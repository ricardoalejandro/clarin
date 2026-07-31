import { expect, test, type Locator, type Page, type Route } from '@playwright/test'

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3011'
const now = '2026-07-29T12:00:00.000Z'

const statuses = [
  taskStatus('status-todo', 'Por hacer', 'not_started', '#64748b', 0, true),
  taskStatus('status-active', 'En curso', 'active', '#3b82f6', 1),
  taskStatus('status-done', 'Completada', 'done', '#10b981', 2),
  taskStatus('status-paused', 'Pausada', 'cancelled', '#f59e0b', 3),
]

function taskStatus(id: string, name: string, category: 'not_started' | 'active' | 'done' | 'cancelled', color: string, sortOrder: number, isDefault = false) {
  return {
    id,
    account_id: 'account-kanban',
    workflow_id: 'workflow-kanban',
    name,
    color,
    category,
    sort_order: sortOrder,
    is_default: isDefault,
    created_at: now,
    updated_at: now,
  }
}

function task(id: string, title: string, statusId: string, sortOrder: number) {
  const status = statuses.find(item => item.id === statusId)!
  return {
    id,
    account_id: 'account-kanban',
    created_by: 'user-kanban',
    assigned_to: 'user-kanban',
    assigned_to_name: 'Ricardo QA',
    title,
    description: '',
    type: 'reminder',
    priority: id === 'todo-1' ? 'urgent' : 'medium',
    status: status.category === 'done' ? 'completed' : status.category === 'cancelled' ? 'cancelled' : 'pending',
    status_id: status.id,
    status_detail: status,
    list_id: 'list-kanban',
    list_name: 'Operaciones QA',
    sort_order: sortOrder,
    progress: status.category === 'done' ? 100 : 0,
    version: 1,
    recurrence_rule: '',
    reminder_minutes: 0,
    notes: '',
    created_at: now,
    updated_at: now,
  }
}

function initialTasks() {
  let order = 1024
  const create = (id: string, title: string, statusId: string) => {
    const item = task(id, title, statusId, order)
    order += 1024
    return item
  }
  return [
    ...Array.from({ length: 5 }, (_, index) => create(`todo-${index + 1}`, index === 0 ? 'Tarea crítica que debe moverse' : `Pendiente ${index + 1}`, 'status-todo')),
    ...Array.from({ length: 6 }, (_, index) => create(`active-${index + 1}`, `En curso ${index + 1}`, 'status-active')),
    ...Array.from({ length: 79 }, (_, index) => create(`done-${index + 1}`, `Completada ${index + 1}`, 'status-done')),
  ]
}

type MoveMode = 'success' | 'failure' | 'conflict'

