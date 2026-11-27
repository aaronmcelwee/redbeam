#!/usr/bin/env node
// Keeps copies of Aaron's Claude account skills in step with the master.
//
// The account skill is the only place the skill is edited. Every copy carries a
// stamp naming the master version it was made from: its date and a fingerprint
// of the master's text. Removing the stamp from a copy must give back the
// master text exactly, so a copy whose text no longer matches its own stamp was
// edited by hand, and the sync flags it instead of overwriting it.
//
//   node tools/skill-sync.mjs fingerprint <SKILL.md>
//   node tools/skill-sync.mjs check  <master SKILL.md> <copy>      exit 0 in sync, 10 behind, 20 hand-edited
//   node tools/skill-sync.mjs stamp  <master SKILL.md> <copy> [YYYY-MM-DD]
//   node tools/skill-sync.mjs notion <master SKILL.md> [YYYY-MM-DD]  prints the Notion page body
//   node tools/skill-sync.mjs loose  <file>                         fingerprint ignoring formatting (for Notion)
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const STAMP = /^master: .*\n/m
const NOTION_STAMP = /^.*Synced from Aaron's Claude skill.*$/m

/** Line endings and trailing spaces never count as a change. */
export const normalize = (text) => text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/\s+$/, '') + '\n'

const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12)

/** The fingerprint of a skill's text, with any stamp taken out first. */
export const fingerprint = (text) => sha(normalize(unstamp(text)))

/** A copy without its stamp line (the stamp sits in the front matter). */
export const unstamp = (text) => {
  const t = text.replace(/\r\n?/g, '\n')
  if (!t.startsWith('---\n')) return t
  const end = t.indexOf('\n---', 4)
  return end < 0 ? t : t.slice(0, end + 1).replace(STAMP, '') + t.slice(end + 1)
}

/** The stamp a copy carries: { date, fingerprint }, or null when it has none. */
export const readStamp = (text) => {
  const m = /^master: "?(\d{4}-\d{2}-\d{2}) sha256:([0-9a-f]{12})"?$/m.exec(text.replace(/\r\n?/g, '\n'))
  return m ? { date: m[1], fingerprint: m[2] } : null
}

/** The master's text with a stamp added as the last front matter line. */
export const stamp = (master, date) => {
  const t = normalize(unstamp(master))
  const line = `master: "${date} sha256:${fingerprint(t)}"\n`
  if (!t.startsWith('---\n')) return `---\n${line}---\n\n${t}`
  const end = t.indexOf('\n---', 4)
  return t.slice(0, end + 1) + line + t.slice(end + 1)
}

/**
 * Compares a copy with the master.
 * in_sync: the copy is the master. behind: the copy is an untouched older master.
 * hand_edited: the copy's text no longer matches its own stamp (or it has none).
 */
export const check = (master, copy) => {
  const masterFp = fingerprint(master)
  const st = readStamp(copy)
  const copyFp = fingerprint(copy)
  if (!st || st.fingerprint !== copyFp) return { status: 'hand_edited', masterFp, stamp: st, copyFp }
  return { status: copyFp === masterFp ? 'in_sync' : 'behind', masterFp, stamp: st, copyFp }
}

const frontMatter = (text) => {
  const t = normalize(unstamp(text))
  if (!t.startsWith('---\n')) return { meta: {}, body: t }
  const end = t.indexOf('\n---', 4)
  const meta = {}
  for (const line of t.slice(4, end).split('\n')) {
    const m = /^(\w[\w-]*):\s*"?(.*?)"?$/.exec(line)
    if (m) meta[m[1]] = m[2]
  }
  return { meta, body: t.slice(end + 4).replace(/^\n+/, '') }
}

/** The Notion page body: the description as a quote, the skill, and the stamp. */
export const notionBody = (master, date) => {
  const { meta, body } = frontMatter(master)
  return `> ${meta.description ?? ''}\n\n${body}\n---\n\n_Synced from Aaron's Claude skill \`${meta.name}\` · master ${date} · sha256:${fingerprint(master)} · edit the Claude skill, not this page._\n`
}

/**
 * A fingerprint that ignores formatting: letters and digits only, front matter,
 * quote markers and the Notion stamp left out. Notion rewrites markdown when it
 * stores it, so this is how a Notion page is compared with the master.
 */
export const loose = (text) => {
  let t = text.replace(/\r\n?/g, '\n').replace(NOTION_STAMP, '')
  const { meta, body } = frontMatter(t)
  if (meta.description) t = meta.description + '\n' + body
  return sha(t.toLowerCase().replace(/[^a-z0-9]+/g, ''))
}

const today = () => new Date().toISOString().slice(0, 10)

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const [cmd, a, b, c] = process.argv.slice(2)
  const read = (p) => fs.readFileSync(p, 'utf8')
  if (cmd === 'fingerprint') console.log(fingerprint(read(a)))
  else if (cmd === 'loose') console.log(loose(read(a)))
  else if (cmd === 'notion') process.stdout.write(notionBody(read(a), b ?? today()))
  else if (cmd === 'stamp') {
    fs.writeFileSync(b, stamp(read(a), c ?? today()))
    console.log(`${b}: master ${c ?? today()} sha256:${fingerprint(read(a))}`)
  } else if (cmd === 'check') {
    const r = check(read(a), read(b))
    console.log(JSON.stringify(r))
    process.exit(r.status === 'in_sync' ? 0 : r.status === 'behind' ? 10 : 20)
  } else {
    console.error('usage: skill-sync.mjs fingerprint|check|stamp|notion|loose …')
    process.exit(2)
  }
}
