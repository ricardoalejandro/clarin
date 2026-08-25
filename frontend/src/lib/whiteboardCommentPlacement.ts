export type WhiteboardCommentPlacementCapture = (clientX: number, clientY: number) => boolean

export function consumeWhiteboardViewModeCommentPointer(
  event: PointerEvent,
  capture: WhiteboardCommentPlacementCapture,
) {
  const target = event.target
  if (event.button !== 0
    || !(target instanceof HTMLCanvasElement)
    || !target.classList.contains('interactive')) return false
  if (!capture(event.clientX, event.clientY)) return false
  event.preventDefault()
  event.stopPropagation()
  event.stopImmediatePropagation()
  return true
}
