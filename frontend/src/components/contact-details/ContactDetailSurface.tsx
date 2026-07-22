'use client'

import type { ComponentType, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  Briefcase,
  Building2,
  Cake,
  ChevronDown,
  ChevronUp,
  CircleUserRound,
  Cloud,
  CloudOff,
  Clock3,
  CreditCard,
  Edit2,
  FileText,
  Loader2,
  Mail,
  Map,
  MapPin,
  MessageCircle,
  Phone,
  Plus,
  RefreshCw,
  Save,
  SlidersHorizontal,
  Smartphone,
  Tag,
  Trash2,
  User,
  X,
} from 'lucide-react'
import ContactAvatarControl from '@/components/ContactAvatarControl'
import ContactTagEditor from './ContactTagEditor'
import type { Observation } from '@/types/contact'
import type {
  ContactProfileContact,
  ContactProfileContext,
  ContactProfileAvailableTag,
  ContactProfileCustomFieldPatch,
  ContactProfileEditableField,
  ContactProfileExtraPhonePatch,
  ContactProfilePatch,
} from '@/types/contact-profile'
import { useContactProfile } from './useContactProfile'
import { useGoogleContactSync } from './useGoogleContactSync'

interface ContactDetailSurfaceProps {
  contactId: string
  context: ContactProfileContext
  initialContact?: Partial<ContactProfileContact> | null
  title?: string
  subtitle?: string
  onClose: () => void
  onContactChange?: (contact: ContactProfileContact) => void
  onObservationChange?: () => void
  onSendMessage?: (phone: string) => void
  sendingMessage?: boolean
  onDeleteContact?: (contact: ContactProfileContact) => void
  /** Context-specific content follows the shared contact history in every module. */
  contextContent?: ReactNode
  hideHeader?: boolean
  parentOwnsScroll?: boolean
  readOnly?: boolean
  className?: string
}

interface ProfileField {
  key: Exclude<ContactProfileEditableField, 'name' | 'custom_name' | 'notes'>
  label: string
  placeholder: string
  icon: ComponentType<{ className?: string }>
  inputType?: 'text' | 'email' | 'tel' | 'number' | 'date'
  format?: (value: string | number) => string
}

const profileFields: ProfileField[] = [
  { key: 'phone', label: 'Teléfono principal', placeholder: 'Agregar teléfono', icon: Phone, inputType: 'tel' },
  { key: 'email', label: 'Correo', placeholder: 'Agregar correo', icon: Mail, inputType: 'email' },
  { key: 'last_name', label: 'Apellidos', placeholder: 'Agregar apellidos', icon: User },
  { key: 'short_name', label: 'Nombre corto', placeholder: 'Agregar nombre corto', icon: CircleUserRound },
  { key: 'dni', label: 'DNI', placeholder: 'Agregar DNI', icon: CreditCard },
  { key: 'birth_date', label: 'Fecha de nacimiento', placeholder: 'Agregar fecha de nacimiento', icon: Cake, inputType: 'date', format: value => formatDate(String(value)) },
  { key: 'age', label: 'Edad', placeholder: 'Agregar edad', icon: Clock3, inputType: 'number', format: value => `${value} años` },
  { key: 'company', label: 'Organización', placeholder: 'Agregar organización', icon: Building2 },
  { key: 'ocupacion', label: 'Ocupación', placeholder: 'Agregar ocupación', icon: Briefcase },
  { key: 'address', label: 'Dirección', placeholder: 'Agregar dirección', icon: MapPin },
  { key: 'distrito', label: 'Distrito', placeholder: 'Agregar distrito', icon: Map },
]

type ContactEditDraft = Record<ContactProfileEditableField, string>

function contactEditDraft(contact: ContactProfileContact): ContactEditDraft {
  return {
    name: fieldDraft(contact, 'name'),
    custom_name: fieldDraft(contact, 'custom_name'),
    last_name: fieldDraft(contact, 'last_name'),
    short_name: fieldDraft(contact, 'short_name'),
    phone: fieldDraft(contact, 'phone'),
    email: fieldDraft(contact, 'email'),
    company: fieldDraft(contact, 'company'),
    age: fieldDraft(contact, 'age'),
    dni: fieldDraft(contact, 'dni'),
    birth_date: fieldDraft(contact, 'birth_date'),
    address: fieldDraft(contact, 'address'),
    distrito: fieldDraft(contact, 'distrito'),
    ocupacion: fieldDraft(contact, 'ocupacion'),
    notes: fieldDraft(contact, 'notes'),
  }
}

