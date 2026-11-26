/**
 * Changing another app's markup in place: its colour, and the appearance that
 * shows it.
 *
 * Kenneth, 2026-11-26: Bluebeam's dimensions, clouds, text and arrows "stay
 * flattened": they could be hidden for the session and nothing else. They are
 * annotations in the PDF, each with its own drawing (its appearance stream,
 * /AP), and REDBEAM now moves, recolours and deletes them as they are, so
 * Bluebeam opens the same markup it saved, only moved or recoloured.
 *
 * Moving needs no new drawing: an appearance is drawn into the annotation's
 * /Rect, so a shifted /Rect is a shifted drawing. Recolouring rewrites the
 * colour operators in the drawing that carry the markup's colour, and leaves
 * every other colour (a white text box, black dimension text) alone.
 *
 * Pure string work, shared by the viewer's worker (the copy on screen) and
 * the save (the copy in the file), and tested without either.
 */

/** A colour as PDF writes it, three components from 0 to 1. */
export type Rgb = [number, number, number]

export function hexToRgb(hex: string | null | undefined): Rgb | null {
  if (typeof hex !== 'string') return null
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (m === null) return null
  const n = parseInt(m[1]!, 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

export function rgbToHex(c: Rgb): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0')
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`
}

/** Within a rounding step of each other: 0.6 and 0.6000001, or #99 read back as 0.6. */
export function sameColor(a: Rgb, b: Rgb, tolerance = 0.02): boolean {
  return Math.abs(a[0] - b[0]) <= tolerance && Math.abs(a[1] - b[1]) <= tolerance && Math.abs(a[2] - b[2]) <= tolerance
}

const fmt = (v: number): string => {
  const s = (Math.round(v * 10000) / 10000).toFixed(4)
  return s.replace(/\.?0+$/, '') || '0'
}

const rgbOps = (c: Rgb): string => `${fmt(c[0])} ${fmt(c[1])} ${fmt(c[2])}`

// ----------------------------------------------------------- tokenizing --

interface Tok {
  start: number
  end: number
  kind: 'num' | 'op' | 'name' | 'other'
  text: string
}

const WS = new Set([' ', '\t', '\r', '\n', '\f', '\0'])
const DELIM = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%'])
const NUM = /^[+-]?(\d+\.?\d*|\.\d+)$/

/**
 * A content stream's tokens, with where each sits in the text. Null for a
 * stream with an inline image (BI … ID … EI): its binary data cannot be told
 * apart from operators, and such a drawing is left as it is.
 */
export function tokenize(s: string): Tok[] | null {
  const out: Tok[] = []
  let i = 0
  const n = s.length
  while (i < n) {
    const ch = s[i]!
    if (WS.has(ch)) { i++; continue }
    if (ch === '%') {
      while (i < n && s[i] !== '\n' && s[i] !== '\r') i++
      continue
    }
    const start = i
    if (ch === '(') {
      let depth = 0
      while (i < n) {
        const c = s[i]!
        if (c === '\\') { i += 2; continue }
        if (c === '(') depth++
        else if (c === ')') { depth--; if (depth === 0) { i++; break } }
        i++
      }
      out.push({ start, end: i, kind: 'other', text: s.slice(start, i) })
      continue
    }
    if (ch === '<' || ch === '>') {
      if (s[i + 1] === ch) { i += 2; out.push({ start, end: i, kind: 'other', text: s.slice(start, i) }); continue }
      if (ch === '<') {
        while (i < n && s[i] !== '>') i++
        i++
      } else i++
      out.push({ start, end: i, kind: 'other', text: s.slice(start, i) })
      continue
    }
    if (ch === '[' || ch === ']' || ch === '{' || ch === '}' || ch === ')') {
      i++
      out.push({ start, end: i, kind: 'other', text: ch })
      continue
    }
    if (ch === '/') {
      i++
      while (i < n && !WS.has(s[i]!) && !DELIM.has(s[i]!)) i++
      out.push({ start, end: i, kind: 'name', text: s.slice(start, i) })
      continue
    }
    while (i < n && !WS.has(s[i]!) && !DELIM.has(s[i]!)) i++
    const text = s.slice(start, i)
    if (text === 'BI') return null
    out.push({ start, end: i, kind: NUM.test(text) ? 'num' : 'op', text })
  }
  return out
}

// ---------------------------------------------------------- recolouring --

const STROKE_OPS = new Set(['RG', 'G', 'K', 'SC', 'SCN'])
const COLOR_OPS = new Set(['RG', 'rg', 'G', 'g', 'K', 'k', 'SC', 'sc', 'SCN', 'scn'])

function colorOf(op: string, nums: number[]): Rgb | null {
  if ((op === 'RG' || op === 'rg') && nums.length === 3) return [nums[0]!, nums[1]!, nums[2]!]
  if ((op === 'G' || op === 'g') && nums.length === 1) return [nums[0]!, nums[0]!, nums[0]!]
  if ((op === 'K' || op === 'k') && nums.length === 4) {
    const [c, m, y, k] = nums as [number, number, number, number]
    return [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)]
  }
  if (op === 'SC' || op === 'sc' || op === 'SCN' || op === 'scn') {
    if (nums.length === 3) return [nums[0]!, nums[1]!, nums[2]!]
    if (nums.length === 1) return [nums[0]!, nums[0]!, nums[0]!]
    if (nums.length === 4) return colorOf('k', nums)
  }
  return null
}

/**
 * The content with every colour operator that sets one of `from` set to `to`
 * instead. `changed` counts them. Null when the stream cannot be read safely.
 */
export function recolorContent(content: string, from: readonly Rgb[], to: Rgb): { text: string, changed: number } | null {
  const toks = tokenize(content)
  if (toks === null) return null
  const edits: Array<{ start: number, end: number, text: string }> = []
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!
    if (t.kind !== 'op' || !COLOR_OPS.has(t.text)) continue
    let j = i - 1
    while (j >= 0 && toks[j]!.kind === 'num' && i - j <= 4) j--
    // A pattern colour (`/P1 scn`) is not a colour to swap.
    if (j >= 0 && toks[j]!.kind === 'name' && (t.text === 'scn' || t.text === 'SCN')) continue
    const numToks = toks.slice(j + 1, i)
    const c = colorOf(t.text, numToks.map((x) => Number(x.text)))
    if (c === null || !from.some((f) => sameColor(f, c))) continue
    const first = numToks[0]
    if (first === undefined) continue
    edits.push({ start: first.start, end: t.end, text: `${rgbOps(to)} ${STROKE_OPS.has(t.text) ? 'RG' : 'rg'}` })
  }
  if (edits.length === 0) return { text: content, changed: 0 }
  let text = ''
  let at = 0
  for (const e of edits) { text += content.slice(at, e.start) + e.text; at = e.end }
  text += content.slice(at)
  return { text, changed: edits.length }
}

/** The colour a FreeText's default appearance (/DA) sets for its text. */
export function daColor(da: string): Rgb | null {
  const toks = tokenize(da)
  if (toks === null) return null
  let found: Rgb | null = null
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!
    if (t.kind !== 'op' || (t.text !== 'rg' && t.text !== 'g' && t.text !== 'k')) continue
    const want = t.text === 'rg' ? 3 : t.text === 'g' ? 1 : 4
    const nums = toks.slice(Math.max(0, i - want), i)
    if (nums.length !== want || !nums.every((x) => x.kind === 'num')) continue
    found = colorOf(t.text, nums.map((x) => Number(x.text)))
  }
  return found
}

/** /DA with its text colour set to `to`. Unchanged when it sets none. */
export function recolorDa(da: string, to: Rgb): string {
  const from = daColor(da)
  if (from === null) return da
  return recolorContent(da, [from], to)?.text ?? da
}

/**
 * Bluebeam's text styles (/DS, /RC) name colours as CSS: `color:#FF0000`.
 * Those matching `from` become `to`.
 */
export function recolorCss(css: string, from: readonly Rgb[], to: Rgb): string {
  return css.replace(/(color\s*[:=]\s*["']?)#([0-9a-f]{6})/gi, (whole, lead: string, hex: string) => {
    const c = hexToRgb(hex)
    return c !== null && from.some((f) => sameColor(f, c)) ? `${lead}${rgbToHex(to).toUpperCase()}` : whole
  })
}

// ------------------------------------------------------- on-screen copy --

/** [a b c d e f] applied to a point. */
function apply(m: readonly number[], x: number, y: number): [number, number] {
  return [m[0]! * x + m[2]! * y + m[4]!, m[1]! * x + m[3]! * y + m[5]!]
}

/**
 * The matrix an appearance is drawn with: its /Matrix, then the map that
 * puts the box it transforms /BBox to onto /Rect (PDF 32000, 12.5.5).
 * `rect` and `bbox` are [x0 y0 x1 y1].
 */
export function appearanceMatrix(bbox: readonly number[], matrix: readonly number[] | null, rect: readonly number[]): number[] {
  const m = matrix !== null && matrix.length === 6 && matrix.every(Number.isFinite) ? matrix : [1, 0, 0, 1, 0, 0]
  const corners = [apply(m, bbox[0]!, bbox[1]!), apply(m, bbox[2]!, bbox[1]!), apply(m, bbox[0]!, bbox[3]!), apply(m, bbox[2]!, bbox[3]!)]
  const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1])
  const tx0 = Math.min(...xs), tx1 = Math.max(...xs), ty0 = Math.min(...ys), ty1 = Math.max(...ys)
  const rx0 = Math.min(rect[0]!, rect[2]!), rx1 = Math.max(rect[0]!, rect[2]!)
  const ry0 = Math.min(rect[1]!, rect[3]!), ry1 = Math.max(rect[1]!, rect[3]!)
  const sx = tx1 - tx0 > 1e-9 ? (rx1 - rx0) / (tx1 - tx0) : 1
  const sy = ty1 - ty0 > 1e-9 ? (ry1 - ry0) / (ty1 - ty0) : 1
  // m, then scale and move: [m] x [sx 0 0 sy ex ey]
  const ex = rx0 - tx0 * sx, ey = ry0 - ty0 * sy
  return [m[0]! * sx, m[1]! * sy, m[2]! * sx, m[3]! * sy, m[4]! * sx + ex, m[5]! * sy + ey]
}

const FILL_TO_NONE: Record<string, string> = { f: 'n', F: 'n', 'f*': 'n', B: 'S', 'B*': 'S', b: 's', 'b*': 's' }
const STROKE_TO_NONE: Record<string, string> = { S: 'n', s: 'h n', B: 'f', 'B*': 'f*', b: 'h f', 'b*': 'h f*' }

function rewriteOps(content: string, map: Record<string, string>, dropText: boolean): string | null {
  const toks = tokenize(content)
  if (toks === null) return null
  const parts: string[] = []
  let inText = false
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!
    if (t.kind === 'op' && t.text === 'BT') inText = true
    if (dropText && inText) { if (t.kind === 'op' && t.text === 'ET') inText = false; continue }
    if (t.kind === 'op' && t.text === 'ET') inText = false
    // A named graphics state lives in resources the on-screen copy has not got.
    if (t.kind === 'op' && t.text === 'gs') { parts.pop(); continue }
    if (t.kind === 'op' && (t.text === 'Do' || t.text === 'sh')) { parts.pop(); continue }
    parts.push(t.kind === 'op' && map[t.text] !== undefined ? map[t.text]! : t.text)
  }
  return parts.join(' ')
}

