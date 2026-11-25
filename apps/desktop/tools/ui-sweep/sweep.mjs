#!/usr/bin/env node
/**
 * UI sweep: the real app, every main surface, screenshotted and checked.
 *
 *   npm run test:ui                     (from the repo root)
 *   node apps/desktop/tools/ui-sweep/sweep.mjs [--keep-going] [--only <step>]
 *
 * Why it exists. 0.3.47 to 0.3.49 shipped with the Light window's text near
 * white on near white, and nothing in CI looked at the app. This runs the
 * actual App, not the harness, in Chromium with Tauri faked (tauri-mock.js)
 * and a small drawing set (fixtures/ui/sweep.pdf), walks every surface a
 * person reaches, and fails on what a person would call broken:
 *
 *   - text below WCAG AA contrast, and buttons with no name (axe-core);
 *   - a menu that opens empty, or a popover that hangs off the window;
 *   - a menu, picker or panel that Escape does not close;
 *   - a scroller the wheel does not scroll (Settings did not, 0.3.22-0.3.50);
 *   - thumbnails stretched to fill a short set;
 *   - an uncaught error.
 *
 * Every step runs twice: on the opaque window (Windows 10, the browser) and
 * over Windows 11's Mica, where the chrome is transparent over the dark
 * glass the window is pinned to (0.3.50). Screenshots of both land in
 * apps/desktop/ui-sweep-out/, which CI keeps as an artifact: look at them
 * when a release changes the chrome.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const here = dirname(fileURLToPath(import.meta.url))
const desktop = resolve(here, '../..')
const root = resolve(desktop, '../..')
const out = join(desktop, 'ui-sweep-out')
const require = createRequire(import.meta.url)
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8')
const PDF = readFileSync(join(root, 'fixtures/ui/sweep.pdf'))
const PORT = Number(process.env.RB_SWEEP_PORT ?? 5199)
const BASE = `http://localhost:${PORT}/`
const FILE = 'C:\\Jobs\\Sweep\\Sweep set.pdf'
const view = (file) => `${BASE}?view=${encodeURIComponent(file)}`

const args = process.argv.slice(2)
const keepGoing = args.includes('--keep-going')
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null

/** The Mica colour DWM paints behind a window pinned Dark (Mica Alt, dark). */
// What DWM draws behind transparent chrome: Mica tinted dark or light by the window theme.
const MICA = { dark: process.env.RB_SWEEP_MICA ?? '#202020', light: process.env.RB_SWEEP_MICA_LIGHT ?? '#F3F3F3' }

// ------------------------------------------------------------- checks --

/** Everything wrong on screen right now, as sentences. */
async function inspect(page) {
  const problems = []
  await page.evaluate(AXE)
  const axe = await page.evaluate(async () => {
    // eslint-disable-next-line no-undef
    const r = await axe.run(document, {
      runOnly: ['color-contrast', 'button-name'],
      resultTypes: ['violations'],
    })
    return r.violations.flatMap((v) => v.nodes.map((n) =>
      `${v.id}: ${(n.any[0]?.message ?? v.help).replace(/\s+/g, ' ').slice(0, 140)} at ${n.target.join(' ')}`))
  })
  problems.push(...axe)
  problems.push(...await page.evaluate(ownContrast))
  problems.push(...await page.evaluate(() => {
    const found = []
    const shown = (el) => {
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'
    }
    const name = (el) => (el.getAttribute('aria-label') ?? el.className ?? el.tagName).toString().slice(0, 40)
    // A listbox may be empty (no recent files); a menu that opens may not.
    for (const menu of document.querySelectorAll('[role="menu"]')) {
      if (!shown(menu)) continue
      const items = [...menu.querySelectorAll('[role^="menuitem"], [role="option"], button')].filter(shown)
      if (items.length === 0) found.push(`empty menu: ${name(menu)} opened with nothing in it`)
    }
    for (const pop of document.querySelectorAll('[role="menu"], [role="listbox"], [role="dialog"]')) {
      if (!shown(pop)) continue
      const r = pop.getBoundingClientRect()
      if (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) {
        found.push(`off-window: ${name(pop)} at ${Math.round(r.left)},${Math.round(r.top)}-${Math.round(r.right)},${Math.round(r.bottom)} in ${innerWidth}x${innerHeight}`)
      }
    }
    // The dock's groups sit side by side or wrap; never one under the other.
    const groups = [...document.querySelectorAll('.dock > .dockgroup')].filter(shown).map((g) => g.getBoundingClientRect())
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const a = groups[i]; const b = groups[j]
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) {
          found.push('the dock\'s groups overlap')
        }
      }
    }
    if (document.documentElement.scrollWidth > innerWidth + 1) {
      found.push(`the window scrolls sideways: ${document.documentElement.scrollWidth} px wide in ${innerWidth}`)
    }
    return found
  }))
  return problems
}

/**
 * Contrast the way the window composites it, which axe will not judge.
 *
 * axe gives up ("incomplete") on text whose background is transparent all the
 * way down, and that is exactly the chrome over Mica: in 0.3.49 every pane
 * was transparent over pale glass and axe passed it. This walks each text's
 * ancestors, blending their background colours down to the window's, and
 * holds it to 3:1, the floor below which text stops being readable at a
 * glance (0.3.49's panes measured 1.0:1). axe holds what it can judge to AA.
 * Disabled controls, and rows drawn as off, are exempt, as WCAG has them.
 */
