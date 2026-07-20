'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Camera, Check, ChevronDown, Contrast, FlipHorizontal2, FlipVertical2,
  ImagePlus, Loader2, Maximize2, RefreshCw, RotateCw, SlidersHorizontal, Trash2, Undo2, X,
} from 'lucide-react'
import { api, apiUpload } from '@/lib/api'

export type ContactAvatarContextType = 'contact' | 'lead' | 'chat' | 'event_participant' | 'program_participant'

export interface ContactAvatarInfo {
  contact_id?: string
  avatar_url?: string | null
  source?: 'legacy' | 'whatsapp' | 'manual' | null
  revision: number
  updated_at?: string | null
  whatsapp_checked_at?: string | null
  whatsapp_check_error?: string | null
  automatic_fetch_at?: string | null
  size_bytes?: number | null
}

interface AvatarDevice {
  id: string
  name?: string | null
  phone?: string | null
}

interface AvatarMetadataResponse {
  success: boolean
  avatar: ContactAvatarInfo
  devices: AvatarDevice[]
}

interface AvatarCandidate {
  data_url: string
  token: string
  device_id: string
  expires_at: string
}

interface AvatarPreviewResponse {
  success: boolean
  available: boolean
  candidate?: AvatarCandidate
  code?: string
  message?: string
}

interface ContactAvatarControlProps {
  contactId: string
  contextType: ContactAvatarContextType
  contextId: string
  displayName: string
  avatarUrl?: string | null
  disabled?: boolean
  compact?: boolean
  onChange?: (avatar: ContactAvatarInfo) => void
}

type DialogMode = 'none' | 'view' | 'device' | 'preview' | 'editor' | 'remove'

interface ImageTransform {
  zoom: number
  offsetX: number
  offsetY: number
  rotation: number
  flipX: boolean
  flipY: boolean
  brightness: number
  contrast: number
}

const initialTransform: ImageTransform = {
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
  rotation: 0,
  flipX: false,
  flipY: false,
  brightness: 100,
  contrast: 100,
}

const targetAvatarBytes = 250 * 1024
const avatarMenuWidth = 256
const avatarMenuMargin = 8
const avatarMenuGap = 8

