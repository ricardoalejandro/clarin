import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type BrowserContext, type Page, type Route, type WebSocketRoute } from '@playwright/test'

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3011'
const boardID = 'whiteboard-compatibility-qa'
const now = '2026-08-09T06:00:00.000Z'
const explicitLinkOrigin = 'http://whiteboard-link.invalid'
const fixtureRoot = resolve(process.cwd(), '.codex/skills/clarin-excalidraw-development/assets/compat-fixtures/v0.18.1')
const sceneFixture = JSON.parse(readFileSync(resolve(fixtureRoot, 'complex-scene.excalidraw'), 'utf8')) as Record<string, any>
const libraryFixture = JSON.parse(readFileSync(resolve(fixtureRoot, 'internal-library.excalidrawlib'), 'utf8')) as { libraryItems: Array<Record<string, any>> }

interface VisibleBrandingSurface {
  name: string
  visibleText: string[]
  visibleActions: Array<{
    text: string
    accessibleName: string
    ariaLabel: string
    label: string
    title: string
    testId: string
    classNames: string[]
    href: string
  }>
}

const access = {
  level: 'manage',
  inherited_from: 'creator',
  can_view: true,
  can_edit: true,
  can_manage_access: true,
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

const loadedTextFixture = (() => {
  const text = clone(sceneFixture.elements.find((element: Record<string, any>) => element.type === 'text'))
  text.id = 'loaded-font-text'
  text.x = 320
  text.y = 120
  text.groupIds = []
  text.frameId = null
  text.containerId = null
  text.boundElements = null
  text.index = 'a0'
  text.text = 'Fuente local al abrir'
  text.originalText = text.text
  return text as Record<string, unknown>
})()

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

class WhiteboardRealtimeHarness {
  sequence = 0
  elements: Array<Record<string, unknown>> = [clone(loadedTextFixture)]
  readonly patchAttempts: Array<{ userID: string; operationID: string; baseSequence: number; acceptedSequence: number }> = []
  readonly deliveries: Array<{ recipient: string; operationID: string }> = []
  readonly httpSceneWrites: Array<{ method: string; operationID: string }> = []
  readonly ticketReads = new Map<string, number>()
  readonly createdBoardNames: string[] = []
  readonly createdFolders: Array<{ id: string; name: string; parentID: string | null }> = []
  private readonly sockets = new Map<WebSocketRoute, string>()
  private readonly operationSequences = new Map<string, number>()
  private delayedRule: { sender: string; recipient: string } | null = null
  private readonly delayedMessages: Array<{ recipient: string; socket: WebSocketRoute; message: string }> = []
  private loseAckUserID: string | null = null
  private rejectPatchUserID: string | null = null
  private readonly failingTicketUsers = new Set<string>()

  loseNextAckFor(userID: string) {
    this.loseAckUserID = userID
  }

  rejectNextPatchFor(userID: string) {
    this.rejectPatchUserID = userID
  }

  failTicketsFor(userID: string) {
    this.failingTicketUsers.add(userID)
  }

  restoreTicketsFor(userID: string) {
    this.failingTicketUsers.delete(userID)
  }

  shouldFailTicket(userID: string) {
    return this.failingTicketUsers.has(userID)
  }

  recordHTTPSceneWrite(method: string, payload: Record<string, any>) {
    const operationID = String(payload.operation_id || '')
    this.httpSceneWrites.push({ method, operationID })
    const priorSequence = this.operationSequences.get(operationID)
    if (priorSequence !== undefined) return true
    this.sequence += 1
    this.operationSequences.set(operationID, this.sequence)
    this.elements = clone(payload.scene?.elements || this.elements)
    return false
  }

  delayNextDelivery(sender: string, recipient: string) {
    this.delayedRule = { sender, recipient }
  }

  releaseDelayedDeliveries() {
    for (const delivery of this.delayedMessages.splice(0)) delivery.socket.send(delivery.message)
  }

  socketCount() {
    return this.sockets.size
  }

  revoke(userID: string) {
    for (const [socket, owner] of this.sockets) {
      if (owner === userID) socket.send(JSON.stringify({ event: 'access.revoked', code: 'access_revoked' }))
    }
  }

  async install(context: BrowserContext, userID: string) {
    await context.routeWebSocket(/\/ws(?:\/whiteboards\/[^?]+)?(?:\?.*)?$/, socket => {
      const url = new URL(socket.url())
      if (url.pathname === '/ws') {
        socket.onMessage(() => undefined)
        return
      }
      this.sockets.set(socket, userID)
      socket.onMessage(raw => {
        let message: Record<string, any>
        try {
          message = JSON.parse(String(raw)) as Record<string, any>
        } catch {
          return
        }
        if (message.event === 'sync.request') {
          socket.send(JSON.stringify({ event: 'ack', sequence: this.sequence }))
          socket.send(JSON.stringify({
            event: 'presence.snapshot',
            data: [...this.sockets.values()].map(id => ({ kind: 'user', id, display_name: id, access: 'edit' })),
          }))
          return
        }
        if (message.event === 'cursor.update') {
          for (const [peer, owner] of this.sockets) {
            if (peer !== socket) peer.send(JSON.stringify({ ...message, actor: { kind: 'user', id: userID, display_name: userID, access: 'edit' } }))
          }
          return
        }
        if (message.event !== 'scene.patch' || typeof message.operation_id !== 'string') return
        const operationID = message.operation_id
        if (this.rejectPatchUserID === userID) {
          this.rejectPatchUserID = null
          this.patchAttempts.push({
            userID,
            operationID,
            baseSequence: Number.isInteger(message.base_sequence) ? message.base_sequence : -1,
            acceptedSequence: this.sequence,
          })
          socket.send(JSON.stringify({
            event: 'error',
            code: 'whiteboard_internal_error',
            error: 'simulated_correlated_write_error',
            operation_id: operationID,
          }))
          return
        }
        let operationSequence = this.operationSequences.get(operationID)
        if (operationSequence === undefined) {
          this.sequence += 1
          operationSequence = this.sequence
          this.operationSequences.set(operationID, operationSequence)
          const byID = new Map(this.elements.map(element => [String(element.id), element]))
          for (const element of Array.isArray(message.elements) ? message.elements : []) byID.set(String(element.id), clone(element))
          this.elements = [...byID.values()]
          for (const [peer, owner] of this.sockets) {
            if (peer === socket) continue
            this.deliveries.push({ recipient: owner, operationID })
            const outbound = JSON.stringify({
              event: 'scene.patch',
              sequence: operationSequence,
              operation_id: operationID,
              data: { elements: message.elements, app_state: message.app_state || {} },
            })
            if (this.delayedRule?.sender === userID && this.delayedRule.recipient === owner) {
              this.delayedRule = null
              this.delayedMessages.push({ recipient: owner, socket: peer, message: outbound })
            } else {
              peer.send(outbound)
            }
          }
        }
        this.patchAttempts.push({
          userID,
          operationID,
          baseSequence: Number.isInteger(message.base_sequence) ? message.base_sequence : -1,
          acceptedSequence: operationSequence,
        })
        if (this.loseAckUserID === userID) {
          this.loseAckUserID = null
          this.sockets.delete(socket)
          setTimeout(() => { void socket.close({ code: 1012, reason: 'simulated_lost_ack' }) }, 20)
          return
        }
        socket.send(JSON.stringify({
          event: 'ack',
          sequence: operationSequence,
          operation_id: operationID,
          data: { scene: this.sceneRecord().scene },
        }))
      })
    })
  }

  sceneRecord() {
    return {
      board_id: boardID,
      scene: {
        type: 'excalidraw', version: 2, source: 'clarin', elements: clone(this.elements),
        appState: { viewBackgroundColor: '#ffffff', gridModeEnabled: false, gridStep: 5 }, files: {},
      },
      scene_schema_version: 'excalidraw', editor_version: '0.18.1', sequence: this.sequence, updated_at: now,
    }
  }
}

function board(harness: WhiteboardRealtimeHarness) {
  return {
    id: boardID,
    name: 'Pizarra QA autónoma',
    folder_id: null,
    created_at: now,
    updated_at: now,
    access_mode: 'private',
    access_revision: 1,
    version: 1,
    scene_sequence: harness.sequence,
    effective_access: access,
  }
}

async function installWhiteboardHTTP(
  context: BrowserContext,
  harness: WhiteboardRealtimeHarness,
  userID: string,
  trace: Set<string>,
  blocked: string[],
  explicitNavigations: Set<string>,
) {
  await context.addCookies([{ name: 'auth-token', value: `whiteboard-${userID}`, url: baseURL, httpOnly: true, sameSite: 'Lax' }])
  await context.addInitScript(({ id }) => {
    localStorage.setItem('token', `whiteboard-${id}`)
    localStorage.setItem('clarin:last_activity_at', String(Date.now()))
    localStorage.setItem('clarin:auth_refreshed_at', String(Date.now()))
  }, { id: userID })

  await context.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    trace.add(url.href)
    if (url.origin !== new URL(baseURL).origin) {
      if (url.origin === explicitLinkOrigin && request.resourceType() === 'document') {
        explicitNavigations.add(url.href)
        await route.abort('blockedbyclient')
        return
      }
      blocked.push(url.href)
      await route.abort('blockedbyclient')
      return
    }
    if (!url.pathname.startsWith('/api/')) {
      // Next.js dev emits eval-based source maps. Keep the product CSP strict and
      // relax only the HTML response served by this opt-in local E2E server.
      if (request.resourceType() === 'document' && process.env.PLAYWRIGHT_LOCAL_SERVER === '1') {
        const response = await route.fetch()
        const headers = response.headers()
        const csp = headers['content-security-policy']
        if (csp) headers['content-security-policy'] = csp.replace("script-src 'self' 'unsafe-inline'", "script-src 'self' 'unsafe-inline' 'unsafe-eval'")
        await route.fulfill({ response, headers })
        return
      }
      await route.continue()
      return
    }

    if (url.pathname === '/api/me') {
      await json(route, {
        success: true,
        user: {
          id: userID, username: userID, display_name: userID, role: 'admin', is_admin: true, is_super_admin: false,
          account_id: 'account-whiteboard-qa', account_name: 'Cuenta QA', permissions: ['whiteboards'],
        },
        accounts: [{ account_id: 'account-whiteboard-qa', account_name: 'Cuenta QA', role: 'admin', is_default: true }],
      })
      return
    }
    if (url.pathname === '/api/whiteboards' && request.method() === 'GET') {
      await json(route, {
        success: true,
        whiteboards: [board(harness)],
        next_cursor: null,
        permissions: { can_create: true, can_create_folder: true },
        counts: { all: 1, mine: 1, shared: 0, recent: 1, trash: 0 },
      })
      return
    }
    if (url.pathname === '/api/whiteboards' && request.method() === 'POST') {
      const payload = request.postDataJSON() as Record<string, any>
      harness.createdBoardNames.push(String(payload.name || ''))
      await json(route, { success: true, whiteboard: { ...board(harness), name: String(payload.name || '') } }, 201)
      return
    }
    if (url.pathname === '/api/whiteboard-folders' && request.method() === 'GET') {
      await json(route, {
        success: true,
        folders: harness.createdFolders.map(folder => ({
          id: folder.id, name: folder.name, parent_id: folder.parentID, version: 1,
          created_at: now, updated_at: now, whiteboard_count: 0, effective_access: access,
        })),
        next_cursor: null,
      })
      return
    }
    if (url.pathname === '/api/whiteboard-folders' && request.method() === 'POST') {
      const payload = request.postDataJSON() as Record<string, any>
      const folder = {
        id: `folder-${harness.createdFolders.length + 1}`,
        name: String(payload.name || ''),
        parentID: typeof payload.parent_id === 'string' && payload.parent_id ? payload.parent_id : null,
      }
      harness.createdFolders.push(folder)
      await json(route, {
        success: true,
        folder: {
          id: folder.id, name: folder.name, parent_id: folder.parentID, version: 1,
          created_at: now, updated_at: now, whiteboard_count: 0, effective_access: access,
        },
      }, 201)
      return
    }
    if (url.pathname === `/api/whiteboards/${boardID}` && request.method() === 'GET') {
      await json(route, { success: true, whiteboard: board(harness) })
      return
    }
    if (url.pathname === `/api/whiteboards/${boardID}/scene` && request.method() === 'GET') {
      await json(route, { success: true, scene: harness.sceneRecord() })
      return
    }
    if (url.pathname === `/api/whiteboards/${boardID}/scene` && ['PATCH', 'PUT'].includes(request.method())) {
      const payload = request.postDataJSON() as Record<string, any>
      const idempotent = harness.recordHTTPSceneWrite(request.method(), payload)
      await json(route, { success: true, result: { scene: harness.sceneRecord(), idempotent } })
      return
    }
    if (url.pathname === `/api/whiteboards/${boardID}/assets` && request.method() === 'GET') {
      await json(route, { success: true, assets: [], next_cursor: null })
      return
    }
    if (url.pathname === `/api/whiteboards/${boardID}/assets` && request.method() === 'POST') {
      await json(route, {
        success: true,
        asset: { id: `thumbnail-${userID}`, board_id: boardID, file_id: 'thumbnail', kind: 'thumbnail', filename: 'thumbnail.png', content_type: 'image/png', size_bytes: 100, created_at: now },
        deduped: false,
        whiteboard: board(harness),
      }, 201)
      return
    }
    if (url.pathname === `/api/whiteboards/${boardID}/collab-ticket`) {
      harness.ticketReads.set(userID, (harness.ticketReads.get(userID) || 0) + 1)
      if (harness.shouldFailTicket(userID)) {
        await json(route, { success: false, error: 'simulated_ticket_failure' }, 503)
        return
      }
      await json(route, { success: true, ticket: `ticket-${userID}-${harness.ticketReads.get(userID)}` }, 201)
      return
    }
    if (url.pathname === '/api/whiteboard-libraries' && request.method() === 'GET') {
      await json(route, {
        success: true,
        libraries: [
          {
            id: `library-${userID}`, name: `Mi biblioteca · ${userID}`, description: '', library_json: { libraryItems: [] },
            visibility: 'private', version: 1, created_by: userID, updated_by: userID, created_at: now, updated_at: now,
          },
          {
            id: 'library-account-qa', name: 'Catálogo QA interno', description: 'Solo dentro de Clarin',
            library_json: { libraryItems: clone(libraryFixture.libraryItems) }, visibility: 'account', version: 1,
            created_by: 'account-admin', updated_by: 'account-admin', created_at: now, updated_at: now,
          },
        ],
        next_cursor: null,
      })
      return
    }
    if (decodeURIComponent(url.pathname) === `/api/whiteboard-libraries/library-${userID}` && request.method() === 'PUT') {
      const payload = request.postDataJSON() as Record<string, any>
      await json(route, {
        success: true,
        library: {
          id: `library-${userID}`,
          name: payload.name,
          description: payload.description || '',
          library_json: payload.library_json,
          visibility: 'private',
          version: Number(payload.expected_version || 1) + 1,
          created_by: userID,
          updated_by: userID,
          created_at: now,
          updated_at: now,
        },
      })
      return
    }
    if (url.pathname === '/api/tasks/stats') {
      await json(route, { success: true, stats: { overdue: 0, today: 0 } })
      return
    }
    if (url.pathname === '/api/version') {
      await json(route, { version: 'whiteboard-e2e' })
      return
    }
    if (url.pathname === '/api/eros/status') {
      await json(route, { success: true, available: false })
      return
    }
    await json(route, { success: true })
  })
}

