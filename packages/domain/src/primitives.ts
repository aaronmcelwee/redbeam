/**
 * Stored primitives: named, versioned, parametric products (Aaron, 2026-11-27).
 *
 * 700 Bay St. (SC-1, Parallel Open Cell) took five rebuilds as a custom
 * pattern, because a recipe is a fixed list of shapes for one geometry: it
 * cannot vary by area, and nothing in the PDF said which sizes and positions
 * its rectangles came from. A primitive keeps the PARAMETERS and lays the
 * pieces out per area when the scope is counted:
 *
 *   definition   name, version, a parameter schema, and the generator
 *   generator    code in REDBEAM that turns parameters plus one area's size
 *                into finished pieces (SKUs) and hardware
 *   scope        the definition as saved (so the PDF opens the same on any
 *                machine, and a library version bump never reprices it),
 *                the scope's values, and per-area overrides by markup id
 *
 * Generators are code, not agent-sent scripts: a takeoff tool that runs
 * whatever an agent sends could do anything to the person's machine. An
 * agent saves a primitive over a generator with its own name, defaults and
 * required fields; a new kind of geometry is a new generator in a release.
 *
 * Everything here is in INCHES. Local frame per area: `along` runs with the
 * mains from the area's left (or top) edge, `across` from its top (or left)
 * edge, as the estimator reads the drawing.
 */

import { lengthToFeet, slugOf } from './patternRecipe.js'
import { isLengthUnit, type LengthUnit } from './units.js'
import { regionArea, type Point, type Region } from './geometry.js'

/** Where a scope keeps its primitive: in its specification, so it is saved in the PDF. */
export const PRIMITIVE_KEY = 'primitive'

export type PrimitiveStatus = 'draft' | 'approved'
export type ParamKind = 'measure' | 'measures' | 'choice' | 'bool' | 'angle' | 'number'
export const PARAM_KINDS: readonly ParamKind[] = ['measure', 'measures', 'choice', 'bool', 'angle', 'number']

export interface PrimitiveParam {
  key: string
  label: string
  kind: ParamKind
  /** Plain numbers are in this unit (measure, measures). Default in. */
  unit?: LengthUnit
  choices?: string[]
  default?: unknown
  required?: boolean
  help?: string
  /** False: one value for the whole scope. Default true: an area can override it. */
  perArea?: boolean
  /** Where the viewer lists it: Layout, Members, Factory pieces, Suspension or Island size. */
  group?: string
}

export interface PrimitiveDefinition {
  version: 1
  /** Library id, a slug. */
  id: string
  name: string
  /** The library version this definition is. A scope keeps the one it was made with. */
  primitiveVersion: number
  generator: string
  parameters: PrimitiveParam[]
  description?: string
  status: PrimitiveStatus
  source?: string
  savedAt?: string
  approvedBy?: string
  approvedAt?: string
}

/** What a scope carries: the definition as used, its values, per-area overrides. */
export interface ScopePrimitive {
  definition: PrimitiveDefinition
  parameters: Record<string, unknown>
  /** Overrides by area markup id. */
  areas?: Record<string, Record<string, unknown>>
}

export type Values = Record<string, number | number[] | string | boolean | null>

export interface GenPiece {
  sku: string
  family: string
  /** Finished length, inches. */
  length: number
  mitres: number
  /** [along0, along1, across0, across1], inches in the area's frame. */
  rect: [number, number, number, number]
}

export interface GenHardware { key: string; label: string; qty: number; unit?: string; note?: string }

export interface GeneratedArea {
  pieces: GenPiece[]
  hardware: GenHardware[]
  /** Hanger points, [along, across] inches in the area's frame. */
  hangers?: Array<[number, number]>
}