export default function ContactAvatarControl({
  contactId,
  contextType,
  contextId,
  displayName,
  avatarUrl,
  disabled = false,
  compact = false,
  onChange,
}: ContactAvatarControlProps) {
  const [avatar, setAvatar] = useState<ContactAvatarInfo>({ avatar_url: avatarUrl, revision: 0 })
  const [devices, setDevices] = useState<AvatarDevice[]>([])
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number; maxHeight: number } | null>(null)
  const [dialog, setDialog] = useState<DialogMode>('none')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [candidate, setCandidate] = useState<AvatarCandidate | null>(null)
  const [previewEmpty, setPreviewEmpty] = useState<{ code?: string; message: string } | null>(null)
  const [selectedDevice, setSelectedDevice] = useState('')
  const [editorURL, setEditorURL] = useState('')
  const [editorImage, setEditorImage] = useState<HTMLImageElement | null>(null)
  const [transform, setTransform] = useState<ImageTransform>(initialTransform)
  const [history, setHistory] = useState<ImageTransform[]>([])
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef({ x: 0, y: 0, startX: 0, startY: 0 })
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuTriggerRef = useRef<HTMLButtonElement>(null)
  const menuPopupRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const metadataRequestRef = useRef(0)
  const operationRequestRef = useRef(0)
  const operationControllerRef = useRef<AbortController | null>(null)
  const filePickerIdentityRef = useRef('')
  const busyRef = useRef(false)
  const identityKey = `${contactId}:${contextType}:${contextId}`
  const identityRef = useRef(identityKey)

  const updateBusy = useCallback((value: boolean) => {
    busyRef.current = value
    setBusy(value)
  }, [])

  const currentURL = avatar.avatar_url ?? ''
  const initials = useMemo(() => {
    const parts = displayName.trim().split(/\s+/).filter(Boolean)
    return (parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')
  }, [displayName])
  const contextQuery = useMemo(() => new URLSearchParams({
    context_type: contextType,
    context_id: contextId,
  }).toString(), [contextId, contextType])

  const publishAvatar = useCallback((next: ContactAvatarInfo) => {
    setAvatar(next)
    onChange?.(next)
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('clarin:contact-avatar-updated', {
        detail: { contactId, avatar: next },
      }))
    }
  }, [contactId, onChange])

  const beginOperation = useCallback(() => {
    operationControllerRef.current?.abort()
    const controller = new AbortController()
    operationControllerRef.current = controller
    return {
      id: ++operationRequestRef.current,
      identity: identityRef.current,
      signal: controller.signal,
    }
  }, [])

  const operationIsCurrent = useCallback((operation: { id: number; identity: string }) => (
    operation.id === operationRequestRef.current && operation.identity === identityRef.current
  ), [])

  useEffect(() => {
    identityRef.current = identityKey
    operationRequestRef.current++
    operationControllerRef.current?.abort()
    operationControllerRef.current = null
    const requestID = ++metadataRequestRef.current
    const controller = new AbortController()
    setAvatar({ avatar_url: avatarUrl, revision: 0 })
    setDevices([])
    setMenuOpen(false)
    setMenuPosition(null)
    setDialog('none')
    updateBusy(false)
    setError('')
    setCandidate(null)
    setPreviewEmpty(null)
    setSelectedDevice('')
    filePickerIdentityRef.current = ''
    setEditorImage(null)
    setEditorURL('')
    setTransform(initialTransform)
    setHistory([])
    setDragging(false)
    void api<AvatarMetadataResponse>(`/api/contact-avatars/${contactId}?${contextQuery}`, {
      signal: controller.signal,
    }).then(result => {
      if (requestID !== metadataRequestRef.current || identityKey !== identityRef.current || !result.success || !result.data) return
      setAvatar(result.data.avatar || { avatar_url: avatarUrl, revision: 0 })
      setDevices(result.data.devices || [])
    })
    return () => {
      controller.abort()
      metadataRequestRef.current++
      operationRequestRef.current++
      operationControllerRef.current?.abort()
    }
  }, [avatarUrl, contactId, contextQuery, identityKey, updateBusy])

  useEffect(() => {
    const syncAvatar = (event: Event) => {
      const detail = (event as CustomEvent<{ contactId?: string; avatar?: ContactAvatarInfo }>).detail
      if (detail?.contactId === contactId && detail.avatar) setAvatar(detail.avatar)
    }
    window.addEventListener('clarin:contact-avatar-updated', syncAvatar)
    return () => window.removeEventListener('clarin:contact-avatar-updated', syncAvatar)
  }, [contactId])

  const positionMenu = useCallback(() => {
    const trigger = menuTriggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) {
      setMenuOpen(false)
      setMenuPosition(null)
      return
    }
    const maxHeight = Math.max(160, window.innerHeight - avatarMenuMargin * 2)
    const measuredHeight = Math.min(menuPopupRef.current?.offsetHeight || 300, maxHeight)
    const below = rect.bottom + avatarMenuGap
    const above = rect.top - avatarMenuGap - measuredHeight
    const top = below + measuredHeight <= window.innerHeight - avatarMenuMargin
      ? below
      : Math.max(avatarMenuMargin, above)
    const preferredLeft = rect.left
    const alternativeLeft = rect.right - avatarMenuWidth
    const left = Math.min(
      Math.max(preferredLeft + avatarMenuWidth <= window.innerWidth - avatarMenuMargin ? preferredLeft : alternativeLeft, avatarMenuMargin),
      Math.max(avatarMenuMargin, window.innerWidth - avatarMenuWidth - avatarMenuMargin),
    )
    setMenuPosition({ top, left, maxHeight })
  }, [])

  useEffect(() => {
    if (!menuOpen) return
    const close = (event: MouseEvent) => {
      const target = event.target as Node
      if (!menuRef.current?.contains(target) && !menuPopupRef.current?.contains(target)) {
        setMenuOpen(false)
        setMenuPosition(null)
      }
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      setMenuOpen(false)
      setMenuPosition(null)
      requestAnimationFrame(() => menuTriggerRef.current?.focus())
    }
    const reposition = () => requestAnimationFrame(positionMenu)
    const frame = requestAnimationFrame(() => {
      positionMenu()
      menuPopupRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    })
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape, true)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', escape, true)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [menuOpen, positionMenu])

  useEffect(() => {
    return () => {
      if (editorURL.startsWith('blob:')) URL.revokeObjectURL(editorURL)
    }
  }, [editorURL])

  const closeDialog = useCallback(() => {
    if (busyRef.current) return
    setDialog('none')
    setCandidate(null)
    setPreviewEmpty(null)
    setError('')
    setDragging(false)
  }, [])

  const dialogOpen = dialog !== 'none'
  useEffect(() => {
    if (!dialogOpen) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusableSelector = 'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    const frame = window.requestAnimationFrame(() => {
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector)
      focusable?.[0]?.focus()
    })
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        closeDialog()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) || [])
      if (focusable.length === 0) {
        event.preventDefault()
        dialogRef.current?.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!dialogRef.current?.contains(document.activeElement)) {
        event.preventDefault()
        first.focus()
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('keydown', handleKeyDown, true)
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [closeDialog, dialogOpen])

  const requestWhatsAppPreview = async (deviceId?: string) => {
    const operation = beginOperation()
    updateBusy(true)
    setError('')
    setCandidate(null)
    setPreviewEmpty(null)
    const result = await api<AvatarPreviewResponse>(`/api/contact-avatars/${contactId}/whatsapp-preview`, {
      method: 'POST',
      body: JSON.stringify({ context_type: contextType, context_id: contextId, device_id: deviceId || '' }),
      signal: operation.signal,
    })
    if (!operationIsCurrent(operation)) return
    updateBusy(false)
    if (!result.success || !result.data) {
      setError(result.error || 'No se pudo consultar la foto de WhatsApp')
      return
    }
    if (!result.data.available) {
      setPreviewEmpty({
        code: result.data.code,
        message: result.data.message || 'Este contacto no tiene una foto visible en WhatsApp.',
      })
      setDialog('preview')
      return
    }
    if (!result.data.candidate) {
      setError('WhatsApp no devolvió una previsualización válida')
      return
    }
    setCandidate(result.data.candidate)
    setSelectedDevice(result.data.candidate.device_id)
    setDialog('preview')
  }

  const beginWhatsAppRefresh = () => {
    setMenuOpen(false)
    setMenuPosition(null)
    setError('')
    setPreviewEmpty(null)
    if (devices.length > 1) {
      setSelectedDevice('')
      setDialog('device')
      return
    }
    setDialog('preview')
    void requestWhatsAppPreview(devices[0]?.id)
  }

  const confirmWhatsAppAvatar = async () => {
    if (!candidate) return
    const operation = beginOperation()
    updateBusy(true)
    setError('')
    const result = await api<{ success: boolean; avatar: ContactAvatarInfo }>(`/api/contact-avatars/${contactId}/whatsapp-confirm`, {
      method: 'POST',
      body: JSON.stringify({
        context_type: contextType,
        context_id: contextId,
        preview_token: candidate.token,
        data_url: candidate.data_url,
      }),
      signal: operation.signal,
    })
    if (!operationIsCurrent(operation)) return
    updateBusy(false)
    if (!result.success || !result.data?.avatar) {
      setError(result.error || 'No se pudo reemplazar la foto')
      return
    }
    publishAvatar(result.data.avatar)
    setDialog('none')
    setCandidate(null)
  }

  const openFilePicker = () => {
    setMenuOpen(false)
    setMenuPosition(null)
    filePickerIdentityRef.current = identityRef.current
    fileInputRef.current?.click()
  }

  const loadEditorFile = (file: File) => {
    if (filePickerIdentityRef.current !== identityRef.current) return
    if (!['image/jpeg', 'image/png'].includes(file.type) || file.size > 8 * 1024 * 1024) {
      setEditorImage(null)
      setError('Usa una imagen JPEG o PNG de hasta 8 MB')
      setDialog('editor')
      return
    }
    const operation = beginOperation()
    if (editorURL.startsWith('blob:')) URL.revokeObjectURL(editorURL)
    const objectURL = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      if (!operationIsCurrent(operation)) {
        URL.revokeObjectURL(objectURL)
        return
      }
      setEditorURL(objectURL)
      setEditorImage(image)
      setTransform(initialTransform)
      setHistory([])
      setError('')
      setDialog('editor')
    }
    image.onerror = () => {
      URL.revokeObjectURL(objectURL)
      if (!operationIsCurrent(operation)) return
      setError('No se pudo leer la imagen')
      setDialog('editor')
    }
    image.src = objectURL
  }

  const drawEditor = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !editorImage) return
    const context = canvas.getContext('2d')
    if (!context) return
    const size = canvas.width
    context.clearRect(0, 0, size, size)
    context.fillStyle = '#e2e8f0'
    context.fillRect(0, 0, size, size)
    context.save()
    context.translate(size / 2 + transform.offsetX, size / 2 + transform.offsetY)
    context.rotate(transform.rotation * Math.PI / 180)
    context.scale(transform.flipX ? -1 : 1, transform.flipY ? -1 : 1)
    context.filter = `brightness(${transform.brightness}%) contrast(${transform.contrast}%)`
    const quarterTurn = Math.abs(transform.rotation / 90) % 2 === 1
    const sourceWidth = quarterTurn ? editorImage.naturalHeight : editorImage.naturalWidth
    const sourceHeight = quarterTurn ? editorImage.naturalWidth : editorImage.naturalHeight
    const baseScale = Math.max(size / sourceWidth, size / sourceHeight)
    const width = editorImage.naturalWidth * baseScale * transform.zoom
    const height = editorImage.naturalHeight * baseScale * transform.zoom
    context.drawImage(editorImage, -width / 2, -height / 2, width, height)
    context.restore()
  }, [editorImage, transform])

  useEffect(() => drawEditor(), [drawEditor])

  const rememberAndSet = (next: ImageTransform) => {
    setHistory(previous => [...previous.slice(-9), transform])
    setTransform(next)
  }

  const rememberCurrentTransform = () => {
    setHistory(previous => [...previous.slice(-9), transform])
  }

  const undoTransform = () => {
    setHistory(previous => {
      if (previous.length === 0) return previous
      setTransform(previous[previous.length - 1])
      return previous.slice(0, -1)
    })
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!editorImage) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { x: event.clientX, y: event.clientY, startX: transform.offsetX, startY: transform.offsetY }
    setHistory(previous => [...previous.slice(-9), transform])
    setDragging(true)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragging) return
    const deltaX = event.clientX - dragRef.current.x
    const deltaY = event.clientY - dragRef.current.y
    setTransform(previous => ({ ...previous, offsetX: dragRef.current.startX + deltaX, offsetY: dragRef.current.startY + deltaY }))
  }

  const exportEditorBlob = async (): Promise<Blob | null> => {
    const canvas = canvasRef.current
    if (!canvas) return null
    let quality = 0.86
    let blob: Blob | null = null
    while (quality >= 0.7) {
      blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality))
      if (!blob || blob.size <= targetAvatarBytes) break
      quality -= 0.04
    }
    return blob
  }

  const saveManualAvatar = async () => {
    if (!editorImage) return
    const operation = beginOperation()
    updateBusy(true)
    setError('')
    const blob = await exportEditorBlob()
    if (!operationIsCurrent(operation)) return
    if (!blob) {
      updateBusy(false)
      setError('No se pudo preparar la imagen')
      return
    }
    const form = new FormData()
    form.append('image', blob, 'contact-avatar.jpg')
    form.append('context_type', contextType)
    form.append('context_id', contextId)
    const result = await apiUpload<{ success: boolean; avatar: ContactAvatarInfo }>(`/api/contact-avatars/${contactId}/upload`, form, {
      signal: operation.signal,
    })
    if (!operationIsCurrent(operation)) return
    updateBusy(false)
    if (!result.success || !result.data?.avatar) {
      setError(result.error || 'No se pudo guardar la foto')
      return
    }
    publishAvatar(result.data.avatar)
    setDialog('none')
  }

  const removeAvatar = async () => {
    const operation = beginOperation()
    updateBusy(true)
    setError('')
    const result = await api<{ success: boolean; avatar: ContactAvatarInfo }>(`/api/contact-avatars/${contactId}?${contextQuery}`, {
      method: 'DELETE',
      signal: operation.signal,
    })
    if (!operationIsCurrent(operation)) return
    updateBusy(false)
    if (!result.success || !result.data?.avatar) {
      setError(result.error || 'No se pudo quitar la foto')
      return
    }
    publishAvatar(result.data.avatar)
    setDialog('none')
  }

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = Array.from(menuPopupRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') || [])
    if (items.length === 0) return
    event.preventDefault()
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement)
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : event.key === 'ArrowDown'
          ? (currentIndex + 1 + items.length) % items.length
          : (currentIndex - 1 + items.length) % items.length
    items[nextIndex]?.focus()
  }

  return (
    <>
      <div ref={menuRef} className={`relative inline-flex ${compact ? '' : 'mb-2'}`}>
        <div className={`relative ${compact ? 'h-12 w-12' : 'h-16 w-16'}`}>
          {currentURL ? (
            <button type="button" onClick={() => setDialog('view')} className="h-full w-full rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2" aria-label={`Ampliar foto de ${displayName}`}>
              <img
                key={`${currentURL}:${avatar.revision}`}
                src={currentURL}
                alt={`Foto de ${displayName}`}
                className="h-full w-full rounded-full border-2 border-white object-cover shadow-sm ring-1 ring-slate-200"
              />
            </button>
          ) : (
            <div className="flex h-full w-full items-center justify-center rounded-full bg-emerald-50 text-sm font-bold uppercase text-emerald-700 ring-1 ring-emerald-100">
              {initials}
            </div>
          )}
          {!disabled && (
            <button
              ref={menuTriggerRef}
              type="button"
              onClick={() => setMenuOpen(open => {
                if (open) setMenuPosition(null)
                return !open
              })}
              className="absolute -bottom-1 -right-1 flex h-7 w-7 items-center justify-center rounded-full border-2 border-white bg-emerald-600 text-white shadow-md transition hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2"
              aria-label="Gestionar foto del contacto"
              aria-expanded={menuOpen}
            >
              <Camera className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {menuOpen && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuPopupRef}
          role="menu"
          aria-label="Opciones de foto del contacto"
          onKeyDown={handleMenuKeyDown}
          className="fixed z-[95] w-64 overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5 text-left shadow-2xl shadow-slate-900/20 outline-none"
          style={{
            top: menuPosition?.top ?? 0,
            left: menuPosition?.left ?? 0,
            maxHeight: menuPosition?.maxHeight ?? 320,
            visibility: menuPosition ? 'visible' : 'hidden',
          }}
        >
          <p className="px-2.5 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Foto del contacto</p>
          {currentURL && (
            <button role="menuitem" type="button" onClick={() => { setMenuOpen(false); setMenuPosition(null); setDialog('view') }} className="flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
              <Maximize2 className="h-4 w-4 text-slate-500" /> Ver foto
            </button>
          )}
          <button role="menuitem" type="button" onClick={beginWhatsAppRefresh} className="flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
            <RefreshCw className="h-4 w-4 text-emerald-600" /> Actualizar desde WhatsApp
          </button>
          <button role="menuitem" type="button" onClick={openFilePicker} className="flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
            <ImagePlus className="h-4 w-4 text-sky-600" /> {currentURL ? 'Subir o reemplazar' : 'Subir una imagen'}
          </button>
          {currentURL && (
            <button role="menuitem" type="button" onClick={() => { setMenuOpen(false); setMenuPosition(null); setError(''); setDialog('remove') }} className="flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-red-600 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500">
              <Trash2 className="h-4 w-4" /> Quitar foto
            </button>
          )}
          <div className="mt-1 border-t border-slate-100 px-2.5 py-2 text-[11px] text-slate-400">
            {avatar.source === 'manual' ? 'Imagen subida a Clarin' : avatar.source === 'whatsapp' ? 'Actualizada desde WhatsApp' : avatar.source === 'legacy' ? 'Foto anterior de WhatsApp' : 'Sin foto guardada'}
          </div>
        </div>,
        document.body,
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png"
        className="hidden"
        onChange={event => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) loadEditorFile(file)
        }}
      />

      {dialog !== 'none' && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/55 p-3 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-label="Gestionar foto del contacto">
          <div ref={dialogRef} tabIndex={-1} className={`flex max-h-[94vh] w-full flex-col overflow-hidden rounded-2xl border border-white/70 bg-white shadow-2xl outline-none ${dialog === 'editor' ? 'max-w-3xl' : 'max-w-lg'}`}>
            <div className="flex min-h-14 items-center justify-between border-b border-slate-200 px-5">
              <div>
                <h3 className="font-semibold text-slate-900">
                  {dialog === 'editor' ? 'Editar foto' : dialog === 'preview' ? 'Comparar con WhatsApp' : dialog === 'device' ? 'Elegir dispositivo' : dialog === 'view' ? 'Foto del contacto' : 'Quitar foto'}
                </h3>
                <p className="text-xs text-slate-500">{displayName}</p>
              </div>
              <button type="button" onClick={closeDialog} disabled={busy} className="flex h-10 w-10 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 disabled:opacity-40" aria-label="Cerrar">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="overflow-y-auto p-5">
              {dialog === 'device' && (
                <div className="space-y-3">
                  <p className="text-sm text-slate-600">Selecciona qué sesión de WhatsApp consultará la foto. No se sustituirá nada hasta que confirmes la comparación.</p>
                  {devices.map(device => (
                    <button
                      key={device.id}
                      type="button"
                      onClick={() => setSelectedDevice(device.id)}
                      className={`flex min-h-12 w-full items-center justify-between rounded-xl border px-4 py-3 text-left transition ${selectedDevice === device.id ? 'border-emerald-500 bg-emerald-50 ring-1 ring-emerald-200' : 'border-slate-200 hover:bg-slate-50'}`}
                    >
                      <span><span className="block text-sm font-medium text-slate-800">{device.name || 'WhatsApp Web'}</span><span className="block text-xs text-slate-500">{device.phone || 'Conectado'}</span></span>
                      {selectedDevice === device.id && <Check className="h-5 w-5 text-emerald-600" />}
                    </button>
                  ))}
                </div>
              )}

              {dialog === 'preview' && (
                <div>
                  {busy && !candidate ? (
                    <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-sm text-slate-500"><Loader2 className="h-7 w-7 animate-spin text-emerald-600" /> Consultando WhatsApp…</div>
                  ) : candidate ? (
                    <div className="grid grid-cols-2 gap-4">
                      <AvatarComparison label="Foto actual" url={currentURL} initials={initials} />
                      <AvatarComparison label="Foto encontrada" url={candidate.data_url} initials={initials} highlight />
                    </div>
                  ) : previewEmpty ? (
                    <div className="min-h-48 rounded-xl border border-slate-200 bg-slate-50 p-6 text-center">
                      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-white text-slate-400 ring-1 ring-slate-200">
                        <Camera className="h-5 w-5" />
                      </div>
                      <p className="mt-3 text-sm font-medium text-slate-700">No hay una foto visible</p>
                      <p className="mt-1 text-sm leading-relaxed text-slate-500">{previewEmpty.message}</p>
                    </div>
                  ) : (
                    <div className="min-h-48 rounded-xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-500">No se pudo cargar una foto candidata.</div>
                  )}
                  <p className="mt-4 rounded-xl bg-slate-50 px-3 py-2.5 text-xs leading-relaxed text-slate-600">WhatsApp puede ocultar la foto por privacidad. Un resultado vacío nunca eliminará la foto actual automáticamente.</p>
                </div>
              )}

              {dialog === 'remove' && (
                <div className="rounded-xl border border-red-100 bg-red-50 p-4 text-sm leading-relaxed text-red-800">
                  Se quitará la foto de Clarin en todos los lugares donde aparece este Contacto. No se modificará la foto del perfil en WhatsApp.
                </div>
              )}

              {dialog === 'view' && currentURL && (
                <div className="flex min-h-72 items-center justify-center rounded-2xl bg-slate-950 p-4">
                  <img src={currentURL} alt={`Foto de ${displayName}`} className="max-h-[70vh] max-w-full rounded-xl object-contain shadow-2xl" />
                </div>
              )}

              {dialog === 'editor' && (
                <div className="grid gap-6 md:grid-cols-[minmax(280px,1fr)_250px]">
                  <div className="mx-auto w-full max-w-[480px]">
                    <div className="relative aspect-square overflow-hidden rounded-2xl bg-slate-200 shadow-inner">
                      <canvas
                        ref={canvasRef}
                        width={512}
                        height={512}
                        onPointerDown={handlePointerDown}
                        onPointerMove={handlePointerMove}
                        onPointerUp={() => setDragging(false)}
                        onPointerCancel={() => setDragging(false)}
                        className={`h-full w-full touch-none ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
                      />
                      <div className="pointer-events-none absolute inset-[7%] rounded-full border-2 border-white/90 shadow-[0_0_0_999px_rgba(15,23,42,0.32)]" />
                    </div>
                    <p className="mt-2 text-center text-xs text-slate-500">Arrastra para encuadrar. La guía circular muestra cómo se verá en las listas.</p>
                  </div>

                  <div className="space-y-4">
                    <EditorSlider label="Zoom" value={transform.zoom} min={1} max={3} step={0.05} onChangeStart={rememberCurrentTransform} onChange={zoom => setTransform(previous => ({ ...previous, zoom }))} />
                    <EditorSlider label="Brillo" value={transform.brightness} min={60} max={140} step={1} suffix="%" icon={<SlidersHorizontal className="h-4 w-4" />} onChangeStart={rememberCurrentTransform} onChange={brightness => setTransform(previous => ({ ...previous, brightness }))} />
                    <EditorSlider label="Contraste" value={transform.contrast} min={60} max={140} step={1} suffix="%" icon={<Contrast className="h-4 w-4" />} onChangeStart={rememberCurrentTransform} onChange={contrast => setTransform(previous => ({ ...previous, contrast }))} />
                    <div>
                      <p className="mb-2 text-xs font-medium text-slate-600">Orientación</p>
                      <div className="grid grid-cols-3 gap-2">
                        <EditorButton label="Girar" onClick={() => rememberAndSet({ ...transform, rotation: (transform.rotation + 90) % 360 })}><RotateCw className="h-4 w-4" /></EditorButton>
                        <EditorButton label="Horizontal" onClick={() => rememberAndSet({ ...transform, flipX: !transform.flipX })}><FlipHorizontal2 className="h-4 w-4" /></EditorButton>
                        <EditorButton label="Vertical" onClick={() => rememberAndSet({ ...transform, flipY: !transform.flipY })}><FlipVertical2 className="h-4 w-4" /></EditorButton>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2 border-t border-slate-100 pt-4">
                      <EditorButton label="Deshacer" disabled={history.length === 0} onClick={undoTransform}><Undo2 className="h-4 w-4" /></EditorButton>
                      <EditorButton label="Restablecer" onClick={() => rememberAndSet(initialTransform)}><RefreshCw className="h-4 w-4" /></EditorButton>
                    </div>
                  </div>
                </div>
              )}

              {error && <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">{error}</div>}
            </div>

            <div className="flex min-h-16 items-center justify-end gap-2 border-t border-slate-200 bg-slate-50/70 px-5">
              <button type="button" onClick={closeDialog} disabled={busy} className="min-h-10 rounded-xl px-4 text-sm font-medium text-slate-600 hover:bg-white disabled:opacity-40">Cancelar</button>
              {dialog === 'device' && <button type="button" disabled={!selectedDevice || busy} onClick={() => { setDialog('preview'); void requestWhatsAppPreview(selectedDevice) }} className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-40">Continuar <ChevronDown className="h-4 w-4 -rotate-90" /></button>}
              {dialog === 'preview' && <button type="button" disabled={!candidate || busy} onClick={confirmWhatsAppAvatar} className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-40">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Usar esta foto</button>}
              {dialog === 'editor' && <button type="button" disabled={!editorImage || busy} onClick={saveManualAvatar} className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-40">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Guardar foto</button>}
              {dialog === 'remove' && <button type="button" disabled={busy} onClick={removeAvatar} className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-red-600 px-4 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-40">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Quitar foto</button>}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function AvatarComparison({ label, url, initials, highlight = false }: { label: string; url: string; initials: string; highlight?: boolean }) {
  return (
    <div className={`rounded-2xl border p-4 text-center ${highlight ? 'border-emerald-300 bg-emerald-50/70' : 'border-slate-200 bg-slate-50'}`}>
      <p className="mb-3 text-xs font-semibold text-slate-600">{label}</p>
      {url ? <img src={url} alt={label} className="mx-auto aspect-square w-full max-w-44 rounded-full object-cover shadow-sm ring-2 ring-white" /> : <div className="mx-auto flex aspect-square w-full max-w-44 items-center justify-center rounded-full bg-white text-2xl font-bold text-slate-400 ring-1 ring-slate-200">{initials}</div>}
    </div>
  )
}

function EditorSlider({ label, value, min, max, step, suffix = '', icon, onChangeStart, onChange }: { label: string; value: number; min: number; max: number; step: number; suffix?: string; icon?: React.ReactNode; onChangeStart: () => void; onChange: (value: number) => void }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center justify-between text-xs font-medium text-slate-600"><span className="flex items-center gap-1.5">{icon}{label}</span><span className="tabular-nums text-slate-400">{Math.round(value * 100) / 100}{suffix}</span></span>
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onPointerDown={onChangeStart}
        onKeyDown={event => {
          if (!event.repeat && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) onChangeStart()
        }}
        onChange={event => onChange(Number(event.target.value))}
        className="h-2 w-full cursor-pointer accent-emerald-600"
      />
    </label>
  )
}

function EditorButton({ label, disabled = false, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" disabled={disabled} onClick={onClick} className="flex min-h-11 flex-col items-center justify-center gap-1 rounded-xl border border-slate-200 bg-white px-2 text-[10px] font-medium text-slate-600 hover:border-emerald-300 hover:bg-emerald-50 disabled:opacity-35">{children}{label}</button>
}
