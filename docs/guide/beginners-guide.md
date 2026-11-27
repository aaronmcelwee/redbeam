# REDBEAM beginner's guide

REDBEAM is Maxxit's takeoff tool. It is a PDF viewer, like Bluebeam, that measures ceilings and walls and counts the product in them: panels, planks, baffles, trim and hardware. Everything you do is saved inside the PDF itself, so there is no project to set up and nothing else to keep track of.

You can do a takeoff by hand, or ask ChatGPT (or Claude) to do it for you inside REDBEAM while you watch and approve. This guide covers both. It was written for REDBEAM 0.3.93 (November 2026).

---

## 1. Getting REDBEAM

### Option A: the installer (most people)

1. Go to the [latest release](https://github.com/aaronmcelwee/redbeam/releases/latest) and download **REDBEAM_x.x.x_x64-setup.exe** (use the **arm64** file only on a Snapdragon / ARM laptop).
2. Run it. REDBEAM is not code-signed, so Windows shows a blue "Windows protected your PC" box. Click **More info**, then **Run anyway**. You only see this once.
3. The installer adds REDBEAM to the Start menu and to **Open with** for PDFs. To make it your default PDF viewer, use **Make default…** on the start screen or **Settings › About › Default PDF viewer**. Bluebeam stays the default until you choose otherwise.

### Option B: the portable zip (if the installer is blocked or fails)

Some PCs refuse the installer (for example "Windows cannot access the specified device, path, or file"). The portable copy needs no install and no admin rights.

1. Download the [latest portable zip](https://redbeam-updates.trackchairking.workers.dev/files/REDBEAM_latest_x64_portable.zip).
2. **Before you unzip it**, right-click the zip, choose **Properties**, tick **Unblock** at the bottom, and click OK. (Skipping this can make Windows block the app inside.)
3. Unzip it into Documents or onto your Desktop (not into Downloads or a temp folder), and double-click **REDBEAM.exe**. If SmartScreen appears, click **More info › Run anyway**.

The portable copy does everything the installed one does, except it is not in the Start menu or in Open with. If your PC is missing Microsoft Edge WebView2, REDBEAM says so and offers Microsoft's download page.

When REDBEAM opens you see the start screen: **Open a PDF**, your recent files, and the version at the bottom.

![The start screen](images/10-start-screen.png)

### Updates

REDBEAM checks for new versions by itself. From 0.3.94, a blue chip appears next to **Settings** at the bottom of the sheet list (on the start screen, next to the version number). It reads **Ready to update**, then **Updating N%**, then **Restart to update**: click it to finish. (Older versions show an update bar with **Download and install**, then **Restart now**.) The portable copy downloads the new zip instead.

You can also check any time in **Settings › About › Check for updates**. After an update, **What's new** lists what changed; you can reopen it from Settings › About.

![Settings › About: Report a bug, What's new and Check for updates](images/11-settings-about-updates.png)


---

## 2. Doing a takeoff by hand

### The screen

- **Left:** the sheet list (**Contents**), with Thumbnails and Search tabs at the top.
- **Middle:** the drawing, with the toolbar along the bottom.
- **Right:** the **Takeoff** panel: your scopes, their quantities and their markups.
- **Top:** one tab per open PDF, like Bluebeam.

![A PDF open: sheet list on the left, toolbar at the bottom, Takeoff panel on the right](images/12-the-screen.png)

### Open a PDF

- Use **Open a PDF** on the start screen, **Ctrl+O**, drag a PDF onto the window, or right-click a PDF in File Explorer and choose **Open with › REDBEAM**.
- Each PDF opens in its own tab. **Ctrl+Tab** switches tabs, **Ctrl+W** closes one, **Ctrl+Shift+T** reopens the last one you closed.
- Big sets are fine. There is no size limit: 1,000+ sheet, multi-GB sets open in seconds.

### Get around the set

- Click a sheet in the Contents list, or type in **Find a sheet**. **Left / Right arrow** (or PgUp / PgDn) steps through sheets.
- Scroll to zoom and drag to pan (the **Pan** tool, **H**). **Z** zooms to a box you drag.
- Links on the drawings (detail bubbles, sheet numbers) work: click to jump, **Alt+Left** to come back.
- If the PDF has bookmarks, switch the list from **Sheets** to **Bookmarks**.
- **Ctrl+K** opens the command palette, which can find any command, sheet or scope by typing.

![The Thumbnails tab: click a page to go to it](images/13-thumbnails.png)

![The command palette (Ctrl+K): every command, sheet and scope by typing](images/14-command-palette.png)

### Fix the sheet names (if needed)

If the sheet list shows "Page 14" or the same contract number on every sheet, click **Read from title block…** under the list. Drag a box around the **drawing number** on one sheet, then around the **drawing title**. REDBEAM reads the same two spots on every sheet and names them all. The names are saved in the PDF, and Bluebeam shows them as bookmarks too.

![Step 1: drag a box around the drawing number](images/15-title-block-step1.png)

![Sheets named from the title block](images/02-sheets-named.png)

### Set the scale (do this first on every sheet you measure)

Markups on a sheet with no scale count nothing, and the sheet list shows **no scale** beside it.

- Click the scale button at the right end of the toolbar (it says **Unset** until a scale is set). Pick a common scale (1/8" = 1'-0", 1/4" = 1'-0", 1:50, 1:100) or open the full list.
- If you don't trust the printed scale, choose **Calibrate from the drawing** (or press **K**) and click two ends of a dimension you know.
- For many sheets at once, choose **Set scale for a range of sheets…**, or Ctrl+click several sheets in the list, right-click, and set one scale for all of them.

![The scale picker: architectural, engineering and metric scales, then Apply](images/16-scale-picker.png)

Until a sheet has a scale, the Takeoff panel warns you, with a **Set scale** button right there:

![The warning on a sheet with no scale](images/28-no-scale-warning.png)

### Scopes: one per product you are pricing

A **scope** is one product, such as "CL03 Acoustic ceiling panels" or "CL02 Wood baffles". It has its own colour, its own product details and its own quantities. Whatever you draw goes into the scope that is active.

1. In the Takeoff panel, click **Add scope** and name it after its tag on the drawings.
2. Open **Setup** and pick the **Product** (panels, planks, baffles, cassettes, linear parts and so on). Fill in its sizes. The count comes from them.
3. Click **Take off**, then draw.

![A new scope: pick the Product in Setup and fill in the sizes it asks for](images/17-new-scope-setup.png)

![An area drawn for the scope; it shows on the sheet and under Markups](images/18-area-drawn.png)

The **Summary** card at the top shows area, perimeter or length, and the part counts. **Copy** puts it on the clipboard as a two-column table, ready to paste into Excel.

![A finished scope: Summary with area, perimeter and part counts, Saved automatically, and its markups](images/07-custom-pattern.png)

### Drawing tools

When **Take off** is on, the toolbar shows the scope you are drawing into and its tools. Hover any button to see its name and key.

![The toolbar in Take off: Pan, Select, Zoom, Text, the active scope, then the drawing tools (Area, Cutout, Linear, Count, Highlight)](images/19-toolbar.png)

| Tool | Key | How to use it |
|---|---|---|
| **Area** | A | Click the corners, or drag a rectangle. Enter finishes. |
| **Cutout** | X | Draw inside an area to take out a hole (a bulkhead, an atrium, a column). |
| **Linear** | L | Click along a run (trim, a wall, a light cove). Enter finishes. |
| **Arc / Circle** | A / Shift+C | While drawing an Area, Cutout or Linear: A for a curved piece, Shift+C for a circle. See *Arcs and circles* below. |
| **Count** | C | One click per item (lights, diffusers, sprinklers). |
| **Select** | V | Click a markup, or drag a box around several. Delete removes them; Ctrl+D duplicates. |
| **Dimension** | D | Measure one length off the sheet without adding to a scope. |
| **Text** | T | Drag a box around text, then Ctrl+C to copy it (great for RFIs). |
| **Direction / Origin** | O for Origin | Set which way panels or baffles run, and where the pattern starts. |

Points snap to the drawing's lines; hold **Alt** to place a point exactly where the cursor is. **Esc** cancels, **Ctrl+Z** undoes. Right-click a markup for more (Copy markup, Start the pattern here, and so on).

### Arcs and circles

Curved walls, round bulkheads and circular openings are drawn with the same Area, Cutout and Linear tools. When one of them is on, a small bar at the top of the drawing shows **Line**, **Arc** and **Circle**, and tells you what to click next.

**An arc inside an area or a run**

1. Start the Area (or Cutout, or Linear) as usual: click the straight corners up to where the curve begins.
2. Press **A** (or click **Arc** on the bar).
3. Click any point the curve passes through, ideally near its middle.
4. Click where the curve ends. You are back to straight lines, so keep clicking corners, or press **A** again for the next arc.
5. Press **Enter** to finish. If the arc is the last piece of an area, press Enter after step 3 and REDBEAM closes the area along the curve back to your first point.

![Drawing an area with a curved side: straight corners, A, a point on the curve, then its end](images/30-arc.gif)

**A circle**

1. Pick Area or Cutout (or Linear for a circle's perimeter).
2. Press **Shift+C** (or click **Circle** on the bar). Do this before your first click.
3. Click the centre, then any point on the edge. The circle is done; click again for another one the same way.
4. Click **Line** on the bar to go back to straight lines.

![A round opening cut out of an area: Cutout, Shift+C, the centre, then the edge](images/31-circle-cutout.gif)

The area and length follow the true curve, not a rough polygon. **Backspace** takes back the last arc point (or the last corner), and Ctrl+Z undoes a finished shape as usual.

### Links between sheets

Clicking a detail bubble, section mark or sheet number that the architect linked takes you to that sheet, and **Alt+Left** brings you back. When a set has no links (or broken ones), you can add them:

- **One link:** pick **Link** on the toolbar, drag a box over the callout and choose the sheet. The sheet named inside the box is listed first.
- **Every detail callout at once:** with Link on, click **Link all detail callouts…**. REDBEAM reads every sheet and lists each reference to another sheet. Click a row to see it on the drawing, untick any you don't want, then **Add links**. Sheet names must be set first (see *Fix the sheet names*).

The links are saved into the PDF, so they work in Bluebeam and any other viewer too.

![The Link tool: a box over a detail bubble and the sheet list](images/32-link-picker.png)

![Link detail callouts: every reference found, grouped by sheet, ready to add](images/33-link-callouts.png)

### Saving: the PDF is the record

- REDBEAM **saves your takeoff into the PDF automatically** a few seconds after each change. The Takeoff panel says **Saved automatically**. There is no Save button to remember.
- The same PDF opens in Bluebeam with your areas and lengths as normal Bluebeam markups, and Bluebeam edits come back into REDBEAM. Merging, inserting or reordering pages in Bluebeam takes the takeoff along with each sheet.
- Areas and lengths someone already drew in Bluebeam come in **dashed and pending**. They count toward nothing until you accept them: give one a scope, or use **Accept imported markups…** in Ctrl+K.
- If REDBEAM can't write into the PDF (it is open in Bluebeam, still syncing, or someone else saved first), it never throws your work away. It offers **Save a copy…** instead.
- **Client tender file?** Use **Save a copy with the takeoff…** (Ctrl+K) and work on the copy, so the original stays as it came.

### Reuse a takeoff

- **Copy / paste markups between PDFs:** select markups, Ctrl+C, switch to the other PDF's tab, Ctrl+V. They land in the same spot at real size, in the scope with the same name (created if it is missing).
- **Next bidding round:** open the new set and use **Start from another PDF's takeoff…** (Ctrl+K). Scopes come over, and markups land on matching sheets. Anything that could not be placed is counted so you know what to redraw.
- **Scopes only:** **Import scopes from another PDF…** brings the scopes and their product setup without the markups.

### Export the estimate

Click **Export…** at the top of the Takeoff panel. Fill in the cover (project, estimate, subtitle), untick any scope you want to leave out, and click **Save PDF**. The estimate PDF has a cover with a key plan, a quantities page, and a picture of every takeoff area drawn from the sheet itself. The **⋯** menu next to Save PDF also has **Save CSV…** and **Copy TSV** for spreadsheets.

![The Export panel: cover details, the scopes to include, and Save PDF](images/20-export-panel.png)

![Estimate PDF: the cover with a key plan and the totals](images/04-estimate-pdf-cover.png)

![Estimate PDF: quantities by scope](images/22-estimate-pdf-quantities.png)

![Estimate PDF: a snapshot of every area, drawn from the sheet](images/21-estimate-pdf-snapshots.png)

---

## 3. Working with ChatGPT (and Claude)

REDBEAM can be driven by an AI agent. The agent opens the PDF in REDBEAM, reads the drawings, proposes the scopes, and once you approve them, draws the takeoff, all in the same REDBEAM window you are looking at.

### What you need

- The **ChatGPT desktop app** for Windows, signed in. **ChatGPT in a web browser cannot reach REDBEAM**, because REDBEAM runs on your own PC.
- REDBEAM installed (or the portable copy).

### One-time setup

1. In REDBEAM, open **Settings** (bottom-left) and go to **Claude and ChatGPT**.
2. Turn on **Let AI apps use REDBEAM**.
3. Click **Add to ChatGPT**. REDBEAM adds itself to the ChatGPT desktop app's MCP servers (shared with Codex). Nothing else needs installing.
4. Quit ChatGPT completely and reopen it. REDBEAM should now be listed among its tools.

![Settings › Claude and ChatGPT: the switch, and Add to ChatGPT](images/23-settings-claude-chatgpt.png)

You can turn the switch off any time; nothing can connect while it is off. If REDBEAM is closed when ChatGPT asks for it, it opens by itself.

### Asking for a takeoff

Start a new ChatGPT chat for each job and tell it plainly what you want. Give it the full path of the PDF (in File Explorer, Shift+right-click the PDF and choose **Copy as path**). For example:

> Use REDBEAM to do a takeoff of the Level 3 reflected ceiling plans in "C:\Users\me\OneDrive\Jobs\Scottsdale\CD set.pdf". Save a working copy first so the client file stays clean. Scopes I'm pricing: CL03 acoustic ceiling panels and CL02 wood baffles, plus perimeter trim. Show me the scopes for approval before drawing anything.

Other things you can ask:

- "Name the sheets in this set from the title blocks."
- "Find every sheet that mentions WP-12 and tell me where it is used."
- "Check the scale on A6.01 against a written dimension."
- "Export the estimate PDF to the job folder."

### How the agent works

REDBEAM hands every agent Maxxit's **precon-takeoff** procedure automatically when it connects, so ChatGPT follows the same steps every time:

1. **Define the scopes first.** It reads the specs and details, then lists each scope (product, sizes, finish, where it applies) and **stops and waits for your approval**.
2. **Build the takeoff.** After you approve, it sets scales, draws areas, runs and counts, and checks its outlines.
3. **Hand back** the quantities, call-outs and assumptions, and marks its session finished.

Reply in the ChatGPT chat to approve, correct a scope, or ask it to redo something.

### Watching it work in REDBEAM

- Each ChatGPT chat gets its **own session**, named for the app and the job (for example "ChatGPT · Nokia Canada North Campus takeoff"), with its own colour and its own group of tabs.
- The **Agents** list sits under Takeoff in the right panel. It shows each session, what it is doing now, and its PDFs. Pick a PDF to look in on it as one of your tabs.
- When you look at a PDF an agent is working in, its **bright cursor** shows where it is acting, labelled with what it is doing.
- An agent **never steals your keyboard, window or view**. You can keep working, even in the same PDF. Each agent has its own view of the set: it turns its own sheets and zooms on its own, and draws on any sheet, while what is on your screen stays exactly where you left it. It never asks permission to work in a sheet.
- **Ctrl+Z only undoes your own work**, never the agent's, and the agent can only undo its own.
- When it finishes, the PDFs it changed move to your own tabs with a dot until you open them. You can also **End this session** from the Agents list.

![An agent drawing an area: its cursor says what it is doing, and its card in the Agents list says the same](images/24-agent-drawing.png)

![Two agents in one window: each has its own colour and tab group, and you keep working in your own tab](images/05-agent-cursor-in-your-pdf.png)


![A finished session: its PDFs move to your tabs, and Finished keeps what it did](images/26-agent-finished.png)

### Reviewing the agent's work

Treat it like a junior estimator's takeoff. Before you price it:

- Click through each scope in the Takeoff panel and look at the markups on the sheets. **Hide the PDF's own markups** (Ctrl+K) helps you see the drawing underneath; a bar at the top says markups are hidden, with **Show markups** to bring them back.
- Check that every sheet used has a scale (no **no scale** tags) and that the agent stated the scale it used.
- Read the assumptions it handed back in the chat, and ask it to fix anything that is off.
- Export and check the estimate PDF pictures; they make missed or doubled areas obvious.

![Markups hidden to check the drawing underneath; Show markups brings them back](images/29-hide-markups.png)

### Custom patterns (beta)

For products REDBEAM does not have built in (triangle panels, a repeating "random" baffle module, panels on rails, open cell with coffers), turn on **Settings › Beta › Custom patterns** and ask the agent to build it as a pattern. It lays it out on the sheet and saves it on the scope as a **Draft**. Draft counts show as unverified in the estimate until you approve it in the scope's **Setup**: **Approve, add to library** to reuse it on other jobs, or **Use here only**.

![Settings › Beta › Custom patterns turned on: an agent's pattern laid out on the sheet](images/27-custom-pattern-sheet.png)

![A draft pattern from an AI app: counts are unverified until you approve it in Setup](images/03-scope-summary-and-setup.png)

### Using Claude instead

Claude works the same way. Install the **Claude desktop app**, then in REDBEAM's **Settings › Claude and ChatGPT** click **Add to Claude** (this also adds it to Claude Code if you use it). Quit Claude from the system tray and reopen it. Everything above about sessions, approval and review applies to Claude too.

---

## 4. Tips

- **Set the scale before you draw.** It is the most common reason a quantity reads zero.
- **One scope per tag on the drawings.** Name scopes after the spec tag (CL03, WP-12) so copy/paste and next-round imports match them up.
- **Ctrl+K is the fastest way to anything.** Type a few letters of a command, a sheet number or a scope.
- **Print** with Ctrl+P (this sheet), or "Print sheets…" in Ctrl+K for a range like `1-5, 8`. What prints includes your takeoff.
- **Rotate a sideways sheet** from the zoom menu or Ctrl+K; the takeoff turns with it and the turn is saved in the PDF.
- **Theme:** Settings › General › Theme (Match Windows, Light or Dark).

## 5. Troubleshooting

| Problem | What to do |
|---|---|
| "Windows protected your PC" | Click **More info**, then **Run anyway**. REDBEAM is not code-signed. |
| The installer fails or is blocked | Use the portable zip. Unblock the zip in Properties before unzipping. |
| REDBEAM won't open: WebView2 missing | Install Microsoft Edge WebView2 from the page REDBEAM offers. |
| An area shows 0 or "sheet has no scale" | Set the scale on that sheet (toolbar scale button, or K to calibrate). |
| "Save a copy" keeps appearing | The PDF is open in Bluebeam, still syncing in OneDrive, or someone else saved it. Close it elsewhere, or save a copy. |
| Bluebeam markups are dashed | They are pending imports. Give them a scope or use **Accept imported markups…**. |
| A warning says the takeoff was rebuilt from the markups | Another app dropped REDBEAM's hidden data. Quantities are back; re-enter product details and any missing scales. |
| ChatGPT can't see REDBEAM | Use the desktop app, not the web. Check the **Let AI apps use REDBEAM** switch is on, click **Add to ChatGPT** again, then fully quit and reopen ChatGPT. |
| The agent is stuck "waiting for you" | Answer it in its chat. |
| Something else is wrong | **Settings › Report a bug** (it can include a screenshot). Reports go straight to the team. |
