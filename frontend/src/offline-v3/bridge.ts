import { CompactEncrypt } from 'jose'
import { attachBrowserProfile, createDPoPProof, forgetPendingEnrollment, importEncryptionKey, loadOrCreateBrowserIdentity, pinBrowserTransportTrust, publicKeyThumbprint, randomBase64URL, rememberPendingEnrollment, signBrowserClaims } from './identity'
import { assertTrustedUnlockTransport, buildPinnedTransportTrust, verifyLocalServicePossession } from './transportTrust'
import {
  LocalServiceError,
  OFFLINE_V3_LOCAL_ORIGIN,
  OFFLINE_V3_PROTOCOL,
  type BrowserChallenge,
  type BrowserIdentityRecord,
  type BrowserProfileProof,
  type GrantSummary,
  type GrantActivationBundle,
  type GrantLeaseActivationBundle,
  type GrantLeaseActivationResult,
  type GrantLeaseProofResult,
  type GrantLeaseRequest,
  type GrantKeyChallenge,
  type GrantProvisionResult,
  type LocalEnrollmentMaterial,
  type LocalServiceErrorBody,
  type LocalServiceDescriptor,
  type OfflineContact,
  type OfflineConflict,
  type OfflineHealth,
  type OfflinePage,
  type OfflineProgram,
  type OfflineResource,
  type OfflineSession,
  type OfflineTask,
  type OfflineTaskList,
  type OfflineWhiteboard,
  type OnlineEnrollmentChallenge,
  type OnlineEnrollmentRequestInput,
  type PrincipalChallenge,
  type ProvisionChallenge,
  type QueuedTaskResult,
  type ServiceDescriptorEnvelope,
  type SyncStatus,
  type TaskCompleteInput,
  type TaskCreateInput,
  type UnlockChallenge,
  type UnlockResult,
} from './types'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const REQUEST_TIMEOUT_MS = 5_000
const UNLOCK_TIMEOUT_MS = 15_000

function requireUUID(value: string, label: string) {
  if (!UUID_PATTERN.test(value)) throw new Error(`${label} no es válido.`)
  return value
}

function queryString(values: Record<string, string | number | undefined>) {
  const query = new URLSearchParams()
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== '') query.set(key, String(value))
  })
  const encoded = query.toString()
  return encoded ? `?${encoded}` : ''
}

type ProofKind = 'none' | 'enrollment' | 'browser' | 'session'

interface RequestOptions {
  method?: 'GET' | 'POST'
  body?: unknown
  proof?: ProofKind
  timeoutMs?: number
}

export function buildOnlineEnrollmentRequest(material: LocalEnrollmentMaterial, browserSignature: string): OnlineEnrollmentRequestInput {
  return {
    challenge_id: material.challenge_id,
    nonce: material.nonce,
    installation_id: material.installation_id,
    windows_principal_id: material.windows_principal_id,
    browser_profile_id: material.browser_profile_id,
    authorization_id: material.authorization_id,
    display_name: material.display_name,
    principal_display_name: material.principal_display_name,
    browser_name: material.browser_name,
    client_version: material.client_version,
    sid_hash: material.sid_hash,
    installation_signing_jwk: material.installation_signing_jwk,
    service_encryption_jwk: material.service_encryption_jwk,
    browser_dpop_jwk: material.browser_dpop_jwk,
    installation_signature: material.installation_signature,
    principal_signature: material.principal_signature,
    browser_signature: browserSignature,
  }
}

export function buildGrantKeyRegistrationRequest(result: GrantProvisionResult, browserSignature: string) {
  const registration = result.key_registration
  return {
    challenge_id: registration.challenge_id,
    nonce: registration.nonce,
    counter: registration.counter,
    signing_jwk: registration.signing_jwk,
    encryption_jwk: registration.encryption_jwk,
    installation_signature: registration.installation_signature,
    browser_signature: browserSignature,
    grant_signature: registration.grant_signature,
  }
}

export function buildGrantLeaseRequest(result: GrantLeaseProofResult, browserSignature: string): GrantLeaseRequest {
  const proof = result.lease_proof
  return {
    challenge_id: proof.challenge_id,
    nonce: proof.nonce,
    counter: proof.counter,
    installation_signature: proof.installation_signature,
    browser_signature: browserSignature,
    grant_signature: proof.grant_signature,
  }
}

