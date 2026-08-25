import { afterEach, describe, expect, it, vi } from 'vitest'
import { exportToSvg } from '@excalidraw/excalidraw'
import {
  createClarinParagraphFormat,
  getClarinSvgTextAnchor,
  getClarinVisualLineLayouts,
  getClarinVisualLineOriginalOffsets,
} from '@excalidraw/excalidraw/clarin-rich-text'

describe('Clarin paragraph alignment renderer mapping', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps SVG alignment physical for both LTR and RTL text directions', () => {
    expect(getClarinSvgTextAnchor('left', 'ltr')).toBe('start')
    expect(getClarinSvgTextAnchor('right', 'ltr')).toBe('end')
    expect(getClarinSvgTextAnchor('left', 'rtl')).toBe('end')
    expect(getClarinSvgTextAnchor('right', 'rtl')).toBe('start')
    expect(getClarinSvgTextAnchor('center', 'ltr')).toBe('middle')
    expect(getClarinSvgTextAnchor('center', 'rtl')).toBe('middle')
  })

  it('keeps soft-wrapped lines in their original logical paragraph', () => {
    const originalText = '😀 título largo\nCuerpo\n'
    const visualText = '😀 título\nlargo\nCuerpo\n'

    expect(getClarinVisualLineOriginalOffsets(originalText, visualText)).toEqual([
      0,
      10,
      16,
      23,
    ])
  })

  it('maps empty paragraphs after trimmed whitespace to exact UTF-16 starts', () => {
    const originalText = 'Primero   \n\nÚltimo'
    const visualText = 'Primero\n\nÚltimo'

    expect(getClarinVisualLineOriginalOffsets(originalText, visualText)).toEqual([
      0,
      11,
      12,
    ])
  })

  it('resolves a different alignment for each paragraph and every wrapped line', () => {
    const originalText = '😀 título largo\nCuerpo\n'
    const format = createClarinParagraphFormat(originalText, 'left', [
      { start: 16, align: 'center' },
      { start: 23, align: 'right' },
    ])

    expect(getClarinVisualLineLayouts({
      originalText,
      text: '😀 título\nlargo\nCuerpo\n',
      textAlign: 'left',
      customData: { clarinParagraphFormat: format },
    } as never)).toEqual([
      { originalOffset: 0, paragraphStart: 0, textAlign: 'left' },
      { originalOffset: 10, paragraphStart: 0, textAlign: 'left' },
      { originalOffset: 16, paragraphStart: 16, textAlign: 'center' },
      { originalOffset: 23, paragraphStart: 23, textAlign: 'right' },
    ])
  })

  it('falls back to the element alignment when paragraph metadata is stale', () => {
    const originalText = 'Uno\nDos'
    const format = createClarinParagraphFormat(originalText, 'left', [
      { start: 4, align: 'center' },
    ])

    expect(getClarinVisualLineLayouts({
      originalText,
      text: originalText,
      textAlign: 'left',
      customData: {
        clarinParagraphFormat: { ...format, textHash: format.textHash + 1 },
      },
    } as never).map(line => line.textAlign)).toEqual(['left', 'left'])
  })

  it('exports each paragraph with its own SVG anchor and horizontal position', async () => {
    vi.stubGlobal('FontFace', class FontFaceMock {
      family: string
      status = 'unloaded'

      constructor(family: string) {
        this.family = family
      }

      load() {
        this.status = 'loaded'
        return Promise.resolve(this)
      }
    })
    const originalText = 'Título\nCuerpo'
    const format = createClarinParagraphFormat(originalText, 'left', [
      { start: 0, align: 'center' },
      { start: 7, align: 'right' },
    ])
    const element = {
      id: 'partial-paragraph-alignment',
      type: 'text',
      x: 0,
      y: 0,
      width: 200,
      height: 50,
      angle: 0,
      strokeColor: '#1e1e1e',
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 1,
      strokeStyle: 'solid',
      roughness: 0,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: null,
      index: null,
      seed: 1,
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      boundElements: null,
      updated: 1,
      link: null,
      locked: false,
      fontSize: 20,
      fontFamily: 1,
      text: originalText,
      originalText,
      textAlign: 'left',
      verticalAlign: 'top',
      containerId: null,
      lineHeight: 1.25,
      autoResize: false,
      customData: { clarinParagraphFormat: format },
    }

    const svg = await exportToSvg({
      elements: [element] as never,
      files: {},
      appState: {
        exportBackground: false,
        viewBackgroundColor: '#ffffff',
      },
      exportPadding: 0,
      skipInliningFonts: true,
    })
    const lines = Array.from(
      (svg as SVGSVGElement).querySelectorAll<SVGTextElement>('text'),
    )

    expect(lines).toHaveLength(2)
    expect(lines.map(line => line.getAttribute('x'))).toEqual(['100', '200'])
    expect(lines.map(line => line.getAttribute('text-anchor'))).toEqual([
      'middle',
      'end',
    ])
  })
})
