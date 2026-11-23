import { readFile } from 'node:fs/promises'
import { expect, test, type FileChooser, type Locator, type Page } from '@playwright/test'
import { createUtilitiesLibraryMock } from './helpers/utilitiesLibraryMock'
import { editorAction } from './helpers/jsonToolbar'

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3011'
test.use({ channel: process.env.PLAYWRIGHT_CHANNEL })
test.setTimeout(120_000)

type Library = ReturnType<typeof createUtilitiesLibraryMock>

async function setup(page: Page) {
  const library = createUtilitiesLibraryMock()
  const workers: string[] = []
  const workerFailures: string[] = []
  // Only APIs are mocked: file decoding and saved-panel restoration run the published workers.
  page.on('worker', worker => workers.push(worker.url()))
  page.on('console', message => {
    if (/could not create web worker|falling back to loading web worker/i.test(message.text())) workerFailures.push(message.text())
  })
  await page.context().addCookies([{ name: 'auth-token', value: 'encoding-browser-session', url: baseURL }])
  await page.addInitScript(() => {
    localStorage.setItem('token', 'cookie-session')
    localStorage.setItem('clarin:auth_refreshed_at', String(Date.now()))
  })
  await page.route('**/api/**', async route => {
    if (await library.handle(route)) return
    if (new URL(route.request().url()).pathname === '/api/utilities/access') return route.fulfill({ status: 204 })
    return route.fulfill({ json: {
      success: true,
      user: { id: 'encoding-user', username: 'qa', display_name: 'Codificación QA', account_id: 'encoding-account', account_name: 'Cuenta QA', permissions: ['utilities'] },
      session: { scope: 'encoding-browser-scope', account_id: 'encoding-account', idle_timeout_minutes: 180, server_now: new Date().toISOString(), idle_expires_at: new Date(Date.now() + 10_800_000).toISOString(), absolute_expires_at: new Date(Date.now() + 86_400_000).toISOString() },
    } })
  })
  await page.goto(`${baseURL}/dashboard/utilities/json`)
  const editor = page.getByTestId('document-editor-a')
  await expect(editor).toBeVisible({ timeout: 30_000 })
  return { library, editor, workers, workerFailures }
}

async function openFile(page: Page, file: Parameters<FileChooser['setFiles']>[0]) {
  const open = await editorAction(page, 'Abrir archivo')
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), open.click()])
  await chooser.setFiles(file)
}

async function typeDocument(page: Page, editor: Locator, source: string) {
  await editor.getByRole('textbox').focus()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText(source)
}

async function expectSaved(page: Page) {
  await expect(page.getByRole('button', { name: 'Estado del guardado', exact: true })).toHaveAttribute('title', /^Guardado(?: · Indexando)?$/, { timeout: 15_000 })
}

function contentSnapshot(library: Library) {
  return [...library.contents].map(([slot, bytes]) => [slot, bytes.toString('hex')])
}

function cp1252(source: string) {
  const symbols: Record<string, number> = { '“': 0x93, '”': 0x94, '€': 0x80 }
  return Buffer.from([...source].map(char => symbols[char] ?? char.charCodeAt(0)))
}

async function expectImportSaved(page: Page, library: Library, source: string, original: Buffer, writesBefore: number) {
  const id = library.getWorkspace().active_id
  expect(id).toBeTruthy()
  await expect.poll(() => library.contents.get(`${id}/panel-a`)?.toString('utf8'), { timeout: 15_000 }).toBe(source)
  expect(library.contents.get(`${id}/original-a`)).toEqual(original)
  // The original must reach private storage before its editable interpretation.
  expect(library.writes.slice(writesBefore).filter(write => write.startsWith('content:'))).toEqual([
    `content:${id}/original-a`, `content:${id}/panel-a`,
  ])
  const slot = library.documents.get(id!)?.slots.find(item => item.slot === 'panel-a')
  expect(slot?.content_type).toBe('text/plain;charset=utf-8')
  await expectSaved(page)
}

async function downloadOriginal(page: Page) {
  const action = await editorAction(page, 'Descargar archivo original')
  const [download] = await Promise.all([page.waitForEvent('download'), action.click()])
  const path = await download.path()
  if (!path) throw new Error('The original file download did not create a local file')
  return { name: download.suggestedFilename(), bytes: await readFile(path) }
}

