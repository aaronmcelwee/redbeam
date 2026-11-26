import { describe, expect, it } from 'vitest'
import { aggregate, digestFor, fileSignals, fingerprint, isFailure, issueFor, lastDays, newer } from '../file-signals.mjs'

const A = '0b6f2a1e-4c1d-4f8a-9a55-3f0e2b9d1c11'
const B = '7d1c9e40-2b3a-4c5d-8e6f-112233445566'

function batch(install: string, version: string, rows: unknown[]) {
  return { id: 'x', received_at: '2026-11-26T12:00:00Z', version, os: 'Windows 11', install, session: install, dropped: 0, rows }
}
const r = (kind: string, name: string, detail = '', count = 1, ms = 0) =>
  ({ kind, name, detail, count, ms_sum: ms * count, ms_max: ms, first_at: '2026-11-26T10:00:00Z', last_at: '2026-11-26T11:00:00Z' })

describe('aggregate', () => {
  it('groups one cause across installs and versions', () => {
    const agg = aggregate([
      batch(A, '0.3.96', [r('save', 'auto:failed', 'the PDF is open in ‹text›', 2), r('app', 'launch')]),
      batch(B, '0.3.97', [r('save', 'auto:failed', 'the PDF is open in ‹text›', 1), r('friction', 'rage-click', 'Calibrate', 3)]),
    ])
    expect(agg.installs).toBe(2)
    const save = agg.causes.find((c: { name: string }) => c.name === 'auto:failed')
    expect(save.count).toBe(3)
    expect(save.installs.size).toBe(2)
    expect(save.latest).toBe('0.3.97')
    expect(agg.causes[0].name).toBe('auto:failed') // two installs outrank one
  })
})

describe('rules', () => {
  it('files failures and digests the rest', () => {
    expect(isFailure(r('error', 'render:TypeError'))).toBe(true)
    expect(isFailure(r('save', 'manual:failed'))).toBe(true)
    expect(isFailure(r('save', 'auto:written'))).toBe(false)
    expect(isFailure(r('command', 'failed:delete_markup'))).toBe(true)
    expect(isFailure(r('agent', 'get_lines:failed'))).toBe(false)
    expect(isFailure(r('friction', 'rage-click'))).toBe(false)
  })

  it('compares versions as numbers', () => {
    expect(newer('0.3.100', '0.3.99')).toBe(true)
    expect(newer('0.3.9', '0.3.10')).toBe(false)
  })

  it('reads seven days ending today', () => {
    expect(lastDays(new Date('2026-11-26T05:00:00Z'))).toEqual(
      ['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26'])
  })

  it('fences the detail and marks the issue', () => {
    const [c] = aggregate([batch(A, '0.3.96', [r('error', 'render:TypeError', 'x @ y')])]).causes
    const issue = issueFor(c)
    expect(issue.body).toContain(`<!-- redbeam-signal:${fingerprint(c)} -->`)
    expect(issue.body).toContain('```text\nx @ y\n```')
    expect(issue.body).toContain('Last seen on REDBEAM 0.3.96')
  })

  it('keeps @ and # out of the digest table', () => {
    const agg = aggregate([batch(A, '0.3.96', [r('friction', 'rage-click', 'ask @someone about #12')])])
    expect(digestFor(agg).body).not.toMatch(/[^`]@someone/)
  })
})

describe('fileSignals', () => {
  function fake(issues: Array<Record<string, unknown>>) {
    const calls: Array<{ url: string; method: string; body: unknown }> = []
    const fetchImpl = async (url: string, init: { method?: string; body?: string } = {}) => {
      const method = init.method ?? 'GET'
      calls.push({ url, method, body: init.body === undefined ? null : JSON.parse(init.body) })
      const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
      if (url.includes('/signals/day/2026-11-26')) {
        return ok({ batches: [batch(A, '0.3.98', [r('error', 'render:TypeError', 'boom'), r('friction', 'undo-soon', 'create_markup')])], after: null })
      }
      if (url.includes('/signals/day/')) return ok({ batches: [], after: null })
      if (url.endsWith('/labels')) return ok({}, 422)
      if (url.includes('/issues?labels=')) return ok(issues)
      if (method === 'POST' && url.endsWith('/issues')) return ok({ html_url: 'https://github.com/o/r/issues/9' }, 201)
      return ok({ html_url: 'https://github.com/o/r/issues/1' })
    }
    return { calls, fetchImpl }
  }
  const opts = { endpoint: 'https://u.example', syncKey: 'k', repo: 'o/r', token: 't', now: new Date('2026-11-26T20:00:00Z'), log: () => {} }

  it('opens an issue for a new failure and writes the digest', async () => {
    const f = fake([])
    const out = await fileSignals({ ...opts, fetchImpl: f.fetchImpl })
    expect(out.opened).toHaveLength(1)
    const posts = f.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/issues'))
    expect(posts).toHaveLength(2) // the failure and the digest
    expect(JSON.stringify(posts[1]!.body)).toContain('undo-soon')
  })

  it('reopens a closed failure only when a newer build hits it', async () => {
    const [c] = aggregate([batch(A, '0.3.98', [r('error', 'render:TypeError', 'boom')])]).causes
    const closed = { number: 4, state: 'closed', title: 't', body: `<!-- redbeam-signal:${fingerprint(c)} -->\nLast seen on REDBEAM 0.3.97`, html_url: 'u4' }
    const f = fake([closed])
    const out = await fileSignals({ ...opts, fetchImpl: f.fetchImpl })
    expect(out.reopened).toEqual(['u4'])

    const same = fake([{ ...closed, body: closed.body.replace('0.3.97', '0.3.98') }])
    const again = await fileSignals({ ...opts, fetchImpl: same.fetchImpl })
    expect(again.reopened).toHaveLength(0)
    expect(again.opened).toHaveLength(0)
  })
})
