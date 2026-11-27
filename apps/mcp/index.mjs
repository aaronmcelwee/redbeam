#!/usr/bin/env node
/**
 * MCP server for the REDBEAM automation bridge (plan 11.1).
 *
 * Exposes the bridge's methods as MCP tools so an agent gets them as
 * first-class tools rather than shelling out to a script.
 *
 * Dependency-free on purpose, matching the Qt build's server: newline-
 * delimited JSON-RPC on stdio, and a plain TCP socket to the app. Adding an
 * SDK here would put a dependency between an agent and the app it is meant to
 * be debugging, which is exactly the layer you want to stay boring.
 *
 * The app must be running with REDBEAM_BRIDGE=1. Every tool reports a clear
 * "start the app" error rather than hanging when it is not.
 */
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SERVER_INFO = { name: 'redbeam', version: '0.1.0' }
const DISCOVERY_FILE = path.join(os.tmpdir(), 'redbeam-bridge.json')
// How long REDBEAM may say nothing during a call (it sends keepalives while working).
const CALL_TIMEOUT_MS = Number(process.env['REDBEAM_BRIDGE_TIMEOUT_MS'] ?? 60000)

// --------------------------------------------------------------- transport --

function readDiscovery() {
  if (!fs.existsSync(DISCOVERY_FILE)) {
    throw new Error(
      `REDBEAM is not running, or AI control is off. Open REDBEAM and turn on ` +
      `Settings › Claude and ChatGPT › Let AI apps use REDBEAM (or start it with REDBEAM_BRIDGE=1) ` +
      `(discovery file expected at ${DISCOVERY_FILE}).`,
    )
  }
  const d = JSON.parse(fs.readFileSync(DISCOVERY_FILE, 'utf8'))
  if (!d.port || !d.token) throw new Error(`Malformed bridge discovery file: ${DISCOVERY_FILE}`)
  return d
}

/**
 * One call, one connection — matching the bridge.
 *
 * The discovery file is re-read per call rather than cached: the app restarts
 * often during development and gets a new port and token each time. A cached
 * handle would fail with a confusing connection error long after the real
 * cause (a restart) had scrolled away.
 */
function bridgeCall(method, params = {}, agent = null, onAlive = () => {}) {
  const d = readDiscovery()
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(d.port, '127.0.0.1')
    let buffer = ''
    /*
     * A clock on SILENCE, not on the work (Aaron, 2026-11-24: no arbitrary
     * caps). REDBEAM sends {"keepalive":true} every few seconds while a call
     * runs; each one restarts the clock, so a long export finishes.
     */
    let timer
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        socket.destroy()
        reject(new Error(`REDBEAM said nothing for ${CALL_TIMEOUT_MS}ms during bridge method ${method}`))
      }, CALL_TIMEOUT_MS)
    }
    arm()

    socket.on('connect', () =>
      socket.write(JSON.stringify({ id: 1, method, token: d.token, params, keepalive: true, ...(agent ? { agent } : {}) }) + '\n'))
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      for (;;) {
        const nl = buffer.indexOf('\n')
        if (nl === -1) return
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        let res
        try {
          res = JSON.parse(line)
        } catch (e) {
          clearTimeout(timer)
          socket.end()
          reject(e)
          return
        }
        if (res && res.keepalive === true) { arm(); onAlive(); continue }
        clearTimeout(timer)
        socket.end()
        if (res.ok) resolve(res.result)
        else reject(new Error(res.error ?? `bridge method ${method} failed`))
        return
      }
    })
    socket.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(
        `Could not reach the REDBEAM bridge on 127.0.0.1:${d.port} (${e.message}). ` +
        `The app may have been restarted — its port and token change each launch.`,
      ))
    })
  })
}

// ------------------------------------------------------------------- tools --

