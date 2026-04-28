'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, Bot, CheckCircle2, ClipboardList, Loader2, Play, Plus, RefreshCw, Save, Send, Trash2, UploadCloud, X } from 'lucide-react'
import { apiDelete, apiGet, apiPost, apiPut } from '@/lib/api'
import type { BotFlow, BotGraph, BotSimulationResult } from '@/types/bot'

interface BotListResponse { bots: BotFlow[] }
interface BotResponse { bot: BotFlow }
interface SimulationResponse { result: BotSimulationResult }

const defaultGraph: BotGraph = {
  nodes: [
    { id: 'trigger', type: 'trigger', data: { label: 'Mensaje recibido' } },
    { id: 'reply', type: 'send_message', data: { label: 'Respuesta', message: 'Hola, gracias por escribirnos. Un asesor continuara la atencion.' } },
  ],
  edges: [{ id: 'e-trigger-reply', source: 'trigger', target: 'reply' }],
}

function formatDate(value?: string) {
  if (!value) return '-'
  return new Date(value).toLocaleString('es-PE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function statusBadge(bot: BotFlow) {
  if (!bot.is_published) return <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-50 text-amber-700">Borrador</span>
  if (bot.is_active) return <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-50 text-emerald-700">Activo</span>
  return <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-100 text-slate-500">Pausado</span>
}

export default function BotsPage() {
  const [bots, setBots] = useState<BotFlow[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<BotFlow | null>(null)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [form, setForm] = useState({ name: '', description: '', trigger_type: 'message_received', is_active: false })
  const [graphJSON, setGraphJSON] = useState(JSON.stringify(defaultGraph, null, 2))
  const [simulationMessage, setSimulationMessage] = useState('hola, quiero informacion')
  const [simulation, setSimulation] = useState<BotSimulationResult | null>(null)
  const [simulating, setSimulating] = useState(false)

  const selectedGraph = useMemo(() => {
    try { return JSON.parse(graphJSON) as BotGraph } catch { return null }
  }, [graphJSON])

  const load = useCallback(async () => {
    setLoading(true)
    const res = await apiGet<BotListResponse>('/api/bots')
    if (res.success) {
      const list = res.data?.bots || []
      setBots(list)
      if (!selected && list.length > 0) setSelected(list[0])
    }
    setLoading(false)
  }, [selected])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!selected || editing) return
    setForm({
      name: selected.name,
      description: selected.description || '',
      trigger_type: selected.trigger_type || 'message_received',
      is_active: selected.is_active,
    })
    setGraphJSON(JSON.stringify(selected.graph || defaultGraph, null, 2))
    setSimulation(null)
  }, [selected, editing])

  const startCreate = () => {
    setSelected(null)
    setEditing(true)
    setForm({ name: '', description: '', trigger_type: 'message_received', is_active: false })
    setGraphJSON(JSON.stringify(defaultGraph, null, 2))
    setSimulation(null)
  }

  const startEdit = (bot: BotFlow) => {
    setSelected(bot)
    setEditing(true)
    setForm({ name: bot.name, description: bot.description || '', trigger_type: bot.trigger_type || 'message_received', is_active: bot.is_active })
    setGraphJSON(JSON.stringify(bot.graph || defaultGraph, null, 2))
    setSimulation(null)
  }

  const save = async () => {
    if (!form.name.trim()) return
    let graph: BotGraph
    try {
      graph = JSON.parse(graphJSON)
    } catch {
      setMessage({ type: 'error', text: 'El JSON del flujo no es valido' })
      return
    }
    setSaving(true)
    const payload = {
      name: form.name.trim(),
      description: form.description,
      channel: 'whatsapp',
      trigger_type: form.trigger_type,
      trigger_config: {},
      graph,
      is_active: form.is_active,
    }
    const res = selected
      ? await apiPut<BotResponse>(`/api/bots/${selected.id}`, payload)
      : await apiPost<BotResponse>('/api/bots', payload)
    setSaving(false)
    if (res.success && res.data?.bot) {
      setMessage({ type: 'success', text: selected ? 'Bot actualizado' : 'Bot creado' })
      setSelected(res.data.bot)
      setEditing(false)
      await load()
    } else {
      setMessage({ type: 'error', text: res.error || 'No se pudo guardar' })
    }
  }

  const publish = async (bot: BotFlow) => {
    const res = await apiPost<BotResponse>(`/api/bots/${bot.id}/publish`, {})
    if (res.success && res.data?.bot) {
      setMessage({ type: 'success', text: 'Version publicada' })
      setSelected(res.data.bot)
      await load()
    } else {
      setMessage({ type: 'error', text: res.error || 'No se pudo publicar' })
    }
  }

  const remove = async (bot: BotFlow) => {
    if (!confirm('Eliminar este bot?')) return
    const res = await apiDelete(`/api/bots/${bot.id}`)
    if (res.success) {
      setSelected(null)
      await load()
    } else {
      setMessage({ type: 'error', text: res.error || 'No se pudo eliminar' })
    }
  }

  const simulate = async () => {
    if (!selected) return
    setSimulating(true)
    const res = await apiPost<SimulationResponse>(`/api/bots/${selected.id}/simulate`, { message: simulationMessage })
    setSimulating(false)
    if (res.success) setSimulation(res.data?.result || null)
    else setMessage({ type: 'error', text: res.error || 'No se pudo simular' })
  }

  return (
    <div className="h-full flex flex-col min-h-0 gap-3">
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 bg-emerald-50 rounded-xl flex items-center justify-center">
            <Bot className="w-5 h-5 text-emerald-600" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Bots</h1>
            <p className="text-xs text-slate-500">Flujos de respuesta para leads y conversaciones</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} className="p-2 rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50" title="Actualizar"><RefreshCw className="w-4 h-4" /></button>
          <button onClick={startCreate} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700 shadow-sm">
            <Plus className="w-3.5 h-3.5" /> Nuevo
          </button>
        </div>
      </div>

      {message && (
        <div className={`shrink-0 flex items-center gap-2 rounded-xl px-3 py-2 text-xs ${message.type === 'success' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'}`}>
          {message.type === 'success' ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
          {message.text}
        </div>
      )}

      <div className="grid lg:grid-cols-[330px_1fr] gap-4 flex-1 min-h-0">
        <div className="border border-slate-200 rounded-xl bg-white overflow-hidden flex flex-col min-h-0">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
            <h2 className="text-sm font-medium text-slate-900">Flujos</h2>
            <span className="text-xs text-slate-400">{bots.length}</span>
          </div>
          {loading ? (
            <div className="flex-1 flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-emerald-600" /></div>
          ) : bots.length === 0 ? (
            <div className="p-8 text-center">
              <ClipboardList className="w-8 h-8 text-slate-300 mx-auto mb-2" />
              <p className="text-sm font-medium text-slate-700">Sin bots</p>
              <button onClick={startCreate} className="mt-3 inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700">
                <Plus className="w-3.5 h-3.5" /> Crear bot
              </button>
            </div>
          ) : (
            <div className="overflow-y-auto divide-y divide-slate-100">
              {bots.map(bot => (
                <button key={bot.id} onClick={() => { setSelected(bot); setEditing(false) }} className={`w-full text-left px-4 py-3 hover:bg-slate-50 transition ${selected?.id === bot.id && !editing ? 'bg-emerald-50/60' : ''}`}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-slate-900 truncate">{bot.name}</p>
                    {statusBadge(bot)}
                  </div>
                  <p className="text-xs text-slate-500 truncate mt-0.5">v{bot.published_version || 0} publicada · borrador v{bot.draft_version}</p>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="border border-slate-200 rounded-xl bg-white overflow-hidden flex flex-col min-h-0">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-medium text-slate-900 truncate">{editing ? (selected ? 'Editar bot' : 'Nuevo bot') : (selected?.name || 'Selecciona un bot')}</h2>
              {selected && !editing && <p className="text-xs text-slate-500">Actualizado {formatDate(selected.updated_at)}</p>}
            </div>
            {selected && !editing && (
              <div className="flex items-center gap-1.5">
                <button onClick={() => startEdit(selected)} className="px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-600 hover:bg-slate-50">Editar</button>
                <button onClick={() => publish(selected)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 text-white text-xs font-medium hover:bg-slate-700"><UploadCloud className="w-3.5 h-3.5" /> Publicar</button>
                <button onClick={() => remove(selected)} className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50" title="Eliminar"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            )}
          </div>

          {!selected && !editing ? (
            <div className="flex-1 flex items-center justify-center text-sm text-slate-500">Crea o selecciona un flujo</div>
          ) : editing ? (
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              <div className="grid md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Nombre</label>
                  <input value={form.name} onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))} className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Disparador</label>
                  <select value={form.trigger_type} onChange={e => setForm(prev => ({ ...prev, trigger_type: e.target.value }))} className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/20">
                    <option value="message_received">Mensaje recibido</option>
                    <option value="manual">Manual</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Descripcion</label>
                <input value={form.description} onChange={e => setForm(prev => ({ ...prev, description: e.target.value }))} className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/20" />
              </div>
              <div className="flex items-center justify-between rounded-xl border border-slate-200 px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-slate-800">Activar al publicar</p>
                  <p className="text-xs text-slate-500">El motor queda listo, sin envios pagados por API.</p>
                </div>
                <button onClick={() => setForm(prev => ({ ...prev, is_active: !prev.is_active }))} className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${form.is_active ? 'bg-emerald-500' : 'bg-slate-300'}`}>
                  <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-sm transition-transform ${form.is_active ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
                </button>
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-medium text-slate-600">Flujo JSON</label>
                  {!selectedGraph && <span className="text-xs text-red-600">JSON invalido</span>}
                </div>
                <textarea value={graphJSON} onChange={e => setGraphJSON(e.target.value)} rows={15} className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs font-mono text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 resize-none" />
              </div>
              <div className="flex items-center justify-end gap-2">
                <button onClick={() => { setEditing(false); if (!selected) setGraphJSON(JSON.stringify(defaultGraph, null, 2)) }} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-200 text-xs font-medium text-slate-600 hover:bg-slate-50"><X className="w-3.5 h-3.5" /> Cancelar</button>
                <button onClick={save} disabled={saving || !form.name.trim()} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700 disabled:opacity-50">
                  {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Guardar
                </button>
              </div>
            </div>
          ) : selected ? (
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              <div className="grid sm:grid-cols-4 gap-3">
                <div className="border border-slate-200 rounded-xl p-3"><p className="text-xl font-semibold text-slate-900">{selected.draft_version}</p><p className="text-[11px] text-slate-500">Borrador</p></div>
                <div className="border border-slate-200 rounded-xl p-3"><p className="text-xl font-semibold text-slate-900">{selected.published_version}</p><p className="text-[11px] text-slate-500">Publicada</p></div>
                <div className="border border-slate-200 rounded-xl p-3"><p className="text-xl font-semibold text-slate-900">{selected.execution_count}</p><p className="text-[11px] text-slate-500">Ejecuciones</p></div>
                <div className="border border-slate-200 rounded-xl p-3"><p className="text-xl font-semibold text-slate-900">{selected.graph?.nodes?.length || 0}</p><p className="text-[11px] text-slate-500">Nodos</p></div>
              </div>

              <div className="border border-slate-200 rounded-xl p-4 space-y-3">
                <div className="flex items-center gap-2"><Play className="w-4 h-4 text-emerald-600" /><h3 className="text-sm font-medium text-slate-900">Simulador</h3></div>
                <div className="flex gap-2">
                  <input value={simulationMessage} onChange={e => setSimulationMessage(e.target.value)} className="flex-1 px-3 py-2 rounded-xl border border-slate-200 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/20" />
                  <button onClick={simulate} disabled={simulating} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700 disabled:opacity-50">
                    {simulating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />} Simular
                  </button>
                </div>
                {simulation && (
                  <div className="space-y-2">
                    {simulation.steps.map((step, idx) => (
                      <div key={`${step.node_id}-${idx}`} className="flex items-start gap-3 rounded-xl bg-slate-50 px-3 py-2">
                        <div className="w-6 h-6 rounded-full bg-white border border-slate-200 flex items-center justify-center text-[11px] text-slate-500 shrink-0">{idx + 1}</div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-slate-800">{step.label || step.node_type}</p>
                          <pre className="text-xs text-slate-500 whitespace-pre-wrap break-words">{JSON.stringify(step.output, null, 2)}</pre>
                        </div>
                      </div>
                    ))}
                    {simulation.error && <p className="text-xs text-red-600">{simulation.error}</p>}
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
