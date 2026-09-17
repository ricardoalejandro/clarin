import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ prepared: vi.fn(), enter: vi.fn(), fallback: vi.fn(), dismiss: vi.fn() }))
vi.mock('@/lib/offlineV5Runtime', () => ({
  hasPreparedOfflineV5Copy: mocks.prepared,
  enterOfflineV5: mocks.enter,
  refreshOfflineV5FallbackOffer: mocks.fallback,
  dismissOfflineV5FallbackOffer: mocks.dismiss,
}))
vi.mock('./online', async importOriginal => {
  const actual = await importOriginal<typeof import('./online')>()
  return { ...actual, offlineAvailabilityV5: vi.fn().mockResolvedValue({ enabled: true }) }
})
vi.mock('./ClarinRuntimeProvider', () => ({
  useClarinRuntime: () => ({ snapshot: { active: false, mode: 'online', canEnterOffline: false } }),
}))

import OfflineConnectionBannerV5 from './OfflineConnectionBannerV5'
import { OfflineAPIErrorV5, offlineAvailabilityV5 } from './online'

const availability = vi.mocked(offlineAvailabilityV5)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.prepared.mockResolvedValue(true)
  mocks.fallback.mockResolvedValue(true)
  mocks.dismiss.mockResolvedValue(undefined)
  mocks.enter.mockResolvedValue({ active: true, mode: 'offline' })
  availability.mockResolvedValue({ enabled: true } as Awaited<ReturnType<typeof offlineAvailabilityV5>>)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('Offline v5 outage choice', () => {
  it('offers only the exact prepared identity and stays on the canonical surface', async () => {
    render(<OfflineConnectionBannerV5 userId="user-a" accountId="account-a" username="ricardo" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Seguir sin conexión' }))
    fireEvent.change(screen.getByLabelText(/contraseña actual/i), { target: { value: 'correct horse battery staple' } })
    fireEvent.click(screen.getByRole('button', { name: 'Entrar offline' }))
    await vi.waitFor(() => expect(mocks.enter).toHaveBeenCalledWith({
      username: 'ricardo',
      password: 'correct horse battery staple',
      userId: 'user-a',
      accountId: 'account-a',
    }))
    expect(mocks.prepared).toHaveBeenCalledWith('user-a', 'account-a')
  })

  it('does not offer offline unless the service worker classified an infrastructure failure', async () => {
    mocks.fallback.mockResolvedValue(false)
    render(<OfflineConnectionBannerV5 userId="user-a" accountId="account-a" username="ricardo" />)
    await vi.waitFor(() => expect(mocks.fallback).toHaveBeenCalledOnce())
    expect(screen.queryByRole('button', { name: 'Seguir sin conexión' })).not.toBeInTheDocument()
  })

  it('offers the exact prepared copy when Clarin is unreachable although the browser reports internet', async () => {
    mocks.fallback.mockResolvedValue(false)
    availability.mockRejectedValue(new OfflineAPIErrorV5(502, 'http_502', 'gateway'))
    render(<OfflineConnectionBannerV5 userId="user-a" accountId="account-a" username="ricardo" />)
    expect(await screen.findByRole('button', { name: 'Seguir sin conexión' })).toBeInTheDocument()
    expect(mocks.prepared).toHaveBeenCalledWith('user-a', 'account-a')
  })

  it('does not bypass a trusted authentication denial', async () => {
    mocks.fallback.mockResolvedValue(false)
    availability.mockRejectedValue(new OfflineAPIErrorV5(403, 'forbidden', 'denied'))
    render(<OfflineConnectionBannerV5 userId="user-a" accountId="account-a" username="ricardo" />)
    await vi.waitFor(() => expect(availability).toHaveBeenCalledOnce())
    expect(screen.queryByRole('button', { name: 'Seguir sin conexión' })).not.toBeInTheDocument()
  })

  it('does not offer another account when the exact user/account copy is absent', async () => {
    mocks.prepared.mockResolvedValue(false)
    render(<OfflineConnectionBannerV5 userId="user-a" accountId="account-b" username="ricardo" />)
    await vi.waitFor(() => expect(mocks.prepared).toHaveBeenCalledWith('user-a', 'account-b'))
    expect(screen.queryByRole('button', { name: 'Seguir sin conexión' })).not.toBeInTheDocument()
  })

  it('lets the user wait and dismisses the current fallback offer without opening local data', async () => {
    render(<OfflineConnectionBannerV5 userId="user-a" accountId="account-a" username="ricardo" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Esperar' }))
    expect(mocks.dismiss).toHaveBeenCalledOnce()
    expect(mocks.enter).not.toHaveBeenCalled()
    expect(screen.getByText(/esperando a que clarin vuelva/i)).toBeInTheDocument()
  })
})
