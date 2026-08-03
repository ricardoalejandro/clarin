import type { SurveyBranding, SurveyQuestionConfig, SurveyLogicRule, QuestionType, SurveyMeasurementConfig, SurveyMeasurementDimensionStats } from './survey';

export interface SurveyTemplate {
  id: string;
  account_id: string;
  name: string;
  description: string;
  status: 'active' | 'archived';
  welcome_title: string;
  welcome_description: string;
  thank_you_title: string;
  thank_you_message: string;
  thank_you_redirect_url: string;
  branding: SurveyBranding;
  measurement_config: SurveyMeasurementConfig;
  revision: number;
  system_key?: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
  question_count: number;
  instance_count: number;
  archived_instance_count: number;
  response_count: number;
}

export interface SurveyTemplateQuestion {
  id: string;
  account_id: string;
  template_id: string;
  order_index: number;
  type: QuestionType;
  title: string;
  description: string;
  required: boolean;
  config: SurveyQuestionConfig;
  logic_rules: SurveyLogicRule[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface SurveyInstanceSummary {
  id: string;
  account_id: string;
  template_id: string;
  template_revision: number;
  program_id?: string;
  origin_type: 'standalone' | 'program';
  origin_label: string;
  name: string;
  slug: string;
  status: 'draft' | 'active' | 'closed';
  audience_mode: 'public' | 'program_participants';
  opens_at?: string;
  closes_at?: string;
  legacy_instance: boolean;
  archived_at?: string;
  archived_by?: string;
  archived_from_status?: 'draft' | 'active' | 'closed';
  measurement_signature?: string;
  analytics_tracking_started_at: string;
  question_count: number;
  recipient_count: number;
  response_count: number;
  can_delete: boolean;
  can_archive: boolean;
  can_restore: boolean;
  deletion_block_reason?: SurveyDeletionBlockReason;
  created_at: string;
  updated_at: string;
}

export type SurveyDeletionBlockReason = 'legacy' | 'has_responses' | 'has_activity' | 'has_uploads';

export interface SurveyMeasurementApplicationPoint {
  survey_id: string;
  name: string;
  created_at: string;
  response_count: number;
  dimensions: SurveyMeasurementDimensionStats[];
}

export interface SurveyParticipantMeasurementPoint {
  program_participant_id: string;
  contact_name: string;
  survey_id: string;
  survey_name: string;
  created_at: string;
  scores: Record<string, number>;
}

export interface SurveyPairedMeasurementChange {
  dimension_key: string;
  sample_size: number;
  baseline?: number;
  followup?: number;
  delta?: number;
}

export interface SurveyMeasurementSeries {
  template_id: string;
  program_id: string;
  signature: string;
  excluded_applications: number;
  applications: SurveyMeasurementApplicationPoint[];
  participants: SurveyParticipantMeasurementPoint[];
  paired_changes: SurveyPairedMeasurementChange[];
}

export interface SurveyInstanceRecipient {
  id: string;
  contact_id?: string;
  program_participant_id?: string;
  contact_name: string;
  status: 'pending' | 'opened' | 'completed';
  recipient_token: string;
  opened_at?: string;
  completed_at?: string;
}
