'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowRight,
  BarChart3,
  CalendarClock,
  CheckCircle2,
  Clock3,
  Handshake,
  ListChecks,
  MessageSquare,
  RefreshCw,
  Smartphone,
  TrendingDown,
  TrendingUp,
  WifiOff,
} from 'lucide-react'
import { api } from '@/lib/api'

type PeriodPreset = '7d' | '30d' | '90d'

interface DashboardPeriod {
  preset: PeriodPreset
  from: string
  to: string
  previous_from: string
  previous_to: string
}

interface DashboardSections {
  leads: boolean
  chats: boolean
  tasks: boolean
  events: boolean
  devices: boolean
}

interface ComparisonMetric {
  current: number
  previous: number
  change_percent: number | null
}

interface DashboardTrendPoint {
  date: string
  new: number
  won: number
  lost: number
}

interface DashboardPipeline {
  id: string
  name: string
  unassigned_count: number
  stages: Array<{ id: string; name: string; color: string; count: number }>
}

interface DashboardLeads {
  open: number
  new: ComparisonMetric
  won: ComparisonMetric
  conversion: {
    current_percent: number | null
    previous_percent: number | null
    change_points: number | null
  }
  trend: DashboardTrendPoint[]
  pipeline?: DashboardPipeline
}

interface DashboardChats {
  total: number
  unread_total: number
  awaiting_reply: number
  items: Array<{
    id: string
    display_name: string
    last_message: string | null
    last_message_at: string | null
    last_inbound_at: string | null
    unread_count: number
  }>
}

interface DashboardTasks {
  overdue: number
  due_today: number
  items: Array<{
    id: string
    title: string
    due_at: string | null
    status: string
    type: string
  }>
}

interface DashboardEvents {
  overdue_followups: number
  due_next_7_days: number
  items: Array<{
    participant_id: string
    event_id: string
    event_name: string
    participant_name: string
    next_action: string | null
    next_action_date: string
  }>
}

interface DashboardDevices {
  total: number
  connected: number
  connecting: number
  disconnected: number
  issues: Array<{
    id: string
    name: string
    phone: string | null
    status: string
  }>
}

interface DashboardSummary {
  generated_at: string
  timezone: string
  period: DashboardPeriod
  sections: DashboardSections
  leads?: DashboardLeads
  chats?: DashboardChats
  tasks?: DashboardTasks
  events?: DashboardEvents
  devices?: DashboardDevices
}

interface DashboardResponse {
  success: boolean
  dashboard?: DashboardSummary
  error?: string
}

const numberFormatter = new Intl.NumberFormat('es-PE')
const decimalFormatter = new Intl.NumberFormat('es-PE', { maximumFractionDigits: 1 })

function formatNumber(value: number) {
  return numberFormatter.format(value || 0)
}

function formatPercent(value: number | null) {
  return value === null ? '—' : `${decimalFormatter.format(value)}%`
}