async function installTaskBoardMock(page: Page) {
  let tasks = initialTasks()
  let moveMode: MoveMode = 'success'
  const moveRequests: Array<{ taskId: string; body: Record<string, unknown> }> = []
  const bulkRequests: Array<Record<string, unknown>> = []

  await page.routeWebSocket('**/ws**', socket => {
    socket.onMessage(() => undefined)
  })
  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    let body: Record<string, unknown> = {}
    try { body = request.postDataJSON() } catch { body = {} }

    if (path === '/api/me') {
      await json(route, {
        success: true,
        user: {
          id: 'user-kanban', username: 'kanban_qa', display_name: 'Ricardo QA', role: 'admin', is_admin: true,
          is_super_admin: false, account_id: 'account-kanban', account_name: 'Cuenta Kanban', permissions: ['tasks'],
        },
        accounts: [{ account_id: 'account-kanban', account_name: 'Cuenta Kanban', account_slug: 'kanban', role: 'admin', is_default: true }],
      })
      return
    }
    if (path === '/api/tasks/hierarchy') {
      await json(route, {
        folders: [],
        root_lists: [{
          id: 'list-kanban', account_id: 'account-kanban', workflow_id: 'workflow-kanban', is_default: true,
          name: 'Operaciones QA', description: '', color: '#10b981', sort_order: 1024, created_by: 'user-kanban',
          created_at: now, updated_at: now, task_count: tasks.length,
        }],
      })
      return
    }
    if (path === '/api/tasks/workflows') {
      await json(route, {
        workflows: [{
          id: 'workflow-kanban', account_id: 'account-kanban', name: 'Flujo Kanban', is_default: true,
          created_by: 'user-kanban', created_at: now, updated_at: now, statuses,
        }],
      })
      return
    }
    if (path === '/api/account/users') {
      await json(route, { users: [{ id: 'user-kanban', username: 'kanban_qa', display_name: 'Ricardo QA', role: 'admin' }] })
      return
    }
    if (path === '/api/tasks/saved-views') {
      await json(route, { views: [] })
      return
    }
    if (path === '/api/tasks/stats') {
      await json(route, { stats: { overdue: 0, today: 0 } })
      return
    }
    if (path === '/api/tasks' && request.method() === 'GET') {
      const offset = Number(url.searchParams.get('offset') || 0)
      const limit = Number(url.searchParams.get('limit') || 200)
      await json(route, { tasks: tasks.slice(offset, offset + limit), total: tasks.length })
      return
    }

    if (path === '/api/tasks/bulk-move' && request.method() === 'POST') {
      bulkRequests.push(body)
      const itemIDs = new Set((body.items as Array<{ id: string }>).map(item => item.id))
      const category = String(body.destination_status_category || '')
      const destinationStatus = statuses.find(item => item.category === category)
      tasks = tasks.map(item => itemIDs.has(item.id) && destinationStatus ? { ...item, status_id: destinationStatus.id, status_detail: destinationStatus, status: destinationStatus.category === 'done' ? 'completed' : destinationStatus.category === 'cancelled' ? 'cancelled' : 'pending', progress: destinationStatus.category === 'done' ? 100 : 0, version: item.version + 1 } : item)
      await json(route, { success: true, operation_id: body.operation_id, tasks: tasks.filter(item => itemIDs.has(item.id)), orders: { 'list-kanban': tasks.map(item => item.id) } })
      return
    }

    const moveMatch = path.match(/^\/api\/tasks\/([^/]+)\/move$/)
    if (moveMatch && request.method() === 'POST') {
      const taskId = moveMatch[1]
      moveRequests.push({ taskId, body })
      if (moveMode === 'failure') {
        await json(route, { error: 'Fallo controlado de movimiento' }, 500)
        return
      }
      if (moveMode === 'conflict') {
        await json(route, { error: 'La tarea fue modificada' }, 409)
        return
      }
      const current = tasks.find(item => item.id === taskId)!
      const destinationStatus = statuses.find(item => item.id === body.status_id)!
      const withoutActive = tasks.filter(item => item.id !== taskId).sort((left, right) => left.sort_order - right.sort_order)
      const beforeIndex = typeof body.before_task_id === 'string' ? withoutActive.findIndex(item => item.id === body.before_task_id) : -1
      let insertAt = beforeIndex >= 0 ? beforeIndex : withoutActive.reduce((last, item, index) => item.status_detail.category === destinationStatus.category ? index : last, -1) + 1
      if (insertAt < 0) insertAt = withoutActive.length
      const previous = insertAt > 0 ? withoutActive[insertAt - 1]?.sort_order : undefined
      const following = insertAt < withoutActive.length ? withoutActive[insertAt]?.sort_order : undefined
      const sortOrder = previous === undefined && following === undefined ? 1024
        : previous === undefined ? following! / 2
          : following === undefined ? previous + 1024
            : previous + (following - previous) / 2
      const moved = {
        ...current,
        status: destinationStatus.category === 'done' ? 'completed' : destinationStatus.category === 'cancelled' ? 'cancelled' : 'pending',
        status_id: destinationStatus.id,
        status_detail: destinationStatus,
        progress: destinationStatus.category === 'done' ? 100 : 0,
        sort_order: sortOrder,
        version: current.version + 1,
        updated_at: '2026-07-29T12:05:00.000Z',
      }
      tasks = [...withoutActive, moved].sort((left, right) => left.sort_order - right.sort_order)
      await json(route, {
        task: moved,
        operation_id: body.operation_id,
        order: { list_id: 'list-kanban', task_ids: tasks.map(item => item.id) },
      })
      return
    }

    if (path.startsWith('/api/notifications')) {
      await json(route, { notifications: [], unread_count: 0, total: 0 })
      return
    }
    await json(route, { success: true })
  })

  await page.context().addCookies([{ name: 'auth-token', value: 'kanban-ui-session', url: baseURL, httpOnly: true, sameSite: 'Lax' }])
  await page.addInitScript(() => {
    localStorage.setItem('token', 'kanban-ui-session')
    localStorage.setItem('clarin:last_activity_at', String(Date.now()))
    localStorage.setItem('clarin:auth_refreshed_at', String(Date.now()))
    localStorage.setItem('tasks:view', 'board')
  })

  return {
    moveRequests,
    bulkRequests,
    setMoveMode(mode: MoveMode) { moveMode = mode },
  }
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

