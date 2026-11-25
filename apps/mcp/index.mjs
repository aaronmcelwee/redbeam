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
function bridgeCall(method, params = {}, onAlive = () => {}) {
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
      socket.write(JSON.stringify({ id: 1, method, token: d.token, params, keepalive: true }) + '\n'))
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

async function callTool(name, args = {}, onAlive = () => {}) {
  const method = METHOD_OF[name]
  if (!method) throw new Error(`Unknown REDBEAM tool: ${name}`)
  const bound = ACTION_OF[name] ? { ...args, action: ACTION_OF[name] } : args
  const result = await bridgeCall(method, bound, onAlive)

  // A screenshot is returned as an image block, not as a data URL in text: a
  // 2 MB base64 string pasted into a transcript is unreadable and expensive.
  if (name === 'redbeam_screenshot' && typeof result?.dataUrl === 'string') {
    const comma = result.dataUrl.indexOf(',')
    return {
      content: [{ type: 'image', data: result.dataUrl.slice(comma + 1), mimeType: 'image/png' }],
    }
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
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
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: SPEC.instructions,
        },
      })
      return
    }
    if (method === 'notifications/initialized') return
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} })
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools } })
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

function startServer() {
  let buffer = ''
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

export { bridgeCall, callTool, tools, METHOD_OF, ACTION_OF, startServer }

if (import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, '/')) startServer()
