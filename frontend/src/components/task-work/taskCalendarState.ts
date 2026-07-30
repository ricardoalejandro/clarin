export type TaskCalendarMode = 'month' | 'week' | 'day'

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
