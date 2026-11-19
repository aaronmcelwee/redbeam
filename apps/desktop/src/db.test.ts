import { describe, expect, it, vi } from 'vitest'
import { SqlJsDriver, UndoStack } from '@redbeam/store'
import { undoOptionsFor } from './db.js'

describe('undoOptionsFor', () => {
  it('sends undo to the core only for the core’s own database, addressed to its project', () => {
    expect(undoOptionsFor('tauri', 'C:\\jobs\\a')).toEqual({ mode: 'core', projectPath: 'C:\\jobs\\a' })
    expect(undoOptionsFor('sqljs', 'C:\\jobs\\a')).toEqual({ mode: 'memory' })
  })

  it('keeps a Light window’s takeoff off the core even inside Tauri', async () => {
    // Light opens an in-memory database. The core has no project open for it,
    // so any call that reached the core failed with "no project database is open".
    const invoke = vi.fn(async () => { throw new Error('no project database is open — call db_open first') })
    const driver = await SqlJsDriver.open()
    const stack = new UndoStack(driver, 100, { ...undoOptionsFor('sqljs', 'C:\\drawings'), invoke })
    expect(stack.isProjectScoped).toBe(false)
    await stack.clear()
    expect(await stack.undo()).toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('names the project on every core call', async () => {
    const invoke = vi.fn(async () => ({}) as never)
    const stack = new UndoStack(await SqlJsDriver.open(), 100, { ...undoOptionsFor('tauri', 'C:\\jobs\\a'), invoke })
    await stack.fetchState()
    expect(invoke).toHaveBeenCalledWith('undo_state', { projectPath: 'C:\\jobs\\a' })
  })
})
