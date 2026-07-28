'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Activity, Calendar, Check, ChevronRight, Download, File, Flag, Link2, Loader2, MessageSquare, Paperclip, Pencil, Plus, Send, Trash2, UserRound, X } from 'lucide-react'
import { apiDelete, apiGet, apiPost, apiPut, apiUpload, subscribeWebSocket } from '@/lib/api'
import { Task, TaskActivity, TaskAttachment, TaskComment, TaskDependency, TaskList, TaskWorkflow } from '@/types/task'
import { TaskAccountUser } from './TaskEditorModal'

interface Props {
  taskId: string | null
  allTasks: Task[]
  users: TaskAccountUser[]
  lists: TaskList[]
  workflows: TaskWorkflow[]
  onClose: () => void
  onEdit: (task: Task) => void
  onChanged: (task?: Task) => void
  onDeleted: (taskId: string) => void
}

type DrawerTab = 'details' | 'comments' | 'activity'

const dateFormatter = new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' })
const activityLabels: Record<string, string> = {
  created: 'creó la tarea', updated: 'actualizó la tarea', subtask_created: 'añadió una subtarea',
  comment_created: 'escribió un comentario', collaborators_updated: 'cambió los colaboradores',
  attachment_added: 'adjuntó un archivo', dependency_added: 'añadió una dependencia',
}

