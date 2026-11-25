# REDBEAM 0.3.83 at 40c19fb, AARON-SLS, 2026-11-25

- **Build:** built locally (249 s) and installed per-user once the benchmark had closed its own "Project Heineken" window. No other REDBEAM was running.
- **Desktop:** unlocked.
- **Agents:** real `REDBEAM.exe --mcp` processes.
- **Files:** scratch PDFs only. Shape 2 used a clean 8-sheet pdf-lib set; shape 1 used 8-sheet sets that already held markups from earlier runs.
- **Bench log:** read-only.

## Concurrency (2a to 2f)

| Check | ONE --mcp, 10 sessions (driver-log-conc-one.json) | 10 --mcp processes (driver-log-conc-many.json) |
|---|---|---|
| open wait:true | 10/10 opened, 8 pages, yours:true | 10/10 opened, 8 pages, yours:true |
| a. set_page_scale pages [0..7], never shown | 10/10 ok, 8 pages each, 0 FOREIGN KEY | 10/10 ok, 8 pages each, 0 FOREIGN KEY |
| b. create_markups 12 areas over 6 sheets via `page` | 10/10: created 12, 12 ids | 10/10: created 12, 12 ids |
| c. list_markups + scales | per sheet includes earlier markups in these sources; pages 1-6 each gained 2; 8/8 calibrations ok | **exactly 12: 2 each on sheets 1-6**; 8/8 calibrations (sample: arch-1-8 on p0..p7) |
| d. update_scope on own scope | 10/10 ok, no "no such scope" | 10/10 ok |
| e. round-robin traffic | 12 min, 953 calls total | 12 min, 921 calls total |
| e. silent session, 11 min, then list_markups + get_ui_state | pageCount 8, markups intact (18, same as at setup), 8 scales | pageCount 8, 12 markups (2 × sheets 1-6), 8 scales |
| f. save | 10/10 "unchanged" (already in the file, see reopen) | 10/10 "unchanged" |
| f. end_session with keep | 10/10 handed back 1 | 10/10 handed back 1 |
| f. reopen two byte copies fresh | 01 and 10: same markups per sheet and 8 scales | 01 and 10: 12 markups (2 × sheets 1-6) and 8 scales |
| Errors, all calls | **0** | **0** |
| "out of range (0..-1)" / "no document is open" / "no canvas" / "FOREIGN KEY" / "no such scope" | 0 / 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 / 0 |
| Foreground, sampled every 0.5 s through the run | ShellExperienceHost 1832/1832; REDBEAM never in front | ShellExperienceHost 1830/1830; REDBEAM never in front |
| Agents list names | (UIA tree query timed out with 32+ restored tabs) | "Claude · Concurrency 1 takeoff", "ChatGPT · …", "Claude Code · …"; no "Â·" |

Notepad could not take the foreground for these runs: Windows' foreground lock left ShellExperienceHost in front. The check that REDBEAM never came forward still holds.

## Bench-log replays (on scratch copies of the same PDFs; the copies already held the benchmark's saved markups and scopes)

| Sequence | Result on 40c19fb | Benchmark (b2929aa) |
|---|---|---|
| Verge Condo: set_page_scale pages [0..5] (3 forms) and [1..5] | all ok, pages [0..5] / [1..5] | FOREIGN KEY constraint failed |
| Verge Condo: create_markups 22 entries over 6 sheets | created 19, 19 ids, landed on sheets 0-5 (0:+4 1:+5 2:+3 3:+2 4:+2 5:+3); the other 3 were cutouts | created 19 |
| Verge Condo: per-sheet follow-ups | 5, 3, 2, 2, 3 created as sent | same |
| Verge Condo: after | 53 markups (19 before + 34): 0:8 1:15 2:9 3:6 4:6 5:9; scales metric-50 on p0..p5 | |
| 5 Times Square: set_page_scale pages [1..5] / [1,2,4,5] | ok | FOREIGN KEY constraint failed |
| 5 Times Square: create_markups batch of 6 (sheets 1,2,3,4×2,5) | created 6, 6 ids, all present (total rose 31 → 66 = 6+25+4) | 6 ids, 4 areas reported missing |
| 5 Times Square: after | 1:3 2:2 3:24 4:22 5:15; scales arch-1-4 on p0..p5 | |
| create_scope (labels already in the copy) | refused, "already exists" (expected; the copies held the benchmark's scopes) | ok |
| Saves | first "written", second "unchanged" | "unchanged" both times |

Observation: a byte copy of REPLAY-Verge-Condo.pdf taken right after the replay's final save ("written") read back **no calibrations**. A copy taken a little later (file time 12:39:35, after end_session handed the tab back) had all 6 metric-50 scales. The scales may reach the file a write later than the markups. This is not confirmed as loss.

The bench log read as UTF-8 has 914 lines with "·" and 0 with "Â·".

## S5 / S9 regression

S5: REDBEAM never came to the front during either 12-minute run (3662 samples).

S9 case B: **not completed.** The display was reconfigured mid-session (\\.\DISPLAY11 became \\.\DISPLAY1). Afterwards REDBEAM's window stayed 1455×909, maximize did not apply, and its web content rendered about 1.3× too large inside the window (S9-caseB-attempt-display-rescaled.png). The person's real clicks missed the Dimension button, so no person markup was drawn and there was nothing for Ctrl+Z to undo. The guest area was created and stayed.
