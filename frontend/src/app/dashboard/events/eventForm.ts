export function isEventContextReadOnly(status?: string) {
  return status === 'completed' || status === 'cancelled'
}

/** datetime-local owns the browser's local wall time, never a UTC substring. */
export function eventLocalDateTime(value?: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (number: number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function eventDateTimePayload(value: string, original?: string | null): string | null {
  if (!value) return null
  // Preserve seconds/milliseconds and ambiguous DST instants when unchanged.
  if (original && eventLocalDateTime(original) === value) return original
  const date = new Date(value)
  if (Number.isNaN(date.getTime()) || eventLocalDateTime(date.toISOString()) !== value) {
    throw new Error('La fecha u hora del evento no es válida')
  }
  return date.toISOString()
}

type EventDateDraft = {
  event_date: string
  event_end: string
  description: string
  location: string
}

export function eventDetailPayload(draft: EventDateDraft, original?: { event_date?: string | null; event_end?: string | null }) {
  const event_date = eventDateTimePayload(draft.event_date, original?.event_date)
  const event_end = eventDateTimePayload(draft.event_end, original?.event_end)
  if (event_date && event_end && Date.parse(event_end) < Date.parse(event_date)) {
    throw new Error('La fecha de fin debe ser igual o posterior a la fecha de inicio')
  }
  return {
    event_date,
    event_end,
    description: draft.description.trim() ? draft.description : null,
    location: draft.location.trim() ? draft.location : null,
  }
}

type LogbookSettingsDraft = { title: string; date: string; status: string }

/** Compare against the immutable editor baseline, not a later server snapshot. */
export function logbookSettingsPatch(draft: LogbookSettingsDraft, initial: LogbookSettingsDraft): Record<string, string> {
  const patch: Record<string, string> = {}
  if (draft.title.trim() !== initial.title.trim()) patch.title = draft.title.trim()
  if (draft.date !== initial.date) patch.date = draft.date
  if (draft.status !== initial.status) patch.status = draft.status
  return patch
}

export async function readLogbookMutation<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.success === false) {
    throw new Error(data.error || 'No se pudo guardar la bitácora. Vuelve a intentarlo.')
  }
  return data as T
}
