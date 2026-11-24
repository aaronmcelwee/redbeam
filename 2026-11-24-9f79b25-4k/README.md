# REDBEAM 0.3.70 (9f79b25) at a 4K full-screen layout, AARON-SLS, 2026-11-24

These captures are sized the way a full-screen window looks on a 4K monitor at Windows' recommended 150% scaling: 2560×1440 CSS px at 1.5× device scale, which renders 3840×2160.

Why not the installed window: this laptop's screen is 2400×1600, and Windows will not size a window larger than the screen. The 4K layout is therefore rendered by the same app code (this commit's `apps/desktop`, served by Vite) in Chromium, with the UI sweep's Tauri mock (`tools/ui-sweep/tauri-mock.js`). The three agents are the mock's bridge clients, named the way Claude, Claude Code and ChatGPT's MCP servers name themselves. They call go_to_page, find_text and create_markup about a second apart. The live installed-app captures are in `../2026-11-24-9f79b25/`.

PNGs are full 3840×2160. GIFs are downscaled to 1920 wide to stay under 8 MB.

| File | What it shows |
|---|---|
| 4k-01-person-view-three-agents.png | The person's own PDF (North Campus set) with three agent chips at the right of the tab strip, each with its live action ("Drawing an area", "Searching for “CEILING”"). The person's view and sheet are untouched. |
| 4k-02-person-typing-agents-working.png | The person types "A6.0" into Find a sheet while the agents work. The keyboard stays in the field. |
| 4k-03-group-open.png | The Claude chip clicked: its group unfolds its tab (Tower A) inline in the strip. |
| 4k-04-look-in.png | The person opens Claude's Tower A tab. The InfoBar reads "Claude is working in this PDF. The view follows it. [Make this tab mine]", and Claude's areas are drawn in scope ACT-1's colour. |
| 4k-05-ask-bar.png | Claude Code tries to turn pages in the person's PDF, and the ask bar appears. |
| 4k-06-start-page-card.png | One agent finished and the person closed their PDF. The start page lists the agents still at work. |
| 4k-07-cursor-at-4k-1920.png | A look-in frame with the cursor (lower left, "Claude · Drawing an area"). At 4K the pointer is about 10 px and the label is small. |
| 4k-a-three-agents-person-view.gif | 12 s of the person's view while three agents work: the chips' action text changes, and nothing else on screen moves. |
| 4k-b-group-open.gif | The open group, live. |
| 4k-c-look-in-cursor.gif | 18 s inside Claude's tab: the view follows the agent's page turns, areas land, and the cursor and label appear in about 13 of 44 frames. |
| 4k-d-ask-bar.gif | The ask bar, live. |

## Seen at 4K
- The strip has plenty of room: the three chips use about a quarter of it, and their action text is readable.
- The cursor and its label are small for a 4K screen and show only part of the time. Making them larger and brighter, and keeping them up between actions, would meet "brightly coloured cursors".
- The activity pills that stacked over the canvas on the small window do not appear in this run.
