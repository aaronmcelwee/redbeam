# Changelog

Releases are Windows installers for x64 and ARM64, published at
https://github.com/testusercar/redbeam/releases. Both installers are unsigned;
SmartScreen will ask once.


## 0.3.66 — 2026-11-24

### Closing the window always does something

- **The X closes, or says why it can't yet.** Closing a window could do nothing at all, with no message, while its takeoff was being saved into the PDF. Now the window closes once the save lands, and if the save takes more than a few seconds REDBEAM asks: save a copy, leave without saving, or keep working.
- **Alt+F4 and the taskbar's Close too.** Every way of closing the window saves the takeoff first, then closes for certain.


## 0.3.65 — 2026-11-24

### Copy and paste markups between PDFs

- **Paste into another open PDF.** Select markups, press Ctrl+C, switch to another PDF's tab and press Ctrl+V. They land in the same place on the sheet, at their real size, so they measure the same.
- **Scopes come along.** A pasted markup goes into the scope with the same name in the other PDF. If that PDF doesn't have one, REDBEAM adds it with the same colour and product.
- **Copies don't stack.** Pasting again onto the same sheet places each copy a little further down and to the right.
- **Copy from the right-click menu.** Right-click a markup and choose Copy markup. Dimensions and callouts keep their text when pasted.


## 0.3.64 — 2026-11-24

### AI apps stay in one window

- **No extra windows.** When an AI app opened a PDF just as REDBEAM was starting, or opened two PDFs one after the other, each could land in a new window. They now open as tabs in the window that's already there.


## 0.3.63 — 2026-11-24

### AI apps can do a whole takeoff

- **Products say what they need.** An AI app can ask what a product needs (spacing, stock length, connector spacing and so on), with the exact field, unit and default for each. A scope that can't be counted yet names the fields to fill in, and a value written where nothing reads it is flagged.
- **Product type and pattern set by the app.** A new scope can be given its product type directly. The pattern's start point (a point, a corner, an edge, the centre or automatic) and its direction (for the scope, a sheet or one area) can be set and read back.
- **Reading the drawing.** Line reading can keep only lines inside a box, horizontal or vertical lines, or a length range, without duplicates. An app can also read a drawn pattern's spacing, member length, runs and rows, and trace the closed outline around a point.
- **Scales and sheet names.** The scales printed on each sheet are read with their positions and checked against the scale that's set, or against a written dimension. Pages that the bookmarks leave as plain numbers are named from their title blocks, and so are spec sections and addendum pages.
- **Addenda.** A sheet issued again later in the set is marked as replaced, sheets can be linked by hand, and scopes with takeoff on a replaced sheet are listed.
- **Drawing the takeoff.** Outlines can have true arcs and circles, many markups can go in at once as a single undo step, and a working copy can leave out other apps' markups. Cutouts are taken out of baffle, plank and panel patterns.
- **Output.** A piece list gives every run's pieces with their cut lengths (including pieces cut to fit), stock use and parts, and can be exported as a spreadsheet. Exports can be written to a chosen file. The PDF now keeps a history of who changed each markup and scope (a person or an AI app) and when.


### AI apps work more surely

- **A change is confirmed once it has happened.** When an AI app draws, deletes, rescopes or sets a scale, it is told the result after the change has landed, with the measure and any warning, such as no scope or no scale on the sheet.
- **The right sheet and the right file.** A change can name its sheet (by page or sheet number) and its PDF. It lands there, and is refused if a different PDF is showing.
- **Saving and undo.** An app can save the takeoff into the PDF and learn how it went, see whether everything is saved, and undo or redo.
- **More it can do.** Reshape or move a markup, copy markups to another sheet, draw a dimension, rotate sheets, bring scopes in from another PDF, accept imported markups, read the PDF's notes, links and bookmarks, close a tab, and read or change settings.
- **No stolen focus.** When an AI app opens a PDF, REDBEAM stays where it is instead of jumping in front of what you're working in.
- **Clearer tools.** Each action has its own tool with its own inputs, lists of markups and scopes come back with quantities and names, and errors say what would have worked.


## 0.3.62 — 2026-11-24

### A new estimate PDF, with a picture of every area

- **White paper that prints.** The estimate PDF is redesigned on white: a cover with the totals and a key plan of the takeoff, then the quantities, then the pictures.
- **A picture of every area, drawn from the sheet.** Each takeoff area gets its own snapshot, copied from the drawing itself rather than a screenshot, so it stays sharp when you zoom. The drawing is dimmed so the takeoff stands out: products inside the boundary are bold, and offcuts past it are faded.
- **One scale, so rooms compare.** Rooms print at one scale even when their sheets were drawn at different scales, and small rooms print together at one larger detail scale. Every picture names its scale.
- **Perimeter trim on the edge of the area.** Trim is drawn along each area's boundary with a tick at every joint, and the picture shows the same lengths the quantities count.
- **Long names fit.** When the estimate and the file share a name, the cover says it once, and a long file or sheet name wraps after its hyphens instead of running off the page.
- **Nothing left out quietly.** Takeoff on a sheet with no scale is listed as not measured, and a sheet the export can't read is noted.

### Perimeter trim counts more carefully

- **Each area is counted at its own sheet's scale.** A scope spread over sheets drawn at different scales could count a room's trim at twice or half its real length, depending on which sheet was open.
- **A curved wall is one run.** A bend of less than 20° keeps a length going, and a corner starts a new one, so round and curved rooms drawn with many short sides count fewer lengths.


## 0.3.60 — 2026-11-24

### Takeoff survives merging and rearranging pages in Bluebeam

- **Merged PDFs open with their takeoff.** A PDF with REDBEAM markups that was combined with another PDF in Bluebeam now opens with all of its takeoff, on the sheets where the markups are now. Before, REDBEAM said part of the takeoff could not be loaded and would only save a copy.
- **Each sheet carries its own takeoff.** Its markups, scale and scopes are saved on the sheet itself, so inserting, deleting, reordering or extracting pages in Bluebeam takes the takeoff along with the sheet.
- **Two marked-up PDFs become one takeoff.** Scopes with the same name are joined. Markups on sheets that were deleted are left out, and REDBEAM tells you how many.
- **Files from before this update recover too.** REDBEAM finds each of its markups on the page where it is now. The next save puts the file back in order.


## 0.3.58 — 2026-11-24

### AI apps can measure, and keep a client's file clean

- **Measure without drawing.** Claude or ChatGPT can measure a distance or an area between points at the sheet's scale, and read the drawing's own lines in a box with their lengths. Nothing is drawn or saved, so there's no more guessing sizes from screenshots.
- **Takeoff on a copy.** REDBEAM keeps takeoff inside the PDF. For a client's tender file, an AI app can now save a working copy beside it and do the takeoff there, leaving the original as it came.
- **Lighter close-ups.** Close-ups from AI apps are 1200 pixels wide by default instead of 2000, and the app can ask for more or less.


## 0.3.57 — 2026-11-24

### Imported Bluebeam markups wait for your yes

- **Bluebeam markups come in pending.** Areas and lengths brought in from the PDF are drawn dashed and count toward nothing until you accept them.
- **Accept by giving one a scope,** or with **Accept imported markups…** in the command palette, for the selected markups, the whole sheet or the whole PDF.
- A pending markup you leave alone stays exactly as Bluebeam saved it.


## 0.3.56 — 2026-11-24

### Bluebeam markups you can work with

