import { describe, expect, it } from 'vitest'
import { scrub, topFrames } from './scrub.js'
import { ClickBurst, RAGE_CLICKS } from './friction.js'
import { Signals, Tally, provideNames, signalName, type Channel, type Row } from './signals.js'

describe('scrub', () => {
  it('takes out the names of what is open', () => {
    const s = scrub('Could not save Hyundai Capital RCP: open in Bluebeam', ['C:/Jobs/Hyundai Capital RCP.pdf'])
    expect(s).not.toMatch(/Hyundai/)
    expect(s).toContain('‹name›')
  })

  it('takes out paths, PDFs, quoted text, e-mail and numbers', () => {
    const cases = [
      String.raw`C:\Users\aaron\Maxxit Group\Tender Docs\A-201.pdf is open in another app`,
      String.raw`\\server\share\Bids\x.pdf`,
      'Edge case 2 - Kenneth’s long file name.pdf could not be read',
      'scope "CL03 – Armstrong Optima" has no product',
      'sent by kenneth@maxxit.example',
      '/home/aaron/jobs/nokia/plan.pdf',
    ]
    for (const c of cases) {
      const s = scrub(c)
      expect(s, c).not.toMatch(/aaron|Maxxit|Tender|A-201|server|Kenneth|Armstrong|kenneth|nokia/i)
    }
  })

  it('keeps the shape, so one cause groups as one', () => {
    expect(scrub('sheet 12 has no scale')).toBe(scrub('sheet 13 has no scale'))
    expect(scrub('could not read the text layer')).toBe('could not read the text layer')
  })

  it('keeps contractions', () => {
    expect(scrub("the PDF isn't writable")).toBe("the PDF isn't writable")
  })

  it('reads the first frames of a stack without the host', () => {
    const stack = 'TypeError: x\n    at draw (http://tauri.localhost/assets/index-3f9.js:12:345)\n    at paint (http://tauri.localhost/assets/index-3f9.js:9:1)\n    at more'
    const top = topFrames(stack)
    expect(top).not.toContain('tauri.localhost')
    expect(top).toContain('draw')
    expect(top.split(' < ')).toHaveLength(2)
  })
})

describe('Tally', () => {
  it('folds identical events into one row with a count and times', () => {
    const t = new Tally()
    t.add('save', 'auto:failed', 'locked', 100, 'a')
    t.add('save', 'auto:failed', 'locked', 300, 'b')
    t.add('save', 'auto:written', '', 50, 'b')
    const { rows } = t.take()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ count: 2, ms_sum: 400, ms_max: 300, first_at: 'a', last_at: 'b' })
    expect(t.size).toBe(0)
  })

  it('counts new causes it has no room for instead of growing', () => {
    const t = new Tally(2)
    t.add('error', 'a', '', null, 'x')
    t.add('error', 'b', '', null, 'x')
    t.add('error', 'c', '', null, 'x')
    t.add('error', 'a', '', null, 'x')
    const out = t.take()
    expect(out.rows).toHaveLength(2)
    expect(out.dropped).toBe(1)
  })
})

describe('signalName', () => {
  it('stays inside the Worker’s vocabulary', () => {
    expect(signalName('abandon:draw-area')).toBe('abandon:draw-area')
    expect(signalName('get lines / fast')).toBe('get-lines-fast')
    expect(signalName('')).toBe('unnamed')
  })
})

type Held = { rows: Row[]; dropped: number } | null
type TestChannel = Channel & { sent: string[]; held: Held }
function channel(over: Partial<Channel> = {}): TestChannel {
  const c: TestChannel = {
    sent: [],
    held: null,
    enabled: () => true,
    endpoint: 'https://u.example/signals',
    version: '0.3.96',
    os: 'Windows 11',
    install: () => '0b6f2a1e-4c1d-4f8a-9a55-3f0e2b9d1c11',
    async send(_url: string, body: string) { c.sent.push(body); return true },
    load: (): Held => c.held,
    save(h: Held) { c.held = h },
    now: () => new Date('2026-11-26T12:00:00Z'),
    ...over,
  }
  return c
}

describe('Signals', () => {
  it('sends a batch with no names in it', async () => {
    const c = channel()
    const s = new Signals(c)
    const stop = provideNames(() => ['Nokia North Campus.pdf'])
    s.record('save', 'manual:failed', 'Nokia North Campus.pdf is open in Bluebeam')
    stop()
    await s.flush()
    expect(c.sent).toHaveLength(1)
    const body = JSON.parse(c.sent[0]!)
    expect(body).toMatchObject({ v: 1, version: '0.3.96', rows: [{ kind: 'save', name: 'manual:failed', count: 1 }] })
    expect(c.sent[0]).not.toMatch(/Nokia/)
  })

  it('records nothing and sends nothing with sharing off', async () => {
    const c = channel({ enabled: () => false })
    const s = new Signals(c)
    s.record('error', 'x')
    await s.flush()
    expect(c.sent).toHaveLength(0)
  })

  it('keeps what it could not send, and sends it next launch', async () => {
    const c = channel({ async send() { return false } })
    const s = new Signals(c)
    s.record('friction', 'rage-click', 'Calibrate')
    await s.flush()
    expect(c.held?.rows).toHaveLength(1)
    const next = channel()
    next.held = c.held
    const again = new Signals(next)
    await again.flush()
    expect(JSON.parse(next.sent[0]!).rows[0]).toMatchObject({ name: 'rage-click', detail: 'Calibrate' })
    expect(next.held).toBeNull()
  })

  it('throws away what is held when sharing is turned off', async () => {
    let on = true
    const c = channel({ enabled: () => on })
    const s = new Signals(c)
    s.record('error', 'x')
    on = false
    await s.flush()
    on = true
    await s.flush()
    expect(c.sent).toHaveLength(0)
  })
})

describe('ClickBurst', () => {
  it('fires once per burst of rapid clicks on one control', () => {
    const b = new ClickBurst()
    const fired = []
    for (let i = 0; i < RAGE_CLICKS + 3; i++) fired.push(b.click('Calibrate', i * 100))
    expect(fired.filter(Boolean)).toHaveLength(1)
    expect(fired[RAGE_CLICKS - 1]).toBe(true)
  })

  it('does not fire for slow or alternating clicks', () => {
    const b = new ClickBurst()
    expect([0, 2000, 4000, 6000].map((t) => b.click('Save', t)).some(Boolean)).toBe(false)
    expect([0, 10, 20, 30, 40].map((t, i) => b.click(i % 2 === 0 ? 'A' : 'B', t)).some(Boolean)).toBe(false)
  })
})
