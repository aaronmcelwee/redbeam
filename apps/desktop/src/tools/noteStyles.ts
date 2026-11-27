/**
 * The style each note tool draws with next: its colour, line, fill, ends and
 * font size. Changed from the property strip while the tool is in hand and
 * remembered on this machine, the way Revu's tool chest keeps a tool's last
 * properties.
 */
import { NOTE_SHAPES, defaultNoteContent, parseNoteContent, type NoteContent, type NoteShape } from './noteGeometry.js'

export type NoteStyles = Record<NoteShape, NoteContent>

const KEY = 'redbeam.note-styles'

export function defaultNoteStyles(): NoteStyles {
  return Object.fromEntries(NOTE_SHAPES.map((s) => [s, defaultNoteContent(s)])) as NoteStyles
}

/** Read the saved styles over the defaults. Storage may be missing or refuse. */
export function parseNoteStyles(raw: string | null): NoteStyles {
  const out = defaultNoteStyles()
  if (raw === null) return out
  try {
    const v = JSON.parse(raw) as Record<string, unknown>
    for (const s of NOTE_SHAPES) {
      const c = parseNoteContent({ ...(typeof v[s] === 'object' && v[s] !== null ? v[s] as object : {}), shape: s })
      if (c !== null) out[s] = { ...c, text: '' }
    }
  } catch { /* the defaults stand */ }
  return out
}

export function loadNoteStyles(): NoteStyles {
  try { return parseNoteStyles(localStorage.getItem(KEY)) } catch { return defaultNoteStyles() }
}

export function saveNoteStyles(s: NoteStyles): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)) } catch { /* not remembered; still applied */ }
}