export interface Generator {
  id: string
  label: string
  description: string
  /** The design basis, one rule a line, for the viewer. */
  rules: string[]
  schema: PrimitiveParam[]
  /** Family order for the summary: frame first, then mains, then cross. */
  families: string[]
  generate(values: Values, length: number, width: number): GeneratedArea | { errors: string[] }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// ---------------------------------------------------------------------------
// Lengths, as the shop writes them
// ---------------------------------------------------------------------------

function gcd(a: number, b: number): number { return b === 0 ? a : gcd(b, a % b) }

function fraction(sixteenths: number): string {
  const whole = Math.floor(sixteenths / 16)
  const part = sixteenths - whole * 16
  if (part === 0) return `${whole}`
  const g = gcd(part, 16)
  return `${whole}-${part / g}/${16 / g}`
}

/** 108 → 9'-0, 106 → 8'-10, 58.5 → 58-1/2in. Six feet and over in feet and inches. */
export function formatPieceLength(inches: number): string {
  const s = Math.round(inches * 16)
  if (s >= 72 * 16) {
    const ft = Math.floor(s / (12 * 16))
    return `${ft}'-${fraction(s - ft * 12 * 16)}`
  }
  return `${fraction(s)}in`
}

/** Equal pieces at most `max` long (centred seams), or full pieces from the start and the rest last. */
export function splitRun(total: number, max: number, seams: string): number[] {
  if (!(total > 1e-9)) return []
  if (!(max > 0) || total <= max + 1e-6) return [total]
  if (seams === 'from origin') {
    const out: number[] = []
    let left = total
    while (left > max + 1e-6) { out.push(max); left -= max }
    if (left > 1e-6) out.push(left)
    return out
  }
  const n = Math.ceil(total / max - 1e-9)
  return Array.from({ length: n }, () => total / n)
}

// ---------------------------------------------------------------------------
// Parallel Open Cell (700 Bay St., SC-1)
// ---------------------------------------------------------------------------

/** Area keys every generator takes: the island's exact outside size, and how drawn sizes round. */
const AREA_SIZE_PARAMS: PrimitiveParam[] = [
  { key: 'length', label: 'Outside length (along the mains)', kind: 'measure', group: 'Island size', help: 'Exact outside size from the drawing. Default: the drawn area, rounded to sizeRounding.' },
  { key: 'width', label: 'Outside width', kind: 'measure', group: 'Island size', help: 'Exact outside size from the drawing. Default: the drawn area, rounded to sizeRounding.' },
  { key: 'sizeRounding', label: 'Round drawn sizes to', kind: 'measure', default: 1, group: 'Island size', help: 'A drawn area is measured and rounded to this before pieces are cut.' },
]

const OPEN_CELL_SCHEMA: PrimitiveParam[] = [
  { key: 'memberWidth', label: 'Member face width', kind: 'measure', default: 2, required: true, group: 'Members' },
  { key: 'memberDepth', label: 'Member depth', kind: 'measure', default: 6, group: 'Members', help: 'Finish only: not geometry.' },
  { key: 'mainsDirection', label: 'Mains direction', kind: 'angle', default: null, group: 'Layout', help: 'Degrees on the sheet, 0 = left to right, 90 = top to bottom. Default: the scope\'s pattern direction, else 0.' },
  { key: 'mainPositions', label: 'Main centrelines', kind: 'measures', required: true, group: 'Layout', help: 'Interior mains, centrelines (OC) measured in from the top edge (the left edge when the mains run up and down); the frame is not listed.' },
  { key: 'crossPositions', label: 'Cross centrelines', kind: 'measures', required: true, group: 'Layout', help: 'Interior cross members, centrelines (OC) measured in from the left edge (the top edge when the mains run up and down); the frame is not listed.' },
  { key: 'frame', label: 'Perimeter frame', kind: 'choice', choices: ['none', 'square', 'mitred'], default: 'mitred', group: 'Members' },
  { key: 'crossJoin', label: 'Where members meet', kind: 'choice', choices: ['mains through', 'cross through', 'both through'], default: 'mains through', group: 'Members', help: 'mains through: cross members are cut between main faces. both through: both run full length, notched.' },
  { key: 'maxPiece', label: 'Longest factory piece', kind: 'measure', default: 120, required: true, group: 'Factory pieces' },
  { key: 'seams', label: 'Seams', kind: 'choice', choices: ['centred', 'from origin'], default: 'centred', group: 'Factory pieces', help: 'centred: each run in equal pieces; from origin: full pieces from the start, the rest last.' },
  { key: 'hangerSpacing', label: 'Hanger spacing (max)', kind: 'measure', group: 'Suspension', help: 'No default: ask. Hangers along every main and frame main, spaced evenly, no farther apart than this.' },
  { key: 'hangerFromEnd', label: 'First hanger from the end', kind: 'measure', default: 0, group: 'Suspension', help: 'How far in from each end of a run the first and last hangers sit. 0: at the ends.' },
  ...AREA_SIZE_PARAMS,
]

function openCell(values: Values, L: number, W: number): GeneratedArea | { errors: string[] } {
  const errors: string[] = []
  const w = values['memberWidth'] as number
  const maxPiece = values['maxPiece'] as number
  const frame = values['frame'] as string
  const seams = values['seams'] as string
  const join = values['crossJoin'] as string
  const fw = frame === 'none' ? 0 : w
  if (!(w > 0)) errors.push('memberWidth: must be more than zero')
  if (!(maxPiece > 0)) errors.push('maxPiece: must be more than zero')
  if (!(L > 2 * fw) || !(W > 2 * fw)) errors.push(`length/width: ${formatPieceLength(L)} by ${formatPieceLength(W)} leaves no room inside the frame`)
  const check = (key: string, list: number[], span: number) => {
    const sorted = [...list].sort((a, b) => a - b)
    sorted.forEach((c, i) => {
      if (c - w / 2 < fw - 1e-6 || c + w / 2 > span - fw + 1e-6) {
        errors.push(`${key}[${list.indexOf(c)}]: ${c} in puts the member outside the frame (inside faces at ${fw} and ${span - fw} in)`)
      }
      if (i > 0 && c - sorted[i - 1]! < w - 1e-6) errors.push(`${key}: ${sorted[i - 1]} and ${c} in are closer than one member width (${w} in)`)
    })
    return sorted
  }
  const mains = check('mainPositions', values['mainPositions'] as number[], W)
  const cross = check('crossPositions', values['crossPositions'] as number[], L)
  if (errors.length > 0) return { errors }

  const pieces: GenPiece[] = []
  let seamsCount = 0
  /** Runs that carry hangers: along from a0 to a1, at across c. */
  const hangerRuns: Array<{ a0: number; a1: number; c: number }> = []
  const name = (family: string, len: number, mitres: number) =>
    `${family} ${formatPieceLength(len)}${mitres > 0 ? ` mitre ${mitres} end${mitres > 1 ? 's' : ''}` : ''}`
  /** A run cut into factory pieces; `place` gives each piece its rectangle from its start and end along the run. */
  const run = (family: string, total: number, mitredEnds: boolean, place: (s: number, e: number) => GenPiece['rect']) => {
    const lens = splitRun(total, maxPiece, seams)
    seamsCount += Math.max(0, lens.length - 1)
    let at = 0
    lens.forEach((len, i) => {
      const mitres = mitredEnds ? (i === 0 ? 1 : 0) + (i === lens.length - 1 ? 1 : 0) : 0
      pieces.push({ sku: name(family, len, mitres), family, length: len, mitres, rect: place(at, at + len) })
      at += len
    })
  }

  // The frame.
  if (frame === 'mitred') {
    for (const c0 of [0, W - w]) { run('Frame main', L, true, (s, e) => [s, e, c0, c0 + w]); hangerRuns.push({ a0: 0, a1: L, c: c0 + w / 2 }) }
    for (const a0 of [0, L - w]) run('Frame end', W, true, (s, e) => [a0, a0 + w, Math.max(s, w), Math.min(e, W - w)])
  } else if (frame === 'square') {
    for (const c0 of [0, W - w]) { run('Frame main', L, false, (s, e) => [s, e, c0, c0 + w]); hangerRuns.push({ a0: 0, a1: L, c: c0 + w / 2 }) }
    for (const a0 of [0, L - w]) run('Frame end', W - 2 * w, false, (s, e) => [a0, a0 + w, w + s, w + e])
  }

  const mainsThrough = join === 'mains through' || join === 'both through'
  const crossThrough = join === 'cross through' || join === 'both through'
  const gaps = (lines: number[], span: number): Array<[number, number]> => {
    const faces = [fw, ...lines.flatMap((c) => [c - w / 2, c + w / 2]), span - fw]
    const out: Array<[number, number]> = []
    for (let i = 0; i + 1 < faces.length; i += 2) if (faces[i + 1]! - faces[i]! > 1e-6) out.push([faces[i]!, faces[i + 1]!])
    return out
  }
  // Mains, the long direction.
  for (const c of mains) {
    if (mainsThrough) { run('Main', L - 2 * fw, false, (s, e) => [fw + s, fw + e, c - w / 2, c + w / 2]); hangerRuns.push({ a0: fw, a1: L - fw, c }) }
    else for (const [s0, s1] of gaps(cross, L)) { run('Main', s1 - s0, false, (s, e) => [s0 + s, s0 + e, c - w / 2, c + w / 2]); hangerRuns.push({ a0: s0, a1: s1, c }) }
  }
  // Cross members.
  for (const x of cross) {
    if (crossThrough) run('Cross', W - 2 * fw, false, (s, e) => [x - w / 2, x + w / 2, fw + s, fw + e])
    else for (const [s0, s1] of gaps(mains, W)) run('Cross', s1 - s0, false, (s, e) => [x - w / 2, x + w / 2, s0 + s, s0 + e])
  }

  const lines = (frame === 'none' ? 0 : 2)
  const hardware: GenHardware[] = [
    { key: 'seams', label: 'Seams', qty: seamsCount },
    { key: 'crossings', label: 'Crossings', qty: (mains.length + lines) * (cross.length + lines) },
  ]
  if (frame === 'mitred') hardware.push({ key: 'mitred-corners', label: 'Mitred corners', qty: 4 })
  const spacing = values['hangerSpacing']
  const hangers: Array<[number, number]> = []
  if (typeof spacing === 'number' && spacing > 0) {
    const fromEnd = typeof values['hangerFromEnd'] === 'number' ? Math.max(0, values['hangerFromEnd']) : 0
    for (const r of hangerRuns) {
      // Evenly spaced, no farther apart than the spacing, the first and last fromEnd in.
      const e = Math.min(fromEnd, (r.a1 - r.a0) / 2)
      const span = r.a1 - r.a0 - 2 * e
      const n = span > 1e-6 ? Math.ceil(span / spacing - 1e-9) + 1 : 1
      for (let i = 0; i < n; i++) hangers.push([n === 1 ? (r.a0 + r.a1) / 2 : r.a0 + e + (span * i) / (n - 1), r.c])
    }
    hardware.push({ key: 'hangers', label: 'Hangers', qty: hangers.length })
  }
  return { pieces, hardware, hangers }
}

export const GENERATORS: Record<string, Generator> = {
  parallel_open_cell: {
    id: 'parallel_open_cell',
    label: 'Parallel Open Cell (factory cut)',
    description: 'A perimeter frame with a grid of members inside, at uneven on-centre spacing, shipped as finished pieces. '
      + 'Mains run the long way between the frame\'s inside faces; cross members are cut between main faces; every run longer than maxPiece is split into equal pieces. '
      + 'One SKU per distinct piece (mitred ends are their own SKU). Rectangular islands, one area each.',
    rules: [
      'A perimeter frame with a grid of members inside, at uneven on-centre spacing, shipped as finished factory pieces.',
      'Every island is a rectangle, laid out on its own, measured from its outside edges.',
      'Mains run the long way, between the frame\'s inside faces. Cross members run between the main faces, unless members meet another way.',
      'The frame runs full length along the mains. Its ends sit between the frame mains. With a mitred frame both end pieces of a frame run are mitred.',
      'A run longer than the longest factory piece is split, in equal pieces (centred) or full pieces from the start.',
      'One SKU per distinct finished piece: family, length and mitred ends. A seam is where two pieces of a run meet.',
      'Hangers go along every main and frame main, evenly spaced, no farther apart than the hanger spacing.',
    ],
    schema: OPEN_CELL_SCHEMA,
    families: ['Frame main', 'Frame end', 'Main', 'Cross'],
    generate: openCell,
  },
}

/** The 700 Bay St. primitive, as an agent would save it: the worked example. */
export const OPEN_CELL_EXAMPLE = {
  name: 'Parallel Open Cell 6x2',
  generator: 'parallel_open_cell',
  description: 'Maxxit AERO:Form Parallel Open Cell, 6"x2" members, factory cut.',
  parameters: {
    memberWidth: { default: 2 },
    memberDepth: { default: 6 },
    frame: { default: 'mitred' },
    maxPiece: { default: 120 },
  },
}

// ---------------------------------------------------------------------------
// Checking a definition
// ---------------------------------------------------------------------------

export type PrimitiveCheck =
  | { ok: true; definition: PrimitiveDefinition; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] }

