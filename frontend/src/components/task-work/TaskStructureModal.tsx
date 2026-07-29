'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronUp, FolderPlus, Layers3, ListPlus, Plus, Save, Trash2, Workflow, X } from 'lucide-react'
import { apiDelete, apiPost, apiPut } from '@/lib/api'
import { TaskFolder, TaskList, TaskStatusCategory, TaskWorkflow, TaskWorkflowStatus } from '@/types/task'

interface Props {
  open: boolean
  folders: TaskFolder[]
  lists: TaskList[]
  workflows: TaskWorkflow[]
  onClose: () => void
  onChanged: () => Promise<void> | void
}

const field = 'w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm text-slate-800 outline-none focus:border-emerald-400 focus:ring-4 focus:ring-emerald-50'
const categories: { value: TaskStatusCategory; label: string }[] = [
  { value: 'not_started', label: 'Inicial' }, { value: 'active', label: 'En curso' },
  { value: 'done', label: 'Completada' }, { value: 'cancelled', label: 'Cancelada' },
]

export default function TaskStructureModal({ open, folders, lists, workflows, onClose, onChanged }: Props) {
  const [tab, setTab] = useState<'structure' | 'workflow'>('structure')
  const [folderName, setFolderName] = useState('')
  const [folderColor, setFolderColor] = useState('#10b981')
  const [folderWorkflow, setFolderWorkflow] = useState('')
  const [listName, setListName] = useState('')
  const [listColor, setListColor] = useState('#10b981')
  const [listFolder, setListFolder] = useState('')
  const [listWorkflow, setListWorkflow] = useState('')
  const [workflowName, setWorkflowName] = useState('')
  const [selectedWorkflow, setSelectedWorkflow] = useState('')
  const [newStatus, setNewStatus] = useState({ name: '', color: '#64748b', category: 'active' as TaskStatusCategory })
  const [drafts, setDrafts] = useState<Record<string, TaskWorkflowStatus>>({})
  const [folderDrafts, setFolderDrafts] = useState<Record<string, { name: string; color: string; workflow_id: string }>>({})
  const [listDrafts, setListDrafts] = useState<Record<string, { name: string; color: string; folder_id: string }>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const dialogRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)
  const busyRef = useRef(busy)
  onCloseRef.current = onClose
  busyRef.current = busy

  useEffect(() => {
    if (!open) return
    const selected = workflows.find(item => item.id === selectedWorkflow) || workflows.find(item => item.is_default) || workflows[0]
    if (selected) setSelectedWorkflow(selected.id)
    setDrafts(Object.fromEntries(workflows.flatMap(workflow => workflow.statuses.map(status => [status.id, { ...status }]))))
    setFolderDrafts(Object.fromEntries(folders.map(folder => [folder.id, { name: folder.name, color: folder.color, workflow_id: folder.workflow_id || '' }])))
    setListDrafts(Object.fromEntries(lists.map(list => [list.id, { name: list.name, color: list.color, folder_id: list.folder_id || '' }])))
    setError('')
  }, [open, workflows, selectedWorkflow, folders, lists])

  useEffect(() => {
    if (!open) return
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusDialog = window.requestAnimationFrame(() => dialogRef.current?.focus({ preventScroll: true }))
    const handleKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (busyRef.current) return
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
      window.cancelAnimationFrame(focusDialog)
      window.removeEventListener('keydown', handleKeyboard)
      previousFocusRef.current?.focus({ preventScroll: true })
      previousFocusRef.current = null
    }
  }, [open])

  const workflow = workflows.find(item => item.id === selectedWorkflow)
  const sortedLists = useMemo(() => [...lists].sort((a, b) => a.name.localeCompare(b.name)), [lists])

  const run = async (operation: () => Promise<{ success: boolean; error?: string }>, reset?: () => void) => {
    setBusy(true)
    setError('')
    try {
      const result = await operation()
      if (result.success) {
        reset?.()
        await onChanged()
      } else setError(result.error || 'No se pudo guardar')
    } catch {
      setError('No se pudo completar la operación. Inténtalo nuevamente.')
    } finally {
      setBusy(false)
    }
  }

  const createFolder = () => run(() => apiPost('/api/tasks/folders', { name: folderName.trim(), color: folderColor, workflow_id: folderWorkflow || undefined }), () => setFolderName(''))
  const createList = () => run(() => apiPost('/api/tasks/lists', { name: listName.trim(), color: listColor, folder_id: listFolder || undefined, workflow_id: listFolder ? undefined : listWorkflow || undefined }), () => setListName(''))
  const createWorkflow = () => run(() => apiPost('/api/tasks/workflows', { name: workflowName.trim() }), () => setWorkflowName(''))
  const addStatus = () => workflow && run(() => apiPost(`/api/tasks/workflows/${workflow.id}/statuses`, newStatus), () => setNewStatus({ name: '', color: '#64748b', category: 'active' }))
  const saveStatus = (status: TaskWorkflowStatus) => run(() => apiPut(`/api/tasks/statuses/${status.id}`, { name: status.name.trim(), color: status.color, category: status.category, sort_order: status.sort_order }))
  const reorderStatuses = async (fromId: string, toId: string) => {
    if (!workflow || fromId === toId) return
    const ordered = [...workflow.statuses]
    const from = ordered.findIndex(item => item.id === fromId)
    const to = ordered.findIndex(item => item.id === toId)
    if (from < 0 || to < 0) return
    const [moved] = ordered.splice(from, 1)
    ordered.splice(to, 0, moved)
    await run(() => apiPut(`/api/tasks/workflows/${workflow.id}/statuses/reorder`, { status_ids: ordered.map(status => status.id) }))
  }
  const deleteStatus = (status: TaskWorkflowStatus) => {
    if (!workflow) return
    const replacement = workflow.statuses.find(item => item.id !== status.id && item.category === status.category)
    const suffix = replacement ? `?replacement_status_id=${replacement.id}` : ''
    void run(() => apiDelete(`/api/tasks/statuses/${status.id}${suffix}`))
  }
  const saveFolder = (folder: TaskFolder) => {
    const draft = folderDrafts[folder.id]
    if (!draft?.name.trim()) return
    if (draft.workflow_id !== (folder.workflow_id || '') && folder.task_count > 0 && !window.confirm('Cambiar el flujo remapeará los estados de todas las tareas por su categoría equivalente. Si falta una equivalencia, no se guardará ningún cambio. ¿Continuar?')) return
    void run(() => apiPut(`/api/tasks/folders/${folder.id}`, { name: draft.name.trim(), color: draft.color, workflow_id: draft.workflow_id || null }))
  }
  const archiveFolder = (folder: TaskFolder) => {
    if (folder.task_count > 0) { setError('Mueve o archiva las tareas de esta carpeta antes de archivarla. Así ninguna tarea queda oculta o bloqueada.'); return }
    if (!window.confirm(`¿Archivar “${folder.name}” y sus listas vacías?`)) return
    void run(() => apiDelete(`/api/tasks/folders/${folder.id}`))
  }
  const saveList = async (list: TaskList) => {
    const draft = listDrafts[list.id]
    if (!draft?.name.trim()) return
    if (draft.folder_id !== (list.folder_id || '') && list.task_count > 0 && !window.confirm('Mover esta lista puede cambiar su flujo heredado. Los estados se remapearán por categoría y la operación completa se cancelará si falta una equivalencia. ¿Continuar?')) return
    await run(() => apiPut(`/api/tasks/lists/${list.id}/structure`, {
      name: draft.name.trim(), color: draft.color, folder_id: draft.folder_id,
      workflow_inherited: Boolean(draft.folder_id),
    }))
  }
  const archiveList = (list: TaskList) => {
    if (list.task_count > 0) { setError('Mueve o archiva las tareas de esta lista antes de archivarla. Así ninguna tarea queda oculta o bloqueada.'); return }
    if (!window.confirm(`¿Archivar la lista vacía “${list.name}”?`)) return
    void run(() => apiDelete(`/api/tasks/lists/${list.id}`))
  }

  if (!open || typeof document === 'undefined') return null
  const requestClose = () => { if (!busy) onClose() }
  return createPortal(<div data-task-structure-modal className="fixed inset-0 z-[85] flex items-end justify-center bg-slate-950/45 p-0 backdrop-blur-sm sm:items-center sm:p-5" onMouseDown={event => event.target === event.currentTarget && requestClose()}>
    <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="task-structure-title" aria-busy={busy} className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl outline-none sm:rounded-3xl">
      <header className="flex items-center justify-between border-b border-slate-100 px-5 py-4 sm:px-7"><div><p className="text-xs font-bold uppercase tracking-[.18em] text-emerald-600">Configuración</p><h2 id="task-structure-title" className="mt-1 text-xl font-bold text-slate-900">Organiza Clarin Work</h2></div><button disabled={busy} aria-label="Cerrar configuración" onClick={requestClose} className="rounded-xl p-2 text-slate-400 hover:bg-slate-100 disabled:opacity-40"><X className="h-5 w-5" /></button></header>
      <div className="border-b border-slate-100 px-5 pt-3 sm:px-7"><div className="flex gap-5">{([['structure','Carpetas y listas'],['workflow','Flujos y estados']] as const).map(([key,label]) => <button key={key} onClick={() => setTab(key)} className={`border-b-2 px-1 pb-3 text-sm font-semibold ${tab === key ? 'border-emerald-500 text-emerald-700' : 'border-transparent text-slate-400'}`}>{label}</button>)}</div></div>
      <div className="overflow-y-auto px-5 py-5 sm:px-7">
        {error && <div className="mb-4 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}
        {tab === 'structure' && <div className="grid gap-5 sm:grid-cols-2">
          <section className="rounded-2xl border border-slate-200 p-4"><h3 className="flex items-center gap-2 text-sm font-bold text-slate-800"><FolderPlus className="h-4 w-4 text-emerald-600" /> Nueva carpeta</h3><p className="mt-1 text-xs leading-5 text-slate-400">Agrupa listas que comparten un propósito o flujo.</p><div className="mt-4 space-y-3"><input value={folderName} onChange={event => setFolderName(event.target.value)} placeholder="Ej. Operaciones" className={field} /><div className="flex gap-2"><input type="color" value={folderColor} onChange={event => setFolderColor(event.target.value)} className="h-10 w-12 rounded-xl border border-slate-200 p-1" /><select value={folderWorkflow} onChange={event => setFolderWorkflow(event.target.value)} className={field}><option value="">Flujo general</option>{workflows.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div><button disabled={!folderName.trim() || busy} onClick={createFolder} className="w-full rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-30">Crear carpeta</button></div></section>
          <section className="rounded-2xl border border-slate-200 p-4"><h3 className="flex items-center gap-2 text-sm font-bold text-slate-800"><ListPlus className="h-4 w-4 text-emerald-600" /> Nueva lista</h3><p className="mt-1 text-xs leading-5 text-slate-400">Una lista contiene tareas y hereda el flujo de su carpeta.</p><div className="mt-4 space-y-3"><div className="flex gap-2"><input type="color" value={listColor} onChange={event => setListColor(event.target.value)} className="h-10 w-12 rounded-xl border border-slate-200 p-1" /><input value={listName} onChange={event => setListName(event.target.value)} placeholder="Ej. Lanzamiento de campaña" className={field} /></div><select value={listFolder} onChange={event => setListFolder(event.target.value)} className={field}><option value="">Sin carpeta</option>{folders.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>{!listFolder && <select value={listWorkflow} onChange={event => setListWorkflow(event.target.value)} className={field}><option value="">Flujo general</option>{workflows.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}<button disabled={!listName.trim() || busy} onClick={createList} className="w-full rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-30">Crear lista</button></div></section>
          <section className="sm:col-span-2"><h3 className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-800"><Layers3 className="h-4 w-4 text-emerald-600" /> Administrar estructura</h3><div className="space-y-2">
            {folders.map(folder => { const draft = folderDrafts[folder.id] || { name: folder.name, color: folder.color, workflow_id: folder.workflow_id || '' }; return <div key={folder.id} className="grid grid-cols-[38px_minmax(120px,1fr)_36px_36px] items-center gap-2 rounded-xl border border-slate-200 p-2 sm:grid-cols-[38px_minmax(160px,1fr)_190px_36px_36px]"><input type="color" value={draft.color} onChange={event => setFolderDrafts(current => ({ ...current, [folder.id]: { ...draft, color: event.target.value } }))} className="h-9 w-9 rounded-lg border border-slate-200 p-1" /><input value={draft.name} onChange={event => setFolderDrafts(current => ({ ...current, [folder.id]: { ...draft, name: event.target.value } }))} className="min-w-0 rounded-lg border border-slate-200 px-2.5 py-2 text-sm font-semibold" /><select value={draft.workflow_id} onChange={event => setFolderDrafts(current => ({ ...current, [folder.id]: { ...draft, workflow_id: event.target.value } }))} className="col-span-2 rounded-lg border border-slate-200 px-2 py-2 text-xs sm:col-span-1"><option value="">Flujo general</option>{workflows.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button disabled={busy || !draft.name.trim()} onClick={() => saveFolder(folder)} className="rounded-lg p-2 text-emerald-600 hover:bg-emerald-50"><Save className="h-4 w-4" /></button><button disabled={busy} onClick={() => archiveFolder(folder)} className="rounded-lg p-2 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 className="h-4 w-4" /></button></div> })}
            <div className="my-3 border-t border-slate-100" />
            {sortedLists.map(list => { const draft = listDrafts[list.id] || { name: list.name, color: list.color, folder_id: list.folder_id || '' }; return <div key={list.id} className="grid grid-cols-[38px_minmax(120px,1fr)_36px_36px] items-center gap-2 rounded-xl bg-slate-50 p-2 sm:grid-cols-[38px_minmax(160px,1fr)_190px_36px_36px]"><input type="color" value={draft.color} onChange={event => setListDrafts(current => ({ ...current, [list.id]: { ...draft, color: event.target.value } }))} className="h-9 w-9 rounded-lg border border-slate-200 p-1" /><input value={draft.name} onChange={event => setListDrafts(current => ({ ...current, [list.id]: { ...draft, name: event.target.value } }))} className="min-w-0 rounded-lg border border-slate-200 px-2.5 py-2 text-sm" /><select disabled={list.is_default} value={draft.folder_id} onChange={event => setListDrafts(current => ({ ...current, [list.id]: { ...draft, folder_id: event.target.value } }))} className="col-span-2 rounded-lg border border-slate-200 px-2 py-2 text-xs disabled:bg-slate-100 disabled:text-slate-400 sm:col-span-1"><option value="">{list.is_default ? 'Lista predeterminada' : 'Sin carpeta'}</option>{folders.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button disabled={busy || !draft.name.trim()} onClick={() => void saveList(list)} className="rounded-lg p-2 text-emerald-600 hover:bg-emerald-50"><Save className="h-4 w-4" /></button>{list.is_default ? <span title="La lista predeterminada no se puede archivar" className="flex items-center justify-center text-[10px] font-bold text-emerald-600">BASE</span> : <button disabled={busy} onClick={() => archiveList(list)} className="rounded-lg p-2 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 className="h-4 w-4" /></button>}</div> })}
          </div></section>
        </div>}

        {tab === 'workflow' && <div className="space-y-5">
          <section className="flex flex-col gap-2 rounded-2xl border border-slate-200 p-4 sm:flex-row"><div className="flex-1"><h3 className="flex items-center gap-2 text-sm font-bold text-slate-800"><Workflow className="h-4 w-4 text-emerald-600" /> Crear flujo</h3><p className="mt-1 text-xs text-slate-400">Se crea con estados inicial, en curso, completada y cancelada.</p></div><input value={workflowName} onChange={event => setWorkflowName(event.target.value)} placeholder="Nombre del flujo" className={`${field} sm:w-56`} /><button disabled={!workflowName.trim() || busy} onClick={createWorkflow} className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-30"><Plus className="mr-1 inline h-4 w-4" />Crear</button></section>
          <section className="rounded-2xl border border-slate-200 p-4"><div className="mb-4 flex flex-col justify-between gap-3 sm:flex-row sm:items-center"><div><h3 className="text-sm font-bold text-slate-800">Estados del flujo</h3><p className="mt-1 text-xs text-slate-400">El tablero usa este orden y estos colores.</p></div><select value={selectedWorkflow} onChange={event => setSelectedWorkflow(event.target.value)} className={`${field} sm:w-56`}>{workflows.map(item => <option key={item.id} value={item.id}>{item.name}{item.is_default ? ' · General' : ''}</option>)}</select></div>
            <div className="space-y-2">{workflow?.statuses.map((original, index) => { const status = drafts[original.id] || original; const previous = workflow.statuses[index - 1]; const next = workflow.statuses[index + 1]; return <div key={original.id} draggable={!busy} onDragStart={event => event.dataTransfer.setData('text/task-status-id', original.id)} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void reorderStatuses(event.dataTransfer.getData('text/task-status-id'), original.id) }} className="grid cursor-grab grid-cols-[38px_minmax(100px,1fr)] items-center gap-2 rounded-xl bg-slate-50 p-2 active:cursor-grabbing sm:grid-cols-[38px_minmax(130px,1fr)_150px_108px_36px]"><input type="color" value={status.color} onChange={event => setDrafts(current => ({ ...current, [status.id]: { ...status, color: event.target.value } }))} className="h-9 w-9 rounded-lg border border-slate-200 p-1" /><input value={status.name} onChange={event => setDrafts(current => ({ ...current, [status.id]: { ...status, name: event.target.value } }))} className="min-w-0 rounded-lg border border-slate-200 px-2.5 py-2 text-sm" /><select value={status.category} disabled={original.is_default} title={original.is_default ? 'El estado inicial predeterminado siempre pertenece a la categoría Inicial' : undefined} onChange={event => setDrafts(current => ({ ...current, [status.id]: { ...status, category: event.target.value as TaskStatusCategory } }))} className="col-span-2 rounded-lg border border-slate-200 px-2 py-2 text-xs disabled:bg-slate-100 disabled:text-slate-500 sm:col-span-1">{categories.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select><div className="col-span-2 flex justify-end gap-0.5 sm:col-span-1"><button type="button" title="Subir estado" aria-label={`Subir ${status.name}`} disabled={busy || !previous} onClick={() => previous && void reorderStatuses(status.id, previous.id)} className="rounded-lg p-2 text-slate-400 hover:bg-white hover:text-slate-700 disabled:opacity-20"><ChevronUp className="h-4 w-4" /></button><button type="button" title="Bajar estado" aria-label={`Bajar ${status.name}`} disabled={busy || !next} onClick={() => next && void reorderStatuses(status.id, next.id)} className="rounded-lg p-2 text-slate-400 hover:bg-white hover:text-slate-700 disabled:opacity-20"><ChevronDown className="h-4 w-4" /></button><button type="button" title="Guardar estado" aria-label={`Guardar ${status.name}`} disabled={busy || !status.name.trim()} onClick={() => saveStatus({ ...status, sort_order: index })} className="rounded-lg p-2 text-emerald-600 hover:bg-emerald-100"><Save className="h-4 w-4" /></button></div><button title={original.is_default ? 'El estado inicial predeterminado no se puede eliminar' : 'Eliminar estado'} disabled={busy || original.is_default || (workflow?.statuses.length || 0) <= 2} onClick={() => deleteStatus(status)} className="rounded-lg p-2 text-slate-400 hover:bg-rose-100 hover:text-rose-600 disabled:opacity-20"><Trash2 className="h-4 w-4" /></button></div> })}</div>
            <div className="mt-3 grid grid-cols-[38px_minmax(100px,1fr)] gap-2 rounded-xl border border-dashed border-slate-300 p-2 sm:grid-cols-[38px_minmax(130px,1fr)_150px_90px]"><input type="color" value={newStatus.color} onChange={event => setNewStatus(current => ({ ...current, color: event.target.value }))} className="h-9 w-9 rounded-lg border border-slate-200 p-1" /><input value={newStatus.name} onChange={event => setNewStatus(current => ({ ...current, name: event.target.value }))} placeholder="Nuevo estado" className="min-w-0 rounded-lg border border-slate-200 px-2.5 py-2 text-sm" /><select value={newStatus.category} onChange={event => setNewStatus(current => ({ ...current, category: event.target.value as TaskStatusCategory }))} className="col-span-2 rounded-lg border border-slate-200 px-2 py-2 text-xs sm:col-span-1">{categories.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select><button disabled={!newStatus.name.trim() || busy || !workflow} onClick={addStatus} className="col-span-2 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-30 sm:col-span-1">Añadir</button></div>
          </section>
        </div>}
      </div>
    </div>
  </div>, document.body)
}
