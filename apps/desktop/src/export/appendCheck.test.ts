import { describe, expect, it } from 'vitest'
import { startsWith } from './appendCheck.js'

describe('startsWith', () => {
  const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255)

  it('is true for the original followed by more', () => {
    const head = bytes(1003)
    const whole = new Uint8Array(1050)
    whole.set(head)
    expect(startsWith(whole, head)).toBe(true)
  })

  it('is false when any byte of the original differs, wherever it is', () => {
    const head = bytes(1003)
    for (const at of [0, 7, 8, 500, 1001, 1002]) {
      const whole = new Uint8Array(1050)
      whole.set(head)
      whole[at] = whole[at]! ^ 1
      expect(startsWith(whole, head)).toBe(false)
    }
  })

  it('is false when the new file is shorter, and works on unaligned views', () => {
    expect(startsWith(bytes(10), bytes(11))).toBe(false)
    const backing = new Uint8Array(2000)
    const head = bytes(999)
    backing.set(head, 3)
    expect(startsWith(backing.subarray(3), head)).toBe(true)
  })
})
