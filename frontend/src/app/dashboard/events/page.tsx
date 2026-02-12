'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  CalendarDays, Plus, Search, MapPin, Users, Clock, Edit2, Trash2,
  Filter, ChevronDown, Eye
} from 'lucide-react'
import { formatDistanceToNow, format } from 'date-fns'
import { es } from 'date-fns/locale'

interface Event {
  id: string
  name: string
  description?: string
  event_date?: string
  event_end?: string
  location?: string
  status: string
  color: string
  created_at: string
  total_participants: number
  participant_counts?: Record<string, number>
}

const STATUS_OPTIONS = [
  { value: 'active', label: 'Activo', color: 'bg-green-100 text-green-700' },
  { value: 'draft', label: 'Borrador', color: 'bg-gray-100 text-gray-700' },
  { value: 'completed', label: 'Completado', color: 'bg-blue-100 text-blue-700' },
  { value: 'cancelled', label: 'Cancelado', color: 'bg-red-100 text-red-700' },
]

const COLOR_OPTIONS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899',
  '#06b6d4', '#f97316', '#14b8a6', '#6366f1'
]

const PARTICIPANT_STATUSES = [
  { key: 'invited', label: 'Invitados', color: 'bg-blue-500' },
  { key: 'contacted', label: 'Contactados', color: 'bg-yellow-500' },
  { key: 'confirmed', label: 'Confirmados', color: 'bg-green-500' },
  { key: 'declined', label: 'Declinados', color: 'bg-red-500' },
  { key: 'attended', label: 'Asistieron', color: 'bg-emerald-600' },
  { key: 'no_show', label: 'No asistieron', color: 'bg-gray-400' },
]

