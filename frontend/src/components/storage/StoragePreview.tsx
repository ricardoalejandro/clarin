'use client'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { AudioLines, Download, ExternalLink, FileText, ImageIcon, Loader2, ShieldCheck, Video } from 'lucide-react'
import { api, apiBlob } from '@/lib/api'
import { getAuthScope } from '@/lib/authScope'
import ChatDocumentViewer from '@/components/chat/ChatDocumentViewer'
import { StorageDialog } from './StorageDialog'
import { StorageReadQueue } from './storageReadQueue'
import { formatStorageBytes, PREVIEW_MAX_BYTES, PREVIEW_TIMEOUT_MS, safeStorageOriginHref, STORAGE_READ_TIMEOUT_MS, storageContentPath, storageUnavailableMessage, THUMBNAIL_MAX_BYTES, type StorageFile } from './storageModel'

const thumbnailQueues = new Map<string, { active: number; pending: Set<() => void> }>()

/** Scope-local permits contain no media data and are removed when their last request ends. */
function reserveThumbnail(scope: string, signal: AbortSignal): Promise<(() => void) | null> {
  if (signal.aborted) return Promise.resolve(null)
  let queue = thumbnailQueues.get(scope)
  if (!queue) { queue = { active: 0, pending: new Set() }; thumbnailQueues.set(scope, queue) }
  const session = queue
  return new Promise(resolve => {
    let active = false
    let released = false
    const release = () => {
      if (released) return
      released = true
      signal.removeEventListener('abort', release)
      if (active) session.active--
      else { session.pending.delete(start); resolve(null) }
      while (session.active < 4 && session.pending.size) session.pending.values().next().value?.()
      if (!session.active && !session.pending.size && thumbnailQueues.get(scope) === session) thumbnailQueues.delete(scope)
    }
    const start = () => {
      session.pending.delete(start)
      active = true
      session.active++
      resolve(release)
    }
    signal.addEventListener('abort', release, { once: true })
    if (session.active < 4) start()
    else session.pending.add(start)
  })
}

export function MediaIcon({ type, className = 'h-5 w-5' }: { type: string; className?: string }) {
  const Icon = type === 'image' ? ImageIcon : type === 'video' ? Video : type === 'audio' ? AudioLines : FileText
  return <Icon className={className} aria-hidden="true" />
}

/** No raw/public media URL is rendered. Each small image owns a cancellable authenticated request. */
export function StorageThumbnail({ file, scope }: { file: StorageFile; scope: string }) {
  const host = useRef<HTMLSpanElement>(null)
  const [url, setUrl] = useState('')
  useEffect(() => {
    setUrl('')
    if (file.media_type !== 'image' || file.size_bytes > THUMBNAIL_MAX_BYTES || file.status === 'trash') return
    const controller = new AbortController(); let objectURL = ''; let started = false; let timeout: number | undefined
    const load = async () => {
      if (started) return
      started = true
      const release = await reserveThumbnail(scope, controller.signal)
      if (!release) return
      if (controller.signal.aborted || getAuthScope() !== scope) { release(); return }
      timeout = window.setTimeout(() => controller.abort(), STORAGE_READ_TIMEOUT_MS)
      try {
        const result = await apiBlob(storageContentPath(file), { signal: controller.signal })
        if (controller.signal.aborted || getAuthScope() !== scope || !result.success || !result.blob || !/^image\/(jpeg|png|webp|gif|avif)$/.test(result.blob.type)) return
        objectURL = URL.createObjectURL(result.blob); setUrl(objectURL)
      } catch { /* The media icon remains available when a thumbnail cannot load. */ }
      finally { window.clearTimeout(timeout); release() }
    }
    const observer = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { void load(); observer?.disconnect() } }, { rootMargin: '100px' }) : null
    if (observer && host.current) observer.observe(host.current)
    else void load()
    return () => { observer?.disconnect(); window.clearTimeout(timeout); controller.abort(); if (objectURL) URL.revokeObjectURL(objectURL) }
  }, [file.object_key, file.media_type, file.size_bytes, file.status, scope])
  return <span ref={host} className="flex h-full w-full items-center justify-center overflow-hidden rounded-xl bg-slate-100 text-slate-500">{url ? <img src={url} alt="" className="h-full w-full object-cover" loading="lazy" /> : <MediaIcon type={file.media_type} className="h-7 w-7" />}</span>
}

