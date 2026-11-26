/*
 * Just enough of Tauri for the real app to run in Chromium (ui-sweep.mjs).
 *
 * Every PDF the app asks for is the sweep fixture, served by the sweep at
 * /__sweep.pdf; a path containing "Broken" reads three bytes, so the failed
 * open can be looked at too. Anything not listed answers null, which is what
 * a desktop command with nothing to say returns. `window.__sweepCalls` keeps
 * the commands asked for, for debugging a step.
 *
 * AI agents: `window.__sweepAgent(agent, action, params)` sends the window a
 * bridge request the way the app's own bridge does (bridge/ui.rs) and
 * resolves with what the window answers, so a step can be several agents
 * calling at once with nobody at the keyboard.
 */
(() => {
  const calls = (window.__sweepCalls = [])
  let next = 0
  const pick = (path) => ({ supported: true, path, project: null, relativePath: path.split('\\').pop(), reason: null })
  /** What each file holds now: saves land here, and the next read sees them. */
  const files = new Map()
  const fingerprint = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((b) => b.toString(16).padStart(2, '0')).join('')
  /** Event name to the callbacks listening for it, as Tauri's event plugin keeps them. */
  const listeners = new Map()
  const waiting = new Map()
  let request = 0
  const send = (id, action, params, agent) => {
    for (const handler of listeners.get('redbeam://bridge/request') ?? []) {
      window[`_${handler}`]?.({ event: 'redbeam://bridge/request', id: handler, payload: { id, action, params, agent } })
    }
  }
  /** Each AI app's server says it is still there every five seconds, as the real ones do (apps/mcp, mcp.rs). */
  const servers = new Set()
  setInterval(() => { for (const server of servers) send(++request, 'agent_alive', { server }, null) }, 5000)
  window.__sweepAgent = (agent, action, params = {}, withinMs = 25000) => new Promise((resolve) => {
    const id = ++request
    const cut = typeof agent?.id === 'string' ? agent.id.lastIndexOf('/') : -1
    if (cut > 0) servers.add(agent.id.slice(0, cut))
    waiting.set(id, resolve)
    setTimeout(() => { if (waiting.delete(id)) resolve({ error: `sweep: no answer to ${action} in ${withinMs} ms` }) }, withinMs)
    send(id, action, params, agent)
  })
  const handlers = {
    bridge_reply: (a) => { const go = waiting.get(a.id); waiting.delete(a.id); go?.(a.result); return null },
    project_locate_file: (a) => pick(a.path),
    project_pick_drawing: () => pick('C:\\Jobs\\Sweep\\Second set.pdf'),
    project_pick_file: () => pick('C:\\Jobs\\Sweep\\Second set.pdf'),
    project_read_document: async (a) => {
      const key = String(a.relativePath ?? '')
      if (key.includes('Broken')) return new Uint8Array([1, 2, 3])
      // A path containing "Held" is a sheet marked up in Bluebeam (fixtures/ui/held.pdf).
      if (!files.has(key)) files.set(key, new Uint8Array(await (await fetch(key.includes('Held') ? '/__held.pdf' : '/__sweep.pdf')).arrayBuffer()))
      // A copy: the app hands what it reads to the PDF worker, which detaches it.
      return files.get(key).slice()
    },
    project_recents: () => [],
    project_old_data: () => null,
    launch_take_file: () => null,
    launch_showing: () => null,
    pdf_handler_status: () => ({ registered: true, isDefault: true }),
    system_accent: () => null,
    // The sweep sets this to look at the app over Windows 11's Mica.
    backdrop_active: () => window.__sweepBackdrop === true,
    crash_reports: () => [],
    ai_apps_status: () => ({ enabled: false, claude: false, chatgpt: false }),
  }
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
    transformCallback(fn) { const id = ++next; window[`_${id}`] = fn; return id },
    unregisterCallback(id) { delete window[`_${id}`] },
    convertFileSrc: (p) => p,
    async invoke(cmd, args, opts) {
      calls.push(cmd)
      if (handlers[cmd] !== undefined) return handlers[cmd](args ?? {})
    // A save: the body is the bytes, the file is named in the headers.
    if (cmd === 'project_write_document' || cmd === 'project_append_document') {
      // The slow-close step: a save that does not answer until it is let go.
      if (window.__sweepHoldSaves === true) await new Promise((go) => (window.__sweepHeld ??= []).push(go))
      const key = decodeURIComponent(opts?.headers?.['x-redbeam-relative-path'] ?? '')
      const body = (args instanceof Uint8Array ? args : new Uint8Array(args)).slice()
      const old = files.get(key) ?? new Uint8Array()
      const next = cmd === 'project_write_document' ? body : new Uint8Array([...old, ...body])
      files.set(key, next)
      return { outcome: 'written', fingerprint: await fingerprint(next) }
    }
      if (cmd === 'plugin:event|listen') {
        listeners.set(args.event, [...(listeners.get(args.event) ?? []), args.handler])
        return args.handler
      }
      if (cmd === 'plugin:window|is_maximized') return false
      if (cmd === 'plugin:app|version') return '0.0.0-sweep'
      // The update chip: a step sets __sweepUpdate to a version to offer one.
      // The download holds until __sweepUpdateGo() lets it finish.
      if (cmd === 'plugin:updater|check') {
        return typeof window.__sweepUpdate === 'string'
          ? { rid: 1, currentVersion: '0.0.0-sweep', version: window.__sweepUpdate, date: null, body: null, rawJson: {} }
          : null
      }
      if (cmd === 'plugin:updater|download_and_install') {
        await new Promise((go) => { window.__sweepUpdateGo = go })
        return null
      }
      return null
    },
  }
  // Without this a listener React mounted twice in development would answer every agent call twice.
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(event, id) { listeners.set(event, (listeners.get(event) ?? []).filter((h) => h !== id)) },
  }
})()
