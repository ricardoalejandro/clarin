export interface Program {
  id: string;
  account_id: string;
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
}

export interface ProgramParticipant {
  id: string;
  program_id: string;
  contact_id: string;
  status: 'active' | 'dropped' | 'completed';
  enrolled_at: string;
  contact_name?: string;
  contact_phone?: string;
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
