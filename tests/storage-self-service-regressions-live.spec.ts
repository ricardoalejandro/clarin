import { expect, test, type Page, type Request } from '@playwright/test'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Independent regression fixtures use the ordinary index worker and real API,
// SQL, Redis, MinIO and WebSocket paths. No route mocks or forced reconciliation.
const enabled = process.env.CLARIN_STORAGE_BROWSER_QA === '1'
const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000'
const manifestPath = process.env.CLARIN_STORAGE_UI_QA_MANIFEST || ''
const evidenceDir = process.env.CLARIN_STORAGE_QA_EVIDENCE_DIR || resolve('work/qa-regressions/evidence')
type Media = { label: string; filename: string; object_key: string; size_bytes: number; sha256: string }
type Fixture = { profile: string; state: string; accounts: { a: { id: string } }; actors: { admin_a: { username: string; password: string } }; files: Media[] }
let fixture: Fixture
let hints = 0
const observations: Record<string, unknown>[] = []
const errors = new WeakMap<Page, string[]>()

function observe(entry: Record<string, unknown>) { observations.push({ at: new Date().toISOString(), ...entry }) }
function file(label: string): Media {
  const result = fixture.files.find(item => item.label === label)
  if (!result) throw new Error(`Missing synthetic regression label: ${label}`)
  return result
}
function row(page: Page, media: Media) { return page.locator('[data-storage-workspace] article').filter({ has: page.getByRole('button', { name: media.filename, exact: true }) }) }
function fixtureAction(action: 'noise' | 'simulate-missing'): Promise<void> {
  return new Promise((done, fail) => {
    execFile('bash', ['scripts/qa/storage-ui-fixture.sh', action], {
      cwd: resolve('.'), env: { ...process.env, CLARIN_STORAGE_UI_QA: '1', CLARIN_STORAGE_UI_QA_MANIFEST: manifestPath }, timeout: 40_000,
    }, error => error ? fail(new Error(`Owned local regression fixture action failed: ${action}`)) : done())
  })
}
async function login(page: Page) {
  const ready = page.waitForResponse(response => new URL(response.url()).pathname === '/api/public/security-config')
  await page.goto(`${baseURL}/login`, { waitUntil: 'domcontentloaded' })
  expect((await ready).status()).toBe(200)
  await page.getByPlaceholder('usuario o correo').fill(fixture.actors.admin_a.username)
  try { await page.getByPlaceholder('tu contraseña').fill(fixture.actors.admin_a.password) } catch { throw new Error('Could not fill private fixture credentials') }
  const authenticated = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/login' && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click()
  expect((await authenticated).status()).toBe(200)
  await page.waitForURL(/\/dashboard(?:\/|$|\?)/, { timeout: 90_000 })
}
async function open(page: Page) {
  await page.goto(`${baseURL}/dashboard/storage`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'Almacenamiento', exact: true })).toBeVisible()
}
async function search(page: Page, query: string) {
  const response = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/storage/files' && url.searchParams.get('q') === query
  })
  await page.getByRole('textbox', { name: 'Buscar archivos', exact: true }).fill(query)
  expect((await response).status()).toBe(200)
}

