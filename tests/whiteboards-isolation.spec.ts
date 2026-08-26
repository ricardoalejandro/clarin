import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type BrowserContext, type Locator, type Page, type Request, type Route, type TestInfo, type WebSocketRoute } from '@playwright/test'

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3011'
const boardID = '10000000-0000-4000-8000-000000000001'
const workViewID = '10000000-0000-4000-8000-000000000101'
const workEnvironmentID = '10000000-0000-4000-8000-000000000102'
const workListID = '10000000-0000-4000-8000-000000000103'
const now = '2026-08-09T06:00:00.000Z'
const explicitLinkOrigin = 'http://whiteboard-link.invalid'
const fixtureRoot = resolve(process.cwd(), '.codex/skills/clarin-excalidraw-development/assets/compat-fixtures/v0.18.1')
const sceneFixture = JSON.parse(readFileSync(resolve(fixtureRoot, 'complex-scene.excalidraw'), 'utf8')) as Record<string, any>
const imageImportFixture = JSON.parse(readFileSync(resolve(fixtureRoot, 'image-import.excalidraw'), 'utf8')) as Record<string, any>
const libraryFixture = JSON.parse(readFileSync(resolve(fixtureRoot, 'internal-library.excalidrawlib'), 'utf8')) as { libraryItems: Array<Record<string, any>> }
const imageElementFixture = imageImportFixture.elements[0] as Record<string, any>
const imageFixtureDataURL = String(imageImportFixture.files[imageElementFixture.fileId].dataURL)
const imageFixtureBytes = Buffer.from(imageFixtureDataURL.slice(imageFixtureDataURL.indexOf(',') + 1), 'base64')

function recordWhiteboardRequestFailure(
  failures: Array<{ url: string; error: string }>,
  request: Request,
) {
  const error = request.failure()?.errorText || 'unknown'
  const url = new URL(request.url())
  const path = url.pathname
  const expectedDevelopmentReloadAbort = process.env.PLAYWRIGHT_LOCAL_SERVER === '1'
    && error === 'net::ERR_ABORTED'
    && path.startsWith('/_next/static/webpack/')
    && (path.endsWith('.hot-update.js') || path.endsWith('.hot-update.json'))
  const expectedNextPrefetchAbort = error === 'net::ERR_ABORTED'
    && url.origin === new URL(baseURL).origin
    && url.searchParams.has('_rsc')
    && path.startsWith('/dashboard')
  if (!expectedDevelopmentReloadAbort && !expectedNextPrefetchAbort) failures.push({ url: request.url(), error })
}

test.describe.configure({ mode: 'serial' })
test.use({ serviceWorkers: 'block' })

test('el acceso compartido mantiene nombre, contraseña y cursor legibles', async ({ page }) => {
  test.setTimeout(90_000)
  await page.route('**/*', async route => {
    const request = route.request()
    if (request.resourceType() !== 'document') {
      await route.continue()
      return
    }
    const response = await route.fetch()
    const headers = response.headers()
    const csp = headers['content-security-policy']
    if (csp) headers['content-security-policy'] = csp.replace("script-src 'self' 'unsafe-inline'", "script-src 'self' 'unsafe-inline' 'unsafe-eval'")
    await route.fulfill({ response, headers })
  })
  await page.goto(`${baseURL}/shared/whiteboards/contrast-qa#secret`, { waitUntil: 'domcontentloaded' })

  const name = page.getByRole('textbox', { name: 'Tu nombre' })
  const password = page.getByLabel('Contraseña, si fue configurada')
  await expect(name).toBeVisible({ timeout: 30_000 })
  await name.fill('Marta')
  await password.fill('secreto')
  await expect(name).toHaveValue('Marta')
  await expect(password).toHaveValue('secreto')

  for (const input of [name, password]) {
    const colors = await input.evaluate(element => {
      const style = getComputedStyle(element)
      return {
        text: style.color,
        caret: style.caretColor,
        background: style.backgroundColor,
      }
    })
    expect(colors.text).toBe('rgb(241, 245, 249)')
    expect(colors.caret).toBe('rgb(241, 245, 249)')
    expect(colors.background).toBe('rgb(2, 6, 23)')
  }
})

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
  can_comment: true,
  can_edit: true,
  can_manage_access: true,
}

function actorIDFor(userID: string) {
  return userID === 'Luis QA'
    ? '10000000-0000-4000-8000-000000000012'
	: userID === 'Marta QA'
	  ? '10000000-0000-4000-8000-000000000013'
	  : userID === 'Marta Invitada'
		? '10000000-0000-4000-8000-000000000014'
    : '10000000-0000-4000-8000-000000000011'
}

function personalLibraryIDFor(userID: string) {
  return userID === 'Luis QA'
    ? '20000000-0000-4000-8000-000000000012'
	: userID === 'Marta QA'
	  ? '20000000-0000-4000-8000-000000000013'
    : '20000000-0000-4000-8000-000000000011'
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
  effectiveAccess = { ...access }
  elements: Array<Record<string, unknown>> = [clone(loadedTextFixture)]
  appState: Record<string, unknown> = { viewBackgroundColor: '#ffffff', gridModeEnabled: false, gridStep: 5 }
  readonly patchAttempts: Array<{ userID: string; operationID: string; baseSequence: number; acceptedSequence: number }> = []
  readonly scenePatches: Array<{
    userID: string
    operationID: string
    elements: Array<Record<string, unknown>>
  }> = []
  readonly deliveries: Array<{ recipient: string; operationID: string }> = []
  readonly httpSceneWrites: Array<{ method: string; operationID: string }> = []
  assetUploads = 0
  readonly assets = new Map<string, {
    id: string
    board_id: string
    file_id: string
    kind: string
    filename: string
    content_type: string
    size_bytes: number
    created_at: string
  }>()
  readonly ticketReads = new Map<string, number>()
  readonly createdBoardNames: string[] = []
  readonly createdFolders: Array<{ id: string; name: string; parentID: string | null }> = []
  readonly boardMoves: Array<{ folderID: string | null; expectedVersion: number }> = []
  readonly folderMoves: Array<{ folderID: string; parentID: string | null; beforeFolderID: string | null; expectedVersion: number }> = []
  boardFolderID: string | null = null
  boardVersion = 1
  private readonly sockets = new Map<WebSocketRoute, string>()
  private readonly operationSequences = new Map<string, number>()
  private delayedRule: { sender: string; recipient: string } | null = null
  private readonly delayedMessages: Array<{ recipient: string; socket: WebSocketRoute; message: string }> = []
  private loseAckUserID: string | null = null
  private rejectPatchUserID: string | null = null
  private readonly failingTicketUsers = new Set<string>()
  private nextBoardMoveFailure: number | null = null
	private activePresentation: { presentation_id: string; actor: Record<string, string>; started_at: string } | null = null
	readonly viewportDeliveries: Array<{ sender: string; bounds: number[] }> = []
	readonly followChanges: Array<{ sender: string; target: string; action: string }> = []

  failNextBoardMove(status: number) {
    this.nextBoardMoveFailure = status
  }

  consumeBoardMoveFailure() {
    const status = this.nextBoardMoveFailure
    this.nextBoardMoveFailure = null
    return status
  }

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

  interruptAuthorization(userID: string) {
    for (const [socket, owner] of this.sockets) {
      if (owner !== userID) continue
      socket.send(JSON.stringify({
        event: 'error',
        code: 'authorization_unavailable',
        error: 'No se pudo comprobar temporalmente el acceso.',
      }))
      setTimeout(() => { void socket.close({ code: 1013, reason: 'authorization_unavailable' }) }, 20)
    }
  }

  broadcastAutomaticSnapshot() {
    this.sequence += 1
    const record = this.sceneRecord()
    const message = JSON.stringify({
      event: 'scene.snapshot',
      sequence: this.sequence,
      data: {
        scene: record.scene,
        scene_schema_version: record.scene_schema_version,
        editor_version: record.editor_version,
        updated_at: record.updated_at,
      },
    })
    for (const socket of this.sockets.keys()) socket.send(message)
  }

  async install(context: BrowserContext, userID: string) {
    await context.routeWebSocket(/\/ws(?:\/whiteboards\/[^?]+)?(?:\?.*)?$/, socket => {
      const url = new URL(socket.url())
      if (url.pathname === '/ws') {
        socket.onMessage(() => undefined)
        return
      }
      this.sockets.set(socket, userID)
	  socket.onClose(() => {
		this.sockets.delete(socket)
		if (this.activePresentation?.actor.id === actorIDFor(userID)) {
		  const presentationID = this.activePresentation.presentation_id
		  this.activePresentation = null
		  const stopped = JSON.stringify({ event: 'presentation.changed', data: { presentation_id: presentationID, status: 'stopped', reason: 'presenter_left' } })
		  for (const peer of this.sockets.keys()) peer.send(stopped)
		}
	  })
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
			event: 'room.ready',
			actor: { kind: 'user', id: actorIDFor(userID), display_name: userID, access: 'edit' },
			data: { actor_id: actorIDFor(userID) },
		  }))
		  const presenceSnapshot = JSON.stringify({
			event: 'presence.snapshot',
			data: [...this.sockets.values()].map(id => ({ kind: 'user', id: actorIDFor(id), display_name: id, access: 'edit' })),
		  })
		  for (const peer of this.sockets.keys()) peer.send(presenceSnapshot)
		  socket.send(JSON.stringify({ event: 'presentation.snapshot', data: { presentation: this.activePresentation } }))
          return
        }
        if (message.event === 'cursor.update') {
          for (const [peer, owner] of this.sockets) {
			if (peer !== socket) peer.send(JSON.stringify({ ...message, actor: { kind: 'user', id: actorIDFor(userID), display_name: userID, access: 'edit' } }))
          }
          return
        }
		if (message.event === 'presentation.start' && typeof message.operation_id === 'string') {
		  if (this.activePresentation && this.activePresentation.actor.id !== actorIDFor(userID)) {
			socket.send(JSON.stringify({ event: 'error', operation_id: message.operation_id, code: 'presentation_occupied', error: 'Otra persona ya está presentando' }))
			return
		  }
		  this.activePresentation = this.activePresentation || {
			presentation_id: message.operation_id,
			actor: { kind: 'user', id: actorIDFor(userID), display_name: userID, access: 'edit' },
			started_at: new Date().toISOString(),
		  }
		  socket.send(JSON.stringify({ event: 'ack', operation_id: message.operation_id, data: { presentation: this.activePresentation } }))
		  const changed = JSON.stringify({ event: 'presentation.changed', actor: this.activePresentation.actor, data: { presentation: this.activePresentation, status: 'started' } })
		  for (const peer of this.sockets.keys()) peer.send(changed)
		  return
		}
		if (message.event === 'presentation.stop' && typeof message.operation_id === 'string') {
		  const presentationID = String(message.data?.presentation_id || '')
		  if (!this.activePresentation || this.activePresentation.presentation_id !== presentationID || this.activePresentation.actor.id !== actorIDFor(userID)) {
			socket.send(JSON.stringify({ event: 'error', operation_id: message.operation_id, code: 'presentation_not_owned', error: 'La presentación activa pertenece a otra persona' }))
			return
		  }
		  this.activePresentation = null
		  const stopped = JSON.stringify({ event: 'presentation.changed', actor: { kind: 'user', id: actorIDFor(userID), display_name: userID, access: 'edit' }, data: { presentation_id: presentationID, status: 'stopped', reason: 'presenter_stopped' } })
		  for (const peer of this.sockets.keys()) peer.send(stopped)
		  socket.send(JSON.stringify({ event: 'ack', operation_id: message.operation_id, data: { presentation_id: presentationID, stopped: true } }))
		  return
		}
		if (message.event === 'follow.change') {
		  const target = String(message.data?.target_actor_id || '')
		  const action = String(message.data?.action || '')
		  this.followChanges.push({ sender: userID, target, action })
		  if (target === actorIDFor(userID)) {
			socket.send(JSON.stringify({ event: 'error', code: 'invalid_whiteboard_payload', error: 'No se pudo aplicar el cambio en tiempo real' }))
			return
		  }
		  const outbound = JSON.stringify({ ...message, actor: { kind: 'user', id: actorIDFor(userID), display_name: userID, access: 'edit' } })
		  for (const peer of this.sockets.keys()) if (peer !== socket) peer.send(outbound)
		  return
		}
		if (message.event === 'viewport.update' && Array.isArray(message.data?.bounds)) {
		  this.viewportDeliveries.push({ sender: userID, bounds: message.data.bounds.map(Number) })
		  const outbound = JSON.stringify({ ...message, actor: { kind: 'user', id: actorIDFor(userID), display_name: userID, access: 'edit' } })
		  for (const peer of this.sockets.keys()) if (peer !== socket) peer.send(outbound)
		  return
		}
        if (message.event !== 'scene.patch' || typeof message.operation_id !== 'string') return
        const operationID = message.operation_id
        this.scenePatches.push({
          userID,
          operationID,
          elements: Array.isArray(message.elements) ? clone(message.elements) : [],
        })
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
        appState: clone(this.appState), files: {},
      },
      scene_schema_version: 'excalidraw', editor_version: '0.18.1-clarin.5', sequence: this.sequence, updated_at: now,
    }
  }
}

function board(harness: WhiteboardRealtimeHarness) {
  const folder = harness.createdFolders.find(item => item.id === harness.boardFolderID)
  return {
    id: boardID,
    name: 'Pizarra QA autónoma',
    description: '',
    folder_id: harness.boardFolderID,
    folder_name: folder?.name || null,
    owner_name: 'Ana QA',
    updated_by_name: 'Ana QA',
    shared: false,
    created_at: now,
    updated_at: now,
    access_mode: 'private',
    access_revision: 1,
    version: harness.boardVersion,
    scene_sequence: harness.sequence,
    effective_access: harness.effectiveAccess,
  }
}

