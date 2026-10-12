export type WorkspaceMenuAnchor = { left: number; right: number; top: number; bottom: number }
export type WorkspaceMenuViewport = { left: number; top: number; width: number; height: number }
export type WorkspaceMenuPosition = { left: number; top: number; width: number; maxHeight: number; placement: 'top' | 'bottom' }

// Shared by row/card actions. All coordinates belong to the visual viewport.
export function workspaceMenuPosition(anchor: WorkspaceMenuAnchor, menu: { width: number; height: number }, viewport: WorkspaceMenuViewport): WorkspaceMenuPosition | null {
  const margin = 8, gap = 8
  const viewportRight = viewport.left + viewport.width, viewportBottom = viewport.top + viewport.height
  if (anchor.bottom < viewport.top || anchor.top > viewportBottom || anchor.right < viewport.left || anchor.left > viewportRight) return null
  const width = Math.min(menu.width, Math.max(1, viewport.width - margin * 2))
  const desiredHeight = Math.min(Math.max(1, menu.height), Math.max(1, viewport.height - margin * 2))
  const spaceBelow = Math.max(0, viewportBottom - margin - gap - anchor.bottom)
  const spaceAbove = Math.max(0, anchor.top - gap - (viewport.top + margin))
  const placement = spaceBelow >= desiredHeight || spaceBelow >= spaceAbove ? 'bottom' : 'top'
  const maxHeight = Math.max(1, placement === 'bottom' ? spaceBelow : spaceAbove)
  const height = Math.min(desiredHeight, maxHeight)
  const preferredTop = placement === 'bottom' ? anchor.bottom + gap : anchor.top - gap - height
  const minTop = viewport.top + margin, maxTop = Math.max(minTop, viewportBottom - margin - height)
  const minLeft = viewport.left + margin, maxLeft = Math.max(minLeft, viewportRight - margin - width)
  return { left: Math.round(Math.max(minLeft, Math.min(anchor.right - width, maxLeft))), top: Math.round(Math.max(minTop, Math.min(preferredTop, maxTop))), width: Math.round(width), maxHeight: Math.round(maxHeight), placement }
}
