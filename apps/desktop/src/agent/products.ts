/**
 * What each product needs, in the keys an agent writes (Aaron, 2026-11-24:
 * "the bill of materials says 'needs Spacing OC, Stock, Conn. Max' but not
 * where to store them").
 *
 * Read off the same tables the scope editor and the layout engine use
 * (requiredMeasures, editableMeasures, granularityKey), so the description
 * cannot drift from what actually moves a number.
 */
import {
  PRODUCT_TYPES, PRODUCT_TYPE_KEY, PRODUCT_TYPE_LABEL, canonicalProductType, editableMeasures,
  granularityKey, measureHelp, measureToFeet, requiredMeasures, scopeTypeForProduct,
  type ProductType, type Specifications,
} from '@redbeam/domain'

export const UNITS = ['in', 'ft', 'mm', 'cm', 'm'] as const

export interface ProductField {
  key: string
  /** Where the unit goes. Absent for a choice. */
  unitKey?: string
  label: string
  help: string
  required: boolean
  kind: 'measure' | 'choice'
  /** For a measure, the units; for a choice, the values. */
  allowed: readonly string[]
  /** Unit assumed when unitKey is empty (measures), or the value used when the key is absent. */
  default: string
}

export interface ProductDescription {
  productType: ProductType
  label: string
  /** What the scope must be measured as (scopeType), or null when any. */
  measuredAs: 'area' | 'linear' | 'count' | null
  fields: ProductField[]
  /** Specifications that would satisfy every required field, for illustration. */
  example: Record<string, string>
  note: string
  /** Optional settings that are not measures (mixed members on a baffle). */
  options?: Array<{ key: string; help: string; default: string }>
}

/** A plausible value for an example, in inches. Illustration only. */
const EXAMPLE_INCHES: Record<string, string> = {
  spacing: '6', stockLength: '96', maxConnectorSpacing: '48', cassetteWidth: '24',
  panelWidth: '24', panelLength: '48', plankWidth: '6', partLength: '96',
}

export function describeProduct(type: string): ProductDescription {
  const product = canonicalProductType(type)
  const required = new Set(requiredMeasures(product).map((f) => f.valueKey))
  const fields: ProductField[] = editableMeasures(product).map((f) => ({
    key: f.valueKey,
    unitKey: f.unitKey,
    label: f.label,
    help: measureHelp(f.valueKey),
    required: required.has(f.valueKey),
    kind: 'measure' as const,
    allowed: UNITS,
    default: 'in',
  }))
  if (product !== 'custom_assembly' && product !== 'linear_parts') {
    fields.push({
      key: granularityKey(product), label: 'Granularity', help: 'smallest piece ordered',
      required: false, kind: 'choice', allowed: ['full', 'half', 'quarter'], default: 'full',
    })
  }
  const example: Record<string, string> = { [PRODUCT_TYPE_KEY]: product }
  for (const f of fields) {
    if (!f.required || f.kind !== 'measure') continue
    example[f.key] = EXAMPLE_INCHES[f.key] ?? '12'
    example[f.unitKey!] = 'in'
  }
  return {
    productType: product,
    label: PRODUCT_TYPE_LABEL[product],
    measuredAs: scopeTypeForProduct(product),
    fields,
    example,
    ...(product === 'baffle' || product === 'baffle_cassette' ? { options: [...MIXED_OPTIONS, ...CLOUD_OPTIONS] }
      : scopeTypeForProduct(product) !== 'linear' ? { options: CLOUD_OPTIONS } : {}),
    note: 'Values are text ("6", "7 1/2"). Each measure is two keys: the number under `key`, the unit under `unitKey`. '
      + 'Set them with update_scope {specifications}, which merges. Laid-out products also need a pattern direction (set_pattern_direction).',
  }
}

