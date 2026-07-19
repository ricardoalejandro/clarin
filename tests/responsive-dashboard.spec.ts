import { expect, test, type Locator, type Page } from '@playwright/test'

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3001'
const username = process.env.CLARIN_E2E_USERNAME
const password = process.env.CLARIN_E2E_PASSWORD
const accountName = process.env.CLARIN_E2E_ACCOUNT
const useMockSession = process.env.CLARIN_E2E_MOCK_AUTH === '1'
const captureVisuals = process.env.CLARIN_E2E_CAPTURE === '1'

const priorityRoutes = [
  '/dashboard',
  '/dashboard/chats',
  '/dashboard/programs',
]

const secondaryRoutes = [
  '/dashboard/contacts',
  '/dashboard/settings?tab=devices',
  '/dashboard/broadcasts',
  '/dashboard/leads',
  '/dashboard/events',
]

const priorityMatrix = [
  { name: 'phone-320', width: 320, height: 568 },
  { name: 'phone-375-short', width: 375, height: 667 },
  { name: 'phone-375-tall', width: 375, height: 812 },
  { name: 'phone-landscape', width: 568, height: 320 },
  { name: 'tablet-portrait', width: 768, height: 1024 },
  { name: 'tablet-landscape', width: 1024, height: 768 },
  { name: 'laptop', width: 1366, height: 768 },
  { name: 'desktop', width: 1440, height: 900 },
] as const

const mockNow = '2026-07-17T12:00:00.000Z'
const mockProgramParticipants = Array.from({ length: 6 }, (_, index) => ({
  id: `program-participant-${index + 1}`,
  program_id: 'program-1',
  contact_id: `program-contact-${index + 1}`,
  status: 'active',
  enrolled_at: mockNow,
  contact_name: index === 0 ? 'Álexis Tarillo Mejio' : `Participante Móvil ${index + 1}`,
  contact_phone: `5192300${String(100 + index)}`,
  avatar_url: null,
}))

