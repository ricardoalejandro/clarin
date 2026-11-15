export const LIBRARY_SIDEBAR_WIDTH = 224
export const LIBRARY_MIN_EDITOR_WIDTH = 840
export const LIBRARY_SIDEBAR_BREAKPOINT = LIBRARY_SIDEBAR_WIDTH + LIBRARY_MIN_EDITOR_WIDTH
export const LIBRARY_COMPACT_BREAKPOINT = 640

export function libraryLayout(availableWidth: number, libraryOpen = false) {
  const width = Number.isFinite(availableWidth) ? Math.max(0, availableWidth) : 0
  const sidebar = libraryOpen && width >= LIBRARY_SIDEBAR_BREAKPOINT
  const editorWidth = width - (sidebar ? LIBRARY_SIDEBAR_WIDTH : 0)
  return { sidebar, overlay: libraryOpen && !sidebar, compact: editorWidth < LIBRARY_COMPACT_BREAKPOINT }
}

export function libraryDrawerBounds(rect: { left: number; top: number; right: number; bottom: number }, viewport: { left: number; top: number; width: number; height: number }) {
  const left = Math.max(rect.left, viewport.left)
  const top = Math.max(rect.top + 44, viewport.top)
  const width = Math.max(0, Math.min(rect.right, viewport.left + viewport.width) - left)
  const height = Math.max(0, Math.min(rect.bottom, viewport.top + viewport.height) - top)
  return { left, top, width, height, panelWidth: Math.min(LIBRARY_SIDEBAR_WIDTH, width) }
}

export function librarySaveStatus(phase: string | undefined, workspace: string, loading: boolean, indexing: boolean, transitioning: boolean) {
  if (phase === 'conflict') return { label: 'Conflicto de versión', tone: 'error' }
  if (phase === 'error') return { label: 'No se pudo guardar', tone: 'error' }
  if (workspace === 'error') return { label: 'Pestañas sin guardar', tone: 'error' }
  if (phase === 'saving') return { label: 'Guardando…', tone: 'pending' }
  if (phase === 'dirty') return { label: 'Cambios pendientes', tone: 'pending' }
  if (loading || transitioning) return { label: 'Abriendo documento…', tone: 'pending' }
  if (workspace === 'saving') return { label: 'Guardando pestañas…', tone: 'pending' }
  return { label: indexing ? 'Guardado · Indexando' : 'Guardado', tone: 'saved' }
}

export function activeTabScrollLeft(view: { left: number; right: number; scrollLeft: number; clientWidth: number; scrollWidth: number }, tab: { left: number; right: number }) {
  const next = tab.left < view.left ? view.scrollLeft + tab.left - view.left : tab.right > view.right ? view.scrollLeft + tab.right - view.right : view.scrollLeft
  return Math.max(0, Math.min(Math.max(0, view.scrollWidth - view.clientWidth), next))
}
