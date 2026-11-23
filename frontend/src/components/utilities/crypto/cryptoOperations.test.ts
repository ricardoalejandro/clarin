// @vitest-environment node
import { decodeProtectedHeader } from 'jose'
import { describe, expect, it } from 'vitest'
import {
  decodeBase64, decodeUtf8, decryptJwe, encodeBase64, encodeHex, encodeUtf8, encryptJwe, generateAesKey,
  generateRsaKeys, hashText, MAX_CRYPTO_TEXT_BYTES,
} from './cryptoOperations'

describe('developer crypto utilities', () => {
  it('supports standard and URL-safe Base64 with Unicode and binary output', () => {
    const text = '\uFEFFCafé 🦊\n第二行'
    expect(decodeUtf8(decodeBase64(encodeBase64(encodeUtf8(text), 'base64'), 'base64'))).toBe(text)
    expect(encodeBase64(new Uint8Array([251, 255]), 'base64')).toBe('+/8=')
    expect(encodeBase64(new Uint8Array([251, 255]), 'base64url')).toBe('-_8')
    expect(decodeBase64('-_8=', 'base64url')).toEqual(new Uint8Array([251, 255]))
    expect(() => decodeUtf8(decodeBase64('/w==', 'base64'))).toThrow('no son texto UTF-8 válido')
    expect(() => decodeBase64('AB==', 'base64')).toThrow('válido')
    expect(() => decodeBase64('-_8=', 'base64')).toThrow('válido')
    expect(() => encodeUtf8('ñ'.repeat(MAX_CRYPTO_TEXT_BYTES / 2 + 1))).toThrow('1 MiB')
  })

  it('produces known SHA-256 and HMAC vectors and supports other SHA families', async () => {
    expect(encodeHex(await hashText('abc', 'SHA-256'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(encodeHex(await hashText('The quick brown fox jumps over the lazy dog', 'SHA-256', { value: 'key', format: 'utf8' })))
      .toBe('f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8')
    expect(await hashText('', 'SHA-384')).toHaveLength(48)
    expect(await hashText('', 'SHA-512')).toHaveLength(64)
  })

  it.each([['aes128', 128, 'A128GCM'], ['aes256', 256, 'A256GCM']] as const)('authenticates compact JWE with %s', async (profile, length, enc) => {
    const key = await generateAesKey(length)
    expect(decodeBase64(key, 'base64')).toHaveLength(length / 8)
    const message = 'Mensaje 🔐\nLínea 2'
    const token = await encryptJwe(message, profile, key)
    expect(decodeProtectedHeader(token)).toEqual({ alg: 'dir', enc })
    expect((await encryptJwe(message, profile, key)).split('.')[2]).not.toBe(token.split('.')[2])
    await expect(decryptJwe(token, profile, key)).resolves.toBe(message)
    await expect(decryptJwe(await encryptJwe('', profile, key), profile, key)).resolves.toBe('')
    await expect(decryptJwe(token, profile, await generateAesKey(length))).rejects.toThrow('No se pudo autenticar')
    const parts = token.split('.')
    parts[0] = encodeBase64(encodeUtf8(JSON.stringify({ alg: 'dir', enc, zip: 'DEF' })), 'base64url')
    await expect(decryptJwe(parts.join('.'), profile, key)).rejects.toThrow('sin compresión')
  })

  it('generates interoperable RSA PEM keys and encrypts more than an RSA block', async () => {
    const { publicKey, privateKey } = await generateRsaKeys(2048)
    expect(publicKey).toMatch(/^-----BEGIN PUBLIC KEY-----/)
    expect(privateKey).toMatch(/^-----BEGIN PRIVATE KEY-----/)
    const source = 'Mensaje más largo que un bloque RSA 👋 '.repeat(70)
    const token = await encryptJwe(source, 'rsa', publicKey)
    expect(decodeProtectedHeader(token)).toEqual({ alg: 'RSA-OAEP-256', enc: 'A256GCM' })
    await expect(decryptJwe(token, 'rsa', privateKey)).resolves.toBe(source)
    await expect(decryptJwe(token, 'rsa', publicKey)).rejects.toThrow('privada RSA')
    await expect(decryptJwe(token, 'aes256', await generateAesKey(256))).rejects.toThrow('algoritmo seleccionado')
  }, 10_000)
})
