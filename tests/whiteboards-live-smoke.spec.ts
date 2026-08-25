import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type Request,
} from '@playwright/test'

const liveSmokeEnabled = process.env.CLARIN_E2E_LIVE_WHITEBOARDS === '1'
const targetAccountName = 'Proyectos Varios'
const productionOrigin = 'https://clarin.naperu.cloud'
const officialLibraryOrigin = 'https://libraries.excalidraw.com'
const callbackStorageKey = 'clarin:whiteboard-public-library-callback:v1'
const callbackTTLMS = 10 * 60 * 1000
const turnstileTimeoutMS = 45_000
const operationTimeoutMS = 90_000

type JSONObject = Record<string, any>

class SmokeFailure extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'SmokeFailure'
    this.code = code
  }
}

interface TurnstileEvidence {
  attempts: number
  checkbox_clicks: number
  tokens_observed: number
  human_interaction_declared: boolean
}

type AuthBootstrap = 'runtime_harness' | 'ui'

interface RuntimeActor {
  user_id: string
  account_id: string
  username: string
  is_admin: boolean
  is_super_admin: boolean
  role: string
  permissions: string[]
}

interface RuntimeSession {
  id: string
  token: string
}

interface SmokeChecks {
  admin_session: boolean
  account_exact_match: boolean
  independent_qa_sessions: boolean
  access_hidden_404: boolean
  access_view: boolean
  access_comment: boolean
  access_edit: boolean
  comments_ui_hidden: boolean
  comments_api_preserved: boolean
  comments_conflict_409: boolean
  comments_counts_and_filters: boolean
  comments_markers_body_free: boolean
  comments_no_browser_fetch: boolean
  first_catalog_import: boolean
  first_catalog_reload_persisted: boolean
  library_ack_exact_and_idempotent: boolean
  expired_callback_401: boolean
  expired_callback_storage_ttl: boolean
  expired_callback_allowlisted_next: boolean
  expired_callback_resumed: boolean
  second_catalog_reload_persisted: boolean
}

interface CleanupState {
  personal_library_archived: boolean | null
  board_archived: boolean
  qa_user_deleted: boolean
  qa_user_deactivated: boolean
  qa_role_deleted: boolean
  runtime_sessions_removed: boolean | null
}

interface BoardTracking {
  id: string | null
  name: string
  archived_at: string | null
  retention_days: number | null
  eligible_at: string | null
}

interface APIResult {
  status: number
  data: JSONObject
}

interface AdminEntityLookup {
  confirmed: boolean
  item: JSONObject | null
}

interface LiveState {
  adminContext: BrowserContext | null
  adminPage: Page | null
  qaContextA: BrowserContext | null
  qaContextB: BrowserContext | null
  qaPageA: Page | null
  qaPageB: Page | null
  accountID: string | null
  roleID: string | null
  userID: string | null
  boardID: string | null
  personalLibraryID: string | null
  runtimeSessionIDs: string[]
  qaSessionAID: string | null
  qaSessionBID: string | null
}

interface CatalogImportEvidence {
  importID: string
  acknowledgedVersion: number
}

function ensure(condition: unknown, code: string): asserts condition {
  if (!condition) throw new SmokeFailure(code)
}

function authBootstrapMode(): AuthBootstrap {
  const configured = process.env.CLARIN_QA_AUTH_BOOTSTRAP?.trim()
  if (!configured || configured === 'runtime_harness') return 'runtime_harness'
  if (configured === 'ui') return 'ui'
  throw new SmokeFailure('invalid_auth_bootstrap')
}

function runtimeCommand(args: string[], input?: string) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    input,
    maxBuffer: 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  ensure(result.status === 0, 'runtime_harness_command_failed')
  return result.stdout.trim()
}

function runtimeJWTSecret() {
  const secret = runtimeCommand([
    'exec',
    'clarin-backend',
    'sh',
    '-c',
    'test -n "$JWT_SECRET" && printf %s "$JWT_SECRET"',
  ])
  ensure(secret.length >= 32, 'runtime_harness_jwt_secret_unavailable')
  return secret
}

function runtimeQueryJSON(query: string) {
  const output = runtimeCommand([
    'exec',
    'clarin-postgres',
    'psql',
    '-U',
    'clarin',
    '-d',
    'clarin',
    '-At',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    query,
  ])
  ensure(Boolean(output), 'runtime_harness_actor_not_found')
  try {
    return JSON.parse(output) as RuntimeActor
  } catch {
    throw new SmokeFailure('runtime_harness_actor_invalid')
  }
}

function validUUID(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function validateRuntimeActor(actor: RuntimeActor, expectedAccountID?: string) {
  ensure(validUUID(actor.user_id) && validUUID(actor.account_id), 'runtime_harness_actor_ids_invalid')
  ensure(Boolean(actor.username && actor.role), 'runtime_harness_actor_identity_invalid')
  ensure(Array.isArray(actor.permissions), 'runtime_harness_actor_permissions_invalid')
  if (expectedAccountID) ensure(actor.account_id === expectedAccountID, 'runtime_harness_actor_account_mismatch')
  return actor
}

function runtimeAdminActor() {
  const actor = runtimeQueryJSON(`
    SELECT json_build_object(
      'user_id',account_user.id::text,
      'account_id',account.id::text,
      'username',account_user.username,
      'is_admin',COALESCE(account_user.is_admin,FALSE) OR membership.role IN ('admin','super_admin'),
      'is_super_admin',COALESCE(account_user.is_super_admin,FALSE),
      'role',membership.role,
      'permissions',json_build_array('*')
    )::text
    FROM user_accounts membership
    JOIN users account_user ON account_user.id=membership.user_id AND account_user.is_active
    JOIN accounts account ON account.id=membership.account_id AND account.is_active
    WHERE account.name='Proyectos Varios' AND account_user.is_super_admin
    ORDER BY membership.created_at,account_user.id
    LIMIT 1
  `)
  validateRuntimeActor(actor)
  ensure(actor.is_super_admin, 'runtime_harness_admin_not_super_admin')
  return actor
}

function runtimeQAActor(userID: string, accountID: string) {
  ensure(validUUID(userID) && validUUID(accountID), 'runtime_harness_qa_ids_invalid')
  const actor = runtimeQueryJSON(`
    SELECT json_build_object(
      'user_id',account_user.id::text,
      'account_id',membership.account_id::text,
      'username',account_user.username,
      'is_admin',COALESCE(account_user.is_admin,FALSE) OR membership.role IN ('admin','super_admin'),
      'is_super_admin',COALESCE(account_user.is_super_admin,FALSE),
      'role',membership.role,
      'permissions',to_json(COALESCE(role_item.permissions,ARRAY[]::TEXT[]))
    )::text
    FROM user_accounts membership
    JOIN users account_user ON account_user.id=membership.user_id AND account_user.is_active
    LEFT JOIN roles role_item ON role_item.id=membership.role_id
    WHERE account_user.id='${userID}'::uuid AND membership.account_id='${accountID}'::uuid
    LIMIT 1
  `)
  validateRuntimeActor(actor, accountID)
  ensure(actor.permissions.includes('whiteboards'), 'runtime_harness_qa_permission_missing')
  return actor
}

function base64URLJSON(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function signRuntimeJWT(actor: RuntimeActor, sessionID: string, jwtSecret: string) {
  const now = Math.floor(Date.now() / 1000)
  const header = base64URLJSON({ alg: 'HS256', typ: 'JWT' })
  const payload = base64URLJSON({
    user_id: actor.user_id,
    account_id: actor.account_id,
    session_id: sessionID,
    username: actor.username,
    is_admin: actor.is_admin,
    is_super_admin: actor.is_super_admin,
    role: actor.role,
    permissions: actor.permissions,
    jti: randomUUID(),
    iss: 'clarin',
    iat: now,
    exp: now + 60 * 60,
  })
  const input = `${header}.${payload}`
  const signature = createHmac('sha256', jwtSecret).update(input).digest('base64url')
  return `${input}.${signature}`
}

function createRuntimeSession(actor: RuntimeActor, jwtSecret: string): RuntimeSession {
  const sessionID = randomUUID()
  const now = Math.floor(Date.now() / 1000)
  const session = JSON.stringify({
    user_id: actor.user_id,
    account_id: actor.account_id,
    username: actor.username,
    created_at: now,
    last_seen: now,
  })
  const result = runtimeCommand([
    'exec',
    '-i',
    'clarin-redis',
    'redis-cli',
    '-x',
    'SETEX',
    `session:${sessionID}`,
    '1800',
  ], session)
  ensure(result === 'OK', 'runtime_harness_session_not_registered')
  return { id: sessionID, token: signRuntimeJWT(actor, sessionID, jwtSecret) }
}

function removeRuntimeSession(sessionID: string) {
  ensure(validUUID(sessionID), 'runtime_harness_session_id_invalid')
  runtimeCommand(['exec', 'clarin-redis', 'redis-cli', 'DEL', `session:${sessionID}`])
}

async function installRuntimeSession(
  context: BrowserContext,
  baseURL: string,
  session: RuntimeSession,
) {
  await context.addInitScript(({ origin }) => {
    if (window.location.origin !== origin) return
    const now = String(Date.now())
    // DashboardLayout deliberately requires this non-secret marker in
    // addition to the httpOnly access cookie. A runtime QA session must model
    // the same browser state established by a successful interactive login.
    window.localStorage.setItem('token', 'cookie-session')
    window.localStorage.setItem('clarin:auth_refreshed_at', now)
    window.localStorage.setItem('clarin:last_activity_at', now)
  }, { origin: baseURL })
  await context.addCookies([{
    name: 'auth-token',
    value: session.token,
    url: baseURL,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    expires: Math.floor(Date.now() / 1000) + 60 * 60,
  }])
}

async function installWhiteboardSocketControl(context: BrowserContext) {
  await context.addInitScript(() => {
    const NativeWebSocket = window.WebSocket
    const whiteboardSockets = new Set<WebSocket>()
    const TrackedWebSocket = new Proxy(NativeWebSocket, {
      construct(target, args) {
        const socket = Reflect.construct(target, args, target) as WebSocket
        if (socket.url.includes('/ws/whiteboards/')) {
          whiteboardSockets.add(socket)
          socket.addEventListener('close', () => whiteboardSockets.delete(socket), { once: true })
        }
        return socket
      },
    })
    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      writable: true,
      value: TrackedWebSocket,
    })
    Object.defineProperty(window, '__clarinQaCloseWhiteboardSocket', {
      configurable: true,
      value: (boardID: string) => {
        const expectedPath = `/ws/whiteboards/${encodeURIComponent(boardID)}`
        for (const socket of whiteboardSockets) {
          if (socket.url.includes(expectedPath) && socket.readyState < NativeWebSocket.CLOSING) {
            socket.close(4000, 'clarin_qa_reconnect')
            return true
          }
        }
        return false
      },
    })
  })
}

