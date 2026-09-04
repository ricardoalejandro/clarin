import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test'

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3011'
const now = '2026-08-25T12:00:00.000Z'
const environmentID = '31000000-0000-4000-8000-000000000001'
const secondaryEnvironmentID = '31000000-0000-4000-8000-000000000007'
const secondaryListID = '31000000-0000-4000-8000-000000000008'
const listID = '31000000-0000-4000-8000-000000000002'
const folderID = '31000000-0000-4000-8000-000000000003'
const childListID = '31000000-0000-4000-8000-000000000004'
const actorID = '31000000-0000-4000-8000-000000000005'
const personalLibraryID = '31000000-0000-4000-8000-000000000006'
const taskID = '31000000-0000-4000-8000-000000000009'
const taskStatus = {
  id: '31000000-0000-4000-8000-000000000010',
  account_id: 'account-work-whiteboards',
  workflow_id: 'workflow-qa',
  name: 'Por hacer',
  color: '#64748b',
  category: 'not_started',
  sort_order: 0,
  is_default: true,
  created_at: now,
  updated_at: now,
}

const fullPermissions = {
  level: 'full', can_view: true, can_comment: true, can_edit: true, can_delete: true,
  can_archive: true, can_trash: true, can_restore: true, can_manage_access: true,
  inherited_from: 'account_admin',
}

interface WorkWhiteboardState {
  views: Array<Record<string, any>>
  boards: Map<string, Record<string, any>>
  containerPermissions: typeof fullPermissions
  sequence: Map<string, number>
  failedWrites: boolean
  sceneWrites: number
  createdScopes: Array<{ scopeType: string; scopeID: string }>
  sockets: Set<{ send(message: string): void }>
  taskSockets: Set<{ send(message: string): void }>
  collabTicketReads: number
  workFeatureEnabled: boolean
  sceneAckDelayMS: number
  hideViewsFromLocationList: boolean
  locationListReads: number
  locationDetailReads: number
  locationListFailureStatus?: number
  locationListGate?: { promise: Promise<void>; release: () => void }
  permissionMetadataGate?: { promise: Promise<void>; release: () => void }
  permissionMetadataFailureStatus?: number
  environmentIndexReads: number
  environmentDetailReads: number
  environmentDetailCompletions: number
  environmentDetailGate?: { promise: Promise<void>; release: () => void }
  whiteboardReads: string[]
  whiteboardSocketConnections: number
  createGate?: { promise: Promise<void>; release: () => void }
  duplicateGate?: { promise: Promise<void>; release: () => void }
  trashGate?: { promise: Promise<void>; release: () => void }
  createRequests: number
  duplicateRequests: number
  trashRequests: number
  renameConflictOnce: boolean
  renamePayloads: Array<Record<string, any>>
  task?: Record<string, any>
}

function environment(permissions = fullPermissions, id = environmentID) {
  return {
    id, account_id: 'account-work-whiteboards', name: id === environmentID ? 'Entorno QA' : 'Entorno secundario', description: '', color: '#10b981', icon: 'layers', sort_order: 0,
    visibility: 'account', default_access_level: 'edit', is_default: true, version: 1, access_revision: 1, created_at: now, updated_at: now,
    folder_count: 1, list_count: 2, task_count: 0, permissions,
  }
}

function list(id: string, name: string, folderId?: string, permissions = fullPermissions) {
  return {
    id, account_id: 'account-work-whiteboards', environment_id: environmentID, folder_id: folderId,
    workflow_id: 'workflow-qa', workflow_inherited: Boolean(folderId),
    name, description: '', color: '#10b981', icon: 'list', sort_order: 1024,
    created_by: actorID, created_at: now, updated_at: now, task_count: 0, open_task_count: 0,
    completed_task_count: 0, cancelled_task_count: 0, permissions,
  }
}

function makeTask() {
  return {
    id: taskID,
    account_id: 'account-work-whiteboards',
    environment_id: environmentID,
    environment_name: 'Entorno QA',
    list_id: listID,
    list_name: 'Lista Operativa',
    created_by: actorID,
    assigned_to: actorID,
    assigned_to_name: 'QA Work',
    title: 'Tarea con detalle abierto',
    description: 'Contexto que debe cerrarse al abrir una pizarra contextual.',
    type: 'task',
    priority: 'medium',
    status: 'pending',
    status_id: taskStatus.id,
    status_detail: taskStatus,
    sort_order: 1024,
    progress: 0,
    progress_mode: 'manual',
    manual_progress: 0,
    progress_source: 'manual',
    subtask_done: 0,
    subtask_count: 0,
    start_at: null,
    due_at: null,
    version: 1,
    recurrence_rule: '',
    reminder_minutes: 0,
    notes: '',
    access_mode: 'inherit',
    effective_access_level: 'full',
    permissions: fullPermissions,
    collaborators: [],
    created_at: now,
    updated_at: now,
  }
}

function makeView(index: number, scopeType: 'list' | 'folder' = 'list', lifecycle = 'active') {
  const id = `32000000-0000-4000-8000-${String(index).padStart(12, '0')}`
  const boardID = `33000000-0000-4000-8000-${String(index).padStart(12, '0')}`
  const scopeID = scopeType === 'list' ? listID : folderID
  const scopeName = scopeType === 'list' ? 'Lista Operativa' : 'Carpeta Estratégica'
  return {
    id,
    type: 'whiteboard',
    environment_id: environmentID,
    scope: {
      scope_type: scopeType,
      scope_id: scopeID,
      scope_name: scopeName,
      breadcrumb: [
        { type: 'environment', id: environmentID, name: 'Entorno QA' },
        { type: scopeType, id: scopeID, name: scopeName },
      ],
    },
    sort_order: index * 1024,
    version: 1,
    access_revision: 1,
    lifecycle,
    created_by: actorID,
    deleted_at: lifecycle === 'trash' ? now : null,
    resource: {
      whiteboard: {
        id: boardID,
        name: scopeType === 'folder' ? 'Mapa de carpeta' : `Mapa operativo ${index}`,
        description: '',
        version: 1,
        scene_sequence: 0,
        updated_at: now,
        archived_at: lifecycle === 'trash' ? now : null,
      },
    },
    capabilities: {
      can_view: true,
      can_comment: lifecycle === 'active',
      can_edit: lifecycle === 'active',
      can_manage: lifecycle === 'active',
      can_manage_access: false,
    },
  }
}

function boardFromView(view: Record<string, any>) {
  const summary = view.resource.whiteboard
  return {
    ...summary,
    origin: 'work',
    work_location: {
      task_view_id: view.id,
      environment_id: environmentID,
      scope_type: view.scope.scope_type,
      scope_id: view.scope.scope_id,
      scope_name: view.scope.scope_name,
      breadcrumb: view.scope.breadcrumb,
      lifecycle: view.lifecycle,
    },
    owner_name: 'QA Work',
    updated_by_name: 'QA Work',
    shared: false,
    created_by: actorID,
    created_at: now,
    updated_at: now,
    access_mode: 'private',
    access_revision: view.access_revision,
    effective_access: {
      level: view.capabilities.can_manage ? 'manage' : 'view',
      inherited_from: 'work_location',
      can_view: true,
      can_comment: view.capabilities.can_comment,
      can_edit: view.capabilities.can_edit,
      can_delete: view.capabilities.can_manage,
      can_manage_access: false,
    },
  }
}

function initialState(): WorkWhiteboardState {
  const views = [1, 2, 3, 4, 5, 6].map(index => makeView(index))
  views.push(makeView(20, 'folder'))
  const boards = new Map(views.map(view => [view.resource.whiteboard.id, boardFromView(view)]))
  return {
    views,
    boards,
    containerPermissions: { ...fullPermissions },
    sequence: new Map(),
    failedWrites: false,
    sceneWrites: 0,
    createdScopes: [],
    sockets: new Set(),
    taskSockets: new Set(),
    collabTicketReads: 0,
    workFeatureEnabled: true,
    sceneAckDelayMS: 0,
    hideViewsFromLocationList: false,
    locationListReads: 0,
    locationDetailReads: 0,
    environmentIndexReads: 0,
    environmentDetailReads: 0,
    environmentDetailCompletions: 0,
    whiteboardReads: [],
    whiteboardSocketConnections: 0,
    createRequests: 0,
    duplicateRequests: 0,
    trashRequests: 0,
    renameConflictOnce: false,
    renamePayloads: [],
  }
}

