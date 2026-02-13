'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { X, User, Phone, Mail, Tag, FileText, Edit2, Save, Smartphone, Clock, Plus, Trash2, Maximize2, XCircle, Building2, Check } from 'lucide-react'
import { formatDistanceToNow, format } from 'date-fns'
import { es } from 'date-fns/locale'
import ImageViewer from '@/components/chat/ImageViewer'

interface Contact {
  id: string
  jid: string
  phone?: string
  name?: string
  custom_name?: string
  last_name?: string
  push_name?: string
  avatar_url?: string
  email?: string
  company?: string
  age?: number
  notes?: string
  is_group: boolean
}

interface Lead {
  id: string
  jid: string
  name?: string
  phone?: string
  email?: string
  status?: string
  source?: string
  notes?: string
  tags?: string[]
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

interface ContactPanelProps {
  chatId: string
  isOpen: boolean
  onClose: () => void
  deviceName?: string
  devicePhone?: string
}

const STATUS_OPTIONS = [
  { value: 'new', label: 'Nuevo', color: 'bg-blue-500' },
  { value: 'contacted', label: 'Contactado', color: 'bg-yellow-500' },
  { value: 'qualified', label: 'Calificado', color: 'bg-green-500' },
  { value: 'proposal', label: 'Propuesta', color: 'bg-purple-500' },
  { value: 'won', label: 'Ganado', color: 'bg-emerald-600' },
  { value: 'lost', label: 'Perdido', color: 'bg-red-500' },
]

export default function ContactPanel({ chatId, isOpen, onClose, deviceName, devicePhone }: ContactPanelProps) {
  const [contact, setContact] = useState<Contact | null>(null)
  const [lead, setLead] = useState<Lead | null>(null)
  const [loading, setLoading] = useState(true)
  const [editingNotes, setEditingNotes] = useState(false)
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [showAvatarViewer, setShowAvatarViewer] = useState(false)

  // Inline editing for contact fields
  const [editingField, setEditingField] = useState<string | null>(null)
  const [editValues, setEditValues] = useState<Record<string, string>>({})
  const [savingField, setSavingField] = useState(false)

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

  useEffect(() => {
    if (isOpen && chatId) {
      fetchDetails()
    }
  }, [isOpen, chatId])

  const fetchDetails = async () => {
    setLoading(true)
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/chats/${chatId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        setContact(data.contact || null)
        setLead(data.lead || null)
        setNotes(data.lead?.notes || '')
        // Fetch observations for this contact
        if (data.contact?.id) {
          fetchObservations(data.contact.id)
        }
      }
    } catch (err) {
      console.error('Failed to fetch chat details:', err)
    } finally {
      setLoading(false)
    }
  }

  const fetchObservations = async (contactId: string) => {
    setLoadingObservations(true)
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/contacts/${contactId}/interactions?limit=100`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        setObservations(data.interactions || [])
        setObsDisplayCount(5)
      }
    } catch (err) {
      console.error('Failed to fetch observations:', err)
    } finally {
      setLoadingObservations(false)
    }
  }

  const startEditing = (field: string, currentValue: string) => {
    setEditingField(field)
    setEditValues({ ...editValues, [field]: currentValue })
  }

  const cancelEditing = () => {
    setEditingField(null)
  }

  const saveContactField = async (field: string) => {
    if (!contact?.id) return
    setSavingField(true)
    const token = localStorage.getItem('token')
    try {
      const payload: Record<string, string | null> = {}
      const val = editValues[field]?.trim() ?? ''
      // Map frontend field names to API field names
      const fieldMap: Record<string, string> = {
        name: 'custom_name',
        phone: 'phone',
        email: 'email',
        company: 'company',
      }
      payload[fieldMap[field] || field] = val || null
      const res = await fetch(`/api/contacts/${contact.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (data.success && data.contact) {
        setContact(data.contact)
      }
    } catch (err) {
      console.error('Failed to save contact field:', err)
    } finally {
      setSavingField(false)
      setEditingField(null)
    }
  }

