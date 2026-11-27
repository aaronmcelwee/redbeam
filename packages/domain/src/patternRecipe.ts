/**
 * Custom patterns: a product described as data (Aaron, 2026-11-25).
 *
 * "What's the best way to give agents the ability to create new system
 * primitives, such as triangular panels? I don't want it to be too laborious."
 * And then: North Shore was "a repeating pattern of random", an open cell grid
 * carries lay-in coffers, panels hang from suspension rails, "and hardware".
 *
 * So a product is a RECIPE: a stack of layers laid on one area, sharing the
 * scope's direction and origin so they line up, each counted on its own.
 *
 *   tiles     shapes in a repeating module           panels, triangles, coffers
 *   members   runs at set places in a module         random baffles, slats
 *   lines     runs at a spacing, along or across     rails, open cell mains/tees
 *   panels / planks / baffle / baffle_cassette / linear_parts
 *             one of the built-in engines, verbatim  the products REDBEAM had
 *   hardware  counts tied to the layers above        clips, hangers, splices
 *
 * The built-in products are themselves one-layer recipes (products.ts), which
 * is what puts every product in the same system: a panel scope can take a
 * rails layer and hardware without being rebuilt as something else.
 *
 * This module only READS and CHECKS recipes. The layout is patternEngine.ts.
 *
 * COORDINATES. "along" is the scope's pattern direction (the way a baffle
 * runs); "across" is perpendicular to it. A tile point is [along, across].
 * Plain numbers are in the recipe's `units` (inches unless stated); text is
 * a length as an estimator writes one ("48", "4'", "4' 6\"", "1200 mm").
 */

import { parseLengthInput, unitToFeet, type LengthUnit, isLengthUnit } from './units.js'
import { signedPolygonArea, type Point } from './geometry.js'

/** Where a scope keeps its recipe: in its specification, so it is saved in the PDF. */
export const PATTERN_RECIPE_KEY = 'patternRecipe'

export type PatternStatus = 'draft' | 'approved'

/** A length: a number in the recipe's units, or text with its own unit. */
export type LengthText = string | number

/** The built-in engines, usable as a layer. */
export type BuiltInLayerKind = 'panels' | 'planks' | 'baffle' | 'baffle_cassette' | 'linear_parts'
export const BUILT_IN_LAYER_KINDS: readonly BuiltInLayerKind[] = ['panels', 'planks', 'baffle', 'baffle_cassette', 'linear_parts']

export type LayerKind = 'tiles' | 'members' | 'lines' | 'hardware' | BuiltInLayerKind
export const LAYER_KINDS: readonly LayerKind[] = ['tiles', 'members', 'lines', 'hardware', ...BUILT_IN_LAYER_KINDS]

export interface PatternModule {
  /** Repeat along the direction. */
  along: LengthText
  /** Repeat across it: the next row. */
  across: LengthText
  /** How far each next row is slid along: half the module for running bond, triangles, hexagons. */
  shift?: LengthText
}

export interface TileSpec {
  /** Tiles with the same name are counted together. */
  name?: string
  /** A CONVEX outline, [along, across] per corner, in the recipe's units. */
  points: Array<[number, number]>
}

export interface MemberSpec {
  /** Where it starts along the module. */
  along: LengthText
  /** Where it sits across the module. */
  across: LengthText
  /** Its length, along the direction. */
  length: LengthText
}

export type CutRule = 'whole' | 'halves' | 'nest'
export type YieldRule = 'full' | 'half' | 'quarter'

interface LayerBase {
  /** Short and unique in the recipe: hardware names layers by it. */
  id: string
  /** What the estimator reads. Defaults from the id. */
  name?: string
  /** A layer an agent added to an approved pattern stays a draft until approved. */
  status?: PatternStatus
  /** Who made it and from what, e.g. "Claude, detail 5/A-501". */
  source?: string
}

export interface TilesLayer extends LayerBase {
  kind: 'tiles'
  module: PatternModule
  tiles: TileSpec[]
  /** Reveal between tiles. Drawn; area-neutral for counts (a joint is not material). */
  joint?: LengthText
  /** How a tile cut at the edge is ordered. Default whole: every cut piece is a tile. */
  cuts?: CutRule
}

export interface MembersLayer extends LayerBase {
  kind: 'members'
  module: PatternModule
  members: MemberSpec[]
  /** Face width, for the drawing. */
  width?: LengthText
  /** Stock length members are cut from; cuts are nested. */
  stock?: LengthText
  /** Or: fixed-length parts, each run rounded up to whole parts. */
  partLength?: LengthText
  yield?: YieldRule
}

