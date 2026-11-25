/**
 * The pattern library (custom patterns beta, 2026-11-25).
 *
 * Approved patterns, kept so the next job can use one again. The library is a
 * convenience, not the record: a scope that uses a pattern carries its own
 * copy of the recipe in the PDF, so a priced PDF never changes when the
 * library does, and opens the same on a machine that has never seen it.
 *
 * Stored in this machine's app storage for the beta. Every read and write is
 * guarded: a library that cannot be read is an empty library, never a crash.
 */
import { checkPatternRecipe, slugOf, type PatternRecipe } from '@redbeam/domain'

export const LIBRARY_KEY = 'redbeam.patterns.library'

export interface LibraryEntry {
  id: string
  version: number
  recipe: PatternRecipe
  savedAt: string
  savedBy: string
}

/** The storage this reads and writes: localStorage in the app, a map in tests. */
export interface KeyValue {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function store(): KeyValue | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

export function readLibrary(kv: KeyValue | null = store()): LibraryEntry[] {
  if (kv === null) return []
  try {
    const raw = kv.getItem(LIBRARY_KEY)
    if (raw === null) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((e): e is LibraryEntry =>
      typeof e === 'object' && e !== null && typeof (e as LibraryEntry).id === 'string' && checkPatternRecipe((e as LibraryEntry).recipe).ok)
  } catch {
    return []
  }
}

function write(entries: readonly LibraryEntry[], kv: KeyValue | null): boolean {
  if (kv === null) return false
  try { kv.setItem(LIBRARY_KEY, JSON.stringify(entries)); return true } catch { return false }
}

/**
 * Add an approved pattern, or a new version of one already there (same
 * libraryId, or failing that the same name). Returns the recipe as saved,
 * stamped with its library id and version, for the scope to carry.
 */
export function saveToLibrary(recipe: PatternRecipe, by: string, at: string, kv: KeyValue | null = store()): PatternRecipe {
  const entries = readLibrary(kv)
  const id = recipe.libraryId ?? entries.find((e) => e.recipe.name === recipe.name)?.id ?? uniqueId(slugOf(recipe.name), entries)
  const prior = entries.find((e) => e.id === id)
  const version = (prior?.version ?? 0) + 1
  const stamped: PatternRecipe = { ...recipe, libraryId: id, libraryVersion: version }
  const next = [...entries.filter((e) => e.id !== id), { id, version, recipe: stamped, savedAt: at, savedBy: by }]
  write(next, kv)
  return stamped
}

export function removeFromLibrary(id: string, kv: KeyValue | null = store()): boolean {
  const entries = readLibrary(kv)
  if (!entries.some((e) => e.id === id)) return false
  return write(entries.filter((e) => e.id !== id), kv)
}

export function libraryEntry(id: string, kv: KeyValue | null = store()): LibraryEntry | undefined {
  const entries = readLibrary(kv)
  return entries.find((e) => e.id === id) ?? entries.find((e) => slugOf(e.recipe.name) === slugOf(id))
}

/** A newer version in the library than the one a scope carries, or null. */
export function newerInLibrary(recipe: PatternRecipe, kv: KeyValue | null = store()): LibraryEntry | null {
  if (recipe.libraryId === undefined) return null
  const e = readLibrary(kv).find((x) => x.id === recipe.libraryId)
  return e !== undefined && e.version > (recipe.libraryVersion ?? 0) ? e : null
}

function uniqueId(base: string, entries: readonly LibraryEntry[]): string {
  let id = base
  for (let n = 2; entries.some((e) => e.id === id); n++) id = `${base}-${n}`
  return id
}
