/**
 * Anonymous error and UX signals.
 *
 * Bug reports catch what a person stops to write down. Most of what makes an
 * app feel rough never gets that far: a save the PDF refused, an agent's tool
 * call that failed, a tile that took two seconds, an undo straight after an
 * action, a dialog closed without being used, a button clicked five times. This
 * counts those, folds identical ones into one row, and every few minutes posts
 * the rows to the update Worker (POST /signals), which is the one host every
 * copy already talks to. A nightly workflow groups them by cause, opens an
 * issue for each real failure and keeps a digest of the paper cuts.
 *
 * What leaves the machine: the app version, the kind of Windows, a random id
 * for this install and one for this launch, and rows of
 * {kind, name, detail, count, ms}. `name` is from a fixed vocabulary written
 * in this codebase. `detail` is scrubbed (scrub.ts): no file or project
 * names, no paths, no quoted text, no numbers. No drawing, markup, quantity,
 * screenshot or keystroke is ever recorded.
 *
 * Settings › General › "Send anonymous usage signals" turns it off, and off
 * also throws away anything not yet sent.
 *
 * It never blocks and never takes focus: recording is a Map update, sending
 * is a background fetch, and a failed send keeps the rows for next time.
 */
import { scrub, topFrames } from './scrub.js'

export type SignalKind = 'app' | 'error' | 'save' | 'agent' | 'slow' | 'friction' | 'command'

export interface Row {
  kind: SignalKind
  name: string
  detail: string
  count: number
  ms_sum: number
  ms_max: number
  first_at: string
  last_at: string
}

export interface Batch {
  v: 1
  version: string
  os: string
  install: string
  session: string
  dropped: number
  rows: Row[]
}

