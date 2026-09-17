export type TaskType = 'call' | 'whatsapp' | 'meeting' | 'reminder'
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent'
export type TaskStatus = 'pending' | 'completed' | 'overdue' | 'cancelled'
export type TaskStatusCategory = 'not_started' | 'active' | 'done' | 'cancelled'
export type TaskViewMode = 'list' | 'board' | 'calendar' | 'gantt' | 'summary'
export type TaskLocationViewType = 'whiteboard'
export type TaskLocationViewScopeType = 'folder' | 'list'
export type TaskLocationViewLifecycle = 'active' | 'location_archived' | 'trash'
export type TaskLocationViewVisibilityMode = 'inherit' | 'restricted'
export type TaskGroupBy = 'none' | 'status' | 'list' | 'assignee' | 'priority' | 'type' | 'due'
export type TaskGroupDirection = 'asc' | 'desc'
export type TaskAccessLevel = 'none' | 'view' | 'comment' | 'edit' | 'full'
export type TaskContainerLifecycle = 'active' | 'archived' | 'trash'

export interface TaskPermissions {
  level: TaskAccessLevel
  can_view: boolean
  can_comment: boolean
  can_edit: boolean
  can_delete: boolean
	can_archive?: boolean
	can_trash?: boolean
	can_restore?: boolean
  can_manage_access: boolean
  inherited_from?: 'account_admin' | 'environment_grant' | 'environment_default' | 'environment_private' | 'environment_required' | 'folder_grant' | 'folder_private' | 'list_grant' | 'list_private' | 'task_grant' | 'task_private' | 'folder_policy' | 'list_policy' | 'historical_read_only' | 'not_visible'
}

export interface TaskEnvironment {
  id: string
  account_id: string
  name: string
  description?: string
  color: string
  icon: string
  sort_order: number
  visibility: 'account' | 'restricted'
  default_access_level: TaskAccessLevel
  is_default: boolean
  created_by?: string
  archived_at?: string
	deleted_at?: string
	deleted_by?: string
	lifecycle?: TaskContainerLifecycle
  version: number
  access_revision: number
  created_at: string
  updated_at: string
  folder_count: number
  list_count: number
  task_count: number
	open_task_count: number
	completed_task_count: number
	cancelled_task_count: number
  effective_access_level?: TaskAccessLevel
  can_manage_access?: boolean
  capabilities?: TaskPermissions
  permissions: TaskPermissions
}

export interface TaskAccessGrant {
  user_id: string
  display_name?: string
  username?: string
  access_level: TaskAccessLevel
  can_manage_access: boolean
}

export interface TaskSharedResource {
  type: 'folder' | 'list' | 'task'
  id: string
  environment_id: string
  name: string
  color?: string
  icon?: string
  access_mode?: 'inherit' | 'private'
  effective_access_level: TaskAccessLevel
  capabilities: TaskPermissions
}

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
  environment_id?: string
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
  environment_id?: string
  environment_name?: string
  breadcrumbs_visible?: boolean
  access_mode?: 'inherit' | 'private'
  effective_access_level?: TaskAccessLevel
  can_manage_access?: boolean
  capabilities?: TaskPermissions
  permissions?: TaskPermissions
  parent_task_id?: string
  starred?: boolean
  sort_order?: number
  progress?: number
  progress_mode?: 'manual' | 'automatic'
  manual_progress?: number
  progress_source?: 'manual' | 'subtasks'
  is_milestone?: boolean
  deleted_at?: string
  deleted_by?: string
  version?: number
  recurrence_rule: string
  recurrence_parent_id?: string
  reminder_minutes?: number
  notes: string
	color?: string
	resolved_color?: string
	color_source?: 'item' | 'list' | 'default'
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

export type TaskMyWorkSuggestionReason = 'overdue' | 'due_today' | 'previous_focus'

export interface TaskMyWorkSummary {
  business_date: string
  timezone: 'America/Lima'
  reset_at: string
  revision: number
  focus_count: number
  completed_count: number
  suggestion_count: number
  overdue_suggestion_count: number
  due_today_suggestion_count: number
  previous_suggestion_count: number
  maximum_daily_task_count: number
}

export interface TaskMyWorkItem {
  task: Task
  position: number
  added_at: string
}

export interface TaskMyWorkSuggestion {
  task: Task
  reasons: TaskMyWorkSuggestionReason[]
}

