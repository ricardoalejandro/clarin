import { describe, expect, it } from 'vitest'
import { crmDetailWorkspaceLayout } from './CrmDetailWorkspace'
import { activityAuthorLabel, activityScopeKey, activityScopePayload, activityScopeQuery } from './ScopedActivityPanel'

describe('CRM detail contracts', () => {
  it('uses measured workspace width for chat composition', () => {
    expect(crmDetailWorkspaceLayout(1440, false)).toBe('detail')
    expect(crmDetailWorkspaceLayout(979, true)).toBe('chat')
    expect(crmDetailWorkspaceLayout(980, true)).toBe('split')
  })

  it('keeps Lead observations explicitly scoped', () => {
    const scope = { kind: 'lead' as const, leadId: 'lead-1', contactId: 'contact-1' }
    expect(activityScopeKey(scope)).toBe('lead:lead-1')
    expect(activityScopeQuery(scope)).toBe('/api/leads/lead-1/interactions?limit=100')
    expect(activityScopePayload(scope, 'Seguimiento')).toEqual({ lead_id: 'lead-1', contact_id: 'contact-1', type: 'note', notes: 'Seguimiento' })
  })

  it('requests only direct participant observations', () => {
    const scope = { kind: 'event_participant' as const, eventId: 'event-1', participantId: 'participant-1', contactId: 'contact-1' }
    expect(activityScopeQuery(scope)).toContain('participant_id=participant-1')
    expect(activityScopeQuery(scope)).toContain('scope=participant')
    expect(activityScopePayload(scope, 'Llegará temprano')).toMatchObject({ event_id: 'event-1', participant_id: 'participant-1', contact_id: 'contact-1' })
    expect(activityScopePayload(scope, 'Llamada confirmada', 'call')).toMatchObject({ type: 'call', participant_id: 'participant-1' })
  })

  it('always exposes an honest observation author', () => {
    expect(activityAuthorLabel({ created_by_name: 'María', source_label: null })).toBe('María')
    expect(activityAuthorLabel({ created_by_name: null, source_label: 'Importación Excel' })).toBe('Importación · Importación Excel')
    expect(activityAuthorLabel({ created_by_name: null, source_label: null })).toBe('Usuario no disponible')
  })
})
