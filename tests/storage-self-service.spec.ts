import { expect, test, type Page, type Route } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StorageAction, StorageFile, StorageReview } from '../frontend/src/components/storage/storageModel'

// Browser/UI contract tests with synthetic API responses. Real SQL, MinIO,
// tenant authorization and physical deletion belong to the independent Go
// integration suite; these mocks are never presented as production E2E proof.
const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3011'
const accountA = '11111111-1111-4111-8111-111111111111'
const accountB = '22222222-2222-4222-8222-222222222222'
const userID = '33333333-3333-4333-8333-333333333333'
const runtimeErrors = new WeakMap<Page, string[]>()
test.beforeEach(async ({ page }) => {
  const errors: string[] = []; runtimeErrors.set(page, errors)
  page.on('pageerror', error => errors.push(error.message))
})
test.afterEach(async ({ page }) => {
  expect(runtimeErrors.get(page) || [], 'uncaught browser runtime errors').toEqual([])
})

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

function makeFile(index: number, account = accountA): StorageFile {
  const filename = `Documento ${String(index + 1).padStart(3, '0')}.pdf`
  return { object_key: `${account}/chats/file-${index}.pdf`, filename, media_type: 'document', size_bytes: (index + 1) * 1024,
    last_modified: '2026-01-01T10:00:00Z', origins: [{ type: 'chats', label: 'Conversación de prueba', href: '/dashboard/chats?open=synthetic' }],
    references_count: 1, can_remove: true, status: 'active' }
}