async function openEditor(page: Page) {
  const browserErrors: string[] = []
  page.on('pageerror', error => browserErrors.push(error.message))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${baseURL}/dashboard/whiteboards/${boardID}`, { waitUntil: 'domcontentloaded' })
  try {
    await expect(page.getByLabel('Nombre de la pizarra')).toHaveValue('Pizarra QA autónoma', { timeout: 30_000 })
  } catch (cause) {
    const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 2_000)
    throw new Error(`El editor no llegó a ready en ${page.url()}. UI: ${JSON.stringify(body)}. Errores: ${JSON.stringify(browserErrors)}`, { cause })
  }
  await expect(page.locator('canvas.interactive')).toBeVisible({ timeout: 30_000 })
}

async function drawRectangle(page: Page, offset: number) {
  const surface = page.locator('.whiteboard-editor-shell .excalidraw').first()
  const box = await surface.boundingBox()
  expect(box).not.toBeNull()
  await page.getByTestId('toolbar-rectangle').check({ force: true })
  await expect(page.getByTestId('toolbar-rectangle')).toBeChecked()
  const startX = box!.x + box!.width * 0.44 + offset
  const startY = box!.y + box!.height * 0.42 + offset
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX + 130, startY + 80, { steps: 8 })
  await page.mouse.up()
  return { x: startX + 65, y: startY + 40 }
}

async function drawStandaloneText(page: Page, text: string, offset: number) {
  const surface = page.locator('.whiteboard-editor-shell .excalidraw').first()
  const box = await surface.boundingBox()
  expect(box).not.toBeNull()
  await page.getByTestId('toolbar-text').check({ force: true })
  await expect(page.getByTestId('toolbar-text')).toBeChecked()
  await page.mouse.click(box!.x + box!.width * 0.58 + offset, box!.y + box!.height * 0.32 + offset)
  await page.keyboard.type(text)
  await page.keyboard.press('Control+Enter')
}

async function drawDiamondWithBoundText(page: Page, text: string, offset: number) {
  const surface = page.locator('.whiteboard-editor-shell .excalidraw').first()
  const box = await surface.boundingBox()
  expect(box).not.toBeNull()
  await page.getByTestId('toolbar-diamond').check({ force: true })
  await expect(page.getByTestId('toolbar-diamond')).toBeChecked()
  const startX = box!.x + box!.width * 0.38 + offset
  const startY = box!.y + box!.height * 0.58 + offset
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX + 150, startY + 100, { steps: 8 })
  await page.mouse.up()
  await page.mouse.dblclick(startX + 75, startY + 50)
  await page.keyboard.type(text)
  await page.keyboard.press('Control+Enter')
}

async function exportEditableScene(page: Page) {
  await page.getByTestId('main-menu-trigger').click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByText('Archivo editable', { exact: true }).click()
  const download = await downloadPromise
  const path = await download.path()
  expect(path).not.toBeNull()
  return JSON.parse(readFileSync(path!, 'utf8')) as { elements: Array<Record<string, any>> }
}

async function expectEditorSaved(page: Page) {
  await expect(page.getByLabel('Guardado en Clarin')).toBeVisible({ timeout: 20_000 })
}

async function expectInsideViewport(page: Page, locator: ReturnType<Page['locator']>, label: string) {
  await expect(locator, `${label} debe seguir visible`).toBeVisible()
  const box = await locator.boundingBox()
  const viewport = page.viewportSize()
  expect(box, `${label} debe tener geometría medible`).not.toBeNull()
  expect(viewport, 'Playwright debe conocer el viewport').not.toBeNull()
  expect(box!.x, `${label} desborda por la izquierda`).toBeGreaterThanOrEqual(-1)
  expect(box!.y, `${label} desborda por arriba`).toBeGreaterThanOrEqual(-1)
  expect(box!.x + box!.width, `${label} desborda por la derecha`).toBeLessThanOrEqual(viewport!.width + 1)
  expect(box!.y + box!.height, `${label} desborda por abajo`).toBeLessThanOrEqual(viewport!.height + 1)
}

async function expectNoDocumentHorizontalOverflow(page: Page, label: string) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(dimensions.scrollWidth, `${label} no debe crear scroll horizontal global`).toBeLessThanOrEqual(dimensions.clientWidth + 1)
}

async function exerciseResponsiveEditor(page: Page) {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 760, height: 800 },
    { width: 1024, height: 768 },
    { width: 1220, height: 800 },
    { width: 1280, height: 800 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport)
    const suffix = `editor ${viewport.width}x${viewport.height}`
    await expectInsideViewport(page, page.locator('.whiteboard-editor-shell'), suffix)
    await expect(page.locator('.whiteboard-editor-shell > header')).toHaveCount(0)
    await expectInsideViewport(page, page.getByTestId('toolbar-rectangle'), `${suffix}: herramientas prioritarias`)
    await expectInsideViewport(page, page.getByLabel('Más acciones de Pizarras'), `${suffix}: más acciones`)
    await page.getByLabel('Más acciones de Pizarras').click()
    await expectInsideViewport(page, page.getByRole('menu', { name: 'Más acciones de Pizarras' }), `${suffix}: menú Más`)
    await expect(page.getByRole('menu', { name: 'Más acciones de Pizarras' })).toContainText('Pizarra QA autónoma')
    await expect(page.getByRole('menuitem', { name: 'Biblioteca', exact: true })).toBeVisible()
    if (viewport.width < 1_100) await expect(page.getByRole('menuitem', { name: 'Volver a Pizarras' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expectInsideViewport(page, page.getByTestId('main-menu-trigger'), `${suffix}: menú`)
    await expectInsideViewport(page, page.locator('canvas.interactive'), `${suffix}: lienzo`)
    await expect(page.locator('.whiteboard-editor-shell iframe'), `${suffix}: ningún embed debe crear iframe`).toHaveCount(0)
    await expectNoDocumentHorizontalOverflow(page, suffix)
  }
  for (const viewport of [
    { width: 1800, height: 900 },
  ]) {
    await page.setViewportSize(viewport)
    const suffix = `editor ${viewport.width}x${viewport.height}`
    await expect(page.locator('.whiteboard-editor-shell')).toHaveAttribute('data-whiteboard-layout', 'wide')
    await expect(page.locator('.whiteboard-editor-shell > header')).toHaveCount(0)
    await expectInsideViewport(page, page.locator('.whiteboard-integrated-title'), `${suffix}: título integrado`)
    await expectInsideViewport(page, page.locator('.whiteboard-editor-shell .shapes-section'), `${suffix}: herramientas nativas`)
    const titleBox = await page.locator('.whiteboard-integrated-title').boundingBox()
    const toolsBox = await page.locator('.whiteboard-editor-shell .shapes-section').boundingBox()
    expect(titleBox).not.toBeNull()
    expect(toolsBox).not.toBeNull()
    expect(Math.abs(titleBox!.y - toolsBox!.y), 'título y herramientas deben compartir la fila superior').toBeLessThanOrEqual(20)
    await expectNoDocumentHorizontalOverflow(page, suffix)
  }
  await page.setViewportSize({ width: 1440, height: 900 })
}

async function exerciseResponsiveManager(page: Page) {
  await expect(page.getByRole('heading', { name: 'Mis pizarras' })).toBeVisible({ timeout: 20_000 })
  for (const viewport of [{ width: 390, height: 844 }, { width: 1024, height: 768 }]) {
    await page.setViewportSize(viewport)
    const suffix = `gestor ${viewport.width}x${viewport.height}`
    await expectInsideViewport(page, page.locator('section[aria-labelledby="whiteboards-title"]'), suffix)
    await expectInsideViewport(page, page.getByRole('heading', { name: 'Mis pizarras' }), `${suffix}: título`)
    await expectInsideViewport(page, page.getByLabel('Actualizar pizarras'), `${suffix}: actualizar`)
    await expectInsideViewport(page, page.getByRole('button', { name: 'Nueva pizarra' }).first(), `${suffix}: nueva pizarra`)
    await expectInsideViewport(page, page.getByPlaceholder('Buscar por nombre, carpeta o propietario…'), `${suffix}: buscar`)
    await expectInsideViewport(page, page.getByLabel('Vista de cuadrícula'), `${suffix}: cuadrícula`)
    await expect(page.locator('iframe'), `${suffix}: el gestor no debe depender de iframe`).toHaveCount(0)
    await expectNoDocumentHorizontalOverflow(page, suffix)
  }
}

async function exerciseManagerCreateDialogFocus(page: Page, harness: WhiteboardRealtimeHarness) {
  await page.setViewportSize({ width: 1024, height: 768 })
  const folderTrigger = page.getByRole('button', { name: 'Crear carpeta' })
  await folderTrigger.click()
  const folderDialog = page.getByRole('dialog', { name: 'Nueva carpeta' })
  const folderInput = folderDialog.getByPlaceholder('Ej. Operaciones')
  await expect(folderInput).toBeFocused()
  await folderInput.pressSequentially('Carpeta completa', { delay: 8 })
  await expect(folderInput).toHaveValue('Carpeta completa')
  await expect(folderInput).toBeFocused()
  await folderInput.press('Enter')
  await expect(folderDialog).toBeHidden()
  expect(harness.createdFolders.at(-1)).toMatchObject({ name: 'Carpeta completa', parentID: null })

  await page.getByRole('button', { name: 'Carpeta completa' }).click()
  await page.getByRole('button', { name: 'Crear subcarpeta' }).click()
  const subfolderDialog = page.getByRole('dialog', { name: 'Nueva subcarpeta' })
  const subfolderInput = subfolderDialog.getByPlaceholder('Ej. Operaciones')
  await expect(subfolderInput).toBeFocused()
  await subfolderInput.pressSequentially('Subcarpeta completa', { delay: 8 })
  await expect(subfolderInput).toHaveValue('Subcarpeta completa')
  await expect(subfolderInput).toBeFocused()
  await subfolderInput.press('Enter')
  await expect(subfolderDialog).toBeHidden()
  expect(harness.createdFolders.at(-1)).toMatchObject({ name: 'Subcarpeta completa', parentID: 'folder-1' })

  await page.getByRole('button', { name: 'Nueva pizarra' }).first().click()
  const boardDialog = page.getByRole('dialog', { name: 'Nueva pizarra' })
  const boardInput = boardDialog.getByPlaceholder('Ej. Flujo de atención')
  await expect(boardInput).toBeFocused()
  await boardInput.pressSequentially('Pizarra completa', { delay: 8 })
  await expect(boardInput).toHaveValue('Pizarra completa')
  await expect(boardInput).toBeFocused()
  await boardInput.press('Enter')
  await expect.poll(() => harness.createdBoardNames.at(-1)).toBe('Pizarra completa')
  await expect(page).toHaveURL(`${baseURL}/dashboard/whiteboards/${boardID}`)
  await page.goto(`${baseURL}/dashboard/whiteboards`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'Mis pizarras' })).toBeVisible({ timeout: 20_000 })
}

async function captureVisibleBrandingSurface(page: Page, name: string): Promise<VisibleBrandingSurface> {
  return await page.evaluate(surfaceName => {
    const visible = (element: Element) => {
      const node = element as HTMLElement
      const style = window.getComputedStyle(node)
      const bounds = node.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0
        && bounds.width > 0 && bounds.height > 0
    }
    const actions = Array.from(document.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [role="button"], [role="menuitem"], [role="link"]'))
      .filter(visible)
      .map(element => ({
        text: (element.innerText || element.textContent || '').trim(),
        accessibleName: element.getAttribute('aria-label') || element.getAttribute('title') || (element.innerText || '').trim(),
        ariaLabel: element.getAttribute('aria-label') || '',
        label: element.getAttribute('label') || '',
        title: element.getAttribute('title') || '',
        testId: element.getAttribute('data-testid') || '',
        classNames: Array.from(element.classList),
        href: element instanceof HTMLAnchorElement ? element.href : '',
      }))
    return {
      name: surfaceName,
      visibleText: [(document.body.innerText || '').trim()],
      visibleActions: actions,
    }
  }, name)
}

async function exerciseHelpAndInternalLibraries(page: Page) {
  await page.locator('.whiteboard-editor-shell .excalidraw').first().click({ position: { x: 700, y: 520 } })
  await expect(page.locator('.help-icon')).toBeHidden()
  await expect(page.getByTestId('help-menu-item')).toBeHidden()
  await page.keyboard.press('Shift+/')
  await expect(page.locator('.HelpDialog')).toBeHidden()

  const directLibraryAdmin = page.getByLabel('Administrar bibliotecas de Clarin')
  if (await directLibraryAdmin.isVisible()) {
    await directLibraryAdmin.click()
  } else {
    await page.getByLabel('Más acciones de Pizarras').click()
    await page.getByRole('menuitem', { name: 'Administrar bibliotecas' }).click()
  }
  const dialog = page.getByRole('dialog', { name: 'Bibliotecas de Pizarras' })
  await expect(dialog).toBeVisible()
  const accountCatalog = dialog.locator('article').filter({ hasText: 'Catálogo QA interno' })
  await expect(accountCatalog).toBeVisible()
  await expect(accountCatalog).toContainText('Administrable')
  await expect(accountCatalog).toContainText('2 elementos')
  await dialog.getByLabel('Cerrar').click()

  const nativeLibraryToggle = page.getByRole('checkbox', { name: 'Biblioteca' })
  const moreActions = page.getByLabel('Más acciones de Pizarras')
  if (await moreActions.isVisible()) {
    await moreActions.click()
    await page.getByRole('menuitem', { name: 'Biblioteca', exact: true }).click()
  } else {
    await nativeLibraryToggle.click()
  }
  await expect(page.locator('.library-menu-items-container')).toBeVisible()
  await expect(page.locator('.library-menu-browse-button')).toBeHidden()
  await expect(page.getByTestId('lib-dropdown--remove')).toBeHidden()
  await expect(page.getByText('Publica tu propia biblioteca', { exact: true })).toBeHidden()
  await expect(page.getByTestId('toolbar-embeddable')).toBeHidden()
  await expect(page.getByTestId('toolbar-magicframe')).toBeHidden()
}

async function exerciseExplicitHTTPLink(page: Page, context: BrowserContext) {
  await drawRectangle(page, 108)
  await page.keyboard.press('Control+k')
  const input = page.locator('.excalidraw-hyperlinkContainer-input')
  await expect(input).toBeVisible()
  await input.fill(`${explicitLinkOrigin}/manual`)
  await input.press('Enter')
  const anchor = page.locator('.excalidraw-hyperlinkContainer-link')
  await expect(anchor).toHaveAttribute('href', `${explicitLinkOrigin}/manual`)
  const popupPromise = context.waitForEvent('page')
  await anchor.click()
  const popup = await popupPromise
  await popup.waitForLoadState('domcontentloaded', { timeout: 3_000 }).catch(() => undefined)
  await popup.close().catch(() => undefined)
}

async function importLocalSceneWithBlockedEmbed(page: Page, harness: WhiteboardRealtimeHarness) {
  const imported = clone(sceneFixture)
  const template = clone(imported.elements.find((element: Record<string, any>) => element.type === 'rectangle'))
  template.id = 'blocked-external-embed'
  template.type = 'embeddable'
  template.x = 850
  template.y = 80
  template.width = 320
  template.height = 180
  template.link = 'https://embed.whiteboard.invalid/widget'
  template.boundElements = null
  template.containerId = null
  template.frameId = null
  template.customData = { clarin: { egressFixture: true } }
  imported.elements = [...imported.elements, template]
  const writesBefore = harness.httpSceneWrites.length

  await page.getByTestId('main-menu-trigger').click()
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByText('Importar archivo', { exact: true }).click()
  const chooser = await chooserPromise
  await chooser.setFiles({
    name: 'local-egress-fixture.excalidraw',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(imported)),
  })
  await expect.poll(() => harness.httpSceneWrites.length, { timeout: 30_000 }).toBeGreaterThan(writesBefore)
  await expect(page.locator('.whiteboard-editor-shell iframe')).toHaveCount(0)
  const exported = await exportEditableScene(page)
  expect(exported.elements.map(element => element.id)).toContain('blocked-external-embed')
  expect(exported.elements.map(element => element.id)).toContain('frame-operaciones')
}

test('Pizarras stays same-origin and survives two-user lost-ACK reconnect plus revocation', async ({ browser, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'El gate determinista usa dos contextos Chromium; la matriz visual cubre los demás motores.')
  test.setTimeout(150_000)
  const harness = new WhiteboardRealtimeHarness()
  const requests = new Set<string>()
  const webSockets = new Set<string>()
  const blocked: string[] = []
  const explicitNavigations = new Set<string>()
  const requestFailures: Array<{ url: string; error: string }> = []
  const pageErrors: Array<{ page: string; error: string }> = []
  const fontResponses: Array<{ url: string; status: number }> = []
  const sceneConflicts: string[] = []
  const cspViolations: string[] = []
  const visibleBrandingSurfaces: VisibleBrandingSurface[] = []
  const unexpectedDialogs: string[] = []
  const firstContext = await browser.newContext()
  const secondContext = await browser.newContext()
  await harness.install(firstContext, 'Ana QA')
  await harness.install(secondContext, 'Luis QA')
  await installWhiteboardHTTP(firstContext, harness, 'Ana QA', requests, blocked, explicitNavigations)
  await installWhiteboardHTTP(secondContext, harness, 'Luis QA', requests, blocked, explicitNavigations)
  const first = await firstContext.newPage()
  const second = await secondContext.newPage()
  for (const page of [first, second]) {
    page.on('request', request => requests.add(request.url()))
    page.on('requestfailed', request => requestFailures.push({ url: request.url(), error: request.failure()?.errorText || 'unknown' }))
    page.on('response', response => {
      const path = new URL(response.url()).pathname
      if (path.startsWith('/vendor/whiteboards-editor/0.18.1/fonts/')) {
        fontResponses.push({ url: response.url(), status: response.status() })
      }
      if (response.status() === 409 && /\/api\/whiteboards\/[^/]+\/scene$/.test(path)) sceneConflicts.push(response.url())
    })
    page.on('pageerror', error => pageErrors.push({ page: page === first ? 'Ana QA' : 'Luis QA', error: error.message }))
    page.on('websocket', socket => webSockets.add(socket.url()))
    page.on('console', message => {
      if (/content security policy|refused to (?:connect|load|frame)/i.test(message.text())) cspViolations.push(message.text())
    })
  }

  try {
    await test.step('abre dos editores y conecta la sala', async () => {
      await Promise.all([openEditor(first), openEditor(second)])
      await expect.poll(() => harness.socketCount()).toBe(2)
      await expect.poll(
        () => fontResponses.filter(response => response.status === 200).length,
        { timeout: 20_000 },
      ).toBeGreaterThan(0)
    })

    await test.step('crea texto y texto ligado a un rombo con fuentes locales y guardado durable', async () => {
      await drawStandaloneText(first, 'Texto QA local', 0)
      await drawDiamondWithBoundText(first, 'Decisión QA', 0)
      await expectEditorSaved(first)
      const exported = await exportEditableScene(first)
      const standaloneText = exported.elements.find(element => element.type === 'text' && element.originalText === 'Texto QA local')
      const boundText = exported.elements.find(element => element.type === 'text' && element.originalText === 'Decisión QA')
      expect(standaloneText?.containerId).toBeNull()
      expect(typeof boundText?.containerId).toBe('string')
      expect(exported.elements.some(element => element.id === boundText?.containerId && element.type === 'diamond')).toBe(true)
      expect(harness.elements.some(element => element.id === standaloneText?.id)).toBe(true)
      expect(harness.elements.some(element => element.id === boundText?.id)).toBe(true)
      expect(harness.patchAttempts[0]).toMatchObject({ baseSequence: 0, acceptedSequence: 1 })
      expect(sceneConflicts).toEqual([])
    })

    await test.step('reintenta el mismo operation_id tras perder el ACK', async () => {
      const attemptsBeforeLostAck = harness.patchAttempts.filter(item => item.userID === 'Ana QA').length
      const writesBeforeLostAck = harness.httpSceneWrites.length
      harness.loseNextAckFor('Ana QA')
      await drawRectangle(first, 0)
      await expect.poll(() => harness.patchAttempts.filter(item => item.userID === 'Ana QA').length, { timeout: 10_000 }).toBeGreaterThan(attemptsBeforeLostAck)
      await expect.poll(() => harness.httpSceneWrites.length, { timeout: 20_000 }).toBeGreaterThan(writesBeforeLostAck)
      const anaAttempts = harness.patchAttempts.filter(item => item.userID === 'Ana QA').slice(attemptsBeforeLostAck)
      expect(new Set(anaAttempts.map(item => item.operationID)).size).toBe(1)
      expect(harness.httpSceneWrites.at(-1)?.operationID).toBe(anaAttempts[0].operationID)
      expect(harness.deliveries.some(item => item.recipient === 'Luis QA' && item.operationID === anaAttempts[0].operationID)).toBe(true)
      await expectEditorSaved(first)
      await expect.poll(() => harness.socketCount(), { timeout: 30_000 }).toBe(2)
    })

    await test.step('un error WebSocket correlacionado activa REST sin esperar el timeout', async () => {
      const attemptsBeforeError = harness.patchAttempts.filter(item => item.userID === 'Ana QA').length
      const writesBeforeError = harness.httpSceneWrites.length
      harness.rejectNextPatchFor('Ana QA')
      await drawRectangle(first, 18)
      await expect.poll(
        () => harness.patchAttempts.filter(item => item.userID === 'Ana QA').length,
        { timeout: 10_000 },
      ).toBeGreaterThan(attemptsBeforeError)
      await expect.poll(() => harness.httpSceneWrites.length, { timeout: 10_000 }).toBeGreaterThan(writesBeforeError)
      const realtimeOperationID = harness.patchAttempts.filter(item => item.userID === 'Ana QA').at(-1)!.operationID
      expect(harness.httpSceneWrites.at(-1)?.operationID).toBe(realtimeOperationID)
      await expectEditorSaved(first)
    })

    await test.step('reconcilia un ACK canónico contra una base antigua', async () => {
      const anaAttemptsBeforeRace = harness.patchAttempts.filter(item => item.userID === 'Ana QA').length
      harness.delayNextDelivery('Luis QA', 'Ana QA')
      await drawRectangle(second, 36)
      await expect.poll(() => harness.patchAttempts.some(item => item.userID === 'Luis QA'), { timeout: 30_000 }).toBe(true)
      await expectEditorSaved(second)
      const sequenceAfterLuis = harness.sequence

      await drawRectangle(first, 72)
      await expect.poll(() => harness.patchAttempts.filter(item => item.userID === 'Ana QA').length, { timeout: 30_000 }).toBeGreaterThan(anaAttemptsBeforeRace)
      await expectEditorSaved(first)
      const rebasedAttempt = harness.patchAttempts.filter(item => item.userID === 'Ana QA').at(-1)!
      expect(rebasedAttempt.baseSequence).toBeLessThan(sequenceAfterLuis)
      const exportedAfterRebase = await exportEditableScene(first)
      expect(exportedAfterRebase.elements.map(element => element.id).sort()).toEqual(harness.elements.map(element => String(element.id)).sort())
      harness.releaseDelayedDeliveries()
    })

    await test.step('sale de Cambios pendientes por HTTP si la sala no consigue reconectar', async () => {
      const attemptsBeforeFailure = harness.patchAttempts.filter(item => item.userID === 'Luis QA').length
      const writesBeforeFailure = harness.httpSceneWrites.length
      const ticketsBeforeFailure = harness.ticketReads.get('Luis QA') || 0
      harness.failTicketsFor('Luis QA')
      harness.loseNextAckFor('Luis QA')
      await drawRectangle(second, 104)
      await expect.poll(
        () => harness.patchAttempts.filter(item => item.userID === 'Luis QA').length,
        { timeout: 20_000 },
      ).toBeGreaterThan(attemptsBeforeFailure)
      await expect.poll(() => harness.httpSceneWrites.length, { timeout: 30_000 }).toBeGreaterThan(writesBeforeFailure)
      const realtimeOperationID = harness.patchAttempts.filter(item => item.userID === 'Luis QA').at(-1)!.operationID
      expect(harness.httpSceneWrites.at(-1)?.operationID).toBe(realtimeOperationID)
      await expectEditorSaved(second)
      harness.restoreTicketsFor('Luis QA')
      await expect.poll(() => harness.ticketReads.get('Luis QA') || 0, { timeout: 30_000 }).toBeGreaterThan(ticketsBeforeFailure)
      await expect.poll(() => harness.socketCount(), { timeout: 30_000 }).toBe(2)
    })

    await test.step('oculta ayuda nativa y publicación; abre sólo bibliotecas internas', async () => {
      await exerciseHelpAndInternalLibraries(first)
    })

    await test.step('abre un enlace http sólo por acción explícita', async () => {
      const patchesBeforeLink = harness.patchAttempts.filter(item => item.userID === 'Ana QA').length
      await exerciseExplicitHTTPLink(first, firstContext)
      await expect.poll(() => explicitNavigations.size, { timeout: 10_000 }).toBe(1)
      await expect.poll(() => harness.patchAttempts.filter(item => item.userID === 'Ana QA').length, { timeout: 20_000 }).toBeGreaterThan(patchesBeforeLink)
      await expectEditorSaved(first)
    })

    await test.step('importa y exporta localmente manteniendo un embed heredado inerte', async () => {
      await importLocalSceneWithBlockedEmbed(first, harness)
    })

    await test.step('mantiene el editor dentro del viewport móvil y tablet', async () => {
      await exerciseResponsiveEditor(first)
      visibleBrandingSurfaces.push(await captureVisibleBrandingSurface(first, 'editor-autenticado'))
    })

    await test.step('guarda antes de abandonar la pizarra por navegación SPA', async () => {
      const writesBeforeNavigation = harness.httpSceneWrites.length
      first.once('dialog', async dialog => {
        unexpectedDialogs.push(dialog.message())
        await dialog.accept()
      })
      await drawRectangle(first, 144)
      await first.getByLabel('Volver a Pizarras').click()
      await expect.poll(() => harness.httpSceneWrites.length, { timeout: 20_000 }).toBeGreaterThan(writesBeforeNavigation)
      await expect(first).toHaveURL(`${baseURL}/dashboard/whiteboards`, { timeout: 30_000 })
      expect(unexpectedDialogs).toEqual([])
    })

    await test.step('mantiene el gestor dentro del viewport móvil y tablet', async () => {
      await exerciseResponsiveManager(first)
      await exerciseManagerCreateDialogFocus(first, harness)
      visibleBrandingSurfaces.push(await captureVisibleBrandingSurface(first, 'gestor-pizarras'))
    })

    await test.step('cierra inmediatamente la sesión revocada', async () => {
      harness.revoke('Luis QA')
      await expect(second.getByRole('heading', { name: 'No se pudo abrir la pizarra' })).toBeVisible()
      await expect(second.getByText('Tu acceso a esta pizarra fue revocado.')).toBeVisible()
    })

    const tracedURLs = [...new Set([...requests, ...webSockets])].sort()
    const forbiddenHosts = /(?:^|\.)(?:excalidraw\.com|esm\.sh|firebaseio\.com|firebaseapp\.com|googleapis\.com|gstatic\.com|sentry\.io|youtube\.com|youtu\.be|vimeo\.com|githubusercontent\.com)$/i
    expect(blocked).toEqual([])
    expect(explicitNavigations.size).toBe(1)
    expect([...requests].some(rawURL => new URL(rawURL).hostname === 'embed.whiteboard.invalid')).toBe(false)
    expect(cspViolations).toEqual([])
    expect(pageErrors).toEqual([])
    expect(fontResponses.length).toBeGreaterThan(0)
    expect(fontResponses.every(response => response.status === 200)).toBe(true)
    for (const rawURL of tracedURLs) {
      const url = new URL(rawURL)
      expect(url.hostname).not.toMatch(forbiddenHosts)
      if (url.origin === explicitLinkOrigin) continue
      if (url.protocol === 'blob:' || url.protocol === 'data:') continue
      expect(url.host).toBe(new URL(baseURL).host)
    }

    const trace = {
      generatedAt: new Date().toISOString(),
      requests: [...requests].sort(),
      webSockets: [...webSockets].sort(),
      requestFailures,
      cspViolations,
      explicitNavigations: [...explicitNavigations].sort(),
      blocked,
    }
    const traceBody = Buffer.from(`${JSON.stringify(trace, null, 2)}\n`)
    await testInfo.attach('whiteboard-network-trace.json', { body: traceBody, contentType: 'application/json' })
    if (process.env.WHITEBOARD_EGRESS_TRACE) writeFileSync(process.env.WHITEBOARD_EGRESS_TRACE, traceBody)
    const brandingBody = Buffer.from(`${JSON.stringify({ schemaVersion: 1, surfaces: visibleBrandingSurfaces }, null, 2)}\n`)
    await testInfo.attach('whiteboard-visible-branding.json', { body: brandingBody, contentType: 'application/json' })
    if (process.env.WHITEBOARD_BRANDING_SNAPSHOT) writeFileSync(process.env.WHITEBOARD_BRANDING_SNAPSHOT, brandingBody)
  } finally {
    await Promise.allSettled([firstContext.close(), secondContext.close()])
  }
})
