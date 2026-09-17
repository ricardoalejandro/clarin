'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Loader2, LockKeyhole, Search, ShieldCheck, UserRound, X } from 'lucide-react'
import { useDebouncedValue } from '@/lib/useDebouncedValue'
import { searchTaskLocationViewAccessCandidates } from '@/lib/taskLocationViewsApi'
import type {
  TaskLocationViewScopeType, TaskLocationViewVisibilityCandidate,
  TaskLocationViewVisibilityMember, TaskLocationViewVisibilityMode,
} from '@/types/task'

export type TaskLocationViewSelectedMember = TaskLocationViewVisibilityCandidate & { eligible?: boolean }

const accessLabels: Record<string, string> = {
  view: 'Puede ver', comment: 'Puede comentar', edit: 'Puede editar', full: 'Puede administrar', none: 'Sin acceso actual',
}

export function selectedVisibilityMembers(members: TaskLocationViewVisibilityMember[]): TaskLocationViewSelectedMember[] {
  return members.map(member => ({
    user_id: member.user_id,
    display_name: member.display_name,
    username: member.username,
    effective_access_level: member.effective_access_level,
    eligible: member.eligible,
  }))
}

export default function TaskLocationViewVisibilityFields({
  scopeType,
  scopeID,
  canManageAccess,
  mode,
  selected,
  onMode,
  onSelected,
  disabled = false,
}: {
  scopeType: TaskLocationViewScopeType
  scopeID: string
  canManageAccess: boolean
  mode: TaskLocationViewVisibilityMode
  selected: TaskLocationViewSelectedMember[]
  onMode: (mode: TaskLocationViewVisibilityMode) => void
  onSelected: (members: TaskLocationViewSelectedMember[]) => void
  disabled?: boolean
}) {
  const [query, setQuery] = useState('')
  const [settledQuery] = useDebouncedValue(query)
  const [candidates, setCandidates] = useState<TaskLocationViewVisibilityCandidate[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const generationRef = useRef(0)

  useEffect(() => {
    if (mode !== 'restricted' || !canManageAccess) {
      generationRef.current += 1
      setCandidates([])
      setLoading(false)
      setError('')
      return
    }
    const generation = ++generationRef.current
    const controller = new AbortController()
    setLoading(true)
    setError('')
    void searchTaskLocationViewAccessCandidates({
      scopeType,
      scopeID,
      query: settledQuery,
      signal: controller.signal,
    }).then(result => {
      if (generation !== generationRef.current) return
      setLoading(false)
      if (!result.success) {
        if (result.status !== 0) setError(result.error || 'No se pudieron buscar personas con acceso.')
        return
      }
      setCandidates(result.data?.users || [])
    })
    return () => controller.abort()
  }, [canManageAccess, mode, scopeID, scopeType, settledQuery])

  const selectedIDs = useMemo(() => new Set(selected.map(member => member.user_id)), [selected])
  const available = candidates.filter(candidate => !selectedIDs.has(candidate.user_id))

  const chooseMode = (next: TaskLocationViewVisibilityMode) => {
    if (disabled || next === 'restricted' && !canManageAccess) return
    onMode(next)
    if (next === 'inherit') onSelected([])
  }

  return <section className="mt-5 rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
    <div className="flex items-start gap-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white text-violet-700 shadow-sm"><ShieldCheck className="h-4 w-4" /></span>
      <div><h3 className="text-sm font-black text-slate-800">Quién puede verla</h3><p className="mt-1 text-xs leading-5 text-slate-500">La pizarra nunca concede más permisos: cada persona conserva el nivel de esta ubicación de Work.</p></div>
    </div>
    <div className="mt-4 grid gap-2 sm:grid-cols-2">
      <button type="button" disabled={disabled} onClick={() => chooseMode('inherit')} aria-pressed={mode === 'inherit'} className={`min-h-20 rounded-xl border p-3 text-left transition ${mode === 'inherit' ? 'border-emerald-300 bg-emerald-50 ring-2 ring-emerald-100' : 'border-slate-200 bg-white hover:border-slate-300'} disabled:opacity-50`}><span className="flex items-center gap-2 text-xs font-black text-slate-800"><ShieldCheck className="h-4 w-4 text-emerald-600" />Toda la ubicación</span><span className="mt-1 block text-[11px] leading-4 text-slate-500">La ven quienes pueden ver la Lista o Carpeta.</span></button>
      <button type="button" disabled={disabled || !canManageAccess} onClick={() => chooseMode('restricted')} aria-pressed={mode === 'restricted'} title={!canManageAccess ? 'Necesitas gobernar el acceso de esta ubicación.' : undefined} className={`min-h-20 rounded-xl border p-3 text-left transition ${mode === 'restricted' ? 'border-violet-300 bg-violet-50 ring-2 ring-violet-100' : 'border-slate-200 bg-white hover:border-slate-300'} disabled:cursor-not-allowed disabled:opacity-45`}><span className="flex items-center gap-2 text-xs font-black text-slate-800"><LockKeyhole className="h-4 w-4 text-violet-600" />Personas seleccionadas</span><span className="mt-1 block text-[11px] leading-4 text-slate-500">Además de administradores y gestores de acceso.</span></button>
    </div>
    {mode === 'restricted' && canManageAccess && <div className="mt-4">
      <label className="block text-xs font-black uppercase tracking-[.12em] text-slate-500">Añadir personas</label>
      <div className="relative mt-2"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input value={query} disabled={disabled} onChange={event => setQuery(event.target.value)} placeholder="Buscar por nombre o usuario" className="h-11 w-full rounded-xl border border-slate-200 bg-white pl-10 pr-10 text-sm outline-none focus:border-violet-400 focus:ring-4 focus:ring-violet-100 disabled:opacity-50" />{(loading || query !== settledQuery) && <Loader2 aria-label="Buscando personas" className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-violet-500" />}</div>
      {(available.length > 0 || error) && <div className="mt-2 max-h-48 overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5 shadow-sm">
        {available.map(candidate => <button key={candidate.user_id} type="button" disabled={disabled} onClick={() => { onSelected([...selected, candidate]); setQuery('') }} className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left hover:bg-violet-50 disabled:opacity-50"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-violet-100 text-[10px] font-black text-violet-700">{(candidate.display_name || candidate.username).slice(0, 2).toUpperCase()}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-bold text-slate-800">{candidate.display_name || candidate.username}</span><span className="block truncate text-[11px] text-slate-400">@{candidate.username} · {accessLabels[candidate.effective_access_level]}</span></span><Check className="h-4 w-4 text-violet-600" /></button>)}
        {error && <p role="alert" className="px-3 py-2 text-xs font-semibold text-rose-700">{error}</p>}
      </div>}
      <div className="mt-3 space-y-2">
        {selected.map(member => <div key={member.user_id} className="flex min-h-11 items-center gap-3 rounded-xl border border-slate-200 bg-white px-3"><UserRound className="h-4 w-4 shrink-0 text-slate-400" /><span className="min-w-0 flex-1"><span className="block truncate text-xs font-bold text-slate-700">{member.display_name || member.username}</span><span className={`block text-[10px] ${member.eligible === false ? 'font-semibold text-amber-700' : 'text-slate-400'}`}>{member.eligible === false ? 'Sin acceso actual a la ubicación' : accessLabels[member.effective_access_level]}</span></span><button type="button" disabled={disabled} onClick={() => onSelected(selected.filter(candidate => candidate.user_id !== member.user_id))} aria-label={`Quitar a ${member.display_name || member.username}`} className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"><X className="h-4 w-4" /></button></div>)}
        {!selected.length && <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">Selecciona al menos una persona para crear o guardar una pizarra restringida.</p>}
      </div>
    </div>}
  </section>
}
