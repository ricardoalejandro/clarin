'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Activity,
  AlertCircle,
  Calendar,
  Check,
  ChevronRight,
  Download,
  File,
  Flag,
  Link2,
  Loader2,
  Maximize2,
  MessageSquare,
  Minimize2,
  Move,
  PanelRight,
  Paperclip,
  Pencil,
  Plus,
  Search,
  Send,
  Trash2,
  UserRound,
  X,
} from 'lucide-react'
import { apiDelete, apiGet, apiPost, apiPut, apiUpload, subscribeWebSocket } from '@/lib/api'
import {
  Task,
  TaskActivity,
  TaskAttachment,
  TaskComment,
  TaskDependency,
  TaskList,
  TaskWorkflow,
} from '@/types/task'
import { TaskAccountUser } from './TaskEditorModal'
import TaskCollaboratorPicker from './TaskCollaboratorPicker'
import { TaskPriorityPicker, TaskStatusPicker } from './TaskPropertyPicker'
import TaskUserCombobox from './TaskUserCombobox'
import useTaskDetailWindow, { type TaskDetailResizeEdge } from './useTaskDetailWindow'

interface Props {
  taskId: string | null
  allTasks: Task[]
  users: TaskAccountUser[]
  lists: TaskList[]
  workflows: TaskWorkflow[]
  onClose: () => void
  onEdit: (task: Task) => void
  onOpenTask: (taskId: string) => void
  onCreateSubtask: (task: Task) => void
  onChanged: (task?: Task) => void
  onDeleted: (taskId: string, version?: number) => boolean
}

type DetailTab = 'details' | 'activity'
type FeedFilter = 'all' | 'comments' | 'changes'
type PendingOperations = Record<string, number>
type Failure = { message: string; canRetry: boolean }
type TaskCommentPage = { comments: TaskComment[]; has_more: boolean; next_offset: number }
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
  dependency_added: 'añadió una dependencia',
  dependency_deleted: 'quitó una dependencia',
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

