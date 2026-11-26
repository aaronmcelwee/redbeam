---
name: "precon-takeoff"
description: "Use after precon intake is approved: define each scope from the drawings for Aaron's sign-off, then do the RedBeam takeoff with layouts, quantities, detail and finish call-outs."
---

# Precon takeoff

Step 2 of the Maxxit estimating codex. It starts from a scope brief that Aaron approved in `precon-intake`. It has two gates:

- **A. Scope definition.** Read and measure, write nothing to the takeoff, and wait for Aaron's approval.
- **B. Takeoff.** Build scopes, layouts and quantities in RedBeam, then hand back for review.

**Done means:** a saved RedBeam takeoff in a working copy, the bill of materials and piece lists for each scope, call-outs for details and finish schedules, a record of every assumption, and a list of RedBeam gaps.

## Hard rules

- **Always work on a copy** unless Aaron says to work in the open file — his instruction wins. Never write takeoff into a file another estimator has worked on. When he says to work in his open file, work in it directly: your session has its own view there, so nothing on his screen moves and REDBEAM never asks him to allow it.
  - Make a working copy, e.g. `<Project>\1 Data\MAXXiT\Blind Takeoff - Claude\<set> - BLIND TAKEOFF.pdf`.
  - On a blind run, strip or hide the embedded markups in that copy first.
  - The PDF is the only record. There is no sidecar file.
- **Spacing is always on-centre** for baffles, planks, slats and any other repeating member. Measure member centre to member centre. Never report a gap plus product thickness.
- **Read spacing off the RCP's own linework**, from member centre to member centre. Check `redbeam_detect_pattern` output by hand whenever members are drawn as rectangles: it can report face width instead of on-centre spacing.
- **Yield granularity:**
  - You may move a scope from full to half on your own when it lowers stock. Revert to full where half makes no difference.
  - Quarter needs Aaron's decision. Explain the stock it saves and why, then wait.
- **Never invent product data.** If a required input such as maximum hanger spacing is not in the documents or Maxxit data, use a clearly labelled assumption and list it for Aaron.
- **If RedBeam can't do something, stop and report it.** Aaron upgrades the app.

## A. Scope definition (stop for approval)

1. Start with `redbeam_start_session {task}` (a short name for the job) and pass its `session` on every call. Open the working copy with `redbeam_open_file`. **Fix sheet names first:** run `redbeam_list_sheets`; if numbers come from bookmarks/tags (MF01, SF72) or are null, find the title-block number and title boxes with `get_words`, set them with `redbeam_set_title_blocks`, then patch outliers and the discipline prefix (e.g. "A") with `redbeam_rename_sheets`. Save. Then go to each plan sheet with `redbeam_go_to_page {sheet}`.
2. **Scale:** run `redbeam_read_scale` to see the stated scale. Check it against a written dimension (`dimension` + `points`). Set it with `redbeam_set_page_scale {presetId}`. This setting is not undoable.
3. **For each scope area:**
   - Find its outline with `redbeam_trace_area`. **If the field is a hatched/patterned fill (trace fails on content):** do not hand-click outlines from screenshots and do not hull the vector hatch — hatch dashes break at every grid line, column and panel joint and the hull splits there. Read the boundary visually instead: render the field with `redbeam_screenshot` (region, overlay off) in ~2400 px tiles, build an edge-density + member-direction map, threshold, close to bridge columns/panel gaps, open to drop single strokes, keep large components, map contours back to page coordinates, create one area per field. Overlay each result on the sheet and show Aaron before quantities.
   - **Grid lines, column lines and dimension lines are never boundaries.** A field only stops where its fill stops or at a drawn bulkhead/wall.
   - **Overlapping sheets (sector plans):** never guess a match line. Register the two sheets on two shared grid intersections, map one field onto the other and subtract the overlap; state the sf removed.
   - **Look for a typical module or pattern detail before assuming even spacing.** Search with `redbeam_find_text` for the mark's detail references and words such as TYP, MODULE, PATTERN and LAYOUT, and read the enlarged plans. If the product repeats as a module (members of different lengths, offsets or a random-looking layout that tiles), record the module, its size and its member list, and count from that. A single on-centre figure is only right when the drawing shows uniform spacing. Where REDBEAM has no product that lays the module out, build it as a custom pattern (`redbeam_preview_pattern`, then `redbeam_save_pattern`) when Aaron has Custom patterns turned on under Settings, Beta; if it is off, say so and count the module by hand.
   - Read the pattern with `redbeam_detect_pattern`, then confirm it with `get_lines`. Record:
     - direction;
     - on-centre spacing;
     - member length;
     - number of runs and rows;
     - the reveals or gaps between runs;
     - where the designer's first member sits.
   - Note the fixtures within the field. A pendant that hangs below the ceiling is not a cutout. Cut out only where the drawing leaves the field empty.
   - Note any edge where the drawn members stop short of the outline (e.g. clear zones at walls or a TV wall).
