# S9 person undo: cases A to F, b2929aa (0.3.83), AARON-SLS, 2026-11-25 ~16:00Z

**Setup**
- Desktop unlocked, scratch PDFs, window maximized.
- The person draws a dimension with real mouse clicks: the Dimension button, then two points (the tool commits on the second).
- The guest session is a real `REDBEAM.exe --mcp` (chatgpt) and draws an area with `file` set and no page.
- Ctrl+Z is real `keybd_event` input. `undo` comes from `redbeam_get_ui_state`, the status line from UI Automation text, and counts from `list_markups`.

| Case | How the key arrived | Count before → after draw → after key | undo before → after | Status line | Result |
|---|---|---|---|---|---|
| A | Clicks, then Ctrl+Z, no foreground change, no agent markup | 0 → 1 → 0 | canUndo true, "create dimension", depth 1 → false, null, 0 | "undid create dimension" | PASS |
| B | Clicks, guest area, Ctrl+Z, no foreground change | 0 → 1 (+1 guest) → guest only | depth 2 → 1, canUndo false | "undid create dimension" | PASS (guest stays) |
| C | As B, then Notepad in front, then REDBEAM brought forward programmatically (AttachThreadInput + SetForegroundWindow), then the key about 1.5 s later | dimension gone, guests stay | depth 3 → 2 | "undid create dimension" | PASS |
| D | As C, plus one real click on a neutral spot (the left panel footer), then Ctrl+Z | 0 → 1 (+guest) → guest only | depth 2 → 1 | "undid create dimension" | PASS |
| E | A person dimension still there after a failed Ctrl+Z (from F): real Ctrl+K, type "Undo", Enter | | | "undid create dimension" | PASS |
| F | As C, but the key sent by my older helper: ALT tap + SetForegroundWindow, then Ctrl+Z 400 ms later. This is how the earlier failing S9 rerun sent it. | 3 of 3 tries: the dimension stays | depth unchanged (2→2, 4→4, 6→6), canUndo true | no "undid" line | **key lost** |

**Conclusion:** REDBEAM's undo is correct. Ctrl+Z undoes only the person's work and leaves the guest's markup, in every case where the key reaches the page. The earlier S9 failure was my key helper. Its ALT-tap activation followed by a key 400 ms later loses the Ctrl+Z before the page sees it.

I could not read which element had keyboard focus: GetGUIThreadInfo returned no focus or active window for REDBEAM's thread while REDBEAM was in front.

**Harness slips, not REDBEAM faults:**
- The first D and E attempts clicked the "+" (open a drawing) button, which sits at about 81% of the maximized width. That opened the native "Open a drawing set" dialog, which took the Ctrl+Z, and "Undo" was typed into its file-name box. I closed that dialog with Escape.
- One E attempt in the restored window clicked Settings. It was closed with Escape and redone (E above).
