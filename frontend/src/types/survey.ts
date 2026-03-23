export interface SurveyBranding {
  logo_url?: string;
  bg_color?: string;
  accent_color?: string;
  bg_image_url?: string;
  font_family?: string;     // Inter, Poppins, Playfair Display, etc.
  title_size?: string;      // sm, md, lg, xl
  text_color?: string;      // custom text color
  button_style?: string;    // rounded, pill, square
  bg_overlay?: string;      // overlay opacity: "0", "0.2", "0.4", "0.6"
  question_align?: string;  // left, center
}

export const FONT_OPTIONS = [
  { value: 'Inter', label: 'Inter', style: 'font-sans' },
  { value: 'Poppins', label: 'Poppins', style: 'font-sans' },
  { value: 'DM Sans', label: 'DM Sans', style: 'font-sans' },
  { value: 'Space Grotesk', label: 'Space Grotesk', style: 'font-sans' },
  { value: 'Montserrat', label: 'Montserrat', style: 'font-sans' },
  { value: 'Roboto', label: 'Roboto', style: 'font-sans' },
  { value: 'Open Sans', label: 'Open Sans', style: 'font-sans' },
  { value: 'Lato', label: 'Lato', style: 'font-sans' },
  { value: 'Nunito', label: 'Nunito', style: 'font-sans' },
  { value: 'Playfair Display', label: 'Playfair Display', style: 'font-serif' },
] as const;

export const TITLE_SIZE_OPTIONS = [
  { value: 'sm', label: 'Pequeño', px: '1.25rem' },
  { value: 'md', label: 'Mediano', px: '1.75rem' },
  { value: 'lg', label: 'Grande', px: '2.25rem' },
  { value: 'xl', label: 'Extra grande', px: '3rem' },
] as const;

export const BUTTON_STYLE_OPTIONS = [
  { value: 'rounded', label: 'Redondeado', className: 'rounded-lg' },
  { value: 'pill', label: 'Píldora', className: 'rounded-full' },
  { value: 'square', label: 'Cuadrado', className: 'rounded-none' },
] as const;

export interface Survey {
  id: string;
  account_id: string;
  name: string;
  description: string;
  slug: string;
  status: 'draft' | 'active' | 'closed';
  welcome_title: string;
  welcome_description: string;
  thank_you_title: string;
  thank_you_message: string;
  thank_you_redirect_url: string;
  branding: SurveyBranding;
  is_template?: boolean;
  created_by?: string;
  created_at: string;
  updated_at: string;
  question_count?: number;
  response_count?: number;
}

export interface SurveyQuestionConfig {
  options?: string[];
  max_rating?: number;
  likert_scale?: number;
  likert_min?: string;
  likert_max?: string;
  allowed_types?: string[];
  max_size_mb?: number;
  placeholder?: string;
}

export interface SurveyLogicRule {
  value: string;
  operator?: string; // eq, neq, contains, gt, lt
  jump_to: string;   // question ID
}

export interface SurveyQuestion {
  id: string;
  survey_id: string;
  order_index: number;
  type: QuestionType;
  title: string;
  description: string;
  required: boolean;
  config: SurveyQuestionConfig;
  logic_rules: SurveyLogicRule[];
  created_at: string;
  updated_at: string;
}

export type QuestionType =
  | 'short_text'
  | 'long_text'
  | 'single_choice'
  | 'multiple_choice'
  | 'rating'
  | 'likert'
  | 'date'
  | 'email'
  | 'phone'
  | 'file_upload';

export interface SurveyAnswer {
  id: string;
  response_id: string;
  question_id: string;
  value: string;
  file_url?: string;
  created_at: string;
}

export interface SurveyResponse {
  id: string;
  survey_id: string;
  account_id: string;
  respondent_token: string;
  lead_id?: string;
  source: string;
  started_at: string;
  completed_at?: string;
  created_at: string;
  answers?: SurveyAnswer[];
}

export interface SurveyAnalytics {
  total_responses: number;
  completion_rate: number;
  avg_completion_seconds: number;
  question_stats: SurveyQuestionStats[];
}

export interface SurveyQuestionStats {
  question_id: string;
  question_type: string;
  title: string;
  total_answers: number;
  option_counts?: Record<string, number>;
  average?: number;
  distribution?: Record<string, number>;
}

export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  short_text: 'Texto corto',
  long_text: 'Texto largo',
  single_choice: 'Opción única',
  multiple_choice: 'Opción múltiple',
  rating: 'Calificación',
  likert: 'Escala Likert',
  date: 'Fecha',
  email: 'Email',
  phone: 'Teléfono',
  file_upload: 'Archivo',
};

export const QUESTION_TYPE_ICONS: Record<QuestionType, string> = {
  short_text: 'Type',
  long_text: 'AlignLeft',
  single_choice: 'CircleDot',
  multiple_choice: 'CheckSquare',
  rating: 'Star',
  likert: 'SlidersHorizontal',
  date: 'Calendar',
  email: 'Mail',
  phone: 'Phone',
  file_upload: 'Paperclip',
};
