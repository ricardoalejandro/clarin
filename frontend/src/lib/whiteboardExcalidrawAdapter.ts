import { restore, serializeAsJSON } from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types'
import {
  buildWhiteboardImportPlan,
  buildWhiteboardSavePayload,
  type WhiteboardSavePayload,
  type WhiteboardSceneDocument,
} from './whiteboards'

function sceneRecord(value: unknown) {
  const candidate = typeof value === 'string' ? JSON.parse(value) as unknown : value
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : {}
}

/**
 * Canonical restoration boundary for every Clarin whiteboard snapshot.
 *
 * Excalidraw owns element migration, binding repair and app-state defaults.
 * Clarin owns the root envelope and private binary metadata. Keeping those
 * responsibilities separate lets future upstream formats migrate without
 * turning Excalidraw into a storage or network provider.
 */
export function restoreClarinWhiteboardScene(value: unknown): WhiteboardSceneDocument {
  const parsed = sceneRecord(value)
  const elements = Array.isArray(parsed.elements) ? parsed.elements : []
  const appState = parsed.appState && typeof parsed.appState === 'object' && !Array.isArray(parsed.appState)
    ? parsed.appState as Record<string, unknown>
    : {}
  const files = parsed.files && typeof parsed.files === 'object' && !Array.isArray(parsed.files)
    ? parsed.files as Record<string, unknown>
    : {}
  const restored = restore({ elements, appState, files: {} } as never, null, null, {
    refreshDimensions: false,
    repairBindings: true,
  })
  return {
    ...parsed,
    type: 'excalidraw',
    version: 2,
    source: 'clarin',
    elements: restored.elements,
    appState: restored.appState as unknown as Record<string, unknown>,
    files,
  }
}

function serializeElementsForDatabase(
  elements: readonly unknown[],
  appState: Record<string, unknown>,
) {
  const core = JSON.parse(serializeAsJSON(
    elements as readonly ExcalidrawElement[],
    appState as Partial<AppState>,
    {} as BinaryFiles,
    'database',
  )) as { elements?: readonly unknown[]; appState?: Record<string, unknown> }
  const serializedByID = new Map((core.elements || []).flatMap(element => {
    if (!element || typeof element !== 'object' || Array.isArray(element)) return []
    const id = (element as { id?: unknown }).id
    return typeof id === 'string' && id ? [[id, element] as const] : []
  }))
  // The upstream database serializer intentionally drops deleted elements.
  // Realtime reconciliation still needs those tombstones until the canonical
  // sequence is acknowledged, so retain only the omitted input entries while
  // taking every live element from the official serializer.
  const serialized = elements.map(element => {
    const id = element && typeof element === 'object' && !Array.isArray(element)
      ? (element as { id?: unknown }).id
      : null
    return typeof id === 'string' && serializedByID.has(id) ? serializedByID.get(id) : element
  })
  return { elements: serialized, appState: core.appState || {} }
}

/** Uses Excalidraw's official database serializer before Clarin persistence. */
export function buildExcalidrawWhiteboardSavePayload(input: {
  sceneSequence: number
  operationID: string
  reason: 'autosave' | 'manual' | 'import'
  elements: readonly unknown[]
  appState: Record<string, unknown>
  files?: Record<string, unknown>
  includePatch?: boolean
  patchElements?: readonly unknown[]
  rootExtensions?: Record<string, unknown>
}): WhiteboardSavePayload {
  const officialScene = serializeElementsForDatabase(input.elements, input.appState)
  const officialPatch = input.includePatch
    ? serializeElementsForDatabase(input.patchElements || input.elements, input.appState)
    : null
  return buildWhiteboardSavePayload({
    ...input,
    elements: officialScene.elements,
    appState: officialScene.appState,
    patchElements: officialPatch?.elements,
  })
}

export function buildExcalidrawWhiteboardImportPlan(input: {
  name: string
  folderID?: string | null
  operationID: string
  elements: readonly unknown[]
  appState: Record<string, unknown>
  files?: Record<string, unknown>
  rootExtensions?: Record<string, unknown>
}) {
  const base = buildWhiteboardImportPlan(input)
  return {
    ...base,
    snapshot: buildExcalidrawWhiteboardSavePayload({
      sceneSequence: 0,
      operationID: input.operationID,
      reason: 'import',
      elements: input.elements,
      appState: input.appState,
      files: input.files,
      rootExtensions: input.rootExtensions,
      includePatch: false,
    }),
  }
}
