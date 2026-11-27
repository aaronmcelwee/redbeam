import { describe, expect, it } from 'vitest'
import { angleGap, dilateXY, erodeXY, fitRingToLines, traceField } from './fieldTrace.js'
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

describe('traceField near a denser hatch (NOIC, 2026-11-26)', () => {
  // A sparse slat field (6 pt apart) right beside a dense 45-degree wall poche
  // (1.5 pt): the window around the point holds more of the poche, which used
  // to win. The field at the point is the slats.
  const FIELD: Polygon = [{ x: 100, y: 100 }, { x: 500, y: 100 }, { x: 500, y: 400 }, { x: 100, y: 400 }]
  const POCHE: Polygon = [{ x: 140, y: 100 }, { x: 175, y: 100 }, { x: 175, y: 400 }, { x: 140, y: 400 }]
  const segs = norm([
    ...hatch(FIELD, { spacing: 6, angle: 0, holes: [(p) => pointInPolygon(p, POCHE)] }),
    ...hatch(POCHE, { spacing: 1.5, angle: 45 }),
  ])
  const seed = { x: 185 / PAGE.width, y: 250 / PAGE.height }

  it('follows the hatch that is solid at the point, and lists the other', () => {
    const r = traceField({ segments: segs, page: PAGE, seed, frame: { x0: 0, y0: 0, x1: 1, y1: 1 } })
    if (!r.ok) throw new Error(r.message)
    expect(angleGap(r.diagnostics.angleDeg!, 0)).toBeLessThan(2)
    const area = regionArea(r.fields[0]!.rings.map((ring) => ring.map((q) => ({ x: q.x * PAGE.width, y: q.y * PAGE.height }))))
    // The slat field less the poche strip it surrounds.
    expect(area).toBeGreaterThan(0.8 * (400 * 300 - 35 * 300))
    expect(r.diagnostics.alternatives?.some((a) => angleGap(a.angleDeg, 45) < 2)).toBe(true)
  })

  it('takes the stroke spacing it is told', () => {
    const r = traceField({ segments: segs, page: PAGE, seed, frame: { x0: 0, y0: 0, x1: 1, y1: 1 }, options: { strokeSpacingPoints: 6 } })
    if (!r.ok) throw new Error(r.message)
    expect(angleGap(r.diagnostics.angleDeg!, 0)).toBeLessThan(2)
  })
})


describe('traceField: Coinbase blind test (2026-11-27)', () => {
  // Vertical baffles every 4.2 pt across x 200..400, y 100..500; a band of
  // wall lines off that spacing on the west side, x 185..196.
  const members: number[] = []
  for (let x = 200; x <= 400 + 1e-9; x += 4.2) members.push(x, 100, x, 500)
  const wall = [196, 193.5, 191, 189, 186.5, 185].flatMap((x) => [x, 100, x, 500])
  const segs = () => norm([...members, ...wall, 180, 100, 180, 500])
  const seed = { x: 300 / PAGE.width, y: 300 / PAGE.height }
  const xs = (r: { fields: Array<{ rings: Polygon[] }> }) => r.fields[0]!.rings[0]!.map((p) => p.x * PAGE.width)

  it('traces the same field whatever box it is searched in', () => {
    const a = traceField({ segments: segs(), page: PAGE, seed, frame: { x0: 0, y0: 0, x1: 1, y1: 1 }, options: { cellPoints: 0.75 } })
    const b = traceField({ segments: segs(), page: PAGE, seed, frame: { x0: 0.1, y0: 0.05, x1: 0.6, y1: 0.75 }, options: { cellPoints: 0.75 } })
    if (!a.ok || !b.ok) throw new Error('no field')
    expect(b.fields[0]!.areaPoints2).toBeCloseTo(a.fields[0]!.areaPoints2, 6)
  })

  it('ends the field at the hatch, not at the wall lines past it, with edge "hatch"', () => {
    const wallEdge = traceField({ segments: segs(), page: PAGE, seed, frame: { x0: 0, y0: 0, x1: 1, y1: 1 } })
    const hatchEdge = traceField({ segments: segs(), page: PAGE, seed, frame: { x0: 0, y0: 0, x1: 1, y1: 1 }, options: { edge: 'hatch' } })
    if (!wallEdge.ok || !hatchEdge.ok) throw new Error('no field')
    expect(Math.min(...xs(wallEdge))).toBeLessThan(188)
    expect(Math.min(...xs(hatchEdge))).toBeGreaterThan(196)
    expect(Math.min(...xs(hatchEdge))).toBeLessThan(200)
    expect(hatchEdge.diagnostics.hatch?.periodPoints).toBeCloseTo(4.2, 1)
  })

  it('fits a stair-stepped edge to the slanted line it runs along', () => {
    // Steps of 4 pt down a line from (100,100) to (140,500).
    const ring: Polygon = [{ x: 300, y: 100 }, { x: 300, y: 500 }, { x: 140, y: 500 }]
    for (let y = 500; y > 100; y -= 40) {
      const x = 100 + (y - 100) / 10
      ring.push({ x, y }, { x, y: y - 40 })
    }
    ring.push({ x: 100, y: 100 })
    const line = Float64Array.from([100, 100, 140, 500])
    const fit = fitRingToLines(ring, line, 6)
    expect(fit.moved).toBeGreaterThan(5)
    for (const p of fit.ring) if (p.x < 200) expect(Math.abs(p.x - (100 + (p.y - 100) / 10))).toBeLessThan(1e-6)
  })
})

describe('dilateXY and erodeXY', () => {
  // The slow, obvious meaning: a cell is set when a set cell lies within rx
  // along its row of a cell within ry down its column.
  const naive = (src: Uint8Array, w: number, h: number, rx: number, ry: number, erode: boolean) => {
    const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? (erode ? 1 : 0) : src[y * w + x]!)
    const out = new Uint8Array(w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let any = false, all = true
      for (let dy = -ry; dy <= ry; dy++) for (let dx = -rx; dx <= rx; dx++) {
        if (at(x + dx, y + dy)) any = true
        else all = false
      }
      out[y * w + x] = (erode ? all : any) ? 1 : 0
    }
    return out
  }
  it('match the cell-by-cell meaning on random grids, for every pair of radii', () => {
    let seed = 7
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    for (const [w, h] of [[1, 1], [9, 5], [16, 23]] as const) {
      for (const fill of [0.1, 0.5, 0.9]) {
        const src = Uint8Array.from({ length: w * h }, () => (rnd() < fill ? 1 : 0))
        for (const rx of [0, 1, 3]) for (const ry of [0, 1, 4]) {
          expect(Array.from(dilateXY(src, w, h, rx, ry)), `dilate ${w}x${h} ${rx},${ry}`).toEqual(Array.from(naive(src, w, h, rx, ry, false)))
          expect(Array.from(erodeXY(src, w, h, rx, ry)), `erode ${w}x${h} ${rx},${ry}`).toEqual(Array.from(naive(src, w, h, rx, ry, true)))
        }
      }
    }
  })
  it('never hand back the grid they were given', () => {
    const src = Uint8Array.from([1, 0, 0, 1])
    expect(dilateXY(src, 2, 2, 0, 0)).not.toBe(src)
    expect(erodeXY(src, 2, 2, 0, 0)).not.toBe(src)
  })
})
