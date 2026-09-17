import { browserOfflineV5Client, type OfflineV5UnlockResult } from '@/offline-v5/client'
import { OfflineV5Error, type OfflineV5RouteRequest, type OfflineV5RouteResponse, type OfflineV5SessionSnapshot } from '@/offline-v5/types'
import { beginOfflineV5OnlineReauth, clearOfflineV5FallbackOffer, clearOfflineV5LocalAuthority, getOfflineV5ServiceWorkerStatus, setOfflineV5ServiceWorkerMode, type OfflineV5ServiceWorkerStatus } from './offlineV5ServiceWorker'
import { clearOfflineV5BootMarker, markOfflineV5Boot, readOfflineV5BootMarker } from './offlineV5Boot'

export type OfflineV5RuntimeMode = 'online' | 'offline' | 'syncing' | 'conflict' | 'locked' | 'unavailable'

export interface RuntimeSnapshot {
  mode: OfflineV5RuntimeMode
  active: boolean
  canEnterOffline: boolean
  userId?: string
  accountId?: string
  authorizedModules: readonly string[]
  selectedRoots: Readonly<Record<string, readonly string[]>>
  capabilities: readonly string[]
  pendingCount: number
  conflictCount: number
  lastSyncAt?: string
  leaseExpiresAt?: string
  error?: string
}

const EMPTY: RuntimeSnapshot = {
  mode: 'online', active: false, canEnterOffline: false, authorizedModules: [], selectedRoots: {}, capabilities: [], pendingCount: 0, conflictCount: 0,
}

export function offlineV5RuntimeAtBoot(markedOffline: boolean): RuntimeSnapshot {
  return markedOffline ? { ...EMPTY, mode: 'locked', canEnterOffline: true } : EMPTY
}

const bootMarkedOffline = readOfflineV5BootMarker()
let current: RuntimeSnapshot = offlineV5RuntimeAtBoot(bootMarkedOffline)
let offlineRequested = bootMarkedOffline
let onlineTransitionRequested = false
let onlineTransitionTimer: ReturnType<typeof setTimeout> | undefined
let clientSubscribed = false
let bootstrapPromise: Promise<RuntimeSnapshot> | undefined
let preparedAvailabilityPromise: Promise<boolean> | undefined
const listeners = new Set<(snapshot: RuntimeSnapshot) => void>()

function publish(next: RuntimeSnapshot) {
  current = Object.freeze({ ...next, authorizedModules: Object.freeze([...next.authorizedModules]), capabilities: Object.freeze([...next.capabilities]), selectedRoots: Object.freeze(Object.fromEntries(Object.entries(next.selectedRoots).map(([module, ids]) => [module, Object.freeze([...ids])]))) })
  for (const listener of listeners) listener(current)
}

function fromWorker(snapshot: OfflineV5SessionSnapshot): RuntimeSnapshot {
  if (!snapshot.active) return { ...EMPTY, mode: offlineRequested ? snapshot.mode : 'online', canEnterOffline: current.canEnterOffline, error: snapshot.error }
  return {
    mode: snapshot.mode,
    active: true,
    canEnterOffline: true,
    userId: snapshot.userId,
    accountId: snapshot.accountId,
    authorizedModules: snapshot.authorizedModules,
    selectedRoots: snapshot.selectedRoots,
    capabilities: snapshot.capabilities,
    pendingCount: snapshot.pendingCount,
    conflictCount: snapshot.conflictCount,
    lastSyncAt: snapshot.lastSyncAt,
    leaseExpiresAt: snapshot.leaseExpiresAt,
    error: snapshot.error,
  }
}

function ensureClientSubscription() {
  if (clientSubscribed || typeof window === 'undefined') return
  clientSubscribed = true
  void bootstrapOfflineV5Runtime()
  try { browserOfflineV5Client.subscribe(snapshot => publish(fromWorker(snapshot))) }
  catch (error) {
    publish({ ...EMPTY, mode: offlineRequested ? 'unavailable' : 'online', error: error instanceof Error ? error.message : 'El modo offline no está disponible en este navegador.' })
  }
}

