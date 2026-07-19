'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  ImagePlus,
  Loader2,
  RefreshCw,
  Star,
  Sticker,
  Upload,
  X,
} from 'lucide-react'
import { chatMediaIdentity } from '@/utils/chatMediaUrl'

type StickerTab = 'recent' | 'saved' | 'create'
type StickerFit = 'fit' | 'fill'

type StickerDraft = {
  file: File
  previewUrl: string
  width: number
  height: number
}

interface StickerPickerProps {
  onStickerSelect: (stickerUrl: string, file?: File) => void | Promise<void>
  isOpen?: boolean
  onToggle?: () => void
  savedStickers: string[]
  savedStickerUrls: Set<string>
  savingStickerUrls?: Set<string>
  savedLoading?: boolean
  savedError?: string | null
  onToggleSavedSticker: (stickerUrl: string) => void | Promise<void>
  onRefreshSavedStickers: () => void | Promise<void>
  triggerClassName?: string
  embedded?: boolean
}

type StickerListResponse = {
  success?: boolean
  stickers?: unknown
  error?: string
}

const MAX_SOURCE_BYTES = 5 * 1024 * 1024
const MAX_SOURCE_DIMENSION = 4096
const MIN_SOURCE_DIMENSION = 16
const STICKER_SIZE = 512
const EMPTY_STICKER_URLS = new Set<string>()

function dedupeStickerUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(
    value
      .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      .map(chatMediaIdentity),
  ))
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('No se pudo leer la imagen.'))
    image.src = url
  })
}

function canvasToWebP(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => {
        if (!blob || blob.type !== 'image/webp') {
          reject(new Error('Este navegador no pudo convertir la imagen a WebP.'))
          return
        }
        resolve(blob)
      },
      'image/webp',
      quality,
    )
  })
}

async function isAnimatedSource(file: File): Promise<boolean> {
  if (file.type !== 'image/webp' && file.type !== 'image/png') return false
  const header = new Uint8Array(await file.slice(0, Math.min(file.size, 1024 * 1024)).arrayBuffer())
  const marker = new TextDecoder('latin1').decode(header)
  return file.type === 'image/webp'
    ? marker.includes('ANIM') || marker.includes('ANMF')
    : marker.includes('acTL')
}

