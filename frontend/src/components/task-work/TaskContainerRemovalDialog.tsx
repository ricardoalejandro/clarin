'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, CheckCircle2, Loader2, MoveRight, Trash2, X } from 'lucide-react'
import { api, apiPost } from '@/lib/api'
import type { TaskContainerLifecycleMutation } from './taskHierarchyLazy'
import { TASK_OVERLAY_LAYERS } from './taskOverlayLayers'
import TaskContainerRemovalDestinationPicker from './TaskContainerRemovalDestinationPicker'
import { useTaskRemovalDialogFocus } from './useTaskRemovalDialogFocus'
import {
  canConfirmTaskContainerRemoval, taskContainerRemovalEndpoint, taskContainerRemovalInventory,
  taskContainerRemovalPayload, taskContainerRemovalPreparation, taskContainerRemovalPreviewMatches, taskRemovalNeedsNewPreview,
  type TaskContainerRemovalDestination, type TaskContainerRemovalDraft, type TaskContainerRemovalMode,
  type TaskContainerRemovalPreview, type TaskContainerRemovalResponse, type TaskContainerRemovalType,
} from './taskContainerRemoval'

export default function TaskContainerRemovalDialog({ item, type, onClose, onSaved, onOperation }: {
  item: { id: string; name: string; environment_id?: string }
  type: TaskContainerRemovalType
  onClose: () => void
  onSaved: (mutation: TaskContainerLifecycleMutation) => Promise<void> | void
  onOperation?: (operationID: string, active: boolean) => void
}) {
  const titleID = useId()
  const descriptionID = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const previewRequest = useRef<{ generation: number; controller?: AbortController }>({ generation: 0 })
  const attemptRef = useRef<{ signature: string; operationID: string } | null>(null)
  const mutationRef = useRef(false)
  const refreshRef = useRef(false)
  const mountedRef = useRef(true)
  const callbacks = useRef({ onClose, onSaved, onOperation })
  callbacks.current = { onClose, onSaved, onOperation }
  const [draft, setDraft] = useState<TaskContainerRemovalDraft>({ mode: 'trash_all', destinationListID: '', confirmationName: '', cancelFutureEvents: false, confirmAccessChanges: false })
  const [destination, setDestination] = useState<TaskContainerRemovalDestination | null>(null)
  const [preview, setPreview] = useState<TaskContainerRemovalPreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [committed, setCommitted] = useState<TaskContainerLifecycleMutation | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  useTaskRemovalDialogFocus(dialogRef, () => { if (!mutationRef.current && !refreshRef.current) callbacks.current.onClose() })

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false; previewRequest.current.controller?.abort(); previewRequest.current.generation += 1 }
  }, [])

  const prepare = useCallback(async (mode: TaskContainerRemovalMode, destinationListID: string) => {
    previewRequest.current.controller?.abort()
    const controller = new AbortController()
    const generation = ++previewRequest.current.generation
    previewRequest.current.controller = controller
    setLoading(true); setError(''); setPreview(null)
    try {
      const result = await api<TaskContainerRemovalResponse>(`${taskContainerRemovalEndpoint(type, item.id)}/removal-preview`, {
        method: 'POST', body: JSON.stringify(taskContainerRemovalPreparation({ mode, destinationListID })), signal: controller.signal,
      })
      if (!mountedRef.current || controller.signal.aborted || generation !== previewRequest.current.generation) return
      if (!result.success || !result.data?.preview) { setError(result.error || 'No se pudo preparar la eliminación. Reintenta.'); return }
      setPreview(result.data.preview)
    } catch {
      if (mountedRef.current && !controller.signal.aborted && generation === previewRequest.current.generation) setError('No se pudo consultar el contenido. Reintenta.')
    } finally {
      if (mountedRef.current && !controller.signal.aborted && generation === previewRequest.current.generation) setLoading(false)
    }
  }, [item.id, type])
  useEffect(() => { void prepare(draft.mode, draft.destinationListID) }, [draft.destinationListID, draft.mode, prepare])

  const changeMode = (mode: TaskContainerRemovalMode) => {
    if (busy || uncertain || mode === draft.mode) return
    attemptRef.current = null; setPreview(null); setConflict(false)
    setDraft(current => ({ ...current, mode, confirmationName: '', cancelFutureEvents: false, confirmAccessChanges: false }))
  }
  const refresh = async (mutation: TaskContainerLifecycleMutation) => {
    refreshRef.current = true
    setRefreshing(true); setError('')
    try {
      await callbacks.current.onSaved(mutation)
      if (mountedRef.current) callbacks.current.onClose()
    } catch {
      if (mountedRef.current) setError('La eliminación ya se guardó. No se pudo actualizar la vista; vuelve a cargarla desde aquí.')
    } finally { refreshRef.current = false; if (mountedRef.current) setRefreshing(false) }
  }
  const confirm = async () => {
    if (mutationRef.current || committed || !taskContainerRemovalPreviewMatches(preview, type, item.id, draft) || !canConfirmTaskContainerRemoval(preview, draft) || loading || !preview) return
    const signature = JSON.stringify(taskContainerRemovalPayload(preview, draft, ''))
    if (attemptRef.current?.signature !== signature) attemptRef.current = { signature, operationID: crypto.randomUUID() }
    const operationID = attemptRef.current.operationID
    mutationRef.current = true; setBusy(true); setError('')
    callbacks.current.onOperation?.(operationID, true)
    try {
      const result = await apiPost<TaskContainerRemovalResponse>(`${taskContainerRemovalEndpoint(type, item.id)}/remove`, taskContainerRemovalPayload(preview, draft, operationID))
      if (!mountedRef.current) return
      if (!result.success) {
        if (taskRemovalNeedsNewPreview(result.status, result.data?.code)) {
          attemptRef.current = null; setUncertain(false); setConflict(true)
          setDraft(current => ({ ...current, confirmationName: '', cancelFutureEvents: false, confirmAccessChanges: false }))
          await prepare(draft.mode, draft.destinationListID)
        } else {
          setUncertain(!result.status || result.status >= 500)
          setError(result.error || 'No se pudo completar la eliminación. Reintenta.')
        }
        return
      }
      const mutation: TaskContainerLifecycleMutation = { type, id: item.id, action: 'trashed', operationID, hierarchyCounts: result.data?.hierarchy_counts }
      setCommitted(mutation); setUncertain(false)
      mutationRef.current = false; setBusy(false)
      await refresh(mutation)
    } catch {
      if (mountedRef.current) { setUncertain(true); setError('No se recibió confirmación del servidor. Reintenta la misma operación para comprobar su resultado.') }
    } finally {
      mutationRef.current = false
      callbacks.current.onOperation?.(operationID, false)
      if (mountedRef.current) setBusy(false)
    }
  }
  if (typeof document === 'undefined') return null
  const matches = taskContainerRemovalPreviewMatches(preview, type, item.id, draft)
  const showDestination = draft.mode === 'preserve_contents' && (type === 'list' || preview?.requires_destination)
  const canConfirm = matches && !loading && !busy && !committed && canConfirmTaskContainerRemoval(preview, draft)
  const close = () => { if (!busy && !refreshing) onClose() }
  return createPortal(<div data-task-destructive-dialog data-task-container-removal className="fixed inset-0 flex items-center justify-center bg-slate-950/50 p-3 backdrop-blur-sm sm:p-5" style={{ zIndex: TASK_OVERLAY_LAYERS.confirmation }} onMouseDown={event => { if (event.target === event.currentTarget) close() }}>
    <div ref={dialogRef} tabIndex={-1} role="alertdialog" aria-modal="true" aria-labelledby={titleID} aria-describedby={descriptionID} className="flex max-h-[calc(100dvh-24px)] w-full max-w-xl flex-col overflow-hidden rounded-3xl border border-white/70 bg-white shadow-2xl outline-none">
      <header className="flex shrink-0 items-start gap-3 border-b border-slate-100 px-5 py-4"><span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${committed ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-600'}`}>{committed ? <CheckCircle2 className="h-5 w-5" /> : <Trash2 className="h-5 w-5" />}</span><div className="min-w-0 flex-1"><h2 id={titleID} className="break-words text-lg font-bold text-slate-900">{committed ? 'Eliminación guardada' : `Eliminar ${type === 'environment' ? 'Entorno' : type === 'folder' ? 'carpeta' : 'lista'}`}</h2><p id={descriptionID} className="mt-1 break-words text-sm leading-5 text-slate-500">{item.name} · {committed ? 'El cambio ya está guardado en el servidor.' : type === 'environment' ? 'El Entorno y su árbol completo pasarán a Papelera, incluida su Bandeja general. No se eliminarán archivos definitivamente.' : 'Elige qué hacer con su contenido. Podrás recuperar lo enviado a Papelera.'}</p></div><button data-removal-initial-focus type="button" aria-label="Cerrar eliminación" disabled={busy || refreshing} onClick={close} className="flex min-h-11 min-w-11 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 disabled:opacity-40"><X className="h-4 w-4" /></button></header>
      <div className="min-h-0 space-y-4 overflow-y-auto px-5 py-4">
        {!committed && type !== 'environment' && <fieldset disabled={busy || uncertain} className="space-y-2"><legend className="mb-2 text-xs font-bold text-slate-600">Qué quieres eliminar</legend>{([
          { mode: 'trash_all', title: 'Eliminar todo junto', description: 'La estructura y su contenido pasarán a Papelera en una sola operación.', Icon: Trash2 },
          { mode: 'preserve_contents', title: 'Conservar el contenido', description: type === 'folder' ? 'Sus listas quedarán independientes en este Entorno. Las pizarras propias se trasladarán al destino elegido.' : 'Sus tareas, subtareas, eventos y pizarras se trasladarán a la lista que elijas.', Icon: MoveRight },
        ] as const).map(option => <label key={option.mode} className={`flex cursor-pointer items-start gap-3 rounded-2xl border p-3 transition ${draft.mode === option.mode ? 'border-emerald-400 bg-emerald-50/60' : 'border-slate-200 hover:bg-slate-50'}`}><input type="radio" name={titleID} value={option.mode} checked={draft.mode === option.mode} onChange={() => changeMode(option.mode)} className="mt-1 h-4 w-4 shrink-0 accent-emerald-600" /><option.Icon className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" /><span><span className="block text-sm font-semibold text-slate-800">{option.title}</span><span className="mt-1 block text-xs leading-5 text-slate-500">{option.description}</span></span></label>)}</fieldset>}
        {!committed && type !== 'environment' && showDestination && <div><p className="mb-2 text-xs font-bold text-slate-600">{type === 'folder' ? 'Destino de las pizarras de esta carpeta' : 'Lista de destino'}</p><TaskContainerRemovalDestinationPicker type={type} id={item.id} selected={destination} disabled={busy || uncertain} onChange={next => { attemptRef.current = null; setDestination(next); setPreview(null); setConflict(false); setDraft(current => ({ ...current, destinationListID: next.id, confirmationName: '', cancelFutureEvents: false, confirmAccessChanges: false })) }} /><p className="mt-1.5 text-xs leading-5 text-slate-500">Solo se ofrecen destinos del mismo Entorno y del mismo estado de Archivo.</p></div>}
        {loading && !committed && <div role="status" className="flex items-center gap-2 py-3 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Consultando contenido y permisos…</div>}
        {preview && matches && !committed && <>
          <section aria-label="Contenido afectado" className="rounded-2xl border border-slate-200 bg-slate-50 p-3"><p className="mb-2 text-xs font-bold text-slate-700">Contenido de esta operación</p><dl className="grid grid-cols-2 gap-x-5 gap-y-2 text-xs sm:grid-cols-3">{taskContainerRemovalInventory(preview.counts).map(entry => <div key={entry.label}><dt className="text-slate-500">{entry.label}</dt><dd className="mt-0.5 text-sm font-bold tabular-nums text-slate-800">{entry.count}</dd></div>)}</dl><p className="mt-3 text-xs leading-5 text-slate-500">{preview.counts.open_tasks} abiertas · {preview.counts.completed_tasks} completadas · {preview.counts.cancelled_tasks} canceladas</p></section>
          {preview.lifecycle === 'archived' && <p className="text-xs leading-5 text-amber-800">El contenido archivado conservará su estado histórico. Restaurarlo desde Papelera no lo reactivará.</p>}
          {conflict && <p role="status" className="rounded-xl bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">El contenido o los permisos cambiaron. Actualizamos el resumen; revisa y confirma de nuevo. Tu opción y destino se conservaron.</p>}
          {preview.blockers?.length > 0 && <div role="status" className="space-y-1 rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-900">{preview.blockers.map((blocker, index) => <p key={index}>{blocker}</p>)}</div>}
          {preview.access_change_summary && <p className="rounded-xl border border-slate-200 p-3 text-xs leading-5 text-slate-600">{preview.access_change_summary}</p>}
          {preview.requires_event_cancellation && <label className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900"><input type="checkbox" checked={draft.cancelFutureEvents} disabled={busy || uncertain} onChange={event => setDraft(current => ({ ...current, cancelFutureEvents: event.target.checked }))} className="mt-1 h-4 w-4 shrink-0 accent-amber-600" />Confirmo cancelar los eventos futuros y detener sus recordatorios al enviarlos a Papelera.</label>}
          {preview.requires_access_confirmation && <label className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900"><input type="checkbox" checked={draft.confirmAccessChanges} disabled={busy || uncertain} onChange={event => setDraft(current => ({ ...current, confirmAccessChanges: event.target.checked }))} className="mt-1 h-4 w-4 shrink-0 accent-amber-600" />Revisé y confirmo los cambios de acceso indicados en este resumen.</label>}
          {(preview.requires_name || type === 'environment') && <label className="block text-xs font-semibold leading-5 text-slate-600">Escribe <strong className="break-words text-slate-900">{preview.name}</strong> para confirmar<input aria-label="Nombre para confirmar" value={draft.confirmationName} disabled={busy || uncertain} onChange={event => setDraft(current => ({ ...current, confirmationName: event.target.value }))} autoComplete="off" spellCheck={false} className="mt-2 min-h-11 w-full rounded-xl border border-slate-300 px-3 text-sm text-slate-800 outline-none focus:border-rose-300 focus:ring-4 focus:ring-rose-100 disabled:opacity-50" /></label>}
          <p className="text-xs leading-5 text-slate-500">{draft.mode === 'trash_all' ? 'No se borrarán archivos definitivamente. La recuperación se hará desde Papelera.' : 'La estructura vacía quedará en Papelera. Restaurarla después no deshará los traslados de contenido.'}</p>
        </>}
        {error && <div role="alert" className="flex items-start gap-2 rounded-xl bg-rose-50 p-3 text-xs leading-5 text-rose-700"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}{!committed && !preview && <button type="button" onClick={() => void prepare(draft.mode, draft.destinationListID)} className="ml-2 font-semibold underline">Reintentar consulta</button>}</span></div>}
        {uncertain && <p role="status" className="text-xs leading-5 text-amber-900">La confirmación no llegó. Reintentar verificará la misma operación, sin duplicarla.</p>}
      </div>
      <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-4"><button type="button" disabled={busy || refreshing} onClick={close} className="min-h-11 rounded-xl px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-white disabled:opacity-40">{committed ? 'Cerrar' : 'Cancelar'}</button>{committed ? <button type="button" disabled={refreshing} onClick={() => void refresh(committed)} className="min-h-11 rounded-xl bg-emerald-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">{refreshing ? 'Actualizando…' : 'Actualizar vista'}</button> : <button type="button" disabled={!canConfirm} onClick={() => void confirm()} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-40">{busy && <Loader2 className="h-4 w-4 animate-spin" />}{busy ? 'Eliminando…' : uncertain ? 'Reintentar la operación' : draft.mode === 'trash_all' ? 'Mover todo a Papelera' : 'Conservar y eliminar'}</button>}</footer>
    </div>
  </div>, document.body)
}
