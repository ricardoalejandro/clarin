'use client'

import { useState, useEffect, useRef } from 'react'
import { X, Calendar, Clock, AlertCircle, Search, User, List } from 'lucide-react'
import { Task, TaskType, TaskPriority, TaskList, TASK_TYPE_CONFIG, TASK_PRIORITY_CONFIG, REMINDER_OPTIONS } from '@/types/task'

interface User {
  id: string
  display_name: string
  username: string
}

interface Props {
  isOpen: boolean
  onClose: () => void
  onSave: (task: Task) => void
  task?: Task | null
  leadId?: string
  leadName?: string
  eventId?: string
  eventName?: string
  programId?: string
  programName?: string
  contactId?: string
  contactName?: string
  listId?: string
  taskLists?: TaskList[]
}

export default function TaskFormModal({ isOpen, onClose, onSave, task, leadId, leadName, eventId, eventName, programId, programName, contactId, contactName, listId, taskLists }: Props) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [type, setType] = useState<TaskType>('reminder')
  const [dueDate, setDueDate] = useState('')
  const [dueTime, setDueTime] = useState('09:00')
  const [priority, setPriority] = useState<TaskPriority>('medium')
  const [assignedTo, setAssignedTo] = useState('')
  const [reminderMinutes, setReminderMinutes] = useState(0)
  const [selectedListId, setSelectedListId] = useState('')
  const [saving, setSaving] = useState(false)
  const [users, setUsers] = useState<User[]>([])
  const [currentUserId, setCurrentUserId] = useState('')
  const [userSearch, setUserSearch] = useState('')
  const [showUserDropdown, setShowUserDropdown] = useState(false)
  const userDropdownRef = useRef<HTMLDivElement>(null)

  // Close user dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (userDropdownRef.current && !userDropdownRef.current.contains(e.target as Node)) {
        setShowUserDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Close modal on Escape key
  useEffect(() => {
    if (!isOpen) return
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', handleEsc)
    return () => document.removeEventListener('keydown', handleEsc)
  }, [isOpen, onClose])

  useEffect(() => {
    if (isOpen) {
      fetchUsers()
      if (task) {
        setTitle(task.title)
        setDescription(task.description || '')
        setType(task.type)
        if (task.due_at) {
          const d = new Date(task.due_at)
          setDueDate(d.toISOString().split('T')[0])
          setDueTime(d.toTimeString().slice(0, 5))
        } else {
          setDueDate('')
          setDueTime('09:00')
        }
        setPriority(task.priority)
        setAssignedTo(task.assigned_to)
        setReminderMinutes(task.reminder_minutes || 0)
        setSelectedListId(task.list_id || '')
      } else {
        setTitle('')
        setDescription('')
        setType('reminder')
        setDueDate('')
        setDueTime('09:00')
        setPriority('medium')
        setAssignedTo('')
        setReminderMinutes(15)
        setSelectedListId(listId || '')
      }
    }
  }, [isOpen, task])

  const fetchUsers = async () => {
    try {
      const token = localStorage.getItem('token')
      // Fetch current user ID
      const meRes = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } })
      const meData = await meRes.json()
      const myId = meData.success ? meData.user?.id || '' : ''
      setCurrentUserId(myId)

      // Fetch all account users
      const res = await fetch('/api/account/users', { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      if (data.success && data.users) {
        setUsers(data.users)
        // Auto-assign to current user for new tasks
        if (!task) {
          setAssignedTo(myId)
        }
      }
    } catch { /* ignore */ }
  }

  const handleSubmit = async () => {
    if (!title.trim()) return
    setSaving(true)
    try {
      const token = localStorage.getItem('token')

      const body: Record<string, unknown> = {
        title: title.trim(),
        description,
        type,
        priority,
        assigned_to: assignedTo || undefined,
        reminder_minutes: reminderMinutes || undefined,
        list_id: selectedListId || '',
      }

      // Only set due_at if a date was selected
      if (dueDate) {
        body.due_at = new Date(`${dueDate}T${dueTime}:00`).toISOString()
      }

      // Link context
      if (leadId) body.lead_id = leadId
      if (eventId) body.event_id = eventId
      if (programId) body.program_id = programId
      if (contactId) body.contact_id = contactId

      const url = task ? `/api/tasks/${task.id}` : '/api/tasks'
      const method = task ? 'PUT' : 'POST'

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (data.success && data.task) {
        onSave(data.task)
        onClose()
      }
    } catch (err) {
      console.error('Failed to save task:', err)
    } finally {
      setSaving(false)
    }
  }

  if (!isOpen) return null

  const contextLabel = leadName ? `Lead: ${leadName}` : eventName ? `Evento: ${eventName}` : programName ? `Programa: ${programName}` : contactName ? `Contacto: ${contactName}` : null

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-3 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-bold text-slate-800">
              {task ? 'Editar Tarea' : 'Nueva Tarea'}
            </h2>
            {contextLabel && (
              <span className="px-2.5 py-1 bg-emerald-50 text-emerald-700 text-[11px] font-medium rounded-lg">
                {contextLabel}
              </span>
            )}
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-slate-100 rounded-lg transition">
            <X className="w-5 h-5 text-slate-400" />
          </button>
        </div>

        <div className="px-6 py-4">
          {/* Task type — compact horizontal */}
          <div className="mb-4">
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Tipo</label>
            <div className="grid grid-cols-4 gap-2">
              {(Object.entries(TASK_TYPE_CONFIG) as [TaskType, typeof TASK_TYPE_CONFIG[TaskType]][]).map(([key, cfg]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setType(key)}
                  className={`flex items-center justify-center gap-1.5 p-2 rounded-xl border-2 transition-all text-sm ${
                    type === key
                      ? 'border-emerald-500 bg-emerald-50 shadow-sm'
                      : 'border-slate-200 hover:border-slate-300 bg-white'
                  }`}
                >
                  <span className="text-base">{cfg.icon}</span>
                  <span className={`text-xs font-medium ${type === key ? 'text-emerald-700' : 'text-slate-600'}`}>{cfg.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Title — full width */}
          <div className="mb-4">
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Título *</label>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && title.trim()) handleSubmit() }}
              placeholder="Ej: Llamar para confirmar asistencia"
              className="w-full px-3 py-2 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 text-sm text-slate-800 placeholder:text-slate-400"
              autoFocus
            />
          </div>

          {/* Two-column layout */}
          <div className="grid grid-cols-2 gap-x-5 gap-y-3">
            {/* Left column */}
            <div className="space-y-3">
              {/* Date + Time */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">
                    <Calendar className="w-3 h-3 inline mr-1" />Fecha
                  </label>
                  <input
                    type="date"
                    value={dueDate}
                    onChange={e => setDueDate(e.target.value)}
                    className="w-full px-2.5 py-2 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 text-sm text-slate-800"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">
                    <Clock className="w-3 h-3 inline mr-1" />Hora
                  </label>
                  <input
                    type="time"
                    value={dueTime}
                    onChange={e => setDueTime(e.target.value)}
                    className="w-full px-2.5 py-2 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 text-sm text-slate-800"
                  />
                </div>
              </div>

              {/* Priority */}
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Prioridad</label>
                <div className="flex gap-1.5">
                  {(Object.entries(TASK_PRIORITY_CONFIG) as [TaskPriority, typeof TASK_PRIORITY_CONFIG[TaskPriority]][]).map(([key, cfg]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setPriority(key)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                        priority === key
                          ? `${cfg.bg} ${cfg.color} ring-2 ring-offset-1 ring-current`
                          : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                      }`}
                    >
                      {cfg.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Reminder */}
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">
                  <AlertCircle className="w-3 h-3 inline mr-1" />Recordatorio
                </label>
                <select
                  value={reminderMinutes}
                  onChange={e => setReminderMinutes(Number(e.target.value))}
                  className="w-full px-2.5 py-2 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 text-sm text-slate-800"
                >
                  {REMINDER_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Right column */}
            <div className="space-y-3">
              {/* Assigned to */}
              <div ref={userDropdownRef} className="relative">
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Asignado a</label>
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
                  <input
                    type="text"
                    value={showUserDropdown ? userSearch : (users.find(u => u.id === assignedTo)?.display_name || users.find(u => u.id === assignedTo)?.username || (assignedTo === currentUserId && assignedTo ? 'Yo' : 'Seleccionar...'))}
                    onChange={e => { setUserSearch(e.target.value); setShowUserDropdown(true) }}
                    onFocus={() => { setUserSearch(''); setShowUserDropdown(true) }}
                    placeholder="Buscar usuario..."
                    className="w-full pl-8 pr-3 py-2 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 text-sm text-slate-800 placeholder:text-slate-400"
                  />
                </div>
                {showUserDropdown && (
                  <div className="absolute z-50 mt-1 w-full bg-white border border-slate-200 rounded-xl shadow-lg max-h-40 overflow-y-auto">
                    {users
                      .filter(u => {
                        if (!userSearch) return true
                        const q = userSearch.toLowerCase()
                        return (u.display_name?.toLowerCase().includes(q) || u.username.toLowerCase().includes(q))
                      })
                      .map(u => {
                        const isMe = u.id === currentUserId
                        const isSelected = u.id === assignedTo
                        const initials = (u.display_name || u.username).slice(0, 2).toUpperCase()
                        return (
                          <button
                            key={u.id}
                            type="button"
                            onMouseDown={e => {
                              e.preventDefault()
                              e.stopPropagation()
                              setAssignedTo(u.id)
                              setShowUserDropdown(false)
                              setUserSearch('')
                            }}
                            className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm transition hover:bg-emerald-50 ${
                              isSelected ? 'bg-emerald-50' : ''
                            }`}
                          >
                            <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold shrink-0 ${
                              isSelected ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-600'
                            }`}>
                              {initials}
                            </div>
                            <span className="font-medium text-slate-800 truncate flex-1">
                              {u.display_name || u.username}{isMe ? ' (Yo)' : ''}
                            </span>
                            {isSelected && <span className="text-emerald-600 text-xs">✓</span>}
                          </button>
                        )
                      })}
                    {users.filter(u => {
                      if (!userSearch) return true
                      const q = userSearch.toLowerCase()
                      return (u.display_name?.toLowerCase().includes(q) || u.username.toLowerCase().includes(q))
                    }).length === 0 && (
                      <div className="px-3 py-2 text-sm text-slate-400 text-center">Sin resultados</div>
                    )}
                  </div>
                )}
              </div>

              {/* List */}
              {taskLists && taskLists.length > 0 && (
                <div>
                  <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">
                    <List className="w-3 h-3 inline mr-1" />Lista
                  </label>
                  <select
                    value={selectedListId}
                    onChange={e => setSelectedListId(e.target.value)}
                    className="w-full px-2.5 py-2 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 text-sm text-slate-800"
                  >
                    <option value="">Sin lista</option>
                    {taskLists.map(l => (
                      <option key={l.id} value={l.id}>{l.name}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Description */}
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Descripción</label>
                <textarea
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder="Detalles opcionales..."
                  rows={3}
                  className="w-full px-2.5 py-2 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 text-sm text-slate-800 placeholder:text-slate-400 resize-none"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-3 border-t border-slate-100 bg-slate-50 rounded-b-2xl">
          <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-200 rounded-xl transition">
            Cancelar
          </button>
          <button
            onClick={handleSubmit}
            disabled={!title.trim() || saving}
            className="px-5 py-2 bg-emerald-600 text-white text-sm font-medium rounded-xl hover:bg-emerald-700 disabled:opacity-50 transition shadow-sm"
          >
            {saving ? (
              <div className="flex items-center gap-2">
                <div className="animate-spin rounded-full h-4 w-4 border-2 border-white/30 border-t-white" />
                Guardando...
              </div>
            ) : task ? 'Guardar Cambios' : 'Crear Tarea'}
          </button>
        </div>
      </div>
    </div>
  )
}
