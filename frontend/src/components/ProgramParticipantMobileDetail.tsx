'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Briefcase, Building2, Cake, CreditCard, FileText, Loader2, Mail, MapPin, MessageCircle, NotebookPen, Phone, Plus, RefreshCw, Tags, UserRound } from 'lucide-react'
import ContactPhotoPreview from '@/components/ContactPhotoPreview'
import ObservationHistoryModal, { type HistoryObservation } from '@/components/ObservationHistoryModal'
import type { Contact } from '@/types/contact'

interface ProgramParticipantMobileDetailProps {
  contact: Contact
  participantId: string
  participantStatus: 'active' | 'dropped' | 'completed'
  programId: string
  onClose: () => void
  onObservationChange?: () => void
  onSendMessage?: (phone: string) => void | Promise<void>
  sendingMessage?: boolean
}

const statusLabel = (status: ProgramParticipantMobileDetailProps['participantStatus']) => status === 'active'
  ? 'Activo'
  : status === 'completed'
    ? 'Completado'
    : 'Retirado'

const statusClass = (status: ProgramParticipantMobileDetailProps['participantStatus']) => status === 'active'
  ? 'bg-emerald-50 text-emerald-700'
  : status === 'completed'
    ? 'bg-blue-50 text-blue-700'
    : 'bg-red-50 text-red-700'

const observationTypeLabel = (type: string) => type === 'note'
  ? 'Nota'
  : type === 'call'
    ? 'Llamada'
    : type === 'attendance'
      ? 'Asistencia'
      : type

