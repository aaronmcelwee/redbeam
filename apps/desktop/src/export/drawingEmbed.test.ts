import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib'
import { ingestDocuments, migrate, SqlJsDriver, type Migration } from '@redbeam/store'
import {
  embedDrawing, embedMarkupsFor, embedStatus, foreignEdits, foreignEditsStatus, importSlice, migrateProjectTakeoffs, migrationStatus, MIGRATED_KEY,
  openingStatus, sliceTables, type DrawingFile,
} from './drawingEmbed.js'
import { readSheetEmbed } from './sheetEmbed.js'

const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(here, '..', '..', '..', '..', 'packages', 'store', 'migrations')
const loadMigrations = (): Migration[] => readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort().map((f) => {
  const m = /^(\d+)_([a-z0-9]+)\.sql$/i.exec(f)!
  return { version: Number(m[1]), name: m[2]!, sql: readFileSync(join(migrationsDir, f), 'utf8') }
})

const NOW = '2026-11-12T00:00:00.000Z'
const sq = (x0: number, y0: number, x1: number, y1: number) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]

async function freshDb(path = 'A-101.pdf'): Promise<{ db: SqlJsDriver, docId: string }> {
  const db = await SqlJsDriver.open()
  await migrate(db, loadMigrations())
  await ingestDocuments(db, [{
    relativePath: path, displayName: path, kind: 'drawing', status: 'current', sizeBytes: 1,
    contentFingerprint: 'fp', availability: 'local', pages: [{ pageNumber: 0, widthPdfPoints: 2592, heightPdfPoints: 1728 }],
  }])
  const row = await db.all<{ id: string }>('SELECT id FROM documents LIMIT 1')
  return { db, docId: row[0]!.id }
}

async function seedTakeoff(db: SqlJsDriver, docId: string): Promise<void> {
  const page = `${docId}-p0`
  await db.run(`INSERT INTO scopes(id,label,scope_type,color,specifications_json,created_at,updated_at)
    VALUES('s1','ACT-1 Ceiling','ceiling','#2f7fd1','{"tile":"2x2 secret layout"}',?,?)`, [NOW, NOW])
  await db.run(`INSERT INTO calibrations(id,document_id,page_id,feet_per_pdf_point,source,created_at,updated_at)
    VALUES('c1',?,?,?,'manual',?,?)`, [docId, page, 8 / 72, NOW, NOW])
  await db.run(`INSERT INTO markups(id,document_id,page_id,scope_id,kind,geometry_json,origin,created_at,updated_at)
    VALUES('m1',?,?,'s1','area',?,'user',?,?)`, [docId, page, JSON.stringify([sq(0.1, 0.2, 0.3, 0.4)]), NOW, NOW])
}

async function blankPdf(): Promise<Uint8Array> {
  const d = await PDFDocument.create()
  d.addPage([2592, 1728])
  return d.save()
}

/** An in-memory drawing whose version is a counter, so a second writer can be simulated. */
function memoryFile(bytes: Uint8Array): DrawingFile & { bytes: Uint8Array, writes: number, bump: () => void } {
  let version = 0
  const f = {
    bytes, writes: 0,
    bump: () => { version++ },
    read: async () => ({ bytes: f.bytes, version: String(version) }),
    write: async (b: Uint8Array, expected: string) => {
      if (expected !== String(version)) return false
      f.bytes = b; f.writes++; version++
      return true
    },
  }
  return f
}