function mockApiPayload(url: URL) {
  const path = url.pathname
  if (path === '/api/me') {
    return {
      success: true,
      user: {
        id: 'user-responsive', username: 'responsive_qa', display_name: 'Responsive QA',
        is_admin: true, is_super_admin: false, role: 'admin', account_id: 'account-responsive',
        account_name: 'Cuenta Responsive', plan: 'pro', subscription_status: 'active',
        subscription_active: true, permissions: ['chats', 'contacts', 'programs', 'devices', 'broadcasts', 'leads', 'events', 'tasks', 'tags'],
        kommo_enabled: false,
      },
      accounts: [{ account_id: 'account-responsive', account_name: 'Cuenta Responsive', account_slug: 'responsive', role: 'admin', is_default: true }],
    }
  }
  if (path === '/api/dashboard/summary') {
    return {
      success: true,
      dashboard: {
        generated_at: mockNow,
        timezone: 'America/Lima',
        period: { preset: '30d', from: '2026-06-18', to: '2026-07-17', previous_from: '2026-05-19', previous_to: '2026-06-17' },
        sections: { leads: true, chats: true, tasks: true, events: true, devices: true },
        leads: {
          open: 12,
          new: { current: 8, previous: 6, change_percent: 33.3 },
          won: { current: 3, previous: 2, change_percent: 50 },
          conversion: { current_percent: 25, previous_percent: 20, change_points: 5 },
          trend: [
            { date: '2026-06-18', new: 1, won: 0, lost: 0 },
            { date: '2026-07-02', new: 4, won: 1, lost: 1 },
            { date: '2026-07-17', new: 3, won: 2, lost: 0 },
          ],
          pipeline: { id: 'pipeline-1', name: 'Ventas', unassigned_count: 1, stages: [{ id: 'stage-1', name: 'Nuevo', color: '#10b981', count: 5 }] },
        },
        chats: { total: 7, unread_total: 2, awaiting_reply: 1, items: [{ id: 'chat-1', display_name: 'Contacto móvil', last_message: 'Mensaje de prueba responsiva', last_message_at: mockNow, last_inbound_at: mockNow, unread_count: 2 }] },
        tasks: { overdue: 1, due_today: 2, items: [{ id: 'task-1', title: 'Seguimiento desde móvil', due_at: mockNow, status: 'pending', type: 'follow_up' }] },
        events: { overdue_followups: 1, due_next_7_days: 2, items: [{ participant_id: 'participant-1', event_id: 'event-1', event_name: 'Evento QA', participant_name: 'Persona QA', next_action: 'Llamar', next_action_date: mockNow }] },
        devices: { total: 1, connected: 0, connecting: 0, disconnected: 1, issues: [{ id: 'device-1', name: 'Canal QA', phone: '51999999999', status: 'disconnected' }] },
      },
    }
  }
  if (path === '/api/programs/dashboard') {
    return { success: true, dashboard: { attendance_goal_percent: 80, transfer_goal_percent: 70, program_count: 1, active_program_count: 1, participant_count: 8, completed_count: 2, dropped_count: 1, transferred_count: 1, attendance_rate: 88, transfer_rate: 75, groups_below_goal: 0, critical_participants: 0, groups: [] } }
  }
  if (path === '/api/programs/folders') return { success: true, folders: [] }
  if (path === '/api/programs/program-1/participants') return mockProgramParticipants
  if (path === '/api/programs/program-1/sessions') return null
  if (path === '/api/programs/program-1/health') {
    return { success: true, health: { program_id: 'program-1', attendance_goal_percent: 80, transfer_goal_percent: 70, participant_count: 6, active_count: 6, completed_count: 0, dropped_count: 0, transferred_count: 0, session_count: 0, recovery_session_count: 0, attendance_rate: 72, transfer_rate: 0, health: 'watch', reasons: ['asistencia bajo meta'], participants: mockProgramParticipants.map((participant, index) => ({ participant_id: participant.id, contact_id: participant.contact_id, name: participant.contact_name, phone: participant.contact_phone, avatar_url: null, status: participant.status, health: index === 0 ? 'watch' : 'healthy', attendance_rate: 70 + index, present: 2, late: 0, absent: 1, excused: 0, recovery_sessions: 0, notes_count: index === 0 ? 1 : 0, reasons: index === 0 ? ['asistencia bajo meta'] : [] })) } }
  }
  if (path === '/api/programs/program-1/goals') return { success: true, goals: { attendance_goal_percent: 80, transfer_goal_percent: 70 } }
  if (path === '/api/programs/program-1') {
    return { id: 'program-1', account_id: 'account-responsive', name: 'Programa sin sesiones', description: '', status: 'active', color: '#10b981', created_by: 'user-responsive', created_at: mockNow, updated_at: mockNow, participant_count: 6, session_count: 0, type: 'course' }
  }
  if (path === '/api/programs') {
    return [{ id: 'program-1', account_id: 'account-responsive', name: 'Programa móvil QA', description: 'Programa visible en tarjetas responsivas', status: 'active', color: '#10b981', created_by: 'user-responsive', created_at: mockNow, updated_at: mockNow, participant_count: 8, session_count: 3, type: 'course' }]
  }
  if (path === '/api/events/pipelines') return { success: true, pipelines: [] }
  if (path === '/api/chats/chat-1') {
    return { success: true, chat: { id: 'chat-1', jid: '51999999999@s.whatsapp.net', name: 'Contacto móvil', device_id: 'device-1', device_name: 'Canal QA', contact_phone: '51999999999', last_message: 'Mensaje de prueba responsiva', last_message_at: mockNow, unread_count: 2 } }
  }
  if (path === '/api/chats/chat-1/messages') return { success: true, messages: [
    { id: 'message-in-1', account_id: 'account-responsive', device_id: 'device-1', chat_id: 'chat-1', message_id: 'wa-in-1', from_jid: '51999999999@s.whatsapp.net', from_name: 'Contacto móvil', body: 'Mensaje recibido para seleccionar', message_type: 'text', is_from_me: false, is_read: true, status: 'read', timestamp: new Date(Date.now() - 120_000).toISOString(), created_at: new Date(Date.now() - 120_000).toISOString() },
    { id: 'message-out-1', account_id: 'account-responsive', device_id: 'device-1', chat_id: 'chat-1', message_id: 'wa-out-1', from_jid: '51911111111@s.whatsapp.net', from_name: 'Me', body: 'Mensaje enviado para acciones', message_type: 'text', is_from_me: true, is_read: true, status: 'read', delivered_at: new Date(Date.now() - 45_000).toISOString(), read_at: new Date(Date.now() - 20_000).toISOString(), timestamp: new Date(Date.now() - 60_000).toISOString(), created_at: new Date(Date.now() - 60_000).toISOString() },
    { id: 'message-image-1', account_id: 'account-responsive', device_id: 'device-1', chat_id: 'chat-1', message_id: 'wa-image-1', from_jid: '51999999999@s.whatsapp.net', from_name: 'Contacto móvil', body: '', message_type: 'image', media_url: '/api/media/test-image', media_mimetype: 'image/png', is_from_me: false, is_read: true, status: 'read', timestamp: new Date(Date.now() - 30_000).toISOString(), created_at: new Date(Date.now() - 30_000).toISOString() },
  ] }
  if (path.startsWith('/api/chats/resolve-whatsapp/')) {
    const phone = path.split('/').pop() || '5192300100'
    return { success: true, phone, jid: `${phone}@s.whatsapp.net`, chat: null, historical_phone: '', devices: [{ id: 'device-1', name: 'Canal QA', phone: '51999999999', status: 'connected', provider: 'whatsapp_web', historical_relation: 'new_chat' }], mode: 'open_direct' }
  }
  if (path === '/api/chats/new') {
    return { success: true, chat: { id: 'chat-1', jid: '51999999999@s.whatsapp.net', name: 'Contacto móvil', device_id: 'device-1', device_name: 'Canal QA', contact_phone: '51999999999', last_message: 'Mensaje de prueba responsiva', last_message_at: mockNow, unread_count: 0 } }
  }
  if (path === '/api/chats') {
    return { success: true, total: 1, chats: [{ id: 'chat-1', jid: '51999999999@s.whatsapp.net', name: 'Contacto móvil', device_id: 'device-1', device_name: 'Canal QA', contact_phone: '51999999999', last_message: 'Mensaje de prueba responsiva', last_message_at: mockNow, unread_count: 2 }] }
  }
  if (path === '/api/devices') {
    return { success: true, devices: [{ id: 'device-1', name: 'Canal QA', phone: '51999999999', status: 'connected', provider: 'whatsapp_web', receive_messages: true, runtime_capabilities: { can_start_chat: true, can_check_whatsapp: true, can_send_sticker: true, can_send_animated_sticker: true, can_publish_status: true, can_sync_own_status: true } }] }
  }
  if (path === '/api/contacts') {
    return { success: true, total: 1, contacts: [{ id: 'contact-1', jid: '51999999999@s.whatsapp.net', phone: '51999999999', name: 'Contacto móvil', custom_name: 'Contacto móvil', email: 'movil@example.test', tags: [], structured_tags: [], created_at: mockNow, updated_at: mockNow }] }
  }
  if (/^\/api\/contacts\/program-contact-\d+\/interactions$/.test(path)) {
    return { success: true, interactions: [{ id: 'observation-1', contact_id: path.split('/')[3], lead_id: null, type: 'note', direction: null, outcome: null, notes: 'Observación móvil existente', created_by_name: 'Responsive QA', created_at: mockNow, program_id: 'program-1', program_participant_id: 'program-participant-1' }] }
  }
  if (/^\/api\/contacts\/program-contact-\d+$/.test(path)) {
    const contactNumber = Number(path.split('-').pop() || '1')
    const participant = mockProgramParticipants[contactNumber - 1] || mockProgramParticipants[0]
    return { success: true, contact: { id: participant.contact_id, account_id: 'account-responsive', jid: `${participant.contact_phone}@s.whatsapp.net`, phone: participant.contact_phone, name: participant.contact_name, custom_name: participant.contact_name, email: `participante${contactNumber}@example.test`, company: 'Clarin QA', distrito: 'Lima', ocupacion: 'Estudiante', notes: 'Nota general del contacto', tags: ['Comunidad'], structured_tags: [{ id: 'tag-program-1', name: 'Comunidad', color: '#6366f1' }], avatar_url: null, created_at: mockNow, updated_at: mockNow } }
  }
  if (path === '/api/campaigns') {
    return { success: true, campaigns: [{ id: 'campaign-1', account_id: 'account-responsive', device_id: 'device-1', name: 'Difusión móvil QA', message_template: 'Mensaje responsivo', media_url: null, media_type: null, status: 'draft', scheduled_at: null, started_at: null, completed_at: null, total_recipients: 1, sent_count: 0, failed_count: 0, settings: {}, created_at: mockNow, updated_at: mockNow, device_name: 'Canal QA' }] }
  }
  if (path === '/api/events/folders') return { success: true, folders: [] }
  if (path === '/api/events') {
    return {
      success: true,
      events: [{
        id: 'event-1',
        name: 'Evento móvil QA',
        description: 'Evento visible después del estado de carga',
        event_date: mockNow,
        location: 'Lima',
        status: 'active',
        color: '#10b981',
        folder_id: null,
        created_at: mockNow,
        total_participants: 3,
        participant_counts: { confirmed: 2, invited: 1 },
        stage_counts: {},
        tags: [],
      }],
      total: 1,
      has_more: false,
    }
  }
  if (path.startsWith('/api/leads/')) return { success: true, leads: [], total: 0, counts: {} }
  if (path === '/api/leads') return { success: true, leads: [], total: 0, counts: {} }
  if (path === '/api/pipelines') return { success: true, pipelines: [] }
  if (path === '/api/tags') return { success: true, tags: [] }
  if (path === '/api/custom-fields') return { success: true, definitions: [] }
  if (path === '/api/google/status') return { success: true, connected: false }
  if (path === '/api/eros/status') return { success: true, available: false }
  if (path === '/api/public/security-config') return { success: true, login_enabled: true, login_turnstile_required: false, turnstile_site_key: '' }
  return { success: true }
}

