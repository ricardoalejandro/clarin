import { describe, expect, it } from 'vitest'
import { eventContactName, eventContactPickCount, eventContactQuery, eventContactSelected, eventContactSelectionPayload, eventSelectionNeedsReview, selectEventContactPage, toggleEventContact, type EventContactCandidate, type EventContactPick } from './eventContactSelection'
const candidate = (id: string, can_add = true): EventContactCandidate => ({ contact: { id }, can_add, membership_status: 'not_added', eligibility: 'eligible' })
describe('event contact selection', () => {
 it('uses the canonical identity precedence and rejects whitespace', () => {
  expect(eventContactName({ id: 'a', custom_name: ' ', name: ' Ana ', short_name: 'A' })).toBe('Ana')
  expect(eventContactName({ id: 'a', short_name: ' Alias ' })).toBe('Alias')
  expect(eventContactName({ id: 'a' })).toBe('Contacto sin nombre')
 })
 it('selects only eligible page rows and preserves selections on other pages', () => {
  expect(selectEventContactPage({ mode: 'ids', ids: ['first'] }, [candidate('new'), candidate('first'), candidate('blocked', false)])).toEqual({ mode: 'ids', ids: ['first', 'new'] })
 })
 it('represents twenty thousand selections with a filter and exceptions', () => {
  const selection: EventContactPick = { mode: 'filtered', filter: { search: 'Ana', tag_ids: [], membership: 'available' }, total: 20000, excluded_ids: [] }
  const changed = toggleEventContact(selection, candidate('exception'))
  expect(eventContactPickCount(changed)).toBe(19999)
  expect(eventContactSelected(changed, candidate('exception'))).toBe(false)
  expect(eventContactSelected(changed, candidate('other'))).toBe(true)
  expect(eventContactSelected(changed, candidate('active', false))).toBe(false)
  expect(JSON.stringify(eventContactSelectionPayload(changed)).length).toBeLessThan(300)
  expect(selectEventContactPage(changed, [candidate('exception')])).toEqual(selection)
 })
 it('does not let blocked rows or repeat page selection change counts', () => {
  const selection: EventContactPick = { mode: 'ids', ids: ['a'] }
  expect(toggleEventContact(selection, candidate('b', false))).toBe(selection)
  expect(eventContactPickCount(selectEventContactPage(selection, [candidate('a')]))).toBe(1)
 })
 it('bounds explicit IDs without imposing the explicit limit on all-filtered selection', () => {
  const selection: EventContactPick = { mode: 'ids', ids: Array.from({ length: 500 }, (_, i) => String(i)) }
  expect(toggleEventContact(selection, candidate('overflow'))).toEqual(selection)
 })
 it('constructs encoded scoped queries and distinguishes review conflicts from uncertain commits', () => {
  expect(eventContactQuery({ search: 'Ana & José', tag_ids: ['a'], membership: 'inactive', has_phone: true }, 'next')).toBe('membership=inactive&search=Ana+%26+Jos%C3%A9&tag_ids=a&has_phone=true&cursor=next')
  expect(eventSelectionNeedsReview('EVENT_SELECTION_STALE')).toBe(true)
  expect(eventSelectionNeedsReview('EVENT_SELECTION_BUSY')).toBe(false)
 })
})
