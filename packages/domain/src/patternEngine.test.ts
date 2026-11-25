import { describe, it, expect } from 'vitest'
import { calculatePieces } from './takeoff.js'
import { buildBom } from './bom.js'
import { checkPatternRecipe, PATTERN_EXAMPLES, approvePatternRecipe, PATTERN_RECIPE_KEY, type PatternRecipe } from './patternRecipe.js'
import { builtInAsRecipe, productDefinitionFor, BUILT_IN_PRODUCTS } from './products.js'
import type { Calibration, Markup, Scope } from './scope.js'

/*
 * A 1000 x 1000 pt sheet at 0.05 ft/pt: 0.2 of the page is 10 ft. Pattern
 * runs along +x; the automatic origin is the area's corner.
 */
const cal: Calibration = { feetPerPoint: 0.05, pageWidth: 1000, pageHeight: 1000 }
const opts = { scopeDirection: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }] as const, pageSize: { width: 1000, height: 1000 } }

function square(feet: number, id = 'a1'): Markup {
  const s = feet / 50
  return {
    id, scopeId: 's1', documentId: 'd', pageId: 'p0', kind: 'area',
    rings: [[{ x: 0.1, y: 0.1 }, { x: 0.1 + s, y: 0.1 }, { x: 0.1 + s, y: 0.1 + s }, { x: 0.1, y: 0.1 + s }]],
  }
}

const scope = (specs: Record<string, unknown>): Scope => ({ id: 's1', label: 'CL-1', scopeType: 'area', color: '#c2410c', specifications: specs })
const pattern = (recipe: unknown) => scope({ productType: 'custom_pattern', [PATTERN_RECIPE_KEY]: recipe })
const q = (r: ReturnType<typeof calculatePieces>, key: string) => r.quantities.find((x) => x.itemKey === key)?.quantity

const squareTiles = (cuts?: string): PatternRecipe => ({
  version: 1, name: '2x2 tile', status: 'draft', units: 'in',
  layers: [{
    id: 'tiles', kind: 'tiles', module: { along: 24, across: 24 },
    tiles: [{ name: 'Tile', points: [[0, 0], [24, 0], [24, 24], [0, 24]] }],
    ...(cuts !== undefined ? { cuts: cuts as 'whole' } : {}),
  }],
})

describe('custom pattern: tiles', () => {
  it('lays 25 whole 2x2 tiles on a 10x10 room', () => {
    const r = calculatePieces(pattern(squareTiles()), [square(10)], cal, opts)
    expect(r.blockers).toEqual([])
    expect(q(r, 'tiles.tile')).toBe(25)
    expect(q(r, 'tiles.tile.whole')).toBe(25)
    expect(q(r, 'tiles.tile.cut')).toBeUndefined()
    expect(r.shapes?.filter((s) => s.kind === 'polygon')).toHaveLength(25)
  })

  it('cuts the last row and column of a 9x9 room, and orders them by the cut rule', () => {
    const whole = calculatePieces(pattern(squareTiles()), [square(9)], cal, opts)
    expect(q(whole, 'tiles.tile.whole')).toBe(16)
    expect(q(whole, 'tiles.tile.cut')).toBe(9)
    expect(q(whole, 'tiles.tile')).toBe(25)
    // Eight half tiles and one quarter: 4.5 tiles of halves, 4.25 by area.
    expect(q(calculatePieces(pattern(squareTiles('halves')), [square(9)], cal, opts), 'tiles.tile')).toBe(16 + 5)
    expect(q(calculatePieces(pattern(squareTiles('nest')), [square(9)], cal, opts), 'tiles.tile')).toBe(16 + 5)
  })

  it('covers the room exactly with alternating triangles', () => {
    const r = calculatePieces(pattern(PATTERN_EXAMPLES['triangles']), [square(10)], cal, opts)
    expect(r.blockers).toEqual([])
    const ordered = q(r, 'panels.triangle-panel')!
    const waste = q(r, 'panels.waste')!
    const tileArea = 48 * 41.569 / 2 / 144
    // Ordered area less waste is the room, to the rounding of the waste line.
    expect(ordered * tileArea * (1 - waste / 100)).toBeCloseTo(100, 0)
    expect(q(r, 'panels.triangle-panel.cut')).toBeGreaterThan(0)
    // 40 ft of edge in 12 ft trim: each 10 ft edge takes one length.
    expect(q(r, 'hardware.perimeter-trim')).toBe(4)
  })
})