async function closeWhiteboardSocket(page: Page, boardID: string) {
  return page.evaluate(id => {
    const controlledWindow = window as typeof window & {
      __clarinQaCloseWhiteboardSocket?: (candidateID: string) => boolean
    }
    return controlledWindow.__clarinQaCloseWhiteboardSocket?.(id) === true
  }, boardID)
}

function normalizedBaseURL() {
  const raw = (process.env.CLARIN_QA_BASE_URL || productionOrigin).trim()
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new SmokeFailure('invalid_base_url')
  }
  ensure(parsed.protocol === 'https:' && !parsed.username && !parsed.password, 'unsafe_base_url')
  ensure(parsed.pathname === '/' && !parsed.search && !parsed.hash, 'base_url_must_be_origin')
  if (process.env.CLARIN_QA_ALLOW_NON_PRODUCTION !== '1') {
    ensure(parsed.origin === productionOrigin, 'non_production_origin_not_allowed')
  }
  return parsed.origin
}

function generatedPassword() {
  return `Qa!${randomBytes(18).toString('base64url')}7z`
}

function generatedSuffix() {
  return randomBytes(4).toString('hex')
}

function emptyScene() {
  return {
    type: 'excalidraw',
    version: 2,
    source: 'clarin',
    elements: [],
    appState: {},
    files: {},
  }
}

function safeURL(baseURL: string, path: string) {
  const parsed = new URL(path, baseURL)
  ensure(parsed.origin === baseURL, 'api_origin_mismatch')
  return parsed.toString()
}

async function callAPI(
  request: APIRequestContext,
  baseURL: string,
  path: string,
  options: { method?: string; data?: unknown } = {},
): Promise<APIResult> {
  const response = await request.fetch(safeURL(baseURL, path), {
    method: options.method || 'GET',
    data: options.data,
    failOnStatusCode: false,
  })
  const data = await response.json().catch(() => ({})) as JSONObject
  return { status: response.status(), data }
}

async function successfulAPI(
  request: APIRequestContext,
  baseURL: string,
  label: string,
  path: string,
  options: { method?: string; data?: unknown } = {},
  acceptedStatuses: readonly number[] = [200],
) {
  const result = await callAPI(request, baseURL, path, options)
  ensure(acceptedStatuses.includes(result.status), `${label}_${result.status}`)
  ensure(result.data?.success !== false, `${label}_rejected`)
  return result.data
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  code: string,
  timeout = operationTimeoutMS,
  interval = 250,
) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return
    } catch {
      // Transient browser/network reads are retried until the bounded deadline.
    }
    await new Promise(resolve => setTimeout(resolve, interval))
  }
  throw new SmokeFailure(code)
}

async function visible(locator: Locator, code: string, timeout = 30_000) {
  try {
    await locator.waitFor({ state: 'visible', timeout })
  } catch {
    throw new SmokeFailure(code)
  }
  return locator
}

async function click(locator: Locator, code: string) {
  try {
    await visible(locator, `${code}_not_visible`)
    await locator.click({ timeout: 20_000 })
  } catch (error) {
    if (error instanceof SmokeFailure) throw error
    throw new SmokeFailure(`${code}_click_failed`)
  }
}

async function fill(locator: Locator, value: string, code: string) {
  try {
    await visible(locator, `${code}_not_visible`)
    await locator.fill(value, { timeout: 20_000 })
  } catch (error) {
    if (error instanceof SmokeFailure) throw error
    throw new SmokeFailure(`${code}_fill_failed`)
  }
}

async function turnstileRequired(page: Page, baseURL: string) {
  const response = await page.request.get(safeURL(baseURL, '/api/public/security-config'), {
    failOnStatusCode: false,
  })
  ensure(response.status() === 200, 'security_config_unavailable')
  const payload = await response.json().catch(() => ({})) as JSONObject
  return Boolean(payload.login_turnstile_required)
}

async function tryLegitimateTurnstileCheckbox(page: Page, evidence: TurnstileEvidence) {
  const iframe = page.locator('iframe[src*="challenges.cloudflare.com"]').first()
  await iframe.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => undefined)
  for (const frame of page.frames().filter(item => item.url().includes('challenges.cloudflare.com'))) {
    const candidates = [
      frame.getByRole('checkbox', { name: /verify you are human|verifica que eres humano/i }).first(),
      frame.locator('input[type="checkbox"]').first(),
    ]
    for (const candidate of candidates) {
      if (!await candidate.isVisible().catch(() => false)) continue
      await candidate.click().catch(() => undefined)
      evidence.checkbox_clicks += 1
      return
    }
  }
}

async function waitForTurnstileToken(page: Page, evidence: TurnstileEvidence) {
  evidence.attempts += 1
  await tryLegitimateTurnstileCheckbox(page, evidence)
  await waitUntil(async () => {
    const field = page.locator('[name="cf-turnstile-response"]').first()
    const value = await field.inputValue().catch(() => '')
    return value.length > 20
  }, 'turnstile_token_not_observed', turnstileTimeoutMS)
  evidence.tokens_observed += 1
}

