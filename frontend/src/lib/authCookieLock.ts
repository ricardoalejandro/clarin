import { getAuthScope } from '@/lib/authScope'

export const AUTH_COOKIE_LOCK_NAME = 'clarin:auth-cookie'

export class AuthCookieLockUnavailableError extends Error {
  readonly code = 'auth_cookie_lock_unavailable'

  constructor() {
    super('Este navegador no permite coordinar la sesión entre pestañas. Actualiza el navegador y vuelve a intentarlo.')
    this.name = 'AuthCookieLockUnavailableError'
  }
}

/** Serialize every response that may replace shared authentication cookies. */
export async function fetchAuthCookie(
  url: string,
  init: RequestInit,
  expectedScope: string,
): Promise<Response> {
  const validateLease = () => {
    if (init.signal?.aborted || getAuthScope() !== expectedScope) {
      throw new DOMException('La sesión cambió o la solicitud fue cancelada.', 'AbortError')
    }
  }
  validateLease()

  let manager: LockManager | undefined
  try { manager = typeof navigator === 'undefined' ? undefined : navigator.locks }
  catch { throw new AuthCookieLockUnavailableError() }
  if (!manager || typeof manager.request !== 'function') throw new AuthCookieLockUnavailableError()

  try {
    return await manager.request(AUTH_COOKIE_LOCK_NAME, {
      mode: 'exclusive',
      ...(init.signal ? { signal: init.signal } : {}),
    }, async () => {
      // The identity may have changed while a different tab held the lock.
      validateLease()
      return fetch(url, init)
    })
  } catch (error) {
    if (error instanceof DOMException && ['SecurityError', 'InvalidStateError', 'NotSupportedError'].includes(error.name)) {
      throw new AuthCookieLockUnavailableError()
    }
    throw error
  }
}
