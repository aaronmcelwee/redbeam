/**
 * The takeoff travels with the drawing.
 *
 * Aaron, 2026-11-12: "Embed only that sheet slice so that the markups and
 * takeoffs travel with the PDF. Make it so that Bluebeam can open files edited
 * in REDBEAM and show the markups, but not the scope layouts. Only REDBEAM has
 * the enhanced layouts and counts and scope details. Bluebeam only sees the
 * scope label and overall square footage." And then: "if someone opens it in
 * Bluebeam, adds a few markups, and saves it, it doesn't overwrite or delete
 * the REDBEAM-specific metadata."
 *
 * So a drawing REDBEAM has worked on carries two layers, written into the PDF
 * itself as an incremental update (see pdfIncremental.ts):
 *
 * 1. A BLUEBEAM-NATIVE layer. Every takeoff markup is an ordinary measurement
 *    annotation written the way Revu writes its own (read off a Revu 21 save of
 *    the TEV IFC set): a Polygon with /IT /PolygonDimension, the scope as its
 *    /Subj and /Label, the quantity as "1,234.56 sf" in /Contents,
 *    /MeasurementTypes saying "show area and label", and a /Measure dictionary
 *    in Revu's shape including /TargetUnitConversion. The page gets a /VP
 *    viewport carrying the calibration, so Revu shows the sheet as scaled and
 *    measures to our numbers. That is ALL Revu is given: label and quantity.
 *
 * 2. A REDBEAM-PRIVATE layer: the sheet's slice of redbeam.db (its pages,
 *    calibrations, scale regions, markups, the scopes they belong to with
 *    their specifications, and the calculation runs with their counts and
 *    layout components) as a compressed JSON stream reachable only through
 *    private dictionary keys. Nothing Revu displays points at it. It is written
 *    in more than one place (see CARRIERS) because no editor promises to keep
 *    another application's private data, and the reader takes whichever copy
 *    survived.
 *
 * Since 0.3.60 each sheet with takeoff also carries its own part of the
 * slice in the page's /PieceInfo, so pages merged, inserted, reordered or
 * extracted in Bluebeam take their takeoff along; sliceAssemble.ts puts the
 * file's takeoff back together from where the sheets are now.
 *
 * redbeam.db stays the record. The embedded slice is a copy for the drawing to
 * carry: it is read back only when the database has nothing for that drawing,
 * which is the case of a sheet emailed into another job folder.
 *
 * MARKUPS FROM OTHER APPS ARE NEVER TOUCHED. The writer removes only the
 * annotations REDBEAM itself wrote, recognised by their /NM, and appends —
 * so a Bluebeam cloud added between two REDBEAM saves is still there after the
 * second. A REDBEAM markup that somebody MOVED or relabelled in Bluebeam is
 * left exactly as they saved it rather than being snapped back, and reported.
 */
import {
  PDFArray, PDFDict, PDFDocument, PDFHexString, PDFInvalidObject, PDFName, PDFNumber, PDFRawStream,
  PDFRef, PDFStream, PDFString, decodePDFRawStream, degrees,
  type PDFContext, type PDFPage,
} from 'pdf-lib'
import { areaRegion } from '@redbeam/domain'
import { openLazyPdf } from './lazyPdf.js'
import { incrementalTail, newRefsSince, reserveExistingNumbers, updateBaseOf, type UpdateBase } from './pdfIncremental.js'
import { sheetOutlineCurrent, writeSheetOutline } from './sheetOutline.js'
import { annotColor, appearanceInfo, recolorAnnot, rectOf, rewriteNeeds, translateAnnot, type AnnotRewrite } from './annotRewrite.js'
import { buildNoteAnnots } from './noteAnnots.js'
import type { NoteContent } from '../tools/noteGeometry.js'
import { assembleSlice, pageSlicesFor, parsePageSlice, type FoundAnnot, type PageSlice, type Rebound } from './sliceAssemble.js'
import {
  COUNT_RADIUS, MIN_POINTS, appearanceOps, centroidOf, fromUserSpace, pdfText, regionAt, shapeForKind,
  toPdfColor, toUserSpace,
  type PageBox, type WritableMarkup, type WritableScaleRegion,
} from './pdfMarkup.js'

// ------------------------------------------------------------- the slice --

export const SLICE_FORMAT = 'redbeam.sheet-slice'
export const SLICE_VERSION = 1

/** Rows of redbeam.db, by table, exactly as SQLite returned them. */
export type SliceTables = Record<string, Array<Record<string, unknown>>>

export interface SheetSlice {
  format: typeof SLICE_FORMAT
  version: number
  documentId: string
  relativePath: string
  displayName: string
  writtenAt: string
  appVersion: string
  tables: SliceTables
  /**
   * What REDBEAM wrote for each markup it put on the sheet, keyed by /NM: the
   * markup it came from and a fingerprint of the geometry and label as
   * written. A later save compares the annotation against this to tell
   * "untouched" from "edited in another app".
   */
  annots: Record<string, SliceAnnot>
  /** Hash of everything the write depended on; equal hash, nothing to write. */
  contentHash: string
  /**
   * The `pageHash` of every page slice written in the same save (see
   * sliceAssemble.ts). A page copy not listed is stale. Absent before 0.3.60.
   */
  pageHashes?: string[]
}

/** What the slice remembers about one annotation REDBEAM wrote. */
export interface SliceAnnot {
  markupId: string
  /** Fingerprint of the annotation as written (`annotFingerprint`). */
  fp: string
  /**
   * The markup's own revision when it was written (`EmbedMarkup.rev`). When
   * the annotation has since changed and the markup has NOT, the edit was
   * made in another app and REDBEAM can take it (`bluebeamEdits`). Absent in
   * slices written before 0.3.16, which are then never adopted from.
   */
  rev?: string
  /** Separate REDBEAM cutout markups written into this area's /Cutouts. */
  folded?: string[]
}

/** A markup to put on the sheet, plus what its Bluebeam annotation says. */
export interface EmbedMarkup extends WritableMarkup {
  /** Net quantity in the unit of its kind: sq ft for areas, ft for runs. */
  quantity?: number | null
  /**
   * An area's openings, normalized: written as Revu's /Cutouts on the same
   * annotation so Bluebeam shows one area with cutouts, measured net.
   */
  cutouts?: ReadonlyArray<ReadonlyArray<{ x: number, y: number }>>
  /** Separate cutout markups among `cutouts`, by id. */
  folded?: readonly string[]
  /** The source markup's revision, recorded in the slice. */
  rev?: string
  /**
   * A note's shape, colours and text (kind `note`): written as the
   * annotation Revu would write for it (noteAnnots.ts) rather than as takeoff.
   */
  noteContent?: NoteContent
}

export interface EmbedInput {
  documentId: string
  relativePath: string
  displayName: string
  appVersion: string
  tables: SliceTables
  markups: readonly EmbedMarkup[]
  pageScales: ReadonlyMap<number, number>
  pageRegions?: ReadonlyMap<number, readonly WritableScaleRegion[]>
  /**
   * Sheets turned in REDBEAM: page index to /Rotate in degrees. Written onto
   * the page before its annotations, which are placed through the page's
   * rotation, so Bluebeam opens the sheet turned with the takeoff on it.
   */
  pageRotations?: ReadonlyMap<number, number>
  /**
   * The takeoff this writer last saw in the file (`sliceStamp`), or null for
   * none. When the file now carries a different one that also differs from
   * what is being written, somebody else saved a takeoff in between, and
   * nothing is written: the result says `conflict`. Left out, no check.
   */
  expectStamp?: string | null
  /**
   * /NMs of other apps' annotations that REDBEAM's markups now stand for
   * (adopted, then edited or deleted here). They are taken off the sheet, so
   * the markup is not shown twice, and a deleted one stays deleted.
   */
  retire?: readonly string[]
  /**
   * Take every other app's markup off the sheet (links and form fields stay).
   * For a working copy of someone else's file that should carry only this
   * takeoff (Aaron, 2026-11-24: "I had to strip Dave's markups outside
   * RedBeam"). Never used on a save to the original.
   */
  retireForeign?: boolean
  /**
   * Other apps' annotations REDBEAM has moved or recoloured (`annot`
   * markups), as each should now stand, and deleted ones whose delete was
   * undone after a save (annotRewrite.ts). Each is rewritten in place.
   */
  rewrite?: readonly AnnotRewrite[]
  /** For tests; defaults to the clock. */
  now?: () => Date
}

export interface EmbedResult {
  /** Null when the file already carries exactly this; nothing to write. */
  bytes: Uint8Array | null
  /** REDBEAM markups somebody changed in another app, left as they saved them. */
  editedElsewhere: string[]
  /** Annotations from other apps that were kept. */
  foreignKept: number
  /** `sliceStamp` of the takeoff the file carries after this call. */
  stamp: string | null
  /** Another writer's takeoff is in the file; see `EmbedInput.expectStamp`. */
  conflict?: true
  /**
   * By /NM, the objects this save took off the sheet for `retire` (the
   * annotation, then its popup), as "12 0 R". An undone delete puts them back.
   */
  retired?: Record<string, string[]>
}

