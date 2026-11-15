import { operationalDateLocalValue, operationalDateValue } from '../operational-date/operationalDate'

/** Date-only event boundaries never pass through UTC. */
export function shiftWorkEventDate(value: string | undefined, days: number) {
  if (!value) return ''
  const date = operationalDateValue(value.slice(0, 10), 'date')
  if (!date) return ''
  date.setDate(date.getDate() + days)
  return operationalDateLocalValue(date, 'date')
}
export const inclusiveWorkEventEnd = (value?: string) => shiftWorkEventDate(value, -1)
export const exclusiveWorkEventEnd = (value: string) => shiftWorkEventDate(value, 1)
