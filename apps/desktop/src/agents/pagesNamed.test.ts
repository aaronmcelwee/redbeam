/** Which sheets a call names, so each has its row before the call writes to it. */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { pagesNamed } from './pagesNamed.js'

describe('the sheets a call names', () => {
  it('reads page, pages, a range, and a page on each markup', () => {
    expect(pagesNamed({ page: 3 }, 10)).toEqual([3])
    expect(pagesNamed({ pages: [1, 4, 4] }, 10)).toEqual([1, 4])
    expect(pagesNamed({ fromPage: 2, toPage: 4 }, 10)).toEqual([2, 3, 4])
    expect(pagesNamed({ markups: [{ page: 0 }, { page: 5 }, {}] }, 10)).toEqual([0, 5])
  })
  it('leaves out what is not a sheet of this document', () => {
    expect(pagesNamed({ page: 12, pages: [-1, 2.5, 'x'] }, 10)).toEqual([])
    expect(pagesNamed({}, 10)).toEqual([])
  })
  it('has every named sheet written to the store before the call runs', () => {
    const src = readFileSync(fileURLToPath(new URL('../Workspace.tsx', import.meta.url)), 'utf8')
    const at = src.indexOf('await ensurePageRows(pagesNamed(params, pageCount))')
    expect(at).toBeGreaterThan(0)
    expect(at).toBeLessThan(src.indexOf('await keepingFocus(() => invokeAction(action, params))'))
  })
})