/** Names one save of a takeoff: no two saves share it, even of the same content. */
export function sliceStamp(slice: Pick<SheetSlice, 'writtenAt' | 'contentHash'> | null): string | null {
  return slice === null ? null : `${slice.writtenAt}|${slice.contentHash}`
}

// ------------------------------------------------------------- hashing --

/** cyrb53: a fast, well-mixed 53-bit string hash. Not cryptographic. */
export function hash53(text: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

const hashHex = (text: string): string => hash53(text).toString(16).padStart(14, '0')

/** Stable JSON: keys sorted, so equal data hashes equal. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`
}

// ------------------------------------------------------------- identity --

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

function lettersOf(n: number, count: number): string {
  let out = ''
  let v = n
  for (let i = 0; i < count; i++) {
    out += LETTERS[v % 26]
    v = Math.floor(v / 26)
  }
  return out
}

/**
 * The /NM REDBEAM gives a markup's annotation.
 *
 * Revu names its own markups with sixteen upper-case letters and shows the
 * name as the markup's ID, so ours look the same: "RB", twelve letters from
 * the markup id, and two check letters over those fourteen. Deterministic, so
 * the same markup always gets the same name; checkable, so a REDBEAM
 * annotation is recognisable even in a file whose private data an editor
 * threw away. A random Revu name passes the check about once in 450,000.
 */
export function redbeamNm(markupId: string): string {
  const body = 'RB' + lettersOf(hash53(markupId, 7), 12)
  return body + lettersOf(hash53(body, 11), 2)
}

export function isRedbeamNm(nm: string): boolean {
  if (!/^RB[A-Z]{14}$/.test(nm)) return false
  const body = nm.slice(0, 14)
  return nm.slice(14) === lettersOf(hash53(body, 11), 2)
}

// ------------------------------------------------- Bluebeam's measure dict --

/** One point of paper in feet: 1/72 in, 1/864 ft. Revu's TargetUnitConversion. */
const FEET_PER_PAPER_POINT = 1 / 864

function revuNumberFormat(ctx: PDFContext, unit: string, conversion: number, fd = false): PDFDict {
  return ctx.obj({
    Type: 'NumberFormat',
    U: pdfText(unit),
    C: conversion,
    D: 100,
    ...(fd ? { FD: true } : {}),
    SS: PDFString.of(''),
  }) as PDFDict
}

/** "1 in = 8 ft", or "1 in = 8'-0"" style figures trimmed to what they need. */
export function scaleRatioText(feetPerPoint: number): string {
  const feetPerInch = Math.round(feetPerPoint * 72 * 10000) / 10000
  return `1 in = ${feetPerInch} ft`
}

/**
 * A /Measure dictionary in the shape Revu 21 writes.
 *
 * /X converts a point of the page to feet, which is the calibration; /D and
 * /A then convert feet to the displayed length and area units, so their
 * conversion is 1. /T and /V (angle, volume) are not ours to use but Revu
 * writes them on every measurement and a dictionary without them is one it
 * has to guess about. /TargetUnitConversion is a paper point in the target
 * unit, which is how Revu reconstructs the "1 in = 8 ft" it shows.
 */
export function revuMeasure(ctx: PDFContext, feetPerPoint: number): PDFDict {
  return ctx.obj({
    Type: 'Measure',
    Subtype: 'RL',
    R: pdfText(scaleRatioText(feetPerPoint)),
    X: [revuNumberFormat(ctx, 'ft', feetPerPoint)],
    D: [revuNumberFormat(ctx, 'ft', 1)],
    A: [revuNumberFormat(ctx, 'sf', 1, true)],
    T: [revuNumberFormat(ctx, '°', 1, true)],
    V: [revuNumberFormat(ctx, 'cu ft', 1, true)],
    TargetUnitConversion: FEET_PER_PAPER_POINT,
  }) as PDFDict
}

const fmt2 = (n: number): string =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** /Contents, as Revu words a measurement: "2,064.78 sf", "80.00 ft". */
export function quantityText(kind: string, quantity: number | null | undefined): string {
  if (quantity === null || quantity === undefined || !Number.isFinite(quantity)) return ''
  if (kind === 'polyline') return `${fmt2(quantity)} ft`
  if (kind === 'count') return `${Math.round(quantity)} EA`
  return `${fmt2(quantity)} sf`
}

/**
 * Revu's MeasurementTypes bits (Area=1, Length=2, Count=8192, Label=128):
 * which values the on-page caption shows.
 */
const MEASUREMENT_TYPES: Record<string, number> = { polygon: 1 | 128, polyline: 2 | 128 }

// ------------------------------------------------------------ fingerprints --

const vertsOf = (a: PDFDict): number[] => {
  const v = a.lookup(PDFName.of('Vertices'))
  if (!(v instanceof PDFArray)) return []
  const out: number[] = []
  for (let i = 0; i < v.size(); i++) {
    const n = v.lookup(i)
    out.push(n instanceof PDFNumber ? n.asNumber() : NaN)
  }
  return out
}

const textOf = (a: PDFDict, key: string): string => {
  const v = a.lookup(PDFName.of(key))
  return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : ''
}

/**
 * What "this annotation is as REDBEAM left it" is judged on: its geometry,
 * to a tenth of a point, and its label. Not /Contents — Revu rewrites the
 * measurement text in its own format when it saves, and that is not an edit.
 */
export function annotFingerprint(a: PDFDict): string {
  const verts = vertsOf(a).map((n) => Math.round(n * 10) / 10)
  const rect = a.lookup(PDFName.of('Rect'))
  const geom = verts.length > 0 || !(rect instanceof PDFArray)
    ? verts
    : [0, 1, 2, 3].map((i) => {
      const n = rect.lookup(i)
      return n instanceof PDFNumber ? Math.round(n.asNumber() * 10) / 10 : NaN
    })
  // Cutouts count as geometry, so one added or moved in Bluebeam is an edit.
  // Only when present: a file written before they were read keeps its
  // fingerprints, and is not taken for edited on its next save.
  const cuts = cutoutsOf(a)
  const cutPart = cuts.length === 0 ? '' : `|c:${cuts.map((r) => r.map((n) => Math.round(n * 10) / 10).join(',')).join(';')}`
  return hashHex(`${geom.join(',')}|${textOf(a, 'Label')}${cutPart}`)
}

/** Revu's /Cutouts: one flat [x y x y …] array per opening, page space. */
function cutoutsOf(a: PDFDict): number[][] {
  const v = a.lookup(PDFName.of('Cutouts'))
  if (!(v instanceof PDFArray)) return []
  const out: number[][] = []
  for (let i = 0; i < v.size(); i++) {
    const inner = v.lookup(i)
    if (!(inner instanceof PDFArray)) continue
    const ring: number[] = []
    for (let k = 0; k < inner.size(); k++) {
      const n = inner.lookup(k)
      ring.push(n instanceof PDFNumber ? n.asNumber() : NaN)
    }
    if (ring.length >= 6 && ring.every(Number.isFinite)) out.push(ring)
  }
  return out
}

// --------------------------------------------------------------- carriers --

/**
 * Where the private slice lives.
 *
 * PieceInfo is ISO 32000's own mechanism for exactly this — "private data of
 * the conforming product that created it", keyed by application — and a
 * conforming editor is expected to carry an entry it does not understand.
 * The per-annotation key covers the opposite failure: an editor that rebuilds
 * the document catalog but copies annotations whole. Either one is enough to
 * get the slice back.
 */
const KEY = 'REDBEAM'

/** The slice's bytes: UTF-8. A JS string handed to flateStream keeps only each character's low byte. */
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

/**
 * Reads a slice stream. Builds before 0.3.82 wrote each character's low byte
 * only, so a non-ASCII name made the slice unreadable and the takeoff was
 * rebuilt from the markups without its product details. An accent made the
 * bytes invalid UTF-8, so those are read one byte per character. A dash or
 * curly quote became a control byte; JSON.stringify never writes one raw, so
 * each one found was a General Punctuation character (U+2000 to U+201F) and
 * is put back. A slice this build wrote is plain UTF-8 and passes unchanged.
 */
export function sliceText(bytes: Uint8Array): string {
  try {
    return repairLowBytes(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    let text = ''
    for (let i = 0; i < bytes.length; i += 0x8000) {
      text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    }
    return repairLowBytes(text)
  }
}

/** Puts back the dashes and quotes that the old writer cut to control bytes. */
export function repairLowBytes(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x1f]/g, (c) => String.fromCharCode(0x2000 + c.charCodeAt(0)))
}

