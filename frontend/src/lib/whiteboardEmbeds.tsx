/**
 * Excalidraw falls back to an iframe only when this callback returns null or
 * undefined. A non-null empty React node therefore keeps legacy/imported web
 * embeds inert without opening any network surface.
 */
export function renderBlockedWhiteboardEmbeddable() {
  return <></>
}
