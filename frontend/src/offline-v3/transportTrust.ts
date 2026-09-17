import { calculateJwkThumbprint, decodeProtectedHeader, importJWK, jwtVerify, type JWTPayload } from 'jose'
import type {
  BrowserIdentityRecord,
  BrowserTransportTrust,
  LocalServiceDescriptor,
  OfflineJWK,
  OfflineKeyedJWK,
  ServiceDescriptorEnvelope,
} from './types'

const DESCRIPTOR_ISSUER = 'clarin-offline-v3'
const DESCRIPTOR_AUDIENCE = 'clarin-offline-local-service'
const DESCRIPTOR_TYPE = 'clarin-offline-service-descriptor+jwt'
const POSSESSION_TYPE = 'clarin-offline-service-possession+jwt'
const CLOCK_TOLERANCE_SECONDS = 300
const MAX_DESCRIPTOR_SECONDS = 31 * 24 * 60 * 60
const MAX_POSSESSION_SECONDS = 60

export interface ServiceDescriptorClaims extends JWTPayload {
  version: 3
  installation_id: string
  windows_principal_id: string
  browser_profile_id: string
  transport_encryption_kid: string
  transport_encryption_jwk: OfflineJWK
  service_signing_kid: string
  service_signing_jwk: OfflineJWK
  server_origin: string
}