/**
 * Check a definition an agent sent. `parameters` may be a list of params or a
 * map from key to {default, required, label, help}; anything left out comes
 * from the generator. Every refusal names the field and says what to change.
 */
export function checkPrimitiveDefinition(raw: unknown): PrimitiveCheck {
  const errors: string[] = []
  const warnings: string[] = []
  let input = raw
  if (typeof input === 'string') { try { input = JSON.parse(input) } catch { return { ok: false, errors: ['definition: not valid JSON'], warnings } } }
  if (!isRecord(input)) return { ok: false, errors: ['definition: an object with name, generator and parameters'], warnings }
  const name = typeof input['name'] === 'string' ? input['name'].trim() : ''
  if (name === '') errors.push('name: required, e.g. "Parallel Open Cell 6x2"')
  const genId = typeof input['generator'] === 'string' ? input['generator'].trim() : isRecord(input['generator']) && typeof input['generator']['kind'] === 'string' ? input['generator']['kind'] : ''
  const gen = GENERATORS[genId]
  if (gen === undefined) {
    errors.push(`generator: "${genId}" is not one REDBEAM has (generators: ${Object.keys(GENERATORS).join(', ')})`)
    return { ok: false, errors, warnings }
  }
  const sent = new Map<string, Record<string, unknown>>()
  const pr = input['parameters']
  if (Array.isArray(pr)) {
    pr.forEach((p, i) => {
      if (!isRecord(p) || typeof p['key'] !== 'string') { errors.push(`parameters[${i}]: give {key, default?, required?, label?}`); return }
      sent.set(p['key'], p)
    })
  } else if (isRecord(pr)) {
    for (const [k, v] of Object.entries(pr)) sent.set(k, isRecord(v) ? { ...v, key: k } : { key: k, default: v })
  } else if (pr !== undefined) {
    errors.push('parameters: a list of {key, default, ...} or a map {key: {default, ...}}')
  }
  const known = new Map(gen.schema.map((p) => [p.key, p]))
  for (const k of sent.keys()) {
    if (!known.has(k)) errors.push(`parameters.${k}: not a parameter of ${gen.id} (its parameters: ${gen.schema.map((p) => p.key).join(', ')})`)
  }
  const parameters: PrimitiveParam[] = gen.schema.map((base) => {
    const s = sent.get(base.key)
    if (s === undefined) return { ...base }
    if (s['kind'] !== undefined && s['kind'] !== base.kind) errors.push(`parameters.${base.key}.kind: ${gen.id} reads it as ${base.kind}, not ${String(s['kind'])}`)
    const out: PrimitiveParam = { ...base }
    if (typeof s['label'] === 'string' && s['label'].trim() !== '') out.label = s['label'].trim()
    if (typeof s['help'] === 'string') out.help = s['help']
    if (typeof s['required'] === 'boolean') out.required = s['required'] || base.required === true
    if (typeof s['perArea'] === 'boolean') out.perArea = s['perArea']
    if (s['unit'] !== undefined) {
      if (typeof s['unit'] === 'string' && isLengthUnit(s['unit'])) out.unit = s['unit'] as LengthUnit
      else errors.push(`parameters.${base.key}.unit: "${String(s['unit'])}" is not one of in, ft, mm, cm, m`)
    }
    if ('default' in s) {
      const parsed = parseValue(out, s['default'], `parameters.${base.key}.default`)
      if ('error' in parsed) errors.push(parsed.error)
      else out.default = s['default']
    }
    return out
  })
  if (errors.length > 0) return { ok: false, errors, warnings }
  const id = typeof input['id'] === 'string' && input['id'].trim() !== '' ? slugOf(input['id']) : slugOf(name)
  return {
    ok: true,
    warnings,
    definition: {
      version: 1, id, name, primitiveVersion: typeof input['primitiveVersion'] === 'number' ? input['primitiveVersion'] : 0,
      generator: gen.id, parameters,
      ...(typeof input['description'] === 'string' ? { description: input['description'] } : {}),
      status: input['status'] === 'approved' ? 'approved' : 'draft',
      ...(typeof input['source'] === 'string' ? { source: input['source'] } : {}),
      ...(typeof input['savedAt'] === 'string' ? { savedAt: input['savedAt'] } : {}),
      ...(typeof input['approvedBy'] === 'string' ? { approvedBy: input['approvedBy'] } : {}),
      ...(typeof input['approvedAt'] === 'string' ? { approvedAt: input['approvedAt'] } : {}),
    },
  }
}

