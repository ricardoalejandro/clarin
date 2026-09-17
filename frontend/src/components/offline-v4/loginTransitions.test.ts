import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const transition = vi.hoisted(() => ({ begin: vi.fn(), mode: vi.fn() }))
vi.mock('@/lib/offlineV4ServiceWorker', () => ({ beginOfflineV4OnlineReauth: transition.begin, setOfflineV4Mode: transition.mode }))
import { completeExplicitOnlineLogin, recoverTurnstileError } from './loginTransitions'
import { OFFLINE_V4_META_CACHE } from '@/lib/pwaCache'

beforeEach(() => {
  vi.clearAllMocks()
  transition.begin.mockResolvedValue(true)
  transition.mode.mockResolvedValue(true)
  vi.stubGlobal('navigator', { serviceWorker: { getRegistration: vi.fn().mockResolvedValue({ active: {} }), controller: {} } })
  vi.stubGlobal('caches', { keys: vi.fn().mockResolvedValue([OFFLINE_V4_META_CACHE]) })
})
afterEach(() => vi.unstubAllGlobals())

describe('explicit online login after another tab entered offline mode', () => {
  it('requires ordered begin and online acknowledgements even for a normal preexisting login page', async () => {
    expect(await completeExplicitOnlineLogin()).toBe(true)
    expect(transition.begin).toHaveBeenCalledOnce()
    expect(transition.mode).toHaveBeenCalledWith('online')
    expect(transition.begin.mock.invocationCallOrder[0]).toBeLessThan(transition.mode.mock.invocationCallOrder[0])
  })
  it('fails closed without attempting online mode when begin is rejected', async () => {
    transition.begin.mockResolvedValue(false)
    expect(await completeExplicitOnlineLogin()).toBe(false)
    expect(transition.mode).not.toHaveBeenCalled()
  })
  it('does not report success before the online mode acknowledgement', async () => {
    transition.mode.mockResolvedValue(false)
    expect(await completeExplicitOnlineLogin()).toBe(false)
  })
  it('turns worker failures into a rejected transition so the caller discards the new cookie', async () => {
    transition.mode.mockRejectedValue(new Error('Worker unavailable'))
    expect(await completeExplicitOnlineLogin()).toBe(false)
  })
  it('does not install or require a service worker for an ordinary online user', async () => {
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration: vi.fn().mockResolvedValue(undefined), controller: null } })
    expect(await completeExplicitOnlineLogin()).toBe(true)
    expect(transition.begin).not.toHaveBeenCalled()
    expect(await completeExplicitOnlineLogin(true)).toBe(false)
  })
  it('does not send unsupported v4 messages to an active legacy worker with no v4 routing state', async () => {
    vi.stubGlobal('caches', { keys: vi.fn().mockResolvedValue(['clarin-pwa-legacy', 'clarin-offline-v3-meta-v1']) })
    expect(await completeExplicitOnlineLogin()).toBe(true)
    expect(transition.begin).not.toHaveBeenCalled()
    expect(transition.mode).not.toHaveBeenCalled()
  })
  it('requires both acknowledgements for an explicit offline transition even when its public cache was removed', async () => {
    vi.stubGlobal('caches', { keys: vi.fn().mockResolvedValue([]) })
    expect(await completeExplicitOnlineLogin(true)).toBe(true)
    expect(transition.begin).toHaveBeenCalledOnce()
    expect(transition.mode).toHaveBeenCalledWith('online')
  })
  it('does not assume there is no offline state when the read-only routing lookup fails', async () => {
    vi.stubGlobal('caches', { keys: vi.fn().mockRejectedValue(new Error('Storage unavailable')) })
    expect(await completeExplicitOnlineLogin()).toBe(false)
    expect(transition.begin).not.toHaveBeenCalled()
  })
  it('allows ordinary login without service worker support but not a required offline transition', async () => {
    vi.stubGlobal('navigator', {})
    expect(await completeExplicitOnlineLogin()).toBe(true)
    expect(await completeExplicitOnlineLogin(true)).toBe(false)
  })
  it('clears only captcha errors when a new token arrives', () => {
    expect(recoverTurnstileError('Completa la verificación de seguridad para iniciar sesión.')).toBe('')
    for (const error of ['Credenciales incorrectas', 'La identidad fue validada, pero el navegador no pudo cerrar el modo offline de forma segura. Vuelve a intentarlo.', 'No se pudo bloquear la sesión offline anterior.']) expect(recoverTurnstileError(error)).toBe(error)
  })
})
