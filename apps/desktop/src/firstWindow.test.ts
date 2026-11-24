import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/*
 * lib.rs builds the first window itself, so that an AI app starting REDBEAM
 * does not bring it to the front. If tauri.conf.json also creates that window,
 * the app dies at launch with "a webview with label 'main' already exists".
 * A merge that took main's config dropped the flag once (0.3.78 test build,
 * 2026-11-24) and nothing short of starting the Windows build noticed.
 */
const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')

describe('the first window', () => {
  const conf = JSON.parse(read('../src-tauri/tauri.conf.json'))
  const lib = read('../src-tauri/src/lib.rs')
  const first = conf.app.windows[0]

  it('is built by exactly one of lib.rs and tauri.conf.json', () => {
    const builtInCode = /WebviewWindowBuilder::from_config\(/.test(lib)
    expect(builtInCode).toBe(first.create === false)
  })

  it('leaves no other configured window to be created twice', () => {
    expect(conf.app.windows).toHaveLength(1)
    expect(first.label).toBe('main')
  })
})
