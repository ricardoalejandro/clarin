import { BrowserOfflineEngine } from './engine'
import { BrowserOfflineError, PROTOCOL, WORKER_SCHEMA, type BrowserState } from './types'
import type { OfflineDataGateway } from '../offline-v3/gateway'

declare const __CLARIN_OFFLINE_BUILD__: string
const buildID = typeof __CLARIN_OFFLINE_BUILD__ === 'undefined' ? 'development' : __CLARIN_OFFLINE_BUILD__
export interface WorkerRequest { id: string; protocol: 4; schema: 1; generation: number; method: string; args: unknown[] }
const scope = globalThis as unknown as { location: Location; onconnect: (event: MessageEvent) => void; setInterval: typeof setInterval }
const engine = new BrowserOfflineEngine(scope.location.origin)
const ports = new Map<MessagePort, { seen: number; generation: number | null }>()
let queue = Promise.resolve()
function publicState(state: BrowserState, generation: number | null) {
  return generation === state.generation ? state : { generation: state.generation, session: null, preparing: state.preparing }
}
function broadcast(state: BrowserState) { for (const [port, context] of ports) port.postMessage({ type: 'state', protocol: PROTOCOL, schema: WORKER_SCHEMA, build_id: buildID, state: publicState(state, context.generation) }) }
engine.subscribe(broadcast)
const invalidation = new BroadcastChannel('clarin-offline-v4-invalidate')
invalidation.onmessage = event => {
  if (event.data?.type === 'invalidate') { engine.lock(); invalidation.postMessage({ type: 'invalidated', id: event.data.id }) }
}
const gatewayMethods = new Set<keyof OfflineDataGateway>(['conflicts', 'resources', 'taskLists', 'tasks', 'contacts', 'contact', 'programs', 'program', 'whiteboards', 'whiteboardScene', 'createTask', 'completeTask', 'syncStatus', 'triggerSync'])
async function dispatch(request: WorkerRequest) {
  const args = request.args
  if (request.method.startsWith('gateway.')) {
    if (request.generation !== engine.state().generation) throw new BrowserOfflineError('identity_changed', 'La sesión cambió. Vuelve a abrir esta pantalla.')
    const name = request.method.slice(8) as keyof OfflineDataGateway
    if (!gatewayMethods.has(name)) throw new BrowserOfflineError('invalid_method', 'Operación no permitida.')
    const method = engine.gateway()[name] as (...input: unknown[]) => Promise<unknown>
    return method(...args)
  }
  switch (request.method) {
    case 'capabilities': return engine.capabilities(Boolean(args[0]))
    case 'profile': return engine.profile()
    case 'listLocalGrants': return engine.listLocalGrants()
    case 'enroll': return engine.enroll(String(args[0] || ''), String(args[1] || ''))
    case 'prepare': return engine.prepare(String(args[0]), String(args[1]), String(args[2] || ''))
    case 'unlock': return engine.unlock(String(args[0]), String(args[1]), String(args[2] || ''))
    case 'unlockUser': return engine.unlockUser(String(args[0] || ''), String(args[1] || ''), args[2] as { user_id: string; account_id: string } | undefined)
    case 'selectAccount': return engine.selectAccount(String(args[0]))
    case 'replaceSelection': return engine.replaceSelection(String(args[0]), Number(args[1]), args[2] as Parameters<BrowserOfflineEngine['replaceSelection']>[2], String(args[3] || ''))
    default: throw new BrowserOfflineError('invalid_method', 'Operación no permitida.')
  }
}
scope.onconnect = event => {
  const port = event.ports[0]
  ports.set(port, { seen: Date.now(), generation: null }); port.start()
  port.postMessage({ type: 'state', protocol: PROTOCOL, schema: WORKER_SCHEMA, build_id: buildID, state: publicState(engine.state(), null) })
  port.onmessage = event => {
    const request = event.data as WorkerRequest
    if (!request || request.protocol !== PROTOCOL || request.schema !== WORKER_SCHEMA || !request.id || !Array.isArray(request.args)) return
    const context = ports.get(port)
    if (!context) return
    context.seen = Date.now()
    if (request.method === 'heartbeat') return
    if (request.method === 'disconnect') {
      ports.delete(port); port.close(); if (![...ports.values()].some(item => item.generation === engine.state().generation)) engine.lock(); return
    }
    if (request.method === 'lock' || request.method === 'activity') {
      if (request.method === 'lock') engine.lock()
      else if (request.generation === engine.state().generation && context.generation === request.generation) engine.activity()
      port.postMessage({ type: 'result', id: request.id, protocol: PROTOCOL, schema: WORKER_SCHEMA, generation: engine.state().generation, result: undefined }); return
    }
    queue = queue.then(async () => {
      try {
        if (!ports.has(port)) return
        if (request.method.startsWith('gateway.') && context.generation !== engine.state().generation) throw new BrowserOfflineError('locked', 'Desbloquea esta pestaña para acceder a la copia offline.')
        if (request.method === 'selectAccount' && context.generation !== engine.state().generation) throw new BrowserOfflineError('locked', 'Vuelve a identificarte para elegir una cuenta.')
        const result = await dispatch(request)
        if (['prepare', 'unlock', 'unlockUser', 'selectAccount'].includes(request.method)) { context.generation = engine.state().generation; broadcast(engine.state()) }
        port.postMessage({ type: 'result', id: request.id, protocol: PROTOCOL, schema: WORKER_SCHEMA, generation: engine.state().generation, result })
      } catch (error) {
        port.postMessage({ type: 'result', id: request.id, protocol: PROTOCOL, schema: WORKER_SCHEMA, generation: engine.state().generation, error: { code: error instanceof BrowserOfflineError ? error.code : 'offline_failed', message: error instanceof Error ? error.message : 'No se pudo completar la operación.' } })
      }
    })
  }
}
scope.setInterval(() => {
  for (const [port, context] of ports) if (Date.now() - context.seen > 15000) { ports.delete(port); port.close() }
  if (![...ports.values()].some(item => item.generation === engine.state().generation) && engine.hasUnlockContext()) engine.lock()
  engine.checkIdle()
}, 5000)
