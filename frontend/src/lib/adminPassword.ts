export const ADMIN_PASSWORD_MIN_CODE_POINTS = 10
export const ADMIN_PASSWORD_MAX_UTF8_BYTES = 72
export const ADMIN_GENERATED_PASSWORD_LENGTH = 20

export type AdminPasswordCheckKey =
  | 'length'
  | 'max_bytes'
  | 'upper'
  | 'lower'
  | 'number'
  | 'symbol'
  | 'match'

export interface AdminPasswordCheck {
  key: AdminPasswordCheckKey
  label: string
  passed: boolean
}

export interface AdminPasswordEvaluation {
  codePointLength: number
  utf8ByteLength: number
  checks: AdminPasswordCheck[]
  valid: boolean
}

export type AdminPasswordRandomSource = (target: Uint8Array) => Uint8Array

export interface AdminPasswordClipboard {
  writeText: (text: string) => Promise<void>
}

const UPPERCASE_CHARACTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const LOWERCASE_CHARACTERS = 'abcdefghjkmnpqrstuvwxyz'
const NUMBER_CHARACTERS = '23456789'
const SYMBOL_CHARACTERS = '!#$%&*+-=?@^_'
const ALL_GENERATED_CHARACTERS = `${UPPERCASE_CHARACTERS}${LOWERCASE_CHARACTERS}${NUMBER_CHARACTERS}${SYMBOL_CHARACTERS}`

const UPPERCASE_PATTERN = new RegExp('\\p{Lu}', 'u')
const LOWERCASE_PATTERN = new RegExp('\\p{Ll}', 'u')
const NUMBER_PATTERN = new RegExp('\\p{Nd}', 'u')
const SYMBOL_PATTERN = new RegExp('[\\p{P}\\p{S}]', 'u')

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function evaluateAdminPassword(password: string, confirmation?: string): AdminPasswordEvaluation {
  const codePointLength = Array.from(password).length
  const byteLength = utf8ByteLength(password)
  const checks: AdminPasswordCheck[] = [
    {
      key: 'length',
      label: `${ADMIN_PASSWORD_MIN_CODE_POINTS} caracteres Unicode como mínimo`,
      passed: codePointLength >= ADMIN_PASSWORD_MIN_CODE_POINTS,
    },
    {
      key: 'max_bytes',
      label: `${ADMIN_PASSWORD_MAX_UTF8_BYTES} bytes UTF-8 como máximo`,
      passed: byteLength <= ADMIN_PASSWORD_MAX_UTF8_BYTES,
    },
    { key: 'upper', label: 'Una letra mayúscula', passed: UPPERCASE_PATTERN.test(password) },
    { key: 'lower', label: 'Una letra minúscula', passed: LOWERCASE_PATTERN.test(password) },
    { key: 'number', label: 'Un número', passed: NUMBER_PATTERN.test(password) },
    { key: 'symbol', label: 'Un signo o símbolo', passed: SYMBOL_PATTERN.test(password) },
  ]

  if (confirmation !== undefined) {
    checks.push({
      key: 'match',
      label: 'Las contraseñas coinciden',
      passed: password.length > 0 && password === confirmation,
    })
  }

  return {
    codePointLength,
    utf8ByteLength: byteLength,
    checks,
    valid: checks.every(check => check.passed),
  }
}

export function getAdminPasswordChecks(password: string, confirmation?: string): AdminPasswordCheck[] {
  return evaluateAdminPassword(password, confirmation).checks
}

export function getAdminPasswordIssues(password: string, confirmation?: string): string[] {
  return getAdminPasswordChecks(password, confirmation)
    .filter(check => !check.passed)
    .map(check => check.label.toLowerCase())
}

export function isAdminPasswordValid(password: string, confirmation?: string): boolean {
  return evaluateAdminPassword(password, confirmation).valid
}

function fillWithSecureRandomBytes(target: Uint8Array): Uint8Array {
  const webCrypto = globalThis.crypto
  if (!webCrypto?.getRandomValues) {
    throw new Error('secure_random_unavailable')
  }
  return webCrypto.getRandomValues(target)
}

function randomIndex(upperBound: number, randomSource: AdminPasswordRandomSource): number {
  if (!Number.isSafeInteger(upperBound) || upperBound < 1 || upperBound > 256) {
    throw new RangeError('random_upper_bound_invalid')
  }

  const acceptanceLimit = 256 - (256 % upperBound)
  for (;;) {
    const randomBytes = randomSource(new Uint8Array(1))
    if (!(randomBytes instanceof Uint8Array) || randomBytes.byteLength < 1) {
      throw new Error('secure_random_source_invalid')
    }
    const candidate = randomBytes[0]
    if (candidate < acceptanceLimit) return candidate % upperBound
  }
}

function randomCharacter(characters: string, randomSource: AdminPasswordRandomSource): string {
  return characters[randomIndex(characters.length, randomSource)]
}

/**
 * Generates the single Clarin administrative password shape: 20 non-ambiguous
 * ASCII characters with every required category represented. All selections and
 * the Fisher-Yates shuffle use rejection sampling so modulo bias is not added.
 */
export function generateAdminPassword(
  randomSource: AdminPasswordRandomSource = fillWithSecureRandomBytes,
): string {
  const characters = [
    randomCharacter(UPPERCASE_CHARACTERS, randomSource),
    randomCharacter(LOWERCASE_CHARACTERS, randomSource),
    randomCharacter(NUMBER_CHARACTERS, randomSource),
    randomCharacter(SYMBOL_CHARACTERS, randomSource),
  ]

  while (characters.length < ADMIN_GENERATED_PASSWORD_LENGTH) {
    characters.push(randomCharacter(ALL_GENERATED_CHARACTERS, randomSource))
  }

  for (let index = characters.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(index + 1, randomSource)
    ;[characters[index], characters[swapIndex]] = [characters[swapIndex], characters[index]]
  }

  return characters.join('')
}

export async function copyAdminPassword(
  password: string,
  clipboard: AdminPasswordClipboard | undefined = globalThis.navigator?.clipboard,
): Promise<void> {
  if (!clipboard?.writeText) throw new Error('clipboard_unavailable')
  await clipboard.writeText(password)
}
