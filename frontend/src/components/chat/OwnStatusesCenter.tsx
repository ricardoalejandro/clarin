'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle, Eye, Image as ImageIcon, Loader2,
  Maximize2, Minimize2, Play, Plus, RefreshCcw, Send, Smartphone,
  Sparkles, Trash2, Type, Upload, Video, X,
} from 'lucide-react'
import { subscribeWebSocket } from '@/lib/api'
import { useAccessibleDialog } from '@/components/pipelines/useAccessibleDialog'
import type { Device } from '@/types/chat'
import StatusMediaEditor, { type StatusMediaEditResult, type StatusVideoEdits } from './StatusMediaEditor'

type StatusKind = 'text' | 'image' | 'video'
type StatusState = 'pending' | 'sent' | 'failed' | 'expired'
type ImageMode = 'fit' | 'fill'

interface OwnStatus {
  id: string
  device_id: string
  source: 'clarin' | 'device'
  kind: StatusKind
  text?: string
  caption?: string
  background_argb?: number
  font_style?: number
  media_url?: string
  media_mimetype?: string
  status: StatusState
  error_message?: string
  privacy?: string
  sent_at?: string
  expires_at: string
  created_at: string
  view_count?: number
}

interface StatusViewer {
  id: string
  status_id: string
  viewer_jid: string
  viewer_name?: string
  viewer_phone?: string
  viewer_avatar?: string
  receipt_type: 'read' | 'played'
  viewed_at: string
}

interface OwnStatusesCenterProps {
  open: boolean
  devices: Device[]
  filteredDeviceIds: string[]
  onClose: () => void
}

const backgrounds = [
  { name: 'Esmeralda', value: 0xff047857, css: '#047857' },
  { name: 'Azul', value: 0xff1d4ed8, css: '#1d4ed8' },
  { name: 'Violeta', value: 0xff7c3aed, css: '#7c3aed' },
  { name: 'Coral', value: 0xffbe123c, css: '#be123c' },
  { name: 'Noche', value: 0xff0f172a, css: '#0f172a' },
]

const privacyLabel: Record<string, string> = {
  contacts: 'Mis contactos',
  blacklist: 'Mis contactos, excepto…',
  whitelist: 'Compartir solo con…',
}

const maxStatusTextLength = 700

const statusStateLabel: Record<StatusState, string> = {
  pending: 'Enviando',
  sent: 'Publicado',
  failed: 'Fallido',
  expired: 'Expirado',
}

