'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Activity, AlertCircle, CheckCircle2, Clock, ExternalLink, FileText,
  Globe, Loader2, RefreshCw, ShieldCheck, Smartphone, XCircle,
} from 'lucide-react'
import { apiGet, apiPost } from '@/lib/api'

interface Overview {
  cloud_channel_count: number
  template_count: number
  approved_templates: number
  webhook_event_count: number
  open_window_count: number
}

interface CloudConfiguration {
  ready: boolean
  embedded_signup_ready: boolean
  app_id?: string
  configuration_id?: string
  graph_version: string
  webhook_url?: string
  webhook_verify_configured: boolean
  webhook_signature_configured: boolean
  token_encryption_configured: boolean
  missing: string[]
}

interface CloudChannel {
  id: string
  name?: string
  phone?: string
  status?: string
  waba_id?: string
  phone_number_id?: string
  api_display_phone?: string
  api_webhook_status?: string
  api_billing_status?: string
  api_sending_enabled: boolean
  api_templates_enabled: boolean
}

interface Template {
  id: string
  device_id?: string
  name: string
  language: string
  category: string
  status: string
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
  customer_service_window_expires_at?: string
  can_reply: boolean
}

interface EmbeddedSignupSession {
  waba_id: string
  phone_number_id?: string
  business_id?: string
}

interface MetaLoginResponse {
  authResponse?: { code?: string }
  status?: string
}

declare global {
  interface Window {
    FB?: {
      init: (options: Record<string, unknown>) => void
      login: (callback: (response: MetaLoginResponse) => void, options: Record<string, unknown>) => void
    }
  }
}

