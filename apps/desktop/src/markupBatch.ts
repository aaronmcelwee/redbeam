/**
 * Several markups changed in one gesture, as one undo step.
 *
 * The canvas (a multi-selection) and the scope's markup list in the sidebar
 * both act on a set of markups at once: delete them, move them to another
 * scope, duplicate them. Both go through here so the two surfaces cannot
 * disagree about what "delete these six" writes or how it undoes.
 *
 * Two rules every builder keeps:
 *
 * * **A markup is found wherever it is.** The write paths used to look only at
 *   the open sheet's markups, so deleting or rescoping a markup listed in the
 *   sidebar from another sheet or another drawing did nothing at all, without
 *   a word. {@link resolveMarkups} looks at the open sheet first (its geometry
 *   is the live one, mid-drag included) and the whole project after.
 * * **One gesture, one undo step.** Several commands go out as a `batch`; a
 *   single one goes out as itself, so its undo label stays specific.
 */
import {
  batch, createMarkup, reassignScope, removeMarkup, type Command,
} from '@redbeam/store'

/** What these builders need of a markup. `content` is the per-kind payload (a dimension's label). */
export interface BatchMarkup {
  id: string
  scopeId: string | null
  documentId: string
  pageId: string
  kind: string
  rings: Array<Array<{ x: number; y: number }>>
  content?: Record<string, unknown>
}

/**
 * The markups behind a list of ids, in the order given, each once.
 *
 * `onSheet` wins over `everywhere` for the same id: it is what the canvas is
 * painting, and a markup being dragged has its new geometry there first.
 * Ids that match nothing (deleted by another window a moment ago) are dropped.
 */
export function resolveMarkups<M extends BatchMarkup>(
  ids: readonly string[],
  onSheet: readonly M[],
  everywhere: readonly M[],
): M[] {
  const byId = new Map<string, M>()
  for (const m of everywhere) byId.set(m.id, m)
  for (const m of onSheet) byId.set(m.id, m)
  const seen = new Set<string>()
  const out: M[] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    const m = byId.get(id)
    if (m !== undefined) out.push(m)
  }
  return out
}

/** One command, or several as a single undo step. Null when there is nothing to do. */
export function asOneStep(label: string, cmds: Command[]): Command | null {
  if (cmds.length === 0) return null
  return cmds.length === 1 ? cmds[0]! : batch(label, cmds)
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** Delete these markups. Each carries its sheet, so undo can say where they came back. */
export function deleteMarkupsCommand(markups: readonly BatchMarkup[]): Command | null {
  const cmds = markups.map((m) => removeMarkup({
    id: m.id, kind: m.kind, origin: 'user', documentId: m.documentId, pageId: m.pageId,
  }))
  return asOneStep(`delete ${plural(cmds.length, 'markup')}`, cmds)
}

/**
 * Move these markups to a scope (null: no scope). Markups already in it are
 * left out, so the undo step names only what actually moved.
 */
export function rescopeMarkupsCommand(
  markups: readonly BatchMarkup[],
  scopeId: string | null,
): Command | null {
  const cmds = markups
    .filter((m) => m.scopeId !== scopeId)
    .map((m) => reassignScope(m.id, m.scopeId, scopeId, { documentId: m.documentId, pageId: m.pageId }))
  return asOneStep(`rescope ${plural(cmds.length, 'markup')}`, cmds)
}

/** How far a copy is set off from its original, in normalized page units. */
export const DUPLICATE_NUDGE = 0.01

/**
 * Copy these markups, each onto its OWN sheet and in its own scope, nudged so
 * the copy is visibly a second shape. Returns the command and the new ids, so
 * the caller can select what it made.
 */
export function duplicateMarkupsCommand(
  markups: readonly BatchMarkup[],
  mint: () => string,
  nudge = DUPLICATE_NUDGE,
): { command: Command | null; ids: string[] } {
  const ids: string[] = []
  const cmds = markups.map((m) => {
    const id = mint()
    ids.push(id)
    return createMarkup({
      id, documentId: m.documentId, pageId: m.pageId, scopeId: m.scopeId,
      kind: m.kind,
      rings: m.rings.map((r) => r.map((p) => ({ x: p.x + nudge, y: p.y + nudge }))),
      origin: 'user', reviewState: 'accepted',
      ...(m.content !== undefined ? { content: structuredClone(m.content) } : {}),
    })
  })
  return { command: asOneStep(`duplicate ${plural(cmds.length, 'markup')}`, cmds), ids }
}
