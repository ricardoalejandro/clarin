import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TaskSubtaskDisplayControl from './TaskSubtaskDisplayControl'

describe('TaskSubtaskDisplayControl', () => {
  afterEach(cleanup)

  it('exposes the global collapsed state and requests expansion accessibly', () => {
    const onChange = vi.fn()
    render(<TaskSubtaskDisplayControl mode="collapsed" onChange={onChange} />)

    expect(screen.getByText('Subtareas')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Contraer todas las subtareas' })).toHaveAttribute('aria-pressed', 'true')
    const expand = screen.getByRole('button', { name: 'Expandir todas las subtareas' })
    expect(expand).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(expand)
    expect(onChange).toHaveBeenCalledWith('expanded')
  })

  it('keeps the label available to assistive technology in compact mode', () => {
    render(<TaskSubtaskDisplayControl mode="expanded" compact onChange={vi.fn()} />)
    expect(screen.getByRole('group', { name: 'Visualización de subtareas' })).toBeInTheDocument()
    expect(screen.queryByText('Subtareas')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Expandir todas las subtareas' })).toHaveAttribute('aria-pressed', 'true')
  })
})
