# REDBEAM 0.3.70 (9f79b25), live multi-agent captures, AARON-SLS, 2026-11-24

These were captured from the installed x64 build. The agents were real `REDBEAM.exe --mcp` processes speaking MCP over stdio, with clientInfo set to claude-ai, claude-code and chatgpt. Each image shows only the REDBEAM window, captured with PrintWindow. Capturing never activated the window or raised it in z-order. REDBEAM was never the foreground window: the foreground stayed on another app for the whole run. All PDFs are scratch copies of `fixtures/ui/sweep.pdf`. The person's tab (`scratch-6`) was left over from an earlier thread's test session.

The UI was driven through UI Automation: ExpandCollapse on a chip, SelectionItem on a tab. No mouse or keyboard input was used.

| File | What it shows |
|---|---|
| 01-three-agents-background.gif | 20 s with three agents calling go_to_page, find_text and create_markup a second apart, while the person's tab stays put. Claude and ChatGPT reopened files still owned by the ended sessions from the earlier test, so instead of working they raised "wants to work in …" asks in the strip (06). Only Claude Code worked here. |
| 02-group-opens.gif | Three fresh sessions at work. The Claude Code chip is expanded, which unfolds its tab beside the chips. |
| 03-look-in-cursor.gif | The person opens the Claude Code chip, then its TowerB3 tab. An InfoBar reads "Claude Code 4 is working in this PDF. The view follows it. [Make this tab mine]". The violet cursor and the "Drawing an area" label appear for about 1.5 s of the 25. |
| 04-ask-bar.gif | Claude 6 calls go_to_page on the person's own PDF. An InfoBar asks "wants to turn pages and zoom in this PDF … [Let it work here]", and the call is refused in band until the person answers. |
| 05-chips-pills-whatsnew.png | After test a–j: four chips in the strip, activity pills stacked over the person's canvas (top left), and What's New opened over the view after the update. |
| 06-ask-between-agents.png | "ChatGPT 2 wants to work in Clinic [Allow] [Not now]": the person is asked to referee a file held by an ended agent. |
| 07-cursor-label.png | One cursor frame: a violet pointer with the label "Claude Code 4 · Drawing an area". |
| 08-ask-bar-person-pdf.png | A still of the ask bar in the person's PDF. |
| 09-chip-strip-crowded.png | With 9 or more sessions (most of them ended), the chips shrink to "Cl", "Ch" and bare dots. |
