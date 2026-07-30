import { expect, test, type Locator, type Page, type Route } from '@playwright/test'

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3011'
const now = '2026-07-30T12:00:00.000Z'

const todoStatus = { id: 'status-todo', account_id: 'account-work', workflow_id: 'workflow-main', name: 'Por hacer', color: '#64748b', category: 'not_started', sort_order: 0, is_default: true, created_at: now, updated_at: now }
const activeStatus = { id: 'status-active', account_id: 'account-work', workflow_id: 'workflow-main', name: 'En curso', color: '#3b82f6', category: 'active', sort_order: 1, is_default: false, created_at: now, updated_at: now }
const doneStatus = { id: 'status-done', account_id: 'account-work', workflow_id: 'workflow-main', name: 'Completada', color: '#10b981', category: 'done', sort_order: 2, is_default: false, created_at: now, updated_at: now }
const statuses = [todoStatus, activeStatus, doneStatus]

function list(id: string, name: string, folderId = '', order = 1024, taskCount = 0, isDefault = false) {
  return { id, account_id: 'account-work', folder_id: folderId || undefined, workflow_id: 'workflow-main', workflow_inherited: Boolean(folderId), is_default: isDefault, name, description: '', color: isDefault ? '#10b981' : '#3b82f6', icon: isDefault ? 'inbox' : 'list', sort_order: order, created_by: 'user-owner', created_at: now, updated_at: now, task_count: taskCount }
}

function makeTask() {
  return {
    id: 'task-refinement', account_id: 'account-work', created_by: 'user-owner', assigned_to: 'user-owner', assigned_to_name: 'Ricardo Rojas',
    title: 'Preparar propuesta profesional', description: '', type: 'reminder', priority: 'medium', status: 'pending', status_id: todoStatus.id,
    status_detail: todoStatus, list_id: 'list-work', list_name: 'Trabajo principal', sort_order: 1024, progress: 0, version: 1,
    recurrence_rule: '', reminder_minutes: 0, notes: '', created_at: now, updated_at: now,
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
      icon: 'folder', created_by: 'user-owner', created_at: now, updated_at: now, task_count: 0, lists: [list('list-folder', 'Lista de carpeta', 'folder-client', 1024)],
    }, {
      id: 'folder-beta', account_id: 'account-work', workflow_id: 'workflow-main', name: 'Cliente Beta', description: '', color: '#f59e0b', sort_order: 2048,
      icon: 'briefcase', created_by: 'user-owner', created_at: now, updated_at: now, task_count: 0, lists: [],
    }],
    root_lists: [list('list-default', 'Bandeja general', '', 0, 0, true), list('list-work', 'Trabajo principal', '', 2048, 1)],
  }
  const structureWrites: Array<Record<string, unknown>> = []
  const folderStructureWrites: Array<{ folderId: string; body: Record<string, unknown> }> = []
  const appearanceWrites: Array<{ path: string; body: Record<string, unknown> }> = []
  const collaboratorWrites: Array<Record<string, unknown>> = []
  const taskWrites: Array<Record<string, unknown>> = []
  const createWrites: Array<Record<string, unknown>> = []
  const taskQueries: Array<{ search: string; at: number }> = []
  const trashWrites: Array<{ path: string; method: string; body: Record<string, unknown> }> = []

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
      taskQueries.push({ search, at: Date.now() })
      const activeItems = [task, ...createdTasks].filter(item => !search || `${item.title} ${item.description}`.toLocaleLowerCase().includes(search))
      const items = url.searchParams.get('deleted') === 'true' ? trashTasks : activeItems
      await json(route, { tasks: items, total: items.length }); return
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
      const status = statuses.find(item => item.id === body.status_id)
      task = { ...task, ...body, version: task.version + 1, ...(status ? { status_id: status.id, status_detail: status } : {}) }
      await json(route, { task })
      return
    }
    if (path === '/api/tasks' && request.method() === 'POST') {
      createWrites.push(body)
      const created = { ...makeTask(), ...body, id: `task-created-${createdTasks.length + 1}`, title: String(body.title || ''), version: 1, collaborators: [] }
      createdTasks = [created, ...createdTasks]
      await json(route, { task: created, operation_id: body.operation_id }, 201)
      setTimeout(() => workspaceSocket?.send(JSON.stringify({ event: 'task_update', data: { action: 'created', task: created, operation_id: body.operation_id } })), 20)
      return
    }
    if (path === `/api/tasks/${task.id}`) { await json(route, { task }); return }
    if (path === `/api/tasks/${task.id}/children`) { await json(route, { tasks: [] }); return }
    if (path === `/api/tasks/${task.id}/comments`) { await json(route, { comments: [], total: 0, limit: 100, offset: 0 }); return }
    if (path === `/api/tasks/${task.id}/activity`) { await json(route, { activity: [] }); return }
    if (path === `/api/tasks/${task.id}/attachments`) { await json(route, { attachments: [] }); return }
    if (path === `/api/tasks/${task.id}/dependencies`) { await json(route, { dependencies: [] }); return }
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

  return { structureWrites, folderStructureWrites, appearanceWrites, collaboratorWrites, taskWrites, createWrites, trashWrites, taskQueries }
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
  await page.waitForTimeout(180)
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

test.describe('Clarin Work workspace refinement', () => {
  test.describe.configure({ timeout: 60_000 })

  test('moves a list into a folder once and keeps the default list locked', async ({ page }) => {
    const mock = await installWorkspaceMock(page)
    await page.setViewportSize({ width: 1398, height: 504 })
    await page.goto(`${baseURL}/dashboard/tasks`)
    await expect(page.getByText('Trabajo principal', { exact: true }).first()).toBeVisible()
    await expect(page.getByTitle('La Bandeja general permanece fija en la raíz')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Mover Bandeja general' })).toHaveCount(0)

    await drag(page, page.getByRole('button', { name: 'Mover Trabajo principal' }), page.getByRole('button', { name: 'Cliente Alfa 0' }))
    await expect.poll(() => mock.structureWrites.length).toBe(1)
    expect(mock.structureWrites[0]).toMatchObject({ folder_id: 'folder-client', before_list_id: null, workflow_inherited: true })
    await expect(page.locator('[data-task-hierarchy-container="container:folder-client"] [data-task-hierarchy-list="list-work"]')).toBeVisible()
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
    await dialog.getByRole('button', { name: 'Color #f97316' }).click()
    await dialog.getByRole('button', { name: 'Objetivo' }).click()
    await dialog.getByRole('button', { name: 'Guardar cambios' }).click()
    await expect.poll(() => mock.appearanceWrites.length).toBe(1)
    expect(mock.appearanceWrites[0].body).toMatchObject({ name: 'Seguimiento comercial', color: '#f97316', icon: 'target' })
    await expect(page.getByText('Seguimiento comercial', { exact: true })).toBeVisible()
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

  test('keeps the workspace full-bleed and contained across responsive widths', async ({ page }) => {
    await installWorkspaceMock(page)
    for (const width of [1398, 1024, 768, 375]) {
      await page.setViewportSize({ width, height: width === 375 ? 720 : 504 })
      await page.goto(`${baseURL}/dashboard/tasks`)
      await expect(page.locator('[data-task-view-tabs]')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Lista', exact: true })).toBeVisible()
      await expect(page.locator('[data-task-workspace-canvas]')).toBeVisible()
      const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth)
      expect(documentWidth).toBeLessThanOrEqual(width)
    }
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
    const listSearch = page.getByRole('listbox', { name: 'Seleccionar lista' }).getByPlaceholder('Buscar…')
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