/** "Beam every Nth member, Slab between" (NOIC report, 2026-11-26). Read by runs.ts readMixedMembers. */
const MIXED_OPTIONS = [
  { key: 'mixedEvery', help: 'every Nth line is a different member (2 or more), ordered on its own as "<mixedLabel> stock"; leave out for one member', default: '' },
  { key: 'mixedStart', help: 'which line is the first of them, 0 = the first line of each area', default: '0' },
  { key: 'mixedLabel', help: 'the Nth member\'s name', default: 'Beam' },
  { key: 'memberLabel', help: 'the members between (e.g. "Slab"); the stock line is named after it', default: 'Baffle' },
]

/** A cloud or 3D feature from its plan (NOIC report, 2026-11-26). Read by takeoff.ts readCloudShape. */
const CLOUD_OPTIONS = [
  { key: 'cloudSlope', help: 'degrees the face tilts from flat (0-80); the face area is the plan area over its cosine, as "Cloud face (developed)"', default: '' },
  { key: 'cloudUpturn', help: 'height the edges turn up, a measure with cloudUpturnUnit; gives "Cloud upturn" (SF) and "Cloud fold line" (LF) round each area', default: '' },
  { key: 'cloudUpturnUnit', help: 'unit of cloudUpturn: in, ft, mm, cm or m', default: 'in' },
]

export function describeAllProducts(): ProductDescription[] {
  return PRODUCT_TYPES.map((p) => describeProduct(p))
}

/** The keys a product is still missing, for a blocker an agent can act on. */
export function missingKeys(type: ProductType, specs: Specifications): Array<{ key: string; unitKey: string; label: string }> {
  return requiredMeasures(type)
    .filter((f) => measureToFeet(specs, f) === null)
    .map((f) => ({ key: f.valueKey, unitKey: f.unitKey, label: f.label }))
}

/** Keys the app reads from a scope's specifications that are not product measures. */
const OTHER_KNOWN = [
  PRODUCT_TYPE_KEY, 'alignSeams', 'profileWidthInches', 'scopeColor', 'scopeDefaultDirection',
  'pageDirections', 'areaDirections', 'areaOrigins', 'panelGranularity', 'yieldGranularity',
  'layoutPreviewActive', 'showConnectors', 'showEndCaps', 'showJoiners', 'showOverflowPreview', 'dimPageContent',
  'patternRecipe', 'mixedEvery', 'mixedStart', 'mixedLabel', 'memberLabel', 'cloudSlope', 'cloudUpturn', 'cloudUpturnUnit',
]

/**
 * Keys in `specs` that nothing reads for this product, so a value written
 * there changes no number (an agent wrote `length: "8' L"` and the parts list
 * stayed blocked). Reported back, not refused: older files carry keys of
 * their own, and refusing them would make those scopes uneditable.
 */
export function unknownSpecKeys(type: string, specs: Record<string, unknown>): string[] {
  const product = canonicalProductType(type)
  const known = new Set<string>(OTHER_KNOWN)
  for (const p of PRODUCT_TYPES) {
    for (const f of editableMeasures(p)) { known.add(f.valueKey); known.add(f.unitKey) }
  }
  const mine = new Set<string>()
  for (const f of editableMeasures(product)) { mine.add(f.valueKey); mine.add(f.unitKey) }
  return Object.keys(specs).filter((k) => !known.has(k) || (!mine.has(k) && !OTHER_KNOWN.includes(k)))
}

/**
 * Measures sent as numbers, as text. A spec measure is text ("24", "7 1/2")
 * because that is what the form holds; an AI app sent `panelWidth: 2`, it was
 * stored, and nothing read it, so the scope stayed "cannot be calculated".
 */
export function measuresAsText(specs: Record<string, unknown>): Record<string, unknown> {
  const keys = new Set<string>()
  for (const p of PRODUCT_TYPES) for (const f of editableMeasures(p)) keys.add(f.valueKey)
  const out: Record<string, unknown> = { ...specs }
  for (const [k, v] of Object.entries(specs)) {
    if (typeof v === 'number' && Number.isFinite(v) && keys.has(k)) out[k] = String(v)
  }
  return out
}
