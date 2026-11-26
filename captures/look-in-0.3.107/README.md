# Look-in diagnosis, REDBEAM 0.3.107, AARON-SLS, 2026-11-26 ~20:10Z

**Read: the click never reached the button.** Windows toast notifications were stacked over the bottom-right of the screen, on top of REDBEAM's Agents list: a Claude desktop app notification and a "Windows Update — Restart to install…" toast. The real click at the row's centre landed on the toast window, which took the foreground ("ShellExperienceHost | New notification"). The page got only a window blur: no pointerdown, mousedown or click. The look-in handler itself works: the row's `.click()` from DevTools took the window to the agent's sheet.

**Setup**
- Fresh scratch copy C:\temp\rb-108\LookIn.pdf (12-sheet sweep), opened by the person.
- Agent: start_session, open_file (yours:false), go_to_page 5, one create_markup on page 5.
- The person real-clicked sheet row 10, giving "10 / 12", 60%.

| Step | Result |
|---|---|
| 4. Agent get_ui_state before the click | pageIndex 5, person.pageIndex 9 |
| 1. `.agentfile` buttons | 1 in the showing workspace, 1 in the whole document |
| 1. Row | text "LookIn your PDF"; class `agentfile active`; not disabled; pointer-events auto |
| 1. Row rect (CSS) | x 1138.7, y 605.2, w 287.3, h 24; centre 1282.3, 617.2 → physical 2055, 1017 |
| 1. Row title | "C:\temp\rb-108\LookIn.pdf / Your PDF. Claude Code · look-in test is working in it with you. Click to go to the sheet it is on." |
| 1. elementFromPoint at the centre | SPAN.agentfile-name, a descendant of the row (inRow true) |
| 2. Capture listeners, then a REAL click at 2055,1017 | window.__clicks = [window-blur, window-blur]; **no pointerdown, mousedown, pointerup, mouseup or click** |
| 2. Foreground before / after | "redbeam \| LookIn — REDBEAM" → "ShellExperienceHost \| New notification" |
| 2. document.hasFocus() before / after | true → false |
| 2. Page indicator 1 s later | 10 / 12 (unchanged) |
| 3. row.click() from Runtime.evaluate | click event on BUTTON.agentfile; page indicator 1 s later **6 / 12** |
| 3. Real click on sheet row 2 right after | 2 / 12 (real clicks reach the page elsewhere) |
| 4. Console errors (Runtime.exceptionThrown / Log.entryAdded) | none |
| 5. Few-tab window | skipped: every launch restores 60+ person tabs from earlier sessions, and closing tabs that are not mine was not allowed |

I kept the screen grab of the notification stack out of this public repo, because it shows another project's notification text.

**Implication for earlier runs:** the persistent "ShellExperienceHost / New notification" foreground seen since 2026-11-25 was these toasts. It explains why Notepad could not hold the foreground and why bottom-right clicks missed.