test('offers Windows-1252 explicitly and leaves the saved document untouched during preview or cancellation', async ({ page }, testInfo) => {
  const { library, editor, workers, workerFailures } = await setup(page)
  const previous = '{"estado":"borrador anterior, intacto"}'
  await typeDocument(page, editor, previous)
  await expect.poll(() => [...library.contents.values()].some(bytes => bytes.toString('utf8') === previous)).toBe(true)
  await expectSaved(page)
  const before = contentSnapshot(library)
  const writesBefore = library.writes.length
  const workersBefore = workers.length
  const source = '<?xml version="1.0" encoding="UTF-8"?><r name="Peña">“café” €</r>'
  const bytes = cp1252(source)
  const file = { name: 'codificacion-incompatible.xml', mimeType: 'application/xml', buffer: bytes }

  await openFile(page, file)
  const choice = page.getByRole('group', { name: 'Elegir codificación del archivo' })
  await expect(choice).toBeVisible()
  await expect(choice.getByRole('combobox', { name: 'Codificación del archivo' })).toHaveValue('windows-1252')
  await expect(editor.locator('.view-lines')).toContainText('borrador anterior, intacto')
  expect(contentSnapshot(library)).toEqual(before)
  await choice.getByRole('combobox', { name: 'Codificación del archivo' }).selectOption('windows-1252')
  await choice.getByRole('button', { name: 'Abrir con esta codificación' }).click()
  const review = page.getByRole('dialog', { name: 'Revisar codificación' })
  await expect(review.getByRole('textbox', { name: 'Vista previa de la codificación' })).toHaveValue(source)
  await expect(review.getByLabel('Avisos de codificación')).toContainText('el XML declara UTF-8')
  await expect.poll(() => workers.length).toBeGreaterThan(workersBefore)
  // Exceed the two-second autosave delay; merely previewing must never queue a save.
  await page.waitForTimeout(2300)
  expect(contentSnapshot(library)).toEqual(before)
  expect(library.writes.slice(writesBefore).filter(write => write.startsWith('content:'))).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('encoding-explicit-preview.png') })
  await review.getByRole('button', { name: 'Cancelar', exact: true }).click()
  await expect(review).toBeHidden()
  await expect(choice).toBeHidden()
  await expect(editor.locator('.view-lines')).toContainText('borrador anterior, intacto')
  await page.waitForTimeout(2300)
  expect(contentSnapshot(library)).toEqual(before)

  await openFile(page, file)
  await choice.getByRole('button', { name: 'Abrir con esta codificación' }).click()
  await expect(review).toBeVisible()
  const acceptedAt = library.writes.length
  await review.getByRole('button', { name: 'Usar esta codificación y abrir' }).click()
  await expect(review).toBeHidden()
  await expect(editor.locator('.view-lines')).toContainText('“café” €')
  await expectImportSaved(page, library, source, bytes, acceptedAt)
  expect((await downloadOriginal(page)).bytes).toEqual(bytes)
  expect(workerFailures).toEqual([])
})

test('reviews declared Windows-1252, restores the UTF-8 panel and downloads the exact original after reload', async ({ page }, testInfo) => {
  const { library, editor, workers, workerFailures } = await setup(page)
  const source = '<?xml version="1.0" encoding="windows-1252"?><r name="Peña">“café” €</r>'
  const bytes = cp1252(source)
  const before = contentSnapshot(library)
  await openFile(page, { name: 'original-windows1252.xml', mimeType: 'application/xml', buffer: bytes })
  const review = page.getByRole('dialog', { name: 'Revisar codificación' })
  await expect(review.getByRole('textbox', { name: 'Vista previa de la codificación' })).toHaveValue(source)
  expect(contentSnapshot(library)).toEqual(before)
  const acceptedAt = library.writes.length
  await review.getByRole('button', { name: 'Usar esta codificación y abrir' }).click()
  await expect(editor.locator('.view-lines')).toContainText('Peña')
  await expectImportSaved(page, library, source, bytes, acceptedAt)
  expect(library.contents.get(`${library.getWorkspace().active_id}/panel-a`)).toEqual(Buffer.from(source, 'utf8'))
  expect(bytes).not.toEqual(Buffer.from(source, 'utf8'))

  const workersBeforeReload = workers.length
  await page.reload()
  await expect(editor).toBeVisible({ timeout: 30_000 })
  await expect(editor.locator('.view-lines')).toContainText('“café” €')
  await expect(editor.locator('.view-lines')).toContainText('Peña')
  await expect(editor.locator('.view-lines')).not.toContainText('PeÃ±a')
  await expect(review).toBeHidden()
  await expect.poll(() => workers.length).toBeGreaterThan(workersBeforeReload)
  const downloaded = await downloadOriginal(page)
  expect(downloaded.name).toBe('original-windows1252.xml')
  expect(downloaded.bytes).toEqual(bytes)
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('Peña')
  expect(workerFailures).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('encoding-restored-unicode.png') })
})

test.describe('mobile encoding review', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })

  test('warns about literal replacement characters and keeps the review inside the viewport', async ({ page }, testInfo) => {
    const { library, editor, workerFailures } = await setup(page)
    await typeDocument(page, editor, '{"estado":"trabajo móvil anterior"}')
    await expect.poll(() => [...library.contents.values()].some(bytes => bytes.toString('utf8').includes('trabajo móvil anterior'))).toBe(true)
    await expectSaved(page)
    const before = contentSnapshot(library)
    const source = '<?xml version="1.0" encoding="UTF-8"?><r>Shop �, Peña y 😀</r>'
    await openFile(page, { name: 'archivo-con-caracteres-ya-sustituidos.xml', mimeType: 'application/xml', buffer: Buffer.from(source, 'utf8') })
    const review = page.getByRole('dialog', { name: 'Revisar codificación' })
    await expect(review).toBeVisible()
    await expect(review.getByRole('textbox', { name: 'Vista previa de la codificación' })).toHaveValue(source)
    await expect(review.getByLabel('Avisos de codificación')).toContainText('ya contiene caracteres de sustitución')
    await expect(review.getByLabel('Avisos de codificación')).toContainText('no permite recuperar con certeza')
    const bounds = (await review.boundingBox())!
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.y).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(375)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(812)
    for (const button of await review.getByRole('button').all()) {
      const box = (await button.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(bounds.x)
      expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width)
      expect(box.height).toBeGreaterThanOrEqual(44)
    }
    await expect.poll(() => page.locator('html').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await page.waitForTimeout(2300)
    expect(contentSnapshot(library)).toEqual(before)
    await page.screenshot({ path: testInfo.outputPath('encoding-replacement-mobile-375.png') })
    await page.keyboard.press('Escape')
    await expect(review).toBeHidden()
    await expect(editor.locator('.view-lines')).toContainText('trabajo móvil anterior')
    expect(contentSnapshot(library)).toEqual(before)
    expect(workerFailures).toEqual([])
  })
})
