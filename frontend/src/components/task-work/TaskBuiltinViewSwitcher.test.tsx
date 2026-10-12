import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TaskBuiltinViewSwitcher from './TaskBuiltinViewSwitcher'

afterEach(cleanup)
describe('progressive view navigation', () => {
  it('keeps daily views visible and exposes advanced views through an accessible menu', () => {
    const onChange = vi.fn()
    render(<TaskBuiltinViewSwitcher value="list" width={1440} onChange={onChange} />)
    for (const name of ['Lista', 'Tablero', 'Calendario']) expect(screen.getByRole('button', { name })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Gantt' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Más vistas' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Resumen' }))
    expect(onChange).toHaveBeenCalledWith('summary')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
  it('keeps the active advanced view visible at narrow widths', () => {
    render(<TaskBuiltinViewSwitcher value="gantt" width={375} onChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Gantt' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Gantt')).not.toHaveClass('sr-only')
    fireEvent.click(screen.getByRole('button', { name: 'Más vistas' }))
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.getByRole('button', { name: 'Más vistas' })).toHaveFocus()
  })
})
