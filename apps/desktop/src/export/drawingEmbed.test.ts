import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib'
import { ingestDocuments, migrate, SqlJsDriver, type Migration } from '@redbeam/store'
import type { Markup } from '@redbeam/domain'
import { cutoutsOf } from '../cutouts.js'
import {
  copyName, embedCopy, embedDrawing, embedMarkupsFor, embedStatus, ensureFileRound, fileLoadVerdict, foreignEdits, foreignEditsStatus, importScopesFromSlice, importSlice, importTakeoffFromSlice, takeoffImportStatus,
  migrateProjectTakeoffs, migrationStatus, MIGRATED_KEY, openingStatus, rebuildFromAnnots, rebuiltStatus, scopeImportStatus, sliceTables, takeNewerSlice, unsavedReason,
  type DrawingFile,
} from './drawingEmbed.js'
import { parseSlice, readSheetEmbed, sliceStamp, SLICE_FORMAT, SLICE_VERSION, type SheetEmbedReading } from './sheetEmbed.js'

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

describe('light mode files', () => {
  let db: SqlJsDriver
  let docId: string
  beforeEach(async () => { ({ db, docId } = await freshDb()) })

  const addScope = (id: string, label: string) => db.run(
    `INSERT INTO scopes(id,label,scope_type,color,specifications_json,created_at,updated_at) VALUES(?,?,'ceiling','#123456','{"k":"v"}',?,?)`,
    [id, label, NOW, NOW])

  it('carries a scope with nothing drawn yet when the whole store is the file', async () => {
    await addScope('s-empty', 'GWB soffit')
    expect((await sliceTables(db, docId)).scopes).toHaveLength(0)
    expect((await sliceTables(db, docId, { allScopes: true })).scopes).toHaveLength(1)

    const file = memoryFile(await blankPdf())
    const pro = await embedDrawing({ db, documentId: docId, relativePath: 'A-101.pdf', displayName: 'A-101', appVersion: 't', file })
    expect(pro.kind).toBe('nothing-to-embed')
    const out = await embedDrawing({
      db, documentId: docId, relativePath: 'A-101.pdf', displayName: 'A-101', appVersion: 't', file, allScopes: true,
    })
    expect(out.kind).toBe('written')
    const reading = await readSheetEmbed(file.bytes)
    expect(reading.slice?.tables.scopes?.map((r) => r.label)).toEqual(['GWB soffit'])

    // Reopened in Light: a fresh in-memory store takes the scope back.
    const next = await freshDb()
    expect(await importSlice(next.db, next.docId, reading.slice!)).toEqual({ markups: 0, scopes: 1 })
  })

  it('makes one round for the file and puts every scope in it', async () => {
    await addScope('s1', 'ACT-1')
    const id = await ensureFileRound(db, 'A-101')
    await addScope('s2', 'ACT-2')
    expect(await ensureFileRound(db, 'ignored')).toBe(id)
    const rounds = await db.all<{ name: string }>('SELECT name FROM estimates')
    expect(rounds).toEqual([{ name: 'A-101' }])
    const linked = await db.all<{ scope_id: string }>('SELECT scope_id FROM estimate_scopes WHERE estimate_id = ? ORDER BY scope_id', [id])
    expect(linked.map((r) => r.scope_id)).toEqual(['s1', 's2'])
  })

  it('imports another PDF\'s scopes without its markups, under new ids, skipping names already here', async () => {
    await seedTakeoff(db, docId)
    await addScope('s-two', 'Wall panels')
    const file = memoryFile(await blankPdf())
    await embedDrawing({ db, documentId: docId, relativePath: 'A-101.pdf', displayName: 'A-101', appVersion: 't', file, allScopes: true })
    const slice = (await readSheetEmbed(file.bytes)).slice!

    const target = await freshDb('Round 2/A-101.pdf')
    await target.db.run(`INSERT INTO scopes(id,label,scope_type,color,specifications_json,created_at,updated_at)
      VALUES('mine','wall PANELS','wall','#000000','{}',?,?)`, [NOW, NOW])
    const result = await importScopesFromSlice(target.db, slice)
    expect(result).toEqual({ added: ['ACT-1 Ceiling'], skipped: ['Wall panels'] })
    const scopes = await target.db.all<{ id: string, label: string, specifications_json: string }>(
      'SELECT id, label, specifications_json FROM scopes ORDER BY label')
    const act = scopes.find((r) => r.label === 'ACT-1 Ceiling')!
    expect(act.id).not.toBe('s1')
    expect(act.specifications_json).toContain('secret layout')
    expect(await target.db.all('SELECT id FROM markups')).toEqual([])
    expect(scopeImportStatus(result, 'A-101 round 1.pdf')).toBe('1 scope imported from A-101 round 1.pdf, 1 already here by name')
    expect(scopeImportStatus({ added: [], skipped: [] }, 'x.pdf')).toBe('x.pdf carries no REDBEAM scopes')
  })

  it('starts a file from another PDF\'s takeoff: scopes and markups, on the sheets that match', async () => {
    await seedTakeoff(db, docId)
    // A second sheet in the old set, with its own area.
    await db.run(`INSERT INTO pages(id,document_id,page_number,width_pdf_points,height_pdf_points,created_at,updated_at)
      VALUES(?,?,1,2592,1728,?,?)`, [`${docId}-p1`, docId, NOW, NOW])
    await db.run(`INSERT INTO markups(id,document_id,page_id,scope_id,kind,geometry_json,origin,created_at,updated_at)
      VALUES('m2',?,?,'s1','area',?,'user',?,?)`, [docId, `${docId}-p1`, JSON.stringify([sq(0.5, 0.5, 0.6, 0.6)]), NOW, NOW])
    const file = memoryFile(await blankPdf())
    await embedDrawing({ db, documentId: docId, relativePath: 'A-101.pdf', displayName: 'A-101', appVersion: 't', file, allScopes: true })
    const slice = (await readSheetEmbed(file.bytes)).slice!

    // The new set: sheet 1 is the same size and not visited yet, so it has no row here.
    const target = await freshDb('Rev B/A-101.pdf')
    const sizes = [{ width: 2592, height: 1728 }, { width: 2592, height: 1728 }]
    const result = await importTakeoffFromSlice(target.db, target.docId, slice, sizes)
    expect(result).toMatchObject({ added: ['ACT-1 Ceiling'], markups: 2, sheets: 2, already: 0, unplaced: 0 })
    const rows = await target.db.all<{ id: string, page_id: string, scope_id: string }>('SELECT id, page_id, scope_id FROM markups ORDER BY page_id')
    expect(rows.map((r) => r.page_id)).toEqual([`${target.docId}-p0`, `${target.docId}-p1`])
    // New ids throughout: the two files never share a row.
    expect(rows.map((r) => r.id)).not.toContain('m1')
    const scope = await target.db.all<{ id: string }>('SELECT id FROM scopes')
    expect(scope[0]!.id).not.toBe('s1')
    expect(rows.every((r) => r.scope_id === scope[0]!.id)).toBe(true)
    // The sheet's scale came too, so the copy measures what the original did.
    const tables = await sliceTables(target.db, target.docId, { allScopes: true })
    const { markups } = embedMarkupsFor(tables, target.docId)
    expect(markups.find((m) => m.pageIndex === 0)!.quantity).toBeCloseTo(57.6 * 38.4, 1)
    expect(takeoffImportStatus(result, 'A-101.pdf')).toBe('2 markups on 2 sheets copied from A-101.pdf, 1 scope added')

    // Doing it again adds nothing.
    const again = await importTakeoffFromSlice(target.db, target.docId, slice, sizes)
    expect(again).toMatchObject({ added: [], skipped: ['ACT-1 Ceiling'], markups: 0, already: 2 })
    expect((await target.db.all('SELECT id FROM markups')).length).toBe(2)
    expect(takeoffImportStatus(again, 'A-101.pdf')).toBe('nothing new in A-101.pdf, 2 markups were already here')
  })

  it('does not save over a takeoff someone else saved into the PDF since this window read it', async () => {
    await seedTakeoff(db, docId)
    const file = memoryFile(await blankPdf())
    const mine = { db, documentId: docId, relativePath: 'A-101.pdf', displayName: 'A-101', appVersion: 't', file, allScopes: true }
    // This window opened a PDF with no takeoff, and saved its own: it now knows what the file carries.
    const first = await embedDrawing({ ...mine, expectStamp: null })
    expect(first.kind).toBe('written')
    const seen = first.kind === 'written' ? first.stamp! : null
    expect(seen).toBe(sliceStamp((await readSheetEmbed(file.bytes)).slice))

    // A second window, opened on the same PDF, draws another area and saves.
    const other = await freshDb('A-101.pdf')
    await importSlice(other.db, other.docId, (await readSheetEmbed(file.bytes)).slice!)
    await other.db.run(`INSERT INTO markups(id,document_id,page_id,scope_id,kind,geometry_json,origin,created_at,updated_at)
      VALUES('theirs',?,?,'s1','area',?,'user',?,?)`, [other.docId, `${other.docId}-p0`, JSON.stringify([sq(0.6, 0.6, 0.7, 0.7)]), NOW, NOW])
    expect((await embedDrawing({ db: other.db, documentId: other.docId, relativePath: 'A-101.pdf', displayName: 'A-101', appVersion: 't', file, allScopes: true })).kind).toBe('written')
    const theirs = file.bytes

    // This window changes its own takeoff and saves: theirs is in the way, so nothing is written.
    await db.run(`UPDATE markups SET geometry_json = ? WHERE id = 'm1'`, [JSON.stringify([sq(0.1, 0.2, 0.4, 0.4)])])
    const out = await embedDrawing({ ...mine, expectStamp: seen })
    expect(out.kind).toBe('elsewhere')
    expect(file.bytes).toBe(theirs)
    expect(unsavedReason(out, 1)).toMatch(/Someone else saved a different takeoff/)
    expect(unsavedReason(out, 0)).toBeNull()
    expect(embedStatus(out, 'A-101')).toMatch(/someone else saved/)

    // Without the check (a project window, whose database is the record) the old behaviour stands.
    expect((await embedDrawing(mine)).kind).toBe('written')
  })

  it('still saves when the takeoff in the file is the one this window last saw, or says the same thing', async () => {
    await seedTakeoff(db, docId)
    const file = memoryFile(await blankPdf())
    const mine = { db, documentId: docId, relativePath: 'A-101.pdf', displayName: 'A-101', appVersion: 't', file, allScopes: true }
    const first = await embedDrawing({ ...mine, expectStamp: null })
    const seen = first.kind === 'written' ? first.stamp! : null
    await db.run(`UPDATE markups SET geometry_json = ? WHERE id = 'm1'`, [JSON.stringify([sq(0.1, 0.2, 0.4, 0.4)])])
    const second = await embedDrawing({ ...mine, expectStamp: seen })
    expect(second.kind).toBe('written')
    // A stale stamp, but the file already says exactly what this window holds: nothing to fight over.
    expect((await embedDrawing({ ...mine, expectStamp: seen })).kind).toBe('unchanged')
  })

  it('leaves behind markups whose sheet is missing or another size, and says how many', async () => {
    await seedTakeoff(db, docId)
    await db.run(`INSERT INTO pages(id,document_id,page_number,width_pdf_points,height_pdf_points,created_at,updated_at)
      VALUES(?,?,1,2592,1728,?,?)`, [`${docId}-p1`, docId, NOW, NOW])
    await db.run(`INSERT INTO markups(id,document_id,page_id,scope_id,kind,geometry_json,origin,created_at,updated_at)
      VALUES('m2',?,?,'s1','area',?,'user',?,?)`, [docId, `${docId}-p1`, JSON.stringify([sq(0.5, 0.5, 0.6, 0.6)]), NOW, NOW])
    const file = memoryFile(await blankPdf())
    await embedDrawing({ db, documentId: docId, relativePath: 'A-101.pdf', displayName: 'A-101', appVersion: 't', file, allScopes: true })
    const slice = (await readSheetEmbed(file.bytes)).slice!

    // Sheet 1 was reissued on a smaller sheet.
    const target = await freshDb('Rev B/A-101.pdf')
    const result = await importTakeoffFromSlice(target.db, target.docId, slice, [{ width: 2592, height: 1728 }, { width: 1224, height: 792 }])
    expect(result).toMatchObject({ markups: 1, sheets: 1, unplaced: 1 })
    expect(takeoffImportStatus(result, 'A-101.pdf')).toMatch(/1 markup on 1 sheet copied.*1 markup was left behind: its sheet is missing or a different size/)
    expect(takeoffImportStatus({ added: [], skipped: [], markups: 0, sheets: 0, already: 0, unplaced: 0 }, 'x.pdf')).toBe('x.pdf carries no REDBEAM takeoff')
  })
})

