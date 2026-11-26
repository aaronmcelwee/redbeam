# Own views: agent and person in the same PDF, REDBEAM main 0.3.100 (c4a8c61), AARON-SLS, 2026-11-26

**Build:** built locally from origin/main c4a8c61 (NSIS, 247 s) and installed per-user. Before installing, the "copy-titleblock" REDBEAM was closed normally, on Aaron's word; it exited by itself.

**Setup**
- Desktop unlocked.
- Scratch PDF `C:\temp\rb-100\OwnViews.pdf`, a copy of fixtures/ui/sweep.pdf (12 sheets), opened by the person from the command line.
- The agent is a real `REDBEAM.exe --mcp` over stdio (79 tools).
- Window state was read after every call through UI Automation: page indicator, zoom button, dialogs, "Let it work there", needs-you marks.

| Step | Result | Evidence |
|---|---|---|
| 1. Person opens the PDF, sheet 1 | PASS: "1 / 12", zoom 60%, title "OwnViews — REDBEAM" | 01-person-sheet1.png |
| 2. open_file | PASS: opened, 12 pages, yours:false, note "This PDF was already open in the person's own tab, so it stays theirs. That changes nothing for you: you have your own view of it…" | driver-log-own-views.json |
| 2. go_to_page 5 | PASS: page 5 (A6.02); window still 1/12 at 60% | |
| 2. get_ui_state | PASS: pageIndex 5; person.pageIndex 0, person tool pan, zoom 0.596; agent.drives false | |
| 2. zoom_to_region | PASS: "framed in your own view… The person's view did not move" | |
| 2. set_tool area | PASS: "noted for your session; the tool on screen is the person's and did not change" | |
| 2. open_panel settings | PASS: panel "none", "panels are the person's and none was opened" | |
| 2. set_page_scale feetPerPoint 0.02 (no pages) | PASS: pages [5], source "agent" | |
| 2. create_scope, then create_markup with no page | PASS: markup on page 5 (A6.02), 8.725 sf | |
| 2. screenshot (no args) | PASS: sheet 6's framed box with the area markup | 02-agent-screenshot.png |
| 2. select_markups, create a 2nd markup, delete_markup | PASS: "selected in your own view; the person's selection did not change"; deleted | |
| 2. Window after EACH call | PASS: always "1 / 12", 60%, no dialog, no "Let it work there", no needs-you mark, no error field | 02-window-after-agent-calls.png |
| 3. 20 create_markup on page 5 while the person works | Writes PASS: page 5 went 21 → 41 (+20), every answered call said page 5. Answers FAIL: the first 2 calls answered "Error: no window answered `invoke_ui_action`, and none said it was working on it, for 20s — is a PDF open? Open one with redbeam_open_file." but both writes landed (+20 from 18 ok answers), in both runs. Stalls (66 s, 33 s, 16 s) coincided exactly with my UI Automation tree walks of the window (66 s, 16 s, 16 s); once walks fell under 2 s, calls took 9–24 ms. | driver-log-own-views-steps3-5.json (3.calls, 3.walks), 03-person-works-during-agent-loop.gif |
| 3. Person: click sheet 3, Ctrl+wheel, pan | NOT DONE as specified: the UIA lookup for "Architectural 3" timed out (tree walk 66 s with 60+ restored tabs) and the click never happened; Ctrl+wheel left zoom at 60%. The window stayed on 1/12 at 60% through the loop (start, middle, end), so agent writes did not move the person's view. | 03a/03b/03c PNGs |
| 4. Click the session's PDF row in Agents | FAIL as expected-behaviour: clicked "OwnViews your PDF" (real click); the window stayed on sheet 1 (1/12, 60%), not sheet 6. The PDF is the person's own tab here. | 04-after-agents-row-click.png |
| 5. end_session {summary:"test"} | ok: handedBack [], closed [], why {} (the PDF was the person's own) | driver-log |

**Other observations**
- The window renders its content larger than its frame after the earlier display change (\\.\DISPLAY1), so captures are cropped on the right and the Agents list is out of frame.
- The window has 61+ restored person tabs from earlier test sessions on this machine. That makes the accessibility tree very large.
