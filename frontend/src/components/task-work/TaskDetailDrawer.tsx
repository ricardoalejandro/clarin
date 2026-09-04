'use client'

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  Activity,
  AlertCircle,
  ArrowRightLeft,
  CalendarRange,
  Check,
  ChevronRight,
  Download,
  File,
  Flag,
  Link2,
  ListTodo,
  Loader2,
  Maximize2,
  MessageSquare,
  Minimize2,
  Move,
  PanelRight,
  Paperclip,
  Palette,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Send,
  Trash2,
  UserRound,
  X,
} from 'lucide-react'
import { apiDelete, apiGet, apiPatch, apiPost, apiPut, apiUpload, subscribeWebSocket } from '@/lib/api'
import { SEARCH_DEBOUNCE_MS } from '@/lib/useDebouncedValue'
import {
  Task,
  TaskActivity,
  TaskAttachment,
  TaskComment,
  TaskDependency,
  TaskFolder,
  TaskList,
  TaskWorkflow,
} from '@/types/task'
import { TaskAccountUser } from './TaskEditorModal'
import TaskCollaboratorPicker from './TaskCollaboratorPicker'
import { TaskPriorityPicker, TaskStatusPicker } from './TaskPropertyPicker'
import TaskUserCombobox from './TaskUserCombobox'
import useTaskDetailWindow, { type TaskDetailResizeEdge } from './useTaskDetailWindow'
import TaskDestructiveConfirmDialog from './TaskDestructiveConfirmDialog'
import { TaskListPicker } from './TaskSelectPicker'
import TaskDateRangePicker from './TaskDateRangePicker'
import TaskAttachmentViewer from './TaskAttachmentViewer'
import { TASK_OVERLAY_LAYERS } from './taskOverlayLayers'
import { taskDetailVisualState } from './taskDetailInspectorState'
import type { TaskHierarchyCounts } from './taskHierarchyCounts'
import TaskDescriptionEditor from './TaskDescriptionEditor'
import { taskAttachmentUploadEndpoint, taskAttachmentUploadForm, taskImageFilesFromClipboard } from './taskAttachmentQueue'
import TaskAccessPanel from './TaskAccessPanel'
import TaskMoveEnvironmentDialog from './TaskMoveEnvironmentDialog'
import TaskParticipantGrantConfirmDialog from './TaskParticipantGrantConfirmDialog'
import { canAdministerTask, canCommentOnTask, canEditTask } from './taskPermissionActions'
import { mergeCommentAttachmentDrafts, removeCommentAttachmentDrafts, resolveCommentAttachment, type TaskCommentAttachmentLookup } from './taskCommentAttachmentDrafts'
import { TaskColorPicker } from './TaskContainerAppearance'
import { resolveTaskIdentityColor } from './taskIdentityColor'
import { validateManualProgress } from './taskProgress'
import TaskProgressControl from './TaskProgressControl'
import TaskCompletionButton from './TaskCompletionButton'
import TaskQuickSubtaskComposer, { createTaskQuickSubtaskDraft, type TaskQuickSubtaskDraft } from './TaskQuickSubtaskComposer'
import { taskCompletionTransition } from './taskStatusTransition'
import { resolveTaskDetailEscape, TASK_DETAIL_ESCAPE_LAYER_SELECTOR } from './taskDetailEscape'
import { projectTaskVisualUpdate, type TaskVisualUpdate } from './taskVisualProjection'
import {
  TaskDescriptionAutosaveCoordinator,
  type TaskDescriptionAutosaveState,
  type TaskDescriptionConflict,
  type TaskDescriptionSaveOutcome,
  type TaskDescriptionSaveRequest,
} from './taskDescriptionAutosave'

interface Props {
  taskId: string | null
  availableWorkspaceWidth?: number
  inFlowDocked?: boolean
  historicalReadOnly?: boolean
  allTasks: Task[]
  users: TaskAccountUser[]
  lists: TaskList[]
  folders: TaskFolder[]
  workflows: TaskWorkflow[]
  subtaskDraftResetToken?: number
  storageScope?: string
  onClose: () => void
  onEdit: (task: Task) => void
  onOpenTask: (taskId: string) => void
  onCreateSubtask: (task: Task, draft?: TaskQuickSubtaskDraft) => void
  onChanged: (task?: Task, operationID?: string, hierarchyCounts?: TaskHierarchyCounts) => void
  onDeleted: (taskId: string, version?: number, operationID?: string, hierarchyCounts?: TaskHierarchyCounts) => boolean
}

export interface TaskDetailDrawerHandle {
  requestClose: () => Promise<boolean>
}

type DetailTab = 'details' | 'activity'
type FeedFilter = 'all' | 'comments' | 'changes'
type PendingOperations = Record<string, number>
type Failure = { message: string; canRetry: boolean }
type ParticipantGrantPrompt = { taskId: string; affectedUserIDs: string[]; retry: () => void }
type TaskMutationResponse = {
  task?: Task
  operation_id?: string
  hierarchy_counts?: TaskHierarchyCounts
  code?: string
  affected_user_ids?: string[]
  current?: TaskDescriptionConflict
}
type TaskCommentPage = { comments: TaskComment[]; has_more: boolean; next_offset: number }
type TaskDetailDraft = {
  title: string
  description: string
  comment: string
  commentMentionIds: string[]
  commentAttachmentIds: string[]
  commentAttachmentLookup: TaskCommentAttachmentLookup
  editingCommentId: string
  editingCommentBody: string
  editingMentionIds: string[]
  editingAttachmentIds: string[]
  subtaskDraft: TaskQuickSubtaskDraft
  subtaskDraftTouched: boolean
}
type TaskReadSession = { taskId: string; generation: number; controller: AbortController }
type TaskReadToken = { taskId: string; generation: number; signal?: AbortSignal }
type TaskUploadContext = { task: Task; taskId: string; generation: number }
type FeedItem =
  | { kind: 'comment'; id: string; createdAt: string; comment: TaskComment }
  | { kind: 'activity'; id: string; createdAt: string; activity: TaskActivity }

const dateFormatter = new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' })
const activityLabels: Record<string, string> = {
  created: 'creó la tarea',
  updated: 'actualizó la tarea',
  moved: 'movió la tarea',
  completed: 'completó la tarea',
  archived: 'archivó la tarea',
  restored: 'restauró la tarea',
  subtask_created: 'añadió una subtarea',
  collaborators_updated: 'cambió los colaboradores',
  attachment_added: 'adjuntó un archivo',
  attachment_deleted: 'quitó un archivo',
  attachment_comment_added: 'comentó sobre un adjunto',
  attachment_comment_resolved: 'resolvió un comentario de adjunto',
  attachment_comment_reopened: 'reabrió un comentario de adjunto',
  attachment_comment_updated: 'editó un comentario de adjunto',
  attachment_comment_deleted: 'eliminó un comentario de adjunto',
  dependency_added: 'añadió una dependencia',
  dependency_deleted: 'quitó una dependencia',
  description_updated: 'actualizó la descripción',
}
const taskStructureActions = new Set(['folder_created', 'folder_updated', 'folder_archived', 'list_created', 'list_updated', 'list_archived', 'list_deleted', 'workflow_created', 'workflow_updated', 'status_created', 'status_updated', 'status_deleted'])
const resizeHandles: Record<TaskDetailResizeEdge, string> = {
  n: 'left-3 right-3 top-0 h-1.5 cursor-n-resize',
  e: 'bottom-3 right-0 top-3 w-1.5 cursor-e-resize',
  s: 'bottom-0 left-3 right-3 h-1.5 cursor-s-resize',
  w: 'bottom-3 left-0 top-3 w-1.5 cursor-w-resize',
  ne: 'right-0 top-0 h-3 w-3 cursor-ne-resize',
  nw: 'left-0 top-0 h-3 w-3 cursor-nw-resize',
  se: 'bottom-0 right-0 h-3 w-3 cursor-se-resize',
  sw: 'bottom-0 left-0 h-3 w-3 cursor-sw-resize',
}
const inputClass = 'w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-700 outline-none transition focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100 disabled:bg-slate-50 disabled:opacity-60'

function TaskPropertyRow({ label, icon, children, className = '' }: { label: string; icon: ReactNode; children: ReactNode; className?: string }) {
  return <div className={`grid gap-2 border-b border-slate-100 px-3 py-3 last:border-b-0 sm:grid-cols-[8.75rem_minmax(0,1fr)] sm:items-start sm:px-4 ${className}`}>
    <div className="flex min-h-10 items-center gap-2 text-xs font-bold text-slate-500"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500">{icon}</span><span>{label}</span></div>
    <div className="min-w-0">{children}</div>
  </div>
}

