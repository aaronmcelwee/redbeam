import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFString, decodePDFRawStream } from 'pdf-lib'
import { ingestDocuments, listMarkups, migrate, SqlJsDriver, type Migration } from '@redbeam/store'
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

  it('adopts areas with their cutouts, and holds clouds and text where they are', async () => {
    const reading = await readSheetEmbed(await bluebeamPdf())
    expect(reading.adoptable.map((a) => [a.nm, a.kind])).toEqual([
      ['QWERTYUIOPASDFGH', 'area'], ['CLOUDCLOUDCLOUDX', 'annot'], ['TEXTTEXTTEXTTEXT', 'annot'],
    ])
    expect(reading.adoptable[0]!.rings).toHaveLength(2)
    const result = await adoptForeignAnnots(db, docId, reading)
    expect(result).toEqual({ added: 3, held: 2, nms: ['QWERTYUIOPASDFGH'], heldNms: ['CLOUDCLOUDCLOUDX', 'TEXTTEXTTEXTTEXT'] })
    const rows = await db.all<{ id: string, kind: string, scope_id: string | null, geometry_json: string, content_json: string }>(
      "SELECT id, kind, scope_id, geometry_json, content_json FROM markups WHERE kind <> 'annot'")
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(adoptedId(docId, 'QWERTYUIOPASDFGH'))
    expect(rows[0]!.kind).toBe('area')
    expect(rows[0]!.scope_id).toBeNull()
    expect(untouched(rows[0]!)).toBe(true)
    const state = await db.all<{ origin: string, review_state: string }>("SELECT origin, review_state FROM markups WHERE kind <> 'annot'")
    expect(state[0]).toEqual({ origin: 'import', review_state: 'proposed' })
    // Held markups are not takeoff: nothing to accept.
    const held = await db.all<{ review_state: string }>("SELECT review_state FROM markups WHERE kind = 'annot'")
    expect(held.map((h) => h.review_state)).toEqual(['accepted', 'accepted'])
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
    expect(after.adoptable.map((a) => a.kind)).toEqual(['annot', 'annot'])
    expect(after.redbeamAnnots).toHaveLength(1)
    expect(after.redbeamAnnots[0]!.label).toBe('ACT-1')
    expect(after.redbeamAnnots[0]!.cutouts).toHaveLength(1)
    // Saved again: still one.
    await embed(file)
    expect((await readSheetEmbed(file.bytes)).redbeamAnnots).toHaveLength(1)
  })

  it('pending markups stay out of the accepted list; accepting one writes it as REDBEAM\'s', async () => {
    const file = memoryFile(await bluebeamPdf())
    await adoptForeignAnnots(db, docId, await readSheetEmbed(file.bytes))
    expect((await listMarkups(db, {})).filter((m) => m.kind !== 'annot')).toHaveLength(0)
    expect((await listMarkups(db, { reviewStates: ['accepted', 'proposed'] })).filter((m) => m.kind !== 'annot')).toHaveLength(1)
    await db.run("UPDATE markups SET review_state = 'accepted'")
    expect((await embed(file)).kind).toBe('written')
    const nms = await nmsOn(file.bytes)
    expect(nms).not.toContain('QWERTYUIOPASDFGH')
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

/** A sheet with Bluebeam's other markups: a cloud with a see-through fill, a text box, an arrow and a dimension. */
async function markedUpPdf(): Promise<Uint8Array> {
  const d = await PDFDocument.create()
  const page = d.addPage([2592, 1728])
  const ctx = d.context
  const gs = ctx.obj({ GS0: ctx.obj({ Type: 'ExtGState', BM: 'Multiply', ca: 0.3, CA: 1 }) })
  const cloudAp = ctx.register(ctx.flateStream('q /GS0 gs 1 0 0 RG 1 0 0 rg 2 w 700 700 m 900 700 l 900 900 l 700 900 l h B 0 0 0 rg 710 710 5 5 re f Q', {
    Type: 'XObject', Subtype: 'Form', BBox: [695, 695, 905, 905], Resources: ctx.obj({ ExtGState: gs }),
  }))
  const popup = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [950, 950, 1100, 1050] }))
  const cloud = ctx.register(ctx.obj({
    Type: 'Annot', Subtype: 'Polygon', NM: PDFString.of('CLOUDCLOUDCLOUDX'), BE: { S: 'C', I: 1 }, Subj: PDFString.of('Cloud'),
    Rect: [695, 695, 905, 905], Vertices: [700, 700, 900, 700, 900, 900, 700, 900], C: [1, 0, 0], IC: [1, 0, 0],
    Popup: popup, AP: ctx.obj({ N: cloudAp }),
  }))
  ctx.lookup(popup, PDFDict).set(PDFName.of('Parent'), cloud)
  const textAp = ctx.register(ctx.flateStream('q 1 0 0 RG 1 w 0.5 0.5 199 99 re S BT /Helv 12 Tf 1 0 0 rg 5 10 Td (note) Tj ET Q', {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 200, 100],
  }))
  const text = ctx.register(ctx.obj({
    Type: 'Annot', Subtype: 'FreeText', NM: PDFString.of('TEXTTEXTTEXTTEXT'), Rect: [1000, 1000, 1200, 1100],
    Contents: PDFString.of('note'), DA: PDFString.of('1 0 0 rg /Helv 12 Tf'), DS: PDFString.of('font: Helvetica 12pt; color:#FF0000'),
    AP: ctx.obj({ N: textAp }),
  }))
  const arrow = ctx.register(ctx.obj({
    Type: 'Annot', Subtype: 'Line', NM: PDFString.of('ARROWARROWARROWX'), Rect: [195, 1195, 405, 1305],
    L: [200, 1200, 400, 1300], LE: ['None', 'OpenArrow'], C: [0, 0, 1],
  }))
  const dimension = ctx.register(ctx.obj({
    Type: 'Annot', Subtype: 'Line', NM: PDFString.of('DIMENSIONDIMENSI'), IT: 'LineDimension', Subj: PDFString.of('Dimension'),
    Rect: [95, 1495, 505, 1555], L: [100, 1500, 500, 1500], LL: 20, C: [0, 0, 0],
  }))
  const length = ctx.register(ctx.obj({
    Type: 'Annot', Subtype: 'Line', NM: PDFString.of('LENGTHLENGTHLENG'), IT: 'LineDimension', Subj: PDFString.of('Length Measurement'),
    Rect: [95, 1595, 505, 1605], L: [100, 1600, 500, 1600], C: [0, 0, 0],
  }))
  page.node.set(PDFName.of('Annots'), ctx.obj([cloud, popup, text, arrow, dimension, length]))
  return d.save()
}

