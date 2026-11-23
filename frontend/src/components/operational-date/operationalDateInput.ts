import { operationalDateLocalValue, operationalDateValue, operationalDateWithinRange, type OperationalDatePickerMode } from './operationalDate'

export interface OperationalDateDraftState {
  value: string | null
  valid: boolean
  dirty: boolean
  inputId: string
  message: string
  active?: boolean
}

export function operationalDateFieldStacked(width: number, mode: OperationalDatePickerMode) {
  return mode === 'datetime' && width > 0 && width < 240
}

export function operationalDateInputText(value: string, mode: OperationalDatePickerMode) {
  const date = operationalDateValue(value, mode)
  if (!date) return { dateText: '', timeText: '' }
  const day = operationalDateLocalValue(date, 'date').split('-')
  const clock = value.includes('T') ? operationalDateValue(value, 'datetime') || date : date
  return { dateText: `${day[2]}/${day[1]}/${day[0]}`, timeText: `${String(clock.getHours()).padStart(2, '0')}:${String(clock.getMinutes()).padStart(2, '0')}` }
}

export function operationalDateInputValue(
  dateText: string,
  timeText: string,
  mode: OperationalDatePickerMode,
  options: { required?: boolean; min?: string; max?: string } = {},
): Pick<OperationalDateDraftState, 'value' | 'valid' | 'message'> {
  const text = dateText.trim()
  const fail = (message: string) => ({ value: null, valid: false, message })
  if (!text) {
    if (mode === 'datetime' && timeText.trim()) return fail('Completa la fecha.')
    return options.required ? fail('Completa la fecha.') : { value: '', valid: true, message: '' }
  }
  const localized = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!localized && !iso) return fail('Escribe una fecha completa: DD/MM/AAAA.')
  const value = localized ? `${localized[3]}-${localized[2].padStart(2, '0')}-${localized[1].padStart(2, '0')}` : text
  const date = operationalDateValue(value, 'date')
  if (!date) return fail('La fecha no existe. Revisa el día, mes y año.')
  if (!operationalDateWithinRange(date, options.min, options.max)) return fail('La fecha está fuera del intervalo permitido.')
  if (mode === 'date') return { value, valid: true, message: '' }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(timeText.trim())) return fail('Completa la hora: HH:mm (00:00–23:59).')
  const datetime = `${value}T${timeText.trim()}`
  if (!operationalDateValue(datetime, 'datetime')) return fail('La hora no es válida en esta fecha.')
  return { value: datetime, valid: true, message: '' }
}
