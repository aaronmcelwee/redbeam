//! Bridge method dispatch (plan 11.2).
//!
//! The takeoff lives in the window that shows its PDF (see `light_query`), so
//! the store reads below are SQL sent to that window's in-memory store. The
//! methods that act on the window itself — navigation, screenshots, writes —
//! go through `invoke_ui_action` and the same handlers a click uses.
//!
//! # Read and write are separated on purpose
//!
//! Query methods run arbitrary parameterized SELECTs. Write methods do not
//! exist here yet: markup creation, calibration and scope edits go through the
//! undo stack and the review gate (docs/DECISIONS.md D1, docs/PORTING.md), and
//! a bridge that wrote rows directly would bypass both — producing takeoff
//! changes with no undo entry and no activity trail. Plan 11.3 adds them as
//! *proposals* through the same path the UI uses.

use serde_json::{json, Map, Value};
use tauri::AppHandle;


/// Every store read answers from the window.
///
/// Aaron, 2026-11-24: "Using REDBEAM with AI agents forces it to go back to
/// pro mode. I want AI agents to work natively in light mode", then "lets
/// retire pro mode altogether". These reads were written for Pro, where the
/// takeoff lived in a project's SQLite file. Now it lives in the window, in
/// the in-memory store the PDF was read into, so the Rust store is empty (or
/// holds an old project an earlier session moved into its PDFs). An agent
/// reading it saw "no project open", reached for `open_project`, and that
/// put the window in Pro. `open_project` is gone; the reads go to the window.

/// How long a Light read waits for a window. A window with a PDF open answers
/// in milliseconds; only a start screen, which has nothing to say, waits it out.
const LIGHT_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Route one bridge call.
pub fn dispatch(app: &AppHandle, method: &str, params: &Value) -> Result<Value, String> {
    // The PDF the call named, for the reads below that ask the window.
    NAMED_FILE.with(|f| *f.borrow_mut() = str_param(params, "file").filter(|s| !s.trim().is_empty()));
    match method {
        "ping" => Ok(json!({ "ok": true, "protocolVersion": super::PROTOCOL_VERSION })),
        "get_capabilities" => Ok(capabilities()),
        "get_state" => get_state(app),
        "list_documents" => list_documents(app, params),
        "list_pages" => list_pages(app, params),
        "list_scopes" => list_scopes(app, params),
        "list_markups" => list_markups(app, params),
        "get_calibration" => get_calibration(app, params),
        "project_summary" => project_summary(app),
        "execute_query" => execute_query(app, params),
        "open_file" => open_file(app, params),
        "agent_bye" => Ok(agent_bye(app)),
        "agent_alive" => Ok(agent_alive(app, params)),
        // UI round trips. Separated from the store-backed methods above
        // because these are the only ones a wedged or window-less app can
        // fail, and a caller deserves to know which kind it is asking for.
        "get_ui_state" => super::ui::request(app, "get_ui_state", params),
        "screenshot" => super::ui::request(app, "screenshot", params),
        "invoke_ui_action" => super::ui::request(app, "invoke_ui_action", params),
        other => Err(format!("unknown method: {other}")),
    }
}

/// What this bridge can do, so a client can negotiate rather than guess.
fn capabilities() -> Value {
    json!({
        "protocolVersion": super::PROTOCOL_VERSION,
        "transport": "tcp-loopback",
        "methods": [
            "ping", "get_capabilities", "get_state", "list_documents", "list_pages",
            "list_scopes", "list_markups", "get_calibration", "project_summary",
            "execute_query", "open_file", "agent_bye", "agent_alive",
            "get_ui_state", "screenshot", "invoke_ui_action",
        ],
        // Named so a client does not have to discover the gap by trying.
        // Named so a client does not have to discover a gap by trying.
        "notImplemented": {
            "write": "markup and scope writes go through the undo stack and review gate; plan 11.3",
        },
        // These need a window and will fail if none is open or the frontend is
        // wedged. Store-backed methods above keep working regardless.
        "needsWindow": ["get_ui_state", "screenshot", "invoke_ui_action"],
    })
}

// ------------------------------------------------------------------ helpers --


