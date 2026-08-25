import { describe, expect, it } from 'vitest'
import {
  applyClarinTextEdit,
  CLARIN_TEXT_MARK,
  createClarinTextFormat,
  getClarinBeforeInputText,
  getClarinMarkState,
  getClarinVisualLines,
  replaceClarinTextRange,
  setClarinTextMark,
  shouldInsertClarinTextLineBreak,
  shouldForceClarinCustomDataRemoval,
  snapClarinTextRange,
  toggleClarinTextMark,
  updateClarinTextCustomData,
  validateClarinTextFormat,
} from '@excalidraw/excalidraw/clarin-rich-text'

describe('Clarin partial text formatting model', () => {
  it('removes an isolated italic run and signals deletion of the final customData field', () => {
    const text = 'Solo cursiva'
    const italic = toggleClarinTextMark(null, text, 0, text.length, CLARIN_TEXT_MARK.ITALIC)
    expect(italic.runs).toEqual([{ from: 0, to: text.length, marks: CLARIN_TEXT_MARK.ITALIC }])

    const cleared = toggleClarinTextMark(italic, text, 0, text.length, CLARIN_TEXT_MARK.ITALIC)
    expect(cleared.runs).toEqual([])
    const previous = { clarinTextFormat: italic }
    const next = updateClarinTextCustomData(previous, cleared)
    expect(next).toBeUndefined()
    expect(shouldForceClarinCustomDataRemoval(previous, next)).toBe(true)
    expect(shouldForceClarinCustomDataRemoval(undefined, undefined)).toBe(false)
  })

  it('combines marks and removes only the requested mark', () => {
    const text = 'Título\nCuerpo'
    let format = toggleClarinTextMark(null, text, 0, 6, CLARIN_TEXT_MARK.BOLD)
    format = toggleClarinTextMark(format, text, 0, 6, CLARIN_TEXT_MARK.ITALIC)
    format = toggleClarinTextMark(format, text, 0, 6, CLARIN_TEXT_MARK.UNDERLINE)
    format = toggleClarinTextMark(format, text, 0, 6, CLARIN_TEXT_MARK.STRIKE)
    expect(format.runs).toEqual([{ from: 0, to: 6, marks: 15 }])

    format = toggleClarinTextMark(format, text, 0, 6, CLARIN_TEXT_MARK.ITALIC)
    expect(format.runs).toEqual([{ from: 0, to: 6, marks: 13 }])
  })

  it('applies a mark across a mixed selection and removes it when fully marked', () => {
    const text = 'Título\nCuerpo'
    const titleOnly = createClarinTextFormat(text, [{ from: 0, to: 6, marks: CLARIN_TEXT_MARK.BOLD }])
    expect(getClarinMarkState(titleOnly, text, 0, text.length, CLARIN_TEXT_MARK.BOLD)).toBe('mixed')

    const allBold = setClarinTextMark(titleOnly, text, 0, text.length, CLARIN_TEXT_MARK.BOLD, true)
    expect(allBold.runs).toEqual([{ from: 0, to: text.length, marks: CLARIN_TEXT_MARK.BOLD }])
    expect(setClarinTextMark(allBold, text, 0, text.length, CLARIN_TEXT_MARK.BOLD, false).runs).toEqual([])
  })

  it('keeps future caret formatting on inserted text and shifts existing ranges', () => {
    const previousText = 'AB'
    const format = createClarinTextFormat(previousText, [{ from: 0, to: 1, marks: CLARIN_TEXT_MARK.BOLD }])
    const inserted = applyClarinTextEdit({
      format,
      previousText,
      nextText: 'AxB',
      insertedMarks: CLARIN_TEXT_MARK.BOLD | CLARIN_TEXT_MARK.UNDERLINE,
    })
    expect(inserted.runs).toEqual([
      { from: 0, to: 1, marks: CLARIN_TEXT_MARK.BOLD },
      { from: 1, to: 2, marks: CLARIN_TEXT_MARK.BOLD | CLARIN_TEXT_MARK.UNDERLINE },
    ])
  })

  it('updates ranges through deletion and line-break insertion', () => {
    const previousText = 'TítuloCuerpo'
    const format = createClarinTextFormat(previousText, [
      { from: 0, to: 6, marks: CLARIN_TEXT_MARK.BOLD },
      { from: 6, to: 12, marks: CLARIN_TEXT_MARK.ITALIC },
    ])
    const withBreak = applyClarinTextEdit({ format, previousText, nextText: 'Título\nCuerpo' })
    expect(withBreak.runs).toEqual([
      { from: 0, to: 6, marks: CLARIN_TEXT_MARK.BOLD },
      { from: 7, to: 13, marks: CLARIN_TEXT_MARK.ITALIC },
    ])
    const deleted = applyClarinTextEdit({ format: withBreak, previousText: 'Título\nCuerpo', nextText: 'Título\nCuer' })
    expect(deleted.runs).toEqual([
      { from: 0, to: 6, marks: CLARIN_TEXT_MARK.BOLD },
      { from: 7, to: 11, marks: CLARIN_TEXT_MARK.ITALIC },
    ])
    expect(shouldInsertClarinTextLineBreak({ key: 'Enter', ctrlOrCmd: false, isComposing: false, keyCode: 13 })).toBe(true)
    expect(shouldInsertClarinTextLineBreak({ key: 'Enter', ctrlOrCmd: true, isComposing: false, keyCode: 13 })).toBe(false)
    expect(shouldInsertClarinTextLineBreak({ key: 'Enter', ctrlOrCmd: false, isComposing: true, keyCode: 229 })).toBe(false)
    expect(getClarinBeforeInputText({ inputType: 'insertParagraph', data: null, isComposing: false })).toBe('\n')
    expect(getClarinBeforeInputText({ inputType: 'insertText', data: 'C', isComposing: false })).toBe('C')
    expect(getClarinBeforeInputText({ inputType: 'insertText', data: '字', isComposing: true })).toBeNull()
  })

  it('uses the exact replaced range when identical text appears more than once', () => {
    const text = 'uno uno uno'
    const format = createClarinTextFormat(text, [
      { from: 0, to: 3, marks: CLARIN_TEXT_MARK.BOLD },
      { from: 8, to: 11, marks: CLARIN_TEXT_MARK.ITALIC },
    ])

    const deleted = replaceClarinTextRange({
      format,
      text,
      from: 4,
      to: 8,
      insertedText: '',
    })
    expect(deleted.text).toBe('uno uno')
    expect(deleted.format.runs).toEqual([
      { from: 0, to: 3, marks: CLARIN_TEXT_MARK.BOLD },
      { from: 4, to: 7, marks: CLARIN_TEXT_MARK.ITALIC },
    ])

    const inserted = replaceClarinTextRange({
      format: deleted.format,
      text: deleted.text,
      from: 4,
      to: 4,
      insertedText: 'nuevo ',
      insertedMarks: CLARIN_TEXT_MARK.UNDERLINE,
    })
    expect(inserted.text).toBe('uno nuevo uno')
    expect(inserted.format.runs).toEqual([
      { from: 0, to: 3, marks: CLARIN_TEXT_MARK.BOLD },
      { from: 4, to: 10, marks: CLARIN_TEXT_MARK.UNDERLINE },
      { from: 10, to: 13, marks: CLARIN_TEXT_MARK.ITALIC },
    ])
  })

  it('does not let an unformatted line break prevent removing a visible mark', () => {
    const text = 'Título\nCuerpo'
    const titleBold = createClarinTextFormat(text, [
      { from: 0, to: 6, marks: CLARIN_TEXT_MARK.BOLD },
    ])

    expect(
      getClarinMarkState(titleBold, text, 0, 7, CLARIN_TEXT_MARK.BOLD),
    ).toBe('on')
    expect(
      toggleClarinTextMark(titleBold, text, 0, 7, CLARIN_TEXT_MARK.BOLD).runs,
    ).toEqual([])
  })

  it('snaps selections to complete emoji and combining graphemes', () => {
    expect(snapClarinTextRange('A😀B', 2, 2)).toEqual([1, 3])
    expect(snapClarinTextRange('e\u0301x', 1, 1)).toEqual([0, 2])
    const emoji = toggleClarinTextMark(null, 'A😀B', 2, 2, CLARIN_TEXT_MARK.BOLD)
    expect(emoji.runs).toEqual([{ from: 1, to: 3, marks: CLARIN_TEXT_MARK.BOLD }])
  })

  it('supports Unicode and RTL offsets and rejects stale hashes', () => {
    const text = 'مرحبا mundo'
    const format = createClarinTextFormat(text, [{ from: 0, to: 5, marks: CLARIN_TEXT_MARK.ITALIC }])
    expect(validateClarinTextFormat(format, text)).toBe(true)
    expect(validateClarinTextFormat(format, `${text}!`)).toBe(false)
    expect(validateClarinTextFormat({ ...format, textHash: 1 }, text)).toBe(false)
    expect(validateClarinTextFormat({ ...format, future: true }, text)).toBe(false)
    expect(validateClarinTextFormat({
      ...format,
      runs: [{ ...format.runs[0], future: true }],
    }, text)).toBe(false)
  })

  it('maps wrapped visual lines back to the original formatted offsets', () => {
    const originalText = 'Título largo'
    const format = createClarinTextFormat(originalText, [{ from: 0, to: 6, marks: CLARIN_TEXT_MARK.BOLD }])
    const lines = getClarinVisualLines({
      originalText,
      text: 'Título\nlargo',
      customData: { clarinTextFormat: format },
    } as never)
    expect(lines[0].map(run => [run.text, run.marks])).toEqual([['Título', CLARIN_TEXT_MARK.BOLD]])
    expect(lines[1].map(run => [run.text, run.marks])).toEqual([['largo', 0]])
  })
})