describe('drawing embed', () => {
  let db: SqlJsDriver
  let docId: string
  beforeEach(async () => { ({ db, docId } = await freshDb()) })

  it('cuts this drawing\'s rows and turns them into Bluebeam markups with the net area', async () => {
    await seedTakeoff(db, docId)
    const tables = await sliceTables(db, docId)
    expect(tables.markups).toHaveLength(1)
    expect(tables.scopes).toHaveLength(1)
    expect(tables.documents?.[0]).not.toHaveProperty('content_fingerprint')
    const { markups, pageScales } = embedMarkupsFor(tables, docId)
    expect(pageScales.get(0)).toBeCloseTo(8 / 72)
    expect(markups[0]).toMatchObject({ id: 'm1', scopeLabel: 'ACT-1 Ceiling', kind: 'area' })
    // 0.2 x 0.2 of a 36 x 24 in sheet at 1 in = 8 ft: 57.6 ft x 38.4 ft.
    expect(markups[0]!.quantity).toBeCloseTo(57.6 * 38.4, 1)
  })

  it('leaves a drawing with no takeoff alone', async () => {
    const file = memoryFile(await blankPdf())
    const out = await embedDrawing({ db, documentId: docId, relativePath: 'A-101.pdf', displayName: 'A-101', appVersion: 't', file })
    expect(out.kind).toBe('nothing-to-embed')
    expect(file.writes).toBe(0)
  })

  it('writes once, then does nothing until the takeoff changes', async () => {
    await seedTakeoff(db, docId)
    const file = memoryFile(await blankPdf())
    const opts = { db, documentId: docId, relativePath: 'A-101.pdf', displayName: 'A-101', appVersion: 't', file }
    expect((await embedDrawing(opts)).kind).toBe('written')
    expect((await embedDrawing(opts)).kind).toBe('unchanged')
    await db.run(`UPDATE markups SET geometry_json = ? WHERE id = 'm1'`, [JSON.stringify([sq(0.1, 0.2, 0.4, 0.4)])])
    expect((await embedDrawing(opts)).kind).toBe('written')
    expect(file.writes).toBe(2)
    const reading = await readSheetEmbed(file.bytes)
    expect(reading.redbeamAnnots).toHaveLength(1)
  })

  it('does not write over a file another program changed in between', async () => {
    await seedTakeoff(db, docId)
    const file = memoryFile(await blankPdf())
    const realRead = file.read
    file.read = async () => { const r = await realRead(); file.bump(); return r }
    const out = await embedDrawing({ db, documentId: docId, relativePath: 'A-101.pdf', displayName: 'A-101', appVersion: 't', file })
    expect(out.kind).toBe('busy')
    expect(file.writes).toBe(0)
    expect(embedStatus(out, 'A-101')).toMatch(/not saved into it/)
  })

  it('brings an embedded takeoff into another project that has none for the drawing', async () => {
    await seedTakeoff(db, docId)
    const file = memoryFile(await blankPdf())
    await embedDrawing({ db, documentId: docId, relativePath: 'A-101.pdf', displayName: 'A-101', appVersion: 't', file })

    const other = await freshDb('Arch/A-101 rev2.pdf')
    expect(other.docId).not.toBe(docId)
    const reading = await readSheetEmbed(file.bytes)
    const imported = await importSlice(other.db, other.docId, reading.slice!)
    expect(imported).toEqual({ markups: 1, scopes: 1 })
    const rows = await other.db.all<{ page_id: string, scope_id: string }>('SELECT page_id, scope_id FROM markups')
    expect(rows).toEqual([{ page_id: `${other.docId}-p0`, scope_id: 's1' }])
    const spec = await other.db.all<{ s: string }>('SELECT specifications_json AS s FROM scopes')
    expect(spec[0]!.s).toContain('secret layout')
    expect(openingStatus(reading, imported, 'A-101')).toMatch(/loaded 1 markup/)

    // A database that already has markups for the drawing is never touched.
    expect(await importSlice(other.db, other.docId, reading.slice!)).toBeNull()
  })
})

