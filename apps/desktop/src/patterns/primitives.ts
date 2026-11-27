/**
 * The primitives library (stored primitives, Aaron 2026-11-27).
 *
 * Every version of every primitive saved on this machine: an agent saves a
 * draft (redbeam_save_primitive), the person approves it once, in the app,
 * and the next job finds it with redbeam_list_primitives. A scope carries the
 * definition it was made with in the PDF, so a new version here never changes
 * a priced scope, and the PDF opens the same where this library is empty.
 *
 * Kept in app storage beside the pattern library. Every read and write is
 * guarded: a library that cannot be read is an empty one, never a crash.
 */
import { checkPrimitiveDefinition, sameDefinition, type PrimitiveDefinition } from '@redbeam/domain'
import type { KeyValue } from './library.js'

export const PRIMITIVES_KEY = 'redbeam.primitives.library'

export interface PrimitiveEntry {
  id: string
  /** Oldest first. */
  versions: PrimitiveDefinition[]
}

function store(): KeyValue | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

export function readPrimitives(kv: KeyValue | null = store()): PrimitiveEntry[] {
  if (kv === null) return []
  try {
    const raw = kv.getItem(PRIMITIVES_KEY)
    if (raw === null) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((e): PrimitiveEntry[] => {
      if (typeof e !== 'object' || e === null || typeof (e as PrimitiveEntry).id !== 'string' || !Array.isArray((e as PrimitiveEntry).versions)) return []
      const versions = (e as PrimitiveEntry).versions.flatMap((v) => {
        const c = checkPrimitiveDefinition(v)
        return c.ok ? [{ ...c.definition, primitiveVersion: (v as PrimitiveDefinition).primitiveVersion }] : []
      })
      return versions.length > 0 ? [{ id: (e as PrimitiveEntry).id, versions }] : []
    })
  } catch {
    return []
  }
}

function write(entries: readonly PrimitiveEntry[], kv: KeyValue | null): boolean {
  if (kv === null) return false
  try { kv.setItem(PRIMITIVES_KEY, JSON.stringify(entries)); return true } catch { return false }
}

function find(entries: readonly PrimitiveEntry[], idOrName: string): PrimitiveEntry | undefined {
  const k = idOrName.trim().toLowerCase()
  const slug = k.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return entries.find((e) => e.id === k || e.id === slug)
    ?? entries.find((e) => e.versions.some((v) => v.name.toLowerCase() === k))
}

/**
 * Save a draft from an agent. The same definition as the latest version is
 * that version (nothing to approve again); anything else is the next version,
 * a draft. Returns the definition as stored.
 */
export function savePrimitiveDraft(def: PrimitiveDefinition, by: string, at: string, kv: KeyValue | null = store()): { definition: PrimitiveDefinition; isNew: boolean } {
  const entries = readPrimitives(kv)
  const entry = find(entries, def.id) ?? find(entries, def.name)
  const id = entry?.id ?? def.id
  const latest = entry?.versions[entry.versions.length - 1]
  if (latest !== undefined && sameDefinition(latest, def)) return { definition: latest, isNew: false }
  const stored: PrimitiveDefinition = {
    ...def, id, primitiveVersion: (latest?.primitiveVersion ?? 0) + 1, status: 'draft', source: def.source ?? by, savedAt: at,
  }
  delete stored.approvedBy
  delete stored.approvedAt
  const next = entry === undefined
    ? [...entries, { id, versions: [stored] }]
    : entries.map((e) => (e.id === id ? { ...e, versions: [...e.versions, stored] } : e))
  write(next, kv)
  return { definition: stored, isNew: true }
}

/** The person approves one version. Only the app calls this: the bridge has no way to. */
export function approvePrimitive(id: string, version: number, by: string, at: string, kv: KeyValue | null = store()): PrimitiveDefinition | null {
  const entries = readPrimitives(kv)
  let out: PrimitiveDefinition | null = null
  const next = entries.map((e) => e.id !== id ? e : {
    ...e,
    versions: e.versions.map((v) => {
      if (v.primitiveVersion !== version) return v
      out = { ...v, status: 'approved' as const, approvedBy: by, approvedAt: at }
      return out
    }),
  })
  if (out === null) return null
  write(next, kv)
  return out
}

/** Put a version a PDF carries (approved elsewhere, or saved before) into this library. */
export function adoptPrimitive(def: PrimitiveDefinition, kv: KeyValue | null = store()): void {
  const entries = readPrimitives(kv)
  const e = find(entries, def.id)
  if (e?.versions.some((v) => v.primitiveVersion === def.primitiveVersion)) {
    write(entries.map((x) => x.id !== e.id ? x : { ...x, versions: x.versions.map((v) => v.primitiveVersion === def.primitiveVersion ? def : v) }), kv)
    return
  }
  const versions = [...(e?.versions ?? []), def].sort((a, b) => a.primitiveVersion - b.primitiveVersion)
  write(e === undefined ? [...entries, { id: def.id, versions }] : entries.map((x) => (x.id === e.id ? { ...x, versions } : x)), kv)
}

export function removePrimitive(id: string, kv: KeyValue | null = store()): boolean {
  const entries = readPrimitives(kv)
  if (!entries.some((e) => e.id === id)) return false
  return write(entries.filter((e) => e.id !== id), kv)
}

/**
 * A primitive by id or name. Without a version: the newest approved one,
 * else the newest draft.
 */
export function getPrimitive(idOrName: string, version?: number, kv: KeyValue | null = store()): PrimitiveDefinition | undefined {
  const e = find(readPrimitives(kv), idOrName)
  if (e === undefined) return undefined
  if (version !== undefined) return e.versions.find((v) => v.primitiveVersion === version)
  const approved = e.versions.filter((v) => v.status === 'approved')
  return approved[approved.length - 1] ?? e.versions[e.versions.length - 1]
}

/** Each primitive as the list shows it: its newest version, and the newest approved one when that is older. */
export function primitiveSummaries(kv: KeyValue | null = store()): Array<{ id: string; latest: PrimitiveDefinition; approved: PrimitiveDefinition | null }> {
  return readPrimitives(kv).map((e) => {
    const approved = e.versions.filter((v) => v.status === 'approved')
    return { id: e.id, latest: e.versions[e.versions.length - 1]!, approved: approved[approved.length - 1] ?? null }
  })
}
