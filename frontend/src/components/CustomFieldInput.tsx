'use client'

import { useState, useRef, useEffect } from 'react'
import { Check, X, ExternalLink, Phone, Mail, Bold, Italic, Underline } from 'lucide-react'
import { CustomFieldDefinition, CustomFieldValue, CustomFieldType } from '@/types/custom-field'

// ─── HTML helpers for rich text variant ──────────────────────────────────────

/** Strip all HTML tags and decode entities. Used for length counting and plain display. */
function stripHtml(html: string): string {
  if (!html) return ''
  if (typeof document === 'undefined') return html.replace(/<[^>]*>/g, '')
  const tmp = document.createElement('div')
  tmp.innerHTML = html
  return tmp.textContent || tmp.innerText || ''
}

/** Sanitize HTML allowing only a minimal set of inline formatting tags. */
const RICH_TAG_WHITELIST = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'BR', 'DIV', 'SPAN', 'P'])
function sanitizeRichHtml(html: string): string {
  if (!html || typeof document === 'undefined') return html
  const tmp = document.createElement('div')
  tmp.innerHTML = html
  const walker = (node: Node) => {
    const children = Array.from(node.childNodes)
    for (const child of children) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as HTMLElement
        if (!RICH_TAG_WHITELIST.has(el.tagName)) {
          // Unwrap: replace element with its children
          while (el.firstChild) el.parentNode?.insertBefore(el.firstChild, el)
          el.parentNode?.removeChild(el)
        } else {
          // Strip attributes (no style/onclick etc.)
          while (el.attributes.length > 0) el.removeAttribute(el.attributes[0].name)
          walker(el)
        }
      } else if (child.nodeType !== Node.TEXT_NODE) {
        child.parentNode?.removeChild(child)
      }
    }
  }
  walker(tmp)
  return tmp.innerHTML
}

interface CustomFieldInputProps {
  definition: CustomFieldDefinition
  value?: CustomFieldValue | null
  onSave: (fieldId: string, value: any) => Promise<void>
  disabled?: boolean
}

function getDisplayValue(def: CustomFieldDefinition, val?: CustomFieldValue | null): string {
  if (!val) return ''
  switch (def.field_type) {
    case 'text':
    case 'email':
    case 'phone':
    case 'url':
      return val.value_text || ''
    case 'number':
      return val.value_number != null ? String(val.value_number) : ''
    case 'currency':
      if (val.value_number == null) return ''
      const sym = def.config?.symbol || '$'
      const dec = def.config?.decimals ?? 2
      return `${sym} ${val.value_number.toLocaleString('es-PE', { minimumFractionDigits: dec, maximumFractionDigits: dec })}`
    case 'date':
      if (!val.value_date) return ''
      try {
        return new Date(val.value_date).toLocaleDateString('es-PE', { year: 'numeric', month: 'short', day: 'numeric' })
      } catch { return val.value_date }
    case 'checkbox':
      return val.value_bool ? 'Sí' : 'No'
    case 'select':
      if (!val.value_text) return ''
      const opt = def.config?.options?.find(o => o.value === val.value_text)
      return opt?.label || val.value_text
    case 'multi_select':
      if (!val.value_json || val.value_json.length === 0) return ''
      return val.value_json.map(v => {
        const o = def.config?.options?.find(opt => opt.value === v)
        return o?.label || v
      }).join(', ')
    default:
      return ''
  }
}

function getRawEditValue(def: CustomFieldDefinition, val?: CustomFieldValue | null): string {
  if (!val) return def.default_value || ''
  switch (def.field_type) {
    case 'text':
    case 'email':
    case 'phone':
    case 'url':
      return val.value_text || ''
    case 'number':
    case 'currency':
      return val.value_number != null ? String(val.value_number) : ''
    case 'date':
      if (!val.value_date) return ''
      try {
        return new Date(val.value_date).toISOString().split('T')[0]
      } catch { return '' }
    case 'select':
      return val.value_text || ''
    default:
      return ''
  }
}

