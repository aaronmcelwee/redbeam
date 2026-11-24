/**
 * Undoable commands, and the stack they live on.
 *
 * # Two implementations of one stack, and why
 *
 * Under Tauri the stack is **not here**. `docs/DECISIONS.md` :: D1 puts one
 * chronological stack per open project in the Rust core, shared by every window
 * on that project: a per-page stack cannot undo a peer's edit, and an absolute
 * before-image can silently clobber newer work. So in that mode `UndoStack` is
 * a thin client over `undo_record` / `undo_apply` / `undo_redo` / `undo_state`,
 * and the mutation, the pop and the concurrency check all happen inside one
 * hold of the core's lock.
 *
 * In a plain browser there is exactly one page, one sql.js database and no IPC,
 * and the in-memory stack below is correct as it stands. It is kept as the
 * browser fallback rather than deleted — it is how the app is iterated on
 * without a desktop build, and it is what the tests in `commands.test.ts` pin
 * down.
 *
 * # A command is data as well as a pair of closures
 *
 * `{label, apply(db), revert(db)}` closes over JS values, and a core that never
 * saw the closure cannot revert it (D1: "Commands become serializable records,
 * not closures"). Every factory below therefore returns both: the closures the
 * in-memory path runs, and a [`UndoRecord`] — op, entity, before-image,
 * after-image — that crosses the IPC hop and lands in the `undo_log` table.
 * The two must describe the same effect; `apply.rs` in the core mirrors
 * `repo.ts` statement for statement so that they do.
 *
 * Deliberately NOT built on change_sets. That table is a propose/decide model
 * (`state` defaults to 'proposed', with `decided_at` and `revision_of_id`) and
 * belongs to the agent review gate that pairs with `markups.review_state`.
 * Undo is a local editing concern; routing it through the review queue would
 * mean every vertex nudge showed up as something for a human to approve.
 */
import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import type { SqlDriver } from './index.js'
import { isTauriAvailable, type TauriInvokeFn } from './tauri-driver.js'
import {
  insertMarkup, updateMarkupGeometry, deleteMarkup, restoreMarkup, assignMarkupScope,
  saveCalibration, deleteCalibration, logActivity, markupExists,
  type MarkupRow,
} from './repo.js'

// ---------------------------------------------------------------- records ----

/** Wire spelling of an op. Matches `OpKind` in `src-tauri/src/undo/record.rs`. */
export type UndoOpKind =
  | 'create_markup'
  | 'delete_markup'
  | 'edit_geometry'
  | 'reassign_scope'
  | 'set_calibration'
  | 'batch'

/**
 * A command as data — what the core stores in `undo_log` and replays the
 * inverse of.
 *
 * `documentId` / `pageId` are not bookkeeping. D1 requires undo to navigate to
 * what it reverted ("An undo you cannot see is the failure mode"), and the
 * window cannot go to a markup on page 12 without being told which page that
 * is. Where a factory's existing signature cannot supply them, they are
 * accepted as an optional `where` argument rather than guessed.
 */
export interface UndoRecord {
  op: UndoOpKind
  label: string
  entityType: 'markup' | 'page' | 'batch'
  entityId: string | null
  documentId: string | null
  pageId: string | null
  before: unknown
  after: unknown
  /** Anything but 'user' is logged but never enters the user's stack. */
  origin: string
}

export interface Command {
  /** Short human label, shown in the UI ("Undo move markup"). */
  label: string
  /** The same command as data, for the core's stack. */
  record: UndoRecord
  apply(db: SqlDriver): Promise<void>
  revert(db: SqlDriver): Promise<void>
}

/** Optional location, for commands whose signature predates D1's navigation rule. */
export interface EntityLocation {
  documentId?: string | null
  pageId?: string | null
}

type Rings = MarkupRow['rings']

const USER = 'user'

function locate(where: EntityLocation | undefined): Pick<UndoRecord, 'documentId' | 'pageId'> {
  return { documentId: where?.documentId ?? null, pageId: where?.pageId ?? null }
}

