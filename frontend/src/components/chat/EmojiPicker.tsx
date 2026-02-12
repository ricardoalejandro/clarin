'use client'

import { useState, useRef, useEffect } from 'react'
import { Smile } from 'lucide-react'

// Common emoji categories for a lightweight picker
const EMOJI_CATEGORIES = {
  'Frecuentes': ['😀', '😂', '🤣', '😊', '😍', '🥰', '😘', '😋', '🤗', '🤔', '😎', '🥳'],
  'Caras': ['😀', '😃', '😄', '😁', '😅', '😂', '🤣', '😊', '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😗', '😙', '😚', '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🤫', '🤔', '🤐', '🤨', '😐', '😑', '😶', '😏', '😒', '🙄', '😬', '🤥', '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮', '🤧', '🥵', '🥶', '🥴', '😵', '🤯', '🤠', '🥳', '😎', '🤓', '🧐'],
  'Gestos': ['👍', '👎', '👊', '✊', '🤛', '🤜', '🤝', '👏', '🙌', '👐', '🤲', '🙏', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆', '👇', '☝️', '👋', '🤚', '🖐️', '✋', '🖖', '👌', '🤏', '✍️', '💪'],
  'Corazones': ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝'],
  'Símbolos': ['✅', '❌', '⭐', '🌟', '✨', '💫', '⚡', '🔥', '💯', '🎉', '🎊', '🎁', '🏆', '🥇', '🥈', '🥉', '📌', '📍', '🔔', '🔕', '🎵', '🎶', '💡', '📱', '💻', '📧', '📞', '📅', '⏰', '🕐'],
  'Animales': ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐔', '🐧', '🐦', '🐤', '🦆', '🦅', '🦉', '🦇', '🐺', '🐴', '🦄', '🐝', '🐛', '🦋', '🐌'],
  'Comida': ['🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐', '🍈', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🍆', '🥑', '🥦', '🍕', '🍔', '🍟', '🌭', '🍿', '🧁', '🍰', '☕', '🍺', '🍷'],
}

interface EmojiPickerProps {
  onEmojiSelect: (emoji: string) => void
  buttonClassName?: string
  isOpen?: boolean
  onToggle?: () => void
}

export default function EmojiPicker({ onEmojiSelect, buttonClassName, isOpen: controlledOpen, onToggle }: EmojiPickerProps) {
  const [internalOpen, setInternalOpen] = useState(false)
  const [activeCategory, setActiveCategory] = useState('Frecuentes')
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
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])

  const handleEmojiClick = (emoji: string) => {
    onEmojiSelect(emoji)
  }

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
        <div className="absolute bottom-full mb-2 left-0 bg-white rounded-xl shadow-xl border border-gray-200 w-[calc(100vw-2rem)] sm:w-80 max-w-80 z-50">
          {/* Category tabs */}
          <div className="flex overflow-x-auto border-b border-gray-200 p-2 gap-1 scrollbar-hide">
            {Object.keys(EMOJI_CATEGORIES).map(category => (
              <button
                key={category}
                onClick={() => setActiveCategory(category)}
                className={`px-2.5 py-1.5 text-xs font-semibold rounded whitespace-nowrap transition-colors ${
                  activeCategory === category
                    ? 'bg-green-100 text-green-700'
                    : 'text-gray-700 hover:bg-gray-100'
                }`}
              >
                {category}
              </button>
            ))}
          </div>

          {/* Emoji grid */}
          <div className="p-2 h-48 overflow-y-auto">
            <div className="grid grid-cols-8 gap-0.5">
              {EMOJI_CATEGORIES[activeCategory as keyof typeof EMOJI_CATEGORIES].map((emoji, index) => (
                <button
                  key={`${emoji}-${index}`}
                  onClick={() => handleEmojiClick(emoji)}
                  className="p-1.5 text-xl hover:bg-gray-100 rounded transition-colors flex items-center justify-center"
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
