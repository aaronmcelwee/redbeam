/**
 * The primitive viewer (Aaron, 2026-11-27): what a stored primitive is
 * built on and what it is made of, in one place. One island drawn to scale
 * with its pieces, seams and hangers; the rules it follows; every variable
 * with its value, its default and the areas that differ; the component sizes
 * (member section, longest piece, largest opening) and the suspension.
 *
 * Read only. Values change through the agent tools or Setup, never here.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  drawPrimitiveArea, formatPieceLength, GENERATORS,
  type PieceResult, type PrimitiveParam, type ScopePrimitive,
} from '@redbeam/domain'

const GROUP_ORDER = ['Layout', 'Members', 'Factory pieces', 'Suspension', 'Island size']

const inch = (v: number): string => formatPieceLength(v).replace(/in$/, '"')
/** A centreline as typed: 207.125, never 207.12499999999997. */
const figure = (v: number): string => String(Math.round(v * 1000) / 1000)

function valueText(p: PrimitiveParam, v: unknown): string {
  if (v === undefined || v === null || v === '') return '—'
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'number' ? `${figure(x)}"` : String(x))).join(', ')
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (typeof v === 'number') return p.kind === 'angle' ? `${figure(v)}°` : p.kind === 'measure' ? `${figure(v)}"` : figure(v)
  return String(v)
}

/** Gaps between member faces across a span: the openings a person sees. */
function openings(centres: readonly number[], span: number, face: number, frame: number): number[] {
  const faces = [frame, ...[...centres].sort((a, b) => a - b).flatMap((c) => [c - face / 2, c + face / 2]), span - frame]
  const out: number[] = []
  for (let i = 0; i + 1 < faces.length; i += 2) out.push(faces[i + 1]! - faces[i]!)
  return out
}

