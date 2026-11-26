/**
 * Taking a person's work out of a line of text before it leaves the machine.
 *
 * Error messages in this app name things: "Could not save Hyundai Capital
 * RCP.pdf", "C:\Users\…\Tender Docs\A-201.pdf is open in Bluebeam", a scope
 * called "CL03 – Armstrong Optima". A signal needs the shape of the message
 * so the same failure groups together, never those names. So everything that
 * could be one goes: the names of what is open, paths, anything ending in
 * .pdf, quoted text, e-mail addresses, ids, and every number (so "sheet 12"
 * and "sheet 13" are one cause).
 *
 * Over-redacting is fine; the cost is a vaguer line. Under-redacting is not.
 */

const FILE = '‹file›'

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Every name worth hiding, longest first, so "Plan A rev 2" goes before "Plan A". */
function nameList(names: Iterable<string>): string[] {
  const out = new Set<string>()
  for (const raw of names) {
    const n = raw.trim()
    if (n.length < 3) continue
    out.add(n)
    // The bare name, the name without its folder and without its extension.
    const base = n.split(/[\\/]/).pop() ?? n
    if (base.length >= 3) out.add(base)
    const stem = base.replace(/\.[A-Za-z0-9]{1,5}$/, '')
    if (stem.length >= 3) out.add(stem)
  }
  return [...out].sort((a, b) => b.length - a.length)
}

export function scrub(input: string, names: Iterable<string> = [], max = 240): string {
  let s = String(input)
  for (const n of nameList(names)) s = s.replace(new RegExp(escape(n), 'gi'), '‹name›')
  s = s
    // Where the code came from is useful; which host served it is not.
    .replace(/\b(?:https?|tauri|asset|file):\/\/[^\s/)]*\//gi, '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '‹email›')
    // Paths: a drive letter or a UNC share to the end of the clause.
    .replace(/(?:[A-Za-z]:|\\\\)[\\/][^\n"'<>|:;]*/g, '‹path›')
    .replace(/(?:^|(?<=\s))(?:~|\.{1,2})?\/(?:[^\s/]+\/)+[^\s]*/g, '‹path›')
    // Anything naming a PDF, from the start of its clause.
    .replace(/[^\n:"“”()[\]]*?\.pdf\b/gi, FILE)
    .replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|(?<![A-Za-z])'[^'\n]*'(?![A-Za-z])/g, '‹text›')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '‹id›')
    .replace(/\b[0-9a-f]{16,}\b/gi, '‹id›')
    .replace(/\d+(?:[.,]\d+)*/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/**
 * The first frames of a stack that are this app's own code, scrubbed: where
 * an error came from, which is what groups two reports of it as one.
 */
export function topFrames(stack: string, names: Iterable<string> = [], frames = 2): string {
  const lines = stack.split('\n').map((l) => l.trim()).filter((l) => /^at |@/.test(l))
  return lines.slice(0, frames).map((l) => scrub(l.replace(/^at /, ''), names, 100)).join(' < ')
}