async function annotOn(bytes: Uint8Array, nm: string): Promise<PDFDict | null> {
  const d = await PDFDocument.load(bytes)
  const arr = d.getPage(0).node.lookup(PDFName.of('Annots'))
  if (!(arr instanceof PDFArray)) return null
  for (let i = 0; i < arr.size(); i++) {
    const a = arr.lookup(i)
    if (a instanceof PDFDict && (a.lookup(PDFName.of('NM')) as PDFString | undefined)?.decodeText() === nm) return a
  }
  return null
}

const numbers = (a: PDFDict, key: string): number[] => {
  const v = a.lookup(PDFName.of(key))
  if (!(v instanceof PDFArray)) return []
  return v.asArray().map((n) => (n as unknown as { asNumber(): number }).asNumber())
}

describe('other apps\' markups held in place (Kenneth, 2026-11-26)', () => {
  let db: SqlJsDriver
  let docId: string
  beforeEach(async () => { ({ db, docId } = await freshDb()) })

  const embed = (file: DrawingFile) => embedDrawing({
    db, documentId: docId, relativePath: 'A-101.pdf', displayName: 'A-101.pdf', appVersion: 'test', file, allScopes: true,
  })
  const heldRow = async (nm: string) => {
    const [row] = await db.all<{ id: string, geometry_json: string, content_json: string }>(
      'SELECT id, geometry_json, content_json FROM markups WHERE id = ?', [adoptedId(docId, nm)])
    return row!
  }
  const moveBy = async (nm: string, dx: number, dy: number) => {
    const row = await heldRow(nm)
    const rings = JSON.parse(row.geometry_json) as Array<Array<{ x: number, y: number }>>
    await db.run('UPDATE markups SET geometry_json = ? WHERE id = ?',
      [JSON.stringify(rings.map((r) => r.map((p) => ({ x: p.x + dx, y: p.y + dy })))), row.id])
  }
  const recolor = async (nm: string, hex: string) => {
    const row = await heldRow(nm)
    const c = JSON.parse(row.content_json) as Record<string, Record<string, unknown>>
    await db.run('UPDATE markups SET content_json = ? WHERE id = ?', [JSON.stringify({ ...c, annot: { ...c['annot'], color: hex } }), row.id])
  }

  it('holds clouds, text, arrows and dimensions; a length measurement is still takeoff', async () => {
    const reading = await readSheetEmbed(await markedUpPdf())
    expect(Object.fromEntries(reading.adoptable.map((a) => [a.nm, a.kind]))).toEqual({
      CLOUDCLOUDCLOUDX: 'annot', TEXTTEXTTEXTTEXT: 'annot', ARROWARROWARROWX: 'annot',
      DIMENSIONDIMENSI: 'annot', LENGTHLENGTHLENG: 'polyline',
    })
    const cloud = reading.adoptable.find((a) => a.nm === 'CLOUDCLOUDCLOUDX')!
    expect(cloud.color).toBe('#ff0000')
    expect(cloud.ap).toEqual({ bbox: [695, 695, 905, 905], matrix: null, alpha: 0.3 })
    // The text box's colour is its text's.
    expect(reading.adoptable.find((a) => a.nm === 'TEXTTEXTTEXTTEXT')!.color).toBe('#ff0000')
  })

  it('writes nothing while they are untouched', async () => {
    const file = memoryFile(await markedUpPdf())
    await adoptForeignAnnots(db, docId, await readSheetEmbed(file.bytes))
    // Only the length (pending takeoff) and nothing changed: no write.
    expect((await embed(file)).kind).toBe('nothing-to-embed')
    expect(file.writes).toBe(0)
  })

  it('moved here, the annotation itself moves: same /NM, its popup too, never doubled', async () => {
    const file = memoryFile(await markedUpPdf())
    await adoptForeignAnnots(db, docId, await readSheetEmbed(file.bytes))
    await moveBy('CLOUDCLOUDCLOUDX', 0.1, 0.05)
    expect((await embed(file)).kind).toBe('written')
    const cloud = (await annotOn(file.bytes, 'CLOUDCLOUDCLOUDX'))!
    const dx = 0.1 * 2592, dy = -0.05 * 1728
    numbers(cloud, 'Rect').forEach((v, i) => expect(v).toBeCloseTo([695 + dx, 695 + dy, 905 + dx, 905 + dy][i]!, 3))
    numbers(cloud, 'Vertices').forEach((v, i) => expect(v).toBeCloseTo([700, 700, 900, 700, 900, 900, 700, 900][i]! + (i % 2 === 0 ? dx : dy), 3))
    const popup = cloud.lookup(PDFName.of('Popup')) as PDFDict
    expect(numbers(popup, 'Rect')[0]).toBeCloseTo(950 + dx, 3)
    // The appearance is untouched: it is drawn into /Rect.
    expect(cloud.lookup(PDFName.of('AP'))).toBeInstanceOf(PDFDict)
    const nms = await nmsOn(file.bytes)
    expect(nms.filter((n) => n === 'CLOUDCLOUDCLOUDX')).toHaveLength(1)
    expect((await readSheetEmbed(file.bytes)).redbeamAnnots).toHaveLength(0)
    // Saved again: it does not move again.
    await embed(file)
    expect(numbers((await annotOn(file.bytes, 'CLOUDCLOUDCLOUDX'))!, 'Rect')[0]).toBeCloseTo(695 + dx, 3)
    // Moved back after that save (an undo): written back where it was.
    await moveBy('CLOUDCLOUDCLOUDX', -0.1, -0.05)
    expect((await embed(file)).kind).toBe('written')
    expect(numbers((await annotOn(file.bytes, 'CLOUDCLOUDCLOUDX'))!, 'Rect')[0]).toBeCloseTo(695, 3)
  })

  it('a moved arrow carries its line; a moved text box its rectangle', async () => {
    const file = memoryFile(await markedUpPdf())
    await adoptForeignAnnots(db, docId, await readSheetEmbed(file.bytes))
    await moveBy('ARROWARROWARROWX', 0.01, 0)
    await moveBy('TEXTTEXTTEXTTEXT', 0, 0.01)
    await embed(file)
    expect(numbers((await annotOn(file.bytes, 'ARROWARROWARROWX'))!, 'L')[0]).toBeCloseTo(200 + 25.92, 3)
    expect(numbers((await annotOn(file.bytes, 'TEXTTEXTTEXTTEXT'))!, 'Rect')[1]).toBeCloseTo(1000 - 17.28, 3)
  })

  it('recoloured here, its colour and its drawing change, and nothing else of it', async () => {
    const file = memoryFile(await markedUpPdf())
    await adoptForeignAnnots(db, docId, await readSheetEmbed(file.bytes))
    await recolor('CLOUDCLOUDCLOUDX', '#0070ff')
    await recolor('TEXTTEXTTEXTTEXT', '#00a000')
    expect((await embed(file)).kind).toBe('written')
    const cloud = (await annotOn(file.bytes, 'CLOUDCLOUDCLOUDX'))!
    expect(numbers(cloud, 'C').map((n) => Math.round(n * 255))).toEqual([0, 112, 255])
    expect(numbers(cloud, 'IC').map((n) => Math.round(n * 255))).toEqual([0, 112, 255])
    const reread = await readSheetEmbed(file.bytes)
    expect(reread.adoptable.find((a) => a.nm === 'CLOUDCLOUDCLOUDX')!.color).toBe('#0070ff')
    // The appearance: its red is blue now, its black dot still black, its see-through fill kept.
    expect(reread.adoptable.find((a) => a.nm === 'CLOUDCLOUDCLOUDX')!.ap?.alpha).toBe(0.3)
    const n = (cloud.lookup(PDFName.of('AP')) as PDFDict).lookup(PDFName.of('N')) as PDFRawStream
    const drawn = new TextDecoder('latin1').decode(decodePDFRawStream(n).decode())
    expect(drawn).toContain('0 0.4392 1 RG 0 0.4392 1 rg')
    expect(drawn).toContain('0 0 0 rg')
    expect(drawn).not.toContain('1 0 0 RG')
    const text = (await annotOn(file.bytes, 'TEXTTEXTTEXTTEXT'))!
    expect((text.lookup(PDFName.of('DA')) as PDFString).decodeText()).toBe('0 0.6275 0 rg /Helv 12 Tf')
    expect((text.lookup(PDFName.of('DS')) as PDFString).decodeText()).toBe('font: Helvetica 12pt; color:#00A000')
    expect(reread.adoptable.find((a) => a.nm === 'TEXTTEXTTEXTTEXT')!.color).toBe('#00a000')
    // Saved again: nothing more to write.
    expect((await embed(file)).kind).toBe('unchanged')
  })

  it('deleted here it leaves the PDF; undone after that save, it is put back, once', async () => {
    const file = memoryFile(await markedUpPdf())
    await adoptForeignAnnots(db, docId, await readSheetEmbed(file.bytes))
    const id = adoptedId(docId, 'CLOUDCLOUDCLOUDX')
    await db.run('UPDATE markups SET deleted_at = ? WHERE id = ?', [NOW, id])
    expect((await embed(file)).kind).toBe('written')
    expect(await nmsOn(file.bytes)).not.toContain('CLOUDCLOUDCLOUDX')
    expect(await nmsOn(file.bytes)).not.toContain('(Popup)')
    // Saved again while deleted: nothing more.
    await embed(file)
    await db.run('UPDATE markups SET deleted_at = NULL WHERE id = ?', [id])
    expect((await embed(file)).kind).toBe('written')
    const nms = await nmsOn(file.bytes)
    expect(nms.filter((n) => n === 'CLOUDCLOUDCLOUDX')).toHaveLength(1)
    expect(nms).toContain('(Popup)')
    await embed(file)
    expect((await nmsOn(file.bytes)).filter((n) => n === 'CLOUDCLOUDCLOUDX')).toHaveLength(1)
    expect(numbers((await annotOn(file.bytes, 'CLOUDCLOUDCLOUDX'))!, 'Rect')[0]).toBeCloseTo(695, 3)
  })

  it('an adopted area deleted, saved, then undone is written as REDBEAM\'s, not lost', async () => {
    const file = memoryFile(await bluebeamPdf())
    await adoptForeignAnnots(db, docId, await readSheetEmbed(file.bytes))
    const id = adoptedId(docId, 'QWERTYUIOPASDFGH')
    await db.run('UPDATE markups SET deleted_at = ? WHERE id = ?', [NOW, id])
    await embed(file)
    expect(await nmsOn(file.bytes)).not.toContain('QWERTYUIOPASDFGH')
    await db.run('UPDATE markups SET deleted_at = NULL WHERE id = ?', [id])
    await embed(file)
    expect((await readSheetEmbed(file.bytes)).redbeamAnnots).toHaveLength(1)
  })
})