function ownContrast() {
  const parse = (c) => {
    // color-mix() computes to color(srgb r g b / a), channels 0 to 1.
    const s = c.match(/color\(srgb ([^)]+)\)/)
    if (s) {
      const v = s[1].split(/[ /]+/).filter(Boolean).map(Number)
      return [v[0] * 255, v[1] * 255, v[2] * 255, v.length > 3 ? v[3] : 1]
    }
    const m = c.match(/rgba?\(([^)]+)\)/)
    if (!m) return [0, 0, 0, 0]
    const v = m[1].split(/[ ,/]+/).filter(Boolean).map(Number)
    return [v[0], v[1], v[2], v.length > 3 ? v[3] : 1]
  }
  const over = (top, under) => {
    const a = top[3] + under[3] * (1 - top[3])
    if (a === 0) return [0, 0, 0, 0]
    return [0, 1, 2].map((i) => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a).concat(a)
  }
  const lum = ([r, g, b]) => {
    const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
  const windowBg = parse(getComputedStyle(document.documentElement).backgroundColor)
  const ground = windowBg[3] === 0 ? [255, 255, 255, 1] : over(windowBg, [255, 255, 255, 1])
  const found = new Map()
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let t = walker.nextNode(); t !== null; t = walker.nextNode()) {
    if (t.textContent.trim() === '') continue
    const el = t.parentElement
    if (el === null || el.closest('[disabled], [aria-disabled="true"], [aria-hidden="true"], .off, svg, canvas')) continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue
    // Every layer between the text and the window, top first.
    const layers = []
    let opacity = 1
    let pictured = false
    for (let n = el; n !== null; n = n.parentElement) {
      const ns = getComputedStyle(n)
      opacity *= Number(ns.opacity)
      if (ns.backgroundImage !== 'none' && !ns.backgroundImage.startsWith('url("data:image/svg')) {
        // A gradient or a picture: judged by eye in the screenshots, not here.
        if (!ns.backgroundImage.includes('gradient')) { pictured = true; break }
      }
      const bg = parse(ns.backgroundColor)
      if (bg[3] > 0) layers.push(bg)
      if (bg[3] >= 1) break
    }
    if (pictured || opacity < 0.4) continue
    let under = ground
    for (const layer of layers.reverse()) under = over(layer, under)
    const ink = parse(cs.color)
    const seen = over([ink[0], ink[1], ink[2], ink[3] * opacity], under)
    const need = 3
    const got = ratio(seen, under)
    if (got < need) {
      const key = `${el.className}|${cs.color}`
      if (!found.has(key)) found.set(key, `low contrast ${got.toFixed(2)}:1 (needs ${need}) "${t.textContent.trim().slice(0, 30)}" in .${String(el.className).split(' ')[0] || el.tagName}`)
    }
  }
  return [...found.values()].slice(0, 12)
}

// -------------------------------------------------------------- steps --

const button = (page, name) => page.getByRole('button', { name, exact: true })
const row = (page, number) => page.locator('.sheetrow', { hasText: number }).first()

// AI sessions: two chats in one app (one MCP server, two sessions) and one in another.
const AGENTS = [
  { id: 'sweep-claude/7K2', client: 'claude-ai', label: 'Nokia Canada North Campus takeoff' },
  { id: 'sweep-claude/M4Q', client: 'claude-ai', label: 'Level 2 ceilings' },
  { id: 'sweep-chatgpt/9XB', client: 'chatgpt', label: 'Clinic framing session' },
]
const AGENT_FILES = ['C:\\Jobs\\Agents\\Tower A.pdf', 'C:\\Jobs\\Agents\\Tower B.pdf', 'C:\\Jobs\\Agents\\Clinic.pdf']
/** One bridge call from an agent, answered by the window (tauri-mock.js). */
const agentCall = (page, agent, action, params) => page.evaluate(([a, b, c]) => window.__sweepAgent(a, b, c), [agent, action, params ?? {}])
const agentAct = (page, agent, name, params) => agentCall(page, agent, 'invoke_ui_action', { action: name, ...params })
/** The PDF showing: with agents about, others are mounted behind it. */
const shown = (page) => page.locator('.wshost[data-showing="true"]')
/** What the person has in front of them: which tab, which sheet, where the keyboard is. */
const person = (page) => page.evaluate(() => {
  const ws = document.querySelector('.wshost[data-showing="true"]')
  const a = document.activeElement
  return {
    tab: ws?.querySelector('.tab.active .tabname')?.textContent ?? null,
    sheet: ws?.querySelector('.sheetrow[aria-current], .sheetrow.active, .sheetrow[aria-selected="true"]')?.textContent ?? null,
    focus: a === null || a === document.body ? 'body' : `${a.tagName}.${String(a.className).split(' ')[0]}`,
  }
})

/** Open something, check it, and check Escape takes it away again. */
async function opensAndEscapes(page, open, gone, label) {
  await open()
  await page.waitForTimeout(250)
  const problems = await inspect(page)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
  if (await page.locator(gone).filter({ visible: true }).count() > 0) problems.push(`Escape left ${label} open`)
  return problems
}

/**
 * Each step leaves the app where the next expects it. A step returns extra
 * problems of its own (on top of `inspect` after it).
 */
