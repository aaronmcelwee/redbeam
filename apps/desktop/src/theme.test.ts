import { describe, expect, it } from 'vitest'
import { darken } from './accent.js'
import { resolveTheme } from './theme.js'
import { SETTINGS } from './settings/registry.js'

describe('the theme', () => {
  it('follows Windows unless a theme is chosen', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })

  it('defaults to Match Windows', () => {
    expect(SETTINGS.find((s) => s.id === 'general.theme')?.default).toBe('system')
  })

  it("makes the accent's dark steps from its base", () => {
    // Windows' own Dark1 for the default blue is #005A9E.
    expect(darken('#0078D4', 0.25)).toBe('#005A9F')
    expect(darken('#FFFFFF', 0)).toBe('#FFFFFF')
    expect(darken('#FFFFFF', 1)).toBe('#000000')
  })
})
