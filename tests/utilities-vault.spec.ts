import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { createUtilitiesLibraryMock } from './helpers/utilitiesLibraryMock'

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3011'
test.use({ channel: process.env.PLAYWRIGHT_CHANNEL })
test.setTimeout(120_000)

async function setup(page: Page) {
  const library = createUtilitiesLibraryMock()
  const vault = new Map<string, Record<string, any>>()
  const material = new Map<string, string>()
  await page.context().addCookies([{ name: 'auth-token', value: 'vault-browser-session', url: baseURL }])
  await page.addInitScript(() => { localStorage.setItem('token', 'cookie-session'); localStorage.setItem('clarin:auth_refreshed_at', String(Date.now())) })
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method()
    const reply = (data: unknown, status = 200) => route.fulfill({ status, json: { success: status < 400, data }, headers: { 'cache-control': 'no-store' } })
    if (path === '/api/utilities/vault/status') return reply({ configured: true })
    if (path === '/api/utilities/vault') {
      if (method === 'POST') {
        const input = request.postDataJSON(), id = randomUUID()
        const { material: secret, operation_id: _operation, ...publicValues } = input
        const item = { ...publicValues, id, version: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
        vault.set(id, item); material.set(id, secret)
        return reply({ item })
      }
      const q = (url.searchParams.get('q') || '').toLowerCase()
      return reply({ items: [...vault.values()].filter(item => item.name.toLowerCase().includes(q)), has_more: false })
    }
    const entry = /^\/api\/utilities\/vault\/([^/]+)(\/material)?$/.exec(path)
    if (entry) {
      const item = vault.get(entry[1])
      if (!item) return reply({}, 404)
      if (method === 'DELETE') { vault.delete(entry[1]); material.delete(entry[1]); return reply({ deleted: true, cleanup_pending: true }) }
      if (entry[2]) {
        if (method === 'GET') return reply({ material: material.get(entry[1]), public_data: item.public_data, metadata: item.metadata })
        const input = request.postDataJSON()
        if (input.version !== item.version) return reply({}, 409)
        material.set(entry[1], input.material); item.version++; if (input.metadata) item.metadata = input.metadata
        return reply({ item })
      }
      if (method === 'PATCH') { const input = request.postDataJSON(); Object.assign(item, { name: input.name, description: input.description, version: item.version + 1 }) }
      return reply({ item })
    }
    if (await library.handle(route)) return
    if (path === '/api/utilities/access') return route.fulfill({ status: 204 })
    return route.fulfill({ json: { success: true, user: { id: 'vault-user', account_id: 'vault-account', username: 'qa', display_name: 'Claves QA', account_name: 'Cuenta QA', permissions: ['utilities'] }, session: { scope: 'vault-scope', account_id: 'vault-account', idle_timeout_minutes: 180, server_now: new Date().toISOString(), idle_expires_at: new Date(Date.now() + 10_800_000).toISOString(), absolute_expires_at: new Date(Date.now() + 86_400_000).toISOString() } } })
  })
  await page.setViewportSize({ width: 1440, height: 1000 })
  return { library, vault, material }
}