export function buildLocalCredentialPayload(
  purpose: 'unlock' | 'provision' | 'renew',
  challengeId: string,
  grantId: string,
  browserProfileId: string,
  login: string,
  password: string,
) {
  if (!login.trim() || !password) throw new Error('El usuario y la contraseña de Clarin son obligatorios.')
  return {
    v: OFFLINE_V3_PROTOCOL,
    purpose,
    challenge_id: challengeId,
    grant_id: grantId,
    browser_profile_id: browserProfileId,
    login,
    password,
  }
}

export function buildHeartbeatPayload(
  session: OfflineSession,
  clientInstanceId: string,
  visible: boolean,
  activitySequence: number,
) {
  if (!Number.isSafeInteger(activitySequence) || activitySequence < 0) throw new Error('La secuencia de actividad no es válida.')
  return {
    session_id: session.session_id,
    client_instance_id: requireUUID(clientInstanceId, 'La pestaña'),
    profile_epoch: session.profile_epoch,
    visible,
    activity_sequence: activitySequence,
  }
}

export class OfflineV3Bridge {
  private identity: BrowserIdentityRecord | null = null
  private session: OfflineSession | null = null
  private nonce = ''
  private invalidationListeners = new Set<(error: LocalServiceError) => void>()

  async initializeIdentity() {
    this.identity = await loadOrCreateBrowserIdentity()
    return this.identity
  }

  currentIdentity() {
    return this.identity
  }

  currentSession() {
    return this.session
  }

  async pinAuthenticatedTransportTrust(envelope: ServiceDescriptorEnvelope) {
    if (!this.identity) this.identity = await loadOrCreateBrowserIdentity()
    const trust = await buildPinnedTransportTrust(this.identity, envelope)
    this.identity = await pinBrowserTransportTrust(this.identity, trust)
    return this.identity
  }

  async rememberEnrollmentRequest(requestId: string) {
    if (!this.identity) this.identity = await loadOrCreateBrowserIdentity()
    this.identity = await rememberPendingEnrollment(this.identity, requireUUID(requestId, 'La solicitud'))
    return this.identity
  }

  async forgetEnrollmentRequest(requestId: string) {
    if (!this.identity) return
    this.identity = await forgetPendingEnrollment(this.identity, requireUUID(requestId, 'La solicitud'))
  }

  onInvalidated(listener: (error: LocalServiceError) => void) {
    this.invalidationListeners.add(listener)
    return () => { this.invalidationListeners.delete(listener) }
  }

  async health() {
    return this.request<OfflineHealth>('/health', { proof: 'none' })
  }

  async createPrincipalChallenge() {
    return this.request<PrincipalChallenge>('/browser-profiles/principal-challenge', {
      method: 'POST',
      proof: 'none',
      body: {},
    })
  }

  async principalChallengeStatus(challengeId: string) {
    return this.request<{ state: 'waiting' | 'completed' | 'expired'; expires_at: string }>(
      `/browser-profiles/principal-challenges/${encodeURIComponent(requireUUID(challengeId, 'El reto principal'))}`,
      { proof: 'none' },
    )
  }

  async browserChallenge(clientBuild: string, browserLabel: string) {
    const result = await this.request<BrowserChallenge>('/browser-profiles/challenge', {
      method: 'POST',
      proof: 'none',
      body: { client_build: clientBuild, browser_label: browserLabel },
    })
    this.nonce = result.nonce
    return result
  }

  async enrollBrowser(principalChallengeId: string, challengeId: string, clientBuild: string, browserLabel: string) {
    requireUUID(principalChallengeId, 'El reto de Windows')
    requireUUID(challengeId, 'El reto del navegador')
    const result = await this.request<BrowserProfileProof>('/browser-profiles/enroll', {
      method: 'POST',
      proof: 'enrollment',
      body: {
        principal_challenge_id: principalChallengeId,
        challenge_id: challengeId,
        client_build: clientBuild,
        browser_label: browserLabel,
      },
    })
    if (!this.identity) throw new Error('La clave del navegador no está disponible.')
    this.identity = await attachBrowserProfile(this.identity, result.browser_profile_id)
    return result
  }

