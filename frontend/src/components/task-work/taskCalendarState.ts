export type TaskCalendarMode = 'month' | 'week' | 'day'

export type CalendarViewport = { left: number; top: number; width: number; height: number }
export type CalendarFloatingRect = { left: number; top: number; width: number; height: number }

export const TASK_CALENDAR_MODE_LABELS: Record<TaskCalendarMode, string> = {
  month: 'Mes',
  week: 'Semana',
  day: 'Día',
}

export function calendarPopoverPosition(
  anchor: CalendarFloatingRect,
  panel: { width: number; height: number },
  viewport: CalendarViewport,
  padding = 12,
  gap = 8,
) {
  const viewportRight = viewport.left + viewport.width
  const viewportBottom = viewport.top + viewport.height
  const anchorBottom = anchor.top + anchor.height
  const below = anchorBottom + gap
  const above = anchor.top - panel.height - gap
  const top = below + panel.height <= viewportBottom - padding
    ? below
    : Math.max(viewport.top + padding, above)
  const centered = anchor.left + anchor.width / 2 - panel.width / 2
  const left = Math.min(
    Math.max(viewport.left + padding, centered),
    Math.max(viewport.left + padding, viewportRight - panel.width - padding),
  )
  return { left: Math.round(left), top: Math.round(top) }
}

export function calendarSlot(date: Date, hour?: number) {
  const start = new Date(date)
  start.setHours(hour ?? 0, 0, 0, 0)
  const end = new Date(start)
  if (hour === undefined) end.setHours(23, 59, 0, 0)
  else end.setHours(end.getHours() + 1)
  return { startAt: start.toISOString(), dueAt: end.toISOString(), allDay: hour === undefined }
}

export function calendarDefaultList(scopeListID: string | undefined, lastListID: string | undefined, availableIDs: string[]) {
  if (scopeListID && availableIDs.includes(scopeListID)) return scopeListID
  if (lastListID && availableIDs.includes(lastListID)) return lastListID
  return availableIDs[0] || ''
}

export function shouldCloseCalendarComposerOnEscape(defaultPrevented: boolean, nestedLayerOpen: boolean) {
  return !defaultPrevented && !nestedLayerOpen
}
