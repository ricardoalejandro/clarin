import { SignJWT, calculateJwkThumbprint, importJWK } from 'jose'
import type { BrowserIdentityRecord, BrowserTransportTrust, OfflineJWK } from './types'

const DB_NAME = 'clarin-offline-v3-public'
const STORE_NAME = 'browser-identity'
const RECORD_KEY = 'active'
let browserIdentityCreation: Promise<BrowserIdentityRecord> | null = null

function openIdentityDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('No se pudo abrir la identidad protegida del navegador.'))
  })
}

async function databaseRequest<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) {
  const database = await openIdentityDatabase()
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode)
      const request = action(transaction.objectStore(STORE_NAME))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error || new Error('No se pudo guardar la identidad del navegador.'))
      transaction.onabort = () => reject(transaction.error || new Error('La operación de identidad fue cancelada.'))
    })
  } finally {
    database.close()
  }
}

export async function loadBrowserIdentity(): Promise<BrowserIdentityRecord | null> {
  return (await databaseRequest('readonly', store => store.get(RECORD_KEY))) || null
}

export async function saveBrowserIdentity(identity: BrowserIdentityRecord): Promise<void> {
  await databaseRequest('readwrite', store => store.put(identity, RECORD_KEY))
}

export async function createBrowserIdentity(): Promise<BrowserIdentityRecord> {
  const keys = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const publicJwk = await crypto.subtle.exportKey('jwk', keys.publicKey) as OfflineJWK
  const identity: BrowserIdentityRecord = {
    version: 1,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    publicJwk,
    createdAt: new Date().toISOString(),
  }
  try {
    await databaseRequest('readwrite', store => store.add(identity, RECORD_KEY))
    return identity
  } catch (error) {
    if ((error as DOMException).name !== 'ConstraintError') throw error
    const winner = await loadBrowserIdentity()
    if (!winner) throw error
    return winner
  }
}

export async function loadOrCreateBrowserIdentity(): Promise<BrowserIdentityRecord> {
  const existing = await loadBrowserIdentity()
  if (existing) return existing
  if (!browserIdentityCreation) {
    browserIdentityCreation = createBrowserIdentity().finally(() => { browserIdentityCreation = null })
  }
  return browserIdentityCreation
}

export async function attachBrowserProfile(identity: BrowserIdentityRecord, browserProfileId: string) {
  const next = { ...identity, browserProfileId }
  await saveBrowserIdentity(next)
  return next
}

export async function rememberPendingEnrollment(identity: BrowserIdentityRecord, requestId: string) {
  const ids = [requestId, ...(identity.pendingEnrollmentRequestIds || []).filter(id => id !== requestId)].slice(0, 20)
  const next = { ...identity, pendingEnrollmentRequestIds: ids }
  await saveBrowserIdentity(next)
  return next
}

export async function forgetPendingEnrollment(identity: BrowserIdentityRecord, requestId: string) {
  const next = { ...identity, pendingEnrollmentRequestIds: (identity.pendingEnrollmentRequestIds || []).filter(id => id !== requestId) }
  await saveBrowserIdentity(next)
  return next
}

export async function pinBrowserTransportTrust(identity: BrowserIdentityRecord, trust: BrowserTransportTrust) {
  if (trust.serverOrigin !== window.location.origin) throw new Error('El descriptor offline pertenece a otro servidor.')
  const next = { ...identity, trust }
  await saveBrowserIdentity(next)
  return next
}

export function base64URL(bytes: Uint8Array) {
  let binary = ''
  bytes.forEach(byte => { binary += String.fromCharCode(byte) })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function randomBase64URL(byteLength: number) {
  return base64URL(crypto.getRandomValues(new Uint8Array(byteLength)))
}

export async function capabilityHash(capability: string) {
  return base64URL(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(capability))))
}

export async function publicKeyThumbprint(publicJwk: OfflineJWK) {
  return calculateJwkThumbprint(publicJwk, 'sha256')
}

export async function createDPoPProof({
  identity,
  method,
  url,
  nonce,
  capability,
  enrollment,
}: {
  identity: BrowserIdentityRecord
  method: string
  url: string
  nonce: string
  capability?: string
  enrollment?: boolean
}) {
  const claims: Record<string, unknown> = {
    htm: method.toUpperCase(),
    htu: new URL(url).toString(),
    nonce,
  }
  if (capability) claims.ath = await capabilityHash(capability)
  const protectedHeader = enrollment
    ? { typ: 'dpop+jwt', alg: 'ES256', jwk: identity.publicJwk }
    : { typ: 'dpop+jwt', alg: 'ES256', kid: identity.browserProfileId }

  return new SignJWT(claims)
    .setProtectedHeader(protectedHeader)
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .sign(identity.privateKey)
}

export async function signBrowserClaims(identity: BrowserIdentityRecord, claims: Record<string, unknown>, typ: string) {
  if (!identity.browserProfileId) throw new Error('El perfil del navegador aún no está inscrito.')
  return new SignJWT(claims)
    .setProtectedHeader({ typ, alg: 'ES256', kid: identity.browserProfileId })
    .sign(identity.privateKey)
}

export async function importEncryptionKey(jwk: OfflineJWK) {
  return importJWK(jwk, 'ECDH-ES+A256KW')
}
