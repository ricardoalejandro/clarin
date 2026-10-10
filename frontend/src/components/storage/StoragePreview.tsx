'use client'
import { useEffect, useRef, useState } from 'react'
import { AudioLines, Download, ExternalLink, FileText, ImageIcon, Loader2, ShieldCheck, Video } from 'lucide-react'
import { apiBlob } from '@/lib/api'
import { getAuthScope } from '@/lib/authScope'
import ChatDocumentViewer from '@/components/chat/ChatDocumentViewer'
import { StorageDialog } from './StorageDialog'
import { formatStorageBytes, PREVIEW_MAX_BYTES, PREVIEW_TIMEOUT_MS, safeStorageOriginHref, storageContentPath, THUMBNAIL_MAX_BYTES, type StorageFile } from './storageModel'

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
    const controller = new AbortController(); let objectURL = ''; let started = false
    const load = async () => {
      if (started) return
      started = true
      const result = await apiBlob(storageContentPath(file), { signal: controller.signal })
      if (controller.signal.aborted || getAuthScope() !== scope || !result.success || !result.blob || !/^image\/(jpeg|png|webp|gif|avif)$/.test(result.blob.type)) return
      objectURL = URL.createObjectURL(result.blob); setUrl(objectURL)
    }
    const observer = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { void load(); observer?.disconnect() } }, { rootMargin: '100px' }) : null
    if (observer && host.current) observer.observe(host.current)
    else void load()
    return () => { observer?.disconnect(); controller.abort(); if (objectURL) URL.revokeObjectURL(objectURL) }
  }, [file.object_key, file.media_type, file.size_bytes, file.status, scope])
  return <span ref={host} className="flex h-full w-full items-center justify-center overflow-hidden rounded-xl bg-slate-100 text-slate-500">{url ? <img src={url} alt="" className="h-full w-full object-cover" loading="lazy" /> : <MediaIcon type={file.media_type} className="h-7 w-7" />}</span>
}