describe('a project opening a drawing changed in Light mode', () => {
  it('takes the PDF\'s takeoff when it is newer and different, and keeps the old markup soft-deleted', async () => {
    const pro = await freshDb()
    await seedTakeoff(pro.db, pro.docId)
    const file = memoryFile(await blankPdf())
    await embedDrawing({ db: pro.db, documentId: pro.docId, relativePath: 'A-101.pdf', displayName: 'A-101', appVersion: 't', file })

    // Pro's own save is not newer news.
    const own = (await readSheetEmbed(file.bytes)).slice!
    expect(await takeNewerSlice(pro.db, pro.docId, own)).toBeNull()

    // Light opens the PDF in a fresh store, redraws the area and adds a run.
    const light = await freshDb()
    await importSlice(light.db, light.docId, own)
    const later = '2026-11-18T10:00:00.000Z'
    await light.db.run('UPDATE markups SET deleted_at = ?, updated_at = ? WHERE id = ?', [later, later, 'm1'])
    await light.db.run(`INSERT INTO markups(id,document_id,page_id,scope_id,kind,geometry_json,origin,created_at,updated_at)
      VALUES('m2',?,?,'s1','polyline',?,'user',?,?)`,
      [light.docId, `${light.docId}-p0`, JSON.stringify([[{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }]]), later, later])
    await light.db.run(`UPDATE scopes SET label = 'ACT-1 Ceiling (rev)' WHERE id = 's1'`)
    await embedDrawing({
      db: light.db, documentId: light.docId, relativePath: 'A-101.pdf', displayName: 'A-101', appVersion: 't', file, allScopes: true,
    })
    const theirs = (await readSheetEmbed(file.bytes)).slice!

    expect(await takeNewerSlice(pro.db, pro.docId, theirs)).toEqual({ markups: 1, scopes: 1 })
    const live = await pro.db.all<{ id: string, page_id: string }>('SELECT id, page_id FROM markups WHERE deleted_at IS NULL')
    expect(live).toEqual([{ id: 'm2', page_id: `${pro.docId}-p0` }])
    const gone = await pro.db.all<{ id: string }>('SELECT id FROM markups WHERE deleted_at IS NOT NULL')
    expect(gone).toEqual([{ id: 'm1' }])
    const label = await pro.db.all<{ label: string }>(`SELECT label FROM scopes WHERE id = 's1'`)
    expect(label[0]!.label).toBe('ACT-1 Ceiling (rev)')

    // Once taken, the same slice is not news again.
    expect(await takeNewerSlice(pro.db, pro.docId, theirs)).toBeNull()
  })

  it('ignores a slice older than the project\'s own last change', async () => {
    const pro = await freshDb()
    await seedTakeoff(pro.db, pro.docId)
    const file = memoryFile(await blankPdf())
    await embedDrawing({ db: pro.db, documentId: pro.docId, relativePath: 'A-101.pdf', displayName: 'A-101', appVersion: 't', file })
    const slice = { ...(await readSheetEmbed(file.bytes)).slice!, writtenAt: '2000-01-01T00:00:00.000Z' }
    slice.tables = { ...slice.tables, markups: [] }
    expect(await takeNewerSlice(pro.db, pro.docId, slice)).toBeNull()
  })
})

