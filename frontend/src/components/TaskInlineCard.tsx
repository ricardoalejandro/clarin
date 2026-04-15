'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { MoreVertical, Calendar, Clock, Plus, Trash2, Edit2, CheckCircle2, ListTodo, ExternalLink, Star, GripVertical } from 'lucide-react'
import { Task, Subtask, TASK_TYPE_CONFIG, TASK_PRIORITY_CONFIG } from '@/types/task'

interface Props {
  task: Task
  isExpanded: boolean
  onExpand: () => void
  onCollapse: () => void
  onComplete: (taskId: string) => void
  onUpdate: (taskId: string, fields: Record<string, unknown>) => void
  onDelete: (taskId: string) => void
  onOpenFullEdit: (task: Task) => void
  onToggleStar?: (taskId: string) => void
  compact?: boolean
}

function getTimeStatus(dueAt: string): 'overdue' | 'today' | 'tomorrow' | 'future' {
  const due = new Date(dueAt)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const dayAfter = new Date(today)
  dayAfter.setDate(dayAfter.getDate() + 2)
  if (due < now && due < today) return 'overdue'
  if (due >= today && due < tomorrow) return 'today'
  if (due >= tomorrow && due < dayAfter) return 'tomorrow'
  return 'future'
}

function toLocalDate(iso: string) {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function TaskInlineCard({
  task, isExpanded, onExpand, onCollapse, onComplete, onUpdate, onDelete, onOpenFullEdit, onToggleStar, compact
}: Props) {
  const typeConfig = TASK_TYPE_CONFIG[task.type] || TASK_TYPE_CONFIG.reminder
  const priorityConfig = TASK_PRIORITY_CONFIG[task.priority] || TASK_PRIORITY_CONFIG.medium
  const isCompleted = task.status === 'completed' || task.status === 'cancelled'
  const hasDueDate = !!task.due_at
  const timeStatus = isCompleted ? 'future' : (hasDueDate ? getTimeStatus(task.due_at!) : 'future')
  const dueDate = hasDueDate ? new Date(task.due_at!) : null

  // Inline editing state
  const [editTitle, setEditTitle] = useState(task.title)
  const [editDescription, setEditDescription] = useState(task.description || '')
  const [subtasks, setSubtasks] = useState<Subtask[]>([])
  const [newSubtaskTitle, setNewSubtaskTitle] = useState('')
  const [showSubtaskInput, setShowSubtaskInput] = useState(false)
  const [loadingSubtasks, setLoadingSubtasks] = useState(false)
  const [showMenu, setShowMenu] = useState(false)
  const [showDatePicker, setShowDatePicker] = useState(false)
  const [checkHover, setCheckHover] = useState(false)
  const [completing, setCompleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const titleRef = useRef<HTMLInputElement>(null)
  const descRef = useRef<HTMLTextAreaElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Sync state when task prop changes
  useEffect(() => {
    setEditTitle(task.title)
    setEditDescription(task.description || '')
  }, [task.title, task.description])

  // Auto-focus title when expanded
  useEffect(() => {
    if (isExpanded && titleRef.current) {
      titleRef.current.focus()
      titleRef.current.select()
    }
  }, [isExpanded])

  // Fetch subtasks when expanded
  useEffect(() => {
    if (isExpanded) {
      fetchSubtasks()
    }
  }, [isExpanded])

  // Click outside menu
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false)
        setConfirmDelete(false)
      }
    }
    if (showMenu) {
      document.addEventListener('mousedown', handler)
      return () => document.removeEventListener('mousedown', handler)
    }
  }, [showMenu])

  // Click outside card to collapse (Phase 1)
  useEffect(() => {
    if (!isExpanded) return
    const handleClickOutside = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        onCollapse()
      }
    }
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCollapse()
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [isExpanded, onCollapse])

  const fetchSubtasks = async () => {
    setLoadingSubtasks(true)
    try {
      const token = localStorage.getItem('token')
      const res = await fetch(`/api/tasks/${task.id}/subtasks`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) setSubtasks(data.subtasks || [])
    } catch { /* ignore */ }
    setLoadingSubtasks(false)
  }

  const debouncedUpdate = useCallback((fields: Record<string, unknown>) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      onUpdate(task.id, fields)
    }, 600)
  }, [task.id, onUpdate])

  const handleTitleBlur = () => {
    const trimmed = editTitle.trim()
    if (trimmed && trimmed !== task.title) {
      onUpdate(task.id, { title: trimmed })
    } else {
      setEditTitle(task.title)
    }
  }

  const handleTitleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      titleRef.current?.blur()
    }
    if (e.key === 'Escape') {
      setEditTitle(task.title)
      onCollapse()
    }
  }

  const handleDescriptionChange = (val: string) => {
    setEditDescription(val)
    debouncedUpdate({ description: val })
  }

  const parseDateLocal = (dateStr: string, hours: number, minutes: number) => {
    const [y, m, d] = dateStr.split('-').map(Number)
    return new Date(y, m - 1, d, hours, minutes, 0, 0)
  }

  const handleQuickDate = (dateStr: string) => {
    const h = dueDate ? dueDate.getHours() : 9
    const m = dueDate ? dueDate.getMinutes() : 0
    const d = parseDateLocal(dateStr, h, m)
    onUpdate(task.id, { due_at: d.toISOString() })
    setShowDatePicker(false)
  }

  const handleDatePickerChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const h = dueDate ? dueDate.getHours() : 9
    const m = dueDate ? dueDate.getMinutes() : 0
    const d = parseDateLocal(e.target.value, h, m)
    onUpdate(task.id, { due_at: d.toISOString() })
    setShowDatePicker(false)
  }

  // Origin badge helper — smart navigation with auto-select + scroll to tasks
  const getOriginBadge = () => {
    if (task.lead_id) return { icon: '👤', label: task.lead_name || 'Lead', href: `/dashboard/leads?lead_id=${task.lead_id}&scroll=tasks`, color: 'bg-slate-100 text-slate-600 hover:bg-slate-200' }
    if (task.event_id) return { icon: '📅', label: task.event_name || 'Evento', href: `/dashboard/events/${task.event_id}`, color: 'bg-purple-50 text-purple-600 hover:bg-purple-100' }
    if (task.program_id) return { icon: '📚', label: task.program_name || 'Programa', href: `/dashboard/programs/${task.program_id}`, color: 'bg-blue-50 text-blue-600 hover:bg-blue-100' }
    if (task.contact_id) return { icon: '💬', label: task.contact_name || 'Contacto', href: `/dashboard/contacts?contact_id=${task.contact_id}&scroll=tasks`, color: 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100' }
    return null
  }
  const originBadge = getOriginBadge()

  const handleComplete = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (isCompleted) return
    setCompleting(true)
    onComplete(task.id)
    setTimeout(() => setCompleting(false), 400)
  }

  const handleAddSubtask = async () => {
    if (!newSubtaskTitle.trim()) return
    try {
      const token = localStorage.getItem('token')
      const res = await fetch(`/api/tasks/${task.id}/subtasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ title: newSubtaskTitle.trim() }),
      })
      const data = await res.json()
      if (data.success && data.subtask) {
        setSubtasks(prev => [...prev, data.subtask])
        setNewSubtaskTitle('')
      }
    } catch { /* ignore */ }
  }

  const handleToggleSubtask = async (subId: string) => {
    try {
      const token = localStorage.getItem('token')
      const res = await fetch(`/api/tasks/${task.id}/subtasks/${subId}/toggle`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success && data.subtask) {
        setSubtasks(prev => prev.map(s => s.id === subId ? data.subtask : s))
      }
    } catch { /* ignore */ }
  }

  const handleDeleteSubtask = async (subId: string) => {
    try {
      const token = localStorage.getItem('token')
      await fetch(`/api/tasks/${task.id}/subtasks/${subId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      setSubtasks(prev => prev.filter(s => s.id !== subId))
    } catch { /* ignore */ }
  }

  // Quick date helpers
  const todayStr = (() => {
    const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
  })()
  const tomorrowStr = (() => {
    const d = new Date(); d.setDate(d.getDate()+1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
  })()

  const timeBorderColor =
    !hasDueDate ? 'border-l-slate-200' :
    timeStatus === 'overdue' ? 'border-l-red-400' :
    timeStatus === 'today' ? 'border-l-amber-400' :
    timeStatus === 'tomorrow' ? 'border-l-blue-400' :
    'border-l-slate-200'

  const subtaskTotal = subtasks.length || (task.subtask_count || 0)
  const subtaskDone = subtasks.filter(s => s.completed).length || (task.subtask_done || 0)

  return (
    <div
      ref={cardRef}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/task-id', task.id)
        e.dataTransfer.effectAllowed = 'move'
        ;(e.currentTarget as HTMLElement).style.opacity = '0.5'
      }}
      onDragEnd={(e) => {
        ;(e.currentTarget as HTMLElement).style.opacity = ''
      }}
      className={`group relative rounded-xl border border-slate-100 border-l-[3px] ${timeBorderColor} transition-all ${
        isExpanded ? 'shadow-md bg-white ring-1 ring-emerald-100' : 'bg-white hover:shadow-sm'
      } ${isCompleted ? 'opacity-60' : ''} ${completing ? 'scale-[0.98] opacity-70' : ''}`}
      style={{ transition: 'all 0.2s ease' }}
    >
      {/* ── Collapsed row ── */}
      <div
        className={`flex items-start gap-2.5 p-2.5 ${!isExpanded ? 'cursor-pointer' : ''}`}
        onClick={() => {
          if (!isExpanded && !isCompleted) onExpand()
        }}
      >
        {/* Drag handle */}
        <div className="mt-0.5 shrink-0 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity"
          onMouseDown={e => e.stopPropagation()}
        >
          <GripVertical className="w-4 h-4 text-slate-300" />
        </div>

        {/* Checkbox */}
        <button
          onClick={handleComplete}
          onMouseEnter={() => setCheckHover(true)}
          onMouseLeave={() => setCheckHover(false)}
          className="mt-0.5 shrink-0 transition-all duration-200"
          title={isCompleted ? 'Completada' : 'Marcar completada'}
        >
          {isCompleted ? (
            <CheckCircle2 className="w-[18px] h-[18px] text-emerald-500" />
          ) : (
            <div className={`w-[18px] h-[18px] rounded-full border-2 transition-all duration-200 flex items-center justify-center ${
              checkHover
                ? 'border-emerald-500 bg-emerald-50 scale-110'
                : 'border-slate-300'
            }`}>
              {checkHover && (
                <svg className="w-2.5 h-2.5 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
            </div>
          )}
        </button>

        {/* Title + meta */}
        <div className="flex-1 min-w-0">
          {isExpanded ? (
            <input
              ref={titleRef}
              value={editTitle}
              onChange={e => setEditTitle(e.target.value)}
              onBlur={handleTitleBlur}
              onKeyDown={handleTitleKeyDown}
              className="w-full text-sm font-medium text-slate-800 bg-transparent border-0 border-b border-transparent focus:border-emerald-400 outline-none py-0 px-0 transition"
              placeholder="Título de la tarea"
            />
          ) : (
            <div className="flex items-center gap-1.5 mb-0.5">
              <span className="text-sm" title={typeConfig.label}>{typeConfig.icon}</span>
              {onToggleStar && (
                <button
                  onClick={e => { e.stopPropagation(); onToggleStar(task.id) }}
                  className={`shrink-0 transition-all ${task.starred ? 'text-amber-400' : 'text-slate-300 opacity-0 group-hover:opacity-100 hover:text-amber-400'}`}
                  title={task.starred ? 'Quitar destacada' : 'Destacar'}
                >
                  <Star className={`w-3.5 h-3.5 ${task.starred ? 'fill-amber-400' : ''}`} />
                </button>
              )}
              <span className={`text-sm font-medium truncate ${isCompleted ? 'line-through text-slate-400' : 'text-slate-800'}`}>
                {task.title}
              </span>
              {subtaskTotal > 0 && (
                <span className="flex items-center gap-0.5 text-[10px] text-slate-400 ml-1" title={`${subtaskDone}/${subtaskTotal} subtareas`}>
                  <ListTodo className="w-3 h-3" />
                  {subtaskDone}/{subtaskTotal}
                </span>
              )}
            </div>
          )}

          {!isExpanded && (
            <div className="flex items-center gap-2 flex-wrap">
              {dueDate ? (
                <span className={`flex items-center gap-1 text-[11px] ${
                  timeStatus === 'overdue' ? 'text-red-500 font-medium' :
                  timeStatus === 'today' ? 'text-amber-600 font-medium' :
                  'text-slate-400'
                }`}>
                  <Clock className="w-3 h-3" />
                  {timeStatus === 'overdue' ? 'Vencida ' : ''}
                  {timeStatus === 'today' ? 'Hoy ' : ''}
                  {dueDate.toLocaleDateString('es', { day: 'numeric', month: 'short' })}
                  {' '}
                  {dueDate.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}
                </span>
              ) : (
                <span className="flex items-center gap-1 text-[11px] text-slate-400">
                  <Clock className="w-3 h-3" />
                  Sin fecha
                </span>
              )}
              {task.priority !== 'medium' && (
                <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded-full ${priorityConfig.bg} ${priorityConfig.color}`}>
                  {priorityConfig.label}
                </span>
              )}
              {originBadge && (
                <a
                  href={originBadge.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={e => e.stopPropagation()}
                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded-full truncate max-w-[140px] transition ${originBadge.color}`}
                  title={`Ir a ${originBadge.label}`}
                >
                  {originBadge.icon} {originBadge.label}
                  <ExternalLink className="w-2.5 h-2.5 shrink-0 opacity-60" />
                </a>
              )}
              {task.list_name && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-slate-50 text-slate-500 truncate max-w-[120px]" title={task.list_name}>
                  <ListTodo className="w-2.5 h-2.5 shrink-0" /> {task.list_name}
                </span>
              )}
            </div>
          )}
        </div>

        {/* ⋮ Menu button */}
        <div ref={menuRef} className="relative shrink-0">
          <button
            onClick={e => { e.stopPropagation(); setShowMenu(!showMenu); setConfirmDelete(false) }}
            className={`p-1 rounded transition ${showMenu ? 'bg-slate-100 text-slate-600' : 'text-slate-300 hover:text-slate-500 sm:opacity-0 sm:group-hover:opacity-100'}`}
            title="Opciones"
          >
            <MoreVertical className="w-4 h-4" />
          </button>

          {showMenu && (
            <div className="absolute right-0 top-full mt-1 z-50 w-48 bg-white border border-slate-200 rounded-xl shadow-xl py-1 text-sm animate-in fade-in-0 slide-in-from-top-1 duration-150">
              <button
                onMouseDown={e => {
                  e.preventDefault(); e.stopPropagation()
                  setShowMenu(false)
                  setShowDatePicker(true)
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-slate-700 hover:bg-slate-50 transition"
              >
                <Calendar className="w-4 h-4 text-slate-400" />
                Poner fecha límite
              </button>
              <button
                onMouseDown={e => {
                  e.preventDefault(); e.stopPropagation()
                  setShowMenu(false)
                  if (!isExpanded) onExpand()
                  setTimeout(() => setShowSubtaskInput(true), 100)
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-slate-700 hover:bg-slate-50 transition"
              >
                <ListTodo className="w-4 h-4 text-slate-400" />
                Agregar subtarea
              </button>
              <button
                onMouseDown={e => {
                  e.preventDefault(); e.stopPropagation()
                  setShowMenu(false)
                  onOpenFullEdit(task)
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-slate-700 hover:bg-slate-50 transition"
              >
                <Edit2 className="w-4 h-4 text-slate-400" />
                Editar
              </button>
              <div className="border-t border-slate-100 my-1" />
              {confirmDelete ? (
                <button
                  onMouseDown={e => {
                    e.preventDefault(); e.stopPropagation()
                    setShowMenu(false)
                    setConfirmDelete(false)
                    onDelete(task.id)
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-red-600 hover:bg-red-50 transition font-medium"
                >
                  <Trash2 className="w-4 h-4" />
                  ¿Confirmar eliminar?
                </button>
              ) : (
                <button
                  onMouseDown={e => {
                    e.preventDefault(); e.stopPropagation()
                    setConfirmDelete(true)
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-red-500 hover:bg-red-50 transition"
                >
                  <Trash2 className="w-4 h-4" />
                  Eliminar
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Expanded details ── */}
      {isExpanded && (
        <div className="px-2.5 pb-3 space-y-3 border-t border-slate-100 pt-3 ml-[30px]">
          {/* Description */}
          <textarea
            ref={descRef}
            value={editDescription}
            onChange={e => handleDescriptionChange(e.target.value)}
            placeholder="Añadir descripción..."
            rows={2}
            className="w-full text-sm text-slate-700 bg-slate-50/50 border border-transparent focus:border-slate-200 rounded-lg px-3 py-2 resize-none outline-none transition placeholder:text-slate-400"
          />

          {/* Quick date bar */}
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-slate-400 font-medium">Fecha:</span>
            <button
              onClick={() => handleQuickDate(todayStr)}
              className={`px-2.5 py-1 text-xs rounded-lg font-medium transition ${
                hasDueDate && toLocalDate(task.due_at!) === todayStr
                  ? 'bg-amber-100 text-amber-700 ring-1 ring-amber-300'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              Hoy
            </button>
            <button
              onClick={() => handleQuickDate(tomorrowStr)}
              className={`px-2.5 py-1 text-xs rounded-lg font-medium transition ${
                hasDueDate && toLocalDate(task.due_at!) === tomorrowStr
                  ? 'bg-blue-100 text-blue-700 ring-1 ring-blue-300'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              Mañana
            </button>
            <div className="relative">
              <button
                onClick={() => setShowDatePicker(!showDatePicker)}
                className="p-1.5 bg-slate-100 text-slate-500 hover:bg-slate-200 rounded-lg transition"
                title="Elegir fecha"
              >
                <Calendar className="w-3.5 h-3.5" />
              </button>
              {showDatePicker && (
                <div className="absolute left-0 top-full mt-1 z-50 bg-white border border-slate-200 rounded-xl shadow-lg p-2">
                  <input
                    type="date"
                    value={hasDueDate ? toLocalDate(task.due_at!) : ''}
                    onChange={handleDatePickerChange}
                    className="px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500"
                    autoFocus
                    onBlur={() => setTimeout(() => setShowDatePicker(false), 200)}
                  />
                </div>
              )}
            </div>
            <span className="text-[11px] text-slate-400 ml-auto">
              {dueDate
                ? <>{dueDate.toLocaleDateString('es', { weekday: 'short', day: 'numeric', month: 'short' })} {dueDate.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}</>
                : 'Sin fecha asignada'
              }
            </span>
          </div>

          {/* Origin badge (expanded) */}
          {originBadge && (
            <a
              href={originBadge.href}
              target="_blank"
              rel="noopener noreferrer"
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg transition ${originBadge.color}`}
              title={`Ir a ${originBadge.label}`}
            >
              {originBadge.icon} {originBadge.label}
              <ExternalLink className="w-3 h-3 opacity-60" />
            </a>
          )}

          {/* Subtasks */}
          <div>
            {loadingSubtasks ? (
              <div className="flex items-center gap-2 py-1">
                <div className="animate-spin rounded-full h-3.5 w-3.5 border-2 border-emerald-200 border-t-emerald-600" />
                <span className="text-xs text-slate-400">Cargando subtareas...</span>
              </div>
            ) : (
              <>
                {subtasks.length > 0 && (
                  <div className="space-y-1 mb-2">
                    {subtasks.map(sub => (
                      <div key={sub.id} className="group/sub flex items-center gap-2 py-1 px-1 rounded-lg hover:bg-slate-50 transition">
                        <button
                          onClick={() => handleToggleSubtask(sub.id)}
                          className="shrink-0"
                        >
                          {sub.completed ? (
                            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                          ) : (
                            <div className="w-4 h-4 rounded-full border-[1.5px] border-slate-300 hover:border-emerald-500 hover:bg-emerald-50 transition" />
                          )}
                        </button>
                        <span className={`flex-1 text-sm ${sub.completed ? 'line-through text-slate-400' : 'text-slate-700'}`}>
                          {sub.title}
                        </span>
                        <button
                          onClick={() => handleDeleteSubtask(sub.id)}
                          className="p-0.5 text-slate-300 hover:text-red-500 opacity-0 group-hover/sub:opacity-100 transition"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Add subtask input */}
                {(showSubtaskInput || subtasks.length > 0) && (
                  <div className="flex items-center gap-2">
                    <Plus className="w-4 h-4 text-slate-300 shrink-0" />
                    <input
                      type="text"
                      value={newSubtaskTitle}
                      onChange={e => setNewSubtaskTitle(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && newSubtaskTitle.trim()) {
                          e.preventDefault()
                          handleAddSubtask()
                        }
                        if (e.key === 'Escape') {
                          setNewSubtaskTitle('')
                          setShowSubtaskInput(false)
                        }
                      }}
                      placeholder="Agregar subtarea..."
                      className="flex-1 text-sm text-slate-700 bg-transparent border-0 border-b border-slate-200 focus:border-emerald-400 outline-none py-1 px-0 transition placeholder:text-slate-400"
                      autoFocus={showSubtaskInput}
                    />
                  </div>
                )}

                {!showSubtaskInput && subtasks.length === 0 && (
                  <button
                    onClick={() => setShowSubtaskInput(true)}
                    className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-emerald-600 transition py-1"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Agregar subtarea
                  </button>
                )}
              </>
            )}
          </div>

          {/* Collapse button */}
          <div className="flex justify-end pt-1">
            <button
              onClick={onCollapse}
              className="text-xs text-slate-400 hover:text-slate-600 transition px-2 py-1"
            >
              Cerrar
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
