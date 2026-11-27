#!/usr/bin/env node
/**
 * Agent bench: how long each agent tool call takes in the window, and how
 * much it sends back.
 *
 *   npm run build -w @redbeam/desktop
 *   node apps/desktop/tools/agent-bench/bench.mjs --pdf <a real drawing set> [--out result.json] [--hidden] [--cpu 4]
 *
 * The real app (the built one, served by `vite preview`) runs in Chromium
 * with Tauri faked, as the UI sweep runs it (../ui-sweep/tauri-mock.js), and
 * one named AI session makes the calls a takeoff makes: open, read the
 * sheets, find text, look, measure, set up a scope, draw, count, save. Each
 * call is timed from the moment the window is handed it to the moment it
 * answers, and its answer is sized as the MCP server would send it.
 *
 * `--hidden` puts another tab in front first, so the app runs as it does
 * behind the AI app's own window: timers slowed to one a second and no
 * animation frames. A call that waits on either shows up here.
 *
 * Never commit a client's PDF. Point --pdf at one outside the repo.
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const here = dirname(fileURLToPath(import.meta.url))
const desktop = resolve(here, '../..')
const root = resolve(desktop, '../..')
const args = process.argv.slice(2)
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const PDF_PATH = arg('--pdf', join(root, 'fixtures/ui/sweep.pdf'))
const OUT = arg('--out', null)
const HIDDEN = args.includes('--hidden')
const CPU = Number(arg('--cpu', '1'))
const REPEAT = Number(arg('--repeat', '5'))
const SHEET = arg('--sheet', null)
const FIND = arg('--find', null)
const PORT = Number(process.env.RB_BENCH_PORT ?? 5197)
const BASE = `http://localhost:${PORT}/`
const FILE = 'C:\\Jobs\\Bench\\Bench set.pdf'
const AGENT = { id: 'bench-claude/B3N', client: 'claude-ai', label: 'Bench takeoff' }



function serve() {
  const vite = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: desktop, stdio: ['ignore', 'pipe', 'inherit'],
  })
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('vite preview did not start in 60 s')), 60000)
    vite.stdout.on('data', (d) => { if (String(d).includes('Local')) { clearTimeout(t); res(vite) } })
    vite.on('exit', (code) => rej(new Error(`vite exited ${code}`)))
  })
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length === 0 ? 0 : s[Math.floor(s.length / 2)] }

// Served by vite itself: a big set does not fit through the browser's debugging pipe.
const served = join(desktop, 'dist/__sweep.pdf')
if (!existsSync(join(desktop, 'dist/index.html'))) throw new Error('build first: npm run build -w @redbeam/desktop')
rmSync(served, { force: true })
symlinkSync(resolve(PDF_PATH), served)
const vite = await serve()
const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] })
browser.on('disconnected', () => console.error('the browser went away'))
const rows = []
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  const page = await context.newPage()
  page.on('pageerror', (e) => console.error('pageerror:', e.message))
  page.on('crash', () => console.error('the page crashed'))
  if (args.includes('--console')) page.on('console', (m) => console.error('console:', m.text().slice(0, 300)))
  await page.addInitScript({ path: join(here, '../ui-sweep/tauri-mock.js') })
  await page.goto(`${BASE}?role=main`)
  await page.waitForTimeout(1500)
  if (CPU > 1) {
    const cdp = await context.newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU })
  }

  /** One call, timed inside the page so the trip to Node is not counted. */
  const call = (action, params) => page.evaluate(async ([agent, a, p]) => {
    const t0 = performance.now()
    const result = await window.__sweepAgent(agent, a, p, 120000)
    return { ms: performance.now() - t0, result }
  }, [AGENT, action, params ?? {}])
  const act = (name, params) => call('invoke_ui_action', { action: name, ...(params ?? {}) })

  /** Run a step `times` times; keep every time, and the size of the last answer. */
  const step = async (name, run, times = REPEAT) => {
    const ms = []
    let last = null
    for (let i = 0; i < times; i++) {
      const r = await run(i)
      ms.push(r.ms)
      last = r.result
    }
    const isImage = typeof last?.dataUrl === 'string'
    const compact = isImage ? last.dataUrl.length : JSON.stringify(last ?? null).length
    const pretty = isImage ? compact : JSON.stringify(last ?? null, null, 2).length
    const error = typeof last?.error === 'string' ? last.error.slice(0, 160) : null
    const row = { name, n: times, first: Math.round(ms[0]), median: Math.round(median(ms)), max: Math.round(Math.max(...ms)), bytes: compact, prettyBytes: pretty, image: isImage, error }
    rows.push(row)
    console.log(`${name.padEnd(34)} first ${String(row.first).padStart(6)} ms  median ${String(row.median).padStart(6)} ms  max ${String(row.max).padStart(6)} ms  ${String(compact).padStart(8)} B${error ? '  ERROR ' + error : ''}`)
    return last
  }

  const opened = await step('open_file (wait)', () => call('open_file', { path: FILE, wait: true }), 1)
  const pageCount = Number(opened?.pageCount ?? 0)
  if (!(pageCount > 0)) {
    // Still opening after the open's own wait: poll, as an agent is told to.
    for (let i = 0; i < 200; i++) {
      const s = await call('get_ui_state', {})
      if (Number(s.result?.pageCount ?? 0) > 0) break
      await page.waitForTimeout(250)
    }
  }

  if (HIDDEN) {
    // Another tab in front: this page is now hidden, as the app is behind the AI app's window.
    const cover = await context.newPage()
    await cover.goto('about:blank')
    await cover.bringToFront()
    const vis = await page.evaluate(() => document.visibilityState)
    console.log(`(page visibility: ${vis})`)
  }

  await step('get_ui_state', () => call('get_ui_state', {}))
  await step('get_state', () => call('get_state', {}))
  const sheets = await step('list_sheets', () => act('list_sheets'))
  const list = Array.isArray(sheets?.sheets) ? sheets.sheets : []
  let target = 0
  if (SHEET !== null) {
    const hit = list.find((s) => String(s.number ?? s.sheet ?? s.code ?? '').replace(/\W/g, '').toLowerCase() === SHEET.replace(/\W/g, '').toLowerCase())
    if (hit !== undefined) target = Number(hit.page ?? hit.index ?? 0)
  }
  const other = target === 0 ? Math.min(1, Math.max(0, list.length - 1)) : 0
  console.log(`(sheets: ${list.length}; working on page ${target})`)

  await step('go_to_page', (i) => act('go_to_page', { page: i % 2 === 0 ? target : other }), REPEAT + (REPEAT % 2 === 0 ? 1 : 0))
  await act('go_to_page', { page: target })
  await step('screenshot whole sheet', () => call('screenshot', { page: target, width: 1600 }))
  await step('screenshot region 1200', () => call('screenshot', { page: target, region: { x0: 0.3, y0: 0.3, x1: 0.5, y1: 0.45 }, width: 1200 }))
  await step('get_words (sheet)', () => act('get_words', { page: target }))
  await step('get_words (box)', () => act('get_words', { page: target, rect: { x0: 0.3, y0: 0.3, x1: 0.5, y1: 0.45 } }))
  if (FIND !== null) {
    await step('find_text (whole set)', () => act('find_text', { query: FIND }), 2)
    await step('find_text (one sheet)', () => act('find_text', { query: FIND, page: target }))
  }
  await step('get_lines (box)', () => act('get_lines', { page: target, rect: { x0: 0.3, y0: 0.3, x1: 0.5, y1: 0.45 } }))
  await step('read_scale', () => act('read_scale', { page: target }))
  await step('get_scale_presets', () => act('get_scale_presets'), 1)
  await step('set_page_scale', () => act('set_page_scale', { pages: [target], presetId: 'arch-1-8' }))
  await step('measure', () => act('measure', { page: target, points: [{ x: 0.3, y: 0.3 }, { x: 0.5, y: 0.3 }, { x: 0.5, y: 0.45 }], closed: true }))
  await step('detect_pattern', () => act('detect_pattern', { page: target, rect: { x0: 0.3, y0: 0.3, x1: 0.5, y1: 0.45 } }), 2)
  await step('describe_product', () => act('describe_product', { productType: 'panels' }), 1)
  let n = 0
  const scopes = []
  await step('create_scope', async () => {
    const r = await act('create_scope', { label: `Bench CL${++n}`, scopeType: 'area', productType: 'panels' })
    const id = r.result?.scopeId ?? r.result?.id ?? r.result?.scope?.id
    if (typeof id === 'string') scopes.push(id)
    return r
  }, 3)
  const scopeId = scopes[0]
  await step('update_scope', () => act('update_scope', { scopeId, specifications: { panelWidthInches: 24, panelLengthInches: 48 } }), 3)
  await step('trace_area', () => act('trace_area', { page: target, point: { x: 0.4, y: 0.4 } }), 2)
  const square = (x, y, s) => [[{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }]]
  await step('create_markup', (i) => act('create_markup', { page: target, kind: 'area', scopeId, rings: square(0.30 + i * 0.03, 0.30, 0.02) }))
  await step('create_markups x20', (i) => act('create_markups', {
    markups: Array.from({ length: 20 }, (_, k) => ({ page: target, kind: 'area', scopeId, rings: square(0.30 + (k % 10) * 0.025, 0.40 + i * 0.05 + Math.floor(k / 10) * 0.025, 0.02) })),
  }), 2)
  await step('list_scopes', () => call('list_scopes', {}))
  await step('list_markups', () => act('list_markups', {}))
  await step('list_markups (geometry)', () => act('list_markups', { withGeometry: true }))
  await step('get_bom', () => act('get_bom', {}))
  await step('get_bom (brief)', () => act('get_bom', { brief: true }))
  await step('get_piece_list', () => act('get_piece_list', { scopeId }), 2)
  await step('get_history', () => act('get_history', {}), 2)
  await step('get_settings', () => act('get_settings', {}), 1)
  await step('save', () => act('save'), 2)
  await step('get_ui_state (after work)', () => call('get_ui_state', {}))

  const total = rows.reduce((a, r) => a + r.median * r.n, 0)
  const bytes = rows.filter((r) => !r.image).reduce((a, r) => a + r.bytes * r.n, 0)
  const pretty = rows.filter((r) => !r.image).reduce((a, r) => a + r.prettyBytes * r.n, 0)
  console.log(`\ncalls ${rows.reduce((a, r) => a + r.n, 0)}  time in the window ${(total / 1000).toFixed(1)} s  text sent back ${bytes} B compact, ${pretty} B indented`)
  if (OUT !== null) writeFileSync(OUT, JSON.stringify({ pdf: PDF_PATH, hidden: HIDDEN, cpu: CPU, pageCount: list.length, rows }, null, 2))
} finally {
  await browser.close()
  vite.kill()
  rmSync(served, { force: true })
}
