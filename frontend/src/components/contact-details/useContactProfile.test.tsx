import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useContactProfile } from './useContactProfile'
import type { Observation } from '@/types/contact'
import { beginAuthIdentityChange, completeAuthIdentityChange, getAuthScope } from '@/lib/authScope'

const mocks = vi.hoisted(() => ({ api: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: mocks.api, subscribeWebSocket: () => () => {} }))
const contact = (id: string) => ({ id, name: id, avatar_url: 'old-photo', structured_tags: [], extra_phones: [], custom_field_values: [] })
const note = (id: string): Observation => ({ id, contact_id: 'contact-a', lead_id: null, direction: null, outcome: null, created_by_name: null, type: 'note', notes: 'Synthetic QA note', created_at: '2026-09-01T00:00:00Z', is_pinned: false, can_pin: true, can_edit: true, can_delete: true })

beforeEach(() => {
  localStorage.clear()
  mocks.api.mockReset().mockImplementation(async (url: string) => ({ success: true, data: {
    success: true, contact: contact(url.includes('contact-b') ? 'contact-b' : 'contact-a'),
    capabilities: { can_view: true, can_edit: true, can_manage_avatar: true, can_manage_observations: true, can_create_tags: false },
    observation_count: 75, pinned_observation_count: 0, observations: [], total: 75,
  } }))
})
afterEach(cleanup)

