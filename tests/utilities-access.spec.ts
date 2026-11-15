import { mkdir, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { expect, test, type FileChooser, type Locator, type Page } from '@playwright/test'
import { createUtilitiesLibraryMock } from './helpers/utilitiesLibraryMock'
import { clickEditorAction, editorAction } from './helpers/jsonToolbar'

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
  const library = createUtilitiesLibraryMock()
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/utilities/access') {
      if (options.apiAllowed ?? options.permission) await route.fulfill({ status: 204 })
      else await route.fulfill({ status: 403, json: { success: false } })
      return
    }
    if (await library.handle(route)) return
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

async function typeDocument(page: Page, editor: Locator, source: string) {
  await editor.getByRole('textbox').focus()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText(source)
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect.poll(() => page.locator('main').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
}

async function expectSingleEditorToolbar(page: Page) {
  const toolbar = page.getByRole('toolbar', { name: 'Herramientas del documento activo' })
  const geometry = await toolbar.evaluate(element => {
    const bounds = element.getBoundingClientRect()
    const fine = matchMedia('(hover: hover) and (pointer: fine)').matches && !matchMedia('(any-pointer: coarse)').matches
    return {
      height: bounds.height,
      expectedHeight: fine ? 36 : 48,
      expectedControl: fine ? 32 : 44,
      wrap: getComputedStyle(element).flexWrap,
      controls: Array.from(element.querySelectorAll('button,select')).map(control => {
        const box = control.getBoundingClientRect()
        return { height: box.height, inside: box.left >= bounds.left - 1 && box.right <= bounds.right + 1, center: box.top + box.height / 2 }
      }),
    }
  })
  expect(geometry.height).toBe(geometry.expectedHeight)
  expect(geometry.wrap).toBe('nowrap')
  expect(geometry.controls.every(control => control.inside && control.height >= geometry.expectedControl)).toBe(true)
  expect(Math.max(...geometry.controls.map(control => control.center)) - Math.min(...geometry.controls.map(control => control.center))).toBeLessThanOrEqual(1)
}

async function openDocument(page: Page, file: Parameters<FileChooser['setFiles']>[0]) {
  const open = await editorAction(page, 'Abrir archivo')
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    open.click(),
  ])
  await chooser.setFiles(file)
}

async function downloadDocument(page: Page) {
  const button = await editorAction(page, 'Descargar documento')
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    button.click(),
  ])
  const path = await download.path()
  if (!path) throw new Error('The editor did not download a local file')
  return { filename: download.suggestedFilename(), source: await readFile(path, 'utf8') }
}