- **Bluebeam areas and lengths are REDBEAM markups now.** When a PDF opens, its Bluebeam (or Acrobat) areas, rectangles, polylines and measured lines, cutouts included, become ordinary markups with no scope. Select, move, reshape or delete them like anything you drew, and give an area a scope to make it part of that takeoff.
- **Nothing is doubled or lost in Bluebeam.** A markup you leave alone stays exactly as Bluebeam saved it. One you change or give a scope is saved as REDBEAM's, in place of the original. One you delete is deleted from the PDF too.
- Clouds, arrows, text boxes and stamps stay Bluebeam's, drawn on the sheet as before.


## 0.3.55 — 2026-11-24

### Claude and ChatGPT can read your sheets closely

- **Hide markups to see the drawing.** New in the command palette: *Hide the PDF's own markups* (Bluebeam's or anyone's), *Hide REDBEAM markups*, and *Hide all markups*. Nothing in the file changes, and a bar at the top says while they're hidden, with a button to bring them back.
- **Sharp close-ups for AI apps.** Claude or ChatGPT can now ask REDBEAM for one part of a sheet rendered at high resolution, instead of cropping a blurry screenshot of the whole sheet.
- **AI apps can find where text is.** Searching for a tag like C-7 now tells the AI app where it sits on the sheet, so it can zoom to it or take a close-up of it.
- **AI apps know your sheet names.** They see each page as its sheet number and title, A4.0 FLOOR PLAN rather than "page 5", and can go to a sheet by its number.
- **AI apps can hide markups too**, for a clean look at the drawing, and the bar tells you when they have.


## 0.3.54 — 2026-11-24

### Pro mode is retired, and AI agents work in Light

- **Claude and ChatGPT stay in the PDF you have open.** When an AI app drives REDBEAM, it now reads and changes the takeoff of the PDF showing in the window, the same one you see, saved into that PDF. Before, it went looking for a project and switched the window back to the old Pro screens.
- **Pro is gone.** REDBEAM is a PDF viewer that does takeoffs, and nothing else: the Mode setting and the Light/Pro switch on the start screen are removed, and nothing (a click, a link or an AI app) can open a project any more. An old project folder still works the same way as before: open a PDF from it and its takeoff moves into that PDF.


## 0.3.53 — 2026-11-24

### Tools you can find and name

- **Toolbar buttons have labels.** Each tool now shows its name, beside the icon when there's room and in a small caption under it when there isn't. On a narrow window the page and zoom controls move up a row to make room. Only a very narrow drawing goes back to icons alone.
- **A Zoom button beside Pan and Select.** Drag a box around part of the sheet to fill the window with it. Z still does the same.
- **An Origin tool for the pattern's 0,0.** In takeoff, beside Direction: click an area's corner, an edge or a point inside it, and its panels or baffles start from there. It snaps to the corner or edge, and to the drawing's own lines. The right-click "Start the pattern here" still works.
- **Every tool shows its shortcut** when you hover over it. New keys: D for Dimension and O for Origin.
- **Darker text and icons in Light.** Body text, captions and icons are near-black now instead of grey.


## 0.3.52 — 2026-11-23

### A tidy-up pass over every screen

- **Settings scrolls with the mouse wheel again,** and so does any list whose rows you were pointing at. Since 0.3.22 the wheel did nothing over most of Settings.
- **Escape closes things.** Settings, the app menu, the dock's menus, the tab menu and the sheet right-click menu all ignored Escape.
- **The dock's ⋯ menu no longer opens empty** in a narrow window. It now holds Dimension, which the dock folds away at that width.
- **Thumbnails stay the size of their pictures** in a short set instead of stretching to fill the pane.
- **The dock wraps to two rows** in a narrow window instead of sliding one half under the other.
- **The palette shows your commands** when it opens, not a single suggestion in an empty box.
- **A PDF that cannot be opened says so** in plain words, instead of "FPDF_LoadMemDocument failed" over a list that said "Opening the drawing…" forever.
- **No more database talk.** Opening a file no longer flashes "browser store · in memory", and searching no longer shows a "Limited search… page_text_fts" note.
- **Smaller things:** the scope menu no longer heads itself "Estimate" for a single PDF, long scope details end in "…" instead of being cut, the new scope field's hint fits, and a few faint captions are easier to read.


## 0.3.51 — 2026-11-23

### Light theme

- **REDBEAM now comes in Light as well as Dark.** The sheet list, tabs, Takeoff panel, menus, Settings and the start screen all have a light version, built from Windows 11's own light colours.
- **Choose it in Settings › General › Theme:** *Match Windows* (the default, so it follows Light or Dark in Windows Settings), *Light* or *Dark*. It changes straight away, and the glass behind the panels follows it.
- **Buttons and highlights use your Windows accent colour** in both themes, in the darker shade Windows itself uses on a light background.


## 0.3.50 — 2026-11-23

### Readable on a PC set to Light

- **Fixed text you could barely read** in the sheet list, the tab strip and the Takeoff panel when Windows is set to Light. REDBEAM's window now stays dark whatever Windows' app mode is, so the see-through glass behind the panels is dark too and the text sits on the ground it was designed for.


## 0.3.49 — 2026-11-23

### Several PDFs open at once

- **Open more than one PDF in a window.** Each PDF gets a tab across the top, like Bluebeam. *Ctrl+O*, double-clicking a PDF in Explorer and dragging one onto REDBEAM all open it in a new tab instead of replacing the one you have open.
- **Each tab keeps its own takeoff,** saved into its own PDF. Switching tabs saves the one you leave, and closing a tab saves it first.
- **Keys:** *Ctrl+Tab* and *Ctrl+Shift+Tab* switch tabs, *Ctrl+W* closes one and *Ctrl+Shift+T* reopens the one you closed.
- **REDBEAM reopens your tabs** the next time it starts. A file that has moved since is left out.


## 0.3.48 — 2026-11-23

### Bookmarks

- **See the PDF's bookmarks the way it was written.** The Contents panel has a *Sheets | Bookmarks* switch when the PDF has bookmarks. *Bookmarks* shows every bookmark, nested and in order, with folders you can open and close, like Bluebeam's Bookmarks panel. Click one to go to its page, or search with *Find a bookmark*.
- **Act on bookmarks too.** *Ctrl+click* or *Shift+click* several, or right-click a folder, to rotate, print or set the scale of every sheet under them.
- REDBEAM remembers which view you last used.


## 0.3.47 — 2026-11-23

### Work on several sheets at once

- **Rotate, print or set the scale of a selection.** In the Contents list or the Thumbnails panel, *Ctrl+click* or *Shift+click* to pick several sheets, then right-click. Rotate them clockwise, counterclockwise or 180°, print them, or set one scale for all of them. Turns save into the PDF and the takeoff on each sheet turns with it.
- **Thumbnails can be selected.** Picked pages are highlighted, and a plain click still goes to that page.


## 0.3.46 — 2026-11-21

### Print

- **Print this sheet with *Ctrl+P*.** It opens the Windows print dialog, where you pick the printer, paper size and fit.
- **Print every sheet, or a range.** In the command prompt (*Ctrl+K*), "Print all sheets" prints the whole set and "Print sheets…" takes sheet numbers like *1-5, 8*, numbered as in the sheet list.
- **What prints is the PDF with your takeoff on it,** the same file "Save a copy" makes. Linework stays sharp at any paper size, and a sheet you turned prints turned.


## 0.3.45 — 2026-11-21

### Turn a sheet

