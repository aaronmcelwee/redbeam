import { describe, expect, it } from 'vitest'
import { clientNote } from './AiAppsRun.js'
import { aiStatus } from '../tauri/aiApps.js'

const claude = { id: 'claude' as const, detected: true, installed: false, files: [] }
const chatgpt = { id: 'chatgpt' as const, detected: true, installed: false, files: [] }

describe('Claude and ChatGPT settings', () => {
  it('says what adding does, and to restart the app', () => {
    expect(clientNote(claude, false)).toMatch(/Claude desktop app.*restart Claude/)
    expect(clientNote({ ...claude, installed: true }, true)).toMatch(/Added/)
  })

  it('is honest that ChatGPT on the web cannot reach this computer', () => {
    expect(clientNote(chatgpt, false)).toMatch(/on the web cannot reach/)
    expect(clientNote({ ...chatgpt, installed: true }, true)).toMatch(/on the web cannot reach/)
  })

  it('says when an installed app is blocked by the switch', () => {
    expect(clientNote({ ...claude, installed: true }, false)).toMatch(/switch above is on/)
    expect(clientNote({ ...chatgpt, installed: true }, false)).toMatch(/switch above is on/)
  })

  it('is not offered outside the desktop app', async () => {
    expect((await aiStatus()).supported).toBe(false)
  })
})
