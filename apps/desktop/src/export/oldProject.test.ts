import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument } from 'pdf-lib'
import { ingestDocuments, migrate, SqlJsDriver, type Migration } from '@redbeam/store'
import { embedDrawing, ensureFileRound, fileLoadVerdict, importSlice, type DrawingFile } from './drawingEmbed.js'
import { readSheetEmbed } from './sheetEmbed.js'
import {
  drawingsToTransfer, oldDrawingAt, transferComplete, transferOffer, transferOldProject, transferStatus,
  TRANSFERRED_KEY, undrawnPending,
} from './oldProject.js'

const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(here, '..', '..', '..', '..', 'packages', 'store', 'migrations')
const loadMigrations = (): Migration[] => readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort().map((f) => {
  const m = /^(\d+)_([a-z0-9]+)\.sql$/i.exec(f)!
  return { version: Number(m[1]), name: m[2]!, sql: readFileSync(join(migrationsDir, f), 'utf8') }
})

const OLD = '2026-10-01T00:00:00.000Z'
const sq = (x0: number, y0: number, x1: number, y1: number) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]
const page = { pageNumber: 0, widthPdfPoints: 2592, heightPdfPoints: 1728 }

/** A project database with these drawings, as a project window would have left it. */
async function project(paths: string[]): Promise<{ db: SqlJsDriver, ids: Record<string, string> }> {
  const db = await SqlJsDriver.open()
  await migrate(db, loadMigrations())
  await ingestDocuments(db, paths.map((p) => ({
    relativePath: p, displayName: p.replace(/^.*\//, ''), kind: 'drawing', status: 'current', sizeBytes: 1,
    contentFingerprint: `fp-${p}`, availability: 'local', pages: [page],
  })))
  const rows = await db.all<{ id: string, relative_path: string }>('SELECT id, relative_path FROM documents')
  return { db, ids: Object.fromEntries(rows.map((r) => [r.relative_path, r.id])) }
}

async function scope(db: SqlJsDriver, id: string, label: string): Promise<void> {
  await db.run(`INSERT INTO scopes(id,label,scope_type,color,specifications_json,created_at,updated_at)
    VALUES(?,?,'ceiling','#2f7fd1','{"tile":"2x2"}',?,?)`, [id, label, OLD, OLD])
}

async function area(db: SqlJsDriver, id: string, docId: string, scopeId: string, at = OLD): Promise<void> {
  await db.run(`INSERT INTO markups(id,document_id,page_id,scope_id,kind,geometry_json,origin,created_at,updated_at)
    VALUES(?,?,?,?,'area',?,'user',?,?)`, [id, docId, `${docId}-p0`, scopeId, JSON.stringify([sq(0.1, 0.2, 0.3, 0.4)]), at, at])
}

async function blankPdf(): Promise<Uint8Array> {
  const d = await PDFDocument.create()
  d.addPage([2592, 1728])
  return d.save()
}

type MemFile = DrawingFile & { bytes: Uint8Array, writes: number, locked: boolean }
function memoryFile(bytes: Uint8Array): MemFile {
  let version = 0
  const f: MemFile = {
    bytes, writes: 0, locked: false,
    read: async () => ({ bytes: f.bytes, version: String(version) }),
    write: async (b: Uint8Array, expected: string) => {
      if (f.locked || expected !== String(version)) return false
      f.bytes = b; f.writes++; version++
      return true
    },
  }
  return f
}

const gone: DrawingFile = {
  read: async () => { throw new Error('Arch/A-900.pdf: The system cannot find the file specified. (os error 2)') },
  write: async () => false,
}

/** What a Light window holds after opening this PDF. */
async function openInLight(bytes: Uint8Array): Promise<{ scopes: string[], markups: number, loaded: boolean }> {
  const { db, ids } = await project(['opened.pdf'])
  const reading = await readSheetEmbed(bytes)
  const imported = reading.slice === null ? null : await importSlice(db, ids['opened.pdf']!, reading.slice)
  await ensureFileRound(db, 'opened')
  const scopes = await db.all<{ label: string }>('SELECT label FROM scopes ORDER BY label')
  const n = await db.all<{ n: number }>('SELECT COUNT(*) AS n FROM markups WHERE deleted_at IS NULL')
  return {
    scopes: scopes.map((s) => s.label),
    markups: n[0]!.n,
    loaded: fileLoadVerdict(reading, imported, 'opened.pdf').state === 'loaded',
  }
}

describe('moving an older project into its PDFs', () => {
  it('moves each drawing\'s takeoff into its PDF, once, and a Light window then loads it', async () => {
    const { db, ids } = await project(['Arch/A-101.pdf', 'Arch/A-102.pdf', 'Arch/A-103.pdf'])
    await scope(db, 's1', 'ACT-1 Ceiling')
    await area(db, 'm1', ids['Arch/A-101.pdf']!, 's1')
    await area(db, 'm2', ids['Arch/A-102.pdf']!, 's1')
    const files: Record<string, MemFile> = {
      'Arch/A-101.pdf': memoryFile(await blankPdf()),
      'Arch/A-102.pdf': memoryFile(await blankPdf()),
    }

    // Only drawings with takeoff are on the list; A-103 has none.
    const todo = await drawingsToTransfer(db)
    expect(todo.map((d) => d.relativePath)).toEqual(['Arch/A-101.pdf', 'Arch/A-102.pdf'])

    // Opening A-101: it alone is moved, the other is still to do.
    const first = await transferOldProject({ old: db, drawings: [todo[0]!], appVersion: 't', fileFor: (d) => files[d.relativePath]! })
    expect(first.written).toEqual(['A-101.pdf'])
    expect(files['Arch/A-102.pdf']!.writes).toBe(0)
    expect((await drawingsToTransfer(db)).map((d) => d.relativePath)).toEqual(['Arch/A-102.pdf'])
    expect(transferComplete(first, 1)).toBe(false)

    const light = await openInLight(files['Arch/A-101.pdf']!.bytes)
    expect(light).toEqual({ scopes: ['ACT-1 Ceiling'], markups: 1, loaded: true })
    // The PDF names itself, not the folder a project kept it in.
    expect((await readSheetEmbed(files['Arch/A-101.pdf']!.bytes)).slice!.relativePath).toBe('A-101.pdf')

    // The one-time move of the rest.
    const rest = await transferOldProject({ old: db, drawings: await drawingsToTransfer(db), appVersion: 't', fileFor: (d) => files[d.relativePath]! })
    expect(rest.written).toEqual(['A-102.pdf'])
    expect(await drawingsToTransfer(db)).toEqual([])
    expect(transferComplete(rest, 0)).toBe(true)
    expect(transferStatus(rest, true)).toMatch(/moved into A-102\.pdf.*set aside in \.redbeam, not deleted/)

    // The old database still has every row: nothing was moved out of it.
    expect((await db.all('SELECT id FROM markups')).length).toBe(2)
    const meta = await db.all<{ value: string }>('SELECT value FROM redbeam_meta WHERE key = ?', [TRANSFERRED_KEY])
    expect(JSON.parse(meta[0]!.value)).toHaveLength(2)
  })

  it('leaves a PDF alone when its own takeoff is newer than the database\'s', async () => {
    const { db, ids } = await project(['A-101.pdf'])
    const docId = ids['A-101.pdf']!
    await scope(db, 's1', 'ACT-1 Ceiling')
    await area(db, 'm1', docId, 's1')
    const file = memoryFile(await blankPdf())

    // Someone opened the PDF in Light and drew a second area after the project last touched it.
    const light = await project(['A-101.pdf'])
    await scope(light.db, 's1', 'ACT-1 Ceiling')
    await area(light.db, 'm1', light.ids['A-101.pdf']!, 's1')
    await area(light.db, 'm9', light.ids['A-101.pdf']!, 's1', new Date().toISOString())
    await embedDrawing({ db: light.db, documentId: light.ids['A-101.pdf']!, relativePath: 'A-101.pdf', displayName: 'A-101.pdf', appVersion: 't', file, allScopes: true })
    const before = file.bytes

    const out = await transferOldProject({ old: db, drawings: await drawingsToTransfer(db), appVersion: 't', fileFor: () => file })
    expect(out.current).toEqual(['A-101.pdf'])
    expect(file.bytes).toBe(before)
    expect((await openInLight(file.bytes)).markups).toBe(2)
    expect(await drawingsToTransfer(db)).toEqual([])
  })

  it('keeps the database until a PDF that is open elsewhere can take its takeoff', async () => {
    const { db, ids } = await project(['A-101.pdf', 'A-900.pdf'])
    await scope(db, 's1', 'ACT-1 Ceiling')
    await area(db, 'm1', ids['A-101.pdf']!, 's1')
    await area(db, 'm2', ids['A-900.pdf']!, 's1')
    const file = memoryFile(await blankPdf())
    file.locked = true
    const fileFor = (d: { relativePath: string }) => d.relativePath === 'A-101.pdf' ? file : gone

    const out = await transferOldProject({ old: db, drawings: await drawingsToTransfer(db), appVersion: 't', fileFor })
    expect(out.retry).toEqual([{ name: 'A-101.pdf', why: 'it changed on disk or is open in another app' }])
    // A drawing that is no longer in the folder has nothing to move into, and does not hold the rest back.
    expect(out.missing).toEqual(['A-900.pdf'])
    const left = await drawingsToTransfer(db)
    expect(left.map((d) => d.relativePath)).toEqual(['A-101.pdf'])
    expect(transferComplete(out, left.length)).toBe(false)
    expect(transferStatus(out, false)).toMatch(/A-101\.pdf could not take its takeoff yet.*kept until it can/)

    file.locked = false
    const again = await transferOldProject({ old: db, drawings: left, appVersion: 't', fileFor })
    expect(again.written).toEqual(['A-101.pdf'])
    expect(transferComplete(again, (await drawingsToTransfer(db)).length)).toBe(true)
  })

  it('names each scope for its round when the project had more than one in use', async () => {
    const { db, ids } = await project(['A-101.pdf'])
    const docId = ids['A-101.pdf']!
    await scope(db, 's1', 'ACT-1 Ceiling')
    await scope(db, 's2', 'ACT-1 Ceiling')
    for (const [id, name, s] of [['e1', 'Bid 1', 's1'], ['e2', 'Bid 2', 's2']] as const) {
      await db.run(`INSERT INTO estimates(id,name,state,notes_json,created_at,updated_at) VALUES(?,?,'working','{}',?,?)`, [id, name, OLD, OLD])
      await db.run('INSERT INTO estimate_scopes(estimate_id,scope_id,position,created_at) VALUES(?,?,0,?)', [id, s, OLD])
    }
    await area(db, 'm1', docId, 's1')
    await area(db, 'm2', docId, 's2')
    const file = memoryFile(await blankPdf())
    await transferOldProject({ old: db, drawings: await drawingsToTransfer(db), appVersion: 't', fileFor: () => file })
    expect((await openInLight(file.bytes)).scopes).toEqual(['ACT-1 Ceiling (Bid 1)', 'ACT-1 Ceiling (Bid 2)'])
    // The database's own names are untouched.
    expect((await db.all<{ label: string }>('SELECT DISTINCT label FROM scopes')).map((r) => r.label)).toEqual(['ACT-1 Ceiling'])
  })

  it('carries scopes nothing was drawn in, once, in the first PDF written', async () => {
    const { db, ids } = await project(['A-101.pdf', 'A-102.pdf', 'A-103.pdf'])
    await scope(db, 's1', 'ACT-1 Ceiling')
    await scope(db, 's2', 'Wall panels, not started')
    await area(db, 'm1', ids['A-101.pdf']!, 's1')
    await area(db, 'm2', ids['A-102.pdf']!, 's1')
    const files: Record<string, MemFile> = {
      'A-101.pdf': memoryFile(await blankPdf()), 'A-102.pdf': memoryFile(await blankPdf()), 'A-103.pdf': memoryFile(await blankPdf()),
    }
    expect(await undrawnPending(db)).toHaveLength(1)
    await transferOldProject({ old: db, drawings: await drawingsToTransfer(db), appVersion: 't', fileFor: (d) => files[d.relativePath]! })
    expect((await openInLight(files['A-101.pdf']!.bytes)).scopes).toEqual(['ACT-1 Ceiling', 'Wall panels, not started'])
    expect((await openInLight(files['A-102.pdf']!.bytes)).scopes).toEqual(['ACT-1 Ceiling'])
    expect(await undrawnPending(db)).toEqual([])
  })

  it('puts undrawn scopes into the PDF being opened when no drawing has takeoff', async () => {
    const { db } = await project(['Arch/A-101.pdf'])
    await scope(db, 's2', 'Wall panels, not started')
    expect(await drawingsToTransfer(db)).toEqual([])
    const opened = await oldDrawingAt(db, 'arch/a-101.PDF')
    expect(opened?.relativePath).toBe('Arch/A-101.pdf')
    const file = memoryFile(await blankPdf())
    const out = await transferOldProject({ old: db, drawings: [opened!], appVersion: 't', fileFor: () => file })
    expect(out.written).toEqual(['A-101.pdf'])
    expect(await openInLight(file.bytes)).toEqual({ scopes: ['Wall panels, not started'], markups: 0, loaded: true })
  })

  it('has nothing to do for a database with no takeoff, and says nothing', async () => {
    const { db } = await project(['A-101.pdf'])
    const out = await transferOldProject({ old: db, drawings: await drawingsToTransfer(db), appVersion: 't', fileFor: () => gone })
    expect(transferComplete(out, 0)).toBe(true)
    expect(transferStatus(out, true)).toBeNull()
    expect(transferOffer(1)).toMatch(/1 other PDF\./)
    expect(transferOffer(4)).toMatch(/4 other PDFs/)
  })
})