- **Rotate a sheet.** A sheet that comes in sideways can be turned a quarter turn at a time, from the zoom menu or the command prompt (*Ctrl+K*, "Rotate sheet"). Everything you drew on it turns with it, so areas, runs and counts stay on what they were drawn over and every quantity stays the same.
- **The turn is saved in the PDF.** The sheet opens turned in Bluebeam and any other PDF viewer, with the takeoff on it.
- **Undo starts again from the turn.** Shapes from before it cannot be undone across it, and REDBEAM says so.
- **Sheets that were already turned in the PDF now line up.** Text selection, links, snapping and imported Bluebeam markups were all placed as if those sheets were upright.


## 0.3.44 — 2026-11-21

### Getting around a drawing set like any PDF viewer

- **Links in the PDF work.** Many sets have their detail bubbles and sheet numbers linked to their sheets. Clicking one now goes to that sheet; the pointer turns into a hand over a link. Web links in the PDF open in your browser.
- **Back and Forward.** After jumping to another sheet, *Alt+Left* takes you back to where you were, at the same zoom and spot, and *Alt+Right* goes forward again. The Back and Forward buttons on a mouse do the same, and both are in the command prompt.
- **Zoom to a box.** Press *Z* and drag a box around the part of the sheet you want to see; it fills the window. Click instead of dragging to zoom in on that spot. It is also in the zoom menu, and *Esc* cancels it.
- **Select and copy text.** The new *Text* tool (*T*) selects the words inside a box you drag. *Ctrl+C* copies them line by line, ready to paste into an email or an RFI. A scanned sheet has no text to select, and REDBEAM says so.


## 0.3.43 — 2026-11-20

### Finishing a shape is faster

- **Enter takes about a third of the work it did.** Finishing an area, run or count used to redraw the whole window six times in a row. It now redraws once, with the new shape, its quantities and the estimate totals all arriving together. On the 80 MB Scottsdale set with the processor slowed to a slow laptop's pace, the work behind each Enter fell from about 66 ms to about 25 ms, and the shape and totals appear about 20 ms sooner.
- **Undo and redo got the same treatment**, one redraw instead of three.
- **No more background redraws.** The window was quietly redrawing itself twice a second for a performance readout that is normally hidden. It now redraws only when something changes.

## 0.3.42 — 2026-11-20

### See what's new after an update

- **What's new opens after an update.** The first time REDBEAM starts on a new version, it shows what changed. If you skipped a few updates, it lists every release since the one you last saw, newest first.
- **Find it again any time.** Settings › About › *What's new*, or type "what's new" in the command prompt.
- A new install starts quietly; the notes appear from the next update on.

## 0.3.41 — 2026-11-20

### Let Claude and ChatGPT use REDBEAM

- **One click to add.** Settings › Claude and ChatGPT has *Add to Claude* and *Add to ChatGPT*. REDBEAM is its own connector (an MCP server), so there is nothing else to install: the button adds REDBEAM to the Claude desktop app (and to Claude Code, if you use it) or to the ChatGPT desktop app (Settings › MCP servers, shared with Codex). Restart Claude or ChatGPT afterwards. *Remove* takes it out again and leaves everything else in their settings alone.
- **What they can do.** Open a PDF, look at the sheet, read scopes and quantities, set the scale, create scopes and draw takeoff, and export, all in the window you are looking at. Their changes go on the undo stack like yours and are saved into the PDF the same way.
- **You stay in charge.** *Let AI apps use REDBEAM* switches it on and off, and nothing can connect while it is off. If REDBEAM is closed when Claude or ChatGPT asks for it, it opens.
- ChatGPT on the web cannot reach apps on your computer; use the ChatGPT desktop app.

## 0.3.40 — 2026-11-20

### A redrawn icon, and the same icon everywhere

- **A crisper icon.** The prism is now drawn rather than rendered: a faceted white crystal on a graphite tile, with white light going in and a red beam fanning out. It has soft gradients and gentle depth, in the style of a modern Mac app icon, and it stays clear in the taskbar at 16 px.
- **One icon throughout the app.** The title bar, the start screen, the command palette, Settings › About and the browser tab all show the icon. The red "RB" squares are gone.
- **A branded installer.** The installer shows the icon in its header and sidebar.

## 0.3.39 — 2026-11-20

### REDBEAM can be your PDF viewer

- **In Open with.** The installer registers REDBEAM for PDFs, so right-clicking a drawing in Explorer offers *Open with › REDBEAM*, and Windows lists it in Settings › Apps › Default apps. Bluebeam (or whatever opens PDFs now) stays the default until you choose otherwise.
- **Make it the default.** Windows makes you choose the default yourself, so REDBEAM takes you there: *Make default…* on the start screen, or Settings › About › Default PDF viewer, opens Default apps on REDBEAM's page. Settings says when REDBEAM is the default. *Not now* hides the start-screen offer for good.
- **One REDBEAM.** Opening a PDF while REDBEAM is running opens it in the running app instead of starting a second copy: the window already showing that file comes forward, a window on the start screen opens it, and otherwise it gets a new window.
- Uninstalling removes the registration; an update keeps it, so a default you chose is not reset.

## 0.3.38 — 2026-11-19

### A new app icon: a glass prism

- **REDBEAM has its own icon.** A clear glass prism turns a white beam into a red one, rendered in Blender with Cycles. It replaces the placeholder orange in the taskbar, Start menu, installer and window title.
- **Sharp at every size.** The taskbar and title-bar sizes (16 to 44 px) use a closer, simpler render with thicker beams, so the prism still reads as a prism at 16 px.

## 0.3.37 — 2026-11-19

### Every panel follows Windows 11's own rules

- **One type ramp, Windows' own.** Text is now only Caption 12, Body 14, Body Large 18, Subtitle 20 or Title 28. There were 19 different sizes, down to 10px; dense lists stay dense at Caption 12 rather than going smaller.
- **Quantities in the system face.** Figures were set in a monospace font; they are now Segoe UI Variable with even-width digits, so columns still line up and a number reads in the same voice as its label.
- **Corners, shadows and focus match Windows.** 4px corners on controls and 8px on cards and flyouts (there were 13 different radii), Fluent's flyout and dialog shadows, and the white-and-black focus ring everywhere, including the start screen, Settings and the palette.
- **The Takeoff panel, tidied.** Markup icons no longer run into their names; markup rows are a true 24px; the toggle is Windows' 40 × 20; By sheet / By kind uses the SelectorBar's small pill; InfoBars use Fluent's severity icons; section heads are Body Strong.
- **The breadcrumb keeps the scope visible.** A long set name used to push the scope off the end, cut mid-word. The path now shortens with an ellipsis and the current item stays whole.
- No uppercase or letter-spaced labels remain; group headings are sentence case.

## 0.3.36 — 2026-11-19

### The cutter is a one-shot cut into each markup

- **A cutout cuts and is gone.** Drawing one cuts a hole, trimmed to the
  edge, into every area it crosses. Each area keeps its own hole; nothing
  ties them together any more.
- **Moving an area moves only its own holes.** Before, moving one area of a
  cutout that spanned several dragged the shared cutout along and left a
  copy behind.
- **Remove a hole per markup.** Click inside it, or pick it under its area in
  the markups list, and press Delete; only that area changes.
- Each area still goes to Bluebeam as one area with its own cutouts.

## 0.3.35 — 2026-11-19

### Finishing a shape is quicker, and saves write only what changed

