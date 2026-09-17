import type { OfflineDataGateway } from '../offline-v3/gateway'
import { setOfflineV4NavigationEnabled } from '../lib/offlineV4ServiceWorker'
import { invalidateStoredSessionEpoch } from './storage'
export { hasPreparedCopy } from './storage'
import { BrowserOfflineError, PROTOCOL, WORKER_SCHEMA, WORKER_URL, type BrowserCapabilities, type BrowserState, type LocalGrantSummary, type OfflineSession } from './types'

declare const __CLARIN_OFFLINE_BUILD__: string

export class BrowserOfflineClient {
  private worker?: SharedWorker
  private current: BrowserState = { generation: 0, session: null }
  private listeners = new Set<(state: BrowserState) => void>()
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: unknown) => void; generation: number; scoped: boolean; timer: ReturnType<typeof setTimeout> }>()
  private ready: Promise<void> = Promise.resolve()
  private heartbeat?: ReturnType<typeof setInterval>
  private connect() {
    if (this.worker) return
    if (typeof SharedWorker === 'undefined' || !globalThis.isSecureContext) throw new BrowserOfflineError('unsupported_browser', 'Este navegador no dispone del modo offline protegido. Clarín online sigue disponible.')
    const worker = new SharedWorker(WORKER_URL, { name: 'clarin-offline-v4-schema-1', type: 'module' })
    this.worker = worker
    let readyResolve!: () => void
    this.ready = new Promise<void>(resolve => { readyResolve = resolve })
    worker.port.start()
    worker.onerror = () => {
      if (this.worker !== worker) return
      this.close()
      readyResolve()
    }
    worker.port.onmessage = event => {
      if (this.worker !== worker) return
      const message = event.data
      if (message.protocol !== PROTOCOL || message.schema !== WORKER_SCHEMA || (message.type === 'state' && typeof __CLARIN_OFFLINE_BUILD__ !== 'undefined' && message.build_id !== __CLARIN_OFFLINE_BUILD__)) { this.close(); readyResolve(); return }
      if (message.type === 'state') {
        this.current = message.state
        readyResolve()
        for (const listener of this.listeners) listener(this.current)
        return
      }
      if (message.type !== 'result') return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new BrowserOfflineError(message.error.code, message.error.message))
      else if (pending.scoped && (message.generation !== pending.generation || this.current.generation !== pending.generation)) pending.reject(new BrowserOfflineError('identity_changed', 'La respuesta anterior se descartó porque cambió la sesión.'))
      else pending.resolve(message.result)
    }
    this.heartbeat = setInterval(() => this.post('heartbeat', []), 5000)
    window.addEventListener('pagehide', this.close)
  }
  private post(method: string, args: unknown[], id = crypto.randomUUID()): string {
    this.worker?.port.postMessage({ id, protocol: PROTOCOL, schema: WORKER_SCHEMA, generation: this.current.generation, method, args }); return id
  }
  private async request<T>(method: string, args: unknown[] = []): Promise<T> {
    this.connect()
    const connection = this.worker
    let handshakeTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([this.ready, new Promise<void>((_, reject) => { handshakeTimer = setTimeout(() => reject(new BrowserOfflineError('worker_timeout', 'El modo offline no respondió. Vuelve a abrir Clarín.')), 10000) })])
    } finally { if (handshakeTimer) clearTimeout(handshakeTimer) }
    if (!this.worker || this.worker !== connection) throw new BrowserOfflineError('worker_unavailable', 'La conexión offline cambió. Vuelve a intentar la operación.')
    return new Promise<T>((resolve, reject) => {
      const id = crypto.randomUUID()
      const timer = setTimeout(() => { this.pending.delete(id); reject(new BrowserOfflineError('operation_timeout', 'La operación tardó demasiado. Los cambios guardados permanecen en este equipo; vuelve a comprobar su estado.')) }, method === 'prepare' || method === 'gateway.triggerSync' ? 180000 : 30000)
      this.pending.set(id, { resolve: value => resolve(value as T), reject, generation: this.current.generation, scoped: method.startsWith('gateway.'), timer })
      this.post(method, args, id)
    })
  }
  state() { return this.current }
  subscribe(listener: (state: BrowserState) => void) {
    this.listeners.add(listener)
    this.connect(); listener(this.current)
    return () => { this.listeners.delete(listener) }
  }
  async capabilities(): Promise<BrowserCapabilities> {
    if (typeof SharedWorker === 'undefined' || !globalThis.isSecureContext) return { supported: false, persistent: false, usage: 0, quota: 0, reason: 'Este navegador no dispone del modo offline protegido. Clarín online sigue disponible.' }
    return this.request('capabilities')
  }
  profile() { return this.request<{ browser_profile_id: string; public_jwk: JsonWebKey; request_ids: string[] }>('profile') }
  listLocalGrants() { return this.request<LocalGrantSummary[]>('listLocalGrants') }
  enroll(displayName = 'Este navegador en este equipo') {
    return this.request<{ id: string; state: string; browser_profile_id: string; user_id: string }>('enroll', [this.onlineToken(), displayName])
  }
  async prepare(grantID: string, password: string): Promise<OfflineSession> {
    const token = this.onlineToken()
    // persist() is Window-only. Request it from the user's preparation gesture;
    // the worker independently rechecks persisted() before allowing any write.
    const persistence = navigator.storage?.persist?.().catch(() => false) || Promise.resolve(false)
    if (!await setOfflineV4NavigationEnabled(true)) throw new BrowserOfflineError('shell_not_ready', 'No se pudo preparar y verificar la interfaz offline. Conecta y vuelve a intentarlo.')
    await persistence
    return this.request<OfflineSession>('prepare', [grantID, password, token])
  }
  unlock(grantID: string, password: string, username: string) { return this.request<OfflineSession>('unlock', [grantID, password, username]) }
  unlockUser(username: string, password: string, expected?: { user_id: string; account_id: string }) { return this.request<{ accounts: Array<{ grant_id: string; account_name: string }>; session?: OfflineSession }>('unlockUser', [username, password, expected]) }
  selectAccount(grantID: string) { return this.request<OfflineSession>('selectAccount', [grantID]) }
  replaceSelection(grantID: string, revision: number, items: Array<{ module: string; resource_type: string; resource_id: string }>) {
    return this.request('replaceSelection', [grantID, revision, items, this.onlineToken()])
  }
  lock() { return this.request<void>('lock') }
  activity() { if (this.worker) this.post('activity', []) }
  private onlineToken() {
    const token = localStorage.getItem('token') || ''
    if (!token) throw new BrowserOfflineError('online_required', 'Inicia sesión online para preparar o administrar esta copia.')
    return token
  }
  close = () => {
    if (this.worker) { this.post('disconnect', []); this.worker.port.close(); this.worker = undefined }
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = undefined
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new BrowserOfflineError('session_closed', 'Se cerró esta sesión offline.')) }
    this.pending.clear(); this.current = { generation: this.current.generation + 1, session: null }
    for (const listener of this.listeners) listener(this.current)
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', this.close)
  }
  gateway(): OfflineDataGateway {
    return {
      resources: (module, cursor) => this.request('gateway.resources', [module, cursor]),
      taskLists: cursor => this.request('gateway.taskLists', [cursor]), tasks: (id, cursor) => this.request('gateway.tasks', [id, cursor]),
      contacts: cursor => this.request('gateway.contacts', [cursor]), contact: id => this.request('gateway.contact', [id]),
      programs: cursor => this.request('gateway.programs', [cursor]), program: id => this.request('gateway.program', [id]),
      whiteboards: cursor => this.request('gateway.whiteboards', [cursor]), whiteboardScene: id => this.request('gateway.whiteboardScene', [id]),
      conflicts: cursor => this.request('gateway.conflicts', [cursor]), createTask: input => this.request('gateway.createTask', [input]),
      completeTask: (id, input) => this.request('gateway.completeTask', [id, input]),
      syncStatus: () => this.request('gateway.syncStatus'), triggerSync: () => this.request('gateway.triggerSync'),
    }
  }
}
export const browserOfflineClient = new BrowserOfflineClient()

/** Auth transitions invalidate existing workers without opening a worker or creating a profile. */
export async function invalidateActiveOfflineSession(): Promise<void> {
  // Durable barrier is checked in the same transaction as every private write;
  // the broadcast ACK is only prompt UI feedback, never the authority boundary.
  await invalidateStoredSessionEpoch()
  if (typeof BroadcastChannel === 'undefined') return
  const channel = new BroadcastChannel('clarin-offline-v4-invalidate'), id = crypto.randomUUID()
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, 150)
    channel.onmessage = event => { if (event.data?.type === 'invalidated' && event.data.id === id) { clearTimeout(timer); resolve() } }
    channel.postMessage({ type: 'invalidate', id })
  })
  channel.close()
}
