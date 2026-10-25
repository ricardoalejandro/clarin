'use client'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getAuthScope, isAuthIdentityChanging, subscribeAuthScope } from '@/lib/authScope'
import { subscribeWebSocket } from '@/lib/api'
import { groupIdentityRecoveryPollDelay, parseGroupIdentityRecovery, type GroupIdentityRecoverySnapshot } from './groupIdentityRecovery'

export function useGroupIdentityRecovery(deviceIds: readonly string[], accountId?: string) {
  const scope = useSyncExternalStore(subscribeAuthScope, getAuthScope, () => 'server')
  const devicesKey = JSON.stringify([...new Set(deviceIds.filter(Boolean))].sort())
  const key = `${scope}:${accountId || ''}:${devicesKey}`
  const currentKey = useRef(key); currentKey.current = key
  const [revision, setRevision] = useState(0)
  const [snapshot, setSnapshot] = useState<{ key: string; rows: GroupIdentityRecoverySnapshot[] }>({ key, rows: [] })
  const refresh = useCallback(() => setRevision(value => value + 1), [])
  useEffect(() => {
    if (isAuthIdentityChanging(scope)) return
    const ids = JSON.parse(devicesKey) as string[]
    if (!ids.length) return
    const controller = new AbortController()
    let poll: ReturnType<typeof setTimeout> | undefined
    let busy = false
    let request: AbortController | null = null
    const current = () => !controller.signal.aborted && currentKey.current === key && getAuthScope() === scope && !isAuthIdentityChanging(scope)
    const run = async () => {
      if (!current() || busy || document.visibilityState === 'hidden') return
      busy = true
      if (poll) clearTimeout(poll)
      const requestController = new AbortController(); request = requestController
      const timeout = setTimeout(() => requestController.abort(), 20000)
      const rows: GroupIdentityRecoverySnapshot[] = []
      try {
        for (let index = 0; index < ids.length && current(); index += 4) {
          const results = await Promise.all(ids.slice(index, index + 4).map(async deviceId => {
            try {
              const response = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/group-identities/recovery`, { credentials: 'include', cache: 'no-store', signal: requestController.signal })
              if (!response.ok) throw new Error('recovery_unavailable')
              return parseGroupIdentityRecovery(await response.json(), deviceId)
            } catch { return { deviceId, recovery: null, identityRevision: 0, error: 'recovery_unavailable' } satisfies GroupIdentityRecoverySnapshot }
          }))
          rows.push(...results)
        }
        if (!current()) return
        setSnapshot({ key, rows })
        const delay = groupIdentityRecoveryPollDelay(rows)
        if (delay !== null) poll = setTimeout(() => { void run() }, delay)
      } finally { clearTimeout(timeout); busy = false }
    }
    const focus = () => { if (document.visibilityState !== 'hidden') void run(); else if (poll) clearTimeout(poll) }
    void run()
    window.addEventListener('focus', focus)
    document.addEventListener('visibilitychange', focus)
    return () => { controller.abort(); request?.abort(); if (poll) clearTimeout(poll); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus) }
  }, [key, devicesKey, scope, revision])
  useEffect(() => subscribeWebSocket((raw: unknown) => {
    const event = raw as { event?: string; type?: string; account_id?: string; data?: { account_id?: string; device_id?: string } }
    if (getAuthScope() !== scope || isAuthIdentityChanging(scope) || accountId && [event.account_id, event.data?.account_id].some(id => id && id !== accountId)) return
    if (['whatsapp_identity_updated', 'device_status', 'device_deletion', 'groups_synced'].includes(event.event || event.type || '') && event.data?.device_id && (JSON.parse(devicesKey) as string[]).includes(event.data.device_id)) refresh()
  }), [scope, accountId, devicesKey, refresh])
  return { rows: snapshot.key === key && !isAuthIdentityChanging(scope) ? snapshot.rows : [], refresh }
}
