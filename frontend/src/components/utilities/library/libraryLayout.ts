export const LIBRARY_SIDEBAR_WIDTH = 256
export const LIBRARY_SIDEBAR_BREAKPOINT = 900
export const LIBRARY_COMPACT_BREAKPOINT = 720

export function libraryLayout(availableWidth: number) {
  const width = Number.isFinite(availableWidth) ? Math.max(0, availableWidth) : 0
  const sidebar = width >= LIBRARY_SIDEBAR_BREAKPOINT
  const editorWidth = width - (sidebar ? LIBRARY_SIDEBAR_WIDTH : 0)
  return { sidebar, compact: editorWidth < LIBRARY_COMPACT_BREAKPOINT }
}