const STEPS = [
  ['start', async (page) => { await page.goto(BASE); await page.waitForTimeout(800) }],
  ['viewer', async (page) => {
    await page.goto(view(FILE))
    await page.locator('.sheetrow, [data-page]').first().waitFor({ timeout: 20000 })
    await page.waitForTimeout(1500)
  }],
  ['contents-menu', async (page) => {
    await row(page, 'G1.01').click()
    await row(page, 'A1.02').click({ modifiers: ['Shift'] })
    return opensAndEscapes(page, () => row(page, 'A1.02').click({ button: 'right' }), '[role="menu"]', 'the sheet menu')
  }],
  ['set-scale', async (page) => {
    await row(page, 'A6.01').click({ button: 'right' })
    await page.getByRole('menuitem', { name: /Set scale/ }).click()
    await page.waitForTimeout(300)
    const problems = await inspect(page)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)
    if (await page.getByRole('button', { name: 'Apply', exact: true }).count() > 0) problems.push('Escape left the scale picker open')
    return problems
  }],
  ['bookmarks', async (page) => {
    await page.getByRole('tab', { name: 'Bookmarks', exact: true }).click()
    await page.waitForTimeout(300)
  }],
  ['thumbnails', async (page) => {
    await button(page, 'Thumbnails').click()
    await page.waitForTimeout(2500)
    return page.evaluate(() => {
      const t = document.querySelector('.thumb canvas')
      const cell = t?.closest('.thumb')
      if (!t || !cell) return ['thumbnails: none drawn']
      const extra = cell.getBoundingClientRect().height - t.getBoundingClientRect().height
      return extra > 48 ? [`thumbnails: each cell is ${Math.round(extra)} px taller than its picture`] : []
    })
  }],
  ['search', async (page) => {
    await button(page, 'Search').click()
    await page.keyboard.type('CEILING')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(2500)
    const note = await page.getByText('Limited search').count()
    return note > 0 ? ['search: Light shows the database\'s "Limited search" note'] : []
  }],
  ['every-menu', async (page) => {
    await button(page, 'Contents').click()
    const problems = []
    // Every menu button on screen: opens with something in it, and Escape closes it.
    const count = await page.locator('button[aria-haspopup]').count()
    for (let i = 0; i < count; i++) {
      const b = page.locator('button[aria-haspopup]').nth(i)
      if (!(await b.isVisible()) || !(await b.isEnabled())) continue
      const label = (await b.getAttribute('aria-label')) ?? (await b.innerText()).trim()
      try { await b.click({ timeout: 3000 }) } catch { problems.push(`${label}: shown but cannot be clicked (something covers it)`); continue }
      await page.waitForTimeout(250)
      for (const p of await inspect(page)) problems.push(`${label}: ${p}`)
      await page.screenshot({ path: join(out, `${shotPrefix}every-menu-${String(i).padStart(2, '0')}.png`) })
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
      if ((await b.getAttribute('aria-expanded')) === 'true') {
        problems.push(`${label}: Escape did not close its menu`)
        await b.click({ force: true }).catch(() => {})
      }
    }
    return problems
  }],
  ['palette', async (page) => {
    await page.locator('.viewport').click({ position: { x: 200, y: 200 } })
    await page.keyboard.press('Control+k')
    await page.waitForTimeout(300)
    const problems = await inspect(page)
    const rows = await page.locator('.palette-panel [role="option"]').count()
    if (rows < 6) problems.push(`palette: opens with only ${rows} row(s)`)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    if (await page.locator('.palette-panel').count() > 0) problems.push('Escape left the palette open')
    return problems
  }],
  ['hide-markups', async (page) => {
    await page.locator('.viewport').click({ position: { x: 200, y: 200 } })
    await page.keyboard.press('Control+k')
    await page.waitForTimeout(300)
    await page.keyboard.type('Hide all markups')
    await page.waitForTimeout(200)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(800)
    const problems = await inspect(page)
    const shown = await page.getByRole('button', { name: 'Show markups' }).count()
    if (shown === 0) problems.push('hide-markups: no "Show markups" button says markups are hidden')
    else {
      await page.screenshot({ path: join(out, `${shotPrefix}hide-markups-bar.png`) })
      await page.getByRole('button', { name: 'Show markups' }).first().click()
      await page.waitForTimeout(300)
      if (await page.getByRole('button', { name: 'Show markups' }).count() > 0) problems.push('hide-markups: "Show markups" did not bring them back')
    }
    return problems
  }],
  ['settings', async (page) => {
    await button(page, 'Settings').last().click()
    await page.waitForTimeout(400)
    const problems = await inspect(page)
    await page.mouse.move(640, 500)
    for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 200); await page.waitForTimeout(60) }
    await page.waitForTimeout(300)
    const top = await page.evaluate(() => document.querySelector('.prefs-layer')?.scrollTop ?? 0)
    if (top === 0) problems.push('settings: the wheel does not scroll the page')
    await page.screenshot({ path: join(out, `${shotPrefix}settings-scrolled.png`) })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)
    if (await page.locator('.prefs-layer').count() > 0) problems.push('Escape left Settings open')
    return problems
  }],
  ['export', async (page) => {
    await button(page, 'Export…').click()
    await page.waitForTimeout(300)
    const problems = await inspect(page)
    await button(page, 'Close').last().click()
    return problems
  }],
  ['add-scope', async (page) => {
    await button(page, 'Add scope').first().click()
    await page.keyboard.type('C-MT-01')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(800)
  }],
  ['takeoff', async (page) => {
    await page.getByRole('button', { name: /^Take off/ }).first().click()
    await page.waitForTimeout(300)
    const box = await page.locator('.viewport').boundingBox()
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    for (const [dx, dy] of [[-120, -80], [120, -80], [120, 80], [-120, 80]]) {
      await page.mouse.click(x + dx, y + dy)
      await page.waitForTimeout(120)
    }
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1200)
  }],
  ['takeoff-menus', async (page) => {
    const problems = []
    const count = await page.locator('button[aria-haspopup]').count()
    for (let i = 0; i < count; i++) {
      const b = page.locator('button[aria-haspopup]').nth(i)
      if (!(await b.isVisible()) || !(await b.isEnabled())) continue
      const label = (await b.getAttribute('aria-label')) ?? (await b.innerText()).trim()
      try { await b.click({ timeout: 3000 }) } catch { problems.push(`${label}: shown but cannot be clicked (something covers it)`); continue }
      await page.waitForTimeout(250)
      for (const p of await inspect(page)) problems.push(`${label}: ${p}`)
      await page.screenshot({ path: join(out, `${shotPrefix}takeoff-menu-${String(i).padStart(2, '0')}.png`) })
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
      if ((await b.getAttribute('aria-expanded')) === 'true') {
        problems.push(`${label}: Escape did not close its menu`)
        await b.click({ force: true }).catch(() => {})
      }
    }
    return problems
  }],
  /*
   * The X with a save that does not answer: it used to do nothing, with
   * nothing on screen (0.3.63). Now it asks within seconds, and once the save
   * lands the window goes, by destroy rather than another close request.
   */
  ['slow-close', async (page) => {
    const problems = []
    await page.keyboard.press('Escape')
    await page.evaluate(() => { window.__sweepHoldSaves = true })
    // A change to save: the area just drawn, undone.
    await page.locator('.viewport').click({ position: { x: 40, y: 40 } })
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(150)
    await page.locator('.wincontrols .wcbtn.close').click()
    const ask = page.getByRole('dialog', { name: 'Still saving the takeoff into the PDF' })
    try { await ask.waitFor({ timeout: 20000 }) } catch { problems.push('slow-close: the X showed nothing while the save hung') }
    problems.push(...await inspect(page))
    await page.screenshot({ path: join(out, `${shotPrefix}slow-close-ask.png`) })
    await button(page, 'Keep working').click().catch(() => problems.push('slow-close: no Keep working'))
    await page.waitForTimeout(200)
    if (await ask.count() > 0) problems.push('slow-close: Keep working left the ask up')
    await page.evaluate(() => { window.__sweepHoldSaves = false; for (const go of window.__sweepHeld ?? []) go(); window.__sweepHeld = [] })
    await page.waitForTimeout(500)
    const before = await page.evaluate(() => window.__sweepCalls.length)
    await page.locator('.wincontrols .wcbtn.close').click()
    await page.waitForTimeout(1500)
    const asked = await page.evaluate((n) => window.__sweepCalls.slice(n), before)
    if (!asked.includes('plugin:window|destroy')) problems.push(`slow-close: a second X after the save landed did not close (${asked.filter((c) => c.startsWith('plugin:window')).join(', ') || 'no window call'})`)
    await page.keyboard.press('Control+y')
    await page.waitForTimeout(300)
    return problems
  }],
  ['second-tab', async (page) => {
    await page.keyboard.press('Escape')
    await button(page, 'Open another document').click()
    await page.waitForTimeout(3000)
  }],
  ['tab-menu', async (page) => opensAndEscapes(
    page,
    () => page.locator('[data-tab][role="tab"]').first().click({ button: 'right' }),
    '.tabctx', 'the tab menu',
  )],
  ['narrow', async (page) => {
    await page.setViewportSize({ width: 1024, height: 700 })
    await page.waitForTimeout(600)
  }],
  ['narrow-menus', async (page) => {
    const problems = []
    for (const b of await page.locator('.dock button[aria-haspopup]').all()) {
      if (!(await b.isVisible()) || !(await b.isEnabled())) continue
      const label = (await b.getAttribute('aria-label')) ?? ''
      await b.click()
      await page.waitForTimeout(250)
      for (const p of await inspect(page)) problems.push(`${label}: ${p}`)
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
    }
    await page.setViewportSize({ width: 1280, height: 800 })
    return problems
  }],
  ['broken-file', async (page) => {
    await page.goto(view('C:\\Jobs\\Sweep\\Broken.pdf'))
    await page.waitForTimeout(3000)
  }],
  /*
   * AI agents beside the person (Aaron, 2026-11-24: "MULTIPLE agents ...
   * ALONGSIDE a human ... agent actions should NEVER steal focus"). Three
   * agents call at once through the mock's bridge while the sweep is the
   * person. Each step holds the promise as well as the look: the tab showing,
   * the sheet showing and the keyboard are the person's throughout.
   */
  ['agents', async (page) => {
    // A window as first opened: earlier steps left the sidebar folded on another panel, and it remembers.
    await page.evaluate(() => localStorage.clear())
    await page.goto(view(FILE))
    await shown(page).locator('.sheetrow').first().waitFor({ timeout: 20000 })
    await page.waitForTimeout(1200)
    const problems = []
    const before = await person(page)
    const opened = await Promise.all(AGENTS.map((a, i) => agentCall(page, a, 'open_file', { path: AGENT_FILES[i], wait: true })))
    for (const [i, o] of opened.entries()) {
      if (o.opened !== true || o.yours !== true) problems.push(`agents: ${AGENTS[i].client} could not open its own PDF: ${JSON.stringify(o).slice(0, 160)}`)
    }
    const moved = await Promise.all([
      agentAct(page, AGENTS[0], 'go_to_page', { page: 4 }),
      agentAct(page, AGENTS[1], 'go_to_page', { page: 6 }),
      agentAct(page, AGENTS[2], 'zoom_to_region', { page: 2, rect: { x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.5 } }),
      agentCall(page, AGENTS[0], 'screenshot', {}),
    ])
    if (moved[0].page !== 4 || moved[1].page !== 6) problems.push(`agents: each agent's page turn should land in its own PDF: ${JSON.stringify(moved.slice(0, 2)).slice(0, 200)}`)
    if (!/Tower A/.test(String(moved[0].file)) || !/Tower B/.test(String(moved[1].file))) problems.push('agents: a call went to the wrong PDF')
    if (typeof moved[3].dataUrl !== 'string') problems.push('agents: no picture of a PDF open in the background')
    await page.waitForTimeout(400)
    const after = await person(page)
    if (JSON.stringify(after) !== JSON.stringify(before)) problems.push(`agents: the person's view moved: ${JSON.stringify(before)} became ${JSON.stringify(after)}`)
    const seen = await page.evaluate(() => {
      const ws = document.querySelector('.wshost[data-showing="true"]')
      const tab = ws.querySelector('[data-tab][role="tab"]')?.getBoundingClientRect()
      const sum = ws.querySelector('.agentsummary')
      const r = sum?.getBoundingClientRect()
      return {
        summary: sum?.querySelector('.agentsummary-text')?.textContent ?? null,
        clipped: sum !== null && sum !== undefined && sum.scrollWidth > sum.clientWidth + 1,
        dots: [...ws.querySelectorAll('.agentsummary .agentdot')].map((d) => d.style.getPropertyValue('--agent-bright')),
        over: r !== undefined && tab !== undefined && r.left < tab.right - 1,
        tab: tab?.width ?? 0,
        flyouts: document.querySelectorAll('.agentflyout, [role="dialog"]').length,
        pane: ws.querySelectorAll('.agentspane').length,
        offered: ws.querySelector('.contentsview [data-view="agents"]')?.textContent ?? null,
        behind: document.querySelectorAll('.wshost[data-showing="false"]').length,
        inert: document.querySelectorAll('.wshost[data-showing="false"][inert]').length,
        tabs: [...ws.querySelectorAll('[data-tab][role="tab"] .tabname')].map((n) => n.textContent),
      }
    })
    if (seen.summary !== '3 AI sessions') problems.push(`agents: the title bar should say "3 AI sessions", says ${seen.summary ?? 'nothing'}`)
    if (seen.clipped) problems.push('agents: the title bar\'s summary of the sessions is cut off')
    if (new Set(seen.dots).size !== 3) problems.push('agents: the three sessions do not have three colours')
    if (seen.flyouts !== 0) problems.push('agents: something opened over the person\'s work when agents arrived')
    if (seen.pane !== 0) problems.push('agents: the left pane changed to the Agents list by itself when agents arrived')
    if (seen.offered !== 'Agents3') problems.push(`agents: Contents should offer an Agents view counting 3, offers ${seen.offered ?? 'none'}`)
    if (seen.over) problems.push('agents: the sessions\' summary sits over the person\'s tab')
    if (seen.tab < 100) problems.push(`agents: the person's tab is squeezed to ${Math.round(seen.tab)} px`)
    if (seen.behind !== 3 || seen.inert !== 3) problems.push(`agents: ${seen.behind} PDFs live behind the one showing, ${seen.inert} of them inert (want 3 and 3)`)
    if (seen.tabs.join() !== 'Sweep set') problems.push(`agents: the person's strip should hold only their tab, holds ${seen.tabs.join()}`)
    // The list itself: every session by its whole name, none cut off, with its PDF.
    await shown(page).locator('.agentsummary').click()
    await page.waitForTimeout(250)
    const list = await page.evaluate(() => [...document.querySelectorAll('.wshost[data-showing="true"] .agentcard')].map((c) => {
      const n = c.querySelector('.agentcard-name')
      return { name: n?.textContent, cut: n !== null && (n.scrollWidth > n.clientWidth + 1 || getComputedStyle(n).textOverflow === 'ellipsis'), files: [...c.querySelectorAll('.agentfile-name')].map((f) => f.textContent).join() }
    }))
    const want = 'Claude · Nokia Canada North Campus takeoff:Tower A|Claude · Level 2 ceilings:Tower B|ChatGPT · Clinic framing:Clinic'
    const got = list.map((c) => `${c.name}:${c.files}`).join('|')
    if (got !== want) problems.push(`agents: the Agents list should name each session with its PDF (${want}), lists ${got || 'nothing'}`)
    if (list.some((c) => c.cut)) problems.push('agents: a session\'s name is cut off in the Agents list')
    problems.push(...await inspect(page))
    await page.screenshot({ path: join(out, `${shotPrefix}agents-list.png`) })
    // Back to the sheets: the list is one click away, not in the way.
    await shown(page).locator('.contentsview').getByRole('tab', { name: 'Sheets' }).click()
    await page.waitForTimeout(150)
    return problems
  }],
  ['agents-typing', async (page) => {
    // The person types a sheet number while three agents act, one of them opening a panel.
    const problems = []
    const input = shown(page).getByPlaceholder('Find a sheet')
    await input.click()
    await page.keyboard.type('A6')
    const acting = Promise.all([
      agentAct(page, AGENTS[0], 'open_panel', { panel: 'search' }),
      agentAct(page, AGENTS[1], 'set_tool', { tool: 'select' }),
      agentAct(page, AGENTS[2], 'go_to_page', { page: 8 }),
      agentAct(page, AGENTS[0], 'create_scope', { label: 'ACT-1', scopeType: 'area' }),
    ])
    await page.keyboard.type('.0', { delay: 70 })
    await acting
    await page.keyboard.type('1', { delay: 70 })
    await page.waitForTimeout(450)
    const typed = await input.inputValue()
    if (typed !== 'A6.01') problems.push(`agents-typing: typed "A6.01" while agents worked, the field holds "${typed}"`)
    const focused = await page.evaluate(() => document.activeElement?.getAttribute('placeholder'))
    if (focused !== 'Find a sheet') problems.push(`agents-typing: the keyboard left the field the person was typing in (now ${focused ?? 'nowhere'})`)
    problems.push(...await inspect(page))
    await input.fill('')
    await page.keyboard.press('Escape')
    return problems
  }],
  ['agent-ask', async (page) => {
    // An agent wants to turn the pages of the person's own PDF: they are asked, and nothing moves.
    const problems = []
    const before = await person(page)
    const going = agentAct(page, AGENTS[1], 'go_to_page', { page: 5, file: FILE })
    // The question is counted in the title bar and asked in the Agents list, never over the sheet the person is working on.
    const needing = shown(page).locator('.agentsummary[data-needing="true"]')
    try { await needing.waitFor({ timeout: 4000 }) } catch { problems.push('agent-ask: the title bar does not say a session is waiting when one asked to work in the person\'s PDF') }
    const said = await needing.locator('.agentsummary-text').textContent().catch(() => null)
    if (said !== '3 AI sessions · 1 waiting for you') problems.push(`agent-ask: the title bar should say "3 AI sessions · 1 waiting for you", says ${said ?? 'nothing'}`)
    if (await shown(page).locator('.agentbar .agentinfobar').count() > 0) problems.push('agent-ask: a question was put over the sheet the person is working on')
    if (await page.locator('.agentflyout, [role="dialog"]').count() > 0) problems.push('agent-ask: a question opened something over the person\'s work')
    problems.push(...await inspect(page))
    await page.screenshot({ path: join(out, `${shotPrefix}agent-ask-question.png`) })
    if (JSON.stringify(await person(page)) !== JSON.stringify(before)) problems.push('agent-ask: the person\'s sheet moved before they answered')
    await needing.click().catch(() => {})
    const ask = shown(page).locator('.agentcard[data-asking="true"] .agentcard-ask')
    if (await ask.getByRole('button', { name: 'Let it work there' }).count() !== 1) problems.push('agent-ask: the Agents list has no way to say yes')
    problems.push(...await inspect(page))
    await page.screenshot({ path: join(out, `${shotPrefix}agent-ask-menu.png`) })
    await ask.getByRole('button', { name: 'Not now' }).click().catch(() => problems.push('agent-ask: no Not now'))
    const told = await going
    if (told.handover !== 'refused') problems.push(`agent-ask: the agent was not told the person said not now: ${JSON.stringify(told).slice(0, 160)}`)
    await page.waitForTimeout(200)
    if (await shown(page).locator('.agentcard[data-asking="true"], .agentsummary[data-needing="true"]').count() > 0) problems.push('agent-ask: the question stayed up after Not now')
    await shown(page).locator('.contentsview').getByRole('tab', { name: 'Sheets' }).click()
    await page.waitForTimeout(150)
    // Reading the person's PDF, and drawing on the sheet they are on, needs no asking.
    const settled = await person(page)
    const read = await agentAct(page, AGENTS[1], 'find_text', { query: 'CEILING', file: FILE })
    if (!Array.isArray(read.matches)) problems.push(`agent-ask: an agent could not read the person's PDF: ${JSON.stringify(read).slice(0, 160)}`)
    if (JSON.stringify(await person(page)) !== JSON.stringify(settled)) problems.push(`agent-ask: reading the person's PDF moved their view: ${JSON.stringify(settled)} became ${JSON.stringify(await person(page))}`)
    return problems
  }],
  ['agent-watch', async (page) => {
    // The person looks in on a session: its card lists its PDFs by name, one click shows the PDF as a full tab of theirs, its cursor says what it is doing.
    const problems = []
    await shown(page).locator('.agentsummary').click()
    await page.waitForTimeout(250)
    const card = shown(page).locator('.agentcard').first()
    const head = await card.locator('.agentcard-head').textContent().catch(() => null)
    if (head === null || !/Claude · Nokia Canada North Campus takeoff/.test(head)) problems.push(`agent-watch: the session's card should carry its whole name, reads "${head}"`)
    if (await card.getByRole('button', { name: 'End this session' }).count() !== 1) problems.push('agent-watch: the session\'s card has no End this session')
    // Folding a card away and back.
    await card.locator('.agentcard-head').click()
    await page.waitForTimeout(150)
    if (await card.locator('.agentfile').count() > 0) problems.push('agent-watch: clicking a session\'s name did not fold its PDFs away')
    await card.locator('.agentcard-head').click()
    await page.waitForTimeout(150)
    await card.locator('.agentfile').first().click()
    await page.waitForTimeout(1200)
    const showing = await page.evaluate(() => {
      const ws = document.querySelector('.wshost[data-showing="true"]')
      const t = ws?.querySelector('[data-tab][role="tab"].active')
      const n = t?.querySelector('.tabname')
      return {
        tab: n?.textContent ?? null, cut: n !== null && n !== undefined && n.scrollWidth > n.clientWidth + 1, mark: t?.querySelector('.tabmark')?.getAttribute('title') ?? null,
        list: ws?.querySelectorAll('.agentspane').length, row: ws?.querySelector('.agentfile.active .agentfile-name')?.textContent ?? null,
      }
    })
    if (showing.tab !== 'Tower A') problems.push(`agent-watch: picking a session's PDF should show it as the active tab, showing ${showing.tab ?? 'none'}`)
    if (showing.cut) problems.push('agent-watch: the active tab\'s name is cut off')
    if (!/Claude · Nokia Canada North Campus takeoff is operating this PDF/.test(showing.mark ?? '')) problems.push(`agent-watch: the tab of a session's PDF should carry the session's dot, carries ${showing.mark ?? 'none'}`)
    if (showing.list !== 1 || showing.row !== 'Tower A') problems.push('agent-watch: the Agents list should stay up, with the PDF being looked at marked, after picking a PDF from it')
    if (await page.locator('.agentflyout, [role="dialog"]').count() > 0) problems.push('agent-watch: looking in on a session opened something over the sheet')
    await agentAct(page, AGENTS[0], 'find_text', { query: 'CL-105' })
    await page.waitForTimeout(300)
    const searching = await page.evaluate(() => document.querySelector('.wshost[data-showing="true"] .agentcursor-doing')?.textContent)
    if (searching !== 'Searching for “CL-105”') problems.push(`agent-watch: the cursor's label should say what the session is doing now, reads "${searching ?? 'nothing'}"`)
    const made = await agentAct(page, AGENTS[0], 'create_markup', {
      kind: 'area', scope: 'ACT-1', rings: [[{ x: 0.2, y: 0.25 }, { x: 0.55, y: 0.25 }, { x: 0.55, y: 0.6 }, { x: 0.2, y: 0.6 }]],
    })
    await page.waitForTimeout(700)
    const cursor = await page.evaluate(() => {
      const c = document.querySelector('.wshost[data-showing="true"] .agentcursor')
      return c === null ? null : { mode: c.dataset.mode, text: c.textContent, colour: c.style.getPropertyValue('--agent') }
    })
    if (cursor === null) problems.push(`agent-watch: no cursor on the sheet after the agent drew (${JSON.stringify(made).slice(0, 140)})`)
    else {
      if (!/Claude · Nokia Canada North Campus takeoff/.test(cursor.text ?? '')) problems.push(`agent-watch: the cursor's label should name the session, reads "${cursor.text}"`)
      if (typeof made.error !== 'string' && cursor.mode !== 'on') problems.push(`agent-watch: the cursor should sit on the point drawn, is ${cursor.mode}`)
    }
    if (await shown(page).locator('.agentbar', { hasText: 'is operating this PDF' }).count() === 0) problems.push('agent-watch: nothing on the sheet says an agent drives this tab')
    const hit = await page.evaluate(() => {
      const c = document.querySelector('.wshost[data-showing="true"] .agentcursor-label')
      if (c === null) return null
      const r = c.getBoundingClientRect()
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('.agentcursors') !== null
    })
    if (hit === true) problems.push('agent-watch: the cursor label takes the pointer')
    problems.push(...await inspect(page))
    await page.screenshot({ path: join(out, `${shotPrefix}agent-in-its-tab.png`) })
    return problems
  }],
  ['agent-together', async (page) => {
    /*
     * Aaron, 2026-11-24: "I can be doing a manual takeoff while the agent
     * searches for references to a scope and highlights them for me. This
     * must work." The person is in their own PDF; a session marks it up as a
     * guest. Their tab gets its dot, nothing of theirs moves, and Ctrl+Z
     * does not take back the session's work.
     */
    const problems = []
    await shown(page).locator('[data-tab][role="tab"]').first().click()
    await page.waitForTimeout(900)
    await shown(page).locator('.contentsview').getByRole('tab', { name: 'Sheets' }).click()
    await page.waitForTimeout(150)
    // The sheet list says "no scale" beside a sheet once it has takeoff on it: that is the list telling the truth, not the view moving.
    const where = async () => { const p = await person(page); return JSON.stringify({ ...p, sheet: String(p.sheet).replace('no scale', '') }) }
    const before = await where()
    const scope = await agentAct(page, AGENTS[2], 'create_scope', { label: 'CL-105 references', scopeType: 'area', file: FILE })
    if (typeof scope.scopeId !== 'string') problems.push(`agent-together: a guest session could not add a scope: ${JSON.stringify(scope).slice(0, 160)}`)
    for (const [x, y] of [[0.22, 0.3], [0.5, 0.52]]) {
      const made = await agentAct(page, AGENTS[2], 'create_markup', { kind: 'area', scopeId: scope.scopeId, file: FILE, rings: [[{ x, y }, { x: x + 0.09, y }, { x: x + 0.09, y: y + 0.07 }, { x, y: y + 0.07 }]] })
      if (typeof made.error === 'string') problems.push(`agent-together: a guest session could not draw on the sheet showing: ${made.error.slice(0, 140)}`)
    }
    await page.waitForTimeout(500)
    if (await where() !== before) problems.push(`agent-together: the person's view moved while a session drew in their PDF: ${before} became ${await where()}`)
    // One dot per session in the PDF: this one, and the one that read it a step ago.
    const marks = await shown(page).locator('[data-tab][role="tab"] .tabmark').evaluateAll((els) => els.map((e) => e.getAttribute('title')))
    if (!marks.some((m) => /ChatGPT · Clinic framing is also working in this PDF · Drawing an area/.test(m ?? ''))) problems.push(`agent-together: the person's tab should carry a dot naming the guest session and what it is doing, carries ${JSON.stringify(marks)}`)
    const count = async () => { const l = await agentAct(page, AGENTS[2], 'list_markups', { file: FILE }); return Array.isArray(l.markups) ? l.markups.length : -1 }
    const had = await count()
    await shown(page).locator('.stage, canvas').first().click({ position: { x: 5, y: 5 } }).catch(() => {})
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(500)
    const kept = await count()
    if (kept !== had) problems.push(`agent-together: the person's Ctrl+Z took back a session's work (${had} markups became ${kept})`)
    const undone = await agentAct(page, AGENTS[2], 'undo', { file: FILE })
    await page.waitForTimeout(300)
    if (typeof undone.undid !== 'string' || await count() !== had - 1) problems.push(`agent-together: a guest session could not undo its own last markup: ${JSON.stringify(undone).slice(0, 160)}`)
    if (await where() !== before) problems.push('agent-together: a session\'s undo moved the person\'s view')
    problems.push(...await inspect(page))
    await page.screenshot({ path: join(out, `${shotPrefix}agent-together.png`) })
    return problems
  }],
  ['agent-finish', async (page) => {
    // A session waits at a gate, then finishes: what it wrote goes to the person's strip, what it only read closes, and nothing is left to referee.
    const problems = []
    const before = await person(page)
    await agentAct(page, AGENTS[0], 'wait_for_person', { for: 'approve the scope definition' })
    await page.waitForTimeout(250)
    const waiting = await shown(page).locator('.agentsummary-text').textContent().catch(() => null)
    if (waiting !== '3 AI sessions · 1 waiting for you') problems.push(`agent-finish: the title bar should say a session is waiting, says ${waiting ?? 'nothing'}`)
    await shown(page).locator('.agentsummary').click()
    await page.waitForTimeout(250)
    const why = await shown(page).locator('.agentcard[data-state="waiting"] .agentcard-status').allTextContents()
    if (why.join() !== 'Waiting for you: approve the scope definition') problems.push(`agent-finish: a waiting session's card should say what it waits for, says ${why.join() || 'nothing'}`)
    problems.push(...await inspect(page))
    await page.screenshot({ path: join(out, `${shotPrefix}agent-waiting.png`) })
    const ended = await agentAct(page, AGENTS[0], 'end_session', { summary: 'Takeoff saved in Tower A: 1 scope, 1 area.' })
    if (JSON.stringify(ended.handedBack) !== JSON.stringify([AGENT_FILES[0]])) problems.push(`agent-finish: the PDF the session wrote in should be handed back: ${JSON.stringify(ended).slice(0, 200)}`)
    await shown(page).locator('.contentsview').getByRole('tab', { name: 'Sheets' }).click()
    await agentCall(page, AGENTS[1], 'agent_bye', {})
    await page.waitForTimeout(900)
    const strip = await page.evaluate(() => ({
      mine: [...document.querySelectorAll('.wshost[data-showing="true"] [data-tab][role="tab"]')].map((t) => `${t.querySelector('.tabname')?.textContent}${t.querySelector('.tabmark') ? '*' : ''}`),
      summary: document.querySelector('.wshost[data-showing="true"] .agentsummary-text')?.textContent ?? null,
      cursors: [...document.querySelectorAll('.wshost[data-showing="true"] .agentcursor')].map((c) => c.dataset.agent),
      asks: document.querySelectorAll('.agentinfobar[role="alert"], .agentflyout, [role="dialog"]').length,
    }))
    if (strip.mine.join('|') !== 'Sweep set*|Tower A*') problems.push(`agent-finish: the person's strip should hold their PDF and the one handed back, each with its dot: ${strip.mine.join('|')}`)
    if (strip.summary !== '1 AI session') problems.push(`agent-finish: the title bar should count the one session still at work, says ${strip.summary ?? 'nothing'}`)
    if (strip.cursors.some((c) => /Nokia|Level 2/.test(c ?? ''))) problems.push('agent-finish: a finished session still has a cursor on the sheet')
    if (strip.asks !== 0) problems.push('agent-finish: a session finishing put something in front of the person')
    if (JSON.stringify(await person(page)) !== JSON.stringify(before)) problems.push('agent-finish: the person\'s view moved when sessions finished')
    await shown(page).locator('.agentsummary').click()
    await page.waitForTimeout(250)
    if (await shown(page).locator('.agentcard:not(.finished)').count() !== 1 || await shown(page).locator('.agentcard.finished').count() !== 2) problems.push('agent-finish: the Agents list should hold one session at work and two finished')
    const list = (await shown(page).locator('.agentcard.finished').allTextContents()).join(' ')
    for (const want of ['Takeoff saved in Tower A: 1 scope, 1 area.', 'Now in your tabs', 'Only read, so closed', 'Tower B', 'its app closed']) {
      if (!String(list).includes(want)) problems.push(`agent-finish: the Finished list should say "${want}"`)
    }
    problems.push(...await inspect(page))
    await page.screenshot({ path: join(out, `${shotPrefix}agent-finished.png`) })
    return problems
  }],
  ['agents-start', async (page) => {
    // The person closes their own PDFs. The session still at work carries on, listed on the start page.
    const problems = []
    for (let i = 0; i < 2; i++) {
      await shown(page).locator('[data-tab][role="tab"]:not(.tucked) .tabclose').first().click({ force: true })
      await page.waitForTimeout(1300)
    }
    const card = page.locator('.agentsonstart')
    if (await card.count() === 0) problems.push('agents-start: the start page does not list the session still at work')
    else if (await card.locator('.agentsonstart-open').count() !== 1) problems.push('agents-start: the card should list the one PDF a session still has open')
    const still = await agentAct(page, AGENTS[2], 'list_markups', {})
    if (typeof still.error === 'string') problems.push(`agents-start: an agent's PDF stopped answering once the person had no tab: ${still.error.slice(0, 120)}`)
    const closed = await agentAct(page, AGENTS[2], 'close_tab', {})
    if (closed.closed === undefined) problems.push(`agents-start: an agent could not close its own tab: ${JSON.stringify(closed).slice(0, 140)}`)
    await page.waitForTimeout(400)
    return problems
  }],
]

