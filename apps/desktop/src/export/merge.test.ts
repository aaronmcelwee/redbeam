/**
 * A REDBEAM PDF that went through Bluebeam's page tools.
 *
 * Reported 2026-11-24: a tester merged a PDF carrying a REDBEAM takeoff with
 * another PDF in Bluebeam. Bluebeam still showed the markups; REDBEAM said
 * "Part of the takeoff inside CLG-04, CLG-05 Takeoffs.pdf could not be loaded
 * (19 items)" and logged "UNIQUE constraint failed: pages.document_id,
 * pages.page_number". The merged file has a new name, so a new document id,
 * and the slice's page rows kept the old one while their markups took the new.
 *
 * These build the merge the way Bluebeam does it (pages copied whole into
 * another file, the takeoff file's own catalog kept or lost) and open the
 * result the way a Light window does: an empty store, the sheets' rows made
 * as they are looked at.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib'
import { ensureDocumentAndPage, ingestDocuments, migrate, SqlJsDriver, type Migration } from '@redbeam/store'
import { embedDrawing, fileLoadVerdict, importSlice, type DrawingFile } from './drawingEmbed.js'
import { readSheetEmbed } from './sheetEmbed.js'

const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(here, '..', '..', '..', '..', 'packages', 'store', 'migrations')
const MIGRATIONS: Migration[] = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort().map((f) => {
  const m = /^(\d+)_([a-z0-9]+)\.sql$/i.exec(f)!
  return { version: Number(m[1]), name: m[2]!, sql: readFileSync(join(migrationsDir, f), 'utf8') }
})

const NOW = '2026-11-24T12:00:00.000Z'
const FPP = 8 / 72
const sq = (x0: number, y0: number, x1: number, y1: number) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]

/** A Light window's store for one PDF: the document, and no sheets until they are looked at. */
async function lightStore(path: string): Promise<{ db: SqlJsDriver, docId: string }> {
  const db = await SqlJsDriver.open()
  await migrate(db, MIGRATIONS)
  await ingestDocuments(db, [{
    relativePath: path, displayName: path, kind: 'drawing', status: 'current', sizeBytes: 1,
    contentFingerprint: path, availability: 'local', pages: [],
  }])
  const row = await db.all<{ id: string }>('SELECT id FROM documents LIMIT 1')
  await db.run('DELETE FROM pages')
  return { db, docId: row[0]!.id }
}

/** A drawing set of `n` sheets; `size` tells the sets apart. */
async function sheets(n: number, size: [number, number] = [2592, 1728]): Promise<Uint8Array> {
  const d = await PDFDocument.create()
  for (let i = 0; i < n; i++) d.addPage(size)
  return d.save({ addDefaultPage: false })
}

function memoryFile(bytes: Uint8Array): DrawingFile & { bytes: Uint8Array } {
  let version = 0
  const f = {
    bytes,
    read: async () => ({ bytes: f.bytes, version: String(version) }),
    write: async (b: Uint8Array, expected: string) => {
      if (expected !== String(version)) return false
      f.bytes = b; version++
      return true
    },
  }
  return f
}

interface Drawn { page: number, scope: string, rect: [number, number, number, number], kind?: 'area' | 'polyline' }

/**
 * A marked-up PDF, saved by REDBEAM. `legacy` strips the per-sheet copies, as
 * a file saved by 0.3.58 and earlier carries none.
 */
async function markedUp(path: string, pageCount: number, drawn: Drawn[], opts: { legacy?: boolean, size?: [number, number] } = {}) {
  const { db, docId } = await lightStore(path)
  const scopes = new Map<string, string>()
  for (const d of drawn) {
    for (let p = 0; p < pageCount; p++) {
      await ensureDocumentAndPage(db, { id: docId, relativePath: path, displayName: path },
        { id: `${docId}-p${p}`, documentId: docId, pageNumber: p, width: opts.size?.[0] ?? 2592, height: opts.size?.[1] ?? 1728 })
    }
    let scopeId = scopes.get(d.scope)
    if (scopeId === undefined) {
      scopeId = `sc-${path}-${scopes.size}`
      scopes.set(d.scope, scopeId)
      await db.run(`INSERT INTO scopes(id,label,scope_type,color,specifications_json,created_at,updated_at)
        VALUES(?,?,'area','#2f7fd1','{"spec":"kept"}',?,?)`, [scopeId, d.scope, NOW, NOW])
    }
    await db.run(`INSERT OR IGNORE INTO calibrations(id,document_id,page_id,feet_per_pdf_point,source,created_at,updated_at)
      VALUES(?,?,?,?,'manual',?,?)`, [`cal-${path}-${d.page}`, docId, `${docId}-p${d.page}`, FPP, NOW, NOW])
    const [x0, y0, x1, y1] = d.rect
    const geometry = d.kind === 'polyline' ? [[{ x: x0, y: y0 }, { x: x1, y: y1 }]] : [sq(x0, y0, x1, y1)]
    await db.run(`INSERT INTO markups(id,document_id,page_id,scope_id,kind,geometry_json,origin,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'user',?,?)`,
    [`m-${path}-${d.page}-${d.rect.join('_')}`, docId, `${docId}-p${d.page}`, scopeId, d.kind ?? 'area', JSON.stringify(geometry), NOW, NOW])
  }
  const file = memoryFile(await sheets(pageCount, opts.size))
  const out = await embedDrawing({ db, documentId: docId, relativePath: path, displayName: path, appVersion: 't', file, allScopes: true })
  expect(out.kind).toBe('written')
  if (opts.legacy === true) {
    const d = await PDFDocument.load(file.bytes, { updateMetadata: false })
    for (const page of d.getPages()) page.node.delete(PDFName.of('PieceInfo'))
    return d.save()
  }
  return file.bytes
}

