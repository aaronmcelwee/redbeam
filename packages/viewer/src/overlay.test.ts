import { describe, expect, it } from 'vitest'
import { boundsOf, drawOverlay } from './overlay.js'
import type { OverlaySet, PolygonOverlay, Viewport } from './types.js'

/** A 2D context that only counts what reaches it. */
function fakeCtx() {
  const calls = { fill: 0, stroke: 0 }
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(target, key) {
      if (key === 'fill') return () => { calls.fill++ }
      if (key === 'stroke') return () => { calls.stroke++ }
      if (key in target) return target[key as string]
      return () => {}
    },
    set(target, key, value) { target[key as string] = value; return true },
  })
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls }
}

function room(x0: number, y0: number, x1: number, y1: number): PolygonOverlay {
  return {
    poly: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
    fill: '#f00', stroke: '#f00', fillOpacity: 0.16, strokeOpacity: 0.9, strokeWidth: 1.4, dashed: false,
    cx: (x0 + x1) / 2, cy: (y0 + y1) / 2,
  }
}

// A 36 x 24 in sheet (2592 x 1728 pt) in a 1600 x 900 window.
const W = 2592, H = 1728
const at = (zoom: number, nx: number, ny: number): Viewport => ({
  zoom, ox: nx * W * zoom - 800, oy: ny * H * zoom - 450, vw: 1600, vh: 900,
})

describe('drawOverlay culling', () => {
  it('keeps drawing an area zoomed into its corner at 6400%', () => {
    const set: OverlaySet = { polygons: [room(0.2, 0.2, 0.6, 0.6)], lines: [], dots: [] }
    // Centred on a point just inside the room's top-left corner: the room's
    // centroid is about 66,000 px away, its fill covers the whole window.
    const { ctx, calls } = fakeCtx()
    const stats = drawOverlay(ctx, set, at(64, 0.201, 0.201), W, H)
    expect(stats).toEqual({ drawn: 1, culled: 0 })
    expect(calls.fill).toBe(1)
  })

  it('keeps drawing at every zoom step from fit to 6400%', () => {
    const set: OverlaySet = { polygons: [room(0.3, 0.3, 0.5, 0.45)], lines: [], dots: [] }
    for (let zoom = 0.25; zoom <= 64; zoom *= 1.25) {
      const { ctx } = fakeCtx()
      expect(drawOverlay(ctx, set, at(zoom, 0.31, 0.31), W, H).drawn, `zoom ${zoom}`).toBe(1)
    }
  })

  it('still culls an area that is wholly off screen', () => {
    const set: OverlaySet = { polygons: [room(0.7, 0.7, 0.8, 0.8)], lines: [], dots: [] }
    const { ctx, calls } = fakeCtx()
    expect(drawOverlay(ctx, set, at(8, 0.2, 0.2), W, H)).toEqual({ drawn: 0, culled: 1 })
    expect(calls.fill).toBe(0)
  })

  it('counts a split area by every piece, not only the first', () => {
    const p: PolygonOverlay = { ...room(0.1, 0.1, 0.2, 0.2), holes: [[[0.5, 0.5], [0.9, 0.5], [0.9, 0.9], [0.5, 0.9]]] }
    expect(boundsOf(p)).toEqual([0.1, 0.1, 0.9, 0.9])
    const { ctx } = fakeCtx()
    expect(drawOverlay(ctx, { polygons: [p], lines: [], dots: [] }, at(32, 0.7, 0.7), W, H).drawn).toBe(1)
  })
})
