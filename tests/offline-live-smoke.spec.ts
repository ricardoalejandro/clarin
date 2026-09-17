import {
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
} from '@playwright/test'

const liveSmokeEnabled = process.env.CLARIN_E2E_LIVE_OFFLINE === '1'
const productionOrigin = 'https://clarin.naperu.cloud'

type JSONObject = Record<string, any>

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

interface APIResult {
  status: number
  data: JSONObject
}

interface SignedResult extends APIResult {
  body: string
  headers: Record<string, string>
}

class OfflineSmokeFailure extends Error {
  constructor(readonly code: string, detail = '') {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'OfflineSmokeFailure'
  }
}

function ensure(condition: unknown, code: string, detail = ''): asserts condition {
  if (!condition) throw new OfflineSmokeFailure(code, detail)
}

function validUUID(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function normalizedBaseURL() {
  const raw = (process.env.CLARIN_QA_BASE_URL || productionOrigin).trim()
  const parsed = new URL(raw)
  ensure(parsed.protocol === 'https:' && !parsed.username && !parsed.password, 'unsafe_base_url')
  ensure(parsed.pathname === '/' && !parsed.search && !parsed.hash, 'base_url_must_be_origin')
  if (process.env.CLARIN_QA_ALLOW_NON_PRODUCTION !== '1') {
    ensure(parsed.origin === productionOrigin, 'non_production_origin_not_allowed')
  }
  return parsed.origin
}

function runtimeCommand(args: string[], input?: string) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    input,
    maxBuffer: 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  ensure(result.status === 0, 'runtime_command_failed')
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
  ensure(secret.length >= 32, 'runtime_jwt_secret_unavailable')
  return secret
}

function runtimeQueryJSON(query: string): JSONObject {
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
  ensure(Boolean(output), 'runtime_query_empty')
  return JSON.parse(output) as JSONObject
}

function runtimeAdminActor(): RuntimeActor {
  const actor = runtimeQueryJSON(`
    SELECT json_build_object(
      'user_id',u.id::text,
      'account_id',a.id::text,
      'username',u.username,
      'is_admin',TRUE,
      'is_super_admin',TRUE,
      'role',ua.role,
      'permissions',json_build_array('*')
    )::text
    FROM users u
    JOIN user_accounts ua ON ua.user_id=u.id
    JOIN accounts a ON a.id=ua.account_id AND a.is_active
    WHERE u.is_active AND u.is_super_admin
    ORDER BY ua.is_default DESC,ua.created_at,u.id
    LIMIT 1
  `) as unknown as RuntimeActor
  ensure(validUUID(actor.user_id) && validUUID(actor.account_id), 'runtime_admin_ids_invalid')
  ensure(actor.is_super_admin && Boolean(actor.username), 'runtime_admin_invalid')
  return actor
}

function runtimeQAActor(userID: string, accountID: string): RuntimeActor {
  ensure(validUUID(userID) && validUUID(accountID), 'runtime_qa_ids_invalid')
  const actor = runtimeQueryJSON(`
    SELECT json_build_object(
      'user_id',u.id::text,
      'account_id',ua.account_id::text,
      'username',u.username,
      'is_admin',FALSE,
      'is_super_admin',FALSE,
      'role',ua.role,
      'permissions',to_json(COALESCE(r.permissions,ARRAY[]::TEXT[]))
    )::text
    FROM users u
    JOIN user_accounts ua ON ua.user_id=u.id
    LEFT JOIN roles r ON r.id=ua.role_id
    WHERE u.id='${userID}'::uuid AND ua.account_id='${accountID}'::uuid
    LIMIT 1
  `) as unknown as RuntimeActor
  ensure(validUUID(actor.user_id) && actor.account_id === accountID, 'runtime_qa_actor_invalid')
  ensure(!actor.is_super_admin, 'runtime_qa_must_not_be_superadmin')
  for (const permission of ['whiteboards', 'tasks', 'contacts', 'programs']) {
    ensure(actor.permissions.includes(permission), 'runtime_qa_permission_missing', permission)
  }
  return actor
}

