'use client'

import { useEffect, useMemo, useState } from 'react'
import { CalendarDays, Check, Clock3, Link2, Loader2, MapPin, Repeat2, Trash2, UserPlus, X } from 'lucide-react'
import { apiDelete, apiPost, apiPut } from '@/lib/api'
import type { TaskFolder, TaskList, WorkEvent, WorkEventOccurrence } from '@/types/task'
import type { TaskAccountUser } from './TaskEditorModal'
import TaskWorkWindowShell from './TaskWorkWindowShell'
import TaskDateTimePicker from './TaskDateTimePicker'
import TaskUserCombobox from './TaskUserCombobox'
import { TaskListPicker } from './TaskSelectPicker'
import { TaskColorPicker, taskColorContrast } from './TaskContainerAppearance'
import { resolveTaskIdentityColor } from './taskIdentityColor'

export interface WorkEventDraft {
	title?: string
	listId?: string
	startAt: string
	endAt: string
	allDay: boolean
}

interface Props {
	open: boolean
	event?: WorkEvent | null
	occurrence?: WorkEventOccurrence | null
	draft?: WorkEventDraft | null
	lists: TaskList[]
	folders: TaskFolder[]
	users: TaskAccountUser[]
	currentUserID: string
	defaultListID?: string
	storageScope?: string
	onClose: () => void
	onSaved: (event: WorkEvent) => void
	onDeleted?: (eventID: string) => void
}

type MutationResponse = { event?: WorkEvent; code?: string; conflicts?: Array<{ start_at: string; end_at: string }> }