// --------------------------------------------------------------- factories ---

export function createMarkup(m: MarkupRow): Command {
  const record: UndoRecord = {
    op: 'create_markup',
    label: `create ${m.kind}`,
    entityType: 'markup',
    entityId: m.id,
    documentId: m.documentId,
    pageId: m.pageId,
    before: null,
    after: {
      id: m.id, documentId: m.documentId, pageId: m.pageId, scopeId: m.scopeId,
      kind: m.kind, rings: m.rings, origin: m.origin, reviewState: m.reviewState,
      // The per-kind payload rides along, because the REDO path rebuilds the
      // row from this image rather than from the closure. Without it a
      // dimension replayed as a line with no offset and no label — the two
      // things that make it a dimension.
      content: m.content ?? {},
    },
    origin: m.origin,
  }
  return {
    label: record.label,
    record,
    async apply(db) {
      // On a REDO the row still exists — revert() soft-deletes rather than
      // dropping it, so a plain INSERT would violate the primary key. Restore
      // the existing row and put its geometry back instead.
      if (await markupExists(db, m.id)) {
        await restoreMarkup(db, m.id)
        await updateMarkupGeometry(db, m.id, m.rings)
      } else {
        await insertMarkup(db, m)
      }
      await logActivity(db, {
        eventType: 'markup.created', entityType: 'markup', entityId: m.id,
        origin: m.origin, details: { kind: m.kind },
      })
    },
    async revert(db) {
      // soft delete rather than DELETE: the row is an audit record, and a redo
      // must be able to bring back the same id.
      await deleteMarkup(db, m.id)
      await logActivity(db, {
        eventType: 'markup.create_undone', entityType: 'markup', entityId: m.id, origin: m.origin,
      })
    },
  }
}

export function removeMarkup(
  m: Pick<MarkupRow, 'id' | 'kind' | 'origin'> & EntityLocation,
): Command {
  const record: UndoRecord = {
    op: 'delete_markup',
    label: `delete ${m.kind}`,
    entityType: 'markup',
    entityId: m.id,
    ...locate(m),
    before: { kind: m.kind, origin: m.origin },
    after: null,
    origin: m.origin,
  }
  return {
    label: record.label,
    record,
    async apply(db) {
      await deleteMarkup(db, m.id)
      await logActivity(db, {
        eventType: 'markup.deleted', entityType: 'markup', entityId: m.id, origin: m.origin,
      })
    },
    async revert(db) {
      await restoreMarkup(db, m.id)
      await logActivity(db, {
        eventType: 'markup.restored', entityType: 'markup', entityId: m.id, origin: m.origin,
      })
    },
  }
}

/**
 * Who issued this command.
 *
 * Load-bearing, not bookkeeping: undo DEPTH counts only `user` entries, so
 * Ctrl+Z steps past an agent's work to the person's own. An agent-issued
 * command logged as `user` therefore makes the estimator's next undo revert
 * something they never did.
 */
export function editGeometry(
  id: string,
  before: Rings,
  after: Rings,
  what = 'edit',
  where?: EntityLocation,
  origin: string = USER,
): Command {
  const record: UndoRecord = {
    op: 'edit_geometry',
    label: what,
    entityType: 'markup',
    entityId: id,
    ...locate(where),
    before,
    after,
    origin,
  }
  return {
    label: what,
    record,
    async apply(db) {
      await updateMarkupGeometry(db, id, after)
      await logActivity(db, {
        eventType: 'markup.geometry_changed', entityType: 'markup', entityId: id,
        origin, details: { what },
      })
    },
    async revert(db) {
      // NOTE: this in-memory path writes the before-image unconditionally.
      // That is safe in the browser, where one page owns the whole database.
      // The desktop path does NOT do this — the core checks the row's
      // updated_at and its own after-image first, and refuses rather than
      // clobber a peer. See `src-tauri/src/undo/apply.rs :: guard`.
      await updateMarkupGeometry(db, id, before)
      await logActivity(db, {
        eventType: 'markup.geometry_reverted', entityType: 'markup', entityId: id, origin,
      })
    },
  }
}

