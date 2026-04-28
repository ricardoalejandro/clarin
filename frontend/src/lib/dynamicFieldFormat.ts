/**
 * Dynamic field formatter — Excel-like format for `DynamicText` placeholders.
 *
 * Supports: General, Number, Currency, Percent, Date, DateTime, Text, Custom
 * pattern. Custom pattern is a small subset of Excel:
 *   - Number tokens: `#`, `0`, `,`, `.`
 *   - Date tokens (when the pattern contains any of d/M/y/H/m/s): `d`, `dd`,
 *     `ddd`, `dddd`, `M`, `MM`, `MMM`, `MMMM`, `yy`, `yyyy`, `H`, `HH`, `h`,
 *     `hh`, `m`, `mm`, `s`, `ss`, `tt` (AM/PM)
 *   - Literal text via backslash escape or text between quotes
 *   - Section separator `;`: positive;negative;zero;text (minimal: only
 *     positive/negative supported)
 */

export type FieldFormatType =
  | 'general'
  | 'number'
  | 'currency'
  | 'percent'
  | 'date'
  | 'datetime'
  | 'text'
  | 'custom'

export type TextTransform = 'none' | 'uppercase' | 'lowercase' | 'capitalize'

export interface FieldFormat {
  type: FieldFormatType
  /** Decimal places (number/currency/percent). */
  decimals?: number
  /** Show thousands separator (number/currency/percent). */
  thousandsSep?: boolean
  /** Currency symbol, e.g. 'S/', '$', '€'. */
  currency?: string
  /** Placement of currency symbol. */
  currencyPos?: 'before' | 'after'
  /** Date preset token, e.g. 'dd/MM/yyyy'. */
  datePreset?: string
  /** Custom pattern (type='custom'). */
  pattern?: string
  /** Text transforms. */
  transform?: TextTransform
  /** Prefix/suffix literal text. */
  prefix?: string
  suffix?: string
}

export const DEFAULT_FIELD_FORMAT: FieldFormat = { type: 'general' }

export const DATE_PRESETS: { value: string; label: string }[] = [
  { value: 'dd/MM/yyyy', label: '21/04/2026' },
  { value: 'd/M/yyyy', label: '21/4/2026' },
  { value: 'yyyy-MM-dd', label: '2026-04-21' },
  { value: "d 'de' MMMM 'de' yyyy", label: '21 de abril de 2026' },
  { value: 'dd MMM yyyy', label: '21 abr 2026' },
  { value: 'dddd, d MMMM yyyy', label: 'martes, 21 abril 2026' },
  { value: 'dd/MM/yyyy HH:mm', label: '21/04/2026 14:30' },
  { value: 'dd/MM/yyyy hh:mm tt', label: '21/04/2026 02:30 PM' },
]

const MONTH_NAMES_LONG = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre']
const MONTH_NAMES_SHORT = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic']
const DAY_NAMES_LONG = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado']
const DAY_NAMES_SHORT = ['dom','lun','mar','mié','jue','vie','sáb']

// ─── Date formatting ──────────────────────────────────────────────────────────

function pad2(n: number): string { return n < 10 ? '0' + n : String(n) }

