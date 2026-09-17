import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProgramParticipant, ProgramSessionRosterEntry } from '@/types/program'
import ProgramAttendanceBoard, {
  attendanceCollisionDetection,
  programAttendanceDropAnimation,
} from './ProgramAttendanceBoard'
import { createProgramAttendanceDraft } from './programAttendance'

const participants: ProgramParticipant[] = [
  { id: 'p-3', program_id: 'program-1', contact_id: 'contact-3', status: 'active', enrolled_at: '2026-01-01', contact_name: 'Zoé' },
  { id: 'p-1', program_id: 'program-1', contact_id: 'contact-1', status: 'active', enrolled_at: '2026-01-01', contact_name: 'Álvaro' },
  { id: 'p-2', program_id: 'program-1', contact_id: 'contact-2', status: 'active', enrolled_at: '2026-01-01', contact_name: 'Ana' },
]

const roster: ProgramSessionRosterEntry[] = [
  { participant_id: 'p-1', contact_id: 'contact-1', contact_name: 'Álvaro', participation_status: 'active', enrolled_at: '2026-01-01', attendance_status: 'present', observation_count: 0, observation_preview: [] },
  { participant_id: 'p-2', contact_id: 'contact-2', contact_name: 'Ana', participation_status: 'active', enrolled_at: '2026-01-01', attendance_status: 'present', observation_count: 0, observation_preview: [] },
  { participant_id: 'p-3', contact_id: 'contact-3', contact_name: 'Zoé', participation_status: 'active', enrolled_at: '2026-01-01', attendance_status: '', observation_count: 0, observation_preview: [] },
]

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.documentElement.classList.remove('kanban-ctrl-held', 'kanban-panning')
})

describe('ProgramAttendanceBoard', () => {
  it('cancels pointer drops outside every column and uses proximity only for keyboard movement', () => {
    const column = { id: 'attendance-column:present' }
    const rect = { left: 0, right: 100, top: 0, bottom: 100, width: 100, height: 100 }
    const baseArgs = {
      collisionRect: rect,
      droppableContainers: [column],
      droppableRects: new Map([[column.id, rect]]),
    }

    expect(attendanceCollisionDetection({ ...baseArgs, pointerCoordinates: { x: 300, y: 300 } } as never)).toEqual([])
    expect(attendanceCollisionDetection({ ...baseArgs, pointerCoordinates: null } as never)).toHaveLength(1)
  })

  it('removes the drop animation when reduced motion is requested', () => {
    expect(programAttendanceDropAnimation(true)).toBeNull()
    expect(programAttendanceDropAnimation(false)).toEqual({ duration: 180, easing: 'ease-out' })
  })

  it('renders five honest droppable columns and one alphabetized card per participant', () => {
    render(<ProgramAttendanceBoard participants={participants} draft={createProgramAttendanceDraft(roster)} onStatusChange={vi.fn()} onOpenObservations={vi.fn()} />)
    expect(screen.getByTestId('program-attendance-board-header')).toHaveClass('sticky', '-top-4')
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(5)
    expect(screen.getByRole('region', { name: 'Sin estado: 1 participante' })).toBeInTheDocument()
    const confirmed = screen.getByRole('region', { name: 'Confirmado: 0 participantes' })
    expect(confirmed).toHaveClass('self-stretch')
    expect(confirmed.querySelector('[data-attendance-column-surface]')).toBeInTheDocument()
    const present = screen.getByRole('region', { name: 'Presente: 2 participantes' })
    expect(screen.getByRole('region', { name: 'Faltó: 0 participantes' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Tarde: 0 participantes' })).toBeInTheDocument()
    expect(within(present).getAllByRole('article').map(card => card.getAttribute('data-attendance-participant-card'))).toEqual(['p-1', 'p-2'])
    expect(document.querySelectorAll('[data-attendance-participant-card]')).toHaveLength(3)
    expect(screen.getByTestId('program-attendance-board').firstElementChild).toHaveClass('min-w-[1180px]', 'items-stretch')
  })

  it('keeps the sticky header horizontally aligned with the board viewport', () => {
    render(<ProgramAttendanceBoard participants={participants} draft={createProgramAttendanceDraft(roster)} onStatusChange={vi.fn()} onOpenObservations={vi.fn()} />)
    const board = screen.getByTestId('program-attendance-board')
    const header = screen.getByTestId('program-attendance-board-header-scroll')
    board.scrollLeft = 317
    fireEvent.scroll(board)
    expect(header.scrollLeft).toBe(317)
  })

  it('uses a dedicated accessible handle while observation remains an independent action', () => {
    const onOpenObservations = vi.fn()
    const onStatusChange = vi.fn()
    const denseObservationRoster: ProgramSessionRosterEntry[] = [{
      ...roster[2],
      observation_count: 50,
      observation_preview: [{
        id: 'observation-long',
        notes: 'Esta observación extensa no debe ocupar espacio dentro de la ficha del tablero.',
        created_by_name: 'Responsive QA',
        created_at: '2026-01-02T10:30:00.000Z',
      }],
    }]
    render(<ProgramAttendanceBoard participants={participants.slice(0, 1)} draft={createProgramAttendanceDraft(denseObservationRoster)} onStatusChange={onStatusChange} onOpenObservations={onOpenObservations} />)
    expect(screen.getByRole('button', { name: 'Mover a Zoé' })).toHaveAttribute('title', 'Arrastrar participante')
    const observation = screen.getByRole('button', { name: 'Abrir observaciones de asistencia de Zoé' })
    expect(observation).toHaveTextContent(/Observaciones\s*·\s*50/)
    expect(screen.queryByText('Esta observación extensa no debe ocupar espacio dentro de la ficha del tablero.')).not.toBeInTheDocument()
    expect(screen.queryByText('Responsive QA')).not.toBeInTheDocument()
    fireEvent.click(observation)
    expect(onOpenObservations).toHaveBeenCalledWith(participants[0], observation)
    expect(onStatusChange).not.toHaveBeenCalled()
  })

  it('disables pickup and observation history while a save is pending', () => {
    render(<ProgramAttendanceBoard disabled participants={participants.slice(0, 1)} draft={createProgramAttendanceDraft(roster.slice(2))} onStatusChange={vi.fn()} onOpenObservations={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Mover a Zoé' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Abrir observaciones de asistencia de Zoé' })).toBeDisabled()
  })
})
