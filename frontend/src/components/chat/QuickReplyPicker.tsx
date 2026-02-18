'use client'

import { useState, useRef, useEffect, useMemo } from 'react'
import { Zap, Search, X, Image, Video, File } from 'lucide-react'

interface QuickReplyItem {
  id: string
  shortcut: string
  title: string
  body: string
  media_url?: string
  media_type?: string
  media_filename?: string
}

interface QuickReplyPickerProps {
  replies: QuickReplyItem[]
  isOpen: boolean
  filter: string
  onSelect: (reply: QuickReplyItem) => void
  onClose: () => void
}

export default function QuickReplyPicker({
  replies,
  isOpen,
  filter,
  onSelect,
  onClose,
}: QuickReplyPickerProps) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    if (!filter) return replies
    const q = filter.toLowerCase()
    return replies.filter(
      r =>
        r.shortcut.toLowerCase().includes(q) ||
        r.title.toLowerCase().includes(q) ||
        r.body.toLowerCase().includes(q)
    )
  }, [replies, filter])

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIndex(0)
  }, [filter])

  // Scroll active item into view
  useEffect(() => {
    if (!listRef.current) return
    const active = listRef.current.children[selectedIndex] as HTMLElement | undefined
    active?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  // Keyboard navigation (listen globally while open)
  useEffect(() => {
    if (!isOpen) return

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex(i => (i + 1) % Math.max(filtered.length, 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex(i => (i - 1 + filtered.length) % Math.max(filtered.length, 1))
      } else if (e.key === 'Enter' && filtered.length > 0) {
        e.preventDefault()
        e.stopPropagation()
        onSelect(filtered[selectedIndex])
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [isOpen, filtered, selectedIndex, onSelect, onClose])

  if (!isOpen) return null

  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 bg-white border border-gray-200 rounded-lg shadow-lg z-50 max-h-64 flex flex-col">
      {/* Header */}
      <div className="px-3 py-2 border-b border-gray-200 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4 text-green-600" />
          <span className="text-sm font-semibold text-gray-700">Respuestas rápidas</span>
        </div>
        <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Filter hint */}
      {filter && (
        <div className="px-3 py-1.5 bg-gray-50 border-b border-gray-100">
          <span className="text-xs text-gray-500">
            Buscando: <span className="font-medium text-gray-700">/{filter}</span>
          </span>
        </div>
      )}

      {/* Results */}
      <div ref={listRef} className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="px-3 py-4 text-center text-sm text-gray-500">
            No se encontraron respuestas rápidas
          </div>
        ) : (
          filtered.map((reply, idx) => (
            <div
              key={reply.id}
              onClick={() => onSelect(reply)}
              onMouseEnter={() => setSelectedIndex(idx)}
              className={`px-3 py-2.5 cursor-pointer flex items-start gap-3 border-b border-gray-50 last:border-0 ${
                idx === selectedIndex ? 'bg-green-50' : 'hover:bg-gray-50'
              }`}
            >
              <span className="inline-block px-1.5 py-0.5 bg-green-100 text-green-700 text-xs font-mono rounded flex-shrink-0 mt-0.5">
                /{reply.shortcut}
              </span>
              <div className="flex-1 min-w-0">
                {reply.title && (
                  <p className="text-sm font-medium text-gray-900 truncate">{reply.title}</p>
                )}
                {reply.media_url && (
                  <div className="flex items-center gap-1 mb-0.5">
                    {reply.media_type === 'image' ? <Image className="w-3 h-3 text-green-500" /> :
                     reply.media_type === 'video' ? <Video className="w-3 h-3 text-green-500" /> :
                     <File className="w-3 h-3 text-green-500" />}
                    <span className="text-[10px] text-green-600">{reply.media_filename || reply.media_type}</span>
                  </div>
                )}
                {reply.body && <p className="text-xs text-gray-500 line-clamp-2">{reply.body}</p>}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Footer hint */}
      {filtered.length > 0 && (
        <div className="px-3 py-1.5 border-t border-gray-200 bg-gray-50">
          <span className="text-xs text-gray-400">↑↓ navegar · Enter seleccionar · Esc cerrar</span>
        </div>
      )}
    </div>
  )
}
