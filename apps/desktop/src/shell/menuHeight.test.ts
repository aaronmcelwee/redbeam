/**
 * Every menu that borrows the dock menu's surface must clear its `bottom`.
 *
 * `.dockmenu` hangs the dock's menus ABOVE their button with
 * `bottom: calc(100% + …)`. A menu that reuses the class but anchors from the
 * top — the ⋯ flyouts under a header, the context menus at the pointer — and
 * forgets `bottom: auto` is pinned by both edges at once. That is a negative
 * height, clamped to nothing, and the menu renders as a 5–8px sliver whose
 * items have to be scrolled through (Aaron, 2026-11-17: "all the ellipsis
 * menus throughout the UI").
 *
 * The test reads both sheets and every component, finds each element whose
 * class list starts with `dockmenu` and is positioned by `top` (in CSS or an
 * inline style), and requires a rule for one of its other classes that sets
 * `bottom: auto`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

function walk(dir: string, ext: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, ext, out)
    else if (p.endsWith(ext)) out.push(p)
  }
  return out
}

/** Declarations of every rule whose selector names `.cls` as its last class. */
function rulesFor(css: string, cls: string): string[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: string[] = []
  for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (m[1] ?? '').split(',').map((s) => s.trim())
    if (selectors.some((s) => new RegExp(`\\.${cls}(?![\\w-])[^\\s>+~]*$`).test(s))) out.push(m[2] ?? '')
  }
  return out
}

const css = ['styles.css', 'shell/shell.css'].map((f) => readFileSync(join(SRC, f), 'utf8')).join('\n')
const components = walk(SRC, '.tsx').map((f) => readFileSync(f, 'utf8'))

const menus: Array<{ classes: string[]; inlineTop: boolean }> = []
for (const src of components) {
  for (const m of src.matchAll(/<div\b[^>]*?className=\{?["`]dockmenu ([^"`$]*)[^>]*>/gs)) {
    menus.push({
      classes: (m[1] ?? '').split(/\s+/).filter(Boolean),
      inlineTop: /style=\{\{[^}]*\btop\b/.test(m[0]),
    })
  }
}

describe('menus on the dock-menu surface', () => {
  it('finds the ⋯ menus', () => {
    expect(menus.some((m) => m.classes.includes('es-menu'))).toBe(true)
  })

  it('clear the dock’s bottom anchor whenever they are placed from the top', () => {
    const squeezed: string[] = []
    for (const menu of menus) {
      const decls = menu.classes.flatMap((c) => rulesFor(css, c))
      const placedByTop = menu.inlineTop || decls.some((d) => /(^|;)\s*top\s*:/.test(d))
      if (!placedByTop) continue
      if (!decls.some((d) => /(^|;)\s*bottom\s*:\s*auto\b/.test(d))) squeezed.push(menu.classes.join(' '))
    }
    expect(squeezed).toEqual([])
  })
})
