import { expect, test, type Page, type Route } from '@playwright/test'

const baseURL = 'http://127.0.0.1:3011'
const userID = 'user-ricardo'
const accountID = 'account-proyectos'

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function mockAdmin(page: Page) {
  let assignmentGets = 0
  let assignmentWrites = 0
  let refreshes = 0
  let role = 'admin'

  await page.addInitScript(() => {
    const now = String(Date.now())
    localStorage.setItem('token', 'cookie-session')
    localStorage.setItem('clarin:auth_refreshed_at', now)
    localStorage.setItem('clarin:last_activity_at', now)
  })
  await page.context().addCookies([{
    name: 'refresh-token',
    value: 'playwright-refresh-session',
    url: baseURL,
    httpOnly: true,
    sameSite: 'Lax',
  }])

  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    const path = url.pathname
    const method = route.request().method()

    if (path === '/api/me') return json(route, {
      success: true,
      user: { id: userID, username: 'ricardo', display_name: 'ricardo rojas', email: 'ricardo@example.test', role: 'super_admin', is_admin: true, is_super_admin: true, is_active: true, account_id: 'account-personal', account_name: 'Ricardo_Personal', permissions: ['*'] },
      accounts: [{ account_id: 'account-personal', account_name: 'Ricardo_Personal', role: 'super_admin', is_default: true }],
    })
    if (path === '/api/auth/refresh') {
      refreshes += 1
      return json(route, { success: true })
    }
    if (path === '/api/admin/accounts') return json(route, { success: true, accounts: [{ id: accountID, name: 'Proyectos', slug: 'proyectos', plan: 'pro', max_devices: 5, storage_limit_bytes: 0, is_active: true, user_count: 1, device_count: 0, chat_count: 0, created_at: new Date().toISOString() }] })
    if (path === '/api/admin/users') return json(route, { success: true, users: [{ id: userID, account_id: 'account-personal', username: 'ricardo', email: 'ricardo@example.test', display_name: 'ricardo rojas', role: 'super_admin', is_admin: true, is_super_admin: true, is_active: true, account_name: 'Ricardo_Personal', accounts: [{ account_id: accountID, account_name: 'Proyectos', role, is_default: false }], created_at: new Date().toISOString() }] })
    if (path === `/api/admin/users/${userID}/accounts` && method === 'GET') {
      assignmentGets += 1
      return json(route, { success: true, accounts: [{ account_id: accountID, account_name: 'Proyectos', role, is_default: false }] })
    }
    if (path === `/api/admin/users/${userID}/accounts` && method === 'POST') {
      assignmentWrites += 1
      const body = route.request().postDataJSON() as { role: string }
      role = body.role
      return json(route, { success: true, accounts: [{ account_id: accountID, account_name: 'Proyectos', role, is_default: false }], session_refresh_required: true })
    }
    if (path === '/api/admin/plans') return json(route, { success: true, plans: [] })
    if (path === '/api/admin/roles') return json(route, { success: true, roles: [] })
    if (path === '/api/admin/storage/orphans') return json(route, {
      success: true,
      summary: {
        total_objects: 0,
        total_bytes: 0,
        deleted_account_orphans: { objects: 0, bytes: 0 },
        active_account_orphans: { objects: 0, bytes: 0 },
        active_eligible_orphans: { objects: 0, bytes: 0 },
      },
    })
    if (path === '/api/admin/mcp/clients') return json(route, { success: true, clients: [] })
    if (path === '/api/admin/mcp/sessions') return json(route, { success: true, sessions: [] })
    if (path === '/api/admin/mcp/audit') return json(route, { success: true, events: [] })
    if (path === '/api/admin/eros/settings') return json(route, { success: true, settings: {} })
    if (path === '/api/admin/eros/openai/status') return json(route, { success: true, connection: { connected: false, login: { status: 'idle' } } })
    if (path === '/api/eros/status') return json(route, { success: true })
    if (path === '/api/tasks/stats') return json(route, { success: true, stats: {} })
    if (path === '/api/version') return json(route, { version: 'test' })
    return json(route, { success: true })
  })

  return {
    counts: () => ({ assignmentGets, assignmentWrites, refreshes }),
  }
}

test('editar el propio rol renueva la sesión una vez y conserva el modal', async ({ page }) => {
  const admin = await mockAdmin(page)
  const nativeDialogs: string[] = []
  page.on('dialog', dialog => {
    nativeDialogs.push(dialog.message())
    void dialog.dismiss()
  })

  await page.goto(`${baseURL}/dashboard/admin`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /Usuarios/ }).click()
  await page.getByTitle('Gestionar cuentas').click()
  await expect(page.getByRole('heading', { name: 'Cuentas de ricardo rojas' })).toBeVisible()

  await page.getByRole('button', { name: 'Cambiar rol en Proyectos' }).click()
  await page.locator('label').filter({ hasText: /^Rol/ }).locator('select').selectOption('super_admin')
  await page.getByRole('button', { name: 'Guardar' }).click()

  await expect(page.getByRole('status')).toContainText('Rol actualizado correctamente')
  await expect(page.locator('span').filter({ hasText: /^Super Admin$/ }).last()).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Cuentas de ricardo rojas' })).toBeVisible()
  expect(admin.counts()).toEqual({ assignmentGets: 1, assignmentWrites: 1, refreshes: 1 })
  expect(nativeDialogs).toEqual([])
})
