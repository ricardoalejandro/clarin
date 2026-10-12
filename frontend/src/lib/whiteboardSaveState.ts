import { hasWhiteboardDocumentMutation, snapshotWhiteboardFiles } from './whiteboards'

interface ObservedScene {
  elements: readonly unknown[]
  appState: object
  files: object
}

/** Freeze the document before asynchronous asset preparation, not afterwards. */
export function captureWhiteboardScene<T extends ObservedScene>(scene: T): T {
  return {
    ...scene,
    // Elements/customData are the JSON document. In particular, points and
    // bindings must not alias an element still being edited while uploads run.
    elements: JSON.parse(JSON.stringify(scene.elements)) as T['elements'],
    appState: { ...scene.appState },
    files: snapshotWhiteboardFiles(scene.files as Record<string, unknown>),
  } as T
}

/**
 * Publish the exact programmatic baseline before Excalidraw can emit onChange.
 * No frame-wide suppression: the next real gesture is observable immediately.
 */
export function applyWhiteboardProgrammaticScene<T>(
  latest: { current: T | null },
  scene: T,
  update: () => void,
) {
  latest.current = scene
  update()
}

export function observeWhiteboardScene<T extends ObservedScene>(
  latest: { current: T | null },
  scene: T,
) {
  const previous = latest.current
  latest.current = {
    ...scene,
    elements: scene.elements.map(element => ({ ...(element as object) })),
    files: snapshotWhiteboardFiles(scene.files as Record<string, unknown>),
  } as T
  return !previous || hasWhiteboardDocumentMutation({
    currentElements: scene.elements,
    previousElements: previous.elements,
    currentAppState: scene.appState as Record<string, unknown>,
    previousAppState: previous.appState as Record<string, unknown>,
    currentFiles: scene.files as Record<string, unknown>,
    previousFiles: previous.files as Record<string, unknown>,
  })
}

/** Only a specific server rejection proves that this operation did not commit. */
export function whiteboardMissingAssetIDs(code: unknown, fileIDs: unknown): string[] {
  if (code !== 'whiteboard_assets_missing' || !Array.isArray(fileIDs)) return []
  return Array.from(new Set(fileIDs.filter((id): id is string => typeof id === 'string' && id.length > 0)))
}