function localDateTime(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function initials(name: string) {
  return name.trim().slice(0, 2).toUpperCase() || 'CL'
}

function taskWorkflowStatuses(task: Task, lists: TaskList[], workflows: TaskWorkflow[]) {
  const explicitWorkflowID = task.status_detail?.workflow_id
  const listWorkflowID = lists.find(item => item.id === task.list_id)?.workflow_id
  const workflow = workflows.find(item => item.id === explicitWorkflowID)
    || (!explicitWorkflowID ? workflows.find(item => item.id === listWorkflowID) : undefined)
  if (workflow?.statuses?.length) return workflow.statuses
  return task.status_detail ? [task.status_detail] : []
}

const TaskDetailDrawer = forwardRef<TaskDetailDrawerHandle, Props>(function TaskDetailDrawer({ taskId, availableWorkspaceWidth = 0, inFlowDocked = false, historicalReadOnly = false, allTasks, users, lists, folders, workflows, subtaskDraftResetToken = 0, storageScope, onClose, onEdit, onOpenTask, onCreateSubtask, onChanged, onDeleted }, forwardedRef) {
  const [task, setTask] = useState<Task | null>(null)
  const [children, setChildren] = useState<Task[]>([])
  const [comments, setComments] = useState<TaskComment[]>([])
  const [commentsHasMore, setCommentsHasMore] = useState(false)
  const [commentsLoadingMore, setCommentsLoadingMore] = useState(false)
  const [activity, setActivity] = useState<TaskActivity[]>([])
  const [attachments, setAttachments] = useState<TaskAttachment[]>([])
  const [dependencies, setDependencies] = useState<TaskDependency[]>([])
  const [tab, setTab] = useState<DetailTab>('details')
  const [feedFilter, setFeedFilter] = useState<FeedFilter>('all')
  const [loading, setLoading] = useState(false)
  const [sectionsLoading, setSectionsLoading] = useState(false)
  const [pending, setPending] = useState<PendingOperations>({})
  const [failure, setFailure] = useState<Failure | null>(null)
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false)
  const [archiveTaskId, setArchiveTaskId] = useState('')
  const [moveEnvironmentOpen, setMoveEnvironmentOpen] = useState(false)
  const [archiveError, setArchiveError] = useState('')
  const [panelWidth, setPanelWidth] = useState(0)
  const [participantGrantPrompt, setParticipantGrantPrompt] = useState<ParticipantGrantPrompt | null>(null)

  const [titleDraft, setTitleDraft] = useState('')
  const [descriptionDraft, setDescriptionDraft] = useState('')
  const [descriptionExpanded, setDescriptionExpanded] = useState(false)
  const [descriptionSaveState, setDescriptionSaveState] = useState<TaskDescriptionAutosaveState | undefined>()
  const [startDraft, setStartDraft] = useState('')
  const [dueDraft, setDueDraft] = useState('')
  const [allDayDraft, setAllDayDraft] = useState(false)
  const [progressDraft, setProgressDraft] = useState(0)
  const [progressInput, setProgressInput] = useState('0')
  const [progressError, setProgressError] = useState('')
  const [progressMode, setProgressMode] = useState<'manual' | 'automatic'>('manual')
  const [previewAttachment, setPreviewAttachment] = useState<TaskAttachment | null>(null)
  const [subtaskDraft, setSubtaskDraft] = useState<TaskQuickSubtaskDraft>(() => createTaskQuickSubtaskDraft({ assigned_to: '' }, []))

  const [comment, setComment] = useState('')
  const [commentMentionIds, setCommentMentionIds] = useState<string[]>([])
  const [commentAttachmentIds, setCommentAttachmentIds] = useState<string[]>([])
  const [commentAttachmentLookup, setCommentAttachmentLookup] = useState<TaskCommentAttachmentLookup>({})
  const [editingCommentId, setEditingCommentId] = useState('')
  const [editingCommentBody, setEditingCommentBody] = useState('')
  const [editingMentionIds, setEditingMentionIds] = useState<string[]>([])
  const [editingAttachmentIds, setEditingAttachmentIds] = useState<string[]>([])

  const [dependencyTaskId, setDependencyTaskId] = useState('')
  const [dependencySearch, setDependencySearch] = useState('')
  const [dependencySettledSearch, setDependencySettledSearch] = useState('')
  const [dependencyResults, setDependencyResults] = useState<Task[]>([])
  const [dependencySearching, setDependencySearching] = useState(false)
  const [dependencyPickerOpen, setDependencyPickerOpen] = useState(false)
  const [newFeedItems, setNewFeedItems] = useState(false)

  const panelRef = useRef<HTMLElement>(null)
  const detailsScrollRef = useRef<HTMLElement | null>(null)
  const feedScrollRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const commentFileRef = useRef<HTMLInputElement>(null)
  const editCommentFileRef = useRef<HTMLInputElement>(null)
  const taskIdRef = useRef<string | null>(null)
  const taskRef = useRef<Task | null>(null)
  const loadSequenceRef = useRef(0)
  const readSessionRef = useRef<TaskReadSession | null>(null)
  const dependencySearchSequenceRef = useRef(0)
  const dependencySearchAbortRef = useRef<AbortController | null>(null)
  const taskWriteQueuesRef = useRef(new Map<string, Promise<void>>())
  const taskSnapshotsRef = useRef(new Map<string, Task>())
  const draftsByTaskRef = useRef(new Map<string, TaskDetailDraft>())
  const currentDraftRef = useRef<TaskDetailDraft | null>(null)
  const allTasksRef = useRef(allTasks)
  const listsRef = useRef(lists)
  const workflowsRef = useRef(workflows)
  const subtaskDraftResetTokenRef = useRef(subtaskDraftResetToken)
  const subtaskDraftTouchedRef = useRef(false)
  const preservedDraftKeysRef = useRef(new Set<string>())
  const draftBodiesRef = useRef<Record<string, Record<string, unknown>>>({})
  const failureRetryRef = useRef<(() => void) | null>(null)
  const failuresByTaskRef = useRef(new Map<string, { failure: Failure; retry: (() => void) | null }>())
  const feedNearBottomRef = useRef(true)
  const feedCountRef = useRef(0)
  const feedContextRef = useRef('')
  const modalPreviousFocusRef = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)
  const requestCloseRef = useRef<() => void>(() => onClose())
  const commentsNextOffsetRef = useRef(0)
  const commentsRef = useRef<TaskComment[]>([])
  const prependScrollHeightRef = useRef<number | null>(null)
  const editingTitleRef = useRef(false)
  const skipTitleSaveRef = useRef(false)
  const editingDescriptionRef = useRef(false)
  const descriptionComposingRef = useRef(false)
  const editingDatesRef = useRef(false)
  const editingProgressRef = useRef(false)
  const taskNavigationReturnRef = useRef<{ parentTaskId: string; childTaskId: string; scrollTop: number; tab: DetailTab } | null>(null)
  const pendingParentRestoreRef = useRef<{ parentTaskId: string; childTaskId: string; scrollTop: number; tab: DetailTab } | null>(null)
  const updateTaskRef = useRef<(key: string, body: Record<string, unknown>, confirmGrants?: boolean) => Promise<boolean>>(async () => false)
  const descriptionSaveHandlerRef = useRef<(request: TaskDescriptionSaveRequest) => Promise<TaskDescriptionSaveOutcome>>(async () => ({ kind: 'error', message: 'No se pudo guardar la descripción.' }))
  const descriptionAutosaveRef = useRef<TaskDescriptionAutosaveCoordinator | null>(null)
  const detailWindow = useTaskDetailWindow(storageScope, availableWorkspaceWidth)
  const windowVisual = taskDetailVisualState(detailWindow.effectiveMode, detailWindow.isMobile)
  const taskOpen = Boolean(taskId)
  onCloseRef.current = onClose
  const onOpenTaskRef = useRef(onOpenTask)
  onOpenTaskRef.current = onOpenTask
  allTasksRef.current = allTasks
  listsRef.current = lists
  workflowsRef.current = workflows
  commentsRef.current = comments
  if (!descriptionAutosaveRef.current) {
    descriptionAutosaveRef.current = new TaskDescriptionAutosaveCoordinator({
      save: request => descriptionSaveHandlerRef.current(request),
      onStateChange: (changedTaskId, state) => {
        const savedDraft = draftsByTaskRef.current.get(changedTaskId)
        if (savedDraft) {
          savedDraft.description = state.draft
          draftsByTaskRef.current.set(changedTaskId, savedDraft)
        }
        if (taskIdRef.current !== changedTaskId) return
        const clean = state.draft === state.canonical && state.phase !== 'conflict' && state.phase !== 'error'
        editingDescriptionRef.current = !clean
        if (clean) preservedDraftKeysRef.current.delete('description')
        else preservedDraftKeysRef.current.add('description')
        setDescriptionSaveState(state)
      },
    })
  }
  currentDraftRef.current = {
    title: titleDraft,
    description: descriptionDraft,
    comment,
    commentMentionIds: [...commentMentionIds],
    commentAttachmentIds: [...commentAttachmentIds],
    commentAttachmentLookup: { ...commentAttachmentLookup },
    editingCommentId,
    editingCommentBody,
    editingMentionIds: [...editingMentionIds],
    editingAttachmentIds: [...editingAttachmentIds],
    subtaskDraft: { ...subtaskDraft },
    subtaskDraftTouched: subtaskDraftTouchedRef.current,
  }
  useEffect(() => { setDescriptionExpanded(false) }, [taskId])
  const historicalReadURL = useCallback((url: string) => historicalReadOnly
    ? `${url}${url.includes('?') ? '&' : '?'}lifecycle=archive`
    : url, [historicalReadOnly])

  draftBodiesRef.current = {
    title: { title: titleDraft.trim() },
    description: { description: descriptionDraft },
    dates: {
      start_at: startDraft ? new Date(startDraft).toISOString() : '',
      due_at: dueDraft ? new Date(dueDraft).toISOString() : '',
      is_all_day: allDayDraft,
    },
    progress: { progress_mode: progressMode, manual_progress: progressDraft },
  }

  const pendingOperationKey = useCallback((taskID: string | null, key: string) => `${taskID || 'closed'}:${key}`, [])
  const beginPending = useCallback((key: string, taskID = taskIdRef.current) => {
    const scopedKey = pendingOperationKey(taskID, key)
    setPending(current => ({ ...current, [scopedKey]: (current[scopedKey] || 0) + 1 }))
  }, [pendingOperationKey])
  const endPending = useCallback((key: string, taskID = taskIdRef.current) => {
    const scopedKey = pendingOperationKey(taskID, key)
    setPending(current => {
      const next = { ...current }
      const count = (next[scopedKey] || 1) - 1
      if (count > 0) next[scopedKey] = count
      else delete next[scopedKey]
      return next
    })
  }, [pendingOperationKey])
  const isPending = useCallback((key: string) => Boolean(pending[pendingOperationKey(taskId, key)]), [pending, pendingOperationKey, taskId])
  const isTaskPending = useCallback((key: string, taskID: string) => Boolean(pending[pendingOperationKey(taskID, key)]), [pending, pendingOperationKey])
  const showFailure = useCallback((message: string, retry?: () => void, taskID = taskIdRef.current) => {
    if (!taskID) return
    const entry = { failure: { message, canRetry: Boolean(retry) }, retry: retry || null }
    failuresByTaskRef.current.set(taskID, entry)
    if (taskIdRef.current !== taskID) return
    failureRetryRef.current = entry.retry
    setFailure(entry.failure)
  }, [])
  const clearFailure = useCallback((taskID = taskIdRef.current) => {
    if (taskID) failuresByTaskRef.current.delete(taskID)
    if (taskIdRef.current !== taskID) return
    failureRetryRef.current = null
    setFailure(null)
  }, [])

  const captureReadToken = useCallback((): TaskReadToken | null => {
    const requestedTaskId = taskIdRef.current
    if (!requestedTaskId) return null
    const session = readSessionRef.current
    return {
      taskId: requestedTaskId,
      generation: session?.taskId === requestedTaskId ? session.generation : loadSequenceRef.current,
      signal: session?.taskId === requestedTaskId ? session.controller.signal : undefined,
    }
  }, [])
  const acceptsReadToken = useCallback((token: TaskReadToken) => {
    const session = readSessionRef.current
    return !token.signal?.aborted
      && taskIdRef.current === token.taskId
      && loadSequenceRef.current === token.generation
      && session?.taskId === token.taskId
      && session.generation === token.generation
  }, [])

  const applyTask = useCallback((incoming: Task, forceDrafts = false) => {
    const stored = taskSnapshotsRef.current.get(incoming.id)
    if (stored && Number(incoming.version || 0) < Number(stored.version || 0)) return
    const current = taskIdRef.current === incoming.id ? taskRef.current : stored
    if (current?.id === incoming.id && Number(incoming.version || 0) < Number(current.version || 0)) return
    const next = incoming.collaborators === undefined && current?.collaborators !== undefined
      ? { ...incoming, collaborators: current.collaborators }
      : incoming
    taskSnapshotsRef.current.set(incoming.id, next)
    descriptionAutosaveRef.current?.syncCanonical(incoming.id, next.description || '', {
      description: next.description || '',
      version: Number(next.version || 0),
      updated_at: next.updated_at,
    })
    if (taskIdRef.current !== incoming.id) return
    taskRef.current = next
    setTask(next)
    if (forceDrafts || (!editingTitleRef.current && !preservedDraftKeysRef.current.has('title'))) setTitleDraft(next.title)
    if (!preservedDraftKeysRef.current.has('description') && (forceDrafts || !editingDescriptionRef.current)) setDescriptionDraft(next.description || '')
    if (forceDrafts || (!editingDatesRef.current && !preservedDraftKeysRef.current.has('dates'))) {
      setStartDraft(localDateTime(next.start_at))
      setDueDraft(localDateTime(next.due_at))
      setAllDayDraft(Boolean(next.is_all_day))
    }
    if (forceDrafts || (!editingProgressRef.current && !preservedDraftKeysRef.current.has('progress'))) {
      const manual = next.manual_progress ?? next.progress ?? 0
      setProgressDraft(manual)
      setProgressInput(String(manual))
      setProgressError('')
      setProgressMode(next.progress_mode || 'manual')
    }
    if (!subtaskDraftTouchedRef.current) {
      setSubtaskDraft(createTaskQuickSubtaskDraft(next, taskWorkflowStatuses(next, listsRef.current, workflowsRef.current)))
    }
  }, [])

  const persistDescription = useCallback((request: TaskDescriptionSaveRequest): Promise<TaskDescriptionSaveOutcome> => {
    const requestedTaskId = request.taskId
    beginPending('description', requestedTaskId)
    if (taskIdRef.current === requestedTaskId) preservedDraftKeysRef.current.add('description')
    const execute = async (): Promise<TaskDescriptionSaveOutcome> => {
      const current = taskSnapshotsRef.current.get(requestedTaskId)
        || (taskRef.current?.id === requestedTaskId ? taskRef.current : undefined)
        || allTasksRef.current.find(item => item.id === requestedTaskId)
      if (!current) return { kind: 'error', message: 'No pudimos encontrar la tarea para guardar la descripción.' }
      if (!canEditTask(current)) return { kind: 'error', message: 'No tienes permiso para modificar esta tarea.' }

      const operationID = crypto.randomUUID()
      const result = await apiPatch<TaskMutationResponse>(`/api/tasks/${requestedTaskId}/description`, {
        description: request.description,
        version: request.versionOverride ?? current.version,
        operation_id: operationID,
      })
      if (!result.success || !result.data?.current) {
        if (result.status === 409 && result.data?.code === 'version_conflict' && result.data.current) {
          const remote = result.data.current
          const canonical = {
            ...current,
            description: remote.description,
            version: remote.version,
            updated_at: remote.updated_at || current.updated_at,
          }
          taskSnapshotsRef.current.set(requestedTaskId, canonical)
          if (taskIdRef.current === requestedTaskId) {
            taskRef.current = canonical
            setTask(canonical)
          }
          onChanged(canonical)
          return { kind: 'conflict', message: result.error || 'La descripción cambió en otra sesión.', current: remote }
        }
        return { kind: 'error', message: result.error || 'No se pudo guardar la descripción.' }
      }
      const saved = result.data.current
      const latestSnapshot = taskSnapshotsRef.current.get(requestedTaskId)
      if (latestSnapshot && Number(latestSnapshot.version || 0) > Number(saved.version || 0)) {
        if ((latestSnapshot.description || '') !== (saved.description || '')) {
          return {
            kind: 'conflict',
            message: 'La descripción cambió en otra sesión.',
            current: {
              description: latestSnapshot.description || '',
              version: Number(latestSnapshot.version || 0),
              updated_at: latestSnapshot.updated_at,
            },
          }
        }
        return { kind: 'success', description: latestSnapshot.description || '' }
      }
      const savedTask = {
        ...(latestSnapshot || current),
        description: saved.description,
        version: saved.version,
        updated_at: saved.updated_at || current.updated_at,
      }
      applyTask(savedTask)
      onChanged(savedTask, result.data.operation_id || operationID)
      return { kind: 'success', description: saved.description || '' }
    }

    const previousQueue = taskWriteQueuesRef.current.get(requestedTaskId) || Promise.resolve()
    const queued = previousQueue.then(execute, execute)
    taskWriteQueuesRef.current.set(requestedTaskId, queued.then(() => undefined, () => undefined))
    return queued.finally(() => endPending('description', requestedTaskId))
  }, [applyTask, beginPending, endPending, onChanged])
  descriptionSaveHandlerRef.current = persistDescription

  const refreshTask = useCallback(async () => {
    const token = captureReadToken()
    if (!token) return
    const response = await apiGet<{ task: Task }>(historicalReadURL(`/api/tasks/${token.taskId}`), { signal: token.signal })
    if (!acceptsReadToken(token)) return
    if (response.success && response.data?.task) applyTask(response.data.task)
    else showFailure(response.error || 'No se pudo actualizar la tarea', () => { void refreshTask() }, token.taskId)
  }, [acceptsReadToken, applyTask, captureReadToken, historicalReadURL, showFailure])

  const refreshChildren = useCallback(async () => {
    const token = captureReadToken()
    if (!token) return
    const response = await apiGet<{ tasks: Task[] }>(historicalReadURL(`/api/tasks/${token.taskId}/children`), { signal: token.signal })
    if (acceptsReadToken(token) && response.success) setChildren(response.data?.tasks || [])
  }, [acceptsReadToken, captureReadToken, historicalReadURL])
  const refreshComments = useCallback(async () => {
    const token = captureReadToken()
    if (!token) return
    const response = await apiGet<TaskCommentPage>(historicalReadURL(`/api/tasks/${token.taskId}/comments?limit=100&offset=0`), { signal: token.signal })
    if (!acceptsReadToken(token) || !response.success) return
    const latest = response.data?.comments || []
    const existing = new Map(commentsRef.current.map(item => [item.id, item]))
    let inserted = 0
    for (const item of latest) {
      if (!existing.has(item.id)) inserted++
      existing.set(item.id, item)
    }
    if (commentsNextOffsetRef.current > 0) commentsNextOffsetRef.current += inserted
    const merged = Array.from(existing.values()).sort((left, right) => new Date(left.created_at).getTime() - new Date(right.created_at).getTime())
    commentsRef.current = merged
    setComments(merged)
    if (commentsNextOffsetRef.current <= 100) {
      commentsNextOffsetRef.current = response.data?.next_offset || latest.length
      setCommentsHasMore(Boolean(response.data?.has_more))
    }
  }, [acceptsReadToken, captureReadToken, historicalReadURL])
  const loadOlderComments = useCallback(async () => {
    const token = captureReadToken()
    if (!token || commentsLoadingMore || !commentsHasMore) return
    const offset = commentsNextOffsetRef.current
    setCommentsLoadingMore(true)
    prependScrollHeightRef.current = feedScrollRef.current?.scrollHeight ?? null
    const response = await apiGet<TaskCommentPage>(historicalReadURL(`/api/tasks/${token.taskId}/comments?limit=100&offset=${offset}`), { signal: token.signal })
    if (!acceptsReadToken(token)) {
      if (taskIdRef.current === token.taskId) setCommentsLoadingMore(false)
      return
    }
    if (!response.success) {
      prependScrollHeightRef.current = null
      showFailure(response.error || 'No se pudieron cargar los comentarios anteriores', () => { void loadOlderComments() })
      setCommentsLoadingMore(false)
      return
    }
    const older = response.data?.comments || []
    const byID = new Map([...older, ...commentsRef.current].map(item => [item.id, item]))
    const merged = Array.from(byID.values()).sort((left, right) => new Date(left.created_at).getTime() - new Date(right.created_at).getTime())
    commentsRef.current = merged
    setComments(merged)
    commentsNextOffsetRef.current = response.data?.next_offset ?? offset + older.length
    setCommentsHasMore(Boolean(response.data?.has_more))
    setCommentsLoadingMore(false)
  }, [acceptsReadToken, captureReadToken, commentsHasMore, commentsLoadingMore, historicalReadURL, showFailure])
  const refreshActivity = useCallback(async () => {
    const token = captureReadToken()
    if (!token) return
    const response = await apiGet<{ activity: TaskActivity[] }>(historicalReadURL(`/api/tasks/${token.taskId}/activity`), { signal: token.signal })
    if (acceptsReadToken(token) && response.success) setActivity(response.data?.activity || [])
  }, [acceptsReadToken, captureReadToken, historicalReadURL])
  const refreshAttachments = useCallback(async () => {
    const token = captureReadToken()
    if (!token) return
    const response = await apiGet<{ attachments: TaskAttachment[] }>(historicalReadURL(`/api/tasks/${token.taskId}/attachments`), { signal: token.signal })
    if (acceptsReadToken(token) && response.success) setAttachments(response.data?.attachments || [])
  }, [acceptsReadToken, captureReadToken, historicalReadURL])
  const refreshDependencies = useCallback(async () => {
    const token = captureReadToken()
    if (!token) return
    const response = await apiGet<{ dependencies: TaskDependency[] }>(historicalReadURL(`/api/tasks/${token.taskId}/dependencies`), { signal: token.signal })
    if (acceptsReadToken(token) && response.success) setDependencies(response.data?.dependencies || [])
  }, [acceptsReadToken, captureReadToken, historicalReadURL])

  const removeAttachmentReferences = useCallback((attachmentId: string) => {
    const next = commentsRef.current.map(item => {
      const nextAttachments = item.attachments.filter(file => file.id !== attachmentId)
      return nextAttachments.length === item.attachments.length ? item : { ...item, attachments: nextAttachments }
    })
    commentsRef.current = next
    setComments(next)
    setCommentAttachmentIds(current => current.filter(id => id !== attachmentId))
    setEditingAttachmentIds(current => current.filter(id => id !== attachmentId))
    setCommentAttachmentLookup(current => removeCommentAttachmentDrafts(current, [attachmentId]))
  }, [])

  const load = useCallback(async () => {
    const requestedTaskId = taskIdRef.current
    if (!requestedTaskId) return
    readSessionRef.current?.controller.abort()
    const sequence = ++loadSequenceRef.current
    const controller = new AbortController()
    readSessionRef.current = { taskId: requestedTaskId, generation: sequence, controller }
    setLoading(true)
    setSectionsLoading(true)
    const taskRequest = apiGet<{ task: Task }>(historicalReadURL(`/api/tasks/${requestedTaskId}`), { signal: controller.signal })
    const sectionRequests = [
      apiGet<{ tasks: Task[] }>(historicalReadURL(`/api/tasks/${requestedTaskId}/children`), { signal: controller.signal }),
      apiGet<TaskCommentPage>(historicalReadURL(`/api/tasks/${requestedTaskId}/comments?limit=100&offset=0`), { signal: controller.signal }),
      apiGet<{ activity: TaskActivity[] }>(historicalReadURL(`/api/tasks/${requestedTaskId}/activity`), { signal: controller.signal }),
      apiGet<{ attachments: TaskAttachment[] }>(historicalReadURL(`/api/tasks/${requestedTaskId}/attachments`), { signal: controller.signal }),
      apiGet<{ dependencies: TaskDependency[] }>(historicalReadURL(`/api/tasks/${requestedTaskId}/dependencies`), { signal: controller.signal }),
    ] as const
    const taskRes = await taskRequest
    if (controller.signal.aborted || loadSequenceRef.current !== sequence || taskIdRef.current !== requestedTaskId) return
    if (!taskRes.success || !taskRes.data?.task) {
      setLoading(false)
      setSectionsLoading(false)
      showFailure(taskRes.error || 'No se pudo abrir la tarea', () => { void load() }, requestedTaskId)
      return
    }
    applyTask(taskRes.data.task, !draftsByTaskRef.current.has(requestedTaskId))
    const [childRes, commentRes, activityRes, attachmentRes, dependencyRes] = await Promise.all(sectionRequests)
    if (controller.signal.aborted || loadSequenceRef.current !== sequence || taskIdRef.current !== requestedTaskId) return
    setChildren(childRes.data?.tasks || [])
    commentsRef.current = commentRes.data?.comments || []
    setComments(commentsRef.current)
    commentsNextOffsetRef.current = commentRes.data?.next_offset || commentRes.data?.comments?.length || 0
    setCommentsHasMore(Boolean(commentRes.data?.has_more))
    setActivity(activityRes.data?.activity || [])
    setAttachments(attachmentRes.data?.attachments || [])
    setDependencies(dependencyRes.data?.dependencies || [])
    if (![childRes, commentRes, activityRes, attachmentRes, dependencyRes].every(result => result.success)) {
      showFailure('Algunos datos de la tarea no se pudieron cargar.', () => { void load() }, requestedTaskId)
    }
    setLoading(false)
    setSectionsLoading(false)
    const restore = pendingParentRestoreRef.current
    if (restore?.parentTaskId === requestedTaskId) {
      pendingParentRestoreRef.current = null
      setTab(restore.tab)
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        if (taskIdRef.current !== requestedTaskId) return
        detailsScrollRef.current?.scrollTo({ top: restore.scrollTop })
        document.getElementById(`task-child-link-${restore.childTaskId}`)?.focus({ preventScroll: true })
      }))
    }
  }, [applyTask, historicalReadURL, showFailure])

  useEffect(() => {
    const previousTaskId = taskIdRef.current
    if (previousTaskId && currentDraftRef.current) {
      const latestDescription = descriptionAutosaveRef.current?.getState(previousTaskId)?.draft ?? currentDraftRef.current.description
      draftsByTaskRef.current.set(previousTaskId, { ...currentDraftRef.current, description: latestDescription })
      descriptionAutosaveRef.current?.setComposing(previousTaskId, false)
      void descriptionAutosaveRef.current?.flush(previousTaskId)
    }
    readSessionRef.current?.controller.abort()
    loadSequenceRef.current += 1
    taskIdRef.current = taskId
    taskRef.current = null
    editingTitleRef.current = false
    skipTitleSaveRef.current = false
    editingDescriptionRef.current = false
    descriptionComposingRef.current = false
    editingDatesRef.current = false
    editingProgressRef.current = false
    preservedDraftKeysRef.current.clear()
    setParticipantGrantPrompt(null)
    setArchiveConfirmOpen(false)
    setArchiveTaskId('')
    setArchiveError('')
    setMoveEnvironmentOpen(false)
    const savedDraft = taskId ? draftsByTaskRef.current.get(taskId) : undefined
    subtaskDraftTouchedRef.current = Boolean(savedDraft?.subtaskDraftTouched)
    const seed = taskId ? taskSnapshotsRef.current.get(taskId) || allTasksRef.current.find(item => item.id === taskId) : undefined
    if (seed) {
      taskSnapshotsRef.current.set(seed.id, seed)
      taskRef.current = seed
      setTask(seed)
      setTitleDraft(savedDraft?.title ?? seed.title)
      setDescriptionDraft(savedDraft?.description ?? seed.description ?? '')
      setStartDraft(localDateTime(seed.start_at))
      setDueDraft(localDateTime(seed.due_at))
      setAllDayDraft(Boolean(seed.is_all_day))
      const manual = seed.manual_progress ?? seed.progress ?? 0
      setProgressDraft(manual)
      setProgressInput(String(manual))
      setProgressMode(seed.progress_mode || 'manual')
      if (savedDraft?.title !== undefined && savedDraft.title !== seed.title) preservedDraftKeysRef.current.add('title')
      if (savedDraft?.description !== undefined && savedDraft.description !== (seed.description || '')) preservedDraftKeysRef.current.add('description')
    } else {
      setTask(null)
      setTitleDraft(savedDraft?.title || '')
      setDescriptionDraft(savedDraft?.description || '')
      setStartDraft('')
      setDueDraft('')
      setAllDayDraft(false)
      setProgressDraft(0)
      setProgressInput('0')
      setProgressMode('manual')
    }
    if (taskId) {
      const canonicalDescription = seed?.description || ''
      const autosaveState = descriptionAutosaveRef.current?.hydrate(taskId, canonicalDescription, savedDraft?.description ?? canonicalDescription, seed ? {
        description: canonicalDescription,
        version: Number(seed.version || 0),
        updated_at: seed.updated_at,
      } : undefined)
      setDescriptionSaveState(autosaveState)
    } else setDescriptionSaveState(undefined)
    setChildren([])
    commentsRef.current = []
    setComments([])
    setCommentsHasMore(false)
    setCommentsLoadingMore(false)
    commentsNextOffsetRef.current = 0
    prependScrollHeightRef.current = null
    setActivity([])
    setAttachments([])
    setPreviewAttachment(null)
    setDependencies([])
    setFeedFilter('all')
    const savedFailure = taskId ? failuresByTaskRef.current.get(taskId) : undefined
    failureRetryRef.current = savedFailure?.retry || null
    setFailure(savedFailure?.failure || null)
    setProgressError('')
    setComment(savedDraft?.comment || '')
    setCommentMentionIds(savedDraft?.commentMentionIds || [])
    setCommentAttachmentIds(savedDraft?.commentAttachmentIds || [])
    setCommentAttachmentLookup(savedDraft?.commentAttachmentLookup || {})
    setEditingCommentId(savedDraft?.editingCommentId || '')
    setEditingCommentBody(savedDraft?.editingCommentBody || '')
    setEditingMentionIds(savedDraft?.editingMentionIds || [])
    setEditingAttachmentIds(savedDraft?.editingAttachmentIds || [])
    const seedStatuses = seed
      ? taskWorkflowStatuses(seed, listsRef.current, workflowsRef.current)
      : workflowsRef.current.find(item => item.is_default)?.statuses || workflowsRef.current[0]?.statuses || []
    setSubtaskDraft(savedDraft?.subtaskDraft ? { ...savedDraft.subtaskDraft } : createTaskQuickSubtaskDraft({ assigned_to: seed?.assigned_to || '' }, seedStatuses))
    dependencySearchAbortRef.current?.abort()
    dependencySearchSequenceRef.current += 1
    setDependencySearch('')
    setDependencySettledSearch('')
    setDependencyTaskId('')
    setNewFeedItems(false)
    feedNearBottomRef.current = true
    feedCountRef.current = 0
    feedContextRef.current = ''
    const parentRestore = taskId && pendingParentRestoreRef.current?.parentTaskId === taskId
    if (!parentRestore) detailsScrollRef.current?.scrollTo({ top: 0 })
    if (taskId) void load()
    else {
      setLoading(false)
      setSectionsLoading(false)
      taskNavigationReturnRef.current = null
      pendingParentRestoreRef.current = null
    }
  }, [load, taskId])

  useEffect(() => () => {
    readSessionRef.current?.controller.abort()
    const autosave = descriptionAutosaveRef.current
    void autosave?.flushAll()
    autosave?.dispose()
  }, [])

  useEffect(() => {
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!descriptionAutosaveRef.current?.hasUnsaved()) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnBeforeUnload)
    return () => window.removeEventListener('beforeunload', warnBeforeUnload)
  }, [])

  useEffect(() => {
    if (subtaskDraftResetTokenRef.current === subtaskDraftResetToken) return
    subtaskDraftResetTokenRef.current = subtaskDraftResetToken
    const currentTask = taskRef.current
    if (!currentTask) return
    const reset = createTaskQuickSubtaskDraft(currentTask, taskWorkflowStatuses(currentTask, listsRef.current, workflowsRef.current))
    subtaskDraftTouchedRef.current = false
    setSubtaskDraft(reset)
    const saved = draftsByTaskRef.current.get(currentTask.id)
    if (saved) draftsByTaskRef.current.set(currentTask.id, { ...saved, subtaskDraft: reset, subtaskDraftTouched: false })
  }, [subtaskDraftResetToken])

  useEffect(() => {
    if (!taskId) return
    const incoming = allTasks.find(item => item.id === taskId)
    if (incoming) applyTask(incoming)
  }, [allTasks, applyTask, taskId])

  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const measure = () => setPanelWidth(panel.getBoundingClientRect().width)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(panel)
    return () => observer.disconnect()
  }, [taskId, detailWindow.effectiveMode])

  useEffect(() => subscribeWebSocket(raw => {
    const envelope = raw as {
      event?: string
      data?: { action?: string; task_id?: string; description?: string; version?: number; updated_at?: string; operation_id?: string; hierarchy_counts?: TaskHierarchyCounts; related_task_ids?: string[]; task?: Task; subtask?: Task; comment_id?: string; comment?: TaskComment; attachment_id?: string }
    }
    if (envelope.event !== 'task_update' && envelope.event !== 'task_overdue') return
    const message = envelope.data || {}
    const currentTaskId = taskIdRef.current
    if (!currentTaskId) return
    const changedTaskId = message.task?.id || message.task_id
    const parentTaskId = message.task?.parent_task_id || message.subtask?.parent_task_id
    const currentParentId = taskRef.current?.parent_task_id
    if (message.action === 'deleted' && (message.task_id === currentTaskId || message.task_id === currentParentId)) {
      if (onDeleted(message.task_id || currentTaskId, message.task?.version || message.version, message.operation_id, message.hierarchy_counts)) onCloseRef.current()
      return
    }
    if (message.action && taskStructureActions.has(message.action)) {
      void refreshTask()
      if (!currentParentId) void refreshChildren()
      return
    }
    if (message.action === 'description_updated' && message.task_id === currentTaskId && typeof message.description === 'string' && Number.isFinite(message.version)) {
      const current = taskSnapshotsRef.current.get(currentTaskId) || taskRef.current
      if (!current || Number(message.version) <= Number(current.version || 0)) return
      const remote: TaskDescriptionConflict = {
        description: message.description,
        version: Number(message.version),
        updated_at: message.updated_at,
      }
      descriptionAutosaveRef.current?.receiveRemote(currentTaskId, remote)
      const canonical = {
        ...current,
        description: remote.description,
        version: remote.version,
        updated_at: remote.updated_at || current.updated_at,
      }
      taskSnapshotsRef.current.set(currentTaskId, canonical)
      taskRef.current = canonical
      setTask(canonical)
      const autosaveState = descriptionAutosaveRef.current?.getState(currentTaskId)
      if (autosaveState && autosaveState.draft === remote.description && autosaveState.phase !== 'conflict') {
        editingDescriptionRef.current = false
        preservedDraftKeysRef.current.delete('description')
        setDescriptionDraft(remote.description)
      }
      window.setTimeout(() => { void refreshActivity() }, 120)
      return
    }
    if (message.task?.id === currentTaskId) applyTask(message.task)
    if (message.action === 'subtasks_updated' && (message.task_id === currentTaskId || message.task_id === currentParentId)) {
      void refreshTask()
      if (message.task_id === currentTaskId) void refreshChildren()
      window.setTimeout(() => { void refreshActivity() }, 120)
      return
    }
    if (parentTaskId === currentTaskId || (message.action?.startsWith('subtask_') && message.task_id === currentTaskId)) {
      void refreshChildren()
      window.setTimeout(() => { void refreshActivity() }, 120)
      return
    }
    if (message.related_task_ids?.includes(currentTaskId)) {
      void refreshDependencies()
      window.setTimeout(() => { void refreshActivity() }, 120)
      return
    }
    if (changedTaskId !== currentTaskId) return
    if (message.action === 'comment_deleted' && message.comment_id) {
      const existed = commentsRef.current.some(item => item.id === message.comment_id)
      if (existed && commentsNextOffsetRef.current > 0) commentsNextOffsetRef.current--
      commentsRef.current = commentsRef.current.filter(item => item.id !== message.comment_id)
      setComments(commentsRef.current)
    } else if (message.action === 'comment_updated' && message.comment) {
      const previous = commentsRef.current.find(item => item.id === message.comment!.id)
      if (previous) {
        commentsRef.current = commentsRef.current.map(item => item.id === message.comment!.id
          ? { ...message.comment!, can_edit: previous.can_edit, can_delete: previous.can_delete }
          : item)
        setComments(commentsRef.current)
      } else void refreshComments()
    } else if (message.action?.startsWith('comment_')) void refreshComments()
    else if (message.action?.includes('attachment')) {
      if (message.action === 'attachment_deleted' && message.attachment_id) {
        removeAttachmentReferences(message.attachment_id)
        setPreviewAttachment(current => current?.id === message.attachment_id ? null : current)
      }
      void refreshAttachments()
    }
    else if (message.action?.includes('dependency')) void refreshDependencies()
    else if (!message.task) void refreshTask()
    window.setTimeout(() => { void refreshActivity() }, 120)
  }), [applyTask, refreshActivity, refreshAttachments, refreshChildren, refreshComments, refreshDependencies, refreshTask, removeAttachmentReferences])

  useEffect(() => {
    if (!taskOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const currentTask = taskRef.current
      const resolution = resolveTaskDetailEscape(Boolean(document.querySelector(TASK_DETAIL_ESCAPE_LAYER_SELECTOR)), currentTask?.parent_task_id)
      if (resolution === 'defer') return
      event.preventDefault()
      if (resolution === 'parent' && currentTask?.parent_task_id) {
        const saved = taskNavigationReturnRef.current
        pendingParentRestoreRef.current = saved?.parentTaskId === currentTask.parent_task_id
          ? saved
          : { parentTaskId: currentTask.parent_task_id, childTaskId: currentTask.id, scrollTop: 0, tab: 'details' }
        onOpenTaskRef.current(currentTask.parent_task_id)
        return
      }
      requestCloseRef.current()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [taskOpen])

  useEffect(() => {
    if (!taskOpen || !detailWindow.isModal) return
    modalPreviousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusPanel = window.requestAnimationFrame(() => panelRef.current?.focus({ preventScroll: true }))
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !panelRef.current) return
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'))
      if (!focusable.length) { event.preventDefault(); panelRef.current.focus(); return }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', trapFocus)
    return () => {
      window.cancelAnimationFrame(focusPanel)
      window.removeEventListener('keydown', trapFocus)
      modalPreviousFocusRef.current?.focus({ preventScroll: true })
      modalPreviousFocusRef.current = null
    }
  }, [detailWindow.isModal, taskOpen])

  useEffect(() => {
    const query = dependencySearch.trim()
    if (dependencyTaskId) {
      setDependencySearching(false)
      return
    }
    if (query.length < 2) {
      setDependencySettledSearch(query)
      setDependencyResults([])
      setDependencySearching(false)
      return
    }
    const timer = window.setTimeout(() => setDependencySettledSearch(query), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [dependencySearch, dependencyTaskId])

  useEffect(() => {
    const query = dependencySettledSearch.trim()
    dependencySearchAbortRef.current?.abort()
    const sequence = ++dependencySearchSequenceRef.current
    if (dependencyTaskId || query.length < 2) {
      setDependencySearching(false)
      return
    }
    const controller = new AbortController()
    dependencySearchAbortRef.current = controller
    setDependencySearching(true)
    void apiGet<{ tasks: Task[] }>(`/api/tasks?search=${encodeURIComponent(query)}&include_subtasks=false`, { signal: controller.signal }).then(response => {
      if (controller.signal.aborted || sequence !== dependencySearchSequenceRef.current || taskIdRef.current !== taskId) return
      setDependencyResults((response.data?.tasks || []).filter(item => item.id !== taskId && !item.parent_task_id))
      setDependencySearching(false)
    })
    return () => controller.abort()
  }, [dependencySettledSearch, dependencyTaskId, taskId])

  const visibleTask = task?.id === taskId ? task : null
  const taskTransitioning = Boolean(task && task.id !== taskId)
  const list = lists.find(item => item.id === visibleTask?.list_id)
  const explicitWorkflowID = visibleTask?.status_detail?.workflow_id
  const workflow = workflows.find(item => item.id === explicitWorkflowID)
    || (!explicitWorkflowID ? workflows.find(item => item.id === list?.workflow_id) || workflows.find(item => item.is_default) || workflows[0] : undefined)
  const statuses = workflow?.statuses?.length ? workflow.statuses : visibleTask?.status_detail ? [visibleTask.status_detail] : []
  const parentTask = visibleTask?.parent_task_id ? allTasks.find(item => item.id === visibleTask.parent_task_id) : undefined
  const isWide = panelWidth >= 980
  const canEdit = canEditTask(visibleTask)
  const canComment = canCommentOnTask(visibleTask)
  const canAdmin = canAdministerTask(visibleTask)

  const localDependencyCandidates = useMemo(() => allTasks.filter(item => item.id !== taskId && !item.parent_task_id).slice(0, 8), [allTasks, taskId])
  const dependencyCandidates = dependencySearch.trim().length >= 2 ? dependencyResults : localDependencyCandidates
  const dependencySearchPending = !dependencyTaskId && dependencySearch.trim().length >= 2 && dependencySearch.trim() !== dependencySettledSearch
  const selectedDependency = [...dependencyResults, ...allTasks].find(item => item.id === dependencyTaskId)
  const taskCompleted = visibleTask?.status_detail?.category === 'done' || visibleTask?.status === 'completed'
  const openChildTask = (childTaskId: string) => {
    const currentTask = taskRef.current
    if (!currentTask) return
    taskNavigationReturnRef.current = {
      parentTaskId: currentTask.id,
      childTaskId,
      scrollTop: detailsScrollRef.current?.scrollTop || 0,
      tab,
    }
    onOpenTask(childTaskId)
  }
  const returnToParent = () => {
    const currentTask = taskRef.current
    if (!currentTask?.parent_task_id) return
    const saved = taskNavigationReturnRef.current
    pendingParentRestoreRef.current = saved?.parentTaskId === currentTask.parent_task_id
      ? saved
      : { parentTaskId: currentTask.parent_task_id, childTaskId: currentTask.id, scrollTop: 0, tab: 'details' }
    onOpenTask(currentTask.parent_task_id)
  }

  const updateTask = useCallback((key: string, body: Record<string, unknown>, confirmGrants = false): Promise<boolean> => {
    const requestedTaskId = taskIdRef.current
    if (!requestedTaskId) return Promise.resolve(false)
    beginPending(key, requestedTaskId)
    if (['title', 'description', 'dates', 'progress'].includes(key)) preservedDraftKeysRef.current.add(key)
    const execute = async () => {
      const current = taskSnapshotsRef.current.get(requestedTaskId)
        || (taskRef.current?.id === requestedTaskId ? taskRef.current : undefined)
        || allTasksRef.current.find(item => item.id === requestedTaskId)
      if (!current) return false
      if (!canEditTask(current)) {
        showFailure('No tienes permiso para modificar esta tarea.', undefined, requestedTaskId)
        return false
      }
      const operationID = crypto.randomUUID()
      const visualUpdate: TaskVisualUpdate = {}
      if (typeof body.status_id === 'string') visualUpdate.status_id = body.status_id
      if (typeof body.priority === 'string' && ['low', 'medium', 'high', 'urgent'].includes(body.priority)) visualUpdate.priority = body.priority as Task['priority']
      const hasVisualUpdate = Boolean(visualUpdate.status_id || visualUpdate.priority)
      if (hasVisualUpdate) {
        const optimistic = projectTaskVisualUpdate(current, visualUpdate, workflows.flatMap(workflow => workflow.statuses || []))
        applyTask(optimistic)
        onChanged(optimistic, operationID)
      }
      const result = await apiPut<TaskMutationResponse>(`/api/tasks/${requestedTaskId}`, { ...body, version: current.version, operation_id: operationID, confirm_grants: confirmGrants })
      if (!result.success || !result.data?.task) {
        if (hasVisualUpdate) {
          applyTask(current)
          onChanged(current, operationID)
        }
        if (result.status === 409 && result.data?.code === 'access_change_confirmation_required') {
          const retryBody = body
          if (taskIdRef.current === requestedTaskId) {
            setParticipantGrantPrompt({
              taskId: requestedTaskId,
              affectedUserIDs: result.data.affected_user_ids || [],
              retry: () => { void updateTaskRef.current(key, retryBody, true) },
            })
          } else showFailure('Este cambio necesita confirmar acceso. Vuelve a la tarea para continuar.', () => onOpenTaskRef.current(requestedTaskId), requestedTaskId)
          return false
        }
        if (result.status === 409 && taskIdRef.current === requestedTaskId) await refreshTask()
        showFailure(result.status === 409 ? 'La tarea cambió en otra sesión. Conservamos tu borrador para que puedas volver a guardarlo.' : result.error || 'No se pudo guardar el cambio', () => {
          if (taskIdRef.current !== requestedTaskId) onOpenTaskRef.current(requestedTaskId)
          window.setTimeout(() => { void updateTaskRef.current(key, body) })
        }, requestedTaskId)
        return false
      }
      clearFailure(requestedTaskId)
      if (taskIdRef.current === requestedTaskId) preservedDraftKeysRef.current.delete(key)
      const savedDraft = draftsByTaskRef.current.get(requestedTaskId)
      if (savedDraft) {
        if (key === 'title') savedDraft.title = result.data.task.title
        if (key === 'description') savedDraft.description = result.data.task.description || ''
        draftsByTaskRef.current.set(requestedTaskId, savedDraft)
      }
      applyTask(result.data.task)
      onChanged(result.data.task, result.data.operation_id || operationID, result.data.hierarchy_counts)
      return true
    }
    const previousQueue = taskWriteQueuesRef.current.get(requestedTaskId) || Promise.resolve()
    const queued = previousQueue.then(execute, execute)
    taskWriteQueuesRef.current.set(requestedTaskId, queued.then(() => undefined, () => undefined))
    return queued.finally(() => endPending(key, requestedTaskId))
  }, [applyTask, beginPending, clearFailure, endPending, onChanged, refreshTask, showFailure, workflows])
  updateTaskRef.current = updateTask

	const changeColor = async (nextColor: string | null) => {
		const current = taskRef.current
		if (!current || !canEditTask(current) || isPending('color')) return
		const requestedTaskId = current.id
		const listColor = lists.find(item => item.id === current.list_id)?.color
		const optimisticColor = resolveTaskIdentityColor(nextColor, listColor)
		const snapshot = current
		beginPending('color', requestedTaskId)
		applyTask({ ...current, color: nextColor || undefined, resolved_color: optimisticColor.color, color_source: optimisticColor.source })
		const operationID = crypto.randomUUID()
		const result = await apiPatch<TaskMutationResponse>(`/api/tasks/${current.id}/appearance`, { color: nextColor, version: current.version, operation_id: operationID })
		endPending('color', requestedTaskId)
		if (!result.success || !result.data?.task) {
			applyTask(snapshot)
			if (result.status === 409 && taskIdRef.current === requestedTaskId) await refreshTask()
			showFailure(result.status === 409 ? 'El color cambió en otra sesión. Cargamos la versión canónica.' : result.error || 'No se pudo cambiar el color; restauramos el anterior.', () => { if (taskIdRef.current !== requestedTaskId) onOpenTaskRef.current(requestedTaskId); else void changeColor(nextColor) }, requestedTaskId)
			return
		}
		clearFailure(requestedTaskId); applyTask(result.data.task); onChanged(result.data.task, result.data.operation_id || operationID, result.data.hierarchy_counts)
	}

  const saveTitle = async () => {
    editingTitleRef.current = false
    if (skipTitleSaveRef.current) {
      skipTitleSaveRef.current = false
      return
    }
    const value = titleDraft.trim()
    if (!task) return
    if (!value) {
      setTitleDraft(task.title)
      showFailure('El título no puede quedar vacío.')
      return
    }
    if (value !== task.title) await updateTask('title', { title: value })
  }
  const saveDescription = async () => {
    const requestedTaskId = taskIdRef.current
    if (!requestedTaskId) return true
    if (descriptionComposingRef.current) return false
    return descriptionAutosaveRef.current?.flush(requestedTaskId) ?? true
  }
  const changeDescription = (value: string) => {
    const requestedTaskId = taskIdRef.current
    editingDescriptionRef.current = true
    preservedDraftKeysRef.current.add('description')
    setDescriptionDraft(value)
    if (requestedTaskId) descriptionAutosaveRef.current?.change(requestedTaskId, value, descriptionComposingRef.current)
  }
  const changeDescriptionComposition = (composing: boolean) => {
    descriptionComposingRef.current = composing
    const requestedTaskId = taskIdRef.current
    if (requestedTaskId) descriptionAutosaveRef.current?.setComposing(requestedTaskId, composing)
  }
  const useRemoteDescription = () => {
    const requestedTaskId = taskIdRef.current
    if (!requestedTaskId) return
    const remote = descriptionAutosaveRef.current?.useRemote(requestedTaskId)
    if (!remote) return
    setDescriptionDraft(remote.description)
    editingDescriptionRef.current = false
    preservedDraftKeysRef.current.delete('description')
    const savedDraft = draftsByTaskRef.current.get(requestedTaskId)
    if (savedDraft) {
      savedDraft.description = remote.description
      draftsByTaskRef.current.set(requestedTaskId, savedDraft)
    }
  }
  const requestClose = useCallback(async () => {
    const requestedTaskId = taskIdRef.current
    if (!requestedTaskId || !descriptionAutosaveRef.current?.hasUnsaved(requestedTaskId)) {
      onClose()
      return true
    }
    if (requestedTaskId) {
      descriptionComposingRef.current = false
      descriptionAutosaveRef.current?.setComposing(requestedTaskId, false)
      const saved = await descriptionAutosaveRef.current?.flush(requestedTaskId)
      if (saved === false) return false
    }
    onClose()
    return true
  }, [onClose])
  requestCloseRef.current = () => { void requestClose() }
  useImperativeHandle(forwardedRef, () => ({ requestClose }), [requestClose])
  const saveDates = async (startValue = startDraft, dueValue = dueDraft, isAllDay = allDayDraft) => {
    editingDatesRef.current = false
    if (!task) return
    if (startValue && dueValue && new Date(dueValue) < new Date(startValue)) {
      showFailure('La entrega no puede ser anterior al inicio.')
      return
    }
    const nextStart = startValue ? new Date(startValue).toISOString() : ''
    const nextDue = dueValue ? new Date(dueValue).toISOString() : ''
    if (nextStart !== (task.start_at || '') || nextDue !== (task.due_at || '') || isAllDay !== Boolean(task.is_all_day)) await updateTask('dates', { start_at: nextStart, due_at: nextDue, is_all_day: isAllDay })
  }
  const saveProgress = async (mode = progressMode, manual = progressDraft) => {
    editingProgressRef.current = false
    if (task && (mode !== (task.progress_mode || 'manual') || manual !== (task.manual_progress ?? task.progress ?? 0))) await updateTask('progress', { progress_mode: mode, manual_progress: manual })
  }
  const commitManualProgress = async () => {
    editingProgressRef.current = false
    const validation = validateManualProgress(progressInput)
    if (!validation.valid) {
      setProgressError(validation.error)
      return
    }
    setProgressError('')
    setProgressDraft(validation.value)
    setProgressInput(String(validation.value))
    await saveProgress('manual', validation.value)
  }
  const changeProgressMode = (mode: 'manual' | 'automatic') => {
    if (mode === progressMode) return
    editingProgressRef.current = false
    setProgressError('')
    setProgressInput(String(progressDraft))
    setProgressMode(mode)
    void saveProgress(mode, progressDraft)
  }

  const setCollaborator = async (userId: string, intendedSelected?: boolean, confirmGrants = false) => {
    const currentTask = taskRef.current
    if (!currentTask || !canEditTask(currentTask) || isPending('collaborators')) return
    const requestedTaskId = currentTask.id
    const ids = currentTask.collaborators?.map(item => item.user_id) || []
    const selected = ids.includes(userId)
    const shouldSelect = intendedSelected ?? !selected
    if (intendedSelected !== undefined && selected === intendedSelected) {
      clearFailure()
      return
    }
    const next = shouldSelect ? [...ids, userId] : ids.filter(id => id !== userId)
    const participant = users.find(user => user.id === userId)
    const optimisticCollaborators = shouldSelect
      ? [...(currentTask.collaborators || []), { user_id: userId, display_name: participant?.display_name || participant?.username || 'Usuario', username: participant?.username || '', created_at: new Date().toISOString() }]
      : (currentTask.collaborators || []).filter(item => item.user_id !== userId)
    beginPending('collaborators', requestedTaskId)
    applyTask({ ...currentTask, collaborators: optimisticCollaborators })
    const operationID = crypto.randomUUID()
    const result = await apiPut<{ task?: Task; collaborators?: Task['collaborators']; version?: number; code?: string; affected_user_ids?: string[] }>(`/api/tasks/${currentTask.id}/collaborators`, {
      user_ids: next,
      version: currentTask.version,
      operation_id: operationID,
      confirm_grants: confirmGrants,
    })
    if (result.success && result.data?.task) {
      const canonical = { ...result.data.task, collaborators: result.data.collaborators ?? [] }
      applyTask(canonical)
      onChanged(canonical)
      clearFailure(requestedTaskId)
    } else if (result.status === 409 && result.data?.code === 'access_change_confirmation_required') {
      applyTask(currentTask)
      if (taskIdRef.current === requestedTaskId) setParticipantGrantPrompt({
          taskId: requestedTaskId,
          affectedUserIDs: result.data.affected_user_ids || [],
          retry: () => { void setCollaborator(userId, shouldSelect, true) },
        })
      else showFailure('Este cambio necesita confirmar acceso. Vuelve a la tarea para continuar.', () => onOpenTaskRef.current(requestedTaskId), requestedTaskId)
    } else if (result.status === 409) {
      if (taskIdRef.current === requestedTaskId) await refreshTask()
      showFailure('La tarea cambió en otra sesión. Ya cargamos la versión reciente; puedes aplicar tu selección nuevamente.', () => { if (taskIdRef.current !== requestedTaskId) onOpenTaskRef.current(requestedTaskId); else void setCollaborator(userId, shouldSelect) }, requestedTaskId)
    } else if (!result.success) {
      applyTask(currentTask)
      showFailure(result.error || 'No se pudieron actualizar los colaboradores', () => { if (taskIdRef.current !== requestedTaskId) onOpenTaskRef.current(requestedTaskId); else void setCollaborator(userId, shouldSelect) }, requestedTaskId)
    }
    endPending('collaborators', requestedTaskId)
  }

  const setCollaboratorSelection = (nextIDs: string[]) => {
    const currentIDs = taskRef.current?.collaborators?.map(item => item.user_id) || []
    const added = nextIDs.find(id => !currentIDs.includes(id))
    if (added) { void setCollaborator(added, true); return }
    const removed = currentIDs.find(id => !nextIDs.includes(id))
    if (removed) void setCollaborator(removed, false)
  }

  const toggleChild = async (child: Task) => {
    const ownerTaskId = taskRef.current?.id
    if (!ownerTaskId || !canEditTask(taskRef.current)) return
    const transition = taskCompletionTransition(child, statuses)
    if (!transition || isPending(`child:${child.id}`)) return
    const operationID = crypto.randomUUID()
    const optimistic = projectTaskVisualUpdate(child, { status_id: transition.target.id }, statuses)
    beginPending(`child:${child.id}`, ownerTaskId)
    if (taskIdRef.current === ownerTaskId) setChildren(current => current.map(item => item.id === child.id ? optimistic : item))
    onChanged(optimistic, operationID)
    const result = await apiPut<TaskMutationResponse>(`/api/tasks/${child.id}`, { status_id: transition.target.id, version: child.version, operation_id: operationID })
    if (result.success && result.data?.task) {
      const canonicalChild = result.data.task
      if (taskIdRef.current === ownerTaskId) setChildren(current => current.map(item => item.id === child.id ? canonicalChild : item))
      onChanged(canonicalChild, result.data.operation_id || operationID, result.data.hierarchy_counts)
    } else if (result.status === 409) {
      if (taskIdRef.current === ownerTaskId) setChildren(current => current.map(item => item.id === child.id ? child : item))
      onChanged(child, operationID)
      if (taskIdRef.current === ownerTaskId) await refreshChildren()
      showFailure('La subtarea cambió en otra sesión. Ya cargamos su versión más reciente; vuelve a intentarlo.', undefined, ownerTaskId)
    } else {
      if (taskIdRef.current === ownerTaskId) setChildren(current => current.map(item => item.id === child.id ? child : item))
      onChanged(child, operationID)
      showFailure(result.error || 'No se pudo actualizar la subtarea', () => onOpenTaskRef.current(ownerTaskId), ownerTaskId)
    }
    endPending(`child:${child.id}`, ownerTaskId)
  }

  const createQuickSubtask = async (draft = subtaskDraft, confirmGrants = false) => {
    const currentTask = taskRef.current
    const title = draft.title.trim()
    if (!currentTask || !canEditTask(currentTask) || !title || isPending('subtask-create')) return
    if (draft.startAt && draft.dueAt && new Date(draft.dueAt) < new Date(draft.startAt)) {
      showFailure('La entrega de la subtarea no puede ser anterior al inicio.')
      return
    }
    const requestedTaskId = currentTask.id
    const operationID = crypto.randomUUID()
    beginPending('subtask-create', requestedTaskId)
    const result = await apiPost<TaskMutationResponse>(`/api/tasks/${currentTask.id}/children`, {
      title,
      assigned_to: draft.assignedTo,
      status_id: draft.statusId,
      priority: draft.priority,
      start_at: draft.startAt ? new Date(draft.startAt).toISOString() : '',
      due_at: draft.dueAt ? new Date(draft.dueAt).toISOString() : '',
      is_all_day: draft.isAllDay,
      operation_id: operationID,
      confirm_grants: confirmGrants,
    })
    if (result.success && result.data?.task) {
      const createdChild = result.data.task
      if (taskIdRef.current === requestedTaskId) {
        setChildren(current => current.some(item => item.id === createdChild.id) ? current : [...current, createdChild])
        subtaskDraftTouchedRef.current = false
        setSubtaskDraft(createTaskQuickSubtaskDraft(currentTask, statuses))
        setTask(current => current ? { ...current, subtask_count: (current.subtask_count || 0) + 1 } : current)
        window.setTimeout(() => { void refreshActivity() }, 120)
      }
      const saved = draftsByTaskRef.current.get(requestedTaskId)
      if (saved) draftsByTaskRef.current.set(requestedTaskId, { ...saved, subtaskDraft: createTaskQuickSubtaskDraft(currentTask, statuses), subtaskDraftTouched: false })
      onChanged(createdChild, result.data.operation_id || operationID, result.data.hierarchy_counts)
    } else if (result.status === 409 && result.data?.code === 'access_change_confirmation_required') {
      if (taskIdRef.current === requestedTaskId) setParticipantGrantPrompt({
        taskId: requestedTaskId,
        affectedUserIDs: result.data.affected_user_ids || [],
        retry: () => { void createQuickSubtask(draft, true) },
      })
      else showFailure('La subtarea requiere confirmar acceso. Vuelve a la tarea para continuar.', () => onOpenTaskRef.current(requestedTaskId), requestedTaskId)
    } else if (!result.success) showFailure(result.error || 'No se pudo crear la subtarea', () => { if (taskIdRef.current !== requestedTaskId) onOpenTaskRef.current(requestedTaskId); else void createQuickSubtask(draft) }, requestedTaskId)
    endPending('subtask-create', requestedTaskId)
  }

  const sendComment = async () => {
    const currentTask = taskRef.current
    if (!currentTask || !canCommentOnTask(currentTask) || !comment.trim() || isPending('comment-create')) return
    const requestedTaskId = currentTask.id
    const submittedAttachmentIds = [...commentAttachmentIds]
    beginPending('comment-create', requestedTaskId)
    const result = await apiPost<{ comment: TaskComment }>(`/api/tasks/${currentTask.id}/comments`, {
      body: comment.trim(),
      mentioned_user_ids: commentMentionIds,
      attachment_ids: commentAttachmentIds,
    })
    if (result.success && result.data?.comment) {
      if (taskIdRef.current === requestedTaskId && !commentsRef.current.some(item => item.id === result.data!.comment.id)) {
        if (commentsNextOffsetRef.current > 0) commentsNextOffsetRef.current++
        commentsRef.current = [...commentsRef.current, result.data.comment]
        setComments(commentsRef.current)
      }
      if (taskIdRef.current === requestedTaskId) {
        setComment('')
        setCommentMentionIds([])
        setCommentAttachmentIds([])
        setCommentAttachmentLookup(current => removeCommentAttachmentDrafts(current, submittedAttachmentIds))
        window.setTimeout(() => { void refreshActivity() }, 120)
      }
      const saved = draftsByTaskRef.current.get(requestedTaskId)
      if (saved) draftsByTaskRef.current.set(requestedTaskId, { ...saved, comment: '', commentMentionIds: [], commentAttachmentIds: [], commentAttachmentLookup: removeCommentAttachmentDrafts(saved.commentAttachmentLookup, submittedAttachmentIds) })
    } else if (!result.success) showFailure(result.error || 'No se pudo publicar el comentario', () => onOpenTaskRef.current(requestedTaskId), requestedTaskId)
    endPending('comment-create', requestedTaskId)
  }

  const saveComment = async (item: TaskComment) => {
    const currentTask = taskRef.current
    const key = `comment-edit:${item.id}`
    if (!currentTask || !canCommentOnTask(currentTask) || !item.can_edit || !editingCommentBody.trim() || isPending(key)) return
    const requestedTaskId = currentTask.id
    beginPending(key, requestedTaskId)
    const result = await apiPut<{ comment: TaskComment }>(`/api/tasks/${currentTask.id}/comments/${item.id}`, {
      body: editingCommentBody.trim(),
      mentioned_user_ids: editingMentionIds,
      attachment_ids: editingAttachmentIds,
    })
    if (result.success && result.data?.comment) {
      const submittedAttachmentIds = [...editingAttachmentIds]
      if (taskIdRef.current === requestedTaskId) {
        commentsRef.current = commentsRef.current.map(commentItem => commentItem.id === item.id ? result.data!.comment : commentItem)
        setComments(commentsRef.current)
        setEditingCommentId('')
        setEditingCommentBody('')
        setEditingMentionIds([])
        setEditingAttachmentIds([])
        setCommentAttachmentLookup(current => removeCommentAttachmentDrafts(current, submittedAttachmentIds))
      }
      const saved = draftsByTaskRef.current.get(requestedTaskId)
      if (saved) draftsByTaskRef.current.set(requestedTaskId, {
        ...saved,
        editingCommentId: '',
        editingCommentBody: '',
        editingMentionIds: [],
        editingAttachmentIds: [],
        commentAttachmentLookup: removeCommentAttachmentDrafts(saved.commentAttachmentLookup, submittedAttachmentIds),
      })
    } else if (!result.success) showFailure(result.error || 'No se pudo editar el comentario', () => onOpenTaskRef.current(requestedTaskId), requestedTaskId)
    endPending(key, requestedTaskId)
  }

  const deleteComment = async (item: TaskComment) => {
    const currentTask = taskRef.current
    const key = `comment-delete:${item.id}`
    if (!currentTask || !canCommentOnTask(currentTask) || !item.can_delete || !window.confirm('¿Eliminar este comentario?') || isPending(key)) return
    const requestedTaskId = currentTask.id
    beginPending(key, requestedTaskId)
    const result = await apiDelete(`/api/tasks/${currentTask.id}/comments/${item.id}`)
    if (taskIdRef.current === currentTask.id && result.success) {
      const existed = commentsRef.current.some(commentItem => commentItem.id === item.id)
      if (existed && commentsNextOffsetRef.current > 0) commentsNextOffsetRef.current--
      commentsRef.current = commentsRef.current.filter(commentItem => commentItem.id !== item.id)
      setComments(commentsRef.current)
    }
    else if (!result.success) showFailure(result.error || 'No se pudo eliminar el comentario', undefined, requestedTaskId)
    endPending(key, requestedTaskId)
  }

  const upload = async (file: File, target: 'task' | 'comment' | 'edit-comment', context: TaskUploadContext) => {
    const currentTask = context.task
    const key = `upload:${target}`
    const allowed = target === 'task' ? canEditTask(currentTask) : canCommentOnTask(currentTask)
    if (!allowed) return
    const requestedTaskId = context.taskId
    beginPending(key, requestedTaskId)
	const form = taskAttachmentUploadForm(file, crypto.randomUUID(), target === 'task' ? 'task' : 'comment')
    const attached = await apiUpload<{ success?: boolean; attachment: TaskAttachment; deduped?: boolean; operation_id?: string }>(taskAttachmentUploadEndpoint(requestedTaskId), form)
    if (attached.success && attached.data?.attachment) {
      const uploaded = attached.data.attachment
      if (target !== 'task') {
        const saved = draftsByTaskRef.current.get(requestedTaskId)
          || (taskIdRef.current === requestedTaskId ? currentDraftRef.current : null)
        if (saved) draftsByTaskRef.current.set(requestedTaskId, {
          ...saved,
          commentAttachmentLookup: mergeCommentAttachmentDrafts(saved.commentAttachmentLookup, [uploaded]),
          commentAttachmentIds: target === 'comment' && !saved.commentAttachmentIds.includes(uploaded.id)
            ? [...saved.commentAttachmentIds, uploaded.id]
            : saved.commentAttachmentIds,
          editingAttachmentIds: target === 'edit-comment' && !saved.editingAttachmentIds.includes(uploaded.id)
            ? [...saved.editingAttachmentIds, uploaded.id]
            : saved.editingAttachmentIds,
        })
      }
      if (taskIdRef.current === requestedTaskId) {
        if (target === 'task') setAttachments(current => current.some(item => item.id === uploaded.id) ? current : [...current, uploaded])
        else setCommentAttachmentLookup(current => mergeCommentAttachmentDrafts(current, [uploaded]))
        if (target === 'comment') setCommentAttachmentIds(current => current.includes(uploaded.id) ? current : [...current, uploaded.id])
        if (target === 'edit-comment') setEditingAttachmentIds(current => current.includes(uploaded.id) ? current : [...current, uploaded.id])
      }
    } else if (!attached.success || !attached.data?.attachment) showFailure(attached.error || 'No se pudo adjuntar el archivo', () => onOpenTaskRef.current(requestedTaskId), requestedTaskId)
    endPending(key, requestedTaskId)
    if (taskIdRef.current === requestedTaskId && loadSequenceRef.current === context.generation) {
      const input = target === 'task' ? fileRef.current : target === 'comment' ? commentFileRef.current : editCommentFileRef.current
      if (input) input.value = ''
    }
  }

  const uploadFiles = async (files: File[], target: 'task' | 'comment' | 'edit-comment' = 'task') => {
    const currentTask = taskRef.current
    const key = `upload:${target}`
    const allowed = target === 'task' ? canEditTask(currentTask) : canCommentOnTask(currentTask)
    if (!currentTask || !allowed || !files.length || isTaskPending(key, currentTask.id)) return
    const context: TaskUploadContext = { task: currentTask, taskId: currentTask.id, generation: loadSequenceRef.current }
    for (const file of files) await upload(file, target, context)
  }

  const pasteTaskImages = (event: ReactClipboardEvent<HTMLElement>) => {
    if (!taskRef.current || taskRef.current.id !== taskIdRef.current || !canEditTask(taskRef.current)) return
    const files = taskImageFilesFromClipboard(event.clipboardData)
    if (!files.length) return
    event.preventDefault()
    void uploadFiles(files)
  }

  const addMention = (userId: string, editing = false) => {
    const user = users.find(item => item.id === userId)
    if (!user) return
    const label = `@${user.display_name || user.username}`
    if (editing) {
      setEditingMentionIds(current => current.includes(userId) ? current : [...current, userId])
      setEditingCommentBody(current => `${current}${current && !current.endsWith(' ') ? ' ' : ''}${label} `)
    } else {
      setCommentMentionIds(current => current.includes(userId) ? current : [...current, userId])
      setComment(current => `${current}${current && !current.endsWith(' ') ? ' ' : ''}${label} `)
    }
  }

  const addDependency = async () => {
    const currentTask = taskRef.current
    if (!currentTask || !canEditTask(currentTask) || !dependencyTaskId || isPending('dependency-create')) return
    const requestedTaskId = currentTask.id
    beginPending('dependency-create', requestedTaskId)
    const result = await apiPost<{ dependency: TaskDependency }>(`/api/tasks/${currentTask.id}/dependencies`, { predecessor_task_id: dependencyTaskId, lag_minutes: 0 })
    if (taskIdRef.current === requestedTaskId && result.success) {
      await refreshDependencies()
      dependencySearchAbortRef.current?.abort()
      dependencySearchSequenceRef.current += 1
      setDependencyTaskId('')
      setDependencySearch('')
      setDependencySettledSearch('')
      setDependencyPickerOpen(false)
      onChanged()
      window.setTimeout(() => { void refreshActivity() }, 120)
    } else if (!result.success) showFailure(result.error || 'No se pudo crear la dependencia', () => onOpenTaskRef.current(requestedTaskId), requestedTaskId)
    endPending('dependency-create', requestedTaskId)
  }

  const removeDependency = async (item: TaskDependency) => {
    const currentTask = taskRef.current
    const key = `dependency-delete:${item.id}`
    if (!currentTask || !canEditTask(currentTask) || isPending(key)) return
    const requestedTaskId = currentTask.id
    beginPending(key, requestedTaskId)
    const result = await apiDelete(`/api/tasks/${currentTask.id}/dependencies/${item.id}`)
    if (result.success && taskIdRef.current === requestedTaskId) setDependencies(current => current.filter(candidate => candidate.id !== item.id))
    else if (!result.success) showFailure(result.error || 'No se pudo eliminar la dependencia', undefined, requestedTaskId)
    endPending(key, requestedTaskId)
  }

  const removeAttachment = async (item: TaskAttachment) => {
    const currentTask = taskRef.current
    const key = `attachment-delete:${item.id}`
    if (!currentTask || !canEditTask(currentTask) || isPending(key)) return
    const requestedTaskId = currentTask.id
    beginPending(key, requestedTaskId)
    const result = await apiDelete(`/api/tasks/${currentTask.id}/attachments/${item.id}`)
    if (result.success && taskIdRef.current === requestedTaskId) {
      setAttachments(current => current.filter(file => file.id !== item.id))
      setPreviewAttachment(current => current?.id === item.id ? null : current)
      removeAttachmentReferences(item.id)
    }
    else if (!result.success) showFailure(result.error || 'No se pudo eliminar el archivo', undefined, requestedTaskId)
    endPending(key, requestedTaskId)
  }

  const removeTask = async () => {
    const requestedTaskId = archiveTaskId
    if (!requestedTaskId || taskIdRef.current !== requestedTaskId) return
    const currentTask = taskSnapshotsRef.current.get(requestedTaskId)
      || (taskRef.current?.id === requestedTaskId ? taskRef.current : null)
    if (!currentTask || !canAdministerTask(currentTask)) return
    setArchiveError('')
    beginPending('archive', requestedTaskId)
    const operationID = crypto.randomUUID()
    const result = await apiDelete<{ task: Task; version: number; operation_id?: string; hierarchy_counts?: TaskHierarchyCounts }>(`/api/tasks/${currentTask.id}`, { version: currentTask.version, operation_id: operationID })
    if (result.success) {
      const archivedVersion = result.data?.task?.version || result.data?.version
      if (taskIdRef.current === requestedTaskId) setArchiveConfirmOpen(false)
      if (onDeleted(currentTask.id, archivedVersion, result.data?.operation_id || operationID, result.data?.hierarchy_counts) && taskIdRef.current === requestedTaskId) onClose()
      else if (taskIdRef.current === requestedTaskId) await refreshTask()
    } else if (taskIdRef.current === requestedTaskId) setArchiveError(result.error || 'No se pudo mover la tarea a Papelera. Reintenta.')
    else showFailure(result.error || 'No se pudo mover la tarea a Papelera.', () => onOpenTaskRef.current(requestedTaskId), requestedTaskId)
    endPending('archive', requestedTaskId)
  }

  const feed = useMemo<FeedItem[]>(() => {
    const commentItems: FeedItem[] = comments.map(item => ({ kind: 'comment', id: `comment:${item.id}`, createdAt: item.created_at, comment: item }))
    const activityItems: FeedItem[] = activity
      .filter(item => item.action !== 'comment_created')
      .map(item => ({ kind: 'activity', id: `activity:${item.id}`, createdAt: item.created_at, activity: item }))
    const items = feedFilter === 'comments' ? commentItems : feedFilter === 'changes' ? activityItems : [...commentItems, ...activityItems]
    return items.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  }, [activity, comments, feedFilter])

  useEffect(() => {
    const element = feedScrollRef.current
    if (!element) return
    const context = `${taskId || ''}:${feedFilter}`
    const contextChanged = feedContextRef.current !== context
    const grew = feed.length > feedCountRef.current
    feedContextRef.current = context
    feedCountRef.current = feed.length
    if (prependScrollHeightRef.current !== null) {
      const previousHeight = prependScrollHeightRef.current
      prependScrollHeightRef.current = null
      const frame = window.requestAnimationFrame(() => {
        element.scrollTop += element.scrollHeight - previousHeight
      })
      return () => window.cancelAnimationFrame(frame)
    }
    if (contextChanged || feedNearBottomRef.current) {
      const frame = window.requestAnimationFrame(() => {
        element.scrollTop = element.scrollHeight
        feedNearBottomRef.current = true
        setNewFeedItems(false)
      })
      return () => window.cancelAnimationFrame(frame)
    }
    if (grew) setNewFeedItems(true)
  }, [feed.length, feedFilter, taskId])

  const renderComment = (item: TaskComment) => {
    const editKey = `comment-edit:${item.id}`
    return <article key={`comment:${item.id}`} className="group flex gap-3 py-2">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-[10px] font-bold text-emerald-700">{initials(item.author_name)}</div>
      <div className="min-w-0 flex-1 rounded-2xl rounded-tl-sm border border-slate-100 bg-white px-3.5 py-3 shadow-sm">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0"><p className="truncate text-xs font-bold text-slate-700">{item.author_name}</p><p className="mt-0.5 text-[10px] text-slate-400">{dateFormatter.format(new Date(item.created_at))}{item.updated_at && item.updated_at !== item.created_at ? ' · editado' : ''}</p></div>
          <div className="flex shrink-0 gap-1 opacity-100 sm:opacity-0 sm:transition sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
            {item.can_edit && <button type="button" aria-label="Editar comentario" onClick={() => { setEditingCommentId(item.id); setEditingCommentBody(item.body); setEditingMentionIds(item.mentions?.map(mention => mention.user_id) || []); setEditingAttachmentIds(item.attachments?.map(file => file.id) || []); setCommentAttachmentLookup(current => mergeCommentAttachmentDrafts(current, item.attachments || [])) }} className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700"><Pencil className="h-3.5 w-3.5" /></button>}
            {item.can_delete && <button type="button" aria-label="Eliminar comentario" onClick={() => void deleteComment(item)} className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 className="h-3.5 w-3.5" /></button>}
          </div>
        </div>
        {editingCommentId === item.id ? <div className="mt-3 space-y-2">
          <textarea autoFocus rows={3} value={editingCommentBody} onChange={event => setEditingCommentBody(event.target.value)} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void saveComment(item) } }} className="w-full resize-none rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-emerald-400 focus:bg-white" />
          <div className="flex flex-wrap gap-1.5">{editingMentionIds.map(id => { const user = users.find(candidate => candidate.id === id); return <button key={id} onClick={() => setEditingMentionIds(current => current.filter(value => value !== id))} className="rounded-full bg-emerald-100 px-2 py-1 text-[10px] font-semibold text-emerald-700">@{user?.display_name || user?.username} ×</button> })}{editingAttachmentIds.map(id => { const file = resolveCommentAttachment(id, commentAttachmentLookup, attachments); return <button key={id} onClick={() => setEditingAttachmentIds(current => current.filter(value => value !== id))} className="rounded-full bg-slate-200 px-2 py-1 text-[10px] font-semibold text-slate-600">{file?.filename || 'Archivo'} ×</button> })}</div>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2"><TaskUserCombobox users={users} value="" onChange={id => addMention(id, true)} excludeIds={editingMentionIds} placeholder="Mencionar a alguien…" /><button onClick={() => editCommentFileRef.current?.click()} className="flex h-11 w-11 items-center justify-center rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50"><Paperclip className="h-4 w-4" /></button><input ref={editCommentFileRef} type="file" className="hidden" onChange={event => void uploadFiles(Array.from(event.target.files || []), 'edit-comment')} /></div>
          <div className="flex justify-end gap-2"><button onClick={() => setEditingCommentId('')} className="min-h-9 rounded-lg px-3 text-xs font-semibold text-slate-500 hover:bg-slate-100">Cancelar</button><button disabled={isPending(editKey) || !editingCommentBody.trim()} onClick={() => void saveComment(item)} className="min-h-9 rounded-lg bg-slate-900 px-3 text-xs font-semibold text-white disabled:opacity-40">{isPending(editKey) ? 'Guardando…' : 'Guardar'}</button></div>
        </div> : <>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-5 text-slate-600">{item.body}</p>
          {item.mentions?.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{item.mentions.map(mention => <span key={mention.user_id} className="rounded-full bg-emerald-100 px-2 py-1 text-[10px] font-semibold text-emerald-700">@{mention.display_name || mention.username}</span>)}</div>}
          {item.attachments?.length > 0 && <div className="mt-2 grid gap-1.5">{item.attachments.map(file => <a key={file.id} href={file.url} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs font-semibold text-slate-600 hover:border-emerald-200"><File className="h-3.5 w-3.5 shrink-0 text-emerald-600" /><span className="truncate">{file.filename}</span><Download className="ml-auto h-3.5 w-3.5 shrink-0 text-slate-400" /></a>)}</div>}
        </>}
      </div>
    </article>
  }

  const activityPane = <div className="flex min-h-0 flex-1 flex-col bg-slate-50/70">
    <div className="border-b border-slate-200 bg-white px-4 py-3">
      <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-bold text-slate-800">Actividad</h3><span className="text-[10px] font-semibold text-slate-400">{comments.length}{commentsHasMore ? '+' : ''} comentarios</span></div>
      <div className="mt-2 flex rounded-xl bg-slate-100 p-1">{([['all', 'Todo'], ['comments', 'Comentarios'], ['changes', 'Cambios']] as [FeedFilter, string][]).map(([key, label]) => <button key={key} onClick={() => setFeedFilter(key)} className={`min-h-8 flex-1 rounded-lg px-2 text-[11px] font-semibold transition ${feedFilter === key ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>{label}</button>)}</div>
    </div>
    <div ref={feedScrollRef} onScroll={event => { const element = event.currentTarget; const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 72; feedNearBottomRef.current = nearBottom; if (nearBottom) setNewFeedItems(false) }} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
      {commentsHasMore && feedFilter !== 'changes' && <div className="flex justify-center py-2"><button type="button" disabled={commentsLoadingMore} onClick={() => { void loadOlderComments() }} className="inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-[11px] font-semibold text-slate-600 shadow-sm hover:border-emerald-200 hover:text-emerald-700 disabled:opacity-50">{commentsLoadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Cargar comentarios anteriores</button></div>}
      {feed.map(item => item.kind === 'comment' ? renderComment(item.comment) : <div key={item.id} className="relative flex gap-3 py-3 before:absolute before:bottom-0 before:left-[15px] before:top-0 before:w-px before:bg-slate-200 first:before:top-1/2 last:before:bottom-1/2"><div className="z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white"><Activity className="h-3.5 w-3.5 text-emerald-600" /></div><div className="min-w-0 pt-0.5"><p className="text-sm leading-5 text-slate-600"><strong className="font-semibold text-slate-800">{item.activity.actor_name || 'Sistema'}</strong> {activityLabels[item.activity.action] || item.activity.action.replaceAll('_', ' ')}</p><p className="mt-0.5 text-[10px] text-slate-400">{dateFormatter.format(new Date(item.activity.created_at))}</p></div></div>)}
      {!feed.length && <div className="flex h-full min-h-40 flex-col items-center justify-center text-center"><MessageSquare className="h-8 w-8 text-slate-300" /><p className="mt-2 text-sm font-medium text-slate-500">Todavía no hay actividad aquí.</p><p className="mt-1 max-w-xs text-xs text-slate-400">{canComment ? 'Escribe el primer comentario para empezar la conversación.' : 'Tu nivel actual permite consultar la actividad.'}</p></div>}
      {newFeedItems && <button type="button" onClick={() => { const element = feedScrollRef.current; if (element) element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' }); feedNearBottomRef.current = true; setNewFeedItems(false) }} className="sticky bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-full bg-slate-900 px-3 py-1.5 text-[10px] font-bold text-white shadow-lg">Nueva actividad ↓</button>}
    </div>
    {canComment ? <div className="shrink-0 border-t border-slate-200 bg-white p-3 sm:p-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm focus-within:border-emerald-300 focus-within:ring-4 focus-within:ring-emerald-50">
        <textarea rows={2} value={comment} onChange={event => setComment(event.target.value)} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void sendComment() } }} placeholder="Escribe un comentario…" className="w-full resize-none bg-transparent px-1 text-sm text-slate-700 outline-none placeholder:text-slate-400" />
        <div className="mt-2 flex flex-wrap gap-1.5">{commentMentionIds.map(id => { const user = users.find(candidate => candidate.id === id); return <button key={id} onClick={() => setCommentMentionIds(current => current.filter(value => value !== id))} className="rounded-full bg-emerald-100 px-2 py-1 text-[10px] font-semibold text-emerald-700">@{user?.display_name || user?.username} ×</button> })}{commentAttachmentIds.map(id => { const file = resolveCommentAttachment(id, commentAttachmentLookup, attachments); return <button key={id} onClick={() => setCommentAttachmentIds(current => current.filter(value => value !== id))} className="rounded-full bg-slate-200 px-2 py-1 text-[10px] font-semibold text-slate-600">{file?.filename || 'Archivo'} ×</button> })}</div>
        <div className="mt-2 flex items-end gap-2"><div className="min-w-0 flex-1"><TaskUserCombobox users={users} value="" onChange={id => addMention(id)} excludeIds={commentMentionIds} placeholder="Mencionar a alguien…" className="py-2" /></div><button title="Adjuntar archivo" onClick={() => commentFileRef.current?.click()} disabled={isPending('upload:comment')} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40">{isPending('upload:comment') ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}</button><input ref={commentFileRef} type="file" className="hidden" onChange={event => void uploadFiles(Array.from(event.target.files || []), 'comment')} /><button title="Publicar comentario (Ctrl/⌘ + Enter)" onClick={() => void sendComment()} disabled={isPending('comment-create') || !comment.trim()} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white transition hover:bg-emerald-700 disabled:opacity-30">{isPending('comment-create') ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}</button></div>
      </div>
      <p className="mt-1.5 hidden text-center text-[10px] text-slate-400 sm:block">Ctrl/⌘ + Enter para publicar</p>
    </div> : <div className="shrink-0 border-t border-slate-200 bg-white px-4 py-3 text-center text-xs font-semibold text-slate-500">Necesitas Comentar para participar en esta conversación.</div>}
  </div>

  const detailsPane = visibleTask && (() => {
    const task = visibleTask
    return <div className="mx-auto w-full max-w-4xl space-y-7 pb-8">
    <section aria-labelledby={`task-properties-${task.id}`}>
      <div className="mb-3 flex items-end justify-between gap-3"><div><h3 id={`task-properties-${task.id}`} className="text-xs font-black uppercase tracking-[0.14em] text-slate-500">Propiedades</h3><p className="mt-1 text-[11px] text-slate-400">Actualiza lo esencial sin salir de la tarea.</p></div>{Object.keys(pending).some(key => key.startsWith(`${task.id}:`) && !key.includes('comment')) && <span className="inline-flex items-center gap-1.5 text-[10px] font-bold text-emerald-600"><Loader2 className="h-3.5 w-3.5 animate-spin" />Guardando</span>}</div>
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_8px_24px_rgba(15,23,42,0.04)]">
        <TaskPropertyRow label="Estado" icon={<Check className="h-3.5 w-3.5" />}>
          <div className="flex items-center gap-2"><div className="min-w-0 flex-1"><TaskStatusPicker value={task.status_id || ''} statuses={statuses} disabled={!canEdit} pending={isPending('status')} onChange={statusID => { void updateTask('status', { status_id: statusID }) }} /></div><TaskCompletionButton task={task} statuses={statuses} disabled={!canEdit} pending={isPending('status')} onChange={statusID => { void updateTask('status', { status_id: statusID }) }} /></div>
        </TaskPropertyRow>
        <TaskPropertyRow label="Responsable" icon={<UserRound className="h-3.5 w-3.5" />}><TaskUserCombobox users={users} value={task.assigned_to} onChange={userId => { void updateTask('owner', { assigned_to: userId }) }} disabled={!canEdit || isPending('owner')} /></TaskPropertyRow>
        <TaskPropertyRow label="Fechas" icon={<CalendarRange className="h-3.5 w-3.5" />}><TaskDateRangePicker label="Fecha de entrega" startValue={startDraft} endValue={dueDraft} allDay={allDayDraft} disabled={!canEdit} pending={isPending('dates')} onApply={range => { setStartDraft(range.startAt); setDueDraft(range.endAt); setAllDayDraft(range.isAllDay); void saveDates(range.startAt, range.endAt, range.isAllDay) }} /></TaskPropertyRow>
        <TaskPropertyRow label="Prioridad" icon={<Flag className="h-3.5 w-3.5" />}><TaskPriorityPicker value={task.priority} disabled={!canEdit} pending={isPending('priority')} onChange={priority => { void updateTask('priority', { priority }) }} /></TaskPropertyRow>
        <TaskPropertyRow label="Progreso" icon={<Activity className="h-3.5 w-3.5" />}><TaskProgressControl id={`task-progress-${task.id}`} mode={progressMode} inputValue={progressInput} canonicalManualValue={progressDraft} effectiveProgress={task.progress || 0} completed={taskCompleted} disabled={!canEdit} pending={isPending('progress')} error={progressError} subtaskDone={task.subtask_done || 0} subtaskCount={task.subtask_count || 0} onModeChange={changeProgressMode} onFocus={() => { editingProgressRef.current = true }} onInputChange={value => { setProgressInput(value); setProgressError('') }} onCommit={() => { void commitManualProgress() }} onReset={() => { editingProgressRef.current = false; const canonical = task.manual_progress ?? task.progress ?? 0; setProgressDraft(canonical); setProgressInput(String(canonical)); setProgressError('') }} /></TaskPropertyRow>
        <TaskPropertyRow label="Lista" icon={<ListTodo className="h-3.5 w-3.5" />}><TaskListPicker value={task.list_id || ''} lists={lists} folders={folders} disabled={!canEdit || Boolean(task.parent_task_id) || isPending('list')} onChange={listID => { void updateTask('list', { list_id: listID }) }} />{task.parent_task_id && <p className="mt-1.5 text-[10px] leading-4 text-slate-400">Las subtareas heredan la lista de su tarea principal y se trasladan junto con ella.</p>}</TaskPropertyRow>
        <TaskPropertyRow label="Color" icon={<Palette className="h-3.5 w-3.5" />}>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]"><button type="button" disabled={!canEdit || isPending('color')} onClick={() => { void changeColor(null) }} className={`flex min-h-11 min-w-0 items-center gap-3 rounded-xl border px-3 text-left outline-none transition focus:ring-4 focus:ring-emerald-100 disabled:opacity-50 ${!task.color ? 'border-emerald-300 bg-emerald-50' : 'border-slate-200 hover:border-slate-300'}`}><span className="h-7 w-7 shrink-0 rounded-lg border-2 border-white shadow" style={{ backgroundColor: resolveTaskIdentityColor(null, list?.color).color }} /><span className="min-w-0 flex-1"><span className="block text-xs font-bold text-slate-700">Heredar de la lista</span><span className="block truncate text-[10px] text-slate-400">{list?.name || 'Color predeterminado'} · {resolveTaskIdentityColor(null, list?.color).color}</span></span>{!task.color && <Check className="h-4 w-4 shrink-0 text-emerald-600" />}</button><TaskColorPicker value={task.resolved_color || resolveTaskIdentityColor(task.color, list?.color).color} disabled={!canEdit || isPending('color')} label="Cambiar color de la tarea" onChange={value => { void changeColor(value) }} /></div>
        </TaskPropertyRow>
      </div>
    </section>

    <TaskDescriptionEditor
      key={task.id}
      value={descriptionDraft}
      onChange={changeDescription}
      onCompositionChange={changeDescriptionComposition}
      storageScope={storageScope}
      panelRef={panelRef}
      pending={isPending('description')}
      disabled={!canEdit}
      onCommit={saveDescription}
      onExpandedChange={expanded => { editingDescriptionRef.current = expanded; setDescriptionExpanded(expanded) }}
      saveState={descriptionSaveState?.taskId === task.id ? descriptionSaveState : undefined}
      onRetry={() => { void descriptionAutosaveRef.current?.retry(task.id) }}
      onKeepLocal={() => { void descriptionAutosaveRef.current?.keepLocal(task.id) }}
      onUseRemote={useRemoteDescription}
      error={failure && <div role="alert" className="mb-3 flex shrink-0 items-start gap-2 rounded-xl border border-rose-100 bg-rose-50 px-3 py-2.5 text-xs text-rose-700"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span className="min-w-0 flex-1 leading-5">{failure.message}</span>{failure.canRetry && <button type="button" onClick={() => { const retry = failureRetryRef.current; clearFailure(); retry?.() }} className="shrink-0 rounded-lg bg-white px-2.5 py-1 font-semibold shadow-sm hover:bg-rose-100">Reintentar</button>}</div>}
    />

    <section>
      <div className="mb-1.5 flex items-center gap-2"><UserRound className="h-4 w-4 text-emerald-600" /><h3 className="text-sm font-bold text-slate-800">Colaboradores</h3>{isPending('collaborators') && <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-600" />}</div>
      <p className="mb-3 text-xs leading-5 text-slate-400">Participan y reciben contexto de la tarea; el responsable continúa siendo su único propietario.</p>
      <TaskCollaboratorPicker users={users} value={task.collaborators?.map(item => item.user_id) || []} ownerID={task.assigned_to} disabled={!canEdit} pending={isPending('collaborators')} onChange={setCollaboratorSelection} />
    </section>

    <TaskAccessPanel task={task} users={users} onChanged={(changed, operationID) => {
      if (changed) {
        applyTask(changed)
        onChanged(changed, operationID)
      } else if (taskIdRef.current === task.id) {
        void refreshTask()
        onChanged(undefined, operationID)
      }
    }} />

    {!task.parent_task_id && <section>
      <div className="mb-3 flex items-center justify-between"><div><h3 className="text-sm font-bold text-slate-800">Subtareas <span className="font-normal text-slate-400">{children.filter(item => item.status_detail?.category === 'done').length}/{children.length}</span></h3><p className="mt-1 text-[11px] text-slate-400">Crea pasos asignables sin perder el contexto.</p></div></div>
      {canEdit && <div className="mb-3"><TaskQuickSubtaskComposer parent={task} value={subtaskDraft} statuses={statuses} users={users} pending={isPending('subtask-create')} onChange={draft => { subtaskDraftTouchedRef.current = true; setSubtaskDraft(draft) }} onSubmit={draft => createQuickSubtask(draft)} onCancel={() => { subtaskDraftTouchedRef.current = false; setSubtaskDraft(createTaskQuickSubtaskDraft(task, statuses)) }} onMoreOptions={draft => onCreateSubtask(task, draft)} /></div>}
      <div className="space-y-2">{children.map(child => <div key={child.id} className="group flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5 transition hover:border-emerald-200 hover:bg-emerald-50/30"><TaskCompletionButton compact task={child} statuses={statuses} disabled={!canEdit} pending={isPending(`child:${child.id}`)} onChange={() => toggleChild(child)} /><button id={`task-child-link-${child.id}`} data-task-child-link={child.id} onClick={() => openChildTask(child.id)} className="min-w-0 flex-1 text-left"><span className={`block truncate text-sm font-medium ${child.status_detail?.category === 'done' ? 'text-slate-400 line-through' : 'text-slate-700'}`}>{child.title}</span><span className="mt-0.5 block truncate text-[10px] text-slate-400">{child.assigned_to_name || 'Sin responsable'} · {child.due_at ? dateFormatter.format(new Date(child.due_at)) : 'Sin fecha'}</span></button><span className="hidden shrink-0 rounded-lg bg-slate-100 px-2 py-1 text-[10px] font-semibold text-slate-500 sm:block">{child.status_detail?.name || 'Por hacer'}</span><ChevronRight className="h-4 w-4 shrink-0 text-slate-300 transition group-hover:translate-x-0.5" /></div>)}{!children.length && <div className="rounded-xl border border-dashed border-slate-300 px-4 py-5 text-center text-sm text-slate-400">Divide el trabajo en pasos pequeños y asignables.</div>}</div>
    </section>}

    <section>
      <div className="mb-3 flex items-center justify-between gap-3"><div><h3 className="flex items-center gap-2 text-sm font-bold text-slate-800"><Paperclip className="h-4 w-4 text-emerald-600" /> Archivos <span className="font-normal text-slate-400">{attachments.length}</span></h3><p className="mt-1 text-[10px] text-slate-400">{canEdit ? 'Adjunta archivos o pega imágenes con Ctrl/⌘ + V.' : 'Puedes consultar y descargar los archivos visibles.'}</p></div>{canEdit && <><button onClick={() => fileRef.current?.click()} disabled={isPending('upload:task')} className="flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-40">{isPending('upload:task') && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Adjuntar</button><input ref={fileRef} type="file" multiple className="hidden" onChange={event => void uploadFiles(Array.from(event.target.files || []))} /></>}</div>
      <div className="grid gap-2 sm:grid-cols-2">{attachments.map(item => <div key={item.id} className="group flex items-center gap-2 rounded-xl border border-slate-200 bg-white p-2.5 transition hover:border-emerald-200 hover:shadow-sm"><button type="button" onClick={() => setPreviewAttachment(item)} className="flex min-w-0 flex-1 items-center gap-2 text-left"><div className="rounded-lg bg-slate-100 p-2 transition group-hover:bg-emerald-50"><File className="h-4 w-4 text-slate-500 group-hover:text-emerald-600" /></div><div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold text-slate-700">{item.filename}</p><p className="text-[10px] text-slate-400">{Math.max(1, Math.round(item.size_bytes / 1024))} KB · {canComment ? 'Ver y comentar' : 'Ver archivo'}</p></div></button><a aria-label={`Descargar ${item.filename}`} href={item.url} target="_blank" rel="noreferrer" className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"><Download className="h-4 w-4" /></a>{canEdit && <button aria-label={`Quitar ${item.filename}`} disabled={isPending(`attachment-delete:${item.id}`)} onClick={() => { void removeAttachment(item) }} className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-600"><X className="h-3.5 w-3.5" /></button>}</div>)}{!attachments.length && <div className="rounded-xl border border-dashed border-slate-300 px-4 py-5 text-center text-sm text-slate-400 sm:col-span-2">{canEdit ? 'Adjunta documentos, imágenes o entregables.' : 'No hay archivos en esta tarea.'}</div>}</div>
    </section>

    <section>
      <h3 className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-800"><Link2 className="h-4 w-4 text-emerald-600" /> Dependencias <span className="font-normal text-slate-400">{dependencies.length}</span></h3>
      <div className="space-y-2">{dependencies.map(dep => { const incoming = dep.successor_task_id === task.id; const linkedTaskId = incoming ? dep.predecessor_task_id : dep.successor_task_id; return <div key={dep.id} className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2"><span className="shrink-0 rounded-lg bg-white px-2 py-1 text-[10px] font-semibold text-slate-500">{incoming ? 'Bloqueada por' : 'Bloquea a'}</span><button onClick={() => onOpenTask(linkedTaskId)} className="min-w-0 flex-1 truncate text-left text-xs font-semibold text-slate-700 hover:text-emerald-700 hover:underline">{incoming ? dep.predecessor_title : dep.successor_title}</button>{canEdit && <button aria-label="Eliminar dependencia" disabled={isPending(`dependency-delete:${dep.id}`)} onClick={() => { void removeDependency(dep) }} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-600"><X className="h-3.5 w-3.5" /></button>}</div> })}
        {canEdit && <div className="relative"><div className="flex gap-2"><div className="relative min-w-0 flex-1"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input value={dependencySearch} onFocus={() => setDependencyPickerOpen(true)} onChange={event => { dependencySearchAbortRef.current?.abort(); dependencySearchSequenceRef.current += 1; setDependencySearching(false); setDependencySearch(event.target.value); if (!event.target.value.trim()) setDependencySettledSearch(''); setDependencyTaskId(''); setDependencyPickerOpen(true) }} onKeyDown={event => { if (event.key === 'Escape' && dependencyPickerOpen) { event.preventDefault(); event.stopPropagation(); setDependencyPickerOpen(false) } }} placeholder="Buscar tarea predecesora…" className={`${inputClass} pl-9 pr-9`} />{(dependencySearchPending || dependencySearching) && <Loader2 aria-label={dependencySearchPending ? 'Esperando para buscar' : 'Buscando dependencias'} className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-emerald-600" />}</div><button onClick={() => { void addDependency() }} disabled={!dependencyTaskId || isPending('dependency-create')} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white disabled:opacity-30">{isPending('dependency-create') ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}</button></div>
          {selectedDependency && <p className="mt-1.5 truncate text-[10px] font-medium text-emerald-700">Seleccionada: {selectedDependency.title}</p>}
          {dependencyPickerOpen && !dependencyTaskId && <div className="mt-2 max-h-48 overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg">{dependencyCandidates.map(candidate => <button key={candidate.id} onClick={() => { dependencySearchAbortRef.current?.abort(); dependencySearchSequenceRef.current += 1; setDependencyTaskId(candidate.id); setDependencySearch(candidate.title); setDependencySettledSearch(candidate.title.trim()); setDependencySearching(false); setDependencyPickerOpen(false) }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-emerald-50"><span className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-700">{candidate.title}</span><span className="shrink-0 text-[10px] text-slate-400">{candidate.breadcrumbs_visible === false ? 'Compartida contigo' : candidate.list_name || 'Bandeja'}</span></button>)}{!dependencyCandidates.length && !dependencySearching && !dependencySearchPending && <p className="px-3 py-5 text-center text-xs text-slate-400">No encontramos tareas disponibles.</p>}</div>}
        </div>}
      </div>
    </section>
    </div>
  })()

  if (!taskId) return null
  const dockedInspector = inFlowDocked && detailWindow.effectiveMode === 'docked' && detailWindow.canDock !== false
  const panel = <aside
    ref={panelRef}
    data-task-detail-window
    data-window-mode={detailWindow.effectiveMode}
    data-backdrop-mode={windowVisual.blocksWorkspace ? 'modal' : detailWindow.effectiveMode}
    onPaste={pasteTaskImages}
    tabIndex={-1}
    role={dockedInspector ? 'complementary' : 'dialog'}
    aria-modal={dockedInspector ? undefined : windowVisual.blocksWorkspace}
    aria-label="Detalle de tarea"
    style={dockedInspector ? { width: detailWindow.dockedWidth } : detailWindow.panelStyle}
    className={`pointer-events-auto flex flex-col overflow-hidden bg-white outline-none ${dockedInspector ? 'relative h-full shrink-0 border-l border-slate-200 shadow-none' : `absolute shadow-[0_32px_90px_rgba(15,23,42,0.32)] ring-1 ring-slate-900/10 ${detailWindow.isMobile ? '' : 'rounded-2xl border border-white/80'}`}`}
  >
        {detailWindow.effectiveMode === 'floating' && (Object.entries(resizeHandles) as [TaskDetailResizeEdge, string][]).map(([edge, classes]) => <div key={edge} className={`absolute z-30 ${classes}`} onPointerDown={event => detailWindow.beginResize(edge, event)} />)}
        {(loading || taskTransitioning) && !visibleTask ? <div className="flex flex-1 flex-col items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-emerald-600" /><p className="mt-3 text-sm text-slate-400">Abriendo tarea…</p></div> : visibleTask ? (() => { const task = visibleTask; return <>
          <header onPointerDown={detailWindow.beginDrag} onDoubleClick={event => { if (!detailWindow.temporaryModeActive && !(event.target as HTMLElement).closest('button,a,input,textarea,select,[data-no-window-drag]')) detailWindow.toggleMaximized() }} className={`shrink-0 select-none border-b border-slate-200 bg-white px-4 py-3 sm:px-6 sm:py-4 ${detailWindow.effectiveMode === 'floating' ? 'cursor-move' : ''}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
				<div className="mb-1.5 flex min-w-0 items-center gap-1.5 overflow-hidden text-[11px] text-slate-400"><span className="h-3.5 w-3.5 shrink-0 rounded-md border-2 border-white shadow-sm" style={{ backgroundColor: task.resolved_color || resolveTaskIdentityColor(task.color, list?.color).color }} aria-label={`Color de identidad ${task.resolved_color || resolveTaskIdentityColor(task.color, list?.color).color}`} />{parentTask && <><button data-no-window-drag onClick={returnToParent} className="max-w-44 truncate font-semibold text-emerald-700 hover:underline">{parentTask.title}</button><ChevronRight className="h-3 w-3 shrink-0" /></>}{task.breadcrumbs_visible === false ? <span className="truncate font-semibold text-violet-600">Compartida contigo</span> : <><span className="truncate">{task.folder_name || 'Clarin Work'}</span><ChevronRight className="h-3 w-3 shrink-0" /><span className="truncate">{task.list_name || 'Bandeja general'}</span></>}{task.is_milestone && <span className="ml-1 flex shrink-0 items-center gap-1 rounded-full bg-violet-50 px-2 py-1 font-medium text-violet-700"><Flag className="h-3 w-3" /> Hito</span>}</div>
                <div data-no-window-drag className="relative"><textarea rows={1} value={titleDraft} disabled={!canEdit || isPending('title')} onFocus={() => { editingTitleRef.current = true }} onChange={event => setTitleDraft(event.target.value.replace(/\n/g, ' '))} onBlur={() => { void saveTitle() }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); skipTitleSaveRef.current = true; setTitleDraft(task.title); event.currentTarget.blur() } }} aria-label="Título de la tarea" className="block min-h-9 w-full resize-none overflow-hidden rounded-lg border border-transparent bg-transparent py-1 pr-8 text-lg font-bold leading-7 text-slate-900 outline-none transition hover:border-slate-200 focus:border-emerald-300 focus:bg-white focus:px-2 focus:ring-4 focus:ring-emerald-50 disabled:opacity-80 sm:text-xl" />{isPending('title') && <Loader2 className="absolute right-2 top-2 h-4 w-4 animate-spin text-emerald-600" />}</div>
              </div>
              <div data-no-window-drag className="flex shrink-0 gap-0.5">
                {!detailWindow.isMobile && detailWindow.temporaryModeActive && <span role="img" aria-label="Vista maximizada temporal por espacio disponible" title="Vista maximizada temporal por espacio disponible" className="flex h-9 w-9 items-center justify-center rounded-xl text-slate-400"><Maximize2 className="h-4 w-4" /></span>}
                {!detailWindow.isMobile && !detailWindow.temporaryModeActive && <><button title="Acoplar a la derecha" onClick={() => detailWindow.setMode('docked')} className={`flex h-9 w-9 items-center justify-center rounded-xl hover:bg-slate-100 ${detailWindow.effectiveMode === 'docked' ? 'text-emerald-600' : 'text-slate-400'}`}><PanelRight className="h-4 w-4" /></button><button title="Ventana flotante" onClick={() => detailWindow.setMode('floating')} className={`flex h-9 w-9 items-center justify-center rounded-xl hover:bg-slate-100 ${detailWindow.effectiveMode === 'floating' ? 'text-emerald-600' : 'text-slate-400'}`}><Move className="h-4 w-4" /></button></>}
                {!detailWindow.isMobile && detailWindow.effectiveMode === 'floating' && <button title="Restablecer tamaño" aria-label="Restablecer tamaño" onClick={detailWindow.resetGeometry} className="flex h-9 w-9 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 hover:text-slate-700"><RotateCcw className="h-4 w-4" /></button>}
                {!detailWindow.isMobile && !detailWindow.temporaryModeActive && <button title={detailWindow.effectiveMode === 'maximized' ? 'Restaurar ventana' : 'Maximizar'} onClick={detailWindow.toggleMaximized} className="flex h-9 w-9 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 hover:text-slate-700">{detailWindow.effectiveMode === 'maximized' ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}</button>}
                {canEdit && <button title="Editar todas las propiedades" aria-label="Editar todas las propiedades" onClick={() => onEdit(task)} className="flex h-9 w-9 items-center justify-center rounded-xl text-slate-400 outline-none hover:bg-slate-100 hover:text-slate-700 focus:ring-2 focus:ring-emerald-400 focus:ring-offset-2"><Pencil className="h-4 w-4" /></button>}
                {!task.parent_task_id && canAdmin && <button title="Mover a otro Entorno" onClick={() => setMoveEnvironmentOpen(true)} className="flex h-9 w-9 items-center justify-center rounded-xl text-slate-400 hover:bg-violet-50 hover:text-violet-700"><ArrowRightLeft className="h-4 w-4" /></button>}
                {canAdmin && <button title="Mover a Papelera" disabled={isPending('archive')} onClick={() => { setArchiveTaskId(task.id); setArchiveError(''); setArchiveConfirmOpen(true) }} className="flex h-9 w-9 items-center justify-center rounded-xl text-slate-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40"><Trash2 className="h-4 w-4" /></button>}
                <button title="Cerrar" onClick={() => requestCloseRef.current()} className="flex h-9 w-9 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 hover:text-slate-700"><X className="h-5 w-5" /></button>
              </div>
            </div>
            {!isWide && <nav data-no-window-drag className="mt-3 flex rounded-xl bg-slate-100 p-1">{([['details', 'Detalles'], ['activity', `Actividad${comments.length ? ` · ${comments.length}${commentsHasMore ? '+' : ''}` : ''}`]] as [DetailTab, string][]).map(([key, label]) => <button key={key} onClick={() => setTab(key)} className={`min-h-9 flex-1 rounded-lg px-3 text-xs font-semibold transition ${tab === key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>{label}</button>)}</nav>}
          </header>

          {!canEdit && !descriptionExpanded && <div role="status" className="mx-4 mt-3 rounded-xl border border-violet-100 bg-violet-50 px-3 py-2.5 text-xs font-semibold text-violet-700 sm:mx-6">Acceso {canComment ? 'Comentar' : 'Ver'} · puedes consultar esta tarea{canComment ? ' y participar en la conversación' : ''}.</div>}
          {failure && !descriptionExpanded && <div className="mx-4 mt-3 flex shrink-0 items-start gap-2 rounded-xl border border-rose-100 bg-rose-50 px-3 py-2.5 text-xs text-rose-700 sm:mx-6"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span className="min-w-0 flex-1 leading-5">{failure.message}</span>{failure.canRetry && <button onClick={() => { const retry = failureRetryRef.current; clearFailure(); retry?.() }} className="shrink-0 rounded-lg bg-white px-2.5 py-1 font-semibold shadow-sm hover:bg-rose-100">Reintentar</button>}<button aria-label="Cerrar aviso" onClick={() => clearFailure()} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg hover:bg-rose-100"><X className="h-3.5 w-3.5" /></button></div>}
          {sectionsLoading && !descriptionExpanded && <div role="status" className="mx-4 mt-2 flex shrink-0 items-center gap-2 text-[11px] font-medium text-slate-400 sm:mx-6"><Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-600" />Actualizando comentarios, actividad y archivos…</div>}

          {isWide ? <div className="flex min-h-0 flex-1"><main ref={detailsScrollRef} className="min-w-0 flex-1 overflow-y-auto overscroll-contain px-6 py-6 lg:px-8">{detailsPane}</main><section className="flex w-[390px] min-h-0 shrink-0 flex-col border-l border-slate-200">{activityPane}</section></div> : tab === 'details' ? <main ref={detailsScrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6">{detailsPane}</main> : activityPane}
        </> })() : <div className="flex flex-1 flex-col items-center justify-center px-6 text-center"><AlertCircle className="h-8 w-8 text-rose-300" /><p className="mt-3 text-sm font-semibold text-slate-700">No pudimos abrir esta tarea.</p><button onClick={() => { void load() }} className="mt-3 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white">Reintentar</button></div>}
      </aside>
  const auxiliaryLayers = <>
      {canAdmin && visibleTask && <TaskDestructiveConfirmDialog open={archiveConfirmOpen && archiveTaskId === taskId} title="Mover tarea a Papelera" description={`${visibleTask.subtask_count ? `También se moverán ${visibleTask.subtask_count} subtarea${visibleTask.subtask_count === 1 ? '' : 's'}. ` : ''}La tarea podrá restaurarse durante el plazo configurado. Completar una tarea nunca la envía aquí.`} actionLabel="Mover a Papelera" busy={isPending('archive')} error={archiveError} onClose={() => { if (!isPending('archive')) { setArchiveConfirmOpen(false); setArchiveTaskId(''); setArchiveError('') } }} onConfirm={() => { void removeTask() }} />}
      {visibleTask && canAdmin && <TaskMoveEnvironmentDialog key={visibleTask.id} open={moveEnvironmentOpen && visibleTask.id === taskId} task={visibleTask} onClose={() => setMoveEnvironmentOpen(false)} onMoved={(moved, operationID) => { applyTask(moved); onChanged(moved, operationID); if (taskIdRef.current === moved.id) { setMoveEnvironmentOpen(false); onClose() } }} />}
      {previewAttachment && visibleTask && previewAttachment.task_id === taskId && <TaskAttachmentViewer key={`${visibleTask.id}:${previewAttachment.id}`} taskId={visibleTask.id} attachment={previewAttachment} users={users} canComment={canComment} historicalReadOnly={historicalReadOnly} onClose={() => setPreviewAttachment(null)} />}
      <TaskParticipantGrantConfirmDialog
        open={Boolean(participantGrantPrompt && participantGrantPrompt.taskId === taskId)}
        affectedUserIDs={participantGrantPrompt?.affectedUserIDs || []}
        users={users}
        busy={false}
        onClose={() => setParticipantGrantPrompt(null)}
        onConfirm={() => { const prompt = participantGrantPrompt; setParticipantGrantPrompt(null); if (prompt?.taskId === taskIdRef.current) prompt.retry() }}
      />
    </>
  if (dockedInspector) return <>{panel}{auxiliaryLayers}</>
  if (typeof document === 'undefined') return null
  return createPortal(
    <div
      data-task-detail-overlay
      data-window-mode={detailWindow.effectiveMode}
      data-backdrop-mode={windowVisual.blocksWorkspace ? 'modal' : detailWindow.effectiveMode}
      style={{ ...windowVisual.backdropStyle, zIndex: TASK_OVERLAY_LAYERS.window }}
      className={`fixed inset-0 transition-[background-color,backdrop-filter] duration-200 ${windowVisual.blocksWorkspace ? '' : 'pointer-events-none'}`}
      onMouseDown={event => { if (windowVisual.blocksWorkspace && event.target === event.currentTarget) requestCloseRef.current() }}
    >
      {panel}
      {auxiliaryLayers}
    </div>,
    document.body,
  )
})

export default TaskDetailDrawer