export function reassignScope(
  id: string,
  before: string | null,
  after: string | null,
  where?: EntityLocation,
  origin: string = USER,
): Command {
  const record: UndoRecord = {
    op: 'reassign_scope',
    label: 'change scope',
    entityType: 'markup',
    entityId: id,
    ...locate(where),
    before,
    after,
    origin,
  }
  return {
    label: record.label,
    record,
    async apply(db) {
      await assignMarkupScope(db, id, after)
      await logActivity(db, {
        eventType: 'markup.scope_changed', entityType: 'markup', entityId: id,
        origin, details: { from: before, to: after },
      })
    },
    async revert(db) {
      await assignMarkupScope(db, id, before)
    },
  }
}

export function setCalibration(
  documentId: string,
  pageId: string,
  before: number | null,
  after: number,
  source = 'reference-line',
  origin: string = USER,
): Command {
  const record: UndoRecord = {
    op: 'set_calibration',
    label: 'calibrate page',
    entityType: 'page',
    entityId: pageId,
    documentId,
    pageId,
    before,
    after: { feetPerPdfPoint: after, source },
    origin,
  }
  return {
    label: record.label,
    record,
    async apply(db) {
      await saveCalibration(db, { documentId, pageId, feetPerPdfPoint: after, source })
      await logActivity(db, {
        eventType: 'page.calibrated', entityType: 'page', entityId: pageId,
        origin, details: { feetPerPdfPoint: after, previous: before },
      })
    },
    async revert(db) {
      // A page that had no calibration must go back to having none, not to a
      // bogus zero — the schema CHECK would reject that anyway.
      if (before === null) await deleteCalibration(db, pageId)
      else await saveCalibration(db, { documentId, pageId, feetPerPdfPoint: before, source })
    },
  }
}

/** Several commands applied and reverted as one unit. */
export function batch(label: string, commands: Command[]): Command {
  // A batch that contains anything an agent applied is itself agent-origin, and
  // so stays off the user's stack: reversing an accepted proposal belongs at the
  // review gate, not on Ctrl+Z.
  const origin = commands.find((c) => c.record.origin !== USER)?.record.origin ?? USER
  const record: UndoRecord = {
    op: 'batch',
    label,
    entityType: 'batch',
    entityId: null,
    documentId: commands[0]?.record.documentId ?? null,
    pageId: commands[0]?.record.pageId ?? null,
    before: null,
    after: { children: commands.map((c) => c.record) },
    origin,
  }
  return {
    label,
    record,
    async apply(db) {
      for (const c of commands) await c.apply(db)
    },
    async revert(db) {
      // reverse order, or later commands undo onto state their predecessors
      // have not yet restored
      for (let i = commands.length - 1; i >= 0; i--) await commands[i]!.revert(db)
    },
  }
}

// ------------------------------------------------------------------ state ----

/** Where a command points, so the UI can name it and navigate to it. */
export interface UndoTarget {
  entityType: string
  entityId: string | null
  documentId: string | null
  pageId: string | null
}

export interface UndoState {
  canUndo: boolean
  canRedo: boolean
  undoLabel: string | null
  redoLabel: string | null
  depth: number
  /**
   * What `undo()` would act on. D1 requires the control to say what it will
   * undo and the window to navigate there afterwards, which a bare label
   * cannot support.
   *
   * Optional in the type, always present in what `UndoStack.state` returns:
   * existing callers build a starting `UndoState` as an object literal, and
   * requiring these would break them for no gain. Read them with `?? null`.
   */
  undoTarget?: UndoTarget | null
  redoTarget?: UndoTarget | null
}

/** What an undo or redo actually did. `null` at the ends of the stack. */
export interface UndoOutcome {
  op: string
  label: string
  target: UndoTarget | null
}

const EMPTY_STATE: UndoState = {
  canUndo: false, canRedo: false, undoLabel: null, redoLabel: null, depth: 0,
  undoTarget: null, redoTarget: null,
}

