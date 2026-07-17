'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Columns3,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Settings,
  Trash2,
  X,
} from 'lucide-react'
import type { Pipeline } from '@/types/contact'
import PipelineCreationWizard from './PipelineCreationWizard'
import PipelineStageManager from './PipelineStageManager'
import { useAccessibleDialog } from './useAccessibleDialog'

interface PipelineManagementDialogProps {
  open: boolean
  onClose: () => void
  activePipelineId?: string | null
  onChanged?: (pipelines: Pipeline[], preferredPipelineId?: string | null) => void | Promise<void>
}

const focusClass = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2'

export default function PipelineManagementDialog({ open, onClose, activePipelineId, onChanged }: PipelineManagementDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const deleteDialogRef = useRef<HTMLDivElement>(null)
  const onChangedRef = useRef(onChanged)
  const [pipelines, setPipelines] = useState<Pipeline[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const [expandedPipelineId, setExpandedPipelineId] = useState<string | null>(null)
  const [editingPipelineId, setEditingPipelineId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [savingName, setSavingName] = useState(false)
  const [showCreationWizard, setShowCreationWizard] = useState(false)
  const [stageManagerPipeline, setStageManagerPipeline] = useState<Pipeline | null>(null)
  const [deletePipeline, setDeletePipeline] = useState<Pipeline | null>(null)
  const [deleting, setDeleting] = useState(false)

  const loadPipelines = useCallback(async (preferredPipelineId?: string | null) => {
    setLoading(true)
    setLoadError('')
    try {
      const token = localStorage.getItem('token')
      const response = await fetch('/api/pipelines', { headers: { Authorization: `Bearer ${token}` } })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.success) throw new Error(data?.error || 'No pudimos cargar los pipelines.')
      const next: Pipeline[] = data.pipelines || []
      setPipelines(next)
      await onChangedRef.current?.(next, preferredPipelineId)
      return next
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'No pudimos cargar los pipelines.')
      return null
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { onChangedRef.current = onChanged }, [onChanged])

  useEffect(() => {
    if (!open) return
    setActionError('')
    setEditingPipelineId(null)
    setDeletePipeline(null)
    void loadPipelines(activePipelineId)
  }, [open, activePipelineId, loadPipelines])

  const requestClose = useCallback(() => {
    if (savingName || deleting || showCreationWizard || stageManagerPipeline || deletePipeline) return
    onClose()
  }, [deletePipeline, deleting, onClose, savingName, showCreationWizard, stageManagerPipeline])

  useAccessibleDialog(open && !showCreationWizard && !stageManagerPipeline && !deletePipeline, dialogRef, requestClose, titleRef)
  const closeDeleteDialog = useCallback(() => { if (!deleting) setDeletePipeline(null) }, [deleting])
  useAccessibleDialog(Boolean(deletePipeline), deleteDialogRef, closeDeleteDialog)

  const activePipeline = useMemo(() => pipelines.find(item => item.id === activePipelineId), [activePipelineId, pipelines])

  const handleRename = async (pipeline: Pipeline) => {
    const name = editName.trim()
    if (!name || savingName) return
    setSavingName(true)
    setActionError('')
    try {
      const token = localStorage.getItem('token')
      const response = await fetch(`/api/pipelines/${pipeline.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.success) throw new Error(data?.error || 'No se pudo renombrar el pipeline.')
      const next = pipelines.map(item => item.id === pipeline.id ? { ...item, ...data.pipeline, name } : item)
      setPipelines(next)
      setEditingPipelineId(null)
      setAnnouncement(`Pipeline ${name} actualizado.`)
      await onChanged?.(next, activePipelineId)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'No se pudo renombrar el pipeline.')
    } finally {
      setSavingName(false)
    }
  }

  const confirmDelete = async () => {
    if (!deletePipeline || deleting) return
    setDeleting(true)
    setActionError('')
    try {
      const token = localStorage.getItem('token')
      const response = await fetch(`/api/pipelines/${deletePipeline.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.success) throw new Error(data?.error || 'No se pudo eliminar el pipeline.')
      const next = pipelines.filter(item => item.id !== deletePipeline.id)
      const preferred = deletePipeline.id === activePipelineId
        ? (next.find(item => item.is_default)?.id || next[0]?.id || null)
        : activePipelineId
      setPipelines(next)
      setExpandedPipelineId(current => current === deletePipeline.id ? null : current)
      setAnnouncement(`Pipeline ${deletePipeline.name} eliminado.`)
      setDeletePipeline(null)
      await onChanged?.(next, preferred)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No se pudo eliminar el pipeline.'
      setActionError(message)
      setDeletePipeline(null)
    } finally {
      setDeleting(false)
    }
  }

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <>
      <div data-pipeline-management-layer="true" className="fixed inset-0 z-[75] flex items-center justify-center bg-slate-950/55 p-0 backdrop-blur-sm sm:p-4" onMouseDown={event => { if (event.target === event.currentTarget) requestClose() }}>
        <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="pipeline-management-title" tabIndex={-1} className="flex h-full w-full max-w-5xl flex-col overflow-hidden bg-white shadow-2xl sm:h-[88vh] sm:rounded-3xl">
          <header className="flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-700"><Columns3 className="h-5 w-5" /></div>
            <div className="min-w-0 flex-1">
              <h2 ref={titleRef} id="pipeline-management-title" tabIndex={-1} className="text-base font-bold text-slate-900 outline-none sm:text-lg">Administrar pipelines</h2>
              <p className="truncate text-xs text-slate-500 sm:text-sm">Crea recorridos y organiza sus etapas desde un solo lugar.</p>
            </div>
            <button type="button" onClick={() => setShowCreationWizard(true)} className={`inline-flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-3 text-sm font-semibold text-white hover:bg-emerald-700 sm:px-4 ${focusClass}`}><Plus className="h-4 w-4" /><span className="hidden sm:inline">Nuevo pipeline</span></button>
            <button type="button" onClick={requestClose} className={`inline-flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 ${focusClass}`} aria-label="Cerrar administración de pipelines"><X className="h-5 w-5" /></button>
          </header>

          <main className="min-h-0 flex-1 overflow-y-auto bg-slate-50/70 p-4 sm:p-6">
            {actionError && <div className="mb-4 flex items-start gap-2 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800" role="alert"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span className="flex-1">{actionError}</span><button type="button" onClick={() => setActionError('')} className="rounded p-1 hover:bg-red-100" aria-label="Cerrar error"><X className="h-4 w-4" /></button></div>}

            {loading ? (
              <div className="flex min-h-64 items-center justify-center rounded-3xl border border-slate-200 bg-white" aria-busy="true"><Loader2 className="h-6 w-6 animate-spin text-emerald-600" /><span className="ml-3 text-sm font-semibold text-slate-600">Cargando pipelines…</span></div>
            ) : loadError ? (
              <div className="rounded-3xl border border-red-200 bg-red-50 p-8 text-center" role="alert"><AlertCircle className="mx-auto h-7 w-7 text-red-600" /><p className="mt-3 text-sm font-bold text-red-800">{loadError}</p><button type="button" onClick={() => void loadPipelines(activePipelineId)} className={`mt-5 inline-flex min-h-11 items-center gap-2 rounded-xl bg-white px-4 text-sm font-bold text-red-700 ring-1 ring-red-200 hover:bg-red-100 ${focusClass}`}><RefreshCw className="h-4 w-4" />Reintentar</button></div>
            ) : pipelines.length === 0 ? (
              <div className="rounded-3xl border border-dashed border-slate-300 bg-white px-5 py-12 text-center"><Columns3 className="mx-auto h-9 w-9 text-slate-300" /><h3 className="mt-3 text-base font-bold text-slate-800">Todavía no hay pipelines</h3><p className="mx-auto mt-1 max-w-md text-sm text-slate-500">Crea el primero con una plantilla profesional o una configuración propia.</p><button type="button" onClick={() => setShowCreationWizard(true)} className={`mt-5 inline-flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-bold text-white hover:bg-emerald-700 ${focusClass}`}><Plus className="h-4 w-4" />Crear mi primer pipeline</button></div>
            ) : (
              <div className="space-y-3">
                {pipelines.map(pipeline => {
                  const expanded = expandedPipelineId === pipeline.id
                  const editing = editingPipelineId === pipeline.id
                  const stages = [...(pipeline.stages || [])].sort((a, b) => a.position - b.position)
                  return (
                    <section key={pipeline.id} className={`overflow-hidden rounded-2xl border bg-white shadow-sm ${pipeline.id === activePipelineId ? 'border-emerald-300 ring-1 ring-emerald-100' : 'border-slate-200'}`}>
                      <div className="flex min-h-16 items-center gap-2 px-3 py-2 sm:px-4">
                        {editing ? (
                          <div className="flex min-w-0 flex-1 items-center gap-2">
                            <input autoFocus value={editName} maxLength={120} onChange={event => setEditName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void handleRename(pipeline); if (event.key === 'Escape') setEditingPipelineId(null) }} className={`h-11 min-w-0 flex-1 rounded-xl border border-slate-300 px-3 text-sm font-semibold text-slate-900 ${focusClass}`} aria-label={`Nuevo nombre para ${pipeline.name}`} />
                            <button type="button" disabled={savingName || !editName.trim()} onClick={() => void handleRename(pipeline)} className={`inline-flex h-11 w-11 items-center justify-center rounded-xl text-emerald-700 hover:bg-emerald-50 disabled:opacity-40 ${focusClass}`} aria-label="Guardar nombre">{savingName ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}</button>
                            <button type="button" onClick={() => setEditingPipelineId(null)} className={`inline-flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 ${focusClass}`} aria-label="Cancelar edición"><X className="h-4 w-4" /></button>
                          </div>
                        ) : (
                          <button type="button" onClick={() => setExpandedPipelineId(expanded ? null : pipeline.id)} className={`flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-xl px-1 text-left ${focusClass}`} aria-expanded={expanded}>
                            {expanded ? <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" /> : <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" />}
                            <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h3 className="truncate text-sm font-bold text-slate-900">{pipeline.name}</h3>{pipeline.id === activePipeline?.id && <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700">Activo</span>}</div><p className="mt-0.5 text-xs text-slate-400">{stages.length} etapa{stages.length !== 1 ? 's' : ''}</p></div>
                          </button>
                        )}
                        {!editing && <div className="flex shrink-0 items-center gap-1"><button type="button" onClick={() => { setEditingPipelineId(pipeline.id); setEditName(pipeline.name); setActionError('') }} className={`inline-flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 hover:bg-emerald-50 hover:text-emerald-700 ${focusClass}`} aria-label={`Renombrar ${pipeline.name}`}><Pencil className="h-4 w-4" /></button><button type="button" onClick={() => { setDeletePipeline(pipeline); setActionError('') }} className={`inline-flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2`} aria-label={`Eliminar ${pipeline.name}`}><Trash2 className="h-4 w-4" /></button></div>}
                      </div>
                      {expanded && <div className="border-t border-slate-100 bg-slate-50/60">
                        {stages.length === 0 ? <p className="px-4 py-6 text-center text-sm text-slate-500">Este pipeline todavía no tiene etapas.</p> : <div className="divide-y divide-slate-100">{stages.map((stage, index) => <div key={stage.id} className="flex min-h-11 items-center gap-3 px-4 py-2"><span className="w-4 text-center text-[10px] text-slate-400">{index + 1}</span><span className="h-3 w-3 rounded-full" style={{ backgroundColor: stage.color }} /><span className="min-w-0 flex-1 truncate text-sm text-slate-700">{stage.name}</span>{stage.stage_type !== 'active' && <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${stage.stage_type === 'won' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>{stage.stage_type === 'won' ? 'Ganado' : 'Perdido'}</span>}{stage.lead_count !== undefined && <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-500">{stage.lead_count}</span>}</div>)}</div>}
                        <div className="flex justify-end border-t border-slate-100 bg-white p-3"><button type="button" onClick={() => setStageManagerPipeline(pipeline)} className={`inline-flex min-h-11 items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 text-sm font-semibold text-emerald-700 hover:bg-emerald-100 ${focusClass}`}><Settings className="h-4 w-4" />Gestionar etapas</button></div>
                      </div>}
                    </section>
                  )
                })}
              </div>
            )}
          </main>
          <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-slate-200 bg-white px-4 py-3 sm:px-6"><p className="hidden text-xs text-slate-500 sm:block">Los cambios se reflejan inmediatamente en la cuenta.</p><button type="button" onClick={requestClose} className={`ml-auto min-h-11 rounded-xl border border-slate-200 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 ${focusClass}`}>Cerrar</button></footer>
        </div>
      </div>

      <PipelineCreationWizard open={showCreationWizard} onClose={() => setShowCreationWizard(false)} onCreated={async pipeline => { const next = [...pipelines, pipeline]; setPipelines(next); setExpandedPipelineId(pipeline.id); setAnnouncement(`Pipeline ${pipeline.name} creado.`); await onChanged?.(next, pipeline.id) }} />
      <PipelineStageManager open={Boolean(stageManagerPipeline)} pipeline={stageManagerPipeline} onClose={() => setStageManagerPipeline(null)} onSaved={async updated => { const next = pipelines.map(item => item.id === updated.id ? updated : item); setPipelines(next); setStageManagerPipeline(updated); setAnnouncement(`Etapas de ${updated.name} actualizadas.`); await onChanged?.(next, activePipelineId) }} />

      {deletePipeline && <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/55 p-4"><div ref={deleteDialogRef} role="alertdialog" aria-modal="true" aria-labelledby="delete-pipeline-title" tabIndex={-1} className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl"><div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-red-50 text-red-600"><Trash2 className="h-5 w-5" /></div><h3 id="delete-pipeline-title" className="mt-4 text-lg font-bold text-slate-900">¿Eliminar “{deletePipeline.name}”?</h3><p className="mt-2 text-sm leading-relaxed text-slate-600">Sólo puede eliminarse si no contiene oportunidades. Sus etapas también se eliminarán de forma irreversible.</p><div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row"><button type="button" autoFocus disabled={deleting} onClick={closeDeleteDialog} className={`min-h-11 flex-1 rounded-xl border border-slate-200 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 ${focusClass}`}>Cancelar</button><button type="button" disabled={deleting} onClick={() => void confirmDelete()} className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-red-600 px-4 text-sm font-bold text-white hover:bg-red-700 disabled:opacity-50">{deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{deleting ? 'Eliminando…' : 'Eliminar pipeline'}</button></div></div></div>}
      <p className="sr-only" aria-live="polite">{announcement}</p>
    </>,
    document.body,
  )
}
