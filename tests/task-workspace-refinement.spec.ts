import { expect, test, type Locator, type Page, type Route } from '@playwright/test'

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3011'
const now = '2026-07-30T12:00:00.000Z'

const todoStatus = { id: 'status-todo', account_id: 'account-work', workflow_id: 'workflow-main', name: 'Por hacer', color: '#64748b', category: 'not_started', sort_order: 0, is_default: true, created_at: now, updated_at: now }
const activeStatus = { id: 'status-active', account_id: 'account-work', workflow_id: 'workflow-main', name: 'En curso', color: '#3b82f6', category: 'active', sort_order: 1, is_default: false, created_at: now, updated_at: now }
const doneStatus = { id: 'status-done', account_id: 'account-work', workflow_id: 'workflow-main', name: 'Completada', color: '#10b981', category: 'done', sort_order: 2, is_default: false, created_at: now, updated_at: now }
const statuses = [todoStatus, activeStatus, doneStatus]
const fullPermissions = { level: 'full' as const, can_view: true, can_comment: true, can_edit: true, can_delete: true, can_manage_access: true, inherited_from: 'account_admin' as const }
const viewPermissions = { level: 'view' as const, can_view: true, can_comment: false, can_edit: false, can_delete: false, can_manage_access: false, inherited_from: 'task_grant' as const }

function list(id: string, name: string, folderId = '', order = 1024, taskCount = 0, isDefault = false) {
  return { id, account_id: 'account-work', environment_id: 'env-work', folder_id: folderId || undefined, workflow_id: 'workflow-main', workflow_inherited: Boolean(folderId), is_default: isDefault, name, description: '', color: isDefault ? '#10b981' : '#3b82f6', icon: isDefault ? 'inbox' : 'list', sort_order: order, created_by: 'user-owner', created_at: now, updated_at: now, task_count: taskCount, open_task_count: taskCount, completed_task_count: 0, cancelled_task_count: 0, permissions: fullPermissions }
}