describe('custom pattern: members (a repeating "random" module)', () => {
  const recipe = (y: 'full' | 'half'): PatternRecipe => ({
    version: 1, name: 'Module', status: 'draft', units: 'ft',
    layers: [
      { id: 'baffles', kind: 'members', module: { along: 10, across: 2 }, members: [{ along: 0, across: 1, length: 6 }], stock: 12, yield: y },
      { id: 'hw', kind: 'hardware', items: [
        { name: 'End caps', per: 'piece', of: 'baffles', qty: 2 },
        { name: 'Hangers', per: 'piece', of: 'baffles', qty: 2, over: 5, qtyOver: 3 },
      ] },
    ],
  })

  it('places one member per module row, measures and orders them', () => {
    const r = calculatePieces(pattern(recipe('full')), [square(10)], cal, opts)
    expect(r.blockers).toEqual([])
    expect(q(r, 'baffles.count')).toBe(5)
    expect(q(r, 'baffles.length')).toBe(30)
    expect(q(r, 'baffles.stock')).toBe(5)
    expect(q(r, 'hw.end-caps')).toBe(10)
    expect(q(r, 'hw.hangers')).toBe(15)
  })

  it('nests half lengths when the yield allows it', () => {
    expect(q(calculatePieces(pattern(recipe('half')), [square(10)], cal, opts), 'baffles.stock')).toBe(3)
  })
})

describe('custom pattern: layers and hardware on a built-in product', () => {
  const panels = { panelWidth: '24', panelWidthUnit: 'in', panelLength: '48', panelLengthUnit: 'in' }
  const onRails: PatternRecipe = {
    version: 1, name: 'Panels on rails', status: 'draft',
    layers: [
      { id: 'panels', kind: 'panels', specifications: panels },
      { id: 'rails', kind: 'lines', name: 'Rails', run: 'across', spacing: "4'", offset: "1'", stock: "16'" },
      { id: 'hw', kind: 'hardware', items: [
        { name: 'Hangers', per: 'along', of: 'rails', every: "4'", fromEnds: "1'" },
        { name: 'Clips', per: 'crossing', of: ['rails', 'panels'], qty: 2 },
      ] },
    ],
  }

  it('counts the panel layer exactly as a panel scope', () => {
    const alone = calculatePieces(scope({ productType: 'panels', ...panels }), [square(10)], cal, opts)
    const layered = calculatePieces(pattern(onRails), [square(10)], cal, opts)
    expect(layered.blockers).toEqual([])
    expect(q(layered, 'panels.panel_count')).toBe(q(alone, 'panel_count'))
    expect(layered.cells.length).toBe(alone.cells.length)
  })

  it('lays rails across the panels and counts hangers along them and clips where they cross joints', () => {
    const r = calculatePieces(pattern(onRails), [square(10)], cal, opts)
    expect(q(r, 'rails.count')).toBe(3)
    expect(q(r, 'rails.length')).toBe(30)
    expect(q(r, 'rails.stock')).toBe(3)
    // 10 ft rail, first and last 1 ft in, every 4 ft: 1, 5, 9.
    expect(q(r, 'hw.hangers')).toBe(9)
    const clips = q(r, 'hw.clips')!
    expect(clips).toBeGreaterThan(0)
    expect(clips % 6).toBe(0) // 3 rails, 2 clips each crossing
  })

  it('reads the open cell example: mains, tees, coffers in every other cell', () => {
    const r = calculatePieces(pattern(PATTERN_EXAMPLES['openCellWithCoffers']), [square(10)], cal, opts)
    expect(r.blockers).toEqual([])
    // Mains every 2 ft in a 10 ft room: 2, 4, 6, 8. The one on the wall line is the wall angle's.
    expect(q(r, 'mains.count')).toBe(4)
    expect(q(r, 'tees.count')).toBe(4)
    expect(q(r, 'coffers.coffer')).toBeGreaterThan(10)
    expect(q(r, 'hardware.hold-down-clips')).toBe(q(r, 'coffers.coffer')! * 4)
    expect(q(r, 'hardware.wall-angle')).toBe(4)
  })

  it('turns a panel scope into a one-layer pattern without moving its count', () => {
    const specs = { productType: 'panels', ...panels, panelGranularity: 'half' }
    const recipe = builtInAsRecipe(specs, 'CL-1 panels')!
    const before = calculatePieces(scope(specs), [square(9)], cal, opts)
    const after = calculatePieces(pattern(recipe), [square(9)], cal, opts)
    expect(q(after, 'panels.panel_count')).toBe(q(before, 'panel_count'))
  })
})

