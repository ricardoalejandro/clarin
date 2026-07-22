export function contactIdFromRealtimeEvent(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null
  const record = message as Record<string, unknown>
  const data = record.data && typeof record.data === 'object'
    ? record.data as Record<string, unknown>
    : record
  const direct = data.contact_id
  if (typeof direct === 'string') return direct
  const contact = data.contact
  if (contact && typeof contact === 'object' && typeof (contact as Record<string, unknown>).id === 'string') {
    return (contact as Record<string, unknown>).id as string
  }
  return null
}
