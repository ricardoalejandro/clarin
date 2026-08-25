import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRef, type ReactNode } from 'react'
import type { ContactProfileContact } from '@/types/contact-profile'
import ContactDetailSurface, { type ContactDetailSurfaceHandle } from './ContactDetailSurface'

const mocks = vi.hoisted(() => ({ updateContact: vi.fn(), refreshObservations: vi.fn(), googleSync: vi.fn() }))

function EmbeddedPanel({ children }: { embedded?: boolean; onCountChange?: (count: number) => void; children: ReactNode }) {
  return <div>{children}</div>
}

const contact: ContactProfileContact = {
  id: 'contact-1',
  name: 'Gabriela',
  custom_name: 'Gaby',
  phone: '51999999999',
  birth_date: '1992-05-04',
  structured_tags: [],
  extra_phones: [],
  custom_field_values: [{
    id: 'value-1',
    field_id: 'field-date',
    contact_id: 'contact-1',
    field_name: 'Renovación',
    field_type: 'date',
    value_date: '2026-06-15',
    created_at: '',
    updated_at: '',
  }],
}

vi.mock('./useContactProfile', () => ({
  useContactProfile: () => ({
    contact,
    capabilities: { can_view: true, can_edit: true, can_manage_avatar: true, can_manage_observations: true, can_create_tags: true },
    availableTags: [],
    customFieldDefinitions: [{ id: 'field-date', name: 'Renovación', slug: 'renovacion', field_type: 'date', is_required: false }],
    loading: false,
    refreshing: false,
    error: '',
    saving: false,
    observations: [],
    observationCount: 0,
    observationsLoaded: false,
    observationsLoading: false,
    observationsError: '',
    savingObservation: false,
    refresh: vi.fn(),
    refreshObservations: mocks.refreshObservations,
    updateContact: mocks.updateContact,
    updateAvatarLocally: vi.fn(),
    updateGoogleSyncLocally: vi.fn(),
    createObservation: vi.fn(),
    deleteObservation: vi.fn(),
    updateObservation: vi.fn(),
    setObservationPinned: vi.fn(),
  }),
}))

vi.mock('./useGoogleContactSync', () => ({
  useGoogleContactSync: () => mocks.googleSync(),
}))

vi.mock('@/components/ContactAvatarControl', () => ({ default: () => <div data-testid="avatar" /> }))

afterEach(cleanup)

beforeEach(() => {
  mocks.updateContact.mockReset().mockResolvedValue({ success: true, contact })
  mocks.refreshObservations.mockReset().mockResolvedValue(undefined)
  mocks.googleSync.mockReset().mockReturnValue({
    statusLoading: false,
    connected: false,
    permissionDenied: false,
    synced: false,
    mutation: null,
    statusError: '',
    actionError: '',
    feedback: '',
    retryStatus: vi.fn(),
    sync: vi.fn(),
    desync: vi.fn(),
  })
})

describe('ContactDetailSurface date editing', () => {
  it('keeps integrations collapsed and exposes accessible Google Contacts actions when opened', () => {
    mocks.googleSync.mockReturnValue({
      statusLoading: false,
      connected: true,
      permissionDenied: false,
      synced: false,
      mutation: null,
      statusError: '',
      actionError: '',
      feedback: '',
      retryStatus: vi.fn(),
      sync: vi.fn(),
      desync: vi.fn(),
    })
    render(<ContactDetailSurface contactId="contact-1" context={{ type: 'contact', id: 'contact-1' }} initialContact={contact} onClose={vi.fn()} />)

    const integrations = screen.getByRole('button', { name: /Integraciones Google Contacts disponible/ })
    expect(integrations).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('region', { name: 'Google Contacts' })).toBeNull()

    fireEvent.click(integrations)
    expect(screen.getByRole('region', { name: 'Google Contacts' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Sincronizar contacto con Google Contacts' })).toBeVisible()
  })

  it('keeps scoped and general observations separate, contiguous and lazy', () => {
    render(
      <ContactDetailSurface
        contactId="contact-1"
        context={{ type: 'lead', id: 'lead-1' }}
        initialContact={contact}
        onClose={vi.fn()}
        contextActivity={<EmbeddedPanel>Actividad directa</EmbeddedPanel>}
        contextSummary={<div>Contexto comercial</div>}
        relatedTasks={<EmbeddedPanel>Tareas CRM</EmbeddedPanel>}
      />,
    )

    const headings = [
      'Información del contacto',
      'Etiquetas',
      'Observaciones de esta oportunidad',
      'Historial general del contacto',
      'Contexto de la oportunidad',
      'Tareas relacionadas',
      'Integraciones',
    ].map(name => screen.getByRole('button', { name: new RegExp(name) }))
    headings.slice(0, -1).forEach((heading, index) => {
      expect(heading.compareDocumentPosition(headings[index + 1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })
    expect(mocks.refreshObservations).not.toHaveBeenCalled()
    fireEvent.click(headings[3])
    expect(mocks.refreshObservations).toHaveBeenCalledTimes(1)
  })

  it('uses date-only drafts for birth and custom fields and writes only on Guardar contacto', async () => {
    render(<ContactDetailSurface contactId="contact-1" context={{ type: 'event_participant', id: 'participant-1' }} initialContact={contact} onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Editar' }))
    expect(screen.getByRole('form', { name: 'Editar contacto' })).toBeInTheDocument()
    expect(document.querySelector('input[type="date"]')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Renovación: 15/06/2026' })).toBeInTheDocument()

    const birthTrigger = screen.getByRole('button', { name: 'Fecha de nacimiento: 04/05/1992' })
    fireEvent.click(birthTrigger)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByRole('form', { name: 'Editar contacto' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Elegir Fecha de nacimiento' })).not.toBeInTheDocument()
    expect(mocks.updateContact).not.toHaveBeenCalled()

    fireEvent.click(birthTrigger)
    fireEvent.click(document.querySelector('[data-date-key="1992-05-08"]') as HTMLButtonElement)
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))
    expect(screen.getByText('Cambios sin guardar')).toBeInTheDocument()
    expect(mocks.updateContact).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Guardar contacto' }))
    await waitFor(() => expect(mocks.updateContact).toHaveBeenCalledTimes(1))
    expect(mocks.updateContact).toHaveBeenCalledWith(expect.objectContaining({
      birth_date: '1992-05-08',
      custom_field_values: [expect.objectContaining({ field_id: 'field-date', value_date: '2026-06-15' })],
    }))
  })

  it('exposes the same dirty-draft close guard to an owning operational window', () => {
    const ref = createRef<ContactDetailSurfaceHandle>()
    const onClose = vi.fn()
    const confirmClose = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<ContactDetailSurface ref={ref} contactId="contact-1" context={{ type: 'contact', id: 'contact-1' }} initialContact={contact} onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'Editar' }))
    fireEvent.change(screen.getByLabelText('Nombre visible'), { target: { value: 'Gabriela actualizada' } })

    expect(ref.current?.requestClose()).toBe(false)
    expect(confirmClose).toHaveBeenCalledWith('Hay cambios del contacto sin guardar. ¿Deseas cerrar y descartarlos?')
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('form', { name: 'Editar contacto' })).toBeInTheDocument()

    confirmClose.mockReturnValue(true)
    expect(ref.current?.requestClose()).toBe(true)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
