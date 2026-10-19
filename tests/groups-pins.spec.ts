import { expect, test, type Page, type WebSocketRoute } from '@playwright/test'
import { writeFile } from 'node:fs/promises'

test.setTimeout(90_000)
test.beforeEach(async ({ page }, testInfo) => {
  page.on('pageerror', error => { void testInfo.attach('pageerror', { body: error.stack || error.message, contentType: 'text/plain' }) })
  page.on('requestfailed', request => { void testInfo.attach('requestfailed', { body: new URL(request.url()).pathname + ' ' + (request.failure()?.errorText || ''), contentType: 'text/plain' }) })
  page.on('console', message => { if (message.type() === 'error') void testInfo.attach('console-error', { body: message.text(), contentType: 'text/plain' }) })
})

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3011'
const now = '2026-10-18T12:00:00Z'
const capabilities = { can_start_chat: true, can_check_whatsapp: true, can_send_sticker: true, can_send_animated_sticker: true, can_send_reaction: true, can_publish_status: true, can_sync_own_status: true, can_list_groups: true, can_send_group_messages: true }
const device = { id: 'device-qa', name: 'Número de prueba', phone: '51900000001', status: 'connected', provider: 'whatsapp_web', runtime_capabilities: capabilities }
const group = { subject: 'Equipo de coordinación', description: 'Coordinación y acuerdos del equipo.', participant_count: 3, membership_status: 'member', announce: false, can_send: true, synced_at: now, kind: 'group' }
const initialChats: any[] = [
  { id: 'direct-qa', kind: 'direct', device_id: device.id, device_name: device.name, jid: '51900000009@s.whatsapp.net', name: 'Contacto individual', contact_name: 'Contacto individual', contact_phone: '51900000009', last_message: 'Mensaje individual', last_message_at: '2026-10-18T13:00:00Z', unread_count: 0, is_pinned: false, pin_version: 0 },
  { id: 'group-qa', kind: 'group', device_id: device.id, device_name: device.name, jid: '12000000000@g.us', name: group.subject, group, last_message: 'Confirmamos la reunión', last_message_from_name: 'María León', last_message_from_me: false, last_message_at: now, unread_count: 2, is_pinned: false, pin_version: 0 },
]
const members = [{ jid: '51900000002@s.whatsapp.net', name: 'María León', phone: '51900000002', role: 'admin', is_self: false }, { jid: '1234567890@lid', name: 'José Ríos', role: 'member', is_self: false }, { jid: '51900000001@s.whatsapp.net', name: 'Número de prueba', role: 'member', is_self: true }]
const incoming = { id: 'message-in', message_id: 'wa-in', chat_id: 'group-qa', device_id: device.id, from_jid: members[0].jid, from_name: members[0].name, body: 'Confirmamos la reunión', message_type: 'text', is_from_me: false, is_read: false, status: 'delivered', timestamp: now, quoted_message_id: 'wa-quote', quoted_sender: members[1].jid, quoted_sender_name: members[1].name, quoted_body: 'La propuesta de José', quoted_is_from_me: false }

