import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate, type Migration } from './index.js'
import { SqlJsDriver } from './sqljs.js'
import { ingestDocuments } from './documents.js'
import { insertMarkup, listMarkups, listScopes, upsertScope } from './repo.js'
import { listScaleRegions, saveScaleRegion } from './scaleRegions.js'
import { rotatePageData, turnNormPoint } from './rotatePage.js'

const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(here, '..', 'migrations')

function loadMigrations(): Migration[] {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => {
      const m = /^(\d+)_([a-z0-9]+)\.sql$/i.exec(f)!
      return { version: Number(m[1]), name: m[2]!, sql: readFileSync(join(migrationsDir, f), 'utf8') }
    })
}

let db: SqlJsDriver
let docId: string
const pages = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ pageNumber: i, widthPdfPoints: 612, heightPdfPoints: 792 }))

beforeEach(async () => {
  db = await SqlJsDriver.open()
  await migrate(db, loadMigrations())
  await ingestDocuments(db, [{
    relativePath: 'A-401.pdf', displayName: 'A-401.pdf', kind: 'drawing', status: 'current',
    sizeBytes: 1, contentFingerprint: 'fp', availability: 'local', pages: pages(6),
  }])
  const row = await db.all<{ id: string }>('SELECT id FROM documents LIMIT 1')
  docId = row[0]!.id
})


describe('rotating a page', () => {
  it('turns markups, scale regions, the page box and the scope directions on that sheet', async () => {
    const pageId = `${docId}-p0`
    await upsertScope(db, {
      id: 's1', label: 'ACT', scopeType: 'area', color: '#f00', archivedAt: null,
      specifications: {
        scopeDefaultDirection: { x1: 0, y1: 0, x2: 1, y2: 0 },
        areaDirections: { m1: { x1: 0, y1: 0, x2: 0, y2: 1 }, other: { x1: 0, y1: 0, x2: 0, y2: 1 } },
        areaOrigins: { m1: { x: 0.2, y: 0.3 } },
      },
    })
    await insertMarkup(db, {
      id: 'm1', scopeId: 's1', documentId: docId, pageId, kind: 'area', origin: 'manual', reviewState: 'accepted',
      rings: [[{ x: 0.1, y: 0.2 }, { x: 0.5, y: 0.2 }, { x: 0.5, y: 0.6 }]],
    })
    await saveScaleRegion(db, {
      id: 'sr', documentId: docId, pageId, label: 'D', x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.6, feetPerPdfPoint: 1, source: 'x',
    })

    const r = await rotatePageData(db, pageId, 1)
    expect(r).toEqual({ markups: 1, regions: 1, scopes: 1 })

    const [m] = await listMarkups(db, { pageId })
    expect(m!.rings[0]![0]).toEqual(turnNormPoint({ x: 0.1, y: 0.2 }, 1))
    const [sr] = await listScaleRegions(db, pageId)
    expect(sr!.x0).toBeCloseTo(0.4); expect(sr!.x1).toBeCloseTo(0.8)
    expect(sr!.y0).toBeCloseTo(0.1); expect(sr!.y1).toBeCloseTo(0.3)

    const page = await db.all<{ rotation: number; width_pdf_points: number; height_pdf_points: number }>(
      'SELECT rotation, width_pdf_points, height_pdf_points FROM pages WHERE id = ?', [pageId])
    expect(page[0]).toEqual({ rotation: 90, width_pdf_points: 792, height_pdf_points: 612 })

    const [s] = await listScopes(db)
    const spec = s!.specifications as Record<string, Record<string, unknown>>
    // The default is left alone; this sheet gets the default, turned, as its own.
    expect(spec.scopeDefaultDirection).toEqual({ x1: 0, y1: 0, x2: 1, y2: 0 })
    expect(spec.pageDirections![pageId]).toEqual({ x1: 1, y1: 0, x2: 1, y2: 1 })
    expect(spec.areaDirections!.m1).toEqual({ x1: 1, y1: 0, x2: 0, y2: 0 })
    expect(spec.areaDirections!.other).toEqual({ x1: 0, y1: 0, x2: 0, y2: 1 })
    expect(spec.areaOrigins!.m1).toEqual(turnNormPoint({ x: 0.2, y: 0.3 }, 1))
  })

  it('does nothing for no turn, and leaves other sheets alone', async () => {
    await saveScaleRegion(db, {
      id: 'sr', documentId: docId, pageId: `${docId}-p1`, label: 'D', x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.6, feetPerPdfPoint: 1, source: 'x',
    })
    expect(await rotatePageData(db, `${docId}-p0`, 4)).toEqual({ markups: 0, regions: 0, scopes: 0 })
    await rotatePageData(db, `${docId}-p0`, 1)
    const [sr] = await listScaleRegions(db, `${docId}-p1`)
    expect(sr!.x0).toBeCloseTo(0.1)
  })
})