/**
 * Bluebeam's Combine / Insert Pages: `into`'s catalog stays, and the given
 * pages of each source are copied in whole, annotations and all, in order.
 */
async function combine(into: Uint8Array, parts: Array<{ bytes: Uint8Array, pages?: number[] }>, keepOwn: number[] | null = null): Promise<Uint8Array> {
  const out = await PDFDocument.load(into, { updateMetadata: false })
  const own = out.getPageCount()
  const keep = keepOwn ?? Array.from({ length: own }, (_, i) => i)
  for (const part of parts) {
    const src = await PDFDocument.load(part.bytes, { updateMetadata: false })
    const pick = part.pages ?? src.getPageIndices()
    for (const p of await out.copyPages(src, pick)) out.addPage(p)
  }
  // The catalog's own sheets that are not kept go; their order is `keep`.
  const pages = out.getPages()
  const moved = [...keep.map((i) => pages[i]!), ...pages.slice(own)]
  for (let i = out.getPageCount() - 1; i >= 0; i--) out.removePage(i)
  for (const p of moved) out.addPage(p)
  return out.save()
}

/** Open a PDF in a fresh Light window: read, import, then look at every sheet. */
async function openInLight(bytes: Uint8Array, path: string) {
  const { db, docId } = await lightStore(path)
  const reading = await readSheetEmbed(bytes)
  const imported = reading.slice === null ? null : await importSlice(db, docId, reading.slice)
  const verdict = fileLoadVerdict(reading, imported, path)
  // Paging through the sheets makes their rows; 0.3.58 failed here with UNIQUE(document_id, page_number).
  const count = (await PDFDocument.load(bytes)).getPageCount()
  for (let p = 0; p < count; p++) {
    await ensureDocumentAndPage(db, { id: docId, relativePath: path, displayName: path },
      { id: `${docId}-p${p}`, documentId: docId, pageNumber: p, width: 2592, height: 1728 })
  }
  const markups = await db.all<{ page_id: string, label: string, kind: string, geometry_json: string }>(
    `SELECT m.page_id, s.label, m.kind, m.geometry_json FROM markups m LEFT JOIN scopes s ON s.id = m.scope_id
      WHERE m.deleted_at IS NULL ORDER BY m.page_id, m.geometry_json`)
  const where = markups.map((m) => ({ page: Number(m.page_id.slice(`${docId}-p`.length)), label: m.label, x0: JSON.parse(m.geometry_json)[0][0].x as number }))
  const cal = await db.all<{ page_id: string }>('SELECT page_id FROM calibrations ORDER BY page_id')
  return {
    db, docId, reading, imported, verdict, where,
    calibrated: cal.map((c) => Number(c.page_id.slice(`${docId}-p`.length))).sort((a, b) => a - b),
    scopes: (await db.all<{ label: string, s: string }>('SELECT label, specifications_json AS s FROM scopes ORDER BY label')),
  }
}

const KENNETH: Drawn[] = [
  { page: 0, scope: 'ACT-1', rect: [0.1, 0.1, 0.2, 0.2] },
  { page: 0, scope: 'ACT-1', rect: [0.3, 0.1, 0.4, 0.2] },
  { page: 1, scope: 'GWB Soffit', rect: [0.5, 0.5, 0.6, 0.6] },
  { page: 1, scope: 'Wall base', rect: [0.1, 0.8, 0.9, 0.8], kind: 'polyline' },
]

