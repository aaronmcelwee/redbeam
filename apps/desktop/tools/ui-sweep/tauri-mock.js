/*
 * Just enough of Tauri for the real app to run in Chromium (ui-sweep.mjs).
 *
 * Every PDF the app asks for is the sweep fixture, served by the sweep at
 * /__sweep.pdf; a path containing "Broken" reads three bytes, so the failed
 * open can be looked at too. Anything not listed answers null, which is what
 * a desktop command with nothing to say returns. `window.__sweepCalls` keeps
 * the commands asked for, for debugging a step.
 */
(() => {
  const calls = (window.__sweepCalls = [])
  let next = 0
  const pick = (path) => ({ supported: true, path, project: null, relativePath: path.split('\\').pop(), reason: null })
  /** What each file holds now: saves land here, and the next read sees them. */
  const files = new Map()
  const fingerprint = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((b) => b.toString(16).padStart(2, '0')).join('')
  const handlers = {
    project_locate_file: (a) => pick(a.path),
    project_pick_drawing: () => pick('C:\\Jobs\\Sweep\\Second set.pdf'),
    project_pick_file: () => pick('C:\\Jobs\\Sweep\\Second set.pdf'),
    project_read_document: async (a) => {
      const key = String(a.relativePath ?? '')
      if (key.includes('Broken')) return new Uint8Array([1, 2, 3])
      if (!files.has(key)) files.set(key, new Uint8Array(await (await fetch('/__sweep.pdf')).arrayBuffer()))
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
      const key = decodeURIComponent(opts?.headers?.['x-redbeam-relative-path'] ?? '')
      const body = (args instanceof Uint8Array ? args : new Uint8Array(args)).slice()
      const old = files.get(key) ?? new Uint8Array()
      const next = cmd === 'project_write_document' ? body : new Uint8Array([...old, ...body])
      files.set(key, next)
      return { outcome: 'written', fingerprint: await fingerprint(next) }
    }
      if (cmd === 'plugin:event|listen') return ++next
      if (cmd === 'plugin:window|is_maximized') return false
      if (cmd === 'plugin:app|version') return '0.0.0-sweep'
      return null
    },
  }
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
})()
