import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import { createUtilitiesLibraryMock } from './helpers/utilitiesLibraryMock'
import { clickEditorAction, editorAction } from './helpers/jsonToolbar'

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3011'
test.use({ channel: process.env.PLAYWRIGHT_CHANNEL })
test.setTimeout(180_000)

async function setup(page: Page) {
  const library = createUtilitiesLibraryMock()
  await page.context().addCookies([{ name: 'auth-token', value: 'syntax-synthetic-session', url: baseURL }])
  await page.addInitScript(() => {
    localStorage.setItem('token', 'cookie-session')
    localStorage.setItem('clarin:auth_refreshed_at', String(Date.now()))
    const methods: string[] = []
    const astMethods = new Set(['doValidation', 'doHover', 'doComplete', 'findDocumentSymbols', 'getFoldingRanges'])
    Object.defineProperty(window, '__syntaxWorkerMethods', { value: methods })
    Worker.prototype.postMessage = new Proxy(Worker.prototype.postMessage, {
      apply(target, owner, args) {
        const method = args[0]?.method
        if (typeof method === 'string' && astMethods.has(method)) methods.push(method)
        return Reflect.apply(target, owner, args)
      },
    })
  })
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/utilities/access') return route.fulfill({ status: 204 })
    if (await library.handle(route)) return
    return route.fulfill({ json: { success: true,
      user: { id: 'syntax-user', username: 'qa', display_name: 'Usuario QA', account_id: 'syntax-account', account_name: 'Cuenta QA', permissions: ['utilities'] },
      session: { scope: 'syntax-scope', account_id: 'syntax-account', idle_timeout_minutes: 180, server_now: new Date().toISOString(), idle_expires_at: new Date(Date.now() + 10_800_000).toISOString(), absolute_expires_at: new Date(Date.now() + 86_400_000).toISOString() },
    } })
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${baseURL}/dashboard/utilities/json`)
  await expect(page.getByTestId('document-editor-a')).toBeVisible({ timeout: 30_000 })
}

function fixture(size: number, prefix: string, row: string, suffix: string) {
  const source = Buffer.alloc(size, ' ')
  const prefixBytes = source.write(prefix)
  const rowBytes = Buffer.byteLength(row)
  const count = Math.floor((size - prefixBytes - Buffer.byteLength(suffix)) / rowBytes)
  source.fill(row, prefixBytes, prefixBytes + count * rowBytes)
  source.write(suffix, size - Buffer.byteLength(suffix))
  return source
}

async function openFile(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }) {
  const action = await editorAction(page, 'Abrir archivo')
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), action.click()])
  await chooser.setFiles(file)
}

async function colors(editor: Locator) {
  return editor.locator('.view-lines').evaluate(element => [...new Set(
    Array.from(element.querySelectorAll<HTMLElement>('.view-line span'))
      .filter(span => span.textContent?.trim())
      .map(span => getComputedStyle(span).color),
  )])
}

async function expectColors(editor: Locator) {
  await expect.poll(async () => (await colors(editor)).length, { timeout: 20_000 }).toBeGreaterThanOrEqual(3)
  return colors(editor)
}

async function assertNoAutomaticJsonAst(page: Page) {
  // Observe beyond Monaco's queued 500 ms diagnostic callback. Only method
  // names are recorded; worker arguments and document contents stay private.
  await page.waitForTimeout(700)
  expect(await page.evaluate(() => (window as Window & { __syntaxWorkerMethods?: string[] }).__syntaxWorkerMethods ?? [])).toEqual([])
}

async function downloadHash(page: Page) {
  const action = await editorAction(page, 'Descargar documento')
  const [download] = await Promise.all([page.waitForEvent('download'), action.click()])
  return createHash('sha256').update(await readFile((await download.path())!)).digest('hex')
}

async function saveMetrics(testInfo: TestInfo, name: string, metrics: Record<string, unknown>) {
  const path = testInfo.outputPath(`${name}.json`)
  await writeFile(path, JSON.stringify(metrics, null, 2))
  await testInfo.attach(`${name}.json`, { path, contentType: 'application/json' })
}

test('XML 20 MiB keeps visible syntax colors and explains light mode in its tab', async ({ page }, testInfo) => {
  await setup(page)
  const size = 20 * 1024 * 1024
  const source = fixture(size, '<?xml version="1.0" encoding="UTF-8"?>\n<Catalog>\n', `<Item ID="123" Name="${'x'.repeat(150)}" Enabled="true" Count="42"/>\n`, '</Catalog>\n')
  const file = testInfo.outputPath('syntax-20mib.xml')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, source)
  try {
    const started = performance.now()
    await openFile(page, file)
    const editor = page.getByTestId('document-editor-a')
    await expect(editor.locator('.view-lines')).toContainText('Catalog', { timeout: 60_000 })
    const openMs = Math.round(performance.now() - started)
    await expect(page.getByRole('combobox', { name: 'Formato del documento' })).toHaveValue('xml')
    const colorStarted = performance.now()
    const visibleColors = await expectColors(editor)
    const colorMs = Math.round(performance.now() - colorStarted)
    const mode = page.getByRole('button', { name: 'Modo ligero · Panel A', exact: true })
    await expect(mode).toBeVisible()
    await expect(mode.locator('svg')).toBeVisible()
    await expect(mode).toHaveAttribute('title', /mantener el editor ágil/)
    await mode.focus(); await mode.press('Enter')
    const explanation = page.getByRole('dialog', { name: 'Modo ligero de este documento' })
    await expect(explanation).toContainText('JSON/XML mantiene colores básicos')
    await page.keyboard.press('Escape')
    await expect(mode).toBeFocused()
    await assertNoAutomaticJsonAst(page)
    await page.screenshot({ path: testInfo.outputPath('xml-20mib-colors.png') })
    await saveMetrics(testInfo, 'xml-20mib-colors', { bytes: size, openMs, colorMs, visibleColors })
    expect(await downloadHash(page)).toBe(createHash('sha256').update(source).digest('hex'))
  } finally { await rm(file, { force: true }) }
})

test('JSON 30 MiB colors without semantic work and keeps small panels and undo independent', async ({ page }, testInfo) => {
  await setup(page)
  const size = 30 * 1024 * 1024
  const source = fixture(size, '[\n{"name":"start-json-marker","count":123,"active":true,"empty":null},\n', `{"name":"${'x'.repeat(230)}","count":123.5,"active":false,"other":null},\n`, '{"name":"end-json-marker","count":456,"active":false}\n]\n')
  const sourceHash = createHash('sha256').update(source).digest('hex')
  const file = testInfo.outputPath('syntax-30mib.json')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, source)
  try {
    const started = performance.now()
    await openFile(page, file)
    const editorA = page.getByTestId('document-editor-a')
    await expect(editorA.locator('.view-lines')).toContainText('start-json-marker', { timeout: 60_000 })
    const openMs = Math.round(performance.now() - started)
    const colorStarted = performance.now()
    const visibleColors = await expectColors(editorA)
    const colorMs = Math.round(performance.now() - colorStarted)
    await expect(page.getByRole('button', { name: 'Modo ligero · Panel A', exact: true })).toBeVisible()
    await assertNoAutomaticJsonAst(page)
    await page.screenshot({ path: testInfo.outputPath('json-30mib-colors.png') })

    const editStarted = performance.now()
    await editorA.getByRole('textbox').focus()
    await page.keyboard.press('ControlOrMeta+Home')
    await page.keyboard.press('End')
    await page.keyboard.insertText(' ')
    const editedHash = createHash('sha256').update(source.subarray(0, 1)).update(' ').update(source.subarray(1)).digest('hex')
    expect(await downloadHash(page)).toBe(editedHash)
    const editDownloadMs = Math.round(performance.now() - editStarted)
    const undoStarted = performance.now()
    await clickEditorAction(page, 'Deshacer')
    expect(await downloadHash(page)).toBe(sourceHash)
    const undoDownloadMs = Math.round(performance.now() - undoStarted)

    await clickEditorAction(page, 'Mostrar segundo panel')
    const editorB = page.getByTestId('document-editor-b')
    await expect(editorB).toBeVisible()
    await editorB.getByRole('textbox').focus()
    await page.keyboard.insertText('{"small-panel-marker":"value","count":42,"active":true}')
    await expect(editorB.locator('.view-lines')).toContainText('small-panel-marker')
    await expectColors(editorB)
    await expect(page.getByRole('button', { name: 'Modo ligero · Panel A', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /Modo ligero · Panel B/ })).toHaveCount(0)
    await editorA.getByRole('textbox').focus()
    await openFile(page, { name: 'small-normal.json', mimeType: 'application/json', buffer: Buffer.from('{"small-replacement-marker":"value","count":42,"active":true}') })
    await expect(editorA.locator('.view-lines')).toContainText('small-replacement-marker')
    await expect(page.getByRole('button', { name: /^Modo ligero/ })).toHaveCount(0)
    await expectColors(editorA)
    await clickEditorAction(page, 'Deshacer')
    await expect(editorA.locator('.view-lines')).toContainText('start-json-marker', { timeout: 30_000 })
    await expect(page.getByRole('button', { name: 'Modo ligero · Panel A', exact: true })).toBeVisible()
    await expectColors(editorA)
    await expect(editorB.locator('.view-lines')).toContainText('small-panel-marker')
    await clickEditorAction(page, 'Rehacer')
    await expect(editorA.locator('.view-lines')).toContainText('small-replacement-marker')
    await expect(page.getByRole('button', { name: /^Modo ligero/ })).toHaveCount(0)
    await saveMetrics(testInfo, 'json-30mib-colors', { bytes: size, openMs, colorMs, editDownloadMs, undoDownloadMs, visibleColors })
  } finally { await rm(file, { force: true }) }
})