async function installMockSession(page: Page) {
  await page.routeWebSocket('**/ws**', socket => {
    socket.onMessage(() => undefined)
  })
  await page.route('**/api/**', async route => {
    if (new URL(route.request().url()).pathname === '/api/media/test-image') {
      await route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAC0lEQVR4nO3PQQ0AIBDAsAP/nuGNAvZoFSzZOjNnyNiBNwNvBt4MvBl4M/Bm4M3Am4E3A28G3gy8GXgz8GbgzcCbgTcDbwbeDLwZeDPwZuDNwJuBNwNvBt4MvBl4M/Bm4M3Am4E3A28G3gy8GXgz8GbgzcCbgTcDbwbeDLwZeDPwZuDNwJuBNwNvBt4MvBl4M/Bm4M3Am4E3A28G3gy8GXgz8GbgzcCbgTcDbwbeDLwZeDPwZuDNwJuBNwNvBt4MvBl4M/Bm4M3Am4E3A28G3gy8GXgz8GbgzcCbgTcDbwbeDLwZeDPwZuDNwJuBNwNvBt4MvBl4M/Bm4M3Am4E3A28G3gy8GXgz8GbgzcCbgTcDbwbeDLwZeDPwZuDNwJuBNwNvBt4MvBl4M/Bm4M3Am4E3A28G3gy8GXgz8GbgzcCbgTcDbwbeDLwZeDPwZuDNwJuBNwNvBt4MvBl4M/Bm4G3gB4x8BfU3pFQAAAABJRU5ErkJggg==', 'base64'),
      })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockApiPayload(new URL(route.request().url()))) })
  })
  await page.context().addCookies([{ name: 'auth-token', value: 'responsive-ui-session', url: baseURL, httpOnly: true, sameSite: 'Lax' }])
  await page.addInitScript(() => {
    localStorage.setItem('token', 'responsive-ui-session')
    localStorage.setItem('clarin:last_activity_at', String(Date.now()))
  })
}