test('library and document workspace adapt to measured width and preserve saved drafts', async ({ page }, testInfo) => {
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
  await page.getByRole('button', { name: 'Nuevo documento', exact: true }).click()
  await page.getByRole('menuitem', { name: 'JSON/XML', exact: true }).click()
  const editorA = page.getByTestId('document-editor-a')
  const editorB = page.getByTestId('document-editor-b')
  const linesA = editorA.locator('.view-lines')
  const secondMarker = `${marker}-segundo`
  const raw = `{"id":9007199254740993,"marker":"${marker}"}`
  await expect(editorA).toBeVisible({ timeout: 20_000 })
  await expect(editorB).toBeHidden()
  await typeDocument(page, editorA, raw)
  await expect(linesA).toContainText(marker)
  await page.getByRole('button', { name: 'Formatear', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Formatear', exact: true })).toBeEnabled({ timeout: 60_000 })
  await expect(linesA).toContainText(new RegExp(`9007199254740993[\\s\\S]+${marker}`))
  await expect(editorA.locator('.view-line')).toHaveCount(4)
  await editorA.getByRole('textbox').focus()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(editorA.locator('.view-line')).toHaveCount(1)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(editorA.locator('.view-line')).toHaveCount(4)
  await expectNoHorizontalOverflow(page)

  for (const width of [375, 768, 1024, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(linesA).toContainText(marker)
    await expectNoHorizontalOverflow(page)
    await expectSingleEditorToolbar(page)
  }
  expect((await editorA.boundingBox())!.height).toBeGreaterThan(540)
  await page.getByRole('button', { name: 'Mostrar segundo panel' }).click()
  await expect(editorB).toBeVisible()
  expect((await editorB.boundingBox())!.x).toBeGreaterThan((await editorA.boundingBox())!.x)
  await typeDocument(page, editorB, `{"marker":"${secondMarker}"}`)
  await expect(editorB.locator('.view-lines')).toContainText(secondMarker)
  await testInfo.attach('editor-desktop-dark.png', { body: await page.screenshot({ path: testInfo.outputPath('editor-desktop-dark.png') }), contentType: 'image/png' })
  await page.getByRole('button', { name: 'Abrir Eros' }).click()
  await expect(linesA).toContainText(marker)
  await expectNoHorizontalOverflow(page)
  await page.getByLabel('Asistente Eros').getByTitle('Cerrar', { exact: true }).click()

  await page.setViewportSize({ width: 320, height: 740 })
  await page.getByRole('button', { name: 'Ver documento A', exact: true }).click()
  await expect(linesA).toContainText(marker)
  await expect(editorB).toBeHidden()
  await page.getByRole('button', { name: 'Ver documento B', exact: true }).click()
  await expect(editorB.locator('.view-lines')).toContainText(secondMarker)
  await expect(editorA).toBeHidden()
  await expectNoHorizontalOverflow(page)
  await testInfo.attach('editor-narrow-dark.png', { body: await page.screenshot({ path: testInfo.outputPath('editor-narrow-dark.png') }), contentType: 'image/png' })

  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(editorA).toBeVisible()
  const splitWidthA = (await editorA.boundingBox())!.width
  await page.getByRole('button', { name: 'Ocultar panel B' }).click()
  await expect(editorB).toBeHidden()
  await expect(linesA).toContainText(marker)
  await expect.poll(async () => (await editorA.boundingBox())!.width).toBeGreaterThan(splitWidthA * 1.5)
  await page.getByRole('button', { name: 'Mostrar segundo panel' }).click()
  await expect(editorB.locator('.view-lines')).toContainText(secondMarker)
  const splitWidthB = (await editorB.boundingBox())!.width
  await page.getByRole('button', { name: 'Ocultar panel A' }).click()
  await expect(editorA).toBeHidden()
  await expect(editorB.locator('.view-lines')).toContainText(secondMarker)
  await expect.poll(async () => (await editorB.boundingBox())!.width).toBeGreaterThan(splitWidthB * 1.5)
  await page.getByRole('button', { name: 'Mostrar segundo panel' }).click()
  await expect(linesA).toContainText(marker)
  await editorA.getByRole('textbox').focus()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(editorA.locator('.view-line')).toHaveCount(1)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(editorA.locator('.view-line')).toHaveCount(4)
  const leaked = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))
  expect(leaked).not.toContain(marker)
  expect(outgoing.filter(value => !value.includes('/api/utilities/')).join('\n')).not.toContain(marker)

  await page.getByRole('button', { name: /Cerrar pestaña/ }).click()
  await page.setViewportSize({ width: 320, height: 740 })
  await page.getByRole('button', { name: 'Abrir biblioteca' }).click()
  await page.getByRole('complementary', { name: 'Mis documentos' }).getByRole('button', { name: /Sin título/ }).click()
  await expect(editorA).toBeVisible({ timeout: 20_000 })
  await expect(linesA).toContainText(marker)
  expect(editorErrors).toEqual([])
})

test('Monaco applies the chosen theme and Ctrl+wheel changes font only over the focused editor', async ({ page }, testInfo) => {
  await mockAccount(page, { permission: true })
  const desktopViewport = { width: 1280, height: 720 }
  await page.setViewportSize(desktopViewport)
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto(`${baseURL}/dashboard/utilities/json`)
  const editor = page.getByTestId('document-editor-a')
  const zoom = page.getByRole('button', { name: 'Restablecer zoom del editor' })
  const format = page.getByRole('combobox', { name: 'Formato del documento' })
  const formatContrast = () => format.evaluate(element => {
    const luminance = (color: string) => {
      const [red, green, blue] = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(component => {
        const channel = Number(component) / 255
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * red + 0.7152 * green + 0.0722 * blue
    }
    const style = getComputedStyle(element)
    const foreground = luminance(style.color)
    const background = luminance(style.backgroundColor)
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
  })
  await expect(editor.locator('.monaco-editor.vs-dark')).toBeVisible({ timeout: 20_000 })
  await expect(zoom).toHaveText('100%')
  await expect.poll(formatContrast).toBeGreaterThanOrEqual(4.5)
  await clickEditorAction(page, 'Preferencias del editor')
  const theme = page.getByRole('combobox', { name: 'Tema' })
  await theme.selectOption('light')
  await expect(editor.locator('.monaco-editor.vs')).toBeVisible()
  await expect.poll(formatContrast).toBeGreaterThanOrEqual(4.5)
  await theme.selectOption('dark')
  await expect(editor.locator('.monaco-editor.vs-dark')).toBeVisible()
  await page.keyboard.press('Escape')
  await typeDocument(page, editor, '{"zoom":true}')
  const lines = editor.locator('.view-lines')
  const fontSize = () => lines.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))
  const wheel = (target: Locator, ctrlKey: boolean) => target.evaluate((element, ctrlKey) => {
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey, deltaY: -120 })
    element.dispatchEvent(event)
    return event.defaultPrevented
  }, ctrlKey)
  const viewport = () => page.evaluate(() => [window.innerWidth, window.innerHeight, window.devicePixelRatio, window.visualViewport?.scale])
  const initialFont = await fontSize()
  const initialViewport = await viewport()

  const back = page.getByRole('button', { name: 'Más acciones del editor', exact: true })
  await back.focus()
  expect(await wheel(lines, true)).toBe(false)
  expect(await fontSize()).toBe(initialFont)

  await editor.getByRole('textbox').focus()
  await wheel(lines, false)
  expect(await fontSize()).toBe(initialFont)
  expect(await wheel(back, true)).toBe(false)
  expect(await fontSize()).toBe(initialFont)
  expect(await wheel(lines, true)).toBe(true)
  await expect.poll(fontSize).toBeGreaterThan(initialFont)
  await expect(zoom).toHaveText('107%')
  expect(await viewport()).toEqual(initialViewport)

  await clickEditorAction(page, 'Preferencias del editor')
  const increase = page.getByRole('button', { name: 'Aumentar letra' })
  for (let size = 15; size < 70; size++) await increase.press('Enter')
  await expect(zoom).toHaveText('500%')
  await expect.poll(fontSize).toBe(70)
  await expect(increase).toBeDisabled()
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 320, height: 740 })
  await editor.getByRole('textbox').focus()
  await page.keyboard.press('Home')
  await expect(zoom).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await testInfo.attach('editor-320-500-percent.png', { body: await page.screenshot(), contentType: 'image/png' })
  await page.setViewportSize(desktopViewport)
  await zoom.click()
  await expect(zoom).toHaveText('100%')
  await expect.poll(fontSize).toBe(initialFont)
  expect(await viewport()).toEqual(initialViewport)
})

