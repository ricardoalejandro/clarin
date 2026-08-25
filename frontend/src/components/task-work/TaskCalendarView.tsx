'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, Clock3, ExternalLink, GripHorizontal, GripVertical, ListTodo, Loader2, MapPin, Pencil, Plus, RefreshCw, Undo2, UserRound, X } from 'lucide-react'
import { apiGet, apiPost, apiPut, subscribeWebSocket } from '@/lib/api'
import type { AgendaItem, Task, TaskAgendaResponse, TaskFolder, TaskList, TaskWorkflowStatus, WorkEvent, WorkEventOccurrence } from '@/types/task'
import type { TaskAccountUser } from './TaskEditorModal'
import type { TaskInlineDraft } from './TaskBoard'
import { TaskListPicker } from './TaskSelectPicker'
import TaskUserCombobox from './TaskUserCombobox'
import { calendarDefaultList, calendarPopoverPosition, calendarSlot, shouldCloseCalendarComposerOnEscape, TASK_CALENDAR_MODE_LABELS, type CalendarFloatingRect, type TaskCalendarMode } from './taskCalendarState'
import type { TaskHierarchyCounts } from './taskHierarchyCounts'
import { agendaItemInterval, agendaItemOverlapsDay, layoutTimedAgendaItems } from './calendarAgendaLayout'
import { taskColorContrast } from './TaskContainerAppearance'
import { resolveTaskIdentityColor } from './taskIdentityColor'
import WorkEventEditor, { type WorkEventDraft } from './WorkEventEditor'
import { TASK_OVERLAY_LAYERS } from './taskOverlayLayers'
import { canEditTask } from './taskPermissionActions'
import { TaskPriorityIndicator, TaskStatusIndicator } from './TaskSemanticIndicators'
import {
	applyCalendarSchedule,
	buildEventSchedulePayload,
	buildTaskSchedulePayload,
	calendarInteractionLabel,
	calendarItemSchedule,
	calendarPointerDelta,
	calendarScheduleAfterInteraction,
	calendarScheduleChanged,
	calendarSpanOverflowCount,
	layoutCalendarSpans,
	CALENDAR_TOUCH_HOLD_MS,
	type CalendarInteractionDelta,
	type CalendarInteractionMode,
	type CalendarInteractionSurface,
	type CalendarSchedule,
} from './calendarScheduleInteraction'

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
	activeTaskId?: string
	taskProjection?: Task | null
	onOpenTaskDetail: (task: Task, trigger?: HTMLElement | null) => void
	onEditTask: (task: Task) => void
	onCreated: (task: Task, operationID: string, hierarchyCounts?: TaskHierarchyCounts) => void
	onOperation: (operationID: string, active: boolean) => void
	onMore: (statusID?: string, draft?: TaskInlineDraft) => void
	canCreate?: boolean
}

type Composer = { startAt: string; dueAt: string; allDay: boolean; type: 'event' | 'task' }
type CalendarSummaryState = { item: AgendaItem; anchor: CalendarFloatingRect; anchorElement: HTMLElement | null; returnFocus: HTMLElement | null }
type CalendarPreviewState = { itemKey: string; title: string; label: string; point?: { x: number; y: number } }
type CalendarUndoState = { item: AgendaItem; before: CalendarSchedule; after: CalendarSchedule; expiresAt: number }
type CalendarConflictState = { item: AgendaItem; before: CalendarSchedule; after: CalendarSchedule }
const hours = Array.from({ length: 24 }, (_, index) => index)
const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
const startOfDay = (date: Date) => { const next = new Date(date); next.setHours(0, 0, 0, 0); return next }
const addDays = (date: Date, days: number) => { const next = new Date(date); next.setDate(next.getDate() + days); return next }
const eventTitle = (item: AgendaItem) => item.kind === 'task' ? item.task.title : item.event.event.title
const agendaItemVersion = (item: AgendaItem) => item.kind === 'task' ? item.task.version || 0 : item.event.event.version || 0
const taskVersion = (task: Task) => task.version || 0

function mergeCalendarInventory(current: AgendaItem[], canonical: AgendaItem[], projections: ReadonlyMap<string, Task>, pendingKeys: ReadonlySet<string>) {
	const currentByKey = new Map(current.map(item => [item.key, item]))
	const merged = canonical.map(item => {
		const local = currentByKey.get(item.key)
		if (pendingKeys.has(item.key) && local) return local
		if (item.kind !== 'task') return local && agendaItemVersion(local) > agendaItemVersion(item) ? local : item
		const projected = projections.get(item.task.id)
		if (projected && taskVersion(projected) >= taskVersion(item.task)) return { ...item, task: projected } as AgendaItem
		return local && agendaItemVersion(local) > agendaItemVersion(item) ? local : item
	})
	for (const key of Array.from(pendingKeys)) {
		if (!merged.some(item => item.key === key) && currentByKey.has(key)) merged.push(currentByKey.get(key)!)
	}
	return merged
}
const eventColor = (item: AgendaItem, lists: TaskList[]) => {
	if (item.kind === 'task') return item.task.resolved_color || resolveTaskIdentityColor(item.task.color, lists.find(list => list.id === item.task.list_id)?.color).color
	return item.event.event.resolved_color || resolveTaskIdentityColor(item.event.event.color, lists.find(list => list.id === item.event.event.list_id)?.color).color
}

function itemTime(item: AgendaItem) {
	const interval = agendaItemInterval(item)
	if (!interval || interval.allDay) return ''
	return interval.start.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
}

interface AgendaBlockInteraction {
	surface: CalendarInteractionSurface
	dayCount: number
	pending?: boolean
	allowResize?: boolean
	onCommit: (item: AgendaItem, mode: CalendarInteractionMode, delta: CalendarInteractionDelta) => void
	onPreview: (item: AgendaItem, schedule: CalendarSchedule | null, point?: { x: number; y: number }) => void
	onAutoScroll?: (point: { x: number; y: number }) => void
}

type AgendaPointerSession = {
	pointerID: number
	pointerType: string
	origin: { x: number; y: number }
	mode: CalendarInteractionMode
	active: boolean
	target: HTMLButtonElement
	timer: number | null
}

