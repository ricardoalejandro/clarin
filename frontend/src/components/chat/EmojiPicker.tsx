'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Smile } from 'lucide-react'
import dynamic from 'next/dynamic'

const Picker = dynamic(() => import('./LocalizedEmojiPicker'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center rounded-xl border border-gray-200 bg-white shadow-xl">
      <div className="animate-pulse text-gray-400 text-sm">Cargando emojis...</div>
    </div>
  ),
})

interface EmojiPickerProps {
  onEmojiSelect: (emoji: string) => void
  buttonClassName?: string
  isOpen?: boolean
  onToggle?: () => void
  portalTarget?: HTMLElement | null
}

interface EmojiPickerContentProps {
  onEmojiSelect: (emoji: string) => void
  width: number | string
  height: number | string
  searchPlaceholder?: string
}

export function EmojiPickerContent({
  onEmojiSelect,
  width,
  height,
  searchPlaceholder = 'Buscar emoji...',
}: EmojiPickerContentProps) {
  return (
    <Picker
      onEmojiClick={(emojiData: { emoji: string }) => onEmojiSelect(emojiData.emoji)}
      searchPlaceHolder={searchPlaceholder}
      width={width}
      height={height}
      skinTonesDisabled
      previewConfig={{ showPreview: false }}
      lazyLoadEmojis
    />
  )
}

export default function EmojiPicker({ onEmojiSelect, buttonClassName, isOpen: controlledOpen, onToggle, portalTarget }: EmojiPickerProps) {
  const [internalOpen, setInternalOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const wasOpenRef = useRef(false)
  const [position, setPosition] = useState({ top: 8, left: 8, width: 350, height: 400 })

  const isOpen = controlledOpen !== undefined ? controlledOpen : internalOpen
  const toggle = useCallback(() => {
    if (onToggle) onToggle()
    else setInternalOpen(value => !value)
  }, [onToggle])
  const close = useCallback(() => {
    if (onToggle) onToggle()
    else setInternalOpen(false)
  }, [onToggle])

  const updatePosition = useCallback(() => {
    const visualViewport = window.visualViewport
    const viewportLeft = visualViewport?.offsetLeft || 0
    const viewportTop = visualViewport?.offsetTop || 0
    const viewportWidth = visualViewport?.width || window.innerWidth
    const viewportHeight = visualViewport?.height || window.innerHeight
    const margin = 8
    const width = Math.min(350, Math.max(1, viewportWidth - margin * 2))
    const height = Math.min(400, Math.max(1, viewportHeight - margin * 2))
    const rect = triggerRef.current?.getBoundingClientRect()

    let left = rect && rect.width > 0 ? rect.left : viewportLeft + margin
    let top = rect && rect.height > 0 ? rect.top - height - margin : viewportTop + viewportHeight - height - margin
    if (rect && rect.height > 0 && top < viewportTop + margin) top = rect.bottom + margin
    left = Math.max(viewportLeft + margin, Math.min(left, viewportLeft + viewportWidth - width - margin))
    top = Math.max(viewportTop + margin, Math.min(top, viewportTop + viewportHeight - height - margin))
    setPosition({ top, left, width, height })
  }, [])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node) && !popupRef.current?.contains(event.target as Node)) {
        if (isOpen) close()
      }
    }
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && isOpen) close() }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKey)
    }
  }, [close, isOpen])

  useEffect(() => {
    if (!isOpen) {
      if (wasOpenRef.current) {
        wasOpenRef.current = false
        requestAnimationFrame(() => triggerRef.current?.focus())
      }
      return
    }
    wasOpenRef.current = true
    updatePosition()
    const visualViewport = window.visualViewport
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    visualViewport?.addEventListener('resize', updatePosition)
    visualViewport?.addEventListener('scroll', updatePosition)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
      visualViewport?.removeEventListener('resize', updatePosition)
      visualViewport?.removeEventListener('scroll', updatePosition)
    }
  }, [isOpen, updatePosition])

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        className={buttonClassName || "p-2 hover:bg-gray-100 rounded-lg transition-colors"}
        title="Emojis"
        aria-label="Abrir selector de emojis"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
      >
        <Smile className="w-5 h-5 text-gray-700" />
      </button>

      {isOpen && typeof document !== 'undefined' && createPortal(
        <div ref={popupRef} role="dialog" aria-label="Selector de emojis" className="fixed z-[100] overflow-hidden rounded-xl shadow-2xl" style={{ top: position.top, left: position.left, width: position.width, height: position.height }}>
          <EmojiPickerContent
            onEmojiSelect={onEmojiSelect}
            width={position.width}
            height={position.height}
          />
        </div>,
        portalTarget || document.body,
      )}
    </div>
  )
}