export function PrimitiveViewer({ prim, pieces, onClose }: {
  prim: ScopePrimitive
  pieces: PieceResult | undefined
  onClose: () => void
}) {
  const d = prim.definition
  const gen = GENERATORS[d.generator]
  const areas = pieces?.primitive?.areas ?? []
  const [areaId, setAreaId] = useState<string | null>(areas[0]?.markupId ?? null)
  const area = areas.find((a) => a.markupId === areaId) ?? null
  const drawing = useMemo(
    () => drawPrimitiveArea(prim, area?.markupId ?? null, area !== null ? area.used : undefined),
    [prim, area],
  )
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    dialog.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const v = drawing.values
  const num = (k: string): number | null => (typeof v[k] === 'number' ? (v[k] as number) : null)
  const list = (k: string): number[] => (Array.isArray(v[k]) ? (v[k] as number[]) : [])
  const face = num('memberWidth') ?? 0
  const frameW = v['frame'] === 'none' ? 0 : face
  const L = drawing.length, W = drawing.width

  // Variables, grouped as the generator lists them.
  const areaMap = prim.areas ?? {}
  const differ = (k: string) => Object.values(areaMap).filter((a) => a[k] !== undefined && a[k] !== null).length
  const groups = GROUP_ORDER
    .map((g) => ({ title: g, params: d.parameters.filter((p) => (p.group ?? gen?.schema.find((s) => s.key === p.key)?.group ?? 'Layout') === g) }))
    .filter((g) => g.params.length > 0)

  // Components, sized from this island.
  const longest = drawing.pieces.reduce((m, p) => Math.max(m, p.length), 0)
  const openAlong = openings(list('crossPositions'), L, face, frameW)
  const openAcross = openings(list('mainPositions'), W, face, frameW)
  const skus = new Map<string, { n: number; len: number }>()
  for (const p of drawing.pieces) { const s = skus.get(p.sku); skus.set(p.sku, { n: (s?.n ?? 0) + 1, len: p.length }) }
  const hw = (k: string) => drawing.hardware.find((h) => h.key === k)?.qty ?? 0

  // Hangers: the widest gap between two on one run.
  const byRun = new Map<number, number[]>()
  for (const [a, c] of drawing.hangers) byRun.set(c, [...(byRun.get(c) ?? []), a])
  let widest = 0
  for (const xs of byRun.values()) { xs.sort((a, b) => a - b); for (let i = 1; i < xs.length; i++) widest = Math.max(widest, xs[i]! - xs[i - 1]!) }

  // The drawing: along the mains left to right, across top to bottom, inches.
  const pad = Math.max(L, W) * 0.09
  // Room on the right for the main centrelines' figures.
  const vb = `${-pad} ${-pad} ${L + 2.6 * pad} ${W + 2 * pad}`
  const fs = Math.max(L, W) * 0.026
  const familyClass = (f: string) => (f.startsWith('Frame') ? 'pv-frame' : f === 'Main' ? 'pv-main' : 'pv-cross')

  return (
    <div className="pv-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="pv-dialog" role="dialog" aria-modal="true" aria-labelledby="pv-title" tabIndex={-1} ref={dialog}>
        <header className="pv-head">
          <div>
            <h2 id="pv-title">{d.name}</h2>
            <div className="pv-sub">
              {gen?.label ?? d.generator} · version {d.primitiveVersion}
              <span className={d.status === 'draft' ? 'pt-pill draft' : 'pt-pill ok'}>{d.status === 'draft' ? 'Draft' : 'Approved'}</span>
            </div>
          </div>
          <button type="button" className="es-btn subtle" onClick={onClose} aria-label="Close">Close</button>
        </header>
        <div className="pv-body">
          <section className="pv-left" aria-label="Drawing">
            <div className="pv-pick">
              <label htmlFor="pv-area">Island</label>
              <select id="pv-area" className="es-field" value={areaId ?? ''} onChange={(e) => setAreaId(e.target.value === '' ? null : e.target.value)}>
                {areas.length === 0 && <option value="">Typical (no areas yet)</option>}
                {areas.map((a, i) => (
                  <option key={a.markupId} value={a.markupId}>
                    {`Island ${i + 1} · ${formatPieceLength(a.used.length)} × ${formatPieceLength(a.used.width)}${a.overrides.filter((k) => k !== 'length' && k !== 'width').length > 0 ? ' · own values' : ''}`}
                  </option>
                ))}
              </select>
            </div>
            {drawing.errors.length > 0
              ? <div className="pv-errors">{drawing.errors.map((e) => <div key={e}>{e}</div>)}</div>
              : (
                <svg className="pv-svg" viewBox={vb} role="img" aria-label={`${d.name}, ${formatPieceLength(L)} by ${formatPieceLength(W)}`}>
                  <rect x={0} y={0} width={L} height={W} className="pv-outline" />
                  {drawing.pieces.map((p, i) => {
                    const [a0, a1, c0, c1] = p.rect
                    return <rect key={i} x={a0} y={c0} width={a1 - a0} height={c1 - c0} className={familyClass(p.family)}><title>{p.sku}</title></rect>
                  })}
                  {drawing.seams.map(([a, c], i) => (
                    <circle key={`s${i}`} cx={a} cy={c} r={Math.max(face * 1.4, fs * 0.35)} className="pv-seam"><title>Seam</title></circle>
                  ))}
                  {drawing.hangers.map(([a, c], i) => (
                    <circle key={`h${i}`} cx={a} cy={c} r={Math.max(face * 0.8, fs * 0.22)} className="pv-hanger"><title>Hanger</title></circle>
                  ))}
                  {/* Overall sizes. */}
                  <text x={L / 2} y={-pad * 0.45} className="pv-dim" fontSize={fs} textAnchor="middle">{formatPieceLength(L)} along the mains</text>
                  <text x={-pad * 0.45} y={W / 2} className="pv-dim" fontSize={fs} textAnchor="middle" transform={`rotate(-90 ${-pad * 0.45} ${W / 2})`}>{formatPieceLength(W)}</text>
                  {/* Centrelines, where they are measured from. */}
                  {list('crossPositions').map((x) => (
                    <text key={`cx${x}`} x={x} y={W + pad * 0.55} className="pv-tick" fontSize={fs * 0.8} textAnchor="middle">{figure(x)}</text>
                  ))}
                  {list('mainPositions').map((y) => (
                    <text key={`my${y}`} x={L + pad * 0.12} y={y + fs * 0.28} className="pv-tick" fontSize={fs * 0.8}>{figure(y)}</text>
                  ))}
                </svg>
                )}
            <ul className="pv-legend">
              <li><span className="pv-key pv-frame" />Frame</li>
              <li><span className="pv-key pv-main" />Mains</li>
              <li><span className="pv-key pv-cross" />Cross members</li>
              <li><span className="pv-key round pv-seam" />Seams ({hw('seams')})</li>
              <li><span className="pv-key round pv-hanger" />Hangers ({drawing.hangers.length})</li>
            </ul>
            <div className="pv-note">Centrelines in inches, mains from the top edge, cross members from the left edge.</div>
          </section>
          <section className="pv-right">
            <h3>Design basis</h3>
            <ol className="pv-rules">{(gen?.rules ?? []).map((r) => <li key={r}>{r}</li>)}</ol>

            <h3>Components</h3>
            <dl className="pv-kv">
              <dt>Member section</dt><dd>{num('memberWidth') !== null ? `${num('memberWidth')}" face × ${num('memberDepth') ?? '—'}" deep` : '—'}</dd>
              <dt>Longest factory piece</dt><dd>{num('maxPiece') !== null ? formatPieceLength(num('maxPiece')!) : '—'}{longest > 0 ? ` (longest cut here ${formatPieceLength(longest)})` : ''}</dd>
              <dt>Frame</dt><dd>{String(v['frame'] ?? '—')}{v['frame'] === 'mitred' ? `, ${hw('mitred-corners')} mitred corners` : ''}</dd>
              <dt>Where members meet</dt><dd>{String(v['crossJoin'] ?? '—')}, {hw('crossings')} crossings</dd>
              <dt>Largest opening</dt><dd>{openAlong.length > 0 && openAcross.length > 0 ? `${inch(Math.max(...openAlong))} × ${inch(Math.max(...openAcross))} clear` : '—'}</dd>
              <dt>Smallest opening</dt><dd>{openAlong.length > 0 && openAcross.length > 0 ? `${inch(Math.min(...openAlong))} × ${inch(Math.min(...openAcross))} clear` : '—'}</dd>
            </dl>
            <table className="pv-skus">
              <thead><tr><th>Piece</th><th>Count</th><th>LF</th></tr></thead>
              <tbody>
                {[...skus.entries()].map(([sku, s]) => (
                  <tr key={sku}><td>{sku}</td><td>{s.n}</td><td>{Math.round((s.n * s.len) / 12 * 10) / 10}</td></tr>
                ))}
              </tbody>
            </table>

            <h3>Suspension</h3>
            <dl className="pv-kv">
              <dt>Hanger spacing (max)</dt><dd className={num('hangerSpacing') === null ? 'pv-ask' : ''}>{num('hangerSpacing') !== null ? `${num('hangerSpacing')}"` : 'Not set: ask before pricing'}</dd>
              <dt>First hanger from the end</dt><dd>{num('hangerFromEnd') ? `${num('hangerFromEnd')}"` : 'At the ends'}</dd>
              <dt>Carried on</dt><dd>Every main and frame main</dd>
              <dt>Hangers on this island</dt><dd>{drawing.hangers.length > 0 ? `${drawing.hangers.length}, at most ${inch(widest)} apart` : '—'}</dd>
            </dl>

            <h3>Variables</h3>
            {groups.map((g) => (
              <div key={g.title} className="pv-group">
                <div className="pv-group-title">{g.title}</div>
                <table className="pv-vars">
                  <tbody>
                    {g.params.map((p) => {
                      const n = differ(p.key)
                      const scopeV = prim.parameters[p.key]
                      return (
                        <tr key={p.key}>
                          <th scope="row">
                            {p.label}{p.required === true && <span className="pv-req" title="Required">*</span>}
                            <div className="pv-key-name">{p.key}</div>
                          </th>
                          <td>
                            <div>{(p.key === 'length' || p.key === 'width') && (scopeV ?? null) === null ? 'From the drawing' : valueText(p, scopeV ?? p.default)}</div>
                            {scopeV !== undefined && scopeV !== null && p.default !== undefined && p.default !== null && <div className="pv-default">default {valueText(p, p.default)}</div>}
                            {n > 0 && <span className="pt-pill agent">{n === 1 ? '1 area differs' : `${n} areas differ`}</span>}
                            {p.help !== undefined && <div className="pv-help">{p.help}</div>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ))}
          </section>
        </div>
      </div>
    </div>
  )
}
