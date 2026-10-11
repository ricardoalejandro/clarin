'use client'

import { ArrowRight, Clock3, FileSearch, HardDrive, Loader2, ShieldCheck, Trash2 } from 'lucide-react'
import { formatStorageBytes, type StorageRecommendation, type StorageUsage } from './storageModel'

const descriptions = {
  large_files: { title: 'Archivos grandes', description: 'Revisa archivos de al menos 10 MiB.', icon: HardDrive },
  older_files: { title: 'Archivos antiguos', description: 'Cargados hace al menos 180 días. Su antigüedad no significa que hayan dejado de usarse.', icon: Clock3 },
  unused_uploads: { title: 'Mis cargas sin utilizar', description: 'Cargas tuyas verificadas, sin usos actuales y con al menos un día de antigüedad.', icon: FileSearch },
  trash_ready: { title: 'Papelera para revisar', description: 'La retención mínima terminó. Revisa las referencias antes del borrado definitivo.', icon: Trash2 },
} as const

export function StorageRecommendations({ usage, onChoose, disabled }: { usage: StorageUsage | null; onChoose: (recommendation: StorageRecommendation) => void; disabled: boolean }) {
  if (!usage) return null
  const recommendations = (usage.recommendations || []).filter(item => item.count > 0 && item.id in descriptions)
  const pending = usage.catalog_status === 'indexing'
  const degraded = usage.catalog_status === 'degraded'
  return <>
    {(pending || degraded || usage.inventory_complete === false) && <div role="status" className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      {pending ? <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" /> : <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />}
      <p>{pending ? 'Estamos verificando el inventario.' : 'La verificación del inventario no está completa.'} Los datos disponibles pueden cambiar.{usage.last_verified_at && Number.isFinite(Date.parse(usage.last_verified_at)) && <> Última verificación: {new Date(usage.last_verified_at).toLocaleString('es-PE')}.</>}</p>
    </div>}
    {recommendations.length > 0 && <section aria-label="Sugerencias para revisar" className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-sm font-semibold text-slate-800">Por dónde empezar</h2><p className="text-xs text-slate-500">Tamaño de los archivos a revisar; todavía no es espacio liberado.</p></div>
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 230px), 1fr))' }}>
        {recommendations.map(recommendation => {
          const { title, description, icon: Icon } = descriptions[recommendation.id]
          return <button key={recommendation.id} type="button" onClick={() => onChoose(recommendation)} disabled={disabled} className="group flex min-h-11 items-start gap-3 rounded-2xl border border-slate-200 bg-white p-3 text-left transition-colors hover:border-emerald-300 hover:bg-emerald-50/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:cursor-not-allowed disabled:opacity-50">
            <Icon className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
            <span className="min-w-0 flex-1"><span className="block text-sm font-semibold text-slate-800">{title}</span><span className="mt-1 block text-sm text-slate-700">{recommendation.count.toLocaleString('es-PE')} archivo{recommendation.count === 1 ? '' : 's'} · {formatStorageBytes(recommendation.bytes)}</span><span className="mt-1 block text-xs leading-5 text-slate-500">{description}</span></span>
            <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-slate-400 group-hover:text-emerald-600" />
          </button>
        })}
      </div>
    </section>}
  </>
}