export default function CustomFieldInput({ definition, value, onSave, disabled }: CustomFieldInputProps) {
  const [editing, setEditing] = useState(false)
  const [editVal, setEditVal] = useState('')
  const [editBool, setEditBool] = useState(false)
  const [editMulti, setEditMulti] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [richLen, setRichLen] = useState(0)
  const inputRef = useRef<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(null)
  const richRef = useRef<HTMLDivElement>(null)
  const savingRef = useRef(false)

  const textVariant = definition.field_type === 'text' ? (definition.config?.text_variant || 'inline') : 'inline'
  const maxLen = definition.config?.max_length

  const startEdit = () => {
    if (disabled) return
    if (definition.field_type === 'checkbox') {
      // Toggle immediately
      handleToggleCheckbox()
      return
    }
    if (definition.field_type === 'multi_select') {
      setEditMulti(value?.value_json || [])
      setEditing(true)
      return
    }
    setEditVal(getRawEditValue(definition, value))
    setEditing(true)
  }

  useEffect(() => {
    if (!editing) return
    if (textVariant === 'rich' && richRef.current) {
      // Seed the contentEditable div with the stored HTML and focus
      richRef.current.innerHTML = sanitizeRichHtml(editVal || '')
      setRichLen(stripHtml(editVal || '').length)
      // Place cursor at end
      const range = document.createRange()
      range.selectNodeContents(richRef.current)
      range.collapse(false)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
      richRef.current.focus()
    } else if (inputRef.current) {
      inputRef.current.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing])

  const handleToggleCheckbox = async () => {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    try {
      await onSave(definition.id, { value: !(value?.value_bool ?? false) })
    } finally {
      setSaving(false)
      savingRef.current = false
    }
  }

  const handleSave = async () => {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setEditing(false)
    try {
      const ft = definition.field_type
      let val: any = null
      if (ft === 'text') {
        if (textVariant === 'rich' && richRef.current) {
          const clean = sanitizeRichHtml(richRef.current.innerHTML).trim()
          // Store empty when there is no text content
          val = stripHtml(clean).trim() ? clean : null
        } else {
          val = editVal.trim() || null
        }
      } else if (ft === 'email' || ft === 'phone' || ft === 'url') {
        val = editVal.trim() || null
      } else if (ft === 'select') {
        val = editVal || null
      } else if (ft === 'number' || ft === 'currency') {
        val = editVal !== '' ? Number(editVal) : null
      } else if (ft === 'date') {
        val = editVal || null
      } else if (ft === 'multi_select') {
        val = editMulti.length > 0 ? editMulti : null
      }
      await onSave(definition.id, { value: val })
    } finally {
      setSaving(false)
      savingRef.current = false
    }
  }

  const handleCancel = () => {
    setEditing(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Allow newlines in textarea / rich variants: only save on Ctrl/Cmd+Enter
    const isMultiline = definition.field_type === 'text' && (textVariant === 'textarea' || textVariant === 'rich')
    if (e.key === 'Enter' && definition.field_type !== 'multi_select') {
      if (isMultiline && !(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      handleSave()
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      handleCancel()
    }
  }

  const execRich = (cmd: 'bold' | 'italic' | 'underline') => {
    if (!richRef.current) return
    richRef.current.focus()
    document.execCommand(cmd, false)
    setRichLen(stripHtml(richRef.current.innerHTML).length)
  }

  const toggleMultiOption = (optValue: string) => {
    setEditMulti(prev => prev.includes(optValue) ? prev.filter(v => v !== optValue) : [...prev, optValue])
  }

  const display = getDisplayValue(definition, value)
  const isEmpty = definition.field_type === 'text' && textVariant === 'rich'
    ? !stripHtml(value?.value_text || '').trim()
    : !display
  const isRequired = definition.is_required && isEmpty

  // Checkbox — inline toggle
  if (definition.field_type === 'checkbox') {
    return (
      <div className="flex items-center justify-between py-1.5 group">
        <span className="text-xs text-slate-500 truncate flex-1">{definition.name}</span>
        <button
          onClick={handleToggleCheckbox}
          disabled={disabled || saving}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            value?.value_bool ? 'bg-emerald-600' : 'bg-slate-200'
          } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
        >
          <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform shadow-sm ${
            value?.value_bool ? 'translate-x-4' : 'translate-x-0.5'
          }`} />
        </button>
      </div>
    )
  }

  // Multi-select — checkboxes
  if (definition.field_type === 'multi_select' && editing) {
    return (
      <div className="py-1.5 space-y-1">
        <span className="text-xs text-slate-500">{definition.name}</span>
        <div className="space-y-1 max-h-32 overflow-y-auto">
          {(definition.config?.options || []).map(opt => (
            <label key={opt.value} className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-slate-50 cursor-pointer">
              <input
                type="checkbox"
                checked={editMulti.includes(opt.value)}
                onChange={() => toggleMultiOption(opt.value)}
                className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
              />
              <span className="text-sm text-slate-700">{opt.label}</span>
            </label>
          ))}
        </div>
        <div className="flex gap-1.5 pt-1">
          <button onClick={handleSave} disabled={saving} className="px-2 py-1 bg-emerald-600 text-white text-[10px] font-medium rounded-lg hover:bg-emerald-700 transition">
            <Check className="w-3 h-3" />
          </button>
          <button onClick={handleCancel} className="px-2 py-1 text-slate-400 hover:text-slate-600 text-[10px] rounded-lg hover:bg-slate-100 transition">
            <X className="w-3 h-3" />
          </button>
        </div>
      </div>
    )
  }

  // Editing mode — input field
  if (editing) {
    // Counter helpers
    const currentLen = definition.field_type === 'text' && textVariant === 'rich' ? richLen : editVal.length
    const showCounter = definition.field_type === 'text' && !!maxLen
    const counterColor =
      !showCounter ? '' :
      maxLen && currentLen >= maxLen ? 'text-rose-500' :
      maxLen && currentLen >= Math.floor(maxLen * 0.9) ? 'text-amber-500' :
      'text-slate-400'

    return (
      <div className="py-1.5 space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-500">{definition.name}</span>
          {showCounter && (
            <span className={`text-[10px] font-mono ${counterColor}`}>{currentLen}/{maxLen}</span>
          )}
        </div>
        {definition.field_type === 'select' ? (
          <select
            ref={inputRef as React.RefObject<HTMLSelectElement>}
            value={editVal}
            onChange={e => setEditVal(e.target.value)}
            onBlur={handleSave}
            onKeyDown={handleKeyDown}
            className="w-full px-2 py-1.5 border-b-2 border-emerald-500 bg-emerald-50/30 text-sm text-slate-900 outline-none"
          >
            <option value="">Sin valor</option>
            {(definition.config?.options || []).map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        ) : definition.field_type === 'text' && textVariant === 'rich' ? (
          <div className="rounded-lg border border-emerald-400 bg-white focus-within:ring-2 focus-within:ring-emerald-500/20 overflow-hidden">
            <div className="flex items-center gap-0.5 px-1.5 py-1 border-b border-slate-100 bg-slate-50/60">
              <button type="button" onMouseDown={(e) => { e.preventDefault(); execRich('bold') }} className="p-1 rounded hover:bg-slate-200 text-slate-600" title="Negrita (Ctrl+B)">
                <Bold className="w-3 h-3" />
              </button>
              <button type="button" onMouseDown={(e) => { e.preventDefault(); execRich('italic') }} className="p-1 rounded hover:bg-slate-200 text-slate-600" title="Cursiva (Ctrl+I)">
                <Italic className="w-3 h-3" />
              </button>
              <button type="button" onMouseDown={(e) => { e.preventDefault(); execRich('underline') }} className="p-1 rounded hover:bg-slate-200 text-slate-600" title="Subrayado (Ctrl+U)">
                <Underline className="w-3 h-3" />
              </button>
              <span className="ml-auto text-[10px] text-slate-400 pr-1">Ctrl+Enter para guardar</span>
            </div>
            <div
              ref={richRef}
              contentEditable
              suppressContentEditableWarning
              onInput={() => {
                if (!richRef.current) return
                const plain = stripHtml(richRef.current.innerHTML)
                // Enforce max_length by truncating textContent
                if (maxLen && plain.length > maxLen) {
                  richRef.current.textContent = plain.slice(0, maxLen)
                  // Move cursor to end
                  const range = document.createRange()
                  range.selectNodeContents(richRef.current)
                  range.collapse(false)
                  const sel = window.getSelection()
                  sel?.removeAllRanges()
                  sel?.addRange(range)
                  setRichLen(maxLen)
                } else {
                  setRichLen(plain.length)
                }
              }}
              onBlur={handleSave}
              onKeyDown={handleKeyDown}
              className="px-2 py-1.5 text-sm text-slate-900 outline-none min-h-[80px] max-h-[200px] overflow-y-auto"
              data-placeholder={`Ingresa ${definition.name.toLowerCase()}`}
            />
          </div>
        ) : definition.field_type === 'text' && textVariant === 'textarea' ? (
          <textarea
            ref={inputRef as React.RefObject<HTMLTextAreaElement>}
            value={editVal}
            onChange={e => setEditVal(e.target.value)}
            onBlur={handleSave}
            onKeyDown={handleKeyDown}
            maxLength={maxLen || undefined}
            rows={4}
            placeholder={`Ingresa ${definition.name.toLowerCase()}`}
            className="w-full px-2 py-1.5 border border-emerald-400 rounded-lg bg-white text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:ring-2 focus:ring-emerald-500/20 resize-y min-h-[80px] max-h-[240px]"
          />
        ) : (
          <input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            type={definition.field_type === 'number' || definition.field_type === 'currency' ? 'number' : definition.field_type === 'date' ? 'date' : 'text'}
            value={editVal}
            onChange={e => setEditVal(e.target.value)}
            onBlur={handleSave}
            onKeyDown={handleKeyDown}
            step={definition.field_type === 'currency' ? '0.01' : undefined}
            min={definition.config?.min != null ? definition.config.min : undefined}
            max={definition.config?.max != null ? definition.config.max : undefined}
            maxLength={definition.config?.max_length || undefined}
            placeholder={`Ingresa ${definition.name.toLowerCase()}`}
            className="w-full px-2 py-1.5 border-b-2 border-emerald-500 bg-emerald-50/30 text-sm text-slate-900 outline-none placeholder:text-slate-400"
          />
        )}
        {definition.field_type === 'text' && (textVariant === 'textarea' || textVariant === 'rich') && (
          <div className="text-[10px] text-slate-400">Presiona Esc para cancelar · click fuera o Ctrl+Enter para guardar</div>
        )}
      </div>
    )
  }

  // Display mode
  return (
    <div
      className={`flex items-center justify-between py-1.5 group cursor-pointer rounded-lg px-1 -mx-1 hover:bg-slate-50 transition-colors ${disabled ? 'cursor-default' : ''}`}
      onClick={startEdit}
    >
      <span className="text-xs text-slate-500 truncate shrink-0 w-[40%]">{definition.name}</span>
      <div className="flex-1 text-right min-w-0">
        {isEmpty ? (
          <span className={`text-xs italic ${isRequired ? 'text-amber-500' : 'text-slate-300'}`}>
            {isRequired ? 'Requerido' : 'Sin valor'}
          </span>
        ) : definition.field_type === 'multi_select' ? (
          <div className="flex flex-wrap gap-1 justify-end">
            {(value?.value_json || []).map(v => {
              const opt = definition.config?.options?.find(o => o.value === v)
              return (
                <span key={v} className="px-1.5 py-0.5 bg-emerald-50 text-emerald-700 text-[10px] font-medium rounded-md">
                  {opt?.label || v}
                </span>
              )
            })}
          </div>
        ) : definition.field_type === 'email' && display ? (
          <a href={`mailto:${display}`} onClick={e => e.stopPropagation()} className="text-xs text-emerald-600 hover:underline truncate flex items-center gap-1 justify-end">
            <Mail className="w-3 h-3 shrink-0" />{display}
          </a>
        ) : definition.field_type === 'phone' && display ? (
          <a href={`tel:${display}`} onClick={e => e.stopPropagation()} className="text-xs text-emerald-600 hover:underline truncate flex items-center gap-1 justify-end">
            <Phone className="w-3 h-3 shrink-0" />{display}
          </a>
        ) : definition.field_type === 'url' && display ? (
          <a href={display.startsWith('http') ? display : `https://${display}`} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} className="text-xs text-emerald-600 hover:underline truncate flex items-center gap-1 justify-end">
            <ExternalLink className="w-3 h-3 shrink-0" />{display}
          </a>
        ) : definition.field_type === 'text' && textVariant === 'rich' && value?.value_text ? (
          <div
            className="text-xs text-slate-900 text-left max-h-16 overflow-hidden rich-display"
            dangerouslySetInnerHTML={{ __html: sanitizeRichHtml(value.value_text) }}
          />
        ) : definition.field_type === 'text' && textVariant === 'textarea' ? (
          <span className="text-xs text-slate-900 whitespace-pre-wrap text-left line-clamp-3">{display}</span>
        ) : (
          <span className="text-xs text-slate-900 truncate">{display}</span>
        )}
      </div>
    </div>
  )
}
