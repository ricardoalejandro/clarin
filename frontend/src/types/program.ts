export interface Program {
  id: string;
  account_id: string;
  folder_id?: string;
  name: string;
  description: string;
  status: 'active' | 'archived' | 'completed';
  color: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  participant_count?: number;
  session_count?: number;
  // Schedule fields
  schedule_start_date?: string;
  schedule_end_date?: string;
  schedule_days?: number[]; // 0=Sun, 1=Mon, ..., 6=Sat
  schedule_start_time?: string; // "HH:MM"
  schedule_end_time?: string;   // "HH:MM"
  // Program type & event-specific fields
  type?: 'course' | 'event';
  pipeline_id?: string;
  pipeline_name?: string;
  tag_formula?: string;
  tag_formula_mode?: 'OR' | 'AND';
  tag_formula_type?: 'simple' | 'advanced';
  event_date?: string;
  event_end?: string;
  location?: string;
  stage_counts?: Record<string, number>;
}

export interface ProgramFolder {
  id: string;
  account_id: string;
  parent_id?: string;
  name: string;
  color: string;
  icon: string;
  position: number;
  created_at: string;
  updated_at: string;
  program_count?: number;
}

export interface ProgramParticipant {
  id: string;
  program_id: string;
  contact_id: string;
  lead_id?: string;
  status: 'active' | 'dropped' | 'completed';
  enrolled_at: string;
  contact_name?: string;
  contact_phone?: string;
  stage_id?: string;
  stage_name?: string;
  stage_color?: string;
  auto_tag_sync?: boolean;
}

export interface ProgramSession {
  id: string;
  program_id: string;
  date: string;
  topic: string;
  start_time?: string; // "HH:MM"
  end_time?: string;   // "HH:MM"
  location?: string;
  created_at: string;
  updated_at: string;
  attendance_stats?: Record<string, number>;
}

export interface ProgramAttendance {
  id: string;
  session_id: string;
  participant_id: string;
  status: 'present' | 'absent' | 'late' | 'excused';
  notes: string;
  created_at: string;
  updated_at: string;
  participant_name?: string;
  participant_phone?: string;
}
