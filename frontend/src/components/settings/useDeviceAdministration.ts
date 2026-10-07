'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { subscribeWebSocket } from '@/lib/api'
import { getAuthScope, isAuthIdentityChanging, subscribeAuthScope } from '@/lib/authScope'
import type { Device, DeviceDeletionResult } from '@/types/chat'
import { applyDeviceDeletionResult, isDeviceDeleting } from './deviceLifecycle'

export function useDeviceAdministration<T extends Device>(enabled: boolean) {
  const scope = useSyncExternalStore(subscribeAuthScope, getAuthScope, () => 'server')
  const ready = enabled && !isAuthIdentityChanging(scope)
  const [devices, setDevices] = useState<T[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [mutationError, setMutationError] = useState('')
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set())
  const stateScope = useRef(scope)
  const generation = useRef(0)
  const fetchSequence = useRef(0)
  const fetchController = useRef<AbortController | null>(null)
  const deleteControllers = useRef(new Map<string, AbortController>())

  const refreshDevices = useCallback(async () => {
    if (!ready || scope !== getAuthScope()) return
    fetchController.current?.abort()
    const controller = new AbortController()
    fetchController.current = controller
    const sequence = ++fetchSequence.current
    const session = generation.current
    const current = () => !controller.signal.aborted && sequence === fetchSequence.current && session === generation.current && scope === getAuthScope()
    try {
      const response = await fetch('/api/devices', { headers: { Authorization: `Bearer ${localStorage.getItem('token') || ''}` }, signal: controller.signal })
      const data = await response.json().catch(() => ({}))
      if (!current()) return
      if (!response.ok || !data.success) throw new Error(data.error || 'No se pudieron cargar los dispositivos')
      setDevices(Array.isArray(data.devices) ? data.devices : [])
      setError('')
    } catch (reason) {
      if (current()) setError(reason instanceof Error ? reason.message : 'No se pudieron cargar los dispositivos')
    } finally {
      if (current()) setLoading(false)
    }
  }, [ready, scope])

  useEffect(() => {
    stateScope.current = scope
    generation.current += 1
    setDevices([])
    setPendingIds(new Set())
    setError('')
    setMutationError('')
    setLoading(ready)
    if (ready) void refreshDevices()
    return () => {
      generation.current += 1
      fetchController.current?.abort()
      deleteControllers.current.forEach(controller => controller.abort())
      deleteControllers.current.clear()
    }
  }, [scope, ready, refreshDevices])

  useEffect(() => {
    if (!ready) return
    const interval = window.setInterval(() => { void refreshDevices() }, 5000)
    const unsubscribe = subscribeWebSocket(value => {
      if (scope !== getAuthScope() || isAuthIdentityChanging()) return
      const event = value as { event?: string; data?: DeviceDeletionResult }
      if (event.event === 'device_deletion' && event.data?.device_id && event.data.operation_id && ['pending', 'completed'].includes(event.data.deletion_status)) {
        const result = event.data
        setDevices(previous => applyDeviceDeletionResult(previous, result))
        // GET also confirms unknown operations and contains retry/phase checkpoints.
        fetchController.current?.abort()
        void refreshDevices()
      } else if (event.event === 'device_status' || event.event === 'qr_code') void refreshDevices()
    })
    return () => { window.clearInterval(interval); unsubscribe() }
  }, [ready, scope, refreshDevices])

  const deleteDevice = async (id: string) => {
    if (!ready || scope !== getAuthScope() || deleteControllers.current.has(id)) return false
    const controller = new AbortController()
    const session = generation.current
    const current = () => !controller.signal.aborted && session === generation.current && scope === getAuthScope()
    deleteControllers.current.set(id, controller)
    // An already-started GET must not resurrect a row after a committed delete.
    fetchController.current?.abort()
    fetchSequence.current += 1
    setPendingIds(new Set(deleteControllers.current.keys()))
    setMutationError('')
    try {
      const response = await fetch(`/api/devices/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${localStorage.getItem('token') || ''}` }, signal: controller.signal })
      const data = await response.json().catch(() => ({}))
      if (!current()) return false
      if (!response.ok || !data.success) throw new Error(data.error || 'No se pudo eliminar el dispositivo')
      const result = data as DeviceDeletionResult
      if (result.device_id !== id || !result.operation_id || !['pending', 'completed'].includes(result.deletion_status)) throw new Error('No se pudo confirmar el estado de eliminación')
      setDevices(previous => applyDeviceDeletionResult(previous, result, true))
      void refreshDevices()
      return true
    } catch (reason) {
      if (current()) setMutationError(reason instanceof Error ? reason.message : 'No se pudo eliminar el dispositivo')
      return false
    } finally {
      if (deleteControllers.current.get(id) === controller) deleteControllers.current.delete(id)
      if (current()) setPendingIds(new Set(deleteControllers.current.keys()))
    }
  }
  const visible = ready && stateScope.current === scope
  return {
    scope,
    devices: visible ? devices : [], setDevices, loading: visible && loading, setLoading, error: visible ? mutationError || error : '',
    pendingIds: visible ? pendingIds : new Set<string>(), refreshDevices, deleteDevice,
    total: visible ? devices.length : 0, available: visible ? devices.filter(device => !isDeviceDeleting(device)).length : 0,
  }
}
