/**
 * The piece list a run product is cut into (Aaron, 2026-11-24, round 3 #14):
 * every run with its pieces and their cut lengths, including the ones cut to
 * fit at an edge or along a curve, how the stock lengths are used, and the
 * parts that go with them.
 *
 * Read from the layout the counts already come from (PieceResult.runs), so
 * the list and the BOM cannot disagree.
 */
import { formatFeetInches, type PieceResult, type Point, type Segment } from '@redbeam/domain'

export interface CutPiece {
  /** Installed length: what is inside the area. */
  cutFeet: number
  cut: string
  /** Stock length this piece is cut from, as a fraction. */
  stockFraction: number
  family: string
  /** Cut to fit at an edge, a cutout or a curve rather than a standard length. */
  cutToFit: boolean
  /** Waste hanging past the area that is bought and cut off. */
  offcutFeet: number
  startCap: boolean
  endCap: boolean
  connectors: number
}

export interface RunList {
  pageId: string
  /** Index of the area on that page, in layout order. */
  area: number
  run: number
  lengthFeet: number
  length: string
  pieces: CutPiece[]
}

export interface PieceList {
  productType: string
  feetPerPoint: number | null
  runs: RunList[]
  /** Identical cuts counted, longest first: the cutting list. */
  cutList: Array<{ cut: string; cutFeet: number; count: number; cutToFit: boolean }>
  stock: {
    piecesPlaced: number
    stockLengthsUsed: number
    byFamily: Record<string, number>
    installedFeet: number
    offcutFeet: number
  }
  rails: { pieces: number; installedFeet: number }
  /** Connectors, end caps, joiners, trim and the rest, from the same roll-up as the BOM. */
  parts: Array<{ itemKey: string; label: string; quantity: number; unit: string }>
  truncated?: boolean
}

const len = (s: Segment) => Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y)
const r3 = (n: number) => Math.round(n * 1000) / 1000
const mid = (s: Segment): Point => ({ x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 })

/** Distance from p to the infinite line through s, and whether p projects inside s. */
function onSegment(p: Point, s: Segment): number {
  const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y
  const L2 = dx * dx + dy * dy
  if (L2 === 0) return Math.hypot(p.x - s.a.x, p.y - s.a.y)
  const t = ((p.x - s.a.x) * dx + (p.y - s.a.y) * dy) / L2
  if (t < -0.01 || t > 1.01) return Infinity
  return Math.abs((p.x - s.a.x) * dy - (p.y - s.a.y) * dx) / Math.sqrt(L2)
}

export function pieceList(result: PieceResult, opts: { maxRuns?: number } = {}): PieceList {
  const runs: RunList[] = []
  const cuts = new Map<string, { cut: string; cutFeet: number; count: number; cutToFit: boolean }>()
  const byFamily: Record<string, number> = {}
  let placed = 0, stockUsed = 0, installed = 0, offcut = 0, railPieces = 0, railFeet = 0
  let fpp: number | null = null
  const areaOnPage = new Map<string, number>()
  const maxRuns = opts.maxRuns ?? 2000
  let truncated = false
  for (const entry of result.runs) {
    fpp = entry.feetPerPoint
    const area = areaOnPage.get(entry.pageId) ?? 0
    areaOnPage.set(entry.pageId, area + 1)
    const lists: RunList[] = entry.layout.segments.map((s, i) => ({
      pageId: entry.pageId, area, run: i, lengthFeet: r3(len(s) * entry.feetPerPoint),
      length: formatFeetInches(len(s) * entry.feetPerPoint), pieces: [],
    }))
    for (const p of entry.layout.pieces) {
      const inside = len(p.insideSegment) * entry.feetPerPoint
      const full = len(p.fullSegment) * entry.feetPerPoint
      const cutToFit = Math.abs(p.stockFraction - Math.round(p.stockFraction * 4) / 4) > 1e-6 || full - inside > 1 / 96
      const piece: CutPiece = {
        cutFeet: r3(inside), cut: formatFeetInches(inside), stockFraction: r3(p.stockFraction), family: p.family,
        cutToFit, offcutFeet: r3(Math.max(0, full - inside)), startCap: p.startCap, endCap: p.endCap,
        connectors: p.connectorPoints.length,
      }
      placed++; stockUsed += p.stockFraction; installed += inside; offcut += Math.max(0, full - inside)
      byFamily[p.family] = (byFamily[p.family] ?? 0) + 1
      const key = `${piece.cut}|${cutToFit}`
      const c = cuts.get(key)
      if (c) c.count++
      else cuts.set(key, { cut: piece.cut, cutFeet: piece.cutFeet, count: 1, cutToFit })
      const m = mid(p.insideSegment)
      let best = -1, bestD = Infinity
      lists.forEach((l, i) => {
        const d = onSegment(m, entry.layout.segments[i]!)
        if (d < bestD) { bestD = d; best = i }
      })
      if (best >= 0 && bestD < 1) lists[best]!.pieces.push(piece)
    }
    for (const r of entry.layout.railPieces) { railPieces++; railFeet += len(r.insideSegment) * entry.feetPerPoint }
    for (const l of lists) {
      if (l.pieces.length === 0) continue
      if (runs.length >= maxRuns) { truncated = true; break }
      runs.push(l)
    }
  }
  return {
    productType: result.productType,
    feetPerPoint: fpp,
    runs,
    cutList: [...cuts.values()].sort((a, b) => b.cutFeet - a.cutFeet),
    stock: {
      piecesPlaced: placed, stockLengthsUsed: r3(stockUsed), byFamily,
      installedFeet: r3(installed), offcutFeet: r3(offcut),
    },
    rails: { pieces: railPieces, installedFeet: r3(railFeet) },
    parts: result.quantities.map((q) => ({ ...q })),
    ...(truncated ? { truncated: true } : {}),
  }
}