- **Finishing a shape is quicker.** Pressing Enter to finish an area, line or count used to search the takeoff three times and rebuild the panel's number formats on every redraw. It now searches once and reuses them: about 15–25% less work per finished shape on a large takeoff.
- **Saves write only the new bytes.** Each save into the PDF used to rewrite the whole 50–80 MB set on disk, which OneDrive then uploaded again. REDBEAM now adds only the takeoff update to the end of the file (usually a few kilobytes), after checking the file is still the one it last saved. If anything else changed it, the whole file is written as before.
- **Pan and zoom were measured** on an 80 MB set with the CPU slowed four times and stay at 60 frames a second, so they are unchanged.

## 0.3.34 — 2026-11-19

### Cutouts are part of the area they cut

- **The cutter cuts the area itself.** A cutout is no longer a separate
  markup: it cuts every area it crosses, and each area measures and draws as
  its outline less its cuts.
- **One cutout, however many areas it crosses.** Click it on the sheet or pick
  it in the markups list. Delete it and every area it cut is whole again;
  drag it and the cut moves in each of them.
- **Cutouts move with their area.** Moving an area takes its cuts along. If a
  cutout spans two areas and you move one, each keeps its own cut.
- **The same in Bluebeam.** Each area is saved as one Revu area with its
  cutouts and the net quantity, and the cuts come back as one cutout.
- Cutouts drawn as separate markups in earlier versions are folded into the
  areas they open when the drawing is opened. Ctrl+Z puts them back.

## 0.3.33 — 2026-11-19

### Takeoffs no longer stall while the PDF saves

- **Saving happens in the background.** A few seconds after each change, REDBEAM writes the takeoff into the PDF. On a 50–80 MB drawing set that froze the window for a quarter to half a second each time, in the middle of drawing. The PDF is now built on a background thread, so the sheet keeps responding while it saves.
- **The drawing is not read back from disk on every save.** REDBEAM keeps the copy it last saved instead of re-reading and re-checking the whole set each time. A file that changed on disk meanwhile (Bluebeam, OneDrive) is still noticed before anything is written, and the save then starts again from the file as it is now.
- **It waits for a pause.** The save into the PDF now waits until you stop clicking for a couple of seconds (and never holds a change for more than 30 seconds), instead of rewriting the set in a OneDrive folder between two clicks of a polygon.
- **Placing a point is cheaper.** Each click of an area or line no longer redraws the whole window, only the sheet.

## 0.3.32 — 2026-11-19

### A takeoff survives an app that drops REDBEAM's data

- **The takeoff is rebuilt from its markups.** Some apps keep the markups REDBEAM drew in a PDF and throw away the hidden data that said what they were. That file used to open with no takeoff and could only be saved as a copy. REDBEAM now reads its own markups back: each area with its cutouts, each run, each count, the scope it belongs to by name and colour, and each sheet's scale.
- **The next save puts the detail back** into the PDF, so the file is whole again.
- **What cannot come back is said.** Product details entered on a scope were only in the dropped data, so they need entering again, and a sheet whose scale the other app also removed needs its scale set again. A note in the warning bar says which applies.
- If even one markup cannot be read back, nothing is rebuilt and the file opens as before: untouched, with Save a copy.

## 0.3.31 — 2026-11-19

### The Takeoff panel follows where you are with a scope

- **A summary card on top.** Area, perimeter (or length, or count) and the parts list now sit together in one card at the top of the scope, always open.
- **Copy for your estimate.** The card's Copy button puts the summary on the clipboard as a two-column table, item on the left and number on the right, ready to paste into Excel.
- **Setup first, then markups.** A new scope opens with Setup. While you take off, and once you're done, Markups comes first and Setup folds to a one-line summary. Open or fold either one at any time.
- **Product is the first Setup field.** It used to be a small dropdown under the scope name.
- **Take off shows when it's on** for the scope you're looking at.

## 0.3.30 — 2026-11-19

### Two people's takeoffs no longer overwrite each other

- **A takeoff saved by someone else is not replaced.** If a PDF is open in two REDBEAM windows, or a synced copy comes in from a colleague, and the other side saves its takeoff first, REDBEAM used to save yours straight over theirs. It now notices the PDF carries a takeoff it has not seen and does not write.
- **You choose what happens to yours.** Ctrl+S, closing the file and closing the window all ask: save yours as a copy, or leave without saving and reopen the PDF to see theirs. A window that only looked at the file is not asked anything.
- Markups added in Bluebeam are not affected: they were already kept, and still are.

## 0.3.29 — 2026-11-19

### Start a PDF from another PDF's takeoff

- **Copy a takeoff from one drawing set to the next.** *Start from another PDF's takeoff…* in the command palette (Ctrl+K) brings another PDF's scopes and its markups into the file you have open. It is how last round's takeoff becomes this round's starting point.
- **Markups land on the matching sheets.** A markup goes to the sheet with the same number, when that sheet is the same size in both PDFs. Its scale comes with it where the open file has none for that sheet.
- **Nothing is guessed.** Markups whose sheet is missing, or was reissued at another size, are left behind and counted in the status line, so you know what to redraw.
- **Safe to repeat.** A scope the file already has by name is reused, and a markup that is already there is not added twice. The other PDF is only read.
- *Import scopes from another PDF…* is still there for bringing scopes without their markups.

## 0.3.28 — 2026-11-19

### REDBEAM is a PDF viewer that does takeoffs

- **Pro mode is parked.** REDBEAM now always opens PDFs and keeps each takeoff inside its file. The Light and Pro switch is gone from the start screen and from Settings. Nothing was removed from the app, and Pro will return once the PDF workflow is settled.
- **Coming from a project?** Open a PDF from the project's folder. Its takeoff moves from the project into the PDF as it opens, and the other PDFs are offered in one go (0.3.26).

## 0.3.27 — 2026-11-19

### Smooth pan and zoom again

- **No more freezes after a change.** Since 0.3.17 the takeoff is saved into the PDF a few seconds after every change. That save handed the whole PDF to the save step as a list of numbers, one per byte, so an 80 MB drawing set froze the window for several seconds each time and left pan and zoom stuttering afterwards. The PDF now goes across as plain bytes and the save takes a fraction of a second. It mattered most in Light mode, where the open PDF is often a full drawing set.

## 0.3.26 — 2026-11-19

### An older project's takeoff moves into its PDFs

REDBEAM now keeps a takeoff inside its PDF. A folder that was once a REDBEAM project still has its takeoff in a `redbeam.db` file beside the drawings, where a PDF opened on its own could not see it.

- **The PDF you open takes its takeoff with it.** When a PDF is opened from a folder (or a subfolder) of an older project, the scopes, markups and scales that project held for it are written into the PDF first, then the PDF opens with them.
- **The other PDFs are offered once.** If the project holds takeoff for other PDFs too, a note says how many and *Move them now* moves them all in one go. A PDF that is open in Bluebeam is skipped and tried again next time.
- **A PDF that is already ahead is left alone.** If a PDF's own takeoff was changed after the project last touched it, the PDF is the record and nothing is written over it.
- **Nothing is deleted.** Once every PDF has its takeoff, `redbeam.db` is moved into `.redbeam/superseded-…` in the same folder and is not looked at again. Until then it stays where it is.
- **Rounds become part of the scope name.** A project with more than one bidding round in use had scopes with the same name in each. In the PDF they arrive as "ACT-1 Ceiling (Bid 2)", so they can be told apart. A project with one round keeps its names as they are.
- **Scopes set up but never drawn in are kept.** They travel in the first PDF that is moved, which is the one being opened when it belongs to the project.

