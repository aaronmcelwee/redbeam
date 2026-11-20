/**
 * What's new: the release notes, read from CHANGELOG.md.
 *
 * CHANGELOG.md at the repo root is the one curated, user-facing record of
 * every release. Each release thread already adds an entry to it, so the
 * dialog reads the same file rather than a second list that could drift:
 *
 *     ## 0.3.42 — 2026-11-20
 *
 *     ### One headline, in the user's words
 *
 *     - **Lead.** What changed, and what the person does differently now.
 *
 * Only that shape is understood: `##` opens a release, `###` is a headline,
 * `- ` is a point (indented lines continue it), and anything else is a
 * paragraph. Inline, `**bold**`, `*italic*` and `` `code` `` are kept.
 *
 * Pure, so it is tested on node; the file itself is bundled by
 * changelogSource.ts.
 */

export type Block =
  | { kind: 'heading'; text: string }
  | { kind: 'item'; text: string }
  | { kind: 'para'; text: string }

export interface Release {
  version: string
  /** As written after the dash, e.g. "2026-11-20"; '' when absent. */
  date: string
  blocks: Block[]
}

const RELEASE = /^##\s+v?(\d+\.\d+\.\d+)\s*(?:[—–-]\s*(.*))?$/

export function parseChangelog(md: string): Release[] {
  const releases: Release[] = []
  let current: Release | null = null
  let open: Block | null = null

  for (const raw of md.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    const release = RELEASE.exec(line)
    if (release !== null) {
      current = { version: release[1]!, date: (release[2] ?? '').trim(), blocks: [] }
      releases.push(current)
      open = null
      continue
    }
    if (/^#\s/.test(line) || /^##\s/.test(line)) { current = null; open = null; continue }
    if (current === null) continue
    if (line.trim() === '') { open = null; continue }

    const heading = /^###+\s+(.*)$/.exec(line)
    if (heading !== null) {
      current.blocks.push({ kind: 'heading', text: heading[1]!.trim() })
      open = null
      continue
    }
    const item = /^\s*[-*]\s+(.*)$/.exec(line)
    if (item !== null) {
      open = { kind: 'item', text: item[1]!.trim() }
      current.blocks.push(open)
      continue
    }
    if (open !== null) { open.text += ` ${line.trim()}`; continue }
    open = { kind: 'para', text: line.trim() }
    current.blocks.push(open)
  }
  return releases
}

/** -1, 0 or 1, comparing dotted numbers; a missing part counts as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

/**
 * The releases a person has not seen: newer than `seen`, up to and including
 * `current`, newest first. `seen` null means "only this version".
 */
export function unseenReleases(all: readonly Release[], seen: string | null, current: string): Release[] {
  return all
    .filter((r) => compareVersions(r.version, current) <= 0)
    .filter((r) => (seen === null ? compareVersions(r.version, current) === 0 : compareVersions(r.version, seen) > 0))
    .sort((a, b) => compareVersions(b.version, a.version))
}

/** The latest `count` releases up to `current`, newest first: the dialog opened by hand. */
export function recentReleases(all: readonly Release[], current: string, count: number): Release[] {
  return all
    .filter((r) => compareVersions(r.version, current) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version))
    .slice(0, count)
}

export interface Run { text: string; strong?: true; em?: true; code?: true }

/** `**bold**`, `*italic*` and `` `code` `` as runs; anything unmatched stays literal. */
export function inlineRuns(text: string): Run[] {
  const runs: Run[] = []
  const pattern = /\*\*(.+?)\*\*|`([^`]+)`|\*([^*\s][^*]*?)\*|_([^_\s][^_]*?)_(?![A-Za-z0-9])/g
  let last = 0
  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index) })
    if (m[1] !== undefined) runs.push(...inlineRuns(m[1]).map((r): Run => ({ ...r, strong: true })))
    else if (m[2] !== undefined) runs.push({ text: m[2], code: true })
    else runs.push({ text: (m[3] ?? m[4])!, em: true })
    last = m.index + m[0].length
  }
  if (last < text.length) runs.push({ text: text.slice(last) })
  return runs
}

/** "2026-11-20" as "20 November 2026"; anything else as written. */
export function friendlyDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (m === null) return date
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  const month = months[Number(m[2]) - 1]
  return month === undefined ? date : `${Number(m[3])} ${month} ${m[1]}`
}
