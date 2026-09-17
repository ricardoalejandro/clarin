import { test, expect, type BrowserContext, type Page, type TestInfo } from '@playwright/test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

// Real browser + real isolated API, database, signer and sync. No production
// origin, account or token is accepted. No native service/installer is involved.
test.use({ trace: 'off', video: 'off', actionTimeout: 30_000, navigationTimeout: 30_000 })
type Credential = { username: string; password: string }
let credentials: { admin: Credential; users: Credential[] }
let fixtures: { run_id: string; state: string; steps: Record<string, { value: Record<string, string> }> }
let runID: string
let labOrigin: string
let labRoot: string
let labRequest: (path: string, options?: Record<string, unknown>) => Promise<{ status: number; text: string }>

test.beforeAll(async () => {
  const lab = await import('../scripts/offline/browser-qa-environment.mjs')
  labOrigin = lab.labOrigin; labRoot = lab.labRoot; labRequest = lab.labRequest
  const { verifyLabIdentity } = lab
  const marker = await verifyLabIdentity()
  runID = marker.run_id
  credentials = JSON.parse(await readFile(join(labRoot, 'credentials.json'), 'utf8'))
  fixtures = JSON.parse(await readFile(join(labRoot, 'fixtures.json'), 'utf8'))
  if (fixtures.run_id !== runID || fixtures.state !== 'complete' || credentials.users.length !== 10 || !credentials.users.every(user => /^offlineqa_user_\d{2}$/.test(user.username))) throw new Error('Exact synthetic fixtures are required')
})

async function faults(value: { unavailable?: boolean; cloudflare?: boolean; lost_ack?: boolean; sync_unavailable?: boolean; reset_sync_metrics?: boolean }) {
  const result = await labRequest('/__offline-v4-qa/control', { method: 'POST', headers: { 'X-QA-Run': runID }, body: value })
  if (result.status !== 204) throw new Error('Isolated gateway fault control failed')
}
test.afterEach(async () => { await faults({ unavailable: false, cloudflare: false, lost_ack: false, sync_unavailable: false }) })

async function guardContext(context: BrowserContext, forbidden: string[]) {
  context.on('response', response => {
    const path = new URL(response.url()).pathname
    if (path.startsWith('/api/offline/v4/') && !response.ok()) {
      void response.json().then(body => console.log('QA offline HTTP failure:', JSON.stringify({ path, status: response.status(), code: typeof body.error === 'string' ? body.error : typeof body.code === 'string' ? body.code : 'unknown' }))).catch(() => {})
    }
  })
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== labOrigin && url.origin !== 'https://challenges.cloudflare.com') {
      forbidden.push(`${url.origin}${url.pathname}`)
      await route.abort('blockedbyclient')
    } else await route.continue()
  })
}

async function failureState(context: BrowserContext) {
  for (const page of context.pages()) {
    if (page.isClosed()) continue
    const pathname = new URL(page.url()).pathname
    // Never dump form inputs, cookies, query strings or raw network bodies.
    const alerts = await page.getByRole('alert').allTextContents().catch(() => [])
    console.log('QA failure surface:', JSON.stringify({ pathname, alerts: alerts.map(text => text.slice(0, 220)) }))
  }
}

async function grantDurableStorage(context: BrowserContext, page: Page) {
  const target = await context.newCDPSession(page)
  const { targetInfo } = await target.send('Target.getTargetInfo')
  await target.detach()
  const browser = context.browser()
  if (!browser) throw new Error('Real browser-level permission scope is required')
  // A page-scoped CDP override is revoked when that page closes. Keep the real
  // permission in a browser session for this disposable QA context's lifetime.
  const cdp = await browser.newBrowserCDPSession()
  await cdp.send('Browser.grantPermissions', { origin: labOrigin, browserContextId: targetInfo.browserContextId, permissions: ['durableStorage'] })
  context.once('close', () => { void cdp.detach().catch(() => {}) })
}

async function login(page: Page, credential: Credential, existingPage = false) {
  console.log('QA stage: online login started')
  if (!existingPage) await page.goto(`${labOrigin}/login?offline_fresh_login=1`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByPlaceholder('usuario o correo')).toBeVisible()
  const security = await page.request.get(`${labOrigin}/api/public/security-config`)
  const config = await security.json()
  if (config.login_turnstile_required) await expect.poll(async () => page.locator('input[name="cf-turnstile-response"]').inputValue().catch(() => ''), { timeout: 30_000, message: 'Official Turnstile test widget must complete' }).not.toBe('')
  // The real widget is rendered by a React effect: wait for hydration before
  // typing, otherwise SSR inputs can be replaced while Playwright fills them.
  // Credentials stay in ignored fixtures and memory; failures never echo them.
  try {
    await page.getByPlaceholder('usuario o correo').fill(credential.username)
    await page.getByPlaceholder('tu contraseña').fill(credential.password)
  } catch { throw new Error('The QA login fields were unavailable') }
  const response = page.waitForResponse(reply => new URL(reply.url()).pathname === '/api/auth/login' && reply.request().method() === 'POST', { timeout: 30_000 })
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click()
  const loginResponse = await response
  console.log('QA stage: real online login response', JSON.stringify({ status: loginResponse.status(), trusted: loginResponse.headers()['x-clarin-response'] === '1' }))
  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/, { timeout: 30_000 })
  console.log('QA stage: online login complete')
}