## 0.3.24 — 2026-11-19

### A Light takeoff is not lost on the way into its PDF

- **Saving waits for the PDF's own takeoff.** A file opens empty for a moment while its takeoff is read. A save in that moment, or after a read that failed, could write that emptiness over the takeoff. REDBEAM now saves into a PDF only once everything it carried is in the window.
- **A file REDBEAM cannot fully read is left alone.** A PDF saved by a newer REDBEAM, or by another app that dropped REDBEAM's takeoff detail, opens with a warning and is not saved over, so what it holds stays as it is. What you draw in it can be saved as a copy.
- **A refused save no longer closes the file.** If the PDF is open in Bluebeam or still syncing, closing the file, opening another or closing the window now asks: save a copy, try again, leave without saving, or keep working.
- **You can always save.** When the PDF itself cannot take the takeoff, *Save a copy…* writes the PDF with its scopes and markups wherever you choose. Ctrl+S offers it, the warning bar offers it, and *Save a copy with the takeoff…* is in the command palette at any time.
- **Every way of closing saves first.** Alt+F4, the taskbar, Windows shutting down and installing or restarting for an update used to skip the save that the window's own X button made.
- **Opening a PDF no longer rewrites it.** Reopening a file and paging through it counted as a change, so the whole takeoff was appended to the PDF again each time. A file is now written only when the takeoff changes.

## 0.3.23 — 2026-11-19

### Light mode: panel tabs in the title bar

- **The sidebar's tabs moved up.** In Light mode, Contents, Thumbnails and Search now sit in the title bar, in the spot to the right of the app logo where the project switcher used to be. The file's name was there before, but its tab already says it, so the sheet list starts one row higher. Pro mode is unchanged.

## 0.3.22 — 2026-11-19

### Sidebars stay put

- **No more bounce or scrolling past the end.** Scrolling the sheet list, the Takeoff panel, Settings, the command palette or any menu now stops dead at the top and bottom instead of rubber-banding, and the leftover scroll no longer carries on into the window behind it. A sideways trackpad swipe no longer tries to go "back" either. This is the same in Light and Pro.
- **No sideways scrolling in the panels.** A row a little too wide for its panel used to let the whole panel slide left and right. Panels now only scroll up and down; long names are cut off with "…" as before.

## 0.3.21 — 2026-11-19

### Takeoffs work in Light mode

- **Drawing an area no longer fails.** In Light mode, finishing an area, line, count or shape showed "could not create area: no project database is open". The takeoff was being sent to the project database, which Light never opens; it now stays with the PDF the way Light intends. Undo, redo, calibrating and deleting markups had the same fault and are fixed with it.
- **Undo stays in its own project.** With two Pro projects open in separate windows, Ctrl+Z in one could act on whichever project was opened last. Undo now always names the project it belongs to.

## 0.3.20 — 2026-11-19

### Keyboard and toolbar fixes