async function loginThroughUI(input: {
  page: Page
  baseURL: string
  username: string
  password: string
  evidence: TurnstileEvidence
  navigate?: boolean
  destination?: (url: URL) => boolean
}) {
  const { page, baseURL, username, password, evidence } = input
  if (input.navigate !== false) {
    try {
      await page.goto(`${baseURL}/login`, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    } catch {
      throw new SmokeFailure('login_page_unavailable')
    }
  }
  ensure(new URL(page.url()).origin === baseURL, 'login_origin_mismatch')
  await fill(page.getByPlaceholder('usuario o correo'), username, 'login_username')
  await fill(page.getByPlaceholder('tu contraseña'), password, 'login_password')
  if (await turnstileRequired(page, baseURL)) {
    await waitForTurnstileToken(page, evidence)
  }
  await click(page.getByRole('button', { name: /Iniciar sesión/i }), 'login_submit')
  const destination = input.destination || (url => url.origin === baseURL && url.pathname.startsWith('/dashboard'))
  await waitUntil(() => destination(new URL(page.url())), 'login_destination_not_reached', turnstileTimeoutMS)
}

async function ensureAdminContext(browser: Browser, baseURL: string, evidence: TurnstileEvidence) {
  const storageState = process.env.CLARIN_QA_ADMIN_STORAGE_STATE?.trim()
  const username = process.env.CLARIN_QA_ADMIN_USERNAME?.trim()
  const password = process.env.CLARIN_QA_ADMIN_PASSWORD || ''
  let context: BrowserContext
  if (storageState) {
    ensure(existsSync(storageState), 'admin_storage_state_missing')
    try {
      context = await browser.newContext({ storageState })
    } catch {
      throw new SmokeFailure('admin_storage_state_invalid')
    }
  } else {
    ensure(Boolean(username && password), 'admin_auth_input_missing')
    context = await browser.newContext()
  }
  const page = await context.newPage()
  let me = await callAPI(context.request, baseURL, '/api/me')
  if (me.status === 401) {
    const refreshed = await callAPI(context.request, baseURL, '/api/auth/refresh', { method: 'POST' })
    if (refreshed.status === 200) me = await callAPI(context.request, baseURL, '/api/me')
  }
  if (me.status !== 200 && username && password) {
    await loginThroughUI({ page, baseURL, username, password, evidence })
    me = await callAPI(context.request, baseURL, '/api/me')
  }
  ensure(me.status === 200 && me.data?.user, 'admin_session_unavailable')
  ensure(Boolean(me.data.user.is_super_admin), 'admin_must_be_super_admin')
  return { context, page, me: me.data.user as JSONObject }
}

async function switchAdminToTargetAccount(
  context: BrowserContext,
  baseURL: string,
  currentUser: JSONObject,
) {
  const accountsPayload = await successfulAPI(
    context.request,
    baseURL,
    'admin_accounts',
    '/api/admin/accounts',
  )
  const exact = (Array.isArray(accountsPayload.accounts) ? accountsPayload.accounts : [])
    .filter((account: JSONObject) => account?.name === targetAccountName && account?.is_active !== false)
  ensure(exact.length === 1 && typeof exact[0].id === 'string', 'target_account_not_unique')
  const accountID = exact[0].id as string
  if (currentUser.account_id !== accountID) {
    const memberships = await successfulAPI(
      context.request,
      baseURL,
      'admin_memberships',
      '/api/me/accounts',
    )
    const available = (Array.isArray(memberships.accounts) ? memberships.accounts : [])
      .some((account: JSONObject) => account?.id === accountID || account?.account_id === accountID)
    ensure(available, 'admin_not_member_of_target_account')
    await successfulAPI(
      context.request,
      baseURL,
      'admin_switch_account',
      '/api/auth/switch-account',
      { method: 'POST', data: { account_id: accountID } },
    )
  }
  const me = await successfulAPI(context.request, baseURL, 'admin_me_after_switch', '/api/me')
  ensure(me.user?.account_id === accountID && me.user?.account_name === targetAccountName, 'target_account_switch_mismatch')
  return accountID
}

async function setBoardGrant(
  adminRequest: APIRequestContext,
  baseURL: string,
  boardID: string,
  userID: string,
  accessLevel: 'view' | 'comment' | 'edit',
) {
  const current = await successfulAPI(
    adminRequest,
    baseURL,
    'board_access_read',
    `/api/whiteboards/${boardID}/grants`,
  )
  ensure(Number.isSafeInteger(current.access?.access_revision), 'board_access_revision_missing')
  return successfulAPI(
    adminRequest,
    baseURL,
    `board_access_${accessLevel}`,
    `/api/whiteboards/${boardID}/grants`,
    {
      method: 'PUT',
      data: {
        access_mode: 'private',
        grants: [{ user_id: userID, access_level: accessLevel }],
        expected_access_revision: current.access.access_revision,
        operation_id: randomUUID(),
      },
    },
  )
}

async function sceneWriteResult(
  request: APIRequestContext,
  baseURL: string,
  boardID: string,
) {
  const loaded = await callAPI(request, baseURL, `/api/whiteboards/${boardID}/scene`)
  ensure(loaded.status === 200 && loaded.data?.scene, 'scene_read_failed')
  const record = loaded.data.scene
  return callAPI(request, baseURL, `/api/whiteboards/${boardID}/scene`, {
    method: 'PUT',
    data: {
      expected_sequence: record.sequence,
      operation_id: randomUUID(),
      scene: record.scene,
      scene_schema_version: 'excalidraw',
      editor_version: '0.18.1-clarin.5',
    },
  })
}

function visibleLibraryToggle(page: Page) {
  return page.locator([
    'button[data-whiteboard-action="library"]',
    'button[data-whiteboard-sidebar-internal="library"]',
  ].join(',')).filter({ visible: true })
}

function visibleHostSidebarAction(page: Page, tab: 'library' | 'comments') {
  return page.locator(`button[data-whiteboard-sidebar-action="${tab}"]`).filter({ visible: true })
}

function visibleInternalSidebarAction(page: Page, tab: 'library' | 'comments') {
  return page.locator(`button[data-whiteboard-sidebar-internal="${tab}"]`).filter({ visible: true })
}

async function assertClosedSidebarOwnership(page: Page) {
  await waitUntil(async () => {
    return await page.locator('button[data-whiteboard-action="library"]').filter({ visible: true }).count() === 1
      && await visibleHostSidebarAction(page, 'comments').count() === 0
      && await visibleInternalSidebarAction(page, 'library').count() === 0
      && await visibleInternalSidebarAction(page, 'comments').count() === 0
  }, 'closed_sidebar_owner_invalid', 10_000)
}

async function assertOpenSidebarOwnership(page: Page) {
  await waitUntil(async () => {
    const library = visibleInternalSidebarAction(page, 'library')
    const comments = visibleInternalSidebarAction(page, 'comments')
    const active = page.locator('.sidebar-triggers .sidebar-tab-trigger[data-state="active"]').filter({ visible: true })
    return await page.locator('button[data-whiteboard-action="library"]').filter({ visible: true }).count() === 0
      && await visibleHostSidebarAction(page, 'comments').count() === 0
      && await library.count() === 1
      && await comments.count() === 0
      && await active.count() === 1
      && await library.getAttribute('data-state') === 'active'
  }, 'open_sidebar_library_owner_invalid', 10_000)
}

async function assertCommentsUIHidden(page: Page) {
  ensure(await page.locator('[aria-label^="Comentarios"]').filter({ visible: true }).count() === 0, 'comments_control_visible')
  ensure(await page.getByLabel('Comentarios de la pizarra').count() === 0, 'comments_panel_mounted')
  ensure(await page.getByLabel('Pines de comentarios').count() === 0, 'comments_pins_mounted')
}

function actionHitTarget(action: Locator) {
  return action
}

async function openEditor(page: Page, baseURL: string, boardID: string) {
  try {
    await page.goto(`${baseURL}/dashboard/whiteboards/${boardID}`, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    })
  } catch {
    throw new SmokeFailure('editor_navigation_failed')
  }
  await visible(page.locator('.whiteboard-editor-shell'), 'editor_shell_not_visible', 45_000)
  await visible(page.getByLabel('Guardado en Clarin'), 'editor_not_ready', 45_000)
  try {
    await assertClosedSidebarOwnership(page)
  } catch {
    throw new SmokeFailure('editor_action_probe_failed')
  }
}

async function closeActiveSidebar(page: Page) {
  const close = page.locator('.sidebar__close').filter({ visible: true }).first()
  await close.click({ timeout: 3_000 }).catch(() => undefined)
  await assertClosedSidebarOwnership(page)
}

function assertCounts(payload: JSONObject, expected: { open: number; resolved: number; all: number }, code: string) {
  ensure(payload?.counts?.open === expected.open, `${code}_open`)
  ensure(payload?.counts?.resolved === expected.resolved, `${code}_resolved`)
  ensure(payload?.counts?.all === expected.all, `${code}_all`)
}

async function createCommentThroughAPI(
  request: APIRequestContext,
  baseURL: string,
  boardID: string,
  body: string,
  x: number,
  y: number,
) {
  const payload = await successfulAPI(
    request,
    baseURL,
    'comment_create_api',
    `/api/whiteboards/${boardID}/comment-threads`,
    {
      method: 'POST',
      data: {
        operation_id: randomUUID(),
        element_id: null,
        anchor_x: x,
        anchor_y: y,
        anchor_ratio_x: null,
        anchor_ratio_y: null,
        body,
      },
    },
    [201],
  )
  ensure(payload.thread?.id, 'comment_create_api_missing_thread')
  return payload.thread as JSONObject
}

async function personalLibrary(
  request: APIRequestContext,
  baseURL: string,
  userID: string,
) {
  const summaries = await successfulAPI(
    request,
    baseURL,
    'personal_library_list',
    `/api/whiteboard-libraries?q=${encodeURIComponent(`Mi biblioteca · ${userID}`)}&limit=50`,
  )
  const summary = (Array.isArray(summaries.libraries) ? summaries.libraries : [])
    .find((item: JSONObject) => item.visibility === 'private' && item.created_by === userID && !item.archived_at)
  ensure(summary?.id, 'personal_library_not_found')
  const detail = await successfulAPI(
    request,
    baseURL,
    'personal_library_detail',
    `/api/whiteboard-libraries/${summary.id}`,
  )
  ensure(detail.library?.id === summary.id && Number.isSafeInteger(detail.library?.version), 'personal_library_detail_invalid')
  return detail.library as JSONObject
}

function libraryItemCount(library: JSONObject) {
  if (Number.isSafeInteger(library.item_count)) return library.item_count as number
  let value = library.library_json
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return -1
    }
  }
  return Array.isArray(value?.libraryItems) ? value.libraryItems.length : -1
}

async function selectOfficialLibrary(page: Page, title: string) {
  await waitUntil(() => new URL(page.url()).origin === officialLibraryOrigin, 'official_catalog_not_reached', 45_000)
  const search = page.locator('#search-input')
  await fill(search, title, 'official_catalog_search')
  const card = page.locator('.library').filter({ hasText: title }).first()
  await visible(card, 'official_library_card_not_found', 45_000)
  const install = card.locator('.install-library').first()
  await click(install, 'official_add_to_excalidraw')
}

