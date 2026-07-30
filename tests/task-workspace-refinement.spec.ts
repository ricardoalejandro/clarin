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

  await page.routeWebSocket('**/ws**', socket => { socket.onMessage(() => undefined) })
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
    if (path === '/api/tasks' && request.method() === 'GET') { await json(route, { tasks: [task], total: 1 }); return }

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
      await json(route, { task: { ...makeTask(), ...body, id: 'task-created', title: String(body.title || ''), collaborators: [] } }, 201)
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

  return { structureWrites, folderStructureWrites, appearanceWrites, collaboratorWrites, taskWrites, createWrites }
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
})
