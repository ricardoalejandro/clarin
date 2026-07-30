export type TaskType = 'call' | 'whatsapp' | 'meeting' | 'reminder'
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent'
export type TaskStatus = 'pending' | 'completed' | 'overdue' | 'cancelled'
export type TaskStatusCategory = 'not_started' | 'active' | 'done' | 'cancelled'
export type TaskViewMode = 'list' | 'board' | 'calendar' | 'gantt' | 'summary'

export interface TaskWorkflowStatus {
  id: string
  account_id: string
  workflow_id: string
  name: string
  color: string
  category: TaskStatusCategory
  sort_order: number
  is_default: boolean
  created_at: string
  updated_at: string
}

export interface TaskWorkflow {
  id: string
  account_id: string
  name: string
  is_default: boolean
  created_by?: string
  created_at: string
  updated_at: string
  statuses: TaskWorkflowStatus[]
}

export interface TaskCollaborator {
  user_id: string
  display_name: string
  username: string
  created_at: string
}

export interface Task {
  id: string
  account_id: string
  created_by: string
  assigned_to: string
  title: string
  description: string
  type: TaskType
  start_at?: string
  due_at?: string
  due_end_at?: string
  is_all_day?: boolean
  priority: TaskPriority
  status: TaskStatus
  status_id?: string
  status_detail?: TaskWorkflowStatus
  completed_at?: string
  completed_by?: string
  lead_id?: string
  event_id?: string
  program_id?: string
  contact_id?: string
  list_id?: string
  parent_task_id?: string
  starred?: boolean
  sort_order?: number
  progress?: number
  is_milestone?: boolean
  deleted_at?: string
  deleted_by?: string
  version?: number
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
  folder_id?: string
  folder_name?: string
  collaborators?: TaskCollaborator[]
  // Subtask counts
  subtask_count?: number
  subtask_done?: number
  comment_count?: number
  attachment_count?: number
  dependency_count?: number
  // Populated on demand
  subtasks?: Subtask[]
}

export type TaskDueFilter = '' | 'overdue' | 'today' | 'this_week' | 'no_date'

export interface TaskFilters {
  status_ids: string[]
  assigned_to_ids: string[]
  collaborator_ids: string[]
  priorities: TaskPriority[]
  types: TaskType[]
  creator_ids: string[]
  due: TaskDueFilter
  created_from: string
  created_to: string
  completed_from: string
  completed_to: string
  has_subtasks?: boolean
  has_comments?: boolean
  has_attachments?: boolean
  has_dependencies?: boolean
  starred?: boolean
}

export interface TaskSavedView {
  id: string
  account_id: string
  user_id: string
  name: string
  scope_type: 'all' | 'folder' | 'list'
  scope_id?: string
  view_mode: TaskViewMode
  filters: TaskFilters
  collapsed_status_ids: string[]
  is_default: boolean
  created_at: string
  updated_at: string
}

export interface TaskMoveResponse {
  task: Task
  operation_id: string
  order?: {
    list_id: string
    task_ids: string[]
  }
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
  folder_id?: string
  workflow_id?: string
  workflow_inherited?: boolean
  is_default?: boolean
  name: string
  description?: string
  color: string
  sort_order: number
  created_by: string
  created_at: string
  updated_at: string
  task_count: number
}

export interface TaskFolder {
  id: string
  account_id: string
  workflow_id?: string
  name: string
  description?: string
  color: string
  sort_order: number
  created_by: string
  archived_at?: string
  created_at: string
  updated_at: string
  task_count: number
  lists: TaskList[]
}

export interface TaskComment {
  id: string
  account_id: string
  task_id: string
  author_id: string
  author_name: string
  body: string
  edited_at?: string
  created_at: string
  updated_at: string
  mentions: TaskCommentMention[]
  attachments: TaskAttachment[]
  can_edit?: boolean
  can_delete?: boolean
}

export interface TaskCommentMention {
  user_id: string
  display_name: string
  username: string
}

export interface TaskActivity {
  id: string
  account_id: string
  task_id: string
  actor_id?: string
  actor_name?: string
  action: string
  metadata: Record<string, unknown>
  created_at: string
}

export interface TaskAttachment {
  id: string
  account_id: string
  task_id: string
  media_asset_id: string
  filename: string
  content_type: string
  media_type: string
  size_bytes: number
  url: string
  uploaded_by?: string
  created_at: string
}

export interface TaskDependency {
  id: string
  account_id: string
  predecessor_task_id: string
  successor_task_id: string
  dependency_type: 'finish_to_start'
  lag_minutes: number
  predecessor_title?: string
  successor_title?: string
  created_by?: string
  created_at: string
}

export interface TaskWorkSummary {
  total: number
  done: number
  active: number
  overdue: number
  owners: number
  progress: number
}

export interface TaskGanttData {
  tasks: Task[]
  dependencies: TaskDependency[]
  critical_task_ids: string[]
  slack_minutes: Record<string, number>
  unscheduled_count: number
}
