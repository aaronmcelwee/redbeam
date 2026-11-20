// Prevents an extra console window from appearing alongside the app on Windows
// release builds. Debug builds keep it so `println!` is visible.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `REDBEAM.exe --mcp` is the MCP server Claude and ChatGPT start
    // (src/mcp.rs). Checked before anything else so it never builds a window
    // or meets the single-instance plugin.
    if std::env::args().nth(1).as_deref() == Some("--mcp") {
        redbeam_lib::mcp::serve_stdio();
        return;
    }
    redbeam_lib::run()
}
