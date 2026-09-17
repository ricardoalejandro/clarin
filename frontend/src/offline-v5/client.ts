import { clearOfflineV5FallbackOffer, clearOfflineV5LocalAuthority, enableOfflineV5Shell, setOfflineV5ServiceWorkerMode } from '../lib/offlineV5ServiceWorker'
import { clearOfflineV5BootMarker, markOfflineV5Boot } from '../lib/offlineV5Boot'
import { invalidateOfflineV5StoredSessionEpoch } from './storage'
import { OFFLINE_V5_PROTOCOL, OFFLINE_V5_SCHEMA, OFFLINE_V5_WORKER_URL, OfflineV5Error, type OfflineV5LocalGrantSummary, type OfflineV5MutationInput, type OfflineV5MutationResult, type OfflineV5Root, type OfflineV5RouteRequest, type OfflineV5RouteResponse, type OfflineV5SessionSnapshot, type OfflineV5Snapshot } from './types'

const OFFLINE_V5_CLIENT_BUILD = process.env.NEXT_PUBLIC_BUILD_VERSION || 'dev'
const OFFLINE_V5_WORKER_RECOVERY_PREFIX = 'clarin:offline-v5-worker-recovery:'

export function offlineV5SharedWorkerName(buildVersion = OFFLINE_V5_CLIENT_BUILD) {
  return `clarin-offline-v5-schema-${OFFLINE_V5_SCHEMA}:${buildVersion}`
}

export function markOfflineV5WorkerRecovery(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  pageBuild: string,
  workerBuild: string,
): boolean {
  const key = `${OFFLINE_V5_WORKER_RECOVERY_PREFIX}${pageBuild}:${workerBuild || 'unknown'}`
  try {
    if (storage.getItem(key) === '1') return false
    storage.setItem(key, '1')
    return true
  } catch {
    // Storage restrictions must not prevent one recovery attempt. This page
    // instance is destroyed by the reload, which still bounds the retry.
    return true
  }
}

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  generation: number
  scoped: boolean
  timer: ReturnType<typeof setTimeout>
}

export interface OfflineV5UnlockResult {
  accounts: Array<{ grantId: string; accountId: string; accountName: string }>
  snapshot?: OfflineV5SessionSnapshot
}

export class BrowserOfflineV5Client {
  private worker?: SharedWorker
  private current: OfflineV5SessionSnapshot = { generation: 0, active: false, mode: 'locked', authorizedModules: [], selectedRoots: {}, capabilities: [], pendingCount: 0, conflictCount: 0 }
  private listeners = new Set<(snapshot: OfflineV5SessionSnapshot) => void>()
  private pending = new Map<string, Pending>()
  private ready: Promise<void> = Promise.resolve()
  private heartbeat?: ReturnType<typeof setInterval>
  private lastActivityAt = 0
  private connectionError?: OfflineV5Error

  constructor(private readonly reloadForUpdate: () => void = () => window.location.reload()) {}

  state() { return this.current }

  subscribe(listener: (snapshot: OfflineV5SessionSnapshot) => void) {
    this.listeners.add(listener)
    this.connect()
    listener(this.current)
    return () => this.listeners.delete(listener)
  }

  private publish(snapshot: OfflineV5SessionSnapshot) {
    this.current = snapshot
    for (const listener of this.listeners) listener(snapshot)
  }

