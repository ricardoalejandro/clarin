'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CalendarRange, Flag, Maximize2, Minimize2, Move, PanelRight, Repeat2, Sparkles, X } from 'lucide-react'
import { apiGet, apiPost, apiPut } from '@/lib/api'
import {
  REMINDER_OPTIONS,
  TASK_PRIORITY_CONFIG,
  TASK_TYPE_CONFIG,
  Task,
  TaskFolder,
  TaskList,
  TaskPriority,
  TaskType,
  TaskWorkflow,
} from '@/types/task'
import TaskUserCombobox from './TaskUserCombobox'
import TaskCollaboratorPicker from './TaskCollaboratorPicker'
import { TaskStatusPicker } from './TaskPropertyPicker'
import { TaskListPicker, TaskSelectPicker } from './TaskSelectPicker'
import useTaskWindow, { type TaskWindowResizeEdge } from './useTaskWindow'

export interface TaskAccountUser {
  id: string
  display_name: string
  username: string
  role?: string
}

interface Props {
  open: boolean
  task?: Task | null
  defaultListId?: string
  defaultStatusId?: string
  defaultOwnerId?: string
  defaultTitle?: string
  defaultPriority?: TaskPriority
  defaultDueAt?: string
  parentTaskId?: string
  parentTaskTitle?: string
  lists: TaskList[]
  folders: TaskFolder[]
  workflows: TaskWorkflow[]
  users: TaskAccountUser[]
  onClose: () => void
  onSaved: (task: Task, operationId?: string) => void
  onOperation?: (operationId: string, active: boolean) => void
}

const inputClass = 'w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100'

