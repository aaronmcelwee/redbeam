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

/// How long one bridge call may take. UI calls time out at 20 s in the app.
const CALL_TIMEOUT: Duration = Duration::from_secs(30);
/// How long to wait for a freshly started REDBEAM to bring its bridge up.
const LAUNCH_WAIT: Duration = Duration::from_secs(30);

struct Spec {
    tools: Value,
    method_of: Value,
    action_of: Value,
    instructions: Value,
    /// The session tool, the `session` input's words, and what a call without one is told.
    sessions: Value,
}

fn spec() -> Spec {
    let v: Value = serde_json::from_str(TOOLS_JSON).expect("tools.json is valid JSON");
    Spec {
        tools: v["tools"].clone(),
        method_of: v["methodOf"].clone(),
        action_of: v["actionOf"].clone(),
        instructions: v["instructions"].clone(),
        sessions: v["sessions"].clone(),
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
    launch_app();
    let started = Instant::now();
    while started.elapsed() < LAUNCH_WAIT {
        std::thread::sleep(Duration::from_millis(400));
        if let Some((port, token)) = discovery() {
            if let Ok(s) = connect(port) {
                return Ok((s, token));
            }
        }
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

/// The sessions this server has started: each one's code and the task its chat named.
static SESSIONS: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

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
        if !sessions.iter().any(|(c, _)| *c == code) {
            break code;
        }
    };
    sessions.push((code.clone(), task.clone()));
    Ok(format!("{task} #{code}"))
}

/// The session a call named, as (code, task); None when this server issued
/// no such session. Only the code is read: a chat may tidy the words.
fn session_of(value: Option<&str>) -> Option<(String, String)> {
    let (_, code) = value?.rsplit_once('#')?;
    let code = code.trim().to_uppercase();
    let sessions = SESSIONS.lock().unwrap_or_else(|e| e.into_inner());
    sessions.iter().find(|(c, _)| *c == code).cloned()
}

/// Who a call is from: one chat's session inside this server.
fn identity(code: &str, task: &str) -> Value {
    let id = format!("{}/{code}", session());
    {
        let mut seen = SEEN.lock().unwrap_or_else(|e| e.into_inner());
        if !seen.contains(&id) {
            seen.push(id.clone());
        }
    }
    let client = CLIENT.lock().unwrap_or_else(|e| e.into_inner()).clone();
    json!({ "id": id, "client": client, "label": task })
}

/// The tool list: the session tool first, then every tool with the required `session` input.
fn tools_with_agent(spec: &Spec) -> Value {
    let mut tools = spec.tools.clone();
    if let Some(list) = tools.as_array_mut() {
        for tool in list.iter_mut() {
            let schema = &mut tool["inputSchema"];
            if !schema.is_object() {
                *schema = json!({ "type": "object", "properties": {} });
            }
            if !schema["properties"].is_object() {
                schema["properties"] = json!({});
            }
            if schema["properties"].get(SESSION_ARG).is_none() {
                schema["properties"][SESSION_ARG] = json!({
                    "type": "string",
                    "description": spec.sessions["input"],
                });
                match schema["required"].as_array_mut() {
                    Some(list) => list.push(json!(SESSION_ARG)),
                    None => schema["required"] = json!([SESSION_ARG]),
                }
            }
        }
        list.insert(0, spec.sessions["tool"].clone());
    }
    tools
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

fn bridge_call(method: &str, params: &Value, agent: &Value) -> Result<Value, String> {
    let (mut stream, token) = reach()?;
    let _ = stream.set_read_timeout(Some(CALL_TIMEOUT));
    let line = json!({ "id": 1, "method": method, "token": token, "params": params, "agent": agent });
    stream
        .write_all(format!("{line}\n").as_bytes())
        .map_err(|e| format!("could not reach REDBEAM: {e}"))?;
    let mut reply = String::new();
    BufReader::new(stream)
        .read_line(&mut reply)
        .map_err(|e| format!("REDBEAM did not answer {method}: {e}"))?;
    let v: Value = serde_json::from_str(reply.trim()).map_err(|e| format!("bad reply from REDBEAM: {e}"))?;
    if v.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(v.get("result").cloned().unwrap_or(Value::Null))
    } else {
        Err(v.get("error").and_then(Value::as_str).unwrap_or("REDBEAM refused the call").to_string())
    }
}

/// One tools/call, as MCP content. Mirrors apps/mcp/index.mjs callTool.
fn call_tool(spec: &Spec, name: &str, args: &Value) -> Result<Value, String> {
    if name == SESSION_TOOL {
        let session = start_session(args.get("task").and_then(Value::as_str).unwrap_or(""))?;
        let text = serde_json::to_string_pretty(&json!({ "session": session,
            "use": "Pass this exact value as `session` on every other REDBEAM call in this chat." }))
            .unwrap_or_default();
        return Ok(json!({ "content": [{ "type": "text", "text": text }], "structuredContent": { "session": session } }));
    }
    let method = spec.method_of.get(name).and_then(Value::as_str)
        .ok_or_else(|| format!("Unknown REDBEAM tool: {name}"))?;
    let mut params = if args.is_object() { args.clone() } else { json!({}) };
    // Who is calling is not an input of the tool: it rides beside them.
    let named = params
        .as_object_mut()
        .and_then(|o| o.remove(SESSION_ARG))
        .and_then(|v| v.as_str().map(str::to_owned));
    let (code, task) = session_of(named.as_deref())
        .ok_or_else(|| spec.sessions["refused"].as_str().unwrap_or("Call redbeam_start_session first.").to_string())?;
    if let Some(action) = spec.action_of.get(name).and_then(Value::as_str) {
        params["action"] = json!(action);
    }
    let result = bridge_call(method, &params, &identity(&code, &task))?;

    // A screenshot goes back as an image, not a 2 MB data URL in text.
    if name == "redbeam_screenshot" {
        if let Some(url) = result.get("dataUrl").and_then(Value::as_str) {
            let data = url.split_once(',').map(|(_, d)| d).unwrap_or(url);
            return Ok(json!({ "content": [{ "type": "image", "data": data, "mimeType": "image/png" }] }));
        }
    }
    let text = serde_json::to_string_pretty(&result).unwrap_or_default();
    let structured = if result.is_object() { result } else { json!({ "value": result }) };
    Ok(json!({ "content": [{ "type": "text", "text": text }], "structuredContent": structured }))
}

/// Answer one JSON-RPC message; None for a notification.
fn handle(spec: &Spec, req: &Value) -> Option<Value> {
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
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "redbeam", "version": env!("CARGO_PKG_VERSION") },
            "instructions": spec.instructions,
            }))
        }
        "ping" => ok(json!({})),
        "tools/list" => ok(json!({ "tools": tools_with_agent(spec) })),
        "resources/list" => ok(json!({ "resources": [] })),
        "prompts/list" => ok(json!({ "prompts": [] })),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            match call_tool(spec, name, &args) {
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
            if let Some(reply) = handle(&spec, &req) {
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
        assert!(handle(&s, &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).is_none());
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
        assert!(r["result"]["structuredContent"]["session"].as_str().unwrap().starts_with("Level 2 ceilings #"));
    }

    #[test]
    fn unknown_tool_is_a_tool_error_not_a_crash() {
        let s = spec();
        let r = handle(&s, &json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": { "name": "nope", "arguments": {} } })).unwrap();
        assert_eq!(r["result"]["isError"], true);
    }
}