describe('opening an older project', () => {
  let db: SqlJsDriver
  let docId: string
  beforeEach(async () => { ({ db, docId } = await freshDb()) })

  const docs = (id: string, extra: Record<string, unknown> = {}) => [{ id, relativePath: 'A-101.pdf', displayName: 'A-101', ...extra }]

  it('carries a takeoff that lives only in redbeam.db into the PDF, and keeps the database', async () => {
    await seedTakeoff(db, docId)
    const file = memoryFile(await blankPdf())
    expect((await readSheetEmbed(file.bytes)).slice).toBeNull()

    const result = await migrateProjectTakeoffs({ db, documents: docs(docId), appVersion: 't', fileFor: () => file })
    expect(result.written).toEqual(['A-101'])
    expect(migrationStatus(result)).toMatch(/older takeoff saved into A-101/)

    const reading = await readSheetEmbed(file.bytes)
    expect(reading.slice?.tables.markups).toHaveLength(1)
    expect(reading.redbeamAnnots).toHaveLength(1)
    // redbeam.db is untouched: the embed is a copy.
    const left = await db.all<{ n: number }>('SELECT COUNT(*) AS n FROM markups WHERE deleted_at IS NULL')
    expect(left[0]!.n).toBe(1)
    const meta = await db.all<{ value: string }>('SELECT value FROM redbeam_meta WHERE key = ?', [MIGRATED_KEY])
    expect(JSON.parse(meta[0]!.value)).toEqual([docId])
  })

  it('does it once: a second open neither reads nor writes the drawing', async () => {
    await seedTakeoff(db, docId)
    const file = memoryFile(await blankPdf())
    let reads = 0
    const realRead = file.read
    file.read = async () => { reads++; return realRead() }
    await migrateProjectTakeoffs({ db, documents: docs(docId), appVersion: 't', fileFor: () => file })
    const again = await migrateProjectTakeoffs({ db, documents: docs(docId), appVersion: 't', fileFor: () => file })
    expect(again).toEqual({ written: [], retry: [] })
    expect(migrationStatus(again)).toBeNull()
    expect(file.writes).toBe(1)
    expect(reads).toBe(1)
  })

  it('tries a drawing again next time when it could not be written, and loses nothing', async () => {
    await seedTakeoff(db, docId)
    const file = memoryFile(await blankPdf())
    const original = file.bytes
    const realRead = file.read
    file.read = async () => { const r = await realRead(); file.bump(); return r }
    const first = await migrateProjectTakeoffs({ db, documents: docs(docId), appVersion: 't', fileFor: () => file })
    expect(first.retry.map((r) => r.outcome.kind)).toEqual(['busy'])
    expect(migrationStatus(first)).toMatch(/try again next time/)
    expect(file.bytes).toBe(original)
    expect(await db.all('SELECT value FROM redbeam_meta WHERE key = ?', [MIGRATED_KEY])).toEqual([])

    file.read = realRead
    const second = await migrateProjectTakeoffs({ db, documents: docs(docId), appVersion: 't', fileFor: () => file })
    expect(second.written).toEqual(['A-101'])
  })

  it('reports a write that fails outright and leaves the file as it was', async () => {
    await seedTakeoff(db, docId)
    const file: DrawingFile = {
      read: async () => ({ bytes: await blankPdf(), version: '0' }),
      write: async () => { throw new Error('disk full') },
    }
    const out = await migrateProjectTakeoffs({ db, documents: docs(docId), appVersion: 't', fileFor: () => file })
    expect(out.retry).toEqual([{ name: 'A-101', outcome: { kind: 'failed', message: 'disk full' } }])
  })

  it('skips drawings with no takeoff, and missing files, without reading them', async () => {
    const file = memoryFile(await blankPdf())
    let reads = 0
    file.read = async () => { reads++; return { bytes: file.bytes, version: '0' } }
    await migrateProjectTakeoffs({ db, documents: docs(docId), appVersion: 't', fileFor: () => file })
    await seedTakeoff(db, docId)
    await migrateProjectTakeoffs({ db, documents: docs(docId, { missing: true }), appVersion: 't', fileFor: () => file })
    expect(reads).toBe(0)
  })

  it('leaves an already-embedded drawing byte-for-byte alone and marks it done', async () => {
    await seedTakeoff(db, docId)
    const file = memoryFile(await blankPdf())
    await embedDrawing({ db, documentId: docId, relativePath: 'A-101.pdf', displayName: 'A-101', appVersion: 't', file })
    const out = await migrateProjectTakeoffs({ db, documents: docs(docId), appVersion: 't', fileFor: () => file })
    expect(out).toEqual({ written: [], retry: [] })
    expect(file.writes).toBe(1)
    const meta = await db.all<{ value: string }>('SELECT value FROM redbeam_meta WHERE key = ?', [MIGRATED_KEY])
    expect(JSON.parse(meta[0]!.value)).toEqual([docId])
  })

  it('queues each write through the caller\'s per-drawing lock', async () => {
    await seedTakeoff(db, docId)
    const file = memoryFile(await blankPdf())
    const locked: string[] = []
    await migrateProjectTakeoffs({
      db, documents: docs(docId), appVersion: 't', fileFor: () => file,
      exclusive: async (id, task) => { locked.push(id); return task() },
    })
    expect(locked).toEqual([docId])
    expect(file.writes).toBe(1)
  })
})

