import { describe, expect, it } from 'vitest'
import { historyStepForButton, historyStepForKey, ViewHistory, zoomToBox } from './viewNav'

const v = { ox: 0, oy: 0, zoom: 1, vw: 1000, vh: 500 }
const stage = { width: 1000, height: 500 }

describe('zoomToBox', () => {
  it('fits the box on its tighter axis and centres it', () => {
    // A 100 x 100 box at (100,100): page span 100pt, stage 1000x500 → zoom 5.
    const out = zoomToBox(v, { x0: 200, y0: 200, x1: 100, y1: 100 }, stage, 10)!
    expect(out.zoom).toBe(5)
    // The box centre (150,150)pt lands on the stage centre.
    expect(out.ox + stage.width / 2).toBe(150 * 5)
    expect(out.oy + stage.height / 2).toBe(150 * 5)
  })
  it('respects the zoom ceiling', () => {
    expect(zoomToBox(v, { x0: 0, y0: 0, x1: 10, y1: 10 }, stage, 8)!.zoom).toBe(8)
  })
  it('treats a tiny drag as a click', () => {
    expect(zoomToBox(v, { x0: 0, y0: 0, x1: 3, y1: 50 }, stage, 10)).toBeNull()
  })
  it('accounts for the current scroll and zoom', () => {
    const out = zoomToBox({ ...v, ox: 400, oy: 200, zoom: 2 }, { x0: 0, y0: 0, x1: 100, y1: 50 }, stage, 100)!
    // Page span 50 x 25 pt from (200,100)pt; zoom min(1000/50, 500/25) = 20.
    expect(out.zoom).toBe(20)
    expect((out.ox + 500) / 20).toBeCloseTo(225)
    expect((out.oy + 250) / 20).toBeCloseTo(112.5)
  })
})

describe('ViewHistory', () => {
  const at = (page: number, zoom = 1) => ({ page, zoom, ox: 0, oy: 0 })
  it('goes back and forward like a browser', () => {
    const h = new ViewHistory()
    h.leave(at(0)); h.leave(at(4))
    expect(h.goBack(at(9))).toEqual(at(4))
    expect(h.goBack(at(4))).toEqual(at(0))
    expect(h.goBack(at(0))).toBeNull()
    expect(h.goForward(at(0))).toEqual(at(4))
    expect(h.goForward(at(4))).toEqual(at(9))
    expect(h.canGoForward()).toBe(false)
  })
  it('clears forward on a new jump, and keeps the latest framing of a sheet', () => {
    const h = new ViewHistory()
    h.leave(at(0)); h.leave(at(1))
    h.goBack(at(2))
    h.leave(at(1, 3))
    expect(h.canGoForward()).toBe(false)
    expect(h.goBack(at(5))).toEqual(at(1, 3))
    expect(h.goBack(at(1))).toEqual(at(0))
  })
  it('remembers every place, not the last fifty', () => {
    const h = new ViewHistory()
    for (let p = 0; p < 500; p++) h.leave(at(p))
    let back = 0
    while (h.goBack(at(999)) !== null) back++
    expect(back).toBe(500)
  })
})

describe('history keys', () => {
  it('is Alt+arrow only, and mouse buttons 3 and 4', () => {
    const m = { altKey: true, ctrlKey: false, metaKey: false, shiftKey: false }
    expect(historyStepForKey('ArrowLeft', m)).toBe(-1)
    expect(historyStepForKey('ArrowRight', m)).toBe(1)
    expect(historyStepForKey('ArrowLeft', { ...m, altKey: false })).toBeNull()
    expect(historyStepForKey('ArrowLeft', { ...m, ctrlKey: true })).toBeNull()
    expect(historyStepForButton(3)).toBe(-1)
    expect(historyStepForButton(4)).toBe(1)
    expect(historyStepForButton(0)).toBeNull()
  })
})
