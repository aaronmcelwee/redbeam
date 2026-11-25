# REDBEAM 0.3.83 (b2929aa), PR #87, AARON-SLS, 2026-11-25

- **Build:** built locally (`npx tauri build --target x86_64-pc-windows-msvc --bundles nsis`, 225 s) and installed per-user.
- **Tests:** `cargo test --lib mcp::` passed 20 of 20 runs. `cargo test --lib bridge::` passed 15 of 15.
- **Desktop:** UNLOCKED for the whole run. The display was kept awake with SetThreadExecutionState; no settings were changed.
- **Agents:** real `REDBEAM.exe --mcp` processes (clients claude-ai, chatgpt, claude-code).
- **Files:** scratch PDFs made with pdf-lib.
- **Captures:** window only, through PrintWindow. The person's actions (opening PDFs from the command line, Notepad in front, maximize, clicks, Ctrl+Z) were done with real input or UI Automation, never by an agent.
- **Logs:** driver-log.json (main run) and driver-log-supplement.json (run with fresh file names, so each session owns its PDF).

| Std | Result | Measured / observed | Capture | Commit |
|---|---|---|---|---|
| Launch race | PASS | 2 servers, first call at the same instant: 1 app in 10 of 10 tries. 3 servers: 1 app in 3 of 3. Notepad stayed in front every time. On ca4c77e, before the claim fix, it was 2 apps in 2 of 5 tries. | driver-log.json Race2x10 / Race3x3 | b2929aa |
| Launch | PASS (with a note) | Agent-started launches never took the foreground. What's New was not shown on AI launches. It did open as a modal over the sheet on the person's first own launch after the update. | S2-S3-agents-dock-maximized.png | b2929aa |
| S1 | PASS | Three chats, three sessions, each its own card. Fresh PDFs opened `yours:true`, and every page turn and draw was ok. | SUP-S1-S6-three-own-sessions.png | b2929aa |
| S2 | PASS | Cards and cursor read app + task in full, e.g. "ChatGPT · Nokia Canada North Campus takeoff" (long names wrap, no ellipsis), at default size and maximized. | S2-S3-agents-dock-default.png, S2-S3-agents-dock-maximized.png, SUP-S4-cursor-tooltip.png | b2929aa |
| S3 | PASS | Agents sits at the bottom of the right sidebar, with a header, a "Resize Agents" separator and cards. It folds to one line and unfolds. Nothing agent-related is in the tab strip or the left panel. The title bar shows "3 AI sessions · 3 waiting for you". Divider drag not tested. | S3-agents-folded.png | b2929aa |
| S4 | PASS | Cursor with the tooltip "Drawing an area · ChatGPT · Nokia Canada North Campus takeoff 2", readable in Light. Killed during an uncached 300-page find_text: the card moved to Finished as "stopped answering" in 2.4 s, and "Searching" stayed for 1 sample. | gif-SUP-S4-cursor-tooltip.gif, gif-SUP-S4-kill-mid-call.gif, SUP-S4-after-kill.png | b2929aa |
| S5 | PASS (note) | Notepad was in front for 143 of 143 samples while agents started, opened, paged and drew, and 86 of 86 in the supplement. The person's page, zoom, tool and selection did not change. The only dialog seen was the person-launch What's New. | gif-S5-person-view-while-agents-work.gif, S5-person-view-after-agents.png | b2929aa |
| S6 | **FAIL** | Session A **moved session B's view**: `go_to_page` on B's own PDF returned ok, page 2. Drawing and closing were refused with "work in a copy", and the person was asked nothing. | SUP-S1-S6-three-own-sessions.png, driver-log-supplement.json S6.moveOther | b2929aa |
| S7 | PASS | get_ui_state, 110 calls per session with 3 at once: median 31/31/31 ms, p95 43/43/41, worst 53/57/55, 0 failures. | driver-log.json S7 | b2929aa |
| S8 | PASS | wait_for_person shows "Waiting for you: approve the scope definition" on the card and in the title bar, still there after 60 s, and the next call resumes. end_session shows Finished with the summary, and the read-only PDF closed with a reopen row. The summary stayed after the app closed. No question to the person. | S8-1-waiting-for-you.png, S8-2-finished-with-summary.png, S8-3-summary-after-app-closed.png, gif-S8-end-session.gif | b2929aa |
| S9 | PARTLY | The agent's markups appear live on the person's open sheet ("2 markups"; the agent's view is no longer a separate copy). The card lists the PDF as "your PDF". The agent's undo removed exactly its own last markup. The person's real Ctrl+Z did not remove the agent's markup. NOT shown: Ctrl+Z undoing a person markup. The person's real-input dimension landed in an agent tab and was still being placed ("set scale first") when Ctrl+Z was sent. | S9-1-guest-markups-on-person-sheet.png, S9-3-after-both-undos.png, gif-S9-person-and-agent-undo.gif, gif-SUP-S9-person-ctrlz.gif | b2929aa |
| Long call | PASS | find_text over 300 pages returned one answer (100 matches, 2.1 s), attributed to its session's card ("Searching for “ACOUSTICAL”"). | driver-log.json long.findText300 | b2929aa |
| Ask 60 s | PARTLY | The ask lives only in the Agents card ("Let it work there / Not now"), not over the sheet. The agent's call returns after about 12 s with "asked, not answered yet" rather than waiting. After "Not now", the next call is refused: "the person said not now". | ASK-unanswered-60s.png | b2929aa |

## Narrow reruns (b2929aa, unlocked, 2026-11-25 ~15:45Z; log: driver-log-narrow.json)

| Std | Result | Measured / observed | Capture |
|---|---|---|---|
| S6 (rerun) | **PASS** | B on page 0 (read 0). A go_to_page {B's PDF, page 3}: refused, "One session does not move another session's view…". B still on page 0. A zoom_to_region and A set_tool on B's PDF: both refused, same message. A go_to_page page 0 (already showing): ok, no movement, B still 0. The person was asked nothing. The earlier S6 fail was a no-op: B was already on page 2. | driver-log-narrow.json |
| S9 person undo (rerun) | **FAIL** | In the person's own scratch PDF (Person-S9-jy85): 1 markup before. The person's real-input dimension made 2 (mk-7uyya0jt:dimension). The agent's guest area made 3 (mk-mwwakjhf-5xrn0e). A real Ctrl+Z with REDBEAM in front left **3**: the person's dimension was NOT undone, and the agent's area stayed. The agent's redbeam_undo then made 2 (it removed only its own area). | gif-N-S9-person-undo.gif, N-S9-1-person-and-agent-markups.png, N-S9-2-after-person-ctrlz.png, N-S9-3-after-agent-undo.png |

Also seen: the person's own active tab (Person-S9-jy85) was not visible in the tab strip. It sat in the "+11" overflow, so the guest dot on it could not be seen.

**Other:** the person's tab strip holds restored tabs from earlier runs on this machine (other threads' test files and mine), so the overflow shows "+8"/"+15". Some of my test files also reused those names, so the main run's agents shared person tabs (`yours:false`). The supplement used fresh names.