describe.each([
  ['saved by 0.3.58 (one copy for the whole file)', true],
  ['saved with a copy on each sheet', false],
])('a takeoff %s, after Bluebeam', (_name, legacy) => {
  it('opens under a new name with nothing moved', async () => {
    const bytes = await markedUp('CLG-04 Takeoffs.pdf', 2, KENNETH, { legacy })
    const opened = await openInLight(bytes, 'CLG-04, CLG-05 Takeoffs.pdf')
    expect(opened.verdict).toEqual({ state: 'loaded' })
    expect(opened.where.map((w) => w.page)).toEqual([0, 0, 1, 1])
    expect(opened.calibrated).toEqual([0, 1])
  })

  it('loads when another set was merged in after it (its own catalog kept)', async () => {
    const takeoff = await markedUp('CLG-04 Takeoffs.pdf', 2, KENNETH, { legacy })
    const merged = await combine(takeoff, [{ bytes: await sheets(3) }])
    const opened = await openInLight(merged, 'CLG-04, CLG-05 Takeoffs.pdf')
    expect(opened.verdict).toEqual({ state: 'loaded' })
    expect(opened.imported?.skipped).toBeUndefined()
    expect(opened.where.map((w) => w.page)).toEqual([0, 0, 1, 1])
    expect(opened.scopes.map((s) => s.label)).toEqual(['ACT-1', 'GWB Soffit', 'Wall base'])
    expect(opened.scopes[0]!.s).toContain('kept')
  })

  it('loads on the right sheets when merged in after another set (its catalog lost)', async () => {
    const takeoff = await markedUp('CLG-05 Takeoffs.pdf', 2, KENNETH, { legacy })
    const merged = await combine(await sheets(3), [{ bytes: takeoff }])
    const opened = await openInLight(merged, 'CLG-04, CLG-05 Takeoffs.pdf')
    expect(opened.verdict).toEqual({ state: 'loaded' })
    expect(opened.where.map((w) => w.page)).toEqual([3, 3, 4, 4])
    expect(opened.calibrated).toEqual([3, 4])
    expect(opened.reading.rebound).toMatchObject({ moved: 4, leftBehind: 0 })
  })

  it('joins two marked-up sets, same-named scopes becoming one', async () => {
    const a = await markedUp('CLG-04 Takeoffs.pdf', 2, KENNETH.slice(0, 3), { legacy })
    const b = await markedUp('CLG-05 Takeoffs.pdf', 2, [
      { page: 0, scope: 'ACT-1', rect: [0.6, 0.6, 0.7, 0.7] },
      { page: 1, scope: 'Baffles', rect: [0.2, 0.2, 0.25, 0.25] },
    ], { legacy })
    const merged = await combine(a, [{ bytes: b }])
    const opened = await openInLight(merged, 'CLG-04, CLG-05 Takeoffs.pdf')
    expect(opened.verdict).toEqual({ state: 'loaded' })
    expect(opened.where.map((w) => [w.page, w.label])).toEqual([
      [0, 'ACT-1'], [0, 'ACT-1'], [1, 'GWB Soffit'], [2, 'ACT-1'], [3, 'Baffles'],
    ])
    expect(opened.scopes.map((s) => s.label)).toEqual(['ACT-1', 'Baffles', 'GWB Soffit'])
    expect(opened.calibrated).toEqual([0, 1, 2, 3])
  })

  it('follows sheets reordered, and lets go of a deleted one', async () => {
    const takeoff = await markedUp('A.pdf', 3, [
      { page: 0, scope: 'ACT-1', rect: [0.1, 0.1, 0.2, 0.2] },
      { page: 1, scope: 'ACT-1', rect: [0.3, 0.3, 0.4, 0.4] },
      { page: 2, scope: 'ACT-1', rect: [0.5, 0.5, 0.6, 0.6] },
    ], { legacy })
    // Sheet 2 to the front, sheet 0 deleted.
    const edited = await combine(takeoff, [], [2, 1])
    const opened = await openInLight(edited, 'A.pdf')
    expect(opened.verdict).toEqual({ state: 'loaded' })
    expect(opened.where.map((w) => [w.page, w.x0])).toEqual([[0, 0.5], [1, 0.3]])
    expect(opened.reading.rebound).toMatchObject({ leftBehind: 1 })
  })

  it('saves the merged file back in order, so the next open needs no matching', async () => {
    const takeoff = await markedUp('CLG-05 Takeoffs.pdf', 2, KENNETH, { legacy })
    const merged = await combine(await sheets(3), [{ bytes: takeoff }])
    const opened = await openInLight(merged, 'Merged.pdf')
    const file = memoryFile(merged)
    const out = await embedDrawing({
      db: opened.db, documentId: opened.docId, relativePath: 'Merged.pdf', displayName: 'Merged.pdf', appVersion: 't', file, allScopes: true,
    })
    expect(out.kind).toBe('written')
    const again = await readSheetEmbed(file.bytes)
    expect(again.rebound ?? null).toBeNull()
    expect(again.redbeamAnnots.map((a) => a.pageIndex).sort()).toEqual([3, 3, 4, 4])
    // Each sheet with takeoff now carries its own copy.
    const doc = await PDFDocument.load(file.bytes)
    const carries = doc.getPages().map((p) => p.node.lookup(PDFName.of('PieceInfo')) instanceof PDFDict)
    expect(carries).toEqual([false, false, false, true, true])
    // And the save after that has nothing to write.
    const twice = await embedDrawing({
      db: opened.db, documentId: opened.docId, relativePath: 'Merged.pdf', displayName: 'Merged.pdf', appVersion: 't', file, allScopes: true,
    })
    expect(twice.kind).toBe('unchanged')
  })
})

