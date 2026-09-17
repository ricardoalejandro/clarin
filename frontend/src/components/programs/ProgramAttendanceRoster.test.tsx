import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProgramParticipant } from '@/types/program'
import ProgramAttendanceRoster from './ProgramAttendanceRoster'
import { createProgramAttendanceDraft, setProgramAttendanceDraftStatus } from './programAttendance'

const participants: ProgramParticipant[] = [
  { id: 'p-1', program_id: 'program-1', contact_id: 'contact-1', status: 'active', enrolled_at: '2026-01-01', contact_name: 'Ana Torres' },
]

function draft(status: '' | 'confirmed' | 'present' | 'absent' | 'late' = '') {
  return createProgramAttendanceDraft([{
    participant_id: 'p-1',
    contact_id: 'contact-1',
    contact_name: 'Ana Torres',
    participation_status: 'active',
    enrolled_at: '2026-01-01',
    attendance_status: status,
    observation_count: 0,
    observation_preview: [],
  }])
}

function props(overrides: Partial<React.ComponentProps<typeof ProgramAttendanceRoster>> = {}): React.ComponentProps<typeof ProgramAttendanceRoster> {
  return {
    participants,
    draft: draft(),
    preferredView: 'list',
    effectiveView: 'list',
    boardAvailable: true,
    onPreferredViewChange: vi.fn(),
    onStatusChange: vi.fn(),
    onOpenObservations: vi.fn(),
    ...overrides,
  }
}

afterEach(cleanup)

describe('ProgramAttendanceRoster', () => {
  it('offers Confirmado in the list and toggles it back to Sin estado through the controlled draft', () => {
    const onStatusChange = vi.fn()
    const rendered = render(<ProgramAttendanceRoster {...props({ onStatusChange })} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Confirmado: Ana Torres' })[0])
    expect(onStatusChange).toHaveBeenLastCalledWith('p-1', 'confirmed')

    rendered.rerender(<ProgramAttendanceRoster {...props({ draft: setProgramAttendanceDraftStatus(draft(), 'p-1', 'confirmed'), onStatusChange })} />)
    expect(screen.getAllByRole('button', { name: 'Confirmado: Ana Torres' })[0]).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getAllByRole('button', { name: 'Confirmado: Ana Torres' })[0])
    expect(onStatusChange).toHaveBeenLastCalledWith('p-1', '')
  })

  it('changes only the preferred desktop view through an accessible segmented control', () => {
    const onPreferredViewChange = vi.fn()
    render(<ProgramAttendanceRoster {...props({ onPreferredViewChange })} />)
    expect(screen.getByRole('button', { name: 'Lista' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Tablero' }))
    expect(onPreferredViewChange).toHaveBeenCalledWith('board')
  })

  it('forces the list when the board is unavailable without exposing a control that could overwrite the preference', () => {
    render(<ProgramAttendanceRoster {...props({ preferredView: 'board', effectiveView: 'list', boardAvailable: false })} />)
    expect(screen.queryByRole('group', { name: 'Vista de asistencia' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Confirmado: Ana Torres' })).toHaveLength(2)
    expect(screen.queryByTestId('program-attendance-board')).not.toBeInTheDocument()
  })

  it('keeps the existing observation action independent from status changes', () => {
    const onOpenObservations = vi.fn()
    const onStatusChange = vi.fn()
    render(<ProgramAttendanceRoster {...props({ onOpenObservations, onStatusChange })} />)
    const button = screen.getAllByRole('button', { name: 'Abrir observaciones de asistencia de Ana Torres' })[0]
    fireEvent.click(button)
    expect(onOpenObservations).toHaveBeenCalledWith(participants[0], button)
    expect(onStatusChange).not.toHaveBeenCalled()
  })

  it('blocks view, status, and observation controls while saving', () => {
    render(<ProgramAttendanceRoster {...props({ disabled: true })} />)
    expect(screen.getByRole('button', { name: 'Lista' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Tablero' })).toBeDisabled()
    expect(screen.getAllByRole('button', { name: 'Confirmado: Ana Torres' })[0]).toBeDisabled()
    expect(screen.getAllByRole('button', { name: 'Abrir observaciones de asistencia de Ana Torres' })[0]).toBeDisabled()
  })

  it('explains an applied search with no matches and offers an immediate clear action', () => {
    const onClearSearch = vi.fn()
    render(<ProgramAttendanceRoster {...props({ participants: [], totalParticipants: 24, searchActive: true, onClearSearch })} />)
    expect(screen.getByTestId('program-attendance-no-results')).toHaveTextContent('Sin coincidencias')
    fireEvent.click(screen.getByRole('button', { name: 'Limpiar búsqueda' }))
    expect(onClearSearch).toHaveBeenCalledOnce()
  })
})
