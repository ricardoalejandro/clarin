import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ObservationHistoryModal, { type HistoryObservation } from '@/components/ObservationHistoryModal'

const fetchMock = vi.fn()
const observation: HistoryObservation = { id: 'note-1', contact_id: 'contact-1', lead_id: null, type: 'note', notes: 'Historia del contacto', direction: null, outcome: null, created_by_name: 'Docente', created_at: '2026-10-01T10:00:00Z' }
const props = { isOpen: true, onClose: vi.fn(), contactId: 'contact-1', programId: 'program-1', programParticipantId: 'participant-1', name: 'Participante', observations: [observation], initialComposerOpen: true }
function clickCallback(element: HTMLElement): () => Promise<void> {
  const propsKey = Object.keys(element).find(key => key.startsWith('__reactProps$'))!
  return (element as any)[propsKey].onClick
}
const success = () => new Response(JSON.stringify({ success: true, interactions: [] }))

beforeEach(() => {
  localStorage.clear()
  fetchMock.mockReset().mockImplementation(async () => success())
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} unobserve() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('observation history mutation capabilities', () => {
  it('preserves an attendance composer intention and draft through history refresh', () => {
    const attendanceContext = { programId: 'program-1', sessionId: 'session-1', participantId: 'participant-1' }
    const view = render(<ObservationHistoryModal {...props} attendanceContext={attendanceContext} initialComposerOpen />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Borrador de asistencia' } })
    view.rerender(<ObservationHistoryModal {...props} attendanceContext={attendanceContext} initialComposerOpen={false} observations={[]} />)
    expect(screen.getByRole('textbox')).toHaveValue('Borrador de asistencia')
    view.rerender(<ObservationHistoryModal {...props} attendanceContext={{ ...attendanceContext, participantId: 'participant-2' }} initialComposerOpen={false} observations={[]} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('protects attendance drafts on close and resumes after cancelling discard', () => {
    const onClose = vi.fn()
    render(<ObservationHistoryModal {...props} onClose={onClose} protectDraftOnClose />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Todavía no enviada' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar observaciones' }))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog', { name: 'Descartar observación pendiente' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Seguir escribiendo' }))
    expect(screen.getByRole('textbox')).toHaveValue('Todavía no enviada')
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Descartar y cerrar' }))
    expect(onClose).toHaveBeenCalledOnce()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps desktop call drafts independent of note-only mobile drafts and rejects old callbacks', async () => {
    const onObservationChange = vi.fn()
    const view = render(<ObservationHistoryModal {...props} onObservationChange={onObservationChange} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Llamada pendiente en escritorio' } })
    const oldAdd = clickCallback(screen.getByRole('button', { name: 'Agregar' }))
    const oldDelete = clickCallback(screen.getByTitle('Eliminar'))
    view.rerender(<ObservationHistoryModal {...props} onObservationChange={onObservationChange} mutationMode="append-only" allowedNewTypes={['note']} />)
    expect(screen.queryByRole('button', { name: 'Llamada' })).not.toBeInTheDocument()
    expect(screen.queryByTitle('Eliminar')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox')).toHaveValue('')
    await act(async () => { await oldAdd(); await oldDelete() })
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Nota del programa' } })
    fireEvent.click(screen.getByRole('button', { name: 'Agregar' }))
    await waitFor(() => expect(onObservationChange).toHaveBeenCalledOnce())
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ contact_id: 'contact-1', program_id: 'program-1', program_participant_id: 'participant-1', type: 'note', notes: 'Nota del programa' })
    view.rerender(<ObservationHistoryModal {...props} onObservationChange={onObservationChange} />)
    expect(screen.getByRole('textbox')).toHaveValue('Llamada pendiente en escritorio')
  })

  it('blocks stale add handlers in read-only mode and resumes the same draft', async () => {
    const view = render(<ObservationHistoryModal {...props} defaultNewType="note" />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Nota sin enviar' } })
    const add = clickCallback(screen.getByRole('button', { name: 'Agregar' }))
    view.rerender(<ObservationHistoryModal {...props} defaultNewType="note" mutationMode="read-only" />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    await act(async () => { await add() })
    expect(fetchMock).not.toHaveBeenCalled()
    view.rerender(<ObservationHistoryModal {...props} defaultNewType="note" />)
    expect(screen.getByRole('textbox')).toHaveValue('Nota sin enviar')
  })

  it('pauses a deletion confirmation on mobile and preserves consultation origin', async () => {
    const onObservationChange = vi.fn()
    const view = render(<ObservationHistoryModal {...props} onObservationChange={onObservationChange} />)
    expect(screen.getByText('Contacto · observación general')).toBeInTheDocument()
    fireEvent.click(screen.getByTitle('Eliminar'))
    const confirm = clickCallback(screen.getByRole('button', { name: 'Eliminar observación' }))
    expect(fetchMock).not.toHaveBeenCalled()
    view.rerender(<ObservationHistoryModal {...props} onObservationChange={onObservationChange} mutationMode="append-only" allowedNewTypes={['note']} />)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    await act(async () => { await confirm() })
    expect(fetchMock).not.toHaveBeenCalled()
    view.rerender(<ObservationHistoryModal {...props} onObservationChange={onObservationChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar observación' }))
    await waitFor(() => expect(onObservationChange).toHaveBeenCalledOnce())
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE')
  })

  it('sends once, reconciles while read-only, and keeps a newer note draft', async () => {
    let resolve!: (response: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise<Response>(done => { resolve = done }))
    const onObservationChange = vi.fn()
    const view = render(<ObservationHistoryModal {...props} onObservationChange={onObservationChange} defaultNewType="note" />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Enviada' } })
    const add = clickCallback(screen.getByRole('button', { name: 'Agregar' }))
    await act(async () => { void add(); void add() })
    expect(fetchMock).toHaveBeenCalledOnce()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Otra pendiente' } })
    view.rerender(<ObservationHistoryModal {...props} onObservationChange={onObservationChange} defaultNewType="note" mutationMode="read-only" />)
    await act(async () => resolve(success()))
    expect(onObservationChange).toHaveBeenCalledOnce()
    view.rerender(<ObservationHistoryModal {...props} onObservationChange={onObservationChange} defaultNewType="note" mutationMode="append-only" allowedNewTypes={['note']} />)
    expect(screen.getByRole('textbox')).toHaveValue('Otra pendiente')
  })

  it('retains the contextual note after failure for explicit retry', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: false, error: 'No se pudo guardar' }), { status: 409 })).mockResolvedValueOnce(success())
    const onObservationChange = vi.fn()
    render(<ObservationHistoryModal {...props} defaultNewType="note" mutationMode="append-only" allowedNewTypes={['note']} onObservationChange={onObservationChange} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Pendiente de reintento' } })
    fireEvent.click(screen.getByRole('button', { name: 'Agregar' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo guardar')
    expect(screen.getByRole('textbox')).toHaveValue('Pendiente de reintento')
    fireEvent.click(screen.getByRole('button', { name: 'Agregar' }))
    await waitFor(() => expect(onObservationChange).toHaveBeenCalledOnce())
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rejects an old callback when the same Contact moves to another Program participation', async () => {
    const view = render(<ObservationHistoryModal {...props} defaultNewType="note" />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Pertenece al primer programa' } })
    const add = clickCallback(screen.getByRole('button', { name: 'Agregar' }))
    view.rerender(<ObservationHistoryModal {...props} defaultNewType="note" programId="program-2" programParticipantId="participant-2" />)
    await act(async () => { await add() })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox')).toHaveValue('')
  })
})
