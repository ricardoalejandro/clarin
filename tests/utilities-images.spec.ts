import { expect, test, type Locator, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { createUtilitiesLibraryMock } from './helpers/utilitiesLibraryMock'

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
  const library = createUtilitiesLibraryMock()
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname === '/api/utilities/access') return route.fulfill({ status: 204 })
    if (await library.handle(route)) return
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
    const qrDownloads = page.getByRole('button', { name: 'Descargar QR' })
    await qrDownloads.click()
    await expect(page.getByRole('menuitem', { name: 'Descargar SVG' })).toBeEnabled()
    const pngDownload = page.waitForEvent('download')
    await page.getByRole('menuitem', { name: 'Descargar PNG' }).click()
    const png = await pngDownload
    expect(png.suggestedFilename()).toBe('codigo-qr.png')
    expect(await readFile((await png.path())!)).toEqual(Buffer.from(dataUrl!.split(',')[1], 'base64'))
    await qrDownloads.click()
    const svgDownload = page.waitForEvent('download')
    await page.getByRole('menuitem', { name: 'Descargar SVG' }).click()
    const svg = await svgDownload
    expect(svg.suggestedFilename()).toBe('codigo-qr.svg')
    expect(await readFile((await svg.path())!, 'utf8')).toContain('<svg')
    await expect(qrDownloads).toBeFocused()

    await page.getByRole('combobox', { name: 'Operación de QR' }).selectOption('read')
    await pasteImage(page.getByRole('group', { name: 'Área para pegar o soltar una imagen' }), Buffer.from(dataUrl!.split(',')[1], 'base64'))
    await page.getByRole('button', { name: 'Leer QR' }).click()
    await expect(page.getByRole('textbox', { name: 'Contenido del QR' })).toHaveValue(privateContent)
    await expect(page.getByRole('link', { name: privateContent })).toHaveCount(0)
    expect(transferred.filter(payload => !payload.includes('/api/utilities/')).some(payload => payload.includes(privateContent) || payload.includes(encodeURIComponent(privateContent)))).toBe(false)

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
    await page.getByRole('combobox', { name: 'Formato de salida' }).selectOption('url')
    const dataUrl = `data:image/png;base64,${samplePng}`
    await expect(page.getByRole('textbox', { name: 'Texto Base64 resultante' })).toHaveValue(dataUrl)

    await page.getByRole('combobox', { name: 'Conversión de imagen' }).selectOption('decode')
    const input = page.getByRole('textbox', { name: 'Texto Base64 o Data URL' })
    await input.fill(dataUrl)
    await page.getByRole('button', { name: 'Convertir a imagen' }).click()
    await expect(page.getByRole('img', { name: 'Vista previa de la imagen' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Descargar imagen' })).toBeEnabled()
    const imageDownload = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Descargar imagen' }).click()
    expect(await readFile((await (await imageDownload).path())!)).toEqual(Buffer.from(samplePng, 'base64'))

    await input.fill('data:image/svg+xml;base64,PHN2Zz4=')
    await page.getByRole('button', { name: 'Convertir a imagen' }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'Data URL Base64' })).toBeVisible()
    await expect(page.getByRole('img', { name: 'Vista previa de la imagen' })).toHaveCount(0)
  })

  test('adapta ambos paneles al espacio medido sin desbordar las acciones', async ({ page }, testInfo) => {
    await mockDashboard(page)
    for (const tool of ['qr', 'imagen-base64']) {
      await page.goto(`${baseURL}/dashboard/utilities/${tool}`)
      const toolbar = page.getByRole('group', { name: tool === 'qr' ? 'Acciones de QR' : 'Acciones de imagen' })
      await expect(toolbar).toBeVisible()
      for (const width of [1280, 1024, 375, 320]) {
        await page.setViewportSize({ width, height: 800 })
        await expect.poll(async () => toolbar.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
        const pair = page.locator('.utility-pair').filter({ has: tool === 'qr' ? page.getByRole('textbox', { name: 'Texto o enlace' }) : page.getByRole('group', { name: 'Área para pegar o soltar una imagen' }) })
        await expect.poll(async () => pair.evaluate(element => {
          const host = element.closest('.utility-density-scope')!
          const panels = Array.from(element.children).map(child => child.getBoundingClientRect())
          const wide = host.getBoundingClientRect().width >= 672
          return wide ? Math.abs(panels[0].top - panels[1].top) <= 1 : panels[1].top >= panels[0].bottom
        })).toBe(true)
        await expect.poll(async () => pair.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
        const screenshot = testInfo.outputPath(`${tool}-${width}.png`)
        await page.screenshot({ path: screenshot })
        await testInfo.attach(`${tool}-${width}`, { path: screenshot, contentType: 'image/png' })
      }
    }
  })
})
