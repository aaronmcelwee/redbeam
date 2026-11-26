/**
 * Names every sheet of a set as its text is read, from the title block the
 * set's own sheets show (findTitleBlock.ts), page by page and in any order.
 *
 * NOIC Interior Fit-Up, read whole (2026-11-26), taught three things the
 * first version missed:
 *
 *  - A set can mix sheet shapes, and a portrait sheet's title block is not
 *    where a landscape sheet's is. Each shape as shown gets its own block,
 *    found from the sheets of that shape. (NOIC's quarter-turned sheets are
 *    turned back by the reader, words and size alike, and join the rest.)
 *  - The first dozen sheets can share a title ("CODE COMPLIANCE AND EGRESS
 *    OFFICE PLANS - LINK & LEVEL 01" to "06"), which reads as the block's
 *    furniture. So the block is looked for again as more sheets come in, and
 *    every sheet is named again whenever what is found changes.
 *  - Where the block is found but a sheet's box reads no code, the reading
 *    of the text in order (sheetFromText) found ceiling tags: "CL201",
 *    "D6A", "PT210". Its guess is kept only when it starts like the codes
 *    the boxes read ("IB", "IC"), and otherwise the sheet stays unnamed.
 */
import type { PageText } from '@redbeam/viewer'
import { codeOf, findTitleBlock, type FoundTitleBlock } from './findTitleBlock.js'
import { sheetFromText } from './sheets.js'
import { readSheetName, type TitleBlockRegions } from './titleBlock.js'

/** How many sheets of a shape are sampled to find its block. */
const SAMPLE = 300

type Shape = 'wide' | 'tall'

/**
 * The sheet's shape as shown. The viewer's page size is already turned by
 * /Rotate, as the words are; the text's own box is not, so it is only the
 * fallback.
 */
function shapeOf(pt: PageText, size?: { width: number; height: number }): Shape {
  const w = size !== undefined ? size.width : Math.abs(pt.box.right - pt.box.left)
  const h = size !== undefined ? size.height : Math.abs(pt.box.top - pt.box.bottom)
  return h > w ? 'tall' : 'wide'
}

/** The letters a sheet code starts with: "IB" for "IB4.LL1", "A" for "A-101". */
const series = (code: string): string => /^[A-Z]+/.exec(code.toUpperCase())?.[0] ?? ''

interface Group {
  pages: number[]
  found: FoundTitleBlock | null
  /** Read sheet count at which to look again. */
  nextLook: number
}

export class SheetNamer {
  private readonly texts = new Map<number, PageText>()
  private readonly groups = new Map<Shape, Group>()
  private readonly labels: Array<string | null>
  private readonly boxed: Array<string | null>
  /** Letters the codes read from the boxes start with, and how many of each. */
  private readonly seriesSeen = new Map<string, number>()

  constructor(private readonly pageCount: number) {
    this.labels = new Array<string | null>(pageCount).fill(null)
    this.boxed = new Array<string | null>(pageCount).fill(null)
  }

  /** Each sheet's name so far: "IB0.081 CODE COMPLIANCE AND EGRESS ...", or null. */
  names(): Array<string | null> { return [...this.labels] }

  /** The block found on the most sheets, for list_sheets. */
  titleBlock(): FoundTitleBlock | null {
    let best: FoundTitleBlock | null = null
    for (const g of this.groups.values()) if (g.found !== null && (best === null || g.found.sheets > best.sheets)) best = g.found
    return best
  }

  /**
   * A sheet's text has been read. `last` says nothing more is coming, so
   * every shape looks for its block once more with all it has.
   */
  add(page: number, pt: PageText, last = false, size?: { width: number; height: number }): void {
    if (page < 0 || page >= this.pageCount) return
    this.texts.set(page, pt)
    const shape = shapeOf(pt, size)
    let g = this.groups.get(shape)
    if (g === undefined) { g = { pages: [], found: null, nextLook: 12 }; this.groups.set(shape, g) }
    g.pages.push(page)
    this.nameBoxed(page, pt, g.found?.regions ?? null)
    if (g.pages.length >= g.nextLook) {
      g.nextLook = g.pages.length * 3
      this.look(g)
    }
    if (last) this.finish()
    else this.nameGuessed(page)
  }

  /** Everything has been read: each shape looks once more, and every sheet is named from it. */
  finish(): void {
    for (const g of this.groups.values()) this.look(g)
    for (let p = 0; p < this.pageCount; p++) this.nameGuessed(p)
  }

  // ------------------------------------------------------------------------

  private look(g: Group): void {
    const step = Math.max(1, Math.floor(g.pages.length / SAMPLE))
    const sample = g.pages.filter((_, k) => k % step === 0).map((p) => this.texts.get(p)!)
    const found = findTitleBlock(sample)
    // What a dozen sheets showed and a hundred do not was not the block (NOIC spec: 4 of 12).
    if (found === null && g.found === null) return
    const same = g.found !== null && found !== null && JSON.stringify(g.found.regions) === JSON.stringify(found.regions)
    g.found = found
    if (same) return
    for (const p of g.pages) this.nameBoxed(p, this.texts.get(p)!, found?.regions ?? null)
    for (const p of g.pages) this.nameGuessed(p)
  }

  /** What the block's boxes read on a sheet. */
  private nameBoxed(page: number, pt: PageText, regions: TitleBlockRegions | null): void {
    const before = this.boxed[page] ?? null
    let now: string | null = null
    if (regions !== null) {
      const read = readSheetName(pt, regions)
      const code = read === null ? null : codeOf(read.number)
      if (read !== null && code !== null) {
        const title = read.title.replace(read.number, '').replace(/\s+/g, ' ').trim()
        now = title === '' ? code : `${code} ${title}`
      }
    }
    if (before !== null) this.count(series(before), -1)
    if (now !== null) this.count(series(now), +1)
    this.boxed[page] = now
  }

  /** The sheet's name: its boxes, else a reading of its text that starts like the set's own codes. */
  private nameGuessed(page: number): void {
    const boxed = this.boxed[page] ?? null
    if (boxed !== null) { this.labels[page] = boxed; return }
    const pt = this.texts.get(page)
    if (pt === undefined) { this.labels[page] = null; return }
    const found = sheetFromText(pt.text)
    if (found === null) { this.labels[page] = null; return }
    // With codes read off boxes, a guess in another series is a tag on the drawing.
    // A spec section ("09 51 13") has no letters, and no tag is without them.
    const s = series(found.number)
    if (s !== '' && this.seriesSeen.size > 0 && (this.seriesSeen.get(s) ?? 0) === 0) { this.labels[page] = null; return }
    this.labels[page] = found.title === '' ? found.number : `${found.number} ${found.title}`
  }

  private count(s: string, by: number): void {
    const n = (this.seriesSeen.get(s) ?? 0) + by
    if (n <= 0) this.seriesSeen.delete(s)
    else this.seriesSeen.set(s, n)
  }
}