function card(page: Page, taskId: string) {
  return page.locator(`[data-task-id="${taskId}"]`)
}

function column(page: Page, statusId: string) {
  return page.locator(`section[data-task-column-id="${statusId}"]`)
}

async function openBoard(page: Page) {
  await page.setViewportSize({ width: 2000, height: 900 })
  await page.goto(`${baseURL}/dashboard/tasks`)
  await expect(page.getByTestId('task-board-viewport')).toBeVisible()
  await expect(column(page, 'status-todo').locator('[data-task-id]')).toHaveCount(5)
  await expect(column(page, 'status-active').locator('[data-task-id]')).toHaveCount(6)
  await expect(column(page, 'status-done').locator('[data-task-id]')).toHaveCount(79)
}

async function startMouseDrag(page: Page, source: Locator, target: Locator) {
  const activator = source.getByRole('button', { name: /^Arrastrar / })
  const dragSource = await activator.count() ? activator.first() : source
  const sourceBox = await dragSource.boundingBox()
  const targetBox = await target.boundingBox()
  expect(sourceBox).not.toBeNull()
  expect(targetBox).not.toBeNull()
  const start = { x: sourceBox!.x + sourceBox!.width / 2, y: sourceBox!.y + Math.min(28, sourceBox!.height / 2) }
  const end = { x: targetBox!.x + targetBox!.width / 2, y: targetBox!.y + Math.min(34, targetBox!.height / 2) }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 10, start.y + 8, { steps: 3 })
  await page.mouse.move(end.x, end.y, { steps: 18 })
  return end
}

