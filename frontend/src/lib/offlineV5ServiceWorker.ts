export type OfflineV5ServiceWorkerStatus = {
  enabled?: boolean
  mode?: 'online' | 'offline'
  online_transition?: boolean
  fallback_offer?: boolean
  active_generation?: string
  previous_generation?: string
}

type OfflineV5SWMessage =
  | 'CLARIN_OFFLINE_V5_SET_ENABLED'
  | 'CLARIN_OFFLINE_V5_SET_MODE'
  | 'CLARIN_OFFLINE_V5_BEGIN_ONLINE_REAUTH'
  | 'CLARIN_OFFLINE_V5_CLEAR_LOCAL_AUTHORITY'
  | 'CLARIN_OFFLINE_V5_CLEAR_FALLBACK_OFFER'
  | 'CLARIN_OFFLINE_V5_GET_STATUS'
  | 'CLARIN_OFFLINE_V5_USE_PREVIOUS'

export type OfflineV5ServiceWorkerDelivery = 'controlling' | 'waiting'
type OfflineV5ServiceWorkerReply<T = unknown> = { ok: boolean; error?: string; meta?: T; delivery: OfflineV5ServiceWorkerDelivery }

const OFFLINE_CACHE_PREFIXES = [
  'clarin-pwa-',
  'clarin-offline-v3-shell-',
  'clarin-offline-v4-shell-',
  'clarin-offline-v5-shell-',
]
const OFFLINE_META_CACHES = new Set([
  'clarin-offline-v3-meta-v1',
  'clarin-offline-v4-meta-v1',
  'clarin-offline-v5-meta-v1',
])

export async function hasOfflineV5ServiceWorkerRegistration(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return false
  return Boolean(await navigator.serviceWorker.getRegistration('/').catch(() => undefined))
}

async function waitForOfflineWorker(registration: ServiceWorkerRegistration): Promise<ServiceWorkerRegistration> {
  if (registration.active || registration.waiting) return registration
  const worker = registration.installing
  if (!worker) return registration
  await Promise.race([
    new Promise<void>(resolve => worker.addEventListener('statechange', () => {
      if (worker.state === 'activated' || worker.state === 'redundant') resolve()
    })),
    new Promise<void>(resolve => setTimeout(resolve, 10_000)),
  ])
  return registration
}

export async function ensureOfflineV5ServiceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) {
    throw new Error('Este navegador no permite preparar el acceso web offline.')
  }
  const current = await navigator.serviceWorker.getRegistration('/').catch(() => undefined)
  const registration = current || await navigator.serviceWorker.register('/sw.js', {
    scope: '/',
    updateViaCache: 'none',
  })
  return waitForOfflineWorker(registration)
}

export async function retireOfflineV5ServiceWorkerAndCaches(): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
    const registration = await navigator.serviceWorker.getRegistration('/').catch(() => undefined)
    await registration?.unregister().catch(() => false)
  }
  if (typeof caches !== 'undefined') {
    const names = await caches.keys().catch(() => [])
    await Promise.all(names
      .filter(name => OFFLINE_META_CACHES.has(name) || OFFLINE_CACHE_PREFIXES.some(prefix => name.startsWith(prefix)))
      .map(name => caches.delete(name)))
  }
}

async function sendOfflineV5ServiceWorkerRaw<T>(
  type: OfflineV5SWMessage,
  payload: Record<string, unknown> = {},
  timeoutMs = 10_000,
): Promise<OfflineV5ServiceWorkerReply<T> | undefined> {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return undefined
  const registered = await navigator.serviceWorker.getRegistration('/').catch(() => undefined)
  const registration = registered || (type === 'CLARIN_OFFLINE_V5_SET_ENABLED'
    ? await ensureOfflineV5ServiceWorkerRegistration().catch(() => undefined)
    : undefined)
  const waiting = type === 'CLARIN_OFFLINE_V5_SET_ENABLED' ? registration?.waiting : undefined
  const worker = waiting || navigator.serviceWorker.controller || registration?.active
  if (!worker) return undefined
  const delivery: OfflineV5ServiceWorkerDelivery = waiting ? 'waiting' : 'controlling'
  const channel = new MessageChannel()
  return new Promise<OfflineV5ServiceWorkerReply<T> | undefined>(resolve => {
    const timer = setTimeout(() => { channel.port1.close(); resolve(undefined) }, timeoutMs)
    channel.port1.onmessage = event => {
      clearTimeout(timer)
      channel.port1.close()
      const reply = event.data
      resolve(reply && typeof reply === 'object' && typeof reply.ok === 'boolean' ? { ...reply, delivery } as OfflineV5ServiceWorkerReply<T> : undefined)
    }
    worker.postMessage({ type, ...payload }, [channel.port2])
  })
}

async function requireOfflineV5ServiceWorkerAck(type: OfflineV5SWMessage, payload: Record<string, unknown> = {}, timeoutMs?: number): Promise<OfflineV5ServiceWorkerDelivery> {
  const reply = await sendOfflineV5ServiceWorkerRaw(type, payload, timeoutMs)
  if (!reply?.ok) throw new Error(reply?.error || 'El navegador no pudo preparar el acceso web offline.')
  return reply.delivery
}

/** SET_ENABLED downloads and verifies every canonical route shell, so its timeout must cover a slow connection. */
export function enableOfflineV5Shell() { return requireOfflineV5ServiceWorkerAck('CLARIN_OFFLINE_V5_SET_ENABLED', { enabled: true }, 180_000) }
export function setOfflineV5ServiceWorkerMode(mode: 'online' | 'offline') { return requireOfflineV5ServiceWorkerAck('CLARIN_OFFLINE_V5_SET_MODE', { mode }) }
export function beginOfflineV5OnlineReauth() { return requireOfflineV5ServiceWorkerAck('CLARIN_OFFLINE_V5_BEGIN_ONLINE_REAUTH') }
export async function clearOfflineV5LocalAuthority() {
  const delivery = await requireOfflineV5ServiceWorkerAck('CLARIN_OFFLINE_V5_CLEAR_LOCAL_AUTHORITY', {}, 1_500)
  await retireOfflineV5ServiceWorkerAndCaches()
  return delivery
}
export function clearOfflineV5FallbackOffer() { return requireOfflineV5ServiceWorkerAck('CLARIN_OFFLINE_V5_CLEAR_FALLBACK_OFFER') }
export async function getOfflineV5ServiceWorkerStatus(): Promise<OfflineV5ServiceWorkerStatus | undefined> {
  const reply = await sendOfflineV5ServiceWorkerRaw<OfflineV5ServiceWorkerStatus>('CLARIN_OFFLINE_V5_GET_STATUS')
  return reply?.ok ? reply.meta : undefined
}
export function usePreviousOfflineV5Shell() { return requireOfflineV5ServiceWorkerAck('CLARIN_OFFLINE_V5_USE_PREVIOUS') }
