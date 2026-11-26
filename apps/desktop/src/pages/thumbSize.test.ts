import { describe, expect, it } from 'vitest'
import { cellWidth, DEFAULT_COLUMNS, parseColumns, renderWidth, stepColumns } from './thumbSize.js'

describe('thumbnail size', () => {
  it('reads a stored column count, and falls back to the default', () => {
    expect(parseColumns('2')).toBe(2)
    expect(parseColumns(null)).toBe(DEFAULT_COLUMNS)
    expect(parseColumns('9')).toBe(DEFAULT_COLUMNS)
    expect(parseColumns('x')).toBe(DEFAULT_COLUMNS)
  })

  it('steps columns with the wheel and stops at the ends', () => {
    expect(stepColumns(3, -100)).toBe(2)
    expect(stepColumns(3, 100)).toBe(4)
    expect(stepColumns(1, -100)).toBe(1)
    expect(stepColumns(4, 100)).toBe(4)
    expect(stepColumns(2, 0)).toBe(2)
  })

  it('fills the column, less gaps, padding and cell chrome', () => {
    // 300 px pane, 3 columns, 4 px gaps and padding, 8 px of border and padding a cell
    expect(cellWidth(300, 3, 4, 4, 8)).toBe(Math.floor((300 - 8 - 8) / 3) - 8)
    expect(cellWidth(300, 1, 4, 4, 8)).toBe(292 - 8)
    expect(cellWidth(10, 3, 4, 4, 8)).toBe(24)
  })

  it('renders at the screen density, in steps so small resizes reuse the render', () => {
    expect(renderWidth(80, 1)).toBe(96)
    expect(renderWidth(80, 2)).toBe(160)
    expect(renderWidth(85, 2)).toBe(192)
    expect(renderWidth(80, 1.5)).toBe(128)
    expect(renderWidth(80, NaN)).toBe(96)
  })
})