test.describe('Clarin Work Kanban drag stability', () => {
  test.describe.configure({ timeout: 60_000 })

  test('keeps a cross-column drag stable while held and writes the move once', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    const mock = await installTaskBoardMock(page)
    await openBoard(page)

    const end = await startMouseDrag(page, card(page, 'todo-1'), card(page, 'active-2'))
    await expect(column(page, 'status-active').locator('[data-task-id="todo-1"]')).toHaveCount(1)

    const observedOrders = new Set<string>()
    for (let index = 0; index < 28; index += 1) {
      await page.mouse.move(end.x + (index % 2 ? 2 : -2), end.y + (index % 3 ? 1 : -1))
      observedOrders.add(await column(page, 'status-active').locator('[data-task-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-task-id')).join('|')))
      await page.waitForTimeout(120)
    }
    expect(observedOrders.size).toBe(1)
    await page.mouse.up()

    await expect.poll(() => mock.moveRequests.length).toBe(1)
    await expect(card(page, 'todo-1')).toHaveCount(1)
    await expect(column(page, 'status-active').locator('[data-task-id="todo-1"]')).toHaveCount(1)
    const activeOrder = await column(page, 'status-active').locator('[data-task-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-task-id')))
    const movedIndex = activeOrder.indexOf('todo-1')
    expect(mock.moveRequests[0].body.status_id).toBe('status-active')
    expect(mock.moveRequests[0].body.before_task_id ?? null).toBe(activeOrder[movedIndex + 1] ?? null)
    expect(errors.filter(message => /maximum update depth|react error #185|application error/i.test(message))).toEqual([])
    await expect(page.getByText('Application error: a client-side exception has occurred')).toHaveCount(0)
  })

  test('gathers a Shift range into one visual stack and performs one atomic bulk move', async ({ page }) => {
    const mock = await installTaskBoardMock(page)
    await openBoard(page)
    await card(page, 'todo-1').hover()
    await card(page, 'todo-1').getByRole('checkbox').click()
    await card(page, 'todo-3').hover()
    await card(page, 'todo-3').getByRole('checkbox').click({ modifiers: ['Shift'] })
    await expect(page.locator('[data-task-bulk-actions]')).toContainText('3')

    await startMouseDrag(page, card(page, 'todo-1'), card(page, 'active-2'))
    await expect(page.getByText('3 tareas', { exact: true })).toBeVisible()
    expect(await page.locator('[data-task-gather-ghost]').count()).toBeLessThanOrEqual(8)
    await page.mouse.up()

    await expect.poll(() => mock.bulkRequests.length).toBe(1)
    expect(mock.moveRequests).toHaveLength(0)
    expect((mock.bulkRequests[0].items as unknown[])).toHaveLength(3)
    expect(mock.bulkRequests[0].destination_status_category).toBe('active')
  })

  test('reorders once inside a column and restores a keyboard cancellation', async ({ page }) => {
    const mock = await installTaskBoardMock(page)
    await openBoard(page)

    await startMouseDrag(page, card(page, 'todo-1'), card(page, 'todo-4'))
    await page.mouse.up()
    await expect.poll(() => mock.moveRequests.length).toBe(1)
    const todoOrder = await column(page, 'status-todo').locator('[data-task-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-task-id')))
    expect(todoOrder.indexOf('todo-1')).toBeGreaterThan(0)

    const beforeCancel = await column(page, 'status-todo').locator('[data-task-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-task-id')).join('|'))
    await card(page, 'todo-2').getByRole('button', { name: /^Arrastrar / }).focus()
    await page.keyboard.press('Space')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Escape')
    await expect.poll(() => mock.moveRequests.length).toBe(1)
    await expect.poll(async () => column(page, 'status-todo').locator('[data-task-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-task-id')).join('|'))).toBe(beforeCancel)
  })

  test('persists one deterministic keyboard reorder', async ({ page }) => {
    const mock = await installTaskBoardMock(page)
    await openBoard(page)

    await card(page, 'todo-1').getByRole('button', { name: /^Arrastrar / }).focus()
    await page.keyboard.press('Space')
    await page.waitForTimeout(100)
    await page.keyboard.press('ArrowDown')
    await page.waitForTimeout(100)
    await page.keyboard.press('Space')
    await expect.poll(() => mock.moveRequests.length).toBe(1)
    const todoOrder = await column(page, 'status-todo').locator('[data-task-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-task-id')))
    expect(todoOrder.slice(0, 2)).toEqual(['todo-2', 'todo-1'])
  })

  test('rolls back a drop outside and an API conflict without duplicating cards', async ({ page }) => {
    const mock = await installTaskBoardMock(page)
    await openBoard(page)

    await startMouseDrag(page, card(page, 'todo-1'), card(page, 'active-1'))
    await page.mouse.move(4, 4, { steps: 10 })
    await page.mouse.up()
    await expect.poll(() => mock.moveRequests.length).toBe(0)
    await expect(column(page, 'status-todo').locator('[data-task-id="todo-1"]')).toHaveCount(1)
    await expect(card(page, 'todo-1')).toHaveCount(1)

    mock.setMoveMode('conflict')
    await openBoard(page)
    await startMouseDrag(page, card(page, 'todo-1'), card(page, 'active-1'))
    await page.mouse.up()
    await expect.poll(() => mock.moveRequests.length).toBe(1)
    await expect(page.getByText(/La tarea cambió en otra sesión/).first()).toBeVisible()
    await expect(column(page, 'status-todo').locator('[data-task-id="todo-1"]')).toHaveCount(1)
    await expect(card(page, 'todo-1')).toHaveCount(1)

    mock.setMoveMode('failure')
    await openBoard(page)
    await startMouseDrag(page, card(page, 'todo-1'), card(page, 'active-1'))
    await page.mouse.up()
    await expect.poll(() => mock.moveRequests.length).toBe(2)
    await expect(page.getByText('Fallo controlado de movimiento').first()).toBeVisible()
    await expect(column(page, 'status-todo').locator('[data-task-id="todo-1"]')).toHaveCount(1)
    await expect(card(page, 'todo-1')).toHaveCount(1)
  })

  test('moves into an empty column even when that column starts collapsed', async ({ page }) => {
    const mock = await installTaskBoardMock(page)
    await openBoard(page)

    const paused = column(page, 'status-paused')
    await paused.getByTitle('Opciones de columna').click()
    await page.getByRole('menuitem', { name: 'Contraer columna' }).click()
    await expect(paused).toHaveAttribute('data-task-column-collapsed', 'true')

    await startMouseDrag(page, card(page, 'todo-1'), paused)
    await page.waitForTimeout(250)
    await page.mouse.up()
    await expect.poll(() => mock.moveRequests.length).toBe(1)
    expect(mock.moveRequests[0].body.status_id).toBe('status-paused')
    await column(page, 'status-paused').getByTitle('Expandir Pausada').click()
    await expect(column(page, 'status-paused').locator('[data-task-id="todo-1"]')).toHaveCount(1)
    await expect(card(page, 'todo-1')).toHaveCount(1)
  })

  test('pans horizontally with Ctrl or the middle button without opening or moving cards', async ({ page }) => {
    const mock = await installTaskBoardMock(page)
    await page.setViewportSize({ width: 1100, height: 720 })
    await page.goto(`${baseURL}/dashboard/tasks`)
    const viewport = page.getByTestId('task-board-viewport')
    await expect(viewport).toBeVisible()
    await viewport.evaluate(element => { element.scrollLeft = 180 })
    const box = await viewport.boundingBox()
    expect(box).not.toBeNull()

    await page.keyboard.down('Control')
    await page.mouse.move(box!.x + 300, box!.y + 80)
    await page.mouse.down()
    await page.mouse.move(box!.x + 220, box!.y + 80, { steps: 6 })
    await page.mouse.up()
    await page.keyboard.up('Control')
    const afterCtrl = await viewport.evaluate(element => element.scrollLeft)
    expect(afterCtrl).toBeGreaterThan(240)

    await page.mouse.move(box!.x + 300, box!.y + 120)
    await page.mouse.down({ button: 'middle' })
    await page.mouse.move(box!.x + 240, box!.y + 120, { steps: 6 })
    await page.mouse.up({ button: 'middle' })
    const afterMiddle = await viewport.evaluate(element => element.scrollLeft)
    expect(afterMiddle).toBeGreaterThan(afterCtrl)
    expect(mock.moveRequests).toHaveLength(0)
    await expect(page.getByRole('dialog', { name: 'Detalle de tarea' })).toHaveCount(0)
  })

  test('keeps full-height drop targets but limits tint to real column content with edge breathing room', async ({ page }) => {
    await installTaskBoardMock(page)
    await openBoard(page)
    const viewport = page.getByTestId('task-board-viewport')
    const firstColumn = column(page, 'status-todo')
    const emptyColumn = column(page, 'status-paused')
    const [viewportBox, firstBox, emptyBox, emptySurfaceBox] = await Promise.all([
      viewport.boundingBox(), firstColumn.boundingBox(), emptyColumn.boundingBox(), emptyColumn.locator('[data-task-column-surface]').boundingBox(),
    ])
    expect(firstBox!.x - viewportBox!.x).toBeGreaterThanOrEqual(12)
    expect(emptySurfaceBox!.height).toBeLessThan(emptyBox!.height / 2)
    await expect(emptyColumn.getByRole('button', { name: 'Agregar tarea' })).toBeVisible()
  })
})