function AgendaBlock({ item, lists, compact = false, activeTaskId, onOpen, interaction, style, resizeAtEnd = false }: { item: AgendaItem; lists: TaskList[]; compact?: boolean; activeTaskId?: string; onOpen: (anchor: DOMRect, trigger: HTMLButtonElement) => void; interaction?: AgendaBlockInteraction; style?: CSSProperties; resizeAtEnd?: boolean }) {
	const rootRef = useRef<HTMLDivElement>(null)
	const mainRef = useRef<HTMLButtonElement>(null)
	const pointerRef = useRef<AgendaPointerSession | null>(null)
	const suppressOpenRef = useRef(false)
	const [pointerActive, setPointerActive] = useState(false)
	const [keyboardSession, setKeyboardSession] = useState<{ mode: CalendarInteractionMode; delta: CalendarInteractionDelta } | null>(null)
	const color = eventColor(item, lists)
	const contrast = taskColorContrast(color)
	const cancelled = item.kind === 'event' && item.event.event.status === 'cancelled'
	const overdue = item.kind === 'task' && Boolean(item.task.due_at && new Date(item.task.due_at) < new Date() && item.task.status_detail?.category !== 'done')
	const schedule = calendarItemSchedule(item)
	const editable = Boolean(interaction && schedule && !interaction.pending && !cancelled && (item.kind === 'task' ? canEditTask(item.task) : item.event.event.capabilities.can_edit))
	const active = pointerActive || Boolean(keyboardSession)
	const isOpenTask = item.kind === 'task' && item.task.id === activeTaskId

	const pointerGeometry = () => {
		const root = rootRef.current
		if (!root || !interaction) return { columnWidth: 1, rowHeight: 1 }
		if (interaction.surface === 'month') {
			const grid = root.closest<HTMLElement>('[data-calendar-month-grid]')
			const rect = grid?.getBoundingClientRect()
			return { columnWidth: (rect?.width || root.getBoundingClientRect().width) / 7, rowHeight: Math.max(1, ((rect?.height || 694) - 34) / 6) }
		}
		if (interaction.surface === 'all-day') {
			const grid = root.closest<HTMLElement>('[data-calendar-all-day-grid]')
			const rect = grid?.getBoundingClientRect()
			const columnWidth = (rect?.width || root.getBoundingClientRect().width) / Math.max(1, interaction.dayCount)
			return { columnWidth: interaction.dayCount === 1 ? Math.max(96, Math.min(180, columnWidth / 2)) : columnWidth }
		}
		const column = root.closest<HTMLElement>('[data-calendar-time-column]')
		const columnWidth = column?.getBoundingClientRect().width || root.getBoundingClientRect().width
		return { columnWidth: interaction.dayCount === 1 ? Math.max(96, Math.min(180, columnWidth / 2)) : columnWidth }
	}

	const clearPointer = (announce = true) => {
		const current = pointerRef.current
		if (current?.timer) window.clearTimeout(current.timer)
		pointerRef.current = null
		if (current?.target.hasPointerCapture(current.pointerID)) current.target.releasePointerCapture(current.pointerID)
		setPointerActive(false)
		if (announce) interaction?.onPreview(item, null)
	}

	useEffect(() => () => {
		const current = pointerRef.current
		if (current?.timer) window.clearTimeout(current.timer)
	}, [])
	useEffect(() => {
		if (!active) return
		const dismiss = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return
			event.preventDefault()
			event.stopPropagation()
			cancelInteraction()
			mainRef.current?.focus({ preventScroll: true })
		}
		window.addEventListener('keydown', dismiss, true)
		return () => window.removeEventListener('keydown', dismiss, true)
	// cancelInteraction intentionally reads the current pointer and keyboard session.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [active])

	const activatePointer = (session: AgendaPointerSession) => {
		if (pointerRef.current !== session) return
		session.active = true
		session.timer = null
		if (!session.target.hasPointerCapture(session.pointerID)) session.target.setPointerCapture(session.pointerID)
		suppressOpenRef.current = true
		setPointerActive(true)
		if (schedule) interaction?.onPreview(item, schedule, session.origin)
	}

	const beginPointer = (event: ReactPointerEvent<HTMLButtonElement>, mode: CalendarInteractionMode) => {
		if (!editable || !interaction || !schedule || (mode === 'resize-end' && interaction.allowResize === false)) return
		event.stopPropagation()
		const session: AgendaPointerSession = {
			pointerID: event.pointerId,
			pointerType: event.pointerType,
			origin: { x: event.clientX, y: event.clientY },
			mode,
			active: mode === 'resize-end',
			target: event.currentTarget,
			timer: null,
		}
		pointerRef.current = session
		if (event.pointerType === 'touch' && mode === 'move') {
			session.timer = window.setTimeout(() => activatePointer(session), CALENDAR_TOUCH_HOLD_MS)
			return
		}
		event.currentTarget.setPointerCapture(event.pointerId)
		if (session.active) activatePointer(session)
	}

	const previewPointer = (event: ReactPointerEvent<HTMLButtonElement>) => {
		const session = pointerRef.current
		if (!session || !interaction || !schedule) return
		const distance = Math.hypot(event.clientX - session.origin.x, event.clientY - session.origin.y)
		if (!session.active) {
			if (session.pointerType === 'touch') {
				if (distance > 10) clearPointer(false)
				return
			}
			if (distance < 4) return
			activatePointer(session)
		}
		if (!session.active) return
		event.preventDefault()
		event.stopPropagation()
		const delta = calendarPointerDelta(interaction.surface, session.origin, { x: event.clientX, y: event.clientY }, pointerGeometry())
		const candidate = calendarScheduleAfterInteraction(schedule, session.mode, delta)
		interaction.onPreview(item, candidate, { x: event.clientX, y: event.clientY })
		interaction.onAutoScroll?.({ x: event.clientX, y: event.clientY })
	}

	const finishPointer = (event: ReactPointerEvent<HTMLButtonElement>) => {
		const session = pointerRef.current
		if (!session || !interaction || !schedule) return
		const wasActive = session.active
		const delta = calendarPointerDelta(interaction.surface, session.origin, { x: event.clientX, y: event.clientY }, pointerGeometry())
		const candidate = calendarScheduleAfterInteraction(schedule, session.mode, delta)
		clearPointer()
		if (!wasActive) return
		event.preventDefault()
		event.stopPropagation()
		suppressOpenRef.current = true
		if (calendarScheduleChanged(schedule, candidate)) interaction.onCommit(item, session.mode, delta)
	}

	const cancelInteraction = () => {
		clearPointer()
		setKeyboardSession(null)
		suppressOpenRef.current = false
		interaction?.onPreview(item, null)
	}

	const commitKeyboard = () => {
		if (!keyboardSession || !interaction || !schedule) return
		const candidate = calendarScheduleAfterInteraction(schedule, keyboardSession.mode, keyboardSession.delta)
		const current = keyboardSession
		setKeyboardSession(null)
		suppressOpenRef.current = false
		interaction.onPreview(item, null)
		if (calendarScheduleChanged(schedule, candidate)) interaction.onCommit(item, current.mode, current.delta)
	}

	const handleKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>, requestedMode: CalendarInteractionMode) => {
		if (event.key === 'Escape' && keyboardSession) {
			event.preventDefault(); event.stopPropagation(); cancelInteraction(); return
		}
		const scheduleToggle = requestedMode === 'move'
			? event.altKey && event.key === ' '
			: event.key === ' ' || event.key === 'Enter'
		if (scheduleToggle && editable) {
			event.preventDefault(); event.stopPropagation()
			if (event.repeat) return
			suppressOpenRef.current = true
			if (keyboardSession) commitKeyboard()
			else {
				const next = { mode: requestedMode, delta: { days: 0, minutes: 0 } }
				setKeyboardSession(next); if (schedule) interaction?.onPreview(item, schedule)
			}
			return
		}
		if (!keyboardSession || !interaction || !schedule) return
		let nextDelta = keyboardSession.delta
		if (interaction.surface === 'timed') {
			if (event.key === 'ArrowUp') nextDelta = { ...nextDelta, minutes: nextDelta.minutes - 15 }
			if (event.key === 'ArrowDown') nextDelta = { ...nextDelta, minutes: nextDelta.minutes + 15 }
			if (event.key === 'ArrowLeft') nextDelta = { ...nextDelta, days: nextDelta.days - 1 }
			if (event.key === 'ArrowRight') nextDelta = { ...nextDelta, days: nextDelta.days + 1 }
		} else {
			if (event.key === 'ArrowLeft') nextDelta = { ...nextDelta, days: nextDelta.days - 1 }
			if (event.key === 'ArrowRight') nextDelta = { ...nextDelta, days: nextDelta.days + 1 }
			if (interaction.surface === 'month' && event.key === 'ArrowUp') nextDelta = { ...nextDelta, days: nextDelta.days - 7 }
			if (interaction.surface === 'month' && event.key === 'ArrowDown') nextDelta = { ...nextDelta, days: nextDelta.days + 7 }
		}
		if (nextDelta === keyboardSession.delta) return
		event.preventDefault(); event.stopPropagation()
		const next = { ...keyboardSession, delta: nextDelta }
		setKeyboardSession(next)
		interaction.onPreview(item, calendarScheduleAfterInteraction(schedule, next.mode, next.delta))
	}

	return <div ref={rootRef} data-calendar-agenda-block={item.key} data-calendar-interaction-active={active || undefined} data-task-active={isOpenTask || undefined} style={{ backgroundColor: color, color: contrast.textColor, ...style }} className={`group/item relative min-w-0 overflow-visible rounded-md font-bold shadow-sm ring-1 ring-black/5 transition-[filter,opacity,box-shadow] motion-reduce:transition-none ${compact ? 'min-h-5 text-[10px]' : 'min-h-7 text-[11px]'} ${cancelled ? 'opacity-55 line-through' : ''} ${overdue ? 'border-l-[3px] border-rose-600' : ''} ${isOpenTask ? 'ring-2 ring-slate-700 ring-offset-1' : ''} ${active ? 'z-30 opacity-65 ring-2 ring-slate-900/50' : ''} ${interaction?.pending ? 'cursor-wait opacity-60' : ''}`}>
		<button ref={mainRef} type="button" title={eventTitle(item)} aria-current={isOpenTask ? 'true' : undefined} aria-keyshortcuts={editable ? 'Enter Space Alt+Space ArrowUp ArrowDown ArrowLeft ArrowRight Escape' : 'Enter Space'} onClick={event => { event.stopPropagation(); if (suppressOpenRef.current) { suppressOpenRef.current = false; return }; onOpen(event.currentTarget.getBoundingClientRect(), event.currentTarget) }} onKeyDown={event => handleKeyboard(event, 'move')} onKeyUp={event => { if (event.altKey && event.key === ' ') event.preventDefault() }} onPointerDown={event => beginPointer(event, 'move')} onPointerMove={previewPointer} onPointerUp={finishPointer} onPointerCancel={() => clearPointer()} onLostPointerCapture={() => { if (pointerRef.current) clearPointer() }} className={`flex h-full min-h-[inherit] w-full min-w-0 items-center gap-1.5 overflow-hidden rounded-md px-1.5 text-left outline-none transition hover:brightness-95 focus:ring-2 focus:ring-slate-900/40 motion-reduce:transition-none ${editable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'}`}>
			{item.kind === 'event' ? <CalendarDays className="h-3 w-3 shrink-0" aria-label="Evento" /> : <TaskStatusIndicator status={item.task.status_detail} compact className="shrink-0" />}
			{overdue && <AlertTriangle className="h-3 w-3 shrink-0" aria-label="Atrasada" />}
			<span className="min-w-0 flex-1 truncate">{itemTime(item) && !compact ? `${itemTime(item)} · ` : ''}{eventTitle(item)}</span>
			{item.kind === 'task' && <TaskPriorityIndicator priority={item.task.priority} compact className="shrink-0" />}
			{item.kind === 'event' && item.event.event.availability === 'free' && <span className="shrink-0 rounded bg-white/30 px-1 text-[8px] uppercase">Libre</span>}
			{interaction?.pending && <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-label="Guardando horario" />}
		</button>
		{editable && interaction?.allowResize !== false && <button type="button" data-calendar-resize-end aria-label={`Ajustar final de ${eventTitle(item)}`} title="Arrastra para cambiar la duración" onClick={event => event.stopPropagation()} onKeyDown={event => handleKeyboard(event, 'resize-end')} onKeyUp={event => { if (event.key === ' ') event.preventDefault() }} onPointerDown={event => beginPointer(event, 'resize-end')} onPointerMove={previewPointer} onPointerUp={finishPointer} onPointerCancel={() => clearPointer()} onLostPointerCapture={() => { if (pointerRef.current) clearPointer() }} className={resizeAtEnd ? 'absolute -right-1 inset-y-0 flex w-5 cursor-ew-resize items-center justify-center rounded-r-md opacity-0 outline-none transition motion-reduce:transition-none group-hover/item:opacity-80 group-focus-within/item:opacity-80 focus:opacity-100 focus:ring-2 focus:ring-white/80 [@media(pointer:coarse)]:right-0 [@media(pointer:coarse)]:w-11 [@media(pointer:coarse)]:opacity-70' : 'absolute inset-x-0 -bottom-1 flex h-3 cursor-ns-resize items-center justify-center rounded-b-md opacity-0 outline-none transition motion-reduce:transition-none group-hover/item:opacity-80 group-focus-within/item:opacity-80 focus:opacity-100 focus:ring-2 focus:ring-white/80 [@media(pointer:coarse)]:bottom-0 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:opacity-60'}>{resizeAtEnd ? <GripVertical className="h-3 w-3" /> : <GripHorizontal className="h-3 w-3" />}</button>}
	</div>
}

