---
name: "precon-takeoff"
description: "Use after precon intake is approved: define each scope from the drawings for Aaron's sign-off, then do the RedBeam takeoff with layouts, quantities, detail and finish call-outs."
master: "2026-11-27 sha256:efd857516922"
---

# Precon takeoff

Step 2 of the Maxxit estimating codex. It starts from a scope brief that Aaron approved in `precon-intake`. It has two gates:

- **A. Scope definition.** Read and measure, write nothing to the takeoff, and wait for Aaron's approval.
- **B. Takeoff.** Build scopes, layouts and quantities in RedBeam, then hand back for review.

**Done means:** a saved RedBeam takeoff in a working copy, the bill of materials and piece lists for each scope, call-outs for details and finish schedules, a record of every assumption, the sign-off checks in Part C, and a list of RedBeam gaps.

## Hard rules

- **Always work on a copy** unless Aaron says to work in the open file — his instruction wins. Never write takeoff into a file another estimator has worked on. When he says to work in his open file, work in it directly: your session has its own view there, so nothing on his screen moves and REDBEAM never asks him to allow it.
  - Make a working copy, e.g. `<Project>\1 Data\MAXXiT\Blind Takeoff - Claude\<set> - BLIND TAKEOFF.pdf`.
  - On a blind run, strip or hide the embedded markups in that copy first.
  - The PDF is the only record. There is no sidecar file.
- **Spacing is always on-centre** for baffles, planks, slats and any other repeating member. Measure member centre to member centre. Never report a gap plus product thickness.
- **Spacing source precedence.** Take on-centre spacing from the most specific drawing that shows it, in this order:
  1. a dimensioned ceiling section, detail or elevation through the field;
  2. an enlarged RCP or a written note on the plan;
  3. the RCP's own linework.
  A higher source governs even when the RCP linework measures differently. Record the difference as an assumption, and make the source a question when none of 1 or 2 exists.
- **RCPs can't be trusted alone: spacing needs a second, non-RCP confirmation.** Every repeating-member scope needs two sources that agree: the RCP linework plus at least one of a dimensioned section or detail through that mark (read at its own scale), or a ceiling assembly or finish schedule entry that states the spacing. Search for them with `redbeam_find_text` ("O.C", "CENTRE", "SPACING", the mark, "BAFFLE", "DETAILS - CEILINGS"). Ignore "200mm"-style hits that are only scale-bar labels. In the scope definition table, give each source with its sheet and detail number (e.g. "200 OC: detail 1/32403 at 1:5, ceiling assembly C6 on A-10340, RCP linework 5.67 pt at 1:100"). Where only the RCP gives spacing, mark it UNCONFIRMED, list it as a question for Aaron, and don't present it as settled. Where the sources disagree, the section or detail wins, and you report the difference. Written bay dimensions on lighting or power plans also count as a second written source for spacing: cite them, but report them as RCP-family (the same plan drawn for another trade), never as a section or detail.
- **Every section and detail carries its own scale.** Before measuring spacing or member size on one, read the scale printed under its title (`redbeam_read_scale` lists each stated scale with its box), draw a scale region over that detail with `redbeam_begin_scale_region` + `redbeam_set_region_scale {presetId}`, and check it against a written dimension in the detail. Never measure a detail at the sheet's scale. A written dimension beats any measurement.
- **Read spacing off the RCP's linework only when no section or note gives it**, from member centre to member centre. `redbeam_detect_pattern` counts a member drawn as two faces once, at its centre, and tells members drawn differently apart (`memberTypes`, `sequence`, `repeat`: e.g. a beam every 4th member, slabs between). Check its spacing against `get_lines` before you rely on it.
- **Measure every area, not every mark.** The same tag can change spacing, member mix or direction from room to room. Read OC and member rhythm in each room separately and make one scope per distinct spacing.
- **Count every member type.** Perimeter frames, intermediate beams and in-fill slabs/fins are separate line items even under one tag. Match each drawn member's hatch to the legend before deciding it is "just another baffle".
- **Layouts sit on the architect's grid.** For panels, tiles and boxes, the area edge is the drawn field edge and the origin is a drawn grid intersection, never the area's corner by default. Derive the module from the drawn grid, not from an assumed size.
- **Yield granularity:**
  - You may move a scope from full to half on your own when it lowers stock. Revert to full where half makes no difference.
  - Quarter needs Aaron's decision. Explain the stock it saves and why, then wait.