test('search text, caret and placeholder remain legible without selection in both editor themes', async ({ page }, testInfo) => {
  await mockAccount(page, { permission: true })
  await page.setViewportSize({ width: 1263, height: 650 })
  await page.goto(`${baseURL}/dashboard/utilities/json`)
  await expect(page.getByTestId('document-editor-a')).toBeVisible()
  await typeDocument(page, page.getByTestId('document-editor-a'), '{"texto":"Peña café"}')
  await clickEditorAction(page, 'Buscar en todo el documento')
  const input = page.getByRole('textbox', { name: 'Texto para buscar en todo el documento' })
  await input.fill('café')
  const contrast = () => input.evaluate(element => {
    const luminance = (color: string) => {
      const values = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(component => {
        const value = Number(component) / 255
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      })
      return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722
    }
    const ratio = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05)
    const style = getComputedStyle(element)
    const selected = getComputedStyle(element, '::selection')
    return {
      text: ratio(style.color, style.backgroundColor),
      placeholder: ratio(getComputedStyle(element, '::placeholder').color, style.backgroundColor),
      selection: ratio(selected.color, selected.backgroundColor),
      caret: style.caretColor === style.color,
    }
  })
  for (const theme of ['dark', 'light'] as const) {
    await clickEditorAction(page, 'Preferencias del editor')
    await page.getByRole('combobox', { name: 'Tema' }).selectOption(theme)
    await page.keyboard.press('Escape')
    await input.focus()
    await input.evaluate(element => element.setSelectionRange(element.value.length, element.value.length))
    const measured = await contrast()
    expect(measured.text).toBeGreaterThanOrEqual(4.5)
    expect(measured.placeholder).toBeGreaterThanOrEqual(4.5)
    expect(measured.selection).toBeGreaterThanOrEqual(4.5)
    expect(measured.caret).toBe(true)
    await expect(input).toHaveValue('café')
    await page.screenshot({ path: testInfo.outputPath(`search-${theme}-contrast.png`) })
  }
})

