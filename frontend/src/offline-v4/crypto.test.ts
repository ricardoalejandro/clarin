// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { SignJWT, importJWK } from 'jose'
import { createSigningKey, createVaultKey, decryptValue, encryptValue, unlockVaultKey, verifyLease } from './crypto'
import type { GrantIdentity } from './types'

const identity: GrantIdentity = { origin: 'https://clarin.test', browser_id: 'browser-a', grant_id: 'grant-a', user_id: 'user-a', account_id: 'account-a' }
const password = 'Contraseña segura de prueba 2026'
describe('browser-only encrypted vault', () => {
  it('round trips AES-GCM using a password-derived wrapping key without extractable DEKs', async () => {
    const vault = await createVaultKey(password, identity)
    expect(vault.key.extractable).toBe(false)
    const record = await encryptValue(vault.key, identity, 'task', 'task-a', { title: 'Privado' })
    const reopened = await unlockVaultKey(password, identity, vault.salt, vault.wrapped_key)
    expect(await decryptValue(reopened, identity, 'task', 'task-a', record)).toEqual({ title: 'Privado' })
    expect(JSON.stringify({ ...vault, record })).not.toContain(password)
    expect(JSON.stringify(record)).not.toContain('Privado')
  })
  it('rejects a wrong password and weak preparation passwords', async () => {
    await expect(createVaultKey('corta', identity)).rejects.toMatchObject({ code: 'password_too_short' })
    const vault = await createVaultKey(password, identity)
    await expect(unlockVaultKey('Una contraseña incorrecta', identity, vault.salt, vault.wrapped_key)).rejects.toMatchObject({ code: 'unlock_failed' })
  })
  it('counts Unicode code points consistently with the backend password policy', async () => {
    await expect(createVaultKey('😀'.repeat(6), identity)).rejects.toMatchObject({ code: 'password_too_short' })
    await expect(createVaultKey('😀'.repeat(12), identity)).resolves.toHaveProperty('wrapped_key')
    await expect(createVaultKey('😀'.repeat(257), identity)).rejects.toMatchObject({ code: 'password_too_long' })
  })
  it('binds ciphertext to browser, user, account, grant, origin, record kind and record id', async () => {
    const vault = await createVaultKey(password, identity)
    const record = await encryptValue(vault.key, identity, 'task', 'task-a', { title: 'Privado' })
    for (const field of ['origin', 'browser_id', 'user_id', 'account_id', 'grant_id']) {
      await expect(decryptValue(vault.key, { ...identity, [field]: 'another' }, 'task', 'task-a', record)).rejects.toMatchObject({ code: 'unlock_failed' })
    }
    await expect(decryptValue(vault.key, identity, 'conflict', 'task-a', record)).rejects.toThrow()
    await expect(decryptValue(vault.key, identity, 'task', 'task-b', record)).rejects.toThrow()
  })
  it('uses independent random salts and IVs and rejects altered ciphertext', async () => {
    const one = await createVaultKey(password, identity), two = await createVaultKey(password, identity)
    expect(one.salt).not.toBe(two.salt)
    const a = await encryptValue(one.key, identity, 'task', 'a', {}), b = await encryptValue(one.key, identity, 'task', 'a', {})
    expect(a.iv).not.toBe(b.iv)
    await expect(decryptValue(one.key, identity, 'task', 'a', { ...a, ciphertext: (a.ciphertext.startsWith('a') ? 'b' : 'a') + a.ciphertext.slice(1) })).rejects.toThrow()
  })
  it('verifies exact origin, identity, algorithm, key id, expiry and the 24-hour ceiling', async () => {
    const keys = await createSigningKey(), now = Math.floor(Date.now() / 1000), publicKey = { ...keys.public_jwk, kid: 'server-key' }
    const signingKey = await importJWK(keys.private_jwk, 'ES256')
    const token = await new SignJWT({ version: 4, browser_profile_id: identity.browser_id, grant_id: identity.grant_id, user_id: identity.user_id, account_id: identity.account_id, iat: now, exp: now + 86400 }).setIssuer('clarin-offline-v4').setAudience(identity.origin).setProtectedHeader({ alg: 'ES256', typ: 'clarin-offline-v4-lease+jwt', kid: 'server-key' }).sign(signingKey)
    expect((await verifyLease(token, [publicKey], identity)).grant_id).toBe(identity.grant_id)
    await expect(verifyLease(token, [publicKey], { ...identity, origin: 'https://other.test' })).rejects.toThrow()
    await expect(verifyLease(token, [publicKey], { ...identity, account_id: 'other' })).rejects.toThrow()
    await expect(verifyLease(token, [publicKey], identity, (now + 86401) * 1000)).rejects.toThrow()
    const tooLong = await new SignJWT({ version: 4, browser_profile_id: identity.browser_id, grant_id: identity.grant_id, user_id: identity.user_id, account_id: identity.account_id, iat: now, exp: now + 86401 }).setIssuer('clarin-offline-v4').setAudience(identity.origin).setProtectedHeader({ alg: 'ES256', typ: 'clarin-offline-v4-lease+jwt', kid: 'server-key' }).sign(signingKey)
    await expect(verifyLease(tooLong, [publicKey], identity)).rejects.toMatchObject({ code: 'invalid_lease_scope' })
  })
})
