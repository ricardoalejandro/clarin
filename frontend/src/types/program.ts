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
  // `event` remains only for legacy records redirected to the Events module.
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
  migrated_event_id?: string;
  event_retirement_status?: 'migrated' | 'blocked';
  event_retirement_reason?: string;
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
  status: 'active' | 'dropped' | 'completed';
  enrolled_at: string;
  dropped_at?: string;
  drop_reason?: string;
  drop_notes?: string;
  completed_at?: string;
  transferred_to_level?: string;
  transferred_at?: string;
  contact_name?: string;
  contact_phone?: string;
  avatar_url?: string | null;
  avatar_revision?: number;
  stage_id?: string;
  stage_name?: string;
  stage_color?: string;
  auto_tag_sync?: boolean;
}

export interface ProgramSession {
  id: string;
  program_id: string;
  date: string;
  title?: string | null;
  topic?: string | null;
  course_topic_id?: string | null;
  course_id?: string | null;
  course_name?: string | null;
  course_topic_title?: string | null;
  topics: ProgramSessionTopic[];
  session_type?: 'regular' | 'recovery';
  start_time?: string; // "HH:MM"
  end_time?: string;   // "HH:MM"
  location?: string;
  created_at: string;
  updated_at: string;
  attendance_stats?: Record<string, number>;
}

export interface ProgramSessionTopic {
  id?: string;
  session_id?: string;
  kind: 'course' | 'free';
  course_id?: string | null;
  course_topic_id?: string | null;
  course_name?: string | null;
  title: string;
  position?: number;
  created_at?: string;
}

export interface CourseTopic {
  id: string;
  account_id: string;
  course_id: string;
  title: string;
  description?: string | null;
  status: 'active' | 'archived';
  position: number;
  usage_count: number;
  created_at: string;
  updated_at: string;
}

export interface ProgramCourse {
  id: string;
  account_id: string;
  name: string;
  description?: string | null;
  status: 'active' | 'archived';
  /** Catalog position, or association position when returned in academic-config. */
  position: number;
  usage_count: number;
  topic_count: number;
  active_topic_count: number;
  topic_preview: string[];
  created_at: string;
  updated_at: string;
  topics: CourseTopic[];
}

export interface ProgramInstructor {
  contact_id: string;
  contact_name: string;
  contact_phone?: string | null;
  avatar_url?: string | null;
  avatar_revision?: number;
  position: number;
}

export interface ProgramAcademicConfig {
  program_id: string;
  updated_at: string;
  courses: ProgramCourse[];
  instructors: ProgramInstructor[];
}

export interface ProgramCourseCatalogResponse {
  courses: ProgramCourse[];
  total: number;
  page: number;
  page_size: number;
}

export interface ProgramAttendance {
  id: string;
  session_id: string;
  participant_id: string;
  status: 'present' | 'absent' | 'late' | '';
  notes: string;
  observation_count: number;
  observation_preview: ProgramAttendanceObservation[];
  created_at: string;
  updated_at: string;
  participant_name?: string;
  participant_phone?: string;
}

export interface ProgramAttendanceObservation {
  id: string;
  notes: string;
  created_by?: string | null;
  created_by_name?: string | null;
  created_at: string;
  source_label?: string;
}

export type ProgramParticipantAttendanceHealth = 'green' | 'amber' | 'red' | 'no_data';

export interface ProgramParticipantAttendanceHistorySummary {
  goal_percent: number;
  eligible_sessions: number;
  marked_sessions: number;
  pending: number;
  present: number;
  absent: number;
  late: number;
  attendance_rate: number | null;
  punctuality_rate: number | null;
  health: ProgramParticipantAttendanceHealth;
}