function targetOf(record: UndoRecord): UndoTarget {
  return {
    entityType: record.entityType,
    entityId: record.entityId,
    documentId: record.documentId,
    pageId: record.pageId,
  }
}

/**
 * Read a status envelope from the core.
 *
 * The core spells these camelCase (see `undo/log.rs`), unlike `OpenInfo`, which
 * is snake_case and camelized by `tauri-driver.ts`. Both spellings are accepted
 * here so this does not become the thing that breaks if that choice is ever
 * revisited on the Rust side.
 */
function readState(raw: unknown): UndoState {
  const r = (raw ?? {}) as Record<string, unknown>
  const pick = <T>(camel: string, snake: string, fallback: T): T =>
    (r[camel] ?? r[snake] ?? fallback) as T
  return {
    canUndo: Boolean(pick('canUndo', 'can_undo', false)),
    canRedo: Boolean(pick('canRedo', 'can_redo', false)),
    undoLabel: pick<string | null>('undoLabel', 'undo_label', null),
    redoLabel: pick<string | null>('redoLabel', 'redo_label', null),
    depth: Number(pick('depth', 'depth', 0)) || 0,
    undoTarget: readTarget(pick<unknown>('undoTarget', 'undo_target', null)),
    redoTarget: readTarget(pick<unknown>('redoTarget', 'redo_target', null)),
  }
}

function readTarget(raw: unknown): UndoTarget | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  return {
    entityType: String(r.entityType ?? r.entity_type ?? ''),
    entityId: (r.entityId ?? r.entity_id ?? null) as string | null,
    documentId: (r.documentId ?? r.document_id ?? null) as string | null,
    pageId: (r.pageId ?? r.page_id ?? null) as string | null,
  }
}

// ------------------------------------------------------------------ stack ----

export type UndoMode = 'auto' | 'memory' | 'core'

export interface UndoStackOptions {
  /**
   * 'auto' (the default) delegates to the core inside a Tauri webview and keeps
   * everything in memory anywhere else. The explicit values exist for tests.
   */
  mode?: UndoMode
  /** Override the IPC transport. Injectable so tests need no Tauri runtime. */
  invoke?: TauriInvokeFn
  /**
   * The project this stack belongs to — the folder or `.db` path `db_open`
   * was given. Sent with every core call, because the core keeps one
   * connection PER PROJECT and an unaddressed undo would act on whichever
   * project was opened last: a second window on another project would undo
   * this one's work. Omitted only where no project is open (tests).
   */
  projectPath?: string
}

const defaultInvoke: TauriInvokeFn = (cmd, args) => tauriInvoke(cmd, args ?? {})

/**
 * The undo stack.
 *
 * In **core mode** this object holds no stack at all — only a cache of the last
 * status the core reported, so that `state` can stay a synchronous getter for
 * the toolbar. The cache refreshes on every awaited operation; call
 * `fetchState()` to refresh it after a peer window's edit (the change broadcast
 * in `sync.ts` is the signal for that).
 *
 * In **memory mode** it is the stack, exactly as before. Pushing a new command
 * clears the redo branch, which is the behaviour every editor has: once you
 * diverge, the old future is gone.
 */
/** Whose command it is on the in-memory stack: the person, or one AI session's id. */
export type UndoActor = string
export const PERSON: UndoActor = 'user'

/** `seq`: when it was last applied or reverted, among everything on this stack. */
interface Entry { cmd: Command; actor: UndoActor; seq: number }

/** Every entity a command touches: its own, or its children's for a batch. */
function entitiesOf(record: UndoRecord): string[] {
  if (record.op === 'batch') {
    const children = (record.after as { children?: UndoRecord[] } | null)?.children ?? []
    return children.flatMap(entitiesOf)
  }
  return record.entityId === null ? [] : [record.entityId]
}

/**
 * Raised when one actor's undo would run over another's later work on the
 * same thing. The message is written to be shown as it is.
 */
export class UndoBlocked extends Error {}