test('smart formatting groups short properties without flattening the JSON document', async ({ page }) => {
  await mockAccount(page, { permission: true })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${baseURL}/dashboard/utilities/json`)
  const editor = page.getByTestId('document-editor-a')
  const lines = editor.locator('.view-line')
  const long = 'x'.repeat(65)
  const source = `{"a":"${long}","b":2,"c":3,"d":4,"e":5}`
  await expect(editor).toBeVisible({ timeout: 20_000 })
  await typeDocument(page, editor, source)
  await page.getByRole('button', { name: 'Formatear', exact: true }).click()
  await expect(lines).toHaveCount(7)
  await page.getByRole('button', { name: 'Formato inteligente', exact: true }).click()
  await expect(lines).toHaveCount(4)
  expect(await downloadDocument(page)).toEqual({
    filename: 'documento-a.json',
    source: `{\n  "a": "${long}", "b": 2, "c": 3, "d": 4,\n  "e": 5\n}`,
  })
  await page.getByRole('button', { name: 'Compactar', exact: true }).click()
  await expect(lines).toHaveCount(1)
  expect((await downloadDocument(page)).source).toBe(source)
})

test('document actions remain usable through the compact toolbar and More', async ({ page, browserName }, testInfo) => {
  await mockAccount(page, { permission: true })
  if (browserName === 'chromium') await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.setViewportSize({ width: 320, height: 740 })
  await page.goto(`${baseURL}/dashboard/utilities/json`)
  const editor = page.getByTestId('document-editor-a')
  await expect(editor).toBeVisible({ timeout: 20_000 })
  await expectSingleEditorToolbar(page)
  for (const name of ['Copiar documento', 'Descargar documento', 'Reparar', 'Escapar', 'Desescapar', 'Limpiar documento']) {
    const button = await editorAction(page, name)
    await expect(button).toBeVisible()
    await expect(button.locator('svg')).toBeVisible()
    await expect(button).toBeDisabled()
  }
  await page.keyboard.press('Escape')
  await expectNoHorizontalOverflow(page)
  const source = '{"texto":"Ñ"}'
  await typeDocument(page, editor, source)
  expect(await downloadDocument(page)).toEqual({ filename: 'documento-a.json', source })
  if (browserName === 'chromium') {
    await clickEditorAction(page, 'Copiar documento')
    await expect(page.getByRole('status').filter({ hasText: 'Documento copiado.' })).toBeVisible()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(source)
  }
  await clickEditorAction(page, 'Escapar')
  await expect(await editorAction(page, 'Desescapar')).toBeEnabled()
  await page.keyboard.press('Escape')
  await expect(editor.locator('.view-lines')).toContainText('\\"texto\\"')
  expect((await downloadDocument(page)).source).toBe(JSON.stringify(source))
  await clickEditorAction(page, 'Desescapar')
  await expect(editor.locator('.view-lines')).toContainText(source)
  expect(await downloadDocument(page)).toEqual({ filename: 'documento-a.txt', source })

  const invalid = '{foo: 42}'
  await openDocument(page, { name: 'invalido.json', mimeType: 'application/json', buffer: Buffer.from(invalid) })
  await expect(editor.locator('.view-lines')).toContainText(invalid)
  await clickEditorAction(page, 'Reparar')
  await expect(page.getByText('Propuesta de reparación · Documento A')).toBeVisible()
  expect((await downloadDocument(page)).source).toBe(invalid)
  const proposalScreenshot = testInfo.outputPath('json-repair-proposal.png')
  await page.screenshot({ path: proposalScreenshot })
  await testInfo.attach('json-repair-proposal.png', { path: proposalScreenshot, contentType: 'image/png' })
  await page.getByRole('button', { name: 'Aplicar reparación', exact: true }).click()
  await expect(editor.locator('.view-lines')).toContainText('"foo"')
  expect(JSON.parse((await downloadDocument(page)).source)).toEqual({ foo: 42 })

  await clickEditorAction(page, 'Limpiar documento')
  await expect(editor.locator('.view-lines')).not.toContainText('foo')
  await expect(await editorAction(page, 'Descargar documento')).toBeDisabled()
  await clickEditorAction(page, 'Deshacer')
  await expect(editor.locator('.view-lines')).toContainText('"foo"')
})

test.describe('touch document controls', () => {
  test.use({ hasTouch: true })
  test('keeps one toolbar row and 44-pixel targets with a keyboard accessible overflow menu', async ({ page }, testInfo) => {
    await mockAccount(page, { permission: true })
    await page.setViewportSize({ width: 320, height: 740 })
    await page.goto(`${baseURL}/dashboard/utilities/json`)
    await expect(page.getByTestId('document-editor-a')).toBeVisible({ timeout: 20_000 })
    await expectSingleEditorToolbar(page)
    const more = page.getByRole('button', { name: 'Más acciones del editor', exact: true })
    await more.focus()
    await page.keyboard.press('ArrowDown')
    const menu = page.getByRole('menu', { name: 'Más acciones del editor', exact: true })
    await expect(menu).toBeVisible()
    const bounds = (await menu.boundingBox())!
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(320)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(740)
    await expect(page.getByRole('menuitem', { name: 'Abrir archivo', exact: true })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(more).toBeFocused()
    await expectNoHorizontalOverflow(page)
    const screenshot = testInfo.outputPath('json-toolbar-touch.png')
    await page.screenshot({ path: screenshot })
    await testInfo.attach('json-toolbar-touch.png', { path: screenshot, contentType: 'image/png' })
  })
})

test('word wrap changes only visual lines and is independent for each document', async ({ page }) => {
  await mockAccount(page, { permission: true })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${baseURL}/dashboard/utilities/json`)
  const editorA = page.getByTestId('document-editor-a')
  const editorB = page.getByTestId('document-editor-b')
  const wrap = page.getByRole('button', { name: 'Ajustar líneas' })
  const linesA = editorA.locator('.view-line')
  const linesB = editorB.locator('.view-line')
  const scrollbarA = editorA.locator('.editor-scrollable > .scrollbar.horizontal')
  const scrollbarB = editorB.locator('.editor-scrollable > .scrollbar.horizontal')
  const source = `{"a":"${'abc'.repeat(200)}"}`
  await expect(editorA).toBeVisible({ timeout: 20_000 })
  await typeDocument(page, editorA, source)
  await expect(wrap).toHaveAttribute('aria-pressed', 'false')
  await expect(linesA).toHaveCount(1)
  await wrap.click()
  await expect(wrap).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => linesA.count()).toBeGreaterThan(1)
  await expect(scrollbarA).toHaveClass(/\binvisible\b/)
  expect((await downloadDocument(page)).source).toBe(source)

  await page.getByRole('button', { name: 'Mostrar segundo panel' }).click()
  await typeDocument(page, editorB, source.replace('"a"', '"b"'))
  await expect(wrap).toHaveAttribute('aria-pressed', 'false')
  await expect(linesB).toHaveCount(1)
  await wrap.click()
  await expect.poll(() => linesB.count()).toBeGreaterThan(1)
  await expect(scrollbarB).toHaveClass(/\binvisible\b/)

  await editorA.getByRole('textbox').focus()
  await expect(wrap).toHaveAttribute('aria-pressed', 'true')
  await expect(wrap).toHaveAttribute('aria-keyshortcuts', 'Alt+Z')
  await page.keyboard.press('Alt+z')
  await expect(wrap).toHaveAttribute('aria-pressed', 'false')
  await expect(linesA).toHaveCount(1)
  await editorB.getByRole('textbox').focus()
  await expect(wrap).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => linesB.count()).toBeGreaterThan(1)
})