function privateStream(ctx: PDFContext, json: string): PDFRef {
  return ctx.register(ctx.flateStream(utf8(json), { Type: 'REDBEAM#20Slice' }))
}

function pieceInfo(ctx: PDFContext, when: string, sliceRef: PDFRef): PDFDict {
  return ctx.obj({
    [KEY]: ctx.obj({
      LastModified: PDFString.of(when),
      Private: ctx.obj({ Format: PDFString.of(SLICE_FORMAT), Slice: sliceRef }),
    }),
  }) as PDFDict
}

const pdfDate = (d: Date): string =>
  `D:${d.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`

function streamText(stream: unknown): string | null {
  if (!(stream instanceof PDFStream)) return null
  try {
    const bytes = stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents()
    return sliceText(bytes)
  } catch {
    return null
  }
}

/** A slice this build cannot read because a newer REDBEAM wrote it. */
const TOO_NEW = 'too-new' as const

export function parseSlice(text: string | null): SheetSlice | typeof TOO_NEW | null {
  if (text === null) return null
  try {
    const v = JSON.parse(text) as Partial<SheetSlice>
    if (v.format !== SLICE_FORMAT || typeof v.documentId !== 'string') return null
    if (typeof v.version !== 'number') return null
    if (v.version > SLICE_VERSION) return TOO_NEW
    if (v.tables === null || typeof v.tables !== 'object') return null
    return { annots: {}, contentHash: '', ...v } as SheetSlice
  } catch {
    return null
  }
}

function sliceFromPieceInfo(holder: PDFDict): SheetSlice | typeof TOO_NEW | null {
  const pi = holder.lookup(PDFName.of('PieceInfo'))
  if (!(pi instanceof PDFDict)) return null
  const ours = pi.lookup(PDFName.of(KEY))
  if (!(ours instanceof PDFDict)) return null
  const priv = ours.lookup(PDFName.of('Private'))
  if (!(priv instanceof PDFDict)) return null
  return parseSlice(streamText(priv.lookup(PDFName.of('Slice'))))
}

// ----------------------------------------------------------------- reading --

export interface RedbeamAnnot {
  pageIndex: number
  nm: string
  /** The markup it was written from, when the file still says. */
  markupId: string | null
  label: string
  contents: string
  /** PDF user space. */
  vertices: number[]
  /** Revu /Cutouts, PDF user space; [] when it has none. */
  cutouts: number[][]
  /**
   * The geometry normalized to the page as displayed, the frame markups are
   * stored in: the outline, then each cutout. [] for an annotation with no
   * vertices (a count's circle).
   */
  rings: Array<Array<{ x: number, y: number }>>
  fp: string
  /** The annotation's /Subtype: Polygon, PolyLine or Circle as REDBEAM writes them. */
  subtype: string
  /** Its stroke colour as `#rrggbb`, or null when it has none readable. */
  color: string | null
  /** The middle of its /Rect, normalized like `rings`: where a count sits. */
  center: { x: number, y: number } | null
}

/**
 * A Bluebeam (or Acrobat) markup that REDBEAM can hold as one of its own: an
 * area (a polygon or a rectangle, cutouts included) or a length (a polyline,
 * or a measured line). Clouds, arrows, text, stamps and the rest stay the
 * other app's, drawn by the page.
 */
export interface ForeignAnnot {
  pageIndex: number
  /** The annotation's /NM, its identity across saves in either app. */
  nm: string
  /**
   * What REDBEAM knows it by: the /NM, or, where Revu gave copies on several
   * pages the same /NM, the /NM and its page (`heldKey`).
   */
  key: string
  subtype: string
  /**
   * `annot`: anything else with an /NM (a cloud, a text box, an arrow, a
   * dimension, a stamp), held where it is and drawn by the PDF; its ring is
   * its /Rect.
   */
  kind: 'area' | 'polyline' | 'annot'
  /** Normalized like `RedbeamAnnot.rings`: the outline, then each cutout. */
  rings: Array<Array<{ x: number, y: number }>>
  color: string | null
  subject: string
  label: string
  contents: string
  author: string
  /** For `annot`: its appearance's box and matrix and fill opacity, for a recolour on screen. */
  ap?: { bbox: number[], matrix: number[] | null, alpha: number } | null
  /** The sheet's size in points as displayed, for a page row. */
  width: number
  height: number
}

/** A scale REDBEAM wrote on a sheet, read back from the sheet's viewports. */
export interface SheetScale {
  feetPerPoint: number
  /** Null for the whole sheet; otherwise the region it covers, normalized. */
  rect: { x0: number, y0: number, x1: number, y1: number } | null
  label: string
}

/** A sheet as the file itself describes it, whatever became of the slice. */
export interface SheetFacts {
  pageIndex: number
  /** Size in points as displayed: the crop box, turned by the page's rotation. */
  width: number
  height: number
  scales: SheetScale[]
}

export interface SheetEmbedReading {
  slice: SheetSlice | null
  /** Which carrier the slice came from. */
  source: 'catalog' | 'annotation' | 'page' | null
  redbeamAnnots: RedbeamAnnot[]
  /** Every sheet that carries a REDBEAM annotation or a REDBEAM scale. */
  sheets: SheetFacts[]
  /** Markup annotations REDBEAM did not write: Bluebeam's, Acrobat's. */
  foreignAnnots: number
  /**
   * The ones among them that are takeoff shapes (areas and lengths) REDBEAM
   * takes in as its own markups when the drawing opens (`adoptForeignAnnots`).
   */
  adoptable: ForeignAnnot[]
  /**
   * REDBEAM annotations are on the sheet but no copy of the slice is. Some
   * editor saved the file and dropped REDBEAM's private data; the markups it
   * shows are still there, the scope detail is not.
   */
  privateDataLost: boolean
  /**
   * The file carries a slice written by a newer REDBEAM than this one. It is
   * not read, because reading part of it and saving would drop the rest.
   */
  sliceTooNew: boolean
  /**
   * Set when the takeoff had to be matched to the sheets again: pages were
   * merged, inserted, deleted or moved in another app since REDBEAM saved.
   */
  rebound?: Rebound | null
}

const NOT_MARKUP = new Set(['Link', 'Popup', 'Widget'])

function annotsOn(page: PDFPage): PDFDict[] {
  const arr = page.node.lookup(PDFName.of('Annots'))
  if (!(arr instanceof PDFArray)) return []
  const out: PDFDict[] = []
  for (let i = 0; i < arr.size(); i++) {
    const a = arr.lookup(i)
    if (a instanceof PDFDict) out.push(a)
  }
  return out
}

function isOurs(a: PDFDict): boolean {
  return isRedbeamNm(textOf(a, 'NM')) || a.lookup(PDFName.of(KEY)) instanceof PDFDict
}

function subtypeOf(a: PDFDict): string {
  const s = a.lookup(PDFName.of('Subtype'))
  return s instanceof PDFName ? s.decodeText() : ''
}

const numsOf = (a: PDFDict, key: string): number[] => {
  const v = a.lookup(PDFName.of(key))
  if (!(v instanceof PDFArray)) return []
  const out: number[] = []
  for (let i = 0; i < v.size(); i++) {
    const n = v.lookup(i)
    out.push(n instanceof PDFNumber ? n.asNumber() : NaN)
  }
  return out
}

const hexOf = (c: [number, number, number] | null): string | null =>
  c === null ? null : `#${c.map((n) => Math.round(n * 255).toString(16).padStart(2, '0')).join('')}`

function colorOf(a: PDFDict): string | null {
  const c = numsOf(a, 'C')
  if (c.length !== 3 || !c.every((n) => Number.isFinite(n) && n >= 0 && n <= 1)) return null
  return `#${c.map((n) => Math.round(n * 255).toString(16).padStart(2, '0')).join('')}`
}

/** Feet per point from a /Measure as `revuMeasure` writes it: /X's conversion. */
function feetPerPointOf(holder: PDFDict): number | null {
  const m = holder.lookup(PDFName.of('Measure'))
  if (!(m instanceof PDFDict)) return null
  const x = m.lookup(PDFName.of('X'))
  const first = x instanceof PDFArray ? x.lookup(0) : null
  if (!(first instanceof PDFDict)) return null
  const c = first.lookup(PDFName.of('C'))
  const unit = textOf(first, 'U')
  return c instanceof PDFNumber && c.asNumber() > 0 && unit === 'ft' ? c.asNumber() : null
}

