'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Phone, Mail, User, Calendar, MessageCircle, Trash2, ChevronDown,
  Clock, FileText, X, Maximize2, Building2, Save, Edit2, Plus, RefreshCw, XCircle, CheckCircle2, CreditCard, Cake, Archive, ShieldBan, ArchiveRestore, ShieldOff, Smartphone, Cloud, CloudOff, MapPin, Briefcase, Map, SlidersHorizontal, LayoutList, ExternalLink, Loader2
} from 'lucide-react'
import { formatDistanceToNow, format, parseISO } from 'date-fns'
import { es } from 'date-fns/locale'
import TagInput from '@/components/TagInput'
import ObservationHistoryModal from '@/components/ObservationHistoryModal'
import TaskList from '@/components/TaskList'
import TaskFormModal from '@/components/TaskFormModal'
import GenerateDocumentModal from '@/components/GenerateDocumentModal'
import CustomFieldInput from '@/components/CustomFieldInput'
import ContactAvatarControl, { type ContactAvatarContextType, type ContactAvatarInfo } from '@/components/ContactAvatarControl'
import type { CustomFieldDefinition, CustomFieldValue } from '@/types/custom-field'
import type { Task, TaskList as TaskListType } from '@/types/task'
import { TASK_TYPE_CONFIG } from '@/types/task'
import type { StructuredTag, PipelineStage, Pipeline, Lead, Observation } from '@/types/contact'

export interface EventRelatedLeadSummary {
  id: string
  title: string
  status: string
  pipeline_id?: string
  pipeline_name?: string
  stage_id?: string
  stage_name?: string
  stage_color?: string
  is_archived: boolean
  updated_at: string
}

export interface EventMembershipSummary {
  state?: string
  source?: string
  reason?: string
  autoTagSync?: boolean
  changedAt?: string
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
  /** Optional: hide the duplicated person identity when a parent already renders it. */
  hideIdentity?: boolean
  /** Embedded CRM view: keep opportunity fields/actions and hide Contact-owned personal data. */
  commercialOnly?: boolean
  /** Let an embedding panel own the vertical scroll instead of creating a nested viewport. */
  parentOwnsScroll?: boolean
  /** Optional: hide delete button */
  hideDelete?: boolean
  /** Optional: hide WhatsApp button */
  hideWhatsApp?: boolean
  /** Render entity fields and event membership controls without mutation actions. */
  readOnly?: boolean
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
  /** Read-only opportunities derived from the participant Contact. */
  relatedLeads?: EventRelatedLeadSummary[]
  relatedLeadsLoading?: boolean
  relatedLeadsError?: string
  onRetryRelatedLeads?: () => void
  eventMembership?: EventMembershipSummary
  /** Callback when stage changes in event mode */
  onStageChange?: (stageId: string, stageName: string, stageColor: string) => void
  /** Lets the parent coordinate close/reopen semantics before moving an opportunity. */
  onStageChangeRequest?: (lead: Lead, stage: PipelineStage) => void
  /** Explicit close/reopen actions for the lead lifecycle. */
  onLifecycleAction?: (lead: Lead, mode: 'won' | 'lost' | 'reopen') => void
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
  /** Explicit authorization context when contactMode is embedded outside Contacts. */
  avatarContextType?: ContactAvatarContextType
  avatarContextId?: string
  detailTitle?: string
  programContext?: { programId: string; participantId: string }
  defaultObservationType?: 'note' | 'call'
  onAvatarChange?: (avatar: ContactAvatarInfo) => void

  /** Called when "Send Message" is clicked in contact mode */
  onSendMessage?: () => void
  /** Called after any field save in contact mode (to refresh parent's list) */
  onContactUpdate?: (contact: any) => void
  /** Called when an observation is created or deleted (to refresh parent's list view) */
  onObservationChange?: (leadId: string) => void
  /** Auto-scroll to tasks section after panel opens */
  scrollToTasks?: boolean
}