function formatDateWithPattern(date: Date, pattern: string): string {
  const d = date.getDate()
  const M = date.getMonth() // 0-11
  const y = date.getFullYear()
  const H = date.getHours()
  const h12 = H % 12 === 0 ? 12 : H % 12
  const m = date.getMinutes()
  const s = date.getSeconds()
  const dow = date.getDay()
  const tt = H < 12 ? 'AM' : 'PM'

  let out = ''
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]
    // Literal between single quotes
    if (ch === "'") {
      let j = i + 1
      while (j < pattern.length && pattern[j] !== "'") j++
      out += pattern.slice(i + 1, j)
      i = j + 1
      continue
    }
    // Escaped literal
    if (ch === '\\' && i + 1 < pattern.length) {
      out += pattern[i + 1]
      i += 2
      continue
    }
    // Match longest token first
    if (pattern.startsWith('dddd', i)) { out += DAY_NAMES_LONG[dow]; i += 4; continue }
    if (pattern.startsWith('ddd', i))  { out += DAY_NAMES_SHORT[dow]; i += 3; continue }
    if (pattern.startsWith('dd', i))   { out += pad2(d); i += 2; continue }
    if (ch === 'd')                    { out += String(d); i += 1; continue }
    if (pattern.startsWith('MMMM', i)) { out += MONTH_NAMES_LONG[M]; i += 4; continue }
    if (pattern.startsWith('MMM', i))  { out += MONTH_NAMES_SHORT[M]; i += 3; continue }
    if (pattern.startsWith('MM', i))   { out += pad2(M + 1); i += 2; continue }
    if (ch === 'M')                    { out += String(M + 1); i += 1; continue }
    if (pattern.startsWith('yyyy', i)) { out += String(y); i += 4; continue }
    if (pattern.startsWith('yy', i))   { out += pad2(y % 100); i += 2; continue }
    if (pattern.startsWith('HH', i))   { out += pad2(H); i += 2; continue }
    if (ch === 'H')                    { out += String(H); i += 1; continue }
    if (pattern.startsWith('hh', i))   { out += pad2(h12); i += 2; continue }
    if (ch === 'h')                    { out += String(h12); i += 1; continue }
    if (pattern.startsWith('mm', i))   { out += pad2(m); i += 2; continue }
    if (ch === 'm')                    { out += String(m); i += 1; continue }
    if (pattern.startsWith('ss', i))   { out += pad2(s); i += 2; continue }
    if (ch === 's')                    { out += String(s); i += 1; continue }
    if (pattern.startsWith('tt', i))   { out += tt; i += 2; continue }
    out += ch
    i += 1
  }
  return out
}

// ─── Number formatting ────────────────────────────────────────────────────────

function formatNumber(n: number, decimals: number | undefined, thousandsSep: boolean | undefined): string {
  const d = typeof decimals === 'number' ? Math.max(0, Math.min(10, decimals)) : 2
  const fixed = n.toFixed(d)
  if (!thousandsSep) return fixed
  const [intPart, fracPart] = fixed.split('.')
  const sign = intPart.startsWith('-') ? '-' : ''
  const digits = sign ? intPart.slice(1) : intPart
  const withSep = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return sign + withSep + (fracPart ? '.' + fracPart : '')
}

// ─── Custom pattern (very small subset of Excel) ──────────────────────────────

function isDatePattern(pattern: string): boolean {
  // Consider it a date pattern if it contains non-quoted d/M/y/H/h/m/s tokens.
  let inQuote = false
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === "'") { inQuote = !inQuote; continue }
    if (c === '\\') { i++; continue }
    if (inQuote) continue
    if ('dMyHhms'.includes(c)) return true
  }
  return false
}

