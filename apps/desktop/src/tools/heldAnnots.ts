/**
 * Other apps' markups held where they are (`annot` markups, export/adopt.ts):
 * what the viewer's copy of the PDF needs to show them moved and recoloured,
 * and the colours offered for them.
 *
 * Kenneth, 2026-11-26: Bluebeam's dimensions, clouds, text and arrows could
 * only be hidden. Each is now a markup that selects, drags, recolours and
 * deletes like REDBEAM's own, while the PDF goes on drawing the annotation
 * itself, so it looks exactly as Bluebeam drew it.
 */
import type { Markup } from '@redbeam/domain'
import type { AnnotEdit } from '@redbeam/viewer'

interface HeldContent {
  adopted?: { nm?: unknown }
  annot?: { color?: unknown, fileColor?: unknown, ap?: unknown, subtype?: unknown }
  subject?: unknown
  subtype?: unknown
}

const contentOf = (m: Markup): HeldContent =>
  ((m as Markup & { content?: unknown }).content ?? {}) as HeldContent

/** The /NM a held markup stands for, or null for any other markup. */
export function heldNmOf(m: Markup): string | null {
  if (m.kind !== 'annot') return null
  const nm = contentOf(m).adopted?.nm
  // A copy Revu gave the same /NM as copies on other pages is keyed "NM@p3".
  return typeof nm === 'string' && nm !== '' ? nm.replace(/@p\d+$/, '') : null
}

const hex = (v: unknown): string | null => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null)

/** A held markup's colour now: changed here, or as the file has it. */
export function heldColorOf(m: Markup): string | null {
  const a = contentOf(m).annot
  return hex(a?.color) ?? hex(a?.fileColor)
}

/** What a held markup is, in words: "Cloud", "FreeText “Note”". */
export function heldLabelOf(m: Markup): string {
  const c = contentOf(m)
  const subject = typeof c.subject === 'string' ? c.subject.trim() : ''
  const subtype = typeof c.annot?.subtype === 'string' ? c.annot.subtype : typeof c.subtype === 'string' ? c.subtype : ''
  if (subject !== '') return subject
  return subtype === 'FreeText' ? 'Text box' : subtype === '' ? 'PDF markup' : subtype
}

function boxOf(m: Markup): AnnotEdit['rect'] | null {
  const ring = m.rings[0]
  if (ring === undefined || ring.length === 0) return null
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of ring) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y)
  }
  return Number.isFinite(x0) && Number.isFinite(y1) ? { x0, y0, x1, y1 } : null
}

/** A held markup's place and colour as one comparable string. */
export function heldStateKey(m: Markup): string {
  const b = boxOf(m)
  const r = (n: number) => n.toFixed(6)
  return `${b === null ? '' : [b.x0, b.y0, b.x1, b.y1].map(r).join(',')}|${heldColorOf(m) ?? ''}`
}

function apOf(m: Markup): AnnotEdit['ap'] | undefined {
  const ap = contentOf(m).annot?.ap as { bbox?: unknown, matrix?: unknown, alpha?: unknown } | null | undefined
  if (ap === null || ap === undefined || !Array.isArray(ap.bbox) || ap.bbox.length !== 4) return undefined
  const nums = (v: unknown[]) => v.every((n) => typeof n === 'number' && Number.isFinite(n))
  if (!nums(ap.bbox)) return undefined
  const matrix = Array.isArray(ap.matrix) && ap.matrix.length === 6 && nums(ap.matrix) ? ap.matrix as number[] : null
  const alpha = typeof ap.alpha === 'number' && ap.alpha >= 0 && ap.alpha <= 1 ? ap.alpha : 1
  return { bbox: ap.bbox as number[], matrix, alpha }
}

/**
 * The edits the viewer should show for a page's live held markups: every one
 * moved or recoloured since the file was opened, and every one that ever was
 * (so an undo back to where it started is shown too). `open` is each
 * markup's state when opened, by id; `changed` collects the ids that left it.
 */
export function heldEditsFor(live: readonly Markup[], open: Map<string, string>, changed: Set<string>): AnnotEdit[] {
  const out: AnnotEdit[] = []
  for (const m of live) {
    const nm = heldNmOf(m)
    const rect = boxOf(m)
    if (nm === null || rect === null) continue
    const key = heldStateKey(m)
    const was = open.get(m.id)
    if (was === undefined) { open.set(m.id, key); continue }
    if (was !== key) changed.add(m.id)
    if (!changed.has(m.id)) continue
    const ap = apOf(m)
    out.push({ nm, rect, color: heldColorOf(m), ...(ap === undefined ? {} : { ap }) })
  }
  return out
}

/** Colours offered for a held markup: Bluebeam's own defaults, then black. */
export const HELD_COLORS: ReadonlyArray<{ hex: string, name: string }> = [
  { hex: '#ff0000', name: 'Red' },
  { hex: '#ff8000', name: 'Orange' },
  { hex: '#e6c700', name: 'Yellow' },
  { hex: '#00a000', name: 'Green' },
  { hex: '#0070ff', name: 'Blue' },
  { hex: '#8000ff', name: 'Purple' },
  { hex: '#ff00ff', name: 'Magenta' },
  { hex: '#000000', name: 'Black' },
]
