import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DetachedEventParticipantDetail from './DetachedEventParticipantDetail'

afterEach(cleanup)

describe('DetachedEventParticipantDetail', () => {
  it('keeps legacy event records honest and saves them without adapting them to Lead', async () => {
    const onSave = vi.fn().mockResolvedValue({ success: true })
    render(
      <DetachedEventParticipantDetail
        participant={{ id: 'participant-1', name: 'Ana', phone: '+51999999999', birth_date: '1992-05-04', tags: [] }}
        eventName="Taller agosto"
        context={<div>Contexto del evento</div>}
        activity={<div>Actividad directa</div>}
        onSave={onSave}
        onMessage={vi.fn()}
      />,
    )

    expect(screen.getByText('Sin contacto canónico')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Tareas relacionadas/ }))
    expect(screen.getByRole('button', { name: 'Nueva tarea' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Editar' }))
    fireEvent.change(screen.getByLabelText('Nombre'), { target: { value: 'Ana María' } })
    expect(document.querySelector('input[type="date"]')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Fecha de nacimiento: 04/05/1992' }))
    fireEvent.click(document.querySelector('[data-date-key="1992-05-08"]') as HTMLButtonElement)
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name: 'Ana María', phone: '+51999999999', birth_date: '1992-05-08', age: 0 })))
  })
})
