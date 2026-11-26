import { describe, expect, it } from 'vitest'
import type { PageText } from '@redbeam/viewer'
import { laneCount, PageTextPool, type TextSource } from './textPool.js'

const text = (page: number): PageText => ({
  page, text: `sheet ${page}`, runs: [], box: { left: 0, bottom: 0, right: 1, top: 1 }, charCount: 7, scanned: false, ms: 1,
})

/** A fake reader: `bad` pages kill it, `stuck` pages never answer. */
function opener(opts: { bad?: Set<number>; stuck?: Set<number>; log?: number[] } = {}) {
  let opened = 0
  const open = async (): Promise<TextSource> => {
    opened++
    let dead = false
    return {
      async textLayer(page) {
        if (dead) throw new Error('the PDF worker failed')
        opts.log?.push(page)
        await new Promise((r) => setTimeout(r, 1))
        if (opts.stuck?.has(page)) return new Promise<PageText>(() => {})
        if (opts.bad?.has(page)) { dead = true; throw new Error('Aborted(OOM)') }
        return text(page)
      },
      close() { dead = true },
    }
  }
  return { open, opened: () => opened }
}

describe('reading every sheet with several readers', () => {
  it('reads every page asked for, with no cap, and hands each to the cache', async () => {
    const o = opener()
    const seen: number[] = []
    const pool = new PageTextPool({ open: o.open, lanes: 3, onText: (p) => seen.push(p) })
    const pages = Array.from({ length: 500 }, (_, i) => i)
    pool.want(pages)
    const all = await Promise.all(pages.map((p) => pool.text(p)))
    expect(all.every((t, i) => t?.page === i)).toBe(true)
    expect(new Set(seen).size).toBe(500)
    expect(o.opened()).toBe(3)
    pool.close()
  })
  it('replaces a reader that a page kills, tries the page once more, then reports it and carries on', async () => {
    const o = opener({ bad: new Set([3]) })
    const pool = new PageTextPool({ open: o.open, lanes: 1 })
    pool.want([0, 1, 2, 3, 4, 5])
    expect(await pool.text(3)).toBeNull()
    expect(await pool.text(5)).toMatchObject({ page: 5 })
    expect(pool.unreadable()).toEqual([{ page: 3, why: 'Aborted(OOM)' }])
    pool.close()
  })
  it('gives up on a page that holds a reader for ever, and the rest still come', async () => {
    const o = opener({ stuck: new Set([1]) })
    const pool = new PageTextPool({ open: o.open, lanes: 2, stuckMs: 30 })
    pool.want([0, 1, 2, 3])
    expect(await pool.text(1)).toBeNull()
    expect(await pool.text(3)).toMatchObject({ page: 3 })
    expect(pool.unreadable()[0]).toMatchObject({ page: 1 })
    pool.close()
  })
  it('reads a page someone is waiting on ahead of the rest', async () => {
    const log: number[] = []
    const o = opener({ log })
    const pool = new PageTextPool({ open: o.open, lanes: 1 })
    pool.want(Array.from({ length: 50 }, (_, i) => i))
    await pool.text(40)
    expect(log.indexOf(40)).toBeLessThan(5)
    pool.close()
  })
  it('runs half the cores, one to four', () => {
    expect(laneCount(16)).toBe(4)
    expect(laneCount(4)).toBe(2)
    expect(laneCount(1)).toBe(1)
    expect(laneCount(undefined)).toBe(2)
  })
})