interface OverviewResponse { overview: Overview }
interface ConfigurationResponse { configuration: CloudConfiguration }
interface ConnectionsResponse { channels: CloudChannel[] }
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
  const normalized = status.toLowerCase()
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${statusStyle[normalized] || statusStyle.draft}`}>{normalized}</span>
}

let facebookSDKPromise: Promise<void> | null = null

function loadFacebookSDK() {
  if (typeof window === 'undefined') return Promise.reject(new Error('El navegador no está disponible'))
  if (window.FB) return Promise.resolve()
  if (facebookSDKPromise) return facebookSDKPromise
  facebookSDKPromise = new Promise<void>((resolve, reject) => {
    const existing = document.getElementById('facebook-jssdk') as HTMLScriptElement | null
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', () => reject(new Error('No se pudo cargar el SDK de Meta')), { once: true })
      return
    }
    const script = document.createElement('script')
    script.id = 'facebook-jssdk'
    script.async = true
    script.defer = true
    script.crossOrigin = 'anonymous'
    script.src = 'https://connect.facebook.net/es_LA/sdk.js'
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('No se pudo cargar el SDK de Meta'))
    document.body.appendChild(script)
  })
  return facebookSDKPromise
}

export default function WhatsAppAPISettingsPanel() {
  const [overview, setOverview] = useState<Overview | null>(null)
  const [configuration, setConfiguration] = useState<CloudConfiguration | null>(null)
  const [channels, setChannels] = useState<CloudChannel[]>([])
  const [templates, setTemplates] = useState<Template[]>([])
  const [events, setEvents] = useState<WebhookEvent[]>([])
  const [windows, setWindows] = useState<ConversationWindow[]>([])
  const [loading, setLoading] = useState(true)
  const [connecting, setConnecting] = useState(false)
  const [workingChannel, setWorkingChannel] = useState<string | null>(null)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const oauthCodeRef = useRef<string | null>(null)
  const sessionRef = useRef<EmbeddedSignupSession | null>(null)
  const completingRef = useRef(false)

  const load = useCallback(async () => {
    setLoading(true)
    const [configurationRes, overviewRes, channelsRes, templatesRes, eventsRes, windowsRes] = await Promise.all([
      apiGet<ConfigurationResponse>('/api/whatsapp-api/configuration'),
      apiGet<OverviewResponse>('/api/whatsapp-api/overview'),
      apiGet<ConnectionsResponse>('/api/whatsapp-api/connections'),
      apiGet<TemplatesResponse>('/api/whatsapp-api/templates'),
      apiGet<EventsResponse>('/api/whatsapp-api/webhook-events?limit=20'),
      apiGet<WindowsResponse>('/api/whatsapp-api/windows?limit=20'),
    ])
    if (configurationRes.success) setConfiguration(configurationRes.data?.configuration || null)
    if (overviewRes.success) setOverview(overviewRes.data?.overview || null)
    if (channelsRes.success) setChannels(channelsRes.data?.channels || [])
    if (templatesRes.success) setTemplates(templatesRes.data?.templates || [])
    if (eventsRes.success) setEvents(eventsRes.data?.events || [])
    if (windowsRes.success) setWindows(windowsRes.data?.windows || [])
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  const completeSignup = useCallback(async () => {
    const code = oauthCodeRef.current
    const session = sessionRef.current
    if (!code || !session || completingRef.current) return
    completingRef.current = true
    setConnecting(true)
    setMessage(null)
    const response = await apiPost<{ device?: CloudChannel; warning?: string }>('/api/whatsapp-api/embedded-signup/complete', {
      code,
      waba_id: session.waba_id,
      phone_number_id: session.phone_number_id,
      business_id: session.business_id,
      coexistence: true,
    })
    oauthCodeRef.current = null
    sessionRef.current = null
    completingRef.current = false
    setConnecting(false)
    if (!response.success) {
      setMessage({ type: 'error', text: response.error || 'No se pudo completar la conexión con Meta' })
      return
    }
    setMessage({ type: 'success', text: response.data?.warning || 'Número conectado directamente con Meta mediante Coexistence.' })
    await load()
  }, [load])

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const allowedOrigins = new Set(['https://www.facebook.com', 'https://web.facebook.com', 'https://business.facebook.com'])
      if (!allowedOrigins.has(event.origin)) return
      let payload: unknown = event.data
      if (typeof payload === 'string') {
        try { payload = JSON.parse(payload) } catch { return }
      }
      if (!payload || typeof payload !== 'object') return
      const data = payload as { type?: string; event?: string; data?: Record<string, string> }
      if (data.type !== 'WA_EMBEDDED_SIGNUP') return
      const completed = data.event === 'FINISH' || data.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'
      if (completed && data.data?.waba_id) {
        sessionRef.current = {
          waba_id: data.data.waba_id,
          phone_number_id: data.data.phone_number_id,
          business_id: data.data.business_id,
        }
        void completeSignup()
      } else if (data.event === 'ERROR') {
        setConnecting(false)
        setMessage({ type: 'error', text: 'Meta no pudo completar el alta. Revisa el número y vuelve a intentarlo.' })
      }
    }
    window.addEventListener('message', listener)
    return () => window.removeEventListener('message', listener)
  }, [completeSignup])

  const startEmbeddedSignup = async () => {
    if (!configuration?.embedded_signup_ready || !configuration.app_id || !configuration.configuration_id) return
    setConnecting(true)
    setMessage(null)
    oauthCodeRef.current = null
    sessionRef.current = null
    try {
      await loadFacebookSDK()
      if (!window.FB) throw new Error('El SDK de Meta no quedó disponible')
      window.FB.init({
        appId: configuration.app_id,
        autoLogAppEvents: true,
        xfbml: true,
        version: configuration.graph_version,
      })
      window.FB.login((response) => {
        const code = response.authResponse?.code
        if (!code) {
          setConnecting(false)
          setMessage({ type: 'error', text: 'La conexión con Meta fue cancelada o no devolvió un código válido.' })
          return
        }
        oauthCodeRef.current = code
        void completeSignup()
      }, {
        config_id: configuration.configuration_id,
        response_type: 'code',
        override_default_response_type: true,
        extras: {
          setup: {},
          feature: 'whatsapp_embedded_signup',
          featureType: 'whatsapp_business_app_onboarding',
          sessionInfoVersion: '3',
        },
      })
    } catch (error) {
      setConnecting(false)
      setMessage({ type: 'error', text: error instanceof Error ? error.message : 'No se pudo abrir Meta' })
    }
  }

  const runChannelAction = async (channelID: string, action: 'refresh' | 'templates/sync') => {
    setWorkingChannel(channelID)
    setMessage(null)
    const response = await apiPost<{ warning?: string; templates_synced?: number }>(`/api/whatsapp-api/connections/${channelID}/${action}`, {})
    setWorkingChannel(null)
    if (!response.success) {
      setMessage({ type: 'error', text: response.error || 'No se pudo actualizar el canal' })
      return
    }
    const text = response.data?.warning || (action === 'templates/sync'
      ? `${response.data?.templates_synced || 0} plantillas sincronizadas desde Meta.`
      : 'Canal verificado y suscrito nuevamente en Meta.')
    setMessage({ type: 'success', text })
    await load()
  }

  if (loading) {
    return <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-emerald-600" /></div>
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">WhatsApp API Oficial · directo con Meta</h3>
          <p className="mt-0.5 text-xs text-slate-500">Clarin actúa como Tech Provider; no se usa un BSP intermediario.</p>
        </div>
        <button type="button" onClick={() => void load()} className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-slate-200 px-3 text-xs font-semibold text-slate-600 hover:bg-slate-50">
          <RefreshCw className="h-3.5 w-3.5" /> Actualizar
        </button>
      </div>

      {message && (
        <div className={`flex items-start gap-2 rounded-xl px-3 py-2 text-xs ${message.type === 'success' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
          {message.type === 'success' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}
          <span>{message.text}</span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[
          [Globe, 'text-sky-600', overview?.cloud_channel_count || 0, 'Canales API'],
          [FileText, 'text-emerald-600', overview?.template_count || 0, 'Plantillas registradas'],
          [CheckCircle2, 'text-emerald-600', overview?.approved_templates || 0, 'Aprobadas'],
          [Activity, 'text-slate-600', overview?.webhook_event_count || 0, 'Webhooks'],
          [Clock, 'text-amber-600', overview?.open_window_count || 0, 'Ventanas 24h'],
        ].map(([Icon, color, value, label]) => {
          const MetricIcon = Icon as typeof Globe
          return <div key={String(label)} className="rounded-xl border border-slate-200 p-3"><MetricIcon className={`mb-2 h-4 w-4 ${color}`} /><p className="text-xl font-semibold text-slate-900">{String(value)}</p><p className="text-[11px] text-slate-500">{String(label)}</p></div>
        })}
      </div>

      <section className="rounded-2xl border border-slate-200 bg-gradient-to-br from-white to-emerald-50/40 p-4 sm:p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-start gap-3">
            <div className="rounded-xl bg-emerald-100 p-2.5 text-emerald-700"><ShieldCheck className="h-5 w-5" /></div>
            <div>
              <h4 className="text-sm font-bold text-slate-900">Conectar WhatsApp Business App con Coexistence</h4>
              <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-600">El número sigue funcionando en el teléfono y se habilita en Cloud API. Meta desconectará los dispositivos vinculados actuales durante el alta; después podrán volver a vincularse los compatibles.</p>
              {configuration?.webhook_url && <p className="mt-2 break-all text-[11px] text-slate-500">Webhook: {configuration.webhook_url}</p>}
            </div>
          </div>
          <button type="button" onClick={() => void startEmbeddedSignup()} disabled={connecting || !configuration?.ready} className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-bold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50">
            {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
            {connecting ? 'Conectando con Meta…' : 'Conectar con Meta'}
          </button>
        </div>
        {!configuration?.ready && (
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
            <p className="font-semibold">Falta configuración segura del servidor.</p>
            <p className="mt-1 break-words">{configuration?.missing?.join(', ') || 'Configuración no disponible'}</p>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-slate-200">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3"><h4 className="text-sm font-semibold text-slate-900">Números conectados</h4><span className="text-xs text-slate-400">{channels.length}</span></div>
        {channels.length === 0 ? <div className="p-6 text-center text-sm text-slate-500">Todavía no hay números oficiales conectados.</div> : (
          <div className="divide-y divide-slate-100">
            {channels.map(channel => (
              <div key={channel.id} className="flex flex-col gap-3 px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex min-w-0 items-start gap-3">
                  <div className="rounded-xl bg-sky-50 p-2 text-sky-700"><Smartphone className="h-4 w-4" /></div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-900">{channel.name || 'WhatsApp API'}</p>
                    <p className="text-xs text-slate-500">{channel.api_display_phone || channel.phone || 'Número pendiente'} · {channel.status || 'sin estado'}</p>
                    <div className="mt-1 flex flex-wrap gap-1.5 text-[11px]">
                      <span className={`rounded-full px-2 py-0.5 ${channel.api_sending_enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{channel.api_sending_enabled ? 'Envío activo' : 'Envío inactivo'}</span>
                      <span className={`rounded-full px-2 py-0.5 ${channel.api_templates_enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>{channel.api_templates_enabled ? 'Plantillas activas' : 'Plantillas pendientes'}</span>
                      <span className="rounded-full bg-sky-50 px-2 py-0.5 text-sky-700">Pago directo a Meta</span>
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => void runChannelAction(channel.id, 'templates/sync')} disabled={workingChannel === channel.id} className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-slate-200 px-3 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"><FileText className="h-3.5 w-3.5" /> Sincronizar plantillas</button>
                  <button type="button" onClick={() => void runChannelAction(channel.id, 'refresh')} disabled={workingChannel === channel.id} className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-slate-200 px-3 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50">{workingChannel === channel.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Verificar conexión</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-slate-200">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3"><h4 className="text-sm font-semibold text-slate-900">Plantillas registradas</h4><span className="text-xs text-slate-400">{templates.length}</span></div>
          <div className="max-h-72 divide-y divide-slate-100 overflow-y-auto">
            {templates.length === 0 ? <div className="p-5 text-sm text-slate-500">Sin plantillas sincronizadas</div> : templates.map(template => (
              <div key={template.id} className="px-4 py-3"><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-medium text-slate-800">{template.name}</p>{templateStatus(template.status)}</div><p className="text-xs text-slate-500">{template.language} · {template.category} · {formatDate(template.updated_at)}</p></div>
            ))}
          </div>
        </section>

        <section className="rounded-xl border border-slate-200">
          <div className="border-b border-slate-100 px-4 py-3"><h4 className="text-sm font-semibold text-slate-900">Ventanas de atención</h4></div>
          <div className="max-h-72 divide-y divide-slate-100 overflow-y-auto">
            {windows.length === 0 ? <div className="p-5 text-sm text-slate-500">Sin conversaciones API</div> : windows.map(window => (
              <div key={window.chat_id} className="flex items-center justify-between gap-3 px-4 py-3"><div className="min-w-0"><p className="truncate text-sm font-medium text-slate-800">{window.name || window.jid}</p><p className="truncate text-xs text-slate-500">Expira {formatDate(window.customer_service_window_expires_at)}</p></div><span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${window.can_reply ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{window.can_reply ? 'Abierta' : 'Cerrada'}</span></div>
            ))}
          </div>
        </section>
      </div>

      <section className="rounded-xl border border-slate-200">
        <div className="border-b border-slate-100 px-4 py-3"><h4 className="text-sm font-semibold text-slate-900">Webhooks recientes</h4></div>
        <div className="max-h-72 divide-y divide-slate-100 overflow-y-auto">
          {events.length === 0 ? <div className="p-5 text-sm text-slate-500">Sin eventos recibidos</div> : events.map(event => (
            <div key={event.id} className="flex items-center justify-between gap-3 px-4 py-3"><div className="min-w-0"><p className="truncate text-sm font-medium text-slate-800">{event.event_type}</p><p className="truncate text-xs text-slate-500">{event.phone_number_id || '-'} · {formatDate(event.received_at)}</p>{event.error_message && <p className="mt-0.5 truncate text-xs text-red-600">{event.error_message}</p>}</div>{event.processed ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <XCircle className="h-4 w-4 text-amber-600" />}</div>
          ))}
        </div>
      </section>
    </div>
  )
}
