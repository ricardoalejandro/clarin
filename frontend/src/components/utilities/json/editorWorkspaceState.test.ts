import { describe, expect, it } from 'vitest'
import { acceptsEditorZoom, adjustFont, canCompare, DEFAULT_FONT, DIFF_LIMIT, documentWrapOptions, fontZoomPercent, MAX_FONT, MIN_FONT, repairPreview, tramRange, TRAM_LENGTH, visiblePanels } from './editorWorkspaceState'

describe('estado del espacio de edición', () => {
  it('keeps the selected document visible when the available area is narrow', () => {
    expect(visiblePanels('b', false, 1300)).toEqual(['b'])
    expect(visiblePanels('b', true, 700)).toEqual(['b'])
    expect(visiblePanels('b', true, 900)).toEqual(['a', 'b'])
  })

  it('scopes Ctrl + wheel to the focused editor and caps font sizes', () => {
    const event = { ctrlKey: true, altKey: false, metaKey: false, shiftKey: false, cancelable: true, deltaY: -120 }
    expect(acceptsEditorZoom(event, true)).toBe(true)
    expect(acceptsEditorZoom(event, false)).toBe(false)
    expect(acceptsEditorZoom({ ...event, ctrlKey: false }, true)).toBe(false)
    expect(acceptsEditorZoom({ ...event, cancelable: false }, true)).toBe(false)
    expect(adjustFont(28, 1)).toBe(29)
    expect(adjustFont(MAX_FONT, 1)).toBe(MAX_FONT)
    expect(adjustFont(MIN_FONT, -1)).toBe(MIN_FONT)
    expect(fontZoomPercent(DEFAULT_FONT)).toBe(100)
    expect(fontZoomPercent(MAX_FONT)).toBe(500)
  })

  it('keeps automatic wrapping for chunks and hides horizontal scrolling only when wrapping', () => {
    expect(documentWrapOptions(false, null)).toMatchObject({ wordWrap: 'off', scrollbar: { horizontal: 'auto' } })
    expect(documentWrapOptions(true, null)).toMatchObject({ wordWrap: 'on', scrollbar: { horizontal: 'hidden' } })
    expect(documentWrapOptions(false, 0)).toMatchObject({ wordWrap: 'bounded', scrollbar: { horizontal: 'hidden' } })
  })

  it('uses limits per document and preserves surrogate pairs between tramos', () => {
    const document = { bytes: DIFF_LIMIT, lines: 100_000, longestLine: 100_000 }
    expect(canCompare([document, document])).toBe(true)
    expect(canCompare([document, { ...document, longestLine: 100_001 }])).toBe(false)
    expect(canCompare([document, { ...document, bytes: DIFF_LIMIT + 1 }])).toBe(false)
    const source = 'a'.repeat(TRAM_LENGTH - 1) + '😀x'
    const codeAt = (index: number) => source.charCodeAt(index)
    expect(tramRange(source.length, 0, codeAt)).toEqual({ start: 0, end: TRAM_LENGTH - 1 })
    expect(tramRange(source.length, 1, codeAt)).toEqual({ start: TRAM_LENGTH - 1, end: source.length })
  })

  it('shows both sides of a repair and bounds the displayed excerpt', () => {
    expect(repairPreview('{mal:1}', '{"mal":1}')).toEqual({ before: '{mal:1}', after: '{"mal":1}' })
    expect(repairPreview('a'.repeat(10_000), 'b'.repeat(10_000)).after).toHaveLength(601)
  })
})
