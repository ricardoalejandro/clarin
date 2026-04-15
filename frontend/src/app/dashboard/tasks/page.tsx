'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { Plus, ListTodo, CalendarDays, ChevronLeft, ChevronRight, Search, CheckCircle2, MoreHorizontal, Pencil, Trash2, List, X, Star, ChevronDown, Columns3, GripVertical, PanelLeftClose, PanelLeftOpen, ArrowUpDown } from 'lucide-react'
import dynamic from 'next/dynamic'
import { subscribeWebSocket } from '@/lib/api'
import { useKanbanPan } from '@/lib/useKanbanPan'
import { Task, TaskType, TaskList as TaskListType, TASK_TYPE_CONFIG } from '@/types/task'
import TaskFormModal from '@/components/TaskFormModal'
import TaskListComponent from '@/components/TaskList'
import TaskInlineCard from '@/components/TaskInlineCard'
const TaskColumnsView = dynamic(() => import('@/components/TaskColumnsView'), { ssr: false })

type ViewMode = 'list' | 'calendar' | 'columns'

interface AccountUser {
  id: string
  display_name: string
  username: string
  role: string
}

const viewBtn = (active: boolean) =>
  `flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition ${active ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`

function ViewToggle({ view, setView }: { view: ViewMode; setView: (v: ViewMode) => void }) {
  return (
    <div className="flex bg-slate-100 rounded-lg p-0.5">
      <button onClick={() => setView('list')} className={viewBtn(view === 'list')}>
        <ListTodo className="w-3.5 h-3.5" /> Lista
      </button>
      <button onClick={() => setView('calendar')} className={viewBtn(view === 'calendar')}>
        <CalendarDays className="w-3.5 h-3.5" /> Calendario
      </button>
      <button onClick={() => setView('columns')} className={viewBtn(view === 'columns')}>
        <Columns3 className="w-3.5 h-3.5" /> Columnas
      </button>
    </div>
  )
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [calendarTasks, setCalendarTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(true)
  const [view, setView] = useState<ViewMode>('list')
  const [showModal, setShowModal] = useState(false)
  const [editTask, setEditTask] = useState<Task | null>(null)
  const [search, setSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState<string>('')
  const [filterType, setFilterType] = useState<string>('')
  const [filterAssigned, setFilterAssigned] = useState<string>('')
  const [accountUsers, setAccountUsers] = useState<AccountUser[]>([])
  const offsetRef = useRef(0)
  const taskListScrollRef = useRef<HTMLDivElement>(null)
  const [calendarDate, setCalendarDate] = useState(new Date())
  const [stats, setStats] = useState({ pending: 0, completed: 0, overdue: 0, today: 0 })
  // Calendar popover state
  const [calPopoverTask, setCalPopoverTask] = useState<Task | null>(null)
  const [calPopoverPos, setCalPopoverPos] = useState<{ top: number; left: number } | null>(null)
  const calPopoverRef = useRef<HTMLDivElement>(null)

  // Task Lists state
  const [taskLists, setTaskLists] = useState<TaskListType[]>([])
  const [activeListId, setActiveListId] = useState<string>('') // '' = all, 'none' = no list, uuid = specific list
  const [newListName, setNewListName] = useState('')
  const [showNewListInput, setShowNewListInput] = useState(false)
  const [editingListId, setEditingListId] = useState<string | null>(null)
  const [editingListName, setEditingListName] = useState('')
  const [listMenuId, setListMenuId] = useState<string | null>(null)
  const listMenuRef = useRef<HTMLDivElement>(null)

  // Kanban pan for columns view
  const kanbanRef = useRef<HTMLDivElement>(null)
  useKanbanPan(kanbanRef)

  // Sidebar collapse state
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('tasks_sidebar_collapsed') === 'true'
    }
    return false
  })

  // DnD sidebar lists
  const [dragListId, setDragListId] = useState<string | null>(null)
  const [dragOverListId, setDragOverListId] = useState<string | null>(null)
  const [dragTaskOverListId, setDragTaskOverListId] = useState<string | null>(null)

  // Column order modal
  const [showColumnOrderModal, setShowColumnOrderModal] = useState(false)
  const [modalListOrder, setModalListOrder] = useState<TaskListType[]>([])
  const [modalDragIdx, setModalDragIdx] = useState<number | null>(null)
  const [modalDragOverIdx, setModalDragOverIdx] = useState<number | null>(null)

  // Starred filter
  const [starredFilter, setStarredFilter] = useState(false)
  // Inline creation
  const [inlineTitle, setInlineTitle] = useState('')
  const [inlineCreating, setInlineCreating] = useState(false)
  // Collapsible completed
  const [showCompleted, setShowCompleted] = useState(false)
  // All tasks (unfiltered) for columns view
  const [allTasks, setAllTasks] = useState<Task[]>([])

  const limit = 50

  const fetchTasks = useCallback(async (reset: boolean = true) => {
    if (!reset && !hasMore) return
    if (reset) { setLoading(true); offsetRef.current = 0 }
    else setLoadingMore(true)
    try {
      const token = localStorage.getItem('token')
      const params = new URLSearchParams({ limit: String(limit), offset: String(offsetRef.current) })
      if (filterStatus) params.set('status', filterStatus)
      if (filterType) params.set('type', filterType)
      if (filterAssigned) params.set('assigned_to', filterAssigned)
      if (search) params.set('search', search)
      if (activeListId) params.set('list_id', activeListId)
      if (starredFilter) params.set('starred', 'true')

      const res = await fetch(`/api/tasks?${params}`, { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      if (data.success) {
        const newTasks: Task[] = data.tasks || []
        if (reset) {
          setTasks(newTasks)
        } else {
          setTasks(prev => {
            const ids = new Set(prev.map(t => t.id))
            return [...prev, ...newTasks.filter(t => !ids.has(t.id))]
          })
        }
        const serverTotal = data.total || 0
        setTotal(serverTotal)
        offsetRef.current += newTasks.length
        setHasMore(offsetRef.current < serverTotal)
      }
    } catch (err) {
      console.error('Failed to fetch tasks:', err)
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [filterStatus, filterType, filterAssigned, search, activeListId, starredFilter, hasMore])

  const fetchCalendarTasks = useCallback(async () => {
    try {
      const token = localStorage.getItem('token')
      const year = calendarDate.getFullYear()
      const month = calendarDate.getMonth()
      const from = new Date(year, month, 1).toISOString().split('T')[0]
      const to = new Date(year, month + 1, 0).toISOString().split('T')[0]

      const res = await fetch(`/api/tasks/calendar?from=${from}&to=${to}`, { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      if (data.success) setCalendarTasks(data.tasks || [])
    } catch { /* ignore */ }
  }, [calendarDate])

  const fetchStats = useCallback(async () => {
    try {
      const token = localStorage.getItem('token')
      const res = await fetch('/api/tasks/stats', { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      if (data.success) setStats(data.stats)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { fetchTasks() }, [fetchTasks])
  useEffect(() => { if (view === 'calendar') fetchCalendarTasks() }, [view, fetchCalendarTasks])
  useEffect(() => { fetchStats() }, [fetchStats])

  // Infinite scroll for list view
  useEffect(() => {
    if (view !== 'list' || !hasMore || loadingMore || loading) return
    const el = taskListScrollRef.current
    if (!el) return
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = el
      if (scrollHeight - scrollTop - clientHeight < 300) {
        fetchTasks(false)
      }
    }
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [view, hasMore, loadingMore, loading, fetchTasks])

  // Fetch all tasks for columns view (unfiltered, high limit)
  const fetchAllTasks = useCallback(async () => {
    try {
      const token = localStorage.getItem('token')
      const res = await fetch('/api/tasks?limit=500&offset=0', { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      if (data.success) setAllTasks(data.tasks || [])
    } catch { /* ignore */ }
  }, [])
  useEffect(() => { if (view === 'columns') fetchAllTasks() }, [view, fetchAllTasks])

  // Fetch task lists
  const fetchTaskLists = useCallback(async () => {
    try {
      const token = localStorage.getItem('token')
      const res = await fetch('/api/tasks/lists', { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      if (data.success) setTaskLists(data.lists || [])
    } catch { /* ignore */ }
  }, [])
  useEffect(() => { fetchTaskLists() }, [fetchTaskLists])

  // Fetch account users for filter
  useEffect(() => {
    const fetchAccountUsers = async () => {
      try {
        const token = localStorage.getItem('token')
        const res = await fetch('/api/account/users', { headers: { Authorization: `Bearer ${token}` } })
        const data = await res.json()
        if (data.success) setAccountUsers(data.users || [])
      } catch { /* ignore */ }
    }
    fetchAccountUsers()
  }, [])

  // WebSocket listener for task updates
  useEffect(() => {
    const unsub = subscribeWebSocket((data: unknown) => {
      const msg = data as { event?: string }
      if (msg.event === 'task_update' || msg.event === 'task_overdue') {
        fetchTasks()
        fetchStats()
        fetchTaskLists()
        if (view === 'calendar') fetchCalendarTasks()
        if (view === 'columns') fetchAllTasks()
      }
    })
    return () => unsub()
  }, [fetchTasks, fetchStats, fetchCalendarTasks, fetchAllTasks, fetchTaskLists, view])

  // Close calendar popover on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (calPopoverRef.current && !calPopoverRef.current.contains(e.target as Node)) {
        setCalPopoverTask(null)
        setCalPopoverPos(null)
      }
    }
    if (calPopoverTask) {
      document.addEventListener('mousedown', handler)
      return () => document.removeEventListener('mousedown', handler)
    }
  }, [calPopoverTask])

  // Close list menu on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (listMenuRef.current && !listMenuRef.current.contains(e.target as Node)) {
        setListMenuId(null)
      }
    }
    if (listMenuId) {
      document.addEventListener('mousedown', handler)
      return () => document.removeEventListener('mousedown', handler)
    }
  }, [listMenuId])

  // Task List CRUD
  const handleCreateList = async () => {
    if (!newListName.trim()) return
    try {
      const token = localStorage.getItem('token')
      const res = await fetch('/api/tasks/lists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: newListName.trim() }),
      })
      const data = await res.json()
      if (data.success) {
        setNewListName('')
        setShowNewListInput(false)
        fetchTaskLists()
      }
    } catch { /* ignore */ }
  }

  const handleRenameList = async (listId: string) => {
    if (!editingListName.trim()) return
    try {
      const token = localStorage.getItem('token')
      await fetch(`/api/tasks/lists/${listId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: editingListName.trim() }),
      })
      setEditingListId(null)
      setEditingListName('')
      fetchTaskLists()
    } catch { /* ignore */ }
  }

  const handleDeleteList = async (listId: string) => {
    try {
      const token = localStorage.getItem('token')
      await fetch(`/api/tasks/lists/${listId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (activeListId === listId) setActiveListId('')
      setListMenuId(null)
      fetchTaskLists()
      fetchTasks()
    } catch { /* ignore */ }
  }

  const handleComplete = async (taskId: string) => {
    try {
      const token = localStorage.getItem('token')
      await fetch(`/api/tasks/${taskId}/complete`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      fetchTasks()
      fetchStats()
      if (view === 'calendar') fetchCalendarTasks()
      if (view === 'columns') fetchAllTasks()
    } catch { /* ignore */ }
  }

  const handleToggleStar = async (taskId: string) => {
    try {
      const token = localStorage.getItem('token')
      const res = await fetch(`/api/tasks/${taskId}/star`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, starred: data.starred } : t))
        setCalendarTasks(prev => prev.map(t => t.id === taskId ? { ...t, starred: data.starred } : t))
        if (calPopoverTask?.id === taskId) setCalPopoverTask(prev => prev ? { ...prev, starred: data.starred } : null)
      }
    } catch { /* ignore */ }
  }

  const handleInlineCreate = async () => {
    if (!inlineTitle.trim() || inlineCreating) return
    setInlineCreating(true)
    try {
      const token = localStorage.getItem('token')
      const body: Record<string, unknown> = { title: inlineTitle.trim(), type: 'reminder' }
      if (activeListId && activeListId !== 'none') body.list_id = activeListId
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (data.success) {
        setInlineTitle('')
        fetchTasks()
        fetchStats()
        fetchTaskLists()
      }
    } catch { /* ignore */ }
    finally { setInlineCreating(false) }
  }

  // Column view: create task in a specific list
  const handleColumnInlineCreate = async (title: string, listId: string | null) => {
    try {
      const token = localStorage.getItem('token')
      const body: Record<string, unknown> = { title, type: 'reminder' }
      if (listId) body.list_id = listId
      await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      })
      fetchAllTasks()
      fetchStats()
      fetchTaskLists()
    } catch { /* ignore */ }
  }

  // Column view: move task to a different list
  const handleMoveToList = async (taskId: string, listId: string | null) => {
    try {
      const token = localStorage.getItem('token')
      await fetch(`/api/tasks/${taskId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ list_id: listId || '' }),
      })
      fetchAllTasks()
      fetchTaskLists()
    } catch { /* ignore */ }
  }

  // Column view: reorder tasks
  const handleReorderTasks = async (taskIds: string[]) => {
    try {
      const token = localStorage.getItem('token')
      await fetch('/api/tasks/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ task_ids: taskIds }),
      })
      fetchAllTasks()
    } catch { /* ignore */ }
  }

  // Sidebar list reorder via DnD
  const handleReorderLists = async (newOrder: string[]) => {
    try {
      const token = localStorage.getItem('token')
      await fetch('/api/tasks/lists/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ list_ids: newOrder }),
      })
      fetchTaskLists()
    } catch { /* ignore */ }
  }

  const handleDelete = async (taskId: string) => {
    try {
      const token = localStorage.getItem('token')
      await fetch(`/api/tasks/${taskId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      fetchTasks()
      fetchStats()
      if (view === 'calendar') fetchCalendarTasks()
      if (view === 'columns') fetchAllTasks()
      // Close popover if this task was open
      if (calPopoverTask?.id === taskId) {
        setCalPopoverTask(null)
        setCalPopoverPos(null)
      }
    } catch { /* ignore */ }
  }

  const handleInlineUpdate = async (taskId: string, fields: Record<string, unknown>) => {
    try {
      const token = localStorage.getItem('token')
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(fields),
      })
      const data = await res.json()
      if (data.success && data.task) {
        // Update local state to avoid full refetch
        setTasks(prev => prev.map(t => t.id === taskId ? data.task : t))
        setCalendarTasks(prev => prev.map(t => t.id === taskId ? data.task : t))
        if (calPopoverTask?.id === taskId) setCalPopoverTask(data.task)
      }
    } catch { /* ignore */ }
  }

  const handleSave = () => {
    setShowModal(false)
    setEditTask(null)
    fetchTasks()
    fetchStats()
    fetchTaskLists()
    if (view === 'calendar') fetchCalendarTasks()
    if (view === 'columns') fetchAllTasks()
  }

  const handleOpenFullEdit = (task: Task) => {
    setEditTask(task)
    setShowModal(true)
    // Close popover
    setCalPopoverTask(null)
    setCalPopoverPos(null)
  }

  // ── Calendar helpers ──
  const calYear = calendarDate.getFullYear()
  const calMonth = calendarDate.getMonth()
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate()
  const firstDayOfWeek = new Date(calYear, calMonth, 1).getDay() // 0=Sun
  const today = new Date()
  const isToday = (d: number) => today.getFullYear() === calYear && today.getMonth() === calMonth && today.getDate() === d

  const getTasksForDay = (day: number) => {
    return calendarTasks.filter(t => {
      if (!t.due_at) return false
      const d = new Date(t.due_at)
      return d.getDate() === day && d.getMonth() === calMonth && d.getFullYear() === calYear
    })
  }

  const prevMonth = () => setCalendarDate(new Date(calYear, calMonth - 1, 1))
  const nextMonth = () => setCalendarDate(new Date(calYear, calMonth + 1, 1))
  const goToday = () => setCalendarDate(new Date())

  const monthName = calendarDate.toLocaleDateString('es', { month: 'long', year: 'numeric' })

  const handleCalendarTaskClick = (task: Task, e: React.MouseEvent) => {
    e.stopPropagation()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const viewportW = window.innerWidth
    // Position popover near the clicked task chip
    let left = rect.left
    if (left + 350 > viewportW) left = viewportW - 370
    if (left < 10) left = 10
    setCalPopoverTask(task)
    setCalPopoverPos({ top: rect.bottom + 4, left })
  }

  // Group tasks for list view
  const groupedTasks = () => {
    const groups: { label: string; color: string; tasks: Task[] }[] = []
    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const tomorrowStart = new Date(todayStart)
    tomorrowStart.setDate(tomorrowStart.getDate() + 1)
    const weekEnd = new Date(todayStart)
    weekEnd.setDate(weekEnd.getDate() + 7)

    const overdue: Task[] = []
    const todayTasks: Task[] = []
    const tomorrowTasks: Task[] = []
    const weekTasks: Task[] = []
    const futureTasks: Task[] = []
    const completedTasks: Task[] = []
    const noDateTasks: Task[] = []

    tasks.forEach(t => {
      if (t.status === 'completed' || t.status === 'cancelled') {
        completedTasks.push(t)
      } else if (t.status === 'overdue') {
        overdue.push(t)
      } else if (!t.due_at) {
        noDateTasks.push(t)
      } else {
        const d = new Date(t.due_at)
        if (d < todayStart) overdue.push(t)
        else if (d < tomorrowStart) todayTasks.push(t)
        else if (d < new Date(tomorrowStart.getTime() + 86400000)) tomorrowTasks.push(t)
        else if (d < weekEnd) weekTasks.push(t)
        else futureTasks.push(t)
      }
    })

    if (overdue.length) groups.push({ label: '⚠️ Vencidas', color: 'text-red-600', tasks: overdue })
    if (todayTasks.length) groups.push({ label: '📌 Hoy', color: 'text-amber-600', tasks: todayTasks })
    if (tomorrowTasks.length) groups.push({ label: '📅 Mañana', color: 'text-blue-600', tasks: tomorrowTasks })
    if (weekTasks.length) groups.push({ label: '📆 Esta semana', color: 'text-slate-600', tasks: weekTasks })
    if (futureTasks.length) groups.push({ label: '🔮 Futuras', color: 'text-slate-500', tasks: futureTasks })
    if (noDateTasks.length) groups.push({ label: '📋 Sin fecha', color: 'text-slate-400', tasks: noDateTasks })

    return { groups, completedTasks }
  }

  return (
    <div className="h-full flex bg-slate-50">
      {/* ── Sidebar: Task Lists ── */}
      <div className={`bg-white border-r border-slate-200 flex flex-col shrink-0 transition-all duration-200 ${sidebarCollapsed ? 'w-0 overflow-hidden border-r-0' : 'w-56'}`}>
        <div className="px-3 pt-4 pb-2 space-y-0.5">
          {/* Starred filter */}
          <button
            onClick={() => { setStarredFilter(!starredFilter); offsetRef.current = 0 }}
            className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-sm transition-all ${
              starredFilter ? 'bg-amber-50 text-amber-700 font-medium' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'
            }`}
          >
            <Star className={`w-4 h-4 ${starredFilter ? 'fill-amber-400 text-amber-400' : ''}`} />
            <span className="truncate flex-1 text-left">Destacadas</span>
          </button>
        </div>
        <div className="px-3 pb-2">
          <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest px-1">Listas</h3>
        </div>
        <div className="flex-1 overflow-y-auto px-2 space-y-0.5">
          {/* All tasks */}
          <button
            onClick={() => { setActiveListId(''); offsetRef.current = 0 }}
            className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-sm transition-all ${
              activeListId === '' ? 'bg-emerald-50 text-emerald-700 font-medium' : 'text-slate-600 hover:bg-slate-50'
            }`}
          >
            <ListTodo className="w-4 h-4 shrink-0" />
            <span className="truncate flex-1 text-left">Todas</span>
            <span className="text-[11px] text-slate-400 tabular-nums">{stats.pending + stats.overdue}</span>
          </button>

          {/* User lists */}
          {taskLists.map(list => (
            <div
              key={list.id}
              className={`relative group transition-all duration-200 ${dragOverListId === list.id ? 'ring-2 ring-emerald-300 rounded-lg' : ''} ${dragTaskOverListId === list.id ? 'bg-emerald-50 ring-2 ring-emerald-400 rounded-lg scale-[1.02]' : ''}`}
              draggable={editingListId !== list.id}
              onDragStart={e => {
                if (e.dataTransfer.types.includes('text/task-id')) return
                e.dataTransfer.effectAllowed = 'move'
                setDragListId(list.id)
              }}
              onDragOver={e => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                if (e.dataTransfer.types.includes('text/task-id')) {
                  setDragTaskOverListId(list.id)
                } else {
                  setDragOverListId(list.id)
                }
              }}
              onDragLeave={() => {
                if (dragOverListId === list.id) setDragOverListId(null)
                if (dragTaskOverListId === list.id) setDragTaskOverListId(null)
              }}
              onDrop={e => {
                e.preventDefault()
                const taskId = e.dataTransfer.getData('text/task-id')
                if (taskId) {
                  handleMoveToList(taskId, list.id)
                  setDragTaskOverListId(null)
                  return
                }
                setDragOverListId(null)
                if (dragListId && dragListId !== list.id) {
                  const currentOrder = taskLists.map(l => l.id)
                  const fromIdx = currentOrder.indexOf(dragListId)
                  const toIdx = currentOrder.indexOf(list.id)
                  if (fromIdx !== -1 && toIdx !== -1) {
                    const newOrder = [...currentOrder]
                    newOrder.splice(fromIdx, 1)
                    newOrder.splice(toIdx, 0, dragListId)
                    handleReorderLists(newOrder)
                  }
                }
                setDragListId(null)
              }}
              onDragEnd={() => { setDragListId(null); setDragOverListId(null); setDragTaskOverListId(null) }}
            >
              {editingListId === list.id ? (
                <div className="flex items-center gap-1 px-1">
                  <input
                    autoFocus
                    value={editingListName}
                    onChange={e => setEditingListName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleRenameList(list.id)
                      if (e.key === 'Escape') { setEditingListId(null); setEditingListName('') }
                    }}
                    onBlur={() => handleRenameList(list.id)}
                    className="flex-1 px-2 py-1 text-sm border border-emerald-300 rounded-lg focus:ring-1 focus:ring-emerald-500 outline-none min-w-0"
                  />
                </div>
              ) : (
                <button
                  onClick={() => { setActiveListId(list.id); offsetRef.current = 0 }}
                  className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-sm transition-all ${
                    activeListId === list.id ? 'bg-emerald-50 text-emerald-700 font-medium' : 'text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  <GripVertical className="w-3 h-3 shrink-0 text-slate-300 opacity-0 group-hover:opacity-100 transition cursor-grab" />
                  <List className="w-4 h-4 shrink-0" />
                  <span className="truncate flex-1 text-left">{list.name}</span>
                  <span className="text-[11px] text-slate-400 tabular-nums">{list.task_count}</span>
                  <div className="opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => { e.stopPropagation(); setListMenuId(listMenuId === list.id ? null : list.id) }}>
                    <MoreHorizontal className="w-3.5 h-3.5 text-slate-400 hover:text-slate-600" />
                  </div>
                </button>
              )}

              {/* List context menu */}
              {listMenuId === list.id && (
                <div ref={listMenuRef} className="absolute right-0 top-full mt-1 bg-white border border-slate-200 rounded-xl shadow-lg z-50 py-1 w-36">
                  <button
                    onMouseDown={e => { e.preventDefault(); e.stopPropagation(); setEditingListId(list.id); setEditingListName(list.name); setListMenuId(null) }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 transition"
                  >
                    <Pencil className="w-3.5 h-3.5" /> Renombrar
                  </button>
                  <button
                    onMouseDown={e => { e.preventDefault(); e.stopPropagation(); handleDeleteList(list.id) }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 transition"
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Eliminar
                  </button>
                </div>
              )}
            </div>
          ))}

          {/* No list — also a drop target */}
          <div
            className={`transition-all duration-200 rounded-lg ${dragTaskOverListId === 'none' ? 'bg-emerald-50 ring-2 ring-emerald-400 scale-[1.02]' : ''}`}
            onDragOver={e => {
              if (e.dataTransfer.types.includes('text/task-id')) {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                setDragTaskOverListId('none')
              }
            }}
            onDragLeave={() => { if (dragTaskOverListId === 'none') setDragTaskOverListId(null) }}
            onDrop={e => {
              const taskId = e.dataTransfer.getData('text/task-id')
              if (taskId) {
                e.preventDefault()
                handleMoveToList(taskId, '')
                setDragTaskOverListId(null)
              }
            }}
          >
            <button
              onClick={() => { setActiveListId('none'); offsetRef.current = 0 }}
              className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-sm transition-all ${
                activeListId === 'none' ? 'bg-emerald-50 text-emerald-700 font-medium' : 'text-slate-400 hover:bg-slate-50 hover:text-slate-600'
              }`}
            >
              <span className="w-4 h-4 shrink-0 flex items-center justify-center text-[11px]">—</span>
              <span className="truncate flex-1 text-left">Sin lista</span>
            </button>
          </div>
        </div>

        {/* New list input */}
        <div className="px-2 py-2 border-t border-slate-100">
          {showNewListInput ? (
            <div className="flex items-center gap-1">
              <input
                autoFocus
                value={newListName}
                onChange={e => setNewListName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleCreateList()
                  if (e.key === 'Escape') { setShowNewListInput(false); setNewListName('') }
                }}
                placeholder="Nombre de la lista"
                className="flex-1 px-2 py-1.5 text-sm border border-slate-200 rounded-lg focus:ring-1 focus:ring-emerald-500 outline-none min-w-0 placeholder:text-slate-400"
              />
              <button onClick={handleCreateList} className="p-1 text-emerald-600 hover:bg-emerald-50 rounded transition">
                <Plus className="w-4 h-4" />
              </button>
              <button onClick={() => { setShowNewListInput(false); setNewListName('') }} className="p-1 text-slate-400 hover:bg-slate-100 rounded transition">
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowNewListInput(true)}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 text-sm text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition"
            >
              <Plus className="w-4 h-4" />
              Nueva lista
            </button>
          )}
        </div>
      </div>

      {/* ── Main content ── */}
      <div className="flex-1 flex flex-col min-w-0">
      {/* Header */}
      <div className="bg-white border-b border-slate-200 px-6 py-3 space-y-3">
        {/* Row 1: Always visible — title + stats | view toggle | new button */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => { const v = !sidebarCollapsed; setSidebarCollapsed(v); localStorage.setItem('tasks_sidebar_collapsed', String(v)) }}
            className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition"
          >
            {sidebarCollapsed ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-bold text-slate-800">Tareas</h1>
            <p className="text-sm text-slate-500 mt-0.5">
              {stats.overdue > 0 && <span className="text-red-500 font-medium">{stats.overdue} vencidas · </span>}
              {stats.today > 0 && <span className="text-amber-600 font-medium">{stats.today} hoy · </span>}
              {stats.pending} pendientes · {stats.completed} completadas
            </p>
          </div>
          <ViewToggle view={view} setView={setView} />
          <button
            onClick={() => { setEditTask(null); setShowModal(true) }}
            className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 transition text-sm font-medium shadow-sm"
          >
            <Plus className="w-4 h-4" />
            Nueva Tarea
          </button>
        </div>

        {/* Row 2: View-specific controls */}
        {view === 'list' && (
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative flex-1 max-w-xs">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="text"
                value={search}
                onChange={e => { setSearch(e.target.value); offsetRef.current = 0 }}
                placeholder="Buscar tareas..."
                className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500"
              />
            </div>
            <select
              value={filterStatus}
              onChange={e => { setFilterStatus(e.target.value); offsetRef.current = 0 }}
              className="px-3 py-2 border border-slate-200 rounded-lg text-sm text-slate-700 focus:ring-2 focus:ring-emerald-500"
            >
              <option value="">Todos los estados</option>
              <option value="pending">Pendientes</option>
              <option value="overdue">Vencidas</option>
              <option value="completed">Completadas</option>
              <option value="cancelled">Canceladas</option>
            </select>
            <select
              value={filterType}
              onChange={e => { setFilterType(e.target.value); offsetRef.current = 0 }}
              className="px-3 py-2 border border-slate-200 rounded-lg text-sm text-slate-700 focus:ring-2 focus:ring-emerald-500"
            >
              <option value="">Todos los tipos</option>
              {Object.entries(TASK_TYPE_CONFIG).map(([key, cfg]) => (
                <option key={key} value={key}>{cfg.icon} {cfg.label}</option>
              ))}
            </select>
            {accountUsers.length > 1 && (
              <select
                value={filterAssigned}
                onChange={e => { setFilterAssigned(e.target.value); offsetRef.current = 0 }}
                className="px-3 py-2 border border-slate-200 rounded-lg text-sm text-slate-700 focus:ring-2 focus:ring-emerald-500"
              >
                <option value="">Todos los usuarios</option>
                {accountUsers.map(u => (
                  <option key={u.id} value={u.id}>{u.display_name || u.username}</option>
                ))}
              </select>
            )}
          </div>
        )}
        {view === 'calendar' && (
          <div className="flex items-center gap-3">
            <button onClick={prevMonth} className="p-1 hover:bg-slate-100 rounded-lg transition">
              <ChevronLeft className="w-5 h-5 text-slate-600" />
            </button>
            <h2 className="text-base font-bold text-slate-800 capitalize min-w-[150px] text-center">{monthName}</h2>
            <button onClick={nextMonth} className="p-1 hover:bg-slate-100 rounded-lg transition">
              <ChevronRight className="w-5 h-5 text-slate-600" />
            </button>
            <button onClick={goToday} className="px-2.5 py-1 bg-emerald-50 text-emerald-700 text-xs font-medium rounded-lg hover:bg-emerald-100 transition">
              Hoy
            </button>
          </div>
        )}
        {view === 'columns' && taskLists.length > 1 && (
          <div className="flex items-center">
            <button
              onClick={() => { setModalListOrder([...taskLists]); setShowColumnOrderModal(true) }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg transition"
            >
              <ArrowUpDown className="w-3.5 h-3.5" />
              Ordenar columnas
            </button>
          </div>
        )}
      </div>

      {/* Content */}
      <div ref={view === 'list' ? taskListScrollRef : undefined} className={`flex-1 overflow-y-auto ${view === 'calendar' || view === 'columns' ? 'p-2' : 'p-6'}`}>
        {view === 'list' ? (
          /* ── LIST VIEW ── */
          <div className="max-w-3xl mx-auto space-y-6">
            {/* Inline quick creation */}
            <div className="flex items-center gap-2 bg-white rounded-xl border border-slate-200 px-4 py-2.5 shadow-sm hover:shadow transition">
              <Plus className={`w-5 h-5 shrink-0 ${inlineCreating ? 'text-slate-300 animate-spin' : 'text-emerald-500'}`} />
              <input
                value={inlineTitle}
                onChange={e => setInlineTitle(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleInlineCreate(); if (e.key === 'Escape') setInlineTitle('') }}
                placeholder="Agregar tarea rápida..."
                disabled={inlineCreating}
                className="flex-1 text-sm text-slate-700 placeholder:text-slate-400 outline-none bg-transparent"
              />
              {inlineTitle.trim() && (
                <button
                  onClick={handleInlineCreate}
                  disabled={inlineCreating}
                  className="text-xs font-medium text-emerald-600 hover:text-emerald-700 px-2 py-1 rounded-lg hover:bg-emerald-50 transition"
                >
                  Crear
                </button>
              )}
            </div>

            {loading ? (
              <div className="flex justify-center py-12">
                <div className="animate-spin rounded-full h-8 w-8 border-2 border-emerald-200 border-t-emerald-600" />
              </div>
            ) : tasks.length === 0 ? (
              <div className="text-center py-16">
                <CheckCircle2 className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                <p className="text-slate-500 font-medium">No hay tareas</p>
                <p className="text-sm text-slate-400 mt-1">Crea tu primera tarea para empezar</p>
              </div>
            ) : (
              (() => {
                const { groups, completedTasks } = groupedTasks()
                return (
                  <>
                    {groups.map(group => (
                      <div key={group.label}>
                        <h3 className={`text-sm font-bold ${group.color} mb-2`}>{group.label}</h3>
                        <TaskListComponent
                          tasks={group.tasks}
                          onComplete={handleComplete}
                          onUpdate={handleInlineUpdate}
                          onDelete={handleDelete}
                          onOpenFullEdit={handleOpenFullEdit}
                          onToggleStar={handleToggleStar}
                        />
                      </div>
                    ))}

                    {/* Collapsible completed section */}
                    {completedTasks.length > 0 && (
                      <div>
                        <button
                          onClick={() => setShowCompleted(!showCompleted)}
                          className="flex items-center gap-2 text-sm font-bold text-emerald-600 mb-2 hover:text-emerald-700 transition group"
                        >
                          <ChevronDown className={`w-4 h-4 transition-transform ${showCompleted ? '' : '-rotate-90'}`} />
                          ✅ Completadas ({completedTasks.length})
                        </button>
                        {showCompleted && (
                          <TaskListComponent
                            tasks={completedTasks}
                            onComplete={handleComplete}
                            onUpdate={handleInlineUpdate}
                            onDelete={handleDelete}
                            onOpenFullEdit={handleOpenFullEdit}
                            onToggleStar={handleToggleStar}
                          />
                        )}
                      </div>
                    )}
                  </>
                )
              })()
            )}

            {/* Loading more indicator */}
            {loadingMore && (
              <div className="flex items-center justify-center py-4">
                <div className="w-5 h-5 border-2 border-emerald-600 border-t-transparent rounded-full animate-spin" />
                <span className="ml-2 text-sm text-slate-500">Cargando más tareas...</span>
              </div>
            )}
            {!hasMore && tasks.length > 0 && total > limit && (
              <p className="text-center text-xs text-slate-400 py-2">{total} tareas cargadas</p>
            )}
          </div>
        ) : view === 'calendar' ? (
          /* ── CALENDAR VIEW ── */
          <div className="h-full flex flex-col">
            {/* Calendar grid */}
            <div className="flex-1 bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm flex flex-col">
              {/* Day headers */}
              <div className="grid grid-cols-7 border-b border-slate-200">
                {['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'].map(d => (
                  <div key={d} className="py-1.5 text-center text-[11px] font-semibold text-slate-500 uppercase">{d}</div>
                ))}
              </div>

              {/* Day cells */}
              <div className="grid grid-cols-7 flex-1" style={{ gridAutoRows: '1fr' }}>
                {/* Empty cells before first day */}
                {Array.from({ length: firstDayOfWeek }).map((_, i) => (
                  <div key={`empty-${i}`} className="border-b border-r border-slate-100 bg-slate-50/50" />
                ))}

                {/* Actual days */}
                {Array.from({ length: daysInMonth }).map((_, i) => {
                  const day = i + 1
                  const dayTasks = getTasksForDay(day)
                  const isTodayCell = isToday(day)

                  return (
                    <div
                      key={day}
                      className={`border-b border-r border-slate-100 p-1 cursor-pointer hover:bg-slate-50 transition overflow-hidden ${
                        isTodayCell ? 'bg-emerald-50/40' : ''
                      }`}
                      onClick={() => {
                        setEditTask(null)
                        setShowModal(true)
                      }}
                    >
                      <div className={`text-[11px] font-medium mb-0.5 ${
                        isTodayCell ? 'bg-emerald-600 text-white w-5 h-5 rounded-full flex items-center justify-center text-[10px]' : 'text-slate-600 pl-0.5'
                      }`}>
                        {day}
                      </div>
                      <div className="space-y-px">
                        {dayTasks.slice(0, 3).map(t => {
                          const cfg = TASK_TYPE_CONFIG[t.type] || TASK_TYPE_CONFIG.reminder
                          const isComp = t.status === 'completed'
                          return (
                            <div
                              key={t.id}
                              onClick={e => handleCalendarTaskClick(t, e)}
                              className={`text-[10px] leading-tight px-1 py-px rounded truncate font-medium cursor-pointer transition hover:opacity-80 ${
                                isComp ? 'bg-slate-100 text-slate-400 line-through' : `${cfg.bg} ${cfg.color}`
                              }`}
                              title={t.title}
                            >
                              {cfg.icon} {t.due_at ? new Date(t.due_at).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : ''} {t.title}
                            </div>
                          )
                        })}
                        {dayTasks.length > 3 && (
                          <div className="text-[10px] text-slate-400 pl-1">+{dayTasks.length - 3} más</div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        ) : (
          /* ── COLUMNS VIEW ── */
          <TaskColumnsView
            tasks={allTasks}
            taskLists={taskLists}
            onComplete={handleComplete}
            onDelete={handleDelete}
            onUpdate={handleInlineUpdate}
            onOpenFullEdit={handleOpenFullEdit}
            onToggleStar={handleToggleStar}
            onInlineCreate={handleColumnInlineCreate}
            onMoveToList={handleMoveToList}
            onReorder={handleReorderTasks}
            onReorderLists={handleReorderLists}
            kanbanRef={kanbanRef}
          />
        )}
      </div>
      </div>

      {/* Calendar task popover */}
      {calPopoverTask && calPopoverPos && (
        <div
          ref={calPopoverRef}
          className="fixed z-50 w-[350px] bg-white border border-slate-200 rounded-2xl shadow-2xl animate-in fade-in-0 slide-in-from-top-2 duration-200"
          style={{ top: calPopoverPos.top, left: calPopoverPos.left }}
        >
          <div className="p-1">
            <TaskInlineCard
              task={calPopoverTask}
              isExpanded={true}
              onExpand={() => {}}
              onCollapse={() => { setCalPopoverTask(null); setCalPopoverPos(null) }}
              onComplete={(id) => { handleComplete(id); setCalPopoverTask(null); setCalPopoverPos(null) }}
              onUpdate={handleInlineUpdate}
              onDelete={handleDelete}
              onOpenFullEdit={handleOpenFullEdit}
              onToggleStar={handleToggleStar}
            />
          </div>
        </div>
      )}

      {/* Column Order Modal */}
      {showColumnOrderModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" onClick={() => setShowColumnOrderModal(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-800">Ordenar columnas</h3>
              <button onClick={() => setShowColumnOrderModal(false)} className="p-1 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100 transition">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 space-y-1 max-h-80 overflow-y-auto">
              {modalListOrder.map((list, idx) => (
                <div
                  key={list.id}
                  draggable
                  onDragStart={() => setModalDragIdx(idx)}
                  onDragOver={e => { e.preventDefault(); setModalDragOverIdx(idx) }}
                  onDrop={e => {
                    e.preventDefault()
                    if (modalDragIdx !== null && modalDragIdx !== idx) {
                      const newOrder = [...modalListOrder]
                      const [moved] = newOrder.splice(modalDragIdx, 1)
                      newOrder.splice(idx, 0, moved)
                      setModalListOrder(newOrder)
                    }
                    setModalDragIdx(null)
                    setModalDragOverIdx(null)
                  }}
                  onDragEnd={() => { setModalDragIdx(null); setModalDragOverIdx(null) }}
                  className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg border transition cursor-grab active:cursor-grabbing ${
                    modalDragOverIdx === idx ? 'border-emerald-400 bg-emerald-50' : 'border-slate-200 bg-white hover:bg-slate-50'
                  }`}
                >
                  <GripVertical className="w-4 h-4 text-slate-300 shrink-0" />
                  <List className="w-4 h-4 text-slate-500 shrink-0" />
                  <span className="text-sm font-medium text-slate-700 flex-1 truncate">{list.name}</span>
                  <span className="text-[11px] text-slate-400 tabular-nums">{list.task_count}</span>
                </div>
              ))}
            </div>
            <div className="px-5 py-3 border-t border-slate-200 flex justify-end gap-2">
              <button
                onClick={() => setShowColumnOrderModal(false)}
                className="px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition"
              >
                Cancelar
              </button>
              <button
                onClick={() => {
                  handleReorderLists(modalListOrder.map(l => l.id))
                  setShowColumnOrderModal(false)
                }}
                className="px-4 py-1.5 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition shadow-sm"
              >
                Guardar orden
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Task Form Modal */}
      <TaskFormModal
        isOpen={showModal}
        onClose={() => { setShowModal(false); setEditTask(null) }}
        onSave={handleSave}
        task={editTask}
        taskLists={taskLists}
        listId={activeListId && activeListId !== 'none' ? activeListId : ''}
        leadId={editTask?.lead_id}
        leadName={editTask?.lead_name}
        eventId={editTask?.event_id}
        eventName={editTask?.event_name}
        programId={editTask?.program_id}
        programName={editTask?.program_name}
        contactId={editTask?.contact_id}
        contactName={editTask?.contact_name}
      />
    </div>
  )
}
