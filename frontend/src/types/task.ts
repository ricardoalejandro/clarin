export type TaskType = 'call' | 'whatsapp' | 'meeting' | 'reminder'
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent'
export type TaskStatus = 'pending' | 'completed' | 'overdue' | 'cancelled'

export interface Task {
  id: string
  account_id: string
  created_by: string
  assigned_to: string
  title: string
  description: string
  type: TaskType
  due_at?: string
  due_end_at?: string
  priority: TaskPriority
  status: TaskStatus
  completed_at?: string
  completed_by?: string
  lead_id?: string
  event_id?: string
  program_id?: string
  contact_id?: string
  list_id?: string
  starred?: boolean
  sort_order?: number
  recurrence_rule: string
  recurrence_parent_id?: string
  reminder_minutes?: number
  notes: string
  created_at: string
  updated_at: string
  // Joined fields
  assigned_to_name?: string
  created_by_name?: string
  lead_name?: string
  event_name?: string
  program_name?: string
  contact_name?: string
  list_name?: string
  // Subtask counts
  subtask_count?: number
  subtask_done?: number
  // Populated on demand
  subtasks?: Subtask[]
}

export interface Subtask {
  id: string
  task_id: string
  account_id: string
  title: string
  completed: boolean
  completed_at?: string
  sort_order: number
  created_at: string
  updated_at: string
}

export interface TaskStats {
  pending: number
  completed: number
  overdue: number
  cancelled: number
  today: number
}

export const TASK_TYPE_CONFIG: Record<TaskType, { label: string; icon: string; color: string; bg: string }> = {
  call: { label: 'Llamada', icon: '📞', color: 'text-blue-700', bg: 'bg-blue-50' },
  whatsapp: { label: 'WhatsApp', icon: '💬', color: 'text-emerald-700', bg: 'bg-emerald-50' },
  meeting: { label: 'Reunión', icon: '🤝', color: 'text-purple-700', bg: 'bg-purple-50' },
  reminder: { label: 'Recordatorio', icon: '🔔', color: 'text-amber-700', bg: 'bg-amber-50' },
}

export const TASK_PRIORITY_CONFIG: Record<TaskPriority, { label: string; color: string; bg: string }> = {
  low: { label: 'Baja', color: 'text-slate-600', bg: 'bg-slate-100' },
  medium: { label: 'Media', color: 'text-blue-600', bg: 'bg-blue-100' },
  high: { label: 'Alta', color: 'text-orange-600', bg: 'bg-orange-100' },
  urgent: { label: 'Urgente', color: 'text-red-600', bg: 'bg-red-100' },
}

export const REMINDER_OPTIONS = [
  { value: 0, label: 'Sin recordatorio' },
  { value: 5, label: '5 minutos antes' },
  { value: 15, label: '15 minutos antes' },
  { value: 30, label: '30 minutos antes' },
  { value: 60, label: '1 hora antes' },
  { value: 1440, label: '1 día antes' },
]

export interface TaskList {
  id: string
  account_id: string
  name: string
  color: string
  sort_order: number
  created_by: string
  created_at: string
  updated_at: string
  task_count: number
}
