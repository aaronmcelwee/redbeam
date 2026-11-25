import { describe, expect, it } from 'vitest'
import { shortParent, splitName } from './ProjectStartScreen.js'

describe('start screen names', () => {
  it('keeps the end of a long name, cut at a word', () => {
    expect(splitName('02 - Hyundai Capital - A-MEP IFT 11092026 - BLIND TAKEOFF (takeoff)'))
      .toEqual(['02 - Hyundai Capital - A-MEP IFT 11092026 - BLIND', 'TAKEOFF (takeoff)'])
  })
  it('leaves a short name whole', () => {
    expect(splitName('Arch Fit Up Add#1')).toEqual(['Arch Fit Up Add#1', ''])
  })
  it('leaves one long word to elide at the end', () => {
    expect(splitName('A'.repeat(40))).toEqual(['A'.repeat(40), ''])
  })
  it('shows the folder a file is in, not the file', () => {
    expect(shortParent('C:\\Users\\aaron\\Downloads\\PlansArchitecture.pdf')).toBe('…\\aaron\\Downloads')
    expect(shortParent('C:\\Jobs\\a.pdf')).toBe('C:\\Jobs')
  })
})
