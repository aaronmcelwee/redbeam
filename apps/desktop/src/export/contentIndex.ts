/**
 * Where each path of a PDF content stream lies, found by reading the stream
 * without drawing it.
 *
 * A snapshot shows a few square feet of a sheet that may hold a hundred
 * thousand paths. A clip hides the rest, but a viewer still reads and
 * strokes every one of them, so a page of six snapshots costs six sheets of
 * work. This reads the sheet's content once and notes, for every path that
 * paints, its extent in user space; cullContent then copies the stream for
 * one window, leaving out the paths that lie wholly outside it.
 *
 * Only painting paths are ever left out, and whole q…Q groups that hold
 * nothing but paths and the settings they draw with (a CAD sheet wraps most
 * of its linework that way, often a clip and a fill inside each). Everything
 * else — text, images, shadings, marked content and layers, and every path
 * that clips outside such a group — is kept byte for byte, in order, so what
 * remains draws exactly as it did.
 */

export interface ContentIndex {
  /** How many runs: the stream is cut into runs that, end to end, are the whole of it. */
  count: number
  start: Int32Array
  end: Int32Array
  /** x0, y0, x1, y1 of each run in user space; NaN for a run that is not a path or a group of them. */
  box: Float64Array
  /**
   * 1 for a run that sets nothing but the line width: CAD output sets it
   * before every path, so it is left out with them and the width the next
   * kept run needs is written back in.
   */
  widthOnly: Uint8Array
  /** The line width in force at the end of each run. */
  width: Float64Array
}

type Matrix = [number, number, number, number, number, number]

const WHITE = new Uint8Array(256)
for (const c of [0, 9, 10, 12, 13, 32]) WHITE[c] = 1
const DELIM = new Uint8Array(256)
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1

/** `m` applied first, then `n` (row vectors, as PDF writes matrices). */
const times = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
]

/** Operators that only set how later paths are drawn: a group of these and paths can go whole. */
const SETTINGS = new Set(['cm', 'w', 'J', 'j', 'M', 'd', 'ri', 'i', 'gs', 'CS', 'cs', 'SC', 'SCN', 'sc', 'scn', 'G', 'g', 'RG', 'rg', 'K', 'k'])
const PATH = new Set(['m', 'l', 'c', 'v', 'y', 're', 'h', 'W', 'W*', 'S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n'])

/** A q…Q group being read. */
interface Group {
  ctm: Matrix
  lineWidth: number
  /** Where its q starts, and the first run inside it. */
  at: number
  first: number
  /** Nothing in it yet but paths and settings. */
  pure: boolean
  x0: number
  y0: number
  x1: number
  y1: number
}

class Runs {
  count = 0
  start = new Int32Array(1024)
  end = new Int32Array(1024)
  box = new Float64Array(4096)
  widthOnly = new Uint8Array(1024)
  width = new Float64Array(1024)
  push(start: number, end: number, x0: number, y0: number, x1: number, y1: number, width: number, widthOnly = false): void {
    if (end <= start) return
    if (this.count === this.start.length) {
      const grow = <T extends Int32Array | Float64Array | Uint8Array>(a: T): T => {
        const b = new (a.constructor as new (n: number) => T)(a.length * 2)
        b.set(a)
        return b
      }
      this.start = grow(this.start)
      this.end = grow(this.end)
      this.box = grow(this.box)
      this.widthOnly = grow(this.widthOnly)
      this.width = grow(this.width)
    }
    const k = this.count++
    this.start[k] = start
    this.end[k] = end
    this.box[4 * k] = x0
    this.box[4 * k + 1] = y0
    this.box[4 * k + 2] = x1
    this.box[4 * k + 3] = y1
    this.widthOnly[k] = widthOnly ? 1 : 0
    this.width[k] = width
  }
}

