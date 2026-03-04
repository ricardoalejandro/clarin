'use client'

import { useState, useRef, useEffect } from 'react'
import { Smile } from 'lucide-react'
import dynamic from 'next/dynamic'

const Picker = dynamic(() => import('emoji-picker-react'), {
  ssr: false,
  loading: () => (
    <div className="w-[350px] h-[400px] bg-white rounded-xl shadow-xl border border-gray-200 flex items-center justify-center">
      <div className="animate-pulse text-gray-400 text-sm">Cargando emojis...</div>
    </div>
  ),
})

interface EmojiPickerProps {
  onEmojiSelect: (emoji: string) => void
  buttonClassName?: string
  isOpen?: boolean
  onToggle?: () => void
}

export default function EmojiPicker({ onEmojiSelect, buttonClassName, isOpen: controlledOpen, onToggle }: EmojiPickerProps) {
  const [internalOpen, setInternalOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const isOpen = controlledOpen !== undefined ? controlledOpen : internalOpen
  const toggle = onToggle || (() => setInternalOpen(v => !v))
  const close = onToggle ? onToggle : () => setInternalOpen(false)

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
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
  }, [isOpen])

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={toggle}
        className={buttonClassName || "p-2 hover:bg-gray-100 rounded-lg transition-colors"}
        title="Emojis"
      >
        <Smile className="w-5 h-5 text-gray-700" />
      </button>

      {isOpen && (
        <div className="absolute bottom-full mb-2 left-0 z-50">
          <Picker
            onEmojiClick={(emojiData: any) => onEmojiSelect(emojiData.emoji)}
            searchPlaceHolder="Buscar emoji..."
            width={350}
            height={400}
            skinTonesDisabled
            previewConfig={{ showPreview: false }}
            lazyLoadEmojis
          />
        </div>
      )}
    </div>
  )
}
