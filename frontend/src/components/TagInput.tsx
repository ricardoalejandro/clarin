'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { X, Plus, Check } from 'lucide-react'

interface Tag {
  id: string
  account_id: string
  name: string
  color: string
}

interface TagInputProps {
  entityType: 'contact' | 'lead' | 'chat' | 'participant'
  entityId: string
  assignedTags: Tag[]
  onTagsChange?: (tags: Tag[]) => void
  className?: string
}

const PRESET_COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4',
  '#3b82f6', '#6366f1', '#8b5cf6', '#ec4899', '#6b7280',
]

export default function TagInput({ entityType, entityId, assignedTags, onTagsChange, className = '' }: TagInputProps) {
  const [allTags, setAllTags] = useState<Tag[]>([])
  const [inputValue, setInputValue] = useState('')
  const [isOpen, setIsOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newTagColor, setNewTagColor] = useState(PRESET_COLORS[6])
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const fetchAllTags = useCallback(async () => {
    const token = localStorage.getItem('token')
    try {
      const res = await fetch('/api/tags', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        setAllTags(data.tags || [])
      }
    } catch (err) {
      console.error('Failed to fetch tags:', err)
    }
  }, [])

  useEffect(() => {
    fetchAllTags()
  }, [fetchAllTags])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
        setInputValue('')
        setCreating(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const assignedIds = new Set(assignedTags.map(t => t.id))

  const filteredTags = allTags.filter(t =>
    !assignedIds.has(t.id) &&
    t.name.toLowerCase().includes(inputValue.toLowerCase())
  )

  const exactMatch = allTags.find(t => t.name.toLowerCase() === inputValue.trim().toLowerCase())
  const showCreateOption = inputValue.trim() && !exactMatch

  const handleAssign = async (tag: Tag) => {
    const token = localStorage.getItem('token')
    try {
      const res = await fetch('/api/tags/assign', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          entity_type: entityType,
          entity_id: entityId,
          tag_id: tag.id,
        }),
      })
      const data = await res.json()
      if (data.success) {
        const newTags = [...assignedTags, tag]
        onTagsChange?.(newTags)
      }
    } catch (err) {
      console.error('Failed to assign tag:', err)
    }
    setInputValue('')
  }

  const handleRemove = async (tag: Tag) => {
    const token = localStorage.getItem('token')
    try {
      const res = await fetch('/api/tags/remove', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          entity_type: entityType,
          entity_id: entityId,
          tag_id: tag.id,
        }),
      })
      const data = await res.json()
      if (data.success) {
        const newTags = assignedTags.filter(t => t.id !== tag.id)
        onTagsChange?.(newTags)
      }
    } catch (err) {
      console.error('Failed to remove tag:', err)
    }
  }

  const handleCreate = async () => {
    const name = inputValue.trim()
    if (!name) return
    setCreating(true)
    const token = localStorage.getItem('token')
    try {
      const res = await fetch('/api/tags', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name, color: newTagColor }),
      })
      const data = await res.json()
      if (data.success && data.tag) {
        setAllTags(prev => [...prev, data.tag])
        await handleAssign(data.tag)
      }
    } catch (err) {
      console.error('Failed to create tag:', err)
    } finally {
      setCreating(false)
      setInputValue('')
      setNewTagColor(PRESET_COLORS[Math.floor(Math.random() * PRESET_COLORS.length)])
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (filteredTags.length > 0 && !showCreateOption) {
        handleAssign(filteredTags[0])
      } else if (showCreateOption) {
        handleCreate()
      }
    } else if (e.key === 'Escape') {
      setIsOpen(false)
      setInputValue('')
    } else if (e.key === 'Backspace' && !inputValue && assignedTags.length > 0) {
      handleRemove(assignedTags[assignedTags.length - 1])
    }
  }

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      {/* Pills + Input */}
      <div
        className="flex flex-wrap items-center gap-1.5 min-h-[36px] px-2 py-1.5 border border-gray-300 rounded-lg bg-white cursor-text focus-within:ring-2 focus-within:ring-green-500 focus-within:border-transparent"
        onClick={() => {
          inputRef.current?.focus()
          setIsOpen(true)
        }}
      >
        {assignedTags.map(tag => (
          <span
            key={tag.id}
            className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 text-xs font-medium rounded-full text-white"
            style={{ backgroundColor: tag.color || '#6b7280' }}
          >
            {tag.name}
            <button
              onClick={(e) => {
                e.stopPropagation()
                handleRemove(tag)
              }}
              className="p-0.5 rounded-full hover:bg-black/20 transition"
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => {
            setInputValue(e.target.value)
            setIsOpen(true)
          }}
          onFocus={() => setIsOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={assignedTags.length === 0 ? 'Agregar etiqueta...' : ''}
          className="flex-1 min-w-[80px] text-sm text-gray-900 placeholder:text-gray-400 outline-none bg-transparent"
        />
      </div>

      {/* Dropdown */}
      {isOpen && (filteredTags.length > 0 || showCreateOption) && (
        <div className="absolute z-50 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
          {filteredTags.map(tag => (
            <button
              key={tag.id}
              onClick={() => handleAssign(tag)}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-800 hover:bg-gray-50 transition"
            >
              <span
                className="w-3 h-3 rounded-full shrink-0"
                style={{ backgroundColor: tag.color || '#6b7280' }}
              />
              {tag.name}
            </button>
          ))}
          {showCreateOption && (
            <div className="border-t border-gray-100">
              <button
                onClick={handleCreate}
                disabled={creating}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-green-700 hover:bg-green-50 transition"
              >
                <Plus className="w-4 h-4" />
                {creating ? 'Creando...' : `Crear "${inputValue.trim()}"`}
                <span
                  className="ml-auto w-4 h-4 rounded-full border-2 border-gray-300 cursor-pointer"
                  style={{ backgroundColor: newTagColor }}
                  onClick={(e) => {
                    e.stopPropagation()
                    const idx = PRESET_COLORS.indexOf(newTagColor)
                    setNewTagColor(PRESET_COLORS[(idx + 1) % PRESET_COLORS.length])
                  }}
                  title="Cambiar color"
                />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
