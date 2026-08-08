import { describe, expect, it } from 'vitest'
import { activityRealtimeMatchesScope, activityScopePayload, activityScopeQuery } from './ScopedActivityPanel'

describe('scoped CRM activity', () => {
  it('keeps participant queries direct and explicit', () => {
    expect(activityScopeQuery({ kind: 'event_participant', eventId: 'event-1', participantId: 'participant-1', contactId: 'contact-1' }))
      .toContain('participant_id=participant-1&scope=participant')
  })

  it('preserves Nota/Llamada in the contextual payload', () => {
    expect(activityScopePayload({ kind: 'lead', leadId: 'lead-1', contactId: 'contact-1' }, 'Llamó', 'call')).toEqual({
      lead_id: 'lead-1',
      contact_id: 'contact-1',
      type: 'call',
      notes: 'Llamó',
    })
  })

  it('matches realtime events only to their direct scope', () => {
    const message = { event: 'interaction_update', data: { lead_id: 'lead-1', contact_id: 'contact-1', participant_id: 'participant-1' } }
    expect(activityRealtimeMatchesScope({ kind: 'lead', leadId: 'lead-1' }, message)).toBe(true)
    expect(activityRealtimeMatchesScope({ kind: 'lead', leadId: 'lead-2' }, message)).toBe(false)
    expect(activityRealtimeMatchesScope({ kind: 'event_participant', eventId: 'event-1', participantId: 'participant-1' }, message)).toBe(true)
    expect(activityRealtimeMatchesScope({ kind: 'event_participant', eventId: 'event-1', participantId: 'participant-2' }, message)).toBe(false)
  })

  it('accepts canonical interaction fields nested in the websocket payload', () => {
    const message = { event: 'interaction_update', data: { interaction: { contact_id: 'contact-1' } } }
    expect(activityRealtimeMatchesScope({ kind: 'contact', contactId: 'contact-1' }, message)).toBe(true)
  })
})