/** Whether two definitions lay out the same: name, generator and schema (not status or dates). */
export function sameDefinition(a: PrimitiveDefinition, b: PrimitiveDefinition): boolean {
  const key = (d: PrimitiveDefinition) => JSON.stringify({ n: d.name, g: d.generator, p: d.parameters, d: d.description ?? '' })
  return key(a) === key(b)
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

function inches(v: unknown, unit: LengthUnit): number | null {
  const f = lengthToFeet(v, unit)
  return f === null ? null : f * 12
}

const CHOICE_ALIAS: Record<string, string> = {
  centered: 'centred', center: 'centred', centre: 'centred', mitered: 'mitred', miter: 'mitred', mitre: 'mitred', butt: 'square',
}

function parseValue(p: PrimitiveParam, v: unknown, where: string): { value: Values[string] } | { error: string } {
  const unit = p.unit ?? 'in'
  if (v === null && (p.kind === 'angle' || !p.required)) return { value: null }
  switch (p.kind) {
    case 'measure': {
      const x = inches(v, unit)
      if (x === null) return { error: `${where}: "${String(v)}" is not a length (a number in ${unit}, or text like "10'" or "8 7/8")` }
      if (x < 0) return { error: `${where}: must not be negative` }
      return { value: x }
    }
    case 'measures': {
      const list = typeof v === 'string' ? v.split(/[,;]/).map((s) => s.trim()).filter((s) => s !== '') : v
      if (!Array.isArray(list)) return { error: `${where}: a list of lengths, e.g. [8.875, 42.75]` }
      const out: number[] = []
      for (let i = 0; i < list.length; i++) {
        const x = inches(list[i], unit)
        if (x === null) return { error: `${where}[${i}]: "${String(list[i])}" is not a length` }
        out.push(x)
      }
      return { value: out }
    }
    case 'choice': {
      const t = typeof v === 'string' ? v.trim().toLowerCase().replace(/[_-]+/g, ' ') : ''
      const s = CHOICE_ALIAS[t] ?? t
      const hit = (p.choices ?? []).find((c) => c === s)
      if (hit === undefined) return { error: `${where}: "${String(v)}" is not one of ${(p.choices ?? []).join(', ')}` }
      return { value: hit }
    }
    case 'bool':
      if (typeof v !== 'boolean') return { error: `${where}: true or false` }
      return { value: v }
    case 'angle':
    case 'number': {
      const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/°/g, '')) : NaN
      if (!Number.isFinite(n)) return { error: `${where}: a number${p.kind === 'angle' ? ' of degrees' : ''}` }
      return { value: n }
    }
  }
}