4. **Detail call-outs:** search with `redbeam_find_text` for each detail referenced from the plans and schedules. Record:
   - the detail number and sheet;
   - what it governs: suspension, wall trim, terminations, fixture integration;
   - anything that adds parts.
4b. **Prefab panel / cassette systems** (panels with a module size, gap between modules, removable share): RedBeam's baffle_cassette has no module gap or removable %. Record them in the definition and count outside RedBeam (removable panels, safety cables, alignment pins). Flag BOM lines that don't apply (e.g. end caps and perimeter trim when slats screw to omega bars) and report panel count as a range: area ÷ module (with gap) to RedBeam's whole-panel count.
5. **Finish schedule call-outs:** give each mark's finish and code as revised by the addenda. Flag finishes that are not Maxxit standard and alternates that need an equivalent.
6. **Present a scope definition table for each scope:**
   - mark and product;
   - which areas;
   - area in sf;
   - direction and on-centre spacing;
   - stock length;
   - required product inputs, from `redbeam_describe_product`;
   - the proposed origin;
   - how you will split the areas (one area per separate run where there are reveals between runs, which affects end caps);
   - the detail and finish call-outs;
   - your assumptions and questions.
6b. **Self-check before asking:** compare each field's area against the panels dimensioned on the enlarged plans (if any), and attach an overlay image of every outline on its sheet so Aaron can see the boundaries, not just the numbers.
7. **Stop.** Ask Aaron to approve or correct the definition. Call `redbeam_wait_for_person {for: "approve the scope definition"}` so REDBEAM shows that you are waiting for him.

## B. Takeoff (after approval)

1. **Create each scope** with `redbeam_create_scope {productType, specifications}`. Fill every required key from `redbeam_describe_product`, with its unit keys (e.g. `spacing`, `spacingUnit`, `stockLength`, `maxConnectorSpacing`). Labels must be unique and use plain hyphens.
2. **Draw the areas** in one call with `redbeam_create_markups`. Give each markup its `page`: it is written to that sheet in the background, so do not turn Aaron's pages to draw. Draw:
   - one area for each separate run or field;
   - areas sized so runs fit whole stock lengths where the drawing intends that (e.g. exactly 8'-0");
   - a cutout only where the drawing shows a real void.
3. **Set the direction** for each scope with `redbeam_set_pattern_direction`.
4. **Set the origin** with `redbeam_set_pattern_origin` to match the designer's first member: edge, corner or centre for symmetrical shapes.
5. **Check the result:**
   - Run `redbeam_get_bom`. No line may be blocked.
   - Run `redbeam_get_piece_list` for each scope.
   - Compare runs and rows against the drawn counts, and explain every difference (e.g. a layout that reaches a wall the design stops short of).
6. **Yield pass:**
   - Try half on each scope that has cut pieces, and keep it only where stock drops.
   - Work out what quarter would save without applying it. If it helps, ask Aaron.
7. **Save:** run `redbeam_save`.
   - If it refuses because another app wrote to the file, run `redbeam_save_copy`, reopen the copy, and confirm the scopes still carry their product type, specifications, directions and origins. Re-enter anything that was lost.
   - Tell Aaron which sheets carry the takeoff. His screen is his: you cannot turn his page or switch on his layout preview. He can click your session in the Agents list to go to your sheet.

## Hand back

- **Quantities table, per scope:** area, on-centre spacing, stock, yield, installed LF, stock pieces (full or half), cut list, hangers, end caps, joiners.
- **Detail and finish call-outs:** the detail and finish references found in Part A.
- **Assumptions to confirm:** e.g. hanger spacing, edge clearances, stock lengths that differ from the schedule.
- **Where the layout differs from the drawing, and why.**
- **RedBeam gaps and bugs** hit during the run. For a hard set, offer to package the relevant sheets, a README of what went wrong and why, overlay images and any scripts for the REDBEAM developer chat.
- **File:** the path of the saved working copy.
- **Finish the session:** call `redbeam_end_session {summary}` with one line on what was saved, so REDBEAM hands the PDF back to Aaron.
