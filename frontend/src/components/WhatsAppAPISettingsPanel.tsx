'use client'

import { useCallback, useEffect, useState } from 'react'
import { Activity, AlertCircle, CheckCircle2, Clock, FileText, Globe, Loader2, Plus, RefreshCw, Trash2, XCircle } from 'lucide-react'
import { apiDelete, apiGet, apiPost } from '@/lib/api'

interface Overview {
  cloud_channel_count: number
  template_count: number
  approved_templates: number
  webhook_event_count: number
  open_window_count: number
}

interface Template {
  id: string
  device_id?: string
  name: string
  language: string
  category: string
  status: string
  components: unknown
  created_at: string
  updated_at: string
}

interface WebhookEvent {
  id: string
  event_type: string
  phone_number_id: string
  processed: boolean
  error_message?: string
  received_at: string
}

interface ConversationWindow {
  chat_id: string
  jid: string
  name?: string
  device_name?: string
  provider: string
  last_inbound_at?: string
  customer_service_window_expires_at?: string
  can_reply: boolean
}

interface OverviewResponse { overview: Overview }
interface TemplatesResponse { templates: Template[] }
interface EventsResponse { events: WebhookEvent[] }
interface WindowsResponse { windows: ConversationWindow[] }

const statusStyle: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-600',
  pending: 'bg-amber-50 text-amber-700',
  approved: 'bg-emerald-50 text-emerald-700',
  rejected: 'bg-red-50 text-red-600',
}