/** Area keys a scope's areas may carry beyond the schema: none. */
export function resolveValues(
  def: PrimitiveDefinition, scopeValues: Record<string, unknown>, areaValues: Record<string, unknown> | undefined, areaLabel: string,
): { values: Values; errors: string[] } {
  const errors: string[] = []
  const values: Values = {}
  const keys = new Set(def.parameters.map((p) => p.key))
  for (const k of Object.keys(scopeValues)) if (!keys.has(k)) errors.push(`parameters.${k}: not a parameter of ${def.name} (its parameters: ${[...keys].join(', ')})`)
  for (const k of Object.keys(areaValues ?? {})) if (!keys.has(k)) errors.push(`area ${areaLabel}.${k}: not a parameter of ${def.name}`)
  for (const p of def.parameters) {
    const fromArea = areaValues !== undefined && areaValues[p.key] !== undefined && areaValues[p.key] !== null && p.perArea !== false
    if (areaValues !== undefined && areaValues[p.key] !== undefined && p.perArea === false) errors.push(`area ${areaLabel}.${p.key}: is one value for the whole scope; set it in parameters`)
    const raw = fromArea ? areaValues![p.key] : scopeValues[p.key] !== undefined && scopeValues[p.key] !== null ? scopeValues[p.key] : p.default
    const where = fromArea ? `area ${areaLabel}.${p.key}` : `parameters.${p.key}`
    if (raw === undefined || raw === null) {
      if (p.required === true) errors.push(`${where}: required${p.help !== undefined ? ` (${p.help})` : ''}`)
      values[p.key] = null
      continue
    }
    const parsed = parseValue(p, raw, where)
    if ('error' in parsed) errors.push(parsed.error)
    else values[p.key] = parsed.value
  }
  return { values, errors }
}

