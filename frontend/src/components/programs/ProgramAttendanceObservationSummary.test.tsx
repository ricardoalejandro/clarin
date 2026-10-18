import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProgramParticipant } from '@/types/program'
import ProgramAttendanceObservationSummary from './ProgramAttendanceObservationSummary'

const participant = { id: 'participant', contact_name: 'Ana' } as ProgramParticipant
const observation = { id: 'note', notes: 'Volvió a participar', created_by_name: 'Docente', created_at: '2026-10-18T12:00:00Z' }
afterEach(cleanup)
describe('attendance observation reading and writing', () => {
  it('shows static labelled text and separate view/add intentions', () => {
    const onOpenObservations = vi.fn()
    render(<ProgramAttendanceObservationSummary participant={participant} draft={{ participant: { status: '', original_status: '', observation_count: 3, observation_preview: [observation] } }} onOpenObservations={onOpenObservations}/>)
    expect(screen.getByText('Última observación')).toBeInTheDocument()
    expect(screen.getByText('Volvió a participar').tagName).toBe('P')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    const view = screen.getByRole('button', { name: 'Ver 3 observaciones de asistencia de Ana' })
    fireEvent.click(view)
    expect(onOpenObservations).toHaveBeenLastCalledWith(participant, view, 'view')
    const add = screen.getByRole('button', { name: 'Añadir observación de asistencia de Ana' })
    fireEvent.click(add)
    expect(onOpenObservations).toHaveBeenLastCalledWith(participant, add, 'add')
  })
  it('offers only adding when no observation exists', () => {
    render(<ProgramAttendanceObservationSummary participant={participant} draft={{}} onOpenObservations={vi.fn()}/>)
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getByRole('button')).toHaveTextContent('Añadir')
    expect(screen.queryByText('Sin observaciones')).not.toBeInTheDocument()
  })
})
