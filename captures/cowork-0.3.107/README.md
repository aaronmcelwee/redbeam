# Co-work rerun, REDBEAM 0.3.107 (released installer, main b223416), AARON-SLS, 2026-11-26 ~20:00Z

- **Build:** the released `REDBEAM_0.3.107_x64-setup.exe` (SHA-256 6A4A79FC…CAF3), installed per-user. This was quicker than building.
- **Scratch PDF:** C:\temp\rb-108\CoWork.pdf, a copy of the 12-sheet sweep.pdf, opened by the person.
- **Agent:** a real `REDBEAM.exe --mcp` over stdio.
- **Person input:** real mouse and keyboard through `SendInput`-style calls from a per-monitor-v2 DPI-aware process, at physical coordinates computed as WebView origin + CSS × 1.5.
- **Reads:** page state, focus and element positions came from DevTools (port 9333), with no UI Automation walks.
- **Captures:** PrintWindow, DPI-aware. The tester brought REDBEAM forward only for the person's actions; agent calls never did.

| Step | Expected | Got | Evidence |
|---|---|---|---|
| A1 person opens CoWork.pdf | sheet 1 | "1 / 12", 60%, dpr 1.5 (dismissed What's New first with a real click) | A1-person-sheet1.png |
| A2 agent setup | ok | open_file yours:false (24 ms), go_to_page 5 (20 ms), set_page_scale pages [5] (11 ms), create_scope (40 ms) | driver-log |
| A3 person clicks sheet row 3 | 3 / 12 | 3 / 12, 60%, focus on the row 3 button | A3a-after-row3.png |
| A3 Ctrl+wheel in over the drawing | zoom in | 60% → 316%, still 3 / 12 | |
| A3 drag-pan | view moves, sheet/zoom unchanged | 3 / 12, 316%; focus went to body (a canvas press) | A3b-after-zoom-pan.png |
| A3 click sheet row 8 | 8 / 12 | 8 / 12; zoom back to fit (60%) by the person's sheet change | |
| A3 PageDown twice | 9, then 10 | 9 / 12, then 10 / 12 | A3c-after-pagedown.png |
| A3 the agent never moves the view, zoom or focus | no change other than the person's | **PASS**: every page, zoom or focus change in 300 ms sampling follows one of the person's six actions; none happened otherwise | driver-log A3.strayChanges (each listed change is a person action read 1.6–2 s later) |
| A4 30 agent markups | all on sheet index 5, all ok | **PASS**: 30/30 ok, page 5 (0 → 30, nothing on any other page); times 10–1197 ms (the slowest during the drag); no "no window answered"; 0 dialogs, 0 "Let it work there" | driver-log A3.calls, A4.markups, A-person-works-during-agent-loop.gif |
| B look-in: person on sheet 10, real click on "CoWork · your PDF" in Agents | window to sheet 6 / 12 | **FAIL**: stayed on 10 / 12 (E2.01), 60%; document.hasFocus() became false after the click | B1-before-look-in.png, B2-after-look-in.png |
| B person back to sheet 1, agent makes one markup | stays on 1 / 12 | **PASS**: agent answered page 5 in 26 ms; the window stayed on 1 / 12, 60%, focus on the row 1 button | B3-sheet1-after-agent-markup.png |
| C Start screen: Ctrl+wheel ×3, Ctrl+plus ×2 | dpr stays 1.5 | NOT RUN: launching REDBEAM restores 60+ person tabs from earlier test sessions on this machine, so no Start screen is reachable without closing them | |
| C PDF open, pointer over the right sidebar: Ctrl+wheel ×3 | dpr stays 1.5 | **PASS**: dpr 1.5, visualViewport.scale 1, sheet zoom unchanged (60%) | |
| C same, then Ctrl+plus ×2 | dpr stays 1.5 | **PASS** for the app: dpr 1.5, scale 1. Ctrl+plus zoomed the sheet (60% → 93%, REDBEAM's own shortcut), not the WebView. Nothing to restore. | C1-after-ctrlwheel-ctrlplus.png |
| end_session | | ended; handedBack [], closed [] (the PDF is the person's own) | |
