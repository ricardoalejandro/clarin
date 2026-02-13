'use client'

import { useRef, useEffect, useState, useCallback, forwardRef, useImperativeHandle } from 'react'
import { Bold, Italic, Strikethrough, Code } from 'lucide-react'
import { formatToHtmlPreview, getCaretOffset, setCaretOffset } from '@/lib/whatsappFormat'

export interface WhatsAppTextInputHandle {
  focus: () => void
  insertAtCaret: (text: string) => void
  clear: () => void
}

interface WhatsAppTextInputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
  rows?: number
  onKeyDown?: (e: React.KeyboardEvent) => void
  disabled?: boolean
  /** Treat as single-line (Enter sends) */
  singleLine?: boolean
}

const FORMAT_ACTIONS = [
  { icon: Bold, label: 'Negrita', prefix: '*', suffix: '*' },
  { icon: Italic, label: 'Cursiva', prefix: '_', suffix: '_' },
  { icon: Strikethrough, label: 'Tachado', prefix: '~', suffix: '~' },
  { icon: Code, label: 'Monoespaciado', prefix: '`', suffix: '`' },
]

const WhatsAppTextInput = forwardRef<WhatsAppTextInputHandle, WhatsAppTextInputProps>(function WhatsAppTextInput({
  value,
  onChange,
  placeholder = 'Escribe un mensaje...',
  className = '',
  rows = 4,
  onKeyDown,
  disabled = false,
  singleLine = false,
}, ref) {
  const editorRef = useRef<HTMLDivElement>(null)
  const [toolbar, setToolbar] = useState<{ x: number; y: number; selStart: number; selEnd: number } | null>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const valueRef = useRef(value)
  valueRef.current = value

  useImperativeHandle(ref, () => ({
    focus() {
      editorRef.current?.focus()
    },
    insertAtCaret(text: string) {
      if (!editorRef.current) return
      editorRef.current.focus()
      const caretPos = getCaretOffset(editorRef.current)
      const cur = valueRef.current
      const newVal = cur.slice(0, caretPos) + text + cur.slice(caretPos)
      onChange(newVal)
      requestAnimationFrame(() => {
        if (editorRef.current) {
          editorRef.current.innerHTML = formatToHtmlPreview(newVal) || ''
          setCaretOffset(editorRef.current, caretPos + text.length)
        }
      })
    },
    clear() {
      if (editorRef.current) {
        editorRef.current.innerHTML = ''
      }
    },
  }))

  // Sync HTML when value changes externally
  useEffect(() => {
    if (!editorRef.current) return
    const currentText = (editorRef.current.innerText || '').replace(/\u00a0/g, ' ')
    if (currentText !== value) {
      const html = formatToHtmlPreview(value)
      editorRef.current.innerHTML = html || ''
    }
  }, [value])

  const handleInput = useCallback(() => {
    if (!editorRef.current) return
    const text = (editorRef.current.innerText || '').replace(/\u00a0/g, ' ')
    const caretPos = getCaretOffset(editorRef.current)
    onChange(text)
    const html = formatToHtmlPreview(text)
    editorRef.current.innerHTML = html || ''
    setCaretOffset(editorRef.current, caretPos)
  }, [onChange])

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault()
    const text = e.clipboardData.getData('text/plain')
    document.execCommand('insertText', false, text)
  }, [])

  // Show toolbar on text selection
  const checkSelection = useCallback(() => {
    if (!editorRef.current) return
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      setToolbar(null)
      return
    }
    const range = sel.getRangeAt(0)
    if (!editorRef.current.contains(range.commonAncestorContainer)) {
      setToolbar(null)
      return
    }
    const rect = range.getBoundingClientRect()
    const editorRect = editorRef.current.getBoundingClientRect()
    const selStart = getCaretOffset(editorRef.current)
    // Get selection end offset
    const r2 = range.cloneRange()
    r2.collapse(false)
    const preEnd = document.createRange()
    preEnd.selectNodeContents(editorRef.current)
    preEnd.setEnd(r2.startContainer, r2.startOffset)
    const frag = preEnd.cloneContents()
    frag.querySelectorAll('br').forEach(br => br.parentNode?.replaceChild(document.createTextNode('\n'), br))
    const selEnd = (frag.textContent || '').length
    if (selEnd <= selStart) {
      setToolbar(null)
      return
    }
    setToolbar({
      x: rect.left + rect.width / 2 - editorRect.left,
      y: rect.top - editorRect.top - 8,
      selStart,
      selEnd,
    })
  }, [])

  useEffect(() => {
    document.addEventListener('selectionchange', checkSelection)
    return () => document.removeEventListener('selectionchange', checkSelection)
  }, [checkSelection])

  // Close toolbar on click outside
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (toolbarRef.current && !toolbarRef.current.contains(e.target as Node)) {
        // Will close via selectionchange naturally
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [])

  const applyFormat = (prefix: string, suffix: string) => {
    if (!toolbar || !editorRef.current) return
    const text = valueRef.current
    const { selStart, selEnd } = toolbar
    const selected = text.slice(selStart, selEnd)
    // Check if already formatted, toggle off
    const before = text.slice(0, selStart)
    const after = text.slice(selEnd)
    let newText: string
    let newCaretEnd: number
    if (before.endsWith(prefix) && after.startsWith(suffix)) {
      // Remove wrapping format chars
      newText = before.slice(0, -prefix.length) + selected + after.slice(suffix.length)
      newCaretEnd = selStart - prefix.length + selected.length
    } else {
      newText = before + prefix + selected + suffix + after
      newCaretEnd = selStart + prefix.length + selected.length + suffix.length
    }
    onChange(newText)
    setToolbar(null)
    // Re-render and restore caret
    requestAnimationFrame(() => {
      if (editorRef.current) {
        editorRef.current.innerHTML = formatToHtmlPreview(newText) || ''
        setCaretOffset(editorRef.current, newCaretEnd)
      }
    })
  }

  const minH = singleLine ? 'min-h-[42px]' : `min-h-[${Math.max(rows * 24, 64)}px]`
  const maxH = singleLine ? 'max-h-32' : 'max-h-60'

  return (
    <div className="relative">
      {!value && (
        <div className="absolute left-4 top-2.5 text-gray-400 pointer-events-none select-none text-sm">
          {placeholder}
        </div>
      )}
      <div
        ref={editorRef}
        contentEditable={!disabled}
        onInput={handleInput}
        onKeyDown={onKeyDown}
        onPaste={handlePaste}
        className={`w-full px-4 py-2.5 bg-white border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-900 ${minH} ${maxH} overflow-y-auto whitespace-pre-wrap break-words outline-none text-sm ${className}`}
      />
      {/* Formatting toolbar */}
      {toolbar && (
        <div
          ref={toolbarRef}
          className="absolute z-50 flex items-center gap-0.5 bg-gray-800 rounded-lg shadow-xl px-1 py-0.5 -translate-x-1/2 -translate-y-full"
          style={{ left: toolbar.x, top: toolbar.y }}
          onMouseDown={e => e.preventDefault()}
        >
          {FORMAT_ACTIONS.map(action => (
            <button
              key={action.label}
              type="button"
              onClick={() => applyFormat(action.prefix, action.suffix)}
              className="p-1.5 text-white hover:bg-gray-700 rounded transition-colors"
              title={action.label}
            >
              <action.icon className="w-3.5 h-3.5" />
            </button>
          ))}
        </div>
      )}
    </div>
  )
})

export default WhatsAppTextInput
