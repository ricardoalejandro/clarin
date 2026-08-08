export type OperationalDatePickerMode = 'date' | 'datetime'

export type OperationalDateViewport = {
  left: number
  top: number
  width: number
  height: number
}

export type OperationalDateRect = {
  left: number
  right: number
  top: number
  bottom: number
}

export type OperationalDatePickerGeometry = {
  left: number
  top: number
  width: number
  maxHeight: number
  placement: 'above' | 'below'
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const LOCAL_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/

function validLocalDate(year: number, month: number, day: number, hours = 0, minutes = 0, seconds = 0) {
  const date = new Date(year, month - 1, day, hours, minutes, seconds, 0)
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
    || date.getHours() !== hours
    || date.getMinutes() !== minutes
  ) return null
  return date
}

export function operationalDateValue(value: string | undefined, mode: OperationalDatePickerMode) {
  if (!value) return null
  if (mode === 'date') {
    const match = value.slice(0, 10).match(DATE_PATTERN)
    if (!match) return null
    return validLocalDate(Number(match[1]), Number(match[2]), Number(match[3]))
  }
  const localMatch = value.match(LOCAL_DATETIME_PATTERN)
  if (localMatch) {
    return validLocalDate(
      Number(localMatch[1]),
      Number(localMatch[2]),
      Number(localMatch[3]),
      Number(localMatch[4]),
      Number(localMatch[5]),
      Number(localMatch[6] || 0),
    )
  }
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed : null
}

export function operationalDateLocalValue(date: Date | null, mode: OperationalDatePickerMode) {
  if (!date) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  if (mode === 'date') return day
  return `${day}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function operationalDateQuickValue(kind: 'today' | 'tomorrow' | 'next_week', now = new Date()) {
  const next = new Date(now)
  if (kind === 'tomorrow') next.setDate(next.getDate() + 1)
  if (kind === 'next_week') next.setDate(next.getDate() + 7)
  next.setSeconds(0, 0)
  return next
}

export function operationalDateRangeValid(start?: string, due?: string) {
  if (!start || !due) return true
  const startDate = operationalDateValue(start, 'datetime')
  const dueDate = operationalDateValue(due, 'datetime')
  return Boolean(startDate && dueDate && dueDate >= startDate)
}

export function operationalDateDayKey(date: Date) {
  return operationalDateLocalValue(date, 'date')
}

export function operationalDateWithinRange(date: Date, min?: string, max?: string) {
  const candidate = operationalDateDayKey(date)
  const minimum = operationalDateValue(min, 'date')
  const maximum = operationalDateValue(max, 'date')
  if (minimum && candidate < operationalDateDayKey(minimum)) return false
  if (maximum && candidate > operationalDateDayKey(maximum)) return false
  return true
}

export function operationalDatePickerGeometry(
  trigger: OperationalDateRect,
  viewport: OperationalDateViewport,
  panel: { width: number; height: number },
  margin = 12,
): OperationalDatePickerGeometry {
  const viewportRight = viewport.left + viewport.width
  const viewportBottom = viewport.top + viewport.height
  const width = Math.max(1, Math.min(panel.width, viewport.width - margin * 2))
  const maxHeight = Math.max(1, viewport.height - margin * 2)
  const effectiveHeight = Math.min(panel.height, maxHeight)
  const belowSpace = viewportBottom - trigger.bottom - 8
  const aboveSpace = trigger.top - viewport.top - 8
  const placement = belowSpace >= effectiveHeight || belowSpace >= aboveSpace ? 'below' : 'above'
  const preferredTop = placement === 'below' ? trigger.bottom + 8 : trigger.top - effectiveHeight - 8
  const top = Math.max(viewport.top + margin, Math.min(preferredTop, viewportBottom - effectiveHeight - margin))
  const left = Math.max(viewport.left + margin, Math.min(trigger.left, viewportRight - width - margin))
  return { left, top, width, maxHeight, placement }
}
