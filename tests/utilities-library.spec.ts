import { expect, test, type Page } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { createUtilitiesLibraryHttpMock } from './helpers/utilitiesLibraryHttpMock'
import { clickEditorAction, editorAction } from './helpers/jsonToolbar'

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3011'
test.use({ channel: process.env.PLAYWRIGHT_CHANNEL })
test.setTimeout(90_000)
const libraryServers = new Map<Page, () => Promise<void>>()
test.afterEach(async ({ page }) => {
  const close = libraryServers.get(page)
  libraryServers.delete(page)
  await close?.()
})

async function setup(page: Page) {
  const library = await createUtilitiesLibraryHttpMock()
  libraryServers.set(page, library.close)
  await page.context().addCookies([{ name: 'auth-token', value: 'library-browser-session', url: baseURL }])
  await page.addInitScript(() => { localStorage.setItem('token', 'cookie-session'); localStorage.setItem('clarin:auth_refreshed_at', String(Date.now())) })
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/utilities/access') return route.fulfill({ status: 204 })
    if (url.pathname.startsWith('/api/utilities/')) return route.continue({ url: `${library.url}${url.pathname}${url.search}` })
    return route.fulfill({ json: { success: true, user: { id: 'library-user', username: 'qa', display_name: 'Biblioteca QA', account_id: 'library-account', account_name: 'Cuenta QA', permissions: ['utilities'] }, session: { scope: 'library-scope', account_id: 'library-account', idle_timeout_minutes: 180, server_now: new Date().toISOString(), idle_expires_at: new Date(Date.now() + 10_800_000).toISOString(), absolute_expires_at: new Date(Date.now() + 86_400_000).toISOString() } } })
  })
  await page.setViewportSize({ width: 1600, height: 1000 })
  return library
}

async function rename(page: Page, title: string) {
  await page.getByRole('button', { name: 'Acciones del documento', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Renombrar documento', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Renombrar documento' })
  await dialog.getByRole('textbox', { name: 'Nombre' }).fill(title)
  await dialog.getByRole('button', { name: 'Guardar', exact: true }).click()
  await expect(dialog).toBeHidden()
}

async function createQr(page: Page) {
  await page.getByRole('button', { name: 'Nuevo documento', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Códigos QR', exact: true }).click()
}

async function typeEditorLines(page: Page, text: string) {
  // Firefox's synthetic multiline insertText creates one IME composition across
  // line breaks. Use the editor's real Enter gesture between individual lines.
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index++) {
    if (index) await page.keyboard.press('Enter')
    await page.keyboard.insertText(lines[index])
  }
}

async function pressEditorShortcut(page: Page, key: string, macKey = key) {
  // Monaco follows the emulated browser OS; Playwright's ControlOrMeta follows
  // the runner host, which differs for Desktop Safari on a Windows runner.
  const modifier = await page.evaluate(() => /Macintosh|iPhone|iPad|iPod/.test(navigator.userAgent) ? 'Meta' : 'Control')
  await page.keyboard.press(`${modifier}+${modifier === 'Meta' ? macKey : key}`)
}

async function saveViewportState(page: Page) {
  // Observe the real editor surface and Monaco's rendered scroll position. The
  // hidden textarea also exposes the active native selection without adding
  // test-only hooks to the production editor.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  return page.evaluate(() => {
    const rectangle = (element: Element | null) => {
      if (!element) return null
      const { x, y, width, height } = element.getBoundingClientRect()
      return { x, y, width, height }
    }
    const focused = document.activeElement
    return {
      header: rectangle(document.querySelector('[data-utility-workspace-header]')),
      status: rectangle(document.querySelector('[aria-label="Estado del guardado"]')),
      workspace: rectangle(document.getElementById('utility-active-document')),
      editors: [...document.querySelectorAll('[data-testid^="document-editor-"]')].map(element => ({
        id: element.getAttribute('data-testid'),
        bounds: rectangle(element),
        lines: [...element.querySelectorAll('.view-lines')].map(lines => ({
          bounds: rectangle(lines),
          transform: (lines as HTMLElement).style.transform,
        })),
        scroll: [...element.querySelectorAll('.monaco-scrollable-element')].map(scroll => ({ left: scroll.scrollLeft, top: scroll.scrollTop })),
      })),
      focus: { tag: focused?.tagName, label: focused?.getAttribute('aria-label') },
      selection: focused instanceof HTMLTextAreaElement ? {
        length: focused.value.length,
        start: focused.selectionStart,
        end: focused.selectionEnd,
        direction: focused.selectionDirection,
      } : null,
      pageScroll: { left: scrollX, top: scrollY },
    }
  })
}