  async enrollmentMaterial(
    challenge: OnlineEnrollmentChallenge,
    details: { displayName: string; clientVersion: string },
  ): Promise<OnlineEnrollmentRequestInput> {
    if (!this.identity?.browserProfileId) throw new Error('El perfil del navegador aún no está inscrito.')
    const material = await this.request<LocalEnrollmentMaterial>('/browser-profiles/enrollment-material', {
      method: 'POST',
      proof: 'browser',
      body: {
        challenge_id: requireUUID(challenge.challenge_id, 'El reto del servidor'),
        nonce: challenge.nonce,
        authorization_id: requireUUID(challenge.authorization_id, 'La autorización'),
        display_name: details.displayName,
        client_version: details.clientVersion,
      },
    })
    if (material.challenge_id !== challenge.challenge_id || material.nonce !== challenge.nonce || material.authorization_id !== challenge.authorization_id) {
      throw new LocalServiceError(409, 'identity_changed', 'El motor respondió con material para otra autorización.')
    }
    if (material.browser_profile_id !== this.identity.browserProfileId) throw new LocalServiceError(409, 'identity_changed', 'El motor respondió para otro navegador.')
    if (await publicKeyThumbprint(material.browser_dpop_jwk) !== await publicKeyThumbprint(this.identity.publicJwk)) {
      throw new LocalServiceError(409, 'identity_changed', 'La clave del navegador no coincide con el perfil local.')
    }
    const browserSignature = await signBrowserClaims(this.identity, material.browser_proof_claims, 'clarin-offline-enrollment-proof+jwt')
    return buildOnlineEnrollmentRequest(material, browserSignature)
  }

  async proveBrowser(clientBuild: string) {
    return this.request<BrowserProfileProof>('/browser-profiles/prove', {
      method: 'POST',
      proof: 'browser',
      body: { client_build: clientBuild },
    })
  }

  async activateBrowserProfile(envelope: ServiceDescriptorEnvelope, clientBuild: string) {
    await this.pinAuthenticatedTransportTrust(envelope)
    const current = await this.proveBrowser(clientBuild)
    if (current.state === 'active') return
    if (current.state === 'revoked') throw new LocalServiceError(403, 'grant_revoked', 'El navegador fue revocado.')
    return this.request<void>('/browser-profiles/activate', {
      method: 'POST',
      proof: 'browser',
      body: envelope,
    })
  }

  async grants(cursor?: string) {
    return this.request<{ items: GrantSummary[]; next_cursor?: string }>(`/grants${queryString({ cursor, limit: 50 })}`, { proof: 'browser' })
  }

  async suspendGrantForSelection(grantId: string) {
    this.session = null
    return this.request<{ state: 'suspended'; profile_epoch: number }>(
      `/grants/${encodeURIComponent(requireUUID(grantId, 'La autorización'))}/suspend`,
      { method: 'POST', proof: 'browser', body: { reason: 'selection_changed' } },
    )
  }

  async unlockChallenge(grantId: string) {
    return this.request<UnlockChallenge>(`/grants/${encodeURIComponent(requireUUID(grantId, 'La autorización'))}/unlock/challenge`, {
      method: 'POST',
      proof: 'browser',
      body: {},
    })
  }

  async serviceDescriptor() {
    const challenge = randomBase64URL(32)
    const envelope = await this.request<LocalServiceDescriptor>(`/runtime/service-descriptor${queryString({ challenge })}`, { proof: 'browser' })
    if (!this.identity) throw new Error('La identidad del navegador no está disponible.')
    return verifyLocalServicePossession(this.identity, envelope, challenge)
  }

  async unlock(grantId: string, login: string, password: string) {
    if (!this.identity?.browserProfileId) throw new Error('El perfil del navegador aún no está inscrito.')
    const descriptor = await this.serviceDescriptor()
    const challenge = await this.unlockChallenge(grantId)
    await assertTrustedUnlockTransport(descriptor, challenge.credential_encryption_jwk, challenge.service_descriptor, this.identity.trust?.descriptorJws || '')
    const encryptionKey = await importEncryptionKey(challenge.credential_encryption_jwk)
    const plaintext = new TextEncoder().encode(JSON.stringify(buildLocalCredentialPayload(
      'unlock', challenge.challenge_id, grantId, this.identity.browserProfileId, login, password,
    )))
    const credentialJwe = await new CompactEncrypt(plaintext)
      .setProtectedHeader({
        typ: 'clarin-local-unlock+jwe',
        alg: 'ECDH-ES+A256KW',
        enc: 'A256GCM',
        kid: challenge.credential_encryption_jwk.kid,
        v: OFFLINE_V3_PROTOCOL,
        origin: window.location.origin,
      })
      .encrypt(encryptionKey)

    const result = await this.request<UnlockResult>(`/grants/${encodeURIComponent(requireUUID(grantId, 'La autorización'))}/unlock`, {
      method: 'POST',
      proof: 'browser',
      timeoutMs: UNLOCK_TIMEOUT_MS,
      body: { challenge_id: challenge.challenge_id, credential_jwe: credentialJwe },
    })
    this.session = result.session
    return result
  }

