/**
 * Default PDF viewer, in Settings › About.
 *
 * Windows does not let an app make itself the default, so this says where
 * things stand and opens the Default apps page on REDBEAM's entry. The status
 * is read again when the window regains focus, so coming back from Windows
 * Settings shows the new answer.
 */
import { useState } from 'react'
import { DocumentPdf, Glyph } from '../shell/icons.js'
import { choosePdfHandler, usePdfHandlerStatus, type PdfHandlerStatus } from '../tauri/openWith.js'

export function defaultViewerNote(s: PdfHandlerStatus): string {
  if (s.isDefault) return 'PDFs you double-click open in REDBEAM. To change that, use Default apps in Windows Settings.'
  if (s.registered) {
    return 'REDBEAM is offered under Open with for PDFs. To have double-clicked PDFs open here, ' +
      'choose REDBEAM for .pdf in Windows Settings; Windows asks you to make that choice yourself.'
  }
  return 'This copy was not set up by the REDBEAM installer, so Windows does not offer it for PDFs. ' +
    'The next update registers it.'
}

export function DefaultViewerRow() {
  const status = usePdfHandlerStatus()
  const [error, setError] = useState<string | null>(null)
  if (!status.supported) return null
  return (
    <div className="prefs-card">
      <span className="prefs-cardicon"><Glyph icon={DocumentPdf} role="card" /></span>
      <div className="prefs-cardtext">
        <div className="prefs-cardtitle">{status.isDefault ? 'REDBEAM is your PDF viewer' : 'Default PDF viewer'}</div>
        <div className="prefs-cardnote">{error ?? defaultViewerNote(status)}</div>
      </div>
      {status.registered && (
        <button
          className="act"
          onClick={() => { setError(null); void choosePdfHandler().catch((e: unknown) => setError(String(e))) }}
        >
          {status.isDefault ? 'Default apps' : 'Make default…'}
        </button>
      )}
    </div>
  )
}
