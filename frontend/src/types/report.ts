export type CoverageStatus =
  | 'active_management'
  | 'historical_only'
  | 'contact_only'
  | 'not_registered'
  | 'unidentifiable'
  | 'ambiguous'

export interface ReportDefinition {
  id: string
  title: string
  description: string
  category: string
  href: string
  usesAI?: boolean
  icon?: 'whatsapp' | 'sparkles'
}

export interface LeadIntelligenceOption {
  id: string
  name: string
}

export interface LeadIntelligenceAIAvailability {
  available: boolean
  code?: string
  message: string
}

export interface LeadIntelligenceOptions {
  ai: LeadIntelligenceAIAvailability
  allowed_reasoning_efforts: string[]
  pipelines: LeadIntelligenceOption[]
  stages: LeadIntelligenceOption[]
  tags: LeadIntelligenceOption[]
  sources: string[]
}

export interface LeadIntelligencePreview {
  total_leads: number
  leads_with_chats: number
  ai_candidate_count: number
  ai_candidate_limit: number
  recommended_reasoning: string
  recommendation_reason: string
}

export type LeadIntelligenceRunStatus = 'queued' | 'running' | 'completed' | 'completed_with_warnings' | 'failed' | 'cancelled'

export interface LeadIntelligenceRun {
  id: string
  report_type: string
  status: LeadIntelligenceRunStatus
  phase: string
  selected_reasoning: string
  recommended_reasoning: string
  total_items: number
  processed_items: number
  ai_candidate_count: number
  ai_processed_count: number
  cancel_requested: boolean
  error_code?: string
  safe_error?: string
  created_at: string
  started_at?: string
  completed_at?: string
  expires_at: string
}

export interface LeadIntelligenceSummary {
  generated_at: string
  objective_name: string
  campaign_context?: string
  total_leads: number
  leads_with_chats: number
  leads_with_notes: number
  leads_with_events: number
  ai_candidate_count: number
  ai_processed_count: number
  ai_coverage_percent: number
  priority_distribution: Record<string, number>
  profile_distribution: Record<string, number>
  hallazgos: string[]
  limitaciones: string[]
  respuestas?: Record<string, string>
}

export type LeadIntelligenceRow = Record<string, unknown> & {
  lead_id: string
  nombre: string
  telefono: string
  nivel_prioridad: string
  perfil_humano_principal: string
  razon_prioridad: string
  accion_recomendada: string
  eventos_detalle?: Array<Record<string, unknown>>
}

export interface LeadIntelligenceResult {
  run: LeadIntelligenceRun
  summary: LeadIntelligenceSummary
  warnings: string[]
  rows: LeadIntelligenceRow[]
}

export interface ReportDevice {
  id: string
  name?: string | null
  phone?: string | null
  status?: string | null
  provider?: 'whatsapp_web' | 'whatsapp_cloud_api' | string | null
}

export interface WhatsAppGroupOption {
  id: string
  name: string
  participant_count: number
  kind: 'group' | 'community' | 'announcement'
  suspended: boolean
}

export interface WhatsAppReportTag {
  id: string
  name: string
  color: string
}

export interface WhatsAppReportLead {
  id: string
  title: string
  pipeline_name: string
  stage_name: string
  stage_color: string
  assigned_to_name: string
  updated_at: string
}

export interface WhatsAppReportContact {
  id: string
  display_name: string
  source: string
  do_not_contact: boolean
  last_direct_activity_at: string | null
  tags: WhatsAppReportTag[]
  active_leads: WhatsAppReportLead[]
  historical_lead_count: number
}

export interface WhatsAppGroupCoverageMember {
  whatsapp_name: string
  phone: string | null
  redacted_phone: string | null
  role: 'owner' | 'super_admin' | 'admin' | 'member'
  is_self: boolean
  exists_in_clarin: boolean | null
  coverage_status: CoverageStatus
  matched_contact_count: number
  contact?: WhatsAppReportContact
}

export interface WhatsAppGroupCoverageSummary {
  total_group_members: number
  evaluated_members: number
  eligible_members: number
  registered_members: number
  active_management_members: number
  historical_only_members: number
  contact_only_members: number
  not_registered_members: number
  unidentifiable_members: number
  ambiguous_members: number
  do_not_contact_members: number
  registration_coverage_percent: number | null
  management_coverage_percent: number | null
}

export interface WhatsAppGroupCoverageReport {
  generated_at: string
  device: { id: string; name: string; phone: string }
  group: { id: string; name: string; participant_count: number; kind: WhatsAppGroupOption['kind']; suspended: boolean }
  summary: WhatsAppGroupCoverageSummary
  members: WhatsAppGroupCoverageMember[]
}