/** Read `bytes` (a decoded content stream) and say where each painting path lies. */
export function indexContent(bytes: Uint8Array): ContentIndex {
  const n = bytes.length
  const runs = new Runs()
  const nums: number[] = []
  let operandsAt = -1
  let ctm: Matrix = [1, 0, 0, 1, 0, 0]
  let lineWidth = 1
  const groups: Group[] = []

  let keptFrom = 0
  /** Whether everything since keptFrom sets only the line width. */
  let widthOnly = true
  const gap = (to: number) => runs.push(keptFrom, to, NaN, NaN, NaN, NaN, lineWidth, widthOnly)
  let pathAt = -1
  let clip = false
  let sound = true
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  const add = (x: number | undefined, y: number | undefined) => {
    if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
      sound = false
      return
    }
    const X = ctm[0] * x + ctm[2] * y + ctm[4]
    const Y = ctm[1] * x + ctm[3] * y + ctm[5]
    if (X < x0) x0 = X
    if (X > x1) x1 = X
    if (Y < y0) y0 = Y
    if (Y > y1) y1 = Y
  }
  const arg = (k: number) => nums[nums.length + k]
  const widen = (g: Group, a: number, b: number, c: number, d: number) => {
    if (a < g.x0) g.x0 = a
    if (b < g.y0) g.y0 = b
    if (c > g.x1) g.x1 = c
    if (d > g.y1) g.y1 = d
  }

  let i = 0
  while (i < n) {
    const c = bytes[i]!
    if (WHITE[c]) { i++; continue }
    if (c === 0x25) { // % comment
      while (i < n && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i++
      continue
    }
    const at = i
    if (c === 0x28) { // (literal string)
      let depth = 0
      while (i < n) {
        const d = bytes[i]!
        if (d === 0x5c) { i += 2; continue }
        if (d === 0x28) depth++
        else if (d === 0x29 && --depth === 0) { i++; break }
        i++
      }
    } else if (c === 0x3c) { // <hex> or <<
      if (bytes[i + 1] === 0x3c) i += 2
      else {
        while (i < n && bytes[i] !== 0x3e) i++
        i++
      }
    } else if (c === 0x3e) { // >>
      i += bytes[i + 1] === 0x3e ? 2 : 1
    } else if (c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d) {
      i++
    } else if (c === 0x2f) { // /Name
      i++
      while (i < n && !WHITE[bytes[i]!] && !DELIM[bytes[i]!]) i++
    } else if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) {
      let j = i
      let sign = 1
      if (bytes[j] === 0x2d) { sign = -1; j++ } else if (bytes[j] === 0x2b) j++
      let value = 0
      let scale = 0
      while (j < n) {
        const d = bytes[j]!
        if (d >= 0x30 && d <= 0x39) {
          if (scale === 0) value = value * 10 + (d - 0x30)
          else { value += (d - 0x30) / scale; scale *= 10 }
          j++
        } else if (d === 0x2e && scale === 0) { scale = 10; j++ } else break
      }
      i = j
      if (operandsAt < 0) operandsAt = at
      nums.push(sign * value)
      continue
    } else {
      // A keyword: an operator, or true / false / null among operands.
      while (i < n && !WHITE[bytes[i]!] && !DELIM[bytes[i]!]) i++
      const end = i
      const len = end - at
      const k0 = bytes[at]!, k1 = len > 1 ? bytes[at + 1]! : 0
      const op = len === 1 ? String.fromCharCode(k0) : len === 2 ? String.fromCharCode(k0, k1) : String.fromCharCode(...bytes.subarray(at, end))
      if (op === 'true' || op === 'false' || op === 'null') {
        if (operandsAt < 0) operandsAt = at
        nums.push(NaN)
        continue
      }
      const group = groups[groups.length - 1]
      if (group !== undefined && !SETTINGS.has(op) && !PATH.has(op) && op !== 'q' && op !== 'Q') group.pure = false

      switch (op) {
        case 'q':
          gap(at)
          keptFrom = at
          widthOnly = false
          groups.push({ ctm, lineWidth, at, first: runs.count, pure: true, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity })
          break
        case 'Q': {
          const g = groups.pop()
          if (g === undefined) break
          ctm = g.ctm
          lineWidth = g.lineWidth
          const parent = groups[groups.length - 1]
          if (g.pure && pathAt < 0 && g.x1 >= g.x0) {
            // Nothing but paths and their settings: the group stands or goes whole.
            runs.count = g.first
            runs.push(g.at, end, g.x0, g.y0, g.x1, g.y1, lineWidth)
            keptFrom = end
            widthOnly = true
            if (parent !== undefined) widen(parent, g.x0, g.y0, g.x1, g.y1)
          } else {
            widthOnly = false
            if (parent !== undefined && (!g.pure || pathAt >= 0)) parent.pure = false
          }
          break
        }
        case 'cm':
          if (nums.length >= 6) ctm = times([arg(-6)!, arg(-5)!, arg(-4)!, arg(-3)!, arg(-2)!, arg(-1)!], ctm)
          break
        case 'w':
          if (nums.length >= 1 && Number.isFinite(arg(-1))) lineWidth = arg(-1)!
          break
        case 'm': case 'l': case 'c': case 'v': case 'y': case 're': case 'h':
          if (pathAt < 0) pathAt = operandsAt >= 0 ? operandsAt : at
          if (op === 're') {
            const x = arg(-4), y = arg(-3), w = arg(-2), h = arg(-1)
            add(x, y)
            add(x !== undefined && w !== undefined ? x + w : undefined, y)
            add(x, y !== undefined && h !== undefined ? y + h : undefined)
            add(x !== undefined && w !== undefined ? x + w : undefined, y !== undefined && h !== undefined ? y + h : undefined)
          } else if (op === 'c') { add(arg(-6), arg(-5)); add(arg(-4), arg(-3)); add(arg(-2), arg(-1)) } else if (op === 'v' || op === 'y') { add(arg(-4), arg(-3)); add(arg(-2), arg(-1)) } else if (op !== 'h') add(arg(-2), arg(-1))
          break
        case 'W': case 'W*':
          clip = true
          break
        case 'S': case 's': case 'f': case 'F': case 'f*': case 'B': case 'B*': case 'b': case 'b*': case 'n':
          if (pathAt >= 0) {
            gap(pathAt)
            if (!sound || !(x1 >= x0)) {
              runs.push(pathAt, end, NaN, NaN, NaN, NaN, lineWidth)
              if (group !== undefined) group.pure = false
            } else {
              // The stroke reaches half its width past the path, more at a
              // mitred corner; a zero width still paints a hairline.
              const s = Math.max(Math.hypot(ctm[0], ctm[1]), Math.hypot(ctm[2], ctm[3]))
              const g = Math.max(lineWidth, 1) * s * 2 + 1
              // A clip shapes everything after it, so on its own it stays;
              // inside a group it goes with the group, which it bounds.
              if (clip) runs.push(pathAt, end, NaN, NaN, NaN, NaN, lineWidth)
              else runs.push(pathAt, end, x0 - g, y0 - g, x1 + g, y1 + g, lineWidth)
              if (group !== undefined) widen(group, x0 - g, y0 - g, x1 + g, y1 + g)
            }
            keptFrom = end
            widthOnly = true
          }
          pathAt = -1
          clip = false
          sound = true
          x0 = Infinity; y0 = Infinity; x1 = -Infinity; y1 = -Infinity
          break
        case 'ID': {
          // Inline image data: one white byte, then binary up to EI.
          let j = i + 1
          while (j + 1 < n && !(bytes[j] === 0x45 && bytes[j + 1] === 0x49
            && WHITE[bytes[j - 1]!] && (j + 2 >= n || WHITE[bytes[j + 2]!] || DELIM[bytes[j + 2]!]))) j++
          i = Math.min(n, j + 2)
          break
        }
        default:
          break
      }
      if (op !== 'w' && op !== 'q' && op !== 'Q' && !PATH.has(op)) widthOnly = false
      nums.length = 0
      operandsAt = -1
      continue
    }
    // A string, a name, an array or a dictionary bracket: an operand, not a number.
    if (operandsAt < 0) operandsAt = at
    nums.push(NaN)
  }
  // A path never painted is not drawn either; keep it with the rest.
  widthOnly = false
  gap(n)
  return { count: runs.count, start: runs.start, end: runs.end, box: runs.box, widthOnly: runs.widthOnly, width: runs.width }
}

