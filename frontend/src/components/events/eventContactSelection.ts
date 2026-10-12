export interface EventContact {
 id: string
 custom_name?: string | null
 name?: string | null
 last_name?: string | null
 short_name?: string | null
 push_name?: string | null
 phone?: string | null
 email?: string | null
 extra_phones?: { phone: string; label?: string }[]
 structured_tags?: { id: string; name: string; color: string }[]
}
export interface EventContactCandidate {
 contact: EventContact
 membership_status: 'not_added' | 'active' | 'inactive'
 eligibility: 'eligible' | 'rule_ineligible' | 'event_frozen'
 can_add: boolean
 participant_id?: string
 stage_name?: string
 membership_reason?: string
}
export interface EventContactFilter {
 search: string
 tag_ids: string[]
 has_phone?: boolean
 membership: 'available' | 'active' | 'inactive' | 'ineligible' | 'all'
}
export interface EventContactSelectionResult {
 operation_id: string
 selection_id: string
 created: number
 reactivated: number
 already_active: number
 total_active: number
 stage_counts: Record<string, number>
 completed_at: string
}
export interface EventContactSelection {
 selection_id: string
 expires_at: string
 selected: number
 new: number
 reactivations: number
 result?: EventContactSelectionResult
}
export interface EventCandidatePage {
 candidates: EventContactCandidate[]
 total: number
 has_more: boolean
 next_cursor?: string
 has_rules: boolean
 event_status: string
 counts: { available: number; already_active: number; inactive: number; ineligible: number; matches: number }
}
export type EventContactPick = { mode: 'ids'; ids: string[] } | { mode: 'filtered'; filter: EventContactFilter; excluded_ids: string[]; total: number }
export const EMPTY_EVENT_CONTACT_FILTER: EventContactFilter = { search: '', tag_ids: [], membership: 'available' }
export function eventContactName(contact: EventContact): string {
 return [contact.custom_name, contact.name, contact.push_name, contact.short_name, contact.phone].find(value => typeof value === 'string' && value.trim())?.trim() || 'Contacto sin nombre'
}
export function eventContactSelected(pick: EventContactPick, candidate: EventContactCandidate): boolean {
 return candidate.can_add && (pick.mode === 'filtered' ? !pick.excluded_ids.includes(candidate.contact.id) : pick.ids.includes(candidate.contact.id))
}
export function eventContactPickCount(pick: EventContactPick): number {
 return pick.mode === 'filtered' ? Math.max(0, pick.total - pick.excluded_ids.length) : pick.ids.length
}
export function toggleEventContact(pick: EventContactPick, candidate: EventContactCandidate): EventContactPick {
 if (!candidate.can_add) return pick
 const id = candidate.contact.id
 if (pick.mode === 'filtered') {
  const excluded = new Set(pick.excluded_ids)
  if (excluded.has(id)) excluded.delete(id)
  else if (excluded.size < 5000) excluded.add(id)
  return { ...pick, excluded_ids: [...excluded] }
 }
 const ids = new Set(pick.ids)
 if (ids.has(id)) ids.delete(id)
 else if (ids.size < 500) ids.add(id)
 return { mode: 'ids', ids: [...ids] }
}
export function selectEventContactPage(pick: EventContactPick, rows: EventContactCandidate[]): EventContactPick {
 if (pick.mode === 'filtered') return { ...pick, excluded_ids: pick.excluded_ids.filter(id => !rows.some(row => row.can_add && row.contact.id === id)) }
 return { mode: 'ids', ids: [...new Set([...pick.ids, ...rows.filter(row => row.can_add).map(row => row.contact.id)])].slice(0, 500) }
}
export function eventContactSelectionPayload(pick: EventContactPick) {
 return pick.mode === 'filtered'
  ? { mode: pick.mode, filter: pick.filter, excluded_ids: pick.excluded_ids }
  : { mode: pick.mode, filter: EMPTY_EVENT_CONTACT_FILTER, contact_ids: pick.ids }
}
export function eventContactQuery(filter: EventContactFilter, cursor = '') {
 const query = new URLSearchParams({ membership: filter.membership })
 if (filter.search.trim()) query.set('search', filter.search.trim())
 if (filter.tag_ids.length) query.set('tag_ids', filter.tag_ids.join(','))
 if (filter.has_phone !== undefined) query.set('has_phone', String(filter.has_phone))
 if (cursor) query.set('cursor', cursor)
 return query.toString()
}
export function eventSelectionNeedsReview(code?: string) {
 return ['EVENT_SELECTION_EXPIRED', 'EVENT_SELECTION_STALE', 'EVENT_MEMBERSHIP_FROZEN'].includes(code || '')
}
