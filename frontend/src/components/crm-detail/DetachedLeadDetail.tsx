'use client'

import { cloneElement, isValidElement, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import {
  AlertCircle,
  BriefcaseBusiness,
  Building2,
  CalendarDays,
  CloudOff,
  Edit3,
  FileText,
  ListTodo,
  Mail,
  MapPin,
  MessageCircle,
  MessageSquarePlus,
  Phone,
  Save,
  Tag,
  UserRound,
  X,
} from 'lucide-react'
import type { Lead } from '@/types/contact'
import OperationalDatePicker from '@/components/operational-date/OperationalDatePicker'
import CrmDetailAccordion, { defaultCrmDetailAccordionState, type CrmDetailSectionKey } from './CrmDetailAccordion'

export type DetachedLeadPatch = {
  name: string
  last_name: string
  short_name: string
  phone: string
  email: string
  company: string
  age?: number
  dni: string
  birth_date: string
  address: string
  distrito: string
  ocupacion: string
}

type SaveResult = { success: boolean; error?: string }
type Props = {
  lead: Lead
  context: ReactNode
  activity: ReactNode
  tasks: ReactNode
  onSave: (patch: DetachedLeadPatch) => Promise<SaveResult>
  onMessage?: (phone: string) => void
}

type FormState = Record<Exclude<keyof DetachedLeadPatch, 'age'>, string> & { age: string }
type EmbeddablePanelProps = { embedded?: boolean; onCountChange?: (count: number) => void }

const fields: Array<{ key: keyof FormState; label: string; type?: string; placeholder?: string }> = [
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

function formFromLead(lead: Lead): FormState {
  return {
    name: lead.name || '',
    last_name: lead.last_name || '',
    short_name: lead.short_name || '',
    phone: lead.phone || '',
    email: lead.email || '',
    company: lead.company || '',
    age: lead.age ? String(lead.age) : '',
    dni: lead.dni || '',
    birth_date: lead.birth_date ? lead.birth_date.split('T')[0] : '',
    address: lead.address || '',
    distrito: lead.distrito || '',
    ocupacion: lead.ocupacion || '',
  }
}

function displayName(lead: Lead) {
  return [lead.name, lead.last_name].filter(Boolean).join(' ').trim() || lead.phone || 'Lead sin nombre'
}

function Datum({ icon: Icon, label, value }: { icon: typeof Phone; label: string; value?: string | number | null }) {
  return <div className="flex min-w-0 items-start gap-3 rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-2.5"><Icon className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" /><div className="min-w-0"><p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{label}</p><p className="mt-0.5 break-words text-sm font-semibold text-slate-700">{value || 'Sin registrar'}</p></div></div>
}

function embedPanel(node: ReactNode, onCountChange: (count: number) => void) {
  if (!isValidElement<EmbeddablePanelProps>(node)) return node
  const element = node as ReactElement<EmbeddablePanelProps>
  const original = element.props.onCountChange
  return cloneElement(element, { embedded: true, onCountChange: (count: number) => { onCountChange(count); original?.(count) } })
}

export default function DetachedLeadDetail({ lead, context, activity, tasks, onSave, onMessage }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [accordionOpen, setAccordionOpen] = useState(defaultCrmDetailAccordionState)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState<FormState>(() => formFromLead(lead))
  const [activityCount, setActivityCount] = useState(0)
  const [taskCount, setTaskCount] = useState(0)

  useEffect(() => {
    setAccordionOpen(defaultCrmDetailAccordionState())
    setEditing(false)
    setSaving(false)
    setError('')
    setForm(formFromLead(lead))
    setActivityCount(0)
    setTaskCount(0)
  }, [lead.id])

  const embeddedActivity = useMemo(() => embedPanel(activity, setActivityCount), [activity])
  const embeddedTasks = useMemo(() => embedPanel(tasks, setTaskCount), [tasks])
  const initials = useMemo(() => displayName(lead).split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase()).join(''), [lead])
  const toggle = (key: CrmDetailSectionKey) => setAccordionOpen(current => ({ ...current, [key]: !current[key] }))
  const change = (key: keyof FormState, value: string) => { setForm(current => ({ ...current, [key]: value })); setError('') }
  const cancel = () => { setForm(formFromLead(lead)); setEditing(false); setError('') }

  const save = async () => {
    if (!form.name.trim() || saving) return
    setSaving(true)
    setError('')
    const parsedAge = Number.parseInt(form.age, 10)
    const result = await onSave({
      ...form,
      name: form.name.trim(),
      age: form.age && Number.isFinite(parsedAge) ? parsedAge : undefined,
    })
    setSaving(false)
    if (!result.success) return setError(result.error || 'No se pudieron guardar los datos históricos del Lead.')
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

  return (
    <div ref={rootRef} className="h-full overflow-y-auto overscroll-contain bg-slate-50/70">
      <section className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 px-3 py-3 shadow-[0_4px_16px_rgba(15,23,42,0.04)] backdrop-blur sm:px-4">
        <div className="flex items-center gap-3"><div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-emerald-100 text-sm font-black text-emerald-700">{initials || <UserRound className="h-5 w-5" />}</div><div className="min-w-0 flex-1"><div className="flex min-w-0 items-center gap-2"><h2 className="truncate text-base font-extrabold text-slate-900">{displayName(lead)}</h2><span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[9px] font-bold text-amber-700">Histórico</span></div><p className="truncate text-xs text-slate-500">{lead.phone || 'Sin teléfono registrado'}</p></div></div>
        <div className="mt-3 grid grid-cols-3 gap-2"><button type="button" onClick={openObservation} className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-amber-200 bg-amber-50 px-2 text-xs font-bold text-amber-800"><MessageSquarePlus className="h-4 w-4" />Observación</button><button data-crm-message-action type="button" onClick={() => lead.phone && onMessage?.(lead.phone)} disabled={!lead.phone || !onMessage} className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-2 text-xs font-bold text-white disabled:opacity-45"><MessageCircle className="h-4 w-4" />Mensaje</button><button type="button" onClick={() => { setAccordionOpen(current => ({ ...current, contact: true })); setEditing(true) }} className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white px-2 text-xs font-bold text-slate-700"><Edit3 className="h-4 w-4" />Editar</button></div>
      </section>

      <div className="space-y-3 p-3 sm:p-4">
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-800"><span className="font-bold">Sin Contact canónico.</span> Este Lead histórico conserva datos personales propios; sus etiquetas no se mezclarán con las de un Contact.</div>

        <CrmDetailAccordion id="detached-lead-contact" title="Información del contacto" summary="Datos históricos guardados en este Lead" icon={UserRound} tone="emerald" open={accordionOpen.contact} onToggle={() => toggle('contact')}>
          {editing ? <div><div className="grid gap-3 sm:grid-cols-2">{fields.map((field, index) => <div key={field.key} className="block"><span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-slate-400">{field.label}</span>{field.type === 'date' ? <OperationalDatePicker mode="date" label={field.label} value={form[field.key]} onChange={value => change(field.key, value)} /> : <input aria-label={field.label} autoFocus={index === 0} type={field.type || 'text'} value={form[field.key]} onChange={event => change(field.key, event.target.value)} placeholder={field.placeholder} className="h-11 w-full rounded-xl border border-slate-200 px-3 text-sm outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100" />}</div>)}</div>{error && <p role="alert" className="mt-3 flex items-center gap-2 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700"><AlertCircle className="h-4 w-4" />{error}</p>}<div className="mt-3 flex justify-end gap-2"><button type="button" onClick={cancel} disabled={saving} className="inline-flex min-h-11 items-center gap-1.5 px-3 text-sm font-bold text-slate-600"><X className="h-4 w-4" />Cancelar</button><button type="button" onClick={() => void save()} disabled={saving || !form.name.trim()} className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-emerald-600 px-4 text-sm font-bold text-white disabled:opacity-45"><Save className="h-4 w-4" />{saving ? 'Guardando…' : 'Guardar'}</button></div></div> : <div className="grid gap-2 sm:grid-cols-2"><Datum icon={Phone} label="Teléfono" value={lead.phone} /><Datum icon={Mail} label="Correo" value={lead.email} /><Datum icon={Building2} label="Organización" value={lead.company} /><Datum icon={BriefcaseBusiness} label="Ocupación" value={lead.ocupacion} /><Datum icon={MapPin} label="Ubicación" value={[lead.address, lead.distrito].filter(Boolean).join(', ')} /><Datum icon={CalendarDays} label="Nacimiento / edad" value={[lead.birth_date?.split('T')[0], lead.age ? `${lead.age} años` : ''].filter(Boolean).join(' · ')} /></div>}
        </CrmDetailAccordion>

        <CrmDetailAccordion id="detached-lead-tags" title="Etiquetas" summary={`${lead.structured_tags?.length || 0} asignada${lead.structured_tags?.length === 1 ? '' : 's'} · registro histórico`} icon={Tag} tone="cyan" open={accordionOpen.tags} onToggle={() => toggle('tags')}>{lead.structured_tags?.length ? <div className="flex flex-wrap gap-2">{lead.structured_tags.map(tag => <span key={tag.id} className="rounded-full px-3 py-1.5 text-xs font-bold text-white" style={{ backgroundColor: tag.color || '#64748b' }}>{tag.name}</span>)}</div> : <p className="text-xs italic text-slate-400">Sin etiquetas asociadas.</p>}</CrmDetailAccordion>

        <CrmDetailAccordion id="detached-lead-activity" title="Observaciones de esta oportunidad" summary={`${activityCount} registro${activityCount === 1 ? '' : 's'} · alcance exclusivo`} icon={MessageSquarePlus} tone="amber" open={accordionOpen.activity} onToggle={() => toggle('activity')}>{embeddedActivity}</CrmDetailAccordion>
        <CrmDetailAccordion id="detached-lead-context" title="Contexto de la oportunidad" summary={`${lead.pipeline_name || lead.lead_pipeline_name || 'Pipeline'} · ${lead.stage_name || lead.lead_stage_name || 'Sin etapa'}`} icon={BriefcaseBusiness} tone="violet" open={accordionOpen.context} onToggle={() => toggle('context')} contentClassName="p-0"><div className="p-1">{context}</div></CrmDetailAccordion>
        <CrmDetailAccordion id="detached-lead-tasks" title="Tareas relacionadas" summary={`${taskCount} abierta${taskCount === 1 ? '' : 's'} en Clarin Work`} icon={ListTodo} tone="blue" open={accordionOpen.tasks} onToggle={() => toggle('tasks')}>{embeddedTasks}</CrmDetailAccordion>
        <CrmDetailAccordion id="detached-lead-history" title="Historial general del contacto" summary="No disponible sin Contact canónico" icon={FileText} tone="slate" open={accordionOpen.history} onToggle={() => toggle('history')}><p className="rounded-xl border border-dashed border-slate-200 px-3 py-5 text-center text-xs text-slate-400">Este registro no tiene un historial transversal de Contact.</p></CrmDetailAccordion>
        <CrmDetailAccordion id="detached-lead-integrations" title="Integraciones" summary="No disponibles para un registro sin Contact" icon={CloudOff} tone="sky" open={accordionOpen.integrations} onToggle={() => toggle('integrations')}><p className="rounded-xl border border-dashed border-sky-200 bg-sky-50/30 px-3 py-5 text-center text-xs text-slate-500">Vincula un Contact canónico antes de usar integraciones personales.</p></CrmDetailAccordion>
      </div>
    </div>
  )
}