/**
 * `bytes` less every painting path that lies wholly outside the box, in user
 * space. Returns null when that would leave out too little to be worth a
 * stream of its own.
 */
export function cullContent(
  bytes: Uint8Array,
  index: ContentIndex,
  window: { x0: number; y0: number; x1: number; y1: number },
  worthIt = 0.6,
): Uint8Array | null {
  const parts: Uint8Array[] = []
  let size = 0
  let from = -1
  let to = -1
  const flush = () => {
    if (from < 0) return
    parts.push(bytes.subarray(from, to), SPACE)
    size += to - from + 1
    from = -1
  }
  // The line width the copy has in force, and whether a width-only run was left out since.
  let width = 1
  let owed = false
  for (let k = 0; k < index.count; k++) {
    const bx0 = index.box[4 * k]!
    if (!Number.isNaN(bx0)
      && (index.box[4 * k + 2]! < window.x0 || bx0 > window.x1 || index.box[4 * k + 3]! < window.y0 || index.box[4 * k + 1]! > window.y1)) continue
    if (index.widthOnly[k] === 1) {
      owed = true
      continue
    }
    if (owed) {
      owed = false
      const wanted = k > 0 ? index.width[k - 1]! : 1
      if (wanted !== width) {
        flush()
        const set = ASCII.encode(`${Math.round(wanted * 1e5) / 1e5} w\n`)
        parts.push(set)
        size += set.length
        width = wanted
      }
    }
    const a = index.start[k]!, b = index.end[k]!
    if (from >= 0 && a === to) to = b
    else {
      flush()
      from = a
      to = b
    }
    width = index.width[k]!
  }
  flush()
  if (size > bytes.length * worthIt) return null
  const out = new Uint8Array(size)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const ASCII = new TextEncoder()
/** Runs end on a token; a space keeps the next from running into it. */
const SPACE = new Uint8Array([0x20])
