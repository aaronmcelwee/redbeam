import { describe, expect, it } from 'vitest'
import { RECIPES, applyMatrix, colorMatrix, drawingFilter, isDrawingColors, DRAWING_COLOR_CHOICES } from './drawingColors.js'
import { descriptor } from './settings/registry.js'

const hex = (c: readonly number[]) => '#' + c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase()
const WHITE = [1, 1, 1] as const
const BLACK = [0, 0, 0] as const

describe('drawing colours', () => {
  it.each(Object.entries(RECIPES))('%s maps white to its paper and black to its ink', (_, r) => {
    const m = colorMatrix(r)
    expect(m).toHaveLength(20)
    expect(hex(applyMatrix(m, WHITE))).toBe(r.paper)
    expect(hex(applyMatrix(m, BLACK))).toBe(r.ink)
  })

  it('the dark modes keep a red line red, not cyan', () => {
    for (const mode of ['dark', 'darkgray', 'black'] as const) {
      const [r, g, b] = applyMatrix(colorMatrix(RECIPES[mode]), [1, 0, 0])
      expect(r).toBeGreaterThan(g + 0.2)
      expect(r).toBeGreaterThan(b + 0.2)
    }
  })

  it('a mid grey lands between paper and ink, so hatching keeps its order', () => {
    for (const r of Object.values(RECIPES)) {
      const m = colorMatrix(r)
      const light = applyMatrix(m, [0.8, 0.8, 0.8])[0]
      const dark = applyMatrix(m, [0.3, 0.3, 0.3])[0]
      const paper = applyMatrix(m, WHITE)[0]
      const ink = applyMatrix(m, BLACK)[0]
      // Light grey stays nearer the paper than dark grey does.
      expect(Math.abs(light - paper)).toBeLessThan(Math.abs(dark - paper))
      expect(Math.abs(dark - ink)).toBeLessThan(Math.abs(light - ink))
    }
  })

  it('leaves alpha alone', () => {
    for (const r of Object.values(RECIPES)) expect(colorMatrix(r).slice(15)).toEqual([0, 0, 0, 1, 0])
  })

  it('Normal is no filter at all', () => {
    expect(drawingFilter('normal')).toBe('none')
    expect(drawingFilter('sepia')).toBe('url(#rb-drawing-sepia)')
  })

  it('the setting offers exactly the modes the filters exist for', () => {
    const d = descriptor('viewer.drawingColors')
    expect(d?.type).toBe('enum')
    expect(d?.default).toBe('normal')
    const values = d?.type === 'enum' ? d.choices.map((c) => c.value) : []
    expect(values).toEqual(DRAWING_COLOR_CHOICES.map((c) => c.value))
    expect(values.every(isDrawingColors)).toBe(true)
    expect(isDrawingColors('purple')).toBe(false)
  })
})