function deferred() {
  let release = () => undefined
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

function transitionWorkView(state: WorkWhiteboardState, view: Record<string, any>, lifecycle: 'location_archived' | 'trash') {
  view.lifecycle = lifecycle
  view.access_revision += 1
  view.deleted_at = lifecycle === 'trash' ? now : null
  view.resource.whiteboard.archived_at = lifecycle === 'trash' ? now : null
  view.capabilities = { can_view: true, can_comment: false, can_edit: false, can_manage: false, can_manage_access: false }
  state.boards.set(view.resource.whiteboard.id, boardFromView(view))
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function installWorkWhiteboardMock(context: BrowserContext, state: WorkWhiteboardState) {
  await context.addCookies([{ name: 'auth-token', value: 'work-whiteboards-e2e', url: baseURL, httpOnly: true, sameSite: 'Lax' }])
  await context.addInitScript(() => {
    localStorage.setItem('token', 'work-whiteboards-e2e')
    localStorage.setItem('clarin:last_activity_at', String(Date.now()))
    localStorage.setItem('clarin:auth_refreshed_at', String(Date.now()))
  })
  await context.routeWebSocket(/\/ws(?:\/whiteboards\/[^?]+)?(?:\?.*)?$/, socket => {
    const url = new URL(socket.url())
    if (url.pathname === '/ws') {
      state.taskSockets.add(socket)
      socket.onClose(() => state.taskSockets.delete(socket))
      socket.onMessage(() => undefined)
      return
    }
    state.whiteboardSocketConnections += 1
    state.sockets.add(socket)
    socket.onClose(() => state.sockets.delete(socket))
    socket.onMessage(raw => {
      let message: Record<string, any>
      try { message = JSON.parse(String(raw)) } catch { return }
      if (message.event === 'sync.request') {
        socket.send(JSON.stringify({ event: 'ack', sequence: state.sequence.get(url.pathname) || 0 }))
        socket.send(JSON.stringify({ event: 'room.ready', actor: { kind: 'user', id: actorID, display_name: 'QA Work', access: 'edit' }, data: { actor_id: actorID } }))
        socket.send(JSON.stringify({ event: 'presence.snapshot', data: [{ kind: 'user', id: actorID, display_name: 'QA Work', access: 'edit' }] }))
        return
      }
      if (message.event !== 'scene.patch') return
      if (state.failedWrites) {
        socket.send(JSON.stringify({ event: 'error', code: 'whiteboard_internal_error', error: 'save_failed_for_test', operation_id: message.operation_id }))
        return
      }
      const acknowledge = () => {
        state.sceneWrites += 1
        const next = (state.sequence.get(url.pathname) || 0) + 1
        state.sequence.set(url.pathname, next)
        socket.send(JSON.stringify({ event: 'ack', sequence: next, operation_id: message.operation_id, data: { scene: { type: 'excalidraw', version: 2, source: 'clarin', elements: message.elements || [], appState: message.app_state || {}, files: {} } } }))
      }
      if (state.sceneAckDelayMS > 0) setTimeout(acknowledge, state.sceneAckDelayMS)
      else acknowledge()
    })
  })

  await context.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin !== new URL(baseURL).origin) {
      await route.abort('blockedbyclient')
      return
    }
    if (!url.pathname.startsWith('/api/')) {
      if (request.resourceType() === 'document' && process.env.PLAYWRIGHT_LOCAL_SERVER === '1') {
        const response = await route.fetch()
        const headers = response.headers()
        const csp = headers['content-security-policy']
        if (csp) headers['content-security-policy'] = csp.replace("script-src 'self' 'unsafe-inline'", "script-src 'self' 'unsafe-inline' 'unsafe-eval'")
        await route.fulfill({ response, headers })
        return
      }
      await route.continue()
      return
    }

    if (url.pathname === '/api/me') {
      await json(route, { success: true, user: { id: actorID, username: 'qa-work', display_name: 'QA Work', role: 'admin', is_admin: true, account_id: 'account-work-whiteboards', permissions: ['tasks', 'whiteboards'] }, accounts: [] })
      return
    }
    if (url.pathname === '/api/account/users') { await json(route, { success: true, users: [] }); return }
    if (url.pathname === '/api/tasks/environments') {
      state.environmentIndexReads += 1
      await json(route, { success: true, environments: [environment(state.containerPermissions)], next_cursor: null, can_create: true })
      return
    }
    const environmentDetailID = url.pathname.match(/^\/api\/tasks\/environments\/([^/]+)$/)?.[1]
    if (environmentDetailID && request.method() === 'GET') {
      state.environmentDetailReads += 1
      if (state.environmentDetailGate && environmentDetailID === secondaryEnvironmentID) await state.environmentDetailGate.promise
      try {
        await json(route, { success: true, environment: environment(state.containerPermissions, environmentDetailID) })
      } finally {
        state.environmentDetailCompletions += 1
      }
      return
    }
    if (url.pathname === `/api/tasks/environments/${environmentID}/folders`) {
      await json(route, { success: true, folders: [{
        id: folderID, account_id: 'account-work-whiteboards', environment_id: environmentID, workflow_id: 'workflow-qa', name: 'Carpeta Estratégica',
        description: '', color: '#8b5cf6', icon: 'folder', sort_order: 1024, created_by: actorID, created_at: now, updated_at: now,
        task_count: 0, open_task_count: 0, completed_task_count: 0, cancelled_task_count: 0, permissions: state.containerPermissions, lists: [],
      }], next_cursor: null })
      return
    }
    if (url.pathname === `/api/tasks/environments/${environmentID}/lists`) {
      const lists = url.searchParams.get('folder_id') === folderID ? [list(childListID, 'Lista de carpeta', folderID, state.containerPermissions)] : [list(listID, 'Lista Operativa', undefined, state.containerPermissions)]
      await json(route, { success: true, lists, next_cursor: null })
      return
    }
    if (url.pathname === '/api/tasks/workflows') {
      await json(route, { success: true, workflows: state.task ? [{ id: 'workflow-qa', account_id: 'account-work-whiteboards', environment_id: environmentID, name: 'Flujo QA', is_default: true, statuses: [taskStatus], created_by: actorID, created_at: now, updated_at: now }] : [] })
      return
    }
    if (url.pathname === '/api/tasks' && request.method() === 'GET') {
      const tasks = state.task ? [state.task] : []
      await json(route, { success: true, tasks, total: tasks.length, next_cursor: null })
      return
    }
    if (state.task && url.pathname === `/api/tasks/${state.task.id}` && request.method() === 'GET') { await json(route, { success: true, task: state.task }); return }
    if (state.task && url.pathname === `/api/tasks/${state.task.id}/children` && request.method() === 'GET') { await json(route, { success: true, tasks: [] }); return }
    if (state.task && url.pathname === `/api/tasks/${state.task.id}/comments` && request.method() === 'GET') { await json(route, { success: true, comments: [], total: 0, limit: 100, offset: 0, has_more: false }); return }
    if (state.task && url.pathname === `/api/tasks/${state.task.id}/activity` && request.method() === 'GET') { await json(route, { success: true, activity: [] }); return }
    if (state.task && url.pathname === `/api/tasks/${state.task.id}/attachments` && request.method() === 'GET') { await json(route, { success: true, attachments: [] }); return }
    if (state.task && url.pathname === `/api/tasks/${state.task.id}/dependencies` && request.method() === 'GET') { await json(route, { success: true, dependencies: [] }); return }

    const locationViewMatch = url.pathname.match(/^\/api\/tasks\/location-views\/([^/]+)$/)
    const duplicateMatch = url.pathname.match(/^\/api\/tasks\/location-views\/([^/]+)\/duplicate$/)
    const restoreMatch = url.pathname.match(/^\/api\/tasks\/location-views\/([^/]+)\/restore$/)
    if (url.pathname === '/api/tasks/location-views' && request.method() === 'GET') {
      state.locationListReads += 1
      if (state.locationListGate) {
        const gate = state.locationListGate
        state.locationListGate = undefined
        await gate.promise
      }
      if (state.locationListFailureStatus) {
        await json(route, { success: false, error: 'location_access_denied' }, state.locationListFailureStatus)
        return
      }
      if (!state.workFeatureEnabled) {
        await json(route, { success: true, feature_enabled: false, location_views: [], next_cursor: null })
        return
      }
      const scopeType = url.searchParams.get('scope_type')
      const scopeID = url.searchParams.get('scope_id')
      const visibleViews = state.hideViewsFromLocationList
        ? []
        : state.views.filter(view => view.lifecycle === 'active' && view.scope.scope_type === scopeType && view.scope.scope_id === scopeID)
      await json(route, { success: true, feature_enabled: true, location_views: visibleViews, next_cursor: null })
      return
    }
    if (url.pathname === '/api/tasks/location-views' && request.method() === 'POST') {
      if (!state.workFeatureEnabled) { await json(route, { success: false, error: 'work_whiteboard_views_disabled' }, 503); return }
      state.createRequests += 1
      const payload = request.postDataJSON() as Record<string, any>
      if (state.createGate) await state.createGate.promise
      const index = 100 + state.views.length
      const created = makeView(index, payload.scope_type)
      created.scope.scope_id = String(payload.scope_id)
      created.scope.scope_name = payload.scope_type === 'folder' ? 'Carpeta Estratégica' : 'Lista Operativa'
      created.resource.whiteboard.name = String(payload.name)
      state.views.push(created)
      state.boards.set(created.resource.whiteboard.id, boardFromView(created))
      state.createdScopes.push({ scopeType: String(payload.scope_type), scopeID: String(payload.scope_id) })
      await json(route, { success: true, location_view: created, idempotent: false }, 201)
      return
    }
    if (duplicateMatch && request.method() === 'POST') {
      if (!state.workFeatureEnabled) { await json(route, { success: false, error: 'work_whiteboard_views_disabled' }, 503); return }
      state.duplicateRequests += 1
      if (state.duplicateGate) await state.duplicateGate.promise
      const source = state.views.find(view => view.id === duplicateMatch[1])!
      const duplicate = makeView(200 + state.views.length, source.scope.scope_type)
      duplicate.scope = structuredClone(source.scope)
      duplicate.resource.whiteboard.name = `${source.resource.whiteboard.name} · copia`
      state.views.push(duplicate)
      state.boards.set(duplicate.resource.whiteboard.id, boardFromView(duplicate))
      await json(route, { success: true, location_view: duplicate, idempotent: false }, 201)
      return
    }
    if (restoreMatch && request.method() === 'POST') {
      if (!state.workFeatureEnabled) { await json(route, { success: false, error: 'work_whiteboard_views_disabled' }, 503); return }
      const view = state.views.find(item => item.id === restoreMatch[1])!
      view.lifecycle = 'active'
      view.deleted_at = null
      view.resource.whiteboard.archived_at = null
      state.boards.set(view.resource.whiteboard.id, boardFromView(view))
      await json(route, { success: true, location_view: view })
      return
    }
    if (locationViewMatch && request.method() === 'GET') {
      state.locationDetailReads += 1
      if (!state.workFeatureEnabled) { await json(route, { success: false, error: 'work_whiteboard_views_disabled', feature_enabled: false }, 503); return }
      const view = state.views.find(item => item.id === locationViewMatch[1])
      if (!view) { await json(route, { success: false, error: 'not_found' }, 404); return }
      await json(route, { success: true, feature_enabled: true, location_view: view })
      return
    }
    if (locationViewMatch && request.method() === 'PATCH') {
      if (!state.workFeatureEnabled) { await json(route, { success: false, error: 'work_whiteboard_views_disabled' }, 503); return }
      const view = state.views.find(item => item.id === locationViewMatch[1])!
      const payload = request.postDataJSON() as Record<string, any>
      state.renamePayloads.push(payload)
      if (state.renameConflictOnce) {
        state.renameConflictOnce = false
        view.resource.whiteboard.name = 'Nombre remoto simultáneo'
        view.version += 1
        state.boards.set(view.resource.whiteboard.id, boardFromView(view))
        await json(route, { success: false, error: 'version_conflict' }, 409)
        return
      }
      view.resource.whiteboard.name = String(payload.name)
      view.version += 1
      state.boards.set(view.resource.whiteboard.id, boardFromView(view))
      await json(route, { success: true, location_view: view })
      return
    }
    if (locationViewMatch && request.method() === 'DELETE') {
      if (!state.workFeatureEnabled) { await json(route, { success: false, error: 'work_whiteboard_views_disabled' }, 503); return }
      state.trashRequests += 1
      if (state.trashGate) await state.trashGate.promise
      const view = state.views.find(item => item.id === locationViewMatch[1])!
      view.lifecycle = 'trash'
      view.deleted_at = now
      view.resource.whiteboard.archived_at = now
      state.boards.set(view.resource.whiteboard.id, boardFromView(view))
      await json(route, { success: true, location_view: view })
      return
    }

    if (url.pathname === '/api/whiteboards' && request.method() === 'GET') {
      const wantsTrash = url.searchParams.get('scope') === 'trash'
      const wantsWork = url.searchParams.get('origin') === 'work'
      const whiteboards = [...state.boards.values()].filter(board => wantsTrash ? Boolean(board.archived_at) : !board.archived_at).filter(board => !wantsWork || board.origin === 'work')
      await json(route, { success: true, work_whiteboard_views_enabled: state.workFeatureEnabled, whiteboards: state.workFeatureEnabled ? whiteboards : whiteboards.filter(board => board.origin !== 'work'), next_cursor: null, permissions: { can_create: true, can_create_folder: true }, counts: { all: whiteboards.length, mine: whiteboards.length, shared: 0, recent: whiteboards.length, work: state.workFeatureEnabled ? whiteboards.length : 0, trash: [...state.boards.values()].filter(board => board.archived_at).length } })
      return
    }
    if (url.pathname === '/api/whiteboard-folders') { await json(route, { success: true, folders: [], next_cursor: null }); return }
    if (url.pathname === '/api/whiteboards/trash-policy') { await json(route, { success: true, retention_days: 30 }); return }
    const whiteboardMatch = url.pathname.match(/^\/api\/whiteboards\/([^/]+)$/)
    if (whiteboardMatch && request.method() === 'GET') {
      state.whiteboardReads.push(whiteboardMatch[1])
      if (state.permissionMetadataGate) {
        const gate = state.permissionMetadataGate
        await gate.promise
      }
      if (state.permissionMetadataFailureStatus) {
        await json(route, { success: false, error: 'permission_revalidation_failed' }, state.permissionMetadataFailureStatus)
        return
      }
      const board = state.boards.get(whiteboardMatch[1])
      if (!board) { await json(route, { success: false, error: 'not_found' }, 404); return }
      await json(route, { success: true, whiteboard: board })
      return
    }
    const sceneMatch = url.pathname.match(/^\/api\/whiteboards\/([^/]+)\/scene$/)
    if (sceneMatch && request.method() === 'GET') {
      await json(route, { success: true, scene: { board_id: sceneMatch[1], scene: { type: 'excalidraw', version: 2, source: 'clarin', elements: [], appState: { viewBackgroundColor: '#ffffff' }, files: {} }, scene_schema_version: 'excalidraw', editor_version: '0.18.1-clarin.6', sequence: 0, updated_at: now } })
      return
    }
    if (sceneMatch && ['PATCH', 'PUT'].includes(request.method())) {
      if (state.failedWrites) { await json(route, { success: false, error: 'save_failed_for_test' }, 503); return }
      state.sceneWrites += 1
      await json(route, { success: true, result: { scene: { board_id: sceneMatch[1], scene: request.postDataJSON()?.scene || {}, sequence: state.sceneWrites, updated_at: now } } })
      return
    }
    if (/^\/api\/whiteboards\/[^/]+\/assets$/.test(url.pathname)) { await json(route, { success: true, assets: [], next_cursor: null }); return }
    if (/^\/api\/whiteboards\/[^/]+\/collab-ticket$/.test(url.pathname)) { state.collabTicketReads += 1; await json(route, { success: true, ticket: `ticket-${actorID}` }, 201); return }
    if (/^\/api\/whiteboards\/[^/]+\/comment-markers$/.test(url.pathname)) { await json(route, { success: true, markers: [], next_cursor: null }); return }
    if (/^\/api\/whiteboards\/[^/]+\/comment-threads$/.test(url.pathname)) { await json(route, { success: true, threads: [], next_cursor: null, counts: { open: 0, resolved: 0, all: 0 } }); return }
    if (url.pathname === '/api/whiteboard-libraries') {
      await json(route, { success: true, libraries: [{ id: personalLibraryID, name: `Mi biblioteca · ${actorID}`, description: '', library_json: { libraryItems: [] }, visibility: 'private', version: 1, created_by: actorID, updated_by: actorID, created_at: now, updated_at: now }], next_cursor: null })
      return
    }
    if (url.pathname === '/api/tasks/stats') { await json(route, { success: true, stats: { overdue: 0, today: 0 } }); return }
    if (url.pathname === '/api/eros/status') { await json(route, { success: true, available: false }); return }
    if (url.pathname === '/api/version') { await json(route, { version: 'work-whiteboards-e2e' }); return }
    await json(route, { success: true })
  })
}

