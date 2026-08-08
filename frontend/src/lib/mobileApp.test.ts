import { describe, expect, it } from 'vitest'
import {
  MOBILE_APP_MODULES,
  availableMobileAppModules,
  firstMobileAppHref,
  isAllowedMobileAppPath,
  isInstallPromptDismissed,
  isIOSDevice,
  isMobileAppDevice,
  isStandaloneApp,
  mobileAppModuleForPath,
  pathnameMatchesPrefix,
  pwaRequestStrategy,
  shouldDeliverChatNotification,
} from './mobileApp'

describe('Clarin mobile app policy', () => {
  it('exposes only the five requested modules in a stable order', () => {
    expect(MOBILE_APP_MODULES.map(module => module.key)).toEqual([
      'chats',
      'contacts',
      'programs',
      'surveys',
      'tasks',
    ])
  })

  it('matches complete route segments without accepting similar prefixes', () => {
    expect(pathnameMatchesPrefix('/dashboard/programs/123', '/dashboard/programs')).toBe(true)
    expect(pathnameMatchesPrefix('/dashboard/programs-old', '/dashboard/programs')).toBe(false)
    expect(mobileAppModuleForPath('/dashboard/surveys/launch')).toMatchObject({ key: 'surveys' })
    expect(mobileAppModuleForPath('/dashboard/chat-api')).toBeNull()
  })

  it('derives visible modules and the safe entry route from real permissions', () => {
    const subject = { permissions: ['contacts', 'tasks'] }
    expect(availableMobileAppModules(subject).map(module => module.key)).toEqual(['contacts', 'tasks'])
    expect(firstMobileAppHref(subject)).toBe('/dashboard/contacts')
    expect(isAllowedMobileAppPath('/dashboard/tasks/board', subject)).toBe(true)
    expect(isAllowedMobileAppPath('/dashboard/programs', subject)).toBe(false)
  })

  it('gives administrators all five modules and allows settings only for subscription recovery', () => {
    const admin = { is_admin: true }
    expect(availableMobileAppModules(admin)).toHaveLength(5)
    expect(isAllowedMobileAppPath('/dashboard/settings', admin)).toBe(false)
    expect(isAllowedMobileAppPath('/dashboard/settings/billing', admin, { allowSubscriptionRecovery: true })).toBe(true)
  })

  it('recognizes installed and iOS app contexts safely', () => {
    expect(isStandaloneApp({ displayModeStandalone: true })).toBe(true)
    expect(isStandaloneApp({ displayModeStandalone: false, navigatorStandalone: true })).toBe(true)
    expect(isStandaloneApp({ displayModeStandalone: false })).toBe(false)
    expect(isIOSDevice({ userAgent: 'Mozilla/5.0 (iPhone)' })).toBe(true)
    expect(isIOSDevice({ userAgent: 'Mozilla/5.0', platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true)
    expect(isIOSDevice({ userAgent: 'Mozilla/5.0 (Linux; Android 14)', platform: 'Linux armv8l' })).toBe(false)
    expect(isMobileAppDevice({ userAgent: 'Mozilla/5.0 (Linux; Android 14)' })).toBe(true)
    expect(isMobileAppDevice({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 0 })).toBe(false)
  })

  it('expires install prompt dismissals and suppresses only Cloud chats in the installed app', () => {
    expect(isInstallPromptDismissed('2000', 1000)).toBe(true)
    expect(isInstallPromptDismissed('1000', 1000)).toBe(false)
    expect(isInstallPromptDismissed('invalid', 1000)).toBe(false)
    expect(shouldDeliverChatNotification('whatsapp_cloud_api', true)).toBe(false)
    expect(shouldDeliverChatNotification('whatsapp_web', true)).toBe(true)
    expect(shouldDeliverChatNotification('whatsapp_cloud_api', false)).toBe(true)
  })

  it('keeps account data out of the service worker cache policy', () => {
    expect(pwaRequestStrategy({ method: 'GET', sameOrigin: true, mode: 'navigate', pathname: '/dashboard/chats' })).toBe('navigation-network')
    expect(pwaRequestStrategy({ method: 'GET', sameOrigin: true, mode: 'cors', pathname: '/api/chats' })).toBe('ignore')
    expect(pwaRequestStrategy({ method: 'POST', sameOrigin: true, mode: 'cors', pathname: '/api/tasks' })).toBe('ignore')
    expect(pwaRequestStrategy({ method: 'GET', sameOrigin: false, mode: 'cors', pathname: '/icons/clarin-192.png' })).toBe('ignore')
    expect(pwaRequestStrategy({ method: 'GET', sameOrigin: true, mode: 'cors', pathname: '/_next/static/chunks/app.js' })).toBe('static-cache')
    expect(pwaRequestStrategy({ method: 'GET', sameOrigin: true, mode: 'cors', pathname: '/icons/clarin-192.png' })).toBe('static-cache')
  })
})
