//! `REDBEAM.exe --mcp`: the MCP server Claude and ChatGPT start.
//!
//! The same server as apps/mcp (Node), built into the app so that installing
//! it needs nothing but REDBEAM: the Settings page writes this exe's path and
//! `--mcp` into Claude's or ChatGPT's config (ai_apps.rs), and that app starts
//! it on demand. The tool list is apps/mcp/tools.json, compiled in, so both
//! servers list exactly the same tools.
//!
//! It speaks newline-delimited JSON-RPC on stdin/stdout and forwards each tool
//! call to the running app's bridge (bridge/mod.rs) over loopback. It never
//! opens a window or a project itself. When REDBEAM is not running and AI
//! control is on, the first call starts it and waits for the bridge.
//!
//! This runs before Tauri is built (main.rs), so the single-instance plugin
//! never sees it: an MCP server that handed its arguments to the running copy
//! and exited would look, to Claude, like a server that crashed on start.

use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::{Arc, Mutex, Once, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const TOOLS_JSON: &str = include_str!("../../../mcp/tools.json");

/// How long a bridge call may go without a word from REDBEAM. Not a limit on
/// the work: the app sends a keepalive line every few seconds while a call
/// runs, and each one restarts this clock (Aaron, 2026-11-24: no arbitrary
/// caps). Only an app that has gone quiet fails the call.
const CALL_TIMEOUT: Duration = Duration::from_secs(60);
/// How long to wait for a freshly started REDBEAM to bring its bridge up.
const LAUNCH_WAIT: Duration = Duration::from_secs(30);

struct Spec {
    tools: Value,
    method_of: Value,
    action_of: Value,
    instructions: Value,
    /// The session tool, the `session` input's words, and what a call without one is told.
    sessions: Value,
    /// What keeps the listed tools small, and the batch tool (tools.json `lean`).
    lean: Value,
}

fn spec() -> Spec {
    let v: Value = serde_json::from_str(TOOLS_JSON).expect("tools.json is valid JSON");
    Spec {
        tools: v["tools"].clone(),
        method_of: v["methodOf"].clone(),
        action_of: v["actionOf"].clone(),
        instructions: v["instructions"].clone(),
        sessions: v["sessions"].clone(),
        lean: v["lean"].clone(),
    }
}

const OFF: &str = "AI control is off in REDBEAM. Open REDBEAM, go to Settings > Claude and \
ChatGPT, and turn on \"Let AI apps use REDBEAM\".";

fn discovery() -> Option<(u16, String)> {
    let text = std::fs::read_to_string(crate::bridge::discovery_path()).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    let port = u16::try_from(v.get("port")?.as_u64()?).ok()?;
    let token = v.get("token")?.as_str()?.to_string();
    Some((port, token))
}

fn connect(port: u16) -> std::io::Result<TcpStream> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_secs(2))
}

/// Start REDBEAM once per server process. The flag tells a copy that is
/// already running to stay where it is: it used to come forward (and out of
/// the taskbar) each time an AI app's server could not reach it within two
/// seconds, over whatever the person was working in.
fn launch_app() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let Ok(exe) = std::env::current_exe() else { return };
        let command = || {
            let mut c = std::process::Command::new(&exe);
            c.arg(crate::open_with::FROM_AI_APP);
            c.stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            c
        };
        // Out of the AI app's job, so quitting Claude or ChatGPT (which ends
        // this server) does not close the drawing someone is looking at.
        // A job that forbids breaking away refuses the flag; then start it
        // the plain way.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const DETACHED_PROCESS: u32 = 0x0000_0008;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
            let base = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
            if command().creation_flags(base | CREATE_BREAKAWAY_FROM_JOB).spawn().is_ok() {
                return;
            }
            let _ = command().creation_flags(base).spawn();
        }
        #[cfg(not(windows))]
        {
            let _ = command().spawn();
        }
    });
}

/// How long one server's claim on starting REDBEAM stands. Longer than
/// `LAUNCH_WAIT`, so a claim outlives the launch it covers; short enough that
/// a server killed mid-launch does not stop the next one for long.
const LAUNCH_CLAIM: Duration = Duration::from_secs(45);

fn launch_claim_path() -> std::path::PathBuf {
    std::env::temp_dir().join("redbeam-ai-launch.lock")
}

/// True when this server should start REDBEAM, false when another server
/// already is and this one should only wait for the bridge.
///
/// Two AI chats making their first call in the same second each used to
/// start their own REDBEAM (AARON-SLS, 2026-11-24: two windows, the sessions
/// split between them). The app's single-instance check cannot stop that:
/// the second copy finds the first one's mutex but not yet its window, and
/// carries on. So the servers agree among themselves, with a file only one of
/// them can create.
fn claim_launch(path: &std::path::Path, now: std::time::SystemTime) -> bool {
    for _ in 0..2 {
        match std::fs::OpenOptions::new().write(true).create_new(true).open(path) {
            Ok(_) => return true,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                // A claim written a hair AFTER `now` is as fresh as a claim gets
                // (two servers in the same instant, and a file time that is
                // coarser than the clock). Reading that as "no age" took the
                // claim over, and both servers started REDBEAM (SLS, 2026-11-25).
                let age = std::fs::metadata(path)
                    .and_then(|m| m.modified())
                    .ok()
                    .map(|t| now.duration_since(t).unwrap_or(Duration::ZERO));
                match age {
                    // Fresh: someone else is starting it.
                    Some(a) if a < LAUNCH_CLAIM => return false,
                    // Left behind by a server that died, or unreadable: take it over.
                    _ => {
                        let _ = std::fs::remove_file(path);
                    }
                }
            }
            // No temp folder to write in: start it, as before.
            Err(_) => return true,
        }
    }
    false
}