// ---------------------------------------------------------------------------
// Layout, per area
// ---------------------------------------------------------------------------

export interface PrimitiveGroup {
  pageId: string
  markupId: string
  /** Rings in PDF points, y down. */
  region: Region
  direction: Point
  feetPerPoint: number
  /** False when no direction was stated anywhere: mainsDirection or 0 decides. */
  directionStated?: boolean
}

export interface PrimitiveSkuLine {
  sku: string
  family: string
  count: number
  lengthInches: number
  linearFeet: number
  mitres: number
}

export interface PrimitiveAreaResult {
  markupId: string
  pageId: string
  drawn: { length: number; width: number }
  used: { length: number; width: number }
  overrides: string[]
  pieces: number
  skus: Record<string, number>
}

export interface PrimitiveShape { pageId: string; points: Point[]; family: string }

export interface PrimitiveLayout {
  skus: PrimitiveSkuLine[]
  hardware: GenHardware[]
  areas: PrimitiveAreaResult[]
  shapes: PrimitiveShape[]
  blockers: string[]
  warnings: string[]
  totalPieces: number
  totalLinearFeet: number
}

const r2 = (x: number) => Math.round(x * 100) / 100

export function layoutPrimitive(prim: ScopePrimitive, groups: readonly PrimitiveGroup[], labelOf: (markupId: string) => string = (id) => id): PrimitiveLayout {
  const out: PrimitiveLayout = { skus: [], hardware: [], areas: [], shapes: [], blockers: [], warnings: [], totalPieces: 0, totalLinearFeet: 0 }
  const def = prim.definition
  const gen = GENERATORS[def.generator]
  if (gen === undefined) { out.blockers.push(`the primitive's generator "${def.generator}" is not in this build of REDBEAM: update REDBEAM`); return out }
  const skus = new Map<string, PrimitiveSkuLine>()
  const hw = new Map<string, GenHardware>()
  for (const k of Object.keys(prim.areas ?? {})) {
    if (!groups.some((g) => g.markupId === k)) out.warnings.push(`areaParameters for ${k}: no area of this scope has that id; nothing reads it`)
  }
  for (const g of groups) {
    const label = labelOf(g.markupId)
    const { values, errors } = resolveValues(def, prim.parameters, prim.areas?.[g.markupId], label)
    if (errors.length > 0) { out.blockers.push(...errors); continue }
    // The frame: along with the mains, left to right (or top to bottom); across, top to bottom (or left to right).
    let u: Point
    const angle = values['mainsDirection']
    if (typeof angle === 'number') u = { x: Math.cos(angle * Math.PI / 180), y: Math.sin(angle * Math.PI / 180) }
    else if (g.directionStated === false) u = { x: 1, y: 0 }
    else {
      const d = Math.hypot(g.direction.x, g.direction.y)
      u = d > 0 ? { x: g.direction.x / d, y: g.direction.y / d } : { x: 1, y: 0 }
    }
    if (u.x < -1e-9 || (Math.abs(u.x) <= 1e-9 && u.y < 0)) u = { x: -u.x, y: -u.y }
    let n: Point = { x: -u.y, y: u.x }
    if (n.y < -1e-9 || (Math.abs(n.y) <= 1e-9 && n.x < 0)) n = { x: -n.x, y: -n.y }
    const k = g.feetPerPoint * 12
    let minA = Infinity, maxA = -Infinity, minC = Infinity, maxC = -Infinity
    for (const ring of g.region) for (const p of ring) {
      const a = (p.x * u.x + p.y * u.y) * k, c = (p.x * n.x + p.y * n.y) * k
      minA = Math.min(minA, a); maxA = Math.max(maxA, a); minC = Math.min(minC, c); maxC = Math.max(maxC, c)
    }
    if (!Number.isFinite(minA)) continue
    const drawnL = maxA - minA, drawnW = maxC - minC
    const area = regionArea(g.region) * k * k
    if (g.region.filter((r) => r.length >= 3).length !== 1 || Math.abs(area - drawnL * drawnW) > 0.01 * drawnL * drawnW) {
      out.blockers.push(`area ${label}: is not a rectangle square to the mains (${def.name} lays out rectangular islands: draw one area per island, along the mains direction, with no cutouts)`)
      continue
    }
    const round = (x: number) => { const s = values['sizeRounding']; return typeof s === 'number' && s > 0 ? Math.round(x / s) * s : x }
    const L = typeof values['length'] === 'number' ? values['length'] : round(drawnL)
    const W = typeof values['width'] === 'number' ? values['width'] : round(drawnW)
    for (const [key, used, drawn] of [['length', L, drawnL], ['width', W, drawnW]] as const) {
      if (Math.abs(used - drawn) > Math.max(2, drawn * 0.03)) out.warnings.push(`area ${label}: ${key} ${formatPieceLength(used)} is ${formatPieceLength(Math.abs(used - drawn))} off the drawn ${formatPieceLength(drawn)}`)
    }
    const made = gen.generate(values, L, W)
    if ('errors' in made) { out.blockers.push(...made.errors.map((e) => `area ${label}: ${e}`)); continue }
    const counts: Record<string, number> = {}
    for (const p of made.pieces) {
      const line = skus.get(p.sku) ?? { sku: p.sku, family: p.family, count: 0, lengthInches: r2(p.length), linearFeet: 0, mitres: p.mitres }
      line.count++
      skus.set(p.sku, line)
      counts[p.sku] = (counts[p.sku] ?? 0) + 1
      const [a0, a1, c0, c1] = p.rect
      const at = (a: number, c: number): Point => {
        const A = (minA + a) / k, C = (minC + c) / k
        return { x: u.x * A + n.x * C, y: u.y * A + n.y * C }
      }
      out.shapes.push({ pageId: g.pageId, family: p.family, points: [at(a0, c0), at(a1, c0), at(a1, c1), at(a0, c1)] })
    }
    for (const h of made.hardware) {
      const cur = hw.get(h.key)
      if (cur === undefined) hw.set(h.key, { ...h })
      else cur.qty += h.qty
    }
    out.areas.push({
      markupId: g.markupId, pageId: g.pageId,
      drawn: { length: r2(drawnL), width: r2(drawnW) }, used: { length: r2(L), width: r2(W) },
      overrides: Object.keys(prim.areas?.[g.markupId] ?? {}), pieces: made.pieces.length, skus: counts,
    })
  }
  const order = (f: string) => { const i = gen.families.indexOf(f); return i < 0 ? 99 : i }
  out.skus = [...skus.values()]
    .map((s) => ({ ...s, linearFeet: r2(s.count * s.lengthInches / 12) }))
    .sort((a, b) => order(a.family) - order(b.family) || b.lengthInches - a.lengthInches || a.mitres - b.mitres)
  out.hardware = [...hw.values()]
  out.totalPieces = out.skus.reduce((s, x) => s + x.count, 0)
  out.totalLinearFeet = r2(out.skus.reduce((s, x) => s + x.linearFeet, 0))
  return out
}

