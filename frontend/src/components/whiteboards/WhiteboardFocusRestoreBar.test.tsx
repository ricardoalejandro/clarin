import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import WhiteboardFocusRestoreBar from './WhiteboardFocusRestoreBar'

describe('WhiteboardFocusRestoreBar', () => {
  it('offers a visible keyboard-accessible exit for a focused compact editor', () => {
    const restore = vi.fn()
    render(<WhiteboardFocusRestoreBar active integratedTitle={false} onRestore={restore} />)
    const button = screen.getByRole('button', { name: 'Volver a vista normal' })
    expect(button).toHaveAttribute('aria-keyshortcuts', 'Control+Shift+F Meta+Shift+F')
    fireEvent.click(button)
    expect(restore).toHaveBeenCalledTimes(1)
  })

  it.each([
    { active: false, integratedTitle: false },
    { active: false, integratedTitle: true },
    { active: true, integratedTitle: true },
  ])('does not duplicate the integrated arrow or change normal editors: %j', props => {
    const { container } = render(<WhiteboardFocusRestoreBar {...props} onRestore={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })
})