describe('canonical contact profile session', () => {
  it('a late pin response for A must not inject its note into B', async () => {
    const view = renderHook(({ id }: { id: string }) => useContactProfile({ contactId: id, context: { type: 'contact', id }, initialContact: contact(id) }), { initialProps: { id: 'contact-a' } })
    await waitFor(() => expect(view.result.current.capabilities.can_edit).toBe(true))
    let resolvePin!: (value: unknown) => void
    mocks.api.mockImplementationOnce(() => new Promise(resolve => { resolvePin = resolve }))
    let operation!: Promise<unknown>
    act(() => { operation = view.result.current.setObservationPinned(note('note-a'), true) })
    view.rerender({ id: 'contact-b' })
    await waitFor(() => expect(view.result.current.contact?.id).toBe('contact-b'))
    await act(async () => { resolvePin({ success: true, data: { success: true, observation: { ...note('note-a'), is_pinned: true } } }); await operation })
    expect(view.result.current.observations.map(item => item.id)).toEqual([])
  })

  it('canonical null from avatar deletion must clear the prior avatar immediately', async () => {
    const onContactChange = vi.fn()
    const view = renderHook(() => useContactProfile({ contactId: 'contact-a', context: { type: 'contact', id: 'contact-a' }, initialContact: contact('contact-a'), onContactChange }))
    await waitFor(() => expect(view.result.current.capabilities.can_edit).toBe(true))
    const calls = onContactChange.mock.calls.length
    act(() => view.result.current.updateAvatarLocally({ avatar_url: null, revision: 2 }))
    act(() => view.result.current.updateAvatarLocally({ avatar_url: null, revision: 2 }))
    expect(view.result.current.contact?.avatar_url).toBeNull()
    expect(onContactChange).toHaveBeenCalledTimes(calls + 1)
  })

  it('rejects cross-account and older avatar events while accepting canonical null in the current scope', async () => {
    const view = renderHook(() => useContactProfile({ contactId: 'contact-a', context: { type: 'contact', id: 'contact-a' } }))
    await waitFor(() => expect(view.result.current.capabilities.can_edit).toBe(true))
    const emit = (authScope: string, avatar_url: string | null, revision: number) => window.dispatchEvent(new CustomEvent('clarin:contact-avatar-updated', { detail: { contactId: 'contact-a', authScope, avatar: { avatar_url, revision } } }))
    act(() => { emit('active:other-account', 'foreign-photo', 100) })
    expect(view.result.current.contact?.avatar_url).toBe('old-photo')
    act(() => { emit(getAuthScope(), null, 3); emit(getAuthScope(), 'stale-photo', 2) })
    expect(view.result.current.contact?.avatar_url).toBeNull()
    expect(view.result.current.contact?.avatar_revision).toBe(3)
  })

  it('does not restore an older profile avatar after a newer local upload or deletion', async () => {
    const view = renderHook(() => useContactProfile({ contactId: 'contact-a', context: { type: 'contact', id: 'contact-a' } }))
    await waitFor(() => expect(view.result.current.capabilities.can_edit).toBe(true))
    let resolve!: (value: unknown) => void
    mocks.api.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    let refresh!: Promise<void>
    act(() => { refresh = view.result.current.refresh() })
    act(() => { view.result.current.updateAvatarLocally({ avatar_url: null, revision: 6 }) })
    await act(async () => { resolve({ success: true, data: { success: true, contact: { ...contact('contact-a'), avatar_url: 'older-profile-photo', avatar_revision: 5 }, capabilities: { can_view: true, can_edit: true } } }); await refresh })
    expect(view.result.current.contact?.avatar_url).toBeNull()
    expect(view.result.current.contact?.avatar_revision).toBe(6)
  })

  it('repeated pin confirmation must leave one pinned record and one count', async () => {
    const view = renderHook(() => useContactProfile({ contactId: 'contact-a', context: { type: 'contact', id: 'contact-a' }, initialContact: contact('contact-a') }))
    await waitFor(() => expect(view.result.current.capabilities.can_edit).toBe(true))
    mocks.api.mockImplementation(async () => ({ success: true, data: { success: true, observation: { ...note('note-a'), is_pinned: true } } }))
    await act(async () => { await view.result.current.setObservationPinned(note('note-a'), true); await view.result.current.setObservationPinned(note('note-a'), true) })
    expect(view.result.current.observations).toHaveLength(1)
    expect(view.result.current.pinnedObservationCount).toBe(1)
  })

  it('single-flights one note and gates the canonical pin permission', async () => {
    const view = renderHook(() => useContactProfile({ contactId: 'contact-a', context: { type: 'contact', id: 'contact-a' } }))
    await waitFor(() => expect(view.result.current.capabilities.can_edit).toBe(true))
    const calls = mocks.api.mock.calls.length
    await act(async () => { expect((await view.result.current.setObservationPinned({ ...note('not-owned'), can_pin: false }, true)).success).toBe(false) })
    expect(mocks.api).toHaveBeenCalledTimes(calls)
    let resolve!: (value: unknown) => void
    mocks.api.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    let first!: Promise<unknown>
    act(() => { first = view.result.current.setObservationPinned(note('note-a'), true) })
    expect(view.result.current.pendingObservationIds.has('note-a')).toBe(true)
    await act(async () => { expect((await view.result.current.setObservationPinned(note('note-a'), true)).success).toBe(false) })
    expect(mocks.api).toHaveBeenCalledTimes(calls + 1)
    await act(async () => { resolve({ success: true, data: { success: true, observation: { ...note('note-a'), is_pinned: true }, pinned_total: 1 } }); await first })
    expect(view.result.current.pendingObservationIds.size).toBe(0)
  })

  it('pages past fifty, retains loaded rows on failure, retries and silently rebuilds the same depth', async () => {
    const rows = Array.from({ length: 75 }, (_, index) => note(`note-${String(75-index).padStart(3, '0')}`))
    let failNextPage = false
    mocks.api.mockImplementation(async (url: string, options: RequestInit = {}) => {
      if (url.includes('/pin?')) return { success: true, data: { success: true, observation: { ...rows[0], is_pinned: true }, total: 75, pinned_total: 1 } }
      if (url.includes('/observations?')) {
        const second = new URL(url, 'http://test.invalid').searchParams.has('cursor')
        if (second && failNextPage) { failNextPage = false; return { success: false, error: 'Página temporalmente no disponible' } }
        return { success: true, data: { success: true, observations: second ? rows.slice(50) : rows.slice(0, 50), total: 75, pinned_total: 1, next_cursor: second ? '' : 'page-2', has_more: !second } }
      }
      return { success: true, data: { success: true, contact: contact('contact-a'), capabilities: { can_view: true, can_edit: true, can_manage_observations: true }, observation_count: 75, pinned_observation_count: 1 } }
    })
    const view = renderHook(() => useContactProfile({ contactId: 'contact-a', context: { type: 'contact', id: 'contact-a' } }))
    await waitFor(() => expect(view.result.current.capabilities.can_edit).toBe(true))
    await act(async () => { await view.result.current.refreshObservations() })
    expect(view.result.current.observations).toHaveLength(50)
    expect(view.result.current.observationsHasMore).toBe(true)
    failNextPage = true
    await act(async () => { await view.result.current.loadMoreObservations() })
    expect(view.result.current.observations).toHaveLength(50)
    expect(view.result.current.observationsError).toContain('temporalmente')
    await act(async () => { await view.result.current.loadMoreObservations() })
    expect(view.result.current.observations).toHaveLength(75)
    expect(view.result.current.observationsHasMore).toBe(false)
    expect(view.result.current.observationsError).toBe('')
    await act(async () => { await view.result.current.setObservationPinned(rows[0], true) })
    await waitFor(() => expect(view.result.current.observations).toHaveLength(75))
    expect(mocks.api.mock.calls.filter(([url]) => String(url).includes('/observations?')).every(([url]) => String(url).includes('limit=50'))).toBe(true)
  })

  it('loads a history expansion requested while a note mutation is pending', async () => {
    let resolve!: (value: unknown) => void
    const pinned = { ...note('pending-note'), is_pinned: true }
    mocks.api.mockImplementation((url: string) => {
      if (url.includes('/pin?')) return new Promise(done => { resolve = done })
      if (url.includes('/observations?')) return Promise.resolve({ success: true, data: { success: true, observations: [pinned], total: 1, pinned_total: 1, has_more: false, next_cursor: '' } })
      return Promise.resolve({ success: true, data: { success: true, contact: contact('contact-a'), capabilities: { can_view: true, can_edit: true, can_manage_observations: true }, observation_count: 1, pinned_observation_count: 1 } })
    })
    const view = renderHook(() => useContactProfile({ contactId: 'contact-a', context: { type: 'contact', id: 'contact-a' } }))
    await waitFor(() => expect(view.result.current.capabilities.can_edit).toBe(true))
    let operation!: Promise<unknown>
    act(() => { operation = view.result.current.setObservationPinned(note('pending-note'), true) })
    await act(async () => { await view.result.current.refreshObservations() })
    expect(mocks.api.mock.calls.some(([url]) => String(url).includes('/observations?'))).toBe(false)
    await act(async () => { resolve({ success: true, data: { success: true, observation: pinned, total: 1, pinned_total: 1 } }); await operation })
    await waitFor(() => expect(view.result.current.observationsLoaded).toBe(true))
    expect(view.result.current.observations).toEqual([pinned])
  })

  it('keeps canonical zero counts after deleting the last note', async () => {
    let rows = [note('last-note')]
    mocks.api.mockImplementation(async (url: string, options: RequestInit = {}) => {
      if (options.method === 'DELETE') { rows = []; return { success: true, data: { success: true, total: 0, pinned_total: 0 } } }
      if (url.includes('/observations?')) return { success: true, data: { success: true, observations: rows, total: rows.length, pinned_total: 0, has_more: false, next_cursor: '' } }
      return { success: true, data: { success: true, contact: contact('contact-a'), capabilities: { can_view: true, can_edit: true, can_manage_observations: true }, observation_count: rows.length, pinned_observation_count: 0 } }
    })
    const view = renderHook(() => useContactProfile({ contactId: 'contact-a', context: { type: 'contact', id: 'contact-a' } }))
    await waitFor(() => expect(view.result.current.capabilities.can_edit).toBe(true))
    await act(async () => { await view.result.current.refreshObservations(); await view.result.current.deleteObservation('last-note') })
    expect(view.result.current.observationCount).toBe(0)
    expect(view.result.current.pinnedObservationCount).toBe(0)
    expect(view.result.current.observations).toEqual([])
  })

  it('rejects an old A response after A → B → A and across an account transition', async () => {
    const view = renderHook(({ id }: { id: string }) => useContactProfile({ contactId: id, context: { type: 'contact', id }, initialContact: contact(id) }), { initialProps: { id: 'contact-a' } })
    await waitFor(() => expect(view.result.current.capabilities.can_edit).toBe(true))
    let resolve!: (value: unknown) => void
    mocks.api.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    let pending!: Promise<unknown>
    act(() => { pending = view.result.current.setObservationPinned(note('old-a'), true) })
    view.rerender({ id: 'contact-b' })
    view.rerender({ id: 'contact-a' })
    await act(async () => { resolve({ success: true, data: { success: true, observation: { ...note('old-a'), is_pinned: true } } }); await pending })
    expect(view.result.current.observations).toEqual([])
    await waitFor(() => expect(view.result.current.capabilities.can_edit).toBe(true))
    mocks.api.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    act(() => { pending = view.result.current.setObservationPinned(note('prior-account'), true) })
    act(() => { beginAuthIdentityChange() })
    expect(view.result.current.contact).toBeNull()
    await act(async () => { resolve({ success: true, data: { success: true, observation: note('prior-account') } }); await pending })
    expect(view.result.current.observations).toEqual([])
    act(() => { completeAuthIdentityChange() })
    await waitFor(() => expect(view.result.current.contact?.id).toBe('contact-a'))
  })
})
