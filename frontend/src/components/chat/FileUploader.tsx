'use client'

import { useState, useRef, useEffect } from 'react'
import { Paperclip, Image, Video, FileAudio, FileText, X, Upload } from 'lucide-react'

interface FileUploaderProps {
  onFileSelect: (file: File, mediaType: string) => void
  disabled?: boolean
  buttonClassName?: string
  isOpen?: boolean
  onToggle?: () => void
}

const ACCEPTED_TYPES = {
  image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
  video: ['video/mp4', 'video/3gpp', 'video/quicktime'],
  audio: ['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/opus', 'audio/aac'],
  document: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
}

const MAX_FILE_SIZE = 32 * 1024 * 1024 // 32MB

export default function FileUploader({ onFileSelect, disabled, buttonClassName, isOpen: controlledOpen, onToggle }: FileUploaderProps) {
  const [internalOpen, setInternalOpen] = useState(false)
  const [preview, setPreview] = useState<{ url: string; type: string; file: File } | null>(null)
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
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (preview) { URL.revokeObjectURL(preview.url); setPreview(null) }
        else if (isOpen) close()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKey)
    }
  }, [isOpen, preview])

  const getMediaType = (mimeType: string): string => {
    if (ACCEPTED_TYPES.image.includes(mimeType)) return 'image'
    if (ACCEPTED_TYPES.video.includes(mimeType)) return 'video'
    if (ACCEPTED_TYPES.audio.includes(mimeType)) return 'audio'
    return 'document'
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (file.size > MAX_FILE_SIZE) {
      alert('El archivo es demasiado grande. Máximo 32MB.')
      return
    }

    const mediaType = getMediaType(file.type)

    if (mediaType === 'image' || mediaType === 'video') {
      const url = URL.createObjectURL(file)
      setPreview({ url, type: mediaType, file })
    } else {
      // For audio and documents, send directly
      onFileSelect(file, mediaType)
      close()
    }

    // Reset input
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const handleSendPreview = () => {
    if (preview) {
      onFileSelect(preview.file, preview.type)
      URL.revokeObjectURL(preview.url)
      setPreview(null)
      close()
    }
  }

  const handleCancelPreview = () => {
    if (preview) {
      URL.revokeObjectURL(preview.url)
      setPreview(null)
    }
  }

  const handleSelectType = (accept: string) => {
    // Close the menu immediately when user picks a category
    if (controlledOpen && onToggle) {
      onToggle()
    } else {
      setInternalOpen(false)
    }
    if (fileInputRef.current) {
      fileInputRef.current.accept = accept
      fileInputRef.current.click()
    }
  }

  const allAcceptedTypes = [
    ...ACCEPTED_TYPES.image,
    ...ACCEPTED_TYPES.video,
    ...ACCEPTED_TYPES.audio,
    ...ACCEPTED_TYPES.document,
  ].join(',')

  return (
    <>
      <div ref={containerRef} className="relative">
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileChange}
          accept={allAcceptedTypes}
          className="hidden"
        />

        <button
          type="button"
          onClick={toggle}
          disabled={disabled}
          className={buttonClassName || "p-2 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50"}
          title="Adjuntar archivo"
        >
          <Paperclip className="w-5 h-5 text-gray-700" />
        </button>

        {isOpen && !preview && (
          <div className="absolute bottom-full mb-2 left-0 bg-white rounded-xl shadow-xl border border-gray-200 p-2 z-50 min-w-48">
            <div className="space-y-1">
              <button
                onClick={() => handleSelectType(ACCEPTED_TYPES.image.join(','))}
                className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-purple-50 rounded-lg text-left"
              >
                <div className="w-8 h-8 bg-purple-100 rounded-lg flex items-center justify-center">
                  <Image className="w-4 h-4 text-purple-600" />
                </div>
                <span className="text-sm font-semibold text-gray-800">Imagen</span>
              </button>
              <button
                onClick={() => handleSelectType(ACCEPTED_TYPES.video.join(','))}
                className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-red-50 rounded-lg text-left"
              >
                <div className="w-8 h-8 bg-red-100 rounded-lg flex items-center justify-center">
                  <Video className="w-4 h-4 text-red-600" />
                </div>
                <span className="text-sm font-semibold text-gray-800">Video</span>
              </button>
              <button
                onClick={() => handleSelectType(ACCEPTED_TYPES.audio.join(','))}
                className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-orange-50 rounded-lg text-left"
              >
                <div className="w-8 h-8 bg-orange-100 rounded-lg flex items-center justify-center">
                  <FileAudio className="w-4 h-4 text-orange-600" />
                </div>
                <span className="text-sm font-semibold text-gray-800">Audio</span>
              </button>
              <button
                onClick={() => handleSelectType(ACCEPTED_TYPES.document.join(','))}
                className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-blue-50 rounded-lg text-left"
              >
                <div className="w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center">
                  <FileText className="w-4 h-4 text-blue-600" />
                </div>
                <span className="text-sm font-semibold text-gray-800">Documento</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Preview modal */}
      {preview && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl max-w-lg w-full mx-4">
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <h3 className="font-semibold text-gray-800">Vista previa</h3>
              <button onClick={handleCancelPreview} className="p-1 hover:bg-gray-100 rounded">
                <X className="w-5 h-5 text-gray-600" />
              </button>
            </div>

            <div className="p-4">
              {preview.type === 'image' && (
                <img
                  src={preview.url}
                  alt="Preview"
                  className="max-h-80 w-full object-contain rounded-lg"
                />
              )}
              {preview.type === 'video' && (
                <video
                  src={preview.url}
                  controls
                  className="max-h-80 w-full rounded-lg"
                />
              )}
              <p className="mt-2 text-sm font-medium text-gray-700 truncate">
                {preview.file.name} ({(preview.file.size / 1024 / 1024).toFixed(2)} MB)
              </p>
            </div>

            <div className="flex gap-3 p-4 border-t border-gray-200">
              <button
                onClick={handleCancelPreview}
                className="flex-1 px-4 py-2.5 border border-gray-300 text-gray-800 font-semibold rounded-lg hover:bg-gray-100"
              >
                Cancelar
              </button>
              <button
                onClick={handleSendPreview}
                className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 flex items-center justify-center gap-2"
              >
                <Upload className="w-4 h-4" />
                Enviar
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