/** Edit one REDBEAM annotation the way Bluebeam would: same /NM, new geometry. */
async function editInBluebeam(bytes: Uint8Array, nm: string, edit: { vertices?: number[], cutouts?: number[][] }): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  const annots = doc.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray)
  for (let i = 0; i < annots.size(); i++) {
    const a = annots.lookup(i, PDFDict)
    const v = a.lookup(PDFName.of('NM'))
    if (!(v instanceof PDFString || v instanceof PDFHexString) || v.decodeText() !== nm) continue
    if (edit.vertices !== undefined) a.set(PDFName.of('Vertices'), doc.context.obj(edit.vertices))
    if (edit.cutouts !== undefined) a.set(PDFName.of('Cutouts'), doc.context.obj(edit.cutouts))
  }
  return doc.save()
}

const rowsOf = (db: SqlJsDriver) =>
  db.all<{ id: string, kind: string, scope_id: string | null, geometry_json: string }>(
    'SELECT id, kind, scope_id, geometry_json FROM markups WHERE deleted_at IS NULL ORDER BY id')

describe('round trip with Bluebeam', () => {
  let db: SqlJsDriver
  let docId: string
  beforeEach(async () => { ({ db, docId } = await freshDb()) })

  async function addCutout(id: string, ring: Array<{ x: number, y: number }>): Promise<void> {
    await db.run(`INSERT INTO markups(id,document_id,page_id,scope_id,kind,geometry_json,origin,created_at,updated_at)
      VALUES(?,?,?,'s1','cutout',?,'user',?,?)`, [id, docId, `${docId}-p0`, JSON.stringify([ring]), NOW, NOW])
  }

  it('folds a separate cutout into the area it overlaps, as one Bluebeam area with a net quantity', async () => {
    await seedTakeoff(db, docId)
    await db.run(`UPDATE markups SET geometry_json = ? WHERE id = 'm1'`,
      [JSON.stringify([sq(0.1, 0.2, 0.3, 0.4), sq(0.12, 0.22, 0.14, 0.24)])])
    await addCutout('k1', sq(0.2, 0.3, 0.25, 0.35))
    await addCutout('k2', sq(0.7, 0.7, 0.8, 0.8))
    const { markups } = embedMarkupsFor(await sliceTables(db, docId), docId)
    const area = markups.find((m) => m.id === 'm1')!
    expect(area.cutouts).toHaveLength(2)
    expect(area.folded).toEqual(['k1'])
    const gross = 57.6 * 38.4
    const ftPerUnit = { x: 57.6 / 0.2, y: 38.4 / 0.2 }
    const hole = (w: number, h: number) => w * ftPerUnit.x * h * ftPerUnit.y
    expect(area.quantity).toBeCloseTo(gross - hole(0.02, 0.02) - hole(0.05, 0.05), 1)
    expect(markups.map((m) => m.id).sort()).toEqual(['k2', 'm1'])
  })

  it('writes the holes as Revu /Cutouts, filled even-odd, and reads them back as rings', async () => {
    await seedTakeoff(db, docId)
    await addCutout('k1', sq(0.2, 0.3, 0.25, 0.35))
    const file = memoryFile(await blankPdf())
    await embedDrawing({ db, documentId: docId, relativePath: 'A-101.pdf', displayName: 'A-101', appVersion: 't', file })
    const reading = await readSheetEmbed(file.bytes)
    expect(reading.redbeamAnnots).toHaveLength(1)
    const a = reading.redbeamAnnots[0]!
    expect(a.cutouts).toHaveLength(1)
    expect(a.rings).toHaveLength(2)
    expect(a.rings[1]![0]!.x).toBeCloseTo(0.2, 4)
    expect(a.rings[1]![0]!.y).toBeCloseTo(0.3, 4)
    expect(reading.slice!.annots[a.nm]!.folded).toEqual(['k1'])
  })

  it('brings a shape and cutouts changed in Bluebeam back as an edit, and absorbs folded cutouts', async () => {
    await seedTakeoff(db, docId)
    await addCutout('k1', sq(0.2, 0.3, 0.25, 0.35))
    const file = memoryFile(await blankPdf())
    const opts = { db, documentId: docId, relativePath: 'A-101.pdf', displayName: 'A-101', appVersion: 't', file }
    await embedDrawing(opts)
    const before = await readSheetEmbed(file.bytes)
    const nm = before.redbeamAnnots[0]!.nm
    // 2592 x 1728 page: x 0.1..0.4 → 259.2..1036.8; y 0.2..0.4 down → 1382.4..1036.8 up.
    file.bytes = await editInBluebeam(file.bytes, nm, {
      vertices: [259.2, 1382.4, 1036.8, 1382.4, 1036.8, 1036.8, 259.2, 1036.8],
      cutouts: [[518.4, 1209.6, 648, 1209.6, 648, 1123.2, 518.4, 1123.2], [800, 1300, 900, 1300, 900, 1200]],
    })
    const pulled = foreignEdits(await readSheetEmbed(file.bytes), await rowsOf(db))
    expect(pulled.conflicts).toEqual([])
    expect(pulled.absorbed).toEqual(['k1'])
    expect(pulled.edits).toHaveLength(1)
    const after = pulled.edits[0]!.after
    expect(after).toHaveLength(3)
    expect(after[0]![1]!.x).toBeCloseTo(0.4, 4)
    expect(after[1]![0]!.x).toBeCloseTo(0.2, 4)
    expect(foreignEditsStatus(pulled, 'A-101')).toMatch(/1 markup changed in Bluebeam/)

    // Once REDBEAM adopts the edit, the next save writes REDBEAM's version, and
    // reading it again finds nothing new.
    await db.run(`UPDATE markups SET geometry_json = ? WHERE id = 'm1'`, [JSON.stringify(after)])
    await db.run(`UPDATE markups SET deleted_at = ? WHERE id = 'k1'`, [NOW])
    expect((await embedDrawing(opts)).kind).toBe('written')
    const again = await readSheetEmbed(file.bytes)
    expect(again.redbeamAnnots).toHaveLength(1)
    expect(again.redbeamAnnots[0]!.cutouts).toHaveLength(2)
    expect(foreignEdits(again, await rowsOf(db)).edits).toEqual([])
  })

  it('keeps REDBEAM\'s version when the markup changed on both sides', async () => {
    await seedTakeoff(db, docId)
    const file = memoryFile(await blankPdf())
    await embedDrawing({ db, documentId: docId, relativePath: 'A-101.pdf', displayName: 'A-101', appVersion: 't', file })
    const nm = (await readSheetEmbed(file.bytes)).redbeamAnnots[0]!.nm
    file.bytes = await editInBluebeam(file.bytes, nm, { cutouts: [[518.4, 1209.6, 648, 1209.6, 648, 1123.2]] })
    await db.run(`UPDATE markups SET geometry_json = ? WHERE id = 'm1'`, [JSON.stringify([sq(0.1, 0.2, 0.5, 0.4)])])
    const pulled = foreignEdits(await readSheetEmbed(file.bytes), await rowsOf(db))
    expect(pulled.edits).toEqual([])
    expect(pulled.conflicts).toEqual(['m1'])
    expect(foreignEditsStatus(pulled, 'A-101')).toMatch(/both here and in Bluebeam/)
  })

  it('finds nothing to bring in from a drawing nobody touched', async () => {
    await seedTakeoff(db, docId)
    const file = memoryFile(await blankPdf())
    await embedDrawing({ db, documentId: docId, relativePath: 'A-101.pdf', displayName: 'A-101', appVersion: 't', file })
    const pulled = foreignEdits(await readSheetEmbed(file.bytes), await rowsOf(db))
    expect(pulled).toEqual({ edits: [], absorbed: [], conflicts: [] })
    expect(foreignEditsStatus(pulled, 'A-101')).toBeNull()
  })
})
