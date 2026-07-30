'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DndContext, DragEndEvent, KeyboardSensor, PointerSensor, TouchSensor, useSensor, useSensors } from '@dnd-kit/core'
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ChevronDown, ChevronUp, FolderPlus, GripVertical, Layers3, ListPlus, Plus, Save, Trash2, Workflow, X } from 'lucide-react'
import { apiDelete, apiPost, apiPut } from '@/lib/api'
import type { TaskFolder, TaskList, TaskStatusCategory, TaskWorkflow, TaskWorkflowStatus } from '@/types/task'
import TaskHierarchyTree from './TaskHierarchyTree'
import { TASK_CONTAINER_COLORS, TASK_CONTAINER_ICONS, TaskContainerIcon } from './TaskContainerAppearance'
import { TaskSelectPicker, type TaskSelectOption } from './TaskSelectPicker'

interface Props { open: boolean; folders: TaskFolder[]; lists: TaskList[]; workflows: TaskWorkflow[]; onClose: () => void; onChanged: () => Promise<void> | void; onOperation?: (operationID: string, active: boolean) => void }
const field = 'w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm text-slate-800 outline-none focus:border-emerald-400 focus:ring-4 focus:ring-emerald-50'
const categories: Array<{ value: TaskStatusCategory; label: string; description: string; color: string }> = [
  { value: 'not_started', label: 'Inicial', description: 'Trabajo todavía no iniciado', color: '#64748b' },
  { value: 'active', label: 'En curso', description: 'Trabajo que está avanzando', color: '#3b82f6' },
  { value: 'done', label: 'Completada', description: 'Trabajo finalizado', color: '#10b981' },
  { value: 'cancelled', label: 'Cancelada', description: 'Trabajo que no continuará', color: '#ef4444' },
]
const colorOptions: TaskSelectOption[] = TASK_CONTAINER_COLORS.map(color => ({ value: color, label: color.toUpperCase(), description: 'Color de identificación', leading: <i className="h-4 w-4 rounded-full" style={{ backgroundColor: color }} /> }))
const iconOptions: TaskSelectOption[] = TASK_CONTAINER_ICONS.map(option => ({ value: option.value, label: option.label, leading: <option.icon className="h-4 w-4" /> }))
const categoryOptions: TaskSelectOption[] = categories.map(item => ({ value: item.value, label: item.label, description: item.description, leading: <i className="h-3 w-3 rounded-full" style={{ backgroundColor: item.color }} /> }))

function workflowOptions(workflows: TaskWorkflow[]): TaskSelectOption[] {
  return workflows.map(item => ({ value: item.id, label: item.name, description: `${item.statuses.length} estados`, badge: item.is_default ? 'GENERAL' : undefined, leading: <Workflow className="h-4 w-4" /> }))
}

