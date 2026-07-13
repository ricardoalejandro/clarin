'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Columns3,
  Expand,
  Loader2,
  Minimize2,
  RotateCcw,
  Save,
  Sparkles,
  X,
} from 'lucide-react'
import type { Pipeline } from '@/types/contact'
import StageSequenceEditor from './StageSequenceEditor'
import {
  createManualDraft,
  draftFromPipelineStages,
  draftFromTemplate,
  normalizeDraftPositions,
  serializeStages,
  stageDraftSignature,
  validateStageDraft,
  type DeletedStageDraft,
  type PipelineTemplate,
  type StageDraft,
} from './pipeline-contracts'
import { useAccessibleDialog } from './useAccessibleDialog'

interface PipelineStageManagerProps {
  open: boolean
  pipeline: Pipeline | null
  onClose: () => void
  onSaved: (pipeline: Pipeline) => void | Promise<void>
  incomingStageId?: string
  hiddenStageIds?: Set<string>
  onToggleVisibility?: (stageId: string) => void
}

interface PendingDelete {
  stage: StageDraft
  destinationId: string
}

const focusClass = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2'

function TemplateSetup({ templates, loading, error, onRetry, onSelect, onManual }: {
  templates: PipelineTemplate[]
  loading: boolean
  error: string
  onRetry: () => void
  onSelect: (template: PipelineTemplate) => void
  onManual: () => void
}) {
  return (
    <div className="mx-auto max-w-4xl py-6 sm:py-10">
      <div className="mb-6 text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-700">
          <Sparkles className="h-6 w-6" aria-hidden="true" />
        </div>
        <h3 className="text-lg font-bold text-slate-900">Dale una estructura a este pipeline</h3>
        <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-slate-500">Empieza con una plantilla profesional o crea un recorrido propio. Podrás ajustar nombres, colores y orden antes de guardar.</p>
      </div>
      {loading ? (
        <div className="flex min-h-48 items-center justify-center rounded-2xl border border-slate-200 bg-slate-50" aria-busy="true">
          <Loader2 className="h-6 w-6 animate-spin text-emerald-600 motion-reduce:animate-none" aria-hidden="true" />
          <span className="ml-3 text-sm font-medium text-slate-600">Cargando plantillas…</span>
        </div>
      ) : error ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-center" role="alert">
          <AlertCircle className="mx-auto h-6 w-6 text-red-600" aria-hidden="true" />
          <p className="mt-2 text-sm font-semibold text-red-800">{error}</p>
          <button type="button" onClick={onRetry} className={`mt-4 inline-flex min-h-11 items-center gap-2 rounded-xl bg-white px-4 text-sm font-semibold text-red-700 shadow-sm ring-1 ring-red-200 hover:bg-red-100 ${focusClass}`}>
            <RotateCcw className="h-4 w-4" /> Reintentar
          </button>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {templates.map(template => (
            <button
              key={template.id}
              type="button"
              onClick={() => onSelect(template)}
              className={`group min-h-48 rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-emerald-300 hover:shadow-lg motion-reduce:transform-none ${focusClass}`}
            >
              <span className="inline-flex rounded-full bg-emerald-50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest text-emerald-700">Plantilla sugerida</span>
              <h4 className="mt-3 text-base font-bold text-slate-900">{template.name}</h4>
              <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-slate-500">{template.description}</p>
              <div className="mt-4 flex flex-wrap gap-1.5" aria-label={`${template.stages.length} etapas`}>
                {template.stages.map((stage, index) => <span key={`${stage.name}-${index}`} className="h-2.5 w-6 rounded-full" style={{ backgroundColor: stage.color }} title={stage.name} />)}
              </div>
            </button>
          ))}
          <button type="button" onClick={onManual} className={`min-h-48 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-5 text-left transition hover:border-slate-400 hover:bg-slate-100 ${focusClass}`}>
            <Columns3 className="h-6 w-6 text-slate-500" aria-hidden="true" />
            <h4 className="mt-3 text-base font-bold text-slate-900">Configuración manual</h4>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-500">Comienza con una etapa activa y los resultados Ganado y Perdido protegidos.</p>
          </button>
        </div>
      )}
    </div>
  )
}