describe('a Light file is saved into only once its own takeoff is in the window', () => {
  const reading = (over: Partial<SheetEmbedReading> = {}): SheetEmbedReading => ({
    slice: null, source: null, redbeamAnnots: [], sheets: [], foreignAnnots: 0, adoptable: [], privateDataLost: false, sliceTooNew: false, ...over,
  })

  it('round-trips everything a person made, and may then be saved', async () => {
    const { db, docId } = await freshDb()
    await seedTakeoff(db, docId)
    const file = memoryFile(await blankPdf())
    await embedDrawing({ db, documentId: docId, relativePath: 'A-101.pdf', displayName: 'A-101', appVersion: 't', file, allScopes: true })
    const read = await readSheetEmbed(file.bytes)

    const next = await freshDb()
    const imported = await importSlice(next.db, next.docId, read.slice!)
    expect(imported?.skipped).toBeUndefined()
    expect(fileLoadVerdict(read, imported, 'A-101')).toEqual({ state: 'loaded' })
    for (const table of ['scopes', 'markups', 'calibrations']) {
      const was = await db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)
      const now = await next.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)
      expect(now[0]!.n, table).toBe(was[0]!.n)
    }
    // Saving the reopened file changes nothing: the PDF already says exactly this.
    const again = await embedDrawing({
      db: next.db, documentId: next.docId, relativePath: 'A-101.pdf', displayName: 'A-101', appVersion: 't', file, allScopes: true,
    })
    // Looking at more sheets adds page rows; that is not a change to the takeoff either.
    await next.db.run(`INSERT INTO pages(id,document_id,page_number,width_pdf_points,height_pdf_points,rotation,created_at,updated_at)
      VALUES(?,?,7,100,100,0,?,?)`, [`${next.docId}-p7`, next.docId, NOW, NOW])
    expect(again.kind).toBe('unchanged')
    expect(file.writes).toBe(1)
  })

  it('is not saved into when part of its takeoff could not be loaded', async () => {
    const { db, docId } = await freshDb()
    await seedTakeoff(db, docId)
    const file = memoryFile(await blankPdf())
    await embedDrawing({ db, documentId: docId, relativePath: 'A-101.pdf', displayName: 'A-101', appVersion: 't', file, allScopes: true })
    const read = await readSheetEmbed(file.bytes)
    // A column this build has never heard of, as a newer build's row would carry.
    const slice = { ...read.slice!, tables: { ...read.slice!.tables,
      markups: (read.slice!.tables.markups ?? []).map((r) => ({ ...r, column_from_the_future: 1 })) } }

    const next = await freshDb()
    const imported = await importSlice(next.db, next.docId, slice)
    expect(imported?.skipped).toBe(slice.tables.markups.length)
    const verdict = fileLoadVerdict({ ...read, slice }, imported, 'A-101')
    expect(verdict.state).toBe('blocked')
  })

  it('is not saved into when a newer REDBEAM wrote it, or another app dropped the takeoff detail', () => {
    expect(parseSlice(JSON.stringify({ format: SLICE_FORMAT, version: SLICE_VERSION + 1, documentId: 'd', tables: {} }))).toBe('too-new')
    const newer = fileLoadVerdict(reading({ sliceTooNew: true }), null, 'A-101')
    expect(newer.state).toBe('blocked')
    expect(newer.state === 'blocked' && newer.reason).toContain('newer REDBEAM')
    expect(fileLoadVerdict(reading({ privateDataLost: true }), null, 'A-101').state).toBe('blocked')
    // A PDF with nothing of ours in it has nothing to wait for.
    expect(fileLoadVerdict(reading(), null, 'A-101')).toEqual({ state: 'loaded' })
  })

  it('asks before leaving only when leaving would lose something', () => {
    expect(unsavedReason({ kind: 'written', editedElsewhere: [], foreignKept: 0 }, 3)).toBeNull()
    expect(unsavedReason({ kind: 'unchanged' }, 3)).toBeNull()
    expect(unsavedReason({ kind: 'busy' }, 0)).toContain('open in another app')
    expect(unsavedReason({ kind: 'failed', message: 'access denied' }, 0)).toContain('access denied')
    // Held back with nothing drawn here: the file is as it was found.
    expect(unsavedReason({ kind: 'held', reason: null }, 0)).toBeNull()
    expect(unsavedReason({ kind: 'held', reason: 'why' }, 2)).toBe('why')
  })

  it('can always be saved as a copy, leaving the original untouched', async () => {
    const { db, docId } = await freshDb()
    await seedTakeoff(db, docId)
    const original = await blankPdf()
    const copy = await embedCopy({
      db, documentId: docId, relativePath: 'A-101.pdf', displayName: 'A-101', appVersion: 't',
      read: async () => original, allScopes: true,
    })
    expect(copy).not.toBe(original)
    expect((await readSheetEmbed(original)).slice).toBeNull()
    const carried = (await readSheetEmbed(copy)).slice!
    expect(carried.tables.markups).toHaveLength(1)
    expect(carried.tables.scopes).toHaveLength(1)
    // A copy of a file that already says all of it is the file itself.
    expect(await embedCopy({
      db, documentId: docId, relativePath: 'A-101.pdf', displayName: 'A-101', appVersion: 't',
      read: async () => copy, allScopes: true,
    })).toBe(copy)
    expect(copyName('Round 2/A-101.PDF')).toBe('A-101 (takeoff).pdf')
    expect(copyName('C:\\jobs\\plan')).toBe('plan (takeoff).pdf')
  })
})

