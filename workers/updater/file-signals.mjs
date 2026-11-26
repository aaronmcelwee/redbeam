/**
 * Turn a week of anonymous app signals into GitHub issues and one digest.
 *
 * The app counts errors, failed saves, agent tool calls, slow steps and
 * friction (apps/desktop/src/signals) and posts them to the update Worker,
 * which keeps each batch in R2 under signals/<day>/. Nightly, this runs in
 * .github/workflows/signals.yml with that run's own GITHUB_TOKEN:
 *
 *  1. Read the last seven days' batches (GET /signals/day/<day>).
 *  2. Group rows by cause: kind + name + scrubbed detail.
 *  3. Every FAILURE (an error, a failed save, a failed command) gets one
 *     issue labelled "app signal", found again by a marker in its body and
 *     rewritten with the week's numbers each night. A closed one that comes
 *     back on a newer version than it was last seen on is reopened.
 *  4. Everything else (agent tool failures and slow calls, slow steps,
 *     friction) goes in one digest issue, ranked by how many installs hit it,
 *     for the evening bug sweep to pick paper cuts from.
 *
 * Nothing here can name a file or a person: the app scrubbed it before it
 * left, and the Worker checked the shape again. Details still go inside
 * fences so a stray "@" or "#" cannot notify or link anything.
 *
 *   SYNC_KEY=… GITHUB_TOKEN=… GITHUB_REPOSITORY=owner/repo node workers/updater/file-signals.mjs
 */
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { fence } from './file-reports.mjs'

export const LABEL = 'app signal'
export const DAYS = 7
const MARKER = /<!-- redbeam-signal:([0-9a-f]{12}) -->/
const DIGEST_MARKER = '<!-- redbeam-signals-digest -->'
const LAST_SEEN = /Last seen on REDBEAM ([0-9][0-9A-Za-z.\-+]*)/

/** The days to read, oldest first, ending today (UTC). */
export function lastDays(now = new Date(), days = DAYS) {
  const out = []
  for (let i = days - 1; i >= 0; i--) out.push(new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10))
  return out
}

export function fingerprint(row) {
  return createHash('sha1').update(`${row.kind}\u0000${row.name}\u0000${row.detail ?? ''}`).digest('hex').slice(0, 12)
}

/** Semver-ish compare: 0.3.100 is after 0.3.99. */
export function newer(a, b) {
  const pa = String(a).split(/[.\-+]/).map((x) => Number(x) || 0)
  const pb = String(b).split(/[.\-+]/).map((x) => Number(x) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  }
  return false
}

/** Is this cause a defect (its own issue) rather than a paper cut (the digest)? */
export function isFailure(row) {
  if (row.kind === 'error') return true
  if (row.kind === 'save') return /:failed$/.test(row.name)
  if (row.kind === 'command') return row.name.startsWith('failed:')
  return false
}

/** Every batch's rows grouped by cause, plus the week's totals. */
export function aggregate(batches) {
  const causes = new Map()
  const installs = new Set()
  const launches = new Map()
  let dropped = 0
  for (const b of batches) {
    if (b === null || typeof b !== 'object' || !Array.isArray(b.rows)) continue
    installs.add(b.install)
    dropped += Number(b.dropped) || 0
    for (const r of b.rows) {
      if (r.kind === 'app' && r.name === 'launch') launches.set(b.version, (launches.get(b.version) ?? 0) + r.count)
      const fp = fingerprint(r)
      let c = causes.get(fp)
      if (c === undefined) {
        c = {
          fp, kind: r.kind, name: r.name, detail: r.detail ?? '', count: 0, ms_sum: 0, ms_max: 0,
          installs: new Set(), versions: new Set(), first_at: r.first_at, last_at: r.last_at, latest: '0',
        }
        causes.set(fp, c)
      }
      c.count += r.count
      c.ms_sum += r.ms_sum ?? 0
      c.ms_max = Math.max(c.ms_max, r.ms_max ?? 0)
      c.installs.add(b.install)
      c.versions.add(b.version)
      if (newer(b.version, c.latest)) c.latest = b.version
      if (r.first_at < c.first_at) c.first_at = r.first_at
      if (r.last_at > c.last_at) c.last_at = r.last_at
    }
  }
  const ranked = [...causes.values()].sort((a, b) => b.installs.size - a.installs.size || b.count - a.count)
  return { causes: ranked, installs: installs.size, launches, dropped, batches: batches.length }
}