async function openOfficialCatalog(page: Page, baseURL: string) {
  await page.bringToFront()
  await closeActiveSidebar(page)
  const toggle = visibleLibraryToggle(page)
  await visible(toggle, 'library_toggle_missing', 20_000)
  await click(actionHitTarget(toggle), 'library_toggle')
  await assertOpenSidebarOwnership(page)
  const browse = page.locator('.library-menu-browse-button')
  await visible(browse, 'library_browse_missing')
  const accessibleName = await browse.getAttribute('aria-label') || ''
  ensure(accessibleName.includes('sitio oficial'), 'library_disclosure_official_missing')
  ensure(accessibleName.includes('analítica externa'), 'library_disclosure_analytics_missing')
  ensure(accessibleName.includes('Clarin validará'), 'library_disclosure_validation_missing')
  const link = await browse.evaluate(element => ({
    tag: element.tagName,
    href: element instanceof HTMLAnchorElement ? element.href : '',
    target: element instanceof HTMLAnchorElement ? element.target : '',
  }))
  ensure(link.tag === 'A' && link.target === '_self', 'library_browse_not_same_page_link')
  let startRequest: { method: string; requestOrigin: string | null; guard: string | null; site: string | null; mode: string | null; destination: string | null } | null = null
  let navigationRequest: { method: string; path: string; search: string; site: string | null; mode: string | null; destination: string | null } | null = null
  const observeStart = (request: Request) => {
    const record = (headers: Record<string, string>) => {
      const url = new URL(request.url())
      if (url.pathname.endsWith('/public-library-import/start')) {
        startRequest = {
          method: request.method(),
          requestOrigin: headers.origin || null,
          guard: headers['x-clarin-whiteboard-library-start'] || null,
          site: headers['sec-fetch-site'] || null,
          mode: headers['sec-fetch-mode'] || null,
          destination: headers['sec-fetch-dest'] || null,
        }
        return
      }
      if (/\/public-library-imports\/[0-9a-f-]+\/navigate$/i.test(url.pathname)) {
        navigationRequest = {
          method: request.method(),
          path: url.pathname,
          search: url.search,
          site: headers['sec-fetch-site'] || null,
          mode: headers['sec-fetch-mode'] || null,
          destination: headers['sec-fetch-dest'] || null,
        }
      }
    }
    try {
      record(request.headers())
    } catch {
      // The enriched read below still has an opportunity to record the request.
    }
    void request.allHeaders().then(record).catch(() => {
      // The bounded navigation assertion below remains authoritative.
    })
  }
  page.on('request', observeStart)
  try {
    await click(browse, 'library_browse')
    try {
      await waitUntil(() => new URL(page.url()).origin === officialLibraryOrigin, 'official_catalog_not_reached', 45_000)
      await waitUntil(() => startRequest !== null && navigationRequest !== null, 'library_navigation_observation_missing', 5_000)
      ensure(startRequest?.method === 'POST', 'library_start_not_post_request')
      ensure(startRequest?.requestOrigin === baseURL, 'library_start_origin_missing')
      ensure(startRequest?.guard === '1', 'library_start_guard_missing')
      ensure(navigationRequest?.method === 'GET', 'library_navigation_missing')
      ensure(navigationRequest?.search === '', 'library_navigation_exposed_secret')
    } catch (navigationError) {
      const response = await page.evaluate(() => ({
        url: window.location.href,
        body: document.body?.textContent?.trim().slice(0, 300) || '',
      })).catch(() => ({ url: page.url(), body: '' }))
      process.stderr.write(`${JSON.stringify({
        kind: 'clarin_whiteboards_library_navigation_probe',
        link_origin: new URL(link.href).origin,
        request: startRequest,
        navigation: navigationRequest,
        response_origin: new URL(response.url).origin,
        response_body: response.body,
        blocker_code: navigationError instanceof SmokeFailure ? navigationError.code : 'library_navigation_probe_failed',
      })}\n`)
      throw navigationError
    }
  } finally {
    page.off('request', observeStart)
  }
}

async function runCatalogImport(input: {
  page: Page
  baseURL: string
  boardID: string
  libraryID: string
  title: string
}) {
  const { page, baseURL, boardID, libraryID, title } = input
  const mutationOrder: string[] = []
  let importID = ''
  let acknowledgedVersion = 0
  let observerFailureCode: string | null = null
  let libraryPutSeen = false
  let libraryPutSucceeded = false
  let completeSucceeded = false
  const observeRequest = (request: { method(): string; url(): string; postDataJSON(): unknown }) => {
    try {
      const url = new URL(request.url())
      if (url.origin !== baseURL) return
      if (request.method() === 'PUT' && url.pathname === `/api/whiteboard-libraries/${libraryID}`) {
        libraryPutSeen = true
        mutationOrder.push('library_put')
        return
      }
      const match = url.pathname.match(new RegExp(`^/api/whiteboards/${boardID}/public-library-imports/([0-9a-f-]+)/complete$`, 'i'))
      if (!match || request.method() !== 'POST') return
      importID = match[1]
      const body = request.postDataJSON() as JSONObject
      if (body?.operation_id !== importID) observerFailureCode = 'library_ack_operation_mismatch'
      if (!Number.isSafeInteger(body?.library_version) || body.library_version <= 0) {
        observerFailureCode ||= 'library_ack_version_missing'
      } else {
        acknowledgedVersion = body.library_version
      }
      mutationOrder.push('complete')
    } catch {
      observerFailureCode ||= 'library_import_request_observer_failed'
    }
  }
  const observeResponse = (response: { url(): string; status(): number; request(): { method(): string } }) => {
    try {
      const url = new URL(response.url())
      if (url.origin !== baseURL) return
      if (response.request().method() === 'PUT' && url.pathname === `/api/whiteboard-libraries/${libraryID}`) {
        libraryPutSucceeded = response.status() >= 200 && response.status() < 300
        return
      }
      const complete = new RegExp(`^/api/whiteboards/${boardID}/public-library-imports/[0-9a-f-]+/complete$`, 'i').test(url.pathname)
      if (complete && response.request().method() === 'POST') {
        completeSucceeded = response.status() >= 200 && response.status() < 300
      }
    } catch {
      observerFailureCode ||= 'library_import_response_observer_failed'
    }
  }
  page.on('request', observeRequest)
  page.on('response', observeResponse)
  try {
    await openOfficialCatalog(page, baseURL)
    await selectOfficialLibrary(page, title)
    await waitUntil(() => importID.length > 0, 'library_ack_not_sent', operationTimeoutMS)
    await waitUntil(() => {
      const url = new URL(page.url())
      return url.origin === baseURL
        && url.pathname === `/dashboard/whiteboards/${boardID}`
        && !url.searchParams.has('library_import')
        && !url.hash
    }, 'library_import_return_not_clean', operationTimeoutMS)
    await waitUntil(
      () => libraryPutSucceeded && completeSucceeded,
      'library_import_mutation_response_missing',
      30_000,
    )
    ensure(observerFailureCode === null, observerFailureCode || 'library_import_observer_failed')
    ensure(libraryPutSeen, 'library_put_not_observed')
    ensure(mutationOrder.at(-1) === 'complete', 'library_ack_not_last')
    ensure(mutationOrder.lastIndexOf('library_put') < mutationOrder.lastIndexOf('complete'), 'library_ack_before_persist')
    const importState = await successfulAPI(
      page.context().request,
      baseURL,
      'library_import_completed_readback',
      `/api/whiteboards/${boardID}/public-library-imports/${importID}`,
    )
    ensure(importState.import?.status === 'completed', 'library_import_not_completed')
    ensure(importState.import?.completed_library_version === acknowledgedVersion, 'library_import_completed_version_mismatch')
    await visible(page.locator('.whiteboard-editor-shell'), 'editor_missing_after_import', 45_000)
    return { importID, acknowledgedVersion } satisfies CatalogImportEvidence
  } finally {
    page.off('request', observeRequest)
    page.off('response', observeResponse)
  }
}

async function runExpiredCatalogImport(input: {
  page: Page
  context: BrowserContext
  baseURL: string
  boardID: string
  title: string
  username: string
  password: string
  evidence: TurnstileEvidence
  authBootstrap: AuthBootstrap
  expireRuntimeSession?: () => void
  restoreRuntimeSession?: () => Promise<void>
}) {
  const { page, context, baseURL, boardID, title, username, password, evidence } = input
  const authResponses: Array<{ path: string; status: number }> = []
  let importID = ''
  let acknowledgedVersion = 0
  let observerFailureCode: string | null = null
  const observeResponse = (response: { url(): string; status(): number }) => {
    try {
      const url = new URL(response.url())
      if (url.origin !== baseURL) return
      if (url.pathname === '/api/whiteboards/public-library-import/callback' || url.pathname === '/api/auth/refresh') {
        authResponses.push({ path: url.pathname, status: response.status() })
      }
    } catch {
      observerFailureCode ||= 'expired_callback_response_observer_failed'
    }
  }
  const observeRequest = (request: { method(): string; url(): string; postDataJSON(): unknown }) => {
    try {
      const url = new URL(request.url())
      const match = url.pathname.match(new RegExp(`^/api/whiteboards/${boardID}/public-library-imports/([0-9a-f-]+)/complete$`, 'i'))
      if (url.origin !== baseURL || !match || request.method() !== 'POST') return
      importID = match[1]
      const body = request.postDataJSON() as JSONObject
      if (body?.operation_id !== importID) observerFailureCode = 'expired_callback_ack_operation_mismatch'
      acknowledgedVersion = Number(body?.library_version || 0)
      if (!Number.isSafeInteger(acknowledgedVersion) || acknowledgedVersion <= 0) {
        observerFailureCode ||= 'expired_callback_ack_version_missing'
      }
    } catch {
      observerFailureCode ||= 'expired_callback_request_observer_failed'
    }
  }
  page.on('response', observeResponse)
  page.on('request', observeRequest)
  try {
    await openOfficialCatalog(page, baseURL)
    input.expireRuntimeSession?.()
    await context.clearCookies()
    await selectOfficialLibrary(page, title)
    await waitUntil(() => {
      const url = new URL(page.url())
      return url.origin === baseURL && url.pathname === '/login'
    }, 'expired_callback_login_not_reached', operationTimeoutMS)
    const loginURL = new URL(page.url())
    ensure(loginURL.searchParams.get('reason') === 'expired', 'expired_callback_reason_missing')
    ensure(loginURL.searchParams.get('next') === '/whiteboards/library-import', 'expired_callback_next_not_allowlisted')
    ensure(authResponses.some(item => item.path === '/api/whiteboards/public-library-import/callback' && item.status === 401), 'expired_callback_401_missing')
    ensure(authResponses.some(item => item.path === '/api/auth/refresh' && item.status === 401), 'expired_refresh_401_missing')
    const stored = await page.evaluate(key => {
      const raw = window.sessionStorage.getItem(key)
      const localPresent = window.localStorage.getItem(key) !== null
      if (!raw) return { present: false, localPresent }
      try {
        const value = JSON.parse(raw) as JSONObject
        return {
          present: true,
          localPresent,
          createdAt: value.createdAt,
          identity: value.identity,
          tokenPresent: typeof value.tokens?.token === 'string' && value.tokens.token.length >= 32,
          libraryURLPresent: typeof value.tokens?.libraryURL === 'string' && value.tokens.libraryURL.length > 0,
          hashCleared: window.location.hash === '',
        }
      } catch {
        return { present: true, malformed: true }
      }
    }, callbackStorageKey)
    ensure(stored.present && !stored.malformed, 'expired_callback_storage_missing')
    ensure(!stored.localPresent, 'expired_callback_leaked_to_local_storage')
    ensure(stored.identity === '/whiteboards/library-import', 'expired_callback_storage_identity')
    ensure(stored.tokenPresent && stored.libraryURLPresent && stored.hashCleared, 'expired_callback_storage_shape')
    ensure(typeof stored.createdAt === 'number' && Date.now() - stored.createdAt >= 0 && Date.now() - stored.createdAt <= callbackTTLMS, 'expired_callback_storage_ttl')
    if (input.authBootstrap === 'runtime_harness') {
      ensure(input.restoreRuntimeSession, 'runtime_session_restore_missing')
      await input.restoreRuntimeSession()
      try {
        await page.goto(`${baseURL}/whiteboards/library-import`, {
          waitUntil: 'domcontentloaded',
          timeout: 45_000,
        })
      } catch {
        throw new SmokeFailure('runtime_callback_resume_navigation_failed')
      }
      await waitUntil(() => {
        const url = new URL(page.url())
        return url.origin === baseURL && url.pathname === `/dashboard/whiteboards/${boardID}`
      }, 'runtime_callback_resume_destination_not_reached', operationTimeoutMS)
    } else {
      await loginThroughUI({
        page,
        baseURL,
        username,
        password,
        evidence,
        navigate: false,
        destination: url => url.origin === baseURL && url.pathname === `/dashboard/whiteboards/${boardID}`,
      })
    }
    await waitUntil(() => importID.length > 0 && acknowledgedVersion > 0, 'expired_callback_ack_not_sent', operationTimeoutMS)
    ensure(observerFailureCode === null, observerFailureCode || 'expired_callback_observer_failed')
    await waitUntil(async () => {
      const url = new URL(page.url())
      if (url.searchParams.has('library_import') || url.hash) return false
      return await page.evaluate(key => (
        window.sessionStorage.getItem(key) === null
        && window.localStorage.getItem(key) === null
      ), callbackStorageKey)
    }, 'expired_callback_not_cleared', operationTimeoutMS)
    const importState = await successfulAPI(
      context.request,
      baseURL,
      'expired_library_import_completed_readback',
      `/api/whiteboards/${boardID}/public-library-imports/${importID}`,
    )
    ensure(importState.import?.status === 'completed', 'expired_library_import_not_completed')
    ensure(importState.import?.completed_library_version === acknowledgedVersion, 'expired_library_import_version_mismatch')
    return { importID, acknowledgedVersion } satisfies CatalogImportEvidence
  } finally {
    page.off('response', observeResponse)
    page.off('request', observeRequest)
  }
}