describe('a Light file another app saved without REDBEAM\u2019s private data', () => {
  /** What a re-save that keeps annotations and drops unknown data leaves behind. */
  async function stripPrivate(bytes: Uint8Array): Promise<Uint8Array> {
    const d = await PDFDocument.load(bytes, { updateMetadata: false })
    d.catalog.delete(PDFName.of('PieceInfo'))
    for (const page of d.getPages()) {
      page.node.delete(PDFName.of('PieceInfo'))
      const arr = page.node.lookup(PDFName.of('Annots'))
      if (!(arr instanceof PDFArray)) continue
      for (let i = 0; i < arr.size(); i++) {
        const a = arr.lookup(i)
        if (a instanceof PDFDict) a.delete(PDFName.of('REDBEAM'))
      }
    }
    return d.save()
  }

  async function seedMixed(db: SqlJsDriver, docId: string): Promise<void> {
    await seedTakeoff(db, docId)
    const page = `${docId}-p0`
    await db.run(`INSERT INTO scopes(id,label,scope_type,color,specifications_json,created_at,updated_at)
      VALUES('s2','Wall base','linear','#d1492f','{}',?,?)`, [NOW, NOW])
    await db.run(`INSERT INTO scopes(id,label,scope_type,color,specifications_json,created_at,updated_at)
      VALUES('s3','Diffusers','count','#2fd17f','{}',?,?)`, [NOW, NOW])
    const add = (id: string, scope: string, kind: string, rings: unknown) => db.run(
      `INSERT INTO markups(id,document_id,page_id,scope_id,kind,geometry_json,origin,created_at,updated_at)
       VALUES(?,?,?,?,?,?,'user',?,?)`, [id, docId, page, scope, kind, JSON.stringify(rings), NOW, NOW])
    await add('m2', 's1', 'area', [sq(0.5, 0.5, 0.9, 0.9), sq(0.6, 0.6, 0.7, 0.7)])
    await add('m3', 's1', 'cutout', [sq(0.02, 0.02, 0.05, 0.05)])
    await add('m4', 's2', 'polyline', [[{ x: 0.1, y: 0.8 }, { x: 0.4, y: 0.8 }, { x: 0.4, y: 0.9 }]])
    await add('m5', 's3', 'count', [[{ x: 0.25, y: 0.6 }]])
  }

  const shape = (rows: Array<{ kind: string, label: string | null, geometry_json: string }>) => rows
    .map((r) => `${r.kind}|${r.label ?? ''}|${JSON.stringify((JSON.parse(r.geometry_json) as Array<Array<{ x: number, y: number }>>)
      .map((ring) => ring.map((p) => [Math.round(p.x * 1e4), Math.round(p.y * 1e4)])))}`).sort()
  const takeoff = (db: SqlJsDriver) => db.all<{ kind: string, label: string | null, geometry_json: string }>(
    `SELECT m.kind, s.label, m.geometry_json FROM markups m LEFT JOIN scopes s ON s.id = m.scope_id WHERE m.deleted_at IS NULL`)

  it('gets its takeoff back from the markups, and its detail back on the next save', async () => {
    const { db, docId } = await freshDb()
    await seedMixed(db, docId)
    const file = memoryFile(await blankPdf())
    await embedDrawing({ db, documentId: docId, relativePath: 'A-101.pdf', displayName: 'A-101', appVersion: 't', file, allScopes: true })
    file.bytes = await stripPrivate(file.bytes)

    const reading = await readSheetEmbed(file.bytes)
    expect(reading.privateDataLost).toBe(true)
    expect(reading.redbeamAnnots).toHaveLength(5)

    const next = await freshDb()
    await next.db.run('DELETE FROM pages')
    const rebuilt = await rebuildFromAnnots(next.db, next.docId, reading)
    expect(rebuilt).toEqual({ markups: 5, scopes: 3, unscaled: 0 })
    expect(fileLoadVerdict(reading, null, 'A-101', rebuilt)).toEqual({ state: 'loaded' })
    expect(rebuiltStatus(rebuilt!, 'A-101')).toContain('rebuilt 5 markups in 3 scopes')
    expect(shape(await takeoff(next.db))).toEqual(shape(await takeoff(db)))

    const scopes = await next.db.all<{ label: string, scope_type: string, color: string }>('SELECT label, scope_type, color FROM scopes ORDER BY label')
    expect(scopes).toEqual([
      { label: 'ACT-1 Ceiling', scope_type: 'area', color: '#2f7fd1' },
      { label: 'Diffusers', scope_type: 'count', color: '#2fd17f' },
      { label: 'Wall base', scope_type: 'linear', color: '#d1492f' },
    ])
    const cal = await next.db.all<{ f: number }>('SELECT feet_per_pdf_point AS f FROM calibrations')
    expect(cal).toHaveLength(1)
    expect(cal[0]!.f).toBeCloseTo(8 / 72, 9)
    const pages = await next.db.all<{ w: number, h: number }>('SELECT width_pdf_points AS w, height_pdf_points AS h FROM pages')
    expect(pages).toEqual([{ w: 2592, h: 1728 }])

    // Saving replaces the orphaned annotations one for one and carries the slice again.
    const saved = await embedDrawing({
      db: next.db, documentId: next.docId, relativePath: 'A-101.pdf', displayName: 'A-101', appVersion: 't', file, allScopes: true,
    })
    expect(saved.kind).toBe('written')
    const after = await readSheetEmbed(file.bytes)
    expect(after.privateDataLost).toBe(false)
    expect(after.redbeamAnnots).toHaveLength(5)
    expect(after.slice?.tables.markups).toHaveLength(5)
  })

  it('stays blocked when one of its markups cannot be read back, and when it has no scale says so', async () => {
    const { db, docId } = await freshDb()
    await seedMixed(db, docId)
    const file = memoryFile(await blankPdf())
    await embedDrawing({ db, documentId: docId, relativePath: 'A-101.pdf', displayName: 'A-101', appVersion: 't', file, allScopes: true })
    const stripped = await stripPrivate(file.bytes)

    // The other app also threw the sheet's viewports away: the shapes come back, the scale does not.
    const noScale = await PDFDocument.load(stripped, { updateMetadata: false })
    noScale.getPages()[0]!.node.delete(PDFName.of('VP'))
    const bare = await freshDb()
    const unscaled = await rebuildFromAnnots(bare.db, bare.docId, await readSheetEmbed(await noScale.save()))
    expect(unscaled).toEqual({ markups: 5, scopes: 3, unscaled: 1 })
    expect(rebuiltStatus(unscaled!, 'A-101')).toContain('1 sheet has lost its scale')

    // One annotation turned into something REDBEAM does not write: nothing is rebuilt.
    const odd = await PDFDocument.load(stripped, { updateMetadata: false })
    const arr = odd.getPages()[0]!.node.lookup(PDFName.of('Annots')) as PDFArray
    ;(arr.lookup(0) as PDFDict).set(PDFName.of('Subtype'), PDFName.of('Ink'))
    const reading = await readSheetEmbed(await odd.save())
    const next = await freshDb()
    const rebuilt = await rebuildFromAnnots(next.db, next.docId, reading)
    expect(rebuilt).toBeNull()
    expect((await next.db.all<{ n: number }>('SELECT COUNT(*) AS n FROM markups'))[0]!.n).toBe(0)
    expect(fileLoadVerdict(reading, null, 'A-101', rebuilt).state).toBe('blocked')
  })
})