/** REDBEAM's own viewports on a page: its page scale and its scale regions. */
function scalesOn(page: PDFPage, box: PageBox, rotation: number): SheetScale[] {
  const vps = page.node.lookup(PDFName.of('VP'))
  if (!(vps instanceof PDFArray)) return []
  const out: SheetScale[] = []
  for (let i = 0; i < vps.size(); i++) {
    const vp = vps.lookup(i)
    if (!(vp instanceof PDFDict)) continue
    const name = textOf(vp, 'Name')
    if (!name.startsWith('REDBEAM')) continue
    const feetPerPoint = feetPerPointOf(vp)
    if (feetPerPoint === null) continue
    if (name === 'REDBEAM page scale') { out.push({ feetPerPoint, rect: null, label: '' }); continue }
    const b = numsOf(vp, 'BBox')
    if (b.length !== 4 || !b.every(Number.isFinite)) continue
    const c0 = fromUserSpace({ x: b[0]!, y: b[1]! }, box, rotation)
    const c1 = fromUserSpace({ x: b[2]!, y: b[3]! }, box, rotation)
    const label = name.slice('REDBEAM '.length)
    out.push({
      feetPerPoint,
      rect: { x0: Math.min(c0.x, c1.x), y0: Math.min(c0.y, c1.y), x1: Math.max(c0.x, c1.x), y1: Math.max(c0.y, c1.y) },
      label: label === 'scale region' ? '' : label,
    })
  }
  return out
}

/** A border drawn as a cloud: a revision cloud, not a takeoff shape. */
function isCloud(a: PDFDict): boolean {
  const be = a.lookup(PDFName.of('BE'))
  if (!(be instanceof PDFDict)) return false
  const style = be.lookup(PDFName.of('S'))
  return style instanceof PDFName && style.decodeText() === 'C'
}

/** An arrow or other ending on a line: a leader, not a measured run. */
function hasArrows(a: PDFDict): boolean {
  const le = a.lookup(PDFName.of('LE'))
  if (!(le instanceof PDFArray)) return false
  for (let i = 0; i < le.size(); i++) {
    const n = le.lookup(i)
    if (n instanceof PDFName && n.decodeText() !== 'None') return true
  }
  return false
}

/**
 * A Bluebeam dimension: a measured line drawn to annotate, not a length to
 * take off. Revu's Dimension tool writes /IT LineDimension like its Length
 * measurement does, but with leader lines (/LL) or its own subject.
 */
function isDimension(a: PDFDict): boolean {
  const ll = a.lookup(PDFName.of('LL'))
  if (ll instanceof PDFNumber && ll.asNumber() !== 0) return true
  const subject = textOf(a, 'Subj').toLowerCase()
  return subject.includes('dimension') && !subject.includes('measurement')
}

/** The annotation's /Rect as a ring of corners, user space; null when it has none. */
function annotRectRing(a: PDFDict): number[] | null {
  const r = rectOf(a)
  if (r === null || !(r[2] > r[0]) || !(r[3] > r[1])) return null
  return [r[0], r[1], r[2], r[1], r[2], r[3], r[0], r[3]]
}

/** What a foreign annotation becomes in REDBEAM, and its user-space outline; null to leave it. */
function adoptShape(a: PDFDict): { kind: 'area' | 'polyline' | 'annot', flat: number[] } | null {
  if (textOf(a, 'NM') === '') return null
  const held = (): { kind: 'annot', flat: number[] } | null => {
    const ring = annotRectRing(a)
    return ring === null ? null : { kind: 'annot', flat: ring }
  }
  if (isCloud(a)) return held()
  const subtype = subtypeOf(a)
  const intent = (() => { const it = a.lookup(PDFName.of('IT')); return it instanceof PDFName ? it.decodeText() : '' })()
  if (subtype === 'Polygon') {
    const v = vertsOf(a)
    return v.length >= 6 && v.every(Number.isFinite) ? { kind: 'area', flat: v } : held()
  }
  if (subtype === 'Square') {
    const r = numsOf(a, 'Rect')
    if (r.length !== 4 || !r.every(Number.isFinite)) return null
    // /RD is the border's inset inside /Rect; the shape is the inner box.
    const rd = numsOf(a, 'RD')
    const [l, b, rr, t] = rd.length === 4 && rd.every(Number.isFinite) ? rd : [0, 0, 0, 0]
    const x0 = Math.min(r[0]!, r[2]!) + l!, x1 = Math.max(r[0]!, r[2]!) - rr!
    const y0 = Math.min(r[1]!, r[3]!) + b!, y1 = Math.max(r[1]!, r[3]!) - t!
    if (!(x1 > x0) || !(y1 > y0)) return held()
    return { kind: 'area', flat: [x0, y0, x1, y0, x1, y1, x0, y1] }
  }
  if (hasArrows(a)) return held()
  if (subtype === 'PolyLine') {
    const v = vertsOf(a)
    return v.length >= 4 && v.every(Number.isFinite) ? { kind: 'polyline', flat: v } : held()
  }
  if (subtype === 'Line' && intent === 'LineDimension' && !isDimension(a)) {
    const l = numsOf(a, 'L')
    return l.length === 4 && l.every(Number.isFinite) ? { kind: 'polyline', flat: l } : held()
  }
  return held()
}

/** The object number of the slice stream a PieceInfo points at, to read each stream once. */
function sliceRefOf(holder: PDFDict): string | null {
  const pi = holder.lookup(PDFName.of('PieceInfo'))
  const ours = pi instanceof PDFDict ? pi.lookup(PDFName.of(KEY)) : null
  const priv = ours instanceof PDFDict ? ours.lookup(PDFName.of('Private')) : null
  const ref = priv instanceof PDFDict ? priv.get(PDFName.of('Slice')) : null
  return ref instanceof PDFRef ? ref.toString() : null
}

function pageSliceOn(page: PDFPage): PageSlice | typeof TOO_NEW | null {
  const pi = page.node.lookup(PDFName.of('PieceInfo'))
  if (!(pi instanceof PDFDict)) return null
  const ours = pi.lookup(PDFName.of(KEY))
  if (!(ours instanceof PDFDict)) return null
  const priv = ours.lookup(PDFName.of('Private'))
  if (!(priv instanceof PDFDict)) return null
  return parsePageSlice(streamText(priv.lookup(PDFName.of('Slice'))))
}

