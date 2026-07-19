'use client'

import { useRef, useEffect, useLayoutEffect, useState, useCallback, forwardRef, useImperativeHandle } from 'react'
import { createPortal } from 'react-dom'
import { Bold, Braces, Code, Italic, List, ListOrdered, Quote, Strikethrough } from 'lucide-react'
import { formatToHtmlPreview, getCaretOffset, setCaretOffset } from '@/lib/whatsappFormat'
import { applyWhatsAppFormat, insertTextAtSelection } from '@/lib/whatsappEditor'
import type { TextSelection, WhatsAppFormatCommand } from '@/lib/whatsappEditor'

export interface WhatsAppTextInputHandle {
  focus: () => void
  blur: () => void
  insertAtCaret: (text: string, options?: { restoreFocus?: boolean }) => void
  clear: () => void
}

interface WhatsAppTextInputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
  rows?: number
  onKeyDown?: (e: React.KeyboardEvent) => void
  onPasteFiles?: (files: File[]) => void
  disabled?: boolean
  /** Treat as single-line (Enter sends) */
  singleLine?: boolean
  /** Marks the main mobile chat composer so the dashboard can yield chrome to the virtual keyboard. */
  keyboardChromeTarget?: boolean
  /** Keeps the format toolbar inline by default; chat surfaces can render it outside the editor. */
  formatToolbarPlacement?: 'inline' | 'outside'
}

interface FormatToolbarState {
  x: number
  y: number
  anchorCenterX: number
  selStart: number
  selEnd: number
}

interface OutsideToolbarPosition {
  top: number
  left: number
  width: number
  maxHeight: number
  visible: boolean
}

const FORMAT_ACTIONS: Array<{ icon: typeof Bold; label: string; command: WhatsAppFormatCommand; shortcut?: string }> = [
  { icon: Bold, label: 'Negrita', command: 'bold', shortcut: 'Ctrl+B' },
  { icon: Italic, label: 'Cursiva', command: 'italic', shortcut: 'Ctrl+I' },
  { icon: Strikethrough, label: 'Tachado', command: 'strike', shortcut: 'Ctrl+Mayús+X' },
  { icon: Code, label: 'Código en línea', command: 'inline_code', shortcut: 'Ctrl+`' },
  { icon: Braces, label: 'Monoespaciado', command: 'monospace' },
  { icon: List, label: 'Lista con viñetas', command: 'bullet_list' },
  { icon: ListOrdered, label: 'Lista numerada', command: 'numbered_list' },
  { icon: Quote, label: 'Cita', command: 'quote' },
]