  async provisionChallenge(grantId: string) {
    return this.request<ProvisionChallenge>(`/grants/${encodeURIComponent(requireUUID(grantId, 'La autorización'))}/provision/challenge`, {
      method: 'POST', proof: 'browser', body: {},
    })
  }

  async prepareGrantProvision(
    grantId: string,
    login: string,
    password: string,
    server: { grantBootstrap: string; keyChallenge: GrantKeyChallenge },
  ) {
    if (!this.identity?.browserProfileId) throw new Error('El perfil del navegador aún no está inscrito.')
    const descriptor = await this.serviceDescriptor()
    const challenge = await this.provisionChallenge(grantId)
    await assertTrustedUnlockTransport(descriptor, challenge.credential_encryption_jwk, challenge.service_descriptor, this.identity.trust?.descriptorJws || '')
    const credentialJwe = await this.encryptCredential('provision', grantId, challenge, login, password)
    return this.request<GrantProvisionResult>(`/grants/${encodeURIComponent(requireUUID(grantId, 'La autorización'))}/provision`, {
      method: 'POST',
      proof: 'browser',
      timeoutMs: UNLOCK_TIMEOUT_MS,
      body: {
        challenge_id: challenge.challenge_id,
        credential_jwe: credentialJwe,
        grant_bootstrap: server.grantBootstrap,
        server_challenge_id: requireUUID(server.keyChallenge.challenge_id, 'El reto de claves'),
        server_nonce: server.keyChallenge.nonce,
      },
    })
  }

  async signGrantKeyRegistration(result: GrantProvisionResult) {
    if (!this.identity) throw new Error('La identidad del navegador no está disponible.')
    const registration = result.key_registration
    const browserSignature = await signBrowserClaims(this.identity, registration.browser_proof_claims, 'clarin-offline-grant-keys-proof+jwt')
    return buildGrantKeyRegistrationRequest(result, browserSignature)
  }

  async activateGrantProvision(grantId: string, bundle: GrantActivationBundle) {
    await this.pinAuthenticatedTransportTrust(bundle)
    return this.request<void>(`/grants/${encodeURIComponent(requireUUID(grantId, 'La autorización'))}/provision/activate`, {
      method: 'POST', proof: 'browser', body: bundle,
    })
  }

  async leaseChallenge(grantId: string) {
    return this.request<ProvisionChallenge>(`/grants/${encodeURIComponent(requireUUID(grantId, 'La autorización'))}/lease/challenge`, {
      method: 'POST', proof: 'browser', body: {},
    })
  }

  async prepareGrantLease(
    grantId: string,
    login: string,
    password: string,
    server: { grantBootstrap: string; leaseChallenge: GrantKeyChallenge },
  ) {
    if (!this.identity?.browserProfileId) throw new Error('El perfil del navegador aún no está inscrito.')
    const descriptor = await this.serviceDescriptor()
    const challenge = await this.leaseChallenge(grantId)
    await assertTrustedUnlockTransport(descriptor, challenge.credential_encryption_jwk, challenge.service_descriptor, this.identity.trust?.descriptorJws || '')
    const credentialJwe = await this.encryptCredential('renew', grantId, challenge, login, password)
    return this.request<GrantLeaseProofResult>(`/grants/${encodeURIComponent(requireUUID(grantId, 'La autorización'))}/lease/prepare`, {
      method: 'POST',
      proof: 'browser',
      timeoutMs: UNLOCK_TIMEOUT_MS,
      body: {
        challenge_id: challenge.challenge_id,
        credential_jwe: credentialJwe,
        grant_bootstrap: server.grantBootstrap,
        server_challenge_id: requireUUID(server.leaseChallenge.challenge_id, 'El reto de renovación'),
        server_nonce: server.leaseChallenge.nonce,
      },
    })
  }

  async signGrantLease(result: GrantLeaseProofResult) {
    if (!this.identity) throw new Error('La identidad del navegador no está disponible.')
    const browserSignature = await signBrowserClaims(this.identity, result.lease_proof.browser_proof_claims, 'clarin-offline-lease-proof+jwt')
    return buildGrantLeaseRequest(result, browserSignature)
  }