- **No more crosshair out of nowhere.** Pressing Ctrl+K to open the command palette also armed the Calibrate tool behind it, so the sheet showed a crosshair nobody chose. Ctrl+L, Ctrl+H and Ctrl+X did the same to other tools. Tool letters now only work on their own, without Ctrl, Alt or the Windows key (#29).
- **Arrow keys change sheets.** Left and Right step to the previous and next sheet, and so do PgUp and PgDn, which the ⋯ menu already listed but never did anything (#30).
- **Pan and Select stay on the toolbar.** On a narrow window one of them used to disappear whenever the other was in use. Both now show at every width (#31).

## 0.3.19 — 2026-11-18

### Light mode shows only what a single PDF needs

- **No project switcher.** The top-left of the window names the open PDF; it
  is no longer a drop-down of projects.
- **One file per window.** The "+" for opening another tab and *Pop out to
  context window* are gone. Open another PDF with Ctrl+O or *Open PDF…*.
- **No Files pane.** The left side is the PDF's Contents, Thumbnails and
  Search, and Search looks in this sheet or this document only.
- **The right panel is the file's Takeoff.** It opens straight on the file's
  scopes, with no list of estimates or bidding rounds to go back to, and the
  menu keeps *Save report* and *Save marked-up PDF* without Rename, Duplicate
  round or Delete round.
- **Settings and the command palette** leave out what only steers projects:
  reopening the last project, the recent-projects list, closing other tabs,
  and the round commands.
- **The start screen fills the window** (it stopped at its content before, in
  both modes).

## 0.3.18 — 2026-11-18

### Light mode: open a PDF, take off, and it saves into the file

- **REDBEAM now starts in Light mode.** The start screen opens PDFs instead of
  project folders, and lists the PDFs you opened recently. Open a drawing and
  take off straight away: scopes, markups, scales and counts are saved inside
  the PDF itself, and Bluebeam shows the markups with their scope and quantity.
  Nothing is kept anywhere else, so the file can be emailed, moved or put in
  another folder and the takeoff goes with it.
- **Saving.** The takeoff saves itself into the PDF a few seconds after each
  change, and again when you close it or open another one. Ctrl+S (*Save
  takeoff into this PDF* in the app menu) saves straight away.
- **Each PDF has its own scopes.** Scopes you make in a file are saved in that
  file even before anything is drawn with them.
- **Import scopes from another PDF.** For the next round of bidding, *Import
  scopes from another PDF…* in the app menu (or the palette) brings last
  round's scopes, with their colours and specifications, into the file you
  have open. Their markups stay behind, and a scope with a name the file
  already has is skipped.
- **Pro mode keeps projects.** Project folders, estimates and bidding rounds
  are all still there: switch to Pro at the bottom of the start screen, or in
  Settings › General › Mode.
- **Projects pick up changes made in Light mode.** When a drawing's PDF holds
  a newer takeoff than its project (someone changed it in Light mode), opening
  the drawing in Pro now takes the PDF's version instead of writing the older
  one back over it. Markups the PDF no longer has are deleted softly and can
  still be recovered.

## 0.3.17 — 2026-11-18

### No more Commit: takeoffs save themselves

- **Scopes save automatically.** The *Commit* button, *Commit again*, and the
  *Commit scope…* and *Commit every scope in the round* commands are gone.
  A moment after a scope's numbers change, REDBEAM records them on its own.
  One saved record is kept per scope per day, so the parts list still shows
  what each line *was* on an earlier day when it has moved since (for
  example "changed since 13 Nov").
- **The drawing's takeoff goes into the PDF as you work.** A few seconds after
  your last change, the open drawing's markups, scopes and quantities are
  saved into the PDF itself, so Bluebeam or a colleague on SharePoint sees
  them without you switching drawings or closing the project. A drawing
  that hasn't changed isn't rewritten. If the PDF can't be written (for
  example it's open and being saved in Bluebeam), REDBEAM says so once and
  tries again on your next change.

## 0.3.16 — 2026-11-18

### Markups survive the trip to Bluebeam and back

- **Cutouts reach Bluebeam as real cutouts.** An area's holes, and any separate
  cutout drawn over it, are now written into the drawing as Revu cutouts on
  that one area, so Bluebeam shows the net area and lets you edit the
  openings, instead of a separate "deduction" shape beside a gross area.
- **Changes made in Bluebeam come back.** Move, reshape or add and remove
  cutouts on a REDBEAM markup in Bluebeam, save, and REDBEAM picks the change
  up the next time the drawing is opened. Ctrl+Z undoes it. When the same
  markup was also changed in REDBEAM in the meantime, REDBEAM's version is
  kept and the status bar says so.

## 0.3.15 — 2026-11-17

### Menus open at full size again

- **The ⋯ menus show all their items.** The menus behind the ⋯ buttons in the
  estimates sidebar and the Export sheet, the right-click menu on an estimate
  round, and the right-click menu on a project on the start screen opened as a
  sliver a few pixels tall that had to be scrolled through. They now open to
  fit their items, and only scroll when they're taller than most of the window.

## 0.3.14 — 2026-11-17

### Change many markups at once, from the drawing or the list

- **Undo works after changing several markups together.** Moving, rescoping,
  deleting or pasting a group of markups and then pressing Ctrl+Z past it to
  an earlier edit of one of them was refused as "edited by someone else".
  Undo and redo now step through group changes like any other.
- **The scope's markup list can act on several markups.** Ctrl-click or
  Shift-click rows to select them (they're selected on the drawing too), or
  use *Select all*. Then *Move to* another scope, *Duplicate* or *Delete*
  them in one step. Plain click still goes to the markup.
- **Deleting or moving a markup from the list works on any sheet.** It used to
  do nothing, without a message, unless the markup was on the sheet you had
  open.
- **Duplicate on the drawing.** Ctrl+D, or *Duplicate* in the right-click
  menu, copies the selected markups in place, in their own scope, and selects
  the copies. One Ctrl+Z takes them all back.
- **Shift- or Ctrl-drag a selection box to add to the selection** instead of
  replacing it, so markups from two corners of a sheet can be picked together.
- **A change that can't be saved or undone says why** in the status bar
  instead of silently doing nothing.

## 0.3.13 — 2026-11-17

### A converted Bluebeam area is one shape with its holes

- **One area, holes and all.** 0.3.12 brought a Bluebeam area's cutouts in
  as separate cutout markups beside the area, so the outline and the
  openings did not form one shape. Now each converted area is a single
  REDBEAM area with its openings cut out of it, the way Revu keeps it. An
  opening wholly inside is a hole; one across the edge becomes a notch.
- **The hole is really a hole.** The fill leaves the opening clear, the
  selection outline includes it, clicking inside the opening doesn't pick
  the area, and moving or reshaping the area carries its holes along.
- **The numbers are net.** The markup list, the marked-up PDF export and the
  drawing's Bluebeam copy all show the area less its openings. Checked on the
  8 areas with cutouts in a Revu-saved set: each converts to one area whose
  square footage matches Bluebeam's.

## 0.3.12 — 2026-11-16

### Bluebeam areas keep their cutouts when converted

- **Converting a Bluebeam area brings its cutouts with it.** Revu stores an
  area's holes inside the same markup, which REDBEAM didn't read, so a
  converted area measured its whole outline. Now each cutout becomes a
  REDBEAM cutout in the same scope, and the area nets out to the same square
  footage Bluebeam shows. Checked on 8 areas with cutouts in a Revu-saved
  drawing set: every net area matched Bluebeam's to the hundredth.
- **The status bar says how many cutouts came across,** for example "3 PDF
  markups converted with 1 cutout".

## 0.3.11 — 2026-11-16

### Older projects carry their takeoffs into their drawings

- **Opening a project from before 0.3.7 updates its PDFs.** Those projects
  kept every takeoff only in the project database (redbeam.db), so Bluebeam
  showed bare sheets until each drawing had been opened and left in REDBEAM.
  Now, once the folder has been read, every drawing with takeoff in the
  database gets it saved into its PDF, the same way leaving a drawing does.
  The status bar says how many drawings were updated.
- **Nothing is taken out of redbeam.db.** The database stays the project's
  record and keeps everything; the PDF gets a copy. A drawing that cannot be
  written (open in Bluebeam, or changed while REDBEAM was reading it) is left
  exactly as it was and tried again the next time the project opens.
- **It happens once per drawing.** Drawings already done, drawings with no
  takeoff and files missing from the folder are not read again.

## 0.3.10 — 2026-11-15

### Right-click menus no longer get cut off

- **The menu stays on screen.** Right-clicking a markup, or the drawing
  itself, near the bottom or right edge of the sheet opened a menu whose
  lower rows were hidden past the edge. The menu now slides back inside the
  drawing area, the way the toolbar menus already did.

## 0.3.9 — 2026-11-14

### Count the panels and planks cut for devices

- **Factory-cut count on the Parts page.** A scope with devices in it now
  shows *Factory-cut for devices* under its parts: how many of its panels or
  planks have a light, diffuser or sprinkler in them. They are already in the
  part count above it; this says how many are a different order line.
- **In the estimate export too.** The CSV, the pasted table, the PDF and the
  report each carry the same line, with its confidence. It never adds to a
  total.
- A device that falls in the reveal between two planks is named rather than
  dropped, and a plank scope with no face width says so instead of showing 0.

## 0.3.8 — 2026-11-13

### See which panels and planks a device is cut into

- **Mark a count scope as a device.** A custom-assembly count scope has a new
  *Device* setting. Set it to *yes, through the ceiling* for lights,
  diffusers, sprinklers and anything else mounted through the product.
- **The pieces they land in are cross-hatched.** With the layout showing, every
  panel or plank that has a device in it is cross-hatched, because it is cut at
  the factory. A device on a seam marks both pieces. A device in the reveal
  between planks marks neither. A plank or baffle scope needs its face width
  set before a device can be placed in it.
- Counts of these pieces on the Parts page and in the estimate export come
  next. No quantity changes in this release.

## 0.3.7 — 2026-11-12

### Takeoffs travel inside the drawing, and Bluebeam can read them

- **Bluebeam shows REDBEAM's markups natively.** When you leave a drawing,
  close it or close the project, REDBEAM saves its takeoff into the PDF. Revu
  shows each area and length as its own measurement markup, with the scope as
  its subject and label, the net quantity in its comments ("2,211.84 sf",
  "115.20 ft"), and the sheet's scale ("1 in = 8 ft"). Deductions show as plain
  outlines. Bluebeam sees the scope label and the quantity, nothing else.
- **The detail stays REDBEAM's.** Layouts, counts and scope specifications ride
  along inside the PDF where only REDBEAM reads them. Open the drawing in
  another job folder and its takeoff comes in with it, as long as that project
  has nothing on the drawing yet. redbeam.db is still the record.
- **Bluebeam edits are kept.** Markups someone adds in Revu stay when REDBEAM
  saves again, and so does REDBEAM's own data when Revu saves. Checked by
  saving in Revu 21 and reopening on both sides. If a REDBEAM markup was moved
  in Bluebeam, that version is left as Bluebeam saved it.
- **Safe to write.** REDBEAM appends to the file rather than rewriting it,
  writes nothing when the takeoff has not changed, and does not write at all
  if the file changed on disk after REDBEAM read it, for example because it is
  open and saved in Bluebeam. The status line says when that happens.
- **Save takeoff into this drawing** in the command palette does it on demand.

## 0.3.6 — 2026-11-12

### New job folders index faster

- **The folder scan uses every core.** Opening a folder reads every PDF once to
  recognise it later if it is renamed or moved. That read ran one file at a
  time with a slow checksum, so a few gigabytes of drawings kept a new project
  empty for tens of seconds. It now runs on all cores with the processor's
  built-in SHA instructions: a 1 GB test folder went from 5.0s to 0.6s.
- **Search indexing writes in groups.** Each sheet's text was saved as six
  separate disk commits, which in a SharePoint-synced job folder cost more than
  reading the text did. Sheets are now saved sixteen at a time, and a new
  folder's document list is saved in one go.

## 0.3.5 — 2026-11-12

### A job is one redbeam.db that syncs through SharePoint

- **redbeam.db now holds the whole project, always.** REDBEAM kept a job's
  data in `redbeam.db-wal` and `redbeam.db-shm` beside the database and never
  folded it back, so `redbeam.db` stayed a 4 KB empty file. When a job folder
  synced through SharePoint, was copied, or opened on another PC without those
  side files, REDBEAM found an empty database and started the project over.
  Every save now goes straight into `redbeam.db`, with no side files left
  beside it, so syncing the one file carries the whole job.
- **Older projects are repaired on open.** A project whose data is still in
  its `-wal` has it written into `redbeam.db`, and the side files removed, the
  first time 0.3.5 opens it.

## 0.3.4 — 2026-10-16

### Patterns start at a corner by default

- **Every area starts at its top-left corner** unless you start it somewhere
  else. The first baffle, plank or panel sits on the area's own corner. Before,
  an area you had not started by hand began from the middle of its bounding
  box. This changes totals for those areas.
- **Pick the corner in Settings.** *Start each area's pattern at its* offers
  each of the four corners, or *automatic* for the old start (the shared sheet
  grid for panels, the fewest pieces for runs).
- **Start the pattern at the nearest corner.** A new item in an area's
  right-click menu takes whichever of its corners the click is closest to,
  however far into the area you clicked. *Start the pattern here* still places
  it at the click.

## 0.3.3 — 2026-10-16

### Pattern origin starts at the product's corner

- **The first baffle or plank starts at the origin, not on it.** A placed
  origin used to be the CENTRELINE of the first run, so a baffle started at
  an area's corner hung half its width past the wall. The run grid now moves
  half the profile or plank width into the area, so the first item's edge
  sits on the origin. Panels and cassettes already put a cell corner there.
- **Start the pattern here snaps.** Right-clicking within a few pixels of an
  area's corner lands exactly on that corner; near an edge, exactly on the
  edge. An origin on the boundary counts as inside its area.
- **Zoom goes to 1000%** (was 800%), for picking a corner on a 1/8" plan.

## 0.3.2 — 2026-10-16

### Report a bug

- **From Settings or the prompt.** Settings has *Report a bug* in its header
  and as the first row of About. In the prompt, *Report a bug…* asks what
  kind and then for one sentence, and Enter sends it without leaving the
  prompt; Shift+Enter, or *Report a bug with a picture…*, opens the form.
- **The form** is one small card over the drawing: five kinds (something
  broke, a quantity is wrong, something looks wrong, it is slow, something
  else), what happened in a sentence, optional details, and a picture —
  *Capture the drawing* in one click, or paste or drop a screenshot.
- **What goes with it is shown, not described**: the version and the
  machine as chips, and the exact "where you were" line (project · drawing ·
  sheet) with a tick to leave it out. Nothing else about the project is sent.
- **Nothing is lost.** A report that cannot be sent keeps every word in the
  card, says why, and offers to copy it instead. Closing the card keeps the
  draft for next time.
- Reports go to the update channel's Worker, which keeps each one in R2, and
  a workflow opens a GitHub issue for each, labelled *bug report*. The issue
  has what was typed and the build; the picture, the project and the name
  stay private. See `docs/UPDATES.md`.

### Release path

- The publish job laid the installers out with a one-argument `Join-Path`,
  which throws; no workflow publish had got past that step. Fixed.
- CI runs `npm run verify` on every pull request, and the Worker deploys
  from Actions when it changes.

## 0.3.0 — 2026-09-18

The control surface, the surfaces Aaron approved from boards, Windows'
materials, and the parts list as an estimator orders it. Everything visible
in this release was drawn first and built to the drawing; the boards are in
`docs/design/`.

### The parts list, and what each product orders

- **A part is a thing you buy.** One line per part with its size as a chip;
  the full/cut breakdown, ordered length and offcut are a detail line
  beneath it, never parts of their own. A run product's installed length is
  an *Installed* tile, not an order line. Rails, connectors, end caps, joiners
  and trim are an Accessories group. A custom assembly has no Parts section.
  Confidence is one chip on the header, not a note on every line.
- **The tiles show only what the scope measures.** No tile reads "—".
- **What each product orders**, in Aaron's words: panels — panels and trim;
  planks — planks, carrier rails and trim; baffles — baffles, suspension
  rails, connectors, joiners, end caps; cassettes — cassettes, baffles, end
  caps. Panels never had trim; baffles could never report a rail; planks
  listed connectors and joiners nobody buys. All three corrected.
- **Trim is cut per edge.** Every edge of every area — cutouts included —
  rounds up to whole sticks on its own. The whole-perimeter division is gone.
- **A rail is a laid run.** Perpendicular to the baffle at each connector
  line, cut from rail stock with its own offcut. The area-over-pitch-over-
  length estimate is gone; without a rail length there are no rails.
- **A plank's connector spacing** is its Conn. Max, else its rail spacing,
  else its stock length — several rails can cross one plank.
- **A cassette is a module**: Cassette W by the baffle length, laid whole by
  the panel engine, so partial coverage costs a whole module. Baffles are
  cassettes times the baffles each holds; two end caps per baffle; backer
  rails and their connections are inside the module.

### The dock

- Two floating surfaces instead of four: what you are doing (read tools,
  the scope, Take off or the tools and Done) and where you are (sheet, zoom,
  scale). Reassessed against Fluent's CommandBar.
- Four density tiers of drawing width. Labels on the tools at Spacious;
  every tier sheds into that surface's "…" — a command is never unreachable,
  and the dock never wraps.
- The tool in hand is a fill with its glyph in the accent, not a navigation
  pill. Done takes the slot Take off held. The scope pill names its state —
  no round, add a scope, choose a scope — and with no drawing the read tools
  and Take off are disabled in place. A pinned calibration dims the work
  surface.
- Picking a scope in the dock opens it in the sidebar.

### Windows' materials

- **Mica shows through** the title bar and both sidebars. The window was
  transparent and the panes painted nothing, and still the chrome was a warm
  grey: the vendored design system painted `html` underneath. Fixed.
- Every transient surface — menus, flyouts, the switcher, the search chooser,
  the prompt's flyouts, the dock, toasts — is acrylic: a tint, a 40px blur, a
  grain.
- Hover, selected, raised and divider fills are Fluent's alpha whites, so a
  selected row is the surface lifted, not a grey box on the wallpaper.
- The accent is the Windows accent, on every accent-coloured thing. It read
  as Windows' default blue on machines with another accent because the same
  vendored block shadowed the stamped value. Fixed, and re-read on focus.

### The surfaces built to approved boards

- **The estimates sidebar**, rebuilt: round list, a one-page scope with
  Parts first, Setup and Markups beneath, and the InfoBar that says what the
  number needs.
- **The start window**: a filterable list of recent projects with pin, inline
  rename, locate for a moved folder and a context menu; "Open a project
  folder" is the primary card. **A drawing opens for viewing without a
  project**: the first markup action asks for the drawing's project folder
  before it does anything.
- **The project switcher** is a flyout: the current project with rename,
  reveal and context window, a filterable recent list, Open another and
  Start page.
- **Search highlights ask which scope first.** A highlight is a markup and
  a markup belongs to a scope; with none chosen, Highlight opens the chooser
  instead of landing in whatever scope was last active. Hits are grouped by
  sheet, the open drawing first.
- **Settings** is one centred page of cards with an On/Off word, a Reset
  glyph and an About that says where the accent came from.
- **The prompt** reads as a Raycast: one field, grouped results, the action
  bar, and the no-scale warning names its sheet.
- **One icon dictionary**: Fluent's families, Regular at rest and Filled
  when current, across the rail, the dock and the sidebar.
- Contents and Thumbnails are greyed until a drawing is open; opening a
  drawing switches the rail to Contents.

### The control surface (2026-09-11 plan, all seven phases)

- The prompt does the thing, in the prompt, and asks rather than assumes.
- Lengths read as an estimator writes them: `7′ 2 7/8″`, not 7.239583.
- Layout drawing on the sheet; the PDF's own markups as objects; a trace of
  the region; the app icon; recent projects with settings.

### Bug review of 2026-09-10 (Kenneth's 24 items, five phases)

- Cutouts clip to the areas they open. Fit sheet, search hits across
  documents, the start screen on launch. Drawing and selection: a Select tool
  for marquee selection, and the tools stay off the keyboard's text fields.
  Setup and quantities, project and search, and the PDF's foreign markups.

### Tooling

- A DevTools driver that refuses to drive anything but REDBEAM. A shell
  harness that reaches every surface, including the highlight gate, without
  a real project. Dead stylesheet rules pruned by a script that reads the
  components.

## 0.2.1 — 2026-09-08

What the live test of the installed 0.2.0 build on the Barclays set found
(`docs/AUDIT-2026-09-04.md`, "Live test"), fixed.

- Opening a folder inside a project through the bridge created a second
  `redbeam.db` in it: the bridge's open now goes through the same project
  resolution as the picker.
- The palette's field refocuses on every step change (a configure chain had
  left it unfocused), and Escape cancels the palette outright.
- "This sheet has no scale" no longer shows while no sheet is open.
- Indexing progress is determinate: a ring behind the collapsed Search tab,
  the count and a foot bar on the expanded tab, and a bar with the numbers in
  the Search pane's footer. No spinner over the expanded tab.
- A round's scope rows and totals no longer read 0 after a reopen until a
  sheet is visited: the project's markups are loaded as soon as the store is
  open, and the counts come from the project rather than the open page.
- Switching or closing a project releases its database once the last window
  on it has let go (`db_close`), so its files can be moved or removed while
  the app is still running.

## 0.2.0 — 2026-09-04

The shell brought to WinUI 3, a command palette that can drive the whole
application, and two bug lists fixed the same day. Design register:
`docs/FLUENT-GAPS.md`; functionality audit: `docs/AUDIT-2026-09-04.md`.

### Shell and materials

- WinUI 3 system fills for every warning, note and toast (Caution, Critical,
  Success, Attention), in-app acrylic flyouts with the surface stroke, the
  3×16 selection pill on every selected row and tab, the black-and-white
  focus pair, Compact row heights (24 / 36), 28px menu items at Body 14, the
  40×20 toggle switch, and the Windows accent on the primary actions.
- Fluent UI System Icons throughout, chosen per role size; Lucide removed.
- Sentence-case headers everywhere a mono-caps kicker used to be.
- Thumbnails in three columns at the pane's width.
- Below the 960px window minimum the layout degrades instead of collapsing:
  the fallback grid has the right number of tracks, the wrapped command bar
  no longer slides under the sidebar, and a sheet row never rides its badge
  over the sheet number.

### The estimates pane

- The scope pane rebuilt: the scope band, two headline measures with one
  status line (nothing measured, needs setup, blocked, uncommitted, committed
  and what changed since), then Parts / Setup / Markups as a selector bar,
  with Duplicate and Remove in the foot.
- There is no separate bill of materials at the estimate root. A scope's
  parts and quantities are its Parts page; the round's exports (report, bill
  as TSV, marked-up PDF) live in the round's header menu beside Rename,
  Duplicate and Delete. The round's scope list shows one total per scope.
- Estimate export: a branded PDF with per-scope quantities and sheet
  pictures, CSV or TSV, through a native Save As dialog, from an edit sheet
  that shows what will be written.

### Settings

- A full-screen NavigationView: a pane with back, title, "Find a setting",
  one item per category with its count, About as the footer item; a content
  layer with the breadcrumb title, Reset all only while something is
  changed, rejected values as a dismissable InfoBar, families as expanders,
  rows as 68px settings cards with the On/Off word beside the switch, and an
  About page with version, update, diagnostics and third-party notices.

### The command palette

- Prefixes: `>` commands, `#` sheets, `:` page number, `@` scopes and what
  can be done to one, `/` documents, `=` settings, `~` projects, `?` lists
  them. Recents lead an untyped palette; every group says its prefix.
- Argument steps in the same field: what has been chosen sits as chips,
  Backspace on an empty field goes back, Tab advances without running, a
  text step states its rule and says when it is met.
- Toggles flip and stay (Ctrl+Enter closes). Shift+Enter opens a document in
  a context window. A row that cannot run stays listed and says why.
- Refusals keep the palette open with the store's reason and the nearest
  thing that works. Nothing destructive confirms with a dialog: deleting a
  round is refused while it holds markups (Duplicate is offered instead);
  removing a scope archives it and says its markups come back on restore.
- A miss says so in quotes and offers full-text search across every sheet.
- Every verb: zoom presets, next and previous sheet, close tab, every pane,
  close project, undo and redo with their labels; calibrate, set scale for
  this sheet, every sheet or a series of sheets; draw or remove a scale
  region; new, rename, duplicate and delete round; save report, copy bill,
  marked-up PDF; add, configure, rename, product, counts, duplicate, archive
  and restore scope, with the scope picked when none is open; take off in a
  scope, leave takeoff, every tool, direction; commit one scope or all; move
  or delete the selected markup; every setting as a switch; reset all.
- Aliases on every command and tool ("hand" finds Pan, "hole" finds Cutout);
  a whole-word alias hit ranks above a fuzzy title hit.

### Fixed

- Opening a drawing as a project and then its parent no longer breaks both
  windows: the core keeps one SQLite connection per project, undo is per
  project, and a folder inside a project resolves to the outermost
  `redbeam.db`. Nested `.redbeam` folders are skipped at any depth.
- A project opens on the Files pane rather than the first document; a
  remembered sheet still reopens.
- The wheel scrolls the sheet; Space or the middle button pans; pinch zooms
  either way. The setting says so.
- The Files pane is a nested, foldable folder tree.
- Page text is indexed for the whole project as soon as the folder is read;
  the Search tab wears a ring and says how far it has got.
- Calibrate, direction and scale region refuse a third point.
- The Estimates breadcrumb reaches the list; the dock's scope popover lets a
  round unfold in place and shows product and markup count per scope.
- Project paths, tree rows, menus, tabs and estimate rows truncate with an
  ellipsis instead of wrapping.
- The thumbnail grid's rules matched nothing after the sidebar merge; the
  drawing no longer shows through Settings; unit selects are readable.

### Removed

- `BomView` and the estimate-root bill; `fileFilter` folder grouping,
  superseded by the tree; `lucide-react`.

## 0.1.0 — 2026-09-04

First Windows release: the Fluent shell with Mica behind chrome that paints
nothing, the system accent, one sidebar with a compact collapsed form, one
acrylic command bar that sheds controls as the window narrows, and a takeoff
that blocks a quantity rather than approximating it on an uncalibrated sheet.
