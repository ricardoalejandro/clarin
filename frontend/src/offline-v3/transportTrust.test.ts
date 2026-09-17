// @vitest-environment node

import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'
import { buildPinnedTransportTrust, verifyLocalServicePossession } from './transportTrust'
import type { BrowserIdentityRecord, ServiceDescriptorEnvelope } from './types'

const browserProfileId = '11111111-1111-4111-8111-111111111111'
const installationId = '22222222-2222-4222-8222-222222222222'
const principalId = '33333333-3333-4333-8333-333333333333'
const serverOrigin = 'https://clarin.naperu.cloud'

async function signedFixture(now: number, challenge = 'A'.repeat(43)) {
  const descriptorSigner = await generateKeyPair('ES256', { extractable: true })
  const serviceSigner = await generateKeyPair('ES256', { extractable: true })
  const transport = await generateKeyPair('ECDH-ES', { extractable: true })
  const descriptorSignerJwk = { ...await exportJWK(descriptorSigner.publicKey), kid: 'backend-key-1', use: 'sig', alg: 'ES256' }
  const serviceSignerJwk = { ...await exportJWK(serviceSigner.publicKey), kid: 'service-key-1', use: 'sig', alg: 'ES256' }
  const transportJwk = { ...await exportJWK(transport.publicKey), kid: 'transport-key-1', use: 'enc', alg: 'ECDH-ES+A256KW' }
  const seconds = Math.floor(now / 1_000)
  const descriptor = await new SignJWT({
    version: 3,
    installation_id: installationId,
    windows_principal_id: principalId,
    browser_profile_id: browserProfileId,
    transport_encryption_kid: transportJwk.kid,
    transport_encryption_jwk: transportJwk,
    service_signing_kid: serviceSignerJwk.kid,
    service_signing_jwk: serviceSignerJwk,
    server_origin: serverOrigin,
  })
    .setProtectedHeader({ typ: 'clarin-offline-service-descriptor+jwt', alg: 'ES256', kid: descriptorSignerJwk.kid })
    .setIssuer('clarin-offline-v3')
    .setAudience('clarin-offline-local-service')
    .setIssuedAt(seconds)
    .setNotBefore(seconds - 1)
    .setExpirationTime(seconds + 24 * 60 * 60)
    .setJti('descriptor-1')
    .sign(descriptorSigner.privateKey)
  const possession = await new SignJWT({
    version: 3,
    purpose: 'service-possession',
    challenge,
    installation_id: installationId,
    windows_principal_id: principalId,
    browser_profile_id: browserProfileId,
    server_origin: serverOrigin,
  })
    .setProtectedHeader({ typ: 'clarin-offline-service-possession+jwt', alg: 'ES256', kid: serviceSignerJwk.kid })
    .setIssuedAt(seconds)
    .setNotBefore(seconds - 1)
    .setExpirationTime(seconds + 45)
    .setJti('possession-1')
    .sign(serviceSigner.privateKey)
  const envelope: ServiceDescriptorEnvelope = {
    service_descriptor: descriptor,
    signer_public_keys: { keys: [descriptorSignerJwk], key_version: 1 },
  }
  return { envelope, possession, challenge }
}

function identity(): BrowserIdentityRecord {
  return {
    version: 1,
    privateKey: {} as CryptoKey,
    publicKey: {} as CryptoKey,
    publicJwk: { kty: 'EC', crv: 'P-256', x: 'unused', y: 'unused' },
    browserProfileId,
    createdAt: new Date().toISOString(),
  }
}

describe('local service trust', () => {
  it('pins an HTTPS-authenticated ring then requires fresh proof of the exact local key', async () => {
    const now = Date.parse('2026-09-14T20:00:00Z')
    const fixture = await signedFixture(now)
    const browser = identity()
    browser.trust = await buildPinnedTransportTrust(browser, fixture.envelope, serverOrigin, now)

    const descriptor = await verifyLocalServicePossession(browser, { ...fixture.envelope, possession: fixture.possession }, fixture.challenge, now, serverOrigin)
    expect(descriptor.browser_profile_id).toBe(browserProfileId)
    expect(descriptor.installation_id).toBe(installationId)
  })

  it('rejects a replayed possession proof for another browser challenge', async () => {
    const now = Date.parse('2026-09-14T20:00:00Z')
    const fixture = await signedFixture(now)
    const browser = identity()
    browser.trust = await buildPinnedTransportTrust(browser, fixture.envelope, serverOrigin, now)

    await expect(verifyLocalServicePossession(browser, { ...fixture.envelope, possession: fixture.possession }, 'B'.repeat(43), now, serverOrigin))
      .rejects.toThrow('no responde al reto')
  })

  it('rejects a localhost-provided signer ring that differs from the HTTPS pin', async () => {
    const now = Date.parse('2026-09-14T20:00:00Z')
    const fixture = await signedFixture(now)
    const browser = identity()
    browser.trust = await buildPinnedTransportTrust(browser, fixture.envelope, serverOrigin, now)
    const attacker = await generateKeyPair('ES256', { extractable: true })
    const attackerJwk = { ...await exportJWK(attacker.publicKey), kid: 'backend-key-1' }

    await expect(verifyLocalServicePossession(browser, {
      ...fixture.envelope,
      signer_public_keys: { keys: [attackerJwk], key_version: 1 },
      possession: fixture.possession,
    }, fixture.challenge, now, serverOrigin)).rejects.toThrow('anillo de firmas diferente')
  })
})
