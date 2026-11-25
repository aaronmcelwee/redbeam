import { describe, expect, it } from 'vitest'
import { angleGap, traceField } from './fieldTrace.js'
import { pointInPolygon, regionArea, type Point, type Polygon } from './geometry.js'

/*
 * A synthetic RCP at 1000 x 800 points: a hatched field drawn the way Revit
 * draws a slat ceiling (dashes at 15 degrees, 3 points apart, broken every
 * 40 points as at grid lines), with a round column it stops around, and the
 * things that broke the earlier approaches around it: walls at other angles,
 * a long grid line in the same direction, and a wall drawn with the same
 * hatch, too thin to be a ceiling.
 */
const PAGE = { width: 1000, height: 800 }
const ANGLE = 15

function hatch(
  field: Polygon, opts: { spacing?: number; dash?: number; gap?: number; holes?: Array<(p: Point) => boolean>; angle?: number } = {},
): number[] {
  const spacing = opts.spacing ?? 3, dash = opts.dash ?? 40, gap = opts.gap ?? 2
  const a = ((opts.angle ?? ANGLE) * Math.PI) / 180
  const u = { x: Math.cos(a), y: Math.sin(a) }, v = { x: -Math.sin(a), y: Math.cos(a) }
  const out: number[] = []
  const inside = (p: Point) => pointInPolygon(p, field) && !(opts.holes ?? []).some((h) => h(p))
  for (let off = -1500; off <= 1500; off += spacing) {
    let run: Point | null = null
    let last: Point | null = null
    for (let t = -1500; t <= 1500; t += 0.5) {
      const p = { x: v.x * off + u.x * t, y: v.y * off + u.y * t }
      // A break in the dash every `dash` points, on the same line.
      const broken = ((t % dash) + dash) % dash < gap
      const ok = p.x >= 0 && p.x <= PAGE.width && p.y >= 0 && p.y <= PAGE.height && !broken && inside(p)
      if (ok && run === null) run = p
      if (!ok && run !== null && last !== null) { out.push(run.x, run.y, last.x, last.y); run = null }
      if (ok) last = p
    }
    if (run !== null && last !== null) out.push(run.x, run.y, last.x, last.y)
  }
  return out
}

const norm = (pts: number[]): number[] => pts.map((n, i) => (i % 2 === 0 ? n / PAGE.width : n / PAGE.height))

// An L-shaped field, a column 24 points across inside it, and a second room of the same ceiling beyond a wall.
const L: Polygon = [{ x: 100, y: 100 }, { x: 600, y: 100 }, { x: 600, y: 300 }, { x: 350, y: 300 }, { x: 350, y: 550 }, { x: 100, y: 550 }]
const COLUMN = { x: 250, y: 200, r: 12 }
const ROOM: Polygon = [{ x: 650, y: 100 }, { x: 900, y: 100 }, { x: 900, y: 400 }, { x: 650, y: 400 }]
const STRIP: Polygon = [{ x: 400, y: 600 }, { x: 900, y: 600 }, { x: 900, y: 607 }, { x: 400, y: 607 }]

function sheet(): number[] {
  const segs: number[] = []
  segs.push(...hatch(L, { holes: [(p) => Math.hypot(p.x - COLUMN.x, p.y - COLUMN.y) < COLUMN.r] }))
  segs.push(...hatch(ROOM))
  // A wall drawn with the same hatch: 7 points wide, so not a field.
  segs.push(...hatch(STRIP, { spacing: 2 }))
  // Walls around the field, at 0 and 90 degrees.
  for (const ring of [L, ROOM]) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!, b = ring[(i + 1) % ring.length]!
      segs.push(a.x - 4, a.y - 4, b.x - 4, b.y - 4)
    }
  }
  // A long grid line in the pattern's own direction, running out across the sheet.
  const a = (ANGLE * Math.PI) / 180
  segs.push(0, 650, 1000, 650 + 1000 * Math.tan(a) * 0.1)
  segs.push(20, 700, 20 + 900 * Math.cos(a), 700 + 900 * Math.sin(a) * 0.05)
  // Dimension ticks and text-like clutter at 45 degrees, outside the field.
  for (let i = 0; i < 300; i++) segs.push(620 + (i % 30) * 2, 500 + Math.floor(i / 30) * 3, 622 + (i % 30) * 2, 502 + Math.floor(i / 30) * 3)
  return norm(segs)
}

const areaOf = (rings: Polygon[]) => regionArea(rings.map((r) => r.map((p) => ({ x: p.x * PAGE.width, y: p.y * PAGE.height }))))
const L_AREA = 500 * 200 + 250 * 250