export default function EventsPage() {
  const router = useRouter()
  const [events, setEvents] = useState<Event[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [editEvent, setEditEvent] = useState<Event | null>(null)
  const [formData, setFormData] = useState({
    name: '', description: '', event_date: '', event_end: '', location: '', color: '#3b82f6', status: 'active',
  })

  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : ''

  const fetchEvents = useCallback(async () => {
    try {
      const params = new URLSearchParams()
      if (search) params.set('search', search)
      if (statusFilter) params.set('status', statusFilter)
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
  }, [token, search, statusFilter])

  useEffect(() => { fetchEvents() }, [fetchEvents])

  const handleCreate = async () => {
    const body: Record<string, unknown> = { ...formData }
    if (formData.event_date) body.event_date = new Date(formData.event_date).toISOString()
    else delete body.event_date
    if (formData.event_end) body.event_end = new Date(formData.event_end).toISOString()
    else delete body.event_end
    if (!formData.description) delete body.description
    if (!formData.location) delete body.location

    const res = await fetch('/api/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (data.success) {
      setShowCreate(false)
      resetForm()
      fetchEvents()
    }
  }

  const handleUpdate = async () => {
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
      resetForm()
      fetchEvents()
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('¿Eliminar este evento y todos sus participantes?')) return
    await fetch(`/api/events/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    fetchEvents()
  }

  const resetForm = () => {
    setFormData({ name: '', description: '', event_date: '', event_end: '', location: '', color: '#3b82f6', status: 'active' })
  }

  const openEdit = (ev: Event) => {
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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-600" />
      </div>
    )
  }

  const renderEventForm = (onSubmit: () => void, submitLabel: string) => (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">{submitLabel === 'Crear' ? 'Nuevo Evento' : 'Editar Evento'}</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Nombre *</label>
              <input
                value={formData.name}
                onChange={e => setFormData({ ...formData, name: e.target.value })}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-900"
                placeholder="Ej: Clase Gratuita de Marketing"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Descripción</label>
              <textarea
                value={formData.description}
                onChange={e => setFormData({ ...formData, description: e.target.value })}
                rows={3}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-900"
                placeholder="Describe la actividad..."
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Fecha inicio</label>
                <input
                  type="datetime-local"
                  value={formData.event_date}
                  onChange={e => setFormData({ ...formData, event_date: e.target.value })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-900"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Fecha fin</label>
                <input
                  type="datetime-local"
                  value={formData.event_end}
                  onChange={e => setFormData({ ...formData, event_end: e.target.value })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-900"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Ubicación</label>
              <input
                value={formData.location}
                onChange={e => setFormData({ ...formData, location: e.target.value })}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-900"
                placeholder="Ej: Zoom, Oficina central..."
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Color</label>
                <div className="flex flex-wrap gap-2">
                  {COLOR_OPTIONS.map(c => (
                    <button
                      key={c}
                      onClick={() => setFormData({ ...formData, color: c })}
                      className={`w-7 h-7 rounded-full border-2 transition-all ${formData.color === c ? 'border-gray-900 scale-110' : 'border-transparent'}`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Estado</label>
                <select
                  value={formData.status}
                  onChange={e => setFormData({ ...formData, status: e.target.value })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-900"
                >
                  {STATUS_OPTIONS.map(s => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-3 mt-6">
            <button onClick={() => { setShowCreate(false); setEditEvent(null); resetForm() }} className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg">
              Cancelar
            </button>
            <button disabled={!formData.name} onClick={onSubmit} className="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50">
              {submitLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  )

  return (
    <div className="space-y-6 overflow-y-auto flex-1 min-h-0">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Eventos</h1>
          <p className="text-gray-500 text-sm mt-1">Gestiona actividades y haz seguimiento a tus contactos</p>
        </div>
        <button
          onClick={() => { resetForm(); setShowCreate(true) }}
          className="flex items-center gap-2 px-4 py-2.5 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors shadow-sm"
        >
          <Plus className="w-4 h-4" />
          Nuevo Evento
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar eventos..."
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-900"
          />
        </div>
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-900"
        >
          <option value="">Todos los estados</option>
          {STATUS_OPTIONS.map(s => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
      </div>

      {/* Events grid */}
      {events.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-200">
          <CalendarDays className="w-12 h-12 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500 font-medium">No hay eventos</p>
          <p className="text-gray-400 text-sm mt-1">Crea tu primer evento para empezar a hacer seguimiento</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {events.map(ev => {
            const statusOpt = STATUS_OPTIONS.find(s => s.value === ev.status)
            const counts = ev.participant_counts || {}
            const total = ev.total_participants || 0
            return (
              <div
                key={ev.id}
                className="bg-white rounded-xl border border-gray-200 overflow-hidden hover:shadow-md transition-shadow group"
              >
                {/* Color bar */}
                <div className="h-1.5" style={{ backgroundColor: ev.color }} />
                <div className="p-5">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold text-gray-900 truncate">{ev.name}</h3>
                      {ev.description && (
                        <p className="text-gray-500 text-sm mt-1 line-clamp-2">{ev.description}</p>
                      )}
                    </div>
                    {statusOpt && (
                      <span className={`${statusOpt.color} text-xs font-medium px-2 py-1 rounded-full ml-2 whitespace-nowrap`}>
                        {statusOpt.label}
                      </span>
                    )}
                  </div>

                  <div className="space-y-2 text-sm text-gray-500 mb-4">
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

                  {/* Progress bar */}
                  {total > 0 && (
                    <div className="mb-4">
                      <div className="flex h-2 rounded-full overflow-hidden bg-gray-100">
                        {PARTICIPANT_STATUSES.map(ps => {
                          const count = counts[ps.key] || 0
                          if (count === 0) return null
                          return (
                            <div
                              key={ps.key}
                              className={`${ps.color}`}
                              style={{ width: `${(count / total) * 100}%` }}
                              title={`${ps.label}: ${count}`}
                            />
                          )
                        })}
                      </div>
                      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2">
                        {PARTICIPANT_STATUSES.map(ps => {
                          const count = counts[ps.key] || 0
                          if (count === 0) return null
                          return (
                            <span key={ps.key} className="text-xs text-gray-500">
                              <span className={`inline-block w-2 h-2 rounded-full ${ps.color} mr-1`} />
                              {count} {ps.label.toLowerCase()}
                            </span>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex items-center gap-2 pt-3 border-t border-gray-100">
                    <button
                      onClick={() => router.push(`/dashboard/events/${ev.id}`)}
                      className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm bg-green-50 text-green-700 rounded-lg hover:bg-green-100 transition-colors font-medium"
                    >
                      <Eye className="w-3.5 h-3.5" />
                      Ver detalle
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); openEdit(ev) }}
                      className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDelete(ev.id) }}
                      className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Create modal */}
      {showCreate && renderEventForm(handleCreate, 'Crear')}
      {editEvent && renderEventForm(handleUpdate, 'Guardar')}
    </div>
  )
}
