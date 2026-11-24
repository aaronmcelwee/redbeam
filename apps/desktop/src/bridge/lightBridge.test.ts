/**
 * Agents in Light (Aaron, 2026-11-24): "Using REDBEAM with AI agents forces it
 * to go back to pro mode. I want AI agents to work natively in light mode."
 *
 * Then: "lets retire pro mode altogether". The bridge's store reads
 * (bridge/methods.rs) run in the window, against the in-memory store the PDF
 * was read into. These pin the
 * pieces of that which can drift without anything else going red.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate, SqlJsDriver, type Migration } from '@redbeam/store'
import { isReadOnlySql } from './useBridgeRequests.js'

const here = dirname(fileURLToPath(import.meta.url))
const methodsRs = readFileSync(join(here, '..', '..', 'src-tauri', 'src', 'bridge', 'methods.rs'), 'utf8').replace(/\r\n/g, '\n')
const migrationsDir = join(here, '..', '..', '..', '..', 'packages', 'store', 'migrations')
const loadMigrations = (): Migration[] => readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort().map((f) => {
  const m = /^(\d+)_(.+)\.sql$/.exec(f)!
  return { version: Number(m[1]), name: m[2]!, sql: readFileSync(join(migrationsDir, f), 'utf8') }
})

describe('agents in Light', () => {
  it('lets reads through and refuses writes and second statements', () => {
    expect(isReadOnlySql('SELECT * FROM scopes')).toBe(true)
    expect(isReadOnlySql('  with x as (select 1) select * from x;  ')).toBe(true)
    expect(isReadOnlySql('DELETE FROM markups')).toBe(false)
    expect(isReadOnlySql('UPDATE scopes SET label = 1')).toBe(false)
    expect(isReadOnlySql('SELECT 1; DELETE FROM markups')).toBe(false)
    expect(isReadOnlySql('selection')).toBe(false)
  })

  it('every listing the bridge runs works on the store a Light window holds', async () => {
    // The window's store is built from the same migrations as a project's,
    // and the bridge sends it Rust's SQL verbatim, numbered parameters and
    // all. A column the in-memory store lacks would fail an agent's read.
    const body = methodsRs.slice(0, methodsRs.indexOf('#[cfg(test)]'))
    const literals = [...body.matchAll(/"((?:SELECT|WITH)\b[^"]*)"/g)].map((m) => m[1]!)
      .map((sql) => sql
        // list_markups builds its WHERE with format!.
        .replace('{where_sql}', ' WHERE deleted_at IS NULL AND page_id = ?1')
        .replace('?{}', '?2'))
    expect(literals.length).toBeGreaterThan(8)

    const db = await SqlJsDriver.open()
    await migrate(db, loadMigrations())
    for (const sql of literals) {
      expect(isReadOnlySql(sql), sql).toBe(true)
      const n = Math.max(0, ...[...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])))
      // A LIMIT takes a number, as Rust sends it; the rest are ids.
      const limitAt = /LIMIT \?(\d+)/.exec(sql)?.[1]
      const params = Array.from({ length: n }, (_, i) => (String(i + 1) === limitAt ? 10 : 'x'))
      await expect(db.all(sql, params), sql).resolves.toBeInstanceOf(Array)
    }
  })
})