/**
 * A recoloured appearance for the viewer's own copy of the PDF, drawn in the
 * annotation's /Rect as it stands.
 *
 * The viewer can only replace an appearance with one that has no resources
 * of its own, so the original's graphics states (Bluebeam's see-through fill)
 * are rebuilt: the fills are drawn once under `/GS`, which the viewer makes
 * from the annotation's /CA (set to `alpha` for the call), and the strokes
 * and text once more without it. Text falls back to the viewer's own font.
 * The FILE keeps the original appearance with only its colours changed.
 */
export function previewAppearance(opts: {
  content: string
  bbox: readonly number[]
  matrix: readonly number[] | null
  rect: readonly number[]
  from: readonly Rgb[]
  to: Rgb
  alpha: number
}): string | null {
  const recoloured = recolorContent(opts.content, opts.from, opts.to)
  if (recoloured === null) return null
  const cm = appearanceMatrix(opts.bbox, opts.matrix, opts.rect).map(fmt).join(' ')
  if (!(opts.alpha < 0.999)) {
    const plain = rewriteOps(recoloured.text, {}, false)
    return plain === null ? null : `q ${cm} cm ${plain} Q`
  }
  const fills = rewriteOps(recoloured.text, STROKE_TO_NONE, true)
  const strokes = rewriteOps(recoloured.text, FILL_TO_NONE, false)
  if (fills === null || strokes === null) return null
  return `q ${cm} cm q /GS gs ${fills} Q ${strokes} Q`
}

// ------------------------------------------------------------- protocol --

/**
 * What the viewer's copy of one annotation should look like now. Absolute,
 * not a change: the worker remembers how the file drew it and works from
 * that, so sending the same state twice changes nothing.
 */
export interface AnnotEdit {
  /** The annotation's /NM. */
  nm: string
  /** Where it should be: normalized to the page as displayed, y down. */
  rect: { x0: number, y0: number, x1: number, y1: number }
  /** Its colour as #rrggbb, or null to leave the file's. */
  color: string | null
  /** For a recolour on screen: the file's appearance box and matrix, and its fill opacity. */
  ap?: { bbox: number[], matrix: number[] | null, alpha: number }
}
