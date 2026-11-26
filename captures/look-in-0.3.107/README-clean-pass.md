# Look-in clean pass (window moved clear of the toast area), REDBEAM 0.3.107, AARON-SLS, 2026-11-26 ~20:20Z

**Result: PASS.** A real click on the agent's "your PDF" row took the person's window to the agent's sheet. document.hasFocus() stayed true, and a later agent markup did not move the person off sheet 1.

**Setup**
- Fresh scratch copy C:\temp\rb-108\LookIn2.pdf, a 12-sheet sweep.
- The REDBEAM I opened was moved and sized with SetWindowPos from 120,89–2302,1452 to 0,0–1500,950 physical, and put back afterwards. The toasts were not dismissed.
- Agent: start_session, open_file (yours:false), go_to_page 5, one create_markup on page 5.
- The person real-clicked sheet row 10. Agent get_ui_state then showed pageIndex 5, person.pageIndex 9.

| Check | Value |
|---|---|
| Row | "LookIn2 your PDF", class `agentfile active`, title "…Click to go to the sheet it is on." |
| Row rect (CSS) | x 684.7, y 454.3, w 287.3, h 24; centre 828.3, 466.3 → physical 1254, 701 (1146 px from the right edge, 899 px from the bottom) |
| elementFromPoint at the centre | SPAN.agentfile-name, inside the row |
| WindowFromPoint at 1254,701 | REDBEAM's own Tauri Window |
| Foreground before the click | redbeam |
| Before | 10 / 12, hasFocus true |
| Real click events | pointerdown, mousedown, pointerup, mouseup, click on SPAN.agentfile-name (plus one element blur from the sheet-row button) |
| After 1 s | **6 / 12**, hasFocus **true**, focus BUTTON.agentfile, foreground redbeam |
| Person real-clicks row 1 | 1 / 12 |
| Agent create_markup page 5 (30 ms) | window stays **1 / 12**, hasFocus true, focus on the row 1 button |

The zoom readout is null in this run because the toolbar's zoom button is hidden at the narrower 986 CSS px width.

Files: C1-before-click-sheet10.png, C2-after-click.png, C3-sheet1-after-agent-markup.png, C-click-and-jump.gif, driver-log-look-in-clean.json.
