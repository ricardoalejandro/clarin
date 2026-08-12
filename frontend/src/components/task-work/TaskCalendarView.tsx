'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, Clock3, Loader2, Plus, RefreshCw, X } from 'lucide-react'
import { apiGet, apiPost, apiPut, subscribeWebSocket } from '@/lib/api'
import type { AgendaItem, Task, TaskAgendaResponse, TaskFolder, TaskList, TaskWorkflowStatus, WorkEvent, WorkEventOccurrence } from '@/types/task'
import type { TaskAccountUser } from './TaskEditorModal'
import type { TaskInlineDraft } from './TaskBoard'
import { TaskListPicker } from './TaskSelectPicker'
import TaskUserCombobox from './TaskUserCombobox'
import { calendarDefaultList, calendarSlot, type TaskCalendarMode } from './taskCalendarState'
import type { TaskHierarchyCounts } from './taskHierarchyCounts'
import { agendaItemInterval, agendaItemOverlapsDay, layoutTimedAgendaItems } from './calendarAgendaLayout'
import { taskColorContrast } from './TaskContainerAppearance'
import { resolveTaskIdentityColor } from './taskIdentityColor'
import WorkEventEditor, { type WorkEventDraft } from './WorkEventEditor'

interface Props {
	lists: TaskList[]
	folders: TaskFolder[]
	statuses: TaskWorkflowStatus[]
	users: TaskAccountUser[]
	currentUserID: string
	environmentID?: string
	scopeFolderID?: string
	scopeListID?: string
	storageScope?: string
	createEventToken?: number
	focusEvent?: WorkEventOccurrence | null
	onOpen: (task: Task) => void
	onCreated: (task: Task, operationID: string, hierarchyCounts?: TaskHierarchyCounts) => void
	onOperation: (operationID: string, active: boolean) => void
	onMore: (statusID?: string, draft?: TaskInlineDraft) => void
	canCreate?: boolean
}

type Composer = { startAt: string; dueAt: string; allDay: boolean; type: 'event' | 'task' }
const hours = Array.from({ length: 24 }, (_, index) => index)
const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
const startOfDay = (date: Date) => { const next = new Date(date); next.setHours(0, 0, 0, 0); return next }
const addDays = (date: Date, days: number) => { const next = new Date(date); next.setDate(next.getDate() + days); return next }
const eventTitle = (item: AgendaItem) => item.kind === 'task' ? item.task.title : item.event.event.title
const eventColor = (item: AgendaItem, lists: TaskList[]) => {
	if (item.kind === 'task') return item.task.resolved_color || resolveTaskIdentityColor(item.task.color, lists.find(list => list.id === item.task.list_id)?.color).color
	return item.event.event.resolved_color || resolveTaskIdentityColor(item.event.event.color, lists.find(list => list.id === item.event.event.list_id)?.color).color
}

function itemTime(item: AgendaItem) {
	const interval = agendaItemInterval(item)
	if (!interval || interval.allDay) return ''
	return interval.start.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
}