async function settings(page: Page) {
  console.log('QA stage: settings started')
  await page.goto(`${labOrigin}/dashboard/settings`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Offline', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Clarin offline, en este navegador' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Solicitar acceso offline', exact: true })).toBeEnabled({ timeout: 30_000 })
  console.log('QA stage: settings ready')
}

async function requestAndApprove(page: Page, admin: Page, accountNames: string[], writeTasks = false) {
  console.log('QA stage: requesting access')
  await page.getByRole('button', { name: 'Solicitar acceso offline', exact: true }).click()
  await expect(page.getByText('Pendiente de aprobación', { exact: true })).toBeVisible({ timeout: 30_000 })
  // SharedWorker responses do not belong to page.waitForResponse. Read only
  // the already-created public profile ID after the canonical UI confirms it.
  const profileID = await page.evaluate(() => new Promise<string>((resolve, reject) => {
    const open = indexedDB.open('clarin-offline-v4', 1)
    open.onsuccess = () => {
      const database = open.result
      const read = database.transaction('profiles', 'readonly').objectStore('profiles').get('active')
      read.onsuccess = () => { const id = read.result?.browser_id; database.close(); resolve(id) }
      read.onerror = () => { database.close(); reject(new Error('Cannot read the public QA browser ID')) }
    }
    open.onerror = () => reject(new Error('Cannot open the prepared QA profile'))
  }))
  console.log('QA stage: access requested; reviewing approval')
  expect(profileID).toMatch(/^[a-f0-9-]{36}$/)
  await admin.goto(`${labOrigin}/dashboard/admin`, { waitUntil: 'domcontentloaded' })
  await admin.getByRole('button', { name: 'Offline', exact: true }).click()
  const requestRow = admin.locator('article').filter({ hasText: profileID }).filter({ has: admin.getByRole('button', { name: 'Revisar', exact: true }) })
  await requestRow.getByRole('button', { name: 'Revisar', exact: true }).click()
  const dialog = admin.getByRole('dialog', { name: 'Aprobar acceso offline' })
  for (const name of accountNames) {
    const account = dialog.getByRole('group', { name, exact: true })
    await account.getByRole('checkbox', { name: 'Autorizar esta cuenta', exact: true }).check()
    for (const permission of ['Leer tareas', 'Leer contactos', 'Leer programas', 'Leer pizarras', ...(writeTasks ? ['Crear tareas', 'Completar tareas'] : [])]) await account.getByRole('checkbox', { name: permission, exact: true }).check()
  }
  await dialog.getByRole('button', { name: 'Aprobar cuentas seleccionadas' }).click()
  await expect(dialog).not.toBeVisible()
  await expect(page.getByRole('group', { name: 'Cuentas autorizadas' }).getByRole('button', { name: accountNames[0], exact: true })).toBeVisible({ timeout: 30_000 })
  console.log('QA stage: approval visible to user')
  return profileID
}

async function prepareAccount(page: Page, credential: Credential, accountName: string, allModules: boolean, taskLabel: string | RegExp = /Lista QA 1/) {
  console.log('QA stage: selecting and preparing resources')
  await page.getByRole('group', { name: 'Cuentas autorizadas' }).getByRole('button', { name: accountName, exact: true }).click()
  await expect(page.getByRole('heading', { name: '2. Elige qué sincronizar' })).toBeVisible()
  for (const module of allModules ? ['Tareas', 'Contactos', 'Programas', 'Pizarras'] : ['Contactos']) {
    console.log(`QA stage: selecting module ${module}`)
    await page.getByRole('group', { name: 'Tipo de recurso' }).getByRole('button', { name: module, exact: true }).click()
    const candidates = page.getByRole('region', { name: 'Acceso offline en este navegador' }).getByRole('checkbox')
    await expect(candidates.first()).toBeVisible({ timeout: 30_000 })
    if (module === 'Tareas') await page.getByRole('checkbox', { name: taskLabel }).check()
    else await candidates.first().check()
  }
  try {
    await page.getByLabel('Contraseña de Clarin', { exact: true }).fill(credential.password)
    await page.getByLabel('Repetir contraseña', { exact: true }).fill(credential.password)
  } catch { throw new Error('The QA preparation credential fields were unavailable') }
  await page.getByRole('button', { name: 'Preparar acceso offline', exact: true }).click()
  const ready = page.getByText(/^Copia verificada y lista\./)
  const failure = page.getByRole('region', { name: 'Acceso offline en este navegador' }).locator(':scope > [role="alert"]')
  const outcome = await Promise.race([
    ready.waitFor({ state: 'visible', timeout: 120_000 }).then(() => 'ready'),
    failure.waitFor({ state: 'visible', timeout: 120_000 }).then(() => 'failure'),
  ])
  if (outcome === 'failure') throw new Error(`QA preparation rejected: ${(await failure.innerText()).slice(0, 220)}`)
  await expect(ready).toBeVisible()
  await expect(page.getByRole('button', { name: 'Entrar en modo offline', exact: true })).toBeEnabled()
  console.log('QA stage: encrypted copy and offline shell ready')
}

async function unlock(page: Page, credential: Credential, accountName?: string) {
  await expect(page.getByRole('heading', { name: 'Entrar en modo offline' })).toBeVisible({ timeout: 30_000 })
  expect(await page.getByText(/Copia offline \d/).count()).toBe(0)
  try {
    await page.getByLabel('Usuario de Clarin', { exact: true }).fill(credential.username)
    await page.getByLabel('Contraseña de Clarin', { exact: true }).fill(credential.password)
  } catch { throw new Error('The QA offline credential fields were unavailable') }
  await page.getByRole('button', { name: 'Desbloquear copia local', exact: true }).click()
  if (accountName) {
    await expect(page.getByRole('heading', { name: 'Elige tu cuenta offline' })).toBeVisible()
    await page.getByRole('button', { name: accountName, exact: true }).click()
  }
  await expect(page.getByLabel('Estado offline de la cuenta actual')).toBeVisible({ timeout: 30_000 })
  console.log('QA stage: offline identity unlocked')
}

async function checkResponsiveOffline(page: Page, info: TestInfo) {
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
    const indicator = page.getByLabel('Estado offline de la cuenta actual')
    await expect(indicator).toBeVisible()
    await expect(indicator.getByRole('button', { name: 'Sincronizar', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Bloquear / cambiar usuario o cuenta', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Volver al modo online', exact: true })).toBeVisible({ timeout: 20_000 })
    await page.screenshot({ path: info.outputPath(`offline-responsive-${width}.png`), fullPage: true })
  }
  console.log('QA stage: offline responsive surfaces verified')
}