test('Monaco recognizes JSON and XML syntax and offers local completions', async ({ page }) => {
  await mockAccount(page, { permission: true })
  await page.goto(`${baseURL}/dashboard/utilities/json`)
  const editor = page.getByTestId('document-editor-a')
  const lines = editor.locator('.view-lines')
  const colors = () => lines.locator('span[class^="mtk"]').evaluateAll(tokens => (
    new Set(tokens.filter(token => token.textContent?.trim()).map(token => getComputedStyle(token).color)).size
  ))
  const suggest = async (label: string) => {
    await page.keyboard.press('Control+Space')
    await expect(editor.locator('.suggest-widget').getByText(label, { exact: true }).first()).toBeVisible()
    await page.keyboard.press('Enter')
  }

  await expect(editor).toBeVisible({ timeout: 20_000 })
  await typeDocument(page, editor, '{"activo":true,"cantidad":7}')
  await expect.poll(colors).toBeGreaterThan(1)
  await typeDocument(page, editor, '{"activo": tr')
  await suggest('true')
  await expect(lines).toContainText('true')

  await page.getByRole('combobox', { name: 'Formato del documento' }).selectOption('xml')
  await typeDocument(page, editor, '<raiz dato="sí"><item>Contenido</item></raiz>')
  await expect.poll(colors).toBeGreaterThan(1)
  await typeDocument(page, editor, '<raiz></')
  await suggest('raiz')
  await expect(lines).toContainText('<raiz></raiz>')
})