/** The undo stack's default depth: in practice, every step of the session. */
export const UNBOUNDED_UNDO = Number.MAX_SAFE_INTEGER

export class UndoStack {
  private done: Entry[] = []
  private undone: Entry[] = []
  private cached: UndoState = EMPTY_STATE
  private readonly core: boolean
  private readonly invoke: TauriInvokeFn

  constructor(
    private db: SqlDriver,
    /*
     * No depth cap by default (Aaron, 2026-11-24: no arbitrary caps). An
     * entry is a few kilobytes of before/after, so a whole day of takeoff
     * fits; a test can still pass a small number. A safe integer rather than
     * Infinity because the core path sends it over JSON.
     */
    private limit = UNBOUNDED_UNDO,
    opts: UndoStackOptions = {},
  ) {
    const mode = opts.mode ?? 'auto'
    this.core = mode === 'core' || (mode === 'auto' && isTauriAvailable())
    this.invoke = opts.invoke ?? defaultInvoke
    this.projectPath = opts.projectPath ?? null
  }

  private readonly projectPath: string | null

  /** The arguments every core call carries: which project it is about. */
  private addressed(args: Record<string, unknown> = {}): Record<string, unknown> {
    return this.projectPath === null ? args : { ...args, projectPath: this.projectPath }
  }

  /** Is this stack the core's, shared with every other window on the project? */
  get isProjectScoped(): boolean {
    return this.core
  }

  /**
   * Apply a command and record it as `actor`'s.
   *
   * In memory mode each actor undoes only its own work (Aaron, 2026-11-24:
   * a person and an agent work in one open PDF at once, and Ctrl+Z must not
   * take back what the agent just drew). The core's stack, for the old
   * project mode, stays one chronological stack and ignores `actor`.
   */
  async run(cmd: Command, actor: UndoActor = PERSON): Promise<void> {
    if (this.core) {
      // The core performs the write as well as logging it. That is not an
      // optimisation: the `updated_at` the concurrency guard compares against
      // has to be read in the same lock hold as the write it describes, and
      // D1 wants the mutation in the core rather than in a window's local state.
      this.cached = readState(
        await this.invoke('undo_record', this.addressed({
          record: cmd.record,
          apply: true,
          limit: this.limit,
        })),
      )
      return
    }
    await cmd.apply(this.db)
    this.remember(cmd, actor)
  }

  /** Record a command whose effect has ALREADY been applied. */
  async push(cmd: Command, actor: UndoActor = PERSON): Promise<void> {
    if (this.core) {
      this.cached = readState(
        await this.invoke('undo_record', this.addressed({
          record: cmd.record,
          apply: false,
          limit: this.limit,
        })),
      )
      return
    }
    this.remember(cmd, actor)
  }

  /**
   * Undo the most recent command — in core mode, the most recent anywhere in
   * the project, whichever window made it.
   *
   * Rejects when the core refuses the revert because the entity moved under it.
   * That message is written to be shown to the estimator as it is.
   */
  async undo(actor: UndoActor = PERSON): Promise<UndoOutcome | null> {
    if (this.core) return this.step('undo_apply')
    const at = lastOf(this.done, actor)
    if (at < 0) return null
    const entry = this.done[at]!
    // Someone else changed the same thing afterwards: reverting under them
    // would put back an image their change was never made against.
    this.guard(entry, this.done.slice(at + 1), 'undo')
    await entry.cmd.revert(this.db)
    this.done.splice(at, 1)
    entry.seq = ++this.seq
    this.undone.push(entry)
    return { op: entry.cmd.record.op, label: entry.cmd.label, target: targetOf(entry.cmd.record) }
  }

  async redo(actor: UndoActor = PERSON): Promise<UndoOutcome | null> {
    if (this.core) return this.step('undo_redo')
    const at = lastOf(this.undone, actor)
    if (at < 0) return null
    const entry = this.undone[at]!
    // What has been done since it was undone.
    this.guard(entry, this.done.filter((d) => d.seq > entry.seq), 'redo')
    await entry.cmd.apply(this.db)
    this.undone.splice(at, 1)
    entry.seq = ++this.seq
    this.done.push(entry)
    return { op: entry.cmd.record.op, label: entry.cmd.label, target: targetOf(entry.cmd.record) }
  }

