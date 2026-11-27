# Daily skill sync

Aaron (2026-11-27): the skills in his Claude account are the master copies.
Every other copy follows them one way and carries the master's date and
fingerprint. Nobody edits a copy directly; a copy edited by hand is flagged to
Aaron, never overwritten silently.

| Skill | Master | Copies |
| --- | --- | --- |
| precon-takeoff | `/root/.claude/skills/synced/*/precon-takeoff/SKILL.md` | `apps/mcp/skills/precon-takeoff.md` (ships in REDBEAM), Notion page `424bcf2b9982818ca3d0d99ed50572d5` |
| precon-intake | `/root/.claude/skills/synced/*/precon-intake/SKILL.md` | Notion page `424bcf2b99828194a79eebd654739692` |

The Notion pages live in the Maxxit workspace under PreCon. Reach them through
Composio's `notion` toolkit (`NOTION_GET_PAGE_MARKDOWN`,
`NOTION_UPDATE_PAGE_MARKDOWN`), not the native Notion connector, which is
Aaron's personal workspace.

`tools/skill-sync.mjs` does the comparing. `check` and `notion-check` exit 0
when the copy is current, 10 when it is an untouched older master (safe to
overwrite) and 20 when it was edited by hand (flag it, do not overwrite).

## Each run

1. Find both masters. If a master is missing, stop and report that the account
   skills did not reach this session.
2. `git fetch origin main` and work from `origin/main`.
3. **App copy.** `node tools/skill-sync.mjs check <takeoff master> apps/mcp/skills/precon-takeoff.md`.
   - 0: nothing to do.
   - 20: flag it. Show `git log -p -3 -- apps/mcp/skills/precon-takeoff.md`
     so Aaron sees who changed it, and do not overwrite it.
   - 10: first list the `redbeam_*` tool names the copy mentions that the
     new master does not. If there are any, flag it instead of syncing: the
     master would take app steps away from agents, which is usually an account
     skill saved from an older card. Otherwise, unless an open PR already
     carries this fingerprint, branch from main, run
     `node tools/skill-sync.mjs stamp <master> apps/mcp/skills/precon-takeoff.md`,
     take the next free version (newest tag and every open PR's version), bump
     it in the six version files, add a CHANGELOG entry in plain words about
     what changed in the skill, run `npm run test:mcp`, push, open the PR,
     merge it once CI is green, then release it by dispatching
     `release.yml` on `main` with `version`, `notes` (the CHANGELOG entry in
     one paragraph) and `dry_run: false`. Do not dispatch until the previous
     release run has started (a newer queued dispatch replaces a pending one).
4. **Notion.** For each skill, fetch the page markdown into a file and run
   `node tools/skill-sync.mjs notion-check <master> <file>`.
   - 0: nothing to do.
   - 20: flag it, quoting the stamp and the page's last edit, and do not overwrite.
   - 10: write `node tools/skill-sync.mjs notion <master>` with
     `NOTION_UPDATE_PAGE_MARKDOWN` `replace_content`, fetch it again and check
     it now exits 0.
5. **Suggestions.** People and agents suggest skill changes from REDBEAM
   (Settings › Suggest a skill improvement, and the agent tool
   `redbeam_suggest_skill_improvement`). Each arrives within the hour as an
   open GitHub issue labelled `skill suggestion`, titled
   `Skill suggestion (<skill>): <summary>`. Aaron, 2026-11-27: they queue for
   Claude's review, and nothing reaches a skill until he approves it.
   - List the open `skill suggestion` issues. Skip any that carry the
     `proposed` label, unless Aaron has commented on them since.
   - For each, read it against the current master. Decide: a real gap or a
     wrong step (draft it), already covered or a duplicate of another open
     suggestion (say which section covers it, or fold it into the other), or
     not right for the skill (a REDBEAM bug belongs in a `bug report` issue;
     a one-project preference belongs in that project's notes).
   - Draft every suggestion worth taking as the smallest edit to the master,
     in the skill's own voice, merging suggestions that touch the same step.
     `unsure` ones go to whichever skill the step belongs to.
   - Bring them to Aaron in one `propose_skills` card per skill (edits on the
     existing skill, never a new one), and say beside it which issues each
     edit answers. Then comment on each issue with the drafted wording and
     add the `proposed` label.
   - Close the rest with a one-line reason as a comment (state reason
     `not_planned`, or `completed` when the skill already covers it).
   - Next runs: a suggestion whose wording is now in the master is done;
     comment with the skill's new fingerprint, close it as `completed`, and
     the sync above carries it to the copies. One Aaron declined (he says so,
     or two runs pass with the card unsaved and no word) is closed as
     `not_planned` with his reason if he gave one.
   - Never edit a copy, and never write a suggestion into the master
     yourself; the card is the only path.
   - **Pending cards from other threads.** Aaron, 2026-11-27: skill updates
     come to him once a day, in this run. List the project's threads active
     since the last run (`list_threads` with `since`) and read each for skill
     cards (`skill_proposal`) still `pending`. Fold their changes into your
     card for that skill, then tell each of those threads (`message_thread`)
     that its card is superseded by today's card and should not be re-posted.
   - **One card per skill, built on the current master.** Every card holds
     all of the day's changes for that skill as edits on the master as it is
     now, so saving it never drops another change and no two cards for one
     skill are ever open at once. If a card from an earlier run is still
     unsaved, fold it into today's card and say the old one is replaced.
   - When Aaron saves a card, this thread is told: run steps 3 and 4 again
     at once so the app copy and Notion carry it the same day.
6. Report only when something changed or was flagged: what was synced (skill,
   copy, new fingerprint, PR and version) and every flag with what Aaron
   should do (move the change into his Claude skill, or say to discard it).
   For a flag, also open a GitHub issue labelled `skill sync`. Report
   suggestions as how many came in, which you proposed (with the card) and
   which you closed and why. A run with nothing to do says nothing.

**Threads don't post skill cards.** A thread in the REDBEAM project that finds a
skill change (from a run, a correction Aaron made, a session report) files it
as a `skill suggestion` issue titled `Skill suggestion (<skill>): <summary>`,
with the wording, why, and a link to the thread, and tells Aaron in one line
that it is queued for the daily skill check. Only when Aaron asks for a skill
change in that thread right now does the thread post the card itself.

When a thread in the REDBEAM project sees Aaron save a change to one of these
skills, it fires the "Sync precon skills" scheduled task at once instead of
waiting for the daily run.
