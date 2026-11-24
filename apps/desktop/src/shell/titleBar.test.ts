/**
 * Guards on the title bar's two destructive-looking controls.
 *
 * Both of these shipped wrong for months and nothing caught it, because a
 * dropdown that closes your project and a dropdown that switches project look
 * identical until you click one.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8')

describe('the project switcher', () => {
  const workspace = read('../Workspace.tsx')

  /**
   * The name of the open project used to be wired straight to Close Project:
   * clicking it threw the project away and dropped you on the start screen. It
   * looked like a dropdown and behaved like a destructive action.
   */
  it('is not wired to close the project', () => {
    expect(workspace).not.toMatch(/onPickProject/)
    expect(workspace).not.toMatch(/projectMenu[\s\S]{0,200}onOpen:\s*onCloseProject/)
  })
})

describe('popping a tab out', () => {
  const workspace = read('../Workspace.tsx')
  const windowTs = read('../tauri/window.ts')

  /**
   * The context window must open on the sheet that was popped, not on whatever
   * the project opens first — so the target travels on the URL rather than the
   * new window guessing.
   */
  it('carries the document to the context window', () => {
    expect(windowTs).toMatch(/documentPath/)
    expect(workspace).toMatch(/openContextWindow\([^)]*tab\?\.relativePath\)/)
  })
})

/**
 * The estimate panel's toggle was given `class="tabadd"` — the tab strip's
 * "open another document" affordance — so the two were the same control as far
 * as the stylesheet and the DOM were concerned. A change to one would have
 * silently restyled the other, and assistive technology was told the panel
 * toggle was a way to add a tab.
 *
 * The shared thing is the SHAPE. What each button IS is the class beside it.
 */
describe('title-bar icon buttons', () => {
  const shell = readFileSync(fileURLToPath(new URL('./Shell.tsx', import.meta.url)), 'utf8')

  it('share a shape class and keep their own identity', () => {
    expect(shell).toContain('className="titleicon paneltoggle"')
    expect(shell).toContain('className="titleicon tabadd"')
  })

  it('never wear the tab affordance alone', () => {
    expect(shell).not.toMatch(/className="tabadd"/)
  })

  it('show the toggle is holding a state', () => {
    const css = readFileSync(fileURLToPath(new URL('./shell.css', import.meta.url)), 'utf8')
    expect(css).toContain('.titleicon[aria-pressed="true"]')
  })
})

/**
 * Projects are retired (Aaron, 2026-11-24: "lets retire pro mode altogether"):
 * nothing in the window gate may open one, by hand, from a URL or for an agent.
 */
describe('no way into a project', () => {
  const app = readFileSync(fileURLToPath(new URL('../App.tsx', import.meta.url)), 'utf8')

  it('never opens a project or a project window', () => {
    expect(app).not.toMatch(/project\.open\(|openProject|openRecent\(|bridge\/open-project/)
  })
})