/// A connection to the bridge, starting REDBEAM if it is not running.
fn reach() -> Result<(TcpStream, String), String> {
    if let Some((port, token)) = discovery() {
        if let Ok(s) = connect(port) {
            return Ok((s, token));
        }
    }
    // Nothing answering. Only start the app when the person has said yes in
    // Settings; otherwise say where the switch is instead of opening a window
    // that would refuse anyway.
    if !crate::ai_apps::enabled_on_disk() {
        return Err(format!("REDBEAM is not running, or {OFF}"));
    }
    let claim = launch_claim_path();
    let mine = claim_launch(&claim, std::time::SystemTime::now());
    if mine {
        launch_app();
    }
    let started = Instant::now();
    while started.elapsed() < LAUNCH_WAIT {
        std::thread::sleep(Duration::from_millis(400));
        if let Some((port, token)) = discovery() {
            if let Ok(s) = connect(port) {
                if mine {
                    let _ = std::fs::remove_file(&claim);
                }
                return Ok((s, token));
            }
        }
    }
    if mine {
        let _ = std::fs::remove_file(&claim);
    }
    Err("Started REDBEAM, but it did not answer within 30 seconds. If it is open, check \
Settings > Claude and ChatGPT, then try again."
        .into())
}

// ------------------------------------------------------------- identity --

/// This server process, told apart from every other one talking to the same
/// REDBEAM: its pid and the moment it started.
fn session() -> &'static str {
    static S: OnceLock<String> = OnceLock::new();
    S.get_or_init(|| {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("{:x}-{:x}", std::process::id(), nanos & 0xffff_ffff_ffff)
    })
}

/// The AI app on the other end, as it named itself in `initialize`.
static CLIENT: Mutex<Option<String>> = Mutex::new(None);
/// Every identity this server has called REDBEAM as, to say goodbye for.
static SEEN: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// The input every tool takes: which chat the call is from.
const SESSION_ARG: &str = "session";
const SESSION_TOOL: &str = "redbeam_start_session";

/// A session this server answers for: its code, the task its chat named,
/// and the server that first issued it (this one, or one before a restart).
#[derive(Clone)]
struct Issued {
    code: String,
    task: String,
    server: String,
}

/// The sessions this server answers for.
static SESSIONS: Mutex<Vec<Issued>> = Mutex::new(Vec::new());

/// Where issued sessions are kept between server processes.
///
/// NOIC intake, 2026-11-26: the AI app restarted REDBEAM's connector after
/// two calls went unanswered, and every call after that was refused with
/// "Start a session first": the sessions lived only in the old process. A
/// chat keeps passing the session it was given, so a new server that finds
/// the code here carries on as the same agent, with the same tabs.
fn sessions_file() -> std::path::PathBuf {
    let name = if cfg!(test) { "redbeam-mcp-sessions-test.json" } else { "redbeam-mcp-sessions.json" };
    std::env::temp_dir().join(name)
}

