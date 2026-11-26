import { describe, expect, it } from 'vitest'
import { compareHatches, hatchSignature, legendRows } from './hatch.js'

const PAGE = { width: 1000, height: 1000 }
const flat = (segs: Array<[number, number, number, number]>) => segs.flatMap(([a, b, c, d]) => [a / 1000, b / 1000, c / 1000, d / 1000])
const box = (x0: number, y0: number, x1: number, y1: number) => ({ x0: x0 / 1000, y0: y0 / 1000, x1: x1 / 1000, y1: y1 / 1000 })

/** 45-degree lines (rising to the right) every `step` points of offset, inside a box, plus its frame. */
function diagonal(x0: number, y0: number, x1: number, y1: number, step: number, framed = true): Array<[number, number, number, number]> {
  const out: Array<[number, number, number, number]> = []
  for (let k = -400; k < 400; k += step) out.push([x0 + k, y1, x0 + k + 400, y1 - 400])
  if (framed) out.push([x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0])
  return out
}
function horizontal(x0: number, y0: number, x1: number, y1: number, step: number): Array<[number, number, number, number]> {
  const out: Array<[number, number, number, number]> = []
  for (let y = y0 + step / 2; y < y1; y += step) out.push([x0, y, x1, y])
  out.push([x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0])
  return out
}

describe('hatchSignature', () => {
  it('reads a diagonal hatch: one direction at 45 and its spacing', () => {
    const s = hatchSignature(flat(diagonal(100, 100, 200, 160, 8)), PAGE, { box: box(100, 100, 200, 160) })!
    expect(s.families).toHaveLength(1)
    expect(s.families[0]!.angle).toBeCloseTo(45, 0)
    expect(s.families[0]!.spacing).toBeCloseTo(8 / Math.SQRT2, 1)
  })
  it('leaves a swatch frame out of a horizontal hatch but keeps the hatch', () => {
    const s = hatchSignature(flat(horizontal(100, 100, 200, 160, 6)), PAGE, { box: box(100, 100, 200, 160) })!
    expect(s.families.map((f) => Math.round(f.angle))).toEqual([0])
    expect(s.families[0]!.spacing).toBeCloseTo(6, 1)
  })
})

describe('compareHatches and legendRows', () => {
  it('matches a plan hatch to the legend swatch drawn the same way', () => {
    const plan = hatchSignature(flat(diagonal(300, 300, 600, 500, 8, false)), PAGE, { box: box(300, 300, 600, 500) })!
    const sameSwatch = hatchSignature(flat(diagonal(700, 100, 740, 120, 8)), PAGE, { box: box(700, 100, 740, 120) })!
    const wider = hatchSignature(flat(diagonal(700, 140, 740, 160, 16)), PAGE, { box: box(700, 140, 740, 160) })!
    const flatLines = hatchSignature(flat(horizontal(700, 180, 740, 200, 4)), PAGE, { box: box(700, 180, 740, 200) })!
    const s1 = compareHatches(plan, sameSwatch).score
    expect(s1).toBeGreaterThan(0.7)
    expect(compareHatches(plan, wider).score).toBeLessThan(s1)
    expect(compareHatches(plan, flatLines).score).toBeLessThan(0.3)
  })

  it('reads legend rows from the words beside the swatches', () => {
    const words = [
      { text: 'ACT-1', box: box(750, 105, 780, 115) }, { text: 'Tile', box: box(785, 105, 800, 115) },
      { text: 'WD-2', box: box(750, 145, 775, 155) },
    ]
    const rows = legendRows(words, box(690, 90, 820, 170))
    expect(rows.map((r) => r.label)).toEqual(['ACT-1 Tile', 'WD-2'])
    expect(rows[0]!.swatch.x0).toBeCloseTo(0.69, 5)
    expect(rows[0]!.swatch.x1).toBeLessThan(0.75)
    expect(rows[0]!.swatch.y1).toBeCloseTo(0.13, 5)
  })
})
