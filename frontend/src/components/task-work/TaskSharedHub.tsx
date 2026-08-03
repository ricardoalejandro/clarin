'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { FolderOpen, ListTodo, Loader2, RefreshCw, ShieldCheck, SquareCheckBig } from 'lucide-react'
import { apiGet } from '@/lib/api'
import type { TaskSharedResource } from '@/types/task'
import { TaskContainerIcon } from './TaskContainerAppearance'

type Response = { items: TaskSharedResource[]; next_cursor?: string | null }

export default function TaskSharedHub({ environmentId, refreshToken = 0, onOpenFolder, onOpenList, onOpenTask }: {
  environmentId: string
  refreshToken?: number
  onOpenFolder: (id: string, name: string) => void
  onOpenList: (id: string, name: string) => void
  onOpenTask: (id: string) => void
}) {
  const [items, setItems] = useState<TaskSharedResource[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(async (more = false) => {
    if (!environmentId || (more && !nextCursor)) return
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    more ? setLoadingMore(true) : setLoading(true)
    setError('')
    const cursor = more && nextCursor ? `&cursor=${encodeURIComponent(nextCursor)}` : ''
    const result = await apiGet<Response>(`/api/tasks/environments/${environmentId}/shared-resources?limit=50${cursor}`, { signal: controller.signal })
    if (controller.signal.aborted) return
    setLoading(false)
    setLoadingMore(false)
    if (!result.success) {
      setError(result.error || 'No se pudieron cargar los recursos compartidos.')
      return
    }
    setItems(current => more ? Array.from(new Map([...current, ...(result.data?.items || [])].map(item => [`${item.type}:${item.id}`, item])).values()) : result.data?.items || [])
    setNextCursor(result.data?.next_cursor || null)
  }, [environmentId, nextCursor])

  useEffect(() => {
    setItems([])
    setNextCursor(null)
    void load(false)
    return () => abortRef.current?.abort()
  // A changed page cursor must not restart the first page.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [environmentId, refreshToken])

  const open = (item: TaskSharedResource) => {
    if (item.type === 'folder') onOpenFolder(item.id, item.name)
    else if (item.type === 'list') onOpenList(item.id, item.name)
    else onOpenTask(item.id)
  }

  if (loading) return <div className="flex min-h-[360px] items-center justify-center text-sm font-semibold text-slate-400"><Loader2 className="mr-2 h-5 w-5 animate-spin text-violet-500" />Cargando recursos compartidos…</div>
  if (error) return <div className="mx-auto mt-10 max-w-lg rounded-2xl border border-rose-100 bg-white p-6 text-center"><p role="alert" className="text-sm font-semibold text-rose-700">{error}</p><button type="button" onClick={() => void load(false)} className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-xl bg-slate-900 px-4 text-sm font-bold text-white"><RefreshCw className="h-4 w-4" />Reintentar</button></div>

  return <section className="mx-auto w-full max-w-5xl p-2 sm:p-4" aria-labelledby="shared-hub-title">
    <div className="rounded-3xl border border-violet-100 bg-gradient-to-br from-white via-white to-violet-50/70 p-5 shadow-sm sm:p-7">
      <div className="flex items-start gap-3"><span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-violet-100 text-violet-700"><ShieldCheck className="h-5 w-5" /></span><div><h2 id="shared-hub-title" className="text-lg font-black text-slate-900">Compartidas contigo</h2><p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500">Carpetas, listas y tareas con una concesión directa dentro del Entorno actual. Los niveles heredados no se duplican aquí.</p></div></div>
      {!items.length ? <div className="mt-7 rounded-2xl border border-dashed border-violet-200 bg-white/80 px-5 py-12 text-center"><SquareCheckBig className="mx-auto h-8 w-8 text-violet-300" /><p className="mt-3 text-sm font-bold text-slate-700">No tienes recursos compartidos directamente</p><p className="mt-1 text-xs text-slate-400">El trabajo visible por herencia permanece en “Todo el Entorno”.</p></div> : <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{items.map(item => {
        const TypeIcon = item.type === 'folder' ? FolderOpen : item.type === 'list' ? ListTodo : SquareCheckBig
        const label = item.type === 'folder' ? 'Carpeta' : item.type === 'list' ? 'Lista' : 'Tarea'
        return <button key={`${item.type}:${item.id}`} type="button" onClick={() => open(item)} className="group min-h-24 rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-violet-200 hover:shadow-md focus:outline-none focus:ring-4 focus:ring-violet-100">
          <div className="flex items-start gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl" style={{ color: item.color || '#7C3AED', backgroundColor: `${item.color || '#7C3AED'}16` }}>{item.type === 'task' ? <TypeIcon className="h-4 w-4" /> : <TaskContainerIcon value={item.icon || item.type} className="h-4 w-4" />}</span><span className="min-w-0 flex-1"><span className="block text-[9px] font-black uppercase tracking-[.14em] text-violet-500">{label} · {item.effective_access_level}</span><span className="mt-1 block truncate text-sm font-black text-slate-800 group-hover:text-violet-800">{item.name}</span></span></div>
        </button>
      })}</div>}
      {nextCursor && <div className="mt-5 flex justify-center"><button type="button" disabled={loadingMore} onClick={() => void load(true)} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-violet-200 bg-white px-4 text-sm font-bold text-violet-700 hover:bg-violet-50 disabled:opacity-50">{loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}Cargar más</button></div>}
    </div>
  </section>
}
