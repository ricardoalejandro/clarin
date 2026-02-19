'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { Search, Plus, Phone, Mail, User, Tag, Calendar, MoreVertical, MessageCircle, Trash2, Edit, ChevronDown, ChevronLeft, ChevronRight, Filter, CheckSquare, Square, XCircle, Clock, FileText, X, Maximize2, Upload, Building2, Save, Edit2, Settings, Pencil, Eye, EyeOff, GripVertical, RefreshCw, Radio } from 'lucide-react'
import { formatDistanceToNow, format } from 'date-fns'
import { es } from 'date-fns/locale'
import ImportCSVModal from '@/components/ImportCSVModal'
import TagInput from '@/components/TagInput'
import CreateCampaignModal, { CampaignFormResult } from '@/components/CreateCampaignModal'
import { useRouter } from 'next/navigation'
import { createWebSocket } from '@/lib/api'
import ChatPanel from '@/components/chat/ChatPanel'
import LeadDetailPanel from '@/components/LeadDetailPanel'
import { Chat } from '@/types/chat'

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
  lead_count: number
}

interface Pipeline {
  id: string
  account_id: string
  name: string
  description: string | null
  is_default: boolean
  stages: PipelineStage[] | null
}

interface Device {
  id: string
  name: string
  phone: string
  jid: string
  status: string
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

export default function LeadsPage() {
  const router = useRouter()
  const [leads, setLeads] = useState<Lead[]>([])
  const [pipelines, setPipelines] = useState<Pipeline[]>([])
  const [activePipeline, setActivePipeline] = useState<Pipeline | null>(null)
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState('')
  const [showFilterDropdown, setShowFilterDropdown] = useState(false)
  const [filterStageIds, setFilterStageIds] = useState<Set<string>>(new Set())
  const [filterTagNames, setFilterTagNames] = useState<Set<string>>(new Set())
  const [tagSearchTerm, setTagSearchTerm] = useState('')
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
    notes: '',
    tags: '',
  })

  // Detail panel
  const [showDetailPanel, setShowDetailPanel] = useState(false)
  const [detailLead, setDetailLead] = useState<Lead | null>(null)
  const [observations, setObservations] = useState<Observation[]>([])
  const [loadingObservations, setLoadingObservations] = useState(false)
  const [newObservation, setNewObservation] = useState('')
  const [newObservationType, setNewObservationType] = useState<'note' | 'call'>('note')
  const [savingObservation, setSavingObservation] = useState(false)
  const [obsDisplayCount, setObsDisplayCount] = useState(5)
  const [showHistoryModal, setShowHistoryModal] = useState(false)
  const [showImportModal, setShowImportModal] = useState(false)
  const [syncingKommo, setSyncingKommo] = useState(false)
  const [historyFilterType, setHistoryFilterType] = useState('')
  const [historyFilterFrom, setHistoryFilterFrom] = useState('')
  const [historyFilterTo, setHistoryFilterTo] = useState('')

  // Inline editing for lead fields
  const [editingField, setEditingField] = useState<string | null>(null)
  const [editValues, setEditValues] = useState<Record<string, string>>({})
  const [savingField, setSavingField] = useState(false)
  const [editingNotes, setEditingNotes] = useState(false)
  const [notesValue, setNotesValue] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)

  // Pipeline stage management
  const [showStageModal, setShowStageModal] = useState(false)
  const [newStageName, setNewStageName] = useState('')
  const [newStageColor, setNewStageColor] = useState('#6366f1')
  const [editingStageId, setEditingStageId] = useState<string | null>(null)
  const [editStageName, setEditStageName] = useState('')
  const [editStageColor, setEditStageColor] = useState('')
  const [hiddenStageIds, setHiddenStageIds] = useState<Set<string>>(new Set())
  const [dragSrcIdx, setDragSrcIdx] = useState<number | null>(null)
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null)
  const [expandedPipelineId, setExpandedPipelineId] = useState<string | null>(null)

  // Click outside to close dropdown

  // Device selector for WhatsApp
  const [showDeviceSelector, setShowDeviceSelector] = useState(false)
  const [devices, setDevices] = useState<Device[]>([])
  const [whatsappPhone, setWhatsappPhone] = useState('')

  // Inline chat panel
  const [showInlineChat, setShowInlineChat] = useState(false)
  const [inlineChatId, setInlineChatId] = useState('')
  const [inlineChat, setInlineChat] = useState<Chat | null>(null)
  const [inlineChatDeviceId, setInlineChatDeviceId] = useState('')

  // Device filter for leads
  const [filterDeviceIds, setFilterDeviceIds] = useState<Set<string>>(new Set())
  const [showDeviceFilter, setShowDeviceFilter] = useState(false)

  // Broadcast from leads
  const [showBroadcastModal, setShowBroadcastModal] = useState(false)
  const [submittingBroadcast, setSubmittingBroadcast] = useState(false)

  const kanbanRef = useRef<HTMLDivElement>(null)
  const topScrollRef = useRef<HTMLDivElement>(null)
  const filterDropdownRef = useRef<HTMLDivElement>(null)
  const syncingScroll = useRef(false)

  // Click outside to close dropdown
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (filterDropdownRef.current && !filterDropdownRef.current.contains(event.target as Node)) {
        setShowFilterDropdown(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => {
      document.removeEventListener("mousedown", handleClickOutside)
    }
  }, [filterDropdownRef])

  const fetchPipelines = useCallback(async () => {
    const token = localStorage.getItem('token')
    try {
      const [pipelinesRes, connectedRes] = await Promise.all([
        fetch('/api/pipelines', { headers: { Authorization: `Bearer ${token}` } }),
        fetch('/api/kommo/connected', { headers: { Authorization: `Bearer ${token}` } }),
      ])
      const data = await pipelinesRes.json()
      const connectedData = await connectedRes.json()
      if (data.success && data.pipelines) {
        setPipelines(data.pipelines)
        // Default to the Kommo-connected pipeline, then is_default, then first
        let defaultP = null
        if (connectedData.success && connectedData.connected) {
          const active = connectedData.connected.find((c: { enabled: boolean }) => c.enabled)
          if (active?.pipeline_id) {
            defaultP = data.pipelines.find((p: Pipeline) => p.id === active.pipeline_id)
          }
        }
        if (!defaultP) {
          defaultP = data.pipelines.find((p: Pipeline) => p.is_default) || data.pipelines[0]
        }
        if (defaultP) setActivePipeline(defaultP)
      }
    } catch (err) {
      console.error('Failed to fetch pipelines:', err)
    }
  }, [])

  const fetchLeads = useCallback(async () => {
    const token = localStorage.getItem('token')
    try {
      const params = new URLSearchParams()
      filterDeviceIds.forEach(id => params.append('device_ids', id))
      const url = `/api/leads${params.toString() ? '?' + params.toString() : ''}`
      const res = await fetch(url, {
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
  }, [filterDeviceIds])

  const fetchDevices = useCallback(async () => {
    const token = localStorage.getItem('token')
    try {
      const res = await fetch('/api/devices', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        setDevices((data.devices || []).filter((d: Device) => d.status === 'connected'))
      }
    } catch (err) {
      console.error('Failed to fetch devices:', err)
    }
  }, [])

  useEffect(() => {
    fetchPipelines()
    fetchLeads()
    fetchDevices()
    // Load hidden stages from localStorage
    try {
      const saved = localStorage.getItem('hiddenStageIds')
      if (saved) setHiddenStageIds(new Set(JSON.parse(saved)))
    } catch {}
  }, [fetchPipelines, fetchLeads])

  // WebSocket: listen for lead_update events for real-time refresh
  useEffect(() => {
    const ws = createWebSocket((data: unknown) => {
      const msg = data as { event?: string }
      if (msg.event === 'lead_update') {
        fetchLeads()
      }
    })
    return () => {
      if (ws) ws.close()
    }
  }, [fetchLeads])

  // Debounce search term (500ms)
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearchTerm(searchTerm), 500)
    return () => clearTimeout(timer)
  }, [searchTerm])

  // Click outside to close filter dropdown + reset tag search
  useEffect(() => {
    if (!showFilterDropdown) {
      setTagSearchTerm('')
      return
    }
    const handleClickOutside = (e: MouseEvent) => {
      if (filterDropdownRef.current && !filterDropdownRef.current.contains(e.target as Node)) {
        setShowFilterDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showFilterDropdown])

  // Sync horizontal scroll between top scrollbar and kanban
  const handleTopScroll = () => {
    if (syncingScroll.current) return
    syncingScroll.current = true
    if (kanbanRef.current && topScrollRef.current) {
      kanbanRef.current.scrollLeft = topScrollRef.current.scrollLeft
    }
    syncingScroll.current = false
  }
  const handleKanbanScroll = () => {
    if (syncingScroll.current) return
    syncingScroll.current = true
    if (kanbanRef.current && topScrollRef.current) {
      topScrollRef.current.scrollLeft = kanbanRef.current.scrollLeft
    }
    syncingScroll.current = false
  }

  const toggleStageVisibility = (stageId: string) => {
    setHiddenStageIds(prev => {
      const next = new Set(prev)
      if (next.has(stageId)) next.delete(stageId)
      else next.add(stageId)
      localStorage.setItem('hiddenStageIds', JSON.stringify(Array.from(next)))
      return next
    })
  }

  const handleReorderStages = async (fromIdx: number, toIdx: number) => {
    if (!activePipeline || fromIdx === toIdx) return
    const reordered = [...stages]
    const [moved] = reordered.splice(fromIdx, 1)
    reordered.splice(toIdx, 0, moved)
    // Optimistically update
    const updated = { ...activePipeline, stages: reordered.map((s, i) => ({ ...s, position: i })) }
    setActivePipeline(updated)
    setPipelines(prev => prev.map(p => p.id === updated.id ? updated : p))
    // API call
    const token = localStorage.getItem('token')
    try {
      await fetch(`/api/pipelines/${activePipeline.id}/stages/reorder`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ stage_ids: reordered.map(s => s.id) }),
      })
    } catch (err) {
      console.error('Failed to reorder stages:', err)
      fetchPipelines()
    }
  }

  const allStages = activePipeline?.stages || []
  const stages = allStages.filter(s => !hiddenStageIds.has(s.id))

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
        setFormData({ name: '', phone: '', email: '', notes: '', tags: '' })
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
      }
    } catch (err) {
      console.error('Failed to delete lead:', err)
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
      }
    } catch (err) {
      console.error('Failed to delete leads:', err)
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

  const openDetailPanel = (lead: Lead) => {
    setDetailLead(lead)
    setShowDetailPanel(true)
    setObsDisplayCount(5)
    setEditingField(null)
    setEditingNotes(false)
    setNotesValue(lead.notes || '')
    fetchObservations(lead.id)
  }

  const startEditing = (field: string, currentValue: string) => {
    setEditingField(field)
    setEditValues({ ...editValues, [field]: currentValue })
  }

  const cancelEditing = () => {
    setEditingField(null)
  }

  const saveLeadField = async (field: string) => {
    if (!detailLead?.id) return
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
      const res = await fetch(`/api/leads/${detailLead.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (data.success && data.lead) {
        const merged = { ...data.lead, structured_tags: data.lead.structured_tags || detailLead.structured_tags }
        setDetailLead(merged)
        setLeads(prev => prev.map(l => l.id === data.lead.id ? merged : l))
      }
    } catch (err) {
      console.error('Failed to save lead field:', err)
    } finally {
      setSavingField(false)
      setEditingField(null)
    }
  }

  const handleFieldKeyDown = (e: React.KeyboardEvent, field: string) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      saveLeadField(field)
    } else if (e.key === 'Escape') {
      cancelEditing()
    }
  }

  const saveNotes = async () => {
    if (!detailLead) return
    setSavingNotes(true)
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/leads/${detailLead.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ notes: notesValue }),
      })
      const data = await res.json()
      if (data.success && data.lead) {
        const merged = { ...data.lead, structured_tags: data.lead.structured_tags || detailLead.structured_tags }
        setDetailLead(merged)
        setLeads(prev => prev.map(l => l.id === data.lead.id ? merged : l))
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
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ stage_id: stageId }),
      })
      const data = await res.json()
      if (data.success) {
        // Find stage in current pipeline or look it up across all pipelines
        let stage = stages.find(s => s.id === stageId)
        if (!stage) {
           // Fallback: look in all pipelines
           for (const p of pipelines) {
             const found = p.stages?.find(s => s.id === stageId)
             if (found) {
               stage = found
               break
             }
           }
        }

        setLeads(prev => prev.map(l => l.id === leadId ? {
          ...l,
          stage_id: stageId,
          stage_name: stage?.name || null,
          stage_color: stage?.color || null,
          stage_position: stage?.position ?? null,
        } : l))
        if (detailLead?.id === leadId) {
          setDetailLead(prev => prev ? {
            ...prev,
            stage_id: stageId,
            stage_name: stage?.name || null,
            stage_color: stage?.color || null,
            stage_position: stage?.position ?? null,
          } : null)
        }
      }
    } catch (err) {
      console.error('Failed to update stage:', err)
    }
  }

  const handleUpdateLeadPipeline = async (leadId: string, pipelineId: string) => {
    const token = localStorage.getItem('token')
    // Find first stage of new pipeline
    const newPipeline = pipelines.find(p => p.id === pipelineId)
    // If selecting "Unassigned" (pipelineId is empty string), stage should be null
    const firstStageId = pipelineId ? (newPipeline?.stages?.[0]?.id || null) : null

    try {
      const res = await fetch(`/api/leads/${leadId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          pipeline_id: pipelineId || null,
          stage_id: firstStageId
        }),
      })
      const data = await res.json()
      if (data.success && data.lead) {
        const merged = { ...data.lead, structured_tags: data.lead.structured_tags || detailLead?.structured_tags }
        setDetailLead(merged)
        setLeads(prev => prev.map(l => l.id === data.lead.id ? merged : l))
      }
    } catch (err) {
      console.error('Failed to update pipeline:', err)
    }
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

  const handleSyncKommo = async () => {
    if (!detailLead) return
    setSyncingKommo(true)
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/leads/${detailLead.id}/sync-kommo`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success && data.lead) {
        setDetailLead(data.lead)
        setLeads(prev => prev.map(l => l.id === data.lead.id ? data.lead : l))
        fetchObservations(detailLead.id)
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
          type: newObservationType,
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

  // Drag and drop (using stage_id)
  const handleDragStart = (e: React.DragEvent, leadId: string) => {
    setDraggedLeadId(leadId)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', leadId)
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

  const handleDragOver = (e: React.DragEvent, stageId: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverColumn(stageId)
  }

  const handleDragLeave = () => {
    setDragOverColumn(null)
  }

  const handleDrop = (e: React.DragEvent, targetStageId: string) => {
    e.preventDefault()
    setDragOverColumn(null)
    const leadId = e.dataTransfer.getData('text/plain')
    if (leadId) {
      const lead = leads.find(l => l.id === leadId)
      if (lead && lead.stage_id !== targetStageId) {
        handleUpdateLeadStage(leadId, targetStageId)
      }
    }
    setDraggedLeadId(null)
  }

  // Stage management
  const handleAddStage = async () => {
    if (!activePipeline || !newStageName.trim()) return
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/pipelines/${activePipeline.id}/stages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: newStageName.trim(), color: newStageColor }),
      })
      const data = await res.json()
      if (data.success) {
        setNewStageName('')
        setNewStageColor('#6366f1')
        fetchPipelines()
      }
    } catch (err) {
      console.error('Failed to add stage:', err)
    }
  }

  const handleDeleteStage = async (stageId: string) => {
    if (!activePipeline) return
    if (!confirm('¿Eliminar esta etapa? Los leads en esta etapa quedarán sin etapa asignada.')) return
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/pipelines/${activePipeline.id}/stages/${stageId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        fetchPipelines()
        fetchLeads()
      }
    } catch (err) {
      console.error('Failed to delete stage:', err)
    }
  }

  const handleUpdateStage = async (stageId: string) => {
    if (!activePipeline || !editStageName.trim()) return
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/pipelines/${activePipeline.id}/stages/${stageId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: editStageName.trim(), color: editStageColor }),
      })
      const data = await res.json()
      if (data.success) {
        setEditingStageId(null)
        fetchPipelines()
      }
    } catch (err) {
      console.error('Failed to update stage:', err)
    }
  }

  // WhatsApp internal chat
  const handleSendWhatsApp = async (phone: string) => {
    setWhatsappPhone(phone)
    await fetchDevices()
    setShowDeviceSelector(true)
  }

  const handleDeviceSelected = async (device: Device) => {
    setShowDeviceSelector(false)
    const cleanPhone = whatsappPhone.replace(/[^0-9]/g, '')
    const token = localStorage.getItem('token')
    try {
      const res = await fetch('/api/chats/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ device_id: device.id, phone: cleanPhone }),
      })
      const data = await res.json()
      if (data.success && data.chat) {
        // Open inline chat instead of navigating away
        setInlineChatId(data.chat.id)
        setInlineChat(data.chat)
        setInlineChatDeviceId(device.id)
        setShowInlineChat(true)
      } else {
        alert(data.error || 'Error al crear conversación')
      }
    } catch {
      alert('Error de conexión')
    }
  }

  // Escape key closes modals/panels (topmost first)
  useEffect(() => {
    const handleEscapeKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showDeviceSelector) { setShowDeviceSelector(false); return }
        if (showStageModal) { setShowStageModal(false); return }
        if (showAddModal) { setShowAddModal(false); return }
        if (showEditModal) { setShowEditModal(false); return }
        if (showFilterDropdown) { setShowFilterDropdown(false); return }
        if (showInlineChat) { setShowInlineChat(false); return }
        if (showDetailPanel) { setShowDetailPanel(false); return }
      }
    }
    window.addEventListener('keydown', handleEscapeKey)
    return () => window.removeEventListener('keydown', handleEscapeKey)
  }, [showDeviceSelector, showStageModal, showAddModal, showEditModal, showFilterDropdown, showInlineChat, showDetailPanel])

  const filteredLeads = leads.filter((lead) => {
    const matchesSearch =
      (lead.name || '').toLowerCase().includes(debouncedSearchTerm.toLowerCase()) ||
      (lead.phone || '').toLowerCase().includes(debouncedSearchTerm.toLowerCase()) ||
      (lead.email || '').toLowerCase().includes(debouncedSearchTerm.toLowerCase()) ||
      (lead.company || '').toLowerCase().includes(debouncedSearchTerm.toLowerCase()) ||
      (lead.last_name || '').toLowerCase().includes(debouncedSearchTerm.toLowerCase())
    const matchesPipeline = !activePipeline || lead.pipeline_id === activePipeline.id || !lead.pipeline_id
    const matchesStageFilter = filterStageIds.size === 0 || (lead.stage_id && filterStageIds.has(lead.stage_id))
    const matchesTagFilter = filterTagNames.size === 0 || (lead.structured_tags && lead.structured_tags.some(t => filterTagNames.has(t.name)))
    return matchesSearch && matchesPipeline && matchesStageFilter && matchesTagFilter
  })

  // Collect unique tags from all leads for filter dropdown
  const allUniqueTags = Array.from(
    new Map(leads.flatMap(l => l.structured_tags || []).map(t => [t.name, t])).values()
  ).sort((a, b) => a.name.localeCompare(b.name))

  // Count leads per tag
  const tagLeadCounts = new Map<string, number>()
  leads.forEach(l => {
    (l.structured_tags || []).forEach(t => {
      tagLeadCounts.set(t.name, (tagLeadCounts.get(t.name) || 0) + 1)
    })
  })

  // Filter tags by search term (% = wildcard like Kommo/SQL LIKE)
  const filteredTags = allUniqueTags.filter(tag => {
    if (!tagSearchTerm.trim()) return true
    const term = tagSearchTerm.trim()
    if (term.includes('%')) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')
      try {
        return new RegExp(`^${escaped}$`, 'i').test(tag.name)
      } catch {
        return true
      }
    }
    return tag.name.toLowerCase().includes(term.toLowerCase())
  })

  const activeFilterCount = filterStageIds.size + filterTagNames.size

  // Leads with phone for broadcast
  const broadcastableLeads = filteredLeads.filter(l => l.phone)

  const handleCreateBroadcastFromLeads = async (formResult: CampaignFormResult) => {
    setSubmittingBroadcast(true)
    const token = localStorage.getItem('token')
    try {
      // 1. Create the campaign
      const res = await fetch('/api/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name: formResult.name,
          device_id: formResult.device_id,
          message_template: formResult.message_template,
          attachments: formResult.attachments,
          scheduled_at: formResult.scheduled_at || undefined,
          settings: formResult.settings,
        }),
      })
      const data = await res.json()
      if (!data.success) {
        alert(data.error || 'Error al crear campaña')
        return
      }

      const campaignId = data.campaign?.id
      if (!campaignId) {
        alert('Error: no se recibió el ID de la campaña')
        return
      }

      // 2. Schedule if needed
      if (formResult.scheduled_at) {
        await fetch(`/api/campaigns/${campaignId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ status: 'scheduled', scheduled_at: formResult.scheduled_at }),
        })
      }

      // 3. Add filtered leads as recipients
      const recipientsList = broadcastableLeads.map(lead => {
        const cleanPhone = (lead.phone || '').replace(/[^0-9]/g, '')
        return {
          jid: cleanPhone ? cleanPhone + '@s.whatsapp.net' : '',
          name: lead.name || null,
          phone: cleanPhone,
          metadata: {
            ...(lead.short_name ? { nombre_corto: lead.short_name } : {}),
            ...(lead.company ? { empresa: lead.company } : {}),
          },
        }
      }).filter(r => r.jid)

      if (recipientsList.length > 0) {
        await fetch(`/api/campaigns/${campaignId}/recipients`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ recipients: recipientsList }),
        })
      }

      setShowBroadcastModal(false)
      router.push('/dashboard/broadcasts')
    } catch (err) {
      alert('Error al crear campaña desde leads')
    } finally {
      setSubmittingBroadcast(false)
    }
  }

  // Group leads by stage
  const leadsByStage = stages.map(stage => ({
    ...stage,
    leads: filteredLeads.filter(l => l.stage_id === stage.id),
  }))
  const unassignedLeads = filteredLeads.filter(l => !l.stage_id || !stages.find(s => s.id === l.stage_id))

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-6 w-6 border-2 border-emerald-200 border-t-emerald-600" />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Leads</h1>
          <p className="text-slate-500 text-sm mt-0.5">{filteredLeads.length} leads en total</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {selectionMode ? (
            <>
              <span className="flex items-center px-3 py-1.5 text-xs text-slate-500 font-medium">
                {selectedIds.size} seleccionado(s)
              </span>
              <button onClick={selectAll} className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg hover:bg-slate-50 text-slate-600 font-medium">
                Todos
              </button>
              <button
                onClick={handleDeleteSelected}
                disabled={selectedIds.size === 0 || deleting}
                className="px-3 py-1.5 text-xs bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 font-medium"
              >
                {deleting ? 'Eliminando...' : `Eliminar (${selectedIds.size})`}
              </button>
              <button
                onClick={() => { setSelectionMode(false); setSelectedIds(new Set()) }}
                className="p-1.5 border border-slate-200 rounded-lg hover:bg-slate-50 text-slate-400"
              >
                <XCircle className="w-4 h-4" />
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setSelectionMode(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-slate-200 rounded-lg hover:bg-slate-50 transition text-slate-600 text-xs font-medium"
              >
                <CheckSquare className="w-3.5 h-3.5" />
                Seleccionar
              </button>
              <button
                onClick={() => setShowStageModal(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-slate-200 rounded-lg hover:bg-slate-50 transition text-slate-600 text-xs font-medium"
              >
                <Settings className="w-3.5 h-3.5" />
                Etapas
              </button>
              <button
                onClick={() => setShowImportModal(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-slate-200 rounded-lg hover:bg-slate-50 transition text-slate-600 text-xs font-medium"
              >
                <Upload className="w-3.5 h-3.5" />
                CSV
              </button>
              <button
                onClick={() => { fetchDevices(); setShowBroadcastModal(true) }}
                disabled={filteredLeads.filter(l => l.phone).length === 0}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-emerald-200 rounded-lg hover:bg-emerald-50 transition text-emerald-700 text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Radio className="w-3.5 h-3.5" />
                Masivo
              </button>
              {/* Device filter dropdown */}
              {devices.length > 0 && (
                <div className="relative">
                  <button
                    onClick={() => setShowDeviceFilter(!showDeviceFilter)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 border rounded-lg hover:bg-slate-50 transition text-xs font-medium ${
                      filterDeviceIds.size > 0 ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-600'
                    }`}
                  >
                    <Phone className="w-3.5 h-3.5" />
                    Dispositivos{filterDeviceIds.size > 0 ? ` (${filterDeviceIds.size})` : ''}
                  </button>
                  {showDeviceFilter && (
                    <div className="absolute right-0 top-full mt-1 bg-white border border-slate-200 rounded-xl shadow-xl p-2 z-50 min-w-52">
                      <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider px-2 py-1">Filtrar por dispositivo</p>
                      {devices.map(d => (
                        <label key={d.id} className="flex items-center gap-2 px-2 py-1.5 hover:bg-slate-50 rounded-lg cursor-pointer text-sm">
                          <input
                            type="checkbox"
                            checked={filterDeviceIds.has(d.id)}
                            onChange={() => {
                              setFilterDeviceIds(prev => {
                                const next = new Set(prev)
                                if (next.has(d.id)) next.delete(d.id)
                                else next.add(d.id)
                                return next
                              })
                            }}
                            className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                          />
                          <span className="text-slate-700">{d.name || d.phone || 'Dispositivo'}</span>
                        </label>
                      ))}
                      {filterDeviceIds.size > 0 && (
                        <button
                          onClick={() => setFilterDeviceIds(new Set())}
                          className="w-full mt-1 text-xs text-slate-500 hover:text-slate-700 py-1"
                        >
                          Limpiar filtro
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
              <button
                onClick={() => setShowAddModal(true)}
                className="inline-flex items-center gap-1.5 bg-emerald-600 text-white px-3 py-1.5 rounded-lg hover:bg-emerald-700 transition text-xs font-medium shadow-sm shadow-emerald-600/20"
              >
                <Plus className="w-3.5 h-3.5" />
                Nuevo
              </button>
            </>
          )}
        </div>
      </div>

      {/* Pipeline selector + Search */}
      <div className="flex flex-col sm:flex-row gap-3 mb-3">
        <div ref={filterDropdownRef} className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onFocus={() => setShowFilterDropdown(true)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setShowFilterDropdown(false) } }}
            placeholder="Buscar leads..."
            className="w-full pl-9 pr-10 py-2 bg-white border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 text-slate-800 placeholder:text-slate-400 text-sm"
          />
          <button
            onClick={() => setShowFilterDropdown(!showFilterDropdown)}
            className={`absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-md transition ${activeFilterCount > 0 ? 'bg-green-100 text-green-700' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'}`}
            title="Filtros avanzados"
          >
            <Filter className="w-4 h-4" />
            {activeFilterCount > 0 && (
              <span className="absolute -top-1 -right-1 w-4 h-4 bg-green-600 text-white text-[10px] rounded-full flex items-center justify-center">{activeFilterCount}</span>
            )}
          </button>

          {/* Filter Dropdown */}
          {showFilterDropdown && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-xl shadow-xl z-30 max-h-[400px] overflow-y-auto">
              <div className="p-3 border-b border-gray-100 flex items-center justify-between">
                <span className="text-sm font-semibold text-gray-700">Filtros</span>
                <div className="flex items-center gap-2">
                  {activeFilterCount > 0 && (
                    <button
                      onClick={() => { setFilterStageIds(new Set()); setFilterTagNames(new Set()) }}
                      className="text-xs text-red-500 hover:text-red-700"
                    >
                      Limpiar filtros
                    </button>
                  )}
                  <button onClick={() => setShowFilterDropdown(false)} className="p-0.5 hover:bg-gray-100 rounded">
                    <X className="w-4 h-4 text-gray-400" />
                  </button>
                </div>
              </div>

              {/* Stage filters */}
              {stages.length > 0 && (
                <div className="p-3 border-b border-gray-100">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Etapa</p>
                  <div className="flex flex-wrap gap-1.5">
                    {stages.map(stage => {
                      const isActive = filterStageIds.has(stage.id)
                      return (
                        <button
                          key={stage.id}
                          onClick={() => {
                            const next = new Set(filterStageIds)
                            if (isActive) next.delete(stage.id); else next.add(stage.id)
                            setFilterStageIds(next)
                          }}
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition border ${
                            isActive ? 'border-transparent text-white' : 'border-gray-200 text-gray-700 hover:bg-gray-50'
                          }`}
                          style={isActive ? { backgroundColor: stage.color } : {}}
                        >
                          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: stage.color }} />
                          {stage.name}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Tag filters with search */}
              {allUniqueTags.length > 0 && (
                <div className="p-3">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Etiquetas</p>
                  <div className="relative mb-2">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                    <input
                      type="text"
                      value={tagSearchTerm}
                      onChange={(e) => setTagSearchTerm(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setShowFilterDropdown(false) } }}
                      placeholder="Buscar... (usa % como comodín)"
                      className="w-full pl-8 pr-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-800 placeholder:text-slate-400 focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                    />
                  </div>
                  {filterTagNames.size > 0 && (
                    <div className="flex flex-wrap gap-1 mb-2">
                      {Array.from(filterTagNames).map(name => {
                        const tag = allUniqueTags.find(t => t.name === name)
                        return (
                          <span
                            key={name}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium text-white"
                            style={{ backgroundColor: tag?.color || '#6b7280' }}
                          >
                            {name}
                            <button onClick={() => { const next = new Set(filterTagNames); next.delete(name); setFilterTagNames(next) }} className="hover:opacity-75">
                              <X className="w-2.5 h-2.5" />
                            </button>
                          </span>
                        )
                      })}
                    </div>
                  )}
                  <div className="max-h-[200px] overflow-y-auto space-y-0.5">
                    {filteredTags.map(tag => {
                      const isActive = filterTagNames.has(tag.name)
                      const count = tagLeadCounts.get(tag.name) || 0
                      return (
                        <label
                          key={tag.id}
                          className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-50 cursor-pointer transition"
                        >
                          <input
                            type="checkbox"
                            checked={isActive}
                            onChange={() => {
                              const next = new Set(filterTagNames)
                              if (isActive) next.delete(tag.name); else next.add(tag.name)
                              setFilterTagNames(next)
                            }}
                            className="w-3.5 h-3.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                          />
                          <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: tag.color }} />
                          <span className="flex-1 text-xs text-slate-700">{tag.name}</span>
                          <span className="text-[10px] text-slate-400 tabular-nums">{count}</span>
                        </label>
                      )
                    })}
                    {filteredTags.length === 0 && tagSearchTerm.trim() && (
                      <p className="text-xs text-slate-400 text-center py-2">Sin resultados</p>
                    )}
                  </div>
                </div>
              )}

              {/* Aplicar button */}
              <div className="p-3 border-t border-gray-100 sticky bottom-0 bg-white rounded-b-xl">
                <button
                  onClick={() => setShowFilterDropdown(false)}
                  className="w-full px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition text-sm font-medium"
                >
                  Aplicar
                </button>
              </div>
            </div>
          )}
        </div>
        {pipelines.length > 1 && (
          <div className="relative">
            <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <select
              value={activePipeline?.id || ''}
              onChange={(e) => {
                const p = pipelines.find(p => p.id === e.target.value)
                if (p) setActivePipeline(p)
              }}
              className="pl-9 pr-8 py-2 bg-white border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 appearance-none cursor-pointer text-sm text-slate-900"
            >
              {pipelines.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
          </div>
        )}
      </div>

      {/* Pipeline Kanban */}
      <div className="flex-1 min-h-0 flex flex-col">
      {/* Top synced scrollbar */}
      <div
        ref={topScrollRef}
        onScroll={handleTopScroll}
        className="overflow-x-auto kanban-scroll-top flex-shrink-0"
        style={{ height: 12 }}
      >
        <div style={{ width: `${(stages.length + (unassignedLeads.length > 0 ? 1 : 0)) * 288}px`, height: 1 }} />
      </div>
      <div
        ref={kanbanRef}
        onScroll={handleKanbanScroll}
        className="overflow-x-auto overflow-y-auto flex-1 min-h-0 kanban-scroll"
      >
        <div className="flex gap-3" style={{ minWidth: `${(stages.length + (unassignedLeads.length > 0 ? 1 : 0)) * 288}px` }}>
          {leadsByStage.map((column) => (
            <div key={column.id} className="w-[272px] flex-shrink-0">
              <div
                className="px-3 py-2.5 rounded-t-xl sticky top-0 z-10"
                style={{ background: `linear-gradient(135deg, ${column.color}30, ${column.color}18)`, borderBottom: `3px solid ${column.color}`, boxShadow: `0 2px 8px ${column.color}20` }}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-bold tracking-wide uppercase text-slate-800">{column.name}</span>
                  <span className="text-xs px-2 py-0.5 rounded-full font-bold text-white" style={{ backgroundColor: column.color }}>{column.leads.length}</span>
                </div>
              </div>
              <div
                className={`bg-slate-50/80 p-2 min-h-[200px] space-y-2 transition-colors ${
                  dragOverColumn === column.id ? 'bg-emerald-50 ring-2 ring-emerald-300 ring-inset' : ''
                }`}
                onDragOver={(e) => handleDragOver(e, column.id)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, column.id)}
              >
                {column.leads.map((lead) => (
                  <div
                    key={lead.id}
                    draggable={!selectionMode}
                    onDragStart={(e) => handleDragStart(e, lead.id)}
                    onDragEnd={handleDragEnd}
                    className={`bg-white p-3 rounded-xl shadow-sm border hover:shadow-md transition cursor-pointer ${
                      selectedIds.has(lead.id) ? 'border-emerald-500 ring-2 ring-emerald-100'
                      : detailLead?.id === lead.id ? 'border-emerald-400 ring-2 ring-emerald-200 bg-emerald-50/50'
                      : 'border-slate-100'
                    } ${draggedLeadId === lead.id ? 'opacity-50' : ''} ${!selectionMode ? 'cursor-grab active:cursor-grabbing' : ''}`}
                    onClick={() => selectionMode ? toggleSelection(lead.id) : openDetailPanel(lead)}
                  >
                    <div className="flex items-start justify-between group">
                      <div className="flex items-center gap-2">
                        {selectionMode ? (
                          <button
                            onClick={(e) => { e.stopPropagation(); toggleSelection(lead.id) }}
                            className="p-0.5"
                          >
                            {selectedIds.has(lead.id) ? (
                              <CheckSquare className="w-4 h-4 text-emerald-600" />
                            ) : (
                              <Square className="w-4 h-4 text-slate-300" />
                            )}
                          </button>
                        ) : (
                          <div className="w-7 h-7 bg-emerald-50 rounded-full flex items-center justify-center">
                            <span className="text-emerald-700 text-xs font-semibold">
                              {(lead.name || '?').charAt(0).toUpperCase()}
                            </span>
                          </div>
                        )}
                        <p className="text-[13px] font-medium text-slate-900 truncate max-w-[150px]">
                          {lead.name || 'Sin nombre'}
                        </p>
                      </div>
                      {!selectionMode && (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDeleteLead(lead.id) }}
                          className="p-1 text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                    {lead.phone && (
                      <div className="flex items-center gap-1.5 mt-1.5 text-xs text-slate-500">
                        <Phone className="w-3 h-3" />
                        {lead.phone}
                      </div>
                    )}
                    {lead.email && (
                      <div className="flex items-center gap-1.5 mt-1 text-xs text-slate-500">
                        <Mail className="w-3 h-3" />
                        <span className="truncate max-w-[180px]">{lead.email}</span>
                      </div>
                    )}
                    {lead.company && (
                      <div className="flex items-center gap-1.5 mt-1 text-xs text-slate-400">
                        <Building2 className="w-3 h-3" />
                        <span className="truncate max-w-[180px]">{lead.company}</span>
                      </div>
                    )}
                    {lead.structured_tags && lead.structured_tags.length > 0 ? (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {lead.structured_tags.slice(0, 3).map((tag) => (
                          <span
                            key={tag.id}
                            className="px-1.5 py-0.5 text-[10px] rounded-full text-white font-medium"
                            style={{ backgroundColor: tag.color || '#6b7280' }}
                          >
                            {tag.name}
                          </span>
                        ))}
                        {lead.structured_tags.length > 3 && (
                          <span className="px-1.5 py-0.5 text-slate-400 text-[10px]">
                            +{lead.structured_tags.length - 3}
                          </span>
                        )}
                      </div>
                    ) : lead.tags && lead.tags.length > 0 ? (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {lead.tags.slice(0, 2).map((tag, i) => (
                          <span key={i} className="px-1.5 py-0.5 bg-slate-100 text-slate-500 text-[10px] rounded-full">
                            {tag}
                          </span>
                        ))}
                        {lead.tags.length > 2 && (
                          <span className="px-1.5 py-0.5 text-slate-400 text-[10px]">+{lead.tags.length - 2}</span>
                        )}
                      </div>
                    ) : null}
                    <div className="flex items-center justify-between mt-2 text-[10px] text-slate-400">
                      <span>{formatDistanceToNow(new Date(lead.created_at), { locale: es })}</span>
                      <MessageCircle className="w-3 h-3" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {/* Unassigned column */}
          {unassignedLeads.length > 0 && (
            <div className="w-[272px] flex-shrink-0">
              <div className="px-3 py-2.5 rounded-t-xl sticky top-0 z-10" style={{ background: 'linear-gradient(135deg, rgba(100,116,139,0.2), rgba(100,116,139,0.1))', borderBottom: '3px solid #64748b', boxShadow: '0 2px 8px rgba(100,116,139,0.15)' }}>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-bold tracking-wide uppercase text-slate-800">Sin etapa</span>
                  <span className="text-xs px-2 py-0.5 rounded-full font-bold text-white bg-slate-500">{unassignedLeads.length}</span>
                </div>
              </div>
              <div className="bg-slate-50/80 p-2 min-h-[200px] space-y-2">
                {unassignedLeads.map((lead) => (
                  <div
                    key={lead.id}
                    draggable={!selectionMode}
                    onDragStart={(e) => handleDragStart(e, lead.id)}
                    onDragEnd={handleDragEnd}
                    className={`bg-white p-3 rounded-xl shadow-sm border hover:shadow-md transition cursor-pointer ${
                      detailLead?.id === lead.id ? 'border-emerald-400 ring-2 ring-emerald-200 bg-emerald-50/50' : 'border-slate-100'
                    }`}
                    onClick={() => selectionMode ? toggleSelection(lead.id) : openDetailPanel(lead)}
                  >
                    <p className="text-[13px] font-medium text-slate-900 truncate">{lead.name || 'Sin nombre'}</p>
                    {lead.phone && (
                      <div className="flex items-center gap-1.5 mt-1 text-xs text-slate-500">
                        <Phone className="w-3 h-3" />{lead.phone}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      </div>

      {/* Add Lead Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-md border border-slate-100">
            <h2 className="text-lg font-semibold text-slate-900 mb-4">Nuevo Lead</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Nombre *</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 text-sm text-slate-900 placeholder:text-slate-400"
                  placeholder="Nombre del lead"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Teléfono</label>
                <input
                  type="tel"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 text-sm text-slate-900 placeholder:text-slate-400"
                  placeholder="+51 999 888 777"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Email</label>
                <input
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 text-sm text-slate-900 placeholder:text-slate-400"
                  placeholder="correo@ejemplo.com"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Etiquetas</label>
                <input
                  type="text"
                  value={formData.tags}
                  onChange={(e) => setFormData({ ...formData, tags: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 text-sm text-slate-900 placeholder:text-slate-400"
                  placeholder="ventas, premium (separadas por coma)"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Notas</label>
                <textarea
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  rows={3}
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 text-sm text-slate-900 placeholder:text-slate-400 resize-none"
                  placeholder="Notas adicionales..."
                />
              </div>
            </div>
            <div className="flex gap-3 mt-5">
              <button
                onClick={() => { setShowAddModal(false); setFormData({ name: '', phone: '', email: '', notes: '', tags: '' }) }}
                className="flex-1 px-4 py-2 border border-slate-200 text-slate-600 rounded-xl hover:bg-slate-50 text-sm"
              >
                Cancelar
              </button>
              <button
                onClick={handleCreateLead}
                disabled={!formData.name}
                className="flex-1 px-4 py-2 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 disabled:opacity-50 text-sm font-medium shadow-sm"
              >
                Crear Lead
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Stage Management Modal */}
      {showStageModal && activePipeline && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-md max-h-[85vh] overflow-y-auto border border-gray-100">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Gestionar Etapas</h2>
                <p className="text-sm text-gray-500 mt-0.5">{activePipeline.name}</p>
              </div>
              <button onClick={() => setShowStageModal(false)} className="p-1.5 hover:bg-gray-100 rounded-lg transition">
                <X className="w-5 h-5 text-gray-400" />
              </button>
            </div>

            {/* Current stages with drag reorder */}
            <div className="space-y-1.5 mb-5">
              {allStages.map((stage, idx) => (
                <div
                  key={stage.id}
                  draggable={editingStageId !== stage.id}
                  onDragStart={() => setDragSrcIdx(idx)}
                  onDragOver={(e) => { e.preventDefault(); setDragOverIdx(idx) }}
                  onDragEnd={() => { if (dragSrcIdx !== null && dragOverIdx !== null) handleReorderStages(dragSrcIdx, dragOverIdx); setDragSrcIdx(null); setDragOverIdx(null) }}
                  className={`p-2.5 rounded-xl transition-all ${
                    dragOverIdx === idx ? 'bg-green-50 ring-2 ring-green-300' : 'bg-gray-50 hover:bg-gray-100'
                  } ${hiddenStageIds.has(stage.id) ? 'opacity-50' : ''}`}
                >
                  {editingStageId === stage.id ? (
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={editStageColor}
                        onChange={(e) => setEditStageColor(e.target.value)}
                        className="w-8 h-8 rounded border border-gray-300 cursor-pointer shrink-0"
                      />
                      <input
                        type="text"
                        value={editStageName}
                        onChange={(e) => setEditStageName(e.target.value)}
                        className="flex-1 px-2 py-1 border border-gray-300 rounded-lg text-sm text-gray-900 focus:ring-2 focus:ring-green-500"
                        onKeyDown={(e) => e.key === 'Enter' && handleUpdateStage(stage.id)}
                      />
                      <button onClick={() => handleUpdateStage(stage.id)} className="px-2.5 py-1 bg-green-600 text-white rounded-lg text-xs hover:bg-green-700">
                        Guardar
                      </button>
                      <button onClick={() => setEditingStageId(null)} className="p-1 text-gray-400 hover:text-gray-600">
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <GripVertical className="w-4 h-4 text-gray-300 cursor-grab shrink-0" />
                      <div className="w-3.5 h-3.5 rounded-full shrink-0" style={{ backgroundColor: stage.color }} />
                      <span className="flex-1 text-sm font-medium text-gray-800 truncate">{stage.name}</span>
                      <span className="text-xs text-gray-400 shrink-0">{stage.lead_count}</span>
                      <button
                        onClick={() => toggleStageVisibility(stage.id)}
                        className="p-1 text-gray-400 hover:text-gray-600"
                        title={hiddenStageIds.has(stage.id) ? 'Mostrar etapa' : 'Ocultar etapa'}
                      >
                        {hiddenStageIds.has(stage.id) ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                      <button
                        onClick={() => { setEditingStageId(stage.id); setEditStageName(stage.name); setEditStageColor(stage.color) }}
                        className="p-1 text-gray-400 hover:text-blue-500"
                        title="Editar"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleDeleteStage(stage.id)}
                        className="p-1 text-gray-400 hover:text-red-500"
                        title="Eliminar"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Add new stage */}
            <div className="border-t border-gray-200 pt-4">
              <h4 className="text-sm font-semibold text-gray-700 mb-3">Agregar nueva etapa</h4>
              <div className="flex gap-2">
                <input
                  type="color"
                  value={newStageColor}
                  onChange={(e) => setNewStageColor(e.target.value)}
                  className="w-10 h-10 rounded-lg border border-gray-300 cursor-pointer"
                />
                <input
                  type="text"
                  value={newStageName}
                  onChange={(e) => setNewStageName(e.target.value)}
                  placeholder="Nombre de la etapa"
                  className="flex-1 px-3 py-2 border border-gray-200 rounded-xl text-sm text-gray-900 placeholder:text-gray-400 focus:ring-2 focus:ring-green-500"
                  onKeyDown={(e) => e.key === 'Enter' && handleAddStage()}
                />
                <button
                  onClick={handleAddStage}
                  disabled={!newStageName.trim()}
                  className="px-4 py-2 bg-green-600 text-white rounded-xl hover:bg-green-700 disabled:opacity-50 text-sm font-medium"
                >
                  Agregar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Lead Detail Panel (Slide-over) with Inline Chat */}
      {(showDetailPanel || showInlineChat) && detailLead && (
        <div className="fixed inset-0 z-50 flex justify-end overflow-hidden">
          <div
            className="absolute inset-0 bg-black/30 backdrop-blur-[2px]"
            onClick={() => { setShowDetailPanel(false); setShowInlineChat(false); setNewObservation(''); setEditingField(null); setEditingNotes(false) }}
          />
          <div className={`relative h-full bg-white shadow-2xl flex transition-all duration-300 border-l border-slate-200 ${showInlineChat ? 'w-[85vw] max-w-6xl' : 'w-full max-w-md'}`}>

            {/* Chat Panel - Left Side */}
            {showInlineChat && inlineChatId && (
              <div className="flex-1 min-w-0 border-r border-slate-200 flex flex-col h-full bg-slate-50/50">
                <ChatPanel
                  chatId={inlineChatId}
                  deviceId={inlineChatDeviceId}
                  initialChat={inlineChat || undefined}
                  onClose={() => setShowInlineChat(false)}
                  className="h-full"
                />
              </div>
            )}

            {/* Lead Details - Right Side */}
            <div className={`${showInlineChat ? 'w-[360px] shrink-0' : 'w-full'} flex flex-col h-full bg-white`}>
              <LeadDetailPanel
                lead={detailLead}
                onLeadChange={(updatedLead: Lead) => {
                  setDetailLead(updatedLead as any)
                  setLeads(prev => prev.map(l => l.id === updatedLead.id ? updatedLead as any : l))
                }}
                onClose={() => { setShowDetailPanel(false); setShowInlineChat(false) }}
                onSendWhatsApp={(phone: string) => handleSendWhatsApp(phone)}
                onDelete={(leadId: string) => {
                  setLeads(prev => prev.filter(l => l.id !== leadId))
                  setShowDetailPanel(false)
                  setShowInlineChat(false)
                }}
                hideWhatsApp={showInlineChat}
              />

            </div>
          </div>
        </div>
      )}

      {/* Device Selector Modal for WhatsApp */}
      {showDeviceSelector && (

        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-[60] p-4">
          <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm border border-slate-100">
            <h2 className="text-sm font-semibold text-slate-900 mb-3">Seleccionar dispositivo</h2>
            <p className="text-xs text-slate-500 mb-4">Elige el dispositivo para enviar el mensaje a {whatsappPhone}</p>
            {devices.length === 0 ? (
              <p className="text-xs text-slate-400 text-center py-4">No hay dispositivos conectados</p>
            ) : (
              <div className="space-y-2">
                {devices.map((device) => (
                  <button
                    key={device.id}
                    onClick={() => handleDeviceSelected(device)}
                    className="w-full flex items-center gap-3 p-3 border border-slate-100 rounded-xl hover:bg-emerald-50 hover:border-emerald-200 transition text-left"
                  >
                    <div className="w-9 h-9 bg-emerald-50 rounded-full flex items-center justify-center">
                      <Phone className="w-4 h-4 text-emerald-600" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-slate-900">{device.name || 'Dispositivo'}</p>
                      <p className="text-xs text-slate-500">{device.phone || device.jid}</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
            <button onClick={() => setShowDeviceSelector(false)} className="w-full mt-4 px-4 py-2 border border-slate-200 text-slate-600 rounded-xl hover:bg-slate-50 text-sm">
              Cancelar
            </button>
          </div>
        </div>
      )}



      <ImportCSVModal
        open={showImportModal}
        onClose={() => setShowImportModal(false)}
        onSuccess={() => { fetchLeads(); fetchPipelines() }}
        defaultType="leads"
      />

      {/* Broadcast from Leads Modal */}
      <CreateCampaignModal
        open={showBroadcastModal}
        onClose={() => setShowBroadcastModal(false)}
        onSubmit={handleCreateBroadcastFromLeads}
        devices={devices}
        submitting={submittingBroadcast}
        title="Envío Masivo desde Leads"
        subtitle={`Se incluirán ${broadcastableLeads.length} leads con teléfono`}
        submitLabel={submittingBroadcast ? 'Creando...' : 'Crear y agregar destinatarios'}
        initialName={`Leads - ${new Date().toLocaleDateString('es-PE', { day: 'numeric', month: 'short' })}`}
        infoPanel={
          <div className="bg-emerald-50 border border-emerald-100 rounded-xl p-3 text-xs text-emerald-800">
            <div className="flex items-center gap-2 mb-1">
              <Radio className="w-3.5 h-3.5 text-emerald-600" />
              <span className="font-medium">Destinatarios desde Leads</span>
            </div>
            <p className="text-emerald-600">
              Se agregarán automáticamente <strong>{broadcastableLeads.length}</strong> leads
              {filterStageIds.size > 0 || filterTagNames.size > 0 || debouncedSearchTerm
                ? ' (filtrados)' : ''} como destinatarios de esta campaña.
            </p>
            {filteredLeads.length !== broadcastableLeads.length && (
              <p className="text-amber-600 mt-1">
                {filteredLeads.length - broadcastableLeads.length} lead(s) sin teléfono serán excluidos.
              </p>
            )}
          </div>
        }
      />
    </div>
  )
}