function workLocationView(harness: WhiteboardRealtimeHarness) {
  return {
    id: workViewID,
    type: 'whiteboard',
    environment_id: workEnvironmentID,
    scope: {
      scope_type: 'list',
      scope_id: workListID,
      scope_name: 'Lista QA de egress',
      breadcrumb: [
        { type: 'environment', id: workEnvironmentID, name: 'Entorno QA' },
        { type: 'list', id: workListID, name: 'Lista QA de egress' },
      ],
    },
    sort_order: 1024,
    version: 1,
    access_revision: 1,
    lifecycle: 'active',
    created_by: actorIDFor('Ana QA'),
    resource: { whiteboard: { ...board(harness), folder_id: undefined, folder_name: undefined } },
    capabilities: { can_view: true, can_comment: true, can_edit: true, can_manage: true, can_manage_access: false },
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
  const actorID = actorIDFor(userID)
  const personalLibraryID = personalLibraryIDFor(userID)
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
          id: actorID, username: userID, display_name: userID, role: 'admin', is_admin: true, is_super_admin: false,
          account_id: 'account-whiteboard-qa', account_name: 'Cuenta QA', permissions: ['whiteboards', 'tasks'],
        },
        accounts: [{ account_id: 'account-whiteboard-qa', account_name: 'Cuenta QA', role: 'admin', is_default: true }],
      })
      return
    }
    if (url.pathname === '/api/tasks/environments' && request.method() === 'GET') {
      await json(route, {
        success: true,
        environments: [{
          id: workEnvironmentID, account_id: 'account-whiteboard-qa', name: 'Entorno QA', description: '', color: '#10b981', icon: 'layers',
          sort_order: 0, visibility: 'account', default_access_level: 'edit', is_default: true, version: 1, access_revision: 1,
          created_at: now, updated_at: now, folder_count: 0, list_count: 1, task_count: 0,
          permissions: { level: 'full', can_view: true, can_comment: true, can_edit: true, can_delete: false, can_archive: true, can_trash: false, can_restore: true, can_manage_access: true, inherited_from: 'account_admin' },
        }],
        next_cursor: null,
        can_create: true,
      })
      return
    }
    if (url.pathname === '/api/account/users') {
      await json(route, { success: true, users: [] })
      return
    }
    if (url.pathname === `/api/tasks/environments/${workEnvironmentID}/folders`) {
      await json(route, { success: true, folders: [], next_cursor: null })
      return
    }
    if (url.pathname === `/api/tasks/environments/${workEnvironmentID}/lists`) {
      await json(route, {
        success: true,
        lists: [{
          id: workListID, account_id: 'account-whiteboard-qa', environment_id: workEnvironmentID, name: 'Lista QA de egress', description: '',
          color: '#10b981', icon: 'list', sort_order: 1024, created_by: actorID, created_at: now, updated_at: now,
          task_count: 0, open_task_count: 0, completed_task_count: 0, cancelled_task_count: 0,
          permissions: { level: 'full', can_view: true, can_comment: true, can_edit: true, can_delete: true, can_archive: true, can_trash: true, can_restore: true, can_manage_access: true, inherited_from: 'account_admin' },
        }],
        next_cursor: null,
      })
      return
    }
    if (url.pathname === '/api/tasks/workflows') {
      await json(route, { success: true, workflows: [] })
      return
    }
    if (url.pathname === '/api/tasks' && request.method() === 'GET') {
      await json(route, { success: true, tasks: [], total: 0, next_cursor: null })
      return
    }
    if (url.pathname === `/api/tasks/location-views/${workViewID}` && request.method() === 'GET') {
      await json(route, { success: true, feature_enabled: true, location_view: workLocationView(harness) })
      return
    }
    if (url.pathname === '/api/tasks/location-views' && request.method() === 'GET') {
      await json(route, { success: true, feature_enabled: true, location_views: [workLocationView(harness)], next_cursor: null })
      return
    }
    if (url.pathname === '/api/whiteboards' && request.method() === 'GET') {
      const requestedFolderID = url.searchParams.get('folder_id')
      const boards = requestedFolderID && requestedFolderID !== harness.boardFolderID ? [] : [board(harness)]
      await json(route, {
        success: true,
        work_whiteboard_views_enabled: true,
        whiteboards: boards,
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
          created_at: now, updated_at: now, whiteboard_count: harness.boardFolderID === folder.id ? 1 : 0, effective_access: access,
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
    const folderUpdateMatch = url.pathname.match(/^\/api\/whiteboard-folders\/([^/]+)$/u)
    if (folderUpdateMatch && request.method() === 'PUT') {
      const folderID = folderUpdateMatch[1]
      const folder = harness.createdFolders.find(item => item.id === folderID)
      if (!folder) {
        await json(route, { success: false, error: 'Carpeta no encontrada.' }, 404)
        return
      }
      const payload = request.postDataJSON() as Record<string, any>
      const placement = payload.placement as Record<string, unknown> | undefined
      const expectedVersion = 1 + harness.folderMoves.filter(move => move.folderID === folderID).length
      if (Number(payload.expected_version) !== expectedVersion) {
        await json(route, { success: false, error: 'La carpeta cambió en otra sesión.' }, 409)
        return
      }
      const parentID = typeof placement?.parent_id === 'string' && placement.parent_id ? placement.parent_id : null
      const beforeFolderID = typeof placement?.before_folder_id === 'string' && placement.before_folder_id ? placement.before_folder_id : null
      harness.folderMoves.push({ folderID, parentID, beforeFolderID, expectedVersion })
      folder.parentID = parentID
      if (typeof payload.name === 'string' && payload.name.trim()) folder.name = payload.name.trim()
      const canonical = {
        id: folder.id,
        name: folder.name,
        description: String(payload.description || ''),
        parent_id: folder.parentID,
        sort_order: 1024 * (harness.createdFolders.findIndex(item => item.id === folder.id) + 1),
        version: expectedVersion + 1,
        created_at: now,
        updated_at: now,
        whiteboard_count: harness.boardFolderID === folder.id ? 1 : 0,
        effective_access: access,
      }
      await json(route, { success: true, folder: canonical, affected_folders: [canonical] })
      return
    }
    if (url.pathname === `/api/whiteboards/${boardID}` && request.method() === 'GET') {
      await json(route, { success: true, whiteboard: board(harness) })
      return
    }
    if (url.pathname === `/api/whiteboards/${boardID}` && request.method() === 'PUT') {
      const payload = request.postDataJSON() as Record<string, any>
      const destinationFolderID = typeof payload.folder_id === 'string' && payload.folder_id ? payload.folder_id : null
      harness.boardMoves.push({ folderID: destinationFolderID, expectedVersion: Number(payload.expected_version) })
      const failure = harness.consumeBoardMoveFailure()
      if (failure) {
        await json(route, { success: false, error: failure === 409 ? 'La pizarra cambió en otra sesión.' : 'Fallo simulado al mover la pizarra.' }, failure)
        return
      }
      if (Number(payload.expected_version) !== harness.boardVersion) {
        await json(route, { success: false, error: 'La pizarra cambió en otra sesión.' }, 409)
        return
      }
      harness.boardFolderID = destinationFolderID
      harness.boardVersion += 1
      const canonical = board(harness)
      await json(route, {
        success: true,
        whiteboard: {
          id: canonical.id,
          name: canonical.name,
          description: canonical.description || '',
          folder_id: canonical.folder_id,
          created_at: canonical.created_at,
          updated_at: canonical.updated_at,
          version: canonical.version,
          scene_sequence: canonical.scene_sequence,
          effective_access: canonical.effective_access,
          shared: false,
        },
      })
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
      await json(route, { success: true, assets: Array.from(harness.assets.values()), next_cursor: null })
      return
    }
    if (url.pathname === `/api/whiteboards/${boardID}/assets` && request.method() === 'POST') {
      const multipart = request.postData() || ''
      const multipartValue = (name: string) => multipart.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r\\n]+)`, 'u'))?.[1]?.trim() || ''
      const fileID = multipartValue('file_id')
      const kind = multipartValue('kind') || 'asset'
      if (kind === 'asset') harness.assetUploads += 1
      const asset = {
        id: `asset-${fileID || kind}-${harness.assets.size + 1}`,
        board_id: boardID,
        file_id: fileID || (kind === 'thumbnail' ? 'thumbnail' : `file-${harness.assets.size + 1}`),
        kind,
        filename: `${fileID || kind}.png`,
        content_type: 'image/png',
        size_bytes: imageFixtureBytes.length,
        created_at: now,
      }
      harness.assets.set(asset.id, asset)
      const response: Record<string, unknown> = {
        success: true,
        asset,
        deduped: false,
      }
      if (kind === 'thumbnail') response.whiteboard = board(harness)
      await json(route, response, 201)
      return
    }
    if (url.pathname.startsWith(`/api/whiteboards/${boardID}/assets/`) && request.method() === 'GET') {
      const assetID = decodeURIComponent(url.pathname.split('/').at(-1) || '')
      if (!harness.assets.has(assetID)) {
        await json(route, { success: false, error: 'Recurso no encontrado.' }, 404)
        return
      }
      await route.fulfill({ status: 200, contentType: 'image/png', body: imageFixtureBytes })
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
    if (url.pathname === `/api/whiteboards/${boardID}/comment-markers` && request.method() === 'GET') {
      await json(route, { success: true, markers: [], next_cursor: null })
      return
    }
    if (url.pathname === `/api/whiteboards/${boardID}/comment-threads` && request.method() === 'GET') {
      await json(route, {
        success: true,
        threads: [],
        next_cursor: null,
        counts: { open: 0, resolved: 0, all: 0 },
      })
      return
    }
    if (url.pathname === '/api/whiteboard-libraries' && request.method() === 'GET') {
      await json(route, {
        success: true,
        libraries: [
          {
            id: personalLibraryID, name: `Mi biblioteca · ${actorID}`, description: '', library_json: { libraryItems: [] },
            visibility: 'private', version: 1, created_by: actorID, updated_by: actorID, created_at: now, updated_at: now,
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
    if (decodeURIComponent(url.pathname) === `/api/whiteboard-libraries/${personalLibraryID}` && request.method() === 'PUT') {
      const payload = request.postDataJSON() as Record<string, any>
      await json(route, {
        success: true,
        library: {
          id: personalLibraryID,
          name: payload.name,
          description: payload.description || '',
          library_json: payload.library_json,
          visibility: 'private',
          version: Number(payload.expected_version || 1) + 1,
          created_by: actorID,
          updated_by: actorID,
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

async function installGuestWhiteboardHTTP(
  context: BrowserContext,
  harness: WhiteboardRealtimeHarness,
  trace: Set<string>,
  blocked: string[],
) {
  const shareLinkID = 'whiteboard-guest-link-qa'
  await context.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    trace.add(url.href)
    if (url.origin !== new URL(baseURL).origin) {
      blocked.push(url.href)
      await route.abort('blockedbyclient')
      return
    }
    if (!url.pathname.startsWith('/api/')) {
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
    if (url.pathname === '/api/whiteboard-guest/scene' && url.searchParams.get('link_id') === shareLinkID) {
      await json(route, {
        success: true,
        session: {
          id: 'guest-session-marta',
          display_name: 'Marta Invitada',
          access_level: 'edit',
          expires_at: '2026-08-19T00:00:00Z',
        },
        scene: harness.sceneRecord(),
        allow_export: false,
      })
      return
    }
    if (url.pathname === '/api/whiteboard-guest/assets' && request.method() === 'GET') {
      await json(route, { success: true, assets: [], next_cursor: null })
      return
    }
    if (url.pathname === '/api/whiteboard-guest/collab-ticket' && request.method() === 'POST') {
      await json(route, { success: true, ticket: 'ticket-guest-marta' }, 201)
      return
    }
    await json(route, { success: true })
  })
  return shareLinkID
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

async function openWorkEditor(page: Page) {
  const browserErrors: string[] = []
  page.on('pageerror', error => browserErrors.push(error.message))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${baseURL}/dashboard/tasks?work_view=${workViewID}`, { waitUntil: 'domcontentloaded' })
  try {
    await expect(page.locator('.whiteboard-editor-shell canvas.interactive')).toBeVisible({ timeout: 30_000 })
  } catch (cause) {
    const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 2_000)
    throw new Error(`El editor Work no llegó a ready en ${page.url()}. UI: ${JSON.stringify(body)}. Errores: ${JSON.stringify(browserErrors)}`, { cause })
  }
  const title = page.getByLabel('Nombre de la pizarra')
  if (await title.count()) {
    await expect(title).toHaveValue('Pizarra QA autónoma')
    await expect(title).toHaveAttribute('readonly', '')
  } else {
    await expect(page.getByText('Pizarra QA autónoma', { exact: true }).first()).toBeVisible()
  }
}

