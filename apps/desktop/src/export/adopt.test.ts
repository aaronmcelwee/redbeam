import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib'
import { ingestDocuments, migrate, SqlJsDriver, type Migration } from '@redbeam/store'
import { adoptForeignAnnots, adoptedId, untouched } from './adopt.js'
import { embedDrawing, type DrawingFile } from './drawingEmbed.js'
import { readSheetEmbed } from './sheetEmbed.js'

const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(here, '..', '..', '..', '..', 'packages', 'store', 'migrations')
const loadMigrations = (): Migration[] => readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort().map((f) => {
  const m = /^(\d+)_([a-z0-9]+)\.sql$/i.exec(f)!
  return { version: Number(m[1]), name: m[2]!, sql: readFileSync(join(migrationsDir, f), 'utf8') }
})
const NOW = '2026-11-24T00:00:00.000Z'

async function freshDb(): Promise<{ db: SqlJsDriver, docId: string }> {
  const db = await SqlJsDriver.open()
  await migrate(db, loadMigrations())
  await ingestDocuments(db, [{
    relativePath: 'A-101.pdf', displayName: 'A-101.pdf', kind: 'drawing', status: 'current', sizeBytes: 1,
    contentFingerprint: 'fp', availability: 'local', pages: [{ pageNumber: 0, widthPdfPoints: 2592, heightPdfPoints: 1728 }],
  }])
  const row = await db.all<{ id: string }>('SELECT id FROM documents LIMIT 1')
  return { db, docId: row[0]!.id }
}

/** A sheet as Revu leaves it: an area measurement, a cloud, a text box and a popup for the area. */
async function bluebeamPdf(): Promise<Uint8Array> {
  const d = await PDFDocument.create()
  const page = d.addPage([2592, 1728])
  const ctx = d.context
  const area = ctx.obj({
    Type: 'Annot', Subtype: 'Polygon', NM: PDFString.of('QWERTYUIOPASDFGH'), IT: 'PolygonDimension',
    Subj: PDFString.of('Area Measurement'), Contents: PDFString.of('1,234.56 sf'), T: PDFString.of('aaron'),
    Rect: [100, 100, 600, 500], Vertices: [100, 100, 600, 100, 600, 500, 100, 500], C: [1, 0, 0],
    Cutouts: [[200, 200, 300, 200, 300, 300, 200, 300]],
  })
  const areaRef = ctx.register(area)
  const popup = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [0, 0, 10, 10], Parent: areaRef }))
  const cloud = ctx.register(ctx.obj({
    Type: 'Annot', Subtype: 'Polygon', NM: PDFString.of('CLOUDCLOUDCLOUDX'), BE: { S: 'C', I: 1 },
    Rect: [700, 700, 900, 900], Vertices: [700, 700, 900, 700, 900, 900, 700, 900],
  }))
  const text = ctx.register(ctx.obj({
    Type: 'Annot', Subtype: 'FreeText', NM: PDFString.of('TEXTTEXTTEXTTEXT'), Rect: [1000, 1000, 1200, 1100], Contents: PDFString.of('note'),
  }))
  page.node.set(PDFName.of('Annots'), ctx.obj([areaRef, popup, cloud, text]))
  return d.save()
}

function memoryFile(bytes: Uint8Array): DrawingFile & { bytes: Uint8Array, writes: number } {
  let version = 0
  const f = {
    bytes, writes: 0,
    read: async () => ({ bytes: f.bytes, version: String(version) }),
    write: async (b: Uint8Array, expected: string) => {
      if (expected !== String(version)) return false
      f.bytes = b; f.writes++; version++
      return true
    },
  }
  return f
}

async function nmsOn(bytes: Uint8Array): Promise<string[]> {
  const d = await PDFDocument.load(bytes)
  const arr = d.getPage(0).node.lookup(PDFName.of('Annots'))
  if (!(arr instanceof PDFArray)) return []
  const out: string[] = []
  for (let i = 0; i < arr.size(); i++) {
    const a = arr.lookup(i)
    if (!(a instanceof PDFDict)) continue
    const nm = a.lookup(PDFName.of('NM'))
    const sub = a.lookup(PDFName.of('Subtype'))
    out.push(nm instanceof PDFString ? nm.decodeText() : `(${sub instanceof PDFName ? sub.decodeText() : '?'})`)
  }
  return out
}

