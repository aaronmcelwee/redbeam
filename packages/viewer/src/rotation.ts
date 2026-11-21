/**
 * Quarter turns of a page, in normalized coordinates.
 *
 * Everything this app stores about a sheet is normalized to the page AS
 * DISPLAYED: [0,1] on both axes, y down. PDFium hands text, paths, links and
 * annotations back in the page's own unrotated space, so a page with /Rotate
 * needs every one of those turned before it lines up with what is on screen,
 * and turning a sheet means turning everything drawn on it the same way.
 *
 * Turns are CLOCKWISE, as /Rotate is: at one turn the unrotated top edge lands
 * on the right of the screen.
 */

import type { NormBox } from './text.js'

export interface NormPoint { x: number; y: number }

/** 0..3 from any whole number of turns, or from degrees via `turnsOf`. */
export function wrapTurns(turns: number): 0 | 1 | 2 | 3 {
  return ((((Math.round(turns) % 4) + 4) % 4) as 0 | 1 | 2 | 3)
}

/** Degrees (a multiple of 90, any sign) to 0..3 clockwise turns. */
export function turnsOf(degrees: number): 0 | 1 | 2 | 3 {
  return wrapTurns(Math.round(degrees / 90))
}

/** A normalized point turned clockwise by `turns` quarter turns. */
export function rotateNormPoint(p: NormPoint, turns: number): NormPoint {
  switch (wrapTurns(turns)) {
    case 1: return { x: 1 - p.y, y: p.x }
    case 2: return { x: 1 - p.x, y: 1 - p.y }
    case 3: return { x: p.y, y: 1 - p.x }
    default: return { x: p.x, y: p.y }
  }
}

/** A normalized box turned the same way, still lower/upper ordered. */
export function rotateNormBox<B extends NormBox>(b: B, turns: number): B {
  const a = rotateNormPoint({ x: b.x0, y: b.y0 }, turns)
  const c = rotateNormPoint({ x: b.x1, y: b.y1 }, turns)
  return { ...b, x0: Math.min(a.x, c.x), y0: Math.min(a.y, c.y), x1: Math.max(a.x, c.x), y1: Math.max(a.y, c.y) }
}

/** A flat [x1,y1,x2,y2,...] run of normalized points, turned in place. */
export function rotateFlatPoints(flat: Float32Array | number[], turns: number): void {
  const t = wrapTurns(turns)
  if (t === 0) return
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const p = rotateNormPoint({ x: flat[i]!, y: flat[i + 1]! }, t)
    flat[i] = p.x
    flat[i + 1] = p.y
  }
}
