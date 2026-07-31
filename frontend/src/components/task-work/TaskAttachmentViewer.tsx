'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, ChevronLeft, ChevronRight, Download, Loader2, Maximize2, MessageSquare, RotateCcw, Send, X, ZoomIn, ZoomOut } from 'lucide-react'
import { apiBlob, apiGet, apiPost, apiPut } from '@/lib/api'
import type { TaskAttachment, TaskAttachmentAnchor, TaskAttachmentComment, TaskAttachmentPreview } from '@/types/task'
import type { TaskAccountUser } from './TaskEditorModal'
import TaskUserCombobox from './TaskUserCombobox'
import { TASK_OVERLAY_LAYERS } from './taskOverlayLayers'
import { normalizedAttachmentPoint, textAttachmentAnchor } from './taskAttachmentAnchors'

interface Props {
  taskId: string
  attachment: TaskAttachment
  users: TaskAccountUser[]
  onClose: () => void
}

export default function TaskAttachmentViewer({ taskId, attachment, users, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [preview, setPreview] = useState<TaskAttachmentPreview | null>(attachment.preview || null)
  const [comments, setComments] = useState<TaskAttachmentComment[]>([])
  const [objectURL, setObjectURL] = useState('')
  const [text, setText] = useState('')
  const [pdf, setPdf] = useState<any>(null)
  const [page, setPage] = useState(1)
  const [zoom, setZoom] = useState(1)
  const [fullscreen, setFullscreen] = useState(false)
  const [anchor, setAnchor] = useState<TaskAttachmentAnchor>({ kind: 'image' })
  const [body, setBody] = useState('')
  const [mentionIDs, setMentionIDs] = useState<string[]>([])
  const [replyTo, setReplyTo] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    const [previewResult, commentsResult] = await Promise.all([
      apiGet<{ preview: TaskAttachmentPreview }>(`/api/tasks/${taskId}/attachments/${attachment.id}/preview`),
      apiGet<{ comments: TaskAttachmentComment[] }>(`/api/tasks/${taskId}/attachments/${attachment.id}/comments`),
    ])
    if (!previewResult.success || !previewResult.data?.preview) {
      setError(previewResult.error || 'No se pudo preparar la vista previa')
      setLoading(false)
      return
    }
    const nextPreview = previewResult.data.preview
    setPreview(nextPreview)
    setComments(commentsResult.data?.comments || [])
    if (nextPreview.status === 'ready' && nextPreview.url) {
      const blobResult = await apiBlob(nextPreview.url)
      if (blobResult.success && blobResult.blob) {
        const url = URL.createObjectURL(blobResult.blob)
        setObjectURL(current => { if (current) URL.revokeObjectURL(current); return url })
        if (nextPreview.kind === 'text') setText(await blobResult.blob.text())
        if (nextPreview.kind === 'pdf' || nextPreview.kind === 'word_pdf') {
          const pdfjs = await import('pdfjs-dist')
          // The authenticated preview is already loaded as an ArrayBuffer. Running the
          // parser in-process avoids a second, unauthenticated worker request and keeps
          // the production bundle independent from a public PDF.js worker asset.
          const document = await pdfjs.getDocument({
            data: await blobResult.blob.arrayBuffer(),
            disableWorker: true,
          } as any).promise
          setPdf(document)
          setPreview(current => current ? { ...current, page_count: document.numPages } : current)
        }
      } else setError(blobResult.error || 'No se pudo abrir el archivo')
    }
    setLoading(false)
  }, [attachment.id, taskId])

  useEffect(() => { void load() }, [load])
  useEffect(() => () => { if (objectURL) URL.revokeObjectURL(objectURL) }, [objectURL])
  useEffect(() => {
    if (!pdf || !canvasRef.current) return
    let cancelled = false
    void pdf.getPage(page).then((pdfPage: any) => {
      if (cancelled || !canvasRef.current) return
      const viewport = pdfPage.getViewport({ scale: zoom * 1.25 })
      const canvas = canvasRef.current
      const context = canvas.getContext('2d')!
      canvas.width = viewport.width
      canvas.height = viewport.height
      void pdfPage.render({ canvasContext: context, viewport }).promise
    })
    return () => { cancelled = true }
  }, [page, pdf, zoom])
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [onClose])

  const placeAnchor = (event: React.MouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    setAnchor(normalizedAttachmentPoint(preview?.kind === 'image' ? 'image' : 'pdf', rect, event.clientX, event.clientY, page))
  }
  const send = async () => {
    if (!body.trim()) return
    setSaving(true)
    const result = await apiPost<{ comment: TaskAttachmentComment }>(`/api/tasks/${taskId}/attachments/${attachment.id}/comments`, { body: body.trim(), parent_id: replyTo, anchor, mentioned_user_ids: mentionIDs })
    setSaving(false)
    if (!result.success || !result.data?.comment) { setError(result.error || 'No se pudo publicar el comentario'); return }
    setComments(current => [...current, result.data!.comment])
    setBody(''); setMentionIDs([]); setReplyTo(undefined)
  }
  const resolve = async (comment: TaskAttachmentComment) => {
    const result = await apiPut<{ comment: TaskAttachmentComment }>(`/api/tasks/${taskId}/attachments/${attachment.id}/comments/${comment.id}/resolve`, { resolved: !comment.resolved_at, version: comment.version })
    if (result.success && result.data?.comment) setComments(current => current.map(item => item.id === comment.id ? result.data!.comment : item))
  }
  const roots = comments.filter(comment => !comment.parent_id)
  const canPreview = preview?.status === 'ready' && ['image', 'pdf', 'word_pdf', 'text'].includes(preview.kind)

  return createPortal(<div className="fixed inset-0 flex items-center justify-center bg-slate-950/70 p-2 backdrop-blur-[3px] sm:p-5" style={{ zIndex: TASK_OVERLAY_LAYERS.confirmation }} role="presentation">
    <section role="dialog" aria-modal="true" aria-label={`Vista previa de ${attachment.filename}`} className={`${fullscreen ? 'h-full w-full' : 'h-[92vh] w-full max-w-7xl'} flex overflow-hidden rounded-3xl border border-white/10 bg-slate-950 shadow-2xl shadow-black/50`}>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-14 items-center gap-3 border-b border-white/10 px-4 text-white"><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold">{attachment.filename}</p><p className="text-[10px] text-slate-400">{preview?.kind === 'word_pdf' ? 'Documento convertido de forma segura a PDF' : preview?.kind?.toUpperCase() || 'Preparando'}</p></div>{canPreview && <><button onClick={() => setZoom(value => Math.max(.5, value - .2))} className="rounded-xl p-2 hover:bg-white/10" aria-label="Alejar"><ZoomOut className="h-4 w-4" /></button><span className="w-12 text-center text-[10px] font-bold text-slate-300">{Math.round(zoom * 100)}%</span><button onClick={() => setZoom(value => Math.min(4, value + .2))} className="rounded-xl p-2 hover:bg-white/10" aria-label="Acercar"><ZoomIn className="h-4 w-4" /></button></>}<a href={attachment.url} target="_blank" rel="noreferrer" className="rounded-xl p-2 hover:bg-white/10" aria-label="Descargar"><Download className="h-4 w-4" /></a><button onClick={() => setFullscreen(value => !value)} className="rounded-xl p-2 hover:bg-white/10" aria-label="Pantalla completa"><Maximize2 className="h-4 w-4" /></button><button onClick={onClose} className="rounded-xl p-2 hover:bg-white/10" aria-label="Cerrar"><X className="h-5 w-5" /></button></header>
        <div className="relative min-h-0 flex-1 overflow-auto bg-slate-900 p-5">
          {loading && <div className="absolute inset-0 flex items-center justify-center text-slate-300"><Loader2 className="mr-2 h-5 w-5 animate-spin" />Preparando vista previa…</div>}
          {!loading && preview?.status === 'pending' && <div className="flex h-full items-center justify-center text-center text-slate-300"><div><Loader2 className="mx-auto h-8 w-8 animate-spin text-emerald-400" /><p className="mt-3 font-bold">Convirtiendo documento</p><p className="mt-1 text-xs text-slate-500">El worker aislado está generando un PDF. Puedes cerrar y volver después.</p><button onClick={() => void load()} className="mt-4 rounded-xl bg-white/10 px-4 py-2 text-xs font-bold"><RotateCcw className="mr-1 inline h-3.5 w-3.5" />Actualizar</button></div></div>}
          {!loading && preview?.status === 'unsupported' && <div className="flex h-full items-center justify-center text-center text-slate-300"><div><p className="font-bold">Este formato no tiene vista previa</p><p className="mt-1 text-xs text-slate-500">Los metadatos y la descarga continúan disponibles.</p></div></div>}
          {objectURL && preview?.kind === 'image' && <div className="relative mx-auto w-fit" onClick={placeAnchor}><img src={objectURL} alt={attachment.filename} style={{ transform: `scale(${zoom})`, transformOrigin: 'top center' }} className="max-w-full rounded-lg shadow-2xl" />{anchor.kind === 'image' && anchor.x !== undefined && <span className="pointer-events-none absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-4 border-white bg-emerald-500 shadow-lg" style={{ left: `${anchor.x * 100}%`, top: `${(anchor.y || 0) * 100}%` }} />}</div>}
          {pdf && <div className="relative mx-auto w-fit rounded-lg bg-white shadow-2xl" onClick={placeAnchor}><canvas ref={canvasRef} className="max-w-full" />{anchor.kind === 'pdf' && anchor.page === page && anchor.x !== undefined && <span className="pointer-events-none absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-4 border-white bg-emerald-500 shadow-lg" style={{ left: `${anchor.x * 100}%`, top: `${(anchor.y || 0) * 100}%` }} />}</div>}
          {preview?.kind === 'text' && <pre onMouseUp={() => { const selection = window.getSelection(); setAnchor(textAttachmentAnchor(text, selection?.anchorOffset || 0, selection?.toString() || '')) }} className="mx-auto min-h-full max-w-5xl whitespace-pre-wrap rounded-2xl bg-white p-6 font-mono text-sm leading-6 text-slate-800 shadow-2xl">{text}</pre>}
        </div>
        {pdf && <footer className="flex h-12 items-center justify-center gap-3 border-t border-white/10 text-white"><button disabled={page <= 1} onClick={() => setPage(value => value - 1)} className="rounded-lg p-2 disabled:opacity-30"><ChevronLeft className="h-4 w-4" /></button><span className="text-xs font-bold">Página {page} de {preview?.page_count || pdf.numPages}</span><button disabled={page >= (preview?.page_count || pdf.numPages)} onClick={() => setPage(value => value + 1)} className="rounded-lg p-2 disabled:opacity-30"><ChevronRight className="h-4 w-4" /></button></footer>}
      </div>
      <aside className="flex w-[340px] shrink-0 flex-col border-l border-slate-200 bg-white max-lg:w-[300px] max-md:hidden"><header className="border-b border-slate-200 px-4 py-4"><h2 className="flex items-center gap-2 text-sm font-black text-slate-800"><MessageSquare className="h-4 w-4 text-emerald-600" />Comentarios anclados</h2><p className="mt-1 text-[10px] text-slate-400">Haz clic en el documento para fijar el comentario.</p></header><div className="min-h-0 flex-1 overflow-y-auto p-3">{roots.map(comment => <div key={comment.id} className={`mb-2 rounded-2xl border p-3 ${comment.resolved_at ? 'border-slate-200 bg-slate-50 opacity-70' : 'border-emerald-100 bg-emerald-50/40'}`}><div className="flex items-center gap-2"><span className="flex h-7 w-7 items-center justify-center rounded-full bg-white text-[9px] font-black text-slate-500">{comment.author_name.slice(0,2).toUpperCase()}</span><span className="min-w-0 flex-1 truncate text-xs font-bold text-slate-700">{comment.author_name}</span>{comment.can_resolve && <button onClick={() => void resolve(comment)} title={comment.resolved_at ? 'Reabrir' : 'Resolver'} className="rounded-lg p-1.5 text-slate-400 hover:bg-white hover:text-emerald-600"><CheckCircle2 className="h-4 w-4" /></button>}</div><p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-slate-600">{comment.body}</p><button onClick={() => setReplyTo(comment.id)} className="mt-2 text-[10px] font-bold text-emerald-700">Responder</button>{comments.filter(reply => reply.parent_id === comment.id).map(reply => <div key={reply.id} className="mt-2 border-l-2 border-emerald-200 pl-2 text-[11px] text-slate-600"><strong>{reply.author_name}</strong><p>{reply.body}</p></div>)}</div>)}{!roots.length && <div className="py-14 text-center text-xs text-slate-400">Todavía no hay comentarios sobre este archivo.</div>}</div><div className="border-t border-slate-200 p-3">{replyTo && <button onClick={() => setReplyTo(undefined)} className="mb-2 rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-bold text-emerald-700">Respondiendo · cancelar</button>}<textarea value={body} onChange={event => setBody(event.target.value)} placeholder="Comenta sobre este punto…" className="min-h-20 w-full resize-none rounded-xl border border-slate-200 p-3 text-xs outline-none focus:border-emerald-300 focus:ring-4 focus:ring-emerald-50" /><div className="mt-2 flex gap-2"><div className="min-w-0 flex-1"><TaskUserCombobox users={users} value="" excludeIds={mentionIDs} onChange={id => setMentionIDs(current => [...current, id])} placeholder="Mencionar…" className="!min-h-9 !py-1" /></div><button disabled={!body.trim() || saving} onClick={() => void send()} className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-600 text-white disabled:opacity-40">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}</button></div>{error && <p className="mt-2 text-[10px] font-semibold text-rose-600">{error}</p>}</div></aside>
    </section>
  </div>, document.body)
}
