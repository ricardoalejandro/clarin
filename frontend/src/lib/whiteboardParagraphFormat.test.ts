import { describe, expect, it } from 'vitest'

import {
  applyClarinParagraphTextEdit,
  CLARIN_PARAGRAPH_FORMAT_KEY,
  createClarinParagraphFormat,
  getClarinEffectiveParagraphAlignment,
  getClarinParagraphAlignmentState,
  getClarinParagraphFormat,
  getClarinParagraphStartAtCaret,
  getClarinParagraphStarts,
  getClarinTouchedParagraphStarts,
  MAX_CLARIN_PARAGRAPH_ENTRIES_PER_ELEMENT,
  setClarinParagraphAlignment,
  updateClarinParagraphCustomData,
  validateClarinParagraphFormat,
} from '@excalidraw/excalidraw/clarin-rich-text'

describe('Clarin paragraph alignment model', () => {
  it('canonicalizes paragraph overrides using UTF-16 paragraph starts', () => {
    const text = 'Título\nCuerpo\n'
    const format = createClarinParagraphFormat(text, 'left', [
      { start: text.length, align: 'right' },
      { start: 7, align: 'left' },
      { start: 0, align: 'right' },
      { start: 0, align: 'center' },
      { start: 13, align: 'right' },
      { start: 7, align: 'center' },
      { start: 7, align: 'left' },
    ])

    expect(getClarinParagraphStarts(text)).toEqual([0, 7, 14])
    expect(format.paragraphs).toEqual([
      { start: 0, align: 'center' },
      { start: 14, align: 'right' },
    ])
    expect(validateClarinParagraphFormat(format, text, 'left')).toBe(true)
    expect(validateClarinParagraphFormat(format, `${text}x`, 'left')).toBe(false)
    expect(validateClarinParagraphFormat({ ...format, extra: true }, text, 'left')).toBe(false)
    expect(validateClarinParagraphFormat({
      ...format,
      paragraphs: [{ start: 7, align: 'left' }],
    }, text, 'left')).toBe(false)
    expect(validateClarinParagraphFormat({
      ...format,
      paragraphs: [{ start: 13, align: 'right' }],
    }, text, 'left')).toBe(false)
  })

  it('allows only the final empty paragraph at textLength and enforces the entry limit', () => {
    const withoutFinalEmpty = createClarinParagraphFormat('Uno', 'left', [
      { start: 3, align: 'center' },
    ])
    expect(withoutFinalEmpty.paragraphs).toEqual([])

    const text = '\n'.repeat(MAX_CLARIN_PARAGRAPH_ENTRIES_PER_ELEMENT)
    const paragraphs = getClarinParagraphStarts(text).map(start => ({
      start,
      align: 'center' as const,
    }))
    const tooMany = {
      version: 1,
      textLength: text.length,
      textHash: createClarinParagraphFormat(text, 'left', []).textHash,
      paragraphs,
    }
    expect(paragraphs).toHaveLength(MAX_CLARIN_PARAGRAPH_ENTRIES_PER_ELEMENT + 1)
    expect(validateClarinParagraphFormat(tooMany, text, 'left')).toBe(false)
    expect(createClarinParagraphFormat(text, 'left', paragraphs).paragraphs).toHaveLength(
      MAX_CLARIN_PARAGRAPH_ENTRIES_PER_ELEMENT,
    )
  })

  it('reads and updates customData without disturbing unrelated extensions', () => {
    const text = 'Título\nCuerpo'
    const format = createClarinParagraphFormat(text, 'left', [
      { start: 0, align: 'center' },
    ])
    const customData = updateClarinParagraphCustomData({ retained: 1 }, format)
    expect(customData).toEqual({ retained: 1, [CLARIN_PARAGRAPH_FORMAT_KEY]: format })
    expect(getClarinParagraphFormat({
      originalText: text,
      textAlign: 'left',
      customData,
    } as never)).toEqual(format)
    expect(getClarinParagraphFormat({
      originalText: `${text}!`,
      textAlign: 'left',
      customData,
    } as never)).toBeNull()
    expect(updateClarinParagraphCustomData(customData, null)).toEqual({ retained: 1 })
    expect(updateClarinParagraphCustomData(undefined, null)).toBeUndefined()
  })

  it('resolves half-open selections, newlines and the final empty paragraph', () => {
    const text = 'Uno\nDos\n'
    expect(getClarinParagraphStartAtCaret(text, 3)).toBe(0)
    expect(getClarinParagraphStartAtCaret(text, 4)).toBe(4)
    expect(getClarinParagraphStartAtCaret(text, text.length)).toBe(8)
    expect(getClarinTouchedParagraphStarts(text, 3, 4)).toEqual([0])
    expect(getClarinTouchedParagraphStarts(text, 0, 4)).toEqual([0])
    expect(getClarinTouchedParagraphStarts(text, 4, 5)).toEqual([4])
    expect(getClarinTouchedParagraphStarts(text, 3, 5)).toEqual([0, 4])
    expect(getClarinTouchedParagraphStarts(text, 5, 3)).toEqual([0, 4])
    expect(getClarinTouchedParagraphStarts(text, text.length, text.length)).toEqual([8])
  })

  it('reports effective and mixed alignment over every touched paragraph', () => {
    const text = 'Título\nCuerpo'
    const format = createClarinParagraphFormat(text, 'left', [
      { start: 0, align: 'center' },
    ])
    expect(getClarinEffectiveParagraphAlignment(format, text, 'left', 0)).toBe('center')
    expect(getClarinEffectiveParagraphAlignment(format, text, 'left', 7)).toBe('left')
    expect(getClarinParagraphAlignmentState(format, text, 'left', 1, 3)).toBe('center')
    expect(getClarinParagraphAlignmentState(format, text, 'left', 0, text.length)).toBe('mixed')
  })

  it('sets selected paragraphs and promotes a uniform result to textAlign', () => {
    const text = 'Título\nCuerpo'
    const titleCentered = setClarinParagraphAlignment({
      format: null,
      text,
      textAlign: 'left',
      from: 1,
      to: 3,
      align: 'center',
    })
    expect(titleCentered).toEqual({
      textAlign: 'left',
      format: createClarinParagraphFormat(text, 'left', [
        { start: 0, align: 'center' },
      ]),
    })

    const allCentered = setClarinParagraphAlignment({
      format: titleCentered.format,
      text,
      textAlign: titleCentered.textAlign,
      from: 7,
      to: 7,
      align: 'center',
    })
    expect(allCentered).toEqual({ textAlign: 'center', format: null })

    const allRight = setClarinParagraphAlignment({
      format: titleCentered.format,
      text,
      textAlign: titleCentered.textAlign,
      from: 0,
      to: text.length,
      align: 'right',
    })
    expect(allRight).toEqual({ textAlign: 'right', format: null })
  })

  it('inherits alignment when Enter splits a paragraph and preserves later paragraphs', () => {
    const previousText = 'Título\nCuerpo'
    const format = createClarinParagraphFormat(previousText, 'left', [
      { start: 0, align: 'center' },
    ])
    const result = applyClarinParagraphTextEdit({
      format,
      previousText,
      textAlign: 'left',
      edit: { from: 3, to: 3, insertedText: '\n' },
    })

    expect(result.nextText).toBe('Tít\nulo\nCuerpo')
    expect(result.textAlign).toBe('left')
    expect(result.format?.paragraphs).toEqual([
      { start: 0, align: 'center' },
      { start: 4, align: 'center' },
    ])
    expect(getClarinParagraphAlignmentState(
      result.format,
      result.nextText,
      result.textAlign,
      0,
      7,
    )).toBe('center')
  })

  it('keeps the leading paragraph alignment when deleting a newline', () => {
    const previousText = 'Título\nCuerpo'
    const format = createClarinParagraphFormat(previousText, 'left', [
      { start: 0, align: 'center' },
    ])
    const result = applyClarinParagraphTextEdit({
      format,
      previousText,
      textAlign: 'left',
      edit: { from: 6, to: 7, insertedText: '' },
    })

    expect(result).toEqual({
      nextText: 'TítuloCuerpo',
      textAlign: 'center',
      format: null,
    })
  })

  it('preserves alignment for a text-identical replacement', () => {
    const previousText = 'Título\nCuerpo'
    const format = createClarinParagraphFormat(previousText, 'left', [
      { start: 0, align: 'center' },
      { start: 7, align: 'right' },
    ])
    const result = applyClarinParagraphTextEdit({
      format,
      previousText,
      textAlign: 'left',
      edit: { from: 6, to: 7, insertedText: '\n' },
    })

    expect(result).toEqual({
      nextText: previousText,
      textAlign: 'left',
      format,
    })
  })

  it('preserves a surviving paragraph boundary and shifts it by UTF-16 length', () => {
    const previousText = '😀 Uno\nDos\nTres'
    const format = createClarinParagraphFormat(previousText, 'left', [
      { start: 7, align: 'center' },
      { start: 11, align: 'right' },
    ])
    const result = applyClarinParagraphTextEdit({
      format,
      previousText,
      textAlign: 'left',
      edit: { from: 7, to: 10, insertedText: '二\n三' },
    })

    expect(result.nextText).toBe('😀 Uno\n二\n三\nTres')
    expect(getClarinParagraphStarts(result.nextText)).toEqual([0, 7, 9, 11])
    expect(result.format?.paragraphs).toEqual([
      { start: 7, align: 'center' },
      { start: 9, align: 'center' },
      { start: 11, align: 'right' },
    ])
  })

  it('keeps the paragraph whose boundary survives when its content is replaced', () => {
    const previousText = 'Uno\nDos\nTres'
    const format = createClarinParagraphFormat(previousText, 'left', [
      { start: 4, align: 'center' },
      { start: 8, align: 'right' },
    ])
    const result = applyClarinParagraphTextEdit({
      format,
      previousText,
      textAlign: 'left',
      edit: { from: 4, to: 8, insertedText: 'Segundo' },
    })

    expect(result.nextText).toBe('Uno\nSegundoTres')
    expect(result.format?.paragraphs).toEqual([{ start: 4, align: 'center' }])
    expect(getClarinParagraphAlignmentState(
      result.format,
      result.nextText,
      result.textAlign,
      4,
      4,
    )).toBe('center')
  })
})