- **Never invent product data.** If a required input such as maximum hanger spacing is not in the documents or Maxxit data, use a clearly labelled assumption and list it for Aaron.
- **If RedBeam can't do something, stop and report it.** Aaron upgrades the app.
- **When a check is questioned, re-derive it.** If anyone questions a spacing, count, scale or other check, go back to the documents and work it out again from the source before you restate it. Don't repeat the earlier conclusion, and don't call anything "confirmed" until it meets the source rules above.
- **Keep the brief in step.** If the run keeps a brief page or document, update it in the same turn as every takeoff change (counts, stock, quantities, images), so it never shows superseded numbers.
- **Temporary, until REDBEAM reads CAD text (bug filed 2026-11-27):** where a set stores the drawing text as annotations, `redbeam_find_text` and `redbeam_read_scale` miss tags, spacing notes and stated scales. When they come back empty on a sheet that visibly shows the text, also search the annotation text (`redbeam_list_annotations`) before you mark a source as missing.

## A. Scope definition (stop for approval)

1. Start with `redbeam_start_session {task}` (a short name for the job) and pass its `session` on every call. Open the working copy with `redbeam_open_file`. **Fix sheet names first:** run `redbeam_list_sheets`; if numbers come from bookmarks/tags (MF01, SF72) or are null, find the title-block number and title boxes with `get_words`, set them with `redbeam_set_title_blocks`, then patch outliers and the discipline prefix (e.g. "A") with `redbeam_rename_sheets`. Save. Then go to each plan sheet with `redbeam_go_to_page {sheet}`.
2. **Scale:** run `redbeam_read_scale` to see the stated scale. Check it against two written dimensions that run in different directions, one across and one down (`dimension` + `points`). If they disagree, report the difference to Aaron before any quantity: REDBEAM holds one scale per sheet, so a layout at the wrong scale drifts across the field. For a repeating-member field, also check the scale against a drawn bay (the measured distance between drawn members against the written spacing). Set it with `redbeam_set_page_scale {presetId}`. This setting is not undoable.
3. **For each scope area:**
   - Find its outline with `redbeam_trace_area`. **If the field is a hatched/patterned fill (trace fails on content):** use `redbeam_trace_field` with a point inside the field. Do not hand-click outlines from screenshots and do not hull the vector hatch — hatch dashes break at every grid line, column and panel joint and the hull splits there. If the outline follows the wrong linework, call it again with `angle` from `pattern.alternatives` or with `strokeSpacingFeet`. Check each field's `lookAt` box with `redbeam_screenshot` (region, overlay on) and show Aaron before quantities.
   - **Grid lines, column lines and dimension lines are never boundaries.** A field only stops where its fill stops or at a drawn bulkhead/wall.
   - **Outlines built from line coverage must be closed across fixtures.** When an outline is derived from where grid lines or members are drawn (panel grid coverage, member union), the drawn lines break wherever a light fixture, sign, diffuser or column is drawn over them, and the outline gets notches that aren't in the ceiling. Before creating the area, close the outline across gaps up to the widest fixture on the sheet (typically about 2 ft), keep it inside its original bounding box, then compare it with the render. Keep a step only where the drawing shows a real edge: a wall, bulkhead, opening, or a column you choose to cut out. A light fixture within the field is never a notch or a cutout.
   - **Overlapping sheets (sector plans):** never guess a match line. Register the two sheets on two shared grid intersections, map one field onto the other and subtract the overlap; state the sf removed.
   - **Look for a typical module or pattern detail before assuming even spacing.** Search with `redbeam_find_text` for the mark's detail references and words such as TYP, MODULE, PATTERN and LAYOUT, and read the enlarged plans. If the product repeats as a module (members of different lengths, offsets or a random-looking layout that tiles), record the module, its size and its member list, and count from that. A single on-centre figure is only right when the drawing shows uniform spacing. Where REDBEAM has no product that lays the module out, build it as a custom pattern (`redbeam_preview_pattern`, then `redbeam_save_pattern`, or `create_scope` with `recipe` in one call) when Aaron has Custom patterns turned on under Settings, Beta; if it is off, say so and count the module by hand. Check the layout with `redbeam_screenshot` (region, overlay on): close-ups show the layout preview, so there is no need to zoom Aaron's window. An area edge within 1" of a module line counts as on it (`edgeSnap` in the recipe).
   - Read the pattern with `redbeam_detect_pattern`, then confirm it with `get_lines`. Record:
     - direction;
     - on-centre spacing;
     - member length;
     - number of runs and rows;
     - the reveals or gaps between runs;
     - where the designer's first member sits.
   - Note the fixtures within the field. A pendant that hangs below the ceiling is not a cutout. Cut out only where the drawing leaves the field empty.
   - **Column notches:** size each notch to the short runs drawn around the column, not to the column's box, and confirm the number of short runs laid out matches the drawing.
   - Note any edge where the drawn members stop short of the outline (e.g. clear zones at walls or a TV wall).
   - **Use the true outline.** Chevrons, angled and tapered fields are drawn as their real polygons, split at the fold, never as bounding rectangles.
   - **Split by direction.** Where members change direction inside a room (bands, diagonal splits), segment the field by member direction (orientation map on a render, then fit the dividing lines) and make one area per direction region, each with its own direction.
   - **Mixed-member rhythm.** Where one member type repeats every Nth position (e.g. Beam every 4th, Slab between), record N and the first beam position; build it as a custom pattern with one `lines` layer per member offset, plus the perimeter frame as its own linear scope drawn on the frame centreline.
   - **Panel/tile grids:** find the drawn major grid lines (vector lines or a grey-band profile of a render), record the module, the count across and down, and the grid intersection to use as origin.
   - **3D / cloud ceilings:** look for sections, building sections, elevations and details. If none show the profile, model plan extents only, label the slope/upturn as unknown, and list the questions.
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
6b. **Self-check before asking:** compare each field's area against the panels dimensioned on the enlarged plans (if any), and attach an overlay image of every outline on its sheet so Aaron can see the boundaries, not just the numbers. Zoom each overlay to edge level and reject any notch that lines up with a fixture, sign or grid break. Confirm that every spacing in the table cites a non-RCP source or is marked UNCONFIRMED.
7. **Stop.** Ask Aaron to approve or correct the definition. Call `redbeam_wait_for_person {for: "approve the scope definition"}` so REDBEAM shows that you are waiting for him.

