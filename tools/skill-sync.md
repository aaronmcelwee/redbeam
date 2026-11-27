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
5. Report only when something changed or was flagged: what was synced (skill,
   copy, new fingerprint, PR and version) and every flag with what Aaron
   should do (move the change into his Claude skill, or say to discard it).
   For a flag, also open a GitHub issue labelled `skill sync`. A run with
   nothing to do says nothing.

When a thread in the REDBEAM project sees Aaron save a change to one of these
skills, it fires the "Sync precon skills" scheduled task at once instead of
waiting for the daily run.
