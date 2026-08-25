import { describe, expect, it } from 'vitest'
import {
  CLARIN_PARAGRAPH_FORMAT_KEY,
  CLARIN_TEXT_FORMAT_KEY,
  createClarinParagraphFormat,
  createClarinTextFormat,
  hashClarinText,
} from '@excalidraw/excalidraw/clarin-rich-text'
import {
  assertValidClarinRichTextScene,
  buildExcalidrawWhiteboardImportPlan,
  buildExcalidrawWhiteboardSavePayload,
  restoreClarinWhiteboardScene,
} from './whiteboardExcalidrawAdapter'

function linearElement(overrides: Record<string, unknown> = {}) {
  return {
    id: 'line-one',
    type: 'line',
    x: 0,
    y: 0,
    width: 20,
    height: 20,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: 'a0',
    roundness: null,
    seed: 1,
    version: 1,
    versionNonce: 2,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    points: [[0, 0], [20, 20]],
    lastCommittedPoint: [20, 20],
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: null,
    elbowed: false,
    unknownFutureElementField: { keep: true },
    ...overrides,
  }
}

function textElement(overrides: Record<string, unknown> = {}) {
  const originalText = typeof overrides.originalText === 'string'
    ? overrides.originalText
    : 'Título\nCuerpo'
  return {
    id: 'text-one',
    type: 'text',
    x: 0,
    y: 0,
    width: 160,
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
    index: 'a1',
    roundness: null,
    seed: 2,
    version: 1,
    versionNonce: 3,
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
    autoResize: true,
    lineHeight: 1.25,
    ...overrides,
  }
}

