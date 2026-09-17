import { test, expect, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

test.use({ trace: 'off', video: 'off', actionTimeout: 30_000, navigationTimeout: 30_000 })

test('new authorization request stays pending after an earlier approval and panel refresh', async ({ browser }) => {
  test.setTimeout(180_000)
  const { labOrigin, labRoot, verifyLabIdentity } = await import('../scripts/offline/browser-qa-environment.mjs')
  const marker = await verifyLabIdentity()
  const credentials = JSON.parse(await readFile(join(labRoot, 'credentials.json'), 'utf8'))
  const fixtures = JSON.parse(await readFile(join(labRoot, 'fixtures.json'), 'utf8'))
  if (fixtures.run_id !== marker.run_id || fixtures.state !== 'complete') throw new Error('Exact isolated fixtures required')
  const userContext = await browser.newContext(), adminContext = await browser.newContext()
  const forbidden: string[] = []
  for (const context of [userContext, adminContext]) await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== labOrigin && url.origin !== 'https://challenges.cloudflare.com') {
      forbidden.push(url.origin); await route.abort('blockedbyclient')
    } else await route.continue()
  })
  async function login(page: Page, credential: { username: string; password: string }) {
    await page.goto(`${labOrigin}/login?offline_fresh_login=1`, { waitUntil: 'domcontentloaded' })
    await expect.poll(() => page.locator('input[name="cf-turnstile-response"]').inputValue().catch(() => ''), { timeout: 30_000 }).not.toBe('')
    try {
      await page.getByPlaceholder('usuario o correo').fill(credential.username)
      await page.getByPlaceholder('tu contraseña').fill(credential.password)
    } catch { throw new Error('QA login inputs unavailable') }
    await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click()
    await expect(page).toHaveURL(/\/dashboard(?:\?|$)/, { timeout: 30_000 })
  }
  try {
    const user = await userContext.newPage(), admin = await adminContext.newPage()
    await login(admin, credentials.admin); await login(user, credentials.users[0])
    await user.goto(`${labOrigin}/dashboard/settings`, { waitUntil: 'domcontentloaded' })
    await user.getByRole('button', { name: 'Offline', exact: true }).click()
    const panel = user.getByRole('region', { name: 'Acceso offline en este navegador' })
    await panel.getByRole('button', { name: 'Solicitar acceso offline', exact: true }).click()
    await expect(panel.getByText('Pendiente de aprobación', { exact: true })).toBeVisible()
    const profileID = await user.evaluate(() => new Promise<string>((resolve, reject) => {
      const request = indexedDB.open('clarin-offline-v4', 1)
      request.onsuccess = () => {
        const db = request.result, read = db.transaction('profiles', 'readonly').objectStore('profiles').get('active')
        read.onsuccess = () => { const id = read.result.browser_id; db.close(); resolve(id) }
        read.onerror = () => { db.close(); reject(new Error('Cannot read public browser ID')) }
      }
      request.onerror = () => reject(new Error('Cannot read public browser ID'))
    }))
    const requests = await admin.request.get(`${labOrigin}/api/admin/offline-v4/enrollment-requests`)
    expect(requests.ok()).toBe(true)
    const first = (await requests.json()).items.find((item: { browser_profile_id: string; user_id: string; state: string }) => item.browser_profile_id === profileID && item.user_id === fixtures.steps.user_0.value.id && item.state === 'requested')
    expect(Boolean(first?.id)).toBe(true)
    const approvalURL = `${labOrigin}/api/admin/offline-v4/enrollment-requests/${first.id}/approve`
    const approvalBody = { accounts: [{ account_id: fixtures.steps.account_0.value.id, actions: ['contacts.read'], max_resources: 20, quota_bytes: 5 * 1024 ** 3 }] }
    // APIRequestContext does not supply the browser's Origin automatically.
    // Preserve the server's CSRF/origin gate and prove the unscoped call fails.
    const denied = await admin.request.post(approvalURL, { data: approvalBody })
    expect(denied.status()).toBe(403)
    expect((await denied.json()).error).toBe('offline_origin_denied')
    const approval = await admin.request.post(approvalURL, { headers: { Origin: labOrigin }, data: approvalBody })
    expect(approval.ok()).toBe(true)
    await expect(panel.getByRole('group', { name: 'Cuentas autorizadas' })).toBeVisible({ timeout: 30_000 })
    await panel.getByRole('button', { name: 'Solicitar otra autorización', exact: true }).click()
    await expect(panel.getByRole('button', { name: 'Actualizar', exact: true })).toBeEnabled()
    await panel.getByRole('button', { name: 'Actualizar', exact: true }).click()
    await expect(panel.getByRole('button', { name: 'Actualizar', exact: true })).toBeEnabled()
    await expect(panel.getByText('Pendiente de aprobación', { exact: true })).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Solicitar otra autorización', exact: true })).toBeDisabled()
    const updated = await admin.request.get(`${labOrigin}/api/admin/offline-v4/enrollment-requests`)
    expect(updated.ok()).toBe(true)
    const pending = (await updated.json()).items.filter((item: { id: string; browser_profile_id: string; state: string }) => item.browser_profile_id === profileID && item.id !== first.id && item.state === 'requested')
    expect(pending).toHaveLength(1)
    console.log('QA request refresh: newest pending request remains canonical after prior approval')
  } finally {
    await userContext.close(); await adminContext.close()
    if (forbidden.length) throw new Error('Non-laboratory requests were blocked; no QA credentials were forwarded')
  }
})
