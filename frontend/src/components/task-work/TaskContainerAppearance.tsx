'use client'

import { useEffect, useState, type ComponentType } from 'react'
import { createPortal } from 'react-dom'
import {
  Bell, Briefcase, Building2, CalendarDays, CheckSquare2, ClipboardList,
  Flag, Folder, GraduationCap, Inbox, Layers3, ListTodo, Megaphone,
  MessageCircle, Phone, Rocket, Target, Users, X,
} from 'lucide-react'
import { apiDelete, apiPut } from '@/lib/api'
import type { TaskFolder, TaskList } from '@/types/task'

export const TASK_CONTAINER_COLORS = ['#10b981', '#14b8a6', '#3b82f6', '#6366f1', '#8b5cf6', '#d946ef', '#f59e0b', '#f97316', '#ef4444', '#64748b']

export const TASK_CONTAINER_ICONS: Array<{ value: string; label: string; icon: ComponentType<{ className?: string }> }> = [
  { value: 'inbox', label: 'Bandeja', icon: Inbox },
  { value: 'list', label: 'Lista', icon: ListTodo },
  { value: 'folder', label: 'Carpeta', icon: Folder },
  { value: 'briefcase', label: 'Trabajo', icon: Briefcase },
  { value: 'rocket', label: 'Lanzamiento', icon: Rocket },
  { value: 'target', label: 'Objetivo', icon: Target },
  { value: 'users', label: 'Equipo', icon: Users },
  { value: 'megaphone', label: 'Campaña', icon: Megaphone },
  { value: 'graduation-cap', label: 'Formación', icon: GraduationCap },
  { value: 'building', label: 'Organización', icon: Building2 },
  { value: 'clipboard-list', label: 'Procesos', icon: ClipboardList },
  { value: 'layers', label: 'Proyecto', icon: Layers3 },
  { value: 'calendar', label: 'Calendario', icon: CalendarDays },
  { value: 'flag', label: 'Prioridad', icon: Flag },
  { value: 'phone', label: 'Llamadas', icon: Phone },
  { value: 'message-circle', label: 'Mensajes', icon: MessageCircle },
  { value: 'bell', label: 'Recordatorios', icon: Bell },
  { value: 'check-square', label: 'Checklist', icon: CheckSquare2 },
]

const iconByValue = new Map(TASK_CONTAINER_ICONS.map(item => [item.value, item.icon]))

export function TaskContainerIcon({ value, className = 'h-4 w-4' }: { value?: string; className?: string }) {
  const Icon = iconByValue.get(value || '') || ListTodo
  return <Icon className={className} />
}

