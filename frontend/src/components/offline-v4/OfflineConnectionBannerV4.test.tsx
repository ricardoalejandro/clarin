import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ prepared: vi.fn(), probe: vi.fn(), mode: vi.fn(), enable: vi.fn() }))
vi.mock('@/offline-v4/client', () => ({ hasPreparedCopy: mocks.prepared }))
vi.mock('./availability', () => ({ probeAvailabilityV4: mocks.probe }))
vi.mock('@/lib/offlineV4ServiceWorker', () => ({ setOfflineV4Mode: mocks.mode, setOfflineV4NavigationEnabled: mocks.enable }))
import OfflineConnectionBannerV4 from './OfflineConnectionBannerV4'

beforeEach(() => { vi.clearAllMocks(); mocks.prepared.mockResolvedValue(true); mocks.probe.mockResolvedValue({ state: 'infrastructure_unavailable', code: 'network' }) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('dashboard outage choice', () => {
  it('offers the exact prepared identity a choice and waiting never changes mode', async () => {
    render(<OfflineConnectionBannerV4 userId="user-a" accountId="account-a" />)
    expect(await screen.findByRole('button', { name: 'Seguir sin conexión' })).toBeInTheDocument()
    expect(mocks.prepared).toHaveBeenCalledWith('user-a', 'account-a')
    fireEvent.click(screen.getByRole('button', { name: 'Esperar' }))
    expect(screen.getByText(/Esperando a que Clarin/)).toBeInTheDocument()
    expect(mocks.mode).not.toHaveBeenCalled()
  })
  it('does not turn a trusted auth denial into an offline bypass offer', async () => {
    mocks.probe.mockResolvedValue({ state: 'auth_denied', code: 'unauthorized' })
    render(<OfflineConnectionBannerV4 userId="user-a" accountId="account-a" />)
    await vi.waitFor(() => expect(mocks.probe).toHaveBeenCalledOnce())
    expect(screen.queryByRole('button', { name: 'Seguir sin conexión' })).not.toBeInTheDocument()
  })
  it('does not probe or offer a copy belonging only to another account', async () => {
    mocks.prepared.mockResolvedValue(false)
    render(<OfflineConnectionBannerV4 userId="user-a" accountId="foreign-account" />)
    await vi.waitFor(() => expect(mocks.prepared).toHaveBeenCalledOnce())
    expect(mocks.probe).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Seguir sin conexión' })).not.toBeInTheDocument()
  })
  it('keeps the online draft untouched when the user cancels the transition warning', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<OfflineConnectionBannerV4 userId="user-a" accountId="account-a" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Seguir sin conexión' }))
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('borradores'))
    expect(mocks.enable).not.toHaveBeenCalled()
    expect(mocks.mode).not.toHaveBeenCalled()
  })
  it('switches using only the verified local shell, without trying to prepare it over a failed network', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    mocks.mode.mockResolvedValue(false)
    render(<OfflineConnectionBannerV4 userId="11111111-1111-4111-8111-111111111111" accountId="22222222-2222-4222-8222-222222222222" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Seguir sin conexión' }))
    await vi.waitFor(() => expect(mocks.mode).toHaveBeenCalledExactlyOnceWith('offline'))
    expect(mocks.enable).not.toHaveBeenCalled()
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo abrir el modo offline')
  })
})
