import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { createUtilitiesLibraryMock } from './helpers/utilitiesLibraryMock'
import { clickEditorAction, editorAction } from './helpers/jsonToolbar'

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3011'
test.use({ channel: process.env.PLAYWRIGHT_CHANNEL })
test.setTimeout(180_000)

async function setup(page: Page) {
  const library = createUtilitiesLibraryMock()
  await page.context().addCookies([{ name: 'auth-token', value: 'folding-synthetic-session', url: baseURL }])
  await page.addInitScript(() => {
    localStorage.setItem('token', 'cookie-session')
    localStorage.setItem('clarin:auth_refreshed_at', String(Date.now()))
  })
  await page.route('**/api/**', async route => {
    if (new URL(route.request().url()).pathname === '/api/utilities/access') return route.fulfill({ status: 204 })
    if (await library.handle(route)) return
    return route.fulfill({ json: { success: true,
      user: { id: 'folding-user', username: 'qa', display_name: 'Usuario QA', account_id: 'folding-account', account_name: 'Cuenta QA', permissions: ['utilities'] },
      session: { scope: 'folding-scope', account_id: 'folding-account', idle_timeout_minutes: 180, server_now: new Date().toISOString(), idle_expires_at: new Date(Date.now() + 10_800_000).toISOString(), absolute_expires_at: new Date(Date.now() + 86_400_000).toISOString() },
    } })
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${baseURL}/dashboard/utilities/json`)
  await expect(page.getByTestId('document-editor-a')).toBeVisible({ timeout: 30_000 })
}

function fixture(size: number, prefix: string, row: string, suffix: string) {
  const bytes = Buffer.alloc(size, ' ')
  const start = bytes.write(prefix)
  const length = Buffer.byteLength(row)
  const rows = Math.floor((size - start - Buffer.byteLength(suffix)) / length)
  bytes.fill(row, start, start + rows * length)
  bytes.write(suffix, size - Buffer.byteLength(suffix))
  return bytes
}

async function openFile(page: Page, file: string) {
  const action = await editorAction(page, 'Abrir archivo')
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), action.click()])
  await chooser.setFiles(file)
}

async function waitForFolding(page: Page) {
  const mode = page.getByRole('button', { name: 'Modo ligero · Panel A', exact: true })
  await mode.click()
  const status = page.getByRole('status', { name: 'Plegado del panel A' })
  await expect(status).toContainText(/[1-9][\d.,]* bloques plegables/, { timeout: 20_000 })
  await page.keyboard.press('Escape')
}

async function foldAt(page: Page, editor: Locator, line: number) {
  await editor.getByRole('textbox').focus()
  await page.keyboard.press('ControlOrMeta+Home')
  for (let current = 1; current < line; current++) await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ControlOrMeta+Shift+BracketLeft')
  await expect(editor.locator('.inline-folded').first()).toBeVisible({ timeout: 10_000 })
}

async function verifyDownload(page: Page, bytes: Buffer) {
  const action = await editorAction(page, 'Descargar documento')
  const [download] = await Promise.all([page.waitForEvent('download'), action.click()])
  const result = await readFile((await download.path())!)
  expect(createHash('sha256').update(result).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'))
}

test('XML 20 MiB folds real sections, finds hidden matches and preserves the complete source', async ({ page }, testInfo) => {
  await setup(page)
  const source = fixture(20 * 1024 * 1024,
    '<?xml version="1.0" encoding="UTF-8"?>\n<root>\n<Categories>\n<Category id="first">\n<Value>inside-fold-marker</Value>\n</Category>\n',
    `<Category id="12">\n<Value>${'x'.repeat(160)}</Value>\n</Category>\n`,
    '</Categories>\n<Other>outside-fold-marker</Other>\n</root>\n')
  const file = testInfo.outputPath('folding-20mib.xml')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, source)
  try {
    await openFile(page, file)
    const editor = page.getByTestId('document-editor-a')
    await expect(editor.locator('.view-lines')).toContainText('inside-fold-marker', { timeout: 60_000 })
    // A new revision while indexing must remain editable and invalidate stale ranges.
    await editor.getByRole('textbox').focus()
    await page.keyboard.press('ControlOrMeta+Home')
    await page.keyboard.press('End')
    await page.keyboard.insertText(' ')
    await clickEditorAction(page, 'Deshacer')
    await waitForFolding(page)
    await foldAt(page, editor, 3)
    await expect(editor.locator('.view-lines')).not.toContainText('inside-fold-marker')
    await verifyDownload(page, source)
    await page.screenshot({ path: testInfo.outputPath('xml-20mib-folded.png') })

    await clickEditorAction(page, 'Buscar en todo el documento')
    await page.getByRole('textbox', { name: 'Texto para buscar en todo el documento' }).fill('inside-fold-marker')
    const matches = page.getByLabel('Coincidencias del documento')
    await expect(matches.getByRole('button').first()).toBeVisible({ timeout: 20_000 })
    await matches.getByRole('button').first().click()
    await expect(editor.locator('.view-lines')).toContainText('inside-fold-marker')
    await page.getByRole('button', { name: 'Cerrar búsqueda', exact: true }).click()
    await expect(editor.getByRole('textbox')).toBeFocused()
    await verifyDownload(page, source)
  } finally { await rm(file, { force: true }) }
})

test('JSON 30 MiB folds without indentation and preserves folds while switching panels and widths', async ({ page }, testInfo) => {
  await setup(page)
  const source = fixture(30 * 1024 * 1024,
    '{\n"groups": [\n{\n"name":"first",\n"value":"inside-json-fold-marker"\n},\n',
    `{\n"name":"${'x'.repeat(200)}",\n"active":true,\n"count":12\n},\n`,
    '{\n"name":"last"\n}\n]\n}\n')
  const file = testInfo.outputPath('folding-30mib.json')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, source)
  try {
    await openFile(page, file)
    const editor = page.getByTestId('document-editor-a')
    await expect(editor.locator('.view-lines')).toContainText('inside-json-fold-marker', { timeout: 60_000 })
    await waitForFolding(page)
    await foldAt(page, editor, 2)
    await expect(editor.locator('.view-lines')).not.toContainText('inside-json-fold-marker')
    await page.screenshot({ path: testInfo.outputPath('json-30mib-folded.png') })
    await verifyDownload(page, source)
    await clickEditorAction(page, 'Mostrar segundo panel')
    await page.setViewportSize({ width: 375, height: 812 })
    await page.getByRole('button', { name: 'Ver documento B', exact: true }).click()
    const b = page.getByTestId('document-editor-b')
    await b.getByRole('textbox').focus()
    await page.keyboard.insertText('{"small-panel":true}')
    await page.getByRole('button', { name: 'Ver documento A', exact: true }).click()
    await expect(editor.locator('.inline-folded').first()).toBeVisible({ timeout: 20_000 })
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect(editor.locator('.inline-folded').first()).toBeVisible()
    await editor.getByRole('textbox').focus()
    await page.keyboard.press('ControlOrMeta+Home')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ControlOrMeta+Shift+BracketRight')
    await expect(editor.locator('.view-lines')).toContainText('inside-json-fold-marker')
    await expect(b.locator('.view-lines')).toContainText('small-panel')
    await verifyDownload(page, source)
    await expect.poll(() => page.locator('main').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  } finally { await rm(file, { force: true }) }
})