function localDateTime(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

export default function TaskEditorModal({ open, task, defaultListId, defaultStatusId, defaultOwnerId, defaultTitle, defaultPriority, defaultDueAt, parentTaskId, parentTaskTitle, lists, folders, workflows, users, onClose, onSaved, onOperation }: Props) {
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
  const dialogRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)
  const savingRef = useRef(false)
  const dirtyRef = useRef(false)
  const requestCloseRef = useRef<() => void>(() => {})
  const taskWindow = useTaskWindow({ storageKey: 'clarin:tasks:editor-window:v1', defaultMode: 'floating', defaultWidth: 980, defaultHeight: 820, minWidth: 560, minHeight: 520, align: 'center' })
  onCloseRef.current = onClose
  savingRef.current = saving
  dirtyRef.current = dirty
  const markDirty = () => setDirty(true)

  const selectedList = lists.find(item => item.id === listId)
  const workflow = workflows.find(item => item.id === selectedList?.workflow_id) || workflows.find(item => item.is_default) || workflows[0]
  const statuses = workflow?.statuses || []

  useEffect(() => {
    if (!open) return
    setTitle(task?.title || defaultTitle || '')
    setDescription(task?.description || '')
    setType(task?.type || 'reminder')
    setPriority(task?.priority || defaultPriority || 'medium')
    setListId(task?.list_id || defaultListId || lists.find(item => item.is_default)?.id || lists[0]?.id || '')
    setStatusId(task?.status_id || defaultStatusId || '')
    setOwnerId(task?.assigned_to || defaultOwnerId || '')
    setCollaboratorIds(task?.collaborators?.map(item => item.user_id) || [])
    setStartAt(localDateTime(task?.start_at))
    setDueAt(localDateTime(task?.due_at || defaultDueAt))
    setAllDay(Boolean(task?.is_all_day))
    setProgress(task?.progress || 0)
    setMilestone(Boolean(task?.is_milestone))
    setRecurrence(task?.recurrence_rule || '')
    setReminder(task?.reminder_minutes || 0)
    setEditVersion(task?.version || 1)
    setError('')
    setDirty(false)
    setConfirmClose(false)
  // Initialize only when the dialog/task changes. Late structure/user loads
  // are filled by the focused effects below and never wipe what was typed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, task?.id])

  useEffect(() => {
    if (!open || listId || !lists.length) return
    setListId(defaultListId || lists.find(item => item.is_default)?.id || lists[0].id)
  }, [defaultListId, listId, lists, open])

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

  const canSave = title.trim() && ownerId && listId && statusId && (!startAt || !dueAt || new Date(dueAt) >= new Date(startAt))

  const save = async () => {
    if (!canSave || saving) return
    setSaving(true)
    setError('')
    const operationId = !task ? crypto.randomUUID() : undefined
    if (operationId) onOperation?.(operationId, true)
    const body = {
      title: title.trim(), description, type, priority,
      assigned_to: ownerId, collaborator_ids: collaboratorIds,
      list_id: listId, status_id: statusId,
      start_at: startAt ? new Date(startAt).toISOString() : '',
      due_at: dueAt ? new Date(dueAt).toISOString() : '',
      is_all_day: allDay, progress, is_milestone: milestone,
      recurrence_rule: recurrence, reminder_minutes: reminder || 0,
      ...(parentTaskId && !task ? { parent_task_id: parentTaskId } : {}),
      ...(task ? { version: editVersion } : {}),
      ...(operationId ? { operation_id: operationId } : {}),
    }
    const result = task
      ? await apiPut<{ task: Task }>(`/api/tasks/${task.id}`, body)
      : await apiPost<{ task: Task }>('/api/tasks', body)
    if (!result.success || !result.data?.task) {
      if (task && result.status === 409) {
        const latest = await apiGet<{ task: Task }>(`/api/tasks/${task.id}`)
        if (latest.success && latest.data?.task) setEditVersion(latest.data.task.version || editVersion)
        setError('La tarea cambió en otra sesión. Conservamos todos tus campos; revisa y vuelve a guardar sobre la versión más reciente.')
      } else setError(result.error || 'No se pudo guardar la tarea')
      setSaving(false)
      if (operationId) onOperation?.(operationId, false)
      return
    }
    onSaved(result.data.task, operationId)
    setSaving(false)
    if (operationId) onOperation?.(operationId, false)
    onClose()
  }

  if (!open || typeof document === 'undefined') return null
  const requestClose = () => { if (saving) return; if (dirtyRef.current) { setConfirmClose(true); return }; onClose() }
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
  return createPortal(
    <div data-task-editor-modal data-window-mode={taskWindow.effectiveMode} className={`fixed inset-0 z-[120] ${taskWindow.isModal ? 'bg-slate-950/45 backdrop-blur-sm' : 'pointer-events-none'}`} onMouseDown={event => event.target === event.currentTarget && taskWindow.isModal && requestClose()}>
      <div ref={dialogRef} data-window-mode={taskWindow.effectiveMode} tabIndex={-1} role="dialog" aria-modal={taskWindow.isModal} aria-labelledby="task-editor-title" aria-busy={saving} style={taskWindow.panelStyle} className={`pointer-events-auto fixed flex flex-col overflow-hidden border border-slate-200/80 bg-white shadow-2xl outline-none ${taskWindow.effectiveMode === 'maximized' || taskWindow.isMobile ? 'rounded-none sm:rounded-2xl' : taskWindow.effectiveMode === 'docked' ? 'rounded-l-3xl' : 'rounded-3xl'}`}>
        <div onPointerDown={taskWindow.beginDrag} onDoubleClick={taskWindow.toggleMaximized} className={`flex select-none items-center justify-between border-b border-slate-100 px-5 py-4 sm:px-7 ${taskWindow.effectiveMode === 'floating' ? 'cursor-move' : ''}`}>
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-600"><Sparkles className="h-3.5 w-3.5" /> Clarin Work</div>
            <h2 id="task-editor-title" className="mt-1 text-xl font-bold text-slate-900">{task ? 'Editar tarea' : parentTaskId ? 'Crear subtarea' : 'Crear una tarea'}</h2>
            {parentTaskTitle && !task && <p className="mt-1 max-w-lg truncate text-xs text-slate-400">Dentro de {parentTaskTitle}</p>}
          </div>
          <div data-no-window-drag className="flex items-center gap-1"><button type="button" title="Acoplar a la derecha" aria-label="Acoplar a la derecha" onClick={() => taskWindow.setMode('docked')} className={`rounded-xl p-2 transition ${taskWindow.effectiveMode === 'docked' ? 'bg-emerald-50 text-emerald-700' : 'text-slate-400 hover:bg-slate-100'}`}><PanelRight className="h-4 w-4" /></button><button type="button" title="Ventana flotante" aria-label="Ventana flotante" onClick={() => taskWindow.setMode('floating')} className={`rounded-xl p-2 transition ${taskWindow.effectiveMode === 'floating' ? 'bg-emerald-50 text-emerald-700' : 'text-slate-400 hover:bg-slate-100'}`}><Move className="h-4 w-4" /></button><button type="button" title={taskWindow.effectiveMode === 'maximized' ? 'Restaurar' : 'Maximizar'} aria-label={taskWindow.effectiveMode === 'maximized' ? 'Restaurar' : 'Maximizar'} onClick={taskWindow.toggleMaximized} className="rounded-xl p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700">{taskWindow.effectiveMode === 'maximized' ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}</button><button disabled={saving} onClick={requestClose} className="rounded-xl p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40"><X className="h-5 w-5" /></button></div>
        </div>

        <div className="overflow-y-auto px-5 py-5 sm:px-7">
          <input autoFocus value={title} onChange={event => { setTitle(event.target.value); markDirty() }} placeholder="¿Qué hay que lograr?" className="w-full border-0 bg-transparent p-0 text-2xl font-semibold text-slate-900 outline-none placeholder:text-slate-300" />
          <textarea value={description} onChange={event => { setDescription(event.target.value); markDirty() }} rows={3} placeholder="Añade contexto, criterios o instrucciones…" className="mt-3 w-full resize-none rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm outline-none focus:border-emerald-300 focus:bg-white focus:ring-4 focus:ring-emerald-50" />

          <div className={`mt-5 grid gap-4 ${taskWindow.effectiveMode === 'docked' ? '' : 'lg:grid-cols-2'}`}>
            <section className="space-y-4 rounded-2xl border border-slate-200 p-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="text-xs font-semibold text-slate-500">Lista<div className="mt-1.5"><TaskListPicker disabled={Boolean(parentTaskId || task?.parent_task_id)} value={listId} lists={lists} folders={folders} onChange={next => { setListId(next); markDirty() }} /></div></div>
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
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><label className="text-xs font-semibold text-slate-500">Inicio<input type="datetime-local" value={startAt} onChange={event => { setStartAt(event.target.value); markDirty() }} className={`${inputClass} mt-1.5`} /></label><label className="text-xs font-semibold text-slate-500">Entrega<input type="datetime-local" value={dueAt} onChange={event => { setDueAt(event.target.value); markDirty() }} className={`${inputClass} mt-1.5`} /></label></div>
              {startAt && dueAt && new Date(dueAt) < new Date(startAt) && <p className="text-xs font-medium text-rose-600">La entrega no puede ser anterior al inicio.</p>}
              <div className="flex flex-wrap gap-2"><button onClick={() => { setAllDay(value => !value); markDirty() }} className={`rounded-xl border px-3 py-2 text-xs font-medium ${allDay ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-600'}`}>Todo el día</button><button onClick={() => { setMilestone(value => !value); markDirty() }} className={`flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-medium ${milestone ? 'border-violet-300 bg-violet-50 text-violet-700' : 'border-slate-200 text-slate-600'}`}><Flag className="h-3.5 w-3.5" /> Hito</button></div>
              <label className="block text-xs font-semibold text-slate-500">Progreso · {progress}%<input type="range" min="0" max="100" step="5" value={progress} disabled={statuses.find(status => status.id === statusId)?.category === 'done'} onChange={event => { setProgress(Number(event.target.value)); markDirty() }} className="mt-2 w-full accent-emerald-600 disabled:opacity-50" /></label>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><div className="text-xs font-semibold text-slate-500"><Repeat2 className="mr-1 inline h-3.5 w-3.5" />Recurrencia<div className="mt-1.5"><TaskSelectPicker value={recurrence} options={recurrenceOptions} onChange={value => { setRecurrence(value); markDirty() }} label="Seleccionar recurrencia" /></div></div><div className="text-xs font-semibold text-slate-500">Recordatorio<div className="mt-1.5"><TaskSelectPicker value={String(reminder)} options={reminderOptions} onChange={value => { setReminder(Number(value)); markDirty() }} label="Seleccionar recordatorio" /></div></div></div>
            </section>
          </div>
          {error && <div className="mt-4 rounded-xl bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">{error}</div>}
        </div>

        <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50 px-5 py-4 sm:px-7">
          <span className="hidden text-xs text-slate-400 sm:block">Los cambios se sincronizan con todos los usuarios de la cuenta.</span>
          <div className="ml-auto flex gap-2"><button disabled={saving} onClick={requestClose} className="rounded-xl px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-40">Cancelar</button><button disabled={!canSave || saving} onClick={save} className="rounded-xl bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-slate-300 transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40">{saving ? 'Guardando…' : task ? 'Guardar cambios' : 'Crear tarea'}</button></div>
        </div>
        {taskWindow.effectiveMode === 'floating' && resizeEdges.map(edge => <span key={edge} data-task-window-resize={edge} aria-hidden="true" onPointerDown={event => taskWindow.beginResize(edge, event)} className={`absolute z-10 ${edge === 'n' ? '-top-1 left-4 right-4 h-2 cursor-n-resize' : edge === 's' ? '-bottom-1 left-4 right-4 h-2 cursor-s-resize' : edge === 'e' ? '-right-1 bottom-4 top-4 w-2 cursor-e-resize' : edge === 'w' ? '-left-1 bottom-4 top-4 w-2 cursor-w-resize' : edge === 'ne' ? '-right-1 -top-1 h-4 w-4 cursor-ne-resize' : edge === 'nw' ? '-left-1 -top-1 h-4 w-4 cursor-nw-resize' : edge === 'se' ? '-bottom-1 -right-1 h-4 w-4 cursor-se-resize' : '-bottom-1 -left-1 h-4 w-4 cursor-sw-resize'}`} />)}
      </div>
      {confirmClose && <div className="pointer-events-auto fixed inset-0 z-[160] flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-sm"><div role="alertdialog" aria-modal="true" className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl"><h3 className="text-lg font-black text-slate-900">¿Descartar el borrador?</h3><p className="mt-2 text-sm leading-6 text-slate-500">Hay cambios sin guardar. Puedes continuar editando o cerrar y descartarlos.</p><div className="mt-6 flex justify-end gap-2"><button type="button" onClick={() => setConfirmClose(false)} className="rounded-xl px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-100">Continuar editando</button><button type="button" onClick={() => { setConfirmClose(false); setDirty(false); onClose() }} className="rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-semibold text-white">Descartar</button></div></div></div>}
    </div>,
    document.body,
  )
}
