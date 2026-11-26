/**
 * Every sheet's text, read by several PDF readers at once, off the viewer.
 *
 * NOIC intake, 2026-11-26: find_text on a 257-sheet set answered "still
 * reading" four times, and on a 4,382-page spec it took cursor after cursor.
 * The sheets were read one at a time by the viewer's own worker, the same
 * one that draws the sheet on screen, at the lowest priority it has. This
 * reads them with a few workers of their own (headless, one PDF each), in
 * page order, and hands each page to the viewer's cache as it lands, so
 * find_text and get_words see it without asking again.
 *
 * No cap on the set (Aaron, 2026-11-24): every page asked for is read to the
 * end, however many there are. What it guards against is one page that
 * kills or stalls a reader. A reader that dies is replaced and the page is
 * tried once more on a fresh one; a page that fails twice, or keeps one
 * reader busy for STUCK_MS, is reported unreadable (with why) and the rest
 * carry on. Without that, one bad page of a spec held every search behind it.
 */
import type { PageText } from '@redbeam/viewer'

/** What a lane needs from an open PDF: the subset of HeadlessDocument used here. */
export interface TextSource {
  textLayer(page: number): Promise<PageText>
  close(): void
}

export interface TextPoolOptions {
  /** Open the PDF in a fresh worker. */
  open: () => Promise<TextSource>
  /** How many readers work at once. */
  lanes: number
  /** Each page as it is read, for the viewer's cache. */
  onText?: (page: number, text: PageText) => void
  /** A page that kept one reader busy this long is given up on (that reader is replaced). */
  stuckMs?: number
  /** Pages one reader reads before it is let go for a fresh one (see READS_PER_READER). */
  readsPerReader?: number
}

/** One page that could not be read, and why. */
export interface Unreadable { page: number; why: string }

export const STUCK_MS = 120_000

/*
 * NOIC spec, read whole in one PDFium document (2026-11-26): the heap grew
 * about 100 MB every 250-500 pages and never came back (PDFium keeps what a
 * page's fonts and images decoded for the life of the document), and at page
 * 4,022 it passed 2 GB and aborted. One page read alone takes nothing like
 * it. So a reader is let go after this many pages and the next is fresh.
 */
export const READS_PER_READER = 400

type Slot = {
  promise: Promise<PageText | null>
  resolve: (t: PageText | null) => void
  tries: number
  why: string | null
}

/** How many readers to run: half the cores, at least one, at most four. */
export function laneCount(cores: number | undefined): number {
  const c = Number.isFinite(cores) && (cores ?? 0) > 0 ? Math.floor(cores!) : 4
  return Math.max(1, Math.min(4, Math.floor(c / 2)))
}

export class PageTextPool {
  private readonly slots = new Map<number, Slot>()
  private readonly queue: number[] = []
  private readonly queued = new Set<number>()
  private closed = false
  private readonly sources: Array<TextSource | null>
  private readonly stuckMs: number
  private readonly readsPerReader: number
  private readonly reads: number[]

  constructor(private readonly opts: TextPoolOptions) {
    this.sources = Array.from({ length: Math.max(1, opts.lanes) }, () => null)
    this.stuckMs = opts.stuckMs ?? STUCK_MS
    this.readsPerReader = Math.max(1, opts.readsPerReader ?? READS_PER_READER)
    this.reads = this.sources.map(() => 0)
  }

  /** The page's text, read in the background if it is not yet; null when it cannot be read. */
  text(page: number): Promise<PageText | null> {
    // A closed pool reads nothing more: an answer now, never a wait for ever
    // (0.3.96 retest: the sheet sweep held a closed pool and named one sheet).
    if (this.closed && !this.done.has(page)) return Promise.resolve(null)
    this.want([page], true)
    return this.slot(page).promise
  }

  /** Whether close() has been called: nothing more will be read. */
  get isClosed(): boolean { return this.closed }

  /** Whether a page has been read, or given up on. */
  settled(page: number): boolean {
    return this.done.has(page)
  }

