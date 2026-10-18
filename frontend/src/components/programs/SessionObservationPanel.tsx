'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Edit2, Loader2, MessageSquare, Pin, Plus, Save, Trash2, X } from 'lucide-react'
import { api } from '@/lib/api'
import type { ProgramSessionObservation } from '@/types/program'
import { useDialogTabTrap } from './useDialogTabTrap'
import { OPERATIONAL_OVERLAY_LAYERS } from '@/components/operational-overlay/operationalOverlayLayers'
import { useOperationalOverlayRegistration } from '@/components/operational-window/OperationalOverlayContext'
import type { SessionObservationState } from './programAttendanceDetails'

type MutationMode = 'manage' | 'append-only' | 'read-only'

export default function SessionObservationPanel({ programId, sessionId, disabled = false, suspended = false, mutationMode = 'manage', onChanged, onStateChange }: { programId: string; sessionId: string; disabled?: boolean; suspended?: boolean; mutationMode?: MutationMode; onChanged?: () => void; onStateChange?: (state: SessionObservationState) => void }) {
  const [items, setItems] = useState<ProgramSessionObservation[]>([])
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState<ProgramSessionObservation | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<ProgramSessionObservation | null>(null)
  const deleteDialogRef = useRef<HTMLDivElement>(null)
  const deleteReturnFocusRef = useRef<HTMLElement | null>(null)
  const identity = `${programId}:${sessionId}`
  const identityRef = useRef(identity)
  const identityGenerationRef = useRef(0)
  if (identityRef.current !== identity) {
    identityRef.current = identity
    identityGenerationRef.current += 1
  }
  const identityGeneration = identityGenerationRef.current
  const policyRef = useRef({ disabled, mutationMode })
  policyRef.current = { disabled, mutationMode }
  const requestRef = useRef(0)
  const mutationRef = useRef<object | null>(null)
  const mountedRef = useRef(true)
  const draftRevisionRef = useRef(0)
  const editRevisionRef = useRef(0)
  const editFocusRef = useRef<HTMLTextAreaElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const stateChangeRef = useRef(onStateChange)
  stateChangeRef.current = onStateChange
  const suspendedRef = useRef(suspended)
  suspendedRef.current = suspended
  const canMutate = (manage = false) => mountedRef.current && identityRef.current === identity && identityGenerationRef.current === identityGeneration
    && !suspendedRef.current && !policyRef.current.disabled && policyRef.current.mutationMode !== 'read-only'
    && (!manage || policyRef.current.mutationMode === 'manage')
  const isCurrent = () => mountedRef.current && identityRef.current === identity && identityGenerationRef.current === identityGeneration
  const deleteConfirmationVisible = Boolean(pendingDelete) && mutationMode === 'manage' && !disabled && !suspended
  useDialogTabTrap(deleteConfirmationVisible, deleteDialogRef)
  useOperationalOverlayRegistration(deleteConfirmationVisible, `session-observation-delete:${identity}`)

  const dirty = Boolean(draft.trim()) || Boolean(editing && editDraft !== editing.notes)
  useEffect(() => { stateChangeRef.current?.({ dirty, saving, error, count: items.length }) }, [dirty, saving, error, items.length])
  useEffect(() => {
    if (suspended && document.activeElement instanceof HTMLElement && panelRef.current?.contains(document.activeElement)) document.activeElement.blur()
  }, [suspended])

  useEffect(() => {
    if (!deleteConfirmationVisible) return
    const frame = requestAnimationFrame(() => deleteDialogRef.current?.focus())
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopImmediatePropagation()
      if (!mutationRef.current) setPendingDelete(null)
    }
    document.addEventListener('keydown', escape, true)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', escape, true)
      if (canMutate(true)) requestAnimationFrame(() => {
        const target = deleteReturnFocusRef.current
        if (target?.isConnected && !target.closest('[hidden], [inert]')) target.focus()
      })
    }
    // Capability refs remain current while this confirmation is paused.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deleteConfirmationVisible])

  const load = useCallback(async () => {
    const request = ++requestRef.current
    setLoading(true); setLoadFailed(false); setError('')
    const result = await api<{ success: boolean; observations: ProgramSessionObservation[] }>(`/api/programs/${programId}/sessions/${sessionId}/observations`)
    if (!mountedRef.current || identityRef.current !== identity || identityGenerationRef.current !== identityGeneration || request !== requestRef.current) return
    if (!result.success || !result.data?.success) { setLoadFailed(true); setError(result.error || 'No se pudieron cargar los comentarios de la sesión.') }
    else setItems(Array.isArray(result.data.observations) ? result.data.observations : [])
    setLoading(false)
  }, [identity, identityGeneration, programId, sessionId])

  useEffect(() => {
    mountedRef.current = true
    setItems([]); setDraft(''); setEditing(null); setEditDraft(''); setSaving(false); setPendingDelete(null)
    mutationRef.current = null
    void load()
    return () => { mountedRef.current = false; requestRef.current += 1 }
  }, [load])

  useEffect(() => {
    if (mutationMode !== 'manage' || disabled || suspended || !editing) return
    const frame = requestAnimationFrame(() => editFocusRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [disabled, mutationMode, suspended, editing?.id])

  const upsert = (item: ProgramSessionObservation) => setItems(current => [item, ...current.filter(value => value.id !== item.id)].sort((a, b) => Number(b.is_pinned) - Number(a.is_pinned) || Date.parse(b.pinned_at || b.created_at) - Date.parse(a.pinned_at || a.created_at)))
  const create = async () => {
    if (!canMutate() || mutationRef.current) return
    const notes = draft.trim(); if (!notes) return
    const operation = {}; mutationRef.current = operation
    const revision = draftRevisionRef.current
    setSaving(true); setError('')
    const result = await api<{ success: boolean; observation: ProgramSessionObservation }>(`/api/programs/${programId}/sessions/${sessionId}/observations`, { method: 'POST', body: JSON.stringify({ notes }) })
    if (!isCurrent()) return
    if (mutationRef.current === operation) mutationRef.current = null
    setSaving(false)
    if (!result.success || !result.data?.observation) return setError(result.error || 'No se pudo guardar el comentario.')
    upsert(result.data.observation); if (revision === draftRevisionRef.current) setDraft(''); onChanged?.()
  }
  const update = async () => {
    if (!canMutate(true) || mutationRef.current) return
    if (!editing || !editing.can_edit || !editDraft.trim()) return
    const operation = {}; mutationRef.current = operation
    const revision = editRevisionRef.current
    setSaving(true); setError('')
    const result = await api<{ success: boolean; observation: ProgramSessionObservation }>(`/api/programs/${programId}/sessions/${sessionId}/observations/${editing.id}`, { method: 'PATCH', body: JSON.stringify({ notes: editDraft.trim(), expected_updated_at: editing.updated_at }) })
    if (!isCurrent()) return
    if (mutationRef.current === operation) mutationRef.current = null
    setSaving(false)
    if (!result.success || !result.data?.observation) return setError(result.error || 'No se pudo editar el comentario.')
    upsert(result.data.observation); if (revision === editRevisionRef.current) { setEditing(null); setEditDraft('') }; onChanged?.()
  }
  const pin = async (item: ProgramSessionObservation) => {
    if (!canMutate(true) || mutationRef.current || !item.can_pin) return
    const operation = {}; mutationRef.current = operation
    setSaving(true)
    const result = await api<{ success: boolean; observation: ProgramSessionObservation }>(`/api/programs/${programId}/sessions/${sessionId}/observations/${item.id}/pin`, { method: 'PATCH', body: JSON.stringify({ pinned: !item.is_pinned }) })
    if (!isCurrent()) return
    if (mutationRef.current === operation) mutationRef.current = null
    setSaving(false)
    if (!result.success || !result.data?.observation) return setError(result.error || 'No se pudo cambiar el fijado.')
    upsert(result.data.observation); onChanged?.()
  }
  const requestRemove = (item: ProgramSessionObservation) => {
    if (!canMutate(true) || mutationRef.current || !item.can_delete) return
    deleteReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setPendingDelete(item)
  }
  const remove = async (item: ProgramSessionObservation) => {
    if (!canMutate(true) || mutationRef.current || !item.can_delete) return
    const operation = {}; mutationRef.current = operation
    setSaving(true)
    const result = await api<{ success: boolean }>(`/api/programs/${programId}/sessions/${sessionId}/observations/${item.id}`, { method: 'DELETE' })
    if (!isCurrent()) return
    if (mutationRef.current === operation) mutationRef.current = null
    setSaving(false)
    if (!result.success) return setError(result.error || 'No se pudo eliminar el comentario.')
    setItems(current => current.filter(value => value.id !== item.id)); setPendingDelete(null); onChanged?.()
  }

  return <section ref={panelRef} hidden={suspended} inert={suspended || undefined} className="mb-4 rounded-2xl border border-slate-200 bg-slate-50/70 p-3 sm:p-4">
    <div className="flex items-center justify-between gap-3"><div><h3 className="flex items-center gap-2 text-sm font-bold text-slate-800"><MessageSquare className="h-4 w-4 text-emerald-600" />Comentarios generales</h3><p className="mt-0.5 text-xs text-slate-500">Temas dictados y observaciones que aplican a toda la sesión.</p></div><span className="rounded-full bg-white px-2 py-1 text-xs font-semibold text-slate-500">{items.length}</span></div>
    {editing && editDraft !== editing.notes && mutationMode !== 'manage' && <p role="status" className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">Tienes una edición de comentario pendiente. Vuelve a escritorio para continuar.</p>}
    {mutationMode !== 'read-only' && <div className="mt-3 flex flex-col gap-2 sm:flex-row"><textarea disabled={disabled} rows={2} maxLength={4000} value={draft} onChange={event => { draftRevisionRef.current += 1; setDraft(event.target.value) }} placeholder="Ej.: Se dictó el tema… Observaciones generales…" className="min-h-20 flex-1 resize-y rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"/><button type="button" disabled={disabled || saving || !draft.trim()} onClick={() => void create()} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-bold text-white disabled:opacity-50"><Plus className="h-4 w-4"/>Añadir</button></div>}
    {error && <div role="alert" className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700"><span>{error}</span>{loadFailed && <button type="button" disabled={disabled || loading} onClick={() => { if (!suspendedRef.current && !policyRef.current.disabled) void load() }} className="min-h-11 rounded-lg px-3 font-semibold hover:bg-red-100 disabled:opacity-40">Reintentar comentarios</button>}</div>}
    {loading ? <div className="flex min-h-20 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-emerald-600"/></div> : items.length > 0 && <div className="mt-3 space-y-2">{items.map(item => <article key={item.id} className={`rounded-xl border bg-white p-3 ${item.is_pinned ? 'border-amber-200 ring-1 ring-amber-100' : 'border-slate-200'}`}>
      {editing?.id === item.id && mutationMode === 'manage' ? <><textarea ref={editFocusRef} disabled={disabled} aria-label="Editar comentario de sesión" rows={3} maxLength={4000} value={editDraft} onChange={event => { editRevisionRef.current += 1; setEditDraft(event.target.value) }} className="w-full resize-y rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"/><div className="mt-2 flex justify-end gap-2"><button disabled={disabled || saving} onClick={() => setEditing(null)} className="inline-flex min-h-10 items-center gap-1 rounded-lg px-3 text-xs font-semibold text-slate-600 disabled:opacity-40"><X className="h-4 w-4"/>Cancelar</button><button disabled={disabled || saving || !editDraft.trim()} onClick={() => void update()} className="inline-flex min-h-10 items-center gap-1 rounded-lg bg-emerald-600 px-3 text-xs font-bold text-white disabled:opacity-40"><Save className="h-4 w-4"/>Guardar</button></div></> : <div className="flex gap-3"><div className="min-w-0 flex-1">{item.is_pinned && <span className="mb-1 inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-amber-700"><Pin className="h-3 w-3"/>Fijado</span>}<p className="whitespace-pre-wrap break-words text-sm leading-5 text-slate-700">{item.notes}</p><p className="mt-1 text-[10px] text-slate-400">{item.created_by_name || 'Autor no registrado'} · {new Date(item.created_at).toLocaleString('es-PE')}{item.updated_at !== item.created_at && ` · editado ${new Date(item.updated_at).toLocaleString('es-PE')}`}</p></div>{mutationMode === 'manage' && <div className="flex shrink-0 gap-1">{item.can_pin && <button disabled={disabled || saving} onClick={() => void pin(item)} title={item.is_pinned ? 'Desfijar' : 'Fijar'} className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-400 hover:bg-amber-50 hover:text-amber-700 disabled:opacity-40"><Pin className="h-4 w-4"/></button>}{item.can_edit && <button disabled={disabled || saving} onClick={() => { if (!canMutate(true)) return; setEditing(item); setEditDraft(item.notes) }} title="Editar" className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 disabled:opacity-40"><Edit2 className="h-4 w-4"/></button>}{item.can_delete && <button disabled={disabled || saving} onClick={() => requestRemove(item)} title="Eliminar" className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"><Trash2 className="h-4 w-4"/></button>}</div>}</div>}
    </article>)}</div>}
    {deleteConfirmationVisible && pendingDelete && typeof document !== 'undefined' && createPortal(
      <div className="fixed inset-0 flex items-center justify-center bg-slate-950/50 p-4" style={{ zIndex: OPERATIONAL_OVERLAY_LAYERS.confirmation }} onClick={event => event.stopPropagation()}>
        <div ref={deleteDialogRef} tabIndex={-1} role="alertdialog" aria-modal="true" aria-label="Eliminar comentario de sesión" className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl outline-none">
          <h4 className="text-base font-bold text-slate-900">Eliminar comentario</h4>
          <p className="mt-2 text-sm text-slate-600">Se eliminará este comentario de la sesión. Esta acción no se puede deshacer.</p>
          {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
          <div className="mt-4 flex justify-end gap-2"><button type="button" disabled={saving} onClick={() => setPendingDelete(null)} className="min-h-11 rounded-xl px-3 text-sm font-semibold text-slate-600 disabled:opacity-50">Cancelar</button><button type="button" disabled={saving} onClick={() => void remove(pendingDelete)} className="min-h-11 rounded-xl bg-red-600 px-4 text-sm font-semibold text-white disabled:opacity-50">{saving ? 'Eliminando…' : 'Eliminar comentario'}</button></div>
        </div>
      </div>, document.body,
    )}
  </section>
}