async function openGuestEditor(page: Page, shareLinkID: string) {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${baseURL}/shared/whiteboards/${shareLinkID}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Marta Invitada · Puede editar')).toBeVisible({ timeout: 30_000 })
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

async function drawFreeDraw(page: Page, offset: number) {
  const surface = page.locator('.whiteboard-editor-shell .excalidraw').first()
  const box = await surface.boundingBox()
  expect(box).not.toBeNull()
  const startX = box!.x + box!.width * 0.46
  const startY = box!.y + box!.height * 0.36 + offset
  const points = [
    { x: startX, y: startY },
    { x: startX + 32, y: startY - 8 },
    { x: startX + 64, y: startY + 10 },
    { x: startX + 96, y: startY - 5 },
    { x: startX + 128, y: startY + 12 },
  ]
  await page.mouse.move(points[0].x, points[0].y)
  await page.mouse.down()
  for (const point of points.slice(1)) await page.mouse.move(point.x, point.y, { steps: 3 })
  await page.mouse.up()
  return {
    left: Math.min(...points.map(point => point.x)),
    top: Math.min(...points.map(point => point.y)),
    right: Math.max(...points.map(point => point.x)),
    bottom: Math.max(...points.map(point => point.y)),
  }
}

function visiblePressureGroup(root: Page | Locator) {
  return root.getByRole('group', { name: 'Presión' }).filter({ visible: true })
}

async function waitForEditorResponsiveMode(page: Page) {
  const editor = page.locator('.whiteboard-editor-shell .excalidraw').first()
  await expect.poll(() => editor.evaluate(element => {
    const { width, height } = element.getBoundingClientRect()
    const shouldBeMobile = width < 730 || (height < 500 && width < 1_000)
    return element.classList.contains('excalidraw--mobile') === shouldBeMobile
  }), { timeout: 5_000 }).toBe(true)
  await page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
}

async function expectPressureControls(root: Page | Locator, expected: 'constant' | 'variable' | 'mixed') {
  const pressure = visiblePressureGroup(root)
  await expect(pressure).toBeVisible()
  const constant = pressure.getByRole('radio', { name: 'Constante', exact: true })
  const variable = pressure.getByRole('radio', { name: 'Variable', exact: true })
  await expect(constant).toBeVisible()
  await expect(variable).toBeVisible()
  await expect(constant).toBeChecked({ checked: expected === 'constant' })
  await expect(variable).toBeChecked({ checked: expected === 'variable' })
  return { pressure, constant, variable }
}

async function drawAndCaptureFreeDraw(
  page: Page,
  harness: WhiteboardRealtimeHarness,
  userID: string,
  variability: 'constant' | 'variable',
  offset: number,
) {
  const knownIDs = new Set(harness.elements.map(element => String(element.id)))
  const patchStart = harness.scenePatches.length
  const screenBounds = await drawFreeDraw(page, offset)
  await expect.poll(() => harness.elements.filter(element => (
    element.type === 'freedraw' && !knownIDs.has(String(element.id))
  )).length, { timeout: 30_000 }).toBe(1)
  await expectEditorSaved(page)

  const element = harness.elements.find(candidate => (
    candidate.type === 'freedraw' && !knownIDs.has(String(candidate.id))
  ))!
  const matchingPatches = harness.scenePatches.slice(patchStart).filter(patch => (
    patch.userID === userID && patch.elements.some(candidate => candidate.id === element.id)
  ))
  expect(matchingPatches, 'un trazo debe producir un solo scene.patch lógico').toHaveLength(1)
  const patchedElement = matchingPatches[0].elements.find(candidate => candidate.id === element.id)
  expect(patchedElement?.strokeOptions).toEqual({ variability, streamline: 0.5 })
  return { element, operationID: matchingPatches[0].operationID, screenBounds }
}

async function selectFreeDraws(
  page: Page,
  strokes: Array<{ screenBounds: { left: number; top: number; right: number; bottom: number } }>,
) {
  const left = Math.min(...strokes.map(stroke => stroke.screenBounds.left)) - 12
  const top = Math.min(...strokes.map(stroke => stroke.screenBounds.top)) - 12
  const right = Math.max(...strokes.map(stroke => stroke.screenBounds.right)) + 12
  const bottom = Math.max(...strokes.map(stroke => stroke.screenBounds.bottom)) + 12
  await page.getByTestId('toolbar-selection').check({ force: true })
  await page.mouse.move(left, top)
  await page.mouse.down()
  await page.mouse.move(right, bottom, { steps: 8 })
  await page.mouse.up()
}

async function captureSelectedPressurePatch(
  page: Page,
  harness: WhiteboardRealtimeHarness,
  userID: string,
  elementIDs: string[],
  expected: Array<'constant' | 'variable'>,
  action: () => Promise<void>,
) {
  const patchStart = harness.scenePatches.length
  await action()
  await expect.poll(() => elementIDs.map(id => {
    const element = harness.elements.find(candidate => String(candidate.id) === id)
    return element?.strokeOptions && typeof element.strokeOptions === 'object'
      ? (element.strokeOptions as Record<string, unknown>).variability
      : null
  }), { timeout: 30_000 }).toEqual(expected)
  await expectEditorSaved(page)
  const matchingPatches = harness.scenePatches.slice(patchStart).filter(patch => (
    patch.userID === userID
    && elementIDs.every(id => patch.elements.some(element => String(element.id) === id))
  ))
  expect(matchingPatches, 'la acción de Presión debe producir un solo scene.patch con toda la selección').toHaveLength(1)
  expect(new Set(matchingPatches[0].elements
    .filter(element => element.type === 'freedraw')
    .map(element => String(element.id))), 'el patch debe contener exactamente los dos trazos seleccionados')
    .toEqual(new Set(elementIDs))
  return matchingPatches[0].operationID
}

async function drawStandaloneText(page: Page, text: string, offset: number) {
  const surface = page.locator('.whiteboard-editor-shell .excalidraw').first()
  const box = await surface.boundingBox()
  expect(box).not.toBeNull()
  await page.getByTestId('toolbar-text').check({ force: true })
  await expect(page.getByTestId('toolbar-text')).toBeChecked()
  await page.mouse.click(box!.x + box!.width * 0.58 + offset, box!.y + box!.height * 0.32 + offset)
  await page.keyboard.insertText(text)
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
  await page.getByTestId('main-menu-trigger').click({ timeout: 10_000 })
  const downloadPromise = page.waitForEvent('download')
  await page.getByText('Archivo editable', { exact: true }).click()
  const download = await downloadPromise
  const path = await download.path()
  expect(path).not.toBeNull()
  return JSON.parse(readFileSync(path!, 'utf8')) as { elements: Array<Record<string, any>> }
}

async function exerciseNativeStyleAndImageExportEnhancements(
  page: Page,
  testInfo: TestInfo,
  requests: Set<string>,
  verifyDownloads: boolean,
) {
  await drawRectangle(page, 44)
  const ultraBoldStroke = page.getByTestId('strokeWidth-ultraBold')
  await expect(ultraBoldStroke).toBeVisible()
  await ultraBoldStroke.check({ force: true })
  await expect(ultraBoldStroke).toBeChecked()

  await page.getByTestId('main-menu-trigger').click()
  await page.getByText('Exportar imagen...', { exact: true }).click()
  const exportDialog = page.locator('.ImageExportModal')
  await expect(exportDialog).toBeVisible()
  await expect(exportDialog.locator('.ImageExportModal__preview canvas')).toBeVisible()
  if (!verifyDownloads) await expect(exportDialog.locator('input[name="exportOnlySelected"]')).toBeChecked()
  await expect(exportDialog.getByRole('button', { name: 'Exportar a PNG' })).toBeVisible()
  await expect(exportDialog.getByRole('button', { name: 'Exportar a SVG' })).toBeVisible()
  await testInfo.attach('pizarra-exportacion-seleccionada', {
    body: await page.screenshot({ animations: 'disabled' }),
    contentType: 'image/png',
  })
  await page.keyboard.press('Escape')
  await expect(exportDialog).toBeHidden()
  await expect(page.locator('.Modal__background')).toHaveCount(0)

  await page.getByTestId('toolbar-text').check({ force: true })
  const showFonts = page.getByTestId('font-family-show-fonts')
  await expect(showFonts).toBeVisible({ timeout: 5_000 })
  await expect(showFonts).toHaveAttribute('aria-label', 'Más fuentes · 32', { timeout: 5_000 })
  await expect.poll(async () => showFonts.evaluate(element => {
    const rect = element.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return hit === element || element.contains(hit)
  }), { timeout: 5_000 }).toBe(true)
  await expect(showFonts).toBeEnabled({ timeout: 30_000 })
  const fontRequestsBeforeOpening = Array.from(requests).filter(url => new URL(url).pathname.includes('/fonts/Clarin/'))
  expect(fontRequestsBeforeOpening.length).toBeGreaterThan(0)
  const preloadRequests = new Set(fontRequestsBeforeOpening)
  const fontPickerErrors: string[] = []
  page.on('pageerror', error => fontPickerErrors.push(error.message))
  await showFonts.click({ timeout: 5_000 })
  const fontList = page.locator('.dropdown-menu.fonts')
  try {
    await expect(fontList).toBeVisible()
  } catch (cause) {
    const pickerState = await page.locator('.FontPicker__container').evaluateAll(elements => elements.map(element => element.outerHTML.slice(0, 2_000)))
    const triggerState = await showFonts.evaluate(element => element.parentElement?.outerHTML.slice(0, 2_000))
    throw new Error(`El catálogo de fuentes no abrió. Disparador: ${JSON.stringify(triggerState)}. Estado: ${JSON.stringify(pickerState)}. Errores: ${JSON.stringify(fontPickerErrors)}`, { cause })
  }
  const fontOptions = fontList.locator('button.dropdown-menu-item')
  await expect(fontOptions).toHaveCount(32)
  const fontFamilies = await fontOptions.evaluateAll(options => options.map(option => {
    const label = option.querySelector('.dropdown-menu-item__text')
    return Array.from(label?.childNodes || [])
      .find(node => node.nodeType === Node.TEXT_NODE)?.textContent?.trim()
  })).then(families => families.map(family => family?.replace(/^"|"$/gu, '')).sort())
  expect(fontFamilies).toEqual([
    'Abril Fatface', 'Alfa Slab One', 'Architects Daughter', 'Bangers', 'Bebas Neue', 'Cascadia', 'Caveat',
    'Comic Shanns', 'Excalifont', 'Fredoka', 'Gloria Hallelujah', 'Helvetica', 'IBM Plex Mono', 'Inter',
    'JetBrains Mono', 'Kalam', 'Libre Baskerville', 'Lilita One', 'Lobster', 'Lora', 'Merriweather',
    'Montserrat', 'Nunito', 'Patrick Hand', 'Permanent Marker', 'Playfair Display', 'Poppins', 'Quicksand',
    'Raleway', 'Shadows Into Light', 'Space Mono', 'Virgil',
  ])
  const spaceMonoOption = fontOptions.filter({ hasText: 'Space Mono' })
  await spaceMonoOption.scrollIntoViewIfNeeded()
  await expect.poll(async () => spaceMonoOption.locator('.dropdown-menu-item__text').evaluate(element => getComputedStyle(element).fontFamily)).toContain('Clarin Space Mono')
  expect(await page.evaluate(() => Array.from(document.fonts)
    .filter(face => face.family.includes('Clarin Space Mono'))
    .every(face => face.status === 'loaded'))).toBe(true)

  const categoryGroup = page.getByRole('group', { name: 'Filtrar fuentes' })
  await expect(categoryGroup).toBeVisible()
  await categoryGroup.getByRole('button', { name: 'Mono', exact: true }).click()
  await expect(fontOptions).toHaveCount(3)
  await categoryGroup.getByRole('button', { name: 'Todas', exact: true }).click({ timeout: 5_000 })
  await expect(fontList).toBeVisible({ timeout: 5_000 })
  const fontSearch = page.locator('.properties-content .QuickSearch__input')
  await expect(fontSearch).toBeVisible({ timeout: 5_000 })
  await fontSearch.fill('merri', { timeout: 5_000 })
  await expect(fontOptions).toHaveCount(1, { timeout: 2_000 })
  await expect(fontOptions.first()).toContainText('Merriweather')
  await expect.poll(async () => fontOptions.first().locator('.dropdown-menu-item__text').evaluate(element => getComputedStyle(element).fontFamily)).toContain('Clarin Merriweather')
  await fontSearch.fill('')
  await expect(fontOptions).toHaveCount(32, { timeout: 2_000 })
  const caveatOption = fontOptions.filter({ hasText: 'Caveat' })
  await caveatOption.scrollIntoViewIfNeeded()
  await expect.poll(() => page.evaluate(() => Array.from(document.fonts)
    .filter(face => face.family.includes('Clarin Caveat'))
    .some(face => face.status === 'loaded'))).toBe(true)
  await caveatOption.hover()
  await caveatOption.focus()
  await caveatOption.click()
  await expect(fontList).toBeHidden()
  const fontRequestsAfterCatalogInteractions = Array.from(requests)
    .filter(url => new URL(url).pathname.includes('/fonts/Clarin/'))
  expect(new Set(fontRequestsAfterCatalogInteractions)).toEqual(preloadRequests)
  const fontResourceEntries = await page.evaluate(() => performance.getEntriesByType('resource')
    .map(entry => entry.name)
    .filter(name => new URL(name).pathname.includes('/fonts/Clarin/')))
  expect(fontResourceEntries.length).toBe(new Set(fontResourceEntries).size)
  expect(fontResourceEntries.length).toBeGreaterThan(0)
  await testInfo.attach('pizarra-selector-fuentes-visibles', {
    body: await page.screenshot({ animations: 'disabled' }),
    contentType: 'image/png',
  })

  const eyeDropperBackdrop = page.locator('.excalidraw-eye-dropper-backdrop')
  if (await eyeDropperBackdrop.isVisible()) {
    await page.keyboard.press('Escape')
    await expect(eyeDropperBackdrop).toBeHidden()
  }

  await drawStandaloneText(page, 'Árbol, pingüino y acción', 96)
  if (!verifyDownloads) return

  if (await eyeDropperBackdrop.isVisible()) {
    await page.keyboard.press('Escape')
    await expect(eyeDropperBackdrop).toBeHidden()
  }

  const editable = await exportEditableScene(page)
  const customText = editable.elements.find(element => element.type === 'text' && element.fontFamily === 10001)
  if (!customText) {
    throw new Error(`La escena exportada no conservó Caveat: ${JSON.stringify(editable.elements.map(element => ({ type: element.type, fontFamily: element.fontFamily, text: element.originalText })))}`)
  }
  expect(customText?.originalText).toBe('Árbol, pingüino y acción')

  await page.getByTestId('main-menu-trigger').click()
  await page.getByText('Exportar imagen...', { exact: true }).click()
  const svgDownloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Exportar a SVG' }).click()
  const svgDownload = await Promise.race([
    svgDownloadPromise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('La exportación SVG con fuente privada superó 30 segundos.')), 30_000)),
  ])
  const svgPath = await svgDownload.path()
  expect(svgPath).not.toBeNull()
  const svg = readFileSync(svgPath!, 'utf8')
  expect(svg).toContain('Caveat')
  expect(svg).toMatch(/data:font\/woff2;base64,/u)
  await page.keyboard.press('Escape')
  await expect(page.locator('.ImageExportModal')).toBeHidden()

  await page.getByTestId('main-menu-trigger').click()
  await page.getByText('Exportar imagen...', { exact: true }).click()
  const pngDownloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Exportar a PNG' }).click()
  const pngDownload = await pngDownloadPromise
  const pngPath = await pngDownload.path()
  expect(pngPath).not.toBeNull()
  expect(readFileSync(pngPath!).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
}

async function expectEditorSaved(page: Page) {
  await expect(page.getByLabel('Guardado en Clarin')).toBeVisible({ timeout: 20_000 })
}

async function expectInsideViewport(page: Page, locator: Locator, label: string) {
  await expect(locator, `${label} debe seguir visible`).toBeVisible()
  await expect.poll(async () => {
    const box = await locator.boundingBox()
    const viewport = page.viewportSize()
    if (!box || !viewport) return JSON.stringify({ box, viewport })
    const inside = box.x >= -1
      && box.y >= -1
      && box.x + box.width <= viewport.width + 1
      && box.y + box.height <= viewport.height + 1
    if (inside) return 'inside'
    const layout = await locator.evaluate(element => {
      const describe = (node: Element | null) => {
        if (!node) return null
        const rect = node.getBoundingClientRect()
        return { className: node.className, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }
      }
      return {
        document: { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth },
        shell: describe(element.closest('.whiteboard-editor-shell')),
        excalidraw: describe(element.closest('.excalidraw')),
        topRight: describe(element.closest('.layer-ui__wrapper__top-right, .mobile-misc-tools-container')),
        parent: describe(element.parentElement),
      }
    })
    return JSON.stringify({ box, viewport, layout })
  }, {
    message: `${label} debe quedar íntegramente dentro del viewport después del reflow`,
    timeout: 5_000,
  }).toBe('inside')
}

async function expectNoDocumentHorizontalOverflow(page: Page, label: string) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(dimensions.scrollWidth, `${label} no debe crear scroll horizontal global`).toBeLessThanOrEqual(dimensions.clientWidth + 1)
}

function visibleWhiteboardLibraryActions(page: Page) {
  return page.locator('.whiteboard-editor-shell [aria-label="Biblioteca"]').filter({ visible: true })
}

function visibleWhiteboardCommentActions(page: Page) {
  return page.locator('.whiteboard-editor-shell [aria-label^="Comentarios"]').filter({ visible: true })
}

function whiteboardActionHitTarget(action: Locator) {
  return action
}

async function expectMinimumTouchTarget(locator: Locator, label: string) {
  await expect(locator, `${label} debe estar visible`).toBeVisible()
  const box = await locator.evaluate(element => {
    const hitTarget = element.closest('.whiteboard-action-bar__control, .whiteboard-sidebar-action, .sidebar-trigger__label-element, label') || element
    const rect = hitTarget.getBoundingClientRect()
    return { width: rect.width, height: rect.height }
  })
  expect(box.width, `${label} debe medir al menos 44 px de ancho`).toBeGreaterThanOrEqual(44)
  expect(box.height, `${label} debe medir al menos 44 px de alto`).toBeGreaterThanOrEqual(44)
}

async function expectWhiteboardChromeOwnership(page: Page, label: string) {
  const library = visibleWhiteboardLibraryActions(page)
  const comments = visibleWhiteboardCommentActions(page)
  const libraryOwners = await library.evaluateAll(elements => elements.map(element => ({
    tag: element.tagName,
    className: element.getAttribute('class'),
    role: element.getAttribute('role'),
    dataAction: element.getAttribute('data-whiteboard-action'),
    dataInternal: element.getAttribute('data-whiteboard-sidebar-internal'),
    parentClassName: element.parentElement?.getAttribute('class') || null,
  })))
  expect(libraryOwners, `${label}: debe existir un solo control visible de Biblioteca; dueños=${JSON.stringify(libraryOwners)}`).toHaveLength(1)
  await expect(comments, `${label}: Comentarios debe permanecer oculto`).toHaveCount(0)
  await expect(page.getByLabel('Comentarios de la pizarra'), `${label}: no debe montarse el panel de Comentarios`).toHaveCount(0)
  await expect(page.getByLabel('Pines de comentarios'), `${label}: no deben montarse pines de Comentarios`).toHaveCount(0)
  await expect(page.locator('.whiteboard-action-bar').filter({ visible: true }), `${label}: debe existir una sola barra de acciones`).toHaveCount(1)
  await expect(page.locator('[data-whiteboard-save-status]').filter({ visible: true }), `${label}: debe existir un solo estado de guardado`).toHaveCount(1)
  await expect(page.locator('input.ToolIcon_type_checkbox[aria-label="Biblioteca"]').filter({ visible: true }), `${label}: el trigger oficial sustituido debe quedar fuera de la interfaz`).toHaveCount(0)
  const geometry = await page.locator('.whiteboard-action-bar').filter({ visible: true }).evaluate(element => ({
    bar: element.getBoundingClientRect().toJSON(),
    nativeToolbar: document.querySelector<HTMLElement>('.whiteboard-editor-shell .App-toolbar')?.getBoundingClientRect().toJSON() || null,
    controls: Array.from(element.querySelectorAll<HTMLElement>('.whiteboard-action-bar__control')).map(control => ({
      label: control.getAttribute('aria-label'),
      rect: control.getBoundingClientRect().toJSON(),
    })),
  }))
  expect(geometry.controls.every(control => control.rect.width >= 44 && control.rect.height >= 44), `${label}: todos los controles deben conservar 44 px`).toBe(true)
  expect(geometry.controls.every((control, index) => index === 0 || control.rect.x >= geometry.controls[index - 1].rect.x + geometry.controls[index - 1].rect.width - 0.5), `${label}: los controles no deben solaparse`).toBe(true)
  expect(geometry.bar.width, `${label}: la isla debe envolver sus controles sin desborde`).toBeGreaterThanOrEqual(geometry.controls.reduce((total, control) => total + control.rect.width, 0))
  if (geometry.nativeToolbar) {
    const overlapsNativeToolbar = geometry.bar.x < geometry.nativeToolbar.x + geometry.nativeToolbar.width
      && geometry.bar.x + geometry.bar.width > geometry.nativeToolbar.x
      && geometry.bar.y < geometry.nativeToolbar.y + geometry.nativeToolbar.height
      && geometry.bar.y + geometry.bar.height > geometry.nativeToolbar.y
    expect(overlapsNativeToolbar, `${label}: la barra de Clarin no debe cubrir herramientas de Excalidraw`).toBe(false)
  }
  await expectMinimumTouchTarget(library, `${label}: Biblioteca`)
  await expectMinimumTouchTarget(page.locator('[data-whiteboard-save-status]').filter({ visible: true }), `${label}: estado de guardado`)
  await expectMinimumTouchTarget(page.getByRole('button', { name: 'Más acciones de Pizarras' }), `${label}: Más`)
  return { library }
}

async function expectPublicLibraryDisclosure(page: Page, label: string) {
  const browse = page.locator('.library-menu-browse-button')
  await expect(browse).toBeVisible()
  await expectMinimumTouchTarget(browse, `${label}: Explorar bibliotecas`)
  await expect(browse).toHaveAccessibleName(/sitio oficial.*analítica externa.*Clarin validará/u)
  const disclosureContent = await page.locator('.library-menu-control-buttons').filter({ has: browse }).evaluate(element => (
    getComputedStyle(element, '::after').content.replace(/^['"]|['"]$/gu, '')
  ))
  expect(disclosureContent, `${label}: el aviso inline debe mencionar analítica externa`).toContain('analítica externa')
  expect(disclosureContent, `${label}: el aviso inline debe explicar la validación de Clarin`).toContain('Clarin validará el archivo')
}

async function exerciseResponsiveEditor(page: Page, workContext = false) {
  for (const viewport of [
    { width: 320, height: 720 },
    { width: 375, height: 812 },
    { width: 768, height: 800 },
    { width: 1024, height: 768 },
    { width: 1280, height: 800 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport)
    const suffix = `editor ${viewport.width}x${viewport.height}`
    await expectInsideViewport(page, page.locator('.whiteboard-editor-shell'), suffix)
    await expect(page.locator('.whiteboard-editor-shell > header')).toHaveCount(0)
    await expectInsideViewport(page, page.getByTestId('toolbar-rectangle'), `${suffix}: herramientas prioritarias`)
    await expectWhiteboardChromeOwnership(page, suffix)
    await expectInsideViewport(page, page.getByLabel('Más acciones de Pizarras'), `${suffix}: más acciones`)
    await page.getByLabel('Más acciones de Pizarras').click()
    await expectInsideViewport(page, page.getByRole('menu', { name: 'Más acciones de Pizarras' }), `${suffix}: menú Más`)
    await expect(page.getByRole('menu', { name: 'Más acciones de Pizarras' })).toContainText('Pizarra QA autónoma')
    await expect(page.getByRole('menuitem', { name: 'Administrar bibliotecas', exact: true })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Historial', exact: true })).toHaveCount(1)
    await expect(page.getByRole('menuitem', { name: 'Guardar ahora', exact: true })).toHaveCount(1)
    await expect(page.getByRole('menuitem', { name: 'Biblioteca', exact: true })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: /^Comentarios/u })).toHaveCount(0)
    const toolbarShare = page.locator('[data-whiteboard-action="share"]').filter({ visible: true })
    const menuShare = page.getByRole('menuitem', { name: 'Compartir', exact: true })
    expect(
      (await toolbarShare.count()) + (await menuShare.count()),
      `${suffix}: Compartir debe respetar el origen de la pizarra`,
    ).toBe(workContext ? 0 : 1)
    if (viewport.width < 1_100) {
      await expect(page.getByRole('menuitem', { name: workContext ? 'Volver a las tareas' : 'Volver a Pizarras' })).toBeVisible()
    }
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
    await expectInsideViewport(page, page.getByPlaceholder('Buscar por nombre, ubicación o propietario…'), `${suffix}: buscar`)
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

  await page.getByRole('button', { name: 'Carpeta completa 0', exact: true }).click()
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
  await expect(page).toHaveURL(`${baseURL}/dashboard/whiteboards/${boardID}`, {
    timeout: 30_000,
  })
  await page.goto(`${baseURL}/dashboard/whiteboards`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'Mis pizarras' })).toBeVisible({ timeout: 20_000 })
}

async function dragWhiteboardTo(page: Page, target: ReturnType<Page['locator']>) {
  const handle = page.getByRole('button', { name: 'Arrastrar Pizarra QA autónoma a una carpeta' })
  await expect(handle).toBeEnabled()
  const sourceBox = await handle.boundingBox()
  const targetBox = await target.boundingBox()
  expect(sourceBox).not.toBeNull()
  expect(targetBox).not.toBeNull()
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2 + 12, sourceBox!.y + sourceBox!.height / 2, { steps: 3 })
  await expect(page.locator('[data-operational-drag-overlay]')).toBeVisible()
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 12 })
  await expect(target).toContainText('Mover a')
  await page.mouse.up()
  await expect(page.locator('[data-operational-drag-overlay]')).toBeHidden()
}