// ─── Component ───────────────────────────────────────────
export default function LeadDetailPanel({
  lead: leadProp,
  onLeadChange,
  onClose,
  onSendWhatsApp,
  onDelete,
  hideHeader = false,
  hideIdentity = false,
  commercialOnly = false,
  parentOwnsScroll = false,
  hideDelete = false,
  hideWhatsApp = false,
  readOnly = false,
  className = '',
  eventMode = false,
  eventId,
  eventStages,
  participantId,
  relatedLeads = [],
  relatedLeadsLoading = false,
  relatedLeadsError = '',
  onRetryRelatedLeads,
  eventMembership,
  onStageChange,
  onStageChangeRequest,
  onLifecycleAction,
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
  avatarContextType,
  avatarContextId,
  detailTitle,
  programContext,
  defaultObservationType = 'call',
  onAvatarChange,
  onSendMessage,
  onContactUpdate,
  onObservationChange,
  scrollToTasks = false,
}: LeadDetailPanelProps) {
  // Internal lead state — updates immediately on save, syncs with prop
  const [lead, setLead] = useState(leadProp)

  const avatarContactId = contactMode ? contactId : leadProp.contact_id || undefined
  const resolvedAvatarContextType: ContactAvatarContextType = avatarContextType
    || (eventMode ? 'event_participant' : contactMode ? 'contact' : 'lead')
  const resolvedAvatarContextId = avatarContextId
    || (eventMode ? participantId : contactMode ? contactId : leadProp.id)
  useEffect(() => {
    // Preserve relations that the parent may not refresh in-place (avoids visual wipe
    // of tags / custom fields while the local state is still authoritative).
    setLead(prev => ({
      ...leadProp,
      structured_tags: leadProp.structured_tags ?? prev.structured_tags,
      custom_field_values: (leadProp as any).custom_field_values ?? (prev as any).custom_field_values,
    }))

  }, [leadProp])

  // Pipelines
  const [pipelines, setPipelines] = useState<Pipeline[]>([])

  // Inline editing
  const [editingField, setEditingField] = useState<string | null>(null)
  const [editValues, setEditValues] = useState<Record<string, string>>({})
  const [savingField, setSavingField] = useState(false)
  const savingFieldRef = useRef<string | null>(null)

  // Notes
  const [editingNotes, setEditingNotes] = useState(false)
  const [notesValue, setNotesValue] = useState(lead.notes || '')
  const [savingNotes, setSavingNotes] = useState(false)

  // Observations
  const [observations, setObservations] = useState<Observation[]>([])
  const [loadingObservations, setLoadingObservations] = useState(false)
  const [newObservation, setNewObservation] = useState('')
  const [newObservationType, setNewObservationType] = useState<'note' | 'call'>(defaultObservationType)
  const [savingObservation, setSavingObservation] = useState(false)
  const [observationError, setObservationError] = useState('')
  const [obsDisplayCount, setObsDisplayCount] = useState(5)

  // History modal
  const [showHistoryModal, setShowHistoryModal] = useState(false)

  // Tasks
  const [leadTasks, setLeadTasks] = useState<Task[]>([])
  const [showTaskModal, setShowTaskModal] = useState(false)
  const [editingTask, setEditingTask] = useState<Task | null>(null)
  const [taskLists, setTaskLists] = useState<TaskListType[]>([])
  const panelEntityRequestRef = useRef(0)

  // Pipeline dropdown
  const [showPipelineDropdown, setShowPipelineDropdown] = useState(false)
  const [expandedPipelineId, setExpandedPipelineId] = useState<string | null>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // History sync
  const [syncingHistory, setSyncingHistory] = useState(false)

  // Document generation
  const [showDocumentModal, setShowDocumentModal] = useState(false)

  // Google sync
  const [googleSynced, setGoogleSynced] = useState(false)
  const [googleSyncing, setGoogleSyncing] = useState(false)
  const [googleConnected, setGoogleConnected] = useState(false)

  // Custom fields
  const [cfDefs, setCfDefs] = useState<CustomFieldDefinition[]>([])
  const [cfValues, setCfValues] = useState<CustomFieldValue[]>([])
  const [cfLoading, setCfLoading] = useState(false)

  // Tabs
  const [activeTab, setActiveTab] = useState<'general' | 'campos'>('general')

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

  // ─── Fetch commercial pipelines only for opportunity mode ───────────────
  useEffect(() => {
    if (contactMode || eventMode) return
    const token = localStorage.getItem('token')
    fetch('/api/pipelines', { headers: { Authorization: `Bearer ${token}` } })
      .then(res => res.json())
      .then(data => {
        if (data.success) setPipelines(data.pipelines || [])
      })
      .catch(console.error)
  }, [eventMode, contactMode])

  // ─── Fetch custom field definitions + values ───────────────
  useEffect(() => {
    const cid = contactMode ? contactId : lead.contact_id
    if (!cid) { setCfDefs([]); setCfValues([]); setCfLoading(false); return }
    let active = true
    setCfLoading(true)
    const token = localStorage.getItem('token')
    const headers = { Authorization: `Bearer ${token}` }
    Promise.all([
      fetch('/api/custom-fields', { headers }).then(r => r.json()),
      fetch(`/api/contacts/${cid}/custom-fields`, { headers }).then(r => r.json()),
    ]).then(([defsData, valsData]) => {
      if (!active) return
      if (defsData.success) setCfDefs(defsData.fields || [])
      if (valsData.success) setCfValues(valsData.values || [])
    }).catch(() => {}).finally(() => { if (active) setCfLoading(false) })
    return () => { active = false }
  }, [leadProp.id, contactMode, contactId, lead.contact_id])

  const handleSaveCustomField = useCallback(async (fieldId: string, payload: any) => {
    const cid = contactMode ? contactId : lead.contact_id
    if (!cid) return
    const token = localStorage.getItem('token')
    const res = await fetch(`/api/contacts/${cid}/custom-fields/${fieldId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    })
    const data = await res.json()
    if (data.success && data.value) {
      setCfValues(prev => {
        const idx = prev.findIndex(v => v.field_id === fieldId)
        if (idx >= 0) { const n = [...prev]; n[idx] = data.value; return n }
        return [...prev, data.value]
      })
    }
  }, [contactMode, contactId, lead.contact_id])

  // ─── Fetch observations when lead changes ──────────────
  useEffect(() => {
    const requestId = ++panelEntityRequestRef.current
    setNotesValue(lead.notes || '')
    setEditingField(null)
    setEditingNotes(false)
    setObsDisplayCount(5)
    setActiveTab('general')
    setObservations([])
    setNewObservation('')
    setObservationError('')
    setSavingObservation(false)
    setLeadTasks([])
    fetchObservations(lead.id, requestId)
    fetchTaskLists()
    if (eventMode && eventId && lead.contact_id) {
      fetchContactTasks(lead.contact_id, eventId, requestId)
    } else if (!contactMode) {
      fetchLeadTasks(lead.id, requestId)
    } else if (contactId) {
      fetchContactTasks(contactId, undefined, requestId)
    }
  }, [leadProp.id, participantId, contactId])

  // Auto-scroll to tasks section when scrollToTasks prop is set
  useEffect(() => {
    if (!scrollToTasks) return
    // Wait for tasks to load and DOM to render
    const timer = setTimeout(() => {
      const el = document.getElementById('tasks-section')
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 400)
    return () => clearTimeout(timer)
  }, [scrollToTasks, leadProp.id])

  // ─── Close on Escape ───────────────────────────────────
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (showPipelineDropdown) { e.stopPropagation(); setShowPipelineDropdown(false); return }
      // No internal state to close → let event propagate to parent page handler
    }
    document.addEventListener('keydown', h, true)
    return () => document.removeEventListener('keydown', h, true)
  }, [showPipelineDropdown])

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
  const fetchObservations = async (leadId: string, requestId = panelEntityRequestRef.current) => {
    setLoadingObservations(true)
    const token = localStorage.getItem('token')
    try {
      const url = eventMode && participantId
        ? `/api/interactions?participant_id=${participantId}&limit=100`
        : contactMode && contactId
        ? `/api/contacts/${contactId}/interactions?limit=100`
        : `/api/leads/${leadId}/interactions?limit=100`
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (requestId === panelEntityRequestRef.current && data.success) setObservations(data.interactions || [])
    } catch (err) {
      console.error('Failed to fetch observations:', err)
    } finally {
      if (requestId === panelEntityRequestRef.current) setLoadingObservations(false)
    }
  }

  const fetchTaskLists = async () => {
    try {
      const token = localStorage.getItem('token')
      const res = await fetch('/api/tasks/lists', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) setTaskLists(data.lists || [])
    } catch { /* ignore */ }
  }

  const fetchLeadTasks = async (leadId: string, requestId = panelEntityRequestRef.current) => {
    try {
      const token = localStorage.getItem('token')
      const res = await fetch(`/api/tasks?lead_id=${leadId}&limit=20`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (requestId === panelEntityRequestRef.current && data.success) setLeadTasks(data.tasks || [])
    } catch { /* ignore */ }
  }

  const fetchContactTasks = async (cId: string, scopedEventId?: string, requestId = panelEntityRequestRef.current) => {
    try {
      const token = localStorage.getItem('token')
      const params = new URLSearchParams({ contact_id: cId, limit: '20' })
      if (scopedEventId) params.set('event_id', scopedEventId)
      const res = await fetch(`/api/tasks?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (requestId === panelEntityRequestRef.current && data.success) setLeadTasks(data.tasks || [])
    } catch { /* ignore */ }
  }

  const saveLeadField = async (field: string) => {
    if (readOnly) return
    if (!lead?.id) return
    if (savingFieldRef.current) return
    savingFieldRef.current = field
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
        if (data.success) {
          const updated = { ...lead, ...payload } as Lead
          setLead(updated)
          onLeadChange(updated)
        }
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
      setTimeout(() => { savingFieldRef.current = null }, 50)
    }
  }

  const saveNotes = async () => {
    if (readOnly) return
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
    if (readOnly) return
    const token = localStorage.getItem('token')
    const prevLead = lead
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
        let stage: PipelineStage | undefined
        for (const p of pipelines) {
          const found = p.stages?.find(s => s.id === stageId)
          if (found) { stage = found; break }
        }
        if (!stage) return
        if (onStageChangeRequest) {
          onStageChangeRequest(lead, stage)
          return
        }

        // Optimistic update BEFORE API call
        const updated = {
          ...lead,
          stage_id: stageId,
          stage_name: stage?.name || null,
          stage_color: stage?.color || null,
          stage_position: stage?.position ?? null,
        }
        setLead(updated)
        onLeadChange(updated)

        const res = await fetch(`/api/leads/${leadId}/stage`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ stage_id: stageId }),
        })
        const data = await res.json()
        if (!data.success) {
          setLead(prevLead)
          onLeadChange(prevLead)
        }
      }
    } catch (err) {
      console.error('Failed to update stage:', err)
      setLead(prevLead)
      onLeadChange(prevLead)
    }
  }

  const handleAddObservation = async () => {
    const observationText = newObservation.trim()
    if (!observationText || savingObservation) return
    const requestId = panelEntityRequestRef.current
    const targetLeadId = lead.id
    setSavingObservation(true)
    setObservationError('')
    const token = localStorage.getItem('token')
    try {
      const leadIdForObservation = eventMode
        ? ((lead as any).original_lead_id || null)
        : lead.id
      const payload = eventMode
        ? {
            event_id: eventId,
            participant_id: participantId,
            contact_id: lead.contact_id,
            lead_id: leadIdForObservation,
            type: newObservationType,
            notes: observationText,
          }
        : contactMode && contactId
        ? { contact_id: contactId, program_id: programContext?.programId, program_participant_id: programContext?.participantId, type: newObservationType, notes: observationText }
        : { lead_id: targetLeadId, type: newObservationType, notes: observationText }
      const res = await fetch('/api/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.success) throw new Error(data?.error || 'No se pudo guardar la observación.')
      if (requestId !== panelEntityRequestRef.current) return
      setNewObservation('')
      await fetchObservations(targetLeadId, requestId)
      if (requestId === panelEntityRequestRef.current) onObservationChange?.(targetLeadId)
    } catch (err) {
      console.error('Failed to add observation:', err)
      if (requestId === panelEntityRequestRef.current) {
        setObservationError(err instanceof Error ? err.message : 'No se pudo guardar la observación.')
      }
    } finally {
      if (requestId === panelEntityRequestRef.current) setSavingObservation(false)
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

  const handleRequestHistorySync = async () => {
    const cleanPhone = (lead.phone || '').replace(/[^0-9]/g, '')
    if (syncingHistory || !cleanPhone) {
      alert('Este registro no tiene un número válido para sincronizar historial')
      return
    }
    setSyncingHistory(true)
    try {
      const token = localStorage.getItem('token')
      // First, find or create the chat for this person's phone number.
      const findRes = await fetch(`/api/chats/find-by-phone/${encodeURIComponent(cleanPhone)}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      const findData = await findRes.json()
      let chatId = findData?.chat?.id
      if (!chatId) {
        const devicesRes = await fetch('/api/devices', {
          headers: { Authorization: `Bearer ${token}` }
        })
        const devicesData = await devicesRes.json()
        const connected = (devicesData.devices || []).filter((d: any) => d.status === 'connected')
        if (connected.length === 1) {
          const createRes = await fetch('/api/chats/new', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ device_id: connected[0].id, phone: cleanPhone }),
          })
          const createData = await createRes.json()
          chatId = createData?.chat?.id
        }
      }
      if (!chatId) {
        alert('No encontré un chat para este número. Abre primero el chat con "Enviar WhatsApp" y vuelve a sincronizar.')
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
    if (readOnly) return
    const confirmMsg = contactMode
      ? '¿Estás seguro de eliminar este contacto?'
      : eventMode
        ? '¿Estás seguro de eliminar este participante?'
        : '¿Mover esta oportunidad a la papelera? Podrás restaurarla durante 30 días; el contacto, el chat y sus eventos se conservarán.'
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
    if (readOnly) return
    setEditingField(field)
    setEditValues({ ...editValues, [field]: currentValue })
  }

  const cancelEditing = () => {
    savingFieldRef.current = '_cancel'
    setEditingField(null)
    setTimeout(() => { savingFieldRef.current = null }, 50)
  }

  const handleFieldKeyDown = (e: React.KeyboardEvent, field: string) => {
    if (e.key === 'Enter') { e.preventDefault(); saveLeadField(field) }
    else if (e.key === 'Escape') cancelEditing()
  }

  // ─── Render ────────────────────────────────────────────
  return (
    <div className={`flex flex-col bg-white ${parentOwnsScroll ? 'h-auto overflow-visible' : 'h-full overflow-hidden'} ${className}`}>
      {/* Header */}
      {!hideHeader && (
        <div className="sticky top-0 bg-white/95 backdrop-blur-sm border-b border-slate-100 p-4 flex items-center justify-between z-10 shrink-0">
          <h2 className="text-sm font-semibold text-slate-900">{detailTitle || (contactMode ? 'Detalle del contacto' : eventMode ? 'Detalle del participante' : 'Detalle del lead')}</h2>
          <div className="flex items-center gap-1">
            <button onClick={onClose} className="inline-flex h-10 w-10 items-center justify-center rounded-xl hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label="Cerrar panel de detalle">
              <X className="w-4 h-4 text-slate-400" />
            </button>
          </div>
        </div>
      )}

      {/* Tab Bar */}
      <div className="flex border-b border-slate-200 shrink-0 bg-white px-2">
        <button
          onClick={() => setActiveTab('general')}
          className={`flex min-h-11 items-center gap-1.5 px-4 text-xs font-medium transition-colors whitespace-nowrap ${
            activeTab === 'general'
              ? 'text-emerald-600 border-b-2 border-emerald-600'
              : 'text-slate-400 hover:text-slate-600'
          }`}
        >
          <LayoutList className="w-3.5 h-3.5" />
          {commercialOnly ? 'Oportunidad' : 'General'}
        </button>
        <button
          onClick={() => setActiveTab('campos')}
          className={`flex min-h-11 items-center gap-1.5 px-4 text-xs font-medium transition-colors whitespace-nowrap ${
            activeTab === 'campos'
              ? 'text-emerald-600 border-b-2 border-emerald-600'
              : 'text-slate-400 hover:text-slate-600'
          }`}
        >
          <SlidersHorizontal className="w-3.5 h-3.5" />
          {commercialOnly ? 'Campos comerciales' : 'Campos'}
          {cfDefs.length > 0 && (
            <span className={`ml-1 text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${
              activeTab === 'campos'
                ? 'bg-emerald-100 text-emerald-700'
                : 'bg-slate-100 text-slate-500'
            }`}>
              {cfDefs.length}
            </span>
          )}
        </button>
      </div>

      {readOnly && eventMode && (
        <div className="mx-4 mt-4 flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs text-slate-600">
          <Archive className="mt-0.5 h-4 w-4 shrink-0" />
          <p>Evento cerrado: puedes consultar el historial, pero no cambiar la participación ni su etapa.</p>
        </div>
      )}

      <div className={`${parentOwnsScroll ? 'p-4 sm:p-5' : 'flex-1 overflow-y-auto p-6'} space-y-6 ${activeTab !== 'general' ? 'hidden' : ''}`}>
        {/* Lead Avatar & Name */}
        <div className="text-center">
          {!hideIdentity && <>
          {avatarContactId && resolvedAvatarContextId ? (
            <ContactAvatarControl
              contactId={avatarContactId}
              contextType={resolvedAvatarContextType}
              contextId={resolvedAvatarContextId}
              displayName={lead.name || lead.phone || 'Contacto'}
              avatarUrl={avatarUrl}
              disabled={readOnly}
              onChange={onAvatarChange}
            />
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
              className="mx-auto block w-full max-w-[250px] border-b-2 border-emerald-500 bg-transparent text-center text-lg font-bold text-slate-900 outline-none"
              placeholder="Nombre"
            />
          ) : (
            <h3
              className="cursor-pointer text-lg font-bold text-slate-900 transition-colors hover:text-emerald-700"
              onClick={() => startEditing('name', lead.name || '')}
              title="Clic para editar nombre"
            >
              {lead.name || 'Sin nombre'}
            </h3>
          )}
          {lead.stage_name && (
            <span className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: lead.stage_color || '#64748b' }} aria-hidden="true" />
              {lead.stage_name}
            </span>
          )}
          {!eventMode && !contactMode && (lead.status === 'won' || lead.status === 'lost') && (
            <div className={`mx-auto mt-2 max-w-sm rounded-xl border px-3 py-2 text-left ${lead.status === 'won' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-800'}`}>
              <p className="text-xs font-bold">{lead.status === 'won' ? 'Oportunidad ganada' : 'Oportunidad perdida'}</p>
              {lead.status === 'lost' && lead.close_reason && <p className="mt-0.5 text-xs leading-relaxed opacity-80">{lead.close_reason}</p>}
            </div>
          )}
          {contactMode && pushName && pushName !== lead.name && (
            <p className="text-xs text-slate-400 mt-0.5">Push: {pushName}</p>
          )}
          {contactMode && lead.jid && (
            <p className="text-xs text-slate-400">{lead.jid}</p>
          )}
          </>}

          {/* Archive/Block status badges */}
          {!contactMode && (lead.is_archived || (!commercialOnly && lead.is_blocked)) && (
            <div className="flex items-center justify-center gap-2 mt-2">
              {lead.is_archived && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-50 border border-amber-200 rounded-full text-xs font-medium text-amber-700">
                  <Archive className="w-3 h-3" />
                  Archivado
                </span>
              )}
              {!commercialOnly && lead.is_blocked && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-red-50 border border-red-200 rounded-full text-xs font-medium text-red-700" title={lead.block_reason || ''}>
                  <ShieldBan className="w-3 h-3" />
                  No contactable{lead.block_reason ? `: ${lead.block_reason}` : ''}
                </span>
              )}
            </div>
          )}

          {/* Archive/Block action buttons */}
          {!contactMode && !readOnly && (
            <div className="flex items-center justify-center gap-2 mt-2">
              {!commercialOnly && lead.is_blocked ? (
                onUnblock && (
                  <button
                    onClick={() => onUnblock(lead.id)}
                    className="inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-xs font-medium text-slate-600 transition-colors hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                  >
                    <ShieldOff className="w-3 h-3" />
                    Permitir contacto
                  </button>
                )
              ) : (
                <>
                  {lead.is_archived ? (
                    onArchive && (
                      <button
                        onClick={() => onArchive(lead.id, false)}
                        className="inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-xs font-medium text-slate-600 transition-colors hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                      >
                        <ArchiveRestore className="w-3 h-3" />
                        Restaurar
                      </button>
                    )
                  ) : (
                    onArchive && (
                      <button
                        onClick={() => onArchive(lead.id, true)}
                        className="inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-xs font-medium text-slate-600 transition-colors hover:border-amber-300 hover:bg-amber-50 hover:text-amber-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                      >
                        <Archive className="w-3 h-3" />
                        Archivar
                      </button>
                    )
                  )}
                  {onBlock && (
                    <button
                      onClick={() => onBlock(lead.id)}
                      className="inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-red-200 bg-white px-3 text-xs font-medium text-slate-600 transition-colors hover:bg-red-50 hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                    >
                      <ShieldBan className="w-3 h-3" />
                      No contactar
                    </button>
                  )}
                </>
              )}
            </div>
          )}

          {!contactMode && !eventMode && !lead.deleted_at && onLifecycleAction && (
            <div className="mt-3 flex items-center justify-center gap-2">
              {lead.status === 'won' || lead.status === 'lost' ? (
                <button type="button" onClick={() => onLifecycleAction(lead, 'reopen')} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-3 text-xs font-bold text-blue-700 transition hover:bg-blue-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
                  <ArchiveRestore className="h-4 w-4" /> Reabrir lead
                </button>
              ) : (
                <>
                  <button type="button" onClick={() => onLifecycleAction(lead, 'won')} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 text-xs font-bold text-emerald-700 transition hover:bg-emerald-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
                    <CheckCircle2 className="h-4 w-4" /> Ganado
                  </button>
                  <button type="button" onClick={() => onLifecycleAction(lead, 'lost')} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 text-xs font-bold text-red-700 transition hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500">
                    <XCircle className="h-4 w-4" /> Perdido
                  </button>
                </>
              )}
            </div>
          )}

          {/* External metadata and Google sync status */}
          <div className="flex items-center justify-center gap-2 mt-3 flex-wrap">
            {!eventMode && !contactMode && lead.kommo_id && (
                <span className={`flex items-center gap-1.5 px-2.5 py-1 border rounded-full text-xs font-medium ${lead.kommo_deleted_at ? 'bg-amber-50 border-amber-200 text-amber-700' : 'bg-emerald-50 border-emerald-200 text-emerald-700'}`}>
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${lead.kommo_deleted_at ? 'bg-amber-500' : 'bg-emerald-500'}`} />
                  {lead.kommo_deleted_at ? `Eliminado de Kommo #${lead.kommo_id}` : `Kommo #${lead.kommo_id}`}
                </span>
            )}
            {!commercialOnly && googleConnected && (contactMode ? contactId : lead.contact_id) && (
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

        {!contactMode && !eventMode && (
          <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
            <div className="mb-1 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
              <Briefcase className="h-3.5 w-3.5" /> Concepto del lead
            </div>
            {editingField === 'title' ? (
              <input
                autoFocus
                value={editValues.title ?? ''}
                onChange={(e) => setEditValues({ ...editValues, title: e.target.value })}
                onKeyDown={(e) => handleFieldKeyDown(e, 'title')}
                onBlur={() => saveLeadField('title')}
                className="mt-2 w-full border-b-2 border-emerald-500 bg-transparent py-1 text-sm font-semibold text-slate-900 outline-none"
                placeholder="Ej. Matrícula del curso de verano"
              />
            ) : (
              <button type="button" onClick={() => startEditing('title', lead.title || '')} className="mt-1 flex min-h-9 w-full items-center justify-between gap-3 rounded-lg text-left text-sm font-semibold text-slate-800 hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
                <span className={lead.title ? '' : 'font-normal italic text-slate-400'}>{lead.title || 'Agregar concepto comercial'}</span>
                <Edit2 className="h-3.5 w-3.5 shrink-0 text-slate-400" />
              </button>
            )}
          </div>
        )}

        {/* Contact-owned fields are rendered once by the parent in commercial-only mode. */}
        {!commercialOnly && <>
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
                {lead.birth_date ? format(parseISO(lead.birth_date.split('T')[0]), 'dd/MM/yyyy') : 'Agregar fecha de nacimiento'}
              </span>
            )}
          </div>

          {/* Address */}
          <div className="flex items-center gap-3 group">
            <MapPin className="w-4 h-4 text-emerald-600 shrink-0" />
            {editingField === 'address' ? (
              <input autoFocus type="text" value={editValues.address ?? ''} onChange={(e) => setEditValues({ ...editValues, address: e.target.value })} onKeyDown={(e) => handleFieldKeyDown(e, 'address')} onBlur={() => saveLeadField('address')} className="flex-1 text-sm text-slate-800 bg-transparent border-b-2 border-emerald-500 outline-none" placeholder="Dirección" />
            ) : (
              <span className={`text-sm flex-1 cursor-pointer hover:text-emerald-700 ${lead.address ? 'text-slate-800' : 'text-slate-400 italic'}`} onClick={() => startEditing('address', lead.address || '')} title="Clic para editar">
                {lead.address || 'Agregar dirección'}
              </span>
            )}
          </div>

          {/* Distrito */}
          <div className="flex items-center gap-3 group">
            <Map className="w-4 h-4 text-emerald-600 shrink-0" />
            {editingField === 'distrito' ? (
              <input autoFocus type="text" value={editValues.distrito ?? ''} onChange={(e) => setEditValues({ ...editValues, distrito: e.target.value })} onKeyDown={(e) => handleFieldKeyDown(e, 'distrito')} onBlur={() => saveLeadField('distrito')} className="flex-1 text-sm text-slate-800 bg-transparent border-b-2 border-emerald-500 outline-none" placeholder="Distrito" />
            ) : (
              <span className={`text-sm flex-1 cursor-pointer hover:text-emerald-700 ${lead.distrito ? 'text-slate-800' : 'text-slate-400 italic'}`} onClick={() => startEditing('distrito', lead.distrito || '')} title="Clic para editar">
                {lead.distrito || 'Agregar distrito'}
              </span>
            )}
          </div>

          {/* Ocupación */}
          <div className="flex items-center gap-3 group">
            <Briefcase className="w-4 h-4 text-emerald-600 shrink-0" />
            {editingField === 'ocupacion' ? (
              <input autoFocus type="text" value={editValues.ocupacion ?? ''} onChange={(e) => setEditValues({ ...editValues, ocupacion: e.target.value })} onKeyDown={(e) => handleFieldKeyDown(e, 'ocupacion')} onBlur={() => saveLeadField('ocupacion')} className="flex-1 text-sm text-slate-800 bg-transparent border-b-2 border-emerald-500 outline-none" placeholder="Ocupación" />
            ) : (
              <span className={`text-sm flex-1 cursor-pointer hover:text-emerald-700 ${lead.ocupacion ? 'text-slate-800' : 'text-slate-400 italic'}`} onClick={() => startEditing('ocupacion', lead.ocupacion || '')} title="Clic para editar">
                {lead.ocupacion || 'Agregar ocupación'}
              </span>
            )}
          </div>
        </div>

        {/* Tags belong to the person/contact, including inside an event. */}
        {(!eventMode || contactId || lead.contact_id) && <div className="space-y-2">
          <h5 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Etiquetas</h5>
          {readOnly ? (
            <div className="flex flex-wrap gap-1.5">
              {(lead.structured_tags || []).length > 0 ? (lead.structured_tags || []).map(tag => (
                <span key={tag.id} className="rounded-full px-2 py-1 text-xs font-medium text-white" style={{ backgroundColor: tag.color || '#64748b' }}>{tag.name}</span>
              )) : <span className="text-xs italic text-slate-400">Sin etiquetas</span>}
            </div>
          ) : (
            <TagInput
              entityType={contactMode || eventMode ? "contact" : "lead"}
              entityId={(contactMode || eventMode) && (contactId || lead.contact_id) ? (contactId || lead.contact_id)! : lead.id}
              assignedTags={lead.structured_tags || []}
              onTagsChange={(newTags) => {
                const updated = { ...lead, structured_tags: newTags }
                setLead(updated)
                onLeadChange(updated)
              }}
              onBeforeAssign={eventMode ? onBeforeTagAssign : undefined}
              onBeforeRemove={eventMode ? onBeforeTagRemove : undefined}
            />
          )}
        </div>}
        </>}

        {/* Pipeline & Stage Selector (hidden in contact mode) */}
        {!contactMode && (
        <div className="border-t border-slate-100 pt-4" ref={dropdownRef}>
          <h5 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
            {eventMode ? 'Etapa del evento' : 'Etapa de la oportunidad'}
          </h5>

          <div className="relative">
            {/* Main Button */}
            <button
              disabled={readOnly}
              onClick={() => {
                const willOpen = !showPipelineDropdown
                setShowPipelineDropdown(willOpen)
                if (willOpen && lead.pipeline_id) {
                  setExpandedPipelineId(lead.pipeline_id)
                }
              }}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl border transition-all disabled:cursor-default ${
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
                    ) : 'Oportunidad sin asignar'
                  )}
                </span>
              </div>
              {!readOnly && <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${showPipelineDropdown ? 'rotate-180' : ''}`} />}
            </button>

            {/* Dropdown */}
            {showPipelineDropdown && !readOnly && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-white rounded-xl shadow-xl border border-slate-100 overflow-hidden z-20 max-h-[400px] overflow-y-auto">
                {eventMode ? (
                  /* Event mode: flat list of event stages */
                  <>
                    {eventStages?.map(stage => (
                      <button
                        key={stage.id}
                        className={`flex min-h-11 w-full items-center gap-2 px-3 py-2 cursor-pointer transition-colors text-left ${
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
                    {/* Pipelines and Stages */}
                    {pipelines.map(pipeline => {
                      const isExpanded = expandedPipelineId === pipeline.id
                      return (
                        <div key={pipeline.id} className="border-b border-slate-50 last:border-0">
                          <button
                            className={`flex min-h-11 w-full items-center justify-between px-3 py-2 text-left transition-colors ${
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
                                  className={`flex min-h-11 w-full items-center gap-2 rounded-lg px-3 py-2 cursor-pointer transition-colors text-left ${
                                    lead.stage_id === stage.id ? 'bg-emerald-50 text-emerald-700' : 'hover:bg-slate-100 text-slate-700'
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

        {eventMode && eventMembership && (eventMembership.state || eventMembership.source || eventMembership.autoTagSync !== undefined) && (
          <div className="mt-1 rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Participación en el evento</p>
                <p className="mt-1 text-sm font-semibold text-slate-700">
                  {!eventMembership.state ? 'Verificando participación…' : eventMembership.state === 'inactive' ? 'Fuera del listado activo' : 'Participante activo'}
                </p>
              </div>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${eventMembership.autoTagSync ? 'bg-violet-100 text-violet-700' : 'bg-slate-200 text-slate-600'}`}>
                {eventMembership.autoTagSync === undefined ? 'Verificando…' : eventMembership.autoTagSync ? 'Sujeto a reglas' : 'Sin regla automática'}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500">
              <span>Origen: {eventMembership.source === 'rule' ? 'regla automática' : eventMembership.source === 'manual' ? 'alta por usuario' : eventMembership.source || 'no registrado'}</span>
              {eventMembership.changedAt && <span>Actualizado: {new Date(eventMembership.changedAt).toLocaleString('es-PE')}</span>}
            </div>
            {eventMembership.reason && (
              <p className="mt-2 rounded-lg bg-amber-50 px-2.5 py-2 text-xs text-amber-800">
                Motivo: {eventMembership.reason === 'rule_ineligible' ? 'ya no cumple las reglas actuales del evento' : eventMembership.reason}
              </p>
            )}
          </div>
        )}

        {/* Event membership is Contact-first; commercial opportunities are read-only context. */}
        {eventMode && (
          <div className="mt-1 border-t border-slate-100 pt-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h5 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Oportunidades del contacto</h5>
              {!relatedLeadsLoading && relatedLeads.length > 0 && (
                <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-semibold text-violet-700">{relatedLeads.length}</span>
              )}
            </div>
            {relatedLeadsLoading ? (
              <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-500">
                <Loader2 className="h-4 w-4 animate-spin text-violet-500" /> Cargando oportunidades…
              </div>
            ) : relatedLeadsError ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-3">
                <p className="text-sm font-medium text-amber-900">No se pudo verificar la ficha completa</p>
                <p className="mt-1 text-xs leading-relaxed text-amber-800">{relatedLeadsError}</p>
                {onRetryRelatedLeads && (
                  <button type="button" onClick={onRetryRelatedLeads} className="mt-2 inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-3 text-xs font-semibold text-amber-800 transition hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500">
                    <RefreshCw className="h-3.5 w-3.5" /> Reintentar
                  </button>
                )}
              </div>
            ) : relatedLeads.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/60 px-3 py-3">
                <p className="text-sm font-medium text-slate-600">Sin oportunidades relacionadas</p>
                <p className="mt-1 text-xs leading-relaxed text-slate-500">La participación pertenece al contacto y no necesita un lead para existir.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {[
                  {
                    label: 'Abiertas',
                    historical: false,
                    items: relatedLeads.filter(item => !item.is_archived && item.status === 'open'),
                  },
                  {
                    label: 'Historial',
                    historical: true,
                    items: relatedLeads.filter(item => item.is_archived || item.status !== 'open'),
                  },
                ].filter(section => section.items.length > 0).map(section => (
                  <div key={section.label} className="space-y-1.5">
                    <div className="flex items-center justify-between px-1 pt-1">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{section.label}</p>
                      <span className="text-[10px] font-semibold text-slate-400">{section.items.length}</span>
                    </div>
                    {section.items.map(relatedLead => {
                      const statusLabel = relatedLead.is_archived
                        ? 'Archivada'
                        : relatedLead.status === 'won'
                          ? 'Ganada'
                          : relatedLead.status === 'lost'
                            ? 'Perdida'
                            : 'Abierta'
                      return (
                        <a
                          key={relatedLead.id}
                          href={`/dashboard/leads?lead_id=${relatedLead.id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="group block rounded-xl border border-slate-200 bg-white px-3 py-3 transition hover:border-violet-200 hover:bg-violet-50/40 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
                        >
                          <div className="flex items-start gap-2.5">
                            <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full ring-2 ring-white" style={{ backgroundColor: relatedLead.stage_color || '#8b5cf6' }} />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-start justify-between gap-2">
                                <p className="truncate text-sm font-semibold text-slate-800">{relatedLead.title || 'Oportunidad sin título'}</p>
                                <ExternalLink className="h-3.5 w-3.5 shrink-0 text-slate-400 transition group-hover:text-violet-600" />
                              </div>
                              <p className="mt-0.5 truncate text-xs text-slate-500">
                                {relatedLead.pipeline_name || 'Sin pipeline'} <span className="text-slate-300">/</span> {relatedLead.stage_name || 'Sin etapa'}
                              </p>
                              <span className={`mt-2 inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${section.historical ? 'bg-slate-100 text-slate-600' : 'bg-emerald-50 text-emerald-700'}`}>{statusLabel}</span>
                            </div>
                          </div>
                        </a>
                      )
                    })}
                  </div>
                ))}
                <p className="px-1 text-[11px] leading-relaxed text-slate-400">Las etapas comerciales se gestionan desde Leads y no cambian la etapa de este evento.</p>
              </div>
            )}
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
        {!eventMode && (
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
              placeholder="Escribe notas sobre esta oportunidad..."
            />
          ) : (
            <div className="text-sm text-slate-700 bg-slate-50 rounded-xl p-3 min-h-[50px] border border-slate-100">
              {lead.notes || <span className="text-slate-400 italic">Sin notas</span>}
            </div>
          )}
        </div>
        )}

        {/* Actions */}
        <div className="flex flex-col gap-2 pt-2 border-t border-slate-100">
          {contactMode ? (
            <>
              {!hideWhatsApp && onSendWhatsApp && lead.phone && (
                <button
                  onClick={() => onSendWhatsApp(lead.phone)}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 transition text-sm font-medium shadow-sm"
                >
                  <MessageCircle className="w-4 h-4" />
                  Enviar Mensaje
                </button>
              )}
              {!hideWhatsApp && onSendMessage && !onSendWhatsApp && (
                <button
                  onClick={onSendMessage}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 transition text-sm font-medium shadow-sm"
                >
                  <MessageCircle className="w-4 h-4" />
                  Enviar Mensaje
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

          <button
            onClick={() => setShowDocumentModal(true)}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 border border-slate-200 text-slate-600 rounded-xl hover:bg-slate-50 transition text-sm"
          >
            <FileText className="w-4 h-4" />
            Generar Documento
          </button>

          {!hideDelete && !readOnly && (
            <button
              onClick={handleDeleteLead}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 border border-red-200 text-red-500 rounded-xl hover:bg-red-50 text-sm"
            >
              <Trash2 className="w-4 h-4" />
              Eliminar
            </button>
          )}
        </div>

        {/* ─── Tasks Section ─── */}
        {(!contactMode || (contactMode && contactId)) && (
          <div id="tasks-section">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-xs font-semibold text-slate-500 flex items-center gap-2">
                <Calendar className="w-3.5 h-3.5" />
                Tareas ({leadTasks.filter(t => t.status === 'pending' || t.status === 'overdue').length})
              </h4>
              <button
                onClick={() => { setEditingTask(null); setShowTaskModal(true) }}
                className="p-1.5 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition"
                title="Nueva tarea"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>
            {leadTasks.filter(t => t.status === 'pending' || t.status === 'overdue').length > 0 ? (
              <TaskList
                tasks={leadTasks.filter(t => t.status === 'pending' || t.status === 'overdue')}
                maxItems={5}
                compact
                onComplete={async (taskId) => {
                  try {
                    const token = localStorage.getItem('token')
                    await fetch(`/api/tasks/${taskId}/complete`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
                    if (eventMode && eventId && lead.contact_id) fetchContactTasks(lead.contact_id, eventId)
                    else if (contactMode && contactId) fetchContactTasks(contactId)
                    else fetchLeadTasks(lead.id)
                  } catch { /* ignore */ }
                }}
                onUpdate={async (taskId, fields) => {
                  try {
                    const token = localStorage.getItem('token')
                    await fetch(`/api/tasks/${taskId}`, {
                      method: 'PUT',
                      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                      body: JSON.stringify(fields),
                    })
                    if (eventMode && eventId && lead.contact_id) fetchContactTasks(lead.contact_id, eventId)
                    else if (contactMode && contactId) fetchContactTasks(contactId)
                    else fetchLeadTasks(lead.id)
                  } catch { /* ignore */ }
                }}
                onDelete={async (taskId) => {
                  try {
                    const token = localStorage.getItem('token')
                    await fetch(`/api/tasks/${taskId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
                    if (eventMode && eventId && lead.contact_id) fetchContactTasks(lead.contact_id, eventId)
                    else if (contactMode && contactId) fetchContactTasks(contactId)
                    else fetchLeadTasks(lead.id)
                  } catch { /* ignore */ }
                }}
                onOpenFullEdit={(t) => { setEditingTask(t); setShowTaskModal(true) }}
              />
            ) : (
              <p className="text-xs text-slate-400 text-center py-2">Sin tareas</p>
            )}
          </div>
        )}

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
                onClick={() => { setNewObservationType('note'); setObservationError('') }}
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
                onClick={() => { setNewObservationType('call'); setObservationError('') }}
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
              onChange={(e) => { setNewObservation(e.target.value); setObservationError('') }}
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
            {observationError && (
              <div role="alert" className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-700">
                {observationError}
              </div>
            )}
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
                      {obs.program_id && obs.source_label && <p className={`mt-1.5 text-[10px] font-medium ${obs.type === 'attendance' ? 'text-emerald-700' : 'text-slate-500'}`}>{obs.source_label}</p>}
                    </div>
                    {obs.type !== 'attendance' && <button onClick={() => handleDeleteObservation(obs.id)} className="p-1 text-gray-300 hover:text-red-500 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity shrink-0" title="Eliminar">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>}
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

      {/* Custom Fields Tab */}
      <div className={`${parentOwnsScroll ? 'p-4 sm:p-5' : 'flex-1 overflow-y-auto p-6'} space-y-6 ${activeTab !== 'campos' ? 'hidden' : ''}`}>
        {(contactMode ? contactId : lead.contact_id) ? (
          cfLoading ? (
            <div className="space-y-3">
              {[...Array(4)].map((_, i) => <div key={i} className="h-8 bg-slate-50 rounded-lg animate-pulse" />)}
            </div>
          ) : cfDefs.length > 0 ? (
            <div className="space-y-1">
              {cfDefs.map(def => (
                <CustomFieldInput
                  key={def.id}
                  definition={def}
                  value={cfValues.find(v => v.field_id === def.id)}
                  onSave={handleSaveCustomField}
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <SlidersHorizontal className="w-8 h-8 text-slate-300 mb-3" />
              <p className="text-sm font-medium text-slate-500">Sin campos personalizados</p>
              <p className="text-xs text-slate-400 mt-1">Crea campos desde Configuración para comenzar</p>
            </div>
          )
        ) : (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <SlidersHorizontal className="w-8 h-8 text-slate-300 mb-3" />
            <p className="text-sm font-medium text-slate-500">Contacto no vinculado</p>
            <p className="text-xs text-slate-400 mt-1">Vincule un contacto para ver campos personalizados</p>
          </div>
        )}
      </div>

      {/* Full History Modal */}
      <ObservationHistoryModal
        isOpen={showHistoryModal}
        onClose={() => setShowHistoryModal(false)}
        leadId={lead.id}
        participantId={eventMode ? participantId : undefined}
        eventId={eventMode ? eventId : undefined}
        contactId={eventMode ? lead.contact_id : contactMode ? contactId : undefined}
        programId={programContext?.programId}
        programParticipantId={programContext?.participantId}
        defaultNewType={defaultObservationType}
        name={lead.name || 'Sin nombre'}
        observations={observations}
        onObservationChange={() => { fetchObservations(lead.id); onObservationChange?.(lead.id) }}
      />

      {/* Task Form Modal (lead/contact-linked) */}
      {(!contactMode || (contactMode && contactId)) && (
        <TaskFormModal
          isOpen={showTaskModal}
          onClose={() => { setShowTaskModal(false); setEditingTask(null) }}
          onSave={() => {
            setShowTaskModal(false); setEditingTask(null)
            if (eventMode && eventId && lead.contact_id) { fetchContactTasks(lead.contact_id, eventId); fetchObservations(lead.id) }
            else if (contactMode && contactId) { fetchContactTasks(contactId); fetchObservations(lead.id) }
            else { fetchLeadTasks(lead.id); fetchObservations(lead.id) }
          }}
          task={editingTask}
          leadId={contactMode || eventMode ? undefined : lead.id}
          leadName={contactMode || eventMode ? undefined : lead.name}
          eventId={eventMode ? eventId : undefined}
          contactId={eventMode ? lead.contact_id || undefined : contactMode ? contactId : undefined}
          contactName={eventMode || contactMode ? lead.name : undefined}
          taskLists={taskLists}
        />
      )}

      {/* Generate Document Modal */}
      {showDocumentModal && (
        <GenerateDocumentModal
          lead={lead}
          onClose={() => setShowDocumentModal(false)}
        />
      )}

    </div>
  )
}
