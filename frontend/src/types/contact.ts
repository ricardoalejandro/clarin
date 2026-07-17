// Shared types for Contact, Lead, and related entities

import { CustomFieldValue } from './custom-field'

export interface StructuredTag {
  id: string
  account_id: string
  name: string
  color: string
}

export type PipelineStageType = 'active' | 'won' | 'lost'

export interface PipelineStage {
  id: string
  pipeline_id: string
  name: string
  color: string
  position: number
  stage_type?: PipelineStageType
  lead_count?: number
}

export interface Pipeline {
  id: string
  account_id?: string
  name: string
  description?: string | null
  is_default: boolean
  kommo_id?: number | null
  stages: PipelineStage[] | null
}

export interface Observation {
  id: string
  contact_id: string | null
  lead_id: string | null
  type: string
  direction: string | null
  outcome: string | null
  notes: string | null
  created_by_name: string | null
  created_at: string
  program_id?: string | null
  program_session_id?: string | null
  program_participant_id?: string | null
  source_label?: string | null
}

/** Lead = CRM data + personal data (populated from Contact via backend COALESCE) */
export interface Lead {
  id: string
  jid: string
  contact_id: string | null
  /** Commercial opportunity title. Personal identity remains on Contact. */
  title?: string
  name: string
  last_name: string | null
  short_name: string | null
  phone: string
  email: string
  company: string | null
  age: number | null
  dni: string | null
  birth_date: string | null
  address: string | null
  distrito: string | null
  ocupacion: string | null
  status: 'open' | 'won' | 'lost' | string
  pipeline_id: string | null
  pipeline_name?: string | null
  stage_id: string | null
  stage_name: string | null
  stage_color: string | null
  stage_position: number | null
  lead_pipeline_id?: string | null
  lead_pipeline_name?: string | null
  lead_stage_id?: string | null
  lead_stage_name?: string | null
  lead_stage_color?: string | null
  notes: string
  tags: string[]
  structured_tags: StructuredTag[] | null
  kommo_id: number | null
  is_archived: boolean
  archived_at: string | null
  closed_at?: string | null
  closed_by?: string | null
  close_reason?: string | null
  deleted_at?: string | null
  deleted_by?: string | null
  delete_reason?: string | null
  purge_at?: string | null
  is_blocked: boolean
  blocked_at: string | null
  block_reason: string
  kommo_deleted_at: string | null
  assigned_to: string
  created_at: string
  updated_at: string
  custom_field_values?: CustomFieldValue[] | null
}

/** Contact = source of truth for personal data + tags */
export interface Contact {
  id: string
  account_id?: string
  device_id?: string
  jid: string
  phone: string
  name: string
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
  structured_tags?: StructuredTag[] | null
  notes?: string | null
  source?: string | null
  is_group?: boolean
  kommo_id?: number | null
  do_not_contact?: boolean
  do_not_contact_at?: string | null
  do_not_contact_by?: string | null
  do_not_contact_reason?: string | null
  created_at?: string
  updated_at?: string
  last_activity?: string | null
  device_names?: { device_id: string; name: string }[]
  custom_field_values?: CustomFieldValue[] | null
}
