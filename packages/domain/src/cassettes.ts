/**
 * Baffle cassettes, counted as built (Coinbase blind test, 2026-11-27,
 * #174-#177).
 *
 * A cassette is a module: `cassetteWidth` across its baffles by
 * `cassetteLength` along them (the baffle stock length when no length is
 * given), laid on a grid whose pitch adds `cassetteGap` both ways. Every
 * module the field covers completely is a FULL cassette. A module the field
 * only partly covers is a PARTIAL cassette, built to fit: its baffles are cut
 * to the length the field gives each of them, and the scope's yield
 * (full/half/quarter of a stock length) is applied to those cuts. A module
 * with no baffle inside the field is not a cassette at all.
 *
 * Until 0.3.123 every module the field touched was counted as a full one:
 * 403 cassettes against 287 by area, and about 200 baffles too many.
 *
 * Perimeter trim is reported in feet, and in pieces only when the scope says
 * how long a trim piece is (`perimeterTrimLength`). It used to be cut at the
 * cassette width and reported as "818 EA", which nobody can price.
 */
import type { Point, Region } from './geometry.js'
import { regionArea } from './geometry.js'
import { layoutPanels, orderStockPieceCount, roundUpQuantity, type PanelCell, type PanelLayoutGroup } from './panels.js'
import { pointInRegion } from './pattern.js'
import { allowedPieceFractions, roundStockFractionToAllowed } from './pieces.js'
import { measureToFeet, readString, type Specifications } from './specs.js'
import { regionPerimeterPoints } from './runs.js'
import type { PieceQuantity } from './takeoff.js'

export interface CassetteInputs {
  widthFeet: number
  lengthFeet: number
  gapFeet: number
  spacingFeet: number
  stockLengthFeet: number
  yieldGranularity: string
  /** Share of cassettes that are removable (access), 0..1. */
  removableShare: number
  trimLengthFeet: number | null
}

const measure = (specs: Specifications, key: string, label: string): number | null =>
  measureToFeet(specs, { valueKey: key, unitKey: `${key}Unit`, label })

/** A percent ("10", "10%") or a fraction ("0.1") as 0..1; 0 when absent or unusable. */
export function readShare(specs: Specifications, key: string): number {
  const raw = (readString(specs, key) ?? '').trim().replace(/%$/, '').trim()
  if (raw === '') return 0
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(1, n > 1 ? n / 100 : n)
}

/** The scope's cassette inputs, or the labels of what is missing. */
export function readCassetteInputs(specs: Specifications): CassetteInputs | { missing: string[] } {
  const width = measure(specs, 'cassetteWidth', 'Cassette W')
  const stock = measure(specs, 'stockLength', 'Stock')
  const spacing = measure(specs, 'spacing', 'Spacing OC')
  const missing = [
    ...(spacing === null ? ['Spacing OC'] : []),
    ...(stock === null ? ['Stock'] : []),
    ...(width === null ? ['Cassette W'] : []),
  ]
  if (width === null || stock === null || spacing === null) return { missing }
  return {
    widthFeet: width,
    lengthFeet: measure(specs, 'cassetteLength', 'Cassette L') ?? stock,
    gapFeet: measure(specs, 'cassetteGap', 'Cassette gap') ?? 0,
    spacingFeet: spacing,
    stockLengthFeet: stock,
    yieldGranularity: readString(specs, 'yieldGranularity') ?? 'full',
    removableShare: readShare(specs, 'removableShare'),
    trimLengthFeet: measure(specs, 'perimeterTrimLength', 'Trim Len'),
  }
}

export interface CassetteWidthAdvice {
  /** Baffles one cassette holds: the width over the spacing, rounded down. */
  bafflesPerCassette: number
  /** Whether the width is a whole number of spacings. */
  wholeMultiple: boolean
  /** The nearest whole multiples of the spacing below and above, feet. */
  belowFeet: number
  aboveFeet: number
}

/**
 * Cassette width against the spacing (#176). A cassette holds whole baffles,
 * so its width is a whole number of spacings: 22½" or 30" at 7½", not 24".
 */
