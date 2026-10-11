import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { User } from 'lucide-react'
import CrmDetailAccordion from './CrmDetailAccordion'

afterEach(cleanup)

describe('CrmDetailAccordion disclosure continuity', () => {
  it('keeps a draft mounted while collapsed and excludes it from keyboard and accessibility navigation', () => {
    const props = { id: 'contact', title: 'Información', icon: User, onToggle: vi.fn() }
    const { rerender } = render(<CrmDetailAccordion {...props} open><input aria-label="Borrador" defaultValue="" /></CrmDetailAccordion>)
    const input = screen.getByRole('textbox', { name: 'Borrador' })
    fireEvent.change(input, { target: { value: 'Sin perder' } })
    rerender(<CrmDetailAccordion {...props} open={false}><input aria-label="Borrador" defaultValue="" /></CrmDetailAccordion>)
    const content = document.getElementById('contact-content')!
    expect(content).toHaveAttribute('inert')
    expect(content).toHaveAttribute('aria-hidden', 'true')
    expect(content).toHaveClass('duration-[160ms]', 'motion-reduce:transition-none')
    expect(screen.queryByRole('textbox', { name: 'Borrador' })).not.toBeInTheDocument()
    rerender(<CrmDetailAccordion {...props} open><input aria-label="Borrador" defaultValue="" /></CrmDetailAccordion>)
    expect(screen.getByRole('textbox', { name: 'Borrador' })).toBe(input)
    expect(input).toHaveValue('Sin perder')
  })
})