// ---------------------------------------------------------------- run --

let shotPrefix = ''

async function serve() {
  const vite = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort'], {
    cwd: desktop, stdio: ['ignore', 'pipe', 'pipe'],
  })
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('vite did not start in 60 s')), 60000)
    vite.stdout.on('data', (d) => { if (String(d).includes('ready')) { clearTimeout(t); res() } })
    vite.on('exit', (code) => rej(new Error(`vite exited ${code}`)))
  })
  return vite
}

async function pass(browser, theme, backdrop) {
  // The theme setting defaults to Match Windows, which follows prefers-color-scheme.
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: theme })
  // A control that is there clicks at once; waiting 30 s for one that is not only hides the failure.
  page.setDefaultTimeout(5000)
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e).split('\n')[0]))
  await page.addInitScript({ path: join(here, 'tauri-mock.js') })
  if (backdrop) {
    await page.addInitScript((mica) => {
      window.__sweepBackdrop = true
      // What DWM draws behind the transparent chrome.
      document.addEventListener('DOMContentLoaded', () => {
        const s = document.createElement('style')
        s.textContent = `html { background: ${mica} !important }`
        document.head.append(s)
      })
    }, MICA[theme])
  }
  await page.route('**/__sweep.pdf', (r) => r.fulfill({ body: PDF, contentType: 'application/pdf' }))
  shotPrefix = `${theme}-${backdrop ? 'mica-' : ''}`
  const failures = []
  for (const [name, step] of STEPS) {
    if (only !== null && !only.split(',').includes(name) && !['viewer', 'start'].includes(name)) continue
    const before = errors.length
    let own = []
    try {
      own = (await step(page)) ?? []
    } catch (e) {
      own = [`step failed: ${String(e.message ?? e).split('\n').slice(0, 3).join(' / ')}`]
    }
    await page.waitForTimeout(200)
    await page.screenshot({ path: join(out, `${shotPrefix}${name}.png`) })
    const after = name.endsWith('menus') || name === 'every-menu' ? [] : await inspect(page)
    const all = [...own, ...after, ...errors.slice(before).map((e) => `uncaught: ${e}`)]
    // Whatever a failed step left open must not fail every step after it.
    if (all.length > 0) {
      for (const scrim of await page.locator('.menuscrim').all()) await scrim.click({ force: true }).catch(() => {})
      await page.keyboard.press('Escape')
      // A menu Escape could not close: a click outside closes every one of them.
      await page.mouse.click(page.viewportSize().width / 2, 60).catch(() => {})
    }
    console.log(`${all.length === 0 ? 'ok  ' : 'FAIL'} ${shotPrefix}${name}`)
    for (const p of [...new Set(all)]) console.log(`       ${p}`)
    failures.push(...all.map((p) => `${shotPrefix}${name}: ${p}`))
    if (all.length > 0 && !keepGoing && name === 'viewer') break
  }
  await page.close()
  return failures
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const vite = await serve()
let failures = []
try {
  const browser = await chromium.launch()
  for (const theme of ['dark', 'light']) {
    for (const backdrop of [false, true]) failures.push(...await pass(browser, theme, backdrop))
  }
  await browser.close()
} finally {
  vite.kill()
}
const unique = [...new Set(failures)]
writeFileSync(join(out, 'report.txt'), unique.length === 0 ? 'clean\n' : `${unique.join('\n')}\n`)
console.log(unique.length === 0
  ? `\nUI sweep clean. Screenshots: ${out}`
  : `\nUI sweep: ${unique.length} problem(s). Screenshots: ${out}`)
process.exit(unique.length === 0 ? 0 : 1)
