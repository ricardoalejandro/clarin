'use client'

import { useState, useRef, useEffect } from 'react'
import { ChevronDown, Tag, Check } from 'lucide-react'

interface TagItem {
  id: string
  name: string
  color: string
}

interface TagSelectorProps {
  tags: TagItem[]
  selectedTagIds: string[]
  onTagChange: (ids: string[]) => void
  placeholder?: string
}

export default function TagSelector({
  tags,
  selectedTagIds,
  onTagChange,
  placeholder = 'Todas las etiquetas'
}: TagSelectorProps) {
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleToggle = (tagId: string) => {
    if (selectedTagIds.includes(tagId)) {
      onTagChange(selectedTagIds.filter(id => id !== tagId))
    } else {
      onTagChange([...selectedTagIds, tagId])
    }
  }

  const handleSelectAll = () => {
    if (selectedTagIds.length === tags.length) {
      onTagChange([])
    } else {
      onTagChange(tags.map(t => t.id))
    }
  }

  const getDisplayText = () => {
    if (selectedTagIds.length === 0 || selectedTagIds.length === tags.length) {
      return placeholder
    }
    if (selectedTagIds.length === 1) {
      const tag = tags.find(t => t.id === selectedTagIds[0])
      return tag?.name || 'Etiqueta'
    }
    return `${selectedTagIds.length} etiquetas`
  }

  if (tags.length === 0) return null

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center gap-2 px-3 py-2 bg-white border rounded-lg hover:border-green-500 focus:ring-2 focus:ring-green-500 focus:border-transparent min-w-[170px] ${
          selectedTagIds.length > 0 && selectedTagIds.length < tags.length ? 'border-green-500' : 'border-gray-300'
        }`}
      >
        <Tag className="w-4 h-4 text-green-600" />
        <span className="flex-1 text-left text-sm font-medium text-gray-800 truncate">{getDisplayText()}</span>
        <ChevronDown className={`w-4 h-4 text-gray-600 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute top-full left-0 mt-1 w-56 bg-white border border-gray-200 rounded-lg shadow-lg z-50">
          <div
            onClick={handleSelectAll}
            className="px-3 py-2.5 cursor-pointer hover:bg-green-50 border-b border-gray-200 flex items-center justify-between"
          >
            <span className="text-sm font-semibold text-gray-800">Todas las etiquetas</span>
            {selectedTagIds.length === 0 || selectedTagIds.length === tags.length ? (
              <Check className="w-5 h-5 text-green-600" />
            ) : null}
          </div>

          <div className="max-h-48 overflow-y-auto">
            {tags.map(tag => (
              <div
                key={tag.id}
                onClick={() => handleToggle(tag.id)}
                className={`px-3 py-2.5 cursor-pointer hover:bg-green-50 flex items-center justify-between ${
                  selectedTagIds.includes(tag.id) ? 'bg-green-50' : ''
                }`}
              >
                <div className="flex items-center gap-3">
                  <div
                    className="w-3 h-3 rounded-full flex-shrink-0"
                    style={{ backgroundColor: tag.color }}
                  />
                  <span className="text-sm font-medium text-gray-800">{tag.name}</span>
                </div>
                {selectedTagIds.includes(tag.id) && (
                  <Check className="w-5 h-5 text-green-600" />
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
