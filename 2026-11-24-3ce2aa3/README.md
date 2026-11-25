# REDBEAM 0.3.78 (3ce2aa3), AARON-SLS, 2026-11-25

**Build:** built locally from 3ce2aa3 (`npx tauri build --target x86_64-pc-windows-msvc --bundles nsis`, 234 s on a warm cache) and installed per-user.

**Agents:** real `REDBEAM.exe --mcp` processes.
- P1 (claude-ai) ran two sessions: "Tower A ceilings takeoff" and "Clinic intake review".
- P2 (chatgpt) ran "Nokia Canada North Campus takeoff", and later "Reference check".
- A third process (claude-code) ran "Level 2 ceilings handback" and "Observer".
- All PDFs are scratch sets made with pdf-lib, including a 300-page set.

**Captures:**
- Light theme. Window only, through PrintWindow, which never activates the window.
- The window is at its default size (1456×909 logical). Windows will not size a window larger than this laptop's 2400×1600 screen, so a 4K window was not possible.
- The desktop was locked (LogonUI) for this run. PrintWindow captures still work while locked. Real keyboard input does not, so S9's Ctrl+Z could not be run.
- The UI was driven through UI Automation (Expand/Collapse, Invoke, Select). No mouse was used.

| File | Standard | What it shows |
|---|---|---|
| 01-three-sessions-folded.png | S1/S2 | Three pills in three colours, folded, each reading app + task. |
| 02-pill-unfolded.png | S3 | The Claude · Tower A pill unfolded into its real tab (squeezed to "T."). |
| 03-pill-folded-again.png | S3 | Folded again. |
| gif-fold.gif | S3 | Unfold, then fold. |
| gif-work.gif | S4/S5 | Looking in on ChatGPT's Tower-B while three sessions draw and search, about a second apart. |
| 04a-before-kill.png / 04b-after-kill.png / gif-kill.gif | S4 | ChatGPT's --mcp process killed (taskkill /F) during find_text over the 300-page set. Its session left the live list 21.8 s later and moved to Finished as "its app stopped answering" (see 08c). |
| 08a-waiting-for-you.png | S8 | The Claude · Tower A pill shows "Waiting for you". Also visible: four InfoBars stacked over the drawing. Two are one agent asking about another agent's tab. |
| 08b-after-end-session.png / gif-end.gif | S8 | After end_session for a session that wrote nothing: both its PDFs closed. |
| gif-handback.gif | S8 | "Level 2 ceilings handback" writes in Handback-Write.pdf, reads Handback-Read.pdf, and ends. The written PDF goes to the person's tabs and the read one closes. |
| 08c-finished-list.png | S8 | The Finished list: summary, "Now in your tabs", "Only read, so closed. Pick one to reopen it.", "its app closed" and "its app stopped answering". |
| 08d-after-reopen.png | S8 | Handback-Read reopened from the Finished list as the person's tab. |
| 09-person-tab-guest-dot.png | S9 | Meant to show the guest dot. It shows the look-in tab instead; the person's tab is in the "+4" overflow, so the dot is not visible. |
| 09b-after-agent-undo.png / gif-undo.gif | S9 | After the agent's own redbeam_undo, exactly its last markup is gone. |
| driver-log.json | all | The full driver log, with every call and answer. |
