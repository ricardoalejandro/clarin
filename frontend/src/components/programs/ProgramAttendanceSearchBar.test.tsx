import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProgramAttendanceSearchBar from './ProgramAttendanceSearchBar'

afterEach(cleanup)

describe('ProgramAttendanceSearchBar', () => {
  it('shows the settled count, pending state, and clears immediately', () => {
    const onChange = vi.fn()
    const onClear = vi.fn()
    const { rerender } = render(
      <ProgramAttendanceSearchBar value="Ana" pending={false} resultCount={1} totalCount={24} onChange={onChange} onClear={onClear} />,
    )

    expect(screen.getByRole('searchbox', { name: 'Buscar participante por nombre o teléfono' })).toHaveValue('Ana')
    expect(screen.getByText('1 de 24')).toBeVisible()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Ana T' } })
    expect(onChange).toHaveBeenCalledWith('Ana T')
    fireEvent.click(screen.getByRole('button', { name: 'Limpiar búsqueda de asistencia' }))
    expect(onClear).toHaveBeenCalledOnce()

    rerender(
      <ProgramAttendanceSearchBar value="Ana T" pending resultCount={1} totalCount={24} onChange={onChange} onClear={onClear} />,
    )
    expect(screen.getByText('Buscando…')).toBeVisible()
    expect(screen.queryByText('1 de 24')).not.toBeInTheDocument()
  })

  it('keeps search and clear controls disabled while attendance is saving', () => {
    render(
      <ProgramAttendanceSearchBar value="Ana" pending={false} resultCount={1} totalCount={2} disabled onChange={vi.fn()} onClear={vi.fn()} />,
    )
    expect(screen.getByRole('searchbox')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Limpiar búsqueda de asistencia' })).toBeDisabled()
  })
})
