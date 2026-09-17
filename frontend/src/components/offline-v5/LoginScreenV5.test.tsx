import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  unlock: vi.fn(),
  select: vi.fn(),
  fallback: vi.fn(),
  replaceOnlineLogin: vi.fn(),
  hasAnyPreparedCopy: vi.fn(),
  hasPreparedCopyForUsername: vi.fn(),
  dismissFallback: vi.fn(),
  subscribe: vi.fn(),
  lock: vi.fn(),
  invalidate: vi.fn(),
  beginOnline: vi.fn(),
  cancelOnline: vi.fn(),
  completeOnline: vi.fn(),
  hasWorkerRegistration: vi.fn(),
  storeExpectation: vi.fn(),
  runtimeActive: false,
  runtimeMode: 'online' as 'online' | 'locked',
  workerMode: 'online' as 'online' | 'offline',
  expectation: null as null | { version: 3; user_id: string; account_id: string; issued_at: number },
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push, replace: mocks.replace, refresh: vi.fn() }) }))
vi.mock('next/script', () => ({ default: () => null }))
vi.mock('@/components/branding/ClarinBrandMark', () => ({ default: () => <span aria-label="Clarin" /> }))
vi.mock('@/lib/api', () => ({
  getLoginNoticeForLogoutReason: () => '',
  invalidateOfflineBeforeIdentityChange: mocks.invalidate,
  markAuthTokenRefreshed: vi.fn(),
}))
vi.mock('@/offline-v3/offlineReauth', () => ({
  clearOfflineReauthExpectation: vi.fn(),
  readOfflineReauthExpectation: () => mocks.expectation,
  storeOfflineReauthExpectation: (_storage: Storage, actor: { user_id: string; account_id: string }) => {
    const expectation = { version: 3 as const, ...actor, issued_at: Date.now() }
    mocks.storeExpectation(actor)
    return expectation
  },
}))
vi.mock('@/offline-v3/availability', () => ({ classifyRemoteResponse: () => ({ state: 'auth_denied' }) }))
vi.mock('@/lib/whiteboardPublicLibraries', () => ({ WHITEBOARD_PUBLIC_LIBRARY_CALLBACK_PATH: '/public-library' }))
vi.mock('@/offline-v5/client', () => ({ browserOfflineV5Client: { lock: mocks.lock } }))
vi.mock('@/lib/offlineV5ServiceWorker', () => ({
  getOfflineV5ServiceWorkerStatus: () => Promise.resolve({ mode: mocks.workerMode }),
  hasOfflineV5ServiceWorkerRegistration: mocks.hasWorkerRegistration,
}))
vi.mock('@/lib/offlineV5Runtime', () => ({
  beginOfflineV5OnlineTransition: mocks.beginOnline,
  cancelOfflineV5OnlineTransition: mocks.cancelOnline,
  completeOfflineV5OnlineTransition: mocks.completeOnline,
  getOfflineV5RuntimeSnapshot: () => ({
    active: mocks.runtimeActive,
    mode: mocks.runtimeActive ? 'offline' : mocks.runtimeMode,
    canEnterOffline: false,
    ...(mocks.runtimeActive ? {
      userId: '11111111-1111-4111-8111-111111111111',
      accountId: '22222222-2222-4222-8222-222222222222',
    } : {}),
    authorizedModules: [],
    selectedRoots: {},
    capabilities: [],
    pendingCount: 0,
    conflictCount: 0,
  }),
  refreshOfflineV5FallbackState: mocks.fallback,
  replaceStaleOfflineLoginWithOnline: mocks.replaceOnlineLogin,
  hasAnyPreparedOfflineV5Copy: mocks.hasAnyPreparedCopy,
  hasPreparedOfflineV5CopyForUsername: mocks.hasPreparedCopyForUsername,
  dismissOfflineV5FallbackOffer: mocks.dismissFallback,
  subscribeOfflineV5Runtime: mocks.subscribe,
  unlockOfflineV5User: mocks.unlock,
  selectOfflineV5Account: mocks.select,
}))

