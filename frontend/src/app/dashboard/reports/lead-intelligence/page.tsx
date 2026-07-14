'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  AlertCircle, ArrowLeft, BarChart3, BrainCircuit, CheckCircle2, ChevronDown, ChevronUp,
  Download, FileSpreadsheet, Loader2, RefreshCw, ShieldAlert, Sparkles, Square, XCircle,
} from 'lucide-react'
import type {
  LeadIntelligenceOptions, LeadIntelligencePreview, LeadIntelligenceResult, LeadIntelligenceRun,
} from '@/types/report'
import { exportLeadIntelligenceExcel } from '@/utils/leadIntelligenceReportExport'

type FormState = {
  objective_type: 'course' | 'event' | 'general'
  objective_name: string
  campaign_context: string
  scope: 'all' | 'active' | 'custom'
  chat_history: 'all' | '6m' | '12m' | '24m'
  pipeline_ids: string[]
  stage_ids: string[]
  tag_ids: string[]
  sources: string[]
  created_from: string
  created_to: string
  activity_from: string
  activity_to: string
  include_archived_lost: boolean
  include_converted: boolean
  reasoning_effort: string
}

const initialForm: FormState = {
  objective_type: 'course', objective_name: 'Conócete a Ti Mismo', campaign_context: '', scope: 'all', chat_history: 'all',
  pipeline_ids: [], stage_ids: [], tag_ids: [], sources: [], created_from: '', created_to: '', activity_from: '', activity_to: '',
  include_archived_lost: true, include_converted: true, reasoning_effort: 'high',
}

const effortMeta: Record<string, { label: string; description: string }> = {
  low: { label: 'Bajo', description: 'Más rápido; no recomendado para análisis completos.' },
  medium: { label: 'Medio', description: 'Adecuado para cohortes pequeñas y criterios estándar.' },
  high: { label: 'Alto', description: 'Recomendado para cruzar chats, eventos y señales humanas.' },
  xhigh: { label: 'Exhaustivo', description: 'Mayor profundidad y duración para criterios complejos.' },
}

function authHeaders(json = false): HeadersInit {
  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null
  return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}) }
}

function formatDate(value?: string) {
  if (!value) return '—'
  return new Date(value).toLocaleString('es-PE', { dateStyle: 'medium', timeStyle: 'short' })
}

function runStatusLabel(run: LeadIntelligenceRun) {
  const labels: Record<string, string> = { queued: 'En cola', running: 'Procesando', completed: 'Completado', completed_with_warnings: 'Completado con advertencias', failed: 'Falló', cancelled: 'Cancelado' }
  return labels[run.status] || run.status
}

function FilterChecklist({ label, options, selected, onChange }: { label: string; options: Array<{ id: string; name: string }>; selected: string[]; onChange: (values: string[]) => void }) {
  if (options.length === 0) return null
  return (
    <div>
      <p className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">{label}</p>
      <div className="max-h-36 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-2">
        {options.map(option => {
          const checked = selected.includes(option.id)
          return (
            <label key={option.id} className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-xs text-slate-600 hover:bg-white">
              <input type="checkbox" checked={checked} onChange={() => onChange(checked ? selected.filter(id => id !== option.id) : [...selected, option.id])} className="mt-0.5 accent-emerald-600" />
              <span>{option.name}</span>
            </label>
          )
        })}
      </div>
    </div>
  )
}

function Metric({ label, value, detail }: { label: string; value: string | number; detail: string }) {
  return <div className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{label}</p><p className="mt-1 text-2xl font-black text-slate-800">{value}</p><p className="mt-1 text-xs text-slate-500">{detail}</p></div>
}