/**
 * Tool definitions, the MCP-name -> bridge-method map, and the tools that are
 * one ui-action under a name that says what it is FOR.
 *
 * They live in tools.json so this server and the one built into REDBEAM.exe
 * (`REDBEAM.exe --mcp`, src-tauri/src/mcp.rs, which is what the Settings page
 * installs into Claude and ChatGPT) list exactly the same tools. Two copies of
 * a forty-line enum drift the first time someone adds an action.
 *
 * Descriptions say what a result MEANS, not just what the call does, because
 * that is what stops an agent misreading one: `open_file` returning
 * `accepted` is the obvious trap. Reading and producing the deliverable
 * (get_bom, export) have tools of their own as well as their place in the
 * action enum, because an action buried in an enum stays unfound.
 */
const SPEC = JSON.parse(fs.readFileSync(new URL('./tools.json', import.meta.url), 'utf8'))
const tools = SPEC.tools
/** MCP tool name -> bridge method. */
const METHOD_OF = SPEC.methodOf
/** Named tools that are one invoke_ui_action under a clearer name. */
const ACTION_OF = SPEC.actionOf

/**
 * Who a call is from. Several chats work in REDBEAM at once, each in tabs of
 * its own with its own colour and cursor; the app tells them apart by this.
 *
 * An AI app runs ONE server process for all its chats, and nothing in MCP
 * says which chat a call is from. So a chat starts a session
 * (redbeam_start_session) and is handed a value to pass back on every call.
 * The server makes that value, with a code no other session has, so two
 * chats that call their job the same thing still get a group each, and a
 * chat that passes none, or makes one up, is refused rather than landing in
 * another chat's tabs (mcp.rs does the same).
 */
const SESSION = `${process.pid.toString(16)}-${Date.now().toString(16)}`
let clientName = null
const SESSION_ARG = 'session'
const SESSION_TOOL = SPEC.sessions.tool
/** code -> the task its chat named. */
const sessions = new Map()
const CODE_LETTERS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
function newCode() {
  for (;;) {
    let code = ''
    for (let i = 0; i < 3; i++) code += CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)]
    if (!sessions.has(code)) return code
  }
}
/** Start a session for a chat: the value it passes back from now on. */
function startSession(task) {
  const t = (typeof task === 'string' ? task : '').trim().replace(/\s+/g, ' ').replace(/#/g, '').slice(0, 60).trim()
  if (t === '') throw new Error('Give `task`: a short name for the job this chat is doing.')
  const code = newCode()
  sessions.set(code, t)
  return `${t} #${code}`
}
/** The session a call named, or null when it named none this server issued. Only the code is read: a chat may tidy the words. */
function sessionOf(value) {
  if (typeof value !== 'string') return null
  const hash = value.lastIndexOf('#')
  if (hash < 0) return null
  const code = value.slice(hash + 1).trim().toUpperCase()
  const task = sessions.get(code)
  return task === undefined ? null : { code, task }
}
function identity(session) {
  return { id: `${SESSION}/${session.code}`, client: clientName, label: session.task }
}
/**
 * The tool list as an AI app is given it: the session tool first, the batch
 * tool, then every tool with the required `session` input.
 *
 * Every chat pays for all of this text before its first call, so what is
 * listed is kept lean (SPEC.lean) without touching what a tool does:
 *  - redbeam_invoke_ui_action is not listed. Every action it takes has a tool
 *    of its own, and its schema repeated all of theirs. A call to it still works.
 *  - `file` and `session` are on every tool; their long explanation is in the
 *    server instructions once, and each tool carries a short line.
 *  - "For a, b and c: ..." at the start of an input's description names the
 *    actions of the catch-all tool; on a tool of its own it says nothing.
 */
const LEAN = SPEC.lean
const FOR_ACTIONS = /^For [a-z_]+(?:, [a-z_]+)*(?:,? and [a-z_]+)?: /
function leanSchema(node) {
  if (Array.isArray(node)) return node.map(leanSchema)
  if (node === null || typeof node !== 'object') return node
  const out = {}
  for (const [k, v] of Object.entries(node)) out[k] = leanSchema(v)
  if (typeof out.description === 'string') {
    const m = FOR_ACTIONS.exec(out.description)
    if (m !== null) {
      const rest = out.description.slice(m[0].length)
      out.description = rest.charAt(0).toUpperCase() + rest.slice(1)
    }
  }
  return out
}
function withSession(t) {
  const schema = leanSchema(t.inputSchema ?? { type: 'object', properties: {} })
  const properties = { ...(schema.properties ?? {}) }
  if (properties.file !== undefined) properties.file = { type: 'string', description: LEAN.file }
  if (properties[SESSION_ARG] !== undefined) return { ...t, inputSchema: { ...schema, properties } }
  properties[SESSION_ARG] = { type: 'string', description: LEAN.session }
  return { ...t, inputSchema: { ...schema, properties, required: [...(schema.required ?? []), SESSION_ARG] } }
}
function toolsWithAgent() {
  return [SESSION_TOOL, withSession(LEAN.batch), ...tools.filter((t) => !LEAN.hidden.includes(t.name)).map(withSession)]
}

/** The text of an answer: JSON with no indentation. Indented, the same answers were two thirds bigger for nothing a model reads. */
const asText = (value) => JSON.stringify(value)

/** `"$N.path"`: the value at `path` in the answer of call N of this batch; anything else is itself. */
function resolveRefs(value, answers) {
  if (typeof value === 'string') {
    const m = /^\$(\d+)\.([\w.]+)$/.exec(value)
    if (m === null) return value
    let at = answers[Number(m[1])]
    for (const key of m[2].split('.')) {
      if (at === null || typeof at !== 'object') throw new Error(`${value}: call ${m[1]} has no such value`)
      at = at[key]
    }
    if (at === undefined) throw new Error(`${value}: call ${m[1]} has no such value`)
    return at
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, answers))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v, answers)]))
  }
  return value
}

