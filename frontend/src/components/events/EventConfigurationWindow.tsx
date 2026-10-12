'use client'

import { useEffect, useRef, useState } from 'react'
import { CalendarDays, Check, ChevronRight, Layers3, Loader2, LockKeyhole, Settings2, Tag } from 'lucide-react'
import { api, subscribeWebSocket } from '@/lib/api'
import { getAuthScope, subscribeAuthScope } from '@/lib/authScope'
import OperationalWindowShell from '@/components/operational-window/OperationalWindowShell'
import OperationalDatePicker from '@/components/operational-date/OperationalDatePicker'
import { TaskColorPicker } from '@/components/task-work/TaskContainerAppearance'
import { TaskSelectPicker } from '@/components/task-work/TaskSelectPicker'
import { isEventContextReadOnly } from '@/app/dashboard/events/eventForm'
import EventStageEditor from './EventStageEditor'
import EventRulesEditor from './EventRulesEditor'
import EventConfigurationConfirm from './EventConfigurationConfirm'
import {
  emptyEventData, emptyEventRule, eventDataDraft, eventConfigurationDataPayload,
  eventStageDrafts, eventStagePayload, eventStageSignature, eventRulePayload, eventRuleSignature,
  type EventConfigurationRecord, type EventConfigurationSection, type EventDataDraft,
  type EventRuleDraft, type EventRuleImpact, type EventRuleTag, type EventStageDraft, type EventStageLayout,
} from './eventConfiguration'

