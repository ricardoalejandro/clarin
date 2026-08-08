'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AlertCircle,
  BriefcaseBusiness,
  Building2,
  CalendarDays,
  ClipboardList,
  CloudOff,
  Edit3,
  FileText,
  Mail,
  MapPin,
  MessageCircle,
  MessageSquarePlus,
  Phone,
  Save,
  Tag,
  Trash2,
  UserRound,
  X,
} from 'lucide-react'
import OperationalDatePicker from '@/components/operational-date/OperationalDatePicker'
import CrmDetailAccordion, { defaultCrmDetailAccordionState, type CrmDetailSectionKey } from './CrmDetailAccordion'

export type DetachedEventParticipant = {
  id: string
  name: string
  last_name?: string
  short_name?: string
  phone?: string
  email?: string
  age?: number
  dni?: string
  birth_date?: string
  company?: string
  address?: string
  distrito?: string
  ocupacion?: string
  notes?: string
  tags?: Array<{ id: string; name: string; color: string }>
}

export type DetachedParticipantPatch = {
  name: string
  last_name: string
  short_name: string
  phone: string
  email: string
  age: number
  dni: string
  birth_date: string
  company: string
  address: string
  distrito: string
  ocupacion: string
  notes: string
}

type SaveResult = { success: boolean; error?: string }
type Props = {
  participant: DetachedEventParticipant
  eventName: string
  context: ReactNode
  activity: ReactNode
  readOnly?: boolean
  onSave: (patch: DetachedParticipantPatch) => Promise<SaveResult>
  onMessage?: (phone: string) => void
  onRemove?: () => void
}

type FormState = Record<keyof DetachedParticipantPatch, string>

function formFromParticipant(participant: DetachedEventParticipant): FormState {
  return {
    name: participant.name || '',
    last_name: participant.last_name || '',
    short_name: participant.short_name || '',
    phone: participant.phone || '',
    email: participant.email || '',
    age: participant.age ? String(participant.age) : '',
    dni: participant.dni || '',
    birth_date: participant.birth_date ? participant.birth_date.split('T')[0] : '',
    company: participant.company || '',
    address: participant.address || '',
    distrito: participant.distrito || '',
    ocupacion: participant.ocupacion || '',
    notes: participant.notes || '',
  }
}

function displayName(participant: DetachedEventParticipant) {
  return [participant.name, participant.last_name].filter(Boolean).join(' ').trim() || participant.phone || 'Participante sin nombre'
}

const fieldDefinitions: Array<{ key: keyof FormState; label: string; type?: string; placeholder?: string }> = [
  { key: 'name', label: 'Nombre', placeholder: 'Nombre' },
  { key: 'last_name', label: 'Apellido', placeholder: 'Apellido' },
  { key: 'short_name', label: 'Nombre corto', placeholder: 'Cómo prefiere que lo llamen' },
  { key: 'phone', label: 'Teléfono', type: 'tel', placeholder: '+51…' },
  { key: 'email', label: 'Correo', type: 'email', placeholder: 'correo@ejemplo.com' },
  { key: 'age', label: 'Edad', type: 'number', placeholder: 'Edad' },
  { key: 'dni', label: 'Documento', placeholder: 'DNI' },
  { key: 'birth_date', label: 'Fecha de nacimiento', type: 'date' },
  { key: 'company', label: 'Organización', placeholder: 'Organización' },
  { key: 'ocupacion', label: 'Ocupación', placeholder: 'Ocupación' },
  { key: 'address', label: 'Dirección', placeholder: 'Dirección' },
  { key: 'distrito', label: 'Distrito', placeholder: 'Distrito' },
]

function Datum({ icon: Icon, label, value }: { icon: typeof Phone; label: string; value?: string | number }) {
  return (
    <div className="flex min-w-0 items-start gap-3 rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-2.5">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
      <div className="min-w-0"><p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{label}</p><p className="mt-0.5 break-words text-sm font-semibold text-slate-700">{value || 'Sin registrar'}</p></div>
    </div>
  )
}

