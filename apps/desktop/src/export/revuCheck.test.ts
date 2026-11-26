/**
 * A check against real Revu files, run by hand (skipped unless REVU_IN is
 * set): takes a PDF Bluebeam marked up, moves one held markup, recolours
 * another and deletes a third through the same save path the app uses, and
 * writes the result to REVU_OUT for opening in Revu.
 *
 *   REVU_IN=marked.pdf REVU_OUT=edited.pdf npx vitest run revuCheck
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument } from 'pdf-lib'
import { ingestDocuments, migrate, SqlJsDriver, type Migration } from '@redbeam/store'
import { adoptForeignAnnots } from './adopt.js'
import { embedDrawing, type DrawingFile } from './drawingEmbed.js'
import { readSheetEmbed } from './sheetEmbed.js'

const IN = process.env['REVU_IN']
const OUT = process.env['REVU_OUT'] ?? 'revu-edited.pdf'
const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(here, '..', '..', '..', '..', 'packages', 'store', 'migrations')

describe.skipIf(IN === undefined)('Revu round trip', () => {
  it('moves, recolours and deletes held markups in a real file', async () => {
    const bytes = new Uint8Array(readFileSync(IN!))
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false })
    const db = await SqlJsDriver.open()
    await migrate(db, readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort().map((f): Migration => {
      const m = /^(\d+)_([a-z0-9]+)\.sql$/i.exec(f)!
      return { version: Number(m[1]), name: m[2]!, sql: readFileSync(join(migrationsDir, f), 'utf8') }
    }))
    await ingestDocuments(db, [{
      relativePath: 'in.pdf', displayName: 'in.pdf', kind: 'drawing', status: 'current', sizeBytes: bytes.length,
      contentFingerprint: 'fp', availability: 'local',
      pages: pdf.getPages().map((p, i) => ({ pageNumber: i, widthPdfPoints: p.getWidth(), heightPdfPoints: p.getHeight() })),
    }])
    const [doc] = await db.all<{ id: string }>('SELECT id FROM documents LIMIT 1')
    const docId = doc!.id
    await adoptForeignAnnots(db, docId, await readSheetEmbed(bytes))
    const held = await db.all<{ id: string, geometry_json: string, content_json: string }>(
      "SELECT id, geometry_json, content_json FROM markups WHERE kind = 'annot' ORDER BY id")
    const report: string[] = [`held markups: ${held.length}`]
    const label = (r: { content_json: string }) => {
      const c = JSON.parse(r.content_json) as { subject?: string, annot?: { subtype?: string }, adopted?: { nm?: string } }
      return `${c.subject ?? c.annot?.subtype ?? '?'} (${c.adopted?.nm})`
    }
    for (const r of held) report.push(`  ${label(r)}`)
    const [move, recolour, remove] = held
    if (move !== undefined) {
      const rings = JSON.parse(move.geometry_json) as Array<Array<{ x: number, y: number }>>
      await db.run('UPDATE markups SET geometry_json = ? WHERE id = ?',
        [JSON.stringify(rings.map((ring) => ring.map((p) => ({ x: p.x + 0.05, y: p.y + 0.05 })))), move.id])
      report.push(`moved right and down by 5% of the page: ${label(move)}`)
    }
    if (recolour !== undefined) {
      const c = JSON.parse(recolour.content_json) as Record<string, Record<string, unknown>>
      await db.run('UPDATE markups SET content_json = ? WHERE id = ?',
        [JSON.stringify({ ...c, annot: { ...c['annot'], color: '#0070ff' } }), recolour.id])
      report.push(`recoloured blue: ${label(recolour)}`)
    }
    if (remove !== undefined) {
      await db.run('UPDATE markups SET deleted_at = ? WHERE id = ?', [new Date().toISOString(), remove.id])
      report.push(`deleted: ${label(remove)}`)
    }
    let current: Uint8Array = bytes
    let version = 0
    const file: DrawingFile = {
      read: async () => ({ bytes: current, version: String(version) }),
      write: async (b, expected) => { if (expected !== String(version)) return false; current = b; version++; return true },
    }
    const outcome = await embedDrawing({ db, documentId: docId, relativePath: 'in.pdf', displayName: 'in.pdf', appVersion: 'revu-check', file, allScopes: true })
    report.push(`save: ${outcome.kind}`)
    writeFileSync(OUT, current)
    writeFileSync(`${OUT}.txt`, report.join('\n') + '\n')
    console.log(report.join('\n'))
    expect(held.length).toBeGreaterThan(0)
  })
})