describe('Clarin Excalidraw format adapter', () => {
  it('restores through the official migrator while retaining the Clarin envelope', () => {
    const restored = restoreClarinWhiteboardScene({
      type: 'excalidraw',
      version: 1,
      source: 'legacy-import',
      elements: [linearElement(), linearElement({ id: 'deleted-restored', isDeleted: true })],
      appState: { viewBackgroundColor: '#f8fafc', zoom: 2 },
      files: { image: { id: 'image', mimeType: 'image/png', future: 'p3' } },
      futureRoot: { keep: true },
    })
    expect(restored.type).toBe('excalidraw')
    expect(restored.version).toBe(2)
    expect(restored.source).toBe('clarin')
    expect(restored.futureRoot).toEqual({ keep: true })
    expect(restored.elements).toHaveLength(2)
    expect((restored.elements[0] as Record<string, unknown>).unknownFutureElementField).toEqual({ keep: true })
    expect((restored.elements[1] as Record<string, unknown>).isDeleted).toBe(true)
    expect((restored.appState.zoom as { value: number }).value).toBe(2)
    expect(restored.files.image).toMatchObject({ future: 'p3' })
  })

  it('serializes live elements officially and retains realtime tombstones', () => {
    const payload = buildExcalidrawWhiteboardSavePayload({
      sceneSequence: 8,
      operationID: '00000000-0000-4000-8000-000000000001',
      reason: 'autosave',
      elements: [linearElement(), linearElement({ id: 'deleted-one', isDeleted: true })],
      patchElements: [linearElement(), linearElement({ id: 'deleted-one', isDeleted: true })],
      includePatch: true,
      appState: { viewBackgroundColor: '#ffffff', scrollX: 400, collaborators: { x: {} } },
      files: { image: { id: 'image', mimeType: 'image/png', dataURL: 'data:image/png;base64,AA==' } },
      rootExtensions: { futureRoot: 7 },
    })
    const live = payload.scene.elements.find(element => (element as { id?: string }).id === 'line-one') as Record<string, unknown>
    expect(live.lastCommittedPoint).toBeNull()
    expect(live.unknownFutureElementField).toEqual({ keep: true })
    expect(payload.scene.elements.map(element => (element as { id?: string }).id)).toContain('deleted-one')
    expect(payload.patch?.elements.map(element => (element as { id?: string }).id)).toContain('deleted-one')
    expect(payload.scene.appState).toEqual({ viewBackgroundColor: '#ffffff' })
    expect(payload.scene.files.image).not.toHaveProperty('dataURL')
    expect(payload.scene.futureRoot).toBe(7)
  })

  it('uses the same official boundary for imported snapshots', () => {
    const plan = buildExcalidrawWhiteboardImportPlan({
      name: '  Arquitectura visual  ',
      folderID: 'folder-one',
      operationID: '00000000-0000-4000-8000-000000000002',
      elements: [linearElement()],
      appState: { viewBackgroundColor: '#f8fafc', scrollY: 200 },
      files: {},
      rootExtensions: { unknownImportEnvelope: { keep: true } },
    })
    expect(plan.create).toEqual({ name: '  Arquitectura visual  ', folder_id: 'folder-one' })
    expect((plan.snapshot.scene.elements[0] as Record<string, unknown>).lastCommittedPoint).toBeNull()
    expect(plan.snapshot.scene.appState).toEqual({ viewBackgroundColor: '#f8fafc' })
    expect(plan.snapshot.scene.unknownImportEnvelope).toEqual({ keep: true })
  })

  it('preserves valid partial character and paragraph formatting through restore and persistence', () => {
    const originalText = 'Título\nCuerpo'
    const textFormat = createClarinTextFormat(originalText, [{ from: 0, to: 6, marks: 1 | 4 }])
    const paragraphFormat = createClarinParagraphFormat(originalText, 'left', [
      { start: 0, align: 'center' },
    ])
    const restored = restoreClarinWhiteboardScene({
      type: 'excalidraw',
      version: 2,
      elements: [textElement({ customData: {
        [CLARIN_TEXT_FORMAT_KEY]: textFormat,
        [CLARIN_PARAGRAPH_FORMAT_KEY]: paragraphFormat,
        future: 'keep',
      } })],
      appState: {},
      files: {},
    })
    const restoredText = restored.elements[0] as Record<string, unknown>
    expect(restoredText.customData).toMatchObject({
      [CLARIN_TEXT_FORMAT_KEY]: textFormat,
      [CLARIN_PARAGRAPH_FORMAT_KEY]: paragraphFormat,
      future: 'keep',
    })

    const payload = buildExcalidrawWhiteboardSavePayload({
      sceneSequence: 1,
      operationID: '00000000-0000-4000-8000-000000000003',
      reason: 'manual',
      elements: restored.elements,
      appState: {},
    })
    expect((payload.scene.elements[0] as Record<string, unknown>).customData).toMatchObject({
      [CLARIN_TEXT_FORMAT_KEY]: textFormat,
      [CLARIN_PARAGRAPH_FORMAT_KEY]: paragraphFormat,
      future: 'keep',
    })
  })

  it('shows stale historical formatting as plain text without dropping other metadata', () => {
    const originalText = 'Título\nCuerpo'
    const stale = { ...createClarinTextFormat(originalText, [{ from: 0, to: 6, marks: 1 }]), textHash: 7 }
    const restored = restoreClarinWhiteboardScene({
      type: 'excalidraw',
      version: 2,
      elements: [textElement({ customData: { clarinTextFormat: stale, future: { keep: true } } })],
      appState: {},
      files: {},
    })
    expect((restored.elements[0] as Record<string, unknown>).customData).toEqual({ future: { keep: true } })
  })

  it('drops only stale historical paragraph alignment and preserves other custom metadata', () => {
    const originalText = 'Título\nCuerpo'
    const textFormat = createClarinTextFormat(originalText, [{ from: 0, to: 6, marks: 1 }])
    const staleParagraphFormat = {
      ...createClarinParagraphFormat(originalText, 'left', [{ start: 0, align: 'center' }]),
      textHash: 7,
    }
    const restored = restoreClarinWhiteboardScene({
      type: 'excalidraw',
      version: 2,
      elements: [textElement({ customData: {
        [CLARIN_TEXT_FORMAT_KEY]: textFormat,
        [CLARIN_PARAGRAPH_FORMAT_KEY]: staleParagraphFormat,
        future: { keep: true },
      } })],
      appState: {},
      files: {},
    })
    expect((restored.elements[0] as Record<string, unknown>).customData).toEqual({
      [CLARIN_TEXT_FORMAT_KEY]: textFormat,
      future: { keep: true },
    })
  })

  it('rejects new invalid formatting instead of persisting mismatched character ranges', () => {
    const element = textElement({
      customData: {
        clarinTextFormat: {
          version: 1,
          textLength: 13,
          textHash: 7,
          runs: [{ from: 0, to: 6, marks: 1 }],
        },
      },
    })
    expect(() => buildExcalidrawWhiteboardSavePayload({
      sceneSequence: 1,
      operationID: '00000000-0000-4000-8000-000000000004',
      reason: 'autosave',
      elements: [element],
      appState: {},
    })).toThrow('Formato de texto enriquecido inválido')
  })

  it('rejects new invalid paragraph alignment instead of persisting stale offsets', () => {
    const originalText = 'Título\nCuerpo'
    const element = textElement({
      customData: {
        [CLARIN_PARAGRAPH_FORMAT_KEY]: {
          ...createClarinParagraphFormat(originalText, 'left', [
            { start: 0, align: 'center' },
          ]),
          textLength: originalText.length + 1,
        },
      },
    })
    expect(() => buildExcalidrawWhiteboardSavePayload({
      sceneSequence: 1,
      operationID: '00000000-0000-4000-8000-000000000005',
      reason: 'autosave',
      elements: [element],
      appState: {},
    })).toThrow('Formato de alineación de párrafos inválido')
  })

  it('rejects Clarin paragraph metadata attached to a non-text element', () => {
    const paragraphFormat = createClarinParagraphFormat('Uno', 'left', [
      { start: 0, align: 'center' },
    ])
    expect(() => assertValidClarinRichTextScene([
      linearElement({ customData: { [CLARIN_PARAGRAPH_FORMAT_KEY]: paragraphFormat } }),
    ])).toThrow('Formato de texto enriquecido inválido')
  })

  it('enforces the scene-wide rich text run limit', () => {
    const originalText = 'a'.repeat(4_096)
    const runs = Array.from({ length: 4_096 }, (_, index) => ({
      from: index,
      to: index + 1,
      marks: index % 2 ? 1 : 2,
    }))
    const element = textElement({
      originalText,
      text: originalText,
      customData: {
        clarinTextFormat: {
          version: 1,
          textLength: originalText.length,
          textHash: hashClarinText(originalText),
          runs,
        },
      },
    })
    expect(() => assertValidClarinRichTextScene(Array.from({ length: 13 }, () => element)))
      .toThrow('límite de segmentos')
  })

  it('shares one 50,000-segment scene budget between character runs and paragraph entries', () => {
    const runText = 'a'.repeat(4_096)
    const runElement = textElement({
      originalText: runText,
      text: runText,
      customData: {
        [CLARIN_TEXT_FORMAT_KEY]: {
          version: 1,
          textLength: runText.length,
          textHash: hashClarinText(runText),
          runs: Array.from({ length: 4_096 }, (_, index) => ({
            from: index,
            to: index + 1,
            marks: index % 2 ? 1 : 2,
          })),
        },
      },
    })
    const paragraphText = `${'\n'.repeat(4_095)}a`
    const paragraphElement = textElement({
      originalText: paragraphText,
      text: paragraphText,
      customData: {
        [CLARIN_PARAGRAPH_FORMAT_KEY]: createClarinParagraphFormat(
          paragraphText,
          'left',
          Array.from({ length: 4_096 }, (_, start) => ({ start, align: 'center' })),
        ),
      },
    })
    const tailElement = (count: number) => {
      const originalText = `${'\n'.repeat(count - 1)}a`
      return textElement({
        originalText,
        text: originalText,
        customData: {
          [CLARIN_PARAGRAPH_FORMAT_KEY]: createClarinParagraphFormat(
            originalText,
            'left',
            Array.from({ length: count }, (_, start) => ({ start, align: 'center' })),
          ),
        },
      })
    }

    expect(() => assertValidClarinRichTextScene([
      ...Array.from({ length: 6 }, () => runElement),
      ...Array.from({ length: 6 }, () => paragraphElement),
      tailElement(848),
    ])).not.toThrow()
    expect(() => assertValidClarinRichTextScene([
      ...Array.from({ length: 6 }, () => runElement),
      ...Array.from({ length: 6 }, () => paragraphElement),
      tailElement(849),
    ])).toThrow('límite de segmentos')
  })
})
