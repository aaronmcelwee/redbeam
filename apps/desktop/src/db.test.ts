import { describe, expect, it, vi } from 'vitest'
import { SqlJsDriver, UndoStack } from '@redbeam/store'
import { undoModeFor } from './db.js'

describe('undoModeFor', () => {
  it('sends undo to the core only for the core’s own database', () => {
    expect(undoModeFor('tauri')).toBe('core')
    expect(undoModeFor('sqljs')).toBe('memory')
  })

  it('keeps a Light window’s takeoff off the core even inside Tauri', async () => {
    // Light opens an in-memory database. The core has no project open, so any
    // call that reaches it fails with "no project database is open".
    const invoke = vi.fn(async () => { throw new Error('no project database is open — call db_open first') })
    const driver = await SqlJsDriver.open()
    const stack = new UndoStack(driver, 100, { mode: undoModeFor('sqljs'), invoke })
    expect(stack.isProjectScoped).toBe(false)
    await stack.clear()
    expect(invoke).not.toHaveBeenCalled()
  })
})