const statusTime = (value?: string) => {
  if (!value) return 'Pendiente'
  return new Intl.DateTimeFormat('es-PE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function effectiveStatusState(status: OwnStatus, now: number): StatusState {
  return status.status === 'expired' || new Date(status.expires_at).getTime() <= now ? 'expired' : status.status
}

function statusProgress(status: OwnStatus, now: number): number {
  const start = new Date(status.sent_at || status.created_at).getTime()
  const end = new Date(status.expires_at).getTime()
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0
  return Math.min(100, Math.max(0, ((now - start) / (end - start)) * 100))
}

function statusExpiryLabel(status: OwnStatus, now: number): string {
  const state = effectiveStatusState(status, now)
  if (state === 'expired') return 'Expirado'
  const remainingMinutes = Math.max(1, Math.ceil((new Date(status.expires_at).getTime() - now) / 60_000))
  if (remainingMinutes >= 60) return `Expira en ${Math.ceil(remainingMinutes / 60)} h`
  return `Expira en ${remainingMinutes} min`
}

async function cropImageForStatus(file: File): Promise<File> {
  if (typeof createImageBitmap !== 'function') throw new Error('El recorte no está disponible en este navegador. Usa el modo Ajustar.')
  const bitmap = await createImageBitmap(file)
  try {
    const targetRatio = 9 / 16
    const sourceRatio = bitmap.width / bitmap.height
    const cropWidth = sourceRatio > targetRatio ? bitmap.height * targetRatio : bitmap.width
    const cropHeight = sourceRatio > targetRatio ? bitmap.height : bitmap.width / targetRatio
    const sourceX = (bitmap.width - cropWidth) / 2
    const sourceY = (bitmap.height - cropHeight) / 2
    const scale = Math.min(1, 1080 / cropWidth, 1920 / cropHeight)
    const outputWidth = Math.max(1, Math.round(cropWidth * scale))
    const outputHeight = Math.max(1, Math.round(cropHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = outputWidth
    canvas.height = outputHeight
    const context = canvas.getContext('2d')
    if (!context) throw new Error('No se pudo preparar el recorte de la imagen.')
    context.drawImage(bitmap, sourceX, sourceY, cropWidth, cropHeight, 0, 0, outputWidth, outputHeight)
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', 0.92))
    if (!blob) throw new Error('No se pudo preparar el recorte de la imagen.')
    const baseName = file.name.replace(/\.[^.]+$/, '') || 'estado'
    return new File([blob], `${baseName}-9x16.webp`, { type: 'image/webp', lastModified: Date.now() })
  } finally {
    bitmap.close()
  }
}

export default function OwnStatusesCenter({ open, devices, filteredDeviceIds, onClose }: OwnStatusesCenterProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const viewersDialogRef = useRef<HTMLElement>(null)
  const viewersCloseButtonRef = useRef<HTMLButtonElement>(null)
  const deleteDialogRef = useRef<HTMLElement>(null)
  const deleteCancelButtonRef = useRef<HTMLButtonElement>(null)
  const requestRef = useRef<AbortController | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const wasOpenRef = useRef(false)
  const selectedDeviceIdRef = useRef('')
  const previousDeviceIdRef = useRef('')
  const publishingRef = useRef(false)
  const retryingRef = useRef(false)
  const deletingRef = useRef(false)
  const [maximized, setMaximized] = useState(false)
  const [selectedDeviceId, setSelectedDeviceId] = useState('')
  const [statuses, setStatuses] = useState<OwnStatus[]>([])
  const [selectedStatusId, setSelectedStatusId] = useState('')
  const [privacy, setPrivacy] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [kind, setKind] = useState<StatusKind>('text')
  const [text, setText] = useState('')
  const [caption, setCaption] = useState('')
  const [background, setBackground] = useState(backgrounds[0])
  const [fontStyle, setFontStyle] = useState(0)
  const [media, setMedia] = useState<File | null>(null)
  const [mediaOverlay, setMediaOverlay] = useState<File | null>(null)
  const [videoEdits, setVideoEdits] = useState<StatusVideoEdits | null>(null)
  const [mediaLink, setMediaLink] = useState('')
  const [mediaEditorOpen, setMediaEditorOpen] = useState(false)
  const [imageMode, setImageMode] = useState<ImageMode>('fit')
  const [previewURL, setPreviewURL] = useState('')
  const [composerError, setComposerError] = useState('')
  const [publishing, setPublishing] = useState(false)
  const [retryingStatusId, setRetryingStatusId] = useState('')
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'warning' | 'error'; message: string } | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [readReceiptsEnabled, setReadReceiptsEnabled] = useState<boolean | null>(null)
  const [viewersOpen, setViewersOpen] = useState(false)
  const [viewers, setViewers] = useState<StatusViewer[]>([])
  const [viewersLoading, setViewersLoading] = useState(false)
  const [viewersError, setViewersError] = useState('')
  const [deleteCandidate, setDeleteCandidate] = useState<OwnStatus | null>(null)
  const [deletingStatusId, setDeletingStatusId] = useState('')

  selectedDeviceIdRef.current = selectedDeviceId
  publishingRef.current = publishing

  const requestClose = useCallback(() => {
    if (!publishingRef.current && !retryingRef.current && !deletingRef.current) onClose()
  }, [onClose])
  const closeViewers = useCallback(() => setViewersOpen(false), [])
  const closeDeleteDialog = useCallback(() => {
    if (!deletingStatusId) setDeleteCandidate(null)
  }, [deletingStatusId])
  const nestedDialogOpen = mediaEditorOpen || viewersOpen || Boolean(deleteCandidate)
  const actionBusy = publishing || Boolean(retryingStatusId) || Boolean(deletingStatusId)
  useAccessibleDialog(open && !nestedDialogOpen, dialogRef, requestClose, closeButtonRef)
  useAccessibleDialog(viewersOpen, viewersDialogRef, closeViewers, viewersCloseButtonRef)
  useAccessibleDialog(Boolean(deleteCandidate), deleteDialogRef, closeDeleteDialog, deleteCancelButtonRef)

  const compatibleDevices = useMemo(() => devices.filter(device => {
    const web = !device.provider || device.provider === 'whatsapp_web'
    return web && device.status === 'connected' && Boolean(device.runtime_capabilities?.can_publish_status)
  }), [devices])

  const selectedDevice = compatibleDevices.find(device => device.id === selectedDeviceId)
  const canSyncOwnStatus = selectedDevice?.runtime_capabilities?.can_sync_own_status === true
  const centerTitle = canSyncOwnStatus ? 'Mis estados' : 'Publicados desde Clarin'
  const selectedStatus = statuses.find(status => status.id === selectedStatusId) || statuses[0]

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false
      requestRef.current?.abort()
      return
    }
    const opening = !wasOpenRef.current
    wasOpenRef.current = true
    const filteredCompatible = compatibleDevices.filter(device => filteredDeviceIds.includes(device.id))
    const preferredId = filteredCompatible.length === 1 ? filteredCompatible[0].id : ''
    setSelectedDeviceId(current => {
      if (opening) return preferredId
      if (compatibleDevices.some(device => device.id === current)) return current
      return preferredId
    })
    if (opening) {
      setStatuses([])
      setSelectedStatusId('')
      setPrivacy('')
      setLoadError('')
      setFeedback(null)
      setKind('text')
      setText('')
      setCaption('')
      setBackground(backgrounds[0])
      setFontStyle(0)
      setMedia(null)
      setMediaOverlay(null)
      setVideoEdits(null)
      setMediaLink('')
      setMediaEditorOpen(false)
      setReadReceiptsEnabled(null)
      setViewersOpen(false)
      setViewers([])
      setDeleteCandidate(null)
      setComposerError('')
      setImageMode('fit')
    }
  }, [open, compatibleDevices, filteredDeviceIds])

  useEffect(() => {
    if (!open) return
    setNow(Date.now())
    const interval = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(interval)
  }, [open])

  useEffect(() => {
    if (previousDeviceIdRef.current === selectedDeviceId) return
    previousDeviceIdRef.current = selectedDeviceId
    requestRef.current?.abort()
    setStatuses([])
    setSelectedStatusId('')
    setPrivacy('')
    setLoadError('')
    setRetryingStatusId('')
    setFeedback(null)
    setKind('text')
    setText('')
    setCaption('')
    setBackground(backgrounds[0])
    setFontStyle(0)
    setMedia(null)
    setMediaOverlay(null)
    setVideoEdits(null)
    setMediaLink('')
    setMediaEditorOpen(false)
    setReadReceiptsEnabled(null)
    setViewersOpen(false)
    setViewers([])
    setDeleteCandidate(null)
    setComposerError('')
    setImageMode('fit')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [selectedDeviceId])

  useEffect(() => {
    if (!media) {
      setPreviewURL('')
      return
    }
    const url = URL.createObjectURL(media)
    setPreviewURL(url)
    return () => URL.revokeObjectURL(url)
  }, [media])

  const fetchStatuses = useCallback(async () => {
    if (!open || !selectedDeviceId) {
      setStatuses([])
      setSelectedStatusId('')
      setPrivacy('')
      setLoading(false)
      return
    }
    const targetDeviceId = selectedDeviceId
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    setLoading(true)
    setLoadError('')
    try {
      const token = localStorage.getItem('token')
      const response = await fetch(`/api/whatsapp/statuses?device_id=${encodeURIComponent(targetDeviceId)}`, {
        headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.success) throw new Error(data.error || 'No se pudieron cargar tus estados')
      if (controller.signal.aborted || selectedDeviceIdRef.current !== targetDeviceId) return
      const returned = Array.isArray(data.statuses) ? data.statuses as OwnStatus[] : []
      const next = canSyncOwnStatus ? returned : returned.filter(status => status.source === 'clarin')
      setStatuses(next)
      setPrivacy(data.privacy || '')
      setReadReceiptsEnabled(data.read_receipts_known ? Boolean(data.read_receipts_enabled) : null)
      setSelectedStatusId(current => next.some(item => item.id === current) ? current : next[0]?.id || '')
    } catch (error) {
      if ((error as Error).name !== 'AbortError' && selectedDeviceIdRef.current === targetDeviceId) setLoadError((error as Error).message)
    } finally {
      if (!controller.signal.aborted && selectedDeviceIdRef.current === targetDeviceId) setLoading(false)
    }
  }, [canSyncOwnStatus, open, selectedDeviceId])

  useEffect(() => {
    void fetchStatuses()
    return () => requestRef.current?.abort()
  }, [fetchStatuses])

  useEffect(() => {
    if (!open) return
    return subscribeWebSocket((raw: unknown) => {
      const message = raw as { event?: string; data?: { device_id?: string; action?: string; status?: OwnStatus; status_id?: string; viewer?: StatusViewer; view_count?: number } }
      if (message.event !== 'whatsapp_status' || message.data?.device_id !== selectedDeviceId) return
      const removedStatusId = message.data.status_id || message.data.status?.id
      if ((message.data.action === 'expired' || message.data.action === 'deleted') && removedStatusId) {
        const statusId = removedStatusId
        setStatuses(current => current.filter(item => item.id !== statusId))
        setSelectedStatusId(current => current === statusId ? '' : current)
        if (selectedStatusId === statusId) setViewersOpen(false)
        return
      }
      if (message.data.action === 'viewer_added' && message.data.status_id) {
        const statusId = message.data.status_id
        setStatuses(current => current.map(item => item.id === statusId ? { ...item, view_count: message.data?.view_count ?? (item.view_count || 0) + 1 } : item))
        if (viewersOpen && selectedStatusId === statusId && message.data.viewer) {
          const viewer = message.data.viewer
          setViewers(current => [viewer, ...current.filter(item => item.id !== viewer.id)])
        }
        return
      }
      const incoming = message.data.status
      if (!incoming?.id) {
        void fetchStatuses()
        return
      }
      if (!canSyncOwnStatus && incoming.source !== 'clarin') return
      if (message.data.action === 'expired' || message.data.action === 'deleted' || effectiveStatusState(incoming, Date.now()) === 'expired') {
        setStatuses(current => current.filter(item => item.id !== incoming.id))
        setSelectedStatusId(current => current === incoming.id ? '' : current)
        return
      }
      setStatuses(current => [incoming, ...current.filter(item => item.id !== incoming.id)])
      setSelectedStatusId(current => current || incoming.id)
    })
  }, [canSyncOwnStatus, open, selectedDeviceId, fetchStatuses, selectedStatusId, viewersOpen])

  const fetchViewers = useCallback(async (status: OwnStatus) => {
    setViewersOpen(true)
    setViewersLoading(true)
    setViewersError('')
    try {
      const token = localStorage.getItem('token')
      const response = await fetch(`/api/whatsapp/statuses/${status.id}/viewers?page=1&limit=100`, { headers: { Authorization: `Bearer ${token}` } })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.success) throw new Error(data.error || 'No se pudieron cargar las visualizaciones.')
      setViewers(Array.isArray(data.viewers) ? data.viewers : [])
      if (data.read_receipts_known) setReadReceiptsEnabled(Boolean(data.read_receipts_enabled))
      setStatuses(current => current.map(item => item.id === status.id ? { ...item, view_count: Number(data.pagination?.total || 0) } : item))
    } catch (error) {
      setViewersError(error instanceof Error ? error.message : 'No se pudieron cargar las visualizaciones.')
    } finally {
      setViewersLoading(false)
    }
  }, [])

  const deleteStatus = async () => {
    const status = deleteCandidate
    if (!status || deletingRef.current || retryingRef.current || publishingRef.current) return
    deletingRef.current = true
    setDeletingStatusId(status.id)
    setFeedback(null)
    try {
      const token = localStorage.getItem('token')
      const response = await fetch(`/api/whatsapp/statuses/${status.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.success) throw new Error(data.error || 'No se pudo eliminar el estado.')
      setStatuses(current => current.filter(item => item.id !== status.id))
      setSelectedStatusId(current => current === status.id ? '' : current)
      setDeleteCandidate(null)
      setViewersOpen(false)
      setFeedback({ tone: 'success', message: data.remote_deleted ? 'Estado eliminado de WhatsApp y Clarin.' : 'Publicación eliminada de Clarin.' })
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : 'No se pudo eliminar el estado.' })
      setDeleteCandidate(null)
    } finally {
      deletingRef.current = false
      setDeletingStatusId('')
    }
  }

  const resetComposer = () => {
    setText('')
    setCaption('')
    setMedia(null)
    setMediaOverlay(null)
    setVideoEdits(null)
    setMediaLink('')
    setMediaEditorOpen(false)
    setImageMode('fit')
    setComposerError('')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleDeviceChange = (deviceId: string) => {
    if (deviceId === selectedDeviceId || publishingRef.current) return
    requestRef.current?.abort()
    setSelectedDeviceId(deviceId)
    setStatuses([])
    setSelectedStatusId('')
    setPrivacy('')
    setLoading(false)
    setLoadError('')
    setRetryingStatusId('')
    setFeedback(null)
    resetComposer()
  }

  const changeKind = (nextKind: StatusKind) => {
    if (publishingRef.current || nextKind === kind) return
    setKind(nextKind)
    setComposerError('')
    setFeedback(null)
    if (nextKind === 'text') setCaption('')
    else setText('')
    setMedia(null)
    setMediaOverlay(null)
    setVideoEdits(null)
    setMediaLink('')
    setMediaEditorOpen(false)
    setImageMode('fit')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const chooseMedia = (file?: File) => {
    setComposerError('')
    if (!file) return
    setMedia(null)
    setMediaOverlay(null)
    setVideoEdits(null)
    setMediaLink('')
    const image = ['image/jpeg', 'image/png', 'image/webp'].includes(file.type)
    const video = file.type === 'video/mp4'
    if (!image && !video) {
      setComposerError('Usa JPG, PNG, WebP estático o MP4.')
      if (fileInputRef.current) fileInputRef.current.value = ''
      return
    }
    const limit = image ? 16 * 1024 * 1024 : 30 * 1024 * 1024
    if (file.size > limit) {
      setComposerError(image ? 'La imagen supera 16 MB.' : 'El video supera 30 MB.')
      if (fileInputRef.current) fileInputRef.current.value = ''
      return
    }
    setKind(image ? 'image' : 'video')
    setImageMode('fit')
    setMedia(file)
  }

  const applyMediaEdit = (result: StatusMediaEditResult) => {
    setMedia(result.media)
    setMediaOverlay(result.overlay || null)
    setVideoEdits(result.videoEdits || null)
    setMediaLink(result.linkUrl || '')
    setImageMode('fit')
    setMediaEditorOpen(false)
    setFeedback({ tone: 'success', message: 'Diseño aplicado. Revisa la vista previa antes de publicar.' })
  }

  const publish = async () => {
    if (!selectedDeviceId || publishingRef.current || retryingRef.current || deletingRef.current) return
    if (kind === 'text' && !text.trim()) {
      setComposerError('Escribe el contenido del estado.')
      return
    }
    if (kind !== 'text' && !media) {
      setComposerError('Selecciona un archivo para publicar.')
      return
    }
    const captionWithLink = mediaLink && !caption.includes(mediaLink)
      ? `${caption.trim()}${caption.trim() ? '\n' : ''}${mediaLink}`
      : caption.trim()
    if (Array.from(captionWithLink).length > maxStatusTextLength) {
      setComposerError('El texto y el enlace juntos superan el límite de 700 caracteres.')
      return
    }
    const targetDeviceId = selectedDeviceId
    publishingRef.current = true
    setPublishing(true)
    setComposerError('')
    setFeedback(null)
    try {
      let uploadMedia = media
      if (kind === 'image' && media && imageMode === 'fill') uploadMedia = await cropImageForStatus(media)
      if (selectedDeviceIdRef.current !== targetDeviceId) return
      const form = new FormData()
      form.append('device_id', targetDeviceId)
      form.append('kind', kind)
      form.append('text', text.trim())
      form.append('caption', captionWithLink)
      form.append('background_argb', String(background.value))
      form.append('font_style', String(fontStyle))
      if (uploadMedia) form.append('media', uploadMedia, uploadMedia.name)
      if (mediaOverlay) form.append('overlay', mediaOverlay, mediaOverlay.name)
      if (videoEdits) form.append('edit_manifest', JSON.stringify(videoEdits))
      const token = localStorage.getItem('token')
      const response = await fetch('/api/whatsapp/statuses', {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
      })
      const data = await response.json().catch(() => ({}))
      if (selectedDeviceIdRef.current !== targetDeviceId) return
      if (data.status?.id) {
        setStatuses(current => [data.status as OwnStatus, ...current.filter(item => item.id !== data.status.id)])
        setSelectedStatusId(data.status.id)
      }
      if (!response.ok || !data.success) throw new Error(data.error || 'No se pudo publicar el estado')
      resetComposer()
      setFeedback({ tone: data.warning ? 'warning' : 'success', message: data.warning || 'Estado publicado correctamente.' })
      if (!data.warning) await fetchStatuses()
      if (selectedDeviceIdRef.current === targetDeviceId) setSelectedStatusId(data.status?.id || '')
    } catch (error) {
      if (selectedDeviceIdRef.current === targetDeviceId) {
        setComposerError((error as Error).message)
        await fetchStatuses()
      }
    } finally {
      publishingRef.current = false
      setPublishing(false)
    }
  }

  const retry = async (status: OwnStatus) => {
    if (status.status !== 'failed' || retryingRef.current || publishingRef.current || deletingRef.current) return
    retryingRef.current = true
    const targetDeviceId = status.device_id
    setRetryingStatusId(status.id)
    setFeedback(null)
    setStatuses(current => current.map(item => item.id === status.id ? { ...item, status: 'pending', error_message: undefined } : item))
    try {
      const token = localStorage.getItem('token')
      const response = await fetch(`/api/whatsapp/statuses/${status.id}/retry`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      })
      const data = await response.json().catch(() => ({}))
      if (selectedDeviceIdRef.current !== targetDeviceId) return
      if (!response.ok || !data.success) throw new Error(data.error || 'No se pudo reintentar')
      if (data.status?.id) setStatuses(current => current.map(item => item.id === status.id ? data.status as OwnStatus : item))
      setFeedback({ tone: data.warning ? 'warning' : 'success', message: data.warning || 'Estado publicado correctamente.' })
      if (!data.warning) await fetchStatuses()
    } catch (error) {
      if (selectedDeviceIdRef.current !== targetDeviceId) return
      const message = error instanceof Error ? error.message : 'No se pudo reintentar'
      setStatuses(current => current.map(item => item.id === status.id ? { ...item, status: 'failed', error_message: message } : item))
      setFeedback({ tone: 'error', message })
      await fetchStatuses()
    } finally {
      retryingRef.current = false
      setRetryingStatusId('')
    }
  }

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/55 p-0 backdrop-blur-sm sm:p-5" onMouseDown={event => { if (event.target === event.currentTarget) requestClose() }}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="own-statuses-title"
        className={`${maximized ? 'h-[100dvh] w-screen rounded-none' : 'h-[100dvh] w-screen sm:h-[min(820px,92dvh)] sm:w-[min(1120px,94vw)] sm:rounded-3xl'} flex min-h-0 flex-col overflow-hidden border border-white/60 bg-slate-50 shadow-2xl transition-[width,height,border-radius]`}
      >
        <header className="flex min-h-16 items-center gap-3 border-b border-slate-200 bg-white px-4 sm:px-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700"><Sparkles className="h-5 w-5" /></div>
          <div className="min-w-0 flex-1">
            <h2 id="own-statuses-title" className="truncate text-base font-bold text-slate-900">{centerTitle}</h2>
            <p className="truncate text-xs text-slate-500">{canSyncOwnStatus ? 'Publica y revisa únicamente los estados propios del dispositivo.' : 'Publica y revisa los estados creados desde Clarin.'}</p>
          </div>
          <button type="button" onClick={() => setMaximized(value => !value)} className="hidden h-10 w-10 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 sm:flex" aria-label={maximized ? 'Restaurar ventana' : 'Maximizar ventana'}>
            {maximized ? <Minimize2 className="h-5 w-5" /> : <Maximize2 className="h-5 w-5" />}
          </button>
          <button ref={closeButtonRef} type="button" onClick={requestClose} disabled={publishing} className="flex h-10 w-10 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:cursor-not-allowed disabled:opacity-40" aria-label={publishing ? 'Espera a que termine la publicación' : 'Cerrar Mis estados'}><X className="h-5 w-5" /></button>
        </header>

        {compatibleDevices.length === 0 ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <div className="max-w-md rounded-3xl border border-dashed border-slate-300 bg-white p-8 text-center shadow-sm">
              <Smartphone className="mx-auto mb-4 h-10 w-10 text-slate-400" />
              <h3 className="font-bold text-slate-900">Estados pendientes de habilitación</h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">Se necesita un dispositivo WhatsApp Web conectado y una validación real del protocolo antes de publicar.</p>
            </div>
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)]">
            <aside className="min-h-0 border-b border-slate-200 bg-white lg:border-b-0 lg:border-r">
              <div className="border-b border-slate-100 p-4">
                <label className="text-xs font-bold uppercase tracking-wide text-slate-500" htmlFor="status-device">Dispositivo</label>
                <select id="status-device" value={selectedDeviceId} onChange={event => handleDeviceChange(event.target.value)} disabled={publishing} className="mt-2 h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 disabled:bg-slate-100 disabled:text-slate-400">
                  <option value="">Selecciona un dispositivo</option>
                  {compatibleDevices.map(device => <option key={device.id} value={device.id}>{device.name}{device.phone ? ` · ${device.phone}` : ''}</option>)}
                </select>
                {selectedDevice ? (
                  <div className="mt-3 rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-800">Privacidad: <strong>{privacyLabel[privacy] || 'Configurada en WhatsApp'}</strong></div>
                ) : (
                  <div className="mt-3 rounded-xl bg-slate-100 px-3 py-2 text-xs leading-relaxed text-slate-600">Elige un único dispositivo para evitar publicar desde la conexión equivocada.</div>
                )}
              </div>
              <div className="flex items-center justify-between px-4 pb-2 pt-4">
                <div>
                  <p className="text-sm font-bold text-slate-900">{canSyncOwnStatus ? 'Publicados' : 'Publicados desde Clarin'}</p>
                  <p className="text-xs text-slate-500">Se eliminan tras 24 horas</p>
                </div>
                <button type="button" onClick={() => void fetchStatuses()} disabled={!selectedDeviceId || loading} className="flex h-9 w-9 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40" aria-label="Actualizar estados"><RefreshCcw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></button>
              </div>
              <div className="max-h-64 space-y-2 overflow-y-auto px-3 pb-3 lg:max-h-none lg:h-[calc(100%-190px)]">
                {loading && statuses.length === 0 && <div className="flex items-center justify-center gap-2 py-8 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Cargando</div>}
                {loadError && <button type="button" onClick={() => void fetchStatuses()} className="w-full rounded-2xl border border-rose-200 bg-rose-50 p-3 text-left text-xs text-rose-700">{loadError}<span className="mt-1 block font-bold">Reintentar</span></button>}
                {!loading && !loadError && statuses.length === 0 && <div className="rounded-2xl border border-dashed border-slate-200 p-4 text-center text-xs leading-5 text-slate-500">Aún no has publicado estados desde Clarin.</div>}
                {statuses.map(status => {
                  const active = selectedStatus?.id === status.id
                  const visualState = effectiveStatusState(status, now)
                  return <button key={status.id} type="button" onClick={() => setSelectedStatusId(status.id)} className={`flex w-full items-center gap-3 rounded-2xl border p-2.5 text-left transition ${active ? 'border-emerald-300 bg-emerald-50 shadow-sm' : 'border-slate-200 bg-white hover:border-slate-300'}`}>
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-slate-100">
                      {status.kind === 'image' && status.media_url ? <img src={status.media_url} alt="" className="h-full w-full object-cover" /> : status.kind === 'video' ? <Video className="h-5 w-5 text-slate-500" /> : <Type className="h-5 w-5 text-slate-500" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-slate-800">{status.text || status.caption || (status.kind === 'image' ? 'Imagen' : 'Video')}</p>
                      <p className="mt-0.5 truncate text-[11px] text-slate-500">{statusTime(status.sent_at || status.created_at)} · {statusExpiryLabel(status, now)}</p>
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-1 text-[9px] font-bold ${visualState === 'failed' ? 'bg-rose-100 text-rose-700' : visualState === 'sent' ? 'bg-emerald-100 text-emerald-700' : visualState === 'expired' ? 'bg-slate-200 text-slate-600' : 'bg-amber-100 text-amber-700'}`}>{statusStateLabel[visualState]}</span>
                  </button>
                })}
              </div>
            </aside>

            {!selectedDevice ? (
              <main className="flex min-h-[320px] items-center justify-center p-6">
                <div className="max-w-sm text-center">
                  <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-200 text-slate-600"><Smartphone className="h-6 w-6" /></div>
                  <h3 className="mt-4 text-base font-bold text-slate-900">Elige desde qué dispositivo publicar</h3>
                  <p className="mt-2 text-sm leading-relaxed text-slate-600">La selección es intencional cuando hay más de una conexión compatible. Ningún estado se enviará hasta que elijas una.</p>
                </div>
              </main>
            ) : (
            <main className="min-h-0 overflow-y-auto p-4 sm:p-6">
              <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
                <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
                  <div className="flex min-h-[360px] items-center justify-center bg-slate-950 p-5 sm:min-h-[480px]">
                    {selectedStatus ? (
                      <div className="relative flex aspect-[9/16] max-h-[520px] w-full max-w-[292px] items-center justify-center overflow-hidden rounded-3xl shadow-2xl" style={{ backgroundColor: selectedStatus.kind === 'text' ? `#${(selectedStatus.background_argb ?? backgrounds[0].value).toString(16).slice(-6)}` : '#020617' }}>
                        <div className="absolute inset-x-3 top-3 z-10 h-1 overflow-hidden rounded-full bg-white/30" aria-hidden="true"><div className="h-full rounded-full bg-white transition-[width] duration-500" style={{ width: `${statusProgress(selectedStatus, now)}%` }} /></div>
                        <span className={`absolute right-3 top-6 z-10 rounded-full px-2 py-1 text-[10px] font-bold shadow-sm ${effectiveStatusState(selectedStatus, now) === 'failed' ? 'bg-rose-600 text-white' : effectiveStatusState(selectedStatus, now) === 'sent' ? 'bg-emerald-600 text-white' : effectiveStatusState(selectedStatus, now) === 'expired' ? 'bg-slate-600 text-white' : 'bg-amber-400 text-slate-950'}`}>{statusStateLabel[effectiveStatusState(selectedStatus, now)]}</span>
                        {selectedStatus.kind === 'text' && <p className="whitespace-pre-wrap px-6 text-center text-2xl font-bold leading-relaxed text-white">{selectedStatus.text}</p>}
                        {selectedStatus.kind === 'image' && selectedStatus.media_url && <img src={selectedStatus.media_url} alt="Estado propio" className="h-full w-full object-contain" />}
                        {selectedStatus.kind === 'video' && selectedStatus.media_url && <video src={selectedStatus.media_url} controls playsInline className="h-full w-full object-contain" />}
                        {selectedStatus.caption && selectedStatus.kind !== 'text' && <div className="absolute inset-x-3 bottom-3 rounded-2xl bg-slate-950/65 px-4 py-3 text-center text-sm text-white backdrop-blur">{selectedStatus.caption}</div>}
                      </div>
                    ) : <div className="text-center text-slate-400"><Play className="mx-auto mb-3 h-10 w-10" /><p className="text-sm">Selecciona o publica un estado</p></div>}
                  </div>
                  {selectedStatus && <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 bg-white px-4 py-3 text-xs text-slate-600">
                    <span className="mr-auto">{effectiveStatusState(selectedStatus, now) === 'sent' ? 'Publicado' : 'Creado'}: <strong>{statusTime(selectedStatus.sent_at || selectedStatus.created_at)}</strong> · {statusExpiryLabel(selectedStatus, now)}</span>
                    <button type="button" onClick={() => void fetchViewers(selectedStatus)} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-slate-200 px-3 font-bold text-slate-700 hover:bg-slate-50"><Eye className="h-4 w-4 text-emerald-600" />{selectedStatus.view_count || 0} visualizaciones</button>
                    <button type="button" onClick={() => setDeleteCandidate(selectedStatus)} disabled={actionBusy || selectedStatus.status === 'pending'} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-rose-200 px-3 font-bold text-rose-600 hover:bg-rose-50 disabled:opacity-40"><Trash2 className="h-4 w-4" />Eliminar</button>
                  </div>}
                  {selectedStatus && effectiveStatusState(selectedStatus, now) === 'failed' && <div className="flex items-center justify-between gap-3 border-t border-rose-100 bg-rose-50 p-4 text-sm text-rose-700"><span>{selectedStatus.error_message || 'La publicación falló.'}</span><button type="button" onClick={() => void retry(selectedStatus)} disabled={actionBusy} className="inline-flex min-h-10 shrink-0 items-center gap-2 rounded-xl bg-rose-600 px-3 py-2 font-bold text-white disabled:opacity-50">{retryingStatusId === selectedStatus.id && <Loader2 className="h-4 w-4 animate-spin" />}{retryingStatusId === selectedStatus.id ? 'Reintentando…' : 'Reintentar'}</button></div>}
                </section>

                <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
                  <div className="flex items-center gap-2"><Plus className="h-5 w-5 text-emerald-600" /><h3 className="font-bold text-slate-900">Nuevo estado</h3></div>
                  <div className="mt-4 grid grid-cols-3 gap-2">
                    {(['text', 'image', 'video'] as StatusKind[]).map(option => <button key={option} type="button" onClick={() => changeKind(option)} disabled={publishing} className={`flex h-11 items-center justify-center gap-1.5 rounded-xl border text-xs font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-50 ${kind === option ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>{option === 'text' ? <Type className="h-4 w-4" /> : option === 'image' ? <ImageIcon className="h-4 w-4" /> : <Video className="h-4 w-4" />}{option === 'text' ? 'Texto' : option === 'image' ? 'Imagen' : 'Video'}</button>)}
                  </div>
                  {kind === 'text' ? <>
                    <div className="mt-4 flex aspect-[9/11] items-center justify-center rounded-2xl p-5" style={{ backgroundColor: background.css }}><p className="whitespace-pre-wrap text-center text-xl font-bold text-white">{text || 'Escribe algo memorable'}</p></div>
                    <textarea value={text} maxLength={maxStatusTextLength} onChange={event => setText(event.target.value)} disabled={publishing} rows={4} placeholder="Escribe tu estado…" className="mt-3 w-full resize-none rounded-2xl border border-slate-200 p-3 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 disabled:bg-slate-100" />
                    <div className="mt-2 flex items-center justify-between"><div className="flex gap-1.5">{backgrounds.map(item => <button key={item.name} type="button" onClick={() => setBackground(item)} disabled={publishing} className={`h-7 w-7 rounded-full border-2 disabled:opacity-50 ${background.value === item.value ? 'border-slate-900' : 'border-white shadow'}`} style={{ backgroundColor: item.css }} aria-label={`Fondo ${item.name}`} />)}</div><select value={fontStyle} onChange={event => setFontStyle(Number(event.target.value))} disabled={publishing} className="h-9 rounded-xl border border-slate-200 px-2 text-xs disabled:bg-slate-100"><option value={0}>Clásica</option><option value={6}>Negrita</option><option value={10}>Máquina</option></select></div>
                  </> : <>
                    <input ref={fileInputRef} type="file" className="hidden" disabled={publishing} accept={kind === 'image' ? 'image/jpeg,image/png,image/webp' : 'video/mp4'} onChange={event => chooseMedia(event.target.files?.[0])} />
                    <button type="button" onClick={() => fileInputRef.current?.click()} disabled={publishing} className="mt-4 flex aspect-[9/11] w-full items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50 text-slate-500 hover:border-emerald-400 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-60">
                      {previewURL ? kind === 'image' ? <img src={previewURL} alt="Vista previa" className={`h-full w-full ${imageMode === 'fill' ? 'object-cover' : 'object-contain'}`} /> : <video src={previewURL} controls className="h-full w-full object-contain" /> : <span className="flex flex-col items-center gap-2 text-sm font-semibold"><Upload className="h-7 w-7" />Seleccionar {kind === 'image' ? 'imagen' : 'video'}</span>}
                    </button>
                    {media && <button type="button" onClick={() => setMediaEditorOpen(true)} disabled={publishing} className="mt-2 flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 text-xs font-bold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"><Sparkles className="h-4 w-4" />Editar texto, emojis, giro y enlace</button>}
                    {(mediaOverlay || videoEdits || mediaLink) && <p className="mt-2 rounded-xl bg-violet-50 px-3 py-2 text-[11px] font-semibold leading-4 text-violet-700">Diseño avanzado aplicado{mediaLink ? ' · enlace incluido' : ''}{videoEdits ? ` · video ${videoEdits.mute ? 'sin audio' : 'con audio'}` : ''}.</p>}
                    {kind === 'image' && media && <div className="mt-2 grid grid-cols-2 gap-2 rounded-xl bg-slate-100 p-1" role="group" aria-label="Ajuste de imagen"><button type="button" onClick={() => setImageMode('fit')} disabled={publishing} className={`min-h-9 rounded-lg px-3 text-xs font-bold ${imageMode === 'fit' ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-600'}`}>Ajustar completa</button><button type="button" onClick={() => setImageMode('fill')} disabled={publishing} className={`min-h-9 rounded-lg px-3 text-xs font-bold ${imageMode === 'fill' ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-600'}`}>Llenar y recortar</button></div>}
                    <textarea value={caption} maxLength={maxStatusTextLength} onChange={event => setCaption(event.target.value)} disabled={publishing} rows={3} placeholder="Añade un texto opcional…" className="mt-3 w-full resize-none rounded-2xl border border-slate-200 p-3 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 disabled:bg-slate-100" />
                  </>}
                  {composerError && <div className="mt-3 flex gap-2 rounded-xl bg-rose-50 p-3 text-xs text-rose-700"><AlertCircle className="h-4 w-4 shrink-0" />{composerError}</div>}
                  {feedback && <div className={`mt-3 rounded-xl p-3 text-xs ${feedback.tone === 'success' ? 'bg-emerald-50 text-emerald-700' : feedback.tone === 'warning' ? 'bg-amber-50 text-amber-800' : 'bg-rose-50 text-rose-700'}`} role={feedback.tone === 'error' ? 'alert' : 'status'}>{feedback.message}</div>}
                  <button type="button" onClick={() => void publish()} disabled={actionBusy || (kind === 'text' ? !text.trim() : !media)} className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-emerald-600 text-sm font-bold text-white shadow-lg shadow-emerald-600/20 hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none">{publishing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}{publishing ? 'Publicando…' : 'Publicar estado'}</button>
                  <p className="mt-3 text-center text-[11px] leading-4 text-slate-500">Se usará la privacidad configurada en WhatsApp. Clarin no mostrará estados de tus contactos.</p>
                </section>
              </div>
            </main>
            )}
          </div>
        )}
      </div>
      <StatusMediaEditor
        open={mediaEditorOpen}
        file={media}
        kind={kind === 'video' ? 'video' : 'image'}
        onCancel={() => setMediaEditorOpen(false)}
        onApply={applyMediaEdit}
      />
      {viewersOpen && <div className="fixed inset-0 z-[180] flex items-center justify-center bg-slate-950/60 p-4" onMouseDown={event => { if (event.target === event.currentTarget) closeViewers() }}>
        <section ref={viewersDialogRef} role="dialog" aria-modal="true" aria-label="Visualizaciones del estado" className="flex max-h-[80dvh] w-full max-w-md flex-col overflow-hidden rounded-3xl bg-white shadow-2xl">
          <header className="flex min-h-16 items-center gap-3 border-b border-slate-200 px-5"><div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700"><Eye className="h-5 w-5" /></div><div className="min-w-0 flex-1"><h3 className="font-bold text-slate-900">Visualizaciones informadas por WhatsApp</h3><p className="text-xs text-slate-500">{viewers.length} persona{viewers.length === 1 ? '' : 's'}</p></div><button ref={viewersCloseButtonRef} type="button" onClick={closeViewers} className="flex h-10 w-10 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100" aria-label="Cerrar"><X className="h-5 w-5" /></button></header>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {viewersLoading && <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500"><Loader2 className="h-5 w-5 animate-spin" />Cargando visualizaciones</div>}
            {viewersError && <div className="rounded-2xl bg-rose-50 p-4 text-sm text-rose-700">{viewersError}</div>}
            {!viewersLoading && !viewersError && viewers.length === 0 && <div className="py-12 text-center"><Eye className="mx-auto h-8 w-8 text-slate-300" /><p className="mt-3 text-sm font-semibold text-slate-600">Aún no hay visualizaciones disponibles</p></div>}
            <div className="space-y-1">{viewers.map(viewer => {
              const name = viewer.viewer_name || viewer.viewer_phone || viewer.viewer_jid.split('@')[0] || 'Contacto de WhatsApp'
              return <div key={viewer.id} className="flex items-center gap-3 rounded-2xl p-2.5 hover:bg-slate-50"><div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full bg-emerald-100 font-bold text-emerald-700">{viewer.viewer_avatar ? <img src={viewer.viewer_avatar} alt="" className="h-full w-full object-cover" /> : name.slice(0, 1).toUpperCase()}</div><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold text-slate-900">{name}</p><p className="truncate text-xs text-slate-500">{viewer.viewer_phone || viewer.viewer_jid.split('@')[0]} · {viewer.receipt_type === 'played' ? 'Reprodujo' : 'Vio'} el {statusTime(viewer.viewed_at)}</p></div></div>
            })}</div>
          </div>
          <footer className={`border-t px-5 py-3 text-xs ${readReceiptsEnabled === false ? 'border-amber-100 bg-amber-50 text-amber-800' : 'border-slate-100 bg-slate-50 text-slate-600'}`}>{readReceiptsEnabled === false ? 'Los recibos de lectura están desactivados; WhatsApp puede omitir algunas personas.' : 'La lista depende de los recibos de lectura enviados por WhatsApp.'}</footer>
        </section>
      </div>}
      {deleteCandidate && <div className="fixed inset-0 z-[185] flex items-center justify-center bg-slate-950/65 p-4">
        <section ref={deleteDialogRef} role="alertdialog" aria-modal="true" aria-label="Eliminar estado" className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl"><div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-rose-100 text-rose-600"><Trash2 className="h-6 w-6" /></div><h3 className="mt-4 text-lg font-bold text-slate-900">¿Eliminar este estado?</h3><p className="mt-2 text-sm leading-6 text-slate-600">Si ya fue publicado, Clarin pedirá primero a WhatsApp que lo elimine. No mostraremos una confirmación hasta recibir respuesta del dispositivo.</p><div className="mt-6 flex justify-end gap-2"><button ref={deleteCancelButtonRef} type="button" onClick={closeDeleteDialog} disabled={Boolean(deletingStatusId)} className="h-11 rounded-xl border border-slate-200 px-4 text-sm font-bold text-slate-700 disabled:opacity-40">Cancelar</button><button type="button" onClick={() => void deleteStatus()} disabled={Boolean(deletingStatusId)} className="flex h-11 items-center gap-2 rounded-xl bg-rose-600 px-4 text-sm font-bold text-white disabled:opacity-50">{deletingStatusId ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}{deletingStatusId ? 'Eliminando…' : 'Eliminar estado'}</button></div></section>
      </div>}
    </div>,
    document.body,
  )
}
