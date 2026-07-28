'use client'

import { useCallback, useEffect, useState } from 'react'
import { Edit2, Loader2, MessageSquare, Pin, Plus, Save, Trash2, X } from 'lucide-react'
import { api } from '@/lib/api'
import type { ProgramSessionObservation } from '@/types/program'

export default function SessionObservationPanel({ programId, sessionId, onChanged }: { programId: string; sessionId: string; onChanged?: () => void }) {
  const [items, setItems] = useState<ProgramSessionObservation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState<ProgramSessionObservation | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    const result = await api<{ success: boolean; observations: ProgramSessionObservation[] }>(`/api/programs/${programId}/sessions/${sessionId}/observations`)
    if (!result.success || !result.data?.success) setError(result.error || 'No se pudieron cargar los comentarios de la sesión.')
    else setItems(Array.isArray(result.data.observations) ? result.data.observations : [])
    setLoading(false)
  }, [programId, sessionId])

  useEffect(() => { void load() }, [load])

  const upsert = (item: ProgramSessionObservation) => setItems(current => [item, ...current.filter(value => value.id !== item.id)].sort((a, b) => Number(b.is_pinned) - Number(a.is_pinned) || Date.parse(b.pinned_at || b.created_at) - Date.parse(a.pinned_at || a.created_at)))
  const create = async () => {
    const notes = draft.trim(); if (!notes) return
    setSaving(true); setError('')
    const result = await api<{ success: boolean; observation: ProgramSessionObservation }>(`/api/programs/${programId}/sessions/${sessionId}/observations`, { method: 'POST', body: JSON.stringify({ notes }) })
    setSaving(false)
    if (!result.success || !result.data?.observation) return setError(result.error || 'No se pudo guardar el comentario.')
    upsert(result.data.observation); setDraft(''); onChanged?.()
  }
  const update = async () => {
    if (!editing || !editDraft.trim()) return
    setSaving(true); setError('')
    const result = await api<{ success: boolean; observation: ProgramSessionObservation }>(`/api/programs/${programId}/sessions/${sessionId}/observations/${editing.id}`, { method: 'PATCH', body: JSON.stringify({ notes: editDraft.trim(), expected_updated_at: editing.updated_at }) })
    setSaving(false)
    if (!result.success || !result.data?.observation) return setError(result.error || 'No se pudo editar el comentario.')
    upsert(result.data.observation); setEditing(null); setEditDraft(''); onChanged?.()
  }
  const pin = async (item: ProgramSessionObservation) => {
    const result = await api<{ success: boolean; observation: ProgramSessionObservation }>(`/api/programs/${programId}/sessions/${sessionId}/observations/${item.id}/pin`, { method: 'PATCH', body: JSON.stringify({ pinned: !item.is_pinned }) })
    if (!result.success || !result.data?.observation) return setError(result.error || 'No se pudo cambiar el fijado.')
    upsert(result.data.observation); onChanged?.()
  }
  const remove = async (item: ProgramSessionObservation) => {
    if (!window.confirm('¿Eliminar este comentario de la sesión?')) return
    const result = await api<{ success: boolean }>(`/api/programs/${programId}/sessions/${sessionId}/observations/${item.id}`, { method: 'DELETE' })
    if (!result.success) return setError(result.error || 'No se pudo eliminar el comentario.')
    setItems(current => current.filter(value => value.id !== item.id)); onChanged?.()
  }

  return <section className="mb-4 rounded-2xl border border-slate-200 bg-slate-50/70 p-3 sm:p-4">
    <div className="flex items-center justify-between gap-3"><div><h3 className="flex items-center gap-2 text-sm font-bold text-slate-800"><MessageSquare className="h-4 w-4 text-emerald-600" />Comentarios generales</h3><p className="mt-0.5 text-xs text-slate-500">Temas dictados y observaciones que aplican a toda la sesión.</p></div><span className="rounded-full bg-white px-2 py-1 text-xs font-semibold text-slate-500">{items.length}</span></div>
    <div className="mt-3 flex flex-col gap-2 sm:flex-row"><textarea rows={2} maxLength={4000} value={draft} onChange={event => setDraft(event.target.value)} placeholder="Ej.: Se dictó el tema… Observaciones generales…" className="min-h-20 flex-1 resize-y rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"/><button type="button" disabled={saving || !draft.trim()} onClick={() => void create()} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-bold text-white disabled:opacity-50"><Plus className="h-4 w-4"/>Añadir</button></div>
    {error && <div className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}
    {loading ? <div className="flex min-h-20 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-emerald-600"/></div> : items.length > 0 && <div className="mt-3 space-y-2">{items.map(item => <article key={item.id} className={`rounded-xl border bg-white p-3 ${item.is_pinned ? 'border-amber-200 ring-1 ring-amber-100' : 'border-slate-200'}`}>
      {editing?.id === item.id ? <><textarea autoFocus rows={3} maxLength={4000} value={editDraft} onChange={event => setEditDraft(event.target.value)} className="w-full resize-y rounded-lg border border-slate-300 px-3 py-2 text-sm"/><div className="mt-2 flex justify-end gap-2"><button onClick={() => setEditing(null)} className="inline-flex min-h-10 items-center gap-1 rounded-lg px-3 text-xs font-semibold text-slate-600"><X className="h-4 w-4"/>Cancelar</button><button disabled={saving || !editDraft.trim()} onClick={() => void update()} className="inline-flex min-h-10 items-center gap-1 rounded-lg bg-emerald-600 px-3 text-xs font-bold text-white"><Save className="h-4 w-4"/>Guardar</button></div></> : <div className="flex gap-3"><div className="min-w-0 flex-1">{item.is_pinned && <span className="mb-1 inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-amber-700"><Pin className="h-3 w-3"/>Fijado</span>}<p className="whitespace-pre-wrap break-words text-sm leading-5 text-slate-700">{item.notes}</p><p className="mt-1 text-[10px] text-slate-400">{item.created_by_name || 'Autor no registrado'} · {new Date(item.created_at).toLocaleString('es-PE')}{item.updated_at !== item.created_at && ` · editado ${new Date(item.updated_at).toLocaleString('es-PE')}`}</p></div><div className="flex shrink-0 gap-1">{item.can_pin && <button onClick={() => void pin(item)} title={item.is_pinned ? 'Desfijar' : 'Fijar'} className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-400 hover:bg-amber-50 hover:text-amber-700"><Pin className="h-4 w-4"/></button>}{item.can_edit && <button onClick={() => { setEditing(item); setEditDraft(item.notes) }} title="Editar" className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"><Edit2 className="h-4 w-4"/></button>}{item.can_delete && <button onClick={() => void remove(item)} title="Eliminar" className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-600"><Trash2 className="h-4 w-4"/></button>}</div></div>}
    </article>)}</div>}
  </section>
}
