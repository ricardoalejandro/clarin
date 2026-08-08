export type MobileAppModuleKey = 'chats' | 'contacts' | 'programs' | 'surveys' | 'tasks'

export interface MobileAppModule {
  key: MobileAppModuleKey
  label: string
  href: string
  permission: string
}

export interface MobileAppPermissionSubject {
  is_admin?: boolean
  is_super_admin?: boolean
  permissions?: string[]
}

export const MOBILE_APP_MODULES: readonly MobileAppModule[] = [
  { key: 'chats', label: 'Chats', href: '/dashboard/chats', permission: 'chats' },
  { key: 'contacts', label: 'Contactos', href: '/dashboard/contacts', permission: 'contacts' },
  { key: 'programs', label: 'Programas', href: '/dashboard/programs', permission: 'programs' },
  { key: 'surveys', label: 'Encuestas', href: '/dashboard/surveys', permission: 'surveys' },
  { key: 'tasks', label: 'Tareas', href: '/dashboard/tasks', permission: 'tasks' },
] as const

export function pathnameMatchesPrefix(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

export function mobileAppModuleForPath(pathname: string) {
  return MOBILE_APP_MODULES.find(module => pathnameMatchesPrefix(pathname, module.href)) || null
}

export function canUseMobileAppModule(subject: MobileAppPermissionSubject, module: MobileAppModule) {
  if (subject.is_admin || subject.is_super_admin) return true
  const permissions = subject.permissions || []
  return permissions.includes('*') || permissions.includes(module.permission)
}

export function availableMobileAppModules(subject: MobileAppPermissionSubject) {
  return MOBILE_APP_MODULES.filter(module => canUseMobileAppModule(subject, module))
}

export function firstMobileAppHref(subject: MobileAppPermissionSubject) {
  return availableMobileAppModules(subject)[0]?.href || ''
}

export function isAllowedMobileAppPath(
  pathname: string,
  subject: MobileAppPermissionSubject,
  options: { allowSubscriptionRecovery?: boolean } = {},
) {
  if (options.allowSubscriptionRecovery && pathnameMatchesPrefix(pathname, '/dashboard/settings')) return true
  const module = mobileAppModuleForPath(pathname)
  return Boolean(module && canUseMobileAppModule(subject, module))
}

export function isStandaloneApp(input: {
  displayModeStandalone: boolean
  navigatorStandalone?: boolean
}) {
  return input.displayModeStandalone || input.navigatorStandalone === true
}

export function isIOSDevice(input: {
  userAgent: string
  platform?: string
  maxTouchPoints?: number
}) {
  if (/iPad|iPhone|iPod/i.test(input.userAgent)) return true
  return input.platform === 'MacIntel' && (input.maxTouchPoints || 0) > 1
}

export function isMobileAppDevice(input: {
  userAgent: string
  platform?: string
  maxTouchPoints?: number
  userAgentMobile?: boolean
}) {
  if (input.userAgentMobile === true) return true
  if (/Android|Mobile|iPad|iPhone|iPod/i.test(input.userAgent)) return true
  return isIOSDevice(input)
}

export function isInstallPromptDismissed(rawValue: string | null, now = Date.now()) {
  if (!rawValue) return false
  const until = Number(rawValue)
  return Number.isFinite(until) && until > now
}

export function shouldDeliverChatNotification(provider: string | undefined, mobileAppMode: boolean) {
  return !mobileAppMode || provider !== 'whatsapp_cloud_api'
}

export type PwaRequestStrategy = 'ignore' | 'navigation-network' | 'static-cache'

export function pwaRequestStrategy(input: {
  method: string
  sameOrigin: boolean
  mode: string
  pathname: string
}): PwaRequestStrategy {
  if (input.method !== 'GET' || !input.sameOrigin) return 'ignore'
  if (input.mode === 'navigate') return 'navigation-network'
  if (input.pathname.startsWith('/_next/static/') || input.pathname.startsWith('/icons/')) return 'static-cache'
  return 'ignore'
}