export function getOfflineV5RuntimeSnapshot(): RuntimeSnapshot { return current }

export function subscribeOfflineV5Runtime(listener: (snapshot: RuntimeSnapshot) => void): () => void {
  listeners.add(listener)
  ensureClientSubscription()
  listener(current)
  return () => listeners.delete(listener)
}

export async function hasPreparedOfflineV5Copy(userId: string, accountId: string): Promise<boolean> {
  ensureClientSubscription()
  try {
    const available = await browserOfflineV5Client.hasPreparedCopy(userId, accountId)
    publish({ ...current, canEnterOffline: available })
    return available
  } catch { return false }
}

export async function hasAnyPreparedOfflineV5Copy(): Promise<boolean> {
  ensureClientSubscription()
  if (preparedAvailabilityPromise) return preparedAvailabilityPromise
  preparedAvailabilityPromise = (async () => {
    try {
      const available = typeof navigator !== 'undefined' && navigator.onLine === false
        ? await browserOfflineV5Client.hasAnyPreparedCopy()
        : await browserOfflineV5Client.refreshPreparedCopyAvailability()
      if (!available) {
        offlineRequested = false
        clearOfflineV5BootMarker()
        await Promise.allSettled([
          clearOfflineV5LocalAuthority(),
          clearOfflineV5FallbackOffer(),
        ])
        publish(EMPTY)
      } else {
        publish({ ...current, canEnterOffline: true })
      }
      return available
    } catch { return false }
  })().finally(() => { preparedAvailabilityPromise = undefined })
  return preparedAvailabilityPromise
}

export async function hasPreparedOfflineV5CopyForUsername(username: string): Promise<boolean> {
  const login = username.trim()
  if (!login) return false
  ensureClientSubscription()
  try {
    // Reconcile revocations whenever Clarin is reachable. A genuine outage
    // preserves encrypted data, but the keyed username lookup below still
    // prevents another user's copy from changing this login screen.
    if (typeof navigator === 'undefined' || navigator.onLine !== false) {
      await browserOfflineV5Client.refreshPreparedCopyAvailability()
    }
    return await browserOfflineV5Client.hasPreparedCopyForUsername(login)
  } catch { return false }
}

export async function unlockOfflineV5User(username: string, password: string, expected?: { userId?: string; accountId?: string }): Promise<OfflineV5UnlockResult> {
  offlineRequested = true
  ensureClientSubscription()
  try {
    const result = await browserOfflineV5Client.unlockUser(username, password, expected ? { user_id: expected.userId, account_id: expected.accountId } : undefined)
    publish(result.snapshot ? fromWorker(result.snapshot) : { ...EMPTY, mode: 'locked', canEnterOffline: true })
    return result
  } catch (error) {
    publish({ ...EMPTY, mode: 'locked', canEnterOffline: current.canEnterOffline, error: error instanceof Error ? error.message : 'No se pudo desbloquear la copia offline.' })
    throw error
  }
}

export async function selectOfflineV5Account(grantId: string): Promise<RuntimeSnapshot> {
  offlineRequested = true
  const snapshot = await browserOfflineV5Client.selectAccount(grantId)
  const next = fromWorker(snapshot); publish(next); return next
}

export async function enterOfflineV5(input: { username: string; password: string; userId?: string; accountId?: string; grantId?: string }): Promise<RuntimeSnapshot> {
  const result = await unlockOfflineV5User(input.username, input.password, { userId: input.userId, accountId: input.accountId })
  if (result.snapshot) return fromWorker(result.snapshot)
  if (input.grantId) return selectOfflineV5Account(input.grantId)
  throw new OfflineV5Error('account_selection_required', 'Elige cuál de tus cuentas autorizadas deseas abrir offline.')
}

/** Open the SW's narrow online-login latch without exposing any cached data. */
export async function beginOfflineV5OnlineTransition(
  begin: () => Promise<unknown> = beginOfflineV5OnlineReauth,
): Promise<void> {
  await begin()
  onlineTransitionRequested = true
  if (onlineTransitionTimer) clearTimeout(onlineTransitionTimer)
  onlineTransitionTimer = setTimeout(() => { void cancelOfflineV5OnlineTransition().catch(() => undefined) }, 2 * 60 * 1000)
}