async function openWorkView(page: Page, viewID: string) {
  await page.goto(`${baseURL}/dashboard/tasks?work_view=${viewID}`, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.whiteboard-editor-shell')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('canvas.interactive')).toBeVisible({ timeout: 30_000 })
  const title = page.getByLabel('Nombre de la pizarra')
  if (await title.count()) await expect(title).toHaveAttribute('readonly', '')
  else {
    await page.getByTestId('main-menu-trigger').click()
    await expect(page.getByText('Compartir desde Clarin', { exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape')
  }
}

async function drawRectangle(page: Page) {
  const surface = page.locator('.whiteboard-editor-shell .excalidraw').first()
  const box = await surface.boundingBox()
  expect(box).not.toBeNull()
  const rectangleTool = page.getByTestId('toolbar-rectangle')
  // Excalidraw styles the radio through its visible label. Activating that
  // gesture owner matches a real pointer interaction and avoids bypassing the
  // editor's tool-selection handler through the hidden input.
  await rectangleTool.locator('xpath=ancestor::label[1]').click()
  await expect(rectangleTool).toBeChecked()
  await page.mouse.move(box!.x + box!.width * 0.45, box!.y + box!.height * 0.42)
  await page.mouse.down()
  await page.mouse.move(box!.x + box!.width * 0.55, box!.y + box!.height * 0.52, { steps: 5 })
  await page.mouse.up()
}

async function returnToTasks(page: Page) {
  const integratedReturn = page.getByLabel('Volver a las tareas')
  if (await integratedReturn.isVisible()) {
    await integratedReturn.click()
    return
  }
  await page.getByTestId('main-menu-trigger').click()
  await page.getByText('Volver a las tareas', { exact: true }).click()
}

async function selectWhiteboardHubScope(page: Page, scope: 'work' | 'trash') {
  const label = scope === 'work' ? 'Clarin Work' : 'Papelera'
  const navigation = page.getByRole('navigation', { name: 'Vistas y carpetas de Pizarras' })
  const openNavigation = page.getByRole('button', { name: 'Abrir navegación de Pizarras' })
  await expect.poll(async () => await navigation.isVisible() || await openNavigation.isVisible(), { timeout: 30_000 }).toBe(true)
  if (!await navigation.isVisible()) {
    await openNavigation.click()
    await expect(navigation).toBeVisible()
  }
  const loaded = page.waitForResponse(response => {
    const url = new URL(response.url())
    if (url.pathname !== '/api/whiteboards' || response.request().method() !== 'GET') return false
    return scope === 'work'
      ? url.searchParams.get('origin') === 'work'
      : url.searchParams.get('scope') === 'trash'
  })
  await navigation.getByRole('button', { name: new RegExp(`^${label}`) }).click()
  await loaded
  await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible()
}

test.describe.configure({ mode: 'serial' })
test.use({ serviceWorkers: 'block' })

test('Lista y Carpeta · añade varias vistas, conserva deep link, guardado y retorno', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'El flujo funcional determinista corre una vez; la suite de Pizarras conserva la matriz de motores.')
  // The editor is loaded dynamically and this flow deliberately exercises two
  // complete editor mounts plus three responsive remounts. Leave enough room
  // for cold CI compilation without turning individual assertions unbounded.
  test.setTimeout(240_000)
  const state = initialState()
  const context = await browser.newContext({ reducedMotion: 'reduce', hasTouch: true, viewport: { width: 1180, height: 820 } })
  await installWorkWhiteboardMock(context, state)
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  page.setDefaultNavigationTimeout(120_000)
  try {
    await page.goto(`${baseURL}/dashboard/tasks`, { waitUntil: 'domcontentloaded' })
    await page.locator(`[data-task-hierarchy-list="${listID}"]`).getByText('Lista Operativa').click()
    await expect(page.getByRole('button', { name: 'Vista', exact: true })).toBeEnabled()
    const moreViews = page.getByRole('button', { name: /Más \(/ })
    await expect(moreViews).toBeVisible()
    await moreViews.tap()
    await expect(page.getByRole('menu', { name: 'Vistas adicionales' })).toBeVisible()
    await page.getByRole('button', { name: 'Cerrar vistas adicionales' }).tap()
    await moreViews.focus()
    await page.keyboard.press('Enter')
    const overflowMenu = page.getByRole('menu', { name: 'Vistas adicionales' })
    const overflowItems = overflowMenu.getByRole('menuitem')
    await expect(overflowItems.first()).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(overflowItems.nth(1)).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(moreViews).toBeFocused()
    await page.getByRole('button', { name: 'Vista', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Añadir vista' })
    await expect(dialog.getByText('Pizarra', { exact: true })).toBeVisible()
    await dialog.getByPlaceholder('Ej. Mapa del proyecto').fill('Lienzo de lanzamiento')
    await dialog.getByRole('button', { name: 'Añadir pizarra' }).click()
    await expect(page).toHaveURL(/work_view=/)
    await expect(page.locator('.whiteboard-editor-shell')).toBeVisible({ timeout: 30_000 })
    expect(state.createdScopes.at(-1)).toEqual({ scopeType: 'list', scopeID: listID })

    const viewActions = page.getByRole('button', { name: 'Acciones de Lienzo de lanzamiento' })
    await viewActions.focus()
    await page.keyboard.press('Enter')
    const viewActionsMenu = page.getByRole('menu', { name: 'Acciones de Lienzo de lanzamiento' })
    await expect(viewActionsMenu.getByRole('menuitem', { name: 'Cambiar nombre' })).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(viewActionsMenu.getByRole('menuitem', { name: 'Duplicar' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(viewActions).toBeFocused()

    await drawRectangle(page)
    await returnToTasks(page)
    await expect(page).toHaveURL(`${baseURL}/dashboard/tasks`)
    expect(state.sceneWrites).toBeGreaterThan(0)

    await page.locator(`[data-task-drop-folder="${folderID}"]`).getByText('Carpeta Estratégica').click()
    await page.getByRole('button', { name: 'Vista', exact: true }).click()
    await dialog.getByPlaceholder('Ej. Mapa del proyecto').fill('Mapa de estrategia')
    await dialog.getByRole('button', { name: 'Añadir pizarra' }).click()
    expect(state.createdScopes.at(-1)).toEqual({ scopeType: 'folder', scopeID: folderID })
    await expect(page).toHaveURL(/work_view=/)
    await expect(page.locator('.whiteboard-editor-shell')).toBeVisible({ timeout: 30_000 })

    const activeID = new URL(page.url()).searchParams.get('work_view')!
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page).toHaveURL(new RegExp(`work_view=${activeID}`))
    await expect(page.locator('.whiteboard-editor-shell')).toBeVisible({ timeout: 30_000 })

    for (const width of [320, 768, 1440]) {
      await page.setViewportSize({ width, height: width === 320 ? 720 : 900 })
      await expect.poll(async () => {
        const box = await page.locator('.whiteboard-editor-shell').boundingBox()
        return Boolean(box && box.x >= -1 && box.x + box.width <= width + 1)
      }).toBe(true)
    }

    const erosTrigger = page.getByRole('button', { name: 'Abrir Eros' }).filter({ visible: true }).first()
    await erosTrigger.click()
    const eros = page.getByLabel('Asistente Eros')
    await expect(eros).toBeVisible()
    await expect(page.locator('.whiteboard-editor-shell')).toBeVisible()
    await expect.poll(async () => {
      const viewport = page.viewportSize()
      const board = await page.locator('.whiteboard-editor-shell').boundingBox()
      const assistant = await eros.boundingBox()
      return Boolean(viewport && board && assistant
        && board.x >= -1 && board.x + board.width <= viewport.width + 1
        && assistant.x >= -1 && assistant.x + assistant.width <= viewport.width + 1)
    }).toBe(true)
    const collapseSidebar = page.getByTitle('Colapsar menú')
    await collapseSidebar.click()
    await expect(page.locator('.whiteboard-editor-shell')).toBeVisible()
  } finally {
    await context.close()
  }
})

test('deep link · una respuesta tardía no reemplaza la vista elegida con atrás/adelante', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium')
  test.setTimeout(120_000)
  const state = initialState()
  const slowView = state.views[0]
  const currentView = state.views[1]
  slowView.environment_id = secondaryEnvironmentID
  slowView.scope.scope_id = secondaryListID
  slowView.scope.scope_name = 'Lista secundaria'
  slowView.scope.breadcrumb = [
    { type: 'environment', id: secondaryEnvironmentID, name: 'Entorno secundario' },
    { type: 'list', id: secondaryListID, name: 'Lista secundaria' },
  ]
  state.environmentDetailGate = deferred()
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  await installWorkWhiteboardMock(context, state)
  const page = await context.newPage()
  try {
    await page.goto(`${baseURL}/dashboard/tasks?work_view=${slowView.id}`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('[data-task-workspace-width]')).toBeVisible({ timeout: 30_000 })
    await expect(page).toHaveURL(new RegExp(`work_view=${slowView.id}`))
    await expect.poll(() => state.locationDetailReads, { timeout: 30_000 }).toBeGreaterThanOrEqual(1)
    await expect.poll(() => state.environmentDetailReads, { timeout: 30_000 }).toBeGreaterThanOrEqual(1)

    await page.evaluate(viewID => {
      const url = new URL(window.location.href)
      url.searchParams.set('work_view', viewID)
      window.history.pushState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }, currentView.id)
    await expect(page).toHaveURL(new RegExp(`work_view=${currentView.id}`))
    await expect(page.locator('.whiteboard-editor-shell')).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => state.whiteboardReads.at(-1), { timeout: 30_000 }).toBe(currentView.resource.whiteboard.id)

    state.environmentDetailGate.release()
    await expect.poll(() => state.environmentDetailCompletions, { timeout: 30_000 }).toBeGreaterThanOrEqual(1)
    await page.waitForTimeout(250)
    await expect.poll(() => new URL(page.url()).searchParams.get('work_view')).toBe(currentView.id)
    expect(state.whiteboardReads.at(-1)).toBe(currentView.resource.whiteboard.id)
  } finally {
    state.environmentDetailGate?.release()
    await context.close()
  }
})

test('deep link · una navegación local cancela la pizarra que aún está cargando', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium')
  test.setTimeout(120_000)
  const state = initialState()
  const slowView = state.views[0]
  slowView.environment_id = secondaryEnvironmentID
  slowView.scope.scope_id = secondaryListID
  slowView.scope.scope_name = 'Lista secundaria'
  slowView.scope.breadcrumb = [
    { type: 'environment', id: secondaryEnvironmentID, name: 'Entorno secundario' },
    { type: 'list', id: secondaryListID, name: 'Lista secundaria' },
  ]
  state.environmentDetailGate = deferred()
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  await installWorkWhiteboardMock(context, state)
  const page = await context.newPage()
  try {
    await page.goto(`${baseURL}/dashboard/tasks?work_view=${slowView.id}`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('[data-task-workspace-width]')).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => state.environmentDetailReads, { timeout: 30_000 }).toBeGreaterThanOrEqual(1)
    const localList = page.locator(`[data-task-hierarchy-list="${listID}"]`).getByText('Lista Operativa')
    await expect(localList).toBeVisible({ timeout: 30_000 })
    await localList.click()
    await expect.poll(() => new URL(page.url()).searchParams.get('work_view')).toBeNull()

    state.environmentDetailGate.release()
    await expect.poll(() => state.environmentDetailCompletions, { timeout: 30_000 }).toBeGreaterThanOrEqual(1)
    await page.waitForTimeout(250)
    await expect.poll(() => new URL(page.url()).searchParams.get('work_view')).toBeNull()
    await expect(page.locator('.whiteboard-editor-shell')).toBeHidden()
    await expect(page.locator(`[data-task-hierarchy-list="${listID}"]`).locator('button').first()).toHaveClass(/font-semibold/)
  } finally {
    state.environmentDetailGate?.release()
    await context.close()
  }
})

test('renombrado abierto · un 409 adopta la versión canónica, conserva el editor y permite reintentar', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium')
  test.setTimeout(150_000)
  const state = initialState()
  state.renameConflictOnce = true
  const source = state.views[0]
  const context = await browser.newContext({ viewport: { width: 1700, height: 900 } })
  await installWorkWhiteboardMock(context, state)
  const page = await context.newPage()
  try {
    await openWorkView(page, source.id)
    const integratedTitle = page.getByLabel('Nombre de la pizarra')
    await expect(integratedTitle).toHaveValue(source.resource.whiteboard.name)
    await page.evaluate(() => {
      (window as typeof window & { __workWhiteboardShell?: Element | null }).__workWhiteboardShell = document.querySelector('.whiteboard-editor-shell')
    })
    const connectionsBeforeRename = state.whiteboardSocketConnections

    await page.getByRole('button', { name: `Acciones de ${source.resource.whiteboard.name}` }).click()
    await page.getByRole('menu', { name: `Acciones de ${source.resource.whiteboard.name}` }).getByRole('menuitem', { name: 'Cambiar nombre' }).click()
    const dialog = page.getByRole('dialog', { name: 'Cambiar nombre' })
    await dialog.getByPlaceholder('Ej. Mapa del proyecto').fill('Nombre final confirmado')
    await dialog.getByRole('button', { name: 'Guardar nombre' }).click()

    await expect(dialog.getByRole('alert')).toContainText(/cambió en otra sesión/i)
    await expect(integratedTitle).toHaveValue('Nombre remoto simultáneo')
    await expect(dialog.getByPlaceholder('Ej. Mapa del proyecto')).toHaveValue('Nombre final confirmado')
    expect(state.renamePayloads[0]).toMatchObject({ expected_version: 1, name: 'Nombre final confirmado' })
    expect(await page.evaluate(() => (
      (window as typeof window & { __workWhiteboardShell?: Element | null }).__workWhiteboardShell
      === document.querySelector('.whiteboard-editor-shell')
    ))).toBe(true)
    expect(state.whiteboardSocketConnections).toBe(connectionsBeforeRename)

    await dialog.getByRole('button', { name: 'Guardar nombre' }).click()
    await expect(dialog).toBeHidden()
    await expect(integratedTitle).toHaveValue('Nombre final confirmado')
    await expect(page.getByRole('button', { name: 'Acciones de Nombre final confirmado' })).toBeVisible()
    expect(state.renamePayloads).toHaveLength(2)
    expect(state.renamePayloads.map(payload => payload.expected_version)).toEqual([1, 2])
    expect(state.renamePayloads[1].operation_id).toBe(state.renamePayloads[0].operation_id)
    expect(await page.evaluate(() => (
      (window as typeof window & { __workWhiteboardShell?: Element | null }).__workWhiteboardShell
      === document.querySelector('.whiteboard-editor-shell')
    ))).toBe(true)
    expect(state.whiteboardSocketConnections).toBe(connectionsBeforeRename)
    await expect(page.locator('canvas.interactive')).toBeVisible()
  } finally {
    await context.close()
  }
})

test('carreras de mutación · create, duplicate y trash tardíos no cambian la nueva ubicación', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium')
  test.setTimeout(240_000)
  const state = initialState()
  const context = await browser.newContext({ viewport: { width: 1440, height: 860 } })
  await installWorkWhiteboardMock(context, state)
  const page = await context.newPage()
  const folderLabel = () => page.locator(`[data-task-drop-folder="${folderID}"]`).getByText('Carpeta Estratégica', { exact: true })
  try {
    await page.goto(`${baseURL}/dashboard/tasks`, { waitUntil: 'domcontentloaded' })
    await page.locator(`[data-task-hierarchy-list="${listID}"]`).getByText('Lista Operativa', { exact: true }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Lista Operativa' })).toBeVisible()

    state.createGate = deferred()
    await page.getByRole('button', { name: 'Vista', exact: true }).click()
    const createDialog = page.getByRole('dialog', { name: 'Añadir vista' })
    await createDialog.getByPlaceholder('Ej. Mapa del proyecto').fill('Creación tardía de Lista')
    await createDialog.getByRole('button', { name: 'Añadir pizarra' }).click()
    await expect.poll(() => state.createRequests).toBe(1)
    await folderLabel().evaluate(element => (element as HTMLElement).click())
    await expect(page.getByRole('heading', { level: 1, name: 'Carpeta Estratégica' })).toBeVisible()
    state.createGate.release()
    await expect(createDialog).toBeHidden()
    await expect.poll(() => new URL(page.url()).searchParams.get('work_view')).toBeNull()
    await expect(page.getByText('Creación tardía de Lista', { exact: true })).toHaveCount(0)
    expect(state.createdScopes.at(-1)).toEqual({ scopeType: 'list', scopeID: listID })

    await openWorkView(page, state.views[0].id)
    state.duplicateGate = deferred()
    await page.getByRole('button', { name: `Acciones de ${state.views[0].resource.whiteboard.name}` }).click()
    await page.getByRole('menu', { name: `Acciones de ${state.views[0].resource.whiteboard.name}` }).getByRole('menuitem', { name: 'Duplicar' }).click()
    await expect.poll(() => state.duplicateRequests).toBe(1)
    await folderLabel().evaluate(element => (element as HTMLElement).click())
    await expect(page.getByRole('heading', { level: 1, name: 'Carpeta Estratégica' })).toBeVisible()
    await expect(page.locator('.whiteboard-editor-shell')).toBeHidden()
    state.duplicateGate.release()
    await expect.poll(() => state.views.some(view => view.resource.whiteboard.name === 'Mapa operativo 1 · copia')).toBe(true)
    await expect.poll(() => new URL(page.url()).searchParams.get('work_view')).toBeNull()
    await expect(page.getByText('Mapa operativo 1 · copia', { exact: true })).toHaveCount(0)

    await openWorkView(page, state.views[0].id)
    state.trashGate = deferred()
    await page.getByRole('button', { name: `Acciones de ${state.views[0].resource.whiteboard.name}` }).click()
    await page.getByRole('menu', { name: `Acciones de ${state.views[0].resource.whiteboard.name}` }).getByRole('menuitem', { name: 'Mover a Papelera' }).click()
    const trashDialog = page.getByRole('dialog', { name: 'Mover pizarra a Papelera' })
    await trashDialog.getByRole('button', { name: 'Mover a Papelera' }).click()
    await expect.poll(() => state.trashRequests).toBe(1)
    await folderLabel().evaluate(element => (element as HTMLElement).click())
    await expect(page.getByRole('heading', { level: 1, name: 'Carpeta Estratégica' })).toBeVisible()
    await expect(page.locator('.whiteboard-editor-shell')).toBeHidden()
    state.trashGate.release()
    await expect(trashDialog).toBeHidden()
    await expect.poll(() => state.views[0].lifecycle).toBe('trash')
    await expect.poll(() => new URL(page.url()).searchParams.get('work_view')).toBeNull()
    await expect(page.getByRole('heading', { level: 1, name: 'Carpeta Estratégica' })).toBeVisible()
  } finally {
    state.createGate?.release()
    state.duplicateGate?.release()
    state.trashGate?.release()
    await context.close()
  }
})

test('creación desde una Lista · cierra TaskDetail antes de montar la pizarra', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium')
  test.setTimeout(150_000)
  const state = initialState()
  state.task = makeTask()
  const context = await browser.newContext({ viewport: { width: 1800, height: 900 } })
  await installWorkWhiteboardMock(context, state)
  const page = await context.newPage()
  try {
    await page.goto(`${baseURL}/dashboard/tasks?task=${taskID}`, { waitUntil: 'domcontentloaded' })
    const taskDetail = page.locator('[data-task-detail-window][aria-label="Detalle de tarea"]')
    await expect(taskDetail).toBeVisible({ timeout: 30_000 })
    await expect(taskDetail.getByText('Tarea con detalle abierto', { exact: true }).first()).toBeVisible()

    await page.locator(`[data-task-hierarchy-list="${listID}"]`).getByText('Lista Operativa', { exact: true }).evaluate(element => (element as HTMLElement).click())
    await expect(page.getByRole('heading', { level: 1, name: 'Lista Operativa' })).toBeVisible()
    await expect(taskDetail).toBeVisible()
    await page.getByRole('button', { name: 'Vista', exact: true }).click()
    const createDialog = page.getByRole('dialog', { name: 'Añadir vista' })
    await createDialog.getByPlaceholder('Ej. Mapa del proyecto').fill('Pizarra desde detalle')
    await createDialog.getByRole('button', { name: 'Añadir pizarra' }).click()

    await expect(taskDetail).toBeHidden()
    await expect(page.locator('.whiteboard-editor-shell')).toBeVisible({ timeout: 30_000 })
    await expect(page).toHaveURL(/work_view=/)
    expect(new URL(page.url()).searchParams.get('task')).toBeNull()
    expect(state.createdScopes.at(-1)).toEqual({ scopeType: 'list', scopeID: listID })
  } finally {
    await context.close()
  }
})

test('salida fallida · conserva la pizarra y expone una decisión accionable', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium')
  test.setTimeout(120_000)
  const state = initialState()
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  await installWorkWhiteboardMock(context, state)
  const page = await context.newPage()
  try {
    await openWorkView(page, state.views[0].id)
    state.failedWrites = true
    await drawRectangle(page)

    const createdBeforeBlockedAdd = state.createdScopes.length
    await page.getByRole('button', { name: 'Vista', exact: true }).click()
    const addDialog = page.getByRole('dialog', { name: 'Añadir vista' })
    await addDialog.getByPlaceholder('Ej. Mapa del proyecto').fill('No debe crearse')
    const addPrompt = page.waitForEvent('dialog')
    await addDialog.getByRole('button', { name: 'Añadir pizarra' }).click()
    const addConfirmation = await addPrompt
    expect(addConfirmation.message()).toContain('no pudo confirmar todos los cambios')
    await addConfirmation.dismiss()
    expect(state.createdScopes).toHaveLength(createdBeforeBlockedAdd)
    await expect(page).toHaveURL(new RegExp(`work_view=${state.views[0].id}`))
    await expect(page.locator('.whiteboard-editor-shell')).toBeVisible()
    await addDialog.getByRole('button', { name: 'Cancelar' }).click()

    const prompt = page.waitForEvent('dialog')
    await page.getByRole('button', { name: 'Lista', exact: true }).click()
    const dialog = await prompt
    expect(dialog.message()).toContain('no pudo confirmar todos los cambios')
    await dialog.dismiss()
    await expect(page).toHaveURL(new RegExp(`work_view=${state.views[0].id}`))
    await expect(page.locator('.whiteboard-editor-shell')).toBeVisible()
  } finally {
    await context.close()
  }
})

