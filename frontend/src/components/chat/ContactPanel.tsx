'use client'

import { useState, useEffect } from 'react'
import { X, User, Phone, Mail, Tag, FileText, Edit2, Save, Smartphone, Clock, Plus, Trash2, Maximize2, XCircle, Building2, Calendar } from 'lucide-react'
import { formatDistanceToNow, format } from 'date-fns'
import { es } from 'date-fns/locale'
import ImageViewer from '@/components/chat/ImageViewer'
import TagInput from '@/components/TagInput'

interface StructuredTag {
  id: string
  account_id: string
  name: string
  color: string
}

interface Contact {
  id: string
  jid: string
  phone?: string
  name?: string
  custom_name?: string
  last_name?: string
  short_name?: string
  push_name?: string
  avatar_url?: string
  email?: string
  company?: string
  age?: number
  notes?: string
  is_group: boolean
  structured_tags?: StructuredTag[]
}

interface Lead {
  id: string
  jid: string
  name?: string
  short_name?: string
  phone?: string
  email?: string
  status?: string
  source?: string
  notes?: string
  tags?: string[]
  pipeline_id?: string
  stage_id?: string
  stage_name?: string
  stage_color?: string
  stage_position?: number
  kommo_id?: number
  structured_tags?: StructuredTag[]
}

interface PipelineStage {
  id: string
  pipeline_id: string
  name: string
  color: string
  position: number
}

interface Pipeline {
  id: string
  name: string
  is_default: boolean
  stages: PipelineStage[]
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

  // Pipeline stages
  const [pipelines, setPipelines] = useState<Pipeline[]>([])

  // Observations
  const [observations, setObservations] = useState<Observation[]>([])
  const [loadingObservations, setLoadingObservations] = useState(false)
  const [newObservation, setNewObservation] = useState('')
  const [obsType, setObsType] = useState<'note' | 'call'>('note')
  const [savingObservation, setSavingObservation] = useState(false)
  const [obsDisplayCount, setObsDisplayCount] = useState(5)
  const [showHistoryModal, setShowHistoryModal] = useState(false)
  const [historyFilterType, setHistoryFilterType] = useState('')
  const [historyFilterFrom, setHistoryFilterFrom] = useState('')
  const [historyFilterTo, setHistoryFilterTo] = useState('')

