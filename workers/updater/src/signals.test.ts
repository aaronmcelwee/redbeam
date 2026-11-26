import { describe, expect, it } from 'vitest'
import worker, { type Env } from './index.js'
import { SIGNAL_PAGE, parseBatch, parseRow } from './signals.js'

const KEY = 'k'.repeat(40)
const INSTALL = '0b6f2a1e-4c1d-4f8a-9a55-3f0e2b9d1c11'
const SESSION = '7d1c9e40-2b3a-4c5d-8e6f-112233445566'

function batch(rows: unknown[] = [{ kind: 'error', name: 'TypeError', detail: 'x is undefined @ index.js:#:#', count: 3 }]) {
  return { v: 1, version: '0.3.96', os: 'Windows 11', install: INSTALL, session: SESSION, dropped: 0, rows }
}

function memoryEnv(): Env & { objects: Map<string, string> } {
  const objects = new Map<string, string>()
  return {
    objects,
    SYNC_KEY: KEY,
    UPDATES: {
      async get(key: string) {
        const v = objects.get(key)
        if (v === undefined) return null
        return { async text() { return v }, body: new ReadableStream() }
      },
      async put(key: string, value: string | Uint8Array) {
        objects.set(key, typeof value === 'string' ? value : new TextDecoder().decode(value))
        return {}
      },
      async list({ prefix, limit, startAfter }: { prefix: string; limit: number; startAfter?: string }) {
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix) && (startAfter === undefined || k > startAfter)).sort()
        return { objects: keys.slice(0, limit).map((key) => ({ key })), truncated: keys.length > limit }
      },
      async delete(key: string) { objects.delete(key) },
    },
  }
}

function post(body: unknown, env: Env): Promise<Response> {
  return worker.fetch(new Request('https://updates.example/signals', {
    method: 'POST', headers: { 'content-type': 'text/plain' }, body: typeof body === 'string' ? body : JSON.stringify(body),
  }), env)
}

describe('parseBatch', () => {
  it('keeps a well-formed batch', () => {
    const b = parseBatch(batch(), new Date('2026-11-26T12:00:00Z'))
    if (typeof b === 'string') throw new Error(b)
    expect(b.rows).toHaveLength(1)
    expect(b.rows[0]).toMatchObject({ kind: 'error', name: 'TypeError', count: 3, first_at: '2026-11-26T12:00:00.000Z' })
  })

  it('refuses ids that are not random UUIDs', () => {
    expect(parseBatch({ ...batch(), install: 'aaron-xps' }, new Date())).toMatch(/UUID/)
  })

  it('drops rows of an unknown kind or with a free-text name', () => {
    expect(parseRow({ kind: 'keystrokes', name: 'x', count: 1 }, '')).toBeNull()
    expect(parseRow({ kind: 'error', name: 'C:\\Users\\aaron\\plan.pdf', count: 1 }, '')).toBeNull()
    expect(parseRow({ kind: 'error', name: 'ok', count: 0 }, '')).toBeNull()
    expect(parseBatch(batch([{ kind: 'nope', name: 'x', count: 1 }]), new Date())).toBe('no usable rows')
  })

  it('cuts detail to 300 characters on one line', () => {
    const r = parseRow({ kind: 'friction', name: 'rage-click', detail: 'a\nb'.repeat(400), count: 1 }, '')
    expect(r?.detail.length).toBe(300)
    expect(r?.detail).not.toContain('\n')
  })
})

describe('POST /signals', () => {
  it('stores the batch under the day it arrived', async () => {
    const env = memoryEnv()
    const res = await post(batch(), env)
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    const keys = [...env.objects.keys()]
    expect(keys).toHaveLength(1)
    expect(keys[0]).toMatch(/^signals\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.json$/)
  })

  it('answers 400 for a bad body and stores nothing', async () => {
    const env = memoryEnv()
    expect((await post('not json', env)).status).toBe(400)
    expect((await post({ v: 2 }, env)).status).toBe(400)
    expect(env.objects.size).toBe(0)
  })

  it('answers the preflight', async () => {
    const res = await worker.fetch(new Request('https://updates.example/signals', { method: 'OPTIONS' }), memoryEnv())
    expect(res.status).toBe(204)
  })
})

describe('GET /signals/day/:day', () => {
  function get(path: string, env: Env, key: string | null = KEY) {
    return worker.fetch(new Request(`https://updates.example${path}`, key === null ? {} : { headers: { authorization: `Bearer ${key}` } }), env)
  }

  it('does not exist without the key', async () => {
    const env = memoryEnv()
    expect((await get('/signals/day/2026-11-26', env, null)).status).toBe(404)
    expect((await get('/signals/day/2026-11-26', env, 'wrong'.repeat(10))).status).toBe(404)
  })

  it('pages through a day', async () => {
    const env = memoryEnv()
    for (let i = 0; i < SIGNAL_PAGE + 3; i++) {
      env.objects.set(`signals/2026-11-26/${String(i).padStart(4, '0')}.json`, JSON.stringify({ id: i }))
    }
    env.objects.set('signals/2026-11-27/x.json', JSON.stringify({ id: 'other day' }))
    const first = await (await get('/signals/day/2026-11-26', env)).json() as { batches: unknown[]; after: string | null }
    expect(first.batches).toHaveLength(SIGNAL_PAGE)
    expect(first.after).not.toBeNull()
    const second = await (await get(`/signals/day/2026-11-26?after=${encodeURIComponent(first.after!)}`, env)).json() as { batches: unknown[]; after: string | null }
    expect(second.batches).toHaveLength(3)
    expect(second.after).toBeNull()
  })
})
