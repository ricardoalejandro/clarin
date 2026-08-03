'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DndContext, DragEndEvent, KeyboardSensor, PointerSensor, TouchSensor, useSensor, useSensors } from '@dnd-kit/core'
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ChevronDown, ChevronUp, FolderPlus, GripVertical, Layers3, ListPlus, Plus, Save, Settings2, Trash2, Workflow } from 'lucide-react'
import { apiDelete, apiPost, apiPut } from '@/lib/api'
import type { TaskFolder, TaskList, TaskStatusCategory, TaskWorkflow, TaskWorkflowStatus } from '@/types/task'
import type { TaskAccountUser } from './TaskEditorModal'
import TaskHierarchyTree from './TaskHierarchyTree'
import { TaskColorPicker, TaskContainerIcon, TaskIconPicker } from './TaskContainerAppearance'
import { TaskSelectPicker, type TaskSelectOption } from './TaskSelectPicker'
import { TaskRemoteFolderPicker } from './TaskRemoteHierarchyPicker'
import TaskWorkWindowShell from './TaskWorkWindowShell'
import { TASK_OVERLAY_LAYERS } from './taskOverlayLayers'
import { mergeCanonicalTaskFolderWorkflowDrafts, mergeCanonicalTaskStatusDrafts, taskStatusDraftChanged, taskStructureHasPendingChanges } from './taskStructureDraftState'

interface Props { open: boolean; environmentId: string; folders: TaskFolder[]; lists: TaskList[]; workflows: TaskWorkflow[]; users?: TaskAccountUser[]; storageScope?: string; onClose: () => void; onChanged: () => Promise<void> | void; onCreated?: (created: { type: 'folder'; folder: TaskFolder } | { type: 'list'; list: TaskList }) => void; onOperation?: (operationID: string, active: boolean) => void }
const field = 'w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm text-slate-800 outline-none focus:border-emerald-400 focus:ring-4 focus:ring-emerald-50'
const categories: Array<{ value: TaskStatusCategory; label: string; description: string; color: string }> = [
  { value: 'not_started', label: 'Inicial', description: 'Trabajo todavía no iniciado', color: '#64748b' },
  { value: 'active', label: 'En curso', description: 'Trabajo que está avanzando', color: '#3b82f6' },
  { value: 'done', label: 'Completada', description: 'Trabajo finalizado', color: '#10b981' },
  { value: 'cancelled', label: 'Cancelada', description: 'Trabajo que no continuará', color: '#ef4444' },
]
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
    <div className="col-span-1 sm:col-span-1"><TaskColorPicker compact value={status.color} onChange={color => onDraft({ ...status, color })} label={`Color de ${status.name}`} disabled={busy} /></div>
    <input value={status.name} onChange={event => onDraft({ ...status, name: event.target.value })} className="col-span-2 min-w-0 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold outline-none focus:border-emerald-400 sm:col-span-1" />
    <div className="col-span-2 sm:col-span-1"><TaskSelectPicker value={status.category} options={categoryOptions} onChange={value => onDraft({ ...status, category: value as TaskStatusCategory })} disabled={original.is_default} label={`Categoría de ${status.name}`} /></div>
    <div className="col-span-2 flex justify-end gap-0.5 sm:col-span-1"><button type="button" aria-label={`Subir ${status.name}`} disabled={busy || index === 0} onClick={() => onMove(index, index - 1)} className="rounded-lg p-2 text-slate-400 hover:bg-white disabled:opacity-20"><ChevronUp className="h-4 w-4" /></button><button type="button" aria-label={`Bajar ${status.name}`} disabled={busy || index === count - 1} onClick={() => onMove(index, index + 1)} className="rounded-lg p-2 text-slate-400 hover:bg-white disabled:opacity-20"><ChevronDown className="h-4 w-4" /></button><button type="button" aria-label={`Guardar ${status.name}`} disabled={busy || !status.name.trim()} onClick={onSave} className="rounded-lg p-2 text-emerald-600 hover:bg-emerald-100"><Save className="h-4 w-4" /></button></div>
    <button type="button" aria-label={`Eliminar ${status.name}`} disabled={busy || original.is_default || count <= 2} onClick={onDelete} className="rounded-lg p-2 text-slate-400 hover:bg-rose-100 hover:text-rose-600 disabled:opacity-20"><Trash2 className="h-4 w-4" /></button>
  </div>
}