function makeTask() {
  return {
    id: 'task-refinement', account_id: 'account-work', created_by: 'user-owner', assigned_to: 'user-owner', assigned_to_name: 'Ricardo Rojas',
    title: 'Preparar propuesta profesional', description: '', type: 'reminder', priority: 'medium', status: 'pending', status_id: todoStatus.id,
    status_detail: todoStatus, list_id: 'list-work', list_name: 'Trabajo principal', sort_order: 1024, progress: 0,
    progress_mode: 'manual', manual_progress: 0, progress_source: 'manual', subtask_done: 0, subtask_count: 0,
    start_at: '2026-07-30T09:00:00.000Z', due_at: '2026-08-01T09:00:00.000Z', version: 1,
    recurrence_rule: '', reminder_minutes: 0, notes: '', created_at: now, updated_at: now,
    environment_id: 'env-work', environment_name: 'General', access_mode: 'inherit' as const, effective_access_level: 'full' as const, permissions: fullPermissions,
    collaborators: [{ user_id: 'user-admin', display_name: 'Administrador', username: 'admin', created_at: now }],
  }
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function installWorkspaceMock(page: Page) {
  let task = makeTask()
  let createdTasks: ReturnType<typeof makeTask>[] = []
  let workspaceSocket: { send(message: string): void } | undefined
  let trashTasks = [{ ...makeTask(), id: 'task-trash', title: 'Tarea eliminada explícitamente', deleted_at: '2026-06-20T12:00:00.000Z', version: 4 }]
  let trashRetentionDays: number | null = 30
  let trashContainers = [{ id: 'list-trash', type: 'list' as const, name: 'Lista archivada', color: '#3b82f6', icon: 'list', archived_at: '2026-06-20T12:00:00.000Z', original_folder_name: 'Cliente Alfa', list_count: 0, task_count: 0, next_eligible_at: '2026-07-20T12:00:00.000Z', can_purge: true, restore_blocked: false }]
  let hierarchy = {
    folders: [{
      id: 'folder-client', account_id: 'account-work', workflow_id: 'workflow-main', name: 'Cliente Alfa', description: '', color: '#8b5cf6', sort_order: 1024,
      environment_id: 'env-work', icon: 'folder', created_by: 'user-owner', created_at: now, updated_at: now, task_count: 0, open_task_count: 0, completed_task_count: 0, cancelled_task_count: 0, permissions: fullPermissions, lists: [list('list-folder', 'Lista de carpeta', 'folder-client', 1024)],
    }, {
      id: 'folder-beta', account_id: 'account-work', workflow_id: 'workflow-main', name: 'Cliente Beta', description: '', color: '#f59e0b', sort_order: 2048,
      environment_id: 'env-work', icon: 'folder', created_by: 'user-owner', created_at: now, updated_at: now, task_count: 0, open_task_count: 0, completed_task_count: 0, cancelled_task_count: 0, permissions: fullPermissions, lists: [],
    }],
    root_lists: [list('list-default', 'Bandeja general', '', 0, 0, true), list('list-work', 'Trabajo principal', '', 2048, 1)],
  }
  const privateEnvironment = {
    id: 'env-private', account_id: 'account-work', name: 'Privado remoto', description: 'Entorno fuera de la primera página', color: '#7c3aed', icon: 'lock', sort_order: 2048,
    visibility: 'restricted' as const, default_access_level: 'none' as const, is_default: false, version: 2, access_revision: 4, created_at: now, updated_at: now,
    folder_count: 1, list_count: 2, task_count: 1, permissions: fullPermissions,
  }
  const privateFolder = {
    id: 'folder-private', account_id: 'account-work', environment_id: privateEnvironment.id, workflow_id: 'workflow-main', name: 'Carpeta reservada', description: '', color: '#7c3aed', sort_order: 1024,
    icon: 'folder', created_by: 'user-owner', created_at: now, updated_at: now, task_count: 1, open_task_count: 1, completed_task_count: 0, cancelled_task_count: 0, lists: [],
  }
  const privateDefaultList = { ...list('list-private-default', 'Bandeja privada', '', 0, 0, true), environment_id: privateEnvironment.id, permissions: fullPermissions }
  const privateRemoteList = { ...list('list-private-remote', 'Lista remota especial', privateFolder.id, 1024, 1), environment_id: privateEnvironment.id, permissions: fullPermissions }
  const sharedTask = {
    ...makeTask(), id: 'task-shared-private', title: 'Tarea privada compartida', list_id: 'list-secret', list_name: 'Lista secreta', folder_id: 'folder-secret', folder_name: 'Carpeta secreta',
    environment_id: 'env-work', environment_name: 'General', breadcrumbs_visible: false, access_mode: 'private' as const, effective_access_level: 'view' as const,
    permissions: viewPermissions, collaborators: [],
  }
  let sharedResources = [{ id: sharedTask.id, type: 'task', name: sharedTask.title, color: '#7c3aed', icon: 'task', effective_access_level: 'view' }]
  const sharedResourceReads: string[] = []
  const structureWrites: Array<Record<string, unknown>> = []
  const folderStructureWrites: Array<{ folderId: string; body: Record<string, unknown> }> = []
  const appearanceWrites: Array<{ path: string; body: Record<string, unknown> }> = []
  const collaboratorWrites: Array<Record<string, unknown>> = []
  const taskWrites: Array<Record<string, unknown>> = []
  const createWrites: Array<Record<string, unknown>> = []
  const folderCreateWrites: Array<Record<string, unknown>> = []
  const bulkMoves: Array<Record<string, unknown>> = []
  const bulkUpdates: Array<Record<string, unknown>> = []
  const taskQueries: Array<{ search: string; at: number; sharedWithMe: boolean; environmentId: string }> = []
  const environmentWrites: Array<Record<string, unknown>> = []
  let generalEnvironmentName = 'General'
  let structureRefreshDelayMs = 0
  const structureRefreshCompletions: string[] = []
  const environmentDetailReads: string[] = []
  const remoteListQueries: Array<{ search: string; cursor: string; at: number }> = []
  const remoteFolderQueries: Array<{ limit: string; at: number }> = []
  const attachmentUploads: Array<{ taskId: string; filename: string }> = []
  const trashWrites: Array<{ path: string; method: string; body: Record<string, unknown> }> = []
  const attachmentCommentWrites: Array<Record<string, unknown>> = []
  const attachmentCommentMutations: Array<{ method: string; body: Record<string, unknown> }> = []
  const textAttachment = {
    id: 'attachment-text', account_id: 'account-work', task_id: 'task-refinement', media_asset_id: 'asset-text',
    filename: 'notas-operativas.txt', content_type: 'text/plain', media_type: 'document', size_bytes: 76,
    url: '/api/media/file/account-work/notas-operativas.txt', uploaded_by: 'user-owner', created_at: now,
  }
  let attachmentComments: Array<Record<string, unknown>> = []
  let failNextDescriptionWrite = false
  let failNextAttachmentUpload = false
  let failNextCreateStatus = 0
  let requireNextBulkParticipantGrant = false
  let createDelayMs = 0

  await page.routeWebSocket('**/ws**', socket => { workspaceSocket = socket; socket.onMessage(() => undefined) })
  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    let body: Record<string, unknown> = {}
    try { body = request.postDataJSON() } catch { body = {} }

    if (path === '/api/me') {
      await json(route, { success: true, user: { id: 'user-owner', username: 'ricardo', display_name: 'Ricardo Rojas', role: 'admin', is_admin: true, account_id: 'account-work', permissions: ['tasks'] }, accounts: [] })
      return
    }
    if (path === '/api/tasks/environments') {
      const general = { id: 'env-work', account_id: 'account-work', name: generalEnvironmentName, description: '', color: '#10b981', icon: 'layers', sort_order: 0, visibility: 'account', default_access_level: 'edit', is_default: true, version: 1, access_revision: 1, created_at: now, updated_at: now, folder_count: hierarchy.folders.length, list_count: hierarchy.root_lists.length + hierarchy.folders.flatMap(folder => folder.lists).length, task_count: 1, permissions: fullPermissions }
      const search = (url.searchParams.get('search') || '').toLocaleLowerCase()
      const environments = search ? [general, privateEnvironment].filter(environment => environment.name.toLocaleLowerCase().includes(search)) : [general]
      await json(route, { success: true, environments, next_cursor: search ? null : 'environment-page-2', can_create: true })
      return
    }
    if (path === '/api/tasks/environments/env-work' && request.method() === 'PATCH') {
      environmentWrites.push(body)
      generalEnvironmentName = String(body.name || generalEnvironmentName)
      await json(route, { success: true, environment: { id: 'env-work', account_id: 'account-work', name: generalEnvironmentName, description: String(body.description || ''), color: String(body.color || '#10b981'), icon: String(body.icon || 'layers'), sort_order: 0, visibility: 'account', default_access_level: 'edit', is_default: true, version: 2, access_revision: 1, created_at: now, updated_at: now, folder_count: hierarchy.folders.length, list_count: hierarchy.root_lists.length + hierarchy.folders.flatMap(folder => folder.lists).length, task_count: 1, permissions: fullPermissions } })
      return
    }
    if (path === `/api/tasks/environments/${privateEnvironment.id}`) {
      environmentDetailReads.push(privateEnvironment.id)
      await json(route, { success: true, environment: privateEnvironment })
      return
    }
    if (path === '/api/tasks/environments/env-work/folders') {
      if (structureRefreshDelayMs) {
        await new Promise(resolve => setTimeout(resolve, structureRefreshDelayMs))
        structureRefreshCompletions.push('folders')
      }
      await json(route, { success: true, folders: hierarchy.folders.map(folder => ({ ...folder, environment_id: 'env-work', lists: [] })), next_cursor: null })
      return
    }
    if (path === '/api/tasks/environments/env-work/lists') {
      if (structureRefreshDelayMs) {
        await new Promise(resolve => setTimeout(resolve, structureRefreshDelayMs))
        structureRefreshCompletions.push('lists')
      }
      const folderID = url.searchParams.get('folder_id')
      const scope = url.searchParams.get('scope')
      const source = scope === 'all'
        ? [...hierarchy.root_lists, ...hierarchy.folders.flatMap(folder => folder.lists)]
        : folderID
          ? hierarchy.folders.find(folder => folder.id === folderID)?.lists || []
          : hierarchy.root_lists
      const search = (url.searchParams.get('search') || '').toLocaleLowerCase()
      await json(route, { success: true, lists: source.filter(item => !search || item.name.toLocaleLowerCase().includes(search)).map(item => ({ ...item, environment_id: 'env-work', permissions: fullPermissions })), next_cursor: null })
      return
    }
    if (path === '/api/tasks/folders' && request.method() === 'POST') {
      folderCreateWrites.push(body)
      const folder = { id: `folder-created-${hierarchy.folders.length}`, account_id: 'account-work', environment_id: 'env-work', workflow_id: 'workflow-main', name: String(body.name), description: '', color: String(body.color || '#64748b'), icon: String(body.icon || 'folder'), sort_order: (hierarchy.folders.length + 1) * 1024, created_by: 'user-owner', created_at: now, updated_at: now, task_count: 0, open_task_count: 0, completed_task_count: 0, cancelled_task_count: 0, access_mode: 'inherit', access_revision: 1, permissions: fullPermissions, lists: [] }
      hierarchy = { ...hierarchy, folders: [...hierarchy.folders, folder] }
      structureRefreshDelayMs = 2_500
      await json(route, { success: true, folder }, 201)
      return
    }
    if (path === '/api/tasks/lists' && request.method() === 'POST') {
      const createdList = { ...list(`list-created-${hierarchy.root_lists.length}`, String(body.name), String(body.folder_id || ''), 4096), access_mode: 'inherit' as const, access_revision: 1 }
      hierarchy = body.folder_id
        ? { ...hierarchy, folders: hierarchy.folders.map(folder => folder.id === body.folder_id ? { ...folder, lists: [...folder.lists, createdList] } : folder) }
        : { ...hierarchy, root_lists: [...hierarchy.root_lists, createdList] }
      structureRefreshDelayMs = 2_500
      await json(route, { success: true, list: createdList }, 201)
      return
    }
    if (path === '/api/tasks/environments/env-work/shared-resources') {
      sharedResourceReads.push('env-work')
      await json(route, { success: true, items: sharedResources, next_cursor: null })
      return
    }
    if (path === `/api/tasks/environments/${privateEnvironment.id}/folders`) {
      remoteFolderQueries.push({ limit: url.searchParams.get('limit') || '', at: Date.now() })
      await json(route, { success: true, folders: [privateFolder], next_cursor: null })
      return
    }
    if (path === `/api/tasks/environments/${privateEnvironment.id}/lists`) {
      const search = (url.searchParams.get('search') || '').toLocaleLowerCase()
      const cursor = url.searchParams.get('cursor') || ''
      remoteListQueries.push({ search, cursor, at: Date.now() })
      if (url.searchParams.get('scope') === 'all' && search === 'especial' && !cursor) {
        await json(route, { success: true, lists: [], next_cursor: 'remote-list-page-2' })
        return
      }
      const lists = cursor === 'remote-list-page-2'
        ? [privateRemoteList]
        : url.searchParams.get('folder_id') === privateFolder.id
          ? [privateRemoteList]
          : [privateDefaultList]
      await json(route, { success: true, lists, next_cursor: null })
      return
    }
    if (path === '/api/tasks/hierarchy') { await json(route, hierarchy); return }
    if (path === '/api/tasks/trash-policy' && request.method() === 'GET') { await json(route, { success: true, retention_days: trashRetentionDays, can_manage: true }); return }
    if (path === '/api/tasks/trash-policy' && request.method() === 'PUT') { trashWrites.push({ path, method: request.method(), body }); trashRetentionDays = body.retention_days === null ? null : Number(body.retention_days); await json(route, { success: true, retention_days: trashRetentionDays, can_manage: true }); return }
    if (path === '/api/tasks/trash/containers') { await json(route, { success: true, containers: trashContainers }); return }
    if (path === '/api/tasks/workflows') { await json(route, { workflows: [{ id: 'workflow-main', account_id: 'account-work', name: 'Flujo principal', is_default: true, created_by: 'user-owner', created_at: now, updated_at: now, statuses }] }); return }
    if (path === '/api/account/users') {
      await json(route, { users: [
        { id: 'user-owner', username: 'ricardo', display_name: 'Ricardo Rojas', role: 'Administrador' },
        { id: 'user-admin', username: 'admin', display_name: 'Administrador', role: 'Administrador' },
        { id: 'user-analyst', username: 'analista', display_name: 'Ana Analista', role: 'Analista' },
      ] })
      return
    }
    if (path === '/api/tasks/saved-views') { await json(route, { views: [] }); return }
    if (path === '/api/tasks/stats') { await json(route, { pending: 1, completed: 0, overdue: 0, cancelled: 0, today: 0 }); return }
    if (path === '/api/tasks' && request.method() === 'GET') {
      const search = (url.searchParams.get('search') || '').toLocaleLowerCase()
      const sharedWithMe = url.searchParams.get('shared_with_me') === 'true'
      const environmentId = url.searchParams.get('environment_id') || ''
      taskQueries.push({ search, at: Date.now(), sharedWithMe, environmentId })
      const requestedListID = url.searchParams.get('list_id') || ''
      const requestedFolderID = url.searchParams.get('folder_id') || ''
      const activeItems = [task, ...createdTasks].filter(item => {
        if (search && !`${item.title} ${item.description}`.toLocaleLowerCase().includes(search)) return false
        if (requestedListID && item.list_id !== requestedListID) return false
        if (requestedFolderID && item.folder_id !== requestedFolderID) return false
        return true
      })
      const items = url.searchParams.get('deleted') === 'true'
        ? trashTasks
        : sharedWithMe
          ? [sharedTask]
          : environmentId === privateEnvironment.id
            ? []
            : activeItems
      await json(route, { tasks: items, total: items.length, next_cursor: null, has_more: false }); return
    }
    if (path === '/api/tasks/gantt' && request.method() === 'GET') {
      await json(route, { tasks: [task], dependencies: [], critical_task_ids: [], slack_minutes: {}, unscheduled_count: 0 }); return
    }

    if (path === `/api/tasks/${task.id}` && request.method() === 'DELETE') { trashWrites.push({ path, method: request.method(), body }); await json(route, { success: true, task: { ...task, deleted_at: now, version: task.version + 1 }, version: task.version + 1 }); return }
    if (path === '/api/tasks/task-trash/restore' && request.method() === 'POST') { trashWrites.push({ path, method: request.method(), body }); trashTasks = []; await json(route, { success: true, task: { ...makeTask(), id: 'task-trash' } }); return }
    if (path === '/api/tasks/task-trash/purge' && request.method() === 'DELETE') { trashWrites.push({ path, method: request.method(), body }); trashTasks = []; await json(route, { success: true, purged: { tasks: 1, lists: 0, folders: 0 } }); return }
    if (path === '/api/tasks/lists/list-trash/restore' && request.method() === 'POST') { trashWrites.push({ path, method: request.method(), body }); trashContainers = []; await json(route, { success: true }); return }
    if (path === '/api/tasks/lists/list-trash/purge' && request.method() === 'DELETE') { trashWrites.push({ path, method: request.method(), body }); trashContainers = []; await json(route, { success: true, purged: { tasks: 0, lists: 1, folders: 0 } }); return }

    const structureMatch = path.match(/^\/api\/tasks\/lists\/([^/]+)\/structure$/)
    if (structureMatch && request.method() === 'PUT') {
      if (!Object.prototype.hasOwnProperty.call(body, 'folder_id') && !Object.prototype.hasOwnProperty.call(body, 'before_list_id')) {
        appearanceWrites.push({ path, body })
        const update = (item: ReturnType<typeof list>) => item.id === structureMatch[1] ? { ...item, ...body } : item
        hierarchy = { folders: hierarchy.folders.map(folder => ({ ...folder, lists: folder.lists.map(update) })), root_lists: hierarchy.root_lists.map(update) }
        await json(route, { success: true, hierarchy })
        return
      }
      structureWrites.push(body)
      const moving = [...hierarchy.root_lists, ...hierarchy.folders.flatMap(folder => folder.lists)].find(item => item.id === structureMatch[1])!
      const targetFolderID = typeof body.folder_id === 'string' ? body.folder_id : ''
      hierarchy = {
        folders: hierarchy.folders.map(folder => ({ ...folder, lists: [...folder.lists.filter(item => item.id !== moving.id), ...(folder.id === targetFolderID ? [{ ...moving, folder_id: folder.id, workflow_inherited: true, sort_order: 2048 }] : [])] })),
        root_lists: [...hierarchy.root_lists.filter(item => item.id !== moving.id), ...(!targetFolderID ? [{ ...moving, folder_id: undefined, workflow_inherited: true, sort_order: 2048 }] : [])],
      }
      await json(route, { success: true, hierarchy, operation_id: body.operation_id })
      return
    }

    const folderStructureMatch = path.match(/^\/api\/tasks\/folders\/([^/]+)\/structure$/)
    if (folderStructureMatch && request.method() === 'PUT') {
      folderStructureWrites.push({ folderId: folderStructureMatch[1], body })
      const moving = hierarchy.folders.find(folder => folder.id === folderStructureMatch[1])!
      const rest = hierarchy.folders.filter(folder => folder.id !== moving.id)
      const anchor = typeof body.before_folder_id === 'string' ? rest.findIndex(folder => folder.id === body.before_folder_id) : -1
      const index = anchor >= 0 ? anchor : rest.length
      hierarchy = { ...hierarchy, folders: [...rest.slice(0, index), moving, ...rest.slice(index)].map((folder, position) => ({ ...folder, sort_order: (position + 1) * 1024 })) }
      await json(route, { success: true, hierarchy, operation_id: body.operation_id })
      return
    }

    const folderUpdateMatch = path.match(/^\/api\/tasks\/folders\/([^/]+)$/)
    if (folderUpdateMatch && request.method() === 'PUT') {
      appearanceWrites.push({ path, body })
      hierarchy = { ...hierarchy, folders: hierarchy.folders.map(folder => folder.id === folderUpdateMatch[1] ? { ...folder, ...body } : folder) }
      await json(route, { success: true })
      return
    }

    if (path === `/api/tasks/${task.id}/collaborators` && request.method() === 'PUT') {
      collaboratorWrites.push(body)
      const userIds = body.user_ids as string[]
      task = {
        ...task,
        version: task.version + 1,
        collaborators: userIds.map(id => id === 'user-admin'
          ? { user_id: id, display_name: 'Administrador', username: 'admin', created_at: now }
          : { user_id: id, display_name: 'Ana Analista', username: 'analista', created_at: now }),
      }
      const { collaborators: _omitted, ...taskWithoutCollaborators } = task
      await json(route, { task: taskWithoutCollaborators, collaborators: task.collaborators, version: task.version })
      return
    }
    if (path === `/api/tasks/${task.id}` && request.method() === 'PUT') {
      taskWrites.push(body)
      if (failNextDescriptionWrite && Object.prototype.hasOwnProperty.call(body, 'description')) {
        failNextDescriptionWrite = false
        await json(route, { error: 'No pudimos guardar la descripción.' }, 500)
        return
      }
      const status = statuses.find(item => item.id === body.status_id)
      task = { ...task, ...body, version: task.version + 1, ...(status ? { status_id: status.id, status_detail: status } : {}) }
      await json(route, { task })
      return
    }
    if (path === '/api/tasks' && request.method() === 'POST') {
      createWrites.push(body)
      if (failNextCreateStatus) {
        const status = failNextCreateStatus
        failNextCreateStatus = 0
        await json(route, { error: status === 409 ? 'La tarea cambió mientras se estaba creando.' : 'No se pudo crear la tarea.' }, status)
        return
      }
      const created = { ...makeTask(), ...body, id: `task-created-${createdTasks.length + 1}`, title: String(body.title || ''), version: 1, collaborators: [] }
      createdTasks = [created, ...createdTasks]
      if (createDelayMs) await new Promise(resolve => setTimeout(resolve, createDelayMs))
      await json(route, { task: created, operation_id: body.operation_id }, 201)
      setTimeout(() => workspaceSocket?.send(JSON.stringify({ event: 'task_update', data: { action: 'created', task: created, operation_id: body.operation_id } })), 20)
      return
    }
    const attachmentUploadMatch = path.match(/^\/api\/tasks\/([^/]+)\/attachments\/upload$/)
    if (attachmentUploadMatch && request.method() === 'POST') {
      const multipart = request.postData() || ''
      const filename = multipart.match(/filename="([^"]+)"/)?.[1] || 'archivo-sin-nombre'
      attachmentUploads.push({ taskId: attachmentUploadMatch[1], filename })
      if (failNextAttachmentUpload) {
        failNextAttachmentUpload = false
        await json(route, { error: 'Fallo temporal de almacenamiento.' }, 503)
        return
      }
      await json(route, {
        success: true,
        attachment: {
          id: `attachment-upload-${attachmentUploads.length}`, account_id: 'account-work', task_id: attachmentUploadMatch[1], media_asset_id: `asset-upload-${attachmentUploads.length}`,
          filename, content_type: 'image/png', media_type: 'image', size_bytes: 68, url: `/api/media/file/account-work/${filename}`, uploaded_by: 'user-owner', created_at: now,
        },
      }, 201)
      return
    }
    if (path === '/api/tasks/bulk-move' && request.method() === 'POST') {
      bulkMoves.push(body)
      const sourceListID = task.list_id
      const destinationListID = String(body.destination_list_id || task.list_id)
      const destination = [...hierarchy.root_lists, ...hierarchy.folders.flatMap(folder => folder.lists)].find(item => item.id === destinationListID)
      const destinationFolder = hierarchy.folders.find(folder => folder.lists.some(item => item.id === destinationListID))
      task = { ...task, list_id: destinationListID, list_name: destination?.name || task.list_name, folder_id: destinationFolder?.id, folder_name: destinationFolder?.name, version: task.version + 1 }
      const updateListCounts = (item: ReturnType<typeof list>) => item.id === sourceListID
        ? { ...item, task_count: Math.max(0, item.task_count - 1), open_task_count: Math.max(0, item.open_task_count - 1) }
        : item.id === destinationListID
          ? { ...item, task_count: item.task_count + 1, open_task_count: item.open_task_count + 1 }
          : item
      hierarchy = {
        root_lists: hierarchy.root_lists.map(updateListCounts),
        folders: hierarchy.folders.map(folder => {
          const nextLists = folder.lists.map(updateListCounts)
          const taskCount = nextLists.reduce((sum, item) => sum + item.task_count, 0)
          const openTaskCount = nextLists.reduce((sum, item) => sum + item.open_task_count, 0)
          return { ...folder, lists: nextLists, task_count: taskCount, open_task_count: openTaskCount }
        }),
      }
      const allLists = [...hierarchy.root_lists, ...hierarchy.folders.flatMap(folder => folder.lists)]
      await json(route, {
        success: true,
        operation_id: body.operation_id,
        tasks: [task],
        orders: { [destinationListID]: [task.id] },
        hierarchy_counts: {
          revision: task.version,
          captured_at: new Date().toISOString(),
          task_count: allLists.reduce((sum, item) => sum + item.task_count, 0),
          open_task_count: allLists.reduce((sum, item) => sum + item.open_task_count, 0),
          completed_task_count: 0,
          cancelled_task_count: 0,
          lists: allLists.map(item => ({ id: item.id, task_count: item.task_count, open_task_count: item.open_task_count, completed_task_count: item.completed_task_count, cancelled_task_count: item.cancelled_task_count })),
          folders: hierarchy.folders.map(folder => ({ id: folder.id, task_count: folder.task_count, open_task_count: folder.open_task_count, completed_task_count: folder.completed_task_count, cancelled_task_count: folder.cancelled_task_count })),
        },
      })
      return
    }
    if (path === '/api/tasks/bulk-update' && request.method() === 'POST') {
      bulkUpdates.push(body)
      if (requireNextBulkParticipantGrant && body.property === 'assigned_to' && body.confirm_grants !== true) {
        requireNextBulkParticipantGrant = false
        await json(route, { success: false, code: 'access_change_confirmation_required', affected_user_ids: [String(body.value)] }, 409)
        return
      }
      const itemIDs = new Set(((body.items as Array<{ id: string }> | undefined) || []).map(item => item.id))
      const assignedTo = body.property === 'assigned_to' ? String(body.value) : ''
      const applyBulk = (item: ReturnType<typeof makeTask>) => itemIDs.has(item.id)
        ? {
            ...item,
            ...(body.property === 'assigned_to' ? {
              assigned_to: assignedTo,
              assigned_to_name: assignedTo === 'user-analyst' ? 'Ana Analista' : item.assigned_to_name,
            } : {}),
            version: item.version + 1,
          }
        : item
      task = applyBulk(task)
      createdTasks = createdTasks.map(applyBulk)
      await json(route, { success: true, operation_id: body.operation_id, tasks: [task, ...createdTasks].filter(item => itemIDs.has(item.id)) })
      return
    }
    if (path === `/api/tasks/${task.id}`) { await json(route, { task }); return }
    if (path === `/api/tasks/${task.id}/children`) { await json(route, { tasks: [] }); return }
    if (path === `/api/tasks/${task.id}/comments`) { await json(route, { comments: [], total: 0, limit: 100, offset: 0 }); return }
    if (path === `/api/tasks/${task.id}/activity`) { await json(route, { activity: [] }); return }
    if (path === `/api/tasks/${task.id}/attachments`) { await json(route, { attachments: [textAttachment] }); return }
    if (path === `/api/tasks/${task.id}/attachments/${textAttachment.id}/preview`) {
      await json(route, { preview: { id: 'preview-text', account_id: 'account-work', task_id: task.id, attachment_id: textAttachment.id, kind: 'text', status: 'ready', url: '/api/media/file/account-work/notas-operativas.txt', page_count: 0, version: 1, created_at: now, updated_at: now } }); return
    }
    if (path === `/api/tasks/${task.id}/attachments/${textAttachment.id}/comments` && request.method() === 'GET') {
      await json(route, { comments: attachmentComments }); return
    }
    if (path === `/api/tasks/${task.id}/attachments/${textAttachment.id}/comments` && request.method() === 'POST') {
      attachmentCommentWrites.push(body)
      const comment = { id: `attachment-comment-${attachmentComments.length + 1}`, account_id: 'account-work', task_id: task.id, attachment_id: textAttachment.id, author_id: 'user-owner', author_name: 'Ricardo Rojas', body: body.body, anchor: body.anchor, version: 1, created_at: now, updated_at: now, can_resolve: true, mentions: [] }
      attachmentComments = [...attachmentComments, comment]
      await json(route, { comment }, 201); return
    }
    const attachmentCommentResolveMatch = path.match(new RegExp(`^/api/tasks/${task.id}/attachments/${textAttachment.id}/comments/([^/]+)/resolve$`))
    if (attachmentCommentResolveMatch && request.method() === 'PUT') {
      attachmentCommentMutations.push({ method: request.method(), body })
      const commentID = attachmentCommentResolveMatch[1]
      attachmentComments = attachmentComments.map(comment => comment.id === commentID
        ? { ...comment, version: Number(comment.version) + 1, resolved_at: body.resolved ? now : undefined, resolved_by_name: body.resolved ? 'Ricardo Rojas' : undefined, can_edit: !body.resolved, can_delete: !body.resolved, can_resolve: true }
        : comment)
      await json(route, { comment: attachmentComments.find(comment => comment.id === commentID), operation_id: body.operation_id }); return
    }
    if (path === '/api/media/file/account-work/notas-operativas.txt') {
      await route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: 'Primera línea de contexto.\nSegunda línea para comentarios anclados.\n' }); return
    }
    if (path === `/api/tasks/${task.id}/dependencies`) { await json(route, { dependencies: [] }); return }
    if (path === `/api/tasks/${sharedTask.id}`) { await json(route, { task: sharedTask }); return }
    if (path === `/api/tasks/${sharedTask.id}/children`) { await json(route, { tasks: [] }); return }
    if (path === `/api/tasks/${sharedTask.id}/comments`) { await json(route, { comments: [], total: 0, limit: 100, offset: 0, has_more: false }); return }
    if (path === `/api/tasks/${sharedTask.id}/activity`) { await json(route, { activity: [] }); return }
    if (path === `/api/tasks/${sharedTask.id}/attachments`) { await json(route, { attachments: [] }); return }
    if (path === `/api/tasks/${sharedTask.id}/dependencies`) { await json(route, { dependencies: [] }); return }
    if (path.startsWith('/api/notifications')) { await json(route, { notifications: [], unread_count: 0, total: 0 }); return }
    await json(route, { success: true })
  })

  await page.context().addCookies([{ name: 'auth-token', value: 'task-refinement-session', url: baseURL, httpOnly: true, sameSite: 'Lax' }])
  await page.addInitScript(() => {
    localStorage.setItem('token', 'task-refinement-session')
    localStorage.setItem('clarin:last_activity_at', String(Date.now()))
    localStorage.setItem('clarin:auth_refreshed_at', String(Date.now()))
    localStorage.setItem('tasks:view', 'list')
    localStorage.setItem('tasks:detail-mode', 'maximized')
  })

  return {
    structureWrites, folderStructureWrites, appearanceWrites, collaboratorWrites, taskWrites, createWrites, folderCreateWrites, bulkMoves, bulkUpdates, trashWrites, taskQueries, environmentWrites,
    environmentDetailReads, remoteListQueries, remoteFolderQueries, sharedResourceReads, structureRefreshCompletions, attachmentUploads, attachmentCommentWrites, attachmentCommentMutations,
    failNextDescriptionWrite: () => { failNextDescriptionWrite = true },
    failNextAttachmentUpload: () => { failNextAttachmentUpload = true },
    failNextCreateConflict: () => { failNextCreateStatus = 409 },
    requireNextBulkParticipantGrant: () => { requireNextBulkParticipantGrant = true },
    addAnalystTask: () => {
      createdTasks = [{
        ...makeTask(), id: 'task-analyst', title: 'Tarea de Ana', assigned_to: 'user-analyst', assigned_to_name: 'Ana Analista', sort_order: 2048,
      }, ...createdTasks]
    },
    setCreateDelay: (milliseconds: number) => { createDelayMs = milliseconds },
    emitTaskEvent: (data: Record<string, unknown>) => {
      if (!workspaceSocket) return false
      if (data.action === 'access_revoked' && data.target_type === 'task' && data.target_id === sharedTask.id) sharedResources = []
      workspaceSocket.send(JSON.stringify({ event: 'task_update', data }))
      return true
    },
  }
}