  private connect() {
    if (this.worker) return
    if (typeof SharedWorker === 'undefined' || !globalThis.isSecureContext) throw new OfflineV5Error('unsupported_browser', 'Este navegador no dispone del modo offline protegido.')
    // A versioned name prevents an older worker kept alive by another tab from
    // serving a freshly deployed page. IndexedDB remains schema-scoped and is
    // shared safely; only the in-memory worker process is rotated per release.
    const worker = new SharedWorker(OFFLINE_V5_WORKER_URL, { name: offlineV5SharedWorkerName(), type: 'module' })
    this.worker = worker
    this.connectionError = undefined
    let resolveReady!: () => void
    this.ready = new Promise(resolve => { resolveReady = resolve })
    worker.port.start()
    worker.onerror = () => {
      if (this.worker !== worker) return
      this.connectionError = new OfflineV5Error('worker_unavailable', 'El motor offline no pudo iniciarse. Recarga la página para volver a intentarlo.')
      resolveReady()
      this.close()
    }
    worker.port.onmessage = event => {
      if (this.worker !== worker) return
      const message = event.data
      const incompatibleProtocol = !message || message.protocol !== OFFLINE_V5_PROTOCOL || message.schema !== OFFLINE_V5_SCHEMA
      const workerBuild = message?.type === 'state' && typeof message.build_id === 'string' ? message.build_id : ''
      const changedBuild = message?.type === 'state' && workerBuild !== OFFLINE_V5_CLIENT_BUILD
      if (incompatibleProtocol || changedBuild) {
        this.connectionError = new OfflineV5Error(
          'worker_update_required',
          'Clarín se actualizó. Recarga esta página para continuar; tu información local permanece protegida.',
        )
        const reload = typeof window !== 'undefined'
          && markOfflineV5WorkerRecovery(window.sessionStorage, OFFLINE_V5_CLIENT_BUILD, workerBuild)
        resolveReady()
        this.close()
        if (reload) window.setTimeout(() => this.reloadForUpdate(), 0)
        return
      }
      if (message.type === 'state') {
        resolveReady()
        this.publish(message.state as OfflineV5SessionSnapshot)
        return
      }
      if (message.type !== 'result') return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id); clearTimeout(pending.timer)
      if (message.error) pending.reject(new OfflineV5Error(message.error.code, message.error.message))
      else if (pending.scoped && (message.generation !== pending.generation || this.current.generation !== pending.generation)) pending.reject(new OfflineV5Error('identity_changed', 'La respuesta se descartó porque cambió el usuario o la cuenta de esta pestaña.'))
      else pending.resolve(message.result)
    }
    this.heartbeat = setInterval(() => this.post('heartbeat', []), 5_000)
    window.addEventListener('pagehide', this.close)
    for (const name of ['pointerdown', 'keydown', 'focus'] as const) window.addEventListener(name, this.handleUserActivity, { passive: true })
  }

  private post(method: string, args: unknown[], id = crypto.randomUUID()) {
    this.worker?.port.postMessage({ id, protocol: OFFLINE_V5_PROTOCOL, schema: OFFLINE_V5_SCHEMA, generation: this.current.generation, method, args })
  }

  private async request<T>(method: string, args: unknown[] = [], scoped = false): Promise<T> {
    this.connect()
    const connection = this.worker
    let handshakeTimer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([this.ready, new Promise<void>((_, reject) => { handshakeTimer = setTimeout(() => reject(new OfflineV5Error('worker_timeout', 'El motor offline no respondió.')), 10_000) })]) }
    finally { if (handshakeTimer) clearTimeout(handshakeTimer) }
    if (!this.worker || this.worker !== connection) {
      throw this.connectionError || new OfflineV5Error('worker_unavailable', 'El motor offline se reinició. Recarga la página para continuar.')
    }
    return new Promise<T>((resolve, reject) => {
      const id = crypto.randomUUID()
      const timeout = method === 'prepare' || method === 'sync' ? 180_000 : 30_000
      const timer = setTimeout(() => { this.pending.delete(id); reject(new OfflineV5Error('operation_timeout', 'La operación tardó demasiado; los cambios locales permanecen guardados.')) }, timeout)
      this.pending.set(id, { resolve: value => resolve(value as T), reject, generation: this.current.generation, scoped, timer })
      this.post(method, args, id)
    })
  }

  profile() { return this.request<{ browser_profile_id: string; public_jwk: JsonWebKey; request_ids: string[] }>('profile') }
  enroll(displayName = 'Este navegador en este equipo') { return this.request<{ id: string; state: string; browser_profile_id: string; user_id: string }>('enroll', [displayName]) }
  grants() { return this.request<{ items: Array<Record<string, unknown>> }>('grants') }
  selection(grantID: string) { return this.request<{ items: OfflineV5Root[]; selection_revision: number }>('selection', [grantID]) }
  replaceSelection(grantID: string, revision: number, items: Array<Pick<OfflineV5Root, 'module' | 'resource_type' | 'resource_id'>>) { return this.request<{ items: OfflineV5Root[]; selection_revision: number }>('replaceSelection', [grantID, revision, items]) }
  listLocalGrants() { return this.request<OfflineV5LocalGrantSummary[]>('listLocalGrants') }
  hasAnyPreparedCopy() { return this.request<boolean>('hasAnyPreparedCopy') }
  hasPreparedCopyForUsername(username: string) { return this.request<boolean>('hasPreparedCopyForUsername', [username]) }
  refreshPreparedCopyAvailability() { return this.request<boolean>('refreshPreparedCopyAvailability') }
  async purgeLocalGrant(grantID: string) {
    const result = await this.request<{ removed: string[] }>('purgeLocalGrant', [grantID])
    // The server may revoke a grant whose local vault was already absent or
    // partially cleaned. Navigation authority belongs to the remaining local
    // corpus, not to whether this exact purge happened to delete a row.
    if (!await this.hasAnyPreparedCopy()) {
      clearOfflineV5BootMarker()
      await Promise.allSettled([
        clearOfflineV5LocalAuthority(),
        clearOfflineV5FallbackOffer(),
      ])
    }
    return result
  }
  reconcileLocalGrants(userID: string, authorizedGrantIDs: string[]) { return this.request<{ removed: string[] }>('reconcileLocalGrants', [userID, authorizedGrantIDs]) }
  hasPreparedCopy(userID: string, accountID: string) { return this.request<boolean>('hasPreparedCopy', [userID, accountID]) }

  async prepare(grantID: string, password: string) {
    const shellDelivery = await enableOfflineV5Shell()
    await navigator.storage?.persist?.().catch(() => false)
    const stored = await this.request<OfflineV5SessionSnapshot>('prepare', [grantID, password])
    const snapshot: OfflineV5SessionSnapshot = { ...stored, shellActivation: shellDelivery === 'waiting' ? 'next-reopen' : 'current' }
    this.publish(snapshot)
    // Preparing only creates the encrypted copy. It must never opt the current
    // online session into offline mode or leave a usable key in this port.
    if (shellDelivery === 'controlling') await setOfflineV5ServiceWorkerMode('online')
    return snapshot
  }

  async unlockUser(username: string, password: string, expected?: { user_id?: string; account_id?: string }): Promise<OfflineV5UnlockResult> {
    const result = await this.request<OfflineV5UnlockResult>('unlockUser', [username, password, expected])
    if (result.snapshot) {
      this.publish(result.snapshot)
      if (!markOfflineV5Boot()) {
        await this.lock().catch(() => undefined)
        throw new OfflineV5Error('boot_marker_unavailable', 'El navegador no pudo proteger la reapertura offline. Habilita el almacenamiento del sitio e inténtalo nuevamente.')
      }
      try { await setOfflineV5ServiceWorkerMode('offline') }
      catch (error) { clearOfflineV5BootMarker(); await this.lock().catch(() => undefined); throw error }
    }
    return result
  }

  async selectAccount(grantID: string) {
    const snapshot = await this.request<OfflineV5SessionSnapshot>('selectAccount', [grantID])
    this.publish(snapshot)
    if (!markOfflineV5Boot()) {
      await this.lock().catch(() => undefined)
      throw new OfflineV5Error('boot_marker_unavailable', 'El navegador no pudo proteger la reapertura offline. Habilita el almacenamiento del sitio e inténtalo nuevamente.')
    }
    try { await setOfflineV5ServiceWorkerMode('offline') }
    catch (error) { clearOfflineV5BootMarker(); await this.lock().catch(() => undefined); throw error }
    return snapshot
  }

  snapshot() { return this.request<OfflineV5SessionSnapshot>('snapshot', [], this.current.active) }
  activity() { if (this.worker && this.current.active) this.post('activity', []) }

  private handleUserActivity = () => {
    if (!this.worker || !this.current.active) return
    const now = Date.now()
    if (now - this.lastActivityAt < 10_000) return
    this.lastActivityAt = now
    // Deliberately fire-and-forget: the worker serializes the update and will
    // publish a locked state if the encrypted high-water write fails.
    void this.request<OfflineV5SessionSnapshot>('activity', [], true)
      .then(snapshot => this.publish(snapshot))
      .catch(() => undefined)
  }

  async sync() {
    // Sync is authenticated by the v5 proof/challenge protocol. The canonical
    // shell must remain latched offline until an online login has succeeded.
    const snapshot = await this.request<OfflineV5SessionSnapshot>('sync', [], true)
    this.publish(snapshot)
    return snapshot
  }

  route(request: OfflineV5RouteRequest) { return this.request<OfflineV5RouteResponse>('route.request', [request], true) }
  aggregates(module?: string) { return this.request<OfflineV5Snapshot[]>('data.aggregates', [module], true) }
  mutate<T>(input: OfflineV5MutationInput<T>) { return this.request<OfflineV5MutationResult<T>>('data.mutate', [input], true) }
  conflicts() { return this.request('data.conflicts', [], true) }
  async acknowledgeServerWinsConflicts() {
    const snapshot = await this.request<OfflineV5SessionSnapshot>('data.conflicts.acknowledge-server-wins', [], true)
    this.publish(snapshot)
    return snapshot
  }
  putBlob(input: { blobId: string; entityType: string; entityId: string; rootSelectionId: string; name: string; type: string; bytes: Blob }) { return this.request('blob.put', [input], true) }
  getBlob(blobID: string) { return this.request<Blob>('blob.get', [blobID], true) }
  deleteBlob(blobID: string) { return this.request<void>('blob.delete', [blobID], true) }

  async lock() {
    if (!this.worker) { this.publish({ ...this.current, generation: this.current.generation + 1, active: false, mode: 'locked', userId: undefined, accountId: undefined }); return this.current }
    const snapshot = await this.request<OfflineV5SessionSnapshot>('lock')
    this.publish(snapshot); return snapshot
  }

  close = () => {
    if (this.worker) { this.post('disconnect', []); this.worker.port.close(); this.worker = undefined }
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = undefined
    this.lastActivityAt = 0
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new OfflineV5Error('session_closed', 'Se cerró esta pestaña offline.')) }
    this.pending.clear()
    this.publish({ generation: this.current.generation + 1, active: false, mode: 'locked', authorizedModules: [], selectedRoots: {}, capabilities: [], pendingCount: 0, conflictCount: 0 })
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', this.close)
    if (typeof window !== 'undefined') for (const name of ['pointerdown', 'keydown', 'focus'] as const) window.removeEventListener(name, this.handleUserActivity)
  }
}

export const browserOfflineV5Client = new BrowserOfflineV5Client()

export async function invalidateActiveOfflineV5Session(): Promise<void> {
  // Rotate first: writes from a worker that is frozen, crashed or slow to ACK
  // still fail their expected-epoch transaction check.
  await invalidateOfflineV5StoredSessionEpoch()
  if (typeof BroadcastChannel === 'undefined') return
  const channel = new BroadcastChannel('clarin-offline-v5-invalidate'), id = crypto.randomUUID()
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, 200)
    channel.onmessage = event => { if (event.data?.type === 'invalidated' && event.data.id === id) { clearTimeout(timer); resolve() } }
    channel.postMessage({ type: 'invalidate', id })
  })
  channel.close()
}
