'use client'

import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Layers3, Loader2, X } from 'lucide-react'
import { api } from '@/lib/api'
import type { SurveyInstanceSummary, SurveyTemplate } from '@/types/survey-template'
import SurveyInstanceNameField from './SurveyInstanceNameField'
import { useAccessibleDialog } from '@/components/pipelines/useAccessibleDialog'

export default function StandaloneSurveyApplicationDialog({ template, onClose, onCreated }: {
  template: SurveyTemplate
  onClose: () => void
  onCreated: (instance: SurveyInstanceSummary) => void
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const [name, setName] = useState('')
  const [nameAvailable, setNameAvailable] = useState<boolean | null>(null)
  const [opensAt, setOpensAt] = useState('')
  const [closesAt, setClosesAt] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [conflictSuggestion, setConflictSuggestion] = useState('')

  useAccessibleDialog(true, dialogRef, () => { if (!creating) onClose() })

  const create = async () => {
    if (creating || !name.trim() || nameAvailable === false) return
    if (opensAt && closesAt && new Date(closesAt) <= new Date(opensAt)) {
      setError('El cierre debe ser posterior a la apertura.')
      return
    }
    setCreating(true); setError(''); setConflictSuggestion('')
    try {
      const response = await api<SurveyInstanceSummary & { suggested_name?: string }>(`/api/survey-templates/${template.id}/instances`, {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), status: 'active', audience_mode: 'public', opens_at: opensAt ? new Date(opensAt).toISOString() : null, closes_at: closesAt ? new Date(closesAt).toISOString() : null }),
      })
      if (!response.success || !response.data) {
        if (response.status === 409 && response.data?.suggested_name) setConflictSuggestion(response.data.suggested_name)
        throw new Error(response.error || 'No se pudo crear la aplicación.')
      }
      onCreated(response.data)
    } catch (creationError) {
      setError(creationError instanceof Error ? creationError.message : 'No se pudo crear la aplicación.')
    } finally { setCreating(false) }
  }

  return createPortal(<div className="fixed inset-0 z-[95] flex items-end justify-center bg-slate-950/50 backdrop-blur-[1px] sm:items-center sm:p-4" onMouseDown={event => { if (event.target === event.currentTarget && !creating) onClose() }}>
    <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="standalone-survey-title" className="flex max-h-[100dvh] w-full flex-col overflow-hidden bg-white shadow-2xl outline-none sm:max-w-lg sm:rounded-3xl">
      <header className="flex items-start gap-3 border-b border-slate-100 px-4 py-4 sm:px-5">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700"><Layers3 className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1"><h2 id="standalone-survey-title" className="text-lg font-bold text-slate-900">Aplicación pública</h2><p className="mt-0.5 text-sm leading-5 text-slate-500">Creará una copia inmutable de la plantilla v{template.revision}. Las aplicaciones de Programa se crean desde Programas.</p></div>
        <button type="button" onClick={onClose} disabled={creating} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 disabled:opacity-50" aria-label="Cerrar"><X className="h-5 w-5" /></button>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-5">
        <SurveyInstanceNameField templateId={template.id} value={name} onChange={setName} onAvailabilityChange={setNameAvailable} autoFocus />
        <div className="grid gap-4 sm:grid-cols-2"><label className="block"><span className="mb-1.5 block text-sm font-semibold text-slate-700">Apertura <span className="font-normal text-slate-400">(opcional)</span></span><input type="datetime-local" value={opensAt} onChange={event => setOpensAt(event.target.value)} className="min-h-11 w-full rounded-xl border border-slate-200 px-3 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100" /></label><label className="block"><span className="mb-1.5 block text-sm font-semibold text-slate-700">Cierre <span className="font-normal text-slate-400">(opcional)</span></span><input type="datetime-local" value={closesAt} onChange={event => setClosesAt(event.target.value)} className="min-h-11 w-full rounded-xl border border-slate-200 px-3 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100" /></label></div>
        {error && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"><p>{error}</p>{conflictSuggestion && <button type="button" onClick={() => setName(conflictSuggestion)} className="mt-2 min-h-9 rounded-lg bg-white px-3 text-xs font-semibold shadow-sm">Usar “{conflictSuggestion}”</button>}</div>}
      </div>
      <footer className="flex gap-3 border-t border-slate-100 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-5"><button type="button" onClick={onClose} disabled={creating} className="min-h-11 flex-1 rounded-xl border border-slate-200 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">Cancelar</button><button type="button" onClick={() => void create()} disabled={creating || !name.trim() || nameAvailable === false} className="inline-flex min-h-11 flex-[1.4] items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50">{creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Layers3 className="h-4 w-4" />}Crear aplicación</button></footer>
    </div>
  </div>, document.body)
}