/** Cancel reauthentication and consume the SW latch while staying offline. */
export async function cancelOfflineV5OnlineTransition(
  restoreOffline: () => Promise<unknown> = () => setOfflineV5ServiceWorkerMode('offline'),
): Promise<void> {
  onlineTransitionRequested = false
  if (onlineTransitionTimer) clearTimeout(onlineTransitionTimer)
  onlineTransitionTimer = undefined
  await restoreOffline()
}

/** Called only after the server confirms the exact expected user and account. */
export async function completeOfflineV5OnlineTransition(
  setOnline: () => Promise<unknown> = () => setOfflineV5ServiceWorkerMode('online'),
): Promise<RuntimeSnapshot> {
  await browserOfflineV5Client.lock().catch(() => undefined)
  await setOnline()
  onlineTransitionRequested = false
  if (onlineTransitionTimer) clearTimeout(onlineTransitionTimer)
  onlineTransitionTimer = undefined
  offlineRequested = false
  clearOfflineV5BootMarker()
  publish({ ...EMPTY, canEnterOffline: current.canEnterOffline })
  return current
}

/** Compatibility name used by callers after an already authenticated login. */
export const leaveOfflineV5 = completeOfflineV5OnlineTransition

export async function requestOfflineV5Sync(): Promise<RuntimeSnapshot> {
  if (!current.active) throw new OfflineV5Error('locked', 'Desbloquea primero la copia offline.')
  const snapshot = await browserOfflineV5Client.sync()
  const next = fromWorker(snapshot); publish(next); return next
}

export async function acknowledgeOfflineV5ServerWinsConflicts(): Promise<RuntimeSnapshot> {
  if (!current.active) throw new OfflineV5Error('locked', 'Desbloquea primero la copia offline.')
  const snapshot = await browserOfflineV5Client.acknowledgeServerWinsConflicts()
  const next = fromWorker(snapshot); publish(next); return next
}

export function explainOfflineV5Capability(action: string, resource?: string): { allowed: boolean; reason?: string } {
  if (!current.active) return { allowed: false, reason: 'La copia offline está bloqueada.' }
  if (!current.capabilities.includes(action)) return { allowed: false, reason: 'El superadmin o tus permisos actuales no autorizaron esta acción offline.' }
  if (resource && !Object.values(current.selectedRoots).some(ids => ids.includes(resource))) return { allowed: false, reason: 'Este recurso no fue elegido para la copia offline.' }
  return { allowed: true }
}

export function shouldOfferOfflineV5(status?: OfflineV5ServiceWorkerStatus): boolean {
  // `fallback_offer` is transient. `mode=offline` is the durable truth after
  // the browser is closed and reopened, including when navigator.onLine=true
  // but Cloudflare/the origin is unavailable.
  return Boolean(status?.fallback_offer || status?.mode === 'offline')
}

export function runtimeAfterOfflineV5Bootstrap(status: OfflineV5ServiceWorkerStatus | undefined, previous: RuntimeSnapshot): RuntimeSnapshot {
  if (previous.active || !status) return previous
  if (status.mode === 'offline') return { ...EMPTY, mode: 'locked', canEnterOffline: true }
  if (status.mode === 'online') return EMPTY
  return previous
}

export interface OfflineV5BootMarkerOperations {
  mark(): unknown
  clear(): unknown
}

