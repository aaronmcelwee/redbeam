/**
 * Finishing a shape is ONE render of the window.
 *
 * Pressing Enter on an area used to render the whole workspace six times on
 * the 80 MB Scottsdale set: the undo state, the scale regions, the markups,
 * the estimate list, the open round, and then the quantities from an effect.
 * The window also re-rendered twice a second for a performance readout that
 * is normally hidden. These guard the shape of the fix, since a regression
 * shows up only as a slower Enter, never as a wrong answer.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8')
const workspace = read('./Workspace.tsx')
const code = workspace.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const body = (start: string, end: string) => {
  const at = code.indexOf(start)
  expect(at, `${start} is gone`).toBeGreaterThan(-1)
  return code.slice(at, code.indexOf(end, at))
}

describe('finishing a shape', () => {
  it('reads regions and the round with the markups, before setting anything', () => {
    const sync = body('const syncMarkups = useCallback(', '}, [applyEstimates])')
    const all = sync.slice(sync.indexOf('await Promise.all(['), sync.indexOf('])', sync.indexOf('await Promise.all([')))
    expect(all).toContain('loadRegions(db)')
    expect(all).toContain('loadEstimates(db,')
    // Only one await: a second one splits the sets into two renders.
    expect(sync.match(/\bawait\b/g)).toHaveLength(1)
  })

  it('sets the undo state in the same block as the markups', () => {
    const run = body('const runCommand = useCallback(', '}, [syncMarkups')
    expect(run).toMatch(/await syncMarkups\(\(\) => \{[^}]*setUndoState\(u\.state\)/)
  })

  it('derives quantities and pieces in the render, not in an effect', () => {
    expect(code).not.toContain('setQuantities(')
    expect(code).not.toContain('setPieces(')
    expect(code).toContain('const takeoffTotals = useMemo(')
  })

  it('does not reload the round from an effect on the markup count', () => {
    expect(code).not.toMatch(/\[backend, refreshEstimates, [^\]]*markups\.length/)
  })

  it('keeps the performance meters out of the workspace state', () => {
    expect(code).not.toMatch(/setPerf\(/)
    expect(read('./shell/PerfReadout.tsx')).toMatch(/setInterval\(\(\) => setPerf\(registry\.all\(\)\), 500\)/)
  })
})