async function authenticate(page: Page) {
  if (useMockSession) {
    await installMockSession(page)
    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' })
    await page.waitForURL(/\/dashboard/, { timeout: 20_000 })
    // Wait until DashboardLayout finishes /api/me. Navigating away while that
    // request is still pending can make its unmount/abort path race with the
    // next page.goto and spuriously redirect the test to /login.
    await page.locator('main').waitFor({ state: 'visible', timeout: 20_000 })
    return
  }
  await page.goto(`${baseURL}/login`, { waitUntil: 'domcontentloaded' })
  await page.locator('input[name="username"], input[type="text"]').first().fill(username || '')
  await page.locator('input[type="password"]').first().fill(password || '')
  await page.locator('button[type="submit"]').click()
  await page.waitForURL(/\/dashboard/, { timeout: 20_000 })

  if (accountName) {
    const account = page.getByText(accountName, { exact: true }).first()
    if (await account.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await account.click()
      await page.waitForURL(/\/dashboard/, { timeout: 10_000 })
    }
  }
}

async function expectRouteToFit(page: Page, route: string) {
  await page.goto(`${baseURL}${route}`, { waitUntil: 'domcontentloaded' })
  await expect(page).toHaveURL(new RegExp(route.split('?')[0].replaceAll('/', '\\/')))
  await expect(page.locator('body')).toBeVisible()

  await expect.poll(async () => page.evaluate(() => {
    const root = document.documentElement
    return root.scrollWidth - root.clientWidth
  }), {
    message: `${route} no debe desbordar horizontalmente el documento`,
    timeout: 10_000,
  }).toBeLessThanOrEqual(1)

  const appViewport = await page.evaluate(() => {
    const styles = getComputedStyle(document.documentElement)
    return {
      height: Number.parseFloat(styles.getPropertyValue('--app-height')),
      width: Number.parseFloat(styles.getPropertyValue('--app-width')),
      visualHeight: window.visualViewport?.height || window.innerHeight,
      visualWidth: window.visualViewport?.width || window.innerWidth,
    }
  })
  expect(appViewport.height).toBeGreaterThan(0)
  expect(appViewport.width).toBeGreaterThan(0)
  expect(appViewport.height).toBeLessThanOrEqual(appViewport.visualHeight + 1)
  expect(appViewport.width).toBeLessThanOrEqual(appViewport.visualWidth + 1)
}

async function expectInsideVisualViewport(page: Page, locator: Locator) {
  await expect(locator).toBeVisible()
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  const viewport = await page.evaluate(() => ({
    left: window.visualViewport?.offsetLeft || 0,
    top: window.visualViewport?.offsetTop || 0,
    width: window.visualViewport?.width || window.innerWidth,
    height: window.visualViewport?.height || window.innerHeight,
  }))
  expect(box!.x).toBeGreaterThanOrEqual(viewport.left - 1)
  expect(box!.y).toBeGreaterThanOrEqual(viewport.top - 1)
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.left + viewport.width + 1)
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.top + viewport.height + 1)
}

async function setMockKeyboardInset(page: Page, inset: number) {
  await page.evaluate((nextInset) => {
    const viewport = window.visualViewport
    if (!viewport) throw new Error('visualViewport no está disponible para simular el teclado')
    Object.defineProperty(viewport, 'height', {
      configurable: true,
      value: Math.max(160, window.innerHeight - nextInset),
    })
    viewport.dispatchEvent(new Event('resize'))
  }, inset)
}

