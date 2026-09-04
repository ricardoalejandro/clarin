import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ADMIN_GENERATED_PASSWORD_LENGTH,
  ADMIN_PASSWORD_MAX_UTF8_BYTES,
  copyAdminPassword,
  evaluateAdminPassword,
  generateAdminPassword,
  getAdminPasswordChecks,
  isAdminPasswordValid,
  type AdminPasswordRandomSource,
} from './adminPassword'

afterEach(() => {
  vi.unstubAllGlobals()
})

function checksByKey(password: string) {
  return Object.fromEntries(getAdminPasswordChecks(password).map(check => [check.key, check.passed]))
}

function queuedRandomSource(bytes: number[]) {
  let calls = 0
  const source: AdminPasswordRandomSource = target => {
    calls += 1
    if (bytes.length === 0) throw new Error('deterministic_random_exhausted')
    target[0] = bytes.shift()!
    return target
  }
  return { source, calls: () => calls }
}

describe('administrative password policy', () => {
  it('counts Unicode code points instead of UTF-16 units', () => {
    const password = `Áa2!${'😀'.repeat(6)}`
    const evaluation = evaluateAdminPassword(password)

    expect(evaluation.codePointLength).toBe(10)
    expect(evaluation.valid).toBe(true)
  })

  it('uses Unicode letter and decimal-digit categories while excluding whitespace and ñ as symbols', () => {
    const withoutSymbol = 'A2345678ñ '
    expect(checksByKey(withoutSymbol)).toMatchObject({
      length: true,
      upper: true,
      lower: true,
      number: true,
      symbol: false,
    })

    const unicodeCategories = `Éclair!٢${'a'.repeat(3)}`
    expect(checksByKey(unicodeCategories)).toMatchObject({
      upper: true,
      lower: true,
      number: true,
      symbol: true,
    })
    expect(checksByKey(`Éclair!²${'a'.repeat(3)}`).number).toBe(false)
  })

  it('accepts exactly 72 UTF-8 bytes and rejects the next complete code point', () => {
    const exactly72Bytes = `A1!a${'é'.repeat(34)}`
    const over72Bytes = `${exactly72Bytes}é`

    expect(evaluateAdminPassword(exactly72Bytes).utf8ByteLength).toBe(ADMIN_PASSWORD_MAX_UTF8_BYTES)
    expect(evaluateAdminPassword(exactly72Bytes).valid).toBe(true)
    expect(evaluateAdminPassword(over72Bytes).utf8ByteLength).toBe(74)
    expect(checksByKey(over72Bytes).max_bytes).toBe(false)
  })

  it('requires a non-empty exact confirmation when one is supplied', () => {
    const password = 'Abcdefgh2!'
    expect(isAdminPasswordValid(password)).toBe(true)
    expect(isAdminPasswordValid(password, 'different')).toBe(false)
    expect(checksByKey('')).toMatchObject({ length: false, max_bytes: true })
  })
})

describe('administrative password generator', () => {
  it('always returns a valid 20-character non-ambiguous ASCII password', () => {
    const { source } = queuedRandomSource(Array(64).fill(0))
    const generated = generateAdminPassword(source)

    expect(generated).toHaveLength(ADMIN_GENERATED_PASSWORD_LENGTH)
    expect(generated).toMatch(/^[\x21-\x7E]+$/)
    expect(generated).not.toMatch(/[01IOilo]/)
    expect(isAdminPasswordValid(generated)).toBe(true)
  })

  it('rejects out-of-range bytes instead of introducing modulo bias', () => {
    const { source, calls } = queuedRandomSource([255, ...Array(64).fill(0)])
    const generated = generateAdminPassword(source)

    expect(generated).toHaveLength(ADMIN_GENERATED_PASSWORD_LENGTH)
    expect(calls()).toBe(40)
  })

  it('uses Web Crypto and never falls back to Math.random', () => {
    const getRandomValues = vi.fn((target: Uint8Array) => {
      target.fill(0)
      return target
    })
    vi.stubGlobal('crypto', { getRandomValues })
    const mathRandom = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random must not be used')
    })

    expect(generateAdminPassword()).toHaveLength(ADMIN_GENERATED_PASSWORD_LENGTH)
    expect(getRandomValues).toHaveBeenCalled()
    expect(mathRandom).not.toHaveBeenCalled()
  })

  it('fails closed when secure browser randomness is unavailable', () => {
    vi.stubGlobal('crypto', undefined)
    expect(() => generateAdminPassword()).toThrow('secure_random_unavailable')
  })
})

describe('administrative password clipboard', () => {
  it('copies only through the explicit clipboard dependency', async () => {
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) }
    await copyAdminPassword('Abcdefgh2!', clipboard)
    expect(clipboard.writeText).toHaveBeenCalledWith('Abcdefgh2!')
  })

  it('reports that the clipboard is unavailable instead of pretending success', async () => {
    await expect(copyAdminPassword('Abcdefgh2!', undefined)).rejects.toThrow('clipboard_unavailable')
  })
})
