import {
  operationalDateLocalValue,
  operationalDateQuickValue,
  operationalDateRangeValid,
  operationalDateValue,
} from '../operational-date/operationalDate'

export function taskDateValue(value?: string) {
  return operationalDateValue(value, 'datetime')
}

export function taskDateLocalValue(date: Date | null) {
  return operationalDateLocalValue(date, 'datetime')
}

export function taskDateQuickValue(kind: 'today' | 'tomorrow' | 'next_week', now = new Date()) {
  return operationalDateQuickValue(kind, now)
}

export function taskDateRangeValid(start?: string, due?: string) {
  return operationalDateRangeValid(start, due)
}
