'use client'

import { useCallback, useState, type Dispatch, type SetStateAction } from 'react'
import type { CustomFieldFilter } from '@/types/custom-field'

// Spreads preserve this local identity; JSON and structuredClone omit symbol keys.
// It never becomes part of a query, saved filter or API payload.
const rowIdentity = Symbol('custom-field-filter-row')
let nextIdentity = 0
type FilterRow = CustomFieldFilter & { [rowIdentity]: string }

export function identifyCustomFieldFilterRows(filters: readonly CustomFieldFilter[]): FilterRow[] {
  return filters.map(filter => rowIdentity in filter ? filter as FilterRow : { ...filter, [rowIdentity]: `custom-filter-${++nextIdentity}` })
}

export function customFieldFilterRowKey(filter: CustomFieldFilter): string {
  return (filter as FilterRow)[rowIdentity]
}

export function customFieldFilterDateKey(filter: CustomFieldFilter): string {
  return `${customFieldFilterRowKey(filter)}:${filter.field_id}`
}

export function useCustomFieldFilterRows() {
  const [filters, setRows] = useState<FilterRow[]>([])
  const setFilters: Dispatch<SetStateAction<CustomFieldFilter[]>> = useCallback(action => {
    setRows(current => identifyCustomFieldFilterRows(typeof action === 'function' ? action(current) : action))
  }, [])
  return [filters, setFilters] as const
}
