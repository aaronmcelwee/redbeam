/**
 * A stored primitive in a scope's Setup (Aaron, 2026-11-27).
 *
 * The primitive's name, version and who saved it, its values (with how many
 * areas override each), and, while it is a draft, the one place a person
 * approves it. Approving approves that VERSION in the library, once, so the
 * next job finds it approved. Agents cannot reach the button: the bridge has
 * no action for it.
 */
import type { PieceResult, PrimitiveParam } from '@redbeam/domain'
import { readScopePrimitive } from '@redbeam/domain'

export interface PrimitiveControls {
  onApprove: (scopeId: string) => void
  onDiscard: (scopeId: string) => void
  /** The library's newest approved version when it is newer than the scope's, else null. */
  newerVersion: (id: string, version: number) => number | null
  onUpdate: (scopeId: string) => void
}

function show(p: PrimitiveParam, v: unknown): string {
  if (v === undefined || v === null || v === '') return '—'
  const unit = p.kind === 'measure' || p.kind === 'measures' ? (p.unit ?? 'in') : p.kind === 'angle' ? '°' : ''
  const u = unit === 'in' ? '"' : unit === '°' ? '°' : unit === '' ? '' : ` ${unit}`
  if (Array.isArray(v)) return v.map((x) => `${String(x)}${u}`).join(', ')
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  return `${String(v)}${typeof v === 'number' ? u : ''}`
}

/** The layout's warnings for a person: how many areas are sized off their outline, not each markup id. */
function offSize(warnings: readonly string[]): string {
  const areas = new Set(warnings.map((w) => /^area ([^:]+):/.exec(w)?.[1]).filter((x): x is string => x !== undefined))
  const other = warnings.filter((w) => !/^area [^:]+:/.test(w))
  const bits = [
    ...(areas.size > 0 ? [`${areas.size} area${areas.size === 1 ? ' is' : 's are'} counted at a size more than 3% off the drawn outline. Check the stated length and width.`] : []),
    ...other,
  ]
  return bits.join(' ')
}

export function PrimitiveCard({ scopeId, specs, pieces, controls }: {
  scopeId: string
  specs: Record<string, unknown>
  pieces: PieceResult | undefined
  controls: PrimitiveControls
}) {
  const prim = readScopePrimitive(specs)
  if (prim === null) return null
  if ('error' in prim) {
    return (
      <div className="pt-card warn">
        <div className="pt-head"><b>Primitive</b><span className="pt-pill draft">Needs fixing</span></div>
        <div className="es-muted">{prim.error}</div>
        <div className="pt-btns"><button type="button" className="es-btn tiny" onClick={() => controls.onDiscard(scopeId)}>Discard</button></div>
      </div>
    )
  }
  const d = prim.definition
  const draft = d.status === 'draft'
  const areas = prim.areas ?? {}
  const overrides = (key: string) => Object.values(areas).filter((a) => a[key] !== undefined && a[key] !== null).length
  const shown = d.parameters.filter((p) => {
    const v = prim.parameters[p.key] ?? p.default
    return (v !== undefined && v !== null) || overrides(p.key) > 0 || p.required === true
  })
  const newer = controls.newerVersion(d.id, d.primitiveVersion)
  const summary = pieces?.primitive
  return (
    <div className="pt-wrap">
      <div className="pt-card">
        <div className="pt-head">
          <b className="pt-name">{d.name}</b>
          {d.source !== undefined && draft && <span className="pt-pill agent">From {d.source}</span>}
          <span className={draft ? 'pt-pill draft' : 'pt-pill ok'}>{draft ? 'Draft' : 'Approved'}</span>
        </div>
        <div className="es-muted">Primitive, version {d.primitiveVersion}{d.description !== undefined ? ` · ${d.description}` : ''}</div>
        <div className="pm-params" role="list" aria-label="Parameters">
          {shown.map((p) => {
            const n = overrides(p.key)
            return (
              <div className="pm-param" role="listitem" key={p.key}>
                <span className="pm-k">{p.label}</span>
                <span className="pm-v">
                  {(p.key === 'length' || p.key === 'width') && (prim.parameters[p.key] ?? null) === null ? 'From the drawing' : show(p, prim.parameters[p.key] ?? p.default)}
                  {n > 0 && <span className="pt-pill agent">{n} area{n === 1 ? '' : 's'} differ</span>}
                </span>
              </div>
            )
          })}
        </div>
        {summary !== undefined && summary.blockers.length === 0 && (
          <div className="es-muted">{summary.areas.length} area{summary.areas.length === 1 ? '' : 's'} · {summary.totalPieces} pieces · {summary.skus.length} SKUs · {Math.round(summary.totalLinearFeet)} LF</div>
        )}
        {(summary?.warnings ?? []).length > 0 && (
          <div className="es-muted es-warnink">
            {offSize(summary?.warnings ?? [])}
          </div>
        )}
      </div>
      {draft && (
        <div className="pt-card warn">
          <b>Check the cut list against the drawing, then approve</b>
          <div className="es-muted">Approving keeps version {d.primitiveVersion} in your library, so later jobs start from it. Until then its counts show as unverified.</div>
          <div className="pt-btns">
            <button type="button" className="es-btn primary" onClick={() => controls.onApprove(scopeId)}>Approve primitive</button>
            <button type="button" className="es-btn subtle" onClick={() => controls.onDiscard(scopeId)}>Discard</button>
          </div>
        </div>
      )}
      {newer !== null && (
        <div className="pt-card">
          <div className="es-muted">The library has version {newer} of this primitive. This scope keeps version {d.primitiveVersion} until you update it.</div>
          <div className="pt-btns"><button type="button" className="es-btn tiny" onClick={() => controls.onUpdate(scopeId)}>Update to version {newer}</button></div>
        </div>
      )}
    </div>
  )
}