test('ciclo de vida del padre · confirma guardado antes de Archivo y oculta de inmediato ante Papelera o revocación', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium')
  test.setTimeout(180_000)

  const archiveState = initialState()
  archiveState.sceneAckDelayMS = 800
  const archiveContext = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  await installWorkWhiteboardMock(archiveContext, archiveState)
  const archivePage = await archiveContext.newPage()
  try {
    await openWorkView(archivePage, archiveState.views[0].id)
    await expect.poll(() => archiveState.taskSockets.size).toBeGreaterThan(0)
    await drawRectangle(archivePage)
    const ticketsBeforeArchive = archiveState.collabTicketReads
    transitionWorkView(archiveState, archiveState.views[0], 'location_archived')
    for (const socket of archiveState.taskSockets) socket.send(JSON.stringify({
      event: 'task_update',
      data: { action: 'list_archived', target_type: 'list', target_id: listID, list_id: listID },
    }))
    await expect(archivePage.locator('[data-task-location-view-security-block]')).toBeVisible()
    const archivedNotice = archivePage.locator('.whiteboard-canvas-notice')
    await expect(archivedNotice).toHaveCount(1, { timeout: 30_000 })
    await expect(archivedNotice).toContainText(/ubicación está archivada/i)
    expect(archiveState.sceneWrites).toBeGreaterThan(0)
    expect(archiveState.collabTicketReads).toBe(ticketsBeforeArchive)
  } finally {
    await archiveContext.close()
  }

  const blockedState = initialState()
  blockedState.failedWrites = true
  const blockedContext = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  await installWorkWhiteboardMock(blockedContext, blockedState)
  const blockedPage = await blockedContext.newPage()
  try {
    await openWorkView(blockedPage, blockedState.views[0].id)
    await expect.poll(() => blockedState.taskSockets.size).toBeGreaterThan(0)
    await drawRectangle(blockedPage)
    transitionWorkView(blockedState, blockedState.views[0], 'trash')
    let forcedDialogs = 0
    blockedPage.on('dialog', dialog => { forcedDialogs += 1; void dialog.dismiss() })
    for (const socket of blockedState.taskSockets) socket.send(JSON.stringify({
      event: 'task_update',
      data: { action: 'list_trashed', target_type: 'list', target_id: listID, list_id: listID },
    }))
    await expect(blockedPage.locator('.whiteboard-editor-shell')).toBeHidden({ timeout: 10_000 })
    await expect(blockedPage).not.toHaveURL(/work_view=/)
    await expect(blockedPage.getByText(/Papelera.*ocultamos el lienzo inmediatamente/i)).toBeVisible()
    expect(forcedDialogs).toBe(0)
  } finally {
    await blockedContext.close()
  }

  const revokedState = initialState()
  revokedState.sceneAckDelayMS = 900
  const revokedContext = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  await installWorkWhiteboardMock(revokedContext, revokedState)
  const revokedPage = await revokedContext.newPage()
  try {
    await openWorkView(revokedPage, revokedState.views[0].id)
    await expect.poll(() => revokedState.taskSockets.size).toBeGreaterThan(0)
    await drawRectangle(revokedPage)
    let forcedDialogs = 0
    revokedPage.on('dialog', dialog => { forcedDialogs += 1; void dialog.dismiss() })
    for (const socket of revokedState.taskSockets) socket.send(JSON.stringify({
      event: 'task_update',
      data: { action: 'access_revoked', target_type: 'list', target_id: listID },
    }))
    await expect(revokedPage.locator('[data-task-location-view-security-block]')).toBeVisible()
    await expect(revokedPage.locator('.whiteboard-editor-shell')).toBeHidden({ timeout: 10_000 })
    await expect(revokedPage).not.toHaveURL(/work_view=/)
    await expect(revokedPage.getByText(/acceso a la ubicación.*cambió/i)).toBeVisible()
    expect(forcedDialogs).toBe(0)
  } finally {
    await revokedContext.close()
  }
})