function CalendarMorePopover({ anchor, returnFocus, items, lists, day, activeTaskId, onOpen, onClose }: { anchor: DOMRect; returnFocus: HTMLButtonElement; items: AgendaItem[]; lists: TaskList[]; day: Date; activeTaskId?: string; onOpen: (item: AgendaItem, anchor: DOMRect, trigger: HTMLButtonElement, returnFocus?: HTMLElement) => void; onClose: () => void }) {
	if (typeof document === 'undefined') return null
	const width = Math.min(340, window.innerWidth - 24)
	const left = Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12))
	const top = Math.max(12, Math.min(anchor.bottom + 6, window.innerHeight - Math.min(430, items.length * 34 + 92)))
	return createPortal(<><button type="button" aria-label="Cerrar eventos del día" onMouseDown={onClose} className="fixed inset-0 cursor-default" style={{ zIndex: TASK_OVERLAY_LAYERS.workspacePopover - 1 }} /><section role="dialog" aria-label={`Agenda del ${day.toLocaleDateString('es', { dateStyle: 'long' })}`} style={{ left, top, width, zIndex: TASK_OVERLAY_LAYERS.workspacePopover }} className="fixed max-h-[420px] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"><header className="flex items-center justify-between border-b border-slate-200 px-4 py-3"><div><p className="text-[10px] font-black uppercase tracking-[.14em] text-emerald-600">{day.toLocaleDateString('es', { weekday: 'long' })}</p><p className="text-sm font-black text-slate-900">{day.toLocaleDateString('es', { day: 'numeric', month: 'long' })}</p></div><button type="button" onClick={onClose} className="rounded-xl p-2 text-slate-500 hover:bg-slate-100"><X className="h-4 w-4" /></button></header><div className="space-y-1.5 overflow-y-auto p-3">{items.map(item => <AgendaBlock key={item.key} item={item} lists={lists} activeTaskId={activeTaskId} onOpen={(itemAnchor, trigger) => { onClose(); onOpen(item, itemAnchor, trigger, returnFocus) }} />)}</div></section></>, document.body)
}

function CalendarSpanLayer({ segments, lists, surface, dayCount, visibleLanes, weekOffset, activeTaskId, top = 36, onOpen, interactionFor }: {
	segments: ReturnType<typeof layoutCalendarSpans>
	lists: TaskList[]
	surface: 'month' | 'all-day'
	dayCount: number
	visibleLanes: number
	weekOffset: number
	activeTaskId?: string
	top?: number
	onOpen: (item: AgendaItem, anchor: DOMRect, trigger: HTMLButtonElement) => void
	interactionFor: (itemKey: string, surface: CalendarInteractionSurface, dayCount: number, allowResize?: boolean) => AgendaBlockInteraction
}) {
	return <div aria-label="Elementos programados" className="pointer-events-none absolute inset-x-1 z-[5] grid gap-x-0.5 gap-y-1" style={{ top, gridTemplateColumns: `repeat(${dayCount}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${visibleLanes}, 22px)` }}>
		{segments.filter(segment => segment.lane < visibleLanes).map(segment => {
			const schedule = calendarItemSchedule(segment.item)
			const resizable = Boolean(schedule?.allDay && segment.isEnd)
			return <AgendaBlock key={`${segment.item.key}:${segment.startIndex}:${segment.endIndex}`} item={segment.item} lists={lists} compact resizeAtEnd={resizable} activeTaskId={activeTaskId} onOpen={(anchor, trigger) => onOpen(segment.item, anchor, trigger)} interaction={interactionFor(segment.item.key, surface, dayCount, resizable)} style={{ pointerEvents: 'auto', gridColumn: `${segment.startIndex - weekOffset + 1} / ${segment.endIndex - weekOffset + 1}`, gridRow: segment.lane + 1 }} />
		})}
	</div>
}

const calendarViewport = () => {
	const viewport = window.visualViewport
	return {
		left: viewport?.offsetLeft || 0,
		top: viewport?.offsetTop || 0,
		width: viewport?.width || window.innerWidth,
		height: viewport?.height || window.innerHeight,
	}
}

const floatingRect = (rect: DOMRect): CalendarFloatingRect => ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })

function CalendarModePicker({ mode, onChange, onBeforeOpen }: { mode: TaskCalendarMode; onChange: (mode: TaskCalendarMode) => void; onBeforeOpen: () => void }) {
	const [open, setOpen] = useState(false)
	const [position, setPosition] = useState({ left: 0, top: 0 })
	const triggerRef = useRef<HTMLButtonElement>(null)
	const menuRef = useRef<HTMLDivElement>(null)
	const modes: TaskCalendarMode[] = ['month', 'week', 'day']
	const close = (restoreFocus = true) => {
		setOpen(false)
		if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }))
	}
	useEffect(() => {
		if (!open) return
		const reposition = () => {
			const anchor = triggerRef.current?.getBoundingClientRect()
			if (!anchor) return
			setPosition(calendarPopoverPosition(floatingRect(anchor), { width: 184, height: 146 }, calendarViewport()))
		}
		reposition()
		const frame = window.requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>(`[data-calendar-mode="${mode}"]`)?.focus({ preventScroll: true }))
		const dismissOnEscape = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return
			event.preventDefault()
			event.stopPropagation()
			close()
		}
		window.addEventListener('keydown', dismissOnEscape, true)
		window.addEventListener('resize', reposition)
		window.addEventListener('scroll', reposition, true)
		window.visualViewport?.addEventListener('resize', reposition)
		window.visualViewport?.addEventListener('scroll', reposition)
		return () => {
			window.cancelAnimationFrame(frame)
			window.removeEventListener('keydown', dismissOnEscape, true)
			window.removeEventListener('resize', reposition)
			window.removeEventListener('scroll', reposition, true)
			window.visualViewport?.removeEventListener('resize', reposition)
			window.visualViewport?.removeEventListener('scroll', reposition)
		}
	}, [mode, open])
	const keyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		const options = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]'))
		const current = options.indexOf(document.activeElement as HTMLElement)
		if (event.key === 'Escape') { event.preventDefault(); close(); return }
		if (event.key === 'Tab') { setOpen(false); return }
		if (event.key === 'ArrowDown') { event.preventDefault(); options[(current + 1 + options.length) % options.length]?.focus(); return }
		if (event.key === 'ArrowUp') { event.preventDefault(); options[(current - 1 + options.length) % options.length]?.focus(); return }
		if (event.key === 'Home') { event.preventDefault(); options[0]?.focus(); return }
		if (event.key === 'End') { event.preventDefault(); options.at(-1)?.focus() }
	}
	return <>
		<button ref={triggerRef} type="button" aria-haspopup="listbox" aria-expanded={open} aria-controls="task-calendar-mode-list" onClick={() => { if (open) close(false); else { onBeforeOpen(); setOpen(true) } }} className="flex min-h-11 min-w-[118px] items-center justify-between gap-2 rounded-xl border border-slate-300 bg-white px-3 text-xs font-black text-slate-700 shadow-sm transition hover:border-slate-400 hover:bg-slate-50 focus:outline-none focus:ring-4 focus:ring-emerald-100"><span className="inline-flex items-center gap-2"><CalendarDays className="h-4 w-4 text-emerald-600" />{TASK_CALENDAR_MODE_LABELS[mode]}</span><ChevronDown className={`h-4 w-4 text-slate-500 transition ${open ? 'rotate-180' : ''}`} /></button>
		{open && typeof document !== 'undefined' && createPortal(<><button type="button" aria-label="Cerrar selector de vista" onMouseDown={() => close()} className="fixed inset-0 cursor-default" style={{ zIndex: TASK_OVERLAY_LAYERS.workspacePopover - 1 }} /><div ref={menuRef} id="task-calendar-mode-list" role="listbox" aria-label="Vista del calendario" tabIndex={-1} onKeyDown={keyboard} style={{ ...position, width: 184, zIndex: TASK_OVERLAY_LAYERS.workspacePopover }} className="fixed rounded-2xl border border-slate-200 bg-white p-1.5 shadow-2xl shadow-slate-900/15 outline-none">{modes.map(item => <button key={item} type="button" role="option" aria-selected={mode === item} data-calendar-mode={item} onClick={() => { onChange(item); close() }} className={`flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-bold outline-none transition focus:ring-2 focus:ring-emerald-400 ${mode === item ? 'bg-emerald-50 text-emerald-800' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}`}><span className={`flex h-7 w-7 items-center justify-center rounded-lg ${mode === item ? 'bg-white text-emerald-700 shadow-sm' : 'bg-slate-100 text-slate-500'}`}><CalendarDays className="h-3.5 w-3.5" /></span><span className="flex-1">{TASK_CALENDAR_MODE_LABELS[item]}</span>{mode === item && <Check className="h-4 w-4 text-emerald-600" />}</button>)}</div></>, document.body)}
	</>
}