async function dragWhiteboardToRoot(page: Page) {
  const handle = page.getByRole('button', { name: 'Arrastrar Pizarra QA autónoma a una carpeta' })
  await expect(handle).toBeEnabled()
  const sourceBox = await handle.boundingBox()
  expect(sourceBox).not.toBeNull()
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2 + 12, sourceBox!.y + sourceBox!.height / 2, { steps: 3 })
  const target = page.locator('[data-whiteboard-root-drop]')
  await expect(target).toBeVisible()
  const targetBox = await target.boundingBox()
  expect(targetBox).not.toBeNull()
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 12 })
  await expect(target).toContainText('Soltar en Sin carpeta')
  await page.mouse.up()
  await expect(page.locator('[data-operational-drag-overlay]')).toBeHidden()
}

async function dragFolderToRoot(page: Page, folderName: string) {
  const handle = page.getByRole('button', { name: `Mover carpeta ${folderName}` })
  const target = page.locator('[data-whiteboard-root-drop]')
  const sourceBox = await handle.boundingBox()
  const targetBox = await target.boundingBox()
  expect(sourceBox).not.toBeNull()
  expect(targetBox).not.toBeNull()
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2 + 12, sourceBox!.y + sourceBox!.height / 2, { steps: 3 })
  await expect(page.locator('[data-operational-drag-overlay]')).toBeVisible()
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 12 })
  await expect(target).toContainText('Mover al nivel principal')
  await page.mouse.up()
  await expect(page.locator('[data-operational-drag-overlay]')).toBeHidden()
}

async function exerciseManagerViewsAndFolderMoves(page: Page, harness: WhiteboardRealtimeHarness) {
  await page.setViewportSize({ width: 390, height: 844 })
  const movesBeforeNarrowKeyboardCancel = harness.boardMoves.length
  const narrowHandle = page.getByRole('button', { name: 'Arrastrar Pizarra QA autónoma a una carpeta' })
  await narrowHandle.focus()
  await page.keyboard.press('Space')
  await expect(page.locator('[data-operational-drag-overlay]')).toBeVisible()
  await page.waitForTimeout(100)
  await page.keyboard.press('Space')
  await expect(page.locator('[data-operational-drag-overlay]')).toBeHidden()
  await expect.poll(() => harness.boardMoves.length).toBe(movesBeforeNarrowKeyboardCancel)

  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(page.getByRole('button', { name: 'Vista compacta' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: 'Cambiar carpeta de Pizarra QA autónoma. Carpeta actual: Sin carpeta' })).toBeVisible()

  await page.getByRole('button', { name: 'Vista de cuadrícula' }).click()
  await expect(page.getByRole('button', { name: 'Vista de cuadrícula' })).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('clarin.whiteboards.view.v1'))).toBe('grid')
  await page.getByRole('button', { name: 'Vista compacta' }).click()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('clarin.whiteboards.view.v1'))).toBe('compact')

  const movesBeforePicker = harness.boardMoves.length
  await page.getByRole('button', { name: 'Cambiar carpeta de Pizarra QA autónoma. Carpeta actual: Sin carpeta' }).click()
  const moveDialog = page.getByRole('dialog', { name: 'Mover pizarra' })
  const folderSearch = moveDialog.getByPlaceholder('Buscar carpeta…')
  await expect(folderSearch).toBeFocused()
  await folderSearch.fill('Subcarpeta')
  await expect(moveDialog.locator('input[name="whiteboard-folder-destination"][value="folder-1"]')).toBeHidden()
  await expect(moveDialog.locator('input[name="whiteboard-folder-destination"][value="folder-2"]')).toBeVisible()
  await folderSearch.fill('')
  await expect(moveDialog.locator('input[name="whiteboard-folder-destination"][value="folder-1"]')).toBeVisible()
  await moveDialog.locator('input[name="whiteboard-folder-destination"][value="folder-1"]').check()
  await moveDialog.getByRole('button', { name: 'Mover', exact: true }).click()
  await expect.poll(() => harness.boardMoves.length).toBe(movesBeforePicker + 1)
  expect(harness.boardMoves.at(-1)).toEqual({ folderID: 'folder-1', expectedVersion: 1 })
  const firstFolderButton = page.getByRole('button', { name: 'Cambiar carpeta de Pizarra QA autónoma. Carpeta actual: Carpeta completa' })
  await expect(firstFolderButton).toBeVisible()
  await expect(firstFolderButton).toBeEnabled()
  await expect(page.locator(`[data-whiteboard-id="${boardID}"]`).getByText(/Ana QA/)).toBeVisible()

  const movesBeforeFolderDrop = harness.boardMoves.length
  const subfolderDrop = page.locator('[data-whiteboard-folder-drop="folder-2"]')
  await dragWhiteboardTo(page, subfolderDrop)
  await expect.poll(() => harness.boardMoves.length).toBe(movesBeforeFolderDrop + 1)
  expect(harness.boardMoves.at(-1)).toEqual({ folderID: 'folder-2', expectedVersion: 2 })
  const subfolderButton = page.getByRole('button', { name: 'Cambiar carpeta de Pizarra QA autónoma. Carpeta actual: Subcarpeta completa' })
  await expect(subfolderButton).toBeVisible()
  await expect(subfolderButton).toBeEnabled()

  await page.locator('[data-whiteboard-folder-drop="folder-2"]').click()
  await expect(page.getByRole('heading', { name: 'Subcarpeta completa' })).toBeVisible()
  await expect(page.getByText('Pizarra QA autónoma', { exact: true })).toBeVisible()
  const movesBeforeRootDrop = harness.boardMoves.length
  await dragWhiteboardToRoot(page)
  await expect.poll(() => harness.boardMoves.length).toBe(movesBeforeRootDrop + 1)
  expect(harness.boardMoves.at(-1)).toEqual({ folderID: null, expectedVersion: 3 })
  await expect(page.locator(`[data-whiteboard-id="${boardID}"]`)).toBeHidden()

  await page.locator('nav').getByRole('button', { name: /^Mis pizarras/ }).click()
  await expect(page.locator(`[data-whiteboard-id="${boardID}"]`)).toBeVisible()
  const movesBeforeOutsideDrop = harness.boardMoves.length
  const handle = page.getByRole('button', { name: 'Arrastrar Pizarra QA autónoma a una carpeta' })
  const handleBox = await handle.boundingBox()
  const searchBox = await page.getByPlaceholder('Buscar por nombre, ubicación o propietario…').boundingBox()
  expect(handleBox).not.toBeNull()
  expect(searchBox).not.toBeNull()
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(handleBox!.x + handleBox!.width / 2 + 12, handleBox!.y + handleBox!.height / 2, { steps: 3 })
  await page.mouse.move(searchBox!.x + searchBox!.width / 2, searchBox!.y + searchBox!.height / 2, { steps: 10 })
  await page.mouse.up()
  await expect(page.locator('[data-operational-drag-overlay]')).toBeHidden()
  await expect.poll(() => harness.boardMoves.length).toBe(movesBeforeOutsideDrop)
  await expect(page.locator(`[data-whiteboard-id="${boardID}"]`)).toBeVisible()

  harness.failNextBoardMove(409)
  const movesBeforeConflict = harness.boardMoves.length
  await page.getByRole('button', { name: 'Cambiar carpeta de Pizarra QA autónoma. Carpeta actual: Sin carpeta' }).click()
  const conflictDialog = page.getByRole('dialog', { name: 'Mover pizarra' })
  await conflictDialog.locator('input[name="whiteboard-folder-destination"][value="folder-1"]').check()
  await conflictDialog.getByRole('button', { name: 'Mover', exact: true }).click()
  await expect.poll(() => harness.boardMoves.length).toBe(movesBeforeConflict + 1)
  await expect(page.getByText('La pizarra cambió en otra sesión.', { exact: true })).toBeVisible()
  expect(harness.boardFolderID).toBeNull()
  await expect(page.getByRole('button', { name: 'Cambiar carpeta de Pizarra QA autónoma. Carpeta actual: Sin carpeta' })).toBeVisible()

  const movesBeforeKeyboard = harness.boardMoves.length
  const keyboardHandle = page.getByRole('button', { name: 'Arrastrar Pizarra QA autónoma a una carpeta' })
  await keyboardHandle.focus()
  await page.keyboard.press('Space')
  await expect(page.locator('[data-operational-drag-overlay]')).toBeVisible()
  await page.waitForTimeout(100)
  await page.keyboard.press('Space')
  await expect(page.locator('[data-operational-drag-overlay]')).toBeHidden()
  await expect.poll(() => harness.boardMoves.length).toBe(movesBeforeKeyboard)
  await keyboardHandle.focus()
  await page.keyboard.press('Space')
  await expect(page.locator('[data-operational-drag-overlay]')).toBeVisible()
  await page.waitForTimeout(100)
  await page.keyboard.press('ArrowDown')
  await expect(page.locator('[data-whiteboard-folder-drop="folder-1"]')).toContainText('Mover a Carpeta completa')
  await page.keyboard.press('Space')
  await expect(page.locator('[data-operational-drag-overlay]')).toBeHidden()
  await expect.poll(() => harness.boardMoves.length).toBe(movesBeforeKeyboard + 1)
  await expect.poll(() => harness.boardFolderID).toBe('folder-1')
  expect(harness.boardMoves.at(-1)).toEqual({ folderID: 'folder-1', expectedVersion: 4 })

  const folderMovesBeforeRoot = harness.folderMoves.length
  await dragFolderToRoot(page, 'Subcarpeta completa')
  await expect.poll(() => harness.folderMoves.length).toBe(folderMovesBeforeRoot + 1)
  expect(harness.folderMoves.at(-1)).toEqual({ folderID: 'folder-2', parentID: null, beforeFolderID: null, expectedVersion: 1 })
  expect(harness.createdFolders.find(folder => folder.id === 'folder-2')?.parentID).toBeNull()

  await page.getByLabel('Configurar carpeta Subcarpeta completa').first().click()
  const settings = page.getByRole('complementary', { name: 'Configuración de Subcarpeta completa' })
  await expect(settings).toBeVisible()
  await settings.getByLabel('Descripción').fill('Carpeta operativa fuera del padre')
  await settings.getByRole('button', { name: 'Guardar' }).click()
  await expect(settings).toBeHidden()
  expect(harness.folderMoves.at(-1)).toEqual({ folderID: 'folder-2', parentID: null, beforeFolderID: null, expectedVersion: 2 })
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
  await expect(directLibraryAdmin).toBeHidden()
  if (await page.getByLabel('Más acciones de Pizarras').isVisible()) {
    await page.getByLabel('Más acciones de Pizarras').click()
    await page.getByRole('menuitem', { name: 'Administrar bibliotecas' }).click()
  } else {
    await page.getByTestId('main-menu-trigger').click()
    await page.getByText('Administrar Mi biblioteca', { exact: true }).click()
  }
  const dialog = page.getByRole('dialog', { name: 'Bibliotecas de Pizarras' })
  await expect(dialog).toBeVisible()
  const accountCatalog = dialog.locator('article').filter({ hasText: 'Catálogo QA interno' })
  await expect(accountCatalog).toBeVisible()
  await expect(accountCatalog).toContainText('Administrable')
  await expect(accountCatalog).toContainText('2 elementos')
  await dialog.getByLabel('Cerrar').click()

  const { library: nativeLibraryToggle } = await expectWhiteboardChromeOwnership(page, 'aislamiento de bibliotecas')
  await whiteboardActionHitTarget(nativeLibraryToggle).click()
  await expect(page.locator('.library-menu-items-container')).toBeVisible()
  const publicLibraryButton = page.locator('.library-menu-browse-button')
  await expect(publicLibraryButton).toBeVisible()
  await expect(publicLibraryButton).toHaveText('Explorar bibliotecas')
  await expectPublicLibraryDisclosure(page, 'aislamiento de bibliotecas')
  await expect(publicLibraryButton).toHaveAttribute(
    'href',
    `/api/whiteboards/${boardID}/public-library-import/start?library_id=${personalLibraryIDFor('Ana QA')}`,
  )
  await expect(publicLibraryButton).toHaveAttribute('target', '_self')
  await expect(publicLibraryButton).toHaveAttribute('rel', /noreferrer/u)
  await expect(publicLibraryButton).toHaveAttribute('referrerpolicy', 'no-referrer')
  await expect(page.getByTestId('lib-dropdown--remove')).toBeHidden()
  await expect(page.getByText('Publica tu propia biblioteca', { exact: true })).toBeHidden()
  await expect(page.getByTestId('toolbar-embeddable')).toBeHidden()
  await expect(page.getByTestId('toolbar-magicframe')).toBeHidden()
  await page.locator('.sidebar__close').filter({ visible: true }).click()
  await expect(page.locator('.library-menu-items-container')).toBeHidden()
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

async function insertLocalImageAsset(page: Page) {
  const canvas = page.locator('.whiteboard-editor-shell canvas.interactive').first()
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  await page.keyboard.press('Escape')
  await page.keyboard.press('1')
  const targetX = box!.x + box!.width * 0.55
  const targetY = box!.y + box!.height * 0.55
  await page.mouse.move(targetX, targetY)
  await page.mouse.click(targetX, targetY)
  await page.evaluate(({ bytes }) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([new Uint8Array(bytes)], 'imagen-local-egress.png', { type: 'image/png' }))
    document.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }))
  }, { bytes: Array.from(imageFixtureBytes) })
}

