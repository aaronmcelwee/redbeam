import { describe, expect, it } from 'vitest'
import { ringsAreaPoints, snapToLinework } from './snapTrace.js'

const page = { width: 1000, height: 1000 }
/** A grid of lines every 18 pt (a 2 ft cell at 1/8"), as flat normalized segments. */
function grid(): number[] {
  const flat: number[] = []
  for (let k = 0; k <= 20; k++) {
    const c = (100 + k * 18) / 1000
    flat.push(c, 0.1, c, 0.46, 0.1, c, 0.46, c)
  }
  return flat
}

describe('snapToLinework', () => {
  it('puts a skewed, shifted trace of a cell back on its four lines', () => {
    // The cell from 100..118: traced a few points off and out of square.
    const traced = [[{ x: 0.0975, y: 0.0985 }, { x: 0.1205, y: 0.0975 }, { x: 0.1195, y: 0.1205 }, { x: 0.0965, y: 0.1195 }]]
    const { rings, moved } = snapToLinework(traced, grid(), page, 5)
    expect(moved).toBe(4)
    expect(ringsAreaPoints(rings, page)).toBeCloseTo(18 * 18, 6)
    expect(rings[0]![0]!.x).toBeCloseTo(0.1, 9)
    expect(rings[0]![2]!.y).toBeCloseTo(0.118, 9)
  })

  it('leaves a vertex alone when no line is within reach', () => {
    const traced = [[{ x: 0.6, y: 0.6 }, { x: 0.7, y: 0.6 }, { x: 0.7, y: 0.7 }]]
    const { rings, moved } = snapToLinework(traced, grid(), page, 5)
    expect(moved).toBe(0)
    expect(rings).toEqual(traced)
  })

  it('drops the extra vertices a raster edge leaves along a straight wall', () => {
    const traced = [[
      { x: 0.101, y: 0.099 }, { x: 0.109, y: 0.101 }, { x: 0.119, y: 0.1 },
      { x: 0.118, y: 0.119 }, { x: 0.1, y: 0.117 },
    ]]
    const { rings } = snapToLinework(traced, grid(), page, 5)
    expect(rings[0]).toHaveLength(4)
    expect(ringsAreaPoints(rings, page)).toBeCloseTo(324, 6)
  })
})
