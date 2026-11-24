/**
 * An agent asking to work in a PDF the person has open themselves.
 *
 * Aaron, 2026-11-24: "agent actions should NEVER steal focus, from other
 * apps or even within the app." So an agent turns pages, zooms and picks
 * tools only in tabs it drives: the ones it opened, and the ones the person
 * handed it. In the person's own tab it can read, and draw on the sheet that
 * is showing, but the first call that would move the view puts a question in
 * front of the person instead — in that tab's warning bar and on the agent's
 * chip in the tab strip — and waits a few seconds for the answer.
 *
 * "Let it work here" hands the tab over (lightTabs.ts `owner`): it moves to
 * the agent's group and the person can keep watching, or go elsewhere.
 * "Not now" refuses, and the agent is told so at once for the next few
 * minutes rather than asked about again on every call.
 */
import { samePath } from '../lightTabs.js'

export interface HandoverAsk {
  file: string
  agentId: string
  /** Epoch ms it was first asked. */
  at: number
}

export type HandoverAnswer = 'yes' | 'no' | 'waiting'

/** How long "Not now" holds before the same agent may ask about the same PDF again. */
export const REFUSAL_MS = 5 * 60_000

export class HandoverStore {
  private asks: readonly HandoverAsk[] = []
  private readonly refused = new Map<string, number>()
  private readonly waiters = new Map<string, Array<(a: 'yes' | 'no') => void>>()
  private readonly listeners = new Set<() => void>()
  private readonly now: () => number

  constructor(now: () => number = () => Date.now()) { this.now = now }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  /** The questions waiting for the person, oldest first. */
  get = (): readonly HandoverAsk[] => this.asks

  /** Whether the person said "Not now" to this agent for this PDF recently. */
  isRefused(file: string, agentId: string): boolean {
    const until = this.refused.get(key(file, agentId))
    if (until === undefined) return false
    if (until > this.now()) return true
    this.refused.delete(key(file, agentId))
    return false
  }

  /**
   * Put the question up (once, however many calls are waiting on it) and
   * wait up to `waitMs` for the answer. 'waiting' means it is still up.
   */
  ask(file: string, agentId: string, waitMs: number): Promise<HandoverAnswer> {
    if (this.isRefused(file, agentId)) return Promise.resolve('no')
    const k = key(file, agentId)
    if (!this.asks.some((a) => key(a.file, a.agentId) === k)) {
      this.asks = [...this.asks, { file, agentId, at: this.now() }]
      this.changed()
    }
    return new Promise<HandoverAnswer>((resolve) => {
      let done = false
      const settle = (a: HandoverAnswer) => {
        if (done) return
        done = true
        clearTimeout(timer)
        const list = this.waiters.get(k)
        if (list !== undefined) {
          const i = list.indexOf(settle)
          if (i >= 0) list.splice(i, 1)
        }
        resolve(a)
      }
      const timer = setTimeout(() => settle('waiting'), Math.max(0, waitMs))
      const list = this.waiters.get(k) ?? []
      list.push(settle)
      this.waiters.set(k, list)
    })
  }

  /** The person answered. The caller hands the tab over on a yes; this only records and wakes the waiters. */
  answer(file: string, agentId: string, yes: boolean): void {
    const k = key(file, agentId)
    if (!yes) this.refused.set(k, this.now() + REFUSAL_MS)
    else this.refused.delete(k)
    this.remove((a) => key(a.file, a.agentId) === k, yes ? 'yes' : 'no')
  }

  /** The tab closed, or was handed to someone: nothing left to ask about it. */
  dropFile(file: string): void {
    this.remove((a) => samePath(a.file, file), 'no')
    for (const k of [...this.refused.keys()]) if (k.startsWith(`${fold(file)}|`)) this.refused.delete(k)
  }

  /** The agent is gone: its questions go with it. */
  dropAgent(agentId: string): void {
    this.remove((a) => a.agentId === agentId, 'no')
  }

  private remove(match: (a: HandoverAsk) => boolean, tell: 'yes' | 'no'): void {
    const gone = this.asks.filter(match)
    // Waiters may outlive the ask (answered from the agent's chip after it timed out).
    const keys = new Set(gone.map((a) => key(a.file, a.agentId)))
    for (const k of keys) {
      for (const settle of [...(this.waiters.get(k) ?? [])]) settle(tell)
      this.waiters.delete(k)
    }
    if (gone.length === 0) return
    this.asks = this.asks.filter((a) => !match(a))
    this.changed()
  }

  private changed(): void {
    for (const fn of [...this.listeners]) fn()
  }
}

const fold = (file: string): string => file.replace(/\//g, '\\').toLowerCase()
const key = (file: string, agentId: string): string => `${fold(file)}|${agentId}`

/** This window's handover questions. */
export const handovers = new HandoverStore()
