import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  loadFromBlob,
  loadLibraryFromBlob,
  serializeAsJSON,
  serializeLibraryAsJSON,
} from '@excalidraw/excalidraw'
import { whiteboardSceneRootExtensions } from './whiteboards'
import {
  buildExcalidrawWhiteboardSavePayload,
  restoreClarinWhiteboardScene,
} from './whiteboardExcalidrawAdapter'

const fixturesRoot = resolve(process.cwd(), '../.codex/skills/clarin-excalidraw-development/assets/compat-fixtures/v0.18.1')

function fixture(name: string) {
  return JSON.parse(readFileSync(resolve(fixturesRoot, name), 'utf8')) as Record<string, any>
}

function jsonBlob(value: unknown) {
  return new Blob([JSON.stringify(value)], { type: 'application/json' })
}

function rootExtensions(value: Record<string, any>, known: readonly string[]) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !known.includes(key)))
}

function safeFileMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeFileMetadata)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['dataURL', 'url', 'src'].includes(key))
    .map(([key, child]) => [key, safeFileMetadata(child)]))
}

describe('Excalidraw 0.18.1 historical format corpus', () => {
  it('keeps a versioned scene and library corpus discoverable by the release gate', () => {
    expect(readdirSync(fixturesRoot).sort()).toEqual([
      'complex-scene.excalidraw',
      'freedraw-pressure.excalidraw',
      'image-import.excalidraw',
      'internal-library.excalidrawlib',
    ])
  })

  for (const name of ['complex-scene.excalidraw', 'image-import.excalidraw']) {
    it(`opens, edits, saves, exports, and reopens ${name} through upstream APIs`, async () => {
      const source = fixture(name)
      const sourceElements = source.elements as Array<Record<string, any>>
      const restoredByClarin = restoreClarinWhiteboardScene(source)
      const opened = await loadFromBlob(jsonBlob(source), null, null)
      expect(restoredByClarin.elements.map(element => (element as Record<string, any>).id)).toEqual(sourceElements.map(element => element.id))
      expect(opened.elements.map(element => element.id)).toEqual(sourceElements.map(element => element.id))
      if (name === 'complex-scene.excalidraw') {
        expect(opened.appState.frameRendering).toEqual(source.appState.frameRendering)
        expect(opened.elements.find(element => element.type === 'frame')?.id).toBe('frame-operaciones')
        expect((opened.elements.find(element => element.id === 'arrow-proceso') as unknown as Record<string, any>)?.startBinding?.elementId).toBe('node-entrada')
        expect(opened.elements.find(element => element.id === 'mermaid-edge')?.customData).toMatchObject({ clarinFixtureOrigin: 'mermaid-converted' })
        expect(opened.elements.map(element => element.link).filter(Boolean).sort()).toEqual([
          'https://clarin.example.invalid/manual',
          'mailto:operaciones@example.invalid',
        ])
      }

      const editableID = opened.elements.find(element => element.type !== 'frame')!.id
      const edited = opened.elements.map(element => element.id === editableID
        ? { ...element, x: element.x + 7, version: element.version + 1, versionNonce: 424242 }
        : element)
      const saved = buildExcalidrawWhiteboardSavePayload({
        sceneSequence: 3,
        operationID: `compat-${name}`,
        reason: 'manual',
        elements: edited,
        appState: source.appState,
        files: source.files,
        rootExtensions: whiteboardSceneRootExtensions(source),
      }).scene

      expect(saved.files).toEqual(safeFileMetadata(source.files))
      expect(JSON.stringify(saved.files)).not.toMatch(/dataURL|\"url\"|\"src\"/)
      expect(saved.futureSceneMetadata ?? saved.unknownImportEnvelope).toEqual(source.futureSceneMetadata ?? source.unknownImportEnvelope)
      expect(saved.appState).toEqual(Object.fromEntries(
        ['viewBackgroundColor', 'gridSize', 'gridStep', 'gridModeEnabled']
          .filter(key => Object.hasOwn(source.appState, key))
          .map(key => [key, source.appState[key]]),
      ))
      expect(saved.appState).not.toHaveProperty('frameRendering')
      expect(saved.appState).not.toHaveProperty('theme')
      expect(saved.appState).not.toHaveProperty('selectedElementIds')
      expect(saved.appState).not.toHaveProperty('futureAppStateProperty')

      const localExportCore = JSON.parse(serializeAsJSON(edited as never, opened.appState, opened.files, 'local')) as Record<string, any>
      const localExport = { ...whiteboardSceneRootExtensions(source), ...localExportCore }
      const reopened = await loadFromBlob(jsonBlob(localExport), null, null)
      const reopenedEdited = reopened.elements.find(element => element.id === editableID) as Record<string, any>
      expect(reopenedEdited.x).toBe(sourceElements.find(element => element.id === editableID)!.x + 7)
      expect(reopenedEdited.version).toBe(sourceElements.find(element => element.id === editableID)!.version + 1)

      for (const element of sourceElements) {
        const next = reopened.elements.find(candidate => candidate.id === element.id) as Record<string, any>
        expect(next?.customData).toEqual(element.customData)
        for (const [key, value] of Object.entries(element).filter(([key]) => /^(?:future|unknown|x[-_])/i.test(key))) {
          expect(next?.[key]).toEqual(value)
        }
      }
      expect(Object.keys(reopened.files).sort()).toEqual(Object.keys(source.files).sort())
      expect(localExport.futureSceneMetadata ?? localExport.unknownImportEnvelope).toEqual(source.futureSceneMetadata ?? source.unknownImportEnvelope)
    })
  }

  it('round-trips legacy, constant, and variable freedraw pressure modes', async () => {
    const source = fixture('freedraw-pressure.excalidraw')
    const sourceByID = new Map((source.elements as Array<Record<string, any>>).map(element => [element.id, element]))
    expect(sourceByID.get('freedraw-legacy')).not.toHaveProperty('strokeOptions')

    const restoredByClarin = restoreClarinWhiteboardScene(source)
    const opened = await loadFromBlob(jsonBlob(source), null, null)
    const restoredClarinByID = new Map(restoredByClarin.elements.map(element => {
      const restoredElement = element as unknown as Record<string, any>
      return [restoredElement.id, restoredElement] as const
    }))
    const openedByID = new Map(opened.elements.map(element => [
      element.id,
      element as unknown as Record<string, any>,
    ]))
    const expectedVariability = {
      'freedraw-legacy': 'variable',
      'freedraw-constant': 'constant',
      'freedraw-variable': 'variable',
    } as const

    for (const [id, variability] of Object.entries(expectedVariability)) {
      const original = sourceByID.get(id)!
      const clarinElement = restoredClarinByID.get(id)!
      const openedElement = openedByID.get(id)!
      expect(clarinElement.strokeOptions).toEqual({ variability, streamline: 0.5 })
      expect(openedElement.strokeOptions).toEqual({ variability, streamline: 0.5 })
      for (const field of ['points', 'pressures', 'simulatePressure', 'strokeWidth', 'opacity'] as const) {
        expect(clarinElement[field]).toEqual(original[field])
        expect(openedElement[field]).toEqual(original[field])
      }
    }

    const saved = buildExcalidrawWhiteboardSavePayload({
      sceneSequence: 5,
      operationID: 'compat-freedraw-pressure',
      reason: 'manual',
      elements: opened.elements,
      appState: {
        ...opened.appState,
        currentItemStrokeVariability: 'variable',
      },
      files: opened.files,
      rootExtensions: whiteboardSceneRootExtensions(source),
    }).scene
    expect(saved.appState).toMatchObject({ viewBackgroundColor: '#ffffff' })
    expect(saved.appState).not.toHaveProperty('currentItemStrokeVariability')
    expect(saved.futurePressureFixtureMetadata).toEqual({ synthetic: true })

    const localExport = JSON.parse(serializeAsJSON(
      opened.elements,
      opened.appState,
      opened.files,
      'local',
    )) as Record<string, any>
    const reopened = await loadFromBlob(jsonBlob(localExport), null, null)
    const reopenedByID = new Map(reopened.elements.map(element => [
      element.id,
      element as unknown as Record<string, any>,
    ]))
    for (const [id, variability] of Object.entries(expectedVariability)) {
      const original = sourceByID.get(id)!
      const reopenedElement = reopenedByID.get(id)!
      expect(reopenedElement.strokeOptions).toEqual({ variability, streamline: 0.5 })
      expect(reopenedElement.points).toEqual(original.points)
      expect(reopenedElement.pressures).toEqual(original.pressures)
      expect(reopenedElement.simulatePressure).toBe(original.simulatePressure)
    }
  })

  it('round-trips an internal .excalidrawlib without losing opaque item or element fields', async () => {
    const source = fixture('internal-library.excalidrawlib')
    const opened = await loadLibraryFromBlob(jsonBlob(source), 'unpublished')
    const edited = opened.map((item, index) => index === 0 ? { ...item, name: `${item.name} · editada` } : item)
    const serializedCore = JSON.parse(serializeLibraryAsJSON(edited as never)) as Record<string, any>
    const serialized = {
      ...rootExtensions(source, ['type', 'version', 'source', 'libraryItems']),
      ...serializedCore,
    }
    const reopened = await loadLibraryFromBlob(jsonBlob(serialized), 'unpublished')

    expect(reopened.map(item => item.id)).toEqual(source.libraryItems.map((item: Record<string, any>) => item.id))
    expect(reopened[0].name).toBe('Tarjeta operativa · editada')
    expect((reopened[0] as unknown as Record<string, any>).futureLibraryItemProperty).toEqual({ catalog: 'account' })
    expect((reopened[0].elements[0] as unknown as Record<string, any>).futureLibraryElementProperty).toEqual({ semanticRole: 'card' })
    expect(serialized.futureLibraryMetadata).toEqual(source.futureLibraryMetadata)
  })
})
