import { describe, expect, it } from 'vitest'
import { updateChipView } from './UpdateChip.js'

describe('updateChipView', () => {
  it('offers the update in the words Aaron asked for', () => {
    const v = updateChipView({ kind: 'available', version: '0.3.94', notes: null })
    expect(v?.label).toBe('Ready to update')
    expect(v?.action).toBe('install')
    expect(v?.detail).toContain('0.3.94')
  })
  it('says the portable copy downloads the zip', () => {
    expect(updateChipView({ kind: 'available', version: '0.3.94', notes: null }, true)?.detail).toContain('zip')
  })
  it('shows progress and cannot be pressed while downloading', () => {
    const v = updateChipView({ kind: 'downloading', percent: 41.6 })
    expect(v?.label).toBe('Updating 42%')
    expect(v?.action).toBeNull()
    expect(updateChipView({ kind: 'downloading', percent: null })?.label).toBe('Updating…')
  })
  it('asks for a restart once staged', () => {
    const v = updateChipView({ kind: 'ready', version: '0.3.94' })
    expect(v?.label).toBe('Restart to update')
    expect(v?.action).toBe('restart')
  })
  it('stays out of the way when there is nothing to do', () => {
    for (const kind of ['idle', 'checking', 'current', 'unconfigured'] as const) {
      expect(updateChipView({ kind })).toBeNull()
    }
    // A background check that failed is Settings' business, not the chip's.
    expect(updateChipView({ kind: 'failed', message: 'offline' })).toBeNull()
    expect(updateChipView({ kind: 'failed', message: 'offline' }, false, true)?.label).toBe('Update failed')
  })
})