/** One bridge call for a session: the answer as REDBEAM gave it. */
async function callBridge(name, inputs, session, onAlive) {
  const method = METHOD_OF[name]
  if (!method) throw new Error(`Unknown REDBEAM tool: ${name}`)
  const bound = ACTION_OF[name] ? { ...inputs, action: ACTION_OF[name] } : inputs
  return await bridgeCall(method, bound, identity(session), onAlive)
}

/** Several calls in one round trip (SPEC.lean.batch). */
async function callBatch(args, session, onAlive) {
  const calls = Array.isArray(args?.calls) ? args.calls : []
  if (calls.length === 0) throw new Error('Give `calls`: [{tool, arguments}, ...].')
  const carryOn = args?.continueOnError === true
  const answers = []
  const results = []
  const images = []
  let failed = 0
  for (let i = 0; i < calls.length; i++) {
    const tool = typeof calls[i]?.tool === 'string' ? calls[i].tool : ''
    try {
      if (tool === SESSION_TOOL.name || tool === LEAN.batch.name) throw new Error(`${tool} cannot run inside a batch`)
      const { [SESSION_ARG]: _own, ...inputs } = resolveRefs(calls[i]?.arguments ?? {}, answers)
      const result = await callBridge(tool, inputs, session, onAlive)
      answers.push(result)
      if (tool === 'redbeam_screenshot' && typeof result?.dataUrl === 'string') {
        images.push({ type: 'image', data: result.dataUrl.slice(result.dataUrl.indexOf(',') + 1), mimeType: 'image/png' })
        results.push({ call: i, tool, ok: true, result: { image: images.length } })
      } else {
        results.push({ call: i, tool, ok: true, result })
      }
    } catch (e) {
      failed++
      answers.push(null)
      results.push({ call: i, tool, ok: false, error: e.message })
      if (!carryOn) break
    }
  }
  const summary = {
    ran: results.length, of: calls.length, failed,
    ...(results.length < calls.length ? { stoppedAt: results.length - 1, note: 'A call failed, so the calls after it were not run. Fix it and send the rest.' } : {}),
    results,
  }
  return { content: [{ type: 'text', text: asText(summary) }, ...images], structuredContent: summary, ...(failed > 0 && results.length === failed ? { isError: true } : {}) }
}