describe('traceField', () => {
  const segments = new Float32Array(sheet())
  const frame = { x0: 0, y0: 0, x1: 1, y1: 1 }

  it('traces a dashed hatch with no line around it to where the strokes stop', () => {
    const r = traceField({ segments, page: PAGE, seed: { x: 200 / 1000, y: 400 / 800 }, frame })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(angleGap(r.diagnostics.angleDeg!, ANGLE)).toBeLessThan(1)
    expect(r.fields).toHaveLength(1)
    const f = r.fields[0]!
    expect(f.seed).toBe(true)
    // The hatch stops within a stroke gap of the edge, so the area is a few percent shy at most.
    const column = Math.PI * COLUMN.r * COLUMN.r
    expect(f.areaPoints2).toBeGreaterThan((L_AREA - column) * 0.96)
    expect(f.areaPoints2).toBeLessThan((L_AREA - column) * 1.02)
    expect(Math.abs(f.areaPoints2 - areaOf(f.rings))).toBeLessThan(1)
  })

  it('keeps the column the hatch stops around as a cutout', () => {
    const r = traceField({ segments, page: PAGE, seed: { x: 0.2, y: 0.5 }, frame })
    if (!r.ok) throw new Error(r.message)
    const f = r.fields[0]!
    expect(f.cutouts).toHaveLength(1)
    const c = f.cutouts[0]!
    expect(Math.abs(c.center.x * 1000 - COLUMN.x)).toBeLessThan(3)
    expect(Math.abs(c.center.y * 800 - COLUMN.y)).toBeLessThan(3)
    expect(c.areaPoints2).toBeGreaterThan(Math.PI * COLUMN.r ** 2 * 0.6)
    expect(c.areaPoints2).toBeLessThan(Math.PI * COLUMN.r ** 2 * 1.6)
    expect(f.rings).toHaveLength(2)
  })

  it('fills a hole under minCutoutPoints2', () => {
    const r = traceField({ segments, page: PAGE, seed: { x: 0.2, y: 0.5 }, frame, options: { minCutoutPoints2: 1000 } })
    if (!r.ok) throw new Error(r.message)
    expect(r.fields[0]!.cutouts).toHaveLength(0)
    expect(r.fields[0]!.filledHoles).toBe(1)
  })

  it('starts from a point on the column', () => {
    const r = traceField({ segments, page: PAGE, seed: { x: COLUMN.x / 1000, y: COLUMN.y / 800 }, frame })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.fields[0]!.areaPoints2).toBeGreaterThan(L_AREA * 0.9)
  })

  it('with all, finds the other room of the same ceiling but not a wall drawn with the same hatch', () => {
    const r = traceField({ segments, page: PAGE, seed: { x: 0.2, y: 0.5 }, frame, options: { all: true } })
    if (!r.ok) throw new Error(r.message)
    expect(r.fields).toHaveLength(2)
    const room = r.fields[1]!
    expect(room.seed).toBe(false)
    expect(room.areaPoints2).toBeGreaterThan(250 * 300 * 0.95)
    expect(room.areaPoints2).toBeLessThan(250 * 300 * 1.02)
  })

  it('stays inside the box asked about', () => {
    const r = traceField({ segments, page: PAGE, seed: { x: 0.2, y: 0.5 }, frame: { x0: 0, y0: 0, x1: 0.3, y1: 1 } })
    if (!r.ok) throw new Error(r.message)
    for (const p of r.fields[0]!.rings[0]!) expect(p.x).toBeLessThanOrEqual(0.3 + 1e-6)
  })

  it('cuts out strokes the rendered sheet shows painted over', () => {
    // The sheet as rendered: the field grey, except a 60 x 60 patch masked white.
    const w = 500, h = 400
    const img = new Uint8Array(w * h).fill(255)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = { x: x * 2 + 1, y: y * 2 + 1 }
        const masked = p.x > 150 && p.x < 210 && p.y > 400 && p.y < 460
        if (pointInPolygon(p, L) && !masked && (x + y) % 3 === 0) img[y * w + x] = 60
      }
    }
    const r = traceField({
      segments, page: PAGE, seed: { x: 0.2, y: 0.4 }, frame,
      options: { image: { data: img, width: w, height: h, channels: 1 } },
    })
    if (!r.ok) throw new Error(r.message)
    const f = r.fields[0]!
    const hidden = f.cutouts.filter((c) => c.hidden === true)
    expect(hidden).toHaveLength(1)
    expect(hidden[0]!.areaPoints2).toBeGreaterThan(2000)
    expect(f.visual!.insideInk).toBeGreaterThan(0.1)
  })

  it('says there is no pattern rather than inventing one', () => {
    const r = traceField({ segments, page: PAGE, seed: { x: 0.05, y: 0.05 }, frame })
    expect(r.ok).toBe(false)
  })

  it('refuses a point outside the box', () => {
    const r = traceField({ segments, page: PAGE, seed: { x: 0.9, y: 0.9 }, frame: { x0: 0, y0: 0, x1: 0.5, y1: 0.5 } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('seed-outside-frame')
  })

  it('finds a hatch at 0 degrees too, with walls along it', () => {
    const box: Polygon = [{ x: 100, y: 100 }, { x: 500, y: 100 }, { x: 500, y: 300 }, { x: 100, y: 300 }]
    const segs = [...hatch(box, { angle: 0 }), 96, 96, 504, 96, 96, 304, 504, 304]
    const r = traceField({ segments: new Float32Array(norm(segs)), page: PAGE, seed: { x: 0.3, y: 0.25 }, frame })
    if (!r.ok) throw new Error(r.message)
    expect(r.fields[0]!.areaPoints2).toBeGreaterThan(400 * 200 * 0.96)
    expect(r.fields[0]!.areaPoints2).toBeLessThan(400 * 200 * 1.06)
  })
})