export default function PipelineStageManager({ open, pipeline, onClose, onSaved, incomingStageId, hiddenStageIds, onToggleVisibility }: PipelineStageManagerProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const deleteDialogRef = useRef<HTMLDivElement>(null)
  const discardDialogRef = useRef<HTMLDivElement>(null)
  const originalWasEmpty = (pipeline?.stages?.length || 0) === 0
  const [stages, setStages] = useState<StageDraft[]>([])
  const [baseline, setBaseline] = useState('')
  const [deletedStages, setDeletedStages] = useState<DeletedStageDraft[]>([])
  const [effectiveIncomingStageId, setEffectiveIncomingStageId] = useState<string | undefined>(incomingStageId)
  const [incomingReplacementId, setIncomingReplacementId] = useState<string | undefined>()
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)
  const [discardConfirm, setDiscardConfirm] = useState(false)
  const [templates, setTemplates] = useState<PipelineTemplate[]>([])
  const [templatesLoading, setTemplatesLoading] = useState(false)
  const [templatesError, setTemplatesError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [savedMessage, setSavedMessage] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const [maximized, setMaximized] = useState(false)

  const currentSignature = useMemo(() => stageDraftSignature(stages, deletedStages), [stages, deletedStages])
  const dirty = Boolean(pipeline && currentSignature !== baseline)
  const errors = useMemo(() => stages.length ? validateStageDraft(stages) : [], [stages])

  const loadTemplates = useCallback(async () => {
    setTemplatesLoading(true)
    setTemplatesError('')
    try {
      const token = localStorage.getItem('token')
      const response = await fetch('/api/pipeline-templates', { headers: { Authorization: `Bearer ${token}` } })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.success) throw new Error(data?.error || 'No pudimos cargar las plantillas.')
      setTemplates(data.templates || [])
    } catch (error) {
      setTemplatesError(error instanceof Error ? error.message : 'No pudimos cargar las plantillas.')
    } finally {
      setTemplatesLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open || !pipeline) return
    const initialStages = originalWasEmpty ? [] : draftFromPipelineStages(pipeline.stages, true)
    setStages(initialStages)
    setDeletedStages([])
    setIncomingReplacementId(undefined)
    setBaseline(stageDraftSignature(initialStages))
    setPendingDelete(null)
    setDiscardConfirm(false)
    setSaveError('')
    setSavedMessage('')
    try { setMaximized(localStorage.getItem('clarin-stage-manager-maximized') === 'true') } catch {}
    if (originalWasEmpty) void loadTemplates()
  }, [open, pipeline?.id, originalWasEmpty, loadTemplates])

  useEffect(() => {
    if (!open) return
    if (incomingStageId !== undefined) {
      setEffectiveIncomingStageId(incomingStageId || undefined)
      return
    }
    setEffectiveIncomingStageId(undefined)
    let cancelled = false
    const resolveIncomingStage = async () => {
      try {
        const token = localStorage.getItem('token')
        const response = await fetch('/api/settings', { headers: { Authorization: `Bearer ${token}` } })
        const data = await response.json().catch(() => null)
        if (!cancelled && response.ok && data?.success) setEffectiveIncomingStageId(data.account?.default_incoming_stage_id || undefined)
      } catch { /* optional context; backend still validates atomically */ }
    }
    void resolveIncomingStage()
    return () => { cancelled = true }
  }, [incomingStageId, open])

  useEffect(() => {
    if (!open || !dirty) return
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [open, dirty])

  const requestClose = useCallback(() => {
    if (saving) return
    if (dirty) setDiscardConfirm(true)
    else onClose()
  }, [dirty, onClose, saving])

  useAccessibleDialog(open && !discardConfirm && !pendingDelete, dialogRef, requestClose, titleRef)
  const closeDeleteDialog = useCallback(() => setPendingDelete(null), [])
  const closeDiscardDialog = useCallback(() => setDiscardConfirm(false), [])
  useAccessibleDialog(Boolean(pendingDelete), deleteDialogRef, closeDeleteDialog)
  useAccessibleDialog(discardConfirm, discardDialogRef, closeDiscardDialog)

  if (!open || !pipeline) return null

  const activeDestinations = stages.filter(stage => stage.stage_type === 'active')

  const requestDelete = (stage: StageDraft) => {
    if (stages.filter(item => item.stage_type === 'active').length <= 1) {
      setSaveError('El pipeline necesita al menos una etapa activa. Agrega otra antes de eliminar esta.')
      return
    }
    if (!stage.id) {
      setStages(current => normalizeDraftPositions(current.filter(item => item.key !== stage.key)))
      setAnnouncement(`${stage.name} eliminada del borrador.`)
      return
    }
    const candidates = activeDestinations.filter(item => item.id !== stage.id)
    const needsDestination = stage.lead_count > 0 || effectiveIncomingStageId === stage.id
    const usableCandidates = effectiveIncomingStageId === stage.id ? candidates.filter(item => item.id) : candidates
    if (needsDestination && usableCandidates.length === 0) {
      setSaveError('Agrega una etapa activa de destino antes de eliminar esta etapa.')
      return
    }
    setPendingDelete({ stage, destinationId: needsDestination ? usableCandidates[0]?.key || '' : '' })
  }

  const confirmDelete = () => {
    if (!pendingDelete) return
    const needsDestination = pendingDelete.stage.lead_count > 0 || effectiveIncomingStageId === pendingDelete.stage.id
    if (needsDestination && !pendingDelete.destinationId) return
    const destination = activeDestinations.find(item => item.key === pendingDelete.destinationId)
    if (needsDestination && !destination) return
    setStages(current => normalizeDraftPositions(current.filter(item => item.key !== pendingDelete.stage.key)))
    setDeletedStages(current => [...current, {
      id: pendingDelete.stage.id!,
      name: pendingDelete.stage.name,
      lead_count: pendingDelete.stage.lead_count,
      reassign_to_stage_id: destination?.id,
      reassign_to_client_id: destination?.id ? undefined : destination?.key,
    }])
    if (effectiveIncomingStageId === pendingDelete.stage.id) setIncomingReplacementId(destination?.id)
    setAnnouncement(`${pendingDelete.stage.name} se eliminará al guardar.`)
    setPendingDelete(null)
  }

  const handleSave = async () => {
    if (saving || errors.length > 0 || stages.length === 0) return
    const invalidDeletedDestination = deletedStages.find(deleted => {
      if (deleted.lead_count <= 0) return false
      if (deleted.reassign_to_stage_id) return !stages.some(stage => stage.id === deleted.reassign_to_stage_id && stage.stage_type === 'active')
      if (deleted.reassign_to_client_id) return !stages.some(stage => stage.key === deleted.reassign_to_client_id && stage.stage_type === 'active')
      return true
    })
    if (invalidDeletedDestination) {
      setSaveError(`Selecciona a dónde mover las oportunidades de “${invalidDeletedDestination.name}”.`)
      return
    }
    setSaving(true)
    setSaveError('')
    setSavedMessage('')
    try {
      const token = localStorage.getItem('token')
      const response = await fetch(`/api/pipelines/${pipeline.id}/stages/layout`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          stages: serializeStages(stages),
          deleted_stages: deletedStages.map(({ id, reassign_to_stage_id, reassign_to_client_id }) => ({ id, reassign_to_stage_id, reassign_to_client_id })),
          ...(incomingReplacementId ? { default_incoming_stage_id: incomingReplacementId } : {}),
        }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.success) throw new Error(data?.error || 'No se pudieron guardar las etapas. Tu borrador sigue intacto.')
      const savedPipeline: Pipeline = data.pipeline || { ...pipeline, stages: stages.map((stage, position) => ({
        id: stage.id || stage.key,
        pipeline_id: pipeline.id,
        name: stage.name.trim(),
        color: stage.color,
        position,
        stage_type: stage.stage_type,
        lead_count: stage.lead_count,
      })) }
      const refreshedDraft = draftFromPipelineStages(savedPipeline.stages, true)
      setStages(refreshedDraft)
      setDeletedStages([])
      setBaseline(stageDraftSignature(refreshedDraft))
      setSavedMessage('Cambios guardados correctamente.')
      setAnnouncement('Las etapas del pipeline se guardaron correctamente.')
      await onSaved(savedPipeline)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'No se pudieron guardar las etapas. Tu borrador sigue intacto.')
    } finally {
      setSaving(false)
    }
  }

  const toggleMaximized = () => {
    setMaximized(current => {
      const next = !current
      try { localStorage.setItem('clarin-stage-manager-maximized', String(next)) } catch {}
      return next
    })
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/55 p-0 backdrop-blur-sm sm:p-4" onMouseDown={event => { if (event.target === event.currentTarget) requestClose() }}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pipeline-stage-manager-title"
        aria-describedby="pipeline-stage-manager-description"
        tabIndex={-1}
        className={`flex w-full flex-col overflow-hidden bg-white shadow-2xl transition-[width,height,border-radius] motion-reduce:transition-none ${maximized ? 'h-full max-w-none rounded-none' : 'h-full max-w-6xl rounded-none sm:h-[90vh] sm:rounded-3xl'}`}
      >
        <header className="z-20 flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur sm:px-6">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-700">
            <Columns3 className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 ref={titleRef} id="pipeline-stage-manager-title" tabIndex={-1} className="truncate text-base font-bold text-slate-900 outline-none sm:text-lg">Gestionar etapas</h2>
              {dirty && <span className="hidden rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700 sm:inline">Cambios sin guardar</span>}
            </div>
            <p id="pipeline-stage-manager-description" className="truncate text-xs text-slate-500 sm:text-sm">{pipeline.name} · diseña el recorrido de tus oportunidades</p>
          </div>
          <button type="button" onClick={toggleMaximized} className={`hidden h-11 w-11 items-center justify-center rounded-xl text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 sm:inline-flex ${focusClass}`} aria-label={maximized ? 'Restaurar tamaño de la ventana' : 'Maximizar ventana'}>
            {maximized ? <Minimize2 className="h-5 w-5" /> : <Expand className="h-5 w-5" />}
          </button>
          <button type="button" onClick={requestClose} className={`inline-flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 ${focusClass}`} aria-label="Cerrar gestión de etapas">
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50/70 px-4 py-5 sm:px-6 sm:py-6">
          {stages.length === 0 ? (
            <TemplateSetup templates={templates} loading={templatesLoading} error={templatesError} onRetry={loadTemplates} onSelect={template => { setStages(draftFromTemplate(template)); setAnnouncement(`Plantilla ${template.name} aplicada al borrador.`) }} onManual={() => { setStages(createManualDraft()); setAnnouncement('Configuración manual iniciada.') }} />
          ) : (
            <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
              <div className="min-w-0">
                <StageSequenceEditor stages={stages} onChange={next => { setStages(next); setSavedMessage(''); setSaveError('') }} onRequestDelete={requestDelete} disabled={saving} hiddenStageIds={hiddenStageIds} onToggleVisibility={onToggleVisibility} onAnnouncement={setAnnouncement} />
              </div>
              <aside className="xl:sticky xl:top-0 xl:self-start" aria-labelledby="kanban-preview-heading">
                <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                  <div className="border-b border-slate-100 px-4 py-3">
                    <h3 id="kanban-preview-heading" className="text-sm font-bold text-slate-900">Vista previa del Kanban</h3>
                    <p className="mt-0.5 text-xs text-slate-500">Así se verá el recorrido activo.</p>
                  </div>
                  <div className="space-y-2 p-3">
                    {stages.filter(stage => stage.stage_type === 'active').map((stage, index) => (
                      <div key={stage.key} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                        <div className="mb-2 h-1.5 rounded-full" style={{ backgroundColor: stage.color }} />
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-xs font-bold uppercase tracking-wide text-slate-700">{stage.name || 'Sin nombre'}</span>
                          <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-400 ring-1 ring-slate-200">{index + 1}</span>
                        </div>
                        <div className="mt-2 h-12 rounded-lg border border-dashed border-slate-200 bg-white" />
                      </div>
                    ))}
                  </div>
                </div>
                {errors.length > 0 && (
                  <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 p-4" role="alert">
                    <div className="flex gap-2">
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                      <div>
                        <p className="text-xs font-bold text-amber-900">Revisa el borrador</p>
                        <ul className="mt-1.5 space-y-1 text-xs text-amber-800">{errors.map(error => <li key={error}>• {error}</li>)}</ul>
                      </div>
                    </div>
                  </div>
                )}
              </aside>
            </div>
          )}
        </div>

        <footer className="z-20 flex shrink-0 flex-col gap-3 border-t border-slate-200 bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="min-h-5" aria-live="polite" aria-atomic="true">
            {saveError ? <p className="flex items-center gap-2 text-xs font-semibold text-red-700" role="alert"><AlertCircle className="h-4 w-4 shrink-0" />{saveError}</p>
              : savedMessage ? <p className="flex items-center gap-2 text-xs font-semibold text-emerald-700"><CheckCircle2 className="h-4 w-4 shrink-0" />{savedMessage}</p>
              : dirty ? <p className="text-xs text-slate-500">Tus cambios están en borrador hasta que los guardes.</p>
              : <p className="text-xs text-slate-400">Todo está actualizado.</p>}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={requestClose} disabled={saving} className={`min-h-11 flex-1 rounded-xl border border-slate-200 px-4 text-sm font-semibold text-slate-600 transition hover:bg-slate-50 disabled:opacity-50 sm:flex-none ${focusClass}`}>Cerrar</button>
            <button type="button" onClick={handleSave} disabled={saving || !dirty || errors.length > 0 || stages.length === 0} className={`inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 text-sm font-bold text-white shadow-sm shadow-emerald-200 transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-45 sm:flex-none ${focusClass}`}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Save className="h-4 w-4" />}
              {saving ? 'Guardando…' : 'Guardar cambios'}
            </button>
          </div>
        </footer>
      </div>

      <p className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>

      {pendingDelete && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/45 p-4" role="presentation">
          <div ref={deleteDialogRef} role="alertdialog" aria-modal="true" aria-labelledby="delete-stage-title" tabIndex={-1} className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-red-50 text-red-700"><AlertCircle className="h-5 w-5" /></div>
            <h3 id="delete-stage-title" className="mt-4 text-lg font-bold text-slate-900">Eliminar “{pendingDelete.stage.name}”</h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">
              {pendingDelete.stage.lead_count > 0 ? `Hay ${pendingDelete.stage.lead_count} oportunidad${pendingDelete.stage.lead_count === 1 ? '' : 'es'} en esta etapa. Elige a qué etapa existente se moverán.` : 'La etapa desaparecerá cuando guardes los cambios.'}
            </p>
            {(pendingDelete.stage.lead_count > 0 || effectiveIncomingStageId === pendingDelete.stage.id) && (
              <div className="mt-4">
                <label htmlFor="delete-stage-destination" className="mb-1.5 block text-xs font-bold text-slate-700">Etapa de destino</label>
                <select id="delete-stage-destination" autoFocus value={pendingDelete.destinationId} onChange={event => setPendingDelete(current => current ? { ...current, destinationId: event.target.value } : null)} className={`h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-800 ${focusClass}`}>
                  <option value="">Selecciona una etapa</option>
                  {activeDestinations
                    .filter(stage => stage.id !== pendingDelete.stage.id)
                    .filter(stage => effectiveIncomingStageId !== pendingDelete.stage.id || Boolean(stage.id))
                    .map(stage => <option key={stage.key} value={stage.key}>{stage.name}{stage.id ? '' : ' · nueva'}</option>)}
                </select>
                {effectiveIncomingStageId === pendingDelete.stage.id && <p className="mt-2 text-xs leading-relaxed text-amber-700">También será la nueva etapa predeterminada para oportunidades entrantes.</p>}
              </div>
            )}
            <div className="mt-6 flex gap-2">
              <button type="button" onClick={() => setPendingDelete(null)} className={`min-h-11 flex-1 rounded-xl border border-slate-200 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 ${focusClass}`}>Cancelar</button>
              <button type="button" onClick={confirmDelete} disabled={(pendingDelete.stage.lead_count > 0 || effectiveIncomingStageId === pendingDelete.stage.id) && !pendingDelete.destinationId} className={`inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-red-600 px-4 text-sm font-bold text-white hover:bg-red-700 disabled:opacity-45 ${focusClass}`}><Check className="h-4 w-4" />Eliminar</button>
            </div>
          </div>
        </div>
      )}

      {discardConfirm && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/45 p-4">
          <div ref={discardDialogRef} role="alertdialog" aria-modal="true" aria-labelledby="discard-stage-title" tabIndex={-1} className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-50 text-amber-700"><AlertCircle className="h-5 w-5" /></div>
            <h3 id="discard-stage-title" className="mt-4 text-lg font-bold text-slate-900">¿Descartar los cambios?</h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">Los nombres, colores y posiciones que aún no guardaste se perderán.</p>
            <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row">
              <button type="button" autoFocus onClick={() => setDiscardConfirm(false)} className={`min-h-11 flex-1 rounded-xl border border-slate-200 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 ${focusClass}`}>Seguir editando</button>
              <button type="button" onClick={() => { setDiscardConfirm(false); onClose() }} className={`min-h-11 flex-1 rounded-xl bg-red-600 px-4 text-sm font-bold text-white hover:bg-red-700 ${focusClass}`}>Descartar cambios</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