/// How long an issued session can be picked up again by a later server.
const SESSION_KEEP_SECS: u64 = 7 * 24 * 3600;

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Every session kept on disk and still fresh: (code, task, server, issued at).
fn kept_sessions() -> Vec<(String, String, String, u64)> {
    let Ok(text) = std::fs::read_to_string(sessions_file()) else { return Vec::new() };
    let Ok(v) = serde_json::from_str::<Value>(&text) else { return Vec::new() };
    let now = now_secs();
    v.as_array()
        .map(|list| {
            list.iter()
                .filter_map(|e| {
                    let at = e["at"].as_u64()?;
                    if now.saturating_sub(at) > SESSION_KEEP_SECS {
                        return None;
                    }
                    Some((e["code"].as_str()?.to_string(), e["task"].as_str()?.to_string(), e["server"].as_str()?.to_string(), at))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Add one session to the file. Best effort: a session that cannot be kept still works in this process.
fn keep_session(issued: &Issued) {
    let mut list = kept_sessions();
    list.retain(|(c, ..)| *c != issued.code);
    list.push((issued.code.clone(), issued.task.clone(), issued.server.clone(), now_secs()));
    let json: Vec<Value> = list
        .iter()
        .map(|(code, task, server, at)| json!({ "code": code, "task": task, "server": server, "at": at }))
        .collect();
    let path = sessions_file();
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, serde_json::to_string(&json).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

const CODE_LETTERS: &[u8] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/// Start a session for a chat: the value it passes back on every call.
///
/// An AI app runs ONE server process for all its chats, and nothing in MCP
/// says which chat a call is from (Aaron, 2026-11-24: "let the Mcp start up
/// a new session per Chatgpt or Claude chat"). So the server makes the value,
/// ending in a code no other session has: two chats that call their job the
/// same thing still get a group of tabs each, and a chat that passes none or
/// makes one up is refused rather than landing in another chat's tabs.
fn start_session(task: &str) -> Result<String, String> {
    let task: String = task.replace('#', "").split_whitespace().collect::<Vec<_>>().join(" ");
    let task: String = task.chars().take(60).collect::<String>().trim().to_string();
    if task.is_empty() {
        return Err("Give `task`: a short name for the job this chat is doing.".into());
    }
    let mut sessions = SESSIONS.lock().unwrap_or_else(|e| e.into_inner());
    let mut seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
        ^ (u64::from(std::process::id()) << 20);
    let code = loop {
        let mut code = String::new();
        for _ in 0..3 {
            // xorshift: unguessable is not the point, unalike is.
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            code.push(CODE_LETTERS[(seed % CODE_LETTERS.len() as u64) as usize] as char);
        }
        if !sessions.iter().any(|i| i.code == code) && !kept_sessions().iter().any(|(c, ..)| *c == code) {
            break code;
        }
    };
    let issued = Issued { code: code.clone(), task: task.clone(), server: session().to_string() };
    keep_session(&issued);
    sessions.push(issued);
    Ok(format!("{task} #{code}"))
}

/// The session a call named, as (code, task); None when this server issued
/// no such session. Only the code is read: a chat may tidy the words.
fn session_of(value: Option<&str>) -> Option<(String, String)> {
    let (_, code) = value?.rsplit_once('#')?;
    let code = code.trim().to_uppercase();
    let mut sessions = SESSIONS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(i) = sessions.iter().find(|i| i.code == code) {
        return Some((i.code.clone(), i.task.clone()));
    }
    // Issued by an earlier server of this app that was restarted: carry on as that session.
    let (code, task, server, _) = kept_sessions().into_iter().find(|(c, ..)| *c == code)?;
    sessions.push(Issued { code: code.clone(), task: task.clone(), server });
    Some((code, task))
}

/// Who a call is from: one chat's session, under the server that first issued it.
fn identity(code: &str, task: &str) -> Value {
    let server = SESSIONS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .find(|i| i.code == code)
        .map(|i| i.server.clone())
        .unwrap_or_else(|| session().to_string());
    let id = format!("{server}/{code}");
    {
        let mut seen = SEEN.lock().unwrap_or_else(|e| e.into_inner());
        if !seen.contains(&id) {
            seen.push(id.clone());
        }
    }
    let client = CLIENT.lock().unwrap_or_else(|e| e.into_inner()).clone();
    json!({ "id": id, "client": client, "label": task })
}

const BATCH_TOOL: &str = "redbeam_batch";

/// `For a, b and c: rest` -> `Rest`. Those words name the actions of the
/// catch-all tool; on a tool of its own they say nothing.
fn without_action_list(text: &str) -> Option<String> {
    let rest = text.strip_prefix("For ")?;
    let (list, tail) = rest.split_once(": ")?;
    let names_only = list
        .split(|c: char| c == ',' || c == ' ')
        .filter(|w| !w.is_empty() && *w != "and")
        .all(|w| w.chars().all(|c| c.is_ascii_lowercase() || c == '_'));
    if !names_only || list.is_empty() {
        return None;
    }
    let mut chars = tail.chars();
    let first = chars.next()?;
    Some(first.to_uppercase().collect::<String>() + chars.as_str())
}

fn lean_schema(node: &mut Value) {
    match node {
        Value::Array(list) => list.iter_mut().for_each(lean_schema),
        Value::Object(map) => {
            for (_, v) in map.iter_mut() {
                lean_schema(v);
            }
            if let Some(shorter) = map.get("description").and_then(Value::as_str).and_then(without_action_list) {
                map.insert("description".into(), json!(shorter));
            }
        }
        _ => {}
    }
}

/// The tool list as an AI app is given it: the session tool, the batch tool,
/// then every tool with the required `session` input.
///
/// Every chat pays for all of this text before its first call, so what is
/// listed is kept lean without touching what a tool does (apps/mcp/index.mjs
/// `toolsWithAgent` does the same): the catch-all redbeam_invoke_ui_action is
/// not listed (every action has a tool of its own; a call to it still works),
/// and `file` and `session`, which are on every tool, carry one short line.
fn tools_with_agent(spec: &Spec) -> Value {
    let hidden: Vec<&str> = spec.lean["hidden"].as_array().map(|l| l.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let mut list: Vec<Value> = vec![spec.lean["batch"].clone()];
    list.extend(
        spec.tools
            .as_array()
            .map(|l| l.iter().filter(|t| !hidden.contains(&t["name"].as_str().unwrap_or(""))).cloned().collect::<Vec<_>>())
            .unwrap_or_default(),
    );
    for tool in list.iter_mut() {
        let schema = &mut tool["inputSchema"];
        if !schema.is_object() {
            *schema = json!({ "type": "object", "properties": {} });
        }
        if !schema["properties"].is_object() {
            schema["properties"] = json!({});
        }
        lean_schema(schema);
        if schema["properties"].get("file").is_some() {
            schema["properties"]["file"] = json!({ "type": "string", "description": spec.lean["file"] });
        }
        if schema["properties"].get(SESSION_ARG).is_none() {
            schema["properties"][SESSION_ARG] = json!({ "type": "string", "description": spec.lean["session"] });
            match schema["required"].as_array_mut() {
                Some(list) => list.push(json!(SESSION_ARG)),
                None => schema["required"] = json!([SESSION_ARG]),
            }
        }
    }
    list.insert(0, spec.sessions["tool"].clone());
    Value::Array(list)
}

/// Tell REDBEAM this server's agents are gone, if it is running. Never
/// starts it: a goodbye is not a reason to open a window.
fn say_goodbye() {
    let ids = SEEN.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if ids.is_empty() {
        return;
    }
    let Some((port, token)) = discovery() else { return };
    let client = CLIENT.lock().unwrap_or_else(|e| e.into_inner()).clone();
    for id in ids {
        let Ok(mut stream) = connect(port) else { return };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
        let line = json!({ "id": 1, "method": "agent_bye", "token": token, "params": {},
            "agent": { "id": id, "client": client } });
        if stream.write_all(format!("{line}\n").as_bytes()).is_ok() {
            let mut reply = String::new();
            let _ = BufReader::new(stream).read_line(&mut reply);
        }
    }
}

/// How often this server tells REDBEAM it is still running.
///
/// REDBEAM cannot see an AI app's server die: every call is a connection of
/// its own. So a server with a session says so every few seconds, and one
/// that stops (killed, crashed, hung) has its sessions finished by the window
/// (agents/router.ts `LOST_AFTER_MS`) rather than leaving a cursor on the
/// sheet that says "Searching" for ever.
const ALIVE_EVERY: Duration = Duration::from_secs(5);

/// Say "still here" once, if this server has a session and REDBEAM is running. Never starts it.
fn say_alive() {
    if SEEN.lock().unwrap_or_else(|e| e.into_inner()).is_empty() {
        return;
    }
    let Some((port, token)) = discovery() else { return };
    let Ok(mut stream) = connect(port) else { return };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    // Earlier servers whose sessions this one carries on (see `sessions_file`).
    let servers: Vec<String> = {
        let seen = SEEN.lock().unwrap_or_else(|e| e.into_inner());
        let mut out: Vec<String> = Vec::new();
        for id in seen.iter() {
            if let Some((server, _)) = id.rsplit_once('/') {
                if server != session() && !out.iter().any(|s| s == server) {
                    out.push(server.to_string());
                }
            }
        }
        out
    };
    let line = json!({ "id": 1, "method": "agent_alive", "token": token,
        "params": { "server": session(), "servers": servers } });
    if stream.write_all(format!("{line}\n").as_bytes()).is_ok() {
        let mut reply = String::new();
        let _ = BufReader::new(stream).read_line(&mut reply);
    }
}

/// The takeoff skill every agent is handed: how Maxxit wants a takeoff done.
/// A copy of the precon-takeoff skill (apps/mcp/skills/precon-takeoff.md); when
/// the skill changes, that file changes with it and the next release carries it.
const SKILL_NAME: &str = "precon-takeoff";
const SKILL_URI: &str = "redbeam://skill/precon-takeoff";
const SKILL_ABOUT: &str = "How to do a takeoff in REDBEAM the way Maxxit does it: scope definition for approval, then layouts, quantities and call-outs. Follow it for any takeoff.";
const SKILL_MD: &str = include_str!("../../../mcp/skills/precon-takeoff.md");

/// The skill without its front matter: from its first heading on.
fn skill() -> &'static str {
    if SKILL_MD.starts_with("# ") { return SKILL_MD; }
    SKILL_MD.find("\n# ").map(|i| &SKILL_MD[i + 1..]).unwrap_or(SKILL_MD)
}

/// The skill as an agent is given it when its session starts.
fn skill_handout() -> String {
    // The batching note comes first: an agent that reads only the top of the handout still learns it.
    let fast = spec().lean["handout"].as_str().unwrap_or("").to_string();
    format!("Follow this skill for any takeoff in this chat. It is also the resource {SKILL_URI}, to read again.\n\n{fast}\n\n{}", skill())
}

/// The part of the instructions about working beside a person, to read again.
const GUIDE_URI: &str = "redbeam://guide/working-beside-a-person";

fn guide(spec: &Spec) -> String {
    let text = spec.instructions.as_str().unwrap_or("");
    text.find("WORKING BESIDE A PERSON").map(|i| &text[i..]).unwrap_or(text).to_string()
}

fn bridge_call(method: &str, params: &Value, agent: &Value, alive: &dyn Fn()) -> Result<Value, String> {
    let (mut stream, token) = reach()?;
    let _ = stream.set_read_timeout(Some(CALL_TIMEOUT));
    let line = json!({ "id": 1, "method": method, "token": token, "params": params, "agent": agent, "keepalive": true });
    stream
        .write_all(format!("{line}\n").as_bytes())
        .map_err(|e| format!("could not reach REDBEAM: {e}"))?;
    let mut reader = BufReader::new(stream);
    let v: Value = loop {
        let mut reply = String::new();
        reader
            .read_line(&mut reply)
            .map_err(|e| format!("REDBEAM did not answer {method}: {e}"))?;
        let v: Value = serde_json::from_str(reply.trim()).map_err(|e| format!("bad reply from REDBEAM: {e}"))?;
        // Still working: wait on, and let the AI app know.
        if v.get("keepalive").and_then(Value::as_bool) == Some(true) {
            alive();
            continue;
        }
        break v;
    };
    if v.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(v.get("result").cloned().unwrap_or(Value::Null))
    } else {
        Err(v.get("error").and_then(Value::as_str).unwrap_or("REDBEAM refused the call").to_string())
    }
}

/// The text of an answer: JSON with no indentation. Indented, the same
/// answers were two thirds bigger for nothing a model reads.
fn as_text(v: &Value) -> String {
    serde_json::to_string(v).unwrap_or_default()
}

/// `"$N.path"`: the value at `path` in the answer of call N of this batch; anything else is itself.
fn resolve_refs(value: &Value, answers: &[Value]) -> Result<Value, String> {
    match value {
        Value::String(text) => {
            let Some((n, path)) = text.strip_prefix('$').and_then(|r| r.split_once('.')) else { return Ok(value.clone()) };
            let plain = !n.is_empty() && n.chars().all(|c| c.is_ascii_digit())
                && !path.is_empty() && path.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.');
            if !plain {
                return Ok(value.clone());
            }
            let missing = || format!("{text}: call {n} has no such value");
            let mut at = n.parse::<usize>().ok().and_then(|i| answers.get(i)).ok_or_else(missing)?;
            for key in path.split('.') {
                at = match at {
                    Value::Object(map) => map.get(key),
                    Value::Array(list) => key.parse::<usize>().ok().and_then(|i| list.get(i)),
                    _ => None,
                }
                .ok_or_else(missing)?;
            }
            Ok(at.clone())
        }
        Value::Array(list) => list.iter().map(|v| resolve_refs(v, answers)).collect::<Result<Vec<_>, _>>().map(Value::Array),
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                out.insert(k.clone(), resolve_refs(v, answers)?);
            }
            Ok(Value::Object(out))
        }
        other => Ok(other.clone()),
    }
}

/// One bridge call for a session: the answer as REDBEAM gave it.
fn call_bridge(spec: &Spec, name: &str, mut params: Value, agent: &Value, alive: &dyn Fn()) -> Result<Value, String> {
    let method = spec.method_of.get(name).and_then(Value::as_str)
        .ok_or_else(|| format!("Unknown REDBEAM tool: {name}"))?;
    if !params.is_object() {
        params = json!({});
    }
    if let Some(o) = params.as_object_mut() {
        o.remove(SESSION_ARG);
    }
    if let Some(action) = spec.action_of.get(name).and_then(Value::as_str) {
        params["action"] = json!(action);
    }
    bridge_call(method, &params, agent, alive)
}

/// The PNG of a screenshot answer, without its data-URL prefix.
fn image_of(name: &str, result: &Value) -> Option<String> {
    if name != "redbeam_screenshot" {
        return None;
    }
    let url = result.get("dataUrl").and_then(Value::as_str)?;
    Some(url.split_once(',').map(|(_, d)| d).unwrap_or(url).to_string())
}

/// Several calls in one round trip (tools.json `lean.batch`). Mirrors apps/mcp/index.mjs callBatch.
fn call_batch(spec: &Spec, args: &Value, agent: &Value, alive: &dyn Fn()) -> Result<Value, String> {
    let calls = args.get("calls").and_then(Value::as_array).cloned().unwrap_or_default();
    if calls.is_empty() {
        return Err("Give `calls`: [{tool, arguments}, ...].".into());
    }
    let carry_on = args.get("continueOnError").and_then(Value::as_bool) == Some(true);
    let mut answers: Vec<Value> = Vec::new();
    let mut results: Vec<Value> = Vec::new();
    let mut images: Vec<Value> = Vec::new();
    let mut failed = 0usize;
    for (i, call) in calls.iter().enumerate() {
        let tool = call.get("tool").and_then(Value::as_str).unwrap_or("");
        let ran = (|| {
            if tool == SESSION_TOOL || tool == BATCH_TOOL {
                return Err(format!("{tool} cannot run inside a batch"));
            }
            let inputs = resolve_refs(call.get("arguments").unwrap_or(&json!({})), &answers)?;
            call_bridge(spec, tool, inputs, agent, alive)
        })();
        match ran {
            Ok(result) => {
                if let Some(data) = image_of(tool, &result) {
                    images.push(json!({ "type": "image", "data": data, "mimeType": "image/png" }));
                    results.push(json!({ "call": i, "tool": tool, "ok": true, "result": { "image": images.len() } }));
                } else {
                    results.push(json!({ "call": i, "tool": tool, "ok": true, "result": result }));
                }
                answers.push(result);
            }
            Err(e) => {
                failed += 1;
                answers.push(Value::Null);
                results.push(json!({ "call": i, "tool": tool, "ok": false, "error": e }));
                if !carry_on {
                    break;
                }
            }
        }
    }
    let ran = results.len();
    let mut summary = json!({ "ran": ran, "of": calls.len(), "failed": failed });
    if ran < calls.len() {
        summary["stoppedAt"] = json!(ran - 1);
        summary["note"] = json!("A call failed, so the calls after it were not run. Fix it and send the rest.");
    }
    summary["results"] = Value::Array(results);
    let mut content = vec![json!({ "type": "text", "text": as_text(&summary) })];
    content.extend(images);
    // No structuredContent: a client that has it shows the agent only that, which hides the screenshots.
    let mut out = json!({ "content": content });
    if failed > 0 && ran == failed {
        out["isError"] = json!(true);
    }
    Ok(out)
}

/// One tools/call, as MCP content. Mirrors apps/mcp/index.mjs callTool.
fn call_tool(spec: &Spec, name: &str, args: &Value, alive: &dyn Fn()) -> Result<Value, String> {
    if name == SESSION_TOOL {
        let session = start_session(args.get("task").and_then(Value::as_str).unwrap_or(""))?;
        let text = as_text(&json!({ "session": session,
            "use": "Pass this exact value as `session` on every other REDBEAM call in this chat.",
            "takeoffSkill": SKILL_URI }));
        return Ok(json!({
            // No structuredContent: a client that has it shows the agent only that
            // (Claude Code, 2026-11-27), and the skill and the batching note went unread.
            "content": [{ "type": "text", "text": text }, { "type": "text", "text": skill_handout() }],
        }));
    }
    if name != BATCH_TOOL && spec.method_of.get(name).is_none() {
        return Err(format!("Unknown REDBEAM tool: {name}"));
    }
    // Who is calling is not an input of the tool: it rides beside them.
    let named = args.get(SESSION_ARG).and_then(Value::as_str);
    let (code, task) = session_of(named)
        .ok_or_else(|| spec.sessions["refused"].as_str().unwrap_or("Call redbeam_start_session first.").to_string())?;
    let agent = identity(&code, &task);
    if name == BATCH_TOOL {
        return call_batch(spec, args, &agent, alive);
    }
    let result = call_bridge(spec, name, args.clone(), &agent, alive)?;

    // A screenshot goes back as an image, not a 2 MB data URL in text.
    if let Some(data) = image_of(name, &result) {
        return Ok(json!({ "content": [{ "type": "image", "data": data, "mimeType": "image/png" }] }));
    }
    let text = as_text(&result);
    let structured = if result.is_object() { result } else { json!({ "value": result }) };
    Ok(json!({ "content": [{ "type": "text", "text": text }], "structuredContent": structured }))
}

/// Answer one JSON-RPC message; None for a notification.
fn handle(spec: &Spec, req: &Value) -> Option<Value> {
    handle_with(spec, req, &|_| {})
}

/// [`handle`], with a way to send notifications while a call runs: a long
/// tools/call reports progress to an AI app that asked for it
/// (`_meta.progressToken`), so the app knows the work is still going.
fn handle_with(spec: &Spec, req: &Value, notify: &dyn Fn(Value)) -> Option<Value> {
    // An AI app that stays open across a REDBEAM update reconnects with the
    // tool list it took from the old version. Telling it the list changed on
    // every connection makes it ask again, so new tools appear without a
    // restart of the AI app.
    if req.get("method").and_then(Value::as_str) == Some("notifications/initialized") {
        notify(json!({ "jsonrpc": "2.0", "method": "notifications/tools/list_changed" }));
        return None;
    }
    let id = req.get("id").cloned()?;
    let method = req.get("method").and_then(Value::as_str).unwrap_or("");
    let params = req.get("params").cloned().unwrap_or(Value::Null);
    let ok = |result: Value| json!({ "jsonrpc": "2.0", "id": id, "result": result });
    Some(match method {
        "initialize" => {
            // "claude-ai", "claude-code", "codex-mcp-client": what REDBEAM
            // names this agent after.
            if let Some(name) = params.pointer("/clientInfo/name").and_then(Value::as_str) {
                *CLIENT.lock().unwrap_or_else(|e| e.into_inner()) = Some(name.to_string());
            }
            ok(json!({
            "protocolVersion": params.get("protocolVersion").cloned().unwrap_or(json!("2024-11-05")),
            "capabilities": { "tools": { "listChanged": true }, "resources": {}, "prompts": {} },
            "serverInfo": { "name": "redbeam", "version": env!("CARGO_PKG_VERSION") },
            "instructions": format!("{}{}", spec.instructions.as_str().unwrap_or(""), spec.lean["instructions"].as_str().unwrap_or("")),
            }))
        }
        "ping" => ok(json!({})),
        "tools/list" => ok(json!({ "tools": tools_with_agent(spec) })),
        "resources/list" => ok(json!({ "resources": [{
            "uri": GUIDE_URI, "name": "Working beside a person in REDBEAM", "mimeType": "text/plain",
            "description": "How a session starts, waits, and ends, and how to keep what the person sees about you true.",
        }, {
            "uri": SKILL_URI, "name": "Precon takeoff skill", "mimeType": "text/markdown", "description": SKILL_ABOUT,
        }] })),
        "resources/read" if params.get("uri").and_then(Value::as_str) == Some(SKILL_URI) =>
            ok(json!({ "contents": [{ "uri": SKILL_URI, "mimeType": "text/markdown", "text": skill() }] })),
        "resources/read" => ok(json!({ "contents": [{ "uri": GUIDE_URI, "mimeType": "text/plain", "text": guide(spec) }] })),
        "prompts/list" => ok(json!({ "prompts": [{ "name": SKILL_NAME, "description": SKILL_ABOUT }] })),
        "prompts/get" if params.get("name").and_then(Value::as_str) == Some(SKILL_NAME) => ok(json!({
            "description": SKILL_ABOUT,
            "messages": [{ "role": "user", "content": { "type": "text", "text": skill_handout() } }],
        })),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            let token = params.get("_meta").and_then(|m| m.get("progressToken")).cloned();
            let beats = std::cell::Cell::new(0u64);
            let alive = || {
                if let Some(t) = &token {
                    beats.set(beats.get() + 1);
                    notify(json!({ "jsonrpc": "2.0", "method": "notifications/progress",
                        "params": { "progressToken": t, "progress": beats.get(), "message": "still working" } }));
                }
            };
            match call_tool(spec, name, &args, &alive) {
                Ok(r) => ok(r),
                // A tool result, not an RPC error: the agent should read WHY.
                Err(e) => ok(json!({ "content": [{ "type": "text", "text": format!("Error: {e}") }], "isError": true })),
            }
        }
        other => json!({ "jsonrpc": "2.0", "id": id,
            "error": { "code": -32601, "message": format!("Method not found: {other}") } }),
    })
}

/// Run the server until stdin closes.
pub fn serve_stdio() {
    let spec = Arc::new(spec());
    let out = Arc::new(Mutex::new(std::io::stdout()));
    let send = |out: &Arc<Mutex<std::io::Stdout>>, v: &Value| {
        let mut o = out.lock().unwrap_or_else(|e| e.into_inner());
        let _ = writeln!(o, "{v}");
        let _ = o.flush();
    };
    std::thread::spawn(|| loop {
        std::thread::sleep(ALIVE_EVERY);
        say_alive();
    });
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                send(&out, &json!({ "jsonrpc": "2.0", "id": null,
                    "error": { "code": -32700, "message": format!("Parse error: {e}") } }));
                continue;
            }
        };
        // Tool calls can wait on the window for seconds; a ping must not
        // queue behind them, so each request gets its own thread.
        let (spec, out) = (spec.clone(), out.clone());
        std::thread::spawn(move || {
            let notify = |v: Value| send(&out, &v);
            if let Some(reply) = handle_with(&spec, &req, &notify) {
                send(&out, &reply);
            }
        });
    }
    // The AI app closed the connection: its agents' tabs stay open in
    // REDBEAM, marked as finished rather than as still at work.
    say_goodbye();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_agent_is_handed_the_takeoff_skill() {
        let spec = spec();
        assert!(skill().starts_with("# Precon takeoff"));
        assert!(!skill().contains("\ndescription:"));
        let started = call_tool(&spec, SESSION_TOOL, &json!({ "task": "Skill check" }), &|| {}).unwrap();
        assert!(started["content"][1]["text"].as_str().unwrap().contains("typical module or pattern detail"));
        assert!(started["content"][0]["text"].as_str().unwrap().contains(SKILL_URI));
        assert!(started.get("structuredContent").is_none());
        assert!(started["content"][1]["text"].as_str().unwrap().contains("redbeam_batch {session, calls"));
        let listed = handle(&spec, &json!({ "jsonrpc": "2.0", "id": 1, "method": "resources/list" })).unwrap();
        assert!(listed["result"]["resources"].as_array().unwrap().iter().any(|r| r["uri"] == SKILL_URI));
        let read = handle(&spec, &json!({ "jsonrpc": "2.0", "id": 2, "method": "resources/read", "params": { "uri": SKILL_URI } })).unwrap();
        assert!(read["result"]["contents"][0]["text"].as_str().unwrap().starts_with("# Precon takeoff"));
        let guide = handle(&spec, &json!({ "jsonrpc": "2.0", "id": 3, "method": "resources/read", "params": { "uri": GUIDE_URI } })).unwrap();
        assert!(guide["result"]["contents"][0]["text"].as_str().unwrap().contains("WORKING BESIDE A PERSON"));
        let prompt = handle(&spec, &json!({ "jsonrpc": "2.0", "id": 4, "method": "prompts/get", "params": { "name": SKILL_NAME } })).unwrap();
        assert!(prompt["result"]["messages"][0]["content"]["text"].as_str().unwrap().contains("# Precon takeoff"));
    }

    #[test]
    fn only_one_server_starts_the_app_and_a_dead_claim_is_taken_over() {
        let path = std::env::temp_dir().join(format!("redbeam-claim-test-{}.lock", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let now = std::time::SystemTime::now();
        assert!(claim_launch(&path, now), "the first server starts it");
        assert!(!claim_launch(&path, now), "the second waits for the first");
        // A server whose clock reading is a little BEFORE the claim's file time waits too.
        assert!(!claim_launch(&path, now - Duration::from_secs(2)), "a claim dated after now is fresh, not stale");
        // The first server died mid-launch: later, the claim is stale.
        assert!(claim_launch(&path, now + LAUNCH_CLAIM + Duration::from_secs(1)));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn lists_the_same_tools_as_the_node_server() {
        let s = spec();
        let tools = s.tools.as_array().expect("tools array");
        assert!(tools.len() >= 14);
        for t in tools {
            let name = t["name"].as_str().unwrap();
            assert!(s.method_of.get(name).is_some(), "{name} has no bridge method");
        }
        assert!(tools.iter().any(|t| t["name"] == "redbeam_open_file"));
    }

    #[test]
    fn initialize_and_list() {
        let s = spec();
        let r = handle(&s, &json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2025-06-18" } })).unwrap();
        assert_eq!(r["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(r["result"]["serverInfo"]["name"], "redbeam");
        let r = handle(&s, &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).unwrap();
        assert!(r["result"]["tools"].as_array().unwrap().len() >= 14);
        assert_eq!(r["result"]["tools"].as_array().map(Vec::is_empty), Some(false));
        // Each connection is told to list the tools again, so an AI app left
        // open across an update picks up the new ones.
        let r = handle(&s, &json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} })).unwrap();
        assert_eq!(r["result"]["capabilities"]["tools"]["listChanged"], true);
        let told = std::cell::RefCell::new(Vec::new());
        assert!(handle_with(&s, &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
            &|v| told.borrow_mut().push(v)).is_none());
        assert_eq!(told.borrow()[0]["method"], "notifications/tools/list_changed");
    }

    #[test]
    fn every_tool_requires_a_session() {
        let s = spec();
        let r = handle(&s, &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).unwrap();
        let listed = r["result"]["tools"].as_array().unwrap();
        assert_eq!(listed[0]["name"], SESSION_TOOL);
        for t in &listed[1..] {
            assert_eq!(t["inputSchema"]["properties"]["session"]["type"], "string", "{}", t["name"]);
            // Required: one server serves every chat of its app, and only this tells them apart.
            let required = t["inputSchema"]["required"].as_array().cloned().unwrap_or_default();
            assert!(required.contains(&json!("session")), "{}", t["name"]);
        }
        // tools.json itself stays as it was: the Node server adds its own.
        assert!(s.tools.as_array().unwrap().iter().all(|t| t["inputSchema"]["properties"].get("session").is_none()));
    }

    #[test]
    fn each_chat_gets_a_session_of_its_own() {
        // Two chats that call their job the same thing are still two sessions.
        let a = start_session("Nokia Canada  North Campus takeoff").unwrap();
        let b = start_session("Nokia Canada North Campus takeoff").unwrap();
        assert_ne!(a, b);
        assert!(a.starts_with("Nokia Canada North Campus takeoff #"), "{a}");
        let (code_a, task_a) = session_of(Some(&a)).unwrap();
        let (code_b, _) = session_of(Some(&b)).unwrap();
        assert_ne!(code_a, code_b);
        assert_eq!(task_a, "Nokia Canada North Campus takeoff");
        assert_ne!(identity(&code_a, &task_a)["id"], identity(&code_b, &task_a)["id"]);
        assert_eq!(identity(&code_a, &task_a)["label"], "Nokia Canada North Campus takeoff");
        // A chat may tidy the words; the code is what counts.
        assert_eq!(session_of(Some(&format!("nokia #{} ", code_a.to_lowercase()))).unwrap().0, code_a);
        // None, a bare name, or a made-up code is nobody's session.
        assert!(session_of(None).is_none());
        assert!(session_of(Some("Nokia Canada North Campus takeoff")).is_none());
        assert!(session_of(Some("x #000")).is_none());
        assert!(start_session("  # ").is_err());
    }

    #[test]
    fn a_restarted_server_carries_on_a_session_it_did_not_issue() {
        // As if an earlier server of this app had issued it, then been restarted.
        let earlier = Issued { code: "Q7Z".into(), task: "NOIC spec read".into(), server: "1234-abcd".into() };
        keep_session(&earlier);
        let (code, task) = session_of(Some("NOIC spec read #Q7Z")).unwrap();
        assert_eq!((code.as_str(), task.as_str()), ("Q7Z", "NOIC spec read"));
        // Same agent as before the restart, so REDBEAM gives it its tabs back.
        assert_eq!(identity(&code, &task)["id"], "1234-abcd/Q7Z");
    }

    #[test]
    fn a_call_without_a_session_is_refused_before_redbeam_is_reached() {
        let s = spec();
        for args in [json!({}), json!({ "session": "Nokia takeoff" }), json!({ "agent": "framing" })] {
            let r = handle(&s, &json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call",
                "params": { "name": "redbeam_get_ui_state", "arguments": args } })).unwrap();
            assert_eq!(r["result"]["isError"], true);
            assert!(r["result"]["content"][0]["text"].as_str().unwrap().contains("redbeam_start_session"));
        }
        let r = handle(&s, &json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call",
            "params": { "name": "redbeam_start_session", "arguments": { "task": "Level 2 ceilings" } } })).unwrap();
        assert!(r["result"]["content"][0]["text"].as_str().unwrap().contains("\"session\":\"Level 2 ceilings #"));
    }

    #[test]
    fn the_listed_tools_are_lean() {
        // Every chat pays for the whole list before its first call. 0.3.113 listed 160 KB.
        let s = spec();
        let listed = tools_with_agent(&s);
        let listed = listed.as_array().unwrap();
        assert_eq!(listed[0]["name"], SESSION_TOOL);
        assert_eq!(listed[1]["name"], BATCH_TOOL);
        assert!(listed.iter().all(|t| t["name"] != "redbeam_invoke_ui_action"));
        for t in &listed[1..] {
            let p = &t["inputSchema"]["properties"];
            assert!(p["session"]["description"].as_str().unwrap().len() < 90, "{}", t["name"]);
            if let Some(f) = p.get("file") {
                assert!(f["description"].as_str().unwrap().len() < 130, "{}", t["name"]);
            }
        }
        let bytes = serde_json::to_string(&listed).unwrap().len();
        assert!(bytes < 125_000, "tools/list is {bytes} bytes");
        assert_eq!(without_action_list("For set_page_scale and find_text: explicit pages.").as_deref(), Some("Explicit pages."));
        assert_eq!(without_action_list("For a, b and c: x").as_deref(), Some("X"));
        assert_eq!(without_action_list("For export: an absolute path").as_deref(), Some("An absolute path"));
        assert!(without_action_list("For a small field give sizeFeet: roughly").is_none());
        assert!(without_action_list("The sheet.").is_none());
        // The catch-all is not listed, but a chat that still calls it is served.
        assert!(s.method_of.get("redbeam_invoke_ui_action").is_some());
    }

    #[test]
    fn a_batch_fills_in_values_from_earlier_answers() {
        let answers = vec![json!({ "scopeId": "sc_1", "scope": { "label": "CL-1" } }), json!({ "pages": [3, 4] })];
        let got = resolve_refs(&json!({ "scopeId": "$0.scopeId", "label": "$0.scope.label", "page": "$1.pages.1",
            "note": "$5 each", "rings": [[{ "x": 0.1 }]] }), &answers).unwrap();
        assert_eq!(got, json!({ "scopeId": "sc_1", "label": "CL-1", "page": 4, "note": "$5 each", "rings": [[{ "x": 0.1 }]] }));
        assert!(resolve_refs(&json!({ "a": "$0.nope" }), &answers).is_err());
        assert!(resolve_refs(&json!({ "a": "$7.scopeId" }), &answers).is_err());
    }

    #[test]
    fn a_batch_needs_a_session_and_refuses_to_nest() {
        let s = spec();
        assert!(call_tool(&s, BATCH_TOOL, &json!({ "calls": [{ "tool": "redbeam_get_ui_state" }] }), &|| {}).is_err());
        let session = start_session("Batch check").unwrap();
        assert!(call_tool(&s, BATCH_TOOL, &json!({ "session": session, "calls": [] }), &|| {}).is_err());
        let out = call_tool(&s, BATCH_TOOL, &json!({ "session": session,
            "calls": [{ "tool": "redbeam_batch", "arguments": { "calls": [] } }, { "tool": "redbeam_get_ui_state" }] }), &|| {}).unwrap();
        let summary: Value = serde_json::from_str(out["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(summary["ran"], 1);
        assert_eq!(summary["of"], 2);
        assert!(out.get("structuredContent").is_none());
        assert_eq!(out["isError"], true);
        assert!(out["content"][0]["text"].as_str().unwrap().contains("cannot run inside a batch"));
    }

    #[test]
    fn unknown_tool_is_a_tool_error_not_a_crash() {
        let s = spec();
        let r = handle(&s, &json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": { "name": "nope", "arguments": {} } })).unwrap();
        assert_eq!(r["result"]["isError"], true);
    }
}