test('generates and saves EC identity, CSR and certificate, verifies JWT and exports protected P12', async ({ page }, testInfo) => {
  const state = await setup(page)
  await page.goto(`${baseURL}/dashboard/utilities/criptografia`)
  await page.getByRole('button', { name: 'Mis claves', exact: true }).click()
  await page.getByRole('textbox', { name: 'Nombre', exact: true }).fill('Firma QA')
  await page.getByRole('combobox', { name: 'Tipo de clave' }).selectOption('ec')
  const generate = page.getByRole('button', { name: 'Generar y guardar' })
  await expect(generate).toBeEnabled()
  expect(await generate.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgb(255, 255, 255)')
  await page.getByRole('button', { name: 'Generar y guardar' }).click()
  await expect(page.getByRole('region', { name: 'Entrada seleccionada' })).toBeVisible()
  expect(state.vault.size).toBe(1)
  const entryId = [...state.vault.keys()][0]
  expect(state.vault.get(entryId)).not.toHaveProperty('material')
  expect(state.material.get(entryId)).toContain('PRIVATE KEY')
  await page.getByRole('textbox', { name: 'Nombre común (CN)' }).fill('test.example.invalid')
  await page.getByRole('textbox', { name: 'Nombres DNS (SAN)' }).fill('test.example.invalid')
  await page.getByRole('button', { name: 'Crear y guardar CSR' }).click()
  await expect.poll(() => JSON.parse(state.material.get(entryId)!).requests?.length).toBe(1)
  await page.getByRole('button', { name: 'Certificado de prueba', exact: true }).click()
  await expect.poll(() => JSON.parse(state.material.get(entryId)!).certificates.length).toBe(1)
  await page.getByRole('textbox', { name: 'Contenido JWT / token' }).fill('{"sub":"qa","exp":4102444800}')
  await page.getByRole('button', { name: 'Firmar JWT', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Resultado', exact: true })).toHaveValue(/^[\w-]+\.[\w-]+\.[\w-]+$/, { timeout: 60_000 })
  const token = await page.getByRole('textbox', { name: 'Resultado', exact: true }).inputValue()
  await page.getByRole('textbox', { name: 'Contenido JWT / token' }).fill(token)
  await page.getByRole('button', { name: 'Verificar firma JWT' }).click()
  await expect(page.getByRole('textbox', { name: 'Resultado', exact: true })).toHaveValue(/"firma": "verificada"/, { timeout: 60_000 })
  await page.getByLabel('Contraseña de importación / exportación').fill('synthetic-export-password')
  await page.getByRole('combobox', { name: 'Formato de exportación' }).selectOption('p12')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Exportar', exact: true }).click()
  expect((await download).suggestedFilename()).toBe('certificado.p12')
  const configurations = [...state.library.documents.values()].map(document => document.config)
  expect(JSON.stringify(configurations)).not.toContain('PRIVATE KEY')
  expect(JSON.stringify(configurations)).not.toContain('synthetic-export-password')
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('PRIVATE KEY')
  await page.setViewportSize({ width: 375, height: 812 })
  await expect.poll(() => page.locator('main').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  await page.setViewportSize({ width: 1440, height: 1000 })
  const screenshotPath = testInfo.outputPath('biblioteca-claves.png')
  await page.screenshot({ path: screenshotPath })
  await testInfo.attach('biblioteca-claves.png', { path: screenshotPath, contentType: 'image/png' })
  await page.getByRole('button', { name: 'Eliminar', exact: true }).click()
  await page.getByRole('dialog', { name: 'Eliminar clave o certificado' }).getByRole('button', { name: 'Eliminar definitivamente' }).click()
  await expect.poll(() => state.vault.size).toBe(0)
  expect(state.material.size).toBe(0)
})

test('uses a saved AES key without placing its material in document configuration', async ({ page }) => {
  const state = await setup(page)
  await page.goto(`${baseURL}/dashboard/utilities/criptografia`)
  await page.getByRole('button', { name: 'Mis claves', exact: true }).click()
  await page.getByRole('textbox', { name: 'Nombre', exact: true }).fill('Cifrado QA')
  await page.getByRole('combobox', { name: 'Tipo de clave' }).selectOption('aes')
  await page.getByRole('button', { name: 'Generar y guardar' }).click()
  await expect(page.getByRole('combobox', { name: 'Formato de exportación' })).toHaveValue('jwk-protected')
  await page.getByRole('button', { name: 'Usar esta clave' }).click()
  await page.getByRole('textbox', { name: 'Texto para cifrar (UTF-8)' }).fill('contenido temporal de prueba')
  await page.getByRole('button', { name: 'Cifrar', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'JWE cifrado' })).toHaveValue(/^[\w-]+\.\.[\w-]+\.[\w-]+\.[\w-]+$/)
  await expect.poll(() => [...state.library.documents.values()].some(document => typeof document.config.key_id === 'string')).toBe(true)
  expect(JSON.stringify([...state.library.documents.values()])).not.toContain('contenido temporal de prueba')
})