async function findArchivedBoard(
  request: APIRequestContext,
  baseURL: string,
  boardID: string,
  boardName: string,
) {
  const payload = await successfulAPI(
    request,
    baseURL,
    'trash_board_lookup',
    `/api/whiteboards?scope=trash&q=${encodeURIComponent(boardName)}&limit=50`,
  )
  return (Array.isArray(payload.whiteboards) ? payload.whiteboards : [])
    .find((item: JSONObject) => item.id === boardID) as JSONObject | undefined
}

async function archivePersonalLibrary(
  candidates: readonly (BrowserContext | null)[],
  baseURL: string,
  libraryID: string,
) {
  for (const context of candidates) {
    if (!context) continue
    const detail = await callAPI(context.request, baseURL, `/api/whiteboard-libraries/${libraryID}`).catch(() => null)
    if (detail?.status === 404) return true
    if (!detail || detail.status !== 200 || !Number.isSafeInteger(detail.data?.library?.version)) continue
    await callAPI(context.request, baseURL, `/api/whiteboard-libraries/${libraryID}`, {
      method: 'DELETE',
      data: { expected_version: detail.data.library.version },
    }).catch(() => null)
    const readback = await callAPI(context.request, baseURL, `/api/whiteboard-libraries/${libraryID}`).catch(() => null)
    if (readback?.status === 404 || readback?.data?.library?.archived_at) return true
  }
  return false
}

async function findAdminUser(
  request: APIRequestContext,
  baseURL: string,
  accountID: string | null,
  userID: string | null,
  username: string,
): Promise<AdminEntityLookup> {
  const suffix = accountID ? `?account_id=${encodeURIComponent(accountID)}` : ''
  const listed = await callAPI(request, baseURL, `/api/admin/users${suffix}`).catch(() => null)
  if (!listed || listed.status !== 200 || listed.data?.success === false || !Array.isArray(listed.data?.users)) {
    return { confirmed: false, item: null }
  }
  const matches = (listed.data.users as JSONObject[]).filter((user: JSONObject) => (
    userID ? user.id === userID : user.username === username
  ))
  if (matches.length > 1) return { confirmed: false, item: null }
  if (matches.length === 0) return { confirmed: true, item: null }
  const item = matches[0]
  if (typeof item.id !== 'string' || item.username !== username) return { confirmed: false, item: null }
  return { confirmed: true, item }
}

async function findAdminRole(
  request: APIRequestContext,
  baseURL: string,
  roleID: string | null,
  roleName: string,
): Promise<AdminEntityLookup> {
  const listed = await callAPI(request, baseURL, '/api/admin/roles').catch(() => null)
  if (!listed || listed.status !== 200 || listed.data?.success === false || !Array.isArray(listed.data?.roles)) {
    return { confirmed: false, item: null }
  }
  const matches = (listed.data.roles as JSONObject[]).filter((role: JSONObject) => (
    roleID ? role.id === roleID : role.name === roleName
  ))
  if (matches.length > 1) return { confirmed: false, item: null }
  if (matches.length === 0) return { confirmed: true, item: null }
  const item = matches[0]
  if (typeof item.id !== 'string' || item.name !== roleName) return { confirmed: false, item: null }
  return { confirmed: true, item }
}

async function cleanupLiveState(input: {
  state: LiveState
  baseURL: string
  board: BoardTracking
  cleanup: CleanupState
  qaUsername: string
  roleName: string
}) {
  const { state, baseURL, board, cleanup, qaUsername, roleName } = input
  const adminRequest = state.adminContext?.request
  let userAbsenceConfirmed = false

  if (adminRequest) {
    const userLookup = await findAdminUser(adminRequest, baseURL, state.accountID, state.userID, qaUsername)
    if (userLookup.confirmed && userLookup.item?.id) state.userID = userLookup.item.id
    userAbsenceConfirmed = userLookup.confirmed && userLookup.item === null

    const roleLookup = await findAdminRole(adminRequest, baseURL, state.roleID, roleName)
    if (roleLookup.confirmed && roleLookup.item?.id) state.roleID = roleLookup.item.id
  }

  if (state.userID && !state.personalLibraryID) {
    let lookupConfirmed = false
    for (const context of [state.qaContextA, state.qaContextB, state.adminContext]) {
      if (!context) continue
      const listed = await callAPI(
        context.request,
        baseURL,
        `/api/whiteboard-libraries?q=${encodeURIComponent(`Mi biblioteca · ${state.userID}`)}&limit=50`,
      ).catch(() => null)
      if (!listed || listed.status !== 200 || listed.data?.success === false || !Array.isArray(listed.data?.libraries)) continue
      lookupConfirmed = true
      const found = (listed.data.libraries as JSONObject[])
        .find((item: JSONObject) => item.visibility === 'private' && item.created_by === state.userID && !item.archived_at)
      if (found?.id) {
        state.personalLibraryID = found.id
        break
      }
    }
    if (!state.personalLibraryID && !lookupConfirmed) cleanup.personal_library_archived = false
  }

  if (state.personalLibraryID) {
    cleanup.personal_library_archived = await archivePersonalLibrary(
      [state.qaContextA, state.qaContextB, state.adminContext],
      baseURL,
      state.personalLibraryID,
    )
  }

  if (adminRequest && state.boardID) {
    const active = await callAPI(adminRequest, baseURL, `/api/whiteboards/${state.boardID}`).catch(() => null)
    if (active?.status === 200 && Number.isSafeInteger(active.data?.whiteboard?.version)) {
      const archived = await callAPI(adminRequest, baseURL, `/api/whiteboards/${state.boardID}?expected_version=${active.data.whiteboard.version}`, {
        method: 'DELETE',
      }).catch(() => null)
      cleanup.board_archived = archived?.status === 200
    }
    const retained = await findArchivedBoard(adminRequest, baseURL, state.boardID, board.name).catch(() => undefined)
    if (retained?.archived_at) {
      cleanup.board_archived = true
      board.archived_at = retained.archived_at
    }
    if (board.archived_at && Number.isSafeInteger(board.retention_days)) {
      board.eligible_at = new Date(Date.parse(board.archived_at) + Number(board.retention_days) * 86_400_000).toISOString()
    }
  }

  await state.qaContextA?.close().catch(() => undefined)
  await state.qaContextB?.close().catch(() => undefined)
  state.qaContextA = null
  state.qaContextB = null

  const libraryCleanupAllowsUserDelete = cleanup.personal_library_archived !== false
  let canonicalUser: AdminEntityLookup = { confirmed: userAbsenceConfirmed, item: null }
  if (adminRequest) {
    canonicalUser = await findAdminUser(adminRequest, baseURL, state.accountID, state.userID, qaUsername)
    if (canonicalUser.confirmed && canonicalUser.item?.id) state.userID = canonicalUser.item.id
    userAbsenceConfirmed = canonicalUser.confirmed && canonicalUser.item === null
  }
  if (adminRequest && state.userID && !userAbsenceConfirmed && libraryCleanupAllowsUserDelete) {
    await callAPI(adminRequest, baseURL, `/api/admin/users/${state.userID}`, { method: 'DELETE' }).catch(() => null)
    canonicalUser = await findAdminUser(adminRequest, baseURL, state.accountID, state.userID, qaUsername)
    userAbsenceConfirmed = canonicalUser.confirmed && canonicalUser.item === null
  }
  cleanup.qa_user_deleted = userAbsenceConfirmed
  if (adminRequest && !userAbsenceConfirmed) {
    if (!canonicalUser.confirmed) {
      canonicalUser = await findAdminUser(adminRequest, baseURL, state.accountID, state.userID, qaUsername)
      if (canonicalUser.confirmed && canonicalUser.item?.id) state.userID = canonicalUser.item.id
      userAbsenceConfirmed = canonicalUser.confirmed && canonicalUser.item === null
      cleanup.qa_user_deleted = userAbsenceConfirmed
    }
    if (canonicalUser.confirmed && canonicalUser.item?.is_active === false) {
      cleanup.qa_user_deactivated = true
    } else if (canonicalUser.confirmed && canonicalUser.item?.is_active === true && state.userID) {
      await callAPI(adminRequest, baseURL, `/api/admin/users/${state.userID}/toggle`, { method: 'PATCH' }).catch(() => null)
      canonicalUser = await findAdminUser(adminRequest, baseURL, state.accountID, state.userID, qaUsername)
      userAbsenceConfirmed = canonicalUser.confirmed && canonicalUser.item === null
      cleanup.qa_user_deleted = userAbsenceConfirmed
      cleanup.qa_user_deactivated = Boolean(canonicalUser.confirmed && canonicalUser.item?.is_active === false)
    }
  }

  if (adminRequest) {
    let canonicalRole = await findAdminRole(adminRequest, baseURL, state.roleID, roleName)
    if (canonicalRole.confirmed && canonicalRole.item?.id) state.roleID = canonicalRole.item.id
    if (canonicalRole.confirmed && canonicalRole.item === null) cleanup.qa_role_deleted = true
    if (state.roleID
      && userAbsenceConfirmed
      && !(canonicalRole.confirmed && canonicalRole.item === null)) {
      await callAPI(adminRequest, baseURL, `/api/admin/roles/${state.roleID}`, { method: 'DELETE' }).catch(() => null)
      canonicalRole = await findAdminRole(adminRequest, baseURL, state.roleID, roleName)
      cleanup.qa_role_deleted = canonicalRole.confirmed && canonicalRole.item === null
    }
  }
  const runtimeSessions = state.runtimeSessionIDs.splice(0)
  if (runtimeSessions.length > 0) cleanup.runtime_sessions_removed = true
  for (const sessionID of runtimeSessions) {
    try {
      removeRuntimeSession(sessionID)
    } catch {
      cleanup.runtime_sessions_removed = false
    }
  }
  await state.adminContext?.close().catch(() => undefined)
  state.adminContext = null
}