  async activateGrantLease(grantId: string, bundle: GrantLeaseActivationBundle) {
    const result = await this.request<GrantLeaseActivationResult>(`/grants/${encodeURIComponent(requireUUID(grantId, 'La autorización'))}/lease/activate`, {
      method: 'POST', proof: 'browser', body: bundle,
    })
    // The local service verified the descriptor, key ring, tuple, lease and
    // complete selection digest before the authenticated server trust is kept.
    await this.pinAuthenticatedTransportTrust(bundle)
    this.session = null
    return result
  }

  async lock(reason: 'logout' | 'switch' | 'idle' | 'security') {
    if (!this.session) return
    try {
      await this.request<void>('/session/lock', { method: 'POST', proof: 'session', body: { reason } })
    } finally {
      this.session = null
    }
  }

  async heartbeat(clientInstanceId: string, visible: boolean, activitySequence: number) {
    const session = this.requireSession()
    return this.request<{ ok: true; profile_epoch: number; idle_expires_at: string; lease_expires_at: string; sync: SyncStatus }>(
      '/session/heartbeat',
      {
        method: 'POST',
        proof: 'session',
        body: buildHeartbeatPayload(session, clientInstanceId, visible, activitySequence),
      },
    )
  }

  async resources(module: 'tasks' | 'contacts' | 'programs' | 'whiteboards', cursor?: string) {
    return this.request<{ items: OfflineResource[]; next_cursor?: string; selection_revision: number }>(
      `/resources${queryString({ module, cursor, limit: 50 })}`,
      { proof: 'session' },
    )
  }

  async conflicts(cursor?: string) {
    return this.request<{ items: OfflineConflict[]; next_cursor?: string }>(`/conflicts${queryString({ cursor, limit: 50 })}`, { proof: 'session' })
  }

  async taskLists(cursor?: string) {
    return this.request<OfflinePage<OfflineTaskList>>(`/tasks/lists${queryString({ cursor, limit: 50 })}`, { proof: 'session' })
  }

  async tasks(selectionId: string, cursor?: string) {
    return this.request<OfflinePage<OfflineTask>>(`/tasks${queryString({ selection_id: requireUUID(selectionId, 'La selección'), cursor, limit: 50 })}`, { proof: 'session' })
  }

  async contacts(cursor?: string) {
    return this.request<OfflinePage<OfflineContact>>(`/contacts${queryString({ cursor, limit: 50 })}`, { proof: 'session' })
  }

  async contact(id: string) {
    return this.request<{ item: OfflineContact; snapshot: OfflinePage<never>['snapshot'] }>(`/contacts/${encodeURIComponent(requireUUID(id, 'El contacto'))}`, { proof: 'session' })
  }

  async programs(cursor?: string) {
    return this.request<OfflinePage<OfflineProgram>>(`/programs${queryString({ cursor, limit: 50 })}`, { proof: 'session' })
  }

  async program(id: string) {
    return this.request<{ item: OfflineProgram; snapshot: OfflinePage<never>['snapshot'] }>(`/programs/${encodeURIComponent(requireUUID(id, 'El programa'))}`, { proof: 'session' })
  }

  async whiteboards(cursor?: string) {
    return this.request<OfflinePage<OfflineWhiteboard>>(`/whiteboards${queryString({ cursor, limit: 50 })}`, { proof: 'session' })
  }

  async whiteboardScene(id: string) {
    return this.request<{ item: OfflineWhiteboard; snapshot: OfflinePage<never>['snapshot'] }>(`/whiteboards/${encodeURIComponent(requireUUID(id, 'La pizarra'))}/scene`, { proof: 'session' })
  }

  async createTask(input: TaskCreateInput) {
    return this.request<QueuedTaskResult>('/operations/tasks/create', { method: 'POST', proof: 'session', body: input })
  }

  async completeTask(taskId: string, input: TaskCompleteInput) {
    return this.request<QueuedTaskResult>(`/operations/tasks/${encodeURIComponent(requireUUID(taskId, 'La tarea'))}/complete`, {
      method: 'POST',
      proof: 'session',
      body: input,
    })
  }

  async syncStatus() {
    return this.request<SyncStatus>('/sync/status', { proof: 'session' })
  }

  async triggerSync() {
    return this.request<SyncStatus>('/sync/trigger', { method: 'POST', proof: 'session', body: { reason: 'user' } })
  }

