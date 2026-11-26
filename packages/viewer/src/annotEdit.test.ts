import { describe, expect, it } from 'vitest'
import {
  appearanceMatrix, daColor, hexToRgb, previewAppearance, recolorContent, recolorCss, recolorDa, rgbToHex, tokenize,
} from './annotEdit.js'

const RED: [number, number, number] = [1, 0, 0]
const BLUE: [number, number, number] = [0, 0, 1]

describe('recolouring another app\'s appearance', () => {
  it('swaps only the operators that set the markup\'s colour', () => {
    const out = recolorContent('q 1 0 0 RG 1 0 0 rg 0 0 0 rg 2 w 0 0 m 10 10 l S Q', [RED], BLUE)!
    expect(out.changed).toBe(2)
    expect(out.text).toBe('q 0 0 1 RG 0 0 1 rg 0 0 0 rg 2 w 0 0 m 10 10 l S Q')
  })

  it('reads grey and CMYK as the colours they are', () => {
    expect(recolorContent('0 G 0 g', [[0, 0, 0]], RED)!.text).toBe('1 0 0 RG 1 0 0 rg')
    expect(recolorContent('0 1 1 0 k', [RED], BLUE)!.text).toBe('0 0 1 rg')
  })

  it('leaves strings, names and pattern colours alone', () => {
    const src = 'BT (1 0 0 rg \\) still text) Tj ET /P1 scn /Name 1 0 0 RG'
    const out = recolorContent(src, [RED], BLUE)!
    expect(out.text).toBe('BT (1 0 0 rg \\) still text) Tj ET /P1 scn /Name 0 0 1 RG')
  })

  it('refuses a drawing with an inline image', () => {
    expect(tokenize('BI /W 1 ID xx EI')).toBeNull()
    expect(recolorContent('BI /W 1 ID xx EI', [RED], BLUE)).toBeNull()
  })

  it('reads and recolours a text box\'s /DA and Bluebeam\'s CSS', () => {
    expect(daColor('/Helv 12 Tf 1 0 0 rg')).toEqual(RED)
    expect(recolorDa('/Helv 12 Tf 1 0 0 rg', BLUE)).toBe('/Helv 12 Tf 0 0 1 rg')
    expect(recolorCss('font: Arial; color:#FF0000; <span style="color:#00ff00">', [RED], BLUE))
      .toBe('font: Arial; color:#0000FF; <span style="color:#00ff00">')
  })

  it('hex round trips', () => {
    expect(rgbToHex(hexToRgb('#0070ff')!)).toBe('#0070ff')
    expect(hexToRgb('nope')).toBeNull()
  })
})

describe('the on-screen copy of a recoloured appearance', () => {
  it('maps the appearance box onto the annotation\'s rectangle', () => {
    expect(appearanceMatrix([0, 0, 100, 30], null, [200, 60, 300, 90])).toEqual([1, 0, 0, 1, 200, 60])
    expect(appearanceMatrix([45, 45, 155, 125], null, [65, 75, 175, 155])).toEqual([1, 0, 0, 1, 20, 30])
  })

  it('draws fills under the see-through state and strokes and text without it', () => {
    const ap = previewAppearance({
      content: 'q /GS0 gs 1 0 0 RG 1 0 0 rg 0 0 m 10 0 l 10 10 l h B BT /F1 9 Tf (x) Tj ET Q',
      bbox: [0, 0, 10, 10], matrix: null, rect: [100, 100, 110, 110], from: [RED], to: BLUE, alpha: 0.3,
    })!
    expect(ap).toBe('q 1 0 0 1 100 100 cm q /GS gs q 0 0 1 RG 0 0 1 rg 0 0 m 10 0 l 10 10 l h f Q Q '
      + 'q 0 0 1 RG 0 0 1 rg 0 0 m 10 0 l 10 10 l h S BT /F1 9 Tf (x) Tj ET Q Q')
  })

  it('an opaque drawing is drawn once', () => {
    expect(previewAppearance({
      content: '1 0 0 RG 0 0 m 5 5 l S', bbox: [0, 0, 5, 5], matrix: null, rect: [0, 0, 5, 5], from: [RED], to: BLUE, alpha: 1,
    })).toBe('q 1 0 0 1 0 0 cm 0 0 1 RG 0 0 m 5 5 l S Q')
  })
})