export default function DetachedEventParticipantDetail({ participant, eventName, context, activity, readOnly = false, onSave, onMessage, onRemove }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState<FormState>(() => formFromParticipant(participant))
  const [accordionOpen, setAccordionOpen] = useState(defaultCrmDetailAccordionState)

  useEffect(() => {
    setForm(formFromParticipant(participant))
    setEditing(false)
    setSaving(false)
    setError('')
    setAccordionOpen(defaultCrmDetailAccordionState())
  }, [participant.id])

  const initials = useMemo(() => displayName(participant).split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase()).join(''), [participant])
  const change = (key: keyof FormState, value: string) => setForm(current => ({ ...current, [key]: value }))
  const cancelEdit = () => { setForm(formFromParticipant(participant)); setEditing(false); setError('') }

  const save = async () => {
    if (!form.name.trim() || saving || readOnly) return
    setSaving(true)
    setError('')
    const result = await onSave({
      ...form,
      name: form.name.trim(),
      age: form.age ? Number.parseInt(form.age, 10) || 0 : 0,
    })
    setSaving(false)
    if (!result.success) {
      setError(result.error || 'No se pudieron guardar los datos del participante.')
      return
    }
    setEditing(false)
  }

  const openObservation = () => {
    setAccordionOpen(current => ({ ...current, activity: true }))
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const control = rootRef.current?.querySelector<HTMLButtonElement>('[data-crm-activity-add]')
      control?.click()
      control?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }))
  }

  const toggleSection = (section: CrmDetailSectionKey) => setAccordionOpen(current => ({ ...current, [section]: !current[section] }))

  return (
    <div ref={rootRef} className="h-full overflow-y-auto overscroll-contain bg-slate-50/70">
      <section className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 px-3 py-3 shadow-[0_4px_16px_rgba(15,23,42,0.04)] backdrop-blur sm:px-4">
        <div className="flex items-center gap-3"><div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-violet-100 text-sm font-black text-violet-700">{initials || <UserRound className="h-5 w-5" />}</div><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h2 className="truncate text-base font-extrabold text-slate-900">{displayName(participant)}</h2><span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[9px] font-bold text-amber-700">Histórico</span></div><p className="truncate text-xs text-slate-500">{participant.phone || 'Sin teléfono registrado'}</p></div></div>
        <div className="mt-3 grid grid-cols-3 gap-2"><button type="button" onClick={openObservation} disabled={readOnly} className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-amber-200 bg-amber-50 px-2 text-xs font-bold text-amber-800 disabled:opacity-45"><MessageSquarePlus className="h-4 w-4" />Observación</button><button data-crm-message-action type="button" onClick={() => participant.phone && onMessage?.(participant.phone)} disabled={!participant.phone} className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-2 text-xs font-bold text-white disabled:opacity-45"><MessageCircle className="h-4 w-4" />Mensaje</button><button type="button" onClick={() => { setAccordionOpen(current => ({ ...current, contact: true })); setEditing(true) }} disabled={readOnly} className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white px-2 text-xs font-bold text-slate-700 disabled:opacity-45"><Edit3 className="h-4 w-4" />Editar</button></div>
      </section>

      <div className="space-y-3 p-3 sm:p-4">
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-800"><span className="font-bold">Sin contacto canónico</span>. Este registro histórico conserva sus datos y observaciones únicamente dentro de esta participación.</div>

        <CrmDetailAccordion id="detached-contact" title="Información del contacto" summary="Datos históricos de este registro" icon={UserRound} tone="emerald" open={accordionOpen.contact} onToggle={() => toggleSection('contact')}>
          {editing ? <div><div className="grid gap-3 sm:grid-cols-2">{fieldDefinitions.map(field => <div key={field.key} className="block"><span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-slate-400">{field.label}</span>{field.type === 'date' ? <OperationalDatePicker mode="date" label={field.label} value={form[field.key]} onChange={value => change(field.key, value)} /> : <input aria-label={field.label} type={field.type || 'text'} value={form[field.key]} onChange={event => change(field.key, event.target.value)} placeholder={field.placeholder} className="h-11 w-full rounded-xl border border-slate-200 px-3 text-sm outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100" />}</div>)}</div><label className="mt-3 block"><span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-slate-400">Nota histórica</span><textarea rows={3} value={form.notes} onChange={event => change('notes', event.target.value)} className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm" /></label>{error && <p role="alert" className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}<div className="mt-3 flex justify-end gap-2"><button type="button" onClick={cancelEdit} className="min-h-11 px-3 text-sm font-bold text-slate-600">Cancelar</button><button type="button" onClick={() => void save()} disabled={saving || !form.name.trim()} className="min-h-11 rounded-xl bg-emerald-600 px-4 text-sm font-bold text-white disabled:opacity-45">{saving ? 'Guardando…' : 'Guardar'}</button></div></div> : <div className="grid gap-2 sm:grid-cols-2"><Datum icon={Phone} label="Teléfono" value={participant.phone} /><Datum icon={Mail} label="Correo" value={participant.email} /><Datum icon={Building2} label="Organización" value={participant.company} /><Datum icon={BriefcaseBusiness} label="Ocupación" value={participant.ocupacion} /><Datum icon={MapPin} label="Ubicación" value={[participant.address, participant.distrito].filter(Boolean).join(', ')} /><Datum icon={CalendarDays} label="Nacimiento / edad" value={[participant.birth_date?.split('T')[0], participant.age ? `${participant.age} años` : ''].filter(Boolean).join(' · ')} />{participant.notes && <div className="rounded-xl border border-amber-100 bg-amber-50/60 px-3 py-2.5 sm:col-span-2"><p className="text-[10px] font-bold uppercase text-amber-700">Nota histórica</p><p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{participant.notes}</p></div>}</div>}
        </CrmDetailAccordion>

        <CrmDetailAccordion id="detached-tags" title="Etiquetas" summary={`${participant.tags?.length || 0} asignada${participant.tags?.length === 1 ? '' : 's'} · solo lectura`} icon={Tag} tone="cyan" open={accordionOpen.tags} onToggle={() => toggleSection('tags')}>{participant.tags?.length ? <div className="flex flex-wrap gap-2">{participant.tags.map(tag => <span key={tag.id} className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold text-white" style={{ backgroundColor: tag.color || '#64748b' }}>{tag.name}</span>)}</div> : <p className="text-xs italic text-slate-400">Sin etiquetas asociadas.</p>}</CrmDetailAccordion>

        <CrmDetailAccordion id="detached-activity" title="Observaciones de esta participación" summary="Alcance exclusivo del evento" icon={MessageSquarePlus} tone="amber" open={accordionOpen.activity} onToggle={() => toggleSection('activity')}>{activity}</CrmDetailAccordion>

        <CrmDetailAccordion id="detached-context" title="Contexto del evento" summary={`${eventName} · etapa y estado`} icon={CalendarDays} tone="violet" open={accordionOpen.context} onToggle={() => toggleSection('context')}>{context}</CrmDetailAccordion>

        <CrmDetailAccordion id="detached-tasks" title="Tareas relacionadas" summary="Requiere vincular un Contact canónico" icon={ClipboardList} tone="blue" open={accordionOpen.tasks} onToggle={() => toggleSection('tasks')}><div className="rounded-xl border border-dashed border-blue-200 bg-blue-50/40 px-4 py-5 text-center"><ClipboardList className="mx-auto h-5 w-5 text-blue-400" /><p className="mt-2 text-xs text-slate-500">Las tareas están deshabilitadas para evitar una asociación ambigua.</p><button type="button" disabled title="Disponible al vincular el participante con un Contact" className="mt-3 min-h-10 rounded-xl border border-slate-200 bg-white px-4 text-xs font-bold text-slate-400">Nueva tarea</button></div></CrmDetailAccordion>

        <CrmDetailAccordion id="detached-history" title="Historial general del contacto" summary="No disponible sin Contact canónico" icon={FileText} tone="slate" open={accordionOpen.history} onToggle={() => toggleSection('history')}><p className="rounded-xl border border-dashed border-slate-200 px-3 py-5 text-center text-xs text-slate-400">Este registro no tiene un historial transversal de Contact.</p></CrmDetailAccordion>

        <CrmDetailAccordion id="detached-integrations" title="Integraciones" summary="No disponibles sin Contact canónico" icon={CloudOff} tone="sky" open={accordionOpen.integrations} onToggle={() => toggleSection('integrations')}><p className="rounded-xl border border-dashed border-sky-200 bg-sky-50/30 px-3 py-5 text-center text-xs text-slate-500">Vincula un Contact canónico antes de usar integraciones personales.</p></CrmDetailAccordion>

        {!readOnly && onRemove && <button type="button" onClick={onRemove} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-red-200 bg-white px-4 text-sm font-bold text-red-600 hover:bg-red-50"><Trash2 className="h-4 w-4" />Retirar del evento</button>}
      </div>
    </div>
  )
}
