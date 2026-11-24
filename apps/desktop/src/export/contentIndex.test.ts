import { describe, expect, it } from 'vitest'
import { cullContent, indexContent } from './contentIndex.js'

const bytes = (s: string) => new TextEncoder().encode(s)
const text = (b: Uint8Array | null) => (b === null ? null : new TextDecoder().decode(b))
const cull = (s: string, window: { x0: number; y0: number; x1: number; y1: number }) => {
  const b = bytes(s)
  return text(cullContent(b, indexContent(b), window, 1))
}

describe('cullContent', () => {
  const inside = { x0: 0, y0: 0, x1: 100, y1: 100 }

  it('leaves out a path wholly outside the window, and keeps one that reaches it', () => {
    const out = cull('10 10 m 20 20 l S\n500 500 m 600 600 l S\n90 90 m 300 300 l S\n', inside)
    expect(out).toContain('10 10 m 20 20 l S')
    expect(out).toContain('90 90 m 300 300 l S')
    expect(out).not.toContain('500 500 m')
  })

  it('never leaves out text', () => {
    const out = cull('500 500 m 600 600 l S\nBT /F1 12 Tf 900 900 Td (far away) Tj ET\n', inside)
    expect(out).toContain('(far away) Tj')
    expect(out).not.toContain('500 500 m')
  })

  it('places a path through the matrix it is drawn under', () => {
    // Drawn at 10..20 but moved 1000 across: outside.
    expect(cull('q 1 0 0 1 1000 1000 cm 10 10 m 20 20 l S Q\n50 50 m 60 60 l S\n', inside)).not.toContain('10 10 m')
    // Drawn at 1010..1020 and moved back: inside, while the same path unmoved is not.
    const out = cull('q 1 0 0 1 -1000 -1000 cm 1010 1010 m 1020 1020 l S Q\nq 1010 1010 m 1020 1020 l S Q\n', inside)!
    expect(out.match(/1010 1010 m/g)).toHaveLength(1)
    expect(out).toContain('-1000 -1000 cm')
  })

  it('keeps the line width a kept path was drawn with when the run that set it is left out', () => {
    const out = cull('3 w\n500 500 m 600 600 l S\n10 10 m 20 20 l S\n', inside)!
    expect(out).toContain('10 10 m 20 20 l S')
    expect(out).not.toContain('500 500 m')
    expect(out.indexOf('3 w')).toBeGreaterThanOrEqual(0)
    expect(out.indexOf('3 w')).toBeLessThan(out.indexOf('10 10 m'))
  })

  it('says when leaving paths out would save too little to be worth a stream', () => {
    const b = bytes('10 10 m 20 20 l S\n30 30 m 40 40 l S\n')
    expect(cullContent(b, indexContent(b), inside)).toBeNull()
  })
})
