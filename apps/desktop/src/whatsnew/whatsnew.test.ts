import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  compareVersions, friendlyDate, inlineRuns, parseChangelog, recentReleases, unseenReleases,
} from './changelog.js'
import { SEEN_KEY, launchDecision, markSeen, type SeenStorage } from './seen.js'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

const SAMPLE = `# Changelog

Intro text that belongs to no release.

## 0.3.42 — 2026-11-21

### See what changed

- **After an update.** A dialog lists
  every release you missed.
- Plain point with *emphasis* and \`code\`.

## 0.3.41 — 2026-11-20

### Earlier

A paragraph that wraps
onto a second line.

## 0.3.39 — 2026-11-19

- Only a point.
`

function memory(initial: Record<string, string> = {}): SeenStorage & { data: Record<string, string> } {
  const data = { ...initial }
  return { data, get: (k) => data[k] ?? null, set: (k, v) => { data[k] = v }, keys: () => Object.keys(data) }
}

describe('parseChangelog', () => {
  const releases = parseChangelog(SAMPLE)

  it('reads each release with its date, ignoring text outside a release', () => {
    expect(releases.map((r) => [r.version, r.date])).toEqual([
      ['0.3.42', '2026-11-21'], ['0.3.41', '2026-11-20'], ['0.3.39', '2026-11-19'],
    ])
  })

  it('keeps headlines, points with their wrapped lines, and paragraphs', () => {
    expect(releases[0]!.blocks).toEqual([
      { kind: 'heading', text: 'See what changed' },
      { kind: 'item', text: '**After an update.** A dialog lists every release you missed.' },
      { kind: 'item', text: 'Plain point with *emphasis* and `code`.' },
    ])
    expect(releases[1]!.blocks[1]).toEqual({ kind: 'para', text: 'A paragraph that wraps onto a second line.' })
  })
})

describe('which releases show', () => {
  const releases = parseChangelog(SAMPLE)

  it('lists every release since the one last seen, newest first', () => {
    expect(unseenReleases(releases, '0.3.39', '0.3.42').map((r) => r.version)).toEqual(['0.3.42', '0.3.41'])
  })

  it('never lists a release newer than the running copy', () => {
    expect(unseenReleases(releases, '0.3.39', '0.3.41').map((r) => r.version)).toEqual(['0.3.41'])
  })

  it('shows only this version when nothing was recorded', () => {
    expect(unseenReleases(releases, null, '0.3.42').map((r) => r.version)).toEqual(['0.3.42'])
  })

  it('opened by hand, shows the latest few', () => {
    expect(recentReleases(releases, '0.3.42', 2).map((r) => r.version)).toEqual(['0.3.42', '0.3.41'])
  })

  it('compares versions as numbers', () => {
    expect(compareVersions('0.3.10', '0.3.9')).toBe(1)
    expect(compareVersions('0.3.9', '0.3.10')).toBe(-1)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
  })
})

describe('when it opens by itself', () => {
  it('does not open on a fresh install', () => {
    expect(launchDecision(memory(), '0.3.42')).toEqual({ show: false })
  })

  it('opens with this version for a copy that updated from before the dialog existed', () => {
    expect(launchDecision(memory({ 'redbeam.settings.v1': '{}' }), '0.3.42')).toEqual({ show: true, since: null })
  })

  it('opens after an update, covering everything since the last version seen', () => {
    expect(launchDecision(memory({ [SEEN_KEY]: '0.3.38' }), '0.3.42')).toEqual({ show: true, since: '0.3.38' })
  })

  it('opens once: not again on the same version, nor after going back a version', () => {
    const s = memory({ [SEEN_KEY]: '0.3.38' })
    markSeen(s, '0.3.42')
    expect(launchDecision(s, '0.3.42')).toEqual({ show: false })
    expect(launchDecision(s, '0.3.41')).toEqual({ show: false })
  })
})

describe('inline text', () => {
  it('keeps bold, italic and code, and leaves the rest literal', () => {
    expect(inlineRuns('**Lead.** then *this* and `x` › done')).toEqual([
      { text: 'Lead.', strong: true }, { text: ' then ' }, { text: 'this', em: true },
      { text: ' and ' }, { text: 'x', code: true }, { text: ' › done' },
    ])
  })

  it('does not treat a lone asterisk or snake_case as emphasis', () => {
    expect(inlineRuns('5 * 3 and file_name_here')).toEqual([{ text: '5 * 3 and file_name_here' }])
  })

  it('writes dates out', () => {
    expect(friendlyDate('2026-11-20')).toBe('20 November 2026')
    expect(friendlyDate('soon')).toBe('soon')
  })
})

/**
 * The release convention: every version that ships has a user-facing entry
 * in CHANGELOG.md, because that entry is what the person sees after updating.
 */
describe('CHANGELOG.md', () => {
  const releases = parseChangelog(read('../../../../CHANGELOG.md'))
  const version = (JSON.parse(read('../../src-tauri/tauri.conf.json')) as { version: string }).version

  it('has an entry for the version being built, with a headline and something under it', () => {
    const entry = releases.find((r) => r.version === version)
    expect(entry, `CHANGELOG.md has no "## ${version} — YYYY-MM-DD" entry; What's new would be empty`).toBeDefined()
    expect(entry!.blocks.some((b) => b.kind === 'heading')).toBe(true)
    expect(entry!.blocks.some((b) => b.kind !== 'heading')).toBe(true)
  })

  it('lists releases newest first', () => {
    const versions = releases.map((r) => r.version)
    expect(versions).toEqual([...versions].sort((a, b) => compareVersions(b, a)))
  })
})