async function freshOnline(page: Page) {
  await page.getByRole('button', { name: 'Bloquear / cambiar usuario o cuenta' }).click()
  await page.getByRole('button', { name: 'Iniciar una sesión online', exact: true }).click({ timeout: 25_000 })
  await expect(page.getByPlaceholder('usuario o correo')).toBeVisible()
}

async function readPreparedModules(page: Page, info: TestInfo) {
  const navigation = page.getByRole('navigation', { name: 'Módulos offline' })
  await navigation.getByRole('button', { name: 'Contactos', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Contactos disponibles' })).toBeVisible()
  await page.getByRole('button', { name: /CONTACTO FICTICIO 1-/ }).first().click()
  await expect(page.getByRole('complementary', { name: /Detalle de CONTACTO FICTICIO 1-/ })).toBeVisible()
  await expect(page.getByText(/CONTACTO FICTICIO 2-/)).toHaveCount(0)
  await expect(page.locator('.offline-module').getByRole('alert')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('offline-contact-detail.png'), fullPage: true })
  await navigation.getByRole('button', { name: 'Programas', exact: true }).click()
  await page.getByRole('button', { name: /Programa ficticio cuenta 1/ }).click()
  await expect(page.getByRole('heading', { name: 'Programa ficticio cuenta 1', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Sesiones incluidas', exact: true })).toBeVisible()
  await expect(page.getByText(/Programa ficticio cuenta 2|CONTACTO FICTICIO 2-/)).toHaveCount(0)
  await expect(page.locator('.offline-module').getByRole('alert')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('offline-program-detail.png'), fullPage: true })
  await navigation.getByRole('button', { name: 'Pizarras', exact: true }).click()
  await page.getByRole('button', { name: /Pizarra ficticia cuenta 1/ }).click()
  const rendered = page.getByRole('img', { name: 'Vista de solo lectura de Pizarra ficticia cuenta 1', exact: true })
  await expect(rendered).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => rendered.evaluate(element => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0)).toBe(true)
  await page.getByRole('button', { name: 'Acercar pizarra', exact: true }).click()
  await expect(page.getByLabel('Ampliación')).toHaveText('200%')
  await page.getByRole('button', { name: 'Ajustar', exact: true }).click()
  await expect(page.getByLabel('Ampliación')).toHaveText('100%')
  await expect(page.getByText(/Pizarra ficticia cuenta 2/)).toHaveCount(0)
  await expect(page.locator('.offline-module').getByRole('alert')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('offline-whiteboard-render.png'), fullPage: true })
}

async function inspectPrivateStorage(page: Page, plaintext: string[]) {
  return page.evaluate(async known => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('clarin-offline-v4'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    const readStore = (store: string) => new Promise<unknown[]>((resolve, reject) => { const tx = database.transaction(store, 'readonly'); const request = tx.objectStore(store).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    const serialized = JSON.stringify({ vaults: await readStore('vaults'), records: await readStore('records') })
    database.close()
    const leaked = known.some(value => serialized.includes(value))
    let privateCache = false
    for (const name of await caches.keys()) {
      const cache = await caches.open(name)
      for (const request of await cache.keys()) {
        if (/^\/(api|dashboard|login)(\/|\?|$)/.test(new URL(request.url).pathname)) privateCache = true
        const response = await cache.match(request)
        if (response && /json|text\/html/.test(response.headers.get('content-type') || '')) {
          const body = await response.text()
          if (known.some(value => body.includes(value))) privateCache = true
        }
      }
    }
    return { leaked, privateCache, tokenIsMarker: [null, 'cookie-session'].includes(localStorage.getItem('token')) }
  }, plaintext)
}

async function exactPendingCount(page: Page, userID: string, accountID: string) {
  return page.evaluate(({ userID, accountID }) => new Promise<number>((resolve, reject) => {
    const open = indexedDB.open('clarin-offline-v4', 1)
    open.onsuccess = () => {
      const database = open.result
      const tx = database.transaction(['vaults', 'records'], 'readonly')
      const vaults = tx.objectStore('vaults').getAll()
      const records = tx.objectStore('records').getAll()
      tx.oncomplete = () => {
        const vault = vaults.result.find(value => value.identity.user_id === userID && value.identity.account_id === accountID)
        const count = vault ? records.result.filter(value => value.grant_id === vault.identity.grant_id && value.kind === 'operation').length : -1
        database.close(); resolve(count)
      }
      tx.onerror = () => { database.close(); reject(new Error('Cannot count the exact encrypted QA queue')) }
    }
    open.onerror = () => reject(new Error('Cannot read the exact QA queue'))
  }), { userID, accountID })
}

test('real browser web flow: approval, encrypted preparation, restart, task sync and ten-user isolation', async ({ browser, playwright }, testInfo) => {
  test.setTimeout(20 * 60_000)
  const directory = await mkdtemp(join(tmpdir(), 'clarin-offline-v4-multiuser-'))
  const userContext = await playwright.chromium.launchPersistentContext(directory, { ...(testInfo.project.use.launchOptions || {}), headless: true })
  const adminContext = await browser.newContext()
  const forbiddenRequests: string[] = []
  for (const context of [userContext, adminContext]) await guardContext(context, forbiddenRequests)
  const userPage = await userContext.newPage()
  const adminPage = await adminContext.newPage()
  // Grant the real browser storage permission through CDP in this disposable
  // QA context. Do not monkey-patch StorageManager or bypass the engine gate.
  await grantDurableStorage(userContext, userPage)
  const errors: string[] = []
  const nativeRequests: string[] = []
  userPage.on('pageerror', error => errors.push(error.message))
  userPage.on('request', request => { if (/127\.0\.0\.1:17373|clarin-offline:\/\//.test(request.url())) nativeRequests.push(request.url()) })
  const accountA = fixtures.steps.account_0.value.name
  const accountB = fixtures.steps.account_1.value.name
  try {
    await login(adminPage, credentials.admin)
    await login(userPage, credentials.users[0])
    const onlineTab = await userContext.newPage()
    // A normal login tab predating offline mode has no transition query flag.
    await onlineTab.goto(`${labOrigin}/login`, { waitUntil: 'domcontentloaded' })
    await settings(userPage)
    const profile = await requestAndApprove(userPage, adminPage, [accountA, accountB], true)
    const existingTitle = `Tarea QA completar ${testInfo.project.name} ${randomUUID()}`
    const existingCreated = await userPage.request.post(`${labOrigin}/api/tasks/`, { data: { list_id: fixtures.steps.list_0_0.value.id, title: existingTitle, operation_id: randomUUID() } })
    expect(existingCreated.ok()).toBe(true)
    const existingTaskID = (await existingCreated.json()).task.id as string
    expect(existingTaskID).toMatch(/^[a-f0-9-]{36}$/)
    await prepareAccount(userPage, credentials.users[0], accountA, true)
    await prepareAccount(userPage, credentials.users[0], accountB, true)
    await userPage.getByRole('button', { name: 'Entrar en modo offline', exact: true }).click()
    await unlock(userPage, credentials.users[0], accountA)
    await checkResponsiveOffline(userPage, testInfo)
    await faults({ unavailable: true })
    await userContext.setOffline(true)
    await readPreparedModules(userPage, testInfo)
    await userPage.getByRole('navigation', { name: 'Módulos offline' }).getByRole('button', { name: 'Tareas', exact: true }).click()
    await expect(userPage.getByRole('heading', { name: 'Tareas disponibles' })).toBeVisible()
    const localTitle = `Tarea QA offline ${testInfo.project.name} ${randomUUID()}`
    await userPage.getByPlaceholder(/^Nueva tarea en/).fill(localTitle)
    await userPage.getByRole('button', { name: 'Crear localmente', exact: true }).click()
    await expect(userPage.getByRole('heading', { name: localTitle, exact: true })).toBeVisible()
    const existing = userPage.getByRole('button', { name: `Completar ${existingTitle}`, exact: true })
    await existing.click()
    await expect(userPage.getByRole('button', { name: `Tarea completada: ${existingTitle}`, exact: true })).toBeVisible()
    expect(await inspectPrivateStorage(userPage, [localTitle, credentials.users[0].password, accountA, accountB])).toEqual({ leaked: false, privateCache: false, tokenIsMarker: true })
    await userPage.evaluate(() => window.scrollTo(0, 0))
    await expect.poll(() => userPage.getByLabel('Estado offline de la cuenta actual').evaluate(element => Math.round(element.getBoundingClientRect().top))).toBe(0)
    expect(await userPage.evaluate(() => window.scrollY)).toBe(0)
    await userPage.screenshot({ path: testInfo.outputPath('offline-account-a-pending.png'), fullPage: false })
    // Last unlocked tab closed: a separate online login tab never owns its
    // worker authorization. Same URL must ask for local credentials again.
    await userPage.close()
    const reopened = await userContext.newPage()
    reopened.on('pageerror', error => errors.push(error.message))
    await reopened.goto(`${labOrigin}/dashboard/tasks`, { waitUntil: 'domcontentloaded' })
    await unlock(reopened, credentials.users[0], accountA)
    // Explicitly choosing an account opens that account's safe home screen.
    await reopened.getByRole('navigation', { name: 'Módulos offline' }).getByRole('button', { name: 'Tareas', exact: true }).click()
    await expect(reopened.getByRole('heading', { name: localTitle, exact: true })).toBeVisible()
    await userContext.setOffline(false)
    await faults({ unavailable: false, lost_ack: true })
    await reopened.getByRole('button', { name: 'Sincronizar', exact: true }).click()
    // "Sincronizando" temporarily replaces the visible pending count; absence
    // of that text is not proof that the two original receipts were committed.
    await expect.poll(() => exactPendingCount(reopened, fixtures.steps.user_0.value.id, fixtures.steps.account_0.value.id), { timeout: 90_000 }).toBe(0)
    await expect.poll(async () => reopened.getByLabel('Estado offline de la cuenta actual').innerText(), { timeout: 90_000 }).not.toMatch(/\d+ pendientes?/)
    await expect(reopened.getByLabel('Estado offline de la cuenta actual')).not.toContainText(/\d+ conflictos?/)
    await expect(reopened.getByLabel('Estado offline de la cuenta actual')).toContainText(accountA)
    await expect(reopened.getByLabel('Estado offline de la cuenta actual')).toContainText('Modo offline')
    await expect(reopened.getByRole('heading', { name: localTitle, exact: true })).toHaveCount(1)

    const completedResponse = await reopened.request.get(`${labOrigin}/api/tasks/${existingTaskID}`)
    expect(completedResponse.ok()).toBe(true)
    const completed = (await completedResponse.json()).task
    expect(completed.status).toBe('completed')
    expect(completed.completed_by).toBe(fixtures.steps.user_0.value.id)
    expect(completed.account_id).toBe(fixtures.steps.account_0.value.id)
    const createdResponse = await reopened.request.get(`${labOrigin}/api/tasks/?${new URLSearchParams({ list_id: fixtures.steps.list_0_0.value.id, search: localTitle, limit: '50' })}`)
    expect(createdResponse.ok()).toBe(true)
    const created = await createdResponse.json()
    expect(created.total).toBe(1)
    expect(created.tasks[0].created_by).toBe(fixtures.steps.user_0.value.id)
    expect(created.tasks[0].account_id).toBe(fixtures.steps.account_0.value.id)
    console.log('QA stage: real server confirms original author, account, completion and exactly-once creation after lost ACK')

    await faults({ sync_unavailable: true })
    const retainedTitle = `Pendiente A no sincronizar como B ${randomUUID()}`
    await reopened.getByPlaceholder(/^Nueva tarea en/).fill(retainedTitle)
    await reopened.getByRole('button', { name: 'Crear localmente', exact: true }).click()
    await expect(reopened.getByRole('heading', { name: retainedTitle, exact: true })).toBeVisible()
    await expect(reopened.getByLabel('Estado offline de la cuenta actual')).toContainText('1 pendiente')
    expect(await exactPendingCount(reopened, fixtures.steps.user_0.value.id, fixtures.steps.account_0.value.id)).toBe(1)
    console.log('QA stage: actor A has an encrypted pending operation while online auth remains available')

    // The same browser profile prepares nine further explicitly authorized
    // identities. None inherits the first user's other account or resource data.
    // An already-open online login page must invalidate another tab's offline
    // session before accepting a different online actor, even with shared cookies.
    await onlineTab.bringToFront()
    await onlineTab.evaluate(() => { (window as Window & { turnstile?: { reset: () => void } }).turnstile?.reset() })
    await login(onlineTab, credentials.users[1], true)
    await expect(reopened.getByRole('heading', { name: 'Entrar en modo offline', exact: true })).toBeVisible()
    await expect(reopened.getByRole('heading', { name: localTitle, exact: true })).toHaveCount(0)
    await expect(reopened.getByRole('heading', { name: retainedTitle, exact: true })).toHaveCount(0)
    expect(await exactPendingCount(reopened, fixtures.steps.user_0.value.id, fixtures.steps.account_0.value.id)).toBe(1)
    await faults({ sync_unavailable: false })
    console.log('QA stage: actor B online login locked A without deleting or replaying A pending operation')
    await onlineTab.close()
    for (let index = 1; index < 10; index++) {
      await login(reopened, credentials.users[index])
      await settings(reopened)
      const sameProfile = await requestAndApprove(reopened, adminPage, [accountA])
      expect(sameProfile).toBe(profile)
      await prepareAccount(reopened, credentials.users[index], accountA, false)
      await reopened.getByRole('button', { name: 'Entrar en modo offline', exact: true }).click()
      if (index === 1) {
        try {
          await reopened.getByLabel('Usuario de Clarin', { exact: true }).fill(credentials.users[0].username)
          await reopened.getByLabel('Contraseña de Clarin', { exact: true }).fill(credentials.users[1].password)
        } catch { throw new Error('The QA mismatch credential fields were unavailable') }
        await reopened.getByRole('button', { name: 'Desbloquear copia local', exact: true }).click()
        await expect(reopened.getByRole('alert')).toBeVisible()
        await expect(reopened.getByLabel('Estado offline de la cuenta actual')).toHaveCount(0)
        await expect(reopened.getByRole('button', { name: accountB, exact: true })).toHaveCount(0)
      }
      await unlock(reopened, credentials.users[index])
      await expect(reopened.getByLabel('Estado offline de la cuenta actual')).toContainText(credentials.users[index].username)
      await expect(reopened.getByLabel('Estado offline de la cuenta actual')).not.toContainText(accountB)
      await reopened.getByRole('navigation', { name: 'Módulos offline' }).getByRole('button', { name: 'Contactos', exact: true }).click()
      await expect(reopened.getByText(/CONTACTO FICTICIO 2-/)).toHaveCount(0)
      await freshOnline(reopened)
    }
    await login(reopened, credentials.users[1])
    const grants = await reopened.request.get(`${labOrigin}/api/offline/v4/grants?browser_profile_id=${profile}`)
    expect(grants.ok()).toBe(true)
    const owned = await grants.json()
    expect(owned.items).toHaveLength(1)
    expect(owned.items[0].account_id).toBe(fixtures.steps.account_0.value.id)
    expect(await exactPendingCount(reopened, fixtures.steps.user_0.value.id, fixtures.steps.account_0.value.id)).toBe(1)
    const canonicalTasks = await reopened.request.get(`${labOrigin}/api/tasks/?${new URLSearchParams({ list_id: fixtures.steps.list_0_0.value.id, search: retainedTitle, limit: '50' })}`)
    expect(canonicalTasks.ok()).toBe(true)
    const canonical = await canonicalTasks.json()
    expect(canonical.total).toBe(0)
    expect((canonical.tasks || []).some((task: { title: string }) => task.title === retainedTitle)).toBe(false)
    const denied = await reopened.request.post(`${labOrigin}/api/auth/switch-account`, { data: { account_id: fixtures.steps.account_1.value.id } })
    expect(denied.status()).toBe(403)
    expect(errors).toEqual([])
    expect(nativeRequests).toEqual([])
    expect(forbiddenRequests).toEqual([])
  } catch (error) {
    await failureState(userContext)
    throw error
  } finally {
    await faults({ unavailable: false, cloudflare: false, lost_ack: false, sync_unavailable: false })
    await userContext.close(); await adminContext.close()
    await rm(directory, { recursive: true, force: true }) // Exact synthetic profile owned by this test.
    if (forbiddenRequests.length) throw new Error(`QA egress guard blocked ${forbiddenRequests.length} non-laboratory request(s); no request was forwarded.`)
  }
})

test('real encrypted pending data survives a complete browser-process close and offline reopen', async ({ playwright, browser }, testInfo) => {
  test.setTimeout(8 * 60_000)
  const directory = await mkdtemp(join(tmpdir(), 'clarin-offline-v4-real-vault-'))
  const options = { ...(testInfo.project.use.launchOptions || {}), headless: true }
  let context = await playwright.chromium.launchPersistentContext(directory, options)
  const adminContext = await browser.newContext()
  const forbidden: string[] = []
  const accountName = fixtures.steps.account_0.value.name
  try {
    await guardContext(context, forbidden); await guardContext(adminContext, forbidden)
    const page = context.pages()[0] || await context.newPage()
    const admin = await adminContext.newPage()
    await grantDurableStorage(context, page)
    await login(admin, credentials.admin)
    await login(page, credentials.users[0])
    await settings(page)
    await requestAndApprove(page, admin, [accountName], true)
    await prepareAccount(page, credentials.users[0], accountName, true)
    // Cloudflare-like HTML with connectivity still up: the actual online UI
    // must offer a choice, honor waiting, and open the prepared shell locally.
    await faults({ cloudflare: true })
    const offer = page.getByLabel('Conexión con Clarin no disponible')
    await expect(offer).toBeVisible({ timeout: 25_000 })
    await offer.getByRole('button', { name: 'Esperar', exact: true }).click()
    await expect(offer).toContainText('Esperando a que Clarin vuelva a responder')
    await expect(page.getByRole('heading', { name: 'Clarin offline, en este navegador' })).toBeVisible()
    page.once('dialog', dialog => dialog.accept())
    await offer.getByRole('button', { name: 'Seguir sin conexión', exact: true }).click()
    await unlock(page, credentials.users[0])
    console.log('QA stage: Cloudflare-like outage wait/offline choice verified')
    await faults({ unavailable: true, cloudflare: false })
    await context.setOffline(true)
    await page.getByRole('navigation', { name: 'Módulos offline' }).getByRole('button', { name: 'Tareas', exact: true }).click()
    const title = `Tarea pendiente reinicio ${testInfo.project.name} ${randomUUID()}`
    await page.getByPlaceholder(/^Nueva tarea en/).fill(title)
    await page.getByRole('button', { name: 'Crear localmente', exact: true }).click()
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
    await expect(page.getByLabel('Estado offline de la cuenta actual')).toContainText('1 pendiente')
    await context.close()
    // New OS process, same disposable on-disk browser profile; origin refuses
    // every socket. This is not page.reload() or a StorageState reconstruction.
    context = await playwright.chromium.launchPersistentContext(directory, options)
    await guardContext(context, forbidden)
    await context.setOffline(true)
    const reopened = context.pages()[0] || await context.newPage()
    await reopened.goto(`${labOrigin}/dashboard/tasks`, { waitUntil: 'domcontentloaded' })
    await unlock(reopened, credentials.users[0])
    await expect(reopened.getByRole('heading', { name: title, exact: true })).toBeVisible()
    await expect(reopened.getByLabel('Estado offline de la cuenta actual')).toContainText('1 pendiente')
    const persistentAfterRestart = await reopened.evaluate(() => navigator.storage.persisted())
    if (!persistentAfterRestart) {
      await expect(reopened.getByText('El navegador no garantiza retener esta copia. No borres sus datos y sincroniza los cambios pendientes en cuanto puedas.', { exact: true })).toBeVisible()
      await expect(reopened.getByRole('button', { name: 'Crear localmente', exact: true })).toHaveCount(0)
      for (const complete of await reopened.getByRole('button', { name: /^Completar / }).all()) await expect(complete).toBeDisabled()
    }
    console.log('QA restart: native storage persistence', persistentAfterRestart, '; pending work retained; missing persistence keeps writes unavailable')
    expect(await inspectPrivateStorage(reopened, [title, credentials.users[0].password, accountName])).toEqual({ leaked: false, privateCache: false, tokenIsMarker: true })
    await reopened.screenshot({ path: testInfo.outputPath('encrypted-pending-after-browser-restart.png'), fullPage: true })
  } catch (error) {
    await failureState(context)
    throw error
  } finally {
    await faults({ unavailable: false, cloudflare: false, lost_ack: false, sync_unavailable: false })
    await context.close(); await adminContext.close()
    // Exact temporary synthetic profile created by this test, never user data.
    await rm(directory, { recursive: true, force: true })
    if (forbidden.length) throw new Error(`QA egress guard blocked ${forbidden.length} non-laboratory request(s); none were forwarded.`)
  }
})

test('real large UTF-8 task queue splits below 2 MiB and syncs twelve operations exactly once', async ({ playwright, browser }, testInfo) => {
  test.setTimeout(5 * 60_000)
  const directory = await mkdtemp(join(tmpdir(), 'clarin-offline-v4-large-batch-'))
  const context = await playwright.chromium.launchPersistentContext(directory, { ...(testInfo.project.use.launchOptions || {}), headless: true })
  const adminContext = await browser.newContext()
  const forbidden: string[] = []
  const accountID = fixtures.steps.account_0.value.id
  const userID = fixtures.steps.user_0.value.id
  const prefix = `Lote UTF8 QA ${randomUUID()}`
  const listName = `Lista lote QA ${randomUUID()}`
  const description = 'á'.repeat(100_000) // 200,000 UTF-8 bytes, not 200,000 UTF-16 units.
  expect(Buffer.byteLength(description) * 12).toBeGreaterThan(2 * 1024 * 1024)
  try {
    await guardContext(context, forbidden); await guardContext(adminContext, forbidden)
    const page = context.pages()[0] || await context.newPage()
    const admin = await adminContext.newPage()
    await grantDurableStorage(context, page)
    await login(admin, credentials.admin)
    await login(page, credentials.users[0])
    const listResponse = await page.request.post(`${labOrigin}/api/tasks/lists`, { data: { environment_id: fixtures.steps.environment_0.value.id, name: listName } })
    expect(listResponse.ok()).toBe(true)
    const listID = (await listResponse.json()).list.id as string
    expect(listID).toMatch(/^[a-f0-9-]{36}$/)
    await settings(page)
    await requestAndApprove(page, admin, [fixtures.steps.account_0.value.name], true)
    await prepareAccount(page, credentials.users[0], fixtures.steps.account_0.value.name, true, listName)
    await page.getByRole('button', { name: 'Entrar en modo offline', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Entrar en modo offline' })).toBeVisible()
    await faults({ unavailable: true, reset_sync_metrics: true })
    await context.setOffline(true)

    // The current compact offline task composer has no description field.
    // Exercise the actual authenticated public SharedWorker gateway, not a mock
    // or a database injection. This new port must prove the local password itself.
    const taskIDs = await page.evaluate(async ({ credential, prefix, description, listID }) => {
      const worker = new SharedWorker('/offline-v4/worker.js', { name: 'clarin-offline-v4-schema-1', type: 'module' })
      let generation = 0
      let readyResolve!: () => void
      const ready = new Promise<void>(resolve => { readyResolve = resolve })
      const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
      worker.port.onmessage = event => {
        const message = event.data
        if (message.protocol !== 4 || message.schema !== 1) return
        if (message.type === 'state') { generation = message.state.generation; readyResolve(); return }
        const call = pending.get(message.id)
        if (!call) return
        pending.delete(message.id); clearTimeout(call.timer); generation = message.generation
        if (message.error) call.reject(new Error(`Real QA worker rejected ${message.error.code}`))
        else call.resolve(message.result)
      }
      worker.port.start()
      const call = <T,>(method: string, args: unknown[] = []) => new Promise<T>((resolve, reject) => {
        const id = crypto.randomUUID()
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Real QA worker timed out: ${method}`)) }, 30_000)
        pending.set(id, { resolve: value => resolve(value as T), reject, timer })
        worker.port.postMessage({ id, protocol: 4, schema: 1, generation, method, args })
      })
      const heartbeat = setInterval(() => worker.port.postMessage({ id: crypto.randomUUID(), protocol: 4, schema: 1, generation, method: 'heartbeat', args: [] }), 5000)
      try {
        await Promise.race([ready, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Real QA worker handshake unavailable')), 30_000))])
        await call('unlockUser', [credential.username, credential.password])
        const lists = await call<{ items: { id: string; selection_id: string; can_create: boolean }[] }>('gateway.taskLists')
        const selected = lists.items.find(item => item.id === listID)
        if (!selected?.can_create) throw new Error('Exact authorized QA task list is not writable')
        const ids: string[] = []
        for (let index = 0; index < 12; index++) {
          const taskID = crypto.randomUUID(); ids.push(taskID)
          await call('gateway.createTask', [{ operation_id: crypto.randomUUID(), selection_id: selected.selection_id, task_id: taskID,
            client_occurred_at: new Date().toISOString(), patch: { title: `${prefix} ${index + 1}`, description, priority: 'medium', start_at: null, due_at: null, due_end_at: null, is_all_day: false } }])
        }
        const status = await call<{ pending_count: number }>('gateway.syncStatus')
        if (status.pending_count !== 12) throw new Error('Expected exactly twelve real encrypted pending operations')
        return ids
      } finally {
        clearInterval(heartbeat)
        worker.port.postMessage({ id: crypto.randomUUID(), protocol: 4, schema: 1, generation, method: 'disconnect', args: [] })
        worker.port.close()
      }
    }, { credential: credentials.users[0], prefix, description, listID })
    expect(taskIDs).toHaveLength(12)
    expect(new Set(taskIDs).size).toBe(12)
    expect(await exactPendingCount(page, userID, accountID)).toBe(12)
    console.log('QA stage: twelve actual encrypted operations queued; description payload totals 2400000 UTF-8 bytes')
    // The UI must independently unlock after the RPC port closes, then owns
    // the normal synchronization action and accurately shows all pending work.
    await unlock(page, credentials.users[0])
    await expect(page.getByLabel('Estado offline de la cuenta actual')).toContainText('12 pendientes')
    expect(await inspectPrivateStorage(page, [prefix, description.slice(0, 500), credentials.users[0].password])).toEqual({ leaked: false, privateCache: false, tokenIsMarker: true })
    await context.setOffline(false)
    await faults({ unavailable: false, lost_ack: true })
    await page.getByRole('button', { name: 'Sincronizar', exact: true }).click()
    await expect.poll(() => exactPendingCount(page, userID, accountID), { timeout: 120_000 }).toBe(0)
    await expect(page.getByRole('button', { name: 'Sincronizar', exact: true })).toBeEnabled({ timeout: 30_000 })
    await expect(page.getByLabel('Estado offline de la cuenta actual')).not.toContainText(/\d+ conflictos?/)

    const deniedMetrics = await labRequest('/__offline-v4-qa/sync-metrics')
    expect(deniedMetrics.status).toBe(403)
    const recorded = await labRequest('/__offline-v4-qa/sync-metrics', { headers: { 'X-QA-Run': runID } })
    expect(recorded.status).toBe(200)
    const metrics = JSON.parse(recorded.text).items as { bytes: number; status: number; lost_ack: boolean; complete: boolean; replay_rejected: boolean }[]
    console.log('QA stage: real sync wire metadata', JSON.stringify(metrics))
    await testInfo.attach('sync-wire-metadata', { body: JSON.stringify(metrics), contentType: 'application/json' })
    const created = await page.request.get(`${labOrigin}/api/tasks/?${new URLSearchParams({ list_id: listID, search: prefix, limit: '50' })}`)
    expect(created.ok()).toBe(true)
    const initialCanonical = await created.json()
    expect(initialCanonical.total).toBe(12)
    expect(initialCanonical.tasks.every((task: { id: string; description: string; created_by: string; account_id: string }) => taskIDs.includes(task.id) && task.description === description && task.created_by === userID && task.account_id === accountID)).toBe(true)
    console.log('QA stage: twelve canonical tasks have exact original description, ID, author and account')
    expect(metrics.length).toBeGreaterThanOrEqual(3) // The first successful upload deliberately loses its ACK.
    expect(metrics.every(item => item.complete && item.bytes <= 2 * 1024 * 1024 - 64 * 1024 && (item.status === 200 || item.status === 409 && item.replay_rejected))).toBe(true)
    expect(metrics.filter(item => item.lost_ack)).toHaveLength(1)
    expect(metrics.filter(item => item.status === 200 && item.bytes > 1_800_000).length).toBeGreaterThanOrEqual(2)
    expect(metrics.some(item => item.status === 200 && item.bytes > 300_000 && item.bytes < 500_000)).toBe(true)

    const canonical = async () => {
      const response = await page.request.get(`${labOrigin}/api/tasks/?${new URLSearchParams({ list_id: listID, search: prefix, limit: '50' })}`)
      expect(response.ok()).toBe(true)
      const body = await response.json()
      expect(body.total).toBe(12)
      expect(body.tasks.length).toBe(12)
      // Assert booleans/IDs only: failures must not dump long private fields.
      expect(body.tasks.every((task: { id: string; description: string; created_by: string; account_id: string; list_id: string }) => taskIDs.includes(task.id) && task.description === description && task.created_by === userID && task.account_id === accountID && task.list_id === listID)).toBe(true)
      expect(new Set(body.tasks.map((task: { id: string }) => task.id)).size).toBe(12)
    }
    await canonical()
    await expect(page.getByRole('button', { name: 'Sincronizar', exact: true })).toBeEnabled({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Sincronizar', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Sincronizar', exact: true })).toBeEnabled({ timeout: 30_000 })
    await canonical()
    expect(await exactPendingCount(page, userID, accountID)).toBe(0)
    expect(forbidden).toEqual([])
    console.log('QA stage: server has exactly twelve original IDs, complete descriptions, original author/account, and local queue zero after retry')
  } catch (error) {
    await failureState(context)
    throw error
  } finally {
    await faults({ unavailable: false, cloudflare: false, lost_ack: false, sync_unavailable: false, reset_sync_metrics: true })
    await context.close(); await adminContext.close()
    await rm(directory, { recursive: true, force: true }) // Only this owned disposable synthetic profile.
    if (forbidden.length) throw new Error(`QA egress guard blocked ${forbidden.length} non-laboratory request(s); none were forwarded.`)
  }
})