export function StoragePreview({ file, scope, onClose }: { file: StorageFile; scope: string; onClose: () => void }) {
  const [url, setUrl] = useState('')
  const [mime, setMime] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [downloadRequested, setDownloadRequested] = useState(false)
  const [pdfOpen, setPdfOpen] = useState(false)
  const pdfButtonRef = useRef<HTMLButtonElement>(null)
  const isPDF = file.media_type === 'document' && /\.pdf$/i.test(file.filename)
  const safeInline = file.media_type !== 'document'
  const autoLoad = safeInline && file.size_bytes <= PREVIEW_MAX_BYTES
  useEffect(() => {
    setUrl(''); setMime(''); setError('')
    if (!autoLoad && !downloadRequested) return
    const controller = new AbortController(); let objectURL = ''; let timedOut = false
    setBusy(true)
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); setBusy(false); setError('La descarga está tardando demasiado. Revisa tu conexión y vuelve a intentarlo.') }, PREVIEW_TIMEOUT_MS)
    void apiBlob(storageContentPath(file), { signal: controller.signal }).then(result => {
      if (controller.signal.aborted || getAuthScope() !== scope) return
      if (!result.success || !result.blob) { setError(result.error || 'No se pudo abrir el archivo.'); return }
      objectURL = URL.createObjectURL(result.blob); setUrl(objectURL); setMime(result.blob.type)
      if (downloadRequested) { const link = document.createElement('a'); link.href = objectURL; link.download = file.filename; link.click() }
    }).catch(() => { if (!controller.signal.aborted && getAuthScope() === scope) setError('No se pudo abrir el archivo. Inténtalo de nuevo.') }).finally(() => { window.clearTimeout(timeout); if (!controller.signal.aborted && getAuthScope() === scope && !timedOut) setBusy(false) })
    return () => { window.clearTimeout(timeout); controller.abort(); if (objectURL) URL.revokeObjectURL(objectURL) }
  }, [file.object_key, file.filename, autoLoad, downloadRequested, retry, scope])
  const download = () => {
    if (getAuthScope() !== scope) return
    if (url) { const link = document.createElement('a'); link.href = url; link.download = file.filename; link.click() }
    else { setDownloadRequested(true); setRetry(value => value + 1) }
  }
  const canRender = (file.media_type === 'image' && /^image\/(jpeg|png|webp|gif|avif)$/.test(mime)) || (file.media_type === 'video' && mime.startsWith('video/')) || (file.media_type === 'audio' && mime.startsWith('audio/')) || (file.media_type === 'document' && mime === 'application/pdf')
  if (pdfOpen) return <ChatDocumentViewer document={{ sessionId: `${scope}:${file.object_key}`, src: storageContentPath(file), filename: file.filename, mimeType: 'application/pdf', size: file.size_bytes }} onClose={() => setPdfOpen(false)} />
  return <StorageDialog title={file.filename || 'Archivo'} description={formatStorageBytes(file.size_bytes)} onClose={onClose} wide initialFocusRef={isPDF ? pdfButtonRef : undefined} footer={<><button onClick={onClose} className="min-h-11 rounded-xl border border-slate-200 px-4 text-sm font-medium text-slate-700 hover:bg-slate-100">Cerrar</button><button onClick={download} disabled={busy} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"><Download className="h-4 w-4" />Descargar</button></>}>
    <div className="flex min-h-48 items-center justify-center rounded-2xl bg-slate-100 p-3 sm:min-h-64">
      {busy ? <div role="status" className="py-10 text-center text-sm text-slate-600"><Loader2 className="mx-auto mb-3 h-6 w-6 animate-spin motion-reduce:animate-none" />Abriendo archivo…</div> : error ? <div role="alert" className="max-w-md py-8 text-center"><p className="text-sm text-rose-700">{error}</p><button onClick={() => setRetry(value => value + 1)} className="mt-3 min-h-11 rounded-xl border border-slate-300 bg-white px-4 text-sm">Reintentar</button></div> : url && canRender && safeInline && autoLoad ? file.media_type === 'image' ? <img src={url} alt={file.filename} className="max-h-[55dvh] max-w-full object-contain" /> : file.media_type === 'video' ? <video src={url} controls className="max-h-[55dvh] max-w-full" /> : file.media_type === 'audio' ? <audio src={url} controls className="w-full max-w-lg" /> : null : <div className="max-w-sm py-8 text-center"><MediaIcon type={file.media_type} className="mx-auto mb-3 h-10 w-10 text-slate-400" /><p className="text-sm font-medium text-slate-700">{file.size_bytes > PREVIEW_MAX_BYTES ? 'Este archivo es grande' : isPDF ? 'Documento PDF' : 'Descarga el archivo para abrirlo'}</p><p className="mt-2 text-sm text-slate-500">{file.size_bytes > PREVIEW_MAX_BYTES ? 'Puedes descargarlo para verlo en tu dispositivo.' : isPDF ? 'Consulta sus páginas sin salir de Clarin.' : 'El contenido se conserva en su formato original.'}</p>{isPDF && file.size_bytes <= PREVIEW_MAX_BYTES && <button ref={pdfButtonRef} onClick={() => { setDownloadRequested(false); setPdfOpen(true) }} className="mt-4 min-h-11 rounded-xl bg-emerald-600 px-4 text-sm font-medium text-white hover:bg-emerald-700">Abrir vista previa</button>}</div>}
    </div>
    <section className="mt-5"><h3 className="text-sm font-semibold text-slate-900">Dónde se usa</h3><div className="mt-2 flex flex-wrap gap-2">{file.origins?.length ? file.origins.map((origin, index) => { const href = safeStorageOriginHref(origin.href); return href ? <a key={`${origin.type}-${index}`} href={href} className="inline-flex min-h-11 max-w-full items-center gap-2 rounded-xl border border-slate-200 px-3 text-sm text-slate-700 hover:bg-slate-50"><span className="break-words">{origin.label}</span><ExternalLink className="h-3.5 w-3.5 shrink-0" /></a> : <span key={`${origin.type}-${index}`} className="inline-flex min-h-11 items-center rounded-xl bg-slate-100 px-3 text-sm text-slate-600">{origin.label}</span> }) : <p className="text-sm text-slate-500">No hay ubicaciones disponibles para mostrar.</p>}</div>{file.blocked_reason && <p className="mt-3 flex items-start gap-2 rounded-xl bg-slate-50 p-3 text-sm text-slate-600"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />{file.blocked_reason}</p>}</section>
  </StorageDialog>
}