function readDoc(doc: PDFDocument): SheetEmbedReading {
  const fromCatalog = sliceFromPieceInfo(doc.catalog)
  let sliceTooNew = fromCatalog === TOO_NEW
  const catalog = fromCatalog === TOO_NEW ? null : fromCatalog
  let slice: SheetSlice | null = catalog
  let source: SheetEmbedReading['source'] = slice === null ? null : 'catalog'
  // Every file-wide copy an annotation points at, read once per stream.
  const fileSlices: SheetSlice[] = []
  const streamsRead = new Set<string>()
  const catalogRef = sliceRefOf(doc.catalog)
  if (catalogRef !== null && catalog !== null) streamsRead.add(catalogRef)
  const pageSlices = new Map<number, PageSlice>()
  const allSheets: Array<{ width: number, height: number, scales: SheetScale[] }> = []
  const redbeamAnnots: RedbeamAnnot[] = []
  const sheets: SheetFacts[] = []
  let foreignAnnots = 0
  const adoptable: ForeignAnnot[] = []
  doc.getPages().forEach((page, pageIndex) => {
    const box = page.getCropBox() as PageBox
    const rotation = page.getRotation().angle
    const oursBefore = redbeamAnnots.length
    const ps = pageSliceOn(page)
    if (ps === TOO_NEW) sliceTooNew = true
    else if (ps !== null) pageSlices.set(pageIndex, ps)
    const toRing = (flat: number[]) => {
      const ring: Array<{ x: number, y: number }> = []
      for (let i = 0; i + 1 < flat.length; i += 2) ring.push(fromUserSpace({ x: flat[i]!, y: flat[i + 1]! }, box, rotation))
      return ring
    }
    for (const a of annotsOn(page)) {
      if (NOT_MARKUP.has(subtypeOf(a))) continue
      if (!isOurs(a)) {
        foreignAnnots++
        const shape = adoptShape(a)
        if (shape !== null) {
          const turned = Math.abs(Math.round(rotation / 90)) % 2 === 1
          adoptable.push({
            pageIndex, nm: textOf(a, 'NM'), key: textOf(a, 'NM'), subtype: subtypeOf(a), kind: shape.kind,
            rings: [toRing(shape.flat), ...(shape.kind === 'area' ? cutoutsOf(a).filter((c) => c.length >= 6 && c.every(Number.isFinite)).map(toRing) : [])],
            color: shape.kind === 'annot' ? hexOf(annotColor(a)) : colorOf(a), subject: textOf(a, 'Subj'), label: textOf(a, 'Label'),
            contents: textOf(a, 'Contents'), author: textOf(a, 'T'),
            ...(shape.kind === 'annot' ? { ap: appearanceInfo(a) } : {}),
            width: turned ? box.height : box.width, height: turned ? box.width : box.height,
          })
        }
        continue
      }
      const own = a.lookup(PDFName.of(KEY))
      const markupId = own instanceof PDFDict ? textOf(own, 'MarkupId') || null : null
      if (own instanceof PDFDict) {
        const ref = own.get(PDFName.of('Slice'))
        const key = ref instanceof PDFRef ? ref.toString() : null
        if (key === null || !streamsRead.has(key)) {
          if (key !== null) streamsRead.add(key)
          const s = parseSlice(streamText(own.lookup(PDFName.of('Slice'))))
          if (s === TOO_NEW) sliceTooNew = true
          else if (s !== null) {
            fileSlices.push(s)
            if (slice === null) { slice = s; source = 'annotation' }
          }
        }
      }
      redbeamAnnots.push({
        pageIndex,
        nm: textOf(a, 'NM'),
        markupId,
        label: textOf(a, 'Label'),
        contents: textOf(a, 'Contents'),
        vertices: vertsOf(a),
        cutouts: cutoutsOf(a),
        rings: vertsOf(a).length >= 4 && vertsOf(a).every(Number.isFinite)
          ? [toRing(vertsOf(a)), ...cutoutsOf(a).map(toRing)]
          : [],
        fp: annotFingerprint(a),
        subtype: subtypeOf(a),
        color: colorOf(a),
        center: (() => {
          const r = numsOf(a, 'Rect')
          if (r.length !== 4 || !r.every(Number.isFinite)) return null
          return fromUserSpace({ x: (r[0]! + r[2]!) / 2, y: (r[1]! + r[3]!) / 2 }, box, rotation)
        })(),
      })
    }
    const scales = scalesOn(page, box, rotation)
    const turned = Math.abs(Math.round(rotation / 90)) % 2 === 1
    const facts = { width: turned ? box.height : box.width, height: turned ? box.width : box.height, scales }
    allSheets.push(facts)
    if (redbeamAnnots.length > oursBefore || scales.length > 0) sheets.push({ pageIndex, ...facts })
  })
  // Revu copies a markup to other pages under the same /NM: each page's copy
  // is its own markup here.
  const pagesOfNm = new Map<string, Set<number>>()
  for (const f of adoptable) (pagesOfNm.get(f.nm) ?? pagesOfNm.set(f.nm, new Set()).get(f.nm)!).add(f.pageIndex)
  for (const f of adoptable) if ((pagesOfNm.get(f.nm)?.size ?? 0) > 1) f.key = heldKey(f.nm, f.pageIndex)
  // An annotation that does not name its markup is named by whichever slice wrote it.
  for (const r of redbeamAnnots) {
    if (r.markupId !== null) continue
    const own = pageSlices.get(r.pageIndex)?.annots[r.nm]
      ?? [...(catalog === null ? [] : [catalog]), ...fileSlices].map((s) => s.annots[r.nm]).find((a) => a !== undefined)
    r.markupId = own?.markupId ?? null
  }
  let rebound: Rebound | null = null
  if (!sliceTooNew && (slice !== null || pageSlices.size > 0)) {
    const found: FoundAnnot[] = redbeamAnnots.map((r) => ({ pageIndex: r.pageIndex, nm: r.nm, markupId: r.markupId }))
    const assembled = assembleSlice({ catalog, fileSlices, pageSlices, annots: found, sheets: allSheets })
    if (assembled.slice !== null) {
      if (slice === null) source = 'page'
      slice = assembled.slice
      rebound = assembled.rebound
    }
  }
  return {
    slice,
    source,
    redbeamAnnots,
    sheets,
    foreignAnnots,
    adoptable,
    privateDataLost: slice === null && redbeamAnnots.length > 0,
    // An older copy that still reads does not make the newer one safe to drop.
    sliceTooNew,
    rebound,
  }
}

/** Load a PDF the way this module needs: no metadata rewrite, no throw on encryption. */
async function load(bytes: Uint8Array): Promise<PDFDocument> {
  let doc: PDFDocument | null = null
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false })
  } catch { /* the catalog itself may be the object that does not parse */ }
  if (doc !== null && !hasInvalidObjects(doc)) return doc
  // A full load keeps only the newest revision of each object, even one that
  // does not parse (see lazyPdf's fallback). The ranged reader falls back to
  // the newest earlier revision that does, so a file an older REDBEAM saved a
  // bad sheet name into can still be saved over.
  return openLazyPdf({ size: bytes.length, read: (a, b) => bytes.subarray(a, b) }).doc
}

function hasInvalidObjects(doc: PDFDocument): boolean {
  for (const [, obj] of doc.context.enumerateIndirectObjects()) if (obj instanceof PDFInvalidObject) return true
  return false
}

/**
 * What REDBEAM left in a PDF, if anything.
 *
 * Never throws for a drawing that simply has nothing of ours in it; throws
 * only when pdf-lib cannot parse the file at all, which the caller treats as
 * "nothing embedded" since PDFium may still render it.
 */
export async function readSheetEmbed(bytes: Uint8Array): Promise<SheetEmbedReading> {
  return readDoc(await load(bytes))
}

/** `readSheetEmbed` for a document already open (lazyPdf.ts reads one by byte range). */
export function readSheetEmbedFrom(doc: PDFDocument): SheetEmbedReading {
  return readDoc(doc)
}

// ----------------------------------------------------------------- writing --

function buildAnnot(
  ctx: PDFContext,
  page: PDFPage,
  markup: EmbedMarkup,
  feetPerPoint: number | undefined,
  alpha: number,
  nm: string,
  when: string,
): PDFDict | null {
  const shape = shapeForKind(markup.kind)
  const ring = markup.rings[0]
  if (shape === null || ring === undefined || ring.length < MIN_POINTS[shape]) return null
  const box = page.getCropBox() as PageBox
  const rotation = page.getRotation().angle
  const pts = ring.map((p) => toUserSpace(p, box, rotation))
  const lineWidth = 1.5
  const pad = lineWidth + (shape === 'circle' ? COUNT_RADIUS : 0)
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const rect = [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad]
  const color = toPdfColor(markup.color)
  const holes = shape === 'polygon' && markup.kind !== 'cutout'
    ? (markup.cutouts ?? []).filter((r) => r.length >= 3).map((r) => r.map((p) => toUserSpace(p, box, rotation)))
    : []

  // A cutout is a deduction: drawn so a reader can see it, but deliberately
  // NOT a measurement, or Revu would add its area to the scope's total
  // instead of taking it away. The net figure is on the area it belongs to.
  const isCutout = markup.kind === 'cutout'
  const measured = feetPerPoint !== undefined && !isCutout && shape !== 'circle'
  const fill = shape === 'polyline' ? null : color
  // Drawn as measured: the outline less its cuts, so a cut across the edge
  // is a notch rather than a ring filled outside it. /Vertices and /Cutouts
  // keep the outline and the cuts as drawn, which is how Revu keeps them.
  const drawn = holes.length === 0
    ? [pts]
    : areaRegion([ring, ...(markup.cutouts ?? [])]).map((r) => r.map((p) => toUserSpace(p, box, rotation)))
  const ap = ctx.register(ctx.flateStream(
    appearanceOps(drawn[0] ?? pts, color, lineWidth, shape, drawn.slice(1)),
    {
      Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: rect,
      Resources: ctx.obj({
        ExtGState: ctx.obj({ GS: ctx.obj({ Type: 'ExtGState', ca: isCutout ? 0 : alpha, CA: 1 }) }),
      }),
    },
  ))

  const label = isCutout ? `${markup.scopeLabel} (deduction)` : markup.scopeLabel
  const contents = isCutout ? 'Deduction' : quantityText(markup.kind, markup.quantity)
  const subtype = shape === 'polygon' ? 'Polygon' : shape === 'polyline' ? 'PolyLine' : 'Circle'
  const intent = measured ? (shape === 'polygon' ? 'PolygonDimension' : 'PolyLineDimension') : null

  return ctx.obj({
    Type: 'Annot',
    Subtype: subtype,
    Rect: rect,
    ...(shape === 'circle' ? {} : { Vertices: pts.flatMap((p) => [p.x, p.y]) }),
    // Revu's own key for an area's openings: Bluebeam shows one area with
    // cutouts, measures it net, and lets them be edited there.
    ...(holes.length === 0 ? {} : { Cutouts: holes.map((r) => r.flatMap((p) => [p.x, p.y])) }),
    C: color,
    ...(fill === null || isCutout ? {} : { IC: fill }),
    CA: 1,
    ...(fill === null || isCutout ? {} : { FillOpacity: alpha }),
    F: 4,
    BS: ctx.obj({ Type: 'Border', W: lineWidth, S: PDFName.of(isCutout ? 'D' : 'S') }),
    // Bluebeam's columns: Subject groups the Markups List and its summaries,
    // Label is what the caption prints beside the quantity, Author is who.
    Subj: pdfText(label),
    Label: pdfText(label),
    T: PDFString.of('REDBEAM'),
    Contents: pdfText(contents),
    NM: pdfText(nm),
    M: PDFString.of(when),
    CreationDate: PDFString.of(when),
    ...(intent === null ? {} : {
      IT: PDFName.of(intent),
      Measure: revuMeasure(ctx, feetPerPoint!),
      MeasurementTypes: MEASUREMENT_TYPES[shape] ?? 129,
      Cap: true,
    }),
    DS: PDFString.of('font: Helvetica 12pt; text-align:center; color:#000000'),
    AP: ctx.obj({ N: ap }),
  }) as PDFDict
}

