import { describe, expect, it } from 'vitest'
import { getLoginNoticeForLogoutReason, getLoginRedirectForLogout } from './api'

describe('logout navigation', () => {
  it('explains inactivity and expiry on the login route', () => {
    expect(getLoginRedirectForLogout('idle')).toBe('/login?reason=idle')
    expect(getLoginRedirectForLogout('expired')).toBe('/login?reason=expired')
    expect(getLoginRedirectForLogout('manual')).toBe('/login')
  })

  it('renders an explicit notice only for automatic session expiry', () => {
    expect(getLoginNoticeForLogoutReason('idle')).toContain('30 minutos sin actividad')
    expect(getLoginNoticeForLogoutReason('expired')).toBe('Tu sesión expiró. Inicia sesión nuevamente para continuar.')
    expect(getLoginNoticeForLogoutReason('manual')).toBe('')
    expect(getLoginNoticeForLogoutReason('unexpected')).toBe('')
    expect(getLoginNoticeForLogoutReason(null)).toBe('')
  })
})