export function TaskAppearanceDialog({ item, type, onClose, onSaved, onError, onOperation }: {
  item: TaskList | TaskFolder
  type: 'list' | 'folder'
  onClose: () => void
  onSaved: () => Promise<void> | void
  onError: (message: string) => void
  onOperation?: (operationID: string, active: boolean) => void
}) {
  const [name, setName] = useState(item.name)
  const [color, setColor] = useState(item.color || '#10b981')
  const isDefault = 'is_default' in item && Boolean(item.is_default)
  const [icon, setIcon] = useState(item.icon || (type === 'folder' ? 'folder' : isDefault ? 'inbox' : 'list'))
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    const close = (event: KeyboardEvent) => event.key === 'Escape' && !saving && onClose()
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [onClose, saving])
  if (typeof document === 'undefined') return null
  const save = async () => {
    if (!name.trim()) return
    const operationID = crypto.randomUUID()
    setSaving(true)
    onOperation?.(operationID, true)
    try {
      const path = type === 'folder' ? `/api/tasks/folders/${item.id}` : `/api/tasks/lists/${item.id}/structure`
      const result = await apiPut(path, { name: name.trim(), color, icon, operation_id: operationID })
      if (!result.success) {
        onError(result.error || `No se pudo actualizar ${type === 'folder' ? 'la carpeta' : 'la lista'}.`)
        return
      }
      await onSaved()
      onClose()
    } catch {
      onError(`No se pudo actualizar ${type === 'folder' ? 'la carpeta' : 'la lista'}.`)
    } finally {
      onOperation?.(operationID, false)
      setSaving(false)
    }
  }
  const archive = async () => {
    if (isDefault || item.task_count > 0 || saving) return
    if (!window.confirm(`¿Archivar ${type === 'folder' ? 'la carpeta' : 'la lista'} vacía “${item.name}”?`)) return
    setSaving(true)
    try {
      const path = type === 'folder' ? `/api/tasks/folders/${item.id}` : `/api/tasks/lists/${item.id}`
      const result = await apiDelete(path)
      if (!result.success) { onError(result.error || 'No se pudo archivar.'); return }
      await onSaved(); onClose()
    } catch { onError('No se pudo archivar.') } finally { setSaving(false) }
  }
  return createPortal(<div className="fixed inset-0 z-[130] flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-sm" role="presentation" onMouseDown={event => event.target === event.currentTarget && !saving && onClose()}>
    <section role="dialog" aria-modal="true" aria-labelledby="task-appearance-title" className="w-full max-w-lg overflow-hidden rounded-3xl border border-white/70 bg-white shadow-2xl">
      <header className="flex items-center border-b border-slate-100 px-5 py-4"><div className="flex h-10 w-10 items-center justify-center rounded-2xl" style={{ color, backgroundColor: `${color}18` }}><TaskContainerIcon value={icon} className="h-5 w-5" /></div><div className="ml-3 min-w-0 flex-1"><h2 id="task-appearance-title" className="text-base font-black text-slate-900">Personalizar {type === 'folder' ? 'carpeta' : 'lista'}</h2><p className="text-xs text-slate-400">Nombre, color e icono visibles en todo Clarin Work.</p></div><button type="button" disabled={saving} onClick={onClose} className="rounded-xl p-2 text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button></header>
      <div className="space-y-5 p-5">
        <label className="block text-xs font-bold text-slate-600">Nombre<input autoFocus value={name} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void save() }} maxLength={120} className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-semibold text-slate-800 outline-none focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100" /></label>
        <fieldset><legend className="text-xs font-bold text-slate-600">Color</legend><div className="mt-2 flex flex-wrap gap-2">{TASK_CONTAINER_COLORS.map(value => <button key={value} type="button" aria-label={`Color ${value}`} aria-pressed={color === value} onClick={() => setColor(value)} className={`h-9 w-9 rounded-xl border-4 transition ${color === value ? 'scale-110 border-slate-900 shadow-lg' : 'border-white shadow-sm ring-1 ring-slate-200 hover:scale-105'}`} style={{ backgroundColor: value }} />)}</div></fieldset>
        <fieldset><legend className="text-xs font-bold text-slate-600">Icono</legend><div className="mt-2 grid grid-cols-6 gap-2 sm:grid-cols-9">{TASK_CONTAINER_ICONS.map(option => <button key={option.value} type="button" title={option.label} aria-label={option.label} aria-pressed={icon === option.value} onClick={() => setIcon(option.value)} className={`flex h-10 items-center justify-center rounded-xl border transition ${icon === option.value ? 'border-emerald-400 bg-emerald-50 text-emerald-700 ring-2 ring-emerald-100' : 'border-slate-200 text-slate-500 hover:border-slate-300 hover:bg-slate-50'}`}><option.icon className="h-4 w-4" /></button>)}</div></fieldset>
      </div>
      <footer className="flex items-center gap-2 border-t border-slate-100 bg-slate-50/70 px-5 py-4">{!isDefault && <button type="button" disabled={saving || item.task_count > 0} title={item.task_count > 0 ? 'Mueve o archiva primero las tareas activas' : 'Archivar contenedor vacío'} onClick={() => void archive()} className="mr-auto rounded-xl px-3 py-2 text-sm font-semibold text-rose-600 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-30">Archivar</button>}<button type="button" disabled={saving} onClick={onClose} className="rounded-xl px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-white">Cancelar</button><button type="button" disabled={saving || !name.trim()} onClick={() => void save()} className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-lg disabled:opacity-40">{saving ? 'Guardando…' : 'Guardar cambios'}</button></footer>
    </section>
  </div>, document.body)
}