function formatDateTime(value: string | null, timezone = 'America/Lima') {
  if (!value) return 'Sin fecha'
  return new Date(value).toLocaleString('es-PE', {
    timeZone: timezone,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatUpdatedAt(value: string | undefined, timezone = 'America/Lima') {
  if (!value) return ''
  return new Date(value).toLocaleTimeString('es-PE', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatWaitingSince(value: string | null) {
  if (!value) return 'Sin hora registrada'
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime())
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 60) return `Espera ${Math.max(1, minutes)} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Espera ${hours} h`
  return `Espera ${Math.floor(hours / 24)} d`
}

function ComparisonBadge({ value, suffix = '%' }: { value: number | null; suffix?: string }) {
  if (value === null) {
    return <span className="text-[11px] font-medium text-slate-400">Sin base comparable</span>
  }
  if (value === 0) {
    return <span className="text-[11px] font-bold text-slate-400">0{suffix}</span>
  }
  const positive = value >= 0
  const Icon = positive ? TrendingUp : TrendingDown
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-bold ${positive ? 'text-emerald-600' : 'text-rose-600'}`}>
      <Icon className="h-3 w-3" />
      {positive ? '+' : ''}{decimalFormatter.format(value)}{suffix}
    </span>
  )
}

function MetricCard({
  label,
  value,
  detail,
  comparison,
  comparisonSuffix,
  icon: Icon,
  tone,
}: {
  label: string
  value: string
  detail: string
  comparison?: number | null
  comparisonSuffix?: string
  icon: typeof Handshake
  tone: 'emerald' | 'blue' | 'violet' | 'amber'
}) {
  const tones = {
    emerald: 'bg-emerald-50 text-emerald-700',
    blue: 'bg-blue-50 text-blue-700',
    violet: 'bg-violet-50 text-violet-700',
    amber: 'bg-amber-50 text-amber-700',
  }
  return (
    <div className="rounded-2xl border border-slate-200/90 bg-white p-4 shadow-sm shadow-slate-200/30">
      <div className="flex items-start justify-between gap-3">
        <div className={`flex h-9 w-9 items-center justify-center rounded-xl ${tones[tone]}`}>
          <Icon className="h-[18px] w-[18px]" />
        </div>
        {comparison !== undefined && <ComparisonBadge value={comparison} suffix={comparisonSuffix} />}
      </div>
      <p className="mt-4 text-2xl font-black tracking-tight text-slate-900 tabular-nums">{value}</p>
      <p className="mt-0.5 text-xs font-bold text-slate-700">{label}</p>
      <p className="mt-1 text-[11px] leading-4 text-slate-400">{detail}</p>
    </div>
  )
}

function AttentionCard({
  label,
  value,
  detail,
  href,
  icon: Icon,
  urgent,
}: {
  label: string
  value: number
  detail: string
  href: string
  icon: typeof MessageSquare
  urgent?: boolean
}) {
  return (
    <Link
      href={href}
      className="group flex min-w-0 items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 transition hover:border-emerald-200 hover:shadow-sm"
    >
      <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${urgent && value > 0 ? 'bg-rose-50 text-rose-600' : 'bg-slate-100 text-slate-600'}`}>
        <Icon className="h-[18px] w-[18px]" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-lg font-black text-slate-900 tabular-nums">{formatNumber(value)}</span>
          <span className="truncate text-xs font-bold text-slate-700">{label}</span>
        </div>
        <p className="truncate text-[11px] text-slate-400">{detail}</p>
      </div>
      <ArrowRight className="h-4 w-4 shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-emerald-600" />
    </Link>
  )
}

function EmptyState({ message, detail = 'No hay acciones pendientes en este momento.' }: { message: string; detail?: string }) {
  return (
    <div className="flex min-h-32 flex-col items-center justify-center px-4 py-8 text-center">
      <CheckCircle2 className="h-7 w-7 text-emerald-500" />
      <p className="mt-2 text-sm font-semibold text-slate-600">{message}</p>
      {detail && <p className="mt-1 text-xs text-slate-400">{detail}</p>}
    </div>
  )
}

function TrendChart({ points }: { points: DashboardTrendPoint[] }) {
  const chart = useMemo(() => {
    const width = 720
    const height = 220
    const left = 38
    const right = 12
    const top = 14
    const bottom = 30
    const plotWidth = width - left - right
    const plotHeight = height - top - bottom
    const maximum = Math.max(2, ...points.flatMap(point => [point.new, point.won, point.lost]))
    const x = (index: number) => left + (points.length <= 1 ? plotWidth / 2 : (index / (points.length - 1)) * plotWidth)
    const y = (value: number) => top + plotHeight - (value / maximum) * plotHeight
    const series = [
      { key: 'new' as const, label: 'Nuevas', color: '#059669' },
      { key: 'won' as const, label: 'Ganadas', color: '#2563eb' },
      { key: 'lost' as const, label: 'Perdidas', color: '#e11d48' },
    ]
    return { width, height, left, right, top, bottom, plotWidth, plotHeight, maximum, x, y, series }
  }, [points])

  const hasActivity = points.some(point => point.new > 0 || point.won > 0 || point.lost > 0)
  if (!hasActivity) return <EmptyState message="Aún no hay actividad comercial en este periodo" detail="Prueba otro periodo o revisa las oportunidades en Leads." />

  const tickIndexes = Array.from(new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])).filter(index => index >= 0)
  return (
    <div>
      <div className="h-[220px] w-full overflow-hidden">
        <svg viewBox={`0 0 ${chart.width} ${chart.height}`} className="h-full w-full" role="img" aria-label="Tendencia de oportunidades nuevas, ganadas y perdidas">
          {[0, 0.5, 1].map(fraction => {
            const y = chart.top + chart.plotHeight * fraction
            const value = Math.round(chart.maximum * (1 - fraction))
            return (
              <g key={fraction}>
                <line x1={chart.left} x2={chart.width - chart.right} y1={y} y2={y} stroke="#e2e8f0" strokeDasharray="4 4" />
                <text x={chart.left - 8} y={y + 4} textAnchor="end" className="fill-slate-400 text-[10px]">{value}</text>
              </g>
            )
          })}
          {chart.series.map(serie => (
            <polyline
              key={serie.key}
              fill="none"
              stroke={serie.color}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              points={points.map((point, index) => `${chart.x(index)},${chart.y(point[serie.key])}`).join(' ')}
            />
          ))}
          {tickIndexes.map(index => (
            <text key={index} x={chart.x(index)} y={chart.height - 8} textAnchor="middle" className="fill-slate-400 text-[10px]">
              {new Date(`${points[index].date}T12:00:00`).toLocaleDateString('es-PE', { day: '2-digit', month: 'short' })}
            </text>
          ))}
        </svg>
      </div>
      <div className="mt-1 flex flex-wrap items-center justify-center gap-4">
        {chart.series.map(serie => (
          <span key={serie.key} className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: serie.color }} /> {serie.label}
          </span>
        ))}
      </div>
    </div>
  )
}

