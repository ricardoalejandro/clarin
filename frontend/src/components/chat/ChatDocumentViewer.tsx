'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, ChevronLeft, ChevronRight, Download, FileText, Loader2, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import { apiBlob } from '@/lib/api'
import { loadPdfRuntime } from '@/lib/pdfRuntime'
import type { ChatDocumentDescriptor } from '@/utils/chatDocuments'
import { OPERATIONAL_OVERLAY_LAYERS, useOperationalOverlayPortal, useOperationalOverlayRegistration } from '@/components/operational-window/OperationalOverlayContext'

interface ChatDocumentViewerProps {
  document: ChatDocumentDescriptor
  onClose: () => void
}

type ViewerPhase = 'downloading' | 'opening' | 'rendering' | 'ready' | 'error'

type ViewerResources = {
  controller?: AbortController
  objectURL?: string
  loadingTask?: PDFDocumentLoadingTask
  document?: PDFDocumentProxy
  renderTask?: RenderTask
  slowTimer?: number
  timeoutTimer?: number
}

export const CHAT_PDF_SLOW_MS = 8_000
export const CHAT_PDF_TIMEOUT_MS = 30_000

function formatFileSize(bytes?: number) {
  if (!bytes || bytes <= 0) return 'PDF'
  const units = ['B', 'KB', 'MB', 'GB']
  const unit = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `PDF · ${(bytes / Math.pow(1024, unit)).toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

export default function ChatDocumentViewer({ document: descriptor, onClose }: ChatDocumentViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const resourcesRef = useRef<ViewerResources>({})
  const sessionRef = useRef(0)
  const [reloadKey, setReloadKey] = useState(0)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [page, setPage] = useState(1)
  const [pageCount, setPageCount] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [downloadURL, setDownloadURL] = useState('')
  const [phase, setPhase] = useState<ViewerPhase>('downloading')
  const [slow, setSlow] = useState(false)
  const [error, setError] = useState('')
  const operationalPortal = useOperationalOverlayPortal()
  useOperationalOverlayRegistration(true, `chat-document-viewer:${descriptor.sessionId}`)

  const clearTimers = useCallback(() => {
    const resources = resourcesRef.current
    if (resources.slowTimer) window.clearTimeout(resources.slowTimer)
    if (resources.timeoutTimer) window.clearTimeout(resources.timeoutTimer)
    resources.slowTimer = undefined
    resources.timeoutTimer = undefined
  }, [])

  const clearCanvas = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width = 0
    canvas.height = 0
    canvas.style.width = ''
    canvas.style.height = ''
  }, [])

  const disposeResources = useCallback(() => {
    const resources = resourcesRef.current
    resources.controller?.abort()
    if (resources.slowTimer) window.clearTimeout(resources.slowTimer)
    if (resources.timeoutTimer) window.clearTimeout(resources.timeoutTimer)
    try { resources.renderTask?.cancel() } catch {}
    if (resources.document) void resources.document.destroy().catch(() => undefined)
    else if (resources.loadingTask) void resources.loadingTask.destroy().catch(() => undefined)
    if (resources.objectURL) URL.revokeObjectURL(resources.objectURL)
    resourcesRef.current = {}
    clearCanvas()
  }, [clearCanvas])

  const closeViewer = useCallback(() => {
    sessionRef.current++
    disposeResources()
    onClose()
  }, [disposeResources, onClose])

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    document.body.style.overflow = 'hidden'
    const focusFrame = window.requestAnimationFrame(() => dialogRef.current?.focus())

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        closeViewer()
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter(element => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true')
      if (!focusable.length) {
        event.preventDefault()
        dialogRef.current.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (event.shiftKey && (active === first || !dialogRef.current.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      window.removeEventListener('keydown', handleKeyDown, true)
      document.body.style.overflow = previousOverflow
      previousFocusRef.current?.focus()
    }
  }, [closeViewer])

  useEffect(() => {
    const session = ++sessionRef.current
    disposeResources()
    const controller = new AbortController()
    resourcesRef.current.controller = controller
    const isCurrent = () => sessionRef.current === session && !controller.signal.aborted

    setPdf(null)
    setPage(1)
    setPageCount(0)
    setZoom(1)
    setDownloadURL('')
    setPhase('downloading')
    setSlow(false)
    setError('')

    const fail = (message: string) => {
      if (!isCurrent()) return
      clearTimers()
      try { resourcesRef.current.renderTask?.cancel() } catch {}
      if (resourcesRef.current.loadingTask) void resourcesRef.current.loadingTask.destroy().catch(() => undefined)
      resourcesRef.current.loadingTask = undefined
      resourcesRef.current.renderTask = undefined
      setPdf(null)
      setSlow(false)
      setPhase('error')
      setError(message)
    }

    const startDeadline = () => {
      clearTimers()
      resourcesRef.current.slowTimer = window.setTimeout(() => {
        if (isCurrent()) setSlow(true)
      }, CHAT_PDF_SLOW_MS)
      resourcesRef.current.timeoutTimer = window.setTimeout(() => {
        if (!isCurrent()) return
        controller.abort()
        try { resourcesRef.current.renderTask?.cancel() } catch {}
        if (resourcesRef.current.document) void resourcesRef.current.document.destroy().catch(() => undefined)
        else if (resourcesRef.current.loadingTask) void resourcesRef.current.loadingTask.destroy().catch(() => undefined)
        resourcesRef.current.document = undefined
        resourcesRef.current.loadingTask = undefined
        resourcesRef.current.renderTask = undefined
        setPdf(null)
        setSlow(false)
        setPhase('error')
        setError('La vista previa tardó demasiado. Puedes reintentar o descargar el archivo original.')
      }, CHAT_PDF_TIMEOUT_MS)
    }

    const load = async () => {
      startDeadline()
      const result = await apiBlob(descriptor.src, { signal: controller.signal })
      if (!isCurrent()) return
      if (!result.success || !result.blob) {
        fail(result.error || 'No se pudo descargar el documento.')
        return
      }

      const objectURL = URL.createObjectURL(result.blob)
      resourcesRef.current.objectURL = objectURL
      setDownloadURL(objectURL)
      setPhase('opening')

      try {
        const [pdfjs, data] = await Promise.all([loadPdfRuntime(), result.blob.arrayBuffer()])
        if (!isCurrent()) return
        const loadingTask = pdfjs.getDocument({ data })
        resourcesRef.current.loadingTask = loadingTask
        const loadedDocument = await loadingTask.promise
        if (!isCurrent()) {
          void loadedDocument.destroy().catch(() => undefined)
          return
        }
        resourcesRef.current.loadingTask = undefined
        resourcesRef.current.document = loadedDocument
        clearTimers()
        setPageCount(loadedDocument.numPages)
        setPhase('rendering')
        setPdf(loadedDocument)
      } catch (cause) {
        if (!isCurrent()) return
        const detail = cause instanceof Error && cause.message ? ` ${cause.message}` : ''
        fail(`No se pudo abrir este PDF.${detail}`)
      }
    }

    void load()
    return () => {
      if (sessionRef.current === session) sessionRef.current++
      disposeResources()
    }
  }, [clearTimers, descriptor.sessionId, descriptor.src, disposeResources, reloadKey])

  useEffect(() => {
    if (!pdf || !canvasRef.current) return
    const session = sessionRef.current
    let disposed = false
    let timedOut = false
    clearTimers()
    setSlow(false)
    setError('')
    setPhase('rendering')

    resourcesRef.current.slowTimer = window.setTimeout(() => {
      if (!disposed && sessionRef.current === session) setSlow(true)
    }, CHAT_PDF_SLOW_MS)
    resourcesRef.current.timeoutTimer = window.setTimeout(() => {
      if (disposed || sessionRef.current !== session) return
      timedOut = true
      try { resourcesRef.current.renderTask?.cancel() } catch {}
      if (resourcesRef.current.document) void resourcesRef.current.document.destroy().catch(() => undefined)
      resourcesRef.current.document = undefined
      resourcesRef.current.renderTask = undefined
      setPdf(null)
      setSlow(false)
      setPhase('error')
      setError('La página tardó demasiado en renderizarse. Puedes reintentar o descargar el archivo original.')
    }, CHAT_PDF_TIMEOUT_MS)

    const renderPage = async () => {
      try {
        try { resourcesRef.current.renderTask?.cancel() } catch {}
        resourcesRef.current.renderTask = undefined
        const pdfPage = await pdf.getPage(page)
        if (disposed || timedOut || sessionRef.current !== session || !canvasRef.current) return
        const viewport = pdfPage.getViewport({ scale: zoom * 1.25 })
        const outputScale = Math.max(1, window.devicePixelRatio || 1)
        const canvas = canvasRef.current
        const context = canvas.getContext('2d')
        if (!context) throw new Error('El navegador no pudo preparar el lienzo del PDF.')
        canvas.width = Math.floor(viewport.width * outputScale)
        canvas.height = Math.floor(viewport.height * outputScale)
        canvas.style.width = `${Math.floor(viewport.width)}px`
        canvas.style.height = `${Math.floor(viewport.height)}px`
        const renderTask = pdfPage.render({
          canvasContext: context,
          viewport,
          transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
        })
        resourcesRef.current.renderTask = renderTask
        await renderTask.promise
        if (disposed || timedOut || sessionRef.current !== session) return
        resourcesRef.current.renderTask = undefined
        clearTimers()
        setSlow(false)
        setPhase('ready')
      } catch (cause) {
        const name = cause instanceof Error ? cause.name : ''
        if (disposed || timedOut || sessionRef.current !== session || name === 'RenderingCancelledException') return
        clearTimers()
        setSlow(false)
        setPhase('error')
        setError('No se pudo renderizar esta página. Reintenta abrir el documento.')
      }
    }

    void renderPage()
    return () => {
      disposed = true
      clearTimers()
      try { resourcesRef.current.renderTask?.cancel() } catch {}
      resourcesRef.current.renderTask = undefined
    }
  }, [clearTimers, page, pdf, zoom])

  const zoomOut = () => setZoom(value => Math.max(.5, Number((value - .2).toFixed(1))))
  const zoomIn = () => setZoom(value => Math.min(4, Number((value + .2).toFixed(1))))
  const loading = phase !== 'ready' && phase !== 'error'
  const downloadHref = downloadURL || descriptor.src

  if (typeof window === 'undefined') return null

  return createPortal(
    <div
      data-chat-overlay="document-viewer"
      className="app-viewport pointer-events-auto fixed inset-0 flex items-center justify-center bg-slate-950/75 p-0 backdrop-blur-[2px] sm:p-5"
      style={{ zIndex: OPERATIONAL_OVERLAY_LAYERS.dialog }}
      role="presentation"
      onMouseDown={event => { if (event.target === event.currentTarget) closeViewer() }}
    >
      <section
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Vista previa de ${descriptor.filename}`}
        className="flex h-full w-full min-w-0 flex-col overflow-hidden bg-slate-950 text-white outline-none sm:h-[92vh] sm:max-w-6xl sm:rounded-3xl sm:border sm:border-white/10 sm:shadow-2xl sm:shadow-black/50"
      >
        <header className="safe-area-top safe-area-x flex min-h-16 shrink-0 items-center gap-2 border-b border-white/10 bg-slate-950/95 px-2 sm:px-4">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-rose-500/15 text-rose-300"><FileText className="h-5 w-5" /></span>
            <div className="min-w-0">
              <h2 className="truncate text-sm font-bold" title={descriptor.filename}>{descriptor.filename}</h2>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{formatFileSize(descriptor.size)}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
            <button type="button" onClick={zoomOut} disabled={!pdf || zoom <= .5} className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-white/75 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:opacity-30" aria-label="Alejar PDF"><ZoomOut className="h-4 w-4" /></button>
            <span className="hidden min-w-12 text-center text-xs font-bold text-slate-300 sm:block">{Math.round(zoom * 100)}%</span>
            <button type="button" onClick={zoomIn} disabled={!pdf || zoom >= 4} className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-white/75 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:opacity-30" aria-label="Acercar PDF"><ZoomIn className="h-4 w-4" /></button>
            <a href={downloadHref} download={descriptor.filename} className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-white/75 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400" aria-label={`Descargar ${descriptor.filename}`} title="Descargar"><Download className="h-4 w-4" /></a>
            <button type="button" onClick={closeViewer} className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-white/75 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400" aria-label="Cerrar visor PDF" title="Cerrar (Esc)"><X className="h-5 w-5" /></button>
          </div>
        </header>

        <div className="relative min-h-0 flex-1 overflow-auto overscroll-contain bg-slate-900 p-3 sm:p-6">
          {loading && (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-900/95 px-6 text-center" role="status" aria-live="polite">
              <div>
                <Loader2 className="mx-auto h-7 w-7 animate-spin text-emerald-400" />
                <p className="mt-3 text-sm font-bold">{phase === 'downloading' ? 'Descargando PDF…' : phase === 'opening' ? 'Abriendo PDF…' : 'Renderizando página…'}</p>
                {slow && <p className="mx-auto mt-3 max-w-sm text-xs leading-5 text-amber-200">Está tardando más de lo habitual. Puedes seguir esperando o descargar el archivo original.</p>}
              </div>
            </div>
          )}
          {phase === 'error' && (
            <div className="flex h-full min-h-72 items-center justify-center px-4 text-center" role="alert">
              <div className="max-w-md">
                <AlertCircle className="mx-auto h-10 w-10 text-rose-400" />
                <h3 className="mt-3 text-base font-bold">No pudimos mostrar este PDF</h3>
                <p className="mt-2 text-xs leading-5 text-slate-400">{error}</p>
                <div className="mt-5 flex flex-wrap justify-center gap-2">
                  <button type="button" onClick={() => setReloadKey(value => value + 1)} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-emerald-500 px-4 text-xs font-black text-slate-950 transition hover:bg-emerald-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300"><RotateCcw className="h-4 w-4" />Reintentar</button>
                  <a href={downloadHref} download={descriptor.filename} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-white/10 px-4 text-xs font-bold text-white transition hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"><Download className="h-4 w-4" />Descargar original</a>
                </div>
              </div>
            </div>
          )}
          {pdf && phase !== 'error' && (
            <div className="mx-auto flex min-h-full min-w-full w-fit items-start justify-center">
              <canvas ref={canvasRef} className="block max-w-none rounded-lg bg-white shadow-2xl shadow-black/30" aria-label={`Página ${page} de ${pageCount || pdf.numPages}`} />
            </div>
          )}
        </div>

        <footer className="safe-area-bottom flex min-h-14 shrink-0 items-center justify-center gap-3 border-t border-white/10 bg-slate-950/95 px-3">
          <button type="button" aria-label="Página anterior" disabled={!pdf || page <= 1 || loading} onClick={() => setPage(value => Math.max(1, value - 1))} className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-white/75 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:opacity-30"><ChevronLeft className="h-5 w-5" /></button>
          <span className="min-w-28 text-center text-xs font-bold text-slate-300">{pageCount > 0 ? `Página ${page} de ${pageCount}` : 'Preparando páginas'}</span>
          <button type="button" aria-label="Página siguiente" disabled={!pdf || page >= pageCount || loading} onClick={() => setPage(value => Math.min(pageCount, value + 1))} className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-white/75 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:opacity-30"><ChevronRight className="h-5 w-5" /></button>
        </footer>
      </section>
    </div>,
    operationalPortal || document.body,
  )
}