export function cassetteWidthAdvice(widthFeet: number, spacingFeet: number): CassetteWidthAdvice {
  const ratio = widthFeet / spacingFeet
  const nearest = Math.round(ratio)
  const whole = nearest >= 1 && Math.abs(ratio - nearest) * spacingFeet < 1 / 96 // within 1/8"
  const below = Math.max(1, Math.floor(ratio + 1e-9))
  const above = Math.max(below + (whole ? 0 : 1), Math.ceil(ratio - 1e-9))
  return {
    bafflesPerCassette: whole ? nearest : Math.max(1, Math.floor(ratio + 1e-9)),
    wholeMultiple: whole,
    belowFeet: below * spacingFeet,
    aboveFeet: above * spacingFeet,
  }
}

export interface CassetteModule {
  pageId?: string
  /** The module's four corners, PDF points: start of the width, along the length. */
  path: Point[]
  partial: boolean
  /** Each baffle piece's length inside the field, feet, in order across the module. Absent baffles are left out; a baffle a hole crosses is two pieces. */
  baffleFeet: number[]
}

export interface CassetteLayout {
  inputs: CassetteInputs
  modules: CassetteModule[]
  /** The pitch cells laid out (for the preview), one per module. */
  cells: PanelCell[]
  bafflesPerCassette: number
  fieldSquareFeet: number
  perimeterFeet: number
  warnings: string[]
}

const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y })
const addScaled = (a: Point, d: Point, t: number): Point => ({ x: a.x + d.x * t, y: a.y + d.y * t })

/** Length of segment a→b inside `region` (holes respected), in the segment's own units. */
export function lengthInside(a: Point, b: Point, region: Region): number {
  return spansInside(a, b, region).reduce((t, x) => t + x, 0)
}

/** The lengths of the pieces of segment a→b inside `region`: a hole across it makes two. */
export function spansInside(a: Point, b: Point, region: Region): number[] {
  const d = sub(b, a)
  const len = Math.hypot(d.x, d.y)
  if (!(len > 0)) return []
  const ts: number[] = [0, 1]
  for (const ring of region) {
    if (ring.length < 3) continue
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]!
      const q = ring[(i + 1) % ring.length]!
      const e = sub(q, p)
      const den = d.x * e.y - d.y * e.x
      if (Math.abs(den) < 1e-12) continue
      const w = sub(p, a)
      const t = (w.x * e.y - w.y * e.x) / den
      const u = (w.x * d.y - w.y * d.x) / den
      if (t > 0 && t < 1 && u >= -1e-9 && u <= 1 + 1e-9) ts.push(t)
    }
  }
  ts.sort((x, y) => x - y)
  const spans: number[] = []
  let open = false
  for (let i = 1; i < ts.length; i++) {
    const t0 = ts[i - 1]!, t1 = ts[i]!
    if (t1 - t0 < 1e-12) continue
    const inside = pointInRegion(addScaled(a, d, (t0 + t1) / 2), region)
    if (inside && open) spans[spans.length - 1]! += (t1 - t0) * len
    else if (inside) spans.push((t1 - t0) * len)
    open = inside
  }
  return spans
}

/**
 * Lay a cassette scope's areas out and find each module's baffles. Groups
 * are laid out one at a time so every baffle is measured at its own sheet's
 * scale.
 */
