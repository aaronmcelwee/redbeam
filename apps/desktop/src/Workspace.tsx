import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { pause, until } from './agents/wait.js'
import { PRIORITY_THUMBNAIL, Viewer, clampViewport, segmentsInClip, linkAt, zoomAbout, type OverlaySet, type Viewport, type PageAnnotation, type PageLink } from '@redbeam/viewer'
import PdfWorker from '@redbeam/viewer/worker?worker'
import {
  calibrationFromReference, calculateScopeQuantities, parseNumberOrFraction, parseLengthInput, isLengthUnit,
  formatLength, formatMeasureValue, scopeTypeForProduct,
  traceRegion,
  scopeToolWarning, calculatePieces, scopeDefaultDirectionFrom,
  SCALE_PRESETS, PRODUCT_TYPES, PRODUCT_TYPE_LABEL, readProductType, writeProductType, missingRequiredMeasures,
  areaSquareFeet, linearFeet, cutoutSquareFeet, cutoutSubtracts, feetPerPointForPreset, presetSource, scaleLabel,
  bucketByScale, conflictingRegions, type ScaleRegion,
  buildBom, bomToTsv,
  type MarkupKind, type PieceResult, type ScalePreset,
  type Calibration, type Markup, type Scope, type ScopeType, type QuantityResult,
  PAGE_DIRECTIONS_KEY, AREA_DIRECTIONS_KEY, AREA_ORIGINS_KEY, pageDirectionsFrom, areaDirectionsFrom,
  areaOriginsFrom, patternStartPoint, isAreaCorner, nearestAreaVertex, areaCornerPoint, normalizedBoundingRect, pointInRegion,
  canonicalProductType, scopeDefaultDirectionFrom as scopeDirectionOf, formatFeetInches,
  editableMeasures, measureHelp, readString, unitDisplayText, readBool, alignSeamsOf, cassettePieceList,
  deviceLocations, factoryCutPieces, perimeterTrimLengthFeet, resolveScaleForRings, type FactoryCut,
  checkOutline, type OutlineIssue,
  PATTERN_RECIPE_KEY, PATTERN_FORMAT, checkPatternRecipe, productLabelFor, scopeProductLabel, readPatternRecipe, builtInAsRecipe,
  approvePatternRecipe, approvePatternLayer, removePatternLayer,
  type PatternRecipe, type Polygon, type FieldFrame, areaRegion, regionArea,
} from '@redbeam/domain'
import {
  ensureDocumentAndPage, ensureDocumentAndPageStatements, runBatch, getCalibration, listCalibrations, listMarkups, listScopes, listActivity,
  listEstimates, createEstimate as createEstimateRow, listEstimateScopeIds,
  estimateDocuments, addScopeToEstimate,
  upsertScope, setScopeArchived, logActivity, type SqlDriver,
  pageIdFor, pageNumberFrom, rotatePageData, searchProjectText, indexPageText, textIndexCoverage,
  type DocumentRow, type SearchHit, type NormBox,
  UndoStack, PERSON as UNDO_PERSON, createMarkup as cmdCreate, removeMarkup as cmdRemove,
  editGeometry as cmdEditGeometry, editAnnotColor as cmdEditAnnotColor, editContent as cmdEditContent, setCalibration as cmdCalibrate, batch as cmdBatch,
  reassignScope as cmdReassign,
  type UndoState,
  recordFrozenCalculation, latestFrozenCalculation, frozenCalculationBefore,
  listCalculationQuantities,
  type CalculationRun, type QuantityResultInput,
  listAllCalibrations, listPageBoxes, applyScaleToPages, listDocuments,
  listAllScaleRegions, saveScaleRegion, deleteScaleRegion,
  copyEstimate,
  renameEstimate, deleteEstimate, removeScopeFromEstimate,
} from '@redbeam/store'
import { pagesNamed } from './agents/pagesNamed.js'
import { openDatabase, openMemory, openOldProjectDatabase, debounceSave, undoOptionsFor, type DbBackend } from './db.js'
import {
  resolveMarkups, deleteMarkupsCommand, rescopeMarkupsCommand, duplicateMarkupsCommand,
} from './markupBatch.js'
import { broadcastChange, onChange } from '@redbeam/store'
import { getWindowRole, openContextWindow, isTauri } from './tauri/window.js'
import { windowTitle } from './windowTitle.js'
import {
  emptyDraft, drawDraft, screenToNormalized, rectPointsBetween, isCommittable, draftLengthPdfPoints,
  type DraftState, type Tool,
} from './draw.js'
import { toOverlay } from './overlay.js'
import {
  commitDimension, dimensionDraftBack, dimensionDraftMove, dimensionDraftPlace,
  drawDimension, drawDimensionDraft, emptyDimensionDraft,
  type DimensionDraft, type DimensionMarkup,
} from './tools/dimension.js'
import {
  boxAtTail, canvasMeasure, drawNote, drawNoteDraft, emptyNoteDraft, hasText, hitTestNote, isNoteTool,
  leaderRingIndex, leaderTextSize, noteBack, noteDown, noteDraftStarted, noteFinish, noteMove, noteUp, notesOf,
  parseNoteContent, textBoxHeightFor, textRingIndex, TEXT_LEADING, TEXT_PAD_PT,
  type NoteContent, type NoteDraft, type NoteShape, type NoteStep,
} from './tools/notes.js'
import { loadNoteStyles, saveNoteStyles, type NoteStyles } from './tools/noteStyles.js'
import { NoteStrip, type NotePatch } from './shell/NoteStrip.js'
import { SEED_SCOPES } from './seed.js'
import { PageStrip } from './pages/PageStrip.js'
import './shell/shell.css'
import {
  DocumentTabStrip, FileList, Sidebar, SidebarTabs, TitleBar,
  type PanelFile, type ProjectMenuEntry, type RailPanel, type ShellTab,
} from './shell/Shell.js'
import { Dock, DocumentPill, ToolPill } from './shell/Dock.js'
import { newScope, nextScopeColor, SCOPE_PALETTE } from './shell/scopeFactory.js'
import { clipOf, notePaste, pasteStatus, planPaste, readClip, writeClip } from './markupClipboard.js'
import { SheetIndex } from './shell/SheetIndex.js'
import { NUMBER_BOX_COLOR, TITLE_BOX_COLOR, TitleBlockPicker, type PickStep } from './shell/TitleBlockPicker.js'
import {
  SHEET_LABELS_KEY, SHEET_OVERRIDES_KEY, TITLE_REGIONS_KEY, bookmarksHaveLabels, isTinyBox, labelsToWrite, mergeNames, parseOverrides,
  parseRegions, readSheetName, textInBox, type ReadName, type TitleBlockRegions,
} from './shell/titleBlock.js'
import { useClampedPopover } from './shell/popover.js'
import { pageStepForKey, steppedPage, toolForKey } from './shell/sheetKeys.js'
import type { SheetScope } from './shell/sheets.js'
import { StatusToast } from './shell/StatusToast.js'
import { PerfReadout } from './shell/PerfReadout.js'
import { buildSheetIndex, isOrdinalLabel, mergeSheetLabels, sheetFromText } from './shell/sheets.js'
import type { FoundTitleBlock } from './shell/findTitleBlock.js'
import { SheetNamer } from './shell/sheetNamer.js'
import type { SheetIndexShape, SheetOutlineNode } from './shell/sheets.js'
import {
  EstimatesPanel, type EstimateFile, type EstimateListItem, type PanelWarning, type ScopeMarkup, type ScopeStanding,
  type ScopePage,
} from './shell/RightWorkspace.js'
import { renderTakeoffReport } from './export/report.js'
import { projectBridge, projectNameFromPath } from './project/bridge.js'
import { createCoreDocumentUrlResolver } from './project/ingest.js'
import { copyRanged, openRanged, readEmbedRanged, withRanged, type RangedDrawing } from './export/rangedPdf.js'
import { openProjectDocuments, type ProjectScanner } from './project/openProject.js'
import { SearchPanel, type SearchScope } from './search/SearchPanel.js'
import { CommandPalette } from './palette/CommandPalette.js'
import type { Command, Outcome, Step } from './palette/commands.js'
import { snapPoint, drawSnapIndicator, DEFAULT_SNAP, type SnapResult } from './snap.js'
import {
  hitTest, drawAnnotationSelection, drawSelection, drawMarquee, markupsInRect, insertVertexAt, removeVertexAt,
  isAxisAlignedRect, resizeRectVertex, resizeRectEdge, VERTEX_GRAB_PX, type Hit,
} from './hit.js'
import { buildAnchorGrid, nearestAnchor, type AnchorGrid } from './snapAnchors.js'
import { normalizedToScreen } from './draw.js'
import { CURVE_TOOLS, backCurvePoint, curveModeForKey, finishCurve, placeCurvePoint, type SegmentMode } from './tools/curves.js'
import { LinkBar, SegmentBar, segmentCaption } from './shell/SegmentBar.js'
import { LinkPicker } from './shell/LinkPicker.js'
import { CalloutReview, type ReviewState } from './shell/CalloutReview.js'
import { findCallouts } from './tools/callouts.js'
import { boxRing, linkContentOf, pageLinksFrom, ringBox, suggestTargets } from './tools/links.js'
import { LINK_COLOR } from './overlay.js'
import { useStageSize, sizeCanvas } from './useStageSize.js'
import { embedWhenQuiet } from './autoEmbed.js'
import { parsePageRange, printPdf, printedWhat, sheetsPdf } from './print.js'
import { PerfRegistry } from './perf.js'
import { isTextEntry, survivesTextEntry } from './keys.js'
import { boundsOfRings, frameBox, historyStepForButton, historyStepForKey, ViewHistory, zoomToBox, type ScreenBox, type ViewPlace } from './viewNav.js'
import { wordsAsText, wordsInBox, type PickedWord } from './textSelect.js'
import { openWebLink } from './tauri/openWith.js'
import { readSession, writeSession } from './session.js'
import { calculationFor, deltaBetween, type QuantityDelta } from './commit.js'
import { projectCommands } from './palette/projects.js'
import { copyBillTsv, saveReportFile } from './bom/exports.js'
import { ScalePicker } from './scale/ScalePicker.js'
import { exportMarkedPdf, type RangedMarkedPdf } from './export/markedPdf.js'
import {
  copyInput, copyName, copyTarget, type CopyTarget, embedCopy, embedDrawing, embedStatus, ensureFileRound, fileLoadVerdict, foreignEdits, foreignEditsStatus, importScopesFromSlice, importTakeoffFromSlice, takeoffImportStatus, importSlice, rebuildFromAnnots, rebuiltStatus,
  migrateProjectTakeoffs, migrationStatus, openingStatus, scopeImportStatus, takeNewerSlice, unsavedReason,
  type EmbedOutcome, type FileLoad,
} from './export/drawingEmbed.js'
import {
  drawingsToTransfer, oldDrawingAt, undrawnPending, transferComplete, transferOffer, transferOldProject, transferStatus, type TransferResult,
} from './export/oldProject.js'
import { keptDrawingFile, projectDrawingFile } from './export/drawingSync.js'
import { embedInWorker } from './export/embedInWorker.js'
import { sheetSizes, sliceStamp, isRedbeamNm, readSheetEmbed } from './export/sheetEmbed.js'
import { adoptForeignAnnots } from './export/adopt.js'
import { areaWithCutouts, cutoutsFor, readPdfCutouts, type RawCutouts } from './export/pdfCutouts.js'
import {
  cutAllEdits, cutEdits, cutOwner, cutRemoves, cutTarget, foldCutouts, isCutId, measureCut, previewCut, recutEdits, uncutAllEdits, uncutEdits, withCutouts, type CutMeasure,
  type GeometryEdit,
  CUT_PREFIX,
} from './cutouts.js'
import { ExportSheet } from './export/ExportSheet.js'
import {
  buildEstimateExport, estimateToCsv, estimateToTsv, exportFileName, type EstimateExport,
} from './export/estimateExport.js'
import { renderEstimatePdf } from './export/estimatePdf.js'
import { saveFile, saveOutcomeText } from './export/saveFile.js'
import { pageIndexOf as pageIndexOfId } from './export/snapshotPlan.js'
import { takeoffFor } from './export/estimatePackage.js'
import { estimatePdfInWorker } from './export/estimatePdfInWorker.js'
import { indexProject, type IndexProgress } from './search/indexer.js'
import { findInPageText, pageForSheet, wordsOnPage, type TextMatch } from './search/findText.js'
import type { PageText } from '@redbeam/viewer'
import { detectPattern, linesFromSegments, measurePoints } from './search/measure.js'
import { describeAllProducts, describeProduct, measuresAsText, missingKeys, spacingSourceFlag, unknownSpecKeys } from './agent/products.js'
import { ringsAreaPoints, snapToLinework } from './agent/snapTrace.js'
import { traceFieldInWorker } from './agent/fieldTraceInWorker.js'
import { expandRing } from './agent/arcs.js'
import { checkScale, statedScales } from './agent/statedScale.js'
import { agentPieceList, pieceList } from './agent/pieceList.js'
import { openHeadlessDocument } from './project/headlessDocument.js'
import { laneCount, PageTextPool } from './search/textPool.js'
import { hitTestDimension } from './tools/dimension.js'
import { drawPatternItems, type PatternOriginItem } from './tools/pattern.js'
import { pickOriginArea } from './tools/origin.js'
import {
  hiddenOnPage, hiddenStorageKey, hideAll, hideAnnotation, parseHiddenBook, showHidden,
  visibleAnnotations, type HiddenBook,
} from './tools/foreignMarkups.js'
import { HELD_COLORS, heldColorOf, heldEditsFor, heldLabelOf, heldNmOf, heldStateKey } from './tools/heldAnnots.js'
import { drawPanelLayout, drawPatternShapes, drawRunLayout, layoutSummary } from './layout/drawLayout.js'
import { libraryEntry, readLibrary, saveToLibrary, newerInLibrary } from './patterns/library.js'
import type { PatternControls } from './shell/PatternCard.js'
import { drawScaleRegions } from './scale/drawRegions.js'
import { UNNAMED_CALL, useBridgeHost, type CallContext } from './bridge/useBridgeRequests.js'
import { bomScopeFilter, fieldPerimeters, perAreaCounts } from './bom/agentBom.js'
import { detectGrid, nearestCrossing } from './search/grid.js'
import { directionRegions } from './search/directions.js'
import { compareHatches, hatchSignature, legendRows } from './search/hatch.js'
import { keepingFocus } from './agents/focusGuard.js'
import { AgentCursors, type AgentCursorsHandle } from './agents/AgentCursors.js'
import { AgentBar, type AgentTabItem, tabMarks, useAgents } from './agents/AgentTabs.js'
import { AgentsDock, AgentSummary, askLookIn, peekMarks, showAgentsDock, takeLookIn } from './agents/AgentsPane.js'
import { samePath } from './lightTabs.js'
import { SettingsPanel } from './settings/SettingsPanel.js'
import { THEME_CHANGED } from './theme.js'
import { ReportDialog } from './report/ReportDialog.js'
import { openWhatsNew } from './whatsnew/open.js'
import {
  EMPTY_DRAFT, REPORT_KINDS, SUMMARY_MAX, buildPayload, captureStage, gatherContext, sendReport, whereLine,
  type ReportDraft, type ReportKind,
} from './report/report.js'
import { RELEASES } from './whatsnew/changelogSource.js'
import { noteFromAgent, noteStyle, refitLeaderText, roughMeasure } from './agents/agentNotes.js'
import { reportForAgent, whatsNewForAgent } from './agents/appWide.js'
import { APP_VERSION } from './update/updates.js'
import { UpdateChip } from './update/UpdateChip.js'
import { Glyph, Check, Compass, Minus, Plus, Trash2, Pentagon, Ruler, Highlighter, Copy, Duplicate, Crosshair, Eye, EyeOff, Bug, Sparkles } from './shell/icons.js'
import { LIGHT_HIDDEN_SETTINGS, LIGHT_PANELS, LIGHT_REACHES, lightCommands } from './light.js'
import { SettingsStore, browserStorage, restoreFromFile as restoreSettingsFromFile } from './settings/store.js'
import { provideNames, signal } from './signals/install.js'
import { SETTINGS, CATEGORY_LABEL } from './settings/registry.js'

/**
 * Deepest zoom, 6400%, as Bluebeam allows. It was 1000% (Aaron, 2026-11-24:
 * no arbitrary caps); the tiles render only what is on screen, so a deeper
 * zoom costs no more than a shallow one.
 */
/** JSON with object keys sorted, so two values that differ only in key order compare equal. */
const stableJson = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (
  x !== null && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : x))

const MAX_ZOOM = 64
const VW = 1180
const VH = 780
/**
 * Browser mode has no project folder to ingest, so it gets one synthetic
 * document standing in for the bundled sample. On the desktop this is never
 * used — the id comes from the ingested row, which is derived from the file's
 * relative path so the same file always resolves to the same takeoff.
 */
/** What a scope counts, as the Setup page words it. */
const SCOPE_TYPE_LABEL: Record<ScopeType, string> = { area: 'areas', linear: 'lengths', count: 'counts' }

const FALLBACK_DOC = { id: 'doc-sample', relativePath: 'sample.pdf', displayName: 'Sample drawing' }
/**
 * Page and document identity come from @redbeam/store, never from here.
 *
 * An earlier revision of this file defined its own `pageIdFor` with a
 * different separator. Two id schemes for the same row is how a markup gets
 * silently orphaned: written under one scheme, looked up under the other, and
 * simply not found. The store owns identity.
 */

/** How long after the last change a scope's numbers are saved. */
const AUTO_SAVE_MS = 1500
/** An undo this soon after the same action means the action surprised the person. */
const UNDO_SOON_MS = 5000
/** Local midnight, as the ISO time runs are stamped in: where "today's save" begins. */
function startOfToday(now = new Date()): string {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

const uid = () => `mk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

export interface WorkspaceProps {
  /** Absolute path of the open project folder. */
  projectPath: string
  /** Called when the user closes the project and returns to the start screen. */
  onCloseProject: () => void
  /** Other projects, for the title-bar switcher. */
  recentProjects?: ProjectMenuEntry[]
  /**
   * Open another project. A window IS a project, so this opens a SECOND window
   * and leaves this one alone.
   */
  onOpenProject?: (path: string) => void
  /** Pick a folder, then open it — same second-window rule. */
  onBrowseProject?: () => void
  /**
   * QUICK VIEW: a drawing open with no project behind it.
   *
   * The store is in memory and holds this one file; nothing persists. Any
   * markup action asks for the drawing's project folder first — `onAdopt` —
   * rather than making a project beside the PDF by itself. Aaron, 2026-09-18.
   */
  quickView?: {
    file: string
    relativePath: string
    onAdopt: () => void
    /**
     * LIGHT MODE (Aaron, 2026-11-18): the file is the record. Takeoff is
     * allowed straight away, the PDF carries the scopes and markups, and the
     * project's rounds stay out of sight. Without it this is plain quick view.
     */
    light?: boolean
    /** Light mode: pick another PDF to open in this window. */
    onOpenAnother?: () => void
    /**
     * Light mode's tabs, one per open PDF (lightTabs.ts). The app saves the
     * one showing before it shows another, so these only say what to do.
     */
    tabs?: {
      /** `owner`: the agent whose tab it is (agents/roster.ts); absent on the person's own. */
      list: AgentTabItem[]
      onSelect: (file: string) => void
      onClose: (file: string) => void
      onStep: (step: 1 | -1) => void
      onReopen: () => void
      /** Take an agent's tab back as the person's own. */
      onTakeOver?: (file: string) => void
      /** End an AI session from its group, dismiss a finished one, reopen a PDF it closed. */
      onEndSession?: (agentId: string) => void
      onDismissSession?: (agentId: string) => void
      onReopenFile?: (file: string) => void
    }
  }
  /**
   * Whether this is the PDF the person is looking at. False for one live
   * behind it, where an agent is working (App.tsx `LiveWorkspace`): that one
   * answers the bridge and paints its canvas, and leaves the window's keys,
   * title and focus alone. Defaults to true.
   */
  showing?: boolean
  /** Name this job, as the switcher's header offers. */
  onRenameProject?: (name: string) => void
  /** Show this job's folder in Explorer. Desktop only. */
  onRevealProject?: () => void
  /** The recents list changed under a prompt action (rename, hide, set aside); re-read it. */
  onRecentsChanged?: () => void
  /**
   * The drawing this window was opened to show, by relative path.
   *
   * Set on a context window popped out from a tab. Without it the new window
   * would open whatever the project opens first, which for a "pop this sheet
   * out" gesture is the one thing it must not do.
   */
  initialDocumentPath?: string | null
  /**
   * Hand the window what to finish before it closes, or null for nothing.
   * Light mode registers saving the open drawing into its PDF.
   */
  /**
   * What must happen before this window closes. The function saves, and
   * resolves false when the window should stay open (it has then asked the
   * person, and calls `leave` itself if they choose to go).
   */
  onBeforeClose?: (fn: ((leave: () => void, opts?: { closing?: boolean }) => Promise<boolean>) | null) => void
}

/**
 * The page index encoded in a page id.
 *
 * Page ids are `<documentId>-p<index>` (see `pageIdFor`), so this is a parse,
 * not a lookup. Module scope rather than a hook because it depends on nothing
 * and every hook that needed it had to list it as a dependency.
 */
/** `a.localeCompare(b)`, without building a collator on every call. */
const collate = new Intl.Collator().compare
/** One decimal, as `toLocaleString` would, with one formatter for every row. */
const one = new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format

function pageIndexOf(pageId: string): number | null {
  const m = /-p(\d+)$/.exec(pageId)
  return m === null ? null : Number(m[1])
}

/**
 * Cutouts that subtract from nothing: no area of the same scope on the same
 * page overlaps them, the rule `effectiveAreaRings` applies.
 */
interface EstimateLoad { rounds: EstimateListItem[]; scopeIds: string[]; files: EstimateFile[] }

/** The project's bidding rounds and, for the open one, its scopes and drawings. */
async function loadEstimates(db: SqlDriver, openId: string | null): Promise<EstimateLoad> {
  const [rounds, scopeIds, files] = await Promise.all([
    listEstimates(db),
    openId === null ? Promise.resolve([] as string[]) : listEstimateScopeIds(db, openId),
    openId === null ? Promise.resolve([] as EstimateFile[]) : estimateDocuments(db, openId),
  ])
  return {
    rounds: rounds.map((e) => ({
      id: e.id, name: e.name, scopeCount: e.scopeCount, markupCount: e.markupCount, scopeIds: e.scopeIds,
    })),
    scopeIds,
    files,
  }
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/** The project's scale regions, grouped by page. */
async function loadRegions(db: SqlDriver): Promise<Map<string, ScaleRegion[]>> {
  const rows = await listAllScaleRegions(db)
  const byPage = new Map<string, ScaleRegion[]>()
  for (const r of rows) {
    const region: ScaleRegion = {
      id: r.id,
      pageId: r.pageId,
      label: r.label,
      feetPerPoint: r.feetPerPdfPoint,
      rect: { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 },
    }
    const list = byPage.get(r.pageId)
    if (list) list.push(region)
    else byPage.set(r.pageId, [region])
  }
  return byPage
}

function strayCutouts(markups: readonly Markup[]): number {
  let n = 0
  for (const c of markups) {
    if (c.kind === 'cutout' && !cutoutSubtracts(c, markups)) n++
  }
  return n
}

/**
 * How far past the sheet's edge the wheel, the pinch and a drag may show
 * canvas: half a window. Fit and page changes still frame the sheet exactly.
 */
const OVERSCROLL = 0.5

/* ------------------------------------------------- the PDF's own markups -- */

/**
 * The convertible annotation under a normalized point: the smallest box
 * that contains it, so a note inside a room picks the note. A hair of
 * slack, as the right-click menu has always allowed.
 */
function annotationAt(
  n: { x: number; y: number },
  list: readonly PageAnnotation[],
  hidden?: ReadonlySet<number>,
): PageAnnotation | null {
  const slack = 0.002
  let best: PageAnnotation | null = null
  let bestArea = Number.POSITIVE_INFINITY
  for (const a of visibleAnnotations(list, hidden ?? new Set())) {
    const r = a.rect
    if (n.x < r.x0 - slack || n.x > r.x1 + slack || n.y < r.y0 - slack || n.y > r.y1 + slack) continue
    const area = (r.x1 - r.x0) * (r.y1 - r.y0)
    if (area < bestArea) { best = a; bestArea = area }
  }
  return best
}

/* ---------------------------------------------------------- hover cursor -- */

/**
 * The resize cursor for a grip on an axis-aligned rectangle, or a move
 * cursor over a markup's inside, in the Select tool. Anything else keeps the
 * tool's cursor. Only rectangles get resize arrows: on a polygon an edge
 * drag is not a resize, and a corner drag moves one vertex.
 */
function hoverCursorFor(hit: Hit | null, markups: readonly Markup[], tool: Tool): string | null {
  if (hit === null || tool !== 'select') return null
  const ring = markups.find((m) => m.id === hit.markupId)?.rings[0]
  if (ring === undefined) return null
  if (hit.part === 'inside') return 'move'
  if (!isAxisAlignedRect(ring)) return null
  if (hit.part === 'edge') {
    const a = ring[hit.index]!
    const b = ring[(hit.index + 1) % ring.length]!
    return Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? 'ns-resize' : 'ew-resize'
  }
  let cx = 0, cy = 0
  for (const p of ring) { cx += p.x; cy += p.y }
  cx /= ring.length; cy /= ring.length
  const p = ring[hit.index]!
  return (p.x < cx) === (p.y < cy) ? 'nwse-resize' : 'nesw-resize'
}

/* ------------------------------------------------------- sidebar widths -- */

/** Both panes start at this width: equal, as asked. */
const SIDEBAR_DEFAULT = 340
const clampPane = (w: number) => Math.round(Math.min(560, Math.max(232, w)))
const clampWork = (w: number) => Math.round(Math.min(640, Math.max(320, w)))
function readWidth(key: string, clamp: (w: number) => number): number {
  try {
    const raw = localStorage.getItem(key)
    const n = raw === null ? Number.NaN : Number(raw)
    return Number.isFinite(n) ? clamp(n) : SIDEBAR_DEFAULT
  } catch {
    return SIDEBAR_DEFAULT
  }
}

/**
 * A drag handle on one edge of the drawing. Reports the pointer's window x
 * while dragging; the caller turns that into a pane width. Double-click
 * resets. Pointer capture keeps the drag alive over the sheet and the pane.
 */
function ColumnGrip({ side, onDrag, onReset }: {
  side: 'left' | 'right'
  onDrag: (clientX: number) => void
  onReset: () => void
}) {
  return (
    <div
      className={`colgrip ${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={side === 'left' ? 'Resize the left pane' : 'Resize the estimates pane'}
      title="Drag to resize · double-click to reset"
      onDoubleClick={onReset}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        const el = e.currentTarget
        try { el.setPointerCapture(e.pointerId) } catch { /* synthetic events */ }
        el.classList.add('dragging')
        const move = (ev: PointerEvent) => onDrag(ev.clientX)
        const up = () => {
          el.classList.remove('dragging')
          el.removeEventListener('pointermove', move)
          el.removeEventListener('pointerup', up)
          el.removeEventListener('pointercancel', up)
        }
        el.addEventListener('pointermove', move)
        el.addEventListener('pointerup', up)
        el.addEventListener('pointercancel', up)
      }}
    />
  )
}

/** Area geometry edits as one undo step, or null when there are none. */
function editsCommand(edits: readonly GeometryEdit[], what: string, origin: string = 'user') {
  if (edits.length === 0) return null
  const cmds = edits.map((e) => cmdEditGeometry(e.id, e.before, e.after, what, undefined, origin))
  return cmds.length === 1 ? cmds[0]! : cmdBatch(what, cmds)
}

/**
 * The "rebuilt from the markups" note, once read, stays away for that file.
 * Aaron, 2026-11-24: "I have no way to dismiss this". Kept per viewer; a
 * different rebuild of the file (other counts) says so again.
 */
const REBUILT_DISMISSED = 'redbeam.rebuilt-note-dismissed'
function rebuiltDismissed(key: string): boolean {
  try { return (JSON.parse(localStorage.getItem(REBUILT_DISMISSED) ?? '[]') as string[]).includes(key) } catch { return false }
}
function rememberRebuiltDismissed(key: string): void {
  try {
    const now = (JSON.parse(localStorage.getItem(REBUILT_DISMISSED) ?? '[]') as string[]).filter((k) => k !== key)
    localStorage.setItem(REBUILT_DISMISSED, JSON.stringify([...now, key].slice(-200)))
  } catch { /* not remembered: it shows again next open */ }
}

/**
 * How long a save before closing the window may take before the person is
 * asked. 0.3.66 asked after 4 s, and on every leave: an 80 MB set saving
 * while an agent switched tabs put the ask up mid-work (Aaron, 2026-11-24).
 */
const SLOW_SAVE_MS = 15000
/**
 * How long one answer to an AI app waits for sheets that are still being read
 * before it reports what it has and where to carry on. It is NOT a limit on
 * the work (Aaron, 2026-11-24: no arbitrary caps; sets pass a thousand
 * sheets): the reading goes on in the background until it is finished, and
 * the next call picks up where this one stopped. The window says it is
 * still working every two seconds meanwhile, so ui.rs UI_TIMEOUT never
 * trips. 8 s made a 257-sheet set take four calls (NOIC intake, 2026-11-26).
 */
const AGENT_REPLY_MS = 30_000
const SLOW_SAVE_WHY = 'The save has not finished after a few seconds. The PDF may be busy in another app, or on a slow or syncing drive.'

export default function Workspace({
  projectPath, onCloseProject, recentProjects, onOpenProject, onBrowseProject, onRecentsChanged, onRenameProject, onRevealProject, quickView,
  initialDocumentPath, onBeforeClose, showing = true,
}: WorkspaceProps) {
  /** Light mode: a PDF on its own, its takeoff saved inside it. */
  const light = quickView?.light === true
  /**
   * Whether the person is looking at this PDF, for the listeners bound to
   * the window. Several workspaces are mounted at once now, and the window's
   * keys belong to the one showing: a Delete pressed in the person's tab
   * must not also delete the selection in the tab an agent is working in.
   */
  const showingRef = useRef(showing)
  showingRef.current = showing
  /** Set once the views exist; run when this PDF comes on screen (see `askLookIn`). */
  const lookInRef = useRef<() => void>(() => {})
  useEffect(() => { if (showing) lookInRef.current() }, [showing])
  const stageRef = useRef<HTMLDivElement>(null)
  const rasterRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const viewerRef = useRef<Viewer | null>(null)
  const viewRef = useRef<Viewport>({ ox: 0, oy: 0, zoom: 0.35, vw: VW, vh: VH })
  /** Live stage size in CSS pixels plus the display's device-pixel ratio. */
  const stage = useStageSize(stageRef)
  /** The stage size for callbacks that outlive a render (the viewer's onPage). */
  const stageSizeRef = useRef(stage)
  stageSizeRef.current = stage
  const dragRef = useRef<{ x: number; y: number } | null>(null)
  const dbRef = useRef<SqlDriver | null>(null)
  const saveRef = useRef<() => void>(() => {})
  /** Changes made, and the count the last save into the PDF had seen. */
  const changeTickRef = useRef(0)
  const lastSaveRef = useRef<{ tick: number; kind: string; at: string } | null>(null)
  const undoRef = useRef<UndoStack | null>(null)
  // geometry as it was when a drag began, so the edit can be undone as one step
  const dragOriginRef = useRef<Array<{ x: number; y: number }> | null>(null)
  const draftRef = useRef<DraftState>(emptyDraft('pan'))

  const identity = useMemo(() => getWindowRole(), [])
  /*
   * The project's display name -- its folder name, not its whole path.
   *
   * Derived once and shared rather than recomputed per call site. Four
   * places need it: the title bar, the estimates panel, the BOM panel and
   * the automation bridge's export action. The last two put it in the
   * <title> and <h1> of the branded report, so a report the agent generates
   * and one the button generates have to carry the same name. Four
   * hand-rolled copies of one split is how three of them ended up with a
   * forward-slash-only character class, which splits nothing on Windows and
   * printed the entire path where the project name belongs.
   */
  // The name the estimator gave the project, when there is one; the folder
  // name otherwise.
  const projectName = useMemo(
    () => (light ? quickView?.relativePath.split('/').pop()?.replace(/\.pdf$/i, '') : undefined)
      || recentProjects?.find((p) => p.path.toLowerCase() === projectPath.toLowerCase())?.displayName
      || projectNameFromPath(projectPath) || 'Project',
    [projectPath, recentProjects, light, quickView?.relativePath],
  )
  const [backend, setBackend] = useState<DbBackend | null>(null)
  /*
   * Status carries WHEN it was said, not just what.
   *
   * Thirty-odd `setStatus` calls report outcomes — "committed C-MT-01",
   * "cannot delete: …", "Create an estimate first" — and for a long while the
   * string went only to the automation bridge: no element in the shell
   * rendered it, so every refusal and every confirmation was silent to the
   * person who caused it. A toast shows it now, and it keys on the timestamp
   * because "undid area" said twice in a row is two events, not one.
   */
  const [statusEntry, setStatusEntry] = useState<{ text: string; at: number }>({ text: 'booting', at: 0 })
  const status = statusEntry.text
  /** When the status line last said something; Light's Save asks whether the save did. */
  const statusAtRef = useRef(0)
  const setStatus = useCallback((text: string) => {
    const at = Date.now()
    statusAtRef.current = at
    setStatusEntry({ text, at })
  }, [])
  const [page, setPage] = useState({ width: 0, height: 0 })
  /** Latest value, for copy and paste, which run from the key listener. */
  const pageSizeRef = useRef(page)
  pageSizeRef.current = page
  const [documents, setDocuments] = useState<DocumentRow[]>([])
  /*
   * Whether the folder scan has finished. Until it has, an empty `documents`
   * is not a fact about the project — a SharePoint-synced folder took 152
   * seconds to list 736 PDFs, and for all of it the files pane said the
   * project held none.
   */
  const [scan, setScan] = useState<'reading' | 'done'>('reading')
  const [activeDocId, setActiveDocId] = useState<string | null>(null)
  /**
   * Documents with a TAB, which is not the same as documents in the project.
   * A real bid package runs to hundreds of sheets — the Barclays job catalogs
   * 693 — so opening a project must not open 693 tabs. The full list lives in
   * the browser; tabs are for what you are working on.
   */
  const [openDocIds, setOpenDocIds] = useState<string[]>([])
  /** Tabs closed this session, oldest first, for "Reopen closed tab". */
  const closedTabsRef = useRef<string[]>([])
  /*
   * The document browser is the Files pane. "Open another document" from the
   * tab strip, the app menu or the bridge opens that pane and puts the cursor
   * in its filter; like search, what survives is a nonce, because the pane
   * may already be open and a mounted field does not focus itself.
   */
  const [filesFocus, setFilesFocus] = useState(0)
  /*
   * "Add scope", likewise: the round names its own scopes in the sidebar, and
   * a request from the dock or the palette bumps this so the naming row opens.
   */
  const [addScopeRequest, setAddScopeRequest] = useState(0)
  const [docUrl, setDocUrl] = useState<string | null>(null)
  const [ingestNote, setIngestNote] = useState<string | null>(null)
  /** The project-wide text indexer's progress; null when it is not running. */
  const [indexing, setIndexing] = useState<IndexProgress | null>(null)
  /*
   * Search is a RAIL PANE, so it has no open/closed state of its own — the
   * rail owns that. What survives is a nonce: pressing Ctrl+F while the pane
   * is already open should put the cursor back in the field, and re-rendering
   * an already-mounted pane would not.
   */
  const [searchFocus, setSearchFocus] = useState(0)
  const [searchSeed, setSearchSeed] = useState('')
  /** Key of the (document, page) whose `pages` row is known to exist. */
  const [pageReadyKey, setPageReadyKey] = useState<string | null>(null)
  const [textNote, setTextNote] = useState<string | null>(null)
  const [pageCount, setPageCount] = useState(0)
  /** The open drawing could not be read at all (not a PDF, damaged): said in the panes, not as a PDFium error. */
  const [openFailed, setOpenFailed] = useState(false)
  const [pageIndex, setPageIndex] = useState(0)
  // Callbacks that are deliberately stable (sync handlers, the undo path) still
  // need the live page; state alone would give them the page as of their last
  // creation.
  const pageIndexRef = useRef(0)
  const docIdRef = useRef<string>(FALLBACK_DOC.id)
  const regionsRef = useRef<Map<string, ScaleRegion[]>>(new Map())
  const toolRef = useRef<Tool>('pan')
  /**
   * The page's calibration, for the paint loop.
   *
   * A committed dimension's label is derived from its length and the page's
   * scale, and the painter read neither: it drew every dimension with
   * `feetPerPoint: 0`, so a calibrated sheet's dimensions all said "set
   * scale first". A ref rather than a dependency, because the paint callback
   * must not be rebuilt on every calibration change.
   */
  const calRef = useRef<Calibration | null>(null)
  /**
   * Space is held: the next press-and-drag pans, WHATEVER tool is in hand.
   *
   * Every drawing application does this and an estimator's hands expect it —
   * halfway through a polygon you hold space, drag the sheet over, let go
   * and place the next vertex. It also covers the middle button. The ref
   * pair is read by the pointer handlers; nothing re-renders for it.
   */
  const spaceRef = useRef(false)
  const panOverrideRef = useRef(false)
  /**
   * Is a dialog on screen?
   *
   * Read by the key handler, which guarded only TEXT ENTRY — so with Settings
   * or the BOM open, pressing `a` armed the Area tool on the drawing behind
   * them. The next click then drew a markup the person never meant to start,
   * on a sheet they were not looking at.
   */
  const dialogOpenRef = useRef(false)
  /**
   * The in-progress dimension.
   *
   * Its own ref rather than a branch of `draftRef`, because a dimension is a
   * different state machine: two placed points and a perpendicular offset,
   * against the shape draft's list of vertices. Folding them together was how
   * the Qt build's version grew the bugs this port left behind.
   */
  const dimensionDraftRef = useRef<DimensionDraft>(emptyDimensionDraft())
  /*
   * The note tools (tools/notes.ts): the shape being placed, the style each
   * tool draws with next, and the text box being typed into. The editor is
   * a textarea over the box; the painter keeps it on the box as the sheet
   * moves, and leaves the box's own text out while it is open.
   */
  const noteDraftRef = useRef<NoteDraft>(emptyNoteDraft('text'))
  const noteDownAtRef = useRef<{ x: number; y: number } | null>(null)
  const [noteStyles, setNoteStyles] = useState<NoteStyles>(loadNoteStyles)
  const noteStylesRef = useRef(noteStyles)
  noteStylesRef.current = noteStyles
  const [noteEdit, setNoteEdit] = useState<{ id: string; isNew: boolean } | null>(null)
  const noteEditRef = useRef(noteEdit)
  noteEditRef.current = noteEdit
  const noteTextRef = useRef<HTMLTextAreaElement | null>(null)
  /** Keep the text editor over its box as the sheet pans and zooms. Called by the painter. */
  const placeNoteEditor = (ring: ReadonlyArray<{ x: number; y: number }>, c: NoteContent) => {
    const el = noteTextRef.current
    if (el === null || ring.length === 0) return
    const v = viewRef.current
    const pts = ring.map((q) => normalizedToScreen(q.x, q.y, v, page.width, page.height))
    const x0 = Math.min(...pts.map((q) => q.x)), y0 = Math.min(...pts.map((q) => q.y))
    const x1 = Math.max(...pts.map((q) => q.x)), y1 = Math.max(...pts.map((q) => q.y))
    el.style.left = `${x0}px`
    el.style.top = `${y0}px`
    el.style.width = `${Math.max(24, x1 - x0)}px`
    el.style.minHeight = `${Math.max(16, y1 - y0)}px`
    el.style.height = 'auto'
    el.style.height = `${Math.max(y1 - y0, el.scrollHeight)}px`
    el.style.fontSize = `${c.fontPt * v.zoom}px`
    el.style.padding = `${TEXT_PAD_PT * v.zoom}px`
    el.style.color = c.color
  }
  const [tool, setTool] = useState<Tool>('pan')
  const [scopes, setScopes] = useState<Scope[]>([])
  /*
   * What is open, by name, so a signal's message never carries it
   * (src/signals/scrub.ts). Read when a signal is recorded, not copied.
   */
  const namesRef = useRef<{ docs: DocumentRow[], scopes: Scope[], project: string }>({ docs: [], scopes: [], project: '' })
  useEffect(() => provideNames(() => {
    const n = namesRef.current
    return [n.project, ...n.docs.flatMap((d) => [d.displayName, d.relativePath]), ...n.scopes.map((sc) => sc.label)]
      .filter((x): x is string => typeof x === 'string' && x !== '')
  }), [])
  namesRef.current = { docs: documents, scopes, project: projectName }
  const [archivedScopes, setArchivedScopes] = useState<Scope[]>([])
  const archivedScopesRef = useRef<Scope[]>([])
  const [activeScope, setActiveScope] = useState<string | null>(null)
  const [markups, setMarkups] = useState<Markup[]>([])
  /**
   * Markups waiting to be accepted: other apps' markups brought in from the
   * PDF (export/adopt.ts). Shown on the sheet, dashed, and selectable, but kept
   * out of every total (`docMarkups`, `projectMarkups`) until accepted.
   */
  const pendingIdsRef = useRef<ReadonlySet<string>>(new Set())
  const markupsRef = useRef<Markup[]>([])
  const [cal, setCal] = useState<Calibration | null>(null)
  /** Latest value, for the commit path. See the note on `pageIndexRef`. */
  const quantitiesRef = useRef<Array<{ scope: Scope; rows: QuantityResult[] }>>([])
  /** Orderable piece counts per scope. Separate from measurements — see takeoff.ts. */
  // paint() is a stable callback; state alone would give it last render's data.
  const piecesRef = useRef<Array<{ scope: Scope; result: PieceResult; factoryCut?: FactoryCut }>>([])
  /** Custom patterns (beta): a recipe an agent is previewing, per scope, not yet saved. */
  const [patternPreviews, setPatternPreviews] = useState<ReadonlyMap<string, unknown>>(() => new Map())
  const patternPreviewsRef = useRef(patternPreviews)
  patternPreviewsRef.current = patternPreviews
  /** Pattern layers hidden from the sheet, per scope: a reading preference, never saved. */
  const [hiddenLayers, setHiddenLayers] = useState<ReadonlyMap<string, ReadonlySet<string>>>(() => new Map())
  const hiddenLayersRef = useRef(hiddenLayers)
  hiddenLayersRef.current = hiddenLayers
  const activeScopeRef = useRef<string | null>(null)
  /*
   * The scopes, for write paths that must not be wrong about what they are
   * merging into. See the note on `pageIndexRef` below — this is the same trap
   * and it cost a user their specification.
   */
  const scopesRef = useRef<Scope[]>([])
  /**
   * Perf recording is free (a ring-buffer write); the UI samples it on a slow
   * timer. Pushing the frame time into React state every paint made the
   * measurement part of what it measured.
   */
  // A step many times over its budget is counted as a slow signal (src/signals).
  const perfRef = useRef(new PerfRegistry(undefined, (key, ms) => signal('slow', key, '', ms)))
  const [, forceRender] = useState(0)
  const [pendingCal, setPendingCal] = useState<number | null>(null)
  // Read by the palette and the find drawer, which are opened from stable
  // callbacks that must not be rebuilt every time a measurement lands.
  const pendingCalRef = useRef<number | null>(null)
  pendingCalRef.current = pendingCal
  /**
   * Settings are per-USER and global, so the store is opened once for the
   * window rather than per project — reopening a project must not reset a
   * preference.
   */
  const settingsRef = useRef<SettingsStore | null>(null)
  if (settingsRef.current === null) settingsRef.current = SettingsStore.open(browserStorage())
  const settings = settingsRef.current
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** The bill of materials is showing, as a level of the estimates panel. */
  /* Which page of the open scope shows: the dock's Quantities opens Parts, its Specifications opens Setup. */
  const [scopePage, setScopePage] = useState<ScopePage>('parts')
  const [paletteSeed, setPaletteSeed] = useState('')
  /** The cursor the thing under the pointer asks for, or null for the tool's own. */
  const [hoverCursor, setHoverCursor] = useState<string | null>(null)
  const hoverCursorRef = useRef<string | null>(null)
  /* Sidebar widths: equal by default, remembered per machine. */
  const [paneW, setPaneW] = useState(() => readWidth('rb.paneW', clampPane))
  const [workW, setWorkW] = useState(() => readWidth('rb.workW', clampWork))
  useEffect(() => { try { localStorage.setItem('rb.paneW', String(paneW)) } catch { /* private mode */ } }, [paneW])
  useEffect(() => { try { localStorage.setItem('rb.workW', String(workW)) } catch { /* private mode */ } }, [workW])
  /** Which left-rail panel is showing, or null when the panel is collapsed. */
  /*
   * Files first. A project opens with no drawing on the stage (see the open
   * effect), so the pane that lists the drawings is the one to be looking at.
   */
  const [railPanel, setRailPanel] = useState<RailPanel | null>(light ? 'contents' : 'files')
  /**
   * Whether the drawing tools are on screen.
   *
   * The dock rests as a scope pill and a Take off button; the tool rails only
   * appear once takeoff is entered. Twelve controls permanently floating over
   * a drawing is what made the old shell feel cluttered.
   */
  const [takeoff, setTakeoff] = useState(false)
  /**
   * A persistent fit, the way every PDF viewer does it.
   *
   * Fit used to be computed once per document, which is wrong the moment a
   * document has pages of different sizes — and a real bid set always does.
   * Paging from a 3456pt drawing to a 612pt spec sheet kept the drawing's zoom
   * and showed the spec sheet at 24% in the middle of an empty viewport.
   *
   * So fit is a MODE, not a one-off calculation: it survives page changes and
   * window resizes, and any manual zoom clears it to custom.
   */
  const [fitMode, setFitMode] = useState<'page' | 'width' | null>('page')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [estimates, setEstimates] = useState<EstimateListItem[]>([])
  /** False until the first read: an unread list is not an empty one. */
  const [estimatesLoaded, setEstimatesLoaded] = useState(false)
  const [openEstimateId, setOpenEstimateId] = useState<string | null>(null)
  const [openScopeId, setOpenScopeId] = useState<string | null>(null)
  const [estimateScopeIds, setEstimateScopeIds] = useState<string[]>([])
  /**
   * Have this estimate's scope ids been read yet?
   *
   * Needed because "no scopes" and "not asked yet" are both an empty array,
   * and they mean opposite things to the panel: one is an onboarding screen,
   * the other is a flash of it before the real list arrives.
   */
  const [estimateScopesLoaded, setEstimateScopesLoaded] = useState(false)
  const openEstimateIdRef = useRef<string | null>(null)
  const [estimateFiles, setEstimateFiles] = useState<EstimateFile[]>([])
  const [workOpen, setWorkOpen] = useState(true)
  /**
   * Every markup in the open document, not just the visible page.
   *
   * The page-scoped `markups` above is what the canvas paints. The sheet index
   * needs to know which OTHER sheets carry takeoff, and the scope panel lists a
   * scope's markups grouped by sheet — neither can be answered from one page.
   */
  const [docMarkups, setDocMarkups] = useState<Markup[]>([])
  /** Latest value, for write paths. See the note on `pageIndexRef`. */
  const docMarkupsRef = useRef<Markup[]>([])
  /**
   * Who is making the change being written: an AI app while a bridge action
   * runs, the person otherwise. Recorded in the activity trail that travels
   * in the PDF (round 3 #16), so "who deleted that markup" has an answer.
   */
  const actorRef = useRef<'user' | 'agent'>('user')
  /**
   * The whole PROJECT's takeoff, for totalling.
   *
   * A scope spans documents as well as sheets — a ceiling continues from the
   * architectural set onto the interiors set — so a total that stops at the
   * open file is not a total, it is a fragment that changes when you switch
   * tabs and says nothing about having done so.
   */
  const [projectMarkups, setProjectMarkups] = useState<Markup[]>([])
  /** Latest value, for write paths that act on markups off the open sheet. */
  const projectMarkupsRef = useRef<Markup[]>([])
  projectMarkupsRef.current = projectMarkups
  const [projectCalibrations, setProjectCalibrations] = useState<Map<string, number>>(new Map())

  /*
   * Every scale region in the project, by page id.
   *
   * Declared HERE, beside the calibrations, rather than beside the rest of the
   * scale code — `syncMarkups` reads it and this file has a history of
   * temporal-dead-zone bugs from declaring a callback below its use.
   */
  const [projectRegions, setProjectRegions] = useState<Map<string, ScaleRegion[]>>(new Map())

  const reloadRegions = useCallback(async (db: SqlDriver) => {
    setProjectRegions(await loadRegions(db))
  }, [])
  const [projectPageBoxes, setProjectPageBoxes] = useState<
    Map<string, { width: number; height: number }>
  >(new Map())
  /**
   * The document's own index: its outline, its page labels, and which of the
   * three shapes those turned out to be. Defaults to `none`, which makes the
   * sheet index fall back to page labels and then to ordinals — a correct, if
   * plainer, panel while the extraction is in flight or absent.
   */
  /**
   * Page boxes for every sheet, from the viewer's boot report.
   *
   * Needed because normalized geometry is relative to ITS OWN page's box and
   * the boxes differ across a real set — a details sheet is not the size of a
   * plan. Measuring an off-screen markup against the open sheet's box is how a
   * quantity comes out confidently wrong.
   */
  const [pageSizes, setPageSizes] = useState<Array<{ width: number; height: number }>>([])
  const pageSizesRef = useRef(pageSizes)
  /** Set below, where the documents are in reach (`ensurePageRows`). */
  const ensurePageRowsRef = useRef<(pages: readonly number[]) => Promise<void>>(async () => {})
  pageSizesRef.current = pageSizes
  /** Calibration per page id, for the whole open document. */
  const [docCalibrations, setDocCalibrations] = useState<Map<string, number>>(new Map())
  const [docIndex, setDocIndex] = useState<{
    outline: SheetOutlineNode[]
    labels: Array<string | null>
    shape: SheetIndexShape
  }>({ outline: [], labels: [], shape: 'none' })
  const [workspaceTab, setWorkspaceTab] = useState<'chat' | 'estimates'>('estimates')
  const [prefs, setPrefs] = useState(() => settings.all())
  /*
   * Read by the paint callback, which is memoized on the page box alone —
   * putting `prefs` in its dependency list would rebuild the painter every
   * time any unrelated setting changed.
   */
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs

  /*
   * The layout preview is a GLOBAL preference, not a piece of window state.
   *
   * It was a `useState` here, which made it per-window and per-session: it
   * reset on every relaunch, and the control living in a scope's panel made it
   * look like a property of that scope. It is neither. Whether you are reading
   * layouts right now is a way of working, and it is the same answer for every
   * scope on every sheet — so it lives with the other preferences, persists,
   * and can be reached from the settings screen and the command palette like
   * anything else.
   */
  const layoutOn = prefs['takeoff.layoutPreview'] === true
  const setLayoutOn = useCallback((on: boolean) => {
    settings.set('takeoff.layoutPreview', on)
  }, [settings])

  /**
   * Open settings, closing whatever dialog was up. They are not layered.
   *
   * Declared HERE, above the command list, and not beside the other modal
   * helpers further down: the palette's command objects read this value while
   * the memo is being built, which is during render — so a `const` declared
   * after that memo is in its temporal dead zone and the whole workspace
   * throws before it paints. Tests did not catch it because none of them render
   * this component; the browser did, immediately.
   */
  /*
   * The two finders exclude each other.
   *
   * Ctrl+K over an open find-in-page left both on screen at once — a palette in
   * the middle of the window and a search field over the title bar, each with
   * its own idea of what Escape and Enter meant. They answer the same question
   * from different angles; only one of them can be the one being asked.
   */
  /*
   * ...and neither opens over the calibration form, which is a question with a
   * measurement behind it: it cannot be dismissed by opening something else,
   * and every command reachable from the palette would have been swallowed by
   * its precedence anyway. Refusing to open is the honest version of that.
   */
  const openPalette = useCallback((seed?: unknown) => {
    if (pendingCalRef.current !== null) return
    // Seeded with a prefix when a menu hands off to the prompt ("More…" in
    // the project menu opens it at `~`). Anything that is not a string — a
    // click event from a handler passed straight through — is no seed.
    setPaletteSeed(typeof seed === 'string' ? seed : '')
    // A context menu on the drawing closes: the prompt is the one overlay,
    // and a menu left open under it stayed on the sheet through a whole hub
    // flow (seen on the MSK Podium file, 2026-09-14).
    setMarkupMenu(null)
    setAnnotMenu(null)
    // Search no longer closes: it is a rail pane beside the drawing rather
    // than an overlay, so it can sit under the palette without competing
    // for the same space.
    setPaletteOpen(true)
  }, [])
  const openSearch = useCallback(() => {
    if (pendingCalRef.current !== null) return
    setPaletteOpen(false); setRailPanel('search'); setSearchFocus((n) => n + 1)
  }, [])

  /** The setting the panel opens at, when it was reached through the prompt. */
  const [settingsTarget, setSettingsTarget] = useState<string | null>(null)
  const openSettings = useCallback((target?: unknown) => {
    setSettingsTarget(typeof target === 'string' ? target : null)
    setSettingsOpen(true)
  }, [])

  /**
   * The bug report card, and what the prompt's quick report carried into it
   * when that report could not go, or when Shift+Enter asked for the form.
   * It opens over Settings as well as over the drawing.
   */
  const [report, setReport] = useState<{ initial?: Partial<ReportDraft> } | null>(null)
  const openReport = useCallback((initial?: Partial<ReportDraft>) => {
    setPaletteOpen(false)
    setReport(initial === undefined ? {} : { initial })
  }, [])
  /** The drawing as it is on screen, for the report's picture. */
  const captureView = useCallback(
    () => (rasterRef.current === null ? null : captureStage([rasterRef.current, overlayRef.current])),
    [],
  )

  /*
   * THERE ARE NO DIALOGS. The palette is the only overlay this app has.
   *
   * The bill of materials, the document browser and the scope editor were
   * three windows over the drawing, and each went to the surface its moment
   * was already in: the bill is a level of the estimates panel, the browser
   * is the Files pane with a filter, and a scope is named in its round's
   * list and edited on its own page. `only` is still the one place that says
   * where each request goes — the bridge's `open_panel` and the palette both
   * route through it — but "going" now means opening a pane or a level, and
   * leaving settings, which is the one full-screen place a pane can be
   * hidden behind.
   */
  const only = useCallback((open: 'bom' | 'browser' | 'scope') => {
    setSettingsOpen(false)
    if (open === 'bom') {
      // The bill is a scope's Parts page now — there is no level of its own.
      setWorkOpen(true); setScopePage('parts')
      const id = activeScopeRef.current
      if (id !== null) setOpenScopeId(id)
    }
    if (open === 'browser' && !light) { setRailPanel('files'); setFilesFocus((n) => n + 1) }
    if (open === 'scope') {
      setWorkOpen(true)
      setOpenScopeId(null)
      setAddScopeRequest((n) => n + 1)
    }
  }, [])
  const openParts = useCallback(() => { only('bom') }, [only])
  const openBrowser = useCallback(() => { only('browser') }, [only])
  const openScopeEditor = useCallback(() => { only('scope') }, [only])
  /**
   * Show the active scope's specification — in the sidebar, where it lives.
   * With no active scope there is nothing to show, so the request becomes
   * "add one", which is the row the sidebar opens for that.
   *
   * Declared HERE, beside the other openers and above the command list: the
   * palette's command objects read it while the memo is built, during render,
   * and a `const` declared after that memo is in its temporal dead zone.
   */
  const openScopeDetail = useCallback(() => {
    const id = activeScopeRef.current
    if (id === null) { only('scope'); return }
    setSettingsOpen(false)
    setWorkOpen(true)
    setScopePage('setup')
    setOpenScopeId(id)
  }, [only])
  useEffect(() => settings.subscribe(setPrefs), [settings])
  /*
   * Keep this window's settings in step with every other window's, and bring
   * back the copy on disk if the webview lost the last write (an update ends
   * the process to install). See settings/store.ts.
   */
  useEffect(() => {
    const unwatch = settings.watch()
    let live = true
    void restoreSettingsFromFile().then((restored) => { if (restored && live) settings.reload() })
    return () => { live = false; unwatch() }
  }, [settings])

  /**
   * Derived, not duplicated. Holding a separate `snapOn` state seeded from the
   * setting made the toolbar checkbox and the Settings row disagree the moment
   * either was changed — two controls for one value, silently out of step.
   */
  const snapOn = prefs['takeoff.snapEnabled'] !== false
  const snapToLines = prefs['takeoff.snapToLines'] !== false
  /**
   * The stroke multiplier for markups and layout lines at a zoom: the
   * line-weight setting, times the zoom relative to the opening zoom when
   * weights follow it. A ref-backed callback, because the viewer asks on
   * every paint and was built once.
   */
  const strokeScaleFor = useCallback((zoom: number): number => {
    const weight = Number(prefsRef.current['takeoff.lineWeight'] ?? 100) / 100
    const follow = prefsRef.current['takeoff.scaleLineWeightWithZoom'] === true
    return weight * (follow ? Math.min(6, Math.max(0.5, zoom / 0.35)) : 1)
  }, [])
  const [undoState, setUndoState] = useState<UndoState>({
    canUndo: false, canRedo: false, undoLabel: null, redoLabel: null, depth: 0,
  })
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const selectedRef = useRef<string[]>([])
  const marqueeRef = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  /*
   * Every scope's layout on one sheet, onto any canvas at any view. The window
   * paints with it, and so does a close-up (NOIC, 2026-11-26: a region
   * screenshot skipped the layout even with the overlay on, so the only way to
   * check a layout was to zoom the person's window).
   */
  const drawLayoutsRef = useRef<(oc: CanvasRenderingContext2D, view: Viewport, here: string, pageWidth: number, pageHeight: number, feetPerPoint: number) => void>(() => {})
  drawLayoutsRef.current = (oc, view, here, pageWidth, pageHeight, feetPerPoint) => {
    for (const entry of piecesRef.current) {
      const opts = {
        color: entry.scope.color,
        pageWidth: pageWidth,
        pageHeight: pageHeight,
        // What to draw is a global reading preference, not a property of a
        // scope: waste and coverage are two different questions asked of
        // every scope, not two kinds of scope.
        showOverflow: prefsRef.current['takeoff.layoutOverflow'] === true,
        // The same preference, spelled the way the panel path names it.
        showFullCells: prefsRef.current['takeoff.layoutOverflow'] === true,
        showRails: prefsRef.current['takeoff.layoutRails'] !== false,
        showTrim: prefsRef.current['takeoff.layoutTrim'] !== false,
        showSeams: prefsRef.current['takeoff.layoutSeams'] !== false,
        lineWeight: strokeScaleFor(view.zoom),
        // The face width, in this sheet's points, when the scope states one.
        ...(entry.result.componentWidthFeet !== undefined && feetPerPoint > 0
          ? { componentWidthPoints: entry.result.componentWidthFeet / feetPerPoint }
          : {}),
        ...(entry.factoryCut !== undefined ? { factoryCut: entry.factoryCut } : {}),
      }
      /*
       * A pattern's layers can each be hidden from its layer list, so the
       * rails can be checked without the panels over them. A built-in
       * layer's geometry is the cells and runs; the rest are shapes.
       */
      const hidden = hiddenLayersRef.current.get(entry.scope.id)
      const layers = entry.result.layers ?? []
      const builtInHidden = hidden !== undefined && layers.some((l) => hidden.has(l.id) && l.kind !== 'tiles' && l.kind !== 'members' && l.kind !== 'lines' && l.kind !== 'hardware')
      const cells = builtInHidden ? [] : entry.result.cells.filter((c) => c.pageId === undefined || c.pageId === here)
      const runs = builtInHidden ? [] : entry.result.runs.filter((r) => r.pageId === here)
      if (cells.length > 0) drawPanelLayout(oc, cells, view, opts)
      if (runs.length > 0 && (cells.length === 0 || entry.result.shapes !== undefined)) drawRunLayout(oc, runs, view, opts)
      const shapes = (entry.result.shapes ?? []).filter((sh) => sh.pageId === here && !(hidden?.has(sh.layer) ?? false))
      if (shapes.length > 0) drawPatternShapes(oc, shapes, layers, view, opts)
    }
  }

  /**
   * Zoom to a box (Z): armed for one drag, then back to whatever tool was in
   * hand. A box rather than a tool because it is a glance, not a mode: you
   * zoom into the corner you need and carry on drawing.
   */
  const zoomBoxArmedRef = useRef(false)
  const [zoomBoxArmed, setZoomBoxArmed] = useState(false)
  const zoomBoxRef = useRef<ScreenBox | null>(null)
  /**
   * Naming the sheets from the title block (shell/titleBlock.ts): the card's
   * step, the boxes drawn so far (normalized), and the box being dragged.
   */
  const [titlePick, setTitlePick] = useState<{
    step: PickStep
    number: NormBox | null
    title: NormBox | null
    numberText: string | null
    titleText: string | null
  } | null>(null)
  const titlePickRef = useRef<typeof titlePick>(null)
  titlePickRef.current = titlePick
  const titleBoxRef = useRef<ScreenBox | null>(null)
  /** The Text tool's box while it is dragged, and the words it picked. */
  const textBoxRef = useRef<ScreenBox | null>(null)
  const textPickRef = useRef<{ page: number; words: PickedWord[] } | null>(null)
  /** A press on one of the PDF's links, followed if it is released in place. */
  const linkDownRef = useRef<{ x: number; y: number; link: PageLink } | null>(null)
  /** Sheets visited, for Back and Forward (Alt+Left, Alt+Right). */
  const historyRef = useRef(new ViewHistory())
  /** Where a Back or Forward is going, applied once that sheet has loaded. */
  const historyNavRef = useRef<ViewPlace | null>(null)
  /** What a Shift/Ctrl marquee adds to: the selection as it stood when it began. */
  const marqueeBaseRef = useRef<string[]>([])
  /*
   * The PDF's OWN markups on this sheet, as selectable objects.
   *
   * Bluebeam's polygons, squares, lines and ink are drawn into the page by
   * PDFium and used to be reachable only by right-clicking on top of one.
   * In the Select tool they select like ours — click, Ctrl+click for more,
   * or a box — and the selection converts to a chosen scope from the
   * right-click menu or the prompt (Aaron, 2026-09-11). Indices into the
   * page's /Annots array; the list is refreshed when the sheet changes.
   */
  const annotsRef = useRef<PageAnnotation[]>([])
  /** PDF annotation indexes hidden for the open document. Session only; the file is never written. */
  const hiddenAnnotsRef = useRef<Set<number>>(new Set())
  /**
   * The open page's annotations that are REDBEAM's own copies, embedded for
   * Bluebeam. Always hidden: the live markups are drawn from redbeam.db, and
   * showing the file's copy too would draw every markup twice.
   */
  const ownAnnotsRef = useRef<Set<number>>(new Set())
  /**
   * Per document, the /NMs of other apps' annotations that REDBEAM markups now
   * stand for (export/adopt.ts). Hidden like REDBEAM's own: the markup is drawn.
   */
  const adoptedNmsRef = useRef(new Map<string, Set<string>>())
  /**
   * Per document, the /NMs of other apps' annotations held as `annot`
   * markups (clouds, text, arrows, dimensions). The PDF still draws them;
   * a deleted one is hidden, a moved or recoloured one is redrawn there by
   * the viewer's own copy of the PDF (annotEdit.ts).
   */
  const heldNmsRef = useRef(new Map<string, Set<string>>())
  /** Each held markup's rectangle and colour as the file had them when opened, and which have been changed since. */
  const heldOpenRef = useRef(new Map<string, string>())
  const heldChangedRef = useRef(new Set<string>())
  /** The page's own and adopted annotations hidden, held ones placed, and the rest offered to Select. */
  const hideOwnAnnots = useCallback((viewer: Viewer, index: number) => {
    void viewer.requestAnnotations(index)
      .then((list) => {
        if (viewerRef.current !== viewer) return
        const adopted = adoptedNmsRef.current.get(docIdRef.current) ?? new Set<string>()
        const held = heldNmsRef.current.get(docIdRef.current) ?? new Set<string>()
        const live = markupsRef.current.filter((m) => m.kind === 'annot')
        const liveNms = new Set(live.map((m) => heldNmOf(m)).filter((nm): nm is string => nm !== null))
        const standsIn = (a: PageAnnotation) => isRedbeamNm(a.name) || adopted.has(a.name)
        // A held markup deleted here: off the sheet until an undo brings it back.
        const gone = (a: PageAnnotation) => held.has(a.name) && !liveNms.has(a.name)
        const own = list.filter((a) => standsIn(a) || gone(a)).map((a) => a.index)
        const changedOwn = own.length !== ownAnnotsRef.current.size || own.some((i) => !ownAnnotsRef.current.has(i))
        ownAnnotsRef.current = new Set(own)
        let redraw = changedOwn && viewer.setHiddenAnnotations(index, [...hiddenAnnotsRef.current, ...own])
        const edits = heldEditsFor(live, heldOpenRef.current, heldChangedRef.current)
        if (viewer.setAnnotationEdits(index, edits)) redraw = true
        if (redraw) viewer.requestVisible(viewRef.current)
        annotsRef.current = list.filter((a) => a.shape !== 'other' && !standsIn(a) && !held.has(a.name))
      })
      .catch(() => { /* a sheet with no readable annotations has none to select */ })
  }, [])
  const [hiddenAnnotCount, setHiddenAnnotCount] = useState(0)
  /**
   * Markups off, to see the drawing underneath (Aaron, 2026-11-24: "hide
   * embedded markups as well as REDBEAM markups for the purpose of visual
   * analysis so it doesn't obscure things"). Two switches because they are
   * two layers: the PDF's own annotations, rasterized with the sheet, and
   * REDBEAM's takeoff, drawn over it. For the whole window and this session
   * only; nothing is written, and the warning bar says while either is off.
   */
  const [embeddedHidden, setEmbeddedHidden] = useState(false)
  const [redbeamHidden, setRedbeamHidden] = useState(false)
  const embeddedHiddenRef = useRef(false)
  const redbeamHiddenRef = useRef(false)
  embeddedHiddenRef.current = embeddedHidden
  redbeamHiddenRef.current = redbeamHidden
  const [asideAsk, setAsideAsk] = useState(false)
  const closeDbRef = useRef<(() => Promise<void>) | null>(null)
  const [selectedAnnots, setSelectedAnnots] = useState<number[]>([])
  const selectedAnnotsRef = useRef<number[]>([])
  const selectAnnots = useCallback((next: number[]) => { selectedAnnotsRef.current = next; setSelectedAnnots(next) }, [])
  const hoverRef = useRef<Hit | null>(null)
  const editRef = useRef<
    | { mode: 'vertex'; id: string; index: number }
    // An edge of a RECTANGLE, dragged: the whole edge moves and the shape
    // stays a rectangle. Any other edge drag moves the markup.
    | { mode: 'edge'; id: string; index: number }
    | { mode: 'move'; ids: string[]; lastN: { x: number; y: number }
        origins: Map<string, Array<Array<{ x: number; y: number }>>> }
    | null
  >(null)
  const snapRef = useRef<SnapResult | null>(null)
  /** Alt held: place the point exactly where the cursor is, no snap. */
  const altRef = useRef(false)
  /**
   * The search hit last jumped to, painted on its sheet until the next jump
   * or an Escape. Kenneth, 2026-09-10: "search results should be
   * highlighted". Boxes are normalized, y down, like every markup.
   */
  const hitHighlightRef = useRef<{ pageId: string; boxes: NormBox[] } | null>(null)

  /**
   * Auto-pan: a gesture in progress with the pointer at the stage's edge
   * slides the sheet, so a shape larger than the window can be drawn without
   * letting go. Kenneth, 2026-09-10: "when drawing a shape that is larger
   * than the viewport, the viewport should pan to follow".
   *
   * A rAF loop while the pointer stays in the edge band. Each tick moves the
   * view and then re-runs the move handler at the pointer's last position,
   * because the sheet moved under a pointer that did not: the rubber band,
   * the rectangle and the marquee all have to follow.
   */
  const autoPanRef = useRef<{
    raf: number; vx: number; vy: number
    at: { clientX: number; clientY: number; pointerId: number; shiftKey: boolean; altKey: boolean }
  } | null>(null)
  const moveHandlerRef = useRef<((e: React.PointerEvent) => void) | null>(null)
  const stopAutoPan = useCallback(() => {
    const ap = autoPanRef.current
    if (ap === null) return
    cancelAnimationFrame(ap.raf)
    autoPanRef.current = null
  }, [])
  useEffect(() => () => stopAutoPan(), [stopAutoPan])
  /**
   * A rectangle being dragged out for an area or a cutout.
   *
   * `moved` is what separates a drag from a click: until the pointer has
   * travelled a few pixels the gesture is still a click placing a polygon
   * vertex, and only on release is it decided which one it was.
   */
  /**
   * A drag-rectangle in progress. The anchor is a point on the PAGE
   * (normalized), the live corner is on the screen: panning or zooming with
   * the wheel while the button is down moves the screen, not the sheet, and
   * the shape's anchored corner has to stay where it was pressed. It used to
   * hold both corners in screen pixels and slid across the sheet with every
   * pan — see `rectPointsBetween` in draw.ts.
   */
  const rectRef = useRef<
    { anchor: { x: number; y: number }; x1: number; y1: number; moved: boolean } | null
  >(null)
  const shiftRef = useRef(false)
  const [calError, setCalError] = useState<string | null>(null)

  /**
   * The markup under a right-click, and where to put its menu.
   *
   * Everything this menu offers already existed and none of it was findable:
   * a vertex was added or removed by ALT-clicking an edge or a corner, and a
   * markup changed scope only by selecting it and going elsewhere. An
   * undiscoverable shortcut is a feature the product does not have.
   *
   * Screen coordinates, because the menu is chrome over the drawing rather
   * than something on the sheet — it must not pan or scale with the page.
   */
  const [markupMenu, setMarkupMenu] = useState<
    { x: number; y: number; nx: number; ny: number; markupId: string; part: Hit['part']; index: number } | null
  >(null)
  /**
   * The menu for a right-click on the DRAWING itself: the PDF's own markups
   * under the pointer, offered for conversion, and a trace of the region
   * there. See openDrawingMenu.
   */
  const [annotMenu, setAnnotMenu] = useState<{
    x: number; y: number; nx: number; ny: number
    annotations: PageAnnotation[]
    /** Every convertible annotation on the sheet, for "convert all". */
    onSheet: number
  } | null>(null)
  /*
   * Both menus open at the pointer, and the viewport clips. Opened near the
   * bottom or right edge of the drawing they lost their rows past it, so a
   * right-click by the dock showed a header and nothing under it (issue #13).
   * They slide back inside the viewport like every dock menu does.
   */
  const markupMenuClamp = useClampedPopover<HTMLDivElement>(markupMenu !== null, [markupMenu])
  const annotMenuClamp = useClampedPopover<HTMLDivElement>(annotMenu !== null, [annotMenu, selectedAnnots])
  /*
   * A new sheet starts with nothing of the PDF's selected. The list itself
   * is fetched by the viewer's `onPage` below: an effect keyed on the
   * document id ran before the new viewer had booted and asked the OLD one,
   * so on the MSK Podium file the cache held A-351A's 74 shapes while
   * A-351B's 101 were on screen (2026-09-14).
   */
  useEffect(() => { annotsRef.current = []; selectAnnots([]) }, [activeDocId, pageIndex, selectAnnots])


  /**
   * Keep the canvases and the viewport matched to the stage.
   *
   * The backing store is sized in DEVICE pixels — that is the blur fix — while
   * the viewport stays in CSS pixels so hit-testing, snapping and geometry all
   * remain in one coordinate space.
   */
  useEffect(() => {
    // Both, unconditionally. `a() || b()` short-circuited and left the overlay
    // at a stale size, so a markup's fill stopped dead at a vertical line
    // partway across the viewport — the edge of the overlay's backing store.
    const rasterResized = sizeCanvas(rasterRef.current, stage)
    const overlayResized = sizeCanvas(overlayRef.current, stage)
    const resized = rasterResized || overlayResized
    viewRef.current = clampViewport(
      { ...viewRef.current, vw: stage.width, vh: stage.height },
      viewerRef.current?.pageInfo ?? { width: page.width, height: page.height },
    )
    viewerRef.current?.requestVisible(viewRef.current)
    // Resizing a canvas clears it, so a repaint is required — but only then.
    if (resized) requestPaint()
  }, [stage, page.width, page.height])

  // ---------------------------------------------------------------- paint --
  /**
   * Read the canvas surround from the stylesheet rather than letting the
   * viewer's default stand.
   *
   * `Viewer.paint` defaults to `#3a3d42` — a Qt-era grey — and nothing ever
   * passed a value, so the sheet floated on a colour from the previous build
   * inside chrome from this one. It was the only unthemed surface on screen
   * and the first thing that read as "not the design".
   */
  const surround = useCallback(() => {
    const el = stageRef.current
    if (el === null) return undefined
    const v = getComputedStyle(el).getPropertyValue('--rb-canvas').trim()
    return v === '' ? undefined : v
  }, [])

  /**
   * Ask for a repaint on the next frame.
   *
   * Everything that changes what is on screen calls this; nothing calls
   * `paint()` directly except the frame callback. Two problems it replaces:
   *
   *  - a `setInterval(paint, 120)` was the ONLY thing that painted an arriving
   *    tile, so a tile could sit up to 120ms before appearing. That, far more
   *    than the tile grid, is why raster visibly landed a piece at a time.
   *  - pointer and wheel handlers painted synchronously, several times per
   *    frame during a drag, doing work the compositor then threw away.
   *
   * Coalescing to one paint per frame fixes both ends at once.
   */
  const frameRef = useRef(0)
  const requestPaint = useCallback(() => {
    if (frameRef.current !== 0) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0
      paintRef.current()
    })
  }, [])

  // The surround is read from the stylesheet on each paint; a theme change
  // only needs one more paint to land on the drawing.
  useEffect(() => {
    window.addEventListener(THEME_CHANGED, requestPaint)
    return () => window.removeEventListener(THEME_CHANGED, requestPaint)
  }, [requestPaint])

  /** Agents' cursors over the sheet (agents/AgentCursors.tsx). */
  const cursorsRef = useRef<AgentCursorsHandle | null>(null)
  /** A normalized point of the sheet showing, in the stage's pixels. Stable: it reads refs. */
  const placeAgentPoint = useCallback((p: { x: number; y: number }) => {
    const size = pageSizeRef.current
    if (size.width <= 0) return null
    return normalizedToScreen(p.x, p.y, viewRef.current, size.width, size.height)
  }, [])

  /*
   * The toolbar's zoom readout. It read viewRef straight off the last
   * render, so wheel zoom (which repaints without rendering) left it on the
   * old percent until something else re-rendered. Each paint now hands it
   * the zoom, settled for a tenth of a second so a pinch or a run of wheel
   * notches re-renders the window once, not every frame.
   */
  const [zoomShown, setZoomShown] = useState(0.35)
  const zoomShownTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const paint = useCallback(() => {
    const v = viewerRef.current
    if (!v) return
    if (zoomShownTimer.current !== null) clearTimeout(zoomShownTimer.current)
    zoomShownTimer.current = setTimeout(() => { zoomShownTimer.current = null; setZoomShown(viewRef.current.zoom) }, 100)
    const t0 = performance.now()
    const bg = surround()
    if (bg === undefined) v.paint(viewRef.current)
    else v.paint(viewRef.current, bg)
    const oc = overlayRef.current?.getContext('2d')
    if (oc && page.width > 0) {
      /*
       * Scale regions first, under everything.
       *
       * A region governs every measurement inside it, so it has to be visible
       * whether or not anyone is thinking about scale — crossing into a detail
       * at 1/4" while drawing an area is something to notice before the
       * quantity says so, not after.
       */
      /*
       * Dimensions, on the 2D layer rather than the viewer overlay.
       *
       * The overlay carries takeoff — polygons and lines a scope's colour is
       * derived from. A dimension has no scope and its own drawing (ticks, an
       * offset witness line, a label), so it belongs with the scale regions on
       * the annotation layer.
       */
      const bare = redbeamHiddenRef.current
      for (const m of bare ? [] : markupsRef.current) {
        if (m.kind !== 'dimension') continue
        // A dimension written before content was carried has none; skip it
        // rather than let one row take the whole overlay down.
        if ((m as unknown as { content?: unknown }).content === undefined) continue
        drawDimension(oc, m as unknown as DimensionMarkup, viewRef.current, page.width, page.height, {
          feetPerPoint: calRef.current?.feetPerPoint ?? 0,
        })
      }
      if (toolRef.current === 'dimension') {
        drawDimensionDraft(oc, dimensionDraftRef.current, viewRef.current, page.width, page.height)
      }
      // Notes, on the same layer: they belong to no scope either.
      {
        const editing = noteEditRef.current?.id ?? null
        for (const n of bare ? [] : notesOf(markupsRef.current)) {
          drawNote(oc, n.rings, n.content, viewRef.current, page.width, page.height, { hideText: n.id === editing })
          if (n.id === editing) placeNoteEditor(n.rings[textRingIndex(n.content.shape)] ?? [], n.content)
        }
        if (isNoteTool(toolRef.current)) {
          const shape = toolRef.current
          drawNoteDraft(oc, noteDraftRef.current, noteStylesRef.current[shape], viewRef.current, page.width, page.height)
        }
      }

      const regionsHere = regionsRef.current.get(
        pageIdFor(docIdRef.current, pageIndexRef.current),
      )
      if (!bare && regionsHere !== undefined && regionsHere.length > 0) {
        drawScaleRegions(oc, regionsHere, viewRef.current, {
          pageWidth: page.width,
          pageHeight: page.height,
          active: toolRef.current === 'scale-region',
        })
      }
      // The search hit last jumped to, on its own sheet only.
      const hl = hitHighlightRef.current
      if (hl !== null && hl.pageId === pageIdFor(docIdRef.current, pageIndexRef.current)) {
        oc.save()
        oc.fillStyle = 'rgba(255, 210, 74, 0.38)'
        oc.strokeStyle = 'rgba(255, 170, 0, 0.9)'
        oc.lineWidth = 1
        for (const b of hl.boxes) {
          const a = normalizedToScreen(b.x0, b.y0, viewRef.current, page.width, page.height)
          const c = normalizedToScreen(b.x1, b.y1, viewRef.current, page.width, page.height)
          const x = Math.min(a.x, c.x) - 2, y = Math.min(a.y, c.y) - 2
          const w = Math.abs(c.x - a.x) + 4, h = Math.abs(c.y - a.y) + 4
          oc.fillRect(x, y, w, h)
          oc.strokeRect(x, y, w, h)
        }
        oc.restore()
      }
      // Layout goes UNDER the markups and the selection: it is context for the
      // takeoff, not the takeoff.
      if (layoutOn) {
        /*
         * EVERY scope's layout, not just the one being drawn into.
         *
         * The painter looked up the active scope and drew that alone, so a
         * global switch still showed one scope at a time and turning it on
         * looked like it applied per scope. Which scope you are DRAWING into
         * has nothing to do with which layouts you want to see: an estimator
         * checks a ceiling against the ceiling next to it, and two scopes that
         * overlap where they should not is a thing you can only notice with
         * both on screen. Each draws in its own colour, which is what the
         * colour is for.
         *
         * Only this sheet's geometry: a scope spans sheets, and the
         * calculation returns all of them because that is what the totals are
         * made of.
         */
        if (!bare) drawLayoutsRef.current(oc, viewRef.current, pageIdFor(docIdRef.current, pageIndexRef.current), page.width, page.height, calRef.current?.feetPerPoint ?? 0)
      }
      const hereId = pageIdFor(docIdRef.current, pageIndexRef.current)
      const origins: PatternOriginItem[] = []
      for (const m of markupsRef.current) {
        if (m.kind !== 'area' || m.pageId !== hereId || m.scopeId === null) continue
        const sc = scopesRef.current.find((s) => s.id === m.scopeId)
        if (sc === undefined) continue
        const point = areaOriginsFrom(sc.specifications).get(m.id)
        if (point === undefined) continue
        origins.push({ kind: 'origin', id: m.id, point, color: sc.color })
      }
      if (origins.length > 0 && !bare) {
        drawPatternItems(oc, origins, viewRef.current, page.width, page.height, { labels: true })
      }
      const ids = new Set(selectedRef.current)
      const sel = markupsRef.current.filter((m) => ids.has(m.id))
      drawSelection(oc, sel, viewRef.current, page.width, page.height,
        hoverRef.current?.part === 'vertex' ? hoverRef.current.index : null)
      if (selectedAnnotsRef.current.length > 0) {
        const chosen = new Set(selectedAnnotsRef.current)
        drawAnnotationSelection(oc, annotsRef.current.filter((a) => chosen.has(a.index)), viewRef.current, page.width, page.height)
      }
      drawMarquee(oc, marqueeRef.current)
      drawMarquee(oc, zoomBoxRef.current)
      drawMarquee(oc, textBoxRef.current)
      const tp = titlePickRef.current
      if (tp !== null) {
        oc.save()
        oc.lineWidth = 2
        for (const [b, color] of [[tp.number, NUMBER_BOX_COLOR], [tp.title, TITLE_BOX_COLOR]] as const) {
          if (b === null) continue
          const a = normalizedToScreen(b.x0, b.y0, viewRef.current, page.width, page.height)
          const c = normalizedToScreen(b.x1, b.y1, viewRef.current, page.width, page.height)
          oc.strokeStyle = color
          oc.fillStyle = `${color}1f`
          oc.fillRect(a.x, a.y, c.x - a.x, c.y - a.y)
          oc.strokeRect(a.x, a.y, c.x - a.x, c.y - a.y)
        }
        oc.restore()
        drawMarquee(oc, titleBoxRef.current)
      }
      const pick = textPickRef.current
      if (pick !== null && pick.page === pageIndexRef.current && pick.words.length > 0) {
        oc.save()
        oc.fillStyle = 'rgba(0, 120, 215, 0.28)'
        for (const w of pick.words) {
          const a = normalizedToScreen(w.x0, w.y0, viewRef.current, page.width, page.height)
          const b = normalizedToScreen(w.x1, w.y1, viewRef.current, page.width, page.height)
          oc.fillRect(a.x, a.y, b.x - a.x, b.y - a.y)
        }
        oc.restore()
      }
      // The callout review's finds on this sheet: ticked in link blue, the rest grey.
      const review = reviewRef.current
      if (review !== null) {
        oc.save()
        review.candidates.forEach((c, i) => {
          if (c.page !== pageIndexRef.current) return
          const a = normalizedToScreen(c.rect.x0, c.rect.y0, viewRef.current, page.width, page.height)
          const b = normalizedToScreen(c.rect.x1, c.rect.y1, viewRef.current, page.width, page.height)
          oc.strokeStyle = c.checked ? LINK_COLOR : '#8a929c'
          oc.fillStyle = c.checked ? 'rgba(26, 115, 232, 0.12)' : 'rgba(138, 146, 156, 0.10)'
          oc.lineWidth = review.focus === i ? 3 : 1.5
          oc.setLineDash(c.checked ? [] : [4, 3])
          oc.fillRect(a.x, a.y, b.x - a.x, b.y - a.y)
          oc.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y)
        })
        oc.restore()
      }
      drawDraft(oc, draftRef.current, viewRef.current, page.width, page.height)
      drawSnapIndicator(oc, snapRef.current)
    }
    // The view may have moved: agents' cursors stay on their points.
    cursorsRef.current?.sync()
    perfRef.current.record('frame', performance.now() - t0)
  }, [page.width, page.height, layoutOn])

  /*
   * Repaint when the layout preview is toggled, or a display preference moves.
   *
   * Neither of these touches the drawing itself, so nothing else asks the
   * canvas to redraw — and a canvas only shows what it was last told to draw.
   * Turning the preview on therefore did nothing at all until the next pan or
   * zoom happened to repaint, which is indistinguishable from the toggle being
   * broken; it was why the layout looked missing even with everything computed
   * and switched on. The painter reads the preferences through a ref so it is
   * not rebuilt whenever an unrelated setting changes, which is exactly what
   * leaves it unable to notice on its own.
   */
  useEffect(() => { requestPaint() }, [layoutOn, prefs, requestPaint])

  /*
   * The frame callback needs the CURRENT paint, but `requestPaint` must be
   * stable — it is called from event handlers and from the viewer's onTile,
   * and re-creating it would leak a scheduled frame on every render.
   */
  const paintRef = useRef(paint)
  paintRef.current = paint

  /** Show or hide either markup layer; see `embeddedHidden`. Returns what is now in force. */
  const setMarkupVisibility = useCallback((next: { embedded?: boolean; redbeam?: boolean }) => {
    const v = viewerRef.current
    if (next.embedded !== undefined) {
      embeddedHiddenRef.current = !next.embedded
      setEmbeddedHidden(!next.embedded)
      if (v !== null && v.setAnnotationsVisible(next.embedded)) v.requestVisible(viewRef.current)
    }
    if (next.redbeam !== undefined) {
      redbeamHiddenRef.current = !next.redbeam
      setRedbeamHidden(!next.redbeam)
      v?.setOverlayVisible(next.redbeam)
    }
    requestPaint()
    return { embedded: !embeddedHiddenRef.current, redbeam: !redbeamHiddenRef.current }
  }, [requestPaint])

  /*
   * QUICK VIEW's gate. A drawing open for viewing has no project, so the
   * verbs that would make a markup, a round, a scope or a commit ask for the
   * drawing's project folder first — the picker opens — and do nothing until
   * one is chosen. With a project behind the window this is always true.
   */
  const requireProject = useCallback((): boolean => {
    if (quickView === undefined || quickView.light === true) return true
    setWorkOpen(true)
    setStatus('Open for viewing — choose the drawing’s project folder to take off')
    quickView.onAdopt()
    return false
  }, [quickView, setStatus])

  /*
   * What the store is told the folder holds. A project is scanned; a quick
   * view is exactly one file, described from its path, so a PDF picked from
   * a share with four hundred other documents does not ingest all of them.
   */
  const scanner = useMemo((): ProjectScanner => {
    if (quickView === undefined) return projectBridge
    const { file, relativePath } = quickView
    return {
      scanProject: async () => ({
        root: projectPath,
        files: [{
          relativePath,
          absolutePath: file,
          displayName: relativePath.split('/').pop() ?? relativePath,
          kind: 'pdf', status: 'ready', sizeBytes: 0, modifiedAt: null,
          contentFingerprint: null, availability: 'local', fileDateHint: null,
        }],
        truncated: false,
        unreadable: [],
        scannedAt: new Date().toISOString(),
      }),
    }
  }, [quickView, projectPath])

  // ------------------------------------------------------------- database --
  useEffect(() => {
    let cancelled = false
    // Read ONCE, at open. Re-reading later would fight the user's navigation
    // with a stale idea of where they were.
    const saved = readSession(projectPath)
    let held: Awaited<ReturnType<typeof openDatabase>> | null = null
    ;(async () => {
      const opened = quickView !== undefined ? await openMemory() : await openDatabase(projectPath)
      if (cancelled) {
        // Opened after the window moved on: let go at once.
        void opened.close()
        return
      }
      held = opened
      closeDbRef.current = () => opened.close()
      dbRef.current = opened.driver
      {
        const debounced = debounceSave(opened.save)
        // Every change passes here; the tick says whether the PDF is behind (round 3 P1-4).
        saveRef.current = () => { changeTickRef.current++; debounced() }
      }
      setBackend(opened.backend)
      // Which database opened is for whoever is debugging a project. A PDF
      // opened to view or take off has no database to speak of, and every
      // file opened in Light said "browser store · in memory (viewing)".
      if (quickView === undefined) setStatus(`${opened.backend === 'tauri' ? 'desktop store' : 'browser store'} · ${opened.location}`)
      undoRef.current = new UndoStack(opened.driver, undefined, undoOptionsFor(opened.backend, projectPath))

      let existing = await listScopes(opened.driver)
      /*
       * Seed the BROWSER demo only. Never a real project.
       *
       * This ran for every empty database, so opening a new client folder
       * wrote five demo scopes into it — with FIXED ids, so the next project
       * showed the same five and read as the previous project's scopes
       * following you around. Aaron reported exactly that.
       *
       * The seeded specifications are the worse half. Their own comment calls
       * them "plausible starting points, NOT standards": a 6in baffle spacing
       * that came from nowhere, sitting in a scope named like a real one, on a
       * real bid. An estimator who draws into it gets a quantity computed from
       * a number nobody chose. Everything else in this codebase refuses to
       * invent a measurement; this was inventing five.
       *
       * The browser build has no project folder and exists to be looked at, so
       * it still gets them.
       */
      if (existing.length === 0 && opened.backend !== 'tauri' && quickView === undefined) {
        for (const s of SEED_SCOPES) {
          await upsertScope(opened.driver, { ...s, archivedAt: null })
        }
        existing = await listScopes(opened.driver)
        saveRef.current()
      }
      const asScopes: Scope[] = existing.map((s) => ({
        id: s.id, label: s.label, scopeType: s.scopeType as Scope['scopeType'],
        color: s.color, specifications: s.specifications,
      }))
      setScopes(asScopes)
      setActiveScope((cur) => (
        cur
        ?? (saved.activeScopeId !== undefined && asScopes.some((x) => x.id === saved.activeScopeId)
          ? saved.activeScopeId
          : null)
        ?? asScopes[0]?.id
        ?? null
      ))

      /*
       * Show the catalog we already have BEFORE walking the folder.
       *
       * The scan is what takes the time — on a SharePoint folder with Files
       * On-Demand it took 152 seconds, because every directory is a reparse
       * point the walk has to wake. Waiting for it before showing anything
       * meant reopening a project you had used yesterday sat empty for minutes
       * with a catalog of 736 documents already in the database.
       *
       * Nothing here reads a drawing. The scan takes metadata only and skips
       * fingerprinting anything not local, so no file is downloaded to build
       * this list — the wait was enumeration, not transfer.
       */
      const known = await listDocuments(opened.driver)
      if (cancelled) return
      if (known.length > 0) setDocuments(known)

      // Sequence lives in openProjectDocuments so it can be tested: scanning,
      // reconciling only on a complete scan, and still opening when the folder
      // cannot be read.
      const opened2 = await openProjectDocuments(
        opened.driver, scanner, projectPath, () => cancelled,
      )
      if (cancelled) return
      // Browser mode ingests nothing, but the workspace still runs on the
      // bundled sample. Listing it keeps the UI honest: without this the tab
      // strip says "No documents open" while a document is plainly loaded,
      // and the document browser shows an empty project.
      const listed = opened2.documents.length === 0 && !isTauri()
        ? [{
            id: FALLBACK_DOC.id,
            relativePath: FALLBACK_DOC.relativePath,
            displayName: FALLBACK_DOC.displayName,
          } as DocumentRow]
        : opened2.documents
      setDocuments(listed)
      setScan('done')
      setIngestNote(opened2.note)
      // Browser mode cannot scan a folder, so nothing is ingested. Fall back to
      // the bundled sample's id rather than leaving the workspace with no active
      // document — every page, markup and text row hangs off a document, so a
      // null here silently disables indexing and search.
      /*
       * A context window opens on the sheet it was popped out to show. If that
       * document is not in this project — a stale URL, a moved file — fall
       * through to the first one rather than opening on nothing.
       */
      const requested =
        initialDocumentPath === null || initialDocumentPath === undefined
          ? null
          : listed.find((d) => d.relativePath === initialDocumentPath)?.id ?? null
      /*
       * Otherwise, the sheet you were last on in THIS project.
       *
       * A relaunch used to land on the first document of the set whatever you
       * had been doing, which on a 29-sheet job means finding your way back by
       * hand every time. An explicit request still wins: a popped-out context
       * window was opened to show one document and must not be second-guessed.
       * A remembered document that is no longer in the project, like a stale
       * URL, opens NOTHING. The first file in the folder is not a choice
       * anyone made: on a real bid package it is a bid form or an old set,
       * and opening it looked like the app deciding what to work on. Aaron:
       * "It shouldn't open any file by default, and it should open directly
       * to the folder pane." So a project with no remembered sheet opens on
       * the Files pane and an empty stage that says so.
       */
      const remembered = saved.documentPath === undefined
        ? null
        : listed.find((d) => d.relativePath === saved.documentPath)?.id ?? null
      const first = requested ?? remembered ?? null
      setActiveDocId((cur) => cur ?? first)
      // One tab on open, not one per document.
      setOpenDocIds((cur) => (cur.length > 0 ? cur : first !== null ? [first] : []))
      if (first === null && !light) setRailPanel('files')
    })()
    return () => {
      cancelled = true
      // Switching or closing the project: this window is done with the
      // database. The core drops the connection when the last window is.
      const done = held
      held = null
      closeDbRef.current = null
      dbRef.current = null
      if (done !== null) void done.close()
    }
  }, [projectPath, initialDocumentPath])

  /**
   * Reload markups from the store so the UI always matches what is persisted.
   *
   * Declared HERE, above the page-open effect, because that effect calls it.
   * It used to sit two hundred lines below and the effect loaded the page's
   * markups itself — which is how the two got out of step: `docMarkups` and
   * `docCalibrations` were only ever populated by an EDIT, so on a freshly
   * opened project the piece calculation was handed no markups and no
   * calibrations at all. It produced nothing, and reported no blocker either,
   * because zero markups is a legitimate reason to have no pieces. Draw one
   * shape and everything appeared; relaunch and it was gone again.
   */
  /**
   * Land a loaded estimate list, and the open round's scopes and drawings, in
   * ONE render. These were set either side of a second query, so the list and
   * the round arrived as two whole-window renders.
   */
  const applyEstimates = useCallback((e: EstimateLoad) => {
    setEstimates(e.rounds)
    setEstimatesLoaded(true)
    // The same ids keep the same array, so nothing keyed on it renders again.
    setEstimateScopeIds((cur) => sameStrings(cur, e.scopeIds) ? cur : e.scopeIds)
    setEstimateScopesLoaded(true)
    setEstimateFiles(e.files)
  }, [])

  /**
   * `alongside` runs right after the markups are set, in the same synchronous
   * block, so whatever it sets lands in the SAME render rather than the next.
   */
  const syncMarkups = useCallback(async (alongside?: () => void) => {
    const db = dbRef.current
    if (!db) { alongside?.(); return }
    const toMarkup = (r: {
      id: string; scopeId: string | null; documentId: string; pageId: string; kind: string
      rings: Array<Array<{ x: number; y: number }>>
    }): Markup => ({
      id: r.id, scopeId: r.scopeId, documentId: r.documentId, pageId: r.pageId,
      kind: r.kind as Markup['kind'], rings: r.rings,
      /*
       * The per-kind payload, carried through.
       *
       * This dropped it, so every committed dimension reached the painter
       * with no `content` — and `drawDimension` reads `content.offsetPoints`
       * before anything else. The first dimension on a sheet threw inside
       * the paint loop on every frame after it was saved: the overlay froze,
       * the dimension itself never appeared, and nothing said why. Aaron:
       * "linear dimension … doesn't work as expected".
       */
      ...((r as { content?: Record<string, unknown> }).content !== undefined
        ? { content: (r as { content?: Record<string, unknown> }).content }
        : {}),
    })
    const docId = docIdRef.current
    const pageId = pageIdFor(docId, pageIndexRef.current)
    /*
     * One read of the markups, and one render.
     *
     * This ran after every edit (each finished shape, each move) and read the
     * markups three times (the page's, the document's, the project's), setting
     * state between the reads, so React rendered the whole workspace three
     * times per stroke: about a hundred milliseconds of a laptop's time on a
     * sheet with a hundred markups. The page's and the document's are the
     * project's, filtered, in the same order. Page boxes come from the STORE
     * rather than the viewer: the viewer only knows the open document's, and
     * normalized geometry means nothing without its own box.
     */
    /*
     * Everything a finished shape changes, read FIRST and set together, so
     * the edit is one render of the window rather than one per read.
     *
     * Finishing a shape used to render the whole workspace six times: the
     * undo state, then the scale regions (set between two awaits), then the
     * markups, then the estimate list and the open round (an effect on the
     * markup count, itself set either side of a query), then the quantities
     * (an effect deriving state). About 40 ms of a slow laptop's time, for
     * one press of Enter. The regions, the markups and the round now land in
     * one render, and the quantities are derived in it (see `takeoffTotals`).
     *
     * Regions still resolve BEFORE anything is shown, so a details sheet is
     * never measured at its page number for one render and then corrected.
     */
    const [allRows, cals, allCals, allBoxes, regions, rounds] = await Promise.all([
      listMarkups(db, { reviewStates: ['accepted', 'proposed'] }),
      listCalibrations(db, docId),
      listAllCalibrations(db),
      listPageBoxes(db),
      loadRegions(db),
      loadEstimates(db, openEstimateIdRef.current),
    ])
    setProjectRegions(regions)
    applyEstimates(rounds)
    pendingIdsRef.current = new Set(allRows.filter((r) => r.reviewState === 'proposed').map((r) => r.id))
    const shown = allRows.map(toMarkup)
    // Totals see accepted markups only; the sheet shows pending ones too.
    // Other apps' markups held in place are on the sheet and nowhere else.
    const all = shown.filter((m) => !pendingIdsRef.current.has(m.id) && m.kind !== 'annot')
    const doc = all.filter((m) => m.documentId === docId)
    // The cuts in this sheet's areas, as cutouts to select (cutouts.ts).
    setMarkups(withCutouts(shown.filter((m) => m.documentId === docId && m.pageId === pageId)))
    setDocMarkups(doc)
    setDocCalibrations(new Map([...cals].map(([id, c]) => [id, c.feetPerPdfPoint])))
    setProjectMarkups(all)
    setProjectCalibrations(allCals)
    setProjectPageBoxes(allBoxes)
    alongside?.()
  }, [applyEstimates])

  /*
   * The project's markups, calibrations and boxes are loaded by `syncMarkups`,
   * which the page effect below runs once a sheet has a box. A project now
   * opens with NO sheet on the stage, so nothing ran it: the round page read
   * 0 markups and no totals until some sheet was visited. Run it as soon as
   * the store is open, whether or not a page is.
   */
  useEffect(() => {
    if (backend === null || activeDocId !== null) return
    void syncMarkups()
  }, [backend, activeDocId, syncMarkups])

  // Load page-dependent state once BOTH the db and the page box are ready.
  useEffect(() => {
    const db = dbRef.current
    if (!db || page.width === 0) return
    let cancelled = false
    ;(async () => {
      const activeDoc = documents.find((d) => d.id === activeDocId)
      const docId = activeDoc?.id ?? FALLBACK_DOC.id
      const pageId = pageIdFor(docId, pageIndexRef.current)
      await ensureDocumentAndPage(db, activeDoc ?? FALLBACK_DOC, {
        // pages.page_number is ZERO-based, matching the viewer's page index and
        // the Qt MCP surface ("zero-based page number").
        id: pageId, documentId: docId, pageNumber: pageIndex,
        width: page.width, height: page.height,
      })
      // Calibration is PER PAGE. Page boxes differ across a set and so do
      // scales — a details sheet is not drawn at the plan's scale — so a
      // document-level scale would silently mis-measure every other sheet.
      const stored = await getCalibration(db, pageId)
      if (cancelled) return
      setCal(
        stored
          ? { feetPerPoint: stored.feetPerPdfPoint, pageWidth: page.width, pageHeight: page.height }
          : null,
      )
      // The page's markups AND the document's, through the one function that
      // knows about both. Loading only the page here is what left the piece
      // calculation with nothing to work from until the first edit.
      await syncMarkups()
      if (cancelled) return
      setPageReadyKey(pageId)
      saveRef.current()
    })()
    return () => { cancelled = true }
  }, [page.width, page.height, pageIndex, activeDocId, documents, scopes.length, syncMarkups])


  /*
   * Return to the remembered SHEET, once — and only once.
   *
   * The page cannot be restored with the document: the viewer has to boot and
   * report a page count first, and asking for sheet 9 of a set whose length is
   * still unknown is how you end up on sheet 1 with an error nobody sees. A
   * ref rather than state because this must not re-fire when the user then
   * navigates away, which would pin them to the remembered page forever.
   */
  const restoredPage = useRef(false)
  useEffect(() => {
    if (restoredPage.current || pageCount === 0) return
    // A context window was opened to show something specific; leave it there.
    if (initialDocumentPath !== null && initialDocumentPath !== undefined) {
      restoredPage.current = true
      return
    }
    const want = readSession(projectPath).pageIndex
    restoredPage.current = true
    if (want === undefined || want === pageIndex) return
    if (want < 0 || want >= pageCount) return
    viewerRef.current?.loadPage(want)
  }, [pageCount, pageIndex, projectPath, initialDocumentPath])

  /** Remember where we are, so the next launch starts here. */
  useEffect(() => {
    if (activeDocId === null) return
    const doc = documents.find((d) => d.id === activeDocId)
    writeSession(projectPath, {
      ...(doc !== undefined ? { documentPath: doc.relativePath } : {}),
      pageIndex,
      ...(activeScope !== null ? { activeScopeId: activeScope } : {}),
    })
  }, [projectPath, activeDocId, documents, pageIndex, activeScope])

  /**
   * Read every sheet's title block, when the set does not name its own sheets.
   *
   * A published set usually says what its sheets are in its outline or its
   * page labels. Plenty say it in neither — the information is printed in the
   * title block and nowhere else — and for those the index could only count
   * pages. "Page 14" is not a sheet name, and navigating a 110-sheet set by
   * ordinal is doing the publisher's filing by hand.
   *
   * So when there is nothing to fall back on, walk the document once and read
   * the text. Deliberately:
   *
   *  - only for `none` and `sparse`. A set with a real outline already knows.
   *  - one page at a time, awaited, so a 110-sheet sweep never competes with
   *    the sheet the estimator is actually looking at.
   *  - results appear as they arrive, so the panel fills in rather than
   *    waiting on the last page.
   *  - the text is INDEXED as it goes, which is the same work full-text search
   *    needs — the coverage figure the search panel reports climbs with it
   *    instead of staying at whatever fraction happened to be visited.
   */
  const [derivedLabels, setDerivedLabels] = useState<Array<string | null>>([])
  /** How far the sheet sweep has read, for list_sheets: a stall shows instead of hiding. */
  const [sweepRead, setSweepRead] = useState<{ read: number; of: number; restarts: number }>({ read: 0, of: 0, restarts: 0 })
  useEffect(() => {
    setDerivedLabels([])
    setSweepRead((s) => ({ read: 0, of: pageCount, restarts: s.restarts + 1 }))
    const v = viewerRef.current
    const db = dbRef.current
    if (!v || !db || pageCount === 0) return
    /*
     * Every page is read, not only when nothing names the set: an outline or
     * page labels that cover pages 1-32 and leave 33-54 as plain numbers
     * (Aaron, 2026-11-24) still need the rest read off their title blocks.
     * The document's own names win where they exist (mergeSheetLabels).
     */

    let cancelled = false
    const docId = docIdRef.current
    setFoundTitleBlock(null)
    void (async () => {
      /*
       * Read by the set's own readers, several at once (search/textPool.ts),
       * so a 4,382-page spec is read in a fraction of the time and the
       * worker drawing the sheet is left to draw it.
       */
      const pool = textPool()
      const all = Array.from({ length: pageCount }, (_, k) => k)
      pool?.want(all.filter((k) => v.getText(k) === undefined))
      // Each sheet named from the set's own title block as it is read (shell/sheetNamer.ts).
      const namer = new SheetNamer(pageCount)
      let blockShown: FoundTitleBlock | null = null
      let shown = performance.now()
      // `sweepPage`, not `i`: this enumerates EVERY page, so unlike every other
      // page id in this file there is no "current page" it could be wrong
      // about. The name is what tells the page-identity guard that.
      for (let sweepPage = 0; sweepPage < pageCount; sweepPage++) {
        if (cancelled) return
        try {
          /*
           * The set's readers, and the viewer's own when they are gone: a pool
           * closed under the sweep (a tab switch) must not leave the rest of
           * the set unnamed (0.3.96 retest: one sheet of 60 named).
           */
          let pt: PageText | null | undefined = v.getText(sweepPage)
          if (pt === undefined && pool !== null && !pool.isClosed) pt = await pool.text(sweepPage)
          // Null from an open pool is a page it gave up on; from a closed one, nothing was tried.
          if (pt === undefined || (pt === null && pool !== null && pool.isClosed)) pt = await v.requestText(sweepPage)
          if (cancelled) return
          if (pt === null) continue
          /*
           * Named first, indexed after, and a failed index is not a failed
           * name: a page with no row in the store yet ("FOREIGN KEY
           * constraint failed") left every sheet but the first unnamed
           * (0.3.98 test builds, SLS 2026-11-26).
           */
          namer.add(sweepPage, pt, false, v.getPageSize(sweepPage))
          await indexPageText(db, {
            pageId: pageIdFor(docId, sweepPage),
            documentId: docId,
            content: pt.text,
            source: pt.scanned ? 'ocr-needed' : 'native',
          }).catch(() => undefined)
        } catch {
          // One unreadable sheet is not a reason to stop reading the rest.
        }
        // The list fills in as it goes, a few times a second rather than per page.
        if (sweepPage === pageCount - 1) namer.finish()
        if (performance.now() - shown > 250 || sweepPage === pageCount - 1) {
          shown = performance.now()
          setDerivedLabels(namer.names())
          setSweepRead((s) => ({ ...s, read: sweepPage + 1, of: pageCount }))
          const block = namer.titleBlock()
          if (block !== blockShown) { blockShown = block; setFoundTitleBlock(block) }
        }
      }
    })()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageCount, docIndex.shape, docIndex.labels, activeDocId, docUrl])
  /** The title block found on the set's own sheets (shell/findTitleBlock.ts), for list_sheets. */
  const [foundTitleBlock, setFoundTitleBlock] = useState<FoundTitleBlock | null>(null)


  /*
   * Sheet names from two boxes on the title block (shell/titleBlock.ts).
   *
   * The boxes and any names set one sheet at a time live in the file's
   * redbeam_meta, so they travel in the PDF. Every page is read in the boxes
   * in the background; when the reading finishes, the names go into
   * redbeam_meta as the labels the next save writes into /PageLabels, which is
   * what Bluebeam shows as the page names (Aaron, 2026-11-25).
   */
  const [titleRegions, setTitleRegions] = useState<TitleBlockRegions | null>(null)
  const [sheetOverrides, setSheetOverrides] = useState<Map<number, ReadName>>(new Map())
  const [regionNames, setRegionNames] = useState<Array<ReadName | null>>([])
  const [titleReading, setTitleReading] = useState<{ done: number; total: number } | null>(null)
  /** True once every page has been read in the current boxes. */
  const [titleReadDone, setTitleReadDone] = useState(false)

  const loadTitleMeta = useCallback(async () => {
    const db = dbRef.current
    if (!db) return
    try {
      const rows = await db.all<{ key: string, value: string }>(
        'SELECT key, value FROM redbeam_meta WHERE key IN (?, ?)', [TITLE_REGIONS_KEY, SHEET_OVERRIDES_KEY])
      setTitleRegions(parseRegions(rows.find((r) => r.key === TITLE_REGIONS_KEY)?.value))
      setSheetOverrides(parseOverrides(rows.find((r) => r.key === SHEET_OVERRIDES_KEY)?.value))
    } catch {
      setTitleRegions(null)
      setSheetOverrides(new Map())
    }
  }, [])
  const loadTitleMetaRef = useRef(loadTitleMeta); loadTitleMetaRef.current = loadTitleMeta
  useEffect(() => {
    setTitleRegions(null)
    setSheetOverrides(new Map())
    void loadTitleMeta()
  }, [activeDocId, loadTitleMeta])

  useEffect(() => {
    setRegionNames([])
    setTitleReadDone(false)
    const v = viewerRef.current
    if (!v || titleRegions === null || pageCount === 0) { setTitleReading(null); return }
    let cancelled = false
    const regions = titleRegions
    void (async () => {
      const names: Array<ReadName | null> = new Array<ReadName | null>(pageCount).fill(null)
      let shown = performance.now()
      setTitleReading({ done: 0, total: pageCount })
      // `sweepPage`: this enumerates EVERY page; see the derived-labels sweep.
      for (let sweepPage = 0; sweepPage < pageCount; sweepPage++) {
        if (cancelled) return
        try {
          const pt = v.getText(sweepPage) ?? await v.requestText(sweepPage)
          if (cancelled) return
          names[sweepPage] = readSheetName(pt, regions)
        } catch {
          // One unreadable sheet keeps its old name; the rest are still read.
        }
        // The list fills in as it goes, a few times a second rather than per page.
        if (performance.now() - shown > 200 || sweepPage === pageCount - 1) {
          shown = performance.now()
          setRegionNames([...names])
          setTitleReading({ done: sweepPage + 1, total: pageCount })
        }
      }
      if (cancelled) return
      setTitleReading(null)
      setTitleReadDone(true)
      const read = names.filter((n) => n !== null).length
      setStatus(read === pageCount
        ? `named all ${pageCount} sheets from the title block`
        : `named ${read} of ${pageCount} sheets from the title block; ${pageCount - read === 1 ? '1 sheet had nothing in the number box and kept its old name' : `${pageCount - read} had nothing in the number box and kept their old names`}`)
    })()
    return () => { cancelled = true }
  }, [pageCount, activeDocId, titleRegions, setStatus])

  /** The file and names last saved to add bookmarks, so an unchanged file is not saved again. */
  const bookmarkNudgeRef = useRef<string | null>(null)

  /** Each page's title block name: set for that sheet, else read in the boxes. */
  const titleNames = useMemo(
    () => (titleRegions === null && sheetOverrides.size === 0 ? [] : mergeNames(pageCount, regionNames, sheetOverrides)),
    [pageCount, regionNames, sheetOverrides, titleRegions],
  )

  /*
   * Into the file: once the reading is finished (or there are only names set
   * by hand), the labels the next save writes as /PageLabels.
   */
  useEffect(() => {
    const db = dbRef.current
    if (!db || pageCount === 0) return
    if (titleRegions !== null && !titleReadDone) return
    if (titleRegions === null && sheetOverrides.size === 0) return
    const labels = labelsToWrite(pageCount, titleNames, docIndex.labels)
    if (labels === null) return
    const value = JSON.stringify(labels)
    void (async () => {
      try {
        const rows = await db.all<{ value: string }>('SELECT value FROM redbeam_meta WHERE key = ?', [SHEET_LABELS_KEY])
        if (rows[0]?.value === value) {
          // Named before the names became bookmarks: one save adds them.
          const nudge = `${activeDocId}|${value}`
          if (!bookmarksHaveLabels(docIndex.outline, labels) && bookmarkNudgeRef.current !== nudge) {
            bookmarkNudgeRef.current = nudge
            saveRef.current()
          }
          return
        }
        await db.run('INSERT OR REPLACE INTO redbeam_meta(key, value) VALUES(?, ?)', [SHEET_LABELS_KEY, value])
        saveRef.current()
      } catch { /* the names still show; the next change tries again */ }
    })()
  }, [titleNames, titleReadDone, titleRegions, sheetOverrides, pageCount, docIndex.labels, docIndex.outline, activeDocId])

  /** Keep the boxes in the file and read every sheet in them. Null removes them. */
  const applyTitleRegions = useCallback(async (regions: TitleBlockRegions | null) => {
    const db = dbRef.current
    if (!db) return
    if (regions === null) await db.run('DELETE FROM redbeam_meta WHERE key = ?', [TITLE_REGIONS_KEY])
    else await db.run('INSERT OR REPLACE INTO redbeam_meta(key, value) VALUES(?, ?)', [TITLE_REGIONS_KEY, JSON.stringify(regions)])
    setTitleRegions(regions)
    saveRef.current()
  }, [])

  /** Names set one sheet at a time; `null` takes a page's back off. */
  const applySheetNames = useCallback(async (names: ReadonlyArray<{ page: number; name: ReadName | null }>) => {
    const db = dbRef.current
    if (!db) return
    const next = new Map(sheetOverrides)
    for (const { page: at, name } of names) {
      if (name === null) next.delete(at)
      else next.set(at, name)
    }
    await db.run('INSERT OR REPLACE INTO redbeam_meta(key, value) VALUES(?, ?)',
      [SHEET_OVERRIDES_KEY, JSON.stringify(Object.fromEntries([...next].map(([k, v]) => [String(k), v])))])
    setSheetOverrides(next)
    saveRef.current()
  }, [sheetOverrides])

  const openTitlePick = useCallback(() => {
    if (pageCount === 0) return
    disarmZoomBoxRef.current()
    setTitlePick({
      step: 'number',
      number: titleRegions?.number ?? null,
      title: titleRegions?.title ?? null,
      numberText: null,
      titleText: null,
    })
    // Show what the saved boxes read on this sheet, when there are some.
    const v = viewerRef.current
    const at = pageIndexRef.current
    if (v && titleRegions !== null) {
      void (async () => {
        try {
          const pt = v.getText(at) ?? await v.requestText(at, { priority: 0 })
          setTitlePick((cur) => cur === null ? cur : {
            ...cur,
            numberText: cur.number === null ? null : textInBox(pt, cur.number),
            titleText: cur.title === null ? null : textInBox(pt, cur.title),
          })
        } catch { /* the card says nothing read */ }
      })()
    }
    requestPaint()
  }, [pageCount, titleRegions, setStatus, requestPaint])

  /** A box dragged while the card is up: it answers the card's current step. */
  const finishTitleBox = useCallback((box: ScreenBox) => {
    const v = viewerRef.current
    if (!v || page.width === 0 || titlePickRef.current === null) return
    const a = screenToNormalized(box.x0, box.y0, viewRef.current, page.width, page.height)
    const b = screenToNormalized(box.x1, box.y1, viewRef.current, page.width, page.height)
    const clamp = (n: number) => Math.min(1, Math.max(0, n))
    const nbox = {
      x0: clamp(Math.min(a.x, b.x)), y0: clamp(Math.min(a.y, b.y)),
      x1: clamp(Math.max(a.x, b.x)), y1: clamp(Math.max(a.y, b.y)),
    }
    if (isTinyBox(nbox)) { setStatus('drag a box, not a click: around the whole field'); return }
    const step = titlePickRef.current.step
    setTitlePick((cur) => cur === null ? cur : (step === 'number'
      ? { ...cur, number: nbox, numberText: '' }
      : { ...cur, title: nbox, titleText: '' }))
    const at = pageIndexRef.current
    void (async () => {
      try {
        const pt = v.getText(at) ?? await v.requestText(at, { priority: 0 })
        const text = textInBox(pt, nbox)
        setTitlePick((cur) => cur === null ? cur : (step === 'number' ? { ...cur, numberText: text } : { ...cur, titleText: text }))
        if (text === '') setStatus(pt.scanned ? 'this sheet is a scan with no text to read' : 'no text in that box; drag it around the words')
      } catch {
        setStatus('could not read the text on this sheet')
      }
    })()
    requestPaint()
  }, [page.width, page.height, requestPaint, setStatus])
  const finishTitleBoxRef = useRef(finishTitleBox); finishTitleBoxRef.current = finishTitleBox

  const goToPage = useCallback((index: number) => {
    const v = viewerRef.current
    if (!v || index === pageIndex) return
    // Only ask for the page. Do NOT set the viewport here: the size known at
    // boot comes from the page dictionary (FPDF_GetPageSizeByIndexF) and can
    // differ slightly from the opened page's own box — 3456 x 2592.24 vs
    // 3456.48 x 2591.04 on this set. Setting zoom from the boot size requests
    // tiles at one zoom while onPage then paints at another, so every lookup
    // misses and the canvas stays empty. onPage is the authoritative source.
    v.loadPage(index)
    setSelectedIds([]); selectedRef.current = []
  }, [pageIndex])

  /** Step one sheet either way, for the window's key listener (#30). */
  const stepPageRef = useRef<(step: -1 | 1) => void>(() => {})
  stepPageRef.current = (step) => {
    const next = steppedPage(pageIndex, pageCount, step)
    if (next !== null) goToPage(next)
  }

  // Resolve the active document to something the worker can fetch.
  //
  // Project PDFs live outside the web root, so the core streams them by byte
  // range (or, failing that, hands back the bytes for a blob URL). Browser mode has no filesystem, so it falls
  // back to the bundled sample — the app stays usable for iteration rather than
  // showing an empty stage.
  //
  // Keyed by the file's path, not the catalog: the catalog is a new array
  // whenever any document's record changes (another tab opened, an index
  // finished, a save), and each new array used to issue a new stream token,
  // release the old one and restart the viewer and the set's readers. On a
  // 4,400-page spec the sheet list then never got past its first sheet
  // (0.3.98 test build, SLS 2026-11-26).
  const activeDocRow = documents.find((d) => d.id === activeDocId)
  const activeRelPath = activeDocRow?.relativePath ?? null
  // A changed file on disk is still a reason to read it again.
  const activeFileStamp = activeDocRow === undefined ? '' : `${activeDocRow.sizeBytes}|${activeDocRow.modifiedAtObserved ?? ''}`
  useEffect(() => {
    if (activeRelPath === null) { setDocUrl(isTauri() ? null : '/sample.pdf'); return }
    if (!isTauri()) { setDocUrl('/sample.pdf'); return }

    let cancelled = false
    const resolver = createCoreDocumentUrlResolver(projectPath)
    void resolver.resolveUrl({ relativePath: activeRelPath }).then((url) => {
      if (cancelled || !url) { if (url) resolver.releaseUrl(url); return }
      setDocUrl(url)
    })
    return () => { cancelled = true; resolver.release() }
  }, [activeRelPath, activeFileStamp, activeDocId, projectPath])

  /*
   * Index the whole project's text, starting the moment the folder is known.
   *
   * See `search/indexer.ts` for what and why. Runs in its own worker, one
   * document at a time, and is cancelled if the project closes or the
   * catalog changes under it. Documents it has finished are remembered per
   * machine, keyed by content fingerprint, so a reopen costs one lookup per
   * document and a replaced drawing is read again.
   *
   * Desktop only: the browser build cannot read a project folder.
   */
  useEffect(() => {
    const db = dbRef.current
    if (!db || scan !== 'done' || documents.length === 0 || !isTauri()) return
    let cancelled = false
    const key = `redbeam.indexed.v1:${projectPath}`
    const fingerprintOf = new Map(documents.map((d) => [d.id, d.contentFingerprint ?? '']))
    let done: Record<string, string> = {}
    try { done = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, string> } catch { done = {} }
    const completed = {
      has: (id: string) => done[id] !== undefined && done[id] === fingerprintOf.get(id),
      add: (id: string) => {
        done[id] = fingerprintOf.get(id) ?? ''
        try { localStorage.setItem(key, JSON.stringify(done)) } catch { /* a lost marker costs one re-read */ }
      },
    }
    const resolver = createCoreDocumentUrlResolver(projectPath)
    void indexProject({
      db,
      documents,
      resolveUrl: (d) => resolver.resolveUrl(d),
      releaseUrl: (u) => resolver.releaseUrl(u),
      openDocument: (url) => openHeadlessDocument(url),
      completed,
      isCancelled: () => cancelled,
      onProgress: (p) => { if (!cancelled) setIndexing(p.done >= p.total ? null : p) },
    }).then((out) => {
      if (cancelled) return
      setIndexing(null)
      if (out.failures.length > 0) {
        setTextNote(`Text indexing skipped ${out.failures.length} item${out.failures.length === 1 ? '' : 's'}: ${out.failures[0]!.relativePath} — ${out.failures[0]!.reason}`)
      }
    }).catch((err) => {
      if (!cancelled) setTextNote(`Text indexing stopped: ${err instanceof Error ? err.message : String(err)}`)
    })
    return () => { cancelled = true; setIndexing(null); resolver.release() }
  }, [documents, scan, projectPath])

  // Extract and index this page's text once it is shown.
  //
  // Extraction runs behind visible tiles in the worker's own queue, so this
  // never delays the sheet being drawn. Indexing on view rather than on ingest
  // is deliberate: extracting 75 sheets up front would cost minutes of worker
  // time for pages the estimator may never open, and search reports its own
  // coverage so a partial index is visible rather than silently wrong.
  useEffect(() => {
    const db = dbRef.current
    const v = viewerRef.current
    const docId = activeDocId
    if (!db || !v || !docId || page.width === 0) return
    const pageId = pageIdFor(docId, pageIndexRef.current)
    // page_text has a foreign key to pages. Indexing before the row exists
    // fails the constraint, and because the failure used to be a console
    // warning, search simply stayed empty with no way to tell that it had
    // broken rather than found nothing. Wait for the row.
    if (pageReadyKey !== pageId) return

    let cancelled = false
    const index = pageIndex

    void v.requestText(index).then(async (pt) => {
      perfRef.current.record('text', pt.ms)
      if (cancelled || !pt) return
      // A page with no text layer is a scanned raster, not an empty page.
      // Record it either way so coverage counts it as looked at.
      await indexPageText(db, {
        pageId,
        documentId: docId,
        content: pt.text,
        source: pt.scanned ? 'ocr-needed' : 'native',
      })
      if (!cancelled) setTextNote(null)
    }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn('[text] could not index page', index, err)
      // Say it out loud: a silent indexing failure makes search answer
      // "no matches" for text that is right there on the sheet.
      if (!cancelled) setTextNote(`Text indexing failed for page ${index + 1}: ${msg}`)
    })

    return () => { cancelled = true }
  }, [activeDocId, pageIndex, page.width, pageReadyKey])

  /**
   * Run a search over the chosen reach.
   *
   * Hits on the OPEN document carry boxes, resolved from the viewer's own
   * text extraction, so they can be painted and highlighted; a sheet in
   * another document has no viewer to ask, and its hits carry none. The
   * folder reach is the open document's folder; at the root it is the
   * whole project.
   */
  const runSearch = useCallback(async (q: string, scope: SearchScope, offset = 0) => {
    const db = dbRef.current
    if (!db) throw new Error('no project is open')
    const docId = docIdRef.current
    const doc = documents.find((d) => d.id === docId)
    const folder = doc === undefined ? '' : doc.relativePath.split('/').slice(0, -1).join('/')
    const reach =
      scope === 'sheet' ? { documentId: docId, pageId: pageIdFor(docId, pageIndexRef.current) }
      : scope === 'document' ? { documentId: docId }
      : scope === 'folder' && folder !== '' ? { pathPrefix: folder }
      : {}
    // A new search takes the last one's highlight off the sheet.
    if (offset === 0 && hitHighlightRef.current !== null) { hitHighlightRef.current = null; requestPaint() }
    const report = await searchProjectText(db, q, {
      ...reach,
      offset,
      layout: async (pageId) => {
        const v = viewerRef.current
        const index = pageIndexOf(pageId)
        if (!v || index === null || !pageId.startsWith(`${docIdRef.current}-p`)) return undefined
        try {
          const t = await v.requestText(index)
          return { runs: t.runs }
        } catch {
          return undefined
        }
      },
    })
    /*
     * Light's store is sql.js, which has no FTS5, so every search is the LIKE
     * scan. Over one PDF that is the right search, not a degraded one, and the
     * "Limited search … page_text_fts" note was database talk on every search.
     */
    /*
     * Light indexes a PDF's pages as it reads them after opening, and only
     * read pages have rows, so the store's own count says 100% while a big
     * set is still being read (a search on set-171 said 32, then 57). The
     * document's real page count says how much is left.
     */
    if (light && scope === 'document' && pageCount > report.totalPageCount) {
      return { ...report, degraded: null, totalPageCount: pageCount }
    }
    return light ? { ...report, degraded: null } : report
  }, [documents, light, pageCount, requestPaint])

  /**
   * Read the project folder again.
   *
   * The folder is scanned once, when the project opens; a drawing dropped in
   * during a session was invisible until the next launch. Kenneth,
   * 2026-09-10: "give me a refresh option to refresh the file tree if files
   * have been added within the session." The same sequence as opening (scan,
   * reconcile only on a complete scan, list), and the indexer picks up
   * whatever is new from the documents list.
   */
  const refreshFiles = useCallback(async () => {
    const db = dbRef.current
    if (!db) return
    setScan('reading')
    setStatus('reading the folder…')
    try {
      const opened2 = await openProjectDocuments(db, scanner, projectPath, () => false)
      // The browser build cannot scan; keep the bundled sample listed.
      if (opened2.documents.length > 0 || isTauri()) setDocuments(opened2.documents)
      setIngestNote(opened2.note)
      const n = opened2.documents.length
      setStatus(`${n} document${n === 1 ? '' : 's'} in the folder`)
    } catch (err) {
      setStatus(`could not read the folder: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setScan('done')
    }
  }, [projectPath])

  /**
   * A page to show once the NEXT document has booted.
   *
   * A hit in another document changes the document and asks for the page in
   * the same tick, and the viewer still holding the old document refused the
   * page — "page 3 out of range (0..0)" on every hit past a one-sheet PDF.
   * The page waits here and the new viewer's onReady takes it.
   */
  const pendingPageRef = useRef<number | null>(null)
  /**
   * A markup to centre once its sheet is showing: set when a markup row is
   * clicked for another sheet or document, and applied in onPage, after the
   * new sheet's offsets are reset (which is what used to leave the view on
   * the sheet's top-left corner).
   */
  const pendingFrameRef = useRef<{ documentId: string; page: number; box: NormBox } | null>(null)
  const goToHit = useCallback((hit: SearchHit) => {
    // pageNumber is ZERO-based, straight from pages.page_number — the same
    // space as the viewer's index. Adding one here would land a sheet past
    // every hit.
    hitHighlightRef.current = hit.boxes !== null && hit.boxes.length > 0
      ? { pageId: hit.pageId, boxes: hit.boxes }
      : null
    if (hit.documentId !== docIdRef.current) {
      pendingPageRef.current = hit.pageNumber
      setActiveDocId(hit.documentId)
      return
    }
    goToPage(hit.pageNumber)
    requestPaint()
  }, [goToPage, requestPaint])

  /*
   * Bumped when the PDF reader (the viewer's worker) dies, to build a fresh
   * one on the same document at the same sheet. NOIC spec, 2026-11-26: a
   * reader that stopped on page 1968 left the tab showing a blank sheet and
   * every agent call on it waiting for ever.
   */
  const [readerGen, setReaderGen] = useState(0)
  /*
   * Readers of their own for a whole set's text (search/textPool.ts), made
   * the first time an agent searches the PDF and kept while it is open.
   */
  const textPoolRef = useRef<PageTextPool | null>(null)
  useEffect(() => () => { textPoolRef.current?.close(); textPoolRef.current = null }, [docUrl])
  const textPool = (): PageTextPool | null => {
    if (textPoolRef.current !== null) return textPoolRef.current
    if (docUrl === null) return null
    const url = docUrl
    textPoolRef.current = new PageTextPool({
      open: () => openHeadlessDocument(url),
      lanes: laneCount(typeof navigator === 'undefined' ? undefined : navigator.hardwareConcurrency),
      onText: (page, text) => { viewerRef.current?.primeText(page, text) },
    })
    return textPoolRef.current
  }
  const readerLostRef = useRef<{ at: number; count: number }>({ at: 0, count: 0 })

  // ---------------------------------------------------------------- viewer --
  useEffect(() => {
    if (!rasterRef.current || !overlayRef.current || !docUrl) return
    // Changing document tears the viewer down and rebuilds it. PDFium init
    // costs ~1s, which is acceptable per switch and far simpler than teaching
    // the worker to hold several documents — page handles are already pooled
    // per document, and two documents' pools would contend for the same bound.
    const worker = new PdfWorker()
    // Back and Forward are within one document; a new one starts clean.
    historyRef.current.clear()
    historyNavRef.current = null
    textPickRef.current = null
    let shownPage: number | null = null
    let booted = false
    setOpenFailed(false)
    const viewer = new Viewer(rasterRef.current, overlayRef.current, worker, {
      tileSize: 512,
      // Thumbnails kept so scrolling back through a big set does not render
      // them again (Kenneth, 2026-11-26: "make them load faster"). 64 held
      // barely two screens; 800 is about 250 MB at the sharpest size.
      maxThumbnails: 800,
      overlay: { strokeScale: strokeScaleFor },
      // The viewer already reports each tile's cost; feed it to the budget
      // rather than measuring it a second time from outside.
      onTile: (ms) => {
        perfRef.current.record('tile', ms)
        // The arrival IS the reason to repaint. Previously nothing here asked
        // for one and the 120ms interval eventually noticed.
        requestPaint()
      },
      onReady: ({ pageCount: n, sizes }) => {
        booted = true
        setPageCount(n); setPageSizes([...sizes])
        // The page a search hit asked for before this document had booted.
        const want = pendingPageRef.current
        pendingPageRef.current = null
        if (want !== null && want >= 0 && want < n) viewer.loadPage(want)
      },
      onPage: (info) => {
        setPage({ width: info.width, height: info.height })
        let stored: number[] = []
        try {
          const book = parseHiddenBook(sessionStorage.getItem(hiddenStorageKey(docIdRef.current ?? '')))
          stored = hiddenOnPage(book, info.index)
        } catch { stored = [] }
        hiddenAnnotsRef.current = new Set(stored)
        ownAnnotsRef.current = new Set()
        setHiddenAnnotCount(stored.length)
        if (viewer.setHiddenAnnotations(info.index, stored)) viewer.requestVisible(viewRef.current)
        // The sheet's own markups, for the Select tool: asked of THIS viewer,
        // for the page it has just shown, so a document switch cannot serve
        // the previous document's list.
        hideOwnAnnots(viewer, info.index)
        /*
         * Keep the page-size TABLE current, not just the active page.
         *
         * `onReady` fires once, with whatever sizes the worker knew at boot;
         * the viewer then fills the rest in as pages load, in an array this
         * component never re-reads. So `pageSizes` was a snapshot of the boot
         * state forever.
         *
         * That table is what turns a stored calibration into a usable one: the
         * piece calculation skips any page whose size it does not know, and a
         * skipped page contributes no layout groups. The result was a scope
         * with a calibrated sheet, a direction and drawn areas producing no
         * planks, no rails and no order lines at all — while the plain area
         * roll-up, which reads the ACTIVE page rather than the table, went on
         * reporting square feet as if nothing were wrong.
         */
        setPageSizes((prev) => {
          const known = prev[info.index]
          if (known && known.width === info.width && known.height === info.height) return prev
          const next = [...prev]
          next[info.index] = { width: info.width, height: info.height }
          return next
        })
        // Leaving a sheet records where you were on it, for Back (Alt+Left).
        // A Back or Forward in progress records nothing of its own.
        if (shownPage !== null && shownPage !== info.index && historyNavRef.current === null) {
          const cur = viewRef.current
          historyRef.current.leave({ page: shownPage, zoom: cur.zoom, ox: cur.ox, oy: cur.oy })
        }
        shownPage = info.index
        if (historyNavRef.current !== null && historyNavRef.current.page === info.index) setFitMode(null)
        /*
         * A markup row clicked for this sheet: centre the markup, keeping the
         * zoom unless it does not fit. Leaving fit stops the fit effect
         * re-framing the whole sheet straight after, and `framed` stops the
         * reset below, which React may run later than this line.
         */
        let framed = false
        const frame = pendingFrameRef.current
        if (frame !== null && frame.page === info.index && frame.documentId === docIdRef.current) {
          pendingFrameRef.current = null
          const st = stageSizeRef.current
          if (st.width > 0 && st.height > 0) {
            framed = true
            setFitMode(null)
            viewRef.current = clampViewport(frameBox(viewRef.current, frame.box, info, st, MAX_ZOOM), info)
          }
        }
        setPageIndex((prev) => {
          // A different sheet is framed fresh rather than inheriting the last
          // one's scroll; a re-report of the same page keeps the user's view.
          if (prev !== info.index && !framed) { viewRef.current.ox = 0; viewRef.current.oy = 0 }
          return info.index
        })
        /*
         * Do NOT invent a zoom here.
         *
         * This used to fit the page against the hardcoded VW x VH constants
         * rather than the real viewport, so every page load jumped to a zoom
         * computed for a 1180x780 window that may not exist. Worse, switching
         * between two same-size sheets leaves `page.width/height` unchanged, so
         * the fit effect never re-ran to correct it and the wrong zoom stuck —
         * which is what anchored a sheet in the top-left instead of filling
         * the viewport.
         *
         * Zoom belongs to the fit mode, which knows the actual stage size.
         * Here we only adopt the new page box and re-clamp, which re-centres
         * the offsets that were just reset above.
         */
        viewRef.current = clampViewport(viewRef.current, info)
        viewer.requestVisible(viewRef.current)
        // The page box used to be announced here. It is a readout, not an
        // event, and now that status is shown as one it would toast on every
        // sheet change; `page` already carries the box for anyone who asks.
      },
      onError: (m) => {
        // Before the document is up, the error IS the document: it would not
        // open. "error: FPDF_LoadMemDocument failed" over a pane that said
        // "Opening the drawing…" forever was all a damaged PDF got.
        if (!booted) {
          setOpenFailed(true)
          setStatus('This PDF could not be opened. It may be damaged, password-protected or not a PDF.')
          return
        }
        setStatus(`error: ${m}`)
      },
      onWorkerLost: (why) => {
        // Start a fresh reader on the sheet that was showing. A reader that
        // dies again at once (three times in a minute) is left down, and says so.
        const lost = readerLostRef.current
        const now = Date.now()
        lost.count = now - lost.at < 60_000 ? lost.count + 1 : 1
        lost.at = now
        console.error('PDF reader stopped:', why)
        if (lost.count > 3) {
          setStatus(`The PDF reader keeps stopping (${why}). Close and reopen this PDF.`)
          return
        }
        setStatus('The PDF reader stopped and is restarting…')
        // Back to the same sheet, unless that sheet is what keeps stopping it.
        if (lost.count === 1 && pendingPageRef.current === null && pageIndexRef.current >= 0) pendingPageRef.current = pageIndexRef.current
        setTimeout(() => setReaderGen((g) => g + 1), 0)
      },
    })
    viewerRef.current = viewer
    // Markups switched off stay off across a document switch.
    viewer.setAnnotationsVisible(!embeddedHiddenRef.current)
    viewer.setOverlayVisible(!redbeamHiddenRef.current)
    viewer.boot('/pdfium.wasm', docUrl)
    // A pending page (a search hit into this document) is loaded from onReady
    // instead, once the count is known.
    const t = setTimeout(() => { if (pendingPageRef.current === null) viewer.loadPage(0) }, 50)
    return () => {
      clearTimeout(t)
      if (frameRef.current !== 0) cancelAnimationFrame(frameRef.current)
      frameRef.current = 0
      viewer.destroy()
      viewerRef.current = null
      fieldGeometryRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docUrl, readerGen])

  // Push committed markups into the viewer overlay.
  useEffect(() => {
    const v = viewerRef.current
    if (!v) return
    // A hole is shown by its area's shape, not as an object of its own.
    const set: OverlaySet = toOverlay(markups.filter((m) => !isCutId(m.id)), scopes, pendingIdsRef.current)
    v.setOverlay(set)
    requestPaint()
  }, [markups, scopes, requestPaint])

  /*
   * Quantities and pieces, DERIVED in the render that changed their inputs.
   *
   * This was an effect that set state, so every edit rendered the whole
   * window twice: once with the new markups and the old totals, then again
   * with the totals. The second render was pure overhead (and for one frame
   * the totals disagreed with the sheet).
   */
  const takeoffTotals = useMemo((): {
    quantities: Array<{ scope: Scope; rows: QuantityResult[] }>
    pieces: Array<{ scope: Scope; result: PieceResult; factoryCut?: FactoryCut }>
    /** Lays one scope out over the markups given, as `pieces` was: for get_bom's per-area counts. */
    layOut?: (scope: Scope, markups: readonly Markup[]) => PieceResult
  } => {
    /*
     * NOT GATED ON THE OPEN SHEET'S SCALE.
     *
     * This began `if (!cal) { setQuantities([]); return }`, where `cal` is the
     * calibration of the page on screen. Everything below measures per page
     * from the PROJECT's calibrations, so that gate did only one thing: with
     * no sheet open, or an unscaled sheet on screen, it emptied every scope in
     * the round. A scope with six scaled areas on A-101 read "No measurement"
     * and had no parts, the export said "No takeoff yet" for the whole round,
     * and a committed scope reported "5 changed" against a live total that
     * was empty because the cover sheet happened to be showing. The numbers
     * changed when you changed tabs. That was the hot mess, and it was one
     * line.
     *
     * A page with no calibration still contributes nothing — that rule is
     * kept, per page, below. What is gone is the rule that the sheet you are
     * LOOKING at decides whether any other sheet counts.
     */
    /*
     * The DOCUMENT's markups, measured page by page.
     *
     * This read the current PAGE's markups while the piece calculation beside
     * it reads the whole document — so the same panel showed "Area 0 SF" next
     * to "231 panels" whenever the open sheet happened to carry none of that
     * scope's takeoff. Two numbers under one heading, aggregated over
     * different things, with nothing saying so.
     *
     * It was page-scoped for a reason: `calculateScopeQuantities` takes ONE
     * calibration, and measuring an off-screen markup against the open sheet's
     * box is how a quantity comes out confidently wrong. So the fix is not to
     * hand it everything — it is to run it per page, each with that page's own
     * calibration and box, and add the rows up. A page with no calibration
     * contributes nothing rather than being measured at another page's scale.
     */
    /*
     * Bucketed by page AND by scale region (plan 14.2).
     *
     * This grouped by page alone, which is right until a sheet carries more
     * than one scale — a details page with four details on it measured all
     * four at whichever number the page held, so three of them were wrong and
     * looked entirely plausible.
     *
     * Grouping rather than measuring each markup on its own is what keeps
     * CUTOUTS working: a hole drawn inside detail 3 has to subtract from
     * detail 3's area, and it can only do that if the two are aggregated
     * together. A page with no regions yields exactly one bucket, so this is
     * the old behaviour where nothing has been drawn.
     */
    const buckets = bucketByScale(
      projectMarkups,
      projectRegions,
      (pageId) => projectCalibrations.get(pageId) ?? null,
    )
    const quantities = scopes.map((s) => {
      /*
       * A scope with nothing drawn has NO rows, not a row reading 0.
       *
       * The per-bucket calculation returns its area and length lines at zero
       * for a scope none of the bucket's markups belong to, and adding those
       * up printed "0 SF" in the round's list beside "0 markups" — a
       * measurement of nothing, presented as a measurement. Nothing drawn is
       * an absence, and the row and the hero both already know how to say so.
       */
      if (!projectMarkups.some((m) => m.scopeId === s.id)) return { scope: s, rows: [] }
      const totals = new Map<string, QuantityResult>()
      for (const bucket of buckets) {
        // Boxes come from the store, keyed by page id, so a page in another
        // document is measured on its own terms rather than left out.
        const size = projectPageBoxes.get(bucket.pageId)
        if (size === undefined || bucket.feetPerPoint === null) continue
        const bucketCal = {
          feetPerPoint: bucket.feetPerPoint,
          pageWidth: size.width,
          pageHeight: size.height,
        }
        for (const row of calculateScopeQuantities(s, bucket.markups, bucketCal)) {
          const hit = totals.get(row.itemKey)
          if (hit) hit.quantity += row.quantity
          else totals.set(row.itemKey, { ...row })
        }
      }
      return { scope: s, rows: [...totals.values()] }
    })

    /*
     * Pieces are rolled up across the WHOLE DOCUMENT, each page at its own
     * scale (plan 06.11).
     *
     * This used to hand the roll-up the open page's markups and the open page's
     * calibration. Both were wrong for any scope that spans sheets, which is
     * most of them: a ceiling continuing onto the next floor plan was simply
     * absent from the count, and had it been included it would have been
     * measured at whatever scale the sheet you happened to be looking at was
     * drawn to. A details sheet at 1/4" read against a plan at 1/8" comes out
     * four times its true area — and it looks perfectly plausible, which is
     * what makes it expensive.
     *
     * A page with no calibration is left out rather than borrowed against;
     * a missing number is recoverable and a confident wrong one is not.
     */
    const calibrations = new Map<string, Calibration>()
    const pageBoxes = new Map<string, { width: number; height: number }>()
    /*
     * Keyed by page id across the PROJECT, from the store.
     *
     * This walked the open document's calibrations and looked each page's box
     * up in the viewer's array — which only knows the open document, so a
     * scope continuing into another file contributed nothing and the total
     * silently changed when you switched tabs.
     */
    for (const [pageId, feetPerPoint] of projectCalibrations) {
      const size = projectPageBoxes.get(pageId)
      if (size === undefined) continue
      calibrations.set(pageId, { feetPerPoint, pageWidth: size.width, pageHeight: size.height })
      pageBoxes.set(pageId, size)
    }

    /*
     * `calculatePieces` wants one calibration and one page size as the
     * fallback for a page the maps do not cover. The open sheet's, when it
     * has one; otherwise any calibrated page's, since the maps carry the real
     * per-page values and the fallback only matters for a page that has a box
     * but no calibration — which is excluded from the count anyway. With no
     * calibrated page anywhere there is nothing to measure, and that is the
     * one case that still ends with no numbers.
     */
    const first = calibrations.values().next()
    const fallbackCal: Calibration | null = cal ?? (first.done ? null : first.value)
    if (fallbackCal === null) return { quantities, pieces: [] }
    const pageSize = { width: fallbackCal.pageWidth, height: fallbackCal.pageHeight }

    /*
     * Devices (issue #12): counts in a device scope, placed through the
     * ceiling. Each piece one lands in is cut at the factory, which the
     * preview hatches. Found from the SAME result the preview draws, so the
     * hatch cannot disagree with the grid under it.
     */
    const devices = deviceLocations(projectMarkups, scopes, (pageId) => projectPageBoxes.get(pageId) ?? null)
    const withCuts = (scope: Scope, result: PieceResult) =>
      devices.length === 0 ? { scope, result } : { scope, result, factoryCut: factoryCutPieces(result, devices) }

    /*
     * A pattern an agent is previewing (redbeam_preview_pattern) is laid on
     * its scope in place of what the scope holds, until it is saved or
     * dropped. Nothing is written: the PDF and the undo list never see it.
     */
    const asPreviewed = (s: Scope): Scope => {
      const recipe = patternPreviews.get(s.id)
      return recipe === undefined ? s : { ...s, specifications: { ...s.specifications, productType: 'custom_pattern', [PATTERN_RECIPE_KEY]: recipe } }
    }
    const layOut = (s: Scope, markups: readonly Markup[]): PieceResult =>
      calculatePieces(s, markups, fallbackCal, {
        scopeDirection: scopeDefaultDirectionFrom(s.specifications),
        // AREA beats PAGE beats SCOPE. See `directionFrom` in the domain.
        pageDirections: pageDirectionsFrom(s.specifications),
        areaDirections: areaDirectionsFrom(s.specifications),
        perAreaOrigin: prefs['takeoff.perAreaOrigin'] === true,
        // A drawn edge within 1" of a panel line is on it (NOIC CL115).
        edgeSnapFeet: 1 / 12,
        defaultPatternCorner: isAreaCorner(prefs['takeoff.patternStart'])
          ? prefs['takeoff.patternStart']
          : prefs['takeoff.patternStart'] === 'automatic' ? null : 'top-left',
        pageSize,
        calibrations,
        pageSizes: pageBoxes,
        // Layout resolves scale the same way the roll-up does, so a details
        // sheet's piece count agrees with its area instead of the two
        // disagreeing confidently.
        scaleRegions: projectRegions,
      })
    const pieces = scopes.map(asPreviewed).map((s) => withCuts(s, layOut(s, projectMarkups)))
    return { quantities, pieces, layOut: (s, markups) => layOut(asPreviewed(s), markups) }
  }, [projectMarkups, projectCalibrations, projectPageBoxes, projectRegions, scopes, cal, prefs, patternPreviews])
  const { quantities, pieces } = takeoffTotals

  useEffect(() => { piecesRef.current = pieces }, [pieces])
  const layOutRef = useRef(takeoffTotals.layOut)
  layOutRef.current = takeoffTotals.layOut

  /*
   * Name the window after the project (Aaron's request).
   *
   * Set from here rather than in Rust because Rust names a window from the id
   * in its URL — a hash — and the readable name only exists once the project
   * has been opened. An estimator picks between two or three bids from the
   * taskbar, and every window reading "REDBEAM — 3f9c1a" made that a guess.
   */
  useEffect(() => {
    // The window is named after the PDF showing, not one live behind it.
    if (!showing) return
    const title = windowTitle(projectName, identity.role === 'context' ? 'context' : 'main')
    document.title = title
    if (!isTauri()) return
    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        await getCurrentWindow().setTitle(title)
      } catch {
        // A window that keeps its old title is a cosmetic loss; failing the
        // render over it would not be.
      }
    })()
  }, [projectName, identity.role, showing])

  // ------------------------------------------------------------- scale ----

  /** Sheets the scale picker is about to write to. Null when it is closed. */
  const [scaleTarget, setScaleTarget] = useState<number[] | null>(null)

  /** A region drawn but not yet given a scale. */
  const [pendingRegion, setPendingRegion] = useState<
    { rect: { x0: number, y0: number, x1: number, y1: number }, pageId: string } | null
  >(null)

  /** Read by the window's Escape handler, for the same reason `pendingCalRef` is. */
  const pendingRegionRef = useRef<typeof pendingRegion>(null)
  pendingRegionRef.current = pendingRegion

  /** Remove a region. Its markups fall back to the page scale, or to nothing. */
  const removeRegion = useCallback(async (id: string) => {
    const db = dbRef.current
    if (db === null) return
    await deleteScaleRegion(db, id)
    await reloadRegions(db)
    setStatus('scale region removed')
    requestPaint()
  }, [reloadRegions, requestPaint])

  /** Save the region the picker was just answered for. */
  const commitRegion = useCallback(async (
    feetPerPoint: number, source: string, label: string,
    // An AI session's own half-made region; the one on screen is left alone.
    own?: NonNullable<typeof pendingRegion>,
  ) => {
    const db = dbRef.current
    const region = own ?? pendingRegion
    if (db === null || region === null) return
    await saveScaleRegion(db, {
      id: `sr-${Math.random().toString(36).slice(2, 10)}`,
      documentId: docIdRef.current,
      pageId: region.pageId,
      label,
      x0: region.rect.x0,
      y0: region.rect.y0,
      x1: region.rect.x1,
      y1: region.rect.y1,
      feetPerPdfPoint: feetPerPoint,
      source,
    })
    await reloadRegions(db)
    if (own !== undefined) { requestPaint(); return }
    setPendingRegion(null)
    draftRef.current = emptyDraft('scale-region')
    setStatus(`scale region: ${scaleLabel(feetPerPoint)}`)
    requestPaint()
  }, [pendingRegion, reloadRegions, requestPaint])

  const scaleOfPage = useCallback(
    // `targetPage` rather than `page`: the sheet is an ARGUMENT, so there is no
    // current page for it to be a stale read of. See pageIdentity.test.ts.
    (targetPage: number) =>
      projectCalibrations.get(pageIdFor(docIdRef.current, targetPage)) ?? null,
    [projectCalibrations],
  )

  /**
   * Set one scale across a selection of sheets (plan 14.4).
   *
   * A stated scale needs no measuring — a plotted sheet is at true size, so
   * `1/8" = 1'-0"` IS a feet-per-point — which is why this can cover a whole
   * 400-series while the reference-line tool cannot.
   *
   * The write is one transaction in the store. Half a selection carrying a new
   * scale and half carrying the old one is a set where some sheets measure and
   * some do not, with nothing on screen saying which.
   */
  const applyScaleToSelection = useCallback(async (
    pages: number[], feetPerPoint: number, source: string,
  ) => {
    const db = dbRef.current
    if (db === null || pages.length === 0) return
    const documentId = docIdRef.current
    await ensurePageRowsRef.current(pages)
    await applyScaleToPages(
      db,
      pages.map((targetPage) => ({ documentId, pageId: pageIdFor(documentId, targetPage) })),
      feetPerPoint,
      source,
    )
    // Re-read rather than patching the map by hand: the roll-up measures every
    // page from this, and a stale entry is a wrong quantity.
    setProjectCalibrations(await listAllCalibrations(db))
    // The open sheet's own calibration drives the status line and the tools.
    if (pages.includes(pageIndexRef.current)) {
      setCal({ feetPerPoint, pageWidth: page.width, pageHeight: page.height })
    }
    setStatus(pages.length === 1
      ? `scale set: ${scaleLabel(feetPerPoint)}`
      : `scale set on ${pages.length} sheets: ${scaleLabel(feetPerPoint)}`)
    setScaleTarget(null)
    saveRef.current()
    requestPaint()
  }, [page.width, page.height, requestPaint])

  /**
   * Markups on the drawing that is open, which is what the write-back writes.
   *
   * Counted from `projectMarkups` rather than `docMarkups`, because the latter
   * holds only the open PAGE and the export covers every sheet in the file.
   */
  const markupsOnOpenDrawing = useMemo(
    () => projectMarkups.filter((m) => m.documentId === activeDocId).length,
    [projectMarkups, activeDocId],
  )

  /**
   * Save the open drawing with its markups on it (plan 10.3).
   *
   * The quantities and the report already leave the app; this is the half a
   * spreadsheet cannot carry — the sheet somebody argues about later.
   */
  /**
   * A big drawing's marked-up copy, made without reading the drawing whole
   * (rangedPdf.ts): the markups are an update appended to a copy of the file.
   * `dest` null asks where with a Save As. Null for a drawing small enough to
   * read whole.
   */
  const rangedMarked = useCallback(async (
    relativePath: string,
    dest: { kind: 'path'; path: string; overwrite: boolean } | null,
    onWritten?: (path: string | null) => void,
  ): Promise<RangedMarkedPdf | null> => {
    const big = await openRanged(projectBridge, projectPath, relativePath)
    if (big === null) return null
    return {
      markedTail: (markups, options) => big.markedTail(markups, options),
      async saveCopy(fileName, tail) {
        const path = await big.copyTo(dest ?? { kind: 'dialog', defaultName: fileName, filter: { name: 'PDF drawing', extensions: ['pdf'] } }, tail)
        onWritten?.(path)
        if (dest === null) setStatus(saveOutcomeText({ path, downloaded: false }, 'marked-up PDF'))
      },
      release: () => big.release(),
    }
  }, [projectPath, setStatus])
  const exportMarkedDrawing = useCallback(async (
    /** An AI app's chosen path: written there instead of asking (round 3 #15). */
    target?: { path: string; overwrite: boolean },
  ): Promise<string | null> => {
    const doc = documents.find((d) => d.id === activeDocId)
    if (doc === undefined) return 'No drawing is open.'
    if (target !== undefined) {
      let written: Promise<string> | null = null
      const problem = await exportMarkedPdf({
        documentId: doc.id,
        documentName: doc.displayName || doc.relativePath,
        markups: projectMarkups,
        scopes,
        calibrations: projectCalibrations,
        pageBoxes: projectPageBoxes,
        readBytes: () => projectBridge.readDocument(projectPath, doc.relativePath),
        ranged: () => rangedMarked(doc.relativePath, { kind: 'path', path: target.path, overwrite: target.overwrite }, (path) => {
          written = Promise.resolve(path ?? target.path)
        }),
        save: (_fileName, bytes) => {
          written = projectBridge.writeExport === undefined
            ? Promise.reject(new Error('this build cannot write files'))
            : projectBridge.writeExport(target.path, bytes, target.overwrite)
        },
      })
      if (problem !== null) return problem
      if (written === null) return 'nothing was written'
      try { await written } catch (err) { return err instanceof Error ? err.message : String(err) }
      return null
    }
    return exportMarkedPdf({
      documentId: doc.id,
      documentName: doc.displayName || doc.relativePath,
      markups: projectMarkups,
      scopes,
      calibrations: projectCalibrations,
      pageBoxes: projectPageBoxes,
      readBytes: () => projectBridge.readDocument(projectPath, doc.relativePath),
      ranged: () => rangedMarked(doc.relativePath, null),
      // A native Save As on the desktop; the downloader only in the browser.
      save: (fileName, bytes) => {
        void saveFile(bytes, {
          name: fileName, type: 'application/pdf', filter: { name: 'PDF drawing', extensions: ['pdf'] },
        }).then((o) => setStatus(saveOutcomeText(o, 'marked-up PDF')))
      },
    })
  }, [
    documents, activeDocId, projectMarkups, scopes,
    projectCalibrations, projectPageBoxes, projectPath, rangedMarked,
  ])

  useEffect(() => { activeScopeRef.current = activeScope }, [activeScope])
  useEffect(() => { calRef.current = cal }, [cal])


  useEffect(() => { openEstimateIdRef.current = openEstimateId }, [openEstimateId])


  /**
   * Pull the document's outline and page labels once it has booted.
   *
   * `requestIndex` de-duplicates: calling it twice returns the same in-flight
   * promise, so React's development double-invoke does not queue two walks of
   * the bookmark tree. The failure path sets `none` rather than surfacing an
   * error, because an unbookmarked PDF is ordinary and the sheet index falls
   * back to page labels without it.
   */
  useEffect(() => {
    const v = viewerRef.current
    if (!v || pageCount === 0) return
    let cancelled = false
    void v.requestIndex().then((ix) => {
      if (cancelled) return
      setDocIndex({ outline: ix.outline, labels: [...ix.labels], shape: ix.shape })
    }).catch(() => {
      if (!cancelled) setDocIndex({ outline: [], labels: [], shape: 'none' })
    })
    return () => { cancelled = true }
  }, [activeDocId, pageCount])

  /**
   * Load the project's bidding rounds and, for whichever is open, the scopes
   * and drawings it owns.
   *
   * The contributing-file set is DERIVED from accepted markups on every read
   * rather than stored — a document leaves the estimate the moment its last
   * markup does, and a cached list would keep claiming a drawing nobody
   * measures any more.
   */
  const refreshEstimates = useCallback(async (openId?: string | null) => {
    const db = dbRef.current
    if (!db) return
    applyEstimates(await loadEstimates(db, openId === undefined ? openEstimateIdRef.current : openId))
  }, [applyEstimates])

  const createEstimate = useCallback(async (name: string) => {
    const db = dbRef.current
    if (!db || !requireProject()) return
    const id = `estimate-${crypto.randomUUID()}`
    await createEstimateRow(db, id, name)
    saveRef.current?.()
    await refreshEstimates(id)
    setOpenEstimateId(id)
    void broadcastChange('estimates', identity.projectId ?? 'default')
  }, [refreshEstimates, identity.projectId])

  /**
   * Open the first bidding round automatically.
   *
   * Migration 006 adopts any pre-estimate scopes into an initial round, so a
   * real project always has one; landing on a one-row list to click through
   * would be a step with nothing in it. A project with several rounds still
   * opens the most recent, which is the one being worked.
   */
  useEffect(() => {
    if (backend === null) return
    void refreshEstimates(openEstimateIdRef.current)
    // Not on the markup count: every markup change comes through
    // `syncMarkups`, which reloads the round in the same render.
  }, [backend, refreshEstimates, scopes.length])

  /*
   * Once. This re-ran whenever `openEstimateId` went back to null, so the
   * "Estimates" breadcrumb reopened the first round on the next render and
   * the list of rounds could not be reached at all. Aaron: "Why can't I go
   * back to the root estimates page?" The automatic open is for landing, not
   * for every time the list is asked for.
   */
  const autoOpenedRound = useRef(false)
  useEffect(() => {
    if (autoOpenedRound.current) return
    if (openEstimateId === null && estimates.length > 0) {
      autoOpenedRound.current = true
      setOpenEstimateId(estimates[0]!.id)
      void refreshEstimates(estimates[0]!.id)
    }
  }, [estimates, openEstimateId, refreshEstimates])


  /**
   * Whose undo a command belongs on: the person's, or one AI session's.
   *
   * Read from the command, not from "is an agent call running": the person
   * keeps drawing while an agent's call waits on the sheet, and a flag set
   * for the length of that call would put their work on the agent's undo.
   * Agent handlers build their commands with origin 'agent'; only one agent
   * call runs in a PDF at a time (agents/router.ts), so the session is the
   * one whose call is in flight.
   */
  const undoActor = useCallback((by: 'user' | 'agent'): string => (
    by === 'agent' ? (agentCtxRef.current.agent?.id ?? 'agent') : UNDO_PERSON
  ), [])

  /**
   * The person's last command, to notice an undo straight after it: the
   * action did not do what they expected (an "undo-soon" signal).
   */
  const lastPersonCmdRef = useRef<{ op: string, at: number } | null>(null)
  /** Run an undoable command, then resync and persist. */
  const runCommand = useCallback(async (cmd: Parameters<UndoStack['run']>[0], by?: 'user' | 'agent'): Promise<boolean> => {
    const u = undoRef.current
    if (!u) return false
    const actor = undoActor(by ?? (cmd.record.origin === 'user' ? 'user' : 'agent'))
    /*
     * A write that fails has to say so. Every caller fires this with `void`,
     * so a rejection here went nowhere: a batch delete the core refused left
     * the markups on the sheet with no word about why, which reads exactly
     * like the button doing nothing.
     */
    try {
      await u.run(cmd, actor)
    } catch (err) {
      signal('command', `failed:${cmd.record.op}`, err instanceof Error ? err.message : String(err))
      setStatus(`could not ${cmd.label}: ${err instanceof Error ? err.message : String(err)}`)
      await syncMarkups()
      return false
    }
    if (actor === UNDO_PERSON) lastPersonCmdRef.current = { op: cmd.record.op, at: performance.now() }
    // WITH the resync, not before it: set first, the undo state was a whole
    // render of its own ahead of the markups it describes.
    let undoShown = false
    try {
      await syncMarkups(() => { undoShown = true; setUndoState(u.state) })
    } finally {
      if (!undoShown) setUndoState(u.state)
    }
    saveRef.current()
    // Tell the other windows on this project. No-op outside Tauri.
    void broadcastChange('markups', identity.projectId ?? 'default')
    return true
  }, [syncMarkups, identity.projectId, undoActor])

  const doUndo = useCallback(async (by: 'user' | 'agent' = 'user'): Promise<{ label: string; op: string } | { error: string } | null> => {
    const db = dbRef.current, u = undoRef.current
    if (!db || !u) return null
    let cmd: Awaited<ReturnType<UndoStack['undo']>>
    // The core refuses an undo that would overwrite newer work, and says why
    // in words written to be shown. Unhandled, that reason was lost.
    try { cmd = await u.undo(undoActor(by)) } catch (err) {
      // An agent is told in its answer; the status line is the person's.
      if (by === 'user') setStatus(err instanceof Error ? err.message : String(err))
      setUndoState(await u.fetchState().catch(() => u.state))
      return { error: err instanceof Error ? err.message : String(err) }
    }
    if (!cmd) return null
    const c0 = await getCalibration(db, pageIdFor(docIdRef.current, pageIndexRef.current))
    if (by === 'agent') {
      // An agent taking back its own work: the person's selection and status stay theirs.
      await syncMarkups(() => {
        setUndoState(u.state)
        setCal(c0 ? { feetPerPoint: c0.feetPerPdfPoint, pageWidth: page.width, pageHeight: page.height } : null)
      })
      saveRef.current()
      return { label: cmd.label, op: cmd.op }
    }
    const last = lastPersonCmdRef.current
    lastPersonCmdRef.current = null
    if (last !== null && last.op === cmd.op && performance.now() - last.at < UNDO_SOON_MS) {
      signal('friction', 'undo-soon', cmd.op, performance.now() - last.at)
    }
    selectedRef.current = []
    // Read first, then set with the markups: one render for the undo, not three.
    const c = await getCalibration(db, pageIdFor(docIdRef.current, pageIndexRef.current))
    await syncMarkups(() => {
      setUndoState(u.state)
      setSelectedIds([])
      setCal(c ? { feetPerPoint: c.feetPerPdfPoint, pageWidth: page.width, pageHeight: page.height } : null)
      setStatus(`undid ${cmd.label}`)
    })
    saveRef.current()
    return { label: cmd.label, op: cmd.op }
  }, [syncMarkups, page.width, page.height, undoActor])

  const doRedo = useCallback(async (by: 'user' | 'agent' = 'user'): Promise<{ label: string; op: string } | { error: string } | null> => {
    const db = dbRef.current, u = undoRef.current
    if (!db || !u) return null
    let cmd: Awaited<ReturnType<UndoStack['redo']>>
    try { cmd = await u.redo(undoActor(by)) } catch (err) {
      if (by === 'user') setStatus(err instanceof Error ? err.message : String(err))
      setUndoState(await u.fetchState().catch(() => u.state))
      return { error: err instanceof Error ? err.message : String(err) }
    }
    if (!cmd) return null
    const c = await getCalibration(db, pageIdFor(docIdRef.current, pageIndexRef.current))
    await syncMarkups(() => {
      setUndoState(u.state)
      setCal(c ? { feetPerPoint: c.feetPerPdfPoint, pageWidth: page.width, pageHeight: page.height } : null)
      if (by === 'user') setStatus(`redid ${cmd.label}`)
    })
    saveRef.current()
    return { label: cmd.label, op: cmd.op }
  }, [syncMarkups, page.width, page.height, undoActor])


  // Another window on this project changed something: reload from the store.
  // The core is the single source of truth, so re-reading is both correct and
  // cheap enough at these row counts.
  useEffect(() => {
    if (page.width === 0) return
    let stop: (() => void) | undefined
    let cancelled = false
    void onChange(
      () => {
        void (async () => {
          const db = dbRef.current
          if (!db) return
          await syncMarkups()
          const c = await getCalibration(db, pageIdFor(docIdRef.current, pageIndexRef.current))
          setCal(c ? { feetPerPoint: c.feetPerPdfPoint, pageWidth: page.width, pageHeight: page.height } : null)
          setStatus('updated from another window')
        })()
      },
      { projectId: identity.projectId ?? 'default' },
    ).then((un) => {
      if (cancelled) un()
      else stop = un
    })
    return () => {
      cancelled = true
      stop?.()
    }
  }, [identity.projectId, syncMarkups, page.width, page.height])

  /**
   * Abandon whatever is being drawn and drop any selection.
   *
   * Bound to Escape AND to right-click. Right-click is what an estimator's
   * hands already do to back out of a tool — every drawing application they
   * use works that way — and in this one it used to open the WebView's own
   * "Save image as / Inspect" menu over the sheet, which is the browser
   * showing through the app.
   */
  const cancelDraft = useCallback(() => {
    selectAnnots([])
    stopAutoPan()
    hitHighlightRef.current = null
    // The snap marker was cleared only when an edit's pointer went up, so a
    // right-click out of a tool left it painted at a fixed spot on screen
    // until the next tool was picked. Aaron: "a persistent shape I can't
    // get rid of."
    snapRef.current = null
    hoverRef.current = null
    // A circle stays armed through Escape: it is the tool's mode, not the draft.
    draftRef.current = draftRef.current.mode === 'circle' ? { ...emptyDraft(draftRef.current.tool), mode: 'circle' } : emptyDraft(draftRef.current.tool)
    if (draftRef.current.mode !== 'circle') setSegMode('line')
    setSegTick((n) => n + 1)
    // The dimension keeps its own draft, and Escape left its first point
    // standing: the next click closed a dimension nobody was drawing.
    dimensionDraftRef.current = emptyDimensionDraft(dimensionDraftRef.current.ortho)
    noteDraftRef.current = emptyNoteDraft(noteDraftRef.current.shape)
    noteDownAtRef.current = null
    setSelectedIds([])
    selectedRef.current = []
    requestPaint()
  }, [requestPaint, stopAutoPan])

  // ------------------------------------------------------------ committing --
  const commitDraft = useCallback(async () => {
    const db = dbRef.current
    // An arc half placed on Enter closes the area with it (tools/curves.ts).
    const d = CURVE_TOOLS.has(draftRef.current.tool)
      ? finishCurve(draftRef.current, { width: page.width, height: page.height })
      : draftRef.current
    if (!db || !isCommittable(d) || page.width === 0) return
    // A circle stays armed for the next one; an arc was one segment.
    const next = (): DraftState => (d.mode === 'circle' ? { ...emptyDraft(d.tool), mode: 'circle' } : emptyDraft(d.tool))
    if (d.mode !== 'circle') setSegMode('line')

    // A link's box is drawn; where it goes is asked next (LinkPicker).
    if (d.tool === 'link') {
      draftRef.current = { ...d, cursor: null }
      openLinkPickerRef.current(d.points)
      requestPaint()
      return
    }

    if (d.tool === 'direction') {
      // Not a markup: the orientation belongs to the SCOPE, not the page. Two
      // scopes on one sheet routinely run different ways, and storing it per
      // page would make that unrepresentable.
      const [a, b] = d.points
      /*
       * `scopesRef`, not `scopes`.
       *
       * This read the STATE while `scopes` was missing from the dependency
       * array below, so the callback closed over the scope list from an
       * earlier render — and then wrote `{...sc.specifications}` back. Setting
       * an orientation therefore RESTORED whatever the specification looked
       * like when the closure was made, silently discarding every measure
       * typed since: spacing, reveal, rail length, rail spacing. The user saw
       * fields they had filled in emptying themselves for no reason, and the
       * piece count that depended on them never arrived.
       *
       * A merge is only as good as the thing it merges into. Every write path
       * in this file reads its base through a ref for exactly this reason.
       */
      const sc = scopesRef.current.find((x) => x.id === activeScope)
      if (!a || !b || !sc) return
      if (a.x === b.x && a.y === b.y) {
        setStatus('direction needs two different points')
        draftRef.current = emptyDraft('direction')
        requestPaint()
        return
      }
      await saveScope({
        ...sc,
        specifications: {
          ...sc.specifications,
          // Same stale-closure trap as the markup write below: the ref is the
          // only thing that knows which page this actually happened on.
          scopeDefaultDirection: { sourcePage: pageIndexRef.current, x1: a.x, y1: a.y, x2: b.x, y2: b.y },
        },
      })
      setStatus(`orientation set for ${sc.label}`)
      draftRef.current = emptyDraft('direction')
      requestPaint()
      return
    }

    if (d.tool === 'calibrate') {
      // hand off to the inline form; the draft stays on screen behind it,
      // WITHOUT its rubber band: the line is finished, and a band from its
      // second point to the cursor read as a request for a third.
      draftRef.current = { ...d, cursor: null }
      const length = draftLengthPdfPoints(d, page.width, page.height)
      // Eagerly, so the very next click is already refused (see onPointerDown).
      pendingCalRef.current = length
      setPendingCal(length)
      setCalError(null)
      requestPaint()
      return
    }

    /*
     * A scale region: the box is drawn, then the scale is chosen for it.
     *
     * Deliberately the same two-step as calibrate — geometry first, meaning
     * second — because the box on its own is not a measurement of anything and
     * committing it without a scale would leave a rectangle on the sheet that
     * silently governs nothing.
     */
    if (d.tool === 'scale-region') {
      const a = d.points[0]!
      const b = d.points[1]!
      const pending = {
        rect: { x0: a.x, y0: a.y, x1: b.x, y1: b.y },
        // The ref, not the state: by the time the picker is answered the
        // person may well have paged away, and the region belongs to the sheet
        // it was drawn on.
        pageId: pageIdFor(docIdRef.current, pageIndexRef.current),
      }
      pendingRegionRef.current = pending
      setPendingRegion(pending)
      return
    }

    const kind: Markup['kind'] =
      d.tool === 'area' ? 'area'
      : d.tool === 'cutout' ? 'cutout'
      : d.tool === 'shape' ? 'shape'
      : d.tool === 'polyline' ? 'polyline'
      : 'count'
    /*
     * The cutter cuts the areas themselves. Aaron, 2026-11-19: "The cutter
     * should make a boolean edit to the markup itself. It shouldn't be
     * treated as a separate markup." Every area on the sheet it changes is
     * cut, as one undo step; the cut is then one cutout to select or delete.
     */
    if (kind === 'cutout') {
      const pageId = pageIdFor(docIdRef.current, pageIndexRef.current)
      const edits = cutEdits(markupsRef.current, pageId, d.points)
      draftRef.current = next()
      if (edits.length === 0) {
        setStatus('the cutout crosses no area on this sheet, so nothing was cut')
        requestPaint()
        return
      }
      const cmd = editsCommand(edits, edits.length === 1 ? 'cut area' : `cut ${edits.length} areas`)
      if (cmd !== null && await runCommand(cmd)) {
        setStatus(edits.length === 1 ? 'cut the area' : `cut ${edits.length} areas`)
      }
      requestPaint()
      return
    }
    const rings = kind === 'count' ? d.points.map((p) => [p]) : [d.points]
    /*
     * `pageIndexRef`, not `pageIndex`.
     *
     * This read the STATE while `pageIndex` was missing from the dependency
     * array below, so the callback closed over the page index from first
     * render and never saw another. Every markup drawn on any page was written
     * to page 1, silently and forever — the geometry was correct, the sheet it
     * was filed under was not, and nothing anywhere reported an error.
     *
     * The refs exist precisely so a write cannot be wrong about where it is
     * going; every other write path in this file already uses them.
     */
    const cmds = rings.map((ring) => cmdCreate({
      id: uid(),
      documentId: docIdRef.current,
      pageId: pageIdFor(docIdRef.current, pageIndexRef.current),
      scopeId: activeScope,
      kind, rings: [ring], origin: 'user', reviewState: 'accepted',
    }))
    await runCommand(cmds.length === 1 ? cmds[0]! : cmdBatch(`create ${cmds.length} ${kind}`, cmds))
    draftRef.current = next()
    setSegTick((n) => n + 1)
    requestPaint()
  }, [activeScope, page.width, page.height, requestPaint])

  /**
   * Persist a calibration AND update the view of it.
   *
   * One function because there are now two entry points — the calibrate tool
   * and the automation bridge — and the second one shipped without the
   * `setCal` the first one does. The row landed in the database and the app
   * went on reporting itself uncalibrated with empty quantities, which is a
   * silent wrong answer rather than a visible failure.
   */
  const commitCalibration = useCallback(async (
    built: Calibration,
    source: string,
    // Undo depth counts only `user` entries so Ctrl+Z steps past agent work.
    // An agent calibration logged as `user` would make the estimator's next
    // undo revert something they never did.
    origin: string = 'user',
    // A session's own sheet, which may not be the one showing.
    targetPage: number = pageIndexRef.current,
  ) => {
    const showing = targetPage === pageIndexRef.current
    const pageId = pageIdFor(docIdRef.current, targetPage)
    await runCommand(cmdCalibrate(
      docIdRef.current,
      pageId,
      showing ? (cal?.feetPerPoint ?? null) : (projectCalibrationsLatest.current.get(pageId) ?? null),
      built.feetPerPoint,
      source,
      origin,
    ))
    if (showing) setCal(built)
    setStatus(`calibrated: 1 pt = ${built.feetPerPoint.toFixed(6)} ft`)
    saveRef.current()
    requestPaint()
  }, [cal, runCommand, requestPaint])

  const applyCalibration = useCallback(async (raw: string, unit: string) => {
    const db = dbRef.current
    if (!db || pendingCal === null) return
    // 20'-6" carries its unit; a bare number takes the dropdown's.
    const parsed = parseLengthInput(raw, isLengthUnit(unit) ? unit : 'ft')
    if (parsed === null) { setCalError(`can't read "${raw}"`); return }
    const built = calibrationFromReference(pendingCal, parsed.value, parsed.unit, page.width, page.height)
    if (!built) { setCalError(`unknown unit "${unit}"`); return }
    await commitCalibration(built, 'reference-line')
    setPendingCal(null)
    setCalError(null)
    draftRef.current = emptyDraft('calibrate')
    /*
     * The tool goes DOWN. It stayed armed after the answer, so the next click
     * began a second line, which read as the sheet asking for a third point.
     * Kenneth: "scope calibration should only be two points and then stop."
     */
    setTool('pan')
  }, [pendingCal, page.width, page.height, commitCalibration])

  const cancelCalibration = useCallback(() => {
    signal('friction', 'abandon:calibration')
    setPendingCal(null)
    setCalError(null)
    draftRef.current = emptyDraft('calibrate')
    requestPaint()
  }, [requestPaint])

  /*
   * Beside `cancelCalibration` rather than beside the region drawing it
   * belongs to, because the window's Escape handler needs both and is declared
   * between the two. Referencing it from there while it lived below would put
   * it in the effect's dependency array before its own initializer ran.
   */
  const cancelRegion = useCallback(() => {
    signal('friction', 'abandon:scale-region')
    setPendingRegion(null)
    draftRef.current = emptyDraft('scale-region')
    requestPaint()
  }, [requestPaint])

  /** The markups behind these ids, on this sheet or anywhere in the project. */
  /**
   * Accept imported markups (pending, from the PDF) into the takeoff, so they
   * count. Returns how many were pending. Not an undo step: a markup accepted
   * by mistake is given no scope, which counts it nowhere, or deleted.
   */
  const acceptImported = useCallback(async (ids: readonly string[]): Promise<number> => {
    const db = dbRef.current
    const pending = ids.filter((id) => pendingIdsRef.current.has(id))
    if (db === null || pending.length === 0) return 0
    const now = new Date().toISOString()
    for (const id of pending) {
      await db.run("UPDATE markups SET review_state = 'accepted', updated_at = ? WHERE id = ? AND review_state = 'proposed'", [now, id])
    }
    await syncMarkups()
    saveRef.current?.()
    return pending.length
  }, [syncMarkups])

  const markupsFor = useCallback(
    (ids: readonly string[]) => resolveMarkups(ids.filter((id) => !isCutId(id)), markupsRef.current, projectMarkupsRef.current),
    [],
  )

  /** Drop ids from the selection, for markups that no longer exist. */
  const deselect = useCallback((ids: readonly string[]) => {
    const gone = new Set(ids)
    const next = selectedRef.current.filter((id) => !gone.has(id))
    if (next.length === selectedRef.current.length) return
    setSelectedIds(next); selectedRef.current = next
    requestPaint()
  }, [requestPaint])

  /**
   * Delete markups, as one undo step: deleting six and pressing Ctrl+Z six
   * times to get them back is not undo, it is punishment. Any sheet, any
   * drawing: the sidebar's list reaches past the open sheet, and this used to
   * look only at the open sheet, so a delete from the list did nothing.
   */
  const removeMarkups = useCallback(async (ids: readonly string[]) => {
    const present = markupsFor(ids)
    /*
     * A cutout is not a row: it is a hole in one area, and deleting it takes
     * that ring out of that area alone (Aaron, 2026-11-19: "delete Boolean
     * value per markup"). An area deleted in the same gesture is simply
     * deleted.
     */
    const goneIds = new Set(present.map((m) => m.id))
    const everywhere = [...markupsRef.current.filter((m) => !isCutId(m.id)), ...projectMarkupsRef.current.filter((m) => !markupsRef.current.some((x) => x.id === m.id))]
    const cuts = ids.filter((id) => isCutId(id) && cutOwner(everywhere, id) !== undefined)
    const uncut: GeometryEdit[] = uncutAllEdits(everywhere, cuts, goneIds)
    const parts = [
      ...(uncut.length === 0 ? [] : [editsCommand(uncut, 'delete cutout')!]),
      ...(present.length === 0 ? [] : [deleteMarkupsCommand(present)].filter((c): c is NonNullable<typeof c> => c !== null)),
    ]
    if (parts.length === 0) return
    const cmd = parts.length === 1 ? parts[0]! : cmdBatch(`delete ${present.length + cuts.length} markups`, parts)
    deselect([...present.map((m) => m.id), ...cuts])
    if (await runCommand(cmd)) {
      const n = present.length + cuts.length
      setStatus(cuts.length > 0 && present.length === 0
        ? (cuts.length === 1 ? 'removed the cutout from its area' : `removed ${cuts.length} cutouts`)
        : n === 1 ? 'deleted 1 markup' : `deleted ${n} markups`)
    }
  }, [runCommand, markupsFor, deselect])

  /**
   * Copy the selection, to a clipboard every tab of the window shares, so it
   * pastes into another open PDF too. Ids are minted fresh on paste.
   */
  const copySelection = useCallback(() => {
    const ids = new Set(selectedRef.current)
    // Another app's markup held in place is that app's annotation: there is
    // no second one to paste.
    const picked = markupsRef.current.filter((m) => ids.has(m.id) && !isCutId(m.id) && m.kind !== 'annot')
    if (picked.length === 0) return
    const size = pageSizeRef.current
    if (size.width <= 0 || size.height <= 0) return
    const docId = docIdRef.current
    writeClip(clipOf(picked, [...scopesRef.current, ...archivedScopesRef.current], {
      documentId: docId, pageId: pageIdFor(docId, pageIndexRef.current), width: size.width, height: size.height,
    }))
    setStatus(`copied ${picked.length} markup${picked.length === 1 ? '' : 's'}`)
  }, [])

  /** Make the scopes a paste from another PDF needs. Set once the round helpers exist, below. */
  const addPastedScopesRef = useRef<(scopes: Scope[]) => Promise<void>>(async () => {})

  /**
   * Paste onto the CURRENT page.
   *
   * Pasting onto the current page rather than the source page is the point:
   * the same detail repeats across sheets, and re-tracing it on each one is the
   * work this is meant to remove. From another sheet or another PDF it lands
   * where it was on its own sheet; onto the sheet it came from, or pasted again
   * onto the same sheet, it steps down and right so each copy is visibly distinct. From another PDF, each markup goes to the
   * scope of the same name here, made when this file has none.
   */
  const pasteClipboard = useCallback(async () => {
    const clip = readClip()
    if (clip === null || clip.items.length === 0) return
    const size = pageSizeRef.current
    if (size.width <= 0 || size.height <= 0) return
    const docId = docIdRef.current
    const pageId = pageIdFor(docId, pageIndexRef.current)
    const plan = planPaste(clip, { documentId: docId, pageId, width: size.width, height: size.height },
      scopesRef.current, () => newScope('', []).id, (taken) => nextScopeColor(taken))
    if (plan.newScopes.length > 0) await addPastedScopesRef.current(plan.newScopes)
    const created: string[] = []
    const cmds = plan.markups.map((m) => {
      const id = uid()
      created.push(id)
      return cmdCreate({
        id, documentId: docId, pageId, scopeId: m.scopeId,
        kind: m.kind as MarkupKind, rings: m.rings, origin: 'user', reviewState: 'accepted',
        ...(m.content !== undefined ? { content: m.content } : {}),
      })
    })
    if (!await runCommand(cmds.length === 1 ? cmds[0]! : cmdBatch(`paste ${cmds.length} markups`, cmds))) return
    notePaste(clip, { documentId: docId, pageId })
    setSelectedIds(created); selectedRef.current = created
    setStatus(pasteStatus(plan, clip.documentId !== docId))
  }, [runCommand])

  /** Recolour other apps' markups held in place, as one undo step (tools/heldAnnots.ts). */
  const recolorHeld = useCallback(async (picked: readonly Markup[], hex: string) => {
    const cmds = picked
      .filter((m) => m.kind === 'annot' && heldColorOf(m) !== hex)
      .map((m) => cmdEditAnnotColor(m.id, heldColorOf(m), hex, { documentId: m.documentId, pageId: m.pageId }))
    if (cmds.length === 0) return
    if (await runCommand(cmds.length === 1 ? cmds[0]! : cmdBatch(`recolour ${cmds.length} markups`, cmds))) {
      setStatus(`recoloured ${cmds.length} markup${cmds.length === 1 ? '' : 's'}`)
    }
  }, [runCommand])

  /** Move markups to another scope (or none), as one undo step. Any sheet, any drawing. */
  const reassignMarkups = useCallback(async (ids: readonly string[], scopeId: string | null) => {
    const present = markupsFor(ids).filter((m) => m.kind !== 'annot')
    const cmd = rescopeMarkupsCommand(present, scopeId)
    if (cmd === null) return
    const moved = present.filter((m) => m.scopeId !== scopeId).length
    if (await runCommand(cmd)) {
      const to = scopeId === null ? 'no scope' : (scopesRef.current.find((sc) => sc.id === scopeId)?.label ?? 'scope')
      // Giving an imported markup a scope is accepting it into the takeoff.
      const accepted = scopeId === null ? 0 : await acceptImported(present.map((m) => m.id))
      setStatus(`moved ${moved} markup${moved === 1 ? '' : 's'} to ${to}`
        + (accepted > 0 ? `, ${accepted} imported markup${accepted === 1 ? '' : 's'} accepted` : ''))
    }
  }, [runCommand, markupsFor, acceptImported])

  /** Move every selected markup to another scope, as one undo step. */
  const reassignSelection = useCallback(
    (scopeId: string | null) => reassignMarkups(selectedRef.current, scopeId),
    [reassignMarkups],
  )

  /**
   * Copy markups in place, each on its own sheet and in its own scope, as one
   * undo step, and select the copies. The canvas's Ctrl+D and the list's
   * Duplicate both land here.
   */
  const duplicateMarkups = useCallback(async (ids: readonly string[]) => {
    const present = markupsFor(ids).filter((m) => m.kind !== 'annot')
    const { command, ids: made } = duplicateMarkupsCommand(present, uid)
    if (command === null) return
    if (await runCommand(command)) {
      setSelectedIds(made); selectedRef.current = made
      setStatus(`duplicated ${made.length} markup${made.length === 1 ? '' : 's'}`)
      requestPaint()
    }
  }, [runCommand, markupsFor, requestPaint])

  const removeMarkup = useCallback(async (id: string, by: 'user' | 'agent' = 'user') => {
    // Any sheet's markup: an agent deletes on sheets that are not showing.
    const m = docMarkupsRef.current.find((x) => x.id === id) ?? markupsRef.current.find((x) => x.id === id)
    if (!m) return
    if (isCutId(id)) {
      const cmd = editsCommand(uncutEdits(markupsRef.current, id), 'delete cutout')
      if (cmd !== null) await runCommand(cmd, by)
      return
    }
    await runCommand(cmdRemove({ id, kind: m.kind, origin: by }), by)
  }, [runCommand])

  // ------------------------------------------------------------- interaction --
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The window's keys belong to the PDF showing.
      if (!showingRef.current) return
      shiftRef.current = e.shiftKey
      altRef.current = e.altKey
      const d = draftRef.current
      const mod = e.ctrlKey || e.metaKey

      /*
       * A key pressed into a text field belongs to the text field.
       *
       * This listener is on `window` and had no such check, so every shortcut
       * below fired while you were typing — and most of them called
       * preventDefault, which took the keystroke away from the field as well.
       * Typing "area" into the sheet filter switched the tool three times and
       * landed on Cutout. Ctrl+A selected every markup in the document instead
       * of the text you meant to replace; Ctrl+C copied markups over what you
       * had highlighted; Backspace with a trace in progress deleted a point
       * from the trace rather than a character from the field; Enter committed
       * the trace.
       *
       * What survives is what is still about the application rather than the
       * text: Escape, and the two shortcuts that OPEN something (settings and
       * find), which is what a person typing into a stale field is reaching
       * for when they press them.
       */
      if (isTextEntry(e.target) && !survivesTextEntry(e)) return
      if (e.key === ' ' && !mod) {
        // Held, not pressed: the pointer handlers read it. preventDefault so
        // the page does not scroll and a focused button is not "clicked".
        if (!spaceRef.current) {
          spaceRef.current = true
          const el = stageRef.current
          if (el !== null) el.style.cursor = 'grab'
        }
        e.preventDefault()
        return
      }
      // Ctrl+, is the settings shortcut on every platform the Qt build shipped
      // to, and the Qt shell forwards it from a Context Window to its owner.
      if (mod && e.key === ',') { e.preventDefault(); settingsOpen ? setSettingsOpen(false) : openSettings(); return }
      if (mod && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); if (!copyPickedTextRef.current()) copySelection(); return }
      if (mod && (e.key === 'v' || e.key === 'V')) { e.preventDefault(); void pasteClipboard(); return }
      if (mod && (e.key === 'd' || e.key === 'D') && selectedRef.current.length > 0) {
        e.preventDefault(); void duplicateMarkups(selectedRef.current); return
      }
      if (mod && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault()
        const all = markupsRef.current.map((m) => m.id)
        setSelectedIds(all); selectedRef.current = all
        requestPaint()
        return
      }
      if (mod && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        openSearch()
        return
      }
      if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        if (e.shiftKey) void doRedo(); else void doUndo()
        return
      }
      if (mod && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault()
        void doRedo()
        return
      }
      if (e.key === 'Escape') {
        /*
         * A question waiting on a drawn line outranks the line.
         *
         * The pinned entries answer Escape themselves, but only while focus is
         * inside them — and it does not stay there: measuring a reference line
         * and then clicking the sheet to see it better puts focus on the stage.
         * Escape then cleared the line and left "how long is this?" on screen
         * asking about geometry that no longer existed. The next number typed
         * would have calibrated the page against nothing.
         */
        if (pendingCalRef.current !== null) { cancelCalibration(); return }
        if (pendingRegionRef.current !== null) { cancelRegion(); return }
        if (pendingLinkRef.current !== null) { cancelLinkRef.current(); return }
        if (zoomBoxArmedRef.current) { disarmZoomBoxRef.current(); zoomBoxRef.current = null; requestPaint(); return }
        if (titlePickRef.current !== null) { titleBoxRef.current = null; setTitlePick(null); requestPaint(); return }
        if (textPickRef.current !== null) { textPickRef.current = null; requestPaint(); return }
        // The markup menu closed only on a click on its scrim; Escape, the
        // key every menu closes on, left it standing over the sheet.
        setMarkupMenu(null)
        /*
         * Two presses, two meanings. With something half-drawn, Escape
         * abandons it and keeps the tool — the next shape is usually the
         * same kind. With nothing in progress there is nothing to abandon,
         * so Escape puts the tool down and goes back to Pan; a crosshair
         * with no way out is how a stray click draws something. Right-click
         * does the same (see onContextMenu). Aaron asked for both.
         */
        const drawing = draftRef.current.points.length > 0 || draftRef.current.pivot !== undefined || dimensionDraftRef.current.a !== null
          || (isNoteTool(toolRef.current) && noteDraftStarted(noteDraftRef.current))
        if (drawing) signal('friction', `abandon:draw-${toolRef.current}`, draftRef.current.points.length >= 3 ? 'three or more points' : 'under three points')
        cancelDraft()
        if (!drawing && toolRef.current !== 'pan') setTool('pan')
      }
      else if (e.key === 'Delete' && selectedRef.current.length > 0) {
        const ids = selectedRef.current
        setSelectedIds([]); selectedRef.current = []
        void removeMarkups(ids)
      }
      else if (e.key === 'Enter' && isNoteTool(toolRef.current)) { applyNoteStepRef.current(noteFinish(noteDraftRef.current)) }
      else if (e.key === 'Backspace' && isNoteTool(toolRef.current) && noteDraftStarted(noteDraftRef.current)) {
        noteDraftRef.current = noteBack(noteDraftRef.current); requestPaint()
      }
      else if (e.key === 'Enter') { void commitDraft() }
      else if (e.key === 'Backspace' && (d.points.length > 0 || d.pivot !== undefined)) {
        draftRef.current = CURVE_TOOLS.has(d.tool) ? backCurvePoint(d) : { ...d, points: d.points.slice(0, -1) }
        setSegTick((n) => n + 1)
        requestPaint()
      }
      /*
       * Tool shortcuts belong to the DRAWING, and a dialog is not it.
       *
       * Only text entry was excluded, so every unmodified letter still reached
       * the toolbar through Settings, the BOM and the scope editor — arming a
       * tool nobody chose, on a sheet nobody was looking at, to be discovered
       * by the next click drawing something. Escape and the modified
       * shortcuts above are unaffected: those are still about the application.
       */
      else if (toolRef.current === 'dimension' && e.key === 'Backspace') {
        dimensionDraftRef.current = dimensionDraftBack(dimensionDraftRef.current)
        requestPaint()
      }
      else if (e.key === 'F5') { e.preventDefault(); void refreshFiles() }
      else if (dialogOpenRef.current) { /* a dialog owns the keyboard */ }
      else {
        // Left/Right and PgUp/PgDn step the sheets; not mid-trace, where a
        // page change would strand the points (#30).
        const back = historyStepForKey(e.key, e)
        if (back !== null) {
          e.preventDefault()
          if (d.points.length === 0) stepHistoryRef.current(back)
          return
        }
        if ((e.key === 'z' || e.key === 'Z') && !e.ctrlKey && !e.metaKey && !e.altKey) {
          if (d.points.length === 0) armZoomBoxRef.current()
          return
        }
        const step = pageStepForKey(e.key, e)
        if (step !== null) {
          if (d.points.length === 0) { e.preventDefault(); stepPageRef.current(step) }
          return
        }
        // Bare letters only: see toolForKey (#29). Shift-K is the scale
        // region — the other way to set a scale, for a page with several.
        // Mid-trace, A makes the next segment an arc rather than arming Area;
        // Shift+C draws circles in Area, Cutout and Linear (Kenneth #8).
        // toolRef: this listener is made once, and `tool` here would be the one it was made with.
        const curveKey = CURVE_TOOLS.has(toolRef.current) ? curveModeForKey(e.key, e, d) : null
        if (curveKey !== null) { e.preventDefault(); setSegmentModeRef.current(curveKey); return }
        const next = toolForKey(e.key, e)
        if (next !== null) setTool(next)
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (!showingRef.current) return
      shiftRef.current = e.shiftKey
      altRef.current = e.altKey
      if (e.key === ' ') {
        spaceRef.current = false
        const el = stageRef.current
        if (el !== null) el.style.cursor = toolRef.current === 'pan' ? 'grab' : toolRef.current === 'select' ? 'default' : 'crosshair'
      }
    }
    // Alt-tabbing away with space held would leave it held forever.
    const onBlur = () => {
      spaceRef.current = false
      const el = stageRef.current
      if (el !== null) el.style.cursor = toolRef.current === 'pan' ? 'grab' : toolRef.current === 'select' ? 'default' : 'crosshair'
    }
    window.addEventListener('blur', onBlur)
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [commitDraft, requestPaint, removeMarkups, duplicateMarkups, doUndo, doRedo, copySelection, pasteClipboard,
    cancelCalibration, cancelRegion, refreshFiles])

  /*
   * Synced during RENDER, not in an effect.
   *
   * These are "latest value" refs: every write path reads them to decide which
   * page and document a row belongs to. Updating them in an effect means they
   * lag by one effect pass — an effect declared ABOVE this line would still see
   * the previous page on the render where the page changed, which is a subtler
   * version of the stale-closure bug that filed every markup under page 1.
   *
   * Assigning during render is the sanctioned pattern for this: the value is
   * derived from props/state and read only by callbacks and effects, never
   * during rendering itself.
   */
  pageIndexRef.current = pageIndex
  scopesRef.current = scopes
  archivedScopesRef.current = archivedScopes
  // The painter runs outside render and needs both: which regions govern this
  // sheet, and whether the scale tool is in hand (regions dim when it is not).
  regionsRef.current = projectRegions
  toolRef.current = tool
  // Words picked with the Text tool stay highlighted only while it is in hand.
  useEffect(() => { if (tool !== 'select' && textPickRef.current !== null) { textPickRef.current = null; requestPaint() } }, [tool, requestPaint])
  // A rail pane is deliberately NOT in this list, and neither is anything in
  // the estimates panel: they sit beside the drawing rather than over it, so
  // the drawing's shortcuts still belong to the user. What IS in it is every
  // question still waiting for an answer — a length, a region's scale, a
  // selection's scale — because a letter typed at one of those is an answer,
  // not a tool.
  dialogOpenRef.current = settingsOpen || paletteOpen || report !== null
    || pendingCal !== null || pendingRegion !== null || scaleTarget !== null

  /*
   * Scale regions on the sheet being looked at.
   *
   * Below the ref sync deliberately. `pageIndexRef.current` is only the
   * current page AFTER that line has run — a memo declared above it reads the
   * previous page on the render where the page changed, which is the same
   * one-render lag the sibling guard in pageIdentity.test.ts exists to
   * prevent. `pageIndex` stays in the deps so it recomputes.
   */
  const regionsOnThisSheet = useMemo(
    () => projectRegions.get(pageIdFor(docIdRef.current, pageIndexRef.current)) ?? [],
    [projectRegions, pageIndex, activeDocId],
  )
  docMarkupsRef.current = docMarkups
  quantitiesRef.current = quantities
  docIdRef.current = activeDocId ?? FALLBACK_DOC.id
  useEffect(() => {
    markupsRef.current = markups
    // A held markup moved, recoloured, deleted or put back: the viewer's copy
    // follows. Not mid-drag: that redraws the sheet per pointer move, and the
    // selection outline already shows where it is going.
    const v = viewerRef.current
    if (v !== null && editRef.current === null && (heldNmsRef.current.get(docIdRef.current)?.size ?? 0) > 0) hideOwnAnnots(v, pageIndexRef.current)
  }, [markups, hideOwnAnnots])

  // Dev-only inspection hook. Lets a test read the real geometry and calibration
  // instead of inferring them from rendered text. Stripped from production builds.
  useEffect(() => {
    if (import.meta.env.DEV) {
      ;(window as unknown as Record<string, unknown>).__redbeam = {
        markups, cal, scopes, selectedIds,
        page, pageIndex, pageCount, activeDocId, documents, ingestNote,
        projectPageBoxes, projectCalibrations, projectMarkups,
        selectedAnnots, annots: () => annotsRef.current, selectAnnots,
        // Test plumbing: a sheet with no annotations can be given some.
        setAnnots: (list: PageAnnotation[]) => { annotsRef.current = list },
        goToPage,
        viewer: () => viewerRef.current,
        undoState,
        view: () => ({ ...viewRef.current }),
        activity: () => (dbRef.current ? listActivity(dbRef.current, 20) : Promise.resolve([])),
        coverage: () => (dbRef.current ? textIndexCoverage(dbRef.current) : Promise.resolve(null)),
        rawPageText: () => (dbRef.current
          ? dbRef.current.all('SELECT page_id, document_id, length(content) AS n FROM page_text')
          : Promise.resolve([])),
        rawPages: () => (dbRef.current
          ? dbRef.current.all('SELECT id, document_id, page_number FROM pages')
          : Promise.resolve([])),
        indexNow: async () => {
          const db = dbRef.current, v = viewerRef.current
          if (!db || !v) return 'no db/viewer'
          const t = await v.requestText(pageIndexRef.current)
          const pid = pageIdFor(docIdRef.current, pageIndexRef.current)
          await indexPageText(db, { pageId: pid, documentId: docIdRef.current, content: t.text })
          return { pid, docId: docIdRef.current, chars: t.text.length }
        },
        refCount: () => markupsRef.current.length,
        hitAt: (x: number, y: number) =>
          hitTest(x, y, markupsRef.current, viewRef.current, page.width, page.height),
      }
    }
  }, [markups, cal, scopes, selectedIds, page, undoState, pageIndex, pageCount, goToPage, activeDocId, documents, ingestNote, selectedAnnots, selectAnnots])
  useEffect(() => { selectedRef.current = selectedIds }, [selectedIds])

  /*
   * How the next click joins a trace in Area, Cutout and Linear (Kenneth #8).
   * The draft carries it (draftRef.current.mode); this copy is for the bar
   * under the sheet, which has to re-render when it changes.
   */
  const [segMode, setSegMode] = useState<SegmentMode>('line')
  // The bar's caption reads the draft; a click in a curve tool re-renders it.
  const [, setSegTick] = useState(0)
  const setSegmentMode = useCallback((mode: SegmentMode) => {
    const d = draftRef.current
    if (mode === 'circle' && d.points.length > 0) {
      setStatus('finish or clear this outline first; a circle is drawn on its own')
      return
    }
    const { pivot: _drop, ...rest } = d
    draftRef.current = mode === 'line' ? { ...rest, mode } : { ...(mode === d.mode ? d : rest), mode }
    setSegMode(mode)
    requestPaint()
  }, [requestPaint])
  const setSegmentModeRef = useRef(setSegmentMode)
  setSegmentModeRef.current = setSegmentMode

  useEffect(() => {
    draftRef.current = emptyDraft(tool)
    if (isNoteTool(tool)) noteDraftRef.current = emptyNoteDraft(tool)
    noteDownAtRef.current = null
    setSegMode('line')
    snapRef.current = null
    // leaving the pan tool drops the selection; editing only happens with Pan
    if (tool !== 'pan' && tool !== 'select') { setSelectedIds([]); selectedRef.current = []; hoverRef.current = null }
    requestPaint()
  }, [tool, requestPaint])


  /** Screen-space vertices worth snapping to: the live draft plus committed markups. */
  const snapVertices = useCallback((): Array<{ x: number; y: number }> => {
    if (page.width === 0) return []
    const v = viewRef.current
    const out: Array<{ x: number; y: number }> = []
    for (const p of draftRef.current.points) {
      out.push(normalizedToScreen(p.x, p.y, v, page.width, page.height))
    }
    for (const m of markups) {
      for (const ring of m.rings) {
        for (const p of ring) {
          const s = normalizedToScreen(p.x, p.y, v, page.width, page.height)
          // Only what is actually on screen — and "on screen" is the CURRENT
          // viewport, not the 1180x780 the constants assume. On a wider window
          // this was culling snap targets that were plainly visible.
          if (s.x >= -20 && s.y >= -20 && s.x <= v.vw + 20 && s.y <= v.vh + 20) out.push(s)
        }
      }
    }
    return out
  }, [markups, page.width, page.height])

  /**
   * The ends of this sheet's lines, as snap targets (snapAnchors.ts).
   *
   * Built lazily on the first snap that wants it and kept for the sheet;
   * `grid: null` with `done: false` is a request in flight, with `done: true`
   * a sheet whose geometry could not be read, so neither is asked for twice.
   * Lazily rather than on page change because the request only makes sense
   * against a viewer that has booted, and the first pointer move over a
   * rendered sheet is exactly that moment.
   */
  const anchorGridRef = useRef<{ key: string; grid: AnchorGrid | null; done: boolean } | null>(null)
  const ensureAnchors = useCallback((): AnchorGrid | null => {
    const v = viewerRef.current
    if (!v || pageCount === 0) return null
    const key = `${activeDocId}|${pageIndex}`
    const cur = anchorGridRef.current
    if (cur !== null && cur.key === key) return cur.grid
    anchorGridRef.current = { key, grid: null, done: false }
    v.requestGeometry(pageIndex, { maxSegments: 400000 })
      .then((g) => {
        if (anchorGridRef.current?.key === key) anchorGridRef.current = { key, grid: buildAnchorGrid(g.segments), done: true }
      })
      .catch(() => {
        if (anchorGridRef.current?.key === key) anchorGridRef.current = { key, grid: null, done: true }
      })
    return null
  }, [activeDocId, pageIndex, pageCount])

  /** Apply snapping to a raw stage-relative screen point. */
  const applySnap = useCallback((sx: number, sy: number) => {
    const raster = rasterRef.current
    if (!raster) return { x: sx, y: sy, snap: null as SnapResult | null }
    const pts = draftRef.current.points
    const last = pts[pts.length - 1]
    const anchor = last ? normalizedToScreen(last.x, last.y, viewRef.current, page.width, page.height) : null
    const grid = snapToLines ? ensureAnchors() : null
    const res = snapPoint(sx, sy, {
      ...DEFAULT_SNAP,
      // Alt: this point goes exactly where the cursor is.
      enabled: snapOn && !altRef.current,
      toLines: snapToLines,
      raster,
      vertices: snapVertices(),
      anchor,
      ortho: shiftRef.current,
      ...(grid === null ? {} : {
        anchorAt: (px: number, py: number, r: number) => {
          const v = viewRef.current
          const n = screenToNormalized(px, py, v, page.width, page.height)
          // The pixel radius in each axis's normalized units: a wide sheet
          // is not allowed to snap further sideways than up.
          const a = nearestAnchor(grid, n.x, n.y, r / (v.zoom * page.width), r / (v.zoom * page.height))
          return a === null ? null : normalizedToScreen(a.x, a.y, v, page.width, page.height)
        },
      }),
    })
    return { x: res.x, y: res.y, snap: res }
  }, [snapOn, snapToLines, ensureAnchors, snapVertices, page.width, page.height])



  /** Persist an edited ring and refresh state. */
  const commitGeometry = useCallback(async (
    id: string,
    ring: Array<{ x: number; y: number }>,
    before: Array<{ x: number; y: number }> | null,
    what = 'edit markup',
  ) => {
    if (!undoRef.current || !before) return
    if (JSON.stringify(before) === JSON.stringify(ring)) return   // no-op drag
    // A cutout is a hole in one area: reshape it there.
    if (isCutId(id)) {
      const cmd = editsCommand(recutEdits(markupsRef.current, id, before, ring), what)
      if (cmd !== null) await runCommand(cmd)
      return
    }
    // Editing reshapes the outline, rings[0]. An area's other rings are its
    // holes (a converted Bluebeam area, a traced region) and ride along.
    const rest = markupsRef.current.find((m) => m.id === id)?.rings.slice(1) ?? []
    await runCommand(cmdEditGeometry(id, [before, ...rest], [ring, ...rest], what))
  }, [runCommand])

  /** Commit a multi-markup move as a single undoable step. */
  const commitMove = useCallback(async (
    ids: string[],
    origins: Map<string, Array<Array<{ x: number; y: number }>>>,
  ) => {
    const cmds = ids.flatMap((id) => {
      const before = origins.get(id)
      if (isCutId(id)) {
        const cut = markupsRef.current.find((m) => m.id === id)
        const was = before?.[0], now = cut?.rings[0]
        if (cut === undefined || was === undefined || now === undefined) return []
        if (JSON.stringify(was) === JSON.stringify(now)) return []
        return recutEdits(markupsRef.current, id, was, now).map((e) => cmdEditGeometry(e.id, e.before, e.after, 'move cutout'))
      }
      const after = markupsRef.current.find((m) => m.id === id)?.rings
      if (!before || !after || after.length === 0) return []
      if (JSON.stringify(before) === JSON.stringify(after)) return []
      return [cmdEditGeometry(id, before, after, 'move markup')]
    })
    if (cmds.length === 0) return
    await runCommand(cmds.length === 1 ? cmds[0]! : cmdBatch(`move ${cmds.length} markups`, cmds))
  }, [runCommand])

  /** Apply a live (unsaved) ring so dragging feels immediate. */
  const previewGeometry = useCallback((id: string, ring: Array<{ x: number; y: number }>) => {
    if (isCutId(id)) { setMarkups((cur) => previewCut(cur, id, ring)); return }
    setMarkups((cur) => cur.map((m) => (m.id === id ? { ...m, rings: [ring, ...m.rings.slice(1)] } : m)))
  }, [])

  /** A live move: every ring of the markup, holes included, shifts together. */
  const previewMove = useCallback((id: string, dx: number, dy: number) => {
    if (isCutId(id)) {
      setMarkups((cur) => {
        const ring = cur.find((m) => m.id === id)?.rings[0]
        return ring === undefined ? cur : previewCut(cur, id, ring.map((p) => ({ x: p.x + dx, y: p.y + dy })))
      })
      return
    }
    // The area's cuts are its rings and move with it; its cutouts follow.
    setMarkups((cur) => withCutouts(cur.map((m) => (m.id === id
      ? { ...m, rings: m.rings.map((r) => r.map((p) => ({ x: p.x + dx, y: p.y + dy }))) }
      : m))))
  }, [])

  /**
   * Pointers currently down, for pinch.
   *
   * A trackpad pinch arrives as a wheel event with ctrlKey, which onWheel
   * already handles. This is for a genuine two-finger touch on a touchscreen
   * or a pen display, which arrives as two pointers and never as a wheel.
   */
  const pinchRef = useRef<{
    points: Map<number, { x: number; y: number }>
    startDist: number
    startZoom: number
  } | null>(null)

  /**
   * The dimension under the pointer, if any, in the shape `hitTest` answers.
   *
   * `hitTest` knows the takeoff kinds and nothing else, so a committed
   * dimension could not be selected, moved or deleted — the tool that drew
   * it was the only thing that ever touched it. A dimension's own tester
   * answers for it here, after `hitTest` has had first refusal, so the pan
   * tool treats the two alike: its measured points are vertices and its line
   * moves it.
   */
  const hitDimensionAt = (hx: number, hy: number): Hit | null => {
    const dims = markupsRef.current.filter(
      (m) => m.kind === 'dimension' && (m as unknown as { content?: unknown }).content !== undefined,
    ) as unknown as DimensionMarkup[]
    if (dims.length === 0) return null
    const d = hitTestDimension(hx, hy, dims, viewRef.current, page.width, page.height)
    if (d === null) return null
    return { markupId: d.markupId, part: d.part === 'vertex' ? 'vertex' : 'inside', index: d.index }
  }

  /** The note under the pointer, after takeoff and dimensions have had their turn. */
  const hitNoteAt = (hx: number, hy: number): Hit | null => {
    const notes = notesOf(markupsRef.current)
    return notes.length === 0 ? null : hitTestNote(hx, hy, notes, viewRef.current, page.width, page.height)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    /*
     * Space held, or the middle button: pan, whatever the tool.
     *
     * Ahead of the primary-button check because the middle button IS the
     * gesture here, and ahead of the pending-gesture check because moving
     * the sheet to see a calibration line better is not answering it.
     */
    if (spaceRef.current || (e.pointerType === 'mouse' && e.button === 1)) {
      panOverrideRef.current = true
      dragRef.current = { x: e.clientX, y: e.clientY }
      // Capture keeps the drag alive past the stage's edge. A pointer the
      // browser does not consider active (a synthetic one, in a test) refuses
      // it; the pan still works, it just ends at the edge.
      try { (e.target as Element).setPointerCapture(e.pointerId) } catch { /* see above */ }
      e.preventDefault()
      return
    }
    /*
     * Only the primary button draws.
     *
     * Right-click means "back out" — it is handled in onContextMenu — and
     * middle-click means nothing here. Letting either through put a vertex on
     * the sheet as a side effect of cancelling, so a right-click both abandoned
     * the shape and added a point to the next one.
     */
    const hb = e.pointerType === 'mouse' ? historyStepForButton(e.button) : null
    if (hb !== null) { e.preventDefault(); stepHistoryRef.current(hb); return }
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (zoomBoxArmedRef.current || titlePickRef.current !== null) {
      const r0 = e.currentTarget.getBoundingClientRect()
      const hx = e.clientX - r0.left, hy = e.clientY - r0.top
      const box = { x0: hx, y0: hy, x1: hx, y1: hy }
      if (zoomBoxArmedRef.current) zoomBoxRef.current = box
      else if (titlePickRef.current !== null) titleBoxRef.current = box
      else { textBoxRef.current = box; textPickRef.current = null }
      try { (e.target as Element).setPointerCapture(e.pointerId) } catch { /* see the pan */ }
      e.preventDefault()
      requestPaint()
      return
    }
    /*
     * A gesture waiting for its answer owns the sheet. The calibration line
     * and the region box stay drawn while the dock asks what they mean, and
     * with no scrim over the drawing any more a click here would start a
     * second line on top of the first — and answer the question for neither.
     */
    /*
     * The refs, not the state. The second calibration click sets the pending
     * question, but a third click landing before React re-rendered still saw
     * `pendingCal === null` and appended a third point to a two-point line.
     * Aaron: "It shouldn't allow you to start drawing a third point."
     */
    if (pendingCalRef.current !== null || pendingRegionRef.current !== null) return
    if (e.pointerType === 'touch') {
      const r = e.currentTarget.getBoundingClientRect()
      const p = pinchRef.current ?? {
        points: new Map<number, { x: number; y: number }>(), startDist: 0, startZoom: 1,
      }
      p.points.set(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top })
      pinchRef.current = p
      if (p.points.size === 2) {
        // Second finger down: freeze the baseline. Measuring from the first
        // MOVE instead would drop the distance travelled before that frame and
        // make the gesture jump.
        const [a, b] = [...p.points.values()]
        p.startDist = Math.hypot(a!.x - b!.x, a!.y - b!.y)
        p.startZoom = viewRef.current.zoom
        // A pinch is not a drag. Cancel any pan the first finger started, or
        // the sheet slides while it scales.
        dragRef.current = null
        return
      }
    }
    if (tool === 'pan' || tool === 'select') {
      const r0 = e.currentTarget.getBoundingClientRect()
      const hx = e.clientX - r0.left, hy = e.clientY - r0.top
      // In Pan a link is clicked to follow it; Select (or a right-click) picks it to move or delete.
      const hit = hitTest(hx, hy, tool === 'pan' ? markupsRef.current.filter((m) => m.kind !== 'link') : markupsRef.current, viewRef.current, page.width, page.height)
        ?? hitDimensionAt(hx, hy) ?? hitNoteAt(hx, hy)
      // Capture keeps a drag alive past the stage's edge. A pointer the
      // browser does not consider active — a synthetic one, in a test —
      // refuses it, and the refusal must not abort the selection or the pan.
      try { (e.target as Element).setPointerCapture(e.pointerId) } catch { /* see above */ }

      if (hit) {
        // Shift extends the selection; a plain click replaces it. Clicking an
        // already-selected markup keeps the whole selection so a drag moves all
        // of them, which is what every editor does.
        const already = selectedRef.current.includes(hit.markupId)
        // Shift or Ctrl extends, the way every editor reads them.
        const extend = e.shiftKey || e.ctrlKey || e.metaKey
        const next = extend
          ? (already
              ? selectedRef.current.filter((x) => x !== hit.markupId)
              : [...selectedRef.current, hit.markupId])
          : (already ? selectedRef.current : [hit.markupId])
        setSelectedIds(next)
        selectedRef.current = next
        const m = markupsRef.current.find((x) => x.id === hit.markupId)
        const ring = m?.rings[0] ?? []

        /*
         * The scope FOLLOWS the markup. Clicking a shape of another scope
         * makes that scope the active one everywhere: the dock, the sidebar
         * (if it has a scope open), and the scope the next shape lands in.
         * Kenneth, 2026-09-10: "I'm editing scope B, I click on a markup for
         * scope A, it should jump to scope A in all surfaces of the app."
         * Not on a Shift-click, which is building a selection, not choosing.
         */
        if (m !== undefined && m.scopeId !== null && m.scopeId !== activeScopeRef.current && !extend) {
          const sc = scopesRef.current.find((s) => s.id === m.scopeId)
          setActiveScope(m.scopeId)
          if (openScopeId !== null) setOpenScopeId(m.scopeId)
          if (sc !== undefined) setStatus(`switched to ${sc.label}`)
        }

        dragOriginRef.current = ring.map((p) => ({ ...p }))

        if (hit.part === 'vertex') {
          if (e.altKey && m) {
            const next = removeVertexAt(ring, hit.index, m.kind)
            if (next) void commitGeometry(m.id, next, dragOriginRef.current, 'remove vertex')
            else setStatus('cannot remove — a shape needs its minimum vertices')
            dragOriginRef.current = null
            requestPaint()
            return
          }
          editRef.current = { mode: 'vertex', id: hit.markupId, index: hit.index }
        } else if (hit.part === 'edge' && e.altKey && m) {
          const next = insertVertexAt(ring, hit.index)
          void commitGeometry(m.id, next, dragOriginRef.current, 'insert vertex')
          dragOriginRef.current = null
          editRef.current = null
          requestPaint()
          return
        } else if (hit.part === 'edge' && m && isAxisAlignedRect(ring)) {
          // A rectangle's edge is a grip: drag it and the rectangle resizes.
          // Kenneth: "if you draw it as a rectangle, you should be able to
          // edit it as a rectangle."
          editRef.current = { mode: 'edge', id: hit.markupId, index: hit.index }
        } else {
          const n = screenToNormalized(hx, hy, viewRef.current, page.width, page.height)
          // Move the whole selection, not just the markup under the cursor.
          const picked = selectedRef.current.includes(hit.markupId)
            ? selectedRef.current
            : [hit.markupId]
          // A hole whose area moves goes with it; moving it as well would
          // move it twice.
          const movingIds = picked.filter((id) => !isCutId(id) || !picked.includes(cutTarget(id)?.areaId ?? ''))
          const origins = new Map<string, Array<Array<{ x: number; y: number }>>>()
          for (const id of movingIds) {
            const mm = markupsRef.current.find((x) => x.id === id)
            if (mm?.rings[0]) origins.set(id, mm.rings.map((r) => r.map((pt) => ({ ...pt }))))
          }
          editRef.current = { mode: 'move', ids: movingIds, lastN: n, origins }
        }
        requestPaint()
        return
      }

      // One of the PDF's own markups under the pointer, in the Select tool:
      // it selects the way ours do. Ctrl or Shift extends.
      if (tool === 'select') {
        const a = annotationAt(screenToNormalized(hx, hy, viewRef.current, page.width, page.height), annotsRef.current)
        if (a !== null) {
          const extend = e.shiftKey || e.ctrlKey || e.metaKey
          const cur = selectedAnnotsRef.current
          const has = cur.includes(a.index)
          selectAnnots(extend ? (has ? cur.filter((i) => i !== a.index) : [...cur, a.index]) : [a.index])
          if (!extend) { setSelectedIds([]); selectedRef.current = [] }
          marqueeRef.current = null
          dragRef.current = null
          editRef.current = null
          requestPaint()
          return
        }
      }

      // A press on one of the PDF's links is followed if it is let go in place
      // (see onPointerUp); a drag from it still pans or draws a marquee.
      {
        const lk = !(e.shiftKey || e.ctrlKey || e.metaKey) && viewerRef.current !== null
          ? linkAt(linksHere(), screenToNormalized(hx, hy, viewRef.current, page.width, page.height))
          : null
        linkDownRef.current = lk !== null ? { x: hx, y: hy, link: lk } : null
      }
      // Empty space: the Select tool, or Shift in Pan, starts a marquee;
      // otherwise pan and clear. A marquee with Shift or Ctrl ADDS to the
      // selection, the way a Shift-click does: it cleared it here first, so
      // gathering markups from two corners of a sheet was impossible.
      const extendMarquee = (e.shiftKey || e.ctrlKey || e.metaKey) && (e.shiftKey || tool === 'select')
      marqueeBaseRef.current = extendMarquee ? [...selectedRef.current] : []
      if (!extendMarquee) {
        setSelectedIds([])
        selectedRef.current = []
      }
      if (!(e.shiftKey || e.ctrlKey || e.metaKey)) selectAnnots([])
      editRef.current = null
      if (e.shiftKey || tool === 'select') {
        marqueeRef.current = { x0: hx, y0: hy, x1: hx, y1: hy }
        dragRef.current = null
      } else {
        marqueeRef.current = null
        dragRef.current = { x: e.clientX, y: e.clientY }
      }
      requestPaint()
      return
    }
    const rect = e.currentTarget.getBoundingClientRect()
    const s0 = applySnap(e.clientX - rect.left, e.clientY - rect.top)
    snapRef.current = s0.snap
    const p = screenToNormalized(s0.x, s0.y, viewRef.current, page.width, page.height)
    const d = draftRef.current

    /*
     * An area or a cutout starts as a possible RECTANGLE.
     *
     * Most ceilings, and very nearly every cutout, are rectangles, and clicking
     * four corners to say so is three clicks of ceremony. Pressing and dragging
     * gives the rectangle directly; pressing and releasing without moving falls
     * through to placing a vertex, so the polygon path is untouched and both
     * live on one tool. Which one you meant is decided on release, by whether
     * the pointer travelled — see onPointerUp.
     */
    /*
     * A dimension places two points and commits itself on the second.
     *
     * No Enter, unlike a polygon: a dimension is finished when its second end
     * is down, and asking for a keystroke to confirm something already
     * unambiguous is the ceremony this tool exists to avoid.
     */
    /*
     * Origin: one click sets where an area's pattern starts (#69). The click
     * is already snapped to the drawing; the area it is for, and its corner
     * or edge within a grip's reach, are decided in tools/origin.ts.
     */
    if (tool === 'origin') {
      const v = viewRef.current
      const pick = pickOriginArea(p, markupsRef.current, activeScopeRef.current, {
        scaleX: page.width * v.zoom, scaleY: page.height * v.zoom, radius: VERTEX_GRAB_PX + 3,
      })
      if (pick === null) setStatus('click inside an area, or on its corner or edge, to start its pattern there')
      else void startPatternHere(pick.markup, pick.point)
      requestPaint()
      return
    }

    if (isNoteTool(tool)) {
      // The pen follows the hand, not the drawing's lines.
      const at = tool === 'pen'
        ? screenToNormalized(e.clientX - rect.left, e.clientY - rect.top, viewRef.current, page.width, page.height)
        : p
      if (tool === 'pen') snapRef.current = null
      noteDraftRef.current = noteDown(noteDraftRef.current, at)
      noteDownAtRef.current = tool === 'pen' ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : { x: s0.x, y: s0.y }
      try { (e.target as Element).setPointerCapture(e.pointerId) } catch { /* as in the pan branch */ }
      requestPaint()
      return
    }

    if (tool === 'dimension') {
      const next = dimensionDraftPlace(dimensionDraftRef.current, p, page.width, page.height)
      dimensionDraftRef.current = next
      if (next.b !== null) void commitDimensionDraft()
      requestPaint()
      return
    }

    /*
     * The highlight too. A highlighter is a drag across the thing being
     * marked; asking for three corners and Enter made the Highlight button
     * look broken, because nothing appeared until a gesture nobody makes
     * with a highlighter had been completed.
     */
    if ((tool === 'area' || tool === 'cutout' || tool === 'shape' || tool === 'link') && d.points.length === 0 && d.mode !== 'circle') {
      rectRef.current = { anchor: p, x1: s0.x, y1: s0.y, moved: false }
      try { (e.target as Element).setPointerCapture(e.pointerId) } catch { /* as in the pan branch */ }
    }
    // A link is a dragged box and nothing else; a box waiting for its sheet takes no second one.
    if (tool === 'link') {
      if (pendingLinkRef.current !== null) rectRef.current = null
      requestPaint()
      return
    }

    // A two-point gesture is complete at two. Its commit hands off to a
    // question (calibrate, region) or writes (direction); either way there is
    // no third point to place.
    if ((tool === 'calibrate' || tool === 'direction' || tool === 'scale-region') && d.points.length >= 2) return

    // Nothing the window renders reads the draft: the canvas paints it, so a
    // vertex asks for a paint, not a render of the whole workspace (that cost
    // 40-60 ms a click on a laptop with a takeoff open).
    // Area, Cutout and Linear place through tools/curves.ts: a line, an arc's
    // through point or end, or a circle's centre or edge (Kenneth #8).
    if (CURVE_TOOLS.has(tool)) {
      const placed = placeCurvePoint(d, p, { width: page.width, height: page.height })
      draftRef.current = placed.draft
      setSegMode(placed.draft.mode ?? 'line')
      setSegTick((n) => n + 1)
      if (placed.complete) void commitDraft()
      requestPaint()
      return
    }
    draftRef.current = { ...d, points: [...d.points, p] }
    if (tool === 'count'
        || ((tool === 'calibrate' || tool === 'direction' || tool === 'scale-region')
          && draftRef.current.points.length === 2)) {
      void commitDraft()
    }
    requestPaint()
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const pinch = pinchRef.current
    if (pinch && pinch.points.has(e.pointerId)) {
      const r = e.currentTarget.getBoundingClientRect()
      pinch.points.set(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top })
      if (pinch.points.size === 2 && pinch.startDist > 0) {
        const [a, b] = [...pinch.points.values()]
        const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y)
        const v = viewerRef.current
        if (v && dist > 0) {
          const next = Math.min(MAX_ZOOM, Math.max(0.05, pinch.startZoom * (dist / pinch.startDist)))
          // Anchor on the midpoint between the fingers, which is where the
          // gesture visually pivots.
          viewRef.current = clampViewport(
            zoomAbout(viewRef.current, next, (a!.x + b!.x) / 2, (a!.y + b!.y) / 2),
            v.pageInfo,
          )
          v.requestVisible(viewRef.current)
          requestPaint()
        }
        return
      }
    }
    const v = viewerRef.current
    if (!v) return
    const rect = e.currentTarget.getBoundingClientRect()

    const box = zoomBoxRef.current ?? textBoxRef.current ?? titleBoxRef.current
    if (box !== null) {
      box.x1 = e.clientX - rect.left
      box.y1 = e.clientY - rect.top
      requestPaint()
      return
    }

    /*
     * Auto-pan while a gesture is live and the pointer is within EDGE px of
     * the stage's edge (or past it: capture keeps the events coming). Speed
     * rises with how far into the band the pointer is, capped at MAX px per
     * frame. See autoPanRef.
     */
    const gestureLive = !panOverrideRef.current && (
      rectRef.current !== null || marqueeRef.current !== null || editRef.current !== null
      || dimensionDraftRef.current.a !== null
      || (draftRef.current.points.length > 0 && tool !== 'pan' && tool !== 'select'))
    if (gestureLive) {
      const EDGE = 28, MAX = 18
      const x = e.clientX - rect.left, y = e.clientY - rect.top
      const push = (d: number) => Math.min(MAX, Math.max(0, ((EDGE - d) / EDGE) * MAX))
      const vx = x < EDGE ? -push(x) : x > rect.width - EDGE ? push(rect.width - x) : 0
      const vy = y < EDGE ? -push(y) : y > rect.height - EDGE ? push(rect.height - y) : 0
      if (vx === 0 && vy === 0) stopAutoPan()
      else {
        const at = { clientX: e.clientX, clientY: e.clientY, pointerId: e.pointerId, shiftKey: e.shiftKey, altKey: e.altKey }
        const ap = autoPanRef.current
        if (ap !== null) { ap.vx = vx; ap.vy = vy; ap.at = at }
        else {
          const tick = () => {
            const cur = autoPanRef.current, vv = viewerRef.current, el = stageRef.current
            if (cur === null || vv === null || el === null) { autoPanRef.current = null; return }
            viewRef.current = clampViewport(
              { ...viewRef.current, ox: viewRef.current.ox + cur.vx, oy: viewRef.current.oy + cur.vy },
              vv.pageInfo,
            )
            vv.requestVisible(viewRef.current)
            // The sheet moved under a pointer that did not: re-run the move
            // at its last position so the live geometry follows.
            moveHandlerRef.current?.({ ...cur.at, currentTarget: el, pointerType: 'mouse' } as unknown as React.PointerEvent)
            cur.raf = requestAnimationFrame(tick)
          }
          autoPanRef.current = { raf: requestAnimationFrame(tick), vx, vy, at }
        }
      }
    } else {
      stopAutoPan()
    }

    if (panOverrideRef.current) {
      const d = dragRef.current
      if (!d) return
      viewRef.current = clampViewport(
        { ...viewRef.current, ox: viewRef.current.ox - (e.clientX - d.x), oy: viewRef.current.oy - (e.clientY - d.y) },
        v.pageInfo, OVERSCROLL,
      )
      dragRef.current = { x: e.clientX, y: e.clientY }
      v.requestVisible(viewRef.current)
      requestPaint()
      return
    }

    const rc = rectRef.current
    if (rc) {
      const s = applySnap(e.clientX - rect.left, e.clientY - rect.top)
      snapRef.current = s.snap
      rc.x1 = s.x
      rc.y1 = s.y
      // A few pixels of slop so a click with a shaky hand is still a click.
      // Measured against where the anchor IS on screen now, so a wheel pan
      // mid-press does not count as travel on its own.
      const a = normalizedToScreen(rc.anchor.x, rc.anchor.y, viewRef.current, page.width, page.height)
      if (Math.abs(rc.x1 - a.x) > 3 || Math.abs(rc.y1 - a.y) > 3) rc.moved = true
      if (rc.moved) {
        draftRef.current = {
          ...draftRef.current,
          points: rectPointsBetween(
            rc.anchor, screenToNormalized(rc.x1, rc.y1, viewRef.current, page.width, page.height),
          ),
          cursor: null,
        }
      }
      requestPaint()
      return
    }

    /*
     * The rubber band. Ortho is applied inside the draft, against the anchor,
     * so a constrained dimension snaps to the axis while it is being drawn
     * rather than jumping to it on release.
     */
    if (isNoteTool(tool)) {
      const rx = e.clientX - rect.left, ry = e.clientY - rect.top
      const s0 = tool === 'pen' ? { x: rx, y: ry, snap: null } : applySnap(rx, ry)
      snapRef.current = s0.snap
      const p = screenToNormalized(s0.x, s0.y, viewRef.current, page.width, page.height)
      noteDraftRef.current = noteMove(noteDraftRef.current, p, 1.5 / (page.width * viewRef.current.zoom))
      requestPaint()
      return
    }

    if (tool === 'dimension') {
      const s0 = applySnap(e.clientX - rect.left, e.clientY - rect.top)
      snapRef.current = s0.snap
      const p = screenToNormalized(s0.x, s0.y, viewRef.current, page.width, page.height)
      dimensionDraftRef.current = dimensionDraftMove(
        dimensionDraftRef.current, p, page.width, page.height,
      )
      requestPaint()
      return
    }

    if (tool === 'pan' || tool === 'select') {
      if (marqueeRef.current) {
        marqueeRef.current.x1 = e.clientX - rect.left
        marqueeRef.current.y1 = e.clientY - rect.top
        requestPaint()
        return
      }
      const ed = editRef.current
      if (ed) {
        const s0 = applySnap(e.clientX - rect.left, e.clientY - rect.top)
        snapRef.current = ed.mode === 'vertex' ? s0.snap : null
        const n = screenToNormalized(s0.x, s0.y, viewRef.current, page.width, page.height)
        const focusId = ed.mode === 'move' ? ed.ids[0] : ed.id
        const m = markupsRef.current.find((x) => x.id === focusId)
        if (!m) return
        const ring = m.rings[0] ?? []
        if (ed.mode === 'vertex') {
          /*
           * Shift on a rectangle's corner keeps it a rectangle: the two
           * neighbours follow. Read from the ring as it was when the drag
           * began, which is still a rectangle whatever the preview shows.
           */
          const origin = dragOriginRef.current
          const next = shiftRef.current && origin !== null && isAxisAlignedRect(origin)
            ? resizeRectVertex(origin, ed.index, n)
            : ring.map((p, i) => (i === ed.index ? n : p))
          previewGeometry(ed.id, next)
        } else if (ed.mode === 'edge') {
          previewGeometry(ed.id, resizeRectEdge(dragOriginRef.current ?? ring, ed.index, n))
        } else {
          const dx = n.x - ed.lastN.x
          const dy = n.y - ed.lastN.y
          for (const id of ed.ids) previewMove(id, dx, dy)
          ed.lastN = n
        }
        requestPaint()
        return
      }
      // hover feedback for handles
      const hv = hitTest(e.clientX - rect.left, e.clientY - rect.top,
        markupsRef.current, viewRef.current, page.width, page.height)
        ?? hitDimensionAt(e.clientX - rect.left, e.clientY - rect.top)
        ?? hitNoteAt(e.clientX - rect.left, e.clientY - rect.top)
      hoverRef.current = hv
      /*
       * The cursor says what a press would do. Over a rectangle's edge it is
       * the resize arrow for that edge, over a corner the diagonal one, over
       * the inside a move; nothing said so before, and a grip that does not
       * announce itself is a grip nobody finds (Aaron, 2026-09-11).
       */
      const cursor = hoverCursorFor(hv, markupsRef.current, tool)
        ?? (tool === 'select' && annotsRef.current.length > 0
          && annotationAt(screenToNormalized(e.clientX - rect.left, e.clientY - rect.top, viewRef.current, page.width, page.height), annotsRef.current) !== null
          ? 'pointer' : null)
        ?? (linkAt(linksHere(), screenToNormalized(e.clientX - rect.left, e.clientY - rect.top, viewRef.current, page.width, page.height)) !== null
          ? 'pointer' : null)
      if (cursor !== hoverCursorRef.current) { hoverCursorRef.current = cursor; setHoverCursor(cursor) }
      const d = dragRef.current
      if (!d) { requestPaint(); return }
      viewRef.current = clampViewport(
        { ...viewRef.current, ox: viewRef.current.ox - (e.clientX - d.x), oy: viewRef.current.oy - (e.clientY - d.y) },
        v.pageInfo, OVERSCROLL,
      )
      dragRef.current = { x: e.clientX, y: e.clientY }
      v.requestVisible(viewRef.current)
      requestPaint()
      return
    }
    // A gesture waiting for its answer is finished on the sheet: no snap
    // marker, no rubber band, until the question is answered or withdrawn.
    if (pendingCalRef.current !== null || pendingRegionRef.current !== null) { snapRef.current = null; return }
    const s0 = applySnap(e.clientX - rect.left, e.clientY - rect.top)
    snapRef.current = s0.snap
    if (draftRef.current.points.length > 0 || draftRef.current.pivot !== undefined) {
      draftRef.current = {
        ...draftRef.current,
        cursor: screenToNormalized(s0.x, s0.y, viewRef.current, page.width, page.height),
      }
    }
    requestPaint()
  }

  moveHandlerRef.current = onPointerMove

  // A weight change shows only on the next paint; ask for one.
  useEffect(() => {
    viewerRef.current?.requestVisible(viewRef.current)
    requestPaint()
  }, [prefs['takeoff.lineWeight'], prefs['takeoff.scaleLineWeightWithZoom'], requestPaint])

  const onPointerUp = (e?: React.PointerEvent) => {
    stopAutoPan()
    const pinch = pinchRef.current
    if (pinch && e) {
      pinch.points.delete(e.pointerId)
      // Keep the map alive while one finger remains: lifting one finger of a
      // pinch should not restart a pan under the other.
      if (pinch.points.size === 0) pinchRef.current = null
      else if (pinch.points.size < 2) pinch.startDist = 0
      if (e.pointerType === 'touch') return
    }
    if (panOverrideRef.current) {
      // The drag was a pan and nothing else: no vertex went down, so there is
      // no rectangle, marquee or edit to finish.
      panOverrideRef.current = false
      dragRef.current = null
      return
    }
    dragRef.current = null

    const zb = zoomBoxRef.current
    if (zb !== null) {
      zoomBoxRef.current = null
      finishZoomBoxRef.current(zb)
      requestPaint()
      return
    }
    const tb = textBoxRef.current
    if (tb !== null) {
      textBoxRef.current = null
      finishTextBoxRef.current(tb)
      requestPaint()
      return
    }
    const tbb = titleBoxRef.current
    if (tbb !== null) {
      titleBoxRef.current = null
      finishTitleBoxRef.current(tbb)
      requestPaint()
      return
    }
    const ld = linkDownRef.current
    linkDownRef.current = null
    if (ld !== null && e !== undefined) {
      const r0 = e.currentTarget.getBoundingClientRect()
      const ux = e.clientX - r0.left, uy = e.clientY - r0.top
      if (Math.abs(ux - ld.x) <= 4 && Math.abs(uy - ld.y) <= 4) {
        marqueeRef.current = null
        followLinkRef.current(ld.link)
        requestPaint()
        return
      }
    }

    if (isNoteTool(toolRef.current) && noteDraftRef.current.down !== null && e !== undefined) {
      const r0 = e.currentTarget.getBoundingClientRect()
      const rx = e.clientX - r0.left, ry = e.clientY - r0.top
      const pen = toolRef.current === 'pen'
      const s0 = pen ? { x: rx, y: ry } : applySnap(rx, ry)
      const p = screenToNormalized(s0.x, s0.y, viewRef.current, page.width, page.height)
      const from = noteDownAtRef.current
      noteDownAtRef.current = null
      const first = noteDraftRef.current.points[0]
      const firstOnScreen = first === undefined ? null : normalizedToScreen(first.x, first.y, viewRef.current, page.width, page.height)
      const style = noteStylesRef.current[toolRef.current as NoteShape]
      const step = noteUp(noteDraftRef.current, p, {
        dragged: from !== null && Math.hypot(s0.x - from.x, s0.y - from.y) > 4,
        closes: firstOnScreen !== null && Math.hypot(firstOnScreen.x - s0.x, firstOnScreen.y - s0.y) <= VERTEX_GRAB_PX,
        // A click places a text box two and a half inches wide, one line high;
        // a leader's starts that size at its tail and fits its text when done.
        textBox: { w: 180 / page.width, h: (style.fontPt * TEXT_LEADING + 2 * TEXT_PAD_PT) / page.height },
        simplify: 0.75 / (page.width * viewRef.current.zoom),
      })
      applyNoteStepRef.current(step)
      return
    }

    const rc = rectRef.current
    if (rc) {
      rectRef.current = null
      if (rc.moved) {
        draftRef.current = {
          ...draftRef.current,
          points: rectPointsBetween(
            rc.anchor, screenToNormalized(rc.x1, rc.y1, viewRef.current, page.width, page.height),
          ),
          cursor: null,
        }
        void commitDraft()
        return
      }
      // Did not travel: it was a click, and the vertex it placed on the way
      // down stands. The polygon continues from there.
    }

    if (marqueeRef.current) {
      const r = marqueeRef.current
      marqueeRef.current = null
      // A click with Shift is a zero-area marquee; treat it as clearing, not
      // as selecting everything.
      if (Math.abs(r.x1 - r.x0) > 3 || Math.abs(r.y1 - r.y0) > 3) {
        const inRect = markupsInRect(r, markupsRef.current, viewRef.current, page.width, page.height)
        const base = marqueeBaseRef.current
        const ids = [...base, ...inRect.filter((id) => !base.includes(id))]
        setSelectedIds(ids); selectedRef.current = ids
        const n0 = screenToNormalized(Math.min(r.x0, r.x1), Math.min(r.y0, r.y1), viewRef.current, page.width, page.height)
        const n1 = screenToNormalized(Math.max(r.x0, r.x1), Math.max(r.y0, r.y1), viewRef.current, page.width, page.height)
        const picked = annotsRef.current.filter((a) => a.rect.x0 >= n0.x && a.rect.x1 <= n1.x && a.rect.y0 >= n0.y && a.rect.y1 <= n1.y).map((a) => a.index)
        selectAnnots(picked)
        const total = ids.length + picked.length
        /*
         * Nothing of ours or the PDF's in the box: it was drawn around the
         * sheet's own words, which the Select tool picks for Ctrl+C. This was
         * the Text tool's job until T became the text box (Kenneth,
         * 2026-11-26: "T should be text box, select text should be part of
         * the select tool").
         */
        if (total === 0 && toolRef.current === 'select') {
          finishTextBoxRef.current(r)
          requestPaint()
          return
        }
        textPickRef.current = null
        setStatus(total > 0
          ? `${total} selected${picked.length > 0 ? ` · ${picked.length} from the PDF` : ''}`
          : 'nothing in selection')
      }
      requestPaint()
    }
    const ed = editRef.current
    if (ed) {
      if (ed.mode === 'vertex' || ed.mode === 'edge') {
        const m = markupsRef.current.find((x) => x.id === ed.id)
        const ring = m?.rings[0]
        if (m && ring) void commitGeometry(m.id, ring, dragOriginRef.current, ed.mode === 'edge' ? 'resize edge' : 'move vertex')
      } else {
        // One gesture, one undo step — even when it moved twelve markups.
        void commitMove(ed.ids, ed.origins)
      }
      dragOriginRef.current = null
      editRef.current = null
      snapRef.current = null
      requestPaint()
    }
  }
  /**
   * The kind each drawing tool produces. `pan` and `calibrate` produce no
   * takeoff markup, so they are absent rather than mapped to something.
   */
  /**
   * Put search hits on the sheet as highlight markups, one per matched box,
   * in the active scope, as one undo step. A highlight reaches no quantity,
   * so this marks the sheet without touching the estimate.
   */
  const markHits = useCallback(async (hits: SearchHit[], scopeId: string): Promise<string[]> => {
    if (!requireProject()) return []
    /*
     * Into the scope the PANE chose, never the dock's active scope. Aaron,
     * 2026-09-18: highlights landed in whatever scope happened to be active,
     * and with no takeoff scope in hand they still picked one. The pane asks
     * first now and passes the answer here.
     */
    const cmds = []
    const ids: string[] = []
    for (const h of hits) {
      if (h.boxes === null) continue
      for (const b of h.boxes) {
        const id = uid()
        ids.push(id)
        cmds.push(cmdCreate({
          id, documentId: h.documentId, pageId: h.pageId, scopeId,
          kind: 'shape',
          rings: [[{ x: b.x0, y: b.y0 }, { x: b.x1, y: b.y0 }, { x: b.x1, y: b.y1 }, { x: b.x0, y: b.y1 }]],
          origin: 'user', reviewState: 'accepted',
        }))
      }
    }
    if (cmds.length === 0) return []
    await runCommand(cmds.length === 1 ? cmds[0]! : cmdBatch(`highlight ${cmds.length} matches`, cmds))
    setStatus(`${cmds.length} highlight${cmds.length === 1 ? '' : 's'} added`)
    return ids
  }, [runCommand])

  /** Take highlights back, as one undo step. */
  const unmarkHits = useCallback(async (ids: string[]) => {
    const cmds = ids.map((id) => cmdRemove({ id, kind: 'shape', origin: 'user' }))
    if (cmds.length === 0) return
    await runCommand(cmds.length === 1 ? cmds[0]! : cmdBatch(`remove ${cmds.length} highlights`, cmds))
  }, [runCommand])

  /**
   * What the PDF itself carries under a right-click: annotations from other
   * software (Bluebeam, Acrobat), which the sheet shows but nothing here can
   * select. Kenneth, 2026-09-10: "give me the option to right click on
   * existing markups from other PDF software to turn them into Redbeam
   * markups. Currently they are flattened and ineditable." Real annotations
   * convert; a markup burned into the page is not an annotation at all, and
   * for that the same menu offers a trace of the region under the pointer.
   */
  const openDrawingMenu = useCallback(async (x: number, y: number, n: { x: number; y: number }) => {
    const v = viewerRef.current
    let all: PageAnnotation[] = []
    if (v !== null) {
      try { all = await v.requestAnnotations(pageIndexRef.current) } catch { all = [] }
    }
    const convertible = all.filter((a) => a.shape !== 'other' && !isRedbeamNm(a.name))
    const visible = visibleAnnotations(convertible, hiddenAnnotsRef.current)
    const slack = 0.002
    const under = visible.filter((a) =>
      n.x >= a.rect.x0 - slack && n.x <= a.rect.x1 + slack && n.y >= a.rect.y0 - slack && n.y <= a.rect.y1 + slack)
    setAnnotMenu({ x, y, nx: n.x, ny: n.y, annotations: under, onSheet: convertible.length })
  }, [])

  const persistHidden = useCallback((next: number[]) => {
    hiddenAnnotsRef.current = new Set(next)
    setHiddenAnnotCount(next.length)
    const docId = docIdRef.current
    const page = pageIndexRef.current
    if (docId) {
      try {
        const book: HiddenBook = parseHiddenBook(sessionStorage.getItem(hiddenStorageKey(docId)))
        const key = String(page)
        if (next.length === 0) delete book[key]
        else book[key] = next
        sessionStorage.setItem(hiddenStorageKey(docId), JSON.stringify(book))
      } catch { /* the view still changes */ }
    }
    const viewer = viewerRef.current
    if (viewer !== null && viewer.setHiddenAnnotations(page, [...next, ...ownAnnotsRef.current])) {
      viewer.requestVisible(viewRef.current)
    }
    requestPaint()
  }, [requestPaint])

  const hidePdfMarkup = useCallback((index: number) => {
    persistHidden(hideAnnotation([...hiddenAnnotsRef.current], index))
    setStatus('that PDF markup is hidden on this sheet. The file is unchanged.')
  }, [persistHidden])

  const hidePdfMarkups = useCallback((which: 'all' | 'none') => {
    if (which === 'none') {
      persistHidden(showHidden())
      setStatus('hidden PDF markups are showing again')
      return
    }
    const indexes = annotsRef.current.map((a) => a.index)
    persistHidden(hideAll(indexes))
    setStatus('PDF markups on this sheet are hidden. The file is unchanged.')
  }, [persistHidden])

  const asideCurrentProject = useCallback(async () => {
    if (!projectBridge.desktop) {
      setStatus('the browser build cannot set a project aside')
      return
    }
    try {
      const close = closeDbRef.current
      closeDbRef.current = null
      await close?.()
      dbRef.current = null
      await projectBridge.removeProjectData(projectPath)
      onCloseProject()
    } catch (err) {
      setStatus(`could not set the project aside: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [onCloseProject, projectPath])

  /** The markup kind a PDF annotation becomes. A square is a room; a circle is a note. */
  const kindForAnnotation = (a: PageAnnotation): MarkupKind =>
    a.shape === 'polygon' || a.subtypeName === 'Square' ? 'area'
    : a.shape === 'polyline' || a.shape === 'ink' ? 'polyline'
    : 'shape'

  const ringsForAnnotation = (a: PageAnnotation): Array<Array<{ x: number; y: number }>> => {
    if (a.shape === 'polygon' || a.shape === 'polyline') return a.vertices.length >= 2 ? [a.vertices] : []
    if (a.shape === 'ink') return a.ink.filter((path) => path.length >= 2)
    const r = a.rect
    if (!(r.x1 > r.x0) || !(r.y1 > r.y0)) return []
    return [[{ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 }]]
  }

  /**
   * Turn PDF annotations into markups of the active scope, as one undo step.
   * A polygon or a square becomes an area, a line, polyline or ink stroke a
   * length, and anything else (a circle, a highlight, a stamp, a text box) a
   * highlight over its box. The original stays in the PDF, untouched; the
   * markup remembers where it came from in its content.
   *
   * A Bluebeam area with cutouts stays ONE area with holes in it, the way
   * Revu keeps it: its rings are the outline with every /Cutouts opening
   * subtracted (clip.ts), so an opening across the edge becomes a notch and
   * one inside a hole, and the area measures, draws, moves and embeds as a
   * single shape. Aaron, 2026-11-17: separate cutout markups beside the area
   * "do not together form a boolean shape". PDFium only flags the openings,
   * so the file is read for them (pdfCutouts.ts), and only when a flagged
   * area is among those converted.
   */
  const documentsRef = useRef(documents)
  documentsRef.current = documents
  const convertAnnotations = useCallback(async (
    list: PageAnnotation[], scopeId: string | null = activeScopeRef.current,
    // An agent converts on ITS sheet, which need not be the one on screen.
    at: { page: number; origin: 'user' | 'agent' } = { page: pageIndexRef.current, origin: 'user' },
  ): Promise<{ converted: number; cutouts: number; cutoutsUnread: boolean }> => {
    const docId = docIdRef.current
    const targetPage = at.page
    const pageId = pageIdFor(docId, targetPage)
    let found: RawCutouts[] = []
    let cutoutsUnread = false
    if (list.some((a) => a.hasCutouts && kindForAnnotation(a) === 'area')) {
      const doc = documentsRef.current.find((d) => d.id === docId)
      try {
        if (doc === undefined) throw new Error('no document')
        found = (await withRanged(projectBridge, projectPath, doc.relativePath, (big) => big.cutouts(targetPage)))?.value
          ?? await readPdfCutouts(await projectBridge.readDocument(projectPath, doc.relativePath), targetPage)
      } catch {
        cutoutsUnread = true
      }
    }
    const cmds = []
    let holes = 0
    let holed = 0
    for (const a of list) {
      const kind = kindForAnnotation(a)
      const content = {
        source: 'pdf-annotation', subtype: a.subtypeName, subject: a.subject,
        contents: a.contents, author: a.author, color: a.color,
      }
      const openings = kind === 'area' ? cutoutsFor(a, found) : []
      for (const ring of ringsForAnnotation(a)) {
        if (ring.length < (kind === 'polyline' ? 2 : 3)) continue
        const rings = areaWithCutouts(ring, openings)
        if (rings.length === 0) continue
        if (openings.length > 0) { holes += openings.length; holed++ }
        cmds.push(cmdCreate({
          id: uid(), documentId: docId, pageId, scopeId, kind,
          rings, origin: at.origin, reviewState: 'accepted',
          content: openings.length === 0 ? content : { ...content, cutouts: openings.length },
        }))
      }
    }
    if (cmds.length === 0) {
      if (at.origin === 'user') setStatus('nothing there to convert')
      return { converted: 0, cutouts: 0, cutoutsUnread }
    }
    await runCommand(cmds.length === 1 ? cmds[0]! : cmdBatch(`convert ${cmds.length} PDF markups`, cmds))
    const shapes = cmds.length
    // A session's conversion leaves the person's selection and status line alone.
    if (at.origin === 'agent') return { converted: shapes, cutouts: holes, cutoutsUnread }
    selectAnnots([])
    setStatus(`${shapes} PDF markup${shapes === 1 ? '' : 's'} converted`
      + (holes > 0 ? `, ${holed === 1 ? 'one area' : `${holed} areas`} with ${holes} cutout${holes === 1 ? '' : 's'}` : '')
      + (cutoutsUnread ? '. Their cutouts could not be read from the file' : ''))
    return { converted: shapes, cutouts: holes, cutoutsUnread }
  }, [runCommand, selectAnnots, projectPath])

  /** Every convertible annotation on the open sheet, converted. */
  const convertSheetAnnotations = useCallback(async (scopeId: string | null = activeScopeRef.current) => {
    const v = viewerRef.current
    if (v === null) return
    let all: PageAnnotation[] = []
    try { all = await v.requestAnnotations(pageIndexRef.current) } catch { all = [] }
    await convertAnnotations(all.filter((a) => a.shape !== 'other'), scopeId)
  }, [convertAnnotations])

  /**
   * Trace the region under a point from the sheet's own vector geometry and
   * make it an area of the active scope. For a markup flattened into the
   * page, which no annotation list can see: the lines it left are still
   * lines. The tracer's frame is 1200 points across; only that much of the
   * sheet's geometry is read.
   */
  const traceAt = useCallback(async (n: { x: number; y: number }) => {
    const v = viewerRef.current
    if (v === null || page.width === 0) return
    setStatus('tracing the region…')
    const half = 600
    const clip = {
      x0: Math.max(0, n.x - half / page.width), y0: Math.max(0, n.y - half / page.height),
      x1: Math.min(1, n.x + half / page.width), y1: Math.min(1, n.y + half / page.height),
    }
    let result: ReturnType<typeof traceRegion>
    try {
      const g = await v.requestGeometry(pageIndexRef.current, { clip, priority: 0 })
      const fpp = calRef.current?.feetPerPoint
      result = traceRegion({
        segments: g.segments, seed: n, page: { width: page.width, height: page.height },
        options: fpp !== undefined && fpp > 0 ? { feetPerPoint: fpp } : {},
      })
    } catch (err) {
      setStatus(`could not read the sheet's geometry: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    if (!result.ok) { setStatus(`no region there: ${result.message}`); return }
    await runCommand(cmdCreate({
      id: uid(), documentId: docIdRef.current, pageId: pageIdFor(docIdRef.current, pageIndexRef.current),
      scopeId: activeScopeRef.current, kind: 'area', rings: result.region, origin: 'user', reviewState: 'accepted',
      content: { source: 'trace' },
    }))
    setStatus('region traced')
  }, [page.width, page.height, runCommand])

  /** The tool a scope's take-off starts with: what the scope is measured as. */
  const firstToolFor = (id: string | null): Tool => {
    const sc = scopesRef.current.find((s) => s.id === id)
    return sc?.scopeType === 'linear' ? 'polyline' : sc?.scopeType === 'count' ? 'count' : 'area'
  }

  const TOOL_KIND: Partial<Record<Tool, MarkupKind>> = {
    area: 'area', cutout: 'cutout', polyline: 'polyline', count: 'count', shape: 'shape',
  }

  /**
   * 04.5: warn before a markup is drawn into a scope that will ignore it.
   * Shown next to the tool rather than after the fact, because after the fact
   * the estimator has already moved on believing it counted.
   */
  const toolWarning = useMemo(() => {
    const kind = TOOL_KIND[tool]
    const scope = scopes.find((s) => s.id === activeScope)
    if (!kind || !scope) return null
    return scopeToolWarning(scope, kind)
  }, [tool, scopes, activeScope])

  // The meters are sampled by PerfReadout itself, not into this component's
  // state: see the note there.

  // ------------------------------------------------------------- scopes ----

  /**
   * Freeze the dimension draft into a markup.
   *
   * `scopeId` is null and stays null. A dimension is a reading off the sheet,
   * not takeoff: `markupCountsInScope` returns false for it in every scope
   * type, so filing it under one would put a row in the scope's markup count
   * that reaches no quantity — a scope that says "12 markups" and measures
   * eight of them.
   */
  const commitDimensionDraft = useCallback(async () => {
    const frozen = commitDimension(dimensionDraftRef.current, page.width, page.height)
    // Null means a zero-length drag: a misclick, not a markup.
    if (frozen === null) { dimensionDraftRef.current = emptyDimensionDraft(); return }
    const id = `mk-${Math.random().toString(36).slice(2, 10)}`
    await runCommand(cmdCreate({
      id,
      scopeId: null,
      documentId: docIdRef.current,
      pageId: pageIdFor(docIdRef.current, pageIndexRef.current),
      kind: 'dimension',
      rings: frozen.rings,
      origin: 'user',
      reviewState: 'accepted',
      // The store's content column is an open payload; the dimension's
      // shape is checked where it is parsed back, not here.
      content: frozen.content as unknown as Record<string, unknown>,
    }))
    // Keep the tool in hand: dimensions come in runs — a head, a jamb, a sill
    // — and dropping back to pan after each one would cost a click every time.
    dimensionDraftRef.current = emptyDimensionDraft(dimensionDraftRef.current.ortho)
    setStatus(`dimension: ${frozen.content.label}`)
    requestPaint()
  }, [page.width, page.height, runCommand, requestPaint])

  /*
   * The note tools.
   *
   * A note is committed the moment its shape is complete: a drag let go, a
   * cloud closed, a leader placed. A text box then opens for typing; the
   * text is written when the box loses focus, and a new box left empty is
   * taken away again rather than left as an empty rectangle.
   */
  const commitNote = useCallback(async (shape: NoteShape, rings: Array<Array<{ x: number; y: number }>>) => {
    const id = `mk-${Math.random().toString(36).slice(2, 10)}`
    const content: NoteContent = { ...noteStylesRef.current[shape], shape, text: '' }
    const ok = await runCommand(cmdCreate({
      id,
      scopeId: null,
      documentId: docIdRef.current,
      pageId: pageIdFor(docIdRef.current, pageIndexRef.current),
      kind: 'note',
      rings,
      origin: 'user',
      reviewState: 'accepted',
      content: content as unknown as Record<string, unknown>,
    }))
    if (!ok) return
    if (hasText(shape)) { setNoteEdit({ id, isNew: true }); setStatus('type the text · click away or Ctrl+Enter when done') }
    else setStatus(`${shape === 'rect' ? 'rectangle' : shape} added`)
    requestPaint()
  }, [runCommand, requestPaint, setStatus])

  const applyNoteStep = useCallback((step: NoteStep) => {
    noteDraftRef.current = step.draft
    if (step.rings !== null && isNoteTool(toolRef.current)) void commitNote(toolRef.current, step.rings)
    else if (step.draft.cloud !== null) setStatus('now click where the text goes')
    requestPaint()
  }, [commitNote, requestPaint, setStatus])
  const applyNoteStepRef = useRef(applyNoteStep)
  applyNoteStepRef.current = applyNoteStep

  /**
   * Write what was typed. A text box grows downward to fit it; a leader's box
   * is fitted to its text and kept at the leader's tail. A new text box left
   * empty is taken away; a leader left without text stays an arrow.
   */
  const finishNoteEdit = useCallback(async () => {
    const edit = noteEditRef.current
    const el = noteTextRef.current
    if (edit === null) return
    setNoteEdit(null)
    noteEditRef.current = null
    const m = markupsRef.current.find((x) => x.id === edit.id)
    const before = parseNoteContent((m as { content?: unknown } | undefined)?.content)
    if (m === undefined || before === null) { requestPaint(); return }
    const text = (el?.value ?? before.text).replace(/\s+$/, '')
    if (text === '' && edit.isNew && before.shape === 'text') {
      await runCommand(cmdRemove({ id: m.id, kind: 'note', origin: 'user', documentId: m.documentId, pageId: m.pageId }))
      setStatus('empty text box removed')
      return
    }
    if (text === before.text) { requestPaint(); return }
    const after: NoteContent = { ...before, text }
    const at = textRingIndex(before.shape)
    const ring = m.rings[at] ?? []
    const ys = ring.map((q) => q.y), xs = ring.map((q) => q.x)
    const probe = document.createElement('canvas').getContext('2d')
    const measure = probe === null ? (t: string) => t.length * after.fontPt * 0.5 : canvasMeasure(probe, after.fontPt)
    let box: Array<{ x: number; y: number }> | null = null
    if (before.shape === 'text') {
      const widthPt = (Math.max(...xs) - Math.min(...xs)) * page.width
      const heightPt = (Math.max(...ys) - Math.min(...ys)) * page.height
      const needPt = textBoxHeightFor(after, widthPt, measure)
      if (needPt > heightPt + 0.5 && ring.length === 4) {
        const y0 = Math.min(...ys), y1 = y0 + needPt / page.height
        box = [
          { x: Math.min(...xs), y: y0 }, { x: Math.max(...xs), y: y0 },
          { x: Math.max(...xs), y: y1 }, { x: Math.min(...xs), y: y1 },
        ]
      }
    } else {
      const leader = m.rings[leaderRingIndex(before.shape)]
      if (leader !== undefined && leader.length >= 2) {
        const size = leaderTextSize(text, after.fontPt, measure)
        box = boxAtTail(leader[0]!, leader[1]!, size.w / page.width, size.h / page.height)
      }
    }
    const cmds = [cmdEditContent(m.id, before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>, 'edit text')]
    if (box !== null) {
      const rings = m.rings.map((r) => r.map((q) => ({ ...q })))
      rings[at] = box
      cmds.push(cmdEditGeometry(m.id, m.rings.map((r) => r.map((q) => ({ ...q }))), rings, 'edit text'))
    }
    await runCommand(cmds.length === 1 ? cmds[0]! : cmdBatch('edit text', cmds))
    setStatus('text saved')
  }, [page.width, page.height, runCommand, requestPaint, setStatus])

  /** The notes selected now, with their content. */
  const selectedNotes = useMemo(() => notesOf(markups.filter((m) => selectedIds.includes(m.id))), [markups, selectedIds])

  /** A change from the property strip: to the tool's next note, and to the notes selected. */
  const patchNotes = useCallback((patch: NotePatch) => {
    const t = toolRef.current
    if (isNoteTool(t)) {
      setNoteStyles((cur) => {
        const next = { ...cur, [t]: { ...cur[t], ...patch } }
        saveNoteStyles(next)
        return next
      })
    }
    const picked = notesOf(markupsRef.current.filter((m) => selectedRef.current.includes(m.id)))
    if (picked.length === 0) { requestPaint(); return }
    const cmds = picked.map((n) => cmdEditContent(
      n.id, n.content as unknown as Record<string, unknown>,
      { ...n.content, ...patch } as unknown as Record<string, unknown>, 'change markup',
    ))
    void runCommand(cmds.length === 1 ? cmds[0]! : cmdBatch(`change ${cmds.length} markups`, cmds))
      .then(() => { requestAnimationFrame(() => requestPaint()) })
  }, [runCommand, requestPaint])

  /** Re-read both live and archived scopes after any scope mutation. */
  const refreshScopes = useCallback(async () => {
    const db = dbRef.current
    if (!db) return
    const rows = await listScopes(db, { includeArchived: true })
    const map = (r: Awaited<ReturnType<typeof listScopes>>[number]): Scope => ({
      id: r.id, label: r.label, scopeType: r.scopeType as Scope['scopeType'],
      color: r.color, specifications: r.specifications,
    })
    setScopes(rows.filter((r) => r.archivedAt === null).map(map))
    setArchivedScopes(rows.filter((r) => r.archivedAt !== null).map(map))
  }, [])

  const saveScope = useCallback(async (scope: Scope) => {
    const db = dbRef.current
    if (!db) return
    const before = scopesRef.current.find((x) => x.id === scope.id)
    await upsertScope(db, {
      id: scope.id, label: scope.label, scopeType: scope.scopeType,
      color: scope.color, specifications: scope.specifications, archivedAt: null,
    })
    {
      const changed = before === undefined ? [] : [
        ...(before.label !== scope.label ? ['label'] : []),
        ...(before.scopeType !== scope.scopeType ? ['scopeType'] : []),
        ...(before.color !== scope.color ? ['color'] : []),
        ...[...new Set([...Object.keys(before.specifications), ...Object.keys(scope.specifications)])]
          .filter((k) => JSON.stringify(before.specifications[k]) !== JSON.stringify(scope.specifications[k])),
      ]
      try {
        await logActivity(db, {
          eventType: before === undefined ? 'scope.created' : 'scope.changed', entityType: 'scope', entityId: scope.id,
          origin: actorRef.current, details: { label: scope.label, ...(changed.length > 0 ? { changed } : {}) },
        })
      } catch { /* the trail is a record, never a reason to fail a save */ }
    }
    saveRef.current?.()
    await refreshScopes()
    void broadcastChange('scopes', identity.projectId ?? 'default')
  }, [refreshScopes])

  /**
   * Use a drawn edge as the pattern direction.
   *
   * The alternative is the Direction tool: pick it, then draw a line by eye
   * along an edge that is already on the sheet — a hand-traced copy of a
   * vector the markup holds exactly, and off by however steady your hand was.
   * A ceiling's planks run parallel to the wall you traced, so the wall you
   * traced is the direction.
   *
   * WHERE it lands is the interesting part. The first direction set on a sheet
   * governs every area of that scope on it; each one after that corrects the
   * single area it came from. One orientation usually governs a whole floor,
   * and the exceptions — a corridor the other way, a feature ceiling turned 45
   * degrees — are exceptions. So the common case costs one gesture and the
   * exception costs one more, and there is no mode to remember.
   *
   * `forPage` forces the general reading. Without it the sheet's direction
   * would be unreachable once set: every later gesture would attach to an
   * area, and a page direction taken from the wrong edge could only be undone
   * by overriding every area one at a time.
   */
  const directionFromEdge = useCallback(async (
    markup: Markup,
    edgeIndex: number,
    forPage?: boolean,
  ) => {
    const ring = markup.rings[0]
    if (!ring || markup.scopeId === null) return
    const a = ring[edgeIndex]
    const b = ring[(edgeIndex + 1) % ring.length]
    if (!a || !b) return
    if (a.x === b.x && a.y === b.y) {
      setStatus('that edge has no length, so it is not a direction')
      return
    }
    // `scopesRef`, not `scopes` — see commitDraft. A merge is only as good as
    // the thing it merges into.
    const sc = scopesRef.current.find((x) => x.id === markup.scopeId)
    if (!sc) return

    const specs = sc.specifications
    const pages = { ...(specs[PAGE_DIRECTIONS_KEY] as Record<string, unknown> ?? {}) }
    const areas = { ...(specs[AREA_DIRECTIONS_KEY] as Record<string, unknown> ?? {}) }
    const vector = { sourcePage: pageIndexRef.current, x1: a.x, y1: a.y, x2: b.x, y2: b.y }
    const general = forPage === true || pages[markup.pageId] === undefined

    if (general) {
      pages[markup.pageId] = vector
      /*
       * An area override on THIS sheet is a correction to a direction that no
       * longer exists. Restating the sheet's direction is a fresh start for
       * it, so the corrections to the old one go with it — otherwise areas
       * would silently keep an orientation the estimator has just replaced.
       */
      for (const m of docMarkupsRef.current) {
        if (m.pageId === markup.pageId && m.scopeId === sc.id) delete areas[m.id]
      }
    } else {
      areas[markup.id] = vector
    }

    await saveScope({
      ...sc,
      specifications: { ...specs, [PAGE_DIRECTIONS_KEY]: pages, [AREA_DIRECTIONS_KEY]: areas },
    })
    setStatus(general
      ? `pattern runs along that edge for ${sc.label} on this sheet`
      : `pattern runs along that edge for this area only`)
  }, [saveScope])

  /**
   * Start the panel grid at a point inside one area.
   *
   * The automatic origin is the bounding-rect centre, shared by every area
   * that has not been told otherwise. A right-click stores a point on this
   * area only, in the same specifications the direction already lives in.
   */
  const startPatternHere = useCallback(async (
    markup: Markup,
    click: { x: number; y: number },
    /** Take the area's corner nearest the click, however far away it is. */
    atCorner = false,
  ) => {
    if (markup.kind !== 'area' || markup.scopeId === null) {
      setStatus('start the pattern on an area')
      return
    }
    // Snap to the area's corner or edge within a grip's reach, so "the
    // corner" is the corner and not a few pixels inside it.
    const v = viewRef.current
    const placed = atCorner
      ? nearestAreaVertex(markup.rings, click, page)
      : patternStartPoint(click, markup.rings, {
        scaleX: page.width * v.zoom, scaleY: page.height * v.zoom, radius: VERTEX_GRAB_PX + 3,
      })
    if (placed === null) {
      setStatus('that point is outside the area, so the pattern start is unchanged')
      return
    }
    const sc = scopesRef.current.find((x) => x.id === markup.scopeId)
    if (!sc) return
    const specs = sc.specifications
    const areas = { ...(specs[AREA_ORIGINS_KEY] as Record<string, unknown> ?? {}) }
    areas[markup.id] = { x: placed.x, y: placed.y }
    await saveScope({
      ...sc,
      specifications: { ...specs, [AREA_ORIGINS_KEY]: areas },
    })
    setStatus(atCorner
      ? 'the pattern starts at that corner for this area'
      : 'the pattern starts there for this area')
    requestPaint()
  }, [saveScope, requestPaint, page])

  const clearPatternOrigin = useCallback(async (markup: Markup) => {
    if (markup.scopeId === null) return
    const sc = scopesRef.current.find((x) => x.id === markup.scopeId)
    if (!sc) return
    const specs = sc.specifications
    const areas = { ...(specs[AREA_ORIGINS_KEY] as Record<string, unknown> ?? {}) }
    delete areas[markup.id]
    await saveScope({
      ...sc,
      specifications: { ...specs, [AREA_ORIGINS_KEY]: areas },
    })
    setStatus('this area uses the default pattern start (Settings)')
    requestPaint()
  }, [saveScope, requestPaint])

  /**
   * Duplicate an estimate: its scopes and their specifications, not its takeoff.
   *
   * This is what a bidding round IS — the same scopes priced a different way,
   * an alternate with one product swapped, a value-engineered version. The
   * store has been able to do it since the beginning and nothing ever called
   * it, so the only way to bid an alternate was to build every scope again by
   * hand and hope the specifications matched.
   *
   * Markups deliberately do not come along. Copying them would double every
   * quantity in the project against drawings that were traced once, which is
   * never what "another round" means — the same reason duplicating a scope
   * copies its specification alone.
   */
  const duplicateEstimate = useCallback(async (sourceId: string, name: string) => {
    const db = dbRef.current
    if (!db) return
    const id = `estimate-${crypto.randomUUID()}`
    await copyEstimate(db, sourceId, id, name, () => `scope-${crypto.randomUUID()}`)
    saveRef.current?.()
    await refreshScopes()
    await refreshEstimates(id)
    setOpenEstimateId(id)
    setOpenScopeId(null)
    setStatus(`copied to ${name}`)
    void broadcastChange('estimates', identity.projectId ?? 'default')
  }, [refreshEstimates, refreshScopes, identity.projectId])

  /** Rename a bidding round. */
  const renameEstimateBy = useCallback(async (id: string, name: string) => {
    const db = dbRef.current
    if (!db) return
    try {
      await renameEstimate(db, id, name)
      saveRef.current?.()
      await refreshEstimates(openEstimateIdRef.current)
      void broadcastChange('estimates', identity.projectId ?? 'default')
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    }
  }, [refreshEstimates, identity.projectId])

  /**
   * Delete a bidding round, or say why not.
   *
   * A scope belongs to exactly one round, so this takes every scope in it —
   * which is why the store refuses while any of them still carries takeoff.
   * The refusal is the feature: an estimator does not lose an afternoon's
   * tracing to a click on the round it happens to live in.
   */
  const deleteEstimateBy = useCallback(async (id: string): Promise<string | undefined> => {
    const db = dbRef.current
    if (!db) return undefined
    try {
      await deleteEstimate(db, id)
      saveRef.current?.()
      setOpenEstimateId(null)
      setOpenScopeId(null)
      await refreshScopes()
      await refreshEstimates(null)
      setStatus('round deleted')
      void broadcastChange('estimates', identity.projectId ?? 'default')
      return undefined
    } catch (err) {
      const why = `cannot delete: ${err instanceof Error ? err.message : String(err)}`
      setStatus(why)
      return why
    }
  }, [refreshEstimates, refreshScopes, identity.projectId])

  /** Take a scope out of its round. It is archived, not destroyed. */
  const removeScopeBy = useCallback(async (estimateId: string, scopeId: string) => {
    const db = dbRef.current
    if (!db) return
    await removeScopeFromEstimate(db, estimateId, scopeId)
    saveRef.current?.()
    setOpenScopeId((cur) => (cur === scopeId ? null : cur))
    await refreshScopes()
    await refreshEstimates(estimateId)
    setStatus('scope archived')
    void broadcastChange('estimates', identity.projectId ?? 'default')
  }, [refreshEstimates, refreshScopes, identity.projectId])


  const createScope = useCallback(async (scope: Scope, opts?: { activate?: boolean }) => {
    await saveScope(scope)
    if (opts?.activate !== false) setActiveScope(scope.id)
    // A scope belongs to a bidding round, never to the project directly.
    const db = dbRef.current
    const round = openEstimateIdRef.current
    if (db && round !== null) {
      await addScopeToEstimate(db, round, scope.id)
      await refreshEstimates(round)
    }
  }, [saveScope, refreshEstimates])

  /**
   * A scope from a name — the sidebar's "Add scope" row. It opens on the new
   * scope's page, where everything past the name is set.
   */
  const createNamedScope = useCallback(async (label: string) => {
    if (!requireProject()) return
    const scope = newScope(label, scopesRef.current)
    await createScope(scope)
    setOpenScopeId(scope.id)
  }, [createScope])

  /**
   * Bring an archived scope back INTO THE OPEN ROUND.
   *
   * Removing a scope from a round archives it and drops the link, so
   * un-archiving alone would leave it live and belonging to nothing — listed
   * nowhere the panel looks. The restore is offered from a round's own list,
   * so that round is where it comes back.
   */
  const restoreScope = useCallback(async (id: string) => {
    const db = dbRef.current
    const round = openEstimateIdRef.current
    if (!db || round === null) return
    await setScopeArchived(db, id, false)
    await addScopeToEstimate(db, round, id)
    saveRef.current?.()
    await refreshScopes()
    await refreshEstimates(round)
    setStatus('scope restored')
    void broadcastChange('scopes', identity.projectId ?? 'default')
  }, [refreshScopes, refreshEstimates, identity.projectId])

  /**
   * Duplicate a scope's SPECIFICATIONS, not its markups.
   * Copying the takeoff too would double every quantity on the page, which is
   * never what "duplicate this scope" means — the point is to reuse a spec
   * with one parameter changed.
   */
  const duplicateScope = useCallback(async (id: string) => {
    const src = scopes.find((s) => s.id === id)
    if (!src) return
    // Two scopes with the same label are indistinguishable in the shelf, in
    // the quantity rows and in the rescope list — and rescoping into the wrong
    // one is silent. Disambiguate rather than letting duplicates collide.
    const taken = new Set(scopes.map((s) => s.label))
    let label = `${src.label} copy`
    for (let n = 2; taken.has(label); n++) label = `${src.label} copy ${n}`

    const copy: Scope = {
      ...src,
      id: `sc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      label,
      specifications: { ...src.specifications },
    }
    await createScope(copy)
    return { id: copy.id, label }
  }, [scopes, createScope])

  const archiveScope = useCallback(async (id: string, archived: boolean) => {
    const db = dbRef.current
    if (!db) return
    await setScopeArchived(db, id, archived)
    try {
      await logActivity(db, {
        eventType: archived ? 'scope.archived' : 'scope.restored', entityType: 'scope', entityId: id,
        origin: actorRef.current,
        // The whole scope goes on the trail when it is archived (#180): a file
        // that loses the scope row can still bring back its product and spec.
        details: ((): Record<string, unknown> => {
          const sc = [...scopesRef.current, ...archivedScopesRef.current].find((x) => x.id === id)
          return {
            label: sc?.label ?? '',
            ...(archived && sc !== undefined ? { scopeType: sc.scopeType, color: sc.color, specifications: sc.specifications } : {}),
          }
        })(),
      })
    } catch { /* as in saveScope */ }
    saveRef.current?.()
    await refreshScopes()
    void broadcastChange('scopes', identity.projectId ?? 'default')
    // Never leave the active scope pointing at something the shelf cannot show.
    if (archived) setActiveScope((cur) => (cur === id ? null : cur))
  }, [refreshScopes])

  /** Give a document a tab and focus it. Opening an already-open one just focuses. */
  const openDocument = useCallback((id: string) => {
    setOpenDocIds((cur) => (cur.includes(id) ? cur : [...cur, id]))
    setActiveDocId(id)
    // Choosing a drawing is followed by choosing a sheet in it, so the
    // Contents pane takes over from Files (Aaron, 2026-09-18).
    setRailPanel('contents')
  }, [])

  /*
   * Contents and Thumbnails are views of a drawing. When the first drawing
   * arrives — remembered from last time, or dropped in — the rail shows its
   * contents; when the last tab closes, a pane showing nothing goes back to
   * Files. Tracked by transition, so switching between open tabs leaves the
   * rail wherever it was put.
   */
  const hadDocumentRef = useRef(false)
  useEffect(() => {
    const has = activeDocId !== null
    if (has && !hadDocumentRef.current) setRailPanel((cur) => (cur === 'files' || cur === null ? 'contents' : cur))
    if (!has && hadDocumentRef.current && !light) setRailPanel((cur) => (cur === 'contents' || cur === 'thumbnails' ? 'files' : cur))
    hadDocumentRef.current = has
  }, [activeDocId, light])

  /**
   * Close a tab. Closing the active one falls back to its NEIGHBOUR rather than
   * to the first tab: after closing the third of five, you almost always want
   * the fourth, not the first.
   */
  const closeDocument = useCallback((id: string) => {
    closedTabsRef.current = [...closedTabsRef.current.filter((x) => x !== id), id].slice(-20)
    setOpenDocIds((cur) => {
      const i = cur.indexOf(id)
      if (i < 0) return cur
      const next = cur.filter((x) => x !== id)
      setActiveDocId((active) => {
        if (active !== id) return active
        return next[Math.min(i, next.length - 1)] ?? null
      })
      return next
    })
  }, [])

  /**
   * Save a drawing's takeoff into the PDF itself, so it travels with the file.
   *
   * Bluebeam sees each markup as a native measurement with the scope as its
   * label and the net quantity; REDBEAM's own detail (layouts, counts, scope
   * specs) rides along privately. Appended as an incremental update, refused
   * if the file changed since it was read, and skipped when nothing changed.
   * One write per drawing at a time.
   */
  const embedChainRef = useRef(new Map<string, Promise<void>>())
  /** Drawings whose last automatic save was refused, so it is said once, not every few seconds. */
  const autoEmbedComplainedRef = useRef(new Set<string>())
  /**
   * Light: whether each file's own takeoff reached this window. Saving waits
   * for 'loaded' and never happens for 'blocked', because a save from a store
   * the file's takeoff is not in would write that emptiness over it.
   */
  const fileLoadRef = useRef(new Map<string, FileLoad>())
  /**
   * Light: the takeoff each file carried when this window last read or wrote
   * it. A save that finds a different one there (another window, a synced
   * copy from someone else) does not replace it; see `EmbedInput.expectStamp`.
   */
  const seenStampRef = useRef(new Map<string, string | null>())
  /**
   * Sheets turned in this window, per document: page index to degrees. Handed
   * to every save of that drawing, which writes /Rotate onto the page so the
   * PDF opens turned in Bluebeam as well as here.
   */
  const pageRotationsRef = useRef(new Map<string, Map<number, number>>())
  /** The last sheet an agent's trace_field read whole, so boxes inside it are not read again. */
  const fieldGeometryRef = useRef<{ viewer: Viewer; doc: string | null; page: number; turned: number; width: number; height: number; clip: { x0: number; y0: number; x1: number; y1: number }; segments: Float32Array } | null>(null)
  const [rotationTick, setRotationTick] = useState(0)

  const [loadBlock, setLoadBlock] = useState<string | null>(null)
  /** Light: this file's takeoff was rebuilt from its markups, and what that could not bring back. */
  const [rebuiltNote, setRebuiltNote] = useState<string | null>(null)
  /** Which rebuild the note is about (file, markups, scopes), so a dismissal holds for that file until it changes. */
  const rebuiltKeyRef = useRef<string | null>(null)
  const dismissRebuiltNote = useCallback(() => {
    const key = rebuiltKeyRef.current
    if (key !== null) rememberRebuiltDismissed(key)
    setRebuiltNote(null)
  }, [])
  const saveTakeoffIntoDrawing = useCallback((docId: string, opts: { quiet?: boolean } = {}): Promise<EmbedOutcome> => {
    const db = dbRef.current
    const doc = documents.find((d) => d.id === docId)
    if (!db || !doc || !projectBridge.desktop) return Promise.resolve({ kind: 'nothing-to-embed' })
    const name = doc.displayName || doc.relativePath
    const tickAtStart = changeTickRef.current
    const run = async (): Promise<EmbedOutcome> => {
      if (light) {
        const load = fileLoadRef.current.get(docId)
        if (load === undefined || load.state === 'blocked') {
          const held: EmbedOutcome = { kind: 'held', reason: load === undefined ? null : load.reason }
          if (opts.quiet !== true && held.reason !== null) setStatus(held.reason)
          return held
        }
      }
      const out = await embedDrawing({
        db, documentId: doc.id, relativePath: doc.relativePath, displayName: name, appVersion: APP_VERSION,
        // Kept between saves and built off this thread: an auto-save must not
        // re-read, re-hash and re-parse an 80 MB set on the window's thread.
        file: keptDrawingFile(projectBridge, projectPath, doc.relativePath),
        embed: embedInWorker,
        // Light: the file's scopes are all of the store's, drawn on or not.
        allScopes: light,
        ...(pageRotationsRef.current.has(docId) ? { pageRotations: pageRotationsRef.current.get(docId)! } : {}),
        ...(light && seenStampRef.current.has(docId) ? { expectStamp: seenStampRef.current.get(docId) ?? null } : {}),
      })
      if ((out.kind === 'written' || out.kind === 'unchanged') && out.stamp !== undefined) seenStampRef.current.set(docId, out.stamp)
      lastSaveRef.current = {
        tick: out.kind === 'written' || out.kind === 'unchanged' ? tickAtStart : (lastSaveRef.current?.tick ?? -1),
        kind: out.kind, at: new Date().toISOString(),
      }
      // A window that only looked has nothing to save over theirs, and nothing to say about it.
      if (out.kind === 'elsewhere' && (undoRef.current?.state.depth ?? 0) === 0) return { kind: 'unchanged' }
      const text = embedStatus(out, name)
      if (opts.quiet === true) {
        // An automatic save speaks only when it could not save, and only once
        // until the next one goes through.
        const refused = out.kind === 'busy' || out.kind === 'failed' || out.kind === 'elsewhere'
        if (!refused) {
          autoEmbedComplainedRef.current.delete(docId)
          if (out.kind === 'written' && out.editedElsewhere.length > 0 && text !== null) setStatus(text)
          return out
        }
        if (autoEmbedComplainedRef.current.has(docId)) return out
        autoEmbedComplainedRef.current.add(docId)
      } else if (out.kind !== 'busy' && out.kind !== 'failed' && out.kind !== 'elsewhere') {
        autoEmbedComplainedRef.current.delete(docId)
      }
      if (text !== null) setStatus(text)
      return out
    }
    const guarded = (): Promise<EmbedOutcome> => {
      const t0 = performance.now()
      return run().catch((err: unknown): EmbedOutcome => (
        { kind: 'failed', message: err instanceof Error ? err.message : String(err) }))
        .then((out) => {
          // Every save is counted with how it ended and how long it took, so a
          // failure rate and a slow save are both visible (src/signals).
          if (out.kind !== 'nothing-to-embed') {
            signal('save', `${opts.quiet === true ? 'auto' : 'manual'}:${out.kind}`,
              out.kind === 'failed' ? out.message : out.kind === 'held' ? (out.reason ?? '') : '', performance.now() - t0)
          }
          return out
        })
    }
    const next = (embedChainRef.current.get(docId) ?? Promise.resolve()).then(guarded, guarded)
    embedChainRef.current.set(docId, next.then(() => undefined))
    return next
  }, [documents, projectPath, setStatus, light])

  /**
   * Light mode's round: one, named after the file, holding every scope.
   *
   * Run once the drawing is in the store and again whenever scopes arrive from
   * outside (the PDF's own, or another PDF's), so none of them sits outside
   * the round where the sidebar would not show it.
   */
  const linkFileRound = useCallback(async () => {
    const db = dbRef.current
    if (!db || !light) return
    const id = await ensureFileRound(db, projectName)
    await refreshEstimates(id)
    setOpenEstimateId((cur) => cur ?? id)
  }, [light, projectName, refreshEstimates])
  addPastedScopesRef.current = async (made: Scope[]) => {
    const db = dbRef.current
    if (!db) return
    for (const sc of made) {
      await upsertScope(db, {
        id: sc.id, label: sc.label, scopeType: sc.scopeType,
        color: sc.color, specifications: sc.specifications, archivedAt: null,
      })
    }
    // Light: the file's one round takes every scope not in a round yet.
    if (light) await linkFileRound()
    else {
      const round = openEstimateIdRef.current
      if (round !== null) for (const sc of made) await addScopeToEstimate(db, round, sc.id)
      await refreshEstimates(round)
    }
    await refreshScopes()
    void broadcastChange('scopes', identity.projectId ?? 'default')
  }
  const roundMadeRef = useRef(false)
  useEffect(() => {
    if (!light || backend === null || roundMadeRef.current) return
    roundMadeRef.current = true
    void linkFileRound()
  }, [light, backend, linkFileRound])

  /**
   * Opening an older project carries its takeoffs into its drawings.
   *
   * Projects from before 0.3.7 keep their takeoff only in redbeam.db. Once the
   * folder scan is done, every drawing with takeoff that has not been carried
   * yet gets it embedded, through the same per-drawing queue as leaving a
   * drawing so the two never write one file at once. redbeam.db is kept as
   * the record; see migrateProjectTakeoffs. Desktop only, main window only
   * (a popped-out context window shares the project), once per open.
   */
  const migratedForRef = useRef<string | null>(null)
  useEffect(() => {
    const db = dbRef.current
    if (!db || scan !== 'done' || !projectBridge.desktop || quickView !== undefined) return
    if (identity.role === 'context') return
    if (migratedForRef.current === projectPath) return
    migratedForRef.current = projectPath
    void (async () => {
      try {
        const result = await migrateProjectTakeoffs({
          db,
          documents,
          appVersion: APP_VERSION,
          fileFor: (doc) => projectDrawingFile(projectBridge, projectPath, doc.relativePath),
          exclusive: (docId, task) => {
            let outcome: Awaited<ReturnType<typeof task>> = { kind: 'unchanged' }
            const run = async () => { outcome = await task() }
            const next = (embedChainRef.current.get(docId) ?? Promise.resolve()).then(run, run)
            embedChainRef.current.set(docId, next)
            return next.then(() => outcome)
          },
          // Closing the project stops the pass; the rest go next open.
          cancelled: () => dbRef.current !== db,
        })
        const text = migrationStatus(result)
        if (text !== null && dbRef.current === db) setStatus(text)
      } catch {
        // redbeam.db still holds everything; leaving each drawing embeds it.
      }
    })()
  }, [scan, documents, projectPath, quickView, identity.role, setStatus])

  /** Leaving a drawing (another tab, or closing it) saves its takeoff into it. */
  const leftDocRef = useRef<string | null>(null)
  /** An AI app asked to close the tab showing, and it has not gone yet. */
  const closingTabRef = useRef(false)
  useEffect(() => {
    const prev = leftDocRef.current
    leftDocRef.current = activeDocId
    if (prev !== null && prev !== activeDocId) void saveTakeoffIntoDrawing(prev)
  }, [activeDocId, saveTakeoffIntoDrawing])

  /**
   * Light: leaving a file whose takeoff could not be saved into it.
   *
   * The store is in memory, so leaving IS losing whatever the PDF does not
   * hold. A refused save (the PDF open in Bluebeam, mid-sync, read-only) used
   * to be followed by the leave anyway. Now the leave waits for an answer.
   */
  const [unsavedAsk, setUnsavedAsk] = useState<{ why: string, leave: (() => void) | null, saving?: boolean } | null>(null)
  /**
   * The leave waiting on a save that is slow to answer. A save that never
   * answered (a stuck worker, a file that never came back) used to hold the
   * close forever with nothing on screen: the X looked dead. Now the person is
   * asked after a few seconds, and any answer frees the close.
   */
  const slowLeaveRef = useRef<{ answered: () => void } | null>(null)
  /** Take the ask down, and let a leave waiting on a slow save stop waiting. */
  const dismissUnsavedAsk = useCallback(() => {
    const slow = slowLeaveRef.current
    slowLeaveRef.current = null
    slow?.answered()
    setUnsavedAsk(null)
  }, [])
  /**
   * Save the takeoff as a copy of the PDF, wherever the person says. Never
   * refused: this is the way out when the PDF itself cannot be written.
   * Resolves true once a copy exists.
   */
  const copyingRef = useRef(false)
  const [copying, setCopying] = useState(false)
  const saveCopyOfFile = useCallback(async (): Promise<boolean> => {
    /*
     * One copy at a time. A copy of an 80 MB set is built in memory; clicks
     * made while one was building each started another, with its own Save
     * window, until the window ran out of memory (0.3.66).
     */
    if (copyingRef.current) return false
    const db = dbRef.current
    const doc = documents.find((d) => d.id === leftDocRef.current)
    if (!db || !doc) return false
    const name = doc.displayName || doc.relativePath
    copyingRef.current = true
    setCopying(true)
    try {
      setStatus(`saving a copy of ${name}…`)
      const copyOpts = {
        db, documentId: doc.id, relativePath: doc.relativePath, displayName: name, appVersion: APP_VERSION,
        allScopes: light,
        ...(pageRotationsRef.current.has(doc.id) ? { pageRotations: pageRotationsRef.current.get(doc.id)! } : {}),
      }
      // A big drawing is copied by the core, with the takeoff appended: never in memory.
      const big = await withRanged(projectBridge, projectPath, doc.relativePath, (d) => copyRanged(d, copyOpts,
        { kind: 'dialog', defaultName: copyName(doc.relativePath), filter: { name: 'PDF drawing', extensions: ['pdf'] } }))
      if (big !== null) {
        setStatus(saveOutcomeText({ path: big.value, downloaded: false }, 'copy with the takeoff'))
        return big.value !== null
      }
      const bytes = await embedCopy({
        ...copyOpts,
        read: () => projectBridge.readDocument(projectPath, doc.relativePath),
        // Built off the window's thread, so the window keeps answering.
        embed: embedInWorker,
      })
      const out = await saveFile(bytes, {
        name: copyName(doc.relativePath), type: 'application/pdf', filter: { name: 'PDF drawing', extensions: ['pdf'] },
      })
      setStatus(saveOutcomeText(out, 'copy with the takeoff'))
      return out.path !== null || out.downloaded
    } catch (err) {
      setStatus(`could not save a copy: ${err instanceof Error ? err.message : String(err)}`)
      return false
    } finally {
      copyingRef.current = false
      setCopying(false)
    }
  }, [documents, projectPath, light, setStatus])
  /** Save the open file, then say whether it is safe to leave it. Pro: always, redbeam.db has it. */
  const saveBeforeLeaving = useCallback(async (leave: () => void, opts?: { closing?: boolean }): Promise<boolean> => {
    const id = leftDocRef.current
    if (id === null) return true
    const saving = saveTakeoffIntoDrawing(id)
    // Only a closing window asks while it waits; a tab change simply waits for its save.
    if (!light || opts?.closing !== true) {
      const out = await saving
      if (!light) return true
      const lost = unsavedReason(out, undoRef.current?.state.depth ?? 0)
      if (lost === null) return true
      setUnsavedAsk({ why: lost, leave })
      return false
    }
    let answered!: () => void
    const answer = new Promise<'answered'>((resolve) => { answered = () => resolve('answered') })
    const slow = { answered }
    const timer = setTimeout(() => {
      slowLeaveRef.current = slow
      setUnsavedAsk({ why: SLOW_SAVE_WHY, leave, saving: true })
    }, SLOW_SAVE_MS)
    const first = await Promise.race([saving, answer])
    clearTimeout(timer)
    // The person already chose (a copy, leaving anyway, or staying): theirs stands.
    if (first === 'answered') return false
    const asked = slowLeaveRef.current === slow
    if (asked) slowLeaveRef.current = null
    const lost = unsavedReason(first, undoRef.current?.state.depth ?? 0)
    if (lost === null) {
      if (asked) setUnsavedAsk(null)
      return true
    }
    setUnsavedAsk({ why: lost, leave })
    return false
  }, [light, saveTakeoffIntoDrawing])
  const leaveSaving = useCallback((leave: () => void) => {
    void saveBeforeLeaving(leave).then((ok) => { if (ok) leave() }, leave)
  }, [saveBeforeLeaving])

  const closeProjectSavingTakeoff = useCallback(() => leaveSaving(onCloseProject), [leaveSaving, onCloseProject])

  /**
   * Light: an older project in this folder still holds takeoff that belongs
   * inside the PDFs.
   *
   * Aaron, 2026-11-19: "the PDF becomes the only truth. If you open a file
   * with an adjacent DB file, transfer the DB file once to the PDF, and then
   * mark the DB file as superseded", and for the other PDFs it covers, "offer
   * to do so as a one-time event." So the PDF being opened takes its own
   * takeoff straight away, before it is read into this window, and the rest
   * are offered in the warning bar. Once nothing is left the database is set
   * aside under .redbeam, never deleted.
   */
  const [oldOffer, setOldOffer] = useState<number | null>(null)
  const oldBusyRef = useRef(false)
  const transferFromOldProject = useCallback(async (which: 'opened' | 'rest', openedName: string | null): Promise<void> => {
    if (!projectBridge.desktop || oldBusyRef.current) return
    oldBusyRef.current = true
    try {
      const found = await projectBridge.findOldProject(projectPath)
      if (found === null) { setOldOffer(null); return }
      const old = await openOldProjectDatabase(found.root)
      let result: TransferResult
      let remaining: number
      let others: number
      try {
        const todo = await drawingsToTransfer(old.driver)
        const openedPath = openedName === null ? null : `${found.prefix}${openedName}`.toLowerCase()
        let opened = todo.find((d) => d.relativePath.toLowerCase() === openedPath)
        // Scopes set up and never drawn in have no PDF of their own: this one takes them.
        if (opened === undefined && which === 'opened' && openedPath !== null && (await undrawnPending(old.driver)).length > 0) {
          opened = await oldDrawingAt(old.driver, openedPath)
        }
        result = await transferOldProject({
          old: old.driver,
          /*
           * The open PDF is only ever written before this window reads it. If
           * it could not take its takeoff then, it waits for the next open:
           * written now, this window's next save would put its own, older
           * picture of the file back over it.
           */
          drawings: which === 'rest' ? todo.filter((d) => d !== opened) : opened === undefined ? [] : [opened],
          appVersion: APP_VERSION,
          fileFor: (d) => projectDrawingFile(projectBridge, found.root, d.relativePath),
        })
        const left = await drawingsToTransfer(old.driver)
        // Undrawn scopes with no PDF to ride in do not hold the database back once every drawing is done.
        remaining = left.length
        others = left.filter((d) => d.relativePath.toLowerCase() !== openedPath).length
      } finally {
        await old.close().catch(() => undefined)
      }
      let setAside = false
      if (transferComplete(result, remaining)) {
        // A database that will not move (still open in another window) is tried again next time.
        try { await projectBridge.supersedeOldProject(found.root); setAside = true } catch { /* kept where it is */ }
      }
      setOldOffer(others > 0 ? others : null)
      const text = transferStatus(result, setAside)
      if (text !== null) setStatus(text)
    } finally {
      oldBusyRef.current = false
    }
  }, [projectPath, setStatus])

  /**
   * Opening a drawing reads what it carries. A takeoff embedded elsewhere comes
   * into a project that has nothing on that drawing yet; redbeam.db stays the
   * record otherwise. Each drawing is read once per session.
   */
  const embedCheckedRef = useRef(new Set<string>())
  useEffect(() => {
    const db = dbRef.current
    const doc = documents.find((d) => d.id === activeDocId)
    if (!db || !doc || !projectBridge.desktop) return
    const firstLook = !embedCheckedRef.current.has(doc.id)
    embedCheckedRef.current.add(doc.id)
    void (async () => {
      try {
        const name = doc.displayName || doc.relativePath
        if (light && firstLook) {
          // Before the file is read: what an older project holds for it goes into it first.
          try { await transferFromOldProject('opened', doc.relativePath) } catch { /* the PDF opens as it is */ }
        }
        let reading: Awaited<ReturnType<typeof readSheetEmbed>>
        try {
          // A big set is read by range: only the objects the takeoff lives in.
          reading = await readEmbedRanged(projectBridge, projectPath, doc.relativePath)
            ?? await readSheetEmbed(await projectBridge.readDocument(projectPath, doc.relativePath))
        } catch (err) {
          if (light && firstLook) {
            const reason = `REDBEAM could not read what ${name} carries (${err instanceof Error ? err.message : String(err)}), so REDBEAM will not save into it. What you draw here can be saved as a copy.`
            fileLoadRef.current.set(doc.id, { state: 'blocked', reason })
            setLoadBlock(reason)
          }
          return
        }
        if (light && firstLook) seenStampRef.current.set(doc.id, sliceStamp(reading.slice))
        /*
         * Bluebeam's areas and lengths become REDBEAM markups (export/adopt.ts).
         * After the slice is in: importing it needs a drawing with no markups.
         * Never into a file that is blocked, which is never saved.
         */
        const adopt = async (found: Awaited<ReturnType<typeof readSheetEmbed>>) => {
          if (!light || !firstLook || fileLoadRef.current.get(doc.id)?.state === 'blocked') return
          let result: Awaited<ReturnType<typeof adoptForeignAnnots>>
          try { result = await adoptForeignAnnots(db, doc.id, found) } catch { return }
          if (result.nms.length === 0 && result.heldNms.length === 0) return
          adoptedNmsRef.current.set(doc.id, new Set(result.nms))
          heldNmsRef.current.set(doc.id, new Set(result.heldNms))
          if (result.heldNms.length > 0) {
            // Where each held markup sits in the file as opened: what the
            // viewer draws until one is moved or recoloured here.
            try {
              const rows = await listMarkups(db, { documentId: doc.id, reviewStates: ['accepted'] })
              for (const r of rows) {
                if (r.kind !== 'annot') continue
                const m = { id: r.id, scopeId: null, documentId: r.documentId, pageId: r.pageId, kind: 'annot', rings: r.rings, content: r.content } as Markup
                heldOpenRef.current.set(r.id, heldStateKey(m))
              }
            } catch { /* each is recorded when its sheet is first shown */ }
          }
          if (result.added > 0) await syncMarkups()
          if (docIdRef.current === doc.id && viewerRef.current !== null) hideOwnAnnots(viewerRef.current, pageIndexRef.current)
          const taken = result.added - result.held
          if (taken > 0) {
            setStatus(`${taken} Bluebeam markup${taken === 1 ? '' : 's'} in ${name} came in pending, dashed and counted nowhere. Give one a scope, or use Accept imported markups, to count it.`)
          } else if (result.held > 0) {
            setStatus(`${result.held} markup${result.held === 1 ? '' : 's'} from Bluebeam or another app in ${name} can be selected, moved, recoloured and deleted here. Saving writes the change into the PDF.`)
          }
        }
        if (reading.slice === null && !reading.privateDataLost && !reading.sliceTooNew) {
          // A PDF with nothing of REDBEAM's in it: there is nothing to wait for.
          if (light && firstLook) fileLoadRef.current.set(doc.id, { state: 'loaded' })
          await adopt(reading)
          return
        }
        if (firstLook) {
          let imported: Awaited<ReturnType<typeof importSlice>>
          try {
            imported = reading.slice === null ? null : await importSlice(db, doc.id, reading.slice)
          } catch (err) {
            if (!light) throw err
            const reason = `The takeoff inside ${name} could not be loaded (${err instanceof Error ? err.message : String(err)}). REDBEAM will not save into it, so it stays as it is; what you draw here can be saved as a copy.`
            fileLoadRef.current.set(doc.id, { state: 'blocked', reason })
            setLoadBlock(reason)
            return
          }
          /*
           * A project that already has this drawing's takeoff still takes the
           * PDF's when the PDF's is newer: someone in Light mode (or another
           * job folder) changed it since this project last saved it.
           */
          if (imported === null && reading.slice !== null && !light) {
            imported = await takeNewerSlice(db, doc.id, reading.slice)
            if (imported !== null) saveRef.current?.()
          }
          if (light) {
            // Decided before anything else can throw: an undecided file is never saved.
            /*
             * Another app kept REDBEAM's markups and dropped what said what
             * they were: the takeoff is put back together from the markups.
             * A file it cannot do that for stays blocked, as it was found.
             */
            let rebuilt: Awaited<ReturnType<typeof rebuildFromAnnots>> = null
            if (reading.privateDataLost) {
              try { rebuilt = await rebuildFromAnnots(db, doc.id, reading) } catch { rebuilt = null }
            }
            const verdict = fileLoadVerdict(reading, imported, name, rebuilt)
            fileLoadRef.current.set(doc.id, verdict)
            setLoadBlock(verdict.state === 'blocked' ? verdict.reason : null)
            const rebuiltKey = rebuilt === null ? null : `${quickView?.file ?? doc.relativePath}|${rebuilt.markups}|${rebuilt.scopes}`
            rebuiltKeyRef.current = rebuiltKey
            setRebuiltNote(rebuilt === null || rebuiltKey === null || rebuiltDismissed(rebuiltKey) ? null : rebuiltStatus(rebuilt, name))
            await linkFileRound()
            if (rebuilt !== null) {
              await syncMarkups()
              await refreshScopes()
            }
          }
          if (imported !== null && (imported.markups > 0 || imported.scopes > 0)) {
            await syncMarkups()
            await refreshScopes()
          }
          // The title block boxes and sheet names came in with the slice.
          if (imported !== null && docIdRef.current === doc.id) await loadTitleMetaRef.current()
          // A blocked Light file says so in the warning bar; redbeam.db is not where its markups are.
          const text = light && (fileLoadRef.current.get(doc.id)?.state === 'blocked' || reading.privateDataLost) ? null : openingStatus(reading, imported, name)
          if (text !== null) setStatus(text)
          await adopt(reading)
        }
        /*
         * Every time the drawing comes to the front, not only the first: what
         * was changed in Bluebeam since (a vertex moved, a cutout added) comes
         * back into REDBEAM's markups, as one undoable step. Only markups
         * REDBEAM has not changed since it wrote them; the rest are reported.
         */
        const rows = await db.all<{ id: string, kind: string, scope_id: string | null, geometry_json: string, page_id: string }>(
          'SELECT id, kind, scope_id, geometry_json, page_id FROM markups WHERE document_id = ? AND deleted_at IS NULL', [doc.id])
        const pulled = foreignEdits(reading, rows)
        const cmds = [
          ...pulled.edits.map((e) => cmdEditGeometry(e.markupId, e.before, e.after, 'changed in Bluebeam')),
          ...pulled.absorbed.flatMap((id) => {
            const r = rows.find((x) => x.id === id)
            return r === undefined ? [] : [cmdRemove({ id, kind: r.kind, origin: 'user', documentId: doc.id, pageId: r.page_id })]
          }),
        ]
        if (cmds.length > 0) {
          await runCommand(cmds.length === 1 ? cmds[0]! : cmdBatch('changes made in Bluebeam', cmds))
          await syncMarkups()
        }
        const text = foreignEditsStatus(pulled, name)
        if (text !== null) setStatus(text)

        /*
         * Cutouts drawn before cuts were part of the area (0.3.34) are folded
         * into the areas they open, so they move with them and go to Bluebeam
         * as the area's own cutouts. One undo step puts them back.
         */
        const now = await db.all<{ id: string, kind: string, scope_id: string | null, geometry_json: string, page_id: string }>(
          'SELECT id, kind, scope_id, geometry_json, page_id FROM markups WHERE document_id = ? AND deleted_at IS NULL AND kind IN (\'area\', \'cutout\')', [doc.id])
        if (now.some((r) => r.kind === 'cutout')) {
          const asMarkups: Markup[] = now.map((r) => {
            let rings: Markup['rings'] = []
            try { rings = JSON.parse(r.geometry_json) as Markup['rings'] } catch { rings = [] }
            return { id: r.id, scopeId: r.scope_id, documentId: doc.id, pageId: r.page_id, kind: r.kind as Markup['kind'], rings }
          })
          const { edits, folded } = foldCutouts(asMarkups)
          if (folded.length > 0) {
            const what = 'cutouts made part of their areas'
            const foldCmds = [
              ...edits.map((e) => cmdEditGeometry(e.id, e.before, e.after, what)),
              ...folded.map((c) => cmdRemove({ id: c.id, kind: c.kind, origin: 'user', documentId: doc.id, pageId: c.pageId })),
            ]
            await runCommand(cmdBatch(what, foldCmds))
            await syncMarkups()
            setStatus(`${folded.length} cutout${folded.length === 1 ? ' is' : 's are'} now part of ${folded.length === 1 ? 'its area' : 'their areas'} in ${name} (Ctrl+Z undoes)`)
          }
        }
      } catch {
        // A drawing that cannot be read here is the viewer's to report.
      }
    })()
  }, [activeDocId, documents, projectPath, syncMarkups, refreshScopes, setStatus, runCommand, light, linkFileRound, transferFromOldProject, hideOwnAnnots])

  /**
   * Light mode: bring last round's scopes in from its PDF.
   *
   * Aaron, 2026-11-18: "import scopes from a previous PDF file into a new PDF
   * file. This will be used for rounds of bidding." Names, colours and
   * specifications come across; the markups do not. Saved into this PDF with
   * the next save, like any scope made here.
   */
  const importScopesFromPdf = useCallback(async (fromPath?: string): Promise<string> => {
    const db = dbRef.current
    if (!db) return 'no document is open'
    const pick = fromPath !== undefined ? { path: fromPath, supported: true, reason: null } : await projectBridge.pickFile()
    if (pick.path === null) {
      if (!pick.supported && pick.reason !== null) setStatus(pick.reason)
      return pick.reason ?? 'no file was chosen'
    }
    const cut = Math.max(pick.path.lastIndexOf('\\'), pick.path.lastIndexOf('/'))
    const folder = pick.path.slice(0, cut)
    const name = pick.path.slice(cut + 1)
    try {
      const reading = await readEmbedRanged(projectBridge, folder, name) ?? await readSheetEmbed(await projectBridge.readDocument(folder, name))
      if (reading.slice === null) { const none = `${name} carries no REDBEAM scopes`; setStatus(none); return none }
      const result = await importScopesFromSlice(db, reading.slice)
      await linkFileRound()
      await refreshScopes()
      saveRef.current?.()
      setWorkOpen(true)
      const said = scopeImportStatus(result, name)
      setStatus(said)
      return said
    } catch (err) {
      const said = `could not read scopes from ${name}: ${err instanceof Error ? err.message : String(err)}`
      setStatus(said)
      return said
    }
  }, [linkFileRound, refreshScopes, setStatus])

  /**
   * Light mode: start this file from another PDF's takeoff, markups included.
   *
   * Aaron, 2026-11-19: "copying markups and scope information from one set to
   * another in Light mode is, in essence, copying an old estimate to a new
   * estimate in Pro mode." A markup lands on the sheet with the same number
   * when that sheet is the same size here; the rest are counted and left.
   */
  const startFromPdf = useCallback(async (fromPath?: string): Promise<string> => {
    const db = dbRef.current
    const doc = documents.find((d) => d.id === activeDocId)
    if (!db || !doc) return 'no document is open'
    const pick = fromPath !== undefined ? { path: fromPath, supported: true, reason: null } : await projectBridge.pickFile()
    if (pick.path === null) {
      if (!pick.supported && pick.reason !== null) setStatus(pick.reason)
      return pick.reason ?? 'no file was chosen'
    }
    const cut = Math.max(pick.path.lastIndexOf('\\'), pick.path.lastIndexOf('/'))
    const folder = pick.path.slice(0, cut)
    const name = pick.path.slice(cut + 1)
    try {
      const reading = await readEmbedRanged(projectBridge, folder, name) ?? await readSheetEmbed(await projectBridge.readDocument(folder, name))
      if (reading.slice === null) { const none = `${name} carries no REDBEAM takeoff`; setStatus(none); return none }
      const sizes = (await withRanged(projectBridge, projectPath, doc.relativePath, (big) => big.sizes()))?.value
        ?? await sheetSizes(await projectBridge.readDocument(projectPath, doc.relativePath))
      const result = await importTakeoffFromSlice(db, doc.id, reading.slice, sizes)
      await linkFileRound()
      await refreshScopes()
      await syncMarkups()
      saveRef.current?.()
      setWorkOpen(true)
      const said = takeoffImportStatus(result, name)
      setStatus(said)
      return said
    } catch (err) {
      const said = `could not copy the takeoff from ${name}: ${err instanceof Error ? err.message : String(err)}`
      setStatus(said)
      return said
    }
  }, [documents, activeDocId, projectPath, linkFileRound, refreshScopes, syncMarkups, setStatus])

  /** Light mode: save now, then hand the window to another PDF. */
  const openAnotherFile = useCallback(() => {
    const go = quickView?.onOpenAnother
    if (go === undefined) return
    // With tabs this file stays open, and the app saves it as the new tab comes up.
    if (quickView?.tabs !== undefined) go()
    else leaveSaving(go)
  }, [quickView, leaveSaving])
  const lightTabs = quickView?.tabs
  const agentsNow = useAgents()
  const saveOpenFile = useCallback(() => {
    const id = leftDocRef.current
    if (id === null) return
    const asked = Date.now()
    void saveTakeoffIntoDrawing(id).then((out) => {
      // Ctrl+S always ends in a save: into the PDF, or as a copy when the PDF cannot take it.
      if (light && (out.kind === 'busy' || out.kind === 'failed' || out.kind === 'held' || out.kind === 'elsewhere')) {
        setUnsavedAsk({ why: unsavedReason(out, 1) ?? 'The takeoff could not be saved into the PDF.', leave: null })
        return
      }
      // A write says so itself; silence means the PDF already held all of it.
      if (statusAtRef.current < asked) setStatus('everything is already saved in this PDF')
    })
  }, [saveTakeoffIntoDrawing, setStatus, light])
  useEffect(() => {
    if (!light || onBeforeClose === undefined) return
    onBeforeClose(saveBeforeLeaving)
    return () => onBeforeClose(null)
  }, [light, onBeforeClose, saveBeforeLeaving])
  useEffect(() => {
    if (!light) return
    const onKey = (e: KeyboardEvent) => {
      if (!showingRef.current) return
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      const k = e.key.toLowerCase()
      // Tabs, as a browser and Bluebeam have them.
      if (lightTabs !== undefined) {
        if (k === 'tab') { e.preventDefault(); lightTabs.onStep(e.shiftKey ? -1 : 1); return }
        if (k === 'w' && !e.shiftKey) { e.preventDefault(); lightTabs.onClose(quickView!.file); return }
        if (k === 't' && e.shiftKey) { e.preventDefault(); lightTabs.onReopen(); return }
      }
      if (e.shiftKey) return
      if (k === 's') { e.preventDefault(); saveOpenFile() }
      else if (k === 'o') { e.preventDefault(); openAnotherFile() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [light, saveOpenFile, openAnotherFile, lightTabs, quickView])

  /** Live markup counts per scope, for the shelf and the archive warning. */
  /**
   * From the PROJECT's markups, not the open page's. Every reader of this —
   * the round's scope rows, the dock popover, the palette's remove row —
   * means "how much takeoff is in this scope", and the page-scoped count
   * read 0 for every scope whose sheets were not the one on screen.
   */
  const markupCounts = useMemo(() => {
    const out: Record<string, number> = {}
    for (const m of projectMarkups) if (m.scopeId) out[m.scopeId] = (out[m.scopeId] ?? 0) + 1
    return out
  }, [projectMarkups])

  const onDoubleClick = (e: React.MouseEvent) => {
    if (tool === 'area' || tool === 'cutout' || tool === 'shape' || tool === 'polyline') void commitDraft()
    if (isNoteTool(tool)) { applyNoteStep(noteFinish(noteDraftRef.current)); return }
    // A text box or a leader, double-clicked, opens its text for typing.
    if (tool === 'pan' || tool === 'select') {
      const r0 = e.currentTarget.getBoundingClientRect()
      const hit = hitNoteAt(e.clientX - r0.left, e.clientY - r0.top)
      const m = hit === null ? undefined : markupsRef.current.find((x) => x.id === hit.markupId)
      const shape = m === undefined ? undefined : parseNoteContent((m as { content?: unknown }).content)?.shape
      if (m !== undefined && shape !== undefined && hasText(shape)) {
        setNoteEdit({ id: m.id, isNew: false })
        requestPaint()
      }
    }
  }

  /**
   * Answer the automation bridge.
   *
   * Everything here reads the same state the UI renders from, so what an agent
   * is told is what a person would see — a separate reporting path is how a
   * bridge starts describing an app that no longer exists.
   */
  /**
   * Show a page for an agent and wait until it is the one on screen, so the
   * next step (a close-up, a zoom) acts on it and not on the sheet before.
   */
  /**
   * Who the bridge call being answered is from, and whether it may move this
   * PDF's view (bridge/useBridgeRequests.ts `CallContext`). Calls for one PDF
   * run one at a time (agents/router.ts), so one ref is enough.
   */
  const agentCtxRef = useRef<CallContext>(UNNAMED_CALL)
  /**
   * Each AI session's own view of this PDF: the sheet it is on, the box it
   * framed, what it selected, the scale region it is half way through.
   *
   * Aaron, 2026-11-26: "I can be navigating around, and then the agent steals
   * focus and jumps to where it's working ... the agent should also not need
   * to request approval to work within a sheet. It should be able to just
   * jump in and make changes." Until now a call worked through the sheet on
   * screen, so an agent either moved the person's view or asked for the tab.
   * Now the sheet, zoom, tool, selection and panels on screen are the
   * person's, a session's calls read and write through its own view, and
   * nothing is asked. A session starts on the sheet showing when it first
   * calls. Calls with no session (the sweep, old scripts) drive the window as
   * before.
   */
  const agentViewsRef = useRef(new Map<string, AgentView>())
  const agentView = (): AgentView | null => {
    const id = agentCtxRef.current.agent?.id
    if (id == null) return null
    let view = agentViewsRef.current.get(id)
    if (view === undefined) {
      view = { page: pageIndexRef.current, rect: null, selected: [], pendingRegion: null, embedded: true, redbeam: true, tool: 'pan', layoutOn: false }
      agentViewsRef.current.set(id, view)
    }
    if (view.page >= pageCount && pageCount > 0) view.page = 0
    return view
  }
  lookInRef.current = () => {
    const who = quickView === undefined ? undefined : takeLookIn(quickView.file)
    const view = who === undefined ? undefined : agentViewsRef.current.get(who)
    if (view !== undefined && view.page !== pageIndexRef.current && view.page < pageCount) goToPage(view.page)
  }
  /** The sheet the call being answered is about: its session's, or the one showing. */
  const ap = {
    get index(): number { return agentView()?.page ?? pageIndexRef.current },
    get id(): string {
      const targetPage = this.index
      return pageIdFor(docIdRef.current, targetPage)
    },
    get size(): { width: number; height: number } {
      const at = this.index
      if (at === pageIndexRef.current && page.width > 0) return { width: page.width, height: page.height }
      const s = viewerRef.current?.getPageSize(at) ?? pageSizesRef.current[at]
      return { width: s?.width ?? 0, height: s?.height ?? 0 }
    },
    get feetPerPoint(): number | null {
      if (agentView() === null) return calRef.current?.feetPerPoint ?? null
      return projectCalibrationsLatest.current.get(this.id) ?? null
    },
    get markups(): Markup[] {
      if (agentView() === null) return markupsRef.current
      const here = this.id
      return docMarkupsRef.current.filter((m) => m.pageId === here)
    },
  }
  /**
   * The scope each agent is working in while it is a guest in this PDF.
   *
   * Aaron, 2026-11-24: "I can be doing a manual takeoff while the agent
   * searches for references to a scope and highlights them for me." The
   * active scope is where the PERSON's next stroke lands. An agent drawing
   * beside them in the same PDF has a scope of its own, and never changes
   * theirs.
   */
  const guestScopeRef = useRef(new Map<string, string>())
  /** The scope a call means when it names none: the active one in a tab its caller drives, its own otherwise. */
  const agentScope = (): string | null => {
    const ctx = agentCtxRef.current
    if (ctx.agent == null) return activeScopeRef.current
    // In a tab of its own, with no scope of its own picked yet, the tab's active one.
    return guestScopeRef.current.get(ctx.agent.id) ?? (ctx.drives ? activeScopeRef.current : null)
  }
  /*
   * A sheet's row in the store is written the first time the sheet is shown,
   * and by the search index as it works through the set. An agent writes to
   * sheets nobody has shown, in a tab that may never have been on screen: a
   * scale there failed with "FOREIGN KEY constraint failed", and a batch of
   * markups across six sheets kept only the first sheet's (SLS benchmark,
   * 2026-11-25). So every sheet a call names has its row before the call runs.
   */
  const ensurePageRows = async (pages: readonly number[]): Promise<void> => {
    const db = dbRef.current
    if (db === null || pages.length === 0) return
    const doc = documents.find((d) => d.id === docIdRef.current) ?? FALLBACK_DOC
    // `targetPage`: sheets the call named, not a read of the one showing.
    await runBatch(db, pages.flatMap((targetPage) => ensureDocumentAndPageStatements(doc, {
      id: pageIdFor(doc.id, targetPage), documentId: doc.id, pageNumber: targetPage,
      width: pageSizesRef.current[targetPage]?.width ?? 0, height: pageSizesRef.current[targetPage]?.height ?? 0,
    })))
  }
  ensurePageRowsRef.current = ensurePageRows
  const showPageForAgent = async (n: number): Promise<void> => {
    if (!Number.isInteger(n) || n < 0 || n >= pageCount) throw new Error(`page ${n} out of range (0..${pageCount - 1})`)
    // A session turns ITS sheet. The one on screen is the person's and stays.
    const view = agentView()
    if (view !== null) {
      if (view.page !== n) { view.page = n; view.rect = null; view.selected = [] }
      return
    }
    if (n === pageIndexRef.current && (viewerRef.current?.pageInfo.width ?? 0) > 0) return
    goToPage(n)
    if (await until(() => pageIndexRef.current === n && (viewerRef.current?.pageInfo.width ?? 0) > 0, 10_000)) {
      // One more beat for the fit that follows a page change.
      await pause(150)
      return
    }
    throw new Error(`page ${n} did not show within 10s`)
  }

  /** The areas an agent's call is about: by id, by a point, or every area of the scope on this sheet. */
  /** A refusal that names the scopes there are, so the next call can be right. */
  /*
   * ---- custom patterns (beta): helpers for the bridge ----
   */
  const patternsOff = (): Record<string, unknown> | null => prefsRef.current['beta.customPatterns'] === true ? null : {
    error: 'Custom patterns are a beta feature and it is off. The person turns it on in Settings › Beta › Custom patterns '
      + '(or, if they asked you to, redbeam_set_setting {id:"beta.customPatterns", value:true}).',
    setting: 'beta.customPatterns',
  }
  /*
   * What an agent sends is a draft, whatever it says. On a scope whose
   * pattern a person already approved, the layers that are unchanged keep
   * that approval and only what is new or changed waits for them, so adding
   * rails never reopens the panels (the design Aaron approved, 2026-11-25).
   */
  const asAgentDraft = (recipe: PatternRecipe, sc: Scope, by: string): PatternRecipe => {
    const prior = checkPatternRecipe(readPatternRecipe(sc.specifications))
    const base: PatternRecipe = { ...recipe, source: recipe.source ?? by }
    delete base.approvedBy
    delete base.approvedAt
    if (prior.ok && prior.recipe.status === 'approved' && readProductType(sc.specifications) === 'custom_pattern') {
      const same = (l: PatternRecipe['layers'][number]) => {
        const old = prior.recipe.layers.find((o) => o.id === l.id)
        if (old === undefined || old.status === 'draft') return false
        const strip = (x: object) => JSON.stringify({ ...x, status: undefined, source: undefined })
        return strip(old) === strip(l)
      }
      return {
        ...base, status: 'approved',
        approvedBy: prior.recipe.approvedBy ?? '', approvedAt: prior.recipe.approvedAt ?? '',
        layers: base.layers.map((l) => (same(l) ? { ...l, status: 'approved' as const } : { ...l, status: 'draft' as const, source: l.source ?? by })),
      }
    }
    return { ...base, status: 'draft', layers: base.layers.map((l) => { const { status: _s, ...rest } = l; void _s; return rest as typeof l }) }
  }
  /*
   * The scope as the window holds it once a write has come back from the
   * store. scopesRef follows React state, a render behind the write, so a
   * call that writes and then reads (create_scope then saving its recipe,
   * update_scope then answering) waited for nothing and read the scope as it
   * was (SLS, 0.3.102: "no such scope" for the id just made, and a stale
   * productType in update_scope's answer).
   */
  const scopeWhen = async (id: string, ready: (sc: Scope) => boolean): Promise<Scope | undefined> => {
    // As soon as it is there: no poll interval, and no timer a covered window slows (agents/wait.ts).
    await until(() => { const sc = scopesRef.current.find((x) => x.id === id); return sc !== undefined && ready(sc) }, 10_000)
    return scopesRef.current.find((x) => x.id === id)
  }
  /**
   * The scope's counts once the layout has caught up with THIS recipe.
   *
   * It used to take the first result for the scope that had the recipe's name
   * or any blocker, which was often the one from before the save (NOIC,
   * 2026-11-26): a save reported the old "pick one from the library" blocker
   * though it had worked, and a resave of CL114 reported 51 clouds from the
   * previous recipe when the new one laid out 34. Now only a result computed
   * from the recipe that was sent counts. If the layout is still working when
   * the wait ends, it says so instead of handing back old numbers.
   */
  const settledPieces = async (scopeId: string, recipe: unknown): Promise<PieceResult | 'pending' | undefined> => {
    // Key order is not part of a recipe: the store may hand it back reordered.
    const stable = stableJson
    const want = stable(recipe)
    const current = () => {
      const e = piecesRef.current.find((p) => p.scope.id === scopeId)
      return e !== undefined && readProductType(e.scope.specifications) === 'custom_pattern'
        && stable(e.scope.specifications[PATTERN_RECIPE_KEY]) === want ? e.result : undefined
    }
    await until(() => current() !== undefined, 30_000)
    return current() ?? (piecesRef.current.some((p) => p.scope.id === scopeId) ? 'pending' : undefined)
  }
  /*
   * What decides where each area's layout starts, read back as the layout
   * uses it (NOIC, 2026-11-26: "Lay each area out on its own" read Off, yet
   * the start points placed per area took effect, and the agent could not
   * tell which was wrong). Neither was: a start point placed on an area
   * always wins, and an area with none starts at the corner `patternStart`
   * names. The per-area switch only matters when that is automatic.
   */
  const layoutSettingsAnswer = (): Record<string, unknown> => {
    const start = prefsRef.current['takeoff.patternStart'] ?? 'top-left'
    const automatic = start === 'automatic'
    const perArea = prefsRef.current['takeoff.perAreaOrigin'] === true
    let placed = 0
    for (const sc of scopesRef.current) placed += areaOriginsFrom(sc.specifications).size
    return {
      'takeoff.patternStart': start,
      'takeoff.perAreaOrigin': perArea,
      'takeoff.layoutPreview': prefsRef.current['takeoff.layoutPreview'] === true,
      areasWithPlacedStart: placed,
      edgeSnap: '1" (an area edge within 1" of a module line is on it; a pattern recipe can set its own edgeSnap)',
      howStartsAreChosen: [
        'An area with a start point placed on it (set_pattern_origin, or the Origin tool) starts there, whatever the settings say.',
        automatic
          ? `Other areas: automatic. ${perArea ? 'Panels start a whole panel at each area\'s own edge (perAreaOrigin on).' : 'Panels share one grid across the sheet (perAreaOrigin off).'} Runs pick the phase with the fewest pieces per area either way.`
          : `Other areas start at their own ${String(start)} corner, each on its own; perAreaOrigin has no effect unless patternStart is automatic.`,
      ],
    }
  }
  const patternAnswer = (r: PieceResult | 'pending' | undefined): Record<string, unknown> => {
    if (r === undefined) return { note: 'the scope has no calibrated sheet yet, so nothing could be counted' }
    if (r === 'pending') return { counting: 'still laying out this recipe; read the counts with redbeam_get_pattern or redbeam_get_bom in a moment' }
    if (r.blockers.length > 0) return { blockers: r.blockers }
    const layers = (r.layers ?? []).map((l) => ({
      id: l.id, name: l.name, kind: l.kind, draft: l.draft,
      quantities: r.quantities.filter((q) => q.layer === l.name).map((q) => ({ item: q.itemKey, label: q.label, quantity: q.quantity, unit: q.unit })),
    }))
    return { layers, confidence: r.confidence ?? 'verified', drawn: (r.shapes?.length ?? 0) + r.cells.length + r.runs.length }
  }
  /*
   * ---- custom patterns (beta): the person's side, in the scope's setup ----
   * Approval only ever happens here, by a person. Every change goes through
   * saveScope, so it is one undoable step saved in the PDF.
   */
  const withRecipe = (scopeId: string, change: (r: PatternRecipe, sc: Scope) => PatternRecipe | null): void => {
    const sc = scopesRef.current.find((x) => x.id === scopeId)
    if (sc === undefined) return
    const c = checkPatternRecipe(readPatternRecipe(sc.specifications))
    if (!c.ok) return
    const next = change(c.recipe, sc)
    if (next === null) return
    void saveScope({ ...sc, specifications: { ...sc.specifications, [PATTERN_RECIPE_KEY]: next } })
  }
  const setRecipe = (scopeId: string, recipe: PatternRecipe): void => {
    const sc = scopesRef.current.find((x) => x.id === scopeId)
    if (sc === undefined) return
    const specs = writeProductType({ ...sc.specifications, [PATTERN_RECIPE_KEY]: recipe }, 'custom_pattern')
    void saveScope({ ...sc, scopeType: 'area', specifications: specs })
  }
  const today = (): string => new Date().toISOString().slice(0, 10)
  const patternControls: PatternControls = {
    enabled: prefs['beta.customPatterns'] === true,
    library: readLibrary().map((e) => ({ id: e.id, name: e.recipe.name, version: e.version })),
    hiddenLayers,
    onToggleLayer: (scopeId, layerId) => setHiddenLayers((m) => {
      const next = new Map(m)
      const set = new Set(next.get(scopeId) ?? [])
      if (set.has(layerId)) set.delete(layerId)
      else set.add(layerId)
      next.set(scopeId, set)
      return next
    }),
    onApprove: (scopeId, addToLibrary) => withRecipe(scopeId, (r) => {
      setPatternPreviews((m) => { if (!m.has(scopeId)) return m; const n = new Map(m); n.delete(scopeId); return n })
      const approved = approvePatternRecipe(r, 'You', today())
      return addToLibrary ? saveToLibrary(approved, 'You', today()) : approved
    }),
    onApproveLayer: (scopeId, layerId) => withRecipe(scopeId, (r) => approvePatternLayer(r, layerId)),
    onDiscardLayer: (scopeId, layerId) => withRecipe(scopeId, (r) => removePatternLayer(r, layerId)),
    onDiscard: (scopeId) => {
      const sc = scopesRef.current.find((x) => x.id === scopeId)
      if (sc === undefined) return
      setPatternPreviews((m) => { if (!m.has(scopeId)) return m; const n = new Map(m); n.delete(scopeId); return n })
      const specs: Record<string, unknown> = { ...sc.specifications }
      delete specs[PATTERN_RECIPE_KEY]
      void saveScope({ ...sc, specifications: writeProductType(specs, 'panels') })
    },
    onUsePattern: (scopeId, patternId) => {
      const e = libraryEntry(patternId)
      if (e !== undefined) setRecipe(scopeId, e.recipe)
    },
    onUpdateFromLibrary: (scopeId) => withRecipe(scopeId, (r) => {
      const e = newerInLibrary(r)
      return e === null ? null : e.recipe
    }),
    onMakePattern: (scopeId) => {
      const sc = scopesRef.current.find((x) => x.id === scopeId)
      if (sc === undefined) return
      const r = builtInAsRecipe(sc.specifications, `${sc.label} ${productLabelFor(sc.specifications).toLowerCase()}`)
      if (r !== null) setRecipe(scopeId, r)
    },
    newerVersion: (recipe) => newerInLibrary(recipe)?.version ?? null,
  }
  const noScope = (id: string | null): { error: string; scopes: Array<{ scopeId: string; label: string }> } => ({
    error: `no such scope: ${id === null || id === '' ? '(none given, and none is active)' : id}. Use a scopeId from \`scopes\`, or create_scope`,
    scopes: scopesRef.current.slice(0, 60).map((x) => ({ scopeId: x.id, label: x.label })),
  })
  /**
   * The grid drawn in an area (or a box) of the sheet showing, with its
   * module in points, feet and inches at the scale there.
   */
  const agentGridIn = async (
    where: Markup | { x0: number; y0: number; x1: number; y1: number }, angle: unknown,
  ): Promise<{ grid: NonNullable<ReturnType<typeof detectGrid>>; modules: Record<string, unknown>; fpp: number | null } | { error: string }> => {
    const v = viewerRef.current
    if (!v || ap.size.width === 0) return { error: 'no page is showing' }
    const here = ap.id
    const isArea = 'rings' in where
    if (isArea && where.pageId !== here) return { error: `area ${where.id} is on another sheet; turn to it first with redbeam_go_to_page` }
    const r = isArea ? normalizedBoundingRect(where.rings) : { left: Math.min(where.x0, where.x1), right: Math.max(where.x0, where.x1), top: Math.min(where.y0, where.y1), bottom: Math.max(where.y0, where.y1) }
    if (r === null) return { error: 'that area has no outline' }
    const pad = 0.002
    const clip = { x0: Math.max(0, r.left - pad), y0: Math.max(0, r.top - pad), x1: Math.min(1, r.right + pad), y1: Math.min(1, r.bottom + pad) }
    const geo = await v.requestGeometry(ap.index, { clip, priority: PRIORITY_THUMBNAIL, maxSegments: 400_000 })
    const a = Number(angle)
    const grid = detectGrid(geo.segments, ap.size, {
      ...(isArea ? { rings: where.rings } : { box: clip }),
      ...(angle !== undefined && angle !== null && Number.isFinite(a) ? { angle: a } : {}),
    })
    if (grid === null) return { error: 'no grid of crossing lines is drawn there' }
    const centre = { x: (clip.x0 + clip.x1) / 2, y: (clip.y0 + clip.y1) / 2 }
    const region = (projectRegions.get(here) ?? []).find((s) => pointInRegion(centre, [[
      { x: Math.min(s.rect.x0, s.rect.x1), y: Math.min(s.rect.y0, s.rect.y1) }, { x: Math.max(s.rect.x0, s.rect.x1), y: Math.min(s.rect.y0, s.rect.y1) },
      { x: Math.max(s.rect.x0, s.rect.x1), y: Math.max(s.rect.y0, s.rect.y1) }, { x: Math.min(s.rect.x0, s.rect.x1), y: Math.max(s.rect.y0, s.rect.y1) },
    ]]))
    const fpp = region?.feetPerPoint ?? ap.feetPerPoint
    const len = (pts: number | null) => pts === null ? null : {
      points: Math.round(pts * 100) / 100,
      ...(fpp === null ? {} : { feet: Math.round(pts * fpp * 1000) / 1000, inches: Math.round(pts * fpp * 12 * 100) / 100 }),
    }
    return {
      grid, fpp,
      modules: {
        // Spacing between the lines at `angle` (measured across them), and between the lines across those.
        moduleAcrossLines: len(grid.moduleA), moduleAlongLines: len(grid.moduleB),
        ...(fpp === null ? { scale: 'the sheet has no scale; modules are in PDF points only' } : {}),
        ...(geo.truncated ? { note: 'more geometry than was read; use a smaller area' } : {}),
      },
    }
  }
  const agentAreas = (params: Record<string, unknown>): { scope: Scope; areas: Markup[] } | { error: string } => {
    const sid = String(params['scopeId'] ?? agentScope() ?? '')
    const ids = Array.isArray(params['markupIds']) ? (params['markupIds'] as unknown[]).map(String)
      : typeof params['markupId'] === 'string' ? [params['markupId']] : null
    if (ids !== null) {
      const found = ids.map((i) => docMarkupsRef.current.find((m) => m.id === i))
      const missing = ids.filter((_, k) => found[k] === undefined)
      if (missing.length > 0) return { error: `no such markup: ${missing.join(', ')}` }
      const areas = found as Markup[]
      if (areas.some((m) => m.kind !== 'area' || m.scopeId === null)) return { error: 'patterns are set on areas that belong to a scope' }
      const sc = scopesRef.current.find((x) => x.id === areas[0]!.scopeId)
      if (!sc || areas.some((m) => m.scopeId !== sc.id)) return { error: 'those areas are in different scopes; one scope per call' }
      return { scope: sc, areas }
    }
    const sc = scopesRef.current.find((x) => x.id === sid)
    if (!sc) return { error: `no such scope: ${sid || '(none active)'}` }
    const here = ap.id
    let areas = docMarkupsRef.current.filter((m) => m.kind === 'area' && m.scopeId === sc.id && m.pageId === here)
    const pt = bridgePoint(params['point'])
    if (pt !== null) {
      const inside = areas.filter((m) => pointInRegion(pt, m.rings))
      if (inside.length > 0) areas = inside
      else {
        const box = ap.size
        const near = areas.map((m) => ({ m, p: nearestOnBoundary(m.rings, pt, box) }))
          .filter((x) => x.p !== null && Math.hypot((x.p.x - pt.x) * box.width, (x.p.y - pt.y) * box.height) <= 24)
          .sort((a, b) => Math.hypot(a.p!.x - pt.x, a.p!.y - pt.y) - Math.hypot(b.p!.x - pt.x, b.p!.y - pt.y))
        areas = near.length > 0 ? [near[0]!.m] : []
      }
    }
    if (areas.length === 0) return { error: `no area of ${sc.label} ${pt !== null ? 'at that point' : 'on this sheet'}; give markupId, or a point inside one` }
    return { scope: sc, areas }
  }
  /** Pages for a read: page, pages or fromPage..toPage, else the sheet showing. */
  const agentPageList = (params: Record<string, unknown>, current: number): { pages: number[] } | { error: string } => {
    if (params['page'] === undefined && params['pages'] === undefined && params['fromPage'] === undefined && params['toPage'] === undefined) {
      return { pages: [current] }
    }
    const r = bridgePages(params, pageCount)
    return typeof r === 'string' ? { error: r } : { pages: r }
  }
  /**
   * What is wrong with an outline an agent drew: crossed, off the sheet, or
   * in the title block. The markup is still made; the answer says so.
   */
  const outlineWarnings = (rings: ReadonlyArray<ReadonlyArray<{ x: number; y: number }>>, at?: number): OutlineIssue[] => {
    const info = at === undefined || at === ap.index ? ap.size : (viewerRef.current?.getPageSize(at) ?? ap.size)
    const notDrawing = titleRegions === null ? [] : [titleRegions.number, ...(titleRegions.title !== null ? [titleRegions.title] : [])]
    return checkOutline(rings, { page: { width: info.width || 1, height: info.height || 1 }, notDrawing })
  }
  /** One markup from an agent's description, checked; curves laid out (round 3 #10). */
  const agentMarkup = (spec: Record<string, unknown>, docId: string, pageId: string): { markup: Markup } | { error: string } => {
    const kind = String(spec['kind'] ?? '') as MarkupKind
    const kinds: MarkupKind[] = ['area', 'cutout', 'polyline', 'count', 'shape']
    if (!kinds.includes(kind)) return { error: `cannot create kind: ${kind}` }
    let raw: unknown = spec['rings']
    if (typeof raw === 'string') { try { raw = JSON.parse(raw) } catch { raw = null } }
    if (!Array.isArray(raw) || raw.length === 0) {
      return { error: 'needs rings: [[{x,y}, …]] in NORMALIZED [0,1] coords; a vertex may carry `bulge` for an arc to the next one, and a ring may be {circle:{cx,cy,r}}' }
    }
    const closed = kind === 'area' || kind === 'cutout' || kind === 'shape'
    const pb = projectPageBoxes.get(pageId)
    const sized = pageId === ap.id ? ap.size : (viewerRef.current?.getPageSize(pageNumberFrom(pageId, docId) ?? -1) ?? ap.size)
    const box = pb !== undefined && pb.width > 0 ? { width: pb.width, height: pb.height } : { width: sized.width || 1, height: sized.height || 1 }
    const rings: Array<Array<{ x: number; y: number }>> = []
    for (const r of kind === 'area' ? raw : [raw[0]]) {
      const ring = expandRing(r, box, closed)
      if (ring === null || ring.length === 0) return { error: `not a ring: ${JSON.stringify(r).slice(0, 80)}` }
      for (const p of ring) {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < -0.05 || p.x > 1.05 || p.y < -0.05 || p.y > 1.05) {
          return { error: `vertex out of normalized range: ${JSON.stringify(p)}` }
        }
      }
      rings.push(ring)
    }
    const min = closed ? 3 : kind === 'count' ? 1 : 2
    if (rings[0]!.length < min) return { error: `${kind} needs at least ${min} vertices` }
    const scopeId = typeof spec['scopeId'] === 'string' ? spec['scopeId'] : agentScope()
    if (scopeId !== null && !scopesRef.current.some((sc) => sc.id === scopeId)) return noScope(scopeId)
    return { markup: { id: uid(), documentId: docId, pageId, scopeId, kind, rings } }
  }

  /**
   * get_ui_state for a session: the sheet, scale, selection and half-made
   * region are ITS OWN, and `person` says where the person is looking, so an
   * agent can tell "my sheet" from "theirs" and never has to move theirs to
   * find out.
   */
  const withSessionView = (ctx: CallContext | undefined, state: Record<string, unknown>): Record<string, unknown> => {
    if (ctx === undefined || ctx.agent == null) return state
    const before = agentCtxRef.current
    agentCtxRef.current = ctx
    try {
      const view = agentView()!
      const at = ap.index
      const label = sheetLabelFor(at)
      const fpp = ap.feetPerPoint
      return {
        ...state,
        pageIndex: at,
        pageWidth: ap.size.width,
        pageHeight: ap.size.height,
        sheet: label === `Page ${at + 1}` ? null : { number: label, title: sheetTitleFor(at) },
        tool: view.tool,
        activeScope: agentScope(),
        markupCount: ap.markups.length,
        selectedIds: view.selected,
        calibrated: fpp !== null,
        feetPerPoint: fpp,
        pending: { calibration: false, scaleRegion: view.pendingRegion !== null },
        scaleRegions: (projectRegions.get(ap.id) ?? []).map((r) => ({
          id: r.id, label: r.label, feetPerPoint: r.feetPerPoint, scale: scaleLabel(r.feetPerPoint), rect: r.rect,
        })),
        markupVisibility: { embedded: view.embedded, redbeam: view.redbeam },
        view: view.rect,
        // Where the person is. Theirs to move; nothing a session calls changes it.
        person: {
          pageIndex: state['pageIndex'], sheet: state['sheet'], zoom: state['zoom'], viewport: state['viewport'],
          tool: state['tool'], activeScope: state['activeScope'], selectedIds: state['selectedIds'],
        },
        yourView: 'pageIndex, sheet, tool, selection and scale here are your session\'s own. `person` is what is on screen; your calls never change it.',
      }
    } finally { agentCtxRef.current = before }
  }

  useBridgeHost(quickView?.file ?? '', {
    saveFile: projectBridge.writeExport === undefined ? undefined : (path, bytes, overwrite) => projectBridge.writeExport!(path, bytes, overwrite),
    query: async (sql, params) => {
      const db = dbRef.current
      if (db === null) throw new Error('the PDF is still opening; poll redbeam_get_ui_state until pageCount > 0')
      return db.all<Record<string, unknown>>(sql, params)
    },
    uiState: (ctx) => withSessionView(ctx, {
      /*
       * Whether the PDF holds everything (round 3 P1-4): false while a change
       * has not been written into it yet. `lastSave` is the last attempt.
       */
      saved: (lastSaveRef.current?.tick ?? 0) >= changeTickRef.current,
      lastSave: lastSaveRef.current === null ? null : { outcome: lastSaveRef.current.kind, at: lastSaveRef.current.at },
      // What the warning bar is saying, word for word (P1-9).
      warnings: warningsRef.current.map((w) => (typeof w === 'string' ? w : w.text)),
      appVersion: APP_VERSION,
      // The PDF this window is showing and the others open as tabs.
      ...(light && quickView !== undefined
        ? { file: quickView.file, tabs: quickView.tabs?.list.map((t) => t.file) ?? [quickView.file] }
        : {}),
      projectPath,
      role: identity.role,
      backend,
      status,
      activeDocumentId: activeDocId,
      openDocumentIds: openDocIds,
      documentCount: documents.length,
      pageIndex,
      pageCount,
      pageWidth: page.width,
      pageHeight: page.height,
      zoom: viewRef.current.zoom,
      /*
       * The viewport, verbatim. Added because two rendering complaints in a
       * row had to be diagnosed by measuring pixels in a screenshot, which is
       * how the white-square bug was nearly misdiagnosed — the numbers were
       * right there and simply not reachable.
       */
      viewport: {
        ox: viewRef.current.ox,
        oy: viewRef.current.oy,
        vw: viewRef.current.vw,
        vh: viewRef.current.vh,
      },
      stage: { width: stage.width, height: stage.height, dpr: stage.dpr },
      fitMode,
      tool,
      activeScope,
      scopes: scopes.map((sc) => ({ id: sc.id, label: sc.label, scopeType: sc.scopeType })),
      markupCount: markups.length,
      selectedIds,
      calibrated: cal !== null,
      feetPerPoint: cal?.feetPerPoint ?? null,
      // From the stack itself: the rendered state is a frame behind a write.
      undo: undoRef.current?.state ?? undoState,
      // The names predate the dialogs' rehoming and are kept for the agents
      // that read them: "scope editor open" is a scope's page in the sidebar,
      // "browser open" is the Files pane.
      panels: {
        scopeEditorOpen: openScopeId !== null, settingsOpen, searchOpen: railPanel === 'search',
        browserOpen: railPanel === 'files', bomOpen: openScopeId !== null && scopePage === 'parts', scopePage, layoutOn,
      },
      /*
       * The two gestures that are half-finished rather than open or closed.
       *
       * Both put a question on screen that outranks everything else, so an
       * agent that does not know one is up reads every later refusal as the
       * app being broken instead of as a form waiting for an answer.
       */
      pending: { calibration: pendingCal !== null, scaleRegion: pendingRegion !== null },
      // Ids, because deleting a region needs one and nothing else reports them.
      scaleRegions: regionsOnThisSheet.map((r) => ({
        id: r.id, label: r.label, feetPerPoint: r.feetPerPoint,
        scale: scaleLabel(r.feetPerPoint), rect: r.rect,
      })),
      quantities: quantities.map((q) => ({ scope: q.scope.label, rows: q.rows })),
      pieces: pieces.map((p) => ({
        scope: p.scope.label,
        quantities: p.result.quantities,
        blockers: p.result.blockers,
      })),
      ingestNote,
      /*
       * What the sheet is called, from the same index the sheet list shows:
       * the PDF's bookmarks, then its page labels, then the title block.
       * Null when none of them names it.
       */
      sheet: activeDocId === null ? null : (() => {
        const n = sheetLabelFor(pageIndex)
        return n === `Page ${pageIndex + 1}` ? null : { number: n, title: sheetTitleFor(pageIndex) }
      })(),
      markupVisibility: { embedded: !embeddedHidden, redbeam: !redbeamHidden },
    }),

    screenshot: async (params, ctx) => {
      agentCtxRef.current = ctx
      try {
      /*
       * A close-up: one box of the sheet, rendered by PDFium at the size
       * asked for rather than cropped out of the window, which is only as
       * sharp as the screen (Aaron, 2026-11-24: "I worked around it by
       * cropping, which came out low-res").
       */
      let region = bridgeRect(params['region'] ?? params['rect'])
      if (region === null) throw new Error('region must be {x0,y0,x1,y1} in normalized [0,1] page coordinates')
      /*
       * A sheet named by `page` is rendered on its own, at any page, without
       * turning the window to it (NOIC intake, 2026-11-26). Turning first
       * meant four close-ups sent at once raced one another's page turns
       * ("page did not show within 10s"). It does not turn the session's own
       * sheet either, for the same reason: close-ups asked for at once must
       * not change what a call with no `page` means.
       */
      let page: number | undefined
      const given = params['page']
      if (given !== undefined && given !== null && given !== '') {
        const at = typeof given === 'string' && !/^\d+$/.test(given.trim())
          ? pageForSheet(sheetGroups.flatMap((g) => g.rows), given)
          : Number(given)
        if (at === null || !Number.isInteger(at)) throw new Error(`no single sheet is called ${String(given)} in this document; redbeam_list_sheets has every sheet`)
        if (at < 0 || at >= pageCount) throw new Error(`page ${at} out of range (0..${pageCount - 1})`)
        page = at
      }
      // A session's picture is of ITS sheet: the box it framed there, else the whole sheet.
      const view = agentView()
      if (region === undefined && view !== null) region = (page === undefined || page === view.page ? view.rect : null) ?? { x0: 0, y0: 0, x1: 1, y1: 1 }
      if (region !== undefined || (page !== undefined && page !== pageIndexRef.current)) {
        const v = viewerRef.current
        if (!v) return null
        const box = region ?? { x0: 0, y0: 0, x1: 1, y1: 1 }
        const framed = params['region'] !== undefined || params['rect'] !== undefined
        const width = Math.min(6000, Math.max(64, Number(params['width'] ?? (framed ? 1200 : 1600)) || 1200))
        const targetPage = page ?? view?.page ?? v.currentPageIndex
        const elsewhere = view !== null || targetPage !== v.currentPageIndex
        const annots = typeof params['annotations'] === 'boolean' ? params['annotations'] : view !== null ? view.embedded : undefined
        const overlay = typeof params['overlay'] === 'boolean' ? params['overlay'] : view !== null ? view.redbeam : undefined
        const out = await v.renderRegion(box, width, {
          page: targetPage,
          ...(elsewhere ? {
            overlaySet: toOverlay(docMarkupsRef.current.filter((m) => m.pageId === pageIdFor(docIdRef.current, targetPage) && !isCutId(m.id)), scopesRef.current, pendingIdsRef.current),
          } : {}),
          ...(annots !== undefined ? { annots } : {}),
          ...(overlay !== undefined ? { overlay } : {}),
          /*
           * The layout preview, under the markups (NOIC, 2026-11-26: a
           * close-up skipped it even with the overlay on, so checking a layout
           * meant zooming the person's window). A session's picture shows it
           * when its own view has it on or the person's setting does; with no
           * session, when the window shows it. `layout` decides for one picture.
           */
          ...((params['layout'] === true || (params['layout'] !== false && (
            view !== null ? view.layoutOn || prefsRef.current['takeoff.layoutPreview'] === true
              : prefsRef.current['takeoff.layoutPreview'] === true && !redbeamHiddenRef.current))) ? {
            under: (g: CanvasRenderingContext2D, at: Viewport, pw: number, ph: number) => {
              const pid = pageIdFor(docIdRef.current, targetPage)
              drawLayoutsRef.current(g, at, pid, pw, ph, projectCalibrationsLatest.current.get(pid) ?? 0)
            },
          } : {}),
        })
        return out.canvas.toDataURL('image/png')
      }
      // The raster and the overlay are separate canvases; a screenshot that
      // showed only one would be a picture of half the app.
      const raster = rasterRef.current
      const overlay = overlayRef.current
      if (!raster) return null
      const out = document.createElement('canvas')
      out.width = raster.width
      out.height = raster.height
      const g = out.getContext('2d')
      if (!g) return null
      g.drawImage(raster, 0, 0)
      if (overlay && params['overlay'] !== false) g.drawImage(overlay, 0, 0)
      return out.toDataURL('image/png')
      } finally { agentCtxRef.current = UNNAMED_CALL }
    },
    invoke: async (action, params, ctx) => {
      actorRef.current = 'agent'
      agentCtxRef.current = ctx
      try {
        const doc = documents.find((d) => d.id === activeDocId)
        const fileName = doc === undefined ? null : (doc.displayName || doc.relativePath)
        /*
         * Which file a call is about (P1-3). With `file` (a path or a document
         * id) a call that would land in a different file than the one showing
         * is refused, naming both, rather than written into the wrong one.
         */
        const want = typeof params['file'] === 'string' ? params['file'].trim() : ''
        if (want !== '') {
          const norm = (x: string) => x.replace(/\\/g, '/').toLowerCase()
          const base = (x: string) => norm(x).replace(/^.*\//, '')
          const showing = light && quickView !== undefined ? quickView.file : null
          const same = want === activeDocId
            || (showing !== null && norm(showing) === norm(want))
            || (doc !== undefined && (norm(doc.relativePath) === norm(want) || base(doc.relativePath) === base(want)))
          if (!same) {
            return { error: `this window is showing ${showing ?? fileName ?? 'no file'}, not ${want}; open it with redbeam_open_file first`, showing: showing ?? fileName }
          }
        }
        /*
         * One page input (P3-4): a ZERO-based number, or the sheet's code as
         * the set prints it ("A4.0"). A code that names no single sheet is
         * refused rather than guessed.
         */
        const given = params['page']
        if (typeof given === 'string' && given.trim() !== '') {
          let at: number | null = /^\d+$/.test(given.trim()) ? Number(given.trim()) : null
          if (at === null) at = pageForSheet(sheetGroups.flatMap((g) => g.rows), given)
          if (at === null) return { error: `no single sheet is called ${given} in this document; redbeam_list_sheets has every sheet` }
          params = { ...params, page: at }
        }
        await ensurePageRows(pagesNamed(params, pageCount))
        // A write that names a page lands on that page: the session's own sheet turns to it (P1-2).
        if (PAGE_BOUND.has(action) && params['page'] !== undefined) {
          const n = Number(params['page'])
          if (!Number.isInteger(n) || n < 0 || n >= pageCount) return { error: `page ${String(params['page'])} out of range (0..${pageCount - 1})` }
          await showPageForAgent(n)
        }
        /*
         * Whatever the action opens or selects, the keyboard stays where the
         * person had it. Only the PDF showing can take it at all: one live
         * behind it is inert.
         */
        const out = showingRef.current
          ? await keepingFocus(() => invokeAction(action, params))
          : await invokeAction(action, params)
        return fileName !== null && out['file'] === undefined ? { ...out, file: fileName } : out
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      } finally { actorRef.current = 'user'; agentCtxRef.current = UNNAMED_CALL }
    },
  })
  async function invokeAction(action: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    {
      /*
       * A nested object, however the caller managed to send it.
       *
       * The schema asks for an object and MCP clients routinely stringify one
       * anyway — the transport is JSON either way, so a client that flattens
       * arguments loses nothing but the type. Refusing that was a dead end an
       * agent could not read its way out of: the message said "must be an
       * object", the caller believed it had sent one, and the retry was
       * identical. Parsing costs nothing and a genuinely malformed value still
       * fails, one line further down.
       */
      const objectParam = (v: unknown): Record<string, unknown> | null | undefined => {
        if (v === undefined) return undefined
        const o = typeof v === 'string' ? ((): unknown => { try { return JSON.parse(v) } catch { return null } })() : v
        return typeof o === 'object' && o !== null && !Array.isArray(o)
          ? o as Record<string, unknown>
          : null
      }
      switch (action) {
        case 'set_tool': {
          const next = String(params['tool'] ?? '')
          /*
           * Every tool a person has, because an agent that cannot reach one
           * cannot check it either. This list had drifted: `direction` and
           * `scale-region` both existed in the toolbar and neither could be
           * selected through the bridge, so the two gestures that decide how a
           * takeoff is MEASURED were the two an agent could not exercise.
           * `dimension` drifted the same way the day it was added — the guard
           * in apps/mcp/coverage.test.mjs is what caught it, which is the
           * argument for the guard rather than for care.
           */
          const known: Tool[] = [
            'pan', 'select', 'area', 'cutout', 'polyline', 'count', 'shape',
            'calibrate', 'direction', 'scale-region', 'dimension', 'text', 'origin', 'link',
            'cloud', 'callout', 'arrow', 'line', 'rect', 'ellipse', 'polygon', 'pen',
          ]
          if (!known.includes(next as Tool)) return { error: `unknown tool: ${next}` }
          // The tool in hand on screen is the person's. A session draws with its calls, not with a tool.
          const view = agentView()
          if (view !== null) {
            view.tool = next
            return { tool: next, note: 'noted for your session; the tool on screen is the person\'s and did not change. create_markup, trace_area, measure and the rest need no tool selected' }
          }
          setTool(next as Tool)
          return { tool: next }
        }
        case 'set_active_scope': {
          const id = String(params['scopeId'] ?? '')
          if (!scopes.some((sc) => sc.id === id)) return noScope(id)
          // A guest picks the scope ITS next markups go to; the person's active scope is theirs.
          if (agentCtxRef.current.agent != null) {
            guestScopeRef.current.set(agentCtxRef.current.agent.id, id)
            return { activeScope: id, note: 'yours for this PDF; the person keeps their own active scope' }
          }
          setActiveScope(id)
          return { activeScope: id }
        }
        case 'go_to_page': {
          if (typeof params['sheet'] === 'string' && params['page'] === undefined) {
            const rows = sheetGroups.flatMap((g) => g.rows)
            const at = pageForSheet(rows, params['sheet'])
            if (at === null) return { error: `no single sheet is called ${params['sheet']} in this document; list_sheets has every sheet` }
            await showPageForAgent(at)
            return { page: at, sheet: sheetLabelFor(at) }
          }
          const n = Number(params['page'])
          if (!Number.isInteger(n) || n < 0 || n >= pageCount) {
            return { error: `page ${params['page']} out of range (0..${pageCount - 1})` }
          }
          // Waits for the sheet: a write right after must land on it (P1-2).
          await showPageForAgent(n)
          return { page: n, sheet: sheetLabelFor(n) }
        }
        /*
         * The sheet index, as the sheet list shows it: number and title per
         * page, from the PDF's bookmarks, its page labels, or the title block
         * when the set has neither. `sheet` is null where nothing names it.
         */
        case 'list_sheets': {
          if (activeDocId === null) return { error: 'no document is open' }
          const doc = documents.find((d) => d.id === activeDocId)
          const sheets = sheetGroups.flatMap((g) => g.rows.map((r) => {
            // A bare page label ("34") is a position, not a sheet name.
            const unnamed = r.title === '' && (r.number === `Page ${r.page + 1}` || isOrdinalLabel(r.number))
            return {
              page: r.page,
              sheet: unnamed ? null : r.number,
              title: r.title,
              source: sheetOverrides.has(r.page) ? 'renamed' : (titleRegions !== null && (regionNames[r.page] ?? null) !== null) ? 'title block' : 'document',
              ...(g.label !== null ? { group: g.label } : {}),
            }
          })).sort((a, b) => a.page - b.page)
          return {
            documentId: activeDocId,
            document: doc === undefined ? null : (doc.displayName || doc.relativePath),
            pageCount,
            named: sheets.filter((x) => x.sheet !== null).length,
            ...(titleRegions !== null ? { titleBlocks: { numberBox: titleRegions.number, titleBox: titleRegions.title } } : {}),
            /*
             * Where REDBEAM found the title block on its own, from where the
             * sheet codes sit across sheets. Names marked `document` come from
             * it where the PDF has no names of its own. Check a few with a
             * screenshot `region`; set_title_blocks with these boxes keeps
             * them in the file, or with better ones corrects them.
             */
            ...(titleRegions === null && foundTitleBlock !== null ? {
              foundTitleBlock: {
                numberBox: foundTitleBlock.regions.number, titleBox: foundTitleBlock.regions.title,
                sheetsWithANumber: `${foundTitleBlock.sheets} of ${foundTitleBlock.looked} sheets looked at`,
                note: 'found automatically; check a few names, then redbeam_set_title_blocks with these boxes (or better ones) to keep them in the file',
              },
            } : {}),
            ...(titleReading !== null ? { reading: { ...titleReading, note: 'the title block boxes are still being read; names fill in as they are' } } : {}),
            ...(sweepRead.read < sweepRead.of ? { sheetsRead: { read: sweepRead.read, of: sweepRead.of, note: 'sheets are still being read for their names; ask again shortly' } } : {}),
            sheets,
            ...(sheets.some((x) => x.sheet === null) ? { note: 'sheet: null means no sheet number has been read off that page yet (they are read as the file is indexed after opening, so ask again shortly), or the page has none; `page` always works' } : {}),
          }
        }
        /*
         * Name every sheet from two boxes on the title block, the same as
         * Read from title block in Contents (Aaron, 2026-11-25: agents must
         * be able to see a set is misnamed and fix it on their own).
         */
        case 'set_title_blocks': {
          const v = viewerRef.current
          if (!v || activeDocId === null) return { error: 'no document is open' }
          if (params['clear'] === true) {
            await applyTitleRegions(null)
            return { cleared: true, note: 'the title block boxes are removed; names set with rename_sheets stay' }
          }
          const asBox = (raw: unknown): NormBox | null | 'bad' => {
            const o = objectParam(raw)
            if (o === undefined) return null
            if (o === null) return 'bad'
            const n = ['x0', 'y0', 'x1', 'y1'].map((k) => Number(o[k]))
            if (n.some((x) => !Number.isFinite(x) || x < 0 || x > 1)) return 'bad'
            const box = { x0: Math.min(n[0]!, n[2]!), y0: Math.min(n[1]!, n[3]!), x1: Math.max(n[0]!, n[2]!), y1: Math.max(n[1]!, n[3]!) }
            return isTinyBox(box) ? 'bad' : box
          }
          const numberBox = asBox(params['numberBox'])
          const titleBox = asBox(params['titleBox'])
          if (numberBox === null || numberBox === 'bad') {
            return { error: 'numberBox must be {x0,y0,x1,y1} in normalized [0,1] page coordinates, y down, around the drawing number (find it with get_words on the title block)' }
          }
          if (titleBox === 'bad') return { error: 'titleBox must be {x0,y0,x1,y1} in normalized [0,1] page coordinates, y down, or left out' }
          const regions: TitleBlockRegions = { number: numberBox, title: titleBox }
          const at = params['page'] === undefined ? ap.index : Number(params['page'])
          if (!Number.isInteger(at) || at < 0 || at >= pageCount) return { error: `page ${String(params['page'])} out of range (0..${pageCount - 1})` }
          // A sample across the set, so a box that only fits one sheet shows up now.
          const samplePages = [...new Set([at, 0, Math.floor(pageCount / 4), Math.floor(pageCount / 2), Math.floor((3 * pageCount) / 4), pageCount - 1])]
            .filter((p) => p >= 0 && p < pageCount)
          const sample: Array<Record<string, unknown>> = []
          for (const p of samplePages) {
            try {
              const pt = v.getText(p) ?? await v.requestText(p, { priority: 0 })
              const name = readSheetName(pt, regions)
              sample.push({ page: p, number: name?.number ?? null, title: name?.title ?? null, ...(pt.scanned ? { scanned: true } : {}) })
            } catch {
              sample.push({ page: p, error: 'could not read this sheet' })
            }
          }
          await applyTitleRegions(regions)
          const empty = sample.filter((x) => x['number'] === null).length
          return {
            reading: { total: pageCount },
            sample,
            note: `every sheet is being read in these boxes in the background; list_sheets shows the names as they come in (source "title block") and the next save writes them into the PDF as page labels.${empty > 0 ? ` ${empty} of the sampled sheets read nothing in the number box: check those with get_words, and name odd ones with rename_sheets.` : ''}`,
          }
        }
        /* Name pages one at a time: a cover, a scan, a sheet whose title block differs. */
        case 'rename_sheets': {
          if (activeDocId === null) return { error: 'no document is open' }
          let list: unknown = params['sheets']
          if (typeof list === 'string') { try { list = JSON.parse(list) } catch { list = null } }
          if (!Array.isArray(list) || list.length === 0) return { error: 'sheets must be a list of {page, number, title} (ZERO-based pages), or {page, clear: true} to take a name off' }
          const changes: Array<{ page: number; name: ReadName | null }> = []
          for (const raw of list) {
            const o = objectParam(raw)
            if (o === undefined || o === null) return { error: 'each entry in sheets must be {page, number, title} or {page, clear: true}' }
            const p = Number(o['page'])
            if (!Number.isInteger(p) || p < 0 || p >= pageCount) return { error: `page ${String(o['page'])} out of range (0..${pageCount - 1})` }
            if (o['clear'] === true) { changes.push({ page: p, name: null }); continue }
            const number = String(o['number'] ?? '').replace(/\s+/g, ' ').trim()
            if (number === '') return { error: `page ${p}: number is required (or clear: true)` }
            changes.push({ page: p, name: { number, title: String(o['title'] ?? '').replace(/\s+/g, ' ').trim() } })
          }
          await applySheetNames(changes)
          return {
            renamed: changes.filter((c) => c.name !== null).map((c) => ({ page: c.page, sheet: c.name!.number, title: c.name!.title })),
            cleared: changes.filter((c) => c.name === null).map((c) => c.page),
            note: 'shown in Contents now; the next save writes them into the PDF as page labels, which Bluebeam shows too',
          }
        }
        /*
         * Where text is on the sheets: every occurrence with its box, so an
         * agent can zoom to a tag or render a close-up of it. Reads PDFium's
         * word boxes, the ones Select text uses; nothing is stored for it.
         */
        case 'find_text': {
          const v = viewerRef.current
          if (!v || activeDocId === null) return { error: 'no document is open' }
          const query = String(params['query'] ?? '').trim()
          if (query === '') return { error: 'find_text needs `query`' }
          if (pageCount === 0) return { error: 'the document is still opening; ask again in a moment' }
          const wanted = bridgePages(params, pageCount)
          if (typeof wanted === 'string') return { error: wanted }
          // The search index already knows which sheets cannot contain it.
          let candidates = wanted
          const db = dbRef.current
          if (db !== null) {
            try {
              const rows = await db.all<{ page_id: string; hit: number }>(
                'SELECT page_id, instr(lower(content), lower(?)) > 0 AS hit FROM page_text WHERE document_id = ?',
                [query, activeDocId],
              )
              const known = new Map(rows.map((r) => [r.page_id, r.hit !== 0]))
              candidates = wanted.filter((sweepPage) => known.get(pageIdFor(activeDocId, sweepPage)) !== false)
            } catch { candidates = wanted }
          }
          /*
           * No time limit and no cap on what can be found (Aaron, 2026-11-24:
           * a search "timed out after 70 of 171 sheets", then "don't give the
           * system arbitrary caps"). The work and the answer are separate:
           *
           *   - every sheet not yet read is asked for now, and the worker
           *     reads them to the end in the background, off the UI thread,
           *     whatever happens to this call;
           *   - this call walks the sheets in order and answers with the
           *     matches it reaches, either a page of `limit` of them or as
           *     far as the reading has got after AGENT_REPLY_MS;
           *   - `cursor` says where it stopped (sheet and match), so the next
           *     call carries on from there. Nothing is kept between calls but
           *     the sheets' text, which the viewer holds anyway.
           */
          const pageSize = Math.max(1, Math.min(2000, Number(params['limit'] ?? 300) || 300))
          let fromPage = -1, fromMatch = 0
          if (params['cursor'] !== undefined && params['cursor'] !== null && params['cursor'] !== '') {
            const c = /^(\d+):(\d+)$/.exec(String(params['cursor']))
            if (c === null) return { error: '`cursor` is the value a previous find_text returned, passed back unchanged' }
            fromPage = Number(c[1]); fromMatch = Number(c[2])
          }
          const todo = [...candidates].sort((x, y) => x - y).filter((p) => p >= fromPage)
          /*
           * Read by readers of their own, several at once, in page order
           * (search/textPool.ts), rather than one at a time by the worker
           * drawing the sheet. A page that kills or stalls a reader comes
           * back unreadable, with why, instead of holding the search.
           */
          const pool = textPool()
          if (pool !== null) pool.want(todo.filter((p) => v.getText(p) === undefined))
          const read = (p: number): Promise<PageText | null> => (pool !== null
            ? pool.text(p)
            : v.requestText(p, { priority: PRIORITY_THUMBNAIL }).catch(() => null))
          const reads = new Map<number, Promise<PageText | null>>()
          for (const p of todo) if (v.getText(p) === undefined) reads.set(p, read(p))
          const replyBy = performance.now() + AGENT_REPLY_MS
          const within = <T,>(job: Promise<T>): Promise<T | undefined> => {
            const left = replyBy - performance.now()
            if (left <= 0) return Promise.resolve(undefined)
            return Promise.race([job, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), left))])
          }
          const matches: Array<TextMatch & { page: number; sheet: string | null }> = []
          const unreadable: number[] = []
          let cursor: string | null = null
          let waitingOn: number | null = null
          let breath = performance.now()
          for (const p of todo) {
            const skip = p === fromPage ? fromMatch : 0
            let pt: PageText | null | undefined = v.getText(p)
            if (pt === undefined) {
              pt = await within(reads.get(p) ?? read(p))
              // Navigation drops queued reads; one that was dropped is asked for again.
              if (pt === null) pt = await within(read(p))
              if (pt === undefined) { cursor = `${p}:${skip}`; waitingOn = p; break }
              if (pt === null) { unreadable.push(p); continue }
            }
            const room = pageSize - matches.length
            const found = findInPageText(pt, query, {
              caseSensitive: params['caseSensitive'] === true,
              wholeWord: params['wholeWord'] === true,
              skip, limit: room + 1,
            })
            const label = sheetLabelFor(p)
            for (const m of found.slice(0, room)) matches.push({ page: p, sheet: label === `Page ${p + 1}` ? null : label, ...m })
            if (found.length > room) { cursor = `${p}:${skip + room}`; break }
            // Let the window draw and take input between sheets.
            if (performance.now() - breath > 12) { await new Promise((resolve) => setTimeout(resolve, 0)); breath = performance.now() }
          }
          const sheetsRead = candidates.filter((p) => v.hasText(p)).length + (wanted.length - candidates.length)
          return {
            query,
            matches,
            done: cursor === null,
            ...(cursor !== null ? {
              cursor,
              note: waitingOn !== null
                ? 'the remaining sheets are still being read (it continues in the background); call find_text again with the same arguments plus this `cursor` for the rest'
                : 'more matches follow; call find_text again with the same arguments plus this `cursor`',
            } : {}),
            sheetsRead,
            sheets: wanted.length,
            ...(unreadable.length > 0 ? {
              unreadable,
              unreadableNote: 'these sheets could not be read',
              ...(pool !== null && pool.unreadable().length > 0 ? { why: pool.unreadable().filter((u) => unreadable.includes(u.page)) } : {}),
            } : {}),
          }
        }
        /* Every word on a page with its box, or only those inside `rect`. */
        case 'get_words': {
          const v = viewerRef.current
          if (!v || activeDocId === null) return { error: 'no document is open' }
          const p = params['page'] === undefined ? ap.index : Number(params['page'])
          if (!Number.isInteger(p) || p < 0 || p >= pageCount) return { error: `page ${params['page']} out of range (0..${pageCount - 1})` }
          const within = bridgeRect(params['rect'])
          if (within === null) return { error: 'rect must be {x0,y0,x1,y1} in normalized [0,1] page coordinates' }
          // Any sheet, without showing it; a big set's own readers when there are any.
          const pool = textPoolRef.current
          const pt = v.getText(p) ?? (pool !== null ? await pool.text(p) : null) ?? await v.requestText(p, { priority: PRIORITY_THUMBNAIL })
          const all = wordsOnPage(pt, within)
          const limit = Math.max(1, Math.min(20_000, Number(params['limit'] ?? 3000) || 3000))
          const offset = Math.max(0, Math.floor(Number(params['offset'] ?? 0)) || 0)
          return {
            page: p,
            sheet: sheetLabelFor(p),
            scanned: pt.scanned,
            /*
             * One row per word, not an object with a named box each: a sheet
             * has thousands of words, and the names were most of the answer
             * (an E-size sheet read 108 KB; as rows it reads about half).
             */
            wordFormat: '[text, x0, y0, x1, y1]: the box in normalized [0,1] page coordinates, y down',
            words: all.slice(offset, offset + limit).map((w) => {
              const r4 = (n: number) => Math.round(n * 1e4) / 1e4
              return [w.text, r4(w.box.x0), r4(w.box.y0), r4(w.box.x1), r4(w.box.y1)]
            }),
            total: all.length,
            // Nothing is dropped: the rest comes with `offset`.
            ...(all.length > offset + limit ? { nextOffset: offset + limit, note: 'more words follow; ask again with `offset` set to nextOffset' } : {}),
          }
        }
        /*
         * Frame a box of the sheet in the window, the way the zoom box does,
         * and mark it the way a search hit is marked. With `page`, that sheet
         * is shown first.
         */
        case 'zoom_to_region': {
          const rect = bridgeRect(params['rect'])
          if (rect === undefined || rect === null) return { error: 'zoom_to_region needs `rect` {x0,y0,x1,y1}, normalized [0,1]' }
          if (params['page'] !== undefined) await showPageForAgent(Number(params['page']))
          const v = viewerRef.current
          if (!v || ap.size.width === 0) return { error: 'no page is showing' }
          const { width: pw, height: ph } = ap.size
          const x0 = Math.min(rect.x0, rect.x1) * pw, x1 = Math.max(rect.x0, rect.x1) * pw
          const y0 = Math.min(rect.y0, rect.y1) * ph, y1 = Math.max(rect.y0, rect.y1) * ph
          // A little room around it, so a tag is seen with what it points at.
          const margin = Math.max(0, Number(params['margin'] ?? 0.15) || 0)
          const bw = Math.max(1, (x1 - x0) * (1 + 2 * margin)), bh = Math.max(1, (y1 - y0) * (1 + 2 * margin))
          const view = agentView()
          if (view !== null) {
            // Framed in the session's own view: its next screenshot shows this box.
            view.rect = {
              x0: Math.max(0, ((x0 + x1) / 2 - bw / 2) / pw), y0: Math.max(0, ((y0 + y1) / 2 - bh / 2) / ph),
              x1: Math.min(1, ((x0 + x1) / 2 + bw / 2) / pw), y1: Math.min(1, ((y0 + y1) / 2 + bh / 2) / ph),
            }
            return { page: ap.index, sheet: sheetLabelFor(ap.index), view: view.rect, note: 'framed in your own view; redbeam_screenshot shows it. The person\'s view did not move' }
          }
          const zoom = Math.min(MAX_ZOOM, stage.width / bw, stage.height / bh)
          const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
          showView({ ...viewRef.current, zoom, ox: cx * zoom - stage.width / 2, oy: cy * zoom - stage.height / 2 })
          if (params['highlight'] !== false) {
            hitHighlightRef.current = {
              pageId: ap.id,
              boxes: [{ x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: rect.y1 }],
            }
            requestPaint()
          }
          return { page: ap.index, zoom: viewRef.current.zoom }
        }
        /*
         * Markups off for a clean look at the drawing, the palette's "Hide
         * the PDF's own markups" and "Hide REDBEAM markups". Nothing is
         * written; the warning bar tells the person while either is off.
         */
        case 'set_markup_visibility': {
          const next: { embedded?: boolean; redbeam?: boolean } = {}
          if (typeof params['embedded'] === 'boolean') next.embedded = params['embedded']
          if (typeof params['redbeam'] === 'boolean') next.redbeam = params['redbeam']
          if (next.embedded === undefined && next.redbeam === undefined) {
            return { error: 'set_markup_visibility needs `embedded` and/or `redbeam` (true shows, false hides)' }
          }
          const view = agentView()
          if (view !== null) {
            // What ITS screenshots draw. The person's layers stay as they set them.
            if (next.embedded !== undefined) view.embedded = next.embedded
            if (next.redbeam !== undefined) view.redbeam = next.redbeam
            return { markupVisibility: { embedded: view.embedded, redbeam: view.redbeam }, note: 'for your screenshots; what the person sees did not change' }
          }
          return { markupVisibility: setMarkupVisibility(next) }
        }
        /*
         * A distance or an area between points, at the sheet's scale, with
         * nothing drawn and nothing written. For sizes an agent would
         * otherwise count pixels for.
         */
        case 'measure': {
          if (params['page'] !== undefined) await showPageForAgent(Number(params['page']))
          const v = viewerRef.current
          if (!v || ap.size.width === 0) return { error: 'no page is showing' }
          const raw = typeof params['points'] === 'string'
            ? ((): unknown => { try { return JSON.parse(params['points'] as string) } catch { return null } })()
            : params['points']
          const pts = Array.isArray(raw)
            ? raw.map((p) => ({ x: Number((p as { x?: unknown }).x), y: Number((p as { y?: unknown }).y) }))
            : []
          if (pts.length < 2 || !pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= -0.001 && p.x <= 1.001 && p.y >= -0.001 && p.y <= 1.001)) {
            return { error: 'measure needs `points`: two or more {x,y} in NORMALIZED [0,1] page coordinates' }
          }
          const here = ap.id
          // A section or detail at its own scale (#179: spacing is read off the section, at the section's scale).
          let stated: { feetPerPoint: number; text: string } | undefined
          if (typeof params['scale'] === 'string' && params['scale'].trim() !== '') {
            const read = statedScales({ text: params['scale'] }).scales[0]
            if (read === undefined) return { error: `could not read the scale "${params['scale']}"; give it as printed, e.g. 1 1/2" = 1'-0" or 1:20` }
            stated = { feetPerPoint: read.feetPerPoint, text: read.text }
          }
          return {
            page: ap.index,
            ...measurePoints(pts, ap.size, {
              closed: params['closed'] === true,
              regions: projectRegions.get(here) ?? [],
              pageFeetPerPoint: ap.feetPerPoint,
              ...(stated !== undefined ? { stated } : {}),
            }),
          }
        }
        /*
         * The drawing's own linework inside a box: each segment's ends and
         * length, longest first. Read from the PDF's vector paths, the same
         * geometry snapping uses.
         */
        case 'get_lines': {
          if (params['page'] !== undefined) await showPageForAgent(Number(params['page']))
          const v = viewerRef.current
          if (!v || ap.size.width === 0) return { error: 'no page is showing' }
          const rect = bridgeRect(params['rect'])
          if (rect === undefined || rect === null) return { error: 'get_lines needs `rect` {x0,y0,x1,y1}, normalized [0,1]; keep it small, a whole sheet is hundreds of thousands of lines' }
          const clip = {
            x0: Math.min(rect.x0, rect.x1), y0: Math.min(rect.y0, rect.y1),
            x1: Math.max(rect.x0, rect.x1), y1: Math.max(rect.y0, rect.y1),
          }
          const g = await v.requestGeometry(ap.index, { clip, priority: PRIORITY_THUMBNAIL, maxSegments: 200_000 })
          const limit = Math.max(1, Math.min(5000, Number(params['limit'] ?? 300) || 300))
          const offset = Math.max(0, Math.floor(Number(params['offset'] ?? 0)) || 0)
          // The scale where the box is: a scale region's, else the sheet's.
          const centre = { x: (clip.x0 + clip.x1) / 2, y: (clip.y0 + clip.y1) / 2 }
          const scaleRegion = (projectRegions.get(ap.id) ?? []).find((r) => pointInRegion(centre, [[
            { x: Math.min(r.rect.x0, r.rect.x1), y: Math.min(r.rect.y0, r.rect.y1) }, { x: Math.max(r.rect.x0, r.rect.x1), y: Math.min(r.rect.y0, r.rect.y1) },
            { x: Math.max(r.rect.x0, r.rect.x1), y: Math.max(r.rect.y0, r.rect.y1) }, { x: Math.min(r.rect.x0, r.rect.x1), y: Math.max(r.rect.y0, r.rect.y1) },
          ]]))
          const fpp = scaleRegion?.feetPerPoint ?? ap.feetPerPoint
          const feetToPts = (k: string): number | undefined => {
            const f = Number(params[k])
            return Number.isFinite(f) && f >= 0 && fpp !== null && fpp > 0 ? f / fpp : undefined
          }
          const maxPts = Number.isFinite(Number(params['maxLengthPoints'])) ? Number(params['maxLengthPoints']) : feetToPts('maxLengthFeet')
          const minFromFeet = feetToPts('minLengthFeet')
          const orientation = params['orientation']
          const sort = params['sort']
          const { lines, total, duplicatesRemoved } = linesFromSegments(g.segments, ap.size, {
            feetPerPoint: fpp,
            minLengthPoints: minFromFeet ?? Math.max(0, Number(params['minLengthPoints'] ?? 2) || 0),
            ...(maxPts !== undefined ? { maxLengthPoints: maxPts } : {}),
            // Lines are cut to the box (the part inside it) unless `whole` asks for
            // the drawn line; the geometry read keeps anything that touches it.
            ...(params['inside'] === true ? { inside: clip } : params['whole'] === true ? {} : { clipTo: clip }),
            ...(orientation === 'horizontal' || orientation === 'vertical' ? { orientation } : {}),
            ...(Number.isFinite(Number(params['angle'])) && params['angle'] !== null && params['angle'] !== undefined ? { angle: Number(params['angle']) } : {}),
            ...(Number.isFinite(Number(params['angleTolerance'])) ? { angleTolerance: Number(params['angleTolerance']) } : {}),
            dedupe: params['dedupe'] !== false,
            ...(sort === 'x' || sort === 'y' || sort === 'length' ? { sort } : {}),
            limit: offset + limit,
          })
          return {
            page: ap.index,
            // Rows, not objects: the same numbers in about a third of the text.
            lineFormat: '[x1, y1, x2, y2, lengthPoints, lengthFeet, angle, cut?]; ends normalized 0..1 with y down; lengthFeet is null without a scale; a trailing 1 means the line goes on past the box',
            lines: lines.slice(offset).map((l) => [l.x1, l.y1, l.x2, l.y2, l.lengthPoints, l.lengthFeet, l.angle, ...(l.cut === true ? [1] : [])]),
            total,
            ...(duplicatesRemoved > 0 ? { duplicatesRemoved } : {}),
            // Nothing is dropped: the rest comes with `offset`.
            ...(total > lines.length ? { nextOffset: lines.length, note: 'more lines follow; ask again with `offset` set to nextOffset' } : {}),
            ...(g.truncated ? { note: 'the box holds more geometry than was read; use a smaller box' } : {}),
          }
        }
        /*
         * A working copy of the open PDF, beside it, for takeoff on a file
         * that is not ours to write into: a client's tender set with someone
         * else's markups. The copy carries everything the open file has, and
         * nothing is written to the original. The agent opens the copy with
         * redbeam_open_file and works there.
         */
        case 'save_copy': {
          const db = dbRef.current
          const doc = documents.find((d) => d.id === leftDocRef.current)
          if (!db || !doc) return { error: 'no document is open' }
          if (projectBridge.createDocument === undefined) return { error: 'this build cannot write files' }
          const copyOpts = {
            db, documentId: doc.id, relativePath: doc.relativePath, displayName: doc.displayName || doc.relativePath, appVersion: APP_VERSION,
            allScopes: light,
            ...(pageRotationsRef.current.has(doc.id) ? { pageRotations: pageRotationsRef.current.get(doc.id)! } : {}),
            ...(params['withoutEmbeddedMarkups'] === true ? { withoutForeign: true } : {}),
          }
          // A big drawing is copied by the core with the takeoff appended, never read whole.
          const big = await openRanged(projectBridge, projectPath, doc.relativePath)
          try {
            const bigTail = big === null ? null : (await big.embed(await copyInput(copyOpts))).tail
            const bytes = big === null ? await embedCopy({ ...copyOpts, read: () => projectBridge.readDocument(projectPath, doc.relativePath) }) : null
            const beside = doc.relativePath.includes('/') ? doc.relativePath.slice(0, doc.relativePath.lastIndexOf('/') + 1) : ''
            const sep = projectPath.includes('\\') ? '\\' : '/'
            const root = projectPath.replace(/[\\/]+$/, '')
            // `name` may carry folders, or be a full path (copyTarget).
            let target: CopyTarget = typeof params['name'] === 'string' && params['name'].trim() !== ''
              ? copyTarget(params['name'])
              : { kind: 'relative', folder: '', name: '' }
            if (target.kind === 'error') return { error: target.error }
            // A full path inside the open file's folder is the same as a relative one.
            if (target.kind === 'absolute' && target.folder.toLowerCase().startsWith(root.toLowerCase() + sep)) {
              target = { kind: 'relative', folder: target.folder.slice(root.length + 1).split(sep).join('/'), name: target.name }
            }
            const elsewhere = target.kind === 'absolute'
            if (elsewhere && projectBridge.writeExport === undefined) return { error: 'this build cannot write files' }
            const folder = elsewhere ? target.folder : (target.folder === '' ? beside : (target.folder.toLowerCase().startsWith(beside.toLowerCase()) ? target.folder : beside + target.folder))
            const named = target.name !== '' ? target.name : copyName(doc.relativePath)
            // "name 2.pdf", "name 3.pdf" and on, until a name is free (it gave up after 20).
            for (let n = 1; ; n++) {
              const name = n === 1 ? named : named.replace(/\.pdf$/i, ` ${n}.pdf`)
              try {
                let path: string
                if (big !== null) {
                  path = (await big.copyTo(elsewhere
                    ? { kind: 'path', path: folder + name, overwrite: false }
                    : { kind: 'project', projectPath, relativePath: folder + name }, bigTail))!
                } else if (elsewhere) {
                  path = await projectBridge.writeExport!(folder + name, bytes!, false)
                } else {
                  await projectBridge.createDocument(projectPath, folder + name, bytes!)
                  path = `${root}${sep}${(folder + name).split('/').join(sep)}`
                }
                setStatus(`saved a working copy: ${name}`)
                return {
                  path, name,
                  ...(params['withoutEmbeddedMarkups'] === true ? { embeddedMarkups: 'left out' } : {}),
                  note: 'the original was not changed; open this copy with redbeam_open_file and take off there',
                }
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err)
                if (!/already there/.test(msg)) return { error: `could not save a copy: ${msg}` }
              }
            }
          } finally {
            big?.release()
          }
        }
        case 'set_layout_preview': {
          const on = params['on'] !== false
          const view = agentView()
          if (view !== null) {
            view.layoutOn = on
            return { layoutPreview: on, note: 'the layout preview on screen is the person\'s to turn on; redbeam_get_piece_list and redbeam_get_bom give you the layout\'s pieces either way' }
          }
          setLayoutOn(on)
          return { layoutPreview: on }
        }
        /*
         * Open a panel, the way the icon rail and the palette do.
         *
         * A panel is not decoration here. The bill of materials and its three
         * exports exist only while that dialog is up, so an agent that could
         * not open it could measure an entire set and never reach the thing
         * the measuring was for — and the export buttons could not be checked
         * from an agent's seat at all.
         *
         * `only` rather than the individual setters, because the panels
         * exclude each other: setting two flags leaves the precedence chain to
         * pick one and the other silently never draws.
         */
        case 'open_panel': {
          const which = String(params['panel'] ?? '')
          if (agentView() !== null) {
            return { panel: 'none', note: 'panels are the person\'s and none was opened. Everything a panel shows has a tool: redbeam_get_bom, redbeam_get_piece_list, redbeam_list_scopes, redbeam_update_scope, redbeam_get_settings, redbeam_export' }
          }
          switch (which) {
            case 'bom':
              if (light) return { error: 'there is no parts panel to open now; redbeam_get_bom and redbeam_get_piece_list give the parts, and redbeam_export writes them to a file' }
              openParts(); return { panel: 'bom' }
            case 'browser':
              if (light) return { error: 'there is no file browser panel now; redbeam_open_file opens a PDF and redbeam_list_sheets lists its sheets' }
              openBrowser(); return { panel: 'browser' }
            case 'scope': openScopeEditor(); return { panel: 'scope' }
            case 'settings': openSettings(); return { panel: 'settings' }
            case 'none': closeModals(); return { panel: 'none' }
            default: return { error: `unknown panel: ${which}` }
          }
        }
        /*
         * The named scales, with their ids.
         *
         * A scale is chosen from this list, never typed, and the ids are not
         * guessable — an agent reaching for `1/8"` or `arch-1/8` writes a
         * scale that does not exist, and the failure it gets back says nothing
         * about what would have worked.
         */
        case 'get_scale_presets': {
          return {
            presets: SCALE_PRESETS.map((p) => ({
              id: p.id,
              label: p.label,
              system: p.system,
              feetPerPoint: feetPerPointForPreset(p),
            })),
          }
        }
        /*
         * The bill of materials — the deliverable, as the panel computes it.
         *
         * Built from the same `buildBom` over the same `pieces` the panel
         * renders. A second roll-up computed for the bridge is how an agent
         * ends up confidently reporting a number nobody else in the app can
         * see, which is worse than not reporting one.
         *
         * `confidence` per line is the part that must not be dropped on the
         * way out: a blocked line carries no quantity at all, and an
         * unverified one is a count this build has never checked against the
         * Qt original. A total that flattens the three is a bid.
         */
        case 'get_bom': {
          /*
           * One scope, or a few, instead of the whole bill (NOIC report,
           * 2026-11-26: "at about 60 KB per call it overflows my context").
           * `brief` says each scope's note once instead of on every line.
           */
          const wanted = bomScopeFilter(params, scopesRef.current)
          if ('error' in wanted) return wanted
          const entries = wanted.ids === null ? piecesRef.current : piecesRef.current.filter((p) => wanted.ids!.has(p.scope.id))
          const bom = buildBom(entries)
          const brief = params['brief'] === true
          const notes: Record<string, string> = {}
          const lines = bom.lines.map((l) => {
            let out: Record<string, unknown> = { ...l }
            // A blocked line names the keys to set, not only their labels (round 3 #1).
            if (l.confidence === 'blocked') {
              const sc = scopesRef.current.find((x) => x.id === l.scopeId)
              const keys = sc === undefined ? [] : missingKeys(readProductType(sc.specifications), sc.specifications)
              if (keys.length > 0) out = { ...out, missing: keys }
            }
            if (brief) {
              if (l.note !== undefined && l.confidence !== 'blocked') { notes[l.scopeId] ??= l.note; delete out['note'] }
              delete out['productType']
            }
            return out
          })
          /*
           * Per area (NOIC report: "show layout counts per area as well as
           * per scope, so drawn and counted numbers can be compared room by
           * room"). Each area is laid out alone, with the same settings the
           * scope's count uses, so its numbers are the ones its pieces show.
           */
          const layOut = layOutRef.current
          const perArea = params['perArea'] === true && layOut !== undefined
            ? perAreaCounts(entries.map((e) => e.scope), projectMarkupsRef.current, layOut, (pid) => {
              const pg = pageNumberFrom(pid, docIdRef.current)
              return { page: pg, sheet: pg === null ? null : sheetLabelFor(pg) }
            })
            : undefined
          return {
            ...(wanted.ids !== null ? { scopes: [...wanted.ids] } : {}),
            lines,
            ...(brief && Object.keys(notes).length > 0 ? { notes } : {}),
            /*
             * Runs longer than the stock they are cut from (NOIC report): each
             * is jointed, and the shortest stock that would run them whole.
             */
            ...((): Record<string, unknown> => {
              const warn = entries.filter((e) => e.result.blockers.length === 0 && e.result.runs.length > 0)
                .map((e) => ({ e, over: pieceList(e.result).longerThanStock }))
                .filter((x) => x.over !== undefined)
                .map(({ e, over }) => ({ scopeId: e.scope.id, scope: e.scope.label, stockFeet: over!.stockFeet, runs: over!.runs, longest: over!.longest, joints: over!.joints, fitsWithoutJoints: over!.fitsWithoutJoints }))
              return warn.length > 0 ? { longerThanStock: warn } : {}
            })(),
            /*
             * What to look at again: a cassette width that holds no whole
             * number of baffles (#176), and spacing with only the RCP, or
             * nothing recorded, behind it (#179).
             */
            ...((): Record<string, unknown> => {
              const checks = entries.map((e) => {
                const flags = [...(e.result.warnings ?? []), ...[spacingSourceFlag(e.scope.specifications)].filter((x): x is string => x !== null)]
                return flags.length > 0 ? { scopeId: e.scope.id, scope: e.scope.label, checks: flags } : null
              }).filter((x) => x !== null)
              return checks.length > 0 ? { toCheck: checks } : {}
            })(),
            /*
             * The frame round each scope's field, per sheet, with the edges
             * its areas share (a chevron's fold line) counted once and apart.
             */
            ...(params['perimeter'] === true ? {
              perimeters: entries.map((e) => ({
                scopeId: e.scope.id,
                sheets: fieldPerimeters(
                  projectMarkupsRef.current.filter((m) => m.scopeId === e.scope.id && m.kind === 'area'),
                  (pid) => projectPageBoxes.get(pid) ?? null,
                  (pid) => projectCalibrationsLatest.current.get(pid) ?? null,
                  (pid) => { const pg = pageNumberFrom(pid, docIdRef.current); return { page: pg, sheet: pg === null ? null : sheetLabelFor(pg) } },
                ),
              })),
            } : {}),
            ...(perArea !== undefined ? {
              areas: perArea.areas,
              areaItems: perArea.items,
              areaNote: 'each area laid out on its own with the scope\'s settings; counts are keyed as in areaItems. A connector shared by two areas is counted in both, so area connectors can add up to more than the scope\'s',
            } : {}),
            totals: bom.totals,
            counts: bom.counts,
            needsAttention: bom.needsAttention,
            // The bill is project-wide; so is this.
            calibrated: projectCalibrations.size > 0,
            // Settings that change the counts (P1-6); set_setting changes them.
            layoutSettings: layoutSettingsAnswer(),
          }
        }
        /*
         * The three exports the BOM panel offers.
         *
         * TSV and the report come back as TEXT rather than as a saved file.
         * The buttons hand a blob to the browser's downloader, which puts it
         * somewhere an agent cannot read and cannot choose — so for those two
         * the useful thing to return is the content itself, and an agent that
         * wants a file can write one.
         *
         * The marked-up PDF is the exception: it goes through
         * `exportMarkedDrawing`, the same callback the button calls, because
         * the write-back walks the source PDF and there is nowhere to put a
         * multi-megabyte binary in a JSON reply. It lands in the user's
         * downloads, and this reports only whether it was written.
         */
        case 'export': {
          const what = String(params['what'] ?? '')
          /*
           * Written to a path the agent chose (round 3 #15) instead of
           * returned as text or dropped in Downloads.
           */
          const target = typeof params['path'] === 'string' && params['path'].trim() !== ''
            ? { path: params['path'].trim(), overwrite: params['overwrite'] === true } : undefined
          const toFile = async (format: string, text: string): Promise<Record<string, unknown>> => {
            if (target === undefined) return { format, text }
            if (projectBridge.writeExport === undefined) return { error: 'this build cannot write files' }
            try {
              const written = await projectBridge.writeExport(target.path, new TextEncoder().encode(text), target.overwrite)
              return { format, saved: true, path: written, bytes: text.length }
            } catch (err) { return { error: err instanceof Error ? err.message : String(err) } }
          }
          if (what === 'pieces-csv') {
            // Caps, connectors and joiners per piece (Coinbase blind test #9): the columns add up to the BOM's lines.
            const rowsOut = ['scope,page,area,run,run length,piece,cut,cut ft,cut to fit,stock fraction,family,offcut ft,start cap,end cap,connectors,joiners']
            for (const p of piecesRef.current) {
              if (p.result.blockers.length > 0 || p.result.runs.length === 0) continue
              const list = pieceList(p.result)
              const q = (t: string) => `"${t.replace(/"/g, '""')}"`
              for (const r of list.runs) {
                const pg = pageNumberFrom(r.pageId, docIdRef.current)
                r.pieces.forEach((pc, i) => rowsOut.push([q(p.scope.label), pg === null ? '' : q(sheetLabelFor(pg)), r.area + 1, r.run + 1, q(r.length), i + 1, q(pc.cut), pc.cutFeet, pc.cutToFit ? 'yes' : '', pc.stockFraction, pc.family, pc.offcutFeet, pc.startCap ? 1 : 0, pc.endCap ? 1 : 0, pc.connectors, pc.joiners].join(',')))
              }
            }
            return toFile('pieces-csv', rowsOut.join('\r\n') + '\r\n')
          }
          /*
           * Never a Save dialog for an AI app: it would come up over
           * whatever the person is doing, in whatever app, and wait there.
           */
          if (target === undefined && projectBridge.desktop && (what === 'marked-pdf' || what === 'pdf')) {
            return { error: `export ${what} needs \`path\`: where to write the file. REDBEAM does not open a Save dialog for an AI app.` }
          }
          if (what === 'marked-pdf') {
            // Awaited: the write-back can fail on a source file it cannot
            // read, and reporting `saved` before it returns records that
            // failure as a success.
            const problem = await exportMarkedDrawing(target)
            return problem === null
              ? { format: 'marked-pdf', saved: true, markups: markupsOnOpenDrawing, ...(target !== undefined ? { path: target.path } : {}) }
              : { error: problem }
          }
          if (what === 'csv' || what === 'estimate-tsv' || what === 'pdf') {
            const id = String(params['estimateId'] ?? openEstimateIdRef.current ?? '')
            const draft = await buildExportFor(id)
            if (draft === null) return { error: `no such estimate: ${id || '(none open)'}` }
            if (what === 'csv') return toFile('csv', estimateToCsv(draft))
            if (what === 'estimate-tsv') return toFile('estimate-tsv', estimateToTsv(draft))
            const result = await saveEstimatePdf(draft, () => {}, target)
            return result.problem === null
              ? { format: 'pdf', saved: true, said: result.said, scopes: draft.scopes.length }
              : { error: result.problem }
          }
          const bom = buildBom(piecesRef.current)
          if (what === 'tsv') return toFile('tsv', bomToTsv(bom))
          if (what === 'report') {
            // The same inputs the panel passes. `projectName` is the shared
            // value both read, so the agent's report and the button's report
            // cannot disagree about it; the rest is still mirrored by hand,
            // so a new header field has to be added in both places.
            const html = renderTakeoffReport({
              projectName,
              estimateName: openEstimate?.name ?? 'Takeoff',
              bom,
              documents: documents.map((d) => d.displayName || d.relativePath),
              generatedAt: new Date(),
            })
            if (target !== undefined) return toFile('report', html)
            return { format: 'report', bytes: html.length, html }
          }
          return { error: `unknown export: ${what} (tsv, report, marked-pdf, csv, estimate-tsv or pdf)` }
        }
        /*
         * Save a scope's current answer now rather than when the change
         * settles. The app saves by itself; this is for an agent that wants
         * the record written before it reports. Not undoable: a saved run is
         * a RECORD of what the takeoff said, superseded by the next save.
         */
        case 'commit_scope': {
          const id = String(params['scopeId'] ?? agentScope() ?? '')
          const sc = scopesRef.current.find((x) => x.id === id)
          if (!sc) return noScope(id)
          const p = piecesRef.current.find((x) => x.scope.id === id)
          if (!p) return { error: `no calculation for ${sc.label} yet` }
          if (p.result.blockers.length > 0) {
            return { error: `cannot save ${sc.label}: ${p.result.blockers.join('; ')}` }
          }
          // Awaited: reporting a save that has not happened yet is how a
          // failure gets recorded as a success.
          const outcome = await saveScopeRun(id)
          if (outcome === 'saved') { saveRef.current(); await refreshCommitted() }
          return { committed: sc.label, quantities: p.result.quantities.length, unchanged: outcome === 'unchanged' }
        }

        // ---- writes ----
        //
        // These go through runCommand, the SAME path a drawn markup takes, so
        // they are recorded on the undo stack, broadcast to other windows, and
        // marked with an origin. A bridge that wrote rows directly would
        // produce takeoff changes with no undo entry and no activity trail —
        // the reason the bridge's execute_query refuses writes outright.
        /*
         * A comment markup (kind note): text box, cloud, Cloud+, leader with
         * text, line, rectangle, ellipse, polygon or pen, as the Markup tools
         * draw them and saved as Bluebeam's own annotations (agents/agentNotes.ts).
         */
        case 'create_note': {
          const probe = document.createElement('canvas').getContext('2d')
          const measure = (pt: number) => probe === null ? roughMeasure(pt) : canvasMeasure(probe, pt)
          const built = noteFromAgent(params, ap.size, measure)
          if ('error' in built) return built
          const id = uid()
          const ok = await runCommand(cmdCreate({
            id, documentId: docIdRef.current, pageId: ap.id, scopeId: null,
            kind: 'note', rings: built.rings, origin: 'agent', reviewState: 'accepted',
            content: built.content as unknown as Record<string, unknown>,
          }))
          if (!ok) return { error: 'the note could not be written' }
          requestPaint()
          return { id, kind: 'note', shape: built.content.shape, page: ap.index, sheet: sheetLabelFor(ap.index), note: 'saving writes it into the PDF as a markup Bluebeam can edit' }
        }
        case 'create_markup': {
          const kind = String(params['kind'] ?? '')
          const allowed: MarkupKind[] = ['area', 'cutout', 'polyline', 'count', 'shape']
          if (!allowed.includes(kind as MarkupKind)) return { error: `cannot create kind: ${kind}` }

          const built = agentMarkup(params, docIdRef.current, ap.id)
          if ('error' in built) return built
          const ring = built.markup.rings[0]!
          // Page points would be in the hundreds and would still "work",
          // producing a markup somewhere off the sheet. Reject rather than
          // silently place it.
          for (const p of ring as Array<{ x?: unknown; y?: unknown }>) {
            const x = Number(p?.x), y = Number(p?.y)
            if (!Number.isFinite(x) || !Number.isFinite(y) || x < -0.05 || x > 1.05 || y < -0.05 || y > 1.05) {
              return { error: `vertex out of normalized range: ${JSON.stringify(p)}` }
            }
          }
          const min = kind === 'area' || kind === 'cutout' ? 3 : kind === 'count' ? 1 : 2
          if (ring.length < min) return { error: `${kind} needs at least ${min} vertices` }

          const scopeId = built.markup.scopeId
          const docId = docIdRef.current
          const pageId = ap.id
          // A cutout cuts the areas under it, as the canvas's cutter does.
          if (kind === 'cutout') {
            // With a scope named, only that scope's areas are cut: an opening
            // drawn for one product is not an opening in the one beside it.
            const named = typeof params['scopeId'] === 'string' ? params['scopeId'] : null
            const edits = cutEdits(ap.markups, pageId, ring as Array<{ x: number; y: number }>, { notch: true })
              .filter((e) => named === null || ap.markups.find((m) => m.id === e.id)?.scopeId === named)
            if (edits.length === 0) return { error: named === null ? 'the cutout crosses no area on this sheet' : 'the cutout crosses no area of that scope on this sheet' }
            await runCommand(editsCommand(edits, 'cut area', 'agent')!)
            // Each hole's id, which delete_markup takes to remove that one hole.
            // A cut across an outline notches it instead and adds no hole.
            return {
              cut: edits.map((e) => e.id),
              holes: edits.filter((e) => e.after.length > e.before.length).map((e) => `${CUT_PREFIX}${e.id}:${e.after.length - 1}`),
              notched: edits.filter((e) => e.after.length <= e.before.length).map((e) => e.id),
              kind, pageId,
            }
          }
          const id = uid()
          // Awaited: an id reported before the write lands is a markup the next call cannot find.
          await runCommand(cmdCreate({
            id, documentId: docId, pageId, scopeId,
            // An area keeps its holes; every other kind is one ring.
            kind, rings: kind === 'area' ? built.markup.rings : [ring as Array<{ x: number; y: number }>],
            // `agent`, not `user`: the activity trail must be able to say who
            // drew a markup, and a review gate cannot filter what it cannot see.
            origin: 'agent', reviewState: 'accepted',
          }))
          const notes: string[] = []
          // A crossed or stray outline still gives a number; say it is not to be trusted.
          if (kind === 'area' || kind === 'shape') notes.push(...outlineWarnings(built.markup.rings).map((i) => i.message))
          if (scopeId === null && kind !== 'shape') notes.push('it has no scope, so it counts toward nothing; reassign_markup gives it one')
          if (ap.feetPerPoint === null && !(projectRegions.get(pageId) ?? []).length) notes.push(`${sheetLabelFor(ap.index)} has no scale, so this measures nothing yet; set_page_scale or read_scale`)
          // What it measures at the sheet's scale, holes taken out.
          const made = kind === 'area' ? built.markup.rings : [ring as Array<{ x: number; y: number }>]
          const isClosed = kind === 'area' || kind === 'shape'
          const mOpts = { closed: isClosed, regions: projectRegions.get(pageId) ?? [], pageFeetPerPoint: ap.feetPerPoint }
          const outer = measurePoints(made[0]!, { width: ap.size.width, height: ap.size.height }, mOpts)
          let net = outer.areaSquareFeet ?? null
          if (net !== null) for (const hole of made.slice(1)) net -= measurePoints(hole, { width: ap.size.width, height: ap.size.height }, mOpts).areaSquareFeet ?? 0
          const measure = kind === 'count' ? { count: made[0]!.length }
            : isClosed ? { areaSquareFeet: net === null ? null : Math.round(Math.max(0, net) * 1000) / 1000, perimeterFeet: outer.lengthFeet, perimeter: outer.length }
              : { lengthFeet: outer.lengthFeet, length: outer.length }
          return { id, kind, scopeId, pageId, page: ap.index, sheet: sheetLabelFor(ap.index), measure, ...(notes.length > 0 ? { warnings: notes } : {}) }
        }

        case 'delete_markup': {
          const id = String(params['id'] ?? '')
          // One hole of an area, by the id a cutout answers with ("cut:<area>:<n>").
          if (isCutId(id)) {
            const cmd = editsCommand(uncutEdits(docMarkupsRef.current, id), 'delete cutout', 'agent')
            if (cmd === null) return { error: `no such cutout: ${id}. list_markups gives each area's id and how many holes it has; a hole is cut:<area id>:<1-based hole number>` }
            await runCommand(cmd)
            return { deleted: id, area: cutOwner(docMarkupsRef.current, id)?.id ?? null }
          }
          const m = docMarkupsRef.current.find((x) => x.id === id)
          if (!m) return { error: `no such markup: ${id}` }
          if (agentView() === null && !ap.markups.some((x) => x.id === id)) {
            const pg = pageNumberFrom(m.pageId, docIdRef.current)
            if (pg !== null) await showPageForAgent(pg)
          }
          await removeMarkup(id, 'agent')
          return { deleted: id }
        }

        case 'set_calibration': {
          const value = String(params['value'] ?? '')
          const unit = String(params['unit'] ?? 'ft')
          // Two normalized points along the known length, or its length in PDF points.
          const ends = Array.isArray(params['points']) ? (params['points'] as unknown[]).map(bridgePoint) : []
          const lengthPoints = ends.length === 2 && ends[0] !== null && ends[1] !== null
            ? Math.hypot((ends[1]!.x - ends[0]!.x) * ap.size.width, (ends[1]!.y - ends[0]!.y) * ap.size.height)
            : Number(params['lengthPdfPoints'])
          if (!Number.isFinite(lengthPoints) || lengthPoints <= 0) {
            return { error: 'set_calibration needs `points` (the two ends of the known length, normalized) or a positive lengthPdfPoints' }
          }
          const c = calibrationFromReference(lengthPoints, Number(parseNumberOrFraction(value) ?? NaN), unit, ap.size.width, ap.size.height)
          if (!c) return { error: `could not read "${value}" ${unit} over ${lengthPoints}pt` }
          const previous = ap.feetPerPoint
          await commitCalibration(c, 'agent', 'agent', ap.index)
          return { feetPerPoint: c.feetPerPoint, scale: scaleLabel(c.feetPerPoint), previousFeetPerPoint: previous, page: ap.index }
        }

        case 'set_scope_direction': {
          // The same write the direction tool makes. Exposed because the
          // layout engine refuses to guess an axis, so without this an agent
          // can draw takeoff it can never turn into a piece count.
          const id = String(params['scopeId'] ?? agentScope() ?? '')
          const sc = scopesRef.current.find((x) => x.id === id)
          if (!sc) return noScope(id)
          const n = (k: string) => Number(params[k])
          const [x1, y1, x2, y2] = ['x1', 'y1', 'x2', 'y2'].map(n)
          if ([x1, y1, x2, y2].some((v) => !Number.isFinite(v))) {
            return { error: 'set_scope_direction needs x1,y1,x2,y2 in NORMALIZED [0,1] coords' }
          }
          if (x1 === x2 && y1 === y2) return { error: 'a zero-length vector is not a direction' }
          await saveScope({
            ...sc,
            specifications: {
              ...sc.specifications,
              scopeDefaultDirection: { sourcePage: ap.index, x1, y1, x2, y2 },
            },
          })
          return { scopeId: id, direction: { x1, y1, x2, y2 } }
        }

        /*
         * Scope lifecycle — create, edit, duplicate, archive.
         *
         * Without these an agent could draw takeoff but not decide what it was
         * takeoff OF, which left it able to measure a project it could not set
         * up: every markup had to land in a scope somebody else had already
         * built by hand.
         */
        case 'create_scope': {
          const label = String(params['label'] ?? '').trim()
          if (label === '') return { error: 'create_scope needs a label' }
          const types: Array<Scope['scopeType']> = ['area', 'linear', 'count']
          /*
           * The product, stated rather than guessed (round 3 #2). It decides
           * what the scope is measured as, so scopeType may be left out.
           */
          const productRaw = typeof params['productType'] === 'string' ? params['productType'].trim() : ''
          const product = productRaw === '' ? null : canonicalProductType(productRaw)
          if (product !== null && product === 'baffle' && !/baffle/i.test(productRaw)) {
            return { error: `unknown productType "${productRaw}": use one of ${PRODUCT_TYPES.join(', ')}` }
          }
          /*
           * A recipe with the scope, in one call (NOIC, 2026-11-26: it was
           * refused and the agent sent to save_pattern). It still goes through
           * save_pattern's checks and is still a draft: the scope is made,
           * then the recipe saved on it.
           */
          const recipeSent = params['recipe'] ?? objectParam(params['specifications'])?.[PATTERN_RECIPE_KEY]
          if (recipeSent !== undefined && recipeSent !== null && product !== null && product !== 'custom_pattern') {
            return { error: `a recipe makes the scope a custom_pattern, not a ${product}; leave productType out or send custom_pattern` }
          }
          if (product === 'custom_pattern' || (recipeSent !== undefined && recipeSent !== null)) {
            const off = patternsOff()
            if (off !== null) return off
          }
          if (recipeSent !== undefined && recipeSent !== null) {
            const check = checkPatternRecipe(typeof recipeSent === 'string' ? ((): unknown => { try { return JSON.parse(recipeSent) } catch { return recipeSent } })() : recipeSent)
            if (!check.ok) return { error: 'the recipe does not check, so no scope was made', errors: check.errors, warnings: check.warnings, format: 'describe_product {productType:"custom_pattern"}' }
          }
          const implied = product === null
            ? (recipeSent !== undefined && recipeSent !== null ? 'area' : null)
            : scopeTypeForProduct(product)
          const scopeType = String(params['scopeType'] ?? implied ?? '') as Scope['scopeType']
          if (!types.includes(scopeType)) {
            return { error: `scopeType must be one of ${types.join(', ')}${product === 'custom_assembly' ? ' (a custom assembly can be any of them)' : ''}` }
          }
          if (implied !== null && scopeType !== implied) {
            return { error: `a ${PRODUCT_TYPE_LABEL[product!]} scope is measured as ${implied}, not ${scopeType}` }
          }
          /*
           * Two scopes with one label are indistinguishable in the shelf, in
           * the quantity rows and in the rescope list, and rescoping into the
           * wrong one is silent. The scope editor disambiguates duplicates it
           * makes; there is nothing to disambiguate a name typed twice.
           */
          if (scopesRef.current.some((s) => s.label === label)) {
            return { error: `a scope called "${label}" already exists` }
          }
          const sentRaw = objectParam(params['specifications'])
          if (sentRaw === null) return { error: 'specifications must be an object' }
          const sent = sentRaw === undefined ? undefined : (() => { const { [PATTERN_RECIPE_KEY]: _r, ...rest } = sentRaw; void _r; return rest })()
          // A measure sent as a number is the text the product reads.
          const specs = sent === undefined ? undefined : measuresAsText(sent)
          const scope: Scope = {
            id: `sc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
            label,
            scopeType,
            color: typeof params['color'] === 'string' ? params['color'] : '#39a2ff',
            specifications: product === null
              ? (recipeSent !== undefined && recipeSent !== null ? writeProductType(specs ?? {}, 'custom_pattern') : (specs ?? {}))
              : writeProductType(specs ?? {}, product),
          }
          // In the person's PDF the new scope is the agent's to draw in, not the person's active one.
          const guest = !agentCtxRef.current.drives
          await createScope(scope, { activate: !guest })
          if (agentCtxRef.current.agent != null) guestScopeRef.current.set(agentCtxRef.current.agent.id, scope.id)
          /*
           * A scope belongs to a bidding round, never to the project. Created
           * with no round open it exists, accepts markups, shows a quantity on
           * the sheet — and is in no total anywhere. Reported rather than
           * refused, because the same is true of the button.
           */
          await scopeWhen(scope.id, () => true)
          const pattern = recipeSent === undefined || recipeSent === null ? null
            : await invokeAction('save_pattern', { scopeId: scope.id, recipe: recipeSent })
          const made = (pattern !== null && pattern['saved'] === true
            ? await scopeWhen(scope.id, (x) => x.specifications[PATTERN_RECIPE_KEY] !== undefined)
            : undefined) ?? scopesRef.current.find((x) => x.id === scope.id) ?? scope
          const madeProduct = readProductType(made.specifications)
          const stillNeeds = madeProduct === 'custom_pattern' ? [] : missingKeys(madeProduct, made.specifications)
          return {
            ...(pattern !== null ? { pattern } : {}),
            scopeId: scope.id,
            label,
            scopeType,
            productType: madeProduct,
            ...(((u) => u.length > 0 ? { ignoredKeys: u, warning: `nothing reads ${u.join(', ')} for a ${madeProduct}; see describe_product for the keys that count` } : {})(unknownSpecKeys(madeProduct, scope.specifications))),
            ...(stillNeeds.length > 0 ? { needs: stillNeeds, note: 'set these with update_scope {specifications}; describe_product lists every field' } : {}),
            estimateId: openEstimateIdRef.current,
            inEstimate: openEstimateIdRef.current !== null,
          }
        }

        case 'update_scope': {
          const id = String(params['scopeId'] ?? agentScope() ?? '')
          const sc = scopesRef.current.find((x) => x.id === id)
          if (!sc) return noScope(id)
          const sent = objectParam(params['specifications'])
          if (sent === null) return { error: 'specifications must be an object' }
          // A measure sent as a number is the text the product reads.
          const specs = sent === undefined ? undefined : measuresAsText(sent)
          /*
           * MERGED, not replaced.
           *
           * `specifications` is not only the product spec: the direction tool
           * writes the scope's pattern axis into it, and so do the per-sheet
           * and per-area overrides. A replacing write from an agent editing a
           * panel size would drop every one of them, and the piece counts
           * would change without the count ever being touched.
           *
           * An explicit null removes a key — the one thing a merge cannot
           * otherwise express, and without it a spec field set by mistake
           * could never be taken off again.
           */
          /*
           * A recipe sent here goes through save_pattern's checks, after the
           * rest of the change (NOIC, 2026-11-26: it was refused, sending the
           * agent to a second tool for what is one change).
           */
          const recipeSent = params['recipe'] ?? (specs !== undefined && specs[PATTERN_RECIPE_KEY] !== null ? specs[PATTERN_RECIPE_KEY] : undefined)
          const specsSent = specs === undefined ? undefined : (() => { const { [PATTERN_RECIPE_KEY]: r, ...rest } = specs; return r === null ? specs : rest })()
          let merged: Record<string, unknown> = { ...sc.specifications }
          if (specsSent !== undefined) {
            for (const [k, v] of Object.entries(specsSent)) {
              if (v === null) delete merged[k]
              else merged[k] = v
            }
          }
          /*
           * The product AFTER the specifications, which used to be merged
           * from the scope as it was and so threw a new productType away
           * (NOIC, 2026-11-26: a custom pattern scope could not become a
           * baffle). A new product also brings its own measure, area for every
           * laid-out product, unless scopeType says otherwise.
           */
          const nextProductRaw = typeof params['productType'] === 'string' ? params['productType'].trim() : ''
          let impliedType: Scope['scopeType'] | null = null
          if (nextProductRaw !== '') {
            const np = canonicalProductType(nextProductRaw)
            if (np === 'baffle' && !/baffle/i.test(nextProductRaw)) {
              return { error: `unknown productType "${nextProductRaw}": use one of ${PRODUCT_TYPES.join(', ')}` }
            }
            if (np === 'custom_pattern' && readProductType(sc.specifications) !== 'custom_pattern') {
              const off = patternsOff()
              if (off !== null) return off
            }
            merged = writeProductType(merged, np)
            if (np !== readProductType(sc.specifications)) impliedType = scopeTypeForProduct(np)
          } else if (recipeSent !== undefined && recipeSent !== null) {
            const off = patternsOff()
            if (off !== null) return off
          }
          const types: Array<Scope['scopeType']> = ['area', 'linear', 'count']
          const nextType = params['scopeType'] ?? impliedType ?? undefined
          if (nextType !== undefined && !types.includes(nextType as Scope['scopeType'])) {
            return { error: `scopeType must be one of ${types.join(', ')}` }
          }
          const label = typeof params['label'] === 'string' ? params['label'].trim() : sc.label
          if (label === '') return { error: 'a scope needs a label' }
          if (label !== sc.label && scopesRef.current.some((s) => s.label === label)) {
            return { error: `a scope called "${label}" already exists` }
          }
          const next: Scope = {
            ...sc,
            label,
            scopeType: (nextType as Scope['scopeType'] | undefined) ?? sc.scopeType,
            color: typeof params['color'] === 'string' ? params['color'] : sc.color,
            specifications: merged,
          }
          await saveScope(next)
          const wanted = (x: Scope) => x.label === next.label && x.scopeType === next.scopeType && x.color === next.color
            && stableJson(x.specifications) === stableJson(next.specifications)
          await scopeWhen(id, wanted)
          const pattern = recipeSent === undefined || recipeSent === null ? null
            : await invokeAction('save_pattern', { scopeId: id, recipe: recipeSent })
          if (pattern !== null && pattern['saved'] === true) await scopeWhen(id, (x) => readProductType(x.specifications) === 'custom_pattern' && x.specifications[PATTERN_RECIPE_KEY] !== undefined)
          if (pattern !== null && typeof pattern['error'] === 'string') {
            return { scopeId: id, updated: 'everything but the pattern', patternError: pattern['error'], ...(pattern['errors'] !== undefined ? { errors: pattern['errors'] } : {}) }
          }
          const after = scopesRef.current.find((x) => x.id === id) ?? next
          /*
           * A changed type is reported back loudly: an area scope counts only
           * areas, so retyping one to `count` does not convert its takeoff, it
           * stops every existing markup contributing to a quantity.
           */
          return {
            ...(pattern !== null ? { pattern } : {}),
            scopeId: id,
            label: next.label,
            scopeType: next.scopeType,
            typeChanged: next.scopeType !== sc.scopeType,
            productChanged: readProductType(after.specifications) !== readProductType(sc.specifications),
            productType: readProductType(after.specifications),
            specifications: after.specifications,
            ...(((u) => u.length > 0 ? { ignoredKeys: u, warning: `nothing reads ${u.join(', ')} for a ${readProductType(after.specifications)}; see describe_product for the keys that count` } : {})(unknownSpecKeys(readProductType(after.specifications), after.specifications))),
            ...(((n) => n.length > 0 ? { needs: n } : {})(missingKeys(readProductType(after.specifications), after.specifications))),
          }
        }

        case 'duplicate_scope': {
          const id = String(params['scopeId'] ?? agentScope() ?? '')
          const sc = scopesRef.current.find((x) => x.id === id)
          if (!sc) return noScope(id)
          const made = await duplicateScope(id)
          if (made === undefined) return { error: `could not copy ${sc.label}` }
          return { duplicated: sc.label, scopeId: made.id, label: made.label }
        }

        case 'archive_scope': {
          const id = String(params['scopeId'] ?? '')
          const known = scopesRef.current.some((x) => x.id === id)
            || archivedScopes.some((x) => x.id === id)
          if (!known) return noScope(id)
          const archived = params['archived'] !== false
          await archiveScope(id, archived)
          // Archived, never destroyed: the markups stay, and un-archiving
          // brings the scope and its quantities back exactly as they were.
          return { scopeId: id, archived }
        }

        /*
         * Set a stated scale across a RANGE of sheets.
         *
         * The reference-line tool measures something on ONE page. A drawing
         * set is a hundred sheets at two or three scales printed in the title
         * block, and calibrating each one by hand is the difference between a
         * takeoff an agent can set up and one it cannot. A stated scale needs
         * no measuring: a plotted sheet is at true size, so `1/8" = 1'-0"` IS
         * a feet-per-point.
         *
         * One transaction, in the store. Half a selection carrying a new scale
         * and half carrying the old one is a set where some sheets measure and
         * some do not, with nothing on screen saying which.
         */
        case 'set_page_scale': {
          const presetId = typeof params['presetId'] === 'string' ? params['presetId'] : null
          const raw = params['feetPerPoint']
          let feetPerPoint: number
          let source: string
          if (presetId !== null) {
            const preset = SCALE_PRESETS.find((p) => p.id === presetId)
            if (!preset) {
              return { error: `no such scale preset: ${presetId} — call get_scale_presets` }
            }
            feetPerPoint = feetPerPointForPreset(preset)
            // The source records HOW the scale was set, and it is the
            // difference between a scale a title block states and one
            // somebody measured. `presetSource` is the only speller of it —
            // this used to be an inline template, and a second inline
            // template elsewhere spelt the same fact differently.
            source = presetSource(preset)
          } else if (raw !== undefined) {
            feetPerPoint = Number(raw)
            if (!Number.isFinite(feetPerPoint) || feetPerPoint <= 0) {
              return { error: 'feetPerPoint must be a positive number' }
            }
            source = 'agent'
          } else {
            return { error: 'set_page_scale needs presetId or feetPerPoint' }
          }

          // Defaults to the open sheet, which is what "set the scale" means
          // when nobody said which sheets.
          let pages: number[]
          if (Array.isArray(params['pages'])) {
            pages = (params['pages'] as unknown[]).map(Number)
          } else if (params['fromPage'] !== undefined || params['toPage'] !== undefined) {
            const from = Number(params['fromPage'] ?? 0)
            const to = Number(params['toPage'] ?? from)
            if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) {
              return { error: 'fromPage/toPage must be integers with toPage >= fromPage' }
            }
            pages = Array.from({ length: to - from + 1 }, (_, i) => from + i)
          } else {
            pages = [ap.index]
          }
          // Checked before the write, not during: a partly-applied range is
          // the exact state the transaction exists to prevent.
          const bad = pages.filter((n) => !Number.isInteger(n) || n < 0 || n >= pageCount)
          if (bad.length > 0) {
            return { error: `page(s) out of range (0..${pageCount - 1}): ${bad.join(', ')}` }
          }
          if (pages.length === 0) return { error: 'set_page_scale needs at least one page' }
          // What each sheet measured at before: this write has no undo.
          const was = new Map<string, number>()
          try {
            const rows = await dbRef.current?.all<{ page_id: string; f: number }>(
              'SELECT page_id, feet_per_pdf_point AS f FROM calibrations WHERE document_id = ?1', [docIdRef.current]) ?? []
            for (const r of rows) was.set(r.page_id, r.f)
          } catch { /* a missing "before" is not a reason to refuse the write */ }
          const previous = pages.map((targetPage) => {
            const f = was.get(pageIdFor(docIdRef.current, targetPage)) ?? null
            return { page: targetPage, feetPerPoint: f, scale: f === null ? null : scaleLabel(f) }
          })
          await applyScaleToSelection(pages, feetPerPoint, source)
          return {
            pages,
            previous,
            documentId: docIdRef.current,
            feetPerPoint,
            scale: scaleLabel(feetPerPoint),
            source,
          }
        }

        /*
         * A scale region: a box on the sheet that carries its own scale, for
         * the details sheet where four details sit at four scales and one page
         * number is right for exactly one of them.
         *
         * Two calls, because it is two gestures: drag the box, then answer the
         * picker. Collapsing them here would mean writing the region from the
         * bridge instead of through `commitRegion`, and the picker on screen
         * is also how the person watching finds out an agent is redefining
         * what a part of their sheet measures.
         */
        case 'begin_scale_region': {
          if ((agentView()?.pendingRegion ?? (agentView() === null ? pendingRegion : null)) !== null) {
            return { error: 'a region is already waiting for a scale — set_region_scale or cancel_scale_region' }
          }
          /*
           * A `rect` object rather than four loose numbers. `x1,y1` already
           * mean the SECOND POINT of a direction vector on this surface, and
           * two actions disagreeing about what `y1` is would be a coordinate
           * bug nothing could catch — the call would succeed and the region
           * would simply be somewhere else.
           */
          const r = objectParam(params['rect'])
          if (r === null) return { error: 'rect must be an object: {x0,y0,x1,y1}' }
          const n = (k: string) => Number(r?.[k])
          const x0 = n('x0'), y0 = n('y0'), x1 = n('x1'), y1 = n('y1')
          if ([x0, y0, x1, y1].some((v) => !Number.isFinite(v))) {
            return { error: 'begin_scale_region needs rect: {x0,y0,x1,y1} in NORMALIZED [0,1] coords' }
          }
          // Page points are in the hundreds and would still "work", putting a
          // region off the sheet where it governs nothing.
          if ([x0, y0, x1, y1].some((v) => v < -0.05 || v > 1.05)) {
            return { error: 'scale region corners are outside the page: expected NORMALIZED [0,1]' }
          }
          if (x0 === x1 || y0 === y1) return { error: 'a region with no area governs nothing' }
          const begun = {
            rect: { x0, y0, x1, y1 },
            // The sheet it was drawn on, not the sheet that is open when the
            // scale is chosen — those are two calls apart.
            pageId: ap.id,
          }
          // A session's half-made region waits in its own view: no picker opens over the person's sheet.
          const view = agentView()
          if (view !== null) view.pendingRegion = begun
          else setPendingRegion(begun)
          return { pending: true, next: 'set_region_scale' }
        }

        case 'set_region_scale': {
          const mine = agentView()
          if ((mine !== null ? mine.pendingRegion : pendingRegion) === null) {
            return { error: 'no region is waiting for a scale — call begin_scale_region first' }
          }
          const presetId = typeof params['presetId'] === 'string' ? params['presetId'] : null
          const raw = params['feetPerPoint']
          let feetPerPoint: number
          let source: string
          if (presetId !== null) {
            const preset = SCALE_PRESETS.find((p) => p.id === presetId)
            if (!preset) {
              return { error: `no such scale preset: ${presetId} — call get_scale_presets` }
            }
            feetPerPoint = feetPerPointForPreset(preset)
            source = presetSource(preset)
          } else if (raw !== undefined) {
            feetPerPoint = Number(raw)
            if (!Number.isFinite(feetPerPoint) || feetPerPoint <= 0) {
              return { error: 'feetPerPoint must be a positive number' }
            }
            source = 'agent'
          } else {
            return { error: 'set_region_scale needs presetId or feetPerPoint' }
          }
          const label = typeof params['label'] === 'string' ? params['label'] : ''
          if (mine !== null) {
            await commitRegion(feetPerPoint, source, label, mine.pendingRegion!)
            mine.pendingRegion = null
          } else await commitRegion(feetPerPoint, source, label)
          return { feetPerPoint, scale: scaleLabel(feetPerPoint), label, source }
        }

        case 'cancel_scale_region': {
          const mine = agentView()
          if (mine !== null) {
            if (mine.pendingRegion === null) return { error: 'no region is waiting for a scale' }
            mine.pendingRegion = null
            return { cancelled: true }
          }
          if (pendingRegion === null) return { error: 'no region is waiting for a scale' }
          setPendingRegion(null)
          draftRef.current = emptyDraft('scale-region')
          requestPaint()
          return { cancelled: true }
        }

        case 'delete_scale_region': {
          const id = String(params['id'] ?? '')
          if (!(projectRegions.get(ap.id) ?? []).some((r) => r.id === id)) {
            return { error: `no scale region ${id} on this sheet — see scaleRegions in get_ui_state` }
          }
          // The markups inside it fall back to the PAGE scale, or to nothing.
          // Removing a region is a change to what they measure, not a tidy-up.
          await removeRegion(id)
          return { deleted: id }
        }

        case 'reassign_markup': {
          const id = String(params['id'] ?? '')
          const target = params['scopeId'] === null ? null : String(params['scopeId'] ?? '')
          const m = docMarkupsRef.current.find((x) => x.id === id)
          if (!m) return { error: `no such markup: ${id}` }
          if (target !== null && !scopes.some((sc) => sc.id === target)) {
            return noScope(target)
          }
          await runCommand(cmdReassign(id, m.scopeId, target, undefined, 'agent'))
          return { id, scopeId: target }
        }
        /*
         * Save the takeoff into the PDF now, and say how it went (P1-4):
         * written, unchanged, held (the file's takeoff is not loaded), elsewhere
         * (someone else saved since), busy (open in another app) or failed.
         */
        case 'save': {
          if (activeDocId === null) return { error: 'no document is open' }
          const earlier = lastSaveRef.current
          const out = await saveTakeoffIntoDrawing(activeDocId)
          const ok = out.kind === 'written' || out.kind === 'unchanged' || out.kind === 'nothing-to-embed'
          return {
            saved: ok, outcome: out.kind,
            // REDBEAM saves by itself after each change, so a save asked for a moment later often finds nothing left to write.
            ...(out.kind === 'unchanged' ? {
              message: earlier?.kind === 'written'
                ? `every change is already in the PDF: REDBEAM saved it automatically at ${earlier.at}`
                : 'the PDF already holds everything in this takeoff; there was nothing new to write',
            } : {}),
            ...(out.kind === 'failed' ? { message: out.message } : {}),
            ...(out.kind === 'held' ? { message: out.reason ?? 'the takeoff in this PDF has not finished loading, so nothing was written; call save again in a few seconds' } : {}),
            ...(out.kind === 'busy' ? { message: 'the PDF is open in another app; close it there, or save_copy' } : {}),
            ...(out.kind === 'elsewhere' ? { message: 'someone else saved a takeoff into this PDF since it was opened; nothing was written. save_copy keeps this one' } : {}),
          }
        }
        /*
         * Undo or redo this session's own latest change. Never the person's,
         * and never another session's: each undoes its own work, so an agent
         * and a person can be in one PDF without taking back each other's.
         */
        case 'undo':
        case 'redo': {
          const r = action === 'undo' ? await doUndo('agent') : await doRedo('agent')
          if (r === null) return { error: `nothing of yours to ${action}; a session undoes only its own changes` }
          if ('error' in r) return r
          return { [action === 'undo' ? 'undid' : 'redid']: r.label, op: r.op, undo: undoRef.current?.stateFor(undoActor('agent')) ?? null }
        }
        /* The app's settings, as the Settings page shows them (P1-6). */
        case 'get_settings': {
          return {
            settings: SETTINGS.filter((d) => !LIGHT_HIDDEN_SETTINGS.includes(d.id)).map((d) => ({
              id: d.id, label: d.label, value: prefs[d.id] ?? d.default, default: d.default, type: d.type,
              ...(d.type === 'enum' ? { choices: d.choices.map((c) => c.value) } : {}),
              ...(d.type === 'int' ? { min: d.min, max: d.max } : {}),
            })),
          }
        }
        case 'set_setting': {
          const sid = String(params['setting'] ?? '')
          // The full id, or its last part when that names one setting ("patternStart").
          const tails = SETTINGS.filter((x) => x.id.split('.').pop() === sid)
          const d = SETTINGS.find((x) => x.id === sid) ?? (tails.length === 1 ? tails[0] : undefined)
          if (d === undefined || LIGHT_HIDDEN_SETTINGS.includes(d.id)) return { error: `no setting ${sid}; get_settings lists them` }
          // Back to its default: the Settings page's reset, one setting at a time.
          const why = settings.set(d.id, params['reset'] === true ? d.default : params['value'])
          if (why !== null) return { error: why }
          return { setting: d.id, value: settings.all()[d.id], ...(params['reset'] === true ? { reset: true } : {}) }
        }
        /*
         * Report a bug, as Settings › Report a bug and the prompt's "Report a
         * bug…" do (Aaron, 2026-11-27: "add the report problem or bug report
         * feature as an agent usable tool"). The same Worker and the same
         * GitHub issue labelled "bug report"; the issue says an AI agent sent
         * it. The session name is left out: it carries the client's job name,
         * and issues on a public repo show what was typed.
         */
        case 'report_problem': {
          const agent = agentCtxRef.current.agent
          const box = bridgeRect(params['region'] ?? params['rect'])
          if (box === null) return { error: 'region must be {x0,y0,x1,y1} in normalized [0,1] page coordinates' }
          const doc = documents.find((d) => d.id === activeDocId)
          const targetPage = ap.index
          const view = agentView()
          return reportForAgent({
            params, app: agent?.app ?? null, agentId: agent?.id ?? null,
            where: whereLine([
              projectName, doc === undefined ? null : (doc.displayName || doc.relativePath.split('/').pop()),
              doc === undefined ? null : sheetLabelFor(targetPage),
            ]),
            // A picture of the session's own sheet with the takeoff on it, as the form's "attach a picture" would.
            picture: async () => {
              const v = viewerRef.current
              if (v === null || activeDocId === null) return null
              const out = await v.renderRegion(box ?? view?.rect ?? { x0: 0, y0: 0, x1: 1, y1: 1 }, 1600, {
                page: targetPage,
                overlaySet: toOverlay(docMarkupsRef.current.filter((m) => m.pageId === pageIdFor(docIdRef.current, targetPage) && !isCutId(m.id)), scopesRef.current, pendingIdsRef.current),
              })
              return out.canvas.toDataURL('image/jpeg', 0.85)
            },
          })
        }
        /* What changed in each release, as the What's new dialog shows it. */
        case 'whats_new':
          return whatsNewForAgent(params, RELEASES, APP_VERSION)
        /*
         * Links of REDBEAM's own (kind link): a box on one sheet that jumps
         * to another, as the Link tool draws them, and the detail callouts
         * "Link detail callouts" finds. Saving writes each as a real /Link.
         */
        case 'create_links': {
          const raw = Array.isArray(params['links']) ? params['links'] as unknown[]
            : params['rect'] !== undefined ? [{ page: params['page'], rect: params['rect'], toPage: params['toPage'], toSheet: params['toSheet'], text: params['text'] }] : []
          if (raw.length === 0) return { error: 'create_links needs `links`: [{page, rect:{x0,y0,x1,y1}, toPage or toSheet}], or one link as `rect` with `toPage`/`toSheet`' }
          const sheetRows = sheetGroups.flatMap((g) => g.rows)
          const pageArg = (v: unknown, what: string): number | string => {
            if (typeof v === 'string' && !/^\d+$/.test(v.trim())) {
              const at = pageForSheet(sheetRows, v)
              return at === null ? `${what}: no single sheet is called ${v}` : at
            }
            const n = Number(v)
            return Number.isInteger(n) && n >= 0 && n < pageCount ? n : `${what}: page ${String(v)} out of range (0..${pageCount - 1})`
          }
          const docId = docIdRef.current
          const made: Array<{ id: string; page: number; toPage: number; toSheet: string }> = []
          const cmds = []
          for (const [i, item] of raw.entries()) {
            const o = objectParam(item)
            if (o == null) return { error: `links[${i}] must be an object` }
            const targetPage = o['page'] === undefined ? ap.index : pageArg(o['page'], `links[${i}].page`)
            if (typeof targetPage === 'string') return { error: targetPage }
            const to = pageArg(o['toPage'] ?? o['toSheet'], `links[${i}].toPage`)
            if (typeof to === 'string') return { error: o['toPage'] === undefined && o['toSheet'] === undefined ? `links[${i}] needs toPage or toSheet` : to }
            if (to === targetPage) return { error: `links[${i}] jumps to the sheet it is on` }
            const box = bridgeRect(o['rect'])
            if (box == null) return { error: `links[${i}].rect must be {x0,y0,x1,y1} in normalized [0,1] page coordinates` }
            const id = uid()
            const text = typeof o['text'] === 'string' && o['text'].trim() !== '' ? o['text'].trim() : undefined
            cmds.push(cmdCreate({
              id, documentId: docId, pageId: pageIdFor(docId, targetPage), scopeId: null,
              kind: 'link', rings: [boxRing(box)], origin: 'agent', reviewState: 'accepted',
              content: { toPage: to, source: text === undefined ? 'drawn' : 'callout', ...(text !== undefined ? { text } : {}) },
            }))
            made.push({ id, page: targetPage, toPage: to, toSheet: sheetLabelFor(to) })
          }
          const ok = await runCommand(cmds.length === 1 ? cmds[0]! : cmdBatch(`link ${cmds.length} callouts`, cmds))
          if (!ok) return { error: 'the links could not be written' }
          requestPaint()
          return { created: made, note: 'one undo step; saving writes them into the PDF as links Bluebeam and Acrobat follow' }
        }
        /*
         * Every reference to another sheet ("3/A5.01", "SEE A5.01"), as Link
         * detail callouts finds them, ready to pass to create_links. Nothing
         * is written. Sheets not read in time come back in `stillReading`.
         */
        case 'find_callout_links': {
          const v = viewerRef.current
          if (!v || activeDocId === null || pageCount === 0) return { error: 'no document is open' }
          const numbered = pickerSheets.filter((x) => !/^Page \d+$/.test(x.number))
          if (numbered.length < 2) return { error: 'this set has no sheet numbers to match yet; name its sheets first (redbeam_set_title_blocks or redbeam_rename_sheets)' }
          const pages = params['page'] === undefined && params['pages'] === undefined && params['fromPage'] === undefined && params['toPage'] === undefined
            ? { pages: Array.from({ length: pageCount }, (_, i) => i) }
            : agentPageList(params, ap.index)
          if ('error' in pages) return pages
          const docId = docIdRef.current
          const replyBy = performance.now() + AGENT_REPLY_MS
          const found: ReturnType<typeof findCallouts> = []
          const stillReading: number[] = []
          for (const sweepPage of pages.pages) {
            if (performance.now() > replyBy) { stillReading.push(sweepPage); continue }
            let pt: PageText | null = v.getText(sweepPage) ?? null
            if (pt === null) { try { pt = await v.requestText(sweepPage, { priority: PRIORITY_THUMBNAIL }) } catch { pt = null } }
            if (pt === null) continue
            const words = wordsOnPage(pt).map((w) => ({ text: w.text, ...w.box }))
            const pageId = pageIdFor(docId, sweepPage)
            const existing = [
              ...(v.getLinks(sweepPage) ?? []).map((l) => l.rect),
              ...docMarkupsRef.current.filter((m) => m.kind === 'link' && m.pageId === pageId).map((m) => ringBox(m.rings[0] ?? [])),
            ]
            found.push(...findCallouts(sweepPage, words, numbered, existing))
          }
          const r5 = (n: number) => Math.round(n * 1e5) / 1e5
          return {
            candidates: found.map((c) => ({
              page: c.page, sheet: sheetLabelFor(c.page), toPage: c.toPage, toSheet: sheetLabelFor(c.toPage), text: c.text,
              kind: c.kind, likely: c.checked,
              rect: { x0: r5(c.rect.x0), y0: r5(c.rect.y0), x1: r5(c.rect.x1), y1: r5(c.rect.y1) },
            })),
            note: 'callout = a detail number over a sheet number; mention = a sheet number alone. `likely` is what the review list ticks. Pass the ones to keep to redbeam_create_links.',
            ...(stillReading.length > 0 ? { stillReading, more: 'ask again with `pages` set to these' } : {}),
          }
        }
        /*
         * Turn the PDF's own markups (a Bluebeam area, polyline or count drawn
         * before REDBEAM) into takeoff in a scope: the drawing menu's "Convert
         * the PDF's markups". `names` are list_annotations' `name`s; without
         * them, every convertible markup on the sheet.
         */
        case 'convert_annotations': {
          const v = viewerRef.current
          if (!v || activeDocId === null) return { error: 'no document is open' }
          const target = ap.index
          const scopeId = typeof params['scopeId'] === 'string' ? params['scopeId'] : agentScope()
          if (scopeId !== null && !scopesRef.current.some((x) => x.id === scopeId)) return { error: `no such scope: ${scopeId}; list_scopes has them` }
          let all: PageAnnotation[] = []
          try { all = await v.requestAnnotations(target) } catch { return { error: 'could not read the markups on that sheet' } }
          // As the sheet offers them to Select: not REDBEAM's own, not ones already taken in as markups.
          const adopted = adoptedNmsRef.current.get(docIdRef.current) ?? new Set<string>()
          const held = heldNmsRef.current.get(docIdRef.current) ?? new Set<string>()
          const convertible = all.filter((a) => a.shape !== 'other' && !isRedbeamNm(a.name) && !adopted.has(a.name) && !held.has(a.name))
          const names = Array.isArray(params['names']) ? (params['names'] as unknown[]).map(String) : null
          const picked = names === null ? convertible : convertible.filter((a) => names.includes(a.name))
          const missing = names === null ? [] : names.filter((n) => !picked.some((a) => a.name === n))
          if (picked.length === 0) return { error: names === null ? 'nothing on this sheet to convert: only areas, lines and counts convert' : `none of those can be converted; list_annotations names the markups on the sheet`, ...(missing.length > 0 ? { notConvertible: missing } : {}) }
          const r = await convertAnnotations(picked, scopeId, { page: target, origin: 'agent' })
          return {
            page: target, sheet: sheetLabelFor(target), scopeId, ...r,
            ...(missing.length > 0 ? { notConvertible: missing, note: 'these are not areas, lines or counts, or are not on this sheet' } : {}),
          }
        }
        /*
         * ---- agent usability study, priority 2 ----
         */
        /* Move or reshape a markup, keeping its id. */
        case 'update_markup': {
          const id = String(params['id'] ?? '')
          const m = docMarkupsRef.current.find((x) => x.id === id)
          if (!m) return { error: `no such markup: ${id}` }
          /*
           * Recolour another app's markup held in place (a Bluebeam cloud,
           * text box, arrow): the markup menu's colour row. Takeoff markups
           * wear their scope's colour, which update_scope changes.
           */
          if (params['color'] !== undefined && m.kind !== 'note') {
            if (m.kind !== 'annot') return { error: 'only comment markups (kind note) and markups from Bluebeam or another app (kind annot) carry their own colour; a takeoff markup shows its scope\'s, which update_scope changes' }
            const hex = String(params['color']).trim().toLowerCase()
            const named = HELD_COLORS.find((c) => c.name.toLowerCase() === hex)?.hex ?? hex
            if (!/^#[0-9a-f]{6}$/.test(named)) return { error: `color must be #rrggbb or one of ${HELD_COLORS.map((c) => c.name).join(', ')}` }
            const was = heldColorOf(m)
            if (was !== named) await runCommand(cmdEditAnnotColor(id, was, named, { documentId: m.documentId, pageId: m.pageId }, 'agent'))
            if (params['rings'] === undefined && params['dx'] === undefined && params['dy'] === undefined) return { id, kind: m.kind, color: named }
          }
          /*
           * A comment markup's text and style, as its property strip changes
           * them: one undo step; a leader's text box is refitted to new text.
           */
          const NOTE_KEYS = ['text', 'color', 'width', 'fill', 'fillOpacity', 'ends', 'fontPt']
          if (m.kind === 'note' && NOTE_KEYS.some((k) => params[k] !== undefined)) {
            const before = parseNoteContent((m as { content?: unknown }).content)
            if (before === null) return { error: `${id} is not a readable note` }
            const next = noteStyle(params, before)
            if ('error' in next) return next
            if (next.text !== '' && !hasText(next.shape)) return { error: `a ${next.shape} carries no text` }
            const cmds = [cmdEditContent(m.id, before as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>, 'edit note', { documentId: m.documentId, pageId: m.pageId }, 'agent')]
            if (next.text !== before.text || next.fontPt !== before.fontPt) {
              const probe = document.createElement('canvas').getContext('2d')
              const pg = m.pageId === ap.id ? ap.size : (() => { const n = pageNumberFrom(m.pageId, m.documentId); const z = n === null ? undefined : (viewerRef.current?.getPageSize(n) ?? pageSizesRef.current[n]); return { width: z?.width ?? 0, height: z?.height ?? 0 } })()
              const refit = refitLeaderText(m.rings.map((r) => r.map((q) => ({ ...q }))), next, pg, (pt) => probe === null ? roughMeasure(pt) : canvasMeasure(probe, pt))
              if (JSON.stringify(refit) !== JSON.stringify(m.rings)) cmds.push(cmdEditGeometry(m.id, m.rings, refit, 'edit note', { documentId: m.documentId, pageId: m.pageId }, 'agent'))
            }
            await runCommand(cmds.length === 1 ? cmds[0]! : cmdBatch('edit note', cmds))
            if (params['rings'] === undefined && params['dx'] === undefined && params['dy'] === undefined) return { id, kind: 'note', content: next }
          }
          let after: Markup['rings']
          if (params['rings'] !== undefined) {
            const built = agentMarkup({ kind: m.kind, rings: params['rings'], ...(m.scopeId !== null ? { scopeId: m.scopeId } : {}) }, m.documentId, m.pageId)
            if ('error' in built) return built
            after = built.markup.rings
          } else {
            const dx = Number(params['dx'] ?? 0), dy = Number(params['dy'] ?? 0)
            if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) {
              return { error: 'update_markup needs `rings` (the new shape) or `dx`/`dy` (a move, normalized)' }
            }
            after = m.rings.map((r) => r.map((p) => ({ x: p.x + dx, y: p.y + dy })))
            if (after.some((r) => r.some((p) => p.x < -0.05 || p.x > 1.05 || p.y < -0.05 || p.y > 1.05))) return { error: 'that move takes it off the sheet' }
          }
          await runCommand(cmdEditGeometry(id, m.rings, after, params['rings'] !== undefined ? 'reshape' : 'move', { documentId: m.documentId, pageId: m.pageId }, 'agent'))
          return { id, kind: m.kind, vertices: after[0]?.length ?? 0, holes: Math.max(0, after.length - 1) }
        }
        /* Bring scopes, or the whole takeoff, in from another PDF by path. */
        case 'import_scopes': {
          const from = typeof params['path'] === 'string' ? params['path'].trim() : ''
          if (from === '') return { error: 'import_scopes needs `path`: the PDF to read scopes from' }
          const said = await (params['withMarkups'] === true ? startFromPdf(from) : importScopesFromPdf(from))
          return /^could not|carries no/.test(said) ? { error: said } : { imported: said }
        }
        /* The PDF's own markups on a sheet: notes, callouts, clouds, measurements, with author and text. */
        case 'list_annotations': {
          const v = viewerRef.current
          if (!v || activeDocId === null) return { error: 'no document is open' }
          const pages = agentPageList(params, ap.index)
          if ('error' in pages) return pages
          const out: Array<Record<string, unknown>> = []
          const r5 = (n: number) => Math.round(n * 1e5) / 1e5
          // No cap on how many sheets: the answer covers as many as are read
          // in AGENT_REPLY_MS and names the rest, which carry on being read.
          const reads = new Map(pages.pages.map((p) => [p, v.requestAnnotations(p).catch(() => [] as PageAnnotation[])] as const))
          const replyBy = performance.now() + AGENT_REPLY_MS
          const covered: number[] = []
          const stillReading: number[] = []
          for (const sweepPage of pages.pages) {
            const left = replyBy - performance.now()
            const all = left <= 0 ? undefined : await Promise.race([
              reads.get(sweepPage)!,
              new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), left)),
            ])
            if (all === undefined) { stillReading.push(sweepPage); continue }
            covered.push(sweepPage)
            /*
             * withGeometry (Coinbase blind test #7): each markup's rings in
             * the normalized frame every tool takes, Bluebeam's /Cutouts as
             * holes, and what REDBEAM measures them at on this sheet's scale,
             * so an agent can compare or copy a takeoff without parsing the PDF.
             */
            const geo = params['withGeometry'] === true
            let found: RawCutouts[] = []
            if (geo && all.some((a) => a.hasCutouts && !isRedbeamNm(a.name))) {
              const doc = documentsRef.current.find((d) => d.id === docIdRef.current)
              try {
                if (doc !== undefined) {
                  found = (await withRanged(projectBridge, projectPath, doc.relativePath, (big) => big.cutouts(sweepPage)))?.value
                    ?? await readPdfCutouts(await projectBridge.readDocument(projectPath, doc.relativePath), sweepPage)
                }
              } catch { found = [] }
            }
            const gPid = pageIdFor(docIdRef.current, sweepPage)
            const gFpp = projectCalibrations.get(gPid) ?? (sweepPage === ap.index ? ap.feetPerPoint : null)
            const gSize = sweepPage === ap.index ? ap.size : (v.getPageSize(sweepPage) ?? pageSizesRef.current[sweepPage] ?? null)
            for (const a of all) {
              if (isRedbeamNm(a.name)) continue
              let geometry: Record<string, unknown> = {}
              if (geo) {
                const kind = kindForAnnotation(a)
                const outlines = ringsForAnnotation(a)
                const holes = kind === 'area' ? cutoutsFor(a, found) : []
                const rings = kind === 'area' && outlines.length > 0 ? areaWithCutouts(outlines[0]!, holes) : outlines
                const ptsRings = gSize === null ? null : rings.map((r) => r.map((q) => ({ x: q.x * gSize.width, y: q.y * gSize.height })))
                let measured: Record<string, unknown> | null = null
                if (ptsRings !== null && gFpp !== null && gFpp > 0) {
                  if (kind === 'area') measured = { squareFeet: Math.round(regionArea(areaRegion(ptsRings)) * gFpp * gFpp * 100) / 100 }
                  else if (kind === 'polyline') {
                    let L = 0
                    for (const r of ptsRings) for (let k = 1; k < r.length; k++) L += Math.hypot(r[k]!.x - r[k - 1]!.x, r[k]!.y - r[k - 1]!.y)
                    measured = { feet: Math.round(L * gFpp * 100) / 100 }
                  }
                }
                geometry = {
                  kind, rings: rings.map((r) => r.map((q) => ({ x: r5(q.x), y: r5(q.y) }))),
                  ...(kind === 'area' ? { holes: holes.length } : {}),
                  measured: measured ?? (gFpp === null ? 'this sheet has no scale' : null),
                }
              }
              out.push({
                page: sweepPage, type: a.subtypeName, ...(a.subject !== '' ? { subject: a.subject } : {}),
                ...(a.contents !== '' ? { text: a.contents } : {}), ...(a.author !== '' ? { author: a.author } : {}),
                ...(a.name !== '' ? { name: a.name } : {}), ...(a.color !== null ? { color: a.color } : {}),
                rect: { x0: r5(a.rect.x0), y0: r5(a.rect.y0), x1: r5(a.rect.x1), y1: r5(a.rect.y1) },
                ...(a.vertices.length > 0 ? { vertices: a.vertices.length } : {}),
                ...(a.hasCutouts ? { cutouts: true } : {}),
                ...geometry,
              })
            }
          }
          return {
            annotations: out, pages: covered,
            ...(stillReading.length > 0 ? { stillReading, note: 'these sheets are still being read (it continues in the background); ask again with `pages` set to them' } : {}),
          }
        }
        /* Accept imported (pending) markups: by id, on the sheet showing, or all. */
        case 'accept_imported': {
          const ids = Array.isArray(params['ids']) ? (params['ids'] as unknown[]).map(String)
            : params['all'] === true ? [...pendingIdsRef.current]
              : docMarkupsRef.current.filter((m) => m.pageId === ap.id).map((m) => m.id)
          const n = await acceptImported(ids)
          return { accepted: n, stillPending: pendingIdsRef.current.size }
        }
        /* A sheet's links, and the PDF's bookmark tree. */
        case 'list_links': {
          const v = viewerRef.current
          if (!v) return { error: 'no document is open' }
          if (params['page'] !== undefined) await showPageForAgent(Number(params['page']))
          try { await v.requestAnnotations(ap.index) } catch { /* links ride with the annotations */ }
          return {
            page: ap.index,
            links: v.getLinks(ap.index).map((l) => ({ rect: l.rect, ...(l.page !== undefined ? { toPage: l.page, toSheet: sheetLabelFor(l.page) } : {}), ...(l.uri !== undefined ? { uri: l.uri } : {}) })),
            // REDBEAM's own (the Link tool's, create_links'), with the id that moves or deletes one.
            redbeamLinks: docMarkupsRef.current.filter((m) => m.pageId === ap.id).flatMap((m) => {
              const c = linkContentOf(m)
              return c === null ? [] : [{ id: m.id, rect: ringBox(m.rings[0] ?? []), toPage: c.toPage, toSheet: sheetLabelFor(c.toPage), ...(c.text !== undefined ? { text: c.text } : {}) }]
            }),
          }
        }
        case 'list_bookmarks': {
          type Node = { title: string; page: number | null; children: Node[] }
          let count = 0
          const walkOut = (nodes: readonly Node[], depth: number): Array<Record<string, unknown>> => nodes.flatMap((n) => {
            count++
            return [{ title: n.title, page: n.page, depth }, ...walkOut(n.children, depth + 1)]
          })
          // Every bookmark is reachable: a page of them, and `offset` for the next.
          const every = walkOut(docIndex.outline as readonly Node[], 0)
          const limit = Math.max(1, Math.min(5000, Number(params['limit'] ?? 2000) || 2000))
          const offset = Math.max(0, Math.floor(Number(params['offset'] ?? 0)) || 0)
          return {
            bookmarks: every.slice(offset, offset + limit), total: count,
            ...(count > offset + limit ? { nextOffset: offset + limit, note: 'more bookmarks follow; ask again with `offset` set to nextOffset' } : {}),
          }
        }
        /*
         * A session saying it is waiting on the person, or that it is done.
         * The window answers these (agents/router.ts): they are about the
         * session's tabs, not about this PDF. Reached only by a caller with
         * no session.
         */
        case 'wait_for_person':
        case 'end_session':
          return { error: `${action} is for an AI session; start one with redbeam_start_session` }
        case 'close_tab': {
          if (lightTabs === undefined || quickView === undefined) return { error: 'this window has no tabs' }
          const want = typeof params['path'] === 'string' && params['path'].trim() !== '' ? params['path'].trim() : quickView.file
          const slashes = (x: string) => x.replace(/\\/g, '/').toLowerCase()
          const tab = lightTabs.list.find((t) => slashes(t.file) === slashes(want) || t.name.toLowerCase() === want.toLowerCase())
          if (tab === undefined) return { error: `no open tab ${want}`, tabs: lightTabs.list.map((t) => t.file) }
          // Saved first when it is the one showing, as closing by hand does.
          if (tab.file === quickView.file && activeDocId !== null) await saveTakeoffIntoDrawing(activeDocId, { quiet: true })
          // Answered first: closing the tab showing takes this workspace, and the answer, with it.
          const close = lightTabs.onClose
          if (tab.file === quickView.file) {
            // Its takeoff is saved before it goes, which can take seconds: a second
            // close meanwhile would be told this same tab closed again.
            if (closingTabRef.current) return { error: `${tab.name} is still closing (its takeoff is being saved); ask again once get_ui_state shows another file` }
            closingTabRef.current = true
            // If the save is refused the tab stays, and may be asked to close again.
            setTimeout(() => { closingTabRef.current = false }, 15000)
          }
          setTimeout(() => close(tab.file), 60)
          return { closed: tab.file, ...(tab.file === quickView.file ? { note: 'closing now; get_ui_state shows the next file once it has' } : {}) }
        }
        case 'rotate_pages': {
          const pages = agentPageList(params, ap.index)
          if ('error' in pages) return pages
          const deg = Number(params['degrees'] ?? 90)
          const turns = (((Math.round(deg / 90) % 4) + 4) % 4) as 0 | 1 | 2 | 3
          if (turns === 0 || Math.abs(deg % 90) > 1e-9) return { error: 'degrees must be 90, 180 or 270 (clockwise), or -90' }
          await rotatePages(pages.pages, turns)
          return { rotated: pages.pages, degreesClockwise: turns * 90 }
        }
        /* A dimension between two points: an annotation, not takeoff. */
        case 'create_dimension': {
          const pts = Array.isArray(params['points']) ? (params['points'] as unknown[]).map(bridgePoint) : []
          if (pts.length !== 2 || pts[0] === null || pts[1] === null) return { error: 'create_dimension needs `points`: two {x,y}, normalized' }
          const frozen = commitDimension({ ...emptyDimensionDraft('none'), a: pts[0]!, b: pts[1]!, cursor: pts[1]! }, ap.size.width, ap.size.height)
          if (frozen === null) return { error: 'the two points are the same point' }
          const id = uid()
          await runCommand(cmdCreate({
            id, scopeId: null, documentId: docIdRef.current, pageId: ap.id,
            kind: 'dimension', rings: frozen.rings, origin: 'agent', reviewState: 'accepted',
            content: frozen.content as unknown as Record<string, unknown>,
          }))
          const fpp = ap.feetPerPoint
          const lenPts = Math.hypot((pts[1]!.x - pts[0]!.x) * ap.size.width, (pts[1]!.y - pts[0]!.y) * ap.size.height)
          return { id, lengthFeet: fpp === null ? null : Math.round(lenPts * fpp * 1000) / 1000, length: fpp === null ? null : formatFeetInches(lenPts * fpp) }
        }
        /* Copies of markups, on their own sheet or another one. */
        case 'duplicate_markups': {
          /*
           * Also a scope's areas copied to the same spot on other floors in
           * one step (NOIC report, 2026-11-26, L3, L4 and L6): `scopeId` with
           * `fromPage` picks every area and cutout of the scope on that
           * sheet, `toPages` names the floors, and `offsets` nudges a sheet
           * that does not line up exactly. Start points and directions set
           * per area go with the copies.
           */
          let ids = Array.isArray(params['ids']) ? (params['ids'] as unknown[]).map(String) : typeof params['id'] === 'string' ? [params['id']] : []
          const sheetRows = sheetGroups.flatMap((g) => g.rows)
          const pageOf = (v: unknown): number | string => {
            if (typeof v === 'string' && !/^\d+$/.test(v.trim())) {
              const at = pageForSheet(sheetRows, v)
              return at === null ? `no single sheet is called ${v}` : at
            }
            const n = Number(v)
            return Number.isInteger(n) && n >= 0 && n < pageCount ? n : `page ${String(v)} out of range (0..${pageCount - 1})`
          }
          if (ids.length === 0 && typeof params['scopeId'] === 'string') {
            const targetPage = params['fromPage'] === undefined ? ap.index : pageOf(params['fromPage'])
            if (typeof targetPage === 'string') return { error: targetPage }
            const fromId = pageIdFor(docIdRef.current, targetPage)
            ids = docMarkupsRef.current.filter((m) => m.scopeId === params['scopeId'] && m.pageId === fromId && (m.kind === 'area' || m.kind === 'cutout')).map((m) => m.id)
            if (ids.length === 0) return { error: `no areas of scope ${String(params['scopeId'])} on page ${targetPage}` }
          }
          const src = ids.map((i) => docMarkupsRef.current.find((m) => m.id === i))
          const missing = ids.filter((_, k) => src[k] === undefined)
          if (ids.length === 0 || missing.length > 0) return { error: ids.length === 0 ? 'duplicate_markups needs `ids`, or `scopeId` (with `fromPage`)' : `no such markup: ${missing.join(', ')}` }
          const asked = Array.isArray(params['toPages']) ? params['toPages'] as unknown[] : params['toPage'] !== undefined ? [params['toPage']] : []
          const targets: number[] = []
          for (const t of asked) {
            const at = pageOf(t)
            if (typeof at === 'string') return { error: at }
            targets.push(at)
          }
          const sameSheet = targets.length === 0
          const offsets = typeof params['offsets'] === 'object' && params['offsets'] !== null ? params['offsets'] as Record<string, unknown> : {}
          const shiftFor = (target: number | null): { dx: number; dy: number } => {
            const o = target === null ? undefined : offsets[String(target)] as { dx?: unknown; dy?: unknown } | undefined
            const dx = Number(o?.dx ?? params['dx'] ?? (sameSheet ? 0.01 : 0)), dy = Number(o?.dy ?? params['dy'] ?? (sameSheet ? 0.01 : 0))
            return { dx: Number.isFinite(dx) ? dx : 0, dy: Number.isFinite(dy) ? dy : 0 }
          }
          const made: Array<{ id: string; from: string; page: number | null }> = []
          const copies: Array<{ from: Markup; id: string; dx: number; dy: number }> = []
          const cmds = (sameSheet ? [null] : targets).flatMap((targetPage) => (src as Markup[]).map((m) => {
            const id = uid()
            const { dx, dy } = shiftFor(targetPage)
            const pageId = targetPage === null ? m.pageId : pageIdFor(docIdRef.current, targetPage)
            made.push({ id, from: m.id, page: pageNumberFrom(pageId, docIdRef.current) })
            copies.push({ from: m, id, dx, dy })
            const content = (m as Markup & { content?: Record<string, unknown> }).content
            return cmdCreate({
              id, documentId: m.documentId, pageId, scopeId: m.scopeId, kind: m.kind,
              rings: m.rings.map((r) => r.map((p) => ({ x: p.x + dx, y: p.y + dy }))),
              origin: 'agent', reviewState: 'accepted',
              ...(content !== undefined ? { content: structuredClone(content) } : {}),
            })
          }))
          await ensurePageRows(targets)
          await runCommand(cmds.length === 1 ? cmds[0]! : cmdBatch(`duplicate ${cmds.length} markups`, cmds))
          // The area's own start point and direction, moved with it.
          const carried: string[] = []
          for (const scId of new Set(copies.map((c) => c.from.scopeId).filter((x): x is string => x !== null))) {
            const sc = scopesRef.current.find((x) => x.id === scId)
            if (sc === undefined) continue
            const origins = { ...(sc.specifications[AREA_ORIGINS_KEY] as Record<string, { x: number; y: number }> ?? {}) }
            const dirs = { ...(sc.specifications[AREA_DIRECTIONS_KEY] as Record<string, Record<string, number>> ?? {}) }
            let changed = false
            for (const c of copies.filter((x) => x.from.scopeId === scId)) {
              const o = origins[c.from.id]
              if (o !== undefined) { origins[c.id] = { x: o.x + c.dx, y: o.y + c.dy }; changed = true; carried.push(c.id) }
              const d = dirs[c.from.id]
              if (d !== undefined) { dirs[c.id] = { ...d }; changed = true }
            }
            if (changed) await saveScope({ ...sc, specifications: { ...sc.specifications, [AREA_ORIGINS_KEY]: origins, [AREA_DIRECTIONS_KEY]: dirs } })
          }
          return { duplicated: made, ...(carried.length > 0 ? { startPointsCarried: carried.length } : {}) }
        }
        case 'select_markups': {
          const ids = Array.isArray(params['ids']) ? (params['ids'] as unknown[]).map(String) : []
          const here = ids.filter((i) => ap.markups.some((m) => m.id === i))
          const view = agentView()
          if (view !== null) {
            // Its own selection. What the person has selected stays selected.
            view.selected = here
            return { selected: here, ...(here.length < ids.length ? { notOnThisSheet: ids.filter((i) => !here.includes(i)) } : {}), note: 'selected in your own view; the person\'s selection did not change' }
          }
          setSelectedIds(here); selectedRef.current = here
          requestPaint()
          return { selected: here, ...(here.length < ids.length ? { notOnThisSheet: ids.filter((i) => !here.includes(i)) } : {}) }
        }
        /*
         * ---- round 3 (Aaron, 2026-11-24): agent takeoffs ----
         */
        case 'describe_product': {
          const t = typeof params['productType'] === 'string' ? params['productType'].trim() : ''
          const beta = prefsRef.current['beta.customPatterns'] === true
          if (t === '') {
            return {
              products: describeAllProducts(),
              ...(beta ? { customPatterns: 'On (beta): describe_product {productType:"custom_pattern"} gives the recipe format for a product of your own, with layers and hardware.' } : {}),
            }
          }
          if (canonicalProductType(t) === 'custom_pattern') {
            return {
              productType: 'custom_pattern',
              label: 'Custom pattern',
              beta: beta ? 'on' : 'off: the person turns it on in Settings › Beta › Custom patterns',
              format: PATTERN_FORMAT,
              library: readLibrary().map((e) => ({ patternId: e.id, name: e.recipe.name, version: e.version })),
              tools: 'redbeam_preview_pattern shows a recipe on the sheet without saving; redbeam_save_pattern keeps it on a scope as a draft; '
                + 'redbeam_list_patterns and redbeam_use_pattern reuse the library; redbeam_clear_pattern_preview drops a preview.',
            }
          }
          return { ...describeProduct(t) }
        }
        /*
         * ---- custom patterns (beta, Aaron 2026-11-25) ----
         *
         * An agent designs a product as a recipe, sees it on the sheet, and
         * saves it on a scope as a DRAFT. Nothing here can approve one: the
         * person does that in the scope's Setup, and until then every line it
         * produces is unverified in the BOM.
         */
        case 'preview_pattern':
        case 'save_pattern': {
          const off = patternsOff()
          if (off !== null) return off
          const id = String(params['scopeId'] ?? agentScope() ?? '')
          const sc = scopesRef.current.find((x) => x.id === id)
          if (!sc) return noScope(id)
          const raw = typeof params['recipe'] === 'string' ? ((): unknown => { try { return JSON.parse(params['recipe'] as string) } catch { return params['recipe'] } })() : params['recipe']
          const check = checkPatternRecipe(raw)
          if (!check.ok) return { error: 'the recipe does not check', errors: check.errors, warnings: check.warnings, format: 'describe_product {productType:"custom_pattern"}' }
          const by = agentCtxRef.current.agent?.name ?? agentCtxRef.current.agent?.app ?? 'an AI app'
          const recipe = asAgentDraft(check.recipe, sc, by)
          if (action === 'preview_pattern') {
            setPatternPreviews((m) => new Map(m).set(id, recipe))
            const result = await settledPieces(id, recipe)
            return {
              scopeId: id, previewing: true, saved: false, name: recipe.name,
              ...patternAnswer(result), warnings: check.warnings,
              note: 'Shown on the sheet, not saved. Check it with redbeam_screenshot; redbeam_save_pattern keeps it, redbeam_clear_pattern_preview drops it.',
            }
          }
          const label = typeof params['label'] === 'string' && params['label'].trim() !== '' ? params['label'].trim() : sc.label
          if (label !== sc.label && scopesRef.current.some((x) => x.label === label)) return { error: `a scope called "${label}" already exists` }
          await saveScope({
            ...sc, label, scopeType: 'area',
            specifications: { ...sc.specifications, productType: 'custom_pattern', [PATTERN_RECIPE_KEY]: recipe },
          })
          setPatternPreviews((m) => { if (!m.has(id)) return m; const n = new Map(m); n.delete(id); return n })
          const result = await settledPieces(id, recipe)
          return {
            scopeId: id, saved: true, name: recipe.name, status: recipe.status,
            draftLayers: recipe.status === 'draft' ? 'all' : recipe.layers.filter((l) => l.status === 'draft').map((l) => l.id),
            ...patternAnswer(result), warnings: check.warnings,
            note: 'Saved on the scope as a draft: it counts now, and its lines stay unverified until the person approves it in the scope\'s Setup.',
          }
        }
        case 'clear_pattern_preview': {
          const id = typeof params['scopeId'] === 'string' ? params['scopeId'] : null
          const had = id === null ? [...patternPreviewsRef.current.keys()] : patternPreviewsRef.current.has(id) ? [id] : []
          setPatternPreviews((m) => { if (id === null) return new Map(); const n = new Map(m); n.delete(id); return n })
          return { cleared: had }
        }
        case 'list_patterns': {
          const off = patternsOff()
          if (off !== null) return off
          return {
            library: readLibrary().map((e) => ({
              patternId: e.id, name: e.recipe.name, version: e.version, savedBy: e.savedBy, savedAt: e.savedAt,
              layers: e.recipe.layers.map((l) => ({ id: l.id, kind: l.kind, name: l.name ?? l.id })),
              ...(params['withRecipes'] === true ? { recipe: e.recipe } : {}),
            })),
            onScopes: scopesRef.current.flatMap((x): Array<Record<string, unknown>> => {
              if (readProductType(x.specifications) !== 'custom_pattern') return []
              const c = checkPatternRecipe(readPatternRecipe(x.specifications))
              if (!c.ok) return [{ scopeId: x.id, label: x.label, problem: c.errors }]
              return [{
                scopeId: x.id, label: x.label, name: c.recipe.name, status: c.recipe.status,
                draftLayers: c.resolved.layers.filter((l) => l.draft).map((l) => l.id),
                ...(c.recipe.libraryId !== undefined ? { patternId: c.recipe.libraryId, version: c.recipe.libraryVersion } : {}),
                ...(params['withRecipes'] === true ? { recipe: c.recipe } : {}),
              }]
            }),
            note: 'withRecipes:true includes each recipe. redbeam_use_pattern puts a library pattern on a scope.',
          }
        }
        case 'use_pattern': {
          const off = patternsOff()
          if (off !== null) return off
          const id = String(params['scopeId'] ?? agentScope() ?? '')
          const sc = scopesRef.current.find((x) => x.id === id)
          if (!sc) return noScope(id)
          const pid = String(params['patternId'] ?? '')
          const entry = libraryEntry(pid)
          if (entry === undefined) return { error: `no pattern "${pid}" in the library`, library: readLibrary().map((e) => ({ patternId: e.id, name: e.recipe.name })) }
          await saveScope({
            ...sc, scopeType: 'area',
            specifications: { ...sc.specifications, productType: 'custom_pattern', [PATTERN_RECIPE_KEY]: entry.recipe },
          })
          const result = await settledPieces(id, entry.recipe)
          return { scopeId: id, name: entry.recipe.name, patternId: entry.id, version: entry.version, status: entry.recipe.status, ...patternAnswer(result) }
        }
        /*
         * Where an area's pattern starts. Per area, in the same specification
         * the Origin tool writes, so the tool and an agent see one answer.
         */
        case 'set_pattern_origin': {
          const target = agentAreas(params)
          if ('error' in target) return target
          const { scope: sc, areas } = target
          const mode = String(params['mode'] ?? (params['point'] !== undefined ? 'point' : 'center'))
          const pt = bridgePoint(params['point'])
          const corner = params['corner']
          const pageBox = { width: ap.size.width, height: ap.size.height }
          const origins = { ...(sc.specifications[AREA_ORIGINS_KEY] as Record<string, unknown> ?? {}) }
          const placed: Array<{ markupId: string; origin: { x: number; y: number } | null; grid?: Record<string, unknown> }> = []
          for (const m of areas) {
            let p: { x: number; y: number } | null = null
            if (mode === 'auto') { delete origins[m.id]; placed.push({ markupId: m.id, origin: null }); continue }
            if (mode === 'grid') {
              /*
               * The nearest crossing of the grid drawn in the area (NOIC
               * report, 2026-11-26: "start this area on the nearest drawn
               * grid crossing"), to `point`, else to the corner the layout
               * starts from.
               */
              const read = await agentGridIn(m, params['angle'])
              if ('error' in read) return read
              const fromCorner = isAreaCorner(corner) ? corner
                : isAreaCorner(prefs['takeoff.patternStart']) ? prefs['takeoff.patternStart'] : 'top-left'
              const to = pt ?? areaCornerPoint(m.rings, fromCorner, pageBox)
              const hit = to === null ? null : nearestCrossing(read.grid, to, pageBox)
              if (hit === null) return { error: `no drawn grid crossing inside ${m.id}; redbeam_detect_grid shows what lines were found` }
              p = hit.point
              origins[m.id] = { x: p.x, y: p.y }
              placed.push({
                markupId: m.id, origin: { x: p.x, y: p.y },
                grid: { angle: read.grid.angle, ...read.modules, movedPoints: Math.round(hit.distancePoints * 10) / 10, crossings: read.grid.crossings.length },
              })
              continue
            }
            if (mode === 'center') {
              const r = normalizedBoundingRect(m.rings)
              p = r === null ? null : { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 }
              if (p !== null && !pointInRegion(p, m.rings)) {
                return { error: `the centre of ${m.id} is outside the area (an L-shape or a ring); give a point instead` }
              }
            } else if (mode === 'corner') {
              if (isAreaCorner(corner)) p = areaCornerPoint(m.rings, corner, pageBox)
              else if (pt !== null) p = nearestAreaVertex(m.rings, pt, pageBox)
              else return { error: 'corner mode needs `corner` (top-left, top-right, bottom-left, bottom-right) or a `point` near the corner' }
            } else if (mode === 'edge' || mode === 'line') {
              if (pt === null) return { error: `${mode} mode needs a \`point\` on or near the edge` }
              p = nearestOnBoundary(m.rings, pt, pageBox)
            } else if (mode === 'point') {
              if (pt === null) return { error: 'point mode needs `point` {x,y}, normalized' }
              // Exactly where it was put: point mode never snaps to a corner or an
              // edge (#178); corner and edge modes are for that.
              if (!pointInRegion(pt, m.rings)) return { error: `that point is outside area ${m.id}; give a point inside it, or use mode corner or edge` }
              p = { x: pt.x, y: pt.y }
            } else {
              return { error: 'mode must be point, corner, edge, center, grid or auto' }
            }
            if (p === null) return { error: `could not place an origin on ${m.id}` }
            origins[m.id] = { x: p.x, y: p.y }
            placed.push({ markupId: m.id, origin: { x: p.x, y: p.y } })
          }
          await saveScope({ ...sc, specifications: { ...sc.specifications, [AREA_ORIGINS_KEY]: origins } })
          requestPaint()
          return { scopeId: sc.id, mode, areas: placed }
        }
        /*
         * The direction the members run: for the whole scope, one sheet, or
         * one area. Area beats sheet beats scope, as the Direction tool reads
         * them.
         */
        case 'set_pattern_direction': {
          const id = String(params['scopeId'] ?? agentScope() ?? '')
          const sc = scopesRef.current.find((x) => x.id === id)
          if (!sc) return noScope(id)
          let x1 = Number(params['x1']), y1 = Number(params['y1']), x2 = Number(params['x2']), y2 = Number(params['y2'])
          const angle = params['angle']
          if (angle !== undefined) {
            // Degrees on the sheet, counter-clockwise from the page's horizontal as the drawing reads.
            const a = (Number(angle) * Math.PI) / 180
            if (!Number.isFinite(a)) return { error: 'angle must be a number of degrees' }
            const L = 0.05 * Math.min(ap.size.width, ap.size.height)
            x1 = 0.5; y1 = 0.5
            x2 = 0.5 + (Math.cos(a) * L) / ap.size.width
            y2 = 0.5 - (Math.sin(a) * L) / ap.size.height
          }
          if ([x1, y1, x2, y2].some((v) => !Number.isFinite(v))) {
            return { error: 'give x1,y1,x2,y2 (normalized) along a member, or `angle` in degrees (0 = across the sheet, 90 = up it)' }
          }
          if (x1 === x2 && y1 === y2) return { error: 'a zero-length vector is not a direction' }
          const applyTo = String(params['applyTo'] ?? 'scope')
          const vector = { sourcePage: ap.index, x1, y1, x2, y2 }
          const specs = { ...sc.specifications }
          if (applyTo === 'scope') specs['scopeDefaultDirection'] = vector
          else if (applyTo === 'page') {
            const pages = { ...(specs[PAGE_DIRECTIONS_KEY] as Record<string, unknown> ?? {}) }
            pages[ap.id] = vector
            specs[PAGE_DIRECTIONS_KEY] = pages
          } else if (applyTo === 'area') {
            const target = agentAreas({ ...params, scopeId: sc.id })
            if ('error' in target) return target
            const areasMap = { ...(specs[AREA_DIRECTIONS_KEY] as Record<string, unknown> ?? {}) }
            for (const m of target.areas) areasMap[m.id] = vector
            specs[AREA_DIRECTIONS_KEY] = areasMap
          } else return { error: 'applyTo must be scope, page or area' }
          await saveScope({ ...sc, specifications: specs })
          requestPaint()
          return { scopeId: sc.id, applyTo, direction: { x1, y1, x2, y2 } }
        }
        case 'get_pattern': {
          const id = String(params['scopeId'] ?? agentScope() ?? '')
          const sc = scopesRef.current.find((x) => x.id === id)
          if (!sc) return noScope(id)
          const specs = sc.specifications
          const dirOut = (d: ReturnType<typeof scopeDirectionOf>) => d === null ? null : { x1: d[0].x, y1: d[0].y, x2: d[1].x, y2: d[1].y }
          const pageDirs = pageDirectionsFrom(specs), areaDirs = areaDirectionsFrom(specs), origins = areaOriginsFrom(specs)
          const run = piecesRef.current.find((p) => p.scope.id === sc.id)
          const used = new Map<string, { x: number; y: number }>()
          for (const e of run?.result.runs ?? []) {
            const box = projectPageBoxes.get(e.pageId)
            if (box === undefined || box.width === 0) continue
            used.set(`${e.pageId}:${used.size}`, { x: e.layout.origin.x / box.width, y: e.layout.origin.y / box.height })
          }
          const areas = docMarkupsRef.current.filter((m) => m.scopeId === sc.id && m.kind === 'area').map((m) => {
            const ad = areaDirs.get(m.id), pd = pageDirs.get(m.pageId)
            const o = origins.get(m.id)
            return {
              markupId: m.id,
              pageId: m.pageId,
              direction: ad !== undefined ? { source: 'area', ...dirOut(ad)! } : pd !== undefined ? { source: 'page', ...dirOut(pd)! } : scopeDirectionOf(specs) !== null ? { source: 'scope', ...dirOut(scopeDirectionOf(specs))! } : null,
              origin: o !== undefined ? { source: 'placed', x: o.x, y: o.y }
                : isAreaCorner(prefsRef.current['takeoff.patternStart'] ?? 'top-left')
                  ? { source: 'corner', corner: prefsRef.current['takeoff.patternStart'] ?? 'top-left', setting: 'takeoff.patternStart' }
                  : { source: 'automatic', perAreaOrigin: prefsRef.current['takeoff.perAreaOrigin'] === true },
            }
          })
          return {
            scopeId: sc.id,
            productType: readProductType(specs),
            scopeDirection: dirOut(scopeDirectionOf(specs)),
            pageDirections: Object.fromEntries([...pageDirs].map(([k, d]) => [k, dirOut(d)])),
            areas,
            layoutOrigins: [...used.values()],
            layoutSettings: layoutSettingsAnswer(),
            note: 'direction precedence: area, then page, then scope. Start precedence: a placed start, then the patternStart corner (each area on its own), then automatic.',
          }
        }
        /*
         * The closed boundary around a point, read from the drawing's lines:
         * the same tracer as the Trace tool. Returned as rings ready for
         * create_markup, or placed as an area when `create` is true.
         */
        case 'trace_area': {
          if (params['page'] !== undefined) await showPageForAgent(Number(params['page']))
          const v = viewerRef.current
          if (!v || ap.size.width === 0) return { error: 'no page is showing' }
          const pt = bridgePoint(params['point'])
          if (pt === null) return { error: 'trace_area needs `point` {x,y}, normalized, inside the field to trace' }
          const fpp = (ap.feetPerPoint ?? undefined)
          /*
           * `sizeFeet` is roughly how wide the field is. The tracer reads a
           * square frame as a 512-cell raster, so a smaller frame is a finer
           * read: at the default 1200 points a cell is 2.3 points, too coarse
           * for a small field (a 2 ft cell came back as 5.19 sq ft).
           */
          const sizeFeet = Number(params['sizeFeet'])
          const frame = fpp !== undefined && fpp > 0 && Number.isFinite(sizeFeet) && sizeFeet > 0
            ? Math.max(60, Math.min(1200, (sizeFeet / fpp) * 3)) : 1200
          const half = frame / 2
          const clip = {
            x0: Math.max(0, pt.x - half / ap.size.width), y0: Math.max(0, pt.y - half / ap.size.height),
            x1: Math.min(1, pt.x + half / ap.size.width), y1: Math.min(1, pt.y + half / ap.size.height),
          }
          const g = await v.requestGeometry(ap.index, { clip, priority: PRIORITY_THUMBNAIL })
          const gap = Number(params['bridgeGapFeet'])
          // A gap wider than a third of the field would close the field itself.
          const gapFeet = Number.isFinite(gap) && gap > 0 ? gap
            : Number.isFinite(sizeFeet) && sizeFeet > 0 ? Math.min(3.5, sizeFeet / 6) : null
          const result = traceRegion({
            segments: g.segments, seed: pt, page: { width: ap.size.width, height: ap.size.height },
            options: {
              frameSizePoints: frame,
              ...(fpp !== undefined && fpp > 0 ? { feetPerPoint: fpp } : {}),
              ...(fpp !== undefined && fpp > 0 && gapFeet !== null ? { bridgeGapFeet: gapFeet } : {}),
            },
          })
          if (!result.ok) {
            return {
              // In the sentence, not beside it: an error reaches the app as its text alone.
              error: `no closed boundary there: ${result.message}. For a small field give sizeFeet (roughly how wide it is): gaps up to 3.5 ft are closed by default, which closes a field narrower than that. For a hatched or slatted field with no line around it, use trace_field`,
              reason: result.reason,
            }
          }
          const r5 = (n: number) => Math.round(n * 1e5) / 1e5
          // Back onto the drawing's own lines: the raster's edge is a cell or two off them.
          const onLines = params['snap'] === false ? { rings: result.region, moved: 0 }
            : snapToLinework(result.region, g.segments, { width: ap.size.width, height: ap.size.height }, Math.max(3, (frame / 512) * 2.5))
          const rings = onLines.rings.map((ring) => ring.map((p) => ({ x: r5(p.x), y: r5(p.y) })))
          const areaPts = onLines.moved > 0 ? ringsAreaPoints(onLines.rings, { width: ap.size.width, height: ap.size.height }) : result.areaPoints2
          const areaSqFt = fpp !== undefined && fpp > 0 ? Math.round(areaPts * fpp * fpp * 100) / 100 : null
          if (params['create'] === true) {
            const scopeId = typeof params['scopeId'] === 'string' ? params['scopeId'] : agentScope()
            const id = uid()
            await runCommand(cmdCreate({
              id, documentId: docIdRef.current, pageId: ap.id,
              scopeId, kind: 'area', rings, origin: 'agent', reviewState: 'accepted', content: { source: 'trace' },
            }))
            return { id, rings, areaSquareFeet: areaSqFt, holes: rings.length - 1 }
          }
          return { rings, areaSquareFeet: areaSqFt, holes: rings.length - 1, note: 'pass these rings to create_markup, or call again with create:true' }
        }
        /*
         * A hatched or patterned field (a slat, baffle or wood ceiling)
         * traced from the pattern itself, where trace_area finds no line
         * around it: the pattern's strokes on a grid turned to them, checked
         * against the sheet as rendered. packages/domain fieldTrace.ts says
         * how. The whole sheet is read unless `rect` narrows it; a sheet with
         * more geometry than one read holds is read in quarters, to the end.
         */
        case 'trace_field': {
          if (params['page'] !== undefined) await showPageForAgent(Number(params['page']))
          const v = viewerRef.current
          if (!v || ap.size.width === 0) return { error: 'no page is showing' }
          const pt = bridgePoint(params['point'])
          if (pt === null) return { error: 'trace_field needs `point` {x,y}, normalized, inside the hatched field' }
          const rect = bridgeRect(params['rect'])
          if (rect === null) return { error: '`rect` must be {x0,y0,x1,y1}, normalized [0,1]' }
          const frame = rect === undefined ? { x0: 0, y0: 0, x1: 1, y1: 1 } : {
            x0: Math.max(0, Math.min(rect.x0, rect.x1)), y0: Math.max(0, Math.min(rect.y0, rect.y1)),
            x1: Math.min(1, Math.max(rect.x0, rect.x1)), y1: Math.min(1, Math.max(rect.y0, rect.y1)),
          }
          if (!(pt.x >= frame.x0 && pt.x <= frame.x1 && pt.y >= frame.y0 && pt.y <= frame.y1)) return { error: '`point` is outside `rect`' }
          const pageIdx = ap.index
          const here = ap.id
          const region = (projectRegions.get(here) ?? []).find((r) => pointInRegion(pt, [[
            { x: Math.min(r.rect.x0, r.rect.x1), y: Math.min(r.rect.y0, r.rect.y1) }, { x: Math.max(r.rect.x0, r.rect.x1), y: Math.min(r.rect.y0, r.rect.y1) },
            { x: Math.max(r.rect.x0, r.rect.x1), y: Math.max(r.rect.y0, r.rect.y1) }, { x: Math.min(r.rect.x0, r.rect.x1), y: Math.max(r.rect.y0, r.rect.y1) },
          ]]))
          const fpp = region?.feetPerPoint ?? ap.feetPerPoint
          const pageSize = { width: ap.size.width, height: ap.size.height }
          // Every segment in a box: a read that fills up is split in four, to the end.
          let readsCut = false
          const readAll = async (clip: FieldFrame, depth: number): Promise<Float32Array[]> => {
            const g = await v.requestGeometry(pageIdx, { clip, priority: PRIORITY_THUMBNAIL, maxSegments: 1_000_000 })
            if (!g.truncated) return [g.segments]
            if (depth >= 6) { readsCut = true; return [g.segments] }
            const mx = (clip.x0 + clip.x1) / 2, my = (clip.y0 + clip.y1) / 2
            const parts = await Promise.all([
              { x0: clip.x0, y0: clip.y0, x1: mx, y1: my }, { x0: mx, y0: clip.y0, x1: clip.x1, y1: my },
              { x0: clip.x0, y0: my, x1: mx, y1: clip.y1 }, { x0: mx, y0: my, x1: clip.x1, y1: clip.y1 },
            ].map((q) => readAll(q, depth + 1)))
            return parts.flat()
          }
          /*
           * One read of the sheet serves every box inside it: this call's
           * later passes (a field traced again in its own box) and the next
           * calls on the same sheet. Going back to PDFium for each was more
           * than half of a trace on a dense sheet (Heineken, 2026-11-27:
           * 5.7 s of 10 s over nine passes). Kept only for a read that came
           * back whole in one piece, and only while the sheet is the same
           * sheet, turned the same way, in the same viewer.
           */
          const turned = pageRotationsRef.current.get(docIdRef.current)?.get(pageIdx) ?? 0
          const sameSheet = (c: NonNullable<typeof fieldGeometryRef.current>) =>
            c.viewer === v && c.doc === docIdRef.current && c.page === pageIdx && c.turned === turned && c.width === pageSize.width && c.height === pageSize.height
          const readBox = async (box: FieldFrame): Promise<Float32Array[]> => {
            const held = fieldGeometryRef.current
            if (held !== null && sameSheet(held) && held.clip.x0 <= box.x0 && held.clip.y0 <= box.y0 && held.clip.x1 >= box.x1 && held.clip.y1 >= box.y1) {
              return [segmentsInClip(held.segments, box)]
            }
            const g = await v.requestGeometry(pageIdx, { clip: box, priority: PRIORITY_THUMBNAIL, maxSegments: 1_000_000 })
            if (g.truncated) return readAll(box, 0)
            const area = (f: FieldFrame) => (f.x1 - f.x0) * (f.y1 - f.y0)
            const now = fieldGeometryRef.current
            if (now === null || !sameSheet(now) || area(box) >= area(now.clip)) {
              fieldGeometryRef.current = { viewer: v, doc: docIdRef.current, page: pageIdx, turned, width: pageSize.width, height: pageSize.height, clip: box, segments: g.segments }
            }
            return [g.segments]
          }
          const num = (k: string): number | undefined => {
            const n = Number(params[k])
            return params[k] !== undefined && Number.isFinite(n) && n >= 0 ? n : undefined
          }
          const ptsOf = (feet: number | undefined): number | undefined => (feet === undefined || fpp === null || fpp <= 0 ? undefined : feet / fpp)
          const bridge = ptsOf(num('bridgeGapFeet'))
          const minWidth = ptsOf(num('minWidthFeet') ?? 1.25)
          const minCut = num('minCutoutSqFt') ?? 1.5
          const minField = num('minFieldSqFt')
          const edgeAt = params['edge'] === 'hatch' ? 'hatch' as const : 'wall' as const
          const fitEdges = params['fitEdges'] !== false
          /*
           * The finest cell, on a lattice fixed to the page (Coinbase blind
           * test #3): a box that holds the field at this cell traces it the
           * same whatever else is in the box. A box too big for it is read
           * coarse first and each field then traced again on its own.
           */
          const FINE = 0.75, MAX_CELLS = 8_000_000
          const snap = (f: FieldFrame, c: number): FieldFrame => {
            const W = pageSize.width, H = pageSize.height
            return {
              x0: Math.max(0, Math.floor((f.x0 * W) / c) * c / W), y0: Math.max(0, Math.floor((f.y0 * H) / c) * c / H),
              x1: Math.min(1, Math.ceil((f.x1 * W) / c) * c / W), y1: Math.min(1, Math.ceil((f.y1 * H) / c) * c / H),
            }
          }
          /** Cells a frame needs at the fine cell, the grid turned the worst way. */
          const cellsAtFine = (f: FieldFrame) => {
            const fw = (f.x1 - f.x0) * pageSize.width, fh = (f.y1 - f.y0) * pageSize.height
            return ((fw + fh) * 0.7072) ** 2 / (FINE * FINE)
          }
          // Where the call's time went, so a slow trace on a real sheet says which part was slow.
          const spent = { readMs: 0, renderMs: 0, traceMs: 0, passes: 0 }
          const traceIn = async (box: FieldFrame, seed: { x: number; y: number }, extra: { all?: boolean; angleDeg?: number; cellPoints?: number }) => {
            const T0 = performance.now()
            const chunks = await readBox(box)
            const T1 = performance.now()
            const segments = new Float32Array(chunks.reduce((n, c) => n + c.length, 0))
            let at = 0
            for (const c of chunks) { segments.set(c, at); at += c.length }
            // The sheet as PDFium draws it, without anyone's markups, a pixel a grid cell.
            const fwPts = (box.x1 - box.x0) * pageSize.width, fhPts = (box.y1 - box.y0) * pageSize.height
            const cellGuess = extra.cellPoints ?? Math.max(FINE, Math.sqrt((fwPts * fhPts * 1.5) / 8_000_000))
            let image: { data: Uint8Array; width: number; height: number; channels: 1 } | undefined
            if (params['visual'] !== false) {
              try {
                const out = await v.renderRegion(box, Math.max(64, Math.round(fwPts / cellGuess)), { annots: false, overlay: false })
                const px = out.canvas.getContext('2d')?.getImageData(0, 0, out.width, out.height)
                if (px !== undefined) {
                  const grey = new Uint8Array(out.width * out.height)
                  for (let i = 0, j = 0; i < grey.length; i++, j += 4) grey[i] = (px.data[j]! * 299 + px.data[j + 1]! * 587 + px.data[j + 2]! * 114) / 1000
                  image = { data: grey, width: out.width, height: out.height, channels: 1 }
                }
              } catch { image = undefined }
            }
            const angle = extra.angleDeg ?? num('angle')
            const T2 = performance.now()
            const TR = await traceFieldInWorker({
              segments, page: pageSize, seed, frame: box,
              options: {
                ...(angle !== undefined ? { angleDeg: angle } : {}),
                ...(extra.cellPoints !== undefined ? { cellPoints: extra.cellPoints } : {}),
                ...(ptsOf(num('strokeSpacingFeet')) !== undefined ? { strokeSpacingPoints: ptsOf(num('strokeSpacingFeet'))! } : {}),
                ...(bridge !== undefined ? { bridgePoints: bridge } : {}),
                ...(minWidth !== undefined ? { minWidthPoints: minWidth } : {}),
                ...(fpp !== null && fpp > 0 ? { minCutoutPoints2: minCut / (fpp * fpp) } : {}),
                ...(fpp !== null && fpp > 0 && minField !== undefined ? { minFieldPoints2: minField / (fpp * fpp) } : {}),
                all: extra.all === true,
                edge: edgeAt,
                fitEdges,
                maxCells: MAX_CELLS,
                ...(image !== undefined ? { image } : {}),
              },
            })
            spent.readMs += T1 - T0; spent.renderMs += T2 - T1; spent.traceMs += performance.now() - T2; spent.passes++
            return TR
          }
          const fine = cellsAtFine(frame) <= MAX_CELLS
          const searched = fine ? snap(frame, FINE) : frame
          let result = await traceIn(searched, pt, { all: params['all'] === true, ...(fine ? { cellPoints: FINE } : {}) })
          if (result.ok && !fine) {
            // Each field again in a box of its own at the fine cell, from a point inside it.
            const pad = Math.max(40, 6 * (minWidth ?? 10))
            const angle = result.diagnostics.angleDeg ?? undefined
            const again: typeof result.fields = []
            for (const f of result.fields) {
              const xs = f.rings[0]!.map((q) => q.x), ys = f.rings[0]!.map((q) => q.y)
              const box = snap({
                x0: Math.max(frame.x0, Math.min(...xs) - pad / pageSize.width), y0: Math.max(frame.y0, Math.min(...ys) - pad / pageSize.height),
                x1: Math.min(frame.x1, Math.max(...xs) + pad / pageSize.width), y1: Math.min(frame.y1, Math.max(...ys) + pad / pageSize.height),
              }, FINE)
              const seed = f.seed ? pt : f.inside
              const one = cellsAtFine(box) <= MAX_CELLS
                ? await traceIn(box, seed, { ...(angle !== undefined ? { angleDeg: angle } : {}), cellPoints: FINE })
                : null
              const hit = one !== null && one.ok ? one.fields.find((x) => x.seed) : undefined
              again.push(hit !== undefined ? { ...hit, seed: f.seed } : f)
            }
            result = { ...result, fields: again }
          }
          if (!result.ok) return { error: `no hatched field there: ${result.message}`, reason: result.reason }
          const r5 = (n: number) => Math.round(n * 1e5) / 1e5
          const sqft = (pts2: number) => (fpp !== null && fpp > 0 ? Math.round(pts2 * fpp * fpp * 100) / 100 : null)
          const fields = result.fields.map((f) => {
            const rings = f.rings.map((ring) => ring.map((q) => ({ x: r5(q.x), y: r5(q.y) })))
            const xs = rings[0]!.map((q) => q.x), ys = rings[0]!.map((q) => q.y)
            const mx = 0.1 * (Math.max(...xs) - Math.min(...xs)) + 0.005, my = 0.1 * (Math.max(...ys) - Math.min(...ys)) + 0.005
            const warnings = outlineWarnings(rings).map((i) => i.message)
            const hidden = f.cutouts.filter((c) => c.hidden === true)
            if (hidden.length > 0) warnings.push(`${hidden.length} patch${hidden.length === 1 ? ' is' : 'es are'} drawn over in white on the sheet (the strokes are there, the sheet shows something else) and cut out; look before you trust them`)
            if (rect !== undefined && rings[0]!.some((q) => Math.abs(q.x - frame.x0) < 1e-3 || Math.abs(q.x - frame.x1) < 1e-3 || Math.abs(q.y - frame.y0) < 1e-3 || Math.abs(q.y - frame.y1) < 1e-3)) {
              warnings.push('the field runs to the edge of `rect`: it may go on past it; search a bigger box')
            }
            return {
              seed: f.seed, rings, areaSquareFeet: sqft(f.areaPoints2), holes: rings.length - 1,
              cutouts: f.cutouts.map((c) => ({ areaSquareFeet: sqft(c.areaPoints2), center: { x: r5(c.center.x), y: r5(c.center.y) }, ...(c.hidden === true ? { paintedOver: true } : {}) })),
              smallHolesFilled: f.filledHoles,
              lookAt: { x0: r5(Math.max(0, Math.min(...xs) - mx)), y0: r5(Math.max(0, Math.min(...ys) - my)), x1: r5(Math.min(1, Math.max(...xs) + mx)), y1: r5(Math.min(1, Math.max(...ys) + my)) },
              ...(f.visual !== undefined ? { onTheSheet: f.visual } : {}),
              ...(warnings.length > 0 ? { warnings } : {}),
            }
          })
          const d = result.diagnostics
          const summary = {
            page: pageIdx, sheet: sheetLabelFor(pageIdx),
            pattern: {
              angle: d.angleDeg, from: d.source, strokes: d.patternSegments, segmentsRead: d.segments,
              strokeGapFeet: fpp !== null && fpp > 0 ? Math.round(d.strokeGapPoints * fpp * 1000) / 1000 : null,
              strokeGapPoints: d.strokeGapPoints,
              ...(d.alternatives !== undefined ? {
                alternatives: d.alternatives.map((a) => ({
                  angle: a.angleDeg, strokeGapPoints: a.strokeGapPoints,
                  strokeGapFeet: a.strokeGapPoints !== null && fpp !== null && fpp > 0 ? Math.round(a.strokeGapPoints * fpp * 1000) / 1000 : null,
                  solidAtPoint: a.coversPoint, chosen: a.chosen,
                })),
                ifWrong: 'if the outline followed the wrong linework, call again with `angle` set to the hatch\'s direction from alternatives, or with strokeSpacingFeet',
              } : {}),
            },
            edge: edgeAt,
            ...(d.hatch !== undefined ? { hatch: { spacingPoints: d.hatch.periodPoints, spacingFeet: fpp !== null && fpp > 0 ? Math.round(d.hatch.periodPoints * fpp * 1000) / 1000 : null, strokesKept: d.hatch.members, strokesRead: d.hatch.strokes } } : {}),
            ...(edgeAt === 'hatch' && d.hatch === undefined ? { hatchNote: 'could not read the hatch spacing here, so the field ends at the wall line; pass strokeSpacingFeet (the member spacing)' } : {}),
            ...(d.fittedCorners !== undefined ? { cornersFittedToLines: d.fittedCorners } : {}),
            totalSquareFeet: fpp !== null && fpp > 0 ? Math.round(fields.reduce((n, f) => n + (f.areaSquareFeet ?? 0), 0) * 100) / 100 : null,
            timing: { readMs: Math.round(spent.readMs), renderMs: Math.round(spent.renderMs), traceMs: Math.round(spent.traceMs), passes: spent.passes },
            ...(readsCut ? { note: 'the sheet holds more geometry than could be read; trace with a smaller `rect`' } : {}),
            ...(fpp === null ? { scale: 'the sheet has no scale, so areas are null; set_page_scale first' } : {}),
          }
          if (params['create'] === true) {
            const scopeId = typeof params['scopeId'] === 'string' ? params['scopeId'] : agentScope()
            const ids = fields.map(() => uid())
            const cmds = fields.map((f, i) => cmdCreate({
              id: ids[i]!, documentId: docIdRef.current, pageId: here,
              scopeId, kind: 'area', rings: f.rings, origin: 'agent', reviewState: 'accepted', content: { source: 'trace-field' },
            }))
            await runCommand(cmds.length === 1 ? cmds[0]! : cmdBatch(`trace ${cmds.length} fields`, cmds))
            return { ...summary, fields: fields.map((f, i) => ({ id: ids[i], ...f })), note: 'placed as areas; look at each `lookAt` with redbeam_screenshot (overlay on) to check the edges' }
          }
          return { ...summary, fields, note: 'pass a field’s rings to create_markup, or call again with create:true. Look at `lookAt` with redbeam_screenshot to check the edges' }
        }
        /*
         * A drawn panel or tile grid (NOIC report, 2026-11-26): its module,
         * rows, columns and first crossing, from single or double lines, in
         * an area or a box.
         */
        case 'detect_grid': {
          if (params['page'] !== undefined) await showPageForAgent(Number(params['page']))
          const v = viewerRef.current
          if (!v || ap.size.width === 0) return { error: 'no page is showing' }
          let area: Markup | undefined
          if (typeof params['markupId'] === 'string') {
            area = docMarkupsRef.current.find((m) => m.id === params['markupId'])
            if (area === undefined || area.kind !== 'area') return { error: `no area ${String(params['markupId'])}` }
          }
          const rect = bridgeRect(params['rect'])
          if (area === undefined && (rect === undefined || rect === null)) return { error: 'detect_grid needs `markupId` (an area) or `rect` {x0,y0,x1,y1} around the grid' }
          const read = area !== undefined ? await agentGridIn(area, params['angle']) : await agentGridIn(rect!, params['angle'])
          if ('error' in read) return read
          const g = read.grid
          const limit = Math.max(0, Math.min(5000, Number(params['limit'] ?? 0) || 0))
          const first = [...g.crossings].sort((a, b) => a.y - b.y || a.x - b.x)[0]
          return {
            page: ap.index,
            angle: g.angle,
            ...read.modules,
            // Lines of the first family run at `angle`; so there are as many rows across them as lines less one.
            linesAtAngle: g.linesA.length, linesAcross: g.linesB.length,
            rows: Math.max(0, g.linesA.length - 1), columns: Math.max(0, g.linesB.length - 1),
            doubleLines: g.doubleLines,
            ...(g.bandWidth !== null ? { bandWidthPoints: g.bandWidth, bandWidthInches: read.fpp === null ? null : Math.round(g.bandWidth * read.fpp * 12 * 100) / 100 } : {}),
            crossingCount: g.crossings.length,
            start: first ?? null,
            ...(limit > 0 ? { crossings: g.crossings.slice(0, limit) } : {}),
            note: 'set_pattern_origin with mode "grid" starts an area on the crossing nearest a point; set_pattern_direction with `angle` lines the layout up with it',
          }
        }
        /*
         * Lay out by direction (NOIC report, 2026-11-26): the regions of an
         * area whose members run one way, as polygons with their angles, so
         * an agent can draw one area per region and set its direction.
         */
        case 'detect_directions': {
          if (params['page'] !== undefined) await showPageForAgent(Number(params['page']))
          const v = viewerRef.current
          if (!v || ap.size.width === 0) return { error: 'no page is showing' }
          let area: Markup | undefined
          if (typeof params['markupId'] === 'string') {
            area = docMarkupsRef.current.find((m) => m.id === params['markupId'])
            if (area === undefined || area.kind !== 'area') return { error: `no area ${String(params['markupId'])}` }
            if (area.pageId !== ap.id) return { error: `area ${area.id} is on another sheet; pass its page` }
          }
          const rect = bridgeRect(params['rect'])
          if (area === undefined && (rect === undefined || rect === null)) return { error: 'detect_directions needs `markupId` (an area) or `rect` {x0,y0,x1,y1} around the field' }
          const r = area !== undefined ? normalizedBoundingRect(area.rings) : { left: Math.min(rect!.x0, rect!.x1), right: Math.max(rect!.x0, rect!.x1), top: Math.min(rect!.y0, rect!.y1), bottom: Math.max(rect!.y0, rect!.y1) }
          if (r === null) return { error: 'that area has no outline' }
          const clip = { x0: Math.max(0, r.left - 0.002), y0: Math.max(0, r.top - 0.002), x1: Math.min(1, r.right + 0.002), y1: Math.min(1, r.bottom + 0.002) }
          const geo = await v.requestGeometry(ap.index, { clip, priority: PRIORITY_THUMBNAIL, maxSegments: 400_000 })
          const cellPoints = Number(params['cellPoints'])
          const found = directionRegions(geo.segments, ap.size, {
            ...(area !== undefined ? { rings: area.rings } : { box: { x0: r.left, y0: r.top, x1: r.right, y1: r.bottom } }),
            ...(Number.isFinite(cellPoints) && cellPoints > 0 ? { cellPoints } : {}),
          })
          if (found === null) return { error: 'no members are drawn there' }
          return {
            page: ap.index,
            directions: found.directions,
            regions: found.regions,
            cellPoints: found.cellPoints,
            ...(geo.truncated ? { warning: 'more geometry than was read; use a smaller area' } : {}),
            note: 'draw each polygon with create_markup {kind:"area", rings} in the scope, then set_pattern_direction {applyTo:"area", markupId, angle}. Region edges follow cells of `cellPoints`; pass a smaller cellPoints for a finer edge',
          }
        }
        /*
         * Hatch-to-legend (NOIC report, 2026-11-26): which legend mark a
         * hatch belongs to. The hatch is read in an area or a box on the
         * sheet showing; the legend is a box (rows read from its words) or
         * swatches the agent names, on this sheet or another.
         */
        case 'match_hatch': {
          if (params['page'] !== undefined) await showPageForAgent(Number(params['page']))
          const v = viewerRef.current
          if (!v || ap.size.width === 0) return { error: 'no page is showing' }
          let area: Markup | undefined
          if (typeof params['markupId'] === 'string') {
            area = docMarkupsRef.current.find((m) => m.id === params['markupId'])
            if (area === undefined || area.kind !== 'area') return { error: `no area ${String(params['markupId'])}` }
            if (area.pageId !== ap.id) return { error: `area ${area.id} is on another sheet; pass its page` }
          }
          const rect = bridgeRect(params['rect'])
          if (area === undefined && (rect === undefined || rect === null)) return { error: 'match_hatch needs the hatch: `markupId` (an area) or `rect` around a patch of it' }
          const bb = area !== undefined ? normalizedBoundingRect(area.rings) : { left: Math.min(rect!.x0, rect!.x1), right: Math.max(rect!.x0, rect!.x1), top: Math.min(rect!.y0, rect!.y1), bottom: Math.max(rect!.y0, rect!.y1) }
          if (bb === null) return { error: 'that area has no outline' }
          const hatchGeo = await v.requestGeometry(ap.index, { clip: { x0: bb.left, y0: bb.top, x1: bb.right, y1: bb.bottom }, priority: PRIORITY_THUMBNAIL, maxSegments: 400_000 })
          const sample = hatchSignature(hatchGeo.segments, ap.size, area !== undefined ? { rings: area.rings } : { box: { x0: bb.left, y0: bb.top, x1: bb.right, y1: bb.bottom } })
          if (sample === null) return { error: 'no hatch is drawn there' }
          // The legend's sheet: legendPage (a page number or sheet code), else this one.
          let lp = ap.index
          const lg = params['legendPage']
          if (lg !== undefined && lg !== null && lg !== '') {
            const at = typeof lg === 'string' && !/^\d+$/.test(lg.trim()) ? pageForSheet(sheetGroups.flatMap((g) => g.rows), lg) : Number(lg)
            if (at === null || !Number.isInteger(at) || at < 0 || at >= pageCount) return { error: `no sheet ${String(lg)}; redbeam_list_sheets has every sheet` }
            lp = at
          }
          const lsize = lp === ap.index ? ap.size : (v.getPageSize(lp) ?? pageSizesRef.current[lp] ?? null)
          if (lsize === null || lsize.width === 0) return { error: `sheet ${lp} has no size yet; show it once with redbeam_go_to_page` }
          let rows: Array<{ label: string; swatch: { x0: number; y0: number; x1: number; y1: number } }> = []
          if (Array.isArray(params['swatches'])) {
            for (const sw of params['swatches'] as unknown[]) {
              const o = sw as { rect?: unknown; label?: unknown }
              const r = bridgeRect(o?.rect)
              if (r === undefined || r === null) return { error: 'each swatch needs `rect` {x0,y0,x1,y1} and a `label`' }
              rows.push({ label: String(o.label ?? ''), swatch: r })
            }
          } else {
            const legend = bridgeRect(params['legendRect'])
            if (legend === undefined || legend === null) return { error: 'give the legend: `legendRect` around it (rows are read from its words), or `swatches` [{rect,label}]' }
            const pool = textPoolRef.current
            const pt = v.getText(lp) ?? (pool !== null ? await pool.text(lp) : null) ?? await v.requestText(lp, { priority: PRIORITY_THUMBNAIL })
            rows = legendRows(wordsOnPage(pt, legend), legend)
            if (rows.length === 0) return { error: 'no legend text in legendRect; pass `swatches` [{rect,label}] instead' }
          }
          const all = rows.reduce((u, r) => ({ x0: Math.min(u.x0, r.swatch.x0, r.swatch.x1), y0: Math.min(u.y0, r.swatch.y0, r.swatch.y1), x1: Math.max(u.x1, r.swatch.x0, r.swatch.x1), y1: Math.max(u.y1, r.swatch.y0, r.swatch.y1) }), { x0: 1, y0: 1, x1: 0, y1: 0 })
          const legendGeo = await v.requestGeometry(lp, { clip: all, priority: PRIORITY_THUMBNAIL, maxSegments: 400_000 })
          const ranked = rows.map((r) => {
            const sig = hatchSignature(legendGeo.segments, lsize, { box: r.swatch })
            if (sig === null) return { label: r.label, swatch: r.swatch, score: 0, why: ['nothing drawn in the swatch'] }
            const c = compareHatches(sample, sig)
            return { label: r.label, swatch: r.swatch, score: c.score, why: c.why, signature: sig }
          }).sort((a, b) => b.score - a.score)
          const best = ranked[0]
          return {
            page: ap.index,
            hatch: sample,
            match: best !== undefined && best.score >= 0.6 ? { label: best.label, score: best.score } : null,
            candidates: ranked.slice(0, 8),
            note: 'score 1 is the same hatch; under 0.6 is no match. A swatch read from legendRect runs from the box\'s left edge to its text; pass `swatches` when the legend is laid out differently',
          }
        }
        case 'detect_pattern': {
          if (params['page'] !== undefined) await showPageForAgent(Number(params['page']))
          const v = viewerRef.current
          if (!v || ap.size.width === 0) return { error: 'no page is showing' }
          const rect = bridgeRect(params['rect'])
          if (rect === undefined || rect === null) return { error: 'detect_pattern needs `rect` {x0,y0,x1,y1} around several members' }
          const clip = { x0: Math.min(rect.x0, rect.x1), y0: Math.min(rect.y0, rect.y1), x1: Math.max(rect.x0, rect.x1), y1: Math.max(rect.y0, rect.y1) }
          const g = await v.requestGeometry(ap.index, { clip, priority: PRIORITY_THUMBNAIL, maxSegments: 200_000 })
          const here = ap.id
          const centre = [[{ x: (clip.x0 + clip.x1) / 2, y: (clip.y0 + clip.y1) / 2 }]]
          const region = (projectRegions.get(here) ?? []).find((r) => pointInRegion(centre[0]![0]!, [[
            { x: Math.min(r.rect.x0, r.rect.x1), y: Math.min(r.rect.y0, r.rect.y1) }, { x: Math.max(r.rect.x0, r.rect.x1), y: Math.min(r.rect.y0, r.rect.y1) },
            { x: Math.max(r.rect.x0, r.rect.x1), y: Math.max(r.rect.y0, r.rect.y1) }, { x: Math.min(r.rect.x0, r.rect.x1), y: Math.max(r.rect.y0, r.rect.y1) },
          ]]))
          const r = detectPattern(g.segments, ap.size, {
            feetPerPoint: region?.feetPerPoint ?? ap.feetPerPoint,
            inside: clip,
            ...(Number.isFinite(Number(params['minLengthPoints'])) ? { minLengthPoints: Number(params['minLengthPoints']) } : {}),
          })
          return { page: ap.index, ...r }
        }
        /*
         * The scales the sheet states, with where each is printed, and the
         * scale set on it. With `points` and `dimension`, also a check of the
         * set scale against a written dimension.
         */
        case 'read_scale': {
          const v = viewerRef.current
          if (!v || activeDocId === null) return { error: 'no document is open' }
          const pages = agentPageList(params, ap.index)
          if ('error' in pages) return pages
          const out: Array<Record<string, unknown>> = []
          // Every sheet is read, to the end, in the background; this answer
          // waits AGENT_REPLY_MS for them and names the ones still to come.
          const reads = new Map(pages.pages.map((p) => [p, v.requestText(p, { priority: PRIORITY_THUMBNAIL }).catch(() => null)] as const))
          const replyBy = performance.now() + AGENT_REPLY_MS
          const stillReading: number[] = []
          for (const p of pages.pages) {
            const sweepPage = p
            const left = replyBy - performance.now()
            const pt = v.getText(p) ?? (left <= 0 ? undefined : await Promise.race([
              reads.get(p)!,
              new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), left)),
            ]))
            if (pt === undefined) { stillReading.push(p); continue }
            if (pt === null) { out.push({ page: p, error: 'this sheet could not be read' }); continue }
            const stated = statedScales({ text: pt.text, runs: pt.runs })
            const pid = pageIdFor(docIdRef.current, sweepPage)
            const set = projectCalibrations.get(pid) ?? null
            const regions = (projectRegions.get(pid) ?? []).map((r) => ({ id: r.id, label: r.label, feetPerPoint: r.feetPerPoint, rect: r.rect }))
            const agrees = set === null || stated.scales.length === 0 ? null
              : stated.scales.some((s) => Math.abs(s.feetPerPoint / set - 1) < 0.005)
            out.push({
              page: p,
              sheet: sheetLabelFor(p),
              set: set === null ? null : { feetPerPoint: set, label: scaleLabel(set) },
              stated: stated.scales,
              ...(stated.notes.length > 0 ? { notes: stated.notes } : {}),
              ...(regions.length > 0 ? { regions } : {}),
              ...(agrees !== null ? { setMatchesAStatedScale: agrees } : {}),
            })
          }
          const pts = Array.isArray(params['points']) ? (params['points'] as unknown[]).map(bridgePoint) : []
          const dim = typeof params['dimension'] === 'string' ? params['dimension'] : null
          if (dim !== null) {
            if (pts.length !== 2 || pts.some((p) => p === null)) return { error: 'a dimension check needs `points`: the two ends the written dimension spans, normalized', sheets: out }
            // The check is on the sheet asked for, not the one showing (Coinbase blind test #12).
            if (pages.pages.length !== 1) return { error: 'a dimension check is on one sheet: give `page` (or one entry in `pages`)', sheets: out }
            const targetPage = pages.pages[0]!
            const here = pageIdFor(docIdRef.current, targetPage)
            const size = targetPage === ap.index ? ap.size : (v.getPageSize(targetPage) ?? pageSizesRef.current[targetPage] ?? null)
            if (size === null || size.width === 0) return { error: `sheet ${targetPage} has no size yet; show it once with redbeam_go_to_page`, sheets: out }
            const regs = projectRegions.get(here) ?? []
            const mid = { x: (pts[0]!.x + pts[1]!.x) / 2, y: (pts[0]!.y + pts[1]!.y) / 2 }
            const reg = regs.find((r) => mid.x >= Math.min(r.rect.x0, r.rect.x1) && mid.x <= Math.max(r.rect.x0, r.rect.x1) && mid.y >= Math.min(r.rect.y0, r.rect.y1) && mid.y <= Math.max(r.rect.y0, r.rect.y1))
            const checked = reg?.feetPerPoint ?? (targetPage === ap.index ? ap.feetPerPoint : projectCalibrations.get(here) ?? null)
            return { sheets: out, check: { page: targetPage, sheet: sheetLabelFor(targetPage), ...(reg !== undefined ? { region: reg.id } : {}), ...checkScale(pts[0]!, pts[1]!, dim, { width: size.width, height: size.height }, checked) } }
          }
          return {
            sheets: out,
            ...(stillReading.length > 0 ? { stillReading, note: 'these sheets are still being read (it continues in the background); ask again with `pages` set to them' } : {}),
          }
        }
        /*
         * Addenda (round 3 #9): which sheets of this set are replaced by a
         * later issue of the same sheet, and which scopes have takeoff on a
         * replaced one. A replacement is recorded in the scope-independent
         * meta of the open file; `replaces` links one by hand.
         */
        case 'track_addenda': {
          const db = dbRef.current
          if (!db || activeDocId === null) return { error: 'no document is open' }
          const rows = sheetGroups.flatMap((g) => g.rows)
          const key = (n: string) => n.toLowerCase().replace(/[^a-z0-9]/g, '')
          let links = await readAddendaLinks(db)
          const by = params['page'], replaces = params['replaces']
          if (by !== undefined || replaces !== undefined) {
            const newer = Number(by), older = Number(replaces)
            if (!Number.isInteger(newer) || !Number.isInteger(older) || newer === older || newer < 0 || older < 0 || newer >= pageCount || older >= pageCount) {
              return { error: 'to link by hand give `page` (the addendum sheet) and `replaces` (the sheet it replaces), both ZERO-based pages of this file' }
            }
            links = [...links.filter((l) => l.replaced !== older), { replaced: older, by: newer, source: 'linked' }]
            await writeAddendaLinks(db, links)
            // Into the PDF with the next save: the links are the file's.
            saveRef.current()
          }
          // Same sheet number printed twice: the later page in the set replaces the earlier.
          const seen = new Map<string, number>()
          const auto: Array<{ replaced: number; by: number; source: string }> = []
          for (const r of [...rows].sort((a, b) => a.page - b.page)) {
            if (r.number === `Page ${r.page + 1}` || r.number.startsWith('Addendum')) continue
            const k = key(r.number)
            const prev = seen.get(k)
            if (prev !== undefined && !links.some((l) => l.replaced === prev)) auto.push({ replaced: prev, by: r.page, source: 'same sheet number' })
            seen.set(k, r.page)
          }
          const all = [...links, ...auto]
          const replacedPages = new Set(all.map((l) => l.replaced))
          const affected = new Map<string, { scopeId: string; label: string; markups: number; pages: Set<number> }>()
          for (const m of docMarkupsRef.current) {
            if (m.scopeId === null) continue
            const p = pageNumberFrom(m.pageId, docIdRef.current)
            if (p === null || !replacedPages.has(p)) continue
            const sc = scopesRef.current.find((x) => x.id === m.scopeId)
            const a = affected.get(m.scopeId) ?? { scopeId: m.scopeId, label: sc?.label ?? m.scopeId, markups: 0, pages: new Set<number>() }
            a.markups++; a.pages.add(p)
            affected.set(m.scopeId, a)
          }
          const describe = (p: number) => ({ page: p, sheet: sheetLabelFor(p), title: sheetTitleFor(p) })
          return {
            replaced: all.map((l) => ({ old: describe(l.replaced), new: describe(l.by), source: l.source })),
            scopesOnReplacedSheets: [...affected.values()].map((a) => ({ scopeId: a.scopeId, label: a.label, markups: a.markups, pages: [...a.pages].sort((x, y) => x - y) })),
            note: 'an addendum issued as a separate PDF: open it, read its list_sheets, and link each sheet here with page/replaces after inserting it, or compare the two lists',
          }
        }
        /*
         * Several markups in one call and one undo step (round 3 #12). Each
         * entry is what create_markup takes. A cutout cuts the areas under it,
         * including areas made earlier in the same call.
         */
        case 'create_markups': {
          const list = Array.isArray(params['markups']) ? params['markups'] as Array<Record<string, unknown>> : null
          if (list === null || list.length === 0) return { error: 'create_markups needs `markups`: [{kind, rings, scopeId?}, …]' }
          // Any number in one call and one undo step (the old 500 cap is gone).
          const docId = docIdRef.current
          const pending: Markup[] = []
          // Cutouts into areas already in the PDF are cut after the loop, all
          // together, each into the shape the ones before it left.
          const cuts: Array<{ index: number; pageId: string; ring: Polygon; pendingHit: string[]; pendingMeasure: CutMeasure }> = []
          const results: Array<Record<string, unknown>> = []
          for (let i = 0; i < list.length; i++) {
            // Each entry may name its own ZERO-based page; otherwise the sheet showing.
            // An agent-named page is a target, like a scale gesture's, never a stale read.
            const targetPage = list[i]!['page'] === undefined ? ap.index : Number(list[i]!['page'])
            const pg = targetPage
            if (!Number.isInteger(pg) || pg < 0 || pg >= pageCount) return { error: `markup ${i}: page ${String(list[i]!['page'])} out of range (0..${pageCount - 1})`, created: 0 }
            const pageId = pageIdFor(docId, targetPage)
            const built = agentMarkup(list[i]!, docId, pageId)
            if ('error' in built) return { error: `markup ${i}: ${built.error}`, created: 0 }
            if (built.markup.kind === 'cutout') {
              const ring = built.markup.rings[0]!
              const pendingEdits = cutEdits(pending, pageId, ring, { notch: true })
              for (const e of pendingEdits) {
                const m = pending.find((x) => x.id === e.id)!
                m.rings = e.after
              }
              cuts.push({ index: i, pageId, ring, pendingHit: pendingEdits.map((e) => e.id), pendingMeasure: measureCut(ring, pendingEdits) })
              results.push({ index: i, kind: 'cutout' })
              continue
            }
            pending.push(built.markup)
            const issues = built.markup.kind === 'area' || built.markup.kind === 'shape' ? outlineWarnings(built.markup.rings, pg) : []
            results.push({
              index: i, id: built.markup.id, kind: built.markup.kind, scopeId: built.markup.scopeId, page: pg,
              ...(issues.length > 0 ? { warnings: issues.map((x) => x.message) } : {}),
            })
          }
          const cmds = pending.map((m) => cmdCreate({ ...m, origin: 'agent', reviewState: 'accepted' }))
          const { edits, cutBy, measured } = cutAllEdits(docMarkupsRef.current, cuts, { notch: true })
          for (let k = 0; k < cuts.length; k++) {
            const hit = [...cuts[k]!.pendingHit, ...cutBy[k]!]
            if (hit.length === 0) return { error: `markup ${cuts[k]!.index}: the cutout crosses no area on this sheet`, created: 0 }
            const row = results.find((r) => r['index'] === cuts[k]!.index)!
            row['cut'] = hit
            /*
             * Every cut says what it measures and what it took off (item 1 of
             * the Coinbase report: a 51 sf strip came off as 3.5 sf, silently).
             * Where they differ it says why; with `exact` a cut that does not
             * take its own measured area fails the call and nothing is written.
             */
            const pg = pageNumberFrom(cuts[k]!.pageId, docId)
            const size = projectPageBoxes.get(cuts[k]!.pageId), fpp = projectCalibrations.get(cuts[k]!.pageId)
            if (size === undefined || fpp === undefined || pg === null) continue
            const sf = (normalized: number): number => Math.round(normalized * size.width * size.height * fpp * fpp * 100) / 100
            const pm = cuts[k]!.pendingMeasure, dm = measured[k]!
            const own = sf(pm.own), inside = sf(pm.inside + dm.inside), removed = sf(pm.removed + dm.removed)
            row['cutSquareFeet'] = own
            row['removedSquareFeet'] = removed
            const tol = Math.max(0.05, own * 0.005)
            if (Math.abs(own - removed) > tol) {
              const why = [
                ...(own - inside > tol ? [`${Math.round((own - inside) * 100) / 100} sf of it lies outside the area's outline`] : []),
                ...(inside - removed > tol ? [`${Math.round((inside - removed) * 100) / 100} sf of it was already cut out`] : []),
              ]
              const text = `took ${removed} sf of its own ${own} sf: ${why.length > 0 ? why.join('; ') : 'the cut changed the area by less than it measures'}`
              if (params['exact'] === true) return { error: `markup ${cuts[k]!.index}: the cutout ${text}. Nothing was written. Draw it inside the area, or leave out \`exact\`.`, created: 0 }
              row['warning'] = `this cutout ${text}`
            }
          }
          // What each cut area measures now, so a cut that took less than meant shows.
          const changed = edits.map((e) => {
            const m = docMarkupsRef.current.find((x) => x.id === e.id)!
            const size = projectPageBoxes.get(m.pageId), fpp = projectCalibrations.get(m.pageId)
            const sq = (rings: Markup['rings']) => (size === undefined || fpp === undefined ? null
              : Math.round(areaSquareFeet([{ ...m, rings }], { feetPerPoint: fpp, pageWidth: size.width, pageHeight: size.height }) * 100) / 100)
            return { id: e.id, squareFeetBefore: sq(e.before), squareFeetAfter: sq(e.after), holes: Math.max(0, e.after.length - 1) }
          })
          const editCmd = edits.length > 0 ? editsCommand(edits, 'cut area', 'agent') : null
          const all = [...cmds, ...(editCmd !== null ? [editCmd] : [])]
          await runCommand(all.length === 1 ? all[0]! : cmdBatch(`add ${pending.length} markups`, all))
          return { created: pending.length, markups: results, ...(changed.length > 0 ? { areasCut: changed } : {}) }
        }
        /*
         * The piece list of a run product (round 3 #14): runs, pieces and
         * their cut lengths, stock use, and parts.
         */
        case 'get_piece_list': {
          const id = String(params['scopeId'] ?? agentScope() ?? '')
          const sc = scopesRef.current.find((x) => x.id === id)
          if (!sc) return noScope(id)
          const p = piecesRef.current.find((x) => x.scope.id === id)
          if (!p) return { error: `no calculation for ${sc.label} yet` }
          if (p.result.blockers.length > 0) {
            return { error: `${sc.label} cannot be calculated yet: ${p.result.blockers.map((b) => (typeof b === 'string' ? b : JSON.stringify(b))).join('; ')}`, blockers: p.result.blockers, missing: missingKeys(readProductType(sc.specifications), sc.specifications) }
          }
          if (p.result.cassettes !== undefined) {
            // Full and partial cassettes and every baffle cut (#177); the counts are the BOM's own.
            return {
              scopeId: id, label: sc.label, productType: p.result.productType,
              cassettes: cassettePieceList(p.result.cassettes), parts: p.result.quantities,
              ...(p.result.warnings !== undefined ? { warnings: p.result.warnings } : {}),
            }
          }
          if (p.result.runs.length === 0) {
            return { scopeId: id, productType: p.result.productType, note: 'this product is laid out as panels, not runs; get_bom has the panel counts', parts: p.result.quantities }
          }
          // A page of runs at a time, as many pages as the scope has (no cap).
          const limit = Math.max(1, Number(params['limit'] ?? 1000) || 1000)
          const offset = Math.max(0, Math.floor(Number(params['offset'] ?? 0)) || 0)
          const list = pieceList(p.result, { maxRuns: limit, offset })
          return { scopeId: id, label: sc.label, ...agentPieceList(list, (pid) => pageNumberFrom(pid, docIdRef.current)), ...(list.nextOffset !== undefined ? { note: 'more runs follow; ask again with `offset` set to nextOffset' } : {}) }
        }
        /*
         * Who changed what, and when: the activity trail, which travels in
         * the PDF with the takeoff (round 3 #16).
         */
        case 'get_history': {
          const db = dbRef.current
          if (!db) return { error: 'no document is open' }
          // Paged, with no ceiling: `offset` walks back through the whole trail.
          const limit = Math.max(1, Number(params['limit'] ?? 200) || 200)
          const offset = Math.max(0, Math.floor(Number(params['offset'] ?? 0)) || 0)
          const filter = typeof params['id'] === 'string' ? params['id'] : null
          const fetched = await listActivity(db, limit + 1, { offset, ...(filter !== null ? { entityId: filter } : {}) })
          const more = fetched.length > limit
          const events = fetched.slice(0, limit)
          const info = new Map<string, Record<string, unknown>>()
          const ids = [...new Set(events.filter((e) => e.entityType === 'markup' && e.entityId !== null).map((e) => e.entityId!))]
          for (let i = 0; i < ids.length; i += 200) {
            const chunk = ids.slice(i, i + 200)
            try {
              const found = await db.all<{ id: string; kind: string; page_id: string; scope_id: string | null; origin: string; content_json: string; deleted_at: string | null }>(
                `SELECT id, kind, page_id, scope_id, origin, content_json, deleted_at FROM markups WHERE id IN (${chunk.map(() => '?').join(',')})`, chunk)
              for (const f of found) {
                let adopted: unknown = null
                try { adopted = (JSON.parse(f.content_json) as { adopted?: unknown }).adopted ?? null } catch { adopted = null }
                const pg = pageNumberFrom(f.page_id, docIdRef.current)
                info.set(f.id, {
                  kind: f.kind, page: pg, ...(pg !== null ? { sheet: sheetLabelFor(pg) } : {}),
                  scope: scopesRef.current.find((x) => x.id === f.scope_id)?.label ?? null,
                  madeBy: f.origin, ...(adopted !== null ? { fromAnotherApp: adopted } : {}),
                  ...(f.deleted_at !== null ? { deleted: true } : {}),
                })
              }
            } catch { /* a markup row the database no longer has is reported bare */ }
          }
          return {
            events: events.map((e) => ({
              at: e.createdAt,
              by: e.origin === 'agent' ? 'AI app' : e.origin === 'user' ? 'person' : e.origin,
              event: e.eventType,
              entity: e.entityType,
              id: e.entityId,
              ...(Object.keys(e.details ?? {}).length > 0 ? { details: e.details } : {}),
              ...(e.entityId !== null && info.has(e.entityId) ? { markup: info.get(e.entityId) } : {}),
            })),
            ...(more ? { nextOffset: offset + events.length, note: 'older events follow; ask again with `offset` set to nextOffset' } : {}),
          }
        }
        /*
         * The takeoff as objects (P3-3): each markup with its sheet, scope
         * name, quantity at the sheet's scale, holes and whether it is still
         * waiting to be accepted. Nothing here needs a second call to read.
         */
        case 'list_markups': {
          const db = dbRef.current
          if (db === null || activeDocId === null) return { error: 'no document is open' }
          const dims = new Map<string, { n: number; w: number | null; h: number | null; f: number | null }>()
          const rows = await db.all<{ id: string; n: number; w: number | null; h: number | null; f: number | null }>(
            `SELECT p.id AS id, p.page_number AS n, p.width_pdf_points AS w, p.height_pdf_points AS h, c.feet_per_pdf_point AS f
               FROM pages p LEFT JOIN calibrations c ON c.page_id = p.id WHERE p.document_id = ?1`, [activeDocId])
          for (const r of rows) dims.set(r.id, { n: r.n, w: r.w, h: r.h, f: r.f })
          const showing = ap.id
          const targetPage = Number(params['page'])
          const onlyPage = params['page'] === undefined ? null : pageIdFor(docIdRef.current, targetPage)
          const onlyScope = typeof params['scopeId'] === 'string' ? params['scopeId'] : null
          const onlyKind = typeof params['kind'] === 'string' ? params['kind'] : null
          const limit = Math.max(1, Math.min(5000, Number(params['limit'] ?? 500) || 500))
          const r3 = (x: number) => Math.round(x * 1000) / 1000
          const all = docMarkupsRef.current.filter((m) => !isCutId(m.id)
            && (onlyPage === null || m.pageId === onlyPage)
            && (onlyScope === null || m.scopeId === onlyScope)
            && (onlyKind === null || m.kind === onlyKind))
          const unscaled = new Set<number>()
          const offset = Math.max(0, Math.floor(Number(params['offset'] ?? 0)) || 0)
          const markups = all.slice(offset, offset + limit).map((m) => {
            const d = dims.get(m.pageId)
            const size = m.pageId === showing ? { width: ap.size.width, height: ap.size.height }
              : d !== undefined && d.w !== null && d.h !== null ? { width: d.w, height: d.h } : null
            const sc = m.scopeId === null ? null : scopesRef.current.find((x) => x.id === m.scopeId) ?? null
            const closed = m.kind === 'area' || m.kind === 'cutout' || m.kind === 'shape'
            let quantity: number | null = null
            let unit: string | null = null
            if (m.kind === 'count') { quantity = m.rings[0]?.length ?? 0; unit = 'ea' }
            else if (size !== null && (m.rings[0]?.length ?? 0) >= 2) {
              const opts = { closed, regions: projectRegions.get(m.pageId) ?? [], pageFeetPerPoint: d?.f ?? (m.pageId === showing ? ap.feetPerPoint : null) }
              const outer = measurePoints(m.rings[0]!, size, opts)
              if (closed) {
                let a = outer.areaSquareFeet ?? null
                if (a !== null) for (const hole of m.rings.slice(1)) a -= measurePoints(hole, size, opts).areaSquareFeet ?? 0
                quantity = a === null ? null : r3(Math.max(0, a)); unit = 'sq ft'
              } else { quantity = outer.lengthFeet; unit = 'ft' }
              if (quantity === null && d !== undefined) unscaled.add(d.n)
            }
            return {
              id: m.id, kind: m.kind,
              page: d?.n ?? null, sheet: d === undefined ? null : sheetLabelFor(d.n),
              scopeId: m.scopeId, scope: sc?.label ?? null,
              quantity, unit,
              vertices: m.rings[0]?.length ?? 0, holes: closed ? Math.max(0, m.rings.length - 1) : 0,
              pending: pendingIdsRef.current.has(m.id),
              ...(m.kind === 'link' ? (() => { const c = linkContentOf(m); return c === null ? {} : { toPage: c.toPage, toSheet: sheetLabelFor(c.toPage) } })() : {}),
              ...(m.kind === 'note' ? (() => { const c = parseNoteContent((m as { content?: unknown }).content); return c === null ? {} : { note: { shape: c.shape, text: c.text, color: c.color } } })() : {}),
              ...(params['withGeometry'] === true ? { rings: m.rings } : {}),
            }
          })
          return {
            count: all.length, markups,
            // Nothing is dropped: the rest comes with `offset`.
            ...(all.length > offset + limit ? { nextOffset: offset + limit, note: 'more markups follow; ask again with `offset` set to nextOffset' } : {}),
            // Sheets holding takeoff that measures nothing yet (P3-10).
            unscaledSheets: [...unscaled].sort((a, b) => a - b).map((n) => ({ page: n, sheet: sheetLabelFor(n) })),
          }
        }
        case 'list_scopes': {
          const live = scopesRef.current.map((x) => ({ x, archived: false }))
          const old = params['includeArchived'] === true ? archivedScopes.map((x) => ({ x, archived: true })) : []
          const counts = new Map<string, number>()
          for (const m of docMarkupsRef.current) if (m.scopeId !== null && !isCutId(m.id)) counts.set(m.scopeId, (counts.get(m.scopeId) ?? 0) + 1)
          const scopes = [...live, ...old].map(({ x, archived }) => {
            const type = typeof x.specifications['productType'] === 'string' ? x.specifications['productType'] : null
            return {
              scopeId: x.id, label: x.label, scopeType: x.scopeType, color: x.color,
              productType: type, productLabel: productLabelFor(x.specifications), specifications: x.specifications,
              ...(type !== null ? { needs: missingKeys(readProductType(x.specifications), x.specifications) } : {}),
              markups: counts.get(x.id) ?? 0, archived, active: x.id === activeScopeRef.current,
              ...((): Record<string, unknown> => { const f = spacingSourceFlag(x.specifications); return f !== null ? { spacingCheck: f } : {} })(),
            }
          })
          return { count: scopes.length, scopes }
        }
        default:
          return { error: `unknown action: ${action}. Every action is listed in redbeam_invoke_ui_action's \`action\` input, and most have a tool of their own (redbeam_${action.replace(/[^a-z_]/g, '')} if it exists)` }
      }
    }
  }

  /**
   * Wheel and trackpad pinch, on a NON-PASSIVE native listener.
   *
   * React's onWheel is registered passively, so `preventDefault` inside it does
   * nothing. That left ctrl+wheel — which is exactly how a trackpad pinch is
   * reported — reaching the webview, where it means "zoom the whole page". So
   * pinching scaled the entire user interface, or appeared to do nothing to the
   * drawing, and it looked like pinch-to-zoom was tied to the scroll-to-zoom
   * setting when it never was.
   *
   * A pinch ALWAYS zooms the sheet. `viewer.scrollToZoom` governs the plain
   * wheel only, and it is OFF by default: the wheel scrolls the sheet up and
   * down, Shift+wheel scrolls it sideways, and a sideways wheel — a tilt
   * wheel, a trackpad swipe — scrolls sideways whatever the setting says.
   * Zoom is Ctrl+wheel or the pinch, which is what every PDF viewer does.
   *
   * Two things this used to get wrong. With the setting on (its old
   * default) a plain wheel zoomed and there was no way to scroll the sheet at
   * all; and `deltaX` was only read on the pan branch, so a horizontal wheel
   * did nothing while the setting was on. Aaron: "scrolling should be
   * vertical and if shift is held it should be horizontal", "fix my
   * horizontal scroll wheel".
   */
  useEffect(() => {
    const el = stageRef.current
    if (el === null) return

    const onWheelNative = (e: WheelEvent) => {
      const v = viewerRef.current
      if (!v) return
      // Settings, the scale list and other panels that open over the sheet
      // live inside the stage. A plain wheel over one that scrolls is that
      // panel's: Settings could not be scrolled with the wheel at all.
      if (!e.ctrlKey && !e.metaKey && scrollsInside(e.target, el)) return
      // Otherwise every wheel over the sheet is ours, whether it pans or
      // zooms. Letting one through scrolls or zooms the webview behind us.
      e.preventDefault()

      const rect = el.getBoundingClientRect()
      const pinchGesture = e.ctrlKey || e.metaKey
      // Lines and pages arrive on some mice and every keyboard-driven wheel;
      // pixels are what the viewport moves in.
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewRef.current.vh : 1
      let dx = e.deltaX * unit
      let dy = e.deltaY * unit
      // Shift turns a vertical wheel sideways. Some platforms already have by
      // the time the event arrives (Chromium on Windows reports it as deltaX),
      // so only a delta that is still vertical is turned.
      if (e.shiftKey && dx === 0) { dx = dy; dy = 0 }
      const sideways = dx !== 0 && dy === 0
      const zooms = pinchGesture
        || (prefs['viewer.scrollToZoom'] === true && !e.shiftKey && !sideways)

      if (!zooms) {
        viewRef.current = clampViewport(
          { ...viewRef.current, ox: viewRef.current.ox + dx, oy: viewRef.current.oy + dy },
          v.pageInfo, OVERSCROLL,
        )
        v.requestVisible(viewRef.current)
        requestPaint()
        return
      }

      // A pinch reports fine-grained deltas; the fixed 1.15 step made it lurch.
      const step = pinchGesture
        ? Math.exp(-dy / 180)
        : (dy < 0 ? 1.15 : 1 / 1.15)
      const next = Math.min(MAX_ZOOM, Math.max(0.05, viewRef.current.zoom * step))
      // With slack, so the point under the cursor stays there at the page's edge.
      viewRef.current = clampViewport(
        zoomAbout(viewRef.current, next, e.clientX - rect.left, e.clientY - rect.top),
        v.pageInfo, OVERSCROLL,
      )
      v.requestVisible(viewRef.current)
      requestPaint()
    }

    el.addEventListener('wheel', onWheelNative, { passive: false })
    return () => el.removeEventListener('wheel', onWheelNative)
  }, [prefs, requestPaint])

  // ------------------------------------------------------------- render --

  const nameOf = (d: DocumentRow) =>
    d.displayName || d.relativePath.split('/').pop() || d.relativePath
  const activeDoc = documents.find((d) => d.id === activeDocId) ?? null

  /**
   * The documents as the Files pane lists them. The pane builds the folder
   * TREE itself (`shell/fileTree.ts`); this is only the rows, each with the
   * one qualifier the open document carries.
   */
  const panelFiles = useMemo((): PanelFile[] => documents.map((d) => ({
    id: d.id,
    name: nameOf(d),
    relativePath: d.relativePath,
    /*
     * Only the OPEN document carries a qualifier.
     *
     * Every row used to repeat its own relative path, under a folder heading
     * that already named the folder — so each row said the same thing twice
     * and the file name lost the space to it. The name is what the row is
     * for; the rest was noise.
     */
    /*
     * A document carrying the open round's takeoff says how much. This is
     * where the round's "Pinned" list went (board of 2026-09-18): a drawing
     * with markups on it is a document, and it is listed with the documents.
     */
    detail: d.id === activeDocId && pageCount > 0
      ? `Page ${pageIndex + 1} of ${pageCount}`
      : (() => {
          const n = estimateFiles.find((f) => f.documentId === d.id)?.markupCount ?? 0
          return n === 0 ? '' : `${n} markup${n === 1 ? '' : 's'}`
        })(),
    ...(d.missing ? { missing: true } : {}),
  })), [documents, activeDocId, pageIndex, pageCount, estimateFiles])

  // ------------------------------------------------------- the sheet index --

  /** Page index out of a page id, which is `${documentId}-p${n}`. */

  /**
   * Which sheets carry takeoff.
   *
   * Built from the document-wide markups, not the visible page's — the point
   * of the dot is to tell you about the sheets you are NOT looking at.
   */
  const takeoffPages = useMemo(() => {
    const out = new Set<number>()
    for (const m of docMarkups) {
      // A cloud or a text box is not takeoff, and a link is how the set is
      // read: neither makes a sheet "taken off" or "unscaled".
      if (m.kind === 'note' || m.kind === 'link') continue
      const i = pageIndexOf(m.pageId)
      if (i !== null) out.add(i)
    }
    return out
  }, [docMarkups])

  /**
   * Which scopes have markups on each sheet, for the index's colour dots.
   *
   * Built in SCOPE order rather than markup order, so the dots on one sheet
   * read left to right the same way the scope shelf does — a row whose colours
   * reshuffled because a different markup happened to be drawn first would be
   * unreadable at a glance, which is the only way these are read.
   */
  const pageScopes = useMemo(() => {
    const out = new Map<number, SheetScope[]>()
    for (const s of scopes) {
      for (const m of docMarkups) {
        if (m.scopeId !== s.id) continue
        const i = pageIndexOf(m.pageId)
        if (i === null) continue
        const list = out.get(i) ?? []
        if (!list.some((x) => x.id === s.id)) list.push({ id: s.id, label: s.label, color: s.color })
        out.set(i, list)
      }
    }
    return out
  }, [docMarkups, scopes])

  const sheetGroups = useMemo(() => buildSheetIndex({
    pageCount,
    shape: docIndex.shape,
    outline: docIndex.outline,
    // The document's own labels first; what we read off the sheets fills the
    // gaps. A publisher's label is authoritative and a title block is a guess.
    labels: mergeSheetLabels(docIndex.labels, derivedLabels, pageCount),
    takeoffPages,
    named: titleNames,
  }), [pageCount, docIndex, derivedLabels, takeoffPages, titleNames])

  /** `AE6-01-02` for a page index — what a markup's sheet is called. */
  const sheetLabelFor = useCallback((p: number): string => {
    for (const g of sheetGroups) {
      for (const r of g.rows) if (r.page === p) return r.number
    }
    return `Page ${p + 1}`
  }, [sheetGroups])
  /** The sheet's name beside its number, for the markup groups. Empty when the index has none. */
  const sheetTitleFor = useCallback((p: number): string => {
    for (const g of sheetGroups) {
      for (const r of g.rows) if (r.page === p) return r.title
    }
    return ''
  }, [sheetGroups])

  /** The estimate being checked before it leaves, or null. Shown in the estimates panel. */
  const [exportDraft, setExportDraft] = useState<EstimateExport | null>(null)

  /** Sheet label for any page id in the project — the open document's index, or a page number. */
  const sheetLabelForPageId = useCallback((pageId: string): string => {
    const index = pageIndexOfId(pageId)
    const docId = pageId.replace(/-p\d+$/, '')
    if (index === null) return pageId
    if (docId === docIdRef.current) return sheetLabelFor(index)
    const doc = documents.find((d) => d.id === docId)
    const name = doc === undefined ? docId : (doc.displayName || doc.relativePath.split('/').pop() || doc.relativePath)
    return `${name} p${index + 1}`
  }, [documents, sheetLabelFor])

  /**
   * Build the export model for a round, from what the workspace already knows.
   *
   * Any round, not only the open one: the list level offers the export too,
   * so the round's scope ids are read from the store rather than from the
   * open round's state.
   */
  const buildExportFor = useCallback(async (estimateId: string): Promise<EstimateExport | null> => {
    const db = dbRef.current
    const est = estimates.find((e) => e.id === estimateId)
    if (!db || est === undefined) return null
    const ids = await listEstimateScopeIds(db, estimateId)
    const order = new Map(ids.map((id, i) => [id, i]))
    const roundScopes = scopesRef.current
      .filter((sc) => order.has(sc.id))
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    return buildEstimateExport({
      projectName,
      estimateName: est.name,
      scopes: roundScopes,
      quantities: quantitiesRef.current,
      pieces: piecesRef.current,
      markups: projectMarkups,
      // The same test the quantities make: a scale for the sheet, or for the detail the markup is in.
      measured: (m) => resolveScaleForRings(m.rings, projectRegions.get(m.pageId) ?? [], projectCalibrations.get(m.pageId) ?? null).feetPerPoint !== null,
      sheetLabelFor: sheetLabelForPageId,
      documents: documents.map((d) => d.displayName || d.relativePath),
    })
  }, [estimates, projectName, projectMarkups, projectRegions, projectCalibrations, documents, sheetLabelForPageId])

  const openEstimateExport = useCallback((estimateId: string) => {
    void buildExportFor(estimateId).then((draft) => {
      if (draft === null) { setStatus('that estimate could not be read'); return }
      setExportDraft(draft)
    })
  }, [buildExportFor])

  /**
   * Render the branded PDF for an edited draft and hand it to the downloader.
   * Resolves to a problem to show, or null when the file was written.
   *
   * The PDF is built in a worker (estimatePdfInWorker.ts) from plain data:
   * the takeoff, the piece layouts, the sheets as the window measured them,
   * and the bytes of each drawing with takeoff on it, read from disk here.
   */
  const saveEstimatePdf = useCallback(async (
    draft: EstimateExport,
    onProgress: (text: string) => void,
    /** An AI app's chosen path: written there instead of asking (round 3 #15). */
    target?: { path: string; overwrite: boolean },
  ): Promise<{ problem: string | null; said: string }> => {
    try {
      const inRound = new Set(draft.scopes.map((sc) => sc.id))
      const markups = takeoffFor(projectMarkups, inRound)
      const pageIds = [...new Set(markups.map((m) => m.pageId))]
      const used = new Set(markups.map((m) => m.documentId))
      // Big drawings are read by range while the PDF is built, and closed after.
      const streams: RangedDrawing[] = []
      const make = async () => {
        onProgress('Reading the drawings…')
        const drawings = []
        for (const d of documents) {
          if (!used.has(d.id)) continue
          let bytes: Uint8Array | null = null
          let ranged: { url: string, size: number } | undefined
          try {
            const big = await openRanged(projectBridge, projectPath, d.relativePath)
            if (big !== null) {
              streams.push(big)
              ranged = { url: big.url, size: big.size }
            } else {
              bytes = await projectBridge.readDocument(projectPath, d.relativePath)
            }
          } catch (err) {
            console.warn(`[estimate] could not read ${d.relativePath}:`, err)
          }
          drawings.push({
            documentId: d.id,
            name: d.displayName || d.relativePath,
            bytes,
            ...(ranged === undefined ? {} : { ranged }),
            rotations: [...(pageRotationsRef.current.get(d.id) ?? new Map<number, number>())],
          })
        }
        onProgress('Drawing the snapshots…')
        return {
          estimate: draft,
          snapshots: markups.length > 0,
          scopes: draft.scopes.map((sc) => ({ id: sc.id, label: sc.label, color: sc.color })),
          markups: markups.map((m) => ({ id: m.id, scopeId: m.scopeId, documentId: m.documentId, pageId: m.pageId, kind: m.kind, rings: m.rings })),
          pieces: piecesRef.current
            .filter((p) => inRound.has(p.scope.id))
            .map((p) => {
              // Trim is drawn only where the takeoff counted it.
              const trim = p.result.quantities.some((q) => q.itemKey === 'perimeter_trim' && q.quantity > 0)
                ? perimeterTrimLengthFeet(p.scope.specifications)
                : null
              return {
                scopeId: p.scope.id,
                cells: p.result.cells,
                runs: p.result.runs,
                ...(p.result.componentWidthFeet !== undefined ? { componentWidthFeet: p.result.componentWidthFeet } : {}),
                ...(p.factoryCut !== undefined ? { factoryCut: { cells: p.factoryCut.cells, pieces: p.factoryCut.pieces } } : {}),
                ...(trim !== null ? { trimLengthFeet: trim } : {}),
              }
            }),
          sheets: pageIds.map((pageId): [string, { width: number; height: number; feetPerPoint: number | null; regions: ScaleRegion[] }] => {
            const box = projectPageBoxes.get(pageId)
            return [pageId, {
              width: box?.width ?? 0,
              height: box?.height ?? 0,
              feetPerPoint: projectCalibrations.get(pageId) ?? null,
              regions: projectRegions.get(pageId) ?? [],
            }]
          }),
          labels: pageIds.map((pageId): [string, string] => [pageId, sheetLabelForPageId(pageId)]),
          drawings,
          notes: [],
        }
      }
      let bytes: Uint8Array
      try {
        bytes = await estimatePdfInWorker(make)
      } finally {
        for (const big of streams) big.release()
      }
      if (target !== undefined) {
        if (projectBridge.writeExport === undefined) return { problem: 'this build cannot write files', said: '' }
        const path = await projectBridge.writeExport(target.path, bytes, target.overwrite)
        const said = `PDF saved to ${path}`
        setStatus(said)
        return { problem: null, said }
      }
      onProgress('Choosing where to save…')
      const outcome = await saveFile(bytes, {
        name: exportFileName(draft, 'pdf'),
        type: 'application/pdf',
        filter: { name: 'PDF document', extensions: ['pdf'] },
      })
      const said = saveOutcomeText(outcome, 'PDF')
      setStatus(said)
      return { problem: null, said }
    } catch (err) {
      return { problem: err instanceof Error ? err.message : String(err), said: '' }
    }
  }, [projectPath, documents, projectMarkups, projectPageBoxes, projectCalibrations, projectRegions, sheetLabelForPageId])

  // ------------------------------------------------------- the scope panel --

  /** Scopes belonging to the open bidding round, in its order. */
  /**
   * The scopes IN this estimate, in the order it holds them.
   *
   * This used to fall back to every scope in the project when the estimate
   * held none — a shim from before estimates existed, when "no ids" meant "not
   * organised into rounds yet". Its effect now is that a BRAND NEW estimate
   * displays every scope in the project, each reading "0 markups", so a fresh
   * bidding round looks pre-filled with work nobody put in it. Aaron reported
   * exactly that.
   *
   * An estimate with no scopes has no scopes. Until the ids have been read the
   * answer is unknown rather than empty, and the panel is told which — a
   * momentary onboarding screen in front of a full estimate is its own lie.
   */
  const estimateScopes = useMemo(() => {
    const order = new Map(estimateScopeIds.map((id, i) => [id, i]))
    return scopes
      .filter((s) => order.has(s.id))
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  }, [scopes, estimateScopeIds])

  /**
   * The active scope's markups across the whole document, each with its own
   * measurement.
   *
   * Each markup is measured against ITS OWN page: its own box from the boot
   * report, its own calibration from the store. Reusing the open sheet's
   * numbers would put a confident, wrong area beside every markup on every
   * other sheet.
   */
  const markupRowsFor = useCallback((shown: string): ScopeMarkup[] => {
    // A custom assembly is quantified by hand and lays nothing out, so none of
    // its shapes are missing anything.
    const sc = scopes.find((x) => x.id === shown)
    const laysOut =
      sc !== undefined && readProductType(sc.specifications) !== 'custom_assembly'
      && readProductType(sc.specifications) !== 'linear_parts'
    /*
     * EVERY document, not the open one.
     *
     * The scope's count in the list is project-wide; this page was built
     * from the open document's markups only, so a scope whose two shapes
     * were on another file said "2 markups" above an empty list. Confirmed
     * against the MSK Podium database on 2026-09-11. Each row says which
     * document it is on, and a row from another one opens it.
     */
    const docNameOf = new Map(documents.map((d) => [d.id, d.displayName || d.relativePath.split('/').pop() || d.relativePath]))
    /*
     * Named, and numbered per kind: "Area 1", "Cutout 2". The order is the
     * order the list shows — document, then page, then the markup's own id —
     * so a name stays put when a shape is added on a later sheet. A cutout
     * also says which area it sits in, by that area's name: the bounding box
     * of the area that contains the cutout's centre, on the same sheet.
     */
    // Cuts show as cutouts, each listed once however many areas it cuts. Keys
    // are worked out once per markup, not once per comparison: the sort ran
    // localeCompare and a page lookup a few thousand times on every edit.
    const keyed = withCutouts(projectMarkups)
      .filter((m) => m.scopeId === shown)
      .map((m) => ({
        m,
        here: m.documentId === activeDocId ? 0 : 1,
        doc: docNameOf.get(m.documentId) ?? '',
        page: pageIndexOf(m.pageId) ?? 0,
      }))
    const mine = keyed
      .sort((a, b) => a.here - b.here
        || (a.m.documentId === b.m.documentId ? 0 : collate(a.doc, b.doc))
        || a.page - b.page
        || collate(a.m.id, b.m.id))
      .map((k) => k.m)
    const nameOfMarkup = new Map<string, string>()
    const perKind = new Map<string, number>()
    for (const m of mine) {
      const n = (perKind.get(m.kind) ?? 0) + 1
      perKind.set(m.kind, n)
      nameOfMarkup.set(m.id, `${m.kind.replace(/^./, (c) => c.toUpperCase())} ${n}`)
    }
    const bbox = (m: Markup) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (const ring of m.rings) for (const pt of ring) { x0 = Math.min(x0, pt.x); y0 = Math.min(y0, pt.y); x1 = Math.max(x1, pt.x); y1 = Math.max(y1, pt.y) }
      return { x0, y0, x1, y1 }
    }
    const parentOf = (c: Markup): string | undefined => {
      if (isCutId(c.id)) {
        const owner = cutOwner(projectMarkups, c.id)
        return owner === undefined ? undefined : nameOfMarkup.get(owner.id)
      }
      const b = bbox(c)
      const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2
      for (const a of mine) {
        if (a.kind !== 'area' || a.pageId !== c.pageId) continue
        const ab = bbox(a)
        if (cx >= ab.x0 && cx <= ab.x1 && cy >= ab.y0 && cy <= ab.y1) return nameOfMarkup.get(a.id)
      }
      return undefined
    }
    const out: ScopeMarkup[] = []
    for (const m of mine) {
      const p = pageIndexOf(m.pageId) ?? 0
      const size = projectPageBoxes.get(m.pageId)
      const fpp = projectCalibrations.get(m.pageId)
      let measure = '—'
      if (size !== undefined && fpp !== undefined) {
        const c: Calibration = { feetPerPoint: fpp, pageWidth: size.width, pageHeight: size.height }
        if (m.kind === 'area') measure = `${one(areaSquareFeet([m], c))} SF`
        // A cutout is subtracted material; showing it unsigned reads as though
        // it added that much. Its OWN removal, clipped to the areas around
        // it: measured alone against no area it read "-0.0 SF" every time.
        else if (m.kind === 'cutout' && isCutId(m.id)) {
          const pts = (ring: Array<{ x: number, y: number }>, pageId: string) => {
            const box = projectPageBoxes.get(pageId) ?? size
            return ring.map((pt) => ({ x: pt.x * box.width, y: pt.y * box.height }))
          }
          measure = `−${one(cutRemoves(projectMarkups, m.id, pts) * fpp * fpp)} SF`
        }
        else if (m.kind === 'cutout') measure = `−${one(cutoutSquareFeet(m, projectMarkups, c))} SF`
        else if (m.kind === 'polyline') measure = `${one(linearFeet([m], c))} LF`
        else if (m.kind === 'count') measure = '1 EA'
      }
      /*
       * Why this particular shape is not in the layout.
       *
       * The scope-level blocker says what the SCOPE is missing; it cannot say
       * that four of your six areas are on a sheet with no scale and the other
       * two are carrying the whole number. Grouping drops a markup for exactly
       * two reasons, so those are the two things worth saying, per shape,
       * where the shape is listed.
       */
      let layoutNote: string | null = null
      if (laysOut) {
        if (size === undefined || fpp === undefined) layoutNote = 'this sheet has no scale'
        else if (m.kind !== 'area' && m.kind !== 'cutout') layoutNote = 'only areas and cutouts lay out'
      }
      const parentName = m.kind === 'cutout' ? parentOf(m) : undefined
      out.push({
        id: m.id, kind: m.kind, page: p, measure,
        name: nameOfMarkup.get(m.id) ?? m.kind,
        ...(parentName !== undefined ? { parentName } : {}),
        documentId: m.documentId,
        documentName: docNameOf.get(m.documentId) ?? m.documentId,
        inOpenDocument: m.documentId === activeDocId,
        ...(layoutNote !== null ? { layoutNote } : {}),
      })
    }
    return out
  }, [scopes, projectMarkups, projectPageBoxes, projectCalibrations, documents, activeDocId])
  const scopeMarkups = useMemo((): ScopeMarkup[] => {
    const shown = openScopeId ?? activeScope
    return shown === null ? [] : markupRowsFor(shown)
  }, [openScopeId, activeScope, markupRowsFor])


  const openEstimate = estimates.find((e) => e.id === openEstimateId) ?? null

  /**
   * The one thing standing between the active scope and a quantity.
   *
   * Ordered by what blocks first: without a scale nothing is in real units, so
   * that outranks a missing specification, which outranks a missing direction.
   * Only the first is shown — a list of three problems is a list nobody reads,
   * and fixing the first often reveals the others were consequences.
   */
  const layoutBlocker = useMemo(() => {
    const sc = scopes.find((x) => x.id === activeScope) ?? null
    if (sc === null) return undefined
    /*
     * A scope nobody has put in an estimate has nothing to block.
     *
     * The panel showing "No estimates yet" was also showing "Layout paused" for
     * a seeded scope the estimator had never chosen — a problem reported about
     * work that has not started. A blocker is only news once the scope is
     * somewhere a number will be read from.
     */
    if (openEstimateId === null) return undefined
    /*
     * Calibration is reported ONCE.
     *
     * `warnings` already says this sheet is not calibrated, and this used to say
     * it again in amber immediately above — two blocks, same fact, different
     * words. The general warning keeps it, because it is true whether or not a
     * scope is active; this returns nothing so the panel does not say it twice.
     */
    if (cal === null) return undefined
    const missing = missingRequiredMeasures(readProductType(sc.specifications), sc.specifications)
    if (missing.length > 0) {
      return {
        message: `Layout paused — ${missing.join(' and ')} required`,
        actionLabel: 'Open scope',
        onResolve: () => { setOpenScopeId(sc.id); setWorkOpen(true) },
      }
    }
    const blockers = pieces.find((x) => x.scope.id === sc.id)?.result.blockers ?? []
    if (blockers.length > 0) {
      return {
        message: `Layout paused — ${blockers[0]}`,
        actionLabel: 'Set direction',
        onResolve: () => { setActiveScope(sc.id); setTakeoff(true); setTool('direction') },
      }
    }
    return undefined
  }, [scopes, activeScope, cal, pieces, openEstimateId])
  const shownScopeId = openScopeId ?? activeScope
  const activeQuantities = quantities.find((q) => q.scope.id === shownScopeId)?.rows ?? []

  /**
   * Each scope's saved run, and the earlier day's run it is compared against.
   *
   * Everything else in this panel is recomputed from the markups whenever
   * anything changes — right for working, useless for bidding. So the app
   * records each scope's answer by itself once a change settles (there is no
   * Commit button: Aaron, 2026-11-18, "make it auto-commit, auto-save"), and
   * keeps one run per scope per day. The numbers are compared with the last
   * EARLIER day's run, so changing a specification today still shows what
   * moved since the number somebody sent last week.
   */
  type SavedRun = { run: CalculationRun, quantities: QuantityResultInput[] }
  const [committed, setCommitted] = useState<Map<string, { latest: SavedRun, baseline: SavedRun | null }>>(new Map())
  const committedRef = useRef(committed)
  committedRef.current = committed

  const refreshCommitted = useCallback(async () => {
    const db = dbRef.current
    if (!db) return
    const today = startOfToday()
    const next = new Map<string, { latest: SavedRun, baseline: SavedRun | null }>()
    for (const sc of scopesRef.current) {
      const run = await latestFrozenCalculation(db, sc.id)
      if (run === null) continue
      const latest = { run, quantities: await listCalculationQuantities(db, run.id) }
      const before = (run.acceptedAt ?? '') < today ? run : await frozenCalculationBefore(db, sc.id, today)
      const baseline = before === null ? null
        : before.id === run.id ? latest
          : { run: before, quantities: await listCalculationQuantities(db, before.id) }
      next.set(sc.id, { latest, baseline })
    }
    setCommitted(next)
  }, [])

  useEffect(() => { void refreshCommitted() }, [scopes, refreshCommitted])

  /** What a scope reports right now, as the rows a run records. */
  const liveQuantitiesOf = useCallback((scopeId: string): QuantityResultInput[] => {
    const rows = quantitiesRef.current.find((q) => q.scope.id === scopeId)?.rows ?? []
    const parts = piecesRef.current.find((p) => p.scope.id === scopeId)?.result.quantities ?? []
    return [
      ...rows.map((r) => ({ itemKey: r.itemKey, label: r.label, quantity: r.quantity, unit: r.unit })),
      ...parts.map((q) => ({ itemKey: q.itemKey, label: q.label, quantity: q.quantity, unit: q.unit })),
    ]
  }, [])

  /**
   * Record a scope's answer as it stands, replacing today's earlier save.
   *
   * Skipped when nothing moved since the last save, and when the scope cannot
   * be calculated (its blocker is already on screen). Throws on a failed
   * write, so the bridge never reports a save that did not happen.
   */
  const projectMarkupsLatest = useRef(projectMarkups)
  projectMarkupsLatest.current = projectMarkups
  const projectCalibrationsLatest = useRef(projectCalibrations)
  projectCalibrationsLatest.current = projectCalibrations
  const saveScopeRun = useCallback(async (scopeId: string): Promise<'saved' | 'unchanged' | 'blocked'> => {
    const db = dbRef.current
    const sc = scopesRef.current.find((x) => x.id === scopeId)
    const pieces = piecesRef.current.find((p) => p.scope.id === scopeId)
    if (!db || !sc || !pieces) return 'blocked'
    if (pieces.result.blockers.length > 0) return 'blocked'
    const mine = projectMarkupsLatest.current.filter((m) => m.scopeId === scopeId)
    const prev = committedRef.current.get(scopeId)?.latest ?? null
    // A scope nobody has measured yet has nothing to save.
    if (mine.length === 0 && prev === null) return 'unchanged'
    const live = liveQuantitiesOf(scopeId)
    if (prev !== null && deltaBetween(prev.quantities, live).length === 0) return 'unchanged'
    const rollup = (quantitiesRef.current.find((q) => q.scope.id === scopeId)?.rows ?? [])
      .map((r) => ({ itemKey: r.itemKey, label: r.label, quantity: r.quantity, unit: r.unit }))
    const replaces = prev !== null && (prev.run.acceptedAt ?? '') >= startOfToday() ? prev.run.id : null
    await recordFrozenCalculation(db, calculationFor(sc, pieces.result, rollup, {
      documentId: docIdRef.current,
      // The PROJECT's markups for this scope, matching what the totals above
      // are made of. Saving the open document's would freeze a fragment.
      markups: mine,
      calibrations: projectCalibrationsLatest.current,
    }), { replaces })
    return 'saved'
  }, [liveQuantitiesOf])

  /**
   * Save every scope whose numbers moved, a moment after the last change.
   *
   * One pass at a time; a change during a pass runs one more after it. Not in
   * a popped-out context window (the main window saves the shared project)
   * and not while a drawing is only open for viewing.
   */
  const autoSaveRef = useRef<{ timer: ReturnType<typeof setTimeout> | null, running: boolean, again: boolean }>(
    { timer: null, running: false, again: false })
  const runAutoSave = useCallback(async () => {
    const st = autoSaveRef.current
    if (st.running) { st.again = true; return }
    st.running = true
    try {
      do {
        st.again = false
        let saved = 0
        for (const sc of scopesRef.current) {
          try {
            if (await saveScopeRun(sc.id) === 'saved') saved++
          } catch (err) {
            // Say so: a save that silently fails on a bid is the worst case.
            const why = err instanceof Error ? err.message : String(err)
            setStatus(`could not save ${sc.label}: ${why}`)
          }
        }
        if (saved > 0) {
          saveRef.current()
          await refreshCommitted()
        }
      } while (st.again)
    } finally {
      st.running = false
    }
  }, [saveScopeRun, refreshCommitted, setStatus])

  useEffect(() => {
    // Light files save too: their store is in memory, and the PDF is the record.
    if (!dbRef.current || (quickView !== undefined && !light) || identity.role === 'context') return
    const st = autoSaveRef.current
    if (st.timer !== null) clearTimeout(st.timer)
    st.timer = setTimeout(() => { st.timer = null; void runAutoSave() }, AUTO_SAVE_MS)
    return () => { if (st.timer !== null) { clearTimeout(st.timer); st.timer = null } }
  }, [quantities, pieces, committed, quickView, light, identity.role, runAutoSave])

  /**
   * Auto-save: the open drawing's takeoff goes into its PDF a few seconds
   * after the last change, so Bluebeam (or a colleague on SharePoint) sees it
   * without anyone leaving the drawing or closing the project. Unchanged
   * takeoffs are not rewritten (embedDrawing compares first), and the write
   * goes through the same per-drawing queue as every other save.
   *
   * It waits for a pause in the work too (`embedWhenQuiet`): writing an 80 MB
   * set back to a synced folder is not something to do between two clicks of
   * a polygon, and a takeoff is a run of changes a few seconds apart.
   */
  const lastInputRef = useRef(0)
  useEffect(() => {
    // The person's input in another tab is not work in this one: a PDF live
    // behind it saves on the agent's own pauses.
    const seen = () => { if (showingRef.current) lastInputRef.current = performance.now() }
    const opts = { capture: true, passive: true } as const
    const kinds = ['pointerdown', 'pointermove', 'wheel', 'keydown'] as const
    for (const k of kinds) window.addEventListener(k, seen, opts)
    return () => { for (const k of kinds) window.removeEventListener(k, seen, opts) }
  }, [])
  useEffect(() => {
    const docId = activeDocId
    if (docId === null || !projectBridge.desktop || (quickView !== undefined && !light) || identity.role === 'context') return
    return embedWhenQuiet(
      () => { void saveTakeoffIntoDrawing(docId, { quiet: true }) },
      () => performance.now() - lastInputRef.current,
    )
  }, [activeDocId, markups, scopes, committed, cal, rotationTick, quickView, light, identity.role, saveTakeoffIntoDrawing])

  const activeEntry = pieces.find((p) => p.scope.id === shownScopeId)
  const activePieces = activeEntry?.result
  const activeFactoryCut = activeEntry?.factoryCut

  /**
   * A scope's save against what it shows now: when it was last saved, and
   * what moved since the earlier day's run. Undefined when never saved.
   */
  const commitStateFor = useCallback((scopeId: string) => {
    const hit = committed.get(scopeId)
    if (hit === undefined) return undefined
    const rows = quantities.find((q) => q.scope.id === scopeId)?.rows ?? []
    const parts = pieces.find((p) => p.scope.id === scopeId)?.result.quantities ?? []
    const live = [
      ...rows.map((r) => ({ itemKey: r.itemKey, label: r.label, quantity: r.quantity, unit: r.unit })),
      ...parts,
    ]
    return {
      at: hit.latest.run.acceptedAt,
      since: hit.baseline?.run.acceptedAt ?? null,
      delta: hit.baseline === null ? [] : deltaBetween(hit.baseline.quantities, live),
    }
  }, [committed, quantities, pieces])

  const commitState = shownScopeId === null ? undefined : commitStateFor(shownScopeId)

  /*
   * How any scope stands, for the levels above it: the list totals its
   * rounds and the round reads its scopes' states off this, so every level
   * says what the scope's own page says.
   */
  const standingFor = useCallback((scopeId: string): ScopeStanding | null => {
    const q = quantities.find((x) => x.scope.id === scopeId)
    if (q === undefined) return null
    const c = commitStateFor(scopeId)
    return {
      rows: q.rows,
      committedAt: c === undefined ? null : c.at,
      since: c === undefined ? null : c.since,
      changed: c === undefined ? 0 : c.delta.length,
    }
  }, [quantities, commitStateFor])

  const warningsRef = useRef<PanelWarning[]>([])
  const warnings = useMemo(() => {
    const out: PanelWarning[] = []
    /* Quick view: said first, with the one way out of it. */
    if (quickView !== undefined && !light) {
      out.push({
        text: 'Open for viewing. To take off, choose this drawing’s project folder.',
        action: { label: 'Choose folder…', run: quickView.onAdopt },
      })
    }
    /*
     * Only where it is true of something (board 4, 2026-09-18): a sheet that
     * HAS markups and no scale. The title sheet has nothing drawn for a scale
     * to apply to, and a warning about nothing trains people to ignore the
     * bar. It names the sheet and the count, and carries the fix.
     */
    if (activeDocId !== null && cal === null) {
      const here = pageIdFor(docIdRef.current, pageIndexRef.current)
      const drawn = projectMarkups.filter((m) => m.pageId === here && m.kind !== 'dimension' && m.kind !== 'note' && m.kind !== 'link').length
      if (drawn > 0) {
        out.push({
          text: `${sheetLabelFor(pageIndex)} has no scale, so its ${drawn} markup${drawn === 1 ? ' counts' : 's count'} nothing yet`,
          action: { label: 'Set scale', run: () => openPalette('Set scale for this sheet') },
        })
      }
    }
    /*
     * The tool/scope mismatch used to float above the dock. It reads here
     * instead, with everything else that says a number cannot be trusted —
     * the dock carries controls only.
     */
    /* Light: this file is not being saved into, and why. Said first after quick view. */
    if (loadBlock !== null) out.unshift({ text: loadBlock, action: { label: 'Save a copy…', run: () => void saveCopyOfFile() } })
    if (rebuiltNote !== null) out.push({ text: rebuiltNote, onDismiss: dismissRebuiltNote })
    if (light && oldOffer !== null) {
      out.push({
        text: transferOffer(oldOffer),
        action: {
          label: oldOffer === 1 ? 'Move it now' : 'Move them now',
          run: () => {
            setStatus('moving the older project\u2019s takeoff into its PDFs\u2026')
            void transferFromOldProject('rest', documents.find((d) => d.id === activeDocId)?.relativePath ?? null).catch((err: unknown) => {
              setStatus(`could not move the older project\u2019s takeoff: ${err instanceof Error ? err.message : String(err)}`)
            })
          },
        },
      })
    }
    if (toolWarning !== null) {
      /*
       * Kenneth, 2026-11-26: counts and extra lengths drawn inside an area
       * takeoff never reached its summary. They belong in a Count or Length
       * scope of their own, so the warning offers one: the round's existing
       * one, or a new one named after this scope.
       */
      const kind = TOOL_KIND[tool]
      const here = scopes.find((sc) => sc.id === activeScope)
      const wants = kind === 'count' ? 'count' as const : kind === 'polyline' ? 'linear' as const : null
      if (here !== undefined && wants !== null) {
        const word = wants === 'count' ? 'Count' : 'Length'
        const other = scopes.find((sc) => sc.scopeType === wants)
        // First after a file that cannot save: it is about the markup about to
        // be drawn, and the banner shows one warning at a time.
        out.splice(loadBlock !== null ? 1 : 0, 0, {
          text: `${word === 'Count' ? 'Counts' : 'Lengths'} drawn in ${here.label}, an area scope, reach no total. Draw them in a ${word.toLowerCase()} scope.`,
          action: other !== undefined
            ? { label: `Draw in ${other.label}`, run: () => { setActiveScope(other.id); setOpenScopeId(other.id) } }
            : {
                label: `New ${word.toLowerCase()} scope`,
                run: () => {
                  const made = newScope(`${here.label} ${wants === 'count' ? 'counts' : 'lengths'}`, scopesRef.current)
                  void createScope({ ...made, scopeType: wants, specifications: { productType: 'custom_assembly' } })
                    .then(() => setOpenScopeId(made.id))
                },
              },
        })
      } else out.splice(loadBlock !== null ? 1 : 0, 0, toolWarning)
    }
    if (embeddedHidden || redbeamHidden) {
      const which = embeddedHidden && redbeamHidden ? 'All markups are'
        : embeddedHidden ? 'The PDF\u2019s own markups are' : 'REDBEAM markups are'
      out.push({
        text: `${which} hidden, so you see the drawing on its own.`,
        action: { label: 'Show markups', run: () => { setMarkupVisibility({ embedded: true, redbeam: true }) } },
      })
    }
    /*
     * A cutout subtracts only from an area of ITS OWN scope on the same sheet
     * that it overlaps. One drawn beside an area, or into the wrong scope,
     * subtracts nothing and looks exactly like one that does, "the cutout
     * tool doesn't work". Say which.
     */
    const stray = strayCutouts(projectMarkups)
    if (stray > 0) {
      out.push(`${stray} cutout${stray === 1 ? ' is' : 's are'} outside every area of ${stray === 1 ? 'its' : 'their'} scope on that sheet, so ${stray === 1 ? 'it subtracts' : 'they subtract'} nothing. A cutout has to overlap an area drawn in the same scope.`)
    }
    if (ingestNote !== null) out.push(ingestNote)
    if (textNote !== null) out.push(textNote)
    return out
  }, [cal, toolWarning, tool, scopes, activeScope, createScope, ingestNote, textNote, projectMarkups, activeDocId, pageIndex, sheetLabelFor, openPalette, quickView, light, loadBlock, rebuiltNote, dismissRebuiltNote, saveCopyOfFile, oldOffer, transferFromOldProject, setStatus, documents, embeddedHidden, redbeamHidden, setMarkupVisibility])
  warningsRef.current = warnings

  // ------------------------------------------------------------ view math --

  const setZoom = useCallback((z: number) => {
    // Typing or nudging a zoom is leaving fit, exactly as it is everywhere else.
    setFitMode(null)
    const v = viewerRef.current
    if (!v) return
    // Anchored on the viewport CENTRE: a zoom button is not a pointer
    // position, and anchoring on the last cursor location would make the
    // drawing jump to wherever the mouse happened to be.
    viewRef.current = clampViewport(
      zoomAbout(viewRef.current, Math.min(MAX_ZOOM, Math.max(0.05, z)), stage.width / 2, stage.height / 2),
      v.pageInfo,
    )
    v.requestVisible(viewRef.current)
    forceRender((n) => n + 1)
    requestPaint()
  }, [stage.width, stage.height, requestPaint])

  const fitPage = useCallback(() => {
    const v = viewerRef.current
    if (!v || page.width === 0) return
    const z = Math.min(stage.width / page.width, stage.height / page.height) * 0.96
    // Fit CENTRES; the clamp no longer does. Keeping "legal" and "framed"
    // apart is what lets zoom stay anchored to the cursor at every distance.
    viewRef.current = clampViewport({
      ...viewRef.current,
      zoom: z,
      ox: -(stage.width - page.width * z) / 2,
      oy: -(stage.height - page.height * z) / 2,
    }, v.pageInfo)
    v.requestVisible(viewRef.current)
    forceRender((n) => n + 1)
    requestPaint()
  }, [page.width, page.height, stage.width, stage.height, requestPaint])

  /**
   * Fit the sheet's WIDTH — the one view command an estimator reaches for
   * constantly and the old shell did not have.
   *
   * A construction sheet is wide and short; fitting the whole page to a
   * landscape window leaves the drawing small with bands of dead surround
   * above and below. Fitting the width fills the horizontal axis and lets the
   * vertical scroll, which is how the sheet is read.
   */
  const fitWidth = useCallback(() => {
    const v = viewerRef.current
    if (!v || page.width === 0) return
    const z = (stage.width / page.width) * 0.98
    viewRef.current = clampViewport({
      ...viewRef.current,
      zoom: z,
      ox: -(stage.width - page.width * z) / 2,
      oy: 0,
    }, v.pageInfo)
    v.requestVisible(viewRef.current)
    forceRender((n) => n + 1)
    requestPaint()
  }, [page.width, stage.width, requestPaint])

  /**
   * Fit NOW, then remember the mode.
   *
   * The commands used to do `setFitMode('page')` and rely on the effect
   * below. The mode starts as 'page', and a manual zoom does not clear it,
   * so pressing Fit sheet on a freshly opened set set the state to the value
   * it already had: no change, no effect, no fit. Fit width worked because
   * it changed the value, and Fit sheet worked after it for the same reason.
   * Kenneth: "you can only go to fit sheet after going to fit width".
   */
  const applyFit = useCallback((mode: 'page' | 'width') => {
    if (mode === 'width') fitWidth()
    else fitPage()
    setFitMode(mode)
  }, [fitPage, fitWidth])

  // ------------------------------------------------ zoom box, back, links --

  /** Put a view on screen: leaves fit, asks for its tiles, repaints. */
  const showView = useCallback((next: Viewport) => {
    const v = viewerRef.current
    if (!v) return
    setFitMode(null)
    viewRef.current = clampViewport(next, v.pageInfo)
    v.requestVisible(viewRef.current)
    forceRender((n) => n + 1)
    requestPaint()
  }, [requestPaint])

  /** Go to a scope's markup: its sheet, opening its document first when that is not the open one. */
  const goToMarkup = useCallback((m: ScopeMarkup) => {
    // Land ON the markup, centred, not on the sheet's top-left corner.
    const rings = projectMarkupsRef.current.find((x) => x.id === m.id)?.rings
    const box = rings === undefined ? null : boundsOfRings(rings)
    pendingFrameRef.current = box === null ? null : { documentId: m.documentId, page: m.page, box }
    if (m.documentId !== docIdRef.current) {
      pendingPageRef.current = m.page
      openDocument(m.documentId)
      return
    }
    const v = viewerRef.current
    if (m.page !== pageIndexRef.current || !v || v.pageInfo.width === 0) { goToPage(m.page); return }
    // Already on its sheet: frame it now.
    pendingFrameRef.current = null
    if (box !== null) showView(frameBox(viewRef.current, box, v.pageInfo, stage, MAX_ZOOM))
  }, [openDocument, goToPage, showView, stage])

  const armZoomBox = useCallback(() => {
    if (page.width === 0) return
    zoomBoxArmedRef.current = true
    setZoomBoxArmed(true)
    setStatus('drag a box to zoom to it · click to zoom in · Esc cancels')
  }, [page.width, setStatus])
  const disarmZoomBox = useCallback(() => {
    zoomBoxArmedRef.current = false
    setZoomBoxArmed(false)
  }, [])
  const finishZoomBox = useCallback((box: ScreenBox) => {
    disarmZoomBox()
    const next = zoomToBox(viewRef.current, box, stage, MAX_ZOOM)
    if (next !== null) showView(next)
    // A click, not a drag: zoom in on the point, the way a zoom tool does.
    else showView(zoomAbout(viewRef.current, Math.min(MAX_ZOOM, viewRef.current.zoom * 2), box.x1, box.y1))
  }, [disarmZoomBox, showView, stage])

  const finishTextBox = useCallback((box: ScreenBox) => {
    const v = viewerRef.current
    if (!v || page.width === 0) return
    const at = pageIndexRef.current
    const a = screenToNormalized(box.x0, box.y0, viewRef.current, page.width, page.height)
    const b = screenToNormalized(box.x1, box.y1, viewRef.current, page.width, page.height)
    const nbox = { x0: a.x, y0: a.y, x1: b.x, y1: b.y }
    const pickFrom = (t: { text: string; runs: Parameters<typeof wordsInBox>[1]; scanned: boolean }) => {
      if (pageIndexRef.current !== at) return
      const words = wordsInBox(t.text, t.runs, nbox)
      textPickRef.current = words.length > 0 ? { page: at, words } : null
      setStatus(words.length > 0
        ? `${words.length} word${words.length === 1 ? '' : 's'} selected · Ctrl+C copies`
        : t.scanned ? 'this sheet is a scan with no text to select' : 'no text in that box')
      requestPaint()
    }
    const have = v.getText(at)
    if (have !== undefined) pickFrom(have)
    else void v.requestText(at, { priority: 0 }).then(pickFrom).catch(() => setStatus('could not read the text on this sheet'))
  }, [page.width, page.height, requestPaint, setStatus])

  /** Ctrl+C with words picked by the Text tool. False when there are none. */
  const copyPickedText = useCallback((): boolean => {
    const pick = textPickRef.current
    if (pick === null || pick.page !== pageIndexRef.current || pick.words.length === 0) return false
    const text = wordsAsText(pick.words)
    void navigator.clipboard.writeText(text)
      .then(() => setStatus(`copied ${pick.words.length} word${pick.words.length === 1 ? '' : 's'}`))
      .catch(() => setStatus('could not copy to the clipboard'))
    return true
  }, [setStatus])

  /** Back (-1) or Forward (+1) through the sheets visited. */
  const stepHistory = useCallback((step: -1 | 1) => {
    const v = viewerRef.current
    if (!v) return
    const cur = viewRef.current
    const here = { page: pageIndexRef.current, zoom: cur.zoom, ox: cur.ox, oy: cur.oy }
    const to = step < 0 ? historyRef.current.goBack(here) : historyRef.current.goForward(here)
    if (to === null) { setStatus(step < 0 ? 'nothing to go back to' : 'nothing to go forward to'); return }
    if (to.page === here.page) { showView({ ...cur, zoom: to.zoom, ox: to.ox, oy: to.oy }); return }
    historyNavRef.current = to
    v.loadPage(to.page)
    setSelectedIds([]); selectedRef.current = []
  }, [setStatus, showView])

  // A Back or Forward lands: frame the sheet as it was left, once it has loaded.
  useEffect(() => {
    const to = historyNavRef.current
    if (to === null || to.page !== pageIndex) return
    historyNavRef.current = null
    showView({ ...viewRef.current, zoom: to.zoom, ox: to.ox, oy: to.oy })
  }, [pageIndex, page.width, page.height, showView])

  /** Follow one of the PDF's own links: to its sheet, or out to the browser. */
  const followLink = useCallback((link: PageLink) => {
    if (link.page !== undefined) {
      if (link.page !== pageIndexRef.current) goToPage(link.page)
      setStatus(`went to ${sheetLabelFor(link.page)} · Alt+Left goes back`)
      return
    }
    if (link.uri !== undefined) {
      const uri = link.uri
      void openWebLink(uri).then((ok) => setStatus(ok ? `opened ${uri}` : `could not open ${uri}`))
    }
  }, [goToPage, setStatus, sheetLabelFor])

  /** Every link on the showing sheet: the PDF's own, and the ones made here (tools/links.ts). */
  const linksHere = (): PageLink[] => {
    const own = pageLinksFrom(markupsRef.current, pageIdFor(docIdRef.current, pageIndexRef.current))
    return [...own, ...(viewerRef.current?.getLinks(pageIndexRef.current) ?? [])]
  }

  // ---------------------------------------------------- the Link tool ----
  /** A drawn box waiting for its sheet: where it is on the sheet and on screen. */
  const [pendingLink, setPendingLink] = useState<{ ring: Array<{ x: number; y: number }>; page: number; x: number; y: number; suggested: number[] } | null>(null)
  const pendingLinkRef = useRef(pendingLink)
  pendingLinkRef.current = pendingLink
  const pickerSheets = useMemo(() => sheetGroups.flatMap((g) => g.rows.map((r) => ({ page: r.page, number: r.number, title: r.title }))), [sheetGroups])
  const openLinkPickerRef = useRef<(points: Array<{ x: number; y: number }>) => void>(() => {})
  openLinkPickerRef.current = (points) => {
    const box = ringBox(points)
    const at = pageIndexRef.current
    const pt = viewerRef.current?.getText(at)
    const words = pt === undefined ? [] : wordsOnPage(pt, box).map((w) => ({ text: w.text }))
    const corner = normalizedToScreen(box.x1, box.y1, viewRef.current, page.width, page.height)
    setPendingLink({ ring: boxRing(box), page: at, x: corner.x + 8, y: corner.y + 8, suggested: suggestTargets(words, pickerSheets, at) })
  }
  const cancelLinkRef = useRef<() => void>(() => {})
  cancelLinkRef.current = () => {
    setPendingLink(null)
    draftRef.current = emptyDraft('link')
    requestPaint()
  }
  const pickLinkTarget = useCallback(async (toPage: number) => {
    const pl = pendingLinkRef.current
    if (pl === null) return
    setPendingLink(null)
    draftRef.current = emptyDraft('link')
    // The sheet the box was drawn on, carried with it: no current page to be stale about.
    const targetPage = pl.page
    const ok = await runCommand(cmdCreate({
      id: uid(), documentId: docIdRef.current, pageId: pageIdFor(docIdRef.current, targetPage), scopeId: null,
      kind: 'link', rings: [pl.ring], origin: 'user', reviewState: 'accepted',
      content: { toPage, source: 'drawn' },
    }))
    if (ok) setStatus(`linked to ${sheetLabelFor(toPage)} · it goes into the PDF on the next save`)
    requestPaint()
  }, [runCommand, setStatus, sheetLabelFor, requestPaint])

  // ------------------------------------------- link detail callouts ----
  /*
   * Every sheet is read for references to other sheets (tools/callouts.ts),
   * in the background with a count, on readers of its own when the set is big
   * (Aaron, 2026-11-24: no caps, show progress). Nothing is written until the
   * list is approved; then the ticked ones become links in one undo step.
   */
  const [review, setReview] = useState<ReviewState | null>(null)
  const reviewRef = useRef(review)
  reviewRef.current = review
  const reviewRunRef = useRef(0)
  const findCalloutLinks = useCallback(async () => {
    const v = viewerRef.current
    if (!v || activeDocId === null || pageCount === 0) return
    const numbered = pickerSheets.filter((s) => !/^Page \d+$/.test(s.number))
    if (numbered.length < 2) {
      setStatus('this set has no sheet numbers to match yet; name its sheets from the title block first')
      return
    }
    const run = ++reviewRunRef.current
    const docId = docIdRef.current
    setReview({ phase: 'reading', read: 0, total: pageCount, candidates: [], focus: null })
    const pool = textPool()
    const pages = Array.from({ length: pageCount }, (_, i) => i)
    if (pool !== null) pool.want(pages.filter((p) => v.getText(p) === undefined))
    const found: ReviewState['candidates'] = []
    let breath = performance.now()
    for (const sweepPage of pages) {
      const p = sweepPage
      if (reviewRunRef.current !== run || docIdRef.current !== docId) return
      let pt: PageText | null = v.getText(p) ?? null
      if (pt === null) {
        try { pt = pool !== null ? await pool.text(p) : await v.requestText(p, { priority: PRIORITY_THUMBNAIL }) } catch { pt = null }
      }
      if (pt !== null) {
        const words = wordsOnPage(pt).map((w) => ({ text: w.text, ...w.box }))
        const pageId = pageIdFor(docId, sweepPage)
        const existing = [
          ...(v.getLinks(p) ?? []).map((l) => l.rect),
          ...pageLinksFrom(markupsRef.current.filter((m) => m.pageId === pageId), pageId).map((l) => l.rect),
          ...projectMarkupsRef.current.filter((m) => m.kind === 'link' && m.pageId === pageId).map((m) => ringBox(m.rings[0] ?? [])),
        ]
        found.push(...findCallouts(p, words, numbered, existing))
      }
      if (performance.now() - breath > 120 || p === pageCount - 1) {
        if (reviewRunRef.current !== run) return
        setReview((r) => r === null ? r : { ...r, read: p + 1, candidates: [...found] })
        await new Promise((resolve) => setTimeout(resolve, 0))
        breath = performance.now()
      }
    }
    if (reviewRunRef.current !== run) return
    setReview((r) => r === null ? r : { ...r, phase: 'ready', read: pageCount, candidates: [...found] })
    requestPaint()
  }, [activeDocId, pageCount, pickerSheets, setStatus, requestPaint])

  const closeReview = useCallback(() => {
    reviewRunRef.current++
    setReview(null)
    requestPaint()
  }, [requestPaint])

  const focusCandidate = useCallback((i: number) => {
    const c = reviewRef.current?.candidates[i]
    if (c === undefined) return
    setReview((r) => r === null ? r : { ...r, focus: i })
    const v = viewerRef.current
    if (c.page !== pageIndexRef.current || !v || v.pageInfo.width === 0) {
      reviewFocusRef.current = { page: c.page, rect: c.rect }
      goToPage(c.page)
      return
    }
    showView(reviewViewFor(c.rect, v.pageInfo))
  }, [goToPage, showView])

  /*
   * The view that shows a callout: zoomed so the tag reads, with room around
   * it, centred in the part of the drawing the review panel does not cover.
   */
  const reviewFocusRef = useRef<{ page: number; rect: { x0: number; y0: number; x1: number; y1: number } } | null>(null)
  const reviewViewFor = (rect: { x0: number; y0: number; x1: number; y1: number }, pg: { width: number; height: number }): Viewport => {
    const st = stageSizeRef.current
    const panel = Math.min(st.width * 0.5, 384)
    const room = Math.max(120, st.width - panel)
    const cx = ((rect.x0 + rect.x1) / 2) * pg.width, cy = ((rect.y0 + rect.y1) / 2) * pg.height
    // About twelve tags across: the callout and the drawing it points out of.
    const span = Math.max((rect.x1 - rect.x0) * pg.width * 12, (rect.y1 - rect.y0) * pg.height * 8, 1)
    const zoom = Math.min(MAX_ZOOM, room / span, st.height / span)
    return { ...viewRef.current, zoom, ox: cx * zoom - room / 2, oy: cy * zoom - st.height / 2 }
  }
  useEffect(() => {
    const f = reviewFocusRef.current
    const v = viewerRef.current
    if (f === null || f.page !== pageIndex || !v || v.pageInfo.width === 0 || page.width === 0) return
    reviewFocusRef.current = null
    showView(reviewViewFor(f.rect, v.pageInfo))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageIndex, page.width, page.height, showView])

  const applyReview = useCallback(async () => {
    const r = reviewRef.current
    if (r === null) return
    const picked = r.candidates.filter((c) => c.checked)
    if (picked.length === 0) return
    const docId = docIdRef.current
    // Each link goes on the sheet it was found on, which the candidate carries.
    const cmds = picked.map(({ page: targetPage, ...c }) => cmdCreate({
      id: uid(), documentId: docId, pageId: pageIdFor(docId, targetPage), scopeId: null,
      kind: 'link', rings: [boxRing(c.rect)], origin: 'user', reviewState: 'accepted',
      content: { toPage: c.toPage, source: 'callout', text: c.text },
    }))
    const ok = await runCommand(cmds.length === 1 ? cmds[0]! : cmdBatch(`link ${cmds.length} callouts`, cmds))
    if (ok) {
      setReview(null)
      setStatus(`added ${picked.length} link${picked.length === 1 ? '' : 's'} · they go into the PDF on the next save, and Ctrl+Z takes them back`)
    }
    requestPaint()
  }, [runCommand, setStatus, requestPaint])
  const findCalloutLinksRef = useRef(findCalloutLinks)
  findCalloutLinksRef.current = findCalloutLinks
  // The review's boxes are painted from its ref, which is current after the render.
  useEffect(() => { requestPaint() }, [review, requestPaint])

  /**
   * Turn sheets by clockwise quarter turns: 1, 2 (180°) or 3 (counterclockwise).
   *
   * Everything drawn on each turns with it (rotatePageData), so a takeoff stays
   * on what it was drawn over and every quantity stays what it was. The undo
   * history goes: an earlier shape put back would land in the old orientation.
   */
  const rotatePages = useCallback(async (pages: readonly number[], turns: 1 | 2 | 3) => {
    const v = viewerRef.current, db = dbRef.current
    const docId = activeDocId
    if (!v || !db || docId === null || pages.length === 0) return
    const turnsWord = turns === 1 ? 'clockwise' : turns === 3 ? 'counterclockwise' : '180°'
    const what = pages.length === 1 ? sheetLabelFor(pages[0]!) : `${pages.length} sheets`
    try {
      const forDoc = pageRotationsRef.current.get(docId) ?? new Map<number, number>()
      pageRotationsRef.current.set(docId, forDoc)
      for (const targetPage of pages) {
        await rotatePageData(db, pageIdFor(docId, targetPage), turns)
        const after = await v.turnPage(targetPage, turns)
        forDoc.set(targetPage, after.rotation)
      }
      const u = undoRef.current
      if (u) { await u.clear(); setUndoState(u.state) }
      if (pages.includes(pageIndexRef.current)) setFitMode('page')
      await syncMarkups()
      await refreshScopes()
      setRotationTick((n) => n + 1)
      requestPaint()
      setStatus(`turned ${what} ${turnsWord} · the takeoff turned with it · undo starts again from here`)
    } catch (err) {
      setStatus(`could not turn ${what}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [activeDocId, syncMarkups, refreshScopes, requestPaint, setStatus, sheetLabelFor])
  const rotateSheet = useCallback((delta: 1 | -1) => {
    if (page.width === 0) return Promise.resolve()
    return rotatePages([pageIndexRef.current], delta === 1 ? 1 : 3)
  }, [page.width, rotatePages])

  /**
   * Print sheets of the open drawing: the PDF with this window's takeoff in
   * it, cut down to `indices`, through the system print dialog (print.ts).
   */
  const printSheets = useCallback(async (indices: readonly number[]) => {
    const db = dbRef.current
    const doc = documents.find((d) => d.id === activeDocId)
    if (!db || !doc || indices.length === 0) return
    const what = printedWhat(indices, pageCount, sheetLabelFor)
    setStatus(`getting ${what} ready to print…`)
    try {
      const copyOpts = {
        db, documentId: doc.id, relativePath: doc.relativePath, displayName: doc.displayName || doc.relativePath,
        appVersion: APP_VERSION,
        allScopes: light,
        ...(pageRotationsRef.current.has(doc.id) ? { pageRotations: pageRotationsRef.current.get(doc.id)! } : {}),
      }
      // A big drawing: just these sheets, with the takeoff, read by range.
      const big = await withRanged(projectBridge, projectPath, doc.relativePath, async (d) => d.sheets(await copyInput(copyOpts), [...indices]))
      if (big !== null) {
        await printPdf(big.value)
      } else {
        const whole = await embedCopy({ ...copyOpts, read: () => projectBridge.readDocument(projectPath, doc.relativePath) })
        await printPdf(await sheetsPdf(whole, indices))
      }
      setStatus(`printing ${what}`)
    } catch (err) {
      setStatus(`could not print: ${err instanceof Error ? err.message : String(err)} · Save a copy and print it from your PDF viewer`)
    }
  }, [documents, activeDocId, pageCount, sheetLabelFor, setStatus, projectPath, light])

  // The window's listeners are bound once; these refs hand them the latest.
  const armZoomBoxRef = useRef(armZoomBox); armZoomBoxRef.current = armZoomBox
  const disarmZoomBoxRef = useRef(disarmZoomBox); disarmZoomBoxRef.current = disarmZoomBox
  const finishZoomBoxRef = useRef(finishZoomBox); finishZoomBoxRef.current = finishZoomBox
  const finishTextBoxRef = useRef(finishTextBox); finishTextBoxRef.current = finishTextBox
  const copyPickedTextRef = useRef(copyPickedText); copyPickedTextRef.current = copyPickedText
  const stepHistoryRef = useRef(stepHistory); stepHistoryRef.current = stepHistory
  const followLinkRef = useRef(followLink); followLinkRef.current = followLink
  const printSheetsRef = useRef(printSheets); printSheetsRef.current = printSheets

  // The mouse's Back and Forward buttons would otherwise take the webview
  // itself back a page. The press is handled on the stage; this only stops
  // the browser's own navigation on release.
  useEffect(() => {
    const stop = (e: MouseEvent) => { if (e.button === 3 || e.button === 4) e.preventDefault() }
    window.addEventListener('mouseup', stop)
    return () => window.removeEventListener('mouseup', stop)
  }, [])

  /**
   * Re-apply the fit whenever the thing being fitted changes.
   *
   * Page box, window size, or the mode itself — any of them invalidates a
   * computed zoom. Doing this on every page change is the whole point: it is
   * what makes a mixed-size document readable without touching the zoom once.
   */
  useEffect(() => {
    if (fitMode === null || page.width === 0 || stage.width === 0) return
    if (fitMode === 'width') fitWidth()
    else fitPage()
    // `pageIndex` is in here deliberately. A drawing set is mostly same-size
    // sheets, so paging through it leaves page.width/height untouched — and
    // without this the fit would never re-centre after the offsets were reset.
  }, [fitMode, pageIndex, page.width, page.height, stage.width, stage.height, fitPage, fitWidth])

  /**
   * The sheet owns zoom. All of it.
   *
   * The webview has its own zoom, on the same gestures and the same keys, and
   * it scales the entire interface — chrome, dock and all — which is never
   * what someone zooming a drawing means. The way that was suppressed was at
   * the platform level: `--disable-pinch` in the browser arguments and
   * `zoomHotkeysEnabled: false` on the window.
   *
   * That is the wrong tool, and it is why the trackpad pinch did nothing. Both
   * settings work by taking the gesture away BEFORE the page sees it, so the
   * ctrl+wheel that a pinch is delivered as never arrived and there was
   * nothing left for the sheet to zoom with. Turning "scroll wheel zooms" off
   * then made it look completely dead, because the plain wheel that did arrive
   * panned instead.
   *
   * So: suppress nothing upstream, and claim every zoom input here instead.
   * preventDefault on a ctrl+wheel is what actually stops the webview scaling,
   * and it is claimed for the whole document — the stage's own handler still
   * runs and still zooms the sheet, because this neither stops propagation nor
   * needs to. The keys are claimed the same way, and Ctrl+= / Ctrl+- become
   * what a person pressing them in a drawing application means: zoom the
   * drawing.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!showingRef.current) return
      if (!e.ctrlKey || e.altKey) return
      // '+' needs Shift on most layouts, so shift is allowed through for the
      // zoom keys and only the shift-free ones check for it.
      switch (e.key) {
        case '=': case '+': e.preventDefault(); setZoom(viewRef.current.zoom * 1.25); return
        case '-': case '_': e.preventDefault(); setZoom(viewRef.current.zoom / 1.25); return
      }
      if (e.shiftKey) {
        if (e.key === 'T' || e.key === 't') { e.preventDefault(); const id = closedTabsRef.current.pop(); if (id !== undefined) openDocument(id) }
        return
      }
      if (e.key === 'p' || e.key === 'P') { e.preventDefault(); if (pageIndexRef.current >= 0) void printSheetsRef.current([pageIndexRef.current]) ; return }
      if (e.key === '0') { e.preventDefault(); applyFit('page') }
      if (e.key === '1') { e.preventDefault(); applyFit('width') }
      // The design package removes the permanent menu bar on the explicit
      // condition that this exists, so it is not a convenience.
      if (e.key === 'k' || e.key === 'K') { e.preventDefault(); openPalette() }
    }
    /*
     * Every ctrl+wheel in the window, not only the ones over the sheet.
     *
     * Capture phase so it runs first, and no stopPropagation, so the stage's
     * own wheel handler still receives the event and still zooms the drawing.
     * Over a pane or the dock there is nothing to zoom, and the point is only
     * that the webview does not zoom either.
     */
    const onWheel = (e: WheelEvent) => { if (e.ctrlKey) e.preventDefault() }
    window.addEventListener('keydown', onKey)
    document.addEventListener('wheel', onWheel, { passive: false, capture: true })
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions)
    }
  }, [applyFit, setZoom, openPalette, openDocument])

  /**
   * Apply a named scale from the title block.
   *
   * The whole point of the preset list: the drawing already says what it is,
   * so measuring a line and typing its length to rediscover that is work the
   * document can do for you.
   */
  const applyPreset = useCallback((p: ScalePreset) => {
    if (page.width === 0) return
    void commitCalibration(
      {
        feetPerPoint: feetPerPointForPreset(p),
        pageWidth: page.width,
        pageHeight: page.height,
      },
      presetSource(p),
    )
  }, [page.width, page.height, commitCalibration])

  /**
   * Everything the palette can reach.
   *
   * Built from the state the UI already renders rather than a parallel
   * registry: a command list that drifts from what the app can actually do is
   * worse than no palette, because it fails silently.
   */

  /**
   * At most one modal at a time, and one place that says which.
   *
   * Calibration outranks the rest: it is the tail of a gesture the estimator is
   * mid-way through, and losing it to a panel opened by a stray shortcut would
   * throw away a measurement they just took.
   */
  /**
   * Leave every place that can be left: settings, and the bill. The panes
   * and the scope page are not closed — they are where the work is, not
   * something over it — and neither is a calibration or a region waiting for
   * its answer: those hold a measurement, and "close everything" is not a
   * decision to discard one. Each has its own Cancel.
   */
  const closeModals = useCallback(() => {
    setSettingsOpen(false)
  }, [])

  /** Abandon a region that was drawn but never given a scale. */
  /**
   * Entering takeoff requires somewhere for the quantity to land.
   *
   * A scope belongs to an estimate, and a project with no estimate has nowhere
   * for one to go — but Take off started anyway, so it was possible to draw a
   * ceiling, watch the area appear on the sheet, and find nothing anywhere in
   * the panel afterwards. The markup was real and attached to a scope; the
   * scope was in no bidding round, so no total included it.
   *
   * Rather than invent a round on the estimator's behalf — which is a decision
   * about the bid, not about the UI — this sends them to the panel that makes
   * one and says why.
   */
  const beginTakeoff = useCallback((on: boolean) => {
    if (!on) { setTakeoff(false); return }
    if (!requireProject()) return
    // Light: the file's one round is made when it opens; nothing to choose.
    if (light) { setTakeoff(true); return }
    if (estimates.length === 0) {
      setWorkOpen(true)
      setOpenEstimateId(null)
      setStatus('Create an estimate first — a takeoff has to land in a bidding round')
      return
    }
    if (openEstimateIdRef.current === null) {
      setWorkOpen(true)
      setStatus('Open the estimate this takeoff belongs to')
      return
    }
    setTakeoff(true)
  }, [estimates.length, requireProject, light])

  const openTabs = openDocIds
    .map((id) => documents.find((d) => d.id === id))
    .filter((d): d is DocumentRow => d !== undefined)
    .map((d): ShellTab => ({
      id: d.id, name: nameOf(d), relativePath: d.relativePath,
      ...(d.missing ? { missing: true } : {}),
    }))

  /** Sheet codes for the thumbnail grid, so a thumb reads as its sheet. */
  const thumbLabels = useMemo(() => {
    const out: Record<number, string> = {}
    for (const g of sheetGroups) for (const r of g.rows) out[r.page] = r.number
    return out
  }, [sheetGroups])

  const PANE_TITLE: Record<RailPanel, string> = {
    files: 'Files',
    thumbnails: 'Thumbnails',
    contents: 'Contents',
    search: 'Search',
  }

  /*
   * What the sheet panels say while there is nothing to list YET.
   *
   * Two waits look identical from the page count and are not: the folder is
   * still being read (no document has been chosen), or a document was chosen
   * and the viewer has not reported its pages. Null once the answer is known,
   * at which point "no document open" is a true statement.
   */
  const pendingText: string | null =
    activeDocId !== null && pageCount === 0
      ? (openFailed ? 'This PDF could not be opened.' : 'Opening the drawing…')
      : scan === 'reading' && activeDocId === null
        ? 'Reading the project folder…'
        : null

  /*
   * THE PALETTE'S VOCABULARY: every verb the app has, so the whole app can be
   * driven from one field.
   *
   * Three rules hold the list together. A verb that cannot run right now is
   * still listed, with the reason at its right edge — an empty palette teaches
   * nothing, "open a scope first" does. A verb that needs more takes it in the
   * palette's own field as a step, never in a dialog. And a verb the store
   * refuses returns the refusal as a string, which the palette shows and stays
   * open on, rather than closing on nothing.
   *
   * Rows are grouped by the palette (Commands, Scopes, Estimates, Documents,
   * Pages, Projects) and narrowed by its prefixes; `scope-action` in a row's
   * keywords lets `@` list what can be done TO a scope beside the scopes.
   */
  /*
   * Built only while the palette is open. It reads nearly everything in the
   * workspace, so as an always-on memo it was rebuilt on every edit, for a
   * list nobody was looking at.
   */
  const commands = useMemo((): Command[] => {
    if (!paletteOpen) return []
    const activeDoc = documents.find((d) => d.id === activeDocId)
    const openRound = estimates.find((e) => e.id === openEstimateId)
    const shown = scopes.find((s) => s.id === shownScopeId)
    const noSheet = activeDoc === undefined ? 'no drawing open' : undefined
    const noRound = openRound === undefined ? 'open a round first' : undefined
    const noScope = shown === undefined ? 'open a scope first' : undefined
    const noScale = cal === null ? 'sheet has no scale' : undefined
    const markupsOnThisPage = activeDoc === undefined
      ? 0
      : projectMarkups.filter((m) => m.pageId === pageIdFor(docIdRef.current, pageIndexRef.current) && m.kind !== 'dimension' && m.kind !== 'note' && m.kind !== 'link').length
    const allPages = Array.from({ length: pageCount }, (_, i) => i)
    const scaledPages = allPages.filter((i) => scaleOfPage(i) !== null).length
    const stuck = (why: string | undefined) => (why === undefined ? {} : { unavailable: why })
    /*
     * Report a bug without leaving the prompt: what kind, then the sentence,
     * then Enter sends it. A report that cannot go is not lost — the refusal
     * offers the form with the sentence already in it.
     */
    const reportWhere = whereLine([
      projectName, activeDoc === undefined ? null : (activeDoc.displayName || activeDoc.relativePath.split('/').pop()),
      activeDoc === undefined ? null : sheetLabelFor(pageIndex),
    ])
    const sendQuickReport = async (kind: ReportKind, text: string): Promise<Outcome> => {
      const result = await sendReport(buildPayload({ ...EMPTY_DRAFT, kind, summary: text }, await gatherContext(reportWhere)))
      if (result.ok) { setStatus(`report sent · #${result.id.slice(0, 8)} · thank you`); return undefined }
      return {
        reason: result.reason,
        alternative: {
          id: 'report-bug-retry', kind: 'command', title: 'Open it in the report form', icon: Bug,
          run: () => openReport({ kind, summary: text }),
        },
      }
    }
    const reportCommand: Command = {
      id: 'report-bug', kind: 'command', title: 'Report a bug…', icon: Bug,
      detail: 'Tell the people who maintain REDBEAM what went wrong',
      keywords: ['bug', 'feedback', 'problem', 'issue', 'broken', 'wrong', 'support', 'help'],
      alt: { label: 'Open the report form', run: () => openReport() },
      step: {
        kind: 'choose', label: 'Report a bug', note: 'what kind of problem',
        options: () => REPORT_KINDS.map((k): Command => ({
          id: `report-kind-${k.value}`, kind: 'command', title: k.label, detail: k.hint, icon: Bug,
          alt: { label: 'Open the report form', run: () => openReport({ kind: k.value }) },
          step: {
            kind: 'text', label: k.label, placeholder: k.placeholder,
            rule: 'one sentence; Shift+Enter on the command opens the form for more',
            validate: (t) => (t.trim() === '' ? 'say what happened' : t.trim().length > SUMMARY_MAX ? `under ${SUMMARY_MAX} characters` : null),
            describe: (t) => `Send “${t.trim()}” with REDBEAM ${APP_VERSION}${reportWhere === '' ? '' : ` and ${reportWhere}`}`,
            run: (t) => sendQuickReport(k.value, t.trim()),
          },
        })),
      },
    }
    const nameTaken = (name: string, among: readonly string[]) =>
      among.some((n) => n.trim().toLowerCase() === name.trim().toLowerCase())
    const roundNameRule = (text: string): string | null =>
      text.trim() === '' ? 'a round needs a name'
        : nameTaken(text, estimates.map((e) => e.name)) ? 'a round with that name already exists' : null
    /* ---- scope workflow builders (see the scopes block below) ---- */
    const liveScope = (id: string): Scope | undefined => scopesRef.current.find((x) => x.id === id)
    const scopeByLabel = async (label: string): Promise<Scope | null> => {
      // The state may not have flushed on the tick the scope was written.
      await until(() => scopesRef.current.some((x) => x.label === label), 500)
      return scopesRef.current.find((x) => x.label === label) ?? null
    }
    /** A choose step listing the round's scopes, each leading into `then`. */
    const pickScope = (label: string, then: (sc: Scope) => Command): Step => ({
      kind: 'choose', label, note: 'which scope',
      options: () => [...estimateScopes].sort((a, b) => (a.id === shownScopeId ? -1 : b.id === shownScopeId ? 1 : 0))
        .map((sc): Command => ({
          ...then(sc),
          id: `pick-${sc.id}`, kind: 'scope', title: sc.label,
          detail: `${scopeProductLabel(sc)} · ${markupCounts[sc.id] ?? 0} markup${(markupCounts[sc.id] ?? 0) === 1 ? '' : 's'}`,
        })),
    })
    const renameCommand = (id: string): Command => ({
      id: `rename-${id}`, kind: 'command', title: 'Rename',
      step: {
        kind: 'text', label: 'Rename scope', placeholder: 'New name', initial: liveScope(id)?.label ?? '', rule: 'must be unique in the round',
        validate: (t) => (t.trim() === liveScope(id)?.label ? 'that is its name now' : scopeNameRule(t)),
        describe: (t) => `Rename to “${t.trim()}”`,
        run: (t) => { const sc = liveScope(id); if (sc !== undefined) void saveScope({ ...sc, label: t.trim() }) },
      },
    })
    const productCommand = (id: string, after: { then?: 'counts' | 'configure' }): Command => ({
      id: `set-product-${id}`, kind: 'command', title: 'Set product',
      step: {
        kind: 'choose', label: 'Product', note: `for ${liveScope(id)?.label ?? 'the scope'}`,
        options: () => PRODUCT_TYPES.map((t): Command => ({
          id: `product-${t}`, kind: 'command', title: PRODUCT_TYPE_LABEL[t],
          ...(readProductType(liveScope(id)?.specifications ?? {}) === t ? { detail: 'current' } : {}),
          run: async () => {
            const sc = liveScope(id)
            if (sc === undefined) return
            // The product decides what it is measured as; a custom assembly is asked.
            await saveScope({ ...sc, scopeType: scopeTypeForProduct(t) ?? sc.scopeType, specifications: writeProductType(sc.specifications, t) })
            if (after.then === 'counts' && t === 'custom_assembly') return { next: countsCommand(id, { then: 'configure' }), chip: PRODUCT_TYPE_LABEL[t] }
            if (after.then === 'counts' || after.then === 'configure') return { next: configureCommand(id), chip: PRODUCT_TYPE_LABEL[t] }
          },
        })).concat((['count', 'linear'] as const).map((measure): Command => {
          // Count and Length: products of their own (Kenneth, 2026-11-26).
          const title = measure === 'count' ? 'Count' : 'Length'
          const sc0 = liveScope(id)
          return {
            id: `product-measure-${measure}`, kind: 'command', title,
            ...(sc0 !== undefined && scopeProductLabel(sc0) === title ? { detail: 'current' } : {}),
            run: async () => {
              const sc = liveScope(id)
              if (sc === undefined) return
              await saveScope({ ...sc, scopeType: measure, specifications: writeProductType(sc.specifications, 'custom_assembly') })
              if (after.then === 'counts' || after.then === 'configure') return { next: configureCommand(id), chip: title }
            },
          }
        })),
      },
    })
    const countsCommand = (id: string, after: { then?: 'configure' }): Command => ({
      id: `set-counts-${id}`, kind: 'command', title: 'Set what it counts',
      step: {
        kind: 'choose', label: 'Counts', note: `what ${liveScope(id)?.label ?? 'the scope'} measures`,
        options: () => (['area', 'linear', 'count'] as const).map((t): Command => ({
          id: `counts-${t}`, kind: 'command', title: SCOPE_TYPE_LABEL[t],
          ...(liveScope(id)?.scopeType === t ? { detail: 'current' } : {}),
          run: async () => {
            const sc = liveScope(id)
            if (sc === undefined) return
            await saveScope({ ...sc, scopeType: t })
            if (after.then === 'configure') return { next: configureCommand(id), chip: SCOPE_TYPE_LABEL[t] }
          },
        })),
      },
    })
    /** Any way of writing a length; a bare number keeps the unit given. Same reader as the Setup page. */
    const parseMeasure = (text: string, fallbackUnit: string): { value: string; unit: string } | null => {
      const p = parseLengthInput(text, isLengthUnit(fallbackUnit) ? fallbackUnit : 'in')
      return p === null ? null : { value: formatMeasureValue(p.value), unit: p.unit }
    }
    const lengthDenominator = Number(prefs['takeoff.imperialPrecision'] ?? 16)
    const showLength = (value: string, unit: string): string => {
      const n = parseNumberOrFraction(value)
      return n === null ? `${value} ${unit}` : formatLength(n, unit, lengthDenominator)
    }
    /** The "what do you want to set" step: product, counts, then every measure the product has. Comes back after each. */
    const configureCommand = (id: string): Command => ({
      id: `configure-${id}`, kind: 'command', title: 'Configure',
      step: {
        kind: 'choose', label: 'Configure', note: `${liveScope(id)?.label ?? 'the scope'} — pick a setting; Esc when done`,
        options: () => {
          const sc = liveScope(id)
          if (sc === undefined) return []
          const product = readProductType(sc.specifications)
          const measures = editableMeasures(product).map((f): Command => {
            const current = readString(sc.specifications, f.valueKey) ?? ''
            const unit = unitDisplayText(readString(sc.specifications, f.unitKey) ?? '')
            const required = missingRequiredMeasures(product, sc.specifications).includes(f.label)
            return {
              id: `measure-${f.valueKey}`, kind: 'command', title: f.label,
              detail: current === '' ? (required ? 'required · not set' : `${measureHelp(f.valueKey)} · not set`) : `${showLength(current, unit)} · ${measureHelp(f.valueKey)}`,
              keywords: [measureHelp(f.valueKey), 'measure', 'dimension'],
              step: {
                kind: 'text', label: f.label, placeholder: `${measureHelp(f.valueKey)} — 4', 48\", 5' 6 1/2\", 1.2 m`,
                initial: current === '' ? '' : showLength(current, unit),
                rule: `a length: 10', 120\", 10 ft, 3 m; a bare number is ${isLengthUnit(unit) ? unit : 'in'}`,
                validate: (t) => (parseMeasure(t, unit) === null ? 'a length, written any of those ways' : null),
                describe: (t) => { const p = parseMeasure(t, unit); return p === null ? `Set ${f.label}` : `Set ${f.label} to ${showLength(p.value, p.unit)}` },
                run: async (t) => {
                  const p = parseMeasure(t, unit)
                  const live = liveScope(id)
                  if (p === null || live === undefined) return
                  await saveScope({ ...live, specifications: { ...live.specifications, [f.valueKey]: p.value, [f.unitKey]: p.unit } })
                  return { next: configureCommand(id), chip: `${f.label} ${showLength(p.value, p.unit)}` }
                },
              },
            }
          })
          return [
            { ...productCommand(id, { then: 'configure' }), id: 'cfg-product', title: 'Product', detail: PRODUCT_TYPE_LABEL[product], keywords: ['type', 'system'] },
            // Asked only of a custom assembly; every other product answers it.
            ...(product === 'custom_assembly'
              ? [{ ...countsCommand(id, { then: 'configure' }), id: 'cfg-counts', title: 'Measured as', detail: SCOPE_TYPE_LABEL[sc.scopeType], keywords: ['measure kind', 'counts'] }]
              : []),
            ...measures,
            {
              id: 'cfg-seams', kind: 'command', title: 'Seams', detail: alignSeamsOf(sc.specifications) ? 'aligned' : 'free', keywords: ['align', 'joints'],
              run: async () => {
                const live = liveScope(id)
                if (live === undefined) return
                const on = !readBool(live.specifications, 'alignSeams')
                await saveScope({ ...live, specifications: { ...live.specifications, alignSeams: String(on) } })
                return { next: configureCommand(id), chip: on ? 'Seams aligned' : 'Seams free' }
              },
            },
            { ...renameCommand(id), id: 'cfg-rename', title: 'Name', detail: sc.label },
            { id: 'cfg-open', kind: 'command', title: 'Open the scope page', detail: 'everything else, with the drawing', run: () => { setOpenScopeId(id); setWorkOpen(true) } },
          ]
        },
      },
    })
    /**
     * Archive, not delete, and no confirmation: the register's rule is that a
     * destructive verb either is refused by the store with a reason, or is
     * reversible and its row says so. This one is reversible — `restore-scope`
     * brings the scope and every markup on it back into the round.
     */
    const removeCommand = (id: string): Command => ({
      id: `remove-${id}`, kind: 'command', title: `Archive ${liveScope(id)?.label ?? 'scope'}`,
      detail: `its ${markupCounts[id] ?? 0} markup${(markupCounts[id] ?? 0) === 1 ? '' : 's'} stay and come back if you restore it`,
      run: () => { if (openRound !== undefined) void removeScopeBy(openRound.id, id) },
    })

    /* ---- everything else the prompt can do to a scope, without leaving it ---- */

    /** The scope's colour, from the palette the shell draws scopes in. */
    const colourCommand = (id: string): Command => ({
      id: `colour-${id}`, kind: 'command', title: 'Colour…', detail: liveScope(id)?.color ?? '',
      keywords: ['color', 'swatch'],
      step: {
        kind: 'choose', label: 'Colour', note: `for ${liveScope(id)?.label ?? 'the scope'}`,
        options: () => SCOPE_PALETTE.map((c, i): Command => ({
          id: `colour-${id}-${i}`, kind: 'command', title: `Colour ${i + 1}`, detail: c,
          ...(liveScope(id)?.color.toLowerCase() === c ? { detail: `${c} · current` } : {}),
          run: async () => { const sc = liveScope(id); if (sc !== undefined) await saveScope({ ...sc, color: c }) },
        })),
      },
    })

    /** The areas of a scope on the open sheet, for the edge step. */
    const areasOnSheet = (id: string): Markup[] =>
      projectMarkups.filter((m) => m.scopeId === id && m.kind === 'area' && m.pageId === pageIdFor(docIdRef.current, pageIndexRef.current))
    const edgeDetail = (a: { x: number; y: number }, b: { x: number; y: number }): string => {
      const dx = (b.x - a.x) * page.width, dy = (b.y - a.y) * page.height
      const points = Math.hypot(dx, dy)
      const angle = Math.round(((Math.atan2(-dy, dx) * 180) / Math.PI + 360) % 180)
      return `${cal === null ? `${Math.round(points)} pt` : formatLength(points * cal.feetPerPoint, 'ft', lengthDenominator)} · ${angle}°`
    }
    /**
     * The pattern direction from an edge of one of the scope's areas, chosen
     * in the prompt: area, then edge. It was reachable from the drawing's
     * right-click menu only.
     */
    const edgeDirectionCommand = (id: string): Command => ({
      id: `edge-dir-${id}`, kind: 'command', title: 'Direction from an edge…',
      detail: 'run the pattern along an edge of one of its areas on this sheet',
      keywords: ['orientation', 'pattern', 'edge'],
      ...stuck(noSheet ?? (areasOnSheet(id).length === 0 ? 'no area of this scope on this sheet' : undefined)),
      step: {
        kind: 'choose', label: 'Direction from an edge', note: 'which area',
        options: () => areasOnSheet(id).map((m, i): Command => ({
          id: `edge-area-${m.id}`, kind: 'command', title: `Area ${i + 1}`,
          detail: `${m.rings[0]?.length ?? 0} edges · ${cal === null ? 'no scale' : `${areaSquareFeet([m], cal).toFixed(1)} SF`}`,
          step: {
            kind: 'choose', label: `Area ${i + 1}`, note: 'which edge; the pattern runs along it',
            options: () => (m.rings[0] ?? []).map((a, k, ring): Command => ({
              id: `edge-${m.id}-${k}`, kind: 'command', title: `Edge ${k + 1}`, detail: edgeDetail(a, ring[(k + 1) % ring.length]!),
              run: () => void directionFromEdge(m, k),
            })),
          },
        })),
      },
    })

    /**
     * A scope's markups as rows: Enter goes to one and selects it; each also
     * offers a move to another scope and a delete. Every sheet of every
     * document, as the Markups page lists them.
     */
    const markupsCommand = (id: string): Command => {
      const rows = markupRowsFor(id)
      return {
        id: `markups-${id}`, kind: 'command', title: 'Markups…',
        detail: (() => {
          const sheets = new Set(rows.map((r) => `${r.documentId}#${r.page}`)).size
          return `${rows.length} on ${sheets} sheet${sheets === 1 ? '' : 's'}`
        })(),
        keywords: ['shapes', 'areas', 'list'],
        ...stuck(rows.length === 0 ? 'nothing drawn in this scope yet' : undefined),
        step: {
          kind: 'choose', label: 'Markups', note: `of ${liveScope(id)?.label ?? 'the scope'}`,
          options: () => rows.map((r): Command => ({
            id: `markup-${r.id}`, kind: 'command', title: `${r.kind} · ${r.measure}`,
            detail: `${r.inOpenDocument ? sheetLabelFor(r.page) : `${r.documentName} p${r.page + 1}`}${r.layoutNote !== undefined ? ` · ${r.layoutNote}` : ''}`,
            keywords: [r.kind, r.documentName],
            alt: { label: 'Go to it', run: () => { goToMarkup(r); setSelectedIds([r.id]); selectedRef.current = [r.id] } },
            step: {
              kind: 'choose', label: `${r.kind} ${r.measure}`, note: 'what to do with it',
              options: () => [
                { id: `markup-${r.id}-go`, kind: 'command', title: 'Go to it', detail: 'on its sheet, selected', run: () => { goToMarkup(r); setSelectedIds([r.id]); selectedRef.current = [r.id] } },
                {
                  id: `markup-${r.id}-move`, kind: 'command', title: 'Move to another scope…',
                  step: {
                    kind: 'choose', label: 'Move to', note: 'which scope',
                    options: () => estimateScopes.filter((sc) => sc.id !== id).map((sc): Command => ({
                      id: `markup-${r.id}-move-${sc.id}`, kind: 'scope', title: sc.label, detail: scopeProductLabel(sc),
                      run: () => { setSelectedIds([r.id]); selectedRef.current = [r.id]; void reassignSelection(sc.id) },
                    })),
                  },
                },
                { id: `markup-${r.id}-delete`, kind: 'command', title: 'Delete', detail: 'undoable', run: () => void removeMarkups([r.id]) },
              ],
            },
          })),
        },
      }
    }

    /** The parts and quantities of a scope, read in the prompt. */
    const partsCommand = (id: string): Command => ({
      id: `parts-${id}`, kind: 'command', title: 'Parts and quantities…', keywords: ['bom', 'bill', 'order', 'quantities'],
      detail: (() => { const r = pieces.find((x) => x.scope.id === id)?.result; return r === undefined ? 'nothing measured yet' : r.blockers.length > 0 ? `needs ${r.blockers[0]}` : `${r.quantities.length} line${r.quantities.length === 1 ? '' : 's'}` })(),
      step: {
        kind: 'choose', label: 'Parts', note: `of ${liveScope(id)?.label ?? 'the scope'}`,
        options: () => {
          const r = pieces.find((x) => x.scope.id === id)?.result
          const lines: Command[] = r === undefined ? []
            : r.blockers.length > 0
              ? [{ id: `parts-${id}-blocked`, kind: 'command', title: `Needs ${r.blockers.join(', ')}`, detail: 'nothing is counted in its place', unavailable: 'set it in Configure' }]
              : r.quantities.map((q): Command => ({ id: `parts-${id}-${q.itemKey}`, kind: 'command', title: q.label, detail: `${q.quantity.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${q.unit}`, unavailable: 'a reading' }))
          return [
            ...lines,
            { id: `parts-${id}-open`, kind: 'command', title: 'Open the Parts page', detail: 'in the estimates pane, with the drawing', run: () => { setActiveScope(id); setOpenScopeId(id); openParts() } },
          ]
        },
      },
    })

    /** Everything the prompt can do to one scope. Enter on a scope row opens this. */
    const scopeHub = (sc: Scope): Step => ({
      kind: 'choose', label: sc.label, note: `${scopeProductLabel(sc)} · ${markupCounts[sc.id] ?? 0} markup${(markupCounts[sc.id] ?? 0) === 1 ? '' : 's'}${sc.id === shownScopeId ? ' · open in the sidebar' : ''}`,
      options: () => [
        {
          // Drawing needs a sheet, not a scale: the sidebar's own Take off
          // button draws on an uncalibrated sheet and measures it "—", and
          // the prompt must not be stricter than the button.
          id: `hub-${sc.id}-takeoff`, kind: 'command', title: 'Take off',
          detail: `${firstToolFor(sc.id)} tool, drawing into ${sc.label}${noScale !== undefined ? ' · the sheet has no scale yet' : ''}`,
          ...stuck(noSheet), run: () => { setActiveScope(sc.id); beginTakeoff(true); setTool(firstToolFor(sc.id)) },
        },
        { ...configureCommand(sc.id), title: 'Configure…', detail: 'product, each measure, yield, seams' },
        { ...productCommand(sc.id, { then: 'configure' }), title: 'Set product…', detail: scopeProductLabel(sc) },
        ...(readProductType(sc.specifications) === 'custom_assembly' ? [{ ...countsCommand(sc.id, { then: 'configure' }), title: 'Measured as…', detail: SCOPE_TYPE_LABEL[sc.scopeType] }] : []),
        colourCommand(sc.id),
        edgeDirectionCommand(sc.id),
        { id: `hub-${sc.id}-direction`, kind: 'command', title: 'Set direction on the sheet', detail: 'drawn as an arrow', ...stuck(noSheet), run: () => { setActiveScope(sc.id); setTakeoff(true); setTool('direction') } },
        markupsCommand(sc.id),
        partsCommand(sc.id),
        { ...renameCommand(sc.id), title: 'Rename…' },
        { id: `hub-${sc.id}-duplicate`, kind: 'command', title: 'Duplicate', detail: 'the specification, not the takeoff', run: () => void duplicateScope(sc.id) },
        { ...removeCommand(sc.id), title: 'Archive' },
        { id: `hub-${sc.id}-open`, kind: 'command', title: 'Open in the sidebar', detail: 'the scope page beside the drawing', run: () => { setActiveScope(sc.id); setOpenScopeId(sc.id); setWorkOpen(true) } },
      ],
    })
    /** A take-off row that first asks which scope, when none is open. */
    const takeOffCommand = (sc: Scope): Command => ({
      id: `takeoff-in-${sc.id}`, kind: 'command', title: `Take off in ${sc.label}`,
      run: () => { setActiveScope(sc.id); beginTakeoff(true); setTool(firstToolFor(sc.id)) },
    })

    /** Search in the prompt: the words, then the hits as rows; Enter goes to one. */
    const searchCommand = (reach: SearchScope, id: string, title: string, detail: string): Command => ({
      id, kind: 'command', title, detail, keywords: ['find', 'text', 'search', 'words'],
      ...stuck(reach === 'project' ? undefined : noSheet),
      step: {
        kind: 'text', label: title.replace(/…$/, ''), placeholder: 'words on the sheets — a tag, a note, a room name',
        rule: 'at least two characters',
        validate: (t) => (t.trim().length < 2 ? 'two characters at least' : null),
        describe: (t) => `Find “${t.trim()}”`,
        run: async (t) => {
          // Every hit, page after page: the list has no ceiling.
          let report = await runSearch(t.trim(), reach)
          while (report.truncated) {
            const more = await runSearch(t.trim(), reach, report.hits.length)
            report = { ...report, hits: [...report.hits, ...more.hits], truncated: more.truncated && more.hits.length > 0 }
          }
          const n = report.hits.length
          if (n === 0) {
            const coverage = report.totalPageCount > 0 ? Math.round((report.indexedPageCount / report.totalPageCount) * 100) : 0
            return `no matches for “${t.trim()}”${coverage < 100 ? ` · ${coverage}% of pages indexed so far` : ''}`
          }
          return {
            chip: `“${t.trim()}”`,
            next: {
              id: `${id}-results`, kind: 'command', title: 'Results',
              step: {
                kind: 'choose', label: `${n}${report.truncated ? '+' : ''} match${n === 1 ? '' : 'es'}`, note: 'Enter goes to one',
                options: () => report.hits.map((h): Command => ({
                  id: `hit-${h.pageId}`, kind: 'page', title: h.snippet.length > 90 ? `${h.snippet.slice(0, 90)}…` : h.snippet,
                  detail: `${h.relativePath.split('/').pop() ?? h.relativePath} · p${h.pageNumber + 1}`,
                  run: () => goToHit(h),
                })),
              },
            },
          }
        },
      },
    })

    /** Convert the PDF's own markups on this sheet into a chosen scope. */
    const convertCommand: Command = {
      id: 'convert-annotations', kind: 'command', title: "Convert the PDF's markups on this sheet…",
      detail: 'polygons and squares become areas, lines lengths, the rest highlights',
      keywords: ['bluebeam', 'annotation', 'import', 'convert', 'markups'], ...stuck(noSheet ?? noRound),
      step: pickScope('Convert into', (sc) => ({
        id: `convert-into-${sc.id}`, kind: 'command', title: sc.label,
        step: {
          kind: 'choose', label: sc.label, note: 'which of the PDF\'s markups',
          options: () => [
            { id: `convert-all-${sc.id}`, kind: 'command', title: 'Every markup on this sheet', detail: 'one undo step', run: () => void convertSheetAnnotations(sc.id) },
            {
              id: `convert-selected-${sc.id}`, kind: 'command',
              title: selectedAnnots.length === 0 ? 'The ones selected on the sheet' : `The ${selectedAnnots.length} selected on the sheet`,
              detail: 'Select tool: click one, Ctrl+click for more, or drag a box around several',
              ...stuck(selectedAnnots.length === 0 ? 'none selected' : undefined),
              run: () => void convertAnnotations(annotsRef.current.filter((a) => selectedAnnots.includes(a.index)), sc.id),
            },
          ],
        },
      })),
    }

    const scopeNameRule = (text: string): string | null =>
      text.trim() === '' ? 'a scope needs a name'
        : nameTaken(text, scopes.filter((s) => s.id !== shown?.id).map((s) => s.label)) ? 'a scope with that name already exists' : null
    const docNames = documents.map((d) => d.displayName || d.relativePath)
    const inContext = (relativePath?: string) => () => { void openContextWindow(identity.projectId ?? projectPath, relativePath) }

    const duplicateRound: Command = {
      id: 'duplicate-round', kind: 'command', title: 'Duplicate round…', detail: 'Scopes and markups copied; commits are not',
      keywords: ['estimate', 'copy'], ...stuck(noRound),
      step: {
        kind: 'text', label: 'Duplicate round', placeholder: 'Name the copy',
        initial: openRound === undefined ? '' : `${openRound.name} copy`, rule: 'must be unique', validate: roundNameRule,
        describe: (t) => `Duplicate as “${t.trim()}”`,
        run: (t) => { if (openRound !== undefined) void duplicateEstimate(openRound.id, t.trim()) },
      },
    }
    const out: Command[] = [
      /* ---- the view ---- */
      { id: 'fit-page', kind: 'command', title: 'Fit sheet', shortcut: 'Ctrl+0', keywords: ['zoom'], ...stuck(noSheet), run: () => applyFit('page') },
      { id: 'fit-width', kind: 'command', title: 'Fit width', shortcut: 'Ctrl+1', keywords: ['zoom'], ...stuck(noSheet), run: () => applyFit('width') },
      { id: 'title-block-names', kind: 'command', title: 'Name sheets from the title block', keywords: ['sheet', 'names', 'page labels', 'drawing number', 'title block', 'rename'], ...stuck(noSheet), run: () => openTitlePick() },
      { id: 'zoom-box', kind: 'command', title: 'Zoom to a box', shortcut: 'Z', keywords: ['zoom', 'marquee', 'window', 'area'], ...stuck(noSheet), run: () => armZoomBox() },
      {
        id: 'history-back', kind: 'command', title: 'Back', shortcut: 'Alt+Left', keywords: ['previous view', 'return', 'history', 'last sheet'],
        ...stuck(historyRef.current.canGoBack() ? undefined : 'nothing to go back to'), stay: true, run: () => stepHistory(-1),
      },
      {
        id: 'history-forward', kind: 'command', title: 'Forward', shortcut: 'Alt+Right', keywords: ['next view', 'history'],
        ...stuck(historyRef.current.canGoForward() ? undefined : 'nothing to go forward to'), stay: true, run: () => stepHistory(1),
      },
      { id: 'rotate-cw', kind: 'command', title: 'Rotate sheet clockwise', keywords: ['rotate', 'turn', 'orientation', 'landscape', 'portrait'], ...stuck(noSheet), run: () => { void rotateSheet(1) } },
      { id: 'rotate-ccw', kind: 'command', title: 'Rotate sheet counterclockwise', keywords: ['rotate', 'turn', 'orientation', 'landscape', 'portrait'], ...stuck(noSheet), run: () => { void rotateSheet(-1) } },
      {
        id: 'toggle-embedded-markups', kind: 'command',
        title: embeddedHidden ? 'Show the PDF\u2019s own markups' : 'Hide the PDF\u2019s own markups',
        detail: 'Markups saved in the PDF, from Bluebeam or anyone else. Nothing is changed in the file',
        keywords: ['hide', 'show', 'markups', 'annotations', 'bluebeam', 'embedded', 'clean', 'clear', 'declutter'],
        ...stuck(noSheet), run: () => { setMarkupVisibility({ embedded: embeddedHidden }) },
      },
      {
        id: 'toggle-redbeam-markups', kind: 'command',
        title: redbeamHidden ? 'Show REDBEAM markups' : 'Hide REDBEAM markups',
        detail: 'Your takeoff, dimensions and layout drawn over the sheet. The takeoff is kept',
        keywords: ['hide', 'show', 'markups', 'takeoff', 'overlay', 'clean', 'clear', 'declutter'],
        ...stuck(noSheet), run: () => { setMarkupVisibility({ redbeam: redbeamHidden }) },
      },
      {
        id: 'toggle-all-markups', kind: 'command',
        title: embeddedHidden && redbeamHidden ? 'Show all markups' : 'Hide all markups',
        detail: 'See the drawing on its own',
        keywords: ['hide', 'show', 'markups', 'annotations', 'clean', 'bare', 'declutter'],
        ...stuck(noSheet), run: () => {
          const on = embeddedHidden && redbeamHidden
          setMarkupVisibility({ embedded: on, redbeam: on })
        },
      },
      { id: 'select-text', kind: 'command', title: 'Select text', detail: 'Select tool: drag a box around the words, then Ctrl+C', shortcut: 'V', keywords: ['copy text', 'text', 'clipboard'], ...stuck(noSheet), run: () => { setTool('select'); setStatus('drag a box around the words, then Ctrl+C') } },
      { id: 'link-tool', kind: 'command', title: 'Add a link', detail: 'drag a box over a callout, then pick its sheet', keywords: ['link', 'hyperlink', 'jump', 'callout', 'reference'], ...stuck(noSheet), run: () => setTool('link') },
      { id: 'link-callouts', kind: 'command', title: 'Link detail callouts', detail: 'find every reference to another sheet and choose which to link', keywords: ['link', 'batch link', 'callout', 'detail', 'section', 'hyperlink', 'auto link'], ...stuck(noSheet), run: () => void findCalloutLinksRef.current() },
      ...[50, 100, 200, 400].map((pct): Command => ({
        id: `zoom-${pct}`, kind: 'command', title: `Zoom to ${pct}%`, keywords: ['zoom', 'actual size'],
        whenTyped: true, ...stuck(noSheet), run: () => setZoom(pct / 100),
      })),
      {
        id: 'next-sheet', kind: 'command', title: 'Next sheet', shortcut: 'PgDn',
        ...(pageIndex + 1 < pageCount ? { detail: sheetLabelFor(pageIndex + 1), suggest: 'the next sheet' } : {}),
        keywords: ['page', 'forward'],
        ...stuck(noSheet ?? (pageIndex + 1 >= pageCount ? 'this is the last sheet' : undefined)),
        stay: true, run: () => goToPage(pageIndex + 1),
      },
      {
        id: 'prev-sheet', kind: 'command', title: 'Previous sheet', shortcut: 'PgUp',
        ...(pageIndex > 0 ? { detail: sheetLabelFor(pageIndex - 1) } : {}),
        keywords: ['page', 'back'],
        ...stuck(noSheet ?? (pageIndex === 0 ? 'this is the first sheet' : undefined)),
        stay: true, run: () => goToPage(pageIndex - 1),
      },
      {
        id: 'close-tab', kind: 'command', title: activeDoc === undefined ? 'Close tab' : `Close ${nameOf(activeDoc)}`,
        shortcut: 'Ctrl+W', keywords: ['tab', 'document'], ...stuck(noSheet),
        run: () => { if (activeDocId !== null) closeDocument(activeDocId) },
      },
      {
        id: 'close-other-tabs', kind: 'command', title: 'Close other tabs', detail: `${Math.max(0, openDocIds.length - 1)} other${openDocIds.length === 2 ? '' : 's'}`,
        keywords: ['tab', 'document'], ...stuck(openDocIds.length < 2 ? 'no other tabs' : undefined),
        run: () => { for (const id of openDocIds) if (id !== activeDocId) closeDocument(id) },
      },
      {
        id: 'reopen-tab', kind: 'command', title: 'Reopen closed tab', shortcut: 'Ctrl+Shift+T',
        detail: (() => { const id = closedTabsRef.current[closedTabsRef.current.length - 1]; const d = documents.find((x) => x.id === id); return d === undefined ? 'nothing closed yet' : nameOf(d) })(),
        keywords: ['tab', 'document', 'undo close'], ...stuck(closedTabsRef.current.length === 0 ? 'nothing closed this session' : undefined),
        run: () => { const id = closedTabsRef.current.pop(); if (id !== undefined) openDocument(id) },
      },
      ...(['files', 'contents', 'thumbnails', 'search'] as const).map((panel): Command => ({
        id: `pane-${panel}`, kind: 'command',
        title: railPanel === panel ? `Hide the ${panel} pane` : `Show the ${panel} pane`,
        keywords: ['sidebar', 'pane', 'rail', panel],
        run: () => setRailPanel(railPanel === panel ? null : panel),
      })),
      {
        id: 'pane-estimates', kind: 'command', title: workOpen ? 'Hide the estimates pane' : 'Show the estimates pane',
        keywords: ['sidebar', 'pane', 'estimates', 'scopes'], run: () => setWorkOpen(!workOpen),
      },
      searchCommand('project', 'search', 'Search the project…', 'the words, then the hits; Enter goes to one'),
      searchCommand('document', 'search-document', 'Search this document…', 'every sheet of the open document'),
      searchCommand('sheet', 'search-sheet', 'Search this sheet…', 'the open sheet only'),
      searchCommand('folder', 'search-folder', 'Search this folder…', 'the open document\'s folder'),
      { id: 'search-pane', kind: 'command', title: 'Open the search pane', shortcut: 'Ctrl+F', detail: 'the same search, kept open beside the drawing', keywords: ['find', 'text', 'pane'], run: openSearch },
      {
        id: 'refresh-files', kind: 'command', title: 'Refresh files', shortcut: 'F5',
        detail: 'Read the project folder again for drawings added since it was opened',
        keywords: ['rescan', 'folder', 'reload', 'files', 'documents'], run: () => void refreshFiles(),
      },
      { id: 'settings', kind: 'command', title: 'Settings', detail: 'Application preferences', keywords: ['preferences', 'options'], run: openSettings },
      reportCommand,
      {
        id: 'whats-new', kind: 'command', title: 'What’s new', icon: Sparkles,
        detail: `The changes in REDBEAM ${APP_VERSION} and the releases before it`,
        keywords: ['release notes', 'changelog', 'changes', 'update', 'version', 'new', 'features'],
        run: openWhatsNew,
      },
      {
        id: 'report-bug-form', kind: 'command', title: 'Report a bug with a picture…', icon: Bug,
        detail: 'The full form: details, a capture of the drawing, or a pasted screenshot',
        keywords: ['bug', 'feedback', 'screenshot', 'problem', 'issue', 'support'],
        run: () => openReport(),
      },
      {
        id: 'context-window', kind: 'command', title: 'New context window', detail: 'A second view on this project',
        keywords: ['window', 'second'], run: inContext(activeDoc?.relativePath),
      },
      { id: 'close-project', kind: 'command', title: 'Close project', detail: 'Back to the start page', keywords: ['exit', 'start'], run: closeProjectSavingTakeoff },
      {
        id: 'set-project-aside', kind: 'command', title: 'Set this project’s REDBEAM data aside',
        detail: 'Moves redbeam.db into .redbeam/removed. The drawings stay, and the takeoff can be put back.',
        keywords: ['delete', 'remove', 'project', 'archive'],
        ...stuck(projectBridge.desktop ? undefined : 'the browser build keeps its data in this tab'),
        run: () => setAsideAsk(true),
      },
      {
        id: 'hide-pdf-markups', kind: 'command', title: 'Hide PDF markups on this sheet',
        detail: 'Bluebeam and other annotations stay in the file. This view stops drawing them.',
        keywords: ['bluebeam', 'annotation', 'hide', 'markup'],
        ...stuck(noSheet),
        run: () => hidePdfMarkups('all'),
      },
      {
        id: 'undo', kind: 'command', title: undoState.undoLabel === null ? 'Undo' : `Undo ${undoState.undoLabel}`,
        shortcut: 'Ctrl+Z', ...stuck(undoState.canUndo ? undefined : 'nothing to undo'), stay: true, run: () => void doUndo(),
      },
      {
        id: 'redo', kind: 'command', title: undoState.redoLabel === null ? 'Redo' : `Redo ${undoState.redoLabel}`,
        shortcut: 'Ctrl+Y', ...stuck(undoState.canRedo ? undefined : 'nothing to redo'), stay: true, run: () => void doRedo(),
      },

      /* ---- scale ---- */
      {
        id: 'calibrate', kind: 'command', title: 'Calibrate from the drawing',
        detail: 'Set this sheet’s scale from a known dimension',
        keywords: ['scale', 'measure'], ...stuck(noSheet), run: () => { setTakeoff(true); setTool('calibrate') },
      },
      {
        id: 'set-scale', kind: 'command', title: 'Set scale for this sheet…',
        detail: cal === null ? 'no scale yet' : `now ${scaleLabel(cal.feetPerPoint)}`,
        keywords: ['scale', 'preset', 'calibrate'], ...stuck(noSheet),
        ...(cal === null && noSheet === undefined && markupsOnThisPage > 0
          ? { suggest: `no scale yet · ${markupsOnThisPage} markup${markupsOnThisPage === 1 ? '' : 's'} count nothing` }
          : {}),
        step: {
          kind: 'choose', label: 'Set scale', note: `applies to ${sheetLabelFor(pageIndex)}`,
          options: () => SCALE_PRESETS.map((p): Command => ({
            id: `scale-${p.id}`, kind: 'command', title: p.label,
            ...(cal !== null && Math.abs(cal.feetPerPoint - feetPerPointForPreset(p)) < 1e-9 ? { detail: 'current' } : {}),
            run: () => applyPreset(p),
          })),
        },
      },
      {
        id: 'scale-all', kind: 'command', title: 'Apply this sheet’s scale to every sheet',
        detail: `${pageCount} sheets · ${scaledPages} already carry one`,
        keywords: ['scale', 'all', 'every', 'set'],
        ...stuck(noSheet ?? (cal === null ? 'no scale on this sheet' : undefined)),
        run: () => { if (cal !== null) void applyScaleToSelection(allPages, cal.feetPerPoint, 'palette: this sheet’s scale') },
      },
      {
        id: 'scale-range', kind: 'command', title: 'Set scale for a range of sheets…', detail: 'pick the series, then the preset',
        keywords: ['scale', 'series', 'range', 'sheets'],
        ...stuck(noSheet ?? (sheetGroups.every((g) => g.label === null) ? 'the set has no sheet series' : undefined)),
        step: {
          kind: 'choose', label: 'Set scale for a range', note: 'a series of sheets',
          options: () => sheetGroups.filter((g) => g.label !== null).map((g): Command => ({
            id: `range-${g.label}`, kind: 'command', title: g.label ?? '',
            detail: `${g.rows[0]?.number ?? ''} … ${g.rows[g.rows.length - 1]?.number ?? ''} · ${g.rows.length} sheets`,
            step: {
              kind: 'choose', label: `${g.label} · ${g.rows.length} sheets`, note: `applies to all ${g.rows.length}`,
              ...(g.rows.some((r) => scaleOfPage(r.page) !== null)
                ? { warn: 'Some of these sheets already carry a scale. Applying one replaces every one of them, and cannot be undone.' }
                : {}),
              options: () => SCALE_PRESETS.map((p): Command => {
                const carrying = g.rows.filter((r) => {
                  const s = scaleOfPage(r.page)
                  return s !== null && Math.abs(s - feetPerPointForPreset(p)) < 1e-9
                }).length
                return {
                  id: `range-${g.label}-${p.id}`, kind: 'command', title: p.label,
                  ...(carrying > 0 ? { detail: `${carrying} of the ${g.rows.length} carry this now` } : {}),
                  run: () => void applyScaleToSelection(g.rows.map((r) => r.page), feetPerPointForPreset(p), presetSource(p)),
                }
              }),
            },
          })),
        },
      },
      {
        id: 'scale-region', kind: 'command', title: 'Draw a scale region',
        detail: 'For a sheet that carries more than one scale — four details at four scales',
        keywords: ['scale', 'detail', 'region', 'multiple'], ...stuck(noSheet),
        run: () => { setTakeoff(true); setTool('scale-region') },
      },
      {
        id: 'remove-region', kind: 'command', title: 'Remove a scale region…',
        detail: `${regionsOnThisSheet.length} on this sheet`,
        keywords: ['scale', 'region', 'delete'],
        ...stuck(noSheet ?? (regionsOnThisSheet.length === 0 ? 'no regions on this sheet' : undefined)),
        step: {
          kind: 'choose', label: 'Remove region', note: 'undoable',
          options: () => regionsOnThisSheet.map((r): Command => ({
            id: `region-${r.id}`, kind: 'command', title: r.label, detail: scaleLabel(r.feetPerPoint),
            run: () => void removeRegion(r.id),
          })),
        },
      },

      /* ---- rounds ---- */
      {
        id: 'new-round', kind: 'command', title: 'New round…', detail: 'A bidding round: the estimate a takeoff lands in',
        keywords: ['estimate', 'create', 'add'],
        step: {
          kind: 'text', label: 'New round', placeholder: 'Name the round', rule: 'must be unique', validate: roundNameRule,
          describe: (t) => (t.trim() === '' ? 'Create a round' : `Create round “${t.trim()}”`),
          run: (t) => void createEstimate(t.trim()),
        },
      },
      {
        id: 'rename-round', kind: 'command', title: openRound === undefined ? 'Rename round…' : `Rename ${openRound.name}…`,
        keywords: ['estimate', 'name'], ...stuck(noRound),
        step: {
          kind: 'text', label: 'Rename round', placeholder: 'New name', initial: openRound?.name ?? '', rule: 'must be unique',
          validate: (t) => (t.trim() === openRound?.name ? 'that is its name now' : roundNameRule(t)),
          describe: (t) => `Rename to “${t.trim()}”`,
          run: (t) => { if (openRound !== undefined) void renameEstimateBy(openRound.id, t.trim()) },
        },
      },
      duplicateRound,
      {
        id: 'delete-round', kind: 'command', title: openRound === undefined ? 'Delete round' : `Delete ${openRound.name}`,
        // Not a confirmation: the row says what actually happens. A round that
        // holds the only copy of any markup is refused by the store, with the
        // reason and the nearest thing that works.
        detail: `its ${openRound?.scopeCount ?? 0} scope${openRound?.scopeCount === 1 ? '' : 's'} go to the archive · refused while it holds markups`,
        keywords: ['estimate', 'remove'], ...stuck(noRound),
        run: async () => {
          if (openRound === undefined) return undefined
          const why = await deleteEstimateBy(openRound.id)
          if (why === undefined) return undefined
          return { reason: why, alternative: duplicateRound }
        },
      },
      {
        id: 'export-estimate', kind: 'command', title: 'Export estimate…',
        detail: 'Check the names and scopes, then a branded PDF, a CSV or a TSV',
        keywords: ['export', 'estimate', 'pdf', 'csv', 'tsv', 'client'],
        ...stuck(noRound),
        run: () => { if (openRound !== undefined) openEstimateExport(openRound.id) },
      },
      {
        id: 'save-report', kind: 'command', title: 'Save report…', detail: 'The round’s parts and quantities as a file',
        keywords: ['export', 'estimate', 'bill', 'html'],
        ...stuck(noRound ?? (pieces.length === 0 ? 'nothing measured yet' : undefined)),
        run: () => {
          if (openRound === undefined) return
          void saveReportFile({ projectName, estimateName: openRound.name, bom: buildBom(pieces), documents: docNames })
            .then((o) => setStatus(saveOutcomeText(o, 'report')))
        },
      },
      {
        id: 'copy-bill', kind: 'command', title: 'Copy bill as TSV', detail: 'Pastes into a spreadsheet',
        keywords: ['export', 'clipboard', 'bill', 'excel'],
        ...stuck(noRound ?? (pieces.length === 0 ? 'nothing measured yet' : undefined)),
        run: async () => {
          if (await copyBillTsv(buildBom(pieces))) { setStatus('bill copied as TSV'); return undefined }
          return 'The clipboard refused the bill.'
        },
      },
      {
        id: 'save-takeoff', kind: 'command', title: 'Save takeoff into this drawing',
        detail: 'Bluebeam then shows each markup with its scope and quantity',
        keywords: ['bluebeam', 'embed', 'pdf', 'markup', 'revu'],
        ...stuck(noSheet ?? (activeDocId === null ? 'no drawing is open' : undefined)),
        run: async () => {
          if (activeDocId !== null) await saveTakeoffIntoDrawing(activeDocId)
          return undefined
        },
      },
      {
        id: 'save-marked', kind: 'command', title: 'Save marked-up PDF…', detail: 'This drawing with its markups burned in',
        keywords: ['export', 'pdf', 'markup'],
        ...stuck(noSheet ?? (markupsOnOpenDrawing === 0 ? 'no markups on this drawing' : undefined)),
        run: async () => {
          const err = await exportMarkedDrawing()
          if (err !== null) return err
          setStatus('marked-up PDF saved')
          return undefined
        },
      },

      /* ---- scopes ---- */
      /*
       * WHOLE WORKFLOWS, inside the palette. Aaron: "you should be able to do
       * complete CRUD workflows within the command palette without leaving
       * the command palette." So a scope is created, then asked its product,
       * then what it counts; configuring one picks the scope, then the
       * setting, then takes the value and comes back for the next setting;
       * deleting picks and confirms. Each command works on the OPEN scope
       * when there is one and otherwise starts by asking which — a command
       * that is stuck on "open a scope first" is a dialog by another name.
       */
      {
        id: 'add-scope', kind: 'command', title: 'Add scope…', ...(openRound === undefined ? {} : { detail: `to ${openRound.name}` }),
        keywords: ['scope-action', 'new', 'create'], ...stuck(noRound),
        step: {
          kind: 'text', label: 'Add scope', placeholder: 'Name the scope — CL03 Baffle Ceiling', rule: 'must be unique in the round', validate: scopeNameRule,
          describe: (t) => (t.trim() === '' ? 'Add a scope' : `Add scope “${t.trim()}” — then choose its product`),
          run: async (t) => {
            const label = t.trim()
            await createNamedScope(label)
            // The scope exists now; read it back rather than trusting a closure.
            const made = await scopeByLabel(label)
            if (made === null) return
            return { next: productCommand(made.id, { then: 'counts' }), chip: `Add ${label}` }
          },
        },
      },
      /*
       * EVERY scope action asks which scope, always, with the one open in the
       * sidebar listed first and marked. These used to skip the choice when a
       * scope was open, which read as the prompt refusing to edit any other
       * scope, and as "it's not letting me edit a scope" when the open one
       * was not the one meant. Aaron, 2026-09-11.
       */
      {
        id: 'configure-scope', kind: 'command', title: 'Configure scope…',
        detail: 'product, each measure, yield, seams, colour',
        keywords: ['scope-action', 'setup', 'measures', 'width', 'length', 'spacing', 'edit'], ...stuck(noRound),
        step: pickScope('Configure scope', (sc) => configureCommand(sc.id)),
      },
      {
        id: 'rename-scope', kind: 'command', title: 'Rename scope…',
        keywords: ['scope-action', 'name'], ...stuck(noRound),
        step: pickScope('Rename scope', (sc) => renameCommand(sc.id)),
      },
      {
        id: 'set-product', kind: 'command', title: 'Set product…',
        keywords: ['scope-action', 'type', 'ceiling', 'plank', 'panel'], ...stuck(noRound),
        step: pickScope('Set product', (sc) => productCommand(sc.id, {})),
      },
      {
        id: 'set-counts', kind: 'command', title: 'Set what a custom assembly is measured as…',
        detail: 'every other product answers this itself',
        keywords: ['scope-action', 'areas', 'lengths', 'counts', 'measure'], ...stuck(noRound),
        step: pickScope('Measured as', (sc) => countsCommand(sc.id, {})),
      },
      {
        id: 'scope-colour', kind: 'command', title: 'Set scope colour…',
        keywords: ['scope-action', 'color', 'colour', 'swatch'], ...stuck(noRound),
        step: pickScope('Scope colour', (sc) => colourCommand(sc.id)),
      },
      {
        id: 'scope-markups', kind: 'command', title: 'Markups of a scope…', detail: 'every sheet; go to one, move it, delete it',
        keywords: ['scope-action', 'list', 'shapes'], ...stuck(noRound),
        step: pickScope('Markups', (sc) => markupsCommand(sc.id)),
      },
      {
        id: 'direction-from-edge', kind: 'command', title: 'Direction from an edge…', detail: 'pick a scope, one of its areas, one of its edges',
        keywords: ['scope-action', 'orientation', 'pattern'], ...stuck(noRound ?? noSheet),
        step: pickScope('Direction from an edge', (sc) => edgeDirectionCommand(sc.id)),
      },
      {
        id: 'start-pattern', kind: 'command', title: 'Start the pattern here',
        detail: 'Right-click an area',
        keywords: ['origin', 'pattern', 'grid', 'panel'],
        run: () => setStatus('Right-click an area and choose Start the pattern here'),
      },
      {
        id: 'duplicate-scope', kind: 'command', title: 'Duplicate scope…',
        keywords: ['scope-action', 'copy'], ...stuck(noRound),
        step: pickScope('Duplicate scope', (sc) => ({ id: `dup-${sc.id}`, kind: 'command', title: sc.label, run: () => void duplicateScope(sc.id) })),
      },
      {
        id: 'remove-scope', kind: 'command', title: 'Remove scope from round…',
        // Reversible, so no confirmation: the row says what happens instead.
        detail: 'archived, not destroyed',
        keywords: ['scope-action', 'remove', 'delete', 'archive'], ...stuck(noRound),
        step: pickScope('Remove scope', (sc) => removeCommand(sc.id)),
      },
      {
        id: 'restore-scope', kind: 'command', title: 'Restore scope…',
        detail: `${archivedScopes.length} archived`,
        keywords: ['scope-action', 'archive', 'undelete'],
        ...stuck(noRound ?? (archivedScopes.length === 0 ? 'nothing archived' : undefined)),
        step: {
          kind: 'choose', label: 'Restore scope', note: `into ${openRound?.name ?? 'the round'}`,
          options: () => archivedScopes.map((sc): Command => ({
            id: `restore-${sc.id}`, kind: 'command', title: sc.label,
            detail: productLabelFor(sc.specifications),
            run: () => void restoreScope(sc.id),
          })),
        },
      },
      {
        // ALWAYS asks which scope (rule 3): the one open in the sidebar is
        // not necessarily the one meant, and "@cl04 take off" or the scope's
        // hub is the one-step form for a named scope.
        id: 'take-off', kind: 'command', title: 'Take off…',
        detail: `the drawing tool the scope is measured with${noScale !== undefined ? ' · the sheet has no scale yet' : ''}`, keywords: ['scope-action', 'takeoff', 'draw', 'measure'],
        ...stuck(noSheet ?? noRound),
        step: pickScope('Take off', takeOffCommand),
      },
      {
        id: 'leave-takeoff', kind: 'command', title: 'Leave takeoff', detail: 'Back to reading the sheet',
        keywords: ['stop', 'done', 'pan'], ...stuck(takeoff ? undefined : 'not in a takeoff'),
        run: () => beginTakeoff(false),
      },
      ...([
        ['area', 'Area tool', 'Trace a region'], ['polyline', 'Length tool', 'Trace a run'], ['count', 'Count tool', 'One click, one piece'],
        ['cutout', 'Cutout tool', 'Subtract from an area'], ['shape', 'Highlight tool', 'Mark a region; counts nothing'],
        ['dimension', 'Dimension tool', 'Measure and write it on the sheet'], ['pan', 'Pan tool', 'Read the sheet'],
        ['select', 'Select tool', 'Click a markup, or drag a box around several, or around words to copy them'],
        ['text', 'Text box', 'Drag a box, or click, then type'], ['cloud', 'Cloud', 'Drag a box, or click its corners'],
        ['callout', 'Cloud with leader', 'Draw the cloud, then click where the text goes'],
        ['arrow', 'Leader', 'Drag from what it points at to where the text goes'], ['line', 'Line', 'Drag from end to end'],
        ['rect', 'Rectangle', 'Drag a box'], ['ellipse', 'Ellipse', 'Drag its box'],
        ['polygon', 'Polygon', 'Click its corners, double-click to finish'], ['pen', 'Pen', 'Draw freehand'],
      ] as const).map(([t, label, detail]): Command => {
        const needsScope = t !== 'pan' && t !== 'select' && t !== 'dimension' && !isNoteTool(t)
        const base = {
          id: `tool-${t}`, kind: 'command' as const, title: label, detail: tool === t ? `${detail} · current` : detail,
          keywords: ['tool', 'draw'], ...stuck(noSheet),
        }
        // A drawing tool with no scope to draw into ASKS which, here, rather
        // than refusing until one is opened in the sidebar.
        if (needsScope && noScope !== undefined) {
          if (estimateScopes.length === 0) return { ...base, ...stuck(noRound ?? 'add a scope first') }
          return {
            ...base,
            step: pickScope(label, (sc) => ({
              id: `tool-${t}-in`, kind: 'command', title: label,
              run: () => { setActiveScope(sc.id); beginTakeoff(true); setTool(t) },
            })),
          }
        }
        return { ...base, run: () => { if (needsScope && !takeoff) beginTakeoff(true); setTool(t) } }
      }),
      convertCommand,
      {
        id: 'set-direction', kind: 'command', title: 'Set direction on the sheet…', detail: 'The way planks run, drawn as an arrow',
        keywords: ['scope-action', 'plank', 'orientation'], ...stuck(noSheet ?? noRound),
        step: pickScope('Set direction', (sc) => ({
          id: `direction-in-${sc.id}`, kind: 'command', title: `Direction for ${sc.label}`,
          run: () => { setActiveScope(sc.id); setTakeoff(true); setTool('direction') },
        })),
      },
      /* ---- markups ---- */
      {
        id: 'move-markup', kind: 'command', title: 'Move selected markup to…',
        detail: `${selectedIds.length} selected`, keywords: ['scope-action', 'reassign', 'rescope', 'selection'],
        ...stuck(selectedIds.length === 0 ? 'nothing selected' : undefined),
        step: {
          kind: 'choose', label: 'Move to', note: `${selectedIds.length} markup${selectedIds.length === 1 ? '' : 's'}`,
          options: () => [
            ...estimateScopes.map((sc): Command => ({
              id: `move-${sc.id}`, kind: 'scope', title: sc.label, detail: scopeProductLabel(sc),
              run: () => void reassignSelection(sc.id),
            })),
            { id: 'move-none', kind: 'command', title: 'No scope', detail: 'Kept on the sheet, counted nowhere', run: () => void reassignSelection(null) },
          ],
        },
      },
      {
        id: 'accept-imported', kind: 'command', title: 'Accept imported markups…',
        detail: 'Bluebeam markups from the PDF count once accepted',
        keywords: ['bluebeam', 'pending', 'import', 'accept', 'review', 'approve'],
        step: {
          kind: 'choose', label: 'Accept',
          options: () => {
            const acceptStatus = (n: number) => setStatus(n === 0
              ? 'no imported markups waiting there'
              : `${n} imported markup${n === 1 ? '' : 's'} accepted into the takeoff`)
            const pendingHere = (where: 'selected' | 'sheet' | 'drawing') => {
              const pending = pendingIdsRef.current
              if (where === 'selected') return selectedRef.current.filter((id) => pending.has(id))
              if (where === 'sheet') return markupsRef.current.filter((m) => pending.has(m.id)).map((m) => m.id)
              return [...pending]
            }
            return [
              { id: 'accept-selected', kind: 'command', title: 'The selected markups', run: () => void acceptImported(pendingHere('selected')).then(acceptStatus) },
              { id: 'accept-sheet', kind: 'command', title: 'Every imported markup on this sheet', run: () => void acceptImported(pendingHere('sheet')).then(acceptStatus) },
              { id: 'accept-drawing', kind: 'command', title: 'Every imported markup in this PDF', run: () => void acceptImported(pendingHere('drawing')).then(acceptStatus) },
            ]
          },
        },
      },
      {
        id: 'copy-markup', kind: 'command', title: 'Copy selected markup', shortcut: 'Ctrl+C',
        detail: 'pastes onto any sheet, in this PDF or another open one', keywords: ['clipboard', 'selection', 'other pdf', 'tab'],
        ...stuck(selectedIds.length === 0 ? 'nothing selected' : undefined),
        run: () => copySelection(),
      },
      {
        id: 'paste-markup', kind: 'command', title: 'Paste markups', shortcut: 'Ctrl+V',
        detail: 'onto this sheet, with their scopes', keywords: ['clipboard', 'other pdf', 'tab', 'copy'],
        ...stuck(noSheet),
        run: () => void pasteClipboard(),
      },
      {
        id: 'duplicate-markup', kind: 'command', title: 'Duplicate selected markup', shortcut: 'Ctrl+D',
        detail: `${selectedIds.length} selected`, keywords: ['copy', 'clone', 'selection'],
        ...stuck(selectedIds.length === 0 ? 'nothing selected' : undefined),
        run: () => void duplicateMarkups(selectedRef.current),
      },
      {
        id: 'delete-markup', kind: 'command', title: 'Delete selected markup', shortcut: 'Del',
        detail: `${selectedIds.length} selected`, keywords: ['remove', 'selection'],
        ...stuck(selectedIds.length === 0 ? 'nothing selected' : undefined),
        run: () => void removeMarkups(selectedRef.current),
      },

      {
        id: 'quantities', kind: 'command', title: 'Parts and quantities…', detail: 'read here; open the page from the last row',
        keywords: ['bom', 'bill', 'order'], ...stuck(noRound),
        step: pickScope('Parts', (sc) => partsCommand(sc.id)),
      },
      {
        id: 'specs', kind: 'command', title: 'Scope setup…', detail: 'product, measures, yield, in the prompt',
        keywords: ['edit', 'specifications', 'setup'], ...stuck(noRound),
        step: pickScope('Scope setup', (sc) => configureCommand(sc.id)),
      },
    ]
    /*
     * Every setting, operable WITHOUT opening settings.
     *
     * The palette is the only permanent menu this app has, and typing
     * "scrollbars" to turn scrollbars on should not route through a full-screen
     * view and a search field inside it. A switch becomes one command that
     * flips it — and stays open, so five switches are five Enters; a choice
     * becomes one command per option, so "single page" is a thing you can type
     * rather than a thing you go and find. A number cannot be typed at a
     * palette, so it opens settings — the only case that does.
     */
    for (const d of SETTINGS) {
      const current = prefs[d.id]
      if (d.type === 'bool') {
        const on = current === true
        out.push({
          id: `set:${d.id}`,
          kind: 'command',
          title: `${on ? 'Turn off' : 'Turn on'} ${d.label.toLowerCase()}`,
          detail: `Settings · ${CATEGORY_LABEL[d.category]} · currently ${on ? 'on' : 'off'}`,
          keywords: ['setting', d.label, d.description],
          stay: true,
          run: () => { settings.set(d.id, !on); setStatus(`${d.label}: ${on ? 'off' : 'on'}`) },
        })
      } else if (d.type === 'enum') {
        for (const c of d.choices) {
          if (String(current) === c.value) continue
          out.push({
            id: `set:${d.id}:${c.value}`,
            kind: 'command',
            title: `${d.label}: ${c.label}`,
            detail: `Settings · ${CATEGORY_LABEL[d.category]}`,
            keywords: ['setting', d.label, c.label, d.description],
            stay: true,
            run: () => { settings.set(d.id, c.value); setStatus(`${d.label}: ${c.label}`) },
          })
        }
      } else {
        // A number is typed into the prompt, with its range stated. This used
        // to be "the only setting that opens Settings".
        out.push({
          id: `set:${d.id}`,
          kind: 'command',
          title: `${d.label}…`,
          detail: `Settings · ${CATEGORY_LABEL[d.category]} · currently ${String(current)}`,
          keywords: ['setting', d.description],
          alt: { label: 'Show in Settings', run: () => openSettings(d.id) },
          step: {
            kind: 'text', label: d.label, placeholder: `${d.min} to ${d.max}`, initial: String(current ?? d.default),
            rule: `a whole number from ${d.min} to ${d.max}`,
            validate: (t) => { const n = Number(t.trim()); return Number.isInteger(n) && n >= d.min && n <= d.max ? null : `a whole number from ${d.min} to ${d.max}` },
            describe: (t) => `Set ${d.label.toLowerCase()} to ${t.trim()}`,
            run: (t) => { const why = settings.set(d.id, Number(t.trim())); if (why !== null) return why; setStatus(`${d.label}: ${t.trim()}`) },
          },
        })
      }
    }
    // Shift+Enter on any setting row: the panel, on its page, at its card.
    for (const c of out) {
      if (c.id.startsWith('set:') && c.alt === undefined) {
        const id = c.id.slice(4).split(':')[0]!
        c.alt = { label: 'Show in Settings', run: () => openSettings(id) }
      }
    }
    out.push({
      id: 'settings-at', kind: 'command', title: 'Settings, at a setting…', detail: 'opens the panel on the setting\'s page, at its card',
      keywords: ['preferences', 'options', 'find setting'],
      step: {
        kind: 'choose', label: 'Settings', note: 'which setting',
        options: () => SETTINGS.map((d): Command => ({
          id: `settings-at-${d.id}`, kind: 'command', title: d.label, detail: `${CATEGORY_LABEL[d.category]} · ${d.section ?? ''}`,
          keywords: [d.description], run: () => openSettings(d.id),
        })),
      },
    })
    const modified = SETTINGS.filter((d) => settings.isModified(d.id)).length
    out.push({
      id: 'reset-settings', kind: 'command', title: 'Reset all settings', detail: `${modified} changed from default`,
      keywords: ['setting', 'defaults'], ...stuck(modified === 0 ? 'everything is at its default' : undefined),
      run: () => { settings.resetAll(); setStatus('settings reset') },
    })

    // The presets, typeable straight: "1/8" finds it without the step.
    for (const p of SCALE_PRESETS) {
      out.push({
        id: `scale-${p.id}`, kind: 'command', title: `Set scale ${p.label}`,
        keywords: ['scale', 'calibrate'], whenTyped: true, ...stuck(noSheet), run: () => applyPreset(p),
      })
    }
    for (const e of estimates) {
      const openIt = () => { setOpenScopeId(null); setOpenEstimateId(e.id); void refreshEstimates(e.id) }
      out.push({
        id: `est-${e.id}`, kind: 'estimate', title: e.name,
        detail: `${e.scopeCount} scope${e.scopeCount === 1 ? '' : 's'}${e.id === openEstimateId ? ' · open' : ''}`,
        // Enter lists what can be done to the round; Shift+Enter opens it.
        alt: { label: 'Open in the sidebar', run: openIt },
        step: {
          kind: 'choose', label: e.name, note: 'what to do with the round',
          options: () => [
            { id: `est-${e.id}-open`, kind: 'command', title: 'Open in the sidebar', detail: `${e.scopeCount} scope${e.scopeCount === 1 ? '' : 's'}`, run: openIt },
            {
              id: `est-${e.id}-rename`, kind: 'command', title: 'Rename…',
              step: {
                kind: 'text', label: 'Rename round', placeholder: 'New name', initial: e.name, rule: 'must be unique in the project',
                validate: (t) => (t.trim() === e.name ? 'that is its name now' : roundNameRule(t)),
                describe: (t) => `Rename to “${t.trim()}”`, run: (t) => void renameEstimateBy(e.id, t.trim()),
              },
            },
            {
              id: `est-${e.id}-duplicate`, kind: 'command', title: 'Duplicate…', detail: 'scopes and markups copied; commits are not',
              step: {
                kind: 'text', label: 'Duplicate round', placeholder: 'Name the copy', initial: `${e.name} copy`, rule: 'must be unique in the project',
                validate: roundNameRule, describe: (t) => `Copy ${e.name} as “${t.trim()}”`, run: (t) => void duplicateEstimate(e.id, t.trim()),
              },
            },
            {
              id: `est-${e.id}-delete`, kind: 'command', title: 'Delete', detail: 'the round and its scopes; markups stay on the sheets',
              step: {
                kind: 'choose', label: 'Delete round', note: e.name, warn: 'Not undoable.',
                options: () => [{ id: `est-${e.id}-delete-yes`, kind: 'command', title: `Delete ${e.name}`, run: async () => { const why = await deleteEstimateBy(e.id); return why } }],
              },
            },
          ],
        },
      })
    }
    for (const sc of estimateScopes) {
      const total = quantities.find((q) => q.scope.id === sc.id)?.rows[0]
      const n = markupCounts[sc.id] ?? 0
      out.push({
        id: `scope-${sc.id}`, kind: 'scope', title: sc.label, color: sc.color,
        detail: `${productLabelFor(sc.specifications)} · ${n} markup${n === 1 ? '' : 's'}${total === undefined ? '' : ` · ${total.quantity.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${total.unit}`}`,
        // Enter opens it; Tab lists everything that can be done to it (the prompt's actions).
        alt: { label: 'Open in the sidebar', run: () => { setActiveScope(sc.id); setOpenScopeId(sc.id); setWorkOpen(true) } },
        step: scopeHub(sc),
        ...(sc.id === shownScopeId ? { suggest: 'the active scope' } : {}),
      })
      // "@cl03 take off": the verb beside the noun, findable when typed; suggested for the active scope.
      out.push({
        id: `takeoff-${sc.id}`, kind: 'command', title: `Take off in ${sc.label}`,
        detail: `draw into ${sc.label}`, color: sc.color,
        keywords: ['scope-action', 'takeoff', sc.label], whenTyped: true, ...stuck(noSheet),
        ...(sc.id === shownScopeId && noSheet === undefined ? { suggest: 'the active scope' } : {}),
        run: () => { setActiveScope(sc.id); setOpenScopeId(sc.id); beginTakeoff(true); setTool(firstToolFor(sc.id)) },
      })
    }
    for (const d of documents) {
      out.push({
        id: `doc-${d.id}`, kind: 'document', title: nameOf(d), detail: d.relativePath,
        ...(d.missing ? { unavailable: 'file missing' } : {}),
        alt: { label: 'Open in a context window', run: inContext(d.relativePath) },
        run: () => openDocument(d.id),
      })
    }
    for (const g of sheetGroups) {
      for (const r of g.rows) {
        out.push({
          id: `page-${r.page}`, kind: 'page', title: r.number, page: r.page,
          ...(r.title === '' ? {} : { detail: r.title, keywords: [r.title] }),
          run: () => goToPage(r.page),
        })
      }
    }
    /*
     * Projects last, and after the sheets.
     *
     * The palette is mostly things you do INSIDE the open project; switching
     * to another one is a different order of action, so it sits at the bottom
     * rather than interleaved with commands that act on what is on screen.
     */
    out.push(...projectCommands({
      currentPath: projectPath,
      recents: recentProjects ?? [],
      ...(onOpenProject !== undefined ? { onOpen: onOpenProject } : {}),
      ...(onBrowseProject !== undefined ? { onBrowse: onBrowseProject } : {}),
      actions: {
        rename: async (path, name) => { await projectBridge.renameRecent(path, name); onRecentsChanged?.() },
        hide: async (path) => { await projectBridge.forgetRecent(path); onRecentsChanged?.() },
        ...(projectBridge.desktop ? {
          removeData: async (path) => { await projectBridge.removeProjectData(path); onRecentsChanged?.() },
          reveal: async (path) => { await projectBridge.revealProject(path) },
        } : {}),
        ...(onOpenProject !== undefined ? {
          create: async (path) => {
            try {
              const info = await projectBridge.openProject(path, { create: true })
              onRecentsChanged?.()
              onOpenProject(info.path)
            } catch (err) {
              return err instanceof Error ? err.message : String(err)
            }
          },
        } : {}),
      },
    }))
    if (!light) return out
    return lightCommands(out, [
      {
        id: 'light-open', kind: 'command', title: 'Open PDF…', shortcut: 'Ctrl+O',
        detail: lightTabs !== undefined ? 'In a new tab; this one stays open' : 'Saves this one first, then opens the other in this window',
        keywords: ['open', 'file', 'drawing', 'pdf', 'tab'], run: openAnotherFile,
      },
      ...(lightTabs === undefined ? [] : [
        {
          id: 'light-close-tab', kind: 'command' as const, title: 'Close this file', shortcut: 'Ctrl+W',
          detail: 'Saves its takeoff into the PDF first', keywords: ['close', 'tab', 'file'],
          run: () => lightTabs.onClose(quickView!.file),
        },
        {
          id: 'light-next-tab', kind: 'command' as const, title: 'Next tab', shortcut: 'Ctrl+Tab',
          keywords: ['tab', 'switch', 'file', 'next'], ...stuck(lightTabs.list.length < 2 ? 'only one file open' : undefined),
          run: () => lightTabs.onStep(1),
        },
        {
          id: 'light-prev-tab', kind: 'command' as const, title: 'Previous tab', shortcut: 'Ctrl+Shift+Tab',
          keywords: ['tab', 'switch', 'file', 'previous'], ...stuck(lightTabs.list.length < 2 ? 'only one file open' : undefined),
          run: () => lightTabs.onStep(-1),
        },
        {
          id: 'light-reopen-tab', kind: 'command' as const, title: 'Reopen closed file', shortcut: 'Ctrl+Shift+T',
          detail: 'The tab closed last', keywords: ['reopen', 'undo', 'close', 'tab', 'file'],
          run: lightTabs.onReopen,
        },
      ]),
      {
        id: 'light-save', kind: 'command', title: 'Save takeoff into this PDF', shortcut: 'Ctrl+S',
        detail: 'Scopes and markups travel inside the file; Bluebeam shows the markups',
        keywords: ['save', 'embed', 'file'], ...stuck(activeDocId === null ? 'no drawing open' : undefined), run: saveOpenFile,
      },
      {
        id: 'light-save-copy', kind: 'command', title: 'Save a copy with the takeoff…',
        detail: 'The PDF with its scopes and markups, saved wherever you choose',
        keywords: ['save', 'copy', 'as', 'export', 'file'], ...stuck(activeDocId === null ? 'no drawing open' : undefined),
        run: () => void saveCopyOfFile(),
      },
      {
        id: 'print-sheet', kind: 'command', title: 'Print this sheet', shortcut: 'Ctrl+P',
        detail: 'With the takeoff on it', keywords: ['print', 'plot', 'paper'], ...stuck(noSheet),
        run: () => { void printSheets([pageIndex]) },
      },
      {
        id: 'print-all', kind: 'command', title: 'Print all sheets', detail: `${pageCount} sheets, with the takeoff`,
        keywords: ['print', 'plot', 'paper', 'set'], ...stuck(noSheet),
        run: () => { void printSheets(Array.from({ length: pageCount }, (_, i) => i)) },
      },
      {
        id: 'print-range', kind: 'command', title: 'Print sheets…', detail: 'A range, like 1-5, 8',
        keywords: ['print', 'plot', 'paper', 'range', 'pages'], ...stuck(noSheet),
        step: {
          kind: 'text', label: 'Print sheets', placeholder: `1-${pageCount}, or 3, 7-9`,
          initial: String(pageIndex + 1), rule: `sheets 1 to ${pageCount}`,
          validate: (t) => { const r = parsePageRange(t, pageCount); return typeof r === 'string' ? r : null },
          describe: (t) => { const r = parsePageRange(t, pageCount); return typeof r === 'string' ? 'Print' : `Print ${printedWhat(r, pageCount, sheetLabelFor)}` },
          run: (t) => { const r = parsePageRange(t, pageCount); if (typeof r !== 'string') void printSheets(r) },
        },
      },
      {
        id: 'light-start-from', kind: 'command', title: 'Start from another PDF\u2019s takeoff…',
        detail: 'Its scopes and its markups, placed on the matching sheets',
        keywords: ['copy', 'import', 'takeoff', 'markups', 'scopes', 'revision', 'round', 'bid', 'previous', 'estimate'],
        ...stuck(activeDocId === null ? 'no drawing open' : undefined), run: () => void startFromPdf(),
      },
      {
        id: 'light-import-scopes', kind: 'command', title: 'Import scopes from another PDF…',
        detail: 'Last round’s scopes, without its markups',
        keywords: ['scopes', 'import', 'round', 'bid', 'copy', 'previous'], run: () => void importScopesFromPdf(),
      },
    ])
  }, [
    documents, activeDocId, estimates, openEstimateId, scopes, shownScopeId, estimateScopes,
    pageIndex, pageCount, sheetLabelFor, goToPage, closeDocument, railPanel, workOpen, embeddedHidden, redbeamHidden, setMarkupVisibility,
    openSearch, openSettings, openReport, refreshFiles, convertSheetAnnotations, closeProjectSavingTakeoff, saveTakeoffIntoDrawing, activeDocId, undoState, doUndo, doRedo, cal, applyPreset,
    regionsOnThisSheet, removeRegion, createEstimate, renameEstimateBy, duplicateEstimate,
    deleteEstimateBy, projectName, pieces, markupsOnOpenDrawing, exportMarkedDrawing,
    createNamedScope, saveScope, duplicateScope, removeScopeBy, archivedScopes, restoreScope,
    scaleOfPage, applyScaleToSelection, markupCounts,
    beginTakeoff, takeoff, tool, selectedIds, reassignSelection, acceptImported, removeMarkups, duplicateMarkups,
    openParts, prefs, settings, setZoom, openDocument, refreshEstimates,
    identity.projectId, projectPath, recentProjects, onOpenProject, onBrowseProject, onRecentsChanged,
    openEstimateExport, markupRowsFor, goToMarkup, directionFromEdge, startPatternHere, clearPatternOrigin,
    hidePdfMarkups, hidePdfMarkup, runSearch, goToHit, page.width, page.height,
    openDocIds, closeDocument, convertSheetAnnotations, convertAnnotations, selectedAnnots,
    quantities, projectMarkups,
    light, openAnotherFile, saveOpenFile, importScopesFromPdf, startFromPdf, saveCopyOfFile,
    paletteOpen, lightTabs, quickView,
  ])

  // The bottom of the right sidebar: the AI sessions (Aaron, 2026-11-25: "split the right sidebar, bottom half/third is agent").
  const agentsDock = light && lightTabs !== undefined ? (
    <AgentsDock
      tabs={lightTabs.list}
      activeFile={quickView!.file}
      onSelect={(file, agentId) => {
        /*
         * The one way the person's view goes to where a session is: they
         * click its row for the PDF they are already looking at. A session's
         * own calls never do this.
         */
        const view = agentId === undefined ? undefined : agentViewsRef.current.get(agentId)
        if (samePath(file, quickView!.file)) {
          if (view !== undefined && view.page !== pageIndexRef.current && view.page < pageCount) goToPage(view.page)
          return
        }
        if (agentId !== undefined) askLookIn(file, agentId)
        lightTabs.onSelect(file)
      }}
      onEndSession={lightTabs.onEndSession}
      onDismissSession={lightTabs.onDismissSession}
      onReopenFile={lightTabs.onReopenFile}
    />
  ) : null

  return (
    <div
      className="shellapp"
      data-pane={railPanel === null ? 'closed' : 'open'}
      data-work={workOpen ? 'open' : 'closed'}
      style={{ '--pane-w': `${paneW}px`, '--work-w': `${workW}px` } as React.CSSProperties}
    >
      <TitleBar
        projectName={projectName}
        fileMode={light}
        {...(light ? {
          fileCell: (
            <SidebarTabs
              inTitle
              active={railPanel}
              panels={LIGHT_PANELS}
              documentOpen={activeDocId !== null}
              notes={ingestNote !== null ? { files: ingestNote } : {}}
              indexing={indexing}
              onSelect={(p) => setRailPanel((cur) => (cur === p ? null : p))}
            />
          ),
        } : {})}
        appMenu={light
          ? {
              ...(quickView?.onOpenAnother !== undefined ? { onOpenFile: openAnotherFile } : {}),
              onSaveFile: saveOpenFile,
              onImportScopes: () => void importScopesFromPdf(),
              onPalette: openPalette,
              onSettings: openSettings,
              // One tab: the rest stay open. The last one closed goes to the start page.
              onCloseProject: lightTabs !== undefined ? () => lightTabs.onClose(quickView!.file) : closeProjectSavingTakeoff,
              closeLabel: 'Close file',
            }
          : {
              ...(onBrowseProject !== undefined ? { onOpenProject: onBrowseProject } : {}),
              onOpenDrawing: openBrowser,
              onContextWindow: () => void openContextWindow(identity.projectId ?? projectPath),
              onPalette: openPalette,
              onSettings: openSettings,
              ...(projectBridge.desktop ? { onSetAside: () => setAsideAsk(true) } : {}),
              onCloseProject: closeProjectSavingTakeoff,
            }}
        {...(recentProjects !== undefined && onOpenProject !== undefined
          ? {
              projectMenu: {
                currentPath: projectPath,
                currentName: projectName,
                facts: [
                  `${documents.length} document${documents.length === 1 ? '' : 's'}`,
                  `${estimates.length} round${estimates.length === 1 ? '' : 's'}`,
                  `${scopes.length} scope${scopes.length === 1 ? '' : 's'}`,
                ].join(' · '),
                recents: recentProjects,
                onOpen: onOpenProject,
                ...(onBrowseProject !== undefined ? { onBrowse: onBrowseProject } : {}),
                onMore: () => openPalette('~'),
                ...(onRenameProject !== undefined ? { onRename: onRenameProject } : {}),
                ...(onRevealProject !== undefined ? { onReveal: onRevealProject } : {}),
                onContextWindow: () => { void openContextWindow(identity.projectId ?? projectPath, activeDoc?.relativePath) },
                onStartPage: closeProjectSavingTakeoff,
              },
            }
          : {})}
        workOpen={workOpen}
        onToggleWork={() => setWorkOpen((v) => !v)}
      >
        {light && lightTabs !== undefined ? (
          <>
            {/*
              The person's tabs keep the strip. An agent's PDF joins it only
              while he is looking in on it, as an ordinary full-width tab
              marked in the session's colour; the sessions themselves are in
              the bottom of the right sidebar, and the strip carries one summary of them.
            */}
            <DocumentTabStrip
              tabs={lightTabs.list.filter((t) => t.owner === undefined || t.file === quickView!.file).map((t) => ({
                id: t.file, name: t.name.replace(/\.pdf$/i, ''), relativePath: t.file,
                marks: t.owner === undefined ? tabMarks(t, agentsNow) : peekMarks(t.owner, agentsNow),
              }))}
              activeId={quickView!.file}
              onSelect={lightTabs.onSelect}
              onClose={lightTabs.onClose}
              {...(quickView?.onOpenAnother !== undefined ? { onBrowse: openAnotherFile } : {})}
            />
            <AgentSummary tabs={lightTabs.list} onShow={() => { showAgentsDock(); setWorkOpen(true) }} />
          </>
        ) : (
        <DocumentTabStrip
          tabs={openTabs}
          activeId={activeDocId}
          onSelect={setActiveDocId}
          {...(openDocIds.length > 1 ? { onClose: closeDocument } : {})}
          {...(light ? {} : {
            onBrowse: openBrowser,
            onPopOut: (id: string) => {
              const tab = openTabs.find((t) => t.id === id)
              void openContextWindow(identity.projectId ?? projectPath, tab?.relativePath)
            },
          })}
        />
        )}
      </TitleBar>

      <Sidebar
        active={railPanel}
        {...(light ? { panels: LIGHT_PANELS, tabsInTitle: true } : {})}
        documentOpen={activeDocId !== null}
        /*
          The scan's own verdict — reconciliation refused, folder unreadable,
          no PDFs — was held in `ingestNote` and handed only to the bridge.
          The files panel shows it now, and this marks the tab so it is found
          while another panel is open.
        */
        notes={ingestNote !== null ? { files: ingestNote } : {}}
        indexing={indexing}
        onSelect={(p) => setRailPanel((cur) => (cur === p ? null : p))}
        onSettings={() => (settingsOpen ? setSettingsOpen(false) : openSettings())}
        beside={<UpdateChip desktop={isTauri()} />}
        title={railPanel === null
          ? undefined
          : railPanel === 'contents' && scaleTarget !== null ? 'Set scale' : PANE_TITLE[railPanel]}
      >
        {railPanel !== null && (<>
          {railPanel === 'search' && (
            <SearchPanel
              onSearch={runSearch}
              onGoToHit={goToHit}
              onMarkHits={markHits}
              onUnmarkHits={unmarkHits}
              targets={estimateScopes.map((sc) => ({
                id: sc.id, label: sc.label, color: sc.color,
                product: productLabelFor(sc.specifications), markups: markupCounts[sc.id] ?? 0,
              }))}
              onNewTarget={() => { setOpenScopeId(null); setWorkOpen(true); setAddScopeRequest((n) => n + 1) }}
              sheetFor={(pageId) => {
                const index = pageIndexOfId(pageId)
                const docId = pageId.replace(/-p\d+$/, '')
                if (index === null || docId !== docIdRef.current) return null
                for (const g of sheetGroups) for (const r of g.rows) if (r.page === index) return { number: r.number, title: r.title }
                return null
              }}
              currentDocumentId={activeDocId}
              onClose={() => setRailPanel(null)}
              focusNonce={searchFocus}
              seed={searchSeed}
              indexing={indexing}
              {...(light ? { reaches: LIGHT_REACHES } : {})}
            />
          )}
          {/*
            Setting a scale from the title block, over any number of sheets.
            The reference-line tool measures something on ONE page; this is the
            other half, and it is the one a real set needs most. It takes the
            pane the selection was made in, rather than a window over the
            drawing: the question was asked here, and the sheets it is about
            are the rows it replaces.
          */}
          {railPanel === 'contents' && scaleTarget !== null && (() => {
            const scales = scaleTarget.map(scaleOfPage)
            const first = scales[0] ?? null
            const agree = scales.every((s) => s === first)
            return (
              <ScalePicker
                target={scaleTarget.length === 1
                  ? `sheet ${scaleTarget[0]! + 1}`
                  : `${scaleTarget.length} sheets`}
                current={agree ? first : null}
                mixed={!agree}
                backLabel="Contents"
                onCancel={() => setScaleTarget(null)}
                onApply={(feetPerPoint, source) => {
                  void applyScaleToSelection(scaleTarget, feetPerPoint, source)
                }}
              />
            )
          })()}
          {railPanel === 'contents' && scaleTarget === null && (
            <SheetIndex
              pageCount={pageCount}
              shape={docIndex.shape}
              outline={docIndex.outline}
              labels={docIndex.labels.some((l) => l !== null) ? docIndex.labels : derivedLabels}
              takeoffPages={takeoffPages}
              pageScopes={pageScopes}
              current={pageIndex}
              onGoToPage={goToPage}
              onSetScale={(pages) => setScaleTarget(pages)}
              onRotate={(pages, turns) => { void rotatePages(pages, turns) }}
              onPrint={(pages) => { void printSheets(pages) }}
              scaleOf={scaleOfPage}
              pending={pendingText}
              named={titleNames}
              titleBlock={{
                named: titleRegions !== null,
                reading: titleReading,
                onPick: openTitlePick,
              }}
            />
          )}
          {railPanel === 'thumbnails' && (
            <PageStrip
              pageCount={pageCount}
              current={pageIndex}
              requestThumbnail={(i, w) => viewerRef.current?.requestThumbnail(i, w)}
              onGoTo={goToPage}
              labels={thumbLabels}
              rotationOf={(i) => viewerRef.current?.getPageRotation(i) ?? 0}
              onSetScale={(pages) => setScaleTarget(pages)}
              onRotate={(pages, turns) => { void rotatePages(pages, turns) }}
              onPrint={(pages) => { void printSheets(pages) }}
              empty={pendingText ?? 'No document open.'}
            />
          )}
          {railPanel === 'files' && (
            <FileList
              files={panelFiles}
              activeId={activeDocId}
              openIds={openDocIds}
              onOpen={openDocument}
              onOpenContext={() => void openContextWindow(identity.projectId ?? 'default')}
              onRefresh={() => void refreshFiles()}
              scanning={scan === 'reading'}
              note={ingestNote}
              focusNonce={filesFocus}
            />
          )}
        </>)}
      </Sidebar>

      {/*
        SETTINGS IS A PLACE, NOT A POP-UP.

        It was a dialog, which is the wrong shape for something with six
        categories and forty controls: a dialog says "answer this and get back
        to what you were doing", and settings is somewhere you go, look around,
        and leave. It fills the window under the title bar — the bar stays so
        the window is still movable and closable — and it is dismissed rather
        than answered.
      */}
      {settingsOpen && (
        <div className="settingsview">
          <SettingsPanel
            {...(light ? { hidden: LIGHT_HIDDEN_SETTINGS } : {})}
            store={settings}
            onClose={() => setSettingsOpen(false)}
            onReportBug={() => openReport()}
            {...(settingsTarget !== null ? { initialSettingId: settingsTarget } : {})}
          />
        </div>
      )}

      {/*
        NOTHING IS OVER THE DRAWING BUT THE PALETTE.

        The bill, the browser, the scope editor, the scale picker and the
        calibration form were a modal layer here. Each now lives where its
        moment already is — the estimates panel, the Files pane, the Contents
        pane, the dock's scale control — and the layer is gone.
      */}

      <div className="viewport">
        {/*
          The two panes RESIZE, from the drawing's edges. Equal by default,
          remembered across sessions, and a double-click puts one back.
          Aaron, 2026-09-11: the sidebars were unequal and fixed.
        */}
        {railPanel !== null && <ColumnGrip side="left" onDrag={(x) => setPaneW(clampPane(x))} onReset={() => setPaneW(SIDEBAR_DEFAULT)} />}
        {workOpen && <ColumnGrip side="right" onDrag={(x) => setWorkW(clampWork(window.innerWidth - x))} onReset={() => setWorkW(SIDEBAR_DEFAULT)} />}
        <StatusToast text={statusEntry.text} at={statusEntry.at} />
        {/* The setting promised a readout; this is the readout. */}
        {prefs['performance.showBudgets'] === true && <PerfReadout registry={perfRef.current} />}
        {activeDocId === null && scan === 'done' && (
          <div className="stageempty" role="status">
            <div>
              <strong>No drawing open</strong>
              Choose a sheet from the Files pane. The project&rsquo;s text is indexed in the
              background, so search will find it either way.
            </div>
          </div>
        )}

        <div
          ref={stageRef}
          className="stage"
          style={{ cursor: zoomBoxArmed ? 'zoom-in' : titlePick !== null ? 'crosshair' : tool === 'text' ? 'text' : hoverCursor ?? (tool === 'pan' ? 'grab' : tool === 'select' ? 'default' : 'crosshair') }}
          onMouseDown={(e) => { if (e.button === 1) e.preventDefault() }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={onDoubleClick}
          onContextMenu={(e) => {
            e.preventDefault()
            /*
             * A pending question comes first: a calibration line waiting for
             * its length, a scale box waiting for its scale. Right-click used
             * to cancel only the draft under it, so the form stayed up and
             * nothing could be redrawn until Cancel was pressed.
             */
            if (pendingCalRef.current !== null) { setMarkupMenu(null); cancelCalibration(); return }
            if (pendingRegionRef.current !== null) { setMarkupMenu(null); cancelRegion(); return }
            /*
             * A right-click means "back out" while something is being drawn,
             * and "what can I do with this?" when nothing is. Both are the
             * same button because they are the same instinct at different
             * moments, and neither one is ever ambiguous: a draft is either in
             * progress or it is not.
             */
            if (isCommittable(draftRef.current) || draftRef.current.points.length > 0
                || dimensionDraftRef.current.a !== null) {
              setMarkupMenu(null)
              cancelDraft()
              return
            }
            // Nothing being drawn and a drawing tool in hand: right-click
            // puts it down, the way Escape does. The menu on a markup is a
            // Pan-tool question, asked with the tool already down.
            if (tool !== 'pan' && tool !== 'select') {
              setMarkupMenu(null)
              setTool('pan')
              return
            }
            const r = e.currentTarget.getBoundingClientRect()
            const hx = e.clientX - r.left, hy = e.clientY - r.top
            const hit = hitTest(hx, hy, markupsRef.current, viewRef.current, page.width, page.height)
              ?? hitDimensionAt(hx, hy) ?? hitNoteAt(hx, hy)
            if (!hit) {
              // Nothing of ours under the pointer: ask the drawing what it has.
              // One of the PDF's markups there joins the selection first, so
              // the menu's "convert the selected" acts on what was clicked.
              const n = screenToNormalized(hx, hy, viewRef.current, page.width, page.height)
              const a = annotationAt(n, annotsRef.current, hiddenAnnotsRef.current)
              if (a !== null && !selectedAnnotsRef.current.includes(a.index)) {
                selectAnnots([a.index])
                requestPaint()
              }
              setMarkupMenu(null)
              void openDrawingMenu(hx, hy, n)
              return
            }
            // The menu acts on the selection, so what it will act on has to be
            // selected — and visibly so — before it opens.
            if (!selectedRef.current.includes(hit.markupId)) {
              setSelectedIds([hit.markupId])
              selectedRef.current = [hit.markupId]
              requestPaint()
            }
            const n = screenToNormalized(hx, hy, viewRef.current, page.width, page.height)
            setMarkupMenu({ x: hx, y: hy, nx: n.x, ny: n.y, markupId: hit.markupId, part: hit.part, index: hit.index })
          }}
        >
          {/* Size comes from useStageSize, never from width/height props: the
              backing store must be device pixels while the CSS box is layout
              pixels, and a React-managed `width` would fight that. */}
          <canvas ref={rasterRef} />
          <canvas ref={overlayRef} />
          {light && quickView !== undefined && (
            <AgentCursors ref={cursorsRef} file={quickView.file} page={pageIndex} place={placeAgentPoint} />
          )}
        </div>

        {/*
          The text box being typed into, over the box itself; the painter
          keeps it there as the sheet moves (placeNoteEditor). Outside the
          stage, so a click in it is typing and not a gesture on the sheet.
        */}
        {noteEdit !== null && (() => {
          const m = markups.find((x) => x.id === noteEdit.id)
          const c = parseNoteContent((m as { content?: unknown } | undefined)?.content)
          if (m === undefined || c === null) return null
          return (
            <textarea
              key={noteEdit.id}
              ref={(el) => {
                noteTextRef.current = el
                if (el !== null) { placeNoteEditor(m.rings[textRingIndex(c.shape)] ?? [], c); if (document.activeElement !== el) el.focus() }
              }}
              className="notetextedit"
              aria-label="Text box"
              defaultValue={c.text}
              spellCheck
              onInput={() => placeNoteEditor(m.rings[textRingIndex(c.shape)] ?? [], c)}
              onBlur={() => { void finishNoteEdit() }}
              onKeyDown={(e) => {
                // Escape and Ctrl+Enter end the typing; nothing reaches the sheet's shortcuts.
                e.stopPropagation()
                if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
                  e.preventDefault()
                  e.currentTarget.blur()
                }
              }}
            />
          )
        })()}

        {light && quickView !== undefined && lightTabs !== undefined && (
          <AgentBar
            file={quickView.file}
            owner={lightTabs.list.find((t) => t.file === quickView.file)?.owner}
            {...(lightTabs.onTakeOver !== undefined ? { onTakeOver: lightTabs.onTakeOver } : {})}
          />
        )}

        {annotMenu !== null && (
          <>
            <div
              className="menuscrim"
              onPointerDown={(e) => { e.stopPropagation(); setAnnotMenu(null) }}
              onContextMenu={(e) => { e.preventDefault(); setAnnotMenu(null) }}
            />
            <div
              ref={annotMenuClamp.ref}
              className="dockmenu markupmenu"
              role="menu"
              style={{ left: annotMenu.x, top: annotMenu.y, ...annotMenuClamp.style }}
            >
              {selectedAnnots.length > 0 && (() => {
                const picked = annotsRef.current.filter((a) => selectedAnnots.includes(a.index))
                return (
                  <>
                    <div className="menuhead">
                      Convert {picked.length} selected PDF markup{picked.length === 1 ? '' : 's'} into
                    </div>
                    {estimateScopes.slice(0, 8).map((sc) => (
                      <button
                        key={sc.id} className="menuitem" role="menuitem"
                        onClick={() => { void convertAnnotations(picked, sc.id); setAnnotMenu(null) }}
                      >
                        <span className="scopedot" style={{ background: sc.color }} aria-hidden="true" />
                        <span className="grow">{sc.label}</span>
                      </button>
                    ))}
                    {estimateScopes.length > 8 && (
                      <div className="menunote"><span>More scopes in the prompt: Ctrl+K, “convert”.</span></div>
                    )}
                    {estimateScopes.length === 0 && (
                      <div className="menunote"><span>No scopes in the round yet. Add one in the estimates pane or the prompt.</span></div>
                    )}
                    <div className="menusep" />
                  </>
                )
              })()}
              <div className="menuhead">
                {annotMenu.annotations.length === 0
                  ? 'The drawing'
                  : `${annotMenu.annotations.length} PDF markup${annotMenu.annotations.length === 1 ? '' : 's'} here`}
              </div>
              {annotMenu.annotations.map((a) => {
                const kind = kindForAnnotation(a)
                return (
                  <button
                    key={a.index} className="menuitem" role="menuitem"
                    onClick={() => { void convertAnnotations([a]); setAnnotMenu(null) }}
                  >
                    <Glyph icon={kind === 'area' ? Pentagon : kind === 'polyline' ? Ruler : Highlighter} role="row" />
                    <span className="grow">
                      Convert {a.subtypeName.toLowerCase()}{a.subject !== '' ? ` “${a.subject}”` : ''} to
                      {kind === 'area' ? ' an area' : kind === 'polyline' ? ' a length' : ' a highlight'}
                    </span>
                  </button>
                )
              })}
              {annotMenu.onSheet > 1 && (
                <button
                  className="menuitem" role="menuitem"
                  onClick={() => { void convertSheetAnnotations(); setAnnotMenu(null) }}
                >
                  <Glyph icon={Copy} role="row" />
                  <span className="grow">Convert all {annotMenu.onSheet} PDF markups on this sheet</span>
                </button>
              )}
              <button
                className="menuitem" role="menuitem"
                onClick={() => { void traceAt({ x: annotMenu.nx, y: annotMenu.ny }); setAnnotMenu(null) }}
              >
                <Glyph icon={Crosshair} role="row" />
                <span className="grow">Trace the region here as an area</span>
              </button>
              <div className="menusep" />
              {annotMenu.annotations.length > 0 && (
                <button
                  className="menuitem" role="menuitem"
                  onClick={() => {
                    const target = annotMenu.annotations.reduce((best, a) => {
                      const area = (a.rect.x1 - a.rect.x0) * (a.rect.y1 - a.rect.y0)
                      const bestArea = (best.rect.x1 - best.rect.x0) * (best.rect.y1 - best.rect.y0)
                      return area < bestArea ? a : best
                    })
                    hidePdfMarkup(target.index)
                    setAnnotMenu(null)
                  }}
                >
                  <Glyph icon={EyeOff} role="row" />
                  <span className="grow">Hide this PDF markup</span>
                </button>
              )}
              <button
                className="menuitem" role="menuitem"
                onClick={() => { hidePdfMarkups('all'); setAnnotMenu(null) }}
              >
                <Glyph icon={EyeOff} role="row" />
                <span className="grow">Hide all PDF markups on this sheet</span>
              </button>
              {hiddenAnnotCount > 0 && (
                <button
                  className="menuitem" role="menuitem"
                  onClick={() => { hidePdfMarkups('none'); setAnnotMenu(null) }}
                >
                  <Glyph icon={Eye} role="row" />
                  <span className="grow">Show hidden PDF markups</span>
                </button>
              )}
            </div>
          </>
        )}

        {markupMenu !== null && (() => {
          const m = markups.find((x) => x.id === markupMenu.markupId)
          if (m === undefined) return null
          const ring = m.rings[0] ?? []
          const applyRing = (next: Array<{ x: number; y: number }>, what: string) => {
            void commitGeometry(m.id, next, ring.map((p) => ({ ...p })), what)
            setMarkupMenu(null)
            requestPaint()
          }
          const count = selectedIds.length > 1 ? selectedIds.length : 1
          const plural = count === 1 ? '' : 's'
          if (m.kind === 'annot') {
            /*
              Another app's markup held in place (a Bluebeam cloud, text box,
              arrow or dimension): it moves, recolours and deletes, and the
              save writes that into the annotation itself. No scope, no
              copy: it is that app's markup, not takeoff.
            */
            const picked = markupsRef.current.filter((x) => x.kind === 'annot' && (selectedRef.current.includes(x.id) || x.id === m.id))
            const current = heldColorOf(m)
            return (
              <>
                <div
                  className="menuscrim"
                  onPointerDown={(e) => { e.stopPropagation(); setMarkupMenu(null) }}
                  onContextMenu={(e) => { e.preventDefault(); setMarkupMenu(null) }}
                />
                <div
                  ref={markupMenuClamp.ref}
                  className="dockmenu markupmenu"
                  role="menu"
                  style={{ left: markupMenu.x, top: markupMenu.y, ...markupMenuClamp.style }}
                >
                  <div className="menuhead">
                    {picked.length > 1 ? `${picked.length} PDF markups` : heldLabelOf(m)}
                  </div>
                  <div className="menunote"><span>Made in Bluebeam or another app. Saving writes changes into the PDF.</span></div>
                  <div className="menuhead">Colour</div>
                  <div className="palette" role="group" aria-label="Colour" style={{ padding: '2px 10px 6px' }}>
                    {HELD_COLORS.map((c) => (
                      <button
                        key={c.hex}
                        type="button"
                        className={`chip${current === c.hex ? ' on' : ''}`}
                        role="menuitemradio"
                        aria-checked={current === c.hex}
                        aria-label={c.name}
                        title={c.name}
                        style={{ backgroundColor: c.hex }}
                        onClick={() => { void recolorHeld(picked, c.hex); setMarkupMenu(null) }}
                      />
                    ))}
                  </div>
                  <div className="menusep" />
                  <button
                    className="menuitem danger"
                    role="menuitem"
                    onClick={() => {
                      const ids = selectedRef.current.length > 0 ? selectedRef.current : [m.id]
                      setSelectedIds([]); selectedRef.current = []
                      void removeMarkups(ids)
                      setMarkupMenu(null)
                    }}
                  >
                    <Glyph icon={Trash2} role="row" />
                    <span className="grow">Delete markup{plural}</span>
                  </button>
                </div>
              </>
            )
          }
          return (
            <>
              {/*
                A scrim so the next click anywhere dismisses the menu, and so a
                click meant for "close this" cannot also land on the drawing and
                start a shape.
              */}
              <div
                className="menuscrim"
                onPointerDown={(e) => { e.stopPropagation(); setMarkupMenu(null) }}
                onContextMenu={(e) => { e.preventDefault(); setMarkupMenu(null) }}
              />
              <div
                ref={markupMenuClamp.ref}
                className="dockmenu markupmenu"
                role="menu"
                style={{ left: markupMenu.x, top: markupMenu.y, ...markupMenuClamp.style }}
              >
                <div className="menuhead">{count} markup{plural}</div>

                {/* Vertex editing, which was ALT-click and therefore invisible. */}
                {markupMenu.part === 'edge' && (
                  <button
                    className="menuitem" role="menuitem"
                    onClick={() => applyRing(insertVertexAt(ring, markupMenu.index), 'insert vertex')}
                  >
                    <Glyph icon={Plus} role="row" />
                    <span className="grow">Add a control point here</span>
                  </button>
                )}
                {/*
                  Take the direction from an edge you can see.
                  Setting an orientation otherwise means picking the Direction
                  tool and drawing a line by eye along something already drawn
                  — which is a hand-traced copy of a vector the markup already
                  holds exactly. The edge under the pointer IS the answer.
                */}
                {m.kind === 'area' && m.scopeId !== null && (() => {
                  const sc = scopes.find((x) => x.id === m.scopeId)
                  const placed = sc !== undefined && areaOriginsFrom(sc.specifications).has(m.id)
                  return (
                    <>
                      <button
                        className="menuitem" role="menuitem"
                        onClick={() => {
                          void startPatternHere(m, { x: markupMenu.nx, y: markupMenu.ny })
                          setMarkupMenu(null)
                        }}
                      >
                        <Glyph icon={Crosshair} role="row" />
                        <span className="grow">Start the pattern here</span>
                      </button>
                      {/*
                        A right-click is rarely within a grip of the corner,
                        and "here" then meant a few inches into the ceiling.
                        This takes the corner the click is nearest, so any
                        corner is one right-click near it away.
                      */}
                      <button
                        className="menuitem" role="menuitem"
                        onClick={() => {
                          void startPatternHere(m, { x: markupMenu.nx, y: markupMenu.ny }, true)
                          setMarkupMenu(null)
                        }}
                      >
                        <Glyph icon={Crosshair} role="row" />
                        <span className="grow">Start the pattern at the nearest corner</span>
                      </button>
                      {placed && (
                        <button
                          className="menuitem" role="menuitem"
                          onClick={() => { void clearPatternOrigin(m); setMarkupMenu(null) }}
                        >
                          <Glyph icon={Compass} role="row" />
                          <span className="grow">Use the default pattern start</span>
                        </button>
                      )}
                    </>
                  )
                })()}
                {markupMenu.part === 'edge' && m.scopeId !== null && (() => {
                  const sc = scopes.find((x) => x.id === m.scopeId)
                  const pages = sc === undefined
                    ? new Map()
                    : pageDirectionsFrom(sc.specifications)
                  const sheetHasOne = pages.has(m.pageId)
                  return (
                    <>
                      <button
                        className="menuitem" role="menuitem"
                        onClick={() => { void directionFromEdge(m, markupMenu.index); setMarkupMenu(null) }}
                      >
                        <Glyph icon={Compass} role="row" />
                        <span className="grow">
                          {sheetHasOne
                            ? 'Run the pattern along this edge, here'
                            : 'Run the pattern along this edge'}
                        </span>
                      </button>
                      {/*
                        Once a sheet has a direction, every later gesture
                        corrects one area — so without this the sheet's own
                        direction would be unreachable, and one taken from the
                        wrong edge could only be undone area by area.
                      */}
                      {sheetHasOne && (
                        <button
                          className="menuitem" role="menuitem"
                          onClick={() => {
                            void directionFromEdge(m, markupMenu.index, true)
                            setMarkupMenu(null)
                          }}
                        >
                          <Glyph icon={Compass} role="row" />
                          <span className="grow">…and for every area on this sheet</span>
                        </button>
                      )}
                    </>
                  )
                })()}
                {markupMenu.part === 'vertex' && (
                  <button
                    className="menuitem" role="menuitem"
                    onClick={() => {
                      const next = removeVertexAt(ring, markupMenu.index, m.kind)
                      if (next === null) {
                        // Said out loud rather than disabled: "why is this
                        // greyed out" is a worse question than a plain answer.
                        setStatus('cannot remove — a shape needs its minimum vertices')
                        setMarkupMenu(null)
                        return
                      }
                      applyRing(next, 'remove vertex')
                    }}
                  >
                    <Glyph icon={Minus} role="row" />
                    <span className="grow">Remove this control point</span>
                  </button>
                )}

                <div className="menusep" />
                <div className="menuhead">Scope</div>
                {scopes.map((sc) => (
                  <button
                    key={sc.id}
                    className="menuitem"
                    role="menuitemradio"
                    aria-checked={m.scopeId === sc.id}
                    onClick={() => { void reassignSelection(sc.id); setMarkupMenu(null) }}
                  >
                    <span className="menudot" style={{ background: sc.color }} aria-hidden="true" />
                    <span className="grow">{sc.label}</span>
                    {m.scopeId === sc.id && <Glyph icon={Check} role="small" />}
                  </button>
                ))}
                <button
                  className="menuitem"
                  role="menuitemradio"
                  aria-checked={m.scopeId === null}
                  onClick={() => { void reassignSelection(null); setMarkupMenu(null) }}
                >
                  <Glyph icon={Minus} role="row" />
                  <span className="grow">No scope</span>
                  {m.scopeId === null && <Glyph icon={Check} role="small" />}
                </button>

                <div className="menusep" />
                <button
                  className="menuitem"
                  role="menuitem"
                  onClick={() => {
                    if (selectedRef.current.length === 0) { setSelectedIds([m.id]); selectedRef.current = [m.id] }
                    copySelection()
                    setMarkupMenu(null)
                  }}
                >
                  <Glyph icon={Copy} role="row" />
                  <span className="grow">Copy markup{plural}</span>
                </button>
                <button
                  className="menuitem"
                  role="menuitem"
                  onClick={() => {
                    const ids = selectedRef.current.length > 0 ? selectedRef.current : [m.id]
                    void duplicateMarkups(ids)
                    setMarkupMenu(null)
                  }}
                >
                  <Glyph icon={Duplicate} role="row" />
                  <span className="grow">Duplicate markup{plural}</span>
                </button>
                <button
                  className="menuitem danger"
                  role="menuitem"
                  onClick={() => {
                    const ids = selectedRef.current.length > 0 ? selectedRef.current : [m.id]
                    setSelectedIds([]); selectedRef.current = []
                    void removeMarkups(ids)
                    setMarkupMenu(null)
                  }}
                >
                  <Glyph icon={Trash2} role="row" />
                  <span className="grow">Delete markup{plural}</span>
                </button>
              </div>
            </>
          )
        })()}

        {report !== null && (
          <ReportDialog
            onClose={() => setReport(null)}
            where={whereLine([projectName, activeDoc === null ? null : nameOf(activeDoc), activeDoc === null ? null : sheetLabelFor(pageIndex)])}
            {...(activeDoc === null ? {} : { captureView })}
            initial={report.initial}
          />
        )}

        {unsavedAsk !== null && (
          <div className="nesting" role="presentation">
            <div className="nesting-card" role="dialog" aria-labelledby="unsaved-title">
              <h2 id="unsaved-title">{unsavedAsk.saving === true ? 'Still saving the takeoff into the PDF' : 'This takeoff is not saved in the PDF'}</h2>
              <p>{unsavedAsk.why}</p>
              <p>{unsavedAsk.saving === true
                ? 'REDBEAM carries on by itself once the save finishes. Save a copy to keep the takeoff now, or leave without saving.'
                : 'Save a copy to keep the takeoff now, or close the PDF in the other app and try again.'}</p>
              <div className="nesting-actions">
                <button
                  type="button" className="st-btn" disabled={copying}
                  onClick={() => {
                    if (copyingRef.current) return
                    const { leave } = unsavedAsk
                    // A slow save finishing meanwhile must not leave as well.
                    const slow = slowLeaveRef.current
                    slowLeaveRef.current = null
                    slow?.answered()
                    void saveCopyOfFile().then((saved) => { if (saved) { setUnsavedAsk(null); leave?.() } })
                  }}
                >{copying ? 'Saving a copy…' : 'Save a copy…'}</button>
                {unsavedAsk.saving !== true && (
                  <button
                    type="button" className="st-btn"
                    onClick={() => {
                      const { leave } = unsavedAsk
                      dismissUnsavedAsk()
                      if (leave !== null) leaveSaving(leave)
                      else saveOpenFile()
                    }}
                  >Try again</button>
                )}
                {unsavedAsk.leave !== null && (
                  <button
                    type="button" className="st-btn danger"
                    onClick={() => { const { leave } = unsavedAsk; dismissUnsavedAsk(); leave?.() }}
                  >Leave without saving</button>
                )}
                <button type="button" className="st-btn subtle" onClick={dismissUnsavedAsk}>Keep working</button>
              </div>
            </div>
          </div>
        )}

        {asideAsk && (
          <div className="nesting" role="presentation">
            <div className="nesting-card" role="dialog" aria-labelledby="aside-title">
              <h2 id="aside-title">Set this project’s REDBEAM data aside?</h2>
              <p>The takeoff moves into the folder’s .redbeam/removed folder. The drawings are not touched, and the database can be put back.</p>
              <div className="nesting-actions">
                <button type="button" className="st-btn danger" onClick={() => { setAsideAsk(false); void asideCurrentProject() }}>Set aside</button>
                <button type="button" className="st-btn subtle" onClick={() => setAsideAsk(false)}>Cancel</button>
              </div>
            </div>
          </div>
        )}

        {titlePick !== null && (
          <TitleBlockPicker
            step={titlePick.step}
            numberText={titlePick.numberText}
            titleText={titlePick.titleText}
            sheetCount={pageCount}
            onCancel={() => { setTitlePick(null); requestPaint() }}
            onBack={() => setTitlePick((cur) => cur === null ? cur : { ...cur, step: 'number' })}
            onNext={() => {
              setTitlePick((cur) => cur === null ? cur : { ...cur, step: 'title' })
            }}
            onApply={() => {
              const tp = titlePickRef.current
              if (tp === null || tp.number === null) return
              setTitlePick(null)
              void applyTitleRegions({ number: tp.number, title: tp.title })
              requestPaint()
            }}
          />
        )}

        {tool === 'link' && activeDocId !== null && review === null && (
          <LinkBar onFind={() => void findCalloutLinks()} />
        )}
        {pendingLink !== null && (
          <LinkPicker
            x={pendingLink.x}
            y={pendingLink.y}
            sheets={pickerSheets}
            suggested={pendingLink.suggested}
            fromPage={pendingLink.page}
            onPick={(p) => void pickLinkTarget(p)}
            onCancel={() => cancelLinkRef.current()}
          />
        )}
        {review !== null && (
          <CalloutReview
            state={review}
            sheetLabel={sheetLabelFor}
            sheetTitle={sheetTitleFor}
            onToggle={(i) => { setReview((r) => r === null ? r : { ...r, candidates: r.candidates.map((c, j) => j === i ? { ...c, checked: !c.checked } : c) }); requestPaint() }}
            onAll={(on) => { setReview((r) => r === null ? r : { ...r, candidates: r.candidates.map((c) => ({ ...c, checked: on })) }); requestPaint() }}
            onFocus={focusCandidate}
            onApply={() => void applyReview()}
            onCancel={closeReview}
          />
        )}
        {CURVE_TOOLS.has(tool) && activeDocId !== null && (
          <SegmentBar
            mode={segMode}
            caption={segmentCaption(segMode, draftRef.current.points.length, draftRef.current.pivot !== undefined, tool)}
            onMode={setSegmentMode}
          />
        )}
        <Dock
          pinned={pendingCal !== null || pendingRegion !== null}
          above={isNoteTool(tool)
            ? <NoteStrip content={noteStyles[tool]} target="tool" onChange={patchNotes} />
            : selectedNotes.length > 0 && (tool === 'pan' || tool === 'select')
              ? <NoteStrip content={selectedNotes[0]!.content} target="selection" count={selectedNotes.length} onChange={patchNotes} />
              : undefined}
          left={
            <ToolPill
              tool={tool}
              onTool={setTool}
              scopes={estimateScopes}
              activeScope={activeScope}
              /*
                One active scope, shared. Picking a scope here used to arm
                the dock and leave the sidebar on whatever it was showing
                (Aaron, 2026-09-18: "changing scopes on the dock doesn't
                change the active scope in the sidebar like it should"); the
                sidebar already arms the dock when a scope page opens, so
                this is the other half of the same rule.
              */
              onScope={(id) => { setActiveScope(id); setOpenScopeId(id) }}
              takeoff={takeoff}
              onTakeoff={beginTakeoff}
              estimates={estimates.map((e) => ({ id: e.id, name: e.name }))}
              fileMode={light}
              openEstimateId={openEstimateId}
              onEstimate={(id) => {
                setOpenEstimateId(id)
                setOpenScopeId(null)
                void refreshEstimates(id)
              }}
              onAddScope={openScopeEditor}
              markupCountFor={(id) => markupCounts[id] ?? 0}
              onOpenEstimates={() => setWorkOpen(true)}
              documentOpen={activeDocId !== null}
              onZoomBox={() => { if (zoomBoxArmedRef.current) disarmZoomBox(); else armZoomBox() }}
              zoomBoxArmed={zoomBoxArmed}
            />
          }
          right={
            <DocumentPill
              page={pageIndex}
              pageCount={pageCount}
              onPage={goToPage}
              feetPerPoint={cal?.feetPerPoint ?? null}
              onPreset={applyPreset}
              onCalibrate={() => setTool('calibrate')}
              onDrawRegion={() => { setTakeoff(true); setTool('scale-region') }}
              /*
                Everything about this sheet's scale, under the control that
                reads it: the regions as the page scale's small print, and the
                two half-finished gestures — a line waiting for its length, a
                box waiting for its scale — which hold the control open until
                they are answered. Geometry first, meaning second, for both:
                a box with no scale on it governs nothing and would sit on
                the sheet pretending otherwise.
              */
              regions={{
                list: regionsOnThisSheet,
                conflicting: new Set(conflictingRegions(regionsOnThisSheet).flat()),
                onDelete: (id) => { void removeRegion(id) },
                toolActive: tool === 'scale-region',
                onDone: () => setTool('pan'),
              }}
              {...(pendingCal !== null
                ? {
                    calibration: {
                      lengthPdfPoints: pendingCal,
                      error: calError,
                      onSubmit: (raw: string, unit: string) => { void applyCalibration(raw, unit) },
                      onCancel: cancelCalibration,
                    },
                  }
                : {})}
              {...(pendingRegion !== null
                ? {
                    pendingRegion: {
                      onApply: (feetPerPoint: number, source: string, label: string) => {
                        void commitRegion(feetPerPoint, source, label)
                      },
                      onCancel: cancelRegion,
                    },
                  }
                : {})}
              zoom={zoomShown}
              onZoom={setZoom}
              onZoomBox={armZoomBox}
              onRotate={(d) => { void rotateSheet(d) }}
              onFitPage={() => applyFit('page')}
              onFitWidth={() => applyFit('width')}
            />
          }
        />
      </div>

      <EstimatesPanel
        projectName={projectName}
        patterns={patternControls}
        fileMode={light}
        below={agentsDock}
        estimates={estimates}
        loaded={estimatesLoaded}
        openEstimateId={openEstimateId}
        onOpenEstimate={(id) => { setOpenEstimateId(id); void refreshEstimates(id) }}
        openScopeId={openScopeId}
        onOpenScope={(id) => {
          setOpenScopeId(id)
          // Opening a scope makes it the destination for new markup: reading a
          // scope and drawing into a different one is the mistake this avoids.
          if (id !== null) setActiveScope(id)
        }}
        scopes={estimateScopes}
        scopesLoaded={estimateScopesLoaded}
        markupCountFor={(id) => markupCounts[id] ?? 0}
        standingFor={standingFor}
        rows={activeQuantities}
        {...(activePieces !== undefined ? { pieces: activePieces } : {})}
        {...(activeFactoryCut !== undefined ? { factoryCut: activeFactoryCut } : {})}
        markups={scopeMarkups}
        sheetLabel={sheetLabelFor}
        sheetTitle={sheetTitleFor}
        onGoToPage={goToPage}
        onGoToMarkup={goToMarkup}
        selectedMarkupIds={selectedIds}
        onSelectMarkups={(ids) => { setSelectedIds(ids); selectedRef.current = ids; requestPaint() }}
        onDeleteMarkups={(ids) => void removeMarkups(ids)}
        onMoveMarkups={(ids, scopeId) => void reassignMarkups(ids, scopeId)}
        onDuplicateMarkups={(ids) => void duplicateMarkups(ids)}
        lengthDenominator={Number(prefs['takeoff.imperialPrecision'] ?? 16)}
        onCreateEstimate={(name) => void createEstimate(name)}
        onCreateScope={(label) => void createNamedScope(label)}
        addScopeRequest={addScopeRequest}
        onDuplicateScope={(id) => void duplicateScope(id)}
        archived={archivedScopes}
        onRestoreScope={(id) => void restoreScope(id)}
        onDuplicateEstimate={(id, name) => void duplicateEstimate(id, name)}
        onRenameEstimate={(id, name) => void renameEstimateBy(id, name)}
        onDeleteEstimate={(id) => void deleteEstimateBy(id)}
        onRemoveScope={(eid, sid) => void removeScopeBy(eid, sid)}
        onSaveScope={(sc) => void saveScope(sc)}
        bill={{
          entries: pieces,
          /*
           * The ROUND is calibrated if any page it could be measured on is.
           * This read the open sheet's calibration, so the round's list wore
           * "this drawing is not calibrated, nothing here is in real units"
           * directly above three rows in square feet whenever a cover sheet
           * happened to be showing. Same wrong gate as the roll-up, one
           * consumer further down.
           */
          calibrated: projectCalibrations.size > 0,
          documents: documents.map((d) => d.displayName || d.relativePath),
          markupCount: markupsOnOpenDrawing,
          onExportMarkedPdf: exportMarkedDrawing,
        }}
        scopePage={scopePage}
        onScopePage={setScopePage}
        onSetDirection={() => {
          /*
           * The scope whose Setup is open is the one the direction is FOR.
           * The direction tool writes to the active scope, and the Setup
           * pane could be open on another: the direction landed on the
           * dock's scope, the layout drew correctly for it, and this pane
           * went on saying "not set". Kenneth, 2026-09-10.
           */
          if (openScopeId !== null) setActiveScope(openScopeId)
          setTakeoff(true); setTool('direction')
        }}
        direction={(() => {
          /*
           * A direction lives in three places (AREA beats PAGE beats SCOPE,
           * see the domain), and this row read only the third, so a
           * direction set for the whole sheet drew the layout correctly while
           * the row went on saying "not set".
           */
          const sc = estimateScopes.find((s) => s.id === (openScopeId ?? activeScope))
          if (sc === undefined) return null
          const here = pageIdFor(docIdRef.current, pageIndexRef.current)
          const pages = pageDirectionsFrom(sc.specifications)
          const areas = areaDirectionsFrom(sc.specifications)
          const parts: string[] = []
          if (pages.has(here)) parts.push(pages.size > 1 ? `set for this sheet and ${pages.size - 1} more` : 'set for this sheet')
          else if (pages.size > 0) parts.push(`set on ${pages.size} other sheet${pages.size === 1 ? '' : 's'}`)
          if (areas.size > 0) parts.push(`${areas.size} area${areas.size === 1 ? '' : 's'} on their own`)
          const d = scopeDefaultDirectionFrom(sc.specifications)
          if (d !== null) {
            // The sheet it was picked on rides in the raw spec beside the vector.
            const raw = sc.specifications['scopeDefaultDirection']
            const page = raw !== null && typeof raw === 'object' && 'sourcePage' in raw ? Number((raw as { sourcePage?: unknown }).sourcePage) : NaN
            parts.push(Number.isFinite(page) ? `default from ${sheetLabelFor(page)}` : 'default set')
          }
          return parts.length === 0 ? null : parts.join(' · ')
        })()}
        layoutOn={layoutOn}
        onToggleLayout={setLayoutOn}
        {...(commitState !== undefined ? { commit: commitState } : {})}
        onTakeOff={(id) => { setActiveScope(id); beginTakeoff(true); setTool(firstToolFor(id)) }}
        takingOff={takeoff && openScopeId !== null && activeScope === openScopeId}
        onExportEstimate={openEstimateExport}
        {...(exportDraft !== null
          ? {
              exportSheet: (
                <ExportSheet
                  key={exportDraft.estimateName}
                  initial={exportDraft}
                  onSavePdf={saveEstimatePdf}
                  onClose={() => setExportDraft(null)}
                />
              ),
            }
          : {})}
        warnings={warnings}
        {...(layoutBlocker !== undefined ? { blocker: layoutBlocker } : {})}
      />

      {paletteOpen && (
        <CommandPalette
          commands={commands}
          initialQuery={paletteSeed}
          context={activeDocId === null
            ? projectName
            : `${sheetLabelFor(pageIndex)}${(() => { const sc = scopes.find((s) => s.id === (openScopeId ?? activeScope)); return sc === undefined ? '' : ` · ${sc.label} active` })()}`}
          onClose={() => setPaletteOpen(false)}
          onSearchText={(q) => { openSearch(); setSearchSeed(q) }}
        />
      )}
    </div>
  )
}

/** True when something between `target` and `stage` scrolls vertically and so owns a plain wheel. */
function scrollsInside(target: EventTarget | null, stage: HTMLElement): boolean {
  for (let n = target instanceof Element ? target : null; n !== null && n !== stage; n = n.parentElement) {
    if (n.scrollHeight <= n.clientHeight + 1) continue
    const y = getComputedStyle(n).overflowY
    if (y === 'auto' || y === 'scroll') return true
  }
  return false
}

/**
 * A normalized box from a bridge argument. Undefined when absent; null when
 * present but not a box, so the caller can say so rather than act on the
 * whole sheet. Accepts a stringified object, as MCP clients often send one.
 */
function bridgeRect(v: unknown): { x0: number; y0: number; x1: number; y1: number } | undefined | null {
  if (v === undefined || v === null) return undefined
  let o: unknown = v
  if (typeof v === 'string') { try { o = JSON.parse(v) } catch { return null } }
  if (typeof o !== 'object' || o === null) return null
  const r = o as Record<string, unknown>
  const n = (k: string) => Number(r[k])
  const box = { x0: n('x0'), y0: n('y0'), x1: n('x1'), y1: n('y1') }
  if (![box.x0, box.y0, box.x1, box.y1].every((x) => Number.isFinite(x) && x >= -0.001 && x <= 1.001)) return null
  if (box.x0 === box.x1 || box.y0 === box.y1) return null
  return box
}

/** Writes that act on the sheet showing: a `page` input shows that sheet first. */
const PAGE_BOUND = new Set([
  'create_markup', 'set_calibration', 'set_scope_direction', 'set_pattern_origin', 'set_pattern_direction',
  'begin_scale_region', 'zoom_to_region',
])

/** A normalized point from a bridge argument, or null. */
function bridgePoint(v: unknown): { x: number; y: number } | null {
  let o: unknown = v
  if (typeof v === 'string') { try { o = JSON.parse(v) } catch { return null } }
  if (typeof o !== 'object' || o === null) return null
  const x = Number((o as { x?: unknown }).x), y = Number((o as { y?: unknown }).y)
  return Number.isFinite(x) && Number.isFinite(y) && x >= -0.001 && x <= 1.001 && y >= -0.001 && y <= 1.001 ? { x, y } : null
}

/** The point on an area's outer edge nearest `p`, measured in page points. */
function nearestOnBoundary(
  rings: ReadonlyArray<ReadonlyArray<{ x: number; y: number }>>, p: { x: number; y: number }, page: { width: number; height: number },
): { x: number; y: number } | null {
  const ring = rings[0]
  if (ring === undefined || ring.length < 2) return null
  let best: { x: number; y: number } | null = null, bestD = Infinity
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!
    const ax = a.x * page.width, ay = a.y * page.height, dx = (b.x - a.x) * page.width, dy = (b.y - a.y) * page.height
    const L2 = dx * dx + dy * dy
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((p.x * page.width - ax) * dx + (p.y * page.height - ay) * dy) / L2)) : 0
    const q = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    const d = Math.hypot((q.x - p.x) * page.width, (q.y - p.y) * page.height)
    if (d < bestD) { bestD = d; best = q }
  }
  return best
}

/** Addendum links recorded in the open file (round 3 #9). They travel in the PDF. */
const ADDENDA_KEY = 'addenda_links'
/** One AI session's own view of a PDF; see `agentViewsRef`. */
type AgentView = {
  page: number
  /** The box it last framed with zoom_to_region; a screenshot with no region shows it. */
  rect: { x0: number; y0: number; x1: number; y1: number } | null
  selected: string[]
  pendingRegion: { rect: { x0: number; y0: number; x1: number; y1: number }; pageId: string } | null
  /** Which markup layers ITS screenshots draw. */
  embedded: boolean
  redbeam: boolean
  tool: string
  layoutOn: boolean
}
type AddendumLink = { replaced: number; by: number; source: string }
async function readAddendaLinks(db: SqlDriver): Promise<AddendumLink[]> {
  try {
    const rows = await db.all<{ value: string }>('SELECT value FROM redbeam_meta WHERE key = ?', [ADDENDA_KEY])
    const v = rows[0] === undefined ? [] : JSON.parse(rows[0].value) as unknown
    return Array.isArray(v) ? v.filter((l): l is AddendumLink => typeof l === 'object' && l !== null
      && Number.isInteger((l as AddendumLink).replaced) && Number.isInteger((l as AddendumLink).by)) : []
  } catch { return [] }
}
async function writeAddendaLinks(db: SqlDriver, links: AddendumLink[]): Promise<void> {
  await db.run('INSERT OR REPLACE INTO redbeam_meta(key, value) VALUES(?, ?)', [ADDENDA_KEY, JSON.stringify(links)])
}

/** Pages an agent asked for (`page`, `pages`, or `fromPage`..`toPage`), or every page. */
function bridgePages(params: Record<string, unknown>, pageCount: number): number[] | string {
  const ok = (n: number) => Number.isInteger(n) && n >= 0 && n < pageCount
  let list: number[]
  if (Array.isArray(params['pages'])) list = params['pages'].map(Number)
  else if (params['page'] !== undefined) list = [Number(params['page'])]
  else if (params['fromPage'] !== undefined || params['toPage'] !== undefined) {
    const a = Number(params['fromPage'] ?? 0), b = Number(params['toPage'] ?? pageCount - 1)
    list = []
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) list.push(i)
  } else list = Array.from({ length: pageCount }, (_, i) => i)
  const bad = list.find((n) => !ok(n))
  if (bad !== undefined) return `page ${bad} out of range (0..${pageCount - 1})`
  return [...new Set(list)]
}
