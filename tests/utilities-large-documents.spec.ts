import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { expect, test } from '@playwright/test'
import { createUtilitiesLibraryMock } from './helpers/utilitiesLibraryMock'
import { editorAction } from './helpers/jsonToolbar'

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3011'
test.use({ channel: process.env.PLAYWRIGHT_CHANNEL })
test.setTimeout(180_000)

test('XML 30 MiB searches the entire source, edits a distant chunk, and preserves undo and download', async ({ page }, testInfo) => {
  const diagnostics: string[] = []
  page.on('pageerror', error => diagnostics.push(`pageerror: ${error.message}`))
  page.on('console', message => { if (message.type() === 'error') diagnostics.push(`console: ${message.text()}`) })
  page.on('requestfailed', request => diagnostics.push(`requestfailed: ${new URL(request.url()).pathname} ${request.failure()?.errorText ?? ''}`))
  page.on('response', response => { const path = new URL(response.url()).pathname; if (path.startsWith('/api/')) diagnostics.push(`response: ${response.status()} ${path}`) })
  const library = createUtilitiesLibraryMock()
  await page.context().addCookies([{ name: 'auth-token', value: 'test-session', url: baseURL }])
  await page.addInitScript(() => { localStorage.setItem('token', 'cookie-session'); localStorage.setItem('clarin:auth_refreshed_at', String(Date.now())) })
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/utilities/access') { await route.fulfill({ status: 204 }); return }
    if (await library.handle(route)) return
    await route.fulfill({ json: { success: true, user: { id: 'qa-user', account_id: 'qa-account', username: 'qa', display_name: 'QA', account_name: 'QA', permissions: ['utilities'] }, session: { scope: 'qa-session', account_id: 'qa-account', idle_timeout_minutes: 180, server_now: new Date().toISOString(), idle_expires_at: new Date(Date.now() + 180 * 60_000).toISOString(), absolute_expires_at: new Date(Date.now() + 86_400_000).toISOString() } } })
  })
  const file = testInfo.outputPath('large.xml')
  const prefix = '<?xml version="1.0" encoding="UTF-8"?><root><value>'
  const suffix = '</value></root>'
  const marker = 'target-outside-visible-chunk'
  const size = 30 * 1024 * 1024
  const source = prefix + 'x'.repeat(20 * 1024 * 1024 - prefix.length) + marker + 'x'.repeat(10 * 1024 * 1024 - marker.length - suffix.length) + suffix
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, source)
  try {
    const authenticated = page.waitForResponse(response => new URL(response.url()).pathname === '/api/me' && response.status() === 200)
    await page.goto(`${baseURL}/dashboard/utilities/json`)
    expect(await (await authenticated).json()).toMatchObject({ success: true, user: { account_id: 'qa-account' } })
    await page.waitForFunction(() => {
      try { return JSON.parse(localStorage.getItem('clarin:online_session_sync') ?? 'null')?.session?.scope === 'qa-session' } catch { return false }
    })
    const editor = page.getByTestId('document-editor-a')
    await expect(editor).toBeVisible({ timeout: 30_000 })
    const open = await editorAction(page, 'Abrir archivo')
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), open.click()])
    const openStarted = performance.now()
    await chooser.setFiles(file)
    await expect(page.getByRole('status').filter({ hasText: 'Archivo local abierto.' })).toBeVisible({ timeout: 60_000 })
    const openMs = Math.round(performance.now() - openStarted)
    await expect(editor.getByRole('textbox')).toBeEditable()
    await page.getByRole('button', { name: 'Buscar en todo el documento', exact: true }).click()
    const searchStarted = performance.now()
    await page.getByRole('textbox', { name: 'Texto para buscar en todo el documento' }).fill(marker)
    await expect(page.getByRole('status').filter({ hasText: '1 coincidencias' })).toBeVisible({ timeout: 20_000 })
    const searchMs = Math.round(performance.now() - searchStarted)
    await page.getByRole('button').filter({ hasText: marker }).click()
    await expect(editor.locator('.view-lines')).toContainText(marker)
    await page.keyboard.insertText('edited-distant-xml-value')
    await expect(editor.locator('.view-lines')).toContainText('edited-distant-xml-value')
    await page.keyboard.insertText('-continued')
    await expect(editor.locator('.view-lines')).toContainText('edited-distant-xml-value-continued')
    const downloadButton = await editorAction(page, 'Descargar documento')
    const [download] = await Promise.all([page.waitForEvent('download'), downloadButton.click()])
    const content = await readFile((await download.path())!, 'utf8')
    expect(content).toContain('edited-distant-xml-value-continued')
    expect(content).not.toContain(marker)
    await editor.getByRole('textbox').focus()
    await page.keyboard.press('ControlOrMeta+z')
    await expect(editor.locator('.view-lines')).toContainText(marker)
    expect(source.length).toBe(size)
    const timingPath = testInfo.outputPath('xml-30mib-timing.json')
    await writeFile(timingPath, JSON.stringify({ bytes: size, openMs, searchMs }))
    await testInfo.attach('xml-30mib-timing.json', { path: timingPath, contentType: 'application/json' })
  } finally {
    diagnostics.push(`final-page: ${new URL(page.url()).pathname}`)
    const path = testInfo.outputPath('browser-diagnostics.json')
    await writeFile(path, JSON.stringify(diagnostics))
    await testInfo.attach('browser-diagnostics.json', { path, contentType: 'application/json' })
    await rm(file, { force: true })
  }
})