test('reconciliación de listado · un 403 oculta contenido protegido y declara cambios no confirmados', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium')
  test.setTimeout(150_000)
  const state = initialState()
  state.failedWrites = true
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  await installWorkWhiteboardMock(context, state)
  const page = await context.newPage()
  try {
    await openWorkView(page, state.views[0].id)
    await expect.poll(() => state.taskSockets.size).toBeGreaterThan(0)
    await drawRectangle(page)
    const gate = deferred()
    const readsBeforeRevalidation = state.locationListReads
    state.locationListGate = gate
    state.locationListFailureStatus = 403
    let forcedDialogs = 0
    page.on('dialog', dialog => { forcedDialogs += 1; void dialog.dismiss() })
    const securityBlockObserved = page.evaluate(() => new Promise<boolean>(resolve => {
      if (document.querySelector('[data-task-location-view-security-block]')) { resolve(true); return }
      const observer = new MutationObserver(() => {
        if (!document.querySelector('[data-task-location-view-security-block]')) return
        observer.disconnect()
        window.clearTimeout(timeout)
        resolve(true)
      })
      const timeout = window.setTimeout(() => { observer.disconnect(); resolve(false) }, 5_000)
      observer.observe(document.body, { childList: true, subtree: true })
    }))
    for (const socket of state.taskSockets) socket.send(JSON.stringify({
      event: 'task_update',
      data: { action: 'whiteboard_hub_changed' },
    }))
    await expect.poll(() => state.locationListReads).toBeGreaterThan(readsBeforeRevalidation)
    gate.release()
    expect(await securityBlockObserved).toBe(true)
    await expect(page.locator('.whiteboard-editor-shell')).toBeHidden({ timeout: 10_000 })
    await expect(page).not.toHaveURL(/work_view=/)
    await expect(page.getByText(/Ya no tienes acceso.*Ocultamos el contenido inmediatamente/i)).toBeVisible()
    expect(forcedDialogs).toBe(0)
  } finally {
    state.locationListGate?.release()
    await context.close()
  }
})

