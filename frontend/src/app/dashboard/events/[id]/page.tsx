'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { useParams, useRouter } from 'next/navigation'
import {
  ArrowLeft, Users, UserPlus, Search, Phone, MessageSquare, StickyNote, Mail,
  Handshake, CheckCircle2, XCircle, Voicemail, Clock, PhoneOff, CalendarClock,
  PhoneCall, GripVertical, List, LayoutGrid, X, Plus, Trash2,
  Save, Tag, Filter, Send, Pencil, Maximize2,
  MapPin, CalendarDays
} from 'lucide-react'
import { format, formatDistanceToNow } from 'date-fns'
import { es } from 'date-fns/locale'
import CreateCampaignModal, { CampaignFormResult } from '@/components/CreateCampaignModal'

const token = () => typeof window !== 'undefined' ? localStorage.getItem('token') || '' : ''

interface Event {
  id: string; name: string; description?: string; event_date?: string; event_end?: string
  location?: string; status: string; color: string; total_participants: number
  participant_counts?: Record<string, number>
}
interface TagItem {
  id: string; account_id: string; name: string; color: string; created_at: string
}
interface Participant {
  id: string; event_id: string; contact_id?: string; name: string; last_name?: string
  short_name?: string; phone?: string; email?: string; age?: number; status: string; notes?: string
  next_action?: string; next_action_date?: string; invited_at?: string
  confirmed_at?: string; attended_at?: string; last_interaction?: string
  tags?: TagItem[]
}
interface Interaction {
  id: string; type: string; direction: string; outcome: string; notes?: string
  next_action?: string; next_action_date?: string; created_by_name?: string; created_at: string
}
interface Contact {
  id: string; name: string; phone: string; email?: string
}
interface Device {
  id: string; name: string; phone_number: string; status: string
}

