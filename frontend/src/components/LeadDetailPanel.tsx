'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Phone, Mail, User, Calendar, MessageCircle, Trash2, ChevronDown,
  Clock, FileText, X, Maximize2, Building2, Save, Edit2, Plus, RefreshCw, XCircle, CreditCard, Cake, Archive, ShieldBan, ArchiveRestore, ShieldOff, Smartphone, Cloud, CloudOff
} from 'lucide-react'
import { formatDistanceToNow, format } from 'date-fns'
import { es } from 'date-fns/locale'
import TagInput from '@/components/TagInput'
import ObservationHistoryModal from '@/components/ObservationHistoryModal'
import type { StructuredTag, PipelineStage, Pipeline, Lead, Observation } from '@/types/contact'

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
  /** Event mode: shows event-specific stage selector instead of lead pipelines */
  eventMode?: boolean
  /** Event ID (required when eventMode is true) for API calls */
  eventId?: string
  /** The event's pipeline stages (required when eventMode is true) */
  eventStages?: PipelineStage[]
  /** The participant ID (required when eventMode is true) */
  participantId?: string
  /** Callback when stage changes in event mode */
  onStageChange?: (stageId: string, stageName: string, stageColor: string) => void
  /** Called before assigning a tag in event mode. Return false to cancel. */
  onBeforeTagAssign?: (tagId: string) => Promise<boolean>
  /** Called before removing a tag in event mode. Return false to cancel. */
  onBeforeTagRemove?: (tagId: string) => Promise<boolean>
  /** Called when lead is archived/unarchived */
  onArchive?: (leadId: string, archive: boolean) => void
  /** Called when lead block dialog should open */
  onBlock?: (leadId: string) => void
  /** Called when lead is unblocked */
  onUnblock?: (leadId: string) => void
  /** Contact mode: uses contact APIs, shows device_names, hides pipeline/archive/block */
  contactMode?: boolean
  /** The contact ID for API calls in contact mode */
  contactId?: string
  /** Device names to display in contact mode */
  deviceNames?: { id: string; device_id: string; name: string | null; push_name: string | null; business_name: string | null; device_name: string | null; synced_at: string }[]
  /** Push name from WhatsApp in contact mode */
  pushName?: string | null
  /** Avatar URL in contact mode */
  avatarUrl?: string | null
  /** Called when "Reset from Device" is clicked in contact mode */
  onResetFromDevice?: () => void
  /** Called when "Send Message" is clicked in contact mode */
  onSendMessage?: () => void
  /** Called after any field save in contact mode (to refresh parent's list) */
  onContactUpdate?: (contact: any) => void
  /** Called when an observation is created or deleted (to refresh parent's list view) */
  onObservationChange?: (leadId: string) => void
}

