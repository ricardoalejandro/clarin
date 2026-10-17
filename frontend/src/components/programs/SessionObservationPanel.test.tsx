import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SessionObservationPanel from './SessionObservationPanel'

const apiMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', () => ({ api: apiMock }))

beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockResolvedValue({ success: true, data: { success: true, observations: [] } })
})

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const observation = { id: 'observation-1', notes: 'Comentario original', created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:00:00Z', is_pinned: false, can_edit: true, can_pin: true, can_delete: true }
const props = { programId: 'program-1', sessionId: 'session-1' }
function clickCallback(element: HTMLElement): () => Promise<void> {
  const propsKey = Object.keys(element).find(key => key.startsWith('__reactProps$'))!
  return (element as any)[propsKey].onClick
}

describe('SessionObservationPanel', () => {
  it('keeps every mutation control disabled while attendance is saving', async () => {
    render(<SessionObservationPanel programId="program-1" sessionId="session-1" disabled />)

    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1))
    expect(screen.getByPlaceholderText('Ej.: Se dictó el tema… Observaciones generales…')).toBeDisabled()
    const add = screen.getByRole('button', { name: 'Añadir' })
    expect(add).toBeDisabled()
    fireEvent.click(add)
    expect(apiMock).toHaveBeenCalledTimes(1)
  })

  it('allows contextual creation but hides administration in append-only mode', async () => {
    apiMock.mockResolvedValueOnce({ success: true, data: { success: true, observations: [observation] } })
      .mockResolvedValueOnce({ success: true, data: { success: true, observation: { ...observation, id: 'new-note', notes: 'Nota móvil' } } })
    render(<SessionObservationPanel {...props} mutationMode="append-only" />)
    await screen.findByText(observation.notes)
    expect(screen.queryByTitle('Editar')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Fijar')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Eliminar')).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Nota móvil' } })
    fireEvent.click(screen.getByRole('button', { name: 'Añadir' }))
    await screen.findByText('Nota móvil')
    expect(apiMock.mock.calls[1][0]).toBe('/api/programs/program-1/sessions/session-1/observations')
    expect(JSON.parse(apiMock.mock.calls[1][1].body)).toEqual({ notes: 'Nota móvil' })
  })

  it('pauses an edit draft and rejects saved desktop callbacks until management returns', async () => {
    apiMock.mockResolvedValueOnce({ success: true, data: { success: true, observations: [observation] } })
    const view = render(<SessionObservationPanel {...props} />)
    await screen.findByText(observation.notes)
    const pin = clickCallback(screen.getByTitle('Fijar'))
    const remove = clickCallback(screen.getByTitle('Eliminar'))
    fireEvent.click(screen.getByTitle('Editar'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Editar comentario de sesión' }), { target: { value: 'Edición pendiente' } })
    const save = clickCallback(screen.getByRole('button', { name: 'Guardar' }))
    view.rerender(<SessionObservationPanel {...props} mutationMode="append-only" />)
    await act(async () => { await save(); await pin(); await remove() })
    expect(apiMock).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('textbox', { name: 'Editar comentario de sesión' })).not.toBeInTheDocument()
    view.rerender(<SessionObservationPanel {...props} />)
    expect(screen.getByRole('textbox', { name: 'Editar comentario de sesión' })).toHaveValue('Edición pendiente')
  })

  it('pauses a deletion confirmation on mobile and requires an explicit desktop confirmation', async () => {
    apiMock.mockResolvedValueOnce({ success: true, data: { success: true, observations: [observation] } })
      .mockResolvedValueOnce({ success: true, data: { success: true } })
    const view = render(<SessionObservationPanel {...props} />)
    await screen.findByText(observation.notes)
    fireEvent.click(screen.getByTitle('Eliminar'))
    const confirm = clickCallback(screen.getByRole('button', { name: 'Eliminar comentario' }))
    expect(apiMock).toHaveBeenCalledTimes(1)
    view.rerender(<SessionObservationPanel {...props} mutationMode="append-only" />)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    await act(async () => { await confirm() })
    expect(apiMock).toHaveBeenCalledTimes(1)
    view.rerender(<SessionObservationPanel {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar comentario' }))
    await waitFor(() => expect(screen.queryByText(observation.notes)).not.toBeInTheDocument())
    expect(apiMock).toHaveBeenCalledTimes(2)
    expect(apiMock.mock.calls[1][1].method).toBe('DELETE')
  })

  it('finishes an already sent write once while read-only and preserves newer drafts', async () => {
    let resolve!: (result: unknown) => void
    apiMock.mockImplementationOnce(async () => ({ success: true, data: { success: true, observations: [] } }))
      .mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const onChanged = vi.fn()
    const view = render(<SessionObservationPanel {...props} onChanged={onChanged} />)
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Ya enviada' } })
    const create = clickCallback(screen.getByRole('button', { name: 'Añadir' }))
    await act(async () => { void create(); void create() })
    expect(apiMock).toHaveBeenCalledTimes(2)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Nueva pendiente' } })
    view.rerender(<SessionObservationPanel {...props} onChanged={onChanged} mutationMode="read-only" />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    await act(async () => resolve({ success: true, data: { success: true, observation: { ...observation, notes: 'Ya enviada' } } }))
    expect(screen.getByText('Ya enviada')).toBeInTheDocument()
    expect(onChanged).toHaveBeenCalledOnce()
    view.rerender(<SessionObservationPanel {...props} onChanged={onChanged} mutationMode="append-only" />)
    expect(screen.getByRole('textbox')).toHaveValue('Nueva pendiente')
    expect(apiMock).toHaveBeenCalledTimes(2)
  })

  it('keeps a failed comment for an explicit retry', async () => {
    apiMock.mockResolvedValueOnce({ success: true, data: { success: true, observations: [] } })
      .mockResolvedValueOnce({ success: false, error: 'Conflicto de guardado' })
      .mockResolvedValueOnce({ success: true, data: { success: true, observation } })
    render(<SessionObservationPanel {...props} mutationMode="append-only" />)
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: observation.notes } })
    fireEvent.click(screen.getByRole('button', { name: 'Añadir' }))
    await screen.findByText('Conflicto de guardado')
    expect(screen.getByRole('textbox')).toHaveValue(observation.notes)
    fireEvent.click(screen.getByRole('button', { name: 'Añadir' }))
    await screen.findByText(observation.notes)
    expect(screen.getByRole('textbox')).toHaveValue('')
  })
})
