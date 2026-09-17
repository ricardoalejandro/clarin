/// <reference lib="webworker" />

import { OfflineV5Controller } from './controller'
import { OfflineV5Engine } from './engine'
import { OFFLINE_V5_IDLE_MS, OFFLINE_V5_PROTOCOL, OFFLINE_V5_SCHEMA, OfflineV5Error, type OfflineV5MutationInput, type OfflineV5RouteRequest, type OfflineV5WorkerRequest } from './types'

declare const __CLARIN_OFFLINE_BUILD__: string

const workerScope = globalThis as unknown as SharedWorkerGlobalScope
const buildID = typeof __CLARIN_OFFLINE_BUILD__ === 'undefined' ? 'development' : __CLARIN_OFFLINE_BUILD__
const controller = new OfflineV5Controller(new OfflineV5Engine(workerScope.location.origin))
const ports = new Map<string, { port: MessagePort; seenAt: number; chain: Promise<void> }>()

function postState(portID: string, state = controller.engine.sessions.snapshot(portID)) {
  ports.get(portID)?.port.postMessage({ type: 'state', protocol: OFFLINE_V5_PROTOCOL, schema: OFFLINE_V5_SCHEMA, build_id: buildID, state })
}

controller.engine.sessions.subscribe((portID, state) => postState(portID, state))

async function dispatch(portID: string, request: OfflineV5WorkerRequest): Promise<unknown> {
  switch (request.method) {
    case 'profile': return controller.profile()
    case 'enroll': return controller.enroll(String(request.args[0] || ''))
    case 'grants': return controller.grants()
    case 'selection': return controller.selection(String(request.args[0] || ''))
    case 'replaceSelection': return controller.replaceSelection(String(request.args[0] || ''), Number(request.args[1]), request.args[2] as never)
    case 'listLocalGrants': return controller.listLocalGrants()
    case 'hasAnyPreparedCopy': return controller.hasAnyPreparedCopy()
    case 'hasPreparedCopyForUsername': return controller.hasPreparedCopyForUsername(String(request.args[0] || ''))
    case 'refreshPreparedCopyAvailability': return controller.refreshPreparedCopyAvailability()
    case 'purgeLocalGrant': return controller.purgeLocalGrant(String(request.args[0] || ''))
    case 'reconcileLocalGrants': {
      if (!Array.isArray(request.args[1])) throw new OfflineV5Error('invalid_grant_reconciliation', 'No se pudo validar la limpieza de las copias offline anteriores.')
      return controller.reconcileLocalGrants(String(request.args[0] || ''), request.args[1] as string[])
    }
    case 'hasPreparedCopy': return controller.hasPreparedCopy(String(request.args[0] || ''), String(request.args[1] || ''))
    case 'prepare': {
      const persistent = await workerScope.navigator.storage?.persisted?.().catch(() => false) || false
      return controller.prepare(portID, String(request.args[0] || ''), String(request.args[1] || ''), persistent)
    }
    case 'unlockUser': return controller.unlockUser(portID, String(request.args[0] || ''), String(request.args[1] || ''), request.args[2] as { user_id?: string; account_id?: string } | undefined)
    case 'selectAccount': return controller.selectAccount(portID, String(request.args[0] || ''))
    case 'lock': return controller.lock(portID)
    case 'activity': return controller.engine.activity(portID, request.generation)
    case 'snapshot': return controller.engine.runtimeSnapshot(portID)
    case 'sync': return controller.sync(portID, request.generation)
    case 'route.request': return controller.routes.request(portID, request.generation, request.args[0] as OfflineV5RouteRequest)
    case 'data.aggregates': return controller.engine.aggregates(portID, request.generation, request.args[0] ? String(request.args[0]) : undefined)
    case 'data.overlays': return controller.engine.overlays(portID, request.generation, request.args[0] ? String(request.args[0]) : undefined)
    case 'data.mutate': return controller.engine.queueMutation(portID, request.generation, request.args[0] as OfflineV5MutationInput)
    case 'data.conflicts': return controller.engine.conflicts(portID, request.generation)
    case 'data.conflicts.acknowledge-server-wins': return controller.engine.acknowledgeServerWinsConflicts(portID, request.generation)
    case 'blob.put': return controller.engine.putBlob(portID, request.generation, request.args[0] as never)
    case 'blob.get': return controller.engine.getBlob(portID, request.generation, String(request.args[0] || ''))
    case 'blob.delete': return controller.engine.deleteBlob(portID, request.generation, String(request.args[0] || ''))
    default: throw new OfflineV5Error('invalid_method', 'La operación local no está permitida.')
  }
}

workerScope.onconnect = event => {
  const port = event.ports[0], portID = crypto.randomUUID()
  ports.set(portID, { port, seenAt: Date.now(), chain: Promise.resolve() })
  port.start()
  postState(portID)
  port.onmessage = event => {
    const request = event.data as OfflineV5WorkerRequest
    const context = ports.get(portID)
    if (!context || !request || request.protocol !== OFFLINE_V5_PROTOCOL || request.schema !== OFFLINE_V5_SCHEMA || !request.id || !Array.isArray(request.args)) return
    context.seenAt = Date.now()
    if (request.method === 'heartbeat') return
    if (request.method === 'disconnect') {
      controller.lock(portID); ports.delete(portID); port.close(); return
    }
    context.chain = context.chain.then(async () => {
      try {
        if (!ports.has(portID)) return
        const result = await dispatch(portID, request)
        port.postMessage({ type: 'result', id: request.id, protocol: OFFLINE_V5_PROTOCOL, schema: OFFLINE_V5_SCHEMA, generation: controller.engine.sessions.generation(portID), result })
      } catch (error) {
        port.postMessage({ type: 'result', id: request.id, protocol: OFFLINE_V5_PROTOCOL, schema: OFFLINE_V5_SCHEMA, generation: controller.engine.sessions.generation(portID), error: { code: error instanceof OfflineV5Error ? error.code : 'offline_failed', message: error instanceof Error ? error.message : 'No se pudo completar la operación local.' } })
      }
    })
  }
}

const invalidation = new BroadcastChannel('clarin-offline-v5-invalidate')
invalidation.onmessage = event => {
  if (event.data?.type !== 'invalidate') return
  void controller.engine.invalidateIdentity().finally(() => invalidation.postMessage({ type: 'invalidated', id: event.data.id }))
}

workerScope.setInterval(() => {
  // Background tabs routinely throttle timers for much longer than 15 seconds.
  // Use the product's real idle boundary instead of treating throttling as a
  // disconnected browser; the session registry independently locks on activity.
  for (const [portID, context] of ports) if (Date.now() - context.seenAt > OFFLINE_V5_IDLE_MS) {
    controller.lock(portID); ports.delete(portID); context.port.close()
  }
  controller.engine.sessions.checkIdle()
}, 5_000)

export {}