/** The primitive on a scope's specification, or null. Never throws. */
export function readScopePrimitive(specs: Record<string, unknown>): ScopePrimitive | { error: string } | null {
  let v = specs[PRIMITIVE_KEY]
  if (v === undefined || v === null) return null
  if (typeof v === 'string') { try { v = JSON.parse(v) } catch { return { error: 'the primitive on this scope is not valid JSON' } } }
  if (!isRecord(v)) return { error: 'the primitive on this scope is not an object' }
  const check = checkPrimitiveDefinition(v['definition'])
  if (!check.ok) return { error: `the primitive: ${check.errors.join('; ')}` }
  const params = isRecord(v['parameters']) ? v['parameters'] : {}
  const areas: Record<string, Record<string, unknown>> = {}
  if (isRecord(v['areas'])) for (const [k, a] of Object.entries(v['areas'])) if (isRecord(a)) areas[k] = a
  return { definition: { ...check.definition, primitiveVersion: (v['definition'] as Record<string, unknown>)['primitiveVersion'] as number ?? 0 }, parameters: params, areas }
}

/** A generator's schema and rules, for describe_primitive. */
export function describeGenerator(id: string): Record<string, unknown> | null {
  const g = GENERATORS[id]
  if (g === undefined) return null
  return {
    generator: g.id, label: g.label, summary: g.description, rules: g.rules,
    parameters: g.schema.map((p) => ({
      key: p.key, label: p.label, kind: p.kind, ...(p.unit !== undefined ? { unit: p.unit } : { ...(p.kind === 'measure' || p.kind === 'measures' ? { unit: 'in' } : {}) }),
      ...(p.choices !== undefined ? { choices: p.choices } : {}), ...(p.default !== undefined && p.default !== null ? { default: p.default } : {}),
      ...(p.required === true ? { required: true } : {}), ...(p.help !== undefined ? { help: p.help } : {}),
      ...(p.group !== undefined ? { group: p.group } : {}),
    })),
  }
}