  private requireSession() {
    if (!this.session) throw new LocalServiceError(401, 'session_expired', 'La sesión offline está bloqueada.')
    return this.session
  }

  private async encryptCredential(
    purpose: 'provision' | 'renew',
    grantId: string,
    challenge: ProvisionChallenge,
    login: string,
    password: string,
  ) {
    if (!this.identity?.browserProfileId) throw new Error('El perfil del navegador aún no está inscrito.')
    const encryptionKey = await importEncryptionKey(challenge.credential_encryption_jwk)
    const plaintext = new TextEncoder().encode(JSON.stringify(buildLocalCredentialPayload(
      purpose, challenge.challenge_id, grantId, this.identity.browserProfileId, login, password,
    )))
    return new CompactEncrypt(plaintext)
      .setProtectedHeader({
        typ: purpose === 'provision' ? 'clarin-local-provision+jwe' : 'clarin-local-renew+jwe',
        alg: 'ECDH-ES+A256KW',
        enc: 'A256GCM',
        kid: challenge.credential_encryption_jwk.kid,
        v: OFFLINE_V3_PROTOCOL,
        origin: window.location.origin,
      })
      .encrypt(encryptionKey)
  }

  private async request<T>(path: string, options: RequestOptions): Promise<T> {
    if (!path.startsWith('/') || path.includes('://')) throw new Error('Ruta local no permitida.')
    const method = options.method || 'GET'
    const requestSession = options.proof === 'session' ? this.requireSession() : null
    const requestProfileID = this.identity?.browserProfileId
    const url = `${OFFLINE_V3_LOCAL_ORIGIN}/v3${path}`
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), options.timeoutMs || REQUEST_TIMEOUT_MS)
    try {
      const headers: Record<string, string> = {
        'X-Clarin-Protocol': String(OFFLINE_V3_PROTOCOL),
        'X-Clarin-Request-ID': crypto.randomUUID(),
      }
      if (options.body !== undefined) headers['Content-Type'] = 'application/json'
      if (options.proof && options.proof !== 'none') {
        if (!this.identity) throw new Error('La identidad del navegador no está disponible.')
        if (options.proof !== 'enrollment' && !this.identity.browserProfileId) throw new Error('El navegador no está inscrito.')
        headers.DPoP = await createDPoPProof({
          identity: this.identity,
          method,
          url,
          nonce: this.nonce,
          capability: requestSession?.capability,
          enrollment: options.proof === 'enrollment',
        })
        if (this.identity.browserProfileId) headers['X-Clarin-Browser-Profile-ID'] = this.identity.browserProfileId
        if (requestSession) headers.Authorization = `DPoP ${requestSession.capability}`
      }
      const response = await fetch(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal,
      })
      this.nonce = response.headers.get('DPoP-Nonce') || this.nonce
      if (response.status === 204) return undefined as T
      const contentType = response.headers.get('content-type') || ''
      const payload = contentType.includes('application/json')
        ? await response.json() as T | LocalServiceErrorBody
        : { error: 'invalid_local_response', message: 'El servicio local devolvió una respuesta no válida.' } as LocalServiceErrorBody
      if (!response.ok) {
        const body = payload as LocalServiceErrorBody
        const error = new LocalServiceError(response.status, body.error || 'local_service_error', body.message || 'No se pudo completar la operación offline.', body.profile_epoch)
        if (['identity_changed', 'session_expired', 'grant_revoked', 'lease_expired'].includes(error.code)) {
          this.session = null
          this.invalidationListeners.forEach(listener => listener(error))
        }
        throw error
      }
      if (options.proof === 'session' && (this.session?.session_id !== requestSession?.session_id || this.session?.profile_epoch !== requestSession?.profile_epoch)) {
        throw new LocalServiceError(409, 'identity_changed', 'La identidad offline cambió mientras se procesaba la solicitud.')
      }
      if (options.proof && options.proof !== 'none' && this.identity?.browserProfileId !== requestProfileID) {
        throw new LocalServiceError(409, 'identity_changed', 'El perfil del navegador cambió mientras se procesaba la solicitud.')
      }
      return payload as T
    } catch (error) {
      if (error instanceof LocalServiceError) throw error
      if ((error as Error).name === 'AbortError') throw new LocalServiceError(0, 'local_service_timeout', 'El motor offline no respondió a tiempo.')
      throw new LocalServiceError(0, 'local_service_unavailable', 'El motor offline no está disponible.')
    } finally {
      window.clearTimeout(timer)
    }
  }
}
