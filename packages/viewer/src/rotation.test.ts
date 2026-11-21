import { describe, expect, it } from 'vitest'
import { rotateFlatPoints, rotateNormBox, rotateNormPoint, turnsOf, wrapTurns } from './rotation.js'

describe('rotation', () => {
  it('wraps any whole number of turns and any multiple of 90 degrees', () => {
    expect(wrapTurns(-1)).toBe(3)
    expect(wrapTurns(5)).toBe(1)
    expect(turnsOf(270)).toBe(3)
    expect(turnsOf(-90)).toBe(3)
    expect(turnsOf(360)).toBe(0)
  })

  it('turns clockwise: the top-left corner lands top-right after one turn', () => {
    expect(rotateNormPoint({ x: 0, y: 0 }, 1)).toEqual({ x: 1, y: 0 })
    expect(rotateNormPoint({ x: 0, y: 0 }, 2)).toEqual({ x: 1, y: 1 })
    expect(rotateNormPoint({ x: 0, y: 0 }, 3)).toEqual({ x: 0, y: 1 })
  })

  it('comes back where it started after four turns, and 3 undoes 1', () => {
    const p = { x: 0.2, y: 0.7 }
    let q = p
    for (let i = 0; i < 4; i++) q = rotateNormPoint(q, 1)
    expect(q.x).toBeCloseTo(p.x); expect(q.y).toBeCloseTo(p.y)
    const r = rotateNormPoint(rotateNormPoint(p, 1), 3)
    expect(r.x).toBeCloseTo(p.x); expect(r.y).toBeCloseTo(p.y)
  })

  it('keeps a box ordered and carries its other fields', () => {
    const b = rotateNormBox({ x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.5, start: 4 }, 1)
    expect(b.start).toBe(4)
    expect(b.x0).toBeCloseTo(0.5); expect(b.x1).toBeCloseTo(0.8)
    expect(b.y0).toBeCloseTo(0.1); expect(b.y1).toBeCloseTo(0.3)
  })

  it('turns a flat run of points in place', () => {
    const f = new Float32Array([0, 0, 1, 0])
    rotateFlatPoints(f, 1)
    expect(Array.from(f)).toEqual([1, 0, 1, 1])
  })
})