export interface TaskMyWorkResponse {
  summary: TaskMyWorkSummary
  focus_items: TaskMyWorkItem[]
  completed_items: TaskMyWorkItem[]
  suggestions: TaskMyWorkSuggestion[]
  focus_next_cursor?: string
  suggestions_next_cursor?: string
}

export interface TaskMyWorkMutation {
  business_date: string
  revision: number
  ordered_task_ids: string[]
  focus_count: number
  completed_count: number
  operation_id: string
  idempotent: boolean
}

export type WorkEventRSVP = 'pending' | 'accepted' | 'tentative' | 'declined'

export interface WorkEventCapabilities {
	can_view: boolean
	can_edit: boolean
	can_invite: boolean
	can_cancel: boolean
	can_trash: boolean
	can_restore: boolean
	can_purge: boolean
	can_respond: boolean
	can_set_reminder: boolean
}

export interface WorkEventAttendee {
	user_id: string
	display_name: string
	username: string
	attendance_type: 'required' | 'optional'
	rsvp: WorkEventRSVP
	reminder_minutes?: number
	version: number
	created_at: string
	updated_at: string
}

export interface WorkEvent {
	id: string
	account_id: string
	list_id?: string
	environment_id: string
	organizer_id: string
	organizer_name: string
	title: string
	description?: string
	location?: string
	meeting_url?: string
	color?: string
	resolved_color: string
	color_source: 'item' | 'list' | 'default'
	availability: 'busy' | 'free'
	is_all_day: boolean
	start_at?: string
	end_at?: string
	start_date?: string
	end_date_exclusive?: string
	timezone: string
	recurrence_rule?: string
	series_root_id?: string
	status: 'scheduled' | 'cancelled'
	cancelled_at?: string
	deleted_at?: string
	version: number
	operation_id?: string
	created_by: string
	created_at: string
	updated_at: string
	list_name?: string
	folder_id?: string
	folder_name?: string
	list_visible: boolean
	actor_rsvp?: WorkEventRSVP
	attendees: WorkEventAttendee[]
	capabilities: WorkEventCapabilities
}

export interface WorkEventOccurrence {
	event: WorkEvent
	series_id: string
	occurrence_key: string
	start_at?: string
	end_at?: string
	start_date?: string
	end_date_exclusive?: string
	is_exception: boolean
	override_version?: number
}

export type AgendaItem =
	| { kind: 'task'; key: `task:${string}`; task: Task }
	| { kind: 'event'; key: string; event: WorkEventOccurrence }

export interface TaskAgendaResponse {
	items: AgendaItem[]
	next_cursor?: string
}

export type TaskDueFilter = '' | 'overdue' | 'today' | 'this_week' | 'no_date'

export interface TaskFilters {
  include_closed: boolean
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
  scope_type: 'all' | 'environment' | 'folder' | 'list'
  scope_id?: string
  view_mode: TaskViewMode
  filters: TaskFilters
  collapsed_status_ids: string[]
  group_by: TaskGroupBy
  group_direction: TaskGroupDirection
  collapsed_group_keys: string[]
  is_default: boolean
  created_at: string
  updated_at: string
}

export interface TaskLocationViewBreadcrumbItem {
  type: 'environment' | TaskLocationViewScopeType
  id: string
  name: string
}

export interface TaskLocationViewCapabilities {
  can_view: boolean
  can_comment: boolean
  can_edit: boolean
  can_manage: boolean
  can_manage_access: boolean
}

export interface TaskLocationWhiteboardSummary {
  id: string
  name: string
  description?: string
  thumbnail_url?: string | null
  archived_at?: string | null
  version: number
  scene_sequence: number
  updated_at: string
}

export interface TaskLocationView {
  id: string
  type: TaskLocationViewType
  environment_id: string
  scope: {
    scope_type: TaskLocationViewScopeType
    scope_id: string
    scope_name: string
    breadcrumb: TaskLocationViewBreadcrumbItem[]
  }
  sort_order: number
  version: number
  access_revision: number
  visibility_mode: TaskLocationViewVisibilityMode
  lifecycle: TaskLocationViewLifecycle
  created_by?: string | null
  deleted_at?: string | null
  resource: {
    whiteboard: TaskLocationWhiteboardSummary
  }
  capabilities: TaskLocationViewCapabilities
}

