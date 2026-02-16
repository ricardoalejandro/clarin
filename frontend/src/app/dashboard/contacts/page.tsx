'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  Search, Phone, Mail, Building2, Tag, Edit, Trash2, RefreshCw,
  ChevronDown, CheckSquare, Square, XCircle, MoreVertical,
  Users, Merge, Eye, X, Smartphone, AlertTriangle, MessageSquare, Send,
  Clock, Plus, FileText, Maximize2, CalendarDays, Upload, Calendar, User, Save, Edit2
} from 'lucide-react'
import { formatDistanceToNow, format } from 'date-fns'
import { es } from 'date-fns/locale'
import ImportCSVModal from '@/components/ImportCSVModal'

interface ContactDeviceName {
  id: string
  contact_id: string
  device_id: string
  name: string | null
  push_name: string | null
  business_name: string | null
  device_name: string | null
  synced_at: string
}

interface Contact {
  id: string
  account_id: string
  device_id: string | null
  jid: string
  phone: string | null
  name: string | null
  last_name: string | null
  short_name: string | null
  custom_name: string | null
  push_name: string | null
  avatar_url: string | null
  email: string | null
  company: string | null
  age: number | null
  tags: string[] | null
  notes: string | null
  source: string | null
  is_group: boolean
  created_at: string
  updated_at: string
  device_names?: ContactDeviceName[]
}

interface Device {
  id: string
  name: string
  phone?: string
  status: string
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

function getDisplayName(c: Contact): string {
  return c.custom_name || c.name || c.push_name || c.phone || c.jid || '?'
}

function getInitials(c: Contact): string {
  const name = getDisplayName(c)
  if (!name || name === '?') return '?'
  // Filter to only letters/digits for initials
  const cleaned = name.replace(/[^a-zA-Z0-9\s\u00C0-\u024F]/g, '').trim()
  if (!cleaned) return name.charAt(0).toUpperCase()
  const parts = cleaned.split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return cleaned.substring(0, 2).toUpperCase()
}

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([])
  const [devices, setDevices] = useState<Device[]>([])
  const [loading, setLoading] = useState(true)
  const [total, setTotal] = useState(0)
  const [searchTerm, setSearchTerm] = useState('')
  const [filterDevice, setFilterDevice] = useState('')
  const [page, setPage] = useState(0)
  const pageSize = 50

