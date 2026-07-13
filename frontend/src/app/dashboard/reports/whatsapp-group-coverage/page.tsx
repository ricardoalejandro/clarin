'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  AlertCircle, ArrowLeft, BarChart3, CheckCircle2, ChevronLeft, ChevronRight,
  Download, FileSpreadsheet, Loader2, RefreshCw, Search, ShieldAlert,
  Smartphone, Tags, UserCheck, UserRoundX, UsersRound,
} from 'lucide-react'
import WhatsAppGroupSelector from '@/components/reports/WhatsAppGroupSelector'
import type {
  CoverageStatus, ReportDevice, WhatsAppGroupCoverageMember,
  WhatsAppGroupCoverageReport, WhatsAppGroupOption,
} from '@/types/report'
import { exportWhatsAppGroupReportCSV, exportWhatsAppGroupReportExcel } from '@/utils/whatsappGroupReportExport'

const PAGE_SIZE = 50

const statusMeta: Record<CoverageStatus, { label: string; className: string; priority: number }> = {
  ambiguous: { label: 'Revisar duplicado', className: 'bg-amber-50 text-amber-700 border-amber-200', priority: 0 },
  not_registered: { label: 'No registrado', className: 'bg-rose-50 text-rose-700 border-rose-200', priority: 1 },
  contact_only: { label: 'Solo contacto', className: 'bg-slate-100 text-slate-700 border-slate-200', priority: 2 },
  historical_only: { label: 'Con historial', className: 'bg-violet-50 text-violet-700 border-violet-200', priority: 3 },
  active_management: { label: 'Gestión activa', className: 'bg-emerald-50 text-emerald-700 border-emerald-200', priority: 4 },
  unidentifiable: { label: 'No identificable', className: 'bg-orange-50 text-orange-700 border-orange-200', priority: 5 },
}

const roleLabels: Record<WhatsAppGroupCoverageMember['role'], string> = {
  owner: 'Propietario',
  super_admin: 'Admin. principal',
  admin: 'Administrador',
  member: 'Integrante',
}

function authHeaders(json = false): HeadersInit {
  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  }
}

function displayPhone(member: WhatsAppGroupCoverageMember) {
  if (member.phone) return `+${member.phone}`
  return member.redacted_phone || 'No disponible'
}

function formatDateTime(value?: string | null) {
  if (!value) return 'Sin actividad'
  return new Date(value).toLocaleString('es-PE', { dateStyle: 'medium', timeStyle: 'short' })
}

function MetricCard({ label, value, detail, tone = 'slate' }: { label: string; value: string | number; detail: string; tone?: 'slate' | 'emerald' | 'rose' | 'violet' | 'amber' }) {
  const tones = {
    slate: 'bg-slate-50 text-slate-700 border-slate-200',
    emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    rose: 'bg-rose-50 text-rose-700 border-rose-200',
    violet: 'bg-violet-50 text-violet-700 border-violet-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
  }
  return (
    <div className={`rounded-xl border p-4 ${tones[tone]}`}>
      <p className="text-[11px] font-bold uppercase tracking-wider opacity-70">{label}</p>
      <p className="mt-1 text-2xl font-black">{value}</p>
      <p className="mt-1 text-xs opacity-70">{detail}</p>
    </div>
  )
}