test('Hub y Papelera · la misma pizarra abre Work y nunca ofrece moverla a carpetas físicas', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium')
  test.setTimeout(process.env.WHITEBOARD_CATALOG_CAPTURE_DIR ? 180_000 : 90_000)
  const state = initialState()
  const trashed = makeView(90, 'list', 'trash')
  state.views.push(trashed)
  state.boards.set(trashed.resource.whiteboard.id, boardFromView(trashed))
  const standaloneID = '33000000-0000-4000-8000-000000000091'
  state.boards.set(standaloneID, {
    ...boardFromView(state.views[0]),
    id: standaloneID,
    name: 'Mapa autónomo compartido',
    origin: 'standalone',
    work_location: null,
    shared: true,
    folder_id: null,
    folder_name: null,
    effective_access: {
      level: 'view', inherited_from: 'share', can_view: true, can_comment: false,
      can_edit: false, can_delete: false, can_manage_access: false,
    },
  })
  const context = await browser.newContext({ viewport: { width: 1100, height: 780 } })
  await installWorkWhiteboardMock(context, state)
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  page.setDefaultNavigationTimeout(120_000)
  try {
    await page.goto(`${baseURL}/dashboard/whiteboards`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Vista de lista' }).click()
    await expect.poll(() => page.evaluate(() => localStorage.getItem('clarin.whiteboards.view.v1'))).toBe('list')
    const mixedRows = [
      page.locator(`[data-whiteboard-id="${standaloneID}"]`),
      page.locator(`[data-whiteboard-id="${state.views[0].resource.whiteboard.id}"]`),
    ]
    await expect(mixedRows[0]).toBeVisible()
    await expect(mixedRows[1]).toBeVisible()
    for (const slot of ['drag', 'thumbnail', 'identity', 'location', 'actions']) {
      const positions = await Promise.all(mixedRows.map(row => row.locator(`[data-whiteboard-slot="${slot}"]`).boundingBox()))
      expect(positions[0]).not.toBeNull()
      expect(positions[1]).not.toBeNull()
      expect(Math.abs(positions[0]!.x - positions[1]!.x)).toBeLessThanOrEqual(1)
    }
    await expect(mixedRows[1].getByText('Clarin Work', { exact: true })).toHaveCount(1)
    await expect(mixedRows[1].getByText('Entorno QA / Lista Operativa', { exact: true })).toHaveCount(1)
    await expect(mixedRows[1].getByText('Abrir ubicación', { exact: true })).toHaveCount(1)
    await expect(mixedRows[0].getByRole('button', { name: /Cambiar carpeta/ })).toHaveCount(0)

    const captureDir = process.env.WHITEBOARD_CATALOG_CAPTURE_DIR
    if (captureDir) {
      const viewports = [
        { width: 320, height: 720 },
        { width: 375, height: 812 },
        { width: 768, height: 860 },
        { width: 1024, height: 768 },
        { width: 1280, height: 800 },
        { width: 1440, height: 900 },
        { width: 1671, height: 831 },
      ]
      for (const viewport of viewports) {
        await page.setViewportSize(viewport)
        await expect(mixedRows[1]).toBeVisible()
        await page.waitForTimeout(250)
        await page.screenshot({ path: `${captureDir}/pizarras-lista-${viewport.width}.png` })
      }

      await page.getByRole('button', { name: 'Vista compacta' }).click()
      await page.screenshot({ path: `${captureDir}/pizarras-compacta-1671.png` })
      await page.getByRole('button', { name: 'Vista de cuadrícula' }).click()
      await page.screenshot({ path: `${captureDir}/pizarras-cuadricula-1671.png` })
      await page.getByRole('button', { name: 'Vista de lista' }).click()

      await page.getByRole('button', { name: 'Colapsar menú' }).click()
      await page.screenshot({ path: `${captureDir}/pizarras-sidebar-colapsado-1671.png` })
      await page.getByRole('button', { name: 'Expandir menú' }).click()
      await page.getByRole('button', { name: 'Abrir Eros' }).click()
      const eros = page.locator('[aria-label="Asistente Eros"]')
      await expect(eros).toBeVisible()
      const dockEros = eros.getByTitle('Acoplar a la derecha')
      if (await dockEros.isVisible()) await dockEros.click()
      await page.screenshot({ path: `${captureDir}/pizarras-eros-acoplado-1671.png` })
      await eros.getByTitle('Cerrar').click()
    }

    await page.getByRole('button', { name: 'Vista compacta' }).click()
    await selectWhiteboardHubScope(page, 'work')
    const workCard = page.locator(`[data-whiteboard-id="${state.views[0].resource.whiteboard.id}"]`)
    await expect(workCard.getByText('Clarin Work', { exact: true })).toBeVisible()
    const workLocationLink = workCard.locator(`a[href="/dashboard/tasks?work_view=${state.views[0].id}"]`)
    await expect(workLocationLink).toBeVisible()
    await expect(workLocationLink).toHaveAttribute('aria-label', /Abrir ubicación en Work · Mapa operativo 1 · Entorno QA \/ Lista Operativa/)
    await expect(workCard.getByRole('button', { name: /Cambiar carpeta/ })).toHaveCount(0)
    await workCard.getByRole('button', { name: 'Abrir Mapa operativo 1' }).click()
    await expect(page.locator('.whiteboard-editor-shell')).toBeVisible({ timeout: 30_000 })
    const title = page.getByLabel('Nombre de la pizarra')
    if (await title.count()) await expect(title).toHaveAttribute('readonly', '')
    await page.getByTestId('main-menu-trigger').click()
    await expect(page.getByText('Compartir desde Clarin', { exact: true })).toHaveCount(0)
    await page.getByText('Volver a Pizarras', { exact: true }).click()
    await expect(page).toHaveURL(`${baseURL}/dashboard/whiteboards`)
    await selectWhiteboardHubScope(page, 'work')
    const reopenedWorkCard = page.locator(`[data-whiteboard-id="${state.views[0].resource.whiteboard.id}"]`)
    await reopenedWorkCard.locator(`a[href="/dashboard/tasks?work_view=${state.views[0].id}"]`).click()
    await expect(page).toHaveURL(new RegExp(`/dashboard/tasks\\?work_view=${state.views[0].id}`))

    await page.goto(`${baseURL}/dashboard/whiteboards`, { waitUntil: 'domcontentloaded' })
    await selectWhiteboardHubScope(page, 'trash')
    const trashCard = page.locator(`[data-whiteboard-id="${trashed.resource.whiteboard.id}"]`)
    await expect(trashCard.getByText(/Ubicación original/)).toBeVisible()
    await expect(trashCard.getByRole('link', { name: 'Abrir ubicación en Work' })).toHaveCount(0)
  } finally {
    await context.close()
  }
})

