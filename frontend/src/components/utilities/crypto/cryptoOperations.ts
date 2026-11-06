import { CompactEncrypt, compactDecrypt, decodeProtectedHeader, importPKCS8, importSPKI } from 'jose'

export const MAX_CRYPTO_TEXT_BYTES = 1024 * 1024
export const MAX_CRYPTO_ENCODED_CHARS = Math.ceil(MAX_CRYPTO_TEXT_BYTES / 3) * 4 + 4096
export const MAX_CRYPTO_PEM_CHARS = 16 * 1024
const encoder = new TextEncoder()

export type HashAlgorithm = 'SHA-256' | 'SHA-384' | 'SHA-512'
export type CipherAlgorithm = 'aes128' | 'aes256' | 'rsa'
export type Base64Format = 'base64' | 'base64url'

export class CryptoInputError extends Error {}

function webCrypto() {
  if (!globalThis.crypto?.subtle) throw new CryptoInputError('El navegador requiere una conexión HTTPS y compatibilidad con Web Crypto para esta operación.')
  return globalThis.crypto.subtle
}

export function encodeUtf8(source: string) {
  if (source.length > MAX_CRYPTO_TEXT_BYTES) throw new CryptoInputError('El texto supera el límite de 1 MiB en UTF-8.')
  const bytes = encoder.encode(source)
  if (bytes.byteLength > MAX_CRYPTO_TEXT_BYTES) throw new CryptoInputError('El texto supera el límite de 1 MiB en UTF-8.')
  return bytes
}

export function decodeUtf8(bytes: Uint8Array<ArrayBuffer>) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new CryptoInputError('Los datos no son texto UTF-8 válido. Elige una salida binaria cuando corresponda.')
  }
}

export function encodeBase64(bytes: Uint8Array, format: Base64Format) {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  const value = btoa(binary)
  return format === 'base64url' ? value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : value
}