describe('cuts that are part of the area', () => {
  it('go to Bluebeam as each area\'s /Cutouts, measured net, and come back with each area', async () => {
    const { db, docId } = await freshDb()
    await seedTakeoff(db, docId)
    const across = sq(0.25, 0.25, 0.35, 0.3)
    await db.run(`UPDATE markups SET geometry_json = ? WHERE id = 'm1'`, [JSON.stringify([sq(0.1, 0.2, 0.3, 0.4), across])])
    await db.run(`INSERT INTO markups(id,document_id,page_id,scope_id,kind,geometry_json,origin,created_at,updated_at)
      VALUES('m2',?,?,'s1','area',?,'user',?,?)`, [docId, `${docId}-p0`, JSON.stringify([sq(0.3, 0.2, 0.5, 0.4), across]), NOW, NOW])

    const { markups } = embedMarkupsFor(await sliceTables(db, docId), docId)
    const m1 = markups.find((m) => m.id === 'm1')!
    // 0.2 x 0.2 at 288 x 192 ft per unit, less the half of the cut inside it.
    expect(m1.quantity).toBeCloseTo((0.2 * 0.2 - 0.05 * 0.05) * 288 * 192, 1)
    expect(m1.cutouts).toEqual([across])

    const file = memoryFile(await blankPdf())
    await embedDrawing({ db, documentId: docId, relativePath: 'A-101.pdf', displayName: 'A-101', appVersion: 't', file })
    const reading = await readSheetEmbed(file.bytes)
    expect(reading.redbeamAnnots).toHaveLength(2)
    const back: Markup[] = reading.redbeamAnnots.map((a) => ({
      id: a.markupId!, scopeId: 's1', documentId: docId, pageId: `${docId}-p0`, kind: 'area', rings: a.rings,
    }))
    // Each area brings its own hole back, independent of the other's.
    const cutouts = cutoutsOf(back)
    expect(cutouts).toHaveLength(2)
    expect(cutouts[0]!.rings[0]![0]!.x).toBeCloseTo(0.25, 4)
  })
})

