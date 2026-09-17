import type { RuntimeSnapshot } from '@/lib/offlineV5Runtime'

export interface OfflineRuntimeIndicatorState {
  label: string
  detail: string
  tone: 'emerald' | 'amber' | 'rose' | 'slate'
  canSync: boolean
}

export function runtimeUsesLocalData(snapshot: RuntimeSnapshot) {
  return snapshot.active && snapshot.mode !== 'online'
}

export function runtimeNeedsOfflineUnlock(snapshot: RuntimeSnapshot) {
  return !snapshot.active && snapshot.mode === 'locked' && snapshot.canEnterOffline
}

const offlineDashboardModuleRoots: Readonly<Record<string, string>> = {
  tasks: '/dashboard/tasks',
  contacts: '/dashboard/contacts',
  programs: '/dashboard/programs',
  whiteboards: '/dashboard/whiteboards',
}

export function offlineV5DashboardPathAllowed(pathname: string, authorizedModules: readonly string[]) {
  if (pathname === '/dashboard' || pathname === '/dashboard/') return true
  return authorizedModules.some(module => {
    const root = offlineDashboardModuleRoots[module]
    return Boolean(root && (pathname === root || pathname.startsWith(`${root}/`)))
  })
}

export function runtimeCapabilityAllowed(snapshot: RuntimeSnapshot, action: string) {
  if (!runtimeUsesLocalData(snapshot)) return true
  if (!action.trim()) return false
  const capabilities = new Set(snapshot.capabilities)
  if (capabilities.has(action) || capabilities.has('*')) return true
  const separator = action.indexOf('.')
  return separator > 0 && capabilities.has(`${action.slice(0, separator)}.*`)
}

export function offlineRuntimeIndicatorState(snapshot: RuntimeSnapshot): OfflineRuntimeIndicatorState | null {
  // Before the user explicitly unlocks a copy, the login/dashboard offer owns
  // the outage decision. Do not turn that offer into a second global banner.
  if (!snapshot.active) return null

  const pending = snapshot.pendingCount > 0
    ? `${snapshot.pendingCount} cambio${snapshot.pendingCount === 1 ? '' : 's'} pendiente${snapshot.pendingCount === 1 ? '' : 's'}`
    : 'Cambios guardados en este navegador'

  if (snapshot.mode === 'syncing') {
    return { label: 'Sincronizando', detail: pending, tone: 'emerald', canSync: false }
  }
  if (snapshot.mode === 'conflict' || snapshot.conflictCount > 0) {
    const conflicts = `${snapshot.conflictCount} cambio${snapshot.conflictCount === 1 ? '' : 's'} no se aplic${snapshot.conflictCount === 1 ? 'ó' : 'aron'}; se conservó la versión del servidor`
    return { label: 'Revisión necesaria', detail: conflicts, tone: 'amber', canSync: true }
  }
  if (snapshot.error) {
    return { label: 'No se pudo sincronizar', detail: snapshot.error, tone: 'rose', canSync: true }
  }
  if (snapshot.mode === 'offline') {
    return { label: 'Modo offline', detail: pending, tone: 'amber', canSync: true }
  }
  if (snapshot.mode === 'locked') {
    return { label: 'Copia bloqueada', detail: 'Desbloquéala para continuar trabajando', tone: 'slate', canSync: false }
  }
  if (snapshot.mode === 'unavailable') {
    return { label: 'Copia no disponible', detail: snapshot.error || 'Se necesita conexión para continuar', tone: 'rose', canSync: false }
  }
  if (snapshot.active && (snapshot.pendingCount > 0 || snapshot.conflictCount > 0)) {
    return { label: 'Conectado', detail: pending, tone: 'emerald', canSync: true }
  }
  return null
}

export function onlineOnlyActionReason(snapshot: RuntimeSnapshot, label: string) {
  if (!runtimeUsesLocalData(snapshot)) return ''
  return `${label} necesita conexión. Tus cambios offline actuales permanecen guardados en este navegador.`
}
