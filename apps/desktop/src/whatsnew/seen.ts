/**
 * When What's new opens by itself: once, on the first launch of a version the
 * person has not seen, covering every release since the one they last saw
 * (people skip several releases between launches).
 *
 * A fresh install opens nothing — there is nothing "new" to someone who has
 * never used it — and only records the version. A copy that updated from a
 * version older than this dialog has no record but does have REDBEAM's other
 * keys; it is shown this version's notes.
 */

import { compareVersions } from './changelog.js'

export const SEEN_KEY = 'redbeam.whats-new.seen'

export interface SeenStorage {
  get(key: string): string | null
  set(key: string, value: string): void
  /** Every key in storage, to tell a fresh install from an older copy. */
  keys(): string[]
}

export type LaunchDecision =
  | { show: false }
  /** `since` null: no record of what was seen, so only the current version. */
  | { show: true; since: string | null }


export function launchDecision(storage: SeenStorage, current: string): LaunchDecision {
  const seen = storage.get(SEEN_KEY)
  if (seen === null) {
    const used = storage.keys().some((k) => k.startsWith('redbeam.') && k !== SEEN_KEY)
    return used ? { show: true, since: null } : { show: false }
  }
  if (compareVersions(seen, current) < 0) return { show: true, since: seen }
  return { show: false }
}

export function markSeen(storage: SeenStorage, current: string): void {
  storage.set(SEEN_KEY, current)
}

export function browserSeenStorage(): SeenStorage {
  return {
    get: (k) => { try { return localStorage.getItem(k) } catch { return null } },
    set: (k, v) => { try { localStorage.setItem(k, v) } catch { /* shown again next launch; harmless */ } },
    keys: () => {
      try {
        const out: string[] = []
        for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k !== null) out.push(k) }
        return out
      } catch { return [] }
    },
  }
}
