'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, ArrowLeft, ArrowRight, Check, CheckCircle2, Columns3, Loader2, Plus, RotateCcw, Sparkles, X } from 'lucide-react'
import type { Pipeline } from '@/types/contact'
import StageSequenceEditor from './StageSequenceEditor'
import {
  createManualDraft,
  draftFromTemplate,
  serializeStages,
  validateStageDraft,
  type PipelineTemplate,
  type StageDraft,
} from './pipeline-contracts'
import { useAccessibleDialog } from './useAccessibleDialog'

interface PipelineCreationWizardProps {
  open: boolean
  onClose: () => void
  onCreated: (pipeline: Pipeline) => void | Promise<void>
}

type Selection = { kind: 'template'; template: PipelineTemplate } | { kind: 'manual' }

const focusClass = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2'

export default function PipelineCreationWizard({ open, onClose, onCreated }: PipelineCreationWizardProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const discardDialogRef = useRef<HTMLDivElement>(null)
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [templates, setTemplates] = useState<PipelineTemplate[]>([])
  const [templatesLoading, setTemplatesLoading] = useState(false)
  const [templatesError, setTemplatesError] = useState('')
  const [selection, setSelection] = useState<Selection | null>(null)
  const [stages, setStages] = useState<StageDraft[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const [discardConfirm, setDiscardConfirm] = useState(false)

  const dirty = Boolean(name.trim() || description.trim() || selection || stages.length)
  const stageErrors = useMemo(() => stages.length ? validateStageDraft(stages) : [], [stages])

  const loadTemplates = useCallback(async () => {
    setTemplatesLoading(true)
    setTemplatesError('')
    try {
      const token = localStorage.getItem('token')
      const response = await fetch('/api/pipeline-templates', { headers: { Authorization: `Bearer ${token}` } })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.success) throw new Error(data?.error || 'No pudimos cargar las plantillas.')
      setTemplates(data.templates || [])
    } catch (loadError) {
      setTemplatesError(loadError instanceof Error ? loadError.message : 'No pudimos cargar las plantillas.')
    } finally {
      setTemplatesLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    setStep(1)
    setName('')
    setDescription('')
    setSelection(null)
    setStages([])
    setSaving(false)
    setError('')
    setAnnouncement('')
    setDiscardConfirm(false)
    void loadTemplates()
  }, [open, loadTemplates])

  const requestClose = useCallback(() => {
    if (saving) return
    if (dirty) setDiscardConfirm(true)
    else onClose()
  }, [dirty, onClose, saving])

  useAccessibleDialog(open && !discardConfirm, dialogRef, requestClose, nameRef)
  const closeDiscardDialog = useCallback(() => setDiscardConfirm(false), [])
  useAccessibleDialog(discardConfirm, discardDialogRef, closeDiscardDialog)

  if (!open) return null

  const chooseSelection = (next: Selection) => {
    setSelection(next)
    setStages(next.kind === 'template' ? draftFromTemplate(next.template) : createManualDraft())
    setError('')
  }

  const createPipeline = async () => {
    if (saving || !name.trim() || stageErrors.length > 0 || stages.length === 0) return
    setSaving(true)
    setError('')
    try {
      const token = localStorage.getItem('token')
      const response = await fetch('/api/pipelines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          ...(selection?.kind === 'template' ? { template_id: selection.template.id } : {}),
          stages: serializeStages(stages),
        }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.success || !data.pipeline) throw new Error(data?.error || 'No pudimos crear el pipeline. Revisa los datos e inténtalo otra vez.')
      setAnnouncement(`Pipeline ${name.trim()} creado correctamente.`)
      await onCreated(data.pipeline)
      onClose()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'No pudimos crear el pipeline.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/55 p-0 backdrop-blur-sm sm:p-4" onMouseDown={event => { if (event.target === event.currentTarget) requestClose() }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="pipeline-wizard-title" aria-describedby="pipeline-wizard-description" tabIndex={-1} className="flex h-full w-full max-w-6xl flex-col overflow-hidden bg-white shadow-2xl sm:h-[90vh] sm:rounded-3xl">
        <header className="shrink-0 border-b border-slate-200 bg-white px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-700"><Plus className="h-5 w-5" /></div>
            <div className="min-w-0 flex-1">
              <h2 id="pipeline-wizard-title" className="text-base font-bold text-slate-900 sm:text-lg">Crear pipeline</h2>
              <p id="pipeline-wizard-description" className="truncate text-xs text-slate-500 sm:text-sm">Configura un recorrido claro en solo tres pasos.</p>
            </div>
            <button type="button" onClick={requestClose} disabled={saving} className={`inline-flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-50 ${focusClass}`} aria-label="Cerrar asistente"><X className="h-5 w-5" /></button>
          </div>
          <ol className="mt-4 grid grid-cols-3 gap-2" aria-label="Progreso de creación">
            {[
              { number: 1, label: 'Información' },
              { number: 2, label: 'Punto de partida' },
              { number: 3, label: 'Personalizar' },
            ].map(item => {
              const active = step === item.number
              const completed = step > item.number
              return (
                <li key={item.number} className={`flex min-h-10 items-center gap-2 rounded-xl px-2.5 text-xs font-semibold sm:px-3 ${active ? 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200' : completed ? 'text-emerald-700' : 'text-slate-400'}`} aria-current={active ? 'step' : undefined}>
                  <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] ${active ? 'bg-emerald-600 text-white' : completed ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{completed ? <Check className="h-3.5 w-3.5" /> : item.number}</span>
                  <span className="hidden truncate sm:block">{item.label}</span>
                </li>
              )
            })}
          </ol>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto bg-slate-50/70 px-4 py-6 sm:px-6">
          {step === 1 && (
            <div className="mx-auto max-w-2xl py-3 sm:py-10">
              <div className="mb-6">
                <span className="text-xs font-bold uppercase tracking-widest text-emerald-700">Paso 1 de 3</span>
                <h3 className="mt-2 text-2xl font-bold tracking-tight text-slate-900">¿Qué proceso quieres organizar?</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-500">Un nombre reconocible ayuda al equipo a elegir el pipeline correcto.</p>
              </div>
              <div className="space-y-5 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
                <div>
                  <label htmlFor="pipeline-name" className="mb-2 block text-sm font-bold text-slate-800">Nombre del pipeline <span className="text-red-600" aria-hidden="true">*</span></label>
                  <input ref={nameRef} id="pipeline-name" value={name} onChange={event => setName(event.target.value)} maxLength={120} placeholder="Ej. Ventas corporativas" className={`h-12 w-full rounded-xl border border-slate-300 bg-white px-4 text-base font-semibold text-slate-900 placeholder:font-normal placeholder:text-slate-400 ${focusClass}`} aria-required="true" />
                  <div className="mt-1.5 flex justify-between gap-3 text-xs text-slate-400"><span>Usa un nombre que tu equipo identifique al instante.</span><span className="tabular-nums">{name.length}/120</span></div>
                </div>
                <div>
                  <label htmlFor="pipeline-description" className="mb-2 block text-sm font-bold text-slate-800">Descripción <span className="font-normal text-slate-400">(opcional)</span></label>
                  <textarea id="pipeline-description" value={description} onChange={event => setDescription(event.target.value)} maxLength={500} rows={4} placeholder="Explica cuándo debe utilizarse este pipeline…" className={`w-full resize-none rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm leading-relaxed text-slate-900 placeholder:text-slate-400 ${focusClass}`} />
                  <p className="mt-1.5 text-right text-xs tabular-nums text-slate-400">{description.length}/500</p>
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="mx-auto max-w-5xl py-2">
              <div className="mb-6">
                <span className="text-xs font-bold uppercase tracking-widest text-emerald-700">Paso 2 de 3</span>
                <h3 className="mt-2 text-2xl font-bold tracking-tight text-slate-900">Elige un punto de partida</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-500">Las plantillas ahorran tiempo; todo seguirá siendo editable antes de crear.</p>
              </div>
              {templatesLoading ? (
                <div className="flex min-h-64 items-center justify-center rounded-3xl border border-slate-200 bg-white" aria-busy="true"><Loader2 className="h-6 w-6 animate-spin text-emerald-600 motion-reduce:animate-none" /><span className="ml-3 text-sm font-semibold text-slate-600">Cargando plantillas…</span></div>
              ) : templatesError ? (
                <div className="rounded-3xl border border-red-200 bg-red-50 p-8 text-center" role="alert"><AlertCircle className="mx-auto h-7 w-7 text-red-600" /><p className="mt-3 text-sm font-bold text-red-800">{templatesError}</p><button type="button" onClick={loadTemplates} className={`mt-5 inline-flex min-h-11 items-center gap-2 rounded-xl bg-white px-4 text-sm font-bold text-red-700 ring-1 ring-red-200 hover:bg-red-100 ${focusClass}`}><RotateCcw className="h-4 w-4" />Reintentar</button></div>
              ) : (
                <fieldset>
                  <legend className="sr-only">Plantilla del pipeline</legend>
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    {templates.map(template => {
                      const selected = selection?.kind === 'template' && selection.template.id === template.id
                      return (
                        <label key={template.id} className={`relative min-h-56 cursor-pointer rounded-2xl border bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-emerald-500 has-[:focus-visible]:ring-offset-2 motion-reduce:transform-none ${selected ? 'border-emerald-500 ring-2 ring-emerald-100' : 'border-slate-200 hover:border-emerald-300'}`}>
                          <input type="radio" name="pipeline-template" value={template.id} checked={selected} onChange={() => chooseSelection({ kind: 'template', template })} className="sr-only" />
                          <div className="flex items-start justify-between gap-3"><Sparkles className="h-6 w-6 text-emerald-600" /><span className={`flex h-6 w-6 items-center justify-center rounded-full border ${selected ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-slate-300 bg-white'}`}>{selected && <Check className="h-3.5 w-3.5" />}</span></div>
                          <h4 className="mt-4 text-base font-bold text-slate-900">{template.name}</h4>
                          <p className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-slate-500">{template.description}</p>
                          <div className="mt-4 flex flex-wrap gap-1.5">{template.stages.map((stage, index) => <span key={`${stage.name}-${index}`} className="h-2.5 w-6 rounded-full" style={{ backgroundColor: stage.color }} title={stage.name} />)}</div>
                          <p className="mt-2 text-[11px] font-semibold text-slate-400">{template.stages.length} etapas</p>
                        </label>
                      )
                    })}
                    <label className={`relative min-h-56 cursor-pointer rounded-2xl border border-dashed bg-slate-50 p-5 transition hover:bg-slate-100 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-emerald-500 has-[:focus-visible]:ring-offset-2 ${selection?.kind === 'manual' ? 'border-emerald-500 ring-2 ring-emerald-100' : 'border-slate-300'}`}>
                      <input type="radio" name="pipeline-template" value="manual" checked={selection?.kind === 'manual'} onChange={() => chooseSelection({ kind: 'manual' })} className="sr-only" />
                      <div className="flex items-start justify-between"><Columns3 className="h-6 w-6 text-slate-600" /><span className={`flex h-6 w-6 items-center justify-center rounded-full border ${selection?.kind === 'manual' ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-slate-300 bg-white'}`}>{selection?.kind === 'manual' && <Check className="h-3.5 w-3.5" />}</span></div>
                      <h4 className="mt-4 text-base font-bold text-slate-900">Configuración manual</h4>
                      <p className="mt-1.5 text-xs leading-relaxed text-slate-500">Construye tu recorrido desde cero con Ganado y Perdido ya protegidos.</p>
                    </label>
                  </div>
                </fieldset>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="mx-auto max-w-5xl">
              <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <span className="text-xs font-bold uppercase tracking-widest text-emerald-700">Paso 3 de 3</span>
                  <h3 className="mt-2 text-2xl font-bold tracking-tight text-slate-900">Hazlo tuyo</h3>
                  <p className="mt-2 text-sm leading-relaxed text-slate-500">Ajusta el orden, los nombres y los colores. Nada se crea hasta confirmar.</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-right shadow-sm"><p className="text-xs text-slate-400">Pipeline</p><p className="max-w-xs truncate text-sm font-bold text-slate-800">{name}</p></div>
              </div>
              <StageSequenceEditor stages={stages} onChange={next => { setStages(next); setError('') }} onRequestDelete={stage => { if (stages.filter(item => item.stage_type === 'active').length <= 1) setError('El pipeline necesita al menos una etapa activa.'); else setStages(current => current.filter(item => item.key !== stage.key)) }} disabled={saving} onAnnouncement={setAnnouncement} />
              {stageErrors.length > 0 && <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4" role="alert"><p className="text-sm font-bold text-amber-900">Antes de crear:</p><ul className="mt-1.5 space-y-1 text-xs text-amber-800">{stageErrors.map(stageError => <li key={stageError}>• {stageError}</li>)}</ul></div>}
            </div>
          )}
        </main>

        <footer className="shrink-0 border-t border-slate-200 bg-white px-4 py-3 sm:px-6">
          <div className="mb-2 min-h-5" aria-live="polite">{error && <p className="flex items-center gap-2 text-xs font-semibold text-red-700" role="alert"><AlertCircle className="h-4 w-4" />{error}</p>}</div>
          <div className="flex items-center justify-between gap-3">
            <button type="button" onClick={() => step > 1 ? setStep((step - 1) as 1 | 2) : requestClose()} disabled={saving} className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-slate-200 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 ${focusClass}`}>
              {step > 1 && <ArrowLeft className="h-4 w-4" />}{step > 1 ? 'Atrás' : 'Cancelar'}
            </button>
            {step < 3 ? (
              <button type="button" onClick={() => setStep((step + 1) as 2 | 3)} disabled={(step === 1 && !name.trim()) || (step === 2 && (!selection || templatesLoading || Boolean(templatesError)))} className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 text-sm font-bold text-white shadow-sm shadow-emerald-200 hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-45 ${focusClass}`}>Continuar <ArrowRight className="h-4 w-4" /></button>
            ) : (
              <button type="button" onClick={createPipeline} disabled={saving || stageErrors.length > 0 || !name.trim()} className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 text-sm font-bold text-white shadow-sm shadow-emerald-200 hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-45 ${focusClass}`}>{saving ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <CheckCircle2 className="h-4 w-4" />}{saving ? 'Creando…' : 'Crear pipeline'}</button>
            )}
          </div>
        </footer>
      </div>
      <p className="sr-only" aria-live="polite">{announcement}</p>

      {discardConfirm && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/45 p-4">
          <div ref={discardDialogRef} role="alertdialog" aria-modal="true" aria-labelledby="discard-pipeline-title" tabIndex={-1} className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-50 text-amber-700"><AlertCircle className="h-5 w-5" /></div>
            <h3 id="discard-pipeline-title" className="mt-4 text-lg font-bold text-slate-900">¿Salir sin crear el pipeline?</h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">La información y la configuración de etapas de este borrador se perderán.</p>
            <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row"><button type="button" autoFocus onClick={() => setDiscardConfirm(false)} className={`min-h-11 flex-1 rounded-xl border border-slate-200 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 ${focusClass}`}>Seguir configurando</button><button type="button" onClick={() => { setDiscardConfirm(false); onClose() }} className={`min-h-11 flex-1 rounded-xl bg-red-600 px-4 text-sm font-bold text-white hover:bg-red-700 ${focusClass}`}>Descartar borrador</button></div>
          </div>
        </div>
      )}
    </div>
  )
}
