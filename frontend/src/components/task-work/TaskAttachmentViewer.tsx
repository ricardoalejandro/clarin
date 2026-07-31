'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, CheckCircle2, ChevronLeft, ChevronRight, Download, Loader2, Maximize2, MessageSquare, RotateCcw, Send, X, ZoomIn, ZoomOut } from 'lucide-react'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import { apiBlob, apiGet, apiPost, apiPut } from '@/lib/api'
import type { TaskAttachment, TaskAttachmentAnchor, TaskAttachmentComment, TaskAttachmentPreview } from '@/types/task'
import type { TaskAccountUser } from './TaskEditorModal'
import TaskUserCombobox from './TaskUserCombobox'
import { TASK_OVERLAY_LAYERS } from './taskOverlayLayers'
import { emptyAttachmentAnchor, hasUsableAttachmentAnchor, normalizedAttachmentPoint, textAttachmentAnchor } from './taskAttachmentAnchors'
import {
  ATTACHMENT_PREVIEW_SLOW_MS,
  ATTACHMENT_PREVIEW_TIMEOUT_MS,
  canRetryTaskAttachmentConversion,
  shouldPollTaskAttachmentPreview,
  taskAttachmentPreviewPhaseLabel,
  taskAttachmentPreviewPollDelay,
  type TaskAttachmentPreviewPhase,
} from './taskAttachmentPreviewState'
import { loadTaskPdfRuntime } from './taskPdfRuntime'

interface Props {
  taskId: string
  attachment: TaskAttachment
  users: TaskAccountUser[]
  onClose: () => void
}

type ViewerResources = {
  controller?: AbortController
  objectURL?: string
  loadingTask?: PDFDocumentLoadingTask
  document?: PDFDocumentProxy
  renderTask?: RenderTask
  slowTimer?: number
  timeoutTimer?: number
  pollTimer?: number
}

