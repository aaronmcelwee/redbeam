import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/*
 * The app knows which AI session a bridge call is from by a value kept on the
 * thread that serves it (bridge/ui.rs `set_caller`). A merge added a second
 * place where calls are dispatched, on a thread of its own for keepalive
 * clients, and that thread never heard who was calling: on the SLS
 * (2026-11-25) every session vanished from the Agents list and an agent's
 * markups landed outside the PDF it named. Nothing short of a real Windows
 * run noticed, so this reads the source: every dispatch names its caller.
 */
const mod = readFileSync(fileURLToPath(new URL('../../src-tauri/src/bridge/mod.rs', import.meta.url)), 'utf8')

describe('a bridge call', () => {
  it('names its caller on the thread that dispatches it, wherever it is dispatched', () => {
    const lines = mod.split('\n')
    const dispatches = lines.map((l, i) => (l.includes('methods::dispatch(') ? i : -1)).filter((i) => i >= 0)
    expect(dispatches.length).toBeGreaterThan(0)
    for (const i of dispatches) {
      const before = lines.slice(Math.max(0, i - 3), i).join('\n')
      expect(before, `mod.rs:${i + 1} dispatches without set_caller just before it`).toContain('ui::set_caller(')
    }
  })
})
