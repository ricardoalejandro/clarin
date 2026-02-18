'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Phone, Mail, User, Calendar, MessageCircle, Trash2, ChevronDown,
  Clock, FileText, X, Maximize2, Building2, Save, Edit2, Plus, RefreshCw, XCircle
} from 'lucide-react'
import { formatDistanceToNow, format } from 'date-fns'
import { es } from 'date-fns/locale'
import TagInput from '@/components/TagInput'

// ─── Interfaces ──────────────────────────────────────────
interface StructuredTag {
  id: string
  account_id: string
  name: string
  color: string
}

interface PipelineStage {
  id: string
  pipeline_id: string
  name: string
  color: string
  position: number
  lead_count?: number
}

interface Pipeline {
  id: string
  account_id?: string
  name: string
  description?: string | null
  is_default: boolean
  stages: PipelineStage[] | null
}

interface Lead {
  id: string
  jid: string
  contact_id: string | null
  name: string
  last_name: string | null
  short_name: string | null
  phone: string
  email: string
  company: string | null
  age: number | null
  status: string
  pipeline_id: string | null
  stage_id: string | null
  stage_name: string | null
  stage_color: string | null
  stage_position: number | null
  notes: string
  tags: string[]
  structured_tags: StructuredTag[] | null
  kommo_id: number | null
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

// ─── Props ───────────────────────────────────────────────
interface LeadDetailPanelProps {
  /** The lead to display. If null, the component renders nothing (or loading). */
  lead: Lead
  /** Called when lead data changes (field edit, pipeline change, etc.) */
  onLeadChange: (updatedLead: Lead) => void
  /** Called when close button is clicked */
  onClose: () => void
  /** Called when "Enviar WhatsApp" is clicked */
  onSendWhatsApp?: (phone: string) => void
  /** Called if lead is deleted */
  onDelete?: (leadId: string) => void
  /** Optional: hide the header (useful when embedding inside another panel with its own header) */
  hideHeader?: boolean
  /** Optional: hide delete button */
  hideDelete?: boolean
  /** Optional: hide WhatsApp button */
  hideWhatsApp?: boolean
  /** Optional: extra CSS classes */
  className?: string
}

// ─── Component ───────────────────────────────────────────
export default function LeadDetailPanel({
  lead,
  onLeadChange,
  onClose,
  onSendWhatsApp,
  onDelete,
  hideHeader = false,
  hideDelete = false,
  hideWhatsApp = false,
  className = '',
}: LeadDetailPanelProps) {
  // Pipelines
  const [pipelines, setPipelines] = useState<Pipeline[]>([])

  // Inline editing
  const [editingField, setEditingField] = useState<string | null>(null)
  const [editValues, setEditValues] = useState<Record<string, string>>({})
  const [savingField, setSavingField] = useState(false)

  // Notes
  const [editingNotes, setEditingNotes] = useState(false)
  const [notesValue, setNotesValue] = useState(lead.notes || '')
  const [savingNotes, setSavingNotes] = useState(false)

  // Observations
  const [observations, setObservations] = useState<Observation[]>([])
  const [loadingObservations, setLoadingObservations] = useState(false)
  const [newObservation, setNewObservation] = useState('')
  const [newObservationType, setNewObservationType] = useState<'note' | 'call'>('note')
  const [savingObservation, setSavingObservation] = useState(false)
  const [obsDisplayCount, setObsDisplayCount] = useState(5)

  // History modal
  const [showHistoryModal, setShowHistoryModal] = useState(false)
  const [historyFilterType, setHistoryFilterType] = useState('')
  const [historyFilterFrom, setHistoryFilterFrom] = useState('')
  const [historyFilterTo, setHistoryFilterTo] = useState('')

  // Pipeline dropdown
  const [showPipelineDropdown, setShowPipelineDropdown] = useState(false)
  const [expandedPipelineId, setExpandedPipelineId] = useState<string | null>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Kommo sync
  const [syncingKommo, setSyncingKommo] = useState(false)

  // ─── Fetch pipelines ───────────────────────────────────
  useEffect(() => {
    const token = localStorage.getItem('token')
    fetch('/api/pipelines', { headers: { Authorization: `Bearer ${token}` } })
      .then(res => res.json())
      .then(data => {
        if (data.success) setPipelines(data.pipelines || [])
      })
      .catch(console.error)
  }, [])

  // ─── Fetch observations when lead changes ──────────────
  useEffect(() => {
    setNotesValue(lead.notes || '')
    setEditingField(null)
    setEditingNotes(false)
    setObsDisplayCount(5)
    fetchObservations(lead.id)
  }, [lead.id])

  // ─── Click outside to close dropdown ───────────────────
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowPipelineDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // ─── API helpers ───────────────────────────────────────
  const fetchObservations = async (leadId: string) => {
    setLoadingObservations(true)
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/leads/${leadId}/interactions?limit=100`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) setObservations(data.interactions || [])
    } catch (err) {
      console.error('Failed to fetch observations:', err)
    } finally {
      setLoadingObservations(false)
    }
  }

  const saveLeadField = async (field: string) => {
    if (!lead?.id) return
    setSavingField(true)
    const token = localStorage.getItem('token')
    try {
      const payload: Record<string, string | number | null> = {}
      const val = editValues[field]?.trim() ?? ''
      if (field === 'age') {
        payload[field] = val ? parseInt(val, 10) : null
      } else {
        payload[field] = val || null
      }
      const res = await fetch(`/api/leads/${lead.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (data.success && data.lead) {
        const merged = { ...data.lead, structured_tags: data.lead.structured_tags || lead.structured_tags }
        onLeadChange(merged)
      }
    } catch (err) {
      console.error('Failed to save lead field:', err)
    } finally {
      setSavingField(false)
      setEditingField(null)
    }
  }

  const saveNotes = async () => {
    setSavingNotes(true)
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/leads/${lead.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ notes: notesValue }),
      })
      const data = await res.json()
      if (data.success && data.lead) {
        const merged = { ...data.lead, structured_tags: data.lead.structured_tags || lead.structured_tags }
        onLeadChange(merged)
      }
      setEditingNotes(false)
    } catch (err) {
      console.error('Failed to save notes:', err)
    } finally {
      setSavingNotes(false)
    }
  }

  const handleUpdateLeadStage = async (leadId: string, stageId: string) => {
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/leads/${leadId}/stage`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ stage_id: stageId }),
      })
      const data = await res.json()
      if (data.success) {
        let stage: PipelineStage | undefined
        for (const p of pipelines) {
          const found = p.stages?.find(s => s.id === stageId)
          if (found) { stage = found; break }
        }
        onLeadChange({
          ...lead,
          stage_id: stageId,
          stage_name: stage?.name || null,
          stage_color: stage?.color || null,
          stage_position: stage?.position ?? null,
        })
      }
    } catch (err) {
      console.error('Failed to update stage:', err)
    }
  }

  const handleUpdateLeadPipeline = async (leadId: string, pipelineId: string) => {
    const token = localStorage.getItem('token')
    const newPipeline = pipelines.find(p => p.id === pipelineId)
    const firstStageId = pipelineId ? (newPipeline?.stages?.[0]?.id || null) : null
    try {
      const res = await fetch(`/api/leads/${leadId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ pipeline_id: pipelineId || null, stage_id: firstStageId }),
      })
      const data = await res.json()
      if (data.success && data.lead) {
        const merged = { ...data.lead, structured_tags: data.lead.structured_tags || lead.structured_tags }
        onLeadChange(merged)
      }
    } catch (err) {
      console.error('Failed to update pipeline:', err)
    }
  }

  const handleAddObservation = async () => {
    if (!newObservation.trim()) return
    setSavingObservation(true)
    const token = localStorage.getItem('token')
    try {
      const res = await fetch('/api/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          lead_id: lead.id,
          type: newObservationType,
          notes: newObservation.trim(),
        }),
      })
      const data = await res.json()
      if (data.success) {
        setNewObservation('')
        fetchObservations(lead.id)
      }
    } catch (err) {
      console.error('Failed to add observation:', err)
    } finally {
      setSavingObservation(false)
    }
  }

  const handleDeleteObservation = async (obsId: string) => {
    if (!confirm('¿Eliminar esta observación?')) return
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/interactions/${obsId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) fetchObservations(lead.id)
    } catch (err) {
      console.error('Failed to delete observation:', err)
    }
  }

  const handleSyncKommo = async () => {
    setSyncingKommo(true)
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/leads/${lead.id}/sync-kommo`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success && data.lead) {
        onLeadChange(data.lead)
        fetchObservations(lead.id)
      } else {
        alert(data.error || 'Error al sincronizar')
      }
    } catch (err) {
      console.error('Sync error:', err)
      alert('Error de conexión al sincronizar')
    } finally {
      setSyncingKommo(false)
    }
  }

  const handleDeleteLead = async () => {
    if (!confirm('¿Estás seguro de eliminar este lead?')) return
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/leads/${lead.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        onDelete?.(lead.id)
        onClose()
      }
    } catch (err) {
      console.error('Failed to delete lead:', err)
    }
  }

  // ─── Helpers ───────────────────────────────────────────
  const startEditing = (field: string, currentValue: string) => {
    setEditingField(field)
    setEditValues({ ...editValues, [field]: currentValue })
  }

  const cancelEditing = () => setEditingField(null)

  const handleFieldKeyDown = (e: React.KeyboardEvent, field: string) => {
    if (e.key === 'Enter') { e.preventDefault(); saveLeadField(field) }
    else if (e.key === 'Escape') cancelEditing()
  }

  // ─── Render ────────────────────────────────────────────
  return (
    <div className={`flex flex-col h-full overflow-hidden bg-white ${className}`}>
      {/* Header */}
      {!hideHeader && (
        <div className="sticky top-0 bg-white/95 backdrop-blur-sm border-b border-slate-100 p-4 flex items-center justify-between z-10 shrink-0">
          <h2 className="text-sm font-semibold text-slate-900">Detalle del Lead</h2>
          <div className="flex items-center gap-1">
            {lead.kommo_id && (
              <button
                onClick={handleSyncKommo}
                disabled={syncingKommo}
                title="Sincronizar desde Kommo"
                className="p-1.5 hover:bg-emerald-50 rounded-lg text-slate-400 hover:text-emerald-600 transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`w-4 h-4 ${syncingKommo ? 'animate-spin' : ''}`} />
              </button>
            )}
            <button onClick={onClose} className="p-1.5 hover:bg-slate-100 rounded-lg">
              <X className="w-4 h-4 text-slate-400" />
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* Lead Avatar & Name */}
        <div className="text-center">
          <div className="w-12 h-12 bg-emerald-50 rounded-full flex items-center justify-center mx-auto mb-2">
            <span className="text-emerald-700 font-bold text-base">
              {(lead.name || '?').charAt(0).toUpperCase()}
            </span>
          </div>
          {editingField === 'name' ? (
            <input
              autoFocus
              value={editValues.name ?? ''}
              onChange={(e) => setEditValues({ ...editValues, name: e.target.value })}
              onKeyDown={(e) => handleFieldKeyDown(e, 'name')}
              onBlur={() => saveLeadField('name')}
              className="text-lg font-bold text-slate-900 text-center bg-transparent border-b-2 border-emerald-500 outline-none w-full max-w-[250px] mx-auto block"
              placeholder="Nombre"
            />
          ) : (
            <h3
              className="text-lg font-bold text-slate-900 cursor-pointer hover:text-emerald-700 transition-colors"
              onClick={() => startEditing('name', lead.name || '')}
              title="Clic para editar nombre"
            >
              {lead.name || 'Sin nombre'}
            </h3>
          )}
          {lead.stage_name && (
            <span
              className="inline-block px-2 py-0.5 text-xs rounded-full mt-1 text-white"
              style={{ backgroundColor: lead.stage_color || '#6b7280' }}
            >
              {lead.stage_name}
            </span>
          )}
        </div>

        {/* Inline editable info fields */}
        <div className="space-y-3">
          <h5 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Información</h5>

          {/* Phone */}
          <div className="flex items-center gap-3 group">
            <Phone className="w-4 h-4 text-emerald-600 shrink-0" />
            {editingField === 'phone' ? (
              <input autoFocus value={editValues.phone ?? ''} onChange={(e) => setEditValues({ ...editValues, phone: e.target.value })} onKeyDown={(e) => handleFieldKeyDown(e, 'phone')} onBlur={() => saveLeadField('phone')} className="flex-1 text-sm text-slate-800 bg-transparent border-b-2 border-emerald-500 outline-none" placeholder="Teléfono" />
            ) : (
              <span className={`text-sm flex-1 cursor-pointer hover:text-emerald-700 ${lead.phone ? 'text-slate-800' : 'text-slate-400 italic'}`} onClick={() => startEditing('phone', lead.phone || '')} title="Clic para editar">
                {lead.phone || 'Agregar teléfono'}
              </span>
            )}
          </div>

          {/* Email */}
          <div className="flex items-center gap-3 group">
            <Mail className="w-4 h-4 text-emerald-600 shrink-0" />
            {editingField === 'email' ? (
              <input autoFocus value={editValues.email ?? ''} onChange={(e) => setEditValues({ ...editValues, email: e.target.value })} onKeyDown={(e) => handleFieldKeyDown(e, 'email')} onBlur={() => saveLeadField('email')} className="flex-1 text-sm text-slate-800 bg-transparent border-b-2 border-emerald-500 outline-none" placeholder="correo@ejemplo.com" />
            ) : (
              <span className={`text-sm flex-1 cursor-pointer hover:text-emerald-700 ${lead.email ? 'text-slate-800' : 'text-slate-400 italic'}`} onClick={() => startEditing('email', lead.email || '')} title="Clic para editar">
                {lead.email || 'Agregar email'}
              </span>
            )}
          </div>

          {/* Last Name */}
          <div className="flex items-center gap-3 group">
            <User className="w-4 h-4 text-emerald-600 shrink-0" />
            {editingField === 'last_name' ? (
              <input autoFocus value={editValues.last_name ?? ''} onChange={(e) => setEditValues({ ...editValues, last_name: e.target.value })} onKeyDown={(e) => handleFieldKeyDown(e, 'last_name')} onBlur={() => saveLeadField('last_name')} className="flex-1 text-sm text-slate-800 bg-transparent border-b-2 border-emerald-500 outline-none" placeholder="Apellido" />
            ) : (
              <span className={`text-sm flex-1 cursor-pointer hover:text-emerald-700 ${lead.last_name ? 'text-slate-800' : 'text-slate-400 italic'}`} onClick={() => startEditing('last_name', lead.last_name || '')} title="Clic para editar">
                {lead.last_name || 'Agregar apellido'}
              </span>
            )}
          </div>

          {/* Short Name */}
          <div className="flex items-center gap-3 group">
            <Edit2 className="w-4 h-4 text-emerald-600 shrink-0" />
            {editingField === 'short_name' ? (
              <input autoFocus value={editValues.short_name ?? ''} onChange={(e) => setEditValues({ ...editValues, short_name: e.target.value })} onKeyDown={(e) => handleFieldKeyDown(e, 'short_name')} onBlur={() => saveLeadField('short_name')} className="flex-1 text-sm text-slate-800 bg-transparent border-b-2 border-emerald-500 outline-none" placeholder="Nombre corto" />
            ) : (
              <span className={`text-sm flex-1 cursor-pointer hover:text-emerald-700 ${lead.short_name ? 'text-slate-800' : 'text-slate-400 italic'}`} onClick={() => startEditing('short_name', lead.short_name || '')} title="Clic para editar">
                {lead.short_name || 'Agregar nombre corto'}
              </span>
            )}
          </div>

          {/* Company */}
          <div className="flex items-center gap-3 group">
            <Building2 className="w-4 h-4 text-emerald-600 shrink-0" />
            {editingField === 'company' ? (
              <input autoFocus value={editValues.company ?? ''} onChange={(e) => setEditValues({ ...editValues, company: e.target.value })} onKeyDown={(e) => handleFieldKeyDown(e, 'company')} onBlur={() => saveLeadField('company')} className="flex-1 text-sm text-slate-800 bg-transparent border-b-2 border-emerald-500 outline-none" placeholder="Empresa" />
            ) : (
              <span className={`text-sm flex-1 cursor-pointer hover:text-emerald-700 ${lead.company ? 'text-slate-800' : 'text-slate-400 italic'}`} onClick={() => startEditing('company', lead.company || '')} title="Clic para editar">
                {lead.company || 'Agregar empresa'}
              </span>
            )}
          </div>

          {/* Age */}
          <div className="flex items-center gap-3 group">
            <Calendar className="w-4 h-4 text-emerald-600 shrink-0" />
            {editingField === 'age' ? (
              <input autoFocus type="number" value={editValues.age ?? ''} onChange={(e) => setEditValues({ ...editValues, age: e.target.value })} onKeyDown={(e) => handleFieldKeyDown(e, 'age')} onBlur={() => saveLeadField('age')} className="flex-1 text-sm text-slate-800 bg-transparent border-b-2 border-emerald-500 outline-none" placeholder="Edad" />
            ) : (
              <span className={`text-sm flex-1 cursor-pointer hover:text-emerald-700 ${lead.age ? 'text-slate-800' : 'text-slate-400 italic'}`} onClick={() => startEditing('age', lead.age?.toString() || '')} title="Clic para editar">
                {lead.age ? `${lead.age} años` : 'Agregar edad'}
              </span>
            )}
          </div>
        </div>

        {/* Tags */}
        <div className="space-y-2">
          <h5 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Etiquetas</h5>
          <TagInput
            entityType="lead"
            entityId={lead.id}
            assignedTags={lead.structured_tags || []}
            onTagsChange={(newTags) => {
              onLeadChange({ ...lead, structured_tags: newTags })
            }}
          />
        </div>

        {/* Pipeline & Stage Selector (Accordion) */}
        <div className="border-t border-slate-100 pt-4" ref={dropdownRef}>
          <h5 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Etapa del Pipeline</h5>

          <div className="relative">
            {/* Main Button */}
            <button
              onClick={() => setShowPipelineDropdown(!showPipelineDropdown)}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl border transition-all ${
                lead.stage_id
                  ? 'bg-white border-slate-200 text-slate-700 hover:border-emerald-300 hover:shadow-sm'
                  : 'bg-slate-50 border-slate-200 text-slate-500'
              }`}
            >
              <div className="flex items-center gap-2 overflow-hidden">
                {lead.stage_color && (
                  <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: lead.stage_color }} />
                )}
                <span className="truncate text-sm font-medium">
                  {lead.stage_name || lead.pipeline_id ? (
                    <>
                      <span className="opacity-50 font-normal">{pipelines.find(p => p.id === lead.pipeline_id)?.name || 'Sin Pipeline'}</span>
                      <span className="mx-1.5 opacity-30">/</span>
                      {lead.stage_name || 'Sin etapa'}
                    </>
                  ) : 'Leads Entrantes (Sin asignar)'}
                </span>
              </div>
              <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${showPipelineDropdown ? 'rotate-180' : ''}`} />
            </button>

            {/* Dropdown */}
            {showPipelineDropdown && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-white rounded-xl shadow-xl border border-slate-100 overflow-hidden z-20 max-h-[400px] overflow-y-auto">
                {/* Unassigned */}
                <button
                  className="w-full text-left px-3 py-2 hover:bg-slate-50 cursor-pointer flex items-center gap-2 border-b border-slate-50 transition-colors"
                  onClick={() => {
                    handleUpdateLeadPipeline(lead.id, '')
                    setShowPipelineDropdown(false)
                  }}
                  type="button"
                >
                  <div className="w-2 h-2 rounded-full bg-slate-300" />
                  <span className="text-sm text-slate-600">Leads Entrantes (Sin Asignar)</span>
                </button>

                {/* Pipelines and Stages */}
                {pipelines.map(pipeline => {
                  const isExpanded = expandedPipelineId === pipeline.id
                  return (
                    <div key={pipeline.id} className="border-b border-slate-50 last:border-0">
                      <button
                        className={`w-full flex items-center justify-between px-3 py-2 text-left transition-colors ${
                          isExpanded ? 'bg-slate-50' : 'hover:bg-slate-50 bg-white'
                        }`}
                        onClick={() => setExpandedPipelineId(prev => prev === pipeline.id ? null : pipeline.id)}
                        type="button"
                      >
                        <span className="text-xs font-bold text-slate-600 uppercase tracking-wider">{pipeline.name}</span>
                        <ChevronDown className={`w-3.5 h-3.5 text-slate-400 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`} />
                      </button>

                      <div className={`transition-all duration-300 ease-in-out overflow-hidden ${isExpanded ? 'max-h-[500px] opacity-100' : 'max-h-0 opacity-0'}`}>
                        <div className="p-1 bg-slate-50/30 border-t border-slate-100">
                          {pipeline.stages?.map(stage => (
                            <button
                              key={stage.id}
                              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors text-left ${
                                lead.stage_id === stage.id ? 'bg-emerald-50 text-emerald-700' : 'hover:bg-slate-100 text-slate-700'
                              }`}
                              onClick={() => {
                                if (lead.pipeline_id !== pipeline.id) {
                                  // Cross-pipeline move
                                  const token = localStorage.getItem('token')
                                  fetch(`/api/leads/${lead.id}`, {
                                    method: 'PUT',
                                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                                    body: JSON.stringify({ pipeline_id: pipeline.id, stage_id: stage.id })
                                  }).then(res => res.json()).then(data => {
                                    if (data.success && data.lead) {
                                      const merged = { ...data.lead, structured_tags: data.lead.structured_tags || lead.structured_tags }
                                      onLeadChange(merged)
                                    }
                                  })
                                } else {
                                  handleUpdateLeadStage(lead.id, stage.id)
                                }
                                setShowPipelineDropdown(false)
                              }}
                              type="button"
                            >
                              <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: stage.color }} />
                              <span className="text-sm truncate">{stage.name}</span>
                              {lead.stage_id === stage.id && <div className="ml-auto w-1.5 h-1.5 rounded-full bg-emerald-500" />}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        {/* Notes */}
        <div className="border-t border-slate-100 pt-4">
          <div className="flex items-center justify-between mb-3">
            <h5 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Notas</h5>
            {editingNotes ? (
              <button onClick={saveNotes} disabled={savingNotes} className="flex items-center gap-1 text-xs font-semibold text-emerald-600 hover:text-emerald-700">
                <Save className="w-3.5 h-3.5" />
                {savingNotes ? 'Guardando...' : 'Guardar'}
              </button>
            ) : (
              <button onClick={() => { setEditingNotes(true); setNotesValue(lead.notes || '') }} className="flex items-center gap-1 text-xs font-semibold text-emerald-600 hover:text-emerald-700">
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
              placeholder="Escribe notas sobre este lead..."
            />
          ) : (
            <div className="text-sm text-slate-700 bg-slate-50 rounded-xl p-3 min-h-[50px] border border-slate-100">
              {lead.notes || <span className="text-slate-400 italic">Sin notas</span>}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-2 pt-2 border-t border-slate-100">
          {!hideWhatsApp && lead.phone && (
            <button
              onClick={() => onSendWhatsApp?.(lead.phone)}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 transition text-sm font-medium shadow-sm"
            >
              <MessageCircle className="w-4 h-4" />
              Enviar WhatsApp
            </button>
          )}
          {!hideDelete && (
            <button
              onClick={handleDeleteLead}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 border border-red-200 text-red-500 rounded-xl hover:bg-red-50 text-sm"
            >
              <Trash2 className="w-4 h-4" />
              Eliminar
            </button>
          )}
        </div>

        {/* Observations / History */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-xs font-semibold text-slate-500 flex items-center gap-2">
              <FileText className="w-3.5 h-3.5" />
              Historial de Observaciones
            </h4>
            {observations.length > 0 && (
              <button onClick={() => setShowHistoryModal(true)} className="p-1.5 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition" title="Ver historial completo">
                <Maximize2 className="w-4 h-4" />
              </button>
            )}
          </div>

          <div className="mb-3">
            <div className="flex items-center gap-1.5 mb-2">
              <button
                onClick={() => setNewObservationType('note')}
                className={`flex items-center gap-1 px-2.5 py-1 text-xs rounded-lg transition font-medium ${
                  newObservationType === 'note'
                    ? 'bg-yellow-100 text-yellow-700 ring-1 ring-yellow-300'
                    : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                }`}
              >
                <FileText className="w-3 h-3" />
                Nota
              </button>
              <button
                onClick={() => setNewObservationType('call')}
                className={`flex items-center gap-1 px-2.5 py-1 text-xs rounded-lg transition font-medium ${
                  newObservationType === 'call'
                    ? 'bg-blue-100 text-blue-700 ring-1 ring-blue-300'
                    : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                }`}
              >
                <Phone className="w-3 h-3" />
                Llamada
              </button>
            </div>
            <textarea
              value={newObservation}
              onChange={(e) => setNewObservation(e.target.value)}
              placeholder={newObservationType === 'call' ? 'Registrar resultado de llamada...' : 'Escribir una observación...'}
              rows={2}
              className="w-full px-3 py-2 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 text-sm text-slate-900 placeholder:text-slate-400 resize-none"
            />
            <button
              onClick={handleAddObservation}
              disabled={!newObservation.trim() || savingObservation}
              className="mt-1.5 inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white text-xs rounded-xl hover:bg-emerald-700 disabled:opacity-50 transition"
            >
              {savingObservation ? <div className="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-white" /> : <Plus className="w-3.5 h-3.5" />}
              Agregar {newObservationType === 'call' ? 'Llamada' : 'Nota'}
            </button>
          </div>

          {loadingObservations ? (
            <div className="flex justify-center py-4">
              <div className="animate-spin rounded-full h-4 w-4 border-2 border-emerald-200 border-t-emerald-600" />
            </div>
          ) : observations.length === 0 ? (
            <p className="text-xs text-slate-400 text-center py-3">Sin observaciones aún</p>
          ) : (
            <div className="space-y-2">
              {observations.slice(0, obsDisplayCount).map((obs) => (
                <div key={obs.id} className="p-2.5 bg-slate-50 rounded-xl group relative border border-slate-100">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-slate-800 whitespace-pre-wrap break-words">{obs.notes?.startsWith('(sinc) ') ? obs.notes.slice(7) : (obs.notes || '(sin contenido)')}</p>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <Clock className="w-3 h-3 text-slate-300" />
                        <span className="text-[10px] text-slate-400">{formatDistanceToNow(new Date(obs.created_at), { locale: es, addSuffix: true })}</span>
                        {obs.created_by_name && <span className="text-[10px] text-slate-500">&mdash; {obs.created_by_name}</span>}
                        {obs.type === 'call' && <span className="px-1.5 py-0.5 bg-blue-50 text-blue-600 text-[10px] rounded-full font-medium">📞 Llamada</span>}
                        {obs.type !== 'note' && obs.type !== 'call' && <span className="px-1.5 py-0.5 bg-blue-50 text-blue-600 text-[10px] rounded-full">{obs.type}</span>}
                        {obs.notes?.startsWith('(sinc)') && <span className="px-1.5 py-0.5 bg-emerald-50 text-emerald-600 text-[10px] rounded-full font-medium">↕ Kommo</span>}
                      </div>
                    </div>
                    <button onClick={() => handleDeleteObservation(obs.id)} className="p-1 text-gray-300 hover:text-red-500 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity shrink-0" title="Eliminar">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
              {observations.length > obsDisplayCount && (
                <button onClick={() => setObsDisplayCount(prev => prev + 10)} className="w-full py-2 text-xs text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 rounded-xl transition font-medium">
                  Mostrar más ({observations.length - obsDisplayCount} restantes)
                </button>
              )}
            </div>
          )}
        </div>

        <div className="text-[10px] text-slate-400 space-y-0.5">
          <p>Creado: {new Date(lead.created_at).toLocaleDateString('es')}</p>
          <p>Actualizado: {formatDistanceToNow(new Date(lead.updated_at), { locale: es, addSuffix: true })}</p>
        </div>
      </div>

      {/* Full History Modal */}
      {showHistoryModal && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-[60] p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col border border-slate-100">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">Historial Completo</h2>
                <p className="text-xs text-slate-500">{lead.name || 'Sin nombre'} &mdash; {observations.length} registros</p>
              </div>
              <button onClick={() => { setShowHistoryModal(false); setHistoryFilterType(''); setHistoryFilterFrom(''); setHistoryFilterTo('') }} className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="px-6 py-3 border-b border-slate-100 bg-slate-50">
              <div className="flex items-center gap-3 flex-wrap">
                <div>
                  <label className="text-[10px] text-slate-500 uppercase tracking-wider mb-1 block">Tipo</label>
                  <select value={historyFilterType} onChange={(e) => setHistoryFilterType(e.target.value)} className="px-3 py-1.5 border border-slate-200 rounded-xl text-sm text-slate-700 focus:ring-2 focus:ring-emerald-500">
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
                  <input type="date" value={historyFilterFrom} onChange={(e) => setHistoryFilterFrom(e.target.value)} className="px-3 py-1.5 border border-slate-200 rounded-xl text-sm text-slate-700 focus:ring-2 focus:ring-emerald-500" />
                </div>
                <div>
                  <label className="text-[10px] text-slate-500 uppercase tracking-wider mb-1 block">Hasta</label>
                  <input type="date" value={historyFilterTo} onChange={(e) => setHistoryFilterTo(e.target.value)} className="px-3 py-1.5 border border-slate-200 rounded-xl text-sm text-slate-700 focus:ring-2 focus:ring-emerald-500" />
                </div>
                {(historyFilterType || historyFilterFrom || historyFilterTo) && (
                  <button onClick={() => { setHistoryFilterType(''); setHistoryFilterFrom(''); setHistoryFilterTo('') }} className="mt-4 text-xs text-slate-500 hover:text-red-600 flex items-center gap-1">
                    <XCircle className="w-3.5 h-3.5" />Limpiar
                  </button>
                )}
              </div>
            </div>

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
                if (filtered.length === 0) return <p className="text-xs text-slate-400 text-center py-8">No hay registros con los filtros seleccionados</p>
                return (
                  <div className="space-y-2">
                    {filtered.map((obs) => (
                      <div key={obs.id} className="p-3 bg-slate-50 rounded-xl group relative border border-slate-100">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <span className={`px-2 py-0.5 text-xs rounded font-medium ${obs.type === 'note' ? 'bg-yellow-100 text-yellow-700' : obs.type === 'call' ? 'bg-blue-100 text-blue-700' : obs.type === 'whatsapp' ? 'bg-green-100 text-green-700' : obs.type === 'email' ? 'bg-purple-100 text-purple-700' : 'bg-orange-100 text-orange-700'}`}>
                                {obs.type === 'note' ? 'Nota' : obs.type === 'call' ? 'Llamada' : obs.type === 'whatsapp' ? 'WhatsApp' : obs.type === 'email' ? 'Email' : obs.type === 'meeting' ? 'Reunión' : obs.type}
                              </span>
                              <span className="text-xs text-slate-400">{format(new Date(obs.created_at), "d MMM yyyy, HH:mm", { locale: es })}</span>
                            </div>
                            <p className="text-sm text-slate-800 whitespace-pre-wrap break-words">{obs.notes?.startsWith('(sinc) ') ? obs.notes.slice(7) : (obs.notes || '(sin contenido)')}</p>
                            <div className="flex items-center gap-2 mt-1">
                              {obs.created_by_name && <span className="text-xs text-slate-400">por {obs.created_by_name}</span>}
                              {obs.notes?.startsWith('(sinc)') && <span className="px-1.5 py-0.5 bg-emerald-50 text-emerald-600 text-[10px] rounded-full font-medium">↕ Kommo</span>}
                            </div>
                          </div>
                          <button onClick={() => handleDeleteObservation(obs.id)} className="p-1 text-gray-300 hover:text-red-500 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity shrink-0" title="Eliminar">
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
