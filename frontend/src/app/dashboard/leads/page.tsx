'use client'

import { useEffect, useState, useCallback } from 'react'
import { Search, Plus, Phone, Mail, User, Tag, Calendar, MoreVertical, MessageCircle, Trash2, Edit, ChevronDown, Filter, CheckSquare, Square, XCircle, Clock, FileText, X, Maximize2 } from 'lucide-react'
import { formatDistanceToNow, format } from 'date-fns'
import { es } from 'date-fns/locale'

interface Lead {
  id: string
  jid: string
  name: string
  phone: string
  email: string
  status: string
  notes: string
  tags: string[]
  assigned_to: string
  created_at: string
  updated_at: string
}

interface Observation {
  id: string
  contact_id: string | null
  lead_id: string | null
  type: string
  direction: string | null
  outcome: string | null
  notes: string | null
  created_by_name: string | null
  created_at: string
}

const STATUS_OPTIONS = [
  { value: 'new', label: 'Nuevo', color: 'bg-blue-100 text-blue-700' },
  { value: 'contacted', label: 'Contactado', color: 'bg-yellow-100 text-yellow-700' },
  { value: 'qualified', label: 'Calificado', color: 'bg-purple-100 text-purple-700' },
  { value: 'proposal', label: 'Propuesta', color: 'bg-orange-100 text-orange-700' },
  { value: 'negotiation', label: 'Negociación', color: 'bg-pink-100 text-pink-700' },
  { value: 'won', label: 'Ganado', color: 'bg-green-100 text-green-700' },
  { value: 'lost', label: 'Perdido', color: 'bg-red-100 text-red-700' },
]

