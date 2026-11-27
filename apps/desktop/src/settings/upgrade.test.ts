/**
 * Every setting survives an update (Aaron, 2026-11-27: "settings such as
 * beta custom patterns keep being resetted after updates").
 *
 * What reset them: each window opened its own store and wrote its whole
 * snapshot back, so a window that predated a change wrote the old value over
 * it; and localStorage could lose a write the updater cut off. These tests
 * hold every setting in the registry to a changed value and check it comes
 * back through each of those paths, so a setting added later is covered by
 * being listed.
 */
import { describe, it, expect } from 'vitest'
import { SETTINGS, type SettingDescriptor } from './registry.js'
import { SettingsStore, memoryStorage, pickRestore, type SettingsStorage } from './store.js'
import type { SettingValue } from './registry.js'

/** A valid value that is not the default. */
function changed(d: SettingDescriptor): SettingValue {
  switch (d.type) {
    case 'bool': return !d.default
    case 'int': return d.default < d.max ? d.default + 1 : d.default - 1
    case 'enum': return d.choices.find((c) => c.value !== d.default)!.value
  }
}

function shared(): SettingsStorage & { text: () => string | null } {
  let text: string | null = null
  return { read: () => text, write: (t) => { text = t }, text: () => text }
}

function setEverything(store: SettingsStore): void {
  for (const d of SETTINGS) expect(store.set(d.id, changed(d)), d.id).toBeNull()
}

function expectEverythingKept(store: SettingsStore): void {
  for (const d of SETTINGS) expect(store.get(d.id), d.id).toBe(changed(d))
}

describe('settings survive an update', () => {
  it('reads every setting written by the previous build (no write stamp)', () => {
    const old: Record<string, SettingValue> = {}
    for (const d of SETTINGS) old[d.id] = changed(d)
    const store = SettingsStore.open(memoryStorage(old))
    expect(store.rejected).toEqual([])
    expectEverythingKept(store)
  })

  it('keeps every setting through a relaunch', () => {
    const storage = shared()
    setEverything(SettingsStore.open(storage))
    expectEverythingKept(SettingsStore.open(storage))
  })

  it('a window opened before the change cannot write the old values back', () => {
    const storage = shared()
    const olderWindow = SettingsStore.open(storage)
    const settingsWindow = SettingsStore.open(storage)
    setEverything(settingsWindow)
    // The older window still holds defaults and saves something else: an
    // agent toggling the layout preview, the theme, anything.
    for (const d of SETTINGS) olderWindow.set(d.id, olderWindow.get(d.id))
    olderWindow.set(SETTINGS[0]!.id, changed(SETTINGS[0]!))
    expectEverythingKept(SettingsStore.open(storage))
    // And it now reads what the other window wrote.
    expectEverythingKept(olderWindow)
  })

  it('reload() takes another window\'s writes without writing', () => {
    const storage = shared()
    const a = SettingsStore.open(storage)
    const b = SettingsStore.open(storage)
    setEverything(a)
    const before = storage.text()
    let told = 0
    b.subscribe(() => { told++ })
    b.reload()
    expect(storage.text()).toBe(before)
    expect(told).toBe(1)
    expectEverythingKept(b)
  })

  it('keeps a key from a newer build when an older build writes', () => {
    const storage = shared()
    storage.write(JSON.stringify({ 'beta.somethingNewer': true, 'beta.customPatterns': true }))
    const first = SETTINGS.find((d) => d.id !== 'beta.customPatterns')!
    SettingsStore.open(storage).set(first.id, changed(first))
    const stored = JSON.parse(storage.text()!) as Record<string, unknown>
    expect(stored['beta.somethingNewer']).toBe(true)
    expect(stored['beta.customPatterns']).toBe(true)
  })

  it('restores from the disk copy when the webview lost the last write', () => {
    const disk = shared()
    setEverything(SettingsStore.open(disk))
    // The webview kept nothing (reset profile) ...
    expect(pickRestore(null, disk.text())).toBe(disk.text())
    // ... or kept an older copy (the updater ended the process first).
    const stale = shared()
    stale.write(JSON.stringify({ '$savedAt': 1 }))
    const use = pickRestore(stale.text(), disk.text())
    expect(use).toBe(disk.text())
    expectEverythingKept(SettingsStore.open(memoryStorageFrom(use!)))
  })

  it('keeps the webview copy when it is the newer one', () => {
    const disk = shared()
    disk.write(JSON.stringify({ '$savedAt': 1, 'beta.customPatterns': false }))
    const local = shared()
    setEverything(SettingsStore.open(local))
    expect(pickRestore(local.text(), disk.text())).toBeNull()
    expect(pickRestore(local.text(), null)).toBeNull()
  })
})

function memoryStorageFrom(text: string): SettingsStorage {
  let t: string | null = text
  return { read: () => t, write: (x) => { t = x } }
}