describe('a slice row the database refuses', () => {
  /*
   * Found testing 0.3.61 on a PDF whose slice rows carried only an id:
   * INSERT OR IGNORE dropped them without an error, the import counted them
   * as loaded, the window showed no takeoff, and the next save removed the
   * file's REDBEAM markups.
   */
  it('is counted as not loaded, so the file is not saved into', async () => {
    const { db, docId } = await freshDb()
    const slice = {
      format: SLICE_FORMAT, version: SLICE_VERSION, documentId: 'd', relativePath: '', displayName: '',
      annots: {}, contentHash: '',
      tables: { markups: [{ id: 'm1' }], scopes: [{ id: 's', specifications_json: '{}' }] },
    } as unknown as NonNullable<SheetEmbedReading['slice']>
    const imported = await importSlice(db, docId, slice)
    expect(imported).toEqual({ markups: 0, scopes: 0, skipped: 2 })
    const reading = { slice, privateDataLost: false, sliceTooNew: false } as unknown as SheetEmbedReading
    expect(fileLoadVerdict(reading, imported, 'old.pdf').state).toBe('blocked')
  })
})

describe('addenda links made by hand', () => {
  it('travel in a Light file and come back on import', async () => {
    const { db, docId } = await freshDb()
    await seedTakeoff(db, docId)
    await db.run("INSERT OR REPLACE INTO redbeam_meta(key, value) VALUES('addenda_links', ?)", [JSON.stringify([{ replaced: 0, by: 1, source: 'linked' }])])
    await db.run("INSERT OR REPLACE INTO redbeam_meta(key, value) VALUES('something_else', 'x')")
    const tables = await sliceTables(db, docId, { allScopes: true })
    expect(tables['redbeam_meta']).toEqual([{ key: 'addenda_links', value: JSON.stringify([{ replaced: 0, by: 1, source: 'linked' }]) }])
    expect((await sliceTables(db, docId))['redbeam_meta']).toBeUndefined()

    const other = await freshDb()
    const slice = { format: SLICE_FORMAT, version: SLICE_VERSION, documentId: docId, relativePath: '', displayName: '', annots: {}, contentHash: '',
      tables: { ...tables, redbeam_meta: [...tables['redbeam_meta']!, { key: 'not_the_files', value: 'y' }] } } as unknown as NonNullable<SheetEmbedReading['slice']>
    await importSlice(other.db, other.docId, slice)
    const rows = await other.db.all<{ key: string, value: string }>("SELECT key, value FROM redbeam_meta WHERE key IN ('addenda_links','not_the_files')")
    expect(rows).toEqual([{ key: 'addenda_links', value: JSON.stringify([{ replaced: 0, by: 1, source: 'linked' }]) }])
  })
})
