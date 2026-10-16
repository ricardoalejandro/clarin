import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import ContactDetailSurface from '@/components/contact-details/ContactDetailSurface'
import { OfflineV5RouteAdapter } from './routeAdapter'
import type { OfflineV5Engine } from './engine'
import type { OfflineV5MutationInput, OfflineV5Snapshot } from './types'

// Only the transport is replaced: the ordinary surface and useContactProfile execute unchanged.
vi.mock('@/lib/api', () => ({ api: vi.fn(), subscribeWebSocket: () => () => {} }))
vi.mock('@/lib/authScope', () => ({ getAuthScope: () => 'active:offline-fixture', isAuthIdentityChanging: () => false, subscribeAuthScope: () => () => {} }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

function prepare(includeContact: boolean) {
  const identity = { id: 'contact', account_id: 'account', name: 'Participante preparada', phone: '51900000001', updated_at: '2026-10-15T00:00:00Z' }
  const contactPayload = { contact: identity, phones: [], tags: [{ id: 'tag', name: 'Inscrita', color: '#123456' }], custom_fields: [], direct_observations: [], observation_count: 0 }
  const make = (module: OfflineV5Snapshot['module'], id: string, payload: Record<string, unknown>): OfflineV5Snapshot => ({
    protocol_version: 5, manifest_id: 'manifest', manifest_revision: 1, selection_id: `selection-${id}`, root_selection_id: `selection-${id}`, root_resource_id: id,
    module, resource_type: module === 'programs' ? 'program' : 'contact', resource_id: id, dependency: false, head_version: 1,
    content_hash: 'hash', payload_json: '{}', tombstone: false, generated_at: '2026-10-16T00:00:00Z', payload,
  })
  const snapshots = [make('programs', 'program', { program: { id: 'program' }, active_roster: [{ id: 'participant', program_id: 'program', contact_id: 'contact' }], contact_profiles: [contactPayload] })]
  if (includeContact) snapshots.push(make('contacts', 'contact', contactPayload))
  const session = { identity: { user_id: 'user', account_id: 'account' }, metadata: { actor: { username: 'User' } }, manifest: {
    roots: snapshots, entity_versions: [{ entity_id: 'contact', version: 123 }], capabilities: includeContact ? [{ action: 'contacts.update', selection_id: 'selection-contact' }] : [],
  } }
  const mutations: OfflineV5MutationInput[] = []
  const overlays: Array<{ entity_id: string; entity_type: string; root_selection_id: string; value: unknown }> = []
  const adapter = new OfflineV5RouteAdapter({
    origin: 'https://clarin.test', checkedSession: async () => session, sessions: { require: () => session },
    aggregates: async (_p: string, _g: number, module: string) => snapshots.filter(value => value.module === module),
    overlays: async (_p: string, _g: number, type: string) => overlays.filter(value => value.entity_type === type),
    queueMutation: async (_p: string, _g: number, input: OfflineV5MutationInput) => {
      mutations.push(input)
      const entity = { entity_id: input.entity_id, entity_type: input.entity_type, root_selection_id: input.selection_id, value: input.optimistic_value }
      overlays.push(entity)
      return { operation_id: 'op', state: 'queued', entity }
    },
  } as unknown as OfflineV5Engine)
  vi.mocked(api).mockImplementation(async (path, options = {}) => {
    const response = await adapter.request('port', 1, { url: `https://clarin.test${path}`, method: options.method || 'GET', headers: [], body: typeof options.body === 'string' ? options.body : undefined })
    const data = JSON.parse(response.body || '{}')
    return { success: response.status < 400, status: response.status, data, error: data.message || data.error }
  })
  return { mutations }
}

describe('ordinary Contact window through the offline route adapter', () => {
  it('opens the prepared Program identity in the canonical surface with honest read-only controls', async () => {
    const { mutations } = prepare(false)
    render(<ContactDetailSurface contactId="contact" context={{ type: 'program_participant', id: 'participant' }} onClose={vi.fn()} />)
    expect(await screen.findByText('Participante preparada')).toBeVisible()
    expect(await screen.findByText('Inscrita')).toBeVisible()
    expect(screen.getByRole('button', { name: /^Editar$/ })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Quitar etiqueta Inscrita' })).toBeNull()
    expect(mutations).toHaveLength(0)
    expect(vi.mocked(api).mock.calls.some(([path]) => path === '/api/contact-profiles/contact?context_type=program_participant&context_id=participant')).toBe(true)
  })

  it('edits and reconciles the same Contact window when the Contact root is also prepared', async () => {
    const { mutations } = prepare(true)
    render(<ContactDetailSurface contactId="contact" context={{ type: 'program_participant', id: 'participant' }} onClose={vi.fn()} />)
    await screen.findByText('Participante preparada')
    fireEvent.click(screen.getByRole('button', { name: /^Editar$/ }))
    fireEvent.change(screen.getByLabelText('Nombre visible'), { target: { value: 'Nombre actualizado offline' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar contacto' }))
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Editar contacto' })).toBeNull())
    expect(screen.getByText('Nombre actualizado offline')).toBeVisible()
    expect(mutations).toHaveLength(1)
    expect(mutations[0]).toMatchObject({ selection_id: 'selection-contact', action: 'contacts.update', base_version: 123, base: { name: 'Participante preparada' }, payload: { custom_name: 'Nombre actualizado offline' } })
  })

  it('does not display identity for a different participation context', async () => {
    prepare(false)
    render(<ContactDetailSurface contactId="contact" context={{ type: 'program_participant', id: 'not-prepared' }} onClose={vi.fn()} />)
    expect(await screen.findByText('Este contexto del contacto no fue incluido en la copia offline.')).toBeVisible()
    expect(screen.queryByText('Participante preparada')).toBeNull()
  })
})