export default function LeadsPage() {
  const [leads, setLeads] = useState<Lead[]>([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [filterStatus, setFilterStatus] = useState<string>('')
  const [showAddModal, setShowAddModal] = useState(false)
  const [showEditModal, setShowEditModal] = useState(false)
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState(false)
  const [draggedLeadId, setDraggedLeadId] = useState<string | null>(null)
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null)
  const [formData, setFormData] = useState({
    name: '',
    phone: '',
    email: '',
    status: 'new',
    notes: '',
    tags: '',
  })

  // Detail panel
  const [showDetailPanel, setShowDetailPanel] = useState(false)
  const [detailLead, setDetailLead] = useState<Lead | null>(null)
  const [observations, setObservations] = useState<Observation[]>([])
  const [loadingObservations, setLoadingObservations] = useState(false)
  const [newObservation, setNewObservation] = useState('')
  const [savingObservation, setSavingObservation] = useState(false)
  const [obsDisplayCount, setObsDisplayCount] = useState(5)
  const [showHistoryModal, setShowHistoryModal] = useState(false)
  const [historyFilterType, setHistoryFilterType] = useState('')
  const [historyFilterFrom, setHistoryFilterFrom] = useState('')
  const [historyFilterTo, setHistoryFilterTo] = useState('')

  const fetchLeads = useCallback(async () => {
    const token = localStorage.getItem('token')
    try {
      const res = await fetch('/api/leads', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        setLeads(data.leads || [])
      }
    } catch (err) {
      console.error('Failed to fetch leads:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchLeads()
  }, [fetchLeads])

  const handleCreateLead = async () => {
    const token = localStorage.getItem('token')
    try {
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          ...formData,
          tags: formData.tags.split(',').map(t => t.trim()).filter(Boolean),
        }),
      })
      const data = await res.json()
      if (data.success) {
        setShowAddModal(false)
        setFormData({ name: '', phone: '', email: '', status: 'new', notes: '', tags: '' })
        fetchLeads()
      } else {
        alert(data.error || 'Error al crear lead')
      }
    } catch (err) {
      console.error('Failed to create lead:', err)
      alert('Error al crear lead')
    }
  }

  const handleUpdateLead = async () => {
    if (!selectedLead) return
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/leads/${selectedLead.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          ...formData,
          tags: formData.tags.split(',').map(t => t.trim()).filter(Boolean),
        }),
      })
      const data = await res.json()
      if (data.success) {
        setShowEditModal(false)
        setSelectedLead(null)
        fetchLeads()
      } else {
        alert(data.error || 'Error al actualizar lead')
      }
    } catch (err) {
      console.error('Failed to update lead:', err)
      alert('Error al actualizar lead')
    }
  }

  const handleDeleteLead = async (leadId: string) => {
    if (!confirm('¿Estás seguro de eliminar este lead?')) return
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/leads/${leadId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        fetchLeads()
      } else {
        alert(data.error || 'Error al eliminar lead')
      }
    } catch (err) {
      console.error('Failed to delete lead:', err)
      alert('Error al eliminar lead')
    }
  }

  const handleDeleteSelected = async () => {
    if (selectedIds.size === 0) return
    if (!confirm(`¿Estás seguro de eliminar ${selectedIds.size} lead(s)?`)) return
    
    const token = localStorage.getItem('token')
    setDeleting(true)
    try {
      const res = await fetch('/api/leads/batch', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ ids: Array.from(selectedIds) }),
      })
      const data = await res.json()
      if (data.success) {
        setSelectedIds(new Set())
        setSelectionMode(false)
        fetchLeads()
      } else {
        alert(data.error || 'Error al eliminar leads')
      }
    } catch (err) {
      console.error('Failed to delete leads:', err)
      alert('Error al eliminar leads')
    } finally {
      setDeleting(false)
    }
  }

  const handleDeleteAll = async () => {
    if (!confirm('¿Estás seguro de eliminar TODOS los leads? Esta acción no se puede deshacer.')) return
    if (!confirm('Esta acción eliminará todos los leads permanentemente. ¿Continuar?')) return
    
    const token = localStorage.getItem('token')
    setDeleting(true)
    try {
      const res = await fetch('/api/leads/batch', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ delete_all: true }),
      })
      const data = await res.json()
      if (data.success) {
        setSelectedIds(new Set())
        setSelectionMode(false)
        fetchLeads()
      } else {
        alert(data.error || 'Error al eliminar leads')
      }
    } catch (err) {
      console.error('Failed to delete all leads:', err)
      alert('Error al eliminar leads')
    } finally {
      setDeleting(false)
    }
  }

  const toggleSelection = (leadId: string) => {
    const newSelected = new Set(selectedIds)
    if (newSelected.has(leadId)) {
      newSelected.delete(leadId)
    } else {
      newSelected.add(leadId)
    }
    setSelectedIds(newSelected)
  }

  const selectAll = () => {
    setSelectedIds(new Set(filteredLeads.map(l => l.id)))
  }

  const deselectAll = () => {
    setSelectedIds(new Set())
  }

  const handleUpdateStatus = async (leadId: string, newStatus: string) => {
    const token = localStorage.getItem('token')
    try {
      await fetch(`/api/leads/${leadId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ status: newStatus }),
      })
      fetchLeads()
    } catch (err) {
      console.error('Failed to update status:', err)
    }
  }

  const openEditModal = (lead: Lead) => {
    setSelectedLead(lead)
    setFormData({
      name: lead.name || '',
      phone: lead.phone || '',
      email: lead.email || '',
      status: lead.status || 'new',
      notes: lead.notes || '',
      tags: (lead.tags || []).join(', '),
    })
    setShowEditModal(true)
  }

  const openDetailPanel = (lead: Lead) => {
    setDetailLead(lead)
    setShowDetailPanel(true)
    setObsDisplayCount(5)
    fetchObservations(lead.id)
  }

  const fetchObservations = async (leadId: string) => {
    setLoadingObservations(true)
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/leads/${leadId}/interactions?limit=100`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        setObservations(data.interactions || [])
      }
    } catch (err) {
      console.error('Failed to fetch observations:', err)
    } finally {
      setLoadingObservations(false)
    }
  }

  const handleAddObservation = async () => {
    if (!detailLead || !newObservation.trim()) return
    setSavingObservation(true)
    const token = localStorage.getItem('token')
    try {
      const res = await fetch('/api/interactions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          lead_id: detailLead.id,
          type: 'note',
          notes: newObservation.trim(),
        }),
      })
      const data = await res.json()
      if (data.success) {
        setNewObservation('')
        fetchObservations(detailLead.id)
      }
    } catch (err) {
      console.error('Failed to add observation:', err)
    } finally {
      setSavingObservation(false)
    }
  }

  const handleDeleteObservation = async (obsId: string) => {
    if (!detailLead) return
    if (!confirm('¿Eliminar esta observación?')) return
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/interactions/${obsId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        fetchObservations(detailLead.id)
      }
    } catch (err) {
      console.error('Failed to delete observation:', err)
    }
  }

  const getStatusInfo = (status: string) => {
    return STATUS_OPTIONS.find(s => s.value === status) || STATUS_OPTIONS[0]
  }

  const handleDragStart = (e: React.DragEvent, leadId: string) => {
    setDraggedLeadId(leadId)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', leadId)
    // Make drag image semi-transparent
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '0.5'
    }
  }

  const handleDragEnd = (e: React.DragEvent) => {
    setDraggedLeadId(null)
    setDragOverColumn(null)
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '1'
    }
  }

  const handleDragOver = (e: React.DragEvent, columnStatus: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverColumn(columnStatus)
  }

  const handleDragLeave = () => {
    setDragOverColumn(null)
  }

  const handleDrop = (e: React.DragEvent, targetStatus: string) => {
    e.preventDefault()
    setDragOverColumn(null)
    const leadId = e.dataTransfer.getData('text/plain')
    if (leadId) {
      const lead = leads.find(l => l.id === leadId)
      if (lead && lead.status !== targetStatus) {
        handleUpdateStatus(leadId, targetStatus)
      }
    }
    setDraggedLeadId(null)
  }

  const filteredLeads = leads.filter((lead) => {
    const matchesSearch = 
      (lead.name || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (lead.phone || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (lead.email || '').toLowerCase().includes(searchTerm.toLowerCase())
    const matchesStatus = !filterStatus || lead.status === filterStatus
    return matchesSearch && matchesStatus
  })

  const leadsByStatus = STATUS_OPTIONS.map(status => ({
    ...status,
    leads: filteredLeads.filter(l => l.status === status.value),
  }))

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-600" />
      </div>
    )
  }

  return (
    <div className="space-y-6 overflow-y-auto flex-1 min-h-0">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Leads</h1>
          <p className="text-gray-600 mt-1">{filteredLeads.length} leads en total</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {selectionMode ? (
            <>
              <span className="flex items-center px-3 py-2 text-sm text-gray-600">
                {selectedIds.size} seleccionado(s)
              </span>
              <button
                onClick={selectAll}
                className="px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Seleccionar todos
              </button>
              <button
                onClick={handleDeleteSelected}
                disabled={selectedIds.size === 0 || deleting}
                className="px-3 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
              >
                {deleting ? 'Eliminando...' : `Eliminar (${selectedIds.size})`}
              </button>
              <button
                onClick={handleDeleteAll}
                disabled={deleting || leads.length === 0}
                className="px-3 py-2 text-sm bg-red-800 text-white rounded-lg hover:bg-red-900 disabled:opacity-50"
              >
                Eliminar todos
              </button>
              <button
                onClick={() => {
                  setSelectionMode(false)
                  setSelectedIds(new Set())
                }}
                className="px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                <XCircle className="w-4 h-4" />
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setSelectionMode(true)}
                className="inline-flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition"
              >
                <CheckSquare className="w-5 h-5" />
                Seleccionar
              </button>
              <button
                onClick={() => setShowAddModal(true)}
                className="inline-flex items-center gap-2 bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 transition"
              >
                <Plus className="w-5 h-5" />
                Nuevo Lead
              </button>
            </>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Buscar por nombre, teléfono o email..."
            className="w-full pl-10 pr-4 py-2.5 bg-white border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 text-gray-900 placeholder:text-gray-400"
          />
        </div>
        <div className="relative">
          <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="pl-10 pr-8 py-2.5 bg-white border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 appearance-none cursor-pointer text-gray-900"
          >
            <option value="">Todos los estados</option>
            {STATUS_OPTIONS.map(status => (
              <option key={status.value} value={status.value}>{status.label}</option>
            ))}
          </select>
          <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
        </div>
      </div>

      {/* Pipeline view */}
      <div className="overflow-x-auto pb-4">
        <div className="flex gap-4 min-w-max">
          {leadsByStatus.map((column) => (
            <div key={column.value} className="w-72 flex-shrink-0">
              <div className={`p-3 rounded-t-lg ${column.color}`}>
                <div className="flex items-center justify-between">
                  <span className="font-medium">{column.label}</span>
                  <span className="text-sm">{column.leads.length}</span>
                </div>
              </div>
              <div
                className={`bg-gray-100 rounded-b-lg p-2 min-h-[200px] space-y-2 transition-colors ${
                  dragOverColumn === column.value ? 'bg-green-50 ring-2 ring-green-300 ring-inset' : ''
                }`}
                onDragOver={(e) => handleDragOver(e, column.value)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, column.value)}
              >
                {column.leads.map((lead) => (
                  <div
                    key={lead.id}
                    draggable={!selectionMode}
                    onDragStart={(e) => handleDragStart(e, lead.id)}
                    onDragEnd={handleDragEnd}
                    className={`bg-white p-3 rounded-lg shadow-sm border hover:shadow-md transition cursor-pointer ${
                      selectedIds.has(lead.id) ? 'border-green-500 ring-2 ring-green-200' : 'border-gray-200'
                    } ${draggedLeadId === lead.id ? 'opacity-50' : ''} ${!selectionMode ? 'cursor-grab active:cursor-grabbing' : ''}`}
                    onClick={() => selectionMode ? toggleSelection(lead.id) : openDetailPanel(lead)}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2">
                        {selectionMode ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              toggleSelection(lead.id)
                            }}
                            className="p-0.5"
                          >
                            {selectedIds.has(lead.id) ? (
                              <CheckSquare className="w-5 h-5 text-green-600" />
                            ) : (
                              <Square className="w-5 h-5 text-gray-400" />
                            )}
                          </button>
                        ) : (
                          <div className="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center">
                            <span className="text-green-700 text-sm font-medium">
                              {(lead.name || '?').charAt(0).toUpperCase()}
                            </span>
                          </div>
                        )}
                        <p className="font-medium text-gray-900 truncate max-w-[150px]">
                          {lead.name || 'Sin nombre'}
                        </p>
                      </div>
                      {!selectionMode && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            handleDeleteLead(lead.id)
                          }}
                          className="p-1 text-gray-400 hover:text-red-500"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                    {lead.phone && (
                      <div className="flex items-center gap-2 mt-2 text-sm text-gray-600">
                        <Phone className="w-3.5 h-3.5" />
                        {lead.phone}
                      </div>
                    )}
                    {lead.email && (
                      <div className="flex items-center gap-2 mt-1 text-sm text-gray-600">
                        <Mail className="w-3.5 h-3.5" />
                        <span className="truncate max-w-[180px]">{lead.email}</span>
                      </div>
                    )}
                    {lead.tags && lead.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {lead.tags.slice(0, 2).map((tag, i) => (
                          <span key={i} className="px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded">
                            {tag}
                          </span>
                        ))}
                        {lead.tags.length > 2 && (
                          <span className="px-2 py-0.5 text-gray-400 text-xs">
                            +{lead.tags.length - 2}
                          </span>
                        )}
                      </div>
                    )}
                    <div className="flex items-center justify-between mt-2 text-xs text-gray-400">
                      <span>{formatDistanceToNow(new Date(lead.created_at), { locale: es })}</span>
                      <MessageCircle className="w-3.5 h-3.5" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Add Lead Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl p-6 w-full max-w-md">
            <h2 className="text-xl font-bold text-gray-900 mb-4">Nuevo Lead</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Nombre *</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 text-gray-900 placeholder:text-gray-400"
                  placeholder="Nombre del lead"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Teléfono</label>
                <input
                  type="tel"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 text-gray-900 placeholder:text-gray-400"
                  placeholder="+51 999 888 777"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                <input
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 text-gray-900 placeholder:text-gray-400"
                  placeholder="correo@ejemplo.com"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Estado</label>
                <select
                  value={formData.status}
                  onChange={(e) => setFormData({ ...formData, status: e.target.value })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 text-gray-900 placeholder:text-gray-400"
                >
                  {STATUS_OPTIONS.map(s => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Etiquetas</label>
                <input
                  type="text"
                  value={formData.tags}
                  onChange={(e) => setFormData({ ...formData, tags: e.target.value })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 text-gray-900 placeholder:text-gray-400"
                  placeholder="ventas, premium, urgente (separadas por coma)"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notas</label>
                <textarea
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  rows={3}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 text-gray-900 placeholder:text-gray-400"
                  placeholder="Notas adicionales sobre el lead..."
                />
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => {
                  setShowAddModal(false)
                  setFormData({ name: '', phone: '', email: '', status: 'new', notes: '', tags: '' })
                }}
                className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
              >
                Cancelar
              </button>
              <button
                onClick={handleCreateLead}
                disabled={!formData.name}
                className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
              >
                Crear Lead
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Lead Modal */}
      {showEditModal && selectedLead && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4">
          <div className="bg-white rounded-xl p-6 w-full max-w-md max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold text-gray-900 mb-4">Editar Lead</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Nombre *</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 text-gray-900 placeholder:text-gray-400"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Teléfono</label>
                <input
                  type="tel"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 text-gray-900 placeholder:text-gray-400"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                <input
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 text-gray-900 placeholder:text-gray-400"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Estado</label>
                <select
                  value={formData.status}
                  onChange={(e) => setFormData({ ...formData, status: e.target.value })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 text-gray-900 placeholder:text-gray-400"
                >
                  {STATUS_OPTIONS.map(s => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Etiquetas</label>
                <input
                  type="text"
                  value={formData.tags}
                  onChange={(e) => setFormData({ ...formData, tags: e.target.value })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 text-gray-900 placeholder:text-gray-400"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notas</label>
                <textarea
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  rows={3}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 text-gray-900 placeholder:text-gray-400"
                />
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => {
                  setShowEditModal(false)
                  setSelectedLead(null)
                }}
                className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
              >
                Cancelar
              </button>
              <button
                onClick={() => {
                  handleUpdateLead()
                  if (detailLead && selectedLead && detailLead.id === selectedLead.id) {
                    setTimeout(() => {
                      const updated = leads.find(l => l.id === selectedLead.id)
                      if (updated) setDetailLead(updated)
                    }, 500)
                  }
                }}
                disabled={!formData.name}
                className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
              >
                Guardar Cambios
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Lead Detail Panel (Slide-over) */}
      {showDetailPanel && detailLead && (
        <div className="fixed inset-0 z-50 flex justify-end overflow-hidden">
          <div className="absolute inset-0 bg-black/30" onClick={() => { setShowDetailPanel(false); setNewObservation('') }} />
          <div className="relative w-full max-w-md bg-white shadow-xl overflow-y-auto overscroll-contain">
            {/* Header */}
            <div className="sticky top-0 bg-white border-b border-gray-200 p-4 flex items-center justify-between z-10">
              <h2 className="text-lg font-semibold text-gray-900">Detalle del Lead</h2>
              <button onClick={() => { setShowDetailPanel(false); setNewObservation('') }} className="p-1 hover:bg-gray-100 rounded">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-6">
              {/* Lead Info */}
              <div className="flex items-center gap-4">
                <div className="w-14 h-14 bg-green-100 rounded-full flex items-center justify-center">
                  <span className="text-green-700 font-bold text-lg">
                    {(detailLead.name || '?').charAt(0).toUpperCase()}
                  </span>
                </div>
                <div>
                  <h3 className="text-xl font-bold text-gray-900">{detailLead.name || 'Sin nombre'}</h3>
                  <span className={`inline-block px-2 py-0.5 text-xs rounded-full mt-1 ${getStatusInfo(detailLead.status).color}`}>
                    {getStatusInfo(detailLead.status).label}
                  </span>
                </div>
              </div>

              {/* Info fields */}
              <div className="space-y-3">
                {detailLead.phone && (
                  <div className="flex items-center gap-3 text-gray-700">
                    <Phone className="w-4 h-4 text-gray-400" />
                    <span>{detailLead.phone}</span>
                  </div>
                )}
                {detailLead.email && (
                  <div className="flex items-center gap-3 text-gray-700">
                    <Mail className="w-4 h-4 text-gray-400" />
                    <span>{detailLead.email}</span>
                  </div>
                )}
                {detailLead.tags && detailLead.tags.length > 0 && (
                  <div className="flex items-start gap-3">
                    <Tag className="w-4 h-4 text-gray-400 mt-1" />
                    <div className="flex flex-wrap gap-1">
                      {detailLead.tags.map((tag, i) => (
                        <span key={i} className="px-2 py-1 bg-green-50 text-green-700 text-xs rounded-full">
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {detailLead.notes && (
                  <div className="p-3 bg-gray-50 rounded-lg text-sm text-gray-700">
                    <p className="font-medium text-gray-500 text-xs mb-1">Notas</p>
                    {detailLead.notes}
                  </div>
                )}
              </div>

              {/* Actions */}
              <div className="flex flex-col gap-2 pt-2 border-t border-gray-200">
                <button
                  onClick={() => openEditModal(detailLead)}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
                >
                  <Edit className="w-4 h-4" />
                  Editar Lead
                </button>
                <button
                  onClick={() => {
                    handleDeleteLead(detailLead.id)
                    setShowDetailPanel(false)
                  }}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 border border-red-200 text-red-600 rounded-lg hover:bg-red-50"
                >
                  <Trash2 className="w-4 h-4" />
                  Eliminar
                </button>
              </div>

              {/* Observations / History */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-semibold text-gray-600 flex items-center gap-2">
                    <FileText className="w-4 h-4" />
                    Historial de Observaciones
                  </h4>
                  {observations.length > 0 && (
                    <button
                      onClick={() => setShowHistoryModal(true)}
                      className="p-1.5 text-gray-400 hover:text-green-600 hover:bg-green-50 rounded-lg transition"
                      title="Ver historial completo"
                    >
                      <Maximize2 className="w-4 h-4" />
                    </button>
                  )}
                </div>

                {/* Add new observation */}
                <div className="mb-3">
                  <textarea
                    value={newObservation}
                    onChange={(e) => setNewObservation(e.target.value)}
                    placeholder="Escribir una observación..."
                    rows={2}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 text-sm text-gray-900 placeholder:text-gray-400 resize-none"
                  />
                  <button
                    onClick={handleAddObservation}
                    disabled={!newObservation.trim() || savingObservation}
                    className="mt-1.5 inline-flex items-center gap-1.5 px-3 py-1.5 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700 disabled:opacity-50 transition"
                  >
                    {savingObservation ? (
                      <div className="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-white" />
                    ) : (
                      <Plus className="w-3.5 h-3.5" />
                    )}
                    Agregar
                  </button>
                </div>

                {/* Observations list */}
                {loadingObservations ? (
                  <div className="flex justify-center py-4">
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-green-600" />
                  </div>
                ) : observations.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-3">Sin observaciones aún</p>
                ) : (
                  <div className="space-y-2">
                    {observations.slice(0, obsDisplayCount).map((obs) => (
                      <div key={obs.id} className="p-3 bg-gray-50 rounded-lg group relative">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-gray-800 whitespace-pre-wrap break-words">
                              {obs.notes || '(sin contenido)'}
                            </p>
                            <div className="flex items-center gap-2 mt-1.5">
                              <Clock className="w-3 h-3 text-gray-400" />
                              <span className="text-xs text-gray-400">
                                {formatDistanceToNow(new Date(obs.created_at), { locale: es, addSuffix: true })}
                              </span>
                              {obs.created_by_name && (
                                <span className="text-xs text-gray-500">
                                  &mdash; {obs.created_by_name}
                                </span>
                              )}
                              {obs.type !== 'note' && (
                                <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 text-xs rounded">
                                  {obs.type}
                                </span>
                              )}
                            </div>
                          </div>
                          <button
                            onClick={() => handleDeleteObservation(obs.id)}
                            className="p-1 text-gray-300 hover:text-red-500 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity shrink-0"
                            title="Eliminar"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                    {observations.length > obsDisplayCount && (
                      <button
                        onClick={() => setObsDisplayCount(prev => prev + 10)}
                        className="w-full py-2 text-sm text-green-600 hover:text-green-700 hover:bg-green-50 rounded-lg transition font-medium"
                      >
                        Mostrar más ({observations.length - obsDisplayCount} restantes)
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div className="text-xs text-gray-400 space-y-1">
                <p>Creado: {new Date(detailLead.created_at).toLocaleDateString('es')}</p>
                <p>Actualizado: {formatDistanceToNow(new Date(detailLead.updated_at), { locale: es, addSuffix: true })}</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Full History Modal */}
      {showHistoryModal && detailLead && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Historial Completo</h2>
                <p className="text-sm text-gray-500">{detailLead.name || 'Sin nombre'} &mdash; {observations.length} registros</p>
              </div>
              <button onClick={() => { setShowHistoryModal(false); setHistoryFilterType(''); setHistoryFilterFrom(''); setHistoryFilterTo('') }} className="p-1 text-gray-400 hover:text-gray-600 rounded">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Filters */}
            <div className="px-6 py-3 border-b border-gray-100 bg-gray-50">
              <div className="flex items-center gap-3 flex-wrap">
                <div>
                  <label className="text-[10px] text-gray-500 uppercase tracking-wider mb-1 block">Tipo</label>
                  <select
                    value={historyFilterType}
                    onChange={(e) => setHistoryFilterType(e.target.value)}
                    className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm text-gray-700 focus:ring-2 focus:ring-green-500"
                  >
                    <option value="">Todos</option>
                    <option value="note">Nota</option>
                    <option value="call">Llamada</option>
                    <option value="whatsapp">WhatsApp</option>
                    <option value="email">Email</option>
                    <option value="meeting">Reunión</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] text-gray-500 uppercase tracking-wider mb-1 block">Desde</label>
                  <input
                    type="date"
                    value={historyFilterFrom}
                    onChange={(e) => setHistoryFilterFrom(e.target.value)}
                    className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm text-gray-700 focus:ring-2 focus:ring-green-500"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-gray-500 uppercase tracking-wider mb-1 block">Hasta</label>
                  <input
                    type="date"
                    value={historyFilterTo}
                    onChange={(e) => setHistoryFilterTo(e.target.value)}
                    className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm text-gray-700 focus:ring-2 focus:ring-green-500"
                  />
                </div>
                {(historyFilterType || historyFilterFrom || historyFilterTo) && (
                  <button
                    onClick={() => { setHistoryFilterType(''); setHistoryFilterFrom(''); setHistoryFilterTo('') }}
                    className="mt-4 text-xs text-gray-500 hover:text-red-600 flex items-center gap-1"
                  >
                    <XCircle className="w-3.5 h-3.5" />
                    Limpiar
                  </button>
                )}
              </div>
            </div>

            {/* History list */}
            <div className="flex-1 overflow-y-auto p-6">
              {(() => {
                const filtered = observations.filter(obs => {
                  if (historyFilterType && obs.type !== historyFilterType) return false
                  if (historyFilterFrom && new Date(obs.created_at) < new Date(historyFilterFrom)) return false
                  if (historyFilterTo) {
                    const to = new Date(historyFilterTo)
                    to.setDate(to.getDate() + 1)
                    if (new Date(obs.created_at) >= to) return false
                  }
                  return true
                })
                if (filtered.length === 0) return <p className="text-sm text-gray-400 text-center py-8">No hay registros con los filtros seleccionados</p>
                return (
                  <div className="space-y-3">
                    {filtered.map((obs) => (
                      <div key={obs.id} className="p-4 bg-gray-50 rounded-lg group relative border border-gray-100">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <span className={`px-2 py-0.5 text-xs rounded font-medium ${obs.type === 'note' ? 'bg-yellow-100 text-yellow-700' : obs.type === 'call' ? 'bg-blue-100 text-blue-700' : obs.type === 'whatsapp' ? 'bg-green-100 text-green-700' : obs.type === 'email' ? 'bg-purple-100 text-purple-700' : 'bg-orange-100 text-orange-700'}`}>
                                {obs.type === 'note' ? 'Nota' : obs.type === 'call' ? 'Llamada' : obs.type === 'whatsapp' ? 'WhatsApp' : obs.type === 'email' ? 'Email' : obs.type === 'meeting' ? 'Reunión' : obs.type}
                              </span>
                              <span className="text-xs text-gray-400">
                                {format(new Date(obs.created_at), "d MMM yyyy, HH:mm", { locale: es })}
                              </span>
                            </div>
                            <p className="text-sm text-gray-800 whitespace-pre-wrap break-words">
                              {obs.notes || '(sin contenido)'}
                            </p>
                            {obs.created_by_name && (
                              <p className="text-xs text-gray-400 mt-1.5">por {obs.created_by_name}</p>
                            )}
                          </div>
                          <button
                            onClick={() => handleDeleteObservation(obs.id)}
                            className="p-1 text-gray-300 hover:text-red-500 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity shrink-0"
                            title="Eliminar"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )
              })()}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