function AgendaBlock({ item, lists, compact = false, onOpen, onReschedule, style }: { item: AgendaItem; lists: TaskList[]; compact?: boolean; onOpen: () => void; onReschedule?: (occurrence: WorkEventOccurrence, start: Date, end: Date) => void; style?: CSSProperties }) {
	const color = eventColor(item, lists)
	const contrast = taskColorContrast(color)
	const cancelled = item.kind === 'event' && item.event.event.status === 'cancelled'
	const overdue = item.kind === 'task' && Boolean(item.task.due_at && new Date(item.task.due_at) < new Date() && item.task.status_detail?.category !== 'done')
	const dragRef = useRef<{ y: number; mode: 'move' | 'resize' } | null>(null)
	const suppressOpenRef = useRef(false)
	const draggable = !compact && item.kind === 'event' && item.event.event.capabilities.can_edit && Boolean(item.event.start_at && item.event.end_at) && Boolean(onReschedule)
	return <button type="button" onClick={event => { event.stopPropagation(); if (suppressOpenRef.current) { suppressOpenRef.current = false; return }; onOpen() }} onPointerDown={event => { if (!draggable || event.pointerType === 'touch') return; dragRef.current = { y: event.clientY, mode: (event.target as HTMLElement).closest('[data-event-resize]') ? 'resize' : 'move' }; event.currentTarget.setPointerCapture(event.pointerId) }} onPointerUp={event => { const drag = dragRef.current; dragRef.current = null; if (!drag || item.kind !== 'event' || !item.event.start_at || !item.event.end_at) return; const delta = Math.round((event.clientY - drag.y) / 15) * 15; if (!delta) return; suppressOpenRef.current = true; const start = new Date(item.event.start_at); const end = new Date(item.event.end_at); if (drag.mode === 'move') { start.setMinutes(start.getMinutes() + delta); end.setMinutes(end.getMinutes() + delta) } else end.setTime(Math.max(start.getTime() + 15 * 60_000, end.getTime() + delta * 60_000)); onReschedule?.(item.event, start, end) }} title={eventTitle(item)} style={{ backgroundColor: color, color: contrast.textColor, ...style }} className={`group/item flex min-w-0 items-center gap-1.5 overflow-hidden rounded-md px-1.5 text-left font-bold shadow-sm ring-1 ring-black/5 transition hover:brightness-95 focus:outline-none focus:ring-2 focus:ring-slate-900/40 ${compact ? 'min-h-5 text-[10px]' : 'min-h-7 text-[11px]'} ${cancelled ? 'opacity-55 line-through' : ''} ${overdue ? 'border-l-[3px] border-rose-600' : ''} ${draggable ? 'cursor-grab active:cursor-grabbing' : ''}`}>
		{item.kind === 'event' ? <CalendarDays className="h-3 w-3 shrink-0" aria-label="Evento" /> : item.task.status_detail?.category === 'done' ? <CheckCircle2 className="h-3 w-3 shrink-0" aria-label="Completada" /> : overdue ? <AlertTriangle className="h-3 w-3 shrink-0" aria-label="Atrasada" /> : <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-80" aria-label={item.task.status_detail?.name || 'Tarea'} />}
		<span className="min-w-0 flex-1 truncate">{itemTime(item) && !compact ? `${itemTime(item)} · ` : ''}{eventTitle(item)}</span>
		{item.kind === 'event' && item.event.event.availability === 'free' && <span className="shrink-0 rounded bg-white/30 px-1 text-[8px] uppercase">Libre</span>}
		{draggable && <span data-event-resize className="absolute inset-x-1 bottom-0 h-1 cursor-ns-resize rounded-full bg-current opacity-0 transition group-hover/item:opacity-40" aria-label="Cambiar duración" />}
	</button>
}

function CalendarMorePopover({ anchor, items, lists, day, onOpen, onClose }: { anchor: DOMRect; items: AgendaItem[]; lists: TaskList[]; day: Date; onOpen: (item: AgendaItem) => void; onClose: () => void }) {
	if (typeof document === 'undefined') return null
	const width = Math.min(340, window.innerWidth - 24)
	const left = Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12))
	const top = Math.max(12, Math.min(anchor.bottom + 6, window.innerHeight - Math.min(430, items.length * 34 + 92)))
	return createPortal(<><button type="button" aria-label="Cerrar eventos del día" onMouseDown={onClose} className="fixed inset-0 z-[105] cursor-default" /><section role="dialog" aria-label={`Agenda del ${day.toLocaleDateString('es', { dateStyle: 'long' })}`} style={{ left, top, width }} className="fixed z-[106] max-h-[420px] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"><header className="flex items-center justify-between border-b border-slate-100 px-4 py-3"><div><p className="text-[10px] font-black uppercase tracking-[.14em] text-emerald-600">{day.toLocaleDateString('es', { weekday: 'long' })}</p><p className="text-sm font-black text-slate-900">{day.toLocaleDateString('es', { day: 'numeric', month: 'long' })}</p></div><button type="button" onClick={onClose} className="rounded-xl p-2 text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button></header><div className="space-y-1.5 overflow-y-auto p-3">{items.map(item => <AgendaBlock key={item.key} item={item} lists={lists} onOpen={() => { onOpen(item); onClose() }} />)}</div></section></>, document.body)
}