async function callTool(name, args = {}, onAlive = () => {}) {
  if (name === SESSION_TOOL.name) {
    const session = startSession(args?.task)
    return {
      content: [
        { type: 'text', text: asText({ session, use: 'Pass this exact value as `session` on every other REDBEAM call in this chat.', takeoffSkill: SKILL_URI }) },
        { type: 'text', text: skillHandout() },
      ],
      structuredContent: { session, takeoffSkill: SKILL_URI },
    }
  }
  if (name !== LEAN.batch.name && !METHOD_OF[name]) throw new Error(`Unknown REDBEAM tool: ${name}`)
  // Who is calling is not an input of the tool: it rides beside them.
  const { [SESSION_ARG]: named, ...inputs } = args ?? {}
  const session = sessionOf(named)
  if (session === null) throw new Error(SPEC.sessions.refused)
  if (name === LEAN.batch.name) return await callBatch(inputs, session, onAlive)
  const result = await callBridge(name, inputs, session, onAlive)

  // A screenshot is returned as an image block, not as a data URL in text: a
  // 2 MB base64 string pasted into a transcript is unreadable and expensive.
  if (name === 'redbeam_screenshot' && typeof result?.dataUrl === 'string') {
    const comma = result.dataUrl.indexOf(',')
    return {
      content: [{ type: 'image', data: result.dataUrl.slice(comma + 1), mimeType: 'image/png' }],
    }
  }
  return {
    content: [{ type: 'text', text: asText(result) }],
    structuredContent: result && typeof result === 'object' ? result : { value: result },
  }
}

// -------------------------------------------------------------- rpc plumbing --

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const sendError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

