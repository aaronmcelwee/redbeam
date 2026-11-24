/**
 * The estimate PDF's page furniture, shared by every page type.
 *
 * The estimate is a print document: it is attached to a bid, printed and
 * marked up. So it is set on white paper, which the Maxxit brand keeps for
 * exactly that, with Maxxit Black type and wordmark, one accent for one
 * meaning, and the drawings themselves as the only imagery. Aaron, 2026-11-24:
 * "I don't like the dark background."
 *
 * Helvetica stands in for Gotham and Whitney, which are licensed and cannot
 * be embedded from here.
 */
import { rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib'
import { MAXXIT_WORDMARK } from './wordmark.js'

export const hex = (h: string): RGB => {
  const n = parseInt(h.replace('#', ''), 16)
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
}

export const BRAND = {
  paper: rgb(1, 1, 1),
  /** Maxxit Black: headlines, figures, the wordmark. */
  ink: hex('#181A1D'),
  /** Body and secondary text. 8:1 on white. */
  inkDim: hex('#4D535B'),
  /** Labels, folios, captions. 4.6:1 on white. */
  inkFaint: hex('#757C85'),
  /** Hairlines between rows. */
  rule: hex('#DDE0E4'),
  /** The frame around a picture and the rule under a table head. */
  ruleStrong: hex('#B9BEC5'),
  /** A band behind a group heading. */
  surface: hex('#F3F4F6'),
  /** AERO:Form Orange: the kicker's rule, and "not ready to send". */
  accent: hex('#CA4139'),
  /** The same meaning as type: dark enough to read small on white. */
  accentInk: hex('#A8342D'),
} as const

/** Letter, landscape, in points. */
export const PAGE = { w: 792, h: 612 } as const
/** The brand's 112/96/150 on a 1920 canvas, scaled to a Letter page. */
export const M = { left: 46, right: 46, top: 40, bottom: 62 } as const
export const FOLIO_Y = 40

const WORDMARK_PATHS = [...MAXXIT_WORDMARK.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]!)
const WORDMARK_BOX = { w: 432, h: 68.89 } as const

export interface Fonts { text: PDFFont; display: PDFFont; bold: PDFFont }
export interface Pen extends Fonts { page: PDFPage }

/** Draw the wordmark with its left edge at `x`, its TOP at `top`, `width` wide. */
export function wordmark(page: PDFPage, x: number, top: number, width: number, color: RGB = BRAND.ink): void {
  const scale = width / WORDMARK_BOX.w
  for (const d of WORDMARK_PATHS) {
    // pdf-lib draws an SVG path with y growing DOWN from the given y, which is
    // what an SVG path expects — but the page's own y grows UP from the foot,
    // so `top`, measured from the head of the page, is turned over here.
    page.drawSvgPath(d, { x, y: PAGE.h - top, scale, color })
  }
}

/** The wordmark's height at `width`. */
export const wordmarkHeight = (width: number) => (width / WORDMARK_BOX.w) * WORDMARK_BOX.h

/** The brand's one flourish: a short accent rule, then a tracked uppercase label. */
export function kicker(pen: Pen, x: number, y: number, label: string): void {
  pen.page.drawRectangle({ x, y: y + 2.6, width: 18, height: 1.1, color: BRAND.accent })
  tracked(pen, x + 25, y, winAnsi(label.toUpperCase()), 7, pen.bold, BRAND.inkDim, 0.9)
}

/** Text set with extra space between letters, the way the brand sets labels. */
export function tracked(pen: Pen, x: number, y: number, text: string, size: number, font: PDFFont, color: RGB, spacing: number): number {
  let at = x
  for (const ch of winAnsi(text)) {
    pen.page.drawText(ch, { x: at, y, size, font, color })
    at += font.widthOfTextAtSize(ch, size) + spacing
  }
  return at - x - spacing
}

/** How wide `tracked` would set `text`. */
export const trackedWidth = (font: PDFFont, size: number, text: string, spacing: number) =>
  font.widthOfTextAtSize(winAnsi(text), size) + Math.max(0, winAnsi(text).length - 1) * spacing

/**
 * The running foot of every page: a hairline, what this is, and where.
 */
export function folio(pen: Pen, running: string, n: number, total: number): void {
  const { page } = pen
  page.drawLine({
    start: { x: M.left, y: FOLIO_Y + 13 }, end: { x: PAGE.w - M.right, y: FOLIO_Y + 13 },
    thickness: 0.5, color: BRAND.rule,
  })
  tracked(pen, M.left, FOLIO_Y, fit(pen.text, 6.5, running.toUpperCase(), PAGE.w - M.left - M.right - 80), 6.5, pen.text, BRAND.inkFaint, 0.6)
  const right = `${n} / ${total}`
  const w = trackedWidth(pen.text, 6.5, right, 0.6)
  tracked(pen, PAGE.w - M.right - w, FOLIO_Y, right, 6.5, pen.text, BRAND.inkFaint, 0.6)
}