function ms(n) {
  if (n < 1000) return `${Math.round(n)} ms`
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} s`
}

function versions(c) {
  return [...c.versions].sort((a, b) => (newer(a, b) ? 1 : newer(b, a) ? -1 : 0)).join(', ')
}

const KIND_WORD = { error: 'Error', save: 'Save failed', command: 'Command failed' }

export function issueFor(c) {
  const title = `${KIND_WORD[c.kind] ?? 'Signal'}: ${c.name}${c.detail ? ` · ${c.detail}` : ''}`.replace(/\s+/g, ' ').slice(0, 200)
  const f = fence(c.detail)
  const avg = c.count > 0 && c.ms_sum > 0 ? ` Took ${ms(c.ms_sum / c.count)} on average, ${ms(c.ms_max)} at worst.` : ''
  const body = [
    `<!-- redbeam-signal:${c.fp} -->`,
    `Counted by the app on its own (anonymous signals, Settings › General › Privacy). Rewritten nightly with the last ${DAYS} days.`,
    '',
    `**${c.kind} · ${c.name}**`,
    '',
    `${f}text`,
    c.detail || '(no detail)',
    f,
    '',
    `- **${c.count}** times on **${c.installs.size}** install${c.installs.size === 1 ? '' : 's'} in the last ${DAYS} days.${avg}`,
    `- Versions: ${versions(c)}`,
    `- First seen in this window ${String(c.first_at).slice(0, 16).replace('T', ' ')} UTC, last ${String(c.last_at).slice(0, 16).replace('T', ' ')} UTC.`,
    `- Last seen on REDBEAM ${c.latest}`,
    '',
    'File and project names, paths, quoted text and numbers were taken out in the app before it was sent, so the message is its shape, not its words.',
  ].join('\n')
  return { title, body, labels: [LABEL] }
}

function row(c) {
  const avg = c.ms_sum > 0 ? ms(c.ms_sum / c.count) : ''
  const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/[@#]/g, (m) => `\`${m}\``)
  return `| ${c.installs.size} | ${c.count} | \`${c.kind}\` | \`${c.name}\` | ${cell(c.detail)} | ${avg} | ${c.latest} |`
}

/** The digest: the week's totals and every non-failure cause, ranked. */
export function digestFor(agg, now = new Date()) {
  const rest = agg.causes.filter((c) => !isFailure(c) && c.kind !== 'app')
  const failures = agg.causes.filter(isFailure)
  const launches = [...agg.launches.entries()].sort((a, b) => (newer(a[0], b[0]) ? -1 : 1))
    .map(([v, n]) => `${v}: ${n}`).join(', ')
  const head = '| Installs | Times | Kind | Name | Detail | Avg | Latest version |\n|---:|---:|---|---|---|---:|---|'
  const section = (title, list) => list.length === 0 ? [] : [`### ${title}`, '', head, ...list.slice(0, 40).map(row), '']
  const body = [
    DIGEST_MARKER,
    `Anonymous signals from the app, last ${DAYS} days, rewritten nightly (${now.toISOString().slice(0, 16).replace('T', ' ')} UTC). Ranked by how many installs hit each one.`,
    '',
    `**${agg.installs}** installs, launches by version: ${launches || 'none'}. ${failures.length} failure cause${failures.length === 1 ? '' : 's'} have their own issues.${agg.dropped > 0 ? ` ${agg.dropped} events were counted but not kept while offline.` : ''}`,
    '',
    ...section('Friction', rest.filter((c) => c.kind === 'friction')),
    ...section('Agent tool calls that failed or ran long', rest.filter((c) => c.kind === 'agent' && !/:ok$/.test(c.name))),
    ...section('Slow steps', rest.filter((c) => c.kind === 'slow')),
    ...section('Saves', rest.filter((c) => c.kind === 'save')),
    '### How to read it',
    '',
    '- `rage-click`: a control clicked four or more times in a second and a half. It did nothing visible, or too slowly.',
    '- `dialog-dismissed`: a dialog closed without anything in it used; Avg is how long it was up.',
    '- `undo-soon`: the person undid an action within five seconds of doing it.',
    '- `abandon:*`: a shape, calibration or scale region started and dropped with Escape.',
    '- `slow`: a tile, text read or frame many times over its budget.',
  ].join('\n')
  return { title: `App signals: last ${DAYS} days`, body, labels: [LABEL] }
}

async function allIssues(api, headers, fetchImpl) {
  const out = []
  for (let page = 1; page <= 20; page++) {
    const res = await fetchImpl(`${api}/issues?labels=${encodeURIComponent(LABEL)}&state=all&per_page=100&page=${page}`, { headers })
    if (!res.ok) throw new Error(`listing issues answered ${res.status}`)
    const list = await res.json()
    out.push(...list.filter((i) => i.pull_request === undefined))
    if (list.length < 100) break
  }
  return out
}