test('Archivo · carga escena e historial en solo lectura sin pedir ticket ni abrir sala', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium')
  test.setTimeout(150_000)
  const state = initialState()
  const historical = makeView(80, 'list', 'location_archived')
  state.views.push(historical)
  state.boards.set(historical.resource.whiteboard.id, boardFromView(historical))
  const context = await browser.newContext({ viewport: { width: 1180, height: 780 } })
  await installWorkWhiteboardMock(context, state)
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  page.setDefaultNavigationTimeout(60_000)
  try {
    await openWorkView(page, historical.id)
    const historicalNotice = page.locator('.whiteboard-canvas-notice')
    await expect(historicalNotice).toHaveCount(1)
    await expect(historicalNotice).toContainText(/ubicación está archivada/i)
    await expect(page.getByText('Solo lectura', { exact: true })).toBeVisible()
    const canvasBox = await page.locator('[data-task-workspace-canvas]').boundingBox()
    const editorBox = await page.locator('.whiteboard-editor-shell').boundingBox()
    expect(canvasBox).not.toBeNull()
    expect(editorBox).not.toBeNull()
    expect(editorBox!.y + editorBox!.height).toBeLessThanOrEqual(canvasBox!.y + canvasBox!.height + 1)
    await page.getByRole('button', { name: 'Más acciones de Pizarras' }).click()
    await page.getByRole('menu', { name: 'Más acciones de Pizarras' }).getByRole('menuitem', { name: 'Historial', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    expect(state.collabTicketReads).toBe(0)
    expect(state.sockets.size).toBe(0)
    expect(state.sceneWrites).toBe(0)
  } finally {
    await context.close()
  }
})

test('access_changed · refresca capacidades de ubicación y retira controles administrativos', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium')
  test.setTimeout(120_000)
  const state = initialState()
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  await installWorkWhiteboardMock(context, state)
  const page = await context.newPage()
  try {
    await openWorkView(page, state.views[0].id)
    await expect.poll(() => state.taskSockets.size).toBeGreaterThan(0)
    await expect(page.getByRole('button', { name: `Acciones de ${state.views[0].resource.whiteboard.name}` })).toBeVisible()
    const readsBefore = state.locationListReads

    state.containerPermissions = {
      ...fullPermissions,
      level: 'view',
      can_comment: false,
      can_edit: false,
      can_delete: false,
      can_archive: false,
      can_trash: false,
      can_restore: false,
      can_manage_access: false,
    }
    state.views[0].access_revision += 1
    state.views[0].capabilities = {
      can_view: true,
      can_comment: false,
      can_edit: false,
      can_manage: false,
      can_manage_access: false,
    }
    state.boards.set(state.views[0].resource.whiteboard.id, boardFromView(state.views[0]))
    for (const socket of state.taskSockets) socket.send(JSON.stringify({
      event: 'task_update',
      data: { action: 'access_changed', target_type: 'list', target_id: listID },
    }))

    await expect.poll(() => state.locationListReads).toBeGreaterThan(readsBefore)
    await expect(page.getByRole('button', { name: `Acciones de ${state.views[0].resource.whiteboard.name}` })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Vista', exact: true })).toBeDisabled()
    await expect(page.locator('.whiteboard-editor-shell')).toBeVisible()
  } finally {
    await context.close()
  }
})

test('kill switch · apaga endpoints Work, cierra la pizarra activa y la oculta del Hub', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium')
  test.setTimeout(120_000)
  const state = initialState()
  const context = await browser.newContext({ viewport: { width: 1100, height: 760 } })
  await installWorkWhiteboardMock(context, state)
  const page = await context.newPage()
  try {
    await openWorkView(page, state.views[0].id)
    await expect.poll(() => state.taskSockets.size).toBeGreaterThan(0)
    const listReadsBeforeDisable = state.locationListReads
    state.workFeatureEnabled = false
    for (const socket of state.taskSockets) socket.send(JSON.stringify({
      event: 'task_update',
      data: { action: 'whiteboard_hub_changed' },
    }))
    await expect.poll(() => state.locationListReads).toBeGreaterThan(listReadsBeforeDisable)
    await expect(page.locator('.whiteboard-editor-shell')).toBeHidden({ timeout: 20_000 })
    await expect(page).not.toHaveURL(/work_view=/)
    await expect(page.getByRole('button', { name: 'Vista', exact: true })).toHaveCount(0)

    await page.goto(`${baseURL}/dashboard/tasks?work_view=${state.views[0].id}`, { waitUntil: 'domcontentloaded' })
    await expect.poll(() => state.locationDetailReads).toBeGreaterThan(0)
    await expect(page.locator('.whiteboard-editor-shell')).toBeHidden()
    await expect(page).not.toHaveURL(/work_view=/)

    await page.goto(`${baseURL}/dashboard/whiteboards`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Mis pizarras' })).toBeVisible()
    await expect(page.getByRole('button', { name: /Clarin Work/ })).toHaveCount(0)
    await expect(page.locator(`[data-whiteboard-id="${state.views[0].resource.whiteboard.id}"]`)).toHaveCount(0)
  } finally {
    await context.close()
  }
})

test('dos sesiones · una revocación cierra el lienzo contextual sin convertirlo en standalone', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium')
  test.setTimeout(120_000)
  const state = initialState()
  const firstContext = await browser.newContext()
  const secondContext = await browser.newContext()
  await Promise.all([installWorkWhiteboardMock(firstContext, state), installWorkWhiteboardMock(secondContext, state)])
  const first = await firstContext.newPage()
  const second = await secondContext.newPage()
  try {
    await Promise.all([openWorkView(first, state.views[0].id), openWorkView(second, state.views[0].id)])
    const permissionGate = deferred()
    state.permissionMetadataGate = permissionGate
    for (const socket of state.sockets) socket.send(JSON.stringify({ event: 'access.revoked', code: 'work_access_changed' }))
    await expect(first.locator('[data-whiteboard-permission-revalidating]')).toBeVisible()
    permissionGate.release()
    await expect(first.locator('[data-whiteboard-permission-revalidating]')).toBeHidden()
    await expect(first.locator('.whiteboard-editor-shell')).toBeVisible()
    await expect(second.locator('.whiteboard-editor-shell')).toBeVisible()

    const failureGate = deferred()
    state.permissionMetadataGate = failureGate
    state.permissionMetadataFailureStatus = 503
    for (const socket of state.sockets) socket.send(JSON.stringify({ event: 'access.revoked', code: 'work_access_changed' }))
    await expect(first.locator('[data-whiteboard-permission-revalidating]')).toBeVisible()
    failureGate.release()
    await expect(first.locator('.whiteboard-editor-shell')).toBeHidden({ timeout: 10_000 })
    await expect(first.getByText(/Por seguridad ocultamos el lienzo/i)).toBeVisible()
    state.permissionMetadataGate = undefined
    state.permissionMetadataFailureStatus = undefined
    await first.getByRole('button', { name: 'Reintentar' }).click()
    await expect(first.locator('.whiteboard-editor-shell')).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => state.sockets.size, { timeout: 10_000 }).toBeGreaterThan(0)

    state.boards.delete(state.views[0].resource.whiteboard.id)
    for (const socket of state.sockets) socket.send(JSON.stringify({ event: 'access.revoked', code: 'work_access_changed' }))
    await expect(first.locator('.whiteboard-editor-shell')).toBeHidden({ timeout: 20_000 })
    await expect(second.locator('.whiteboard-editor-shell')).toBeHidden({ timeout: 20_000 })
    await expect(first).not.toHaveURL(/dashboard\/whiteboards\//)
    await expect(first.getByText(/revocado|dejó de estar disponible/i)).toBeVisible()
  } finally {
    await Promise.allSettled([firstContext.close(), secondContext.close()])
  }
})
