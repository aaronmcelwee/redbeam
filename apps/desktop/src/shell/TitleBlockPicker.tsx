/**
 * Two boxes on the title block, then every sheet is named from them.
 *
 * A card over the drawing rather than a dialog, because the answer is a box
 * dragged on the drawing: the sheet has to stay live underneath. Step one is
 * the drawing number, step two the title (which can be skipped). Each step
 * shows what its box reads on this sheet, so a box that caught the contract
 * number instead of the drawing number is caught here and not on sheet 200.
 */
export type PickStep = 'number' | 'title'

/** The colours the two boxes are drawn in on the sheet. */
export const NUMBER_BOX_COLOR = '#d83b01'
export const TITLE_BOX_COLOR = '#0078d4'

export interface TitleBlockPickerProps {
  step: PickStep
  /** What each box reads on this sheet; null before it is drawn. */
  numberText: string | null
  titleText: string | null
  sheetCount: number
  onBack: () => void
  onNext: () => void
  /** Read every sheet with the boxes drawn so far. */
  onApply: () => void
  onCancel: () => void
}

export function TitleBlockPicker({
  step, numberText, titleText, sheetCount, onBack, onNext, onApply, onCancel,
}: TitleBlockPickerProps) {
  const shown = (t: string | null, drawn: string) => (t === null ? 'Not drawn yet' : t === '' ? `No text in the ${drawn} box` : t)
  return (
    <div className="tbpick" role="dialog" aria-modal="false" aria-labelledby="tbpick-title">
      <h2 id="tbpick-title">Name sheets from the title block</h2>
      <p className="tbpick-step">
        {step === 'number'
          ? 'Step 1 of 2: drag a box around the drawing number on this sheet.'
          : 'Step 2 of 2: drag a box around the drawing title. Make it big enough for the longest title.'}
      </p>
      <dl className="tbpick-fields">
        <dt className={numberText !== null ? 'on' : ''} style={{ ['--tb-color' as string]: NUMBER_BOX_COLOR }}>Drawing number</dt>
        <dd className={numberText === null || numberText === '' ? 'empty' : ''}>{shown(numberText, 'number')}</dd>
        <dt className={titleText !== null ? 'on' : ''} style={{ ['--tb-color' as string]: TITLE_BOX_COLOR }}>Drawing title</dt>
        <dd className={titleText === null || titleText === '' ? 'empty' : ''}>{shown(titleText, 'title')}</dd>
      </dl>
      <div className="tbpick-actions">
        <button type="button" className="st-btn subtle" onClick={onCancel}>Cancel</button>
        <span className="grow" />
        {step === 'number'
          ? (
            <button type="button" className="st-btn accent" disabled={numberText === null || numberText === ''} onClick={onNext}>Next</button>
            )
          : (
            <>
              <button type="button" className="st-btn" onClick={onBack}>Back</button>
              <button type="button" className="st-btn accent" onClick={onApply}>
                {titleText === null ? `Numbers only, ${sheetCount} sheets` : `Name ${sheetCount} sheets`}
              </button>
            </>
            )}
      </div>
    </div>
  )
}
