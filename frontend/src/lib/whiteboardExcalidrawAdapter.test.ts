import { describe, expect, it } from 'vitest'
import {
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
})