describe('Bluebeam markups held as REDBEAM markups', () => {
  let db: SqlJsDriver
  let docId: string
  beforeEach(async () => { ({ db, docId } = await freshDb()) })

  const embed = (file: DrawingFile) => embedDrawing({
    db, documentId: docId, relativePath: 'A-101.pdf', displayName: 'A-101.pdf', appVersion: 'test', file, allScopes: true,
  })

  it('adopts areas with their cutouts, and leaves clouds and text to the page', async () => {
    const reading = await readSheetEmbed(await bluebeamPdf())
    expect(reading.adoptable.map((a) => a.nm)).toEqual(['QWERTYUIOPASDFGH'])
    expect(reading.adoptable[0]!.rings).toHaveLength(2)
    const result = await adoptForeignAnnots(db, docId, reading)
    expect(result).toEqual({ added: 1, nms: ['QWERTYUIOPASDFGH'] })
    const rows = await db.all<{ id: string, kind: string, scope_id: string | null, geometry_json: string, content_json: string }>(
      'SELECT id, kind, scope_id, geometry_json, content_json FROM markups')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(adoptedId(docId, 'QWERTYUIOPASDFGH'))
    expect(rows[0]!.kind).toBe('area')
    expect(rows[0]!.scope_id).toBeNull()
    expect(untouched(rows[0]!)).toBe(true)
    // A second open adds nothing.
    expect((await adoptForeignAnnots(db, docId, reading)).added).toBe(0)
  })

  it('writes nothing while the adopted markup is untouched', async () => {
    const file = memoryFile(await bluebeamPdf())
    await adoptForeignAnnots(db, docId, await readSheetEmbed(file.bytes))
    const outcome = await embed(file)
    expect(outcome.kind).toBe('nothing-to-embed')
    expect(file.writes).toBe(0)
  })

  it('given a scope, it replaces the Bluebeam annotation instead of doubling it', async () => {
    const file = memoryFile(await bluebeamPdf())
    await adoptForeignAnnots(db, docId, await readSheetEmbed(file.bytes))
    await db.run(`INSERT INTO scopes(id,label,scope_type,color,specifications_json,created_at,updated_at)
      VALUES('s1','ACT-1','ceiling','#2f7fd1','{}',?,?)`, [NOW, NOW])
    await db.run('UPDATE markups SET scope_id = ?', ['s1'])
    expect((await embed(file)).kind).toBe('written')
    const nms = await nmsOn(file.bytes)
    expect(nms).not.toContain('QWERTYUIOPASDFGH')
    expect(nms).not.toContain('(Popup)')
    expect(nms).toContain('CLOUDCLOUDCLOUDX')
    expect(nms).toContain('TEXTTEXTTEXTTEXT')
    const after = await readSheetEmbed(file.bytes)
    expect(after.adoptable).toHaveLength(0)
    expect(after.redbeamAnnots).toHaveLength(1)
    expect(after.redbeamAnnots[0]!.label).toBe('ACT-1')
    expect(after.redbeamAnnots[0]!.cutouts).toHaveLength(1)
    // Saved again: still one.
    await embed(file)
    expect((await readSheetEmbed(file.bytes)).redbeamAnnots).toHaveLength(1)
  })

  it('deleted here, it is deleted from the PDF; undone, it is left as it was', async () => {
    const file = memoryFile(await bluebeamPdf())
    await adoptForeignAnnots(db, docId, await readSheetEmbed(file.bytes))
    await db.run('UPDATE markups SET deleted_at = ?', [NOW])
    await db.run('UPDATE markups SET deleted_at = NULL')
    await embed(file)
    expect(await nmsOn(file.bytes)).toContain('QWERTYUIOPASDFGH')
    await db.run('UPDATE markups SET deleted_at = ?', [NOW])
    expect((await embed(file)).kind).toBe('written')
    const nms = await nmsOn(file.bytes)
    expect(nms).not.toContain('QWERTYUIOPASDFGH')
    expect((await readSheetEmbed(file.bytes)).redbeamAnnots).toHaveLength(0)
  })
})