async function drag(page: Page, source: Locator, target: Locator) {
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  expect(sourceBox).not.toBeNull()
  expect(targetBox).not.toBeNull()
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2 + 10, sourceBox!.y + sourceBox!.height / 2 + 4, { steps: 3 })
  await expect(page.locator('[data-task-hierarchy-overlay]')).toBeVisible()
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 12 })
  await page.mouse.move(targetBox!.x + targetBox!.width / 2 + 2, targetBox!.y + targetBox!.height / 2 + 1, { steps: 2 })
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 2 })
  await page.waitForTimeout(250)
  await expect(page.locator('[data-task-hierarchy-container="container:folder-client"] [data-task-hierarchy-placeholder]')).toBeVisible()
  await page.mouse.up()
}

async function dragSortable(page: Page, source: Locator, target: Locator) {
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  expect(sourceBox).not.toBeNull()
  expect(targetBox).not.toBeNull()
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(sourceBox!.x + 12, sourceBox!.y + 6, { steps: 3 })
  await expect(page.locator('[data-task-hierarchy-overlay]')).toBeVisible()
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + 3, { steps: 12 })
  await page.waitForTimeout(180)
  await page.mouse.up()
}

async function dragTaskToNavigation(page: Page, source: Locator, target: Locator) {
  const handle = source.locator('button[aria-label^="Arrastrar "]').first()
  const sourceBox = await handle.boundingBox()
  expect(sourceBox).not.toBeNull()
  const start = { x: sourceBox!.x + sourceBox!.width / 2, y: sourceBox!.y + sourceBox!.height / 2 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 10, start.y + 7, { steps: 4 })
  await page.waitForTimeout(60)
  const targetBox = await target.boundingBox()
  expect(targetBox).not.toBeNull()
  const end = { x: targetBox!.x + targetBox!.width / 2, y: targetBox!.y + targetBox!.height / 2 }
  await page.mouse.move(end.x, end.y, { steps: 18 })
  await page.mouse.move(end.x + 2, end.y + 1, { steps: 2 })
  await page.mouse.move(end.x, end.y, { steps: 2 })
  await page.waitForTimeout(240)
}

