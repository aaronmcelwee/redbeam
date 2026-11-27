/**
 * Contract tests for the MCP surface.
 *
 * These do NOT need the app running: they pin the tool schemas and the
 * name->method mapping, which is where a rename silently breaks an agent.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { tools, METHOD_OF } from './index.mjs'
import { readFileSync } from 'node:fs'
const SPEC_HANDOUT = JSON.parse(readFileSync(new URL('./tools.json', import.meta.url), 'utf8')).lean.handout

test('every tool maps to a bridge method, and every mapping has a tool', () => {
  // A tool with no mapping fails at call time with "Unknown REDBEAM tool";
  // a mapping with no tool is dead code an agent can never reach.
  const names = new Set(tools.map((t) => t.name))
  for (const t of tools) assert.ok(METHOD_OF[t.name], `${t.name} has no bridge method`)
  for (const n of Object.keys(METHOD_OF)) assert.ok(names.has(n), `${n} is mapped but not exposed`)
})

test('tool names are unique and namespaced', () => {
  const names = tools.map((t) => t.name)
  assert.equal(new Set(names).size, names.length, 'duplicate tool name')
  for (const n of names) assert.match(n, /^redbeam_[a-z_]+$/)
})

test('every tool has a description and a valid object schema', () => {
  for (const t of tools) {
    assert.ok(t.description?.length > 20, `${t.name} needs a real description`)
    assert.equal(t.inputSchema.type, 'object', `${t.name} schema must be an object`)
    for (const req of t.inputSchema.required ?? []) {
      assert.ok(t.inputSchema.properties[req], `${t.name} requires ${req} but does not define it`)
    }
  }
})

test('there is no way to open a project', () => {
  // Aaron, 2026-11-24: "lets retire pro mode altogether". Opening a project
  // is what put an agent's window into Pro.
  assert.equal(tools.find((x) => x.name === 'redbeam_open_project'), undefined)
  assert.equal(Object.values(METHOD_OF).includes('open_project'), false)
})

test('execute_query says why writes are refused, not just that they are', () => {
  const t = tools.find((x) => x.name === 'redbeam_execute_query')
  assert.match(t.description, /undo|activity/i)
})

test('window-dependent tools say so', () => {
  // Store-backed tools work on a minimized app; these do not, and an agent
  // should know which kind it is calling before it blames the bridge.
  for (const name of ['redbeam_get_ui_state', 'redbeam_screenshot']) {
    const t = tools.find((x) => x.name === name)
    assert.match(t.description, /window/i, `${name} should mention needing a window`)
  }
})

test('writes are documented as landing on the undo stack', () => {
  // An agent writing takeoff must know the change is visible to the person who
  // owns the estimate, not silently applied.
  const t = tools.find((x) => x.name === 'redbeam_invoke_ui_action')
  assert.match(t.description, /undo stack/i)
  assert.match(t.description, /agent/i)
})

test('the writes that do NOT undo say so by name', () => {
  // Extended when the surface grew writes the undo stack has never covered.
  // The blanket promise above was true of every action when it was written and
  // is not any more: committing a scope records an answer rather than editing
  // one, and a scale region is project setup. An agent that believes it can
  // reverse either will tell somebody it has, which is worse than refusing.
  const t = tools.find((x) => x.name === 'redbeam_invoke_ui_action')
  assert.match(t.description, /commit_scope/)
  assert.match(t.description, /set_page_scale/)
  assert.match(t.description, /scale.region/i)
  // Named, not merely implied. `set_page_scale` covers a whole sheet series in
  // one transaction and the store writes it outside the undo stack — the
  // button has the same property — so there is no taking it back, and an
  // agent that believes there is will overwrite a scale to "try it".
  assert.match(t.description, /cannot be taken back/i)
})

test('the bill of materials warns that its total is not the sum of its rows', () => {
  // `totals` covers VERIFIED lines only and a blocked line has quantity null.
  // An agent that adds the rows up, or reads null as zero, produces a number
  // somebody prices work from.
  const t = tools.find((x) => x.name === 'redbeam_get_bom')
  assert.match(t.description, /confidence/i)
  assert.match(t.description, /verified/i)
  assert.match(t.description, /null/i)
})

test('export says where its output goes', () => {
  // Two of the three come back as text and one lands in a downloads folder the
  // agent cannot read. An agent expecting a file path for the first two, or
  // bytes for the third, is stuck either way.
  const t = tools.find((x) => x.name === 'redbeam_export')
  assert.match(t.description, /text/i)
  assert.match(t.description, /download/i)
  assert.deepEqual(
    t.inputSchema.properties.what.enum,
    ['tsv', 'report', 'marked-pdf', 'csv', 'estimate-tsv', 'pdf', 'pieces-csv'],
  )
})

test('a scale can be set by name, and the names are discoverable', () => {
  // The preset ids are not guessable — `arch-1-8`, not `1/8"` — and guessing
  // one produces a refusal that says nothing about what would have worked.
  const t = tools.find((x) => x.name === 'redbeam_invoke_ui_action')
  assert.ok(t.inputSchema.properties.action.enum.includes('get_scale_presets'))
  assert.match(t.inputSchema.properties.presetId.description, /get_scale_presets/)
})

test('specifications are documented as merged, not replaced', () => {
  // The same object carries the pattern directions the direction tool writes.
  // A replacing write from an agent editing a panel size silently re-orients
  // every piece count on the scope, and nothing reports it.
  const t = tools.find((x) => x.name === 'redbeam_invoke_ui_action')
  assert.match(t.inputSchema.properties.specifications.description, /merged/i)
  assert.match(t.inputSchema.properties.specifications.description, /direction/i)
})

test('a scale region says which coordinate space it wants, like create_markup', () => {
  // Same trap, same page: PDF points are in the hundreds and would "work",
  // putting the region somewhere it governs nothing.
  const t = tools.find((x) => x.name === 'redbeam_invoke_ui_action')
  assert.match(t.inputSchema.properties.rect.description, /normalized/i)
  assert.match(t.inputSchema.properties.rect.description, /NOT PDF points/i)
})

test('create_markup says which coordinate space it wants', () => {
  // Page points are in the hundreds and would "work" — placing a markup off
  // the sheet. The schema has to say normalized, and the app rejects the rest.
  const t = tools.find((x) => x.name === 'redbeam_invoke_ui_action')
  assert.match(t.inputSchema.properties.rings.description, /normalized/i)
  assert.match(t.inputSchema.properties.rings.description, /NOT PDF points/i)
})

test('page numbering is documented as zero-based where it is exposed', () => {
  // The Qt surface is zero-based and so is ours; an off-by-one here is a
  // markup on the wrong sheet.
  const pages = tools.find((x) => x.name === 'redbeam_list_pages')
  assert.match(pages.description, /zero-based/i)
  const invoke = tools.find((x) => x.name === 'redbeam_invoke_ui_action')
  assert.match(invoke.inputSchema.properties.page.description, /zero-based/i)
  // And on every parameter that names a sheet, not just the one that did when
  // this was written. Applying a scale one sheet out puts a whole series at
  // the wrong scale, which is the same off-by-one with a hundred times the
  // blast radius.
  for (const p of ['pages', 'fromPage', 'toPage']) {
    assert.match(
      invoke.inputSchema.properties[p].description, /zero-based/i,
      `${p} names a sheet and must say the numbering is zero-based`,
    )
  }
})

test('round 3 agent takeoff tools are named and described', () => {
  for (const name of [
    'redbeam_describe_product', 'redbeam_set_pattern_origin', 'redbeam_set_pattern_direction', 'redbeam_get_pattern',
    'redbeam_trace_area', 'redbeam_detect_pattern', 'redbeam_read_scale', 'redbeam_track_addenda',
    'redbeam_create_markups', 'redbeam_get_piece_list', 'redbeam_get_history',
  ]) {
    const t = tools.find((x) => x.name === name)
    assert.ok(t, `${name} is listed`)
    assert.ok(t.description.length > 60, `${name} says what it does`)
  }
  const exp = tools.find((x) => x.name === 'redbeam_export')
  assert.ok(exp.inputSchema.properties.path, 'export takes a path')
})

test('a chat starts a session, and a call without one is refused', async () => {
  // Aaron, 2026-11-24: "let the Mcp start up a new session per Chatgpt or
  // Claude chat". One server serves every chat of its app, so the server
  // hands each chat a value only it holds.
  const { callTool, toolsWithAgent, startSession, sessionOf } = await import('./index.mjs')
  const listed = toolsWithAgent()
  assert.equal(listed[0].name, 'redbeam_start_session')
  for (const t of listed.slice(1)) {
    assert.equal(t.inputSchema.properties.session.type, 'string', t.name)
    assert.ok(t.inputSchema.required.includes('session'), t.name)
  }
  // Two chats that call their job the same thing are still two sessions.
  const a = startSession('Nokia Canada North Campus takeoff')
  const b = startSession('Nokia Canada North Campus takeoff')
  assert.notEqual(a, b)
  assert.match(a, /^Nokia Canada North Campus takeoff #[2-9A-Z]{3}$/)
  assert.notEqual(sessionOf(a).code, sessionOf(b).code)
  assert.equal(sessionOf(a).task, 'Nokia Canada North Campus takeoff')
  // A chat may tidy the words; the code is what counts.
  assert.equal(sessionOf(`nokia takeoff #${sessionOf(a).code.toLowerCase()} `).code, sessionOf(a).code)
  // None, a made-up one, or a bare name: refused before REDBEAM is reached.
  for (const bad of [undefined, '', 'Nokia Canada North Campus takeoff', 'x #000', 42]) {
    await assert.rejects(callTool('redbeam_get_ui_state', { session: bad }), /redbeam_start_session/)
  }
  await assert.rejects(callTool('redbeam_get_ui_state', { agent: 'framing' }), /redbeam_start_session/)
  const started = await callTool('redbeam_start_session', { task: '  Level 2   ceilings ' })
  assert.match(started.structuredContent.session, /^Level 2 ceilings #[2-9A-Z]{3}$/)
  await assert.rejects(callTool('redbeam_start_session', {}), /task/)
})

test('the shipped takeoff skill is an untouched copy of the master', async () => {
  // Aaron, 2026-11-27: his Claude account skill is the only place the skill is
  // edited. The copy carries the master's date and fingerprint; any other edit
  // breaks the match and is lost at the next sync.
  const { check } = await import('../../tools/skill-sync.mjs')
  const copy = readFileSync(new URL('./skills/precon-takeoff.md', import.meta.url), 'utf8')
  const r = check(copy, copy)
  assert.ok(r.stamp, 'skills/precon-takeoff.md has no "master:" stamp; make it with node tools/skill-sync.mjs stamp')
  assert.equal(r.status, 'in_sync', 'skills/precon-takeoff.md was edited by hand. Edit the precon-takeoff skill in Aaron\'s Claude account instead, then run node tools/skill-sync.mjs stamp <SKILL.md> apps/mcp/skills/precon-takeoff.md')
})

test('every agent is handed the takeoff skill when its session starts', async () => {
  // Aaron, 2026-11-25: the local server gives agents the current precon-takeoff
  // skill. skills/precon-takeoff.md is the copy that ships.
  const { callTool, SKILL, SKILL_URI, skillHandout } = await import('./index.mjs')
  assert.ok(SKILL.startsWith('# Precon takeoff'), 'the skill is served without its front matter')
  assert.match(SKILL, /typical module or pattern detail/)
  for (const tool of SKILL.match(/`redbeam_[a-z_]+/g) ?? []) {
    const name = tool.slice(1)
    assert.ok(name === 'redbeam_start_session' || tools.some((t) => t.name === name), `the skill names ${name}, which is not a tool`)
  }
  const started = await callTool('redbeam_start_session', { task: 'Skill check' })
  assert.equal(started.structuredContent.takeoffSkill, SKILL_URI)
  assert.equal(started.content[1].text, skillHandout())
  // Benchmark run 3 (2026-11-27): no agent batched from the tool description alone, so the handout says when to.
  assert.match(skillHandout(), /redbeam_batch \{session, calls/)
  assert.ok(skillHandout().indexOf('redbeam_batch') < skillHandout().indexOf('# Precon takeoff'), 'the batching note comes before the skill')
  for (const tool of SPEC_HANDOUT.match(/redbeam_[a-z_]+/g) ?? []) {
    assert.ok(tool === 'redbeam_batch' || tools.some((t) => t.name === tool), `the handout names ${tool}, which is not a tool`)
  }
})

test('the listed tools are lean: no catch-all, short shared inputs, and a size that does not creep', async () => {
  // Every chat pays for the whole list before its first call (Aaron,
  // 2026-11-27: "use fewer tokens"). 0.3.113 listed 160 KB.
  const { toolsWithAgent } = await import('./index.mjs')
  const listed = toolsWithAgent()
  const names = listed.map((t) => t.name)
  assert.equal(names[0], 'redbeam_start_session')
  assert.equal(names[1], 'redbeam_batch')
  assert.equal(names.includes('redbeam_invoke_ui_action'), false, 'every action has a tool of its own')
  for (const t of listed.slice(1)) {
    const p = t.inputSchema.properties
    assert.ok(p.session.description.length < 90, `${t.name} session`)
    if (p.file !== undefined) assert.ok(p.file.description.length < 130, `${t.name} file`)
    for (const [k, v] of Object.entries(p)) {
      assert.doesNotMatch(String(v.description ?? ''), /^For [a-z_]+(, [a-z_]+)*(,? and [a-z_]+)?: /, `${t.name}.${k} still names the catch-all's actions`)
    }
  }
  const bytes = JSON.stringify(listed).length
  // Not a cap on what tools may exist: a reminder to say it in fewer words. Raise it with a new tool, not with longer text.
  assert.ok(bytes < 125_000, `tools/list is ${bytes} bytes`)
})

test('a batch fills in values from earlier answers', async () => {
  const { resolveRefs } = await import('./index.mjs')
  const answers = [{ scopeId: 'sc_1', scope: { label: 'CL-1' } }, { pages: [3, 4] }]
  assert.deepEqual(
    resolveRefs({ scopeId: '$0.scopeId', label: '$0.scope.label', page: '$1.pages.1', note: '$5 each', rings: [[{ x: 0.1, y: 0.2 }]] }, answers),
    { scopeId: 'sc_1', label: 'CL-1', page: 4, note: '$5 each', rings: [[{ x: 0.1, y: 0.2 }]] },
  )
  assert.throws(() => resolveRefs({ scopeId: '$0.nope' }, answers), /no such value/)
  assert.throws(() => resolveRefs({ scopeId: '$7.scopeId' }, answers), /no such value/)
})

test('a batch needs a session and refuses to nest', async () => {
  const { callTool, startSession } = await import('./index.mjs')
  await assert.rejects(callTool('redbeam_batch', { calls: [{ tool: 'redbeam_get_ui_state' }] }), /redbeam_start_session/)
  const session = startSession('Batch check')
  await assert.rejects(callTool('redbeam_batch', { session, calls: [] }), /calls/)
  const out = await callTool('redbeam_batch', { session, calls: [{ tool: 'redbeam_batch', arguments: { calls: [] } }, { tool: 'redbeam_get_ui_state' }] })
  assert.equal(out.structuredContent.ran, 1)
  assert.equal(out.structuredContent.of, 2)
  assert.match(out.structuredContent.results[0].error, /cannot run inside a batch/)
  assert.equal(out.isError, true)
})
