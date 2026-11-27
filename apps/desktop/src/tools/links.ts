/**
 * Links made in REDBEAM: a box on one sheet that jumps to another (Kenneth,
 * 2026-11-26, item 12).
 *
 * A link is a markup of kind `link` with no scope. `rings[0]` is its box, four
 * corners TL, TR, BR, BL, normalized like every markup; `content` names the
 * page it goes to. Being a markup is what gives it select, move, delete, undo
 * and copy for nothing, and what carries it in the PDF's takeoff slice. On
 * save it is ALSO written as a real /Link annotation (export/sheetEmbed.ts),
 * so Bluebeam, Acrobat and a browser follow it too.
 *
 * Two ways to make one: the Link tool (drag a box, pick the sheet), and
 * "Link detail callouts" (tools/callouts.ts), which finds them and asks.
 */
import type { Markup } from '@redbeam/domain'

/** What a link markup carries in `content`. */
export interface LinkContent {
  /** Zero-based page it jumps to, in the same PDF. */
  toPage: number
  /** How it was made: drawn with the tool, or found on a callout. */
  source: 'drawn' | 'callout'
  /** The words it sits on, when it was found from them ("3/A5.01"). */
  text?: string
}

export type LinkMarkup = Markup & { kind: 'link'; content: LinkContent }

/** A link's content, or null when the markup is not a usable link. */
export function linkContentOf(m: Markup): LinkContent | null {
  if (m.kind !== 'link') return null
  const c = (m as { content?: Record<string, unknown> }).content
  const to = c?.['toPage']
  if (typeof to !== 'number' || !Number.isInteger(to) || to < 0) return null
  const text = c?.['text']
  return { toPage: to, source: c?.['source'] === 'callout' ? 'callout' : 'drawn', ...(typeof text === 'string' && text !== '' ? { text } : {}) }
}

/** A box as a ring, TL, TR, BR, BL. */
export function boxRing(r: { x0: number; y0: number; x1: number; y1: number }): Array<{ x: number; y: number }> {
  const x0 = Math.min(r.x0, r.x1), x1 = Math.max(r.x0, r.x1)
  const y0 = Math.min(r.y0, r.y1), y1 = Math.max(r.y0, r.y1)
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]
}

/** A ring's bounding box. */
export function ringBox(ring: ReadonlyArray<{ x: number; y: number }>): { x0: number; y0: number; x1: number; y1: number } {
  const xs = ring.map((p) => p.x), ys = ring.map((p) => p.y)
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
}

/**
 * This page's REDBEAM links in the viewer's link shape, so a click follows
 * them exactly as it follows the PDF's own (viewer `linkAt`).
 */
export function pageLinksFrom(markups: readonly Markup[], pageId: string): Array<{ rect: { x0: number; y0: number; x1: number; y1: number }; page: number }> {
  const out: Array<{ rect: { x0: number; y0: number; x1: number; y1: number }; page: number }> = []
  for (const m of markups) {
    if (m.pageId !== pageId) continue
    const c = linkContentOf(m)
    const ring = m.rings[0]
    if (c === null || ring === undefined || ring.length < 2) continue
    out.push({ rect: ringBox(ring), page: c.toPage })
  }
  return out
}

/** Sheet numbers compared the way people write them: case, spaces and a trailing stop ignored. */
export function sheetKey(s: string): string {
  return s.toUpperCase().replace(/\s+/g, '').replace(/^[([{]+|[)\]}.,;:]+$/g, '')
}

/**
 * The sheets a box most likely points at, best first, from the words inside
 * it: a sheet number among them goes to the top. Used to pre-pick the Link
 * tool's target, so a box over "A5.01" asks nothing but a confirmation.
 */
export function suggestTargets(
  words: ReadonlyArray<{ text: string }>,
  sheets: ReadonlyArray<{ page: number; number: string }>,
  fromPage: number,
): number[] {
  const byKey = new Map<string, number>()
  for (const s of sheets) {
    const k = sheetKey(s.number)
    if (k !== '' && !/^PAGE\d+$/.test(k) && !byKey.has(k)) byKey.set(k, s.page)
  }
  const out: number[] = []
  for (const w of words) {
    for (const part of w.text.split('/')) {
      const p = byKey.get(sheetKey(part))
      if (p !== undefined && p !== fromPage && !out.includes(p)) out.push(p)
    }
  }
  return out
}