test('Monaco compares JSON and XML without overwriting either document', async ({ page }) => {
  await mockAccount(page, { permission: true })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${baseURL}/dashboard/utilities/json`)
  const editorA = page.getByTestId('document-editor-a')
  const editorB = page.getByTestId('document-editor-b')
  const diff = page.getByTestId('document-editor-diff')
  const openDiff = page.getByRole('button', { name: 'Comparar diferencias' })
  const editAgain = page.getByRole('button', { name: 'Volver a editar' })

  await expect(editorA).toBeVisible({ timeout: 20_000 })
  await typeDocument(page, editorA, '{"estado":"original-json"}')
  await page.getByRole('button', { name: 'Mostrar segundo panel' }).click()
  await typeDocument(page, editorB, '{"estado":"modificado-json"}')
  await openDiff.click()
  await expect(diff).toBeVisible()
  await expect(diff.locator('.view-lines').filter({ hasText: 'original-json' })).toBeVisible()
  await expect(diff.locator('.view-lines').filter({ hasText: 'modificado-json' })).toBeVisible()
  await expect(diff.locator('.line-insert, .line-delete').first()).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'Diferencias resaltadas.' })).toBeVisible()
  await page.setViewportSize({ width: 320, height: 740 })
  await expect(diff).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await editAgain.click()
  await expect(editorA.locator('.view-lines')).toContainText('original-json')
  await expect(editorB.locator('.view-lines')).toContainText('modificado-json')

  await editorA.getByRole('textbox').focus()
  await openDocument(page, { name: 'original.xml', mimeType: 'application/xml', buffer: Buffer.from('<raiz><estado>original-xml</estado></raiz>') })
  await expect(editorA.locator('.view-lines')).toContainText('original-xml')
  await expect(page.getByRole('combobox', { name: 'Formato del documento' })).toHaveValue('xml')
  await editorB.getByRole('textbox').focus()
  await openDocument(page, { name: 'modificado.xml', mimeType: 'application/xml', buffer: Buffer.from('<raiz><estado>modificado-xml</estado></raiz>') })
  await expect(editorB.locator('.view-lines')).toContainText('modificado-xml')
  await expect(page.getByRole('combobox', { name: 'Formato del documento' })).toHaveValue('xml')
  await clickEditorAction(page, 'Preferencias del editor')
  await page.getByRole('checkbox', { name: 'Ajustar espacios entre etiquetas' }).check()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Formatear', exact: true }).click()
  await expect(editorB.locator('.view-line')).toHaveCount(3)
  await openDiff.click()
  await expect(diff.locator('.view-lines').filter({ hasText: 'original-xml' })).toBeVisible()
  await expect(diff.locator('.view-lines').filter({ hasText: 'modificado-xml' })).toBeVisible()
  await editAgain.click()
  await expect(editorA.locator('.view-lines')).toContainText('original-xml')
  await expect(editorB.locator('.view-lines')).toContainText('modificado-xml')
})

test('a 30 MiB document with a long line remains navigable in bounded editable chunks', async ({ page }, testInfo) => {
  await mockAccount(page, { permission: true })
  const firstMarker = 'primer-tramo-clarin-qa'
  const secondMarker = 'segundo-tramo-clarin-qa'
  const size = 30 * 1024 * 1024
  const source = Buffer.alloc(size, 'a')
  source.write(`{"valor":"${firstMarker}`)
  source.write(secondMarker, 24_000)
  source.write('"}', size - 2)
  const file = testInfo.outputPath('documento-grande.json')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, source)
  const outgoing: string[] = []
  page.on('request', request => outgoing.push(`${request.url()} ${request.postData() || ''}`))

  try {
    await page.goto(`${baseURL}/dashboard/utilities/json`)
    await expect(page.getByTestId('document-editor-a')).toBeVisible({ timeout: 20_000 })
    const openStarted = performance.now()
    await openDocument(page, file)
    await expect(page.getByText(firstMarker, { exact: false })).toBeVisible({ timeout: 30_000 })
    const openMs = Math.round(performance.now() - openStarted)
    const wrap = page.getByRole('button', { name: 'Ajustar líneas' })
    await expect(wrap).toHaveAttribute('aria-pressed', 'true')
    await expect(wrap).toBeDisabled()
    const previous = page.getByRole('button', { name: 'Tramo anterior' })
    const next = page.getByRole('button', { name: 'Tramo siguiente' })
    await expect(previous).toBeDisabled()
    await next.click()
    await expect(page.getByText(secondMarker, { exact: false })).toBeVisible()
    await previous.click()
    await expect(page.getByText(firstMarker, { exact: false })).toBeVisible()
    const validateStarted = performance.now()
    await page.getByRole('button', { name: 'Validar', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'JSON válido.' })).toBeVisible({ timeout: 30_000 })
    const timingPath = testInfo.outputPath('large-document-timing.json')
    await writeFile(timingPath, JSON.stringify({ bytes: size, openMs, validateMs: Math.round(performance.now() - validateStarted) }))
    await testInfo.attach('large-document-timing.json', { contentType: 'application/json', path: timingPath })
    await truncate(file, 60 * 1024 * 1024 + 1)
    await openDocument(page, file)
    await expect(page.getByRole('alert').filter({ hasText: 'El archivo supera 60 MiB.' })).toBeVisible()
    await expect(page.getByText(firstMarker, { exact: false })).toBeVisible()
    await expectNoHorizontalOverflow(page)
    expect(outgoing.filter(value => !value.includes('/api/utilities/')).join('\n')).not.toContain(firstMarker)
    expect(outgoing.filter(value => !value.includes('/api/utilities/')).join('\n')).not.toContain(secondMarker)
  } finally {
    await rm(file, { force: true })
  }
})