async function expectStableSaveConfirmation(page: Page, save: () => Promise<void>) {
  const status = page.getByRole('button', { name: 'Estado del guardado', exact: true })
  const before = await saveViewportState(page)
  expect(before.header?.height).toBe(44)
  await page.evaluate(() => {
    const target = document.querySelector('[aria-label="Estado del guardado"]')!
    const start = performance.now()
    const events = [{ atMs: 0, title: target.getAttribute('title') }]
    const observer = new MutationObserver(() => events.push({ atMs: Math.round(performance.now() - start), title: target.getAttribute('title') }))
    observer.observe(target, { attributes: true, attributeFilter: ['title'] })
    Object.assign(window, { utilitySaveProbe: { events, observer } })
  })
  try {
    await save()
    await expect(status).toHaveAttribute('title', 'Documento guardado.')
    await expect(status.getByRole('status')).toHaveText('Documento guardado.')
    await expect(page.getByText('Documento guardado.', { exact: true })).toHaveCount(1)
    const during = await saveViewportState(page)
    expect(during).toEqual(before)
    await expect(status).toHaveAttribute('title', 'Guardado', { timeout: 5000 })
    const after = await saveViewportState(page)
    expect(after).toEqual(before)
    const titles = await page.evaluate(() => (window as unknown as { utilitySaveProbe: { events: { atMs: number; title: string | null }[] } }).utilitySaveProbe.events)
    const confirmationIndex = titles.findIndex(event => event.title === 'Documento guardado.')
    const ended = titles.slice(confirmationIndex + 1).find(event => event.title !== 'Documento guardado.')
    expect(confirmationIndex).toBeGreaterThanOrEqual(0)
    expect(ended).toBeDefined()
    expect(ended!.atMs - titles[confirmationIndex].atMs).toBeGreaterThanOrEqual(1900)
    return { before, during, after, titles }
  } catch (error) {
    const titles = await page.evaluate(() => (window as unknown as { utilitySaveProbe: { events: unknown[] } }).utilitySaveProbe.events)
    console.log('Save confirmation diagnostic:', JSON.stringify({ titles }))
    throw error
  } finally {
    await page.evaluate(() => {
      const probe = (window as unknown as { utilitySaveProbe?: { observer: MutationObserver } }).utilitySaveProbe
      probe?.observer.disconnect()
      delete (window as unknown as { utilitySaveProbe?: unknown }).utilitySaveProbe
    })
  }
}

async function expectActiveTabVisible(page: Page) {
  const strip = page.getByRole('tablist', { name: 'Documentos abiertos' })
  const activeRow = strip.locator('[data-utility-tab-id]').filter({ has: page.getByRole('tab', { selected: true }) })
  await expect(activeRow).toHaveCount(1)
  await expect.poll(async () => {
    const viewport = (await strip.boundingBox())!
    const active = (await activeRow.boundingBox())!
    return active.width > 0 && active.x >= viewport.x - 1 && active.x + active.width <= viewport.x + viewport.width + 1
  }).toBe(true)
}

