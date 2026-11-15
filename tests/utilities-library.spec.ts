import { expect, test, type Page } from '@playwright/test'
import { createUtilitiesLibraryMock } from './helpers/utilitiesLibraryMock'

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3011'
test.use({ channel: process.env.PLAYWRIGHT_CHANNEL })
test.setTimeout(90_000)

async function setup(page: Page) {
  const library = createUtilitiesLibraryMock()
  await page.context().addCookies([{ name: 'auth-token', value: 'library-browser-session', url: baseURL }])
  await page.addInitScript(() => { localStorage.setItem('token', 'cookie-session'); localStorage.setItem('clarin:auth_refreshed_at', String(Date.now())) })
  await page.route('**/api/**', async route => {
    if (await library.handle(route)) return
    if (new URL(route.request().url()).pathname === '/api/utilities/access') return route.fulfill({ status: 204 })
    return route.fulfill({ json: { success: true, user: { id: 'library-user', username: 'qa', display_name: 'Biblioteca QA', account_id: 'library-account', account_name: 'Cuenta QA', permissions: ['utilities'] }, session: { scope: 'library-scope', account_id: 'library-account', idle_timeout_minutes: 180, server_now: new Date().toISOString(), idle_expires_at: new Date(Date.now() + 10_800_000).toISOString(), absolute_expires_at: new Date(Date.now() + 86_400_000).toISOString() } } })
  })
  await page.setViewportSize({ width: 1600, height: 1000 })
  return library
}