// ---------------------------------------------------------------------------
// One island drawn out, for the viewer
// ---------------------------------------------------------------------------

export interface PrimitiveDrawing {
  /** Outside size used, inches. */
  length: number
  width: number
  values: Values
  pieces: GenPiece[]
  hardware: GenHardware[]
  hangers: Array<[number, number]>
  /** Interior seams, [along, across] at the joint's centre. */
  seams: Array<[number, number]>
  errors: string[]
}

/**
 * One island of a primitive, generated in its own frame (inches, along the
 * mains then across), so the viewer can draw it and size its components.
 * `areaId` takes that area's overrides; `size` is its outside size, else the
 * stated length and width, else a size that holds every centreline.
 */
export function drawPrimitiveArea(prim: ScopePrimitive, areaId: string | null, size?: { length: number; width: number }): PrimitiveDrawing {
  const empty = (errors: string[], length = 0, width = 0): PrimitiveDrawing => ({ length, width, values: {}, pieces: [], hardware: [], hangers: [], seams: [], errors })
  const gen = GENERATORS[prim.definition.generator]
  if (gen === undefined) return empty([`generator: ${prim.definition.generator} is not one REDBEAM has`])
  const { values, errors } = resolveValues(prim.definition, prim.parameters, areaId === null ? undefined : prim.areas?.[areaId], areaId ?? 'typical')
  if (errors.length > 0) return { ...empty(errors), values }
  const fit = (key: string): number => {
    const list = values[key]
    const w = typeof values['memberWidth'] === 'number' ? values['memberWidth'] : 2
    if (!Array.isArray(list) || list.length === 0) return 120
    // As much again past the last centreline as before the first.
    return Math.max(...list) + Math.max(Math.min(...list), w)
  }
  const L = size?.length ?? (typeof values['length'] === 'number' ? values['length'] : fit('crossPositions'))
  const W = size?.width ?? (typeof values['width'] === 'number' ? values['width'] : fit('mainPositions'))
  const made = gen.generate(values, L, W)
  if ('errors' in made) return { ...empty(made.errors, L, W), values }
  // A seam is where one piece of a run ends and the next starts.
  const seams: Array<[number, number]> = []
  const ends = new Map<string, number>()
  for (const p of made.pieces) {
    const [a0, a1, c0, c1] = p.rect
    const alongRun = a1 - a0 >= c1 - c0
    const k0 = alongRun ? `a:${(c0 + c1) / 2}:${a0}` : `c:${(a0 + a1) / 2}:${c0}`
    if (ends.has(k0)) seams.push(alongRun ? [a0, (c0 + c1) / 2] : [(a0 + a1) / 2, c0])
    ends.set(alongRun ? `a:${(c0 + c1) / 2}:${a1}` : `c:${(a0 + a1) / 2}:${c1}`, 1)
  }
  return { length: L, width: W, values, pieces: made.pieces, hardware: made.hardware, hangers: made.hangers ?? [], seams, errors: [] }
}