  const handleFieldKeyDown = (e: React.KeyboardEvent, field: string) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      saveContactField(field)
    } else if (e.key === 'Escape') {
      cancelEditing()
    }
  }

  const handleAddObservation = async () => {
    if (!contact?.id || !newObservation.trim()) return
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
          contact_id: contact.id,
          type: 'note',
          notes: newObservation.trim(),
        }),
      })
      const data = await res.json()
      if (data.success) {
        setNewObservation('')
        fetchObservations(contact.id)
      }
    } catch (err) {
      console.error('Failed to add observation:', err)
    } finally {
      setSavingObservation(false)
    }
  }

  const handleDeleteObservation = async (obsId: string) => {
    if (!contact?.id) return
    if (!confirm('¿Eliminar esta observación?')) return
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/interactions/${obsId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        fetchObservations(contact.id)
      }
    } catch (err) {
      console.error('Failed to delete observation:', err)
    }
  }

  const updateLeadStatus = async (status: string) => {
    if (!lead) return
    const token = localStorage.getItem('token')
    try {
      await fetch(`/api/leads/${lead.id}/status`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ status }),
      })
      setLead({ ...lead, status })
    } catch (err) {
      console.error('Failed to update lead status:', err)
    }
  }

  const saveNotes = async () => {
    if (!lead) return
    setSaving(true)
    const token = localStorage.getItem('token')
    try {
      await fetch(`/api/leads/${lead.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ notes }),
      })
      setLead({ ...lead, notes })
      setEditingNotes(false)
    } catch (err) {
      console.error('Failed to save notes:', err)
    } finally {
      setSaving(false)
    }
  }

  const getStatusInfo = (status?: string) => {
    return STATUS_OPTIONS.find(s => s.value === status) || STATUS_OPTIONS[0]
  }

  if (!isOpen) return null

  // Clean name: remove leading dots/punctuation from synced names
  const cleanName = (name?: string | null) => name?.replace(/^[\s.·•\-]+/, '').trim() || ''
  const displayName = cleanName(contact?.custom_name) || cleanName(contact?.name) || cleanName(contact?.push_name) || cleanName(lead?.name) || 'Contacto'
  const rawPhone = contact?.phone || lead?.phone || ''
  const displayPhone = rawPhone ? (rawPhone.startsWith('+') ? rawPhone : '+' + rawPhone) : ''
  const avatarUrl = contact?.avatar_url
  const fmtDevicePhone = devicePhone ? (devicePhone.startsWith('+') ? devicePhone : '+' + devicePhone) : ''

  return (
    <div className="border-l border-gray-200 bg-white flex flex-col h-full w-full">
      {/* Header */}
      <div className="p-4 border-b border-gray-200 flex items-center justify-between">
        <h3 className="font-semibold text-gray-900">Información del contacto</h3>
        <button
          onClick={onClose}
          className="p-1 hover:bg-gray-100 rounded"
        >
          <X className="w-5 h-5 text-gray-500" />
        </button>
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-600" />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {/* Avatar and name */}
          <div className="p-6 text-center border-b border-gray-100">
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt={displayName}
                className="w-24 h-24 rounded-full mx-auto mb-3 object-cover cursor-pointer hover:opacity-80 transition ring-2 ring-transparent hover:ring-green-400"
                onClick={() => setShowAvatarViewer(true)}
              />
            ) : (
              <div className="w-24 h-24 bg-green-100 rounded-full mx-auto mb-3 flex items-center justify-center">
                <User className="w-12 h-12 text-green-600" />
              </div>
            )}
            {/* Editable name */}
            {contact && editingField === 'name' ? (
              <div className="flex items-center justify-center gap-1">
                <input
                  autoFocus
                  value={editValues.name ?? ''}
                  onChange={(e) => setEditValues({ ...editValues, name: e.target.value })}
                  onKeyDown={(e) => handleFieldKeyDown(e, 'name')}
                  onBlur={() => saveContactField('name')}
                  className="text-xl font-semibold text-gray-900 text-center bg-transparent border-b-2 border-green-500 outline-none w-full max-w-[250px] px-1"
                  placeholder="Nombre"
                />
              </div>
            ) : (
              <h4
                className={`text-xl font-semibold text-gray-900 ${contact ? 'cursor-pointer hover:text-green-700 transition-colors' : ''}`}
                onClick={() => contact && startEditing('name', displayName !== 'Contacto' ? displayName : '')}
                title={contact ? 'Clic para editar nombre' : undefined}
              >
                {displayName}
              </h4>
            )}
            {displayPhone && (
              <p className="text-gray-700 font-medium mt-1">{displayPhone}</p>
            )}
          </div>

          {/* Device info */}
          {(deviceName || devicePhone) && (
            <div className="p-4 border-b border-gray-100">
              <div className="flex items-center gap-2 text-sm font-semibold text-gray-700 mb-2">
                <Smartphone className="w-4 h-4 text-green-600" />
                <span>Dispositivo</span>
              </div>
              <p className="text-sm font-bold text-gray-800">{deviceName || 'Sin nombre'}</p>
              {fmtDevicePhone && (
                <p className="text-sm font-medium text-gray-600">{fmtDevicePhone}</p>
              )}
            </div>
          )}

          {/* Contact info - inline editable */}
          <div className="p-4 border-b border-gray-100 space-y-3">
            <h5 className="text-sm font-bold text-gray-700 uppercase tracking-wide">Información</h5>
            
            {/* Phone */}
            <div className="flex items-center gap-3 group">
              <Phone className="w-4 h-4 text-green-600 shrink-0" />
              {contact && editingField === 'phone' ? (
                <input
                  autoFocus
                  value={editValues.phone ?? ''}
                  onChange={(e) => setEditValues({ ...editValues, phone: e.target.value })}
                  onKeyDown={(e) => handleFieldKeyDown(e, 'phone')}
                  onBlur={() => saveContactField('phone')}
                  className="flex-1 text-sm font-medium text-gray-800 bg-transparent border-b-2 border-green-500 outline-none px-0 py-0"
                  placeholder="Teléfono"
                />
              ) : (
                <span
                  className={`text-sm font-medium flex-1 ${contact ? 'cursor-pointer hover:text-green-700' : ''} ${displayPhone ? 'text-gray-800' : 'text-gray-400 italic'}`}
                  onClick={() => contact && startEditing('phone', contact.phone || '')}
                  title={contact ? 'Clic para editar' : undefined}
                >
                  {displayPhone || 'Agregar teléfono'}
                </span>
              )}
            </div>
            
            {/* Email */}
            <div className="flex items-center gap-3 group">
              <Mail className="w-4 h-4 text-green-600 shrink-0" />
              {contact && editingField === 'email' ? (
                <input
                  autoFocus
                  value={editValues.email ?? ''}
                  onChange={(e) => setEditValues({ ...editValues, email: e.target.value })}
                  onKeyDown={(e) => handleFieldKeyDown(e, 'email')}
                  onBlur={() => saveContactField('email')}
                  className="flex-1 text-sm font-medium text-gray-800 bg-transparent border-b-2 border-green-500 outline-none px-0 py-0"
                  placeholder="correo@ejemplo.com"
                />
              ) : (
                <span
                  className={`text-sm font-medium flex-1 ${contact ? 'cursor-pointer hover:text-green-700' : ''} ${(contact?.email || lead?.email) ? 'text-gray-800' : 'text-gray-400 italic'}`}
                  onClick={() => contact && startEditing('email', contact.email || '')}
                  title={contact ? 'Clic para editar' : undefined}
                >
                  {contact?.email || lead?.email || 'Agregar email'}
                </span>
              )}
            </div>

            {/* Company */}
            <div className="flex items-center gap-3 group">
              <Building2 className="w-4 h-4 text-green-600 shrink-0" />
              {contact && editingField === 'company' ? (
                <input
                  autoFocus
                  value={editValues.company ?? ''}
                  onChange={(e) => setEditValues({ ...editValues, company: e.target.value })}
                  onKeyDown={(e) => handleFieldKeyDown(e, 'company')}
                  onBlur={() => saveContactField('company')}
                  className="flex-1 text-sm font-medium text-gray-800 bg-transparent border-b-2 border-green-500 outline-none px-0 py-0"
                  placeholder="Empresa"
                />
              ) : (
                <span
                  className={`text-sm font-medium flex-1 ${contact ? 'cursor-pointer hover:text-green-700' : ''} ${contact?.company ? 'text-gray-800' : 'text-gray-400 italic'}`}
                  onClick={() => contact && startEditing('company', contact.company || '')}
                  title={contact ? 'Clic para editar' : undefined}
                >
                  {contact?.company || 'Agregar empresa'}
                </span>
              )}
            </div>

            {lead?.source && (
              <div className="flex items-center gap-3">
                <Tag className="w-4 h-4 text-green-600" />
                <span className="text-sm font-medium text-gray-800 capitalize">{lead.source}</span>
              </div>
            )}
          </div>

          {/* Lead status */}
          {lead && (
            <div className="p-4 border-b border-gray-100">
              <h5 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Estado del Lead</h5>
              <div className="flex flex-wrap gap-2">
                {STATUS_OPTIONS.map(option => (
                  <button
                    key={option.value}
                    onClick={() => updateLeadStatus(option.value)}
                    className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-all ${
                      lead.status === option.value
                        ? `${option.color} text-white shadow-sm`
                        : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Notes */}
          {lead && (
            <div className="p-4 border-b border-gray-100">
              <div className="flex items-center justify-between mb-3">
                <h5 className="text-sm font-bold text-gray-700 uppercase tracking-wide">Notas</h5>
                {editingNotes ? (
                  <button
                    onClick={saveNotes}
                    disabled={saving}
                    className="flex items-center gap-1 text-sm font-semibold text-green-600 hover:text-green-700"
                  >
                    <Save className="w-4 h-4" />
                    {saving ? 'Guardando...' : 'Guardar'}
                  </button>
                ) : (
                  <button
                    onClick={() => setEditingNotes(true)}
                    className="flex items-center gap-1 text-sm font-semibold text-green-600 hover:text-green-700"
                  >
                    <Edit2 className="w-4 h-4" />
                    Editar
                  </button>
                )}
              </div>
              
              {editingNotes ? (
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full h-32 p-3 text-sm text-gray-800 font-medium border-2 border-green-500 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent resize-none placeholder:text-gray-400"
                  placeholder="Escribe notas sobre este contacto..."
                />
              ) : (
                <div className="text-sm text-gray-700 font-medium bg-gray-50 rounded-lg p-3 min-h-[80px] border border-gray-200">
                  {lead.notes || <span className="text-gray-400 italic">Sin notas</span>}
                </div>
              )}
            </div>
          )}

          {/* Observations / History */}
          {contact && (
            <div className="p-4">
              <div className="flex items-center justify-between mb-3">
                <h5 className="text-sm font-bold text-gray-700 uppercase tracking-wide flex items-center gap-1.5">
                  <FileText className="w-4 h-4 text-green-600" />
                  Observaciones
                </h5>
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

              {/* Add observation */}
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
                          className="p-1 text-gray-300 hover:text-red-500 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity shrink-0"
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
          )}
        </div>
      )}

      {/* Avatar viewer */}
      {avatarUrl && (
        <ImageViewer
          src={avatarUrl}
          alt={displayName}
          isOpen={showAvatarViewer}
          onClose={() => setShowAvatarViewer(false)}
        />
      )}

      {/* Full History Modal */}
      {showHistoryModal && contact && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[70] p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Historial Completo</h2>
                <p className="text-sm text-gray-500">{displayName} &mdash; {observations.length} registros</p>
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
                            className="p-1 text-gray-300 hover:text-red-500 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity shrink-0"
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
