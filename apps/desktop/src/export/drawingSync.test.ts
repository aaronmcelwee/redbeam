import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument } from 'pdf-lib'
import { ingestDocuments, migrate, SqlJsDriver, type Migration } from '@redbeam/store'
import { forgetKeptDrawings, keptDrawingFile, projectDrawingFile, sha256Hex } from './drawingSync.js'
import { embedDrawing, type SheetEmbedder } from './drawingEmbed.js'
import { embedSheet, readSheetEmbed } from './sheetEmbed.js'
import type { DocumentWrite } from '../project/bridge.js'

describe('project drawing file', () => {
  it('hashes like the Rust side', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc')))
      .toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('passes the hash it read as the expected version, and reports a refused write as false', async () => {
    const calls: string[] = []
    const file = projectDrawingFile({
      readDocument: async () => new TextEncoder().encode('abc'),
      writeDocument: async (_p, rel, _b, expected) => {
        calls.push(`${rel}:${expected.slice(0, 6)}`)
        return calls.length === 1 ? { outcome: 'written', fingerprint: 'x' } : { outcome: 'changed' }
      },
    }, '/job', 'A-101.pdf')
    const { bytes, version } = await file.read()
    expect(await file.write(bytes, version)).toBe(true)
    expect(await file.write(bytes, version)).toBe(false)
    expect(calls).toEqual(['A-101.pdf:ba7816', 'A-101.pdf:ba7816'])
  })
})

const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(here, '..', '..', '..', '..', 'packages', 'store', 'migrations')
const migrations = (): Migration[] => readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort().map((f) => {
  const m = /^(\d+)_([a-z0-9]+)\.sql$/i.exec(f)!
  return { version: Number(m[1]), name: m[2]!, sql: readFileSync(join(migrationsDir, f), 'utf8') }
})
const NOW = '2026-11-19T00:00:00.000Z'
const sq = (x0: number, y0: number, x1: number, y1: number) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]

/** A drawing on "disk" that refuses a write over a version it no longer is, like the Rust side. */
function disk(initial: Uint8Array) {
  const d = {
    bytes: initial, reads: 0, writes: 0,
    readDocument: async () => { d.reads++; return d.bytes.slice() },
    writeDocument: async (_p: string, _r: string, b: Uint8Array, expected: string): Promise<DocumentWrite> => {
      if (await sha256Hex(d.bytes) !== expected) return { outcome: 'changed' }
      d.bytes = b.slice(); d.writes++
      return { outcome: 'written', fingerprint: await sha256Hex(b) }
    },
  }
  return d
}

describe('a drawing kept between saves', () => {
  let db: SqlJsDriver
  let docId: string
  let n = 0
  const draw = async () => {
    n++
    await db.run(`INSERT INTO markups(id,document_id,page_id,scope_id,kind,geometry_json,origin,created_at,updated_at)
      VALUES(?,?,?,'s1','area',?,'user',?,?)`, [`m${n}`, docId, `${docId}-p0`, JSON.stringify([sq(0.01 * n, 0.2, 0.01 * n + 0.05, 0.4)]), NOW, NOW])
  }
  beforeEach(async () => {
    forgetKeptDrawings()
    db = await SqlJsDriver.open()
    await migrate(db, migrations())
    await ingestDocuments(db, [{
      relativePath: 'A-101.pdf', displayName: 'A-101.pdf', kind: 'drawing', status: 'current', sizeBytes: 1,
      contentFingerprint: 'fp', availability: 'local', pages: [{ pageNumber: 0, widthPdfPoints: 2592, heightPdfPoints: 1728 }],
    }])
    docId = (await db.all<{ id: string }>('SELECT id FROM documents LIMIT 1'))[0]!.id
    await db.run(`INSERT INTO scopes(id,label,scope_type,color,specifications_json,created_at,updated_at)
      VALUES('s1','ACT-1','ceiling','#2f7fd1','{}',?,?)`, [NOW, NOW])
  })
  const pdf = async () => { const d = await PDFDocument.create(); d.addPage([2592, 1728]); return d.save() }
  const opts = (file: ReturnType<typeof keptDrawingFile>, embed?: SheetEmbedder) => ({
    db, documentId: docId, relativePath: 'A-101.pdf', displayName: 'A-101', appVersion: 't', file, ...(embed ? { embed } : {}),
  })

  it('reads the drawing from disk once, then saves from memory', async () => {
    const d = disk(await pdf())
    const file = keptDrawingFile(d, '/job', 'A-101.pdf')
    await draw()
    expect((await embedDrawing(opts(file))).kind).toBe('written')
    await draw()
    expect((await embedDrawing(opts(file))).kind).toBe('written')
    expect((await embedDrawing(opts(file))).kind).toBe('unchanged')
    await draw()
    expect((await embedDrawing(opts(file))).kind).toBe('written')
    expect(d.reads).toBe(1)
    expect(d.writes).toBe(3)
    expect((await readSheetEmbed(d.bytes)).redbeamAnnots).toHaveLength(3)
  })

  it('saves over what another program wrote meanwhile, keeping it, instead of over its old copy', async () => {
    const d = disk(await pdf())
    const file = keptDrawingFile(d, '/job', 'A-101.pdf')
    await draw()
    await embedDrawing(opts(file))
    // Bluebeam saves the drawing: a different file on disk.
    const theirs = await PDFDocument.load(d.bytes)
    theirs.setTitle('saved in Bluebeam')
    d.bytes = await theirs.save()
    await draw()
    expect((await embedDrawing(opts(file))).kind).toBe('written')
    expect(d.reads).toBe(2)
    expect((await PDFDocument.load(d.bytes)).getTitle()).toBe('saved in Bluebeam')
    expect((await readSheetEmbed(d.bytes)).redbeamAnnots).toHaveLength(2)
  })

  it('works with an embedder that takes the bytes away and hands them back', async () => {
    const d = disk(await pdf())
    const file = keptDrawingFile(d, '/job', 'A-101.pdf')
    // Like the worker: the caller's view is unusable afterwards.
    const moving: SheetEmbedder = async (source, input) => {
      const mine = source.slice()
      source.fill(0)
      return { result: await embedSheet(mine, input), source: mine }
    }
    await draw()
    expect((await embedDrawing(opts(file, moving))).kind).toBe('written')
    expect((await embedDrawing(opts(file, moving))).kind).toBe('unchanged')
    await draw()
    expect((await embedDrawing(opts(file, moving))).kind).toBe('written')
    expect(d.reads).toBe(1)
    expect((await readSheetEmbed(d.bytes)).redbeamAnnots).toHaveLength(2)
  })
})
