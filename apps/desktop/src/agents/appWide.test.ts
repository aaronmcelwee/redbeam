import { beforeEach, describe, expect, it } from 'vitest'
import { agentDraft, agentSuggestion, forgetSentReports, reportForAgent, suggestForAgent, whatsNewForAgent } from './appWide.js'
import { parseChangelog } from '../whatsnew/changelog.js'
import type { ReportPayload } from '../report/report.js'

const ctx = async (where: string) => ({ version: '0.3.200', machine: 'x64' as const, os: 'Windows 11', where })

describe('an agent reports a bug', () => {
  beforeEach(() => forgetSentReports())

  it('sends the report the form sends, marked as from an AI agent, without the session name', async () => {
    const sentBodies: ReportPayload[] = []
    const out = await reportForAgent({
      params: { kind: 'quantity', summary: 'Trim count doubles on A-101', details: 'get_bom said 24; the room needs 12' },
      app: 'Claude', agentId: 'srv/1', where: 'Tender.pdf · A-101', context: ctx,
      send: async (p) => { sentBodies.push(p); return { ok: true, id: 'abc', filed: 'kept' } },
    })
    expect(out).toMatchObject({ sent: true, id: 'abc', kind: 'quantity', where: 'Tender.pdf · A-101', screenshot: 'none' })
    expect(sentBodies).toHaveLength(1)
    expect(sentBodies[0]!.details).toBe("get_bom said 24; the room needs 12\n\nReported by an AI agent (Claude) through REDBEAM's agent tools.")
    expect(sentBodies[0]!.where).toBe('Tender.pdf · A-101')
    expect(sentBodies[0]!.version).toBe('0.3.200')
  })

  it('leaves where out when asked, and attaches a picture when asked', async () => {
    let body: ReportPayload | null = null
    const out = await reportForAgent({
      params: { summary: 'Screenshot came back blank', includeWhere: false, screenshot: true },
      app: null, agentId: null, where: 'Tender.pdf · A-101', context: ctx,
      picture: async () => 'data:image/jpeg;base64,AAAA',
      send: async (p) => { body = p; return { ok: true, id: 'x', filed: 'kept' } },
    })
    expect(out).toMatchObject({ sent: true, where: null, screenshot: 'attached' })
    expect(body!.where).toBe('')
    expect(body!.screenshot).toBe('data:image/jpeg;base64,AAAA')
    expect(body!.kind).toBe('broke')
  })

  it('sends the same summary once per session', async () => {
    let calls = 0
    const send = async () => { calls++; return { ok: true as const, id: `id${calls}`, filed: 'kept' as const } }
    const one = { params: { summary: 'Save failed' }, app: 'Claude', agentId: 'a', where: '', context: ctx, send }
    await reportForAgent(one)
    const again = await reportForAgent({ ...one, params: { summary: 'save failed ' } })
    expect(again).toMatchObject({ duplicate: true, id: 'id1' })
    await reportForAgent({ ...one, agentId: 'b' })
    expect(calls).toBe(2)
  })

  it('refuses a report with nothing to say or an unknown kind, and passes a failed send on', async () => {
    expect(agentDraft({}, null)).toEqual({ error: '`summary` is required: what happened, in one sentence' })
    expect(agentDraft({ summary: 'x', kind: 'angry' }, null)).toMatchObject({ error: expect.stringContaining('kind must be one of') })
    const out = await reportForAgent({
      params: { summary: 'Offline' }, app: null, agentId: null, where: '', context: ctx,
      send: async () => ({ ok: false, reason: 'REDBEAM could not reach the report service.' }),
    })
    expect(out).toEqual({ error: 'REDBEAM could not reach the report service.' })
  })
})

describe('an agent reads what is new', () => {
  const releases = parseChangelog([
    '# Changelog', '', '## 0.3.3 — 2026-11-27', '- Third', '', '## 0.3.2 — 2026-11-26', '### Fixed', '- Second',
    '', '## 0.3.1 — 2026-11-25', '- First', '',
  ].join('\n'))

  it('gives the latest releases up to the running one, newest first', () => {
    const out = whatsNewForAgent({ limit: 2 }, releases, '0.3.2') as { version: string; releases: Array<{ version: string; notes: string }> }
    expect(out.version).toBe('0.3.2')
    expect(out.releases.map((r) => r.version)).toEqual(['0.3.2', '0.3.1'])
    expect(out.releases[0]!.notes).toBe('## Fixed\n- Second')
  })

  it('gives every release after `since`', () => {
    const out = whatsNewForAgent({ since: 'v0.3.1' }, releases, '0.3.3') as { releases: Array<{ version: string }> }
    expect(out.releases.map((r) => r.version)).toEqual(['0.3.3', '0.3.2'])
    expect(whatsNewForAgent({ since: 'last week' }, releases, '0.3.3')).toMatchObject({ error: expect.any(String) })
  })
})

describe('an agent suggests a skill improvement', () => {
  beforeEach(() => forgetSentReports())

  it('sends a skill suggestion for the named skill, with the wording and the reason', async () => {
    const bodies: ReportPayload[] = []
    const out = await suggestForAgent({
      params: {
        skill: 'precon-takeoff', summary: 'Read the RCP legend before counting fixtures',
        suggestion: 'Before any count, list every legend symbol with its tag.', why: 'I counted diffusers as lights on A-201.',
      },
      app: 'Claude', agentId: 'srv/1', where: 'Tender.pdf · A-201', context: ctx,
      send: async (p) => { bodies.push(p); return { ok: true, id: 'sg1', filed: 'kept' } },
    })
    expect(out).toMatchObject({ sent: true, id: 'sg1', skill: 'precon-takeoff', where: 'Tender.pdf · A-201' })
    expect(bodies[0]!.kind).toBe('skill')
    expect(bodies[0]!.skill).toBe('precon-takeoff')
    expect(bodies[0]!.screenshot).toBeNull()
    expect(bodies[0]!.details).toBe(
      "Suggested wording:\nBefore any count, list every legend symbol with its tag.\n\nWhy:\nI counted diffusers as lights on A-201.\n\nSuggested by an AI agent (Claude) through REDBEAM's agent tools.",
    )
  })

  it('leaves the skill to the reviewer when not named, and refuses one it does not know', () => {
    const d = agentSuggestion({ summary: 'Ask for the addenda first' }, null)
    expect('error' in d ? null : d.skill).toBe('unsure')
    expect(agentSuggestion({ skill: 'estimating', summary: 'x' }, null)).toMatchObject({ error: expect.stringMatching(/^skill must be one of/) })
    expect(agentSuggestion({ skill: 'precon-intake' }, null)).toMatchObject({ error: expect.stringMatching(/summary/) })
  })

  it('sends the same suggestion once per session, apart from a bug report with the same words', async () => {
    let calls = 0
    const send = async () => { calls++; return { ok: true as const, id: `i${calls}`, filed: 'kept' as const } }
    const input = { params: { summary: 'Same words' }, app: null, agentId: 'a', where: '', context: ctx, send }
    await suggestForAgent(input)
    expect(await suggestForAgent(input)).toMatchObject({ duplicate: true, id: 'i1' })
    await reportForAgent(input)
    expect(calls).toBe(2)
  })
})
