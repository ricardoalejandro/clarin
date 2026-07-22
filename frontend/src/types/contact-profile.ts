import type { CustomFieldValue } from './custom-field'
import type { Observation, StructuredTag } from './contact'

export type ContactProfileContextType =
  | 'contact'
  | 'lead'
  | 'chat'
  | 'event_participant'
  | 'program_participant'

export interface ContactProfileContext {
  type: ContactProfileContextType
  id: string
}

export interface ContactProfilePhone {
  id: string
  contact_id: string
  phone: string
  label?: string | null
  created_at?: string
}

export interface ContactProfileDeviceName {
  id: string
  contact_id?: string
  device_id: string
  name?: string | null
  push_name?: string | null
  business_name?: string | null
  device_name?: string | null
  synced_at?: string
}

/**
 * Canonical identity payload shared by every CRM context.
 * Nullable fields mirror the backend instead of the older flattened Lead DTO.
 */
export interface ContactProfileContact {
  id: string
  account_id?: string
  device_id?: string | null
  jid?: string | null
  phone?: string | null
  name?: string | null
  last_name?: string | null
  short_name?: string | null
  custom_name?: string | null
  push_name?: string | null
  avatar_url?: string | null
  avatar_media_asset_id?: string | null
  avatar_source?: 'legacy' | 'whatsapp' | 'manual' | null
  avatar_updated_at?: string | null
  avatar_revision?: number
  email?: string | null
  company?: string | null
  age?: number | null
  dni?: string | null
  birth_date?: string | null
  address?: string | null
  distrito?: string | null
  ocupacion?: string | null
  tags?: string[]
  structured_tags: StructuredTag[]
  extra_phones: ContactProfilePhone[]
  custom_field_values: CustomFieldValue[]
  device_names?: ContactProfileDeviceName[]
  notes?: string | null
  source?: string | null
  is_group?: boolean
  kommo_id?: number | null
  do_not_contact?: boolean
  do_not_contact_at?: string | null
  do_not_contact_by?: string | null
  do_not_contact_reason?: string | null
  google_sync?: boolean
  google_resource_name?: string | null
  google_synced_at?: string | null
  google_sync_error?: string | null
  created_at?: string
  updated_at?: string
  last_activity?: string | null
}

export interface ContactProfileCapabilities {
  can_view: boolean
  can_edit: boolean
  can_manage_avatar: boolean
  can_manage_observations: boolean
  can_create_tags: boolean
}

export interface ContactProfileAvailableTag {
  id: string
  name: string
  color: string
}

export interface ContactProfileCustomFieldDefinition {
  id: string
  name: string
  slug: string
  field_type: CustomFieldValue['field_type']
  options?: Array<{ label: string; value: string }>
  config?: {
    options?: Array<{ label: string; value: string }>
    symbol?: string
    decimals?: number
    min?: number
    max?: number
    max_length?: number
    text_variant?: 'inline' | 'textarea' | 'rich'
  }
  is_required?: boolean
  position?: number
}

export interface ContactProfileResponse {
  success: boolean
  contact: ContactProfileContact
  context: ContactProfileContext
  capabilities: ContactProfileCapabilities
  available_tags?: ContactProfileAvailableTag[]
  observation_count?: number
  custom_field_definitions?: ContactProfileCustomFieldDefinition[]
}

export interface ContactProfileObservationsResponse {
  success: boolean
  observations: Observation[]
  total?: number
}

export interface ContactProfileTagSearchResponse {
  success: boolean
  tags: ContactProfileAvailableTag[]
  total: number
}

export interface ContactProfileObservationResponse {
  success: boolean
  observation: Observation
  total?: number
}

export type ContactProfileEditableField =
  | 'name'
  | 'custom_name'
  | 'last_name'
  | 'short_name'
  | 'phone'
  | 'email'
  | 'company'
  | 'age'
  | 'dni'
  | 'birth_date'
  | 'address'
  | 'distrito'
  | 'ocupacion'
  | 'notes'

export interface ContactProfileExtraPhonePatch {
  id?: string
  phone: string
  label?: string | null
}

export interface ContactProfileCustomFieldPatch {
  field_id: string
  value_text?: string | null
  value_number?: number | null
  value_date?: string | null
  value_bool?: boolean | null
  value_json?: string[] | null
}

export type ContactProfilePatch = Partial<
  Record<ContactProfileEditableField, string | number | null>
> & {
  /** Omit to preserve; an empty array intentionally clears the collection. */
  tag_ids?: string[]
  /** Omit to preserve; an empty array intentionally clears the collection. */
  extra_phones?: ContactProfileExtraPhonePatch[]
  /** Omit to preserve; an empty array intentionally clears the collection. */
  custom_field_values?: ContactProfileCustomFieldPatch[]
}