test.describe('integrated dashboard focus header', () => {
  for (const width of [1024, 1263, 1600]) test(`keeps one 44px row, keyboard focus and stable saves at ${width}px`, async ({ page }, testInfo) => {
    const library = await setup(page)
    await page.routeWebSocket('**/*', socket => socket.close())
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`${baseURL}/dashboard/utilities/json`)
    const editor = page.getByTestId('document-editor-a')
    await expect(editor).toBeVisible({ timeout: 30_000 })
    const source = Array.from({ length: 80 }, (_, index) => `Linea ${index + 1}: prueba de cabecera`).join('\n')
    await page.getByLabel('Abrir archivo local').setInputFiles({ name: 'cabecera.txt', mimeType: 'text/plain', buffer: Buffer.from(source) })
    await expect.poll(() => library.contents.get(`${library.getWorkspace().active_id}/panel-a`)?.toString(), { timeout: 15_000 }).toBe(source)
    await expect(page.getByRole('button', { name: 'Estado del guardado', exact: true })).toHaveAttribute('title', 'Guardado')
    const input = editor.getByRole('textbox')
    await input.focus()
    await pressEditorShortcut(page, 'End', 'ArrowDown')
    await page.keyboard.press('Shift+ArrowLeft')
    await page.keyboard.press('Shift+ArrowLeft')
    const mountedInput = await input.elementHandle()
    const before = await saveViewportState(page)
    const sidebar = page.locator('[data-dashboard-sidebar]')
    const hide = page.getByRole('button', { name: 'Ocultar menú', exact: true })
    await hide.focus()
    await hide.press('Enter')
    await expect(sidebar).toHaveAttribute('data-dashboard-sidebar-hidden', 'true')
    await expect(sidebar).toHaveAttribute('inert', '')
    const header = page.locator('[data-utility-workspace-header]')
    const restore = page.getByRole('button', { name: 'Mostrar menú', exact: true })
    await expect(restore).toHaveAccessibleName('Mostrar menú')
    await expect(restore).toHaveAttribute('aria-controls', 'dashboard-primary-navigation')
    await expect(restore).toHaveAttribute('aria-expanded', 'false')
    await expect(restore).toBeFocused()
    await expect(page.locator('[data-dashboard-focus-restore-bar]')).toHaveCount(1)
    await expect(header.locator('[data-dashboard-focus-restore-bar]')).toHaveCount(1)
    const integrated = await saveViewportState(page)
    expect(integrated.header?.height).toBe(44)
    expect(integrated.header?.y).toBe(before.header?.y)
    expect(integrated.workspace?.y).toBe(before.workspace?.y)
    expect(integrated.editors[0].bounds?.y).toBe(before.editors[0].bounds?.y)
    expect(integrated.editors[0].bounds?.height).toBe(before.editors[0].bounds?.height)
    expect(integrated.editors[0].bounds!.width).toBeGreaterThan(before.editors[0].bounds!.width)
    expect((await header.boundingBox())!.y).toBe((await page.getByRole('region', { name: 'Biblioteca personal de Utilitarios' }).boundingBox())!.y)

    await restore.press('Tab')
    await expect(page.getByRole('button', { name: 'Abrir biblioteca', exact: true })).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(restore).toBeFocused()
    await expectActiveTabVisible(page)
    await input.focus()
    expect(await mountedInput!.evaluate(element => element.isConnected)).toBe(true)
    expect((await saveViewportState(page)).selection).toEqual(before.selection)
    const shortcut = await expectStableSaveConfirmation(page, () => pressEditorShortcut(page, 's'))
    await expect(input).toBeFocused()
    const save = page.getByRole('button', { name: 'Guardar documento', exact: true })
    await save.focus()
    const visibleSave = await expectStableSaveConfirmation(page, () => save.press('Enter'))
    await expect(save).toBeFocused()
    await page.screenshot({ path: testInfo.outputPath('integrated-focus-header.png') })

    await restore.focus()
    await restore.press('Space')
    await expect(sidebar).toHaveAttribute('data-dashboard-sidebar-hidden', 'false')
    await expect(hide).toBeFocused()
    await expect(page.locator('[data-dashboard-focus-restore-bar]')).toHaveCount(0)
    const restored = await saveViewportState(page)
    expect(restored.header).toEqual(before.header)
    expect(restored.workspace).toEqual(before.workspace)
    expect(restored.editors.map(surface => surface.bounds)).toEqual(before.editors.map(surface => surface.bounds))
    expect(await mountedInput!.evaluate(element => element.isConnected)).toBe(true)
    await testInfo.attach('integrated-header-geometry.json', { body: JSON.stringify({ width, before, integrated, restored, shortcut, visibleSave }, null, 2), contentType: 'application/json' })
  })

  test('keeps overflowing tabs visible and uses the existing Tab, Enter and Space gestures', async ({ page }) => {
    const library = await setup(page)
    await page.routeWebSocket('**/*', socket => socket.close())
    const titles = Array.from({ length: 8 }, (_, index) => `Documento ${index + 1} con un nombre largo para desbordar la fila`)
    const ids: string[] = []
    for (const title of titles) {
      const response = await fetch(`${library.url}/api/utilities/documents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'qr', title }) })
      expect(response.ok).toBe(true)
      const result = await response.json()
      ids.push(result.data.document.id)
    }
    const workspace = await fetch(`${library.url}/api/utilities/workspace`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ open_ids: ids, active_id: ids.at(-1) }) })
    expect(workspace.ok).toBe(true)
    await page.setViewportSize({ width: 1024, height: 900 })
    await page.goto(`${baseURL}/dashboard/utilities`)
    const tabs = page.getByRole('tablist', { name: 'Documentos abiertos' })
    await expect(tabs.getByRole('tab')).toHaveCount(8)
    await expect(page.getByRole('textbox', { name: 'Texto o enlace' })).toBeVisible()
    await expect(tabs.getByRole('tab', { selected: true })).toHaveAttribute('title', titles.at(-1)!)
    await expectActiveTabVisible(page)
    const hide = page.getByRole('button', { name: 'Ocultar menú', exact: true })
    await hide.focus()
    await hide.press('Space')
    const restore = page.getByRole('button', { name: 'Mostrar menú', exact: true })
    await expect(restore).toBeFocused()
    await expectActiveTabVisible(page)
    expect(await tabs.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true)
    await restore.press('Tab')
    await expect(page.getByRole('button', { name: 'Abrir biblioteca', exact: true })).toBeFocused()
    await page.keyboard.press('Tab')
    // Firefox includes a natively scrollable tab strip in sequential focus.
    // Keep its existing extra stop and verify the next Tab reaches the tab.
    if (await tabs.evaluate(element => element === document.activeElement)) await page.keyboard.press('Tab')
    const first = tabs.getByRole('tab').nth(0)
    await expect(first).toBeFocused()
    await first.press('Enter')
    await expect(first).toHaveAttribute('aria-selected', 'true')
    await expect(first).toBeEnabled()
    await first.focus()
    await expectActiveTabVisible(page)
    await page.keyboard.press('Tab')
    await expect(tabs.getByRole('button', { name: `Cerrar pestaña ${titles[0]}`, exact: true })).toBeFocused()
    await page.keyboard.press('Tab')
    const second = tabs.getByRole('tab').nth(1)
    await expect(second).toBeFocused()
    await second.press('Space')
    await expect(second).toHaveAttribute('aria-selected', 'true')
    await expect(second).toBeEnabled()
    await expectActiveTabVisible(page)
    const last = tabs.getByRole('tab').nth(7)
    await last.focus()
    await last.press('Enter')
    await expect(last).toHaveAttribute('aria-selected', 'true')
    await expectActiveTabVisible(page)
    expect((await page.locator('[data-utility-workspace-header]').boundingBox())!.height).toBe(44)
    await restore.focus()
    await restore.press('Enter')
    await expect(hide).toBeFocused()
    await expectActiveTabVisible(page)
  })

  test('resets temporary menu hiding below the desktop breakpoint without adding a mobile row', async ({ page }) => {
    await setup(page)
    await page.routeWebSocket('**/*', socket => socket.close())
    await page.setViewportSize({ width: 1024, height: 900 })
    await page.goto(`${baseURL}/dashboard/utilities/json`)
    await expect(page.getByTestId('document-editor-a')).toBeVisible({ timeout: 30_000 })
    const hide = page.getByRole('button', { name: 'Ocultar menú', exact: true })
    await hide.focus()
    await hide.press('Enter')
    await expect(page.getByRole('button', { name: 'Mostrar menú', exact: true })).toBeFocused()
    for (const width of [1023, 375, 320]) {
      await page.setViewportSize({ width, height: 900 })
      await expect(page.locator('[data-dashboard-sidebar]')).toHaveAttribute('data-dashboard-sidebar-hidden', 'false')
      await expect(page.getByRole('button', { name: 'Mostrar menú', exact: true })).toHaveCount(0)
      await expect(hide).toHaveCount(0)
      expect((await page.locator('[data-utility-workspace-header]').boundingBox())!.height).toBe(44)
      await expectActiveTabVisible(page)
      await expect.poll(() => page.getByRole('main').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    }
    await page.setViewportSize({ width: 1024, height: 900 })
    await expect(hide).toBeVisible()
    await expect(page.getByRole('button', { name: 'Mostrar menú', exact: true })).toHaveCount(0)
    await expect(page.locator('[data-dashboard-sidebar]')).toHaveAttribute('data-dashboard-sidebar-hidden', 'false')
  })

  test('compacts the restore label by available width beside docked Eros and expands it again', async ({ page }, testInfo) => {
    await setup(page)
    await page.routeWebSocket('**/*', socket => socket.close())
    await page.addInitScript(() => localStorage.setItem('clarin:eros:window:v2', JSON.stringify({ version: 2, mode: 'docked', geometry: { x: 720, y: 12, width: 500, height: 620 }, dockWidth: 500 })))
    await page.route('**/api/eros/**', route => route.fulfill({ json: { success: true, available: false, conversations: [], runs: [], tasks: [] } }))
    await page.setViewportSize({ width: 1263, height: 900 })
    await page.goto(`${baseURL}/dashboard/utilities/json`)
    await expect(page.getByTestId('document-editor-a')).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Estado del guardado', exact: true }).focus()
    await pressEditorShortcut(page, 'i')
    const eros = page.getByLabel('Asistente Eros', { exact: true })
    await expect(eros).toBeVisible()
    const hide = page.getByRole('button', { name: 'Ocultar menú', exact: true })
    await hide.focus()
    await hide.press('Enter')
    const restore = page.getByRole('button', { name: 'Mostrar menú', exact: true })
    await expect(restore).toBeFocused()
    const header = page.locator('[data-utility-workspace-header]')
    await expect.poll(async () => (await header.boundingBox())!.width).toBeLessThan(820)
    expect((await header.boundingBox())!.width).toBeGreaterThanOrEqual(640)
    expect((await header.boundingBox())!.height).toBe(44)
    await expect(restore).toHaveAccessibleName('Mostrar menú')
    await expect(restore.locator('.utility-restore-label')).toBeHidden()
    await restore.press('Tab')
    await expect(page.getByRole('button', { name: 'Abrir biblioteca', exact: true })).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(restore).toBeFocused()
    await expect(restore.locator('kbd')).toBeVisible()
    await expect(restore.locator('kbd')).toHaveText('Ctrl/Cmd + Shift + F')
    await expectActiveTabVisible(page)
    await page.screenshot({ path: testInfo.outputPath('integrated-header-docked-eros-compact.png') })

    await page.setViewportSize({ width: 1600, height: 900 })
    await expect.poll(async () => (await header.boundingBox())!.width).toBeGreaterThanOrEqual(820)
    await expect(restore.locator('.utility-restore-label')).toBeVisible()
    await expect(restore).toHaveAccessibleName('Mostrar menú')
    expect((await header.boundingBox())!.height).toBe(44)
    await expect(eros).toBeVisible()
    await expectActiveTabVisible(page)
    await page.screenshot({ path: testInfo.outputPath('integrated-header-docked-eros-wide.png') })
    await restore.focus()
    await restore.press('Enter')
    await expect(hide).toBeFocused()
    await expect(eros).toBeVisible()
  })

  test('retains the separate 44px fallback on Dashboard and registers the inline slot again on return', async ({ page }) => {
    await setup(page)
    await page.routeWebSocket('**/*', socket => socket.close())
    await page.route('**/api/dashboard/summary?*', route => route.fulfill({ json: { success: true, dashboard: { generated_at: '2026-11-20T00:00:00Z', timezone: 'America/Lima', period: { preset: '30d', from: '2026-10-21', to: '2026-11-20', previous_from: '2026-09-21', previous_to: '2026-10-21' }, sections: { leads: false, chats: false, tasks: false, events: false, devices: false } } } }))
    await page.goto(`${baseURL}/dashboard/utilities/json`)
    await expect(page.getByTestId('document-editor-a')).toBeVisible({ timeout: 30_000 })
    await page.getByRole('link', { name: 'Dashboard', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Resumen de la cuenta', exact: true })).toBeVisible()
    const main = page.getByRole('main')
    const before = (await main.boundingBox())!
    const hide = page.getByRole('button', { name: 'Ocultar menú', exact: true })
    await hide.focus()
    await hide.press('Enter')
    const restore = page.getByRole('button', { name: 'Mostrar menú', exact: true })
    await expect(restore).toBeFocused()
    const bar = page.locator('[data-dashboard-focus-restore-bar]')
    await expect(bar).toHaveCount(1)
    expect((await bar.boundingBox())!.height).toBe(44)
    expect(await bar.evaluate(element => !element.closest('main'))).toBe(true)
    expect((await main.boundingBox())!.y).toBe(before.y + 44)
    await restore.press('Enter')
    await expect(hide).toBeFocused()
    expect((await main.boundingBox())!.y).toBe(before.y)
    await page.getByRole('link', { name: 'Utilitarios', exact: true }).click()
    await expect(page.getByTestId('document-editor-a')).toBeVisible({ timeout: 30_000 })
    await hide.focus()
    await hide.press('Enter')
    await expect(restore).toBeFocused()
    await expect(page.locator('[data-utility-workspace-header] [data-dashboard-focus-restore-bar]')).toHaveCount(1)
    expect((await page.locator('[data-utility-workspace-header]').boundingBox())!.height).toBe(44)
  })
})

for (const width of [1600, 375, 320]) test(`save confirmation preserves editor geometry, selection and scroll at ${width}px`, async ({ page }, testInfo) => {
  const library = await setup(page)
  await page.routeWebSocket('**/*', socket => socket.close())
  await page.setViewportSize({ width, height: width === 320 ? 740 : 900 })
  await page.goto(`${baseURL}/dashboard/utilities/json`)
  const editor = page.getByTestId('document-editor-a')
  await expect(editor).toBeVisible({ timeout: 30_000 })
  const source = Array.from({ length: 120 }, (_, index) => `Linea ${index + 1}: contenido de prueba final`).join('\n')
  await page.getByLabel('Abrir archivo local').setInputFiles({ name: 'geometria.txt', mimeType: 'text/plain', buffer: Buffer.from(source) })
  // Import decoding is asynchronous; the resting label can still belong to
  // the empty document until the imported bytes reach the real mock server.
  await expect.poll(() => library.contents.get(`${library.getWorkspace().active_id}/panel-a`)?.toString(), { timeout: 15_000 }).toBe(source)
  const status = page.getByRole('button', { name: 'Estado del guardado', exact: true })
  await expect(status).toHaveAttribute('title', 'Guardado', { timeout: 15_000 })

  const save = page.getByRole('button', { name: 'Guardar documento', exact: true })
  await save.focus()
  // Safari intentionally blurs buttons on a pointer click. Activate the focused
  // visible action with Enter so this assertion isolates the announcement's
  // focus neutrality, rather than the browser's native pointer focus policy.
  const buttonResult = await expectStableSaveConfirmation(page, () => save.press('Enter'))
  await expect(save).toBeFocused()

  const input = editor.getByRole('textbox')
  await input.focus()
  await pressEditorShortcut(page, 'End', 'ArrowDown')
  await page.keyboard.press('Shift+ArrowLeft')
  await page.keyboard.press('Shift+ArrowLeft')
  const shortcutResult = await expectStableSaveConfirmation(page, () => pressEditorShortcut(page, 's'))
  await expect(input).toBeFocused()
  expect(shortcutResult.before.selection?.end).toBeGreaterThan(shortcutResult.before.selection?.start ?? 0)

  // Typing after the confirmation must still replace the selected characters
  // at the scrolled reading position, rather than moving the caret elsewhere.
  await page.keyboard.insertText('OK')
  const id = library.getWorkspace().active_id!
  await pressEditorShortcut(page, 's')
  await expect.poll(() => library.contents.get(`${id}/panel-a`)?.toString()).toBe(source.slice(0, -2) + 'OK')
  await testInfo.attach('save-confirmation-geometry.json', { body: JSON.stringify({ width, button: buttonResult, shortcut: shortcutResult }, null, 2), contentType: 'application/json' })
})

test('keeps independent same-tool tabs, saves, renames, searches, reopens and deletes documents', async ({ page }, testInfo) => {
  const library = await setup(page)
  await page.goto(`${baseURL}/dashboard/utilities`)
  await createQr(page)
  await rename(page, 'QR sucursal')
  await page.getByRole('textbox', { name: 'Texto o enlace' }).fill('contenido-buscable-iquitos')
  await expect.poll(() => [...library.contents.values()].some(value => value.toString().includes('contenido-buscable-iquitos'))).toBe(true)

  await createQr(page)
  await rename(page, 'QR pruebas')
  await expect(page.getByRole('textbox', { name: 'Texto o enlace' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Texto o enlace' }).fill('otro documento independiente')
  await page.getByRole('tab', { name: 'QR sucursal' }).click()
  await expect(page.getByRole('textbox', { name: 'Texto o enlace' })).toHaveValue('contenido-buscable-iquitos')
  await page.getByRole('button', { name: 'Cerrar pestaña QR sucursal' }).click()
  await expect(page.getByRole('textbox', { name: 'Texto o enlace' })).toHaveValue('otro documento independiente')
  expect(library.documents.size).toBe(2)
  expect(library.writes.some(write => write.startsWith('delete:'))).toBe(false)

  await page.getByRole('button', { name: 'Abrir biblioteca', exact: true }).click()
  await page.getByRole('textbox', { name: 'Buscar documentos por nombre o contenido' }).fill('contenido-buscable-iquitos')
  const sidebar = page.getByRole('complementary', { name: 'Mis documentos' })
  await expect(sidebar.getByRole('button', { name: /QR pruebas/ })).toHaveCount(0)
  await sidebar.getByRole('button', { name: /^QR sucursal/ }).click()
  await expect(page.getByRole('textbox', { name: 'Texto o enlace' })).toHaveValue('contenido-buscable-iquitos')
  await expect.poll(() => library.documents.get(library.getWorkspace().active_id ?? '')?.title).toBe('QR sucursal')
  await page.reload()
  await expect(page.getByRole('tab', { name: 'QR sucursal' })).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 })
  await expect(page.getByRole('textbox', { name: 'Texto o enlace' })).toHaveValue('contenido-buscable-iquitos')
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('contenido-buscable-iquitos')
  await testInfo.attach('biblioteca-documentos.png', { body: await page.screenshot({ path: testInfo.outputPath('biblioteca-documentos.png') }), contentType: 'image/png' })

  await page.getByRole('button', { name: 'Acciones del documento', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Eliminar documento', exact: true }).click()
  await page.getByRole('dialog', { name: 'Eliminar documento' }).getByRole('button', { name: 'Eliminar definitivamente' }).click()
  await expect(page.getByRole('tab', { name: 'QR sucursal' })).toHaveCount(0)
  expect(library.documents.size).toBe(1)
  expect([...library.contents.values()].some(value => value.toString().includes('contenido-buscable-iquitos'))).toBe(false)
})

test('saves real Monaco TXT and SQL with Ctrl+S, preserves modes on reload and exports their actual extensions', async ({ page }, testInfo) => {
  const library = await setup(page)
  const downloads: string[] = []
  page.on('download', download => downloads.push(download.suggestedFilename()))
  await page.goto(`${baseURL}/dashboard/utilities/json`)
  const editor = page.getByTestId('document-editor-a')
  await expect(editor).toBeVisible({ timeout: 30_000 })
  const mode = page.getByRole('combobox', { name: 'Formato del documento', exact: true })
  await mode.click()
  const choices = page.getByRole('dialog', { name: 'Elegir formato del documento' })
  const bounds = (await choices.boundingBox())!
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(1600)
  await choices.getByRole('option', { name: /^Texto plano/ }).click()
  const text = 'Texto libre, Pe\u00f1a y \ud83d\ude00\nSegunda l\u00ednea.'
  await expect.poll(() => library.getWorkspace().active_id).not.toBeNull()
  const id = library.getWorkspace().active_id!
  await editor.getByRole('textbox').focus()
  await typeEditorLines(page, text)
  await pressEditorShortcut(page, 's')
  await expect.poll(() => library.contents.get(`${id}/panel-a`)?.toString(), { timeout: 1500 }).toBe(text)
  expect(downloads).toEqual([])
  await expect(page.getByRole('button', { name: 'Formatear', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Validar', exact: true })).toBeDisabled()
  await mode.click()
  await page.getByRole('combobox', { name: 'Buscar formato' }).fill('SQL')
  await expect(page.getByRole('listbox', { name: 'Formatos del documento' }).getByRole('option')).toHaveCount(1)
  await page.getByRole('option', { name: /^SQL/ }).click()
  await editor.getByRole('textbox').focus()
  await pressEditorShortcut(page, 'a')
  await typeEditorLines(page, "select '\u00f1' as nombre;\n-- Texto, no ejecuci\u00f3n")
  await page.getByRole('button', { name: 'Guardar documento' }).click()
  await expect.poll(() => library.documents.get(id)?.config['json.formats']).toEqual({ a: 'sql', b: 'strict' })
  await page.reload()
  await expect(mode).toHaveText('SQL', { timeout: 30_000 })
  await expect(editor.locator('.view-lines')).toContainText('select')
  const downloadAction = await editorAction(page, 'Descargar documento')
  const [download] = await Promise.all([page.waitForEvent('download'), downloadAction.click()])
  expect(download.suggestedFilename()).toBe('documento-a.sql')
  expect(await readFile((await download.path())!, 'utf8')).toBe("select '\u00f1' as nombre;\n-- Texto, no ejecuci\u00f3n")
  await page.screenshot({ path: testInfo.outputPath('editor-text-and-code.png') })
  await page.setViewportSize({ width: 375, height: 812 })
  await mode.click()
  const mobilePicker = (await choices.boundingBox())!
  expect(mobilePicker.x).toBeGreaterThanOrEqual(0)
  expect(mobilePicker.x + mobilePicker.width).toBeLessThanOrEqual(375)
  expect(mobilePicker.y + mobilePicker.height).toBeLessThanOrEqual(812)
  await page.keyboard.press('Escape')
  await expect(mode).toBeFocused()
  await page.screenshot({ path: testInfo.outputPath('editor-text-and-code-375.png') })
})

test('save confirmation stays in place for chunked text and comparison while Ctrl+S saves the whole document', async ({ page }) => {
  const library = await setup(page)
  await page.routeWebSocket('**/*', socket => socket.close())
  await page.goto(`${baseURL}/dashboard/utilities/json`)
  const editorA = page.getByTestId('document-editor-a')
  await expect(editorA).toBeVisible({ timeout: 30_000 })
  await page.getByLabel('Abrir archivo local').setInputFiles({ name: 'large.txt', mimeType: 'text/plain', buffer: Buffer.from('x'.repeat(100_100)) })
  await expect(page.getByRole('button', { name: 'Tramo siguiente', exact: true })).toBeVisible()
  await expect.poll(() => library.getWorkspace().active_id).not.toBeNull()
  const id = library.getWorkspace().active_id!
  const chunkInput = editorA.getByRole('textbox')
  await chunkInput.focus()
  await pressEditorShortcut(page, 'Home', 'ArrowUp')
  // Position the native caret explicitly: WebKit's emulated Mac key gesture
  // leaves the native textarea caret at context offset500 on a Windows runner.
  await chunkInput.evaluate(element => (element as HTMLTextAreaElement).setSelectionRange(0, 0))
  await chunkInput.pressSequentially('chunk-save:')
  await expect(chunkInput).toHaveValue(/^chunk-save:/)
  await expect(editorA.locator('.view-lines')).toContainText('chunk-save:')
  await expectStableSaveConfirmation(page, () => pressEditorShortcut(page, 's'))
  await expect.poll(() => library.contents.get(`${id}/panel-a`)?.toString(), { timeout: 1500 }).toBe('chunk-save:' + 'x'.repeat(100_100))
  await page.getByLabel('Abrir archivo local').setInputFiles({ name: 'small.txt', mimeType: 'text/plain', buffer: Buffer.from('first') })
  await clickEditorAction(page, 'Mostrar segundo panel')
  const editorB = page.getByTestId('document-editor-b')
  await editorB.getByRole('textbox').focus()
  await page.keyboard.insertText('second')
  await clickEditorAction(page, 'Comparar diferencias')
  const diff = page.getByTestId('document-editor-diff')
  await expect(diff).toBeVisible()
  await diff.getByRole('textbox').last().focus()
  await expectStableSaveConfirmation(page, () => pressEditorShortcut(page, 's'))
  await expect.poll(() => library.contents.get(`${id}/panel-b`)?.toString(), { timeout: 1500 }).toBe('second')
  expect(library.contents.get(`${id}/panel-a`)?.toString()).toBe('first')
})

test('renames and deletes closed library documents without opening their tabs', async ({ page }) => {
  const library = await setup(page)
  await page.goto(`${baseURL}/dashboard/utilities/qr`)
  await rename(page, 'Documento cerrado')
  await page.getByRole('textbox', { name: 'Texto o enlace' }).fill('contenido cerrado')
  await createQr(page)
  await rename(page, 'Documento activo')
  await page.getByRole('button', { name: 'Cerrar pestaña Documento cerrado' }).click()
  const editor = page.getByRole('textbox', { name: 'Texto o enlace' })
  await editor.fill('borrador activo')
  await page.getByRole('button', { name: 'Abrir biblioteca', exact: true }).click()
  await page.getByRole('button', { name: 'Acciones de Documento cerrado', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Renombrar documento', exact: true }).click()
  const renameDialog = page.getByRole('dialog', { name: 'Renombrar documento' })
  await renameDialog.getByRole('textbox', { name: 'Nombre' }).fill('Renombrado desde biblioteca')
  await renameDialog.getByRole('button', { name: 'Guardar', exact: true }).click()
  await expect(renameDialog).toBeHidden()
  await expect(page.getByRole('tab', { name: 'Renombrado desde biblioteca', exact: true })).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'Documento activo', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('button', { name: 'Acciones de Renombrado desde biblioteca', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Eliminar documento', exact: true }).click()
  expect(library.documents.size).toBe(2)
  await page.getByRole('dialog', { name: 'Eliminar documento' }).getByRole('button', { name: 'Eliminar definitivamente' }).click()
  await expect.poll(() => library.documents.size).toBe(1)
  await expect(editor).toHaveValue('borrador activo')
  await expect(page.getByRole('tab')).toHaveCount(1)
})

test('copies a conflicting draft durably before loading the original saved version', async ({ page }) => {
  const library = await setup(page)
  await page.goto(`${baseURL}/dashboard/utilities/qr`)
  const editor = page.getByRole('textbox', { name: 'Texto o enlace' })
  await editor.fill('versión guardada')
  await page.getByRole('button', { name: 'Guardar documento' }).click()
  await expect.poll(() => library.getWorkspace().active_id).not.toBeNull()
  const originalId = library.getWorkspace().active_id!
  await expect.poll(() => library.contents.get(`${originalId}/qr-text`)?.toString()).toBe('versión guardada')
  library.failSave(409)
  await editor.fill('borrador local protegido')
  await page.getByRole('button', { name: 'Guardar documento' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Conflicto de versión' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reintentar', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Guardar copia y cargar versión guardada', exact: true }).click()
  await expect(editor).toHaveValue('versión guardada')
  expect(library.getWorkspace().active_id).toBe(originalId)
  expect(library.documents.size).toBe(2)
  const copyId = [...library.documents.keys()].find(id => id !== originalId)!
  expect(library.contents.get(`${copyId}/qr-text`)?.toString()).toBe('borrador local protegido')
})

test('preserves unsaved work on conflict and saves it as an independent copy', async ({ page }) => {
  const library = await setup(page)
  await page.goto(`${baseURL}/dashboard/utilities/qr`)
  await page.getByRole('textbox', { name: 'Texto o enlace' }).fill('valor confirmado')
  await expect.poll(() => [...library.contents.values()].some(value => value.toString() === 'valor confirmado')).toBe(true)
  library.failSave(409)
  await page.getByRole('textbox', { name: 'Texto o enlace' }).fill('borrador que no se puede perder')
  await expect(page.getByRole('status').filter({ hasText: 'Conflicto de versión' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Texto o enlace' })).toHaveValue('borrador que no se puede perder')
  await page.getByRole('button', { name: 'Guardar una copia', exact: true }).click()
  await expect(page.getByRole('tab', { name: /copia/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('textbox', { name: 'Texto o enlace' })).toHaveValue('borrador que no se puede perder')
  expect(library.documents.size).toBe(2)
})

test('remains usable at narrow widths and keeps closing distinct from deleting', async ({ page }) => {
  await setup(page)
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(`${baseURL}/dashboard/utilities/qr`)
  await page.getByRole('textbox', { name: 'Texto o enlace' }).fill('documento móvil')
  await page.getByRole('button', { name: 'Abrir biblioteca' }).click()
  await expect(page.getByRole('textbox', { name: 'Buscar documentos por nombre o contenido' })).toBeVisible()
  await page.getByRole('button', { name: 'Cerrar biblioteca' }).click()
  await expect(page.getByRole('textbox', { name: 'Texto o enlace' })).toHaveValue('documento móvil')
  await expect.poll(() => page.getByRole('main').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
})

test('keeps at least 200px for editing at 320px and exposes complete keyboard menus', async ({ page }, testInfo) => {
  await setup(page)
  await page.setViewportSize({ width: 320, height: 740 })
  await page.goto(`${baseURL}/dashboard/utilities/json`)
  const editor = page.getByTestId('document-editor-a')
  await expect(editor).toBeVisible({ timeout: 30_000 })
  await expect.poll(async () => (await editor.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(200)
  expect((await page.locator('[data-utility-workspace-header]').boundingBox())!.height).toBe(44)
  await expect(page.locator('[data-utility-create-toolbar], [data-utility-document-toolbar]')).toHaveCount(0)
  const actions = page.getByRole('button', { name: 'Acciones del documento', exact: true })
  await actions.focus(); await actions.press('ArrowDown')
  const actionMenu = page.getByRole('menu', { name: 'Acciones del documento' })
  await expect(actionMenu).toBeVisible()
  await expect(actionMenu.getByRole('menuitem').first()).toBeFocused()
  await page.keyboard.press('End')
  await expect(actionMenu.getByRole('menuitem', { name: 'Eliminar documento', exact: true })).toBeFocused()
  const rectangle = (await actionMenu.boundingBox())!
  expect(rectangle.x).toBeGreaterThanOrEqual(0); expect(rectangle.x + rectangle.width).toBeLessThanOrEqual(320)
  expect(rectangle.y).toBeGreaterThanOrEqual(0); expect(rectangle.y + rectangle.height).toBeLessThanOrEqual(740)
  await page.keyboard.press('Escape')
  await expect(actions).toBeFocused()
  await expect.poll(() => page.getByRole('main').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('editor-320-usable.png') })
  await page.getByRole('button', { name: 'Nuevo documento', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Códigos QR', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Texto o enlace' })).toBeVisible()
  await expect(page.getByRole('tab')).toHaveCount(2)
  const activeTab = page.getByRole('tab', { selected: true })
  const strip = (await page.getByRole('tablist', { name: 'Documentos abiertos' }).boundingBox())!
  const active = (await activeTab.boundingBox())!
  expect(active.x).toBeGreaterThanOrEqual(strip.x - 1)
  expect(active.x + active.width).toBeLessThanOrEqual(strip.x + strip.width + 1)
})

test('gives the reference viewport one header and keeps navigation preferences scoped to Utilities', async ({ page }, testInfo) => {
  await setup(page)
  await page.addInitScript(() => localStorage.setItem('sidebar_collapsed', 'false'))
  await page.setViewportSize({ width: 1263, height: 650 })
  await page.goto(`${baseURL}/dashboard/utilities/json`)
  const editor = page.getByTestId('document-editor-a')
  await expect(editor).toBeVisible({ timeout: 30_000 })
  const sidebar = page.locator('[data-dashboard-sidebar]')
  await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(68)
  expect(await page.evaluate(() => localStorage.getItem('sidebar_collapsed'))).toBe('false')
  await expect(page.getByRole('complementary', { name: 'Mis documentos' })).toHaveCount(0)
  expect((await page.locator('[data-utility-workspace-header]').boundingBox())!.height).toBe(44)
  await expect.poll(async () => (await editor.boundingBox())!.height).toBeGreaterThanOrEqual(500)
  await expect.poll(async () => (await editor.boundingBox())!.width).toBeGreaterThanOrEqual(1150)
  const geometryPath = testInfo.outputPath('workspace-geometry.json')
  await writeFile(geometryPath, JSON.stringify({ viewport: page.viewportSize(), devicePixelRatio: await page.evaluate(() => devicePixelRatio), editor: await editor.boundingBox(), header: await page.locator('[data-utility-workspace-header]').boundingBox() }, null, 2))
  await testInfo.attach('workspace-geometry.json', { path: geometryPath, contentType: 'application/json' })
  await page.getByRole('button', { name: 'Abrir biblioteca', exact: true }).click()
  const library = page.getByRole('complementary', { name: 'Mis documentos' })
  await expect(library).toBeVisible()
  expect((await library.boundingBox())!.width).toBe(224)
  await page.getByRole('button', { name: 'Cerrar biblioteca', exact: true }).click()
  await expect(editor).toBeVisible()
  await expect(page.getByRole('button', { name: 'Estado del guardado', exact: true })).toHaveAttribute('title', 'Guardado')
  await page.screenshot({ path: testInfo.outputPath('utilities-1263-compact.png') })
  await page.getByRole('button', { name: 'Expandir menú', exact: true }).click()
  await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(240)
  expect(await page.evaluate(() => localStorage.getItem('sidebar_collapsed'))).toBe('false')
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click()
  await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(240)
  await page.getByRole('link', { name: 'Utilitarios', exact: true }).click()
  await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(240)
})

test('Escape closes the library overlay while keeping the docked Eros panel open', async ({ page }, testInfo) => {
  await setup(page)
  await page.addInitScript(() => localStorage.setItem('clarin:eros:window:v2', JSON.stringify({ version: 2, mode: 'docked', geometry: { x: 720, y: 12, width: 440, height: 620 }, dockWidth: 440 })))
  await page.route('**/api/eros/**', route => route.fulfill({ json: { success: true, available: false, conversations: [], runs: [], tasks: [] } }))
  await page.setViewportSize({ width: 1263, height: 650 })
  await page.goto(`${baseURL}/dashboard/utilities/json`)
  await expect(page.getByTestId('document-editor-a')).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Estado del guardado', exact: true }).focus()
  await page.keyboard.press('Control+i')
  const eros = page.getByLabel('Asistente Eros', { exact: true })
  await expect(eros).toBeVisible()
  // The assistant installs its keyboard owner after opening and checking availability.
  await page.waitForTimeout(200)
  for (const focused of ['search', 'header']) {
    await page.getByRole('button', { name: 'Abrir biblioteca', exact: true }).click()
    const library = page.getByRole('complementary', { name: 'Mis documentos' })
    await expect(library).toBeVisible()
    await page.waitForTimeout(100)
    if (focused === 'search') await page.getByRole('textbox', { name: 'Buscar documentos por nombre o contenido' }).focus()
    else await page.getByRole('button', { name: 'Cerrar biblioteca', exact: true }).focus()
    await page.keyboard.press('Escape')
    await expect(library).toBeHidden()
    // Check the committed result, including the assistant's prop-to-state effect.
    await page.waitForTimeout(200)
    const result = { focused, libraryOpen: await library.isVisible(), erosOpen: await eros.isVisible() }
    const resultPath = testInfo.outputPath(`escape-result-${focused}.json`)
    await writeFile(resultPath, JSON.stringify(result, null, 2))
    await testInfo.attach(`escape-result-${focused}.json`, { path: resultPath, contentType: 'application/json' })
    expect(result).toEqual({ focused, libraryOpen: false, erosOpen: true })
    await expect(page.getByRole('button', { name: 'Abrir biblioteca', exact: true })).toBeFocused()
  }
})

for (const hasTouch of [false, true]) test.describe(hasTouch ? 'touch document menu' : 'mouse document menu', () => {
  test.use({ hasTouch })
  test('uses the shared density for every document action', async ({ page }) => {
    await setup(page)
    await page.goto(`${baseURL}/dashboard/utilities/qr`)
    await expect(page.getByRole('textbox', { name: 'Texto o enlace' })).toBeVisible()
    await page.getByRole('button', { name: 'Acciones del documento', exact: true }).click()
    const menu = page.getByRole('menu', { name: 'Acciones del documento' })
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem').first()).toBeFocused()
    const heights = await menu.getByRole('menuitem').evaluateAll(items => items.map(item => item.getBoundingClientRect().height))
    expect(heights.length).toBeGreaterThan(0)
    expect(heights.every(height => height === (hasTouch ? 44 : 32))).toBe(true)
    await page.keyboard.press('End')
    await expect(menu.getByRole('menuitem', { name: 'Eliminar documento', exact: true })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'Acciones del documento', exact: true })).toBeFocused()
  })
})