test.describe('Reported storage regressions on real local services', () => {
  test.skip(!enabled, 'requires explicit local storage browser opt-in')
  test.describe.configure({ mode: 'serial' })
  test.beforeAll(() => {
    if (!['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname)) throw new Error('Regression acceptance requires local services')
    fixture = JSON.parse(readFileSync(manifestPath, 'utf8')) as Fixture
    if (fixture.profile !== 'regression' || fixture.state === 'cleaned') throw new Error('Create a new dedicated regression fixture')
    mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
  })
  test.beforeEach(async ({ page }, info) => {
    observe({ event: 'test_start', title: info.title })
    errors.set(page, [])
    page.on('pageerror', error => errors.get(page)!.push(error.message))
    const started = new Map<Request, number>()
    page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/storage/')) started.set(request, Date.now()) })
    page.on('response', response => {
      const start = started.get(response.request())
      if (start != null) { observe({ event: 'response', path: new URL(response.url()).pathname, status: response.status(), elapsed_ms: Date.now() - start }); started.delete(response.request()) }
    })
    page.on('requestfailed', request => {
      if (started.has(request)) { observe({ event: 'request_failed', path: new URL(request.url()).pathname }); started.delete(request) }
    })
    page.on('websocket', socket => socket.on('framereceived', frame => {
      try {
        const message = JSON.parse(String(frame.payload))
        if (message.event === 'storage_changed' && message.data?.account_id === fixture.accounts.a.id) { hints++; observe({ event: 'storage_changed', reason: message.data.reason }) }
      } catch { /* Ignore unrelated/binary events. */ }
    }))
    await login(page)
  })
  test.afterEach(async ({ page }) => expect(errors.get(page) || []).toEqual([]))
  test.afterAll(() => { if (enabled) writeFileSync(resolve(evidenceDir, 'regression-observations.json'), JSON.stringify(observations, null, 2) + '\n', { mode: 0o600 }) })

  test('normal worker finishes and forty-file review survives unrelated account notifications', async ({ page }) => {
    const began = Date.now()
    await open(page)
    await expect.poll(async () => {
      const response = await page.request.get(`${baseURL}/api/storage/usage`)
      expect(response.status()).toBe(200)
      const usage = await response.json()
      observe({ event: 'inventory_state', status: usage.catalog_status, complete: usage.inventory_complete })
      return usage.catalog_status
    }, { timeout: 90_000, intervals: [500, 1000, 2000] }).toBe('ready')
    observe({ event: 'normal_worker_ready', elapsed_ms: Date.now() - began })
    await search(page, 'Batch review')
    await expect(page.locator('[data-storage-workspace] article')).toHaveCount(40)
    await page.getByRole('checkbox', { name: 'Seleccionar archivos de esta página', exact: true }).check()
    const hintStart = hints
    let noiseFinished = false
    let noiseError: Error | undefined
    const noise = fixtureAction('noise').catch(error => { noiseError = error }).finally(() => { noiseFinished = true })
    try {
      await expect.poll(() => { if (noiseError) throw noiseError; return hints }).toBeGreaterThan(hintStart)
      expect(noiseFinished, 'review must remain usable while source notifications continue').toBe(false)
      const reviewResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/storage/cleanup/preview' && response.request().method() === 'POST')
      const beganReview = Date.now()
      await page.getByRole('button', { name: 'Revisar selección', exact: true }).click()
      const response = await reviewResponse
      expect(response.status()).toBe(200)
      const review = await response.json()
      expect(review.eligible_count).toBe(40)
      expect(review.estimated_freed_bytes).toBe(0)
      observe({ event: 'review_complete', selected: 40, elapsed_ms: Date.now() - beganReview })
      const dialog = page.getByRole('dialog', { name: 'Revisar eliminación', exact: true })
      const confirm = dialog.getByRole('button', { name: 'Confirmar retirada', exact: true })
      await expect(confirm).toBeEnabled()
      const duringReview = hints
      await expect.poll(() => hints).toBeGreaterThan(duringReview)
      await expect(confirm).toBeEnabled()
      await page.screenshot({ path: resolve(evidenceDir, '01-revision-40-archivos.png') })
      await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click()
      await expect(page.getByRole('checkbox', { name: 'Seleccionar archivos de esta página', exact: true })).toBeChecked()
    } finally { await noise; if (noiseError) throw noiseError }
    const activity = await page.request.get(`${baseURL}/api/storage/activity`)
    expect(activity.status()).toBe(200)
    expect((await activity.json()).total).toBe(0)
  })

  test('URL-only legacy names render actual PDF bytes and preserve tenant isolation', async ({ page }) => {
    await open(page)
    for (const label of ['legacy_plain', 'legacy_percent', 'legacy_delimiters', 'legacy_unicode']) {
      const media = file(label)
      await search(page, media.filename)
      await expect(row(page, media)).toBeVisible()
      const content = await page.request.get(`${baseURL}/api/storage/content?object_key=${encodeURIComponent(media.object_key)}`)
      expect(content.status()).toBe(200)
      const bytes = await content.body()
      expect(bytes.byteLength).toBe(media.size_bytes)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(media.sha256)
      await row(page, media).getByRole('button', { name: `Ver ${media.filename}`, exact: true }).click()
      await page.getByRole('button', { name: 'Abrir vista previa', exact: true }).click()
      const viewer = page.getByRole('dialog', { name: `Vista previa de ${media.filename}`, exact: true })
      await expect(viewer.locator('canvas')).toBeVisible()
      await expect.poll(() => viewer.locator('canvas').evaluate((canvas: HTMLCanvasElement) => {
        const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
        let green = 0
        for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 1] > pixels[i] + 50 && pixels[i + 1] > pixels[i + 2] + 20) green++
        return green
      })).toBeGreaterThan(100)
      await page.keyboard.press('Escape')
      await expect(viewer).toBeHidden()
      const parent = page.getByRole('dialog', { name: media.filename, exact: true })
      if (await parent.isVisible()) await page.keyboard.press('Escape')
    }
    const denied = await page.request.get(`${baseURL}/api/storage/content?object_key=${encodeURIComponent(file('other_account').object_key)}`)
    expect(denied.status()).toBe(404)
  })

  test('missing physical object reports a blocked review without retry loop or fabricated success', async ({ page }) => {
    const missing = file('missing')
    await open(page)
    await search(page, missing.filename)
    await expect(row(page, missing)).toBeVisible()
    await row(page, missing).getByRole('checkbox').check()
    await fixtureAction('simulate-missing')
    const content = await page.request.get(`${baseURL}/api/storage/content?object_key=${encodeURIComponent(missing.object_key)}`)
    expect(content.status()).toBe(404)
    let attempts = 0
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/storage/cleanup/preview') attempts++ })
    const reviewed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/storage/cleanup/preview')
    await page.getByRole('button', { name: 'Revisar selección', exact: true }).click()
    const response = await reviewed
    expect(response.status()).toBe(200)
    const result = await response.json()
    expect(result.eligible_count).toBe(0)
    expect(result.estimated_freed_bytes).toBe(0)
    expect(result.items).toHaveLength(1)
    expect(result.items[0].eligible).toBe(false)
    expect(result.items[0].size_bytes).toBe(0)
    expect(result.items[0].reason).toBeTruthy()
    const dialog = page.getByRole('dialog', { name: 'Revisar eliminación', exact: true })
    await expect(dialog.getByRole('button', { name: 'Confirmar retirada', exact: true })).toBeDisabled()
    await expect(dialog.getByText(result.items[0].reason, { exact: true })).toBeVisible()
    await page.screenshot({ path: resolve(evidenceDir, '02-objeto-ausente-bloqueado.png') })
    await page.keyboard.press('Escape')
    expect(attempts).toBe(1)
    const activity = await page.request.get(`${baseURL}/api/storage/activity`)
    expect((await activity.json()).total).toBe(0)
  })
})