export default function TaskDetailDrawer({ taskId, allTasks, users, lists, workflows, onClose, onEdit, onOpenTask, onCreateSubtask, onChanged, onDeleted }: Props) {
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
  const [pending, setPending] = useState<PendingOperations>({})
  const [failure, setFailure] = useState<Failure | null>(null)
  const [panelWidth, setPanelWidth] = useState(0)

  const [titleDraft, setTitleDraft] = useState('')
  const [descriptionDraft, setDescriptionDraft] = useState('')
  const [startDraft, setStartDraft] = useState('')
  const [dueDraft, setDueDraft] = useState('')
  const [progressDraft, setProgressDraft] = useState(0)
  const [subtaskTitle, setSubtaskTitle] = useState('')

  const [comment, setComment] = useState('')
  const [commentMentionIds, setCommentMentionIds] = useState<string[]>([])
  const [commentAttachmentIds, setCommentAttachmentIds] = useState<string[]>([])
  const [editingCommentId, setEditingCommentId] = useState('')
  const [editingCommentBody, setEditingCommentBody] = useState('')
  const [editingMentionIds, setEditingMentionIds] = useState<string[]>([])
  const [editingAttachmentIds, setEditingAttachmentIds] = useState<string[]>([])

  const [dependencyTaskId, setDependencyTaskId] = useState('')
  const [dependencySearch, setDependencySearch] = useState('')
  const [dependencyResults, setDependencyResults] = useState<Task[]>([])
  const [dependencySearching, setDependencySearching] = useState(false)
  const [dependencyPickerOpen, setDependencyPickerOpen] = useState(false)
  const [newFeedItems, setNewFeedItems] = useState(false)

  const panelRef = useRef<HTMLElement>(null)
  const feedScrollRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const commentFileRef = useRef<HTMLInputElement>(null)
  const editCommentFileRef = useRef<HTMLInputElement>(null)
  const taskIdRef = useRef(taskId)
  const taskRef = useRef<Task | null>(null)
  const loadSequenceRef = useRef(0)
  const dependencySearchSequenceRef = useRef(0)
  const taskWriteQueueRef = useRef<Promise<void>>(Promise.resolve())
  const preservedDraftKeysRef = useRef(new Set<string>())
  const draftBodiesRef = useRef<Record<string, Record<string, unknown>>>({})
  const failureRetryRef = useRef<(() => void) | null>(null)
  const feedNearBottomRef = useRef(true)
  const feedCountRef = useRef(0)
  const feedContextRef = useRef('')
  const modalPreviousFocusRef = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)
  const commentsNextOffsetRef = useRef(0)
  const commentsRef = useRef<TaskComment[]>([])
  const prependScrollHeightRef = useRef<number | null>(null)
  const editingTitleRef = useRef(false)
  const skipTitleSaveRef = useRef(false)
  const editingDescriptionRef = useRef(false)
  const editingDatesRef = useRef(false)
  const editingProgressRef = useRef(false)
  const updateTaskRef = useRef<(key: string, body: Record<string, unknown>) => Promise<boolean>>(async () => false)
  const detailWindow = useTaskDetailWindow()
  const taskOpen = Boolean(taskId)
  onCloseRef.current = onClose
  commentsRef.current = comments

  draftBodiesRef.current = {
    title: { title: titleDraft.trim() },
    description: { description: descriptionDraft },
    dates: {
      start_at: startDraft ? new Date(startDraft).toISOString() : '',
      due_at: dueDraft ? new Date(dueDraft).toISOString() : '',
    },
    progress: { progress: progressDraft },
  }

  const beginPending = useCallback((key: string) => {
    setPending(current => ({ ...current, [key]: (current[key] || 0) + 1 }))
  }, [])
  const endPending = useCallback((key: string) => {
    setPending(current => {
      const next = { ...current }
      const count = (next[key] || 1) - 1
      if (count > 0) next[key] = count
      else delete next[key]
      return next
    })
  }, [])
  const isPending = useCallback((key: string) => Boolean(pending[key]), [pending])
  const showFailure = useCallback((message: string, retry?: () => void) => {
    failureRetryRef.current = retry || null
    setFailure({ message, canRetry: Boolean(retry) })
  }, [])
  const clearFailure = useCallback(() => {
    failureRetryRef.current = null
    setFailure(null)
  }, [])

  const applyTask = useCallback((incoming: Task, forceDrafts = false) => {
    if (taskIdRef.current !== incoming.id) return
    const current = taskRef.current
    if (current?.id === incoming.id && Number(incoming.version || 0) < Number(current.version || 0)) return
    const next = incoming.collaborators === undefined && current?.collaborators !== undefined
      ? { ...incoming, collaborators: current.collaborators }
      : incoming
    taskRef.current = next
    setTask(next)
    if (forceDrafts || (!editingTitleRef.current && !preservedDraftKeysRef.current.has('title'))) setTitleDraft(next.title)
    if (forceDrafts || (!editingDescriptionRef.current && !preservedDraftKeysRef.current.has('description'))) setDescriptionDraft(next.description || '')
    if (forceDrafts || (!editingDatesRef.current && !preservedDraftKeysRef.current.has('dates'))) {
      setStartDraft(localDateTime(next.start_at))
      setDueDraft(localDateTime(next.due_at))
    }
    if (forceDrafts || (!editingProgressRef.current && !preservedDraftKeysRef.current.has('progress'))) setProgressDraft(next.progress || 0)
  }, [])

  const refreshTask = useCallback(async () => {
    const requestedTaskId = taskIdRef.current
    if (!requestedTaskId) return
    const response = await apiGet<{ task: Task }>(`/api/tasks/${requestedTaskId}`)
    if (taskIdRef.current !== requestedTaskId) return
    if (response.success && response.data?.task) applyTask(response.data.task)
    else showFailure(response.error || 'No se pudo actualizar la tarea', () => { void refreshTask() })
  }, [applyTask, showFailure])

  const refreshChildren = useCallback(async () => {
    const requestedTaskId = taskIdRef.current
    if (!requestedTaskId) return
    const response = await apiGet<{ tasks: Task[] }>(`/api/tasks/${requestedTaskId}/children`)
    if (taskIdRef.current === requestedTaskId && response.success) setChildren(response.data?.tasks || [])
  }, [])
  const refreshComments = useCallback(async () => {
    const requestedTaskId = taskIdRef.current
    if (!requestedTaskId) return
    const response = await apiGet<TaskCommentPage>(`/api/tasks/${requestedTaskId}/comments?limit=100&offset=0`)
    if (taskIdRef.current !== requestedTaskId || !response.success) return
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
  }, [])
  const loadOlderComments = useCallback(async () => {
    const requestedTaskId = taskIdRef.current
    if (!requestedTaskId || commentsLoadingMore || !commentsHasMore) return
    const offset = commentsNextOffsetRef.current
    setCommentsLoadingMore(true)
    prependScrollHeightRef.current = feedScrollRef.current?.scrollHeight ?? null
    const response = await apiGet<TaskCommentPage>(`/api/tasks/${requestedTaskId}/comments?limit=100&offset=${offset}`)
    if (taskIdRef.current !== requestedTaskId) return
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
  }, [commentsHasMore, commentsLoadingMore, showFailure])
  const refreshActivity = useCallback(async () => {
    const requestedTaskId = taskIdRef.current
    if (!requestedTaskId) return
    const response = await apiGet<{ activity: TaskActivity[] }>(`/api/tasks/${requestedTaskId}/activity`)
    if (taskIdRef.current === requestedTaskId && response.success) setActivity(response.data?.activity || [])
  }, [])
  const refreshAttachments = useCallback(async () => {
    const requestedTaskId = taskIdRef.current
    if (!requestedTaskId) return
    const response = await apiGet<{ attachments: TaskAttachment[] }>(`/api/tasks/${requestedTaskId}/attachments`)
    if (taskIdRef.current === requestedTaskId && response.success) setAttachments(response.data?.attachments || [])
  }, [])
  const refreshDependencies = useCallback(async () => {
    const requestedTaskId = taskIdRef.current
    if (!requestedTaskId) return
    const response = await apiGet<{ dependencies: TaskDependency[] }>(`/api/tasks/${requestedTaskId}/dependencies`)
    if (taskIdRef.current === requestedTaskId && response.success) setDependencies(response.data?.dependencies || [])
  }, [])

  const removeAttachmentReferences = useCallback((attachmentId: string) => {
    const next = commentsRef.current.map(item => {
      const nextAttachments = item.attachments.filter(file => file.id !== attachmentId)
      return nextAttachments.length === item.attachments.length ? item : { ...item, attachments: nextAttachments }
    })
    commentsRef.current = next
    setComments(next)
    setCommentAttachmentIds(current => current.filter(id => id !== attachmentId))
    setEditingAttachmentIds(current => current.filter(id => id !== attachmentId))
  }, [])

  const load = useCallback(async () => {
    const requestedTaskId = taskIdRef.current
    if (!requestedTaskId) return
    const sequence = ++loadSequenceRef.current
    setLoading(true)
    const [taskRes, childRes, commentRes, activityRes, attachmentRes, dependencyRes] = await Promise.all([
      apiGet<{ task: Task }>(`/api/tasks/${requestedTaskId}`),
      apiGet<{ tasks: Task[] }>(`/api/tasks/${requestedTaskId}/children`),
      apiGet<TaskCommentPage>(`/api/tasks/${requestedTaskId}/comments?limit=100&offset=0`),
      apiGet<{ activity: TaskActivity[] }>(`/api/tasks/${requestedTaskId}/activity`),
      apiGet<{ attachments: TaskAttachment[] }>(`/api/tasks/${requestedTaskId}/attachments`),
      apiGet<{ dependencies: TaskDependency[] }>(`/api/tasks/${requestedTaskId}/dependencies`),
    ])
    if (loadSequenceRef.current !== sequence || taskIdRef.current !== requestedTaskId) return
    if (!taskRes.success || !taskRes.data?.task) {
      setLoading(false)
      showFailure(taskRes.error || 'No se pudo abrir la tarea', () => { void load() })
      return
    }
    applyTask(taskRes.data.task, true)
    setChildren(childRes.data?.tasks || [])
    commentsRef.current = commentRes.data?.comments || []
    setComments(commentsRef.current)
    commentsNextOffsetRef.current = commentRes.data?.next_offset || commentRes.data?.comments?.length || 0
    setCommentsHasMore(Boolean(commentRes.data?.has_more))
    setActivity(activityRes.data?.activity || [])
    setAttachments(attachmentRes.data?.attachments || [])
    setDependencies(dependencyRes.data?.dependencies || [])
    if (![childRes, commentRes, activityRes, attachmentRes, dependencyRes].every(result => result.success)) {
      showFailure('Algunos datos de la tarea no se pudieron cargar.', () => { void load() })
    }
    setLoading(false)
  }, [applyTask, showFailure])

  useEffect(() => {
    taskIdRef.current = taskId
    taskRef.current = null
    editingTitleRef.current = false
    skipTitleSaveRef.current = false
    editingDescriptionRef.current = false
    editingDatesRef.current = false
    editingProgressRef.current = false
    taskWriteQueueRef.current = Promise.resolve()
    preservedDraftKeysRef.current.clear()
    setTask(null)
    setChildren([])
    commentsRef.current = []
    setComments([])
    setCommentsHasMore(false)
    setCommentsLoadingMore(false)
    commentsNextOffsetRef.current = 0
    prependScrollHeightRef.current = null
    setActivity([])
    setAttachments([])
    setDependencies([])
    setTab('details')
    setFeedFilter('all')
    setPending({})
    clearFailure()
    setComment('')
    setCommentMentionIds([])
    setCommentAttachmentIds([])
    setEditingCommentId('')
    setSubtaskTitle('')
    setDependencySearch('')
    setDependencyTaskId('')
    setNewFeedItems(false)
    feedNearBottomRef.current = true
    feedCountRef.current = 0
    feedContextRef.current = ''
    if (taskId) void load()
  }, [clearFailure, load, taskId])

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
      data?: { action?: string; task_id?: string; version?: number; related_task_ids?: string[]; task?: Task; subtask?: Task; comment_id?: string; comment?: TaskComment; attachment_id?: string }
    }
    if (envelope.event !== 'task_update' && envelope.event !== 'task_overdue') return
    const message = envelope.data || {}
    const currentTaskId = taskIdRef.current
    if (!currentTaskId) return
    const changedTaskId = message.task?.id || message.task_id
    const parentTaskId = message.task?.parent_task_id || message.subtask?.parent_task_id
    const currentParentId = taskRef.current?.parent_task_id
    if (message.action === 'deleted' && (message.task_id === currentTaskId || message.task_id === currentParentId)) {
      if (onDeleted(message.task_id || currentTaskId, message.task?.version || message.version)) onCloseRef.current()
      return
    }
    if (message.action && taskStructureActions.has(message.action)) {
      void refreshTask()
      if (!currentParentId) void refreshChildren()
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
      if (message.action === 'attachment_deleted' && message.attachment_id) removeAttachmentReferences(message.attachment_id)
      void refreshAttachments()
    }
    else if (message.action?.includes('dependency')) void refreshDependencies()
    else if (!message.task) void refreshTask()
    window.setTimeout(() => { void refreshActivity() }, 120)
  }), [applyTask, refreshActivity, refreshAttachments, refreshChildren, refreshComments, refreshDependencies, refreshTask, removeAttachmentReferences])

  useEffect(() => {
    if (!taskOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('[data-task-editor-modal],[data-task-structure-modal]')) return
      event.preventDefault()
      onCloseRef.current()
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
    if (query.length < 2) {
      setDependencyResults([])
      setDependencySearching(false)
      return
    }
    const sequence = ++dependencySearchSequenceRef.current
    const timer = window.setTimeout(async () => {
      setDependencySearching(true)
      const response = await apiGet<{ tasks: Task[] }>(`/api/tasks?search=${encodeURIComponent(query)}&include_subtasks=false`)
      if (sequence !== dependencySearchSequenceRef.current || taskIdRef.current !== taskId) return
      setDependencyResults((response.data?.tasks || []).filter(item => item.id !== taskId && !item.parent_task_id))
      setDependencySearching(false)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [dependencySearch, taskId])

  const list = lists.find(item => item.id === task?.list_id)
  const workflow = workflows.find(item => item.id === list?.workflow_id) || workflows.find(item => item.is_default) || workflows[0]
  const statuses = workflow?.statuses || []
  const parentTask = task?.parent_task_id ? allTasks.find(item => item.id === task.parent_task_id) : undefined
  const isWide = panelWidth >= 980

  const localDependencyCandidates = useMemo(() => allTasks.filter(item => item.id !== taskId && !item.parent_task_id).slice(0, 8), [allTasks, taskId])
  const dependencyCandidates = dependencySearch.trim().length >= 2 ? dependencyResults : localDependencyCandidates
  const selectedDependency = [...dependencyResults, ...allTasks].find(item => item.id === dependencyTaskId)

  const updateTask = useCallback((key: string, body: Record<string, unknown>): Promise<boolean> => {
    const requestedTaskId = taskIdRef.current
    if (!requestedTaskId) return Promise.resolve(false)
    beginPending(key)
    if (['title', 'description', 'dates', 'progress'].includes(key)) preservedDraftKeysRef.current.add(key)
    const execute = async () => {
      const current = taskRef.current
      if (!current || current.id !== requestedTaskId || taskIdRef.current !== requestedTaskId) return false
      const result = await apiPut<{ task: Task }>(`/api/tasks/${requestedTaskId}`, { ...body, version: current.version })
      if (taskIdRef.current !== requestedTaskId) return false
      if (!result.success || !result.data?.task) {
        if (result.status === 409) await refreshTask()
        showFailure(result.status === 409 ? 'La tarea cambió en otra sesión. Conservamos tu borrador para que puedas volver a guardarlo.' : result.error || 'No se pudo guardar el cambio', () => { void updateTaskRef.current(key, draftBodiesRef.current[key] || body) })
        return false
      }
      clearFailure()
      preservedDraftKeysRef.current.delete(key)
      applyTask(result.data.task)
      onChanged(result.data.task)
      return true
    }
    const queued = taskWriteQueueRef.current.then(execute, execute)
    taskWriteQueueRef.current = queued.then(() => undefined, () => undefined)
    return queued.finally(() => endPending(key))
  }, [applyTask, beginPending, clearFailure, endPending, onChanged, refreshTask, showFailure])
  updateTaskRef.current = updateTask

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
    editingDescriptionRef.current = false
    if (task && descriptionDraft !== (task.description || '')) await updateTask('description', { description: descriptionDraft })
  }
  const saveDates = async () => {
    editingDatesRef.current = false
    if (!task) return
    if (startDraft && dueDraft && new Date(dueDraft) < new Date(startDraft)) {
      showFailure('La entrega no puede ser anterior al inicio.')
      return
    }
    const nextStart = startDraft ? new Date(startDraft).toISOString() : ''
    const nextDue = dueDraft ? new Date(dueDraft).toISOString() : ''
    if (nextStart !== (task.start_at || '') || nextDue !== (task.due_at || '')) await updateTask('dates', { start_at: nextStart, due_at: nextDue })
  }
  const saveProgress = async () => {
    editingProgressRef.current = false
    if (task && progressDraft !== (task.progress || 0)) await updateTask('progress', { progress: progressDraft })
  }

  const setCollaborator = async (userId: string, intendedSelected?: boolean) => {
    const currentTask = taskRef.current
    if (!currentTask || isPending('collaborators')) return
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
    beginPending('collaborators')
    applyTask({ ...currentTask, collaborators: optimisticCollaborators })
    const result = await apiPut<{ task: Task; collaborators: Task['collaborators']; version: number }>(`/api/tasks/${currentTask.id}/collaborators`, {
      user_ids: next,
      version: currentTask.version,
    })
    if (taskIdRef.current === currentTask.id && result.success && result.data?.task) {
      const canonical = { ...result.data.task, collaborators: result.data.collaborators ?? [] }
      applyTask(canonical)
      onChanged(canonical)
      clearFailure()
    } else if (result.status === 409) {
      await refreshTask()
      showFailure('La tarea cambió en otra sesión. Ya cargamos la versión reciente; puedes aplicar tu selección nuevamente.', () => { void setCollaborator(userId, shouldSelect) })
    } else if (!result.success) {
      if (taskIdRef.current === currentTask.id) applyTask(currentTask)
      showFailure(result.error || 'No se pudieron actualizar los colaboradores', () => { void setCollaborator(userId, shouldSelect) })
    }
    endPending('collaborators')
  }

  const setCollaboratorSelection = (nextIDs: string[]) => {
    const currentIDs = taskRef.current?.collaborators?.map(item => item.user_id) || []
    const added = nextIDs.find(id => !currentIDs.includes(id))
    if (added) { void setCollaborator(added, true); return }
    const removed = currentIDs.find(id => !nextIDs.includes(id))
    if (removed) void setCollaborator(removed, false)
  }

  const toggleChild = async (child: Task) => {
    const done = child.status_detail?.category === 'done'
    const status = statuses.find(item => item.category === (done ? 'not_started' : 'done'))
    if (!status || isPending(`child:${child.id}`)) return
    beginPending(`child:${child.id}`)
    const result = await apiPut<{ task: Task }>(`/api/tasks/${child.id}`, { status_id: status.id, version: child.version })
    if (result.success && result.data?.task) {
      setChildren(current => current.map(item => item.id === child.id ? result.data!.task : item))
      onChanged()
    } else if (result.status === 409) {
      await refreshChildren()
      showFailure('La subtarea cambió en otra sesión. Ya cargamos su versión más reciente; vuelve a intentarlo.')
    } else showFailure(result.error || 'No se pudo actualizar la subtarea', () => { void toggleChild(child) })
    endPending(`child:${child.id}`)
  }

  const createQuickSubtask = async () => {
    const currentTask = taskRef.current
    const title = subtaskTitle.trim()
    if (!currentTask || !title || isPending('subtask-create')) return
    beginPending('subtask-create')
    const result = await apiPost<{ task: Task }>(`/api/tasks/${currentTask.id}/children`, { title })
    if (taskIdRef.current === currentTask.id && result.success && result.data?.task) {
      setChildren(current => current.some(item => item.id === result.data!.task.id) ? current : [...current, result.data!.task])
      setSubtaskTitle('')
      setTask(current => current ? { ...current, subtask_count: (current.subtask_count || 0) + 1 } : current)
      onChanged()
      window.setTimeout(() => { void refreshActivity() }, 120)
    } else if (!result.success) showFailure(result.error || 'No se pudo crear la subtarea', () => { void createQuickSubtask() })
    endPending('subtask-create')
  }

  const sendComment = async () => {
    const currentTask = taskRef.current
    if (!currentTask || !comment.trim() || isPending('comment-create')) return
    beginPending('comment-create')
    const result = await apiPost<{ comment: TaskComment }>(`/api/tasks/${currentTask.id}/comments`, {
      body: comment.trim(),
      mentioned_user_ids: commentMentionIds,
      attachment_ids: commentAttachmentIds,
    })
    if (taskIdRef.current === currentTask.id && result.success && result.data?.comment) {
      if (!commentsRef.current.some(item => item.id === result.data!.comment.id)) {
        if (commentsNextOffsetRef.current > 0) commentsNextOffsetRef.current++
        commentsRef.current = [...commentsRef.current, result.data.comment]
        setComments(commentsRef.current)
      }
      setComment('')
      setCommentMentionIds([])
      setCommentAttachmentIds([])
      window.setTimeout(() => { void refreshActivity() }, 120)
    } else if (!result.success) showFailure(result.error || 'No se pudo publicar el comentario', () => { void sendComment() })
    endPending('comment-create')
  }

  const saveComment = async (item: TaskComment) => {
    const currentTask = taskRef.current
    const key = `comment-edit:${item.id}`
    if (!currentTask || !editingCommentBody.trim() || isPending(key)) return
    beginPending(key)
    const result = await apiPut<{ comment: TaskComment }>(`/api/tasks/${currentTask.id}/comments/${item.id}`, {
      body: editingCommentBody.trim(),
      mentioned_user_ids: editingMentionIds,
      attachment_ids: editingAttachmentIds,
    })
    if (taskIdRef.current === currentTask.id && result.success && result.data?.comment) {
      commentsRef.current = commentsRef.current.map(commentItem => commentItem.id === item.id ? result.data!.comment : commentItem)
      setComments(commentsRef.current)
      setEditingCommentId('')
    } else if (!result.success) showFailure(result.error || 'No se pudo editar el comentario', () => { void saveComment(item) })
    endPending(key)
  }

  const deleteComment = async (item: TaskComment) => {
    const currentTask = taskRef.current
    const key = `comment-delete:${item.id}`
    if (!currentTask || !window.confirm('¿Eliminar este comentario?') || isPending(key)) return
    beginPending(key)
    const result = await apiDelete(`/api/tasks/${currentTask.id}/comments/${item.id}`)
    if (taskIdRef.current === currentTask.id && result.success) {
      const existed = commentsRef.current.some(commentItem => commentItem.id === item.id)
      if (existed && commentsNextOffsetRef.current > 0) commentsNextOffsetRef.current--
      commentsRef.current = commentsRef.current.filter(commentItem => commentItem.id !== item.id)
      setComments(commentsRef.current)
    }
    else if (!result.success) showFailure(result.error || 'No se pudo eliminar el comentario')
    endPending(key)
  }

  const upload = async (file?: File, target: 'task' | 'comment' | 'edit-comment' = 'task') => {
    const currentTask = taskRef.current
    const key = `upload:${target}`
    if (!currentTask || !file || isPending(key)) return
    beginPending(key)
    const form = new FormData()
    form.append('file', file)
    form.append('folder', 'tasks/attachments')
    const uploaded = await apiUpload<{ media_asset_id: string }>('/api/media/upload', form)
    if (uploaded.success && uploaded.data?.media_asset_id) {
      const attached = await apiPost<{ attachment: TaskAttachment }>(`/api/tasks/${currentTask.id}/attachments`, { media_asset_id: uploaded.data.media_asset_id })
      if (taskIdRef.current === currentTask.id && attached.success && attached.data?.attachment) {
        setAttachments(current => current.some(item => item.id === attached.data!.attachment.id) ? current : [...current, attached.data!.attachment])
        if (target === 'comment') setCommentAttachmentIds(current => current.includes(attached.data!.attachment.id) ? current : [...current, attached.data!.attachment.id])
        if (target === 'edit-comment') setEditingAttachmentIds(current => current.includes(attached.data!.attachment.id) ? current : [...current, attached.data!.attachment.id])
      } else if (!attached.success) showFailure(attached.error || 'No se pudo adjuntar el archivo', () => { void upload(file, target) })
    } else showFailure(uploaded.error || 'No se pudo cargar el archivo', () => { void upload(file, target) })
    endPending(key)
    if (fileRef.current) fileRef.current.value = ''
    if (commentFileRef.current) commentFileRef.current.value = ''
    if (editCommentFileRef.current) editCommentFileRef.current.value = ''
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
    if (!currentTask || !dependencyTaskId || isPending('dependency-create')) return
    beginPending('dependency-create')
    const result = await apiPost<{ dependency: TaskDependency }>(`/api/tasks/${currentTask.id}/dependencies`, { predecessor_task_id: dependencyTaskId, lag_minutes: 0 })
    if (taskIdRef.current === currentTask.id && result.success) {
      await refreshDependencies()
      setDependencyTaskId('')
      setDependencySearch('')
      setDependencyPickerOpen(false)
      onChanged()
      window.setTimeout(() => { void refreshActivity() }, 120)
    } else if (!result.success) showFailure(result.error || 'No se pudo crear la dependencia', () => { void addDependency() })
    endPending('dependency-create')
  }

  const removeDependency = async (item: TaskDependency) => {
    const currentTask = taskRef.current
    const key = `dependency-delete:${item.id}`
    if (!currentTask || isPending(key)) return
    beginPending(key)
    const result = await apiDelete(`/api/tasks/${currentTask.id}/dependencies/${item.id}`)
    if (result.success) setDependencies(current => current.filter(candidate => candidate.id !== item.id))
    else showFailure(result.error || 'No se pudo eliminar la dependencia')
    endPending(key)
  }

  const removeAttachment = async (item: TaskAttachment) => {
    const currentTask = taskRef.current
    const key = `attachment-delete:${item.id}`
    if (!currentTask || isPending(key)) return
    beginPending(key)
    const result = await apiDelete(`/api/tasks/${currentTask.id}/attachments/${item.id}`)
    if (result.success) {
      setAttachments(current => current.filter(file => file.id !== item.id))
      removeAttachmentReferences(item.id)
    }
    else showFailure(result.error || 'No se pudo eliminar el archivo')
    endPending(key)
  }

  const removeTask = async () => {
    const currentTask = taskRef.current
    if (!currentTask || !window.confirm('¿Archivar esta tarea y sus subtareas? Podrás restaurarla desde la Papelera.')) return
    beginPending('archive')
    const result = await apiDelete<{ task: Task; version: number }>(`/api/tasks/${currentTask.id}`)
    if (result.success) {
      const archivedVersion = result.data?.task?.version || result.data?.version
      if (onDeleted(currentTask.id, archivedVersion)) onClose()
      else await refreshTask()
    } else showFailure(result.error || 'No se pudo archivar la tarea', () => { void removeTask() })
    endPending('archive')
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
            {item.can_edit && <button type="button" aria-label="Editar comentario" onClick={() => { setEditingCommentId(item.id); setEditingCommentBody(item.body); setEditingMentionIds(item.mentions?.map(mention => mention.user_id) || []); setEditingAttachmentIds(item.attachments?.map(file => file.id) || []) }} className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700"><Pencil className="h-3.5 w-3.5" /></button>}
            {item.can_delete && <button type="button" aria-label="Eliminar comentario" onClick={() => void deleteComment(item)} className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 className="h-3.5 w-3.5" /></button>}
          </div>
        </div>
        {editingCommentId === item.id ? <div className="mt-3 space-y-2">
          <textarea autoFocus rows={3} value={editingCommentBody} onChange={event => setEditingCommentBody(event.target.value)} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void saveComment(item) } }} className="w-full resize-none rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-emerald-400 focus:bg-white" />
          <div className="flex flex-wrap gap-1.5">{editingMentionIds.map(id => { const user = users.find(candidate => candidate.id === id); return <button key={id} onClick={() => setEditingMentionIds(current => current.filter(value => value !== id))} className="rounded-full bg-emerald-100 px-2 py-1 text-[10px] font-semibold text-emerald-700">@{user?.display_name || user?.username} ×</button> })}{editingAttachmentIds.map(id => { const file = attachments.find(candidate => candidate.id === id); return <button key={id} onClick={() => setEditingAttachmentIds(current => current.filter(value => value !== id))} className="rounded-full bg-slate-200 px-2 py-1 text-[10px] font-semibold text-slate-600">{file?.filename || 'Archivo'} ×</button> })}</div>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2"><TaskUserCombobox users={users} value="" onChange={id => addMention(id, true)} excludeIds={editingMentionIds} placeholder="Mencionar a alguien…" /><button onClick={() => editCommentFileRef.current?.click()} className="flex h-11 w-11 items-center justify-center rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50"><Paperclip className="h-4 w-4" /></button><input ref={editCommentFileRef} type="file" className="hidden" onChange={event => void upload(event.target.files?.[0], 'edit-comment')} /></div>
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
      {!feed.length && <div className="flex h-full min-h-40 flex-col items-center justify-center text-center"><MessageSquare className="h-8 w-8 text-slate-300" /><p className="mt-2 text-sm font-medium text-slate-500">Todavía no hay actividad aquí.</p><p className="mt-1 max-w-xs text-xs text-slate-400">Escribe el primer comentario para empezar la conversación.</p></div>}
      {newFeedItems && <button type="button" onClick={() => { const element = feedScrollRef.current; if (element) element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' }); feedNearBottomRef.current = true; setNewFeedItems(false) }} className="sticky bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-full bg-slate-900 px-3 py-1.5 text-[10px] font-bold text-white shadow-lg">Nueva actividad ↓</button>}
    </div>
    <div className="shrink-0 border-t border-slate-200 bg-white p-3 sm:p-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm focus-within:border-emerald-300 focus-within:ring-4 focus-within:ring-emerald-50">
        <textarea rows={2} value={comment} onChange={event => setComment(event.target.value)} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void sendComment() } }} placeholder="Escribe un comentario…" className="w-full resize-none bg-transparent px-1 text-sm text-slate-700 outline-none placeholder:text-slate-400" />
        <div className="mt-2 flex flex-wrap gap-1.5">{commentMentionIds.map(id => { const user = users.find(candidate => candidate.id === id); return <button key={id} onClick={() => setCommentMentionIds(current => current.filter(value => value !== id))} className="rounded-full bg-emerald-100 px-2 py-1 text-[10px] font-semibold text-emerald-700">@{user?.display_name || user?.username} ×</button> })}{commentAttachmentIds.map(id => { const file = attachments.find(candidate => candidate.id === id); return <button key={id} onClick={() => setCommentAttachmentIds(current => current.filter(value => value !== id))} className="rounded-full bg-slate-200 px-2 py-1 text-[10px] font-semibold text-slate-600">{file?.filename || 'Archivo'} ×</button> })}</div>
        <div className="mt-2 flex items-end gap-2"><div className="min-w-0 flex-1"><TaskUserCombobox users={users} value="" onChange={id => addMention(id)} excludeIds={commentMentionIds} placeholder="Mencionar a alguien…" className="py-2" /></div><button title="Adjuntar archivo" onClick={() => commentFileRef.current?.click()} disabled={isPending('upload:comment')} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40">{isPending('upload:comment') ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}</button><input ref={commentFileRef} type="file" className="hidden" onChange={event => void upload(event.target.files?.[0], 'comment')} /><button title="Publicar comentario (Ctrl/⌘ + Enter)" onClick={() => void sendComment()} disabled={isPending('comment-create') || !comment.trim()} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white transition hover:bg-emerald-700 disabled:opacity-30">{isPending('comment-create') ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}</button></div>
      </div>
      <p className="mt-1.5 hidden text-center text-[10px] text-slate-400 sm:block">Ctrl/⌘ + Enter para publicar</p>
    </div>
  </div>

  const detailsPane = task && <div className="mx-auto w-full max-w-4xl space-y-7 pb-8">
    <section>
      <div className="mb-2 flex items-center justify-between gap-3"><h3 className="text-xs font-bold uppercase tracking-[0.14em] text-slate-400">Descripción</h3>{isPending('description') && <span className="flex items-center gap-1 text-[10px] font-medium text-emerald-600"><Loader2 className="h-3 w-3 animate-spin" /> Guardando</span>}</div>
      <textarea value={descriptionDraft} onFocus={() => { editingDescriptionRef.current = true }} onChange={event => setDescriptionDraft(event.target.value)} onBlur={() => { void saveDescription() }} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } }} rows={4} placeholder="Añade contexto, criterios de éxito o instrucciones…" className="min-h-28 w-full resize-y rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-700 outline-none transition focus:border-emerald-300 focus:bg-white focus:ring-4 focus:ring-emerald-50" />
    </section>

    <section>
      <div className="mb-3 flex items-center justify-between"><h3 className="text-xs font-bold uppercase tracking-[0.14em] text-slate-400">Propiedades</h3><button onClick={() => onEdit(task)} className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-50">Más opciones</button></div>
      <div className="grid gap-x-5 gap-y-4 rounded-2xl border border-slate-200 bg-white p-4 sm:grid-cols-2">
        <div className="text-xs font-semibold text-slate-500">Estado<div className="mt-1.5"><TaskStatusPicker value={task.status_id || ''} statuses={statuses} pending={isPending('status')} onChange={statusID => { void updateTask('status', { status_id: statusID }) }} /></div></div>
        <div className="text-xs font-semibold text-slate-500">Responsable<div className="mt-1.5"><TaskUserCombobox users={users} value={task.assigned_to} onChange={userId => { void updateTask('owner', { assigned_to: userId }) }} disabled={isPending('owner')} /></div></div>
        <div className="text-xs font-semibold text-slate-500">Prioridad<div className="mt-1.5"><TaskPriorityPicker value={task.priority} pending={isPending('priority')} onChange={priority => { void updateTask('priority', { priority }) }} /></div></div>
        <div className="text-xs font-semibold text-slate-500">Lista<div className="mt-1.5 flex min-h-11 items-center rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm font-medium text-slate-600">{task.list_name || list?.name || 'Bandeja general'}</div></div>
        <label className="text-xs font-semibold text-slate-500"><span className="flex items-center gap-1.5"><Calendar className="h-3.5 w-3.5" /> Inicio</span><input type="datetime-local" value={startDraft} disabled={isPending('dates')} onFocus={() => { editingDatesRef.current = true }} onChange={event => setStartDraft(event.target.value)} onBlur={() => { void saveDates() }} className={`${inputClass} mt-1.5`} /></label>
        <label className="text-xs font-semibold text-slate-500"><span className="flex items-center gap-1.5"><Calendar className="h-3.5 w-3.5" /> Entrega</span><input type="datetime-local" value={dueDraft} disabled={isPending('dates')} onFocus={() => { editingDatesRef.current = true }} onChange={event => setDueDraft(event.target.value)} onBlur={() => { void saveDates() }} className={`${inputClass} mt-1.5`} /></label>
        <label className="text-xs font-semibold text-slate-500 sm:col-span-2"><span className="flex items-center justify-between"><span>Progreso</span><span className="text-emerald-700">{progressDraft}%</span></span><input type="range" min="0" max="100" step="5" value={progressDraft} disabled={isPending('progress') || task.status_detail?.category === 'done'} onFocus={() => { editingProgressRef.current = true }} onChange={event => setProgressDraft(Number(event.target.value))} onPointerUp={() => { void saveProgress() }} onKeyUp={() => { void saveProgress() }} className="mt-2 w-full accent-emerald-600 disabled:opacity-50" /></label>
      </div>
    </section>

    <section>
      <div className="mb-1.5 flex items-center gap-2"><UserRound className="h-4 w-4 text-emerald-600" /><h3 className="text-sm font-bold text-slate-800">Colaboradores</h3>{isPending('collaborators') && <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-600" />}</div>
      <p className="mb-3 text-xs leading-5 text-slate-400">Participan y reciben contexto de la tarea; el responsable continúa siendo su único propietario.</p>
      <TaskCollaboratorPicker users={users} value={task.collaborators?.map(item => item.user_id) || []} ownerID={task.assigned_to} pending={isPending('collaborators')} onChange={setCollaboratorSelection} />
    </section>

    {!task.parent_task_id && <section>
      <div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-bold text-slate-800">Subtareas <span className="font-normal text-slate-400">{children.filter(item => item.status_detail?.category === 'done').length}/{children.length}</span></h3><button onClick={() => onCreateSubtask(task)} className="flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-50"><Plus className="h-3.5 w-3.5" /> Más opciones</button></div>
      <div className="mb-2 flex gap-2"><input value={subtaskTitle} disabled={isPending('subtask-create')} onChange={event => setSubtaskTitle(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void createQuickSubtask() } if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setSubtaskTitle('') } }} placeholder="Añadir una subtarea y presionar Enter…" className={`${inputClass} min-w-0 flex-1`} /><button disabled={!subtaskTitle.trim() || isPending('subtask-create')} onClick={() => { void createQuickSubtask() }} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white disabled:opacity-30">{isPending('subtask-create') ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}</button></div>
      <div className="space-y-2">{children.map(child => <div key={child.id} className="group flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5 transition hover:border-emerald-200 hover:bg-emerald-50/30"><button title={child.status_detail?.category === 'done' ? 'Marcar pendiente' : 'Completar'} disabled={isPending(`child:${child.id}`)} onClick={() => { void toggleChild(child) }} className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${child.status_detail?.category === 'done' ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-slate-300 bg-white hover:border-emerald-400'}`}>{isPending(`child:${child.id}`) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : child.status_detail?.category === 'done' && <Check className="h-3.5 w-3.5" />}</button><button onClick={() => onOpenTask(child.id)} className="min-w-0 flex-1 text-left"><span className={`block truncate text-sm font-medium ${child.status_detail?.category === 'done' ? 'text-slate-400 line-through' : 'text-slate-700'}`}>{child.title}</span><span className="mt-0.5 block truncate text-[10px] text-slate-400">{child.assigned_to_name || 'Sin responsable'} · {child.due_at ? dateFormatter.format(new Date(child.due_at)) : 'Sin fecha'}</span></button><span className="hidden shrink-0 rounded-lg bg-slate-100 px-2 py-1 text-[10px] font-semibold text-slate-500 sm:block">{child.status_detail?.name || 'Por hacer'}</span><ChevronRight className="h-4 w-4 shrink-0 text-slate-300 transition group-hover:translate-x-0.5" /></div>)}{!children.length && <div className="rounded-xl border border-dashed border-slate-300 px-4 py-5 text-center text-sm text-slate-400">Divide el trabajo en pasos pequeños y asignables.</div>}</div>
    </section>}

    <section>
      <div className="mb-3 flex items-center justify-between"><h3 className="flex items-center gap-2 text-sm font-bold text-slate-800"><Paperclip className="h-4 w-4 text-emerald-600" /> Archivos <span className="font-normal text-slate-400">{attachments.length}</span></h3><button onClick={() => fileRef.current?.click()} disabled={isPending('upload:task')} className="flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-40">{isPending('upload:task') && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Adjuntar</button><input ref={fileRef} type="file" className="hidden" onChange={event => void upload(event.target.files?.[0])} /></div>
      <div className="grid gap-2 sm:grid-cols-2">{attachments.map(item => <div key={item.id} className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white p-2.5"><div className="rounded-lg bg-slate-100 p-2"><File className="h-4 w-4 text-slate-500" /></div><div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold text-slate-700">{item.filename}</p><p className="text-[10px] text-slate-400">{Math.max(1, Math.round(item.size_bytes / 1024))} KB</p></div><a aria-label={`Abrir ${item.filename}`} href={item.url} target="_blank" rel="noreferrer" className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"><Download className="h-4 w-4" /></a><button aria-label={`Quitar ${item.filename}`} disabled={isPending(`attachment-delete:${item.id}`)} onClick={() => { void removeAttachment(item) }} className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-600"><X className="h-3.5 w-3.5" /></button></div>)}{!attachments.length && <div className="rounded-xl border border-dashed border-slate-300 px-4 py-5 text-center text-sm text-slate-400 sm:col-span-2">Adjunta documentos, imágenes o entregables.</div>}</div>
    </section>

    <section>
      <h3 className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-800"><Link2 className="h-4 w-4 text-emerald-600" /> Dependencias <span className="font-normal text-slate-400">{dependencies.length}</span></h3>
      <div className="space-y-2">{dependencies.map(dep => { const incoming = dep.successor_task_id === task.id; const linkedTaskId = incoming ? dep.predecessor_task_id : dep.successor_task_id; return <div key={dep.id} className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2"><span className="shrink-0 rounded-lg bg-white px-2 py-1 text-[10px] font-semibold text-slate-500">{incoming ? 'Bloqueada por' : 'Bloquea a'}</span><button onClick={() => onOpenTask(linkedTaskId)} className="min-w-0 flex-1 truncate text-left text-xs font-semibold text-slate-700 hover:text-emerald-700 hover:underline">{incoming ? dep.predecessor_title : dep.successor_title}</button><button aria-label="Eliminar dependencia" disabled={isPending(`dependency-delete:${dep.id}`)} onClick={() => { void removeDependency(dep) }} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-600"><X className="h-3.5 w-3.5" /></button></div> })}
        <div className="relative"><div className="flex gap-2"><div className="relative min-w-0 flex-1"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input value={dependencySearch} onFocus={() => setDependencyPickerOpen(true)} onChange={event => { setDependencySearch(event.target.value); setDependencyTaskId(''); setDependencyPickerOpen(true) }} placeholder="Buscar tarea predecesora…" className={`${inputClass} pl-9 pr-9`} />{dependencySearching && <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-emerald-600" />}</div><button onClick={() => { void addDependency() }} disabled={!dependencyTaskId || isPending('dependency-create')} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white disabled:opacity-30">{isPending('dependency-create') ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}</button></div>
          {selectedDependency && <p className="mt-1.5 truncate text-[10px] font-medium text-emerald-700">Seleccionada: {selectedDependency.title}</p>}
          {dependencyPickerOpen && !dependencyTaskId && <div className="mt-2 max-h-48 overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg">{dependencyCandidates.map(candidate => <button key={candidate.id} onClick={() => { setDependencyTaskId(candidate.id); setDependencySearch(candidate.title); setDependencyPickerOpen(false) }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-emerald-50"><span className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-700">{candidate.title}</span><span className="shrink-0 text-[10px] text-slate-400">{candidate.list_name || 'Bandeja'}</span></button>)}{!dependencyCandidates.length && !dependencySearching && <p className="px-3 py-5 text-center text-xs text-slate-400">No encontramos tareas disponibles.</p>}</div>}
        </div>
      </div>
    </section>
  </div>

  if (!taskId || typeof document === 'undefined') return null
  return createPortal(
    <div className={`fixed inset-0 z-[70] ${detailWindow.isModal ? 'bg-slate-950/30 backdrop-blur-[1px]' : 'pointer-events-none'}`} onMouseDown={event => { if (detailWindow.isModal && event.target === event.currentTarget) onClose() }}>
      <aside ref={panelRef} tabIndex={-1} role="dialog" aria-modal={detailWindow.isModal} aria-label="Detalle de tarea" style={detailWindow.panelStyle} className={`pointer-events-auto absolute flex flex-col overflow-hidden bg-white shadow-2xl outline-none ${detailWindow.effectiveMode === 'docked' ? 'border-l border-slate-200' : detailWindow.isMobile ? '' : 'rounded-2xl border border-slate-200'}`}>
        {detailWindow.effectiveMode === 'floating' && (Object.entries(resizeHandles) as [TaskDetailResizeEdge, string][]).map(([edge, classes]) => <div key={edge} className={`absolute z-30 ${classes}`} onPointerDown={event => detailWindow.beginResize(edge, event)} />)}
        {loading && !task ? <div className="flex flex-1 flex-col items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-emerald-600" /><p className="mt-3 text-sm text-slate-400">Abriendo tarea…</p></div> : task ? <>
          <header onPointerDown={detailWindow.beginDrag} onDoubleClick={event => { if (!(event.target as HTMLElement).closest('button,a,input,textarea,select,[data-no-window-drag]')) detailWindow.toggleMaximized() }} className={`shrink-0 select-none border-b border-slate-200 bg-white px-4 py-3 sm:px-6 sm:py-4 ${detailWindow.effectiveMode === 'floating' ? 'cursor-move' : ''}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="mb-1.5 flex min-w-0 items-center gap-1.5 overflow-hidden text-[11px] text-slate-400">{parentTask && <><button data-no-window-drag onClick={() => onOpenTask(parentTask.id)} className="max-w-44 truncate font-semibold text-emerald-700 hover:underline">{parentTask.title}</button><ChevronRight className="h-3 w-3 shrink-0" /></>}<span className="truncate">{task.folder_name || 'Clarin Work'}</span><ChevronRight className="h-3 w-3 shrink-0" /><span className="truncate">{task.list_name || 'Bandeja general'}</span>{task.is_milestone && <span className="ml-1 flex shrink-0 items-center gap-1 rounded-full bg-violet-50 px-2 py-1 font-medium text-violet-700"><Flag className="h-3 w-3" /> Hito</span>}</div>
                <div data-no-window-drag className="relative"><textarea rows={1} value={titleDraft} disabled={isPending('title')} onFocus={() => { editingTitleRef.current = true }} onChange={event => setTitleDraft(event.target.value.replace(/\n/g, ' '))} onBlur={() => { void saveTitle() }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); skipTitleSaveRef.current = true; setTitleDraft(task.title); event.currentTarget.blur() } }} aria-label="Título de la tarea" className="block min-h-9 w-full resize-none overflow-hidden rounded-lg border border-transparent bg-transparent py-1 pr-8 text-lg font-bold leading-7 text-slate-900 outline-none transition hover:border-slate-200 focus:border-emerald-300 focus:bg-white focus:px-2 focus:ring-4 focus:ring-emerald-50 sm:text-xl" />{isPending('title') && <Loader2 className="absolute right-2 top-2 h-4 w-4 animate-spin text-emerald-600" />}</div>
              </div>
              <div data-no-window-drag className="flex shrink-0 gap-0.5">
                {!detailWindow.isMobile && <><button title="Acoplar a la derecha" onClick={() => detailWindow.setMode('docked')} className={`flex h-9 w-9 items-center justify-center rounded-xl hover:bg-slate-100 ${detailWindow.effectiveMode === 'docked' ? 'text-emerald-600' : 'text-slate-400'}`}><PanelRight className="h-4 w-4" /></button><button title="Ventana flotante" onClick={() => detailWindow.setMode('floating')} className={`flex h-9 w-9 items-center justify-center rounded-xl hover:bg-slate-100 ${detailWindow.effectiveMode === 'floating' ? 'text-emerald-600' : 'text-slate-400'}`}><Move className="h-4 w-4" /></button></>}
                {!detailWindow.isMobile && <button title={detailWindow.effectiveMode === 'maximized' ? 'Restaurar ventana' : 'Maximizar'} onClick={detailWindow.toggleMaximized} className="flex h-9 w-9 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 hover:text-slate-700">{detailWindow.effectiveMode === 'maximized' ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}</button>}
                <button title="Editar todas las propiedades" onClick={() => onEdit(task)} className="flex h-9 w-9 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 hover:text-slate-700"><Pencil className="h-4 w-4" /></button>
                <button title="Archivar" disabled={isPending('archive')} onClick={() => { void removeTask() }} className="flex h-9 w-9 items-center justify-center rounded-xl text-slate-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40"><Trash2 className="h-4 w-4" /></button>
                <button title="Cerrar" onClick={onClose} className="flex h-9 w-9 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 hover:text-slate-700"><X className="h-5 w-5" /></button>
              </div>
            </div>
            {!isWide && <nav data-no-window-drag className="mt-3 flex rounded-xl bg-slate-100 p-1">{([['details', 'Detalles'], ['activity', `Actividad${comments.length ? ` · ${comments.length}${commentsHasMore ? '+' : ''}` : ''}`]] as [DetailTab, string][]).map(([key, label]) => <button key={key} onClick={() => setTab(key)} className={`min-h-9 flex-1 rounded-lg px-3 text-xs font-semibold transition ${tab === key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>{label}</button>)}</nav>}
          </header>

          {failure && <div className="mx-4 mt-3 flex shrink-0 items-start gap-2 rounded-xl border border-rose-100 bg-rose-50 px-3 py-2.5 text-xs text-rose-700 sm:mx-6"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span className="min-w-0 flex-1 leading-5">{failure.message}</span>{failure.canRetry && <button onClick={() => { const retry = failureRetryRef.current; clearFailure(); retry?.() }} className="shrink-0 rounded-lg bg-white px-2.5 py-1 font-semibold shadow-sm hover:bg-rose-100">Reintentar</button>}<button aria-label="Cerrar aviso" onClick={clearFailure} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg hover:bg-rose-100"><X className="h-3.5 w-3.5" /></button></div>}

          {isWide ? <div className="flex min-h-0 flex-1"><main className="min-w-0 flex-1 overflow-y-auto overscroll-contain px-6 py-6 lg:px-8">{detailsPane}</main><section className="flex w-[390px] min-h-0 shrink-0 flex-col border-l border-slate-200">{activityPane}</section></div> : tab === 'details' ? <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6">{detailsPane}</main> : activityPane}
        </> : <div className="flex flex-1 flex-col items-center justify-center px-6 text-center"><AlertCircle className="h-8 w-8 text-rose-300" /><p className="mt-3 text-sm font-semibold text-slate-700">No pudimos abrir esta tarea.</p><button onClick={() => { void load() }} className="mt-3 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white">Reintentar</button></div>}
      </aside>
    </div>,
    document.body,
  )
}