thread_local! {
    /// The `file` the call being served on this thread named, if any.
    ///
    /// NOIC intake, 2026-11-26: these reads went to whichever PDF the agent
    /// named last, with no way to name another, so a read meant for one set
    /// answered for the other. The window's router sends a call that names a
    /// file to that file's tab (agents/router.ts).
    static NAMED_FILE: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

/// `{ ...body, file }` when the call named a file.
fn with_named_file(mut body: Value) -> Value {
    if let Some(file) = NAMED_FILE.with(|f| f.borrow().clone()) {
        body["file"] = json!(file);
    }
    body
}

fn query(app: &AppHandle, sql: &str, params: Vec<Value>) -> Result<Vec<Map<String, Value>>, String> {
    light_query(app, sql, params)
}

/// Run a read against the store of the PDF showing in a window (Light).
///
/// The same SQL the Pro store runs: the in-memory store is built from the
/// same migrations, so the column lists above hold for both.
fn light_query(app: &AppHandle, sql: &str, params: Vec<Value>) -> Result<Vec<Map<String, Value>>, String> {
    let reply = super::ui::request_within(
        app,
        "query",
        &with_named_file(json!({ "sql": sql, "params": params })),
        LIGHT_READ_TIMEOUT,
    )?;
    light_rows(&reply)
}

/// The rows out of a window's answer to `query`, refusing anything else.
fn light_rows(reply: &Value) -> Result<Vec<Map<String, Value>>, String> {
    let rows = reply
        .get("rows")
        .and_then(Value::as_array)
        .ok_or("the window answered a query without rows")?;
    rows.iter()
        .map(|r| r.as_object().cloned().ok_or_else(|| "the window answered a row that is not an object".to_string()))
        .collect()
}

fn str_param(params: &Value, key: &str) -> Option<String> {
    params.get(key).and_then(|v| v.as_str()).map(str::to_owned)
}

fn usize_param(params: &Value, key: &str) -> Option<i64> {
    params.get(key).and_then(|v| v.as_i64())
}

/// Rows in one page of a listing.
///
/// A page, not a cap (Aaron, 2026-11-24: no arbitrary caps): a listing that
/// has more says `truncated` and gives `nextOffset`, and `offset` reads on
/// from there, so a set of any size can be walked. A caller may ask for a
/// page of any size.
const DEFAULT_LIMIT: i64 = 500;

fn limit_of(params: &Value) -> i64 {
    usize_param(params, "limit").unwrap_or(DEFAULT_LIMIT).max(1)
}

/// Rows already read: the `nextOffset` of the previous page.
fn offset_of(params: &Value) -> i64 {
    usize_param(params, "offset").unwrap_or(0).max(0)
}

fn listing(rows: Vec<Map<String, Value>>, limit: i64, offset: i64, key: &str) -> Value {
    let truncated = rows.len() as i64 >= limit;
    let mut out = json!({
        key: rows,
        "count": rows.len(),
        "limit": limit,
        // Reported rather than inferred: a client cannot tell a full page from
        // a coincidentally-exact count.
        "truncated": truncated,
    });
    if truncated {
        out["nextOffset"] = json!(offset + limit);
    }
    out
}

// ------------------------------------------------------------------ methods --

fn get_state(app: &AppHandle) -> Result<Value, String> {
    Ok(light_state(app))
}

/// What the window has open, asked of it. Never an error: "nothing is
/// open" is an answer, and the note says what to do about it.
fn light_state(app: &AppHandle) -> Value {
    let ui = super::ui::request_within(app, "get_ui_state", &with_named_file(json!({})), LIGHT_READ_TIMEOUT).ok();
    let file = ui
        .as_ref()
        .and_then(|u| u.get("file"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let page_count = ui.as_ref().and_then(|u| u.get("pageCount")).cloned().unwrap_or(Value::Null);
    let tabs = ui.as_ref().and_then(|u| u.get("tabs")).cloned().unwrap_or(json!([]));
    json!({
        "fileOpen": file.is_some(),
        "file": file,
        "pageCount": page_count,
        "tabs": tabs,
        "appVersion": env!("CARGO_PKG_VERSION"),
        "note": if file.is_some() {
            "The takeoff lives in the PDF. Reads answer for the PDF showing; writes go through redbeam_invoke_ui_action."
        } else {
            "No PDF is open, and REDBEAM has no projects. Open a PDF with redbeam_open_file, then poll redbeam_get_ui_state until pageCount > 0."
        },
        "pid": std::process::id(),
    })
}

fn list_documents(app: &AppHandle, params: &Value) -> Result<Value, String> {
    // A real bid package is 693 documents; an unbounded listing is a response
    // nobody can read.
    let (limit, offset) = (limit_of(params), offset_of(params));
    let rows = query(
        app,
        // Columns are checked against packages/store/migrations, not guessed.
        // `page_count` does not exist on documents — page counts live in the
        // `pages` table, and asking for one here failed the whole listing.
        "SELECT id, relative_path, display_name, kind, status, availability,
                missing, size_bytes, content_fingerprint
           FROM documents ORDER BY relative_path LIMIT ?1 OFFSET ?2",
        vec![json!(limit), json!(offset)],
    )?;
    Ok(listing(rows, limit, offset, "documents"))
}

fn list_pages(app: &AppHandle, params: &Value) -> Result<Value, String> {
    let (limit, offset) = (limit_of(params), offset_of(params));
    let rows = match str_param(params, "documentId") {
        Some(doc) => query(
            app,
            "SELECT id, document_id, page_number, width_pdf_points, height_pdf_points
               FROM pages WHERE document_id = ?1 ORDER BY page_number LIMIT ?2 OFFSET ?3",
            vec![json!(doc), json!(limit), json!(offset)],
        )?,
        None => query(
            app,
            "SELECT id, document_id, page_number, width_pdf_points, height_pdf_points
               FROM pages ORDER BY document_id, page_number LIMIT ?1 OFFSET ?2",
            vec![json!(limit), json!(offset)],
        )?,
    };
    Ok(listing(rows, limit, offset, "pages"))
}

fn list_scopes(app: &AppHandle, params: &Value) -> Result<Value, String> {
    let include_archived = params
        .get("includeArchived")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let sql = if include_archived {
        "SELECT id, label, scope_type, color, specifications_json, archived_at
           FROM scopes ORDER BY archived_at IS NULL DESC, label"
    } else {
        "SELECT id, label, scope_type, color, specifications_json, archived_at
           FROM scopes WHERE archived_at IS NULL ORDER BY label"
    };
    let rows = query(app, sql, vec![])?;
    Ok(json!({ "scopes": rows, "count": rows.len() }))
}

fn list_markups(app: &AppHandle, params: &Value) -> Result<Value, String> {
    let (limit, offset) = (limit_of(params), offset_of(params));
    // deleted_at IS NULL by default: soft-deleted markups are kept for audit
    // and must not appear as live takeoff unless asked for explicitly.
    let include_deleted = params
        .get("includeDeleted")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let mut where_parts: Vec<String> = Vec::new();
    let mut args: Vec<Value> = Vec::new();
    if !include_deleted {
        where_parts.push("deleted_at IS NULL".into());
    }
    if let Some(page) = str_param(params, "pageId") {
        args.push(json!(page));
        where_parts.push(format!("page_id = ?{}", args.len()));
    }
    if let Some(scope) = str_param(params, "scopeId") {
        args.push(json!(scope));
        where_parts.push(format!("scope_id = ?{}", args.len()));
    }
    if let Some(doc) = str_param(params, "documentId") {
        args.push(json!(doc));
        where_parts.push(format!("document_id = ?{}", args.len()));
    }
    let where_sql = if where_parts.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", where_parts.join(" AND "))
    };
    args.push(json!(limit));
    let limit_at = args.len();
    args.push(json!(offset));
    let sql = format!(
        "SELECT id, document_id, page_id, scope_id, kind, geometry_json, content_json,
                origin, review_state, created_at, updated_at, deleted_at
           FROM markups{where_sql} ORDER BY created_at, id LIMIT ?{limit_at} OFFSET ?{}",
        args.len()
    );
    let rows = query(app, &sql, args)?;
    Ok(listing(rows, limit, offset, "markups"))
}

fn get_calibration(app: &AppHandle, params: &Value) -> Result<Value, String> {
    let rows = match str_param(params, "pageId") {
        Some(page) => query(
            app,
            "SELECT document_id, page_id, feet_per_pdf_point, source
               FROM calibrations WHERE page_id = ?1",
            vec![json!(page)],
        )?,
        None => query(
            app,
            "SELECT document_id, page_id, feet_per_pdf_point, source FROM calibrations",
            vec![],
        )?,
    };
    Ok(json!({ "calibrations": rows, "count": rows.len() }))
}

fn project_summary(app: &AppHandle) -> Result<Value, String> {
    // One round trip, and a failure is reported: counting zeros because no
    // PDF answered would say "empty takeoff", which is a different thing.
    let rows = light_query(
        app,
        "SELECT (SELECT COUNT(*) FROM documents) AS documents,
                (SELECT COUNT(*) FROM pages) AS pages,
                (SELECT COUNT(*) FROM scopes WHERE archived_at IS NULL) AS scopes,
                (SELECT COUNT(*) FROM scopes WHERE archived_at IS NOT NULL) AS archivedScopes,
                (SELECT COUNT(*) FROM markups WHERE deleted_at IS NULL) AS markups,
                (SELECT COUNT(*) FROM markups WHERE deleted_at IS NOT NULL) AS deletedMarkups,
                (SELECT COUNT(*) FROM calibrations) AS calibratedPages",
        vec![],
    )?;
    let out = rows.into_iter().next().unwrap_or_default();
    Ok(Value::Object(out))
}

/// Arbitrary READ-ONLY query, for the questions no typed method covers.
///
/// Refuses anything that is not a single SELECT. This is not a security
/// boundary — the caller already holds the token and could drive the UI — it
/// is a guard against an agent corrupting a takeoff by "just checking
/// something". Writes must go through the undo stack, and a DELETE issued here
/// would leave no undo entry and no activity row.
/// Open a PDF as a tab for the agent that asked, without bringing REDBEAM
/// forward or changing the tab the person is looking at.
fn open_file(app: &AppHandle, params: &Value) -> Result<Value, String> {
    let path = str_param(params, "path").ok_or("open_file needs `path`")?;
    let p = std::path::Path::new(path.trim());
    if !p.is_file() {
        return Err(format!("no such file: {path}"));
    }
    let is_pdf = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("pdf"))
        .unwrap_or(false);
    if !is_pdf {
        return Err(format!("not a PDF: {path}"));
    }
    let path = p.display().to_string();
    let wait = params.get("wait").and_then(Value::as_bool) == Some(true);
    /*
     * The window keeps the tabs, so the window opens it: as the calling
     * agent's own tab, behind whatever the person is looking at, which stays
     * exactly where it is (Aaron, 2026-11-24: "agent actions should NEVER
     * steal focus, from other apps or even within the app").
     *
     * A window that has only just started is not listening yet, so the ask is
     * repeated until one answers. Asking twice is harmless: a PDF already
     * open as a tab is left as it is.
     */
    let budget = std::time::Duration::from_secs(if wait { 22 } else { 8 });
    let started = std::time::Instant::now();
    let mut tries = 0u32;
    loop {
        tries += 1;
        let left = budget.saturating_sub(started.elapsed());
        if left < std::time::Duration::from_millis(300) {
            break;
        }
        // The first asks go to the window that keeps the tabs; after that any window may take it.
        let ask = json!({ "path": path, "wait": wait, "any": tries > 2 });
        let slice = if wait && tries > 1 { left } else { left.min(std::time::Duration::from_secs(3)) };
        match super::ui::request_within(app, "open_file", &ask, slice) {
            Ok(v) => return Ok(v),
            Err(e) if e.starts_with("no window answered") => {
                if !has_window(app) {
                    break;
                }
            }
            Err(e) => return Err(e),
        }
    }
    if has_window(app) {
        return Ok(json!({
            "accepted": true,
            "opened": false,
            "path": path,
            "note": "REDBEAM is still starting; poll get_ui_state until `file` is this path and pageCount > 0",
        }));
    }
    // No window at all (the last one was closed): build one, quietly.
    let routed = path.clone();
    let app = app.clone();
    // Off this thread and off the main one: building a window on the main
    // thread deadlocks on Windows (open_with.rs).
    tauri::async_runtime::spawn(async move {
        if let Err(e) = crate::open_with::route_quietly(&app, routed).await {
            eprintln!("bridge open_file failed: {e}");
        }
    });
    Ok(json!({
        "accepted": true,
        "opened": false,
        "path": path,
        "note": "poll get_ui_state until `file` is this path and pageCount > 0",
    }))
}

/// Whether any window that can hold PDFs exists.
fn has_window(app: &AppHandle) -> bool {
    use tauri::Manager;
    app.webview_windows().keys().any(|l| l == "main" || l.starts_with("view-"))
}

/// An AI app closed its connection: its agents are no longer at work. Their
/// tabs stay open. Never an error; a window that is not there has nobody to tell.
fn agent_bye(app: &AppHandle) -> Value {
    let _ = super::ui::request_within(app, "agent_bye", &json!({}), std::time::Duration::from_secs(2));
    json!({ "ok": true })
}

/// An AI app's server saying it is still running (mcp.rs `ALIVE_EVERY`). The
/// window finishes the sessions of one that stops. Never an error.
fn agent_alive(app: &AppHandle, params: &Value) -> Value {
    let _ = super::ui::request_within(app, "agent_alive", params, std::time::Duration::from_secs(2));
    json!({ "ok": true })
}

/// Validate the SQL and hand back the single statement to run.
///
/// Split out from [`execute_query`] so the guard is testable without an
/// `AppHandle` — the guard is the part worth testing, and needing a running
/// app to exercise it is how a check like this ends up untested.
fn execute_query_guard(params: &Value) -> Result<String, String> {
    let sql = str_param(params, "sql").ok_or("execute_query needs `sql`")?;
    let trimmed = sql.trim().trim_end_matches(';').trim().to_string();
    let lowered = trimmed.to_ascii_lowercase();

    if !(lowered.starts_with("select") || lowered.starts_with("with")) {
        return Err("execute_query runs SELECT only; writes must go through the undo stack".into());
    }
    // A second statement would slip past the prefix check.
    if trimmed.contains(';') {
        return Err("execute_query takes ONE statement".into());
    }
    Ok(trimmed)
}

fn execute_query(app: &AppHandle, params: &Value) -> Result<Value, String> {
    let trimmed = execute_query_guard(params)?;

    let args = params
        .get("params")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let limit = limit_of(params);
    let rows = query(app, &trimmed, args)?;
    let n = rows.len();
    Ok(json!({
        "rows": rows,
        "count": n,
        // The caller's own SQL decides the row count; the limit is reported so
        // a missing LIMIT clause is visible rather than mistaken for the truth.
        "limitHint": limit,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn execute_query_refuses_anything_that_writes() {
        // A DELETE here would leave no undo entry and no activity row — the
        // takeoff would change with nothing recording that it did.
        for sql in [
            "DELETE FROM markups",
            "UPDATE scopes SET label = 'x'",
            "INSERT INTO scopes VALUES (1)",
            "DROP TABLE markups",
            "PRAGMA writable_schema = 1",
            "  delete from markups  ",
        ] {
            let params = json!({ "sql": sql });
            let err = execute_query_guard(&params).unwrap_err();
            assert!(err.contains("SELECT only"), "{sql} -> {err}");
        }
    }

    #[test]
    fn execute_query_refuses_a_second_statement() {
        let params = json!({ "sql": "SELECT 1; DELETE FROM markups" });
        let err = execute_query_guard(&params).unwrap_err();
        assert!(err.contains("ONE statement"), "{err}");
    }

    #[test]
    fn execute_query_allows_a_plain_select_and_a_cte() {
        for sql in ["SELECT * FROM scopes", "WITH x AS (SELECT 1) SELECT * FROM x"] {
            assert!(execute_query_guard(&json!({ "sql": sql })).is_ok(), "{sql}");
        }
    }

    #[test]
    fn light_rows_come_back_as_objects_and_anything_else_is_refused() {
        let rows = light_rows(&json!({ "rows": [{ "id": "a" }, { "id": "b" }] })).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1]["id"], json!("b"));
        assert!(light_rows(&json!({})).is_err());
        assert!(light_rows(&json!({ "rows": [1] })).is_err());
    }

    #[test]
    fn limit_is_clamped_rather_than_trusted() {
        assert_eq!(limit_of(&json!({})), DEFAULT_LIMIT);
        assert_eq!(limit_of(&json!({ "limit": 0 })), 1);
        // A page of any size: no ceiling.
        assert_eq!(limit_of(&json!({ "limit": 9_999_999 })), 9_999_999);
        assert_eq!(offset_of(&json!({})), 0);
        assert_eq!(offset_of(&json!({ "offset": 1500 })), 1500);
        let page = listing(vec![Map::new(); 3], 3, 6, "rows");
        assert_eq!(page["nextOffset"], json!(9));
        assert!(listing(vec![Map::new(); 2], 3, 6, "rows").get("nextOffset").is_none());
        assert_eq!(limit_of(&json!({ "limit": 42 })), 42);
    }

    #[test]
    fn unknown_methods_are_named_rather_than_silently_empty() {
        // Silence would look like "this returned nothing", which is a very
        // different answer from "that method does not exist".
        let caps = capabilities();
        let listed = caps["methods"].as_array().unwrap();
        assert!(listed.iter().any(|m| m == "get_state"));
        assert!(caps["notImplemented"]["write"].is_string());
    }
}
