import { expect, test, type Page, type WebSocketRoute } from '@playwright/test'

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3011'
const now = '2026-09-21T12:00:00.000Z'
const device = { id: 'device-qa', name: 'Canal QA', status: 'connected', provider: 'whatsapp_web', runtime_capabilities: { can_start_chat: true, can_check_whatsapp: true, can_send_reaction: true, can_send_sticker: true } }
const sampleReply = { id: '10000000-0000-4000-8000-000000000001', shortcut: 'bienvenida', title: 'Bienvenida personal', body: 'Hola\n\nGracias', updated_at: now, attachments: [{ id: '20000000-0000-4000-8000-000000000001', media_asset_id: '30000000-0000-4000-8000-000000000001', media_url: '/whatsapp-chat-background.png', media_type: 'image', media_filename: 'bienvenida.png', caption: '*Tu reserva está lista* 😊\nTe esperamos.', position: 0 }], items: [{ id: '40000000-0000-4000-8000-000000000001', type: 'text', text: 'Hola' }, { id: '40000000-0000-4000-8000-000000000002', type: 'media', attachment_id: '20000000-0000-4000-8000-000000000001' }, { id: '40000000-0000-4000-8000-000000000003', type: 'text', text: 'Gracias' }] }

async function fixture(page: Page) {
  page.on('pageerror', error => console.log('QA page error:', error.message))
  page.on('console', message => { if (message.type() === 'error') console.log('QA browser:', message.text().slice(0, 400)) })
  // Dev webpack needs eval; this exception exists only in the intercepted QA document.
  await page.route(baseURL + '/dashboard/**', async route => {
    if (route.request().resourceType() !== 'document') return route.continue()
    const response = await route.fetch()
    const headers = response.headers()
    if (headers['content-security-policy']) headers['content-security-policy'] = headers['content-security-policy'].replace("script-src 'self' 'unsafe-inline'", "script-src 'self' 'unsafe-inline' 'unsafe-eval'")
    await route.fulfill({ response, headers })
  })
  let reply = structuredClone(sampleReply)
  const saved: any[] = [], sends: any[] = []
  const chats = [1, 2, 3].map(i => ({ id: `chat-${i}`, jid: `5199900000${i}@s.whatsapp.net`, name: `Contacto QA ${i}`, device_id: device.id, unread_count: 1, needs_reply: true, waiting_since: `2026-09-21T0${i}:00:00.000Z` as string | null, state_version: 1, last_message: `Consulta ${i}`, last_message_at: now }))
  const history = new Map(chats.map(chat => [chat.id, [{ id: `incoming-${chat.id}`, message_id: `incoming-${chat.id}`, body: 'Necesito información', is_from_me: false, is_read: false, status: 'delivered', message_type: 'text', timestamp: now }] as any[]]))
  let socket: WebSocketRoute | undefined
  const emit = (chat: typeof chats[number]) => socket?.send(JSON.stringify({ type: 'chat_update', data: { ...chat, chat_id: chat.id } }))
  let failImage = true
  await page.routeWebSocket('**/ws**', ws => { socket = ws; ws.onMessage(() => undefined) })
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname, method = route.request().method()
    const body = method === 'POST' || method === 'PUT' ? route.request().postDataJSON() : {}
    const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) })
    if (path === '/api/me') return json({ success: true, user: { id: 'advisor-qa', username: 'qa', display_name: 'Asesora QA', role: 'admin', is_admin: true, account_id: 'account-qa', account_name: 'Cuenta QA', permissions: ['chats', 'quick_replies_manage'] }, accounts: [] })
    if (path === '/api/devices') return json({ success: true, devices: [device] })
    if (path === '/api/quick-replies') return json({ success: true, quick_replies: [reply], total: 1, has_more: false, next_cursor: '' })
    if (path === `/api/quick-replies/${reply.id}` && method === 'PUT') { saved.push(body); reply = { ...reply, ...body, updated_at: '2026-09-21T13:00:00Z' }; return json({ success: true, quick_reply: reply }) }
    if (path === '/api/chats') {
      let rows = chats.filter(chat => (!url.searchParams.has('unread_only') || chat.unread_count > 0) && (!url.searchParams.has('pending_only') || chat.needs_reply))
      const total = rows.length
      if (url.searchParams.has('pending_only')) rows = [...rows].sort((a, b) => a.waiting_since!.localeCompare(b.waiting_since!))
      const cursor = url.searchParams.get('cursor')?.split('|')
      if (cursor) rows = rows.filter(chat => chat.waiting_since! > cursor[0] || chat.waiting_since === cursor[0] && chat.id > cursor[1])
      return json({ success: true, chats: rows, total, next_cursor: '' })
    }
    const chat = chats.find(chat => path.startsWith(`/api/chats/${chat.id}`))
    if (chat) {
      if (path.endsWith('/messages')) return json({ success: true, messages: history.get(chat.id), has_more: false })
      if (path.endsWith('/read')) { chat.unread_count = 0; chat.state_version++; emit(chat); return json({ success: true, unread_count: 0, chat_state: { ...chat, chat_id: chat.id } }) }
      if (path.endsWith('/attention')) { chat.unread_count = 0; chat.needs_reply = false; chat.waiting_since = null; chat.state_version++; emit(chat); return json({ success: true, chat_state: { ...chat, chat_id: chat.id } }) }
      return json({ success: true, chat, device })
    }
    if (path === '/api/messages/send') {
      sends.push(body)
      if (body.media_type === 'image' && failImage) { failImage = false; return json({ success: false, error: 'Fallo simulado del segundo bloque' }, 503) }
      const message = { id: `out-${sends.length}`, message_id: `out-${sends.length}`, body: body.body, media_url: body.media_url, media_filename: body.media_filename, message_type: body.media_type || 'text', is_from_me: true, is_read: false, status: 'sent', timestamp: now, sender: { user_id: 'advisor-qa', name: 'Asesora QA', origin: 'quick_reply' } }
      history.get(body.chat_id)!.push(message)
      return json({ success: true, message })
    }
    if (path.includes('/notifications')) return json({ success: true, notifications: [], unread_count: 0, total: 0 })
    return json({ success: true, contacts: [], tags: [], pipelines: [], stages: [], stickers: [], settings: {} })
  })
  await page.context().addCookies([{ name: 'auth-token', value: 'chat-qa-fixture', url: baseURL, httpOnly: true, sameSite: 'Lax' }])
  await page.addInitScript(() => {
    localStorage.setItem('token', 'chat-qa-fixture')
    localStorage.setItem('clarin:last_activity_at', String(Date.now()))
    localStorage.setItem('clarin:auth_refreshed_at', String(Date.now()))
  })
  return { saved, sends, chats, emit }
}

