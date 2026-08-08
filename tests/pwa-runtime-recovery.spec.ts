import { expect, test } from '@playwright/test'

const baseURL = process.env.CLARIN_E2E_BASE_URL || 'https://clarin.naperu.cloud'
const baseOrigin = new URL(baseURL).origin

function dispatchChunkLoadError() {
  const reason = Object.assign(new Error('Loading chunk 9999 failed'), { name: 'ChunkLoadError' })
  window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', {
    promise: Promise.resolve(),
    reason,
  }))
}

test.describe('PWA runtime recovery', () => {
  test('loads login resources and exposes the deployed PWA contract', async ({ page, request }) => {
    const failedSameOriginRequests: string[] = []
    const chunkErrors: string[] = []

    page.on('requestfailed', failed => {
      if (new URL(failed.url()).origin === baseOrigin) failedSameOriginRequests.push(failed.url())
    })
    page.on('console', message => {
      if (message.type() === 'error' && /ChunkLoadError|Application error|Loading chunk/i.test(message.text())) {
        chunkErrors.push(message.text())
      }
    })

    const navigation = await page.goto(`${baseURL}/login?reason=idle`, { waitUntil: 'domcontentloaded' })
    expect(navigation?.status()).toBe(200)
    await expect(page.getByRole('status')).toContainText('30 minutos sin actividad')
    await page.waitForTimeout(1_000)

    const manifest = await request.get(`${baseURL}/manifest.webmanifest`)
    expect(manifest.status()).toBe(200)
    expect(manifest.headers()['content-type']).toContain('application/manifest+json')
    expect(await manifest.json()).toMatchObject({
      name: 'Clarin',
      start_url: '/dashboard',
      display: 'standalone',
    })

    const serviceWorker = await request.get(`${baseURL}/sw.js`)
    expect(serviceWorker.status()).toBe(200)
    expect(serviceWorker.headers()['cache-control']).toContain('no-store')
    const serviceWorkerSource = await serviceWorker.text()
    expect(serviceWorkerSource).toContain('STATIC_FETCH_TIMEOUT_MS = 10000')
    expect(serviceWorkerSource).toContain("fetchWithTimeout(request, 'reload')")
    expect(serviceWorkerSource).not.toContain('self.skipWaiting()')
    expect(serviceWorkerSource).not.toContain('self.clients.claim()')

    expect(failedSameOriginRequests).toEqual([])
    expect(chunkErrors).toEqual([])
  })

  test('reloads once for a chunk failure and then shows a recoverable screen', async ({ page }) => {
    await page.goto(`${baseURL}/login`, { waitUntil: 'domcontentloaded' })

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      page.evaluate(dispatchChunkLoadError),
    ])
    await expect(page.getByRole('heading', { name: 'Clarin' })).toBeVisible()
    expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('clarin:chunk-recovery:')))).toHaveLength(1)

    await page.evaluate(dispatchChunkLoadError)
    await expect(page.getByRole('heading', { name: 'Clarin necesita actualizarse' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Reintentar' })).toBeVisible()

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      page.getByRole('button', { name: 'Reintentar' }).click(),
    ])
    await expect(page.getByRole('heading', { name: 'Clarin' })).toBeVisible()
  })

  test('keeps login and the inactivity notice usable at mobile width', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto(`${baseURL}/login?reason=idle`, { waitUntil: 'domcontentloaded' })

    await expect(page.getByRole('status')).toContainText('30 minutos sin actividad')
    await expect(page.getByRole('button', { name: 'Iniciar sesión' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

    const submitBox = await page.getByRole('button', { name: 'Iniciar sesión' }).boundingBox()
    expect(submitBox).not.toBeNull()
    expect(submitBox!.x).toBeGreaterThanOrEqual(0)
    expect(submitBox!.x + submitBox!.width).toBeLessThanOrEqual(375)
  })
})