export default function TaskAttachmentViewer({ taskId, attachment, users, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const resourcesRef = useRef<ViewerResources>({})
  const sessionRef = useRef(0)
  const identityRef = useRef(`${taskId}:${attachment.id}`)
  const [reloadKey, setReloadKey] = useState(0)
  const [preview, setPreview] = useState<TaskAttachmentPreview | null>(attachment.preview || null)
  const [comments, setComments] = useState<TaskAttachmentComment[]>([])
  const [objectURL, setObjectURL] = useState('')
  const [text, setText] = useState('')
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [page, setPage] = useState(1)
  const [zoom, setZoom] = useState(1)
  const [fullscreen, setFullscreen] = useState(false)
  const [mobileCommentsOpen, setMobileCommentsOpen] = useState(false)
  const [anchor, setAnchor] = useState<TaskAttachmentAnchor>(() => emptyAttachmentAnchor(attachment.preview?.kind))
  const [body, setBody] = useState('')
  const [mentionIDs, setMentionIDs] = useState<string[]>([])
  const [replyTo, setReplyTo] = useState<string | undefined>()
  const [phase, setPhase] = useState<TaskAttachmentPreviewPhase>('metadata')
  const [loading, setLoading] = useState(true)
  const [slow, setSlow] = useState(false)
  const [saving, setSaving] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [error, setError] = useState('')
  const [commentError, setCommentError] = useState('')

  const clearLoadTimers = useCallback(() => {
    const resources = resourcesRef.current
    if (resources.slowTimer) window.clearTimeout(resources.slowTimer)
    if (resources.timeoutTimer) window.clearTimeout(resources.timeoutTimer)
    resources.slowTimer = undefined
    resources.timeoutTimer = undefined
  }, [])

  const disposeResources = useCallback(() => {
    const resources = resourcesRef.current
    resources.controller?.abort()
    if (resources.slowTimer) window.clearTimeout(resources.slowTimer)
    if (resources.timeoutTimer) window.clearTimeout(resources.timeoutTimer)
    if (resources.pollTimer) window.clearTimeout(resources.pollTimer)
    try { resources.renderTask?.cancel() } catch {}
    if (resources.document) void resources.document.destroy().catch(() => undefined)
    else if (resources.loadingTask) void resources.loadingTask.destroy().catch(() => undefined)
    if (resources.objectURL) URL.revokeObjectURL(resources.objectURL)
    resourcesRef.current = {}
    const canvas = canvasRef.current
    if (canvas) {
      canvas.width = 0
      canvas.height = 0
    }
  }, [])

  const closeViewer = useCallback(() => {
    sessionRef.current++
    disposeResources()
    onClose()
  }, [disposeResources, onClose])

  useEffect(() => {
    identityRef.current = `${taskId}:${attachment.id}`
    const session = ++sessionRef.current
    disposeResources()
    const controller = new AbortController()
    resourcesRef.current.controller = controller
    const isCurrent = () => sessionRef.current === session && !controller.signal.aborted
    const fail = (message: string) => {
      if (!isCurrent()) return
      clearLoadTimers()
      setLoading(false)
      setSlow(false)
      setPhase('error')
      setError(message)
    }
    const complete = () => {
      if (!isCurrent()) return
      clearLoadTimers()
      setLoading(false)
      setSlow(false)
      setPhase('ready')
    }
    const startLoadDeadline = () => {
      clearLoadTimers()
      resourcesRef.current.slowTimer = window.setTimeout(() => {
        if (isCurrent()) setSlow(true)
      }, ATTACHMENT_PREVIEW_SLOW_MS)
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
        setLoading(false)
        setSlow(false)
        setPhase('error')
        setError('La vista previa tardó demasiado. Puedes reintentar o descargar el archivo original.')
      }, ATTACHMENT_PREVIEW_TIMEOUT_MS)
    }
    const openReadyPreview = async (nextPreview: TaskAttachmentPreview) => {
      if (!nextPreview.url) {
        fail('La vista previa no tiene un archivo disponible.')
        return
      }
      setLoading(true)
      setPhase('downloading')
      const blobResult = await apiBlob(nextPreview.url, { signal: controller.signal })
      if (!isCurrent()) return
      if (!blobResult.success || !blobResult.blob) {
        fail(blobResult.error || 'No se pudo descargar la vista previa.')
        return
      }
      try {
        if (nextPreview.kind === 'image') {
          const url = URL.createObjectURL(blobResult.blob)
          resourcesRef.current.objectURL = url
          setObjectURL(url)
          complete()
          return
        }
        if (nextPreview.kind === 'text') {
          const nextText = await blobResult.blob.text()
          if (!isCurrent()) return
          setText(nextText)
          complete()
          return
        }
        if (nextPreview.kind === 'pdf' || nextPreview.kind === 'word_pdf') {
          setPhase('opening')
          const [pdfjs, data] = await Promise.all([loadTaskPdfRuntime(), blobResult.blob.arrayBuffer()])
          if (!isCurrent()) return
          const loadingTask = pdfjs.getDocument({ data })
          resourcesRef.current.loadingTask = loadingTask
          const document = await loadingTask.promise
          if (!isCurrent()) {
            void document.destroy().catch(() => undefined)
            return
          }
          resourcesRef.current.loadingTask = undefined
          resourcesRef.current.document = document
          setPreview(current => current ? { ...current, page_count: document.numPages } : current)
          setPhase('rendering')
          setPdf(document)
          return
        }
        complete()
      } catch (cause) {
        if (!isCurrent()) return
        const message = cause instanceof Error && cause.message ? cause.message : 'No se pudo abrir el archivo.'
        fail(`No se pudo abrir la vista previa. ${message}`)
      }
    }
    const consumePreview = async (nextPreview: TaskAttachmentPreview, pollAttempt = 0): Promise<void> => {
      if (!isCurrent()) return
      setPreview(nextPreview)
      setAnchor(emptyAttachmentAnchor(nextPreview.kind))
      if (nextPreview.status === 'unsupported') {
        clearLoadTimers()
        setLoading(false)
        setSlow(false)
        setPhase('unsupported')
        return
      }
      if (nextPreview.status === 'failed') {
        fail(nextPreview.error || 'No se pudo convertir este documento.')
        return
      }
      if (shouldPollTaskAttachmentPreview(nextPreview)) {
        setLoading(false)
        setPhase('converting')
        resourcesRef.current.pollTimer = window.setTimeout(async () => {
          const result = await apiGet<{ preview: TaskAttachmentPreview }>(`/api/tasks/${taskId}/attachments/${attachment.id}/preview`, { signal: controller.signal })
          if (!isCurrent()) return
          if (!result.success || !result.data?.preview) {
            fail(result.error || 'No se pudo consultar la conversión.')
            return
          }
          await consumePreview(result.data.preview, pollAttempt + 1)
        }, taskAttachmentPreviewPollDelay(pollAttempt))
        return
      }
      if (nextPreview.status === 'ready') {
        await openReadyPreview(nextPreview)
        return
      }
      fail('La vista previa devolvió un estado que no reconocemos.')
    }
    const load = async () => {
      setPreview(attachment.preview || null)
      setComments([])
      setObjectURL('')
      setText('')
      setPdf(null)
      setPage(1)
      setZoom(1)
      setMobileCommentsOpen(false)
      setAnchor(emptyAttachmentAnchor(attachment.preview?.kind))
      setLoading(true)
      setSlow(false)
      setSaving(false)
      setRetrying(false)
      setBody('')
      setMentionIDs([])
      setReplyTo(undefined)
      setPhase('metadata')
      setError('')
      setCommentError('')
      startLoadDeadline()
      const commentsRequest = apiGet<{ comments: TaskAttachmentComment[] }>(`/api/tasks/${taskId}/attachments/${attachment.id}/comments`, { signal: controller.signal })
      void commentsRequest.then(commentsResult => {
        if (!isCurrent()) return
        if (commentsResult.success) setComments(commentsResult.data?.comments || [])
        else if (commentsResult.error !== 'Solicitud cancelada') setCommentError(commentsResult.error || 'No se pudieron cargar los comentarios.')
      })
      const previewResult = await apiGet<{ preview: TaskAttachmentPreview }>(`/api/tasks/${taskId}/attachments/${attachment.id}/preview`, { signal: controller.signal })
      if (!isCurrent()) return
      if (!previewResult.success || !previewResult.data?.preview) {
        fail(previewResult.error || 'No se pudo preparar la vista previa.')
        return
      }
      await consumePreview(previewResult.data.preview)
    }
    void load()
    return () => {
      if (sessionRef.current === session) sessionRef.current++
      disposeResources()
    }
  }, [attachment.id, clearLoadTimers, disposeResources, reloadKey, taskId])

  useEffect(() => {
    if (!pdf || !canvasRef.current) return
    const session = sessionRef.current
    let disposed = false
    let timedOut = false
    clearLoadTimers()
    setSlow(false)
    setError('')
    resourcesRef.current.slowTimer = window.setTimeout(() => {
      if (!disposed && sessionRef.current === session) setSlow(true)
    }, ATTACHMENT_PREVIEW_SLOW_MS)
    resourcesRef.current.timeoutTimer = window.setTimeout(() => {
      if (disposed || sessionRef.current !== session) return
      timedOut = true
      try { resourcesRef.current.renderTask?.cancel() } catch {}
      resourcesRef.current.renderTask = undefined
      setLoading(false)
      setSlow(false)
      setPhase('error')
      setError('La página tardó demasiado en renderizarse. Puedes reintentar o descargar el archivo original.')
    }, ATTACHMENT_PREVIEW_TIMEOUT_MS)
    const renderPage = async () => {
      try {
        try { resourcesRef.current.renderTask?.cancel() } catch {}
        resourcesRef.current.renderTask = undefined
        setLoading(true)
        setPhase('rendering')
        const pdfPage = await pdf.getPage(page)
        if (disposed || timedOut || sessionRef.current !== session || !canvasRef.current) return
        const viewport = pdfPage.getViewport({ scale: zoom * 1.25 })
        const context = canvasRef.current.getContext('2d')
        if (!context) throw new Error('El navegador no pudo preparar el lienzo del PDF.')
        canvasRef.current.width = viewport.width
        canvasRef.current.height = viewport.height
        const renderTask = pdfPage.render({ canvasContext: context, viewport })
        resourcesRef.current.renderTask = renderTask
        await renderTask.promise
        if (disposed || timedOut || sessionRef.current !== session) return
        resourcesRef.current.renderTask = undefined
        clearLoadTimers()
        setLoading(false)
        setSlow(false)
        setPhase('ready')
      } catch (cause) {
        const name = cause instanceof Error ? cause.name : ''
        if (disposed || timedOut || sessionRef.current !== session || name === 'RenderingCancelledException') return
        clearLoadTimers()
        setLoading(false)
        setSlow(false)
        setPhase('error')
        setError('No se pudo renderizar esta página. Reintenta abrir el documento.')
      }
    }
    void renderPage()
    return () => {
      disposed = true
      clearLoadTimers()
      try { resourcesRef.current.renderTask?.cancel() } catch {}
      resourcesRef.current.renderTask = undefined
    }
  }, [clearLoadTimers, page, pdf, zoom])

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus({ preventScroll: true }))
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !dialogRef.current) return
      if (document.querySelector('[data-task-user-combobox-portal],[data-task-select-picker-portal],[data-task-property-picker-portal]')) return
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],textarea:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])'))
      if (!focusable.length) {
        event.preventDefault()
        dialogRef.current.focus({ preventScroll: true })
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', trapFocus)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', trapFocus)
      previousFocusRef.current?.focus({ preventScroll: true })
      previousFocusRef.current = null
    }
  }, [])

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (document.querySelector('[data-task-user-combobox-portal],[data-task-select-picker-portal],[data-task-property-picker-portal],[data-task-picker-backdrop]')) return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      if (mobileCommentsOpen) {
        setMobileCommentsOpen(false)
        return
      }
      closeViewer()
    }
    window.addEventListener('keydown', close, true)
    return () => window.removeEventListener('keydown', close, true)
  }, [closeViewer, mobileCommentsOpen])

  const placeAnchor = (event: React.MouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    setAnchor(normalizedAttachmentPoint(preview?.kind === 'image' ? 'image' : 'pdf', rect, event.clientX, event.clientY, page))
  }
  const retryPreview = async () => {
    if (retrying) return
    setRetrying(true)
    setError('')
    if (canRetryTaskAttachmentConversion(preview)) {
      const result = await apiPost<{ preview: TaskAttachmentPreview }>(`/api/tasks/${taskId}/attachments/${attachment.id}/preview/retry`, { operation_id: crypto.randomUUID() })
      if (identityRef.current !== `${taskId}:${attachment.id}`) return
      if (!result.success) {
        setRetrying(false)
        setPhase('error')
        setError(result.error || 'No se pudo reintentar la conversión.')
        return
      }
      if (result.data?.preview) setPreview(result.data.preview)
    }
    setRetrying(false)
    setReloadKey(value => value + 1)
  }
  const send = async () => {
    if (!body.trim()) return
    const commentAnchor = replyTo ? comments.find(comment => comment.id === replyTo)?.anchor : anchor
    if (!commentAnchor || !hasUsableAttachmentAnchor(commentAnchor)) {
      setCommentError('Selecciona primero un punto del documento para anclar el comentario.')
      return
    }
    const identity = identityRef.current
    setSaving(true)
    setCommentError('')
    const result = await apiPost<{ comment: TaskAttachmentComment }>(`/api/tasks/${taskId}/attachments/${attachment.id}/comments`, { body: body.trim(), parent_id: replyTo, anchor: commentAnchor, mentioned_user_ids: mentionIDs })
    if (identityRef.current !== identity) return
    setSaving(false)
    if (!result.success || !result.data?.comment) { setCommentError(result.error || 'No se pudo publicar el comentario'); return }
    setComments(current => [...current, result.data!.comment])
    setBody(''); setMentionIDs([]); setReplyTo(undefined)
  }
  const resolve = async (comment: TaskAttachmentComment) => {
    const identity = identityRef.current
    setCommentError('')
    const result = await apiPut<{ comment: TaskAttachmentComment }>(`/api/tasks/${taskId}/attachments/${attachment.id}/comments/${comment.id}/resolve`, { resolved: !comment.resolved_at, version: comment.version })
    if (identityRef.current !== identity) return
    if (result.success && result.data?.comment) setComments(current => current.map(item => item.id === comment.id ? result.data!.comment : item))
    else setCommentError(result.error || 'No se pudo actualizar el comentario.')
  }
  const roots = comments.filter(comment => !comment.parent_id)
  const pendingCommentAnchor = replyTo ? comments.find(comment => comment.id === replyTo)?.anchor : anchor
  const canPublishComment = Boolean(body.trim() && pendingCommentAnchor && hasUsableAttachmentAnchor(pendingCommentAnchor))
  const canPreview = preview?.status === 'ready' && ['image', 'pdf', 'word_pdf', 'text'].includes(preview.kind)
  const download = <a href={attachment.url} target="_blank" rel="noreferrer" className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-xs font-bold text-white hover:bg-white/10"><Download className="h-4 w-4" />Descargar original</a>

  return createPortal(<div data-task-attachment-viewer className="fixed inset-0 flex items-center justify-center bg-slate-950/70 p-2 backdrop-blur-[3px] sm:p-5" style={{ zIndex: TASK_OVERLAY_LAYERS.confirmation }} role="presentation">
    <section ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`Vista previa de ${attachment.filename}`} className={`${fullscreen ? 'h-full w-full' : 'h-[92vh] w-full max-w-7xl'} relative flex overflow-hidden rounded-3xl border border-white/10 bg-slate-950 shadow-2xl shadow-black/50 outline-none`}>
      {mobileCommentsOpen && <><button type="button" aria-label="Cerrar comentarios anclados" onClick={() => setMobileCommentsOpen(false)} className="absolute inset-0 z-30 bg-slate-950/65 backdrop-blur-sm md:hidden" /><aside data-task-attachment-mobile-comments className="absolute inset-y-0 right-0 z-40 flex w-[min(92vw,380px)] flex-col bg-white shadow-2xl md:hidden"><header className="flex items-start gap-3 border-b border-slate-200 px-4 py-4"><div className="min-w-0 flex-1"><h2 className="flex items-center gap-2 text-sm font-black text-slate-800"><MessageSquare className="h-4 w-4 text-emerald-600" />Comentarios anclados</h2><p className="mt-1 text-[10px] leading-4 text-slate-400">Selecciona un punto del archivo antes de publicar.</p></div><button type="button" onClick={() => setMobileCommentsOpen(false)} aria-label="Cerrar panel de comentarios" className="rounded-xl p-2 text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button></header><div className="min-h-0 flex-1 overflow-y-auto p-3">{roots.map(comment => <div key={comment.id} className={`mb-2 rounded-2xl border p-3 ${comment.resolved_at ? 'border-slate-200 bg-slate-50 opacity-70' : 'border-emerald-100 bg-emerald-50/40'}`}><div className="flex items-center gap-2"><span className="flex h-7 w-7 items-center justify-center rounded-full bg-white text-[9px] font-black text-slate-500">{comment.author_name.slice(0,2).toUpperCase()}</span><span className="min-w-0 flex-1 truncate text-xs font-bold text-slate-700">{comment.author_name}</span>{comment.can_resolve && <button type="button" onClick={() => void resolve(comment)} aria-label={comment.resolved_at ? 'Reabrir comentario' : 'Resolver comentario'} className="rounded-lg p-1.5 text-slate-400 hover:bg-white hover:text-emerald-600"><CheckCircle2 className="h-4 w-4" /></button>}</div><p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-slate-600">{comment.body}</p><button type="button" onClick={() => setReplyTo(comment.id)} className="mt-2 text-[10px] font-bold text-emerald-700">Responder</button>{comments.filter(reply => reply.parent_id === comment.id).map(reply => <div key={reply.id} className="mt-2 border-l-2 border-emerald-200 pl-2 text-[11px] text-slate-600"><strong>{reply.author_name}</strong><p>{reply.body}</p></div>)}</div>)}{!roots.length && <div className="py-14 text-center text-xs text-slate-400">Todavía no hay comentarios sobre este archivo.</div>}</div><div className="border-t border-slate-200 p-3">{replyTo && <button type="button" onClick={() => setReplyTo(undefined)} className="mb-2 rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-bold text-emerald-700">Respondiendo · cancelar</button>}<textarea value={body} onChange={event => setBody(event.target.value)} placeholder="Comenta sobre este punto…" className="min-h-20 w-full resize-none rounded-xl border border-slate-200 p-3 text-xs outline-none focus:border-emerald-300 focus:ring-4 focus:ring-emerald-50" /><p className={`mt-1 text-[10px] ${pendingCommentAnchor && hasUsableAttachmentAnchor(pendingCommentAnchor) ? 'text-emerald-600' : 'text-amber-600'}`}>{pendingCommentAnchor && hasUsableAttachmentAnchor(pendingCommentAnchor) ? 'Ancla lista para comentar.' : 'Selecciona un punto, página o fragmento de texto.'}</p><div className="mt-2 flex gap-2"><div className="min-w-0 flex-1"><TaskUserCombobox users={users} value="" excludeIds={mentionIDs} onChange={id => setMentionIDs(current => [...current, id])} placeholder="Mencionar…" className="!min-h-9 !py-1" /></div><button type="button" aria-label="Publicar comentario" disabled={!canPublishComment || saving} onClick={() => void send()} className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-600 text-white disabled:opacity-40">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}</button></div>{commentError && <p role="alert" className="mt-2 text-[10px] font-semibold text-rose-600">{commentError}</p>}</div></aside></>}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-14 items-center gap-2 border-b border-white/10 px-3 text-white sm:gap-3 sm:px-4"><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold">{attachment.filename}</p><p className="text-[10px] text-slate-400">{preview?.kind === 'word_pdf' ? 'Documento convertido de forma segura a PDF' : preview?.kind?.toUpperCase() || 'Preparando'}</p></div>{canPreview && <><button onClick={() => setZoom(value => Math.max(.5, value - .2))} className="hidden rounded-xl p-2 hover:bg-white/10 sm:block" aria-label="Alejar"><ZoomOut className="h-4 w-4" /></button><span className="hidden w-12 text-center text-[10px] font-bold text-slate-300 sm:block">{Math.round(zoom * 100)}%</span><button onClick={() => setZoom(value => Math.min(4, value + .2))} className="hidden rounded-xl p-2 hover:bg-white/10 sm:block" aria-label="Acercar"><ZoomIn className="h-4 w-4" /></button></>}<button type="button" onClick={() => setMobileCommentsOpen(true)} aria-label="Abrir comentarios anclados" aria-expanded={mobileCommentsOpen} className="relative rounded-xl p-2 hover:bg-white/10 md:hidden"><MessageSquare className="h-4 w-4" />{comments.length > 0 && <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-500 px-1 text-[8px] font-black text-slate-950">{comments.length}</span>}</button><a href={attachment.url} target="_blank" rel="noreferrer" className="rounded-xl p-2 hover:bg-white/10" aria-label="Descargar"><Download className="h-4 w-4" /></a><button onClick={() => setFullscreen(value => !value)} className="hidden rounded-xl p-2 hover:bg-white/10 sm:block" aria-label={fullscreen ? 'Restaurar tamaño' : 'Pantalla completa'}><Maximize2 className="h-4 w-4" /></button><button onClick={closeViewer} className="rounded-xl p-2 hover:bg-white/10" aria-label="Cerrar"><X className="h-5 w-5" /></button></header>
        <div className="relative min-h-0 flex-1 overflow-auto bg-slate-900 p-5">
          {!loading && slow && phase === 'converting' && <div role="status" className="absolute left-1/2 top-4 z-20 w-[min(92%,440px)] -translate-x-1/2 rounded-2xl border border-amber-300/20 bg-slate-950/95 p-3 text-center shadow-xl"><p className="text-xs leading-5 text-amber-100">La conversión está tardando más de lo habitual. Puedes seguir esperando o descargar el original.</p><div className="mt-2">{download}</div></div>}
          {loading && <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-900/90 px-6 text-center text-slate-300"><div><Loader2 className="mx-auto h-6 w-6 animate-spin text-emerald-400" /><p className="mt-3 text-sm font-bold">{taskAttachmentPreviewPhaseLabel(phase)}</p>{slow && <div className="mt-4 rounded-2xl border border-amber-300/20 bg-amber-300/10 p-4"><p className="max-w-sm text-xs leading-5 text-amber-100">Está tardando más de lo habitual. Puedes seguir esperando o descargar el original.</p><div className="mt-3">{download}</div></div>}</div></div>}
          {!loading && phase === 'converting' && <div className="flex h-full items-center justify-center text-center text-slate-300"><div><Loader2 className="mx-auto h-8 w-8 animate-spin text-emerald-400" /><p className="mt-3 font-bold">Convirtiendo documento</p><p className="mt-1 max-w-md text-xs leading-5 text-slate-500">El worker aislado está generando un PDF. Consultaremos el estado automáticamente mientras esta ventana permanezca abierta.</p><div className="mt-4 flex justify-center gap-2"><button onClick={() => setReloadKey(value => value + 1)} className="inline-flex items-center gap-2 rounded-xl bg-white/10 px-4 py-2 text-xs font-bold hover:bg-white/15"><RotateCcw className="h-3.5 w-3.5" />Actualizar ahora</button>{download}</div></div></div>}
          {!loading && phase === 'unsupported' && <div className="flex h-full items-center justify-center text-center text-slate-300"><div><p className="font-bold">Este formato no tiene vista previa</p><p className="mt-1 text-xs text-slate-500">Los metadatos y la descarga continúan disponibles.</p><div className="mt-4">{download}</div></div></div>}
          {!loading && phase === 'error' && <div role="alert" className="flex h-full items-center justify-center px-6 text-center text-slate-300"><div className="max-w-md"><AlertCircle className="mx-auto h-9 w-9 text-rose-400" /><p className="mt-3 font-bold text-white">No pudimos abrir la vista previa</p><p className="mt-2 text-xs leading-5 text-slate-400">{error}</p><div className="mt-5 flex flex-wrap justify-center gap-2"><button disabled={retrying} onClick={() => void retryPreview()} className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2 text-xs font-black text-slate-950 hover:bg-emerald-400 disabled:opacity-50">{retrying ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}{canRetryTaskAttachmentConversion(preview) ? 'Reintentar conversión' : 'Reintentar'}</button>{download}</div></div></div>}
          {objectURL && preview?.kind === 'image' && phase === 'ready' && <div className="relative mx-auto w-fit" onClick={placeAnchor}><img src={objectURL} alt={attachment.filename} style={{ transform: `scale(${zoom})`, transformOrigin: 'top center' }} className="max-w-full rounded-lg shadow-2xl" />{anchor.kind === 'image' && anchor.x !== undefined && <span className="pointer-events-none absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-4 border-white bg-emerald-500 shadow-lg" style={{ left: `${anchor.x * 100}%`, top: `${(anchor.y || 0) * 100}%` }} />}</div>}
          {pdf && phase !== 'error' && <div className="relative mx-auto w-fit rounded-lg bg-white shadow-2xl" onClick={placeAnchor}><canvas ref={canvasRef} className="max-w-full" />{anchor.kind === 'pdf' && anchor.page === page && anchor.x !== undefined && <span className="pointer-events-none absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-4 border-white bg-emerald-500 shadow-lg" style={{ left: `${anchor.x * 100}%`, top: `${(anchor.y || 0) * 100}%` }} />}</div>}
          {preview?.kind === 'text' && phase === 'ready' && <pre onMouseUp={() => { const selection = window.getSelection(); setAnchor(textAttachmentAnchor(text, selection?.anchorOffset || 0, selection?.toString() || '')) }} className="mx-auto min-h-full max-w-5xl whitespace-pre-wrap rounded-2xl bg-white p-6 font-mono text-sm leading-6 text-slate-800 shadow-2xl">{text}</pre>}
        </div>
        {pdf && phase !== 'error' && <footer className="flex h-12 items-center justify-center gap-3 border-t border-white/10 text-white"><button type="button" aria-label="Página anterior" disabled={page <= 1} onClick={() => setPage(value => value - 1)} className="rounded-lg p-2 disabled:opacity-30"><ChevronLeft className="h-4 w-4" /></button><span className="text-xs font-bold">Página {page} de {preview?.page_count || pdf.numPages}</span><button type="button" aria-label="Página siguiente" disabled={page >= (preview?.page_count || pdf.numPages)} onClick={() => setPage(value => value + 1)} className="rounded-lg p-2 disabled:opacity-30"><ChevronRight className="h-4 w-4" /></button></footer>}
      </div>
      <aside className="flex w-[340px] shrink-0 flex-col border-l border-slate-200 bg-white max-lg:w-[300px] max-md:hidden"><header className="border-b border-slate-200 px-4 py-4"><h2 className="flex items-center gap-2 text-sm font-black text-slate-800"><MessageSquare className="h-4 w-4 text-emerald-600" />Comentarios anclados</h2><p className="mt-1 text-[10px] text-slate-400">Haz clic en el documento para fijar el comentario.</p></header><div className="min-h-0 flex-1 overflow-y-auto p-3">{roots.map(comment => <div key={comment.id} className={`mb-2 rounded-2xl border p-3 ${comment.resolved_at ? 'border-slate-200 bg-slate-50 opacity-70' : 'border-emerald-100 bg-emerald-50/40'}`}><div className="flex items-center gap-2"><span className="flex h-7 w-7 items-center justify-center rounded-full bg-white text-[9px] font-black text-slate-500">{comment.author_name.slice(0,2).toUpperCase()}</span><span className="min-w-0 flex-1 truncate text-xs font-bold text-slate-700">{comment.author_name}</span>{comment.can_resolve && <button onClick={() => void resolve(comment)} title={comment.resolved_at ? 'Reabrir' : 'Resolver'} className="rounded-lg p-1.5 text-slate-400 hover:bg-white hover:text-emerald-600"><CheckCircle2 className="h-4 w-4" /></button>}</div><p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-slate-600">{comment.body}</p><button onClick={() => setReplyTo(comment.id)} className="mt-2 text-[10px] font-bold text-emerald-700">Responder</button>{comments.filter(reply => reply.parent_id === comment.id).map(reply => <div key={reply.id} className="mt-2 border-l-2 border-emerald-200 pl-2 text-[11px] text-slate-600"><strong>{reply.author_name}</strong><p>{reply.body}</p></div>)}</div>)}{!roots.length && <div className="py-14 text-center text-xs text-slate-400">Todavía no hay comentarios sobre este archivo.</div>}</div><div className="border-t border-slate-200 p-3">{replyTo && <button onClick={() => setReplyTo(undefined)} className="mb-2 rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-bold text-emerald-700">Respondiendo · cancelar</button>}<textarea value={body} onChange={event => setBody(event.target.value)} placeholder="Comenta sobre este punto…" className="min-h-20 w-full resize-none rounded-xl border border-slate-200 p-3 text-xs outline-none focus:border-emerald-300 focus:ring-4 focus:ring-emerald-50" /><p className={`mt-1 text-[10px] ${pendingCommentAnchor && hasUsableAttachmentAnchor(pendingCommentAnchor) ? 'text-emerald-600' : 'text-amber-600'}`}>{pendingCommentAnchor && hasUsableAttachmentAnchor(pendingCommentAnchor) ? 'Ancla lista para comentar.' : 'Selecciona un punto, página o fragmento de texto.'}</p><div className="mt-2 flex gap-2"><div className="min-w-0 flex-1"><TaskUserCombobox users={users} value="" excludeIds={mentionIDs} onChange={id => setMentionIDs(current => [...current, id])} placeholder="Mencionar…" className="!min-h-9 !py-1" /></div><button type="button" aria-label="Publicar comentario" disabled={!canPublishComment || saving} onClick={() => void send()} className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-600 text-white disabled:opacity-40">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}</button></div>{commentError && <p role="alert" className="mt-2 text-[10px] font-semibold text-rose-600">{commentError}</p>}</div></aside>
    </section>
  </div>, document.body)
}
