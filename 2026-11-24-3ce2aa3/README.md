# REDBEAM 0.3.78 (3ce2aa3), AARON-SLS, interim (2026-11-25 ~02:05Z)

These shots come from the installed build, built locally from 3ce2aa3 and installed per-user. They show the REDBEAM window only, captured with PrintWindow, which never activates the window. The theme is Light. The window is at its default size (1456×909 logical): Windows will not size a window larger than this laptop's 2400×1600 screen, so no 4K window was possible here.

The agents are two real `REDBEAM.exe --mcp` processes. P1 (claude-ai) runs two sessions, "Tower A ceilings takeoff" and "Clinic intake review". P2 (chatgpt) runs one, "Nokia Canada North Campus takeoff". All files are scratch PDFs made with pdf-lib.

| File | What it shows |
|---|---|
| 01-three-sessions-folded.png | Three session pills, folded, beside the person's tabs. |
| 02-pill-unfolded.png | The Claude · Tower A pill unfolded through UI Automation. Its tab is squeezed to "T.". An orange "Checking what is open — Claude · Tower A ceilings takeoff" card sits over the person's own PDF (Person-North-Campus), top left. |
| 03-pill-folded-again.png | Not a fold: the second click failed in my harness (UIA Expand on an already-expanded pill), so this is the same state as 02. |

The full run was stopped by a harness bug (a recording promise that never resolved). It is being rerun. The final set will replace this README.