/**
 * Text the standard fonts can set.
 *
 * Helvetica here is WinAnsi: a prime, a CJK character or an emoji in a scope
 * label made pdf-lib throw and the whole export fail. Primes become the
 * marks a drawing uses anyway; anything else unsettable becomes "?".
 */
export function winAnsi(text: string): string {
  return text
    .replace(/[′’‘]/g, "'")
    .replace(/[″“”]/g, '"')
    .replace(/[‐-–]/g, '-')
    .replace(/[  - ]/g, ' ')
    // WinAnsi is Latin-1 plus the cp1252 extras below.
    .replace(/[^\u0009\u000A\u000D -~¡-ÿŒœŠšŸŽžƒˆ˜—†-•…‰‹›€™]/g, '?')
}

/** After a hyphen, an underscore, a dot or a slash: where a name with no spaces can break. */
const BREAK_AFTER = /(?<=[-_./\\])(?![-_./\\])/

/**
 * Break text into lines that fit `width`, at spaces where it can.
 *
 * A word too long for a line is broken inside, after a hyphen, underscore,
 * dot or slash, and only as a last resort between any two letters. A file
 * name is often one long word ("A-351B-FLOOR-01---SECTOR-B-EXTERIOR-…"),
 * and set whole it ran off the page (Kenneth, 2026-11-24).
 */
export function wrap(font: PDFFont, size: number, text: string, width: number): string[] {
  return wrapped(font, size, text, width).map((l) => l.text)
}

/** `wrap`, at most `max` lines; what does not fit ends the last one with an ellipsis. */
export function wrapLines(font: PDFFont, size: number, text: string, width: number, max: number): string[] {
  const lines = wrapped(font, size, text, width)
  if (lines.length <= max) return lines.map((l) => l.text)
  // The rest as it was written: a line broken inside a word rejoins it without a space.
  const rest = lines.slice(max - 1).reduce((t, l, i) => (i === 0 ? l.text : `${t}${l.inWord ? '' : ' '}${l.text}`), '')
  return [...lines.slice(0, max - 1).map((l) => l.text), fit(font, size, rest, width)]
}

/** Lines, each saying whether it carries on a word the line before it broke. */
function wrapped(font: PDFFont, size: number, text: string, width: number): Array<{ text: string; inWord: boolean }> {
  const fits = (t: string) => font.widthOfTextAtSize(t, size) <= width
  const letters = (chunk: string): string[] => {
    const out: string[] = []
    let cur = ''
    for (const ch of chunk) {
      if (cur !== '' && !fits(cur + ch)) { out.push(cur); cur = ch } else cur += ch
    }
    return cur === '' ? out : [...out, cur]
  }
  const out: Array<{ text: string; inWord: boolean }> = []
  for (const para of winAnsi(text).split(/\r?\n/)) {
    let line = ''
    let inWord = false
    const push = (next: string, broke: boolean) => {
      out.push({ text: line, inWord })
      line = next
      inWord = broke
    }
    for (const word of para.split(/\s+/).filter((w) => w !== '')) {
      const next = line === '' ? word : `${line} ${word}`
      if (fits(next)) { line = next; continue }
      if (fits(word)) { push(word, false); continue }
      // Longer than a line: carry on the line it starts on, a part at a time.
      let gap = line === '' ? '' : ' '
      for (const part of word.split(BREAK_AFTER).flatMap((c) => (fits(c) ? [c] : letters(c)))) {
        if (fits(line + gap + part)) line += gap + part
        else if (line === '') line = part
        else push(part, gap === '')
        gap = ''
      }
    }
    out.push({ text: line, inWord })
  }
  return out
}

/** Trim with an ellipsis so a long label cannot walk into the next column. */
export function fit(font: PDFFont, size: number, text: string, width: number): string {
  let t = winAnsi(text)
  if (font.widthOfTextAtSize(t, size) <= width) return t
  while (t.length > 1 && font.widthOfTextAtSize(`${t}…`, size) > width) t = t.slice(0, -1)
  return `${t}…`
}

/** A quantity the way the pages print one. */
export const fmt = (n: number): string =>
  n >= 100 ? Math.round(n).toLocaleString('en-US') : (Math.round(n * 10) / 10).toLocaleString('en-US')
