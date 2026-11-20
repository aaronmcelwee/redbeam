import { describe, expect, it } from 'vitest'
import { pdfHandlerStatus, takeLaunchFile } from './openWith.js'
import { defaultViewerNote } from '../settings/DefaultViewerRow.js'

describe('opening PDFs from Windows', () => {
  it('does nothing outside the desktop app', async () => {
    expect(await takeLaunchFile()).toBeNull()
    expect(await pdfHandlerStatus()).toEqual({ supported: false, registered: false, isDefault: false })
  })

  it('says where REDBEAM stands as the PDF viewer', () => {
    expect(defaultViewerNote({ supported: true, registered: true, isDefault: true })).toMatch(/open in REDBEAM/)
    expect(defaultViewerNote({ supported: true, registered: true, isDefault: false })).toMatch(/Open with/)
    expect(defaultViewerNote({ supported: true, registered: false, isDefault: false })).toMatch(/installer/)
  })
})
