import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SurveyResponsePagination from './SurveyResponsePagination'

afterEach(cleanup)

describe('survey response pagination', () => {
  it('requests a page without advancing the canonical range and disables both controls while loading', () => {
    const change = vi.fn()
    const { rerender } = render(<SurveyResponsePagination page={0} total={75} loading={false} onPageChange={change} />)
    expect(screen.getByRole('navigation', { name: 'Paginación de respuestas' })).toBeInTheDocument()
    const previous = screen.getByRole('button', { name: 'Anterior' })
    const next = screen.getByRole('button', { name: 'Siguiente' })
    expect(previous).toBeDisabled()
    expect(next).toBeEnabled()
    expect(previous).toHaveClass('min-h-11', 'min-w-11')
    expect(next).toHaveClass('min-h-11', 'min-w-11')
    fireEvent.click(next)
    expect(change).toHaveBeenCalledExactlyOnceWith(1)
    expect(screen.getByText('Mostrando 1-50 de 75')).toBeInTheDocument()
    rerender(<SurveyResponsePagination page={0} total={75} loading onPageChange={change} />)
    expect(previous).toBeDisabled()
    expect(next).toBeDisabled()
    fireEvent.click(next)
    expect(change).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Página 1 de 2')).toBeInTheDocument()
  })

  it('shows the exact final range and permits only the bounded previous page', () => {
    const change = vi.fn()
    render(<SurveyResponsePagination page={1} total={75} loading={false} onPageChange={change} />)
    expect(screen.getByText('Mostrando 51-75 de 75')).toBeInTheDocument()
    expect(screen.getByText('Página 2 de 2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Siguiente' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Anterior' }))
    expect(change).toHaveBeenCalledExactlyOnceWith(0)
  })

  it.each([0, 1, 50])('does not offer pagination for %i responses on one page', total => {
    render(<SurveyResponsePagination page={0} total={total} loading={false} onPageChange={vi.fn()} />)
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
  })
})