function DashboardSkeleton() {
  return (
    <div className="animate-pulse space-y-5">
      <div className="flex items-center justify-between">
        <div className="space-y-2"><div className="h-6 w-44 rounded bg-slate-200" /><div className="h-4 w-72 rounded bg-slate-100" /></div>
        <div className="h-9 w-48 rounded-xl bg-slate-200" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[0, 1, 2, 3].map(item => <div key={item} className="h-20 rounded-xl bg-slate-100" />)}</div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[0, 1, 2, 3].map(item => <div key={item} className="h-40 rounded-2xl bg-slate-100" />)}</div>
      <div className="grid gap-4 xl:grid-cols-3"><div className="h-80 rounded-2xl bg-slate-100 xl:col-span-2" /><div className="h-80 rounded-2xl bg-slate-100" /></div>
    </div>
  )
}

export default function DashboardPage() {
  const [period, setPeriod] = useState<PeriodPreset>('30d')
  const [dashboard, setDashboard] = useState<DashboardSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const requestIdRef = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)

  const loadDashboard = useCallback(async (showSkeleton: boolean) => {
    const requestId = ++requestIdRef.current
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    if (showSkeleton) setLoading(true)
    else setRefreshing(true)
    setError('')

    const result = await api<DashboardResponse>(`/api/dashboard/summary?period=${period}`, {
      signal: controller.signal,
      cache: 'no-store',
    })
    if (requestId !== requestIdRef.current) return

    if (result.success && result.data?.success && result.data.dashboard) {
      setDashboard(result.data.dashboard)
    } else {
      setError(result.error || result.data?.error || 'No se pudo cargar el resumen de la cuenta.')
    }
    setLoading(false)
    setRefreshing(false)
  }, [period])

  useEffect(() => {
    void loadDashboard(true)
    return () => {
      requestIdRef.current += 1
      controllerRef.current?.abort()
    }
  }, [loadDashboard])

  const handlePeriodChange = (nextPeriod: PeriodPreset) => {
    if (nextPeriod === period) return
    setDashboard(null)
    setError('')
    setLoading(true)
    setPeriod(nextPeriod)
  }

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadDashboard(false)
    }, 60_000)
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void loadDashboard(false)
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [loadDashboard])

  if (loading && !dashboard) return <DashboardSkeleton />

  if (!dashboard) {
    return (
      <div className="flex min-h-[420px] items-center justify-center">
        <div className="max-w-md rounded-2xl border border-rose-200 bg-white p-6 text-center shadow-sm">
          <AlertCircle className="mx-auto h-8 w-8 text-rose-500" />
          <h1 className="mt-3 text-lg font-bold text-slate-900">No pudimos cargar el Dashboard</h1>
          <p className="mt-1 text-sm text-slate-500">{error || 'Revisa tu conexión e inténtalo nuevamente.'}</p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            {(['7d', '30d', '90d'] as PeriodPreset[]).filter(option => option !== period).map(option => (
              <button key={option} type="button" onClick={() => handlePeriodChange(option)} className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold text-slate-600 hover:border-emerald-300 hover:text-emerald-700">
                Probar {option.replace('d', ' días')}
              </button>
            ))}
            <button type="button" onClick={() => void loadDashboard(true)} className="inline-flex h-10 items-center gap-2 rounded-xl bg-slate-900 px-4 text-sm font-bold text-white hover:bg-slate-800">
              <RefreshCw className="h-4 w-4" /> Reintentar
            </button>
          </div>
        </div>
      </div>
    )
  }

  const { sections, leads, chats, tasks, events, devices } = dashboard
  const hasAttention = sections.chats || sections.tasks || sections.events || sections.devices
  const hasAgenda = sections.tasks || sections.events
  const hasAnySection = Object.values(sections).some(Boolean)

  return (
    <div className="mx-auto min-h-0 w-full max-w-[1600px] space-y-5 overflow-y-auto pb-4">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-black tracking-tight text-slate-900">Resumen de la cuenta</h1>
            <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-700">Datos reales</span>
          </div>
          <p className="mt-1 text-sm text-slate-500">Prioridades actuales y evolución comercial en un solo lugar.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {sections.leads && (
            <div className="inline-flex rounded-xl border border-slate-200 bg-white p-1 shadow-sm" aria-label="Periodo del dashboard">
              {(['7d', '30d', '90d'] as PeriodPreset[]).map(option => (
                <button
                  key={option}
                  type="button"
                  onClick={() => handlePeriodChange(option)}
                  disabled={loading}
                  className={`h-8 rounded-lg px-3 text-xs font-bold transition ${period === option ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800'} disabled:cursor-wait`}
                >
                  {option.replace('d', ' días')}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={() => void loadDashboard(false)}
            disabled={refreshing || loading}
            className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold text-slate-600 shadow-sm transition hover:border-emerald-200 hover:text-emerald-700 disabled:cursor-wait disabled:opacity-60"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing || loading ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">Actualizar</span>
          </button>
        </div>
      </header>

      {error && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <span className="flex items-center gap-2"><AlertCircle className="h-4 w-4 shrink-0" /> {error} Se mantienen los últimos datos disponibles.</span>
          <button type="button" onClick={() => void loadDashboard(false)} className="shrink-0 text-xs font-bold underline">Reintentar</button>
        </div>
      )}

      {!hasAnySection && (
        <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center">
          <BarChart3 className="mx-auto h-8 w-8 text-slate-300" />
          <h2 className="mt-3 font-bold text-slate-800">Dashboard listo</h2>
          <p className="mt-1 text-sm text-slate-500">Tu rol todavía no tiene módulos operativos habilitados en esta cuenta.</p>
        </div>
      )}

      {hasAttention && (
        <section>
          <div className="mb-2 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-black text-slate-800">Requiere atención</h2>
              <p className="text-[11px] text-slate-400">Indicadores actuales, fuera del filtro de periodo.</p>
            </div>
            <span className="text-[11px] text-slate-400">Actualizado {formatUpdatedAt(dashboard.generated_at, dashboard.timezone)}</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {sections.chats && chats && (
              <AttentionCard label="chats por responder" value={chats.awaiting_reply} detail={`${formatNumber(chats.unread_total)} mensajes no leídos en total`} href="/dashboard/chats" icon={MessageSquare} urgent />
            )}
            {sections.tasks && tasks && (
              <AttentionCard label="mis tareas vencidas" value={tasks.overdue} detail={`${formatNumber(tasks.due_today)} adicionales para hoy`} href="/dashboard/tasks" icon={ListChecks} urgent />
            )}
            {sections.events && events && (
              <AttentionCard label="seguimientos vencidos" value={events.overdue_followups} detail={`${formatNumber(events.due_next_7_days)} próximos en 7 días`} href="/dashboard/events" icon={CalendarClock} urgent />
            )}
            {sections.devices && devices && (
              <AttentionCard label="canales con incidencia" value={devices.disconnected + devices.connecting} detail={`${formatNumber(devices.connected)} de ${formatNumber(devices.total)} conectados`} href="/dashboard/devices" icon={WifiOff} urgent />
            )}
          </div>
        </section>
      )}

      {sections.leads && leads && (
        <section>
          <div className="mb-2">
            <h2 className="text-sm font-black text-slate-800">Rendimiento comercial</h2>
            <p className="text-[11px] text-slate-400">Comparación con los {dashboard.period.preset.replace('d', '')} días inmediatamente anteriores.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard label="Oportunidades abiertas" value={formatNumber(leads.open)} detail="Activas ahora, sin archivadas ni eliminadas" icon={Handshake} tone="emerald" />
            <MetricCard label="Nuevas oportunidades" value={formatNumber(leads.new.current)} detail={`${formatNumber(leads.new.previous)} en el periodo anterior`} comparison={leads.new.change_percent} icon={TrendingUp} tone="blue" />
            <MetricCard label="Oportunidades ganadas" value={formatNumber(leads.won.current)} detail={`${formatNumber(leads.won.previous)} en el periodo anterior`} comparison={leads.won.change_percent} icon={CheckCircle2} tone="violet" />
            <MetricCard label="Conversión de cierres" value={formatPercent(leads.conversion.current_percent)} detail="Ganadas sobre ganadas + perdidas" comparison={leads.conversion.change_points} comparisonSuffix=" pp" icon={BarChart3} tone="amber" />
          </div>
        </section>
      )}

      {sections.leads && leads && (
        <div className="grid gap-4 xl:grid-cols-3">
          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm shadow-slate-200/30 xl:col-span-2">
            <div className="flex items-start justify-between gap-3">
              <div><h2 className="text-sm font-black text-slate-800">Actividad comercial</h2><p className="mt-0.5 text-[11px] text-slate-400">Altas y cierres por día.</p></div>
              <Link href="/dashboard/leads" className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700 hover:text-emerald-800">Abrir leads <ArrowRight className="h-3.5 w-3.5" /></Link>
            </div>
            <div className="mt-3"><TrendChart points={leads.trend || []} /></div>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm shadow-slate-200/30">
            <div className="flex items-start justify-between gap-3">
              <div><h2 className="text-sm font-black text-slate-800">Salud del pipeline</h2><p className="mt-0.5 truncate text-[11px] text-slate-400">{leads.pipeline?.name || 'Sin pipeline configurado'}</p></div>
              <BarChart3 className="h-5 w-5 text-slate-300" />
            </div>
            {leads.pipeline ? (() => {
              const rows = [
                ...leads.pipeline.stages,
                ...(leads.pipeline.unassigned_count > 0 ? [{ id: '__unassigned__', name: 'Sin etapa', color: '#94a3b8', count: leads.pipeline.unassigned_count }] : []),
              ]
              const total = rows.reduce((sum, row) => sum + row.count, 0)
              return rows.length === 0 ? <EmptyState message="Este pipeline todavía no tiene etapas" detail="Agrega etapas desde la vista de Leads para visualizar su distribución." /> : (
                <div className="mt-5 space-y-3">
                  {rows.map(row => (
                    <div key={row.id}>
                      <div className="mb-1 flex items-center justify-between gap-3 text-xs"><span className="truncate font-semibold text-slate-600">{row.name}</span><span className="font-bold tabular-nums text-slate-800">{formatNumber(row.count)}</span></div>
                      <div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full ${row.count > 0 ? 'min-w-[2px]' : ''}`} style={{ width: `${total > 0 ? (row.count / total) * 100 : 0}%`, backgroundColor: row.color || '#94a3b8' }} /></div>
                    </div>
                  ))}
                  <p className="pt-1 text-right text-[11px] text-slate-400">{formatNumber(total)} oportunidades abiertas</p>
                </div>
              )
            })() : <EmptyState message="Configura un pipeline para ver su distribución" detail="Puedes crearlo y administrarlo desde la vista de Leads." />}
          </section>
        </div>
      )}

      {(sections.chats || hasAgenda || (sections.devices && devices && devices.issues.length > 0)) && (
        <div className="grid gap-4 xl:grid-cols-2">
          {sections.chats && chats && (
            <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm shadow-slate-200/30">
              <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                <div><h2 className="text-sm font-black text-slate-800">Esperan respuesta</h2><p className="mt-0.5 text-[11px] text-slate-400">Las conversaciones más antiguas primero.</p></div>
                <Link href="/dashboard/chats" className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700">Ver todos <ArrowRight className="h-3.5 w-3.5" /></Link>
              </div>
              {chats.items.length === 0 ? <EmptyState message="No hay conversaciones esperando respuesta" /> : (
                <div className="divide-y divide-slate-100">
                  {chats.items.map(chat => (
                    <Link key={chat.id} href={`/dashboard/chats?open=${chat.id}`} className="group flex items-center gap-3 px-4 py-3 hover:bg-slate-50/70">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-sm font-black text-emerald-700">{chat.display_name.charAt(0).toUpperCase()}</div>
                      <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><p className="truncate text-sm font-bold text-slate-700">{chat.display_name}</p>{chat.unread_count > 0 && <span className="rounded-full bg-emerald-600 px-1.5 py-0.5 text-[9px] font-black text-white">{chat.unread_count}</span>}</div><p className="mt-0.5 truncate text-xs text-slate-400">{chat.last_message || 'Mensaje recibido sin vista previa'}</p></div>
                      <span className="shrink-0 text-[10px] font-bold text-amber-600">{formatWaitingSince(chat.last_inbound_at)}</span>
                    </Link>
                  ))}
                </div>
              )}
            </section>
          )}

          {hasAgenda && (
            <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm shadow-slate-200/30">
              <div className="border-b border-slate-100 px-4 py-3"><h2 className="text-sm font-black text-slate-800">Agenda operativa</h2><p className="mt-0.5 text-[11px] text-slate-400">Tareas personales y próximos seguimientos.</p></div>
              <div className="divide-y divide-slate-100">
                {sections.tasks && tasks && tasks.items.slice(0, 3).map(task => (
                  <Link key={`task-${task.id}`} href="/dashboard/tasks" className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50/70">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600"><ListChecks className="h-4 w-4" /></div>
                    <div className="min-w-0 flex-1"><p className="truncate text-sm font-bold text-slate-700">{task.title}</p><p className="mt-0.5 text-[11px] text-slate-400">Mi tarea · {formatDateTime(task.due_at, dashboard.timezone)}</p></div>
                    {task.due_at && new Date(task.due_at).getTime() < Date.now() && <span className="text-[10px] font-bold text-rose-600">Vencida</span>}
                  </Link>
                ))}
                {sections.events && events && events.items.slice(0, 3).map(item => (
                  <Link key={`event-${item.participant_id}`} href={`/dashboard/events/${item.event_id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50/70">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-50 text-violet-600"><CalendarClock className="h-4 w-4" /></div>
                    <div className="min-w-0 flex-1"><p className="truncate text-sm font-bold text-slate-700">{item.next_action || `Seguimiento con ${item.participant_name}`}</p><p className="mt-0.5 truncate text-[11px] text-slate-400">{item.event_name} · {item.participant_name}</p></div>
                    <span className={`shrink-0 text-[10px] font-bold ${new Date(item.next_action_date).getTime() < Date.now() ? 'text-rose-600' : 'text-slate-400'}`}>{formatDateTime(item.next_action_date, dashboard.timezone)}</span>
                  </Link>
                ))}
                {((!tasks || tasks.items.length === 0) && (!events || events.items.length === 0)) && <EmptyState message="Tu agenda está al día" />}
              </div>
            </section>
          )}

          {!hasAgenda && !sections.chats && sections.devices && devices && devices.issues.length > 0 && (
            <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm shadow-slate-200/30">
              <div className="border-b border-slate-100 px-4 py-3"><h2 className="text-sm font-black text-slate-800">Canales con incidencia</h2></div>
              <div className="divide-y divide-slate-100">{devices.issues.map(device => <Link key={device.id} href="/dashboard/devices" className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50"><Smartphone className="h-4 w-4 text-slate-400" /><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold text-slate-700">{device.name}</p><p className="text-[11px] text-slate-400">{device.phone || 'Sin número'}</p></div><span className="text-[10px] font-bold text-rose-600">{device.status === 'connecting' ? 'Conectando' : 'Desconectado'}</span></Link>)}</div>
            </section>
          )}
        </div>
      )}

      <footer className="flex items-center justify-between border-t border-slate-200 pt-3 text-[10px] text-slate-400">
        <span>{sections.leads ? `Periodo comercial: ${dashboard.period.preset.replace('d', ' días')} · ` : 'Indicadores operativos actuales · '}Zona horaria {dashboard.timezone}</span>
        <span className="inline-flex items-center gap-1"><Clock3 className="h-3 w-3" /> Actualización automática cada minuto</span>
      </footer>
    </div>
  )
}