// Callback fragments are bearer credentials. Keep every Playwright artifact
// disabled even if the repository-level configuration enables traces on retry.
test.use({ trace: 'off', screenshot: 'off', video: 'off' })

test.describe('smoke real opt-in · barra de Pizarras y Bibliotecas', () => {
  test.skip(!liveSmokeEnabled, 'Requiere CLARIN_E2E_LIVE_WHITEBOARDS=1 y autorización explícita.')
  test.describe.configure({ mode: 'serial' })

  test('ejercita producción, conserva sólo la retención permitida y emite un resumen sanitizado', async ({ browser, browserName }) => {
    test.skip(browserName !== 'chromium', 'El smoke mutante se ejecuta una sola vez en Chromium; la matriz visual vive en la suite aislada.')
    test.setTimeout(20 * 60 * 1000)

    const suffix = generatedSuffix()
    const createdAt = new Date()
    const qaUsername = `qa_pizarras_${createdAt.getTime()}_${suffix}`
    const qaPassword = generatedPassword()
    const roleName = `QA Pizarras ${createdAt.toISOString()} ${suffix}`
    const boardName = `QA Pizarras Barra Biblioteca · ${createdAt.toISOString()} · ${suffix}`
    const firstCommentBody = `Comentario smoke ${suffix}`
    const concurrentBody = `Edición concurrente ${suffix}`
    const preservedDraft = `Borrador preservado ${suffix}`
    const secondCommentBody = `Comentario reconexión A ${suffix}`
    const thirdCommentBody = `Comentario reconexión B ${suffix}`
    const firstLibraryTitle = (process.env.CLARIN_QA_LIBRARY_TITLE || 'Software Architecture').trim()
    const secondLibraryTitle = (process.env.CLARIN_QA_EXPIRED_LIBRARY_TITLE || 'System Design Components').trim()
    const evidence: TurnstileEvidence = {
      attempts: 0,
      checkbox_clicks: 0,
      tokens_observed: 0,
      human_interaction_declared: process.env.CLARIN_QA_ALLOW_INTERACTIVE_TURNSTILE === '1',
    }
    const checks: SmokeChecks = {
      admin_session: false,
      account_exact_match: false,
      independent_qa_sessions: false,
      access_hidden_404: false,
      access_view: false,
      access_comment: false,
      access_edit: false,
      comments_ui_hidden: false,
      comments_api_preserved: false,
      comments_conflict_409: false,
      comments_counts_and_filters: false,
      comments_markers_body_free: false,
      comments_no_browser_fetch: false,
      first_catalog_import: false,
      first_catalog_reload_persisted: false,
      library_ack_exact_and_idempotent: false,
      expired_callback_401: false,
      expired_callback_storage_ttl: false,
      expired_callback_allowlisted_next: false,
      expired_callback_resumed: false,
      second_catalog_reload_persisted: false,
    }
    const cleanup: CleanupState = {
      personal_library_archived: null,
      board_archived: false,
      qa_user_deleted: false,
      qa_user_deactivated: false,
      qa_role_deleted: false,
      runtime_sessions_removed: null,
    }
    const board: BoardTracking = {
      id: null,
      name: boardName,
      archived_at: null,
      retention_days: null,
      eligible_at: null,
    }
    const state: LiveState = {
      adminContext: null,
      adminPage: null,
      qaContextA: null,
      qaContextB: null,
      qaPageA: null,
      qaPageB: null,
      accountID: null,
      roleID: null,
      userID: null,
      boardID: null,
      personalLibraryID: null,
      runtimeSessionIDs: [],
      qaSessionAID: null,
      qaSessionBID: null,
    }
    let baseURL = productionOrigin
    let bootstrap: AuthBootstrap = 'runtime_harness'
    let runtimeSecret = ''
    let qaRuntimeActor: RuntimeActor | null = null
    let failureCode: string | null = null
    let phase = 'preflight'
    const phaseHeartbeat = setInterval(() => {
      process.stderr.write(`${JSON.stringify({ kind: 'clarin_whiteboards_live_smoke_phase', phase })}\n`)
    }, 15_000)

    try {
      baseURL = normalizedBaseURL()
      bootstrap = authBootstrapMode()
      phase = 'admin_auth'
      let adminUser: JSONObject
      if (bootstrap === 'runtime_harness') {
        ensure(process.env.CLARIN_QA_RUNTIME_HARNESS === '1', 'runtime_harness_not_explicitly_enabled')
        runtimeSecret = runtimeJWTSecret()
        const actor = runtimeAdminActor()
        const session = createRuntimeSession(actor, runtimeSecret)
        state.runtimeSessionIDs.push(session.id)
        state.adminContext = await browser.newContext()
        await installRuntimeSession(state.adminContext, baseURL, session)
        state.adminPage = await state.adminContext.newPage()
        const me = await successfulAPI(state.adminContext.request, baseURL, 'runtime_admin_me', '/api/me')
        ensure(me.user?.id === actor.user_id && me.user?.account_id === actor.account_id, 'runtime_admin_session_mismatch')
        adminUser = me.user
      } else {
        const admin = await ensureAdminContext(browser, baseURL, evidence)
        state.adminContext = admin.context
        state.adminPage = admin.page
        adminUser = admin.me
      }
      checks.admin_session = true
      ensure(state.adminContext, 'admin_context_missing')
      const adminContext = state.adminContext

      phase = 'account_selection'
      state.accountID = await switchAdminToTargetAccount(adminContext, baseURL, adminUser)
      checks.account_exact_match = true

      phase = 'retention_policy'
      const trashPolicy = await successfulAPI(
        adminContext.request,
        baseURL,
        'trash_policy',
        '/api/whiteboards/trash-policy',
      )
      ensure(Number.isSafeInteger(trashPolicy.retention_days) && trashPolicy.retention_days >= 7, 'trash_policy_invalid')
      board.retention_days = trashPolicy.retention_days

      phase = 'qa_role_creation'
      const role = await successfulAPI(
        adminContext.request,
        baseURL,
        'qa_role_create',
        '/api/admin/roles',
        {
          method: 'POST',
          data: {
            name: roleName,
            description: 'Rol temporal smoke Pizarras; eliminar al finalizar.',
            permissions: ['whiteboards'],
          },
        },
        [201],
      )
      ensure(typeof role.role?.id === 'string', 'qa_role_id_missing')
      state.roleID = role.role.id

      phase = 'qa_user_creation'
      const user = await successfulAPI(
        adminContext.request,
        baseURL,
        'qa_user_create',
        '/api/admin/users',
        {
          method: 'POST',
          data: {
            username: qaUsername,
            email: `${qaUsername}@users.clarin.local`,
            password: qaPassword,
            password_confirm: qaPassword,
            display_name: `QA Pizarras ${suffix}`,
            accounts: [{
              account_id: state.accountID,
              role: 'agent',
              role_id: state.roleID,
              is_default: true,
            }],
          },
        },
        [201],
      )
      ensure(typeof user.user?.id === 'string', 'qa_user_id_missing')
      state.userID = user.user.id

      phase = 'board_creation'
      const created = await successfulAPI(
        adminContext.request,
        baseURL,
        'board_create',
        '/api/whiteboards',
        {
          method: 'POST',
          data: {
            name: boardName,
            description: 'Artefacto temporal del smoke real de la barra y Bibliotecas de Pizarras.',
            folder_id: null,
            scene: emptyScene(),
            scene_schema_version: 'excalidraw',
            editor_version: '0.18.1-clarin.5',
            access_mode: 'private',
            operation_id: randomUUID(),
          },
        },
        [201],
      )
      ensure(typeof created.whiteboard?.id === 'string', 'board_id_missing')
      state.boardID = created.whiteboard.id
      board.id = state.boardID

      phase = 'qa_session_a'
      state.qaContextA = await browser.newContext()
      state.qaContextB = await browser.newContext()
      await installWhiteboardSocketControl(state.qaContextB)
      state.qaPageA = await state.qaContextA.newPage()
      state.qaPageB = await state.qaContextB.newPage()
      if (bootstrap === 'runtime_harness') {
        qaRuntimeActor = runtimeQAActor(state.userID, state.accountID)
        const sessionA = createRuntimeSession(qaRuntimeActor, runtimeSecret)
        const sessionB = createRuntimeSession(qaRuntimeActor, runtimeSecret)
        state.runtimeSessionIDs.push(sessionA.id, sessionB.id)
        state.qaSessionAID = sessionA.id
        state.qaSessionBID = sessionB.id
        await installRuntimeSession(state.qaContextA, baseURL, sessionA)
        await installRuntimeSession(state.qaContextB, baseURL, sessionB)
      } else {
        await loginThroughUI({
          page: state.qaPageA,
          baseURL,
          username: qaUsername,
          password: qaPassword,
          evidence,
        })
        phase = 'qa_session_b'
        await loginThroughUI({
          page: state.qaPageB,
          baseURL,
          username: qaUsername,
          password: qaPassword,
          evidence,
        })
      }
      const [meA, meB] = await Promise.all([
        successfulAPI(state.qaContextA.request, baseURL, 'qa_me_a', '/api/me'),
        successfulAPI(state.qaContextB.request, baseURL, 'qa_me_b', '/api/me'),
      ])
      ensure(meA.user?.id === state.userID && meB.user?.id === state.userID, 'qa_session_actor_mismatch')
      ensure(meA.user?.account_id === state.accountID && meB.user?.account_id === state.accountID, 'qa_session_account_mismatch')
      if (bootstrap === 'runtime_harness') {
        ensure(Boolean(state.qaSessionAID && state.qaSessionBID && state.qaSessionAID !== state.qaSessionBID), 'qa_sessions_not_independent')
      } else {
        const cookiesA = await state.qaContextA.cookies(baseURL)
        const cookiesB = await state.qaContextB.cookies(baseURL)
        const refreshA = cookiesA.find(cookie => cookie.name === 'refresh-token')?.value
        const refreshB = cookiesB.find(cookie => cookie.name === 'refresh-token')?.value
        ensure(Boolean(refreshA && refreshB && refreshA !== refreshB), 'qa_sessions_not_independent')
      }
      checks.independent_qa_sessions = true

      phase = 'access_hidden'
      const hidden = await callAPI(state.qaContextA.request, baseURL, `/api/whiteboards/${state.boardID}`)
      ensure(hidden.status === 404, 'private_board_not_hidden')
      checks.access_hidden_404 = true

      phase = 'access_view'
      await setBoardGrant(adminContext.request, baseURL, state.boardID, state.userID, 'view')
      const visibleBoard = await callAPI(state.qaContextA.request, baseURL, `/api/whiteboards/${state.boardID}`)
      ensure(visibleBoard.status === 200 && visibleBoard.data?.whiteboard?.effective_access?.level === 'view', 'view_access_missing')
      const deniedComment = await callAPI(state.qaContextA.request, baseURL, `/api/whiteboards/${state.boardID}/comment-threads`, {
        method: 'POST',
        data: { operation_id: randomUUID(), element_id: null, anchor_x: 10, anchor_y: 10, body: 'Debe rechazarse' },
      })
      ensure(deniedComment.status === 403, 'view_comment_not_forbidden')
      ensure((await sceneWriteResult(state.qaContextA.request, baseURL, state.boardID)).status === 403, 'view_scene_write_not_forbidden')
      checks.access_view = true

      phase = 'access_comment'
      await setBoardGrant(adminContext.request, baseURL, state.boardID, state.userID, 'comment')
      const commentAccess = await callAPI(state.qaContextA.request, baseURL, `/api/whiteboards/${state.boardID}`)
      ensure(commentAccess.status === 200 && commentAccess.data?.whiteboard?.effective_access?.level === 'comment', 'comment_access_missing')
      ensure((await sceneWriteResult(state.qaContextA.request, baseURL, state.boardID)).status === 403, 'comment_scene_write_not_forbidden')
      checks.access_comment = true

      phase = 'editor_two_sessions'
      let socketsB = 0
      let browserCommentRequests = 0
      const countBrowserCommentRequest = (request: Request) => {
        const pathname = new URL(request.url()).pathname
        if (/\/comment-(?:threads|markers)(?:\/|$)/u.test(pathname)) browserCommentRequests += 1
      }
      state.qaPageA.on('request', countBrowserCommentRequest)
      state.qaPageB.on('request', countBrowserCommentRequest)
      state.qaPageB.on('websocket', socket => {
        // Playwright may surface the URL before it can be normalized by the
        // platform URL constructor in this event callback. Matching the exact
        // account-scoped path keeps this observer read-only and non-throwing.
        try {
          if (socket.url().includes(`/ws/whiteboards/${state.boardID}`)) {
            socketsB += 1
          }
        } catch {
          // A transient observer failure must not abort the browser flow; the
          // bounded socket assertion below remains the source of truth.
        }
      })
      // Keep both sessions alive, but initialize the two heavy Excalidraw
      // runtimes sequentially. This still exercises real concurrent sessions
      // while avoiding a nondeterministic browser-process spike and a race to
      // create the same personal library during smoke bootstrap.
      phase = 'editor_session_a'
      await openEditor(state.qaPageA, baseURL, state.boardID)
      phase = 'editor_session_b'
      await openEditor(state.qaPageB, baseURL, state.boardID)
      phase = 'editor_wait_socket'
      await waitUntil(() => socketsB >= 1, 'second_session_websocket_missing', 30_000)
      await state.qaPageA.bringToFront()

      phase = 'comments_ui_hidden'
      await assertCommentsUIHidden(state.qaPageA)
      await assertCommentsUIHidden(state.qaPageB)
      await assertClosedSidebarOwnership(state.qaPageA)
      ensure(await state.qaPageA.locator('.whiteboard-action-bar').filter({ visible: true }).count() === 1, 'whiteboard_action_bar_missing')
      ensure(await state.qaPageA.locator('[data-whiteboard-save-status]').filter({ visible: true }).count() === 1, 'whiteboard_save_status_owner_invalid')
      checks.comments_ui_hidden = true

      phase = 'comment_api_create'
      const firstThread = await createCommentThroughAPI(
        state.qaContextA.request,
        baseURL,
        state.boardID,
        firstCommentBody,
        280,
        220,
      )
      ensure(Boolean(firstThread?.id && firstThread.comments?.[0]?.id), 'comment_api_create_missing_thread')
      checks.comments_api_preserved = true

      const initialCounts = await successfulAPI(
        state.qaContextA.request,
        baseURL,
        'comment_counts_initial',
        `/api/whiteboards/${state.boardID}/comment-threads?status=all&limit=40`,
      )
      assertCounts(initialCounts, { open: 1, resolved: 0, all: 1 }, 'comment_counts_initial')
      const openFilter = await successfulAPI(
        state.qaContextA.request,
        baseURL,
        'comment_open_filter',
        `/api/whiteboards/${state.boardID}/comment-threads?status=open&limit=40`,
      )
      const resolvedFilter = await successfulAPI(
        state.qaContextA.request,
        baseURL,
        'comment_resolved_filter',
        `/api/whiteboards/${state.boardID}/comment-threads?status=resolved&limit=40`,
      )
      ensure(openFilter.threads?.length === 1 && resolvedFilter.threads?.length === 0, 'comment_status_filter_invalid')

      phase = 'comment_markers'
      const markers = await successfulAPI(
        state.qaContextA.request,
        baseURL,
        'comment_markers',
        `/api/whiteboards/${state.boardID}/comment-markers?limit=200`,
      )
      ensure(markers.markers?.length === 1, 'comment_marker_missing')
      const markerFields = new Set([
        'id', 'board_id', 'element_id', 'anchor_x', 'anchor_y',
        'anchor_ratio_x', 'anchor_ratio_y', 'version', 'comment_count', 'updated_at',
      ])
      ensure(
        Object.keys(markers.markers[0]).every(field => markerFields.has(field)),
        'comment_marker_contains_unapproved_field',
      )
      ensure(!JSON.stringify(markers.markers).includes(firstCommentBody), 'comment_marker_contains_body')
      checks.comments_markers_body_free = true

      phase = 'comment_concurrent_edit'
      const beforeConcurrent = await successfulAPI(
        state.qaContextB.request,
        baseURL,
        'comment_thread_before_concurrent',
        `/api/whiteboards/${state.boardID}/comment-threads/${firstThread.id}`,
      )
      const originalComment = beforeConcurrent.thread.comments.find((item: JSONObject) => item.id === firstThread.comments[0].id)
      ensure(Number.isSafeInteger(originalComment?.version), 'comment_version_missing')
      await successfulAPI(
        state.qaContextB.request,
        baseURL,
        'comment_concurrent_write',
        `/api/whiteboards/${state.boardID}/comment-threads/${firstThread.id}/comments/${originalComment.id}`,
        {
          method: 'PATCH',
          data: {
            operation_id: randomUUID(),
            expected_version: originalComment.version,
            body: concurrentBody,
          },
        },
      )
      const staleWrite = await callAPI(
        state.qaContextA.request,
        baseURL,
        `/api/whiteboards/${state.boardID}/comment-threads/${firstThread.id}/comments/${originalComment.id}`,
        {
          method: 'PATCH',
          data: {
            operation_id: randomUUID(),
            expected_version: originalComment.version,
            body: preservedDraft,
          },
        },
      )
      ensure(staleWrite.status === 409, 'comment_conflict_409_missing')
      await assertCommentsUIHidden(state.qaPageA)
      checks.comments_conflict_409 = true

      phase = 'comment_resolve_counts'
      const latestFirst = await successfulAPI(
        state.qaContextA.request,
        baseURL,
        'comment_thread_latest',
        `/api/whiteboards/${state.boardID}/comment-threads/${firstThread.id}`,
      )
      await successfulAPI(
        state.qaContextA.request,
        baseURL,
        'comment_resolve',
        `/api/whiteboards/${state.boardID}/comment-threads/${firstThread.id}/status`,
        {
          method: 'PATCH',
          data: {
            operation_id: randomUUID(),
            expected_version: latestFirst.thread.version,
            status: 'resolved',
          },
        },
      )
      const resolvedCounts = await successfulAPI(
        state.qaContextA.request,
        baseURL,
        'comment_counts_resolved',
        `/api/whiteboards/${state.boardID}/comment-threads?status=resolved&limit=40`,
      )
      assertCounts(resolvedCounts, { open: 0, resolved: 1, all: 1 }, 'comment_counts_resolved')
      ensure(resolvedCounts.threads?.length === 1 && resolvedCounts.threads[0].id === firstThread.id, 'resolved_filter_missing_thread')

      phase = 'comment_api_inventory'
      await createCommentThroughAPI(
        state.qaContextA.request,
        baseURL,
        state.boardID,
        secondCommentBody,
        340,
        260,
      )
      await createCommentThroughAPI(
        state.qaContextA.request,
        baseURL,
        state.boardID,
        thirdCommentBody,
        560,
        330,
      )
      const reconciledCounts = await successfulAPI(
        state.qaContextB.request,
        baseURL,
        'comment_counts_reconciled',
        `/api/whiteboards/${state.boardID}/comment-threads?status=all&limit=40`,
      )
      assertCounts(reconciledCounts, { open: 2, resolved: 1, all: 3 }, 'comment_counts_reconciled')
      checks.comments_counts_and_filters = true
      await assertCommentsUIHidden(state.qaPageA)
      await assertCommentsUIHidden(state.qaPageB)
      ensure(browserCommentRequests === 0, 'comments_browser_request_detected')
      checks.comments_no_browser_fetch = true

      phase = 'access_edit'
      await setBoardGrant(adminContext.request, baseURL, state.boardID, state.userID, 'edit')
      const editAccess = await callAPI(state.qaContextA.request, baseURL, `/api/whiteboards/${state.boardID}`)
      ensure(editAccess.status === 200 && editAccess.data?.whiteboard?.effective_access?.level === 'edit', 'edit_access_missing')
      ensure((await sceneWriteResult(state.qaContextA.request, baseURL, state.boardID)).status === 200, 'edit_scene_write_failed')
      checks.access_edit = true

      phase = 'personal_library_before_import'
      const beforeLibrary = await personalLibrary(state.qaContextA.request, baseURL, state.userID)
      state.personalLibraryID = beforeLibrary.id
      const beforeCount = libraryItemCount(beforeLibrary)
      ensure(beforeCount >= 0, 'personal_library_count_invalid')

      phase = 'first_catalog_import'
      const firstImport = await runCatalogImport({
        page: state.qaPageA,
        baseURL,
        boardID: state.boardID,
        libraryID: beforeLibrary.id,
        title: firstLibraryTitle,
      })
      const afterFirst = await personalLibrary(state.qaContextA.request, baseURL, state.userID)
      ensure(afterFirst.id === state.personalLibraryID, 'personal_library_changed_after_import')
      ensure(afterFirst.version === firstImport.acknowledgedVersion, 'first_import_ack_version_mismatch')
      ensure(libraryItemCount(afterFirst) > beforeCount, 'first_import_items_not_persisted')
      checks.first_catalog_import = true
      await state.qaPageA.reload({ waitUntil: 'domcontentloaded' })
      await visible(state.qaPageA.locator('.whiteboard-editor-shell'), 'editor_missing_after_first_reload', 45_000)
      const afterFirstReload = await personalLibrary(state.qaContextA.request, baseURL, state.userID)
      ensure(afterFirstReload.version === afterFirst.version && libraryItemCount(afterFirstReload) === libraryItemCount(afterFirst), 'first_import_not_stable_after_reload')
      checks.first_catalog_reload_persisted = true

      const idempotentACK = await callAPI(
        state.qaContextA.request,
        baseURL,
        `/api/whiteboards/${state.boardID}/public-library-imports/${firstImport.importID}/complete`,
        {
          method: 'POST',
          data: { operation_id: firstImport.importID, library_version: firstImport.acknowledgedVersion },
        },
      )
      ensure(idempotentACK.status === 200 && idempotentACK.data?.import?.status === 'completed', 'library_ack_not_idempotent')
      const divergentACK = await callAPI(
        state.qaContextA.request,
        baseURL,
        `/api/whiteboards/${state.boardID}/public-library-imports/${firstImport.importID}/complete`,
        {
          method: 'POST',
          data: { operation_id: firstImport.importID, library_version: firstImport.acknowledgedVersion + 1 },
        },
      )
      ensure(divergentACK.status === 409, 'library_ack_divergent_version_not_conflict')
      checks.library_ack_exact_and_idempotent = true

      phase = 'expired_catalog_import'
      const expiredImport = await runExpiredCatalogImport({
        page: state.qaPageA,
        context: state.qaContextA,
        baseURL,
        boardID: state.boardID,
        title: secondLibraryTitle,
        username: qaUsername,
        password: qaPassword,
        evidence,
        authBootstrap: bootstrap,
        expireRuntimeSession: bootstrap === 'runtime_harness'
          ? () => {
              ensure(state.qaSessionAID, 'runtime_expired_session_missing')
              removeRuntimeSession(state.qaSessionAID)
              state.runtimeSessionIDs = state.runtimeSessionIDs.filter(id => id !== state.qaSessionAID)
              state.qaSessionAID = null
            }
          : undefined,
        restoreRuntimeSession: bootstrap === 'runtime_harness'
          ? async () => {
              ensure(qaRuntimeActor, 'runtime_qa_actor_missing_for_restore')
              const fresh = createRuntimeSession(qaRuntimeActor, runtimeSecret)
              state.runtimeSessionIDs.push(fresh.id)
              state.qaSessionAID = fresh.id
              await installRuntimeSession(state.qaContextA!, baseURL, fresh)
            }
          : undefined,
      })
      checks.expired_callback_401 = true
      checks.expired_callback_storage_ttl = true
      checks.expired_callback_allowlisted_next = true
      const afterExpired = await personalLibrary(state.qaContextA.request, baseURL, state.userID)
      ensure(afterExpired.version === expiredImport.acknowledgedVersion, 'expired_import_ack_version_mismatch')
      ensure(libraryItemCount(afterExpired) > libraryItemCount(afterFirstReload), 'expired_import_items_not_persisted')
      checks.expired_callback_resumed = true
      await state.qaPageA.reload({ waitUntil: 'domcontentloaded' })
      await visible(state.qaPageA.locator('.whiteboard-editor-shell'), 'editor_missing_after_expired_reload', 45_000)
      const finalLibrary = await personalLibrary(state.qaContextA.request, baseURL, state.userID)
      ensure(finalLibrary.version === afterExpired.version && libraryItemCount(finalLibrary) === libraryItemCount(afterExpired), 'expired_import_not_stable_after_reload')
      checks.second_catalog_reload_persisted = true
    } catch (error) {
      failureCode = error instanceof SmokeFailure ? error.code : `${phase}_failed`
    } finally {
      phase = 'cleanup'
      await cleanupLiveState({ state, baseURL, board, cleanup, qaUsername, roleName }).catch(() => {
        if (!failureCode) failureCode = 'cleanup_failed'
      })
      clearInterval(phaseHeartbeat)
      if (state.boardID && !cleanup.board_archived && !failureCode) failureCode = 'board_cleanup_incomplete'
      if (state.userID && !cleanup.qa_user_deleted && !failureCode) failureCode = 'qa_user_cleanup_incomplete'
      if (state.roleID && !cleanup.qa_role_deleted && !failureCode) failureCode = 'qa_role_cleanup_incomplete'
      if (state.personalLibraryID && cleanup.personal_library_archived !== true && !failureCode) failureCode = 'personal_library_cleanup_incomplete'
      if (bootstrap === 'runtime_harness' && cleanup.runtime_sessions_removed === false && !failureCode) failureCode = 'runtime_session_cleanup_incomplete'

      const summary = {
        kind: 'clarin_whiteboards_live_smoke',
        ok: failureCode === null,
        auth_bootstrap: bootstrap,
        login_ui_exercised: evidence.attempts > 0,
        account_name: targetAccountName,
        board,
        cleanup,
        checks,
        turnstile: evidence,
        blocker_code: failureCode,
      }
      process.stdout.write(`${JSON.stringify(summary)}\n`)
    }

    if (failureCode) throw new SmokeFailure(`live_smoke_incomplete:${failureCode}`)
  })
})