function writePageScale(
  ctx: PDFContext,
  page: PDFPage,
  feetPerPoint: number | null,
  regions: readonly WritableScaleRegion[],
): boolean {
  const box = page.getCropBox() as PageBox
  const rotation = page.getRotation().angle
  const ours: PDFDict[] = []
  if (feetPerPoint !== null) {
    ours.push(ctx.obj({
      Type: 'Viewport',
      BBox: [box.x, box.y, box.x + box.width, box.y + box.height],
      Name: PDFString.of('REDBEAM page scale'),
      Measure: revuMeasure(ctx, feetPerPoint),
    }) as PDFDict)
  }
  // Last containing viewport wins in Revu, so the page scale goes first and
  // regions follow largest to smallest: the app's smallest-wins rule.
  const area = (r: WritableScaleRegion['rect']): number => Math.abs(r.x1 - r.x0) * Math.abs(r.y1 - r.y0)
  for (const region of [...regions].sort((a, b) => area(b.rect) - area(a.rect))) {
    const c0 = toUserSpace({ x: region.rect.x0, y: region.rect.y0 }, box, rotation)
    const c1 = toUserSpace({ x: region.rect.x1, y: region.rect.y1 }, box, rotation)
    ours.push(ctx.obj({
      Type: 'Viewport',
      BBox: [Math.min(c0.x, c1.x), Math.min(c0.y, c1.y), Math.max(c0.x, c1.x), Math.max(c0.y, c1.y)],
      Name: pdfText(`REDBEAM ${region.label === '' ? 'scale region' : region.label}`),
      Measure: revuMeasure(ctx, region.feetPerPoint),
    }) as PDFDict)
  }

  // Keep viewports somebody else drew; replace only REDBEAM's own. Ours go
  // last so they win where they overlap, which is right for OUR markups, and a
  // Revu user's calibration of some other part of the sheet survives.
  const existing = page.node.lookup(PDFName.of('VP'))
  const kept: PDFDict[] = []
  let hadOurs = false
  if (existing instanceof PDFArray) {
    for (let i = 0; i < existing.size(); i++) {
      const vp = existing.lookup(i)
      if (!(vp instanceof PDFDict)) continue
      if (textOf(vp, 'Name').startsWith('REDBEAM')) { hadOurs = true; continue }
      kept.push(vp)
    }
  }
  if (ours.length === 0 && !hadOurs) return false
  page.node.set(PDFName.of('VP'), ctx.obj([...kept, ...ours]))
  return true
}

/** Bookkeeping columns that differ between two stores holding the same takeoff. */
const BOOKKEEPING = new Set(['created_at', 'updated_at', 'text_indexed_at', 'native_text_available'])

/**
 * The slice as far as "has the takeoff changed?" is concerned.
 *
 * A Light file's store is built fresh every time the PDF is opened, so its
 * document and page rows carry that moment's timestamps, and it gains a page
 * row for every sheet that is looked at or indexed. Hashing those made every
 * opened file differ from itself: merely opening a PDF and paging through it
 * rewrote the file, and each rewrite appends a full copy of the takeoff. So
 * the document and page rows are compared without their bookkeeping, and only
 * the pages something was drawn or scaled on count.
 */
export function hashableTables(tables: SliceTables): SliceTables {
  const used = new Set<string>()
  for (const table of ['markups', 'calibrations', 'scale_regions', 'layout_components']) {
    for (const row of tables[table] ?? []) if (typeof row.page_id === 'string') used.add(row.page_id)
  }
  const plain = (row: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(row).filter(([k]) => !BOOKKEEPING.has(k)))
  const out: SliceTables = { ...tables }
  if (tables.documents !== undefined) out.documents = tables.documents.map(plain)
  if (tables.pages !== undefined) {
    out.pages = tables.pages.filter((p) => used.has(String(p.id))).map(plain)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
  }
  return out
}

/**
 * The page labels a slice carries (redbeam_meta `sheet_labels`, written by
 * the title-block reading), or null when it carries none.
 */
export function sheetLabelsFrom(tables: SliceTables): Array<string | null> | null {
  const row = (tables['redbeam_meta'] ?? []).find((r) => r['key'] === 'sheet_labels')
  const raw = row?.['value']
  if (typeof raw !== 'string' || raw === '') return null
  try {
    const v = JSON.parse(raw) as unknown
    if (!Array.isArray(v) || !v.some((l) => typeof l === 'string' && l !== '')) return null
    return v.map((l) => (typeof l === 'string' && l.trim() !== '' ? l : null))
  } catch {
    return null
  }
}

/**
 * A /PageLabels number tree: one /P entry per named page, and a decimal range
 * (numbered as the page's position) for each run of pages with no name.
 */
export function pageLabelTree(ctx: PDFContext, labels: ReadonlyArray<string | null>, pageCount: number): PDFDict {
  const nums: unknown[] = []
  let inRange = false
  for (let i = 0; i < pageCount; i++) {
    const l = labels[i] ?? null
    if (l !== null) {
      nums.push(PDFNumber.of(i), ctx.obj({ P: pdfText(l) }))
      inRange = false
    } else if (!inRange) {
      nums.push(PDFNumber.of(i), ctx.obj({ S: PDFName.of('D'), St: PDFNumber.of(i + 1) }))
      inRange = true
    }
  }
  return ctx.obj({ Nums: ctx.obj(nums as never[]) }) as PDFDict
}

/** The pages whose /Rotate differs from what REDBEAM shows them at. */
export function rotationsToWrite(
  pages: readonly PDFPage[], wanted: ReadonlyMap<number, number> | undefined,
): Array<[number, number]> {
  const out: Array<[number, number]> = []
  if (wanted === undefined) return out
  for (const [i, deg] of wanted) {
    const page = pages[i]
    if (page === undefined || !Number.isFinite(deg)) continue
    const angle = ((Math.round(deg / 90) * 90) % 360 + 360) % 360
    const have = ((page.getRotation().angle % 360) + 360) % 360
    if (angle !== have) out.push([i, angle])
  }
  return out
}

/**
 * Embed a sheet's takeoff in its PDF.
 *
 * Returns the new bytes as `source` plus an appended update, or `bytes: null`
 * when the file already carries exactly this slice — the common case of
 * closing a drawing nobody touched, which must not rewrite a synced file.
 */
export async function embedSheet(source: Uint8Array, input: EmbedInput): Promise<EmbedResult> {
  const doc = await load(source)
  const largestBefore = reserveExistingNumbers(doc, source)
  const out = embedInto(doc, largestBefore, input, updateBaseOf(source))
  if (out.tail === null) return out.result
  const bytes = new Uint8Array(source.length + out.tail.length)
  bytes.set(source, 0)
  bytes.set(out.tail, source.length)
  return { ...out.result, bytes }
}

/**
 * `embedSheet` for a drawing that is not in memory: `doc` was opened by byte
 * range (lazyPdf.ts) with its object numbers reserved up to the file's /Size.
 * `tail` is what to append to the file; `result.bytes` stays null.
 */
export function embedSheetTail(
  doc: PDFDocument,
  base: UpdateBase,
  input: EmbedInput,
): { result: EmbedResult, tail: Uint8Array | null } {
  return embedInto(doc, doc.context.largestObjectNumber, input, base)
}

interface PlannedRewrite {
  pageIndex: number
  rewrite: AnnotRewrite
  annot: PDFDict
  /** The annotation's own object, or null when it sits directly in /Annots. */
  ref: PDFRef | null
  /** Objects to put back on the sheet first. */
  restore: PDFRef[]
}

/** A reference written as "12 0 R", or null. */
function parseRef(text: string): PDFRef | null {
  const m = /^(\d+) (\d+) R$/.exec(text.trim())
  return m === null ? null : PDFRef.of(Number(m[1]), Number(m[2]))
}

/**
 * The rewrites that change something in this file: the annotation is on its
 * sheet (or can be put back) and stands somewhere else, or in another colour.
 * One being retired in the same save is left to the retire.
 */
/** The key a repeated /NM's copy on one page goes by. */
export function heldKey(nm: string, pageIndex: number): string {
  return `${nm}@p${pageIndex}`
}

/** The /NM a key stands for. */
export function nmOfKey(key: string): string {
  return key.replace(/@p\d+$/, '')
}

