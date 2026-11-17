import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  migrate, SqlJsDriver, UndoStack, ensureDocumentAndPage, listMarkups, upsertScope, type Migration,
} from '@redbeam/store'
import {
  resolveMarkups, deleteMarkupsCommand, rescopeMarkupsCommand, duplicateMarkupsCommand,
  DUPLICATE_NUDGE, type BatchMarkup,
} from './markupBatch.js'
import { clickMarkupRow } from './shell/markupSelection.js'

const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(here, '..', '..', '..', 'packages', 'store', 'migrations')

function loadMigrations(): Migration[] {
  return readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort().map((f) => {
    const m = /^(\d+)_([a-z0-9]+)\.sql$/i.exec(f)!
    return { version: Number(m[1]), name: m[2]!, sql: readFileSync(join(migrationsDir, f), 'utf8') }
  })
}

const ring = [[{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.1 }, { x: 0.2, y: 0.2 }]]
const mk = (id: string, pageId: string, scopeId: string | null = 's1'): BatchMarkup => ({
  id, documentId: 'doc-1', pageId, scopeId, kind: 'area', rings: ring,
})

let db: SqlJsDriver
let undo: UndoStack

async function live(): Promise<Array<{ id: string; scopeId: string | null; pageId: string }>> {
  return (await listMarkups(db, {})).map((m) => ({ id: m.id, scopeId: m.scopeId, pageId: m.pageId }))
}

beforeEach(async () => {
  db = await SqlJsDriver.open()
  await migrate(db, loadMigrations())
  await ensureDocumentAndPage(db, { id: 'doc-1', relativePath: 'a.pdf', displayName: 'A' },
    { id: 'p1', documentId: 'doc-1', pageNumber: 1, width: 1000, height: 1000 })
  await ensureDocumentAndPage(db, { id: 'doc-1', relativePath: 'a.pdf', displayName: 'A' },
    { id: 'p2', documentId: 'doc-1', pageNumber: 2, width: 1000, height: 1000 })
  for (const id of ['s1', 's2']) {
    await upsertScope(db, {
      id, label: id, scopeType: 'area', color: '#000', specifications: {}, archivedAt: null,
    } as Parameters<typeof upsertScope>[1])
  }
  undo = new UndoStack(db, 100, { mode: 'memory' })
  const { command } = duplicateMarkupsCommand([mk('a', 'p1'), mk('b', 'p1'), mk('c', 'p2')], (() => {
    const ids = ['a', 'b', 'c']; let i = 0; return () => ids[i++]!
  })(), 0)
  await undo.run(command!)
  await undo.clear()
})

describe('resolveMarkups', () => {
  it('finds markups on other sheets, preferring the open sheet’s live copy', () => {
    const onSheet = [{ ...mk('a', 'p1'), rings: [[{ x: 0.9, y: 0.9 }]] }]
    const everywhere = [mk('a', 'p1'), mk('c', 'p2')]
    const got = resolveMarkups(['c', 'a', 'a', 'gone'], onSheet, everywhere)
    expect(got.map((m) => m.id)).toEqual(['c', 'a'])
    expect(got[1]!.rings[0]![0]).toEqual({ x: 0.9, y: 0.9 })
  })
})

describe('batch commands', () => {
  it('deletes markups across sheets as one undo step', async () => {
    await undo.run(deleteMarkupsCommand([mk('a', 'p1'), mk('c', 'p2')])!)
    expect((await live()).map((m) => m.id)).toEqual(['b'])
    expect(undo.state.depth).toBe(1)
    expect(undo.state.undoLabel).toBe('delete 2 markups')
    await undo.undo()
    expect((await live()).map((m) => m.id).sort()).toEqual(['a', 'b', 'c'])
    await undo.redo()
    expect((await live()).map((m) => m.id)).toEqual(['b'])
  })

  it('rescopes only what changes, and undoes as one step', async () => {
    const cmd = rescopeMarkupsCommand([mk('a', 'p1', 's1'), mk('b', 'p1', 's2'), mk('c', 'p2', 's1')], 's2')!
    expect(cmd.label).toBe('rescope 2 markups')
    await undo.run(cmd)
    const after = await live()
    // b was passed as already in s2, so the command leaves it alone.
    expect(after.filter((m) => m.scopeId === 's2').map((m) => m.id).sort()).toEqual(['a', 'c'])
    await undo.undo()
    expect((await live()).find((m) => m.id === 'c')!.scopeId).toBe('s1')
  })

  it('moves to no scope', async () => {
    await undo.run(rescopeMarkupsCommand([mk('a', 'p1')], null)!)
    expect((await live()).find((m) => m.id === 'a')!.scopeId).toBeNull()
  })

  it('is nothing to do when nothing moves', () => {
    expect(rescopeMarkupsCommand([mk('a', 'p1', 's2')], 's2')).toBeNull()
    expect(deleteMarkupsCommand([])).toBeNull()
  })

  it('duplicates each markup onto its own sheet, nudged, and undo takes the copies back', async () => {
    let n = 0
    const { command, ids } = duplicateMarkupsCommand(
      [mk('a', 'p1'), { ...mk('c', 'p2'), kind: 'dimension', content: { label: '10ft' } }],
      () => `copy-${++n}`,
    )
    expect(ids).toEqual(['copy-1', 'copy-2'])
    await undo.run(command!)
    const rows = await listMarkups(db, {})
    const c1 = rows.find((r) => r.id === 'copy-1')!, c2 = rows.find((r) => r.id === 'copy-2')!
    expect(c1.pageId).toBe('p1')
    expect(c2.pageId).toBe('p2')
    expect(c1.rings[0]![0]!.x).toBeCloseTo(0.1 + DUPLICATE_NUDGE)
    expect(c2.content).toEqual({ label: '10ft' })
    await undo.undo()
    expect((await live()).map((m) => m.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('a single markup goes out as itself, not a batch of one', () => {
    expect(deleteMarkupsCommand([mk('a', 'p1')])!.record.op).toBe('delete_markup')
  })
})

describe('clickMarkupRow', () => {
  const visible = ['a', 'b', 'c', 'd']
  it('plain click picks one', () => {
    expect(clickMarkupRow(['a', 'b'], 'a', 'c', { toggle: false, range: false }, visible))
      .toEqual({ selected: ['c'], anchor: 'c' })
  })
  it('ctrl toggles and moves the anchor', () => {
    expect(clickMarkupRow(['a'], 'a', 'c', { toggle: true, range: false }, visible))
      .toEqual({ selected: ['a', 'c'], anchor: 'c' })
    expect(clickMarkupRow(['a', 'c'], 'c', 'a', { toggle: true, range: false }, visible))
      .toEqual({ selected: ['c'], anchor: 'a' })
  })
  it('shift takes the range as shown, either direction', () => {
    expect(clickMarkupRow(['d'], 'd', 'b', { toggle: false, range: true }, visible).selected).toEqual(['b', 'c', 'd'])
  })
  it('ctrl+shift adds the range', () => {
    expect(clickMarkupRow(['x'], 'a', 'b', { toggle: true, range: true }, visible).selected).toEqual(['x', 'a', 'b'])
  })
  it('a lost anchor falls back to a plain click', () => {
    expect(clickMarkupRow([], 'gone', 'b', { toggle: false, range: true }, visible)).toEqual({ selected: ['b'], anchor: 'b' })
  })
})