const STATUSES = [
  { key: 'invited', label: 'Invitados', color: 'bg-blue-500', bgLight: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-700' },
  { key: 'contacted', label: 'Contactados', color: 'bg-yellow-500', bgLight: 'bg-yellow-50', border: 'border-yellow-200', text: 'text-yellow-700' },
  { key: 'confirmed', label: 'Confirmados', color: 'bg-green-500', bgLight: 'bg-green-50', border: 'border-green-200', text: 'text-green-700' },
  { key: 'declined', label: 'Declinados', color: 'bg-red-500', bgLight: 'bg-red-50', border: 'border-red-200', text: 'text-red-700' },
  { key: 'attended', label: 'Asistieron', color: 'bg-emerald-600', bgLight: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-700' },
  { key: 'no_show', label: 'No asistieron', color: 'bg-gray-400', bgLight: 'bg-gray-50', border: 'border-gray-200', text: 'text-gray-600' },
]

const INTERACTION_TYPES = [
  { key: 'call', label: 'Llamada', icon: Phone, color: 'bg-blue-100 text-blue-700 hover:bg-blue-200' },
  { key: 'whatsapp', label: 'WhatsApp', icon: MessageSquare, color: 'bg-green-100 text-green-700 hover:bg-green-200' },
  { key: 'note', label: 'Nota', icon: StickyNote, color: 'bg-yellow-100 text-yellow-700 hover:bg-yellow-200' },
  { key: 'email', label: 'Email', icon: Mail, color: 'bg-purple-100 text-purple-700 hover:bg-purple-200' },
  { key: 'meeting', label: 'Reunión', icon: Handshake, color: 'bg-orange-100 text-orange-700 hover:bg-orange-200' },
]

const OUTCOMES = [
  { key: 'answered', label: 'Contestó', icon: CheckCircle2, color: 'bg-green-100 text-green-700 hover:bg-green-200' },
  { key: 'no_answer', label: 'No contestó', icon: PhoneOff, color: 'bg-red-100 text-red-700 hover:bg-red-200' },
  { key: 'voicemail', label: 'Buzón', icon: Voicemail, color: 'bg-gray-100 text-gray-700 hover:bg-gray-200' },
  { key: 'busy', label: 'Ocupado', icon: Phone, color: 'bg-yellow-100 text-yellow-700 hover:bg-yellow-200' },
  { key: 'confirmed', label: 'Confirmó', icon: CheckCircle2, color: 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' },
  { key: 'declined', label: 'Declinó', icon: XCircle, color: 'bg-red-100 text-red-700 hover:bg-red-200' },
  { key: 'rescheduled', label: 'Reprogramar', icon: CalendarClock, color: 'bg-blue-100 text-blue-700 hover:bg-blue-200' },
  { key: 'callback', label: 'Devolver', icon: PhoneCall, color: 'bg-indigo-100 text-indigo-700 hover:bg-indigo-200' },
]

export default function EventDetailPage() {
  const params = useParams()
  const router = useRouter()
  const eventId = params.id as string

  const [event, setEvent] = useState<Event | null>(null)
  const [participants, setParticipants] = useState<Participant[]>([])
  const [loading, setLoading] = useState(true)
  const [viewMode, setViewMode] = useState<'kanban' | 'list'>('kanban')
  const [searchQuery, setSearchQuery] = useState('')
  const [showAddModal, setShowAddModal] = useState(false)
  const [selectedParticipant, setSelectedParticipant] = useState<Participant | null>(null)
  const [interactions, setInteractions] = useState<Interaction[]>([])
  const [draggedParticipant, setDraggedParticipant] = useState<string | null>(null)
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null)

  // Tags
  const [allTags, setAllTags] = useState<TagItem[]>([])
  const [showTagDropdown, setShowTagDropdown] = useState<string | null>(null)

  // Filters
  const [filterStatus, setFilterStatus] = useState('')
  const [filterTags, setFilterTags] = useState<string[]>([])
  const [filterHasPhone, setFilterHasPhone] = useState(false)
  const [showFilters, setShowFilters] = useState(false)

  // Mass messaging modal
  const [showCampaignModal, setShowCampaignModal] = useState(false)
  const [devices, setDevices] = useState<Device[]>([])
  const [creatingCampaign, setCreatingCampaign] = useState(false)

  // Add participant form
  const [addTab, setAddTab] = useState<'search' | 'manual'>('search')
  const [contactSearch, setContactSearch] = useState('')
  const [contactResults, setContactResults] = useState<Contact[]>([])
  const [selectedContacts, setSelectedContacts] = useState<Contact[]>([])
  const [manualForm, setManualForm] = useState({ name: '', last_name: '', short_name: '', phone: '', email: '', age: '' })

  // Edit participant
  const [editingParticipant, setEditingParticipant] = useState<Participant | null>(null)
  const [editForm, setEditForm] = useState({ name: '', last_name: '', short_name: '', phone: '', email: '', age: '', notes: '' })
  const [savingEdit, setSavingEdit] = useState(false)

  // Interaction form
  const [intForm, setIntForm] = useState({ type: '', outcome: '', notes: '', direction: 'outbound', next_action: '', next_action_date: '' })
  const [savingInteraction, setSavingInteraction] = useState(false)
  const [intDisplayCount, setIntDisplayCount] = useState(5)
  const [showIntHistoryModal, setShowIntHistoryModal] = useState(false)
  const [intHistoryFilterType, setIntHistoryFilterType] = useState('')
  const [intHistoryFilterFrom, setIntHistoryFilterFrom] = useState('')
  const [intHistoryFilterTo, setIntHistoryFilterTo] = useState('')

  const fetchEvent = useCallback(async () => {
    try {
      const res = await fetch(`/api/events/${eventId}`, { headers: { Authorization: `Bearer ${token()}` } })
      const data = await res.json()
      if (data.success) setEvent(data.event)
    } catch (e) { console.error(e) }
  }, [eventId])

  const fetchParticipants = useCallback(async () => {
    try {
      const params = new URLSearchParams()
      if (searchQuery) params.set('search', searchQuery)
      if (filterStatus) params.set('status', filterStatus)
      if (filterTags.length > 0) params.set('tags', filterTags.join(','))
      if (filterHasPhone) params.set('has_phone', 'true')
      const res = await fetch(`/api/events/${eventId}/participants?${params}`, { headers: { Authorization: `Bearer ${token()}` } })
      const data = await res.json()
      if (data.success) setParticipants(data.participants || [])
    } catch (e) { console.error(e) }
  }, [eventId, searchQuery, filterStatus, filterTags, filterHasPhone])

  const fetchTags = useCallback(async () => {
    try {
      const res = await fetch('/api/tags', { headers: { Authorization: `Bearer ${token()}` } })
      const data = await res.json()
      if (data.success) setAllTags(data.tags || [])
    } catch (e) { console.error(e) }
  }, [])

  const fetchDevices = useCallback(async () => {
    try {
      const res = await fetch('/api/devices', { headers: { Authorization: `Bearer ${token()}` } })
      const data = await res.json()
      if (data.success) setDevices((data.devices || []).filter((d: Device) => d.status === 'connected'))
    } catch (e) { console.error(e) }
  }, [])

  const fetchInteractions = useCallback(async (participantId: string) => {
    try {
      const res = await fetch(`/api/interactions?participant_id=${participantId}`, { headers: { Authorization: `Bearer ${token()}` } })
      const data = await res.json()
      if (data.success) setInteractions(data.interactions || [])
    } catch (e) { console.error(e) }
  }, [])

  useEffect(() => {
    Promise.all([fetchEvent(), fetchParticipants(), fetchTags()]).then(() => setLoading(false))
  }, [fetchEvent, fetchParticipants, fetchTags])

  useEffect(() => {
    if (selectedParticipant) {
      setIntDisplayCount(5)
      fetchInteractions(selectedParticipant.id)
    }
  }, [selectedParticipant, fetchInteractions])

  // Search contacts for adding
  const searchContacts = useCallback(async (q: string) => {
    if (!q || q.length < 2) { setContactResults([]); return }
    try {
      const res = await fetch(`/api/contacts?search=${encodeURIComponent(q)}&limit=20`, { headers: { Authorization: `Bearer ${token()}` } })
      const data = await res.json()
      if (data.success) setContactResults(data.contacts || [])
    } catch (e) { console.error(e) }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => searchContacts(contactSearch), 300)
    return () => clearTimeout(t)
  }, [contactSearch, searchContacts])

  // Tag management
  const handleAssignTag = async (participantId: string, tagId: string) => {
    await fetch('/api/tags/assign', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity_type: 'participant', entity_id: participantId, tag_id: tagId }),
    })
    setShowTagDropdown(null)
    fetchParticipants()
  }

  const handleRemoveTag = async (participantId: string, tagId: string) => {
    await fetch('/api/tags/remove', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity_type: 'participant', entity_id: participantId, tag_id: tagId }),
    })
    fetchParticipants()
  }

  // Drag and drop handlers
  const handleDragStart = (participantId: string) => setDraggedParticipant(participantId)
  const handleDragOver = (e: React.DragEvent, status: string) => { e.preventDefault(); setDragOverColumn(status) }
  const handleDragLeave = () => setDragOverColumn(null)
  const handleDrop = async (e: React.DragEvent, newStatus: string) => {
    e.preventDefault()
    setDragOverColumn(null)
    if (!draggedParticipant) return
    const participant = participants.find(p => p.id === draggedParticipant)
    if (!participant || participant.status === newStatus) { setDraggedParticipant(null); return }
    setParticipants(prev => prev.map(p => p.id === draggedParticipant ? { ...p, status: newStatus } : p))
    try {
      await fetch(`/api/events/${eventId}/participants/${draggedParticipant}/status`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      })
      fetchEvent()
    } catch (e) { console.error(e); fetchParticipants() }
    setDraggedParticipant(null)
  }

  const handleStatusChange = async (pid: string, newStatus: string) => {
    setParticipants(prev => prev.map(p => p.id === pid ? { ...p, status: newStatus } : p))
    await fetch(`/api/events/${eventId}/participants/${pid}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    })
    fetchEvent()
  }

  const handleAddFromContacts = async () => {
    if (selectedContacts.length === 0) return
    const parts = selectedContacts.map(c => ({
      contact_id: c.id, name: c.name, phone: c.phone, email: c.email || '',
    }))
    const res = await fetch(`/api/events/${eventId}/participants/bulk`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ participants: parts }),
    })
    const data = await res.json()
    if (!data.success) {
      alert(data.error || 'Error al agregar participantes')
      return
    }
    setShowAddModal(false)
    setSelectedContacts([])
    setContactSearch('')
    fetchParticipants()
    fetchEvent()
  }

  const handleAddManual = async () => {
    const body: Record<string, unknown> = {
      name: manualForm.name,
      last_name: manualForm.last_name,
      short_name: manualForm.short_name || undefined,
      phone: manualForm.phone || undefined,
      email: manualForm.email || undefined,
    }
    if (manualForm.age) body.age = parseInt(manualForm.age)
    const res = await fetch(`/api/events/${eventId}/participants`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!data.success) {
      alert(data.error || 'Error al agregar participante')
      return
    }
    setShowAddModal(false)
    setManualForm({ name: '', last_name: '', short_name: '', phone: '', email: '', age: '' })
    fetchParticipants()
    fetchEvent()
  }

  // Edit participant
  const openEditParticipant = (p: Participant) => {
    setEditForm({
      name: p.name,
      last_name: p.last_name || '',
      short_name: p.short_name || '',
      phone: p.phone || '',
      email: p.email || '',
      age: p.age ? String(p.age) : '',
      notes: p.notes || '',
    })
    setEditingParticipant(p)
  }

  const handleSaveEdit = async () => {
    if (!editingParticipant) return
    setSavingEdit(true)
    try {
      const body: Record<string, unknown> = {
        name: editForm.name,
        last_name: editForm.last_name || null,
        short_name: editForm.short_name || null,
        phone: editForm.phone || null,
        email: editForm.email || null,
        age: editForm.age ? parseInt(editForm.age) : null,
        notes: editForm.notes || null,
      }
      const res = await fetch(`/api/events/${eventId}/participants/${editingParticipant.id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (data.success) {
        setEditingParticipant(null)
        fetchParticipants()
        if (selectedParticipant?.id === editingParticipant.id) {
          setSelectedParticipant(data.participant)
        }
      } else {
        alert(data.error || 'Error al guardar')
      }
    } catch (e) { console.error(e); alert('Error de conexión') }
    setSavingEdit(false)
  }

  const handleLogInteraction = async () => {
    if (!selectedParticipant || !intForm.type || !intForm.outcome) return
    setSavingInteraction(true)
    const body: Record<string, unknown> = {
      event_id: eventId,
      participant_id: selectedParticipant.id,
      contact_id: selectedParticipant.contact_id || undefined,
      type: intForm.type,
      direction: intForm.direction,
      outcome: intForm.outcome,
      notes: intForm.notes || undefined,
      next_action: intForm.next_action || undefined,
      next_action_date: intForm.next_action_date ? new Date(intForm.next_action_date).toISOString() : undefined,
    }
    try {
      await fetch('/api/interactions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      setIntForm({ type: '', outcome: '', notes: '', direction: 'outbound', next_action: '', next_action_date: '' })
      fetchInteractions(selectedParticipant.id)
      fetchParticipants()
      fetchEvent()
    } catch (e) { console.error(e) }
    setSavingInteraction(false)
  }

  const handleDeleteParticipant = async (pid: string) => {
    if (!confirm('¿Eliminar este participante?')) return
    await fetch(`/api/events/${eventId}/participants/${pid}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token()}` },
    })
    if (selectedParticipant?.id === pid) setSelectedParticipant(null)
    fetchParticipants()
    fetchEvent()
  }

  // Mass messaging
  const participantsWithPhone = useMemo(() => participants.filter(p => p.phone), [participants])

  const handleCreateCampaign = async (formResult: CampaignFormResult) => {
    setCreatingCampaign(true)
    try {
      const res = await fetch(`/api/events/${eventId}/campaign`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formResult.name,
          device_id: formResult.device_id,
          message_template: formResult.message_template,
          attachments: formResult.attachments,
          scheduled_at: formResult.scheduled_at || undefined,
          settings: formResult.settings,
          status: filterStatus || undefined,
          tag_ids: filterTags.length > 0 ? filterTags : undefined,
          has_phone: true,
        }),
      })
      const data = await res.json()
      if (data.success) {
        if (formResult.scheduled_at && data.campaign) {
          await fetch(`/api/campaigns/${data.campaign.id}`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'scheduled', scheduled_at: formResult.scheduled_at }),
          })
        }
        alert(`Campaña creada con ${data.recipients_count} destinatarios. Puedes verla y iniciarla en Envíos Masivos.`)
        setShowCampaignModal(false)
      } else {
        alert(data.error || 'Error al crear campaña')
      }
    } catch (e) { console.error(e); alert('Error de conexión') }
    setCreatingCampaign(false)
  }

  const grouped = useMemo(() => {
    const map: Record<string, Participant[]> = {}
    STATUSES.forEach(s => { map[s.key] = [] })
    participants.forEach(p => {
      if (map[p.status]) map[p.status].push(p)
      else map['invited'].push(p)
    })
    return map
  }, [participants])

  const activeFilterCount = [filterStatus, filterTags.length > 0, filterHasPhone].filter(Boolean).length

  if (loading || !event) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-600" />
      </div>
    )
  }

  const statusInfo = (key: string) => STATUSES.find(s => s.key === key)

  const TagPills = ({ participant }: { participant: Participant }) => (
    <div className="flex flex-wrap gap-1 mt-1">
      {(participant.tags || []).map(tag => (
        <span
          key={tag.id}
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium text-white"
          style={{ backgroundColor: tag.color || '#6b7280' }}
        >
          {tag.name}
          <button
            onClick={(e) => { e.stopPropagation(); handleRemoveTag(participant.id, tag.id) }}
            className="ml-0.5 hover:opacity-70"
          >
            <X className="w-2.5 h-2.5" />
          </button>
        </span>
      ))}
      <button
        onClick={(e) => { e.stopPropagation(); setShowTagDropdown(showTagDropdown === participant.id ? null : participant.id) }}
        className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-gray-100 text-gray-500 hover:bg-gray-200"
      >
        <Plus className="w-2.5 h-2.5" />
      </button>
      {showTagDropdown === participant.id && (
        <div className="absolute z-50 mt-6 bg-white border border-gray-200 rounded-lg shadow-lg py-1 w-40 max-h-48 overflow-y-auto">
          {allTags.filter(t => !(participant.tags || []).some(pt => pt.id === t.id)).map(tag => (
            <button
              key={tag.id}
              onClick={(e) => { e.stopPropagation(); handleAssignTag(participant.id, tag.id) }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
            >
              <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: tag.color || '#6b7280' }} />
              {tag.name}
            </button>
          ))}
          {allTags.filter(t => !(participant.tags || []).some(pt => pt.id === t.id)).length === 0 && (
            <p className="px-3 py-2 text-xs text-gray-400">No hay más etiquetas</p>
          )}
        </div>
      )}
    </div>
  )

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden" onClick={() => setShowTagDropdown(null)}>
      {/* Header */}
      <div className="flex-shrink-0 bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center gap-3 mb-3">
          <button onClick={() => router.push('/dashboard/events')} className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3">
              <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: event.color }} />
              <h1 className="text-xl font-bold text-gray-900 truncate">{event.name}</h1>
              <span className={`text-xs font-medium px-2 py-1 rounded-full ${statusInfo(event.status)?.bgLight} ${statusInfo(event.status)?.text}`}>
                {statusInfo(event.status)?.label || event.status}
              </span>
            </div>
            <div className="flex items-center gap-4 text-sm text-gray-500 mt-1 ml-6">
              {event.event_date && (
                <span className="flex items-center gap-1"><CalendarDays className="w-3.5 h-3.5" />{format(new Date(event.event_date), "d MMM yyyy, HH:mm", { locale: es })}</span>
              )}
              {event.location && (
                <span className="flex items-center gap-1"><MapPin className="w-3.5 h-3.5" />{event.location}</span>
              )}
              <span className="flex items-center gap-1"><Users className="w-3.5 h-3.5" />{event.total_participants} participantes</span>
            </div>
          </div>
        </div>

        {/* Status badges bar */}
        <div className="flex items-center gap-2 flex-wrap ml-8 mb-3">
          {STATUSES.map(s => {
            const count = event.participant_counts?.[s.key] || 0
            return (
              <span key={s.key} className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${s.bgLight} ${s.text}`}>
                <span className={`w-2 h-2 rounded-full ${s.color}`} />
                {count} {s.label.toLowerCase()}
              </span>
            )
          })}
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-3 ml-8 flex-wrap">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Buscar participante..."
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-900"
            />
          </div>

          {/* Filter toggle */}
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${activeFilterCount > 0 ? 'border-green-300 bg-green-50 text-green-700' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
          >
            <Filter className="w-4 h-4" />
            Filtros
            {activeFilterCount > 0 && (
              <span className="bg-green-600 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">{activeFilterCount}</span>
            )}
          </button>

          <div className="flex bg-gray-100 rounded-lg p-0.5">
            <button onClick={() => setViewMode('kanban')} className={`p-2 rounded-md transition-colors ${viewMode === 'kanban' ? 'bg-white shadow text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}>
              <LayoutGrid className="w-4 h-4" />
            </button>
            <button onClick={() => setViewMode('list')} className={`p-2 rounded-md transition-colors ${viewMode === 'list' ? 'bg-white shadow text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}>
              <List className="w-4 h-4" />
            </button>
          </div>

          <button
            onClick={() => { setShowCampaignModal(true); fetchDevices() }}
            className="flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 text-sm font-medium shadow-sm"
          >
            <Send className="w-4 h-4" />
            Envío Masivo
          </button>

          <button onClick={() => setShowAddModal(true)} className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm font-medium shadow-sm">
            <UserPlus className="w-4 h-4" />
            Agregar
          </button>
        </div>

        {/* Filter bar (collapsible) */}
        {showFilters && (
          <div className="ml-8 mt-3 flex items-center gap-3 flex-wrap p-3 bg-gray-50 rounded-lg border border-gray-200">
            {/* Status filter */}
            <div>
              <label className="text-[10px] text-gray-500 uppercase tracking-wider mb-1 block">Estado</label>
              <select
                value={filterStatus}
                onChange={e => setFilterStatus(e.target.value)}
                className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm text-gray-700 focus:ring-2 focus:ring-green-500"
              >
                <option value="">Todos</option>
                {STATUSES.map(s => (
                  <option key={s.key} value={s.key}>{s.label}</option>
                ))}
              </select>
            </div>

            {/* Tag filter */}
            <div>
              <label className="text-[10px] text-gray-500 uppercase tracking-wider mb-1 block">Etiquetas</label>
              <div className="flex flex-wrap gap-1">
                {allTags.map(tag => {
                  const active = filterTags.includes(tag.id)
                  return (
                    <button
                      key={tag.id}
                      onClick={() => setFilterTags(prev => active ? prev.filter(id => id !== tag.id) : [...prev, tag.id])}
                      className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium transition-all ${active ? 'text-white ring-2 ring-offset-1' : 'text-gray-600 bg-gray-100 hover:bg-gray-200'}`}
                      style={active ? { backgroundColor: tag.color || '#6b7280' } : {}}
                    >
                      {!active && <span className="w-2 h-2 rounded-full" style={{ backgroundColor: tag.color || '#6b7280' }} />}
                      {tag.name}
                    </button>
                  )
                })}
                {allTags.length === 0 && <span className="text-xs text-gray-400">Sin etiquetas</span>}
              </div>
            </div>

            {/* Has phone filter */}
            <div>
              <label className="text-[10px] text-gray-500 uppercase tracking-wider mb-1 block">Teléfono</label>
              <button
                onClick={() => setFilterHasPhone(!filterHasPhone)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${filterHasPhone ? 'bg-green-50 border-green-300 text-green-700' : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50'}`}
              >
                <Phone className="w-3.5 h-3.5" />
                Solo con teléfono
              </button>
            </div>

            {/* Clear filters */}
            {activeFilterCount > 0 && (
              <button
                onClick={() => { setFilterStatus(''); setFilterTags([]); setFilterHasPhone(false) }}
                className="ml-auto text-xs text-gray-500 hover:text-red-600 flex items-center gap-1"
              >
                <X className="w-3.5 h-3.5" />
                Limpiar filtros
              </button>
            )}
          </div>
        )}
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-hidden flex">
        <div className={`flex-1 overflow-auto ${selectedParticipant ? 'mr-0' : ''}`}>
          {viewMode === 'kanban' ? (
            /* Kanban View */
            <div className="flex gap-4 p-6 h-full overflow-x-auto">
              {STATUSES.map(status => (
                <div
                  key={status.key}
                  className={`flex-shrink-0 w-72 flex flex-col rounded-xl border ${dragOverColumn === status.key ? 'border-green-400 bg-green-50/50' : `${status.border} bg-gray-50/50`} transition-colors`}
                  onDragOver={e => handleDragOver(e, status.key)}
                  onDragLeave={handleDragLeave}
                  onDrop={e => handleDrop(e, status.key)}
                >
                  <div className={`flex items-center gap-2 px-4 py-3 border-b ${status.border}`}>
                    <span className={`w-2.5 h-2.5 rounded-full ${status.color}`} />
                    <span className="text-sm font-semibold text-gray-700">{status.label}</span>
                    <span className="text-xs text-gray-400 ml-auto bg-white px-2 py-0.5 rounded-full">{grouped[status.key]?.length || 0}</span>
                  </div>
                  <div className="flex-1 overflow-y-auto p-2 space-y-2">
                    {(grouped[status.key] || []).map(p => (
                      <div
                        key={p.id}
                        draggable
                        onDragStart={() => handleDragStart(p.id)}
                        onClick={() => setSelectedParticipant(p)}
                        className={`bg-white rounded-lg border border-gray-200 p-3 cursor-pointer hover:shadow-md transition-all relative ${selectedParticipant?.id === p.id ? 'ring-2 ring-green-500' : ''} ${draggedParticipant === p.id ? 'opacity-50' : ''}`}
                      >
                        <div className="flex items-start gap-2">
                          <GripVertical className="w-4 h-4 text-gray-300 mt-0.5 flex-shrink-0 cursor-grab" />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1">
                              <p className="text-sm font-medium text-gray-900 truncate">
                                {p.name} {p.last_name || ''}
                              </p>
                              <button
                                onClick={(e) => { e.stopPropagation(); openEditParticipant(p) }}
                                className="p-0.5 text-gray-300 hover:text-blue-600 rounded flex-shrink-0"
                                title="Editar"
                              >
                                <Pencil className="w-3 h-3" />
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); handleDeleteParticipant(p.id) }}
                                className="p-0.5 text-gray-300 hover:text-red-600 rounded flex-shrink-0"
                                title="Eliminar"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </div>
                            {p.short_name && <p className="text-xs text-gray-400 italic">{p.short_name}</p>}
                            {p.phone && <p className="text-xs text-gray-500 mt-0.5">{p.phone}</p>}
                            <TagPills participant={p} />
                            {p.next_action && (
                              <div className="flex items-center gap-1 mt-2">
                                <Clock className="w-3 h-3 text-orange-500" />
                                <span className="text-xs text-orange-600 truncate">{p.next_action}</span>
                              </div>
                            )}
                            {p.next_action_date && (
                              <p className="text-xs text-gray-400 mt-0.5">
                                {formatDistanceToNow(new Date(p.next_action_date), { addSuffix: true, locale: es })}
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                    {(grouped[status.key] || []).length === 0 && (
                      <div className="text-center py-8 text-gray-400 text-xs">
                        Arrastra aquí
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            /* List View */
            <div className="p-6">
              <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-200 bg-gray-50">
                      <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Nombre</th>
                      <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">N. Corto</th>
                      <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Teléfono</th>
                      <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Email</th>
                      <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Edad</th>
                      <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Estado</th>
                      <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Etiquetas</th>
                      <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Próxima acción</th>
                      <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Acciones</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {participants.map(p => {
                      const si = statusInfo(p.status)
                      return (
                        <tr key={p.id} className={`hover:bg-gray-50 cursor-pointer ${selectedParticipant?.id === p.id ? 'bg-green-50' : ''}`} onClick={() => setSelectedParticipant(p)}>
                          <td className="px-4 py-3">
                            <span className="text-sm font-medium text-gray-900">{p.name} {p.last_name || ''}</span>
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-500 italic">{p.short_name || '-'}</td>
                          <td className="px-4 py-3 text-sm text-gray-600">{p.phone || '-'}</td>
                          <td className="px-4 py-3 text-sm text-gray-600">{p.email || '-'}</td>
                          <td className="px-4 py-3 text-sm text-gray-600">{p.age || '-'}</td>
                          <td className="px-4 py-3">
                            <select
                              value={p.status}
                              onChange={e => { e.stopPropagation(); handleStatusChange(p.id, e.target.value) }}
                              onClick={e => e.stopPropagation()}
                              className={`text-xs font-medium px-2 py-1 rounded-full border-0 ${si?.bgLight} ${si?.text} cursor-pointer`}
                            >
                              {STATUSES.map(s => (
                                <option key={s.key} value={s.key}>{s.label}</option>
                              ))}
                            </select>
                          </td>
                          <td className="px-4 py-3">
                            <div className="relative">
                              <TagPills participant={p} />
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            {p.next_action ? (
                              <div>
                                <span className="text-xs text-gray-700">{p.next_action}</span>
                                {p.next_action_date && (
                                  <p className="text-xs text-gray-400">{formatDistanceToNow(new Date(p.next_action_date), { addSuffix: true, locale: es })}</p>
                                )}
                              </div>
                            ) : <span className="text-xs text-gray-400">-</span>}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1">
                              <button onClick={(e) => { e.stopPropagation(); openEditParticipant(p) }} className="p-1 text-gray-400 hover:text-blue-600 rounded" title="Editar">
                                <Pencil className="w-4 h-4" />
                              </button>
                              <button onClick={(e) => { e.stopPropagation(); handleDeleteParticipant(p.id) }} className="p-1 text-gray-400 hover:text-red-600 rounded">
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                    {participants.length === 0 && (
                      <tr>
                        <td colSpan={9} className="px-4 py-12 text-center text-gray-400">
                          No hay participantes aún
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* Right panel - Participant detail / Interaction logging */}
        {selectedParticipant && (
          <div className="w-96 flex-shrink-0 bg-white border-l border-gray-200 flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gray-50">
              <h3 className="font-semibold text-gray-900 text-sm truncate">
                {selectedParticipant.name} {selectedParticipant.last_name || ''}
                {selectedParticipant.short_name && <span className="text-xs text-gray-400 font-normal ml-1">({selectedParticipant.short_name})</span>}
              </h3>
              <div className="flex items-center gap-1">
                <button onClick={() => openEditParticipant(selectedParticipant)} className="p-1 text-gray-400 hover:text-blue-600 rounded" title="Editar">
                  <Pencil className="w-4 h-4" />
                </button>
                <button onClick={() => handleDeleteParticipant(selectedParticipant.id)} className="p-1 text-gray-400 hover:text-red-600 rounded" title="Eliminar">
                  <Trash2 className="w-4 h-4" />
                </button>
                <button onClick={() => setSelectedParticipant(null)} className="p-1 text-gray-400 hover:text-gray-600 rounded">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto">
              {/* Participant info */}
              <div className="p-4 space-y-2 border-b border-gray-100">
                {selectedParticipant.phone && (
                  <div className="flex items-center gap-2 text-sm"><Phone className="w-3.5 h-3.5 text-gray-400" /><span className="text-gray-700">{selectedParticipant.phone}</span></div>
                )}
                {selectedParticipant.email && (
                  <div className="flex items-center gap-2 text-sm"><Mail className="w-3.5 h-3.5 text-gray-400" /><span className="text-gray-700">{selectedParticipant.email}</span></div>
                )}
                {selectedParticipant.age && (
                  <div className="text-sm text-gray-500">Edad: {selectedParticipant.age}</div>
                )}
                {selectedParticipant.notes && (
                  <div className="text-sm text-gray-500 bg-gray-50 rounded p-2">{selectedParticipant.notes}</div>
                )}
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-medium px-2 py-1 rounded-full ${statusInfo(selectedParticipant.status)?.bgLight} ${statusInfo(selectedParticipant.status)?.text}`}>
                    {statusInfo(selectedParticipant.status)?.label}
                  </span>
                  {selectedParticipant.invited_at && (
                    <span className="text-xs text-gray-400">Invitado {formatDistanceToNow(new Date(selectedParticipant.invited_at), { addSuffix: true, locale: es })}</span>
                  )}
                </div>

                {/* Tags in side panel */}
                <div className="pt-2">
                  <label className="text-xs text-gray-500 font-medium block mb-1.5">
                    <Tag className="w-3 h-3 inline mr-1" />Etiquetas
                  </label>
                  <div className="relative">
                    <TagPills participant={selectedParticipant} />
                  </div>
                </div>
              </div>

              {/* Quick interaction form */}
              <div className="p-4 border-b border-gray-100">
                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Registrar interacción</h4>

                <div className="mb-3">
                  <label className="text-xs text-gray-500 mb-1.5 block">Tipo</label>
                  <div className="flex flex-wrap gap-1.5">
                    {INTERACTION_TYPES.map(t => {
                      const Icon = t.icon
                      return (
                        <button
                          key={t.key}
                          onClick={() => setIntForm(f => ({ ...f, type: t.key }))}
                          className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all ${intForm.type === t.key ? t.color + ' ring-2 ring-offset-1 ring-current' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
                        >
                          <Icon className="w-3 h-3" />{t.label}
                        </button>
                      )
                    })}
                  </div>
                </div>

                <div className="mb-3">
                  <label className="text-xs text-gray-500 mb-1.5 block">Resultado</label>
                  <div className="flex flex-wrap gap-1.5">
                    {OUTCOMES.map(o => {
                      const Icon = o.icon
                      return (
                        <button
                          key={o.key}
                          onClick={() => setIntForm(f => ({ ...f, outcome: o.key }))}
                          className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all ${intForm.outcome === o.key ? o.color + ' ring-2 ring-offset-1 ring-current' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
                        >
                          <Icon className="w-3 h-3" />{o.label}
                        </button>
                      )
                    })}
                  </div>
                </div>

                <div className="mb-3">
                  <label className="text-xs text-gray-500 mb-1.5 block">Dirección</label>
                  <div className="flex gap-2">
                    <button onClick={() => setIntForm(f => ({ ...f, direction: 'outbound' }))} className={`px-3 py-1.5 rounded-lg text-xs font-medium ${intForm.direction === 'outbound' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-500'}`}>
                      Saliente
                    </button>
                    <button onClick={() => setIntForm(f => ({ ...f, direction: 'inbound' }))} className={`px-3 py-1.5 rounded-lg text-xs font-medium ${intForm.direction === 'inbound' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-500'}`}>
                      Entrante
                    </button>
                  </div>
                </div>

                <textarea
                  value={intForm.notes}
                  onChange={e => setIntForm(f => ({ ...f, notes: e.target.value }))}
                  placeholder="Notas de la interacción..."
                  rows={2}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-900 mb-3"
                />

                <div className="grid grid-cols-2 gap-2 mb-3">
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Próxima acción</label>
                    <input
                      value={intForm.next_action}
                      onChange={e => setIntForm(f => ({ ...f, next_action: e.target.value }))}
                      placeholder="Ej: Volver a llamar"
                      className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-xs focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-900"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Fecha</label>
                    <input
                      type="datetime-local"
                      value={intForm.next_action_date}
                      onChange={e => setIntForm(f => ({ ...f, next_action_date: e.target.value }))}
                      className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-xs focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-900"
                    />
                  </div>
                </div>

                <button
                  onClick={handleLogInteraction}
                  disabled={!intForm.type || !intForm.outcome || savingInteraction}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 text-sm font-medium"
                >
                  <Save className="w-4 h-4" />
                  {savingInteraction ? 'Guardando...' : 'Guardar interacción'}
                </button>
              </div>

              {/* Interaction timeline */}
              <div className="p-4">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Historial de interacciones</h4>
                  {interactions.length > 0 && (
                    <button
                      onClick={() => setShowIntHistoryModal(true)}
                      className="p-1.5 text-gray-400 hover:text-green-600 hover:bg-green-50 rounded-lg transition"
                      title="Ver historial completo"
                    >
                      <Maximize2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
                {interactions.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-4">Sin interacciones aún</p>
                ) : (
                  <div className="space-y-3">
                    {interactions.slice(0, intDisplayCount).map(int => {
                      const typeInfo = INTERACTION_TYPES.find(t => t.key === int.type)
                      const outcomeInfo = OUTCOMES.find(o => o.key === int.outcome)
                      const TypeIcon = typeInfo?.icon || StickyNote
                      return (
                        <div key={int.id} className="relative pl-8">
                          <div className={`absolute left-0 top-1 w-6 h-6 rounded-full flex items-center justify-center ${typeInfo?.color.split(' ')[0] || 'bg-gray-100'}`}>
                            <TypeIcon className={`w-3 h-3 ${typeInfo?.color.split(' ')[1] || 'text-gray-500'}`} />
                          </div>
                          <div className="bg-gray-50 rounded-lg p-3">
                            <div className="flex items-center gap-2 mb-1 flex-wrap">
                              <span className="text-xs font-medium text-gray-900">{typeInfo?.label || int.type}</span>
                              <span className="text-xs text-gray-400">&bull;</span>
                              {outcomeInfo && (
                                <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${outcomeInfo.color.replace('hover:bg-', '')}`}>
                                  {outcomeInfo.label}
                                </span>
                              )}
                              <span className="text-xs text-gray-400">&bull;</span>
                              <span className="text-xs text-gray-400">{int.direction === 'inbound' ? '← Entrante' : '→ Saliente'}</span>
                            </div>
                            {int.notes && <p className="text-xs text-gray-600 mt-1">{int.notes}</p>}
                            {int.next_action && (
                              <div className="flex items-center gap-1 mt-2">
                                <Clock className="w-3 h-3 text-orange-500" />
                                <span className="text-xs text-orange-600">{int.next_action}</span>
                                {int.next_action_date && (
                                  <span className="text-xs text-gray-400 ml-1">
                                    ({formatDistanceToNow(new Date(int.next_action_date), { addSuffix: true, locale: es })})
                                  </span>
                                )}
                              </div>
                            )}
                            <div className="flex items-center justify-between mt-2">
                              <span className="text-xs text-gray-400">
                                {format(new Date(int.created_at), "d MMM, HH:mm", { locale: es })}
                              </span>
                              {int.created_by_name && (
                                <span className="text-xs text-gray-400">por {int.created_by_name}</span>
                              )}
                            </div>
                          </div>
                        </div>
                      )
                    })}
                    {interactions.length > intDisplayCount && (
                      <button
                        onClick={() => setIntDisplayCount(prev => prev + 10)}
                        className="w-full py-2 text-sm text-green-600 hover:text-green-700 hover:bg-green-50 rounded-lg transition font-medium"
                      >
                        Mostrar más ({interactions.length - intDisplayCount} restantes)
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Add Participant Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[85vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900">Agregar Participantes</h2>
              <button onClick={() => setShowAddModal(false)} className="p-1 text-gray-400 hover:text-gray-600 rounded">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex border-b border-gray-200">
              <button onClick={() => setAddTab('search')} className={`flex-1 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${addTab === 'search' ? 'border-green-600 text-green-700' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
                Buscar Contacto
              </button>
              <button onClick={() => setAddTab('manual')} className={`flex-1 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${addTab === 'manual' ? 'border-green-600 text-green-700' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
                Agregar Manual
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              {addTab === 'search' ? (
                <div>
                  <div className="relative mb-4">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                    <input
                      value={contactSearch}
                      onChange={e => setContactSearch(e.target.value)}
                      placeholder="Buscar por nombre o teléfono..."
                      className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-900"
                    />
                  </div>

                  {selectedContacts.length > 0 && (
                    <div className="mb-4">
                      <p className="text-xs text-gray-500 mb-2">{selectedContacts.length} seleccionados</p>
                      <div className="flex flex-wrap gap-2">
                        {selectedContacts.map(c => (
                          <span key={c.id} className="inline-flex items-center gap-1 px-2.5 py-1 bg-green-100 text-green-700 rounded-full text-xs">
                            {c.name}
                            <button onClick={() => setSelectedContacts(prev => prev.filter(x => x.id !== c.id))} className="hover:text-green-900">
                              <X className="w-3 h-3" />
                            </button>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="space-y-2">
                    {contactResults.map(c => {
                      const isSelected = selectedContacts.some(x => x.id === c.id)
                      return (
                        <button
                          key={c.id}
                          onClick={() => {
                            if (isSelected) setSelectedContacts(prev => prev.filter(x => x.id !== c.id))
                            else setSelectedContacts(prev => [...prev, c])
                          }}
                          className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition-colors ${isSelected ? 'border-green-300 bg-green-50' : 'border-gray-200 hover:bg-gray-50'}`}
                        >
                          <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium ${isSelected ? 'bg-green-200 text-green-700' : 'bg-gray-200 text-gray-600'}`}>
                            {c.name.charAt(0).toUpperCase()}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-gray-900 truncate">{c.name}</p>
                            <p className="text-xs text-gray-500">{c.phone}</p>
                          </div>
                          {isSelected && <CheckCircle2 className="w-5 h-5 text-green-600 flex-shrink-0" />}
                        </button>
                      )
                    })}
                    {contactSearch.length >= 2 && contactResults.length === 0 && (
                      <p className="text-center text-gray-400 text-sm py-4">No se encontraron contactos</p>
                    )}
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Nombre *</label>
                      <input value={manualForm.name} onChange={e => setManualForm(f => ({ ...f, name: e.target.value }))} className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-900" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Apellido</label>
                      <input value={manualForm.last_name} onChange={e => setManualForm(f => ({ ...f, last_name: e.target.value }))} className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-900" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Nombre Corto</label>
                    <input value={manualForm.short_name} onChange={e => setManualForm(f => ({ ...f, short_name: e.target.value }))} placeholder="Apodo o nombre corto" className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-900" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Teléfono</label>
                    <input value={manualForm.phone} onChange={e => setManualForm(f => ({ ...f, phone: e.target.value }))} className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-900" placeholder="+51..." />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                    <input value={manualForm.email} onChange={e => setManualForm(f => ({ ...f, email: e.target.value }))} type="email" className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-900" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Edad</label>
                    <input value={manualForm.age} onChange={e => setManualForm(f => ({ ...f, age: e.target.value }))} type="number" className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-900" />
                  </div>
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
              <button onClick={() => setShowAddModal(false)} className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg">
                Cancelar
              </button>
              {addTab === 'search' ? (
                <button onClick={handleAddFromContacts} disabled={selectedContacts.length === 0} className="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 font-medium">
                  Agregar {selectedContacts.length > 0 ? `(${selectedContacts.length})` : ''}
                </button>
              ) : (
                <button onClick={handleAddManual} disabled={!manualForm.name} className="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 font-medium">
                  Agregar
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Edit Participant Modal */}
      {editingParticipant && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900">Editar Participante</h2>
              <button onClick={() => setEditingParticipant(null)} className="p-1 text-gray-400 hover:text-gray-600 rounded">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Nombre *</label>
                  <input value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-900" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Apellido</label>
                  <input value={editForm.last_name} onChange={e => setEditForm(f => ({ ...f, last_name: e.target.value }))} className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-900" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Nombre Corto</label>
                <input value={editForm.short_name} onChange={e => setEditForm(f => ({ ...f, short_name: e.target.value }))} placeholder="Apodo o nombre corto" className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-900" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Teléfono</label>
                  <input value={editForm.phone} onChange={e => setEditForm(f => ({ ...f, phone: e.target.value }))} className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-900" placeholder="+51..." />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Edad</label>
                  <input value={editForm.age} onChange={e => setEditForm(f => ({ ...f, age: e.target.value }))} type="number" className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-900" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                <input value={editForm.email} onChange={e => setEditForm(f => ({ ...f, email: e.target.value }))} type="email" className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-900" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notas</label>
                <textarea value={editForm.notes} onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))} rows={3} className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-900" />
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
              <button onClick={() => setEditingParticipant(null)} className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg">
                Cancelar
              </button>
              <button onClick={handleSaveEdit} disabled={!editForm.name || savingEdit} className="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 font-medium flex items-center gap-2">
                <Save className="w-4 h-4" />
                {savingEdit ? 'Guardando...' : 'Guardar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mass Messaging / Campaign Modal */}
      <CreateCampaignModal
        open={showCampaignModal}
        onClose={() => setShowCampaignModal(false)}
        onSubmit={handleCreateCampaign}
        devices={devices}
        title="Envío Masivo desde Evento"
        subtitle="Crea una campaña con los participantes filtrados que tengan teléfono"
        accentColor="purple"
        submitLabel={creatingCampaign ? 'Creando...' : `Crear campaña (${participantsWithPhone.length})`}
        submitting={creatingCampaign || participantsWithPhone.length === 0}
        initialName={`Envío - ${event.name}`}
        infoPanel={
          <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <Users className="w-4 h-4 text-purple-600" />
              <span className="text-sm font-semibold text-purple-800">
                {participantsWithPhone.length} destinatarios con teléfono
              </span>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              {filterStatus && (
                <span className="bg-purple-100 text-purple-700 px-2 py-1 rounded-full">
                  Estado: {STATUSES.find(s => s.key === filterStatus)?.label || filterStatus}
                </span>
              )}
              {filterTags.length > 0 && (
                <span className="bg-purple-100 text-purple-700 px-2 py-1 rounded-full">
                  {filterTags.length} etiqueta{filterTags.length > 1 ? 's' : ''} seleccionada{filterTags.length > 1 ? 's' : ''}
                </span>
              )}
              {!filterStatus && filterTags.length === 0 && (
                <span className="text-purple-600">Todos los participantes con teléfono</span>
              )}
            </div>
            <p className="text-xs text-purple-500 mt-2">
              Puedes ajustar los filtros arriba antes de crear la campaña
            </p>
          </div>
        }
      />

      {/* Full Interaction History Modal */}
      {showIntHistoryModal && selectedParticipant && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Historial Completo</h2>
                <p className="text-sm text-gray-500">{selectedParticipant.name} {selectedParticipant.last_name || ''} &mdash; {interactions.length} registros</p>
              </div>
              <button onClick={() => { setShowIntHistoryModal(false); setIntHistoryFilterType(''); setIntHistoryFilterFrom(''); setIntHistoryFilterTo('') }} className="p-1 text-gray-400 hover:text-gray-600 rounded">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Filters */}
            <div className="px-6 py-3 border-b border-gray-100 bg-gray-50">
              <div className="flex items-center gap-3 flex-wrap">
                <div>
                  <label className="text-[10px] text-gray-500 uppercase tracking-wider mb-1 block">Tipo</label>
                  <select
                    value={intHistoryFilterType}
                    onChange={(e) => setIntHistoryFilterType(e.target.value)}
                    className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm text-gray-700 focus:ring-2 focus:ring-green-500"
                  >
                    <option value="">Todos</option>
                    {INTERACTION_TYPES.map(t => (
                      <option key={t.key} value={t.key}>{t.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] text-gray-500 uppercase tracking-wider mb-1 block">Desde</label>
                  <input
                    type="date"
                    value={intHistoryFilterFrom}
                    onChange={(e) => setIntHistoryFilterFrom(e.target.value)}
                    className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm text-gray-700 focus:ring-2 focus:ring-green-500"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-gray-500 uppercase tracking-wider mb-1 block">Hasta</label>
                  <input
                    type="date"
                    value={intHistoryFilterTo}
                    onChange={(e) => setIntHistoryFilterTo(e.target.value)}
                    className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm text-gray-700 focus:ring-2 focus:ring-green-500"
                  />
                </div>
                {(intHistoryFilterType || intHistoryFilterFrom || intHistoryFilterTo) && (
                  <button
                    onClick={() => { setIntHistoryFilterType(''); setIntHistoryFilterFrom(''); setIntHistoryFilterTo('') }}
                    className="mt-4 text-xs text-gray-500 hover:text-red-600 flex items-center gap-1"
                  >
                    <X className="w-3.5 h-3.5" />
                    Limpiar
                  </button>
                )}
              </div>
            </div>

            {/* History list */}
            <div className="flex-1 overflow-y-auto p-6">
              {(() => {
                const filtered = interactions.filter(int => {
                  if (intHistoryFilterType && int.type !== intHistoryFilterType) return false
                  if (intHistoryFilterFrom && new Date(int.created_at) < new Date(intHistoryFilterFrom)) return false
                  if (intHistoryFilterTo) {
                    const to = new Date(intHistoryFilterTo)
                    to.setDate(to.getDate() + 1)
                    if (new Date(int.created_at) >= to) return false
                  }
                  return true
                })
                if (filtered.length === 0) return <p className="text-sm text-gray-400 text-center py-8">No hay registros con los filtros seleccionados</p>
                return (
                  <div className="space-y-3">
                    {filtered.map(int => {
                      const typeInfo = INTERACTION_TYPES.find(t => t.key === int.type)
                      const outcomeInfo = OUTCOMES.find(o => o.key === int.outcome)
                      const TypeIcon = typeInfo?.icon || StickyNote
                      return (
                        <div key={int.id} className="relative pl-8 p-4 bg-gray-50 rounded-lg border border-gray-100">
                          <div className={`absolute left-4 top-5 w-6 h-6 rounded-full flex items-center justify-center ${typeInfo?.color.split(' ')[0] || 'bg-gray-100'}`}>
                            <TypeIcon className={`w-3 h-3 ${typeInfo?.color.split(' ')[1] || 'text-gray-500'}`} />
                          </div>
                          <div className="ml-4">
                            <div className="flex items-center gap-2 mb-1 flex-wrap">
                              <span className="text-xs font-medium text-gray-900">{typeInfo?.label || int.type}</span>
                              <span className="text-xs text-gray-400">&bull;</span>
                              {outcomeInfo && (
                                <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${outcomeInfo.color.replace('hover:bg-', '')}`}>
                                  {outcomeInfo.label}
                                </span>
                              )}
                              <span className="text-xs text-gray-400">&bull;</span>
                              <span className="text-xs text-gray-400">{int.direction === 'inbound' ? '← Entrante' : '→ Saliente'}</span>
                              <span className="text-xs text-gray-400 ml-auto">
                                {format(new Date(int.created_at), "d MMM yyyy, HH:mm", { locale: es })}
                              </span>
                            </div>
                            {int.notes && <p className="text-sm text-gray-600 mt-1">{int.notes}</p>}
                            {int.next_action && (
                              <div className="flex items-center gap-1 mt-2">
                                <Clock className="w-3 h-3 text-orange-500" />
                                <span className="text-xs text-orange-600">{int.next_action}</span>
                                {int.next_action_date && (
                                  <span className="text-xs text-gray-400 ml-1">
                                    ({formatDistanceToNow(new Date(int.next_action_date), { addSuffix: true, locale: es })})
                                  </span>
                                )}
                              </div>
                            )}
                            {int.created_by_name && (
                              <p className="text-xs text-gray-400 mt-1.5">por {int.created_by_name}</p>
                            )}
                          </div>
                        </div>
                      )
                    })}
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