export default function StickerPicker({
  onStickerSelect,
  isOpen: controlledOpen,
  onToggle,
  savedStickers,
  savedStickerUrls,
  savingStickerUrls = EMPTY_STICKER_URLS,
  savedLoading = false,
  savedError,
  onToggleSavedSticker,
  onRefreshSavedStickers,
  triggerClassName = '',
  embedded = false,
}: StickerPickerProps) {
  const [internalOpen, setInternalOpen] = useState(false)
  const [tab, setTab] = useState<StickerTab>('recent')
  const [recentStickers, setRecentStickers] = useState<string[]>([])
  const [recentLoading, setRecentLoading] = useState(false)
  const [recentError, setRecentError] = useState<string | null>(null)
  const [draft, setDraft] = useState<StickerDraft | null>(null)
  const [fit, setFit] = useState<StickerFit>('fit')
  const [draftError, setDraftError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const dialogCloseRef = useRef<HTMLButtonElement>(null)
  const wasOpenRef = useRef(false)
  const recentRequestRef = useRef<AbortController | null>(null)

  const isOpen = controlledOpen !== undefined ? controlledOpen : internalOpen

  const open = useCallback(() => {
    if (isOpen) return
    if (onToggle) onToggle()
    else setInternalOpen(true)
  }, [isOpen, onToggle])

  const close = useCallback(() => {
    if (!isOpen) return
    if (onToggle) onToggle()
    else setInternalOpen(false)
  }, [isOpen, onToggle])

  const loadRecentStickers = useCallback(async () => {
    recentRequestRef.current?.abort()
    const controller = new AbortController()
    recentRequestRef.current = controller
    setRecentLoading(true)
    setRecentError(null)

    try {
      const token = localStorage.getItem('token')
      const response = await fetch('/api/stickers/recent', {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      })
      const data = await response.json().catch(() => ({})) as StickerListResponse
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'No se pudieron cargar los stickers recientes.')
      }
      setRecentStickers(dedupeStickerUrls(data.stickers))
    } catch (error) {
      if (controller.signal.aborted) return
      setRecentError(error instanceof Error ? error.message : 'No se pudieron cargar los stickers recientes.')
    } finally {
      if (recentRequestRef.current === controller) {
        recentRequestRef.current = null
        setRecentLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    if (!isOpen) return
    void loadRecentStickers()
    void onRefreshSavedStickers()
    return () => recentRequestRef.current?.abort()
  }, [isOpen, loadRecentStickers, onRefreshSavedStickers])

  useEffect(() => () => {
    recentRequestRef.current?.abort()
  }, [])

  useEffect(() => {
    if (!draft) return
    return () => URL.revokeObjectURL(draft.previewUrl)
  }, [draft])

  useEffect(() => {
    if (!isOpen || embedded) return

    const handlePointerDown = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) close()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return

      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ))
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [close, embedded, isOpen])

  useEffect(() => {
    if (embedded) return
    if (isOpen) {
      wasOpenRef.current = true
      requestAnimationFrame(() => dialogCloseRef.current?.focus())
      return
    }
    if (wasOpenRef.current) {
      wasOpenRef.current = false
      requestAnimationFrame(() => triggerRef.current?.focus())
    }
  }, [embedded, isOpen])

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    setDraftError(null)
    const allowedTypes = new Set(['image/png', 'image/jpeg', 'image/webp'])
    if (!allowedTypes.has(file.type)) {
      setDraftError('Usa una imagen PNG, JPEG o WebP estática. Los GIF animados aún no son compatibles.')
      return
    }
    if (file.size === 0 || file.size > MAX_SOURCE_BYTES) {
      setDraftError(`La imagen debe pesar como máximo ${formatBytes(MAX_SOURCE_BYTES)}.`)
      return
    }

    try {
      if (await isAnimatedSource(file)) {
        setDraftError('La imagen contiene animación. En esta fase solo se admiten stickers estáticos.')
        return
      }
    } catch {
      setDraftError('No se pudo validar el archivo seleccionado.')
      return
    }

    const previewUrl = URL.createObjectURL(file)
    try {
      const image = await loadImage(previewUrl)
      const width = image.naturalWidth
      const height = image.naturalHeight
      if (width < MIN_SOURCE_DIMENSION || height < MIN_SOURCE_DIMENSION) {
        throw new Error(`La imagen debe medir al menos ${MIN_SOURCE_DIMENSION} × ${MIN_SOURCE_DIMENSION} px.`)
      }
      if (width > MAX_SOURCE_DIMENSION || height > MAX_SOURCE_DIMENSION) {
        throw new Error(`La imagen no puede superar ${MAX_SOURCE_DIMENSION} px por lado.`)
      }
      setDraft({ file, previewUrl, width, height })
      setFit('fit')
    } catch (error) {
      URL.revokeObjectURL(previewUrl)
      setDraftError(error instanceof Error ? error.message : 'No se pudo leer la imagen.')
    }
  }

  const createSticker = async () => {
    if (!draft || preparing) return
    setPreparing(true)
    setDraftError(null)

    try {
      const image = await loadImage(draft.previewUrl)
      const canvas = document.createElement('canvas')
      canvas.width = STICKER_SIZE
      canvas.height = STICKER_SIZE
      const context = canvas.getContext('2d')
      if (!context) throw new Error('No se pudo preparar el editor de imagen.')

      context.clearRect(0, 0, STICKER_SIZE, STICKER_SIZE)
      const scale = fit === 'fit'
        ? Math.min(STICKER_SIZE / image.naturalWidth, STICKER_SIZE / image.naturalHeight)
        : Math.max(STICKER_SIZE / image.naturalWidth, STICKER_SIZE / image.naturalHeight)
      const width = image.naturalWidth * scale
      const height = image.naturalHeight * scale
      context.drawImage(image, (STICKER_SIZE - width) / 2, (STICKER_SIZE - height) / 2, width, height)

      let blob = await canvasToWebP(canvas, 0.88)
      for (const quality of [0.78, 0.68, 0.58]) {
        if (blob.size <= 512 * 1024) break
        blob = await canvasToWebP(canvas, quality)
      }
      if (blob.size > 512 * 1024) {
        throw new Error('La imagen es demasiado compleja para un sticker. Prueba con una imagen más simple.')
      }
      const baseName = draft.file.name.replace(/\.[^.]+$/, '').slice(0, 80) || 'sticker'
      const stickerFile = new File([blob], `${baseName}.webp`, { type: 'image/webp' })
      void onStickerSelect('', stickerFile)
      setDraft(null)
      close()
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : 'No se pudo crear el sticker.')
    } finally {
      setPreparing(false)
    }
  }

  const handleStickerClick = (stickerUrl: string) => {
    void onStickerSelect(stickerUrl)
    close()
  }

  const renderAsyncError = (message: string, retry: () => void) => (
    <div role="alert" className="mx-2 mt-2 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-2.5 text-xs text-red-700">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p>{message}</p>
        <button
          type="button"
          onClick={retry}
          className="mt-1 inline-flex min-h-8 items-center gap-1 rounded-md px-2 font-semibold hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Reintentar
        </button>
      </div>
    </div>
  )

  const renderStickerGrid = (stickers: string[], empty: 'recent' | 'saved') => {
    if (stickers.length === 0) {
      return (
        <div className="flex min-h-52 flex-col items-center justify-center px-5 py-8 text-center text-slate-400">
          {empty === 'recent' ? <Sticker className="mb-3 h-10 w-10" /> : <Star className="mb-3 h-10 w-10" />}
          <p className="text-sm font-medium text-slate-600">
            {empty === 'recent' ? 'Aún no hay stickers recientes' : 'Aún no tienes favoritos'}
          </p>
          <p className="mt-1 max-w-56 text-xs">
            {empty === 'recent'
              ? 'Los stickers usados y recibidos aparecerán aquí.'
              : 'Pulsa la estrella de un sticker recibido para guardarlo.'}
          </p>
        </div>
      )
    }

    return (
      <div className="grid grid-cols-4 gap-1.5 p-2 sm:grid-cols-4">
        {stickers.map(url => {
          const isSaved = savedStickerUrls.has(url)
          const isSaving = savingStickerUrls.has(url)
          return (
            <div key={url} className="group/sticker-item relative aspect-square">
              <button
                type="button"
                onClick={() => handleStickerClick(url)}
                className="h-full w-full rounded-xl p-1.5 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                aria-label="Enviar sticker"
              >
                <img src={url} alt="" className="h-full w-full object-contain" loading="lazy" />
              </button>
              <button
                type="button"
                onClick={event => {
                  event.stopPropagation()
                  void onToggleSavedSticker(url)
                }}
                disabled={isSaving}
                aria-pressed={isSaved}
                aria-label={isSaved ? 'Quitar sticker de favoritos' : 'Guardar sticker en favoritos'}
                className={`absolute right-0 top-0 flex h-8 w-8 items-center justify-center rounded-full border shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:cursor-wait ${
                  isSaved
                    ? 'border-amber-300 bg-amber-400 text-white'
                    : 'border-slate-200 bg-white/95 text-slate-500 opacity-100 sm:opacity-0 sm:group-hover/sticker-item:opacity-100 sm:group-focus-within/sticker-item:opacity-100'
                }`}
              >
                {isSaving
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : isSaved
                    ? <Star className="h-3.5 w-3.5 fill-current" />
                    : <Star className="h-3.5 w-3.5" />}
              </button>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div ref={containerRef} className={embedded ? 'h-full min-h-0' : 'relative'}>
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileUpload}
        accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
        className="hidden"
      />

      {!embedded && <button
        ref={triggerRef}
        type="button"
        onClick={isOpen ? close : open}
        className={`h-11 w-11 items-center justify-center rounded-xl transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${triggerClassName || 'flex'} ${isOpen ? 'bg-emerald-50 text-emerald-600' : 'text-slate-500 hover:bg-slate-100 hover:text-emerald-600'}`}
        aria-label="Abrir stickers"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
      >
        <Sticker className="h-5 w-5" />
      </button>}

      {isOpen && (
        <>
          {!embedded && <button
            type="button"
            aria-label="Cerrar stickers"
            onClick={close}
            className="app-viewport fixed inset-0 z-[80] bg-slate-950/30 sm:hidden"
          />}
          <section
            ref={dialogRef}
            role={embedded ? 'region' : 'dialog'}
            aria-label="Selector de stickers"
            className={embedded
              ? 'flex h-full min-h-0 flex-col overflow-hidden bg-white'
              : 'visual-viewport-bottom-sheet fixed inset-x-0 bottom-0 z-[90] flex max-h-[85dvh] flex-col overflow-hidden rounded-t-2xl border border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] shadow-2xl sm:absolute sm:inset-x-auto sm:bottom-full sm:left-0 sm:z-50 sm:mb-2 sm:h-[410px] sm:max-h-[min(560px,calc(100dvh-7rem))] sm:w-[360px] sm:rounded-2xl sm:pb-0'}
          >
            {!embedded && <>
            <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-slate-300 sm:hidden" />
            <header className="flex min-h-12 items-center justify-between border-b border-slate-100 px-3">
              <div className="flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
                  <Sticker className="h-4 w-4" />
                </span>
                <div>
                  <h2 className="text-sm font-semibold text-slate-800">Stickers</h2>
                  <p className="text-[11px] text-slate-500">Elige, guarda o crea uno nuevo</p>
                </div>
              </div>
              <button
                ref={dialogCloseRef}
                type="button"
                onClick={close}
                className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                aria-label="Cerrar selector de stickers"
              >
                <X className="h-4 w-4" />
              </button>
            </header>
            </>}

            <div role="tablist" aria-label="Colecciones de stickers" className="grid grid-cols-3 border-b border-slate-100 px-2">
              {([
                ['recent', 'Recientes', null],
                ['saved', 'Favoritos', savedStickers.length],
                ['create', 'Crear', null],
              ] as const).map(([value, label, count]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={tab === value}
                  onClick={() => setTab(value)}
                  className={`relative min-h-11 px-2 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500 ${
                    tab === value ? 'text-emerald-700' : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  {label}
                  {count !== null && count > 0 && (
                    <span className="ml-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">{count}</span>
                  )}
                  {tab === value && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-emerald-600" />}
                </button>
              ))}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              {tab === 'recent' && (
                <>
                  {recentError && renderAsyncError(recentError, () => void loadRecentStickers())}
                  {recentLoading && recentStickers.length === 0
                    ? <div className="flex min-h-52 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-emerald-600" /></div>
                    : renderStickerGrid(recentStickers, 'recent')}
                </>
              )}

              {tab === 'saved' && (
                <>
                  {savedError && renderAsyncError(savedError, () => void onRefreshSavedStickers())}
                  {savedLoading && savedStickers.length === 0
                    ? <div className="flex min-h-52 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-emerald-600" /></div>
                    : renderStickerGrid(savedStickers, 'saved')}
                </>
              )}

              {tab === 'create' && (
                <div className="p-3">
                  {draftError && (
                    <div role="alert" className="mb-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-2.5 text-xs text-red-700">
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>{draftError}</span>
                    </div>
                  )}

                  {!draft ? (
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="flex min-h-56 w-full flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 px-6 text-center transition hover:border-emerald-400 hover:bg-emerald-50/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                    >
                      <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-white text-emerald-600 shadow-sm">
                        <ImagePlus className="h-6 w-6" />
                      </span>
                      <span className="text-sm font-semibold text-slate-700">Elegir imagen</span>
                      <span className="mt-1 text-xs leading-5 text-slate-500">PNG, JPEG o WebP estático · máximo 5 MB y 4096 px</span>
                    </button>
                  ) : (
                    <>
                      <div className="mx-auto aspect-square w-48 overflow-hidden rounded-xl border border-slate-200 bg-[linear-gradient(45deg,#f1f5f9_25%,transparent_25%),linear-gradient(-45deg,#f1f5f9_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#f1f5f9_75%),linear-gradient(-45deg,transparent_75%,#f1f5f9_75%)] bg-[length:16px_16px] bg-[position:0_0,0_8px,8px_-8px,-8px_0px]">
                        <img
                          src={draft.previewUrl}
                          alt="Vista previa del sticker"
                          className={`h-full w-full ${fit === 'fit' ? 'object-contain' : 'object-cover'}`}
                        />
                      </div>
                      <p className="mt-2 text-center text-[11px] text-slate-500">
                        {draft.width} × {draft.height} px · {formatBytes(draft.file.size)}
                      </p>

                      <fieldset className="mt-3">
                        <legend className="mb-1.5 text-xs font-semibold text-slate-700">Encuadre</legend>
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            aria-pressed={fit === 'fit'}
                            onClick={() => setFit('fit')}
                            className={`min-h-10 rounded-lg border px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${fit === 'fit' ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}
                          >
                            Ajustar completa
                          </button>
                          <button
                            type="button"
                            aria-pressed={fit === 'fill'}
                            onClick={() => setFit('fill')}
                            className={`min-h-10 rounded-lg border px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${fit === 'fill' ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}
                          >
                            Llenar y recortar
                          </button>
                        </div>
                      </fieldset>

                      <div className="mt-3 grid grid-cols-[1fr_auto] gap-2">
                        <button
                          type="button"
                          onClick={createSticker}
                          disabled={preparing}
                          className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white transition hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
                        >
                          {preparing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sticker className="h-4 w-4" />}
                          {preparing ? 'Preparando…' : 'Crear y enviar'}
                        </button>
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          disabled={preparing}
                          className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-600 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-50"
                          aria-label="Elegir otra imagen"
                        >
                          <Upload className="h-4 w-4" />
                          Cambiar
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  )
}