export type EventConfigurationSaveResult = {
  event?: EventConfigurationRecord; pipeline_id?: string | null; stages?: EventStageLayout['stages']
  stage_id_map?: Record<string, string>; [key: string]: unknown
}
export interface EventConfigurationWindowProps {
  open: boolean
  eventId?: string
  initialSection?: EventConfigurationSection
  folderId?: string | null
  storageScope?: string
  onClose: () => void
  onSaved?: (eventId: string, section: EventConfigurationSection, result: EventConfigurationSaveResult) => void | Promise<void>
  onCreated?: (eventId: string) => void | Promise<void>
}
const sections = [
  { id: 'data' as const, label: 'Datos', icon: CalendarDays },
  { id: 'stages' as const, label: 'Etapas', icon: Layers3 },
  { id: 'rules' as const, label: 'Reglas', icon: Tag },
]
const fieldClass = 'min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100 disabled:bg-slate-50 disabled:text-slate-500'
const labelClass = 'mb-1.5 block text-sm font-medium text-slate-700'
class ConfigurationError extends Error {
  constructor(message: string, public status?: number) { super(message) }
}
async function request<T extends { success?: boolean; error?: string }>(path: string, signal: AbortSignal, method = 'GET', body?: unknown) {
  const response = await api<T>(path, { signal, method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  if (!response.success || !response.data || response.data.success === false) throw new ConfigurationError(response.error || response.data?.error || 'No se pudo completar la operación.', response.status)
  return response.data
}
export default function EventConfigurationWindow({ open, eventId, initialSection = 'data', folderId, storageScope, onClose, onSaved, onCreated }: EventConfigurationWindowProps) {
  const [section, setSection] = useState<EventConfigurationSection>(initialSection)
  const [record, setRecord] = useState<EventConfigurationRecord | null>(null)
  const [closedRemotely, setClosedRemotely] = useState(false)
  const [activeId, setActiveId] = useState<string | undefined>(eventId)
  const [data, setData] = useState<EventDataDraft>(emptyEventData)
  const [dataBase, setDataBase] = useState<EventDataDraft>(emptyEventData)
  const [layout, setLayout] = useState<EventStageLayout | null>(null)
  const [stages, setStages] = useState<EventStageDraft[]>([])
  const [rule, setRule] = useState<EventRuleDraft>(emptyEventRule)
  const [ruleBase, setRuleBase] = useState<EventRuleDraft>(emptyEventRule)
  const [ruleLoaded, setRuleLoaded] = useState(false)
  const [loading, setLoading] = useState<EventConfigurationSection | null>(null)
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<Partial<Record<EventConfigurationSection, string>>>({})
  const [conflicts, setConflicts] = useState<Partial<Record<EventConfigurationSection, boolean>>>({})
  const [notice, setNotice] = useState('')
  const [confirm, setConfirm] = useState<'discard' | 'lifecycle' | 'reload' | null>(null)
  const [impact, setImpact] = useState<EventRuleImpact | null>(null)
  const [retry, setRetry] = useState(0)
  const generation = useRef(0)
  const requests = useRef(new Set<AbortController>())
  const busy = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollPositions = useRef<Record<EventConfigurationSection, number>>({ data: 0, stages: 0, rules: 0 })
  const callbacks = useRef({ onClose, onSaved, onCreated })
  callbacks.current = { onClose, onSaved, onCreated }
  const newController = () => { const controller = new AbortController(); requests.current.add(controller); return controller }
  const release = (controller: AbortController) => requests.current.delete(controller)
  const dirty = {
    data: JSON.stringify(data) !== JSON.stringify(dataBase),
    stages: Boolean(layout && eventStageSignature(stages) !== eventStageSignature(eventStageDrafts(layout))),
    rules: ruleLoaded && eventRuleSignature(rule) !== eventRuleSignature(ruleBase),
  }
  const hasChanges = Object.values(dirty).some(Boolean)
  const currentMetadataDraft = useRef({ dataBase, dirty: dirty.data })
  currentMetadataDraft.current = { dataBase, dirty: dirty.data }
  const readOnly = closedRemotely || isEventContextReadOnly(record?.status)
  useEffect(() => {
    const session = ++generation.current
    requests.current.forEach(controller => controller.abort()); requests.current.clear()
    busy.current = false
    setActiveId(eventId); setSection(eventId ? initialSection : 'data'); setRecord(null); setClosedRemotely(false)
    setData(emptyEventData()); setDataBase(emptyEventData()); setLayout(null); setStages([])
    setRule(emptyEventRule()); setRuleBase(emptyEventRule()); setRuleLoaded(false)
    setErrors({}); setConflicts({}); setNotice(''); setSaving(false); setConfirm(null); setImpact(null)
    scrollPositions.current = { data: 0, stages: 0, rules: 0 }
    if (!open || !eventId) { setLoading(null); return }
    setLoading('data')
    const controller = newController()
    void request<{ success: boolean; event: EventConfigurationRecord }>('/api/events/' + eventId, controller.signal).then(result => {
      if (generation.current !== session || controller.signal.aborted) return
      setRecord(result.event); setData(eventDataDraft(result.event)); setDataBase(eventDataDraft(result.event))
    }).catch(error => {
      if (generation.current === session && !controller.signal.aborted) setErrors({ data: error.message })
    }).finally(() => {
      release(controller)
      if (generation.current === session && !controller.signal.aborted) setLoading(null)
    })
    return () => { generation.current++; requests.current.forEach(controller => controller.abort()); requests.current.clear() }
  // A section request is navigation inside the current window, not a new draft session.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, eventId])
  useEffect(() => {
    if (open && eventId && !busy.current) setSection(initialSection)
  }, [open, eventId, initialSection])
  useEffect(() => subscribeAuthScope(() => {
    generation.current++; requests.current.forEach(controller => controller.abort()); requests.current.clear()
    if (open) callbacks.current.onClose()
  }), [open])
  useEffect(() => {
    if (!open || !activeId || !record || section === 'data' || (section === 'stages' && layout) || (section === 'rules' && ruleLoaded)) return
    const currentSection = section, session = generation.current, controller = newController()
    setLoading(currentSection); setErrors(previous => ({ ...previous, [currentSection]: undefined }))
    const path = '/api/events/' + activeId + (currentSection === 'stages' ? '/stages/layout' : '/tags')
    void request<EventStageLayout & { success: boolean; tags?: EventRuleTag[]; formula_mode?: 'OR' | 'AND'; tag_formula_type?: 'simple' | 'advanced'; tag_formula?: string }>(path, controller.signal).then(result => {
      if (generation.current !== session || controller.signal.aborted) return
      if (currentSection === 'stages') { setLayout(result); setStages(eventStageDrafts(result)) }
      else {
        const loaded: EventRuleDraft = { formula_mode: result.formula_mode || 'OR', tag_formula_type: result.tag_formula_type || 'simple', tag_formula: result.tag_formula || '', tags: result.tags || [] }
        setRule(loaded); setRuleBase(loaded); setRuleLoaded(true)
      }
    }).catch(error => {
      if (generation.current === session && !controller.signal.aborted) setErrors(previous => ({ ...previous, [currentSection]: error.message }))
    }).finally(() => {
      release(controller)
      if (generation.current === session && !controller.signal.aborted) setLoading(null)
    })
    return () => { controller.abort(); release(controller); setLoading(current => current === currentSection ? null : current) }
  }, [open, activeId, record, section, layout, ruleLoaded, retry])
  const changeSection = (next: EventConfigurationSection) => {
    if (saving || !activeId || !record) return
    if (scrollRef.current) scrollPositions.current[section] = scrollRef.current.scrollTop
    setSection(next); setNotice('')
    requestAnimationFrame(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollPositions.current[next] })
  }
  const close = () => { if (busy.current) return; if (hasChanges) setConfirm('discard'); else callbacks.current.onClose() }
  const reportSaved = async (id: string, savedSection: EventConfigurationSection, result: EventConfigurationSaveResult, session: number) => {
    if (generation.current !== session) return
    try { await callbacks.current.onSaved?.(id, savedSection, result) }
    catch { if (generation.current === session) setNotice('Cambios guardados. Actualiza el listado si aún no refleja el resultado.') }
  }
  const runSave = async (savedSection: EventConfigurationSection, operation: (controller: AbortController, session: number) => Promise<void>) => {
    if (busy.current) return
    busy.current = true; setSaving(true); setNotice(''); setErrors(previous => ({ ...previous, [savedSection]: undefined }))
    const controller = newController(), session = generation.current
    try { await operation(controller, session) }
    catch (error) {
      if (generation.current !== session || controller.signal.aborted) return
      setErrors(previous => ({ ...previous, [savedSection]: error instanceof Error ? error.message : 'No se pudo guardar.' }))
      if (error instanceof ConfigurationError && error.status === 409) { setConflicts(previous => ({ ...previous, [savedSection]: true })); setImpact(null); await refreshMetadata(controller, session) }
    } finally {
      release(controller)
      if (generation.current === session) { busy.current = false; setSaving(false) }
    }
  }
  const saveData = (confirmed = false) => {
    if (readOnly) return
    if (activeId && data.status !== record?.status) {
      if (dirty.stages || dirty.rules) { setErrors(previous => ({ ...previous, data: 'Guarda o descarta los cambios de Etapas y Reglas antes de cambiar el estado.' })); return }
      if (!confirmed) { setConfirm('lifecycle'); return }
    }
    setConfirm(null)
    void runSave('data', async (controller, session) => {
      const payload = eventConfigurationDataPayload(data, record), isNew = !activeId
      const result = await request<{ success: boolean; event: EventConfigurationRecord }>('/api/events' + (activeId ? '/' + activeId : ''), controller.signal, activeId ? 'PUT' : 'POST', { ...payload, ...(isNew ? { status: 'draft', folder_id: folderId || null } : { expected_updated_at: record?.updated_at }) })
      if (generation.current !== session || controller.signal.aborted) return
      setRecord(result.event); setData(eventDataDraft(result.event)); setDataBase(eventDataDraft(result.event)); setActiveId(result.event.id)
      setConflicts(previous => ({ ...previous, data: false })); setNotice(isNew ? 'Borrador creado. Configura etapas y reglas; actívalo desde Datos cuando esté listo.' : 'Datos guardados.')
      await reportSaved(result.event.id, 'data', result, session)
      if (isNew && generation.current === session && !controller.signal.aborted) { try { await callbacks.current.onCreated?.(result.event.id) } catch { /* The saved event remains available. */ } }
    })
  }
  const acceptCanonicalMetadata = (canonicalEvent: EventConfigurationRecord) => {
    const closed = isEventContextReadOnly(canonicalEvent.status)
    setClosedRemotely(closed)
    if (closed) { setImpact(null); setConfirm(current => current === 'lifecycle' ? null : current) }
    const canonical = eventDataDraft(canonicalEvent), current = currentMetadataDraft.current
    if (JSON.stringify(canonical) === JSON.stringify(current.dataBase)) setRecord(canonicalEvent)
    else if (!current.dirty) {
      setRecord(canonicalEvent); setData(canonical); setDataBase(canonical)
    } else {
      setErrors(previous => ({ ...previous, data: 'Los datos cambiaron en otra sesión. Tu borrador se conserva; recarga Datos para revisarlos.' }))
      setConflicts(previous => ({ ...previous, data: true }))
    }
  }
  // Context saves may advance updated_at. Refresh only the canonical metadata
  // baseline that is still equivalent, so a remote edit never blesses a stale draft.
  const refreshMetadata = async (controller: AbortController, session: number) => {
    if (!activeId) return
    try {
      const result = await request<{ success: boolean; event: EventConfigurationRecord }>('/api/events/' + activeId, controller.signal)
      if (generation.current !== session || controller.signal.aborted) return
      acceptCanonicalMetadata(result.event)
    } catch {
      if (generation.current === session && !controller.signal.aborted) setNotice('Cambios guardados. No se pudo actualizar la información del evento; vuelve a cargar Datos antes de editarlo.')
    }
  }
  useEffect(() => {
    if (!open || !activeId) return
    let controller: AbortController | undefined
    const unsubscribe = subscribeWebSocket((message: unknown) => {
      const envelope = message as { event?: string; data?: { event_id?: string }; event_id?: string }
      if (envelope.event !== 'event_update' || (envelope.data?.event_id ?? envelope.event_id) !== activeId) return
      if (controller) { controller.abort(); release(controller) }
      controller = newController()
      const pending = controller, session = generation.current
      void refreshMetadata(pending, session).finally(() => release(pending))
    })
    return () => { unsubscribe(); if (controller) { controller.abort(); release(controller) } }
  }, [open, activeId])
  const saveStages = () => {
    if (!activeId || !layout || readOnly) return
    void runSave('stages', async (controller, session) => {
      const result = await request<EventStageLayout>('/api/events/' + activeId + '/stages/layout', controller.signal, 'PUT', eventStagePayload(stages, layout.revision))
      if (generation.current !== session || controller.signal.aborted) return
      setLayout(result); setStages(eventStageDrafts(result)); setConflicts(previous => ({ ...previous, stages: false })); setNotice('Etapas guardadas.')
      await refreshMetadata(controller, session)
      await reportSaved(activeId, 'stages', { ...result }, session)
    })
  }
  const previewRules = () => {
    if (!activeId || readOnly) return
    void runSave('rules', async (controller, session) => {
      const result = await request<{ success: boolean; impact: EventRuleImpact }>('/api/events/' + activeId + '/tags/preview', controller.signal, 'POST', eventRulePayload(rule))
      if (generation.current !== session || controller.signal.aborted) return
      setImpact(result.impact)
    })
  }
  const applyRules = () => {
    if (!activeId || !impact || readOnly) return
    void runSave('rules', async (controller, session) => {
      const result = await request<{ success: boolean; [key: string]: unknown }>('/api/events/' + activeId + '/tags', controller.signal, 'PUT', { ...eventRulePayload(rule), expected_rule_revision: impact.rule_revision, preview_fingerprint: impact.fingerprint, confirm: true })
      if (generation.current !== session || controller.signal.aborted) return
      setRuleBase(rule); setImpact(null); setConflicts(previous => ({ ...previous, rules: false })); setNotice('Reglas aplicadas; el historial se conserva.')
      await refreshMetadata(controller, session)
      await reportSaved(activeId, 'rules', result, session)
    })
  }
  const reloadSection = () => {
    setConfirm(null); setConflicts(previous => ({ ...previous, [section]: false })); setErrors(previous => ({ ...previous, [section]: undefined }))
    if (record && section === 'stages') setLayout(null)
    else if (record && section === 'rules') { setRuleLoaded(false); setImpact(null) }
    else if (activeId) {
      void runSave('data', async (controller, session) => {
        const result = await request<{ success: boolean; event: EventConfigurationRecord }>('/api/events/' + activeId, controller.signal)
        if (generation.current !== session || controller.signal.aborted) return
        setRecord(result.event); setData(eventDataDraft(result.event)); setDataBase(eventDataDraft(result.event))
      })
    }
    setRetry(value => value + 1)
  }
  const unavailable = Boolean(activeId && !record)
  const currentError = errors[section] || (unavailable ? errors.data : undefined)
  const sectionReady = !unavailable && (section === 'data' || (section === 'stages' ? Boolean(layout) : ruleLoaded))
  const disabled = saving || readOnly
  const updateData = (patch: Partial<EventDataDraft>) => { setData(previous => ({ ...previous, ...patch })); setNotice('') }
  const statusOptions = record?.status === 'active'
    ? [{ value: 'active', label: 'Activo' }, { value: 'completed', label: 'Completado', description: 'Conservar historial y cerrar edición' }, { value: 'cancelled', label: 'Cancelado', description: 'Cerrar el evento conservando el historial' }]
    : record?.status === 'draft'
      ? [{ value: 'draft', label: 'Borrador' }, { value: 'active', label: 'Activo', description: 'Aplicar reglas guardadas y abrir participación' }, { value: 'cancelled', label: 'Cancelado' }]
      : [{ value: data.status, label: readOnly ? data.status === 'completed' ? 'Completado' : 'Cancelado' : 'Borrador' }]
  const submitLabel = section === 'data' ? activeId ? 'Guardar datos' : 'Crear borrador' : section === 'stages' ? 'Guardar etapas' : 'Revisar impacto'
  return <>
    <OperationalWindowShell open={open} storageKey="clarin:event-configuration" storageScope={storageScope || getAuthScope()} title={record?.name || 'Nuevo evento'} eyebrow="Configuración del evento" icon={Settings2} defaultMode="floating" defaultWidth={920} defaultHeight={760} minWidth={520} minHeight={480} dockedWidth={672} busy={saving} onRequestClose={close} dataAttribute="event-configuration" temporaryOverlaySelector="[data-operational-confirmation], [data-operational-picker-backdrop], [data-task-picker-backdrop], [data-task-color-picker]" contentClassName="flex min-h-0 flex-1 flex-col"
      footer={<div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 bg-white px-4 py-3 sm:px-6">
        <p className="text-xs text-slate-500">{readOnly ? 'Historial de solo lectura' : hasChanges ? 'Hay cambios sin guardar' : 'Cambios guardados'}</p>
        <div className="ml-auto flex gap-2"><button type="button" disabled={saving} onClick={close} className="min-h-11 rounded-xl px-4 text-sm font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-40">Cerrar</button>{!readOnly && <button type="button" disabled={saving || loading !== null || !sectionReady || (activeId ? !dirty[section] : !data.name.trim()) || conflicts[section]} onClick={() => { if (section === 'data') saveData(); else if (section === 'stages') saveStages(); else previewRules() }} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-40">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{saving ? 'Guardando…' : submitLabel}</button>}</div>
      </div>}>
      <nav aria-label="Secciones de configuración" className="flex shrink-0 gap-1 border-b border-slate-100 px-3 py-2 sm:px-5" role="tablist" onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || saving || !activeId || !record) return
        event.preventDefault()
        const index = sections.findIndex(item => item.id === section)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + sections.length) % sections.length
        changeSection(sections[next].id)
        event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
      }}>{sections.map(item => <button key={item.id} type="button" role="tab" aria-selected={section === item.id} aria-controls={'event-configuration-' + item.id} disabled={saving || (item.id !== 'data' && (!activeId || !record))} onClick={() => changeSection(item.id)} className={'inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl px-3 text-sm font-semibold transition disabled:opacity-35 sm:flex-none ' + (section === item.id ? 'bg-emerald-50 text-emerald-700' : 'text-slate-500 hover:bg-slate-50')}><item.icon className="h-4 w-4" />{item.label}{dirty[item.id] && <span aria-label="Cambios sin guardar" className="h-1.5 w-1.5 rounded-full bg-amber-500" />}</button>)}</nav>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6" role="tabpanel" id={'event-configuration-' + section}>
        {readOnly && <p className="mb-4 flex items-center gap-2 rounded-xl bg-slate-100 p-3 text-sm text-slate-600"><LockKeyhole className="h-4 w-4 shrink-0" />Este evento está cerrado. Su configuración e historial se conservan.</p>}
        {notice && <p role="status" className="mb-4 rounded-xl border border-emerald-100 bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</p>}
        {currentError && <div role="alert" className="mb-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"><p>{currentError}</p>{conflicts[section] ? <button type="button" className="mt-2 min-h-11 rounded-lg bg-white px-3 font-semibold" onClick={() => setConfirm('reload')}>Recargar esta sección</button> : !sectionReady && <button type="button" className="mt-2 min-h-11 rounded-lg bg-white px-3 font-semibold" onClick={reloadSection}>Reintentar</button>}</div>}
        {(loading !== null && !sectionReady) || (unavailable && !currentError) ? <div role="status" className="flex items-center justify-center gap-3 py-16 text-sm text-slate-500"><Loader2 className="h-5 w-5 animate-spin text-emerald-600" />Cargando configuración…</div> : sectionReady && <>
          {section === 'data' && <div className="space-y-5">
            {!activeId && <p className="rounded-xl bg-slate-50 p-3 text-sm leading-6 text-slate-600">Crea el borrador para preparar sus etapas y reglas. Podrás activarlo cuando esté listo.</p>}
            <div><label className={labelClass} htmlFor="event-configuration-name">Nombre del evento</label><input id="event-configuration-name" autoFocus maxLength={255} value={data.name} disabled={disabled} onChange={event => updateData({ name: event.target.value })} className={fieldClass} placeholder="Nombre del evento" /></div>
            <div><label className={labelClass} htmlFor="event-configuration-description">Descripción</label><textarea id="event-configuration-description" rows={3} value={data.description} disabled={disabled} onChange={event => updateData({ description: event.target.value })} className={fieldClass + ' resize-y'} placeholder="Propósito y detalles del evento" /></div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2"><div><span className={labelClass}>Inicio</span><OperationalDatePicker mode="datetime" label="Inicio del evento" value={data.event_date} onChange={event_date => updateData({ event_date })} disabled={disabled} showQuickValues={false} /></div><div><span className={labelClass}>Fin</span><OperationalDatePicker mode="datetime" label="Fin del evento" value={data.event_end} onChange={event_end => updateData({ event_end })} disabled={disabled} showQuickValues={false} min={data.event_date.slice(0, 10)} /></div></div>
            <div><label className={labelClass} htmlFor="event-configuration-location">Ubicación</label><input id="event-configuration-location" value={data.location} disabled={disabled} onChange={event => updateData({ location: event.target.value })} className={fieldClass} placeholder="Lugar o enlace de reunión" /></div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2"><div><span className={labelClass}>Color de identificación</span><TaskColorPicker value={data.color} onChange={color => updateData({ color })} disabled={disabled} label="Color del evento" /></div><div><span className={labelClass}>Estado</span><TaskSelectPicker value={data.status} options={statusOptions} onChange={status => updateData({ status })} label="Estado del evento" disabled={disabled || !activeId} /></div></div>
            {activeId && data.status === 'draft' && <button type="button" disabled={saving} onClick={() => changeSection('stages')} className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-emerald-700">Continuar con etapas<ChevronRight className="h-4 w-4" /></button>}
          </div>}
          {section === 'stages' && <EventStageEditor stages={stages} disabled={disabled} onChange={next => { setStages(next); setNotice('') }} />}
          {section === 'rules' && <EventRulesEditor value={rule} disabled={disabled} onChange={next => { setRule(next); setImpact(null); setNotice('') }} />}
        </>}
      </div>
    </OperationalWindowShell>
    {open && confirm === 'discard' && <EventConfigurationConfirm title="Descartar cambios pendientes" confirmLabel="Descartar y cerrar" destructive onCancel={() => setConfirm(null)} onConfirm={() => { setConfirm(null); callbacks.current.onClose() }}><p>Se descartarán únicamente los borradores sin guardar de {sections.filter(item => dirty[item.id]).map(item => item.label).join(', ')}. Los cambios ya guardados se conservarán.</p></EventConfigurationConfirm>}
    {open && confirm === 'reload' && <EventConfigurationConfirm title="Recargar la sección" confirmLabel="Reemplazar mi borrador" onCancel={() => setConfirm(null)} onConfirm={reloadSection}><p>El borrador de {sections.find(item => item.id === section)?.label} se reemplazará por la versión actual del servidor. Los borradores de las otras secciones se conservan.</p></EventConfigurationConfirm>}
    {open && confirm === 'lifecycle' && <EventConfigurationConfirm title={data.status === 'active' ? 'Activar el evento' : 'Cerrar el evento'} confirmLabel={data.status === 'active' ? 'Activar evento' : data.status === 'completed' ? 'Completar evento' : 'Cancelar evento'} onCancel={() => setConfirm(null)} onConfirm={() => saveData(true)}><p>{data.status === 'active' ? 'Se aplicarán las reglas guardadas y se actualizarán las participaciones correspondientes. Revisa que las etapas y reglas estén listas.' : 'El evento conservará sus participaciones y bitácoras como historial. Después del cierre no se podrá modificar ni reabrir.'}</p></EventConfigurationConfirm>}
    {open && impact && <EventConfigurationConfirm title="Impacto de las reglas" confirmLabel="Aplicar reglas" busy={saving} onCancel={() => { if (!saving) setImpact(null) }} onConfirm={applyRules}><div className="grid grid-cols-2 gap-2">{[['Nuevas participaciones', impact.created], ['Se reactivarán', impact.activated], ['Pasarán a historial', impact.deactivated], ['Sin cambios', impact.unchanged]].map(([label, count]) => <div key={String(label)} className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">{label}</p><p className="mt-1 text-xl font-semibold tabular-nums text-slate-900">{count}</p></div>)}</div>{impact.broad_rule && <p className="mt-3 rounded-xl bg-amber-50 p-3 text-amber-800">Esta regla es amplia y puede incorporar a todos los contactos que no estén excluidos.</p>}<p className="mt-3">Las participaciones que salgan conservarán su historial. Quitar todas las reglas no reactiva automáticamente a los inactivos.</p>{errors.rules && <p role="alert" className="mt-3 text-rose-700">{errors.rules}</p>}</EventConfigurationConfirm>}
  </>
}