interface PossessionClaims extends JWTPayload {
  version: 3
  purpose: 'service-possession'
  challenge: string
  installation_id: string
  windows_principal_id: string
  browser_profile_id: string
  server_origin: string
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} no está presente en la identidad del servicio.`)
  return value
}

function requirePublicJwk(value: unknown, label: string) {
  if (!value || typeof value !== 'object') throw new Error(`${label} no contiene una clave pública válida.`)
  const jwk = value as OfflineJWK
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string' || 'd' in jwk) {
    throw new Error(`${label} no es una clave pública P-256 permitida.`)
  }
  return jwk
}

function validateTimes(payload: JWTPayload, maximumLifetime: number, now: number) {
  if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || !Number.isSafeInteger(payload.nbf)) {
    throw new Error('La vigencia firmada del servicio no es válida.')
  }
  if ((payload.exp as number) - (payload.iat as number) > maximumLifetime) throw new Error('La vigencia firmada del servicio excede el límite permitido.')
  const nowSeconds = Math.floor(now / 1_000)
  if ((payload.iat as number) > nowSeconds + CLOCK_TOLERANCE_SECONDS || (payload.exp as number) <= nowSeconds) {
    throw new Error('La identidad pública del servicio offline venció o todavía no es válida.')
  }
}

async function verifyDescriptor(
  descriptorJws: string,
  signerKeys: OfflineKeyedJWK[],
  browserProfileId: string,
  expectedOrigin: string,
  now: number,
) {
  const header = decodeProtectedHeader(descriptorJws)
  if (header.alg !== 'ES256' || header.typ !== DESCRIPTOR_TYPE || typeof header.kid !== 'string') {
    throw new Error('La firma del descriptor offline no está permitida.')
  }
  const signer = signerKeys.find(key => key.kid === header.kid)
  if (!signer) throw new Error('La firma del servicio offline no pertenece al anillo fijado por Clarin.')
  requirePublicJwk(signer, 'El firmante de Clarin')
  const key = await importJWK(signer, 'ES256')
  const verified = await jwtVerify(descriptorJws, key, {
    algorithms: ['ES256'],
    issuer: DESCRIPTOR_ISSUER,
    audience: DESCRIPTOR_AUDIENCE,
    clockTolerance: CLOCK_TOLERANCE_SECONDS,
    currentDate: new Date(now),
  })
  const payload = verified.payload as ServiceDescriptorClaims
  if (payload.version !== 3) throw new Error('Versión de descriptor offline no admitida.')
  validateTimes(payload, MAX_DESCRIPTOR_SECONDS, now)
  requiredString(payload.jti, 'El identificador del descriptor')
  requiredString(payload.installation_id, 'La instalación')
  requiredString(payload.windows_principal_id, 'El usuario de Windows')
  if (requiredString(payload.browser_profile_id, 'El navegador') !== browserProfileId) throw new Error('El servicio offline pertenece a otro perfil de navegador.')
  if (requiredString(payload.server_origin, 'El origen') !== expectedOrigin) throw new Error('El servicio offline pertenece a otro origen de Clarin.')
  const transportJwk = requirePublicJwk(payload.transport_encryption_jwk, 'La clave de transporte')
  const serviceSigningJwk = requirePublicJwk(payload.service_signing_jwk, 'La clave de posesión')
  if (requiredString(payload.transport_encryption_kid, 'La clave de transporte') !== transportJwk.kid) throw new Error('El identificador de la clave de transporte no coincide.')
  if (requiredString(payload.service_signing_kid, 'La clave de posesión') !== serviceSigningJwk.kid) throw new Error('El identificador de la clave de posesión no coincide.')
  return payload
}

async function keyRingFingerprint(keys: OfflineKeyedJWK[]) {
  const fingerprints = await Promise.all(keys.map(async key => `${requiredString(key.kid, 'El firmante')}:${await calculateJwkThumbprint(requirePublicJwk(key, 'El firmante'), 'sha256')}`))
  return fingerprints.sort().join('|')
}

/** Call only with material received from an authenticated Clarin HTTPS response. */
export async function buildPinnedTransportTrust(
  identity: BrowserIdentityRecord,
  envelope: ServiceDescriptorEnvelope,
  serverOrigin = window.location.origin,
  now = Date.now(),
): Promise<BrowserTransportTrust> {
  if (!identity.browserProfileId) throw new Error('El perfil del navegador aún no está inscrito.')
  if (!Number.isSafeInteger(envelope.signer_public_keys.key_version) || envelope.signer_public_keys.key_version < 1 || envelope.signer_public_keys.keys.length === 0) {
    throw new Error('Clarin no entregó un anillo de firmas válido.')
  }
  await verifyDescriptor(envelope.service_descriptor, envelope.signer_public_keys.keys, identity.browserProfileId, serverOrigin, now)
  return {
    serverOrigin,
    descriptorJws: envelope.service_descriptor,
    signerKeys: envelope.signer_public_keys.keys,
    signerKeyVersion: envelope.signer_public_keys.key_version,
    pinnedAt: new Date(now).toISOString(),
  }
}

export async function verifyLocalServicePossession(
  identity: BrowserIdentityRecord,
  local: LocalServiceDescriptor,
  challenge: string,
  now = Date.now(),
  expectedOrigin = window.location.origin,
) {
  if (!identity.browserProfileId || !identity.trust) throw new Error('Falta fijar la identidad pública del servicio offline desde Clarin.')
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new Error('El reto de posesión local no es válido.')
  if (identity.trust.serverOrigin !== expectedOrigin) throw new Error('La identidad offline fue emitida por otro servidor.')
  if (local.service_descriptor !== identity.trust.descriptorJws) throw new Error('El servicio local presentó un descriptor diferente al autorizado.')
  if (local.signer_public_keys.key_version !== identity.trust.signerKeyVersion
    || await keyRingFingerprint(local.signer_public_keys.keys) !== await keyRingFingerprint(identity.trust.signerKeys)) {
    throw new Error('El servicio local presentó un anillo de firmas diferente al fijado por Clarin.')
  }
  const descriptor = await verifyDescriptor(local.service_descriptor, identity.trust.signerKeys, identity.browserProfileId, expectedOrigin, now)
  const possessionHeader = decodeProtectedHeader(local.possession)
  if (possessionHeader.alg !== 'ES256' || possessionHeader.typ !== POSSESSION_TYPE || possessionHeader.kid !== descriptor.service_signing_kid) {
    throw new Error('La prueba de posesión del servicio local no está permitida.')
  }
  const possessionKey = await importJWK(descriptor.service_signing_jwk, 'ES256')
  const verified = await jwtVerify(local.possession, possessionKey, {
    algorithms: ['ES256'],
    clockTolerance: CLOCK_TOLERANCE_SECONDS,
    currentDate: new Date(now),
  })
  const proof = verified.payload as PossessionClaims
  validateTimes(proof, MAX_POSSESSION_SECONDS, now)
  if (proof.version !== 3 || proof.purpose !== 'service-possession' || proof.challenge !== challenge) throw new Error('La prueba de posesión no responde al reto de este navegador.')
  for (const field of ['installation_id', 'windows_principal_id', 'browser_profile_id', 'server_origin'] as const) {
    if (proof[field] !== descriptor[field]) throw new Error('La prueba de posesión pertenece a otra identidad offline.')
  }
  return descriptor
}

export async function assertTrustedUnlockTransport(
  descriptor: ServiceDescriptorClaims,
  challengeJwk: OfflineJWK,
  serviceDescriptor: string,
  pinnedDescriptor: string,
) {
  if (serviceDescriptor !== pinnedDescriptor) throw new Error('El reto de contraseña no pertenece al servicio autorizado.')
  if (descriptor.transport_encryption_kid !== challengeJwk.kid) throw new Error('La clave de transporte local no coincide con la autorizada.')
  if (await calculateJwkThumbprint(descriptor.transport_encryption_jwk, 'sha256') !== await calculateJwkThumbprint(challengeJwk, 'sha256')) {
    throw new Error('La clave de transporte local fue sustituida.')
  }
}