import LoginScreen from '@/components/LoginScreen'

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState({}, '', '/login')
  mocks.expectation = null
  mocks.runtimeActive = false
  mocks.runtimeMode = 'online'
  mocks.workerMode = 'online'
  mocks.fallback.mockResolvedValue({ offer: true, reloadOnlineLogin: false })
  mocks.hasAnyPreparedCopy.mockResolvedValue(true)
  mocks.hasPreparedCopyForUsername.mockResolvedValue(true)
  mocks.dismissFallback.mockResolvedValue(undefined)
  mocks.subscribe.mockImplementation((listener: () => void) => { listener(); return () => {} })
  mocks.lock.mockResolvedValue(undefined)
  mocks.beginOnline.mockResolvedValue(undefined)
  mocks.cancelOnline.mockResolvedValue(undefined)
  mocks.completeOnline.mockResolvedValue({ active: false, mode: 'online' })
  mocks.hasWorkerRegistration.mockResolvedValue(true)
  mocks.unlock.mockResolvedValue({
    accounts: [
      { grantId: 'grant-a', accountId: 'account-a', accountName: 'Cuenta A' },
      { grantId: 'grant-b', accountId: 'account-b', accountName: 'Cuenta B' },
    ],
  })
  mocks.select.mockResolvedValue({
    active: true,
    mode: 'offline',
    canEnterOffline: true,
    accountId: 'account-b',
    authorizedModules: ['contacts'],
    selectedRoots: { contacts: ['contact-b'] },
    capabilities: ['contacts.update'],
    pendingCount: 0,
    conflictCount: 0,
  })
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({
    success: true,
    login_enabled: true,
    login_turnstile_required: false,
  }), { status: 200, headers: { 'Content-Type': 'application/json', 'X-Clarin-Response': '1' } })))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Login normal con copias Offline v5', () => {
  it('does not start the offline runtime or expose controls when this browser never prepared a copy', async () => {
    mocks.hasWorkerRegistration.mockResolvedValue(false)
    render(<LoginScreen />)
    await vi.waitFor(() => expect(mocks.hasWorkerRegistration).toHaveBeenCalled())
    expect(mocks.subscribe).not.toHaveBeenCalled()
    expect(mocks.fallback).not.toHaveBeenCalled()
    expect(mocks.hasPreparedCopyForUsername).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Entrar en modo offline' })).not.toBeInTheDocument()
  })

  it('no ofrece ni menciona Offline cuando Cloudflare falla y no existe una copia local preparada', async () => {
    mocks.fallback.mockResolvedValue({ offer: false, reloadOnlineLogin: false })
    // Another user may have a prepared copy in the same browser. It must not
    // alter this user's ordinary login or reveal that Offline exists.
    mocks.hasAnyPreparedCopy.mockResolvedValue(true)
    mocks.hasPreparedCopyForUsername.mockResolvedValue(false)
    vi.mocked(fetch).mockImplementation(async input => {
      if (String(input).includes('/api/auth/login')) throw new TypeError('network unavailable')
      return new Response(JSON.stringify({ success: true, login_enabled: true, login_turnstile_required: false }), { status: 200, headers: { 'Content-Type': 'application/json', 'X-Clarin-Response': '1' } })
    })

    render(<LoginScreen />)
    fireEvent.change(screen.getByPlaceholderText('usuario o correo'), { target: { value: 'ricardo' } })
    fireEvent.change(screen.getByPlaceholderText('tu contraseña'), { target: { value: 'contraseña actual segura' } })
    fireEvent.click(screen.getByRole('button', { name: /^Iniciar sesión$/i }))

    expect(await screen.findByText('No se pudo conectar con Clarin. Puedes esperar y volver a intentarlo.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Entrar en modo offline' })).not.toBeInTheDocument()
    expect(screen.queryByText(/copia offline autorizada/i)).not.toBeInTheDocument()
  })

  it('replaces a revoked offline shell with the ordinary online login', async () => {
    mocks.fallback.mockResolvedValue({ offer: false, reloadOnlineLogin: true })

    render(<LoginScreen />)

    await vi.waitFor(() => expect(mocks.replaceOnlineLogin).toHaveBeenCalledOnce())
    expect(screen.queryByRole('button', { name: 'Entrar en modo offline' })).not.toBeInTheDocument()
  })

  it('no revela cuentas antes de verificar la contraseña y conserva una sola pantalla de login', async () => {
    render(<LoginScreen />)
    expect(screen.queryByRole('button', { name: 'Entrar en modo offline' })).not.toBeInTheDocument()
    expect(screen.queryByText('Cuenta A')).not.toBeInTheDocument()

    vi.mocked(fetch).mockImplementation(async input => {
      if (String(input).includes('/api/auth/login')) throw new TypeError('network unavailable')
      return new Response(JSON.stringify({ success: true, login_enabled: true, login_turnstile_required: false }), { status: 200, headers: { 'Content-Type': 'application/json', 'X-Clarin-Response': '1' } })
    })
    fireEvent.change(screen.getByPlaceholderText('usuario o correo'), { target: { value: 'ricardo' } })
    fireEvent.change(screen.getByPlaceholderText('tu contraseña'), { target: { value: 'contraseña actual segura' } })
    fireEvent.click(screen.getByRole('button', { name: /^Iniciar sesión$/i }))
    expect(await screen.findByRole('button', { name: 'Entrar en modo offline' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Entrar en modo offline' }))

    expect(await screen.findByText('Cuenta A')).toBeInTheDocument()
    expect(screen.getByText('Cuenta B')).toBeInTheDocument()
    expect(mocks.unlock).toHaveBeenCalledWith('ricardo', 'contraseña actual segura')
    expect(screen.getByPlaceholderText('tu contraseña')).toHaveValue('')

    fireEvent.click(screen.getByRole('button', { name: /Cuenta B/i }))
    await vi.waitFor(() => expect(mocks.select).toHaveBeenCalledWith('grant-b'))
    expect(mocks.push).toHaveBeenCalledWith('/dashboard')
  })

  it('completes only the v5 transition after Clarin verifies the exact offline identity', async () => {
    const userId = '11111111-1111-4111-8111-111111111111'
    const accountId = '22222222-2222-4222-8222-222222222222'
    mocks.expectation = { version: 3, user_id: userId, account_id: accountId, issued_at: Date.now() }
    window.history.replaceState({}, '', '/login?offline_reauth=1')
    vi.mocked(fetch).mockImplementation(async input => {
      if (String(input).includes('/api/auth/login')) return new Response(JSON.stringify({ success: true, user: { id: userId, account_id: accountId } }), { status: 200, headers: { 'Content-Type': 'application/json', 'X-Clarin-Response': '1' } })
      return new Response(JSON.stringify({ success: true, login_enabled: true, login_turnstile_required: false }), { status: 200, headers: { 'Content-Type': 'application/json', 'X-Clarin-Response': '1' } })
    })

    render(<LoginScreen />)
    expect(await screen.findByText(/exactamente el mismo usuario/i)).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('usuario o correo'), { target: { value: 'ricardo' } })
    fireEvent.change(screen.getByPlaceholderText('tu contraseña'), { target: { value: 'contraseña actual segura' } })
    fireEvent.click(screen.getByRole('button', { name: /Iniciar sesión/i }))

    await vi.waitFor(() => expect(mocks.completeOnline).toHaveBeenCalledOnce())
    expect(mocks.beginOnline).toHaveBeenCalledOnce()
    expect(mocks.invalidate).not.toHaveBeenCalled()
    expect(mocks.lock).not.toHaveBeenCalled()
    expect(mocks.push).toHaveBeenCalledWith('/dashboard')
  })

  it('cancels the v5 latch after rejected authentication without locking or losing the offline session', async () => {
    mocks.expectation = {
      version: 3,
      user_id: '11111111-1111-4111-8111-111111111111',
      account_id: '22222222-2222-4222-8222-222222222222',
      issued_at: Date.now(),
    }
    window.history.replaceState({}, '', '/login?offline_reauth=1')
    vi.mocked(fetch).mockImplementation(async input => {
      if (String(input).includes('/api/auth/login')) return new Response(JSON.stringify({ success: false, error: 'Credenciales incorrectas' }), { status: 401, headers: { 'Content-Type': 'application/json', 'X-Clarin-Response': '1' } })
      return new Response(JSON.stringify({ success: true, login_enabled: true, login_turnstile_required: false }), { status: 200, headers: { 'Content-Type': 'application/json', 'X-Clarin-Response': '1' } })
    })

    render(<LoginScreen />)
    await screen.findByText(/exactamente el mismo usuario/i)
    fireEvent.change(screen.getByPlaceholderText('usuario o correo'), { target: { value: 'ricardo' } })
    fireEvent.change(screen.getByPlaceholderText('tu contraseña'), { target: { value: 'incorrecta' } })
    fireEvent.click(screen.getByRole('button', { name: /Iniciar sesión/i }))

    await vi.waitFor(() => expect(mocks.cancelOnline).toHaveBeenCalledOnce())
    expect(mocks.completeOnline).not.toHaveBeenCalled()
    expect(mocks.lock).not.toHaveBeenCalled()
    expect(await screen.findByText('Credenciales incorrectas')).toBeInTheDocument()
  })

  it('cancels an explicit transition and returns to the still-active canonical offline session', async () => {
    mocks.runtimeActive = true
    mocks.expectation = {
      version: 3,
      user_id: '11111111-1111-4111-8111-111111111111',
      account_id: '22222222-2222-4222-8222-222222222222',
      issued_at: Date.now(),
    }
    window.history.replaceState({}, '', '/login?offline_reauth=1')
    render(<LoginScreen />)
    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar y volver offline' }))
    await vi.waitFor(() => expect(mocks.cancelOnline).toHaveBeenCalledOnce())
    expect(mocks.replace).toHaveBeenCalledWith('/dashboard')
    expect(mocks.lock).not.toHaveBeenCalled()
  })

  it('lets a locked user explicitly choose a fresh online login without an installer or v4 shell', async () => {
    vi.mocked(fetch).mockImplementation(async input => {
      if (String(input).includes('/api/auth/login')) throw new TypeError('network unavailable')
      return new Response(JSON.stringify({ success: true, login_enabled: true, login_turnstile_required: false }), { status: 200, headers: { 'Content-Type': 'application/json', 'X-Clarin-Response': '1' } })
    })
    render(<LoginScreen />)
    fireEvent.change(screen.getByPlaceholderText('usuario o correo'), { target: { value: 'ricardo' } })
    fireEvent.change(screen.getByPlaceholderText('tu contraseña'), { target: { value: 'contraseña actual segura' } })
    fireEvent.click(screen.getByRole('button', { name: /^Iniciar sesión$/i }))
    fireEvent.click(await screen.findByRole('button', { name: 'Iniciar sesión online' }))
    await vi.waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/login?offline_fresh_login=1'))
    expect(mocks.beginOnline).toHaveBeenCalledOnce()
    expect(mocks.lock).not.toHaveBeenCalled()
  })

  it('arms a fresh v5 transition before an ordinary login when local logout left the shell offline', async () => {
    mocks.runtimeMode = 'locked'
    mocks.workerMode = 'offline'
    vi.mocked(fetch).mockImplementation(async input => {
      if (String(input).includes('/api/auth/login')) return new Response(JSON.stringify({ success: true, user: { id: 'new-user', account_id: 'new-account' } }), { status: 200, headers: { 'Content-Type': 'application/json', 'X-Clarin-Response': '1' } })
      return new Response(JSON.stringify({ success: true, login_enabled: true, login_turnstile_required: false }), { status: 200, headers: { 'Content-Type': 'application/json', 'X-Clarin-Response': '1' } })
    })

    render(<LoginScreen />)
    fireEvent.change(screen.getByPlaceholderText('usuario o correo'), { target: { value: 'otro.usuario' } })
    fireEvent.change(screen.getByPlaceholderText('tu contraseña'), { target: { value: 'contraseña actual segura' } })
    fireEvent.click(screen.getByRole('button', { name: /Iniciar sesión/i }))

    await vi.waitFor(() => expect(mocks.completeOnline).toHaveBeenCalledOnce())
    expect(mocks.beginOnline.mock.invocationCallOrder[0]).toBeLessThan(mocks.invalidate.mock.invocationCallOrder[0])
    expect(mocks.replace).toHaveBeenCalledWith('/login?offline_fresh_login=1')
    expect(mocks.lock).not.toHaveBeenCalled()
    expect(mocks.push).toHaveBeenCalledWith('/dashboard')
  })

  it('upgrades an ordinary login to exact reauthentication while a local identity is active', async () => {
    const userId = '11111111-1111-4111-8111-111111111111'
    const accountId = '22222222-2222-4222-8222-222222222222'
    mocks.runtimeActive = true
    vi.mocked(fetch).mockImplementation(async input => {
      if (String(input).includes('/api/auth/login')) return new Response(JSON.stringify({ success: true, user: { id: userId, account_id: accountId } }), { status: 200, headers: { 'Content-Type': 'application/json', 'X-Clarin-Response': '1' } })
      return new Response(JSON.stringify({ success: true, login_enabled: true, login_turnstile_required: false }), { status: 200, headers: { 'Content-Type': 'application/json', 'X-Clarin-Response': '1' } })
    })

    render(<LoginScreen />)
    fireEvent.change(screen.getByPlaceholderText('usuario o correo'), { target: { value: 'ricardo' } })
    fireEvent.change(screen.getByPlaceholderText('tu contraseña'), { target: { value: 'contraseña actual segura' } })
    fireEvent.click(screen.getByRole('button', { name: /Iniciar sesión/i }))

    await vi.waitFor(() => expect(mocks.completeOnline).toHaveBeenCalledOnce())
    expect(mocks.storeExpectation).toHaveBeenCalledWith({ user_id: userId, account_id: accountId })
    expect(mocks.invalidate).not.toHaveBeenCalled()
    expect(mocks.replace).toHaveBeenCalledWith('/login?offline_reauth=1')
  })
})