export interface TaskLocationViewVisibilityMember {
  user_id: string
  display_name: string
  username: string
  effective_access_level: TaskAccessLevel
  eligible: boolean
}

export interface TaskLocationViewVisibilityPolicy {
  view_id: string
  visibility_mode: TaskLocationViewVisibilityMode
  access_revision: number
  members: TaskLocationViewVisibilityMember[]
  effective_access: {
    level: 'none' | 'view' | 'comment' | 'edit' | 'manage'
    inherited_from: string
    can_view: boolean
    can_comment: boolean
    can_edit: boolean
    can_delete: boolean
    can_manage_access: boolean
  }
}

export interface TaskLocationViewVisibilityCandidate {
  user_id: string
  display_name: string
  username: string
  effective_access_level: TaskAccessLevel
}

export type ActiveTaskView =
  | { kind: 'builtin'; view: TaskViewMode }
  | { kind: 'location'; view: TaskLocationView }

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
  environment_id?: string
  folder_id?: string
  workflow_id?: string
  workflow_inherited?: boolean
  is_default?: boolean
  name: string
  description?: string
  color: string
  icon: string
  sort_order: number
  created_by: string
  archived_at?: string
  archived_with_folder?: boolean
	deleted_at?: string
	deleted_by?: string
	deleted_with_folder?: boolean
	lifecycle?: TaskContainerLifecycle
  access_mode?: 'inherit' | 'private'
  access_revision?: number
  created_at: string
  updated_at: string
  task_count: number
  open_task_count: number
  completed_task_count: number
  cancelled_task_count: number
  whiteboard_count?: number
  effective_access_level?: TaskAccessLevel
  can_manage_access?: boolean
  capabilities?: TaskPermissions
  permissions?: TaskPermissions
}

export interface TaskTrashPolicy {
  retention_days: number | null
  can_manage: boolean
}

export interface TaskTrashContainer {
  id: string
  type: 'environment' | 'list' | 'folder'
  name: string
  color: string
  icon: string
  deleted_at: string
  archived_at?: string
	lifecycle: 'trash'
	version?: number
  original_folder_id?: string
  original_folder_name?: string
  archived_with_folder?: boolean
	deleted_with_folder?: boolean
  list_count: number
  task_count: number
  whiteboard_count?: number
  next_eligible_at?: string
  can_purge: boolean
  can_restore: boolean
  restore_blocked: boolean
}

export interface TaskFolder {
  id: string
  account_id: string
  environment_id?: string
  workflow_id?: string
  name: string
  description?: string
  color: string
  icon: string
  sort_order: number
  created_by: string
  archived_at?: string
	deleted_at?: string
	deleted_by?: string
	lifecycle?: TaskContainerLifecycle
  access_mode?: 'inherit' | 'private'
  access_revision?: number
  created_at: string
  updated_at: string
  task_count: number
  open_task_count: number
  completed_task_count: number
  cancelled_task_count: number
  whiteboard_count?: number
  effective_access_level?: TaskAccessLevel
  can_manage_access?: boolean
  capabilities?: TaskPermissions
  permissions?: TaskPermissions
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
  preview?: TaskAttachmentPreview
  uploaded_by?: string
  created_at: string
}

export interface TaskAttachmentPreview {
  id: string
  account_id: string
  task_id: string
  attachment_id: string
  kind: 'image' | 'pdf' | 'text' | 'word_pdf' | 'unsupported'
  status: 'pending' | 'processing' | 'ready' | 'failed' | 'unsupported'
  derivative_asset_id?: string
  url?: string
  page_count: number
  error?: string
  version: number
  created_at: string
  updated_at: string
}

export interface TaskAttachmentAnchor {
  kind: 'image' | 'pdf' | 'text'
  page?: number
  x?: number
  y?: number
  line?: number
  offset?: number
  quote?: string
}

export interface TaskAttachmentComment {
  id: string
  account_id: string
  task_id: string
  attachment_id: string
  parent_id?: string
  author_id: string
  author_name: string
  body: string
  anchor: TaskAttachmentAnchor
  resolved_at?: string
  resolved_by?: string
  resolved_by_name?: string
  edited_at?: string
  deleted?: boolean
  version: number
  created_at: string
  updated_at: string
  can_edit?: boolean
  can_delete?: boolean
  can_resolve?: boolean
  mentions: TaskCommentMention[]
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