function formatDate(value?: string) {
  if (!value) return '-'
  return new Date(value).toLocaleString('es-PE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function templateStatus(status: string) {
  return <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${statusStyle[status] || statusStyle.draft}`}>{status}</span>
}

export default function WhatsAppAPISettingsPanel() {
  const [overview, setOverview] = useState<Overview | null>(null)
  const [templates, setTemplates] = useState<Template[]>([])
  const [events, setEvents] = useState<WebhookEvent[]>([])
  const [windows, setWindows] = useState<ConversationWindow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [templateName, setTemplateName] = useState('')
  const [language, setLanguage] = useState('es')
  const [category, setCategory] = useState('UTILITY')
  const [componentsJSON, setComponentsJSON] = useState('[{"type":"BODY","text":"Hola {{1}}"}]')

  const load = useCallback(async () => {
    setLoading(true)
    const [overviewRes, templatesRes, eventsRes, windowsRes] = await Promise.all([
      apiGet<OverviewResponse>('/api/whatsapp-api/overview'),
      apiGet<TemplatesResponse>('/api/whatsapp-api/templates'),
      apiGet<EventsResponse>('/api/whatsapp-api/webhook-events?limit=20'),
      apiGet<WindowsResponse>('/api/whatsapp-api/windows?limit=20'),
    ])
    if (overviewRes.success) setOverview(overviewRes.data?.overview || null)
    if (templatesRes.success) setTemplates(templatesRes.data?.templates || [])
    if (eventsRes.success) setEvents(eventsRes.data?.events || [])
    if (windowsRes.success) setWindows(windowsRes.data?.windows || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const handleCreateTemplate = async () => {
    if (!templateName.trim()) return
    let components: unknown
    try {
      components = JSON.parse(componentsJSON)
    } catch {
      setMessage({ type: 'error', text: 'JSON de componentes invalido' })
      return
    }
    setSaving(true)
    const res = await apiPost('/api/whatsapp-api/templates', {
      name: templateName.trim().toLowerCase().replace(/\s+/g, '_'),
      language,
      category,
      status: 'draft',
      components,
    })
    setSaving(false)
    if (res.success) {
      setTemplateName('')
      setMessage({ type: 'success', text: 'Plantilla guardada como borrador' })
      load()
    } else {
      setMessage({ type: 'error', text: res.error || 'No se pudo guardar' })
    }
  }

  const handleDeleteTemplate = async (id: string) => {
    if (!confirm('Eliminar plantilla local?')) return
    const res = await apiDelete(`/api/whatsapp-api/templates/${id}`)
    if (res.success) load()
    else setMessage({ type: 'error', text: res.error || 'No se pudo eliminar' })
  }

  if (loading) {
    return <div className="flex items-center justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-emerald-600" /></div>
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">WhatsApp API Oficial</h3>
          <p className="text-xs text-slate-500 mt-0.5">Canales API, webhooks, plantillas y ventanas de atencion.</p>
        </div>
        <button onClick={load} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-200 text-xs font-medium text-slate-600 hover:bg-slate-50">
          <RefreshCw className="w-3.5 h-3.5" /> Actualizar
        </button>
      </div>

      {message && (
        <div className={`flex items-center gap-2 rounded-xl px-3 py-2 text-xs ${message.type === 'success' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'}`}>
          {message.type === 'success' ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
          {message.text}
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <div className="border border-slate-200 rounded-xl p-3">
          <Globe className="w-4 h-4 text-sky-600 mb-2" />
          <p className="text-xl font-semibold text-slate-900">{overview?.cloud_channel_count || 0}</p>
          <p className="text-[11px] text-slate-500">Canales API</p>
        </div>
        <div className="border border-slate-200 rounded-xl p-3">
          <FileText className="w-4 h-4 text-emerald-600 mb-2" />
          <p className="text-xl font-semibold text-slate-900">{overview?.template_count || 0}</p>
          <p className="text-[11px] text-slate-500">Plantillas</p>
        </div>
        <div className="border border-slate-200 rounded-xl p-3">
          <CheckCircle2 className="w-4 h-4 text-emerald-600 mb-2" />
          <p className="text-xl font-semibold text-slate-900">{overview?.approved_templates || 0}</p>
          <p className="text-[11px] text-slate-500">Aprobadas</p>
        </div>
        <div className="border border-slate-200 rounded-xl p-3">
          <Activity className="w-4 h-4 text-slate-600 mb-2" />
          <p className="text-xl font-semibold text-slate-900">{overview?.webhook_event_count || 0}</p>
          <p className="text-[11px] text-slate-500">Webhooks</p>
        </div>
        <div className="border border-slate-200 rounded-xl p-3">
          <Clock className="w-4 h-4 text-amber-600 mb-2" />
          <p className="text-xl font-semibold text-slate-900">{overview?.open_window_count || 0}</p>
          <p className="text-[11px] text-slate-500">Ventanas 24h</p>
        </div>
      </div>

      <div className="border border-amber-200 bg-amber-50 rounded-xl p-3 flex items-start gap-2 text-xs text-amber-800">
        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
        <span>Envio oficial y plantillas enviables permanecen bloqueados. Esta pantalla prepara configuracion, auditoria y piloto inbound sin consumo pagado.</span>
      </div>

      <div className="grid lg:grid-cols-[360px_1fr] gap-4">
        <div className="border border-slate-200 rounded-xl p-4 space-y-3">
          <h4 className="text-sm font-medium text-slate-900">Nueva plantilla local</h4>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Nombre</label>
            <input value={templateName} onChange={e => setTemplateName(e.target.value)} placeholder="bienvenida_lead" className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Idioma</label>
              <input value={language} onChange={e => setLanguage(e.target.value)} className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/20" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Categoria</label>
              <select value={category} onChange={e => setCategory(e.target.value)} className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/20">
                <option value="UTILITY">UTILITY</option>
                <option value="MARKETING">MARKETING</option>
                <option value="AUTHENTICATION">AUTH</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Componentes JSON</label>
            <textarea value={componentsJSON} onChange={e => setComponentsJSON(e.target.value)} rows={5} className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs font-mono text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 resize-none" />
          </div>
          <button onClick={handleCreateTemplate} disabled={saving || !templateName.trim()} className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700 disabled:opacity-50">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Guardar borrador
          </button>
        </div>

        <div className="border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
            <h4 className="text-sm font-medium text-slate-900">Plantillas</h4>
            <span className="text-xs text-slate-400">{templates.length}</span>
          </div>
          {templates.length === 0 ? (
            <div className="p-6 text-center text-sm text-slate-500">Sin plantillas locales</div>
          ) : (
            <div className="divide-y divide-slate-100">
              {templates.map(template => (
                <div key={template.id} className="px-4 py-3 flex items-center justify-between gap-3 hover:bg-slate-50/70">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium text-slate-900 truncate">{template.name}</p>
                      {templateStatus(template.status)}
                    </div>
                    <p className="text-xs text-slate-500">{template.language} · {template.category} · {formatDate(template.updated_at)}</p>
                  </div>
                  <button onClick={() => handleDeleteTemplate(template.id)} className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50" title="Eliminar">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100"><h4 className="text-sm font-medium text-slate-900">Webhooks recientes</h4></div>
          <div className="divide-y divide-slate-100 max-h-72 overflow-y-auto">
            {events.length === 0 ? <div className="p-5 text-sm text-slate-500">Sin eventos recibidos</div> : events.map(event => (
              <div key={event.id} className="px-4 py-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-800 truncate">{event.event_type}</p>
                  <p className="text-xs text-slate-500 truncate">{event.phone_number_id || '-'} · {formatDate(event.received_at)}</p>
                  {event.error_message && <p className="text-xs text-red-600 truncate mt-0.5">{event.error_message}</p>}
                </div>
                {event.processed ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <XCircle className="w-4 h-4 text-amber-600" />}
              </div>
            ))}
          </div>
        </div>

        <div className="border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100"><h4 className="text-sm font-medium text-slate-900">Ventanas 24h</h4></div>
          <div className="divide-y divide-slate-100 max-h-72 overflow-y-auto">
            {windows.length === 0 ? <div className="p-5 text-sm text-slate-500">Sin conversaciones API</div> : windows.map(window => (
              <div key={window.chat_id} className="px-4 py-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-800 truncate">{window.name || window.jid}</p>
                  <p className="text-xs text-slate-500 truncate">Expira {formatDate(window.customer_service_window_expires_at)}</p>
                </div>
                <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${window.can_reply ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                  {window.can_reply ? 'Abierta' : 'Cerrada'}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
