// Shared types for Contact, Lead, and related entities

export interface StructuredTag {
  id: string
  account_id: string
  name: string
  color: string
}

export interface PipelineStage {
  id: string
  pipeline_id: string
  name: string
  color: string
  position: number
  lead_count?: number
}

export interface Pipeline {
  id: string
  account_id?: string
  name: string
  description?: string | null
  is_default: boolean
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
}

/** Lead = CRM data + personal data (populated from Contact via backend COALESCE) */
export interface Lead {
  id: string
  jid: string
  contact_id: string | null
  name: string
  last_name: string | null
  short_name: string | null
  phone: string
  email: string
  company: string | null
  age: number | null
  dni: string | null
  birth_date: string | null
  status: string
  pipeline_id: string | null
  stage_id: string | null
  stage_name: string | null
  stage_color: string | null
  stage_position: number | null
  lead_pipeline_id?: string | null
  lead_stage_id?: string | null
  lead_stage_name?: string | null
  lead_stage_color?: string | null
  notes: string
  tags: string[]
  structured_tags: StructuredTag[] | null
  kommo_id: number | null
  is_archived: boolean
  archived_at: string | null
  is_blocked: boolean
  blocked_at: string | null
  block_reason: string
  assigned_to: string
  created_at: string
  updated_at: string
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
  email?: string | null
  company?: string | null
  age?: number | null
  dni?: string | null
  birth_date?: string | null
  tags?: string[]
  structured_tags?: StructuredTag[] | null
  notes?: string | null
  source?: string | null
  is_group?: boolean
  kommo_id?: number | null
  created_at?: string
  updated_at?: string
  last_activity?: string | null
  device_names?: { device_id: string; name: string }[]
}
