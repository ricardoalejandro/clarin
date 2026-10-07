import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProgramParticipantAttendanceSection from './ProgramParticipantAttendanceSection'

vi.mock('@/components/ObservationHistoryModal', () => ({ default: () => null }))

const fetchMock = vi.fn()
const props = { programId: 'program-1', participantId: 'participant-1', participantName: 'Participant', enrolledAt: '2026-10-01', participationStatus: 'dropped', droppedAt: '2026-10-07' }
const summary = (rate: number) => ({ goal_percent: 80, eligible_sessions: rate === 100 ? 1 : 2, marked_sessions: rate === 100 ? 1 : 2, pending: 0, present: 1, absent: rate === 100 ? 0 : 1, late: 0, attendance_rate: rate, punctuality_rate: null, health: 'green' })
const absent = { session_id: 'session-4', ordinal: 2, date: '2026-10-04', title: 'Excluded class', status: 'absent', observation_count: 0 }
const result = (rate: number, historical = false) => new Response(JSON.stringify({ success: true, summary: summary(rate), sessions: historical ? [] : [absent], historical_sessions: historical ? [absent] : [], next_cursor: null }))

beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('participant attendance participation window reconciliation', () => {
  it('refreshes a corrected withdrawal, preserves mounted metrics, and moves actual records into history', async () => {
    let resolve!: (value: Response) => void
    fetchMock.mockResolvedValueOnce(result(50)).mockImplementationOnce(() => new Promise<Response>(done => { resolve = done }))
    const view = render(<ProgramParticipantAttendanceSection {...props} />)
    const oldMetric = await screen.findByText('50%')
    view.rerender(<ProgramParticipantAttendanceSection {...props} droppedAt="2026-10-04" />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(oldMetric).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Actualizando el periodo')
    await act(async () => resolve(result(100, true)))
    expect(await screen.findByText('100%')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Registros fuera del periodo de participación \(1\)/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Registros fuera del periodo/ }))
    expect(screen.getByText('Excluded class')).toBeInTheDocument()
  })

  it('refreshes completion and enrollment changes and retries failed reconciliation from the first page', async () => {
    fetchMock.mockResolvedValueOnce(result(50)).mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Window refresh failed' }), { status: 500 })).mockResolvedValueOnce(result(100))
    const view = render(<ProgramParticipantAttendanceSection {...props} />)
    await screen.findByText('50%')
    view.rerender(<ProgramParticipantAttendanceSection {...props} participationStatus="completed" droppedAt={undefined} completedAt="2026-10-04" />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Window refresh failed')
    expect(screen.getByText('50%')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
    await screen.findByText('100%')
    expect(fetchMock.mock.calls[2][0]).not.toContain('cursor=')
    fetchMock.mockResolvedValueOnce(result(75))
    view.rerender(<ProgramParticipantAttendanceSection {...props} enrolledAt="2026-09-28" participationStatus="completed" completedAt="2026-10-04" />)
    expect(await screen.findByText('75%')).toBeInTheDocument()
  })

  it('aborts and rejects the old participation window when it completes late', async () => {
    let resolveOld!: (value: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise<Response>(done => { resolveOld = done })).mockResolvedValueOnce(result(100))
    const view = render(<ProgramParticipantAttendanceSection {...props} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    view.rerender(<ProgramParticipantAttendanceSection {...props} droppedAt="2026-10-04" />)
    await screen.findByText('100%')
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
    await act(async () => resolveOld(result(50)))
    expect(screen.queryByText('50%')).not.toBeInTheDocument()
  })
})
