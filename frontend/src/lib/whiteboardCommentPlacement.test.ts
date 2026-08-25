import { describe, expect, it, vi } from 'vitest'
import { consumeWhiteboardViewModeCommentPointer } from './whiteboardCommentPlacement'

function pointerEvent(input: Partial<PointerEvent> = {}) {
  const canvas = document.createElement('canvas')
  canvas.className = 'excalidraw__canvas interactive'
  return {
    target: canvas,
    button: 0,
    clientX: 120,
    clientY: 90,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    stopImmediatePropagation: vi.fn(),
    ...input,
  } as unknown as PointerEvent
}

describe('consumeWhiteboardViewModeCommentPointer', () => {
  it('consumes the primary pointer only after the comment provider captures it', () => {
    const event = pointerEvent()
    const capture = vi.fn(() => true)

    expect(consumeWhiteboardViewModeCommentPointer(event, capture)).toBe(true)
    expect(capture).toHaveBeenCalledWith(120, 90)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce()
  })

  it('leaves normal pan input untouched when no placement is active', () => {
    const event = pointerEvent()

    expect(consumeWhiteboardViewModeCommentPointer(event, () => false)).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.stopPropagation).not.toHaveBeenCalled()
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled()
  })

  it('ignores secondary buttons and targets outside the interactive canvas', () => {
    const capture = vi.fn(() => true)
    expect(consumeWhiteboardViewModeCommentPointer(pointerEvent({ button: 2 }), capture)).toBe(false)
    expect(consumeWhiteboardViewModeCommentPointer(pointerEvent({ target: document.createElement('div') }), capture)).toBe(false)
    expect(capture).not.toHaveBeenCalled()
  })
})
