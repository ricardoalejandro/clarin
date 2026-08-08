'use client'

import { BriefcaseBusiness, CircleDollarSign, GitBranch, Trophy } from 'lucide-react'
import type { Lead } from '@/types/contact'

type Props = { lead: Lead; embedded?: boolean }

function lifecycleLabel(status: string) {
  if (status === 'won') return 'Ganada'
  if (status === 'lost') return 'Perdida'
  return 'Abierta'
}

export default function LeadContextPanel({ lead, embedded = false }: Props) {
  const stageColor = lead.stage_color || lead.lead_stage_color || '#10B981'
  return (
    <section className={embedded ? '' : 'rounded-2xl border border-emerald-100 bg-white p-4 shadow-sm'} aria-labelledby="lead-context-title">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[.16em] text-emerald-700"><BriefcaseBusiness className="h-3.5 w-3.5" />Oportunidad</p>
          <h3 id="lead-context-title" className="mt-1 truncate text-base font-bold text-slate-900">{lead.title || lead.name || 'Oportunidad sin título'}</h3>
          <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-500"><GitBranch className="h-3.5 w-3.5" />{lead.pipeline_name || lead.lead_pipeline_name || 'Pipeline principal'}</p>
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ${lead.status === 'won' ? 'bg-emerald-50 text-emerald-700' : lead.status === 'lost' ? 'bg-rose-50 text-rose-700' : 'bg-blue-50 text-blue-700'}`}>{lead.status === 'won' ? <Trophy className="h-3.5 w-3.5" /> : <CircleDollarSign className="h-3.5 w-3.5" />}{lifecycleLabel(lead.status)}</span>
      </div>
      <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
        <div className="min-w-0"><p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Etapa actual</p><p className="truncate text-sm font-bold text-slate-800">{lead.stage_name || lead.lead_stage_name || 'Sin etapa'}</p></div>
        <span className="h-3.5 w-3.5 shrink-0 rounded-full ring-4 ring-white" style={{ backgroundColor: stageColor }} />
      </div>
    </section>
  )
}