// ─── Component ───────────────────────────────────────────
export default function LeadDetailPanel({
  lead: leadProp,
  onLeadChange,
  onClose,
  onSendWhatsApp,
  onDelete,
  hideHeader = false,
  hideDelete = false,
  hideWhatsApp = false,
  className = '',
  eventMode = false,
  eventId,
  eventStages,
  participantId,
  onStageChange,
  onBeforeTagAssign,
  onBeforeTagRemove,
  onArchive,
  onBlock,
  onUnblock,
  contactMode = false,
  contactId,
  deviceNames,
  pushName,
  avatarUrl,
  onResetFromDevice,
  onSendMessage,
  onContactUpdate,
  onObservationChange,
}: LeadDetailPanelProps) {
  // Internal lead state — updates immediately on save, syncs with prop
  const [lead, setLead] = useState(leadProp)
  useEffect(() => { setLead(leadProp) }, [leadProp])

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
  const [newObservationType, setNewObservationType] = useState<'note' | 'call'>('call')
  const [savingObservation, setSavingObservation] = useState(false)
  const [obsDisplayCount, setObsDisplayCount] = useState(5)

  // History modal
  const [showHistoryModal, setShowHistoryModal] = useState(false)

  // Pipeline dropdown
  const [showPipelineDropdown, setShowPipelineDropdown] = useState(false)
  const [expandedPipelineId, setExpandedPipelineId] = useState<string | null>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Kommo sync
  const [syncingKommo, setSyncingKommo] = useState(false)

  // History sync
  const [syncingHistory, setSyncingHistory] = useState(false)

  // Google sync
  const [googleSynced, setGoogleSynced] = useState(false)
  const [googleSyncing, setGoogleSyncing] = useState(false)
  const [googleConnected, setGoogleConnected] = useState(false)

  // Lead stage dropdown (event mode only)
  const [showLeadStageDropdown, setShowLeadStageDropdown] = useState(false)
  const [expandedLeadPipelineId, setExpandedLeadPipelineId] = useState<string | null>(null)
  const leadStageDropdownRef = useRef<HTMLDivElement>(null)

  // ─── Check Google Contacts connection + sync status ───────────────
  useEffect(() => {
    const cid = contactMode ? contactId : lead.contact_id
    if (!cid) return
    const token = localStorage.getItem('token')
    fetch('/api/google/status', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => { if (d.success && d.connected) setGoogleConnected(true) })
      .catch(() => {})
    // Check contact's google_sync flag via contacts API
    fetch(`/api/contacts/${cid}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => { if (d.success && d.contact?.google_sync) setGoogleSynced(true); else setGoogleSynced(false) })
      .catch(() => {})
  }, [contactMode, contactId, lead.contact_id])

  const handleGoogleSync = async () => {
    const cid = contactMode ? contactId : lead.contact_id
    if (!cid) return
    setGoogleSyncing(true)
    try {
      const token = localStorage.getItem('token')
      const res = await fetch(`/api/google/contacts/${cid}/sync`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        setGoogleSynced(true)
      } else {
        alert(data.error || 'Error al sincronizar con Google')
      }
    } catch {
      alert('Error de conexión')
    } finally {
      setGoogleSyncing(false)
    }
  }

  const handleGoogleDesync = async () => {
    const cid = contactMode ? contactId : lead.contact_id
    if (!cid) return
    setGoogleSyncing(true)
    try {
      const token = localStorage.getItem('token')
      const res = await fetch(`/api/google/contacts/${cid}/sync`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        setGoogleSynced(false)
      } else {
        alert(data.error || 'Error al desincronizar de Google')
      }
    } catch {
      alert('Error de conexión')
    } finally {
      setGoogleSyncing(false)
    }
  }

  // ─── Fetch pipelines (skip in contact mode) ───────────────
  useEffect(() => {
    if (contactMode) return
    const token = localStorage.getItem('token')
    fetch('/api/pipelines', { headers: { Authorization: `Bearer ${token}` } })
      .then(res => res.json())
      .then(data => {
        if (data.success) setPipelines(data.pipelines || [])
      })
      .catch(console.error)
  }, [eventMode, contactMode])

  // ─── Fetch observations when lead changes ──────────────
  useEffect(() => {
    setNotesValue(lead.notes || '')
    setEditingField(null)
    setEditingNotes(false)
    setObsDisplayCount(5)
    fetchObservations(lead.id)
  }, [leadProp.id])

  // ─── Close on Escape ───────────────────────────────────
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (showLeadStageDropdown) { e.stopPropagation(); setShowLeadStageDropdown(false); return }
      if (showPipelineDropdown) { e.stopPropagation(); setShowPipelineDropdown(false); return }
      // No internal state to close → let event propagate to parent page handler
    }
    document.addEventListener('keydown', h, true)
    return () => document.removeEventListener('keydown', h, true)
  }, [showPipelineDropdown, showLeadStageDropdown])

  // ─── Click outside to close dropdown ───────────────────
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowPipelineDropdown(false)
      }
      if (leadStageDropdownRef.current && !leadStageDropdownRef.current.contains(event.target as Node)) {
        setShowLeadStageDropdown(false)
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
      const url = contactMode && contactId
        ? `/api/contacts/${contactId}/interactions?limit=100`
        : `/api/leads/${leadId}/interactions?limit=100`
      const res = await fetch(url, {
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
        payload[field] = val ? parseInt(val, 10) : 0
      } else {
        payload[field] = val
      }
      const endpoint = contactMode && contactId
        ? `/api/contacts/${contactId}`
        : eventMode && eventId && participantId
        ? `/api/events/${eventId}/participants/${participantId}`
        : `/api/leads/${lead.id}`
      const apiPayload = contactMode && contactId
        ? Object.fromEntries(Object.entries(payload).map(([k, v]) => [k === 'name' ? 'custom_name' : k, v]))
        : payload
      const res = await fetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(apiPayload),
      })
      const data = await res.json()
      if (contactMode) {
        if (data.success && data.contact) {
          const updated = { ...lead, ...payload } as Lead
          setLead(updated)
          onLeadChange(updated)
          onContactUpdate?.(data.contact)
        }
      } else if (eventMode) {
        const updated = { ...lead, ...payload } as Lead
        setLead(updated)
        onLeadChange(updated)
      } else {
        if (data.success && data.lead) {
          const merged = { ...data.lead, structured_tags: data.lead.structured_tags || lead.structured_tags }
          setLead(merged)
          onLeadChange(merged)
        }
      }
    } catch (err) {
      console.error('Failed to save field:', err)
    } finally {
      setSavingField(false)
      setEditingField(null)
    }
  }

  const saveNotes = async () => {
    setSavingNotes(true)
    const token = localStorage.getItem('token')
    try {
      const endpoint = contactMode && contactId
        ? `/api/contacts/${contactId}`
        : eventMode && eventId && participantId
        ? `/api/events/${eventId}/participants/${participantId}`
        : `/api/leads/${lead.id}`
      const res = await fetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ notes: notesValue }),
      })
      const data = await res.json()
      if (contactMode) {
        const updated = { ...lead, notes: notesValue }
        setLead(updated)
        onLeadChange(updated)
        if (data.success && data.contact) onContactUpdate?.(data.contact)
      } else if (eventMode) {
        const updated = { ...lead, notes: notesValue }
        setLead(updated)
        onLeadChange(updated)
      } else if (data.success && data.lead) {
        const merged = { ...data.lead, structured_tags: data.lead.structured_tags || lead.structured_tags }
        setLead(merged)
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
      if (eventMode && eventId && participantId) {
        const res = await fetch(`/api/events/${eventId}/participants/${participantId}/stage`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ stage_id: stageId }),
        })
        const data = await res.json()
        if (data.success) {
          const stage = eventStages?.find(s => s.id === stageId)
          const updated = {
            ...lead,
            stage_id: stageId,
            stage_name: stage?.name || null,
            stage_color: stage?.color || null,
            stage_position: stage?.position ?? null,
          }
          setLead(updated)
          onLeadChange(updated)
          onStageChange?.(stageId, stage?.name || '', stage?.color || '')
        }
      } else {
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
          const updated = {
            ...lead,
            stage_id: stageId,
            stage_name: stage?.name || null,
            stage_color: stage?.color || null,
            stage_position: stage?.position ?? null,
          }
          setLead(updated)
          onLeadChange(updated)
        }
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
        setLead(merged)
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
        body: JSON.stringify(contactMode && contactId
          ? { contact_id: contactId, type: newObservationType, notes: newObservation.trim() }
          : { lead_id: lead.id, type: newObservationType, notes: newObservation.trim() }
        ),
      })
      const data = await res.json()
      if (data.success) {
        setNewObservation('')
        fetchObservations(lead.id)
        onObservationChange?.(lead.id)
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
      if (data.success) onObservationChange?.(lead.id)
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
        setLead(data.lead)
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

  const handleRequestHistorySync = async () => {
    if (syncingHistory || !lead.jid) return
    setSyncingHistory(true)
    try {
      const token = localStorage.getItem('token')
      // First, find or create the chat for this lead's JID
      const findRes = await fetch(`/api/chats/find-by-phone/${encodeURIComponent(lead.phone)}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      const findData = await findRes.json()
      const chatId = findData?.chat?.id
      if (!chatId) {
        console.error('[HistorySync] No chat found for lead')
        return
      }
      const res = await fetch(`/api/chats/${chatId}/sync-history`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Error solicitando historial')
      }
    } catch (err: any) {
      console.error('[HistorySync]', err)
    } finally {
      setTimeout(() => setSyncingHistory(false), 15000)
    }
  }

  const handleDeleteLead = async () => {
    const confirmMsg = contactMode ? '¿Estás seguro de eliminar este contacto?' : eventMode ? '¿Estás seguro de eliminar este participante?' : '¿Estás seguro de eliminar este lead?'
    if (!confirm(confirmMsg)) return
    const token = localStorage.getItem('token')
    try {
      const url = contactMode && contactId
        ? `/api/contacts/${contactId}`
        : eventMode && eventId && participantId
        ? `/api/events/${eventId}/participants/${participantId}`
        : `/api/leads/${lead.id}`
      const res = await fetch(url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        onDelete?.(eventMode ? (participantId || lead.id) : lead.id)
        onClose()
      }
    } catch (err) {
      console.error('Failed to delete:', err)
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
          <h2 className="text-sm font-semibold text-slate-900">{contactMode ? 'Detalle del Contacto' : eventMode ? 'Detalle del Participante' : 'Detalle del Lead'}</h2>
          <div className="flex items-center gap-1">
            <button onClick={onClose} className="p-1.5 hover:bg-slate-100 rounded-lg">
              <X className="w-4 h-4 text-slate-400" />
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* Lead Avatar & Name */}
        <div className="text-center">
          {contactMode && avatarUrl ? (
            <img src={avatarUrl} alt="" className="w-14 h-14 rounded-full object-cover mx-auto mb-2" />
          ) : (
          <div className="w-12 h-12 bg-emerald-50 rounded-full flex items-center justify-center mx-auto mb-2">
            <span className="text-emerald-700 font-bold text-base">
              {(lead.name || '?').charAt(0).toUpperCase()}
            </span>
          </div>
          )}
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
          {contactMode && pushName && pushName !== lead.name && (
            <p className="text-xs text-slate-400 mt-0.5">Push: {pushName}</p>
          )}
          {contactMode && lead.jid && (
            <p className="text-xs text-slate-400">{lead.jid}</p>
          )}

          {/* Archive/Block status badges */}
          {!contactMode && (lead.is_archived || lead.is_blocked) && (
            <div className="flex items-center justify-center gap-2 mt-2">
              {lead.is_archived && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-50 border border-amber-200 rounded-full text-xs font-medium text-amber-700">
                  <Archive className="w-3 h-3" />
                  Archivado
                </span>
              )}
              {lead.is_blocked && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-red-50 border border-red-200 rounded-full text-xs font-medium text-red-700" title={lead.block_reason || ''}>
                  <ShieldBan className="w-3 h-3" />
                  Bloqueado{lead.block_reason ? `: ${lead.block_reason}` : ''}
                </span>
              )}
            </div>
          )}

          {/* Archive/Block action buttons */}
          {!contactMode && (
            <div className="flex items-center justify-center gap-2 mt-2">
              {lead.is_blocked ? (
                onUnblock && (
                  <button
                    onClick={() => onUnblock(lead.id)}
                    className="inline-flex items-center gap-1 px-2.5 py-1 bg-white border border-slate-200 hover:border-emerald-300 hover:bg-emerald-50 rounded-full text-xs font-medium text-slate-500 hover:text-emerald-700 transition-colors"
                  >
                    <ShieldOff className="w-3 h-3" />
                    Desbloquear
                  </button>
                )
              ) : (
                <>
                  {lead.is_archived ? (
                    onArchive && (
                      <button
                        onClick={() => onArchive(lead.id, false)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 bg-white border border-slate-200 hover:border-emerald-300 hover:bg-emerald-50 rounded-full text-xs font-medium text-slate-500 hover:text-emerald-700 transition-colors"
                      >
                        <ArchiveRestore className="w-3 h-3" />
                        Restaurar
                      </button>
                    )
                  ) : (
                    onArchive && (
                      <button
                        onClick={() => onArchive(lead.id, true)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 bg-white border border-slate-200 hover:border-amber-300 hover:bg-amber-50 rounded-full text-xs font-medium text-slate-500 hover:text-amber-700 transition-colors"
                      >
                        <Archive className="w-3 h-3" />
                        Archivar
                      </button>
                    )
                  )}
                  {onBlock && (
                    <button
                      onClick={() => onBlock(lead.id)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 bg-white border border-red-200 hover:bg-red-50 rounded-full text-xs font-medium text-slate-500 hover:text-red-700 transition-colors"
                    >
                      <ShieldBan className="w-3 h-3" />
                      Bloquear
                    </button>
                  )}
                </>
              )}
            </div>
          )}

          {/* Kommo & Google sync status */}
          <div className="flex items-center justify-center gap-2 mt-3 flex-wrap">
            {!eventMode && !contactMode && (
              lead.kommo_id ? (
              <>
                <span className="flex items-center gap-1.5 px-2.5 py-1 bg-emerald-50 border border-emerald-200 rounded-full text-xs font-medium text-emerald-700">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0" />
                  Kommo #{lead.kommo_id}
                </span>
                <button
                  onClick={handleSyncKommo}
                  disabled={syncingKommo}
                  title="Sincronizar desde Kommo ahora"
                  className="flex items-center gap-1 px-2.5 py-1 bg-white border border-slate-200 hover:border-emerald-300 hover:bg-emerald-50 rounded-full text-xs font-medium text-slate-500 hover:text-emerald-700 transition-colors disabled:opacity-50"
                >
                  <RefreshCw className={`w-3 h-3 ${syncingKommo ? 'animate-spin text-emerald-600' : ''}`} />
                  {syncingKommo ? 'Sincronizando…' : 'Sincronizar'}
                </button>
              </>
            ) : (
              <span className="flex items-center gap-1.5 px-2.5 py-1 bg-slate-50 border border-slate-200 rounded-full text-xs text-slate-400">
                <span className="w-1.5 h-1.5 rounded-full bg-slate-300 flex-shrink-0" />
                Sin vínculo Kommo
              </span>
            ))}
            {googleConnected && (contactMode ? contactId : lead.contact_id) && (
              <button
                onClick={googleSynced ? handleGoogleDesync : handleGoogleSync}
                disabled={googleSyncing}
                title={googleSynced ? 'Google Sync activo — click para desincronizar' : 'Sincronizar a Google Contacts'}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors disabled:opacity-50 ${
                  googleSynced
                    ? 'bg-sky-50 border border-sky-200 text-sky-700 hover:bg-sky-100'
                    : 'bg-white border border-slate-200 text-slate-500 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-700'
                }`}
              >
                {googleSyncing ? (
                  <RefreshCw className="w-3 h-3 animate-spin" />
                ) : googleSynced ? (
                  <Cloud className="w-3 h-3" />
                ) : (
                  <CloudOff className="w-3 h-3" />
                )}
                {googleSyncing ? 'Sincronizando…' : googleSynced ? 'Google Sync' : 'Google Sync'}
              </button>
            )}
          </div>
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

          {/* DNI */}
          <div className="flex items-center gap-3 group">
            <CreditCard className="w-4 h-4 text-emerald-600 shrink-0" />
            {editingField === 'dni' ? (
              <input autoFocus value={editValues.dni ?? ''} onChange={(e) => setEditValues({ ...editValues, dni: e.target.value })} onKeyDown={(e) => handleFieldKeyDown(e, 'dni')} onBlur={() => saveLeadField('dni')} className="flex-1 text-sm text-slate-800 bg-transparent border-b-2 border-emerald-500 outline-none" placeholder="DNI" />
            ) : (
              <span className={`text-sm flex-1 cursor-pointer hover:text-emerald-700 ${lead.dni ? 'text-slate-800' : 'text-slate-400 italic'}`} onClick={() => startEditing('dni', lead.dni || '')} title="Clic para editar">
                {lead.dni || 'Agregar DNI'}
              </span>
            )}
          </div>

          {/* Birth Date */}
          <div className="flex items-center gap-3 group">
            <Cake className="w-4 h-4 text-emerald-600 shrink-0" />
            {editingField === 'birth_date' ? (
              <input autoFocus type="date" value={editValues.birth_date ?? ''} onChange={(e) => setEditValues({ ...editValues, birth_date: e.target.value })} onKeyDown={(e) => handleFieldKeyDown(e, 'birth_date')} onBlur={() => saveLeadField('birth_date')} className="flex-1 text-sm text-slate-800 bg-transparent border-b-2 border-emerald-500 outline-none" />
            ) : (
              <span className={`text-sm flex-1 cursor-pointer hover:text-emerald-700 ${lead.birth_date ? 'text-slate-800' : 'text-slate-400 italic'}`} onClick={() => startEditing('birth_date', lead.birth_date ? lead.birth_date.split('T')[0] : '')} title="Clic para editar">
                {lead.birth_date ? format(new Date(lead.birth_date), 'dd/MM/yyyy') : 'Agregar fecha de nacimiento'}
              </span>
            )}
          </div>
        </div>

        {/* Tags */}
        <div className="space-y-2">
          <h5 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Etiquetas</h5>
          <TagInput
            entityType={contactMode ? "contact" : "lead"}
            entityId={contactMode && contactId ? contactId : lead.id}
            assignedTags={lead.structured_tags || []}
            onTagsChange={(newTags) => {
              const updated = { ...lead, structured_tags: newTags }
              setLead(updated)
              onLeadChange(updated)
            }}
            onBeforeAssign={eventMode ? onBeforeTagAssign : undefined}
            onBeforeRemove={eventMode ? onBeforeTagRemove : undefined}
          />
        </div>

        {/* Pipeline & Stage Selector (hidden in contact mode) */}
        {!contactMode && (
        <div className="border-t border-slate-100 pt-4" ref={dropdownRef}>
          <h5 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
            {eventMode ? 'Etapa del Evento' : 'Etapa del Pipeline'}
          </h5>

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
                  {eventMode ? (
                    lead.stage_name || 'Sin etapa asignada'
                  ) : (
                    lead.stage_name || lead.pipeline_id ? (
                      <>
                        <span className="opacity-50 font-normal">{pipelines.find(p => p.id === lead.pipeline_id)?.name || 'Sin Pipeline'}</span>
                        <span className="mx-1.5 opacity-30">/</span>
                        {lead.stage_name || 'Sin etapa'}
                      </>
                    ) : 'Leads Entrantes (Sin asignar)'
                  )}
                </span>
              </div>
              <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${showPipelineDropdown ? 'rotate-180' : ''}`} />
            </button>

            {/* Dropdown */}
            {showPipelineDropdown && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-white rounded-xl shadow-xl border border-slate-100 overflow-hidden z-20 max-h-[400px] overflow-y-auto">
                {eventMode ? (
                  /* Event mode: flat list of event stages */
                  <>
                    {eventStages?.map(stage => (
                      <button
                        key={stage.id}
                        className={`w-full flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors text-left ${
                          lead.stage_id === stage.id ? 'bg-emerald-50 text-emerald-700' : 'hover:bg-slate-50 text-slate-700'
                        }`}
                        onClick={() => {
                          handleUpdateLeadStage(lead.id, stage.id)
                          setShowPipelineDropdown(false)
                        }}
                        type="button"
                      >
                        <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: stage.color }} />
                        <span className="text-sm truncate">{stage.name}</span>
                        {lead.stage_id === stage.id && <div className="ml-auto w-1.5 h-1.5 rounded-full bg-emerald-500" />}
                      </button>
                    ))}
                  </>
                ) : (
                  /* Lead mode: pipelines with accordion stages */
                  <>
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
                                      const token = localStorage.getItem('token')
                                      fetch(`/api/leads/${lead.id}`, {
                                        method: 'PUT',
                                        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                                        body: JSON.stringify({ pipeline_id: pipeline.id, stage_id: stage.id })
                                      }).then(res => res.json()).then(data => {
                                        if (data.success && data.lead) {
                                          const merged = { ...data.lead, structured_tags: data.lead.structured_tags || lead.structured_tags }
                                          setLead(merged)
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
                  </>
                )}
              </div>
            )}
          </div>
        </div>
        )}

        {/* Lead Stage (event mode only — independent of event stage) */}
        {eventMode && pipelines.length > 0 && (
        <div className="border-t border-slate-100 pt-3 mt-1">
          <h5 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            Etapa del Lead
          </h5>

          <div className="relative" ref={leadStageDropdownRef}>
            <button
              onClick={() => setShowLeadStageDropdown(!showLeadStageDropdown)}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-xl border transition-all text-sm ${
                lead.lead_stage_id
                  ? 'bg-white border-slate-200 text-slate-600 hover:border-slate-300'
                  : 'bg-slate-50 border-slate-200 text-slate-400'
              }`}
            >
              <div className="flex items-center gap-2 overflow-hidden">
                {lead.lead_stage_color && (
                  <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: lead.lead_stage_color }} />
                )}
                <span className="truncate">
                  {lead.lead_stage_name ? (
                    <>
                      <span className="opacity-50 font-normal">{pipelines.find(p => p.id === lead.lead_pipeline_id)?.name || ''}</span>
                      {lead.lead_pipeline_id && <span className="mx-1 opacity-30">/</span>}
                      {lead.lead_stage_name}
                    </>
                  ) : 'Sin etapa de lead'}
                </span>
              </div>
              <ChevronDown className={`w-3.5 h-3.5 text-slate-400 transition-transform ${showLeadStageDropdown ? 'rotate-180' : ''}`} />
            </button>

            {showLeadStageDropdown && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-white rounded-xl shadow-xl border border-slate-100 overflow-hidden z-20 max-h-[350px] overflow-y-auto">
                {pipelines.map(pipeline => {
                  const isExpanded = expandedLeadPipelineId === pipeline.id
                  return (
                    <div key={pipeline.id} className="border-b border-slate-50 last:border-0">
                      <button
                        className={`w-full flex items-center justify-between px-3 py-2 text-left transition-colors ${
                          lead.lead_pipeline_id === pipeline.id ? 'bg-emerald-50/50' : 'hover:bg-slate-50'
                        }`}
                        onClick={() => setExpandedLeadPipelineId(isExpanded ? null : pipeline.id)}
                        type="button"
                      >
                        <span className="text-sm font-medium text-slate-700 truncate">{pipeline.name}</span>
                        <ChevronDown className={`w-3.5 h-3.5 text-slate-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                      </button>

                      <div className={`transition-all duration-300 ease-in-out overflow-hidden ${isExpanded ? 'max-h-[500px] opacity-100' : 'max-h-0 opacity-0'}`}>
                        <div className="p-1 bg-slate-50/30 border-t border-slate-100">
                          {pipeline.stages?.map(stage => (
                            <button
                              key={stage.id}
                              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors text-left ${
                                lead.lead_stage_id === stage.id ? 'bg-emerald-50 text-emerald-700' : 'hover:bg-slate-100 text-slate-600'
                              }`}
                              onClick={() => {
                                const token = localStorage.getItem('token')
                                const leadId = lead.id
                                fetch(`/api/leads/${leadId}`, {
                                  method: 'PUT',
                                  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                                  body: JSON.stringify({ pipeline_id: pipeline.id, stage_id: stage.id })
                                }).then(res => res.json()).then(data => {
                                  if (data.success) {
                                    const updated = {
                                      ...lead,
                                      lead_pipeline_id: pipeline.id,
                                      lead_stage_id: stage.id,
                                      lead_stage_name: stage.name,
                                      lead_stage_color: stage.color,
                                    }
                                    setLead(updated)
                                    onLeadChange(updated)
                                  }
                                }).catch(console.error)
                                setShowLeadStageDropdown(false)
                              }}
                              type="button"
                            >
                              <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: stage.color }} />
                              <span className="text-sm truncate">{stage.name}</span>
                              {lead.lead_stage_id === stage.id && <div className="ml-auto w-1.5 h-1.5 rounded-full bg-emerald-500" />}
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
        )}

        {/* Device Names (contact mode only) */}
        {contactMode && deviceNames && deviceNames.length > 0 && (
          <div className="border-t border-slate-100 pt-4">
            <h5 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 flex items-center gap-2">
              <Smartphone className="w-3.5 h-3.5" />
              Nombres por Dispositivo
            </h5>
            <div className="space-y-2">
              {deviceNames.map((dn) => (
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
          {contactMode ? (
            <>
              {onSendMessage && (
                <button
                  onClick={onSendMessage}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 transition text-sm font-medium shadow-sm"
                >
                  <MessageCircle className="w-4 h-4" />
                  Enviar Mensaje
                </button>
              )}
              {onResetFromDevice && (
                <button
                  onClick={onResetFromDevice}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2 border border-slate-200 text-slate-600 rounded-xl hover:bg-slate-50 text-sm"
                >
                  <RefreshCw className="w-4 h-4" />
                  Restaurar del Dispositivo
                </button>
              )}
            </>
          ) : (
            <>
          {!hideWhatsApp && lead.phone && (
            <button
              onClick={() => onSendWhatsApp?.(lead.phone)}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 transition text-sm font-medium shadow-sm"
            >
              <MessageCircle className="w-4 h-4" />
              Enviar WhatsApp
            </button>
          )}
          {lead.phone && (
            <button
              onClick={handleRequestHistorySync}
              disabled={syncingHistory}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 border border-slate-200 text-slate-600 rounded-xl hover:bg-slate-50 transition text-sm disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${syncingHistory ? 'animate-spin' : ''}`} />
              {syncingHistory ? 'Sincronizando...' : 'Sincronizar Historial'}
            </button>
          )}
            </>
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
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && newObservation.trim() && !savingObservation) {
                  e.preventDefault()
                  handleAddObservation()
                }
              }}
              placeholder={newObservationType === 'call' ? 'Registrar resultado de llamada... (Ctrl+Enter para guardar)' : 'Escribir una observación... (Ctrl+Enter para guardar)'}
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

        {!eventMode && lead.created_at && lead.updated_at && (
          <div className="text-[10px] text-slate-400 space-y-0.5">
            <p>Creado: {new Date(lead.created_at).toLocaleDateString('es')}</p>
            <p>Actualizado: {formatDistanceToNow(new Date(lead.updated_at), { locale: es, addSuffix: true })}</p>
          </div>
        )}
      </div>

      {/* Full History Modal */}
      <ObservationHistoryModal
        isOpen={showHistoryModal}
        onClose={() => setShowHistoryModal(false)}
        leadId={lead.id}
        contactId={contactMode ? contactId : undefined}
        name={lead.name || 'Sin nombre'}
        observations={observations}
        onObservationChange={() => { fetchObservations(lead.id); onObservationChange?.(lead.id) }}
      />
    </div>
  )
}
