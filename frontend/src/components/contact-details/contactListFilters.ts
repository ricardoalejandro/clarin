import type { CustomFieldFilter } from '@/types/custom-field'

export interface ContactListFilters {
  deviceId: string
  tagNames: string[]
  excludedTagNames: string[]
  tagMode: 'OR' | 'AND'
  formulaType: 'simple' | 'advanced'
  formulaText: string
  dateField: 'created_at' | 'updated_at'
  datePreset: string
  dateFrom: string
  dateTo: string
  customFields: CustomFieldFilter[]
}
export const emptyContactListFilters = (): ContactListFilters => ({ deviceId: '', tagNames: [], excludedTagNames: [], tagMode: 'OR', formulaType: 'simple', formulaText: '', dateField: 'created_at', datePreset: '', dateFrom: '', dateTo: '', customFields: [] })

/** Shared by list, filtered export and campaign audience. Draft controls never reach it. */
export function contactFilterParams(filters: ContactListFilters, search = '') {
  const params = new URLSearchParams()
  if (search) params.set('search', search)
  if (filters.deviceId) params.set('device_id', filters.deviceId)
  if (filters.formulaType === 'advanced' && filters.formulaText) params.set('tag_formula', filters.formulaText)
  else {
    if (filters.tagNames.length) params.set('tag_names', [...filters.tagNames].sort().join(','))
    if (filters.excludedTagNames.length) params.set('exclude_tag_names', [...filters.excludedTagNames].sort().join(','))
    if (filters.tagNames.length || filters.excludedTagNames.length) params.set('tag_mode', filters.tagMode)
  }
  if (filters.datePreset) {
    params.set('date_field', filters.dateField)
    if (filters.dateFrom) params.set('date_from', filters.dateFrom)
    if (filters.dateTo) params.set('date_to', filters.dateTo)
  }
  if (filters.customFields.length) params.set('cf_filter', JSON.stringify(filters.customFields))
  return params
}
export function contactFilterCount(filters: ContactListFilters) {
  return filters.tagNames.length + filters.excludedTagNames.length + Number(Boolean(filters.deviceId)) + Number(filters.formulaType === 'advanced' && Boolean(filters.formulaText)) + Number(Boolean(filters.datePreset)) + filters.customFields.length
}
