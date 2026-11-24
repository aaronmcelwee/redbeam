/**
 * Copy and paste of markups, between sheets AND between open PDFs.
 *
 * Kenneth, 2026-11-24: "can you get copy paste to work between PDF's on
 * redbeam". Each tab is a fresh Workspace (App.tsx keys it on the file), so a
 * clipboard kept in the Workspace's own state was gone the moment you switched
 * tabs. This one lives at module level, which the whole window shares.
 *
 * Two things change when a copy crosses files:
 *
 * - Geometry. Markups are stored as fractions of their sheet, so the clip
 *   keeps them in PDF points and the paste turns them back into fractions of
 *   the sheet they land on. On a sheet of the same size that is the same
 *   place; on a bigger or smaller one it keeps its real size, so it still
 *   measures what it measured.
 * - Scopes. A scope id means nothing in another file. Copying takeoff between
 *   sets is copying an estimate (Aaron, 2026-11-19), so a markup goes to the
 *   scope of the same name in the file it lands in, and when that file has no
 *   such scope it gets a copy of the original, name, colour and product, the
 *   same rule "Start from another PDF" uses.
 */
import type { Scope } from '@redbeam/domain'
import { AREA_DIRECTIONS_KEY, AREA_ORIGINS_KEY, PAGE_DIRECTIONS_KEY } from '@redbeam/domain'

/** How far a paste onto the sheet it came from is moved, so the copy is visibly distinct. */
export const PASTE_NUDGE = 0.01

interface Pt { x: number; y: number }

export interface ClipItem {
  kind: string
  /** In PDF points on the sheet it was copied from. */
  rings: Pt[][]
  content?: Record<string, unknown>
  /** The scope as it was in the file it was copied from. */
  scope: Scope | null
}

export interface MarkupClip {
  documentId: string
  pageId: string
  items: ClipItem[]
}

export interface ClipSource {
  id: string
  scopeId: string | null
  kind: string
  rings: Pt[][]
  content?: Record<string, unknown>
}

let current: MarkupClip | null = null

/** What is on the clipboard, or null. Shared by every tab of the window. */
export function readClip(): MarkupClip | null { return current }

export function writeClip(clip: MarkupClip | null): void { current = clip }

/** A clip of `markups`, which are all on the sheet `page` (its size in PDF points). */
export function clipOf(
  markups: readonly ClipSource[],
  scopes: readonly Scope[],
  page: { documentId: string; pageId: string; width: number; height: number },
): MarkupClip {
  const byId = new Map(scopes.map((s) => [s.id, s]))
  return {
    documentId: page.documentId,
    pageId: page.pageId,
    items: markups.map((m) => {
      const scope = m.scopeId === null ? null : byId.get(m.scopeId) ?? null
      return {
        kind: m.kind,
        rings: m.rings.map((r) => r.map((p) => ({ x: p.x * page.width, y: p.y * page.height }))),
        ...(m.content !== undefined ? { content: structuredClone(m.content) } : {}),
        scope: scope === null ? null : { ...scope, specifications: structuredClone(scope.specifications) },
      }
    }),
  }
}

export interface PastePlan {
  /** Scopes the target file needs before the markups can go in. */
  newScopes: Scope[]
  markups: Array<{ kind: string; rings: Pt[][]; content?: Record<string, unknown>; scopeId: string | null }>
  /** Markups with a point off the sheet they landed on. */
  offSheet: number
  /** True when moved by PASTE_NUDGE (pasted onto the sheet it was copied from). */
  nudged: boolean
}

const key = (label: string) => label.trim().toLowerCase()

/**
 * What a paste of `clip` onto `target` does, given the scopes `target`'s file
 * has (live ones). Pure: the caller creates the scopes and runs the commands.
 */
export function planPaste(
  clip: MarkupClip,
  target: { documentId: string; pageId: string; width: number; height: number },
  liveScopes: readonly Scope[],
  mintScopeId: () => string,
  palette: (taken: readonly Scope[]) => string,
): PastePlan {
  const nudged = clip.documentId === target.documentId && clip.pageId === target.pageId
  const d = nudged ? PASTE_NUDGE : 0
  const ids = new Set(liveScopes.map((s) => s.id))
  const byLabel = new Map(liveScopes.map((s) => [key(s.label), s.id]))
  const mapped = new Map<string, string>()
  const newScopes: Scope[] = []

  const scopeFor = (scope: Scope | null): string | null => {
    if (scope === null) return null
    const done = mapped.get(scope.id)
    if (done !== undefined) return done
    let id: string
    if (clip.documentId === target.documentId && ids.has(scope.id)) id = scope.id
    else {
      const same = byLabel.get(key(scope.label))
      if (same !== undefined) id = same
      else {
        const specs = structuredClone(scope.specifications)
        // Keyed by markup and page ids of the other file: they match nothing here.
        delete specs[AREA_DIRECTIONS_KEY]; delete specs[AREA_ORIGINS_KEY]; delete specs[PAGE_DIRECTIONS_KEY]
        const taken = [...liveScopes, ...newScopes]
        const clash = taken.some((s) => s.color.toLowerCase() === scope.color.toLowerCase())
        const made: Scope = {
          id: mintScopeId(), label: scope.label.trim(), scopeType: scope.scopeType,
          color: clash ? palette(taken) : scope.color, specifications: specs, archivedAt: null,
        }
        newScopes.push(made)
        byLabel.set(key(made.label), made.id)
        id = made.id
      }
    }
    mapped.set(scope.id, id)
    return id
  }

  let offSheet = 0
  const markups = clip.items.map((it) => {
    const rings = it.rings.map((r) => r.map((p) => ({ x: p.x / target.width + d, y: p.y / target.height + d })))
    const off = rings.some((r) => r.some((p) => p.x < -1e-6 || p.y < -1e-6 || p.x > 1 + 1e-6 || p.y > 1 + 1e-6))
    if (off) offSheet++
    return {
      kind: it.kind, rings, scopeId: scopeFor(it.scope),
      ...(it.content !== undefined ? { content: structuredClone(it.content) } : {}),
    }
  })
  return { newScopes, markups, offSheet, nudged }
}

/** The status line after a paste. */
export function pasteStatus(plan: PastePlan, fromOtherFile: boolean): string {
  const n = plan.markups.length
  const parts = [`pasted ${n} markup${n === 1 ? '' : 's'}${fromOtherFile ? ' from the other PDF' : ''}`]
  if (plan.newScopes.length > 0) {
    parts.push(`added scope${plan.newScopes.length === 1 ? '' : 's'} ${plan.newScopes.map((s) => s.label).join(', ')}`)
  }
  if (plan.offSheet > 0) {
    parts.push(`${plan.offSheet} hang${plan.offSheet === 1 ? 's' : ''} off this sheet, which is smaller`)
  }
  return parts.join('; ')
}