function StatusRow({ original, status, index, count, busy, onDraft, onMove, onSave, onDelete }: {
  original: TaskWorkflowStatus; status: TaskWorkflowStatus; index: number; count: number; busy: boolean
  onDraft: (status: TaskWorkflowStatus) => void; onMove: (from: number, to: number) => void; onSave: () => void; onDelete: () => void
}) {
  const sortable = useSortable({ id: status.id })
  return <div ref={sortable.setNodeRef} style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }} className={`grid grid-cols-[34px_minmax(120px,1fr)] items-center gap-2 rounded-2xl border border-slate-100 bg-slate-50 p-2.5 shadow-sm ${sortable.isDragging ? 'z-10 opacity-40' : ''} sm:grid-cols-[34px_54px_minmax(140px,1fr)_190px_108px_36px]`}>
    <button ref={sortable.setActivatorNodeRef} {...sortable.attributes} {...sortable.listeners} type="button" aria-label={`Mover ${status.name}`} className="flex h-9 w-8 cursor-grab items-center justify-center rounded-lg text-slate-300 hover:bg-white hover:text-slate-600"><GripVertical className="h-4 w-4" /></button>
    <div className="col-span-1 sm:col-span-1"><TaskSelectPicker value={status.color} options={colorOptions} onChange={color => onDraft({ ...status, color })} label={`Color de ${status.name}`} className="min-h-9 px-2 [&>span:nth-child(2)]:hidden [&>svg]:hidden" /></div>
    <input value={status.name} onChange={event => onDraft({ ...status, name: event.target.value })} className="col-span-2 min-w-0 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold outline-none focus:border-emerald-400 sm:col-span-1" />
    <div className="col-span-2 sm:col-span-1"><TaskSelectPicker value={status.category} options={categoryOptions} onChange={value => onDraft({ ...status, category: value as TaskStatusCategory })} disabled={original.is_default} label={`Categoría de ${status.name}`} /></div>
    <div className="col-span-2 flex justify-end gap-0.5 sm:col-span-1"><button type="button" aria-label={`Subir ${status.name}`} disabled={busy || index === 0} onClick={() => onMove(index, index - 1)} className="rounded-lg p-2 text-slate-400 hover:bg-white disabled:opacity-20"><ChevronUp className="h-4 w-4" /></button><button type="button" aria-label={`Bajar ${status.name}`} disabled={busy || index === count - 1} onClick={() => onMove(index, index + 1)} className="rounded-lg p-2 text-slate-400 hover:bg-white disabled:opacity-20"><ChevronDown className="h-4 w-4" /></button><button type="button" aria-label={`Guardar ${status.name}`} disabled={busy || !status.name.trim()} onClick={onSave} className="rounded-lg p-2 text-emerald-600 hover:bg-emerald-100"><Save className="h-4 w-4" /></button></div>
    <button type="button" aria-label={`Eliminar ${status.name}`} disabled={busy || original.is_default || count <= 2} onClick={onDelete} className="rounded-lg p-2 text-slate-400 hover:bg-rose-100 hover:text-rose-600 disabled:opacity-20"><Trash2 className="h-4 w-4" /></button>
  </div>
}

