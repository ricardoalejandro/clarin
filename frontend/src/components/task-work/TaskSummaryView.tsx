import type { TaskWorkSummary } from '@/types/task'

export default function TaskSummaryView({ summary }: { summary: TaskWorkSummary | null }) {
  const statusGroups = summary?.by_status || []
  const maxStatus = Math.max(1, ...statusGroups.map(item => item.count))
  const workload = summary?.by_owner || []
  const maxWork = Math.max(1, ...workload.map(item => item.count))
  const completion = summary?.total ? Math.round((summary.done / summary.total) * 100) : 0
  if (!summary) return <p role="status" className="p-6 text-sm text-slate-500">Cargando resumen…</p>
  return <div className="space-y-5 pb-8">
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{[
      ['Total', summary?.total || 0, 'text-slate-900'], ['Completadas', summary?.done || 0, 'text-emerald-600'],
      ['En curso', summary?.active || 0, 'text-blue-600'], ['Vencidas', summary?.overdue || 0, 'text-rose-600'],
      ['Progreso', `${Math.round(summary?.progress || 0)}%`, 'text-violet-600'],
    ].map(([label,value,color]) => <div key={label} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><p className="text-xs font-semibold text-slate-400">{label}</p><p className={`mt-2 text-2xl font-black ${color}`}>{value}</p></div>)}</div>
    <div className="grid gap-5 lg:grid-cols-[1fr_1fr_280px]">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><h3 className="text-sm font-bold text-slate-800">Distribución por estado</h3><div className="mt-5 space-y-4">{statusGroups.map(status => <div key={status.id}><div className="mb-1.5 flex justify-between text-xs"><span className="font-medium text-slate-600">{status.name}</span><span className="font-bold text-slate-500">{status.count}</span></div><div className="h-2 rounded-full bg-slate-100"><div className="h-full rounded-full" style={{ width: `${(status.count/maxStatus)*100}%`, backgroundColor: status.color }} /></div></div>)}</div></section>
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><h3 className="text-sm font-bold text-slate-800">Carga del equipo</h3><div className="mt-5 space-y-4">{workload.map(item => <div key={item.id}><div className="mb-1.5 flex justify-between text-xs"><span className="font-medium text-slate-600">{item.name}</span><span className={item.overdue ? 'font-bold text-rose-600' : 'font-bold text-slate-500'}>{item.count}{item.overdue ? ` · ${item.overdue} vencidas` : ''}</span></div><div className="h-2 rounded-full bg-slate-100"><div className={`h-full rounded-full ${item.overdue ? 'bg-rose-400' : 'bg-blue-500'}`} style={{ width: `${(item.count/maxWork)*100}%` }} /></div></div>)}</div></section>
      <section className="flex flex-col items-center justify-center rounded-2xl border border-slate-200 bg-slate-900 p-6 text-white shadow-sm"><div className="relative flex h-36 w-36 items-center justify-center rounded-full" style={{ background: `conic-gradient(#34d399 ${completion * 3.6}deg,#334155 0deg)` }}><div className="flex h-28 w-28 flex-col items-center justify-center rounded-full bg-slate-900"><span className="text-3xl font-black">{completion}%</span><span className="text-[10px] uppercase tracking-wider text-slate-400">completado</span></div></div><p className="mt-5 text-center text-xs leading-5 text-slate-400">{summary?.owners || 0} responsables participan en este ámbito.</p></section>
    </div>
  </div>
}
