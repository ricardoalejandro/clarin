export const WHITEBOARD_EDITOR_VERSION = '0.18.1-clarin.4'
export const WHITEBOARD_EDITOR_ASSET_PATH = `/vendor/whiteboards-editor/${WHITEBOARD_EDITOR_VERSION}/`

/**
 * Excalidraw constructs every font URL against this base. Keep it absolute so
 * the URL constructor never receives two relative values, and keep it bound to
 * the active Clarin origin so no deployment can fall back to an upstream CDN.
 */
export function whiteboardEditorAssetBase(origin: string) {
  const parsedOrigin = new URL(origin)
  if (!['http:', 'https:'].includes(parsedOrigin.protocol) || parsedOrigin.origin === 'null') {
    throw new TypeError('El origen de assets de Pizarras debe ser HTTP(S).')
  }
  return new URL(WHITEBOARD_EDITOR_ASSET_PATH, parsedOrigin.origin).href
}