function cleanText(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function displayName(contact: ContactProfileContact) {
  return cleanText(contact.custom_name)
    || cleanText(contact.name)
    || cleanText(contact.push_name)
    || cleanText(contact.short_name)
    || cleanText(contact.phone)
    || 'Contacto sin nombre'
}

function formatDate(value: string) {
  if (!value) return ''
  const normalized = value.slice(0, 10)
  const [year, month, day] = normalized.split('-')
  return year && month && day ? `${day}/${month}/${year}` : value
}

function fieldValue(contact: ContactProfileContact, field: ProfileField) {
  const value = contact[field.key]
  if (value === null || value === undefined || value === '') return ''
  return field.format ? field.format(value) : String(value)
}

function fieldDraft(contact: ContactProfileContact, field: ContactProfileEditableField) {
  const value = contact[field]
  if (value === null || value === undefined) return ''
  if (field === 'birth_date') return String(value).slice(0, 10)
  return String(value)
}

function formatCustomFieldValue(value: ContactProfileContact['custom_field_values'][number]) {
  if (value.value_bool !== null && value.value_bool !== undefined) return value.value_bool ? 'Sí' : 'No'
  if (value.value_number !== null && value.value_number !== undefined) return String(value.value_number)
  if (value.value_date) return formatDate(value.value_date)
  if (Array.isArray(value.value_json) && value.value_json.length > 0) return value.value_json.join(', ')
  return cleanText(value.value_text)
}

function customFieldPatch(value: ContactProfileContact['custom_field_values'][number]): ContactProfileCustomFieldPatch {
  return {
    field_id: value.field_id,
    value_text: value.value_text ?? null,
    value_number: value.value_number ?? null,
    value_date: value.value_date ? String(value.value_date).slice(0, 10) : null,
    value_bool: value.value_bool ?? null,
    value_json: Array.isArray(value.value_json) ? value.value_json : null,
  }
}

function customFieldDraft(value: ContactProfileContact['custom_field_values'][number]) {
  if (value.field_type === 'checkbox') return value.value_bool ? 'true' : 'false'
  if (value.field_type === 'multi_select') return JSON.stringify(Array.isArray(value.value_json) ? value.value_json : [])
  if (value.field_type === 'number' || value.field_type === 'currency') return value.value_number === null || value.value_number === undefined ? '' : String(value.value_number)
  if (value.field_type === 'date') return value.value_date ? String(value.value_date).slice(0, 10) : ''
  return value.value_text || ''
}

function parseMultiDraft(value: string | undefined) {
  try {
    const parsed = JSON.parse(value || '[]')
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') as string[] : []
  } catch {
    return []
  }
}

function observationTypeLabel(type: string) {
  switch (type) {
    case 'attendance': return 'Asistencia'
    case 'call': return 'Llamada'
    case 'meeting': return 'Reunión'
    case 'email': return 'Correo'
    case 'whatsapp': return 'WhatsApp'
    default: return 'Nota'
  }
}

function observationTypeClass(type: string) {
  if (type === 'attendance') return 'border-emerald-200 bg-emerald-50 text-emerald-700'
  if (type === 'call') return 'border-blue-200 bg-blue-50 text-blue-700'
  if (type === 'meeting') return 'border-violet-200 bg-violet-50 text-violet-700'
  return 'border-slate-200 bg-slate-50 text-slate-600'
}

function observationDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('es-PE', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export default function ContactDetailSurface({
  contactId,
  context,
  initialContact,
  title = 'Detalles',
  subtitle = 'Perfil del contacto',
  onClose,
  onContactChange,
  onObservationChange,
  onSendMessage,
  sendingMessage = false,
  onDeleteContact,
  contextContent,
  hideHeader = false,
  parentOwnsScroll = false,
  readOnly = false,
  className = '',
}: ContactDetailSurfaceProps) {
  const profile = useContactProfile({ contactId, context, initialContact, onContactChange })
  const googleSync = useGoogleContactSync({
    contactId,
    context,
    contactSynced: Boolean(profile.contact?.google_sync),
    onSyncedChange: profile.updateGoogleSyncLocally,
  })
  const [showObservationComposer, setShowObservationComposer] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [newObservation, setNewObservation] = useState('')
  const [observationActionError, setObservationActionError] = useState('')
  const [visibleObservations, setVisibleObservations] = useState(5)
  const [editMode, setEditMode] = useState(false)
  const [editDraft, setEditDraft] = useState<ContactEditDraft | null>(null)
  const [editDirty, setEditDirty] = useState(false)
  const [phoneDraft, setPhoneDraft] = useState<ContactProfileExtraPhonePatch[]>([])
  const [tagDraft, setTagDraft] = useState<ContactProfileAvailableTag[]>([])
  const [customFieldDraftValues, setCustomFieldDraftValues] = useState<Record<string, string>>({})
  const [collectionError, setCollectionError] = useState('')

  useEffect(() => {
    setShowObservationComposer(false)
    setHistoryOpen(false)
    setNewObservation('')
    setObservationActionError('')
    setVisibleObservations(5)
    setEditMode(false)
    setEditDraft(null)
    setEditDirty(false)
    setPhoneDraft([])
    setTagDraft([])
    setCustomFieldDraftValues({})
    setCollectionError('')
  }, [contactId, context.id, context.type])

  const missingFields = useMemo(
    () => profile.contact ? profileFields.filter(field => !fieldValue(profile.contact!, field)) : [],
    [profile.contact],
  )
  const visibleFields = useMemo(() => {
    if (!profile.contact) return []
    return profileFields.filter(field => Boolean(fieldValue(profile.contact!, field)))
  }, [profile.contact])
  const customFields = useMemo(
    () => (profile.contact?.custom_field_values || []).map(value => ({ value, display: formatCustomFieldValue(value) })),
    [profile.contact?.custom_field_values],
  )
  const canEdit = profile.capabilities.can_edit && !readOnly
  const canManageAvatar = profile.capabilities.can_manage_avatar && !readOnly
  const canManageObservations = profile.capabilities.can_manage_observations && !readOnly

  const toggleHistory = () => {
    const next = !historyOpen
    setHistoryOpen(next)
    setObservationActionError('')
    if (next && !profile.observationsLoaded) void profile.refreshObservations()
  }

  const enterEditMode = () => {
    if (!profile.contact || !canEdit || profile.saving) return
    setEditDraft(contactEditDraft(profile.contact))
    setPhoneDraft(profile.contact.extra_phones.map(phone => ({ id: phone.id, phone: phone.phone, label: phone.label || '' })))
    setTagDraft(profile.contact.structured_tags)
    const valuesByField = new globalThis.Map(profile.contact.custom_field_values.map(value => [value.field_id, value]))
    const drafts = Object.fromEntries(profile.customFieldDefinitions.map(definition => {
      const value = valuesByField.get(definition.id)
      return [definition.id, value ? customFieldDraft(value) : definition.field_type === 'multi_select' ? '[]' : '']
    }))
    profile.contact.custom_field_values.forEach(value => { if (!(value.field_id in drafts)) drafts[value.field_id] = customFieldDraft(value) })
    setCustomFieldDraftValues(drafts)
    setEditDirty(false)
    setCollectionError('')
    setEditMode(true)
  }

  const abandonEdit = () => {
    if (editDirty && !window.confirm('Hay cambios del contacto sin guardar. ¿Deseas descartarlos?')) return
    setEditMode(false)
    setEditDraft(null)
    setEditDirty(false)
    setCollectionError('')
  }

  const requestClose = () => {
    if (editMode && editDirty && !window.confirm('Hay cambios del contacto sin guardar. ¿Deseas cerrar y descartarlos?')) return
    onClose()
  }

  const updateEditDraft = (field: ContactProfileEditableField, value: string) => {
    setEditDraft(current => current ? { ...current, [field]: value } : current)
    setEditDirty(true)
    setCollectionError('')
  }

  const saveCompleteContact = async () => {
    if (!editDraft || !profile.contact) return
    const ageText = editDraft.age.trim()
    const age = ageText ? Number(ageText) : null
    if (age !== null && (!Number.isInteger(age) || age < 1 || age > 150)) {
      setCollectionError('La edad debe estar entre 1 y 150 años.')
      return
    }
    const cleaned = phoneDraft.map(phone => ({ id: phone.id, phone: phone.phone.trim(), label: phone.label?.trim() || null }))
    if (cleaned.some(phone => !phone.phone)) {
      setCollectionError('Completa el teléfono o elimina esa fila antes de guardar.')
      return
    }
    const normalized = cleaned.map(phone => phone.phone.replace(/\D/g, '') || phone.phone.toLowerCase())
    const primaryPhone = editDraft.phone.replace(/\D/g, '')
    if (new Set(normalized).size !== normalized.length || (primaryPhone && normalized.includes(primaryPhone))) {
      setCollectionError('No se puede registrar el mismo teléfono más de una vez.')
      return
    }
    let result
    try {
      const customFieldValues = profile.customFieldDefinitions.map(definition => {
        const draft = customFieldDraftValues[definition.id] || ''
        const edited: ContactProfileCustomFieldPatch = { field_id: definition.id }
        if (definition.field_type === 'number' || definition.field_type === 'currency') {
          const numberValue = draft.trim() === '' ? null : Number(draft)
          if (numberValue !== null && !Number.isFinite(numberValue)) throw new Error(`El campo ${definition.name} debe ser numérico.`)
          edited.value_number = numberValue
        } else if (definition.field_type === 'date') edited.value_date = draft || null
        else if (definition.field_type === 'checkbox') edited.value_bool = draft === '' ? null : draft === 'true'
        else if (definition.field_type === 'multi_select') {
          const selected = JSON.parse(draft || '[]') as string[]
          edited.value_json = selected.length > 0 ? selected : null
        } else edited.value_text = draft.trim() || null
        const hasValue = edited.value_text !== null && edited.value_text !== undefined
          || edited.value_number !== null && edited.value_number !== undefined
          || edited.value_date !== null && edited.value_date !== undefined
          || edited.value_bool !== null && edited.value_bool !== undefined
          || Array.isArray(edited.value_json) && edited.value_json.length > 0
        if (definition.is_required && !hasValue) throw new Error(`Completa el campo obligatorio ${definition.name}.`)
        return edited
      })
      const definitionIDs = new Set(profile.customFieldDefinitions.map(definition => definition.id))
      profile.contact.custom_field_values.forEach(value => {
        if (!definitionIDs.has(value.field_id)) customFieldValues.push(customFieldPatch(value))
      })
      result = await profile.updateContact({
        name: editDraft.name.trim() || null,
        custom_name: editDraft.custom_name.trim() || null,
        last_name: editDraft.last_name.trim() || null,
        short_name: editDraft.short_name.trim() || null,
        phone: editDraft.phone.trim() || null,
        email: editDraft.email.trim() || null,
        company: editDraft.company.trim() || null,
        age,
        dni: editDraft.dni.trim() || null,
        birth_date: editDraft.birth_date || null,
        address: editDraft.address.trim() || null,
        distrito: editDraft.distrito.trim() || null,
        ocupacion: editDraft.ocupacion.trim() || null,
        notes: editDraft.notes.trim() || null,
        tag_ids: tagDraft.map(tag => tag.id),
        extra_phones: cleaned,
        custom_field_values: customFieldValues,
      })
    } catch (error) {
      setCollectionError(error instanceof Error ? error.message : 'Revisa los campos personalizados.')
      return
    }
    if (!result.success) {
      setCollectionError(result.error || 'No se pudo guardar el contacto.')
      return
    }
    setCollectionError('')
    setEditMode(false)
    setEditDraft(null)
    setEditDirty(false)
  }

  useEffect(() => {
    if (!editMode) return
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!editDirty) return
      event.preventDefault()
      event.returnValue = ''
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      abandonEdit()
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    window.addEventListener('keydown', handleEscape, true)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      window.removeEventListener('keydown', handleEscape, true)
    }
  }, [editDirty, editMode])

  const addObservation = async () => {
    setObservationActionError('')
    const result = await profile.createObservation(newObservation)
    if (!result.success) {
      setObservationActionError(result.error || 'No se pudo añadir la observación.')
      return
    }
    setNewObservation('')
    // Keep the composer open: users often register several observations in sequence.
    setShowObservationComposer(true)
    onObservationChange?.()
  }

  const removeObservation = async (observation: Observation) => {
    if (observation.type !== 'note') return
    if (!window.confirm('¿Eliminar esta observación? Esta acción no se puede deshacer.')) return
    setObservationActionError('')
    const result = await profile.deleteObservation(observation.id)
    if (!result.success) setObservationActionError(result.error || 'No se pudo eliminar la observación.')
    else onObservationChange?.()
  }

  const requestGoogleDesync = () => {
    if (!window.confirm('¿Quitar este contacto de Google Contacts? Dejará de recibir actualizaciones automáticas desde Clarin.')) return
    void googleSync.desync()
  }

  return (
    <div className={`flex min-h-0 flex-col bg-white motion-reduce:transition-none ${parentOwnsScroll ? 'h-auto' : 'h-full'} ${className}`}>
      {!hideHeader && !editMode && (
        <header className="relative z-[82] flex min-h-16 shrink-0 items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 pt-[env(safe-area-inset-top)]">
          <div className="min-w-0">
            <h2 className="truncate text-base font-bold text-slate-900">{editMode ? 'Editar contacto' : title}</h2>
            <p className="truncate text-[11px] text-slate-500">{editMode ? 'Una sola ficha para todos los módulos' : subtitle}</p>
          </div>
          <div className="flex items-center gap-1">
            {profile.refreshing && <Loader2 className="h-4 w-4 animate-spin text-emerald-600" aria-label="Actualizando ficha" />}
            <button type="button" onClick={requestClose} className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label="Cerrar detalles">
              <X className="h-5 w-5" />
            </button>
          </div>
        </header>
      )}

      <div className={`${parentOwnsScroll ? '' : 'min-h-0 flex-1 overflow-y-auto overscroll-contain'}`}>
        {profile.loading && !profile.contact ? (
          <div className="space-y-4 p-4" aria-label="Cargando ficha del contacto">
            <div className="flex animate-pulse items-center gap-3 rounded-2xl border border-slate-100 p-4"><div className="h-14 w-14 rounded-full bg-slate-100" /><div className="flex-1 space-y-2"><div className="h-4 w-2/3 rounded bg-slate-100" /><div className="h-3 w-1/2 rounded bg-slate-100" /></div></div>
            <div className="h-40 animate-pulse rounded-2xl bg-slate-100" />
          </div>
        ) : !profile.contact ? (
          <div className="flex min-h-[360px] flex-col items-center justify-center px-6 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-red-50 text-red-600"><AlertCircle className="h-6 w-6" /></div>
            <h3 className="mt-4 text-sm font-bold text-slate-900">No pudimos abrir la ficha</h3>
            <p className="mt-1 max-w-xs text-xs leading-relaxed text-slate-500">{profile.error || 'El contacto no está disponible en este contexto.'}</p>
            <button type="button" onClick={profile.refresh} className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-xl bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2"><RefreshCw className="h-4 w-4" /> Reintentar</button>
          </div>
        ) : (
          <>
            {profile.error && (
              <div className="mx-4 mt-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800" role="status">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span className="min-w-0 flex-1">{profile.error}</span><button type="button" onClick={profile.refresh} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg hover:bg-amber-100" aria-label="Reintentar"><RefreshCw className="h-4 w-4" /></button>
              </div>
            )}

            {editMode && editDraft ? (
              <>
              <div aria-hidden="true" className="fixed inset-0 z-[80] bg-transparent" onMouseDown={event => { event.preventDefault(); abandonEdit() }} />
              <form aria-label="Editar contacto" onSubmit={event => { event.preventDefault(); void saveCompleteContact() }} className="relative z-[81] min-h-full bg-slate-50/60 max-sm:fixed max-sm:inset-0 max-sm:z-[100] max-sm:overflow-y-auto max-sm:overscroll-contain max-sm:animate-in max-sm:fade-in max-sm:duration-200 motion-reduce:animate-none">
                <section className="border-b border-slate-200 bg-white px-4 pb-4 pt-[max(1rem,env(safe-area-inset-top))] sm:pt-4">
                  <div className="flex items-center gap-3">
                    <ContactAvatarControl contactId={profile.contact.id} contextType={context.type} contextId={context.id} displayName={displayName(profile.contact)} avatarUrl={profile.contact.avatar_url} compact disabled={!canManageAvatar} onChange={profile.updateAvatarLocally} />
                    <div className="min-w-0 flex-1"><h3 className="truncate text-base font-bold text-slate-900">Editar contacto</h3><p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-slate-500">Los cambios se reflejarán en Leads, Chats, Eventos y Programas.</p></div>
                    <button type="button" onClick={requestClose} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label="Cerrar detalles"><X className="h-5 w-5" /></button>
                  </div>
                </section>
                <div className="space-y-4 p-4">
                  <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                    <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Identidad y datos</h4>
                    <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <label className="block sm:col-span-2"><span className="mb-1 block text-xs font-semibold text-slate-600">Nombre visible</span><input autoFocus type="text" value={editDraft.custom_name} onChange={event => updateEditDraft('custom_name', event.target.value)} placeholder="Nombre que verá el equipo" className="h-11 w-full rounded-xl border border-slate-300 px-3 text-base text-slate-900 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 sm:text-sm" /></label>
                      <label className="block sm:col-span-2"><span className="mb-1 block text-xs font-semibold text-slate-600">Nombre de origen</span><input type="text" value={editDraft.name} onChange={event => updateEditDraft('name', event.target.value)} placeholder="Nombre sincronizado o registrado" className="h-11 w-full rounded-xl border border-slate-300 px-3 text-base text-slate-900 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 sm:text-sm" /></label>
                      {profileFields.map(field => <label key={field.key} className={`block ${field.key === 'address' ? 'sm:col-span-2' : ''}`}><span className="mb-1 block text-xs font-semibold text-slate-600">{field.label}</span><input type={field.inputType || 'text'} inputMode={field.inputType === 'tel' ? 'tel' : field.inputType === 'number' ? 'numeric' : undefined} value={editDraft[field.key]} onChange={event => updateEditDraft(field.key, event.target.value)} placeholder={field.placeholder} min={field.key === 'age' ? 1 : undefined} max={field.key === 'age' ? 150 : undefined} className="h-11 w-full rounded-xl border border-slate-300 px-3 text-base text-slate-900 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 sm:text-sm" /></label>)}
                      <label className="block sm:col-span-2"><span className="mb-1 block text-xs font-semibold text-slate-600">Notas del contacto</span><textarea rows={4} value={editDraft.notes} onChange={event => updateEditDraft('notes', event.target.value)} placeholder="Notas generales sobre la persona" className="w-full resize-y rounded-xl border border-slate-300 px-3 py-2.5 text-base leading-relaxed text-slate-900 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 sm:text-sm" /></label>
                    </div>
                  </section>

                  <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                    <div className="flex items-center gap-2"><Phone className="h-4 w-4 text-slate-400" /><h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Teléfonos adicionales</h4></div>
                    <div className="mt-3 space-y-2">{phoneDraft.map((phone, index) => <div key={phone.id || `phone-${index}`} className="rounded-xl border border-slate-200 bg-slate-50 p-2"><div className="flex gap-2"><input type="tel" inputMode="tel" aria-label={`Teléfono adicional ${index + 1}`} value={phone.phone} onChange={event => { setPhoneDraft(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, phone: event.target.value } : item)); setEditDirty(true); setCollectionError('') }} placeholder="Teléfono adicional" className="h-11 min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-900 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 sm:text-sm" /><button type="button" onClick={() => { setPhoneDraft(current => current.filter((_, itemIndex) => itemIndex !== index)); setEditDirty(true) }} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-400 hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500" aria-label={`Eliminar teléfono adicional ${index + 1}`}><Trash2 className="h-4 w-4" /></button></div><input type="text" aria-label={`Etiqueta del teléfono ${index + 1}`} value={phone.label || ''} onChange={event => { setPhoneDraft(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item)); setEditDirty(true) }} placeholder="Etiqueta opcional, por ejemplo Trabajo" className="mt-2 h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-900 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 sm:text-sm" /></div>)}</div>
                    <button type="button" onClick={() => { setPhoneDraft(current => [...current, { phone: '', label: '' }]); setEditDirty(true) }} className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 px-3 text-sm font-bold text-emerald-700 hover:border-emerald-300 hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"><Plus className="h-4 w-4" /> Añadir teléfono</button>
                  </section>

                  <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                    <div className="flex items-center gap-2"><Tag className="h-4 w-4 text-slate-400" /><h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Etiquetas</h4></div>
                    <ContactTagEditor contactId={profile.contact.id} context={context} selected={tagDraft} canCreate={profile.capabilities.can_create_tags} disabled={profile.saving} onChange={tags => { setTagDraft(tags); setEditDirty(true); setCollectionError('') }} />
                  </section>

                  {profile.customFieldDefinitions.length > 0 && <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><div className="flex items-center gap-2"><SlidersHorizontal className="h-4 w-4 text-slate-400" /><h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Campos personalizados</h4></div><div className="mt-3 space-y-3">{profile.customFieldDefinitions.map(definition => { const draft = customFieldDraftValues[definition.id] || ''; const options = definition.options || definition.config?.options || []; const update = (next: string) => { setCustomFieldDraftValues(current => ({ ...current, [definition.id]: next })); setEditDirty(true); setCollectionError('') }; return <div key={definition.id}><label htmlFor={`profile-definition-${definition.id}`} className="mb-1 block text-xs font-semibold text-slate-600">{definition.name}{definition.is_required && <span className="text-red-500"> *</span>}</label>{definition.field_type === 'checkbox' ? <select id={`profile-definition-${definition.id}`} value={draft} onChange={event => update(event.target.value)} className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-900 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 sm:text-sm"><option value="">Sin valor</option><option value="true">Sí</option><option value="false">No</option></select> : definition.field_type === 'select' && options.length > 0 ? <select id={`profile-definition-${definition.id}`} value={draft} onChange={event => update(event.target.value)} className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-900 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 sm:text-sm"><option value="">Sin valor</option>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : definition.field_type === 'multi_select' ? options.length > 0 ? <div id={`profile-definition-${definition.id}`} className="grid grid-cols-1 gap-2 sm:grid-cols-2">{options.map(option => { const selected = parseMultiDraft(draft).includes(option.value); return <button key={option.value} type="button" aria-pressed={selected} onClick={() => { const current = parseMultiDraft(draft); update(JSON.stringify(selected ? current.filter(item => item !== option.value) : [...current, option.value])) }} className={`min-h-11 rounded-xl border px-3 text-left text-sm font-semibold ${selected ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-slate-200 text-slate-600'}`}>{option.label}</button>})}</div> : <input id={`profile-definition-${definition.id}`} type="text" value={parseMultiDraft(draft).join(', ')} onChange={event => update(JSON.stringify(event.target.value.split(',').map(item => item.trim()).filter(Boolean)))} placeholder="Valores separados por coma" className="h-11 w-full rounded-xl border border-slate-300 px-3 text-base text-slate-900 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 sm:text-sm" /> : definition.field_type === 'text' && (definition.config?.text_variant === 'textarea' || definition.config?.text_variant === 'rich') ? <textarea id={`profile-definition-${definition.id}`} rows={4} value={draft} onChange={event => update(event.target.value)} className="w-full resize-y rounded-xl border border-slate-300 px-3 py-2.5 text-base text-slate-900 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 sm:text-sm" /> : <input id={`profile-definition-${definition.id}`} type={definition.field_type === 'number' || definition.field_type === 'currency' ? 'number' : definition.field_type === 'date' ? 'date' : definition.field_type === 'email' ? 'email' : definition.field_type === 'phone' ? 'tel' : 'text'} value={draft} onChange={event => update(event.target.value)} min={definition.config?.min} max={definition.config?.max} maxLength={definition.config?.max_length} className="h-11 w-full rounded-xl border border-slate-300 px-3 text-base text-slate-900 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 sm:text-sm" />}</div>})}</div></section>}
                </div>
                <footer className="sticky bottom-0 z-20 border-t border-slate-200 bg-white/95 px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-[0_-8px_24px_rgba(15,23,42,0.08)] backdrop-blur">
                  {collectionError && <p className="mb-2 rounded-xl bg-red-50 px-3 py-2 text-xs font-medium text-red-700" role="alert">{collectionError}</p>}
                  <div className="mb-2 flex items-center gap-2 text-xs"><span className={`h-2 w-2 rounded-full ${editDirty ? 'bg-amber-500' : 'bg-slate-300'}`} /><span className={editDirty ? 'font-semibold text-amber-700' : 'text-slate-500'}>{editDirty ? 'Cambios sin guardar' : 'Sin cambios pendientes'}</span></div>
                  <div className="grid grid-cols-2 gap-2"><button type="button" onClick={abandonEdit} disabled={profile.saving} className="min-h-11 rounded-xl border border-slate-200 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">Cancelar</button><button type="submit" disabled={profile.saving || !editDirty} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-bold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-45">{profile.saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}{profile.saving ? 'Guardando…' : 'Guardar contacto'}</button></div>
                </footer>
              </form>
              </>
            ) : (
              <>
                <section className="border-b border-slate-200 px-4 py-4" aria-labelledby="canonical-contact-name">
                  <div className="flex items-center gap-3">
                    <ContactAvatarControl contactId={profile.contact.id} contextType={context.type} contextId={context.id} displayName={displayName(profile.contact)} avatarUrl={profile.contact.avatar_url} compact disabled={!canManageAvatar} onChange={profile.updateAvatarLocally} />
                    <div className="min-w-0 flex-1">
                      <h3 id="canonical-contact-name" className="truncate text-base font-bold text-slate-900">{displayName(profile.contact)}</h3>
                      {profile.contact.phone && <p className="mt-0.5 truncate text-xs font-medium text-slate-500">{profile.contact.phone.startsWith('+') ? profile.contact.phone : `+${profile.contact.phone}`}</p>}
                    </div>
                    {canEdit && <button type="button" onClick={enterEditMode} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label="Editar contacto"><Edit2 className="h-4 w-4" /></button>}
                  </div>
                  {profile.contact.do_not_contact && <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"><span className="font-bold">No contactar.</span>{profile.contact.do_not_contact_reason ? ` ${profile.contact.do_not_contact_reason}` : ''}</div>}
                  {onSendMessage && profile.contact.phone && <button type="button" onClick={() => onSendMessage(profile.contact!.phone!)} disabled={sendingMessage} aria-label={`Enviar mensaje a ${displayName(profile.contact)}`} className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-bold text-white shadow-sm transition duration-200 motion-reduce:transition-none hover:bg-emerald-700 disabled:opacity-60">{sendingMessage ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageCircle className="h-4 w-4" />}{sendingMessage ? 'Abriendo…' : 'Enviar mensaje'}</button>}

                  {googleSync.statusLoading && (
                    <div role="status" aria-label="Consultando Google Contacts" className="mt-3 flex min-h-11 items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 text-xs font-semibold text-slate-500">
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-sky-600" />
                      Consultando Google Contacts…
                    </div>
                  )}

                  {!googleSync.statusLoading && googleSync.statusError && !googleSync.permissionDenied && (
                    <div role="alert" className="mt-3 flex min-h-11 items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      <AlertCircle className="h-4 w-4 shrink-0" />
                      <span className="min-w-0 flex-1">{googleSync.statusError}</span>
                      <button type="button" onClick={() => void googleSync.retryStatus()} className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-2.5 font-bold hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500" aria-label="Reintentar Google Contacts"><RefreshCw className="h-3.5 w-3.5" /> Reintentar</button>
                    </div>
                  )}

                  {!googleSync.statusLoading && googleSync.connected && (
                    <div className="mt-3 rounded-2xl border border-sky-200 bg-sky-50/60 p-3" role="region" aria-label="Google Contacts">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${googleSync.synced ? 'bg-sky-100 text-sky-700' : 'bg-white text-slate-500'}`}>
                          {googleSync.synced ? <Cloud className="h-5 w-5" /> : <CloudOff className="h-5 w-5" />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-bold text-slate-800">{googleSync.synced ? 'Sincronizado con Google' : 'Google Contacts'}</p>
                          <p className="mt-0.5 text-[10px] leading-4 text-slate-500">{googleSync.synced ? 'Los cambios del contacto se reflejan en Google.' : 'Guarda este contacto también en tu cuenta de Google.'}</p>
                        </div>
                      </div>

                      <div className={`mt-3 grid gap-2 ${googleSync.synced ? 'grid-cols-2' : 'grid-cols-1'}`}>
                        <button type="button" onClick={() => void googleSync.sync()} disabled={googleSync.mutation !== null} className="inline-flex min-h-11 min-w-0 items-center justify-center gap-2 rounded-xl bg-sky-600 px-3 text-xs font-bold text-white transition hover:bg-sky-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-55" aria-label={googleSync.synced ? 'Actualizar contacto en Google Contacts' : 'Sincronizar contacto con Google Contacts'}>
                          {googleSync.mutation === 'sync' ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : <RefreshCw className="h-4 w-4 shrink-0" />}
                          <span className="truncate">{googleSync.mutation === 'sync' ? 'Sincronizando…' : googleSync.synced ? 'Actualizar' : 'Sincronizar'}</span>
                        </button>
                        {googleSync.synced && <button type="button" onClick={requestGoogleDesync} disabled={googleSync.mutation !== null} className="inline-flex min-h-11 min-w-0 items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold text-slate-600 transition hover:border-red-200 hover:bg-red-50 hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:cursor-wait disabled:opacity-55" aria-label="Quitar contacto de Google Contacts">{googleSync.mutation === 'desync' ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : <CloudOff className="h-4 w-4 shrink-0" />}<span className="truncate">{googleSync.mutation === 'desync' ? 'Quitando…' : 'Quitar'}</span></button>}
                      </div>

                      {(googleSync.actionError || profile.contact.google_sync_error) && <p role="alert" className="mt-2 rounded-xl border border-red-200 bg-white px-3 py-2 text-[11px] leading-4 text-red-700">{googleSync.actionError || profile.contact.google_sync_error}</p>}
                      {googleSync.feedback && <p role="status" className="mt-2 rounded-xl border border-sky-100 bg-white px-3 py-2 text-[11px] leading-4 text-sky-800">{googleSync.feedback}</p>}
                    </div>
                  )}
                </section>
                <section className="border-b border-slate-200 px-4 py-4" aria-labelledby="canonical-contact-data-title"><div className="mb-2 flex items-center justify-between gap-3"><h4 id="canonical-contact-data-title" className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Datos del contacto</h4>{canEdit && <button type="button" onClick={enterEditMode} className="inline-flex min-h-10 items-center gap-1.5 rounded-xl px-3 text-xs font-bold text-emerald-700 hover:bg-emerald-50"><Edit2 className="h-3.5 w-3.5" /> Editar contacto</button>}</div><div className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white px-3">{visibleFields.map(field => { const Icon = field.icon; const value = fieldValue(profile.contact!, field); return <div key={field.key} className="flex min-h-12 items-center gap-3 py-2"><Icon className="h-4 w-4 shrink-0 text-emerald-600" /><div className="min-w-0 flex-1"><p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{field.label}</p><p className="truncate text-sm font-medium text-slate-800">{value}</p></div></div>})}{visibleFields.length === 0 && <p className="py-4 text-center text-xs text-slate-400">Aún no hay datos adicionales.</p>}</div>{missingFields.length > 0 && canEdit && <button type="button" onClick={enterEditMode} className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50/60 px-3 text-sm font-bold text-emerald-700 hover:bg-emerald-50"><Plus className="h-4 w-4" />Completar {missingFields.length} dato{missingFields.length === 1 ? '' : 's'}</button>}{profile.contact.extra_phones.length > 0 && <div className="mt-3 rounded-xl bg-slate-50 px-3 py-2.5"><p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Otros teléfonos</p><div className="mt-1 divide-y divide-slate-200/70">{profile.contact.extra_phones.map(phone => <p key={phone.id || phone.phone} className="flex min-h-11 items-center justify-between gap-3 text-xs text-slate-700"><span className="font-medium">{phone.phone}</span>{phone.label && <span className="text-slate-400">{phone.label}</span>}</p>)}</div></div>}{(profile.contact.device_names || []).length > 0 && <div className="mt-3 rounded-xl bg-slate-50 px-3 py-2.5"><div className="flex items-center gap-2"><Smartphone className="h-3.5 w-3.5 text-slate-400" /><p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Nombres por dispositivo</p></div><div className="mt-1 divide-y divide-slate-200/70">{profile.contact.device_names!.map(deviceName => <div key={deviceName.id || deviceName.device_id} className="flex min-h-11 items-center justify-between gap-3 text-xs"><span className="truncate font-medium text-slate-700">{cleanText(deviceName.name) || cleanText(deviceName.push_name) || cleanText(deviceName.business_name) || 'Sin nombre sincronizado'}</span><span className="max-w-[45%] truncate text-[10px] text-slate-400">{cleanText(deviceName.device_name) || 'Dispositivo WhatsApp'}</span></div>)}</div></div>}</section>
                <section className="space-y-4 border-b border-slate-200 px-4 py-4"><div><div className="mb-2 flex items-center gap-2"><Tag className="h-4 w-4 text-slate-400" /><h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Etiquetas del contacto</h4></div>{profile.contact.structured_tags.length > 0 ? <div className="flex flex-wrap gap-1.5">{profile.contact.structured_tags.map(tag => <span key={tag.id} className="rounded-full px-2.5 py-1 text-xs font-semibold text-white" style={{ backgroundColor: tag.color || '#64748b' }}>{tag.name}</span>)}</div> : <p className="text-xs italic text-slate-400">Sin etiquetas registradas.</p>}</div>{customFields.length > 0 && <div><div className="mb-2 flex items-center gap-2"><SlidersHorizontal className="h-4 w-4 text-slate-400" /><h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Campos personalizados</h4></div><div className="divide-y divide-slate-100 rounded-xl bg-slate-50 px-3">{customFields.map(({ value, display }) => <div key={value.id || value.field_id} className="flex min-h-11 items-center justify-between gap-3 py-2 text-xs"><span className="min-w-0 truncate text-slate-500">{value.field_name || value.field_slug || 'Campo personalizado'}</span><span className={`max-w-[55%] break-words text-right font-semibold ${display ? 'text-slate-700' : 'italic text-slate-400'}`}>{display || 'Sin valor'}</span></div>)}</div></div>}<div><div className="mb-2 flex items-center gap-2"><FileText className="h-4 w-4 text-slate-400" /><h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Notas del contacto</h4></div><p className={`whitespace-pre-wrap rounded-xl bg-slate-50 px-3 py-2.5 text-sm leading-relaxed ${cleanText(profile.contact.notes) ? 'text-slate-700' : 'italic text-slate-400'}`}>{cleanText(profile.contact.notes) || 'Sin notas registradas.'}</p></div></section>

            <section className="border-b border-slate-200 px-4 py-4" aria-labelledby="canonical-contact-history-title">
              <div className="flex min-w-0 items-center gap-2"><Clock3 className="h-4 w-4 shrink-0 text-slate-400" /><div><h4 id="canonical-contact-history-title" className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Historial del contacto</h4><p className="text-[10px] text-slate-400">{profile.observationCount} registro{profile.observationCount === 1 ? '' : 's'}</p></div></div>
              <div className={`mt-3 grid gap-2 ${canManageObservations ? 'grid-cols-2' : 'grid-cols-1'}`}>
                <button type="button" onClick={toggleHistory} aria-expanded={historyOpen} className="inline-flex min-h-11 min-w-0 items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white px-2 text-xs font-bold text-slate-600 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">{historyOpen ? <ChevronUp className="h-4 w-4 shrink-0" /> : <ChevronDown className="h-4 w-4 shrink-0" />}<span className="truncate">{historyOpen ? 'Ocultar historial' : 'Ver historial'}</span></button>
                {canManageObservations && <button type="button" onClick={() => { setShowObservationComposer(value => !value); setObservationActionError('') }} aria-expanded={showObservationComposer} className="inline-flex min-h-11 min-w-0 items-center justify-center gap-1.5 rounded-xl border border-emerald-200 bg-white px-2 text-xs font-bold text-emerald-700 hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">{showObservationComposer ? <ChevronUp className="h-4 w-4 shrink-0" /> : <Plus className="h-4 w-4 shrink-0" />}<span className="truncate">{showObservationComposer ? 'Ocultar formulario' : 'Añadir observación'}</span></button>}
              </div>

              {showObservationComposer && (
                <div className="mt-3 rounded-2xl border border-emerald-200 bg-emerald-50/40 p-3">
                  <label htmlFor="canonical-contact-observation" className="sr-only">Nueva observación</label>
                  <textarea id="canonical-contact-observation" autoFocus rows={3} maxLength={4000} value={newObservation} onChange={event => { setNewObservation(event.target.value); setObservationActionError('') }} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && newObservation.trim()) { event.preventDefault(); void addObservation() } }} placeholder="Escribir observación… (Ctrl+Enter)" className="w-full resize-y rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm leading-relaxed text-slate-800 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100" />
                  <div className="mt-2 flex justify-end"><button type="button" onClick={() => void addObservation()} disabled={!newObservation.trim() || profile.savingObservation} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-bold text-white hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-45">{profile.savingObservation ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}{profile.savingObservation ? 'Agregando…' : 'Agregar'}</button></div>
                </div>
              )}

              {(observationActionError || (historyOpen && profile.observationsError)) && <div className="mt-3 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-700" role="alert"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span className="min-w-0 flex-1">{observationActionError || profile.observationsError}</span>{historyOpen && profile.observationsError && <button type="button" onClick={profile.refreshObservations} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg hover:bg-red-100" aria-label="Reintentar historial"><RefreshCw className="h-4 w-4" /></button>}</div>}

              {historyOpen && (profile.observationsLoading ? <div className="flex min-h-24 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-emerald-600" aria-label="Cargando historial" /></div> : profile.observations.length === 0 ? <div className="mt-3 rounded-2xl border border-dashed border-slate-200 px-4 py-7 text-center"><FileText className="mx-auto h-6 w-6 text-slate-300" /><p className="mt-2 text-xs text-slate-400">No hay observaciones registradas.</p></div> : (
                <div className="mt-3 space-y-2">
                  {profile.observations.slice(0, visibleObservations).map(observation => (
                    <article key={observation.id} className="group rounded-2xl border border-slate-200 bg-white p-3">
                      <div className="flex items-start justify-between gap-3"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${observationTypeClass(observation.type)}`}>{observationTypeLabel(observation.type)}</span><time className="text-[10px] text-slate-400">{observationDate(observation.created_at)}</time></div><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-700">{cleanText(observation.notes) || '(sin contenido)'}</p>{observation.source_label && <p className="mt-2 text-[10px] font-semibold text-emerald-700">{observation.source_label}</p>}{observation.created_by_name && <p className="mt-1 text-[10px] text-slate-400">Registrado por {observation.created_by_name}</p>}</div>{canManageObservations && observation.type === 'note' && <button type="button" onClick={() => void removeObservation(observation)} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-300 hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100" aria-label="Eliminar observación"><Trash2 className="h-4 w-4" /></button>}</div>
                    </article>
                  ))}
                  {profile.observations.length > visibleObservations && <button type="button" onClick={() => setVisibleObservations(value => value + 10)} className="inline-flex min-h-11 w-full items-center justify-center rounded-xl text-sm font-bold text-emerald-700 hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">Mostrar {Math.min(10, profile.observations.length - visibleObservations)} más</button>}
                </div>
              ))}
            </section>

            {contextContent}

            {onDeleteContact && (
              <div className="px-4 py-4"><button type="button" onClick={() => onDeleteContact(profile.contact!)} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-red-200 px-4 text-sm font-semibold text-red-600 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"><Trash2 className="h-4 w-4" /> Eliminar contacto</button></div>
            )}
          </>
        )}
          </>
        )}
      </div>
    </div>
  )
}

export type { ContactDetailSurfaceProps }