async function installStorageUI(page: Page, options: { count?: number; canManage?: boolean; firstFilesFail?: boolean; previewExpired?: boolean; confirmMode?: 'partial' | 'conflict' | 'network'; longFilename?: boolean } = {}) {
  const records = Array.from({ length: options.count ?? 3 }, (_, index) => makeFile(index))
  if (options.longFilename && records[0]) records[0].filename = 'Documento con un nombre extremadamente largo para comprobar el desborde en teléfonos pequeños y paneles estrechos.pdf'
  const previews = new Map<string, StorageReview>()
  const calls = { files: [] as string[], previews: [] as { action: StorageAction; object_keys: string[] }[], confirms: [] as { preview_id: string }[] }
  let account = accountA
  let failFiles = !!options.firstFilesFail
  let failConfirm = options.confirmMode
  await page.addInitScript(() => {
    localStorage.setItem('token', 'cookie-session')
    localStorage.setItem('clarin:auth_refreshed_at', String(Date.now()))
    localStorage.setItem('clarin:last_activity_at', String(Date.now()))
    localStorage.setItem('clarin:auth_scope', 'active:storage-qa-a')
    localStorage.setItem('sidebar_collapsed', 'true')
  })
  await page.context().addCookies([{ name: 'refresh-token', value: 'synthetic-session', url: baseURL, httpOnly: true, sameSite: 'Lax' }])
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()); const path = url.pathname; const method = route.request().method()
    if (path === '/api/me') return json(route, { success: true, user: { id: userID, username: 'storage-qa', display_name: 'QA de almacenamiento', email: 'qa@test.invalid', role: 'member', is_admin: false, is_super_admin: false, is_active: true, account_id: account, account_name: account === accountA ? 'Cuenta A' : 'Cuenta B', permissions: ['chats', 'settings'] }, accounts: [{ account_id: account, account_name: 'Cuenta de prueba', role: 'member', is_default: true }], account_count: 1 })
    if (path === '/api/auth/refresh') return json(route, { success: true })
    if (path === '/api/version') return json(route, { version: 'qa' })
    if (path === '/api/tasks/stats') return json(route, { success: true, stats: {} })
    if (path === '/api/eros/status') return json(route, { success: true })
    if (path === '/api/storage/usage') {
      const own = records.filter(file => file.object_key.startsWith(account + '/'))
      const used = own.reduce((sum, file) => sum + file.size_bytes, 0)
      const trash = own.filter(file => file.status === 'trash').reduce((sum, file) => sum + file.size_bytes, 0)
      return json(route, { success: true, scope: 'account', used_bytes: used, visible_bytes: used, limit_bytes: 104857600, available_bytes: 104857600 - used, percent_used: used / 1048576, object_count: own.length, by_type: { document: used }, by_origin: { chats: used }, removable_bytes: used - trash, removable_count: own.filter(file => file.status === 'active').length, trash_bytes: trash, can_manage: options.canManage !== false, retention_days: 7 })
    }
    if (path === '/api/storage/files') {
      calls.files.push(url.search)
      if (failFiles) { failFiles = false; return json(route, { success: false, error: 'No se pudieron cargar los archivos de prueba.' }, 503) }
      const offset = Number(url.searchParams.get('offset') || 0); const limit = Number(url.searchParams.get('limit') || 40)
      const query = (url.searchParams.get('q') || '').toLocaleLowerCase()
      const status = url.searchParams.get('status') || 'all'
      const all = records.filter(file => file.object_key.startsWith(account + '/') && file.status === (status === 'trash' ? 'trash' : 'active') && file.filename.toLocaleLowerCase().includes(query))
      return json(route, { success: true, files: all.slice(offset, offset + limit), total: all.length, offset, limit, next_offset: Math.min(offset + limit, all.length), has_more: offset + limit < all.length, can_manage: options.canManage !== false })
    }
    if (path === '/api/storage/cleanup/preview' && method === 'POST') {
      const body = route.request().postDataJSON() as { action: StorageAction; object_keys: string[] }
      calls.previews.push(body)
      const selected = records.filter(file => body.object_keys.includes(file.object_key))
      const preview: StorageReview = { success: true, preview_id: `preview-${calls.previews.length}`, action: body.action, expires_at: new Date(Date.now() + (options.previewExpired ? -1000 : 300000)).toISOString(), eligible_count: selected.length, estimated_bytes: body.action === 'purge' ? selected.reduce((sum, file) => sum + file.size_bytes, 0) : 0, items: selected.map(file => ({ object_key: file.object_key, filename: file.filename, size_bytes: file.size_bytes, eligible: true })) }
      previews.set(preview.preview_id, preview)
      return json(route, preview)
    }
    if (path === '/api/storage/cleanup/confirm' && method === 'POST') {
      const body = route.request().postDataJSON() as { preview_id: string }; calls.confirms.push(body)
      const preview = previews.get(body.preview_id)!
      if (failConfirm === 'conflict') { failConfirm = undefined; return json(route, { success: false, error: 'Los archivos cambiaron. Revisa nuevamente la selección.', code: 'storage_preview_changed' }, 409) }
      if (failConfirm === 'network') { failConfirm = undefined; return route.abort('failed') }
      const partial = failConfirm === 'partial'; failConfirm = undefined
      const items = preview.items.map((file, index) => ({ object_key: file.object_key, filename: file.filename, status: partial && index === 1 ? 'failed' : 'completed', ...(partial && index === 1 ? { reason: 'No se pudo procesar este archivo. Puedes reintentarlo.' } : {}) }))
      for (const item of items.filter(item => item.status === 'completed')) {
        const file = records.find(file => file.object_key === item.object_key)!
        file.status = preview.action === 'trash' ? 'trash' : 'active'; file.can_restore = true; file.can_purge = false
        file.trash_at = new Date().toISOString(); file.purge_after = new Date(Date.now() + 7 * 86400000).toISOString()
      }
      return json(route, { success: true, status: partial ? 'partial' : 'completed', action: preview.action, operation_id: body.preview_id, items, freed_bytes: 0, retained_bytes: preview.items.reduce((sum, file) => sum + file.size_bytes, 0) })
    }
    if (path === '/api/storage/activity') return json(route, { success: true, operations: [], total: 0, has_more: false })
    if (path === '/api/storage/content') return json(route, { success: false, error: 'Vista previa de prueba no disponible.' }, 503)
    return json(route, { success: true })
  })
  return { calls, records, switchAccount: async () => {
    account = accountB; records.push({ ...makeFile(0, accountB), filename: 'Documento privado de Cuenta B.pdf' })
    await page.evaluate(() => { localStorage.setItem('clarin:auth_scope', 'changing:storage-qa-b'); window.dispatchEvent(new Event('clarin:auth-scope-changed')) })
    await page.evaluate(() => { localStorage.setItem('clarin:auth_scope', 'active:storage-qa-b'); window.dispatchEvent(new Event('clarin:auth-scope-changed')) })
  } }
}

async function openStorage(page: Page) {
  await page.goto(`${baseURL}/dashboard/storage`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'Almacenamiento', exact: true })).toBeVisible()
}