async function pasteImageFiles(target: Locator, filenames: string[]) {
  return target.evaluate((element, names) => {
    const clipboard = new DataTransfer()
    for (const name of names) {
      clipboard.items.add(new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, { type: 'image/png' }))
    }
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(event, 'clipboardData', { value: clipboard })
    element.dispatchEvent(event)
    return event.defaultPrevented
  }, filenames)
}

async function dispatchTextPaste(target: Locator, value: string) {
  return target.evaluate((element, text) => {
    const clipboard = new DataTransfer()
    clipboard.setData('text/plain', text)
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(event, 'clipboardData', { value: clipboard })
    element.dispatchEvent(event)
    return event.defaultPrevented
  }, value)
}

test.describe('Clarin Work workspace refinement', () => {
  test.describe.configure({ timeout: 60_000 })

  test('moves a list into a folder once and keeps the default list locked', async ({ page }) => {
    const mock = await installWorkspaceMock(page)
    await page.setViewportSize({ width: 1398, height: 720 })
    await page.goto(`${baseURL}/dashboard/tasks`)
    await expect(page.getByText('Trabajo principal', { exact: true }).first()).toBeVisible()
    await expect(page.getByTitle('La Bandeja general permanece fija en la raíz')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Mover Bandeja general' })).toHaveCount(0)

    await drag(page, page.getByRole('button', { name: 'Mover Trabajo principal' }), page.getByRole('button', { name: 'Cliente Alfa 0 tareas abiertas' }))
    await expect.poll(() => mock.structureWrites.length).toBe(1)
    expect(mock.structureWrites[0]).toMatchObject({ folder_id: 'folder-client', before_list_id: null, workflow_inherited: true })
    await expect(page.locator('[data-task-hierarchy-container="container:folder-client"] [data-task-hierarchy-list="list-work"]')).toBeVisible()
  })

  test('creates directly from a calendar day and preserves a concrete list destination', async ({ page }) => {
    const mock = await installWorkspaceMock(page)
    await page.goto(`${baseURL}/dashboard/tasks`)
    await page.getByRole('button', { name: 'Calendario' }).click()
    await expect(page.locator('[data-task-calendar]')).toBeVisible()
    await page.locator('[data-task-calendar] .grid button.group').first().click()
    const composer = page.getByRole('dialog', { name: 'Crear tarea' })
    await expect(composer).toBeVisible()
    const pickerTriggers = composer.locator('button[aria-haspopup="listbox"]')
    await pickerTriggers.nth(0).click()
    const listPortal = page.getByRole('listbox', { name: 'Seleccionar lista' })
    await expect(listPortal).toBeVisible()
    expect(await listPortal.evaluate(element => Number(getComputedStyle(element).zIndex))).toBeGreaterThan(145)
    await listPortal.getByPlaceholder('Buscar listas…').fill('carpeta')
    await listPortal.getByRole('option', { name: /Lista de carpeta/ }).click()
    await pickerTriggers.nth(1).click()
    const ownerPortal = page.locator('[data-task-user-combobox-portal]')
    await expect(ownerPortal).toBeVisible()
    expect(await ownerPortal.evaluate(element => Number(getComputedStyle(element).zIndex))).toBeGreaterThan(145)
    await page.getByRole('option', { name: /Ana Analista/ }).click()
    await page.getByPlaceholder('¿Qué hay que lograr?').fill('Tarea creada desde calendario')
    await composer.getByRole('button', { name: 'Crear', exact: true }).click()
    await expect.poll(() => mock.createWrites.length).toBe(1)
    expect(mock.createWrites[0].list_id).toBeTruthy()
    expect(mock.createWrites[0].is_all_day).toBe(true)
    expect(mock.createWrites[0].operation_id).toBeTruthy()
    expect(mock.createWrites[0]).toMatchObject({ list_id: 'list-folder', assigned_to: 'user-analyst' })
  })

  test('supports keyboard pickup and exact Escape cancellation for a list', async ({ page }) => {
    const mock = await installWorkspaceMock(page)
    await page.setViewportSize({ width: 1398, height: 504 })
    await page.goto(`${baseURL}/dashboard/tasks`)
    const handle = page.getByRole('button', { name: 'Mover Trabajo principal' })
    await handle.focus()
    await page.keyboard.press('Space')
    await expect(page.locator('[data-task-hierarchy-overlay]')).toBeVisible()
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-task-hierarchy-overlay]')).toHaveCount(0)
    expect(mock.structureWrites).toHaveLength(0)
    await expect(page.locator('[data-task-hierarchy-container="root"] [data-task-hierarchy-list="list-work"]')).toBeVisible()
  })

  test('keeps the root hierarchy understandable and reorders folders with one write', async ({ page }) => {
    const mock = await installWorkspaceMock(page)
    await page.setViewportSize({ width: 1398, height: 760 })
    await page.goto(`${baseURL}/dashboard/tasks`)
    const defaultRow = page.locator('[data-task-default-list]')
    const independent = page.getByText('Listas independientes', { exact: true })
    const folders = page.getByText('Carpetas', { exact: true })
    await expect(defaultRow).toContainText('Bandeja general')
    await expect(independent).toHaveAttribute('title', 'Listas que no pertenecen a una carpeta')
    const positions = await Promise.all([defaultRow, independent, folders].map(async locator => (await locator.boundingBox())!.y))
    expect(positions[0]).toBeLessThan(positions[1])
    expect(positions[1]).toBeLessThan(positions[2])

    await dragSortable(page, page.getByRole('button', { name: 'Mover carpeta Cliente Beta' }), page.getByRole('button', { name: 'Mover carpeta Cliente Alfa' }))
    await expect.poll(() => mock.folderStructureWrites.length).toBe(1)
    expect(mock.folderStructureWrites[0]).toMatchObject({ folderId: 'folder-beta', body: { before_folder_id: 'folder-client' } })
  })

  test('personalizes a list from the controlled icon and color catalog', async ({ page }) => {
    const mock = await installWorkspaceMock(page)
    await page.setViewportSize({ width: 1398, height: 760 })
    await page.goto(`${baseURL}/dashboard/tasks`)
    const row = page.locator('[data-task-hierarchy-list="list-work"]')
    await row.hover()
    await page.getByRole('button', { name: 'Personalizar Trabajo principal' }).click()
    const dialog = page.getByRole('dialog', { name: 'Personalizar lista' })
    await dialog.getByRole('textbox', { name: 'Nombre' }).fill('Seguimiento comercial')
    await dialog.getByRole('button', { name: 'Color de lista: #3B82F6' }).click()
    const colorPicker = page.getByRole('dialog', { name: 'Color de lista' })
    await colorPicker.getByRole('button', { name: 'Color #f97316' }).click()
    await colorPicker.getByRole('button', { name: 'Usar este color' }).click()
    await dialog.getByRole('button', { name: 'Icono de lista: Lista' }).click()
    await page.getByRole('dialog', { name: 'Icono de lista' }).getByRole('button', { name: 'Objetivo' }).click()
    await dialog.getByRole('button', { name: 'Guardar cambios' }).click()
    await expect.poll(() => mock.appearanceWrites.length).toBe(1)
    expect(mock.appearanceWrites[0].body).toMatchObject({ name: 'Seguimiento comercial', color: '#F97316', icon: 'target' })
    await expect(page.getByText('Seguimiento comercial', { exact: true })).toBeVisible()
  })

  test('keeps folder icons fixed while list icons remain configurable', async ({ page }) => {
    const mock = await installWorkspaceMock(page)
    await page.setViewportSize({ width: 1398, height: 760 })
    await page.goto(`${baseURL}/dashboard/tasks`)
    const folderRow = page.getByRole('button', { name: 'Cliente Alfa 0 tareas abiertas', exact: true })
    await folderRow.hover()
    await page.getByRole('button', { name: 'Personalizar Cliente Alfa' }).click()
    const dialog = page.getByRole('dialog', { name: 'Personalizar carpeta' })

    await expect(dialog.getByLabel('Icono fijo de carpeta')).toBeVisible()
    await expect(dialog.getByRole('button', { name: /Icono de carpeta/i })).toHaveCount(0)
    await dialog.getByRole('textbox', { name: 'Nombre' }).fill('Cliente Alfa actualizado')
    await dialog.getByRole('button', { name: 'Guardar cambios' }).click()

    await expect.poll(() => mock.appearanceWrites.length).toBe(1)
    expect(mock.appearanceWrites[0].body).not.toHaveProperty('icon')
    await expect(page.getByRole('button', { name: 'Personalizar Cliente Alfa actualizado' })).toBeAttached()
  })

  test('expands search without changing the header height and preserves its query on Escape', async ({ page }) => {
    await installWorkspaceMock(page)
    await page.setViewportSize({ width: 1398, height: 504 })
    await page.goto(`${baseURL}/dashboard/tasks`)
    const header = page.locator('main header').first()
    await expect(page.getByRole('button', { name: 'Filtros' })).toBeVisible()
    await page.evaluate(async () => { await document.fonts.ready })
    const before = await header.boundingBox()
    await expect(page.getByRole('button', { name: 'Tablero' })).toBeVisible()
    await page.keyboard.press('/')
    const search = page.locator('#task-search')
    await expect(search).toBeFocused()
    await search.fill('propuesta')
    await page.keyboard.press('Escape')
    await expect(search).toHaveValue('propuesta')
    const after = await header.boundingBox()
    expect(Math.abs((after?.height || 0) - (before?.height || 0))).toBeLessThanOrEqual(1)
    await page.getByRole('button', { name: 'Limpiar búsqueda' }).click()
    await expect(search).toHaveValue('')
  })

  test('waits 500 ms, cancels intermediate searches and performs one final query', async ({ page }) => {
    const mock = await installWorkspaceMock(page)
    await page.setViewportSize({ width: 1398, height: 620 })
    await page.goto(`${baseURL}/dashboard/tasks`)
    await expect(page.getByText('Preparar propuesta profesional', { exact: true })).toBeVisible()
    mock.taskQueries.length = 0
    await page.keyboard.press('/')
    const search = page.locator('#task-search')
    await search.fill('f')
    await search.fill('fi')
    await search.fill('finaz')
    await expect(page.locator('[data-task-search-pending]')).toBeVisible()
    await page.waitForTimeout(450)
    expect(mock.taskQueries.filter(query => query.search).length).toBe(0)
    await expect.poll(() => mock.taskQueries.filter(query => query.search === 'finaz').length).toBe(1)
    expect(mock.taskQueries.filter(query => query.search && query.search !== 'finaz')).toHaveLength(0)
  })

  test('keeps an inline-created task visible by clearing active query state and deduplicating its WebSocket echo', async ({ page }) => {
    const mock = await installWorkspaceMock(page)
    await page.setViewportSize({ width: 1398, height: 700 })
    await page.goto(`${baseURL}/dashboard/tasks`)
    await page.getByRole('button', { name: 'Tablero' }).click()
    await page.keyboard.press('/')
    await page.locator('#task-search').fill('finaz')
    await expect.poll(() => mock.taskQueries.filter(query => query.search === 'finaz').length).toBe(1)
    await expect(page.locator('[data-task-id]')).toHaveCount(0)

    const todo = page.locator('section[data-task-column-id="status-todo"]')
    await todo.getByRole('button', { name: 'Agregar tarea' }).click()
    await todo.getByPlaceholder('Nombre de la tarea…').fill('Nueva tarea que debe permanecer')
    await todo.getByRole('button', { name: 'Crear', exact: true }).click()

    await expect.poll(() => mock.createWrites.length).toBe(1)
    expect(mock.createWrites[0].operation_id).toMatch(/^[0-9a-f-]{36}$/)
    await expect(page.getByRole('status').filter({ hasText: 'Limpiamos la búsqueda y los filtros para mostrar la tarea creada.' })).toBeVisible()
    await expect(page.locator('#task-search')).toHaveValue('')
    await expect(page.getByText('Nueva tarea que debe permanecer', { exact: true })).toHaveCount(1)
    await page.waitForTimeout(250)
    await expect(page.locator('[data-task-id^="task-created-"]')).toHaveCount(1)

    await page.reload()
    await page.getByRole('button', { name: 'Tablero' }).click()
    await expect(page.getByText('Nueva tarea que debe permanecer', { exact: true })).toHaveCount(1)
  })

  test('supports multiple persisted folder accordions and independent keyboard toggles', async ({ page }) => {
    await installWorkspaceMock(page)
    await page.setViewportSize({ width: 1398, height: 620 })
    await page.goto(`${baseURL}/dashboard/tasks`)
    const alpha = page.getByRole('button', { name: 'Contraer Cliente Alfa' })
    const beta = page.getByRole('button', { name: 'Contraer Cliente Beta' })
    await expect(alpha).toBeVisible()
    await expect(beta).toBeVisible()
    await alpha.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: 'Expandir Cliente Alfa' })).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('[data-task-hierarchy-list="list-folder"]')).not.toBeVisible()
    await expect(beta).toHaveAttribute('aria-expanded', 'true')
    await page.reload()
    await expect(page.getByRole('button', { name: 'Expandir Cliente Alfa' })).toHaveAttribute('aria-expanded', 'false')
    await page.getByRole('button', { name: 'Expandir Cliente Alfa' }).click()
    await expect(page.locator('[data-task-hierarchy-list="list-folder"]')).toBeVisible()
  })

  test('lets the active folder stay collapsed when its main row is clicked', async ({ page }) => {
    await installWorkspaceMock(page)
    await page.setViewportSize({ width: 1398, height: 620 })
    await page.goto(`${baseURL}/dashboard/tasks`)
    const row = page.getByRole('button', { name: 'Cliente Alfa 0 tareas abiertas', exact: true })
    await row.click()
    await expect(page.getByRole('button', { name: 'Expandir Cliente Alfa' })).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('[data-task-hierarchy-list="list-folder"]')).not.toBeVisible()
    await row.click()
    await expect(page.getByRole('button', { name: 'Contraer Cliente Alfa' })).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('[data-task-hierarchy-list="list-folder"]')).toBeVisible()
  })

  test('moves a task to a navigation list and opens the folder chooser above the board', async ({ page }) => {
    const mock = await installWorkspaceMock(page)
    await page.setViewportSize({ width: 1398, height: 720 })
    await page.goto(`${baseURL}/dashboard/tasks`)
    await page.getByRole('button', { name: 'Tablero' }).click()
    const taskCard = page.locator('[data-task-id="task-refinement"]')
    const listTarget = page.locator('[data-task-drop-list="list-default"]').first()
    await dragTaskToNavigation(page, taskCard, listTarget)
    await expect(listTarget).toHaveAttribute('data-task-drop-highlight', 'true')
    await expect(page.getByText('Soltar en Bandeja general', { exact: true })).toBeVisible()
    await page.mouse.up()
    await expect.poll(() => mock.bulkMoves.length).toBe(1)
    expect(mock.bulkMoves[0]).toMatchObject({ destination_list_id: 'list-default' })

    const folderTarget = page.getByRole('button', { name: 'Cliente Alfa 0 tareas abiertas', exact: true })
    await dragTaskToNavigation(page, taskCard, folderTarget)
    await page.mouse.up()
    const chooser = page.getByRole('dialog', { name: 'Cliente Alfa' })
    await expect(chooser).toBeVisible()
    const chooserBox = await chooser.boundingBox()
    expect(chooserBox).not.toBeNull()
    await chooser.getByRole('button', { name: /Lista de carpeta/ }).click()
    await expect.poll(() => mock.bulkMoves.length).toBe(2)
    expect(mock.bulkMoves[1]).toMatchObject({ destination_list_id: 'list-folder' })
  })

  test('highlights a real navigation list while dragging from Lista and writes the destination once', async ({ page }, testInfo) => {
    const mock = await installWorkspaceMock(page)
    await page.setViewportSize({ width: 1280, height: 760 })
    await page.goto(`${baseURL}/dashboard/tasks`)
    const taskRow = page.locator('[data-task-list-row="task-refinement"]')
    await expect(taskRow).toBeVisible()
    const listTarget = page.locator('[data-task-drop-list="list-default"]').first()
    await expect(listTarget).toBeVisible()

    await dragTaskToNavigation(page, taskRow, listTarget)
    await expect(listTarget).toHaveAttribute('data-task-drop-highlight', 'true')
    await expect(page.getByText('Soltar en Bandeja general', { exact: true })).toBeVisible()
    const acceptanceScreenshot = testInfo.outputPath('lista-destino-resaltado.png')
    await page.screenshot({ path: acceptanceScreenshot, fullPage: false })
    await testInfo.attach('Aceptación visual: destino lateral desde Lista', { path: acceptanceScreenshot, contentType: 'image/png' })
    await page.mouse.up()
    await expect.poll(() => mock.bulkMoves.length).toBe(1)
    expect(mock.bulkMoves[0]).toMatchObject({ destination_list_id: 'list-default' })
  })

  test('reconciles a list-to-list move immediately without leaving the source row or stale counts', async ({ page }) => {
    const mock = await installWorkspaceMock(page)
    await page.setViewportSize({ width: 1420, height: 674 })
    await page.goto(`${baseURL}/dashboard/tasks`)

    const sourceList = page.locator('[data-task-hierarchy-list="list-work"]')
    const destinationList = page.locator('[data-task-hierarchy-list="list-folder"]')
    await sourceList.click()
    await expect(page.getByRole('heading', { name: 'Trabajo principal' })).toBeVisible()
    const taskRow = page.locator('[data-task-list-row="task-refinement"]')
    await expect(taskRow).toBeVisible()

    await dragTaskToNavigation(page, taskRow, destinationList)
    await page.mouse.up()

    await expect.poll(() => mock.bulkMoves.length).toBe(1)
    expect(mock.bulkMoves[0]).toMatchObject({ destination_list_id: 'list-folder' })
    await expect(taskRow).toHaveCount(0)
    await expect(page.getByText('No hay tareas para esta vista.')).toBeVisible()
    await expect(sourceList).toContainText('0')
    await expect(destinationList).toContainText('1')

    await destinationList.click()
    await expect(page.getByRole('heading', { name: 'Lista de carpeta' })).toBeVisible()
    await expect(page.locator('[data-task-list-row="task-refinement"]')).toBeVisible()
  })

  test('highlights a navigation folder from Lista and requires an explicit child-list choice', async ({ page }) => {
    const mock = await installWorkspaceMock(page)
    await page.setViewportSize({ width: 1280, height: 760 })
    await page.goto(`${baseURL}/dashboard/tasks`)
    const taskRow = page.locator('[data-task-list-row="task-refinement"]')
    await expect(taskRow).toBeVisible()
    const folderTarget = page.locator('[data-task-drop-folder="folder-client"]')
    const folderRow = page.getByRole('button', { name: 'Cliente Alfa 0 tareas abiertas', exact: true })
    await dragTaskToNavigation(page, taskRow, folderRow)
    await expect(folderTarget.locator('[data-task-drop-highlight]')).toHaveCount(1)
    await expect(page.getByText('Suelta para elegir una lista', { exact: true })).toBeVisible()
    await page.mouse.up()
    await expect.poll(() => mock.bulkMoves.length).toBe(0)
    const chooser = page.getByRole('dialog', { name: 'Cliente Alfa' })
    await expect(chooser).toBeVisible()
    await chooser.getByRole('button', { name: /Lista de carpeta/ }).click()
    await expect.poll(() => mock.bulkMoves.length).toBe(1)
    expect(mock.bulkMoves[0]).toMatchObject({ destination_list_id: 'list-folder' })
  })

  test('confirms an explicit Edit grant when an assignee-group drop would expose a task', async ({ page }) => {
    const mock = await installWorkspaceMock(page)
    mock.addAnalystTask()
    mock.requireNextBulkParticipantGrant()
    await page.setViewportSize({ width: 1280, height: 820 })
    await page.goto(`${baseURL}/dashboard/tasks`)

    await page.locator('button[aria-haspopup="listbox"]').filter({ hasText: /Estado|Sin agrupación/ }).first().click()
    await page.getByRole('listbox', { name: 'Agrupar tareas por' }).getByRole('option', { name: /Responsable/ }).click()
    const source = page.locator('[data-task-list-row="task-refinement"]')
    const analystGroup = page.locator('section[data-task-list-group="user-analyst"]')
    await expect(source).toBeVisible()
    await expect(analystGroup).toContainText('Ana Analista')

    await dragTaskToNavigation(page, source, analystGroup)
    await page.mouse.up()
    const confirmation = page.getByRole('alertdialog', { name: 'Confirmar acceso para participantes' })
    await expect(confirmation).toBeVisible()
    await expect(confirmation).toContainText('Ana Analista')
    expect(mock.bulkUpdates).toHaveLength(1)
    expect(mock.bulkUpdates[0]).toMatchObject({ property: 'assigned_to', value: 'user-analyst', confirm_grants: false })

    await confirmation.getByRole('button', { name: 'Conceder Editar y guardar' }).click()
    await expect.poll(() => mock.bulkUpdates.length).toBe(2)
    expect(mock.bulkUpdates[1]).toMatchObject({ property: 'assigned_to', value: 'user-analyst', confirm_grants: true })
    await expect(confirmation).toHaveCount(0)
    await expect(analystGroup.locator('[data-task-list-row="task-refinement"]')).toBeVisible()
  })

  test('keeps the workspace full-bleed and contained across responsive widths', async ({ page }) => {
    await installWorkspaceMock(page)
    for (const width of [320, 375, 768, 1024, 1280, 1440]) {
      await page.emulateMedia({ reducedMotion: width <= 375 ? 'reduce' : 'no-preference' })
      await page.setViewportSize({ width, height: width <= 375 ? 720 : 620 })
      await page.goto(`${baseURL}/dashboard/tasks`)
      await expect(page.locator('[data-task-view-tabs]')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Lista', exact: true })).toBeVisible()
      await expect(page.locator('[data-task-workspace-canvas]')).toBeVisible()
      const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth)
      expect(documentWidth).toBeLessThanOrEqual(width)
    }
    await page.emulateMedia({ reducedMotion: 'no-preference' })
  })

  test('restores a preferred private Entorno outside page one and finds a remote collapsed-folder list after the 500 ms cursor search', async ({ page }) => {
    const mock = await installWorkspaceMock(page)
    await page.addInitScript(() => {
      localStorage.setItem('clarin:tasks:account-work:user-owner:active-environment:v1', 'env-private')
      localStorage.setItem('clarin:tasks:expanded-folders', '[]')
    })
    await page.setViewportSize({ width: 1280, height: 820 })
    await page.goto(`${baseURL}/dashboard/tasks`)

    await expect(page.locator('[data-task-view-tabs]')).toBeVisible({ timeout: 15_000 })
    const environmentTrigger = page.getByTitle('Entorno: Privado remoto')
    await expect(environmentTrigger).toBeVisible({ timeout: 15_000 })
    await expect(environmentTrigger.getByLabel('Entorno privado')).toBeVisible()
    expect(mock.environmentDetailReads.length).toBeGreaterThan(0)
    expect(new Set(mock.environmentDetailReads)).toEqual(new Set(['env-private']))
    await expect(page.getByRole('button', { name: 'Expandir Carpeta reservada' })).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('[data-task-hierarchy-list="list-private-remote"]')).toHaveCount(0)

    await environmentTrigger.click()
    const environmentDialog = page.getByRole('dialog', { name: 'Seleccionar Entorno' })
    await expect(environmentDialog).toBeVisible()
    const panelBox = await environmentDialog.boundingBox()
    expect(panelBox).not.toBeNull()
    expect(panelBox!.x).toBeGreaterThanOrEqual(12)
    expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(1268)
    const privateRow = environmentDialog.locator('button').filter({ hasText: 'Privado remoto' })
    await expect(privateRow).toContainText('Privado')
    await expect(privateRow).toContainText('Administrar')
    const generalRow = environmentDialog.locator('button').filter({ hasText: 'General' }).first()
    await expect(generalRow).toContainText('Cuenta')
    await page.keyboard.press('Escape')
    await expect(environmentDialog).toHaveCount(0)
    await expect(environmentTrigger).toBeFocused()

    await page.getByRole('button', { name: 'Nueva tarea' }).click()
    const editor = page.getByRole('dialog', { name: 'Crear una tarea' })
    await editor.getByRole('button', { name: /Bandeja privada/ }).click()
    const listbox = page.getByRole('listbox', { name: 'Seleccionar lista' })
    const search = listbox.getByPlaceholder('Buscar listas…')
    const startedAt = Date.now()
    await search.fill('especial')
    await page.waitForTimeout(350)
    expect(mock.remoteListQueries.filter(query => query.search === 'especial')).toHaveLength(0)
    await expect.poll(() => mock.remoteListQueries.filter(query => query.search === 'especial').length).toBe(1)
    const firstSearch = mock.remoteListQueries.find(query => query.search === 'especial')!
    expect(firstSearch.at - startedAt).toBeGreaterThanOrEqual(450)
    await expect(listbox.getByRole('button', { name: 'Cargar más listas' })).toBeVisible()
    await listbox.getByRole('button', { name: 'Cargar más listas' }).click()
    await expect.poll(() => mock.remoteListQueries.some(query => query.cursor === 'remote-list-page-2')).toBe(true)
    const remoteOption = listbox.getByRole('option', { name: /Lista remota especial/ })
    await expect(remoteOption).toContainText('Carpeta reservada / Lista remota especial')
    await remoteOption.click()
    await expect(editor.getByRole('button', { name: /Lista remota especial/ })).toBeVisible()
    expect(mock.remoteFolderQueries.some(query => query.limit === '200')).toBe(true)
    await expect(page.getByRole('button', { name: 'Expandir Carpeta reservada' })).toHaveAttribute('aria-expanded', 'false')
  })

  test('shows canonical ACL for Compartidas conmigo and purges a revoked private task without leaking its hierarchy', async ({ page }) => {
    const mock = await installWorkspaceMock(page)
    await page.setViewportSize({ width: 1280, height: 820 })
    await page.goto(`${baseURL}/dashboard/tasks`)
    await expect(page.locator('[data-task-view-tabs]')).toBeVisible({ timeout: 15_000 })
    await page.getByRole('button', { name: 'Compartidas conmigo' }).click()
    await expect(page.getByRole('heading', { name: 'Compartidas contigo' })).toBeVisible()
    await expect.poll(() => mock.sharedResourceReads).toEqual(['env-work'])

    const sharedCard = page.getByRole('button', { name: /Tarea privada compartida/ })
    await expect(sharedCard).toBeVisible()
    await expect(page.getByText('Lista secreta')).toHaveCount(0)
    await sharedCard.click()

    const detail = page.getByRole('dialog', { name: 'Detalle de tarea' })
    await expect(detail).toBeVisible()
    await expect(detail.locator('header')).toContainText('Compartida contigo')
    await expect(detail.locator('header')).not.toContainText('Lista secreta')
    await expect(detail.getByRole('status')).toContainText('Acceso Ver')
    const access = detail.getByRole('button').filter({ hasText: 'Privacidad y acceso' })
    await access.scrollIntoViewIfNeeded()
    await expect(access).toContainText('Privada · Ver')
    await expect(access).toContainText('Solo lectura')
    await access.click()
    await expect(detail.getByText(/Tu acceso efectivo es/)).toContainText('Ver')

    await expect.poll(() => mock.emitTaskEvent({
      action: 'access_revoked', target_type: 'task', target_id: 'task-shared-private', operation_id: 'qa-revocation-1',
    })).toBe(true)
    await expect(detail).toHaveCount(0)
    await expect(sharedCard).toHaveCount(0)
    await expect.poll(() => mock.sharedResourceReads.length).toBe(2)
  })

  test('renames the active Entorno and reconciles newly created structure without reopening the window', async ({ page }) => {
    const mock = await installWorkspaceMock(page)
    await page.setViewportSize({ width: 1367, height: 818 })
    await page.goto(`${baseURL}/dashboard/tasks`)
    await expect(page.locator('[data-task-view-tabs]')).toBeVisible({ timeout: 15_000 })

    await page.locator('aside').getByRole('button', { name: 'Administrar Entorno' }).click()
    const environmentWindow = page.locator('[data-window-kind="task-environment-window"]')
    await expect(environmentWindow).toBeVisible()
    await environmentWindow.getByLabel('Nombre').fill('General QA')
    await environmentWindow.getByRole('button', { name: 'Guardar', exact: true }).click()
    await expect(environmentWindow.getByText('Cambios guardados.')).toBeVisible()
    expect(mock.environmentWrites).toHaveLength(1)
    expect(mock.environmentWrites[0].name).toBe('General QA')
    await expect(page.locator('aside').getByText('General QA', { exact: true })).toBeVisible()
    await environmentWindow.getByRole('button', { name: 'Cerrar', exact: true }).click()

    await page.getByRole('button', { name: 'Organizar carpetas y listas' }).click()
    const structureWindow = page.locator('[data-window-kind="task-structure-window"]')
    await expect(structureWindow).toBeVisible()
    await structureWindow.getByRole('button', { name: 'Carpeta', exact: true }).click()
    const folderForm = structureWindow.locator('section').filter({ hasText: 'Nueva carpeta' })
    await expect(folderForm.getByLabel('Icono fijo de carpeta')).toBeVisible()
    await expect(folderForm.getByRole('button', { name: /Icono de carpeta/i })).toHaveCount(0)
    await folderForm.getByLabel('Nombre').fill('Operaciones QA')
    await folderForm.getByRole('button', { name: 'Crear carpeta' }).click()
    await expect(structureWindow.getByText('Operaciones QA', { exact: true })).toBeVisible({ timeout: 1_500 })
    expect(mock.folderCreateWrites[0]).not.toHaveProperty('icon')
    expect(mock.structureRefreshCompletions).toHaveLength(0)

    await expect.poll(() => mock.structureRefreshCompletions.length).toBe(2)
    await structureWindow.getByRole('button', { name: 'Lista', exact: true }).click()
    const listForm = structureWindow.locator('section').filter({ hasText: 'Nueva lista' })
    await expect(listForm.getByRole('button', { name: /Icono de lista/i })).toBeVisible()
    await listForm.getByLabel('Nombre').fill('Seguimiento QA')
    await listForm.getByRole('button', { name: 'Crear lista' }).click()
    await expect(structureWindow.getByText('Seguimiento QA', { exact: true })).toBeVisible({ timeout: 1_500 })
    expect(mock.structureRefreshCompletions).toHaveLength(2)
  })

  test('uses accessible property pickers and represents zero collaborators canonically', async ({ page }) => {
    const mock = await installWorkspaceMock(page)
    await page.setViewportSize({ width: 1398, height: 760 })
    await page.goto(`${baseURL}/dashboard/tasks`)
    await page.getByText('Preparar propuesta profesional', { exact: true }).click()
    const detail = page.getByRole('dialog', { name: 'Detalle de tarea' })
    await expect(detail).toBeVisible()

    const statusPicker = detail.locator('[data-task-status-picker]')
    await statusPicker.click()
    await expect(page.getByRole('listbox', { name: 'Seleccionar estado' })).toBeVisible()
    await expect(page.getByRole('option', { name: 'En curso En curso' })).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect.poll(() => mock.taskWrites.some(body => body.status_id === activeStatus.id)).toBeTruthy()

    const priorityPicker = detail.locator('[data-task-priority-picker]')
    await priorityPicker.click()
    await expect(page.getByRole('listbox', { name: 'Seleccionar prioridad' })).toBeVisible()
    await expect(page.getByRole('option', { name: /Urgente/ })).toBeVisible()
    await page.keyboard.press('Escape')

    await detail.getByRole('button', { name: 'Quitar a Administrador' }).click()
    await expect.poll(() => mock.collaboratorWrites.length).toBe(1)
    expect(mock.collaboratorWrites[0].user_ids).toEqual([])
    await expect(detail.getByRole('button', { name: 'Quitar a Administrador' })).toHaveCount(0)
    await expect(detail.getByRole('button', { name: 'Añadir colaborador' })).toBeVisible()
  })

  test('persists professional list grouping and preserves manual progress across automatic mode', async ({ page }) => {
    const mock = await installWorkspaceMock(page)
    await page.setViewportSize({ width: 1398, height: 760 })
    await page.goto(`${baseURL}/dashboard/tasks`)

    const groupingTrigger = page.getByText('Agrupar por', { exact: true }).locator('..').locator('button[aria-haspopup="listbox"]')
    await expect(groupingTrigger).toContainText('Estado')
    await groupingTrigger.click()
    await page.getByRole('option', { name: /Prioridad/ }).click()
    await expect(page.locator('[data-task-list-group="medium"]')).toContainText('Media')
    await expect.poll(() => page.evaluate(() => localStorage.getItem('tasks:list-group-by'))).toBe('priority')

    await page.reload()
    await expect(page.getByText('Agrupar por', { exact: true }).locator('..').locator('button[aria-haspopup="listbox"]')).toContainText('Prioridad')
    await expect(page.locator('[data-task-list-group="medium"]')).toBeVisible()

    await page.getByText('Preparar propuesta profesional', { exact: true }).click()
    const detail = page.getByRole('dialog', { name: 'Detalle de tarea' })
    await detail.getByRole('button', { name: '75%' }).click()
    await expect.poll(() => mock.taskWrites.some(write => write.progress_mode === 'manual' && write.manual_progress === 75)).toBeTruthy()
    await detail.getByRole('button', { name: 'Automático' }).click()
    await expect.poll(() => mock.taskWrites.some(write => write.progress_mode === 'automatic' && write.manual_progress === 75)).toBeTruthy()
    await expect(detail.getByText('0% calculado')).toBeVisible()
    await detail.getByRole('button', { name: 'Manual' }).click()
    await expect(detail.getByRole('spinbutton', { name: 'Porcentaje manual' })).toHaveValue('75')
  })

  test('supports every Gantt scale, the full flexible zoom range and dependency mode', async ({ page }) => {
    await installWorkspaceMock(page)
    await page.setViewportSize({ width: 1398, height: 760 })
    await page.goto(`${baseURL}/dashboard/tasks`)
    await page.getByRole('button', { name: 'Gantt' }).click()
    await expect(page.getByText('Cronograma del proyecto')).toBeVisible()

    let currentScale = 'Flexible'
    for (const nextScale of ['Día', 'Semana', 'Mes', 'Trimestre', 'Año', 'Flexible']) {
      await page.getByRole('button', { name: new RegExp(currentScale) }).click()
      await page.getByRole('option', { name: nextScale, exact: true }).click()
      currentScale = nextScale
    }

    const zoomOut = page.getByRole('button', { name: 'Alejar Gantt' })
    const zoomIn = page.getByRole('button', { name: 'Acercar Gantt' })
    for (let index = 0; index < 12; index += 1) await zoomIn.click()
    await expect(page.getByText('120px', { exact: true })).toBeVisible()
    for (let index = 0; index < 15; index += 1) await zoomOut.click()
    await expect(page.getByText('8px', { exact: true })).toBeVisible()
    await page.getByText('Reprogramar dependencias').locator('input').check()
    await expect(page.getByText('Reprogramar dependencias').locator('input')).toBeChecked()
    await expect(page.getByRole('button', { name: 'Cambiar inicio' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Cambiar entrega' })).toBeVisible()
  })

  test('previews text attachments and publishes a task-scoped anchored comment', async ({ page }) => {
    const mock = await installWorkspaceMock(page)
    await page.setViewportSize({ width: 1398, height: 818 })
    await page.goto(`${baseURL}/dashboard/tasks`)
    await page.getByText('Preparar propuesta profesional', { exact: true }).click()
    const detail = page.getByRole('dialog', { name: 'Detalle de tarea' })
    await detail.getByText('notas-operativas.txt', { exact: true }).click()
    const viewer = page.getByRole('dialog', { name: 'Vista previa de notas-operativas.txt' })
    await expect(viewer).toBeVisible()
    const documentText = viewer.locator('pre')
    await expect(documentText).toContainText('Segunda línea para comentarios anclados.')
    await documentText.evaluate(element => {
      const node = element.firstChild
      if (!node) return
      const range = document.createRange()
      range.setStart(node, 0)
      range.setEnd(node, Math.min(14, node.textContent?.length || 0))
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    const composer = viewer.getByPlaceholder('Comenta sobre este punto…')
    await composer.fill('Este fragmento necesita validación.')
    await composer.locator('..').locator('button').last().click()
    await expect.poll(() => mock.attachmentCommentWrites.length).toBe(1)
    expect(mock.attachmentCommentWrites[0]).toMatchObject({ body: 'Este fragmento necesita validación.', anchor: { kind: 'text', offset: 0 } })
    await expect(viewer.getByText('Este fragmento necesita validación.')).toBeVisible()
  })

  test('resolves and reopens an anchored thread without closing or reloading the attachment viewer', async ({ page }) => {
    const mock = await installWorkspaceMock(page)
    await page.setViewportSize({ width: 1398, height: 818 })
    await page.goto(`${baseURL}/dashboard/tasks`)
    await page.getByText('Preparar propuesta profesional', { exact: true }).click()
    const detail = page.getByRole('dialog', { name: 'Detalle de tarea' })
    await detail.getByText('notas-operativas.txt', { exact: true }).click()
    const viewer = page.getByRole('dialog', { name: 'Vista previa de notas-operativas.txt' })
    const documentText = viewer.locator('pre')
    await expect(documentText).toBeVisible()
    await documentText.evaluate(element => {
      const node = element.firstChild
      if (!node) return
      const range = document.createRange()
      range.setStart(node, 0)
      range.setEnd(node, Math.min(12, node.textContent?.length || 0))
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    await viewer.getByPlaceholder('Comenta sobre este punto…').fill('Hilo verificable')
    await viewer.getByRole('button', { name: 'Publicar comentario' }).click()
    await expect(viewer.getByText('Hilo verificable')).toBeVisible()

    await viewer.getByRole('button', { name: 'Resolver comentario' }).click()
    await expect.poll(() => mock.attachmentCommentMutations.length).toBe(1)
    await expect(viewer.getByRole('button', { name: /Resueltos\s+1/ })).toBeVisible()
    await viewer.getByRole('button', { name: /Resueltos\s+1/ }).click()
    await expect(viewer.getByText('Hilo verificable')).toBeVisible()
    await expect(viewer.getByRole('button', { name: 'Responder' })).toHaveCount(0)
    await viewer.getByRole('button', { name: 'Reabrir comentario' }).click()
    await expect.poll(() => mock.attachmentCommentMutations.length).toBe(2)
    await expect(viewer.getByRole('button', { name: 'Resolver comentario' })).toBeVisible()
    await expect(viewer.locator('pre')).toContainText('Primera línea de contexto.')
  })

  test('separates the task detail visually and provides an accessible expanded description editor', async ({ page }) => {
    const mock = await installWorkspaceMock(page)
    await page.setViewportSize({ width: 1395, height: 818 })
    await page.goto(`${baseURL}/dashboard/tasks`)
    await page.getByText('Preparar propuesta profesional', { exact: true }).click()
    const detail = page.getByRole('dialog', { name: 'Detalle de tarea' })
    const backdrop = page.locator('[data-task-detail-window]')
    await detail.getByTitle('Ventana flotante').click()
    await expect(backdrop).toHaveAttribute('data-backdrop-mode', 'floating')
    await expect(backdrop).toHaveCSS('background-color', 'rgba(2, 6, 23, 0.18)')
    await expect(backdrop).toHaveCSS('backdrop-filter', 'blur(2px)')
    await expect(detail).not.toHaveCSS('box-shadow', 'none')

    await page.getByText('Bandeja general', { exact: true }).click({ position: { x: 18, y: 12 } })
    await expect(detail).toBeVisible()
    await detail.getByTitle('Acoplar a la derecha').click()
    await expect(backdrop).toHaveCSS('background-color', 'rgba(2, 6, 23, 0.08)')
    await detail.getByTitle('Ventana flotante').click()

    const description = detail.locator('[data-task-description]')
    const grip = detail.getByRole('slider', { name: 'Ajustar altura de la descripción' })
    const beforeHeight = (await description.boundingBox())!.height
    await grip.focus()
    await page.keyboard.press('ArrowDown')
    await expect.poll(async () => (await description.boundingBox())!.height).toBeGreaterThan(beforeHeight)
    await expect(grip).toHaveAttribute('aria-valuenow', String(beforeHeight + 24))
    const gripBox = await grip.boundingBox()
    const keyboardHeight = (await description.boundingBox())!.height
    await page.mouse.move(gripBox!.x + gripBox!.width / 2, gripBox!.y + gripBox!.height / 2)
    await page.mouse.down()
    await page.mouse.move(gripBox!.x + gripBox!.width / 2, gripBox!.y + gripBox!.height / 2 + 48, { steps: 6 })
    await page.mouse.up()
    await expect.poll(async () => (await description.boundingBox())!.height).toBeGreaterThan(keyboardHeight + 30)

    await detail.getByRole('button', { name: 'Expandir descripción' }).click()
    const expanded = detail.locator('[data-task-description-expanded]')
    const expandedInput = expanded.getByRole('textbox')
    await expect(expanded).toBeVisible()
    await expandedInput.fill('Una descripción extensa que debe conservarse en ambos modos.')
    await expanded.getByRole('button', { name: 'Listo' }).click()
    await expect.poll(() => mock.taskWrites.filter(write => write.description === 'Una descripción extensa que debe conservarse en ambos modos.').length).toBe(1)
    await expect(expanded).toHaveCount(0)
    await expect(description).toHaveValue('Una descripción extensa que debe conservarse en ambos modos.')

    await detail.getByRole('button', { name: 'Expandir descripción' }).click()
    mock.failNextDescriptionWrite()
    await expanded.getByRole('textbox').fill('Borrador que sobrevive a un error temporal.')
    await expanded.getByRole('button', { name: 'Listo' }).click()
    await expect(expanded).toBeVisible()
    await expect(expanded.getByRole('alert')).toContainText('No pudimos guardar la descripción.')
    await expanded.getByRole('button', { name: 'Reintentar' }).click()
    await expect.poll(() => mock.taskWrites.filter(write => write.description === 'Borrador que sobrevive a un error temporal.').length).toBe(2)
    await expect(expanded.getByRole('alert')).toHaveCount(0)
    await expect(description).toHaveValue('Borrador que sobrevive a un error temporal.')
    await expanded.getByRole('button', { name: 'Listo' }).click()
    await expect(expanded).toHaveCount(0)

    await detail.getByTitle('Maximizar').click()
    await expect(backdrop).toHaveAttribute('data-backdrop-mode', 'modal')
    await expect(backdrop).toHaveCSS('background-color', 'rgba(2, 6, 23, 0.45)')
    await expect(detail).toHaveAttribute('aria-modal', 'true')
    await page.setViewportSize({ width: 375, height: 720 })
    await expect(backdrop).toHaveCSS('backdrop-filter', 'blur(3px)')
    const mobileBox = await detail.boundingBox()
    expect(mobileBox!.width).toBeLessThanOrEqual(375)
  })

  test('portals the column menu above cards and restores focus with Escape', async ({ page }) => {
    await installWorkspaceMock(page)
    await page.setViewportSize({ width: 1155, height: 818 })
    await page.goto(`${baseURL}/dashboard/tasks`)
    await page.getByRole('button', { name: 'Tablero' }).click()
    const trigger = page.locator('section[data-task-column-id="status-todo"]').getByTitle('Opciones de columna')
    await trigger.click()
    const menu = page.locator('[data-task-column-menu]')
    await expect(menu).toBeVisible()
    const box = await menu.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(8)
    expect(box!.y).toBeGreaterThanOrEqual(8)
    expect(box!.x + box!.width).toBeLessThanOrEqual(1147)
    expect(box!.y + box!.height).toBeLessThanOrEqual(810)
    expect(await menu.evaluate(element => Number(getComputedStyle(element).zIndex))).toBeGreaterThan(50)
    expect(await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('[data-task-column-menu]')), { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 })).toBe(true)
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(trigger).toBeFocused()
  })

  test('animates list groups accessibly and simplifies the collapsed dashboard header', async ({ page }) => {
    await installWorkspaceMock(page)
    await page.setViewportSize({ width: 1395, height: 818 })
    await page.goto(`${baseURL}/dashboard/tasks`)
    const sectionButton = page.getByRole('button', { name: /Por hacer 1/i })
    const region = page.locator('[role="region"][aria-label="Tareas en Por hacer"]')
    await expect(sectionButton).toHaveAttribute('aria-expanded', 'true')
    await sectionButton.click()
    await expect(sectionButton).toHaveAttribute('aria-expanded', 'false')
    await expect(region).toHaveAttribute('aria-hidden', 'true')
    await expect(region).toHaveAttribute('inert', '')
    await expect(region).toHaveCSS('transition-duration', '0.2s')
    await page.waitForTimeout(240)
    await expect(region).not.toBeVisible()
    await sectionButton.click()
    await expect(region).toBeVisible()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await sectionButton.click()
    await expect(region).toHaveCSS('transition-property', 'none')
    await sectionButton.click()
    await page.emulateMedia({ reducedMotion: 'no-preference' })

    await page.getByRole('button', { name: 'Colapsar menú' }).click()
    const sidebarHeader = page.locator('[data-dashboard-sidebar-header]')
    await expect(sidebarHeader).toHaveAttribute('data-collapsed', 'true')
    await expect(page.locator('[data-dashboard-brand-mark]')).toHaveCount(0)
    const expand = page.getByRole('button', { name: 'Expandir menú' })
    await expand.hover()
    await expect(page.getByRole('tooltip', { name: 'Expandir menú' })).toBeVisible()
    await expand.click()
    await expect(page.locator('[data-dashboard-brand-mark]')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Colapsar menú' })).toBeVisible()
  })

  test('creates exactly once with Ctrl/Cmd+Enter and ignores invalid or overlaid submissions', async ({ page }) => {
    const mock = await installWorkspaceMock(page)
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(`${baseURL}/dashboard/tasks`)

    await page.getByRole('button', { name: 'Nueva tarea' }).click()
    let dialog = page.getByRole('dialog', { name: 'Crear una tarea' })
    const firstTitle = dialog.getByPlaceholder('¿Qué hay que lograr?')
    await firstTitle.press('Control+Enter')
    expect(mock.createWrites).toHaveLength(0)

    await firstTitle.fill('Creación única con Control')
    await dialog.getByRole('button', { name: /Bandeja general/ }).click()
    const listbox = page.getByRole('listbox', { name: 'Seleccionar lista' })
    await expect(listbox).toBeVisible()
    const listSearch = listbox.getByPlaceholder('Buscar listas…')
    await listSearch.press('Control+Enter')
    await page.waitForTimeout(80)
    expect(mock.createWrites).toHaveLength(0)
    await listSearch.press('Escape')
    await expect(listbox).toHaveCount(0)
    await expect(dialog).toBeVisible()

    mock.setCreateDelay(180)
    await firstTitle.press('Control+Enter')
    await firstTitle.press('Control+Enter')
    await expect.poll(() => mock.createWrites.length).toBe(1)
    await expect(dialog).toHaveCount(0)

    mock.setCreateDelay(0)
    await page.getByRole('button', { name: 'Nueva tarea' }).click()
    dialog = page.getByRole('dialog', { name: 'Crear una tarea' })
    const secondTitle = dialog.getByPlaceholder('¿Qué hay que lograr?')
    await secondTitle.fill('Creación con Command')
    await secondTitle.press('Meta+Enter')
    await expect.poll(() => mock.createWrites.length).toBe(2)
    expect(mock.createWrites.map(write => write.title)).toEqual(['Creación única con Control', 'Creación con Command'])
    await expect(dialog).toHaveCount(0)
  })

  test('keeps the expanded creation draft and focus after a Ctrl+Enter conflict, then closes only after retry succeeds', async ({ page }) => {
    const mock = await installWorkspaceMock(page)
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(`${baseURL}/dashboard/tasks`)

    await page.getByRole('button', { name: 'Nueva tarea' }).click()
    const dialog = page.getByRole('dialog', { name: 'Crear una tarea' })
    await dialog.getByPlaceholder('¿Qué hay que lograr?').fill('Creación que conserva el conflicto')
    await dialog.getByRole('button', { name: 'Expandir descripción' }).click()
    const expanded = dialog.getByRole('dialog', { name: 'Editor ampliado de descripción' })
    const description = expanded.getByRole('textbox')
    await description.fill('Borrador ampliado que no puede perderse.')

    mock.failNextCreateConflict()
    await description.press('Control+Enter')
    await expect.poll(() => mock.createWrites.length).toBe(1)
    await expect(expanded).toBeVisible()
    await expect(expanded.getByRole('alert')).toContainText('La tarea cambió mientras se estaba creando.')
    await expect(description).toHaveValue('Borrador ampliado que no puede perderse.')
    await expect(description).toBeFocused()

    await description.press('Control+Enter')
    await expect.poll(() => mock.createWrites.length).toBe(2)
    await expect(dialog).toHaveCount(0)
    expect(mock.createWrites.map(write => write.description)).toEqual([
      'Borrador ampliado que no puede perderse.',
      'Borrador ampliado que no puede perderse.',
    ])
  })

  test('preserves native text paste, queues pasted images and retries only failed uploads without recreating', async ({ page }) => {
    const mock = await installWorkspaceMock(page)
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(`${baseURL}/dashboard/tasks`)
    await page.getByRole('button', { name: 'Nueva tarea' }).click()
    const dialog = page.getByRole('dialog', { name: 'Crear una tarea' })
    const title = dialog.getByPlaceholder('¿Qué hay que lograr?')

    await title.fill('Texto: ')
    await title.focus()
    expect(await dispatchTextPaste(title, 'pegado sin convertirse en archivo')).toBe(false)
    // Synthetic clipboard events intentionally do not perform the browser's
    // native insertion. The assertion above proves Work did not cancel text;
    // mirror the default insertion so the rest of the flow can continue on
    // Chromium, Firefox and WebKit without privileged clipboard permissions.
    await title.fill('Texto: pegado sin convertirse en archivo')
    await expect(title).toHaveValue('Texto: pegado sin convertirse en archivo')
    await expect(dialog.getByText('Todavía no hay archivos en la cola.')).toBeVisible()

    expect(await pasteImageFiles(dialog, ['captura-uno.png', 'captura-dos.png'])).toBe(true)
    await expect(dialog.getByText('captura-uno.png')).toBeVisible()
    await expect(dialog.getByText('captura-dos.png')).toBeVisible()
    mock.failNextAttachmentUpload()
    await title.press('Control+Enter')

    await expect.poll(() => mock.createWrites.length).toBe(1)
    await expect.poll(() => mock.attachmentUploads.length).toBe(2)
    await expect(dialog.getByText(/La tarea quedó creada correctamente/).first()).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Reintentar 1 adjunto' })).toBeVisible()
    await dialog.getByRole('button', { name: 'Reintentar 1 adjunto' }).click()

    await expect.poll(() => mock.attachmentUploads.length).toBe(3)
    expect(mock.createWrites).toHaveLength(1)
    expect(mock.attachmentUploads.map(upload => upload.filename)).toEqual(['captura-uno.png', 'captura-dos.png', 'captura-uno.png'])
    await expect(dialog).toHaveCount(0)
  })

  test('keeps preferred floating geometry through small viewports and restores the professional default on demand', async ({ page }) => {
    await installWorkspaceMock(page)
    const storageKey = 'clarin:tasks:editor-window:v3:account-work%3Auser-owner'
    await page.addInitScript(({ key }) => {
      localStorage.setItem(key, JSON.stringify({
        version: 3,
        mode: 'floating',
        restoreMode: 'floating',
        preferredGeometry: { x: 300, y: 44, width: 760, height: 620 },
      }))
    }, { key: storageKey })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${baseURL}/dashboard/tasks`)
    await page.getByRole('button', { name: 'Nueva tarea' }).click()
    const dialog = page.getByRole('dialog', { name: 'Crear una tarea' })
    await expect(dialog).toHaveAttribute('data-window-mode', 'floating')
    let box = await dialog.boundingBox()
    expect(box?.width).toBeCloseTo(760, 0)
    expect(box?.height).toBeCloseTo(620, 0)

    for (const width of [375, 320]) {
      await page.setViewportSize({ width, height: 720 })
      await expect(dialog).toHaveAttribute('data-window-mode', 'maximized')
      box = await dialog.boundingBox()
      expect(box?.width).toBeCloseTo(width, 0)
      const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key) || '{}'), storageKey)
      expect(stored.preferredGeometry).toEqual({ x: 300, y: 44, width: 760, height: 620 })
    }

    await page.setViewportSize({ width: 1440, height: 900 })
    await expect(dialog).toHaveAttribute('data-window-mode', 'floating')
    box = await dialog.boundingBox()
    expect(box?.width).toBeCloseTo(760, 0)
    expect(box?.height).toBeCloseTo(620, 0)
    await dialog.getByRole('button', { name: 'Restablecer tamaño' }).click()
    await expect.poll(async () => (await dialog.boundingBox())?.width || 0).toBeCloseTo(980, 0)
    await expect.poll(async () => (await dialog.boundingBox())?.height || 0).toBeCloseTo(820, 0)
    await expect.poll(async () => page.evaluate(key => JSON.parse(localStorage.getItem(key) || '{}').preferredGeometry, storageKey)).toEqual({ x: 230, y: 48, width: 980, height: 820 })
  })

  test('creates in a movable, resizable and dockable window and protects its draft', async ({ page }) => {
    const mock = await installWorkspaceMock(page)
    await page.setViewportSize({ width: 1398, height: 900 })
    await page.goto(`${baseURL}/dashboard/tasks`)

    await page.getByRole('button', { name: 'Nueva tarea' }).click()
    let dialog = page.getByRole('dialog', { name: 'Crear una tarea' })
    await expect(dialog).toHaveAttribute('data-window-mode', 'floating')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    await page.getByRole('button', { name: 'Nueva tarea' }).click()
    dialog = page.getByRole('dialog', { name: 'Crear una tarea' })
    const beforeMove = await dialog.boundingBox()
    const header = dialog.getByRole('heading', { name: 'Crear una tarea' }).locator('..').locator('..')
    const headerBox = await header.boundingBox()
    await page.mouse.move(headerBox!.x + 350, headerBox!.y + 28)
    await page.mouse.down()
    await page.mouse.move(headerBox!.x + 410, headerBox!.y + 62, { steps: 8 })
    await page.mouse.up()
    const afterMove = await dialog.boundingBox()
    expect(afterMove!.x).toBeGreaterThan(beforeMove!.x + 30)

    const resize = dialog.locator('[data-task-window-resize="se"]')
    const resizeBox = await resize.boundingBox()
    const beforeResize = await dialog.boundingBox()
    await page.mouse.move(resizeBox!.x + 2, resizeBox!.y + 2)
    await page.mouse.down()
    await page.mouse.move(resizeBox!.x + 42, resizeBox!.y + 32, { steps: 6 })
    await page.mouse.up()
    const afterResize = await dialog.boundingBox()
    expect(afterResize!.width).toBeGreaterThan(beforeResize!.width + 20)

    await dialog.getByRole('button', { name: 'Maximizar' }).click()
    await expect(dialog).toHaveAttribute('data-window-mode', 'maximized')
    await dialog.getByRole('button', { name: 'Restaurar' }).click()
    await expect(dialog).toHaveAttribute('data-window-mode', 'floating')
    await dialog.getByRole('button', { name: 'Acoplar a la derecha' }).click()
    await expect(dialog).toHaveAttribute('data-window-mode', 'docked')
    await dialog.getByRole('button', { name: 'Ventana flotante' }).click()

    await dialog.getByRole('button', { name: /Bandeja general/ }).click()
    const listSearch = page.getByRole('listbox', { name: 'Seleccionar lista' }).getByPlaceholder('Buscar listas…')
    await listSearch.fill('carpeta')
    await page.getByRole('option', { name: /Lista de carpeta/ }).click()
    await expect(dialog.getByRole('button', { name: /Lista de carpeta/ })).toBeVisible()

    const title = dialog.getByPlaceholder('¿Qué hay que lograr?')
    await title.fill('Tarea creada desde ventana profesional')
    await page.keyboard.press('Escape')
    const confirm = page.getByRole('alertdialog')
    await expect(confirm).toContainText('¿Descartar el borrador?')
    await confirm.getByRole('button', { name: 'Continuar editando' }).click()
    await expect(title).toHaveValue('Tarea creada desde ventana profesional')
    await dialog.getByRole('button', { name: 'Crear tarea' }).click()
    await expect.poll(() => mock.createWrites.length).toBe(1)
    expect(mock.createWrites[0]).toMatchObject({ title: 'Tarea creada desde ventana profesional', list_id: 'list-folder' })
  })

  test('removes the shared browser product without hiding web push settings', async ({ page }) => {
    await installWorkspaceMock(page)
    await page.setViewportSize({ width: 1398, height: 760 })
    await page.goto(`${baseURL}/dashboard/tasks`)
    await expect(page.getByRole('link', { name: 'Navegador', exact: true })).toHaveCount(0)
    await expect(page.locator('a[href="/dashboard/browser"]')).toHaveCount(0)
  })

  test('uses a professional archive confirmation and starts retention only from explicit deletion', async ({ page }) => {
    const mock = await installWorkspaceMock(page)
    await page.setViewportSize({ width: 1398, height: 760 })
    await page.goto(`${baseURL}/dashboard/tasks`)
    await page.getByText('Preparar propuesta profesional', { exact: true }).click()
    await page.getByTitle('Mover a Papelera').click()
    const dialog = page.getByRole('alertdialog', { name: 'Mover tarea a Papelera' })
    await expect(dialog).toContainText('Completar una tarea nunca la envía aquí')
    await dialog.getByRole('button', { name: 'Mover a Papelera' }).click()
    await expect.poll(() => mock.trashWrites.filter(write => write.path === '/api/tasks/task-refinement').length).toBe(1)
    expect(mock.trashWrites.find(write => write.path === '/api/tasks/task-refinement')?.body).toMatchObject({ version: 1 })
    expect(mock.trashWrites.find(write => write.path === '/api/tasks/task-refinement')?.body).not.toHaveProperty('completed_at')
  })

  test('manages safe retention, restoration and exact-name permanent deletion', async ({ page }) => {
    const mock = await installWorkspaceMock(page)
    await page.setViewportSize({ width: 1398, height: 760 })
    await page.goto(`${baseURL}/dashboard/tasks`)
    await page.getByTitle('Papelera').click()
    await expect(page.getByText('Solo una acción explícita de “Mover a Papelera” inicia la retención.')).toBeVisible()
    await expect(page.getByText('30 días de retención')).toBeVisible()
    await page.getByRole('button', { name: 'Nunca' }).click()
    await expect.poll(() => mock.trashWrites.some(write => write.path === '/api/tasks/trash-policy' && write.body.retention_days === null)).toBeTruthy()
    await page.getByRole('button', { name: '30 días' }).click()

    await page.getByRole('button', { name: /Listas y carpetas/ }).click()
    await expect(page.getByText('Lista archivada', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Eliminar permanentemente' }).click()
    const dialog = page.getByRole('alertdialog', { name: 'Eliminar lista permanentemente' })
    const input = dialog.getByRole('textbox')
    await input.fill('Lista equivocada')
    await expect(dialog.getByRole('button', { name: 'Eliminar permanentemente' })).toBeDisabled()
    await input.fill('Lista archivada')
    await dialog.getByRole('button', { name: 'Eliminar permanentemente' }).click()
    await expect.poll(() => mock.trashWrites.some(write => write.path === '/api/tasks/lists/list-trash/purge' && write.body.confirmation_name === 'Lista archivada')).toBeTruthy()
  })
})
