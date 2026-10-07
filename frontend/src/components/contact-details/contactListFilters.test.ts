import { describe, expect, it } from 'vitest'
import { contactFilterCount, contactFilterParams, emptyContactListFilters } from './contactListFilters'
describe('applied Contact filter contract', () => {
  it('keeps custom filters, dates and tag exclusions in the same query for list and export', () => {
    const applied = { ...emptyContactListFilters(), tagNames: ['B', 'A'], excludedTagNames: ['C'], datePreset: 'custom', dateFrom: '2026-01-01', customFields: [{ field_id: 'quality', operator: 'eq' as const, value: 'verified' }] }
    const list = contactFilterParams(applied, 'Synthetic')
    expect(list.get('cf_filter')).toBe(JSON.stringify(applied.customFields))
    expect(list.get('tag_names')).toBe('A,B')
    expect(list.get('exclude_tag_names')).toBe('C')
    expect(list.get('date_from')).toBe('2026-01-01')
    expect(contactFilterParams(applied, 'Synthetic').toString()).toBe(list.toString())
    expect(contactFilterCount(applied)).toBe(5)
  })
  it('clears every applied clause with one empty snapshot', () => {
    expect(contactFilterParams(emptyContactListFilters()).toString()).toBe('')
    expect(contactFilterCount(emptyContactListFilters())).toBe(0)
  })
})
