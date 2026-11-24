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

// AI agents: three of them, as three apps' MCP servers would name themselves.
const AGENTS = [{ id: 'sweep-1', client: 'claude-ai' }, { id: 'sweep-2', client: 'claude-code' }, { id: 'sweep-3', client: 'chatgpt' }]
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
    try { await ask.waitFor({ timeout: 8000 }) } catch { problems.push('slow-close: the X showed nothing while the save hung') }
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
    const seen = await page.evaluate(() => ({
      chips: [...document.querySelectorAll('.wshost[data-showing="true"] .agentgroup .agentname')].map((n) => n.textContent),
      colours: [...document.querySelectorAll('.wshost[data-showing="true"] .agentgroup')].map((g) => g.style.getPropertyValue('--agent')),
      behind: document.querySelectorAll('.wshost[data-showing="false"]').length,
      inert: document.querySelectorAll('.wshost[data-showing="false"][inert]').length,
      tabs: [...document.querySelectorAll('.wshost[data-showing="true"] [data-tab][role="tab"] .tabname')].map((n) => n.textContent),
    }))
    if (seen.chips.join() !== 'Claude,Claude Code,ChatGPT') problems.push(`agents: expected a chip each for Claude, Claude Code and ChatGPT, saw ${seen.chips.join() || 'none'}`)
    if (new Set(seen.colours).size !== 3) problems.push('agents: the three agents do not have three colours')
    if (seen.behind !== 3 || seen.inert !== 3) problems.push(`agents: ${seen.behind} PDFs live behind the one showing, ${seen.inert} of them inert (want 3 and 3)`)
    if (seen.tabs.join() !== 'Sweep set') problems.push(`agents: the person's strip should hold only their tab, holds ${seen.tabs.join()}`)
    return problems
  }],
  ['agents-typing', async (page) => {
    // The person types a sheet number while three agents act, one of them opening a panel.
    const problems = []
    // Earlier steps left the sidebar on another panel; the window remembers it.
    await button(page, 'Contents').click()
    await page.getByRole('tab', { name: 'Sheets', exact: true }).click()
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
    const bar = shown(page).locator('.agentbar')
    try { await bar.getByRole('button', { name: 'Let it work here' }).waitFor({ timeout: 4000 }) } catch { problems.push('agent-ask: no question on the sheet when an agent asked to work in the person\'s PDF') }
    problems.push(...await inspect(page))
    await page.screenshot({ path: join(out, `${shotPrefix}agent-ask-question.png`) })
    if (JSON.stringify(await person(page)) !== JSON.stringify(before)) problems.push('agent-ask: the person\'s sheet moved before they answered')
    await bar.getByRole('button', { name: 'Not now' }).click().catch(() => problems.push('agent-ask: no Not now'))
    const told = await going
    if (told.handover !== 'refused') problems.push(`agent-ask: the agent was not told the person said not now: ${JSON.stringify(told).slice(0, 160)}`)
    await page.waitForTimeout(200)
    if (await bar.count() > 0) problems.push('agent-ask: the question stayed up after Not now')
    // Reading the person's PDF, and drawing on the sheet they are on, needs no asking.
    const settled = await person(page)
    const read = await agentAct(page, AGENTS[1], 'find_text', { query: 'CEILING', file: FILE })
    if (!Array.isArray(read.matches)) problems.push(`agent-ask: an agent could not read the person's PDF: ${JSON.stringify(read).slice(0, 160)}`)
    if (JSON.stringify(await person(page)) !== JSON.stringify(settled)) problems.push(`agent-ask: reading the person's PDF moved their view: ${JSON.stringify(settled)} became ${JSON.stringify(await person(page))}`)
    return problems
  }],
  ['agent-watch', async (page) => {
    // The person looks in on an agent: its tabs unfold, its PDF shows, its cursor says what it is doing.
    const problems = []
    await shown(page).locator('.agentchip').first().click()
    await page.waitForTimeout(250)
    await shown(page).locator('.agenttab').first().click()
    await page.waitForTimeout(1200)
    const showing = await page.evaluate(() => document.querySelector('.wshost[data-showing="true"] .agenttab.active .tabname')?.textContent)
    if (showing !== 'Tower A') problems.push(`agent-watch: clicking Claude's tab should show Tower A, shows ${showing ?? 'nothing'}`)
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
      if (!/^Claude/.test(cursor.text ?? '')) problems.push(`agent-watch: the cursor's label should start with the agent's name, reads "${cursor.text}"`)
      if (typeof made.error !== 'string' && cursor.mode !== 'on') problems.push(`agent-watch: the cursor should sit on the point drawn, is ${cursor.mode}`)
    }
    if (await shown(page).locator('.agentbar', { hasText: 'is working in this PDF' }).count() === 0) problems.push('agent-watch: nothing on the sheet says an agent drives this tab')
    const hit = await page.evaluate(() => {
      const c = document.querySelector('.wshost[data-showing="true"] .agentcursor-label')
      if (c === null) return null
      const r = c.getBoundingClientRect()
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('.agentcursors') !== null
    })
    if (hit === true) problems.push('agent-watch: the cursor label takes the pointer')
    return problems
  }],
  ['agents-start', async (page) => {
    // One agent finishes; the person goes back to their own PDF and closes it. The agents keep working.
    const problems = []
    await agentCall(page, AGENTS[1], 'agent_bye', {})
    await shown(page).locator('[data-tab][role="tab"]').first().click()
    await page.waitForTimeout(900)
    await shown(page).locator('[data-tab][role="tab"] .tabclose').first().click({ force: true })
    await page.waitForTimeout(1500)
    const card = page.locator('.agentsonstart')
    if (await card.count() === 0) problems.push('agents-start: the start page does not list the agents still at work')
    else if (await card.locator('.agentsonstart-open').count() !== 3) problems.push('agents-start: the card should list the three PDFs agents have open')
    const still = await agentAct(page, AGENTS[0], 'list_markups', {})
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
      own = [`step failed: ${String(e.message ?? e).split('\n')[0]}`]
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
