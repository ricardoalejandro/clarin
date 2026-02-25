'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import {
  CalendarDays, Plus, Search, MapPin, Users, Clock, Edit2, Trash2,
  Eye, LayoutGrid, List, ChevronRight, Home, FolderPlus, MoreHorizontal,
  LayoutTemplate, FolderOpen, ArrowLeft, MoveRight,
} from 'lucide-react'
import { format } from 'date-fns'
import { es } from 'date-fns/locale'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Event {
  id: string
  name: string
  description?: string
  event_date?: string
  event_end?: string
  location?: string
  status: string
  color: string
  folder_id?: string | null
  created_at: string
  total_participants: number
  participant_counts?: Record<string, number>
}

interface EventFolder {
  id: string
  account_id: string
  parent_id?: string | null
  name: string
  color: string
  icon: string
  position: number
  event_count: number
  created_at: string
  updated_at: string
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_OPTIONS = [
  { value: 'active', label: 'Activo', color: 'bg-emerald-100 text-emerald-700' },
  { value: 'draft', label: 'Borrador', color: 'bg-slate-100 text-slate-700' },
  { value: 'completed', label: 'Completado', color: 'bg-blue-100 text-blue-700' },
  { value: 'cancelled', label: 'Cancelado', color: 'bg-red-100 text-red-700' },
]

const COLOR_OPTIONS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899',
  '#06b6d4', '#f97316', '#14b8a6', '#6366f1',
]

const FOLDER_ICONS = ['📁', '📂', '🎓', '🎉', '🏋️', '📊', '📝', '🎯', '📌', '🗂️']

const PARTICIPANT_STATUSES = [
  { key: 'invited', label: 'Invitados', color: 'bg-blue-500' },
  { key: 'contacted', label: 'Contactados', color: 'bg-yellow-500' },
  { key: 'confirmed', label: 'Confirmados', color: 'bg-green-500' },
  { key: 'declined', label: 'Declinados', color: 'bg-red-500' },
  { key: 'attended', label: 'Asistieron', color: 'bg-emerald-600' },
  { key: 'no_show', label: 'No asistieron', color: 'bg-slate-400' },
]

// ─── Main Component ───────────────────────────────────────────────────────────

