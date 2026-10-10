import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Full local browser -> API -> PostgreSQL/Redis/MinIO acceptance. No API mocks.
// Create the disposable fixture with scripts/qa/storage-ui-fixture.sh first.
const enabled = process.env.CLARIN_STORAGE_BROWSER_QA === '1'
const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000'
const manifestPath = process.env.CLARIN_STORAGE_UI_QA_MANIFEST || resolve('work/storage-ui-qa/fixture.private.json')
const evidenceDir = process.env.CLARIN_STORAGE_QA_EVIDENCE_DIR || resolve('work/qa-acceptance/evidence')

type Actor = { username: string; password: string; account_id: string }
type Media = { label: string; account_id: string; object_key: string; filename: string; media_type: string; size_bytes: number; sha256: string }
type Fixture = { accounts: { a: { id: string; name: string }; b: { id: string; name: string } }; actors: { admin_a: Actor; member_a: Actor }; files: Media[] }
let fixture: Fixture
const runtimeErrors = new WeakMap<Page, string[]>()
const statuses: { method: string; path: string; status: number }[] = []

test.describe('Storage native browser acceptance', () => {
  test.skip(!enabled, 'requires explicit disposable local browser QA opt-in')
  test.describe.configure({ mode: 'serial' })
  test.beforeAll(() => {
    if (!['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname)) throw new Error('Native storage QA requires a local frontend')
    fixture = JSON.parse(readFileSync(manifestPath, 'utf8')) as Fixture
    mkdirSync(evidenceDir, { recursive: true })
  })
  test.beforeEach(async ({ page }) => {
    const errors: string[] = []
    runtimeErrors.set(page, errors)
    await page.addInitScript(() => localStorage.setItem('sidebar_collapsed', 'false'))
    page.on('pageerror', error => errors.push(error.message))
    page.on('response', response => {
      const path = new URL(response.url()).pathname
      if (path.startsWith('/api/storage/')) statuses.push({ method: response.request().method(), path, status: response.status() })
    })
  })
  test.afterEach(async ({ page }) => {
    expect(runtimeErrors.get(page) || [], 'uncaught browser runtime errors').toEqual([])
  })
  test.afterAll(() => {
    if (enabled) writeFileSync(resolve(evidenceDir, 'solicitudes-almacenamiento.json'), JSON.stringify({ scope: 'Local native QA; paths and statuses only, no credentials or query strings', requests: statuses }, null, 2) + '\n')
  })

  test('real login, authorized inventory, filters, protected uses and media previews', async ({ page }) => {
    await login(page, fixture.actors.admin_a)
    await openStorage(page)
    await expect(page.getByText('Espacio de la cuenta', { exact: true })).toBeVisible()
    await expect(row(page, media('shared')).getByRole('checkbox')).toBeDisabled()
    await capture(page, '01-escritorio-lista.png')

    await page.getByRole('button', { name: 'Vista de cuadrícula', exact: true }).click()
    await row(page, media('photo')).scrollIntoViewIfNeeded()
    await expect(row(page, media('photo')).locator('img')).toBeVisible()
    await expect.poll(() => row(page, media('photo')).locator('img').evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true)
    await capture(page, '02-escritorio-cuadricula.png')
    await page.getByRole('button', { name: 'Fotos', exact: false }).click()
    await expect(row(page, media('photo'))).toBeVisible()
    await expect(row(page, media('document'))).toHaveCount(0)
    await page.getByRole('button', { name: 'Todos', exact: true }).click()
    await page.getByLabel('Tamaño mínimo', { exact: true }).selectOption('10485760')
    await expect(row(page, media('large_audio'))).toBeVisible()
    await expect(page.locator('[data-storage-workspace] article')).toHaveCount(1)
    await page.getByRole('button', { name: 'Limpiar filtros', exact: true }).click()
    await page.getByRole('button', { name: 'Vista de lista', exact: true }).click()

    await row(page, media('shared')).getByRole('button', { name: 'Ver detalles', exact: true }).click()
    const protectedDialog = page.getByRole('dialog', { name: media('shared').filename, exact: true })
    await expect(protectedDialog.getByRole('heading', { name: 'Dónde se usa' })).toBeVisible()
    await expect(protectedDialog.getByRole('link')).toHaveCount(2)
    await capture(page, '03-archivo-compartido-protegido.png')
    await protectedDialog.getByRole('button', { name: 'Cerrar', exact: true }).click()

    for (const label of ['photo', 'audio', 'video']) {
      const file = media(label)
      await row(page, file).getByRole('button', { name: 'Ver detalles', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: file.filename, exact: true })
      if (label === 'photo') {
        const photo = dialog.getByRole('img', { name: file.filename })
        await expect(photo).toBeVisible()
        await expect.poll(() => photo.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true)
        await capture(page, '04-vista-previa-foto.png')
      } else {
        const element = dialog.locator(label)
        await expect(element).toBeVisible()
        await expect.poll(() => element.evaluate((node: HTMLMediaElement) => node.readyState)).toBeGreaterThanOrEqual(2)
      }
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
    }

    await row(page, media('document')).getByRole('button', { name: 'Ver detalles', exact: true }).click()
    await page.getByRole('button', { name: 'Abrir vista previa', exact: true }).click()
    const pdf = page.getByRole('dialog', { name: `Vista previa de ${media('document').filename}`, exact: true })
    const canvas = pdf.locator('canvas')
    await expect(canvas).toBeVisible()
    // The real fixture PDF contains a green rectangle; an empty canvas is not
    // sufficient evidence that the PDF renderer painted the downloaded bytes.
    await expect.poll(() => canvas.evaluate((node: HTMLCanvasElement) => {
      const pixels = node.getContext('2d')!.getImageData(0, 0, node.width, node.height).data
      let green = 0
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 1] > pixels[i] + 50 && pixels[i + 1] > pixels[i + 2] + 20) green++
      return green
    }), { timeout: 40_000 }).toBeGreaterThan(100)
    await capture(page, '05-vista-previa-documento.png')
    await page.keyboard.press('Escape')
  })

  test('review performs no removal; trash and restore persist and reconcile without reloading', async ({ page }) => {
    await login(page, fixture.actors.admin_a)
    await openStorage(page)
    const file = media('restore')
    await row(page, file).getByRole('checkbox').check()
    const trigger = page.getByRole('button', { name: 'Revisar selección', exact: true })
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: 'Revisar eliminación', exact: true })
    await expect(dialog).toBeVisible()
    expect((await files(page)).some((item: any) => item.object_key === file.object_key)).toBe(true)
    await capture(page, '06-revision-antes-de-retirar.png')
    await page.keyboard.press('Escape')
    await expect(trigger).toBeFocused()
    await trigger.press('Enter')
    await dialog.getByRole('button', { name: 'Mover a la papelera', exact: true }).click()
    await expect(page.getByText(/1 archivo en la papelera/)).toBeVisible()
    await expect(page.getByText(/Todavía no se ha liberado espacio/)).toBeVisible()
    await expect(row(page, file)).toHaveCount(0)

    await page.getByRole('tab', { name: 'Papelera', exact: true }).click()
    await expect(row(page, file)).toBeVisible()
    await capture(page, '07-papelera-recuperable.png')
    await row(page, file).getByRole('checkbox').check()
    await expect(page.getByRole('button', { name: 'Revisar borrado', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Restaurar', exact: true }).click()
    await page.getByRole('dialog', { name: 'Revisar restauración', exact: true }).getByRole('button', { name: 'Restaurar archivos', exact: true }).click()
    await expect(page.getByText(/1 archivo restaurado/)).toBeVisible()
    await page.getByRole('tab', { name: 'Archivos', exact: true }).click()
    await expect(row(page, file)).toBeVisible()
    const content = await page.request.get(`${baseURL}/api/storage/content?object_key=${encodeURIComponent(file.object_key)}`)
    expect(content.status()).toBe(200)
    expect((await content.body()).byteLength).toBe(file.size_bytes)
  })

  test('retention blocks early purge; aged QA file requires acknowledgment and becomes inaccessible', async ({ page }) => {
    await login(page, fixture.actors.admin_a)
    await openStorage(page)
    await page.getByRole('tab', { name: 'Papelera', exact: true }).click()
    const recent = media('trash_recent')
    await row(page, recent).getByRole('checkbox').check()
    await expect(page.getByRole('button', { name: 'Revisar borrado', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Cancelar selección', exact: true }).click()
    const file = media('purge')
    await row(page, file).getByRole('checkbox').check()
    await page.getByRole('button', { name: 'Revisar borrado', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Revisar borrado definitivo', exact: true })
    const confirm = dialog.getByRole('button', { name: 'Eliminar definitivamente', exact: true })
    await expect(confirm).toBeDisabled()
    await capture(page, '08-confirmacion-borrado-definitivo.png')
    await dialog.getByRole('checkbox').check()
    await confirm.click()
    await expect(page.getByRole('region', { name: 'Resultado de la operación' })).toContainText(/liberado/i)
    await expect(row(page, file)).toHaveCount(0)
    const content = await page.request.get(`${baseURL}/api/storage/content?object_key=${encodeURIComponent(file.object_key)}`)
    expect(content.status()).toBe(404)
    await page.getByRole('tab', { name: 'Actividad', exact: true }).click()
    await expect(page.getByText('Tus operaciones y los borrados definitivos de esta cuenta', { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Borrado definitivo', exact: true })).toBeVisible()
    await capture(page, '09-actividad-y-resultados.png')
  })

  test('account switch clears selection and content; foreign account media are denied', async ({ page }) => {
    await login(page, fixture.actors.admin_a)
    await openStorage(page)
    const denied = await page.request.get(`${baseURL}/api/storage/content?object_key=${encodeURIComponent(media('other_account').object_key)}`)
    expect(denied.status()).toBe(404)
    await row(page, media('restore')).getByRole('checkbox').check()
    await page.getByRole('button', { name: fixture.accounts.a.name, exact: true }).click()
    const switcher = page.getByRole('dialog', { name: 'Cambiar cuenta', exact: true })
    await switcher.getByRole('option').filter({ hasText: fixture.accounts.b.name }).click()
    await page.waitForURL(`${baseURL}/dashboard`)
    await openStorage(page)
    await expect(row(page, media('other_account'))).toBeVisible()
    await expect(row(page, media('restore'))).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Revisar selección', exact: true })).toHaveCount(0)
    const afterSwitch = await page.request.get(`${baseURL}/api/storage/content?object_key=${encodeURIComponent(media('restore').object_key)}`)
    expect(afterSwitch.status()).toBe(404)
    await capture(page, '10-cuenta-b-aislada.png')
  })

  test('member view protects quota; responsive layout and keyboard work on real data', async ({ page }) => {
    await login(page, fixture.actors.member_a)
    await openStorage(page)
    await expect(page.getByText('Archivos a los que tienes acceso', { exact: true })).toBeVisible()
    await expect(page.getByRole('progressbar', { name: 'Espacio utilizado' })).toHaveCount(0)
    const usage = await page.request.get(`${baseURL}/api/storage/usage`)
    const data = await usage.json()
    expect(data.scope).toBe('authorized')
    expect(data.limit_bytes).toBe(0)
    expect(data.available_bytes).toBe(0)
    for (const width of [320, 375, 768, 1024, 1280, 1440]) {
      await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `horizontal overflow at ${width}px`).toBeLessThanOrEqual(0)
      await expect(page.getByRole('button', { name: 'Revisar archivos', exact: true })).toBeVisible()
      if (width === 375) await capture(page, '11-movil-resumen.png')
    }
    await page.setViewportSize({ width: 375, height: 844 })
    await page.getByRole('button', { name: 'Revisar archivos', exact: true }).click()
    await row(page, media('restore')).scrollIntoViewIfNeeded()
    await capture(page, '12-movil-archivos.png')
    await row(page, media('restore')).getByRole('checkbox').focus()
    await page.keyboard.press('Space')
    await page.getByRole('button', { name: 'Revisar selección', exact: true }).press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Revisar eliminación', exact: true })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Cerrar ventana', exact: true })).toBeFocused()
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab')
      expect(await dialog.evaluate(node => node.contains(document.activeElement)), `Tab ${i} escaped the dialog`).toBe(true)
    }
    await capture(page, '13-movil-revision.png')
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })
})

function media(label: string): Media {
  const file = fixture.files.find(item => item.label === label)
  if (!file) throw new Error(`Missing synthetic fixture label: ${label}`)
  return file
}
function row(page: Page, file: Media) {
  return page.locator('[data-storage-workspace] article').filter({ has: page.getByRole('button', { name: file.filename, exact: true }) })
}
async function login(page: Page, actor: Actor) {
  // The server-rendered form can exist before its client bundle hydrates.
  // This request is made by the mounted login effect, so it is a concrete
  // readiness signal and also checks the real security configuration endpoint.
  const ready = page.waitForResponse(response => new URL(response.url()).pathname === '/api/public/security-config')
  await page.goto(`${baseURL}/login`, { waitUntil: 'domcontentloaded' })
  expect((await ready).status()).toBe(200)
  await page.getByPlaceholder('usuario o correo').fill(actor.username)
  try {
    await page.getByPlaceholder('tu contraseña').fill(actor.password)
  } catch {
    // Playwright includes fill values in timeout call logs. Do not persist the
    // disposable password in reporters if the login form cannot be filled.
    throw new Error('Could not fill the private QA password field')
  }
  const authenticated = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/login' && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click()
  expect((await authenticated).status()).toBe(200)
  await page.waitForURL(/\/dashboard(?:\/|$|\?)/, { timeout: 90_000 })
}
async function openStorage(page: Page) {
  await page.goto(`${baseURL}/dashboard/storage`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'Almacenamiento', exact: true })).toBeVisible()
  await expect(page.getByRole('status', { name: 'Cargando archivos' })).toHaveCount(0)
  await expect(page.locator('[data-storage-workspace] article').first()).toBeVisible()
}
async function files(page: Page) {
  const response = await page.request.get(`${baseURL}/api/storage/files?limit=40&status=all`)
  expect(response.status()).toBe(200)
  return (await response.json()).files
}
async function capture(page: Page, name: string) {
  await page.screenshot({ path: resolve(evidenceDir, name), fullPage: name.includes('-escritorio-'), animations: 'disabled' })
}