function applyCustomNumberPattern(n: number, pattern: string): string {
  // Split on ';' into sections: positive;negative;zero
  const sections = pattern.split(';')
  let active = sections[0]
  if (n < 0 && sections.length > 1) active = sections[1]
  else if (n === 0 && sections.length > 2) active = sections[2]

  // If the chosen section doesn't have a sign indicator and we're negative, use abs
  const absN = n < 0 && sections.length > 1 ? Math.abs(n) : n

  // Count decimals from the pattern (digits after the last '.')
  const dotIdx = active.lastIndexOf('.')
  let decimals = 0
  if (dotIdx >= 0) {
    for (let i = dotIdx + 1; i < active.length; i++) {
      if (active[i] === '0' || active[i] === '#') decimals++
      else break
    }
  }
  const useThousands = /[#0],[#0]/.test(active)

  const numStr = formatNumber(absN, decimals, useThousands)
  const [intPart, fracPart] = numStr.split('.')

  // Walk pattern, replacing digit placeholders with actual digits in order
  let out = ''
  let intDigits = intPart.replace(/[^0-9\-]/g, '')
  let intIdx = 0
  let frac = fracPart || ''
  let fracIdx = 0
  let inIntPart = true
  let inQuote = false

  for (let i = 0; i < active.length; i++) {
    const c = active[i]
    if (c === "'") { inQuote = !inQuote; continue }
    if (inQuote) { out += c; continue }
    if (c === '\\' && i + 1 < active.length) { out += active[i + 1]; i++; continue }
    if (c === '.') { inIntPart = false; out += '.'; continue }
    if (c === ',' && inIntPart) {
      // thousands marker placed by formatNumber already
      continue
    }
    if (c === '0' || c === '#') {
      if (inIntPart) {
        // Pour remaining int digits on the FIRST digit placeholder.
        // (Simplification: works fine for typical patterns.)
        if (intIdx === 0) {
          out += intDigits
          intIdx = intDigits.length
        }
      } else {
        out += fracIdx < frac.length ? frac[fracIdx] : (c === '0' ? '0' : '')
        fracIdx++
      }
      continue
    }
    out += c
  }
  return out
}

// ─── Main entry ───────────────────────────────────────────────────────────────

function applyTextTransform(s: string, t: TextTransform | undefined): string {
  if (!t || t === 'none') return s
  if (t === 'uppercase') return s.toUpperCase()
  if (t === 'lowercase') return s.toLowerCase()
  // capitalize: first letter of each word (Unicode-aware via substring)
  return s.replace(/(^|\s|[-_/.,;:()[\]{}"'¡¿])(\S)/g, (_, sep: string, ch: string) => sep + ch.toUpperCase())
}

function coerceNumber(raw: unknown): number | null {
  if (raw == null) return null
  if (typeof raw === 'number') return isFinite(raw) ? raw : null
  if (typeof raw === 'boolean') return raw ? 1 : 0
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return null
    // Accept "1,234.56" or "1234.56"
    const cleaned = trimmed.replace(/,/g, '')
    const n = Number(cleaned)
    return isNaN(n) ? null : n
  }
  return null
}

function coerceDate(raw: unknown): Date | null {
  if (raw == null || raw === '') return null
  if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw
  if (typeof raw === 'string' || typeof raw === 'number') {
    const d = new Date(raw as any)
    return isNaN(d.getTime()) ? null : d
  }
  return null
}

export function formatFieldValue(raw: unknown, fmt?: FieldFormat): string {
  const f = fmt || DEFAULT_FIELD_FORMAT

  // If the source field has no value, render an empty string regardless of
  // format. This prevents orphaned currency symbols, prefixes, suffixes or
  // literal pattern characters from showing up when the data is missing —
  // otherwise the document layout ends up with rows of bare "S/" markers.
  const isEmpty =
    raw == null ||
    (typeof raw === 'string' && raw.trim() === '') ||
    (typeof raw === 'number' && !Number.isFinite(raw))
  if (isEmpty) return ''

  const str = (): string => {
    if (raw == null) return ''
    if (typeof raw === 'string') return raw
    if (raw instanceof Date) {
      return raw.toLocaleDateString('es-PE', { day: '2-digit', month: '2-digit', year: 'numeric' })
    }
    return String(raw)
  }

  let body = ''
  switch (f.type) {
    case 'number': {
      const n = coerceNumber(raw)
      body = n == null ? str() : formatNumber(n, f.decimals ?? 0, f.thousandsSep ?? true)
      break
    }
    case 'currency': {
      const n = coerceNumber(raw)
      const num = n == null ? str() : formatNumber(n, f.decimals ?? 2, f.thousandsSep ?? true)
      const sym = (f.currency ?? 'S/').trim()
      const space = sym ? ' ' : ''
      body = (f.currencyPos === 'after') ? `${num}${space}${sym}` : `${sym}${space}${num}`
      break
    }
    case 'percent': {
      const n = coerceNumber(raw)
      body = n == null ? str() : formatNumber(n, f.decimals ?? 0, f.thousandsSep ?? false) + '%'
      break
    }
    case 'date': {
      const d = coerceDate(raw)
      body = d ? formatDateWithPattern(d, f.datePreset || 'dd/MM/yyyy') : str()
      break
    }
    case 'datetime': {
      const d = coerceDate(raw)
      body = d ? formatDateWithPattern(d, f.datePreset || 'dd/MM/yyyy HH:mm') : str()
      break
    }
    case 'custom': {
      const p = f.pattern || ''
      if (!p) { body = str(); break }
      if (isDatePattern(p)) {
        const d = coerceDate(raw)
        body = d ? formatDateWithPattern(d, p) : str()
      } else {
        const n = coerceNumber(raw)
        body = n == null ? str() : applyCustomNumberPattern(n, p)
      }
      break
    }
    case 'text':
    case 'general':
    default:
      body = str()
      break
  }

  body = applyTextTransform(body, f.transform)
  if (f.prefix) body = f.prefix + body
  if (f.suffix) body = body + f.suffix
  return body
}