test('UI: geometría sin desborde y acciones táctiles con nombres largos', async ({ page }, testInfo) => {
  await installStorageUI(page, { longFilename: true }); await openStorage(page)
  await expect(page.getByText(/Documento con un nombre extremadamente largo/)).toBeVisible()
  for (const width of [320, 375, 768, 1024, 1280, 1440]) {
    await page.setViewportSize({ width, height: width < 500 ? 740 : 900 })
    const primary = page.getByRole('button', { name: 'Revisar archivos', exact: true })
    await expect(primary).toBeVisible()
    if (width < 1024) await expect.poll(() => page.locator('aside').first().evaluate(node => node.getBoundingClientRect().right)).toBeLessThanOrEqual(1)
    const heading = page.getByRole('heading', { name: 'Almacenamiento', exact: true })
    await expect.poll(() => heading.evaluate(node => { const r = node.getBoundingClientRect(); return document.elementFromPoint(r.left + 5, r.top + r.height / 2)?.closest('h1') === node })).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `horizontal overflow at ${width}px`).toBeLessThanOrEqual(0)
    expect((await primary.boundingBox())?.height || 0).toBeGreaterThanOrEqual(44)
    if (width === 320 || width === 1440) await page.screenshot({ path: testInfo.outputPath(`storage-${width}.png`), fullPage: true })
  }
})

test('UI: permite acceder a archivos posteriores al 200 sin perder navegación', async ({ page }) => {
  const mock = await installStorageUI(page, { count: 205 }); await openStorage(page)
  for (let index = 0; index < 5; index++) await page.getByRole('button', { name: /siguiente/i }).click()
  await expect(page.getByText('Documento 205.pdf', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /siguiente/i })).toBeDisabled()
  expect(mock.calls.files.some(query => new URLSearchParams(query).get('offset') === '200')).toBe(true)
})

test('UI: revisión no muta, Escape devuelve foco y confirmar envía una operación', async ({ page }) => {
  const mock = await installStorageUI(page); await openStorage(page)
  await page.getByRole('checkbox', { name: 'Seleccionar Documento 001.pdf', exact: true }).check()
  const trigger = page.getByRole('button', { name: 'Revisar selección', exact: true })
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: 'Revisar eliminación', exact: true })
  await expect(dialog).toBeVisible(); expect(mock.calls.confirms).toHaveLength(0)
  await page.keyboard.press('Escape'); await expect(dialog).toBeHidden(); await expect(trigger).toBeFocused()
  await trigger.press('Enter'); await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Mover a la papelera', exact: true }).click()
  await expect(page.getByText(/1 archivo en la papelera/)).toBeVisible()
  expect(mock.calls.confirms).toHaveLength(1)
  expect(Object.keys(mock.calls.confirms[0])).toEqual(['preview_id'])
  await expect(page.getByText(/Todavía no se ha liberado espacio/)).toBeVisible()
})

