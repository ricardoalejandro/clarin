export type ActivityScope =
  | { kind: 'contact'; contactId: string }
  | { kind: 'lead'; leadId: string; contactId?: string | null }
  | { kind: 'event_participant'; eventId: string; participantId: string; contactId?: string | null; leadId?: string | null }

export interface RelatedTaskScope {
  /** Optional only for legacy Leads that have not yet been linked to a canonical Contact. */
  contactId?: string
  leadId?: string
  eventId?: string
}
