export function taskDateValue(value?: string) {
  if (!value) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

export function taskDateLocalValue(date: Date | null) {
  if (!date) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function taskDateQuickValue(kind: 'today' | 'tomorrow' | 'next_week', now = new Date()) {
  const next = new Date(now)
  if (kind === 'tomorrow') next.setDate(next.getDate() + 1)
  if (kind === 'next_week') next.setDate(next.getDate() + 7)
  next.setSeconds(0, 0)
  return next
}

export function taskDateRangeValid(start?: string, due?: string) {
  if (!start || !due) return true
  const startDate = taskDateValue(start)
  const dueDate = taskDateValue(due)
  return Boolean(startDate && dueDate && dueDate >= startDate)
}