/** Which retire entry, if any, takes this /NM off this page. */
function retiredAs(retire: ReadonlySet<string>, nm: string, pageIndex: number): string | null {
  if (nm === '') return null
  if (retire.has(nm)) return nm
  const k = heldKey(nm, pageIndex)
  return retire.has(k) ? k : null
}

function planRewrites(doc: PDFDocument, rewrites: readonly AnnotRewrite[], retire: ReadonlySet<string>): PlannedRewrite[] {
  if (rewrites.length === 0) return []
  const pages = doc.getPages()
  const out: PlannedRewrite[] = []
  for (const rw of rewrites) {
    if (retiredAs(retire, rw.nm, rw.pageIndex) !== null) continue
    const page = pages[rw.pageIndex]
    if (page === undefined) continue
    let annot: PDFDict | null = null
    let ref: PDFRef | null = null
    const arr = page.node.lookup(PDFName.of('Annots'))
    if (arr instanceof PDFArray) {
      for (let i = 0; i < arr.size(); i++) {
        const a = arr.lookup(i)
        if (a instanceof PDFDict && !isOurs(a) && textOf(a, 'NM') === rw.nm) {
          annot = a
          const e = arr.get(i)
          ref = e instanceof PDFRef ? e : null
          break
        }
      }
    }
    const restore: PDFRef[] = []
    if (annot === null) {
      // Taken off by an earlier save and since restored here: its objects
      // are still in the file, unreferenced, and go back on the sheet.
      const refs = (rw.restore ?? []).map(parseRef).filter((r): r is PDFRef => r !== null)
      const first = refs[0]
      const found = first === undefined ? undefined : doc.context.lookup(first)
      if (!(found instanceof PDFDict) || textOf(found, 'NM') !== rw.nm) continue
      annot = found
      ref = first!
      restore.push(...refs.filter((r) => doc.context.lookup(r) instanceof PDFDict))
    }
    const box = page.getCropBox() as PageBox
    const need = rewriteNeeds(annot, rw, box, page.getRotation().angle)
    if (restore.length === 0 && need.dx === 0 && need.dy === 0 && need.to === null) continue
    out.push({ pageIndex: rw.pageIndex, rewrite: rw, annot, ref, restore })
  }
  return out
}