export default function ProgramParticipantMobileDetail({
  contact,
  participantId,
  participantStatus,
  programId,
  onClose,
  onObservationChange,
  onSendMessage,
  sendingMessage = false,
}: ProgramParticipantMobileDetailProps) {
  const [observations, setObservations] = useState<HistoryObservation[]>([])
  const [historyLoading, setHistoryLoading] = useState(true)
  const [historyError, setHistoryError] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [composerInitiallyOpen, setComposerInitiallyOpen] = useState(false)
  const historyRequestRef = useRef<AbortController | null>(null)
  const historySequenceRef = useRef(0)

  const displayName = contact.custom_name || contact.name || contact.push_name || 'Sin nombre'
  const displayTags = useMemo(() => (contact.structured_tags || []).length > 0
    ? (contact.structured_tags || []).map(tag => ({ id: tag.id, name: tag.name, color: tag.color || '#64748b' }))
    : (contact.tags || []).map((tag, index) => ({ id: `${tag}-${index}`, name: tag, color: '#64748b' })), [contact.structured_tags, contact.tags])

  const loadHistory = useCallback(async () => {
    historyRequestRef.current?.abort()
    const controller = new AbortController()
    const requestId = ++historySequenceRef.current
    historyRequestRef.current = controller
    setHistoryLoading(true)
    setHistoryError('')
    try {
      const token = localStorage.getItem('token') || ''
      const response = await fetch(`/api/contacts/${contact.id}/interactions?limit=200`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.success) throw new Error(data.error || 'No se pudo cargar el historial.')
      if (controller.signal.aborted || requestId !== historySequenceRef.current) return
      setObservations(Array.isArray(data.interactions) ? data.interactions : [])
    } catch (error) {
      if (controller.signal.aborted || requestId !== historySequenceRef.current) return
      setObservations([])
      setHistoryError(error instanceof Error ? error.message : 'No se pudo cargar el historial.')
    } finally {
      if (!controller.signal.aborted && requestId === historySequenceRef.current) setHistoryLoading(false)
    }
  }, [contact.id])

  useEffect(() => {
    void loadHistory()
    return () => historyRequestRef.current?.abort()
  }, [loadHistory])

  const details = useMemo(() => [
    { label: 'Teléfono', value: contact.phone, icon: Phone },
    { label: 'Correo', value: contact.email, icon: Mail },
    { label: 'Empresa', value: contact.company, icon: Building2 },
    { label: 'DNI', value: contact.dni, icon: CreditCard },
    { label: 'Edad', value: contact.age ? `${contact.age} años` : '', icon: UserRound },
    { label: 'Nacimiento', value: contact.birth_date ? new Date(`${contact.birth_date.split('T')[0]}T12:00:00`).toLocaleDateString('es-PE') : '', icon: Cake },
    { label: 'Ocupación', value: contact.ocupacion, icon: Briefcase },
    { label: 'Dirección', value: [contact.address, contact.distrito].filter(Boolean).join(' · '), icon: MapPin },
  ].filter(item => Boolean(item.value)), [contact])

  const openHistory = (composer: boolean) => {
    setComposerInitiallyOpen(composer)
    setHistoryOpen(true)
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-white">
      <div className="flex min-h-16 shrink-0 items-center gap-3 border-b border-slate-200 px-3">
        <button type="button" onClick={onClose} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label="Volver a participantes"><ArrowLeft className="h-5 w-5" /></button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-bold text-slate-900">Detalle del participante</h2>
          <p className="truncate text-xs text-slate-500">Información de consulta</p>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-5">
        <div className="flex items-center gap-3">
          <ContactPhotoPreview url={contact.avatar_url} name={displayName} sizeClassName="h-14 w-14" />
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-base font-bold text-slate-900">{displayName}</h3>
            <p className="truncate text-xs text-slate-500">{contact.phone || 'Sin teléfono registrado'}</p>
            <span className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${statusClass(participantStatus)}`}>{statusLabel(participantStatus)}</span>
          </div>
          {contact.phone && onSendMessage && (
            <button
              type="button"
              onClick={() => void onSendMessage(contact.phone || '')}
              disabled={sendingMessage}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-sm transition hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
              aria-label={`Enviar mensaje a ${displayName}`}
              title="Enviar mensaje"
            >
              {sendingMessage ? <Loader2 className="h-5 w-5 animate-spin" /> : <MessageCircle className="h-5 w-5" />}
            </button>
          )}
        </div>

        {details.length > 0 && <section className="mt-5 rounded-2xl border border-slate-200 bg-white">
          <h4 className="border-b border-slate-100 px-4 py-3 text-xs font-bold uppercase tracking-wide text-slate-400">Datos de contacto</h4>
          <div className="divide-y divide-slate-100 px-4">
            {details.map(({ label, value, icon: Icon }) => <div key={label} className="flex min-h-12 items-center gap-3 py-2.5"><Icon className="h-4 w-4 shrink-0 text-emerald-600" /><div className="min-w-0"><p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p><p className="break-words text-sm text-slate-700">{value}</p></div></div>)}
          </div>
        </section>}

        <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-4">
          <h4 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-400"><Tags className="h-4 w-4" /> Etiquetas</h4>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {displayTags.length > 0
              ? displayTags.map(tag => <span key={tag.id} className="rounded-full px-2 py-1 text-xs font-medium text-white" style={{ backgroundColor: tag.color }}>{tag.name}</span>)
              : <span className="text-sm italic text-slate-400">Sin etiquetas</span>}
          </div>
        </section>

        {contact.notes && <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-4">
          <h4 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-400"><FileText className="h-4 w-4" /> Notas del contacto</h4>
          <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-700">{contact.notes}</p>
        </section>}

        <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between gap-3">
            <h4 className="flex min-w-0 items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-400"><NotebookPen className="h-4 w-4 shrink-0" /> Observaciones</h4>
            {!historyLoading && !historyError && <span className="shrink-0 text-[11px] font-semibold text-slate-400">{observations.length}</span>}
          </div>

          {historyLoading ? <div className="mt-3 space-y-2" aria-label="Cargando observaciones"><div className="h-14 animate-pulse rounded-xl bg-slate-100" /><div className="h-14 animate-pulse rounded-xl bg-slate-100" /></div>
          : historyError ? <div className="mt-3 rounded-xl border border-red-100 bg-red-50 p-3"><p className="text-sm text-red-700">{historyError}</p><button type="button" onClick={() => void loadHistory()} className="mt-2 inline-flex min-h-10 items-center gap-2 rounded-lg px-3 text-xs font-semibold text-red-700 hover:bg-red-100"><RefreshCw className="h-3.5 w-3.5" /> Reintentar</button></div>
          : observations.length === 0 ? <p className="mt-3 rounded-xl bg-slate-50 px-3 py-4 text-center text-sm text-slate-400">Sin observaciones todavía.</p>
          : <div className="mt-3 space-y-2">{observations.slice(0, 3).map(observation => <div key={observation.id} className="rounded-xl bg-slate-50 px-3 py-2.5"><div className="flex items-center justify-between gap-2"><span className="text-[10px] font-bold uppercase tracking-wide text-emerald-700">{observationTypeLabel(observation.type)}</span><span className="text-[10px] text-slate-400">{new Date(observation.created_at).toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' })}</span></div><p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-700">{observation.notes || '(sin contenido)'}</p></div>)}</div>}

          <div className="mt-3 grid grid-cols-2 gap-2">
            <button type="button" onClick={() => openHistory(false)} className="min-h-11 rounded-xl border border-slate-200 px-3 text-sm font-semibold text-slate-600 hover:bg-slate-50">Ver historial</button>
            <button type="button" onClick={() => openHistory(true)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-3 text-sm font-semibold text-white hover:bg-emerald-700"><Plus className="h-4 w-4" /> Nueva</button>
          </div>
        </section>
      </div>

      <ObservationHistoryModal
        isOpen={historyOpen}
        onClose={() => { setHistoryOpen(false); setComposerInitiallyOpen(false) }}
        contactId={contact.id}
        programId={programId}
        programParticipantId={participantId}
        defaultNewType="note"
        name={displayName}
        observations={observations}
        loading={historyLoading}
        errorMessage={historyError}
        onRetry={() => void loadHistory()}
        onObservationChange={() => { void loadHistory(); onObservationChange?.() }}
        mutationMode="append-only"
        allowedNewTypes={['note']}
        initialComposerOpen={composerInitiallyOpen}
      />
    </div>
  )
}
