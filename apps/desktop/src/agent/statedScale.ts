/**
 * The scales a sheet states, read off its text, and a check of the scale
 * against a written dimension (round 3 #7).
 *
 * A sheet says its scale under each drawing title ("1/8" = 1'-0"") and in the
 * title block, and a detail sheet says several. Each statement is returned
 * with where it is, so the one under a drawing can be matched to that drawing
 * (and to a scale region drawn around it).
 */
import { matchPreset, parseMeasureFeet, POINTS_PER_INCH } from '@redbeam/domain'
import type { NormBox } from '@redbeam/viewer'

export interface StatedScale {
  /** As printed, e.g. `1/8" = 1'-0"`. */
  text: string
  feetPerDrawingInch: number
  feetPerPoint: number
  /** The preset to pass to set_page_scale / set_region_scale, when one matches. */
  presetId: string | null
  box: NormBox | null
}

export interface StatedScaleNote {
  /** "AS NOTED", "NTS" and the like: a sheet that states no single scale. */
  text: string
  box: NormBox | null
}

const norm = (s: string) => s.replace(/[″”“]/g, '"').replace(/[′’‘]/g, "'")

/** A number, a fraction, or a mixed number: 1/8, 3/16, 1 1/2, 1-1/2, 0.125. */
const NUM = String.raw`(\d+(?:[ -]\d+\/\d+)?(?:\/\d+)?|\d*\.\d+)`
const ARCH = new RegExp(String.raw`${NUM}\s*"\s*=\s*(\d+)\s*'\s*(?:-?\s*(\d+(?:\.\d+)?)\s*"?)?`, 'g')
const ENG = new RegExp(String.raw`1\s*"\s*=\s*(\d+(?:\.\d+)?)\s*'(?!\s*-?\s*\d)`, 'g')
const METRIC = /(?<![\d.:/])1\s*:\s*(\d{1,4})(?![\d:])/g
const NOTE = /\b(?:SCALE\s*:?\s*)?(AS NOTED|AS SHOWN|NTS|N\.T\.S\.|NOT TO SCALE)\b/gi

function frac(t: string): number | null {
  const s = t.trim().replace('-', ' ')
  const mixed = /^(\d+)\s+(\d+)\/(\d+)$/.exec(s)
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3])
  const f = /^(\d+)\/(\d+)$/.exec(s)
  if (f) return Number(f[2]) === 0 ? null : Number(f[1]) / Number(f[2])
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

type Runs = ReadonlyArray<{ start: number; length: number; x0: number; y0: number; x1: number; y1: number }>
function boxOf(runs: Runs | undefined, at: number, end: number): NormBox | null {
  if (!runs) return null
  const hit = runs.filter((r) => r.start < end && r.start + r.length > at)
  if (hit.length === 0) return null
  const r5 = (n: number) => Math.round(n * 1e5) / 1e5
  return {
    x0: r5(Math.min(...hit.map((r) => r.x0))), y0: r5(Math.min(...hit.map((r) => r.y0))),
    x1: r5(Math.max(...hit.map((r) => r.x1))), y1: r5(Math.max(...hit.map((r) => r.y1))),
  }
}

export function statedScales(page: { text: string; runs?: Runs }): { scales: StatedScale[]; notes: StatedScaleNote[] } {
  const text = norm(page.text)
  const scales: StatedScale[] = []
  const taken: Array<[number, number]> = []
  const push = (at: number, end: number, feetPerDrawingInch: number) => {
    if (!(feetPerDrawingInch > 0) || !Number.isFinite(feetPerDrawingInch)) return
    if (taken.some(([a, b]) => at < b && end > a)) return
    taken.push([at, end])
    const fpp = feetPerDrawingInch / POINTS_PER_INCH
    scales.push({
      text: page.text.slice(at, end).replace(/\s+/g, ' ').trim(),
      feetPerDrawingInch: Math.round(feetPerDrawingInch * 1e6) / 1e6,
      feetPerPoint: fpp,
      presetId: matchPreset(fpp)?.id ?? null,
      box: boxOf(page.runs, at, end),
    })
  }
  for (const m of text.matchAll(ARCH)) {
    const drawIn = frac(m[1]!)
    const feet = Number(m[2]) + (m[3] !== undefined ? Number(m[3]) / 12 : 0)
    if (drawIn === null || drawIn <= 0 || feet <= 0) continue
    // 1" = 10' style reads here too when no inches follow; let ENG take it.
    push(m.index!, m.index! + m[0].length, feet / drawIn)
  }
  for (const m of text.matchAll(ENG)) push(m.index!, m.index! + m[0].length, Number(m[1]))
  for (const m of text.matchAll(METRIC)) push(m.index!, m.index! + m[0].length, Number(m[1]) / 12)
  const notes: StatedScaleNote[] = []
  for (const m of text.matchAll(NOTE)) notes.push({ text: m[0].trim(), box: boxOf(page.runs, m.index!, m.index! + m[0].length) })
  scales.sort((a, b) => (a.box?.y0 ?? 0) - (b.box?.y0 ?? 0) || (a.box?.x0 ?? 0) - (b.box?.x0 ?? 0))
  return { scales, notes }
}

export interface ScaleCheck {
  measuredPoints: number
  writtenFeet: number
  /** Feet per point the written dimension implies. */
  impliedFeetPerPoint: number
  impliedPresetId: string | null
  /** The scale being checked: the one set on the sheet, or the one passed. */
  checkedFeetPerPoint: number | null
  /** What the checked scale makes of the measured line. */
  checkedFeet: number | null
  /** checked / written − 1, as a percentage. Within ±1% is a match. */
  errorPercent: number | null
  agrees: boolean | null
}

/**
 * Measure between two points the written dimension spans, and say what scale
 * the dimension implies and whether the sheet's scale agrees with it.
 */
export function checkScale(
  a: { x: number; y: number }, b: { x: number; y: number }, written: string,
  page: { width: number; height: number }, checkedFeetPerPoint: number | null,
): ScaleCheck | { error: string } {
  const writtenFeet = parseMeasureFeet(written, 'ft')
  if (writtenFeet === null || !(writtenFeet > 0)) return { error: `could not read "${written}" as a length; use e.g. 12'-6" or 3810 mm` }
  const pts = Math.hypot((b.x - a.x) * page.width, (b.y - a.y) * page.height)
  if (!(pts > 0)) return { error: 'the two points are the same point' }
  const implied = writtenFeet / pts
  const checkedFeet = checkedFeetPerPoint === null ? null : pts * checkedFeetPerPoint
  const err = checkedFeet === null ? null : (checkedFeet / writtenFeet - 1) * 100
  const r3 = (n: number) => Math.round(n * 1000) / 1000
  return {
    measuredPoints: r3(pts),
    writtenFeet: r3(writtenFeet),
    impliedFeetPerPoint: implied,
    impliedPresetId: matchPreset(implied)?.id ?? null,
    checkedFeetPerPoint,
    checkedFeet: checkedFeet === null ? null : r3(checkedFeet),
    errorPercent: err === null ? null : Math.round(err * 100) / 100,
    agrees: err === null ? null : Math.abs(err) <= 1,
  }
}