async function rename(page: Page, title: string) {
  await page.getByRole('button', { name: 'Renombrar documento', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Renombrar documento' })
  await dialog.getByRole('textbox', { name: 'Nombre' }).fill(title)
  await dialog.getByRole('button', { name: 'Guardar', exact: true }).click()
  await expect(dialog).toBeHidden()
}

test('keeps independent same-tool tabs, saves, renames, searches, reopens and deletes documents', async ({ page }, testInfo) => {
  const library = await setup(page)
  await page.goto(`${baseURL}/dashboard/utilities`)
  await page.getByRole('button', { name: 'Códigos QR', exact: true }).click()
  await rename(page, 'QR sucursal')
  await page.getByRole('textbox', { name: 'Texto o enlace' }).fill('contenido-buscable-iquitos')
  await expect.poll(() => [...library.contents.values()].some(value => value.toString().includes('contenido-buscable-iquitos'))).toBe(true)

  await page.getByRole('button', { name: 'Códigos QR', exact: true }).click()
  await rename(page, 'QR pruebas')
  await expect(page.getByRole('textbox', { name: 'Texto o enlace' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Texto o enlace' }).fill('otro documento independiente')
  await page.getByRole('tab', { name: 'QR sucursal' }).click()
  await expect(page.getByRole('textbox', { name: 'Texto o enlace' })).toHaveValue('contenido-buscable-iquitos')
  await page.getByRole('button', { name: 'Cerrar pestaña QR sucursal' }).click()
  await expect(page.getByRole('textbox', { name: 'Texto o enlace' })).toHaveValue('otro documento independiente')
  expect(library.documents.size).toBe(2)
  expect(library.writes.some(write => write.startsWith('delete:'))).toBe(false)

  await page.getByRole('textbox', { name: 'Buscar documentos por nombre o contenido' }).fill('contenido-buscable-iquitos')
  const sidebar = page.getByRole('complementary', { name: 'Mis documentos' })
  await expect(sidebar.getByRole('button', { name: /QR pruebas/ })).toHaveCount(0)
  await sidebar.getByRole('button', { name: /QR sucursal/ }).click()
  await expect(page.getByRole('textbox', { name: 'Texto o enlace' })).toHaveValue('contenido-buscable-iquitos')
  await expect.poll(() => library.documents.get(library.getWorkspace().active_id ?? '')?.title).toBe('QR sucursal')
  await page.reload()
  await expect(page.getByRole('tab', { name: 'QR sucursal' })).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 })
  await expect(page.getByRole('textbox', { name: 'Texto o enlace' })).toHaveValue('contenido-buscable-iquitos')
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('contenido-buscable-iquitos')
  await testInfo.attach('biblioteca-documentos.png', { body: await page.screenshot({ path: testInfo.outputPath('biblioteca-documentos.png') }), contentType: 'image/png' })

  await page.getByRole('button', { name: 'Eliminar documento', exact: true }).click()
  await page.getByRole('dialog', { name: 'Eliminar documento' }).getByRole('button', { name: 'Eliminar definitivamente' }).click()
  await expect(page.getByRole('tab', { name: 'QR sucursal' })).toHaveCount(0)
  expect(library.documents.size).toBe(1)
  expect([...library.contents.values()].some(value => value.toString().includes('contenido-buscable-iquitos'))).toBe(false)
})

test('preserves unsaved work on conflict and saves it as an independent copy', async ({ page }) => {
  const library = await setup(page)
  await page.goto(`${baseURL}/dashboard/utilities/qr`)
  await page.getByRole('textbox', { name: 'Texto o enlace' }).fill('valor confirmado')
  await expect.poll(() => [...library.contents.values()].some(value => value.toString() === 'valor confirmado')).toBe(true)
  library.failSave(409)
  await page.getByRole('textbox', { name: 'Texto o enlace' }).fill('borrador que no se puede perder')
  await expect(page.getByRole('status').filter({ hasText: 'Conflicto de versión' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Texto o enlace' })).toHaveValue('borrador que no se puede perder')
  await page.getByRole('button', { name: 'Guardar una copia', exact: true }).click()
  await expect(page.getByRole('tab', { name: /copia/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('textbox', { name: 'Texto o enlace' })).toHaveValue('borrador que no se puede perder')
  expect(library.documents.size).toBe(2)
})

test('remains usable at narrow widths and keeps closing distinct from deleting', async ({ page }) => {
  await setup(page)
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(`${baseURL}/dashboard/utilities/qr`)
  await page.getByRole('textbox', { name: 'Texto o enlace' }).fill('documento móvil')
  await page.getByRole('button', { name: 'Abrir biblioteca' }).click()
  await expect(page.getByRole('textbox', { name: 'Buscar documentos por nombre o contenido' })).toBeVisible()
  await page.getByRole('button', { name: 'Cerrar biblioteca' }).click()
  await expect(page.getByRole('textbox', { name: 'Texto o enlace' })).toHaveValue('documento móvil')
  await expect.poll(() => page.getByRole('main').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
})

test('keeps at least 200px for editing at 320px and exposes complete keyboard menus', async ({ page }, testInfo) => {
  await setup(page)
  await page.setViewportSize({ width: 320, height: 740 })
  await page.goto(`${baseURL}/dashboard/utilities/json`)
  const editor = page.getByTestId('document-editor-a')
  await expect(editor).toBeVisible({ timeout: 30_000 })
  await expect.poll(async () => (await editor.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(200)
  expect((await page.locator('[data-utility-create-toolbar]').boundingBox())!.height).toBeLessThanOrEqual(56)
  expect((await page.locator('[data-utility-document-toolbar]').boundingBox())!.height).toBeLessThanOrEqual(48)
  const actions = page.getByRole('button', { name: 'Acciones del documento', exact: true })
  await actions.focus(); await actions.press('ArrowDown')
  const actionMenu = page.getByRole('menu', { name: 'Acciones del documento' })
  await expect(actionMenu).toBeVisible()
  await page.keyboard.press('End')
  await expect(actionMenu.getByRole('menuitem', { name: 'Eliminar documento', exact: true })).toBeFocused()
  const rectangle = (await actionMenu.boundingBox())!
  expect(rectangle.x).toBeGreaterThanOrEqual(0); expect(rectangle.x + rectangle.width).toBeLessThanOrEqual(320)
  expect(rectangle.y).toBeGreaterThanOrEqual(0); expect(rectangle.y + rectangle.height).toBeLessThanOrEqual(740)
  await page.keyboard.press('Escape')
  await expect(actions).toBeFocused()
  await expect.poll(() => page.getByRole('main').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('editor-320-usable.png') })
  await page.getByRole('button', { name: 'Nuevo documento', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Códigos QR', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Texto o enlace' })).toBeVisible()
  await expect(page.getByRole('tab')).toHaveCount(2)
})