/** Names must stay inside the Worker's vocabulary: letters, digits and `_.:-`. */
export function signalName(raw: string): string {
  const n = raw.replace(/[^A-Za-z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
  return n === '' ? 'unnamed' : n
}

/**
 * The rows waiting to go, folded by (kind, name, detail).
 *
 * Pure apart from the clock it is handed, so the folding and the bound are
 * tested without a window.
 */
export class Tally {
  private rows = new Map<string, Row>()
  dropped = 0

  /** Rows held before new kinds of row are counted instead of kept. Known rows still count up. */
  constructor(readonly room = 400) {}

  get size(): number { return this.rows.size }

  add(kind: SignalKind, name: string, detail: string, ms: number | null, at: string): void {
    const key = `${kind}\u0000${name}\u0000${detail}`
    const row = this.rows.get(key)
    const t = ms === null || !Number.isFinite(ms) ? 0 : Math.max(0, Math.round(ms))
    if (row !== undefined) {
      row.count += 1
      row.ms_sum += t
      row.ms_max = Math.max(row.ms_max, t)
      row.last_at = at
      return
    }
    if (this.rows.size >= this.room) { this.dropped += 1; return }
    this.rows.set(key, { kind, name, detail, count: 1, ms_sum: t, ms_max: t, first_at: at, last_at: at })
  }

  /** Fold rows kept from an earlier launch back in. */
  merge(rows: readonly Row[], dropped = 0): void {
    this.dropped += dropped
    for (const r of rows) {
      const key = `${r.kind}\u0000${r.name}\u0000${r.detail}`
      const row = this.rows.get(key)
      if (row !== undefined) {
        row.count += r.count
        row.ms_sum += r.ms_sum
        row.ms_max = Math.max(row.ms_max, r.ms_max)
        if (r.first_at < row.first_at) row.first_at = r.first_at
        if (r.last_at > row.last_at) row.last_at = r.last_at
      } else if (this.rows.size < this.room) {
        this.rows.set(key, { ...r })
      } else {
        this.dropped += r.count
      }
    }
  }

  /** Everything held, kept. */
  snapshot(): { rows: Row[]; dropped: number } {
    return { rows: [...this.rows.values()].map((r) => ({ ...r })), dropped: this.dropped }
  }

  /** Everything held, and start again. */
  take(): { rows: Row[]; dropped: number } {
    const out = { rows: [...this.rows.values()], dropped: this.dropped }
    this.rows = new Map()
    this.dropped = 0
    return out
  }
}

// ----------------------------------------------------------- the channel --

export interface Channel {
  /** Is sharing on? Read every time, so the switch takes effect at once. */
  enabled(): boolean
  endpoint: string | null
  version: string
  os: string
  /** A random id for this install, made once and kept. */
  install(): string
  send(url: string, body: string): Promise<boolean>
  /** Rows not sent when the app last closed or lost the connection. */
  load(): { rows: Row[]; dropped: number } | null
  save(held: { rows: Row[]; dropped: number } | null): void
  now(): Date
}

/** Rows that have reached this many distinct causes go at once rather than at the next tick. */
export const FLUSH_AT = 150
/** How often what has been counted is sent. */
export const FLUSH_EVERY_MS = 5 * 60_000

const NAMES = new Set<() => Iterable<string>>()

/**
 * Give the scrubber the names of what is open (files, the project) so they
 * are taken out of any message by name as well as by shape. Returns the undo.
 */
export function provideNames(get: () => Iterable<string>): () => void {
  NAMES.add(get)
  return () => { NAMES.delete(get) }
}

export function knownNames(): string[] {
  const out: string[] = []
  for (const get of NAMES) {
    try { for (const n of get()) out.push(n) } catch { /* a closing window */ }
  }
  return out
}

export class Signals {
  private readonly tally = new Tally()
  private readonly session = crypto.randomUUID()
  private sending = false

  constructor(private readonly channel: Channel) {
    const held = channel.load()
    if (held !== null && channel.enabled()) this.tally.merge(held.rows, held.dropped)
    channel.save(null)
  }

  /** Count one event. Never throws; a no-op with sharing off. */
  record(kind: SignalKind, name: string, detail = '', ms: number | null = null): void {
    try {
      if (!this.channel.enabled() || this.channel.endpoint === null) return
      this.tally.add(kind, signalName(name), scrub(detail, knownNames()), ms, this.channel.now().toISOString())
      if (this.tally.size >= FLUSH_AT) void this.flush()
    } catch { /* a counter must never be the thing that breaks */ }
  }

  /** An Error, an unhandled rejection's reason, or a panic's message. */
  error(name: string, err: unknown): void {
    const e = err instanceof Error ? err : null
    const message = e?.message ?? String(err)
    const names = knownNames()
    const where = e?.stack ? topFrames(e.stack, names) : ''
    this.record('error', `${name}:${e?.name ?? 'Error'}`, where === '' ? message : `${message} @ ${where}`)
  }

  /** Sharing was turned off: what was counted is thrown away, not sent later. */
  forget(): void {
    this.tally.take()
    this.channel.save(null)
  }

  /** Send what is held. Resolves once sent or kept for later. */
  async flush(opts: { closing?: boolean } = {}): Promise<void> {
    if (this.sending) return
    if (!this.channel.enabled() || this.channel.endpoint === null) { this.forget(); return }
    const held = this.tally.take()
    if (held.rows.length === 0 && held.dropped === 0) return
    const batch: Batch = {
      v: 1, version: this.channel.version, os: this.channel.os,
      install: this.channel.install(), session: this.session, dropped: held.dropped, rows: held.rows,
    }
    if (opts.closing === true) {
      // No time to wait for an answer: keep a copy, and the next launch sends
      // it if this one did not get out. A duplicate is cheaper than a loss.
      this.channel.save(held)
      void this.channel.send(this.channel.endpoint, JSON.stringify(batch)).then((ok) => { if (ok) this.channel.save(null) })
      return
    }
    this.sending = true
    let ok = false
    try { ok = await this.channel.send(this.channel.endpoint, JSON.stringify(batch)) } catch { ok = false }
    this.sending = false
    if (ok) {
      this.channel.save(null)
    } else {
      // Offline, or the Worker is down: fold them back, and keep a copy on
      // disk in case the app closes before the next try.
      this.tally.merge(held.rows, held.dropped)
      this.channel.save(this.tally.snapshot())
    }
  }
}
