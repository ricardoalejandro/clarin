import { describe, expect, it } from 'vitest'
import { relatedTaskQuery, relatedTaskScopeKey } from './RelatedTasksPanel'

describe('RelatedTasksPanel scope', () => {
  it('keeps a Lead task query bound to Contact and opportunity', () => {
    const scope = { contactId: 'contact-1', leadId: 'lead-1' }
    expect(relatedTaskScopeKey(scope)).toBe('contact-1:lead-1:')
    const query = relatedTaskQuery(scope)
    expect(query).toContain('contact_id=contact-1')
    expect(query).toContain('lead_id=lead-1')
    expect(query).toContain('include_closed=true')
  })

  it('keeps an Event task query bound to Contact and event', () => {
    expect(relatedTaskQuery({ contactId: 'contact-1', eventId: 'event-1' })).toContain('event_id=event-1')
  })
})
