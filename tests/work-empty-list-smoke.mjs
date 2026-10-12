import { chromium, expect as baseExpect } from '@playwright/test'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const expect = baseExpect.configure({ timeout: 30000 })
const origin = 'http://127.0.0.1:56441'
const backend = 'http://127.0.0.1:56440'
const output = '/tmp/clarin-work-empty-preview-artifacts'
mkdirSync(output, { recursive: true })
const env = Object.fromEntries(readFileSync('/tmp/clarin-events-preview.env', 'utf8').trim().split('\n').map(line => {
  const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]
}))
if (!env.DATABASE_URL?.includes('/events_experience_qa?')) throw Error('Only disposable events QA database is allowed')
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
let page, environment, source, destination, task
const checks = [], errors = [], snapshots = []
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', bypassCSP: true })
  const login = await context.request.post(backend + '/api/auth/login', { data: { username: env.ADMIN_USER, password: env.ADMIN_PASSWORD } })
  if (!login.ok()) { const failure = await login.json().catch(() => ({})); throw Error('QA login failed ' + login.status() + ' code ' + (failure.code || 'unspecified')) }
  const request = async (method, path, data) => {
    const response = await context.request.fetch(backend + path, { method, ...(data ? { data } : {}) })
    const result = await response.json().catch(() => ({}))
    if (!response.ok() || !result.success) throw Error('Synthetic Work fixture API failed: ' + method + ' ' + path + ' status ' + response.status() + ' code ' + (result.code || 'unspecified'))
    return result
  }
  const stamp = Date.now()
  environment = (await request('POST', '/api/tasks/environments', { name: 'Work vacío QA ' + stamp, color: '#6366F1', icon: 'layers', operation_id: randomUUID() })).environment
  source = (await request('POST', '/api/tasks/lists', { environment_id: environment.id, name: 'Origen QA ' + stamp, color: '#059669', icon: 'list' })).list
  destination = (await request('POST', '/api/tasks/lists', { environment_id: environment.id, name: 'Destino QA ' + stamp, color: '#2563EB', icon: 'list' })).list
  task = (await request('POST', '/api/tasks/', { title: 'Única tarea QA ' + stamp, list_id: source.id, operation_id: randomUUID() })).task
  const listAPI = id => request('GET', '/api/tasks/?environment_id=' + environment.id + '&list_id=' + id + '&limit=50')
  const original = await listAPI(source.id), empty = await listAPI(destination.id)
  expect(original.tasks).toHaveLength(1); expect(original.total).toBe(1)
  expect(empty.tasks).toEqual([]); expect(empty.total).toBe(0)
  checks.push('QA only: browser /ws routes to isolated ingress port 56440 because Next dev does not proxy WebSockets')
  checks.push('Actor-scoped API returns tasks=[] and total=0 for an empty synthetic list')
  console.log('Work synthetic Entorno, two lists and one task created in disposable QA')
  await context.addInitScript(({ backend }) => {
    // Next dev does not proxy /ws. Route the test browser to the isolated QA
    // ingress, matching the production proxy without changing product code.
    const NativeWebSocket = window.WebSocket
    window.WebSocket = class extends NativeWebSocket {
      constructor(url, protocols) {
        const requested = new URL(url, window.location.href)
        if (requested.pathname === '/ws' && requested.host === window.location.host) {
          requested.host = new URL(backend).host
        }
        super(requested.toString(), protocols)
      }
    }
    localStorage.setItem('token', 'cookie-session')
    localStorage.setItem('clarin:last_activity_at', String(Date.now()))
    localStorage.setItem('clarin:auth_refreshed_at', String(Date.now()))
  }, { backend })
  page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', async response => {
    try {
      const url = new URL(response.url())
      if (url.pathname.replace(/\/$/, '') !== '/api/tasks') return
      const id = url.searchParams.get('list_id')
      if (id !== source.id && id !== destination.id) return
      const body = await response.json()
      snapshots.push({ listID: id, status: response.status(), tasksArray: Array.isArray(body.tasks), taskCount: body.tasks?.length ?? null, total: body.total })
    } catch {}
  })
  await page.goto(origin + '/dashboard/tasks', { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.getByRole('button', { name: /^Entorno / }).first().click({ timeout: 120000 })
  await page.getByRole('dialog', { name: 'Seleccionar Entorno' }).getByText(environment.name, { exact: true }).click()
  const sourceNav = page.locator('[data-task-hierarchy-list="' + source.id + '"]')
  const destinationNav = page.locator('[data-task-hierarchy-list="' + destination.id + '"]')
  await expect(sourceNav).toBeVisible({ timeout: 120000 })
  await sourceNav.getByRole('button').first().click()
  const listView = page.getByRole('button', { name: 'Lista', exact: true })
  if (await listView.count()) await listView.click()
  const taskRow = page.locator('[data-task-list-row="' + task.id + '"]')
  await expect(taskRow).toBeVisible({ timeout: 120000 })
  await page.screenshot({ path: output + '/01-source-one-task.png', fullPage: true })
  await destinationNav.getByRole('button').first().click()
  await expect(page.getByRole('heading', { name: destination.name, exact: true })).toBeVisible()
  await expect(taskRow).toHaveCount(0)
  await expect(page.getByText('No hay tareas para esta vista.', { exact: true })).toBeVisible()
  await expect(destinationNav.getByLabel('0 tareas abiertas', { exact: true })).toBeVisible()
  await page.screenshot({ path: output + '/02-switch-empty.png', fullPage: true })
  checks.push('Switching from populated to empty list clears prior rows and shows zero badge without a crash')
  await sourceNav.getByRole('button').first().click()
  await expect(taskRow).toBeVisible()
  const moved = await request('POST', '/api/tasks/bulk-move', { items: [{ id: task.id, version: task.version }], destination_list_id: destination.id, operation_id: randomUUID() })
  expect(moved.tasks).toHaveLength(1)
  expect(moved.tasks[0].list_id).toBe(destination.id)
  await expect(taskRow).toHaveCount(0, { timeout: 60000 })
  await expect(page.getByText('No hay tareas para esta vista.', { exact: true })).toBeVisible()
  const nowEmpty = await listAPI(source.id)
  expect(nowEmpty.tasks).toEqual([]); expect(nowEmpty.total).toBe(0)
  await expect(sourceNav.getByLabel('0 tareas abiertas', { exact: true })).toBeVisible()
  await page.screenshot({ path: output + '/03-last-task-moved.png', fullPage: true })
  checks.push('Moving the last task via canonical API removes it through WebSocket while source stays open; API tasks=[] total=0 and UI zero badge')
  await destinationNav.getByRole('button').first().click()
  await expect(taskRow).toBeVisible()
  await sourceNav.getByRole('button').first().click()
  await expect(taskRow).toHaveCount(0)
  await expect(page.getByText('No hay tareas para esta vista.', { exact: true })).toBeVisible()
  expect(errors.filter(error => /tasks.*not iterable/i.test(error))).toEqual([])
  expect(errors).toEqual([])
  expect(snapshots.some(item => item.listID === source.id && item.total === 0 && item.taskCount === 0 && item.tasksArray)).toBeTruthy()
  checks.push('Destination contains the moved task; returning to empty source shows no stale rows and no browser errors')
  writeFileSync(output + '/result.json', JSON.stringify({ passed: true, environmentID: environment.id, sourceListID: source.id, destinationListID: destination.id, taskID: task.id, checks, snapshots, errors }, null, 2))
  console.log('Work empty-list browser/API smoke passed: no stale rows, total=0, no iterable exception')
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: output + '/failure.png', fullPage: true, timeout: 10000 }).catch(() => {})
  writeFileSync(output + '/result.json', JSON.stringify({ passed: false, environmentID: environment?.id, sourceListID: source?.id, destinationListID: destination?.id, taskID: task?.id, checks, snapshots, errors, failure: String(error) }, null, 2))
  throw error
} finally {
  await browser.close()
}
