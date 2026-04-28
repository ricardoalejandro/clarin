// Barrel export for fabric library modules
export { createEditorCanvas, zoomIn, zoomOut, zoomToFit, drawGridDots, resizeCanvas, resizePageRect, getPageObjects, ensurePageAtBottom, setPasteboardColor, DEFAULT_PASTEBOARD_COLOR, applyWheelZoom, applyWheelPan } from './canvas'
export { DynamicText } from './objects'
export { CanvasHistory } from './history'
export { calculateSnap, calculateDistances, type SnapGuide, type DistanceLabel, type UserGuide } from './snap'
export { exportCanvasToBlob, downloadBlob, type ExportOptions } from './export'
export {
  canvasToTemplateJson,
  loadTemplateToCanvas,
  ensureFontsLoaded,
  extractFieldsUsed,
} from './serialization'
export { setupShortcuts, type ShortcutActions } from './shortcuts'
export * from './constants'
export { formatFieldValue, DATE_PRESETS, DEFAULT_FIELD_FORMAT, type FieldFormat, type FieldFormatType, type TextTransform } from '../dynamicFieldFormat'