export function bootstrapOfflineV5Runtime(
  getStatus: () => Promise<OfflineV5ServiceWorkerStatus | undefined> = getOfflineV5ServiceWorkerStatus,
  marker: OfflineV5BootMarkerOperations = { mark: markOfflineV5Boot, clear: clearOfflineV5BootMarker },
): Promise<RuntimeSnapshot> {
  if (bootstrapPromise) return bootstrapPromise
  bootstrapPromise = (async () => {
    const status = await getStatus().catch(() => undefined)
    if (status?.mode === 'offline') {
      offlineRequested = true
      marker.mark()
    } else if (status?.mode === 'online' && !current.active) {
      // A canonical online status proves a prior marker was left by an aborted
      // or crashed transition. Missing/unreachable status stays fail-closed.
      offlineRequested = false
      marker.clear()
    }
    onlineTransitionRequested = status?.mode === 'offline' && status.online_transition === true
    const next = runtimeAfterOfflineV5Bootstrap(status, current)
    if (next !== current) publish(next)
    return current
  })().finally(() => { bootstrapPromise = undefined })
  return bootstrapPromise
}

export async function refreshOfflineV5FallbackOffer(
  getStatus: () => Promise<OfflineV5ServiceWorkerStatus | undefined> = getOfflineV5ServiceWorkerStatus,
  hasPreparedCopy: () => Promise<boolean> = hasAnyPreparedOfflineV5Copy,
): Promise<boolean> {
  return (await refreshOfflineV5FallbackState(getStatus, hasPreparedCopy)).offer
}

export type OfflineV5FallbackState = {
  offer: boolean
  reloadOnlineLogin: boolean
}

/**
 * Reconciles a cached offline login with the remaining encrypted corpus.
 * A full online navigation is required only after a previously-offline shell
 * was authoritatively disabled; network errors leave the fail-closed shell in
 * place and therefore cannot cause a reload loop.
 */
export async function refreshOfflineV5FallbackState(
  getStatus: () => Promise<OfflineV5ServiceWorkerStatus | undefined> = getOfflineV5ServiceWorkerStatus,
  hasPreparedCopy: () => Promise<boolean> = hasAnyPreparedOfflineV5Copy,
): Promise<OfflineV5FallbackState> {
  const before = await getStatus()
  if (!shouldOfferOfflineV5(before)) return { offer: false, reloadOnlineLogin: false }
  if (await hasPreparedCopy()) return { offer: true, reloadOnlineLogin: false }
  const after = await getStatus()
  return {
    offer: false,
    reloadOnlineLogin: before?.mode === 'offline' && after?.mode === 'online' && after.enabled === false,
  }
}

export function replaceStaleOfflineLoginWithOnline(
  replace: (url: string) => void = url => window.location.replace(url),
) {
  replace('/login')
}

export async function dismissOfflineV5FallbackOffer() { await clearOfflineV5FallbackOffer() }

export function shouldCloseOfflineV5OnlineTransition(pathname: string, responseOK: boolean): boolean {
  return pathname === '/api/auth/logout' || (pathname === '/api/auth/login' && !responseOK)
}

function responseFromOffline(value: OfflineV5RouteResponse): Response {
  return new Response(value.binary ?? value.body, { status: value.status, headers: value.headers })
}

function onlineRequired(): Response {
  return responseFromOffline({ status: 503, headers: [['Content-Type', 'application/json; charset=utf-8'], ['Cache-Control', 'no-store'], ['X-Clarin-Offline', '5']], body: JSON.stringify({ success: false, error: 'online_required', message: 'Esta función requiere conexión con Clarín.', offline: true }) })
}

type SerializedOfflineV5Request = OfflineV5RouteRequest | null | 'blocked-egress'

export function offlineV5ShouldBlockEgress(currentOrigin: string, target: string): boolean {
  try { return new URL(target, currentOrigin).origin !== currentOrigin } catch { return true }
}

async function serializeRequest(input: RequestInfo | URL, init?: RequestInit): Promise<SerializedOfflineV5Request> {
  const request = new Request(input, init), url = new URL(request.url, location.origin)
  if (offlineV5ShouldBlockEgress(location.origin, url.href)) return 'blocked-egress'
  if (!url.pathname.startsWith('/api/') || url.pathname.startsWith('/api/offline/v5/')) return null
  if (request.signal.aborted) throw new DOMException('Aborted', 'AbortError')
  let requestBody: string | undefined
  if (!['GET', 'HEAD'].includes(request.method.toUpperCase())) {
    const type = request.headers.get('content-type') || ''
    if (type && !type.includes('application/json')) return { url: url.href, method: request.method, headers: [['x-clarin-offline-unsupported-body', '1']] }
    requestBody = await request.clone().text()
  }
  const headers: Array<[string, string]> = []
  for (const name of ['accept', 'content-type', 'if-match']) {
    const value = request.headers.get(name)
    if (value) headers.push([name, value])
  }
  return { url: url.href, method: request.method, headers, ...(requestBody ? { body: requestBody } : {}) }
}

