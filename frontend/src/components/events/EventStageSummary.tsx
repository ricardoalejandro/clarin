'use client'

export interface EventStageSummaryItem { id: string | null; name: string; color: string; position: number; count: number }

export function EventStageSummary({ stages = [], total }: { stages?: EventStageSummaryItem[]; total: number }) {
  const populated = stages.filter(stage => stage.count > 0)
  if (total === 0) return <span className="text-xs text-slate-400">Sin participantes</span>
  if (!populated.length) return <span className="text-xs text-slate-500">{total.toLocaleString('es-PE')} participantes</span>
  return <div className="min-w-0 space-y-2">
    <div className="flex h-1.5 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
      {populated.map(stage => <span key={stage.id ?? 'unassigned'} style={{ width: `${100 * stage.count / total}%`, backgroundColor: stage.color }} />)}
    </div>
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] leading-4 text-slate-500">
      {populated.map(stage => <span key={stage.id ?? 'unassigned'} className="inline-flex min-w-0 items-center gap-1.5">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: stage.color }} />
        <span>{stage.name}</span><span className="font-semibold tabular-nums text-slate-700">{stage.count.toLocaleString('es-PE')}</span>
      </span>)}
    </div>
  </div>
}