describe('approval and the BOM', () => {
  it('marks a draft pattern unverified and an approved one verified', () => {
    const draft = calculatePieces(pattern(squareTiles()), [square(10)], cal, opts)
    const bomDraft = buildBom([{ scope: pattern(squareTiles()), result: draft }])
    expect(bomDraft.lines.every((l) => l.confidence === 'unverified')).toBe(true)
    expect(bomDraft.lines[0]!.productLabel).toBe('2x2 tile')
    expect(bomDraft.lines[0]!.note).toContain('draft')

    const approved = approvePatternRecipe(squareTiles(), 'Aaron', '2026-11-25')
    const r = calculatePieces(pattern(approved), [square(10)], cal, opts)
    const bom = buildBom([{ scope: pattern(approved), result: r }])
    expect(bom.lines.every((l) => l.confidence === 'verified')).toBe(true)
  })
})

describe('checking a recipe', () => {
  it('refuses a concave tile and says how to fix it', () => {
    const c = checkPatternRecipe({
      name: 'L', layers: [{ id: 't', kind: 'tiles', module: { along: 24, across: 24 }, tiles: [{ points: [[0, 0], [24, 0], [24, 12], [12, 12], [12, 24], [0, 24]] }] }],
    })
    expect(c.ok).toBe(false)
    if (!c.ok) expect(c.errors.join(' ')).toMatch(/not convex.*Split/)
  })

  it('refuses hardware on a layer that is not there', () => {
    const c = checkPatternRecipe({
      name: 'x', layers: [
        { id: 't', kind: 'lines', run: 'along', spacing: 12 },
        { id: 'h', kind: 'hardware', items: [{ name: 'Clips', per: 'piece', of: 'rails' }] },
      ],
    })
    expect(c.ok).toBe(false)
    if (!c.ok) expect(c.errors.join(' ')).toContain('no layer "rails"')
  })

  it('blocks a scope whose recipe does not check, rather than counting zero', () => {
    const r = calculatePieces(pattern({ name: 'bad', layers: [] }), [square(10)], cal, opts)
    expect(r.quantities).toEqual([])
    expect(r.blockers[0]).toContain('the pattern')
  })

  it('accepts every published example', () => {
    for (const [name, recipe] of Object.entries(PATTERN_EXAMPLES)) {
      const c = checkPatternRecipe(recipe)
      expect(c.ok, `${name}: ${c.ok ? '' : c.errors.join('; ')}`).toBe(true)
    }
  })
})

describe('one product system', () => {
  it('gives every built-in product a one-layer definition', () => {
    expect(BUILT_IN_PRODUCTS.map((p) => p.id)).toEqual(['panels', 'planks', 'baffle_cassette', 'baffle', 'linear_parts', 'custom_assembly'])
    for (const p of BUILT_IN_PRODUCTS) expect(p.layers).toHaveLength(1)
  })

  it('names a pattern scope by its pattern', () => {
    const d = productDefinitionFor({ productType: 'custom_pattern', [PATTERN_RECIPE_KEY]: PATTERN_EXAMPLES['panelsOnRails'] })
    expect(d.label).toBe('Panels on suspension rails')
    expect(d.layers.map((l) => l.id)).toEqual(['panels', 'rails', 'hardware'])
    expect(d.draft).toBe(true)
  })
})