export function decodeBase64(source: string, format: Base64Format, maxBytes = MAX_CRYPTO_TEXT_BYTES): Uint8Array<ArrayBuffer> {
  if (source.length > MAX_CRYPTO_ENCODED_CHARS) throw new CryptoInputError('La entrada codificada supera el límite de esta operación.')
  const clean = source.replace(/[\t\r\n ]/g, '')
  const alphabet = format === 'base64' ? /^[A-Za-z0-9+/]*={0,2}$/ : /^[A-Za-z0-9_-]*={0,2}$/
  if (!alphabet.test(clean) || (clean.includes('=') && clean.length % 4 !== 0)) throw new CryptoInputError(`El valor no tiene un formato ${format === 'base64' ? 'Base64' : 'Base64URL'} válido.`)
  const normalized = clean.replace(/=+$/, '')
  if (Math.floor(normalized.length * 3 / 4) > maxBytes) throw new CryptoInputError('Los datos decodificados superan el límite de esta operación.')
  try {
    const binary = atob(normalized.replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = Uint8Array.from(binary, (value) => value.charCodeAt(0))
    if (encodeBase64(bytes, format).replace(/=+$/, '') === normalized) return bytes
  } catch { /* Invalid encoding is reported without exposing the input. */ }
  throw new CryptoInputError(`El valor no tiene un formato ${format === 'base64' ? 'Base64' : 'Base64URL'} válido.`)
}

export function encodeHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function hashText(source: string, algorithm: HashAlgorithm, hmacKey?: { value: string; format: 'utf8' | 'base64' }) {
  const subtle = webCrypto()
  const data = encodeUtf8(source)
  if (!hmacKey) return new Uint8Array(await subtle.digest(algorithm, data))
  const material = hmacKey.format === 'utf8' ? encodeUtf8(hmacKey.value) : decodeBase64(hmacKey.value, 'base64', 16 * 1024)
  try {
    if (material.length === 0 || material.length > 16 * 1024) throw new CryptoInputError('Ingresa una clave HMAC de 1 byte a 16 KiB.')
    const key = await subtle.importKey('raw', material, { name: 'HMAC', hash: algorithm }, false, ['sign'])
    return new Uint8Array(await subtle.sign('HMAC', key, data))
  } finally {
    material.fill(0)
  }
}

const profiles = {
  aes128: { alg: 'dir', enc: 'A128GCM', bytes: 16 },
  aes256: { alg: 'dir', enc: 'A256GCM', bytes: 32 },
  rsa: { alg: 'RSA-OAEP-256', enc: 'A256GCM', bytes: 0 },
} as const

async function importCipherKey(profile: CipherAlgorithm, value: string, operation: 'encrypt' | 'decrypt') {
  if (profile !== 'rsa') {
    const raw = decodeBase64(value, 'base64', 64)
    if (raw.length === profiles[profile].bytes) return raw
    raw.fill(0)
    throw new CryptoInputError(`Ingresa una clave AES de ${profiles[profile].bytes * 8} bits en Base64.`)
  }

  const pem = value.trim()
  const label = operation === 'encrypt' ? 'PUBLIC KEY' : 'PRIVATE KEY'
  const format = operation === 'encrypt' ? 'pública RSA en formato PEM (SPKI)' : 'privada RSA en formato PEM (PKCS#8)'
  if (pem.length <= MAX_CRYPTO_PEM_CHARS && pem.startsWith(`-----BEGIN ${label}-----`) && pem.endsWith(`-----END ${label}-----`)) {
    try {
      return await (operation === 'encrypt' ? importSPKI(pem, 'RSA-OAEP-256') : importPKCS8(pem, 'RSA-OAEP-256'))
    } catch { /* Do not expose imported key text in a browser error. */ }
  }
  throw new CryptoInputError(`Ingresa una clave ${format} válida.`)
}

export async function encryptJwe(source: string, profile: CipherAlgorithm, keyValue: string) {
  webCrypto()
  const bytes = encodeUtf8(source)
  const { alg, enc } = profiles[profile]
  const key = await importCipherKey(profile, keyValue, 'encrypt')
  try {
    return await new CompactEncrypt(bytes).setProtectedHeader({ alg, enc }).encrypt(key)
  } catch {
    throw new CryptoInputError('No se pudo cifrar. Comprueba que la clave corresponda al algoritmo seleccionado.')
  } finally {
    bytes.fill(0)
    if (key instanceof Uint8Array) key.fill(0)
  }
}

export async function decryptJwe(source: string, profile: CipherAlgorithm, keyValue: string) {
  webCrypto()
  if (source.length > MAX_CRYPTO_ENCODED_CHARS) throw new CryptoInputError('El JWE supera el límite de esta operación.')
  const jwe = source.trim()
  const { alg, enc } = profiles[profile]
  try {
    const header = decodeProtectedHeader(jwe)
    if (header.alg !== alg || header.enc !== enc || 'zip' in header) throw new CryptoInputError('El JWE debe usar el algoritmo seleccionado y venir sin compresión.')
  } catch (error) {
    if (error instanceof CryptoInputError) throw error
    throw new CryptoInputError('Ingresa un JWE compacto válido.')
  }
  const key = await importCipherKey(profile, keyValue, 'decrypt')
  let plaintext: Uint8Array<ArrayBuffer> | undefined
  try {
    const opened = await compactDecrypt(jwe, key, { keyManagementAlgorithms: [alg], contentEncryptionAlgorithms: [enc] })
    plaintext = new Uint8Array(opened.plaintext)
    opened.plaintext.fill(0)
    if (plaintext.length > MAX_CRYPTO_TEXT_BYTES) throw new CryptoInputError('El texto descifrado supera el límite de 1 MiB.')
    return decodeUtf8(plaintext)
  } catch (error) {
    if (error instanceof CryptoInputError) throw error
    throw new CryptoInputError('No se pudo autenticar el JWE. Comprueba la clave y que el contenido esté completo.')
  } finally {
    plaintext?.fill(0)
    if (key instanceof Uint8Array) key.fill(0)
  }
}

export async function generateAesKey(length: 128 | 256) {
  const subtle = webCrypto()
  const key = await subtle.generateKey({ name: 'AES-GCM', length }, true, ['encrypt', 'decrypt'])
  const bytes = new Uint8Array(await subtle.exportKey('raw', key))
  try {
    return encodeBase64(bytes, 'base64')
  } finally {
    bytes.fill(0)
  }
}

function encodePem(label: 'PUBLIC KEY' | 'PRIVATE KEY', bytes: Uint8Array) {
  const lines = encodeBase64(bytes, 'base64').match(/.{1,64}/g)?.join('\n')
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`
}

export async function generateRsaKeys(modulusLength: 2048 | 3072) {
  const subtle = webCrypto()
  const keyPair = await subtle.generateKey({ name: 'RSA-OAEP', modulusLength, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt'])
  const publicKey = new Uint8Array(await subtle.exportKey('spki', keyPair.publicKey))
  const privateKey = new Uint8Array(await subtle.exportKey('pkcs8', keyPair.privateKey))
  try {
    return { publicKey: encodePem('PUBLIC KEY', publicKey), privateKey: encodePem('PRIVATE KEY', privateKey) }
  } finally {
    privateKey.fill(0)
  }
}
