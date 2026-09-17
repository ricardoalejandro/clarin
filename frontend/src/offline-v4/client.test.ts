import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserOfflineClient } from './client'
import type { BrowserState, OfflineSession } from './types'
import { setOfflineV4NavigationEnabled } from '../lib/offlineV4ServiceWorker'

vi.mock('../lib/offlineV4ServiceWorker', () => ({ setOfflineV4NavigationEnabled: vi.fn(async () => true) }))

class WorkerDouble {
  static instances: WorkerDouble[] = []
  port = { start: vi.fn(), close: vi.fn(), postMessage: vi.fn(), onmessage: null as ((event: { data: unknown }) => void) | null }
  onerror: (() => void) | null = null
  constructor() { WorkerDouble.instances.push(this) }
  state(state: BrowserState, protocol = 4) { this.port.onmessage?.({ data: { type: 'state', protocol, schema: 1, build_id: 'development', state } }) }
}
const session: OfflineSession = { session_id: 'grant-a:1', capability: '', profile_epoch: 1, idle_expires_at: '2026-09-15T05:00:00Z', lease_expires_at: '2026-09-16T00:00:00Z', actions: ['tasks.read'], actor: { user_id: 'user-a', account_id: 'account-a', username: 'usuario-a', display_name: 'Usuario A', account_name: 'Cuenta A' } }
let clients: BrowserOfflineClient[] = []
beforeEach(() => {
  WorkerDouble.instances = []; clients = []
  vi.stubGlobal('SharedWorker', WorkerDouble)
  vi.stubGlobal('isSecureContext', true)
  localStorage.clear()
})
afterEach(() => { for (const client of clients) client.close(); vi.unstubAllGlobals() })
function activeClient() {
  const client = new BrowserOfflineClient(), listener = vi.fn()
  clients.push(client); client.subscribe(listener)
  const worker = WorkerDouble.instances.at(-1)!
  worker.state({ generation: 1, session, grant_id: 'grant-a' })
  return { client, listener, worker }
}
describe('SharedWorker client lifecycle', () => {
  it('publishes a locked state immediately when closing, clearing the previously rendered actor', () => {
    const { client, listener, worker } = activeClient()
    expect(listener.mock.lastCall?.[0].session.actor.user_id).toBe('user-a')
    client.close()
    expect(listener.mock.lastCall?.[0]).toEqual({ generation: 2, session: null })
    expect(client.state().session).toBeNull()
    expect(worker.port.close).toHaveBeenCalled()
    expect(worker.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ method: 'disconnect' }))
  })
  it('locks the rendered UI on worker errors and rejects obsolete worker messages after reconnecting', () => {
    const { client, listener, worker } = activeClient()
    worker.onerror?.()
    expect(listener.mock.lastCall?.[0].session).toBeNull()
    client.subscribe(() => {})
    expect(WorkerDouble.instances).toHaveLength(2)
    worker.state({ generation: 1, session, grant_id: 'grant-a' })
    expect(client.state().session).toBeNull()
  })
  it('locks rather than accepting an incompatible worker handshake', () => {
    const { client, listener, worker } = activeClient()
    worker.state({ generation: 2, session }, 3)
    expect(client.state().session).toBeNull()
    expect(listener.mock.lastCall?.[0].session).toBeNull()
  })
  it('does not prepare private data unless the public shell acknowledged complete verified preparation', async () => {
    const client = new BrowserOfflineClient(); clients.push(client)
    localStorage.setItem('token', 'cookie-session')
    vi.mocked(setOfflineV4NavigationEnabled).mockResolvedValueOnce(false)
    await expect(client.prepare('grant-a', 'contraseña de prueba segura')).rejects.toMatchObject({ code: 'shell_not_ready' })
    expect(WorkerDouble.instances).toHaveLength(0)
  })
})