async function installFixture(page: Page) {
  const chats = structuredClone(initialChats)
  const sent: any[] = [], pins: any[] = [], requests: string[] = []
  let socket: WebSocketRoute | undefined, failPin = false
  await page.routeWebSocket('**/ws**', route => { socket = route; route.onMessage(() => {}) })
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname
    requests.push(path + url.search)
    let data: any = { success: true }
    let status = 200
    const chat = chats.find(row => row.id === path.split('/')[3])
    if (path === '/api/me') data = { success: true, user: { id: 'user-qa', username: 'groups_qa', display_name: 'Grupos QA', is_admin: true, is_super_admin: false, role: 'admin', account_id: 'account-qa', account_name: 'Cuenta de prueba', subscription_active: true, subscription_status: 'active', permissions: ['chats', 'devices', 'contacts', 'leads', 'tasks', 'events', 'tags'], kommo_enabled: false }, accounts: [{ account_id: 'account-qa', account_name: 'Cuenta de prueba', role: 'admin', is_default: true }] }
    else if (path === '/api/settings/lead-policy') data = { success: true, policy: { account_id: 'account-qa', leads_enabled: true, lead_automation_enabled: false, leads_policy_version: 1 } }
    else if (path === '/api/devices') data = { success: true, devices: [device] }
    else if (path === '/api/chats') {
      const kind = url.searchParams.get('kind'), search = (url.searchParams.get('search') || '').toLowerCase()
      const rows = chats.filter(row => (!kind || kind === 'all' || row.kind === kind) && row.name.toLowerCase().includes(search)).sort((a, b) => Number(b.is_pinned) - Number(a.is_pinned) || Date.parse(b.pinned_at || b.last_message_at) - Date.parse(a.pinned_at || a.last_message_at))
      data = { success: true, chats: rows, total: rows.length, next_cursor: '' }
    } else if (path.endsWith('/pin') && request.method() === 'PUT') {
      const body = request.postDataJSON(); pins.push(body)
      if (failPin) { status = 503; data = { success: false, error: 'Fallo de fijado simulado' }; failPin = false }
      else { Object.assign(chat, { is_pinned: body.pinned, pinned_at: body.pinned ? new Date().toISOString() : null, pin_version: chat.pin_version + 1 }); data = { success: true, chat_id: chat.id, is_pinned: chat.is_pinned, pinned_at: chat.pinned_at, pin_version: chat.pin_version } }
    } else if (path.endsWith('/group/participants')) {
      const search = (url.searchParams.get('search') || '').toLowerCase()
      data = { success: true, participants: members.filter(row => row.name.toLowerCase().includes(search)), next_cursor: '' }
    } else if (path.endsWith('/group')) data = { success: true, group: chat.group }
    else if (path.endsWith('/groups/sync')) data = { success: true, synced: 1 }
    else if (path.endsWith('/receipts')) data = { success: true, receipts: [{ jid: members[0].jid, name: members[0].name, delivered_at: now, read_at: now }], total: 1, next_cursor: '' }
    else if (path.endsWith('/messages')) data = { success: true, messages: chat?.kind === 'group' ? [incoming, ...sent.map((body, index) => ({ ...body, id: 'sent-' + index, message_id: 'wa-sent-' + index, is_from_me: true, status: 'sent', timestamp: new Date().toISOString() }))] : [] }
    else if (path === '/api/messages/send') {
      const body = request.postDataJSON(); sent.push(body)
      data = { success: true, message: { ...body, id: 'sent-' + (sent.length - 1), message_id: 'wa-sent-' + (sent.length - 1), message_type: 'text', is_from_me: true, status: 'sent', timestamp: new Date().toISOString() } }
    } else if (path.endsWith('/read')) { if (chat) chat.unread_count = 0; data = { success: true, chat_id: chat?.id, unread_count: 0 } }
    else if (chat && path === '/api/chats/' + chat.id) data = { success: true, chat, device, contact: null, opportunities: [] }
    else if (path.startsWith('/api/quick-replies')) data = { success: true, quick_replies: [], folders: [], total: 0 }
    else if (path === '/api/stickers/saved') data = { success: true, stickers: [] }
    else if (path === '/api/tags') data = { success: true, tags: [] }
    else if (path === '/api/notifications') data = { success: true, notifications: [], unread_count: 0 }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) })
  })
  await page.context().addCookies([{ name: 'auth-token', value: 'synthetic-groups-session', url: baseURL, httpOnly: true, sameSite: 'Lax' }])
  await page.addInitScript(() => { localStorage.setItem('token', 'synthetic-groups-session'); localStorage.setItem('clarin:last_activity_at', String(Date.now())); localStorage.setItem('clarin:pwa-install-dismissed-until', String(Date.now() + 86400000)) })
  return { sent, pins, requests, failNextPin: () => { failPin = true }, emit: (data: unknown) => { if (!socket) throw new Error('No socket'); socket.send(JSON.stringify(data)) }, chats }
}