test('integración simulada · la barra tiene un único dueño y Comentarios permanece oculto en la matriz de navegadores', async ({ browser, browserName }, testInfo) => {
  test.setTimeout(210_000)
  const harness = new WhiteboardRealtimeHarness()
  const requests = new Set<string>()
  const blocked: string[] = []
  const explicitNavigations = new Set<string>()
  const context = await browser.newContext({ hasTouch: true, serviceWorkers: 'block' })
  await harness.install(context, 'Ana QA')
  await installWhiteboardHTTP(context, harness, 'Ana QA', requests, blocked, explicitNavigations)
  const page = await context.newPage()
  const pageErrors: string[] = []
  const requestFailures: Array<{ url: string; error: string }> = []
  page.on('pageerror', error => {
    const detail = error.stack || error.message
    pageErrors.push(detail)
  })
  page.on('requestfailed', request => recordWhiteboardRequestFailure(requestFailures, request))

  try {
    await openEditor(page)
    for (const viewport of [
      { width: 320, height: 720 },
      { width: 375, height: 812 },
      { width: 768, height: 800 },
      { width: 1024, height: 768 },
      { width: 1280, height: 800 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport)
      const label = `${browserName} ${viewport.width}x${viewport.height}`
      const { library } = await expectWhiteboardChromeOwnership(page, label)
      const libraryHitTarget = whiteboardActionHitTarget(library)
      await expectInsideViewport(page, libraryHitTarget, `${label}: Biblioteca`)
      await expectNoDocumentHorizontalOverflow(page, label)
      if (browserName === 'chromium') {
        await testInfo.attach(`pizarra-${viewport.width}px`, {
          body: await page.screenshot({ animations: 'disabled' }),
          contentType: 'image/png',
        })
      }

      if (viewport.width === 320 || viewport.width === 375) {
        await libraryHitTarget.tap()
        await expect(page.locator('.library-menu-items-container')).toBeVisible()
        await expect(page.locator('[data-whiteboard-action]').filter({ visible: true })).toHaveCount(0)
        const internalLibrary = page.locator('[data-whiteboard-sidebar-internal="library"]').filter({ visible: true })
        const internalComments = page.locator('[data-whiteboard-sidebar-internal="comments"]').filter({ visible: true })
        await expect(internalLibrary).toHaveCount(1)
        await expect(internalComments).toHaveCount(0)
        await expectMinimumTouchTarget(internalLibrary, `${label}: tab interno Biblioteca`)
        await expect(page.locator('.sidebar-triggers .sidebar-tab-trigger[data-state="active"]').filter({ visible: true })).toHaveCount(1)
        await expect(page.getByRole('button', { name: 'Más acciones de Pizarras' })).toBeHidden()
        await expectPublicLibraryDisclosure(page, label)
        await page.locator('.sidebar__close').filter({ visible: true }).click()
        await expect(page.locator('.library-menu-items-container')).toBeHidden()
      }

      if (viewport.width === 768) {
        await library.focus()
        await page.keyboard.press('Space')
        await expect(page.locator('.library-menu-items-container')).toBeVisible()
        await page.locator('.sidebar__close').filter({ visible: true }).click()
        await expect(page.locator('.library-menu-items-container')).toBeHidden()
      }
    }
    if (browserName === 'chromium') {
      await page.setViewportSize({ width: 1440, height: 900 })
      await exerciseNativeStyleAndImageExportEnhancements(page, testInfo, requests, false)
      const extraTools = page.getByTitle(/Más herramientas|More tools/u)
      await extraTools.click()
      const extraToolsMenu = page.locator('.App-toolbar__extra-tools-dropdown')
      await expect(extraToolsMenu).toBeVisible()
      await expect(extraToolsMenu.getByTestId('toolbar-highlighter')).toHaveText('Resaltador')
      await expect(extraToolsMenu.getByText('Generate', { exact: true })).toHaveCount(0)
      await extraToolsMenu.getByTestId('toolbar-highlighter').click()
      await expect(extraTools).toHaveClass(/App-toolbar__extra-tools-trigger--selected/u)
    }
    expect(Array.from(requests).filter(url => /\/comment-(?:threads|markers)/u.test(new URL(url).pathname))).toEqual([])
    expect(blocked).toEqual([])
  } catch (cause) {
    throw new Error(
      `Pizarras produjo errores de página: ${JSON.stringify(pageErrors)}. `
      + `Solicitudes fallidas: ${JSON.stringify(requestFailures)}. `
      + `Bloqueadas: ${JSON.stringify(blocked)}. `
      + `API: ${JSON.stringify(Array.from(requests).filter(url => new URL(url).pathname.startsWith('/api/')))}. `
      + `Editor: ${JSON.stringify(Array.from(requests).filter(url => new URL(url).pathname.includes('/vendor/whiteboards-editor/')))}. `
      + `Pizarras: ${JSON.stringify(Array.from(requests).filter(url => new URL(url).pathname.includes('/whiteboards')))}. `
      + `Solicitudes recientes: ${JSON.stringify(Array.from(requests).slice(-20))}`,
      { cause },
    )
  } finally {
    await context.close()
  }
})

test('presión de trazo · Lápiz y Resaltador exponen el control, persisten su modo y reconcilian sin duplicar', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'La persistencia y el realtime de Presión se validan una vez en Chromium.')
  test.setTimeout(360_000)
  const harness = new WhiteboardRealtimeHarness()
  const requests = new Set<string>()
  const blocked: string[] = []
  const explicitNavigations = new Set<string>()
  const firstContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })
  const secondContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })
  await firstContext.addInitScript(() => {
    // Chromium otherwise opens its native save picker, which is not exposed as
    // a Playwright download. Exercise the same audited HTML fallback as Firefox.
    Reflect.deleteProperty(globalThis, 'showOpenFilePicker')
    Reflect.deleteProperty(globalThis, 'showSaveFilePicker')
    Reflect.deleteProperty(globalThis, 'showDirectoryPicker')
  })
  await harness.install(firstContext, 'Ana QA')
  await harness.install(secondContext, 'Luis QA')
  await installWhiteboardHTTP(firstContext, harness, 'Ana QA', requests, blocked, explicitNavigations)
  await installWhiteboardHTTP(secondContext, harness, 'Luis QA', requests, blocked, explicitNavigations)
  const first = await firstContext.newPage()
  const second = await secondContext.newPage()

  const selectHighlighter = async () => {
    const extraTools = first.getByTitle(/Más herramientas|More tools/u)
    await extraTools.click()
    const extraToolsMenu = first.locator('.App-toolbar__extra-tools-dropdown')
    await expect(extraToolsMenu).toBeVisible()
    await extraToolsMenu.getByTestId('toolbar-highlighter').click()
    await expect(extraTools).toHaveClass(/App-toolbar__extra-tools-trigger--selected/u)
  }

  try {
    await Promise.all([openEditor(first), openEditor(second)])
    await expect.poll(() => harness.socketCount(), { timeout: 30_000 }).toBe(2)

    await test.step('Lápiz muestra Presión en el orden pedido y comienza constante', async () => {
      const pencil = first.getByTestId('toolbar-freedraw')
      await pencil.check({ force: true })
      await expect(pencil).toBeChecked()
      const controls = await expectPressureControls(first, 'constant')
      await expect(first.getByRole('group', { name: 'Grosor del trazo' })).toBeVisible()
      await expect(first.getByTestId('opacity')).toBeVisible()
      const order = await controls.pressure.evaluate(fieldset => {
        const siblings = Array.from(fieldset.parentElement?.children || [])
        return {
          strokeWidth: siblings.findIndex(element => (
            element.querySelector(':scope > legend')?.textContent?.trim() === 'Grosor del trazo'
          )),
          pressure: siblings.indexOf(fieldset),
          opacity: siblings.findIndex(element => Boolean(element.querySelector('input[data-testid="opacity"]'))),
        }
      })
      expect(order.strokeWidth).toBeGreaterThanOrEqual(0)
      expect(order.pressure).toBe(order.strokeWidth + 1)
      expect(order.opacity).toBe(order.pressure + 1)
    })

    const pencilConstant = await drawAndCaptureFreeDraw(first, harness, 'Ana QA', 'constant', 0)
    const pencilVariableControls = await expectPressureControls(first, 'constant')
    await pencilVariableControls.variable.focus()
    await first.keyboard.press('Space')
    await expectPressureControls(first, 'variable')
    const pencilVariable = await drawAndCaptureFreeDraw(first, harness, 'Ana QA', 'variable', 54)

    await test.step('Resaltador empieza constante y recuerda su preferencia aparte del Lápiz', async () => {
      await selectHighlighter()
      await expectPressureControls(first, 'constant')
    })
    const highlighterConstant = await drawAndCaptureFreeDraw(first, harness, 'Ana QA', 'constant', 108)
    expect(highlighterConstant.element).toMatchObject({
      strokeColor: '#FFD43B',
      strokeWidth: 4,
      opacity: 40,
    })

    const extraTools = first.getByTitle(/Más herramientas|More tools/u)
    await expect(extraTools).toHaveClass(/App-toolbar__extra-tools-trigger--selected/u)
    await expect(first.getByTestId('toolbar-freedraw')).not.toBeChecked()
    await first.getByTestId('toolbar-freedraw').check({ force: true })
    await expect(first.getByTestId('toolbar-freedraw')).toBeChecked()
    await expect(extraTools).not.toHaveClass(/App-toolbar__extra-tools-trigger--selected/u)
    await expectPressureControls(first, 'variable')
    await selectHighlighter()
    const highlighterVariableControls = await expectPressureControls(first, 'constant')
    await highlighterVariableControls.variable.check({ force: true })
    await expectPressureControls(first, 'variable')
    await selectHighlighter()
    await expectPressureControls(first, 'variable')
    const highlighterVariable = await drawAndCaptureFreeDraw(first, harness, 'Ana QA', 'variable', 162)
    expect(highlighterVariable.element).toMatchObject({
      strokeColor: '#FFD43B',
      strokeWidth: 4,
      opacity: 40,
    })

    await test.step('la exportación de los cuatro trazos produce SVG y PNG válidos sin salir de Clarin', async () => {
      await first.getByTestId('main-menu-trigger').click()
      await first.getByText('Exportar imagen...', { exact: true }).click()
      const exportDialog = first.locator('.ImageExportModal')
      await expect(exportDialog).toBeVisible()
      await expect(exportDialog.locator('.ImageExportModal__preview canvas')).toBeVisible()
      await expect(exportDialog.getByRole('button', { name: 'Exportar a SVG' })).toBeVisible()
      await expect(exportDialog.getByRole('button', { name: 'Exportar a PNG' })).toBeVisible()

      const svgDownloadPromise = first.waitForEvent('download', { timeout: 30_000 })
      await exportDialog.getByRole('button', { name: 'Exportar a SVG' }).click()
      const svgDownload = await svgDownloadPromise
      const svgPath = await svgDownload.path()
      expect(svgPath).not.toBeNull()
      expect(readFileSync(svgPath!, 'utf8')).toContain('<svg')
      await first.locator('.Modal__background').click({ position: { x: 8, y: 8 } })
      await expect(exportDialog).toBeHidden()

      await first.getByTestId('main-menu-trigger').click()
      await first.getByText('Exportar imagen...', { exact: true }).click()
      await expect(exportDialog).toBeVisible()
      const pngDownloadPromise = first.waitForEvent('download', { timeout: 30_000 })
      await exportDialog.getByRole('button', { name: 'Exportar a PNG' }).click()
      const pngDownload = await pngDownloadPromise
      const pngPath = await pngDownload.path()
      expect(pngPath).not.toBeNull()
      expect(readFileSync(pngPath!).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
      await first.locator('.Modal__background').click({ position: { x: 8, y: 8 } })
      await expect(exportDialog).toBeHidden()
    })

    const pressureHistoryOperationIDs: string[] = []
    await test.step('una selección mixta cambia junta y comparte una entrada de undo/redo', async () => {
      const selectedIDs = [String(pencilConstant.element.id), String(pencilVariable.element.id)]
      await selectFreeDraws(first, [pencilConstant, pencilVariable])
      const mixedControls = await expectPressureControls(first, 'mixed')

      pressureHistoryOperationIDs.push(await captureSelectedPressurePatch(
        first,
        harness,
        'Ana QA',
        selectedIDs,
        ['constant', 'constant'],
        () => mixedControls.constant.check({ force: true }),
      ))
      await expectPressureControls(first, 'constant')

      pressureHistoryOperationIDs.push(await captureSelectedPressurePatch(
        first,
        harness,
        'Ana QA',
        selectedIDs,
        ['constant', 'variable'],
        () => first.keyboard.press('Control+z'),
      ))
      await expectPressureControls(first, 'mixed')

      pressureHistoryOperationIDs.push(await captureSelectedPressurePatch(
        first,
        harness,
        'Ana QA',
        selectedIDs,
        ['constant', 'constant'],
        () => first.keyboard.press('Control+Shift+z'),
      ))
      await expectPressureControls(first, 'constant')
      expect(new Set(pressureHistoryOperationIDs).size).toBe(3)
    })

    await test.step('el panel compacto conserva ambas opciones accesibles en 320, 375 y 768 px', async () => {
      for (const viewport of [
        { width: 320, height: 720 },
        { width: 375, height: 812 },
        { width: 768, height: 800 },
      ]) {
        await first.setViewportSize(viewport)
        await waitForEditorResponsiveMode(first)
        if (!await visiblePressureGroup(first).isVisible().catch(() => false)) {
          await first.getByRole('button', { name: 'Editar', exact: true }).filter({ visible: true }).click({ timeout: 5_000 })
        }
        const label = `Presión en ${viewport.width}x${viewport.height}`
        const compactControls = await expectPressureControls(first, 'constant')
        await compactControls.pressure.scrollIntoViewIfNeeded()
        expect(await compactControls.pressure.evaluate(element => {
          const panel = element.closest('section')
          return Boolean(panel?.classList.contains('App-mobile-menu')
            || panel?.classList.contains('selected-shape-actions'))
        }), `${label}: Presión debe pertenecer al panel de propiedades activo`).toBe(true)
        await expectInsideViewport(first, compactControls.pressure, `${label}: grupo`)
        await expectInsideViewport(first, compactControls.constant.locator('..'), `${label}: Constante`)
        await expectInsideViewport(first, compactControls.variable.locator('..'), `${label}: Variable`)
        await expectNoDocumentHorizontalOverflow(first, label)
      }
      await first.setViewportSize({ width: 1440, height: 900 })
    })

    const strokes = [pencilConstant, pencilVariable, highlighterConstant, highlighterVariable]
    const strokeIDs = strokes.map(stroke => String(stroke.element.id))
    const deliveredOperationIDs = [...strokes.map(stroke => stroke.operationID), ...pressureHistoryOperationIDs]
    await expect.poll(() => deliveredOperationIDs.map(operationID => (
      harness.deliveries.filter(delivery => (
        delivery.recipient === 'Luis QA' && delivery.operationID === operationID
      )).length
    )), { timeout: 30_000 }).toEqual(deliveredOperationIDs.map(() => 1))
    await second.evaluate(() => new Promise<void>(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    }))

    await test.step('la segunda sesión y su recarga conservan cada modo sin duplicar elementos', async () => {
      const expectPersistedPressure = (scene: { elements: Array<Record<string, any>> }) => {
        const byID = new Map(scene.elements.map(element => [String(element.id), element]))
        expect(new Set(scene.elements.map(element => String(element.id))).size).toBe(scene.elements.length)
        expect(byID.get(String(pencilConstant.element.id))?.strokeOptions).toEqual({ variability: 'constant', streamline: 0.5 })
        expect(byID.get(String(pencilVariable.element.id))?.strokeOptions).toEqual({ variability: 'constant', streamline: 0.5 })
        expect(byID.get(String(highlighterConstant.element.id))?.strokeOptions).toEqual({ variability: 'constant', streamline: 0.5 })
        expect(byID.get(String(highlighterVariable.element.id))?.strokeOptions).toEqual({ variability: 'variable', streamline: 0.5 })
        expect(strokeIDs.every(id => byID.has(id))).toBe(true)
      }

      expectPersistedPressure(await exportEditableScene(second))
      await second.reload({ waitUntil: 'domcontentloaded' })
      await expect(second.getByLabel('Nombre de la pizarra')).toHaveValue('Pizarra QA autónoma', { timeout: 30_000 })
      await expect(second.locator('canvas.interactive')).toBeVisible({ timeout: 30_000 })
      expectPersistedPressure(await exportEditableScene(second))
    })

    expect(blocked).toEqual([])
  } finally {
    await Promise.all([
      firstContext.close().catch(() => undefined),
      secondContext.close().catch(() => undefined),
    ])
  }
})

test('exportación de fuentes locales · conserva escena, SVG incrustado y PNG en un contexto de escritorio', async ({ browser, browserName }, testInfo) => {
  test.skip(browserName !== 'firefox', 'Firefox usa la ruta de descarga HTML observable por Playwright.')
  test.setTimeout(210_000)
  const harness = new WhiteboardRealtimeHarness()
  const requests = new Set<string>()
  const blocked: string[] = []
  const explicitNavigations = new Set<string>()
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })
  await harness.install(context, 'Ana QA')
  await installWhiteboardHTTP(context, harness, 'Ana QA', requests, blocked, explicitNavigations)
  const page = await context.newPage()
  try {
    await openEditor(page)
    await exerciseNativeStyleAndImageExportEnhancements(page, testInfo, requests, true)
    expect(blocked).toEqual([])
  } finally {
    await context.close()
  }
})

