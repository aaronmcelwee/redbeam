/**
 * Drawing colours: the sheet shown dark, dark gray, true black or sepia.
 *
 * Aaron, 2026-11-27: "Need a drawing: dark mode, sepia, dark gray, and true
 * black." The reader modes a PDF viewer has, for the drawing itself. The
 * panels around it keep Settings › General › Theme; this is the paper.
 *
 * DISPLAY ONLY, BY CONSTRUCTION. The colours are a CSS filter on the raster
 * canvas and on the thumbnails, so the pixels in those canvases are never
 * touched: the saved PDF, exports, print, bug-report captures and the close-
 * ups agents read all come from the same untouched raster or from PDFium and
 * show the drawing as drawn. Switching costs no re-render either — the tiles
 * are the same tiles.
 *
 * Markups are on the overlay canvas and are left alone on purpose: a scope's
 * colour on the sheet has to match its swatch in the sidebar and the legend
 * on the export, and an inverted orange is a blue nobody chose.
 *
 * Each mode is one colour matrix, built from two colours: what the paper
 * (white) becomes and what the ink (black) becomes. The dark modes first
 * invert with the hue turned back round (the "smart invert"), so a red cloud
 * on the drawing stays red instead of turning cyan; sepia does not invert and
 * just tints paper and ink. Everything in between lands proportionally, so
 * greys, hatching and colour keep their order.
 */
import { SettingsStore, browserStorage, SETTINGS_CHANGED } from './settings/store.js'

export type DrawingColors = 'normal' | 'dark' | 'darkgray' | 'black' | 'sepia'

export const DRAWING_COLORS_SETTING = 'viewer.drawingColors'

export const DRAWING_COLOR_CHOICES: ReadonlyArray<{ value: DrawingColors; label: string }> = [
  { value: 'normal', label: 'Normal' },
  { value: 'dark', label: 'Dark' },
  { value: 'darkgray', label: 'Dark gray' },
  { value: 'black', label: 'True black' },
  { value: 'sepia', label: 'Sepia' },
]

/** Paper is what white becomes; ink is what black becomes. sRGB hex. */
interface Recipe { invert: boolean; paper: string; ink: string }

export const RECIPES: Readonly<Record<Exclude<DrawingColors, 'normal'>, Recipe>> = {
  // A soft dark, the Windows dark surface: linework at 88%, not glaring white.
  dark: { invert: true, paper: '#1F1F1F', ink: '#E4E4E4' },
  // Lighter ground for a bright room, where #1F reads as a black hole.
  darkgray: { invert: true, paper: '#3C3C3C', ink: '#F0F0F0' },
  // OLED black and full white.
  black: { invert: true, paper: '#000000', ink: '#FFFFFF' },
  // Warm paper and brown-black ink; dark enough for thin linework.
  sepia: { invert: false, paper: '#F4ECD8', ink: '#3B2A1E' },
}

export function isDrawingColors(v: unknown): v is DrawingColors {
  return DRAWING_COLOR_CHOICES.some((c) => c.value === v)
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/*
 * CSS hue-rotate(180deg), the matrix from the Filter Effects spec with
 * cos = -1, sin = 0. Rows sum to 1, so it maps white to white and black to
 * black, which is what lets the invert be folded into one affine matrix:
 * hue(1 - c) = 1 - hue(c).
 */
const HUE_180: ReadonlyArray<readonly [number, number, number]> = [
  [-0.574, 1.43, 0.144],
  [0.426, 0.43, 0.144],
  [0.426, 1.43, -0.856],
]

/**
 * The 4x5 feColorMatrix for a mode, row-major, alpha untouched.
 *
 * Inverting:   out = ink - (ink - paper) * hue180(c)
 * Not:         out = ink + (paper - ink) * c
 * Check: c = white gives paper, c = black gives ink, in both.
 */
export function colorMatrix(r: Recipe): number[] {
  const P = rgb(r.paper), I = rgb(r.ink)
  const m: number[] = []
  for (let k = 0; k < 3; k++) {
    const span = I[k]! - P[k]!
    for (let j = 0; j < 3; j++) {
      m.push(r.invert ? -span * HUE_180[k]![j]! : (k === j ? -span : 0))
    }
    m.push(0, I[k]!)
  }
  m.push(0, 0, 0, 1, 0)
  return m.map((v) => Math.round(v * 10000) / 10000)
}

/** Apply a 4x5 matrix to one sRGB colour, clamped like the filter does. For tests. */
export function applyMatrix(m: readonly number[], c: readonly [number, number, number]): [number, number, number] {
  const out: number[] = []
  for (let k = 0; k < 3; k++) {
    const v = m[k * 5]! * c[0] + m[k * 5 + 1]! * c[1] + m[k * 5 + 2]! * c[2] + m[k * 5 + 4]!
    out.push(Math.min(1, Math.max(0, v)))
  }
  return out as [number, number, number]
}

export function filterId(mode: Exclude<DrawingColors, 'normal'>): string {
  return `rb-drawing-${mode}`
}

/** The CSS `filter` value for a mode. */
export function drawingFilter(mode: DrawingColors): string {
  return mode === 'normal' ? 'none' : `url(#${filterId(mode)})`
}

export function readDrawingColors(store?: SettingsStore): DrawingColors {
  const v = (store ?? SettingsStore.open(browserStorage())).str(DRAWING_COLORS_SETTING)
  return isDrawingColors(v) ? v : 'normal'
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** The hidden <svg> holding one filter per mode. Idempotent. */
export function installFilters(doc: Document = document): void {
  if (doc.getElementById('rb-drawing-filters') !== null) return
  const svg = doc.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('id', 'rb-drawing-filters')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('width', '0')
  svg.setAttribute('height', '0')
  svg.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none')
  for (const [mode, recipe] of Object.entries(RECIPES) as Array<[Exclude<DrawingColors, 'normal'>, Recipe]>) {
    const f = doc.createElementNS(SVG_NS, 'filter')
    f.setAttribute('id', filterId(mode))
    // The default is linearRGB, which would make every midtone wrong.
    f.setAttribute('color-interpolation-filters', 'sRGB')
    const cm = doc.createElementNS(SVG_NS, 'feColorMatrix')
    cm.setAttribute('type', 'matrix')
    cm.setAttribute('values', colorMatrix(recipe).join(' '))
    f.appendChild(cm)
    svg.appendChild(f)
  }
  doc.body.appendChild(svg)
}

/** Stamp a mode on the document: `data-drawing` and the filter variable the CSS reads. */
export function stampDrawingColors(mode: DrawingColors, doc: Document = document): void {
  doc.documentElement.setAttribute('data-drawing', mode)
  doc.documentElement.style.setProperty('--rb-drawing-filter', drawingFilter(mode))
}

/** Apply now, and again whenever the setting changes here or in another window. */
export function installDrawingColors(): void {
  installFilters()
  const apply = () => { stampDrawingColors(readDrawingColors()) }
  apply()
  window.addEventListener(SETTINGS_CHANGED, apply)
  window.addEventListener('storage', apply)
}