function embedInto(
  doc: PDFDocument,
  largestBefore: number,
  input: EmbedInput,
  base: UpdateBase,
): { result: EmbedResult, tail: Uint8Array | null } {
  const ctx = doc.context
  const before = readDoc(doc)
  const prev = before.slice

  const contentHash = hashHex(stableStringify({
    tables: hashableTables(input.tables),
    markups: input.markups,
    scales: [...input.pageScales.entries()],
    regions: [...(input.pageRegions?.entries() ?? [])],
    v: SLICE_VERSION,
    ...(input.retire === undefined || input.retire.length === 0 ? {} : { retire: [...input.retire].sort() }),
  }))

  // Every annotation REDBEAM wrote last time must still be as it wrote it;
  // otherwise it was edited elsewhere and the file is not "unchanged".
  //
  // Kept as the other app left it only while REDBEAM has not acted on the
  // markup since: once REDBEAM has taken the edit in (foreignEdits) or changed
  // the markup itself, its revision moved on, and REDBEAM's version is written.
  const editedNms = new Set<string>()
  for (const a of before.redbeamAnnots) {
    const recorded = prev?.annots[a.nm]
    if (recorded === undefined || recorded.fp === a.fp) continue
    const now = input.markups.find((m) => m.id === recorded.markupId)
    if (recorded.rev !== undefined && now?.rev !== undefined && now.rev !== recorded.rev) continue
    editedNms.add(a.nm)
  }
  const turned = rotationsToWrite(doc.getPages(), input.pageRotations)
  const retire = new Set(input.retire ?? [])
  const KEEP_SUBTYPES = new Set(['Link', 'Widget'])
  const foreignMarkup = (a: PDFDict): boolean => {
    if (input.retireForeign !== true || isOurs(a)) return false
    const st = a.lookup(PDFName.of('Subtype'))
    return !(st instanceof PDFName && KEEP_SUBTYPES.has(st.decodeText()))
  }
  const rewrites = planRewrites(doc, input.rewrite ?? [], retire)
  const retiring = rewrites.length > 0 || (retire.size > 0 && doc.getPages().some((p, i) => annotsOn(p).some((a) => !isOurs(a) && retiredAs(retire, textOf(a, 'NM'), i) !== null)))
    || (input.retireForeign === true && doc.getPages().some((p) => annotsOn(p).some((a) => foreignMarkup(a))))
  // Sheet names: a file saved before they became bookmarks is written once more.
  const labels = sheetLabelsFrom(input.tables)
  const outlineDue = labels !== null && !sheetOutlineCurrent(doc, labels)
  if (prev !== null && prev.contentHash === contentHash && editedNms.size === 0 && !retiring
    && prev.documentId === input.documentId && turned.length === 0 && !outlineDue) {
    return { result: { bytes: null, editedElsewhere: [], foreignKept: before.foreignAnnots, stamp: sliceStamp(prev) }, tail: null }
  }
  // Someone else saved a different takeoff into this file since this writer
  // last looked. Writing now would replace theirs with ours, unseen.
  if (input.expectStamp !== undefined && prev !== null && sliceStamp(prev) !== input.expectStamp
    && prev.contentHash !== contentHash) {
    return { result: { bytes: null, editedElsewhere: [], foreignKept: before.foreignAnnots, stamp: sliceStamp(prev), conflict: true }, tail: null }
  }

  const when = pdfDate(input.now?.() ?? new Date())
  const pages = doc.getPages()
  const changed: PDFRef[] = []
  const editedElsewhere: string[] = []
  const keptNms = new Set<string>()
  const retired: Record<string, string[]> = {}

  // 1. Take REDBEAM's previous annotations off, keeping everything else and
  //    any of ours that somebody edited.
  pages.forEach((page, pageIndex) => {
    const arr = page.node.lookup(PDFName.of('Annots'))
    if (!(arr instanceof PDFArray)) return
    const keep: unknown[] = []
    let removed = false
    for (let i = 0; i < arr.size(); i++) {
      const entry = arr.get(i)
      const a = arr.lookup(i)
      if (a instanceof PDFDict && isOurs(a)) {
        const nm = textOf(a, 'NM')
        if (editedNms.has(nm)) {
          keptNms.add(nm)
          editedElsewhere.push(prev?.annots[nm]?.markupId ?? nm)
          keep.push(entry)
          continue
        }
        removed = true
        continue
      }
      if (a instanceof PDFDict && foreignMarkup(a)) { removed = true; continue }
      if (a instanceof PDFDict && retire.size > 0) {
        // The retired markup, and the note popup that belongs to it.
        const parent = a.lookup(PDFName.of('Parent'))
        const owner = retiredAs(retire, textOf(a, 'NM'), pageIndex)
          ?? (parent instanceof PDFDict ? retiredAs(retire, textOf(parent, 'NM'), pageIndex) : null)
        if (owner !== null) {
          if (entry instanceof PDFRef) (retired[owner] ??= []).push(entry.toString())
          removed = true
          continue
        }
      }
      keep.push(entry)
    }
    if (!removed) return
    // Written as a DIRECT array on the page even if it was indirect: the old
    // array object stays in the file untouched, and only the page changes.
    page.node.set(PDFName.of('Annots'), ctx.obj(keep as never[]))
    changed.push(page.ref)
  })

  // 1b. Other apps' annotations moved, recoloured, or put back (annotRewrite.ts).
  //     Before any rotation of the page below: their targets were measured on
  //     the page as it was read.
  for (const r of rewrites) {
    const page = pages[r.pageIndex]!
    if (r.restore.length > 0) {
      const arr = page.node.lookup(PDFName.of('Annots'))
      const copy = ctx.obj([]) as PDFArray
      if (arr instanceof PDFArray) for (let i = 0; i < arr.size(); i++) copy.push(arr.get(i))
      for (const ref of r.restore) copy.push(ref)
      page.node.set(PDFName.of('Annots'), copy)
      changed.push(page.ref)
    }
    const box = page.getCropBox() as PageBox
    const need = rewriteNeeds(r.annot, r.rewrite, box, page.getRotation().angle)
    let touched = r.restore.length > 0
    for (const ref of translateAnnot(ctx, r.annot, need.dx, need.dy)) changed.push(ref)
    if (need.dx !== 0 || need.dy !== 0) touched = true
    if (need.from !== null && need.to !== null && recolorAnnot(ctx, r.annot, need.from, need.to)) touched = true
    if (!touched) continue
    r.annot.set(PDFName.of('M'), PDFString.of(when))
    if (r.ref !== null) changed.push(r.ref)
    else changed.push(page.ref)
  }

  // 2. Rotation, then scales, then this save's annotations: all three are
  //    placed through the page's rotation, so it has to be the new one.
  for (const [i, angle] of turned) {
    pages[i]!.setRotation(degrees(angle))
    changed.push(pages[i]!.ref)
  }
  const scaledPages = new Set<number>()
  for (let i = 0; i < pages.length; i++) {
    const regions = input.pageRegions?.get(i) ?? []
    const fpp = input.pageScales.get(i) ?? null
    if (writePageScale(ctx, pages[i]!, fpp, regions)) scaledPages.add(i)
  }
  for (const i of scaledPages) changed.push(pages[i]!.ref)

  const annots: SheetSlice['annots'] = {}
  // The edited ones stay recorded with their CURRENT fingerprint, so the next
  // save sees them as settled rather than as freshly edited again.
  for (const a of before.redbeamAnnots) {
    if (!keptNms.has(a.nm)) continue
    const markupId = prev?.annots[a.nm]?.markupId ?? a.markupId ?? ''
    const source = input.markups.find((m) => m.id === markupId)
    annots[a.nm] = {
      markupId, fp: a.fp,
      ...(source?.rev === undefined ? {} : { rev: source.rev }),
      ...(prev?.annots[a.nm]?.folded === undefined ? {} : { folded: prev.annots[a.nm]!.folded }),
    }
  }
  const editedMarkupIds = new Set(Object.values(annots).map((v) => v.markupId))

  const alpha = 0.28
  const annotRefs: Array<[number, PDFRef]> = []
  for (const markup of input.markups) {
    if (editedMarkupIds.has(markup.id)) continue
    const page = pages[markup.pageIndex]
    if (page === undefined) continue
    const regions = input.pageRegions?.get(markup.pageIndex) ?? []
    const ring = markup.rings[0]
    const fpp = ring === undefined || ring.length === 0
      ? input.pageScales.get(markup.pageIndex)
      : (regionAt(centroidOf(ring), regions)?.feetPerPoint ?? input.pageScales.get(markup.pageIndex))
    if (markup.kind === 'note') {
      if (markup.noteContent === undefined) continue
      const built = buildNoteAnnots(ctx, page, markup.rings, markup.noteContent, (part) => redbeamNm(markup.id + part), when)
      let head: PDFRef | null = null
      for (const b of built ?? []) {
        const bnm = redbeamNm(markup.id + b.part)
        b.dict.set(PDFName.of(KEY), ctx.obj({ MarkupId: pdfText(markup.id) }))
        b.dict.set(PDFName.of('P'), page.ref)
        // A callout's leader is grouped to its cloud, so Revu moves them together.
        if (head !== null) { b.dict.set(PDFName.of('IRT'), head); b.dict.set(PDFName.of('RT'), PDFName.of('Group')) }
        annots[bnm] = {
          markupId: markup.id, fp: annotFingerprint(b.dict),
          ...(markup.rev === undefined ? {} : { rev: markup.rev }),
        }
        const ref = ctx.register(b.dict)
        head ??= ref
        annotRefs.push([markup.pageIndex, ref])
      }
      continue
    }
    const nm = redbeamNm(markup.id)
    const annot = buildAnnot(ctx, page, markup, fpp, alpha, nm, when)
    if (annot === null) continue
    annot.set(PDFName.of(KEY), ctx.obj({ MarkupId: pdfText(markup.id) }))
    annot.set(PDFName.of('P'), page.ref)
    annots[nm] = {
      markupId: markup.id, fp: annotFingerprint(annot),
      ...(markup.rev === undefined ? {} : { rev: markup.rev }),
      ...(markup.folded === undefined || markup.folded.length === 0 ? {} : { folded: [...markup.folded] }),
    }
    annotRefs.push([markup.pageIndex, ctx.register(annot)])
  }
  for (const [pageIndex, ref] of annotRefs) {
    const page = pages[pageIndex]!
    let arr = page.node.lookup(PDFName.of('Annots'))
    if (!(arr instanceof PDFArray)) {
      arr = ctx.obj([])
      page.node.set(PDFName.of('Annots'), arr)
    } else if (page.node.get(PDFName.of('Annots')) instanceof PDFRef) {
      // Same reasoning as above: copy an indirect array onto the page.
      const copy = ctx.obj([]) as PDFArray
      for (let i = 0; i < arr.size(); i++) copy.push(arr.get(i))
      page.node.set(PDFName.of('Annots'), copy)
      arr = copy
    }
    ;(arr as PDFArray).push(ref)
    changed.push(page.ref)
  }

  // 3. Each sheet's own copy of its takeoff, so it goes wherever the sheet goes.
  const writtenAt = (input.now?.() ?? new Date()).toISOString()
  const perPage = pageSlicesFor({
    documentId: input.documentId, tables: input.tables, annots, pageCount: pages.length,
    writtenAt, appVersion: input.appVersion,
  })
  pages.forEach((page, i) => {
    const ps = perPage.get(i)
    const pi = page.node.lookup(PDFName.of('PieceInfo'))
    const had = pi instanceof PDFDict && pi.lookup(PDFName.of(KEY)) !== undefined
    if (ps === undefined && !had) return
    const next = ps === undefined
      ? ctx.obj({}) as PDFDict
      : pieceInfo(ctx, when, ctx.register(ctx.flateStream(utf8(JSON.stringify(ps)), { Type: 'REDBEAM#20PageSlice' })))
    if (pi instanceof PDFDict) {
      for (const [k, v] of pi.entries()) if (k.decodeText() !== KEY) next.set(k, v)
    }
    if (next.entries().length === 0) page.node.delete(PDFName.of('PieceInfo'))
    else page.node.set(PDFName.of('PieceInfo'), next)
    changed.push(page.ref)
  })

  // 4. The private slice.
  const slice: SheetSlice = {
    format: SLICE_FORMAT,
    version: SLICE_VERSION,
    documentId: input.documentId,
    relativePath: input.relativePath,
    displayName: input.displayName,
    writtenAt,
    appVersion: input.appVersion,
    tables: input.tables,
    annots,
    contentHash,
    pageHashes: [...perPage.values()].map((p) => p.pageHash),
  }
  const sliceRef = privateStream(ctx, JSON.stringify(slice))

  const catalogRef = ctx.trailerInfo.Root
  // A fresh, direct PieceInfo on the catalog, carrying over every other
  // application's entry as it was.
  const merged = pieceInfo(ctx, when, sliceRef)
  const pi = doc.catalog.lookup(PDFName.of('PieceInfo'))
  if (pi instanceof PDFDict) {
    for (const [k, v] of pi.entries()) if (k.decodeText() !== KEY) merged.set(k, v)
  }
  doc.catalog.set(PDFName.of('PieceInfo'), merged)
  if (catalogRef instanceof PDFRef) changed.push(catalogRef)

  // 5. Sheet names the estimator read off the title block, as the PDF's own
  //    page labels: Bluebeam (and every PDF viewer) shows them as the page
  //    names, and REDBEAM reads them back as the sheet index on reopening.
  //    And as bookmarks, which is where Bluebeam lists a set's sheets. The
  //    outline is rewritten before the labels change, because REDBEAM's old
  //    bookmarks are recognised by the labels they were written with.
  if (labels !== null) {
    for (const r of writeSheetOutline(doc, labels)) changed.push(r)
    doc.catalog.set(PDFName.of('PageLabels'), pageLabelTree(ctx, labels, pages.length))
  }

  // Second carrier: every annotation of ours points at the same stream.
  for (const [, ref] of annotRefs) {
    const a = ctx.lookup(ref, PDFDict)
    ;(a.lookup(PDFName.of(KEY)) as PDFDict).set(PDFName.of('Slice'), sliceRef)
  }

  // Pushed one by one: a spread of every new object overflows the stack on a big set.
  for (const r of newRefsSince(doc, largestBefore)) changed.push(r)
  return {
    result: {
      bytes: null, editedElsewhere, foreignKept: before.foreignAnnots, stamp: sliceStamp(slice),
      ...(Object.keys(retired).length === 0 ? {} : { retired }),
    },
    tail: incrementalTail(base, doc, changed),
  }
}

/**
 * Each sheet's visible size in PDF points, by zero-based sheet number. For
 * matching one PDF's sheets against another's without opening every page in
 * the viewer. A sheet that cannot be measured is null.
 */
export async function sheetSizes(bytes: Uint8Array): Promise<Array<{ width: number, height: number } | null>> {
  return sheetSizesOf(await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false }))
}

/** `sheetSizes` of a document already open (a big drawing read by range). */
export function sheetSizesOf(doc: PDFDocument): Array<{ width: number, height: number } | null> {
  return doc.getPages().map((p) => {
    try {
      const box = p.getCropBox()
      return box.width > 0 && box.height > 0 ? { width: box.width, height: box.height } : null
    } catch {
      return null
    }
  })
}