export async function offlineV5Request(input: RequestInfo | URL, init?: RequestInit, onlineFetch: typeof fetch = globalThis.fetch): Promise<Response> {
  const lockedOffline = !current.active && offlineRequested && current.mode === 'locked'
  if (!current.active && !lockedOffline) return onlineFetch(input, init)
  const serialized = await serializeRequest(input, init)
  if (serialized === 'blocked-egress') return responseFromOffline({ status: 503, headers: [['Content-Type', 'application/json; charset=utf-8'], ['Cache-Control', 'no-store'], ['X-Clarin-Offline', '5']], body: JSON.stringify({ success: false, error: 'offline_network_blocked', message: 'El modo offline bloqueó una conexión externa para proteger esta copia.', offline: true }) })
  if (!serialized) return onlineFetch(input, init)
  const transitionURL = new URL(serialized.url)
  const transitionMethod = serialized.method.toUpperCase()
  const transitionAllowed = onlineTransitionRequested && (
    transitionMethod === 'POST' && (transitionURL.pathname === '/api/auth/login' || transitionURL.pathname === '/api/auth/logout')
    || transitionMethod === 'GET' && transitionURL.pathname === '/api/public/security-config'
  )
  if (transitionAllowed) {
    try {
      const response = await onlineFetch(input, init)
      // A trusted 401/403 (or any failed login) consumes the one-shot latch and
      // explicitly restores `offline`; it can never promote the SW to online.
      if (shouldCloseOfflineV5OnlineTransition(transitionURL.pathname, response.ok)) await cancelOfflineV5OnlineTransition().catch(() => undefined)
      return response
    } catch (error) {
      if (transitionURL.pathname === '/api/auth/login') await cancelOfflineV5OnlineTransition().catch(() => undefined)
      throw error
    }
  }
  if (lockedOffline) return onlineRequired()
  if (serialized.headers.some(([name]) => name === 'x-clarin-offline-unsupported-body')) return onlineRequired()
  const value = await browserOfflineV5Client.route(serialized)
  return responseFromOffline(value)
}

const FETCH_MARKER = Symbol.for('clarin.offlineV5.fetch')
type MarkedGlobal = typeof globalThis & { [FETCH_MARKER]?: { original: typeof fetch; wrapper: typeof fetch; references: number } }

export function installOfflineV5FetchInterceptor(): () => void {
  if (typeof window === 'undefined') return () => {}
  ensureClientSubscription()
  const target = globalThis as MarkedGlobal
  const existing = target[FETCH_MARKER]
  if (existing) {
    existing.references++
    return () => uninstallFetch(target, existing)
  }
  const original = globalThis.fetch.bind(globalThis)
  const wrapper: typeof fetch = (input, init) => offlineV5Request(input, init, original)
  const state = { original, wrapper, references: 1 }
  target[FETCH_MARKER] = state
  globalThis.fetch = wrapper
  return () => uninstallFetch(target, state)
}

function uninstallFetch(target: MarkedGlobal, state: { original: typeof fetch; wrapper: typeof fetch; references: number }) {
  state.references--
  if (state.references > 0 || target[FETCH_MARKER] !== state) return
  if (globalThis.fetch === state.wrapper) globalThis.fetch = state.original
  delete target[FETCH_MARKER]
}

export function setOfflineV5RuntimeClientForTests(snapshot: RuntimeSnapshot = EMPTY) {
  offlineRequested = snapshot.mode !== 'online'
  onlineTransitionRequested = false
  if (onlineTransitionTimer) clearTimeout(onlineTransitionTimer)
  onlineTransitionTimer = undefined
  publish(snapshot)
}
