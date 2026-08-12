import { describe, expect, it } from 'vitest'
import type { AgendaItem, Task } from '@/types/task'
import { agendaItemOverlapsDay, layoutTimedAgendaItems } from './calendarAgendaLayout'

const task = (id: string, start: string, end: string): AgendaItem => ({ kind: 'task', key: `task:${id}`, task: { id, title: id, start_at: start, due_at: end } as Task })

describe('calendar agenda layout', () => {
	it('keeps multi-day intervals visible on every overlapping day', () => {
		const item = task('one', '2026-08-10T18:00:00Z', '2026-08-12T10:00:00Z')
		expect(agendaItemOverlapsDay(item, new Date('2026-08-11T12:00:00'))).toBe(true)
		expect(agendaItemOverlapsDay(item, new Date('2026-08-13T12:00:00'))).toBe(false)
	})

	it('allocates independent lanes to overlapping blocks', () => {
		const day = new Date('2026-08-10T12:00:00')
		const result = layoutTimedAgendaItems([
			task('one', '2026-08-10T09:00:00', '2026-08-10T11:00:00'),
			task('two', '2026-08-10T10:00:00', '2026-08-10T10:30:00'),
			task('three', '2026-08-10T12:00:00', '2026-08-10T13:00:00'),
		], day)
		expect(result.find(item => item.item.key === 'task:one')?.laneCount).toBe(2)
		expect(result.find(item => item.item.key === 'task:two')?.lane).toBe(1)
		expect(result.find(item => item.item.key === 'task:three')?.lane).toBe(0)
	})
})
