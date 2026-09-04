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
const rolloutOffProbeEnabled = process.env.CLARIN_QA_WORK_WHITEBOARDS_FLAG_OFF_PROBE === '1'
const recoverySmokeEnabled = process.env.CLARIN_QA_WORK_WHITEBOARDS_RECOVERY === '1'
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
  admin_qa_distinct: boolean
  independent_qa_sessions: boolean
  access_hidden_404: boolean
  access_view: boolean
  access_comment: boolean
  access_edit: boolean
  access_realtime_reconciled: boolean
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
  work_list_created: boolean
  work_folder_created: boolean
  work_editor_bootstrap_api: boolean
  work_two_sessions_opened: boolean
  work_hub_canonical: boolean
  work_hub_ui_roundtrip: boolean
  work_scene_ui_persisted: boolean
  work_ws_fanout_observed: boolean
  work_trash_restored: boolean
  work_revocation_ws: boolean
  work_revocation_denied_and_hidden: boolean
}

interface CleanupState {
  personal_library_archived: boolean | null
  board_archived: boolean
  qa_user_deleted: boolean
  qa_user_deactivated: boolean
  qa_role_deleted: boolean
  runtime_sessions_removed: boolean | null
  work_views_archived: boolean | null
  runtime_db_verified: boolean | null
  runtime_redis_verified: boolean | null
  contextual_acl_clean: boolean | null
  contextual_storage_integrity: boolean | null
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
  createdRuntimeSessionIDs: string[]
  qaSessionAID: string | null
  qaSessionBID: string | null
  workViews: Array<{ id: string; boardID: string; name: string }>
  expectedWorkViewNames: string[]
}

interface WorkSmokeLocations {
  environmentID: string
  environmentName: string
  listID: string
  listName: string
  listIsDefault: boolean
  folderID: string
  folderName: string
}

interface WhiteboardSocketEvidence {
  opened: number
  roomReady: number
  presenceSnapshots: number
  scenePatches: number
  accessRevoked: number
  boardArchived: number
  workAccessChanged: number
  sessionExpired: number
  permissionChanged: number
  permissionAccess: string | null
}

interface GeneralSocketEvidence {
  opened: number
  closed: number
  active: number
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

function runtimeQAActor(userID: string, accountID: string, tasksExpected = true) {
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
  ensure(
    actor.permissions.includes('tasks') === tasksExpected,
    tasksExpected ? 'runtime_harness_qa_tasks_permission_missing' : 'runtime_harness_qa_tasks_permission_not_revoked',
  )
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
  const invalidationMarker = runtimeCommand([
    'exec',
    'clarin-redis',
    'redis-cli',
    '--raw',
    'GET',
    `usersessinv:${actor.user_id}`,
  ])
  const session = JSON.stringify({
    user_id: actor.user_id,
    account_id: actor.account_id,
    username: actor.username,
    created_at: now,
    last_seen: now,
    ...(invalidationMarker ? { invalidation_marker: invalidationMarker } : {}),
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

function runtimeSessionIDsForUser(userID: string) {
  ensure(validUUID(userID), 'runtime_recovery_user_id_invalid')
  const keys = runtimeCommand([
    'exec',
    'clarin-redis',
    'redis-cli',
    '--scan',
    '--pattern',
    'session:*',
  ]).split('\n').map(value => value.trim()).filter(Boolean)
  const sessions: string[] = []
  for (const key of keys) {
    const match = /^session:([0-9a-f-]+)$/i.exec(key)
    if (!match || !validUUID(match[1])) continue
    const raw = runtimeCommand(['exec', 'clarin-redis', 'redis-cli', '--raw', 'GET', key])
    if (!raw) continue
    try {
      const record = JSON.parse(raw) as JSONObject
      if (record.user_id === userID) sessions.push(match[1])
    } catch {
      // Ignore unrelated or legacy non-JSON session payloads. The exact QA
      // user match is mandatory before a recovered key can be removed.
    }
  }
  return [...new Set(sessions)]
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

async function boundedStep<T>(
  operation: () => Promise<T>,
  code: string,
  timeout = 20_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SmokeFailure(code)), timeout)
      }),
    ])
  } catch (error) {
    if (error instanceof SmokeFailure) throw error
    throw new SmokeFailure(code)
  } finally {
    if (timer) clearTimeout(timer)
  }
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
      editor_version: '0.18.1-clarin.6',
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
  const closed = async () => {
    return await page.locator('button[data-whiteboard-action="library"]').filter({ visible: true }).count() === 1
      && await visibleHostSidebarAction(page, 'comments').count() === 0
      && await visibleInternalSidebarAction(page, 'library').count() === 0
      && await visibleInternalSidebarAction(page, 'comments').count() === 0
  }
  try {
    await waitUntil(closed, 'closed_sidebar_owner_invalid', 20_000)
  } catch (error) {
    const snapshot = await page.evaluate(() => ({
      url: window.location.href,
      host_library: document.querySelectorAll('button[data-whiteboard-action="library"]:not([hidden])').length,
      host_comments: document.querySelectorAll('button[data-whiteboard-sidebar-action="comments"]:not([hidden])').length,
      internal_library: Array.from(document.querySelectorAll<HTMLElement>('button[data-whiteboard-sidebar-internal="library"]'))
        .filter(element => element.getClientRects().length > 0)
        .map(element => element.dataset.state || null),
      internal_comments: Array.from(document.querySelectorAll<HTMLElement>('button[data-whiteboard-sidebar-internal="comments"]'))
        .filter(element => element.getClientRects().length > 0)
        .map(element => element.dataset.state || null),
      close_controls: Array.from(document.querySelectorAll<HTMLElement>('.sidebar__close'))
        .filter(element => element.getClientRects().length > 0).length,
      editor_shells: document.querySelectorAll('.whiteboard-editor-shell').length,
      save_statuses: Array.from(document.querySelectorAll<HTMLElement>('[data-whiteboard-save-status]'))
        .filter(element => element.getClientRects().length > 0)
        .map(element => element.dataset.whiteboardSaveStatus || null),
      permission_revalidating: document.querySelectorAll('[data-whiteboard-permission-revalidating]').length,
      editor_error_heading: Array.from(document.querySelectorAll<HTMLElement>('h1,h2,h3'))
        .some(element => element.textContent?.trim() === 'No se pudo abrir la pizarra'),
    })).catch(() => ({ unavailable: true }))
    process.stderr.write(`${JSON.stringify({
      kind: 'clarin_whiteboards_live_smoke_diagnostic',
      probe: 'closed_sidebar_ownership',
      state: snapshot,
    })}\n`)
    throw error
  }
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

function diagnosticPath(value: string) {
  return value.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, ':uuid')
}

function diagnosticPageError(error: Error) {
  const name = ['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError'].includes(error.name)
    ? error.name
    : 'BrowserError'
  const message = error.message.toLowerCase()
  if (message.includes('chunk')) return `${name}:chunk_load`
  if (message.includes('fetch') || message.includes('network')) return `${name}:network`
  if (message.includes('abort')) return `${name}:abort`
  return `${name}:runtime`
}

