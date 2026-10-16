import { OfflineV5Error, type OfflineV5Snapshot } from './types'
import { offlineProgramParticipant } from './programDerivedState'

type JsonObject = Record<string, unknown>
const rows = (value: unknown): JsonObject[] => Array.isArray(value) ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) : []

/** Convert historical snapshot names once, below the canonical Contact surface. */
export function offlineCanonicalContact(source: JsonObject, payload: JsonObject): JsonObject {
  const contactID = source.id
  return {
    ...source,
    distrito: source.distrito ?? source.district ?? null,
    ocupacion: source.ocupacion ?? source.occupation ?? null,
    structured_tags: Array.isArray(source.structured_tags) ? source.structured_tags : rows(payload.tags),
    extra_phones: (Array.isArray(source.extra_phones) ? rows(source.extra_phones) : rows(payload.phones)).map(phone => ({ ...phone, contact_id: contactID })),
    custom_field_values: Array.isArray(source.custom_field_values) ? source.custom_field_values : rows(payload.custom_fields).map(field => ({
      ...field,
      field_id: field.field_id ?? field.id,
      contact_id: contactID,
      field_name: field.field_name ?? field.name,
      field_type: field.field_type ?? field.type,
      value_text: field.value_text ?? field.text ?? null,
      value_number: field.value_number ?? (field.number == null ? null : Number(field.number)),
      value_date: field.value_date ?? field.date ?? null,
      value_bool: field.value_bool ?? field.bool ?? null,
      value_json: field.value_json ?? field.json ?? null,
    })),
  }
}

/** Preserve the canonical collection DTO after an edit in the ordinary Contact window. */
export function offlineContactOptimisticValue(contact: JsonObject, payload: JsonObject, change: JsonObject): JsonObject {
  const next: JsonObject = { ...contact, ...change }
  if (Object.hasOwn(change, 'tag_ids')) {
    const known = new Map([...rows(payload.tags), ...rows(contact.structured_tags)].map(tag => [String(tag.id), tag]))
    if (!Array.isArray(change.tag_ids) || change.tag_ids.some(id => typeof id !== 'string' || !known.has(id))) {
      throw new OfflineV5Error('not_prepared', 'Esta etiqueta no fue preparada para el contacto.')
    }
    next.structured_tags = [...new Set(change.tag_ids as string[])].map(id => known.get(id))
  }
  if (Object.hasOwn(change, 'custom_field_values')) {
    if (!Array.isArray(change.custom_field_values)) throw new OfflineV5Error('invalid_request_body', 'Los campos personalizados no son válidos.')
    const current = new Map(rows(contact.custom_field_values).map(field => [String(field.field_id), field]))
    const definitions = new Map(rows(payload.custom_field_definitions).map(field => [String(field.id), field]))
    next.custom_field_values = rows(change.custom_field_values).map(field => {
      const id = String(field.field_id), existing = current.get(id), definition = definitions.get(id)
      if (!existing && !definition) throw new OfflineV5Error('not_prepared', 'Este campo personalizado no fue preparado para el contacto.')
      return { ...existing, field_name: existing?.field_name ?? definition?.name, field_type: existing?.field_type ?? definition?.field_type, ...field, contact_id: contact.id }
    })
  }
  return offlineCanonicalContact(next, payload)
}

export function offlineProgramContactContext(snapshots: readonly OfflineV5Snapshot[], contactID: string, participantID: string, overlays: readonly { root_selection_id: string; entity_id: string; value: unknown }[] = []) {
  for (const snapshot of snapshots) {
    if (snapshot.tombstone || snapshot.module !== 'programs') continue
    const local = overlays.find(value => value.root_selection_id === snapshot.root_selection_id && value.entity_id === participantID)
    const participant = rows(local ? [local.value] : [...rows(snapshot.payload.active_roster), ...rows(snapshot.payload.historical_participations)]).map(value => offlineProgramParticipant(value, snapshot.root_resource_id))
      .find(value => value.id === participantID && value.contact_id === contactID && value.program_id === snapshot.root_resource_id)
    if (!participant) continue
    const profile = rows(snapshot.payload.contact_profiles).find(value => (value.contact as JsonObject | undefined)?.id === contactID)
    return { snapshot, participant, profile }
  }
  return undefined
}

/** Stable bounded paging for the same observations UI used online. */
export function offlineObservationPage(observations: JsonObject[], url: URL) {
  const rawLimit = Number(url.searchParams.get('limit') || 50)
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50
  const cursor = url.searchParams.get('cursor') || ''
  const after = cursor ? observations.findIndex(value => value.id === cursor) : -1
  if (cursor && after < 0) return undefined
  const offset = after + 1
  const page = observations.slice(offset, offset + limit)
  const hasMore = offset + page.length < observations.length
  return { success: true, observations: page, total: observations.length, has_more: hasMore, next_cursor: hasMore ? String(page.at(-1)?.id || '') : null }
}
