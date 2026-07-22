import type { SurveyBranding, SurveyQuestionConfig, SurveyLogicRule, QuestionType } from './survey';

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
  revision: number;
  system_key?: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
  question_count: number;
  instance_count: number;
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
  question_count: number;
  recipient_count: number;
  response_count: number;
  created_at: string;
  updated_at: string;
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