async function expectWithinViewport(page: Page, selector: string) {
  const rect = await page.locator(selector).boundingBox()
  expect(rect).not.toBeNull(); const viewport = page.viewportSize()!
  expect(rect!.x).toBeGreaterThanOrEqual(-1); expect(rect!.x + rect!.width).toBeLessThanOrEqual(viewport.width + 1)
  expect(rect!.y).toBeGreaterThanOrEqual(-1); expect(rect!.y + rect!.height).toBeLessThanOrEqual(viewport.height + 1)
}

for (const width of [320, 375, 768, 1440]) {
  test('grupos, menciones y detalles a ' + width + ' px', async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    const fixture = await installFixture(page)
    await page.goto(baseURL + '/dashboard/chats', { waitUntil: 'domcontentloaded', timeout: 90_000 })
    const groupRow = page.getByRole('button', { name: 'Conversación con Equipo de coordinación', exact: true })
    await expect(groupRow).toBeVisible({ timeout: 30_000 })
    await expect(groupRow).toContainText('María León: Confirmamos la reunión')
    const kindTrigger = page.getByRole('button', { name: 'Tipo de conversación: Todos los chats', exact: true })
    await expect(kindTrigger).toContainText('Tipo')
    if (width < 640) {
      expect((await kindTrigger.boundingBox())!.height).toBeGreaterThanOrEqual(44)
      expect((await page.getByRole('button', { name: 'Pendientes', exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44)
    }
    await page.screenshot({ path: testInfo.outputPath('inbox-all-' + width + '.png') })
    await page.getByRole('button', { name: /^Tipo de conversación:/ }).click()
    await expectWithinViewport(page, '[data-chat-overlay="conversation-menu"]')
    await page.screenshot({ path: testInfo.outputPath('kind-menu-' + width + '.png') })
    await page.getByRole('menuitemradio', { name: 'Individuales', exact: true }).click()
    await expect(groupRow).toHaveCount(0)
    await page.getByRole('button', { name: /^Tipo de conversación:/ }).click()
    await page.getByRole('menuitemradio', { name: 'Grupos', exact: true }).click()
    await expect(groupRow).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('button', { name: 'Conversación con Contacto individual', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Pendientes', exact: true })).toBeDisabled()
    const header = await page.locator('[data-chat-list-header]').boundingBox()
    const firstChat = await groupRow.boundingBox()
    expect(header!.height).toBeLessThanOrEqual(width >= 768 ? 184 : 200)
    await writeFile(testInfo.outputPath('layout-' + width + '.json'), JSON.stringify({ width, headerHeight: header!.height, firstChatTop: firstChat!.y, headerTop: header!.y }, null, 2))
    await page.screenshot({ path: testInfo.outputPath('inbox-' + width + '.png') })
    await expect(page.getByText('Con reacción', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Abrir filtros de chats', exact: true }).click()
    await expectWithinViewport(page, '[role="dialog"][aria-labelledby="mobile-chat-filters-title"]')
    await page.getByRole('button', { name: 'Con reacción', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Otros', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Mi número', exact: true })).toBeVisible()
    await expectWithinViewport(page, '[role="dialog"][aria-labelledby="mobile-chat-filters-title"]')
    await page.screenshot({ path: testInfo.outputPath('advanced-filters-' + width + '.png') })
    await page.getByRole('button', { name: 'Cancelar', exact: true }).click()
    await groupRow.click()
    const message = page.locator('[data-chat-message-id="message-in"]')
    await expect(message).toContainText('María León'); await expect(message).toContainText('José Ríos'); await expect(message).toContainText('La propuesta de José')
    const editor = page.getByRole('textbox', { name: 'Escribe un mensaje…', exact: true })
    await expect(editor).toHaveAttribute('contenteditable', 'true')
    await editor.fill('Hola @Mar')
    await expect(page.getByRole('option', { name: /María León/ })).toBeVisible()
    await expectWithinViewport(page, '[data-chat-overlay="mention-menu"]')
    await page.screenshot({ path: testInfo.outputPath('mentions-' + width + '.png') })
    await page.getByRole('option', { name: /María León/ }).click()
    await expect(editor).toContainText('Hola @María León')
    await page.getByRole('button', { name: 'Enviar mensaje', exact: true }).click()
    await expect.poll(() => fixture.sent.length).toBe(1)
    expect(fixture.sent[0].body).toContain('Hola @51900000002')
    expect(fixture.sent[0].mentions).toEqual([{ jid: members[0].jid, name: members[0].name }])
    await page.getByRole('button', { name: 'Acciones de la conversación', exact: true }).click()
    await expectWithinViewport(page, '[data-chat-overlay="conversation-menu"]')
    await page.getByRole('menuitem', { name: 'Fijar para mí', exact: true }).click()
    await expect.poll(() => fixture.pins.length).toBe(1)
    await page.getByRole('button', { name: 'Ver detalles de la conversación', exact: true }).click()
    const details = page.getByRole('region', { name: 'Detalles del grupo' })
    await expect(details).toBeVisible(); await expect(details.getByText('José Ríos', { exact: true })).toBeVisible()
    await expect(details.getByRole('button', { name: /Crear.*(oportunidad|contacto)|Lead/ })).toHaveCount(0)
    await expect(details).not.toContainText('Sin teléfono')
    await page.screenshot({ path: testInfo.outputPath('details-' + width + '.png') })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
}

test('el rollback de fijados conserva mensajes entrantes y el estado de la bandeja', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const fixture = await installFixture(page)
  await page.goto(baseURL + '/dashboard/chats', { waitUntil: 'domcontentloaded', timeout: 90_000 })
  const row = page.getByRole('button', { name: 'Conversación con Equipo de coordinación', exact: true })
  await expect(row).toBeVisible({ timeout: 30_000 })
  fixture.failNextPin()
  await page.getByRole('button', { name: 'Acciones para Equipo de coordinación', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Fijar para mí', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Fallo de fijado simulado' })).toBeVisible()
  const payload = { ...incoming, id: 'fresh', message_id: 'wa-fresh', body: 'Mensaje durante la actualización', timestamp: '2026-10-18T14:00:00Z' }
  Object.assign(fixture.chats[1], { last_message: payload.body, last_message_at: payload.timestamp, unread_count: 3, state_version: 2 })
  fixture.emit({ event: 'new_message', data: { chat_id: 'group-qa', message: payload } })
  fixture.emit({ event: 'chat_update', data: { chat_id: 'group-qa', unread_count: 3, state_version: 2, needs_reply: true, waiting_since: now } })
  await expect(row).toContainText('Mensaje durante la actualización')
  await expect(row.getByLabel('Chat fijado para ti')).toHaveCount(0)
  await page.getByRole('button', { name: 'Acciones para Equipo de coordinación', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Fijar para mí', exact: true }).click()
  await expect(row.getByLabel('Chat fijado para ti')).toBeVisible()
  fixture.emit({ event: 'new_message', data: { chat_id: 'direct-qa', message: { ...payload, id: 'other', message_id: 'other', chat_id: 'direct-qa', timestamp: '2026-10-18T15:00:00Z' } } })
  await expect(page.locator('[aria-label^="Conversación con "]').first()).toHaveAttribute('aria-label', 'Conversación con Equipo de coordinación')
  await page.screenshot({ path: testInfo.outputPath('pins-realtime.png') })
  expect(fixture.requests.filter(url => url.startsWith('/api/chats?')).every(url => new URL(url, baseURL).searchParams.get('pagination') === 'cursor')).toBe(true)
})
