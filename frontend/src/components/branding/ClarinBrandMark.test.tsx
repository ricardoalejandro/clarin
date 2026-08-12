import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import ClarinBrandMark from './ClarinBrandMark'

describe('ClarinBrandMark', () => {
  it('uses the canonical SVG and stays decorative by default', () => {
    const { container } = render(<ClarinBrandMark className="h-8 w-8" />)
    const mark = container.querySelector('[data-clarin-brand-mark]')

    expect(mark).toHaveAttribute('src', '/favicon.svg')
    expect(mark).toHaveAttribute('alt', '')
    expect(mark).toHaveAttribute('aria-hidden', 'true')
    expect(mark).toHaveAttribute('draggable', 'false')
  })

  it('provides an accessible product name when the mark carries meaning', () => {
    render(<ClarinBrandMark label="Clarín" />)
    expect(screen.getByRole('img', { name: 'Clarín' })).toHaveAttribute('src', '/favicon.svg')
  })
})