export default function EventsPage() {
  const router = useRouter()
  // Events & Folders state
  const [events, setEvents] = useState<Event[]>([])
  const [folders, setFolders] = useState<EventFolder[]>([])
  const [loading, setLoading] = useState(true)

  // Navigation state
  const [currentFolderID, setCurrentFolderID] = useState<string | null>(null)
  const [folderPath, setFolderPath] = useState<EventFolder[]>([]) // breadcrumb

  // Filters & View
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [viewMode, setViewMode] = useState<'grid' | 'compact' | 'list'>('grid')

  // Event modal
  const [showCreate, setShowCreate] = useState(false)
  const [editEvent, setEditEvent] = useState<Event | null>(null)
  const [formData, setFormData] = useState({
    name: '', description: '', event_date: '', event_end: '', location: '', color: '#3b82f6', status: 'active',
  })

  // Folder modal
  const [showFolderModal, setShowFolderModal] = useState(false)
  const [editFolder, setEditFolder] = useState<EventFolder | null>(null)
  const [folderForm, setFolderForm] = useState({ name: '', color: '#3b82f6', icon: '📁' })

  // Event context menus
  const [menuEventID, setMenuEventID] = useState<string | null>(null)
  const [showMoveMenu, setShowMoveMenu] = useState<string | null>(null)

  // Drag & drop
  const [dragOverFolderID, setDragOverFolderID] = useState<string | null>(null)
  const dragEventIDRef = useRef<string | null>(null)

  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : ''

  // ─── Data Fetching ──────────────────────────────────────────────────────────

  const fetchFolders = useCallback(async () => {
    try {
      const res = await fetch('/api/events/folders', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) setFolders(data.folders || [])
    } catch (e) {
      console.error(e)
    }
  }, [token])

  const fetchEvents = useCallback(async () => {
    try {
      const params = new URLSearchParams()
      if (search) params.set('search', search)
      if (statusFilter) params.set('status', statusFilter)
      params.set('folder', currentFolderID ?? 'root')
      const res = await fetch(`/api/events?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) setEvents(data.events || [])
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [token, search, statusFilter, currentFolderID])

  useEffect(() => {
    setLoading(true)
    fetchFolders()
    fetchEvents()
  }, [fetchFolders, fetchEvents])

  // Close modals on Escape
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowCreate(false); setEditEvent(null)
        setShowFolderModal(false); setEditFolder(null)
        setMenuEventID(null); setShowMoveMenu(null)
        resetEventForm()
      }
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [])

  // Close context menus on outside click
  useEffect(() => {
    const h = (e: MouseEvent) => {
      // Only close if the click was NOT on a menu toggle button
      const target = e.target as HTMLElement
      if (target.closest('[data-menu-toggle]')) return
      setMenuEventID(null)
      setShowMoveMenu(null)
    }
    document.addEventListener('click', h)
    return () => document.removeEventListener('click', h)
  }, [])

  // ─── Folder Navigation ──────────────────────────────────────────────────────

  const visibleFolders = folders.filter(f =>
    currentFolderID ? f.parent_id === currentFolderID : !f.parent_id
  )

  const navigateIntoFolder = (folder: EventFolder) => {
    setCurrentFolderID(folder.id)
    setFolderPath(prev => [...prev, folder])
    setSearch('')
    setStatusFilter('')
    setLoading(true)
  }

  const navigateToBreadcrumb = (index: number) => {
    if (index === -1) {
      setCurrentFolderID(null)
      setFolderPath([])
    } else {
      setCurrentFolderID(folderPath[index].id)
      setFolderPath(prev => prev.slice(0, index + 1))
    }
    setSearch('')
    setStatusFilter('')
    setLoading(true)
  }

  // ─── Drag & Drop ────────────────────────────────────────────────────────────

  const handleDragStart = (e: React.DragEvent, eventID: string) => {
    dragEventIDRef.current = eventID
    e.dataTransfer.effectAllowed = 'move'
  }

  const handleFolderDragOver = (e: React.DragEvent, folderID: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverFolderID(folderID)
  }

  const handleFolderDrop = async (e: React.DragEvent, targetFolderID: string) => {
    e.preventDefault()
    setDragOverFolderID(null)
    const eventID = dragEventIDRef.current
    if (!eventID) return
    dragEventIDRef.current = null
    await moveEventToFolder(eventID, targetFolderID)
  }

  const moveEventToFolder = async (eventID: string, folderID: string | null) => {
    await fetch(`/api/events/${eventID}/move-folder`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder_id: folderID }),
    })
    fetchEvents()
    fetchFolders()
  }

  // ─── Event CRUD ─────────────────────────────────────────────────────────────

  const resetEventForm = () => {
    setFormData({ name: '', description: '', event_date: '', event_end: '', location: '', color: '#3b82f6', status: 'active' })
  }

  const openEditEvent = (ev: Event) => {
    setFormData({
      name: ev.name,
      description: ev.description || '',
      event_date: ev.event_date ? new Date(ev.event_date).toISOString().slice(0, 16) : '',
      event_end: ev.event_end ? new Date(ev.event_end).toISOString().slice(0, 16) : '',
      location: ev.location || '',
      color: ev.color,
      status: ev.status,
    })
    setEditEvent(ev)
  }

  const handleCreateEvent = async () => {
    const body: Record<string, unknown> = { ...formData }
    if (formData.event_date) body.event_date = new Date(formData.event_date).toISOString()
    else delete body.event_date
    if (formData.event_end) body.event_end = new Date(formData.event_end).toISOString()
    else delete body.event_end
    if (!formData.description) delete body.description
    if (!formData.location) delete body.location
    if (currentFolderID) body.folder_id = currentFolderID

    const res = await fetch('/api/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (data.success) {
      setShowCreate(false)
      resetEventForm()
      fetchEvents()
      fetchFolders()
    }
  }

  const handleUpdateEvent = async () => {
    if (!editEvent) return
    const body: Record<string, unknown> = { ...formData }
    if (formData.event_date) body.event_date = new Date(formData.event_date).toISOString()
    if (formData.event_end) body.event_end = new Date(formData.event_end).toISOString()

    const res = await fetch(`/api/events/${editEvent.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (data.success) {
      setEditEvent(null)
      resetEventForm()
      fetchEvents()
    }
  }

  const handleDeleteEvent = async (id: string) => {
    if (!confirm('¿Eliminar este evento y todos sus participantes?')) return
    await fetch(`/api/events/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    fetchEvents()
    fetchFolders()
  }

  // ─── Folder CRUD ────────────────────────────────────────────────────────────

  const openCreateFolder = () => {
    setEditFolder(null)
    setFolderForm({ name: '', color: '#3b82f6', icon: '📁' })
    setShowFolderModal(true)
  }

  const openEditFolder = (folder: EventFolder, e: React.MouseEvent) => {
    e.stopPropagation()
    setEditFolder(folder)
    setFolderForm({ name: folder.name, color: folder.color, icon: folder.icon })
    setShowFolderModal(true)
  }

  const handleSaveFolder = async () => {
    if (editFolder) {
      await fetch(`/api/events/folders/${editFolder.id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(folderForm),
      })
    } else {
      await fetch('/api/events/folders', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...folderForm, parent_id: currentFolderID || undefined }),
      })
    }
    setShowFolderModal(false)
    setEditFolder(null)
    fetchFolders()
  }

  const handleDeleteFolder = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirm('¿Eliminar carpeta? Los eventos se moverán a la carpeta padre.')) return
    await fetch(`/api/events/folders/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    fetchFolders()
    fetchEvents()
  }

  // ─── Loading ─────────────────────────────────────────────────────────────────

  if (loading && events.length === 0 && folders.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-600" />
      </div>
    )
  }

  // ─── Render Helpers ───────────────────────────────────────────────────────────

  const renderEventForm = (onSubmit: () => void, submitLabel: string) => (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={() => { setShowCreate(false); setEditEvent(null); resetEventForm() }}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}>
        <div className="p-6">
          <h2 className="text-lg font-semibold text-slate-900 mb-4">
            {submitLabel === 'Crear' ? 'Nuevo Evento' : 'Editar Evento'}
          </h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Nombre *</label>
              <input value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })} autoFocus
                className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-slate-900"
                placeholder="Ej: Clase Gratuita de Marketing"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Descripción</label>
              <textarea value={formData.description} onChange={e => setFormData({ ...formData, description: e.target.value })} rows={3}
                className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-slate-900"
                placeholder="Describe la actividad..." />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Fecha inicio</label>
                <input type="datetime-local" value={formData.event_date}
                  onChange={e => setFormData({ ...formData, event_date: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 text-slate-900 text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Fecha fin</label>
                <input type="datetime-local" value={formData.event_end}
                  onChange={e => setFormData({ ...formData, event_end: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 text-slate-900 text-sm" />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Ubicación</label>
              <input value={formData.location} onChange={e => setFormData({ ...formData, location: e.target.value })}
                className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 text-slate-900"
                placeholder="Ej: Zoom, Oficina central..." />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Color</label>
                <div className="flex flex-wrap gap-2">
                  {COLOR_OPTIONS.map(c => (
                    <button key={c} onClick={() => setFormData({ ...formData, color: c })}
                      className={`w-7 h-7 rounded-full border-2 transition-all ${formData.color === c ? 'border-slate-900 scale-110' : 'border-transparent hover:scale-105'}`}
                      style={{ backgroundColor: c }} />
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Estado</label>
                <select value={formData.status} onChange={e => setFormData({ ...formData, status: e.target.value })}
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 text-slate-900">
                  {STATUS_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-3 mt-6">
            <button onClick={() => { setShowCreate(false); setEditEvent(null); resetEventForm() }}
              className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">Cancelar</button>
            <button disabled={!formData.name} onClick={onSubmit}
              className="px-6 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors">
              {submitLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  )

  const renderFolderModal = () => (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={() => setShowFolderModal(false)}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm" onClick={e => e.stopPropagation()}>
        <div className="p-6">
          <h2 className="text-lg font-semibold text-slate-900 mb-4">
            {editFolder ? 'Editar carpeta' : 'Nueva carpeta'}
          </h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Nombre *</label>
              <input value={folderForm.name} onChange={e => setFolderForm({ ...folderForm, name: e.target.value })} autoFocus
                className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 text-slate-900"
                placeholder="Ej: Eventos 2025" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Ícono</label>
              <div className="flex flex-wrap gap-2">
                {FOLDER_ICONS.map(icon => (
                  <button key={icon} onClick={() => setFolderForm({ ...folderForm, icon })}
                    className={`w-10 h-10 text-xl rounded-lg border-2 transition-all flex items-center justify-center ${folderForm.icon === icon ? 'border-emerald-500 bg-emerald-50 scale-110' : 'border-transparent hover:border-slate-200 hover:bg-slate-50'}`}>
                    {icon}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Color</label>
              <div className="flex flex-wrap gap-2">
                {COLOR_OPTIONS.map(c => (
                  <button key={c} onClick={() => setFolderForm({ ...folderForm, color: c })}
                    className={`w-7 h-7 rounded-full border-2 transition-all ${folderForm.color === c ? 'border-slate-900 scale-110' : 'border-transparent hover:scale-105'}`}
                    style={{ backgroundColor: c }} />
                ))}
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-3 mt-6">
            <button onClick={() => setShowFolderModal(false)}
              className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">Cancelar</button>
            <button disabled={!folderForm.name} onClick={handleSaveFolder}
              className="px-6 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors">
              {editFolder ? 'Guardar' : 'Crear'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )

  // ─── JSX ─────────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5 overflow-y-auto flex-1 min-h-0 pb-6">

      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Eventos</h1>
          <p className="text-slate-500 text-sm mt-0.5">Gestiona actividades y haz seguimiento a tus contactos</p>
        </div>
        <div className="flex gap-2">
          <button onClick={openCreateFolder}
            className="flex items-center gap-2 px-4 py-2.5 bg-white border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 transition-colors shadow-sm text-sm font-medium">
            <FolderPlus className="w-4 h-4" />
            Nueva carpeta
          </button>
          <button onClick={() => { resetEventForm(); setShowCreate(true) }}
            className="flex items-center gap-2 px-4 py-2.5 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors shadow-sm text-sm font-medium">
            <Plus className="w-4 h-4" />
            Nuevo Evento
          </button>
        </div>
      </div>

      {/* Breadcrumb */}
      {folderPath.length > 0 && (
        <nav className="flex items-center gap-1 text-sm">
          <button onClick={() => navigateToBreadcrumb(-1)}
            className="flex items-center gap-1.5 px-2.5 py-1 text-slate-500 hover:text-emerald-700 hover:bg-emerald-50 rounded-lg transition-colors">
            <Home className="w-3.5 h-3.5" />
            <span>Eventos</span>
          </button>
          {folderPath.map((folder, i) => (
            <div key={folder.id} className="flex items-center gap-1">
              <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
              <button onClick={() => navigateToBreadcrumb(i)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg transition-colors font-medium ${i === folderPath.length - 1 ? 'text-slate-900 bg-slate-100 cursor-default' : 'text-slate-500 hover:text-emerald-700 hover:bg-emerald-50'}`}>
                <span className="text-base leading-none">{folder.icon}</span>
                {folder.name}
              </button>
            </div>
          ))}
        </nav>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        {folderPath.length > 0 && (
          <button onClick={() => navigateToBreadcrumb(folderPath.length - 2)}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg border border-slate-200 transition-colors">
            <ArrowLeft className="w-4 h-4" />
            Atrás
          </button>
        )}
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar eventos..."
            className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-slate-900" />
        </div>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          className="px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 text-slate-900">
          <option value="">Todos los estados</option>
          {STATUS_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <div className="flex bg-slate-100 rounded-lg p-0.5">
          <button onClick={() => setViewMode('grid')} title="Cuadrícula"
            className={`p-2 rounded-md transition-colors ${viewMode === 'grid' ? 'bg-white shadow text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}>
            <LayoutGrid className="w-4 h-4" />
          </button>
          <button onClick={() => setViewMode('compact')} title="Compacta"
            className={`p-2 rounded-md transition-colors ${viewMode === 'compact' ? 'bg-white shadow text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}>
            <LayoutTemplate className="w-4 h-4" />
          </button>
          <button onClick={() => setViewMode('list')} title="Lista"
            className={`p-2 rounded-md transition-colors ${viewMode === 'list' ? 'bg-white shadow text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}>
            <List className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* ─── Folders section ──────────────────────────────────────────────────── */}
      {visibleFolders.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Carpetas</p>
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {visibleFolders.map(folder => (
              <div key={folder.id}
                onDragOver={e => handleFolderDragOver(e, folder.id)}
                onDragLeave={() => setDragOverFolderID(null)}
                onDrop={e => handleFolderDrop(e, folder.id)}
                onClick={() => navigateIntoFolder(folder)}
                className={`relative group bg-white border-2 rounded-xl p-4 cursor-pointer transition-all select-none ${
                  dragOverFolderID === folder.id
                    ? 'border-emerald-400 bg-emerald-50 shadow-md scale-[1.02]'
                    : 'border-slate-200 hover:border-slate-300 hover:shadow-sm'
                }`}>
                <div className="absolute top-0 left-0 right-0 h-1 rounded-t-xl" style={{ backgroundColor: folder.color }} />
                <div className="flex items-start justify-between mt-1">
                  <span className="text-3xl leading-none">{folder.icon}</span>
                  <button
                    data-menu-toggle
                    onClick={e => { e.stopPropagation(); setMenuEventID(menuEventID === `f-${folder.id}` ? null : `f-${folder.id}`) }}
                    className="opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-md transition-all">
                    <MoreHorizontal className="w-4 h-4" />
                  </button>
                </div>
                <p className="mt-2 text-sm font-semibold text-slate-800 truncate">{folder.name}</p>
                <p className="text-xs text-slate-400 mt-0.5">{folder.event_count} evento{folder.event_count !== 1 ? 's' : ''}</p>
                {menuEventID === `f-${folder.id}` && (
                  <div className="absolute top-8 right-2 z-20 bg-white border border-slate-200 rounded-xl shadow-lg py-1 min-w-[120px]" onClick={e => e.stopPropagation()}>
                    <button onClick={e => openEditFolder(folder, e)}
                      className="w-full flex items-center gap-2 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">
                      <Edit2 className="w-3.5 h-3.5" /> Editar
                    </button>
                    <button onClick={e => handleDeleteFolder(folder.id, e)}
                      className="w-full flex items-center gap-2 px-4 py-2 text-sm text-red-600 hover:bg-red-50">
                      <Trash2 className="w-3.5 h-3.5" /> Eliminar
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Events section label */}
      {(visibleFolders.length > 0 || folderPath.length > 0) && (
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mt-5 mb-3">
          {folderPath.length > 0 ? `Eventos en "${folderPath[folderPath.length - 1].name}"` : 'Eventos sin carpeta'}
        </p>
      )}

      {/* ─── Events ──────────────────────────────────────────────────────────── */}
      {events.length === 0 && visibleFolders.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-slate-200">
          <CalendarDays className="w-12 h-12 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-500 font-medium">No hay eventos</p>
          <p className="text-slate-400 text-sm mt-1">Crea tu primer evento para empezar</p>
        </div>
      ) : events.length === 0 ? (
        <div className="text-center py-10 bg-white rounded-xl border border-dashed border-slate-200">
          <FolderOpen className="w-10 h-10 text-slate-300 mx-auto mb-2" />
          <p className="text-slate-500 text-sm">No hay eventos aquí</p>
          <p className="text-slate-400 text-xs mt-0.5">Arrastra eventos a esta carpeta o crea uno nuevo</p>
        </div>
      ) : viewMode === 'list' ? (
        /* List View */
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50">
                <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider px-4 py-3">Evento</th>
                <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider px-4 py-3">Fecha</th>
                <th className="hidden sm:table-cell text-left text-xs font-semibold text-slate-500 uppercase tracking-wider px-4 py-3">Ubicación</th>
                <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider px-4 py-3">Estado</th>
                <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider px-4 py-3">Part.</th>
                <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider px-4 py-3">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {events.map(ev => {
                const statusOpt = STATUS_OPTIONS.find(s => s.value === ev.status)
                return (
                  <tr key={ev.id} draggable onDragStart={e => handleDragStart(e, ev.id)}
                    className="hover:bg-slate-50 transition-colors cursor-pointer"
                    onClick={() => router.push(`/dashboard/events/${ev.id}`)}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: ev.color }} />
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-slate-900 truncate">{ev.name}</p>
                          {ev.description && <p className="text-xs text-slate-500 truncate max-w-[220px]">{ev.description}</p>}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-600">
                      {ev.event_date ? format(new Date(ev.event_date), "d MMM yyyy", { locale: es }) : '-'}
                    </td>
                    <td className="hidden sm:table-cell px-4 py-3 text-sm text-slate-600 max-w-[140px] truncate">
                      {ev.location || '-'}
                    </td>
                    <td className="px-4 py-3">
                      {statusOpt && (
                        <span className={`${statusOpt.color} text-xs font-medium px-2 py-1 rounded-full`}>{statusOpt.label}</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <Users className="w-3.5 h-3.5 text-slate-400" />
                        <span className="text-sm text-slate-600">{ev.total_participants}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <button onClick={e => { e.stopPropagation(); router.push(`/dashboard/events/${ev.id}`) }}
                          className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors" title="Ver detalle">
                          <Eye className="w-4 h-4" />
                        </button>
                        <div className="relative">
                          <button data-menu-toggle onClick={e => { e.stopPropagation(); setShowMoveMenu(showMoveMenu === ev.id ? null : ev.id) }}
                            className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors" title="Mover">
                            <MoveRight className="w-4 h-4" />
                          </button>
                          {showMoveMenu === ev.id && (
                            <div className="absolute right-0 z-20 bg-white border border-slate-200 rounded-xl shadow-lg py-1 min-w-[160px]" onClick={e => e.stopPropagation()}>
                              <p className="px-3 py-1.5 text-xs font-semibold text-slate-400 uppercase">Mover a</p>
                              {ev.folder_id && (
                                <button onClick={() => { moveEventToFolder(ev.id, null); setShowMoveMenu(null) }}
                                  className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">
                                  <Home className="w-3.5 h-3.5" /> Sin carpeta
                                </button>
                              )}
                              {folders.filter(f => f.id !== ev.folder_id).map(f => (
                                <button key={f.id} onClick={() => { moveEventToFolder(ev.id, f.id); setShowMoveMenu(null) }}
                                  className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">
                                  <span className="text-base">{f.icon}</span> {f.name}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                        <button onClick={e => { e.stopPropagation(); openEditEvent(ev) }}
                          className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button onClick={e => { e.stopPropagation(); handleDeleteEvent(ev.id) }}
                          className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : viewMode === 'compact' ? (
        /* Compact View */
        <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
          {events.map(ev => {
            const statusOpt = STATUS_OPTIONS.find(s => s.value === ev.status)
            return (
              <div key={ev.id} draggable onDragStart={e => handleDragStart(e, ev.id)}
                className="bg-white border border-slate-200 rounded-xl overflow-hidden hover:shadow-sm hover:border-slate-300 transition-all group cursor-pointer"
                onClick={() => router.push(`/dashboard/events/${ev.id}`)}>
                <div className="h-1" style={{ backgroundColor: ev.color }} />
                <div className="p-3">
                  <div className="flex items-start justify-between gap-1">
                    <p className="text-sm font-semibold text-slate-800 leading-snug line-clamp-2 flex-1">{ev.name}</p>
                    <button onClick={e => { e.stopPropagation(); openEditEvent(ev) }}
                      className="opacity-0 group-hover:opacity-100 flex-shrink-0 p-0.5 text-slate-400 hover:text-slate-600 rounded">
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  {ev.event_date && (
                    <div className="flex items-center gap-1 mt-2 text-xs text-slate-500">
                      <Clock className="w-3 h-3" />
                      {format(new Date(ev.event_date), "d MMM", { locale: es })}
                    </div>
                  )}
                  <div className="flex items-center justify-between mt-2">
                    <div className="flex items-center gap-1 text-xs text-slate-500">
                      <Users className="w-3 h-3" />{ev.total_participants}
                    </div>
                    {statusOpt && (
                      <span className={`${statusOpt.color} text-xs font-medium px-1.5 py-0.5 rounded-full`}>{statusOpt.label}</span>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        /* Grid View */
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {events.map(ev => {
            const statusOpt = STATUS_OPTIONS.find(s => s.value === ev.status)
            const counts = ev.participant_counts || {}
            const total = ev.total_participants || 0
            return (
              <div key={ev.id} draggable onDragStart={e => handleDragStart(e, ev.id)}
                className="bg-white rounded-xl border border-slate-200 overflow-hidden hover:shadow-md transition-shadow group cursor-grab active:cursor-grabbing">
                <div className="h-1.5" style={{ backgroundColor: ev.color }} />
                <div className="p-5">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold text-slate-900 truncate">{ev.name}</h3>
                      {ev.description && <p className="text-slate-500 text-sm mt-0.5 line-clamp-2">{ev.description}</p>}
                    </div>
                    <div className="flex items-center gap-1 ml-2 flex-shrink-0">
                      {statusOpt && (
                        <span className={`${statusOpt.color} text-xs font-medium px-2 py-1 rounded-full`}>{statusOpt.label}</span>
                      )}
                      <div className="relative">
                        <button data-menu-toggle onClick={e => { e.stopPropagation(); setMenuEventID(menuEventID === ev.id ? null : ev.id) }}
                          className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg opacity-0 group-hover:opacity-100 transition-all">
                          <MoreHorizontal className="w-4 h-4" />
                        </button>
                        {menuEventID === ev.id && (
                          <div className="absolute right-0 top-7 z-20 bg-white border border-slate-200 rounded-xl shadow-lg py-1 min-w-[160px]" onClick={e => e.stopPropagation()}>
                            <button onClick={() => { router.push(`/dashboard/events/${ev.id}`); setMenuEventID(null) }}
                              className="w-full flex items-center gap-2 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">
                              <Eye className="w-3.5 h-3.5" /> Ver detalle
                            </button>
                            <button onClick={() => { openEditEvent(ev); setMenuEventID(null) }}
                              className="w-full flex items-center gap-2 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">
                              <Edit2 className="w-3.5 h-3.5" /> Editar
                            </button>
                            <div className="border-t border-slate-100 my-1" />
                            <p className="px-3 py-1 text-xs font-semibold text-slate-400 uppercase">Mover a</p>
                            {ev.folder_id && (
                              <button onClick={() => { moveEventToFolder(ev.id, null); setMenuEventID(null) }}
                                className="w-full flex items-center gap-2 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">
                                <Home className="w-3.5 h-3.5" /> Sin carpeta
                              </button>
                            )}
                            {folders.filter(f => f.id !== ev.folder_id).map(f => (
                              <button key={f.id} onClick={() => { moveEventToFolder(ev.id, f.id); setMenuEventID(null) }}
                                className="w-full flex items-center gap-2 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">
                                <span className="text-base">{f.icon}</span> {f.name}
                              </button>
                            ))}
                            <div className="border-t border-slate-100 my-1" />
                            <button onClick={() => { handleDeleteEvent(ev.id); setMenuEventID(null) }}
                              className="w-full flex items-center gap-2 px-4 py-2 text-sm text-red-600 hover:bg-red-50">
                              <Trash2 className="w-3.5 h-3.5" /> Eliminar
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="space-y-1.5 text-sm text-slate-500 mb-4">
                    {ev.event_date && (
                      <div className="flex items-center gap-2">
                        <Clock className="w-3.5 h-3.5" />
                        <span>{format(new Date(ev.event_date), "d MMM yyyy, HH:mm", { locale: es })}</span>
                      </div>
                    )}
                    {ev.location && (
                      <div className="flex items-center gap-2">
                        <MapPin className="w-3.5 h-3.5" />
                        <span className="truncate">{ev.location}</span>
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <Users className="w-3.5 h-3.5" />
                      <span>{total} participantes</span>
                    </div>
                  </div>

                  {total > 0 && (
                    <div className="mb-4">
                      <div className="flex h-1.5 rounded-full overflow-hidden bg-slate-100">
                        {PARTICIPANT_STATUSES.map(ps => {
                          const count = counts[ps.key] || 0
                          if (count === 0) return null
                          return (
                            <div key={ps.key} className={ps.color}
                              style={{ width: `${(count / total) * 100}%` }}
                              title={`${ps.label}: ${count}`} />
                          )
                        })}
                      </div>
                    </div>
                  )}

                  <div className="flex items-center gap-2 pt-3 border-t border-slate-100">
                    <button onClick={() => router.push(`/dashboard/events/${ev.id}`)}
                      className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm bg-emerald-50 text-emerald-700 rounded-lg hover:bg-emerald-100 transition-colors font-medium">
                      <Eye className="w-3.5 h-3.5" />
                      Ver detalle
                    </button>
                    <button onClick={() => openEditEvent(ev)}
                      className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">
                      <Edit2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Drop zone to move events back to parent when inside a folder */}
      {folderPath.length > 0 && (
        <div
          onDragOver={e => { e.preventDefault(); setDragOverFolderID('__root__') }}
          onDragLeave={() => setDragOverFolderID(null)}
          onDrop={async e => {
            e.preventDefault()
            setDragOverFolderID(null)
            const eventID = dragEventIDRef.current
            if (!eventID) return
            dragEventIDRef.current = null
            await moveEventToFolder(eventID, folderPath.length > 1 ? folderPath[folderPath.length - 2].id : null)
          }}
          className={`mt-4 flex items-center justify-center gap-2 px-6 py-4 border-2 border-dashed rounded-xl transition-all text-sm ${
            dragOverFolderID === '__root__'
              ? 'border-emerald-400 bg-emerald-50 text-emerald-600'
              : 'border-slate-200 text-slate-400 hover:border-slate-300'
          }`}>
          <ArrowLeft className="w-4 h-4" />
          Suelta aquí para mover a «{folderPath.length > 1 ? folderPath[folderPath.length - 2].name : 'Raíz'}»
        </div>
      )}

      {/* Modals */}
      {showCreate && renderEventForm(handleCreateEvent, 'Crear')}
      {editEvent && renderEventForm(handleUpdateEvent, 'Guardar')}
      {showFolderModal && renderFolderModal()}
    </div>
  )
}