  private seq = 0

  private guard(entry: Entry, later: readonly Entry[], what: 'undo' | 'redo'): void {
    const mine = new Set(entitiesOf(entry.cmd.record))
    if (mine.size === 0) return
    const clash = later.find((l) => l.actor !== entry.actor && entitiesOf(l.cmd.record).some((id) => mine.has(id)))
    if (clash === undefined) return
    const who = clash.actor === PERSON ? 'you' : entry.actor === PERSON ? 'an AI session' : 'another session'
    throw new UndoBlocked(
      `cannot ${what} "${entry.cmd.label}" yet: ${who} changed the same markup afterwards ("${clash.cmd.label}"). Undo that first.`,
    )
  }

  /** Drop the stack without reverting anything. */
  async clear(): Promise<void> {
    this.done = []
    this.undone = []
    if (this.core) this.cached = readState(await this.invoke('undo_clear', this.addressed()))
    else this.cached = EMPTY_STATE
  }

  /**
   * Re-read the shared state from the core.
   *
   * In core mode `canUndo` and `undoLabel` change because of what someone else
   * did, so a window that only ever refreshed after its own edits would show a
   * stale label. Call this when a project-change broadcast arrives.
   */
  async fetchState(): Promise<UndoState> {
    if (this.core) this.cached = readState(await this.invoke('undo_state', this.addressed()))
    return this.state
  }

  /**
   * The state as of the last completed operation.
   *
   * Synchronous, because the toolbar renders from it. In core mode it is a
   * cache — accurate immediately after any awaited call on this object, and
   * refreshed by `fetchState()` otherwise.
   */
  get state(): UndoState {
    return this.stateFor(PERSON)
  }

  /**
   * What `actor` can undo and redo. `depth` counts everyone's commands: it
   * answers "has anything changed since this was opened", whoever changed it.
   */
  stateFor(actor: UndoActor): UndoState {
    if (this.core) return this.cached
    const top = this.done[lastOf(this.done, actor)]?.cmd
    const next = this.undone[lastOf(this.undone, actor)]?.cmd
    return {
      canUndo: top !== undefined,
      canRedo: next !== undefined,
      undoLabel: top?.label ?? null,
      redoLabel: next?.label ?? null,
      depth: this.done.length,
      undoTarget: top ? targetOf(top.record) : null,
      redoTarget: next ? targetOf(next.record) : null,
    }
  }

  // ------------------------------------------------------------- internals ---

  private async step(command: 'undo_apply' | 'undo_redo'): Promise<UndoOutcome | null> {
    const raw = (await this.invoke<Record<string, unknown>>(command, this.addressed())) ?? {}
    this.cached = readState(raw.status ?? raw)
    if (!raw.ok) return null
    return {
      op: String(raw.op ?? ''),
      label: String(raw.label ?? ''),
      target: readTarget(raw.target ?? null),
    }
  }

  /**
   * Put a command on the in-memory stack.
   *
   * Agent-origin commands are recorded like anyone's. They used to be applied
   * and left off the stack, because in Pro an agent's proposal was reversed at
   * the review gate. Light has no gate: an AI app's write is accepted as it
   * lands, so leaving it off the stack meant neither the app nor the person
   * could take it back (found testing 0.3.59 on a scratch copy).
   */
  private remember(cmd: Command, actor: UndoActor): void {
    this.done.push({ cmd, actor, seq: ++this.seq })
    // Diverging drops the actor's own old future, and nobody else's.
    this.undone = this.undone.filter((u) => u.actor !== actor)
    if (this.done.length > this.limit) this.done.shift()
  }
}

function lastOf(list: readonly Entry[], actor: UndoActor): number {
  for (let i = list.length - 1; i >= 0; i--) if (list[i]!.actor === actor) return i
  return -1
}
