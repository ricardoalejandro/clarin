'use client'

import React, { useState, useEffect, useCallback } from 'react'
import { X, ZoomIn, ZoomOut, RotateCw, Download } from 'lucide-react'

interface ImageViewerProps {
  src: string
  alt?: string
  isOpen: boolean
  onClose: () => void
}

export default function ImageViewer({ src, alt, isOpen, onClose }: ImageViewerProps) {
  const [scale, setScale] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })

  const resetView = useCallback(() => {
    setScale(1)
    setRotation(0)
    setPosition({ x: 0, y: 0 })
  }, [])

  useEffect(() => {
    if (isOpen) {
      resetView()
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [isOpen, resetView])

  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          onClose()
          break
        case '+':
        case '=':
          setScale((s: number) => Math.min(s + 0.25, 5))
          break
        case '-':
          setScale((s: number) => Math.max(s - 0.25, 0.25))
          break
        case 'r':
          setRotation((r: number) => r + 90)
          break
        case '0':
          resetView()
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose, resetView])

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? -0.15 : 0.15
    setScale((s: number) => Math.min(Math.max(s + delta, 0.25), 5))
  }, [])

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    setIsDragging(true)
    setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y })
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return
    setPosition({
      x: e.clientX - dragStart.x,
      y: e.clientY - dragStart.y,
    })
  }

  const handleMouseUp = () => {
    setIsDragging(false)
  }

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose()
    }
  }

  const handleDownload = () => {
    const link = document.createElement('a')
    link.href = src
    link.download = alt || 'imagen'
    link.target = '_blank'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-[100] bg-black/90 flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-3 bg-black/50 backdrop-blur-sm">
        <div className="text-white text-sm font-medium truncate max-w-[50%]">
          {alt || 'Imagen'}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setScale((s: number) => Math.min(s + 0.25, 5))}
            className="p-2 text-white/80 hover:text-white hover:bg-white/10 rounded-lg transition"
            title="Acercar (+)"
          >
            <ZoomIn className="w-5 h-5" />
          </button>
          <button
            onClick={() => setScale((s: number) => Math.max(s - 0.25, 0.25))}
            className="p-2 text-white/80 hover:text-white hover:bg-white/10 rounded-lg transition"
            title="Alejar (-)"
          >
            <ZoomOut className="w-5 h-5" />
          </button>
          <span className="text-white/60 text-sm px-2 min-w-[50px] text-center">
            {Math.round(scale * 100)}%
          </span>
          <button
            onClick={() => setRotation((r: number) => r + 90)}
            className="p-2 text-white/80 hover:text-white hover:bg-white/10 rounded-lg transition"
            title="Rotar (R)"
          >
            <RotateCw className="w-5 h-5" />
          </button>
          <button
            onClick={handleDownload}
            className="p-2 text-white/80 hover:text-white hover:bg-white/10 rounded-lg transition"
            title="Descargar"
          >
            <Download className="w-5 h-5" />
          </button>
          <div className="w-px h-6 bg-white/20 mx-1" />
          <button
            onClick={onClose}
            className="p-2 text-white/80 hover:text-white hover:bg-white/10 rounded-lg transition"
            title="Cerrar (Esc)"
          >
            <X className="w-6 h-6" />
          </button>
        </div>
      </div>

      {/* Image area */}
      <div
        className="flex-1 flex items-center justify-center overflow-hidden cursor-grab active:cursor-grabbing"
        onClick={handleBackdropClick}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
      >
        <img
          src={src}
          alt={alt || 'Imagen'}
          className="max-w-none select-none pointer-events-none"
          style={{
            transform: `translate(${position.x}px, ${position.y}px) scale(${scale}) rotate(${rotation}deg)`,
            transition: isDragging ? 'none' : 'transform 0.2s ease-out',
            maxHeight: '90vh',
            maxWidth: '90vw',
          }}
          draggable={false}
        />
      </div>

      {/* Hint */}
      <div className="text-center py-2 text-white/40 text-xs">
        Scroll para zoom · Arrastra para mover · Esc para cerrar
      </div>
    </div>
  )
}
