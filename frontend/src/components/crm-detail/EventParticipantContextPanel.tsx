'use client'

import { AlertCircle, CalendarDays, CheckCircle2, GitBranch, Loader2, RefreshCw, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { EventRelatedLeadSummary } from '@/components/LeadDetailPanel'

export type EventParticipantContext = {
  id: string
  stage_id?: string | null
  stage_name?: string | null
  stage_color?: string | null
  membership_state?: string
  membership_source?: string
  membership_reason?: string
  auto_tag_sync?: boolean
  membership_changed_at?: string
}

type Stage = { id: string; name: string; color: string }
type Props = {
  participant: EventParticipantContext
  eventName: string
  stages: Stage[]
  relatedLeads?: EventRelatedLeadSummary[]
  relatedLeadsLoading?: boolean
  relatedLeadsError?: string
  readOnly?: boolean
  readOnlyReason?: 'event' | 'participant'
  onStageChange: (stageId: string) => Promise<boolean> | boolean
  onRetryRelatedLeads?: () => void
  embedded?: boolean
}

function membershipLabel(value?: string) {
  if (value === 'inactive') return 'Fuera del evento'
  return 'Participación activa'
}

export default function EventParticipantContextPanel({ participant, eventName, stages, relatedLeads = [], relatedLeadsLoading = false, relatedLeadsError = '', readOnly = false, readOnlyReason, onStageChange, onRetryRelatedLeads, embedded = false }: Props) {
  const [stageId, setStageId] = useState(participant.stage_id || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { setStageId(participant.stage_id || ''); setError('') }, [participant.id, participant.stage_id])

  const changeStage = async (next: string) => {
    if (!next || next === stageId || saving || readOnly) return
    const previous = stageId
    setStageId(next)
    setSaving(true)
    setError('')
    const saved = await onStageChange(next)
    setSaving(false)
    if (!saved) {
      setStageId(previous)
      setError('No se pudo cambiar la etapa. Restauramos la etapa anterior.')
    }
  }

  const activeStage = stages.find(stage => stage.id === stageId)
  return (
    <section className={embedded ? '' : 'rounded-2xl border border-violet-100 bg-white p-4 shadow-sm'} aria-labelledby="event-participant-context-title">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0"><p className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[.16em] text-violet-700"><CalendarDays className="h-3.5 w-3.5" />Participación en evento</p><h3 id="event-participant-context-title" className="mt-1 truncate text-base font-bold text-slate-900">{eventName || 'Evento'}</h3></div>
        <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ${participant.membership_state === 'inactive' ? 'bg-slate-100 text-slate-600' : 'bg-emerald-50 text-emerald-700'}`}><CheckCircle2 className="h-3.5 w-3.5" />{membershipLabel(participant.membership_state)}</span>
      </div>

      {readOnly && <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span>{readOnlyReason === 'participant' ? 'Esta participación ya no está activa. Sus datos se conservan como historial de solo lectura.' : 'El evento está finalizado o cancelado. La participación se conserva como historial de solo lectura.'}</span></div>}

      <label className="mt-4 block"><span className="mb-1.5 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-slate-400"><GitBranch className="h-3.5 w-3.5" />Etapa del evento</span><div className="relative"><span className="pointer-events-none absolute left-3 top-3.5 h-3.5 w-3.5 rounded-full" style={{ backgroundColor: activeStage?.color || participant.stage_color || '#94A3B8' }} /><select value={stageId} onChange={event => { void changeStage(event.target.value) }} disabled={readOnly || saving} className="h-11 w-full appearance-none rounded-xl border border-slate-200 bg-slate-50 pl-9 pr-10 text-sm font-bold text-slate-800 outline-none focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"><option value="" disabled>Sin etapa</option>{stages.map(stage => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select>{saving && <Loader2 className="pointer-events-none absolute right-3 top-3.5 h-4 w-4 animate-spin text-emerald-600" />}</div></label>
      {error && <p role="alert" className="mt-2 text-xs font-medium text-red-600">{error}</p>}

      <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50/70 p-3"><div className="flex items-center justify-between gap-3"><div><p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Origen de participación</p><p className="mt-1 text-xs font-semibold text-slate-700">{participant.membership_source === 'rule' ? 'Regla automática' : participant.membership_source === 'manual' ? 'Añadida manualmente' : 'Registro del evento'}</p></div>{participant.auto_tag_sync && <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-1 text-[10px] font-bold text-violet-700"><Sparkles className="h-3 w-3" />Sincronizada</span>}</div>{participant.membership_reason && <p className="mt-2 text-[11px] leading-5 text-slate-500">{participant.membership_reason}</p>}</div>

      <div className="mt-4"><div className="flex items-center justify-between"><p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Oportunidades relacionadas</p><span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600">{relatedLeads.length}</span></div>{relatedLeadsLoading ? <div className="mt-2 flex min-h-16 items-center justify-center"><Loader2 className="h-4 w-4 animate-spin text-emerald-600" /></div> : relatedLeadsError ? <div className="mt-2 flex items-center gap-2 rounded-xl border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700"><span className="min-w-0 flex-1">{relatedLeadsError}</span>{onRetryRelatedLeads && <button type="button" onClick={onRetryRelatedLeads} aria-label="Reintentar oportunidades" className="inline-flex h-9 w-9 items-center justify-center rounded-lg hover:bg-red-100"><RefreshCw className="h-4 w-4" /></button>}</div> : relatedLeads.length ? <div className="mt-2 space-y-2">{relatedLeads.slice(0, 4).map(lead => <div key={lead.id} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5"><span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: lead.stage_color || '#94A3B8' }} /><div className="min-w-0 flex-1"><p className="truncate text-xs font-bold text-slate-800">{lead.title || 'Oportunidad'}</p><p className="truncate text-[10px] text-slate-400">{lead.pipeline_name || 'Pipeline'} · {lead.stage_name || 'Sin etapa'}</p></div></div>)}</div> : <p className="mt-2 rounded-xl border border-dashed border-slate-200 px-3 py-4 text-center text-xs text-slate-400">Sin oportunidades relacionadas.</p>}</div>
    </section>
  )
}