export interface LinesLayer extends LayerBase {
  kind: 'lines'
  /** Which way the runs go. */
  run: 'along' | 'across'
  spacing: LengthText
  /** Shift of the first run from the origin, across the runs. */
  offset?: LengthText
  width?: LengthText
  stock?: LengthText
  partLength?: LengthText
  yield?: YieldRule
}

export interface BuiltInLayer extends LayerBase {
  kind: BuiltInLayerKind
  /** The same keys a scope of that product takes (describe_product lists them). */
  specifications: Record<string, unknown>
}

export type HardwarePer = 'piece' | 'module' | 'along' | 'joint' | 'crossing' | 'edge' | 'area'
export const HARDWARE_PER: readonly HardwarePer[] = ['piece', 'module', 'along', 'joint', 'crossing', 'edge', 'area']

export interface HardwareItem {
  name: string
  per: HardwarePer
  /** The layer counted from; two layers for a crossing. Absent for edge and area. */
  of?: string | [string, string]
  /** How many at each place. Default 1. */
  qty?: number
  /** along: spacing. area: square feet each. */
  every?: LengthText | number
  /** along: first and last this far in from each end of a run. */
  fromEnds?: LengthText
  /** piece: runs longer than this take `qtyOver` instead of `qty`. */
  over?: LengthText
  qtyOver?: number
  /** edge: sold in this length, each edge rounded up on its own. Absent: linear feet. */
  stock?: LengthText
  unit?: string
}

export interface HardwareLayer extends LayerBase {
  kind: 'hardware'
  items: HardwareItem[]
}

export type PatternLayer = TilesLayer | MembersLayer | LinesLayer | BuiltInLayer | HardwareLayer

export interface PatternRecipe {
  version: 1
  name: string
  description?: string
  status: PatternStatus
  /** Who made it, e.g. "Claude" or "ChatGPT · Nokia takeoff". */
  source?: string
  /** Plain numbers in tiles and members are in this unit. Default in. */
  units?: LengthUnit
  /**
   * How far off a module line an area edge may be drawn and still count as
   * ON it (NOIC, 2026-11-26): an area drawn exactly N modules wide counted
   * slivers, and one a hair smaller cut its whole last row. Default 1".
   */
  edgeSnap?: LengthText
  /** Set when it came from, or went to, the library. */
  libraryId?: string
  libraryVersion?: number
  approvedBy?: string
  approvedAt?: string
  layers: PatternLayer[]
}

// ---------------------------------------------------------------------------
// Resolved form: every length in FEET, every check passed.
// ---------------------------------------------------------------------------

export interface ResolvedModule { along: number; across: number; shift: number }

export interface ResolvedTile {
  name: string
  points: Point[]
  area: number
  /** Feet: the longest side, the edge a sliver strip runs along. */
  span: number
}

export interface ResolvedMember { along: number; across: number; length: number }

interface ResolvedBase { id: string; name: string; draft: boolean }

export interface ResolvedRunMaterial {
  width: number
  stock: number
  partLength: number
  yield: YieldRule
}

export type ResolvedLayer =
  | (ResolvedBase & { kind: 'tiles'; module: ResolvedModule; tiles: ResolvedTile[]; joint: number; cuts: CutRule })
  | (ResolvedBase & { kind: 'members'; module: ResolvedModule; members: ResolvedMember[] } & ResolvedRunMaterial)
  | (ResolvedBase & { kind: 'lines'; run: 'along' | 'across'; spacing: number; offset: number } & ResolvedRunMaterial)
  | (ResolvedBase & { kind: BuiltInLayerKind; specifications: Record<string, unknown> })
  | (ResolvedBase & { kind: 'hardware'; items: ResolvedHardware[] })

export interface ResolvedHardware {
  name: string
  per: HardwarePer
  of: string[]
  qty: number
  every: number
  fromEnds: number
  over: number
  qtyOver: number
  stock: number
  unit: string
}

export interface ResolvedRecipe {
  name: string
  draft: boolean
  layers: ResolvedLayer[]
  /** Feet. A piece narrower than this at an area edge is a sliver and dropped; one missing less than this is whole. */
  edgeSnap: number
}

/** 1 inch: hand-drawn area edges land within it of the grid they were drawn to. */
export const DEFAULT_EDGE_SNAP_FEET = 1 / 12