export default function LeadIntelligenceReportPage() {
  const [options, setOptions] = useState<LeadIntelligenceOptions | null>(null)
  const [optionsLoading, setOptionsLoading] = useState(true)
  const [optionsError, setOptionsError] = useState('')
  const [form, setForm] = useState<FormState>(initialForm)
  const [advanced, setAdvanced] = useState(false)
  const [preview, setPreview] = useState<LeadIntelligencePreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const [runs, setRuns] = useState<LeadIntelligenceRun[]>([])
  const [activeRun, setActiveRun] = useState<LeadIntelligenceRun | null>(null)
  const [result, setResult] = useState<LeadIntelligenceResult | null>(null)
  const [runError, setRunError] = useState('')
  const [creating, setCreating] = useState(false)
  const previewRequest = useRef<AbortController | null>(null)
  const mounted = useRef(true)

  const updateForm = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    previewRequest.current?.abort()
    setForm(current => ({ ...current, [key]: value }))
    setPreview(null)
    setPreviewError('')
  }

  const requestBody = useCallback(() => ({ ...form }), [form])

  const loadOptions = useCallback(async () => {
    setOptionsLoading(true)
    setOptionsError('')
    try {
      const response = await fetch('/api/reports/lead-intelligence/options', { headers: authHeaders(), credentials: 'include', cache: 'no-store' })
      const data = await response.json()
      if (!response.ok || !data.success) throw new Error(data.error || 'No se pudieron cargar los parámetros')
      if (mounted.current) {
        setOptions(data)
        const allowed: string[] = data.allowed_reasoning_efforts || []
        if (allowed.length > 0) {
          setForm(current => allowed.includes(current.reasoning_effort)
            ? current
            : { ...current, reasoning_effort: allowed.includes('high') ? 'high' : allowed[0] })
        }
      }
    } catch (error) {
      if (mounted.current) setOptionsError(error instanceof Error ? error.message : 'No se pudieron cargar los parámetros')
    } finally {
      if (mounted.current) setOptionsLoading(false)
    }
  }, [])

  const loadRuns = useCallback(async () => {
    try {
      const response = await fetch('/api/reports/lead-intelligence/runs?limit=10', { headers: authHeaders(), credentials: 'include' })
      const data = await response.json()
      if (response.ok && data.success && mounted.current) {
        const loaded: LeadIntelligenceRun[] = data.runs || []
        setRuns(loaded)
        const running = loaded.find(run => run.status === 'queued' || run.status === 'running')
        if (running) setActiveRun(current => current || running)
      }
    } catch { /* Recent history is non-blocking. */ }
  }, [])

  useEffect(() => {
    mounted.current = true
    loadOptions()
    loadRuns()
    return () => { mounted.current = false; previewRequest.current?.abort() }
  }, [loadOptions, loadRuns])

  const loadResult = useCallback(async (run: LeadIntelligenceRun) => {
    setRunError('')
    try {
      const response = await fetch(`/api/reports/lead-intelligence/runs/${run.id}/result`, { headers: authHeaders(), credentials: 'include' })
      const data = await response.json()
      if (!response.ok || !data.success) throw new Error(data.error || 'No se pudo cargar el resultado')
      if (mounted.current) setResult(data)
    } catch (error) {
      if (mounted.current) setRunError(error instanceof Error ? error.message : 'No se pudo cargar el resultado')
    }
  }, [])

  useEffect(() => {
    if (!activeRun || !['queued', 'running'].includes(activeRun.status)) return
    let stopped = false
    const poll = async () => {
      try {
        const response = await fetch(`/api/reports/lead-intelligence/runs/${activeRun.id}`, { headers: authHeaders(), credentials: 'include' })
        const data = await response.json()
        if (!response.ok || !data.success) throw new Error(data.error || 'No se pudo consultar el progreso')
        if (stopped || !mounted.current) return
        const next: LeadIntelligenceRun = data.run
        setActiveRun(next)
        setRuns(current => [next, ...current.filter(run => run.id !== next.id)].slice(0, 10))
        if (next.status === 'completed' || next.status === 'completed_with_warnings') await loadResult(next)
        if (next.status === 'failed') setRunError(next.safe_error || 'No se pudo completar el reporte')
      } catch (error) {
        if (!stopped && mounted.current) setRunError(error instanceof Error ? error.message : 'No se pudo consultar el progreso')
      }
    }
    poll()
    const interval = window.setInterval(poll, 2000)
    return () => { stopped = true; window.clearInterval(interval) }
  }, [activeRun?.id, activeRun?.status, loadResult])

  const calculatePreview = async () => {
    previewRequest.current?.abort()
    const controller = new AbortController()
    previewRequest.current = controller
    setPreviewLoading(true)
    setPreviewError('')
    setOptionsError('')
    try {
      const response = await fetch('/api/reports/lead-intelligence/preview', { method: 'POST', headers: authHeaders(true), credentials: 'include', cache: 'no-store', signal: controller.signal, body: JSON.stringify(requestBody()) })
      const data = await response.json()
      if (!response.ok || !data.success) throw new Error(data.error || 'No se pudo calcular el alcance')
      setPreview(data.preview)
      setOptions(current => current
        ? { ...current, ai: data.ai, allowed_reasoning_efforts: data.allowed_reasoning_efforts }
        : { ai: data.ai, allowed_reasoning_efforts: data.allowed_reasoning_efforts, pipelines: [], stages: [], tags: [], sources: [] })
      setForm(current => ({ ...current, reasoning_effort: data.preview.recommended_reasoning }))
    } catch (error) {
      if ((error as Error).name !== 'AbortError') setPreviewError(error instanceof Error ? error.message : 'No se pudo calcular el alcance')
    } finally {
      if (previewRequest.current === controller) setPreviewLoading(false)
    }
  }

  const createRun = async () => {
    if (!preview || optionsLoading || optionsError || !options?.ai.available) return
    setCreating(true)
    setRunError('')
    setResult(null)
    try {
      const response = await fetch('/api/reports/lead-intelligence/runs', { method: 'POST', headers: authHeaders(true), credentials: 'include', cache: 'no-store', body: JSON.stringify({ ...requestBody(), client_request_id: crypto.randomUUID() }) })
      const data = await response.json()
      if (!response.ok || !data.success) {
        if (response.status === 503 && data.error) {
          setOptions(current => current ? { ...current, ai: { available: false, code: data.code, message: data.error } } : current)
        }
        throw new Error(data.error || 'No se pudo iniciar el reporte')
      }
      setActiveRun(data.run)
      setRuns(current => [data.run, ...current.filter(run => run.id !== data.run.id)].slice(0, 10))
    } catch (error) {
      setRunError(error instanceof Error ? error.message : 'No se pudo iniciar el reporte')
    } finally { setCreating(false) }
  }

  const cancelRun = async () => {
    if (!activeRun) return
    try {
      const response = await fetch(`/api/reports/lead-intelligence/runs/${activeRun.id}/cancel`, { method: 'POST', headers: authHeaders(), credentials: 'include' })
      const data = await response.json()
      if (!response.ok || !data.success) throw new Error(data.error || 'No se pudo cancelar')
      setActiveRun(current => current ? { ...current, cancel_requested: true, phase: 'cancelling' } : current)
    } catch (error) { setRunError(error instanceof Error ? error.message : 'No se pudo cancelar') }
  }

  const progress = useMemo(() => {
    if (!activeRun) return 0
    if (activeRun.status === 'completed' || activeRun.status === 'completed_with_warnings') return 100
    if (!activeRun.total_items) return activeRun.status === 'running' ? 10 : 2
    return Math.min(95, Math.round((activeRun.processed_items / activeRun.total_items) * 70 + (activeRun.ai_candidate_count ? activeRun.ai_processed_count / activeRun.ai_candidate_count * 25 : 20)))
  }, [activeRun])

  const aiChecking = optionsLoading || previewLoading
  const aiValidationFailed = !aiChecking && Boolean(optionsError)
  const aiAvailable = !aiChecking && !aiValidationFailed && Boolean(options?.ai.available)
  const canGenerate = aiAvailable && !creating && preview?.total_leads !== 0 && !Boolean(activeRun && ['queued', 'running'].includes(activeRun.status))

  return (
    <main className="h-full overflow-y-auto bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-[1500px]">
        <header className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <Link href="/dashboard/reports" className="mb-3 inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-emerald-600"><ArrowLeft className="h-4 w-4" /> Centro de reportes</Link>
            <div className="flex items-start gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-violet-100 text-violet-700"><BrainCircuit className="h-6 w-6" /></div>
              <div><div className="flex flex-wrap items-center gap-2"><h1 className="text-2xl font-bold text-slate-900">Análisis inteligente de leads</h1><span className="inline-flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-violet-700"><Sparkles className="h-3 w-3" /> Usa IA</span></div><p className="mt-1 text-sm text-slate-500">Prioriza llamadas, mensajes personalizados y difusión cruzando CRM, WhatsApp y participación.</p></div>
            </div>
          </div>
          <div className={`flex max-w-md items-start gap-2 rounded-xl border px-4 py-3 text-sm ${aiChecking ? 'border-slate-200 bg-slate-100 text-slate-700' : aiAvailable ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
            {aiChecking ? <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" /> : aiAvailable ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />}
            <div className="flex-1"><p className="font-bold">{aiChecking ? 'Validando IA…' : aiValidationFailed ? 'No se pudo validar IA' : aiAvailable ? 'IA disponible' : 'IA no disponible'}</p><p className="mt-0.5 text-xs opacity-80">{aiChecking ? 'Comprobando la conexión real de Eros con OpenAI.' : optionsError || options?.ai.message}</p></div>
            <button type="button" onClick={loadOptions} disabled={optionsLoading} className="rounded-lg p-1 hover:bg-white/60 disabled:cursor-wait disabled:opacity-60" aria-label="Volver a validar Eros"><RefreshCw className={`h-4 w-4 ${optionsLoading ? 'animate-spin' : ''}`} /></button>
          </div>
        </header>

        {optionsError && <div className="mb-5 flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700"><AlertCircle className="h-4 w-4" />{optionsError}</div>}

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="mb-5 flex items-center gap-2"><BarChart3 className="h-5 w-5 text-emerald-600" /><h2 className="font-bold text-slate-800">Parámetros del reporte</h2></div>
          <div className="grid gap-5 lg:grid-cols-3">
            <div><label className="mb-2 block text-xs font-bold uppercase tracking-wider text-slate-500">Tipo de objetivo</label><select value={form.objective_type} onChange={event => updateForm('objective_type', event.target.value as FormState['objective_type'])} className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-emerald-400"><option value="course">Curso</option><option value="event">Evento</option><option value="general">Campaña general</option></select></div>
            <div><label className="mb-2 block text-xs font-bold uppercase tracking-wider text-slate-500">Objetivo</label><input value={form.objective_name} onChange={event => updateForm('objective_name', event.target.value)} maxLength={120} placeholder="Conócete a Ti Mismo" className="h-11 w-full rounded-xl border border-slate-200 px-3 text-sm outline-none focus:border-emerald-400" /></div>
            <div><label className="mb-2 block text-xs font-bold uppercase tracking-wider text-slate-500">Universo</label><select value={form.scope} onChange={event => updateForm('scope', event.target.value as FormState['scope'])} className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-emerald-400"><option value="all">Todos los leads</option><option value="active">Solo activos</option><option value="custom">Filtros personalizados</option></select></div>
            <div className="lg:col-span-2"><label className="mb-2 block text-xs font-bold uppercase tracking-wider text-slate-500">Contexto de campaña</label><input value={form.campaign_context} onChange={event => updateForm('campaign_context', event.target.value)} maxLength={500} placeholder="Ej.: nuevas fechas de julio, primera clase gratuita…" className="h-11 w-full rounded-xl border border-slate-200 px-3 text-sm outline-none focus:border-emerald-400" /></div>
            <div><label className="mb-2 block text-xs font-bold uppercase tracking-wider text-slate-500">Historial de chat</label><select value={form.chat_history} onChange={event => updateForm('chat_history', event.target.value as FormState['chat_history'])} className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-emerald-400"><option value="all">Historial completo</option><option value="6m">Últimos 6 meses</option><option value="12m">Últimos 12 meses</option><option value="24m">Últimos 24 meses</option></select></div>
          </div>
          <button type="button" onClick={() => setAdvanced(value => !value)} className="mt-5 inline-flex items-center gap-1.5 text-xs font-bold text-slate-600 hover:text-emerald-700">{advanced ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />} Filtros avanzados</button>
          {advanced && (
            <div className="mt-4 grid gap-5 border-t border-slate-100 pt-5 md:grid-cols-2 xl:grid-cols-4">
              <FilterChecklist label="Pipelines" options={options?.pipelines || []} selected={form.pipeline_ids} onChange={values => updateForm('pipeline_ids', values)} />
              <FilterChecklist label="Etapas" options={options?.stages || []} selected={form.stage_ids} onChange={values => updateForm('stage_ids', values)} />
              <FilterChecklist label="Etiquetas" options={options?.tags || []} selected={form.tag_ids} onChange={values => updateForm('tag_ids', values)} />
              <FilterChecklist label="Fuentes" options={(options?.sources || []).map(value => ({ id: value, name: value }))} selected={form.sources} onChange={values => updateForm('sources', values)} />
              {(['created_from', 'created_to', 'activity_from', 'activity_to'] as const).map(key => <div key={key}><label className="mb-2 block text-xs font-bold uppercase tracking-wider text-slate-500">{{ created_from: 'Creado desde', created_to: 'Creado hasta', activity_from: 'Actividad desde', activity_to: 'Actividad hasta' }[key]}</label><input type="date" value={form[key]} onChange={event => updateForm(key, event.target.value)} className="h-11 w-full rounded-xl border border-slate-200 px-3 text-sm outline-none focus:border-emerald-400" /></div>)}
              <label className="flex items-start gap-2 rounded-xl border border-slate-200 p-3 text-sm text-slate-600"><input type="checkbox" checked={form.include_archived_lost} onChange={event => updateForm('include_archived_lost', event.target.checked)} className="mt-0.5 accent-emerald-600" /><span><strong className="block text-slate-700">Incluir archivados y perdidos</strong><span className="text-xs text-slate-400">Permite detectar reactivaciones reales.</span></span></label>
              <label className="flex items-start gap-2 rounded-xl border border-slate-200 p-3 text-sm text-slate-600"><input type="checkbox" checked={form.include_converted} onChange={event => updateForm('include_converted', event.target.checked)} className="mt-0.5 accent-emerald-600" /><span><strong className="block text-slate-700">Incluir convertidos</strong><span className="text-xs text-slate-400">Se separarán de la captación externa.</span></span></label>
            </div>
          )}
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button type="button" onClick={calculatePreview} disabled={previewLoading || optionsLoading || !form.objective_name.trim()} className="inline-flex h-11 items-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50 px-5 text-sm font-bold text-emerald-700 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50">{previewLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <BarChart3 className="h-4 w-4" />} Calcular alcance</button>
            {previewError && <span className="text-sm text-rose-600">{previewError}</span>}
          </div>
        </section>

        {preview && (
          <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <div className="grid gap-3 sm:grid-cols-3"><Metric label="Leads" value={preview.total_leads} detail="Filas que tendrá el análisis" /><Metric label="Con chats" value={preview.leads_with_chats} detail="Con mensajes asociados" /><Metric label="Revisión IA" value={preview.ai_candidate_count} detail={`Máximo selectivo ${preview.ai_candidate_limit}`} /></div>
            <div className="mt-6"><div className="flex flex-wrap items-center gap-2"><h3 className="font-bold text-slate-800">Nivel de razonamiento</h3><span className="rounded-full bg-violet-50 px-2 py-1 text-[10px] font-bold uppercase text-violet-700">Recomendado: {effortMeta[preview.recommended_reasoning]?.label || preview.recommended_reasoning}</span></div><p className="mt-1 text-xs text-slate-500">{preview.recommendation_reason}</p>
              <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">{(options?.allowed_reasoning_efforts || []).map(effort => <button key={effort} type="button" onClick={() => setForm(current => ({ ...current, reasoning_effort: effort }))} className={`rounded-xl border p-3 text-left transition ${form.reasoning_effort === effort ? 'border-violet-400 bg-violet-50 ring-2 ring-violet-200' : 'border-slate-200 hover:border-violet-200'}`}><span className="text-sm font-bold text-slate-700">{effortMeta[effort]?.label || effort}</span><span className="mt-1 block text-xs leading-5 text-slate-500">{effortMeta[effort]?.description}</span></button>)}</div>
            </div>
            <div className="mt-6 flex flex-wrap items-center gap-3"><button type="button" onClick={createRun} disabled={!canGenerate} className="inline-flex h-12 items-center gap-2 rounded-xl bg-violet-600 px-6 text-sm font-bold text-white shadow-lg shadow-violet-600/20 hover:bg-violet-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none">{creating ? <Loader2 className="h-5 w-5 animate-spin" /> : <Sparkles className="h-5 w-5" />} Generar reporte con IA</button>{!aiAvailable && <span className="text-xs text-amber-700">{aiChecking ? 'Validando Eros antes de habilitar la generación.' : 'La generación permanecerá bloqueada hasta que Eros esté disponible.'}</span>}</div>
          </section>
        )}

        {activeRun && (
          <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-wider text-slate-400">Ejecución actual</p><h2 className="mt-1 text-lg font-bold text-slate-800">{runStatusLabel(activeRun)}</h2><p className="mt-1 text-xs text-slate-500">Fase: {activeRun.phase} · Razonamiento: {effortMeta[activeRun.selected_reasoning]?.label || activeRun.selected_reasoning}</p></div>{['queued', 'running'].includes(activeRun.status) && <button type="button" onClick={cancelRun} disabled={activeRun.cancel_requested} className="inline-flex items-center gap-2 rounded-xl border border-rose-200 px-3 py-2 text-xs font-bold text-rose-700 hover:bg-rose-50 disabled:opacity-50"><Square className="h-3.5 w-3.5" /> Cancelar</button>}</div>
            {['queued', 'running'].includes(activeRun.status) && <div className="mt-4"><div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-violet-500 transition-all" style={{ width: `${progress}%` }} /></div><div className="mt-2 flex justify-between text-[11px] text-slate-400"><span>{progress}% estimado</span><span>IA: {activeRun.ai_processed_count}/{activeRun.ai_candidate_count || '—'}</span></div></div>}
            {runError && <div className="mt-4 flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"><XCircle className="h-4 w-4" />{runError}</div>}
          </section>
        )}

        {result && (
          <section className="mt-6 rounded-2xl border border-emerald-200 bg-white p-5 shadow-sm sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex items-center gap-2"><CheckCircle2 className="h-5 w-5 text-emerald-600" /><h2 className="text-lg font-bold text-slate-900">Reporte listo</h2></div><p className="mt-1 text-sm text-slate-500">{result.summary.total_leads} leads · cobertura IA {Number(result.summary.ai_coverage_percent || 0).toFixed(1)}%</p></div><button type="button" onClick={() => exportLeadIntelligenceExcel(result)} className="inline-flex h-11 items-center gap-2 rounded-xl bg-slate-800 px-4 text-sm font-bold text-white hover:bg-slate-900"><FileSpreadsheet className="h-4 w-4" /> Descargar Excel</button></div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">{['A+', 'A', 'B', 'C', 'D', 'E'].map(priority => <Metric key={priority} label={`Prioridad ${priority}`} value={result.summary.priority_distribution?.[priority] || 0} detail={priority === 'A+' ? 'Llamada inmediata' : priority === 'E' ? 'No contactar' : 'Segmento calculado'} />)}</div>
            {(result.summary.hallazgos || []).length > 0 && <div className="mt-5 rounded-xl bg-slate-50 p-4"><h3 className="text-sm font-bold text-slate-700">Hallazgos clave</h3><ul className="mt-2 space-y-1 text-sm text-slate-600">{result.summary.hallazgos.map((finding, index) => <li key={index}>• {finding}</li>)}</ul></div>}
            {Object.keys(result.summary.respuestas || {}).length > 0 && <div className="mt-4 grid gap-3 md:grid-cols-2">{Object.entries(result.summary.respuestas || {}).map(([key, value]) => <div key={key} className="rounded-xl border border-slate-200 p-4"><p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{key.replaceAll('_', ' ')}</p><p className="mt-1 text-sm leading-6 text-slate-600">{value}</p></div>)}</div>}
            {result.warnings.length > 0 && <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800"><strong>Advertencias:</strong> {result.warnings.join(' ')}</div>}
          </section>
        )}

        {runs.length > 0 && (
          <section className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><div className="border-b border-slate-200 px-5 py-4"><h2 className="text-sm font-bold text-slate-800">Ejecuciones recientes</h2><p className="mt-0.5 text-xs text-slate-400">Disponibles durante siete días.</p></div><div className="divide-y divide-slate-100">{runs.map(run => <div key={run.id} className="flex flex-col gap-3 px-5 py-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-sm font-semibold text-slate-700">{runStatusLabel(run)}</p><p className="mt-0.5 text-xs text-slate-400">{formatDate(run.created_at)} · {run.total_items || '—'} leads · {effortMeta[run.selected_reasoning]?.label || run.selected_reasoning}</p></div><div className="flex gap-2">{(run.status === 'completed' || run.status === 'completed_with_warnings') && <button type="button" onClick={() => { setActiveRun(run); loadResult(run) }} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:border-emerald-300 hover:text-emerald-700"><Download className="h-3.5 w-3.5" /> Abrir</button>}</div></div>)}</div></section>
        )}
      </div>
    </main>
  )
}