## B. Takeoff (after approval)

1. **Create each scope** with `redbeam_create_scope {productType, specifications}`. Fill every required key from `redbeam_describe_product`, with its unit keys (e.g. `spacing`, `spacingUnit`, `stockLength`, `maxConnectorSpacing`). Labels must be unique and use plain hyphens.
2. **Draw the areas** in one call with `redbeam_create_markups`. Give each markup its `page`: it is written to that sheet in the background, so do not turn Aaron's pages to draw. Draw:
   - one area for each separate run or field;
   - areas sized so runs fit whole stock lengths where the drawing intends that (e.g. exactly 8'-0");
   - a cutout only where the drawing shows a real void.
3. **Set the direction** for each scope with `redbeam_set_pattern_direction`.
4. **Set the origin from the drawn members** with `redbeam_set_pattern_origin`. By default, put it on a drawn member, not the area edge. If the first bay at the edge is odd (shorter or longer than the spacing), skip it and start from the first member at full spacing. Use an edge, corner or centre origin only where the drawing places members that way (e.g. centred on a symmetrical shape).
5. **Check the result:**
   - Run `redbeam_get_bom`. No line may be blocked.
   - Run `redbeam_get_piece_list` for each scope.
   - Compare runs and rows against the drawn counts, and explain every difference (e.g. a layout that reaches a wall the design stops short of).
   - **Count check per area:** members, boxes or panels laid out must equal those drawn. For tile grids, "cut at the edge" should be zero where the drawing shows whole modules; if not, the origin or area edge is off the grid. Size tile areas to an exact multiple of the module (a hair under, never over) to avoid sliver counts.
   - **Check the layout visually** with `redbeam_screenshot` (region, overlay on): close-ups draw the layout preview, so never zoom or turn Aaron's window to look.
   - **Check positions at the far edge, not only the count.** Compare the last laid-out members with the drawn members at the edge opposite the origin. A matching count can hide drift from a scale or spacing error. If the layout has drifted off the drawn members, recheck the scale against the drawn bay before handing back.
   - Flag any run longer than the stock length (e.g. 8'-6" runs on 8' stock) and ask whether longer stock is available.
   - **Seams aligned by default.** Joints between pieces in neighbouring runs must line up on common lines across the field, unless Aaron turns that off for the scope. Check it in a close-up of the layout preview and in the piece list (the cut position of each run's first joint). If runs start their stock at their own edge and the seams stagger, report it as a RedBeam gap and say how many stock pieces aligned seams would add or save.
6. **Stock search and yield pass:**
   - Try each stock length Aaron names, or the schedule's lengths if he names none, and compare stock pieces for each.
   - Read the piece list for every layout, not a summary line, and reject any layout that leaves a piece under 2'-0". If every length leaves one, report it as a RedBeam gap.
   - Try half on each scope that has cut pieces, and keep it only where stock drops.
   - Work out what quarter would save without applying it. If it helps, ask Aaron.
7. **Save:** run `redbeam_save`.
   - If it refuses because another app wrote to the file, run `redbeam_save_copy`, reopen the copy, and confirm the scopes still carry their product type, specifications, directions and origins. Re-enter anything that was lost.
   - Tell Aaron which sheets carry the takeoff. His screen is his: you cannot turn his page or switch on his layout preview. He can click your session in the Agents list to go to your sheet.

## C. Sign-off checks (before the takeoff is final)

The takeoff can go to Aaron for estimator-assisted review before these pass, but it is not final until each one does. Report each check as passed, open or not applicable, with its evidence.

1. **Second visual pass on every baffle RCP.** After the first takeoff, go back over every baffle RCP with the saved traces shown over the drawing (`redbeam_screenshot`, region, overlay on), zoomed to edge level. Look hardest at fan or radial layouts, fixtures, openings, field edges and match lines. Add the missed segments, then log the segments and installed LF added on each sheet. Sheets that added nothing are logged as 0, so the log shows every baffle sheet was rechecked.
2. **A height source for every vertical group.** For each group of vertical baffles or blades, record the blade count, the height, the section or elevation it comes from, and whether the height was dimensioned, scaled or assumed. An assumed height is not final until Aaron approves it. Where another height is plausible (a different section, another estimator's figure), show the LF at that height too.
3. **Projected LF and installed LF are separate.** Plan traces of a sloped ceiling give projected LF. Assign a slope to each platform or zone, cite the section that shows it, and report projected LF, angle and installed LF (projected ÷ cos angle) for each. Never add projected and installed LF in one total.
4. **Reconcile by sheet and scope before grand totals.** When comparing with another estimator's takeoff or an earlier revision, compare sheet by sheet and scope by scope first. Keep flat ceilings, sloped ceilings, verticals and bulkhead top faces as separate lines. Where an area was converted to LF, record the on-centre spacing used. Explain each major difference and flag the ones you can't resolve. Matching grand totals can hide errors that offset each other.
5. **Count each physical run once.** At a match line, name the sheet that owns each run and leave it out of the other sheet. For repeated details (typical bulkheads, typical ends, copied floors), tie every counted occurrence and every counted face to a plan location. If the drawings don't show how many locations or exposed faces there are, that count is an assumption to confirm before sign-off.
6. **Keep an auditable revision.** Save the corrected markups, the installed-quantity summary and the cut schedule together in one revision, so the saved file reproduces the reported total (previous total + logged additions = new total). Name any markups left out of the count, such as another estimator's labels, and why. The cells and labels of a comparison worksheet go in the report, not in the takeoff.

**Sign-off names the assumptions.** The request for final approval lists the assumptions Aaron is accepting, such as vertical heights, face counts at repeated details, and differences between traced runs and area-derived LF, each with its effect on LF where known.

## Hand back

- **Quantities table, per scope:** area, on-centre spacing, stock, yield, installed LF, stock pieces (full or half), cut list, hangers, end caps, joiners.
- **Detail and finish call-outs:** the detail and finish references found in Part A.
- **Assumptions to confirm:** e.g. hanger spacing, edge clearances, stock lengths that differ from the schedule.
- **Where the layout differs from the drawing, and why.**
- **Drawn vs counted table** per area (members / boxes / panels), so Aaron can see each scope was checked against the plan.
- **Superseded scopes:** archive (do not delete) any scope replaced during the run, and name it in the hand-back.
- **RedBeam gaps and bugs** hit during the run. For a hard set, offer to package the relevant sheets, a README of what went wrong and why, overlay images and any scripts for the REDBEAM developer chat.
- **Feedback to send, for approval.** Keep a running note through the session of (1) REDBEAM problems you hit: an error, a call that did nothing, a wrong quantity, something drawn wrong or slow; and (2) improvements to this skill: a step it got wrong or left out, or anything the person corrected you on that the skill should have told you. Before finishing, show the person both lists, one line each with what you would send, and ask which to submit. Submit only the ones they approve: each problem with `redbeam_report_problem` (becomes a "bug report" issue), each skill idea with `redbeam_suggest_skill_improvement` (`skill`, `summary` = what the agent should do differently, `suggestion` = the wording, `why` = what happened; becomes a "skill suggestion" issue that is reviewed before the skill changes). Keep client names and prices out of both. Keep following the skill as written until a change is approved. If there is nothing to report, say so in one line.
- **Sign-off checks (Part C):** the second-pass log by sheet, the vertical height table, projected vs installed LF by platform or zone, the sheet-and-scope reconciliation when comparing with another takeoff, and the assumptions Aaron is accepting.
- **File:** the path of the saved working copy.
- **Finish the session:** once the feedback above is submitted or declined, call `redbeam_end_session {summary}` with one line on what was saved, so REDBEAM hands the PDF back to Aaron.