const priorityLabels: Record<Task['priority'], string> = { low: 'Baja', medium: 'Media', high: 'Alta', urgent: 'Urgente' }

function calendarSummaryDate(item: AgendaItem) {
	const interval = agendaItemInterval(item)
	if (!interval) return 'Sin fecha'
	const date = interval.start.toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' })
	if (interval.allDay) {
		const inclusiveEnd = new Date(interval.end); inclusiveEnd.setDate(inclusiveEnd.getDate() - 1)
		return dateKey(interval.start) === dateKey(inclusiveEnd)
			? `${date} · Todo el día`
			: `${date} – ${inclusiveEnd.toLocaleDateString('es', { day: 'numeric', month: 'long' })} · Todo el día`
	}
	const startTime = interval.start.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
	const endTime = interval.end.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
	return `${date} · ${startTime}–${endTime}`
}

function CalendarItemSummary({ item, lists, anchor, anchorElement, onClose, onOpenTaskDetail, onEditTask, onEditEvent }: { item: AgendaItem; lists: TaskList[]; anchor: CalendarFloatingRect; anchorElement: HTMLElement | null; onClose: (restoreFocus?: boolean) => void; onOpenTaskDetail: (task: Task, trigger?: HTMLElement | null) => void; onEditTask: (task: Task) => void; onEditEvent: (event: WorkEvent, occurrence: WorkEventOccurrence) => void }) {
	const panelRef = useRef<HTMLElement>(null)
	const [style, setStyle] = useState<CSSProperties>({ opacity: 0 })
	const color = eventColor(item, lists)
	const title = eventTitle(item)
	const task = item.kind === 'task' ? item.task : null
	const occurrence = item.kind === 'event' ? item.event : null
	const event = occurrence?.event
	const description = task?.description || event?.description || ''
	const location = event?.location
	const listLabel = task
		? task.breadcrumbs_visible === false ? 'Compartida contigo' : [task.folder_name, task.list_name].filter(Boolean).join(' / ') || 'Bandeja general'
		: event?.list_visible ? [event.folder_name, event.list_name].filter(Boolean).join(' / ') || 'Lista de calendario' : 'Invitación compartida contigo'
	useEffect(() => {
		const reposition = () => {
			const viewport = calendarViewport()
			const width = Math.min(360, Math.max(220, viewport.width - 24))
			const measuredHeight = panelRef.current?.getBoundingClientRect().height || 320
			const liveAnchor = anchorElement?.isConnected ? floatingRect(anchorElement.getBoundingClientRect()) : anchor
			setStyle({ ...calendarPopoverPosition(liveAnchor, { width, height: measuredHeight }, viewport), width, zIndex: TASK_OVERLAY_LAYERS.workspacePopover, opacity: 1 })
		}
		reposition()
		const focusFrame = window.requestAnimationFrame(() => { reposition(); panelRef.current?.focus({ preventScroll: true }) })
		const keyboard = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() } }
		window.addEventListener('keydown', keyboard)
		window.addEventListener('resize', reposition)
		window.addEventListener('scroll', reposition, true)
		window.visualViewport?.addEventListener('resize', reposition)
		window.visualViewport?.addEventListener('scroll', reposition)
		return () => {
			window.cancelAnimationFrame(focusFrame)
			window.removeEventListener('keydown', keyboard)
			window.removeEventListener('resize', reposition)
			window.removeEventListener('scroll', reposition, true)
			window.visualViewport?.removeEventListener('resize', reposition)
			window.visualViewport?.removeEventListener('scroll', reposition)
		}
	}, [anchor, anchorElement, onClose])
	if (typeof document === 'undefined') return null
	return createPortal(<><button type="button" aria-label="Cerrar resumen del calendario" onMouseDown={() => onClose()} className="fixed inset-0 cursor-default" style={{ zIndex: TASK_OVERLAY_LAYERS.workspacePopover - 1 }} /><section ref={panelRef} tabIndex={-1} role="dialog" aria-modal="false" aria-label={`Resumen de ${item.kind === 'task' ? 'tarea' : 'evento'}: ${title}`} data-task-calendar-summary style={style} className="fixed max-h-[calc(100vh-24px)] overflow-y-auto rounded-3xl border border-slate-200 bg-white shadow-2xl shadow-slate-900/20 outline-none transition-opacity motion-reduce:transition-none"><header className="flex items-start gap-3 border-b border-slate-200 px-4 py-4"><span className="mt-0.5 h-4 w-4 shrink-0 rounded-md border-2 border-white shadow-sm ring-1 ring-slate-200" style={{ backgroundColor: color }} /><div className="min-w-0 flex-1"><p className="text-[10px] font-black uppercase tracking-[0.14em] text-emerald-700">{item.kind === 'task' ? 'Tarea' : event?.status === 'cancelled' ? 'Evento cancelado' : 'Evento'}</p><h3 className="mt-1 break-words text-lg font-black leading-6 text-slate-900">{title}</h3></div><button type="button" aria-label="Cerrar resumen" onClick={() => onClose()} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 hover:text-slate-800"><X className="h-4 w-4" /></button></header><div className="space-y-3 px-4 py-4"><div className="flex items-start gap-3"><Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" /><p className="text-sm font-semibold leading-5 text-slate-700">{calendarSummaryDate(item)}{event?.timezone && !event.is_all_day ? <span className="block text-[10px] font-medium text-slate-400">{event.timezone}</span> : null}</p></div><div className="flex items-start gap-3"><ListTodo className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" /><div className="min-w-0 text-sm leading-5 text-slate-600"><p className="truncate font-semibold text-slate-700">{listLabel}</p>{task && <p className="text-[11px] text-slate-500">{task.status_detail?.name || 'Sin estado'} · Prioridad {priorityLabels[task.priority] || task.priority}</p>}{event && <p className="text-[11px] text-slate-500">{event.availability === 'free' ? 'Disponible' : 'Ocupado'}{event.status === 'cancelled' ? ' · Cancelado' : ''}</p>}</div></div><div className="flex items-start gap-3"><UserRound className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" /><p className="text-sm leading-5 text-slate-600">{task?.assigned_to_name || event?.organizer_name || 'Sin responsable'}</p></div>{location && <div className="flex items-start gap-3"><MapPin className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" /><p className="break-words text-sm leading-5 text-slate-600">{location}</p></div>}{description && <p className="line-clamp-4 rounded-2xl bg-slate-50 px-3 py-2.5 text-sm leading-5 text-slate-600">{description}</p>}</div><footer className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 bg-slate-50/80 px-4 py-3">{task && <button type="button" onClick={() => { onClose(false); onOpenTaskDetail(task, anchorElement) }} className="inline-flex min-h-10 items-center gap-2 rounded-xl px-3 text-xs font-bold text-slate-600 hover:bg-white hover:text-slate-900"><ExternalLink className="h-3.5 w-3.5" />Abrir tarea</button>}{task && canEditTask(task) && <button type="button" onClick={() => { onClose(false); onEditTask(task) }} className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-emerald-600 px-4 text-xs font-black text-white shadow-sm hover:bg-emerald-700"><Pencil className="h-3.5 w-3.5" />Editar</button>}{event?.capabilities.can_edit && occurrence && <button type="button" onClick={() => { onClose(false); onEditEvent(event, occurrence) }} className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-emerald-600 px-4 text-xs font-black text-white shadow-sm hover:bg-emerald-700"><Pencil className="h-3.5 w-3.5" />Editar evento</button>}</footer></section></>, document.body)
}