export default function TaskStructureModal({ open, folders, lists, workflows, onClose, onChanged, onOperation }: Props) {
  const [tab, setTab] = useState<'structure' | 'workflow'>('structure')
  const [folderName, setFolderName] = useState(''); const [folderColor, setFolderColor] = useState('#10b981'); const [folderIcon, setFolderIcon] = useState('folder'); const [folderWorkflow, setFolderWorkflow] = useState('')
  const [listName, setListName] = useState(''); const [listColor, setListColor] = useState('#10b981'); const [listIcon, setListIcon] = useState('list'); const [listFolder, setListFolder] = useState(''); const [listWorkflow, setListWorkflow] = useState('')
  const [workflowName, setWorkflowName] = useState(''); const [selectedWorkflow, setSelectedWorkflow] = useState('')
  const [newStatus, setNewStatus] = useState({ name: '', color: '#64748b', category: 'active' as TaskStatusCategory })
  const [drafts, setDrafts] = useState<Record<string, TaskWorkflowStatus>>({})
  const [statusOrder, setStatusOrder] = useState<string[]>([])
  const [folderWorkflows, setFolderWorkflows] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  const dialogRef = useRef<HTMLDivElement>(null); const previousFocusRef = useRef<HTMLElement | null>(null); const busyRef = useRef(false); busyRef.current = busy
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))
  const workflow = workflows.find(item => item.id === selectedWorkflow) || workflows.find(item => item.is_default) || workflows[0]
  const orderedStatuses = useMemo(() => statusOrder.map(id => workflow?.statuses.find(item => item.id === id)).filter(Boolean) as TaskWorkflowStatus[], [statusOrder, workflow])
  const rootLists = lists.filter(item => !item.folder_id)
  const workflowPickerOptions = workflowOptions(workflows)
  const folderPickerOptions: TaskSelectOption[] = [{ value: '', label: 'Listas independientes', description: 'Nivel principal', leading: <Layers3 className="h-4 w-4" /> }, ...folders.map(folder => ({ value: folder.id, label: folder.name, description: 'Hereda el flujo de la carpeta', leading: <span style={{ color: folder.color }}><TaskContainerIcon value={folder.icon} className="h-4 w-4" /></span> }))]

  useEffect(() => {
    if (!open) return
    const current = workflows.find(item => item.id === selectedWorkflow) || workflows.find(item => item.is_default) || workflows[0]
    if (current) { setSelectedWorkflow(current.id); setStatusOrder(current.statuses.map(item => item.id)) }
    setDrafts(Object.fromEntries(workflows.flatMap(item => item.statuses.map(status => [status.id, { ...status }]))))
    setFolderWorkflows(Object.fromEntries(folders.map(folder => [folder.id, folder.workflow_id || workflows.find(item => item.is_default)?.id || ''])))
    setError('')
  }, [folders, open, workflows]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (workflow) setStatusOrder(workflow.statuses.map(item => item.id)) }, [workflow?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = requestAnimationFrame(() => dialogRef.current?.focus({ preventScroll: true }))
    const keyboard = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busyRef.current) { event.preventDefault(); onClose() } }
    window.addEventListener('keydown', keyboard); return () => { cancelAnimationFrame(frame); window.removeEventListener('keydown', keyboard); previousFocusRef.current?.focus({ preventScroll: true }) }
  }, [onClose, open])

  const run = async (operation: () => Promise<{ success: boolean; error?: string }>, reset?: () => void) => {
    setBusy(true); setError('')
    try { const result = await operation(); if (!result.success) { setError(result.error || 'No se pudo guardar'); return false }; reset?.(); await onChanged(); return true } catch { setError('No se pudo completar la operación. Inténtalo nuevamente.'); return false } finally { setBusy(false) }
  }
  const createFolder = () => run(() => apiPost('/api/tasks/folders', { name: folderName.trim(), color: folderColor, icon: folderIcon, workflow_id: folderWorkflow || undefined }), () => setFolderName(''))
  const createList = () => run(() => apiPost('/api/tasks/lists', { name: listName.trim(), color: listColor, icon: listIcon, folder_id: listFolder || undefined, workflow_id: listFolder ? undefined : listWorkflow || undefined }), () => setListName(''))
  const createWorkflow = () => run(() => apiPost('/api/tasks/workflows', { name: workflowName.trim() }), () => setWorkflowName(''))
  const addStatus = () => workflow && run(() => apiPost(`/api/tasks/workflows/${workflow.id}/statuses`, newStatus), () => setNewStatus({ name: '', color: '#64748b', category: 'active' }))
  const saveStatus = (status: TaskWorkflowStatus, index: number) => run(() => apiPut(`/api/tasks/statuses/${status.id}`, { name: status.name.trim(), color: status.color, category: status.category, sort_order: index }))
  const persistStatusOrder = async (next: string[], previous = statusOrder) => {
    if (!workflow || next.every((id, index) => id === previous[index])) return
    setStatusOrder(next); setBusy(true); setError('')
    try { const result = await apiPut(`/api/tasks/workflows/${workflow.id}/statuses/reorder`, { status_ids: next }); if (!result.success) { setStatusOrder(previous); setError(result.error || 'No se pudo ordenar los estados.'); return }; await onChanged() } catch { setStatusOrder(previous); setError('No se pudo ordenar los estados. Se restauró el orden anterior.') } finally { setBusy(false) }
  }
  const deleteStatus = (status: TaskWorkflowStatus) => { if (!workflow) return; const replacement = workflow.statuses.find(item => item.id !== status.id && item.category === status.category); void run(() => apiDelete(`/api/tasks/statuses/${status.id}${replacement ? `?replacement_status_id=${replacement.id}` : ''}`)) }
  const saveFolderWorkflow = (folder: TaskFolder) => { const value = folderWorkflows[folder.id]; if (value !== folder.workflow_id && folder.task_count > 0 && !window.confirm('Cambiar el flujo remapeará todas las tareas por categoría equivalente. Si falta una equivalencia, no se guardará nada. ¿Continuar?')) return; void run(() => apiPut(`/api/tasks/folders/${folder.id}`, { workflow_id: value || null })) }

  if (!open || typeof document === 'undefined') return null
  return createPortal(<div data-task-structure-modal className="fixed inset-0 z-[125] flex items-center justify-center bg-slate-950/45 p-3 backdrop-blur-sm" onMouseDown={event => event.target === event.currentTarget && !busy && onClose()}><div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="task-structure-title" className="flex max-h-[94vh] w-full max-w-5xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl outline-none">
    <header className="flex items-center justify-between border-b border-slate-100 px-5 py-4 sm:px-7"><div><p className="text-xs font-bold uppercase tracking-[.18em] text-emerald-600">Configuración</p><h2 id="task-structure-title" className="mt-1 text-xl font-bold text-slate-900">Organiza Clarin Work</h2></div><button disabled={busy} aria-label="Cerrar configuración" onClick={onClose} className="rounded-xl p-2 text-slate-400 hover:bg-slate-100"><X className="h-5 w-5" /></button></header>
    <nav className="border-b border-slate-100 px-5 pt-3 sm:px-7"><div className="flex gap-5">{([['structure','Carpetas y listas'],['workflow','Flujos y estados']] as const).map(([key,label]) => <button key={key} onClick={() => setTab(key)} className={`border-b-2 px-1 pb-3 text-sm font-semibold ${tab === key ? 'border-emerald-500 text-emerald-700' : 'border-transparent text-slate-400'}`}>{label}</button>)}</div></nav>
    <div className="overflow-y-auto px-5 py-5 sm:px-7">{error && <div className="mb-4 rounded-xl bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">{error}</div>}
      {tab === 'structure' && <div className="space-y-6"><div className="grid gap-5 lg:grid-cols-2">
        <section className="rounded-2xl border border-slate-200 p-4"><h3 className="flex items-center gap-2 text-sm font-bold text-slate-800"><FolderPlus className="h-4 w-4 text-emerald-600" /> Nueva carpeta</h3><p className="mt-1 text-xs text-slate-400">Agrupa listas que comparten propósito y flujo.</p><div className="mt-4 space-y-3"><input value={folderName} onChange={event => setFolderName(event.target.value)} placeholder="Ej. Operaciones" className={field} /><div className="grid grid-cols-2 gap-2"><TaskSelectPicker value={folderColor} options={colorOptions} onChange={setFolderColor} label="Color de carpeta" /><TaskSelectPicker value={folderIcon} options={iconOptions} onChange={setFolderIcon} label="Icono de carpeta" searchable /></div><TaskSelectPicker value={folderWorkflow || workflows.find(item => item.is_default)?.id || ''} options={workflowPickerOptions} onChange={setFolderWorkflow} label="Flujo de carpeta" /><button disabled={!folderName.trim() || busy} onClick={() => void createFolder()} className="w-full rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-30">Crear carpeta</button></div></section>
        <section className="rounded-2xl border border-slate-200 p-4"><h3 className="flex items-center gap-2 text-sm font-bold text-slate-800"><ListPlus className="h-4 w-4 text-emerald-600" /> Nueva lista</h3><p className="mt-1 text-xs text-slate-400">Una lista contiene tareas y puede vivir en la raíz o una carpeta.</p><div className="mt-4 space-y-3"><input value={listName} onChange={event => setListName(event.target.value)} placeholder="Ej. Lanzamiento de campaña" className={field} /><div className="grid grid-cols-2 gap-2"><TaskSelectPicker value={listColor} options={colorOptions} onChange={setListColor} label="Color de lista" /><TaskSelectPicker value={listIcon} options={iconOptions} onChange={setListIcon} label="Icono de lista" searchable /></div><TaskSelectPicker value={listFolder} options={folderPickerOptions} onChange={setListFolder} label="Ubicación de lista" searchable />{!listFolder && <TaskSelectPicker value={listWorkflow || workflows.find(item => item.is_default)?.id || ''} options={workflowPickerOptions} onChange={setListWorkflow} label="Flujo de lista" />}<button disabled={!listName.trim() || busy} onClick={() => void createList()} className="w-full rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-30">Crear lista</button></div></section>
      </div><section className="grid gap-5 lg:grid-cols-[minmax(280px,1fr)_minmax(300px,1fr)]"><div className="rounded-2xl border border-slate-200 p-4"><h3 className="mb-1 flex items-center gap-2 text-sm font-bold text-slate-800"><Layers3 className="h-4 w-4 text-emerald-600" /> Estructura y orden</h3><p className="mb-3 text-xs text-slate-400">Arrastra carpetas o listas. Usa ⋯ para cambiar nombre, color o icono.</p><TaskHierarchyTree folders={folders} rootLists={rootLists} scope={{ type: 'all' }} collapsed={false} onSelect={() => {}} onChanged={onChanged} onError={setError} onOperation={onOperation} /></div><div className="rounded-2xl border border-slate-200 p-4"><h3 className="text-sm font-bold text-slate-800">Flujo por carpeta</h3><p className="mb-3 mt-1 text-xs text-slate-400">Las listas heredadas usan el flujo de su carpeta.</p><div className="space-y-2">{folders.map(folder => <div key={folder.id} className="rounded-xl bg-slate-50 p-3"><div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-700"><span style={{ color: folder.color }}><TaskContainerIcon value={folder.icon} className="h-4 w-4" /></span>{folder.name}</div><div className="flex items-center gap-2"><TaskSelectPicker value={folderWorkflows[folder.id] || ''} options={workflowPickerOptions} onChange={value => setFolderWorkflows(current => ({ ...current, [folder.id]: value }))} label={`Flujo de ${folder.name}`} /><button type="button" disabled={busy || folderWorkflows[folder.id] === folder.workflow_id} onClick={() => saveFolderWorkflow(folder)} className="rounded-xl p-3 text-emerald-600 hover:bg-emerald-50 disabled:opacity-25"><Save className="h-4 w-4" /></button></div></div>)}{!folders.length && <div className="rounded-xl border border-dashed border-slate-200 p-6 text-center text-xs text-slate-400">Crea una carpeta para asignar su flujo.</div>}</div></div></section></div>}
      {tab === 'workflow' && <div className="space-y-5"><section className="flex flex-col gap-3 rounded-2xl border border-slate-200 p-4 sm:flex-row sm:items-center"><div className="flex-1"><h3 className="flex items-center gap-2 text-sm font-bold text-slate-800"><Workflow className="h-4 w-4 text-emerald-600" /> Crear flujo</h3><p className="mt-1 text-xs text-slate-400">Comienza con estados inicial, en curso, completada y cancelada.</p></div><input value={workflowName} onChange={event => setWorkflowName(event.target.value)} placeholder="Nombre del flujo" className={`${field} sm:w-64`} /><button disabled={!workflowName.trim() || busy} onClick={() => void createWorkflow()} className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-30"><Plus className="mr-1 inline h-4 w-4" />Crear</button></section>
        <section className="rounded-2xl border border-slate-200 p-4"><div className="mb-4 flex flex-col justify-between gap-3 sm:flex-row sm:items-center"><div><h3 className="text-sm font-bold text-slate-800">Estados del flujo</h3><p className="mt-1 text-xs text-slate-400">Arrastra para definir el orden del tablero.</p></div><div className="sm:w-72"><TaskSelectPicker value={workflow?.id || ''} options={workflowPickerOptions} onChange={setSelectedWorkflow} label="Seleccionar flujo" searchable /></div></div>
          <DndContext sensors={sensors} onDragEnd={(event: DragEndEvent) => { const from = statusOrder.indexOf(String(event.active.id)); const to = statusOrder.indexOf(String(event.over?.id || '')); if (from >= 0 && to >= 0 && from !== to) void persistStatusOrder(arrayMove(statusOrder, from, to)) }}><SortableContext items={statusOrder} strategy={verticalListSortingStrategy}><div className="space-y-2">{orderedStatuses.map((original, index) => <StatusRow key={original.id} original={original} status={drafts[original.id] || original} index={index} count={orderedStatuses.length} busy={busy} onDraft={status => setDrafts(current => ({ ...current, [status.id]: status }))} onMove={(from, to) => void persistStatusOrder(arrayMove(statusOrder, from, to))} onSave={() => void saveStatus(drafts[original.id] || original, index)} onDelete={() => deleteStatus(original)} />)}</div></SortableContext></DndContext>
          <div className="mt-4 grid gap-2 rounded-2xl border border-dashed border-slate-300 p-3 sm:grid-cols-[minmax(160px,1fr)_160px_210px_90px]"><input value={newStatus.name} onChange={event => setNewStatus(current => ({ ...current, name: event.target.value }))} placeholder="Nuevo estado" className={field} /><TaskSelectPicker value={newStatus.color} options={colorOptions} onChange={color => setNewStatus(current => ({ ...current, color }))} label="Color del nuevo estado" /><TaskSelectPicker value={newStatus.category} options={categoryOptions} onChange={category => setNewStatus(current => ({ ...current, category: category as TaskStatusCategory }))} label="Categoría del nuevo estado" /><button disabled={!newStatus.name.trim() || busy || !workflow} onClick={() => void addStatus()} className="rounded-xl bg-emerald-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-30">Añadir</button></div>
        </section></div>}
    </div>
  </div></div>, document.body)
}
