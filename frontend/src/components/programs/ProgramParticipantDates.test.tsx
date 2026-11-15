import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import ProgramParticipantEnrollmentDate from './ProgramParticipantEnrollmentDate'
import ProgramParticipantOutcomeDate from './ProgramParticipantOutcomeDate'
import type { ProgramParticipant } from '@/types/program'

vi.mock('@/lib/api', () => ({ api: vi.fn() }))
const participant: ProgramParticipant = { id: 'participant', program_id: 'program', contact_id: 'contact', status: 'dropped', enrolled_at: '2020-01-01', dropped_at: '2020-02-01' }
beforeEach(() => vi.mocked(api).mockReset())
afterEach(cleanup)

describe('Program participation dates in an operational mobile view', () => {
  it('does not save partial or out-of-window enrollment text and exposes the dirty draft', async () => {
    const dirty = vi.fn()
    render(<ProgramParticipantEnrollmentDate programId="program" participant={participant} onChange={vi.fn()} onDirtyChange={dirty} />)
    fireEvent.click(screen.getByRole('button', { name: 'Modificar fecha de incorporación' }))
    const input = screen.getByRole('textbox', { name: 'Nueva fecha de incorporación' })
    fireEvent.change(input, { target: { value: '02/01/' } })
    expect(dirty).toHaveBeenLastCalledWith(true)
    expect(screen.getByRole('button', { name: 'Guardar' })).toBeDisabled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(api).not.toHaveBeenCalled()
    expect(input).toHaveValue('02/01/')
    fireEvent.change(input, { target: { value: '02/02/2020' } })
    expect(screen.getByRole('button', { name: 'Guardar' })).toBeDisabled()
    expect(api).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '02/01/2020' } })
    vi.mocked(api).mockResolvedValueOnce({ success: true, data: { success: true, enrolled_at: '2020-01-02' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Guardar' })) })
    expect(api).toHaveBeenCalledExactlyOnceWith('/api/programs/program/participants/participant/enrollment', { method: 'PATCH', body: JSON.stringify({ enrolled_at: '2020-01-02' }) })
  })

  it('confirms the exact reviewed outcome date even if the underlying input changes', async () => {
    render(<ProgramParticipantOutcomeDate programId="program" participant={participant} onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Modificar fecha de retiro' }))
    const input = screen.getByRole('textbox', { name: 'Nueva fecha de retiro' })
    fireEvent.change(input, { target: { value: '02/02/2020' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))
    expect(api).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '03/02/2020' } })
    vi.mocked(api).mockResolvedValueOnce({ success: true, data: { success: true, ended_on: '2020-02-02' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirmar' })) })
    expect(api).toHaveBeenCalledExactlyOnceWith('/api/programs/program/participants/participant/outcome-date', { method: 'PATCH', body: JSON.stringify({ ended_on: '2020-02-02' }) })
  })

  it('starts a fresh date draft when changing participation and ignores a late previous save', async () => {
    let finish!: (value: unknown) => void
    vi.mocked(api).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }) as never)
    const change = vi.fn()
    const props = { programId: 'program', participant, onChange: change }
    const view = render(<ProgramParticipantEnrollmentDate {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Modificar fecha de incorporación' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Nueva fecha de incorporación' }), { target: { value: '02/01/2020' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))
    const other = { ...participant, id: 'another', enrolled_at: '2020-01-15' }
    view.rerender(<ProgramParticipantEnrollmentDate {...props} participant={other} />)
    expect(screen.queryByRole('textbox', { name: 'Nueva fecha de incorporación' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Modificar fecha de incorporación' }))
    expect(screen.getByRole('textbox', { name: 'Nueva fecha de incorporación' })).toHaveValue('15/01/2020')
    await act(async () => { finish({ success: true, data: { success: true, enrolled_at: '2020-01-02' } }) })
    expect(change).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: 'Nueva fecha de incorporación' })).toHaveValue('15/01/2020')
  })

  it('preserves an enrollment draft while displaying the canonical date in read-only mode', async () => {
    const props = { programId: 'program', participant, onChange: vi.fn() }
    const view = render(<ProgramParticipantEnrollmentDate {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Modificar fecha de incorporación' }))
    fireEvent.change(screen.getByLabelText('Nueva fecha de incorporación'), { target: { value: '2020-01-02' } })
    const save = screen.getByRole('button', { name: 'Guardar' })
    view.rerender(<ProgramParticipantEnrollmentDate {...props} readOnly />)
    expect(screen.queryByRole('button', { name: 'Guardar' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Modificar fecha de incorporación' })).not.toBeInTheDocument()
    fireEvent.click(save)
    expect(api).not.toHaveBeenCalled()
    view.rerender(<ProgramParticipantEnrollmentDate {...props} />)
    expect(screen.getByLabelText('Nueva fecha de incorporación')).toHaveValue('2020-01-02')
    vi.mocked(api).mockResolvedValueOnce({ success: true, data: { success: true, enrolled_at: '2020-01-02' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Guardar' })) })
    expect(api).toHaveBeenCalledTimes(1)
    expect(props.onChange).toHaveBeenCalledExactlyOnceWith('2020-01-02')
  })

  it('pauses an outcome-date confirmation without submitting and resumes its exact draft', async () => {
    const props = { programId: 'program', participant, onChange: vi.fn() }
    const view = render(<ProgramParticipantOutcomeDate {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Modificar fecha de retiro' }))
    fireEvent.change(screen.getByLabelText('Nueva fecha de retiro'), { target: { value: '2020-02-02' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    view.rerender(<ProgramParticipantOutcomeDate {...props} readOnly />)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(api).not.toHaveBeenCalled()
    view.rerender(<ProgramParticipantOutcomeDate {...props} />)
    expect(screen.getByLabelText('Nueva fecha de retiro')).toHaveValue('2020-02-02')
    vi.mocked(api).mockResolvedValueOnce({ success: true, data: { success: true, ended_on: '2020-02-02' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirmar' })) })
    expect(api).toHaveBeenCalledExactlyOnceWith('/api/programs/program/participants/participant/outcome-date', { method: 'PATCH', body: JSON.stringify({ ended_on: '2020-02-02' }) })
  })

  it('finishes an already-sent enrollment once while paused and rejects results after unmount', async () => {
    let finish!: (value: unknown) => void
    vi.mocked(api).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }) as never)
    const props = { programId: 'program', participant, onChange: vi.fn() }
    const view = render(<ProgramParticipantEnrollmentDate {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Modificar fecha de incorporación' }))
    fireEvent.change(screen.getByLabelText('Nueva fecha de incorporación'), { target: { value: '2020-01-02' } })
    const save = screen.getByRole('button', { name: 'Guardar' })
    fireEvent.click(save)
    view.rerender(<ProgramParticipantEnrollmentDate {...props} readOnly />)
    fireEvent.click(save)
    view.unmount()
    await act(async () => { finish({ success: true, data: { success: true, enrolled_at: '2020-01-02' } }) })
    expect(api).toHaveBeenCalledTimes(1)
    expect(props.onChange).not.toHaveBeenCalled()
  })
})