test('precarga de fuentes · informa el fallo, bloquea la familia y reintenta explícitamente', async ({ browser }) => {
  test.setTimeout(120_000)
  const harness = new WhiteboardRealtimeHarness()
  const requests = new Set<string>()
  const blocked: string[] = []
  const explicitNavigations = new Set<string>()
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })
  await harness.install(context, 'Ana QA')
  await installWhiteboardHTTP(context, harness, 'Ana QA', requests, blocked, explicitNavigations)
  const page = await context.newPage()
  let rejectBangersPreview = true
  let bangersRequests = 0
  await page.route('**/10008-bangers-latin-400.woff2*', async route => {
    bangersRequests += 1
    if (rejectBangersPreview) {
      await route.abort('failed')
      return
    }
    await route.continue()
  })

  try {
    await openEditor(page)
    await expect(page.getByText('1 fuente no pudo prepararse. Las fuentes disponibles ya pueden usarse.')).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('toolbar-text').check({ force: true })
    await page.getByTestId('font-family-show-fonts').click()
    const fontList = page.locator('.dropdown-menu.fonts')
    await expect(fontList).toBeVisible()
    let bangersOption = fontList.locator('button.dropdown-menu-item').filter({ hasText: 'Bangers' })
    await expect(bangersOption).toBeDisabled()
    await expect(bangersOption).toHaveAttribute('aria-label', 'Bangers. Fuente no disponible')
    const failedAttemptCount = bangersRequests
    expect(failedAttemptCount).toBeGreaterThan(0)
    await bangersOption.hover({ force: true })
    await bangersOption.scrollIntoViewIfNeeded()
    expect(bangersRequests).toBe(failedAttemptCount)

    rejectBangersPreview = false
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Reintentar fuentes' }).click()
    await expect.poll(() => bangersRequests, { timeout: 10_000 }).toBeGreaterThan(failedAttemptCount)
    await expect(page.getByText('1 fuente no pudo prepararse. Las fuentes disponibles ya pueden usarse.')).toBeHidden({ timeout: 30_000 })
    await page.getByTestId('font-family-show-fonts').click()
    await expect(fontList).toBeVisible()
    bangersOption = fontList.locator('button.dropdown-menu-item').filter({ hasText: 'Bangers' })
    await expect(bangersOption).toBeEnabled()
    await expect(bangersOption).not.toHaveAttribute('aria-label', 'Bangers. Fuente no disponible')
    await expect.poll(async () => bangersOption.locator('.dropdown-menu-item__text').evaluate(element => getComputedStyle(element).fontFamily)).toContain('Clarin Bangers')
    expect(blocked).toEqual([])
  } finally {
    await context.close()
  }
})

test('catálogo precargado de fuentes · conserva la apariencia nativa en tema oscuro', async ({ browser, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'La captura visual de referencia se genera una vez en Chromium.')
  test.setTimeout(120_000)
  const harness = new WhiteboardRealtimeHarness()
  harness.appState.theme = 'dark'
  const requests = new Set<string>()
  const blocked: string[] = []
  const explicitNavigations = new Set<string>()
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })
  await harness.install(context, 'Ana QA')
  await installWhiteboardHTTP(context, harness, 'Ana QA', requests, blocked, explicitNavigations)
  const page = await context.newPage()

  try {
    await openEditor(page)
    const editorRoot = page.locator('.whiteboard-editor-shell .excalidraw')
    await expect(editorRoot).toHaveClass(/theme--dark/u)
    await page.getByTestId('toolbar-text').check({ force: true })
    const showFonts = page.getByTestId('font-family-show-fonts')
    await expect(showFonts).toBeEnabled({ timeout: 30_000 })
    await showFonts.click()
    const fontList = page.locator('.dropdown-menu.fonts')
    await expect(fontList).toBeVisible()
    const bangersOption = fontList.locator('button.dropdown-menu-item').filter({ hasText: 'Bangers' })
    await bangersOption.scrollIntoViewIfNeeded()
    await expect.poll(async () => bangersOption.locator('.dropdown-menu-item__text').evaluate(element => getComputedStyle(element).fontFamily)).toContain('Clarin Bangers')
    await expect(editorRoot).toHaveClass(/theme--dark/u)
    await testInfo.attach('pizarra-selector-fuentes-visibles-oscuro', {
      body: await page.screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    })
    expect(blocked).toEqual([])
  } finally {
    await context.close()
  }
})

test('texto enriquecido · Ctrl+C conserva el texto seleccionado y no lo reemplaza por el sobre del lienzo', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'La escritura asíncrona del portapapeles del sistema se valida en Chromium.')
  test.setTimeout(120_000)
  const harness = new WhiteboardRealtimeHarness()
  const requests = new Set<string>()
  const blocked: string[] = []
  const explicitNavigations = new Set<string>()
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    serviceWorkers: 'block',
    permissions: ['clipboard-read', 'clipboard-write'],
  })
  await harness.install(context, 'Ana QA')
  await installWhiteboardHTTP(context, harness, 'Ana QA', requests, blocked, explicitNavigations)
  const page = await context.newPage()

  try {
    await openEditor(page)
    await page.getByTestId('toolbar-text').check({ force: true })
    await expect(page.getByTestId('font-family-show-fonts')).toBeEnabled({ timeout: 30_000 })
    const surface = page.locator('.whiteboard-editor-shell .excalidraw').first()
    const box = await surface.boundingBox()
    expect(box).not.toBeNull()
    const firstPoint = {
      x: box!.x + box!.width * 0.58,
      y: box!.y + box!.height * 0.38,
    }
    await page.mouse.click(firstPoint.x, firstPoint.y)
    const editable = page.locator('[contenteditable="true"][data-type="wysiwyg"]')
    await expect(editable).toBeVisible()
    await page.keyboard.insertText('sdfsdf')
    await page.keyboard.press('Control+a')

    await page.evaluate(() => {
      const state = window as typeof window & { __clarinClipboardEvidence?: Array<Record<string, unknown>> }
      state.__clarinClipboardEvidence = []
      document.addEventListener('copy', event => {
        const target = event.target
        state.__clarinClipboardEvidence?.push({
          targetTag: target instanceof Element ? target.tagName : null,
          closestWysiwyg: target instanceof Element
            ? Boolean(target.closest('[data-type="wysiwyg"]'))
            : target instanceof Node
              ? Boolean(target.parentElement?.closest('[data-type="wysiwyg"]'))
              : false,
          defaultPrevented: event.defaultPrevented,
          text: event.clipboardData?.getData('text/plain') || '',
          richText: event.clipboardData?.getData('application/x-clarin-rich-text+json') || '',
        })
      })
    })

    // Newly-created text used to be overwritten by a scene envelope containing
    // the whole text element. The system clipboard must remain plain text even
    // after the global async Clipboard API has had time to run.
    await page.keyboard.press('Control+c')
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('sdfsdf')

    await page.getByTestId('clarin-text-mark-negrita').click()
    await expect.poll(async () => editable.locator('span').first().evaluate(element => getComputedStyle(element).fontWeight))
      .toBe('700')
    await page.keyboard.press('Control+c')
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('sdfsdf')
    const evidence = await page.evaluate(() => {
      const state = window as typeof window & { __clarinClipboardEvidence?: Array<Record<string, unknown>> }
      return state.__clarinClipboardEvidence || []
    })
    const latestCopy = evidence.at(-1) as { closestWysiwyg?: boolean; defaultPrevented?: boolean; text?: string; richText?: string }
    expect(latestCopy).toMatchObject({ closestWysiwyg: true, defaultPrevented: true, text: 'sdfsdf' })
    expect(JSON.parse(latestCopy.richText || '{}')).toMatchObject({
      version: 1,
      text: 'sdfsdf',
      format: { runs: [{ from: 0, to: 6, marks: 1 }] },
    })

    // Reopening an existing text reproduced the reported empty envelope
    // {elements: []}. It must now retain the selected characters instead.
    await page.keyboard.press('Control+Enter')
    await expect(editable).toBeHidden()
    await page.getByTestId('toolbar-selection').check({ force: true })
    await page.mouse.dblclick(firstPoint.x + 18, firstPoint.y + 12)
    await expect(editable).toBeVisible()
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Control+c')
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('sdfsdf')

    // Paste in a second row of the same element and preserve the private rich
    // text range alongside the plain-text representation.
    await page.keyboard.press('Control+End')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Control+v')
    await expect.poll(() => editable.evaluate(element => element.textContent)).toBe('sdfsdf\nsdfsdf')
    await expect.poll(async () => editable.locator('span').evaluateAll(elements =>
      elements
        .filter(element => Boolean(element.textContent?.trim()))
        .map(element => getComputedStyle(element).fontWeight),
    )).toEqual(['700', '700'])
    await page.keyboard.press('Control+Enter')

    // Pasting outside Excalidraw must receive the same selected text, proving
    // the system clipboard itself was not corrupted by the canvas handler.
    await page.evaluate(() => {
      const textarea = document.createElement('textarea')
      textarea.id = 'clarin-external-clipboard-target'
      document.body.append(textarea)
    })
    const externalTarget = page.locator('#clarin-external-clipboard-target')
    await externalTarget.focus()
    await page.keyboard.press('Control+v')
    await expect(externalTarget).toHaveValue('sdfsdf')
    await externalTarget.evaluate(element => element.remove())

    // Paste into a distinct Excalidraw text element and retain the formatting.
    await page.getByTestId('toolbar-text').check({ force: true })
    await page.mouse.click(firstPoint.x, firstPoint.y + 130)
    await expect(editable).toBeVisible()
    await page.keyboard.press('Control+v')
    await expect.poll(() => editable.evaluate(element => element.textContent)).toBe('sdfsdf')
    await expect.poll(async () => editable.locator('span').first().evaluate(element => getComputedStyle(element).fontWeight))
      .toBe('700')
    await page.keyboard.press('Control+Enter')
    await expectEditorSaved(page)
    await expect.poll(() => harness.elements.filter(element => element.type === 'text' && String(element.originalText).startsWith('sdfsdf')).length)
      .toBe(2)

    // Outside text editing, canvas copy must continue using the Excalidraw
    // scene envelope and include the selected element.
    await page.keyboard.press('Control+c')
    await expect.poll(async () => {
      const value = await page.evaluate(() => navigator.clipboard.readText())
      try {
        const parsed = JSON.parse(value) as { type?: string; elements?: unknown[] }
        return { type: parsed.type, elements: parsed.elements?.length || 0 }
      } catch {
        return { type: '', elements: 0 }
      }
    }).toEqual({ type: 'excalidraw/clipboard', elements: 1 })
    expect(blocked).toEqual([])
  } finally {
    await context.close()
  }
})

test('texto enriquecido · cursiva se activa y desactiva sin depender de negrita', async ({ browser }) => {
  test.setTimeout(120_000)
  const harness = new WhiteboardRealtimeHarness()
  const requests = new Set<string>()
  const blocked: string[] = []
  const explicitNavigations = new Set<string>()
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })
  await harness.install(context, 'Ana QA')
  await installWhiteboardHTTP(context, harness, 'Ana QA', requests, blocked, explicitNavigations)
  const page = await context.newPage()

  try {
    await openEditor(page)
    await page.getByTestId('toolbar-text').check({ force: true })
    await expect(page.getByTestId('font-family-show-fonts')).toBeEnabled({ timeout: 30_000 })
    const surface = page.locator('.whiteboard-editor-shell .excalidraw').first()
    const box = await surface.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.click(box!.x + box!.width * 0.58, box!.y + box!.height * 0.38)
    const editable = page.locator('[contenteditable="true"][data-type="wysiwyg"]')
    await expect(editable).toBeVisible()
    await page.keyboard.type('Solo cursiva')
    await page.keyboard.press('Control+a')

    const selectionSnapshot = () => editable.evaluate(element => {
      const selection = window.getSelection()
      const richEditable = element as HTMLElement & { selectionStart: number; selectionEnd: number }
      return {
        start: richEditable.selectionStart,
        end: richEditable.selectionEnd,
        text: selection?.toString() ?? '',
        anchorInside: Boolean(selection?.anchorNode && element.contains(selection.anchorNode)),
        focusInside: Boolean(selection?.focusNode && element.contains(selection.focusNode)),
      }
    })
    const selected = { start: 0, end: 12, text: 'Solo cursiva', anchorInside: true, focusInside: true }
    await expect.poll(selectionSnapshot).toEqual(selected)

    const italic = page.getByTestId('clarin-text-mark-cursiva')
    const bold = page.getByTestId('clarin-text-mark-negrita')
    await expect(italic).toHaveAttribute('aria-pressed', 'false')
    await expect(bold).toHaveAttribute('aria-pressed', 'false')

    await italic.click()
    await expect(italic).toHaveAttribute('aria-pressed', 'true')
    await expect(bold).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(selectionSnapshot).toEqual(selected)
    await expect.poll(async () => editable.locator('[data-clarin-paragraph-start="0"] span').evaluateAll(elements =>
      elements.map(element => getComputedStyle(element).fontStyle),
    )).toEqual(['italic'])

    await italic.click({ position: { x: 4, y: 4 } })
    await expect(italic).toHaveAttribute('aria-pressed', 'false')
    await expect(bold).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(selectionSnapshot).toEqual(selected)
    await expect.poll(async () => editable.locator('[data-clarin-paragraph-start="0"] span').evaluateAll(elements =>
      elements.map(element => getComputedStyle(element).fontStyle),
    )).toEqual(['normal'])

    // Reproduce the real browser race: pointerdown captures the range, but a
    // focus/selectionchange collapses the live DOM selection before click.
    // The command must still consume the immutable captured range.
    await italic.click()
    await expect(italic).toHaveAttribute('aria-pressed', 'true')
    await italic.dispatchEvent('pointerdown', { pointerType: 'mouse', button: 0 })
    await editable.evaluate(element => {
      const text = element.querySelector('[data-clarin-paragraph-start="0"] span')?.firstChild
      if (!text) throw new Error('No se encontró el nodo de texto cursivo')
      const selection = window.getSelection()
      const range = document.createRange()
      range.setStart(text, text.textContent?.length ?? 0)
      range.collapse(true)
      selection?.removeAllRanges()
      selection?.addRange(range)
    })
    await expect.poll(selectionSnapshot).toEqual({
      start: 12,
      end: 12,
      text: '',
      anchorInside: true,
      focusInside: true,
    })
    await italic.dispatchEvent('pointerup', { pointerType: 'mouse', button: 0 })
    await italic.dispatchEvent('click', { button: 0 })
    await expect(italic).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(selectionSnapshot).toEqual(selected)
    await expect.poll(async () => editable.locator('[data-clarin-paragraph-start="0"] span').evaluateAll(elements =>
      elements.map(element => getComputedStyle(element).fontStyle),
    )).toEqual(['normal'])

    await page.keyboard.press('Control+Enter')
    await expect(editable).toBeHidden()
    await expect.poll(() => Boolean(harness.elements.find(element => element.type === 'text' && element.originalText === 'Solo cursiva')))
      .toBe(true)
    await expect.poll(() => harness.elements.find(element => element.type === 'text' && element.originalText === 'Solo cursiva')?.customData?.clarinTextFormat ?? null)
      .toBeNull()
    await expectEditorSaved(page)
    const exported = await exportEditableScene(page)
    const formatted = exported.elements.find(element => element.type === 'text' && element.originalText === 'Solo cursiva')
    expect(formatted?.customData ?? {}).not.toHaveProperty('clarinTextFormat')

    // The same final-field removal must work when the element is selected but
    // no contenteditable is active (ActionManager/newElementWith path).
    await italic.click()
    await expect.poll(() => harness.elements.find(element => element.type === 'text' && element.originalText === 'Solo cursiva')?.customData?.clarinTextFormat?.runs ?? null)
      .toEqual([{ from: 0, to: 12, marks: 2 }])
    await italic.click()
    await expect.poll(() => harness.elements.find(element => element.type === 'text' && element.originalText === 'Solo cursiva')?.customData?.clarinTextFormat ?? null)
      .toBeNull()
    await expectEditorSaved(page)
    const exportedAfterWholeElementToggle = await exportEditableScene(page)
    const unformatted = exportedAfterWholeElementToggle.elements.find(element => element.type === 'text' && element.originalText === 'Solo cursiva')
    expect(unformatted?.customData ?? {}).not.toHaveProperty('clarinTextFormat')
    expect(blocked).toEqual([])
  } finally {
    await context.close()
  }
})