export default function WhatsAppGroupCoveragePage() {
  const [devices, setDevices] = useState<ReportDevice[]>([])
  const [devicesLoading, setDevicesLoading] = useState(true)
  const [devicesError, setDevicesError] = useState('')
  const [selectedDeviceID, setSelectedDeviceID] = useState('')
  const [groups, setGroups] = useState<WhatsAppGroupOption[]>([])
  const [groupsLoading, setGroupsLoading] = useState(false)
  const [groupsError, setGroupsError] = useState('')
  const [selectedGroupID, setSelectedGroupID] = useState('')
  const [report, setReport] = useState<WhatsAppGroupCoverageReport | null>(null)
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState('')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | CoverageStatus>('all')
  const [page, setPage] = useState(1)
  const groupRequestRef = useRef<AbortController | null>(null)
  const reportRequestRef = useRef<AbortController | null>(null)

  const loadDevices = useCallback(async () => {
    setDevicesLoading(true)
    setDevicesError('')
    try {
      const response = await fetch('/api/devices', { headers: authHeaders(), credentials: 'include' })
      const data = await response.json()
      if (!response.ok || !data.success) throw new Error(data.error || 'No se pudieron cargar los dispositivos')
      const eligible = (data.devices || []).filter((device: ReportDevice) => (device.provider || 'whatsapp_web') === 'whatsapp_web' && device.status === 'connected')
      setDevices(eligible)
      setSelectedDeviceID(current => eligible.some((device: ReportDevice) => device.id === current) ? current : (eligible[0]?.id || ''))
    } catch (error) {
      setDevicesError(error instanceof Error ? error.message : 'No se pudieron cargar los dispositivos')
    } finally {
      setDevicesLoading(false)
    }
  }, [])

  useEffect(() => {
    loadDevices()
    return () => {
      groupRequestRef.current?.abort()
      reportRequestRef.current?.abort()
    }
  }, [loadDevices])

  const loadGroups = useCallback(async (deviceID: string) => {
    groupRequestRef.current?.abort()
    reportRequestRef.current?.abort()
    reportRequestRef.current = null
    setGenerating(false)
    setGroups([])
    setSelectedGroupID('')
    setReport(null)
    setGroupsError('')
    if (!deviceID) return
    const controller = new AbortController()
    groupRequestRef.current = controller
    setGroupsLoading(true)
    try {
      const response = await fetch(`/api/reports/whatsapp-group-coverage/groups?device_id=${encodeURIComponent(deviceID)}`, {
        headers: authHeaders(), credentials: 'include', signal: controller.signal,
      })
      const data = await response.json()
      if (!response.ok || !data.success) throw new Error(data.error || 'No se pudieron cargar los grupos')
      setGroups(data.groups || [])
    } catch (error) {
      if ((error as Error).name !== 'AbortError') setGroupsError(error instanceof Error ? error.message : 'No se pudieron cargar los grupos')
    } finally {
      if (groupRequestRef.current === controller) setGroupsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadGroups(selectedDeviceID)
  }, [selectedDeviceID, loadGroups])

  const generateReport = async () => {
    if (!selectedDeviceID || !selectedGroupID) return
    reportRequestRef.current?.abort()
    const controller = new AbortController()
    reportRequestRef.current = controller
    setGenerating(true)
    setGenerateError('')
    try {
      const response = await fetch('/api/reports/whatsapp-group-coverage/generate', {
        method: 'POST', headers: authHeaders(true), credentials: 'include', signal: controller.signal,
        body: JSON.stringify({ device_id: selectedDeviceID, group_id: selectedGroupID }),
      })
      const data = await response.json()
      if (!response.ok || !data.success) throw new Error(data.error || 'No se pudo generar el reporte')
      setReport(data.report)
      setSearch('')
      setStatusFilter('all')
      setPage(1)
    } catch (error) {
      if ((error as Error).name !== 'AbortError') setGenerateError(error instanceof Error ? error.message : 'No se pudo generar el reporte')
    } finally {
      if (reportRequestRef.current === controller) setGenerating(false)
    }
  }

  const selectGroup = (group: WhatsAppGroupOption) => {
    reportRequestRef.current?.abort()
    reportRequestRef.current = null
    setGenerating(false)
    setSelectedGroupID(group.id)
    setReport(null)
    setGenerateError('')
  }

  const filteredMembers = useMemo(() => {
    if (!report) return []
    const term = search.trim().toLocaleLowerCase('es')
    return report.members
      .filter(member => statusFilter === 'all' || member.coverage_status === statusFilter)
      .filter(member => {
        if (!term) return true
        const haystack = [
          member.whatsapp_name, member.phone, member.redacted_phone, member.contact?.display_name,
          ...(member.contact?.tags || []).map(tag => tag.name),
        ].filter(Boolean).join(' ').toLocaleLowerCase('es')
        return haystack.includes(term)
      })
      .sort((a, b) => {
        if (a.is_self !== b.is_self) return a.is_self ? 1 : -1
        const priority = statusMeta[a.coverage_status].priority - statusMeta[b.coverage_status].priority
        return priority || a.whatsapp_name.localeCompare(b.whatsapp_name, 'es')
      })
  }, [report, search, statusFilter])

  useEffect(() => setPage(1), [search, statusFilter])
  const pageCount = Math.max(1, Math.ceil(filteredMembers.length / PAGE_SIZE))
  const visibleMembers = filteredMembers.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  return (
    <main className="h-full overflow-y-auto bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-[1500px]">
        <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <Link href="/dashboard/reports" className="mb-3 inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 transition hover:text-emerald-600"><ArrowLeft className="h-4 w-4" /> Centro de reportes</Link>
            <div className="flex items-start gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700"><UsersRound className="h-6 w-6" /></div>
              <div>
                <h1 className="text-2xl font-bold tracking-tight text-slate-900">Cobertura de integrantes de WhatsApp</h1>
                <p className="mt-1 text-sm text-slate-500">Identifica quién existe como contacto y quién tiene una oportunidad activa en Clarin.</p>
              </div>
            </div>
          </div>
          {report && (
            <div className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-right shadow-sm">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Última generación</p>
              <p className="mt-0.5 text-xs font-semibold text-slate-600">{formatDateTime(report.generated_at)}</p>
            </div>
          )}
        </header>

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="mb-5 flex items-center gap-2"><BarChart3 className="h-5 w-5 text-emerald-600" /><h2 className="font-bold text-slate-800">Parámetros del reporte</h2></div>
          <div className="grid gap-5 lg:grid-cols-[minmax(260px,0.7fr)_minmax(420px,1.3fr)_auto] lg:items-end">
            <div>
              <label className="mb-2 block text-xs font-bold uppercase tracking-wider text-slate-500">Dispositivo conectado</label>
              <div className="relative">
                <Smartphone className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" />
                <select
                  value={selectedDeviceID}
                  onChange={event => setSelectedDeviceID(event.target.value)}
                  disabled={devicesLoading}
                  className="h-[58px] w-full appearance-none rounded-xl border border-slate-200 bg-white pl-11 pr-4 text-sm font-semibold text-slate-700 shadow-sm outline-none transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-500/20 disabled:bg-slate-50"
                >
                  {devices.length === 0 && <option value="">Sin dispositivos disponibles</option>}
                  {devices.map(device => <option key={device.id} value={device.id}>{device.name || device.phone || 'Dispositivo WhatsApp'}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="mb-2 block text-xs font-bold uppercase tracking-wider text-slate-500">Grupo de WhatsApp</label>
              <WhatsAppGroupSelector
                groups={groups}
                value={selectedGroupID}
                loading={groupsLoading}
                disabled={!selectedDeviceID || Boolean(groupsError)}
                onChange={selectGroup}
              />
            </div>
            <button
              type="button"
              onClick={generateReport}
              disabled={!selectedDeviceID || !selectedGroupID || generating}
              className="inline-flex h-[58px] items-center justify-center gap-2 rounded-xl bg-emerald-600 px-6 text-sm font-bold text-white shadow-lg shadow-emerald-600/20 transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none"
            >
              {generating ? <Loader2 className="h-5 w-5 animate-spin" /> : <BarChart3 className="h-5 w-5" />}
              {generating ? 'Generando…' : report ? 'Regenerar' : 'Generar reporte'}
            </button>
          </div>

          {(devicesError || groupsError || generateError) && (
            <div className="mt-4 flex items-start justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
              <div className="flex items-start gap-2"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span>{devicesError || groupsError || generateError}</span></div>
              <button type="button" onClick={() => devicesError ? loadDevices() : groupsError ? loadGroups(selectedDeviceID) : generateReport()} className="inline-flex shrink-0 items-center gap-1 font-bold"><RefreshCw className="h-3.5 w-3.5" /> Reintentar</button>
            </div>
          )}
          {!devicesLoading && !devicesError && devices.length === 0 && (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">No hay dispositivos WhatsApp Web conectados. Conecta uno desde Dispositivos o solicita ayuda a un administrador.</div>
          )}
          {!groupsLoading && selectedDeviceID && !groupsError && groups.length === 0 && (
            <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">Este dispositivo no participa en ningún grupo disponible.</div>
          )}
        </section>

        {report && (
          <>
            <section className="mt-6">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-bold text-slate-900">{report.group.name}</h2>
                  <p className="mt-0.5 text-xs text-slate-500">{report.summary.total_group_members} integrantes en WhatsApp · {report.summary.evaluated_members} evaluados, excluyendo el dispositivo propio</p>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
                <MetricCard label="Cobertura CRM" value={report.summary.registration_coverage_percent == null ? '—' : `${report.summary.registration_coverage_percent}%`} detail={`${report.summary.registered_members} registrados`} tone="emerald" />
                <MetricCard label="Gestión activa" value={report.summary.active_management_members} detail={report.summary.management_coverage_percent == null ? 'Sin base verificable' : `${report.summary.management_coverage_percent}% de cobertura`} tone="emerald" />
                <MetricCard label="Con historial" value={report.summary.historical_only_members} detail="Sin oportunidad activa" tone="violet" />
                <MetricCard label="Solo contacto" value={report.summary.contact_only_members} detail="Sin oportunidad" />
                <MetricCard label="No registrados" value={report.summary.not_registered_members} detail="Fuera de Clarin" tone="rose" />
                <MetricCard label="Por revisar" value={report.summary.unidentifiable_members + report.summary.ambiguous_members} detail={`${report.summary.unidentifiable_members} ocultos · ${report.summary.ambiguous_members} duplicados`} tone="amber" />
              </div>
              {report.summary.do_not_contact_members > 0 && (
                <div className="mt-3 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"><ShieldAlert className="h-4 w-4" /><strong>{report.summary.do_not_contact_members}</strong> integrantes tienen activa la restricción “No contactar”.</div>
              )}
            </section>

            <section className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="flex flex-col gap-3 border-b border-slate-200 p-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex flex-1 flex-col gap-3 sm:flex-row">
                  <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 lg:max-w-sm">
                    <Search className="h-4 w-4 text-slate-400" />
                    <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Buscar nombre, teléfono o etiqueta…" className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-slate-400" />
                  </div>
                  <select value={statusFilter} onChange={event => setStatusFilter(event.target.value as 'all' | CoverageStatus)} className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-600 outline-none focus:border-emerald-400">
                    <option value="all">Todos los estados</option>
                    {Object.entries(statusMeta).map(([key, meta]) => <option key={key} value={key}>{meta.label}</option>)}
                  </select>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => exportWhatsAppGroupReportCSV(report)} className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold text-slate-600 transition hover:border-emerald-300 hover:text-emerald-700"><Download className="h-4 w-4" /> CSV</button>
                  <button type="button" onClick={() => exportWhatsAppGroupReportExcel(report)} className="inline-flex h-10 items-center gap-2 rounded-xl bg-slate-800 px-3 text-xs font-bold text-white transition hover:bg-slate-900"><FileSpreadsheet className="h-4 w-4" /> Excel</button>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="min-w-[1320px] w-full border-collapse text-left">
                  <thead className="sticky top-0 z-10 bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="px-4 py-3">Integrante de WhatsApp</th>
                      <th className="px-4 py-3">Teléfono</th>
                      <th className="px-4 py-3">¿Existe en Clarin?</th>
                      <th className="px-4 py-3">Estado de gestión</th>
                      <th className="px-4 py-3">Contacto en Clarin</th>
                      <th className="px-4 py-3">Etiquetas</th>
                      <th className="px-4 py-3">Oportunidades activas</th>
                      <th className="px-4 py-3">Última actividad directa</th>
                      <th className="px-4 py-3">Restricción</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {visibleMembers.map((member, index) => {
                      const activeLead = member.contact?.active_leads[0]
                      return (
                        <tr key={`${member.phone || member.redacted_phone || member.whatsapp_name}-${index}`} className="align-top transition hover:bg-slate-50/80">
                          <td className="px-4 py-3">
                            <div className="flex items-start gap-2.5">
                              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500"><UsersRound className="h-4 w-4" /></div>
                              <div className="min-w-0">
                                <p className="max-w-[220px] truncate text-sm font-semibold text-slate-800" title={member.whatsapp_name}>{member.whatsapp_name}</p>
                                <p className="mt-0.5 text-[11px] text-slate-400">{member.is_self ? 'Este dispositivo' : roleLabels[member.role]}</p>
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-sm font-medium text-slate-600">{displayPhone(member)}</td>
                          <td className="px-4 py-3">
                            {member.coverage_status === 'ambiguous' ? (
                              <span className="inline-flex items-center gap-1 text-xs font-bold text-amber-700"><AlertCircle className="h-3.5 w-3.5" /> Sí, {member.matched_contact_count} coincidencias</span>
                            ) : member.exists_in_clarin === null ? (
                              <span className="text-xs font-semibold text-orange-600">No verificable</span>
                            ) : member.exists_in_clarin ? (
                              <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" /> Sí</span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-xs font-bold text-rose-700"><UserRoundX className="h-3.5 w-3.5" /> No</span>
                            )}
                          </td>
                          <td className="px-4 py-3"><span className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-bold ${statusMeta[member.coverage_status].className}`}>{statusMeta[member.coverage_status].label}</span></td>
                          <td className="px-4 py-3">
                            {member.contact ? (
                              <Link href={`/dashboard/contacts?contact_id=${member.contact.id}`} className="group inline-flex max-w-[220px] items-center gap-2 text-sm font-semibold text-slate-700 hover:text-emerald-700">
                                <UserCheck className="h-4 w-4 shrink-0 text-emerald-500" /><span className="truncate">{member.contact.display_name}</span>
                              </Link>
                            ) : <span className="text-xs text-slate-400">—</span>}
                          </td>
                          <td className="px-4 py-3">
                            {(member.contact?.tags || []).length > 0 ? (
                              <div className="flex max-w-[220px] flex-wrap gap-1">
                                {member.contact!.tags.slice(0, 3).map(tag => <span key={tag.id} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ backgroundColor: `${tag.color || '#64748b'}18`, color: tag.color || '#475569' }}><Tags className="h-2.5 w-2.5" />{tag.name}</span>)}
                                {member.contact!.tags.length > 3 && <span className="text-[10px] font-semibold text-slate-400">+{member.contact!.tags.length - 3}</span>}
                              </div>
                            ) : <span className="text-xs text-slate-400">Sin etiquetas</span>}
                          </td>
                          <td className="px-4 py-3">
                            {activeLead ? (
                              <div className="max-w-[240px]">
                                <p className="truncate text-xs font-bold text-slate-700">{[activeLead.pipeline_name, activeLead.stage_name].filter(Boolean).join(' · ') || activeLead.title}</p>
                                <p className="mt-0.5 truncate text-[11px] text-slate-400">{activeLead.assigned_to_name || 'Sin responsable'}{member.contact!.active_leads.length > 1 ? ` · +${member.contact!.active_leads.length - 1} más` : ''}</p>
                              </div>
                            ) : <span className="text-xs text-slate-400">Sin oportunidad activa</span>}
                          </td>
                          <td className="px-4 py-3 text-xs text-slate-500">{formatDateTime(member.contact?.last_direct_activity_at)}</td>
                          <td className="px-4 py-3">{member.contact?.do_not_contact ? <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-1 text-[10px] font-bold text-amber-700"><ShieldAlert className="h-3 w-3" /> No contactar</span> : <span className="text-xs text-slate-400">—</span>}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                {visibleMembers.length === 0 && <div className="py-14 text-center text-sm text-slate-400">No hay integrantes que coincidan con los filtros.</div>}
              </div>

              <div className="flex flex-col gap-3 border-t border-slate-200 px-4 py-3 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
                <span>Mostrando {visibleMembers.length} de {filteredMembers.length} integrantes</span>
                <div className="flex items-center gap-2">
                  <button type="button" disabled={page <= 1} onClick={() => setPage(current => current - 1)} className="rounded-lg border border-slate-200 p-2 text-slate-500 disabled:opacity-40"><ChevronLeft className="h-4 w-4" /></button>
                  <span className="min-w-20 text-center font-semibold text-slate-600">Página {page} de {pageCount}</span>
                  <button type="button" disabled={page >= pageCount} onClick={() => setPage(current => current + 1)} className="rounded-lg border border-slate-200 p-2 text-slate-500 disabled:opacity-40"><ChevronRight className="h-4 w-4" /></button>
                </div>
              </div>
            </section>

            <p className="mt-4 text-xs leading-5 text-slate-400">“Existe en Clarin” se calcula por identidad telefónica dentro de la cuenta. “Gestión activa” requiere al menos una oportunidad abierta. Los números ocultos y las coincidencias duplicadas se excluyen de los porcentajes para evitar conclusiones incorrectas.</p>
          </>
        )}
      </div>
    </main>
  )
}
