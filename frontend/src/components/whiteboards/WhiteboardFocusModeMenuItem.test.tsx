import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WHITEBOARD_FOCUS_ARIA_SHORTCUTS, WHITEBOARD_FOCUS_SHORTCUT_LABEL } from '@/lib/whiteboardFocusMode'
import WhiteboardFocusModeMenuItem from './WhiteboardFocusModeMenuItem'

describe('WhiteboardFocusModeMenuItem', () => {
  afterEach(cleanup)

  it('offers maximization with the documented accessible shortcut', () => {
    const onToggle = vi.fn()
    render(<WhiteboardFocusModeMenuItem active={false} onToggle={onToggle} />)

    const item = screen.getByRole('menuitem', { name: new RegExp(`Maximizar pizarra.*${WHITEBOARD_FOCUS_SHORTCUT_LABEL.replaceAll('+', '\\+')}`) })
    expect(item).toHaveAttribute('data-whiteboard-focus-action', 'maximize')
    expect(item).toHaveAttribute('aria-keyshortcuts', WHITEBOARD_FOCUS_ARIA_SHORTCUTS)
    fireEvent.click(item)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('turns into an explicit touch-accessible restore action', () => {
    render(<WhiteboardFocusModeMenuItem active onToggle={vi.fn()} />)
    expect(screen.getByRole('menuitem', { name: /Volver a vista normal/ })).toHaveAttribute(
      'data-whiteboard-focus-action',
      'restore',
    )
  })
})