export default function TaskCalendarView({ lists, folders, statuses, users, currentUserID, environmentID, scopeFolderID, scopeListID, storageScope, createEventToken = 0, focusEvent, onOpen, onCreated, onOperation, onMore, canCreate = true }: Props) {
	const [mode, setMode] = useState<TaskCalendarMode>('month')
	const [cursor, setCursor] = useState(new Date())
	const [items, setItems] = useState<AgendaItem[]>([])
	const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
	const [loadError, setLoadError] = useState('')
	const [rangeNotice, setRangeNotice] = useState('')
	const [mutationError, setMutationError] = useState('')
	const [scheduleConflict, setScheduleConflict] = useState<{ occurrence: WorkEventOccurrence; start: Date; end: Date } | null>(null)
	const [composer, setComposer] = useState<Composer | null>(null)
	const [title, setTitle] = useState('')
	const [lastListID, setLastListID] = useState('')
	const [listID, setListID] = useState(() => calendarDefaultList(scopeListID, '', lists.map(list => list.id)))
	const [ownerID, setOwnerID] = useState(currentUserID)
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState('')
	const [quickConflict, setQuickConflict] = useState(false)
	const [eventEditorOpen, setEventEditorOpen] = useState(false)
	const [editingEvent, setEditingEvent] = useState<WorkEvent | null>(null)
	const [editingOccurrence, setEditingOccurrence] = useState<WorkEventOccurrence | null>(null)
	const [eventDraft, setEventDraft] = useState<WorkEventDraft | null>(null)
	const [morePopover, setMorePopover] = useState<{ anchor: DOMRect; items: AgendaItem[]; day: Date } | null>(null)
	const [width, setWidth] = useState(1000)
	const containerRef = useRef<HTMLDivElement>(null)
	const scrollRef = useRef<HTMLDivElement>(null)
	const loadAbortRef = useRef<AbortController | null>(null)
	const loadGeneration = useRef(0)
	const previousCreateToken = useRef(0)
	const folderByID = useMemo(() => new Map(folders.map(folder => [folder.id, folder])), [folders])
	const effectiveMode: TaskCalendarMode = mode === 'week' && width < 700 ? 'day' : mode

	const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
	const gridStart = new Date(first); gridStart.setDate(1 - ((first.getDay() + 6) % 7)); gridStart.setHours(0, 0, 0, 0)
	const monthDays = Array.from({ length: 42 }, (_, index) => addDays(gridStart, index))
	const weekStart = new Date(cursor); weekStart.setDate(cursor.getDate() - ((cursor.getDay() + 6) % 7)); weekStart.setHours(0, 0, 0, 0)
	const weekDays = Array.from({ length: 7 }, (_, index) => addDays(weekStart, index))
	const visibleDays = effectiveMode === 'week' ? weekDays : [startOfDay(cursor)]
	const range = useMemo(() => {
		if (mode === 'month') return { from: gridStart, to: addDays(gridStart, 42) }
		if (mode === 'week') return { from: weekStart, to: addDays(weekStart, 7) }
		const from = startOfDay(cursor); return { from, to: addDays(from, 1) }
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [cursor, mode])

	useEffect(() => {
		const node = containerRef.current
		if (!node) return
		const observer = new ResizeObserver(entries => setWidth(entries[0]?.contentRect.width || node.clientWidth))
		observer.observe(node); setWidth(node.clientWidth)
		return () => observer.disconnect()
	}, [])

	const loadAgenda = useCallback(async () => {
		loadAbortRef.current?.abort()
		const controller = new AbortController(); loadAbortRef.current = controller
		const generation = ++loadGeneration.current
		setPhase(current => current === 'ready' ? 'ready' : 'loading'); setLoadError('')
		const params = new URLSearchParams({ from: range.from.toISOString(), to: range.to.toISOString(), sources: 'tasks,events', limit: '200' })
		if (environmentID) params.set('environment_id', environmentID)
		if (scopeFolderID) params.set('folder_id', scopeFolderID)
		if (scopeListID) params.set('list_id', scopeListID)
		const loaded: AgendaItem[] = []
		let nextCursor = ''
		setRangeNotice('')
		for (let page = 0; page < 10; page++) {
			if (nextCursor) params.set('cursor', nextCursor); else params.delete('cursor')
			const result = await apiGet<TaskAgendaResponse>(`/api/tasks/agenda?${params}`, { signal: controller.signal })
			if (generation !== loadGeneration.current || controller.signal.aborted) return
			if (!result.success || !result.data?.items) {
				setPhase('error'); setLoadError(result.error || 'No se pudo cargar este rango')
				return
			}
			loaded.push(...result.data.items)
			nextCursor = result.data.next_cursor || ''
			if (!nextCursor) break
			if (page === 9) setRangeNotice('Este rango contiene más de 2.000 elementos. Acota el Entorno, carpeta o lista para verlos todos.')
		}
		setItems(Array.from(new Map(loaded.map(item => [item.key, item])).values())); setPhase('ready')
	}, [environmentID, range.from.getTime(), range.to.getTime(), scopeFolderID, scopeListID]) // eslint-disable-line react-hooks/exhaustive-deps

	useEffect(() => { void loadAgenda(); return () => loadAbortRef.current?.abort() }, [loadAgenda])
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | null = null
		const unsubscribe = subscribeWebSocket((raw: unknown) => {
			const envelope = raw as { event?: string }
			if (!['work_event_update', 'work_event_invitation', 'work_event_rsvp'].includes(envelope.event || '')) return
			if (timer) clearTimeout(timer)
			timer = setTimeout(() => { void loadAgenda() }, 100)
		})
		return () => { if (timer) clearTimeout(timer); unsubscribe() }
	}, [loadAgenda])
	const rescheduleEvent = async (occurrence: WorkEventOccurrence, start: Date, end: Date, confirmConflicts = false) => {
		const event = occurrence.event
		if (!event.capabilities.can_edit || !event.list_id) return
		const snapshot = items
		setMutationError(''); setScheduleConflict(null)
		setItems(current => current.map(item => item.kind === 'event' && item.key === `event:${event.id}:${occurrence.occurrence_key}`
			? { ...item, event: { ...item.event, start_at: start.toISOString(), end_at: end.toISOString() } }
			: item))
		const operationID = crypto.randomUUID()
		const recurring = Boolean(event.recurrence_rule)
		const result = await apiPut<{ event?: WorkEvent; code?: string }>(`/api/tasks/events/${event.id}`, {
			title: event.title, description: event.description || '', list_id: event.list_id, location: event.location || '', meeting_url: event.meeting_url || '',
			color: event.color || null, availability: event.availability, is_all_day: false, timezone: event.timezone,
			start_at: start.toISOString(), end_at: end.toISOString(), version: event.version, operation_id: operationID, confirm_conflicts: confirmConflicts,
			...(recurring ? { scope: 'occurrence', occurrence_key: occurrence.occurrence_key } : { scope: 'series', recurrence_rule: '', attendees: event.attendees.filter(attendee => attendee.user_id !== event.organizer_id).map(attendee => ({ user_id: attendee.user_id, attendance_type: attendee.attendance_type })) }),
		})
		if (!result.success || !result.data?.event) {
			setItems(snapshot)
			if (result.data?.code === 'schedule_conflict_confirmation_required') {
				setScheduleConflict({ occurrence, start, end }); setMutationError('El nuevo horario se cruza con otro compromiso.')
			} else setMutationError(result.error || 'No se pudo guardar el cambio; restauramos el horario anterior.')
			return
		}
		await loadAgenda()
	}
	useEffect(() => {
		if (effectiveMode !== 'month' && scrollRef.current) requestAnimationFrame(() => { if (scrollRef.current) scrollRef.current.scrollTop = 7 * 60 - 20 })
	}, [effectiveMode])
	useEffect(() => {
		if (createEventToken === previousCreateToken.current) return
		previousCreateToken.current = createEventToken
		const start = new Date(); start.setMinutes(Math.ceil(start.getMinutes() / 30) * 30, 0, 0)
		setEditingEvent(null); setEditingOccurrence(null); setEventDraft({ startAt: start.toISOString(), endAt: new Date(start.getTime() + 60 * 60_000).toISOString(), allDay: false, listId: scopeListID }); setEventEditorOpen(true)
	}, [createEventToken, scopeListID])
	useEffect(() => {
		if (!focusEvent) return
		setCursor(new Date(focusEvent.start_at || `${focusEvent.start_date}T12:00:00`))
		setEditingEvent(focusEvent.event); setEditingOccurrence(focusEvent); setEventDraft(null); setEventEditorOpen(true)
	}, [focusEvent?.event.id, focusEvent?.occurrence_key]) // eslint-disable-line react-hooks/exhaustive-deps

	const dayItems = (day: Date) => items.filter(item => agendaItemOverlapsDay(item, day))
	const move = (direction: number) => setCursor(value => { const next = new Date(value); if (mode === 'month') next.setMonth(next.getMonth() + direction); else if (mode === 'week') next.setDate(next.getDate() + direction * 7); else next.setDate(next.getDate() + direction); return next })
	const openComposer = (date: Date, hour?: number, endHour?: number) => {
		if (!canCreate) return
		const slot = calendarSlot(date, hour)
		if (hour !== undefined && endHour !== undefined) slot.dueAt = new Date(new Date(slot.startAt).setHours(endHour)).toISOString()
		setComposer({ ...slot, type: 'event' }); setListID(calendarDefaultList(scopeListID, lastListID, lists.map(list => list.id)))
		setOwnerID(currentUserID || users[0]?.id || ''); setTitle(''); setError(''); setQuickConflict(false)
	}
	const closeComposer = () => { setComposer(null); setTitle(''); setError(''); setQuickConflict(false) }
	const selectedList = lists.find(list => list.id === listID)
	const status = statuses.find(item => item.workflow_id === selectedList?.workflow_id && item.category === 'not_started')
	const createQuick = async (confirmConflicts = false) => {
		if (!canCreate || !composer || !title.trim() || !selectedList || saving) return
		setSaving(true); setError(''); if (!confirmConflicts) setQuickConflict(false)
		const operationID = crypto.randomUUID(); onOperation(operationID, true)
		try {
			if (composer.type === 'task') {
				if (!status || !ownerID) return
				const result = await apiPost<{ task: Task; operation_id?: string; hierarchy_counts?: TaskHierarchyCounts }>('/api/tasks', { title: title.trim(), description: '', type: 'reminder', priority: 'medium', assigned_to: ownerID, list_id: listID, status_id: status.id, start_at: composer.startAt, due_at: composer.dueAt, is_all_day: composer.allDay, recurrence_rule: '', reminder_minutes: 0, placement: 'top', operation_id: operationID })
				if (!result.success || !result.data?.task) { setError(result.error || 'No se pudo crear la tarea'); return }
				onCreated(result.data.task, result.data.operation_id || operationID, result.data.hierarchy_counts)
			} else {
				const start = new Date(composer.startAt); const end = new Date(composer.dueAt)
				const result = await apiPost<{ event?: WorkEvent; code?: string }>('/api/tasks/events', { title: title.trim(), description: '', list_id: listID, availability: 'busy', is_all_day: composer.allDay, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Lima', recurrence_rule: '', attendees: [], color: null, operation_id: operationID, confirm_conflicts: confirmConflicts, ...(composer.allDay ? { start_date: dateKey(start), end_date_exclusive: dateKey(addDays(start, 1)) } : { start_at: start.toISOString(), end_at: end.toISOString() }) })
				if (!result.success || !result.data?.event) {
					if (result.data?.code === 'schedule_conflict_confirmation_required') { setQuickConflict(true); setError('Este horario se cruza con otro compromiso. Revisa la hora o guarda de todos modos.'); return }
					setError(result.error || 'No se pudo crear el evento'); return
				}
			}
			setLastListID(listID); closeComposer(); await loadAgenda()
		} finally { setSaving(false); onOperation(operationID, false) }
	}
	const more = () => {
		if (!canCreate || !composer) return
		if (composer.type === 'task') onMore(status?.id, { title, listId: listID, statusId: status?.id || '', ownerId: ownerID, dueDate: composer.dueAt.slice(0, 10), priority: 'medium', startAt: composer.startAt, dueAt: composer.dueAt, isAllDay: composer.allDay })
		else { setEditingEvent(null); setEditingOccurrence(null); setEventDraft({ title, listId: listID, startAt: composer.startAt, endAt: composer.dueAt, allDay: composer.allDay }); setEventEditorOpen(true) }
		closeComposer()
	}
	const openItem = (item: AgendaItem) => {
		if (item.kind === 'task') onOpen(item.task)
		else { setEditingEvent(item.event.event); setEditingOccurrence(item.event); setEventDraft(null); setEventEditorOpen(true) }
	}

	const currentTimeTop = (() => { const now = new Date(); return (now.getHours() * 60 + now.getMinutes()) })()
	return <div ref={containerRef} data-task-calendar className="relative flex h-full min-h-0 flex-col overflow-hidden border-y border-slate-200 bg-white">
		<header className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2 sm:px-4"><button onClick={() => move(-1)} aria-label="Periodo anterior" className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100"><ChevronLeft className="h-4 w-4" /></button><button onClick={() => setCursor(new Date())} className="min-h-11 rounded-xl border border-slate-200 px-3 text-xs font-bold text-slate-600">Hoy</button><button onClick={() => move(1)} aria-label="Periodo siguiente" className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100"><ChevronRight className="h-4 w-4" /></button><div className="ml-1 min-w-0"><h3 className="truncate text-sm font-black capitalize text-slate-800">{cursor.toLocaleDateString('es', mode === 'month' ? { month: 'long', year: 'numeric' } : { day: 'numeric', month: 'long', year: 'numeric' })}</h3><p className="hidden text-[10px] font-semibold text-slate-400 sm:block">Tareas, proyectos y eventos</p></div><div className="ml-auto flex rounded-xl bg-slate-100 p-1">{(['month', 'week', 'day'] as TaskCalendarMode[]).map(item => <button key={item} onClick={() => setMode(item)} aria-pressed={mode === item} className={`min-h-9 rounded-lg px-3 text-[11px] font-bold ${mode === item ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-400'}`}>{item === 'month' ? 'Mes' : item === 'week' ? 'Semana' : 'Día'}</button>)}</div><button type="button" onClick={() => void loadAgenda()} aria-label="Actualizar calendario" className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100"><RefreshCw className={`h-4 w-4 ${phase === 'loading' ? 'animate-spin' : ''}`} /></button></header>
		{mode === 'week' && effectiveMode === 'day' && <div data-task-calendar-mobile-week className="flex gap-1 overflow-x-auto border-b border-slate-100 px-2 py-2">{weekDays.map(day => <button key={dateKey(day)} onClick={() => setCursor(day)} className={`min-w-[58px] rounded-xl px-2 py-2 text-center ${dateKey(day) === dateKey(cursor) ? 'bg-emerald-600 text-white' : 'bg-slate-50 text-slate-600'}`}><span className="block text-[9px] font-black uppercase">{day.toLocaleDateString('es', { weekday: 'short' })}</span><span className="text-sm font-black">{day.getDate()}</span></button>)}</div>}
		<div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto">
			{rangeNotice && <div role="status" className="sticky left-4 top-3 z-30 mx-4 mb-2 max-w-xl rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-xs font-semibold text-sky-800">{rangeNotice}</div>}
			{mutationError && <div role="alert" className="sticky left-4 top-3 z-40 mx-4 flex max-w-xl items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-semibold text-amber-800 shadow-lg"><span className="min-w-0 flex-1">{mutationError}</span>{scheduleConflict && <button type="button" onClick={() => void rescheduleEvent(scheduleConflict.occurrence, scheduleConflict.start, scheduleConflict.end, true)} className="shrink-0 rounded-xl bg-amber-500 px-3 py-2 font-black text-white">Guardar de todos modos</button>}<button type="button" aria-label="Cerrar aviso" onClick={() => { setMutationError(''); setScheduleConflict(null) }} className="rounded-lg p-1 hover:bg-amber-100"><X className="h-4 w-4" /></button></div>}
			{phase === 'loading' && !items.length && <div className="flex h-full items-center justify-center gap-2 text-sm font-semibold text-slate-400"><Loader2 className="h-5 w-5 animate-spin text-emerald-500" />Preparando agenda…</div>}
			{phase === 'error' && <div className="absolute inset-x-4 top-4 z-30 flex items-center justify-between rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700"><span>{loadError}</span><button onClick={() => void loadAgenda()} className="rounded-xl bg-white px-3 py-2 font-bold">Reintentar</button></div>}
			{mode === 'month' && <div className="grid min-h-full grid-cols-7 grid-rows-[34px_repeat(6,minmax(110px,1fr))]">{['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'].map(day => <div key={day} className="sticky top-0 z-10 flex items-center justify-center border-b border-r border-slate-100 bg-white/95 text-[10px] font-black uppercase text-slate-400 backdrop-blur">{day}</div>)}{monthDays.map(day => { const visible = dayItems(day); const activeMonth = day.getMonth() === cursor.getMonth(); const today = dateKey(day) === dateKey(new Date()); return <div key={dateKey(day)} role={canCreate ? 'button' : undefined} tabIndex={canCreate ? 0 : -1} onClick={() => openComposer(day)} onKeyDown={event => { if (canCreate && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openComposer(day) } }} className={`group min-h-[110px] border-b border-r border-slate-100 p-1.5 text-left transition ${canCreate ? 'cursor-pointer hover:bg-emerald-50/40' : ''} ${activeMonth ? 'bg-white' : 'bg-slate-50/70'}`}><div className="flex items-center justify-between"><span className={`flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-bold ${today ? 'bg-emerald-600 text-white' : activeMonth ? 'text-slate-600' : 'text-slate-300'}`}>{day.getDate()}</span>{canCreate && <Plus className="h-3.5 w-3.5 text-emerald-500 opacity-0 transition group-hover:opacity-100" />}</div><div className="mt-1 space-y-1">{visible.slice(0, width < 900 ? 2 : 3).map(item => <AgendaBlock key={item.key} item={item} lists={lists} compact onOpen={() => openItem(item)} />)}{visible.length > (width < 900 ? 2 : 3) && <button type="button" onClick={event => { event.stopPropagation(); setMorePopover({ anchor: event.currentTarget.getBoundingClientRect(), items: visible, day }) }} className="min-h-6 rounded-lg px-1.5 text-[9px] font-black text-slate-500 hover:bg-slate-100">+{visible.length - (width < 900 ? 2 : 3)} más</button>}</div></div> })}</div>}
			{mode !== 'month' && <div className={`grid min-w-0 ${effectiveMode === 'week' ? 'grid-cols-[58px_repeat(7,minmax(110px,1fr))]' : 'grid-cols-[58px_minmax(260px,1fr)]'}`}><div className="sticky left-0 top-0 z-20 border-b border-r border-slate-100 bg-white" />{visibleDays.map(day => <div key={`head:${dateKey(day)}`} className="sticky top-0 z-20 border-b border-r border-slate-100 bg-white/95 p-2 text-center backdrop-blur"><p className="text-[10px] font-black uppercase text-slate-400">{day.toLocaleDateString('es', { weekday: 'short' })}</p><p className={`mx-auto flex h-8 w-8 items-center justify-center rounded-full text-sm font-black ${dateKey(day) === dateKey(new Date()) ? 'bg-emerald-600 text-white' : 'text-slate-700'}`}>{day.getDate()}</p></div>)}<div className="sticky left-0 z-10 border-b border-r border-slate-100 bg-white px-1 py-2 text-right text-[9px] font-black uppercase text-slate-400">Todo<br />el día</div>{visibleDays.map(day => <div key={`all:${dateKey(day)}`} onClick={() => openComposer(day)} className="min-h-12 space-y-1 border-b border-r border-slate-100 bg-slate-50/40 p-1">{dayItems(day).filter(item => agendaItemInterval(item)?.allDay).slice(0, 3).map(item => <AgendaBlock key={item.key} item={item} lists={lists} compact onOpen={() => openItem(item)} />)}</div>)}<div className="sticky left-0 z-10 h-[1440px] border-r border-slate-100 bg-white">{hours.map(hour => <div key={hour} className="h-[60px] border-t border-slate-100 pr-2 pt-1 text-right text-[10px] font-semibold text-slate-400">{String(hour).padStart(2, '0')}:00</div>)}</div>{visibleDays.map(day => { const layouts = layoutTimedAgendaItems(items, day); const isToday = dateKey(day) === dateKey(new Date()); return <div key={`body:${dateKey(day)}`} className="relative h-[1440px] border-r border-slate-100 bg-[linear-gradient(to_bottom,transparent_59px,#f1f5f9_60px)] bg-[length:100%_60px]" onDoubleClick={event => { const rect = event.currentTarget.getBoundingClientRect(); const minutes = Math.max(0, Math.min(1439, event.clientY - rect.top)); openComposer(day, Math.floor(minutes / 60)) }} onPointerDown={event => { if (!canCreate || (event.target as HTMLElement).closest('button')) return; const rect = event.currentTarget.getBoundingClientRect(); const start = Math.floor(Math.max(0, Math.min(1439, event.clientY - rect.top)) / 15) * 15; (event.currentTarget as HTMLElement).dataset.dragStart = String(start); event.currentTarget.setPointerCapture(event.pointerId) }} onPointerUp={(event: ReactPointerEvent<HTMLDivElement>) => { const raw = event.currentTarget.dataset.dragStart; delete event.currentTarget.dataset.dragStart; if (!raw) return; const rect = event.currentTarget.getBoundingClientRect(); const start = Number(raw); const finish = Math.floor(Math.max(0, Math.min(1440, event.clientY - rect.top)) / 15) * 15; const low = Math.min(start, finish); const high = Math.max(start + 30, finish); const slotDate = new Date(day); slotDate.setHours(Math.floor(low / 60), low % 60, 0, 0); const endDate = new Date(day); endDate.setHours(Math.floor(high / 60), high % 60, 0, 0); setComposer({ startAt: slotDate.toISOString(), dueAt: endDate.toISOString(), allDay: false, type: 'event' }); setListID(calendarDefaultList(scopeListID, lastListID, lists.map(list => list.id))); setTitle(''); setError('') }}>{isToday && <div aria-hidden className="pointer-events-none absolute inset-x-0 z-20 border-t-2 border-rose-500" style={{ top: currentTimeTop }}><span className="absolute -left-1 -top-1.5 h-3 w-3 rounded-full bg-rose-500" /></div>}{layouts.map(layout => { const left = layout.lane / layout.laneCount * 100; const widthPercent = 100 / layout.laneCount; return <AgendaBlock key={`${layout.item.key}:${dateKey(day)}`} item={layout.item} lists={lists} onOpen={() => openItem(layout.item)} onReschedule={(occurrence, start, end) => { void rescheduleEvent(occurrence, start, end) }} style={{ position: 'absolute', top: layout.top + 2, height: Math.max(26, layout.height - 3), left: `calc(${left}% + 3px)`, width: `calc(${widthPercent}% - 6px)`, zIndex: 5 + layout.lane }} /> })}</div> })}</div>}
		</div>
		{morePopover && <CalendarMorePopover {...morePopover} lists={lists} onOpen={openItem} onClose={() => setMorePopover(null)} />}
		{composer && <div className="fixed inset-0 z-[145] flex items-center justify-center bg-slate-950/25 p-4 backdrop-blur-[2px]" onMouseDown={event => event.target === event.currentTarget && closeComposer()}>
			<div role="dialog" aria-modal="true" aria-labelledby="calendar-composer-title" className="w-full max-w-lg rounded-3xl border border-slate-200 bg-white p-5 shadow-2xl">
				<div className="flex items-start justify-between"><div><p className="text-[10px] font-black uppercase tracking-[.16em] text-emerald-600">Calendario</p><h2 id="calendar-composer-title" className="mt-1 text-lg font-black text-slate-900">Crear en este horario</h2><p className="mt-1 text-xs text-slate-400">{new Date(composer.startAt).toLocaleString('es', composer.allDay ? { dateStyle: 'full' } : { dateStyle: 'medium', timeStyle: 'short' })}</p></div><button onClick={closeComposer} className="rounded-xl p-2 text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button></div>
				<div className="mt-4 flex rounded-xl bg-slate-100 p-1"><button onClick={() => { setQuickConflict(false); setComposer(current => current ? { ...current, type: 'event' } : null) }} className={`min-h-9 flex-1 rounded-lg text-xs font-black ${composer.type === 'event' ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-500'}`}>Evento</button><button onClick={() => { setQuickConflict(false); setComposer(current => current ? { ...current, type: 'task' } : null) }} className={`min-h-9 flex-1 rounded-lg text-xs font-black ${composer.type === 'task' ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-500'}`}>Tarea</button></div>
				<input autoFocus value={title} onChange={event => { setTitle(event.target.value); setQuickConflict(false) }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void createQuick(quickConflict) }; if (event.key === 'Escape') { event.preventDefault(); closeComposer() } }} placeholder={composer.type === 'event' ? 'Nombre del evento' : '¿Qué hay que lograr?'} className="mt-4 w-full rounded-2xl border border-slate-200 px-4 py-3 text-base font-semibold outline-none focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100" />
				<div className={`mt-3 grid gap-3 ${composer.type === 'task' ? 'sm:grid-cols-2' : ''}`}><TaskListPicker value={listID} lists={lists} folders={folders} onChange={value => { setListID(value); setQuickConflict(false) }} />{composer.type === 'task' && <TaskUserCombobox users={users} value={ownerID} onChange={setOwnerID} />}</div>
				{selectedList && <p className="mt-2 text-[10px] text-slate-400">Destino: {selectedList.folder_id ? `${folderByID.get(selectedList.folder_id)?.name || 'Carpeta'} / ` : ''}{selectedList.name}</p>}
				{error && <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">{error}</p>}
				<div className="mt-5 flex flex-wrap justify-end gap-2"><button onClick={more} className="min-h-11 rounded-xl px-4 text-sm font-bold text-slate-600 hover:bg-slate-100">Más opciones</button><button disabled={!title.trim() || !selectedList || (composer.type === 'task' && (!status || !ownerID)) || saving} onClick={() => void createQuick(quickConflict)} className={`inline-flex min-h-11 items-center gap-2 rounded-xl px-4 text-sm font-black text-white shadow-lg disabled:opacity-40 ${quickConflict && composer.type === 'event' ? 'bg-amber-500 shadow-amber-100 hover:bg-amber-600' : 'bg-emerald-600 shadow-emerald-100 hover:bg-emerald-700'}`}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : composer.type === 'event' ? <CalendarDays className="h-4 w-4" /> : <Plus className="h-4 w-4" />}{quickConflict && composer.type === 'event' ? 'Guardar de todos modos' : 'Crear'}</button></div>
			</div>
		</div>}
		<WorkEventEditor open={eventEditorOpen} event={editingEvent} occurrence={editingOccurrence} draft={eventDraft} lists={lists} folders={folders} users={users} currentUserID={currentUserID} defaultListID={scopeListID || lists.find(list => list.is_default)?.id} storageScope={storageScope} onClose={() => { setEventEditorOpen(false); setEditingEvent(null); setEditingOccurrence(null); setEventDraft(null) }} onSaved={() => { void loadAgenda() }} onDeleted={() => { void loadAgenda() }} />
	</div>
}