export function StoragePreview({ file, scope, onClose, refresh = 0, onUnavailable }: { file: StorageFile; scope: string; onClose: () => void; refresh?: number; onUnavailable?: (message?: string) => void }) {
  const streaming = file.media_type === 'video' || file.media_type === 'audio'
  const [validatedRefresh, setValidatedRefresh] = useState(streaming ? -1 : refresh)
  const [mediaAccessReady, setMediaAccessReady] = useState(false)
  const [accessError, setAccessError] = useState('')
  const [accessRetry, setAccessRetry] = useState(0)
  const firstValidation = useRef(true)
  const validation = useRef<{ invalidate: (revision: number) => void; dispose: () => void } | null>(null)
  const unavailable = useRef(onUnavailable || onClose)
  unavailable.current = onUnavailable || onClose
  const [revoked, setRevoked] = useState(false)
  const authorized = validatedRefresh === refresh && !accessError && !revoked
  const authorizedRef = useRef(authorized)
  authorizedRef.current = authorized
  const mediaRef = useRef<HTMLMediaElement | null>(null)
  const resumePlayback = useRef(false)
  const validationCloseRef = useRef<HTMLButtonElement>(null)
  const [url, setUrl] = useState('')
  const [mime, setMime] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [downloading, setDownloading] = useState(false)
  const downloadRequest = useRef<AbortController | null>(null)
  const [pdfOpen, setPdfOpen] = useState(false)
  const pdfButtonRef = useRef<HTMLButtonElement>(null)
  const isPDF = file.media_type === 'document' && /\.pdf$/i.test(file.filename)
  const safeInline = file.media_type !== 'document'
  const autoLoad = streaming || (safeInline && file.size_bytes <= PREVIEW_MAX_BYTES)
  useEffect(() => {
    const queue = new StorageReadQueue(refresh, {
      timeoutMs: PREVIEW_TIMEOUT_MS,
      read: signal => api(storageContentPath(file), { method: 'HEAD', signal }),
      onStart: () => { setValidatedRefresh(-1); setAccessError(''); validationCloseRef.current?.focus({ preventScroll: true }) },
      onResult: (response, revision) => {
        if (getAuthScope() !== scope) return false
        if ([401, 403, 404].includes(response.status || 0)) { setRevoked(true); setPdfOpen(false); unavailable.current(storageUnavailableMessage(response.status)); return false }
        if (!response.success) { setAccessError(response.error || 'No se pudo verificar tu acceso a este archivo.'); return false }
        if (streaming) setMediaAccessReady(true); setValidatedRefresh(revision)
        return true
      },
      onError: reason => { if (getAuthScope() === scope) setAccessError(reason === 'timeout' ? 'No se pudo verificar tu acceso a este archivo. Vuelve a intentarlo.' : 'No se pudo verificar tu acceso a este archivo. Revisa tu conexión.') },
      onSettled: () => {},
    })
    validation.current = queue
    if (firstValidation.current) { firstValidation.current = false; if (streaming) queue.start() }
    else queue.start()
    return () => { queue.dispose(); if (validation.current === queue) validation.current = null }
  }, [accessRetry, scope, file.object_key, streaming])
  useEffect(() => { validation.current?.invalidate(refresh) }, [refresh])

  useEffect(() => {
    setUrl(''); setMime(''); setError(''); setBusy(false)
    if (revoked || !autoLoad) return
    // Native media requests only the ranges it needs. The HEAD check refreshes
    // the authenticated cookie before exposing a source to the media element.
    if (streaming) { if (mediaAccessReady) { setUrl(storageContentPath(file)); setMime(`${file.media_type}/stream`) }; return }
    const controller = new AbortController(); let objectURL = ''; let timedOut = false
    setBusy(true)
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); setBusy(false); setError('La descarga está tardando demasiado. Revisa tu conexión y vuelve a intentarlo.') }, PREVIEW_TIMEOUT_MS)
    void apiBlob(storageContentPath(file), { signal: controller.signal }).then(result => {
      if (controller.signal.aborted || getAuthScope() !== scope) return
      if ([401, 403, 404].includes(result.status || 0)) { setRevoked(true); setPdfOpen(false); unavailable.current(storageUnavailableMessage(result.status)); return }
      if (!result.success || !result.blob) { setError(result.error || 'No se pudo abrir el archivo.'); return }
      objectURL = URL.createObjectURL(result.blob); setUrl(objectURL); setMime(result.blob.type)
    }).catch(() => { if (!controller.signal.aborted && getAuthScope() === scope) setError('No se pudo abrir el archivo. Inténtalo de nuevo.') }).finally(() => { window.clearTimeout(timeout); if (!controller.signal.aborted && getAuthScope() === scope && !timedOut) setBusy(false) })
    return () => { window.clearTimeout(timeout); controller.abort(); if (objectURL) URL.revokeObjectURL(objectURL) }
  }, [file.object_key, file.filename, file.media_type, autoLoad, retry, scope, revoked, streaming, mediaAccessReady])
  useEffect(() => {
    const media = mediaRef.current
    if (!media) return
    if (!authorized) {
      if (!media.paused) { resumePlayback.current = true; media.pause() }
    } else if (resumePlayback.current && getAuthScope() === scope) {
      resumePlayback.current = false
      void media.play().catch(() => { /* The browser can require another user gesture. */ })
    }
  }, [authorized, scope, url])

  useEffect(() => {
    const media = mediaRef.current
    return () => {
      downloadRequest.current?.abort()
      if (media) { media.pause(); media.removeAttribute('src'); media.load() }
    }
  }, [url, error])

  const download = async () => {
    if (getAuthScope() !== scope || !authorized || downloadRequest.current) return
    const controller = new AbortController()
    downloadRequest.current = controller; setDownloading(true)
    const timer = window.setTimeout(() => { controller.abort(); if (downloadRequest.current === controller) { downloadRequest.current = null; setDownloading(false); setError('La descarga está tardando demasiado. Vuelve a intentarlo.') } }, STORAGE_READ_TIMEOUT_MS)
    try {
      const result = await api(storageContentPath(file), { method: 'HEAD', signal: controller.signal })
      if (controller.signal.aborted || getAuthScope() !== scope || !authorizedRef.current) return
      if ([401, 403, 404].includes(result.status || 0)) { setRevoked(true); setPdfOpen(false); unavailable.current(storageUnavailableMessage(result.status)); return }
      if (!result.success) { setError(result.error || 'No se pudo descargar el archivo. Vuelve a intentarlo.'); return }
      const link = document.createElement('a')
      link.href = `${storageContentPath(file)}&download=1`; link.download = file.filename
      link.click()
    } catch { if (!controller.signal.aborted && getAuthScope() === scope) setError('No se pudo descargar el archivo. Revisa tu conexión.') }
    finally { window.clearTimeout(timer); if (downloadRequest.current === controller) { downloadRequest.current = null; if (getAuthScope() === scope) setDownloading(false) } }
  }
  const mediaError = () => {
    if (getAuthScope() !== scope || !authorizedRef.current) return
    const code = mediaRef.current?.error?.code
    setError(code === 3 || code === 4 ? 'Tu navegador no puede reproducir este formato. Puedes descargar el original.' : 'Se interrumpió la reproducción. Revisa tu conexión e inténtalo de nuevo.')
  }
  const canRender = (file.media_type === 'image' && /^image\/(jpeg|png|webp|gif|avif)$/.test(mime)) || (file.media_type === 'video' && mime.startsWith('video/')) || (file.media_type === 'audio' && mime.startsWith('audio/')) || (file.media_type === 'document' && mime === 'application/pdf')
  const validationContent = accessError ? <div role="alert"><p className="text-sm text-rose-700">{accessError}</p><button onClick={() => { setValidatedRefresh(-1); setAccessRetry(value => value + 1) }} className="mt-3 min-h-11 rounded-xl border border-slate-200 px-4 text-sm">Reintentar verificación</button></div> : <p role="status" className="flex items-center gap-2 py-8 text-sm text-slate-600"><Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" />Comprobando acceso…</p>
  return <>
    {pdfOpen && <ChatDocumentViewer document={{ sessionId: `${scope}:${file.object_key}`, src: storageContentPath(file), filename: file.filename, mimeType: 'application/pdf', size: file.size_bytes }} suspended={!authorized} onClose={() => setPdfOpen(false)} />}
    {pdfOpen && !authorized && <StorageDialog title="Verificar acceso al archivo" description="El almacenamiento cambió. Estamos comprobando que el archivo siga disponible." onClose={onClose}>{validationContent}</StorageDialog>}
    {!pdfOpen && <StorageDialog title={authorized ? file.filename || 'Archivo' : 'Verificar acceso al archivo'} description={authorized ? formatStorageBytes(file.size_bytes) : 'El almacenamiento cambió. Estamos comprobando que el archivo siga disponible.'} onClose={onClose} wide initialFocusRef={!authorized ? validationCloseRef : isPDF ? pdfButtonRef : undefined} footer={<><button ref={validationCloseRef} onClick={onClose} className="min-h-11 rounded-xl border border-slate-200 px-4 text-sm font-medium text-slate-700 hover:bg-slate-100">Cerrar</button><button onClick={() => void download()} disabled={downloading || !authorized} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"><Download className="h-4 w-4" />{downloading ? 'Preparando…' : 'Descargar'}</button></>}>
    {!authorized && validationContent}
    <div hidden={!authorized} inert={!authorized}>
    <div className="flex min-h-48 items-center justify-center rounded-2xl bg-slate-100 p-3 sm:min-h-64">
      {busy ? <div role="status" className="py-10 text-center text-sm text-slate-600"><Loader2 className="mx-auto mb-3 h-6 w-6 animate-spin motion-reduce:animate-none" />Abriendo archivo…</div> : error ? <div role="alert" className="max-w-md py-8 text-center"><p className="text-sm text-rose-700">{error}</p><button onClick={() => { if (streaming) { setMediaAccessReady(false); setValidatedRefresh(-1); setAccessRetry(value => value + 1) }; setRetry(value => value + 1) }} className="mt-3 min-h-11 rounded-xl border border-slate-300 bg-white px-4 text-sm">Reintentar</button></div> : url && canRender && safeInline && autoLoad ? file.media_type === 'image' ? <img src={url} alt={file.filename} className="max-h-[55dvh] max-w-full object-contain" /> : file.media_type === 'video' ? <video ref={mediaRef as RefObject<HTMLVideoElement>} src={url} preload="metadata" onError={mediaError} controls className="max-h-[55dvh] max-w-full" /> : file.media_type === 'audio' ? <audio ref={mediaRef as RefObject<HTMLAudioElement>} src={url} preload="metadata" onError={mediaError} controls className="w-full max-w-lg" /> : null : <div className="max-w-sm py-8 text-center"><MediaIcon type={file.media_type} className="mx-auto mb-3 h-10 w-10 text-slate-400" /><p className="text-sm font-medium text-slate-700">{file.size_bytes > PREVIEW_MAX_BYTES ? 'Este archivo es grande' : isPDF ? 'Documento PDF' : 'Descarga el archivo para abrirlo'}</p><p className="mt-2 text-sm text-slate-500">{file.size_bytes > PREVIEW_MAX_BYTES ? 'Puedes descargarlo para verlo en tu dispositivo.' : isPDF ? 'Consulta sus páginas sin salir de Clarin.' : 'El contenido se conserva en su formato original.'}</p>{isPDF && file.size_bytes <= PREVIEW_MAX_BYTES && <button ref={pdfButtonRef} onClick={() => { setPdfOpen(true) }} className="mt-4 min-h-11 rounded-xl bg-emerald-600 px-4 text-sm font-medium text-white hover:bg-emerald-700">Abrir vista previa</button>}</div>}
    </div>
    <section className="mt-5"><h3 className="text-sm font-semibold text-slate-900">Dónde se usa</h3><div className="mt-2 flex flex-wrap gap-2">{file.origins?.length ? file.origins.map((origin, index) => { const href = safeStorageOriginHref(origin.href); return href ? <a key={`${origin.type}-${index}`} href={href} className="inline-flex min-h-11 max-w-full items-center gap-2 rounded-xl border border-slate-200 px-3 text-sm text-slate-700 hover:bg-slate-50"><span className="break-words">{origin.label}</span><ExternalLink className="h-3.5 w-3.5 shrink-0" /></a> : <span key={`${origin.type}-${index}`} className="inline-flex min-h-11 items-center rounded-xl bg-slate-100 px-3 text-sm text-slate-600">{origin.label}</span> }) : <p className="text-sm text-slate-500">No hay ubicaciones disponibles para mostrar.</p>}</div>{file.blocked_reason && <p className="mt-3 flex items-start gap-2 rounded-xl bg-slate-50 p-3 text-sm text-slate-600"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />{file.blocked_reason}</p>}</section>
    </div>
  </StorageDialog>}
  </>
}
