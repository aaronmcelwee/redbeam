/**
 * NOIC Interior Fit-Up and spec, read whole (2026-11-26): how a set's sheets
 * are named as their text comes in (sheetNamer.ts).
 */
import { describe, expect, it } from 'vitest'
import type { PageText } from '@redbeam/viewer'
import { codeOf } from './findTitleBlock.js'
import { SheetNamer } from './sheetNamer.js'

type W = [string, number, number]
function sheet(page: number, ws: W[], tall = false): PageText {
  let text = ''
  const runs = ws.map(([t, x, y]) => {
    const start = text.length
    text += `${t}\n`
    return { start, length: t.length, x0: x, y0: y, x1: x + 0.001 * t.length, y1: y + 0.004 }
  })
  const box = tall ? { left: 0, bottom: 0, right: 2592, top: 3456 } : { left: 0, bottom: 0, right: 3456, top: 2592 }
  return { page, text, runs, box, charCount: text.length, scanned: false, ms: 0 }
}

const words = (title: string, x: number, y: number): W[] => {
  let at = x
  return title.split(' ').map((w) => { const out: W = [w, at, y]; at += 0.001 * w.length + 0.0015; return out })
}

/** A NOIC-like set: the first sheets share one title but its level, tags all over the drawing. */
function noic(n: number): PageText[] {
  return Array.from({ length: n }, (_, i) => {
    const r = (k: number) => ((i * 37 + k * 11) % 70) / 100 + 0.05
    const code = i < 9 ? `IB0.08${i + 1}` : i === 20 ? 'IB4.LL1' : `IB${2 + (i % 5)}.0${String(i).padStart(2, '0')}`
    const title = i < 9 ? `CODE COMPLIANCE AND EGRESS PLANS - OFFICE & LINK - LEVEL 0${i + 1}`
      : ['CONSTRUCTION PLAN', 'REFLECTED CEILING PLAN', 'FLOOR FINISH PLAN', 'FURNITURE PLAN', 'WALL FINISH PLAN'][i % 5]!
    return sheet(i, [
      // A ceiling tag alone on its line, then a line in capitals: what the old reading took for a sheet.
      ['CL201', r(1), r(2)], ['SURFACE MOUNTED LINEAR LIGHT FIXTURE', r(1), r(2) + 0.01],
      ['D6A', r(3), r(4)], ['BULKHEAD ABOVE', r(3), r(4) + 0.01],
      ['NOKIA OTTAWA INNOVATION CAMPUS', 0.913, 0.855],
      ['Project', 0.913, 0.873], ['Number', 0.923, 0.873], ['67.1607.000', 0.913, 0.884],
      ['Description', 0.913, 0.894],
      ...words(title, 0.913, 0.903),
      [code, 0.914, 0.962],
    ])
  })
}

describe('naming a set sheet by sheet', () => {
  it('names every sheet from its block, though the first dozen share a title', () => {
    const pages = noic(40)
    const n = new SheetNamer(pages.length)
    pages.forEach((p, i) => n.add(i, p, i === pages.length - 1))
    const names = n.names()
    expect(names[0]).toBe('IB0.081 CODE COMPLIANCE AND EGRESS PLANS - OFFICE & LINK - LEVEL 01')
    expect(names[8]).toBe('IB0.089 CODE COMPLIANCE AND EGRESS PLANS - OFFICE & LINK - LEVEL 09')
    expect(names[11]).toBe('IB3.011 REFLECTED CEILING PLAN')
    expect(names[20]).toBe('IB4.LL1 CONSTRUCTION PLAN')
    expect(names.every((s) => s !== null && !/CL201|D6A/.test(s))).toBe(true)
    expect(n.titleBlock()?.sheets).toBeGreaterThan(30)
  })
  it('names the sheets read so far, before the last one comes', () => {
    const pages = noic(40)
    const n = new SheetNamer(pages.length)
    pages.slice(0, 15).forEach((p, i) => n.add(i, p))
    expect(n.names().slice(0, 15).every((s) => s !== null && s.startsWith('IB'))).toBe(true)
  })
  it('does not name a sheet after a tag when its box reads nothing', () => {
    const pages = noic(30)
    // A consultant's sheet bound into the set: no code in the box, and a tag the old reading took for one.
    pages[29] = sheet(29, [['CL201', 0.3, 0.3], ['SURFACE MOUNTED LINEAR LIGHT FIXTURE', 0.3, 0.31], ['Smith and Andersen', 0.1, 0.1]])
    const n = new SheetNamer(pages.length)
    pages.forEach((p, i) => n.add(i, p, i === pages.length - 1))
    expect(n.names()[29]).toBeNull()
  })
  it('lets go of a block a dozen sheets showed and the whole set does not', () => {
    // A spec: section headings, and on 4 of the first 12 pages a door number in one corner.
    const pages = Array.from({ length: 200 }, (_, i) => sheet(i, [
      ...(i % 10 === 0 ? [['SECTION 09 51 13', 0.1, 0.05] as W, ['ACOUSTICAL PANEL CEILINGS', 0.1, 0.07] as W] : []),
      ['PART 1 GENERAL', 0.1, 0.12],
      ...(i < 12 && i % 3 === 1 ? [[`A${400 + i}`, 0.12, 0.55] as W] : []),
    ], true))
    const n = new SheetNamer(pages.length)
    pages.forEach((p, i) => n.add(i, p, i === pages.length - 1))
    expect(n.titleBlock()).toBeNull()
    expect(n.names()[0]).toBe('09 51 13 ACOUSTICAL PANEL CEILINGS')
  })
  it('finds each sheet shape its own block', () => {
    const wide = noic(20)
    // Portrait sheets with their block along the bottom left.
    const tall = Array.from({ length: 10 }, (_, i) => sheet(20 + i, [
      ...words(['DETAILS', 'SECTIONS', 'ELEVATIONS'][i % 3]!, 0.05, 0.93), [`IB9.4${String(i).padStart(2, '0')}`, 0.3, 0.95],
    ], true))
    const pages = [...wide, ...tall]
    const n = new SheetNamer(pages.length)
    pages.forEach((p, i) => n.add(i, p, i === pages.length - 1))
    expect(n.names()[0]).toMatch(/^IB0\.081 /)
    expect(n.names()[25]).toBe('IB9.405 ELEVATIONS')
    expect(n.names()[24]).toBe('IB9.404 SECTIONS')
  })
})

describe('sheet codes', () => {
  it('takes the levels some sets write after the dot', () => {
    for (const c of ['IB4.LL1', 'IC8.0L1B', 'IC8.2L01', 'IC2.001A', 'A-101', 'A1.01', 'S2.1A']) expect(codeOf(c)).toBe(c)
    for (const c of ['IB4.LL', 'PLAN', '67.1607.000', 'LEVEL 01']) expect(codeOf(c)).toBeNull()
  })
})