export async function readDays({ endpoint, syncKey, days, fetchImpl = fetch }) {
  const batches = []
  for (const day of days) {
    let after = null
    for (;;) {
      const url = `${endpoint}/signals/day/${day}${after === null ? '' : `?after=${encodeURIComponent(after)}`}`
      const res = await fetchImpl(url, { headers: { authorization: `Bearer ${syncKey}` } })
      if (!res.ok) throw new Error(`GET /signals/day/${day} answered ${res.status}`)
      const page = await res.json()
      batches.push(...(page.batches ?? []))
      if (page.after === null || page.after === undefined) break
      after = page.after
    }
  }
  return batches
}

/** One pass. Returns what it did, for the run's summary. */
export async function fileSignals({ endpoint, syncKey, repo, token, now = new Date(), fetchImpl = fetch, log = console.log }) {
  const github = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'redbeam-signals',
  }
  const api = `https://api.github.com/repos/${repo}`
  const send = (url, method, body) => fetchImpl(url, { method, headers: { ...github, 'content-type': 'application/json' }, body: JSON.stringify(body) })

  const agg = aggregate(await readDays({ endpoint, syncKey, days: lastDays(now), fetchImpl }))

  const label = await send(`${api}/labels`, 'POST', { name: LABEL, color: 'fbca04', description: 'Counted by the app on its own (anonymous signals)' })
  if (!label.ok && label.status !== 422) throw new Error(`creating the label answered ${label.status}`)

  const issues = await allIssues(api, github, fetchImpl)
  const byFp = new Map()
  let digest = null
  for (const i of issues) {
    const m = MARKER.exec(String(i.body ?? ''))
    if (m !== null) byFp.set(m[1], i)
    if (String(i.body ?? '').includes(DIGEST_MARKER)) digest = i
  }

  const done = { opened: [], updated: [], reopened: [], digest: null }
  for (const c of agg.causes.filter(isFailure)) {
    const want = issueFor(c)
    const have = byFp.get(c.fp)
    if (have === undefined) {
      const res = await send(`${api}/issues`, 'POST', want)
      if (!res.ok) { log(`${c.fp}: opening answered ${res.status}`); continue }
      const made = await res.json()
      done.opened.push(made.html_url)
      continue
    }
    if (have.state === 'closed') {
      // Fixed, and still happening on a build newer than the one it was last seen on.
      const was = LAST_SEEN.exec(String(have.body ?? ''))?.[1] ?? '0'
      if (!newer(c.latest, was)) continue
      await send(`${api}/issues/${have.number}`, 'PATCH', { ...want, state: 'open' })
      await send(`${api}/issues/${have.number}/comments`, 'POST', {
        body: `Still happening on REDBEAM ${c.latest}, after this was closed (last seen on ${was} before). Reopened by the nightly signals run.`,
      })
      done.reopened.push(have.html_url)
      continue
    }
    if (have.body !== want.body || have.title !== want.title) {
      await send(`${api}/issues/${have.number}`, 'PATCH', { title: want.title, body: want.body })
      done.updated.push(have.html_url)
    }
  }

  const d = digestFor(agg, now)
  const res = digest === null
    ? await send(`${api}/issues`, 'POST', d)
    : await send(`${api}/issues/${digest.number}`, 'PATCH', { title: d.title, body: d.body, state: 'open' })
  if (res.ok) done.digest = (await res.json()).html_url
  else log(`digest: GitHub answered ${res.status}`)

  log(`${agg.batches} batches from ${agg.installs} installs; ${done.opened.length} opened, ${done.updated.length} updated, ${done.reopened.length} reopened.`)
  return { ...done, agg }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const need = (name) => {
    const v = process.env[name]
    if (v === undefined || v === '') { console.error(`${name} is not set.`); process.exit(1) }
    return v
  }
  const result = await fileSignals({
    endpoint: process.env.REDBEAM_UPDATES || 'https://redbeam-updates.trackchairking.workers.dev',
    syncKey: need('SYNC_KEY'),
    repo: need('GITHUB_REPOSITORY'),
    token: need('GITHUB_TOKEN'),
  })
  const summary = process.env.GITHUB_STEP_SUMMARY
  if (summary) {
    appendFileSync(summary, `${digestFor(result.agg).body}\n\nOpened: ${result.opened.length}, updated: ${result.updated.length}, reopened: ${result.reopened.length}. Digest: ${result.digest ?? 'not written'}\n`)
  }
}
