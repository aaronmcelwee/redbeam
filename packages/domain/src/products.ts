/**
 * Every product, in one system (Aaron, 2026-11-25: "Move all existing product
 * types to this new framework so that everything fits in the same type of
 * system").
 *
 * A product is a DEFINITION: a name, what it is measured as, the fields it
 * takes, and the layers it lays on an area. The five built-in products are
 * one-layer definitions whose layer is their own verified engine; a custom
 * pattern is a definition read from its recipe. Anything that lists, labels
 * or describes products goes through here, so a pattern and a panel are the
 * same kind of thing to the sidebar, the BOM and an agent.
 *
 * The built-in engines are NOT re-expressed as recipes. Panels, cassettes,
 * planks and baffles carry rules a recipe has no words for (quarter-panel
 * stock selection, seam alignment, the Qt build's quirks) and are proven
 * against golden fixtures; re-deriving them would change counts nobody asked
 * to change. Instead the built-in engine IS a layer kind, so a recipe can use
 * "panels" as its first layer and put rails and hardware on top, and a panel
 * scope can become a pattern (builtInAsRecipe) without its count moving.
 */

import { isVerifiedProduct } from './bom.js'
import {
  BUILT_IN_LAYER_KINDS, checkPatternRecipe, readPatternRecipe, type BuiltInLayerKind, type LayerKind, type PatternRecipe,
} from './patternRecipe.js'
import {
  PRODUCT_TYPES, PRODUCT_TYPE_LABEL, editableMeasures, granularityKey, readProductType, requiredMeasures,
  scopeTypeForProduct, type MeasureField, type ProductType, type Specifications,
} from './specs.js'

export interface ProductLayerInfo {
  id: string
  name: string
  kind: LayerKind | 'manual'
  draft: boolean
}

export interface ProductDefinition {
  productType: ProductType
  /** The type for a built-in, `pattern:<slug>` for a pattern. */
  id: string
  label: string
  builtIn: boolean
  measuredAs: 'area' | 'linear' | 'count' | null
  /** Counts proven (built-in) or approved by a person (pattern). */
  verified: boolean
  /** A pattern, or a layer of one, waiting for a person. */
  draft: boolean
  layers: ProductLayerInfo[]
  fields: MeasureField[]
  required: MeasureField[]
}

const LAYER_NAME: Record<Exclude<ProductType, 'custom_pattern'>, string> = {
  panels: 'Panels', planks: 'Planks', baffle: 'Baffles', baffle_cassette: 'Cassettes',
  linear_parts: 'Linear parts', custom_assembly: 'Counted by hand',
}

export function builtInDefinition(product: Exclude<ProductType, 'custom_pattern'>): ProductDefinition {
  return {
    productType: product,
    id: product,
    label: PRODUCT_TYPE_LABEL[product],
    builtIn: true,
    measuredAs: scopeTypeForProduct(product),
    verified: isVerifiedProduct(product),
    draft: false,
    layers: [{ id: product, name: LAYER_NAME[product], kind: product === 'custom_assembly' ? 'manual' : product, draft: false }],
    fields: editableMeasures(product),
    required: requiredMeasures(product),
  }
}

/** The built-in products as definitions, in menu order. */
export const BUILT_IN_PRODUCTS: readonly ProductDefinition[] =
  PRODUCT_TYPES.filter((p): p is Exclude<ProductType, 'custom_pattern'> => p !== 'custom_pattern').map(builtInDefinition)

/** A pattern recipe as a definition. A recipe that does not check still gets a definition, named, with no layers. */
export function patternDefinition(raw: unknown): ProductDefinition {
  const check = checkPatternRecipe(raw)
  const name = check.ok ? check.recipe.name
    : typeof (raw as { name?: unknown } | null)?.name === 'string' ? String((raw as { name: string }).name) : 'Custom pattern'
  return {
    productType: 'custom_pattern',
    id: `pattern:${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    label: name,
    builtIn: false,
    measuredAs: 'area',
    verified: check.ok && !check.resolved.draft,
    draft: !check.ok || check.resolved.draft,
    layers: check.ok ? check.resolved.layers.map((l) => ({ id: l.id, name: l.name, kind: l.kind, draft: l.draft })) : [],
    fields: [],
    required: [],
  }
}

/** The definition of whatever product a scope is. */
export function productDefinitionFor(specs: Specifications): ProductDefinition {
  const product = readProductType(specs)
  if (product === 'custom_pattern') return patternDefinition(readPatternRecipe(specs) ?? {})
  return builtInDefinition(product)
}

/** What to call a scope's product: the pattern's own name, or the type's. */
export function productLabelFor(specs: Specifications): string {
  return productDefinitionFor(specs).label
}

/**
 * What to call a scope's product, the scope's measure included.
 *
 * Kenneth, 2026-11-26: a count, or a length, should be a kind of scope in its
 * own right, "for example, number of light fixture integrations or number of
 * felt clouds", "linear feet of wall or individual linear feet of baffle".
 * Both are a custom assembly measured as counts or lengths underneath; this
 * is the name they go by everywhere a person reads it.
 */
export function scopeProductLabel(scope: { scopeType: 'area' | 'linear' | 'count'; specifications: Specifications }): string {
  const label = productLabelFor(scope.specifications)
  if (readProductType(scope.specifications) !== 'custom_assembly') return label
  if (scope.scopeType === 'count') return 'Count'
  if (scope.scopeType === 'linear') return 'Length'
  return label
}

/** Keys of a built-in scope's specification that describe the PRODUCT (not where it is laid). */
function productKeys(product: BuiltInLayerKind): string[] {
  const keys: string[] = []
  for (const f of editableMeasures(product)) keys.push(f.valueKey, f.unitKey)
  keys.push(granularityKey(product), 'alignSeams', 'profileWidthInches')
  return keys
}

/**
 * A built-in scope as a one-layer recipe, so layers can be added on top of it
 * (rails under panels, hardware on baffles) without the product changing.
 * The count of that layer is the built-in engine's, unchanged. Null for a
 * product counted by hand, which has nothing to lay a layer on.
 */
export function builtInAsRecipe(specs: Specifications, name: string): PatternRecipe | null {
  const product = readProductType(specs)
  if (!(BUILT_IN_LAYER_KINDS as readonly string[]).includes(product)) return null
  const kind = product as BuiltInLayerKind
  const layerSpecs: Record<string, unknown> = {}
  for (const k of productKeys(kind)) if (specs[k] !== undefined) layerSpecs[k] = specs[k]
  return {
    version: 1,
    name,
    status: 'approved',
    layers: [{ id: kind, kind, name: LAYER_NAME[kind], specifications: layerSpecs }],
  }
}
