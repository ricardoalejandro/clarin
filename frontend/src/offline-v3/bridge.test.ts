import { describe, expect, it, vi } from 'vitest'
import { OfflineV3Bridge, buildGrantKeyRegistrationRequest, buildGrantLeaseRequest, buildHeartbeatPayload, buildLocalCredentialPayload, buildOnlineEnrollmentRequest } from './bridge'
import type { BrowserIdentityRecord, GrantLeaseProofResult, GrantProvisionResult, LocalEnrollmentMaterial, OfflineSession, ServiceDescriptorEnvelope } from './types'

const browserProfileId = '11111111-1111-4111-8111-111111111111'

function publicKey(kid: string, use: 'sig' | 'enc', alg: 'ES256' | 'ECDH-ES+A256KW') {
  return { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', kid, use, alg }
}

describe('offline v3 bridge contracts', () => {
  it('binds every local credential envelope to the typed Clarin login without accepting account authority', () => {
    expect(buildLocalCredentialPayload(
      'unlock',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      browserProfileId,
      'ricardo',
      'same-current-password',
    )).toEqual({
      v: 3,
      purpose: 'unlock',
      challenge_id: '22222222-2222-4222-8222-222222222222',
      grant_id: '33333333-3333-4333-8333-333333333333',
      browser_profile_id: browserProfileId,
      login: 'ricardo',
      password: 'same-current-password',
    })
    expect(() => buildLocalCredentialPayload('renew', 'challenge', 'grant', browserProfileId, '   ', 'secret')).toThrow(/usuario/i)
  })

  it('reports only an explicit monotonic user-activity sequence in heartbeats', () => {
    const session = {
      session_id: '22222222-2222-4222-8222-222222222222',
      profile_epoch: 8,
    } as OfflineSession
    expect(buildHeartbeatPayload(session, '33333333-3333-4333-8333-333333333333', true, 17)).toEqual({
      session_id: session.session_id,
      client_instance_id: '33333333-3333-4333-8333-333333333333',
      profile_epoch: 8,
      visible: true,
      activity_sequence: 17,
    })
    expect(() => buildHeartbeatPayload(session, '33333333-3333-4333-8333-333333333333', true, -1)).toThrow(/secuencia/i)
    expect(() => buildHeartbeatPayload(session, '33333333-3333-4333-8333-333333333333', true, 1.5)).toThrow(/secuencia/i)
  })

  it('suspends the exact local grant before a selection authority change', async () => {
    const bridge = new OfflineV3Bridge()
    const requestSpy = vi.spyOn(bridge as unknown as {
      request: (path: string, options: unknown) => Promise<{ state: 'suspended'; profile_epoch: number }>
    }, 'request').mockResolvedValue({ state: 'suspended', profile_epoch: 12 })

    await expect(bridge.suspendGrantForSelection('33333333-3333-4333-8333-333333333333')).resolves.toEqual({
      state: 'suspended', profile_epoch: 12,
    })
    expect(requestSpy).toHaveBeenCalledWith(
      '/grants/33333333-3333-4333-8333-333333333333/suspend',
      { method: 'POST', proof: 'browser', body: { reason: 'selection_changed' } },
    )
  })

  it('sends only the strict backend enrollment material and never forwards proof instructions', () => {
    const material: LocalEnrollmentMaterial = {
      challenge_id: '22222222-2222-4222-8222-222222222222',
      nonce: 'n'.repeat(43),
      installation_id: '33333333-3333-4333-8333-333333333333',
      windows_principal_id: '44444444-4444-4444-8444-444444444444',
      browser_profile_id: browserProfileId,
      authorization_id: '55555555-5555-4555-8555-555555555555',
      display_name: 'Equipo autorizado',
      principal_display_name: 'Windows User',
      browser_name: 'Chrome en Equipo',
      client_version: 'build-1',
      sid_hash: 'a'.repeat(64),
      installation_signing_jwk: publicKey('installation', 'sig', 'ES256'),
      service_encryption_jwk: publicKey('service', 'enc', 'ECDH-ES+A256KW'),
      browser_dpop_jwk: publicKey(browserProfileId, 'sig', 'ES256'),
      installation_signature: 'installation.signature.value',
      principal_signature: 'principal.signature.value',
      browser_proof_claims: { purpose: 'browser', request_hash: 'secret-instruction' },
    }

    const request = buildOnlineEnrollmentRequest(material, 'browser.signature.value')

    expect(request).toMatchObject({ browser_profile_id: browserProfileId, browser_signature: 'browser.signature.value' })
    expect(request).not.toHaveProperty('browser_proof_claims')
    expect(request).not.toHaveProperty('principal')
    expect(request).not.toHaveProperty('proofs')
  })

  it('does not reactivate an already active browser profile and bump its epoch again', async () => {
    const bridge = new OfflineV3Bridge()
    vi.spyOn(bridge, 'pinAuthenticatedTransportTrust').mockResolvedValue({} as BrowserIdentityRecord)
    vi.spyOn(bridge, 'proveBrowser').mockResolvedValue({ browser_profile_id: browserProfileId, state: 'active', profile_epoch: 4 })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const envelope = { service_descriptor: 'signed.descriptor.value', signer_public_keys: { keys: [], key_version: 3 } } satisfies ServiceDescriptorEnvelope

    await bridge.activateBrowserProfile(envelope, 'build-1')

    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('forwards only the flat grant-key proof contract to the backend', () => {
    const result: GrantProvisionResult = {
      state: 'registering',
      key_registration: {
        challenge_id: '66666666-6666-4666-8666-666666666666',
        nonce: 'n'.repeat(43),
        counter: 7,
        signing_jwk: publicKey('grant-signing', 'sig', 'ES256'),
        encryption_jwk: publicKey('grant-encryption', 'enc', 'ECDH-ES+A256KW'),
        installation_signature: 'installation.signature.value',
        grant_signature: 'grant.signature.value',
        browser_proof_claims: { purpose: 'browser', request_hash: 'do-not-forward' },
      },
    }

    const request = buildGrantKeyRegistrationRequest(result, 'browser.signature.value')

    expect(request).toMatchObject({
      challenge_id: result.key_registration.challenge_id,
      counter: 7,
      signing_jwk: result.key_registration.signing_jwk,
      encryption_jwk: result.key_registration.encryption_jwk,
      browser_signature: 'browser.signature.value',
    })
    expect(request).not.toHaveProperty('browser_proof_claims')
    expect(request).not.toHaveProperty('key_registration')
    expect(request).not.toHaveProperty('proofs')
  })

  it('forwards a renewal proof without key material or browser signing instructions', () => {
    const result: GrantLeaseProofResult = {
      state: 'authorizing',
      lease_proof: {
        challenge_id: '77777777-7777-4777-8777-777777777777',
        nonce: 'r'.repeat(43),
        counter: 9,
        installation_signature: 'installation.signature.value',
        grant_signature: 'grant.signature.value',
        browser_proof_claims: { purpose: 'browser', request_hash: 'do-not-forward' },
      },
    }

    const request = buildGrantLeaseRequest(result, 'browser.signature.value')

    expect(request).toEqual({
      challenge_id: result.lease_proof.challenge_id,
      nonce: result.lease_proof.nonce,
      counter: 9,
      installation_signature: 'installation.signature.value',
      browser_signature: 'browser.signature.value',
      grant_signature: 'grant.signature.value',
    })
    expect(request).not.toHaveProperty('signing_jwk')
    expect(request).not.toHaveProperty('encryption_jwk')
    expect(request).not.toHaveProperty('browser_proof_claims')
  })
})
