'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useInsertionEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { setSharedWebSocketOfflineSuppressed } from '@/lib/api'
import {
  acknowledgeOfflineV5ServerWinsConflicts,
  beginOfflineV5OnlineTransition,
  explainOfflineV5Capability,
  getOfflineV5RuntimeSnapshot,
  installOfflineV5FetchInterceptor,
  requestOfflineV5Sync,
  subscribeOfflineV5Runtime,
  type RuntimeSnapshot,
} from '@/lib/offlineV5Runtime'
import { browserOfflineV5Client } from '@/offline-v5/client'
import { clearOfflineReauthExpectation, storeOfflineReauthExpectation } from '@/offline-v3/offlineReauth'
import { onlineOnlyActionReason, runtimeUsesLocalData } from './runtimeState'

interface ClarinRuntimeValue {
  snapshot: RuntimeSnapshot
  isOffline: boolean
  can: (action: string, resource?: string) => boolean
  explain: (action: string, resource?: string) => string
  requireOnline: (label: string) => boolean
  sync: () => Promise<void>
  acknowledgeConflicts: () => Promise<void>
  beginOnlineReauthentication: () => Promise<boolean>
  activity: () => void
  notice: string
  clearNotice: () => void
}

const fallbackSnapshot: RuntimeSnapshot = {
  mode: 'online',
  active: false,
  canEnterOffline: false,
  authorizedModules: [],
  selectedRoots: {},
  capabilities: [],
  pendingCount: 0,
  conflictCount: 0,
}

const ClarinRuntimeContext = createContext<ClarinRuntimeValue | null>(null)

const fallbackValue: ClarinRuntimeValue = {
  snapshot: fallbackSnapshot,
  isOffline: false,
  can: () => true,
  explain: () => '',
  requireOnline: () => true,
  sync: async () => {},
  acknowledgeConflicts: async () => {},
  beginOnlineReauthentication: async () => false,
  activity: () => {},
  notice: '',
  clearNotice: () => {},
}

let fetchInterceptorInstalled = false
function ensureOfflineFetchInterceptor() {
  if (fetchInterceptorInstalled || typeof window === 'undefined') return
  installOfflineV5FetchInterceptor()
  fetchInterceptorInstalled = true
}

export function ClarinRuntimeProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot>(() => {
    if (typeof window === 'undefined') return fallbackSnapshot
    return getOfflineV5RuntimeSnapshot()
  })
  const [notice, setNotice] = useState('')
  const offlineTransportSuppressed = runtimeUsesLocalData(snapshot)

  useInsertionEffect(() => {
    ensureOfflineFetchInterceptor()
    setSharedWebSocketOfflineSuppressed(offlineTransportSuppressed)
    return () => {
      if (offlineTransportSuppressed) setSharedWebSocketOfflineSuppressed(false)
    }
  }, [offlineTransportSuppressed])

  useEffect(() => {
    setSnapshot(getOfflineV5RuntimeSnapshot())
    return subscribeOfflineV5Runtime(next => {
      setSnapshot(next)
      if (next.mode === 'online' && next.pendingCount === 0 && next.conflictCount === 0) setNotice('')
    })
  }, [])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 7_000)
    return () => window.clearTimeout(timer)
  }, [notice])

  const can = useCallback((action: string, resource?: string) => {
    if (!runtimeUsesLocalData(snapshot)) return true
    return explainOfflineV5Capability(action, resource).allowed
  }, [snapshot])

  const explain = useCallback((action: string, resource?: string) => {
    if (!runtimeUsesLocalData(snapshot)) return ''
    const result = explainOfflineV5Capability(action, resource)
    return result.allowed ? '' : result.reason || 'Esta acción no forma parte de la copia offline autorizada.'
  }, [snapshot])

  const requireOnline = useCallback((label: string) => {
    const reason = onlineOnlyActionReason(snapshot, label)
    if (!reason) return true
    setNotice(reason)
    return false
  }, [snapshot])

  const sync = useCallback(async () => {
    setNotice('')
    try {
      await requestOfflineV5Sync()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'No se pudo iniciar la sincronización.')
    }
  }, [])

  const acknowledgeConflicts = useCallback(async () => {
    setNotice('')
    try {
      await acknowledgeOfflineV5ServerWinsConflicts()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'No se pudo cerrar el aviso de conflicto.')
    }
  }, [])

  const beginOnlineReauthentication = useCallback(async () => {
    if (!runtimeUsesLocalData(snapshot) || !snapshot.userId || !snapshot.accountId) {
      setNotice('No hay una identidad offline activa que pueda volver al modo online.')
      return false
    }
    try {
      storeOfflineReauthExpectation(window.sessionStorage, {
        user_id: snapshot.userId,
        account_id: snapshot.accountId,
      })
      await beginOfflineV5OnlineTransition()
      return true
    } catch (error) {
      clearOfflineReauthExpectation(window.sessionStorage)
      setNotice(error instanceof Error ? error.message : 'No se pudo preparar la transición online. La sesión offline continúa abierta.')
      return false
    }
  }, [snapshot])

  const activity = useCallback(() => {
    if (runtimeUsesLocalData(snapshot)) browserOfflineV5Client.activity()
  }, [snapshot])

  const value = useMemo<ClarinRuntimeValue>(() => ({
    snapshot,
    isOffline: runtimeUsesLocalData(snapshot),
    can,
    explain,
    requireOnline,
    sync,
    acknowledgeConflicts,
    beginOnlineReauthentication,
    activity,
    notice,
    clearNotice: () => setNotice(''),
  }), [acknowledgeConflicts, activity, beginOnlineReauthentication, can, explain, notice, requireOnline, snapshot, sync])

  return <ClarinRuntimeContext.Provider value={value}>{children}</ClarinRuntimeContext.Provider>
}

export function useClarinRuntime() {
  return useContext(ClarinRuntimeContext) || fallbackValue
}