test('a 25 MiB multiline document stays editable and undo restores it after compacting', async ({ page }, testInfo) => {
  await mockAccount(page, { permission: true })
  const marker = 'documento-multilinea-clarin-qa'
  const size = 25 * 1024 * 1024
  const source = Buffer.alloc(size, ' ')
  const prefixBytes = source.write(`[\n"${marker}"\n`)
  const row = `,"${'x'.repeat(2_048)}"\n`
  const rowBytes = Buffer.byteLength(row)
  const rowCount = Math.floor((size - prefixBytes - 1) / rowBytes)
  source.fill(row, prefixBytes, prefixBytes + rowCount * rowBytes)
  source.write(']', size - 1)
  const file = testInfo.outputPath('documento-multilinea.json')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, source)

  try {
    await page.goto(`${baseURL}/dashboard/utilities/json`)
    const editor = page.getByTestId('document-editor-a')
    await expect(editor).toBeVisible({ timeout: 20_000 })
    await openDocument(page, file)
    await expect(editor.locator('.view-lines')).toContainText(marker, { timeout: 30_000 })
    const next = page.getByRole('button', { name: 'Tramo siguiente' })
    await expect(next).toBeHidden()
    await expect(editor.getByRole('textbox')).toBeEditable()
    await page.getByRole('button', { name: 'Validar', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'JSON válido.' })).toBeVisible({ timeout: 30_000 })

    await page.getByRole('button', { name: 'Compactar', exact: true }).click()
    await expect(next).toBeEnabled({ timeout: 30_000 })
    await expect(editor.locator('.view-lines')).toContainText(marker)
    await page.getByRole('button', { name: 'Deshacer', exact: true }).click()
    await expect(next).toBeHidden({ timeout: 30_000 })
    await expect(editor.getByRole('textbox')).toBeEditable()
    await expect(editor.locator('.view-lines')).toContainText(marker)
  } finally {
    await rm(file, { force: true })
  }
})

test('a direct link also enforces the current server permission', async ({ page }) => {
  await mockAccount(page, { permission: true, apiAllowed: false })
  await page.goto(`${baseURL}/dashboard/utilities/json`)
  await expect(page.getByRole('heading', { name: 'No tienes acceso a Utilitarios' })).toBeVisible()
  await expect(page.getByTestId('document-editor-a')).toHaveCount(0)
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