async function openWorkEditor(page: Page, baseURL: string, viewID: string) {
  const responses: Array<{ path: string; status: number }> = []
  const failedRequests: Array<{ path: string; error: string }> = []
  const pageErrors: string[] = []
  const observeResponse = (response: { url(): string; status(): number }) => {
    try {
      const url = new URL(response.url())
      if (url.origin !== new URL(baseURL).origin) return
      if (
        url.pathname === '/api/me'
        || url.pathname.startsWith('/api/tasks/environments')
        || url.pathname.startsWith('/api/tasks/location-views')
        || url.pathname.startsWith('/api/whiteboards/')
        || (url.pathname.startsWith('/_next/static/') && response.status() >= 400)
      ) {
        responses.push({ path: diagnosticPath(url.pathname), status: response.status() })
      }
    } catch {
      // Diagnostics must never make the smoke itself fail.
    }
  }
  const observePageError = (error: Error) => {
    pageErrors.push(diagnosticPageError(error))
  }
  const observeRequestFailed = (request: Request) => {
    try {
      const url = new URL(request.url())
      if (url.origin !== new URL(baseURL).origin) return
      if (
        url.pathname.startsWith('/api/tasks/')
        || url.pathname.startsWith('/api/whiteboards/')
        || url.pathname.startsWith('/_next/static/')
      ) {
        const failure = (request.failure()?.errorText || '').toLowerCase()
        const error = failure.includes('abort') || failure.includes('cancel')
          ? 'aborted'
          : failure.includes('timed')
            ? 'timeout'
            : 'request_failed'
        failedRequests.push({ path: diagnosticPath(url.pathname), error })
      }
    } catch {
      // Diagnostics must never make the smoke itself fail.
    }
  }
  page.on('response', observeResponse)
  page.on('pageerror', observePageError)
  page.on('requestfailed', observeRequestFailed)
  try {
    await page.goto(`${baseURL}/dashboard/tasks?work_view=${encodeURIComponent(viewID)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    })
  } catch {
    page.off('response', observeResponse)
    page.off('pageerror', observePageError)
    page.off('requestfailed', observeRequestFailed)
    throw new SmokeFailure('work_editor_navigation_failed')
  }
  try {
    await visible(page.locator('.whiteboard-editor-shell'), 'work_editor_shell_not_visible', 45_000)
    await visible(page.getByLabel('Guardado en Clarin'), 'work_editor_not_ready', 45_000)
    const visibleTitles = page.locator('input[aria-label="Nombre de la pizarra"]:visible')
    const visibleTitleCount = await visibleTitles.count()
    ensure(visibleTitleCount <= 1, 'work_title_owner_invalid')
    if (visibleTitleCount === 1) {
      ensure(
        await visibleTitles.first().evaluate(element => element instanceof HTMLInputElement && element.readOnly),
        'work_title_not_readonly',
      )
    }
    ensure(await page.getByText('Compartir desde Clarin', { exact: true }).count() === 0, 'work_share_control_visible')
  } catch (error) {
    const browserState = await page.evaluate(() => ({
      pathname: window.location.pathname,
      has_work_view: new URLSearchParams(window.location.search).has('work_view'),
      ready_state: document.readyState,
      auth_marker: Boolean(window.localStorage.getItem('token')),
      workspace_mounted: Boolean(document.querySelector('[data-task-workspace-width]')),
      editor_loading: document.body.textContent?.includes('Abriendo pizarra') === true,
      editor_error: document.body.textContent?.includes('No se pudo abrir la pizarra') === true,
      login_visible: Boolean(document.querySelector('form[action*="login"], input[name="username"]')),
      editor_shells: document.querySelectorAll('.whiteboard-editor-shell').length,
      save_statuses: document.querySelectorAll('[data-whiteboard-save-status]').length,
      visible_title_inputs: Array.from(document.querySelectorAll<HTMLInputElement>('input[aria-label="Nombre de la pizarra"]'))
        .filter(element => element.getClientRects().length > 0)
        .map(element => ({ readonly: element.readOnly, disabled: element.disabled })),
      share_controls: Array.from(document.querySelectorAll<HTMLElement>('button, a'))
        .filter(element => element.textContent?.trim() === 'Compartir desde Clarin').length,
      alert_codes: Array.from(document.querySelectorAll<HTMLElement>('[role="alert"]'))
        .map(element => (element.textContent || '').toLocaleLowerCase('es'))
        .map(message => message.includes('sesión') ? 'session' : message.includes('acceso') ? 'access' : message.includes('pizarra') ? 'whiteboard' : 'other')
        .slice(0, 4),
    })).catch(() => ({ unavailable: true }))
    process.stderr.write(`${JSON.stringify({
      kind: 'clarin_whiteboards_live_smoke_diagnostic',
      probe: 'work_editor_open',
      browser_state: browserState,
      responses: responses.slice(-30),
      failed_requests: failedRequests.slice(-16),
      page_errors: pageErrors.slice(-8),
    })}\n`)
    throw error
  } finally {
    page.off('response', observeResponse)
    page.off('pageerror', observePageError)
    page.off('requestfailed', observeRequestFailed)
  }
}

function observeGeneralSocket(page: Page): GeneralSocketEvidence {
  const evidence: GeneralSocketEvidence = { opened: 0, closed: 0, active: 0 }
  page.on('websocket', socket => {
    let matches = false
    try {
      matches = new URL(socket.url()).pathname === '/ws'
    } catch {
      matches = socket.url().includes('/ws') && !socket.url().includes('/ws/whiteboards/')
    }
    if (!matches) return
    evidence.opened += 1
    evidence.active += 1
    socket.on('close', () => {
      evidence.closed += 1
      evidence.active = Math.max(0, evidence.active - 1)
    })
  })
  return evidence
}

function observeWhiteboardSocket(page: Page, boardID: string): WhiteboardSocketEvidence {
  ensure(validUUID(boardID), 'work_socket_board_id_invalid')
  const evidence: WhiteboardSocketEvidence = {
    opened: 0,
    roomReady: 0,
    presenceSnapshots: 0,
    scenePatches: 0,
    accessRevoked: 0,
    boardArchived: 0,
    workAccessChanged: 0,
    sessionExpired: 0,
    permissionChanged: 0,
    permissionAccess: null,
  }
  page.on('websocket', socket => {
    let matches = false
    try {
      matches = new URL(socket.url()).pathname === `/ws/whiteboards/${boardID}`
    } catch {
      matches = socket.url().includes(`/ws/whiteboards/${boardID}`)
    }
    if (!matches) return
    evidence.opened += 1
    socket.on('framereceived', frame => {
      try {
        const raw = typeof frame.payload === 'string' ? frame.payload : frame.payload.toString('utf8')
        const message = JSON.parse(raw) as JSONObject
        if (message.event === 'room.ready') evidence.roomReady += 1
        if (message.event === 'presence.snapshot') evidence.presenceSnapshots += 1
        if (message.event === 'scene.patch') evidence.scenePatches += 1
        if (message.event === 'access.revoked' && message.code === 'access_revoked') {
          evidence.accessRevoked += 1
        }
        if (message.event === 'access.revoked' && message.code === 'board_archived') {
          evidence.boardArchived += 1
        }
        if (message.event === 'access.revoked' && message.code === 'work_access_changed') {
          evidence.workAccessChanged += 1
        }
        if (message.event === 'error' && message.code === 'session_expired') {
          evidence.sessionExpired += 1
        }
        if (message.event === 'error' && message.code === 'permission_changed') {
          evidence.permissionChanged += 1
          const access = message.data?.access
          evidence.permissionAccess = typeof access === 'string' ? access : null
        }
      } catch {
        // Only event names are evidence. Invalid or binary protocol frames are
        // ignored without ever exposing their payload in smoke diagnostics.
      }
    })
  })
  return evidence
}

async function drawRectangleInEditor(page: Page) {
  await boundedStep(() => page.bringToFront(), 'work_canvas_focus_failed', 10_000)
  const canvas = await visible(page.locator('canvas.interactive').first(), 'work_canvas_not_visible', 45_000)
  ensure(await page.getByText('Solo lectura', { exact: true }).count() === 0, 'work_editor_read_only')
  const box = await boundedStep(() => canvas.boundingBox(), 'work_canvas_geometry_timeout', 15_000)
  ensure(box && box.width >= 200 && box.height >= 200, 'work_canvas_geometry_invalid')
  const rectangleTool = page.getByTestId('toolbar-rectangle')
  await visible(rectangleTool, 'work_rectangle_tool_not_visible')
  ensure(await rectangleTool.isEnabled({ timeout: 2_000 }), 'work_rectangle_tool_disabled')
  await page.evaluate(() => {
    const status = document.querySelector<HTMLElement>('[data-whiteboard-save-status]')
    const trackedWindow = window as typeof window & { __clarinQaSaveTransitions?: string[] }
    trackedWindow.__clarinQaSaveTransitions = status?.dataset.whiteboardSaveStatus
      ? [status.dataset.whiteboardSaveStatus]
      : []
    if (!status) return
    const observer = new MutationObserver(() => {
      const next = status.dataset.whiteboardSaveStatus
      if (next) trackedWindow.__clarinQaSaveTransitions?.push(next)
    })
    observer.observe(status, { attributes: true, attributeFilter: ['data-whiteboard-save-status'] })
    window.setTimeout(() => observer.disconnect(), 30_000)
  })
  await boundedStep(
    () => rectangleTool.locator('xpath=ancestor::label[1]').click({ timeout: 10_000 }),
    'work_rectangle_tool_click_failed',
    12_000,
  )
  await waitUntil(
    () => rectangleTool.isChecked({ timeout: 2_000 }),
    'work_rectangle_tool_not_selected',
    10_000,
  )
  const startX = box.x + box.width * 0.42
  const startY = box.y + box.height * 0.40
  await boundedStep(async () => {
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(
      startX + Math.min(140, box.width * 0.16),
      startY + Math.min(100, box.height * 0.14),
      { steps: 6 },
    )
    await page.mouse.up()
  }, 'work_rectangle_gesture_failed', 15_000)
  ensure(await canvas.isVisible(), 'work_canvas_lost_after_draw')
  await waitUntil(
    () => page.getByRole('button', { name: 'Deshacer' }).isEnabled({ timeout: 2_000 }),
    'work_rectangle_local_change_missing',
    10_000,
  )
  await waitUntil(
    () => page.evaluate(() => {
      const trackedWindow = window as typeof window & { __clarinQaSaveTransitions?: string[] }
      return trackedWindow.__clarinQaSaveTransitions?.some(state => state !== 'saved') === true
    }),
    'work_rectangle_not_marked_pending',
    10_000,
  )
}

async function canonicalScene(request: APIRequestContext, baseURL: string, boardID: string) {
  const result = await callAPI(request, baseURL, `/api/whiteboards/${boardID}/scene`)
  ensure(result.status === 200 && result.data?.scene, 'work_scene_read_failed')
  return result.data.scene as JSONObject
}

async function waitForPersistedRectangle(
  request: APIRequestContext,
  baseURL: string,
  boardID: string,
  afterSequence: number,
) {
  let rectangle: JSONObject | null = null
  await waitUntil(async () => {
    const result = await callAPI(request, baseURL, `/api/whiteboards/${boardID}/scene`)
    if (result.status !== 200 || !result.data?.scene) return false
    const record = result.data.scene as JSONObject
    const elements = Array.isArray(record.scene?.elements) ? record.scene.elements as JSONObject[] : []
    rectangle = elements.find(item => item?.type === 'rectangle' && item?.isDeleted !== true) || null
    return Number(record.sequence) > afterSequence && typeof rectangle?.id === 'string'
  }, 'work_rectangle_not_persisted', 45_000)
  return rectangle as JSONObject
}

async function discoverWorkSmokeLocations(request: APIRequestContext, baseURL: string): Promise<WorkSmokeLocations> {
  const environmentPayload = await successfulAPI(request, baseURL, 'work_environments', '/api/tasks/environments?limit=50')
  const configuredEnvironmentID = process.env.CLARIN_QA_WORK_ENVIRONMENT_ID?.trim()
  const environments = (Array.isArray(environmentPayload.environments) ? environmentPayload.environments : []) as JSONObject[]
  const ordered = configuredEnvironmentID
    ? [...environments.filter(item => item.id === configuredEnvironmentID), ...environments.filter(item => item.id !== configuredEnvironmentID)]
    : [...environments.filter(item => item.is_default), ...environments.filter(item => !item.is_default)]
  const configuredListID = process.env.CLARIN_QA_WORK_LIST_ID?.trim()
  const configuredFolderID = process.env.CLARIN_QA_WORK_FOLDER_ID?.trim()
  for (const environment of ordered) {
    if (typeof environment.id !== 'string' || environment.archived_at || environment.deleted_at) continue
    const [listResult, folderResult] = await Promise.all([
      callAPI(request, baseURL, `/api/tasks/environments/${environment.id}/lists?scope=all&limit=200`),
      callAPI(request, baseURL, `/api/tasks/environments/${environment.id}/folders?limit=200`),
    ])
    if (listResult.status !== 200 || folderResult.status !== 200) continue
    const lists = (Array.isArray(listResult.data?.lists) ? listResult.data.lists : []) as JSONObject[]
    const folders = (Array.isArray(folderResult.data?.folders) ? folderResult.data.folders : []) as JSONObject[]
    const list = configuredListID ? lists.find(item => item.id === configuredListID) : lists.find(item => item.is_default) || lists[0]
    const folder = configuredFolderID ? folders.find(item => item.id === configuredFolderID) : folders[0]
    if (
      typeof environment.name === 'string'
      && typeof list?.id === 'string'
      && typeof list?.name === 'string'
      && typeof folder?.id === 'string'
      && typeof folder?.name === 'string'
    ) {
      return {
        environmentID: environment.id as string,
        environmentName: environment.name,
        listID: list.id,
        listName: list.name,
        listIsDefault: list.is_default === true,
        folderID: folder.id,
        folderName: folder.name,
      }
    }
  }
  throw new SmokeFailure('work_qa_locations_unavailable')
}

async function selectWorkSmokeLocation(
  page: Page,
  baseURL: string,
  locations: WorkSmokeLocations,
  scopeType: 'list' | 'folder',
) {
  await page.goto(`${baseURL}/dashboard/tasks`, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  await visible(page.locator('[data-task-workspace-width]'), 'work_workspace_not_visible', 45_000)
  const environmentTrigger = page.locator('button[aria-label^="Entorno "]:visible, button[aria-label="Seleccionar Entorno"]:visible').first()
  await visible(environmentTrigger, 'work_environment_trigger_not_visible')
  if (await environmentTrigger.getAttribute('aria-label') !== `Entorno ${locations.environmentName}`) {
    await environmentTrigger.click({ timeout: 20_000 })
    const dialog = await visible(page.getByRole('dialog', { name: 'Seleccionar Entorno' }), 'work_environment_dialog_not_visible')
    const search = dialog.getByPlaceholder('Buscar Entornos…')
    await fill(search, locations.environmentName, 'work_environment_search')
    const target = dialog.getByRole('button').filter({ hasText: locations.environmentName }).first()
    await click(target, 'work_environment_target')
    await waitUntil(
      async () => await environmentTrigger.getAttribute('aria-label') === `Entorno ${locations.environmentName}`,
      'work_environment_not_selected',
      30_000,
    )
  }

  const target = scopeType === 'folder'
    ? page.locator(`[data-task-drop-folder="${locations.folderID}"]`).getByText(locations.folderName, { exact: true }).first()
    : locations.listIsDefault
      ? page.locator('[data-task-default-list]').getByText(locations.listName, { exact: true }).first()
      : page.locator(`[data-task-hierarchy-list="${locations.listID}"]`).getByText(locations.listName, { exact: true }).first()
  await click(target, `work_${scopeType}_scope`)
  const addView = page.getByRole('button', { name: 'Vista', exact: true })
  await visible(addView, `work_${scopeType}_add_view_not_visible`)
  const expectedScopeName = scopeType === 'folder' ? locations.folderName : locations.listName
  await waitUntil(
    async () => await addView.isEnabled()
      && await addView.getAttribute('title') === `Añadir una vista a ${expectedScopeName}`,
    `work_${scopeType}_scope_not_selected`,
    30_000,
  )
}

async function createWorkSmokeViewThroughUI(
  page: Page,
  request: APIRequestContext,
  baseURL: string,
  locations: WorkSmokeLocations,
  scopeType: 'list' | 'folder',
  name: string,
) {
  await selectWorkSmokeLocation(page, baseURL, locations, scopeType)
  await click(page.getByRole('button', { name: 'Vista', exact: true }), `work_${scopeType}_add_view`)
  const dialog = await visible(page.getByRole('dialog', { name: 'Añadir vista' }), `work_${scopeType}_dialog_not_visible`)
  ensure(await dialog.getByText('Pizarra', { exact: true }).isVisible(), `work_${scopeType}_catalog_missing`)
  await fill(dialog.getByPlaceholder('Ej. Mapa del proyecto'), name, `work_${scopeType}_name`)
  const responsePromise = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.origin === baseURL
      && url.pathname === '/api/tasks/location-views'
      && response.request().method() === 'POST'
  }, { timeout: 45_000 })
  await click(dialog.getByRole('button', { name: 'Añadir pizarra' }), `work_${scopeType}_submit`)
  const response = await responsePromise
  const payload = await response.json().catch(() => ({})) as JSONObject
  ensure(response.status() === 201 && payload.success !== false, `work_${scopeType}_create_${response.status()}`)
  const view = payload.location_view
  const scopeID = scopeType === 'list' ? locations.listID : locations.folderID
  ensure(typeof view?.id === 'string' && typeof view?.resource?.whiteboard?.id === 'string', `work_${scopeType}_binding_missing`)
  ensure(view.scope?.scope_type === scopeType && view.scope?.scope_id === scopeID, `work_${scopeType}_scope_mismatch`)
  ensure(view.capabilities?.can_manage_access === false, `work_${scopeType}_acl_not_inherited`)
  await waitUntil(() => new URL(page.url()).searchParams.get('work_view') === view.id, `work_${scopeType}_deep_link_missing`, 30_000)
  await visible(page.locator('.whiteboard-editor-shell'), `work_${scopeType}_editor_not_visible`, 45_000)
  await visible(page.getByLabel('Guardado en Clarin'), `work_${scopeType}_editor_not_ready`, 45_000)
  const canonical = await callAPI(request, baseURL, `/api/tasks/location-views/${view.id}`)
  ensure(canonical.status === 200 && canonical.data?.location_view?.resource?.whiteboard?.id === view.resource.whiteboard.id, `work_${scopeType}_create_readback_failed`)
  return { id: view.id as string, boardID: view.resource.whiteboard.id as string, name }
}

async function returnToTasks(page: Page, baseURL: string) {
  const integrated = page.getByLabel('Volver a las tareas').filter({ visible: true }).first()
  if (await integrated.isVisible().catch(() => false)) {
    await click(integrated, 'work_return_to_tasks')
  } else {
    await click(page.getByTestId('main-menu-trigger').filter({ visible: true }).first(), 'work_main_menu')
    await click(page.getByText('Volver a las tareas', { exact: true }).filter({ visible: true }).first(), 'work_main_menu_return')
  }
  await waitUntil(() => {
    const url = new URL(page.url())
    return url.origin === baseURL && url.pathname === '/dashboard/tasks' && !url.searchParams.has('work_view')
  }, 'work_return_url_invalid', 30_000)
  await waitUntil(() => page.locator('.whiteboard-editor-shell').count().then(count => count === 0), 'work_editor_not_unmounted', 30_000)
}

async function selectWhiteboardHubScope(page: Page, baseURL: string, scope: 'work' | 'trash') {
  const label = scope === 'work' ? 'Clarin Work' : 'Papelera'
  const navigation = page.getByRole('navigation', { name: 'Vistas y carpetas de Pizarras' })
  const openNavigation = page.getByRole('button', { name: 'Abrir navegación de Pizarras' })
  await waitUntil(async () => await navigation.isVisible() || await openNavigation.isVisible(), 'work_hub_navigation_missing', 30_000)
  if (!await navigation.isVisible()) {
    await click(openNavigation, 'work_hub_navigation_open')
    await visible(navigation, 'work_hub_navigation_not_visible')
  }
  const target = navigation.getByRole('button', { name: new RegExp(`^${label}`) })
  if (await target.getAttribute('aria-current') !== 'page') {
    const responsePromise = page.waitForResponse(response => {
      const url = new URL(response.url())
      if (url.origin !== baseURL || url.pathname !== '/api/whiteboards' || response.request().method() !== 'GET') return false
      return scope === 'work' ? url.searchParams.get('origin') === 'work' : url.searchParams.get('scope') === 'trash'
    }, { timeout: 45_000 })
    await click(target, `work_hub_${scope}_scope`)
    const response = await responsePromise
    ensure(response.status() === 200, `work_hub_${scope}_load_${response.status()}`)
  }
  await visible(page.getByRole('heading', { name: label, exact: true }), `work_hub_${scope}_heading_missing`)
}

async function workHubRoundTrip(
  page: Page,
  request: APIRequestContext,
  baseURL: string,
  view: { id: string; boardID: string; name: string },
  expectedElementID: string,
) {
  await page.goto(`${baseURL}/dashboard/whiteboards`, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  await selectWhiteboardHubScope(page, baseURL, 'work')
  const card = await visible(page.locator(`[data-whiteboard-id="${view.boardID}"]`), 'work_hub_board_missing', 45_000)
  ensure(await card.getByText('Clarin Work', { exact: true }).count() > 0, 'work_hub_badge_missing')
  ensure(await card.getByRole('button', { name: /Cambiar carpeta/ }).count() === 0, 'work_hub_move_control_visible')
  ensure(await card.getByRole('button', { name: /Arrastrar .* a una carpeta/ }).count() === 0, 'work_hub_drag_control_visible')
  await click(card.getByRole('button', { name: `Abrir ${view.name}` }).first(), 'work_hub_open_editor')
  await visible(page.locator('.whiteboard-editor-shell'), 'work_hub_editor_not_visible', 45_000)
  await visible(page.getByLabel('Guardado en Clarin'), 'work_hub_editor_not_ready', 45_000)
  const reopened = await canonicalScene(request, baseURL, view.boardID)
  const elements = Array.isArray(reopened.scene?.elements) ? reopened.scene.elements as JSONObject[] : []
  ensure(elements.some(item => item.id === expectedElementID && item.isDeleted !== true), 'work_hub_scene_readback_missing')
  await click(page.getByTestId('main-menu-trigger').filter({ visible: true }).first(), 'work_hub_editor_menu')
  await click(page.getByText('Volver a Pizarras', { exact: true }).filter({ visible: true }).first(), 'work_hub_editor_return')
  await waitUntil(() => new URL(page.url()).pathname === '/dashboard/whiteboards', 'work_hub_return_url_invalid', 30_000)
  await selectWhiteboardHubScope(page, baseURL, 'work')
  const reopenedCard = await visible(page.locator(`[data-whiteboard-id="${view.boardID}"]`), 'work_hub_board_missing_after_return', 45_000)
  const workLink = reopenedCard.locator(`a[href="/dashboard/tasks?work_view=${view.id}"]`).first()
  await click(workLink, 'work_hub_open_location')
  await waitUntil(() => new URL(page.url()).searchParams.get('work_view') === view.id, 'work_hub_location_url_invalid', 30_000)
  await visible(page.locator('.whiteboard-editor-shell'), 'work_hub_location_editor_missing', 45_000)
}

async function trashAndRestoreWorkViewThroughUI(
  page: Page,
  request: APIRequestContext,
  baseURL: string,
  view: { id: string; boardID: string; name: string },
  socketEvidence: WhiteboardSocketEvidence,
) {
  await openWorkEditor(page, baseURL, view.id)
  await click(page.getByRole('button', { name: `Acciones de ${view.name}` }), 'work_trash_actions')
  const actions = await visible(page.getByRole('menu', { name: `Acciones de ${view.name}` }), 'work_trash_menu_missing')
  await click(actions.getByRole('menuitem', { name: 'Mover a Papelera' }), 'work_trash_menu_action')
  const dialog = await visible(page.getByRole('dialog', { name: 'Mover pizarra a Papelera' }), 'work_trash_dialog_missing')
  const trashResponsePromise = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.origin === baseURL
      && url.pathname === `/api/tasks/location-views/${view.id}`
      && response.request().method() === 'DELETE'
  }, { timeout: 45_000 })
  await click(dialog.getByRole('button', { name: 'Mover a Papelera' }), 'work_trash_confirm')
  const trashResponse = await trashResponsePromise
  const trashPayload = await trashResponse.json().catch(() => ({})) as JSONObject
  ensure(trashResponse.status() === 200 && trashPayload.location_view?.lifecycle === 'trash', 'work_trash_ui_readback_failed')
  await waitUntil(
    () => socketEvidence.boardArchived > 0,
    'work_location_trash_ws_frame_missing',
    45_000,
  )

  await page.goto(`${baseURL}/dashboard/whiteboards`, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  await selectWhiteboardHubScope(page, baseURL, 'trash')
  const trashCard = await visible(page.locator(`[data-whiteboard-id="${view.boardID}"]`), 'work_trash_hub_card_missing', 45_000)
  ensure(await trashCard.getByText(/Ubicación original/).count() > 0, 'work_trash_origin_missing')
  await click(trashCard.getByRole('button', { name: `Más acciones de ${view.name}` }), 'work_restore_actions')
  const restoreMenu = await visible(page.getByRole('menu', { name: `Acciones de ${view.name}` }), 'work_restore_menu_missing')
  const restoreResponsePromise = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.origin === baseURL
      && url.pathname === `/api/whiteboards/${view.boardID}/restore`
      && response.request().method() === 'POST'
  }, { timeout: 45_000 })
  await click(restoreMenu.getByRole('menuitem', { name: 'Restaurar' }), 'work_restore_action')
  const restoreResponse = await restoreResponsePromise
  ensure(restoreResponse.status() === 200, `work_restore_ui_${restoreResponse.status()}`)
  await waitUntil(() => trashCard.count().then(count => count === 0), 'work_restore_trash_card_not_removed', 30_000)
  await visible(page.getByRole('heading', { name: 'Papelera', exact: true }), 'work_restore_trash_scope_changed')
  const restored = await callAPI(request, baseURL, `/api/tasks/location-views/${view.id}`)
  ensure(restored.status === 200 && restored.data?.location_view?.lifecycle === 'active', 'work_restore_ui_readback_failed')
  await selectWhiteboardHubScope(page, baseURL, 'work')
  const restoredCard = await visible(page.locator(`[data-whiteboard-id="${view.boardID}"]`), 'work_restore_active_card_missing', 45_000)
  ensure(await restoredCard.locator(`a[href="/dashboard/tasks?work_view=${view.id}"]`).count() === 1, 'work_restore_location_link_missing')
  ensure(await restoredCard.getByRole('button', { name: /Cambiar carpeta/ }).count() === 0, 'work_restore_move_control_visible')
}

async function closeActiveSidebar(page: Page) {
  const close = page.locator('.sidebar__close').filter({ visible: true }).first()
  if (await close.isVisible().catch(() => false)) {
    await close.click({ timeout: 5_000 }).catch(() => undefined)
  } else {
    const activeLibrary = page.locator(
      'button[data-whiteboard-sidebar-internal="library"][data-state="active"]',
    ).filter({ visible: true }).first()
    if (await activeLibrary.isVisible().catch(() => false)) {
      await activeLibrary.click({ timeout: 5_000 }).catch(() => undefined)
    }
  }
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

async function recoverTrackedWorkViews(
  request: APIRequestContext,
  baseURL: string,
  state: LiveState,
) {
  let complete = true
  const tracked = new Map(state.workViews.map(view => [view.id, view]))
  for (const name of state.expectedWorkViewNames) {
    for (const path of [
      `/api/whiteboards?scope=all&origin=work&q=${encodeURIComponent(name)}&limit=50`,
      `/api/whiteboards?scope=trash&origin=work&q=${encodeURIComponent(name)}&limit=50`,
    ]) {
      const result = await callAPI(request, baseURL, path).catch(() => null)
      if (!result || result.status !== 200 || !Array.isArray(result.data?.whiteboards)) {
        complete = false
        continue
      }
      for (const board of result.data.whiteboards as JSONObject[]) {
        if (board?.name !== name || board?.origin !== 'work') continue
        const viewID = board?.work_location?.task_view_id
        if (!validUUID(board?.id || '') || !validUUID(viewID || '')) {
          complete = false
          continue
        }
        tracked.set(viewID, { id: viewID, boardID: board.id, name })
      }
    }
  }
  state.workViews = [...tracked.values()]
  return complete
}

function runtimeReadbackJSON(query: string) {
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
  ensure(Boolean(output), 'runtime_cleanup_db_readback_empty')
  try {
    const parsed = JSON.parse(output) as JSONObject
    ensure(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'runtime_cleanup_db_readback_invalid')
    return parsed
  } catch (error) {
    if (error instanceof SmokeFailure) throw error
    throw new SmokeFailure('runtime_cleanup_db_readback_invalid')
  }
}

function uuidArraySQL(ids: string[], code: string) {
  ensure(ids.length > 0 && ids.every(validUUID), code)
  return `ARRAY[${ids.map(id => `'${id}'::uuid`).join(',')}]::uuid[]`
}

async function verifyRuntimeCleanup(state: LiveState, cleanup: CleanupState) {
  ensure(
    validUUID(state.accountID || '')
      && validUUID(state.userID || '')
      && validUUID(state.roleID || '')
      && state.workViews.length > 0,
    'runtime_cleanup_tracking_incomplete',
  )
  const accountID = state.accountID!
  const userID = state.userID!
  const roleID = state.roleID!
  const viewIDs = [...new Set(state.workViews.map(view => view.id))]
  const boardIDs = [...new Set(state.workViews.map(view => view.boardID))]
  const viewsSQL = uuidArraySQL(viewIDs, 'runtime_cleanup_view_ids_invalid')
  const boardsSQL = uuidArraySQL(boardIDs, 'runtime_cleanup_board_ids_invalid')
  const readback = runtimeReadbackJSON(`
    SELECT json_build_object(
      'qa_users',(SELECT COUNT(*) FROM users WHERE id='${userID}'::uuid),
      'qa_memberships',(SELECT COUNT(*) FROM user_accounts WHERE account_id='${accountID}'::uuid AND user_id='${userID}'::uuid),
      'qa_roles',(SELECT COUNT(*) FROM roles WHERE id='${roleID}'::uuid),
      'qa_grants',(SELECT COUNT(*) FROM whiteboard_grants WHERE account_id='${accountID}'::uuid AND user_id='${userID}'::uuid),
      'views',(SELECT COUNT(*) FROM task_location_views WHERE account_id='${accountID}'::uuid AND id=ANY(${viewsSQL})),
      'trash_views',(SELECT COUNT(*) FROM task_location_views WHERE account_id='${accountID}'::uuid AND id=ANY(${viewsSQL}) AND deleted_at IS NOT NULL),
      'bindings',(SELECT COUNT(*) FROM task_location_whiteboard_views WHERE account_id='${accountID}'::uuid AND task_view_id=ANY(${viewsSQL}) AND whiteboard_id=ANY(${boardsSQL})),
      'trash_boards',(SELECT COUNT(*) FROM whiteboards WHERE account_id='${accountID}'::uuid AND id=ANY(${boardsSQL}) AND archived_at IS NOT NULL),
      'foldered_boards',(SELECT COUNT(*) FROM whiteboards WHERE account_id='${accountID}'::uuid AND id=ANY(${boardsSQL}) AND folder_id IS NOT NULL),
      'orphan_bindings',(
        SELECT COUNT(*) FROM task_location_whiteboard_views binding
        LEFT JOIN task_location_views task_view ON task_view.account_id=binding.account_id AND task_view.id=binding.task_view_id
        LEFT JOIN whiteboards board ON board.account_id=binding.account_id AND board.id=binding.whiteboard_id
        WHERE binding.account_id='${accountID}'::uuid AND binding.task_view_id=ANY(${viewsSQL})
          AND (task_view.id IS NULL OR board.id IS NULL)
      ),
      'grants',(SELECT COUNT(*) FROM whiteboard_grants WHERE account_id='${accountID}'::uuid AND board_id=ANY(${boardsSQL})),
      'shares',(SELECT COUNT(*) FROM whiteboard_share_links WHERE account_id='${accountID}'::uuid AND board_id=ANY(${boardsSQL})),
      'guests',(SELECT COUNT(*) FROM whiteboard_guest_sessions WHERE account_id='${accountID}'::uuid AND board_id=ANY(${boardsSQL})),
      'asset_links',(SELECT COUNT(*) FROM whiteboard_assets WHERE account_id='${accountID}'::uuid AND board_id=ANY(${boardsSQL})),
      'invalid_assets',(
        SELECT COUNT(*) FROM whiteboard_assets asset
        LEFT JOIN media_assets media ON media.account_id=asset.account_id AND media.id=asset.media_asset_id
        LEFT JOIN storage_objects stored ON stored.account_id=media.account_id AND stored.object_key=media.object_key
        LEFT JOIN user_accounts owner ON owner.account_id=asset.account_id AND owner.user_id=asset.uploaded_by
        WHERE asset.account_id='${accountID}'::uuid AND asset.board_id=ANY(${boardsSQL})
          AND (
            media.id IS NULL OR stored.object_key IS NULL
            OR (asset.uploaded_by IS NOT NULL AND owner.user_id IS NULL)
            OR (asset.committed_at IS NULL AND (asset.draft_expires_at IS NULL OR asset.draft_expires_at<=NOW()))
          )
      ),
      'invalid_revision_assets',(
        SELECT COUNT(*) FROM whiteboard_revision_assets revision_asset
        LEFT JOIN media_assets media ON media.account_id=revision_asset.account_id AND media.id=revision_asset.media_asset_id
        LEFT JOIN storage_objects stored ON stored.account_id=media.account_id AND stored.object_key=media.object_key
        WHERE revision_asset.account_id='${accountID}'::uuid AND revision_asset.board_id=ANY(${boardsSQL})
          AND (media.id IS NULL OR stored.object_key IS NULL)
      ),
      'missing_snapshots',(
        SELECT COUNT(*) FROM whiteboard_revisions revision
        LEFT JOIN storage_objects stored ON stored.account_id=revision.account_id AND stored.object_key=revision.snapshot_object_key
        WHERE revision.account_id='${accountID}'::uuid AND revision.board_id=ANY(${boardsSQL})
          AND stored.object_key IS NULL
      )
    )::text
  `)
  const expectedViews = viewIDs.length
  const expectedBoards = boardIDs.length
  cleanup.contextual_acl_clean = Number(readback.grants) === 0
    && Number(readback.shares) === 0
    && Number(readback.guests) === 0
    && Number(readback.qa_grants) === 0
  cleanup.contextual_storage_integrity = Number(readback.invalid_assets) === 0
    && Number(readback.invalid_revision_assets) === 0
    && Number(readback.missing_snapshots) === 0
  cleanup.runtime_db_verified = Number(readback.qa_users) === 0
    && Number(readback.qa_memberships) === 0
    && Number(readback.qa_roles) === 0
    && Number(readback.views) === expectedViews
    && Number(readback.trash_views) === expectedViews
    && Number(readback.bindings) === expectedViews
    && Number(readback.trash_boards) === expectedBoards
    && Number(readback.foldered_boards) === 0
    && Number(readback.orphan_bindings) === 0
    && cleanup.contextual_acl_clean
    && cleanup.contextual_storage_integrity

  const sessionIDs = [...new Set(state.createdRuntimeSessionIDs)]
  ensure(sessionIDs.length > 0 && sessionIDs.every(validUUID), 'runtime_cleanup_session_ids_invalid')
  await waitUntil(() => {
    const sessions = Number(runtimeCommand([
      'exec',
      'clarin-redis',
      'redis-cli',
      'EXISTS',
      ...sessionIDs.map(id => `session:${id}`),
    ]))
    if (sessions !== 0) return false
    return boardIDs.every(boardID => {
      const presenceIndex = `whiteboard:presence:${accountID}:${boardID}`
      const presentationIndex = `whiteboard:presentation:${accountID}:${boardID}`
      const presenceCount = Number(runtimeCommand(['exec', 'clarin-redis', 'redis-cli', 'ZCARD', presenceIndex]))
      const presentationCount = Number(runtimeCommand(['exec', 'clarin-redis', 'redis-cli', 'ZCARD', presentationIndex]))
      const presencePayloads = runtimeCommand([
        'exec',
        'clarin-redis',
        'redis-cli',
        '--scan',
        '--pattern',
        `${presenceIndex}:client:*`,
      ])
      const presentationPayloads = runtimeCommand([
        'exec',
        'clarin-redis',
        'redis-cli',
        '--scan',
        '--pattern',
        `${presentationIndex}:lease:*`,
      ])
      return presenceCount === 0
        && presentationCount === 0
        && presencePayloads === ''
        && presentationPayloads === ''
    })
  }, 'runtime_cleanup_redis_residue', 30_000, 500)
  cleanup.runtime_redis_verified = true
  ensure(cleanup.runtime_db_verified, 'runtime_cleanup_db_invariant_failed')
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

    const workDiscoveryComplete = await recoverTrackedWorkViews(adminRequest, baseURL, state)
    if (!workDiscoveryComplete) cleanup.work_views_archived = false
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

  if (adminRequest && state.workViews.length > 0) {
    cleanup.work_views_archived = cleanup.work_views_archived !== false
    for (const tracked of state.workViews) {
      const current = await callAPI(adminRequest, baseURL, `/api/tasks/location-views/${tracked.id}`).catch(() => null)
      if (current?.status === 404) {
        const retained = await findArchivedBoard(adminRequest, baseURL, tracked.boardID, tracked.name).catch(() => undefined)
        const location = retained?.work_location
        if (retained?.origin !== 'work' || location?.task_view_id !== tracked.id || location?.lifecycle !== 'trash') {
          cleanup.work_views_archived = false
        }
        continue
      }
      const view = current?.data?.location_view
      if (current?.status !== 200 || !Number.isSafeInteger(view?.version)) {
        cleanup.work_views_archived = false
        continue
      }
      if (view.lifecycle === 'trash') continue
      const archived = await callAPI(adminRequest, baseURL, `/api/tasks/location-views/${tracked.id}`, {
        method: 'DELETE',
        data: { expected_version: view.version, operation_id: randomUUID() },
      }).catch(() => null)
      if (archived?.status !== 200 || archived.data?.location_view?.lifecycle !== 'trash') {
        cleanup.work_views_archived = false
        continue
      }
      const retained = await findArchivedBoard(adminRequest, baseURL, tracked.boardID, tracked.name).catch(() => undefined)
      const location = retained?.work_location
      if (retained?.origin !== 'work' || location?.task_view_id !== tracked.id || location?.lifecycle !== 'trash') {
        cleanup.work_views_archived = false
      }
    }
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

test.describe('sondeo real opt-in · rollout apagado de Pizarras en Work', () => {
  test.skip(!rolloutOffProbeEnabled, 'Requiere CLARIN_QA_WORK_WHITEBOARDS_FLAG_OFF_PROBE=1 y autorización explícita.')

  test('oculta Hub y bloquea rutas contextuales y genéricas con una sesión autenticada', async ({ browser, browserName }) => {
    test.skip(browserName !== 'chromium')
    test.setTimeout(120_000)
    const baseURL = (process.env.CLARIN_QA_BASE_URL || productionOrigin).replace(/\/$/, '')
    ensure(new URL(baseURL).origin === productionOrigin, 'flag_off_probe_origin_not_allowed')
    const actor = runtimeAdminActor()
    const session = createRuntimeSession(actor, runtimeJWTSecret())
    const context = await browser.newContext()
    try {
      await installRuntimeSession(context, baseURL, session)
      const listResponse = await context.request.get(`${baseURL}/api/tasks/location-views?scope_type=list&scope_id=${randomUUID()}&limit=50`)
      const listBody = await listResponse.json() as JSONObject
      ensure(listResponse.status() === 200, 'flag_off_location_list_status')
      ensure(listBody.success === true && listBody.feature_enabled === false, 'flag_off_location_list_capability')
      ensure(Array.isArray(listBody.location_views) && listBody.location_views.length === 0, 'flag_off_location_list_leak')

      const viewID = randomUUID()
      const gatedRoutes = [
        { method: 'POST', path: '/api/tasks/location-views', data: {} },
        { method: 'GET', path: `/api/tasks/location-views/${viewID}` },
        { method: 'PATCH', path: `/api/tasks/location-views/${viewID}`, data: {} },
        { method: 'POST', path: `/api/tasks/location-views/${viewID}/duplicate`, data: {} },
        { method: 'DELETE', path: `/api/tasks/location-views/${viewID}`, data: {} },
        { method: 'POST', path: `/api/tasks/location-views/${viewID}/restore`, data: {} },
      ]
      for (const route of gatedRoutes) {
        const response = await context.request.fetch(`${baseURL}${route.path}`, { method: route.method, data: route.data })
        const body = await response.json() as JSONObject
        ensure(response.status() === 404 && body.code === 'work_whiteboard_views_disabled', 'flag_off_contextual_route_open')
      }

      const boardID = runtimeCommand([
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
        `SELECT whiteboard_id::text FROM task_location_whiteboard_views WHERE account_id='${actor.account_id}'::uuid ORDER BY created_at LIMIT 1`,
      ])
      if (!boardID) {
        test.info().annotations.push({
          type: 'flag_off_generic_routes',
          description: 'not_applicable:no_existing_contextual_binding',
        })
      } else {
        ensure(validUUID(boardID), 'flag_off_contextual_board_fixture_invalid')
        for (const path of [
          `/api/whiteboards/${boardID}`,
          `/api/whiteboards/${boardID}/scene`,
          `/api/whiteboards/${boardID}/assets`,
          `/api/whiteboards/${boardID}/revisions`,
        ]) {
          const response = await context.request.get(`${baseURL}${path}`)
          const body = await response.json() as JSONObject
          // Generic Whiteboard endpoints deliberately use the canonical
          // not-found envelope so the disabled rollout does not reveal that
          // an otherwise hidden resource belongs to Clarin Work.
          ensure(
            response.status() === 404 && body.code === 'whiteboard_not_found',
            `flag_off_generic_route_open:${path}:${response.status()}:${String(body.code || body.error || 'missing_code')}`,
          )
        }
      }

      const hubResponse = await context.request.get(`${baseURL}/api/whiteboards?origin=work&limit=50`)
      const hubBody = await hubResponse.json() as JSONObject
      ensure(hubResponse.status() === 200 && hubBody.work_whiteboard_views_enabled === false, 'flag_off_hub_capability')
      ensure(Array.isArray(hubBody.whiteboards) && hubBody.whiteboards.every((item: JSONObject) => item.origin !== 'work'), 'flag_off_hub_leak')
    } finally {
      await context.close().catch(() => undefined)
      removeRuntimeSession(session.id)
    }
  })
})

test.describe('recuperación opt-in · artefactos QA de Pizarras', () => {
  test.skip(!recoverySmokeEnabled, 'Requiere CLARIN_QA_WORK_WHITEBOARDS_RECOVERY=1 y confirmación explícita.')

  test('retira canónicamente un smoke interrumpido y verifica PostgreSQL y Redis', async ({ browser, browserName }) => {
    test.skip(browserName !== 'chromium')
    test.setTimeout(4 * 60 * 1000)
    ensure(
      process.env.CLARIN_QA_WORK_WHITEBOARDS_RECOVERY_CONFIRM === 'RECOVER_FAILED_WHITEBOARD_SMOKE',
      'recovery_confirmation_missing',
    )
    const required = (name: string) => {
      const value = process.env[name]?.trim() || ''
      ensure(Boolean(value), `recovery_${name.toLowerCase()}_missing`)
      return value
    }
    const accountID = required('CLARIN_QA_RECOVERY_ACCOUNT_ID')
    const userID = required('CLARIN_QA_RECOVERY_USER_ID')
    const roleID = required('CLARIN_QA_RECOVERY_ROLE_ID')
    const boardID = required('CLARIN_QA_RECOVERY_BOARD_ID')
    const libraryID = required('CLARIN_QA_RECOVERY_LIBRARY_ID')
    const workViewID = required('CLARIN_QA_RECOVERY_WORK_VIEW_ID')
    const workBoardID = required('CLARIN_QA_RECOVERY_WORK_BOARD_ID')
    for (const value of [accountID, userID, roleID, boardID, libraryID, workViewID, workBoardID]) {
      ensure(validUUID(value), 'recovery_identifier_invalid')
    }
    const createdAt = required('CLARIN_QA_RECOVERY_CREATED_AT')
    const suffix = required('CLARIN_QA_RECOVERY_SUFFIX')
    ensure(new Date(createdAt).toISOString() === createdAt, 'recovery_created_at_invalid')
    ensure(/^[0-9a-f]{8}$/i.test(suffix), 'recovery_suffix_invalid')
    const qaUsername = `qa_pizarras_${new Date(createdAt).getTime()}_${suffix}`
    const roleName = `QA Pizarras ${createdAt} ${suffix}`
    const boardName = `QA Pizarras Barra Biblioteca · ${createdAt} · ${suffix}`
    const workBoardName = `QA Work Lista · ${createdAt} · ${suffix}`
    const baseURL = normalizedBaseURL()
    ensure(process.env.CLARIN_QA_RUNTIME_HARNESS === '1', 'recovery_runtime_harness_not_enabled')

    const cleanup: CleanupState = {
      personal_library_archived: null,
      board_archived: false,
      qa_user_deleted: false,
      qa_user_deactivated: false,
      qa_role_deleted: false,
      runtime_sessions_removed: null,
      work_views_archived: null,
      runtime_db_verified: null,
      runtime_redis_verified: null,
      contextual_acl_clean: null,
      contextual_storage_integrity: null,
    }
    const board: BoardTracking = {
      id: boardID,
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
      accountID,
      roleID,
      userID,
      boardID,
      personalLibraryID: libraryID,
      runtimeSessionIDs: [],
      createdRuntimeSessionIDs: [],
      qaSessionAID: null,
      qaSessionBID: null,
      workViews: [{ id: workViewID, boardID: workBoardID, name: workBoardName }],
      expectedWorkViewNames: [workBoardName],
    }
    const sessionsCreatedHere = new Set<string>()
    const sessionsApprovedForRecovery = new Set<string>()
    let preflightComplete = false

    try {
      const secret = runtimeJWTSecret()
      const adminActor = runtimeAdminActor()
      ensure(adminActor.account_id === accountID, 'recovery_admin_account_mismatch')
      const adminSession = createRuntimeSession(adminActor, secret)
      sessionsCreatedHere.add(adminSession.id)
      state.adminContext = await browser.newContext()
      await installRuntimeSession(state.adminContext, baseURL, adminSession)
      const me = await successfulAPI(state.adminContext.request, baseURL, 'recovery_admin_me', '/api/me')
      ensure(me.user?.id === adminActor.user_id && me.user?.account_id === accountID, 'recovery_admin_session_mismatch')
      ensure(await switchAdminToTargetAccount(state.adminContext, baseURL, me.user) === accountID, 'recovery_account_mismatch')

      const capability = await callAPI(
        state.adminContext.request,
        baseURL,
        '/api/whiteboards?origin=work&limit=1',
      )
      ensure(
        capability.status === 200 && capability.data?.work_whiteboard_views_enabled === true,
        'recovery_feature_not_enabled',
      )

      const userLookup = await findAdminUser(state.adminContext.request, baseURL, accountID, userID, qaUsername)
      ensure(userLookup.confirmed && userLookup.item?.id === userID && userLookup.item?.username === qaUsername, 'recovery_user_mismatch')
      const roleLookup = await findAdminRole(state.adminContext.request, baseURL, roleID, roleName)
      ensure(roleLookup.confirmed && roleLookup.item?.id === roleID && roleLookup.item?.name === roleName, 'recovery_role_mismatch')

      const qaActor = runtimeQAActor(userID, accountID, true)
      const qaSession = createRuntimeSession(qaActor, secret)
      sessionsCreatedHere.add(qaSession.id)
      state.qaSessionAID = qaSession.id
      state.qaContextA = await browser.newContext()
      await installRuntimeSession(state.qaContextA, baseURL, qaSession)
      const qaMe = await successfulAPI(state.qaContextA.request, baseURL, 'recovery_qa_me', '/api/me')
      ensure(qaMe.user?.id === userID && qaMe.user?.account_id === accountID, 'recovery_qa_session_mismatch')

      const standalone = await callAPI(state.adminContext.request, baseURL, `/api/whiteboards/${boardID}`)
      ensure(
        standalone.status === 200
          && standalone.data?.whiteboard?.id === boardID
          && standalone.data?.whiteboard?.name === boardName
          && standalone.data?.whiteboard?.origin !== 'work'
          && !standalone.data?.whiteboard?.archived_at,
        'recovery_standalone_mismatch',
      )
      const library = await callAPI(state.qaContextA.request, baseURL, `/api/whiteboard-libraries/${libraryID}`)
      ensure(
        library.status === 200
          && library.data?.library?.id === libraryID
          && library.data?.library?.created_by === userID
          && library.data?.library?.visibility === 'private'
          && !library.data?.library?.archived_at,
        'recovery_library_mismatch',
      )
      const contextual = await callAPI(state.adminContext.request, baseURL, `/api/tasks/location-views/${workViewID}`)
      ensure(
        contextual.status === 200
          && contextual.data?.location_view?.id === workViewID
          && contextual.data?.location_view?.resource?.whiteboard?.id === workBoardID
          && contextual.data?.location_view?.resource?.whiteboard?.name === workBoardName
          && contextual.data?.location_view?.lifecycle === 'active',
        'recovery_work_view_mismatch',
      )
      const policy = await successfulAPI(
        state.adminContext.request,
        baseURL,
        'recovery_trash_policy',
        '/api/whiteboards/trash-policy',
      )
      ensure(Number.isSafeInteger(policy.retention_days) && policy.retention_days >= 7, 'recovery_trash_policy_invalid')
      board.retention_days = policy.retention_days

      for (const sessionID of [adminSession.id, ...runtimeSessionIDsForUser(userID)]) {
        sessionsApprovedForRecovery.add(sessionID)
      }
      state.runtimeSessionIDs = [...sessionsApprovedForRecovery]
      state.createdRuntimeSessionIDs = [...sessionsApprovedForRecovery]
      preflightComplete = true

      await cleanupLiveState({ state, baseURL, board, cleanup, qaUsername, roleName })
      await verifyRuntimeCleanup(state, cleanup)
      ensure(cleanup.board_archived, 'recovery_standalone_not_archived')
      ensure(cleanup.personal_library_archived === true, 'recovery_library_not_archived')
      ensure(cleanup.qa_user_deleted, 'recovery_user_not_deleted')
      ensure(cleanup.qa_role_deleted, 'recovery_role_not_deleted')
      ensure(cleanup.work_views_archived === true, 'recovery_work_view_not_archived')
      ensure(cleanup.runtime_sessions_removed === true, 'recovery_sessions_not_removed')
      ensure(cleanup.runtime_db_verified === true, 'recovery_db_not_verified')
      ensure(cleanup.runtime_redis_verified === true, 'recovery_redis_not_verified')
      process.stdout.write(`${JSON.stringify({
        kind: 'clarin_whiteboards_recovery',
        ok: true,
        cleanup,
      })}\n`)
    } finally {
      await state.qaContextA?.close().catch(() => undefined)
      await state.qaContextB?.close().catch(() => undefined)
      await state.adminContext?.close().catch(() => undefined)
      const sessions = preflightComplete ? sessionsApprovedForRecovery : sessionsCreatedHere
      for (const sessionID of sessions) {
        try {
          removeRuntimeSession(sessionID)
        } catch {
          // The canonical cleanup/readback above remains authoritative. This
          // finalizer only removes exact runtime-harness keys after failures.
        }
      }
    }
  })
})

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
    const workListBoardName = `QA Work Lista · ${createdAt.toISOString()} · ${suffix}`
    const workFolderBoardName = `QA Work Carpeta · ${createdAt.toISOString()} · ${suffix}`
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
      admin_qa_distinct: false,
      independent_qa_sessions: false,
      access_hidden_404: false,
      access_view: false,
      access_comment: false,
      access_edit: false,
      access_realtime_reconciled: false,
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
      work_list_created: false,
      work_folder_created: false,
      work_editor_bootstrap_api: false,
      work_two_sessions_opened: false,
      work_hub_canonical: false,
      work_hub_ui_roundtrip: false,
      work_scene_ui_persisted: false,
      work_ws_fanout_observed: false,
      work_trash_restored: false,
      work_revocation_ws: false,
      work_revocation_denied_and_hidden: false,
    }
    const cleanup: CleanupState = {
      personal_library_archived: null,
      board_archived: false,
      qa_user_deleted: false,
      qa_user_deactivated: false,
      qa_role_deleted: false,
      runtime_sessions_removed: null,
      work_views_archived: null,
      runtime_db_verified: null,
      runtime_redis_verified: null,
      contextual_acl_clean: null,
      contextual_storage_integrity: null,
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
      createdRuntimeSessionIDs: [],
      qaSessionAID: null,
      qaSessionBID: null,
      workViews: [],
      expectedWorkViewNames: [workListBoardName, workFolderBoardName],
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
        state.createdRuntimeSessionIDs.push(session.id)
        state.adminContext = await browser.newContext()
        await installRuntimeSession(state.adminContext, baseURL, session)
        state.adminPage = await state.adminContext.newPage()
        state.adminPage.setDefaultTimeout(20_000)
        state.adminPage.setDefaultNavigationTimeout(45_000)
        const me = await successfulAPI(state.adminContext.request, baseURL, 'runtime_admin_me', '/api/me')
        ensure(me.user?.id === actor.user_id && me.user?.account_id === actor.account_id, 'runtime_admin_session_mismatch')
        adminUser = me.user
      } else {
        const admin = await ensureAdminContext(browser, baseURL, evidence)
        state.adminContext = admin.context
        state.adminPage = admin.page
        state.adminPage.setDefaultTimeout(20_000)
        state.adminPage.setDefaultNavigationTimeout(45_000)
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
            permissions: ['whiteboards', 'tasks'],
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
            editor_version: '0.18.1-clarin.6',
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
      const generalSocketEvidenceA = observeGeneralSocket(state.qaPageA)
      const generalSocketEvidenceB = observeGeneralSocket(state.qaPageB)
      state.qaPageA.setDefaultTimeout(20_000)
      state.qaPageA.setDefaultNavigationTimeout(45_000)
      state.qaPageB.setDefaultTimeout(20_000)
      state.qaPageB.setDefaultNavigationTimeout(45_000)
      if (bootstrap === 'runtime_harness') {
        qaRuntimeActor = runtimeQAActor(state.userID, state.accountID)
        const sessionA = createRuntimeSession(qaRuntimeActor, runtimeSecret)
        const sessionB = createRuntimeSession(qaRuntimeActor, runtimeSecret)
        state.runtimeSessionIDs.push(sessionA.id, sessionB.id)
        state.createdRuntimeSessionIDs.push(sessionA.id, sessionB.id)
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
      ensure(typeof adminUser.id === 'string' && adminUser.id !== state.userID, 'admin_qa_actor_not_distinct')
      checks.admin_qa_distinct = true
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

      phase = 'work_location_discovery'
      const workLocations = await discoverWorkSmokeLocations(state.qaContextA.request, baseURL)
      ensure(state.adminPage, 'admin_page_missing_for_work_ui')
      phase = 'work_list_creation_ui'
      const workListView = await createWorkSmokeViewThroughUI(
        state.adminPage,
        adminContext.request,
        baseURL,
        workLocations,
        'list',
        workListBoardName,
      )
      state.workViews.push(workListView)
      checks.work_list_created = true

      phase = 'work_scene_initial_read'
      const initialWorkScene = await canonicalScene(adminContext.request, baseURL, workListView.boardID)
      ensure(Number.isSafeInteger(initialWorkScene.sequence), 'work_initial_scene_sequence_missing')
      const workListSocketEvidenceA = observeWhiteboardSocket(state.qaPageA, workListView.boardID)
      const workListSocketEvidenceB = observeWhiteboardSocket(state.qaPageB, workListView.boardID)
      phase = 'work_scene_open_qa'
      await openWorkEditor(state.qaPageA, baseURL, workListView.id)
      phase = 'work_scene_wait_socket'
      await waitUntil(
        () => workListSocketEvidenceA.opened > 0
          && workListSocketEvidenceA.roomReady > 0
          && workListSocketEvidenceA.presenceSnapshots > 0,
        'work_qa_socket_not_ready',
        30_000,
      )
      phase = 'work_scene_draw'
      await drawRectangleInEditor(state.adminPage)
      phase = 'work_scene_wait_persist'
      const persistedRectangle = await waitForPersistedRectangle(
        adminContext.request,
        baseURL,
        workListView.boardID,
        Number(initialWorkScene.sequence),
      )
      phase = 'work_scene_wait_fanout'
      await waitUntil(() => workListSocketEvidenceA.scenePatches > 0, 'work_qa_scene_patch_not_received', 30_000)
      checks.work_scene_ui_persisted = true
      checks.work_ws_fanout_observed = true

      phase = 'work_folder_creation_ui'
      await returnToTasks(state.adminPage, baseURL)
      const workFolderView = await createWorkSmokeViewThroughUI(
        state.adminPage,
        adminContext.request,
        baseURL,
        workLocations,
        'folder',
        workFolderBoardName,
      )
      state.workViews.push(workFolderView)
      checks.work_folder_created = true

      phase = 'work_actor_authorization'
      const [qaListRead, qaFolderRead] = await Promise.all([
        callAPI(state.qaContextA.request, baseURL, `/api/tasks/location-views/${workListView.id}`),
        callAPI(state.qaContextB.request, baseURL, `/api/tasks/location-views/${workFolderView.id}`),
      ])
      ensure(qaListRead.status === 200 && qaFolderRead.status === 200, 'work_qa_access_missing')
      ensure(qaListRead.data?.location_view?.capabilities?.can_manage_access === false, 'work_qa_acl_override_visible')
      const [workMetadata, workScene] = await Promise.all([
        callAPI(state.qaContextA.request, baseURL, `/api/whiteboards/${workListView.boardID}`),
        callAPI(state.qaContextA.request, baseURL, `/api/whiteboards/${workListView.boardID}/scene`),
      ])
      ensure(
        workMetadata.status === 200
        && workMetadata.data?.whiteboard?.origin === 'work'
        && workMetadata.data?.whiteboard?.work_location?.task_view_id === workListView.id,
        'work_editor_metadata_bootstrap_failed',
      )
      ensure(
        workScene.status === 200
        && workScene.data?.scene?.board_id === workListView.boardID
        && Array.isArray(workScene.data?.scene?.scene?.elements)
        && workScene.data.scene.scene.elements.some((item: JSONObject) => item.id === persistedRectangle.id && item.isDeleted !== true),
        'work_editor_scene_bootstrap_failed',
      )
      checks.work_editor_bootstrap_api = true

      phase = 'work_two_sessions'
      const workFolderSocketEvidenceB = observeWhiteboardSocket(state.qaPageB, workFolderView.boardID)
      await openWorkEditor(state.qaPageB, baseURL, workFolderView.id)
      await waitUntil(
        () => workFolderSocketEvidenceB.opened > 0
          && workFolderSocketEvidenceB.roomReady > 0
          && workFolderSocketEvidenceB.presenceSnapshots > 0,
        'work_folder_qa_socket_not_ready',
        30_000,
      )
      checks.work_two_sessions_opened = true

      phase = 'work_hub_canonical'
      const workHub = await successfulAPI(
        state.qaContextA.request,
        baseURL,
        'work_hub_read',
        `/api/whiteboards?scope=all&origin=work&q=${encodeURIComponent(workListBoardName)}&limit=50`,
      )
      const hubBoard = (Array.isArray(workHub.whiteboards) ? workHub.whiteboards : [])
        .find((item: JSONObject) => item.id === workListView.boardID)
      ensure(hubBoard?.origin === 'work' && hubBoard?.work_location?.task_view_id === workListView.id, 'work_hub_binding_mismatch')
      phase = 'work_hub_ui_roundtrip'
      await workHubRoundTrip(
        state.qaPageA,
        state.qaContextA.request,
        baseURL,
        workListView,
        persistedRectangle.id as string,
      )
      phase = 'work_hub_return_controls'
      const workTitleInputs = state.qaPageA.locator('input[aria-label="Nombre de la pizarra"]:visible')
      const workTitleCount = await workTitleInputs.count()
      ensure(workTitleCount <= 1, 'work_hub_title_owner_invalid')
      if (workTitleCount === 1) {
        ensure(
          await workTitleInputs.first().evaluate(element => element instanceof HTMLInputElement && element.readOnly),
          'work_hub_title_mutable',
        )
      }
      ensure(await state.qaPageA.getByText('Compartir desde Clarin', { exact: true }).count() === 0, 'work_hub_share_visible')
      checks.work_hub_canonical = true
      checks.work_hub_ui_roundtrip = true

      phase = 'work_trash_restore_ui'
      await trashAndRestoreWorkViewThroughUI(
        state.adminPage,
        adminContext.request,
        baseURL,
        workFolderView,
        workFolderSocketEvidenceB,
      )
      const restoredFolder = await successfulAPI(adminContext.request, baseURL, 'work_folder_restore_readback', `/api/tasks/location-views/${workFolderView.id}`)
      ensure(restoredFolder.location_view?.scope?.scope_id === workLocations.folderID, 'work_folder_restore_mismatch')
      checks.work_trash_restored = true

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
      const standaloneSocketEvidenceA = observeWhiteboardSocket(state.qaPageA, state.boardID)
      const standaloneSocketEvidenceB = observeWhiteboardSocket(state.qaPageB, state.boardID)
      let browserCommentRequests = 0
      const countBrowserCommentRequest = (request: Request) => {
        const pathname = new URL(request.url()).pathname
        if (/\/comment-(?:threads|markers)(?:\/|$)/u.test(pathname)) browserCommentRequests += 1
      }
      state.qaPageA.on('request', countBrowserCommentRequest)
      state.qaPageB.on('request', countBrowserCommentRequest)
      // Keep both sessions alive, but initialize the two heavy Excalidraw
      // runtimes sequentially. This still exercises real concurrent sessions
      // while avoiding a nondeterministic browser-process spike and a race to
      // create the same personal library during smoke bootstrap.
      phase = 'editor_session_a'
      await openEditor(state.qaPageA, baseURL, state.boardID)
      phase = 'editor_session_b'
      await openEditor(state.qaPageB, baseURL, state.boardID)
      phase = 'editor_wait_socket'
      await waitUntil(
        () => standaloneSocketEvidenceA.opened >= 1
          && standaloneSocketEvidenceA.roomReady >= 1
          && standaloneSocketEvidenceA.presenceSnapshots >= 1
          && standaloneSocketEvidenceB.opened >= 1
          && standaloneSocketEvidenceB.roomReady >= 1
          && standaloneSocketEvidenceB.presenceSnapshots >= 1,
        'standalone_sessions_not_ready',
        30_000,
      )
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
      phase = 'access_edit_realtime'
      await waitUntil(
        () => standaloneSocketEvidenceA.permissionChanged >= 1
          && standaloneSocketEvidenceA.permissionAccess === 'edit'
          && standaloneSocketEvidenceB.permissionChanged >= 1
          && standaloneSocketEvidenceB.permissionAccess === 'edit',
        'edit_permission_change_ws_missing',
        30_000,
      )
      ensure(
        standaloneSocketEvidenceA.accessRevoked === 0 && standaloneSocketEvidenceB.accessRevoked === 0,
        'edit_permission_change_disconnected_socket',
      )
      for (const [index, page] of [state.qaPageA, state.qaPageB].entries()) {
        await visible(page.locator('.whiteboard-editor-shell'), `edit_editor_${index + 1}_unmounted`, 30_000)
        await visible(page.locator('canvas.interactive').first(), `edit_canvas_${index + 1}_missing`, 30_000)
        await waitUntil(
          async () => await page.locator('[data-whiteboard-permission-revalidating]').count() === 0
            && await page.getByText('Solo lectura', { exact: true }).count() === 0
            && await page.getByText('Lectura y comentarios', { exact: true }).count() === 0,
          `edit_editor_${index + 1}_not_reconciled`,
          30_000,
        )
        const titleInputs = page.locator('input[aria-label="Nombre de la pizarra"]:visible')
        const titleCount = await titleInputs.count()
        ensure(titleCount <= 1, `edit_editor_${index + 1}_title_owner_invalid`)
        if (titleCount === 1) {
          ensure(
            await titleInputs.first().evaluate(element => element instanceof HTMLInputElement && !element.readOnly),
            `edit_editor_${index + 1}_title_still_readonly`,
          )
        }
      }
      const moreActions = state.qaPageA.locator('button[data-whiteboard-action="more"]:visible')
      await visible(moreActions, 'edit_more_actions_missing')
      await moreActions.click()
      await visible(state.qaPageA.getByRole('menuitem', { name: 'Importar archivo', exact: true }), 'edit_import_capability_missing')
      await state.qaPageA.keyboard.press('Escape')
      checks.access_realtime_reconciled = true
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
              state.createdRuntimeSessionIDs.push(fresh.id)
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

      phase = 'work_revocation_open_same_view'
      const workSocketBaselineA = {
        opened: workListSocketEvidenceA.opened,
        roomReady: workListSocketEvidenceA.roomReady,
        presenceSnapshots: workListSocketEvidenceA.presenceSnapshots,
      }
      const workSocketBaselineB = {
        opened: workListSocketEvidenceB.opened,
        roomReady: workListSocketEvidenceB.roomReady,
        presenceSnapshots: workListSocketEvidenceB.presenceSnapshots,
      }
      await openWorkEditor(state.qaPageA, baseURL, workListView.id)
      await openWorkEditor(state.qaPageB, baseURL, workListView.id)
      await waitUntil(
        () => workListSocketEvidenceA.opened > workSocketBaselineA.opened
          && workListSocketEvidenceA.roomReady > workSocketBaselineA.roomReady
          && workListSocketEvidenceA.presenceSnapshots > workSocketBaselineA.presenceSnapshots
          && workListSocketEvidenceB.opened > workSocketBaselineB.opened
          && workListSocketEvidenceB.roomReady > workSocketBaselineB.roomReady
          && workListSocketEvidenceB.presenceSnapshots > workSocketBaselineB.presenceSnapshots
          && generalSocketEvidenceA.active > 0
          && generalSocketEvidenceB.active > 0,
        'work_revocation_sockets_not_ready',
        30_000,
      )
      const workAccessChangedBaselineA = workListSocketEvidenceA.workAccessChanged
      const workAccessChangedBaselineB = workListSocketEvidenceB.workAccessChanged
      const sessionExpiredBaselineA = workListSocketEvidenceA.sessionExpired
      const sessionExpiredBaselineB = workListSocketEvidenceB.sessionExpired
      const generalClosedBaselineA = generalSocketEvidenceA.closed
      const generalClosedBaselineB = generalSocketEvidenceB.closed
      phase = 'work_revocation_role_update'
      await successfulAPI(
        adminContext.request,
        baseURL,
        'work_role_revoke_tasks',
        `/api/admin/roles/${state.roleID}`,
        {
          method: 'PUT',
          data: {
            name: roleName,
            description: 'Rol temporal smoke Pizarras; tasks revocado para validar Redis/WS antes de eliminar.',
            permissions: ['whiteboards'],
          },
        },
      )
      await waitUntil(
        () => (
          workListSocketEvidenceA.workAccessChanged > workAccessChangedBaselineA
          || workListSocketEvidenceA.sessionExpired > sessionExpiredBaselineA
          || generalSocketEvidenceA.closed > generalClosedBaselineA
        ) && (
          workListSocketEvidenceB.workAccessChanged > workAccessChangedBaselineB
          || workListSocketEvidenceB.sessionExpired > sessionExpiredBaselineB
          || generalSocketEvidenceB.closed > generalClosedBaselineB
        ),
        'work_revocation_ws_terminal_missing',
        45_000,
      )
      const workContentProtected = async (page: Page) => {
        const routeHasWorkView = new URL(page.url()).searchParams.has('work_view')
        const visibleCanvas = await page.locator('canvas.interactive:visible').count()
        const blockedEditor = await page.getByRole('heading', { name: 'No se pudo abrir la pizarra' }).count()
        const loginVisible = await page.locator('input[name="username"]:visible, form[action*="login"]:visible').count()
        return visibleCanvas === 0 && (!routeHasWorkView || blockedEditor > 0 || loginVisible > 0)
      }
      await waitUntil(() => workContentProtected(state.qaPageA!), 'work_revocation_editor_a_exposed', 45_000)
      await waitUntil(() => workContentProtected(state.qaPageB!), 'work_revocation_editor_b_exposed', 45_000)
      checks.work_revocation_ws = true
      await waitUntil(async () => {
        const [staleA, staleB] = await Promise.all([
          callAPI(state.qaContextA!.request, baseURL, `/api/tasks/location-views/${workListView.id}`),
          callAPI(state.qaContextB!.request, baseURL, `/api/tasks/location-views/${workListView.id}`),
        ])
        return staleA.status === 401 && staleB.status === 401
      }, 'work_revocation_sessions_not_invalidated', 30_000)

      await state.qaContextA.close().catch(() => undefined)
      state.qaContextA = await browser.newContext()
      state.qaPageA = await state.qaContextA.newPage()
      state.qaPageA.setDefaultTimeout(20_000)
      state.qaPageA.setDefaultNavigationTimeout(45_000)
      if (bootstrap === 'runtime_harness') {
        const revokedActor = runtimeQAActor(state.userID, state.accountID, false)
        const fresh = createRuntimeSession(revokedActor, runtimeSecret)
        state.runtimeSessionIDs.push(fresh.id)
        state.createdRuntimeSessionIDs.push(fresh.id)
        state.qaSessionAID = fresh.id
        await installRuntimeSession(state.qaContextA, baseURL, fresh)
      } else {
        await loginThroughUI({
          page: state.qaPageA,
          baseURL,
          username: qaUsername,
          password: qaPassword,
          evidence,
        })
      }
      const [revokedLocation, revokedGenericBoard, adminRecovery] = await Promise.all([
        callAPI(state.qaContextA.request, baseURL, `/api/tasks/location-views/${workListView.id}`),
        callAPI(state.qaContextA.request, baseURL, `/api/whiteboards/${workListView.boardID}`),
        callAPI(adminContext.request, baseURL, `/api/tasks/location-views/${workListView.id}`),
      ])
      ensure(revokedLocation.status === 403, `work_revocation_location_${revokedLocation.status}`)
      ensure(
        revokedGenericBoard.status === 404 && revokedGenericBoard.data?.code === 'whiteboard_not_found',
        `work_revocation_generic_${revokedGenericBoard.status}_${String(revokedGenericBoard.data?.code || 'missing_code')}`,
      )
      ensure(adminRecovery.status === 200, 'work_revocation_admin_recovery_missing')
      checks.work_revocation_denied_and_hidden = true
    } catch (error) {
      failureCode = error instanceof SmokeFailure ? error.code : `${phase}_failed`
    } finally {
      phase = 'cleanup'
      await cleanupLiveState({ state, baseURL, board, cleanup, qaUsername, roleName }).catch(() => {
        if (!failureCode) failureCode = 'cleanup_failed'
      })
      if (
        bootstrap === 'runtime_harness'
        && validUUID(state.accountID || '')
        && validUUID(state.userID || '')
        && validUUID(state.roleID || '')
        && state.workViews.length > 0
      ) {
        await verifyRuntimeCleanup(state, cleanup).catch(() => {
          cleanup.runtime_db_verified = false
          cleanup.runtime_redis_verified = false
          if (cleanup.contextual_acl_clean === null) cleanup.contextual_acl_clean = false
          if (cleanup.contextual_storage_integrity === null) cleanup.contextual_storage_integrity = false
          if (!failureCode) failureCode = 'runtime_cleanup_readback_failed'
        })
      }
      clearInterval(phaseHeartbeat)
      if (state.boardID && !cleanup.board_archived && !failureCode) failureCode = 'board_cleanup_incomplete'
      if (state.userID && !cleanup.qa_user_deleted && !failureCode) failureCode = 'qa_user_cleanup_incomplete'
      if (state.roleID && !cleanup.qa_role_deleted && !failureCode) failureCode = 'qa_role_cleanup_incomplete'
      if (state.personalLibraryID && cleanup.personal_library_archived !== true && !failureCode) failureCode = 'personal_library_cleanup_incomplete'
      if (state.workViews.length > 0 && cleanup.work_views_archived !== true && !failureCode) failureCode = 'work_views_cleanup_incomplete'
      if (bootstrap === 'runtime_harness' && cleanup.runtime_sessions_removed === false && !failureCode) failureCode = 'runtime_session_cleanup_incomplete'
      if (bootstrap === 'runtime_harness' && state.workViews.length > 0 && cleanup.runtime_db_verified !== true && !failureCode) failureCode = 'runtime_db_cleanup_unverified'
      if (bootstrap === 'runtime_harness' && state.workViews.length > 0 && cleanup.runtime_redis_verified !== true && !failureCode) failureCode = 'runtime_redis_cleanup_unverified'

      const summary = {
        kind: 'clarin_whiteboards_live_smoke',
        ok: failureCode === null,
        auth_bootstrap: bootstrap,
        login_ui_exercised: evidence.attempts > 0,
        account_exact_match: checks.account_exact_match,
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