function base64URLJSON(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function signRuntimeJWT(actor: RuntimeActor, sessionID: string, secret: string) {
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
  const signature = createHmac('sha256', secret).update(input).digest('base64url')
  return `${input}.${signature}`
}

function createRuntimeSession(actor: RuntimeActor, secret: string): RuntimeSession {
  const sessionID = randomUUID()
  const now = Math.floor(Date.now() / 1000)
  const invalidationMarker = runtimeCommand([
    'exec', 'clarin-redis', 'redis-cli', '--raw', 'GET', `usersessinv:${actor.user_id}`,
  ])
  const record = JSON.stringify({
    user_id: actor.user_id,
    account_id: actor.account_id,
    username: actor.username,
    created_at: now,
    last_seen: now,
    ...(invalidationMarker ? { invalidation_marker: invalidationMarker } : {}),
  })
  const result = runtimeCommand([
    'exec', '-i', 'clarin-redis', 'redis-cli', '-x', 'SETEX', `session:${sessionID}`, '3600',
  ], record)
  ensure(result === 'OK', 'runtime_session_registration_failed')
  return { id: sessionID, token: signRuntimeJWT(actor, sessionID, secret) }
}

function removeRuntimeSession(sessionID: string) {
  if (!validUUID(sessionID)) return
  runtimeCommand(['exec', 'clarin-redis', 'redis-cli', 'DEL', `session:${sessionID}`])
}

async function installRuntimeSession(context: BrowserContext, baseURL: string, session: RuntimeSession) {
  await context.addInitScript(({ origin }) => {
    if (window.location.origin !== origin) return
    const now = String(Date.now())
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

async function callAPI(
  request: APIRequestContext,
  baseURL: string,
  path: string,
  options: { method?: string; data?: unknown } = {},
): Promise<APIResult> {
  const url = new URL(path, baseURL)
  ensure(url.origin === baseURL, 'api_origin_mismatch')
  const response = await request.fetch(url.toString(), {
    method: options.method || 'GET',
    data: options.data,
    failOnStatusCode: false,
  })
  return {
    status: response.status(),
    data: await response.json().catch(() => ({})) as JSONObject,
  }
}

async function successfulAPI(
  request: APIRequestContext,
  baseURL: string,
  code: string,
  path: string,
  options: { method?: string; data?: unknown } = {},
  statuses: readonly number[] = [200],
) {
  const result = await callAPI(request, baseURL, path, options)
  ensure(statuses.includes(result.status), `${code}_${result.status}`, JSON.stringify(result.data))
  ensure(result.data.success !== false, `${code}_rejected`, JSON.stringify(result.data))
  return result.data
}

function sha256Hex(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

class DeviceClient {
  readonly terminalID = randomUUID()
  readonly installInstanceHash = randomBytes(32).toString('hex')
  readonly windowsSIDHash = randomBytes(32).toString('hex')
  readonly bootIDHash = randomBytes(32).toString('hex')
  readonly publicKeyPEM: string
  readonly privateKey: KeyObject
  counter = 0
  active = false
  leaseKeyVersion = 0
  leasePublicKeyPEM = ''

  constructor(readonly displayName: string) {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    this.privateKey = pair.privateKey
    this.publicKeyPEM = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  }

  enrollmentPayload() {
    return {
      success: true,
      state: 'pending',
      terminal_id: this.terminalID,
      display_name: this.displayName,
      public_key_pem: this.publicKeyPEM,
      windows_sid_hash: this.windowsSIDHash,
      install_instance_hash: this.installInstanceHash,
      client_version: '0.3.3',
      device_posture: { bitlocker: 'disabled', windows_hello: 'not_configured' },
    }
  }

  activationPayload(installInstanceHash = this.installInstanceHash) {
    const canonical = `CLARIN-OFFLINE-ACTIVATE\n${this.terminalID}\n${installInstanceHash}`
    return {
      terminal_id: this.terminalID,
      install_instance_hash: installInstanceHash,
      signature: this.signature(canonical),
    }
  }

  private signature(value: string) {
    return cryptoSign('sha256', Buffer.from(value), this.privateKey).toString('base64url')
  }

  async activate(request: APIRequestContext, baseURL: string, approval: JSONObject) {
    ensure(approval.terminal_id === this.terminalID, 'activation_terminal_mismatch')
    ensure(Number.isSafeInteger(approval.lease_key_version), 'activation_lease_key_missing')
    ensure(typeof approval.lease_public_key_pem === 'string', 'activation_lease_public_key_missing')
    const activated = await callAPI(request, baseURL, '/api/offline/v2/activate', {
      method: 'POST',
      data: this.activationPayload(),
    })
    ensure(activated.status === 200 && activated.data.success && activated.data.state === 'active', 'activation_failed', JSON.stringify(activated.data))
    this.leaseKeyVersion = approval.lease_key_version
    this.leasePublicKeyPEM = approval.lease_public_key_pem
    this.active = true
    return { success: true }
  }

  private async challenge(request: APIRequestContext, baseURL: string) {
    const response = await callAPI(request, baseURL, '/api/offline/v2/challenge', {
      method: 'POST', data: { terminal_id: this.terminalID },
    })
    ensure(response.status === 200 && response.data.success, 'challenge_failed', JSON.stringify(response.data))
    ensure(validUUID(response.data.challenge_id) && typeof response.data.nonce === 'string', 'challenge_invalid')
    return response.data
  }

  private proof(path: string, body: string, challenge: JSONObject, counter: number) {
    const canonical = [
      'CLARIN-OFFLINE-V2',
      'POST',
      path,
      this.terminalID,
      challenge.account_id,
      challenge.challenge_id,
      challenge.nonce,
      String(counter),
      'application/json',
      createHash('sha256').update(body).digest('base64url'),
    ].join('\n')
    return {
      'Content-Type': 'application/json',
      'X-Clarin-Challenge-ID': challenge.challenge_id,
      'X-Clarin-Nonce': challenge.nonce,
      'X-Clarin-Counter': String(counter),
      'X-Clarin-Signature': this.signature(canonical),
    }
  }

  async signedRequest(
    request: APIRequestContext,
    baseURL: string,
    accountID: string,
    path: string,
    payload: JSONObject,
    options: { counter?: number; mutateSignature?: boolean } = {},
  ): Promise<SignedResult> {
    const challenge = { ...await this.challenge(request, baseURL), account_id: accountID }
    const body = JSON.stringify(payload)
    const counter = options.counter ?? ++this.counter
    const headers = this.proof(path, body, challenge, counter)
    if (options.mutateSignature) {
      headers['X-Clarin-Signature'] = `${headers['X-Clarin-Signature'].slice(0, -2)}aa`
    }
    const response = await request.fetch(new URL(path, baseURL).toString(), {
      method: 'POST',
      data: body,
      headers,
      failOnStatusCode: false,
    })
    return {
      status: response.status(),
      data: await response.json().catch(() => ({})) as JSONObject,
      body,
      headers,
    }
  }

  syncPayload(accountID: string, inventory: JSONObject[] = [], operations: JSONObject[] = []) {
    return {
      terminal_id: this.terminalID,
      account_id: accountID,
      install_instance_hash: this.installInstanceHash,
      boot_id_hash: this.bootIDHash,
      client_version: '0.3.3',
      used_storage_bytes: 128 * 1024,
      inventory,
      operations,
      device_posture: { bitlocker: 'disabled', windows_hello: 'not_configured' },
    }
  }

  verifyEnvelope(envelope: JSONObject) {
    ensure(envelope.key_version === this.leaseKeyVersion, 'signed_envelope_version_mismatch')
    const parts = String(envelope.signature || '').split(':')
    ensure(parts.length === 3 && parts[0] === 'clarin' && parts[1] === `v${this.leaseKeyVersion}`, 'signed_envelope_format_invalid')
    const payload = Buffer.from(String(envelope.payload), 'base64url')
    ensure(cryptoVerify('sha256', payload, this.leasePublicKeyPEM, Buffer.from(parts[2], 'base64')), 'signed_envelope_signature_invalid')
    return JSON.parse(payload.toString('utf8')) as JSONObject
  }

  verifyControl(control: JSONObject) {
    const claims = this.verifyEnvelope({
      payload: control.payload,
      signature: control.signature,
      key_version: control.signer_key_version,
    })
    ensure(claims.directive_id === control.id && claims.terminal_id === this.terminalID, 'control_identity_mismatch')
    ensure(claims.directive_type === 'wipe' && control.directive_type === 'wipe', 'control_type_mismatch')
    return claims
  }
}

test.describe('Clarin offline v2 live journey', () => {
  test.skip(!liveSmokeEnabled, 'Set CLARIN_E2E_LIVE_OFFLINE=1 to run the destructive isolated live smoke.')
  test.describe.configure({ mode: 'serial' })

  test('request, approve, activate, select, sync, reconnect, conflict, revoke and wipe', async ({ browser }) => {
    test.setTimeout(8 * 60 * 1000)

    const baseURL = normalizedBaseURL()
    const suffix = `${Date.now()}-${randomBytes(3).toString('hex')}`
    const accountName = `QA Offline ${suffix}`
    const accountSlug = `qa-offline-${suffix}`.toLowerCase()
    const roleName = `QA Offline ${suffix}`
    const username = `qa_offline_${suffix.replaceAll('-', '_')}`
    const password = `Qa!${randomBytes(18).toString('base64url')}7z`
    const terminalName = `QA-OFFLINE-${suffix}`
    const contactName = `Contacto Offline ${suffix}`
    const programName = `Programa Offline ${suffix}`
    const boardName = `Pizarra Offline ${suffix}`
    const listName = `Lista Offline ${suffix}`
    const taskName = `Tarea creada offline ${suffix}`
    const device = new DeviceClient(terminalName)
    const rejectedDevice = new DeviceClient(`${terminalName}-REJECTED`)
    const secret = runtimeJWTSecret()
    const rootActor = runtimeAdminActor()
    const sessions: string[] = []
    let cleanupContext: BrowserContext | null = null
    let accountID = ''
    let roleID = ''
    let userID = ''
    let primaryFailure: unknown = null

    try {
      const bootstrapSession = createRuntimeSession(rootActor, secret)
      sessions.push(bootstrapSession.id)
      const bootstrapContext = await browser.newContext()
      await installRuntimeSession(bootstrapContext, baseURL, bootstrapSession)

      const createdAccount = await successfulAPI(
        bootstrapContext.request,
        baseURL,
        'account_create',
        '/api/admin/accounts',
        { method: 'POST', data: { name: accountName, slug: accountSlug, plan: 'basic', max_devices: 2 } },
        [201],
      )
      ensure(validUUID(createdAccount.account?.id), 'account_id_missing')
      accountID = createdAccount.account.id

      await successfulAPI(
        bootstrapContext.request,
        baseURL,
        'admin_membership_create',
        `/api/admin/users/${rootActor.user_id}/accounts`,
        { method: 'POST', data: { account_id: accountID, role: 'super_admin', is_default: false } },
      )
      await bootstrapContext.close()

      const cleanupSession = createRuntimeSession(rootActor, secret)
      sessions.push(cleanupSession.id)
      cleanupContext = await browser.newContext()
      await installRuntimeSession(cleanupContext, baseURL, cleanupSession)

      const scopedAdmin = { ...rootActor, account_id: accountID }
      const adminSession = createRuntimeSession(scopedAdmin, secret)
      sessions.push(adminSession.id)
      const adminContext = await browser.newContext()
      await installRuntimeSession(adminContext, baseURL, adminSession)

      const createdRole = await successfulAPI(
        adminContext.request,
        baseURL,
        'role_create',
        '/api/admin/roles',
        {
          method: 'POST',
          data: {
            name: roleName,
            description: 'Rol temporal para el flujo offline vivo.',
            permissions: ['whiteboards', 'tasks', 'contacts', 'programs'],
          },
        },
        [201],
      )
      ensure(validUUID(createdRole.role?.id), 'role_id_missing')
      roleID = createdRole.role.id

      const createdUser = await successfulAPI(
        adminContext.request,
        baseURL,
        'user_create',
        '/api/admin/users',
        {
          method: 'POST',
          data: {
            username,
            email: `${username}@users.clarin.local`,
            password,
            password_confirm: password,
            display_name: `QA Offline ${suffix}`,
            accounts: [{ account_id: accountID, role: 'agent', role_id: roleID, is_default: true }],
          },
        },
        [201],
      )
      ensure(validUUID(createdUser.user?.id), 'user_id_missing')
      userID = createdUser.user.id

      const qaActor = runtimeQAActor(userID, accountID)
      const qaSession = createRuntimeSession(qaActor, secret)
      sessions.push(qaSession.id)
      const qaContext = await browser.newContext()
      await installRuntimeSession(qaContext, baseURL, qaSession)

      const forbiddenAdminList = await callAPI(qaContext.request, baseURL, '/api/admin/offline-terminals/')
      ensure(forbiddenAdminList.status === 403, 'non_superadmin_terminal_admin_not_blocked')

      const rejectedEnrollment = await callAPI(qaContext.request, baseURL, '/api/offline/v2/enrollment-requests', {
        method: 'POST', data: rejectedDevice.enrollmentPayload(),
      })
      ensure(rejectedEnrollment.status === 201 && rejectedEnrollment.data.state === 'requested', 'rejection_fixture_request_failed', JSON.stringify(rejectedEnrollment.data))
      const rejectedDecision = await callAPI(adminContext.request, baseURL, `/api/admin/offline-terminals/${rejectedDevice.terminalID}/reject`, { method: 'POST' })
      ensure(rejectedDecision.status === 200 && rejectedDecision.data.state === 'rejected', 'terminal_rejection_failed', JSON.stringify(rejectedDecision.data))
      const rejectedStatus = await successfulAPI(qaContext.request, baseURL, 'rejected_enrollment_status', `/api/offline/v2/enrollment-requests/${rejectedDevice.terminalID}`)
      ensure(rejectedStatus.state === 'rejected', 'terminal_rejection_not_visible_to_user')
      const rejectedActivation = await callAPI(qaContext.request, baseURL, '/api/offline/v2/activate', {
        method: 'POST', data: rejectedDevice.activationPayload(),
      })
      ensure(rejectedActivation.status === 409, 'rejected_terminal_activation_not_blocked')
      const repeatedRejection = await callAPI(adminContext.request, baseURL, `/api/admin/offline-terminals/${rejectedDevice.terminalID}/reject`, { method: 'POST' })
      ensure(repeatedRejection.status === 409, 'repeated_terminal_rejection_not_conflicted')

      const createdContact = await successfulAPI(
        qaContext.request,
        baseURL,
        'contact_create',
        '/api/contacts',
        { method: 'POST', data: { name: contactName, notes: 'Recurso temporal del smoke offline.' } },
        [201],
      )
      ensure(validUUID(createdContact.contact?.id), 'contact_id_missing')
      const contactID = createdContact.contact.id

      const createdProgram = await successfulAPI(
        qaContext.request,
        baseURL,
        'program_create',
        '/api/programs',
        { method: 'POST', data: { name: programName, description: 'Recurso temporal del smoke offline.', color: '#10B981', type: 'course', schedule_days: [] } },
        [200, 201],
      )
      ensure(validUUID(createdProgram.id), 'program_id_missing')
      const programID = createdProgram.id

      const createdBoard = await successfulAPI(
        qaContext.request,
        baseURL,
        'whiteboard_create',
        '/api/whiteboards',
        {
          method: 'POST',
          data: {
            name: boardName,
            description: 'Recurso temporal del smoke offline.',
            folder_id: null,
            scene: { type: 'excalidraw', version: 2, source: 'clarin', elements: [], appState: {}, files: {} },
            scene_schema_version: 'excalidraw',
            editor_version: '0.18.1-clarin.6',
            access_mode: 'private',
            operation_id: randomUUID(),
          },
        },
        [201],
      )
      ensure(validUUID(createdBoard.whiteboard?.id), 'whiteboard_id_missing')
      const boardID = createdBoard.whiteboard.id

      const environments = await successfulAPI(qaContext.request, baseURL, 'task_environments', '/api/tasks/environments?limit=50')
      const environment = (environments.environments || []).find((item: JSONObject) => item?.archived_at == null)
      ensure(validUUID(environment?.id), 'task_environment_missing')
      const createdList = await successfulAPI(
        qaContext.request,
        baseURL,
        'task_list_create',
        '/api/tasks/lists',
        { method: 'POST', data: { environment_id: environment.id, name: listName, description: 'Recurso temporal del smoke offline.', color: '#10B981', icon: 'list' } },
      )
      ensure(validUUID(createdList.list?.id), 'task_list_id_missing')
      const listID = createdList.list.id

      const originalList = runtimeQueryJSON(`
        SELECT json_build_object('id',id::text)::text
        FROM task_lists
        WHERE account_id='${rootActor.account_id}'::uuid AND archived_at IS NULL AND deleted_at IS NULL
        ORDER BY is_default DESC,id
        LIMIT 1
      `)
      ensure(validUUID(originalList.id), 'cross_account_fixture_missing')

      await qaContext.exposeFunction('__clarinQaOfflineActivate', async (approval: JSONObject) => (
        device.activate(qaContext.request, baseURL, approval)
      ))
      await qaContext.exposeFunction('__clarinQaOfflineBootstrap', async () => (
        device.active
          ? { state: 'enrolled', terminal_id: device.terminalID }
          : { state: 'not_enrolled' }
      ))
      await qaContext.addInitScript((payload) => {
        const qaWindow = window as typeof window & {
          __clarinQaOfflineActivate: (approval: Record<string, unknown>) => Promise<{ success: boolean }>
          __clarinQaOfflineBootstrap: () => Promise<{ state: string; terminal_id?: string }>
          clarinDesktop?: Record<string, unknown>
        }
        qaWindow.clarinDesktop = {
          bootstrapStatus: () => qaWindow.__clarinQaOfflineBootstrap(),
          prepareEnrollment: async () => payload,
          completeEnrollment: (approval: Record<string, unknown>) => qaWindow.__clarinQaOfflineActivate(approval),
        }
      }, device.enrollmentPayload())

      const userPage = await qaContext.newPage()
      userPage.setDefaultTimeout(25_000)
      await userPage.goto(`${baseURL}/dashboard/settings?tab=offline`, { waitUntil: 'domcontentloaded' })
      await expect(userPage.getByRole('button', { name: 'Solicitar acceso offline' })).toBeVisible()

      const invalidClientRequest = await callAPI(qaContext.request, baseURL, '/api/offline/v2/enrollment-requests', {
        method: 'POST',
        data: { ...device.enrollmentPayload(), terminal_id: randomUUID(), client_version: '0.1.0' },
      })
      ensure(invalidClientRequest.status === 400, 'outdated_client_enrollment_not_rejected')

      await userPage.getByRole('button', { name: 'Solicitar acceso offline' }).click()
      await expect(userPage.getByRole('button', { name: 'Esperando aprobación' })).toBeVisible()

      const idempotentRequest = await callAPI(qaContext.request, baseURL, '/api/offline/v2/enrollment-requests', {
        method: 'POST', data: device.enrollmentPayload(),
      })
      ensure(idempotentRequest.status === 200 && idempotentRequest.data.idempotent === true && idempotentRequest.data.state === 'requested', 'enrollment_request_not_idempotent', JSON.stringify(idempotentRequest.data))

      const identityCollision = await callAPI(qaContext.request, baseURL, '/api/offline/v2/enrollment-requests', {
        method: 'POST', data: { ...device.enrollmentPayload(), install_instance_hash: randomBytes(32).toString('hex') },
      })
      ensure(identityCollision.status === 409, 'terminal_identity_collision_not_rejected')

      const activationBeforeApproval = await callAPI(qaContext.request, baseURL, '/api/offline/v2/activate', {
        method: 'POST', data: device.activationPayload(),
      })
      ensure(activationBeforeApproval.status === 409, 'activation_before_approval_not_rejected')

      const terminalBeforeApproval = await successfulAPI(adminContext.request, baseURL, 'terminal_list_requested', '/api/admin/offline-terminals/')
      const requestedTerminal = (terminalBeforeApproval.terminals || []).find((item: JSONObject) => item.id === device.terminalID)
      ensure(requestedTerminal?.state === 'requested', 'terminal_not_requested')
      ensure(requestedTerminal.user_id === userID, 'terminal_user_mismatch')
      ensure(requestedTerminal.bitlocker_status === 'disabled' && requestedTerminal.windows_hello_status === 'not_configured', 'terminal_posture_mismatch')

      const approvalWithoutRisk = await callAPI(adminContext.request, baseURL, `/api/admin/offline-terminals/${device.terminalID}/approve`, {
        method: 'POST',
        data: { acknowledge_device_risk: false, grants: [{ account_id: accountID, modules: ['whiteboards', 'tasks', 'contacts', 'programs'], resources: [] }] },
      })
      ensure(approvalWithoutRisk.status === 400, 'device_risk_acknowledgement_not_enforced')

      const crossAccountApproval = await callAPI(adminContext.request, baseURL, `/api/admin/offline-terminals/${device.terminalID}/approve`, {
        method: 'POST',
        data: { acknowledge_device_risk: true, grants: [{ account_id: rootActor.account_id, modules: ['tasks'], resources: [] }] },
      })
      ensure(crossAccountApproval.status === 400, 'cross_account_offline_grant_not_rejected')

      const stillRequested = await successfulAPI(qaContext.request, baseURL, 'enrollment_still_requested', `/api/offline/v2/enrollment-requests/${device.terminalID}`)
      ensure(stillRequested.state === 'requested', 'failed_approval_changed_terminal_state')

      const crossAccountSelection = await callAPI(qaContext.request, baseURL, `/api/offline/v2/grants/${randomUUID()}/selections`, {
        method: 'PUT',
        data: { selections: [{ module: 'tasks', resource_type: 'task_list', resource_id: originalList.id }] },
      })
      ensure(crossAccountSelection.status === 404, 'unknown_grant_must_be_hidden')

      const adminPage = await adminContext.newPage()
      adminPage.setDefaultTimeout(30_000)
      const adminPageErrors: string[] = []
      adminPage.on('pageerror', error => adminPageErrors.push(error.stack || error.message))
      adminPage.on('console', message => {
        if (message.type() === 'error') adminPageErrors.push(message.text())
      })
      await adminPage.goto(`${baseURL}/dashboard/admin`, { waitUntil: 'domcontentloaded' })
      await adminPage.getByRole('button', { name: 'Offline', exact: true }).click()
      await adminPage.getByText(terminalName, { exact: true }).waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {
        throw new OfflineSmokeFailure('admin_offline_terminal_not_visible', adminPageErrors.slice(-4).join(' | '))
      })
      const terminalRow = adminPage.locator('div').filter({ has: adminPage.getByText(terminalName, { exact: true }) }).filter({ has: adminPage.getByRole('button', { name: 'Revisar y aprobar' }) }).last()
      await terminalRow.getByRole('button', { name: 'Revisar y aprobar' }).click()
      const approvalDialog = adminPage.getByRole('dialog', { name: 'Aprobar acceso offline' })
      await expect(approvalDialog).toBeVisible()
      await approvalDialog.getByRole('checkbox').check()
      await approvalDialog.getByRole('button', { name: 'Aprobar terminal' }).click()
      await expect(approvalDialog).toBeHidden()

      await expect(userPage.getByRole('button', { name: 'Equipo autorizado' })).toBeVisible({ timeout: 30_000 })
      await expect(userPage.getByText('Tú decides qué datos estarán disponibles')).toBeVisible({ timeout: 30_000 })

      const grantsPayload = await successfulAPI(qaContext.request, baseURL, 'user_grants', '/api/offline/v2/grants')
      ensure(grantsPayload.grants?.length === 1, 'active_grant_missing')
      const grant = grantsPayload.grants[0]
      ensure(grant.account_id === accountID && grant.terminal_id === device.terminalID, 'active_grant_identity_mismatch')
      ensure(['contacts', 'programs', 'tasks', 'whiteboards'].every(module => grant.modules.includes(module)), 'active_grant_modules_missing')

      ensure(grantsPayload.installer_available === true && /^[a-f0-9]{64}$/.test(grantsPayload.installer_sha256), 'installer_metadata_invalid')
      const installerResponse = await qaContext.request.get(new URL(`/api/offline/v2/installer?sha256=${grantsPayload.installer_sha256}`, baseURL).toString(), { failOnStatusCode: false })
      ensure(installerResponse.status() === 200, 'installer_download_failed', String(installerResponse.status()))
      const installerBytes = await installerResponse.body()
      ensure(installerBytes.length > 50 * 1024 * 1024, 'installer_download_truncated', String(installerBytes.length))
      const installerDigest = createHash('sha256').update(installerBytes).digest('hex')
      ensure(installerDigest === grantsPayload.installer_sha256, 'installer_sha256_mismatch', JSON.stringify({ expected: grantsPayload.installer_sha256, actual: installerDigest, bytes: installerBytes.length }))
      ensure(installerResponse.headers()['x-clarin-sha256'] === installerDigest, 'installer_checksum_header_mismatch')
      ensure(installerResponse.headers()['content-encoding'] === 'identity', 'installer_was_transformed')
      ensure((installerResponse.headers()['cache-control'] || '').includes('no-transform'), 'installer_cache_policy_incomplete')

      const rejectedCrossAccount = await callAPI(qaContext.request, baseURL, `/api/offline/v2/grants/${grant.id}/selections`, {
        method: 'PUT',
        data: { selections: [{ module: 'tasks', resource_type: 'task_list', resource_id: originalList.id }] },
      })
      ensure(rejectedCrossAccount.status === 400, 'cross_account_selection_not_rejected')

      const resources = [
        { module: 'whiteboards', button: 'Pizarra', name: boardName },
        { module: 'tasks', button: 'Tareas', name: listName },
        { module: 'contacts', button: 'Contactos', name: contactName },
        { module: 'programs', button: 'Programas', name: programName },
      ]
      for (let index = 0; index < resources.length; index += 1) {
        const resource = resources[index]
        await userPage.getByRole('button', { name: new RegExp(`^${resource.button}\\d+$`) }).click()
        const search = userPage.getByPlaceholder(`Buscar en ${resource.button}…`)
        await search.fill(resource.name)
        const candidate = userPage.getByRole('button', { name: new RegExp(resource.name) })
        await expect(candidate).toBeVisible({ timeout: 15_000 })
        await candidate.click()
        await expect.poll(async () => {
          const canonical = await callAPI(qaContext.request, baseURL, `/api/offline/v2/grants/${grant.id}/selections`)
          return Array.isArray(canonical.data.selections) ? canonical.data.selections.length : -1
        }, { timeout: 15_000, message: `selection ${resource.module} was not persisted canonically` }).toBe(index + 1)
        await userPage.getByText(`Seleccionados · ${index + 1}/20`).waitFor({ state: 'visible', timeout: 15_000 }).catch(async () => {
          const canonical = await callAPI(qaContext.request, baseURL, `/api/offline/v2/grants/${grant.id}/selections`)
          const alerts = await userPage.getByRole('alert').allTextContents().catch(() => [])
          throw new OfflineSmokeFailure('selection_ui_not_reconciled', JSON.stringify({ module: resource.module, expected: index + 1, canonical: canonical.data, alerts }))
        })
      }

      const selectionsPayload = await successfulAPI(qaContext.request, baseURL, 'selections_readback', `/api/offline/v2/grants/${grant.id}/selections`)
      ensure(selectionsPayload.selections?.length === 4, 'selection_count_mismatch', JSON.stringify(selectionsPayload))
      const selections = selectionsPayload.selections as JSONObject[]
      const selectionByModule = new Map(selections.map(item => [item.module, item]))
      ensure(selectionByModule.get('whiteboards')?.resource_id === boardID, 'whiteboard_selection_mismatch')
      ensure(selectionByModule.get('tasks')?.resource_id === listID, 'task_selection_mismatch')
      ensure(selectionByModule.get('contacts')?.resource_id === contactID, 'contact_selection_mismatch')
      ensure(selectionByModule.get('programs')?.resource_id === programID, 'program_selection_mismatch')

      const unsignedSync = await callAPI(qaContext.request, baseURL, '/api/offline/v2/sync', {
        method: 'POST', data: device.syncPayload(accountID),
      })
      ensure(unsignedSync.status === 401, 'unsigned_sync_not_rejected')

      const badSignature = await device.signedRequest(
        qaContext.request,
        baseURL,
        accountID,
        '/api/offline/v2/sync',
        device.syncPayload(accountID),
        { mutateSignature: true },
      )
      ensure(badSignature.status === 401, 'bad_signature_not_rejected')

      const firstSync = await device.signedRequest(
        qaContext.request,
        baseURL,
        accountID,
        '/api/offline/v2/sync',
        device.syncPayload(accountID),
      )
      ensure(firstSync.status === 200 && firstSync.data.success && firstSync.data.terminal_state === 'active', 'first_sync_failed', JSON.stringify(firstSync.data))
      ensure(firstSync.data.inventory?.length === 4 && firstSync.data.fetch_required?.length === 4, 'first_sync_inventory_invalid')
      const lease = device.verifyEnvelope(firstSync.data.lease)
      ensure(lease.terminal_id === device.terminalID && lease.user_id === userID && lease.account_id === accountID, 'lease_identity_mismatch')
      ensure(lease.boot_id_hash === device.bootIDHash, 'lease_boot_mismatch')
      ensure(Date.parse(lease.expires_at) - Date.parse(lease.issued_at) <= 24 * 60 * 60 * 1000, 'lease_lifetime_exceeded')
      ensure(lease.max_storage_bytes === 5 * 1024 * 1024 * 1024, 'lease_storage_policy_mismatch')

      const tamperedBodyResponse = await qaContext.request.fetch(new URL('/api/offline/v2/sync', baseURL).toString(), {
        method: 'POST', data: `${firstSync.body} `, headers: firstSync.headers, failOnStatusCode: false,
      })
      ensure(tamperedBodyResponse.status() === 401, 'signed_body_tampering_not_rejected')

      const exactReplayResponse = await qaContext.request.fetch(new URL('/api/offline/v2/sync', baseURL).toString(), {
        method: 'POST', data: firstSync.body, headers: firstSync.headers, failOnStatusCode: false,
      })
      ensure(exactReplayResponse.status() === 409, 'exact_signed_replay_not_rejected', String(exactReplayResponse.status()))

      const wrongInstallation = await device.signedRequest(
        qaContext.request,
        baseURL,
        accountID,
        '/api/offline/v2/sync',
        { ...device.syncPayload(accountID), install_instance_hash: randomBytes(32).toString('hex') },
      )
      ensure(wrongInstallation.status === 401, 'wrong_installation_identity_not_rejected')

      const fetchResponse = await device.signedRequest(
        qaContext.request,
        baseURL,
        accountID,
        '/api/offline/v2/resources/fetch',
        {
          terminal_id: device.terminalID,
          account_id: accountID,
          install_instance_hash: device.installInstanceHash,
          selection_ids: firstSync.data.fetch_required,
        },
      )
      ensure(fetchResponse.status === 200 && fetchResponse.data.snapshots?.length === 4, 'resource_fetch_failed', JSON.stringify(fetchResponse.data))
      const snapshotModules = new Set((fetchResponse.data.snapshots as JSONObject[]).map(item => item.module))
      ensure(['whiteboards', 'tasks', 'contacts', 'programs'].every(module => snapshotModules.has(module)), 'snapshot_modules_missing')
      for (const snapshot of fetchResponse.data.snapshots as JSONObject[]) {
        ensure(typeof snapshot.content_hash === 'string' && snapshot.content_hash.length === 64, 'snapshot_hash_invalid')
        ensure(snapshot.payload && snapshot.tombstone !== true, 'snapshot_payload_missing')
        ensure(sha256Hex(JSON.stringify(snapshot.payload)) === snapshot.content_hash, 'snapshot_content_hash_mismatch', JSON.stringify({ module: snapshot.module, expected: snapshot.content_hash, actual: sha256Hex(JSON.stringify(snapshot.payload)) }))
      }

      const clientInventory = (fetchResponse.data.snapshots as JSONObject[]).map(snapshot => ({
        selection_id: snapshot.selection_id,
        head_version: snapshot.version,
        content_hash: snapshot.content_hash,
      }))

      const prohibitedContactOperation = {
        operation_id: randomUUID(), selection_id: selectionByModule.get('contacts')!.id, module: 'contacts', resource_type: 'contact', resource_id: contactID,
        operation_type: 'contact.update_identity', base_version: 1, patch: { name: `${contactName} alterado` }, client_occurred_at: new Date().toISOString(),
      }
      const prohibitedWrites = [
        prohibitedContactOperation,
        {
          operation_id: randomUUID(), selection_id: selectionByModule.get('whiteboards')!.id, module: 'whiteboards', resource_type: 'whiteboard', resource_id: boardID,
          operation_type: 'whiteboard.update_scene', base_version: 0, patch: { scene: { type: 'excalidraw', version: 2, elements: [] } }, client_occurred_at: new Date().toISOString(),
        },
        {
          operation_id: randomUUID(), selection_id: selectionByModule.get('programs')!.id, module: 'programs', resource_type: 'program', resource_id: programID,
          operation_type: 'program.set_attendance', base_version: 1, patch: { status: 'present' }, client_occurred_at: new Date().toISOString(),
        },
      ]
      const dependentTaskID = randomUUID()
      prohibitedWrites.push({
        operation_id: randomUUID(), selection_id: selectionByModule.get('tasks')!.id, module: 'tasks', resource_type: 'task', resource_id: dependentTaskID,
        operation_type: 'task.create', base_version: 0, patch: { title: `${taskName} dependiente` }, client_occurred_at: new Date().toISOString(), depends_on: [prohibitedContactOperation.operation_id],
      } as any)
      const prohibitedWriteSync = await device.signedRequest(
        qaContext.request,
        baseURL,
        accountID,
        '/api/offline/v2/sync',
        device.syncPayload(accountID, clientInventory, prohibitedWrites),
      )
      ensure(prohibitedWriteSync.status === 200, 'prohibited_write_sync_failed', JSON.stringify(prohibitedWriteSync.data))
      const prohibitedReceipts = new Map((prohibitedWriteSync.data.operation_results || []).map((item: JSONObject) => [item.operation_id, item]))
      for (const operation of prohibitedWrites.slice(0, 3)) {
        const receipt = prohibitedReceipts.get(operation.operation_id) as JSONObject | undefined
        ensure(receipt?.status === 'rejected' && receipt.error_code === 'module_write_disabled', 'read_only_module_write_not_rejected', JSON.stringify(receipt))
      }
      const dependentReceipt = prohibitedReceipts.get(prohibitedWrites[3].operation_id) as JSONObject | undefined
      ensure(dependentReceipt?.status === 'dependency_failed' && dependentReceipt.error_code === 'dependency_failed', 'failed_dependency_did_not_block_write', JSON.stringify(dependentReceipt))
      const absentDependentTask = await callAPI(qaContext.request, baseURL, `/api/tasks/${dependentTaskID}`)
      ensure(absentDependentTask.status === 404, 'dependency_failed_task_was_created')

      const offlineTaskID = randomUUID()
      const createOperation = {
        operation_id: randomUUID(),
        selection_id: selectionByModule.get('tasks')!.id,
        module: 'tasks',
        resource_type: 'task',
        resource_id: offlineTaskID,
        operation_type: 'task.create',
        base_version: 0,
        patch: { title: taskName, description: 'Creada sin conexión y enviada al reconectar.', priority: 'medium' },
        client_occurred_at: new Date().toISOString(),
      }

      // Offline phase: the mutation exists only in the local outbox. The first
      // server request after it is queued is the reconnect sync below.
      const localOutbox = [createOperation]
      ensure(localOutbox.length === 1, 'offline_outbox_not_queued')

      const reconnectSync = await device.signedRequest(
        qaContext.request,
        baseURL,
        accountID,
        '/api/offline/v2/sync',
        device.syncPayload(accountID, clientInventory, localOutbox),
      )
      ensure(reconnectSync.status === 200, 'reconnect_sync_failed', JSON.stringify(reconnectSync.data))
      const createResult = reconnectSync.data.operation_results?.find((item: JSONObject) => item.operation_id === createOperation.operation_id)
      ensure(createResult?.status === 'applied' && createResult.server_version >= 1, 'offline_task_create_not_applied', JSON.stringify(createResult))
      ensure(reconnectSync.data.fetch_required?.includes(selectionByModule.get('tasks')!.id), 'task_snapshot_not_invalidated_after_create')

      const createdTask = await successfulAPI(qaContext.request, baseURL, 'offline_task_readback', `/api/tasks/${offlineTaskID}`)
      ensure(createdTask.task?.title === taskName && createdTask.task?.list_id === listID, 'offline_task_readback_mismatch')

      const replayResult = await device.signedRequest(
        qaContext.request,
        baseURL,
        accountID,
        '/api/offline/v2/sync',
        device.syncPayload(accountID, clientInventory, [createOperation]),
      )
      ensure(replayResult.status === 200, 'idempotent_replay_failed')
      const replayReceipt = replayResult.data.operation_results?.find((item: JSONObject) => item.operation_id === createOperation.operation_id)
      ensure(replayReceipt?.status === 'applied' && replayReceipt.server_version === createResult.server_version, 'idempotent_receipt_changed')

      const reusedOperation = { ...createOperation, patch: { ...createOperation.patch, title: `${taskName} alterada` } }
      const reuseResult = await device.signedRequest(
        qaContext.request,
        baseURL,
        accountID,
        '/api/offline/v2/sync',
        device.syncPayload(accountID, clientInventory, [reusedOperation]),
      )
      ensure(reuseResult.status === 409, 'operation_id_reuse_not_rejected')

      const completeOperation = {
        operation_id: randomUUID(),
        selection_id: selectionByModule.get('tasks')!.id,
        module: 'tasks',
        resource_type: 'task',
        resource_id: offlineTaskID,
        operation_type: 'task.complete',
        base_version: createResult.server_version,
        patch: {},
        client_occurred_at: new Date().toISOString(),
      }
      const completeSync = await device.signedRequest(
        qaContext.request,
        baseURL,
        accountID,
        '/api/offline/v2/sync',
        device.syncPayload(accountID, clientInventory, [completeOperation]),
      )
      ensure(completeSync.status === 200, 'offline_task_complete_sync_failed', JSON.stringify(completeSync.data))
      const completeResult = completeSync.data.operation_results?.find((item: JSONObject) => item.operation_id === completeOperation.operation_id)
      ensure(completeResult?.status === 'applied' && completeResult.server_version > createResult.server_version, 'offline_task_complete_not_applied')
      const completedTask = await successfulAPI(qaContext.request, baseURL, 'offline_task_complete_readback', `/api/tasks/${offlineTaskID}`)
      ensure(completedTask.task?.status === 'completed' && completedTask.task?.progress === 100, 'offline_task_not_completed', JSON.stringify({ status: completedTask.task?.status, status_detail: completedTask.task?.status_detail, progress: completedTask.task?.progress, manual_progress: completedTask.task?.manual_progress, version: completedTask.task?.version }))

      const conflictOperation = {
        operation_id: randomUUID(),
        selection_id: selectionByModule.get('tasks')!.id,
        module: 'tasks',
        resource_type: 'task',
        resource_id: offlineTaskID,
        operation_type: 'task.update_simple',
        base_version: createResult.server_version,
        patch: { title: `${taskName} conflicto` },
        client_occurred_at: new Date().toISOString(),
      }
      const conflictSync = await device.signedRequest(
        qaContext.request,
        baseURL,
        accountID,
        '/api/offline/v2/sync',
        device.syncPayload(accountID, clientInventory, [conflictOperation]),
      )
      ensure(conflictSync.status === 200, 'conflict_sync_failed')
      const conflictResult = conflictSync.data.operation_results?.find((item: JSONObject) => item.operation_id === conflictOperation.operation_id)
      ensure(conflictResult?.status === 'conflict' && validUUID(conflictResult.conflict_id), 'conflict_not_created')

      await userPage.reload({ waitUntil: 'domcontentloaded' })
      await expect(userPage.getByText('Cambios offline que necesitan decisión')).toBeVisible({ timeout: 20_000 })
      await userPage.getByRole('button', { name: 'Conservar servidor' }).click()
      await expect(userPage.getByText('Cambios offline que necesitan decisión')).toBeHidden()
      const conflictReadback = await successfulAPI(qaContext.request, baseURL, 'conflict_readback', '/api/offline/v2/conflicts?limit=100')
      ensure(!(conflictReadback.conflicts || []).some((item: JSONObject) => item.id === conflictResult.conflict_id), 'conflict_not_resolved')

      const staleCounter = await device.signedRequest(
        qaContext.request,
        baseURL,
        accountID,
        '/api/offline/v2/sync',
        device.syncPayload(accountID, clientInventory),
        { counter: device.counter },
      )
      ensure(staleCounter.status === 409, 'stale_counter_not_rejected')

      const tooManySelections = await callAPI(qaContext.request, baseURL, `/api/offline/v2/grants/${grant.id}/selections`, {
        method: 'PUT',
        data: {
          selections: Array.from({ length: 21 }, () => ({ module: 'contacts', resource_type: 'contact', resource_id: randomUUID() })),
        },
      })
      ensure(tooManySelections.status === 413, 'selection_limit_not_enforced')

      await successfulAPI(adminContext.request, baseURL, 'role_permission_remove', `/api/admin/roles/${roleID}`, {
        method: 'PUT',
        data: { name: roleName, description: 'Rol temporal para el flujo offline vivo.', permissions: ['whiteboards', 'tasks', 'programs'] },
      })
      const accessRevokedSync = await device.signedRequest(
        qaContext.request,
        baseURL,
        accountID,
        '/api/offline/v2/sync',
        device.syncPayload(accountID, clientInventory),
      )
      ensure(accessRevokedSync.status === 403, 'revoked_module_access_not_blocked', JSON.stringify(accessRevokedSync.data))

      await successfulAPI(adminContext.request, baseURL, 'role_permission_restore', `/api/admin/roles/${roleID}`, {
        method: 'PUT',
        data: { name: roleName, description: 'Rol temporal para el flujo offline vivo.', permissions: ['whiteboards', 'tasks', 'contacts', 'programs'] },
      })
      const accessRestoredSync = await device.signedRequest(
        qaContext.request,
        baseURL,
        accountID,
        '/api/offline/v2/sync',
        device.syncPayload(accountID, clientInventory),
      )
      ensure(accessRestoredSync.status === 200 && accessRestoredSync.data.terminal_state === 'active', 'restored_module_access_did_not_recover', JSON.stringify(accessRestoredSync.data))
      device.verifyEnvelope(accessRestoredSync.data.lease)

      await successfulAPI(
        adminContext.request,
        baseURL,
        'terminal_revoke',
        `/api/admin/offline-terminals/${device.terminalID}/revoke`,
        { method: 'POST' },
      )
      const revokedSync = await device.signedRequest(
        qaContext.request,
        baseURL,
        accountID,
        '/api/offline/v2/sync',
        device.syncPayload(accountID, clientInventory),
      )
      ensure(revokedSync.status === 200 && revokedSync.data.terminal_state === 'revoked', 'revoked_terminal_sync_invalid')
      ensure(revokedSync.data.inventory?.length === 0 && revokedSync.data.operation_results?.length === 0, 'revoked_terminal_received_data')
      ensure(revokedSync.data.controls?.length === 1, 'wipe_control_missing')
      const wipe = revokedSync.data.controls[0]
      device.verifyControl(wipe)

      const acknowledgement = await device.signedRequest(
        qaContext.request,
        baseURL,
        accountID,
        '/api/offline/v2/control/ack',
        {
          terminal_id: device.terminalID,
          account_id: accountID,
          install_instance_hash: device.installInstanceHash,
          directive_id: wipe.id,
          acknowledgement: { wiped: true, completed_at: new Date().toISOString() },
        },
      )
      ensure(acknowledgement.status === 200 && acknowledgement.data.success, 'wipe_acknowledgement_failed')

      const terminalAfterWipe = await successfulAPI(adminContext.request, baseURL, 'terminal_list_wiped', '/api/admin/offline-terminals/')
      const wipedTerminal = (terminalAfterWipe.terminals || []).find((item: JSONObject) => item.id === device.terminalID)
      ensure(wipedTerminal?.state === 'revoked' && Boolean(wipedTerminal.wipe_acknowledged_at), 'wipe_acknowledgement_not_persisted')

      const postWipeSync = await device.signedRequest(
        qaContext.request,
        baseURL,
        accountID,
        '/api/offline/v2/sync',
        device.syncPayload(accountID, clientInventory),
      )
      ensure(postWipeSync.status === 200 && postWipeSync.data.terminal_state === 'revoked', 'post_wipe_terminal_state_invalid')
      ensure(postWipeSync.data.controls?.length === 0, 'acknowledged_wipe_redelivered')

      const audit = await successfulAPI(adminContext.request, baseURL, 'offline_audit', `/api/admin/offline-terminals/audit?terminal_id=${device.terminalID}&limit=100`)
      const eventTypes = new Set((audit.events || []).map((item: JSONObject) => item.event_type))
      for (const eventType of ['terminal_requested', 'terminal_approved', 'terminal_activated', 'terminal_revoked']) {
        ensure(eventTypes.has(eventType), 'offline_audit_event_missing', eventType)
      }
    } catch (error) {
      primaryFailure = error
      throw error
    } finally {
      let cleanupFailure: unknown = null
      try {
        if (accountID) {
          if (!cleanupContext) {
            const recoverySession = createRuntimeSession(rootActor, secret)
            sessions.push(recoverySession.id)
            cleanupContext = await browser.newContext()
            await installRuntimeSession(cleanupContext, baseURL, recoverySession)
          }
          if (roleID) {
            const roleCleanup = await callAPI(cleanupContext.request, baseURL, `/api/admin/roles/${roleID}`, { method: 'DELETE' })
            ensure([200, 404].includes(roleCleanup.status), 'role_cleanup_failed', JSON.stringify(roleCleanup.data))
          }
          const preview = await callAPI(cleanupContext.request, baseURL, `/api/admin/accounts/${accountID}/purge-preview`)
          if (preview.status === 200) {
            const purge = await callAPI(cleanupContext.request, baseURL, `/api/admin/accounts/${accountID}/purge`, {
              method: 'DELETE',
              data: { confirmation: accountName, delete_files: true },
            })
            ensure(purge.status === 200 && purge.data.success, 'account_cleanup_failed', JSON.stringify(purge.data))
          }
          const residue = runtimeQueryJSON(`
            SELECT json_build_object(
              'accounts',(SELECT COUNT(*) FROM accounts WHERE id='${accountID}'::uuid),
              'terminals',(SELECT COUNT(*) FROM offline_terminals WHERE id='${device.terminalID}'::uuid),
              'roles',(SELECT COUNT(*) FROM roles WHERE id='${roleID || '00000000-0000-0000-0000-000000000000'}'::uuid),
              'users',(SELECT COUNT(*) FROM users WHERE id='${userID || '00000000-0000-0000-0000-000000000000'}'::uuid)
            )::text
          `)
          ensure(Number(residue.accounts) === 0 && Number(residue.terminals) === 0 && Number(residue.roles) === 0 && Number(residue.users) === 0, 'account_cleanup_residue', JSON.stringify(residue))
        }
      } catch (error) {
        cleanupFailure = error
      } finally {
        await cleanupContext?.close().catch(() => undefined)
        for (const sessionID of sessions) removeRuntimeSession(sessionID)
      }
      if (cleanupFailure && primaryFailure) {
        process.stderr.write(`${JSON.stringify({ kind: 'clarin_offline_cleanup_failure', error: String(cleanupFailure) })}\n`)
      } else if (cleanupFailure) {
        throw cleanupFailure
      }
    }
  })
})