export function layoutCassettes(
  groups: readonly PanelLayoutGroup[],
  inputs: CassetteInputs,
  opts: { feetPerPoint: number; perAreaOrigin?: boolean; edgeSnapFeet?: number },
): CassetteLayout {
  const advice = cassetteWidthAdvice(inputs.widthFeet, inputs.spacingFeet)
  const per = advice.bafflesPerCassette
  const warnings: string[] = []
  if (!advice.wholeMultiple) {
    warnings.push(`Cassette W ${inches(inputs.widthFeet)} is not a whole number of ${inches(inputs.spacingFeet)} spacings, so each cassette holds ${per} baffles; `
      + `${inches(advice.belowFeet)} or ${inches(advice.aboveFeet)} would fit whole baffles.`)
  }
  const modules: CassetteModule[] = []
  const cells: PanelCell[] = []
  let fieldSquareFeet = 0
  let perimeterFeet = 0
  for (const group of groups) {
    const fpp = group.feetPerPoint ?? opts.feetPerPoint
    if (!(fpp > 0)) continue
    fieldSquareFeet += regionArea(group.region) * fpp * fpp
    perimeterFeet += regionPerimeterPoints(group.region) * fpp
    const laid = layoutPanels([group], {
      panelWidthFeet: inputs.widthFeet + inputs.gapFeet,
      panelLengthFeet: inputs.lengthFeet + inputs.gapFeet,
      feetPerPoint: fpp,
      panelGranularity: 'full',
      ...(opts.perAreaOrigin === true ? { perAreaOrigin: true } : {}),
      ...(opts.edgeSnapFeet !== undefined ? { edgeSnapFeet: opts.edgeSnapFeet } : {}),
    })
    const lengthPts = inputs.lengthFeet / fpp
    const widthPts = inputs.widthFeet / fpp
    const spacingPts = inputs.spacingFeet / fpp
    // A baffle short of its full length by more than this is a cut one.
    const tolerancePts = Math.max(0.5, (1 / 16 / 12) / fpp)
    for (const cell of laid.cells) {
      const [p0, p1, , p3] = cell.fullPath
      if (p0 === undefined || p1 === undefined || p3 === undefined) continue
      const alongLen = Math.hypot(p1.x - p0.x, p1.y - p0.y)
      const acrossLen = Math.hypot(p3.x - p0.x, p3.y - p0.y)
      if (!(alongLen > 0) || !(acrossLen > 0)) continue
      const dir = { x: (p1.x - p0.x) / alongLen, y: (p1.y - p0.y) / alongLen }
      const nrm = { x: (p3.x - p0.x) / acrossLen, y: (p3.y - p0.y) / acrossLen }
      // Baffles sit at half a spacing in from the module's edge, a spacing apart,
      // centred across the module when the width is not a whole number of them.
      const firstOffset = (widthPts - (per - 1) * spacingPts) / 2
      const baffleFeet: number[] = []
      let partial = false
      for (let i = 0; i < per; i++) {
        const start = addScaled(p0, nrm, firstOffset + i * spacingPts)
        const end = addScaled(start, dir, lengthPts)
        // A hole across a baffle's line leaves two pieces, each cut to fit.
        const spans = spansInside(start, end, group.region).filter((x) => x > tolerancePts)
        if (spans.length !== 1 || spans[0]! < lengthPts - tolerancePts) partial = true
        for (const x of spans) baffleFeet.push(x * fpp)
      }
      if (baffleFeet.length === 0) continue
      const path = [p0, addScaled(p0, dir, lengthPts), addScaled(addScaled(p0, dir, lengthPts), nrm, widthPts), addScaled(p0, nrm, widthPts)]
      modules.push({ ...(cell.pageId !== undefined ? { pageId: cell.pageId } : {}), path, partial, baffleFeet })
      cells.push(cell)
    }
  }
  return { inputs, modules, cells, bafflesPerCassette: per, fieldSquareFeet, perimeterFeet, warnings }
}

/** Stock fractions one baffle of `feet` takes, after yield. */
function baffleStock(feet: number, stockFeet: number, allowed: readonly number[]): number[] {
  const out: number[] = []
  let left = feet
  while (left > stockFeet + 1e-6) { out.push(1); left -= stockFeet }
  if (left > 1e-6) out.push(roundStockFractionToAllowed(left / stockFeet, allowed))
  return out
}

/** The order for a cassette layout. Every count comes from the modules, so the BOM and the piece list agree. */
export function cassetteQuantities(layout: CassetteLayout): PieceQuantity[] {
  const { inputs, modules } = layout
  const allowed = allowedPieceFractions(inputs.yieldGranularity)
  const full = modules.filter((m) => !m.partial).length
  const partial = modules.length - full
  const fullLen = inputs.lengthFeet
  let uncut = 0, cut = 0, installed = 0
  const fractions: number[] = []
  for (const m of modules) {
    for (const f of m.baffleFeet) {
      installed += f
      if (f >= fullLen - 1 / 192) uncut++
      else cut++
      fractions.push(...baffleStock(m.partial ? f : fullLen, inputs.stockLengthFeet, allowed))
    }
  }
  const baffles = uncut + cut
  const moduleSf = inputs.widthFeet * inputs.lengthFeet
  const r1 = (x: number): number => Math.round(x * 10) / 10
  const out: PieceQuantity[] = [
    { itemKey: 'cassette_count', label: 'Cassettes', quantity: modules.length, unit: 'EA' },
    { itemKey: 'cassette_full', label: 'Full cassettes', quantity: full, unit: 'EA' },
    { itemKey: 'cassette_partial', label: 'Partial cassettes (built to fit)', quantity: partial, unit: 'EA' },
    { itemKey: 'cassette_removable', label: 'Removable cassettes', quantity: roundUpQuantity(modules.length * inputs.removableShare), unit: 'EA' },
    { itemKey: 'cassette_by_area', label: 'Cassettes by area', quantity: r1(layout.fieldSquareFeet / moduleSf), unit: 'EA' },
    { itemKey: 'primary_stock', label: 'Baffle stock', quantity: orderStockPieceCount(fractions), unit: 'EA' },
    { itemKey: 'baffle_count', label: 'Baffles', quantity: baffles, unit: 'EA' },
    { itemKey: 'baffle_cut', label: 'Cut baffles (in partial cassettes)', quantity: cut, unit: 'EA' },
    { itemKey: 'installed_length', label: 'Installed baffle length', quantity: r1(installed), unit: 'LF' },
    { itemKey: 'end_caps', label: 'End caps', quantity: baffles * 2, unit: 'EA' },
    { itemKey: 'perimeter_length', label: 'Perimeter trim', quantity: r1(layout.perimeterFeet), unit: 'LF' },
  ]
  if (inputs.trimLengthFeet !== null) {
    out.push({
      itemKey: 'perimeter_trim', label: `Perimeter trim (${inches(inputs.trimLengthFeet)} lengths)`,
      quantity: roundUpQuantity(layout.perimeterFeet / inputs.trimLengthFeet), unit: 'EA',
    })
  }
  return out.filter((q) => q.quantity > 0)
}