test.describe('Chats and quick replies', () => {
  test.setTimeout(90_000)
  for (const width of [320, 375, 768, 1024, 1280, 1440]) {
    test(`sequence editor preserves caption, order and reachable actions at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      const qa = await fixture(page)
      await page.goto(`${baseURL}/dashboard/settings?tab=quick-replies`)
      await page.addStyleTag({ content: 'nextjs-portal { display: none !important }' })
      await page.screenshot({ path: `test-results/chat-settings-initial-${width}.png` })
      await page.getByRole('button', { name: /bienvenida.*Bienvenida personal/ }).click({ timeout: 15000 })
      await page.getByRole('button', { name: 'Editar', exact: true }).click()
      const caption = page.getByRole('textbox', { name: /Escribe el pie/ })
      await caption.fill('*Confirmado* 😊\nLínea nueva')
      const first = page.getByRole('region', { name: 'Mensaje 1', exact: true })
      await first.getByRole('button', { name: 'Bajar mensaje' }).click()
      await expect(page.getByRole('region', { name: 'Mensaje 1', exact: true }).getByRole('textbox', { name: /Escribe el pie/ })).toContainText('Confirmado')
      if (width === 1440) {
        await first.scrollIntoViewIfNeeded()
        const handle = page.getByRole('button', { name: 'Ordenar mensaje 1', exact: true })
        await handle.focus()
        await page.keyboard.press('Space')
        await expect(handle).toHaveAttribute('aria-pressed', 'true')
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
        await page.keyboard.press('ArrowDown')
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
        await page.keyboard.press('Space')
        const moved = page.getByRole('region', { name: 'Mensaje 2', exact: true })
        await expect(moved.getByRole('textbox', { name: /Escribe el pie/ })).toContainText('Confirmado')
        await moved.getByRole('button', { name: 'Subir mensaje' }).click()
      }
      const save = page.getByRole('button', { name: 'Guardar', exact: true })
      await expect(save).toBeInViewport()
      await expect(page.getByRole('heading', { name: 'Editar /bienvenida', exact: true })).toBeInViewport()
      await page.screenshot({ path: `test-results/chat-quick-editor-${width}.png` })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await save.click()
      await expect.poll(() => qa.saved.length).toBe(1)
      expect(qa.saved[0].items[0].type).toBe('media')
      expect(qa.saved[0].attachments[0].caption).toBe('*Confirmado* 😊\nLínea nueva')
      expect(qa.saved[0].body).toBe('Hola\n\nGracias')
    })
  }

  test('unread removal, stable attention, prepared sequence, retry and next preserve the workflow', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 950 })
    const qa = await fixture(page)
    await page.goto(`${baseURL}/dashboard/chats`)
    await page.addStyleTag({ content: 'nextjs-portal { display: none !important }' })
    await page.getByRole('button', { name: 'No leídos', exact: true }).click()
    await page.getByRole('button', { name: 'Conversación con Contacto QA 1', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Conversación con Contacto QA 1', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Pendientes', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Conversación con Contacto QA 1', exact: true })).toBeVisible()
    const composer = page.getByRole('textbox', { name: 'Escribe un mensaje…', exact: true })
    await composer.fill('/bien')
    await page.getByRole('option', { name: /bienvenida/ }).click()
    expect(qa.sends).toHaveLength(0)
    await page.getByRole('button', { name: 'Enviar respuesta rápida preparada' }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'Fallo simulado' })).toBeVisible()
    expect(qa.sends).toHaveLength(2)
    expect(qa.chats[0].needs_reply).toBe(true)
    await page.getByRole('button', { name: 'Enviar respuesta rápida preparada' }).click()
    await expect.poll(() => qa.sends.length).toBe(4)
    expect(qa.sends.map(send => send.body)).toEqual(['Hola', sampleReply.attachments[0].caption, sampleReply.attachments[0].caption, 'Gracias'])
    expect(qa.sends[1].client_operation_id).toBe(qa.sends[2].client_operation_id)
    await expect(page.getByRole('button', { name: 'Conversación con Contacto QA 1', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Ver detalles de la conversación', exact: true }).getByRole('heading', { name: 'Contacto QA 1', exact: true })).toBeVisible()
    await composer.fill('Borrador que conservar')
    await page.getByRole('button', { name: 'Siguiente pendiente →' }).click()
    await expect(page.getByRole('button', { name: 'Ver detalles de la conversación', exact: true }).getByRole('heading', { name: 'Contacto QA 2', exact: true })).toBeVisible()
    await composer.fill('Borrador del segundo')
    await page.getByRole('button', { name: 'Conversación con Contacto QA 3', exact: true }).click()
    await page.getByRole('button', { name: 'Conversación con Contacto QA 2', exact: true }).click()
    await expect(composer).toHaveText('Borrador del segundo')
    await page.screenshot({ path: 'test-results/chat-attention-queue.png' })
    await page.getByRole('button', { name: 'No requiere respuesta', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Conversación con Contacto QA 2', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Todos', exact: true }).click()
    await page.getByRole('button', { name: 'Conversación con Contacto QA 1', exact: true }).click()
    await expect(composer).toHaveText('Borrador que conservar')
    await page.getByRole('button', { name: 'Más acciones del mensaje', exact: true }).last().focus()
    await page.getByRole('button', { name: 'Más acciones del mensaje', exact: true }).last().click()
    await page.getByRole('menuitem', { name: 'Información', exact: true }).click()
    const info = page.getByRole('dialog', { name: 'Información del mensaje', exact: true })
    await expect(info.getByText('Asesora QA', { exact: true })).toBeVisible()
    await expect(info.getByText('Respuesta rápida', { exact: true })).toBeVisible()
    await page.screenshot({ path: 'test-results/chat-message-author.png' })
    await page.keyboard.press('Escape')
    await expect(info).toHaveCount(0)
  })
})
