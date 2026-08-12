import type { AgendaItem } from '@/types/task'

export interface CalendarInterval {
	start: Date
	end: Date
	allDay: boolean
}

export function agendaItemInterval(item: AgendaItem): CalendarInterval | null {
	if (item.kind === 'task') {
		const startRaw = item.task.start_at || item.task.due_at
		const endRaw = item.task.due_end_at || item.task.due_at || item.task.start_at
		if (!startRaw || !endRaw) return null
		const start = new Date(startRaw); const end = new Date(endRaw)
		if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null
		return { start, end: end > start ? end : new Date(start.getTime() + 30 * 60_000), allDay: Boolean(item.task.is_all_day) }
	}
	const occurrence = item.event
	if (occurrence.start_date && occurrence.end_date_exclusive) {
		return { start: new Date(`${occurrence.start_date}T00:00:00`), end: new Date(`${occurrence.end_date_exclusive}T00:00:00`), allDay: true }
	}
	if (!occurrence.start_at || !occurrence.end_at) return null
	const start = new Date(occurrence.start_at); const end = new Date(occurrence.end_at)
	if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null
	return { start, end, allDay: false }
}

export function agendaItemOverlapsDay(item: AgendaItem, day: Date) {
	const interval = agendaItemInterval(item)
	if (!interval) return false
	const start = new Date(day); start.setHours(0, 0, 0, 0)
	const end = new Date(start); end.setDate(end.getDate() + 1)
	return interval.start < end && interval.end > start
}

export interface TimedAgendaLayout {
	item: AgendaItem
	top: number
	height: number
	lane: number
	laneCount: number
}

export function layoutTimedAgendaItems(items: AgendaItem[], day: Date, pixelsPerHour = 60): TimedAgendaLayout[] {
	const dayStart = new Date(day); dayStart.setHours(0, 0, 0, 0)
	const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1)
	const intervals = items.map(item => ({ item, interval: agendaItemInterval(item) }))
		.filter((entry): entry is { item: AgendaItem; interval: CalendarInterval } => Boolean(entry.interval && !entry.interval.allDay && entry.interval.start < dayEnd && entry.interval.end > dayStart))
		.map(entry => ({ ...entry, start: new Date(Math.max(entry.interval.start.getTime(), dayStart.getTime())), end: new Date(Math.min(entry.interval.end.getTime(), dayEnd.getTime())) }))
		.sort((left, right) => left.start.getTime() - right.start.getTime() || right.end.getTime() - left.end.getTime())
	const active: Array<{ end: number; lane: number }> = []
	const result: Array<TimedAgendaLayout & { startMs: number; endMs: number }> = []
	for (const entry of intervals) {
		for (let index = active.length - 1; index >= 0; index--) if (active[index].end <= entry.start.getTime()) active.splice(index, 1)
		const used = new Set(active.map(item => item.lane))
		let lane = 0; while (used.has(lane)) lane++
		active.push({ end: entry.end.getTime(), lane })
		const minutes = (entry.start.getTime() - dayStart.getTime()) / 60_000
		const duration = Math.max(24, (entry.end.getTime() - entry.start.getTime()) / 60_000 / 60 * pixelsPerHour)
		result.push({ item: entry.item, top: minutes / 60 * pixelsPerHour, height: duration, lane, laneCount: 1, startMs: entry.start.getTime(), endMs: entry.end.getTime() })
	}
	for (const current of result) {
		current.laneCount = Math.max(1, ...result.filter(other => other.startMs < current.endMs && other.endMs > current.startMs).map(other => other.lane + 1))
	}
	return result.map(({ startMs: _start, endMs: _end, ...item }) => item)
}
