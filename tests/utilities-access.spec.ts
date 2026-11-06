import { expect, test, type Page } from '@playwright/test'

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3011'
test.use({ channel: process.env.PLAYWRIGHT_CHANNEL })
test.setTimeout(120_000)

async function mockAccount(page: Page, options: { permission: boolean; idleMs?: number; apiAllowed?: boolean }) {
  await page.context().addCookies([{ name: 'auth-token', value: 'browser-test-session', url: baseURL }])
  await page.addInitScript(() => {
    localStorage.setItem('token', 'cookie-session')
    localStorage.setItem('clarin:auth_refreshed_at', String(Date.now()))
  })
  let idleAt = Date.now() + (options.idleMs ?? 300_000)
  const interactions: unknown[] = []
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/utilities/access') {
      if (options.apiAllowed ?? options.permission) await route.fulfill({ status: 204 })
      else await route.fulfill({ status: 403, json: { success: false } })
      return
    }
    if (path === '/api/auth/activity' && route.request().postData()) {
      const activity = route.request().postDataJSON()
      interactions.push(activity)
      if (activity?.interaction) idleAt = Date.now() + 300_000
    }
    await route.fulfill({ json: {
      success: true,
      user: { id: 'user-a', username: 'qa', display_name: 'Usuario QA', account_id: 'account-a', account_name: 'Cuenta QA', permissions: options.permission ? ['utilities'] : [] },
      session: { scope: 'browser-qa-scope', account_id: 'account-a', idle_timeout_minutes: 5, server_now: new Date().toISOString(), idle_expires_at: new Date(idleAt).toISOString(), absolute_expires_at: new Date(Date.now() + 86_400_000).toISOString() },
    } })
  })
  return interactions
}

test('catalog and JSON workspace adapt to measured width and keep inputs local', async ({ page }) => {
  await mockAccount(page, { permission: true })
  const marker = 'clarin-tool-data-only-7029'
  const outgoing: string[] = []
  const editorErrors: string[] = []
  page.on('request', request => outgoing.push(`${request.url()} ${request.postData() || ''}`))
  page.on('pageerror', error => {
    if (/monaco-editor|UNKNOWN service/i.test(error.stack || error.message)) editorErrors.push(error.message)
  })
  page.on('console', message => {
    if (/could not create web worker|falling back to loading web worker/i.test(message.text())) editorErrors.push(message.text())
  })
  await page.setViewportSize({ width: 320, height: 740 })
  await page.goto(`${baseURL}/dashboard/utilities`)
  const catalog = page.getByRole('region', { name: 'Utilitarios' })
  await expect(catalog.getByRole('link')).toHaveCount(4)
  await catalog.getByRole('link', { name: /Editor JSON/ }).click()
  const input = page.getByTestId('json-monaco-source')
  const output = page.getByTestId('json-monaco-result')
  const editable = input.getByRole('textbox')
  const inputLines = input.locator('.view-lines')
  const outputLines = output.locator('.view-lines')
  const raw = `{"id":9007199254740993,"marker":"${marker}"}`
  await editable.focus()
  await page.keyboard.insertText(raw)
  await expect(inputLines).toContainText(marker)
  await page.getByRole('button', { name: 'Formatear', exact: true }).click()
  await expect(outputLines).toContainText(new RegExp(`9007199254740993[\\s\\S]+${marker}`))
  expect((await output.boundingBox())!.y).toBeGreaterThan((await input.boundingBox())!.y)
  expect(await page.locator('main').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)

  for (const width of [375, 768, 1024, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(inputLines).toContainText(marker)
    expect(await page.locator('main').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  }
  expect((await output.boundingBox())!.x).toBeGreaterThan((await input.boundingBox())!.x)
  await page.getByRole('button', { name: 'Abrir Eros' }).click()
  await expect(inputLines).toContainText(marker)
  expect(await page.locator('main').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  const leaked = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))
  expect(leaked).not.toContain(marker)
  expect(outgoing.join('\n')).not.toContain(marker)

  await page.getByRole('button', { name: 'Usar como entrada' }).click()
  await expect(input.locator('.view-line')).toHaveCount(4)
  await page.keyboard.press('ControlOrMeta+z')
  await expect(input.locator('.view-line')).toHaveCount(1)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(input.locator('.view-line')).toHaveCount(4)

  await page.getByRole('region', { name: 'Editor JSON', exact: true }).getByRole('link', { name: 'Utilitarios' }).click()
  await expect(catalog.getByRole('link', { name: /Editor JSON/ })).toBeFocused()
  await catalog.getByRole('link', { name: /Editor JSON/ }).press('Enter')
  await expect(page.getByTestId('json-monaco-source')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('json-monaco-source').locator('.view-lines')).not.toContainText(marker)
  expect(editorErrors).toEqual([])
})

test('a direct link also enforces the current server permission', async ({ page }) => {
  await mockAccount(page, { permission: true, apiAllowed: false })
  await page.goto(`${baseURL}/dashboard/utilities/json`)
  await expect(page.getByRole('heading', { name: 'No tienes acceso a Utilitarios' })).toBeVisible()
  await expect(page.getByTestId('json-monaco-source')).toHaveCount(0)
})

test('the browser encrypts and decrypts JWE locally', async ({ page }) => {
  await mockAccount(page, { permission: true })
  const plaintext = 'Prueba local con ñ y 🔑'
  const key = Buffer.alloc(32, 7).toString('base64')
  const outgoing: string[] = []
  page.on('request', request => outgoing.push(`${request.url()} ${request.postData() || ''}`))
  await page.goto(`${baseURL}/dashboard/utilities/criptografia`)
  await page.getByRole('textbox', { name: 'Texto para cifrar (UTF-8)' }).fill(plaintext)
  await page.getByLabel('Clave AES de 256 bits (Base64)').fill(key)
  await page.getByRole('button', { name: 'Cifrar', exact: true }).click()
  const encrypted = page.getByRole('textbox', { name: 'JWE cifrado' })
  await expect(encrypted).toHaveValue(/^[\w-]+\.\.[\w-]+\.[\w-]+\.[\w-]+$/)
  const jwe = await encrypted.inputValue()
  await page.getByRole('combobox', { name: 'Operación' }).selectOption('decrypt')
  await page.getByRole('textbox', { name: 'JWE compacto' }).fill(jwe)
  await page.getByRole('button', { name: 'Descifrar', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Texto descifrado' })).toHaveValue(plaintext)
  expect(outgoing.join('\n')).not.toContain(key)
  expect(outgoing.join('\n')).not.toContain(jwe)
  expect(outgoing.join('\n')).not.toContain(plaintext)
})

test('inactivity notice renews only through a scope-bound interaction', async ({ page }) => {
  const interactions = await mockAccount(page, { permission: true, idleMs: 59_000 })
  await page.goto(`${baseURL}/dashboard/utilities`)
  await expect(page.getByText('Tu sesión está por cerrarse por inactividad.')).toBeVisible()
  expect(interactions).toEqual([])
  await page.getByRole('button', { name: 'Continuar sesión' }).click()
  await expect(page.getByText('Tu sesión está por cerrarse por inactividad.')).toHaveCount(0)
  expect(interactions).toEqual([{ interaction: true, scope: 'browser-qa-scope' }])
})
