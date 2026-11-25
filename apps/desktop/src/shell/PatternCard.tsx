/**
 * A custom pattern in a scope's Setup (beta, Aaron 2026-11-25).
 *
 * The pattern's name and who made it, its layers with a swatch in the colour
 * the sheet draws them in and a Shown/Hidden switch each, and, while any of
 * it is a draft, the one place a person approves it. Agents cannot reach the
 * approve buttons: the bridge has no action for them.
 *
 * The mockups Aaron approved: custom-patterns/1, 4 and 5 in the project files.
 */
import type { PatternRecipe, PieceResult } from '@redbeam/domain'
import { checkPatternRecipe, draftLayers } from '@redbeam/domain'
import { patternLayerColor } from '../layout/drawLayout.js'

export interface PatternControls {
  /** Settings › Beta › Custom patterns. Off: nothing new is offered, but a scope that has a pattern still shows it. */
  enabled: boolean
  library: ReadonlyArray<{ id: string; name: string; version: number }>
  hiddenLayers: ReadonlyMap<string, ReadonlySet<string>>
  onToggleLayer: (scopeId: string, layerId: string) => void
  /** Approve the whole pattern; with addToLibrary, keep it for other jobs too. */
  onApprove: (scopeId: string, addToLibrary: boolean) => void
  onApproveLayer: (scopeId: string, layerId: string) => void
  onDiscardLayer: (scopeId: string, layerId: string) => void
  /** Take the pattern off the scope (back to Panels with no sizes). */
  onDiscard: (scopeId: string) => void
  onUsePattern: (scopeId: string, patternId: string) => void
  onUpdateFromLibrary: (scopeId: string) => void
  /** A built-in product, as a one-layer pattern, so layers can go on it. */
  onMakePattern: (scopeId: string) => void
  /** The library's version of this scope's pattern when it is newer, else null. */
  newerVersion: (recipe: PatternRecipe) => number | null
}

const KIND_TEXT: Record<string, string> = {
  tiles: 'tiles', members: 'set runs', lines: 'runs', hardware: 'hardware',
  panels: 'panels', planks: 'planks', baffle: 'baffles', baffle_cassette: 'cassettes', linear_parts: 'linear parts',
}

function layerLine(l: PatternRecipe['layers'][number]): string {
  switch (l.kind) {
    case 'tiles': return `${l.tiles.length} tile${l.tiles.length === 1 ? '' : 's'} a module${l.joint !== undefined ? ` · ${l.joint} joint` : ''}`
    case 'members': return `${l.members.length} in a module${l.stock !== undefined ? ` · ${l.stock} stock` : ''}`
    case 'lines': return `${l.run === 'across' ? 'Across' : 'Along'} the pattern · ${l.spacing} OC${l.stock !== undefined ? ` · ${l.stock} stock` : ''}`
    case 'hardware': return l.items.map((i) => i.name).join(', ')
    default: return `Built-in ${KIND_TEXT[l.kind] ?? l.kind}, counted as a ${KIND_TEXT[l.kind] ?? l.kind} scope`
  }
}

export function PatternCard({ scopeId, scopeColor, raw, pieces, controls }: {
  scopeId: string
  scopeColor: string
  raw: unknown
  pieces: PieceResult | undefined
  controls: PatternControls
}) {
  const check = checkPatternRecipe(raw)
  if (!check.ok) {
    return (
      <div className="pt-card warn">
        <div className="pt-head"><b>Pattern</b><span className="pt-pill draft">Needs fixing</span></div>
        <div className="es-muted">{check.errors.slice(0, 3).join(' · ')}</div>
        <div className="pt-btns"><button type="button" className="es-btn tiny" onClick={() => controls.onDiscard(scopeId)}>Discard</button></div>
      </div>
    )
  }
  const recipe = check.recipe
  const drafts = draftLayers(recipe)
  const wholeDraft = recipe.status === 'draft'
  const hidden = controls.hiddenLayers.get(scopeId)
  const newer = controls.newerVersion(recipe)
  const layers = pieces?.layers ?? check.resolved.layers.map((l) => ({ id: l.id, name: l.name, kind: l.kind, draft: l.draft }))
  return (
    <div className="pt-wrap">
      <div className="pt-card">
        <div className="pt-head">
          <b className="pt-name">{recipe.name}</b>
          {recipe.source !== undefined && wholeDraft && <span className="pt-pill agent">From {recipe.source}</span>}
          <span className={wholeDraft ? 'pt-pill draft' : 'pt-pill ok'}>{wholeDraft ? 'Draft' : 'Approved'}</span>
        </div>
        {recipe.description !== undefined && <div className="es-muted">{recipe.description}</div>}
        {!wholeDraft && recipe.approvedBy !== undefined && recipe.approvedBy !== '' && (
          <div className="es-muted">Approved{recipe.libraryId !== undefined ? ` · in the library, version ${recipe.libraryVersion ?? 1}` : ' for this scope'}</div>
        )}
        <div className="pt-layers" role="list" aria-label="Layers">
          {layers.map((l, i) => {
            const spec = recipe.layers.find((x) => x.id === l.id)
            const off = hidden?.has(l.id) ?? false
            const draft = !wholeDraft && drafts.some((d) => d.id === l.id)
            return (
              <div className="pt-layer" role="listitem" key={l.id}>
                <i className="pt-sw" style={{ background: patternLayerColor(scopeColor, i, l.kind) }} />
                <span className="pt-ln">
                  <span>{l.name}{draft && <span className="pt-pill draft">Draft</span>}</span>
                  {spec !== undefined && <small>{layerLine(spec)}</small>}
                </span>
                <button
                  type="button"
                  className={off ? 'es-btn tiny subtle' : 'es-btn tiny subtle on'}
                  aria-pressed={!off}
                  aria-label={`${off ? 'Show' : 'Hide'} ${l.name} on the sheet`}
                  onClick={() => controls.onToggleLayer(scopeId, l.id)}
                >{off ? 'Hidden' : 'Shown'}</button>
                {draft && (
                  <span className="pt-layeracts">
                    <button type="button" className="es-btn tiny primary" onClick={() => controls.onApproveLayer(scopeId, l.id)}>Approve {l.name}</button>
                    <button type="button" className="es-btn tiny" onClick={() => controls.onDiscardLayer(scopeId, l.id)}>Discard</button>
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>
      {wholeDraft && (
        <div className="pt-card warn">
          <b>Check the layout on the sheet, then keep it</b>
          <div className="es-muted">Counts from a draft pattern show as unverified in the estimate until you approve it.</div>
          <div className="pt-btns">
            <button type="button" className="es-btn primary" onClick={() => controls.onApprove(scopeId, true)}>Approve, add to library</button>
            <button type="button" className="es-btn" onClick={() => controls.onApprove(scopeId, false)}>Use here only</button>
            <button type="button" className="es-btn subtle" onClick={() => controls.onDiscard(scopeId)}>Discard</button>
          </div>
        </div>
      )}
      {newer !== null && (
        <div className="pt-card">
          <div className="es-muted">The library has version {newer} of this pattern. This scope keeps its own copy until you update it.</div>
          <div className="pt-btns"><button type="button" className="es-btn tiny" onClick={() => controls.onUpdateFromLibrary(scopeId)}>Update to version {newer}</button></div>
        </div>
      )}
    </div>
  )
}