const WhatsAppTextInput = forwardRef<WhatsAppTextInputHandle, WhatsAppTextInputProps>(function WhatsAppTextInput({
  value,
  onChange,
  placeholder = 'Escribe un mensaje...',
  className = '',
  rows = 4,
  onKeyDown,
  onPasteFiles,
  disabled = false,
  singleLine = false,
  keyboardChromeTarget = false,
  formatToolbarPlacement = 'inline',
}, ref) {
  const editorRef = useRef<HTMLDivElement>(null)
  const [toolbar, setToolbar] = useState<FormatToolbarState | null>(null)
  const [outsideToolbarPosition, setOutsideToolbarPosition] = useState<OutsideToolbarPosition | null>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const valueRef = useRef(value)
  const selectionRef = useRef<TextSelection>({ start: value.length, end: value.length })
  valueRef.current = value

  const commitEdit = useCallback((nextValue: string, selection: TextSelection, restoreFocus = true) => {
    selectionRef.current = selection
    onChange(nextValue)
    requestAnimationFrame(() => {
      if (!editorRef.current) return
      editorRef.current.innerHTML = formatToHtmlPreview(nextValue) || ''
      if (restoreFocus) {
        editorRef.current.focus()
        setCaretOffset(editorRef.current, selection.end)
      }
    })
  }, [onChange])

  useImperativeHandle(ref, () => ({
    focus() {
      if (!editorRef.current) return
      editorRef.current.focus()
      setCaretOffset(editorRef.current, selectionRef.current.end)
    },
    blur() {
      editorRef.current?.blur()
    },
    insertAtCaret(text: string, options) {
      if (!editorRef.current) return
      const edit = insertTextAtSelection(valueRef.current, selectionRef.current, text)
      commitEdit(edit.value, edit.selection, options?.restoreFocus !== false)
    },
    clear() {
      if (editorRef.current) {
        editorRef.current.innerHTML = ''
      }
    },
  }), [commitEdit])

  // Sync HTML when value changes externally
  useEffect(() => {
    if (!editorRef.current) return
    const currentText = (editorRef.current.innerText || '').replace(/\u00a0/g, ' ')
    if (currentText !== value) {
      const html = formatToHtmlPreview(value)
      editorRef.current.innerHTML = html || ''
      const caret = Math.min(value.length, selectionRef.current.end)
      selectionRef.current = { start: caret, end: caret }
    }
  }, [value])

  const handleInput = useCallback(() => {
    if (!editorRef.current) return
    const text = (editorRef.current.innerText || '').replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n')
    const caretPos = getCaretOffset(editorRef.current)
    selectionRef.current = { start: caretPos, end: caretPos }
    onChange(text)
    const html = formatToHtmlPreview(text)
    editorRef.current.innerHTML = html || ''
    setCaretOffset(editorRef.current, caretPos)
  }, [onChange])

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const itemFiles = Array.from(e.clipboardData.items || [])
      .filter(item => item.kind === 'file')
      .map(item => item.getAsFile())
      .filter((file): file is File => file !== null)
    const files = itemFiles.length > 0 ? itemFiles : Array.from(e.clipboardData.files || [])

    if (files.length > 0 && onPasteFiles) {
      e.preventDefault()
      onPasteFiles(files)
      return
    }

    e.preventDefault()
    if (!editorRef.current) return
    const pastedText = e.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n')
    if (!pastedText) return

    // Read current text from the clean DOM (innerHTML set by formatToHtmlPreview uses <br>)
    const currentText = (editorRef.current.innerText || '').replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n')

    // Get caret start and selection end
    const sel = window.getSelection()
    const caretStart = getCaretOffset(editorRef.current)
    let caretEnd = caretStart

    if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0)
      const endRange = document.createRange()
      endRange.selectNodeContents(editorRef.current)
      endRange.setEnd(range.endContainer, range.endOffset)
      const frag = endRange.cloneContents()
      frag.querySelectorAll('br').forEach(br => br.parentNode?.replaceChild(document.createTextNode('\n'), br))
      caretEnd = (frag.textContent || '').length
    }

    // Splice pasted text at caret/selection position
    const newText = currentText.slice(0, caretStart) + pastedText + currentText.slice(caretEnd)

    commitEdit(newText, { start: caretStart + pastedText.length, end: caretStart + pastedText.length })
  }, [commitEdit, onPasteFiles])

  // Show toolbar on text selection
  const checkSelection = useCallback(() => {
    if (!editorRef.current) return
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      if (sel?.rangeCount && editorRef.current.contains(sel.anchorNode)) {
        const caret = getCaretOffset(editorRef.current)
        selectionRef.current = { start: caret, end: caret }
      }
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
    selectionRef.current = { start: selStart, end: selEnd }
    const toolbarHalfWidth = 74
    const rawX = rect.left + rect.width / 2 - editorRect.left
    const x = editorRect.width <= toolbarHalfWidth * 2
      ? editorRect.width / 2
      : Math.max(toolbarHalfWidth, Math.min(rawX, editorRect.width - toolbarHalfWidth))
    setToolbar({
      x,
      y: Math.max(58, rect.top - editorRect.top - 8),
      anchorCenterX: rect.left + rect.width / 2,
      selStart,
      selEnd,
    })
  }, [])

  useEffect(() => {
    document.addEventListener('selectionchange', checkSelection)
    return () => document.removeEventListener('selectionchange', checkSelection)
  }, [checkSelection])

  const positionOutsideToolbar = useCallback(() => {
    if (formatToolbarPlacement !== 'outside' || !toolbar || !editorRef.current || !toolbarRef.current) return

    const viewport = window.visualViewport
    const viewportLeft = viewport?.offsetLeft || 0
    const viewportTop = viewport?.offsetTop || 0
    const viewportWidth = viewport?.width || window.innerWidth
    const viewportHeight = viewport?.height || window.innerHeight
    const viewportRight = viewportLeft + viewportWidth
    const viewportBottom = viewportTop + viewportHeight
    const margin = 8
    const gap = 8
    const editorRect = editorRef.current.getBoundingClientRect()
    const toolbarWidth = Math.min(toolbarRef.current.scrollWidth || 148, Math.max(1, viewportWidth - margin * 2))
    const toolbarHeight = toolbarRef.current.scrollHeight || toolbarRef.current.offsetHeight || 56

    let anchorCenterX = toolbar.anchorCenterX
    const selection = window.getSelection()
    if (selection?.rangeCount) {
      const range = selection.getRangeAt(0)
      if (editorRef.current.contains(range.commonAncestorContainer)) {
        const rangeRect = range.getBoundingClientRect()
        if (rangeRect.width || rangeRect.height) anchorCenterX = rangeRect.left + rangeRect.width / 2
      }
    }

    const availableAbove = Math.max(0, editorRect.top - gap - (viewportTop + margin))
    const availableBelow = Math.max(0, viewportBottom - margin - gap - editorRect.bottom)
    const placeAbove = availableAbove >= toolbarHeight || (
      availableBelow < toolbarHeight && availableAbove >= availableBelow
    )
    const availableHeight = placeAbove ? availableAbove : availableBelow
    const maxHeight = Math.min(toolbarHeight, availableHeight)
    const top = placeAbove
      ? editorRect.top - gap - maxHeight
      : editorRect.bottom + gap
    const minLeft = viewportLeft + margin
    const maxLeft = Math.max(minLeft, viewportRight - margin - toolbarWidth)
    const left = Math.max(minLeft, Math.min(anchorCenterX - toolbarWidth / 2, maxLeft))

    setOutsideToolbarPosition({
      top,
      left,
      width: toolbarWidth,
      maxHeight,
      visible: maxHeight >= 28,
    })
  }, [formatToolbarPlacement, toolbar])

  useLayoutEffect(() => {
    if (!toolbar || formatToolbarPlacement !== 'outside') return
    positionOutsideToolbar()
  }, [formatToolbarPlacement, positionOutsideToolbar, toolbar])

  useEffect(() => {
    if (!toolbar) {
      setOutsideToolbarPosition(null)
      return
    }
    if (formatToolbarPlacement !== 'outside') return
    const reposition = () => positionOutsideToolbar()
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    window.visualViewport?.addEventListener('resize', reposition)
    window.visualViewport?.addEventListener('scroll', reposition)
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
      window.visualViewport?.removeEventListener('resize', reposition)
      window.visualViewport?.removeEventListener('scroll', reposition)
    }
  }, [formatToolbarPlacement, positionOutsideToolbar, toolbar])

  // Close toolbar on click outside or Escape.
  useEffect(() => {
    if (!toolbar) return
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (toolbarRef.current?.contains(target) || editorRef.current?.contains(target)) return
      setToolbar(null)
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setToolbar(null)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [toolbar])

  const applyFormat = useCallback((command: WhatsAppFormatCommand, selection = selectionRef.current) => {
    if (!editorRef.current) return
    const edit = applyWhatsAppFormat(valueRef.current, selection, command)
    setToolbar(null)
    commitEdit(edit.value, edit.selection)
  }, [commitEdit])

  const handleEditorKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!event.nativeEvent.isComposing && (event.ctrlKey || event.metaKey) && !event.altKey) {
      const key = event.key.toLowerCase()
      const command = !event.shiftKey && key === 'b'
        ? 'bold'
        : !event.shiftKey && key === 'i'
          ? 'italic'
          : event.shiftKey && key === 'x'
            ? 'strike'
            : !event.shiftKey && (event.key === '`' || event.code === 'Backquote')
              ? 'inline_code'
              : null
      if (command) {
        event.preventDefault()
        event.stopPropagation()
        applyFormat(command)
        return
      }
    }
    onKeyDown?.(event)
  }, [applyFormat, onKeyDown])

  const minH = singleLine ? 'min-h-[42px]' : `min-h-[${Math.max(rows * 24, 64)}px]`
  const maxH = singleLine ? 'max-h-32' : 'max-h-60'

  const formatToolbar = toolbar ? (
    <div
      ref={toolbarRef}
      role="toolbar"
      aria-label="Formato de texto"
      className={`${formatToolbarPlacement === 'outside' ? 'fixed z-[120] overflow-y-auto' : 'absolute z-50 -translate-x-1/2 -translate-y-full'} grid w-[148px] grid-cols-4 gap-0.5 rounded-lg bg-gray-800 px-1 py-0.5 shadow-xl`}
      style={formatToolbarPlacement === 'outside' ? {
        top: outsideToolbarPosition?.top || 0,
        left: outsideToolbarPosition?.left || 0,
        width: outsideToolbarPosition?.width || 148,
        maxHeight: outsideToolbarPosition?.maxHeight || undefined,
        visibility: outsideToolbarPosition?.visible ? 'visible' : 'hidden',
      } : { left: toolbar.x, top: toolbar.y }}
      onPointerDown={e => e.preventDefault()}
      onMouseDown={e => e.preventDefault()}
    >
      {FORMAT_ACTIONS.map(action => (
        <button
          key={action.label}
          type="button"
          onClick={() => applyFormat(action.command, { start: toolbar.selStart, end: toolbar.selEnd })}
          className="p-1.5 text-white hover:bg-gray-700 rounded transition-colors"
          title={action.shortcut ? `${action.label} (${action.shortcut})` : action.label}
          aria-label={action.shortcut ? `${action.label}, ${action.shortcut}` : action.label}
        >
          <action.icon className="w-3.5 h-3.5" />
        </button>
      ))}
    </div>
  ) : null

  return (
    <div className="relative">
      {!value && (
        <div className="absolute left-4 top-2.5 text-gray-400 pointer-events-none select-none text-sm">
          {placeholder}
        </div>
      )}
      <div
        ref={editorRef}
        role="textbox"
        aria-multiline={!singleLine}
        aria-label={placeholder}
        data-chat-keyboard-target={keyboardChromeTarget ? 'true' : undefined}
        contentEditable={!disabled}
        onInput={handleInput}
        onKeyDown={handleEditorKeyDown}
        onPaste={handlePaste}
        className={`w-full px-4 py-2.5 bg-white border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-900 ${minH} ${maxH} overflow-y-auto whitespace-pre-wrap break-words outline-none text-sm ${className}`}
      />
      {/* Formatting toolbar */}
      {formatToolbarPlacement === 'inline' && formatToolbar}
      {formatToolbarPlacement === 'outside' && formatToolbar && typeof document !== 'undefined' && createPortal(formatToolbar, document.body)}
    </div>
  )
})

export default WhatsAppTextInput
