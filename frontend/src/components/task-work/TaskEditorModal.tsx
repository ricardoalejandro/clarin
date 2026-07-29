'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CalendarRange, Check, Flag, Repeat2, Sparkles, X } from 'lucide-react'
import { apiGet, apiPost, apiPut } from '@/lib/api'
import {
  REMINDER_OPTIONS,
  TASK_PRIORITY_CONFIG,
  TASK_TYPE_CONFIG,
  Task,
  TaskList,
  TaskPriority,
  TaskType,
  TaskWorkflow,
} from '@/types/task'
import TaskUserCombobox from './TaskUserCombobox'

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
  workflows: TaskWorkflow[]
  users: TaskAccountUser[]
  onClose: () => void
  onSaved: (task: Task) => void
}

const inputClass = 'w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100'

function localDateTime(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

export default function TaskEditorModal({ open, task, defaultListId, defaultStatusId, defaultOwnerId, defaultTitle, defaultPriority, defaultDueAt, parentTaskId, parentTaskTitle, lists, workflows, users, onClose, onSaved }: Props) {
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
  const dialogRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)
  const savingRef = useRef(false)
  onCloseRef.current = onClose
  savingRef.current = saving

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
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return
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
  }, [open])

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

  const owner = users.find(user => user.id === ownerId)
  const canSave = title.trim() && ownerId && listId && statusId && (!startAt || !dueAt || new Date(dueAt) >= new Date(startAt))
  const collaboratorUsers = useMemo(() => users.filter(user => user.id !== ownerId), [users, ownerId])

  const save = async () => {
    if (!canSave || saving) return
    setSaving(true)
    setError('')
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
      return
    }
    onSaved(result.data.task)
    setSaving(false)
    onClose()
  }

  if (!open || typeof document === 'undefined') return null
  const requestClose = () => { if (!saving) onClose() }
  return createPortal(
    <div data-task-editor-modal className="fixed inset-0 z-[80] flex items-end justify-center bg-slate-950/45 p-0 backdrop-blur-sm sm:items-center sm:p-5" onMouseDown={event => event.target === event.currentTarget && requestClose()}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="task-editor-title" aria-busy={saving} className="flex max-h-[96vh] w-full max-w-4xl flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl outline-none sm:rounded-3xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4 sm:px-7">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-600"><Sparkles className="h-3.5 w-3.5" /> Clarin Work</div>
            <h2 id="task-editor-title" className="mt-1 text-xl font-bold text-slate-900">{task ? 'Editar tarea' : parentTaskId ? 'Crear subtarea' : 'Crear una tarea'}</h2>
            {parentTaskTitle && !task && <p className="mt-1 max-w-lg truncate text-xs text-slate-400">Dentro de {parentTaskTitle}</p>}
          </div>
          <button disabled={saving} onClick={requestClose} className="rounded-xl p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"><X className="h-5 w-5" /></button>
        </div>

        <div className="overflow-y-auto px-5 py-5 sm:px-7">
          <input autoFocus value={title} onChange={event => setTitle(event.target.value)} placeholder="¿Qué hay que lograr?" className="w-full border-0 bg-transparent p-0 text-2xl font-semibold text-slate-900 outline-none placeholder:text-slate-300" />
          <textarea value={description} onChange={event => setDescription(event.target.value)} rows={3} placeholder="Añade contexto, criterios o instrucciones…" className="mt-3 w-full resize-none rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm outline-none focus:border-emerald-300 focus:bg-white focus:ring-4 focus:ring-emerald-50" />

          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <section className="space-y-4 rounded-2xl border border-slate-200 p-4">
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs font-semibold text-slate-500">Lista<select disabled={Boolean(parentTaskId || task?.parent_task_id)} value={listId} onChange={event => setListId(event.target.value)} className={`${inputClass} mt-1.5 disabled:bg-slate-100 disabled:text-slate-500`}>{lists.map(list => <option key={list.id} value={list.id}>{list.name}{list.is_default ? ' · predeterminada' : ''}</option>)}</select></label>
                <label className="text-xs font-semibold text-slate-500">Estado<select value={statusId} onChange={event => { const nextStatus = statuses.find(status => status.id === event.target.value); setStatusId(event.target.value); if (nextStatus?.category === 'done') setProgress(100); if (event.target.value) setError('') }} className={`${inputClass} mt-1.5`}><option value="" disabled>Selecciona un estado…</option>{statuses.map(status => <option key={status.id} value={status.id}>{status.name}</option>)}</select></label>
              </div>
              <div>
                <div className="mb-2 text-xs font-semibold text-slate-500">Tipo</div>
                <div className="grid grid-cols-4 gap-1.5">{(Object.keys(TASK_TYPE_CONFIG) as TaskType[]).map(key => <button key={key} onClick={() => setType(key)} className={`rounded-xl border px-2 py-2 text-xs transition ${type === key ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}><span className="mr-1">{TASK_TYPE_CONFIG[key].icon}</span>{TASK_TYPE_CONFIG[key].label}</button>)}</div>
              </div>
              <div>
                <div className="mb-2 text-xs font-semibold text-slate-500">Prioridad</div>
                <div className="grid grid-cols-4 gap-1.5">{(Object.keys(TASK_PRIORITY_CONFIG) as TaskPriority[]).map(key => <button key={key} onClick={() => setPriority(key)} className={`rounded-xl px-2 py-2 text-xs font-medium transition ${priority === key ? `${TASK_PRIORITY_CONFIG[key].bg} ${TASK_PRIORITY_CONFIG[key].color} ring-1 ring-current` : 'bg-slate-100 text-slate-500'}`}>{TASK_PRIORITY_CONFIG[key].label}</button>)}</div>
              </div>
              <label className="block text-xs font-semibold text-slate-500">Responsable<span className="mt-1.5 block"><TaskUserCombobox users={users} value={ownerId} onChange={setOwnerId} /></span></label>
              <div>
                <div className="mb-2 text-xs font-semibold text-slate-500">Colaboradores</div>
                <div className="flex max-h-32 flex-wrap gap-2 overflow-y-auto">{collaboratorUsers.map(user => { const active = collaboratorIds.includes(user.id); return <button key={user.id} onClick={() => setCollaboratorIds(current => active ? current.filter(id => id !== user.id) : [...current, user.id])} className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-xs ${active ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-600'}`}>{active && <Check className="h-3 w-3" />}{user.display_name || user.username}</button> })}{!collaboratorUsers.length && <span className="text-xs text-slate-400">{owner ? 'No hay más usuarios disponibles' : 'Selecciona primero un responsable'}</span>}</div>
              </div>
            </section>

            <section className="space-y-4 rounded-2xl border border-slate-200 p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-800"><CalendarRange className="h-4 w-4 text-emerald-600" /> Planificación</div>
              <div className="grid grid-cols-2 gap-3"><label className="text-xs font-semibold text-slate-500">Inicio<input type="datetime-local" value={startAt} onChange={event => setStartAt(event.target.value)} className={`${inputClass} mt-1.5`} /></label><label className="text-xs font-semibold text-slate-500">Entrega<input type="datetime-local" value={dueAt} onChange={event => setDueAt(event.target.value)} className={`${inputClass} mt-1.5`} /></label></div>
              {startAt && dueAt && new Date(dueAt) < new Date(startAt) && <p className="text-xs font-medium text-rose-600">La entrega no puede ser anterior al inicio.</p>}
              <div className="flex flex-wrap gap-2"><button onClick={() => setAllDay(value => !value)} className={`rounded-xl border px-3 py-2 text-xs font-medium ${allDay ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-600'}`}>Todo el día</button><button onClick={() => setMilestone(value => !value)} className={`flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-medium ${milestone ? 'border-violet-300 bg-violet-50 text-violet-700' : 'border-slate-200 text-slate-600'}`}><Flag className="h-3.5 w-3.5" /> Hito</button></div>
              <label className="block text-xs font-semibold text-slate-500">Progreso · {progress}%<input type="range" min="0" max="100" step="5" value={progress} disabled={statuses.find(status => status.id === statusId)?.category === 'done'} onChange={event => setProgress(Number(event.target.value))} className="mt-2 w-full accent-emerald-600 disabled:opacity-50" /></label>
              <div className="grid grid-cols-2 gap-3"><label className="text-xs font-semibold text-slate-500"><Repeat2 className="mr-1 inline h-3.5 w-3.5" />Recurrencia<select value={recurrence} onChange={event => setRecurrence(event.target.value)} className={`${inputClass} mt-1.5`}><option value="">No se repite</option><option value="daily">Cada día</option><option value="weekdays">Días laborables</option><option value="weekly">Cada semana</option><option value="monthly">Cada mes</option></select></label><label className="text-xs font-semibold text-slate-500">Recordatorio<select value={reminder} onChange={event => setReminder(Number(event.target.value))} className={`${inputClass} mt-1.5`}>{REMINDER_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label></div>
            </section>
          </div>
          {error && <div className="mt-4 rounded-xl bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">{error}</div>}
        </div>

        <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50 px-5 py-4 sm:px-7">
          <span className="hidden text-xs text-slate-400 sm:block">Los cambios se sincronizan con todos los usuarios de la cuenta.</span>
          <div className="ml-auto flex gap-2"><button disabled={saving} onClick={requestClose} className="rounded-xl px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-40">Cancelar</button><button disabled={!canSave || saving} onClick={save} className="rounded-xl bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-slate-300 transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40">{saving ? 'Guardando…' : task ? 'Guardar cambios' : 'Crear tarea'}</button></div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