describe('a sheet extracted on its own', () => {
  it('keeps its takeoff even with every file-wide copy gone', async () => {
    const takeoff = await markedUp('A.pdf', 2, KENNETH)
    // Extract sheet 1 into a new file, then drop the annotations' private keys as well.
    const one = await combine(await sheets(0), [{ bytes: takeoff, pages: [1] }])
    const d = await PDFDocument.load(one)
    for (const page of d.getPages()) {
      const arr = page.node.lookup(PDFName.of('Annots'))
      if (arr === undefined) continue
      for (const a of (arr as unknown as { asArray: () => unknown[] }).asArray()) {
        const dict = d.context.lookup(a as never)
        if (dict instanceof PDFDict) dict.delete(PDFName.of('REDBEAM'))
      }
    }
    const opened = await openInLight(await d.save(), 'A-sheet2.pdf')
    expect(opened.verdict).toEqual({ state: 'loaded' })
    expect(opened.reading.source).toBe('page')
    expect(opened.where.map((w) => [w.page, w.label]).sort()).toEqual([[0, 'GWB Soffit'], [0, 'Wall base']])
    expect(opened.calibrated).toEqual([0])
  })
})

describe('a page copy left stale by an older REDBEAM', () => {
  it('is ignored when the file-wide slice was saved after it without listing it', async () => {
    const takeoff = await markedUp('A.pdf', 2, KENNETH)
    // 0.3.58 saving over it: a new catalog slice with no pageHashes, written later; the page copies stay.
    const reading = await readSheetEmbed(takeoff)
    expect(reading.slice?.pageHashes?.length).toBe(2)
    const d = await PDFDocument.load(takeoff, { updateMetadata: false })
    const p1 = d.getPages()[1]!.node
    // Remove sheet 1's markups from the file-wide copy as if deleted there, and mark it newer.
    const { slice } = reading
    const older = { ...slice!, writtenAt: '2099-01-01T00:00:00.000Z', pageHashes: undefined,
      tables: { ...slice!.tables, markups: (slice!.tables.markups ?? []).filter((m) => !String(m.page_id).endsWith('-p1')) } }
    const ref = d.context.register(d.context.flateStream(JSON.stringify(older)))
    const pi = d.catalog.lookup(PDFName.of('PieceInfo'), PDFDict).lookup(PDFName.of('REDBEAM'), PDFDict).lookup(PDFName.of('Private'), PDFDict)
    pi.set(PDFName.of('Slice'), ref)
    // ...and that save took sheet 1's annotations off.
    p1.delete(PDFName.of('Annots'))
    const opened = await openInLight(await d.save(), 'A.pdf')
    expect(opened.where.map((w) => w.page)).toEqual([0, 0])
  })
})

describe('what REDBEAM says on opening a merged file', () => {
  it('names the join and what was left out', async () => {
    const { openingStatus } = await import('./drawingEmbed.js')
    const a = await markedUp('CLG-04 Takeoffs.pdf', 2, KENNETH.slice(0, 3), { legacy: true })
    const b = await markedUp('CLG-05 Takeoffs.pdf', 1, [{ page: 0, scope: 'ACT-1', rect: [0.6, 0.6, 0.7, 0.7] }], { legacy: true })
    const merged = await combine(a, [{ bytes: b }], [1])
    const opened = await openInLight(merged, 'CLG-04, CLG-05 Takeoffs.pdf')
    expect(openingStatus(opened.reading, opened.imported, 'CLG-04, CLG-05 Takeoffs.pdf')).toBe(
      'CLG-04, CLG-05 Takeoffs.pdf joins the takeoffs of 2 REDBEAM PDFs: 2 markups on the sheets where they are now. 1 scope with the same name joined. 2 markups were on sheets no longer in the PDF and left out. The next save keeps it this way')
  })
})
