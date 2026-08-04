'use client'

import { FormEvent, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowRight, ClipboardList, Loader2, X } from 'lucide-react'
import { api } from '@/lib/api'
import type { SurveyTemplate } from '@/types/survey-template'
import { useAccessibleDialog } from '@/components/pipelines/useAccessibleDialog'

export default function CreateSurveyTemplateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (template: SurveyTemplate) => void }) {
  const dialogRef = useRef<HTMLFormElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const dirty = Boolean(name.trim() || description.trim())

  const requestClose = () => {
    if (creating) return
    if (dirty && !window.confirm('Hay información sin guardar. ¿Quieres descartar esta nueva plantilla?')) return
    onClose()
  }
  useAccessibleDialog(true, dialogRef, requestClose, nameRef)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim() || creating) return
    setCreating(true); setError('')
    const response = await api<SurveyTemplate>('/api/survey-templates', { method: 'POST', body: JSON.stringify({ name: name.trim(), description: description.trim() }) })
    setCreating(false)
    if (!response.success || !response.data) {
      setError(response.error || 'No se pudo crear la plantilla.')
      return
    }
    onCreated(response.data)
  }

  return createPortal(<div className="fixed inset-0 z-[90] flex items-end justify-center bg-slate-950/50 backdrop-blur-[1px] sm:items-center sm:p-4" onMouseDown={event => { if (event.target === event.currentTarget) requestClose() }}>
    <form ref={dialogRef} tabIndex={-1} onSubmit={event => void submit(event)} role="dialog" aria-modal="true" aria-labelledby="new-survey-template-title" className="flex max-h-[100dvh] w-full flex-col overflow-hidden bg-white shadow-2xl outline-none sm:max-w-[520px] sm:rounded-3xl">
      <header className="flex items-start gap-3 border-b border-slate-100 p-4 sm:p-5">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700"><ClipboardList className="h-6 w-6" /></span>
        <div className="min-w-0 flex-1"><h2 id="new-survey-template-title" className="text-xl font-bold text-slate-900">Nueva plantilla</h2><p className="mt-1 text-sm leading-5 text-slate-500">Crea la base privada. En el siguiente paso diseñarás preguntas, apariencia y medición.</p></div>
        <button type="button" onClick={requestClose} disabled={creating} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 disabled:opacity-50" aria-label="Cerrar"><X className="h-5 w-5" /></button>
      </header>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 sm:p-5">
        <div className="rounded-2xl border border-emerald-100 bg-emerald-50/70 px-4 py-3"><p className="text-sm font-semibold text-emerald-900">La plantilla todavía no será pública</p><p className="mt-1 text-xs leading-5 text-emerald-700">Solo recibirá respuestas cuando generes una aplicación independiente o desde un Programa.</p></div>
        <label className="block"><span className="mb-1.5 flex items-center justify-between gap-3 text-sm font-semibold text-slate-700"><span>Nombre</span><span className="text-xs font-normal tabular-nums text-slate-400">{name.length}/180</span></span><input ref={nameRef} value={name} onChange={event => setName(event.target.value)} maxLength={180} placeholder="Ej. Satisfacción del programa" className="min-h-12 w-full rounded-xl border border-slate-200 px-3.5 text-sm outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100" /></label>
        <label className="block"><span className="mb-1.5 block text-sm font-semibold text-slate-700">Descripción <span className="font-normal text-slate-400">(opcional)</span></span><textarea value={description} onChange={event => setDescription(event.target.value)} rows={4} placeholder="Explica cuándo y para qué debe usarse." className="w-full resize-none rounded-xl border border-slate-200 p-3.5 text-sm leading-6 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100" /></label>
        {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}
      </div>
      <footer className="flex gap-3 border-t border-slate-100 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-5"><button type="button" onClick={requestClose} disabled={creating} className="min-h-11 flex-1 rounded-xl border border-slate-200 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">Cancelar</button><button type="submit" disabled={!name.trim() || creating} className="inline-flex min-h-11 flex-[1.35] items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50">{creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}Crear y diseñar</button></footer>
    </form>
  </div>, document.body)
}