test('texto enriquecido · aplica marcas combinadas sólo a la selección, deshace y persiste', async ({ browser }) => {
  test.setTimeout(120_000)
  const harness = new WhiteboardRealtimeHarness()
  const requests = new Set<string>()
  const blocked: string[] = []
  const explicitNavigations = new Set<string>()
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })
  await harness.install(context, 'Ana QA')
  await installWhiteboardHTTP(context, harness, 'Ana QA', requests, blocked, explicitNavigations)
  const page = await context.newPage()

  try {
    await openEditor(page)
    await page.getByTestId('toolbar-text').check({ force: true })
    await expect(page.getByTestId('font-family-show-fonts')).toBeEnabled({ timeout: 30_000 })
    const surface = page.locator('.whiteboard-editor-shell .excalidraw').first()
    const box = await surface.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.click(box!.x + box!.width * 0.58, box!.y + box!.height * 0.38)
    const editable = page.locator('[contenteditable="true"][data-type="wysiwyg"]')
    await expect(editable).toBeVisible()
    await page.keyboard.type('Título')
    await page.keyboard.press('Enter')
    await page.keyboard.type('Cuerpo')
    expect(await editable.evaluate(element => element.textContent)).toBe('Título\nCuerpo')
    await page.keyboard.press('Control+Home')
    for (let index = 0; index < 'Título'.length; index += 1) {
      await page.keyboard.press('Shift+ArrowRight')
    }
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('Título')

    await page.getByTestId('clarin-text-mark-negrita').click()
    await page.keyboard.press('Control+i')
    await page.getByTestId('clarin-text-mark-subrayado').click()
    await page.keyboard.press('Control+Shift+x')
    await expect.poll(async () => editable.locator('span').first().evaluate(element => ({
      weight: getComputedStyle(element).fontWeight,
      style: getComputedStyle(element).fontStyle,
      decoration: getComputedStyle(element).textDecorationLine.split(' ').sort(),
    }))).toEqual({ weight: '700', style: 'italic', decoration: ['line-through', 'underline'] })

    await page.keyboard.press('Control+z')
    await expect.poll(async () => editable.locator('span').first().evaluate(element => getComputedStyle(element).textDecorationLine))
      .toBe('underline')
    await page.keyboard.press('Control+Shift+z')
    await expect.poll(async () => editable.locator('span').first().evaluate(element => getComputedStyle(element).textDecorationLine.split(' ').sort()))
      .toEqual(['line-through', 'underline'])

    // Regression: clicking the glyph or its surrounding button must retain the
    // same selection and allow bold to be removed and reapplied repeatedly.
    await page.getByTestId('clarin-text-mark-negrita').click()
    await expect.poll(async () => editable.locator('span').first().evaluate(element => getComputedStyle(element).fontWeight))
      .toBe('400')
    await page.getByTestId('clarin-text-mark-negrita').click({ position: { x: 4, y: 4 } })
    await expect.poll(async () => editable.locator('span').first().evaluate(element => getComputedStyle(element).fontWeight))
      .toBe('700')

    // Alignment follows the same selection contract, but expands it to every
    // logical paragraph touched by the selected characters.
    await page.getByTestId('align-horizontal-center').click({ force: true })
    await expect.poll(async () => editable.locator('[data-clarin-paragraph-start="0"]').evaluate(element => getComputedStyle(element).textAlign))
      .toBe('center')
    await expect.poll(async () => editable.locator('[data-clarin-paragraph-start="7"]').evaluate(element => getComputedStyle(element).textAlign))
      .toBe('left')

    // A selection spanning both paragraphs promotes a uniform result to the
    // element alignment. Undo must restore the exact mixed paragraph state.
    await editable.focus()
    await page.keyboard.press('Control+a')
    await page.getByTestId('align-right').click({ force: true })
    await expect.poll(async () => editable.locator('[data-clarin-paragraph-start="0"]').evaluate(element => getComputedStyle(element).textAlign))
      .toBe('right')
    await expect.poll(async () => editable.locator('[data-clarin-paragraph-start="7"]').evaluate(element => getComputedStyle(element).textAlign))
      .toBe('right')
    await page.keyboard.press('Control+z')
    await expect.poll(async () => editable.locator('[data-clarin-paragraph-start="0"]').evaluate(element => getComputedStyle(element).textAlign))
      .toBe('center')
    await expect.poll(async () => editable.locator('[data-clarin-paragraph-start="7"]').evaluate(element => getComputedStyle(element).textAlign))
      .toBe('left')
    await page.keyboard.press('Control+Enter')
    await expect(editable).toBeHidden()

    await expect.poll(() => harness.elements.find(element => element.type === 'text' && element.originalText === 'Título\nCuerpo'))
      .toMatchObject({
        textAlign: 'left',
        customData: {
          clarinParagraphFormat: {
            version: 1,
            textLength: 13,
            paragraphs: [{ start: 0, align: 'center' }],
          },
        },
      })

    // Outside editing, a mixed whole-element underline state applies the mark
    // to the complete text while preserving the title's other marks.
    await page.getByTestId('clarin-text-mark-subrayado').click()
    await expect.poll(() => harness.elements.find(element => element.type === 'text' && element.originalText === 'Título\nCuerpo')?.customData)
      .toMatchObject({
        clarinTextFormat: {
          version: 1,
          textLength: 13,
          runs: [
            { from: 0, to: 6, marks: 15 },
            { from: 6, to: 13, marks: 4 },
          ],
        },
      })
    await expectEditorSaved(page)
    const exported = await exportEditableScene(page)
    const formatted = exported.elements.find(element => element.type === 'text' && element.originalText === 'Título\nCuerpo')
    expect(formatted?.text).toBe('Título\nCuerpo')
    expect(formatted?.customData?.clarinTextFormat?.runs).toEqual([
      { from: 0, to: 6, marks: 15 },
      { from: 6, to: 13, marks: 4 },
    ])
    expect(formatted?.textAlign).toBe('left')
    expect(formatted?.customData?.clarinParagraphFormat?.paragraphs).toEqual([
      { start: 0, align: 'center' },
    ])

    // Outside editing, alignment applies to the complete element and removes
    // obsolete paragraph overrides atomically.
    await page.getByTestId('align-right').click({ force: true })
    await expect.poll(() => harness.elements.find(element => element.type === 'text' && element.originalText === 'Título\nCuerpo'))
      .toMatchObject({ textAlign: 'right' })
    expect(harness.elements.find(element => element.type === 'text' && element.originalText === 'Título\nCuerpo')?.customData)
      .not.toHaveProperty('clarinParagraphFormat')
    expect(blocked).toEqual([])
  } finally {
    await context.close()
  }
})

test('integración simulada · permiso Comentar conserva el backend pero no monta ni intercepta la UI oculta', async ({ browser, browserName }) => {
  test.setTimeout(150_000)
  const harness = new WhiteboardRealtimeHarness()
  harness.effectiveAccess = {
    level: 'comment',
    inherited_from: 'grant',
    can_view: true,
    can_comment: true,
    can_edit: false,
    can_manage_access: false,
  }
  const requests = new Set<string>()
  const blocked: string[] = []
  const explicitNavigations = new Set<string>()
  const context = await browser.newContext({ hasTouch: browserName === 'firefox', serviceWorkers: 'block' })

  try {
    await harness.install(context, 'Ana QA')
    await installWhiteboardHTTP(context, harness, 'Ana QA', requests, blocked, explicitNavigations)

    const page = await context.newPage()
    await openEditor(page)
    await expect(page.getByText('Solo lectura', { exact: true })).toBeVisible()
    await expectWhiteboardChromeOwnership(page, `${browserName} comment-only`)
    const canvas = page.locator('.whiteboard-editor-shell canvas.interactive').first()
    const box = await canvas.boundingBox()
    expect(box).not.toBeNull()
    const clickX = box!.x + Math.min(480, box!.width - 80)
    const clickY = box!.y + Math.min(420, box!.height - 80)
    if (browserName === 'firefox') await page.touchscreen.tap(clickX, clickY)
    else await page.mouse.click(clickX, clickY)
    await expect(page.getByLabel('Comentarios de la pizarra')).toHaveCount(0)
    await expect(page.getByLabel('Pines de comentarios')).toHaveCount(0)
    expect(Array.from(requests).filter(url => /\/comment-(?:threads|markers)/u.test(new URL(url).pathname))).toEqual([])
    expect(harness.httpSceneWrites).toEqual([])
    expect(blocked).toEqual([])
  } finally {
    await context.close()
  }
})

test('integración simulada · el checkpoint automático conserva zoom y herramienta de la sesión activa', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'La regresión determinista del editor usa Chromium.')
  test.setTimeout(180_000)
  const harness = new WhiteboardRealtimeHarness()
  const requests = new Set<string>()
  const blocked: string[] = []
  const explicitNavigations = new Set<string>()
  const context = await browser.newContext({ serviceWorkers: 'block' })
  await harness.install(context, 'Ana QA')
  await installWhiteboardHTTP(context, harness, 'Ana QA', requests, blocked, explicitNavigations)
  const page = await context.newPage()

  try {
    await openEditor(page)
    await expect.poll(() => harness.socketCount()).toBe(1)
    await page.getByTestId('toolbar-rectangle').check({ force: true })
    await expect(page.getByTestId('toolbar-rectangle')).toBeChecked()
    await page.locator('.zoom-in-button').click()
    await page.locator('.zoom-in-button').click()
    const zoomBeforeCheckpoint = (await page.locator('.reset-zoom-button').innerText()).trim()
    expect(zoomBeforeCheckpoint).not.toBe('100%')

    harness.broadcastAutomaticSnapshot()
    await page.waitForTimeout(500)

    await expect(page.locator('.reset-zoom-button')).toHaveText(zoomBeforeCheckpoint)
    await expect(page.getByTestId('toolbar-rectangle')).toBeChecked()
    expect(blocked).toEqual([])
  } finally {
    await context.close()
  }
})

test('integración simulada · el gestor usa compacta por defecto y mueve pizarras con selector, drag y rollback', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'La interacción de puntero determinista usa Chromium.')
  // This scenario intentionally performs the complete picker, pointer, keyboard,
  // conflict rollback and folder-configuration sequence. Keep enough headroom
  // for a cold Next.js development compile without weakening any assertion.
  test.setTimeout(240_000)
  const harness = new WhiteboardRealtimeHarness()
  harness.createdFolders.push(
    { id: 'folder-1', name: 'Carpeta completa', parentID: null },
    { id: 'folder-2', name: 'Subcarpeta completa', parentID: 'folder-1' },
  )
  const requests = new Set<string>()
  const blocked: string[] = []
  const explicitNavigations = new Set<string>()
  const context = await browser.newContext({ serviceWorkers: 'block' })
  await harness.install(context, 'Ana QA')
  await installWhiteboardHTTP(context, harness, 'Ana QA', requests, blocked, explicitNavigations)
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  page.setDefaultNavigationTimeout(60_000)

  try {
    await page.goto(`${baseURL}/dashboard/whiteboards`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Mis pizarras' })).toBeVisible({ timeout: 20_000 })
    await exerciseManagerViewsAndFolderMoves(page, harness)
    expect(blocked).toEqual([])
  } finally {
    await context.close()
  }
})

test('integración simulada · Comentarios permanece inactivo y el catálogo público completa el flujo dentro de Pizarras', async ({ browser, browserName }) => {
  test.setTimeout(240_000)
  const harness = new WhiteboardRealtimeHarness()
  const requests = new Set<string>()
  const blocked: string[] = []
  const explicitNavigations = new Set<string>()
  // Next.js development bundles use eval. A redirect fulfilled by Playwright
  // skips document route interception, so bypass CSP only in this local flow;
  // production CSP remains covered by the hardening checks.
  const context = await browser.newContext({ bypassCSP: process.env.PLAYWRIGHT_LOCAL_SERVER === '1', serviceWorkers: 'block' })
  try {
    await harness.install(context, 'Ana QA')
    await installWhiteboardHTTP(context, harness, 'Ana QA', requests, blocked, explicitNavigations)

  const actorID = actorIDFor('Ana QA')
  const personalLibraryID = personalLibraryIDFor('Ana QA')
  const importID = '30000000-0000-4000-8000-000000000011'
  const callbackToken = 'whiteboard_public_library_callback_qa_123456'
  const navigationPath = `/api/whiteboards/${boardID}/public-library-imports/${importID}/navigate`
  const publicLibraryURL = 'https://libraries.excalidraw.com/libraries/qa/architecture.excalidrawlib'
  const publicItem = clone(libraryFixture.libraryItems[1])
  publicItem.id = 'public-architecture-item'
  publicItem.name = 'Arquitectura pública QA'
  publicItem.status = 'unpublished'
  publicItem.elements[0].id = 'public-architecture-arrow'
  const validatedPublicLibrary = {
    type: 'excalidrawlib',
    version: 2,
    source: 'clarin',
    libraryItems: [publicItem],
  }
  let personalLibraryJSON: Record<string, any> = { type: 'excalidrawlib', version: 2, source: 'clarin', libraryItems: [] }
  let personalLibraryVersion = 1
  const callbackWrites: Array<Record<string, any>> = []
  const importOrder: string[] = []
  let importReads = 0
  let libraryWrites = 0
  let importCompletions = 0

  await context.route(`**/api/whiteboards/${boardID}/public-library-import/start?*`, async route => {
    expect(route.request().method()).toBe('POST')
    const headers = await route.request().allHeaders()
    expect(headers.origin).toBe(baseURL)
    expect(headers['x-clarin-whiteboard-library-start']).toBe('1')
    await json(route, { success: true, navigation_path: navigationPath })
  })
  await context.route(`**${navigationPath}`, async route => {
    expect(route.request().method()).toBe('GET')
    const callback = `${baseURL}/whiteboards/library-import#addLibrary=${encodeURIComponent(publicLibraryURL)}&token=${callbackToken}`
    if (browserName === 'webkit') {
      // Playwright's WebKit route shim cannot synthesize redirect statuses.
      // The backend integration covers the real 302; this keeps the browser
      // matrix on the same top-level callback and persistence path.
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        headers: { 'cache-control': 'no-store' },
        body: `<script>window.location.replace(${JSON.stringify(callback)})</script>`,
      })
      return
    }
    await route.fulfill({ status: 302, headers: { location: callback, 'cache-control': 'no-store' }, body: '' })
  })
  await context.route('**/api/whiteboards/public-library-import/callback', async route => {
    const payload = route.request().postDataJSON() as Record<string, any>
    callbackWrites.push(payload)
    await json(route, { success: true, board_id: boardID, import_id: importID })
  })
  await context.route(`**/api/whiteboards/${boardID}/public-library-imports/${importID}`, async route => {
    importReads += 1
    await json(route, {
      success: true,
      import: {
        id: importID,
        board_id: boardID,
        library_id: personalLibraryID,
        status: 'ready',
        source_url: publicLibraryURL,
        library_json: validatedPublicLibrary,
        expires_at: '2026-08-14T21:00:00Z',
      },
    })
  })
  await context.route(`**/api/whiteboards/${boardID}/public-library-imports/${importID}/complete`, async route => {
    importCompletions += 1
    importOrder.push('complete')
    const payload = route.request().postDataJSON() as Record<string, any>
    expect(payload.operation_id).toBe(importID)
    expect(payload.library_version).toBe(personalLibraryVersion)
    await json(route, {
      success: true,
      import: {
        id: importID,
        board_id: boardID,
        library_id: personalLibraryID,
        status: 'completed',
        expires_at: '2026-08-14T21:00:00Z',
      },
    })
  })
  await context.route('**/api/whiteboard-libraries', async route => {
    if (route.request().method() !== 'GET') {
      await route.fallback()
      return
    }
    await json(route, {
      success: true,
      libraries: [
        {
          id: personalLibraryID, name: `Mi biblioteca · ${actorID}`, description: '', library_json: personalLibraryJSON,
          visibility: 'private', version: personalLibraryVersion, created_by: actorID, updated_by: actorID, created_at: now, updated_at: now,
        },
        {
          id: 'library-account-qa', name: 'Catálogo QA interno', description: 'Solo dentro de Clarin',
          library_json: { libraryItems: clone(libraryFixture.libraryItems) }, visibility: 'account', version: 1,
          created_by: 'account-admin', updated_by: 'account-admin', created_at: now, updated_at: now,
        },
      ],
      next_cursor: null,
    })
  })
  await context.route(`**/api/whiteboard-libraries/${personalLibraryID}`, async route => {
    if (route.request().method() !== 'PUT') {
      await route.fallback()
      return
    }
    const payload = route.request().postDataJSON() as Record<string, any>
    libraryWrites += 1
    importOrder.push('put')
    personalLibraryJSON = payload.library_json
    personalLibraryVersion += 1
    await json(route, {
      success: true,
      library: {
        id: personalLibraryID,
        name: payload.name,
        description: payload.description || '',
        library_json: personalLibraryJSON,
        visibility: 'private',
        version: personalLibraryVersion,
        created_by: actorID,
        updated_by: actorID,
        created_at: now,
        updated_at: now,
      },
    })
  })

  const page = await context.newPage()
  const requestFailures: Array<{ url: string; error: string }> = []
  const pageErrors: string[] = []
  const callbackDocumentPaths: string[] = []
  page.on('request', request => {
    const url = new URL(request.url())
    if (request.resourceType() === 'document' && url.pathname === '/whiteboards/library-import') {
      callbackDocumentPaths.push(url.pathname)
    }
  })
  page.on('requestfailed', request => recordWhiteboardRequestFailure(requestFailures, request))
  page.on('pageerror', error => pageErrors.push(error.message))

    await test.step('abre el editor y deja listas las bibliotecas internas', async () => {
      await openEditor(page)
      await expect(page.getByLabel('Guardado en Clarin')).toBeVisible({ timeout: 30_000 })
      expect(requestFailures).toEqual([])
      await expect(page.getByText('Solicitud cancelada', { exact: true })).toHaveCount(0)
    })

    await test.step('mantiene Comentarios totalmente fuera de la interfaz y de la carga inicial', async () => {
      await expectWhiteboardChromeOwnership(page, 'flujo simulado sin comentarios')
      expect(Array.from(requests).filter(url => /\/comment-(?:threads|markers)/u.test(new URL(url).pathname))).toEqual([])
    })

    await test.step('abre el catálogo y completa el callback seguro', async () => {
    const { library: libraryToggle } = await expectWhiteboardChromeOwnership(page, 'flujo simulado de biblioteca')
    await whiteboardActionHitTarget(libraryToggle).click()
    const browse = page.locator('.library-menu-browse-button')
    await expect(browse).toBeVisible()
    await expectPublicLibraryDisclosure(page, 'flujo simulado de biblioteca')
    // The native link may remain rendered while an ownership cleanup replaces
    // the global used to create it. The click must still be a real document
    // navigation, never a Next.js/RSC fetch rejected by the backend guard.
    await page.evaluate(() => { delete (globalThis as any).__CLARIN_WHITEBOARD_LIBRARY_START_URL__ })
    await browse.click()

    await expect.poll(() => callbackWrites.length, {
      timeout: 30_000,
      message: `callback pendiente; URL=${page.url()}`,
    }).toBe(1)
    expect(callbackWrites[0]).toEqual({ token: callbackToken, library_url: publicLibraryURL })
    expect(callbackDocumentPaths).toContain('/whiteboards/library-import')
    })

    await test.step('recupera la importación validada al volver al editor', async () => {
      await expect.poll(() => importReads, {
        timeout: 30_000,
        message: `GET import pendiente; URL=${page.url()}; callback=${callbackWrites.length}`,
      }).toBeGreaterThan(0)
    })

    await test.step('persiste la biblioteca pública en Mi biblioteca', async () => {
      await expect.poll(() => libraryWrites, {
        timeout: 30_000,
        message: `PUT library pendiente; URL=${page.url()}; GET=${importReads}; orden=${importOrder.join(',')}`,
      }).toBe(1)
    expect(personalLibraryJSON.libraryItems.some((item: Record<string, any>) => item.id === 'public-architecture-item')).toBe(true)
    })

    await test.step('confirma la importación y limpia la URL', async () => {
      await expect.poll(() => importCompletions, {
        timeout: 30_000,
        message: `complete pendiente; URL=${page.url()}; GET=${importReads}; PUT=${libraryWrites}; orden=${importOrder.join(',')}`,
      }).toBe(1)
      expect(importOrder).toEqual(['put', 'complete'])
      await expect(page).toHaveURL(`${baseURL}/dashboard/whiteboards/${boardID}`, { timeout: 30_000 })
      await expect(page.locator('.library-menu-items-container')).toBeVisible({ timeout: 30_000 })
      expect(requestFailures).toEqual([])
      expect(pageErrors).toEqual([])
      expect(blocked).toEqual([])
    })
  } finally {
    await context.close().catch(() => undefined)
  }
})