const localDateTime = (value?: string) => {
	if (!value) return ''
	const date = new Date(value)
	if (Number.isNaN(date.getTime())) return value.slice(0, 16)
	const offset = date.getTimezoneOffset() * 60000
	return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

const inclusiveDateFromExclusive = (value?: string) => {
	if (!value) return ''
	const date = new Date(`${value}T12:00:00`)
	date.setDate(date.getDate() - 1)
	return date.toISOString().slice(0, 10)
}

const exclusiveDateFromInclusive = (value: string) => {
	const date = new Date(`${value.slice(0, 10)}T12:00:00`)
	date.setDate(date.getDate() + 1)
	return date.toISOString().slice(0, 10)
}

const recurrenceFromEvent = (rule?: string) => {
	const parts = new Map((rule || '').split(';').filter(Boolean).map(item => item.split('=', 2) as [string, string]))
	return {
		frequency: parts.get('FREQ') || '',
		interval: Math.max(1, Number(parts.get('INTERVAL') || '1')),
		weekdays: parts.get('BYDAY') === 'MO,TU,WE,TH,FR',
		end: parts.has('UNTIL') ? 'until' : 'count',
		count: Math.min(730, Math.max(1, Number(parts.get('COUNT') || '10'))),
		until: (parts.get('UNTIL') || '').slice(0, 8).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'),
	}
}

export default function WorkEventEditor({ open, event, occurrence, draft, lists, folders, users, currentUserID, defaultListID, storageScope, onClose, onSaved, onDeleted }: Props) {
	const [title, setTitle] = useState('')
	const [description, setDescription] = useState('')
	const [listID, setListID] = useState('')
	const [allDay, commitAllDay] = useState(false)
	const [startAt, setStartAt] = useState('')
	const [endAt, setEndAt] = useState('')
	const [timezone, setTimezone] = useState('America/Lima')
	const [location, setLocation] = useState('')
	const [meetingURL, setMeetingURL] = useState('')
	const [availability, setAvailability] = useState<'busy' | 'free'>('busy')
	const [color, setColor] = useState<string | null>(null)
	const [attendeeIDs, setAttendeeIDs] = useState<string[]>([])
	const [attendeeCandidate, setAttendeeCandidate] = useState('')
	const [frequency, setFrequency] = useState('')
	const [recurrenceInterval, setRecurrenceInterval] = useState(1)
	const [weekdays, setWeekdays] = useState(false)
	const [recurrenceEnd, setRecurrenceEnd] = useState<'count' | 'until'>('count')
	const [recurrenceCount, setRecurrenceCount] = useState(10)
	const [recurrenceUntil, setRecurrenceUntil] = useState('')
	const [saving, setSaving] = useState(false)
	const [dirty, setDirty] = useState(false)
	const [error, setError] = useState('')
	const [conflictPending, setConflictPending] = useState(false)
	const [reminderMinutes, setReminderMinutes] = useState('')
	const [reminderVersion, setReminderVersion] = useState(0)
	const [reminderNotice, setReminderNotice] = useState('')
	const [editScope, setEditScope] = useState<'occurrence' | 'following' | 'series'>('series')
	const [allDayTransition, setAllDayTransition] = useState<{ target: boolean; start: string; end: string } | null>(null)
	const selectedList = lists.find(item => item.id === listID)
	const inherited = resolveTaskIdentityColor(null, selectedList?.color)
	const effectiveColor = resolveTaskIdentityColor(color, selectedList?.color).color
	const contrast = taskColorContrast(effectiveColor)
	const editable = !event || event.capabilities.can_edit
	const mark = <T,>(setter: (value: T) => void, value: T) => { setter(value); setDirty(true); setError(''); setConflictPending(false) }

	useEffect(() => {
		if (!open) return
		const recurrence = recurrenceFromEvent(event?.recurrence_rule)
		const recurringOccurrence = Boolean(event?.recurrence_rule && occurrence)
		const initialStart = event?.is_all_day ? occurrence?.start_date || event.start_date || '' : localDateTime(occurrence?.start_at || event?.start_at || draft?.startAt)
		const initialEnd = event?.is_all_day ? inclusiveDateFromExclusive(occurrence?.end_date_exclusive || event.end_date_exclusive) : localDateTime(occurrence?.end_at || event?.end_at || draft?.endAt)
		setTitle(event?.title || draft?.title || '')
		setDescription(event?.description || '')
		setListID(event?.list_id || draft?.listId || defaultListID || lists.find(item => item.is_default)?.id || lists[0]?.id || '')
		commitAllDay(event ? event.is_all_day : Boolean(draft?.allDay))
		setStartAt(initialStart)
		setEndAt(initialEnd)
		setTimezone(event?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Lima')
		setLocation(event?.location || '')
		setMeetingURL(event?.meeting_url || '')
		setAvailability(event?.availability || 'busy')
		setColor(event?.color || null)
		setAttendeeIDs(event?.attendees.filter(item => item.user_id !== currentUserID).map(item => item.user_id) || [])
		setAttendeeCandidate('')
		const ownAttendee = event?.attendees.find(item => item.user_id === currentUserID)
		setReminderMinutes(ownAttendee?.reminder_minutes === undefined ? '' : String(ownAttendee.reminder_minutes))
		setReminderVersion(ownAttendee?.version || 0)
		setReminderNotice('')
		setFrequency(recurrence.frequency)
		setRecurrenceInterval(recurrence.interval)
		setWeekdays(recurrence.weekdays)
		setRecurrenceEnd(recurrence.end as 'count' | 'until')
		setRecurrenceCount(recurrence.count)
		setRecurrenceUntil(recurrence.until)
		setEditScope(recurringOccurrence ? 'occurrence' : 'series')
		setAllDayTransition(null)
		setSaving(false); setDirty(false); setError(''); setConflictPending(false)
	}, [open, event?.id, occurrence?.occurrence_key, draft?.startAt]) // eslint-disable-line react-hooks/exhaustive-deps

	const selectEditScope = (scope: 'occurrence' | 'following' | 'series') => {
		setEditScope(scope); setDirty(true); setError(''); setConflictPending(false)
		if (!event || !occurrence) return
		const sourceStart = scope === 'series' ? (event.is_all_day ? event.start_date : event.start_at) : (event.is_all_day ? occurrence.start_date : occurrence.start_at)
		const sourceEnd = scope === 'series' ? (event.is_all_day ? event.end_date_exclusive : event.end_at) : (event.is_all_day ? occurrence.end_date_exclusive : occurrence.end_at)
		setStartAt(event.is_all_day ? sourceStart || '' : localDateTime(sourceStart))
		setEndAt(event.is_all_day ? inclusiveDateFromExclusive(sourceEnd) : localDateTime(sourceEnd))
	}
	const requestAllDayChange = (target: boolean) => {
		if (target === allDay) return
		if (target) {
			setAllDayTransition({ target, start: startAt.slice(0, 10), end: endAt.slice(0, 10) })
			return
		}
		const day = startAt.slice(0, 10) || new Date().toISOString().slice(0, 10)
		setAllDayTransition({ target, start: `${day}T09:00`, end: `${day}T10:00` })
	}
	const setAllDay = (target: boolean) => requestAllDayChange(target)
	const confirmAllDayChange = () => {
		if (!allDayTransition) return
		if (!allDayTransition.start || !allDayTransition.end || (!allDayTransition.target && new Date(allDayTransition.end) <= new Date(allDayTransition.start))) {
			setError('Indica un inicio y una duración válidos para cambiar el tipo de horario.')
			return
		}
		commitAllDay(allDayTransition.target); setStartAt(allDayTransition.start); setEndAt(allDayTransition.end)
		setAllDayTransition(null); setDirty(true); setError(''); setConflictPending(false)
	}

	const recurrenceRule = useMemo(() => {
		if (!frequency) return ''
		const parts = [`FREQ=${frequency}`, `INTERVAL=${Math.max(1, recurrenceInterval)}`]
		if (frequency === 'WEEKLY' && weekdays) parts.push('BYDAY=MO,TU,WE,TH,FR')
		if (recurrenceEnd === 'count') parts.push(`COUNT=${Math.min(730, Math.max(1, recurrenceCount))}`)
		if (recurrenceEnd === 'until' && recurrenceUntil) parts.push(`UNTIL=${recurrenceUntil.replaceAll('-', '')}`)
		return parts.join(';')
	}, [frequency, recurrenceCount, recurrenceEnd, recurrenceInterval, recurrenceUntil, weekdays])
	const recurrenceValid = !frequency || recurrenceEnd === 'count' || Boolean(recurrenceUntil)

	const requestClose = () => {
		if (saving) return
		if (dirty && !window.confirm('¿Descartar los cambios de este evento?')) return
		onClose()
	}

	const save = async (confirmConflicts = false, cancelOccurrence = false) => {
		if (!editable || saving || !title.trim() || !listID || !startAt || !endAt || !recurrenceValid) return
		setSaving(true); setError('')
		const operationID = crypto.randomUUID()
		const payload = {
			title: title.trim(), description, list_id: listID, location, meeting_url: meetingURL,
			color, availability, is_all_day: allDay, timezone,
			...(allDay ? { start_date: startAt.slice(0, 10), end_date_exclusive: exclusiveDateFromInclusive(endAt) } : { start_at: new Date(startAt).toISOString(), end_at: new Date(endAt).toISOString() }),
			...(editScope === 'occurrence' ? {} : { recurrence_rule: recurrenceRule, attendees: attendeeIDs.map(userID => ({ user_id: userID, attendance_type: 'required' })) }),
			version: event?.version || 0, operation_id: operationID, confirm_conflicts: confirmConflicts,
			...(event?.recurrence_rule && occurrence ? { scope: editScope, occurrence_key: occurrence.occurrence_key, cancel_occurrence: cancelOccurrence } : {}),
		}
		const result = event
			? await apiPut<MutationResponse>(`/api/tasks/events/${event.id}`, payload)
			: await apiPost<MutationResponse>('/api/tasks/events', payload)
		if (!result.success || !result.data?.event) {
			const code = result.data?.code
			if (code === 'schedule_conflict_confirmation_required') {
				setConflictPending(true)
				setError('Este horario se cruza con otro compromiso. Puedes revisar la hora o guardar de todos modos.')
			} else setError(result.error || 'No se pudo guardar el evento')
			setSaving(false)
			return
		}
		setDirty(false); setSaving(false); onSaved(result.data.event); onClose()
	}

	const respond = async (rsvp: 'accepted' | 'tentative' | 'declined') => {
		if (!event?.capabilities.can_respond || saving) return
		setSaving(true); setError('')
		const attendeeVersion = event.attendees.find(attendee => attendee.user_id === currentUserID)?.version || 0
		const result = await apiPost<MutationResponse>(`/api/tasks/events/${event.id}/rsvp`, { rsvp, version: attendeeVersion, operation_id: crypto.randomUUID() })
		setSaving(false)
		if (!result.success || !result.data?.event) { setError(result.error || 'No se pudo guardar tu respuesta'); return }
		onSaved(result.data.event); onClose()
	}

	const saveReminder = async () => {
		if (!event?.capabilities.can_set_reminder || reminderVersion < 1 || saving) return
		setSaving(true); setError(''); setReminderNotice('')
		const result = await apiPut<MutationResponse>(`/api/tasks/events/${event.id}/reminder`, {
			minutes: reminderMinutes === '' ? null : Number(reminderMinutes), version: reminderVersion, operation_id: crypto.randomUUID(),
		})
		setSaving(false)
		if (!result.success || !result.data?.event) { setError(result.error || 'No se pudo guardar tu recordatorio'); return }
		const ownAttendee = result.data.event.attendees.find(attendee => attendee.user_id === currentUserID)
		setReminderVersion(ownAttendee?.version || reminderVersion + 1)
		setReminderMinutes(ownAttendee?.reminder_minutes === undefined ? '' : String(ownAttendee.reminder_minutes))
		setReminderNotice('Recordatorio actualizado')
		onSaved(result.data.event)
	}

	const cancelEvent = async () => {
		if (!event || saving || !window.confirm('¿Cancelar este evento? Las personas invitadas verán la cancelación.')) return
		setSaving(true)
		const result = await apiPost<{ success?: boolean }>(`/api/tasks/events/${event.id}/cancel`, { version: event.version, operation_id: crypto.randomUUID() })
		setSaving(false)
		if (!result.success) { setError(result.error || 'No se pudo cancelar el evento'); return }
		onDeleted?.(event.id); onClose()
	}

	const trashEvent = async () => {
		if (!event || saving || !window.confirm('¿Mover este evento a Papelera?')) return
		setSaving(true)
		const result = await apiDelete<{ success?: boolean }>(`/api/tasks/events/${event.id}`, { version: event.version, operation_id: crypto.randomUUID() })
		setSaving(false)
		if (!result.success) { setError(result.error || 'No se pudo mover el evento a Papelera'); return }
		onDeleted?.(event.id); onClose()
	}

	return <TaskWorkWindowShell open={open} storageKey="clarin:tasks:event-window" storageScope={storageScope} title={event ? event.title : 'Nuevo evento'} eyebrow="Clarin Work · Evento" description={event?.list_visible ? event.list_name : event ? 'Invitación compartida contigo' : 'Reserva tiempo y coordina al equipo'} icon={CalendarDays} busy={saving} onRequestClose={requestClose} defaultWidth={900} defaultHeight={780} minWidth={540} minHeight={520} footer={<div className="flex flex-wrap items-center gap-2"><div className="mr-auto flex gap-2">{event?.recurrence_rule && occurrence && editScope === 'occurrence' && event.capabilities.can_cancel && <button type="button" onClick={() => void save(false, true)} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-amber-200 px-3 text-xs font-bold text-amber-700 hover:bg-amber-50"><X className="h-4 w-4" />Cancelar esta ocurrencia</button>}{event?.capabilities.can_cancel && event.status !== 'cancelled' && !(event.recurrence_rule && occurrence && editScope === 'occurrence') && <button type="button" onClick={() => void cancelEvent()} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-amber-200 px-3 text-xs font-bold text-amber-700 hover:bg-amber-50"><X className="h-4 w-4" />Cancelar evento</button>}{event?.capabilities.can_trash && <button type="button" onClick={() => void trashEvent()} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-rose-200 px-3 text-xs font-bold text-rose-700 hover:bg-rose-50"><Trash2 className="h-4 w-4" />Papelera</button>}</div><button type="button" onClick={requestClose} className="min-h-11 rounded-xl px-4 text-sm font-bold text-slate-600 hover:bg-slate-100">Cerrar</button>{editable && conflictPending && <button type="button" disabled={saving} onClick={() => void save(true)} className="min-h-11 rounded-xl bg-amber-500 px-4 text-sm font-black text-white hover:bg-amber-600">Guardar de todos modos</button>}{editable && <button type="button" disabled={saving || !title.trim() || !listID || !startAt || !endAt || !recurrenceValid} onClick={() => void save(false)} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-5 text-sm font-black text-white shadow-lg shadow-emerald-100 hover:bg-emerald-700 disabled:opacity-40">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{event ? 'Guardar' : 'Crear evento'}</button>}</div>}>
		<div className="mx-auto w-full max-w-4xl space-y-5 p-4 sm:p-6">
			{event?.capabilities.can_respond && <section className="rounded-2xl border border-sky-200 bg-sky-50 p-4"><p className="text-xs font-black text-sky-900">¿Asistirás a este evento?</p><p className="mt-1 text-xs text-sky-700">Tu respuesta es independiente del estado del evento y sólo afecta tu disponibilidad.</p><div className="mt-3 flex flex-wrap gap-2">{([['accepted', 'Sí'], ['tentative', 'Quizá'], ['declined', 'No']] as const).map(([value, label]) => <button key={value} type="button" disabled={saving} onClick={() => void respond(value)} aria-pressed={event.actor_rsvp === value} className={`min-h-10 rounded-xl border px-4 text-xs font-black ${event.actor_rsvp === value ? 'border-sky-500 bg-sky-600 text-white' : 'border-sky-200 bg-white text-sky-800 hover:border-sky-400'}`}>{label}</button>)}</div></section>}
			{event?.capabilities.can_set_reminder && <section className="rounded-2xl border border-amber-200 bg-amber-50/70 p-4"><div className="flex flex-wrap items-end gap-3"><div className="min-w-[220px] flex-1"><p className="text-xs font-black text-amber-950">Tu recordatorio</p>{event.is_all_day ? <p className="mt-1 text-xs text-amber-700">09:00 del día anterior, según la zona horaria del evento.</p> : <select value={reminderMinutes} onChange={input => { setReminderMinutes(input.target.value); setReminderNotice('') }} className="mt-2 min-h-11 w-full rounded-xl border border-amber-200 bg-white px-3 text-sm text-slate-700"><option value="">Predeterminado · 15 minutos antes</option><option value="0">Al comenzar</option><option value="5">5 minutos antes</option><option value="10">10 minutos antes</option><option value="15">15 minutos antes</option><option value="30">30 minutos antes</option><option value="60">1 hora antes</option><option value="1440">1 día antes</option></select>}{reminderNotice && <p role="status" className="mt-1 text-[10px] font-bold text-emerald-700">{reminderNotice}</p>}</div>{!event.is_all_day && <button type="button" disabled={saving || reminderVersion < 1} onClick={() => void saveReminder()} className="min-h-11 rounded-xl border border-amber-300 bg-white px-4 text-xs font-black text-amber-800 hover:bg-amber-100 disabled:opacity-40">Guardar recordatorio</button>}</div></section>}
			{!editable && <div role="status" className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs font-semibold text-slate-600">Tienes acceso a esta invitación, pero no a la edición del evento ni a su lista.</div>}
			{editable && event?.recurrence_rule && occurrence && <section className="rounded-2xl border border-violet-200 bg-violet-50/70 p-4"><p className="text-xs font-black text-violet-900">Aplicar cambios a</p><div className="mt-3 grid gap-2 sm:grid-cols-3">{([['occurrence', 'Esta ocurrencia'], ['following', 'Ésta y siguientes'], ['series', 'Toda la serie']] as const).map(([value, label]) => <button key={value} type="button" onClick={() => selectEditScope(value)} aria-pressed={editScope === value} className={`min-h-11 rounded-xl border px-3 text-xs font-black ${editScope === value ? 'border-violet-500 bg-violet-600 text-white' : 'border-violet-200 bg-white text-violet-800 hover:border-violet-400'}`}>{label}</button>)}</div><p className="mt-2 text-[10px] leading-4 text-violet-700">“Ésta y siguientes” crea una nueva serie y conserva intacto el historial anterior.</p></section>}
			<fieldset disabled={!editable} className="contents disabled:opacity-70">
			<div className="grid gap-4 rounded-2xl border border-slate-200 bg-white p-4 sm:grid-cols-[1fr_220px]"><div><label className="text-[10px] font-black uppercase tracking-[.14em] text-slate-400">Título</label><input autoFocus value={title} onChange={input => mark(setTitle, input.target.value)} placeholder="Nombre del evento" className="mt-2 w-full border-0 p-0 text-xl font-black text-slate-900 outline-none placeholder:text-slate-300" /></div><div className="flex items-center gap-3 rounded-2xl px-3 py-2" style={{ backgroundColor: `${effectiveColor}18`, color: contrast.textColor }}><span className="h-9 w-9 shrink-0 rounded-xl border-2 border-white shadow" style={{ backgroundColor: effectiveColor }} /><div className="min-w-0"><p className="truncate text-xs font-black" style={{ color: effectiveColor }}>{color ? 'Color del evento' : 'Heredado de la lista'}</p><p className="text-[10px] text-slate-500">{effectiveColor}</p></div></div></div>
			<div className="grid gap-4 lg:grid-cols-[1.25fr_.75fr]"><section className="space-y-4 rounded-2xl border border-slate-200 p-4"><div className="grid gap-3 sm:grid-cols-2"><TaskDateTimePicker label="Comienza" value={startAt} onChange={value => mark(setStartAt, value)} allDay={allDay} onAllDayChange={value => mark(setAllDay, value)} /><TaskDateTimePicker label={allDay ? 'Último día incluido' : 'Termina'} value={endAt} min={startAt} onChange={value => mark(setEndAt, value)} allDay={allDay} onAllDayChange={value => mark(setAllDay, value)} /></div><div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1.5 text-xs font-bold text-slate-600"><span className="flex items-center gap-2"><Clock3 className="h-4 w-4 text-slate-400" />Zona horaria</span><select value={timezone} onChange={input => mark(setTimezone, input.target.value)} className="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-emerald-400"><option>America/Lima</option><option>America/Bogota</option><option>America/Mexico_City</option><option>America/New_York</option><option>Europe/Madrid</option><option>UTC</option></select></label><label className="space-y-1.5 text-xs font-bold text-slate-600"><span>Disponibilidad</span><select value={availability} onChange={input => mark(setAvailability, input.target.value as 'busy' | 'free')} className="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-emerald-400"><option value="busy">Ocupado</option><option value="free">Libre</option></select></label></div><label className="block"><span className="text-xs font-bold text-slate-600">Descripción</span><textarea value={description} onChange={input => mark(setDescription, input.target.value)} rows={5} placeholder="Objetivo, agenda o información útil…" className="mt-1.5 w-full resize-y rounded-2xl border border-slate-200 px-3 py-3 text-sm outline-none focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100" /></label><div className="grid gap-3 sm:grid-cols-2"><label className="relative"><span className="text-xs font-bold text-slate-600">Ubicación</span><MapPin className="absolute bottom-3 left-3 h-4 w-4 text-slate-400" /><input value={location} onChange={input => mark(setLocation, input.target.value)} className="mt-1.5 min-h-11 w-full rounded-xl border border-slate-200 pl-10 pr-3 text-sm outline-none focus:border-emerald-400" /></label><label className="relative"><span className="text-xs font-bold text-slate-600">Enlace de reunión</span><Link2 className="absolute bottom-3 left-3 h-4 w-4 text-slate-400" /><input value={meetingURL} onChange={input => mark(setMeetingURL, input.target.value)} placeholder="https://…" className="mt-1.5 min-h-11 w-full rounded-xl border border-slate-200 pl-10 pr-3 text-sm outline-none focus:border-emerald-400" /></label></div></section>
				<aside className="space-y-4"><section className="rounded-2xl border border-slate-200 p-4"><p className="text-[10px] font-black uppercase tracking-[.14em] text-slate-400">Organización</p><div className="mt-3"><TaskListPicker value={listID} lists={lists} folders={folders} onChange={value => mark(setListID, value)} /></div><div className="mt-3"><button type="button" onClick={() => mark(setColor, null)} className={`mb-2 flex min-h-11 w-full items-center gap-3 rounded-xl border px-3 text-left ${color === null ? 'border-emerald-300 bg-emerald-50' : 'border-slate-200'}`}><span className="h-7 w-7 rounded-lg border-2 border-white shadow" style={{ backgroundColor: inherited.color }} /><span className="min-w-0 flex-1"><span className="block text-xs font-bold text-slate-700">Heredar de la lista</span><span className="block truncate text-[10px] text-slate-400">{selectedList?.name || 'Color predeterminado'}</span></span>{color === null && <Check className="h-4 w-4 text-emerald-600" />}</button><TaskColorPicker value={effectiveColor} onChange={value => mark(setColor, value)} label="Color del evento" /></div></section>
				<fieldset disabled={editScope === 'occurrence'} className="rounded-2xl border border-slate-200 p-4 disabled:opacity-55">
					<p className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[.14em] text-slate-400"><Repeat2 className="h-4 w-4" />Repetición</p>
					<select value={frequency} onChange={input => mark(setFrequency, input.target.value)} className="mt-3 min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm"><option value="">No se repite</option><option value="DAILY">Cada día</option><option value="WEEKLY">Cada semana</option><option value="MONTHLY">Cada mes</option><option value="YEARLY">Cada año</option></select>
					{frequency && <div className="mt-3 space-y-3"><label className="flex items-center gap-2 text-xs font-semibold text-slate-600">Cada <input type="number" min={1} max={365} value={recurrenceInterval} onChange={input => mark(setRecurrenceInterval, Number(input.target.value))} className="h-9 w-16 rounded-lg border border-slate-200 px-2" /> intervalo(s)</label>{frequency === 'WEEKLY' && <label className="flex items-center gap-2 text-xs font-semibold text-slate-600"><input type="checkbox" checked={weekdays} onChange={input => mark(setWeekdays, input.target.checked)} />Sólo días laborables</label>}<select value={recurrenceEnd} onChange={input => mark(setRecurrenceEnd, input.target.value as 'count' | 'until')} className="min-h-10 w-full rounded-xl border border-slate-200 px-3 text-xs"><option value="count">Después de ocurrencias</option><option value="until">Hasta una fecha</option></select>{recurrenceEnd === 'count' && <input type="number" min={1} max={730} value={recurrenceCount} onChange={input => mark(setRecurrenceCount, Number(input.target.value))} className="min-h-10 w-full rounded-xl border border-slate-200 px-3 text-sm" />}{recurrenceEnd === 'until' && <input type="date" required value={recurrenceUntil} onChange={input => mark(setRecurrenceUntil, input.target.value)} className="min-h-10 w-full rounded-xl border border-slate-200 px-3 text-sm" />}</div>}
				</fieldset>
				<fieldset disabled={editScope === 'occurrence'} className="rounded-2xl border border-slate-200 p-4 disabled:opacity-55"><p className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[.14em] text-slate-400"><UserPlus className="h-4 w-4" />Personas invitadas</p><div className="mt-3 flex flex-wrap gap-2">{attendeeIDs.map(id => { const user = users.find(item => item.id === id); return <span key={id} className="inline-flex min-h-9 items-center gap-2 rounded-full bg-slate-100 pl-3 pr-1 text-xs font-bold text-slate-600">{user?.display_name || user?.username || 'Usuario'}<button type="button" aria-label="Quitar invitado" onClick={() => mark(setAttendeeIDs, attendeeIDs.filter(item => item !== id))} className="flex h-7 w-7 items-center justify-center rounded-full hover:bg-white"><X className="h-3.5 w-3.5" /></button></span> })}</div><div className="mt-3"><TaskUserCombobox users={users} value={attendeeCandidate} excludeIds={[currentUserID, ...attendeeIDs]} allowClear placeholder="Añadir persona…" onChange={id => { if (id) mark(setAttendeeIDs, [...attendeeIDs, id]); setAttendeeCandidate('') }} /></div></fieldset></aside>
			</div>
			</fieldset>
			{allDayTransition && <div className="fixed inset-0 z-[190] flex items-center justify-center bg-slate-950/35 p-4 backdrop-blur-sm"><div role="dialog" aria-modal="true" aria-labelledby="event-time-conversion-title" className="w-full max-w-md rounded-3xl bg-white p-5 shadow-2xl"><p className="text-[10px] font-black uppercase tracking-[.14em] text-amber-600">Confirmar cambio de horario</p><h3 id="event-time-conversion-title" className="mt-1 text-lg font-black text-slate-900">{allDayTransition.target ? 'Convertir en evento de todo el día' : 'Asignar hora y duración'}</h3><p className="mt-2 text-sm leading-6 text-slate-500">{allDayTransition.target ? 'Se conservarán los días elegidos y se quitarán las horas.' : 'Un evento de todo el día necesita una hora inicial y final explícitas antes de convertirse.'}</p><div className="mt-4 grid gap-3 sm:grid-cols-2"><label className="text-xs font-bold text-slate-600">{allDayTransition.target ? 'Primer día' : 'Comienza'}<input type={allDayTransition.target ? 'date' : 'datetime-local'} value={allDayTransition.start} onChange={input => setAllDayTransition(current => current ? { ...current, start: input.target.value } : null)} className="mt-1.5 min-h-11 w-full rounded-xl border border-slate-200 px-3 text-sm" /></label><label className="text-xs font-bold text-slate-600">{allDayTransition.target ? 'Último día incluido' : 'Termina'}<input type={allDayTransition.target ? 'date' : 'datetime-local'} value={allDayTransition.end} min={allDayTransition.start} onChange={input => setAllDayTransition(current => current ? { ...current, end: input.target.value } : null)} className="mt-1.5 min-h-11 w-full rounded-xl border border-slate-200 px-3 text-sm" /></label></div><div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setAllDayTransition(null)} className="min-h-11 rounded-xl px-4 text-sm font-bold text-slate-600 hover:bg-slate-100">Cancelar</button><button type="button" onClick={confirmAllDayChange} className="min-h-11 rounded-xl bg-emerald-600 px-4 text-sm font-black text-white">Confirmar cambio</button></div></div></div>}
			{event?.status === 'cancelled' && <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700">Evento cancelado · se conserva como historial.</div>}
			{error && <div role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">{error}</div>}
		</div>
	</TaskWorkWindowShell>
}
