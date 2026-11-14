import { expect, test, type Locator, type Page } from '@playwright/test'

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3011'
const samplePng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
test.use({ channel: process.env.PLAYWRIGHT_CHANNEL })

async function mockDashboard(page: Page) {
  await page.addInitScript(() => {
    const now = String(Date.now())
    localStorage.setItem('token', 'cookie-session')
    localStorage.setItem('clarin:auth_refreshed_at', now)
    localStorage.setItem('clarin:last_activity_at', now)
  })
  await page.context().addCookies([{ name: 'refresh-token', value: 'playwright-refresh-session', url: baseURL, httpOnly: true, sameSite: 'Lax' }])
  await page.route('**/api/**', route => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname === '/api/utilities/access') return route.fulfill({ status: 204 })
    if (pathname === '/api/me') return route.fulfill({ json: {
      success: true,
      user: { id: 'utility-user', username: 'utility-user', display_name: 'Utilitarios QA', role: 'user', account_id: 'test-account', account_name: 'Cuenta QA', is_admin: false, is_super_admin: false, subscription_active: true, permissions: ['utilities'] },
      accounts: [],
    } })
    return route.fulfill({ json: { success: true, version: 'test' } })
  })
}

async function pasteImage(target: Locator, bytes: Buffer) {
  await target.focus()
  await target.evaluate((element, buffer) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([new Uint8Array(buffer)], 'imagen.png', { type: 'image/png' }))
    const event = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true })
    element.dispatchEvent(event)
  }, Array.from(bytes))
}

test.describe('Utilitarios de imagen', () => {
  test.setTimeout(90_000)

  test('genera un PNG y lee el contenido pegado como texto mediante el worker', async ({ page }) => {
    await mockDashboard(page)
    const privateContent = 'https://example.test/qr?valor=á-privado-4198'
    const transferred: string[] = []
    page.on('request', request => { transferred.push(`${request.url()} ${request.postData() ?? ''}`) })
    page.on('websocket', socket => socket.on('framesent', frame => { transferred.push(String(frame.payload)) }))

    await page.goto(`${baseURL}/dashboard/utilities/qr`)
    await page.getByRole('textbox', { name: 'Texto o enlace' }).fill(privateContent)
    await page.getByRole('button', { name: 'Generar QR' }).click()
    const preview = page.getByRole('img', { name: 'Código QR generado' })
    await expect(preview).toBeVisible()
    const dataUrl = await preview.getAttribute('src')
    expect(dataUrl).toMatch(/^data:image\/png;base64,/)
    await expect(page.getByRole('button', { name: 'Descargar SVG' })).toBeEnabled()

    await page.getByRole('radio', { name: 'Leer QR' }).press('Space')
    await pasteImage(page.getByRole('group', { name: 'Área para pegar o soltar una imagen' }), Buffer.from(dataUrl!.split(',')[1], 'base64'))
    await page.getByRole('button', { name: 'Leer QR' }).click()
    await expect(page.getByRole('textbox', { name: 'Contenido del QR' })).toHaveValue(privateContent)
    await expect(page.getByRole('link', { name: privateContent })).toHaveCount(0)
    expect(transferred.some(payload => payload.includes(privateContent) || payload.includes(encodeURIComponent(privateContent)))).toBe(false)

    await page.getByRole('button', { name: 'Quitar imagen' }).click()
    await expect(page.getByRole('textbox', { name: 'Contenido del QR' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Leer QR' })).toBeDisabled()
  })

  test('convierte el archivo original a Base64 y abre la Data URL resultante', async ({ page }) => {
    await mockDashboard(page)
    await page.goto(`${baseURL}/dashboard/utilities/imagen-base64`)
    await page.locator('input[type="file"]').setInputFiles({ name: 'original.png', mimeType: 'image/png', buffer: Buffer.from(samplePng, 'base64') })
    await page.getByRole('button', { name: 'Convertir a Base64' }).click()
    await expect(page.getByRole('textbox', { name: 'Texto Base64 resultante' })).toHaveValue(samplePng)
    await page.getByRole('radio', { name: 'Data URL' }).press('Space')
    const dataUrl = `data:image/png;base64,${samplePng}`
    await expect(page.getByRole('textbox', { name: 'Texto Base64 resultante' })).toHaveValue(dataUrl)

    await page.getByRole('radio', { name: 'Base64 a imagen' }).press('Space')
    const input = page.getByRole('textbox', { name: 'Texto Base64 o Data URL' })
    await input.fill(dataUrl)
    await page.getByRole('button', { name: 'Convertir a imagen' }).click()
    await expect(page.getByRole('img', { name: 'Vista previa de la imagen' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Descargar imagen' })).toBeEnabled()

    await input.fill('data:image/svg+xml;base64,PHN2Zz4=')
    await page.getByRole('button', { name: 'Convertir a imagen' }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'Data URL Base64' })).toBeVisible()
    await expect(page.getByRole('img', { name: 'Vista previa de la imagen' })).toHaveCount(0)
  })
})
