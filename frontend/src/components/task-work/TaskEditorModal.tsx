'use client'

import { useCallback, useEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { CalendarRange, Check, FileImage, Flag, Loader2, Maximize2, Minimize2, Move, PanelRight, Paperclip, Repeat2, RotateCcw, Sparkles, X } from 'lucide-react'
import { apiGet, apiPost, apiPut, apiUpload } from '@/lib/api'
import {
  REMINDER_OPTIONS,
  TASK_PRIORITY_CONFIG,
  TASK_TYPE_CONFIG,
  Task,
  TaskAttachment,
  TaskFolder,
  TaskList,
  TaskPriority,
  TaskType,
  TaskWorkflow,
} from '@/types/task'
import type { RelatedTaskScope } from '@/types/crm-detail'
import TaskUserCombobox from './TaskUserCombobox'
import TaskCollaboratorPicker from './TaskCollaboratorPicker'
import { TaskStatusPicker } from './TaskPropertyPicker'
import { TaskListPicker, TaskSelectPicker } from './TaskSelectPicker'
import { mergeTaskCatalogPage } from './TaskRemoteHierarchyPicker'
import { environmentFolderListQuery } from './taskEnvironmentAccess'
import useTaskWindow, { type TaskWindowResizeEdge } from './useTaskWindow'
import { TASK_OVERLAY_LAYERS } from './taskOverlayLayers'
import { isTaskEditorSubmitShortcut, taskWindowVisualState } from './taskInteractionVisuals'
import TaskDateTimePicker from './TaskDateTimePicker'
import type { TaskHierarchyCounts } from './taskHierarchyCounts'
import TaskDescriptionEditor from './TaskDescriptionEditor'
import TaskParticipantGrantConfirmDialog from './TaskParticipantGrantConfirmDialog'
import {
  enqueueTaskAttachmentFiles,
  markTaskAttachmentQueueItem,
  taskAttachmentQueueProgress,
  taskAttachmentUploadEndpoint,
  taskAttachmentUploadForm,
  taskCreationAttachmentSaveIntent,
  taskImageFilesFromClipboard,
  type QueuedTaskAttachment,
} from './taskAttachmentQueue'

export interface TaskAccountUser {
  id: string
  display_name: string
  username: string
  role?: string
}

type TaskMutationResponse = {
  task?: Task
  operation_id?: string
  hierarchy_counts?: TaskHierarchyCounts
  code?: string
  affected_user_ids?: string[]
}

interface Props {
  open: boolean
  environmentId?: string
  task?: Task | null
  defaultListId?: string
  defaultFolderId?: string
  defaultStatusId?: string
  defaultOwnerId?: string
  defaultTitle?: string
  defaultPriority?: TaskPriority
  defaultDueAt?: string
  defaultStartAt?: string
  defaultAllDay?: boolean
  parentTaskId?: string
  parentTaskTitle?: string
  lists: TaskList[]
  folders: TaskFolder[]
  workflows: TaskWorkflow[]
  users: TaskAccountUser[]
  relatedScope?: RelatedTaskScope
  storageScope?: string
  onClose: () => void
  onSaved: (task: Task, operationId?: string, hierarchyCounts?: TaskHierarchyCounts) => void
  onOperation?: (operationId: string, active: boolean) => void
}

const inputClass = 'w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100'

function localDateTime(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

export default function TaskEditorModal({ open, environmentId, task, defaultListId, defaultFolderId, defaultStatusId, defaultOwnerId, defaultTitle, defaultPriority, defaultDueAt, defaultStartAt, defaultAllDay, parentTaskId, parentTaskTitle, lists, folders, workflows, users, relatedScope, storageScope, onClose, onSaved, onOperation }: Props) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [type, setType] = useState<TaskType>('reminder')
  const [priority, setPriority] = useState<TaskPriority>('medium')
  const [listId, setListId] = useState('')
  const [statusId, setStatusId] = useState('')
  const [ownerId, setOwnerId] = useState('')
  const [collaboratorIds, setCollaboratorIds] = useState<string[]>([])
  const [startAt, setStartAt] = useState('')
  const [dueAt, setDueAt] = useState('')
  const [allDay, setAllDay] = useState(false)
  const [progress, setProgress] = useState(0)
  const [milestone, setMilestone] = useState(false)
  const [recurrence, setRecurrence] = useState('')
  const [reminder, setReminder] = useState(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [editVersion, setEditVersion] = useState(1)
  const [confirmClose, setConfirmClose] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [attachmentQueue, setAttachmentQueue] = useState<QueuedTaskAttachment[]>([])
  const [createdTask, setCreatedTask] = useState<Task | null>(null)
  const [participantGrantPrompt, setParticipantGrantPrompt] = useState<string[]>([])
  const [catalogLists, setCatalogLists] = useState<TaskList[]>(lists)
  const [catalogFolders, setCatalogFolders] = useState<TaskFolder[]>(folders)
  const dialogRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)
  const savingRef = useRef(false)
  const attachmentObjectURLsRef = useRef(new Map<string, string>())
  const dirtyRef = useRef(false)
  const requestCloseRef = useRef<() => void>(() => {})
  const taskWindow = useTaskWindow({ storageKey: 'clarin:tasks:editor-window', storageScope, defaultMode: 'floating', defaultWidth: 980, defaultHeight: 820, minWidth: 560, minHeight: 520, align: 'center' })
  onCloseRef.current = onClose
  savingRef.current = saving
  dirtyRef.current = dirty
  const markDirty = () => setDirty(true)

  const taskEditable = !task || task.permissions?.can_edit === true
  const selectedList = catalogLists.find(item => item.id === listId)
  const catalogEnvironmentID = environmentId || task?.environment_id || selectedList?.environment_id || ''
  const selectedWorkflowID = selectedList?.workflow_id || (task?.list_id === listId ? task.status_detail?.workflow_id : undefined)
  const workflow = workflows.find(item => item.id === selectedWorkflowID) || workflows.find(item => item.is_default) || workflows[0]
  const statuses = workflow?.statuses || []

  useEffect(() => {
    if (!open || taskEditable) return
    const frame = requestAnimationFrame(() => onCloseRef.current())
    return () => cancelAnimationFrame(frame)
  }, [open, taskEditable])

  useEffect(() => {
    if (!open) return
    if (typeof URL.revokeObjectURL === 'function') for (const url of Array.from(attachmentObjectURLsRef.current.values())) URL.revokeObjectURL(url)
    attachmentObjectURLsRef.current.clear()
    setTitle(task?.title || defaultTitle || '')
    setDescription(task?.description || '')
    setType(task?.type || 'reminder')
    setPriority(task?.priority || defaultPriority || 'medium')
    setListId(task?.list_id || defaultListId || lists.find(item => item.is_default)?.id || lists[0]?.id || '')
    setStatusId(task?.status_id || defaultStatusId || '')
    setOwnerId(task?.assigned_to || defaultOwnerId || '')
    setCollaboratorIds(task?.collaborators?.map(item => item.user_id) || [])
    setStartAt(localDateTime(task?.start_at || defaultStartAt))
    setDueAt(localDateTime(task?.due_at || defaultDueAt))
    setAllDay(task ? Boolean(task.is_all_day) : Boolean(defaultAllDay))
    setProgress(task?.progress || 0)
    setMilestone(Boolean(task?.is_milestone))
    setRecurrence(task?.recurrence_rule || '')
    setReminder(task?.reminder_minutes || 0)
    setEditVersion(task?.version || 1)
    setError('')
    setDirty(false)
    setConfirmClose(false)
    setAttachmentQueue([])
    setCreatedTask(null)
    setParticipantGrantPrompt([])
    setCatalogLists(lists)
    setCatalogFolders(folders)
    if (fileRef.current) fileRef.current.value = ''
  // Initialize only when the dialog/task changes. Late structure/user loads
  // are filled by the focused effects below and never wipe what was typed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, task?.id])

  useEffect(() => {
    setCatalogLists(current => mergeTaskCatalogPage(current, lists))
  }, [lists])

  useEffect(() => {
    setCatalogFolders(current => mergeTaskCatalogPage(current, folders))
  }, [folders])

  useEffect(() => () => {
    if (typeof URL.revokeObjectURL === 'function') for (const url of Array.from(attachmentObjectURLsRef.current.values())) URL.revokeObjectURL(url)
    attachmentObjectURLsRef.current.clear()
  }, [])

  useEffect(() => {
    if (!open || listId || !catalogLists.length) return
    setListId(defaultListId || catalogLists.find(item => item.is_default)?.id || catalogLists[0].id)
  }, [catalogLists, defaultListId, listId, open])

  useEffect(() => {
    if (!open || listId || !defaultFolderId || !catalogEnvironmentID) return
    const controller = new AbortController()
    void apiGet<{ lists: TaskList[] }>(`/api/tasks/environments/${encodeURIComponent(catalogEnvironmentID)}/lists?${environmentFolderListQuery(defaultFolderId)}`, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted || !result.success) return
      const remoteLists = (result.data?.lists || []).filter(item => item.permissions?.can_edit === true)
      if (!remoteLists.length) return
      setCatalogLists(current => mergeTaskCatalogPage(current, remoteLists))
      setListId(current => current || defaultListId || remoteLists.find(item => item.is_default)?.id || remoteLists[0].id)
    })
    return () => controller.abort()
  }, [catalogEnvironmentID, defaultFolderId, defaultListId, listId, open])

  const mergeRemoteCatalog = useCallback((remoteLists: TaskList[], remoteFolders: TaskFolder[]) => {
    if (remoteFolders.length) setCatalogFolders(current => mergeTaskCatalogPage(current, remoteFolders))
    if (!remoteLists.length) return
    setCatalogLists(current => mergeTaskCatalogPage(current, remoteLists))
    const preferred = defaultFolderId ? remoteLists.find(item => item.folder_id === defaultFolderId) : undefined
    setListId(current => current || defaultListId || preferred?.id || (!defaultFolderId ? remoteLists.find(item => item.is_default)?.id || remoteLists[0]?.id : '') || '')
  }, [defaultFolderId, defaultListId])

  useEffect(() => {
    if (!open || ownerId || !users.length) return
    setOwnerId(defaultOwnerId || users[0].id)
  }, [defaultOwnerId, open, ownerId, users])

  useEffect(() => {
    if (!ownerId) return
    setCollaboratorIds(current => current.includes(ownerId) ? current.filter(id => id !== ownerId) : current)
  }, [ownerId])

  useEffect(() => {
    if (!open) return
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const handleKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (savingRef.current) return
        event.preventDefault()
        requestCloseRef.current()
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current || !taskWindow.isModal) return
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'))
      if (!focusable.length) { event.preventDefault(); dialogRef.current.focus(); return }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', handleKeyboard)
    return () => {
      window.removeEventListener('keydown', handleKeyboard)
      previousFocusRef.current?.focus({ preventScroll: true })
      previousFocusRef.current = null
    }
  }, [open, taskWindow.isModal])

  useEffect(() => {
    if (!open || statusId || !statuses.length) return
    const initial = statuses.find(item => item.is_default) || statuses.find(item => item.category === 'not_started') || statuses[0]
    setStatusId(initial.id)
  }, [open, statusId, statuses])

  useEffect(() => {
    if (!statusId || statuses.some(item => item.id === statusId)) return
    const previousStatus = workflows.flatMap(item => item.statuses || []).find(item => item.id === statusId)
    const previousCategory = previousStatus?.category || task?.status_detail?.category
    const equivalent = previousCategory ? statuses.find(item => item.category === previousCategory) : undefined
    if (previousCategory && !equivalent) {
      setStatusId('')
      setError(`La lista elegida no tiene un estado equivalente a “${previousStatus?.name || task?.status_detail?.name || 'el estado anterior'}”. Elige el nuevo estado de forma explícita.`)
      return
    }
    const initial = equivalent || statuses.find(item => item.is_default) || statuses[0]
    setStatusId(initial?.id || '')
  }, [listId, statusId, statuses, task?.status_detail?.category, workflows])

  const addAttachments = (files: File[]) => {
    if (task || createdTask || saving || !files.length) return
    const next = enqueueTaskAttachmentFiles(attachmentQueue, files)
    const addedIDs = new Set(next.added.map(item => item.id))
    setAttachmentQueue(next.queue.map(item => {
      if (!addedIDs.has(item.id) || !item.file.type.toLowerCase().startsWith('image/') || typeof URL.createObjectURL !== 'function') return item
      const previewUrl = URL.createObjectURL(item.file)
      attachmentObjectURLsRef.current.set(item.id, previewUrl)
      return { ...item, previewUrl }
    }))
    if (next.added.length) markDirty()
    if (next.errors.length) setError(next.errors.join(' '))
    if (fileRef.current) fileRef.current.value = ''
  }

  const pasteTaskImages = (event: ReactClipboardEvent<HTMLElement>) => {
    if (task || createdTask || saving) return
    const files = taskImageFilesFromClipboard(event.clipboardData)
    if (!files.length) return
    event.preventDefault()
    addAttachments(files)
  }

  const uploadCreationAttachments = async (taskID: string) => {
    const pendingItems = attachmentQueue.filter(item => item.status === 'pending' || item.status === 'failed')
    let failed = 0
    for (const item of pendingItems) {
      setAttachmentQueue(current => markTaskAttachmentQueueItem(current, item.id, 'uploading'))
      const form = taskAttachmentUploadForm(item.file, crypto.randomUUID())
      const result = await apiUpload<{ success?: boolean; attachment: TaskAttachment; deduped?: boolean; operation_id?: string }>(taskAttachmentUploadEndpoint(taskID), form)
      if (result.success && result.data?.attachment) {
        setAttachmentQueue(current => markTaskAttachmentQueueItem(current, item.id, 'uploaded'))
      } else {
        failed++
        setAttachmentQueue(current => markTaskAttachmentQueueItem(current, item.id, 'failed', result.error || 'No se pudo adjuntar el archivo.'))
      }
    }
    return failed
  }

  const baseCanSave = Boolean(taskEditable && title.trim() && ownerId && listId && statusId && (!startAt || !dueAt || new Date(dueAt) >= new Date(startAt)))
  const queueProgress = taskAttachmentQueueProgress(attachmentQueue)
  const saveIntent = taskCreationAttachmentSaveIntent(createdTask?.id, attachmentQueue, baseCanSave)
  const canSave = task ? baseCanSave : saveIntent !== 'none'

  const save = async (confirmGrants = false) => {
    if (!taskEditable || !canSave || savingRef.current) return false
    savingRef.current = true
    setSaving(true)
    setError('')
    if (saveIntent === 'retry-attachments' && createdTask) {
      const failed = await uploadCreationAttachments(createdTask.id)
      savingRef.current = false
      setSaving(false)
      if (failed) {
        setError(`La tarea ya está creada. ${failed} ${failed === 1 ? 'archivo sigue pendiente' : 'archivos siguen pendientes'}; puedes reintentar sin duplicarla.`)
        return false
      }
      onClose()
      return true
    }
    const operationId = crypto.randomUUID()
    onOperation?.(operationId, true)
    const body = {
      title: title.trim(), description, type, priority,
      assigned_to: ownerId, collaborator_ids: collaboratorIds,
      list_id: listId, status_id: statusId,
      start_at: startAt ? new Date(startAt).toISOString() : '',
      due_at: dueAt ? new Date(dueAt).toISOString() : '',
      is_all_day: allDay, progress, progress_mode: 'manual', manual_progress: progress, is_milestone: milestone,
      recurrence_rule: recurrence, reminder_minutes: reminder || 0,
      ...(parentTaskId && !task ? { parent_task_id: parentTaskId } : {}),
      ...(!task && relatedScope ? {
        ...(relatedScope.contactId ? { contact_id: relatedScope.contactId } : {}),
        ...(relatedScope.leadId ? { lead_id: relatedScope.leadId } : {}),
        ...(relatedScope.eventId ? { event_id: relatedScope.eventId } : {}),
      } : {}),
      ...(task ? { version: editVersion } : {}),
      operation_id: operationId,
      confirm_grants: confirmGrants,
    }
    const result = task
      ? await apiPut<TaskMutationResponse>(`/api/tasks/${task.id}`, body)
      : await apiPost<TaskMutationResponse>('/api/tasks', body)
    if (!result.success || !result.data?.task) {
      if (result.status === 409 && result.data?.code === 'access_change_confirmation_required') {
        setParticipantGrantPrompt(result.data.affected_user_ids || [])
        setError('')
      } else if (task && result.status === 409) {
        const latest = await apiGet<{ task: Task }>(`/api/tasks/${task.id}`)
        if (latest.success && latest.data?.task) setEditVersion(latest.data.task.version || editVersion)
        setError('La tarea cambió en otra sesión. Conservamos todos tus campos; revisa y vuelve a guardar sobre la versión más reciente.')
      } else setError(result.error || 'No se pudo guardar la tarea')
      savingRef.current = false
      setSaving(false)
      onOperation?.(operationId, false)
      return false
    }
    onSaved(result.data.task, result.data.operation_id || operationId, result.data.hierarchy_counts)
    onOperation?.(operationId, false)
    if (!task && attachmentQueue.length) {
      setCreatedTask(result.data.task)
      setDirty(false)
      const failed = await uploadCreationAttachments(result.data.task.id)
      savingRef.current = false
      setSaving(false)
      if (failed) {
        setError(`La tarea quedó creada correctamente. ${failed} ${failed === 1 ? 'archivo no pudo adjuntarse' : 'archivos no pudieron adjuntarse'}; reintenta y no crearemos otra tarea.`)
        // The task already exists and the enclosing retry controls now own
        // the remaining upload work. Closing only the expanded editor exposes
        // those controls without ever creating the task again.
        return true
      }
      onClose()
      return true
    }
    savingRef.current = false
    setSaving(false)
    onClose()
    return true
  }

  if (!open || typeof document === 'undefined') return null
  const requestClose = () => { if (saving) return; if (dirtyRef.current || (createdTask && queueProgress.pending > 0)) { setConfirmClose(true); return }; onClose() }
  requestCloseRef.current = requestClose
  const recurrenceOptions = [
    { value: '', label: 'No se repite', description: 'Tarea única', leading: <Repeat2 className="h-4 w-4" /> },
    { value: 'daily', label: 'Cada día', description: 'Se repite diariamente', leading: <Repeat2 className="h-4 w-4" /> },
    { value: 'weekdays', label: 'Días laborables', description: 'De lunes a viernes', leading: <Repeat2 className="h-4 w-4" /> },
    { value: 'weekly', label: 'Cada semana', description: 'Mismo día cada semana', leading: <Repeat2 className="h-4 w-4" /> },
    { value: 'monthly', label: 'Cada mes', description: 'Misma fecha cada mes', leading: <Repeat2 className="h-4 w-4" /> },
  ]
  const reminderOptions = REMINDER_OPTIONS.map(option => ({ value: String(option.value), label: option.label, description: option.value ? 'Antes de la entrega' : 'Sin aviso previo', leading: <CalendarRange className="h-4 w-4" /> }))
  const resizeEdges: TaskWindowResizeEdge[] = ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw']
  const windowVisual = taskWindowVisualState(taskWindow.effectiveMode, taskWindow.isMobile)
  return createPortal(
    <div data-task-editor-modal data-window-mode={taskWindow.effectiveMode} data-backdrop-mode={windowVisual.blocksWorkspace ? 'modal' : taskWindow.effectiveMode} style={{ ...windowVisual.backdropStyle, zIndex: TASK_OVERLAY_LAYERS.window }} className={`fixed inset-0 transition-[background-color,backdrop-filter] duration-200 ${windowVisual.blocksWorkspace ? '' : 'pointer-events-none'}`} onMouseDown={event => event.target === event.currentTarget && windowVisual.blocksWorkspace && requestClose()}>
      <div ref={dialogRef} onPaste={pasteTaskImages} onKeyDown={event => { if (isTaskEditorSubmitShortcut(event.nativeEvent) && !document.querySelector('[data-task-picker-backdrop], [role="dialog"][aria-label^="Elegir "]')) { event.preventDefault(); void save() } }} data-window-mode={taskWindow.effectiveMode} tabIndex={-1} role="dialog" aria-modal={taskWindow.isModal} aria-labelledby="task-editor-title" aria-busy={saving} style={taskWindow.panelStyle} className={`pointer-events-auto fixed flex flex-col overflow-hidden border border-white/80 bg-white shadow-[0_28px_80px_rgba(15,23,42,0.24)] ring-1 ring-slate-900/5 outline-none ${taskWindow.effectiveMode === 'maximized' || taskWindow.isMobile ? 'rounded-none sm:rounded-2xl' : taskWindow.effectiveMode === 'docked' ? 'rounded-l-3xl' : 'rounded-3xl'}`}>
        <div onPointerDown={taskWindow.beginDrag} onDoubleClick={taskWindow.toggleMaximized} className={`flex select-none items-center justify-between border-b border-slate-100 px-5 py-4 sm:px-7 ${taskWindow.effectiveMode === 'floating' ? 'cursor-move' : ''}`}>
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-600"><Sparkles className="h-3.5 w-3.5" /> Clarin Work</div>
            <h2 id="task-editor-title" className="mt-1 text-xl font-bold text-slate-900">{task ? 'Editar tarea' : parentTaskId ? 'Crear subtarea' : 'Crear una tarea'}</h2>
            {parentTaskTitle && !task && <p className="mt-1 max-w-lg truncate text-xs text-slate-400">Dentro de {parentTaskTitle}</p>}
          </div>
          <div data-no-window-drag className="flex items-center gap-1"><button type="button" title="Acoplar a la derecha" aria-label="Acoplar a la derecha" onClick={() => taskWindow.setMode('docked')} className={`rounded-xl p-2 transition ${taskWindow.effectiveMode === 'docked' ? 'bg-emerald-50 text-emerald-700' : 'text-slate-400 hover:bg-slate-100'}`}><PanelRight className="h-4 w-4" /></button><button type="button" title="Ventana flotante" aria-label="Ventana flotante" onClick={() => taskWindow.setMode('floating')} className={`rounded-xl p-2 transition ${taskWindow.effectiveMode === 'floating' ? 'bg-emerald-50 text-emerald-700' : 'text-slate-400 hover:bg-slate-100'}`}><Move className="h-4 w-4" /></button>{taskWindow.effectiveMode === 'floating' && <button type="button" title="Restablecer tamaño" aria-label="Restablecer tamaño" onClick={taskWindow.resetGeometry} className="rounded-xl p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"><RotateCcw className="h-4 w-4" /></button>}<button type="button" title={taskWindow.effectiveMode === 'maximized' ? 'Restaurar' : 'Maximizar'} aria-label={taskWindow.effectiveMode === 'maximized' ? 'Restaurar' : 'Maximizar'} onClick={taskWindow.toggleMaximized} className="rounded-xl p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700">{taskWindow.effectiveMode === 'maximized' ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}</button><button disabled={saving} onClick={requestClose} className="rounded-xl p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40"><X className="h-5 w-5" /></button></div>
        </div>

        <div {...({ inert: createdTask ? '' : undefined } as Record<string, string | undefined>)} aria-disabled={Boolean(createdTask)} className={`overflow-y-auto px-5 py-5 transition sm:px-7 ${createdTask ? 'opacity-70' : ''}`}>
          <input autoFocus value={title} onChange={event => { setTitle(event.target.value); markDirty() }} placeholder="¿Qué hay que lograr?" className="w-full border-0 bg-transparent p-0 text-2xl font-semibold text-slate-900 outline-none placeholder:text-slate-300" />
          <TaskDescriptionEditor value={description} onChange={value => { setDescription(value); markDirty() }} storageScope={storageScope} panelRef={dialogRef} disabled={saving || Boolean(createdTask)} pending={saving && !createdTask} onSubmit={save} className="mt-4" error={error && <div role="alert" className="mb-3 rounded-xl border border-rose-100 bg-rose-50 px-3 py-2.5 text-xs font-medium text-rose-700">{error}</div>} />

          {!task && <section className="mt-5 rounded-2xl border border-slate-200 bg-white p-4">
            <div className="flex items-start justify-between gap-3"><div><h3 className="flex items-center gap-2 text-sm font-bold text-slate-800"><Paperclip className="h-4 w-4 text-emerald-600" />Adjuntos {queueProgress.total > 0 && <span className="font-normal text-slate-400">{queueProgress.uploaded}/{queueProgress.total}</span>}</h3><p className="mt-1 text-[10px] leading-4 text-slate-400">Selecciona archivos o pega imágenes con Ctrl/⌘ + V. Se subirán después de crear la tarea.</p></div><button type="button" disabled={saving || Boolean(createdTask)} onClick={() => fileRef.current?.click()} className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-xl bg-emerald-50 px-3 text-xs font-bold text-emerald-700 transition hover:bg-emerald-100 disabled:opacity-40"><Paperclip className="h-3.5 w-3.5" />Adjuntar</button><input ref={fileRef} type="file" multiple className="hidden" onChange={event => addAttachments(Array.from(event.target.files || []))} /></div>
            {attachmentQueue.length > 0 ? <div className="mt-3 grid gap-2 sm:grid-cols-2">{attachmentQueue.map(item => <div key={item.id} className={`flex min-w-0 items-center gap-2 rounded-xl border px-3 py-2.5 ${item.status === 'failed' ? 'border-rose-200 bg-rose-50' : item.status === 'uploaded' ? 'border-emerald-200 bg-emerald-50' : 'border-slate-200 bg-slate-50'}`}><span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-white text-slate-500 shadow-sm">{item.status === 'uploading' ? <Loader2 className="h-4 w-4 animate-spin text-emerald-600" /> : item.status === 'uploaded' ? <Check className="h-4 w-4 text-emerald-600" /> : item.previewUrl ? <img src={item.previewUrl} alt="" className="h-full w-full object-cover" /> : <FileImage className="h-4 w-4" />}</span><span className="min-w-0 flex-1"><span className="block truncate text-xs font-semibold text-slate-700">{item.file.name}</span><span className={`block truncate text-[10px] ${item.status === 'failed' ? 'text-rose-600' : 'text-slate-400'}`}>{item.status === 'failed' ? item.error : item.status === 'uploaded' ? 'Adjuntado' : item.status === 'uploading' ? 'Subiendo…' : `${Math.max(1, Math.round(item.file.size / 1024))} KB · pendiente`}</span></span>{item.status !== 'uploading' && item.status !== 'uploaded' && <button type="button" aria-label={`Quitar ${item.file.name}`} onClick={() => { const url = attachmentObjectURLsRef.current.get(item.id); if (url && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url); attachmentObjectURLsRef.current.delete(item.id); setAttachmentQueue(current => current.filter(candidate => candidate.id !== item.id)) }} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-white hover:text-rose-600"><X className="h-3.5 w-3.5" /></button>}</div>)}</div> : <div className="mt-3 rounded-xl border border-dashed border-slate-300 px-4 py-4 text-center text-xs text-slate-400">Todavía no hay archivos en la cola.</div>}
          </section>}

          <div className={`mt-5 grid gap-4 ${taskWindow.effectiveMode === 'docked' ? '' : 'lg:grid-cols-2'}`}>
            <section className="space-y-4 rounded-2xl border border-slate-200 p-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="text-xs font-semibold text-slate-500">Lista<div className="mt-1.5"><TaskListPicker disabled={Boolean(parentTaskId || task?.parent_task_id)} environmentId={catalogEnvironmentID} value={listId} lists={catalogLists} folders={catalogFolders} selectedLabel={task?.list_id === listId ? task.list_name : undefined} selectedDescription={task?.list_id === listId && task.folder_name ? `${task.folder_name} / ${task.list_name || 'Lista'}` : undefined} onItemsLoaded={mergeRemoteCatalog} onChange={(next, list) => { if (list) setCatalogLists(current => mergeTaskCatalogPage(current, [list])); setListId(next); markDirty() }} /></div></div>
                <div className="text-xs font-semibold text-slate-500">Estado<div className="mt-1.5"><TaskStatusPicker value={statusId} statuses={statuses} onChange={nextID => { const nextStatus = statuses.find(status => status.id === nextID); setStatusId(nextID); if (nextStatus?.category === 'done') setProgress(100); if (nextID) setError(''); markDirty() }} /></div></div>
              </div>
              <div>
                <div className="mb-2 text-xs font-semibold text-slate-500">Tipo</div>
                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">{(Object.keys(TASK_TYPE_CONFIG) as TaskType[]).map(key => <button key={key} onClick={() => { setType(key); markDirty() }} className={`rounded-xl border px-2 py-2 text-xs transition ${type === key ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}><span className="mr-1">{TASK_TYPE_CONFIG[key].icon}</span>{TASK_TYPE_CONFIG[key].label}</button>)}</div>
              </div>
              <div>
                <div className="mb-2 text-xs font-semibold text-slate-500">Prioridad</div>
                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">{(Object.keys(TASK_PRIORITY_CONFIG) as TaskPriority[]).map(key => <button key={key} onClick={() => { setPriority(key); markDirty() }} className={`rounded-xl px-2 py-2 text-xs font-medium transition ${priority === key ? `${TASK_PRIORITY_CONFIG[key].bg} ${TASK_PRIORITY_CONFIG[key].color} ring-1 ring-current` : 'bg-slate-100 text-slate-500'}`}>{TASK_PRIORITY_CONFIG[key].label}</button>)}</div>
              </div>
              <label className="block text-xs font-semibold text-slate-500">Responsable<span className="mt-1.5 block"><TaskUserCombobox users={users} value={ownerId} onChange={value => { setOwnerId(value); markDirty() }} /></span></label>
              <div><div className="mb-1 text-xs font-semibold text-slate-500">Colaboradores</div><p className="mb-2 text-[10px] leading-4 text-slate-400">Participantes adicionales; el responsable continúa siendo el propietario.</p><TaskCollaboratorPicker users={users} value={collaboratorIds} ownerID={ownerId} onChange={value => { setCollaboratorIds(value); markDirty() }} emptyLabel={ownerId ? 'Sin colaboradores adicionales.' : 'Selecciona primero un responsable.'} /></div>
            </section>

            <section className="space-y-4 rounded-2xl border border-slate-200 p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-800"><CalendarRange className="h-4 w-4 text-emerald-600" /> Planificación</div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><TaskDateTimePicker label="Inicio" value={startAt} onChange={value => { setStartAt(value); markDirty() }} allDay={allDay} onAllDayChange={value => { setAllDay(value); markDirty() }} /><TaskDateTimePicker label="Entrega" value={dueAt} min={startAt} onChange={value => { setDueAt(value); markDirty() }} allDay={allDay} onAllDayChange={value => { setAllDay(value); markDirty() }} /></div>
              {startAt && dueAt && new Date(dueAt) < new Date(startAt) && <p className="text-xs font-medium text-rose-600">La entrega no puede ser anterior al inicio.</p>}
              <div className="flex flex-wrap gap-2"><button onClick={() => { setAllDay(value => !value); markDirty() }} className={`rounded-xl border px-3 py-2 text-xs font-medium ${allDay ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-600'}`}>Todo el día</button><button onClick={() => { setMilestone(value => !value); markDirty() }} className={`flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-medium ${milestone ? 'border-violet-300 bg-violet-50 text-violet-700' : 'border-slate-200 text-slate-600'}`}><Flag className="h-3.5 w-3.5" /> Hito</button></div>
              <label className="block text-xs font-semibold text-slate-500">Progreso · {progress}%<input type="range" min="0" max="100" step="5" value={progress} disabled={statuses.find(status => status.id === statusId)?.category === 'done'} onChange={event => { setProgress(Number(event.target.value)); markDirty() }} className="mt-2 w-full accent-emerald-600 disabled:opacity-50" /></label>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><div className="text-xs font-semibold text-slate-500"><Repeat2 className="mr-1 inline h-3.5 w-3.5" />Recurrencia<div className="mt-1.5"><TaskSelectPicker value={recurrence} options={recurrenceOptions} onChange={value => { setRecurrence(value); markDirty() }} label="Seleccionar recurrencia" /></div></div><div className="text-xs font-semibold text-slate-500">Recordatorio<div className="mt-1.5"><TaskSelectPicker value={String(reminder)} options={reminderOptions} onChange={value => { setReminder(Number(value)); markDirty() }} label="Seleccionar recordatorio" /></div></div></div>
            </section>
          </div>
          {error && <div className="mt-4 rounded-xl bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">{error}</div>}
        </div>

        <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50 px-5 py-4 sm:px-7">
          <span className={`hidden text-xs sm:block ${createdTask ? 'font-semibold text-amber-700' : 'text-slate-400'}`}>{createdTask ? 'La tarea ya existe; sólo quedan adjuntos pendientes.' : 'Ctrl/⌘ + Enter guarda la tarea desde cualquier campo.'}</span>
          <div className="ml-auto flex gap-2"><button disabled={saving} onClick={requestClose} className="rounded-xl px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-40">{createdTask ? 'Cerrar' : 'Cancelar'}</button><button disabled={!canSave || saving} onClick={() => { void save() }} className="rounded-xl bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-slate-300 transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40">{saving ? createdTask ? 'Reintentando…' : attachmentQueue.length && !task ? 'Creando y adjuntando…' : 'Guardando…' : createdTask ? `Reintentar ${queueProgress.pending} ${queueProgress.pending === 1 ? 'adjunto' : 'adjuntos'}` : task ? 'Guardar cambios' : 'Crear tarea'}</button></div>
        </div>
        {taskWindow.effectiveMode === 'floating' && resizeEdges.map(edge => <span key={edge} data-task-window-resize={edge} aria-hidden="true" onPointerDown={event => taskWindow.beginResize(edge, event)} className={`absolute z-10 ${edge === 'n' ? '-top-1 left-4 right-4 h-2 cursor-n-resize' : edge === 's' ? '-bottom-1 left-4 right-4 h-2 cursor-s-resize' : edge === 'e' ? '-right-1 bottom-4 top-4 w-2 cursor-e-resize' : edge === 'w' ? '-left-1 bottom-4 top-4 w-2 cursor-w-resize' : edge === 'ne' ? '-right-1 -top-1 h-4 w-4 cursor-ne-resize' : edge === 'nw' ? '-left-1 -top-1 h-4 w-4 cursor-nw-resize' : edge === 'se' ? '-bottom-1 -right-1 h-4 w-4 cursor-se-resize' : '-bottom-1 -left-1 h-4 w-4 cursor-sw-resize'}`} />)}
      </div>
      {confirmClose && <div className="pointer-events-auto fixed inset-0 z-[160] flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-sm"><div role="alertdialog" aria-modal="true" className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl"><h3 className="text-lg font-black text-slate-900">{createdTask ? '¿Cerrar con adjuntos pendientes?' : '¿Descartar el borrador?'}</h3><p className="mt-2 text-sm leading-6 text-slate-500">{createdTask ? 'La tarea ya fue creada y no se duplicará. Si cierras ahora, los archivos fallidos saldrán de esta cola.' : 'Hay cambios sin guardar. Puedes continuar editando o cerrar y descartarlos.'}</p><div className="mt-6 flex justify-end gap-2"><button type="button" onClick={() => setConfirmClose(false)} className="rounded-xl px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-100">Continuar editando</button><button type="button" onClick={() => { setConfirmClose(false); setDirty(false); onClose() }} className="rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-semibold text-white">{createdTask ? 'Cerrar' : 'Descartar'}</button></div></div></div>}
      <TaskParticipantGrantConfirmDialog
        open={participantGrantPrompt.length > 0}
        affectedUserIDs={participantGrantPrompt}
        users={users}
        busy={saving}
        onClose={() => setParticipantGrantPrompt([])}
        onConfirm={() => { setParticipantGrantPrompt([]); void save(true) }}
      />
    </div>,
    document.body,
  )
}