export default function TaskDetailDrawer({ taskId, allTasks, users, lists, workflows, onClose, onEdit, onChanged, onDeleted }: Props) {
  const [task, setTask] = useState<Task | null>(null)
  const [children, setChildren] = useState<Task[]>([])
  const [comments, setComments] = useState<TaskComment[]>([])
  const [activity, setActivity] = useState<TaskActivity[]>([])
  const [attachments, setAttachments] = useState<TaskAttachment[]>([])
  const [dependencies, setDependencies] = useState<TaskDependency[]>([])
  const [tab, setTab] = useState<DrawerTab>('details')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [comment, setComment] = useState('')
  const [editingCommentId, setEditingCommentId] = useState('')
  const [editingCommentBody, setEditingCommentBody] = useState('')
  const [childTitle, setChildTitle] = useState('')
  const [dependencyTaskId, setDependencyTaskId] = useState('')
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async (showLoader = true) => {
    if (!taskId) return
    if (showLoader) setLoading(true)
    const [taskRes, childRes, commentRes, activityRes, attachmentRes, dependencyRes] = await Promise.all([
      apiGet<{ task: Task }>(`/api/tasks/${taskId}`),
      apiGet<{ tasks: Task[] }>(`/api/tasks/${taskId}/children`),
      apiGet<{ comments: TaskComment[] }>(`/api/tasks/${taskId}/comments`),
      apiGet<{ activity: TaskActivity[] }>(`/api/tasks/${taskId}/activity`),
      apiGet<{ attachments: TaskAttachment[] }>(`/api/tasks/${taskId}/attachments`),
      apiGet<{ dependencies: TaskDependency[] }>(`/api/tasks/${taskId}/dependencies`),
    ])
    if (taskRes.data?.task) setTask(taskRes.data.task)
    setChildren(childRes.data?.tasks || [])
    setComments(commentRes.data?.comments || [])
    setActivity(activityRes.data?.activity || [])
    setAttachments(attachmentRes.data?.attachments || [])
    setDependencies(dependencyRes.data?.dependencies || [])
    setLoading(false)
  }, [taskId])

  useEffect(() => {
    if (!taskId) return
    setTab('details')
    setError('')
    void load()
  }, [taskId, load])
  useEffect(() => subscribeWebSocket(raw => {
    const message = raw as { event?: string }
    if (taskId && (message.event === 'task_update' || message.event === 'task_overdue')) void load(false)
  }), [taskId, load])

  const list = lists.find(item => item.id === task?.list_id)
  const workflow = workflows.find(item => item.id === list?.workflow_id) || workflows.find(item => item.is_default)
  const statuses = workflow?.statuses || []
  const possibleDependencies = useMemo(() => allTasks.filter(item => item.id !== taskId && !item.parent_task_id), [allTasks, taskId])

  const update = async (body: Record<string, unknown>) => {
    if (!task) return
    setBusy(true)
    const result = await apiPut<{ task: Task }>(`/api/tasks/${task.id}`, { ...body, version: task.version })
    if (result.success && result.data?.task) {
      setTask(result.data.task)
      onChanged(result.data.task)
    } else setError(result.error || 'No se pudo actualizar')
    setBusy(false)
  }

  const setCollaborator = async (userId: string) => {
    if (!task) return
    const ids = task.collaborators?.map(item => item.user_id) || []
    const next = ids.includes(userId) ? ids.filter(id => id !== userId) : [...ids, userId]
    const result = await apiPut<{ collaborators: Task['collaborators'] }>(`/api/tasks/${task.id}/collaborators`, { user_ids: next })
    if (result.success) setTask(current => current ? { ...current, collaborators: result.data?.collaborators || [] } : current)
  }

  const addChild = async () => {
    if (!task || !childTitle.trim()) return
    const result = await apiPost<{ task: Task }>(`/api/tasks/${task.id}/children`, { title: childTitle.trim(), priority: 'medium' })
    if (result.success && result.data?.task) {
      setChildren(current => [...current, result.data!.task])
      setChildTitle('')
      onChanged()
    } else setError(result.error || 'No se pudo crear la subtarea')
  }

  const toggleChild = async (child: Task) => {
    const done = child.status_detail?.category === 'done'
    const status = statuses.find(item => item.category === (done ? 'not_started' : 'done'))
    if (!status) return
    const result = await apiPut<{ task: Task }>(`/api/tasks/${child.id}`, { status_id: status.id, version: child.version })
    if (result.success && result.data?.task) {
      setChildren(current => current.map(item => item.id === child.id ? result.data!.task : item))
      onChanged()
    }
  }

  const sendComment = async () => {
    if (!task || !comment.trim()) return
    const result = await apiPost<{ comment: TaskComment }>(`/api/tasks/${task.id}/comments`, { body: comment.trim() })
    if (result.success && result.data?.comment) {
      setComments(current => [...current, result.data!.comment])
      setComment('')
      void load(false)
    }
  }
  const saveComment = async (item: TaskComment) => {
    if (!task || !editingCommentBody.trim()) return
    const result = await apiPut(`/api/tasks/${task.id}/comments/${item.id}`, { body: editingCommentBody.trim() })
    if (result.success) {
      setEditingCommentId('')
      await load(false)
    } else setError(result.error || 'No se pudo editar el comentario')
  }
  const deleteComment = async (item: TaskComment) => {
    if (!task || !window.confirm('¿Eliminar este comentario?')) return
    const result = await apiDelete(`/api/tasks/${task.id}/comments/${item.id}`)
    if (result.success) setComments(current => current.filter(commentItem => commentItem.id !== item.id))
    else setError(result.error || 'No se pudo eliminar el comentario')
  }

  const upload = async (file?: File) => {
    if (!task || !file) return
    setBusy(true)
    const form = new FormData()
    form.append('file', file)
    form.append('folder', 'tasks/attachments')
    const uploaded = await apiUpload<{ media_asset_id: string }>('/api/media/upload', form)
    if (uploaded.success && uploaded.data?.media_asset_id) {
      const attached = await apiPost<{ attachment: TaskAttachment }>(`/api/tasks/${task.id}/attachments`, { media_asset_id: uploaded.data.media_asset_id })
      if (attached.success && attached.data?.attachment) setAttachments(current => [...current, attached.data!.attachment])
      else setError(attached.error || 'No se pudo adjuntar el archivo')
    } else setError(uploaded.error || 'No se pudo cargar el archivo')
    setBusy(false)
    if (fileRef.current) fileRef.current.value = ''
  }

  const addDependency = async () => {
    if (!task || !dependencyTaskId) return
    const result = await apiPost<{ dependency: TaskDependency }>(`/api/tasks/${task.id}/dependencies`, { predecessor_task_id: dependencyTaskId, lag_minutes: 0 })
    if (result.success && result.data?.dependency) {
      await load(false)
      setDependencyTaskId('')
      onChanged()
    } else setError(result.error || 'No se pudo crear la dependencia')
  }

  const remove = async () => {
    if (!task || !window.confirm('¿Archivar esta tarea y sus subtareas? Podrás restaurarla desde la Papelera.')) return
    const result = await apiDelete(`/api/tasks/${task.id}`)
    if (result.success) {
      onDeleted(task.id)
      onClose()
    } else setError(result.error || 'No se pudo archivar')
  }

  if (!taskId || typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-[70] bg-slate-950/25" onMouseDown={event => event.target === event.currentTarget && onClose()}>
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-2xl flex-col bg-white shadow-2xl">
        {loading && !task ? <div className="flex flex-1 items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-emerald-600" /></div> : task && <>
          <header className="border-b border-slate-100 px-5 py-4 sm:px-7">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-slate-400"><span>{task.folder_name || 'Espacio de trabajo'}</span><ChevronRight className="h-3 w-3" /><span>{task.list_name || 'Bandeja general'}</span>{task.is_milestone && <span className="flex items-center gap-1 rounded-full bg-violet-50 px-2 py-1 font-medium text-violet-700"><Flag className="h-3 w-3" /> Hito</span>}</div>
                <h2 className="break-words text-xl font-bold leading-snug text-slate-900">{task.title}</h2>
              </div>
              <div className="flex shrink-0 gap-1"><button onClick={() => onEdit(task)} className="rounded-xl p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><Pencil className="h-4 w-4" /></button><button onClick={remove} className="rounded-xl p-2 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 className="h-4 w-4" /></button><button onClick={onClose} className="rounded-xl p-2 text-slate-400 hover:bg-slate-100"><X className="h-5 w-5" /></button></div>
            </div>
            <nav className="mt-4 flex gap-1 rounded-xl bg-slate-100 p-1">{([['details','Detalles'],['comments',`Comentarios ${comments.length ? `(${comments.length})` : ''}`],['activity','Actividad']] as [DrawerTab,string][]).map(([key,label]) => <button key={key} onClick={() => setTab(key)} className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition ${tab === key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}>{label}</button>)}</nav>
          </header>

          <div className="flex-1 overflow-y-auto px-5 py-5 sm:px-7">
            {error && <div className="mb-4 flex items-center justify-between rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700"><span>{error}</span><button onClick={() => setError('')}><X className="h-4 w-4" /></button></div>}
            {tab === 'details' && <div className="space-y-6">
              {task.description && <p className="whitespace-pre-wrap rounded-2xl bg-slate-50 p-4 text-sm leading-6 text-slate-600">{task.description}</p>}
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs font-semibold text-slate-400">Estado<select disabled={busy} value={task.status_id || ''} onChange={event => void update({ status_id: event.target.value })} className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-medium text-slate-700">{statuses.map(status => <option key={status.id} value={status.id}>{status.name}</option>)}</select></label>
                <label className="text-xs font-semibold text-slate-400">Responsable<select disabled={busy} value={task.assigned_to} onChange={event => void update({ assigned_to: event.target.value })} className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-medium text-slate-700">{users.map(user => <option key={user.id} value={user.id}>{user.display_name || user.username}</option>)}</select></label>
              </div>
              <div className="grid grid-cols-2 gap-3 rounded-2xl border border-slate-200 p-4 text-sm"><div><div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-slate-400"><Calendar className="h-3.5 w-3.5" /> Inicio</div><span className="text-slate-700">{task.start_at ? dateFormatter.format(new Date(task.start_at)) : 'Sin fecha'}</span></div><div><div className="mb-1 text-xs font-semibold text-slate-400">Entrega</div><span className="text-slate-700">{task.due_at ? dateFormatter.format(new Date(task.due_at)) : 'Sin fecha'}</span></div></div>
              <div><div className="mb-2 flex items-center justify-between text-xs font-semibold text-slate-400"><span>Progreso</span><span>{task.progress || 0}%</span></div><div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${task.progress || 0}%` }} /></div></div>
              <section><div className="mb-2 flex items-center gap-2 text-sm font-bold text-slate-800"><UserRound className="h-4 w-4 text-emerald-600" /> Colaboradores</div><div className="flex flex-wrap gap-2">{users.filter(user => user.id !== task.assigned_to).map(user => { const selected = task.collaborators?.some(item => item.user_id === user.id); return <button key={user.id} onClick={() => void setCollaborator(user.id)} className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-xs ${selected ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-500'}`}>{selected && <Check className="h-3 w-3" />}{user.display_name || user.username}</button> })}</div></section>
              <section><div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-bold text-slate-800">Subtareas <span className="font-normal text-slate-400">{children.filter(item => item.status_detail?.category === 'done').length}/{children.length}</span></h3></div><div className="space-y-2">{children.map(child => <button key={child.id} onClick={() => void toggleChild(child)} className="flex w-full items-center gap-3 rounded-xl border border-slate-200 px-3 py-2.5 text-left hover:border-emerald-200 hover:bg-emerald-50/40"><span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${child.status_detail?.category === 'done' ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-slate-300'}`}>{child.status_detail?.category === 'done' && <Check className="h-3 w-3" />}</span><span className={`text-sm ${child.status_detail?.category === 'done' ? 'text-slate-400 line-through' : 'text-slate-700'}`}>{child.title}</span></button>)}<div className="flex gap-2"><input value={childTitle} onChange={event => setChildTitle(event.target.value)} onKeyDown={event => event.key === 'Enter' && void addChild()} placeholder="Añadir subtarea…" className="min-w-0 flex-1 rounded-xl border border-dashed border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-400" /><button onClick={addChild} disabled={!childTitle.trim()} className="rounded-xl bg-slate-900 p-2.5 text-white disabled:opacity-30"><Plus className="h-4 w-4" /></button></div></div></section>
              <section><div className="mb-3 flex items-center justify-between"><h3 className="flex items-center gap-2 text-sm font-bold text-slate-800"><Paperclip className="h-4 w-4 text-emerald-600" /> Archivos</h3><button onClick={() => fileRef.current?.click()} disabled={busy} className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-50">Adjuntar</button><input ref={fileRef} type="file" className="hidden" onChange={event => void upload(event.target.files?.[0])} /></div><div className="grid gap-2 sm:grid-cols-2">{attachments.map(item => <div key={item.id} className="flex items-center gap-2 rounded-xl border border-slate-200 p-2.5"><div className="rounded-lg bg-slate-100 p-2"><File className="h-4 w-4 text-slate-500" /></div><div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold text-slate-700">{item.filename}</p><p className="text-[10px] text-slate-400">{Math.max(1, Math.round(item.size_bytes / 1024))} KB</p></div><a href={item.url} target="_blank" rel="noreferrer" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"><Download className="h-4 w-4" /></a><button onClick={async () => { const result = await apiDelete(`/api/tasks/${task.id}/attachments/${item.id}`); if (result.success) setAttachments(current => current.filter(file => file.id !== item.id)) }} className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><X className="h-3.5 w-3.5" /></button></div>)}</div></section>
              <section><h3 className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-800"><Link2 className="h-4 w-4 text-emerald-600" /> Dependencias</h3><div className="space-y-2">{dependencies.map(dep => { const incoming = dep.successor_task_id === task.id; return <div key={dep.id} className="flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600"><span className="rounded bg-white px-2 py-1 font-semibold text-slate-500">{incoming ? 'Bloqueada por' : 'Bloquea a'}</span><span className="min-w-0 flex-1 truncate">{incoming ? dep.predecessor_title : dep.successor_title}</span><button onClick={async () => { const result = await apiDelete(`/api/tasks/${task.id}/dependencies/${dep.id}`); if (result.success) setDependencies(current => current.filter(item => item.id !== dep.id)) }}><X className="h-3.5 w-3.5" /></button></div> })}<div className="flex gap-2"><select value={dependencyTaskId} onChange={event => setDependencyTaskId(event.target.value)} className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm"><option value="">Seleccionar tarea predecesora…</option>{possibleDependencies.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select><button onClick={addDependency} disabled={!dependencyTaskId} className="rounded-xl bg-slate-900 p-2.5 text-white disabled:opacity-30"><Plus className="h-4 w-4" /></button></div></div></section>
            </div>}

            {tab === 'comments' && <div className="flex min-h-full flex-col"><div className="flex-1 space-y-4">{comments.map(item => <div key={item.id} className="group flex gap-3"><div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-700">{item.author_name.slice(0,2).toUpperCase()}</div><div className="min-w-0 flex-1 rounded-2xl rounded-tl-sm bg-slate-50 px-4 py-3"><div className="flex items-center justify-between gap-2"><span className="text-xs font-bold text-slate-700">{item.author_name}</span><div className="flex items-center gap-1"><span className="text-[10px] text-slate-400">{dateFormatter.format(new Date(item.created_at))}</span><button onClick={() => { setEditingCommentId(item.id); setEditingCommentBody(item.body) }} className="rounded p-1 text-slate-300 opacity-0 hover:bg-white hover:text-slate-600 group-hover:opacity-100"><Pencil className="h-3 w-3" /></button><button onClick={() => void deleteComment(item)} className="rounded p-1 text-slate-300 opacity-0 hover:bg-rose-50 hover:text-rose-600 group-hover:opacity-100"><Trash2 className="h-3 w-3" /></button></div></div>{editingCommentId === item.id ? <div className="mt-2"><textarea value={editingCommentBody} onChange={event => setEditingCommentBody(event.target.value)} rows={3} className="w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-400" /><div className="mt-2 flex justify-end gap-2"><button onClick={() => setEditingCommentId('')} className="px-2 py-1 text-xs font-semibold text-slate-400">Cancelar</button><button onClick={() => void saveComment(item)} className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white">Guardar</button></div></div> : <p className="mt-1 whitespace-pre-wrap text-sm leading-5 text-slate-600">{item.body}</p>}</div></div>)}{!comments.length && <div className="py-16 text-center"><MessageSquare className="mx-auto h-8 w-8 text-slate-300" /><p className="mt-2 text-sm text-slate-400">Inicia la conversación sobre esta tarea.</p></div>}</div><div className="sticky bottom-0 mt-5 flex gap-2 bg-white py-3"><textarea rows={2} value={comment} onChange={event => setComment(event.target.value)} placeholder="Escribe un comentario…" className="min-w-0 flex-1 resize-none rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-emerald-400" /><button onClick={sendComment} disabled={!comment.trim()} className="self-end rounded-xl bg-emerald-600 p-3 text-white disabled:opacity-30"><Send className="h-4 w-4" /></button></div></div>}

            {tab === 'activity' && <div className="relative space-y-0 before:absolute before:bottom-4 before:left-[15px] before:top-4 before:w-px before:bg-slate-200">{activity.map(item => <div key={item.id} className="relative flex gap-3 py-3"><div className="z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white"><Activity className="h-3.5 w-3.5 text-emerald-600" /></div><div><p className="text-sm text-slate-600"><strong className="font-semibold text-slate-800">{item.actor_name || 'Sistema'}</strong> {activityLabels[item.action] || item.action}</p><p className="mt-0.5 text-[11px] text-slate-400">{dateFormatter.format(new Date(item.created_at))}</p></div></div>)}</div>}
          </div>
        </>}
      </aside>
    </div>, document.body,
  )
}