  /** Pages given up on so far, with why. */
  unreadable(): Unreadable[] {
    return [...this.slots].filter(([p, s]) => this.done.has(p) && s.why !== null).map(([page, s]) => ({ page, why: s.why! }))
  }

  /** Read these pages, in this order, behind anything already asked for (or ahead of it, with `first`). */
  want(pages: readonly number[], first = false): void {
    if (this.closed) return
    if (first) {
      // Already waiting further back: moved to the front.
      const ahead = pages.filter((p) => this.queued.has(p))
      if (ahead.length > 0) {
        const move = new Set(ahead)
        const rest = this.queue.filter((p) => !move.has(p))
        this.queue.length = 0
        this.queue.push(...ahead, ...rest)
      }
    }
    const add = pages.filter((p) => !this.queued.has(p) && !this.done.has(p) && !this.inFlight.has(p))
    for (const p of add) { this.queued.add(p); this.slot(p) }
    if (first) this.queue.unshift(...add)
    else this.queue.push(...add)
    this.pump()
  }

  /** Stop every reader. Pages not yet read resolve null. */
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const s of this.sources) s?.close()
    for (const [p, s] of this.slots) if (!this.done.has(p)) s.resolve(null)
    this.queue.length = 0
    this.queued.clear()
  }

  // ------------------------------------------------------------------------

  private readonly done = new Set<number>()
  private readonly inFlight = new Set<number>()

  private slot(page: number): Slot {
    let s = this.slots.get(page)
    if (s === undefined) {
      let resolve!: (t: PageText | null) => void
      const promise = new Promise<PageText | null>((r) => { resolve = r })
      s = { promise, resolve, tries: 0, why: null }
      this.slots.set(page, s)
    }
    return s
  }

  private pump(): void {
    for (let lane = 0; lane < this.sources.length; lane++) {
      if (this.busy.has(lane) || this.queue.length === 0 || this.closed) continue
      this.busy.add(lane)
      void this.lane(lane).finally(() => { this.busy.delete(lane); this.pump() })
    }
  }

  private readonly busy = new Set<number>()

  private async lane(lane: number): Promise<void> {
    while (!this.closed) {
      const page = this.queue.shift()
      if (page === undefined) {
        // Nothing left to read: let the reader go. A PDFium worker holds
        // memory, and ten tabs each keeping four idle readers adds up.
        this.replace(lane)
        return
      }
      this.queued.delete(page)
      if (this.done.has(page)) continue
      this.inFlight.add(page)
      const slot = this.slot(page)
      slot.tries++
      let out: PageText | null = null
      let failed: string | null = null
      try {
        let src = this.sources[lane]
        if (src === null || src === undefined) { src = await this.opts.open(); this.sources[lane] = src }
        if (this.closed) { src.close(); return }
        const got = await this.within(src.textLayer(page))
        if (++this.reads[lane]! >= this.readsPerReader) this.replace(lane)
        if (got === undefined) {
          failed = `still being read after ${Math.round(this.stuckMs / 1000)} s`
          this.replace(lane)
        } else out = got
      } catch (e) {
        failed = e instanceof Error ? e.message : String(e)
        out = null
        // The reader may be gone with the page; a fresh one for what follows.
        this.replace(lane)
      }
      this.inFlight.delete(page)
      if (this.closed) return
      if (out !== null) {
        this.done.add(page)
        this.opts.onText?.(page, out)
        slot.resolve(out)
      } else if (slot.tries < 2 && !this.closed && !(failed ?? '').startsWith('still being read')) {
        // Once more, on a fresh reader, after what is already waiting.
        this.queued.add(page)
        this.queue.push(page)
      } else {
        this.done.add(page)
        slot.why = failed ?? 'could not be read'
        slot.resolve(null)
      }
    }
  }

  private replace(lane: number): void {
    this.sources[lane]?.close()
    this.sources[lane] = null
    this.reads[lane] = 0
  }

  private within<T>(job: Promise<T>): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve, reject) => {
      const timer = setTimeout(() => resolve(undefined), this.stuckMs)
      job.then((v) => { clearTimeout(timer); resolve(v) }, (e) => { clearTimeout(timer); reject(e) })
    })
  }
}