test('UI: fallo parcial conserva solo la selección pendiente', async ({ page }) => {
  const mock = await installStorageUI(page, { confirmMode: 'partial' }); await openStorage(page)
  await page.getByRole('checkbox', { name: 'Seleccionar Documento 001.pdf', exact: true }).check()
  await page.getByRole('checkbox', { name: 'Seleccionar Documento 002.pdf', exact: true }).check()
  await page.getByRole('button', { name: 'Revisar selección', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Mover a la papelera', exact: true }).click()
  await expect(page.getByText(/1 no se pudieron procesar/)).toBeVisible()
  await expect(page.getByRole('checkbox', { name: 'Seleccionar Documento 002.pdf', exact: true })).toBeChecked()
  await page.getByRole('button', { name: 'Revisar selección', exact: true }).click()
  expect(mock.calls.previews.at(-1)?.object_keys).toEqual([mock.records[1].object_key])
})

test('UI: conflicto invalida revisión y conserva selección para revisar de nuevo', async ({ page }) => {
  const mock = await installStorageUI(page, { confirmMode: 'conflict' }); await openStorage(page)
  await page.getByRole('checkbox', { name: 'Seleccionar Documento 001.pdf', exact: true }).check()
  await page.getByRole('button', { name: 'Revisar selección', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Mover a la papelera', exact: true }).click()
  await expect(page.getByText(/Los archivos cambiaron/)).toBeVisible()
  expect(mock.calls.confirms).toHaveLength(1)
  await expect(page.getByRole('checkbox', { name: 'Seleccionar Documento 001.pdf', exact: true })).toBeChecked()
})

test('UI: revisión vencida bloquea confirmación', async ({ page }) => {
  const mock = await installStorageUI(page, { previewExpired: true }); await openStorage(page)
  await page.getByRole('checkbox', { name: 'Seleccionar Documento 001.pdf', exact: true }).check()
  await page.getByRole('button', { name: 'Revisar selección', exact: true }).click()
  await expect(page.getByRole('dialog').getByText('La revisión venció. Vuelve a comprobar los archivos antes de confirmar.')).toBeVisible()
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Mover a la papelera', exact: true })).toHaveCount(0)
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Volver a revisar', exact: true })).toBeEnabled()
  expect(mock.calls.confirms).toHaveLength(0)
})

test('UI: fallo de carga tiene recuperación y no se presenta como inventario vacío', async ({ page }) => {
  await installStorageUI(page, { firstFilesFail: true }); await openStorage(page)
  await expect(page.getByText('No se pudieron cargar los archivos de prueba.')).toBeVisible()
  await page.getByRole('button', { name: 'Reintentar', exact: true }).click()
  await expect(page.getByText('Documento 001.pdf', { exact: true })).toBeVisible()
})

test('UI: permiso de lectura no permite gestionar ni seleccionar', async ({ page }) => {
  const mock = await installStorageUI(page, { canManage: false }); await openStorage(page)
  await expect(page.getByRole('checkbox', { name: 'Seleccionar Documento 001.pdf', exact: true })).toHaveCount(0)
  expect(mock.calls.previews).toHaveLength(0); expect(mock.calls.confirms).toHaveLength(0)
})

test('UI: cambio de cuenta destruye revisión, selección y contenido anterior', async ({ page }) => {
  const mock = await installStorageUI(page); await openStorage(page)
  await page.getByRole('checkbox', { name: 'Seleccionar Documento 001.pdf', exact: true }).check()
  await page.getByRole('button', { name: 'Revisar selección', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Revisar eliminación', exact: true })).toBeVisible()
  await mock.switchAccount()
  await expect(page.getByRole('dialog', { name: 'Revisar eliminación', exact: true })).toBeHidden()
  await expect(page.getByText('Documento 001.pdf', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Documento privado de Cuenta B.pdf', { exact: true })).toBeVisible()
  expect(mock.calls.confirms).toHaveLength(0)
})

test('UI: diálogo móvil conserva acciones y captura teclado sin escapar al fondo', async ({ page }, testInfo) => {
  await installStorageUI(page); await page.setViewportSize({ width: 320, height: 568 }); await openStorage(page)
  const checkbox = page.getByRole('checkbox', { name: 'Seleccionar Documento 001.pdf', exact: true })
  await checkbox.focus(); await page.keyboard.press('Space')
  await page.getByRole('button', { name: 'Revisar selección', exact: true }).press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Revisar eliminación', exact: true })
  await expect(dialog).toBeVisible()
  for (let index = 0; index < 12; index++) {
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate(node => node.contains(document.activeElement)), `Tab ${index} escaped modal`).toBe(true)
  }
  const bounds = await dialog.boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320)
  expect(bounds!.y).toBeGreaterThanOrEqual(0); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(568)
  const confirm = dialog.getByRole('button', { name: 'Mover a la papelera', exact: true })
  await expect(confirm).toBeVisible(); expect((await confirm.boundingBox())?.height || 0).toBeGreaterThanOrEqual(44)
  await page.screenshot({ path: testInfo.outputPath('storage-review-320.png') })
  await page.keyboard.press('Escape'); await expect(dialog).toBeHidden()
})

test('UI: papelera permite restaurar y reconcilia inventario sin recargar', async ({ page }) => {
  const mock = await installStorageUI(page); await openStorage(page)
  await page.getByRole('checkbox', { name: 'Seleccionar Documento 001.pdf', exact: true }).check()
  await page.getByRole('button', { name: 'Revisar selección', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Mover a la papelera', exact: true }).click()
  await page.getByRole('tab', { name: /Papelera/ }).click()
  await page.getByRole('checkbox', { name: 'Seleccionar Documento 001.pdf', exact: true }).check()
  await page.getByRole('button', { name: 'Restaurar', exact: true }).click()
  await page.getByRole('dialog', { name: 'Revisar restauración', exact: true }).getByRole('button', { name: 'Restaurar archivos', exact: true }).click()
  await expect(page.getByText(/1 archivo restaurado/)).toBeVisible()
  await page.getByRole('tab', { name: /Archivos/ }).click()
  await expect(page.getByText('Documento 001.pdf', { exact: true })).toBeVisible()
  expect(mock.calls.previews.map(preview => preview.action)).toEqual(['trash', 'restore'])
})


function wavFixture(): Buffer {
  const samples = 2400; const pcm = Buffer.alloc(44 + samples * 2)
  pcm.write('RIFF', 0); pcm.writeUInt32LE(pcm.length - 8, 4); pcm.write('WAVEfmt ', 8)
  pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22)
  pcm.writeUInt32LE(8000, 24); pcm.writeUInt32LE(16000, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34)
  pcm.write('data', 36); pcm.writeUInt32LE(samples * 2, 40)
  return pcm
}
const renderedMedia = [
  { type: 'image' as const, filename: 'foto.png', mime: 'image/png', bytes: () => Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGUlEQVR4nGNkWFHBQApgIkn1qIZRDUNKAwCjhQFAyVwhKgAAAABJRU5ErkJggg==', 'base64') },
  { type: 'audio' as const, filename: 'audio.wav', mime: 'audio/wav', bytes: wavFixture },
  { type: 'video' as const, filename: 'video.webm', mime: 'video/webm', bytes: () => readFileSync(join(__dirname, 'fixtures/storage/preview.webm')) },
]
for (const media of renderedMedia) test(`UI: vista previa real ${media.type} decodifica bytes y se cierra sin contenido residual`, async ({ page }) => {
  const mock = await installStorageUI(page, { count: 1 })
  const bytes = media.bytes(); Object.assign(mock.records[0], { filename: media.filename, media_type: media.type, size_bytes: bytes.length })
  await page.route(url => url.pathname === '/api/storage/content', route => route.fulfill({ status: 200, contentType: media.mime, body: bytes }))
  await openStorage(page); await page.getByRole('button', { name: media.filename, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: media.filename, exact: true }); await expect(dialog).toBeVisible()
  const element = dialog.locator(media.type === 'image' ? 'img' : media.type)
  await expect(element).toBeVisible()
  if (media.type === 'image') await expect.poll(() => element.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  else await expect.poll(() => element.evaluate(node => (node as HTMLMediaElement).readyState)).toBeGreaterThanOrEqual(1)
  await expect(element).toHaveAttribute('src', /^blob:/)
  await dialog.getByRole('button', { name: 'Cerrar', exact: true }).click(); await expect(dialog).toBeHidden()
  await expect(page.locator('audio,video')).toHaveCount(0)
})

test('UI: PDF real se renderiza con PDF.js y vuelve a detalles al cerrar', async ({ page }, testInfo) => {
  test.setTimeout(90000)
  const mock = await installStorageUI(page, { count: 1 }); const bytes = readFileSync(join(__dirname, 'fixtures/storage/preview.pdf'))
  mock.records[0].size_bytes = bytes.length
  await page.route(url => url.pathname === '/api/storage/content', route => route.fulfill({ status: 200, contentType: 'application/pdf', body: bytes }))
  await openStorage(page); await page.getByRole('button', { name: 'Documento 001.pdf', exact: true }).click()
  await page.getByRole('button', { name: 'Abrir vista previa', exact: true }).click()
  const viewer = page.getByRole('dialog', { name: 'Vista previa de Documento 001.pdf', exact: true })
  await expect(viewer).toBeVisible()
  const canvas = viewer.locator('canvas')
  await expect.poll(() => canvas.evaluate(node => { const c = node as HTMLCanvasElement; return c.width * c.height }), { timeout: 40000 }).toBeGreaterThan(0)
  // A nonempty canvas alone may still be blank. The PDF has a green rectangle:
  // prove the actual content was painted, independently of plugin availability.
  await expect.poll(() => canvas.evaluate(node => { const c = node as HTMLCanvasElement; const pixels = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data; let green = 0; for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 1] > pixels[i] + 50 && pixels[i + 1] > pixels[i + 2] + 20) green++; return green }), { timeout: 40000 }).toBeGreaterThan(100)
  await page.screenshot({ path: testInfo.outputPath('storage-pdf-rendered.png') })
  await page.getByRole('button', { name: 'Cerrar visor PDF', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Documento 001.pdf', exact: true })).toBeVisible()
  await expect(page.locator('canvas')).toHaveCount(0)
})

test('UI: fallo de vista previa informa y permite reintentar sin ventana vacía', async ({ page }) => {
  const mock = await installStorageUI(page, { count: 1 }); Object.assign(mock.records[0], { filename: 'video-error.webm', media_type: 'video' })
  await openStorage(page); await page.getByRole('button', { name: 'video-error.webm', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'video-error.webm', exact: true })
  await expect(dialog.getByRole('alert')).toContainText('Vista previa de prueba no disponible.')
  await expect(dialog.getByRole('button', { name: 'Reintentar', exact: true })).toBeEnabled()
  await expect(dialog.locator('video')).toHaveCount(0)
})