export interface ProgramParticipantAttendanceHistorySession {
  session_id: string;
  ordinal: number;
  title: string;
  date: string;
  start_time?: string | null;
  end_time?: string | null;
  session_type: 'regular' | 'recovery';
  topics: ProgramSessionTopic[];
  status: 'present' | 'absent' | 'late' | null;
  observation_count: number;
  observation_preview?: ProgramAttendanceObservation | null;
  /** Temporary compatibility alias for early attendance-history responses. */
  latest_observation?: ProgramAttendanceObservation | null;
  outside_enrollment_period?: boolean;
}

export interface ProgramParticipantAttendanceHistoryResponse {
  /** Present only in legacy/wrapped responses; the canonical endpoint returns the payload directly. */
  success?: boolean;
  summary: ProgramParticipantAttendanceHistorySummary;
  sessions: ProgramParticipantAttendanceHistorySession[];
  historical_sessions: ProgramParticipantAttendanceHistorySession[];
  next_cursor?: string | null;
  error?: string;
}

export interface ProgramGoal {
  id?: string;
  account_id?: string;
  program_id?: string;
  attendance_goal_percent: number;
  transfer_goal_percent: number;
  created_at?: string;
  updated_at?: string;
}

export interface ProgramParticipantNote {
  id: string;
  account_id: string;
  program_id: string;
  participant_id: string;
  contact_id: string;
  session_id?: string;
  type: string;
  note: string;
  outcome?: string;
  follow_up_at?: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
  participant_name?: string;
  created_by_name?: string;
}

export interface ProgramHealthParticipant {
  participant_id: string;
  contact_id: string;
  name: string;
  phone?: string;
  avatar_url?: string | null;
  avatar_revision?: number;
  status: 'active' | 'dropped' | 'completed';
  health: 'healthy' | 'watch' | 'critical';
  attendance_rate: number;
  present: number;
  late: number;
  absent: number;
  excused: number;
  eligible_sessions: number;
  marked_sessions: number;
  pending: number;
  recovery_sessions: number;
  notes_count: number;
  last_note_at?: string;
  transferred_to_level?: string;
  reasons: string[];
}

export interface ProgramSessionAttendanceStat {
  session_id: string;
  title: string;
  topic: string;
  date: string;
  present: number;
  absent: number;
  late: number;
  excused: number;
}

export interface ProgramParticipantAttendanceStat {
  participant_id: string;
  name: string;
  present: number;
  absent: number;
  late: number;
  excused: number;
  total_sessions: number;
  marked_sessions: number;
  pending: number;
  rate: number;
}

export interface ProgramAttendanceStatsResponse {
  success: boolean;
  session_stats: ProgramSessionAttendanceStat[];
  participant_stats: ProgramParticipantAttendanceStat[];
  error?: string;
}

export interface ProgramHealthSummary {
  program_id: string;
  attendance_goal_percent: number;
  transfer_goal_percent: number;
  participant_count: number;
  active_count: number;
  completed_count: number;
  dropped_count: number;
  transferred_count: number;
  session_count: number;
  recovery_session_count: number;
  attendance_rate: number;
  transfer_rate: number;
  health: 'healthy' | 'watch' | 'critical';
  reasons: string[];
  participants: ProgramHealthParticipant[];
}

export interface ProgramDashboardGroup {
  program_id: string;
  name: string;
  status: string;
  color: string;
  participant_count: number;
  active_count: number;
  completed_count: number;
  dropped_count: number;
  transferred_count: number;
  session_count: number;
  attendance_rate: number;
  transfer_rate: number;
  attendance_goal_percent: number;
  transfer_goal_percent: number;
  at_risk_count: number;
  health: 'healthy' | 'watch' | 'critical';
}

export interface ProgramDashboardSummary {
  from?: string;
  to?: string;
  attendance_goal_percent: number;
  transfer_goal_percent: number;
  program_count: number;
  active_program_count: number;
  participant_count: number;
  completed_count: number;
  dropped_count: number;
  transferred_count: number;
  attendance_rate: number;
  transfer_rate: number;
  groups_below_goal: number;
  critical_participants: number;
  groups: ProgramDashboardGroup[];
}
