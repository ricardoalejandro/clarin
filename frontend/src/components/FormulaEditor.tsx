'use client'

import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { AlertCircle, CheckCircle2 } from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface TagOption {
  name: string
  color: string
}

interface FormulaEditorProps {
  value: string
  onChange: (value: string) => void
  tags: TagOption[]
  placeholder?: string
  rows?: number
  compact?: boolean
  onValidChange?: (isValid: boolean) => void
}

type TokenType = 'string' | 'operator' | 'lparen' | 'rparen' | 'error'

interface Token {
  type: TokenType
  value: string
  start: number
  end: number
  closed?: boolean
  isLike?: boolean
}

interface AnalyzedToken extends Token {
  tagStatus: 'exists' | 'not-found' | 'pattern-match' | 'pattern-none' | 'na'
  matchCount?: number
  matchedTag?: TagOption
}

// ─── Tokenizer ─────────────────────────────────────────────────────────────────

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const boundary = (pos: number) => pos >= input.length || /[\s()"']/.test(input[pos])

  while (i < input.length) {
    // Skip whitespace
    if (/\s/.test(input[i])) { i++; continue }

    // Parentheses
    if (input[i] === '(') {
      tokens.push({ type: 'lparen', value: '(', start: i, end: i + 1 })
      i++; continue
    }
    if (input[i] === ')') {
      tokens.push({ type: 'rparen', value: ')', start: i, end: i + 1 })
      i++; continue
    }

    // Quoted string
    if (input[i] === '"') {
      const start = i
      i++ // skip opening quote
      let val = ''
      while (i < input.length && input[i] !== '"') { val += input[i]; i++ }
      const closed = i < input.length && input[i] === '"'
      if (closed) i++ // skip closing quote
      tokens.push({ type: 'string', value: val, start, end: i, closed, isLike: val.includes('%') })
      continue
    }

    // Keywords: and, or, not
    const rest = input.slice(i).toLowerCase()
    if (rest.startsWith('and') && boundary(i + 3)) {
      tokens.push({ type: 'operator', value: 'and', start: i, end: i + 3 }); i += 3; continue
    }
    if (rest.startsWith('or') && boundary(i + 2)) {
      tokens.push({ type: 'operator', value: 'or', start: i, end: i + 2 }); i += 2; continue
    }
    if (rest.startsWith('not') && boundary(i + 3)) {
      tokens.push({ type: 'operator', value: 'not', start: i, end: i + 3 }); i += 3; continue
    }

    // Unknown token → error
    const errStart = i
    while (i < input.length && !/[\s()"']/.test(input[i])) i++
    tokens.push({ type: 'error', value: input.slice(errStart, i), start: errStart, end: i })
  }
  return tokens
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getCursorContext(text: string, cursorPos: number) {
  let inQuotes = false
  let quoteStart = -1
  for (let i = 0; i < cursorPos; i++) {
    if (text[i] === '"') {
      if (!inQuotes) { inQuotes = true; quoteStart = i + 1 }
      else { inQuotes = false; quoteStart = -1 }
    }
  }
  if (inQuotes && quoteStart >= 0) {
    return { inQuotes: true, partial: text.slice(quoteStart, cursorPos), quoteStart }
  }
  return { inQuotes: false, partial: '', quoteStart: -1 }
}

function matchesPattern(tagName: string, pattern: string): boolean {
  const lp = pattern.toLowerCase()
  if (!lp.includes('%')) return tagName.toLowerCase() === lp
  const parts = lp.split('%')
  const regexStr = parts.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  try { return new RegExp('^' + regexStr + '$', 'i').test(tagName) }
  catch { return false }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function FormulaEditor({ value, onChange, tags, placeholder, rows = 4, compact = false, onValidChange }: FormulaEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [cursorPos, setCursorPos] = useState(0)
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [suggestionIndex, setSuggestionIndex] = useState(0)
  const pendingCursorRef = useRef<number | null>(null)

  // ─── Tokenization & Analysis ───────────────────────────────────────────────

  const tokens = useMemo(() => tokenize(value), [value])

  const analyzed: AnalyzedToken[] = useMemo(() => {
    return tokens.map(token => {
      if (token.type !== 'string' || !token.value) return { ...token, tagStatus: 'na' as const }
      if (tags.length === 0) return { ...token, tagStatus: 'na' as const }

      const lv = token.value.toLowerCase()
      if (token.isLike) {
        const matches = tags.filter(t => matchesPattern(t.name, lv))
        return {
          ...token,
          tagStatus: matches.length > 0 ? 'pattern-match' as const : 'pattern-none' as const,
          matchCount: matches.length,
          matchedTag: matches[0],
        }
      }
      const match = tags.find(t => t.name.toLowerCase() === lv)
      return { ...token, tagStatus: match ? 'exists' as const : 'not-found' as const, matchedTag: match || undefined }
    })
  }, [tokens, tags])

  // ─── Syntax Errors ─────────────────────────────────────────────────────────

  const syntaxErrors = useMemo(() => {
    const errs: string[] = []
    let depth = 0
    for (const t of tokens) {
      if (t.type === 'lparen') depth++
      if (t.type === 'rparen') depth--
      if (depth < 0) { errs.push('Paréntesis ")" sin apertura'); break }
    }
    if (depth > 0) errs.push(`Falta${depth > 1 ? 'n' : ''} ${depth} paréntesis de cierre`)
    for (const t of tokens) {
      if (t.type === 'string' && !t.closed) errs.push(`Falta cerrar comillas: "${t.value}`)
    }
    for (const t of tokens) {
      if (t.type === 'error') errs.push(`"${t.value}" no es válido — usa and, or, not o pon entre comillas`)
    }
    return errs
  }, [tokens])

  const unknownTags = analyzed.filter(t => t.tagStatus === 'not-found')
  const noMatchPatterns = analyzed.filter(t => t.tagStatus === 'pattern-none')
  const isSyntacticallyValid = syntaxErrors.length === 0
  const isFullyValid = isSyntacticallyValid && unknownTags.length === 0 && noMatchPatterns.length === 0

  // Report validity to parent (only syntax errors block save, not unknown tags)
  useEffect(() => {
    if (onValidChange) onValidChange(!value.trim() || isSyntacticallyValid)
  }, [value, isSyntacticallyValid, onValidChange])

  // ─── Autocomplete ──────────────────────────────────────────────────────────

  const cursorCtx = useMemo(() => getCursorContext(value, cursorPos), [value, cursorPos])

  const suggestions = useMemo(() => {
    if (!cursorCtx.inQuotes) return []
    const partial = cursorCtx.partial.toLowerCase()
    return tags
      .filter(t => !partial || t.name.toLowerCase().includes(partial))
      .slice(0, 10)
  }, [cursorCtx, tags])

  useEffect(() => {
    if (cursorCtx.inQuotes && suggestions.length > 0) {
      setShowSuggestions(true)
      setSuggestionIndex(0)
    } else {
      setShowSuggestions(false)
    }
  }, [cursorCtx.inQuotes, suggestions.length, cursorCtx.partial])

  // Set cursor position after inserting tag
  useEffect(() => {
    if (pendingCursorRef.current !== null && textareaRef.current) {
      const pos = pendingCursorRef.current
      textareaRef.current.selectionStart = pos
      textareaRef.current.selectionEnd = pos
      textareaRef.current.focus()
      setCursorPos(pos)
      pendingCursorRef.current = null
    }
  }, [value])

  // ─── Event Handlers ────────────────────────────────────────────────────────

  const handleSelect = useCallback(() => {
    if (textareaRef.current) setCursorPos(textareaRef.current.selectionStart)
  }, [])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value)
    setCursorPos(e.target.selectionStart)
  }, [onChange])

  const insertTag = useCallback((tag: TagOption) => {
    if (!cursorCtx.inQuotes) return
    const openQuotePos = cursorCtx.quoteStart - 1
    // Find extent: look for closing quote after cursor
    let closePos = value.indexOf('"', cursorPos)
    const hasClose = closePos !== -1
    if (hasClose) closePos += 1; else closePos = cursorPos

    const before = value.slice(0, openQuotePos)
    const after = value.slice(hasClose ? closePos : cursorPos)
    const tagLower = tag.name.toLowerCase()
    const newValue = before + '"' + tagLower + '"' + after
    pendingCursorRef.current = openQuotePos + 1 + tagLower.length + 1
    onChange(newValue)
    setShowSuggestions(false)
  }, [cursorCtx, cursorPos, value, onChange])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!showSuggestions || suggestions.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSuggestionIndex(i => Math.min(i + 1, suggestions.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSuggestionIndex(i => Math.max(i - 1, 0))
    } else if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault()
      insertTag(suggestions[suggestionIndex])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setShowSuggestions(false)
    }
  }, [showSuggestions, suggestions, suggestionIndex, insertTag])

  // ─── Sizing ─────────────────────────────────────────────────────────────────

  const sz = compact ? 'text-xs' : 'text-sm'
  const szSmall = compact ? 'text-[9px]' : 'text-[10px]'
  const szTiny = compact ? 'text-[8px]' : 'text-[9px]'

  // ─── Border color logic ─────────────────────────────────────────────────────

  const borderClass = !value.trim()
    ? 'border-slate-300 focus:ring-emerald-500/20'
    : isFullyValid
      ? 'border-emerald-400 focus:ring-emerald-500/20 bg-emerald-50/30'
      : syntaxErrors.length > 0
        ? 'border-red-400 focus:ring-red-500/20 bg-red-50/30'
        : 'border-amber-400 focus:ring-amber-500/20 bg-amber-50/20'

  return (
    <div className="space-y-2" ref={wrapperRef}>
      {/* Textarea with autocomplete */}
      <div className="relative">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onSelect={handleSelect}
          onClick={handleSelect}
          onKeyDown={handleKeyDown}
          rows={rows}
          spellCheck={false}
          className={`w-full px-3 py-2.5 border rounded-lg font-mono transition-colors text-slate-900 placeholder-slate-400 focus:ring-2 focus:outline-none ${sz} ${borderClass}`}
          placeholder={placeholder || '("04-mar" or "07-mar") and "iquitos" and not "elimi%"'}
        />

        {/* Validation icon */}
        {value.trim() && (
          <div className={`absolute ${compact ? 'top-2 right-2' : 'top-2.5 right-2.5'}`}>
            {isFullyValid ? (
              <CheckCircle2 className={`${compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} text-emerald-500`} />
            ) : syntaxErrors.length > 0 ? (
              <AlertCircle className={`${compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} text-red-500`} />
            ) : (
              <AlertCircle className={`${compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} text-amber-500`} />
            )}
          </div>
        )}

        {/* Autocomplete dropdown */}
        {showSuggestions && suggestions.length > 0 && (
          <div className="absolute left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-xl z-[60] overflow-hidden">
            <div className={`px-2.5 py-1.5 bg-slate-50 border-b border-slate-100 ${szSmall} text-slate-500 font-medium flex items-center justify-between`}>
              <span>Etiquetas disponibles</span>
              <span className="text-slate-400">↑↓ navegar · Tab insertar · Esc cerrar</span>
            </div>
            <div className="max-h-40 overflow-y-auto">
              {suggestions.map((tag, idx) => (
                <button
                  key={tag.name}
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); insertTag(tag) }}
                  className={`w-full flex items-center gap-2 px-2.5 py-1.5 ${sz} transition-colors text-left ${
                    idx === suggestionIndex ? 'bg-emerald-50 text-emerald-800' : 'hover:bg-slate-50 text-slate-700'
                  }`}
                >
                  <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: tag.color }} />
                  <span className="flex-1 truncate">{tag.name}</span>
                  <span className={`${szTiny} text-slate-400 font-mono`}>&quot;{tag.name.toLowerCase()}&quot;</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Token analysis strip */}
      {value.trim() && analyzed.length > 0 && (
        <div className="flex flex-wrap gap-1 items-center">
          {analyzed.map((token, i) => {
            if (token.type === 'lparen' || token.type === 'rparen') {
              return <span key={i} className={`${szSmall} text-slate-400 font-mono font-bold`}>{token.value}</span>
            }
            if (token.type === 'operator') {
              return (
                <span key={i} className={`${szTiny} font-bold uppercase px-1.5 py-0.5 rounded bg-violet-100 text-violet-700`}>
                  {token.value}
                </span>
              )
            }
            if (token.type === 'error') {
              return (
                <span key={i} className={`${szTiny} font-medium px-1.5 py-0.5 rounded bg-red-100 text-red-700 flex items-center gap-0.5`}>
                  <AlertCircle className="w-2.5 h-2.5" />
                  {token.value}
                </span>
              )
            }
            // String tokens — color by tag existence
            if (token.tagStatus === 'exists') {
              return (
                <span key={i} className={`${szTiny} font-medium px-1.5 py-0.5 rounded-full text-white flex items-center gap-0.5`}
                  style={{ backgroundColor: token.matchedTag?.color || '#10b981' }}>
                  <CheckCircle2 className="w-2.5 h-2.5" />
                  {token.value}
                </span>
              )
            }
            if (token.tagStatus === 'not-found') {
              return (
                <span key={i} className={`${szTiny} font-medium px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 flex items-center gap-0.5`}>
                  <AlertCircle className="w-2.5 h-2.5" />
                  {token.value}
                </span>
              )
            }
            if (token.tagStatus === 'pattern-match') {
              return (
                <span key={i} className={`${szTiny} font-medium px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 flex items-center gap-0.5`}>
                  {token.value}
                  <span className="ml-0.5 text-amber-500">({token.matchCount})</span>
                </span>
              )
            }
            if (token.tagStatus === 'pattern-none') {
              return (
                <span key={i} className={`${szTiny} font-medium px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 flex items-center gap-0.5`}>
                  <AlertCircle className="w-2.5 h-2.5" />
                  {token.value} (0)
                </span>
              )
            }
            // Fallback: na status (tags not loaded)
            if (token.type === 'string') {
              return (
                <span key={i} className={`${szTiny} font-medium px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-600`}>
                  {token.value}
                </span>
              )
            }
            return null
          })}
        </div>
      )}

      {/* Error messages */}
      {syntaxErrors.length > 0 && (
        <div className="space-y-0.5">
          {syntaxErrors.map((err, i) => (
            <p key={i} className={`${szSmall} text-red-600 flex items-center gap-1`}>
              <AlertCircle className="w-3 h-3 flex-shrink-0" />
              {err}
            </p>
          ))}
        </div>
      )}

      {/* Tag existence warnings (only when no syntax errors) */}
      {syntaxErrors.length === 0 && unknownTags.length > 0 && (
        <div className="space-y-0.5">
          {unknownTags.map((t, i) => (
            <p key={i} className={`${szSmall} text-amber-600 flex items-center gap-1`}>
              <AlertCircle className="w-3 h-3 flex-shrink-0" />
              &quot;{t.value}&quot; — etiqueta no encontrada
            </p>
          ))}
        </div>
      )}

      {/* Pattern match warnings */}
      {syntaxErrors.length === 0 && noMatchPatterns.length > 0 && (
        <div className="space-y-0.5">
          {noMatchPatterns.map((t, i) => (
            <p key={i} className={`${szSmall} text-amber-600 flex items-center gap-1`}>
              <AlertCircle className="w-3 h-3 flex-shrink-0" />
              &quot;{t.value}&quot; — ninguna etiqueta coincide con este patrón
            </p>
          ))}
        </div>
      )}
    </div>
  )
}
