// Barrel export for fabric library modules
export { createEditorCanvas, zoomIn, zoomOut, zoomToFit, drawGridDots, resizeCanvas, resizePageRect, getPageObjects, ensurePageAtBottom, setPasteboardColor, DEFAULT_PASTEBOARD_COLOR } from './canvas'
export { DynamicText } from './objects'
export { CanvasHistory } from './history'
export { calculateSnap, type SnapGuide, type UserGuide } from './snap'
export { exportCanvasToBlob, downloadBlob, type ExportOptions } from './export'
export {
  canvasToTemplateJson,
  loadTemplateToCanvas,
  ensureFontsLoaded,
  extractFieldsUsed,
} from './serialization'
export { setupShortcuts, type ShortcutActions } from './shortcuts'
export * from './constants'
