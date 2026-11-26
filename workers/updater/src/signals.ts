/**
 * Anonymous error and UX signals from the app.
 *
 * Where a bug report is something a person writes, a signal is something the
 * app counts on its own: an uncaught error, a save the PDF refused, an agent
 * tool call that failed or ran long, a slow tile, an undo straight after an
 * action, a dialog closed without being used, a button clicked over and over,
 * a shape abandoned half drawn. None of those reach a bug report, and
 * together they are where the paper cuts are.
 *
 * POST /signals takes one batch. The app has already folded identical events
 * into one row with a count, and has already taken every file name, path,
 * quoted text and number out of what it sends (apps/desktop/src/signals).
 * This side checks the shape again and keeps the batch in R2 under
 * `signals/<day>/<uuid>.json`. Nothing here is a person's work: a batch is
 * the app version, the kind of Windows, a random id for the install and the
 * launch, and rows of {kind, name, detail, count, ms}.
 *
 * GET /signals/day/<YYYY-MM-DD> hands a day's batches to the Signals
 * workflow, which proves itself with SYNC_KEY like the report inbox does.
 *
 * No Cloudflare types and no globals beyond crypto, so this is tested with
 * plain objects.
 */

export const SIGNAL_KINDS = ['app', 'error', 'save', 'agent', 'slow', 'friction', 'command'] as const
export type SignalKind = (typeof SIGNAL_KINDS)[number]

export interface SignalRow {
  kind: SignalKind
  /** What happened, from a fixed vocabulary the app writes: "rage-click", "auto:failed", "get_lines". */
  name: string
  /** Scrubbed text that tells two causes apart: an error message, a button's label. */
  detail: string
  count: number
  ms_sum: number
  ms_max: number
  first_at: string
  last_at: string
}

export interface SignalBatch {
  version: string
  os: string
  install: string
  session: string
  /** Rows the app could not keep while it was offline, counted rather than sent. */
  dropped: number
  rows: SignalRow[]
}

/** A body larger than this is refused unread. A busy day folds to a few KB. */
export const MAX_SIGNAL_BYTES = 256 * 1024
/** A day's batches handed out per GET. Each is one R2 read, well inside a free Worker's budget. */
export const SIGNAL_PAGE = 50

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const NAME = /^[A-Za-z0-9_.:\-]{1,80}$/
export const SIGNAL_DAY = /^\d{4}-\d{2}-\d{2}$/

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

function whole(value: unknown, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0
  return Math.min(max, Math.max(0, n))
}

function when(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const t = Date.parse(value)
  return Number.isNaN(t) ? fallback : new Date(t).toISOString()
}

/** One row, or null when it is not one. A bad row is dropped, not the batch. */
export function parseRow(value: unknown, at: string): SignalRow | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const o = value as Record<string, unknown>
  const kind = SIGNAL_KINDS.find((k) => k === o['kind'])
  if (kind === undefined) return null
  const name = typeof o['name'] === 'string' && NAME.test(o['name']) ? o['name'] : null
  if (name === null) return null
  const count = whole(o['count'], 1_000_000)
  if (count < 1) return null
  const msMax = whole(o['ms_max'], 86_400_000)
  return {
    kind,
    name,
    detail: text(o['detail'], 300),
    count,
    ms_sum: whole(o['ms_sum'], Number.MAX_SAFE_INTEGER),
    ms_max: msMax,
    first_at: when(o['first_at'], at),
    last_at: when(o['last_at'], at),
  }
}

/** The request body as a batch, or the reason it is not one. */
export function parseBatch(body: unknown, at: Date): SignalBatch | string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'body must be a JSON object'
  const o = body as Record<string, unknown>
  if (o['v'] !== 1) return 'v must be 1'
  const install = typeof o['install'] === 'string' && ID.test(o['install']) ? o['install'] : null
  const session = typeof o['session'] === 'string' && ID.test(o['session']) ? o['session'] : null
  if (install === null || session === null) return 'install and session must be random UUIDs'
  if (!Array.isArray(o['rows'])) return 'rows must be a list'
  const iso = at.toISOString()
  const rows = o['rows'].map((r) => parseRow(r, iso)).filter((r): r is SignalRow => r !== null)
  if (rows.length === 0) return 'no usable rows'
  return {
    version: text(o['version'], 32) || 'unknown',
    os: text(o['os'], 40),
    install,
    session,
    dropped: whole(o['dropped'], 1_000_000),
    rows,
  }
}

/** `signals/2026-11-26/<id>.json`: one day's batches list together. */
export function signalKey(id: string, at: Date): string {
  return `signals/${at.toISOString().slice(0, 10)}/${id}.json`
}

export function storedBatch(batch: SignalBatch, id: string, at: Date) {
  return { id, received_at: at.toISOString(), ...batch }
}