export default function TaskStructureModal({ open, environmentId, folders, lists, workflows, users = [], storageScope, onClose, onChanged, onCreated, onOperation }: Props) {
  const [tab, setTab] = useState<'structure' | 'workflow'>('structure')
  const [structureInspector, setStructureInspector] = useState<'folder' | 'list' | 'flows'>('folder')
  const [folderName, setFolderName] = useState(''); const [folderColor, setFolderColor] = useState('#10b981'); const [folderWorkflow, setFolderWorkflow] = useState('')
  const [listName, setListName] = useState(''); const [listColor, setListColor] = useState('#10b981'); const [listIcon, setListIcon] = useState('list'); const [listFolder, setListFolder] = useState(''); const [listWorkflow, setListWorkflow] = useState('')
  const [workflowName, setWorkflowName] = useState(''); const [selectedWorkflow, setSelectedWorkflow] = useState('')
  const [newStatus, setNewStatus] = useState({ name: '', color: '#64748b', category: 'active' as TaskStatusCategory })
  const [drafts, setDrafts] = useState<Record<string, TaskWorkflowStatus>>({})
  const [dirtyStatusIDs, setDirtyStatusIDs] = useState<string[]>([])
  const [statusOrder, setStatusOrder] = useState<string[]>([])
  const [folderWorkflows, setFolderWorkflows] = useState<Record<string, string>>({})
  const [dirtyFolderWorkflowIDs, setDirtyFolderWorkflowIDs] = useState<string[]>([])
  const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  const [discardConfirm, setDiscardConfirm] = useState(false)
  const discardDialogRef = useRef<HTMLDivElement>(null)
  const discardReturnFocusRef = useRef<HTMLElement | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))
  const workflow = workflows.find(item => item.id === selectedWorkflow) || workflows.find(item => item.is_default) || workflows[0]
  const orderedStatuses = useMemo(() => statusOrder.map(id => workflow?.statuses.find(item => item.id === id)).filter(Boolean) as TaskWorkflowStatus[], [statusOrder, workflow])
  const rootLists = lists.filter(item => !item.folder_id)
  const workflowPickerOptions = workflowOptions(workflows)

  useEffect(() => {
    if (!open) return
    const current = workflows.find(item => item.id === selectedWorkflow) || workflows.find(item => item.is_default) || workflows[0]
    const defaultWorkflowID = workflows.find(item => item.is_default)?.id || ''
    const mergedFolderWorkflows = mergeCanonicalTaskFolderWorkflowDrafts(
      folders,
      folderWorkflows,
      new Set(dirtyFolderWorkflowIDs),
      defaultWorkflowID,
    )
    if (current) { setSelectedWorkflow(current.id); setStatusOrder(current.statuses.map(item => item.id)) }
    setDrafts(currentDrafts => mergeCanonicalTaskStatusDrafts(workflows, currentDrafts, new Set(dirtyStatusIDs)))
    setFolderWorkflows(mergedFolderWorkflows.drafts)
    setDirtyFolderWorkflowIDs(mergedFolderWorkflows.dirtyFolderIDs)
    setError('')
  }, [folders, open, workflows]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (workflow) setStatusOrder(workflow.statuses.map(item => item.id)) }, [workflow?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const run = async <T,>(operation: () => Promise<{ success: boolean; data?: T; error?: string }>, reset?: () => void, reconcile?: (data: T) => void) => {
    setBusy(true); setError('')
    try { const result = await operation(); if (!result.success) { setError(result.error || 'No se pudo guardar'); return false }; reset?.(); if (result.data) reconcile?.(result.data); await onChanged(); return true } catch { setError('No se pudo completar la operación. Inténtalo nuevamente.'); return false } finally { setBusy(false) }
  }
  const createFolder = () => run<{ folder: TaskFolder }>(() => apiPost('/api/tasks/folders', { environment_id: environmentId, name: folderName.trim(), color: folderColor, workflow_id: folderWorkflow || undefined }), () => setFolderName(''), data => onCreated?.({ type: 'folder', folder: data.folder }))
  const createList = () => run<{ list: TaskList }>(() => apiPost('/api/tasks/lists', { environment_id: environmentId, name: listName.trim(), color: listColor, icon: listIcon, folder_id: listFolder || undefined, workflow_id: listFolder ? undefined : listWorkflow || undefined }), () => setListName(''), data => onCreated?.({ type: 'list', list: data.list }))
  const createWorkflow = () => run(() => apiPost('/api/tasks/workflows', { environment_id: environmentId, name: workflowName.trim() }), () => setWorkflowName(''))
  const addStatus = () => workflow && run(() => apiPost(`/api/tasks/workflows/${workflow.id}/statuses`, newStatus), () => setNewStatus({ name: '', color: '#64748b', category: 'active' }))
  const saveStatus = (status: TaskWorkflowStatus, index: number) => run(
    () => apiPut(`/api/tasks/statuses/${status.id}`, { name: status.name.trim(), color: status.color, category: status.category, sort_order: index }),
    () => setDirtyStatusIDs(current => current.filter(id => id !== status.id)),
  )
  const persistStatusOrder = async (next: string[], previous = statusOrder) => {
    if (!workflow || next.every((id, index) => id === previous[index])) return
    setStatusOrder(next); setBusy(true); setError('')
    try { const result = await apiPut(`/api/tasks/workflows/${workflow.id}/statuses/reorder`, { status_ids: next }); if (!result.success) { setStatusOrder(previous); setError(result.error || 'No se pudo ordenar los estados.'); return }; await onChanged() } catch { setStatusOrder(previous); setError('No se pudo ordenar los estados. Se restauró el orden anterior.') } finally { setBusy(false) }
  }
  const deleteStatus = (status: TaskWorkflowStatus) => { if (!workflow) return; const replacement = workflow.statuses.find(item => item.id !== status.id && item.category === status.category); void run(() => apiDelete(`/api/tasks/statuses/${status.id}${replacement ? `?replacement_status_id=${replacement.id}` : ''}`)) }
  const saveFolderWorkflow = (folder: TaskFolder) => { const value = folderWorkflows[folder.id]; if (value !== folder.workflow_id && folder.task_count > 0 && !window.confirm('Cambiar el flujo remapeará todas las tareas por categoría equivalente. Si falta una equivalencia, no se guardará nada. ¿Continuar?')) return; void run(() => apiPut(`/api/tasks/folders/${folder.id}`, { workflow_id: value || null })) }

  const updateStatusDraft = (status: TaskWorkflowStatus) => {
    const original = workflows.flatMap(item => item.statuses).find(item => item.id === status.id)
    setDrafts(current => ({ ...current, [status.id]: status }))
    setDirtyStatusIDs(current => {
      const dirty = taskStatusDraftChanged(original, status)
      return dirty ? Array.from(new Set([...current, status.id])) : current.filter(id => id !== status.id)
    })
  }
  const hasPendingChanges = taskStructureHasPendingChanges({
    dirtyStatusIDs,
    folderName,
    listName,
    workflowName,
    newStatusName: newStatus.name,
    folders,
    folderWorkflows,
  })
  const discardDrafts = () => {
    setFolderName(''); setListName(''); setWorkflowName('')
    setNewStatus({ name: '', color: '#64748b', category: 'active' })
    setDirtyStatusIDs([])
    setDirtyFolderWorkflowIDs([])
    setDrafts(Object.fromEntries(workflows.flatMap(item => item.statuses.map(status => [status.id, { ...status }]))))
    setFolderWorkflows(Object.fromEntries(folders.map(folder => [folder.id, folder.workflow_id || workflows.find(item => item.is_default)?.id || ''])))
  }
  const requestClose = () => {
    if (busy) return
    if (hasPendingChanges) {
      discardReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setDiscardConfirm(true)
      return
    }
    onClose()
  }

  useEffect(() => {
    if (!discardConfirm) return
    const handleKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setDiscardConfirm(false)
        requestAnimationFrame(() => discardReturnFocusRef.current?.focus({ preventScroll: true }))
        return
      }
      if (event.key !== 'Tab' || !discardDialogRef.current) return
      const focusable = Array.from(discardDialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]),[href],input:not([disabled]),[tabindex]:not([tabindex="-1"])'))
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', handleKeyboard)
    return () => window.removeEventListener('keydown', handleKeyboard)
  }, [discardConfirm])

  if (!open) return null
  return <><TaskWorkWindowShell
    open={open}
    storageKey="clarin:tasks:structure-window"
    storageScope={storageScope}
    title="Organiza Clarin Work"
    eyebrow="Configuración"
    description="Administra la jerarquía, la identidad visual y los estados desde un inspector común."
    icon={Settings2}
    defaultWidth={1120}
    defaultHeight={820}
    minWidth={620}
    minHeight={540}
    busy={busy}
    onRequestClose={requestClose}
    dataAttribute="task-structure-window"
    contentClassName="min-h-0 flex-1 overflow-y-auto bg-slate-50/60"
  >
    <nav role="tablist" aria-label="Configuración de Clarin Work" className="sticky top-0 z-10 flex gap-2 border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur sm:px-6">
      {([['structure', 'Carpetas y listas', Layers3], ['workflow', 'Flujos y estados', Workflow]] as const).map(([key, label, TabIcon]) => <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)} className={`inline-flex min-h-10 items-center gap-2 rounded-xl px-3 text-sm font-bold transition ${tab === key ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'}`}><TabIcon className="h-4 w-4" />{label}</button>)}
    </nav>
    {error && <div role="alert" className="mx-4 mt-4 rounded-xl border border-rose-100 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700 sm:mx-6">{error}</div>}
    {hasPendingChanges && <div role="status" className="mx-4 mt-4 flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-semibold text-amber-800 sm:mx-6"><span>Tienes cambios sin guardar. Se conservarán al navegar dentro de Configuración.</span><span className="shrink-0 rounded-full bg-white px-2 py-1 text-[9px] font-black uppercase tracking-wide text-amber-700 shadow-sm">Pendiente</span></div>}

    {tab === 'structure' ? <div className="grid gap-0 lg:grid-cols-[minmax(270px,0.72fr)_minmax(380px,1.28fr)]">
      <aside className="border-b border-slate-200 bg-white p-4 lg:border-b-0 lg:border-r sm:p-5">
        <div className="grid grid-cols-3 gap-2">
          <button type="button" onClick={() => setStructureInspector('folder')} className={`rounded-xl border p-3 text-left transition ${structureInspector === 'folder' ? 'border-slate-900 bg-slate-900 text-white shadow-lg' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}><FolderPlus className="h-4 w-4" /><span className="mt-2 block text-[11px] font-bold">Carpeta</span></button>
          <button type="button" onClick={() => setStructureInspector('list')} className={`rounded-xl border p-3 text-left transition ${structureInspector === 'list' ? 'border-emerald-600 bg-emerald-600 text-white shadow-lg' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}><ListPlus className="h-4 w-4" /><span className="mt-2 block text-[11px] font-bold">Lista</span></button>
          <button type="button" onClick={() => setStructureInspector('flows')} className={`rounded-xl border p-3 text-left transition ${structureInspector === 'flows' ? 'border-violet-600 bg-violet-600 text-white shadow-lg' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}><Workflow className="h-4 w-4" /><span className="mt-2 block text-[11px] font-bold">Flujos</span></button>
        </div>
        <div className="mt-5 border-t border-slate-100 pt-5"><h3 className="flex items-center gap-2 text-sm font-black text-slate-800"><Layers3 className="h-4 w-4 text-emerald-600" />Estructura y orden</h3><p className="mb-3 mt-1 text-[10px] leading-4 text-slate-400">Arrastra para ordenar. Usa el menú de cada elemento para editar su identidad y acceso.</p><TaskHierarchyTree folders={folders} rootLists={rootLists} scope={{ type: 'environment', id: environmentId }} collapsed={false} users={users} onSelect={() => {}} onChanged={onChanged} onError={setError} onOperation={onOperation} /></div>
      </aside>
      <main className="p-4 sm:p-6">
        {structureInspector === 'folder' && <section className="mx-auto max-w-2xl rounded-3xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex items-start gap-3"><span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-100 text-slate-700"><FolderPlus className="h-5 w-5" /></span><div><h3 className="text-base font-black text-slate-900">Nueva carpeta</h3><p className="mt-1 text-xs leading-5 text-slate-400">Agrupa listas que comparten un propósito y un flujo de trabajo.</p></div></div><div className="mt-5 space-y-4"><label className="block text-xs font-bold text-slate-600">Nombre<input value={folderName} onChange={event => setFolderName(event.target.value)} placeholder="Ej. Operaciones" className={`${field} mt-1.5`} /></label><div className="grid gap-3 sm:grid-cols-2"><div><p className="mb-1.5 text-xs font-bold text-slate-600">Color</p><TaskColorPicker value={folderColor} onChange={setFolderColor} label="Color de carpeta" disabled={busy} /></div><div><p className="mb-1.5 text-xs font-bold text-slate-600">Icono</p><div className="flex min-h-11 items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3" aria-label="Icono fijo de carpeta"><span className="flex h-8 w-8 items-center justify-center rounded-xl bg-white text-slate-600"><TaskContainerIcon value="folder" className="h-4 w-4" /></span><span><span className="block text-xs font-bold text-slate-700">Carpeta</span><span className="block text-[10px] text-slate-400">Icono estándar fijo</span></span></div></div></div><div><p className="mb-1.5 text-xs font-bold text-slate-600">Flujo compartido</p><TaskSelectPicker value={folderWorkflow || workflows.find(item => item.is_default)?.id || ''} options={workflowPickerOptions} onChange={setFolderWorkflow} label="Flujo de carpeta" /></div><button disabled={!folderName.trim() || busy} onClick={() => void createFolder()} className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 text-sm font-black text-white shadow-lg disabled:opacity-30"><FolderPlus className="h-4 w-4" />Crear carpeta</button></div></section>}
        {structureInspector === 'list' && <section className="mx-auto max-w-2xl rounded-3xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex items-start gap-3"><span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-700"><ListPlus className="h-5 w-5" /></span><div><h3 className="text-base font-black text-slate-900">Nueva lista</h3><p className="mt-1 text-xs leading-5 text-slate-400">Crea el destino real de las tareas dentro de una carpeta o al nivel principal.</p></div></div><div className="mt-5 space-y-4"><label className="block text-xs font-bold text-slate-600">Nombre<input value={listName} onChange={event => setListName(event.target.value)} placeholder="Ej. Lanzamiento de campaña" className={`${field} mt-1.5`} /></label><div className="grid gap-3 sm:grid-cols-2"><div><p className="mb-1.5 text-xs font-bold text-slate-600">Color</p><TaskColorPicker value={listColor} onChange={setListColor} label="Color de lista" disabled={busy} /></div><div><p className="mb-1.5 text-xs font-bold text-slate-600">Icono</p><TaskIconPicker value={listIcon} onChange={setListIcon} label="Icono de lista" disabled={busy} /></div></div><div><p className="mb-1.5 text-xs font-bold text-slate-600">Ubicación</p><TaskRemoteFolderPicker environmentId={environmentId} value={listFolder} initialFolders={folders} onChange={setListFolder} disabled={busy} /></div>{!listFolder && <div><p className="mb-1.5 text-xs font-bold text-slate-600">Flujo propio</p><TaskSelectPicker value={listWorkflow || workflows.find(item => item.is_default)?.id || ''} options={workflowPickerOptions} onChange={setListWorkflow} label="Flujo de lista" /></div>}<button disabled={!listName.trim() || busy} onClick={() => void createList()} className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-black text-white shadow-lg shadow-emerald-600/15 disabled:opacity-30"><ListPlus className="h-4 w-4" />Crear lista</button></div></section>}
        {structureInspector === 'flows' && <section className="mx-auto max-w-2xl"><div className="mb-4"><h3 className="text-base font-black text-slate-900">Flujo por carpeta</h3><p className="mt-1 text-xs leading-5 text-slate-400">Las listas heredadas usan el flujo de su carpeta. Guardar puede remapear estados por categoría.</p></div><div className="space-y-3">{folders.map(folder => <div key={folder.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><div className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-700"><span className="flex h-9 w-9 items-center justify-center rounded-xl" style={{ color: folder.color, backgroundColor: `${folder.color}18` }}><TaskContainerIcon value={folder.icon} className="h-4 w-4" /></span><span className="min-w-0 flex-1 truncate">{folder.name}</span></div><div className="flex items-center gap-2"><TaskSelectPicker value={folderWorkflows[folder.id] || ''} options={workflowPickerOptions} onChange={value => { const canonical = folder.workflow_id || workflows.find(item => item.is_default)?.id || ''; setFolderWorkflows(current => ({ ...current, [folder.id]: value })); setDirtyFolderWorkflowIDs(current => value === canonical ? current.filter(id => id !== folder.id) : Array.from(new Set([...current, folder.id]))) }} label={`Flujo de ${folder.name}`} /><button type="button" aria-label={`Guardar flujo de ${folder.name}`} disabled={busy || folderWorkflows[folder.id] === folder.workflow_id} onClick={() => saveFolderWorkflow(folder)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700 transition hover:bg-emerald-100 disabled:opacity-25"><Save className="h-4 w-4" /></button></div></div>)}{!folders.length && <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-400">Crea una carpeta para asignar su flujo.</div>}</div></section>}
      </main>
    </div> : <div className="grid gap-0 lg:grid-cols-[280px_minmax(0,1fr)]">
      <aside className="border-b border-slate-200 bg-white p-4 lg:border-b-0 lg:border-r sm:p-5"><h3 className="text-sm font-black text-slate-800">Flujos disponibles</h3><p className="mt-1 text-[10px] leading-4 text-slate-400">Selecciona un flujo para editar sus estados y orden.</p><div className="mt-4 space-y-1.5">{workflows.map(item => <button key={item.id} type="button" onClick={() => setSelectedWorkflow(item.id)} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition ${workflow?.id === item.id ? 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200' : 'text-slate-600 hover:bg-slate-50'}`}><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white shadow-sm"><Workflow className="h-4 w-4" /></span><span className="min-w-0 flex-1"><span className="block truncate text-xs font-bold">{item.name}</span><span className="block text-[9px] text-slate-400">{item.statuses.length} estados</span></span>{item.is_default && <span className="rounded-full bg-slate-100 px-2 py-1 text-[8px] font-black text-slate-500">GENERAL</span>}</button>)}</div><div className="mt-5 border-t border-slate-100 pt-5"><label className="block text-xs font-bold text-slate-600">Crear flujo<input value={workflowName} onChange={event => setWorkflowName(event.target.value)} placeholder="Nombre del flujo" className={`${field} mt-1.5`} /></label><button disabled={!workflowName.trim() || busy} onClick={() => void createWorkflow()} className="mt-2 flex min-h-10 w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-3 text-xs font-black text-white disabled:opacity-30"><Plus className="h-4 w-4" />Crear flujo</button></div></aside>
      <main className="p-4 sm:p-6"><div className="mb-5 flex flex-col justify-between gap-3 sm:flex-row sm:items-center"><div><p className="text-[10px] font-black uppercase tracking-[.14em] text-emerald-600">Inspector de estados</p><h3 className="mt-1 text-lg font-black text-slate-900">{workflow?.name || 'Selecciona un flujo'}</h3><p className="mt-1 text-xs text-slate-400">Arrastra los estados o usa los botones accesibles para definir el tablero.</p></div><div className="sm:hidden"><TaskSelectPicker value={workflow?.id || ''} options={workflowPickerOptions} onChange={setSelectedWorkflow} label="Seleccionar flujo" searchable /></div></div>
        <DndContext sensors={sensors} onDragEnd={(event: DragEndEvent) => { const from = statusOrder.indexOf(String(event.active.id)); const to = statusOrder.indexOf(String(event.over?.id || '')); if (from >= 0 && to >= 0 && from !== to) void persistStatusOrder(arrayMove(statusOrder, from, to)) }}><SortableContext items={statusOrder} strategy={verticalListSortingStrategy}><div className="space-y-2">{orderedStatuses.map((original, index) => <StatusRow key={original.id} original={original} status={drafts[original.id] || original} index={index} count={orderedStatuses.length} busy={busy} onDraft={updateStatusDraft} onMove={(from, to) => void persistStatusOrder(arrayMove(statusOrder, from, to))} onSave={() => void saveStatus(drafts[original.id] || original, index)} onDelete={() => deleteStatus(original)} />)}</div></SortableContext></DndContext>
        <section className="mt-5 rounded-2xl border border-dashed border-slate-300 bg-white p-4"><h4 className="text-sm font-black text-slate-800">Añadir estado</h4><div className="mt-3 grid gap-3 md:grid-cols-[minmax(160px,1fr)_170px_minmax(190px,0.8fr)_96px]"><input value={newStatus.name} onChange={event => setNewStatus(current => ({ ...current, name: event.target.value }))} placeholder="Nuevo estado" className={field} /><TaskColorPicker value={newStatus.color} onChange={color => setNewStatus(current => ({ ...current, color }))} label="Color del nuevo estado" disabled={busy} /><TaskSelectPicker value={newStatus.category} options={categoryOptions} onChange={category => setNewStatus(current => ({ ...current, category: category as TaskStatusCategory }))} label="Categoría del nuevo estado" /><button disabled={!newStatus.name.trim() || busy || !workflow} onClick={() => void addStatus()} className="rounded-xl bg-emerald-600 px-3 py-2 text-xs font-black text-white disabled:opacity-30">Añadir</button></div></section>
      </main>
    </div>}
  </TaskWorkWindowShell>
  {discardConfirm && createPortal(<div data-task-destructive-dialog className="fixed inset-0 flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-sm" style={{ zIndex: TASK_OVERLAY_LAYERS.confirmation }} role="presentation"><div ref={discardDialogRef} role="alertdialog" aria-modal="true" aria-labelledby="task-structure-discard-title" className="w-full max-w-md rounded-3xl border border-white/70 bg-white p-6 shadow-2xl"><p className="text-[10px] font-black uppercase tracking-[.16em] text-amber-600">Cambios pendientes</p><h2 id="task-structure-discard-title" className="mt-1 text-xl font-black text-slate-900">¿Descartar la configuración?</h2><p className="mt-2 text-sm leading-6 text-slate-500">Los nombres, estados o asignaciones de flujo que todavía no guardaste se perderán.</p><div className="mt-6 flex justify-end gap-2"><button type="button" autoFocus onClick={() => { setDiscardConfirm(false); requestAnimationFrame(() => discardReturnFocusRef.current?.focus({ preventScroll: true })) }} className="rounded-xl px-4 py-2.5 text-sm font-bold text-slate-600 hover:bg-slate-100">Seguir editando</button><button type="button" onClick={() => { setDiscardConfirm(false); discardDrafts(); onClose() }} className="rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-black text-white hover:bg-rose-700">Descartar cambios</button></div></div></div>, document.body)}
  </>
}
