import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

// The sole substituted resource is the exact public pre-v4 service worker.
// Login, Turnstile verification and account data use the real isolated stack.
test.use({ trace: 'off', video: 'off', actionTimeout: 30_000, navigationTimeout: 30_000 })

test('ordinary real login remains usable with the legacy production worker still active', async ({ browser }) => {
  test.setTimeout(150_000)
  const { labOrigin, labRoot, verifyLabIdentity } = await import('../scripts/offline/browser-qa-environment.mjs')
  await verifyLabIdentity()
  const source = (await readFile(join(__dirname, 'fixtures/offline-v4-legacy-sw.js'), 'utf8')).trimEnd()
  const baseline = 'd3c0c4f8cbc076d36519a07c90369d111f5fe2bfaf57a472b11ef338118895e9'
  expect(createHash('sha256').update(source).digest('hex')).toBe(baseline)
  const credentials = JSON.parse(await readFile(join(labRoot, 'credentials.json'), 'utf8'))
  const context = await browser.newContext()
  const forbidden: string[] = []
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== labOrigin && url.origin !== 'https://challenges.cloudflare.com') {
      forbidden.push(`${url.origin}${url.pathname}`)
      await route.abort('blockedbyclient')
      return
    }
    if (url.origin === labOrigin && url.pathname === '/sw.js') {
      await route.fulfill({ status: 200, headers: { 'Content-Type': 'application/javascript', 'Service-Worker-Allowed': '/', 'Cache-Control': 'no-store' }, body: source })
      return
    }
    await route.continue()
  })
  try {
    const page = await context.newPage()
    await page.goto(`${labOrigin}/login?offline_fresh_login=1`, { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
    const cacheNames = await page.evaluate(() => caches.keys())
    expect(cacheNames).toContain('clarin-offline-v3-meta-v1')
    expect(cacheNames).not.toContain('clarin-offline-v4-meta-v1')
    await expect.poll(() => page.locator('input[name="cf-turnstile-response"]').inputValue().catch(() => ''), { timeout: 30_000 }).not.toBe('')
    try {
      await page.getByPlaceholder('usuario o correo').fill(credentials.users[0].username)
      await page.getByPlaceholder('tu contraseña').fill(credentials.users[0].password)
    } catch { throw new Error('Synthetic login inputs unavailable') }
    const response = page.waitForResponse(reply => new URL(reply.url()).pathname === '/api/auth/login' && reply.request().method() === 'POST')
    await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click()
    const authenticated = await response
    expect(authenticated.status()).toBe(200)
    expect(authenticated.headers()['x-clarin-response']).toBe('1')
    await expect(page).toHaveURL(/\/dashboard(?:\?|$)/, { timeout: 30_000 })
    expect(await page.evaluate(async () => (await indexedDB.databases()).some(database => database.name === 'clarin-offline-v4'))).toBe(false)
    console.log('QA legacy migration: real login PASS with active unchanged v3 worker; no v4 profile created; baseline SHA', baseline)
  } finally {
    await context.close()
    if (forbidden.length) throw new Error('Legacy QA egress attempted outside allowed origins and was blocked')
  }
})
