import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { expect, test } from '@playwright/test'
import {
  authenticateLab, canonicalContactImage, contactContexts, contextQuery, expectInViewport, expectNoHorizontalOverflow,
  integrityWidths, labRequest, openContactContext, openPhotoEditor, readIntegrityLab, syntheticPhoto,
} from './helpers/integrity-qa'

const lab = readIntegrityLab()
test.describe('Contact identity integrity on the isolated real API', () => {
  test.describe.configure({ mode: 'default' })
  test.skip(!lab, 'Requires .runtime/qa-lab-credentials.json for the disposable synthetic QA laboratory.')
  test.setTimeout(240_000)
  test.beforeEach(async ({ page }) => { await authenticateLab(page, lab!) })

  test('a Contact deep link opens its canonical surface during a fresh authenticated entry', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 900 })
    const profile = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === `/api/contact-profiles/${lab!.fixture.contact_id}` && url.searchParams.get('context_type') === 'contact' && response.ok()
    }, { timeout: 30_000 })
    await page.goto(`${lab!.base_url}/dashboard/contacts?contact_id=${lab!.fixture.contact_id}`, { waitUntil: 'commit' })
    expect((await (await profile).json()).contact.id).toBe(lab!.fixture.contact_id)
    await expect(page.getByRole('button', { name: 'Gestionar foto del contacto', exact: true })).toBeVisible()
  })

  for (const width of integrityWidths) {
    test(`canonical photo controls remain usable in all five contexts at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 })
      for (const type of contactContexts) {
        await test.step(type, async () => {
          await openContactContext(page, lab!, type)
          await expectNoHorizontalOverflow(page)
          const trigger = page.getByRole('button', { name: 'Gestionar foto del contacto', exact: true })
          await trigger.focus()
          await page.keyboard.press('Enter')
          const menu = page.getByRole('menu', { name: 'Opciones de foto del contacto', exact: true })
          await expectInViewport(page, menu)
          await page.keyboard.press('End')
          await expect(menu.getByRole('menuitem').last()).toBeFocused()
          await page.keyboard.press('Home')
          await expect(menu.getByRole('menuitem').first()).toBeFocused()
          await page.keyboard.press('Escape')
          await expect(menu).toBeHidden()
          await expect(trigger).toBeFocused()
          const editor = await openPhotoEditor(page)
          await expectInViewport(page, editor.locator('> div'))
          const closeEditor = editor.getByRole('button', { name: 'Cerrar', exact: true })
          await closeEditor.focus()
          await page.keyboard.press('Shift+Tab')
          await expect(editor.getByRole('button', { name: 'Guardar foto', exact: true })).toBeFocused()
          await page.keyboard.press('Tab')
          await expect(closeEditor).toBeFocused()
          await editor.getByRole('button', { name: 'Girar', exact: true }).click()
          await editor.getByRole('button', { name: 'Deshacer', exact: true }).click()
          await editor.getByRole('button', { name: 'Cancelar', exact: true }).focus()
          await page.keyboard.press('Enter')
          await expect(editor).toBeHidden()
          await expect(trigger).toBeFocused()
          await expectNoHorizontalOverflow(page)
          await page.screenshot({ path: testInfo.outputPath(`contact-${type}-${width}.png`) })
        })
      }
    })
  }

  test('saving a real photo from each context reconciles the same Contact and all canonical revisions', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    const uploadHashes = new Set<string>()
    for (const type of contactContexts) {
      await openContactContext(page, lab!, type)
      const before = await labRequest(page, lab!, `/api/contact-avatars/${lab!.fixture.contact_id}?${contextQuery(lab!, type)}`)
      const photo = await syntheticPhoto(page, contactContexts.indexOf(type) + 1)
      const hash = createHash('sha256').update(photo.buffer).digest('hex')
      expect(uploadHashes.has(hash), 'Every context must edit distinct pixels, rather than idempotently upload the same photo').toBe(false)
      uploadHashes.add(hash)
      const editor = await openPhotoEditor(page, photo)
      await editor.getByRole('button', { name: 'Horizontal', exact: true }).click()
      const savedResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/contact-avatars/${lab!.fixture.contact_id}/upload` && response.request().method() === 'POST')
      await editor.getByRole('button', { name: 'Guardar foto', exact: true }).click()
      const response = await savedResponse
      expect(response.ok()).toBeTruthy()
      const saved = await response.json()
      expect(saved.success).toBe(true)
      expect(saved.avatar.revision).toBeGreaterThan(before.avatar.revision)
      expect(saved.avatar.avatar_url).toBeTruthy()
      await expect(editor).toBeHidden()
      const image = canonicalContactImage(page, lab!)
      await expect(image).toHaveAttribute('src', saved.avatar.avatar_url)
      await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
      for (const other of contactContexts) {
        const canonical = await labRequest(page, lab!, `/api/contact-avatars/${lab!.fixture.contact_id}?${contextQuery(lab!, other)}`)
        expect(canonical.avatar.contact_id).toBe(lab!.fixture.contact_id)
        expect(canonical.avatar.revision).toBe(saved.avatar.revision)
        expect(canonical.avatar.avatar_url).toBe(saved.avatar.avatar_url)
      }
    }
  })

  test('a real avatar mutation reaches another mounted context through the account WebSocket', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    const observer = await page.context().newPage()
    await observer.setViewportSize({ width: 1280, height: 900 })
    let contactEventReceived = false
    observer.on('websocket', socket => {
      expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(socket.url()).hostname)
      socket.on('framereceived', frame => {
        try {
          const event = JSON.parse(String(frame.payload))
          if (event.event === 'contact_update' && event.data?.contact_id === lab!.fixture.contact_id) contactEventReceived = true
        } catch { /* Binary transport frames are not product events. */ }
      })
    })
    try {
      await openContactContext(observer, lab!, 'lead')
      await openContactContext(page, lab!, 'contact')
      await expect.poll(async () => {
        const health = await observer.request.get(`${lab!.api_url || lab!.base_url}/health`)
        return health.ok() ? (await health.json()).websocket?.clients || 0 : 0
      }, { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
      const editor = await openPhotoEditor(page)
      const savedResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/contact-avatars/${lab!.fixture.contact_id}/upload` && response.request().method() === 'POST')
      await editor.getByRole('button', { name: 'Guardar foto', exact: true }).click()
      const saved = await (await savedResponse).json()
      expect(saved.success).toBe(true)
      await expect.poll(() => contactEventReceived).toBe(true)
      await expect(canonicalContactImage(observer, lab!)).toHaveAttribute('src', saved.avatar.avatar_url)
    } finally { await observer.close() }
  })

  test('a WhatsApp preview and cancellation keep the existing canonical photo', async ({ page }) => {
    await openContactContext(page, lab!, 'contact')
    const path = `/api/contact-avatars/${lab!.fixture.contact_id}?${contextQuery(lab!, 'contact')}`
    let before = await labRequest(page, lab!, path)
    if (!before.avatar.avatar_url) {
      const editor = await openPhotoEditor(page)
      const saved = page.waitForResponse(response => new URL(response.url()).pathname === `/api/contact-avatars/${lab!.fixture.contact_id}/upload` && response.request().method() === 'POST' && response.ok())
      await editor.getByRole('button', { name: 'Guardar foto', exact: true }).click()
      await saved
      await expect(editor).toBeHidden()
      before = await labRequest(page, lab!, path)
    }
    expect(before.avatar.avatar_url).toBeTruthy()
    await page.getByRole('button', { name: 'Gestionar foto del contacto', exact: true }).click()
    const preview = page.waitForResponse(response => new URL(response.url()).pathname === `/api/contact-avatars/${lab!.fixture.contact_id}/whatsapp-preview` && response.request().method() === 'POST')
    await page.getByRole('menuitem', { name: 'Actualizar desde WhatsApp', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Gestionar foto del contacto', exact: true })
    await expect(dialog.getByRole('heading', { name: 'Comparar con WhatsApp', exact: true })).toBeVisible()
    // The isolated lab deliberately has no live WhatsApp session. Its real
    // rejection must still leave the manual picture intact and cancellable.
    const rejected = await preview
    expect(rejected.status()).toBeGreaterThanOrEqual(400)
    await expect(dialog.getByRole('button', { name: 'Usar esta foto', exact: true })).toBeDisabled()
    await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click()
    expect((await labRequest(page, lab!, path)).avatar).toEqual(before.avatar)
  })

  test('general history loads beyond 200 through bounded cursors and keeps an older note editable', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    const profile = await openContactContext(page, lab!, 'contact')
    expect(profile.observation_count, 'Seed at least 205 synthetic observations').toBeGreaterThan(200)
    const cursors: string[] = []
    page.on('request', request => {
      const url = new URL(request.url())
      if (url.pathname === `/api/contact-profiles/${lab!.fixture.contact_id}/observations` && request.method() === 'GET') {
        expect(Number(url.searchParams.get('limit'))).toBeLessThanOrEqual(50)
        cursors.push(url.searchParams.get('cursor') || '')
      }
    })
    const history = page.getByRole('button', { name: /Historial general del contacto/ })
    expect(await history.getAttribute('aria-expanded')).toBe('false')
    expect(cursors).toHaveLength(0)
    await history.click()
    const region = page.locator('#crm-contact-history-content')
    await expect(region.locator('article').first()).toBeVisible()
    for (let i = 0; i < 100; i++) {
      const more = region.getByRole('button', { name: 'Mostrar más', exact: true })
      if (!await more.count()) break
      await more.click()
      await expect(region.getByRole('button', { name: 'Cargando…', exact: true })).toHaveCount(0)
    }
    await expect(region.locator('article')).toHaveCount(profile.observation_count)
    expect(cursors.filter(Boolean).length).toBeGreaterThanOrEqual(4)
    expect(new Set(cursors).size).toBe(cursors.length)
    const editable = region.locator('article').filter({ has: page.getByRole('button', { name: 'Editar nota', exact: true }) }).last()
    const oldIndex = await editable.evaluate(article => Array.from(article.parentElement!.children).indexOf(article))
    const old = region.locator('article').nth(oldIndex)
    const original = await old.locator('p').first().innerText()
    const replacement = `${original}\nRevisión QA sintética: áéíóú 日本語`
    await old.getByRole('button', { name: 'Editar nota', exact: true }).click()
    await old.locator('textarea').fill(replacement)
    const editedResponse = page.waitForResponse(response => response.request().method() === 'PATCH' && /\/observations\/[^/]+$/.test(new URL(response.url()).pathname))
    await old.getByRole('button', { name: 'Guardar', exact: true }).click()
    const edited = await (await editedResponse).json()
    try {
      expect(edited.success).toBe(true)
      expect(edited.observation.notes).toBe(replacement)
      await expect(region.getByText(replacement, { exact: true })).toBeVisible()
    } finally {
      // Restore only this synthetic note; avoid changing the shared seed.
      if (edited.observation?.id) await labRequest(page, lab!, `/api/contact-profiles/${lab!.fixture.contact_id}/observations/${edited.observation.id}?${contextQuery(lab!, 'contact')}`, { method: 'PATCH', data: { notes: original, expected_updated_at: edited.observation.updated_at } })
    }
  })

  test('filtered contact CSV is generated from the applied real search and preserves Unicode', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 900 })
    await page.goto(`${lab!.base_url}/dashboard/contacts`, { waitUntil: 'commit' })
    const search = page.getByPlaceholder('Buscar por nombre, teléfono, email...')
    const searched = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/contacts' && url.searchParams.get('search') === lab!.fixture.contact_name && response.ok()
    })
    await search.fill(lab!.fixture.contact_name)
    await searched
    await page.getByRole('button', { name: /Abrir filtros y orden/ }).click()
    await page.getByRole('button', { name: 'Aplicar', exact: true }).click()
    await page.getByTitle('Más acciones', { exact: true }).click()
    await page.getByRole('button', { name: 'Exportar contactos', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Exportar Contactos', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'CSV', exact: true }).click()
    await page.getByText(/^Solo filtrados \(/).click()
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Exportar', exact: true }).click()
    const file = await download
    expect(file.suggestedFilename()).toMatch(/\.csv$/)
    const contents = await readFile((await file.path())!, 'utf8')
    expect(contents).toContain(lab!.fixture.contact_name)
    const canonical = await labRequest(page, lab!, `/api/contacts?search=${encodeURIComponent(lab!.fixture.contact_name)}&limit=200&offset=0`)
    const rows = canonical.contacts || canonical.data || []
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(contents).toContain(row.name || row.custom_name || row.phone)
    await expectNoHorizontalOverflow(page)
  })
})