test('integración simulada · abre antes de las imágenes, hidrata progresivamente y permite guardar', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'La cola progresiva se valida una vez en Chromium.')
  test.setTimeout(120_000)
  const harness = new WhiteboardRealtimeHarness()
  const requests = new Set<string>()
  const blocked: string[] = []
  const explicitNavigations = new Set<string>()
  const fileIDs = Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(40, '0'))
  harness.elements = [
    clone(loadedTextFixture),
    ...fileIDs.map((fileID, index) => ({
      ...clone(imageElementFixture),
      id: `progressive-image-${index + 1}`,
      fileId: fileID,
      index: `b${String(index + 1).padStart(2, '0')}`,
      x: index < 2 ? 120 + index * 180 : 3_000 + index * 180,
      y: index < 2 ? 180 : 2_000,
      link: null,
    })),
  ]
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })
  const releases = new Map<string, () => void>()
  let activeDownloads = 0
  let peakDownloads = 0
  try {
    await harness.install(context, 'Ana QA')
    await installWhiteboardHTTP(context, harness, 'Ana QA', requests, blocked, explicitNavigations)
    await context.route(`**/api/whiteboards/${boardID}/assets**`, async route => {
      const url = new URL(route.request().url())
      if (url.pathname === `/api/whiteboards/${boardID}/assets` && route.request().method() === 'GET') {
        await json(route, {
          success: true,
          assets: fileIDs.map((fileID, index) => ({
            id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
            board_id: boardID,
            file_id: fileID,
            kind: 'asset',
            filename: `${fileID}.png`,
            content_type: 'image/png',
            size_bytes: imageFixtureBytes.length,
            created_at: now,
          })),
          next_cursor: null,
        })
        return
      }
      if (!url.pathname.startsWith(`/api/whiteboards/${boardID}/assets/`) || route.request().method() !== 'GET') {
        await route.fallback()
        return
      }
      const assetID = url.pathname.split('/').at(-1) || ''
      activeDownloads += 1
      peakDownloads = Math.max(peakDownloads, activeDownloads)
      await new Promise<void>(resolve => { releases.set(assetID, resolve) })
      activeDownloads -= 1
      await route.fulfill({ status: 200, contentType: 'image/png', body: imageFixtureBytes })
    })

    const page = await context.newPage()
    await openEditor(page)
    await expect(page.getByText('Cargando imágenes 0 de 12…')).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => releases.size).toBe(4)
    expect(peakDownloads).toBe(4)

    const writesBeforeEdit = harness.patchAttempts.length + harness.httpSceneWrites.length
    await drawRectangle(page, 12)
    await expect.poll(() => harness.patchAttempts.length + harness.httpSceneWrites.length).toBeGreaterThan(writesBeforeEdit)
    await expectEditorSaved(page)
    const writesAfterEdit = harness.patchAttempts.length + harness.httpSceneWrites.length
    await expect(page.getByText('Una imagen todavía no terminó de prepararse.')).toHaveCount(0)

    const released = new Set<string>()
    while (released.size < fileIDs.length) {
      await expect.poll(() => releases.size, { timeout: 30_000 }).toBeGreaterThan(released.size)
      for (const [assetID, release] of releases) {
        if (released.has(assetID)) continue
        released.add(assetID)
        release()
      }
    }
    await expect(page.getByText(/Cargando imágenes/)).toHaveCount(0, { timeout: 30_000 })
    await expect(page.getByText(/imágenes no pudieron cargarse/)).toHaveCount(0)
    await page.waitForTimeout(750)
    expect(harness.patchAttempts.length + harness.httpSceneWrites.length).toBe(writesAfterEdit)
    expect(peakDownloads).toBe(4)
    expect(blocked).toEqual([])
  } finally {
    for (const release of releases.values()) release()
    await context.close().catch(() => undefined)
  }
})

test('integración simulada · invitado abre el lienzo antes de descargar la imagen', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'La ruta compartida progresiva se valida una vez en Chromium.')
  test.setTimeout(90_000)
  const harness = new WhiteboardRealtimeHarness()
  const requests = new Set<string>()
  const blocked: string[] = []
  const fileID = '9999999999999999999999999999999999999999'
  harness.elements = [{ ...clone(imageElementFixture), id: 'guest-progressive-image', fileId: fileID, link: null }]
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' })
  let releaseDownload: (() => void) | null = null
  try {
    await harness.install(context, 'Marta Invitada')
    const shareLinkID = await installGuestWhiteboardHTTP(context, harness, requests, blocked)
    await context.route('**/api/whiteboard-guest/assets**', async route => {
      const url = new URL(route.request().url())
      if (url.pathname === '/api/whiteboard-guest/assets') {
        await json(route, {
          success: true,
          assets: [{
            id: '40000000-0000-4000-8000-000000000001',
            file_id: fileID,
            kind: 'asset',
            filename: `${fileID}.png`,
            content_type: 'image/png',
            size_bytes: imageFixtureBytes.length,
            created_at: now,
          }],
          next_cursor: null,
        })
        return
      }
      if (!url.pathname.startsWith('/api/whiteboard-guest/assets/')) {
        await route.fallback()
        return
      }
      await new Promise<void>(resolve => { releaseDownload = resolve })
      await route.fulfill({ status: 200, contentType: 'image/png', body: imageFixtureBytes })
    })
    const page = await context.newPage()
    await openGuestEditor(page, shareLinkID)
    await expect(page.getByText('Cargando imágenes 0 de 1…')).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => Boolean(releaseDownload)).toBe(true)
    releaseDownload?.()
    await expect(page.getByText(/Cargando imágenes/)).toHaveCount(0, { timeout: 30_000 })
    expect(blocked).toEqual([])
  } finally {
    releaseDownload?.()
    await context.close().catch(() => undefined)
  }
})

test('integración simulada · presentación pide consentimiento, sigue el viewport y recibe incorporaciones tardías', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'El flujo multi-sesión se valida una vez en Chromium.')
  test.setTimeout(120_000)
  const harness = new WhiteboardRealtimeHarness()
  const requests = new Set<string>()
  const blocked: string[] = []
  const explicitNavigations = new Set<string>()
  const contexts = await Promise.all([
    browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' }),
    browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' }),
    browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' }),
  ])
  const users = ['Ana QA', 'Luis QA']
  for (let index = 0; index < users.length; index += 1) {
    await harness.install(contexts[index], users[index])
    await installWhiteboardHTTP(contexts[index], harness, users[index], requests, blocked, explicitNavigations)
  }
  await harness.install(contexts[2], 'Marta Invitada')
  const guestShareLinkID = await installGuestWhiteboardHTTP(contexts[2], harness, requests, blocked)
  const [presenter, viewer, lateViewer] = await Promise.all(contexts.map(context => context.newPage()))

  try {
    await Promise.all([openEditor(presenter), openEditor(viewer)])
	await expect.poll(() => harness.socketCount(), { timeout: 30_000 }).toBe(2)

	await test.step('el avatar propio no sigue su misma sesión y deja de seguir a la remota una sola vez', async () => {
	  const selfAvatar = viewer.locator('.whiteboard-editor-shell .excalidraw .Avatar.is-current-user')
	  const remoteAvatar = viewer.locator('.whiteboard-editor-shell .excalidraw .Avatar:not(.is-current-user)').first()
	  await expect(selfAvatar).toHaveCount(1, { timeout: 30_000 })
	  await expect(selfAvatar).toBeVisible({ timeout: 30_000 })
	  await expect(remoteAvatar).toBeVisible({ timeout: 30_000 })

	  await selfAvatar.dispatchEvent('click')
	  await expect(viewer.getByText('No se pudo aplicar el cambio en tiempo real')).toHaveCount(0)
	  expect(harness.followChanges.filter(change => change.sender === 'Luis QA')).toEqual([])

	  await remoteAvatar.dispatchEvent('click')
	  await expect.poll(() => harness.followChanges.filter(change => change.sender === 'Luis QA')).toEqual([
		{ sender: 'Luis QA', target: actorIDFor('Ana QA'), action: 'FOLLOW' },
	  ])
	  await selfAvatar.dispatchEvent('click')
	  await expect.poll(() => harness.followChanges.filter(change => change.sender === 'Luis QA')).toEqual([
		{ sender: 'Luis QA', target: actorIDFor('Ana QA'), action: 'FOLLOW' },
		{ sender: 'Luis QA', target: actorIDFor('Ana QA'), action: 'UNFOLLOW' },
	  ])
	  await expect(viewer.getByText('No se pudo aplicar el cambio en tiempo real')).toHaveCount(0)
	  await expectEditorSaved(viewer)
	})

    await presenter.getByRole('button', { name: 'Invitar a seguirme' }).click()
    await expect(viewer.getByText('Ana QA te invita a seguir su presentación')).toBeVisible()
    await expect(viewer.getByRole('button', { name: 'Ana QA está presentando' })).toBeDisabled()

    await viewer.getByRole('button', { name: 'Ahora no' }).click()
    await expect(viewer.getByText('Ana QA te invita a seguir su presentación')).toBeHidden()
    await presenter.getByRole('button', { name: /Finalizar presentación/ }).click()
    await presenter.getByRole('button', { name: 'Invitar a seguirme' }).click()

    await viewer.getByRole('button', { name: 'Seguir' }).click()
    await expect(viewer.getByText(/Siguiendo a/)).toBeVisible()
    await expect.poll(() => harness.viewportDeliveries.filter(item => item.sender === 'Ana QA').length).toBeGreaterThan(0)
    await expectEditorSaved(viewer)

    await openGuestEditor(lateViewer, guestShareLinkID)
    await expect(lateViewer.getByText('Ana QA te invita a seguir su presentación')).toBeVisible()

    await contexts[0].close()
    await expect(viewer.getByText(/Siguiendo a/)).toBeHidden()
    await expect(lateViewer.getByText('Ana QA te invita a seguir su presentación')).toBeHidden()
    expect(blocked).toEqual([])
  } finally {
    await Promise.all(contexts.slice(1).map(context => context.close().catch(() => undefined)))
  }
})

test('integración simulada · Pizarras permanece same-origin y reconcilia ACK perdido, reconexión y revocación', async ({ browser, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'El gate determinista usa dos contextos Chromium; la matriz visual cubre los demás motores.')
  test.setTimeout(240_000)
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
  const firstContext = await browser.newContext({ serviceWorkers: 'block' })
  const secondContext = await browser.newContext({ serviceWorkers: 'block' })
  await harness.install(firstContext, 'Ana QA')
  await harness.install(secondContext, 'Luis QA')
  await installWhiteboardHTTP(firstContext, harness, 'Ana QA', requests, blocked, explicitNavigations)
  await installWhiteboardHTTP(secondContext, harness, 'Luis QA', requests, blocked, explicitNavigations)
  const first = await firstContext.newPage()
  const second = await secondContext.newPage()
  for (const page of [first, second]) {
    page.on('request', request => requests.add(request.url()))
    page.on('requestfailed', request => recordWhiteboardRequestFailure(requestFailures, request))
    page.on('response', response => {
      const path = new URL(response.url()).pathname
      if (path.startsWith('/vendor/whiteboards-editor/0.18.1-clarin.5/fonts/')) {
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
      await Promise.all([openWorkEditor(first), openEditor(second)])
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

    await test.step('sube y guarda una imagen local desde la pizarra contextual de Work', async () => {
      const uploadsBefore = harness.assetUploads
      await insertLocalImageAsset(first)
      await expect.poll(() => harness.assetUploads, { timeout: 30_000 }).toBeGreaterThan(uploadsBefore)
      await expectEditorSaved(first)
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

    await test.step('mantiene Excalidraw montado y reconecta inmediatamente tras una autorización temporalmente indisponible', async () => {
      const ticketsBeforeInterruption = harness.ticketReads.get('Luis QA') || 0
      await second.evaluate(() => {
        ;(window as typeof window & { __whiteboardEditorNode?: Element | null }).__whiteboardEditorNode = document.querySelector('.whiteboard-editor-shell .excalidraw')
      })
      harness.failTicketsFor('Luis QA')
      harness.interruptAuthorization('Luis QA')

      await expect(second.locator('[data-whiteboard-realtime-status]').first()).toBeVisible({ timeout: 10_000 })
      await expect(second.getByRole('heading', { name: 'No se pudo abrir la pizarra' })).toHaveCount(0)
      expect(await second.evaluate(() => {
        const candidate = (window as typeof window & { __whiteboardEditorNode?: Element | null }).__whiteboardEditorNode
        return Boolean(candidate && candidate === document.querySelector('.whiteboard-editor-shell .excalidraw'))
      })).toBe(true)
      await expect.poll(() => harness.ticketReads.get('Luis QA') || 0, { timeout: 10_000 }).toBeGreaterThan(ticketsBeforeInterruption)

      harness.restoreTicketsFor('Luis QA')
      await second.evaluate(() => {
        window.dispatchEvent(new Event('online'))
        document.dispatchEvent(new Event('visibilitychange'))
        window.dispatchEvent(new PageTransitionEvent('pageshow'))
      })
      await expect.poll(() => harness.socketCount(), { timeout: 10_000 }).toBe(2)
      await expect(second.locator('[data-whiteboard-realtime-status]')).toHaveCount(0)
      expect(await second.evaluate(() => {
        const candidate = (window as typeof window & { __whiteboardEditorNode?: Element | null }).__whiteboardEditorNode
        return Boolean(candidate && candidate === document.querySelector('.whiteboard-editor-shell .excalidraw'))
      })).toBe(true)
    })

    await test.step('oculta ayuda y publicación; expone el catálogo público sólo por la ruta validada de Clarin', async () => {
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
      await exerciseResponsiveEditor(first, true)
      visibleBrandingSurfaces.push(await captureVisibleBrandingSurface(first, 'editor-autenticado'))
    })

    await test.step('guarda antes de abandonar la pizarra por navegación SPA', async () => {
      const writesBeforeNavigation = harness.httpSceneWrites.length
      first.once('dialog', async dialog => {
        unexpectedDialogs.push(dialog.message())
        await dialog.accept()
      })
      await drawRectangle(first, 144)
      const directReturn = first.getByRole('button', { name: 'Volver a las tareas' })
      if (await directReturn.isVisible().catch(() => false)) {
        await directReturn.click()
      } else {
        await first.getByLabel('Más acciones de Pizarras').click()
        await first.getByRole('menuitem', { name: 'Volver a las tareas' }).click()
      }
      await expect.poll(() => harness.httpSceneWrites.length, { timeout: 20_000 }).toBeGreaterThan(writesBeforeNavigation)
      await expect(first).toHaveURL(`${baseURL}/dashboard/tasks`, { timeout: 30_000 })
      expect(unexpectedDialogs).toEqual([])
      await first.goto(`${baseURL}/dashboard/whiteboards`, { waitUntil: 'domcontentloaded' })
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
