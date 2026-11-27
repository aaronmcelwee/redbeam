import { describe, expect, it } from 'vitest'
import { defaultCornerOf, LAYOUT_KEYS, scopeLayout } from './scopeLayout.js'

describe('a scope\'s own layout settings (Aaron, 2026-11-27)', () => {
  it('defaults to a top-left start and everything drawn', () => {
    expect(scopeLayout({}, {})).toEqual({
      patternStart: 'top-left', perAreaOrigin: false, showOverflow: true, showRails: true, showTrim: true, showSeams: true,
    })
  })

  it('reads the old global setting for a scope that has not set its own', () => {
    const prefs = { 'takeoff.patternStart': 'automatic', 'takeoff.perAreaOrigin': true, 'takeoff.layoutRails': false }
    expect(scopeLayout({}, prefs)).toMatchObject({ patternStart: 'automatic', perAreaOrigin: true, showRails: false })
  })

  it('lets the scope win over the global value', () => {
    const prefs = { 'takeoff.patternStart': 'automatic', 'takeoff.layoutRails': false }
    const look = scopeLayout({ [LAYOUT_KEYS.patternStart]: 'bottom-right', [LAYOUT_KEYS.showRails]: 'true', [LAYOUT_KEYS.showSeams]: 'false' }, prefs)
    expect(look).toMatchObject({ patternStart: 'bottom-right', showRails: true, showSeams: false })
    expect(defaultCornerOf(look)).toBe('bottom-right')
    expect(defaultCornerOf(scopeLayout({ [LAYOUT_KEYS.patternStart]: 'automatic' }, {}))).toBeNull()
  })

  it('ignores a start it does not know', () => {
    expect(scopeLayout({ [LAYOUT_KEYS.patternStart]: 'middle' }, {}).patternStart).toBe('top-left')
  })
})