  useEffect(() => {
    if (isOpen && chatId) {
      fetchDetails()
      fetchPipelines()
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

  const fetchPipelines = async () => {
    const token = localStorage.getItem('token')
    try {
      const res = await fetch('/api/pipelines', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        setPipelines(data.pipelines || [])
      }
    } catch (err) {
      console.error('Failed to fetch pipelines:', err)
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
      const payload: Record<string, string | number | null> = {}
      const val = editValues[field]?.trim() ?? ''
      const fieldMap: Record<string, string> = {
        name: 'custom_name',
        phone: 'phone',
        email: 'email',
        company: 'company',
        short_name: 'short_name',
        last_name: 'last_name',
        age: 'age',
      }
      if (field === 'age') {
        payload[fieldMap[field]] = val ? parseInt(val, 10) : null
      } else {
        payload[fieldMap[field] || field] = val || null
      }
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

  const handleUpdateLeadStage = async (stageId: string) => {
    if (!lead) return
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/leads/${lead.id}/stage`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ stage_id: stageId }),
      })
      const data = await res.json()
      if (data.success) {
        for (const p of pipelines) {
          const stage = p.stages?.find(s => s.id === stageId)
          if (stage) {
            setLead({ ...lead, stage_id: stageId, stage_name: stage.name, stage_color: stage.color, stage_position: stage.position, pipeline_id: p.id })
            break
          }
        }
      }
    } catch (err) {
      console.error('Failed to update lead stage:', err)
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
          lead_id: lead?.id || undefined,
          type: obsType,
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

  if (!isOpen) return null

  const cleanName = (name?: string | null) => name?.replace(/^[\s.·•\-]+/, '').trim() || ''
  const displayName = cleanName(contact?.custom_name) || cleanName(contact?.name) || cleanName(contact?.push_name) || cleanName(lead?.name) || 'Contacto'
  const rawPhone = contact?.phone || lead?.phone || ''
  const displayPhone = rawPhone ? (rawPhone.startsWith('+') ? rawPhone : '+' + rawPhone) : ''
  const avatarUrl = contact?.avatar_url
  const fmtDevicePhone = devicePhone ? (devicePhone.startsWith('+') ? devicePhone : '+' + devicePhone) : ''

  // Get stages for the lead's pipeline
  const leadPipeline = lead?.pipeline_id ? pipelines.find(p => p.id === lead.pipeline_id) : (pipelines.length > 0 ? pipelines[0] : null)
  const stages = leadPipeline?.stages?.sort((a, b) => a.position - b.position) || []

  const renderInlineField = (field: string, icon: React.ReactNode, currentValue: string | undefined | null, placeholder: string, inputType: string = 'text') => (
    <div className="flex items-center gap-3 group">
      <div className="w-4 h-4 shrink-0">{icon}</div>
      {contact && editingField === field ? (
        <input
          autoFocus
          type={inputType}
          value={editValues[field] ?? ''}
          onChange={(e) => setEditValues({ ...editValues, [field]: e.target.value })}
          onKeyDown={(e) => handleFieldKeyDown(e, field)}
          onBlur={() => saveContactField(field)}
          className="flex-1 text-sm text-slate-900 bg-transparent border-b-2 border-emerald-500 outline-none px-0 py-0"
          placeholder={placeholder}
        />
      ) : (
        <span
          className={`text-sm flex-1 ${contact ? 'cursor-pointer hover:text-emerald-700' : ''} ${currentValue ? 'text-slate-900' : 'text-slate-400 italic'}`}
          onClick={() => contact && startEditing(field, (currentValue || '').toString())}
          title={contact ? 'Clic para editar' : undefined}
        >
          {field === 'phone' ? (displayPhone || placeholder) : (currentValue || placeholder)}
        </span>
      )}
    </div>
  )

  return (
    <div className="border-l border-slate-200 bg-white flex flex-col h-full w-full">
      {/* Header */}
      <div className="px-4 py-3.5 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
        <h3 className="text-base font-bold text-slate-900">Contacto</h3>
        <button onClick={onClose} className="p-1 hover:bg-slate-200 rounded-lg transition">
          <X className="w-5 h-5 text-slate-500" />
        </button>
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-600" />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {/* Avatar and name */}
          <div className="p-5 text-center border-b border-slate-200">
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt={displayName}
                className="w-20 h-20 rounded-full mx-auto mb-3 object-cover cursor-pointer hover:opacity-80 transition ring-2 ring-slate-300 hover:ring-emerald-400 shadow-sm"
                onClick={() => setShowAvatarViewer(true)}
              />
            ) : (
              <div className="w-20 h-20 bg-emerald-50 rounded-full mx-auto mb-3 flex items-center justify-center shadow-sm">
                <User className="w-10 h-10 text-emerald-600" />
              </div>
            )}
            {contact && editingField === 'name' ? (
              <div className="flex items-center justify-center gap-1">
                <input
                  autoFocus
                  value={editValues.name ?? ''}
                  onChange={(e) => setEditValues({ ...editValues, name: e.target.value })}
                  onKeyDown={(e) => handleFieldKeyDown(e, 'name')}
                  onBlur={() => saveContactField('name')}
                  className="text-xl font-semibold text-slate-900 text-center bg-transparent border-b-2 border-emerald-500 outline-none w-full max-w-[250px] px-1"
                  placeholder="Nombre"
                />
              </div>
            ) : (
              <h4
                className={`text-xl font-semibold text-slate-900 ${contact ? 'cursor-pointer hover:text-emerald-700 transition-colors' : ''}`}
                onClick={() => contact && startEditing('name', displayName !== 'Contacto' ? displayName : '')}
                title={contact ? 'Clic para editar nombre' : undefined}
              >
                {displayName}
              </h4>
            )}
            {lead?.stage_name && (
              <span
                className="inline-block mt-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold text-white"
                style={{ backgroundColor: lead.stage_color || '#6b7280' }}
              >
                {lead.stage_name}
              </span>
            )}
            {displayPhone && (
              <p className="text-slate-600 text-sm mt-1 font-medium">{displayPhone}</p>
            )}
          </div>

          {/* Device info */}
          {(deviceName || devicePhone) && (
            <div className="px-4 py-3 border-b border-slate-200">
              <div className="flex items-center gap-2 text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
                <Smartphone className="w-3.5 h-3.5 text-slate-500" />
                <span>Dispositivo</span>
              </div>
              <p className="text-sm font-semibold text-slate-900">{deviceName || 'Sin nombre'}</p>
              {fmtDevicePhone && (
                <p className="text-xs text-slate-600">{fmtDevicePhone}</p>
              )}
            </div>
          )}

          {/* Contact info - inline editable */}
          <div className="px-4 py-3 border-b border-slate-200 space-y-2.5">
            <h5 className="text-xs font-bold text-slate-700 uppercase tracking-wider">Información</h5>
            {renderInlineField('phone', <Phone className="w-4 h-4 text-slate-500" />, contact?.phone, 'Agregar teléfono')}
            {renderInlineField('email', <Mail className="w-4 h-4 text-slate-500" />, contact?.email || lead?.email, 'Agregar email')}
            {renderInlineField('last_name', <User className="w-4 h-4 text-slate-500" />, contact?.last_name, 'Agregar apellido')}
            {renderInlineField('short_name', <Edit2 className="w-4 h-4 text-slate-500" />, contact?.short_name, 'Agregar nombre corto')}
            {renderInlineField('company', <Building2 className="w-4 h-4 text-slate-500" />, contact?.company, 'Agregar empresa')}
            {renderInlineField('age', <Calendar className="w-4 h-4 text-slate-500" />, contact?.age?.toString(), 'Edad', 'number')}
            {lead?.source && (
              <div className="flex items-center gap-3">
                <Tag className="w-4 h-4 text-slate-500" />
                <span className="text-sm text-slate-800 capitalize">{lead.source}</span>
              </div>
            )}
          </div>

          {/* Contact Tags */}
          {contact && (
            <div className="px-4 py-3 border-b border-slate-200">
              <h5 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-2">Etiquetas del Contacto</h5>
              <TagInput
                entityType="contact"
                entityId={contact.id}
                assignedTags={contact.structured_tags || []}
                onTagsChange={(newTags) => {
                  setContact({ ...contact, structured_tags: newTags })
                }}
              />
            </div>
          )}

          {/* Lead Tags */}
          {lead && (
            <div className="px-4 py-3 border-b border-slate-200">
              <h5 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-2">Etiquetas del Lead</h5>
              <TagInput
                entityType="lead"
                entityId={lead.id}
                assignedTags={lead.structured_tags || []}
                onTagsChange={(newTags) => {
                  setLead({ ...lead, structured_tags: newTags })
                }}
              />
            </div>
          )}

          {/* Pipeline Stages */}
          {lead && stages.length > 0 && (
            <div className="px-4 py-3 border-b border-slate-200">
              <h5 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-2">Etapa del Lead</h5>
              <div className="flex flex-wrap gap-1.5">
                {stages.map(stage => (
                  <button
                    key={stage.id}
                    onClick={() => handleUpdateLeadStage(stage.id)}
                    className="px-3 py-1.5 rounded-full text-xs font-semibold transition-all"
                    style={
                      lead.stage_id === stage.id
                        ? { backgroundColor: stage.color || '#6b7280', color: 'white' }
                        : { backgroundColor: '#f1f5f9', color: '#475569' }
                    }
                    onMouseEnter={(e) => {
                      if (lead.stage_id !== stage.id) {
                        e.currentTarget.style.backgroundColor = '#e2e8f0'
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (lead.stage_id !== stage.id) {
                        e.currentTarget.style.backgroundColor = '#f1f5f9'
                      }
                    }}
                  >
                    {stage.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Notes */}
          {lead && (
            <div className="px-4 py-3 border-b border-slate-200">
              <div className="flex items-center justify-between mb-2">
                <h5 className="text-xs font-bold text-slate-700 uppercase tracking-wider">Notas</h5>
                {editingNotes ? (
                  <button
                    onClick={saveNotes}
                    disabled={saving}
                    className="flex items-center gap-1 text-xs font-medium text-emerald-600 hover:text-emerald-700"
                  >
                    <Save className="w-3.5 h-3.5" />
                    {saving ? 'Guardando...' : 'Guardar'}
                  </button>
                ) : (
                  <button
                    onClick={() => setEditingNotes(true)}
                    className="flex items-center gap-1 text-xs font-medium text-slate-400 hover:text-emerald-600"
                  >
                    <Edit2 className="w-3.5 h-3.5" />
                    Editar
                  </button>
                )}
              </div>
              {editingNotes ? (
                  <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full h-24 p-3 text-sm text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 resize-none placeholder:text-slate-400"
                  placeholder="Escribe notas sobre este contacto..."
                />
              ) : (
                <div className="text-sm text-slate-800 bg-slate-50 rounded-lg p-3 min-h-[60px] border border-slate-200">
                  {lead.notes || <span className="text-slate-400 italic text-xs">Sin notas</span>}
                </div>
              )}
            </div>
          )}

          {/* Observations / History */}
          {contact && (
            <div className="px-4 py-3">
              <div className="flex items-center justify-between mb-2">
                <h5 className="text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center gap-1.5">
                  <FileText className="w-3.5 h-3.5 text-slate-500" />
                  Observaciones
                </h5>
                {observations.length > 0 && (
                  <button
                    onClick={() => setShowHistoryModal(true)}
                    className="p-1 text-slate-400 hover:text-emerald-600 hover:bg-slate-100 rounded transition"
                    title="Ver historial completo"
                  >
                    <Maximize2 className="w-4 h-4" />
                  </button>
                )}
              </div>

              {/* Type toggle */}
              <div className="flex gap-1.5 mb-2">
                <button
                  onClick={() => setObsType('note')}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition ${
                    obsType === 'note' ? 'bg-yellow-100 text-yellow-700 ring-1 ring-yellow-300' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  Nota
                </button>
                <button
                  onClick={() => setObsType('call')}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition ${
                    obsType === 'call' ? 'bg-blue-100 text-blue-700 ring-1 ring-blue-300' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  Llamada
                </button>
              </div>

              {/* Add observation */}
              <div className="mb-3">
                <textarea
                  value={newObservation}
                  onChange={(e) => setNewObservation(e.target.value)}
                  placeholder={obsType === 'call' ? 'Registrar resultado de llamada...' : 'Escribir una observación...'}
                  rows={2}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 text-sm text-slate-800 placeholder:text-slate-400 resize-none bg-slate-50"
                />
                <button
                  onClick={handleAddObservation}
                  disabled={!newObservation.trim() || savingObservation}
                  className="mt-1.5 inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white text-xs font-medium rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition"
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
                  <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-emerald-600" />
                </div>
              ) : observations.length === 0 ? (
                <p className="text-xs text-slate-400 text-center py-3">Sin observaciones aún</p>
              ) : (
                <div className="space-y-1.5">
                  {observations.slice(0, obsDisplayCount).map((obs) => (
                    <div key={obs.id} className="p-2.5 bg-slate-50 rounded-lg group relative border border-slate-200">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-slate-800 whitespace-pre-wrap break-words leading-relaxed">
                            {obs.notes?.startsWith('(sinc) ') ? obs.notes.slice(6) : (obs.notes || '(sin contenido)')}
                          </p>
                          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                            <Clock className="w-3 h-3 text-slate-300" />
                            <span className="text-xs text-slate-400">
                              {formatDistanceToNow(new Date(obs.created_at), { locale: es, addSuffix: true })}
                            </span>
                            {obs.created_by_name && (
                              <span className="text-xs text-slate-500">
                                &mdash; {obs.created_by_name}
                              </span>
                            )}
                            {obs.type === 'call' && (
                              <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 text-xs rounded font-medium">
                                Llamada
                              </span>
                            )}
                            {obs.type !== 'note' && obs.type !== 'call' && (
                              <span className="px-1.5 py-0.5 bg-slate-100 text-slate-600 text-xs rounded">
                                {obs.type}
                              </span>
                            )}
                            {obs.notes?.startsWith('(sinc) ') && (
                              <span className="px-1.5 py-0.5 bg-purple-100 text-purple-700 text-xs rounded font-medium">
                                Kommo
                              </span>
                            )}
                          </div>
                        </div>
                        <button
                          onClick={() => handleDeleteObservation(obs.id)}
                          className="p-1 text-slate-300 hover:text-red-500 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity shrink-0"
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
                      className="w-full py-1.5 text-xs text-emerald-600 hover:text-emerald-700 hover:bg-slate-100 rounded-lg transition font-medium"
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
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">Historial Completo</h2>
                <p className="text-sm text-slate-500">{displayName} &mdash; {observations.length} registros</p>
              </div>
              <button onClick={() => { setShowHistoryModal(false); setHistoryFilterType(''); setHistoryFilterFrom(''); setHistoryFilterTo('') }} className="p-1 text-slate-400 hover:text-slate-600 rounded">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Filters */}
            <div className="px-6 py-3 border-b border-slate-100 bg-slate-50">
              <div className="flex items-center gap-3 flex-wrap">
                <div>
                  <label className="text-[10px] text-slate-500 uppercase tracking-wider mb-1 block">Tipo</label>
                  <select
                    value={historyFilterType}
                    onChange={(e) => setHistoryFilterType(e.target.value)}
                    className="px-3 py-1.5 border border-slate-300 rounded-lg text-sm text-slate-700 focus:ring-2 focus:ring-emerald-500"
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
                  <label className="text-[10px] text-slate-500 uppercase tracking-wider mb-1 block">Desde</label>
                  <input
                    type="date"
                    value={historyFilterFrom}
                    onChange={(e) => setHistoryFilterFrom(e.target.value)}
                    className="px-3 py-1.5 border border-slate-300 rounded-lg text-sm text-slate-700 focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-slate-500 uppercase tracking-wider mb-1 block">Hasta</label>
                  <input
                    type="date"
                    value={historyFilterTo}
                    onChange={(e) => setHistoryFilterTo(e.target.value)}
                    className="px-3 py-1.5 border border-slate-300 rounded-lg text-sm text-slate-700 focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
                {(historyFilterType || historyFilterFrom || historyFilterTo) && (
                  <button
                    onClick={() => { setHistoryFilterType(''); setHistoryFilterFrom(''); setHistoryFilterTo('') }}
                    className="mt-4 text-xs text-slate-500 hover:text-red-600 flex items-center gap-1"
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
                if (filtered.length === 0) return <p className="text-sm text-slate-400 text-center py-8">No hay registros con los filtros seleccionados</p>
                return (
                  <div className="space-y-3">
                    {filtered.map((obs) => (
                      <div key={obs.id} className="p-4 bg-slate-50 rounded-lg group relative border border-slate-100">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1 flex-wrap">
                              <span className={`px-2 py-0.5 text-xs rounded font-medium ${obs.type === 'note' ? 'bg-yellow-100 text-yellow-700' : obs.type === 'call' ? 'bg-blue-100 text-blue-700' : obs.type === 'whatsapp' ? 'bg-green-100 text-green-700' : obs.type === 'email' ? 'bg-purple-100 text-purple-700' : 'bg-orange-100 text-orange-700'}`}>
                                {obs.type === 'note' ? 'Nota' : obs.type === 'call' ? 'Llamada' : obs.type === 'whatsapp' ? 'WhatsApp' : obs.type === 'email' ? 'Email' : obs.type === 'meeting' ? 'Reunión' : obs.type}
                              </span>
                              {obs.notes?.startsWith('(sinc) ') && (
                                <span className="px-1.5 py-0.5 bg-purple-100 text-purple-700 text-xs rounded font-medium">
                                  Kommo
                                </span>
                              )}
                              <span className="text-xs text-slate-400">
                                {format(new Date(obs.created_at), "d MMM yyyy, HH:mm", { locale: es })}
                              </span>
                            </div>
                            <p className="text-sm text-slate-800 whitespace-pre-wrap break-words">
                              {obs.notes?.startsWith('(sinc) ') ? obs.notes.slice(6) : (obs.notes || '(sin contenido)')}
                            </p>
                            {obs.created_by_name && (
                              <p className="text-xs text-slate-400 mt-1.5">por {obs.created_by_name}</p>
                            )}
                          </div>
                          <button
                            onClick={() => handleDeleteObservation(obs.id)}
                            className="p-1 text-slate-300 hover:text-red-500 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity shrink-0"
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
