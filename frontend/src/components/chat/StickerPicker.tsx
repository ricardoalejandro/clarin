'use client'

import { useState, useEffect, useRef } from 'react'
import { X, Upload, Sticker, Star, Trash2 } from 'lucide-react'

interface StickerPickerProps {
  onStickerSelect: (stickerUrl: string, file?: File) => void
  isOpen?: boolean
  onToggle?: () => void
}

export default function StickerPicker({ onStickerSelect, isOpen: controlledOpen, onToggle }: StickerPickerProps) {
  const [internalOpen, setInternalOpen] = useState(false)
  const [tab, setTab] = useState<'recent' | 'saved'>('recent')
  const [recentStickers, setRecentStickers] = useState<string[]>([])
  const [savedStickers, setSavedStickers] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
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

  useEffect(() => {
    if (isOpen) {
      fetchStickers()
    }
  }, [isOpen])

  const fetchStickers = async () => {
    setLoading(true)
    const token = localStorage.getItem('token')
    try {
      const [recentRes, savedRes] = await Promise.all([
        fetch('/api/stickers/recent', { headers: { Authorization: `Bearer ${token}` } }),
        fetch('/api/stickers/saved', { headers: { Authorization: `Bearer ${token}` } }),
      ])
      const recentData = await recentRes.json()
      const savedData = await savedRes.json()
      if (recentData.success) setRecentStickers(recentData.stickers || [])
      if (savedData.success) setSavedStickers(savedData.stickers || [])
    } catch (err) {
      console.error('Error fetching stickers:', err)
    } finally {
      setLoading(false)
    }
  }

  const handleRemoveSaved = async (url: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const token = localStorage.getItem('token')
    try {
      await fetch('/api/stickers/saved', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ media_url: url }),
      })
      setSavedStickers(prev => prev.filter(s => s !== url))
    } catch (err) {
      console.error('Error removing saved sticker:', err)
    }
  }

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = 512
      canvas.height = 512
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        URL.revokeObjectURL(url)
        return
      }

      const scale = Math.min(512 / img.width, 512 / img.height)
      const w = img.width * scale
      const h = img.height * scale
      const x = (512 - w) / 2
      const y = (512 - h) / 2

      ctx.clearRect(0, 0, 512, 512)
      ctx.drawImage(img, x, y, w, h)

      canvas.toBlob(
        (blob) => {
          if (blob) {
            const webpFile = new File([blob], 'sticker.webp', { type: 'image/webp' })
            onStickerSelect('', webpFile)
            close()
          }
          URL.revokeObjectURL(url)
        },
        'image/webp',
        0.9
      )
    }
    img.onerror = () => URL.revokeObjectURL(url)
    img.src = url

    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleStickerClick = (stickerUrl: string) => {
    onStickerSelect(stickerUrl)
    close()
  }

  const stickers = tab === 'recent' ? recentStickers : savedStickers

  return (
    <div ref={containerRef} className="relative">
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileUpload}
        accept="image/webp,image/png,image/jpeg,image/gif"
        className="hidden"
      />

      <button
        type="button"
        onClick={toggle}
        className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
        title="Stickers"
      >
        <Sticker className="w-5 h-5 text-gray-700" />
      </button>

      {isOpen && (
        <div className="absolute bottom-full mb-2 left-0 bg-white rounded-xl shadow-xl border border-gray-200 w-[calc(100vw-2rem)] sm:w-80 max-w-80 z-50">
          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100">
            <span className="font-semibold text-gray-800 text-sm">Stickers</span>
            <button onClick={close} className="p-1 hover:bg-gray-100 rounded">
              <X className="w-4 h-4 text-gray-500" />
            </button>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-gray-100">
            <button
              onClick={() => setTab('recent')}
              className={`flex-1 py-2 text-xs font-medium transition-colors ${
                tab === 'recent'
                  ? 'text-green-600 border-b-2 border-green-600'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Recientes
            </button>
            <button
              onClick={() => setTab('saved')}
              className={`flex-1 py-2 text-xs font-medium transition-colors flex items-center justify-center gap-1 ${
                tab === 'saved'
                  ? 'text-green-600 border-b-2 border-green-600'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              <Star className="w-3 h-3" />
              Favoritos
              {savedStickers.length > 0 && (
                <span className="bg-gray-200 text-gray-600 text-[10px] rounded-full px-1.5">{savedStickers.length}</span>
              )}
            </button>
          </div>

          <div className="p-2 h-56 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-10">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-green-600" />
              </div>
            ) : stickers.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-gray-400">
                {tab === 'recent' ? (
                  <>
                    <Sticker className="w-10 h-10 mb-2" />
                    <p className="text-sm">No hay stickers aún</p>
                    <p className="text-xs mt-1">Los stickers recibidos aparecerán aquí</p>
                  </>
                ) : (
                  <>
                    <Star className="w-10 h-10 mb-2" />
                    <p className="text-sm">Sin favoritos</p>
                    <p className="text-xs mt-1">Guarda stickers con la estrella ⭐</p>
                  </>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-4 gap-1.5">
                {stickers.map((url, i) => (
                  <div key={i} className="relative group/item">
                    <button
                      onClick={() => handleStickerClick(url)}
                      className="aspect-square w-full rounded-lg hover:bg-gray-100 p-1 transition-colors"
                    >
                      <img
                        src={url}
                        alt="Sticker"
                        className="w-full h-full object-contain"
                        loading="lazy"
                      />
                    </button>
                    {tab === 'saved' && (
                      <button
                        onClick={(e) => handleRemoveSaved(url, e)}
                        className="absolute -top-1 -right-1 p-0.5 bg-red-500 text-white rounded-full opacity-0 group-hover/item:opacity-100 transition-opacity shadow"
                        title="Quitar de favoritos"
                      >
                        <Trash2 className="w-2.5 h-2.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="px-2 pb-2 border-t border-gray-100 pt-2">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-lg transition-colors border border-dashed border-gray-300"
            >
              <Upload className="w-4 h-4" />
              Subir imagen como sticker
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
