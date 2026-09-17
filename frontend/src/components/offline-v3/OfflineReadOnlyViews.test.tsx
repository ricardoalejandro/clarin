import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OfflineDataGateway } from '@/offline-v3/gateway'
import type { OfflineProgram } from '@/offline-v3/types'
import OfflineContactsView from './OfflineContactsView'
import OfflineProgramsView from './OfflineProgramsView'

afterEach(cleanup)
const contactA = { id: 'contact-a', version: 1, display_name: 'Contacto A' }, contactB = { id: 'contact-b', version: 1, display_name: 'Contacto B' }
const program: OfflineProgram = {
  id: 'program', version: 1, name: 'Programa de prueba',
  active_roster: [{ id: 'active', contact_id: 'shared-contact', name: 'Participación actual', status: 'active', enrolled_at: '2026-09-02T00:00:00Z' }],
  historical_participations: [{ id: 'retired', contact_id: 'shared-contact', name: 'Participación retirada', status: 'dropped', enrolled_at: '2026-09-01T00:00:00Z', dropped_at: '2026-09-02T00:00:00Z' }],
  sessions: [{ id: 'session-a', date: '2026-09-02T00:00:00Z', title: 'Sesión A' }, { id: 'session-b', date: '2026-09-03T00:00:00Z', title: 'Sesión B' }],
  eligible_attendance: [],
  out_of_window_history: [{ id: 'outside', participant_id: 'retired', session_id: 'session-a', session_date: '2026-09-02', status: 'present', notes: 'Registro fuera de matrícula' }],
}

describe('offline readonly resource sessions', () => {
  it('does not reopen a contact after close or overwrite a newer selected contact', async () => {
    const completions: Array<(value: unknown) => void> = []
    const gateway = { contacts: vi.fn().mockResolvedValue({ items: [contactA, contactB] }), contact: vi.fn(() => new Promise(resolve => completions.push(resolve))) } as unknown as OfflineDataGateway
    render(<OfflineContactsView gateway={gateway} />)
    fireEvent.click(await screen.findByRole('button', { name: /Contacto A/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }))
    await act(async () => completions[0]({ item: contactA }))
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Contacto A/ }))
    fireEvent.click(screen.getByRole('button', { name: /Contacto B/ }))
    await act(async () => completions[2]({ item: contactB }))
    await act(async () => completions[1]({ item: contactA }))
    expect(screen.getByRole('complementary')).toHaveAccessibleName('Detalle de Contacto B')
  })
  it('clears old account content and rejects its late response after gateway switch', async () => {
    let finish!: (value: unknown) => void
    const previous = { contacts: vi.fn(() => new Promise(resolve => { finish = resolve })) } as unknown as OfflineDataGateway
    const current = { contacts: vi.fn().mockResolvedValue({ items: [contactB] }) } as unknown as OfflineDataGateway
    const view = render(<OfflineContactsView gateway={previous} />)
    view.rerender(<OfflineContactsView gateway={current} />)
    expect(await screen.findByText('Contacto B')).toBeVisible()
    await act(async () => finish({ items: [contactA] }))
    expect(screen.queryByText('Contacto A')).not.toBeInTheDocument()
  })
  it('preserves the selected contact while refreshing its authoritative local copy', async () => {
    const gateway = { contacts: vi.fn().mockResolvedValue({ items: [contactA] }), contact: vi.fn().mockResolvedValueOnce({ item: contactA }).mockResolvedValue({ item: { ...contactA, notes: 'Nota sincronizada' } }) } as unknown as OfflineDataGateway
    const view = render(<OfflineContactsView gateway={gateway} refreshToken="one" />)
    fireEvent.click(await screen.findByRole('button', { name: /Contacto A/ }))
    await waitFor(() => expect(screen.queryByText('Descifrando detalle…')).not.toBeInTheDocument())
    view.rerender(<OfflineContactsView gateway={gateway} refreshToken="two" />)
    expect(await screen.findByText('Nota sincronizada')).toBeVisible()
    expect(screen.getByRole('complementary')).toHaveAccessibleName('Detalle de Contacto A')
  })
  it('displays pending attendance and excluded history without mixing enrollments; refresh keeps the session', async () => {
    const gateway = { program: vi.fn().mockResolvedValue({ item: program }) } as unknown as OfflineDataGateway
    const view = render(<OfflineProgramsView gateway={gateway} programId="program" navigate={vi.fn()} refreshToken="one" />)
    const heading = await screen.findByRole('heading', { name: 'Asistencia · Sesión A' })
    const attendance = within(heading.parentElement!)
    expect(attendance.getByText('Participación actual')).toBeVisible()
    expect(attendance.getByText('Pendiente')).toBeVisible()
    expect(attendance.queryByText('Participación retirada')).not.toBeInTheDocument()
    expect(attendance.queryByText('Ausente')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Sesión B/ }))
    view.rerender(<OfflineProgramsView gateway={gateway} programId="program" navigate={vi.fn()} refreshToken="two" />)
    await waitFor(() => expect(gateway.program).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('heading', { name: 'Asistencia · Sesión B' })).toBeVisible()
    expect(screen.getByRole('button', { name: /Sesión B/ })).toHaveAttribute('aria-pressed', 'true')
  })
})
