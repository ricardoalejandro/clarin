import { expect, test, type Page } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { createUtilitiesLibraryMock } from './helpers/utilitiesLibraryMock'

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3011'
test.use({ channel: process.env.PLAYWRIGHT_CHANNEL })
test.setTimeout(180_000)

async function setup(page: Page) {
  const library = createUtilitiesLibraryMock()
  await page.context().addCookies([{ name: 'auth-token', value: 'compact-synthetic-session', url: baseURL }])
  await page.addInitScript(() => {
    localStorage.setItem('token', 'cookie-session')
    localStorage.setItem('clarin:auth_refreshed_at', String(Date.now()))
    localStorage.setItem('clarin:eros:window:v2', JSON.stringify({ version: 2, mode: 'docked', geometry: { x: 720, y: 12, width: 440, height: 620 }, dockWidth: 440 }))
  })
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (await library.handle(route)) return
    if (path === '/api/utilities/access') return route.fulfill({ status: 204 })
    if (path === '/api/utilities/vault/status') return route.fulfill({ json: { success: true, data: { configured: true } } })
    if (path === '/api/utilities/vault') return route.fulfill({ json: { success: true, data: { items: [], has_more: false } } })
    if (path.startsWith('/api/eros/')) return route.fulfill({ json: { success: true, available: false, conversations: [], runs: [], tasks: [] } })
    return route.fulfill({ json: { success: true,
      user: { id: 'compact-user', username: 'qa', display_name: 'Usuario QA', account_id: 'compact-account', account_name: 'Cuenta QA', permissions: ['utilities'] },
      session: { scope: 'compact-scope', account_id: 'compact-account', idle_timeout_minutes: 180, server_now: new Date().toISOString(), idle_expires_at: new Date(Date.now() + 10_800_000).toISOString(), absolute_expires_at: new Date(Date.now() + 86_400_000).toISOString() },
    } })
  })
}

async function fits(page: Page) {
  await expect.poll(() => page.locator('main').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  const toolbar = page.locator('main .utility-work-toolbar').first()
  await expect(toolbar).toBeVisible()
  const expected = await toolbar.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches && !matchMedia('(any-pointer: coarse)').matches ? { control: 32, toolbar: 36 } : { control: 44, toolbar: 48 })
  expect((await toolbar.boundingBox())!.height).toBe(expected.toolbar)
  await expect.poll(() => toolbar.evaluate(element => {
    const bounds = element.getBoundingClientRect()
    const minimum = matchMedia('(hover: hover) and (pointer: fine)').matches && !matchMedia('(any-pointer: coarse)').matches ? 32 : 44
    return [...element.querySelectorAll('button,select')].every(control => {
      const rect = control.getBoundingClientRect()
      return !rect.width || (rect.height >= minimum && rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 && rect.top >= bounds.top && rect.bottom <= bounds.bottom + 1)
    })
  })).toBe(true)
}

for (const hasTouch of [false, true]) test.describe(hasTouch ? 'touch' : 'mouse', () => {
  test.use({ hasTouch })
  for (const tool of ['json', 'qr', 'imagen-base64', 'criptografia']) {
    test(`${tool} fits measured widths with library and Eros open and closed`, async ({ page }, testInfo) => {
      await setup(page)
      await page.setViewportSize({ width: 1263, height: 650 })
      await page.goto(`${baseURL}/dashboard/utilities/${tool}`)
      await expect(page.locator('main .utility-work-toolbar').first()).toBeVisible({ timeout: 60_000 })
      const measurements: unknown[] = []
      for (const width of [1263, 1440, 1024, 768, 375, 320]) {
        await page.setViewportSize({ width, height: width === 1263 ? 650 : 812 })
        await fits(page)
        if (tool === 'json' && width === 1263) {
          const rect = (await page.getByTestId('document-editor-a').boundingBox())!
          expect(rect.width).toBeGreaterThanOrEqual(1150)
          if (!hasTouch) expect(rect.height).toBeGreaterThanOrEqual(500)
          measurements.push({ width, editor: { width: rect.width, height: rect.height } })
        }
        await page.getByRole('button', { name: 'Abrir biblioteca', exact: true }).click()
        await expect(page.getByRole('complementary', { name: 'Mis documentos' })).toBeVisible()
        await fits(page)
        // Eros is fullscreen through 1024px. Open both surfaces before checking
        // their geometry, instead of clicking through that blocking window.
        await page.getByRole('button', { name: 'Cerrar biblioteca', exact: true }).first().focus()
        await page.keyboard.press('Control+i')
        const eros = page.getByLabel('Asistente Eros', { exact: true })
        await expect(eros).toBeVisible()
        await fits(page)
        await eros.getByTitle('Cerrar', { exact: true }).click({ timeout: 5000 })
        await expect(eros).toBeHidden()
        await page.getByRole('button', { name: 'Cerrar biblioteca', exact: true }).first().click()
        await page.keyboard.press('Control+i')
        await expect(eros).toBeVisible()
        await fits(page)
        await eros.getByTitle('Cerrar', { exact: true }).click({ timeout: 5000 })
        await expect(eros).toBeHidden()
        await fits(page)
        if ([1263, 320].includes(width)) {
          await expect(page.getByRole('button', { name: 'Estado del guardado', exact: true })).toHaveAttribute('title', /^Guardado/)
          await page.screenshot({ path: testInfo.outputPath(`${tool}-${width}.png`) })
        }
      }
      if (tool === 'criptografia') {
        for (const value of ['hash', 'keys', 'base64', 'vault']) {
          await page.getByRole('combobox', { name: 'Herramienta de criptografía' }).selectOption(value)
          await fits(page)
        }
      }
      const metricsPath = testInfo.outputPath('measurements.json')
      await writeFile(metricsPath, JSON.stringify(measurements, null, 2))
      await testInfo.attach('measurements.json', { path: metricsPath, contentType: 'application/json' })
    })
  }
})

test('captures the previous reference layout for comparison', async ({ page }, testInfo) => {
  test.skip(process.env.CLARIN_CAPTURE_COMPARISON !== 'before')
  await setup(page)
  await page.setViewportSize({ width: 1263, height: 650 })
  await page.goto(`${baseURL}/dashboard/utilities/json`)
  await expect(page.getByTestId('document-editor-a')).toBeVisible({ timeout: 60_000 })
  await page.screenshot({ path: testInfo.outputPath('json-1263-before.png') })
  const metricsPath = testInfo.outputPath('before-measurement.json')
  await writeFile(metricsPath, JSON.stringify(await page.getByTestId('document-editor-a').boundingBox(), null, 2))
  await testInfo.attach('before-measurement.json', { path: metricsPath, contentType: 'application/json' })
})
