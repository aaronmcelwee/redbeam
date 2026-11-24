import { describe, expect, it } from 'vitest'
import { RangeReader } from './rangeReader.js'

const source = (size: number) => Uint8Array.from({ length: size }, (_, i) => i % 251)

describe('RangeReader', () => {
  it('reads across block edges and stops at the end', () => {
    const data = source(10_000)
    const r = new RangeReader(data.length, (a, b) => data.slice(a, b), 1024, 4)
    const out = new Uint8Array(3000)
    expect(r.read(1000, 3000, out)).toBe(true)
    expect([...out]).toEqual([...data.slice(1000, 4000)])
    expect(r.read(9_999, 2, new Uint8Array(2))).toBe(false)
    expect(r.read(9_990, 10, new Uint8Array(10))).toBe(true)
  })

  it('reads only the blocks asked for and keeps recent ones', () => {
    const data = source(100 * 1024)
    const r = new RangeReader(data.length, (a, b) => data.slice(a, b), 1024, 4)
    const out = new Uint8Array(10)
    r.read(0, 10, out)
    r.read(5, 10, out)
    r.read(99 * 1024, 10, out)
    expect(r.fetches).toBe(2)
    for (let i = 10; i < 20; i++) r.read(i * 1024, 1, out)
    r.read(0, 1, out)
    expect(r.fetches).toBe(13)
  })
})