export type RecipeCheck =
  | { ok: true; recipe: PatternRecipe; resolved: ResolvedRecipe; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A length in feet, or null when it is not one. Numbers are in `units`. */
export function lengthToFeet(value: unknown, units: LengthUnit = 'in'): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    return unitToFeet(value, units)
  }
  if (typeof value !== 'string') return null
  const parsed = parseLengthInput(value, units)
  if (parsed === null) return null
  return parsed.unit === 'ft' && parsed.explicit ? parsed.value : unitToFeet(parsed.value, parsed.unit)
}

/** A slug for ids and library keys: lower case, dashes. */
export function slugOf(text: string): string {
  const s = text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return s.length > 0 ? s : 'pattern'
}

function isConvex(points: readonly Point[]): boolean {
  const n = points.length
  if (n < 3) return false
  let sign = 0
  for (let i = 0; i < n; i++) {
    const a = points[i]!, b = points[(i + 1) % n]!, c = points[(i + 2) % n]!
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    if (Math.abs(cross) < 1e-12) continue
    const s = Math.sign(cross)
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return sign !== 0
}

/**
 * Check a recipe and resolve it to feet.
 *
 * Every refusal says what to change, in the words an agent writes the recipe
 * in, because the agent is the one reading it: "tile 2 of layer panels is not
 * convex: split it into two tiles" rather than "invalid geometry".
 */
export function checkPatternRecipe(raw: unknown): RecipeCheck {
  const errors: string[] = []
  const warnings: string[] = []
  let input = raw
  if (typeof input === 'string') {
    try { input = JSON.parse(input) } catch { return { ok: false, errors: ['the recipe is not valid JSON'], warnings } }
  }
  if (!isRecord(input)) return { ok: false, errors: ['a recipe is an object with name and layers'], warnings }

  const name = typeof input['name'] === 'string' ? input['name'].trim() : ''
  if (name === '') errors.push('name: give the pattern a name, e.g. "Triangle panel 48\\""')
  const unitsRaw = input['units']
  const units: LengthUnit = typeof unitsRaw === 'string' && isLengthUnit(unitsRaw) ? unitsRaw : 'in'
  if (unitsRaw !== undefined && !(typeof unitsRaw === 'string' && isLengthUnit(unitsRaw))) {
    errors.push(`units: "${String(unitsRaw)}" is not one of in, ft, mm, cm, m`)
  }
  const status: PatternStatus = input['status'] === 'approved' ? 'approved' : 'draft'
  const layersRaw = input['layers']
  if (!Array.isArray(layersRaw) || layersRaw.length === 0) {
    errors.push('layers: a recipe needs at least one layer (tiles, members, lines, or a built-in product)')
    return { ok: false, errors, warnings }
  }

  const ids = new Set<string>()
  const resolved: ResolvedLayer[] = []
  const layers: PatternLayer[] = []
  const len = (where: string, v: unknown, opts: { required?: boolean; positive?: boolean; fallback?: number } = {}): number => {
    if (v === undefined || v === null || v === '') {
      if (opts.required === true) errors.push(`${where}: required`)
      return opts.fallback ?? 0
    }
    const feet = lengthToFeet(v, units)
    if (feet === null) { errors.push(`${where}: "${String(v)}" is not a length (try "48", "4'", "4' 6\\"" or "1200 mm")`); return 0 }
    if (opts.positive === true && !(feet > 0)) { errors.push(`${where}: must be more than zero`); return 0 }
    if (feet < 0) { errors.push(`${where}: must not be negative`); return 0 }
    return feet
  }
  const mod = (where: string, v: unknown): ResolvedModule => {
    if (!isRecord(v)) { errors.push(`${where}.module: give {along, across} and, for staggered rows, shift`); return { along: 0, across: 0, shift: 0 } }
    const along = len(`${where}.module.along`, v['along'], { required: true, positive: true })
    const across = len(`${where}.module.across`, v['across'], { required: true, positive: true })
    const shift = v['shift'] === undefined ? 0 : (lengthToFeet(v['shift'], units) ?? (errors.push(`${where}.module.shift: not a length`), 0))
    return { along, across, shift }
  }
  const material = (where: string, l: Record<string, unknown>): ResolvedRunMaterial => {
    const y = l['yield']
    if (y !== undefined && y !== 'full' && y !== 'half' && y !== 'quarter') errors.push(`${where}.yield: full, half or quarter`)
    const stock = len(`${where}.stock`, l['stock'], { positive: l['stock'] !== undefined })
    const partLength = len(`${where}.partLength`, l['partLength'], { positive: l['partLength'] !== undefined })
    if (stock > 0 && partLength > 0) errors.push(`${where}: give stock (cut and nested) or partLength (whole parts), not both`)
    return {
      width: len(`${where}.width`, l['width']),
      stock,
      partLength,
      yield: y === 'half' || y === 'quarter' ? y : 'full',
    }
  }

  layersRaw.forEach((lr, index) => {
    const where0 = `layer ${index + 1}`
    if (!isRecord(lr)) { errors.push(`${where0}: a layer is an object with id and kind`); return }
    const kind = lr['kind']
    const id = typeof lr['id'] === 'string' && lr['id'].trim() !== '' ? lr['id'].trim() : `layer${index + 1}`
    const where = `layer ${id}`
    if (ids.has(id)) errors.push(`${where}: two layers share the id "${id}"`)
    ids.add(id)
    if (typeof kind !== 'string' || !(LAYER_KINDS as readonly string[]).includes(kind)) {
      errors.push(`${where}.kind: "${String(kind)}" is not one of ${LAYER_KINDS.join(', ')}`)
      return
    }
    const layerName = typeof lr['name'] === 'string' && lr['name'].trim() !== '' ? lr['name'].trim() : defaultLayerName(kind as LayerKind, id)
    const draft = lr['status'] === 'draft' || (lr['status'] === undefined && status === 'draft')
    const base = { id, name: layerName, draft }
    layers.push({ ...(lr as unknown as PatternLayer), id })

    switch (kind) {
      case 'tiles': {
        const m = mod(where, lr['module'])
        const tilesRaw = lr['tiles']
        if (!Array.isArray(tilesRaw) || tilesRaw.length === 0) { errors.push(`${where}.tiles: list at least one tile, each {name, points: [[along, across], ...]}`); return }
        const tiles: ResolvedTile[] = []
        tilesRaw.forEach((t, ti) => {
          const tw = `${where} tile ${ti + 1}`
          if (!isRecord(t) || !Array.isArray(t['points'])) { errors.push(`${tw}: give points: [[along, across], ...]`); return }
          const pts: Point[] = []
          for (const p of t['points'] as unknown[]) {
            if (!Array.isArray(p) || p.length !== 2) { errors.push(`${tw}: each point is [along, across]`); return }
            const a = lengthToFeet(p[0], units), b = lengthToFeet(p[1], units)
            if (a === null || b === null) { errors.push(`${tw}: [${String(p[0])}, ${String(p[1])}] is not two lengths`); return }
            pts.push({ x: a, y: b })
          }
          if (pts.length < 3) { errors.push(`${tw}: needs three corners or more`); return }
          if (!isConvex(pts)) { errors.push(`${tw}: is not convex. Split it into convex tiles with the same name (an L is two rectangles)`); return }
          const area = Math.abs(signedPolygonArea(pts))
          tiles.push({ name: typeof t['name'] === 'string' && t['name'].trim() !== '' ? t['name'].trim() : layerName, points: pts, area, span: Math.max(...pts.map((p, k) => { const q = pts[(k + 1) % pts.length]!; return Math.hypot(q.x - p.x, q.y - p.y) })) })
        })
        if (m.along > 0 && m.across > 0 && tiles.length > 0) {
          const covered = tiles.reduce((s, t) => s + t.area, 0)
          const moduleArea = m.along * m.across
          if (covered > moduleArea * 1.02) warnings.push(`${where}: the tiles cover ${Math.round(covered / moduleArea * 100)}% of one module, so they overlap the next one. Check module along/across.`)
          if (covered < moduleArea * 0.5) warnings.push(`${where}: the tiles cover ${Math.round(covered / moduleArea * 100)}% of one module; the rest is open. Fine for coffers in every other cell, otherwise check the module.`)
        }
        const cuts = lr['cuts']
        if (cuts !== undefined && cuts !== 'whole' && cuts !== 'halves' && cuts !== 'nest') errors.push(`${where}.cuts: whole, halves or nest`)
        resolved.push({ ...base, kind: 'tiles', module: m, tiles, joint: len(`${where}.joint`, lr['joint']), cuts: cuts === 'halves' || cuts === 'nest' ? cuts : 'whole' })
        return
      }
      case 'members': {
        const m = mod(where, lr['module'])
        const membersRaw = lr['members']
        if (!Array.isArray(membersRaw) || membersRaw.length === 0) { errors.push(`${where}.members: list at least one, each {along, across, length}`); return }
        const members: ResolvedMember[] = []
        membersRaw.forEach((mr, mi) => {
          const mw = `${where} member ${mi + 1}`
          if (!isRecord(mr)) { errors.push(`${mw}: give {along, across, length}`); return }
          const a = lengthToFeet(mr['along'] ?? 0, units)
          const b = lengthToFeet(mr['across'], units)
          const l = lengthToFeet(mr['length'], units)
          if (a === null || b === null || l === null || !(l > 0)) { errors.push(`${mw}: along, across and a length above zero`); return }
          members.push({ along: a, across: b, length: l })
        })
        if (m.across > 0) {
          const outside = members.filter((x) => x.across < 0 || x.across >= m.across + 1e-9).length
          if (outside > 0) warnings.push(`${where}: ${outside} member(s) sit outside the module across; they will overlap the next row`)
        }
        resolved.push({ ...base, kind: 'members', module: m, members, ...material(where, lr) })
        return
      }
      case 'lines': {
        const run = lr['run']
        if (run !== 'along' && run !== 'across') errors.push(`${where}.run: along (with the pattern) or across (perpendicular to it)`)
        resolved.push({
          ...base, kind: 'lines', run: run === 'across' ? 'across' : 'along',
          spacing: len(`${where}.spacing`, lr['spacing'], { required: true, positive: true }),
          offset: lengthToFeet(lr['offset'] ?? 0, units) ?? 0,
          ...material(where, lr),
        })
        return
      }
      case 'hardware': {
        const itemsRaw = lr['items']
        if (!Array.isArray(itemsRaw) || itemsRaw.length === 0) { errors.push(`${where}.items: list at least one, each {name, per, of, qty}`); return }
        const items: ResolvedHardware[] = []
        itemsRaw.forEach((ir, ii) => {
          const iw = `${where} item ${ii + 1}`
          if (!isRecord(ir)) { errors.push(`${iw}: give {name, per, of, qty}`); return }
          const iname = typeof ir['name'] === 'string' ? ir['name'].trim() : ''
          if (iname === '') errors.push(`${iw}.name: required`)
          const per = ir['per']
          if (typeof per !== 'string' || !(HARDWARE_PER as readonly string[]).includes(per)) {
            errors.push(`${iw}.per: one of ${HARDWARE_PER.join(', ')}`)
            return
          }
          const ofRaw = ir['of']
          const of = Array.isArray(ofRaw) ? ofRaw.map(String) : typeof ofRaw === 'string' ? [ofRaw] : []
          if (per === 'crossing' && of.length !== 2) errors.push(`${iw}.of: a crossing names two layers, e.g. ["rails", "panels"]`)
          if (per !== 'crossing' && per !== 'edge' && per !== 'area' && of.length === 0) errors.push(`${iw}.of: name the layer it is counted on, or a list of layers to count on each`)
          const qty = ir['qty'] === undefined ? 1 : Number(ir['qty'])
          if (!Number.isFinite(qty) || qty < 0) errors.push(`${iw}.qty: a number`)
          let every = 0
          if (per === 'area') {
            every = Number(ir['every'] ?? 0)
            if (!(every > 0)) errors.push(`${iw}.every: square feet each one serves, e.g. 16`)
          } else if (per === 'along') {
            every = len(`${iw}.every`, ir['every'], { required: true, positive: true })
          }
          const qtyOver = ir['qtyOver'] === undefined ? qty : Number(ir['qtyOver'])
          items.push({
            name: iname, per: per as HardwarePer, of, qty: Number.isFinite(qty) ? qty : 0, every,
            fromEnds: len(`${iw}.fromEnds`, ir['fromEnds']),
            over: len(`${iw}.over`, ir['over']),
            qtyOver: Number.isFinite(qtyOver) ? qtyOver : qty,
            stock: len(`${iw}.stock`, ir['stock']),
            unit: typeof ir['unit'] === 'string' && ir['unit'].trim() !== '' ? ir['unit'].trim() : (per === 'edge' && ir['stock'] === undefined ? 'LF' : 'EA'),
          })
        })
        resolved.push({ ...base, kind: 'hardware', items })
        return
      }
      default: {
        const specs = lr['specifications']
        if (!isRecord(specs)) { errors.push(`${where}.specifications: the same keys a ${kind} scope takes (describe_product lists them)`); return }
        resolved.push({ ...base, kind: kind as BuiltInLayerKind, specifications: specs })
      }
    }
  })

  // Hardware must name layers that exist and can carry what it counts.
  const kindOf = new Map(resolved.map((l) => [l.id, l.kind]))
  for (const l of resolved) {
    if (l.kind !== 'hardware') continue
    for (const it of l.items) {
      for (const ref of it.of) {
        const k = kindOf.get(ref)
        if (k === undefined) { errors.push(`layer ${l.id} item ${it.name}: no layer "${ref}" (layers: ${[...kindOf.keys()].join(', ')})`); continue }
        if (k === 'hardware') errors.push(`layer ${l.id} item ${it.name}: "${ref}" is hardware; count on a material layer`)
        const runs = k === 'members' || k === 'lines' || k === 'planks' || k === 'baffle' || k === 'linear_parts'
        if (it.per === 'along' && !runs) errors.push(`layer ${l.id} item ${it.name}: per along needs a layer of runs (members, lines, planks, baffle)`)
        if (it.per === 'joint' && k !== 'members' && k !== 'lines') errors.push(`layer ${l.id} item ${it.name}: per joint needs a members or lines layer with stock (a built-in baffle or plank counts its own joiners)`)
        if (it.per === 'module' && k !== 'tiles' && k !== 'members') errors.push(`layer ${l.id} item ${it.name}: per module needs a tiles or members layer`)
      }
      if (it.per === 'crossing' && it.of.length === 2) {
        const k0 = kindOf.get(it.of[0]!)
        if (k0 === 'tiles' || k0 === 'panels' || k0 === 'baffle_cassette') errors.push(`layer ${l.id} item ${it.name}: put the runs first in "of", e.g. ["rails", "${it.of[0]}"]`)
      }
    }
  }
  if (!resolved.some((l) => l.kind !== 'hardware')) errors.push('layers: hardware needs a material layer to count on')

  const snapRaw = input['edgeSnap']
  let edgeSnap = DEFAULT_EDGE_SNAP_FEET
  if (snapRaw !== undefined) {
    const f = lengthToFeet(snapRaw, units)
    if (f === null || !(f >= 0)) errors.push(`edgeSnap: "${String(snapRaw)}" is not a length (0 turns the snap off)`)
    else edgeSnap = f
  }
  if (errors.length > 0) return { ok: false, errors, warnings }
  const recipe: PatternRecipe = {
    version: 1,
    name,
    status,
    ...(typeof input['description'] === 'string' ? { description: input['description'] } : {}),
    ...(typeof input['source'] === 'string' ? { source: input['source'] } : {}),
    ...(unitsRaw !== undefined ? { units } : {}),
    ...(snapRaw !== undefined && (typeof snapRaw === 'number' || typeof snapRaw === 'string') ? { edgeSnap: snapRaw } : {}),
    ...(typeof input['libraryId'] === 'string' ? { libraryId: input['libraryId'] } : {}),
    ...(typeof input['libraryVersion'] === 'number' ? { libraryVersion: input['libraryVersion'] } : {}),
    ...(typeof input['approvedBy'] === 'string' ? { approvedBy: input['approvedBy'] } : {}),
    ...(typeof input['approvedAt'] === 'string' ? { approvedAt: input['approvedAt'] } : {}),
    layers,
  }
  return { ok: true, recipe, resolved: { name, draft: resolved.some((l) => l.draft), layers: resolved, edgeSnap }, warnings }
}

export function defaultLayerName(kind: LayerKind, id: string): string {
  switch (kind) {
    case 'panels': return 'Panels'
    case 'planks': return 'Planks'
    case 'baffle': return 'Baffles'
    case 'baffle_cassette': return 'Cassettes'
    case 'linear_parts': return 'Linear parts'
    case 'hardware': return 'Hardware'
    default: return id.charAt(0).toUpperCase() + id.slice(1)
  }
}

/** The recipe on a scope's specification, or null. Never throws: a bad recipe is a blocker, not a crash. */
export function readPatternRecipe(specs: Record<string, unknown>): unknown {
  const v = specs[PATTERN_RECIPE_KEY]
  if (v === undefined || v === null) return null
  if (typeof v === 'string') { try { return JSON.parse(v) } catch { return v } }
  return v
}

/** Approve a recipe: every layer, and the whole. Only a person does this (the bridge has no way to). */
export function approvePatternRecipe(recipe: PatternRecipe, by: string, at: string): PatternRecipe {
  return {
    ...recipe,
    status: 'approved',
    approvedBy: by,
    approvedAt: at,
    layers: recipe.layers.map((l) => {
      const { status: _s, ...rest } = l as PatternLayer & { status?: PatternStatus }
      void _s
      return rest as PatternLayer
    }),
  }
}

/** Approve one layer an agent added to an approved pattern. */
export function approvePatternLayer(recipe: PatternRecipe, layerId: string): PatternRecipe {
  return {
    ...recipe,
    layers: recipe.layers.map((l) => (l.id === layerId ? { ...l, status: 'approved' as const } : l)),
  }
}

/** Drop a layer (and hardware items that counted on it). */
export function removePatternLayer(recipe: PatternRecipe, layerId: string): PatternRecipe {
  const layers = recipe.layers
    .filter((l) => l.id !== layerId)
    .map((l) => (l.kind === 'hardware'
      ? { ...l, items: l.items.filter((it) => !(Array.isArray(it.of) ? it.of : it.of === undefined ? [] : [it.of]).includes(layerId)) }
      : l))
    .filter((l) => l.kind !== 'hardware' || l.items.length > 0)
  return { ...recipe, layers }
}

/** Layers still waiting for a person. */
export function draftLayers(recipe: PatternRecipe): PatternLayer[] {
  if (recipe.status === 'draft') return recipe.layers
  return recipe.layers.filter((l) => l.status === 'draft')
}

// ---------------------------------------------------------------------------
// The format, for an agent: describe_product custom_pattern returns this.
// ---------------------------------------------------------------------------

export const PATTERN_EXAMPLES: Record<string, PatternRecipe> = {
  triangles: {
    version: 1,
    name: 'Triangle panel 48"',
    status: 'draft',
    units: 'in',
    layers: [{
      id: 'panels', kind: 'tiles', name: 'Triangle panels',
      module: { along: 48, across: 41.569, shift: 24 },
      tiles: [
        { name: 'Triangle panel', points: [[0, 0], [48, 0], [24, 41.569]] },
        { name: 'Triangle panel', points: [[24, 41.569], [48, 0], [72, 41.569]] },
      ],
      joint: '1/4"',
      cuts: 'whole',
    }, {
      id: 'hardware', kind: 'hardware',
      items: [{ name: 'Perimeter trim', per: 'edge', stock: "12'" }],
    }],
  },
  randomBaffles: {
    version: 1,
    name: 'Random baffle module',
    status: 'draft',
    units: 'in',
    layers: [{
      id: 'baffles', kind: 'members', name: 'Baffles',
      module: { along: 126, across: 96 },
      members: [
        { along: 0, across: 5, length: 74 },
        { along: 30, across: 16, length: 56 },
        { along: 12, across: 27, length: 90 },
        { along: 48, across: 38, length: 60 },
      ],
      width: 2,
      stock: "12'",
    }, {
      id: 'hardware', kind: 'hardware',
      items: [
        { name: 'End caps', per: 'piece', of: 'baffles', qty: 2 },
        { name: 'Hangers', per: 'piece', of: 'baffles', qty: 2, over: "6'", qtyOver: 3 },
      ],
    }],
  },
  panelsOnRails: {
    version: 1,
    name: 'Panels on suspension rails',
    status: 'draft',
    layers: [
      { id: 'panels', kind: 'panels', specifications: { panelWidth: '24', panelWidthUnit: 'in', panelLength: '48', panelLengthUnit: 'in' } },
      { id: 'rails', kind: 'lines', name: 'Suspension rails', run: 'across', spacing: '48', stock: "16'" },
      {
        id: 'hardware', kind: 'hardware',
        items: [
          { name: 'Panel clips', per: 'crossing', of: ['rails', 'panels'], qty: 2 },
          { name: 'Hangers', per: 'along', of: 'rails', every: "4'", fromEnds: "1'" },
          { name: 'Rail splices', per: 'joint', of: 'rails' },
        ],
      },
    ],
  },
  openCellWithCoffers: {
    version: 1,
    name: 'Open cell 24" with coffers',
    status: 'draft',
    units: 'in',
    layers: [
      { id: 'mains', kind: 'lines', name: 'Mains', run: 'along', spacing: 24, stock: "10'" },
      { id: 'tees', kind: 'lines', name: 'Cross tees', run: 'across', spacing: 24, partLength: 24 },
      {
        id: 'coffers', kind: 'tiles', name: 'Coffer panels',
        module: { along: 48, across: 48 },
        tiles: [
          { name: 'Coffer', points: [[1, 1], [23, 1], [23, 23], [1, 23]] },
          { name: 'Coffer', points: [[25, 25], [47, 25], [47, 47], [25, 47]] },
        ],
      },
      {
        id: 'hardware', kind: 'hardware',
        items: [
          { name: 'Hangers', per: 'along', of: 'mains', every: "4'" },
          { name: 'Main splices', per: 'joint', of: 'mains' },
          { name: 'Hold-down clips', per: 'piece', of: 'coffers', qty: 4 },
          { name: 'Wall angle', per: 'edge', stock: "12'" },
        ],
      },
    ],
  },
}

export const PATTERN_FORMAT = {
  summary: 'A custom pattern is a recipe: layers laid on the same area, sharing the scope\'s direction and origin, each counted on its own. '
    + 'Save it on a scope with redbeam_save_pattern (it shows on the sheet and counts at once, marked draft) and check it with redbeam_get_bom and redbeam_screenshot. '
    + 'A person approves it in the app; agents cannot.',
  coordinates: '"along" is the scope\'s pattern direction (set_pattern_direction), "across" is perpendicular. Tile points are [along, across]. '
    + 'Plain numbers are in `units` (in by default); text is a length ("48", "4\'", "4\' 6\\"", "1200 mm"). The pattern starts at the area\'s origin (set_pattern_origin) or, by default, at its corner.',
  recipe: '{ name, units?, description?, edgeSnap?, layers: [...] }',
  edgeSnap: 'How far off a module line an area edge may be drawn and still count as on it (default 1"). A tile or member piece narrower than this at an edge is a sliver and is not counted; one short of whole by less than this counts whole. 0 turns it off.',
  layers: {
    tiles: '{ id, kind:"tiles", name?, module:{along, across, shift?}, tiles:[{name?, points:[[along,across],...]}], joint?, cuts?:"whole"|"halves"|"nest" }. '
      + 'One module repeats along and across; each next row slides `shift` along (half the module for triangles, hexagons, running bond). '
      + 'Tiles must be convex: give an L or chevron as two tiles with the same name. Several tiles with different names count separately. '
      + 'Leave cells empty for coffers in every other cell (a 2x2 module with two tiles). cuts: whole = every cut piece is a tile (default); halves = a cut piece of half or less is half a tile; nest = cut pieces share tiles by area.',
    members: '{ id, kind:"members", name?, module:{along, across, shift?}, members:[{along, across, length}], width?, stock? | partLength?, yield? }. '
      + 'Runs at set places in one module, repeated: a "random" baffle field that is really one module tiled. Each member starts at `along`, sits at `across`, and runs `length` along. '
      + 'stock: cut from this length with offcuts nested; partLength: each run in whole parts; neither: counted and measured only.',
    lines: '{ id, kind:"lines", name?, run:"along"|"across", spacing, offset?, width?, stock? | partLength?, yield? }. '
      + 'Runs at a spacing across the whole area: suspension rails (run across the panels), open cell mains (along) and cross tees (across, partLength = the cell).',
    'panels|planks|baffle|baffle_cassette|linear_parts': '{ id, kind:"panels", specifications:{ panelWidth:"24", panelWidthUnit:"in", ... } }. '
      + 'A built-in product as a layer, counted exactly as a scope of that product is (describe_product lists its keys). Use it to put rails or hardware on a standard product.',
    hardware: '{ id, kind:"hardware", items:[{ name, per, of?, qty?, every?, fromEnds?, over?, qtyOver?, stock?, unit? }] }.',
  },
  hardwarePer: {
    piece: 'qty per piece of layer `of` (each tile, each installed run piece). over/qtyOver: runs longer than `over` take qtyOver (2 hangers under 6\', else 3).',
    module: 'qty per module of a tiles or members layer that lands in the area.',
    along: 'along each run of layer `of`: one every `every`, the first and last `fromEnds` in from the ends.',
    joint: 'qty per joint between stock lengths in a run of layer `of` (splices).',
    crossing: 'qty where a run of the first layer in `of` crosses an edge or run of the second: ["rails","panels"] counts clips at every panel joint a rail crosses.',
    edge: 'along the area edge: with stock, pieces per edge rounded up each (trim, wall angle); without, linear feet.',
    area: 'one per `every` square feet of area, times qty.',
  },
  examples: PATTERN_EXAMPLES,
} as const

/** The refusal in one line, field first, for an `error` string a client may show alone (700 Bay, 2026-11-27). */
export function recipeErrorLine(errors: readonly string[]): string {
  if (errors.length === 0) return 'no detail (report this)'
  return errors.length === 1 ? errors[0]! : `${errors[0]} (and ${errors.length - 1} more: see errors)`
}