async function handleRequest(req) {
  const { id, method, params } = req
  try {
    if (method === 'initialize') {
      if (typeof params?.clientInfo?.name === 'string') clientName = params.clientInfo.name
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: SERVER_INFO,
          instructions: SPEC.instructions + LEAN.instructions,
        },
      })
      return
    }
    if (method === 'notifications/initialized') return
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} })
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: toolsWithAgent() } })
    if (method === 'resources/list') {
      return send({ jsonrpc: '2.0', id, result: { resources: [{
        uri: GUIDE_URI, name: 'Working beside a person in REDBEAM', mimeType: 'text/plain',
        description: 'How a session starts, waits, and ends, and how to keep what the person sees about you true.',
      }, {
        uri: SKILL_URI, name: 'Precon takeoff skill', mimeType: 'text/markdown', description: SKILL_ABOUT,
      }] } })
    }
    if (method === 'resources/read') {
      if (params?.uri === SKILL_URI) return send({ jsonrpc: '2.0', id, result: { contents: [{ uri: SKILL_URI, mimeType: 'text/markdown', text: SKILL }] } })
      return send({ jsonrpc: '2.0', id, result: { contents: [{ uri: GUIDE_URI, mimeType: 'text/plain', text: guide() }] } })
    }
    if (method === 'prompts/list') {
      return send({ jsonrpc: '2.0', id, result: { prompts: [{ name: SKILL_NAME, description: SKILL_ABOUT }] } })
    }
    if (method === 'prompts/get') {
      if (params?.name !== SKILL_NAME) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown prompt: ${params?.name}` } })
      return send({ jsonrpc: '2.0', id, result: { description: SKILL_ABOUT, messages: [{ role: 'user', content: { type: 'text', text: skillHandout() } }] } })
    }
    if (method === 'tools/call') {
      // A long call tells an AI app that asked (`_meta.progressToken`) that
      // it is still working, so the app keeps waiting.
      const token = params?._meta?.progressToken
      let beats = 0
      const onAlive = token === undefined ? () => {} : () => send({
        jsonrpc: '2.0', method: 'notifications/progress',
        params: { progressToken: token, progress: ++beats, message: 'still working' },
      })
      const result = await callTool(params?.name, params?.arguments ?? {}, onAlive)
      return send({ jsonrpc: '2.0', id, result })
    }
    sendError(id, -32601, `Method not found: ${method}`)
  } catch (e) {
    // Reported as a tool result rather than an RPC error: the call reached the
    // server fine, and an agent should see WHY the app refused rather than a
    // protocol-level failure it cannot act on.
    if (method === 'tools/call') {
      return send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true },
      })
    }
    sendError(id, -32603, e.message)
  }
}

/**
 * The takeoff skill every agent is handed: how Maxxit wants a takeoff done.
 * A copy of the precon-takeoff skill (skills/precon-takeoff.md); when the
 * skill changes, that file changes with it and the next release carries it.
 */
const SKILL_NAME = 'precon-takeoff'
const SKILL_URI = 'redbeam://skill/precon-takeoff'
const SKILL_ABOUT = 'How to do a takeoff in REDBEAM the way Maxxit does it: scope definition for approval, then layouts, quantities and call-outs. Follow it for any takeoff.'
const SKILL = ((md) => (md.startsWith('# ') ? md : md.slice(md.indexOf('\n# ') + 1)))(fs.readFileSync(new URL('./skills/precon-takeoff.md', import.meta.url), 'utf8'))
/** The skill as an agent is given it when its session starts. */
function skillHandout() {
  return `Follow this skill for any takeoff in this chat. It is also the resource ${SKILL_URI}, to read again.\n\n${LEAN.handout}\n\n${SKILL}`
}

/** The part of the instructions about working beside a person, to read again. */
const GUIDE_URI = 'redbeam://guide/working-beside-a-person'
function guide() {
  const at = SPEC.instructions.indexOf('WORKING BESIDE A PERSON')
  return at < 0 ? SPEC.instructions : SPEC.instructions.slice(at)
}

/**
 * How often this server tells REDBEAM it is still running. REDBEAM cannot
 * see a server die (every call is a connection of its own), so one with a
 * session says so every few seconds, and the window finishes the sessions of
 * one that stops (agents/router.ts LOST_AFTER_MS). mcp.rs does the same.
 */
const ALIVE_EVERY_MS = 5000
function sayAlive() {
  if (sessions.size === 0 || !fs.existsSync(DISCOVERY_FILE)) return
  bridgeCall('agent_alive', { server: SESSION }).catch(() => {})
}
/** The AI app closed the connection: its sessions are finished, if REDBEAM is running to hear it. */
async function sayGoodbye() {
  if (!fs.existsSync(DISCOVERY_FILE)) return
  for (const [code, task] of sessions) {
    await bridgeCall('agent_bye', {}, identity({ code, task })).catch(() => {})
  }
}

function startServer() {
  let buffer = ''
  setInterval(sayAlive, ALIVE_EVERY_MS).unref()
  process.stdin.on('end', () => { void sayGoodbye().finally(() => process.exit(0)) })
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    for (;;) {
      const nl = buffer.indexOf('\n')
      if (nl < 0) break
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      try {
        void handleRequest(JSON.parse(line))
      } catch (e) {
        sendError(null, -32700, `Parse error: ${e.message}`)
      }
    }
  })
  process.stderr.write(`REDBEAM MCP server ready. Discovery: ${DISCOVERY_FILE}\n`)
}

export { bridgeCall, callTool, tools, toolsWithAgent, resolveRefs, leanSchema, identity, startSession, sessionOf, guide, SKILL, SKILL_URI, skillHandout, METHOD_OF, ACTION_OF, startServer }

if (import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, '/')) startServer()