export default function TaskCalendarView({ lists, folders, statuses, users, currentUserID, environmentID, scopeFolderID, scopeListID, storageScope, createEventToken = 0, focusEvent, activeTaskId, taskProjection, onOpenTaskDetail, onEditTask, onCreated, onOperation, onMore, canCreate = true }: Props) {
	const [mode, setMode] = useState<TaskCalendarMode>('month')
	const [cursor, setCursor] = useState(new Date())
	const [items, setItems] = useState<AgendaItem[]>([])
	const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
	const [loadError, setLoadError] = useState('')
	const [rangeNotice, setRangeNotice] = useState('')
	const [mutationError, setMutationError] = useState('')
	const [scheduleConflict, setScheduleConflict] = useState<CalendarConflictState | null>(null)
	const [interactionPreview, setInteractionPreview] = useState<CalendarPreviewState | null>(null)
	const [pendingItemKeys, setPendingItemKeys] = useState<string[]>([])
	const [undoState, setUndoState] = useState<CalendarUndoState | null>(null)
	const [announcement, setAnnouncement] = useState('')
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
	const [morePopover, setMorePopover] = useState<{ anchor: DOMRect; returnFocus: HTMLButtonElement; items: AgendaItem[]; day: Date } | null>(null)
	const [summary, setSummary] = useState<CalendarSummaryState | null>(null)
	const [width, setWidth] = useState(1000)
	const containerRef = useRef<HTMLDivElement>(null)
	const scrollRef = useRef<HTMLDivElement>(null)
	const loadAbortRef = useRef<AbortController | null>(null)
	const loadGeneration = useRef(0)
	const previousCreateToken = useRef(0)
	const summaryRef = useRef<CalendarSummaryState | null>(null)
	const composerReturnFocusRef = useRef<HTMLElement | null>(null)
	const itemsRef = useRef(items)
	const taskProjectionsRef = useRef(new Map<string, Task>())
	const pendingItemKeysRef = useRef(new Set<string>())
	const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	itemsRef.current = items
	const folderByID = useMemo(() => new Map(folders.map(folder => [folder.id, folder])), [folders])
	const effectiveMode: TaskCalendarMode = mode === 'week' && width < 700 ? 'day' : mode
	const closeSummary = useCallback((restoreFocus = true) => {
		const current = summaryRef.current
		summaryRef.current = null
		setSummary(null)
		if (restoreFocus && current?.returnFocus?.isConnected) window.requestAnimationFrame(() => current.returnFocus?.focus({ preventScroll: true }))
	}, [])
	const showSummary = useCallback((item: AgendaItem, anchor: DOMRect, trigger: HTMLButtonElement, returnFocus: HTMLElement = trigger) => {
		if (activeTaskId && item.kind === 'task') {
			closeSummary(false)
			onOpenTaskDetail(item.task, trigger)
			return
		}
		const next = { item, anchor: floatingRect(anchor), anchorElement: trigger, returnFocus }
		summaryRef.current = next
		setSummary(next)
	}, [activeTaskId, closeSummary, onOpenTaskDetail])

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
	const monthSegments = useMemo(() => layoutCalendarSpans(items, gridStart, 42), [items, gridStart.getTime()]) // eslint-disable-line react-hooks/exhaustive-deps
	const allDaySegments = useMemo(() => layoutCalendarSpans(items.filter(item => calendarItemSchedule(item)?.allDay), visibleDays[0], visibleDays.length), [items, visibleDays[0]?.getTime(), visibleDays.length]) // eslint-disable-line react-hooks/exhaustive-deps

	useEffect(() => {
		const node = containerRef.current
		if (!node) return
		const observer = new ResizeObserver(entries => setWidth(entries[0]?.contentRect.width || node.clientWidth))
		observer.observe(node); setWidth(node.clientWidth)
		return () => observer.disconnect()
	}, [])
	useEffect(() => {
		if (!taskProjection) return
		const previous = taskProjectionsRef.current.get(taskProjection.id)
		if (previous && taskVersion(previous) > taskVersion(taskProjection)) return
		taskProjectionsRef.current.set(taskProjection.id, taskProjection)
		setItems(current => current.map(item => item.kind === 'task' && item.task.id === taskProjection.id && taskVersion(taskProjection) >= taskVersion(item.task)
			? { ...item, task: taskProjection }
			: item))
		const currentSummary = summaryRef.current
		if (currentSummary?.item.kind === 'task' && currentSummary.item.task.id === taskProjection.id && taskVersion(taskProjection) >= taskVersion(currentSummary.item.task)) {
			const next = { ...currentSummary, item: { ...currentSummary.item, task: taskProjection } as AgendaItem }
			summaryRef.current = next
			setSummary(next)
		}
	}, [taskProjection])

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
		const canonical = Array.from(new Map(loaded.map(item => [item.key, item])).values())
		setItems(current => mergeCalendarInventory(current, canonical, taskProjectionsRef.current, pendingItemKeysRef.current)); setPhase('ready')
	}, [environmentID, range.from.getTime(), range.to.getTime(), scopeFolderID, scopeListID]) // eslint-disable-line react-hooks/exhaustive-deps

	useEffect(() => { void loadAgenda(); return () => loadAbortRef.current?.abort() }, [loadAgenda])
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | null = null
		const unsubscribe = subscribeWebSocket((raw: unknown) => {
			const envelope = raw as { event?: string }
			if (!['task_update', 'task_overdue', 'work_event_update', 'work_event_invitation', 'work_event_rsvp'].includes(envelope.event || '')) return
			if (timer) clearTimeout(timer)
			timer = setTimeout(() => { void loadAgenda() }, 100)
		})
		return () => { if (timer) clearTimeout(timer); unsubscribe() }
	}, [loadAgenda])
	useEffect(() => () => { if (undoTimerRef.current) clearTimeout(undoTimerRef.current) }, [])
	const setItemPending = (key: string, pending: boolean) => {
		if (pending) pendingItemKeysRef.current.add(key); else pendingItemKeysRef.current.delete(key)
		setPendingItemKeys(Array.from(pendingItemKeysRef.current))
	}
	const replaceAgendaItem = (next: AgendaItem) => setItems(current => current.map(item => item.key === next.key && agendaItemVersion(next) >= agendaItemVersion(item) ? next : item))
	const storeUndo = (state: Omit<CalendarUndoState, 'expiresAt'>) => {
		if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
		const expiresAt = Date.now() + 8_000
		setUndoState({ ...state, expiresAt })
		undoTimerRef.current = setTimeout(() => { setUndoState(null); undoTimerRef.current = null }, 8_000)
	}
	const mutateCalendarSchedule = async (requestedItem: AgendaItem, nextSchedule: CalendarSchedule, options: { confirmConflicts?: boolean; recordUndo?: boolean; before?: CalendarSchedule; successLabel?: string } = {}) => {
		const visibleItem = itemsRef.current.find(item => item.key === requestedItem.key)
		const sourceItem = visibleItem && agendaItemVersion(visibleItem) >= agendaItemVersion(requestedItem) ? visibleItem : requestedItem
		const before = options.before || calendarItemSchedule(sourceItem)
		if (!before || !calendarScheduleChanged(before, nextSchedule) || pendingItemKeysRef.current.has(sourceItem.key)) return
		if (sourceItem.kind === 'task' && !canEditTask(sourceItem.task)) return
		if (sourceItem.kind === 'event' && (!sourceItem.event.event.capabilities.can_edit || !sourceItem.event.event.list_id)) return
		const optimistic = applyCalendarSchedule(sourceItem, nextSchedule)
		const operationID = crypto.randomUUID()
		setMutationError(''); setScheduleConflict(null); setInteractionPreview(null)
		setItemPending(sourceItem.key, true)
		replaceAgendaItem(optimistic)
		onOperation(operationID, true)
		try {
			const result = sourceItem.kind === 'task'
				? await apiPut<{ task?: Task; code?: string }>(`/api/tasks/${sourceItem.task.id}`, buildTaskSchedulePayload(sourceItem.task, nextSchedule, operationID))
				: await apiPut<{ event?: WorkEvent; code?: string }>(`/api/tasks/events/${sourceItem.event.event.id}`, buildEventSchedulePayload(sourceItem.event, nextSchedule, operationID, options.confirmConflicts))
			const response = result.data as { task?: Task; event?: WorkEvent; code?: string } | undefined
			const saved = sourceItem.kind === 'task' ? response?.task : response?.event
			if (!result.success || !saved) {
				replaceAgendaItem(sourceItem)
				if (response?.code === 'schedule_conflict_confirmation_required') {
					setScheduleConflict({ item: sourceItem, before, after: nextSchedule })
					setMutationError('El nuevo horario se cruza con otro compromiso. Restauramos el anterior hasta que confirmes.')
				} else {
					setMutationError(result.error || 'No se pudo guardar el cambio; restauramos el horario anterior.')
				}
				return
			}
			let canonical: AgendaItem
			if (sourceItem.kind === 'task') {
				const taskOptimistic = optimistic as Extract<AgendaItem, { kind: 'task' }>
				canonical = { ...taskOptimistic, task: saved as Task }
			} else {
				const eventOptimistic = optimistic as Extract<AgendaItem, { kind: 'event' }>
				canonical = { ...eventOptimistic, event: { ...eventOptimistic.event, event: saved as WorkEvent } }
			}
			replaceAgendaItem(canonical)
			if (options.recordUndo !== false) storeUndo({ item: canonical, before, after: nextSchedule })
			setAnnouncement(options.successLabel || `${eventTitle(sourceItem)} se reprogramó. Puedes deshacer el cambio.`)
		} catch {
			replaceAgendaItem(sourceItem)
			setMutationError('Se perdió la conexión mientras guardábamos. Restauramos exactamente el horario anterior.')
		} finally {
			setItemPending(sourceItem.key, false)
			onOperation(operationID, false)
		}
		await loadAgenda()
	}
	const commitCalendarInteraction = (item: AgendaItem, mode: CalendarInteractionMode, delta: CalendarInteractionDelta) => {
		const schedule = calendarItemSchedule(item)
		if (!schedule) return
		const next = calendarScheduleAfterInteraction(schedule, mode, delta)
		if (!calendarScheduleChanged(schedule, next)) return
		closeSummary(false)
		if (effectiveMode === 'day' && mode === 'move' && delta.days) setCursor(value => addDays(value, delta.days))
		void mutateCalendarSchedule(item, next, { before: schedule })
	}
	const previewCalendarInteraction = (item: AgendaItem, schedule: CalendarSchedule | null, point?: { x: number; y: number }) => {
		if (!schedule) { setInteractionPreview(current => current?.itemKey === item.key ? null : current); return }
		const label = calendarInteractionLabel(schedule)
		setInteractionPreview({ itemKey: item.key, title: eventTitle(item), label, point })
		setAnnouncement(`${eventTitle(item)}: ${label}`)
	}
	const autoScrollCalendar = (point: { x: number; y: number }, timed: boolean) => {
		const scroller = scrollRef.current
		if (!scroller) return
		const rect = scroller.getBoundingClientRect()
		if (timed && point.y < rect.top + 56) scroller.scrollTop -= 22
		else if (timed && point.y > rect.bottom - 56) scroller.scrollTop += 22
		if (point.x < rect.left + 40) scroller.scrollLeft -= 22
		else if (point.x > rect.right - 40) scroller.scrollLeft += 22
	}
	const interactionFor = (itemKey: string, surface: CalendarInteractionSurface, dayCount: number, allowResize = true): AgendaBlockInteraction => ({
		surface,
		dayCount,
		allowResize,
		pending: pendingItemKeys.includes(itemKey),
		onCommit: commitCalendarInteraction,
		onPreview: previewCalendarInteraction,
		onAutoScroll: point => autoScrollCalendar(point, surface === 'timed'),
	})
	const undoCalendarMutation = () => {
		const current = undoState
		if (!current) return
		if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
		undoTimerRef.current = null
		setUndoState(null)
		void mutateCalendarSchedule(current.item, current.before, { before: current.after, recordUndo: false, successLabel: `${eventTitle(current.item)} volvió a su horario anterior.` })
	}
	useEffect(() => {
		if (effectiveMode !== 'month' && scrollRef.current) requestAnimationFrame(() => { if (scrollRef.current) scrollRef.current.scrollTop = 7 * 60 - 20 })
	}, [effectiveMode])
	useEffect(() => {
		if (createEventToken === previousCreateToken.current) return
		previousCreateToken.current = createEventToken
		closeSummary(false)
		const start = new Date(); start.setMinutes(Math.ceil(start.getMinutes() / 30) * 30, 0, 0)
		setEditingEvent(null); setEditingOccurrence(null); setEventDraft({ startAt: start.toISOString(), endAt: new Date(start.getTime() + 60 * 60_000).toISOString(), allDay: false, listId: scopeListID }); setEventEditorOpen(true)
	}, [closeSummary, createEventToken, scopeListID])
	useEffect(() => {
		if (!focusEvent) return
		closeSummary(false)
		setCursor(new Date(focusEvent.start_at || `${focusEvent.start_date}T12:00:00`))
		setEditingEvent(focusEvent.event); setEditingOccurrence(focusEvent); setEventDraft(null); setEventEditorOpen(true)
	}, [focusEvent?.event.id, focusEvent?.occurrence_key]) // eslint-disable-line react-hooks/exhaustive-deps

	const dayItems = (day: Date) => items.filter(item => agendaItemOverlapsDay(item, day))
	const dismissCalendarLayers = (restoreFocus = true) => {
		closeSummary(restoreFocus)
		setMorePopover(null)
		setInteractionPreview(null)
	}
	const move = (direction: number) => { dismissCalendarLayers(); setCursor(value => { const next = new Date(value); if (mode === 'month') next.setMonth(next.getMonth() + direction); else if (mode === 'week') next.setDate(next.getDate() + direction * 7); else next.setDate(next.getDate() + direction); return next }) }
	const closeComposer = useCallback((restoreFocus = true) => {
		setComposer(null); setTitle(''); setError(''); setQuickConflict(false)
		const returnFocus = composerReturnFocusRef.current
		composerReturnFocusRef.current = null
		if (restoreFocus && returnFocus?.isConnected) window.requestAnimationFrame(() => returnFocus.focus({ preventScroll: true }))
	}, [])
	const openComposer = (date: Date, hour?: number, endHour?: number, returnFocus?: HTMLElement | null) => {
		if (!canCreate) return
		closeSummary(false)
		composerReturnFocusRef.current = returnFocus || (document.activeElement instanceof HTMLElement ? document.activeElement : null)
		const slot = calendarSlot(date, hour)
		if (hour !== undefined && endHour !== undefined) slot.dueAt = new Date(new Date(slot.startAt).setHours(endHour)).toISOString()
		setComposer({ ...slot, type: 'event' }); setListID(calendarDefaultList(scopeListID, lastListID, lists.map(list => list.id)))
		setOwnerID(currentUserID || users[0]?.id || ''); setTitle(''); setError(''); setQuickConflict(false)
	}
	useEffect(() => {
		if (!composer) return
		const handleEscape = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return
			const nestedLayerOpen = Boolean(document.querySelector('[data-task-picker-backdrop], [data-task-select-picker-portal], [data-task-user-combobox-portal], [data-task-property-picker-portal]'))
			if (!shouldCloseCalendarComposerOnEscape(event.defaultPrevented, nestedLayerOpen)) return
			event.preventDefault()
			event.stopPropagation()
			closeComposer()
		}
		window.addEventListener('keydown', handleEscape)
		return () => window.removeEventListener('keydown', handleEscape)
	}, [closeComposer, composer])
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
		closeComposer(false)
	}
	const editCalendarEvent = (event: WorkEvent, occurrence: WorkEventOccurrence) => {
		setEditingEvent(event); setEditingOccurrence(occurrence); setEventDraft(null); setEventEditorOpen(true)
	}

	const allDayVisibleLanes = width < 700 ? 2 : 3
	const allDayLaneCount = Math.min(allDayVisibleLanes, allDaySegments.reduce((maximum, segment) => Math.max(maximum, segment.lane + 1), 0))
	const allDayHasOverflow = allDaySegments.some(segment => segment.lane >= allDayVisibleLanes)
	const allDayRowHeight = Math.max(32, 8 + allDayLaneCount * 22 + (allDayHasOverflow ? 20 : 0))
	const currentTimeTop = (() => { const now = new Date(); return (now.getHours() * 60 + now.getMinutes()) })()
	return <div ref={containerRef} data-task-calendar className="relative flex h-full min-h-0 flex-col overflow-hidden border-y border-slate-200 bg-white">
		<header className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2 sm:px-4"><button onClick={() => move(-1)} aria-label="Periodo anterior" className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100"><ChevronLeft className="h-4 w-4" /></button><button onClick={() => { dismissCalendarLayers(); setCursor(new Date()) }} className="min-h-11 rounded-xl border border-slate-200 px-3 text-xs font-bold text-slate-600">Hoy</button><button onClick={() => move(1)} aria-label="Periodo siguiente" className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100"><ChevronRight className="h-4 w-4" /></button><div className="ml-1 min-w-0"><h3 className="truncate text-sm font-black capitalize text-slate-800">{cursor.toLocaleDateString('es', mode === 'month' ? { month: 'long', year: 'numeric' } : { day: 'numeric', month: 'long', year: 'numeric' })}</h3><p className="hidden text-[10px] font-semibold text-slate-500 sm:block">Tareas, proyectos y eventos</p></div><div className="ml-auto"><CalendarModePicker mode={mode} onBeforeOpen={() => dismissCalendarLayers(false)} onChange={nextMode => { dismissCalendarLayers(false); setMode(nextMode) }} /></div><button type="button" onClick={() => { dismissCalendarLayers(); void loadAgenda() }} aria-label="Actualizar calendario" className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100"><RefreshCw className={`h-4 w-4 ${phase === 'loading' ? 'animate-spin' : ''}`} /></button></header>
		{mode === 'week' && effectiveMode === 'day' && <div data-task-calendar-mobile-week className="flex gap-1 overflow-x-auto border-b border-slate-200 px-2 py-2">{weekDays.map(day => <button key={dateKey(day)} onClick={() => { dismissCalendarLayers(); setCursor(day) }} className={`min-w-[58px] rounded-xl px-2 py-2 text-center ${dateKey(day) === dateKey(cursor) ? 'bg-emerald-600 text-white' : 'bg-slate-50 text-slate-600'}`}><span className="block text-[9px] font-black uppercase">{day.toLocaleDateString('es', { weekday: 'short' })}</span><span className="text-sm font-black">{day.getDate()}</span></button>)}</div>}
		<div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto">
			{rangeNotice && <div role="status" className="sticky left-4 top-3 z-30 mx-4 mb-2 max-w-xl rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-xs font-semibold text-sky-800">{rangeNotice}</div>}
			{mutationError && <div role="alert" className="sticky left-4 top-3 z-40 mx-4 flex max-w-xl items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-semibold text-amber-800 shadow-lg"><span className="min-w-0 flex-1">{mutationError}</span>{scheduleConflict && <button type="button" onClick={() => void mutateCalendarSchedule(scheduleConflict.item, scheduleConflict.after, { before: scheduleConflict.before, confirmConflicts: true })} className="shrink-0 rounded-xl bg-amber-500 px-3 py-2 font-black text-white">Guardar de todos modos</button>}<button type="button" aria-label="Cerrar aviso" onClick={() => { setMutationError(''); setScheduleConflict(null) }} className="rounded-lg p-1 hover:bg-amber-100"><X className="h-4 w-4" /></button></div>}
			{phase === 'loading' && !items.length && <div className="flex h-full items-center justify-center gap-2 text-sm font-semibold text-slate-400"><Loader2 className="h-5 w-5 animate-spin text-emerald-500" />Preparando agenda…</div>}
			{phase === 'error' && <div className="absolute inset-x-4 top-4 z-30 flex items-center justify-between rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700"><span>{loadError}</span><button onClick={() => void loadAgenda()} className="rounded-xl bg-white px-3 py-2 font-bold">Reintentar</button></div>}
			{mode === 'month' && <div data-calendar-month-grid className="flex min-h-full min-w-[700px] flex-col">
				<div className="sticky top-0 z-20 grid h-[34px] shrink-0 grid-cols-7 bg-white/95 backdrop-blur">{['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'].map(day => <div key={day} className="flex items-center justify-center border-b border-r border-slate-200 text-[10px] font-black uppercase text-slate-500">{day}</div>)}</div>
				<div className="grid min-h-[660px] flex-1 grid-rows-6">{Array.from({ length: 6 }, (_, weekIndex) => {
					const weekOffset = weekIndex * 7
					const days = monthDays.slice(weekOffset, weekOffset + 7)
					const segments = monthSegments.filter(segment => segment.weekIndex === weekIndex)
					const visibleLanes = width < 900 ? 2 : 3
					return <div key={`month-week:${weekIndex}`} data-calendar-month-week={weekIndex} className="relative grid min-h-[110px] grid-cols-7">
						{days.map((day, dayOffset) => {
							const visible = dayItems(day)
							const activeMonth = day.getMonth() === cursor.getMonth()
							const today = dateKey(day) === dateKey(new Date())
							const overflow = calendarSpanOverflowCount(segments, weekOffset + dayOffset, visibleLanes)
							return <div key={dateKey(day)} data-calendar-month-day={dateKey(day)} role={canCreate ? 'button' : undefined} tabIndex={canCreate ? 0 : -1} onClick={event => openComposer(day, undefined, undefined, event.currentTarget)} onKeyDown={event => { if (canCreate && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openComposer(day, undefined, undefined, event.currentTarget) } }} className={`group relative min-h-[110px] border-b border-r border-slate-200 p-1.5 text-left transition ${canCreate ? 'cursor-pointer hover:bg-emerald-50/40' : ''} ${activeMonth ? 'bg-white' : 'bg-slate-50/70'}`}>
								<div className="flex items-center justify-between"><span className={`flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-bold ${today ? 'bg-emerald-600 text-white' : activeMonth ? 'text-slate-600' : 'text-slate-300'}`}>{day.getDate()}</span>{canCreate && <Plus className="h-3.5 w-3.5 text-emerald-500 opacity-0 transition group-hover:opacity-100" />}</div>
								{overflow > 0 && <button type="button" onClick={event => { event.stopPropagation(); setMorePopover({ anchor: event.currentTarget.getBoundingClientRect(), returnFocus: event.currentTarget, items: visible, day }) }} className="absolute bottom-1 left-1.5 z-10 min-h-6 rounded-lg bg-white/90 px-1.5 text-[9px] font-black text-slate-500 shadow-sm hover:bg-slate-100">+{overflow} más</button>}
							</div>
						})}
						<CalendarSpanLayer segments={segments} lists={lists} surface="month" dayCount={7} visibleLanes={visibleLanes} weekOffset={weekOffset} activeTaskId={activeTaskId} onOpen={showSummary} interactionFor={interactionFor} />
					</div>
				})}</div>
			</div>}
			{mode !== 'month' && <div className={`grid min-w-0 ${effectiveMode === 'week' ? 'grid-cols-[58px_repeat(7,minmax(110px,1fr))]' : 'grid-cols-[58px_minmax(260px,1fr)]'}`}>
				<div className="sticky left-0 top-0 z-20 border-b border-r border-slate-200 bg-white" />
				{visibleDays.map(day => <div key={`head:${dateKey(day)}`} className="sticky top-0 z-20 border-b border-r border-slate-200 bg-white/95 p-2 text-center backdrop-blur"><p className="text-[10px] font-black uppercase text-slate-500">{day.toLocaleDateString('es', { weekday: 'short' })}</p><p className={`mx-auto flex h-8 w-8 items-center justify-center rounded-full text-sm font-black ${dateKey(day) === dateKey(new Date()) ? 'bg-emerald-600 text-white' : 'text-slate-700'}`}>{day.getDate()}</p></div>)}
				<div className="sticky left-0 top-[64px] z-[16] border-b border-r border-slate-200 bg-white px-1 py-2 text-right text-[9px] font-black uppercase text-slate-500 shadow-[0_4px_8px_-8px_rgba(15,23,42,.45)]">Todo<br />el día</div>
				<div data-calendar-all-day-grid className="sticky top-[64px] z-[15] border-b border-slate-200 bg-slate-50/95 shadow-[0_4px_8px_-8px_rgba(15,23,42,.45)] backdrop-blur" style={{ gridColumn: `2 / span ${visibleDays.length}`, minHeight: allDayRowHeight }}>
					<div className="absolute inset-0 grid" style={{ gridTemplateColumns: `repeat(${visibleDays.length}, minmax(0, 1fr))` }}>{visibleDays.map((day, dayIndex) => {
						const visible = dayItems(day).filter(item => calendarItemSchedule(item)?.allDay)
						const overflow = calendarSpanOverflowCount(allDaySegments, dayIndex, allDayVisibleLanes)
						return <div key={`all:${dateKey(day)}`} data-calendar-all-day={dateKey(day)} role={canCreate ? 'button' : undefined} tabIndex={canCreate ? 0 : -1} onClick={event => openComposer(day, undefined, undefined, event.currentTarget)} onKeyDown={event => { if (canCreate && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openComposer(day, undefined, undefined, event.currentTarget) } }} className={`relative border-r border-slate-200 ${canCreate ? 'cursor-pointer hover:bg-emerald-50/40' : ''}`}>
							{overflow > 0 && <button type="button" onClick={event => { event.stopPropagation(); setMorePopover({ anchor: event.currentTarget.getBoundingClientRect(), returnFocus: event.currentTarget, items: visible, day }) }} className="absolute bottom-0.5 left-1 z-10 min-h-5 rounded-md bg-white/90 px-1.5 text-[9px] font-black text-slate-500 shadow-sm hover:bg-slate-100">+{overflow} más</button>}
						</div>
					})}</div>
					<CalendarSpanLayer segments={allDaySegments} lists={lists} surface="all-day" dayCount={visibleDays.length} visibleLanes={allDayVisibleLanes} weekOffset={0} activeTaskId={activeTaskId} top={4} onOpen={showSummary} interactionFor={interactionFor} />
				</div>
				<div className="sticky left-0 z-10 h-[1440px] border-r border-slate-200 bg-white">{hours.map(hour => <div key={hour} className="h-[60px] border-t border-slate-200 pr-2 pt-1 text-right text-[10px] font-semibold text-slate-500">{String(hour).padStart(2, '0')}:00</div>)}</div>
				{visibleDays.map(day => {
					const layouts = layoutTimedAgendaItems(items, day)
					const isToday = dateKey(day) === dateKey(new Date())
					return <div key={`body:${dateKey(day)}`} data-calendar-time-column={dateKey(day)} tabIndex={canCreate ? 0 : -1} className="relative h-[1440px] border-r border-slate-200 bg-[linear-gradient(to_bottom,transparent_29px,#f1f5f9_30px,transparent_31px,transparent_59px,#e2e8f0_60px)] bg-[length:100%_60px]" onDoubleClick={event => { const rect = event.currentTarget.getBoundingClientRect(); const minutes = Math.max(0, Math.min(1439, event.clientY - rect.top)); openComposer(day, Math.floor(minutes / 60), undefined, event.currentTarget) }} onPointerDown={event => { if (!canCreate || (event.target as HTMLElement).closest('button')) return; const rect = event.currentTarget.getBoundingClientRect(); const start = Math.floor(Math.max(0, Math.min(1439, event.clientY - rect.top)) / 15) * 15; (event.currentTarget as HTMLElement).dataset.dragStart = String(start); event.currentTarget.setPointerCapture(event.pointerId) }} onPointerUp={(event: ReactPointerEvent<HTMLDivElement>) => { const raw = event.currentTarget.dataset.dragStart; delete event.currentTarget.dataset.dragStart; if (raw === undefined) return; const rect = event.currentTarget.getBoundingClientRect(); const start = Number(raw); const finish = Math.floor(Math.max(0, Math.min(1440, event.clientY - rect.top)) / 15) * 15; const low = Math.min(start, finish); const high = Math.max(start + 30, finish); const slotDate = new Date(day); slotDate.setHours(Math.floor(low / 60), low % 60, 0, 0); const endDate = new Date(day); endDate.setHours(Math.floor(high / 60), high % 60, 0, 0); composerReturnFocusRef.current = event.currentTarget; setComposer({ startAt: slotDate.toISOString(), dueAt: endDate.toISOString(), allDay: false, type: 'event' }); setListID(calendarDefaultList(scopeListID, lastListID, lists.map(list => list.id))); setTitle(''); setError('') }}>
						{isToday && <div aria-hidden className="pointer-events-none absolute inset-x-0 z-20 border-t-2 border-rose-500" style={{ top: currentTimeTop }}><span className="absolute -left-1 -top-1.5 h-3 w-3 rounded-full bg-rose-500" /></div>}
						{layouts.map(layout => { const left = layout.lane / layout.laneCount * 100; const widthPercent = 100 / layout.laneCount; return <AgendaBlock key={`${layout.item.key}:${dateKey(day)}`} item={layout.item} lists={lists} activeTaskId={activeTaskId} onOpen={(anchor, trigger) => showSummary(layout.item, anchor, trigger)} interaction={interactionFor(layout.item.key, 'timed', visibleDays.length, true)} style={{ position: 'absolute', top: layout.top + 2, height: Math.max(26, layout.height - 3), left: `calc(${left}% + 3px)`, width: `calc(${widthPercent}% - 6px)`, zIndex: 5 + layout.lane }} /> })}
					</div>
				})}
			</div>}
		</div>
		<div className="sr-only" aria-live="polite">{announcement}</div>
		{interactionPreview && typeof document !== 'undefined' && createPortal(<div data-calendar-drag-preview role="status" style={{ zIndex: TASK_OVERLAY_LAYERS.dragGhost, ...(interactionPreview.point ? { left: Math.max(12, Math.min(interactionPreview.point.x + 14, window.innerWidth - 292)), top: Math.max(12, Math.min(interactionPreview.point.y + 14, window.innerHeight - 82)) } : { right: 16, bottom: 78 }) }} className="pointer-events-none fixed w-[276px] max-w-[calc(100vw-24px)] rounded-2xl border border-emerald-300 bg-white/95 px-3 py-2.5 shadow-2xl shadow-slate-900/20 backdrop-blur motion-reduce:transition-none"><p className="truncate text-xs font-black text-slate-900">{interactionPreview.title}</p><p className="mt-0.5 text-[10px] font-bold text-emerald-700">{interactionPreview.label}</p></div>, document.body)}
		{undoState && typeof document !== 'undefined' && createPortal(<div data-calendar-undo role="status" style={{ zIndex: TASK_OVERLAY_LAYERS.toast }} className="fixed bottom-[max(16px,env(safe-area-inset-bottom))] left-1/2 flex w-[min(440px,calc(100vw-24px))] -translate-x-1/2 items-center gap-3 rounded-2xl border border-slate-700 bg-slate-900 px-4 py-3 text-white shadow-2xl"><span className="min-w-0 flex-1 truncate text-xs font-bold">Horario actualizado</span><button type="button" onClick={undoCalendarMutation} className="inline-flex min-h-10 shrink-0 items-center gap-2 rounded-xl bg-white/10 px-3 text-xs font-black text-emerald-300 hover:bg-white/15 focus:outline-none focus:ring-2 focus:ring-emerald-300"><Undo2 className="h-3.5 w-3.5" />Deshacer</button></div>, document.body)}
		{morePopover && <CalendarMorePopover {...morePopover} lists={lists} activeTaskId={activeTaskId} onOpen={showSummary} onClose={() => setMorePopover(null)} />}
		{summary && <CalendarItemSummary item={summary.item} lists={lists} anchor={summary.anchor} anchorElement={summary.anchorElement} onClose={closeSummary} onOpenTaskDetail={onOpenTaskDetail} onEditTask={onEditTask} onEditEvent={editCalendarEvent} />}
		{composer && <div className="fixed inset-0 z-[145] flex items-center justify-center bg-slate-950/25 p-4 backdrop-blur-[2px]" onMouseDown={event => event.target === event.currentTarget && closeComposer()}>
			<div role="dialog" aria-modal="true" aria-labelledby="calendar-composer-title" className="w-full max-w-lg rounded-3xl border border-slate-200 bg-white p-5 shadow-2xl">
				<div className="flex items-start justify-between"><div><p className="text-[10px] font-black uppercase tracking-[.16em] text-emerald-600">Calendario</p><h2 id="calendar-composer-title" className="mt-1 text-lg font-black text-slate-900">Crear en este horario</h2><p className="mt-1 text-xs text-slate-400">{new Date(composer.startAt).toLocaleString('es', composer.allDay ? { dateStyle: 'full' } : { dateStyle: 'medium', timeStyle: 'short' })}</p></div><button onClick={() => closeComposer()} className="rounded-xl p-2 text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button></div>
				<div className="mt-4 flex rounded-xl bg-slate-100 p-1"><button onClick={() => { setQuickConflict(false); setComposer(current => current ? { ...current, type: 'event' } : null) }} className={`min-h-9 flex-1 rounded-lg text-xs font-black ${composer.type === 'event' ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-500'}`}>Evento</button><button onClick={() => { setQuickConflict(false); setComposer(current => current ? { ...current, type: 'task' } : null) }} className={`min-h-9 flex-1 rounded-lg text-xs font-black ${composer.type === 'task' ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-500'}`}>Tarea</button></div>
				<input autoFocus value={title} onChange={event => { setTitle(event.target.value); setQuickConflict(false) }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void createQuick(quickConflict) } }} placeholder={composer.type === 'event' ? 'Nombre del evento' : '¿Qué hay que lograr?'} className="mt-4 w-full rounded-2xl border border-slate-200 px-4 py-3 text-base font-semibold outline-none focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100" />
				<div className={`mt-3 grid gap-3 ${composer.type === 'task' ? 'sm:grid-cols-2' : ''}`}><TaskListPicker value={listID} lists={lists} folders={folders} onChange={value => { setListID(value); setQuickConflict(false) }} />{composer.type === 'task' && <TaskUserCombobox users={users} value={ownerID} onChange={setOwnerID} />}</div>
				{selectedList && <p className="mt-2 text-[10px] text-slate-400">Destino: {selectedList.folder_id ? `${folderByID.get(selectedList.folder_id)?.name || 'Carpeta'} / ` : ''}{selectedList.name}</p>}
				{error && <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">{error}</p>}
				<div className="mt-5 flex flex-wrap justify-end gap-2"><button onClick={more} className="min-h-11 rounded-xl px-4 text-sm font-bold text-slate-600 hover:bg-slate-100">Abrir formulario completo</button><button disabled={!title.trim() || !selectedList || (composer.type === 'task' && (!status || !ownerID)) || saving} onClick={() => void createQuick(quickConflict)} className={`inline-flex min-h-11 items-center gap-2 rounded-xl px-4 text-sm font-black text-white shadow-lg disabled:opacity-40 ${quickConflict && composer.type === 'event' ? 'bg-amber-500 shadow-amber-100 hover:bg-amber-600' : 'bg-emerald-600 shadow-emerald-100 hover:bg-emerald-700'}`}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : composer.type === 'event' ? <CalendarDays className="h-4 w-4" /> : <Plus className="h-4 w-4" />}{quickConflict && composer.type === 'event' ? 'Guardar de todos modos' : 'Crear'}</button></div>
			</div>
		</div>}
		<WorkEventEditor open={eventEditorOpen} event={editingEvent} occurrence={editingOccurrence} draft={eventDraft} lists={lists} folders={folders} users={users} currentUserID={currentUserID} defaultListID={scopeListID || lists.find(list => list.is_default)?.id} storageScope={storageScope} onClose={() => { setEventEditorOpen(false); setEditingEvent(null); setEditingOccurrence(null); setEventDraft(null) }} onSaved={() => { void loadAgenda() }} onDeleted={() => { void loadAgenda() }} />
	</div>
}