async function selectAllEditableText(locator: Locator, text: string) {
  await locator.fill(text)
  await expect(locator).toHaveText(text)
  await locator.evaluate(element => {
    const selection = window.getSelection()
    if (!selection) throw new Error('No se pudo crear una selección de texto')
    const range = document.createRange()
    range.selectNodeContents(element)
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
}

async function expectToolbarOutsideEditor(page: Page, toolbar: Locator, editor: Locator) {
  await expectInsideVisualViewport(page, toolbar)
  const toolbarBox = await toolbar.boundingBox()
  const editorBox = await editor.boundingBox()
  expect(toolbarBox).not.toBeNull()
  expect(editorBox).not.toBeNull()
  const horizontalOverlap = toolbarBox!.x < editorBox!.x + editorBox!.width
    && toolbarBox!.x + toolbarBox!.width > editorBox!.x
  const verticalOverlap = toolbarBox!.y < editorBox!.y + editorBox!.height
    && toolbarBox!.y + toolbarBox!.height > editorBox!.y
  expect(horizontalOverlap && verticalOverlap).toBe(false)
  expect(toolbarBox!.y + toolbarBox!.height).toBeLessThanOrEqual(editorBox!.y - 4)
}

test.describe('Clarin responsive authenticated matrix', () => {
  test.skip(!useMockSession && (!username || !password), 'Define credenciales E2E o CLARIN_E2E_MOCK_AUTH=1 para ejecutar la matriz')
  test.describe.configure({ mode: 'serial' })

  for (const viewport of priorityMatrix) {
    test(`${viewport.name}: Inicio, Chats y Programas caben en el viewport`, async ({ page }, testInfo) => {
      test.setTimeout(90_000)
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await authenticate(page)
      for (const route of priorityRoutes) {
        await expectRouteToFit(page, route)
        if (captureVisuals && (viewport.name === 'phone-375-tall' || viewport.name === 'desktop')) {
          const routeName = route === '/dashboard' ? 'inicio' : route.split('/').pop() || 'page'
          await page.screenshot({ path: testInfo.outputPath(`${viewport.name}-${routeName}.png`), fullPage: false })
        }
      }
    })
  }

  test('módulos secundarios caben en un teléfono de 375 px', async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width: 375, height: 812 })
    await authenticate(page)
    for (const route of secondaryRoutes) await expectRouteToFit(page, route)
  })

  test('Eventos mide el contenedor que aparece después de cargar y activa sus tarjetas móviles', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 375, height: 812 })
    await authenticate(page)
    await page.goto(`${baseURL}/dashboard/events`, { waitUntil: 'domcontentloaded' })

    await expect(page.getByText('Evento móvil QA')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Acciones de Evento móvil QA' })).toBeVisible()
    await expect(page.locator('table')).toHaveCount(0)
  })

  test('Dispositivos conserva la vinculación por QR en una laptop táctil amplia', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 1024, height: 768 })
    await authenticate(page)
    await page.goto(`${baseURL}/dashboard/settings?tab=devices`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Agregar', exact: true }).click()

    const nameInput = page.getByPlaceholder('Nombre del canal')
    await expect(nameInput).toBeVisible()
    await nameInput.fill('Canal laptop táctil')
    await expect(page.getByRole('button', { name: 'Crear y Conectar' })).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Requiere computadora' })).toHaveCount(0)
  })

  test('login y navegación móvil mantienen controles alcanzables', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 })
    await authenticate(page)
    await expectRouteToFit(page, '/dashboard')

    const openMenu = page.getByRole('button', { name: 'Abrir menú' })
    await expect(openMenu).toBeVisible()
    await openMenu.click()
    await expect(page.getByRole('button', { name: 'Cerrar menú' })).toBeVisible()
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
  })

  test('Chats mantiene Nueva conversación dentro del viewport en horizontal', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 568, height: 320 })
    await authenticate(page)
    await page.goto(`${baseURL}/dashboard/chats`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Nuevo chat' }).click()
    const dialog = page.getByRole('dialog', { name: 'Nueva conversación' })
    await expectInsideVisualViewport(page, dialog)
    const close = page.getByRole('button', { name: /Cerrar nueva conversación|Espera a que termine/ })
    const closeBox = await close.boundingBox()
    expect(closeBox?.width).toBeGreaterThanOrEqual(40)
    expect(closeBox?.height).toBeGreaterThanOrEqual(40)
  })

  test('Chats reemplaza el popup por una bandeja móvil dentro del viewport', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 213, height: 378 })
    await authenticate(page)
    await page.goto(`${baseURL}/dashboard/chats`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Conversación con Contacto móvil' }).click()
    await page.getByRole('button', { name: 'Adjuntar archivo' }).click()
    await page.getByRole('menuitem', { name: 'Emoji' }).click()
    const accessory = page.getByTestId('mobile-composer-accessory')
    await expectInsideVisualViewport(page, accessory)
    await expect(page.getByRole('region', { name: 'Selector de emojis' })).toBeVisible()
    await expect(page.getByTestId('dashboard-mobile-header')).toBeHidden()
    await page.goBack()
    await expect(accessory).toHaveCount(0)
  })

  test('Chats intercambia teclado, emojis y stickers sin recuperar el foco indebidamente', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 375, height: 812 })
    await authenticate(page)
    await page.goto(`${baseURL}/dashboard/chats`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Conversación con Contacto móvil' }).click()

    const composer = page.getByRole('textbox', { name: 'Escribe un mensaje…' })
    await composer.click()
    await setMockKeyboardInset(page, 280)
    await page.getByRole('button', { name: 'Abrir selector de emojis' }).click()

    const accessory = page.getByTestId('mobile-composer-accessory')
    await expect(accessory).toBeVisible()
    await expect(page.getByTestId('dashboard-mobile-header')).toBeHidden()
    await expect.poll(() => composer.evaluate(element => document.activeElement === element)).toBe(false)

    await setMockKeyboardInset(page, 0)
    await expect(page.getByRole('region', { name: 'Selector de emojis' })).toBeVisible()
    await page.getByRole('tab', { name: 'Stickers' }).click()
    await expect(page.getByRole('region', { name: 'Selector de stickers' })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Recientes' })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Favoritos' })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Crear' })).toBeVisible()

    await page.getByRole('button', { name: 'Mostrar teclado' }).click()
    await expect(accessory).toHaveCount(0)
    await expect.poll(() => composer.evaluate(element => document.activeElement === element)).toBe(true)
  })

  test('El visor móvil captura pinch sobre la foto sin deshabilitar el zoom del documento', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 375, height: 812 })
    await authenticate(page)
    await page.goto(`${baseURL}/dashboard/chats`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Conversación con Contacto móvil' }).click()

    const chatImage = page.getByRole('img', { name: 'Imagen' })
    await expect(chatImage).toBeVisible()
    await expect(chatImage).toHaveAttribute('loading', 'lazy')
    await expect(chatImage).toHaveAttribute('decoding', 'async')
    await chatImage.click()

    const viewer = page.getByRole('dialog', { name: 'Visor de imagen' })
    const surface = page.getByTestId('image-viewer-surface')
    await expectInsideVisualViewport(page, viewer)
    await expect(surface).toHaveCSS('touch-action', 'none')
    const initialDocumentScale = await page.evaluate(() => window.visualViewport?.scale || 1)
    const box = await surface.boundingBox()
    expect(box).not.toBeNull()
    const centerX = box!.x + box!.width / 2
    const centerY = box!.y + box!.height / 2

    await surface.dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: centerX - 30, clientY: centerY, button: 0 })
    await surface.dispatchEvent('pointerdown', { pointerId: 2, pointerType: 'touch', clientX: centerX + 30, clientY: centerY, button: 0 })
    await surface.dispatchEvent('pointermove', { pointerId: 1, pointerType: 'touch', clientX: centerX - 70, clientY: centerY, button: 0 })
    await surface.dispatchEvent('pointermove', { pointerId: 2, pointerType: 'touch', clientX: centerX + 70, clientY: centerY, button: 0 })
    await surface.dispatchEvent('pointerup', { pointerId: 1, pointerType: 'touch', clientX: centerX - 70, clientY: centerY, button: 0 })
    await surface.dispatchEvent('pointerup', { pointerId: 2, pointerType: 'touch', clientX: centerX + 70, clientY: centerY, button: 0 })

    await expect.poll(async () => Number.parseInt((await page.getByTestId('image-viewer-scale').textContent()) || '0', 10)).toBeGreaterThan(100)
    expect(await page.evaluate(() => window.visualViewport?.scale || 1)).toBe(initialDocumentScale)
    await page.getByRole('button', { name: 'Cerrar visor' }).click()
    await expect(viewer).toHaveCount(0)
  })

  test('Chats cede la cabecera global al teclado solo en teléfono y conserva la conversación', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 375, height: 812 })
    await authenticate(page)
    await page.goto(`${baseURL}/dashboard/chats`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Conversación con Contacto móvil' }).click()

    const dashboardHeader = page.getByTestId('dashboard-mobile-header')
    const conversationHeader = page.getByRole('button', { name: 'Ver detalles de la conversación' })
    const composer = page.getByRole('textbox', { name: 'Escribe un mensaje…' })
    await expect(dashboardHeader).toBeVisible()
    await expect(conversationHeader).toBeVisible()

    await composer.click()
    await setMockKeyboardInset(page, 280)
    await expect(dashboardHeader).toBeHidden()
    await expect(conversationHeader).toBeVisible()

    await setMockKeyboardInset(page, 0)
    await expect(dashboardHeader).toBeVisible()
    await expect(conversationHeader).toBeVisible()

    await page.setViewportSize({ width: 768, height: 1024 })
    await page.goto(`${baseURL}/dashboard/chats`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Conversación con Contacto móvil' }).click()
    await page.getByRole('textbox', { name: 'Escribe un mensaje…' }).click()
    await setMockKeyboardInset(page, 320)
    await expect(page.getByTestId('dashboard-mobile-header')).toBeVisible()
  })

  test('Chats móvil selecciona por pulsación larga y adapta las acciones y el compositor', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 375, height: 812 })
    await authenticate(page)
    await page.goto(`${baseURL}/dashboard/chats`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Conversación con Contacto móvil' }).click()

    await expect(page.getByText('Mensaje enviado para acciones', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Más acciones del mensaje' })).toHaveCount(0)

    const selectedMessage = page.locator('[data-whatsapp-message-id="wa-out-1"] [role="group"]')
    await selectedMessage.dispatchEvent('pointerdown', { pointerType: 'touch', clientX: 180, clientY: 420, button: 0 })
    await page.waitForTimeout(550)
    await selectedMessage.dispatchEvent('pointerup', { pointerType: 'touch', clientX: 180, clientY: 420, button: 0 })

    await expect(page.getByTestId('message-selection-header')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Responder mensaje' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Reenviar mensaje' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Eliminar mensaje para todos' })).toBeVisible()

    await page.getByRole('button', { name: 'Reenviar mensaje' }).click()
    const forwardDialog = page.getByRole('dialog', { name: 'Reenviar mensaje' })
    await expectInsideVisualViewport(page, forwardDialog)
    await expect(forwardDialog.getByPlaceholder('Buscar por nombre, teléfono...')).toBeVisible()
    await page.getByRole('button', { name: 'Cerrar reenvío' }).click()

    await selectedMessage.dispatchEvent('pointerdown', { pointerType: 'touch', clientX: 180, clientY: 420, button: 0 })
    await page.waitForTimeout(550)
    await selectedMessage.dispatchEvent('pointerup', { pointerType: 'touch', clientX: 180, clientY: 420, button: 0 })
    await expect(page.getByTestId('message-selection-header')).toBeVisible()

    await page.getByRole('button', { name: 'Más acciones del mensaje' }).click()
    await page.getByRole('menuitem', { name: 'Información del mensaje' }).click()
    const infoDialog = page.getByRole('dialog', { name: 'Información del mensaje' })
    await expectInsideVisualViewport(page, infoDialog)
    await expect(infoDialog.getByText('Entregado')).toBeVisible()
    await expect(infoDialog.getByText('Leído')).toBeVisible()
    await page.getByRole('button', { name: 'Cerrar información del mensaje' }).click()

    const composer = page.getByRole('textbox', { name: 'Escribe un mensaje…' })
    await expect(page.getByRole('button', { name: 'Abrir selector de emojis' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Adjuntar archivo' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Tomar una foto' })).toBeVisible()
    await composer.fill('Hola desde móvil')
    await expect(page.getByRole('button', { name: 'Tomar una foto' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Enviar mensaje' })).toBeVisible()

    await composer.fill('')
    await selectedMessage.dispatchEvent('pointerdown', { pointerType: 'touch', clientX: 180, clientY: 420, button: 0 })
    await page.waitForTimeout(550)
    await selectedMessage.dispatchEvent('pointerup', { pointerType: 'touch', clientX: 180, clientY: 420, button: 0 })
    await expect(page.getByTestId('message-selection-header')).toBeVisible()
    await page.goBack()
    await expect(page.getByTestId('message-selection-header')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Ver detalles de la conversación' })).toBeVisible()
  })

  test('Chats escritorio conserva sus acciones por mensaje y el compositor amplio', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 1440, height: 900 })
    await authenticate(page)
    await page.goto(`${baseURL}/dashboard/chats`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Conversación con Contacto móvil' }).click()

    await expect(page.getByText('Mensaje enviado para acciones', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Más acciones del mensaje' })).toHaveCount(3)
    await expect(page.getByRole('button', { name: 'Adjuntar archivo' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Abrir selector de emojis' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Tomar una foto' })).toHaveCount(0)
    await expect(page.getByTestId('message-selection-header')).toHaveCount(0)
  })

  test('Chats muestra el formato fuera del texto en mensaje y pie de adjunto', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 320, height: 568 })
    await authenticate(page)
    await page.goto(`${baseURL}/dashboard/chats`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Conversación con Contacto móvil' }).click()

    const composer = page.getByRole('textbox', { name: 'Escribe un mensaje…' })
    await composer.click()
    await setMockKeyboardInset(page, 220)
    await selectAllEditableText(composer, 'Mensaje para dar formato')

    const toolbar = page.getByRole('toolbar', { name: 'Formato de texto' })
    await expectToolbarOutsideEditor(page, toolbar, composer)
    await page.getByRole('button', { name: 'Negrita, Ctrl+B' }).click()
    await expect(toolbar).toBeHidden()
    await expect.poll(() => composer.evaluate(element => element.innerHTML)).toContain('<strong>Mensaje para dar formato</strong>')

    await page.locator('input[type="file"]').nth(1).setInputFiles({
      name: 'prueba.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('archivo de prueba'),
    })
    const caption = page.getByRole('textbox', { name: 'Agregar descripción...' })
    await expect(caption).toBeVisible()
    await selectAllEditableText(caption, 'Descripción del archivo')
    await expectToolbarOutsideEditor(page, toolbar, caption)
    await page.keyboard.press('Escape')
    await expect(toolbar).toBeHidden()

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${baseURL}/dashboard/chats`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Conversación con Contacto móvil' }).click()
    const desktopComposer = page.getByRole('textbox', { name: 'Escribe un mensaje…' })
    await selectAllEditableText(desktopComposer, 'Formato en escritorio')
    await expectToolbarOutsideEditor(page, toolbar, desktopComposer)
  })

  test('Programas móvil queda en consulta y conserva la operación en escritorio', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 320, height: 568 })
    await authenticate(page)
    await page.goto(`${baseURL}/dashboard/programs`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('button', { name: 'Nuevo', exact: true })).toHaveCount(0)
    await expect(page.getByText('Salud general', { exact: true })).toHaveCount(0)
    await expect(page.getByTitle('Cuadrícula')).toHaveCount(0)
    await expect(page.getByText('Programa móvil QA', { exact: true })).toBeVisible()

    await page.setViewportSize({ width: 1440, height: 900 })
    await expect(page.getByRole('button', { name: 'Nuevo Programa' })).toBeVisible()
    await expect(page.getByText('Salud general', { exact: true })).toBeVisible()
    await expect(page.getByTitle('Cuadrícula')).toBeVisible()
  })

  test('Chats móvil mueve los filtros secundarios a una superficie completa', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await authenticate(page)
    await page.goto(`${baseURL}/dashboard/chats`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('button', { name: 'Nuevo chat' })).toBeVisible()
    await expect(page.getByText('No leídos', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: /Abrir filtros de chats/ }).click()
    const dialog = page.getByRole('dialog', { name: 'Filtros de chats' })
    await expectInsideVisualViewport(page, dialog)
    await expect(page.getByRole('button', { name: 'Solo no leídos' })).toBeVisible()
  })

  test('Contactos móvil integra el orden en filtros y usa acciones a pantalla completa', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await authenticate(page)
    await page.goto(`${baseURL}/dashboard/contacts`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('#contacts-mobile-sort')).toHaveCount(0)

    await page.getByRole('button', { name: /Abrir filtros y orden/ }).click()
    await expect(page.locator('#contacts-mobile-sort')).toBeVisible()
    await page.getByRole('button', { name: 'Cerrar filtros y orden' }).click()

    await page.getByTitle('Más acciones').click()
    const actions = page.getByRole('dialog', { name: 'Más acciones de contactos' })
    await expectInsideVisualViewport(page, actions)
    const box = await actions.boundingBox()
    expect(box?.height).toBeGreaterThanOrEqual(790)
    await expect(page.getByText('Herramientas', { exact: true })).toBeVisible()
  })

  test('Programas interpreta una respuesta null de sesiones como lista vacía', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await authenticate(page)
    await page.goto(`${baseURL}/dashboard/programs/program-1`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Programa sin sesiones' })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTitle('Editar programa')).toHaveCount(0)
    await page.getByRole('button', { name: /Cambiar sección\. Actual: Participantes/ }).click()
    await page.getByRole('button', { name: /Sesiones 0 registradas/ }).click()
    await expect(page.getByRole('button', { name: /Cambiar sección\. Actual: Sesiones/ })).toBeVisible()
    await expect(page.getByText('Todavía no hay sesiones para consultar.', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Nueva Sesión' })).toHaveCount(0)
    await expect(page.getByText('No se pudieron cargar las sesiones.', { exact: true })).toHaveCount(0)
  })

  test('Programas móvil prioriza búsqueda, filas densas y detalle enfocado sin alterar escritorio', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 375, height: 812 })
    await authenticate(page)
    await page.goto(`${baseURL}/dashboard/programs/program-1`, { waitUntil: 'domcontentloaded' })

    await expect(page.getByRole('heading', { name: 'Programa sin sesiones' })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByLabel('6 participantes')).toBeVisible()
    await expect(page.getByRole('button', { name: /Cambiar sección\. Actual: Participantes/ })).toBeVisible()
    const search = page.getByRole('textbox', { name: 'Buscar participante por nombre o teléfono' })
    await expect(search).toBeVisible()
    await expect(page.getByText('Salud', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Asistencia', { exact: true })).toHaveCount(0)

    const rows = page.getByTestId('mobile-program-participant-row')
    await expect(rows).toHaveCount(6)
    const firstRowBox = await rows.first().boundingBox()
    expect(firstRowBox?.height).toBeLessThanOrEqual(90)

    await search.fill('alexis')
    await expect(rows).toHaveCount(1)
    await expect(page.getByText('Álexis Tarillo Mejio', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: /Álexis Tarillo Mejio.*5192300100.*Activo/ }).click()

    await expect(page.getByRole('heading', { name: 'Detalle del participante' })).toBeVisible()
    await expect(page.getByText('participante1@example.test')).toBeVisible()
    await expect(page.getByText('Observación móvil existente')).toBeVisible()
    await expect(page.getByText('Generar Documento')).toHaveCount(0)
    await expect(page.getByText('Nueva tarea')).toHaveCount(0)
    await expect(page.getByText('Eliminar', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Enviar mensaje a Álexis Tarillo Mejio' }).click()
    await expect(page.getByRole('button', { name: 'Ver detalles de la conversación' })).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Escribe un mensaje…' })).toBeVisible()
    await page.getByRole('button', { name: 'Volver a la lista de chats' }).click()
    await expect(page.getByRole('heading', { name: 'Detalle del participante' })).toBeVisible()
    await page.getByRole('button', { name: 'Volver a participantes' }).click()
    await expect(search).toHaveValue('alexis')

    await page.getByRole('button', { name: 'Abrir observaciones de Álexis Tarillo Mejio' }).click()
    await expect(page.getByRole('heading', { name: 'Historial de Observaciones' })).toBeVisible()
    const observationAuthor = page.getByTestId('observation-author')
    await expect(observationAuthor).toBeVisible()
    await expect(observationAuthor).toContainText('Responsive QA')
    await expect(page.getByPlaceholder(/Escribir observación/)).toHaveCount(0)
    await page.getByRole('button', { name: 'Nueva observación' }).click()
    await expect(page.getByPlaceholder(/Escribir observación/)).toBeVisible()

    await page.setViewportSize({ width: 320, height: 568 })
    await page.goto(`${baseURL}/dashboard/programs/program-1`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('textbox', { name: 'Buscar participante por nombre o teléfono' })).toBeVisible()
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)

    await page.setViewportSize({ width: 768, height: 1024 })
    await page.goto(`${baseURL}/dashboard/programs/program-1`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('button', { name: /Participantes \(6\)/ })).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Buscar participante por nombre o teléfono' })).toHaveCount(0)

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${baseURL}/dashboard/programs/program-1`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('button', { name: /Participantes \(6\)/ })).toBeVisible()
    await expect(page.getByText('Salud', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('Asistencia', { exact: true }).first()).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Buscar participante por nombre o teléfono' })).toHaveCount(0)
  })

  test('Eros permanece dentro del viewport móvil y conserva el modo acoplado de escritorio', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 375, height: 667 })
    await authenticate(page)

    const openVisibleEros = async () => {
      const triggers = page.getByRole('button', { name: 'Abrir Eros' })
      await triggers.first().waitFor({ state: 'attached', timeout: 10_000 })
      for (let index = 0; index < await triggers.count(); index += 1) {
        const trigger = triggers.nth(index)
        const box = await trigger.boundingBox()
        const viewport = page.viewportSize()
        const intersectsViewport = Boolean(box && viewport
          && box.x + box.width > 0
          && box.y + box.height > 0
          && box.x < viewport.width
          && box.y < viewport.height)
        if (await trigger.isVisible() && intersectsViewport) {
          await trigger.click()
          return
        }
      }
      throw new Error('No se encontró un botón visible para abrir Eros')
    }

    await openVisibleEros()
    const mobileEros = page.getByLabel('Asistente Eros')
    await expectInsideVisualViewport(page, mobileEros)
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    await page.getByRole('button', { name: 'Cerrar', exact: true }).click()

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' })
    await openVisibleEros()
    const desktopEros = page.getByLabel('Asistente Eros')
    await expectInsideVisualViewport(page, desktopEros)
    const dock = page.getByTitle('Acoplar a la derecha')
    await expect(dock).toBeVisible()
    await dock.click()
    await expectInsideVisualViewport(page, desktopEros)
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)

    const collapseSidebar = page.getByTitle('Colapsar menú')
    await expect(collapseSidebar).toBeVisible()
    await collapseSidebar.click()
    await expectInsideVisualViewport(page, desktopEros)
  })
})