  // Selection
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Detail / Edit
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null)
  const [showDetailPanel, setShowDetailPanel] = useState(false)
  const [showEditModal, setShowEditModal] = useState(false)
  const [editForm, setEditForm] = useState({
    custom_name: '',
    last_name: '',
    short_name: '',
    phone: '',
    email: '',
    company: '',
    age: '',
    tags: '',
    notes: '',
  })

  // Duplicates
  const [showDuplicates, setShowDuplicates] = useState(false)
  const [duplicateGroups, setDuplicateGroups] = useState<Contact[][]>([])
  const [loadingDuplicates, setLoadingDuplicates] = useState(false)

  // Sync
  const [syncing, setSyncing] = useState(false)
  const [showImportModal, setShowImportModal] = useState(false)

  // Send message
  const [showSendMessage, setShowSendMessage] = useState(false)
  const [sendDeviceId, setSendDeviceId] = useState('')
  const [sendLoading, setSendLoading] = useState(false)
  const router = useRouter()

  // Observations
  const [observations, setObservations] = useState<Observation[]>([])
  const [loadingObservations, setLoadingObservations] = useState(false)
  const [newObservation, setNewObservation] = useState('')
  const [savingObservation, setSavingObservation] = useState(false)
  const [obsDisplayCount, setObsDisplayCount] = useState(5)
  const [showHistoryModal, setShowHistoryModal] = useState(false)
  const [historyFilterType, setHistoryFilterType] = useState('')
  const [historyFilterFrom, setHistoryFilterFrom] = useState('')
  const [historyFilterTo, setHistoryFilterTo] = useState('')

  // Inline editing
  const [editingField, setEditingField] = useState<string | null>(null)
  const [editValues, setEditValues] = useState<Record<string, string>>({})
  const [savingField, setSavingField] = useState(false)
  const [editingNotes, setEditingNotes] = useState(false)
  const [notesValue, setNotesValue] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)

  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null

  const fetchContacts = useCallback(async () => {
    if (!token) return
    try {
      const params = new URLSearchParams()
      if (searchTerm) params.set('search', searchTerm)
      if (filterDevice) params.set('device_id', filterDevice)
      params.set('limit', String(pageSize))
      params.set('offset', String(page * pageSize))
      params.set('has_phone', 'false')

      const res = await fetch(`/api/contacts?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        setContacts(data.contacts || [])
        setTotal(data.total || 0)
      }
    } catch (err) {
      console.error('Failed to fetch contacts:', err)
    } finally {
      setLoading(false)
    }
  }, [token, searchTerm, filterDevice, page])

  const fetchDevices = useCallback(async () => {
    if (!token) return
    try {
      const res = await fetch('/api/devices', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        setDevices(data.devices || [])
      }
    } catch (err) {
      console.error('Failed to fetch devices:', err)
    }
  }, [token])

  useEffect(() => {
    fetchDevices()
  }, [fetchDevices])

  useEffect(() => {
    setLoading(true)
    const timer = setTimeout(() => {
      fetchContacts()
    }, 500) // Debounce search
    return () => clearTimeout(timer)
  }, [fetchContacts])

  // Reset page on filter change
  useEffect(() => {
    setPage(0)
  }, [searchTerm, filterDevice])

  // Lock body scroll when detail panel is open
  useEffect(() => {
    if (showDetailPanel) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [showDetailPanel])

  const openDetail = async (contact: Contact) => {
    // Fetch full contact with device names
    try {
      const res = await fetch(`/api/contacts/${contact.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        setSelectedContact(data.contact)
        setShowDetailPanel(true)
        setObsDisplayCount(5)
        setEditingField(null)
        setEditingNotes(false)
        setNotesValue(data.contact.notes || '')
        fetchObservations(data.contact.id)
      }
    } catch {
      setSelectedContact(contact)
      setShowDetailPanel(true)
      setObsDisplayCount(5)
      setEditingField(null)
      setEditingNotes(false)
      setNotesValue(contact.notes || '')
      fetchObservations(contact.id)
    }
  }

  const startEditingContact = (field: string, currentValue: string) => {
    setEditingField(field)
    setEditValues({ ...editValues, [field]: currentValue })
  }

  const cancelEditingContact = () => {
    setEditingField(null)
  }

  const saveContactField = async (field: string) => {
    if (!selectedContact?.id) return
    setSavingField(true)
    try {
      const payload: Record<string, string | number | null> = {}
      const val = editValues[field]?.trim() ?? ''
      if (field === 'age') {
        payload[field] = val ? parseInt(val, 10) : null
      } else if (field === 'custom_name') {
        payload[field] = val || null
      } else {
        payload[field] = val || null
      }
      const res = await fetch(`/api/contacts/${selectedContact.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (data.success && data.contact) {
        setSelectedContact(data.contact)
        fetchContacts()
      }
    } catch (err) {
      console.error('Failed to save contact field:', err)
    } finally {
      setSavingField(false)
      setEditingField(null)
    }
  }

  const handleContactFieldKeyDown = (e: React.KeyboardEvent, field: string) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      saveContactField(field)
    } else if (e.key === 'Escape') {
      cancelEditingContact()
    }
  }

  const saveContactNotes = async () => {
    if (!selectedContact) return
    setSavingNotes(true)
    try {
      const res = await fetch(`/api/contacts/${selectedContact.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ notes: notesValue }),
      })
      const data = await res.json()
      if (data.success && data.contact) {
        setSelectedContact(data.contact)
        fetchContacts()
      }
      setEditingNotes(false)
    } catch (err) {
      console.error('Failed to save notes:', err)
    } finally {
      setSavingNotes(false)
    }
  }

  const fetchObservations = async (contactId: string) => {
    setLoadingObservations(true)
    try {
      const res = await fetch(`/api/contacts/${contactId}/interactions?limit=100`, {
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
    if (!selectedContact || !newObservation.trim()) return
    setSavingObservation(true)
    try {
      const res = await fetch('/api/interactions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          contact_id: selectedContact.id,
          type: 'note',
          notes: newObservation.trim(),
        }),
      })
      const data = await res.json()
      if (data.success) {
        setNewObservation('')
        fetchObservations(selectedContact.id)
      }
    } catch (err) {
      console.error('Failed to add observation:', err)
    } finally {
      setSavingObservation(false)
    }
  }

  const handleDeleteObservation = async (obsId: string) => {
    if (!selectedContact) return
    if (!confirm('¿Eliminar esta observación?')) return
    try {
      const res = await fetch(`/api/interactions/${obsId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        fetchObservations(selectedContact.id)
      }
    } catch (err) {
      console.error('Failed to delete observation:', err)
    }
  }

  const openEditModal = (contact: Contact) => {
    setSelectedContact(contact)
    setEditForm({
      custom_name: contact.custom_name || '',
      last_name: contact.last_name || '',
      short_name: contact.short_name || '',
      phone: contact.phone || '',
      email: contact.email || '',
      company: contact.company || '',
      age: contact.age ? String(contact.age) : '',
      tags: (contact.tags || []).join(', '),
      notes: contact.notes || '',
    })
    setShowEditModal(true)
  }

  const handleUpdateContact = async () => {
    if (!selectedContact) return
    try {
      const res = await fetch(`/api/contacts/${selectedContact.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          custom_name: editForm.custom_name || null,
          last_name: editForm.last_name || null,
          short_name: editForm.short_name || null,
          phone: editForm.phone || null,
          email: editForm.email || null,
          company: editForm.company || null,
          age: editForm.age ? parseInt(editForm.age) : null,
          tags: editForm.tags.split(',').map(t => t.trim()).filter(Boolean),
          notes: editForm.notes || null,
        }),
      })
      const data = await res.json()
      if (data.success) {
        setShowEditModal(false)
        fetchContacts()
        if (showDetailPanel && data.contact) {
          setSelectedContact(data.contact)
        }
      } else {
        alert(data.error || 'Error al actualizar contacto')
      }
    } catch {
      alert('Error de conexión')
    }
  }

  const handleResetFromDevice = async (contactId: string) => {
    if (!confirm('¿Restaurar datos del dispositivo? Se eliminará el nombre personalizado.')) return
    try {
      const res = await fetch(`/api/contacts/${contactId}/reset`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        fetchContacts()
        if (data.contact) setSelectedContact(data.contact)
      } else {
        alert(data.error || 'Error al restaurar')
      }
    } catch {
      alert('Error de conexión')
    }
  }

  const handleDeleteContact = async (contactId: string) => {
    if (!confirm('¿Estás seguro de eliminar este contacto?')) return
    try {
      const res = await fetch(`/api/contacts/${contactId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        setShowDetailPanel(false)
        setSelectedContact(null)
        fetchContacts()
      }
    } catch {
      alert('Error de conexión')
    }
  }

  const handleDeleteSelected = async () => {
    if (selectedIds.size === 0) return
    if (!confirm(`¿Eliminar ${selectedIds.size} contacto(s)?`)) return
    try {
      const res = await fetch('/api/contacts/batch', {
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
        fetchContacts()
      }
    } catch {
      alert('Error de conexión')
    }
  }

  const toggleSelection = (id: string) => {
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelectedIds(next)
  }

  const handleFindDuplicates = async () => {
    setLoadingDuplicates(true)
    try {
      const res = await fetch('/api/contacts/duplicates', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        setDuplicateGroups(data.duplicates || [])
        setShowDuplicates(true)
      }
    } catch {
      alert('Error buscando duplicados')
    } finally {
      setLoadingDuplicates(false)
    }
  }

  const handleMerge = async (keepId: string, mergeIds: string[]) => {
    if (!confirm(`¿Fusionar ${mergeIds.length + 1} contactos? Los duplicados se eliminarán.`)) return
    try {
      const res = await fetch('/api/contacts/merge', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ keep_id: keepId, merge_ids: mergeIds }),
      })
      const data = await res.json()
      if (data.success) {
        fetchContacts()
        handleFindDuplicates() // Refresh duplicates
      }
    } catch {
      alert('Error al fusionar')
    }
  }

  const handleSyncAll = async () => {
    const connectedDevices = devices.filter(d => d.status === 'connected')
    if (connectedDevices.length === 0) {
      alert('No hay dispositivos conectados')
      return
    }
    setSyncing(true)
    try {
      for (const device of connectedDevices) {
        await fetch(`/api/devices/${device.id}/sync-contacts`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        })
      }
      // Refresh after a short delay to let sync complete
      setTimeout(() => {
        fetchContacts()
        setSyncing(false)
      }, 3000)
    } catch {
      setSyncing(false)
      alert('Error al sincronizar')
    }
  }

  const handleSendMessageToContact = async (deviceId?: string) => {
    const devId = deviceId || sendDeviceId
    if (!selectedContact || !devId) return
    setSendDeviceId(devId)
    setSendLoading(true)

    const phone = selectedContact.phone || selectedContact.jid?.replace(/@.*$/, '') || ''
    if (!phone) {
      alert('Este contacto no tiene número de teléfono')
      setSendLoading(false)
      return
    }

    try {
      const res = await fetch('/api/chats/new', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          device_id: devId,
          phone: phone.replace(/[^0-9]/g, ''),
        }),
      })
      const data = await res.json()
      if (data.success) {
        setShowSendMessage(false)
        setShowDetailPanel(false)
        router.push(`/dashboard/chats?open=${data.chat.id}`)
      } else {
        alert(data.error || 'Error al crear conversación')
      }
    } catch {
      alert('Error de conexión')
    } finally {
      setSendLoading(false)
    }
  }

  const totalPages = Math.ceil(total / pageSize)

  if (loading && contacts.length === 0) {
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
          <h1 className="text-2xl font-bold text-gray-900">Contactos</h1>
          <p className="text-gray-600 mt-1">{total} contactos en total</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {selectionMode ? (
            <>
              <span className="flex items-center px-3 py-2 text-sm text-gray-600">
                {selectedIds.size} seleccionado(s)
              </span>
              <button
                onClick={() => setSelectedIds(new Set(contacts.map(c => c.id)))}
                className="px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Seleccionar todos
              </button>
              <button
                onClick={handleDeleteSelected}
                disabled={selectedIds.size === 0}
                className="px-3 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
              >
                Eliminar ({selectedIds.size})
              </button>
              <button
                onClick={() => { setSelectionMode(false); setSelectedIds(new Set()) }}
                className="px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                <XCircle className="w-4 h-4" />
              </button>
            </>
          ) : (
            <>
              <button
                onClick={handleSyncAll}
                disabled={syncing}
                className="inline-flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition disabled:opacity-50"
              >
                <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
                {syncing ? 'Sincronizando...' : 'Sincronizar'}
              </button>
              <button
                onClick={() => setShowImportModal(true)}
                className="inline-flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition"
              >
                <Upload className="w-4 h-4" />
                Importar CSV
              </button>
              <button
                onClick={handleFindDuplicates}
                disabled={loadingDuplicates}
                className="inline-flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition disabled:opacity-50"
              >
                <Merge className="w-4 h-4" />
                Duplicados
              </button>
              <button
                onClick={() => setSelectionMode(true)}
                className="inline-flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition"
              >
                <CheckSquare className="w-4 h-4" />
                Seleccionar
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
            placeholder="Buscar por nombre, teléfono, email, empresa..."
            className="w-full pl-10 pr-4 py-2.5 bg-white border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 text-gray-900 placeholder:text-gray-400"
          />
        </div>
        <div className="relative">
          <Smartphone className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
          <select
            value={filterDevice}
            onChange={(e) => setFilterDevice(e.target.value)}
            className="pl-10 pr-8 py-2.5 bg-white border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 appearance-none cursor-pointer text-gray-900"
          >
            <option value="">Todos los dispositivos</option>
            {devices.map(d => (
              <option key={d.id} value={d.id}>{d.name} {d.phone ? `(${d.phone})` : ''}</option>
            ))}
          </select>
          <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
        </div>
      </div>

      {/* Contacts Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                {selectionMode && <th className="w-10 px-4 py-3" />}
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-600">Contacto</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-600">Teléfono</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-600 hidden md:table-cell">Email</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-600 hidden lg:table-cell">Empresa</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-600 hidden lg:table-cell">Etiquetas</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-600 hidden md:table-cell">Fuente</th>
                <th className="w-10 px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {contacts.length === 0 ? (
                <tr>
                  <td colSpan={selectionMode ? 8 : 7} className="text-center py-12 text-gray-500">
                    <Users className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                    <p className="text-lg font-medium">No hay contactos</p>
                    <p className="text-sm mt-1">Los contactos se sincronizan automáticamente desde tus dispositivos WhatsApp</p>
                  </td>
                </tr>
              ) : contacts.map((contact) => (
                <tr
                  key={contact.id}
                  className={`hover:bg-gray-50 cursor-pointer transition ${
                    selectedIds.has(contact.id) ? 'bg-green-50' : ''
                  }`}
                  onClick={() => selectionMode ? toggleSelection(contact.id) : openDetail(contact)}
                >
                  {selectionMode && (
                    <td className="px-4 py-3">
                      <button onClick={(e) => { e.stopPropagation(); toggleSelection(contact.id) }}>
                        {selectedIds.has(contact.id) ? (
                          <CheckSquare className="w-5 h-5 text-green-600" />
                        ) : (
                          <Square className="w-5 h-5 text-gray-400" />
                        )}
                      </button>
                    </td>
                  )}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      {contact.avatar_url ? (
                        <img
                          src={contact.avatar_url}
                          alt=""
                          className="w-10 h-10 rounded-full object-cover"
                        />
                      ) : (
                        <div className="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center flex-shrink-0 overflow-hidden">
                          <span className="text-green-700 font-medium text-sm">
                            {getInitials(contact)}
                          </span>
                        </div>
                      )}
                      <div className="min-w-0">
                        <p className="font-medium text-gray-900 truncate">
                          {getDisplayName(contact)}
                        </p>
                        {contact.custom_name && contact.name && (
                          <p className="text-xs text-gray-400 truncate">
                            WA: {contact.name}
                          </p>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-700">
                    {contact.phone || <span className="text-gray-400">-</span>}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-700 hidden md:table-cell">
                    {contact.email || <span className="text-gray-400">-</span>}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-700 hidden lg:table-cell">
                    {contact.company || <span className="text-gray-400">-</span>}
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell">
                    <div className="flex flex-wrap gap-1">
                      {(contact.tags || []).slice(0, 2).map((tag, i) => (
                        <span key={i} className="px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded">
                          {tag}
                        </span>
                      ))}
                      {(contact.tags || []).length > 2 && (
                        <span className="text-xs text-gray-400">+{(contact.tags || []).length - 2}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500 hidden md:table-cell">
                    {contact.source || 'whatsapp'}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={(e) => { e.stopPropagation(); openEditModal(contact) }}
                      className="p-1 text-gray-400 hover:text-gray-600 rounded"
                    >
                      <MoreVertical className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 bg-gray-50">
            <p className="text-sm text-gray-600">
              Mostrando {page * pageSize + 1}-{Math.min((page + 1) * pageSize, total)} de {total}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0}
                className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-white disabled:opacity-50"
              >
                Anterior
              </button>
              <button
                onClick={() => setPage(p => p + 1)}
                disabled={page >= totalPages - 1}
                className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-white disabled:opacity-50"
              >
                Siguiente
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Detail Panel (Slide-over) */}
      {showDetailPanel && selectedContact && (
        <div className="fixed inset-0 z-50 flex justify-end overflow-hidden">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" onClick={() => { setShowDetailPanel(false); setEditingField(null); setEditingNotes(false) }} />
          <div className="relative w-full max-w-md bg-white shadow-2xl overflow-y-auto overscroll-contain border-l border-slate-200">
            {/* Detail Header */}
            <div className="sticky top-0 bg-white/95 backdrop-blur-sm border-b border-slate-100 p-4 flex items-center justify-between z-10">
              <h2 className="text-sm font-semibold text-slate-900">Detalle del Contacto</h2>
              <button onClick={() => { setShowDetailPanel(false); setEditingField(null); setEditingNotes(false) }} className="p-1.5 hover:bg-slate-100 rounded-lg">
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </div>

            <div className="p-6 space-y-6">
              {/* Avatar + Name */}
              <div className="text-center">
                {selectedContact.avatar_url ? (
                  <img src={selectedContact.avatar_url} alt="" className="w-14 h-14 rounded-full object-cover mx-auto mb-2" />
                ) : (
                  <div className="w-14 h-14 bg-emerald-50 rounded-full flex items-center justify-center mx-auto mb-2">
                    <span className="text-emerald-700 font-bold text-lg">{getInitials(selectedContact)}</span>
                  </div>
                )}
                {editingField === 'custom_name' ? (
                  <input
                    autoFocus
                    value={editValues.custom_name ?? ''}
                    onChange={(e) => setEditValues({ ...editValues, custom_name: e.target.value })}
                    onKeyDown={(e) => handleContactFieldKeyDown(e, 'custom_name')}
                    onBlur={() => saveContactField('custom_name')}
                    className="text-lg font-bold text-slate-900 text-center bg-transparent border-b-2 border-emerald-500 outline-none w-full max-w-[250px] mx-auto block"
                    placeholder="Nombre"
                  />
                ) : (
                  <h3
                    className="text-lg font-bold text-slate-900 cursor-pointer hover:text-emerald-700 transition-colors"
                    onClick={() => startEditingContact('custom_name', selectedContact.custom_name || getDisplayName(selectedContact))}
                    title="Clic para editar nombre"
                  >
                    {getDisplayName(selectedContact)}
                  </h3>
                )}
                {selectedContact.push_name && selectedContact.push_name !== getDisplayName(selectedContact) && (
                  <p className="text-xs text-slate-400 mt-0.5">Push: {selectedContact.push_name}</p>
                )}
                <p className="text-xs text-slate-400">{selectedContact.jid}</p>
              </div>

              {/* Inline editable info fields */}
              <div className="space-y-3">
                <h5 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Información</h5>

                {/* Phone */}
                <div className="flex items-center gap-3 group">
                  <Phone className="w-4 h-4 text-emerald-600 shrink-0" />
                  {editingField === 'phone' ? (
                    <input autoFocus value={editValues.phone ?? ''} onChange={(e) => setEditValues({ ...editValues, phone: e.target.value })} onKeyDown={(e) => handleContactFieldKeyDown(e, 'phone')} onBlur={() => saveContactField('phone')} className="flex-1 text-sm text-slate-800 bg-transparent border-b-2 border-emerald-500 outline-none" placeholder="Teléfono" />
                  ) : (
                    <span className={`text-sm flex-1 cursor-pointer hover:text-emerald-700 ${selectedContact.phone ? 'text-slate-800' : 'text-slate-400 italic'}`} onClick={() => startEditingContact('phone', selectedContact.phone || '')} title="Clic para editar">
                      {selectedContact.phone || 'Agregar teléfono'}
                    </span>
                  )}
                </div>

                {/* Email */}
                <div className="flex items-center gap-3 group">
                  <Mail className="w-4 h-4 text-emerald-600 shrink-0" />
                  {editingField === 'email' ? (
                    <input autoFocus value={editValues.email ?? ''} onChange={(e) => setEditValues({ ...editValues, email: e.target.value })} onKeyDown={(e) => handleContactFieldKeyDown(e, 'email')} onBlur={() => saveContactField('email')} className="flex-1 text-sm text-slate-800 bg-transparent border-b-2 border-emerald-500 outline-none" placeholder="correo@ejemplo.com" />
                  ) : (
                    <span className={`text-sm flex-1 cursor-pointer hover:text-emerald-700 ${selectedContact.email ? 'text-slate-800' : 'text-slate-400 italic'}`} onClick={() => startEditingContact('email', selectedContact.email || '')} title="Clic para editar">
                      {selectedContact.email || 'Agregar email'}
                    </span>
                  )}
                </div>

                {/* Last Name */}
                <div className="flex items-center gap-3 group">
                  <User className="w-4 h-4 text-emerald-600 shrink-0" />
                  {editingField === 'last_name' ? (
                    <input autoFocus value={editValues.last_name ?? ''} onChange={(e) => setEditValues({ ...editValues, last_name: e.target.value })} onKeyDown={(e) => handleContactFieldKeyDown(e, 'last_name')} onBlur={() => saveContactField('last_name')} className="flex-1 text-sm text-slate-800 bg-transparent border-b-2 border-emerald-500 outline-none" placeholder="Apellido" />
                  ) : (
                    <span className={`text-sm flex-1 cursor-pointer hover:text-emerald-700 ${selectedContact.last_name ? 'text-slate-800' : 'text-slate-400 italic'}`} onClick={() => startEditingContact('last_name', selectedContact.last_name || '')} title="Clic para editar">
                      {selectedContact.last_name || 'Agregar apellido'}
                    </span>
                  )}
                </div>

                {/* Company */}
                <div className="flex items-center gap-3 group">
                  <Building2 className="w-4 h-4 text-emerald-600 shrink-0" />
                  {editingField === 'company' ? (
                    <input autoFocus value={editValues.company ?? ''} onChange={(e) => setEditValues({ ...editValues, company: e.target.value })} onKeyDown={(e) => handleContactFieldKeyDown(e, 'company')} onBlur={() => saveContactField('company')} className="flex-1 text-sm text-slate-800 bg-transparent border-b-2 border-emerald-500 outline-none" placeholder="Empresa" />
                  ) : (
                    <span className={`text-sm flex-1 cursor-pointer hover:text-emerald-700 ${selectedContact.company ? 'text-slate-800' : 'text-slate-400 italic'}`} onClick={() => startEditingContact('company', selectedContact.company || '')} title="Clic para editar">
                      {selectedContact.company || 'Agregar empresa'}
                    </span>
                  )}
                </div>

                {/* Age */}
                <div className="flex items-center gap-3 group">
                  <Calendar className="w-4 h-4 text-emerald-600 shrink-0" />
                  {editingField === 'age' ? (
                    <input autoFocus type="number" value={editValues.age ?? ''} onChange={(e) => setEditValues({ ...editValues, age: e.target.value })} onKeyDown={(e) => handleContactFieldKeyDown(e, 'age')} onBlur={() => saveContactField('age')} className="flex-1 text-sm text-slate-800 bg-transparent border-b-2 border-emerald-500 outline-none" placeholder="Edad" />
                  ) : (
                    <span className={`text-sm flex-1 cursor-pointer hover:text-emerald-700 ${selectedContact.age ? 'text-slate-800' : 'text-slate-400 italic'}`} onClick={() => startEditingContact('age', selectedContact.age?.toString() || '')} title="Clic para editar">
                      {selectedContact.age ? `${selectedContact.age} años` : 'Agregar edad'}
                    </span>
                  )}
                </div>
              </div>

              {/* Tags */}
              {selectedContact.tags && selectedContact.tags.length > 0 && (
                <div className="space-y-2">
                  <h5 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Etiquetas</h5>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedContact.tags.map((tag, i) => (
                      <span key={i} className="px-2 py-0.5 bg-emerald-50 text-emerald-700 text-xs rounded-full font-medium">
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Notes */}
              <div className="border-t border-slate-100 pt-4">
                <div className="flex items-center justify-between mb-3">
                  <h5 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Notas</h5>
                  {editingNotes ? (
                    <button onClick={saveContactNotes} disabled={savingNotes} className="flex items-center gap-1 text-xs font-semibold text-emerald-600 hover:text-emerald-700">
                      <Save className="w-3.5 h-3.5" />
                      {savingNotes ? 'Guardando...' : 'Guardar'}
                    </button>
                  ) : (
                    <button onClick={() => { setEditingNotes(true); setNotesValue(selectedContact.notes || '') }} className="flex items-center gap-1 text-xs font-semibold text-emerald-600 hover:text-emerald-700">
                      <Edit2 className="w-3.5 h-3.5" />
                      Editar
                    </button>
                  )}
                </div>
                {editingNotes ? (
                  <textarea
                    value={notesValue}
                    onChange={(e) => setNotesValue(e.target.value)}
                    className="w-full h-28 p-3 text-sm text-slate-800 border-2 border-emerald-500 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:border-transparent resize-none placeholder:text-slate-400"
                    placeholder="Escribe notas sobre este contacto..."
                  />
                ) : (
                  <div className="text-sm text-slate-700 bg-slate-50 rounded-xl p-3 min-h-[50px] border border-slate-100">
                    {selectedContact.notes || <span className="text-slate-400 italic">Sin notas</span>}
                  </div>
                )}
              </div>

              {/* Device Names */}
              {selectedContact.device_names && selectedContact.device_names.length > 0 && (
                <div className="border-t border-slate-100 pt-4">
                  <h5 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 flex items-center gap-2">
                    <Smartphone className="w-3.5 h-3.5" />
                    Nombres por Dispositivo
                  </h5>
                  <div className="space-y-2">
                    {selectedContact.device_names.map((dn) => (
                      <div key={dn.id} className="p-3 bg-slate-50 rounded-xl text-sm border border-slate-100">
                        <p className="font-medium text-slate-700">{dn.device_name || 'Dispositivo'}</p>
                        <div className="text-slate-500 mt-1 space-y-0.5">
                          {dn.name && <p>Nombre: {dn.name}</p>}
                          {dn.push_name && <p>Push: {dn.push_name}</p>}
                          {dn.business_name && <p>Negocio: {dn.business_name}</p>}
                        </div>
                        <p className="text-[10px] text-slate-400 mt-1">
                          Sincronizado {formatDistanceToNow(new Date(dn.synced_at), { locale: es, addSuffix: true })}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Actions */}
              <div className="flex flex-col gap-2 pt-2 border-t border-slate-100">
                <button
                  onClick={() => {
                    const connDevices = devices.filter(d => d.status === 'connected')
                    if (connDevices.length === 0) {
                      alert('No hay dispositivos conectados')
                      return
                    }
                    if (connDevices.length === 1) {
                      setSendDeviceId(connDevices[0].id)
                    } else {
                      setSendDeviceId('')
                    }
                    setShowSendMessage(true)
                  }}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 transition text-sm font-medium shadow-sm"
                >
                  <MessageSquare className="w-4 h-4" />
                  Enviar Mensaje
                </button>
                <button
                  onClick={() => handleResetFromDevice(selectedContact.id)}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2 border border-slate-200 text-slate-600 rounded-xl hover:bg-slate-50 text-sm"
                >
                  <RefreshCw className="w-4 h-4" />
                  Restaurar del Dispositivo
                </button>
                <button
                  onClick={() => handleDeleteContact(selectedContact.id)}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2 border border-red-200 text-red-500 rounded-xl hover:bg-red-50 text-sm"
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
                <p>Creado: {new Date(selectedContact.created_at).toLocaleDateString('es')}</p>
                <p>Actualizado: {formatDistanceToNow(new Date(selectedContact.updated_at), { locale: es, addSuffix: true })}</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {showEditModal && selectedContact && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl p-6 w-full max-w-md max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold text-gray-900 mb-4">Editar Contacto</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Nombre personalizado</label>
                <input
                  type="text"
                  value={editForm.custom_name}
                  onChange={(e) => setEditForm({ ...editForm, custom_name: e.target.value })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 text-gray-900 placeholder:text-gray-400"
                  placeholder={selectedContact.name || selectedContact.push_name || 'Nombre del contacto'}
                />
                <p className="text-xs text-gray-400 mt-1">
                  Nombre original: {selectedContact.name || selectedContact.push_name || '-'}
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Apellido</label>
                  <input
                    type="text"
                    value={editForm.last_name}
                    onChange={(e) => setEditForm({ ...editForm, last_name: e.target.value })}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 text-gray-900 placeholder:text-gray-400"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Nombre Corto</label>
                  <input
                    type="text"
                    value={editForm.short_name}
                    onChange={(e) => setEditForm({ ...editForm, short_name: e.target.value })}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 text-gray-900 placeholder:text-gray-400"
                    placeholder="Apodo o nombre corto"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Teléfono</label>
                <input
                  type="tel"
                  value={editForm.phone}
                  onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 text-gray-900 placeholder:text-gray-400"
                  placeholder="+51 999 888 777"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                <input
                  type="email"
                  value={editForm.email}
                  onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 text-gray-900 placeholder:text-gray-400"
                  placeholder="correo@ejemplo.com"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Empresa</label>
                  <input
                    type="text"
                    value={editForm.company}
                    onChange={(e) => setEditForm({ ...editForm, company: e.target.value })}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 text-gray-900 placeholder:text-gray-400"
                    placeholder="Nombre de la empresa"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Edad</label>
                  <input
                    type="number"
                    value={editForm.age}
                    onChange={(e) => setEditForm({ ...editForm, age: e.target.value })}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 text-gray-900 placeholder:text-gray-400"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Etiquetas</label>
                <input
                  type="text"
                  value={editForm.tags}
                  onChange={(e) => setEditForm({ ...editForm, tags: e.target.value })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 text-gray-900 placeholder:text-gray-400"
                  placeholder="cliente, vip, urgente (separadas por coma)"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notas</label>
                <textarea
                  value={editForm.notes}
                  onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                  rows={3}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 text-gray-900 placeholder:text-gray-400"
                  placeholder="Notas sobre este contacto..."
                />
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => { setShowEditModal(false); setSelectedContact(null) }}
                className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
              >
                Cancelar
              </button>
              <button
                onClick={handleUpdateContact}
                className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
              >
                Guardar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Duplicates Modal */}
      {showDuplicates && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-yellow-500" />
                <h2 className="text-lg font-semibold text-gray-900">
                  Contactos Duplicados ({duplicateGroups.length} grupos)
                </h2>
              </div>
              <button onClick={() => setShowDuplicates(false)} className="p-1 hover:bg-gray-100 rounded">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {duplicateGroups.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  <CheckSquare className="w-12 h-12 mx-auto mb-3 text-green-500" />
                  <p className="font-medium">No se encontraron duplicados</p>
                </div>
              ) : duplicateGroups.map((group, gi) => (
                <div key={gi} className="border border-yellow-200 rounded-lg p-4 bg-yellow-50/50">
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-sm font-medium text-gray-700">
                      Teléfono: {group[0]?.phone || 'desconocido'} ({group.length} contactos)
                    </p>
                    <button
                      onClick={() => handleMerge(group[0].id, group.slice(1).map(c => c.id))}
                      className="flex items-center gap-1 px-3 py-1 text-sm bg-yellow-500 text-white rounded-lg hover:bg-yellow-600"
                    >
                      <Merge className="w-3.5 h-3.5" />
                      Fusionar
                    </button>
                  </div>
                  <div className="space-y-2">
                    {group.map((contact, ci) => (
                      <div key={contact.id} className="flex items-center gap-3 p-2 bg-white rounded-lg">
                        <div className="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center flex-shrink-0">
                          <span className="text-green-700 text-xs font-medium">{getInitials(contact)}</span>
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-gray-900 truncate">{getDisplayName(contact)}</p>
                          <p className="text-xs text-gray-500">{contact.jid}</p>
                        </div>
                        {ci === 0 && (
                          <span className="px-2 py-0.5 bg-green-100 text-green-700 text-xs rounded font-medium">
                            Se mantiene
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Send Message Modal */}
      {showSendMessage && selectedContact && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4">
          <div className="bg-white rounded-xl p-6 w-full max-w-sm">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center">
                <Send className="w-5 h-5 text-green-600" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-gray-900">Enviar Mensaje</h3>
                <p className="text-sm text-gray-500">{getDisplayName(selectedContact)}</p>
              </div>
            </div>
            <p className="text-sm text-gray-600 mb-4">
              Selecciona el dispositivo para iniciar la conversación:
            </p>
            {devices.filter(d => d.status === 'connected').length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-4">No hay dispositivos conectados</p>
            ) : (
              <div className="space-y-2">
                {devices.filter(d => d.status === 'connected').map((device) => (
                  <button
                    key={device.id}
                    onClick={() => handleSendMessageToContact(device.id)}
                    disabled={sendLoading}
                    className="w-full flex items-center gap-3 p-3 border border-gray-200 rounded-lg hover:bg-green-50 hover:border-green-300 transition text-left disabled:opacity-50"
                  >
                    <div className="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center">
                      <Smartphone className="w-5 h-5 text-green-600" />
                    </div>
                    <div className="flex-1">
                      <p className="font-medium text-gray-900">{device.name || 'Dispositivo'}</p>
                      <p className="text-xs text-gray-500">{device.phone || ''}</p>
                    </div>
                    {sendLoading && sendDeviceId === device.id && (
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-green-600" />
                    )}
                  </button>
                ))}
              </div>
            )}
            <button
              onClick={() => { setShowSendMessage(false); setSendDeviceId('') }}
              className="w-full mt-4 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {/* Full History Modal */}
      {showHistoryModal && selectedContact && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Historial Completo</h2>
                <p className="text-sm text-gray-500">{getDisplayName(selectedContact)} &mdash; {observations.length} registros</p>
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

      <ImportCSVModal
        open={showImportModal}
        onClose={() => setShowImportModal(false)}
        onSuccess={fetchContacts}
        defaultType="contacts"
      />
    </div>
  )
}