export interface CassettePieceList {
  bafflesPerCassette: number
  cassetteWidthFeet: number
  cassetteLengthFeet: number
  full: number
  partial: number
  /** Cut baffles grouped by length (to 1/16"), longest first. */
  cutBaffles: Array<{ length: string; feet: number; count: number; stockFraction: number }>
  /** Partial cassettes grouped by their baffle make-up, most common first. */
  partialTypes: Array<{ count: number; baffles: string[] }>
  installedFeet: number
}

/** The cassette piece list (#177): what is built, and every cut. */
export function cassettePieceList(layout: CassetteLayout, opts: { maxTypes?: number } = {}): CassettePieceList {
  const { inputs, modules } = layout
  const allowed = allowedPieceFractions(inputs.yieldGranularity)
  const cuts = new Map<number, number>()
  const types = new Map<string, { count: number; baffles: string[] }>()
  let installed = 0
  for (const m of modules) {
    for (const f of m.baffleFeet) {
      installed += f
      if (f < inputs.lengthFeet - 1 / 192) {
        const k = Math.round(f * 192) // 1/16"
        cuts.set(k, (cuts.get(k) ?? 0) + 1)
      }
    }
    if (!m.partial) continue
    const baffles = m.baffleFeet.map((f) => (f >= inputs.lengthFeet - 1 / 192 ? 'full' : feetInches(Math.round(f * 192) / 192)))
    const key = baffles.join('|')
    const t = types.get(key) ?? { count: 0, baffles }
    t.count++
    types.set(key, t)
  }
  const maxTypes = opts.maxTypes ?? 200
  return {
    bafflesPerCassette: layout.bafflesPerCassette,
    cassetteWidthFeet: inputs.widthFeet,
    cassetteLengthFeet: inputs.lengthFeet,
    full: modules.filter((m) => !m.partial).length,
    partial: modules.filter((m) => m.partial).length,
    cutBaffles: [...cuts].sort((a, b) => b[0] - a[0]).map(([k, count]) => {
      const feet = k / 192
      const fr = baffleStock(feet, inputs.stockLengthFeet, allowed)
      return { length: feetInches(feet), feet: Math.round(feet * 1000) / 1000, count, stockFraction: fr[fr.length - 1] ?? 0 }
    }),
    partialTypes: [...types.values()].sort((a, b) => b.count - a.count).slice(0, maxTypes),
    installedFeet: Math.round(installed * 10) / 10,
  }
}

function inches(feet: number): string {
  const sixteenths = Math.round(feet * 192)
  const whole = Math.floor(sixteenths / 16)
  const rest = sixteenths % 16
  if (rest === 0) return `${whole}"`
  const g = gcd(rest, 16)
  return `${whole > 0 ? `${whole} ` : ''}${rest / g}/${16 / g}"`
}

function feetInches(feet: number): string {
  const sixteenths = Math.round(feet * 192)
  const ft = Math.floor(sixteenths / 192)
  return `${ft}'-${inches((sixteenths - ft * 192) / 192)}`
}

function gcd(a: number, b: number): number { return b === 0 ? a : gcd(b, a % b) }
