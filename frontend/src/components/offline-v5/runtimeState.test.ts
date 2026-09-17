import { describe, expect, it } from 'vitest'
import type { RuntimeSnapshot } from '@/lib/offlineV5Runtime'
import {
  offlineRuntimeIndicatorState,
  offlineV5DashboardPathAllowed,
  onlineOnlyActionReason,
  runtimeCapabilityAllowed,
  runtimeNeedsOfflineUnlock,
  runtimeUsesLocalData,
} from './runtimeState'

const snapshot = (overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot => ({
  mode: 'online',
  active: false,
  canEnterOffline: false,
  authorizedModules: [],
  selectedRoots: {},
  capabilities: [],
  pendingCount: 0,
  conflictCount: 0,
  ...overrides,
})

describe('canonical Clarin offline runtime UI state', () => {
  it('does not alter ordinary online capability checks or render an indicator at rest', () => {
    const online = snapshot()
    expect(runtimeUsesLocalData(online)).toBe(false)
    expect(runtimeCapabilityAllowed(online, 'anything')).toBe(true)
    expect(offlineRuntimeIndicatorState(online)).toBeNull()
    expect(offlineRuntimeIndicatorState(snapshot({ mode: 'unavailable', canEnterOffline: true }))).toBeNull()
  })

  it('returns to the canonical login when an offline shell is reopened locked', () => {
    expect(runtimeNeedsOfflineUnlock(snapshot({ mode: 'locked', active: false, canEnterOffline: true }))).toBe(true)
    expect(runtimeNeedsOfflineUnlock(snapshot({ mode: 'offline', active: true, canEnterOffline: true }))).toBe(false)
    expect(runtimeNeedsOfflineUnlock(snapshot())).toBe(false)
  })

  it('exposes only dashboard and explicitly authorized canonical module routes offline', () => {
    const modules = ['tasks', 'whiteboards']
    expect(offlineV5DashboardPathAllowed('/dashboard', modules)).toBe(true)
    expect(offlineV5DashboardPathAllowed('/dashboard/tasks', modules)).toBe(true)
    expect(offlineV5DashboardPathAllowed('/dashboard/whiteboards/board-a', modules)).toBe(true)
    expect(offlineV5DashboardPathAllowed('/dashboard/contacts', modules)).toBe(false)
    expect(offlineV5DashboardPathAllowed('/dashboard/storage', modules)).toBe(false)
    expect(offlineV5DashboardPathAllowed('/dashboard/admin', ['tasks', 'contacts', 'programs', 'whiteboards'])).toBe(false)
  })

  it('fails closed for unavailable offline capabilities and accepts exact or module wildcard capabilities', () => {
    const offline = snapshot({ mode: 'offline', active: true, capabilities: ['tasks.update', 'contacts.*'] })
    expect(runtimeCapabilityAllowed(offline, 'tasks.update')).toBe(true)
    expect(runtimeCapabilityAllowed(offline, 'contacts.update')).toBe(true)
    expect(runtimeCapabilityAllowed(offline, 'programs.update')).toBe(false)
    expect(runtimeCapabilityAllowed(offline, '')).toBe(false)
  })

  it('keeps the indicator compact and explicit for pending work and conflicts', () => {
    expect(offlineRuntimeIndicatorState(snapshot({ mode: 'offline', active: true, pendingCount: 2 }))).toMatchObject({
      label: 'Modo offline',
      detail: '2 cambios pendientes',
      tone: 'amber',
    })
    expect(offlineRuntimeIndicatorState(snapshot({ mode: 'conflict', active: true, conflictCount: 1 }))).toMatchObject({
      label: 'Revisión necesaria',
      detail: '1 cambio no se aplicó; se conservó la versión del servidor',
    })
    expect(offlineRuntimeIndicatorState(snapshot({ mode: 'offline', active: true, error: 'Servidor temporalmente no disponible.' }))).toMatchObject({
      label: 'No se pudo sincronizar',
      detail: 'Servidor temporalmente no disponible.',
      tone: 'rose',
    })
  })

  it('explains an online-only action without implying that local work was lost', () => {
    const reason = onlineOnlyActionReason(snapshot({ mode: 'offline', active: true }), 'Cambiar permisos')
    expect(reason).toContain('necesita conexión')
    expect(reason).toContain('permanecen guardados')
  })
})
