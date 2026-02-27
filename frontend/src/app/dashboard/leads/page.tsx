'use client'

import { useEffect, useState, useCallback, useRef, useMemo, memo } from 'react'
import { Search, Plus, Phone, Mail, User, Tag, Calendar, MoreVertical, MoreHorizontal, MessageCircle, Trash2, Edit, ChevronDown, ChevronLeft, ChevronRight, Filter, CheckSquare, Square, XCircle, Clock, FileText, X, Maximize2, Upload, Building2, Save, Edit2, Settings, Pencil, Eye, EyeOff, GripVertical, RefreshCw, Radio, LayoutGrid, List, ChevronUp } from 'lucide-react'
import { formatDistanceToNow, format } from 'date-fns'
import { es } from 'date-fns/locale'
import { useVirtualizer } from '@tanstack/react-virtual'
import ImportCSVModal from '@/components/ImportCSVModal'
import TagInput from '@/components/TagInput'
import CreateCampaignModal, { CampaignFormResult } from '@/components/CreateCampaignModal'
import { useRouter } from 'next/navigation'
import { subscribeWebSocket } from '@/lib/api'
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

interface StageData {
  id: string
  pipeline_id: string
  name: string
  color: string
  position: number
  total_count: number
  leads: Lead[]
  has_more: boolean
}

interface TagInfo {
  name: string
  color: string
  count: number
}

// --- Memoized LeadCard component (avoids re-rendering all cards on any state change) ---
interface LeadCardProps {
  lead: Lead
  isSelected: boolean
  isDetailActive: boolean
  isDragged: boolean
  selectionMode: boolean
  onToggleSelection: (id: string) => void
  onOpenDetail: (lead: Lead) => void
  onDelete: (id: string) => void
  onDragStart: (e: React.DragEvent, id: string) => void
  onDragEnd: (e: React.DragEvent) => void
}

const LeadCard = memo(function LeadCard({
  lead, isSelected, isDetailActive, isDragged, selectionMode,
  onToggleSelection, onOpenDetail, onDelete, onDragStart, onDragEnd,
}: LeadCardProps) {
  return (
    <div
      draggable={!selectionMode}
      onDragStart={(e) => onDragStart(e, lead.id)}
      onDragEnd={onDragEnd}
      className={`bg-white p-3 rounded-xl shadow-sm border hover:shadow-md transition cursor-pointer ${
        isSelected ? 'border-emerald-500 ring-2 ring-emerald-100'
        : isDetailActive ? 'border-emerald-400 ring-2 ring-emerald-200 bg-emerald-50/50'
        : 'border-slate-100'
      } ${isDragged ? 'opacity-50' : ''} ${!selectionMode ? 'cursor-grab active:cursor-grabbing' : ''}`}
      onClick={() => selectionMode ? onToggleSelection(lead.id) : onOpenDetail(lead)}
    >
      <div className="flex items-start justify-between group">
        <div className="flex items-center gap-2">
          {selectionMode ? (
            <button onClick={(e) => { e.stopPropagation(); onToggleSelection(lead.id) }} className="p-0.5">
              {isSelected ? <CheckSquare className="w-4 h-4 text-emerald-600" /> : <Square className="w-4 h-4 text-slate-300" />}
            </button>
          ) : (
            <div className="w-7 h-7 bg-emerald-50 rounded-full flex items-center justify-center">
              <span className="text-emerald-700 text-xs font-semibold">{(lead.name || '?').charAt(0).toUpperCase()}</span>
            </div>
          )}
          <p className="text-[13px] font-medium text-slate-900 truncate max-w-[150px]">{lead.name || 'Sin nombre'}</p>
          {lead.kommo_id && (
            <span title={`Vinculado a Kommo #${lead.kommo_id}`} className="flex-shrink-0 flex items-center gap-0.5 px-1.5 py-0.5 bg-emerald-50 rounded-full text-[10px] font-medium text-emerald-600 leading-none">
              <RefreshCw className="w-2.5 h-2.5" />K
            </span>
          )}
        </div>
        {!selectionMode && (
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(lead.id) }}
            className="p-1 text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      {lead.phone && (
        <div className="flex items-center gap-1.5 mt-1.5 text-xs text-slate-500"><Phone className="w-3 h-3" />{lead.phone}</div>
      )}
      {lead.email && (
        <div className="flex items-center gap-1.5 mt-1 text-xs text-slate-500"><Mail className="w-3 h-3" /><span className="truncate max-w-[180px]">{lead.email}</span></div>
      )}
      {lead.company && (
        <div className="flex items-center gap-1.5 mt-1 text-xs text-slate-400"><Building2 className="w-3 h-3" /><span className="truncate max-w-[180px]">{lead.company}</span></div>
      )}
      {lead.structured_tags && lead.structured_tags.length > 0 ? (
        <div className="flex flex-wrap gap-1 mt-2">
          {lead.structured_tags.slice(0, 3).map((tag) => (
            <span key={tag.id} className="px-1.5 py-0.5 text-[10px] rounded-full text-white font-medium" style={{ backgroundColor: tag.color || '#6b7280' }}>{tag.name}</span>
          ))}
          {lead.structured_tags.length > 3 && <span className="px-1.5 py-0.5 text-slate-400 text-[10px]">+{lead.structured_tags.length - 3}</span>}
        </div>
      ) : lead.tags && lead.tags.length > 0 ? (
        <div className="flex flex-wrap gap-1 mt-2">
          {lead.tags.slice(0, 2).map((tag, i) => <span key={i} className="px-1.5 py-0.5 bg-slate-100 text-slate-500 text-[10px] rounded-full">{tag}</span>)}
          {lead.tags.length > 2 && <span className="px-1.5 py-0.5 text-slate-400 text-[10px]">+{lead.tags.length - 2}</span>}
        </div>
      ) : null}
      <div className="flex items-center justify-between mt-2 text-[10px] text-slate-400">
        <span>{formatDistanceToNow(new Date(lead.created_at), { locale: es })}</span>
        <MessageCircle className="w-3 h-3" />
      </div>
    </div>
  )
})

// --- Virtualized Kanban Column with Infinite Scroll ---
interface VirtualColumnProps {
  column: { id: string; name: string; color: string; leads: Lead[] }
  totalCount: number
  hasMore: boolean
  loadingMore: boolean
  onLoadMore: () => void
  selectedIds: Set<string>
  detailLeadId: string | null
  draggedLeadId: string | null
  dragOverColumn: string | null
  selectionMode: boolean
  onToggleSelection: (id: string) => void
  onOpenDetail: (lead: Lead) => void
  onDelete: (id: string) => void
  onDragStart: (e: React.DragEvent, id: string) => void
  onDragEnd: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent, stageId: string) => void
  onDragLeave: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent, stageId: string) => void
}

const VirtualKanbanColumn = memo(function VirtualKanbanColumn({
  column, totalCount, hasMore, loadingMore, onLoadMore,
  selectedIds, detailLeadId, draggedLeadId, dragOverColumn, selectionMode,
  onToggleSelection, onOpenDetail, onDelete, onDragStart, onDragEnd, onDragOver, onDragLeave, onDrop,
}: VirtualColumnProps) {
  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: column.leads.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 120,
    overscan: 5,
  })

  // Infinite scroll: load more when near bottom
  useEffect(() => {
    const el = parentRef.current
    if (!el || !hasMore || loadingMore) return
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = el
      if (scrollHeight - scrollTop - clientHeight < 300) {
        onLoadMore()
      }
    }
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [hasMore, loadingMore, onLoadMore])

  return (
    <div className="w-[272px] flex-shrink-0 flex flex-col" style={{ maxHeight: '100%' }}>
      <div
        className="px-3 py-2.5 rounded-t-xl sticky top-0 z-10 shrink-0"
        style={{ background: `linear-gradient(135deg, ${column.color}30, ${column.color}18)`, borderBottom: `3px solid ${column.color}`, boxShadow: `0 2px 8px ${column.color}20` }}
      >
        <div className="flex items-center justify-between">
          <span className="text-sm font-bold tracking-wide uppercase text-slate-800">{column.name}</span>
          <div className="flex items-center gap-1.5">
            {column.leads.length < totalCount && (
              <span className="text-[10px] text-slate-500 font-medium tabular-nums">{column.leads.length}/</span>
            )}
            <span className="text-xs px-2 py-0.5 rounded-full font-bold text-white tabular-nums" style={{ backgroundColor: column.color }}>{totalCount}</span>
          </div>
        </div>
      </div>
      <div
        ref={parentRef}
        className={`bg-slate-50/80 p-2 flex-1 overflow-y-auto kanban-col-scroll transition-colors ${
          dragOverColumn === column.id ? 'bg-emerald-50 ring-2 ring-emerald-300 ring-inset' : ''
        }`}
        style={{ minHeight: 200 }}
        onDragOver={(e) => onDragOver(e, column.id)}
        onDragLeave={onDragLeave}
        onDrop={(e) => onDrop(e, column.id)}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const lead = column.leads[virtualItem.index]
            return (
              <div
                key={lead.id}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualItem.start}px)`,
                }}
              >
                <div className="pb-2">
                  <LeadCard
                    lead={lead}
                    isSelected={selectedIds.has(lead.id)}
                    isDetailActive={detailLeadId === lead.id}
                    isDragged={draggedLeadId === lead.id}
                    selectionMode={selectionMode}
                    onToggleSelection={onToggleSelection}
                    onOpenDetail={onOpenDetail}
                    onDelete={onDelete}
                    onDragStart={onDragStart}
                    onDragEnd={onDragEnd}
                  />
                </div>
              </div>
            )
          })}
        </div>
        {loadingMore && (
          <div className="flex items-center justify-center py-3">
            <div className="animate-spin rounded-full h-5 w-5 border-2 border-slate-200 border-t-emerald-500" />
          </div>
        )}
        {!hasMore && column.leads.length > 0 && column.leads.length >= totalCount && totalCount > 50 && (
          <p className="text-center text-[10px] text-slate-400 py-2">Todos cargados</p>
        )}
      </div>
    </div>
  )
})

export default function LeadsPage() {
  const router = useRouter()
  // Server-side paginated data
  const [stageData, setStageData] = useState<StageData[]>([])
  const [unassignedData, setUnassignedData] = useState<{ total_count: number; leads: Lead[]; has_more: boolean }>({ total_count: 0, leads: [], has_more: false })
  const [allTags, setAllTags] = useState<TagInfo[]>([])
  const [loadingMoreStages, setLoadingMoreStages] = useState<Set<string>>(new Set())
  const [pipelines, setPipelines] = useState<Pipeline[]>([])
  const [activePipeline, setActivePipeline] = useState<Pipeline | null>(null)
  const [pipelinesLoaded, setPipelinesLoaded] = useState(false)
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

  // View mode: kanban vs list
  const [viewMode, setViewMode] = useState<'kanban' | 'list'>('kanban')

  // List view paginated data
  const [listLeads, setListLeads] = useState<Lead[]>([])
  const [listTotal, setListTotal] = useState(0)
  const [listHasMore, setListHasMore] = useState(false)
  const [listLoading, setListLoading] = useState(false)

  // "Más" dropdown menu
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const moreMenuRef = useRef<HTMLDivElement>(null)

  // List view observations cache
  const [listObservations, setListObservations] = useState<Map<string, Observation[]>>(new Map())
  const [loadingListObs, setLoadingListObs] = useState<Set<string>>(new Set())
  const [expandedListLeadId, setExpandedListLeadId] = useState<string | null>(null)

  const kanbanRef = useRef<HTMLDivElement>(null)
  const topScrollRef = useRef<HTMLDivElement>(null)
  const listScrollRef = useRef<HTMLDivElement>(null)
  const listOffsetRef = useRef(0)
  const filterDropdownRef = useRef<HTMLDivElement>(null)
  const syncingScroll = useRef(false)

  // Click outside to close dropdowns
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (filterDropdownRef.current && !filterDropdownRef.current.contains(event.target as Node)) {
        setShowFilterDropdown(false)
      }
      if (moreMenuRef.current && !moreMenuRef.current.contains(event.target as Node)) {
        setShowMoreMenu(false)
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
      if (data.success && data.pipelines && data.pipelines.length > 0) {
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
      } else {
        setPipelines([])
      }
    } catch (err) {
      console.error('Failed to fetch pipelines:', err)
    } finally {
      setPipelinesLoaded(true)
    }
  }, [])

  const fetchLeadsPaginated = useCallback(async () => {
    const token = localStorage.getItem('token')
    try {
      const params = new URLSearchParams()
      if (activePipeline) params.set('pipeline_id', activePipeline.id)
      params.set('per_stage', '50')
      if (debouncedSearchTerm) params.set('search', debouncedSearchTerm)
      if (filterTagNames.size > 0) params.set('tag_names', Array.from(filterTagNames).join(','))
      if (filterStageIds.size > 0) params.set('stage_ids', Array.from(filterStageIds).join(','))
      filterDeviceIds.forEach(id => params.append('device_ids', id))
      const res = await fetch(`/api/leads/paginated?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        setStageData((data.stages || []).map((s: StageData) => ({ ...s, leads: s.leads || [] })))
        const ua = data.unassigned || { total_count: 0, leads: [], has_more: false }
        setUnassignedData({ ...ua, leads: ua.leads || [] })
        setAllTags(data.all_tags || [])
      }
    } catch (err) {
      console.error('Failed to fetch leads:', err)
    } finally {
      setLoading(false)
    }
  }, [activePipeline, debouncedSearchTerm, filterTagNames, filterStageIds, filterDeviceIds])

  const fetchListLeads = useCallback(async (reset: boolean = false) => {
    setListLoading(true)
    const offset = reset ? 0 : listOffsetRef.current
    const token = localStorage.getItem('token')
    try {
      const params = new URLSearchParams()
      if (activePipeline) params.set('pipeline_id', activePipeline.id)
      params.set('offset', String(offset))
      params.set('limit', '100')
      if (debouncedSearchTerm) params.set('search', debouncedSearchTerm)
      if (filterTagNames.size > 0) params.set('tag_names', Array.from(filterTagNames).join(','))
      if (filterStageIds.size > 0) params.set('stage_ids', Array.from(filterStageIds).join(','))
      filterDeviceIds.forEach(id => params.append('device_ids', id))
      const res = await fetch(`/api/leads/list-paginated?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        const newLeads = data.leads || []
        if (reset) {
          setListLeads(newLeads)
          listOffsetRef.current = newLeads.length
        } else {
          setListLeads(prev => [...prev, ...newLeads])
          listOffsetRef.current = offset + newLeads.length
        }
        setListTotal(data.total || 0)
        setListHasMore(data.has_more || false)
      }
    } catch (err) {
      console.error('Failed to fetch list leads:', err)
    } finally {
      setListLoading(false)
    }
  }, [activePipeline, debouncedSearchTerm, filterTagNames, filterStageIds, filterDeviceIds])

  const loadMoreForStage = useCallback(async (stageId: string) => {
    if (loadingMoreStages.has(stageId)) return
    setLoadingMoreStages(prev => new Set(prev).add(stageId))
    const token = localStorage.getItem('token')
    try {
      const isUnassigned = stageId === '__unassigned__'
      const currentLeads = isUnassigned
        ? unassignedData.leads
        : stageData.find(s => s.id === stageId)?.leads || []
      const params = new URLSearchParams()
      params.set('offset', String(currentLeads.length))
      params.set('limit', '50')
      if (activePipeline) params.set('pipeline_id', activePipeline.id)
      if (debouncedSearchTerm) params.set('search', debouncedSearchTerm)
      if (filterTagNames.size > 0) params.set('tag_names', Array.from(filterTagNames).join(','))
      filterDeviceIds.forEach(id => params.append('device_ids', id))
      const endpoint = isUnassigned ? 'unassigned' : stageId
      const res = await fetch(`/api/leads/by-stage/${endpoint}?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        const newLeads = data.leads || []
        if (isUnassigned) {
          setUnassignedData(prev => ({ ...prev, leads: [...prev.leads, ...newLeads], has_more: data.has_more }))
        } else {
          setStageData(prev => prev.map(s => s.id === stageId ? { ...s, leads: [...s.leads, ...newLeads], has_more: data.has_more } : s))
        }
      }
    } catch (err) {
      console.error('Failed to load more leads:', err)
    } finally {
      setLoadingMoreStages(prev => { const next = new Set(prev); next.delete(stageId); return next })
    }
  }, [loadingMoreStages, stageData, unassignedData, activePipeline, debouncedSearchTerm, filterTagNames, filterDeviceIds])

  // Helper: update a single lead across all stage data
  const updateLeadInStages = useCallback((leadId: string, updater: (lead: Lead) => Lead) => {
    setStageData(prev => prev.map(stage => ({
      ...stage,
      leads: stage.leads.map(l => l.id === leadId ? updater(l) : l)
    })))
    setUnassignedData(prev => ({
      ...prev,
      leads: prev.leads.map(l => l.id === leadId ? updater(l) : l)
    }))
    setListLeads(prev => prev.map(l => l.id === leadId ? updater(l) : l))
  }, [])

  // Helper: remove lead from all stage data
  const removeLeadFromStages = useCallback((leadId: string) => {
    setStageData(prev => prev.map(stage => ({
      ...stage,
      leads: stage.leads.filter(l => l.id !== leadId),
      total_count: stage.leads.some(l => l.id === leadId) ? stage.total_count - 1 : stage.total_count
    })))
    setUnassignedData(prev => ({
      ...prev,
      leads: prev.leads.filter(l => l.id !== leadId),
      total_count: prev.leads.some(l => l.id === leadId) ? prev.total_count - 1 : prev.total_count
    }))
    setListLeads(prev => prev.filter(l => l.id !== leadId))
  }, [])

  // All loaded leads from visible stages
  const allLoadedLeads = useMemo(() => {
    const all: Lead[] = []
    stageData.forEach(s => all.push(...(s.leads || [])))
    all.push(...(unassignedData.leads || []))
    return all
  }, [stageData, unassignedData])

  // Find lead by ID across all loaded data
  const findLeadById = useCallback((leadId: string): Lead | undefined => {
    for (const stage of stageData) {
      const found = (stage.leads || []).find(l => l.id === leadId)
      if (found) return found
    }
    return (unassignedData.leads || []).find(l => l.id === leadId)
  }, [stageData, unassignedData])

  // Total count from server (all matching leads, not just loaded)
  const totalLeadCount = useMemo(() =>
    stageData.reduce((sum, s) => sum + s.total_count, 0) + unassignedData.total_count,
    [stageData, unassignedData]
  )

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
    fetchDevices()
    // Load hidden stages from localStorage
    try {
      const saved = localStorage.getItem('hiddenStageIds')
      if (saved) setHiddenStageIds(new Set(JSON.parse(saved)))
    } catch {}
  }, [fetchPipelines])

  // Fetch paginated kanban data when pipelines loaded or pipeline/filters change
  useEffect(() => {
    if (pipelinesLoaded) {
      fetchLeadsPaginated()
    }
  }, [pipelinesLoaded, fetchLeadsPaginated])

  // Fetch list data when in list view (and when filters change)
  useEffect(() => {
    if (viewMode === 'list' && pipelinesLoaded) {
      fetchListLeads(true)
    }
  }, [viewMode, fetchListLeads, pipelinesLoaded])

  // WebSocket: listen for lead_update events — delta updates for paginated data
  useEffect(() => {
    const unsubscribe = subscribeWebSocket((data: unknown) => {
      const msg = data as { event?: string; action?: string; lead?: Lead; lead_id?: string; stage_id?: string }
      if (msg.event === 'lead_update') {
        if (msg.action === 'created' && msg.lead) {
          const lead = msg.lead!
          // Add to appropriate stage if it matches current pipeline
          if (lead.pipeline_id === activePipeline?.id) {
            if (lead.stage_id) {
              setStageData(prev => prev.map(s => s.id === lead.stage_id
                ? { ...s, leads: [lead, ...s.leads], total_count: s.total_count + 1 }
                : s
              ))
            } else {
              setUnassignedData(prev => ({
                ...prev,
                leads: [lead, ...prev.leads],
                total_count: prev.total_count + 1
              }))
            }
          } else if (!lead.pipeline_id) {
            setUnassignedData(prev => ({
              ...prev,
              leads: [lead, ...prev.leads],
              total_count: prev.total_count + 1
            }))
          }
        } else if (msg.action === 'updated' && msg.lead) {
          updateLeadInStages(msg.lead.id, l => ({ ...l, ...msg.lead! }))
          if (detailLead?.id === msg.lead.id) {
            setDetailLead(prev => prev ? { ...prev, ...msg.lead! } : prev)
          }
        } else if (msg.action === 'deleted' && msg.lead) {
          removeLeadFromStages(msg.lead.id)
          if (detailLead?.id === msg.lead.id) {
            setShowDetailPanel(false)
          }
        } else if (msg.action === 'stage_changed' && msg.lead_id && msg.stage_id) {
          const leadId = msg.lead_id!
          const newStageId = msg.stage_id!
          // Move lead between stages
          setStageData(prev => {
            let movedLead: Lead | undefined
            const afterRemove = prev.map(s => {
              if (s.id === newStageId && s.leads.some(l => l.id === leadId)) return s // already moved
              const idx = s.leads.findIndex(l => l.id === leadId)
              if (idx >= 0) {
                movedLead = { ...s.leads[idx], stage_id: newStageId }
                return { ...s, leads: s.leads.filter(l => l.id !== leadId), total_count: Math.max(0, s.total_count - 1) }
              }
              return s
            })
            if (movedLead) {
              return afterRemove.map(s => s.id === newStageId
                ? { ...s, leads: [movedLead!, ...s.leads], total_count: s.total_count + 1 }
                : s
              )
            }
            return prev
          })
          // Also check unassigned → stage move
          setUnassignedData(prev => {
            const idx = prev.leads.findIndex(l => l.id === leadId)
            if (idx >= 0) {
              const movedLead = { ...prev.leads[idx], stage_id: newStageId }
              setStageData(sd => sd.map(s => s.id === newStageId
                ? { ...s, leads: [movedLead, ...s.leads], total_count: s.total_count + 1 }
                : s
              ))
              return { ...prev, leads: prev.leads.filter(l => l.id !== leadId), total_count: Math.max(0, prev.total_count - 1) }
            }
            return prev
          })
        } else {
          // Fallback: full re-fetch for unknown actions
          fetchLeadsPaginated()
        }
      }
    })
    return () => unsubscribe()
  }, [fetchLeadsPaginated, updateLeadInStages, removeLeadFromStages, detailLead, activePipeline])

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
        fetchLeadsPaginated()
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
        fetchLeadsPaginated()
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
        fetchLeadsPaginated()
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
        fetchLeadsPaginated()
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
    setSelectedIds(new Set(allLoadedLeads.map(l => l.id)))
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
        updateLeadInStages(data.lead.id, () => merged)
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
        updateLeadInStages(data.lead.id, () => merged)
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

    let stage = stages.find(s => s.id === stageId)
    if (!stage) {
       for (const p of pipelines) {
         const found = p.stages?.find(s => s.id === stageId)
         if (found) { stage = found; break }
       }
    }

    const updatedProps = {
      stage_id: stageId,
      stage_name: stage?.name || null,
      stage_color: stage?.color || null,
      stage_position: stage?.position ?? null,
    }

    // Optimistic move between stages
    setStageData(prev => {
      let movedLead: Lead | undefined
      const afterRemove = prev.map(s => {
        const idx = s.leads.findIndex(l => l.id === leadId)
        if (idx >= 0) {
          movedLead = { ...s.leads[idx], ...updatedProps }
          return { ...s, leads: s.leads.filter(l => l.id !== leadId), total_count: Math.max(0, s.total_count - 1) }
        }
        return s
      })
      if (movedLead) {
        return afterRemove.map(s => s.id === stageId
          ? { ...s, leads: [movedLead!, ...s.leads], total_count: s.total_count + 1 }
          : s
        )
      }
      return afterRemove
    })
    // Handle unassigned → stage move
    setUnassignedData(prev => {
      const idx = prev.leads.findIndex(l => l.id === leadId)
      if (idx >= 0) {
        const movedLead = { ...prev.leads[idx], ...updatedProps }
        setStageData(sd => sd.map(s => s.id === stageId
          ? { ...s, leads: [movedLead, ...s.leads], total_count: s.total_count + 1 }
          : s
        ))
        return { ...prev, leads: prev.leads.filter(l => l.id !== leadId), total_count: Math.max(0, prev.total_count - 1) }
      }
      return prev
    })
    setListLeads(prev => prev.map(l => l.id === leadId ? { ...l, ...updatedProps } : l))

    if (detailLead?.id === leadId) {
      setDetailLead(prev => prev ? { ...prev, ...updatedProps } : null)
    }

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
      if (!data.success) {
        fetchLeadsPaginated() // Rollback on failure
      }
    } catch (err) {
      console.error('Failed to update stage:', err)
      fetchLeadsPaginated() // Rollback on error
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
        fetchLeadsPaginated()
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

  // Fetch observations for a single lead in list view (with cache) — used by detail panel
  const fetchListLeadObservations = async (leadId: string) => {
    if (listObservations.has(leadId) || loadingListObs.has(leadId)) return
    setLoadingListObs(prev => new Set(prev).add(leadId))
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/leads/${leadId}/interactions?limit=20`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        setListObservations(prev => new Map(prev).set(leadId, data.interactions || []))
      }
    } catch (err) {
      console.error('Failed to fetch list observations:', err)
    } finally {
      setLoadingListObs(prev => { const next = new Set(prev); next.delete(leadId); return next })
    }
  }

  // Batch fetch observations for multiple leads at once
  const fetchBatchObservations = useCallback(async (leadIds: string[]) => {
    const uncached = leadIds.filter(id => !listObservations.has(id) && !loadingListObs.has(id))
    if (uncached.length === 0) return
    setLoadingListObs(prev => {
      const next = new Set(prev)
      uncached.forEach(id => next.add(id))
      return next
    })
    const token = localStorage.getItem('token')
    try {
      const res = await fetch('/api/leads/observations/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ lead_ids: uncached, limit: 5 }),
      })
      const data = await res.json()
      if (data.success && data.observations) {
        setListObservations(prev => {
          const next = new Map(prev)
          // Set results for leads that had observations
          for (const [leadId, obs] of Object.entries(data.observations)) {
            next.set(leadId, obs as Observation[])
          }
          // Set empty arrays for leads with no observations
          uncached.forEach(id => {
            if (!next.has(id)) next.set(id, [])
          })
          return next
        })
      }
    } catch (err) {
      console.error('Failed to batch fetch observations:', err)
    } finally {
      setLoadingListObs(prev => {
        const next = new Set(prev)
        uncached.forEach(id => next.delete(id))
        return next
      })
    }
  }, [listObservations, loadingListObs])

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
        updateLeadInStages(data.lead.id, () => data.lead)
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
      const lead = findLeadById(leadId)
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
        fetchLeadsPaginated()
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

  // Tags for filter dropdown (from server response)
  const allUniqueTags = useMemo(() =>
    allTags.map(t => ({ id: t.name, account_id: '', name: t.name, color: t.color })).sort((a, b) => a.name.localeCompare(b.name)),
    [allTags]
  )

  // Count leads per tag (from server)
  const tagLeadCounts = useMemo(() => {
    const counts = new Map<string, number>()
    allTags.forEach(t => counts.set(t.name, t.count))
    return counts
  }, [allTags])

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

  // Leads with phone for broadcast (from loaded data)
  const broadcastableLeads = useMemo(() => allLoadedLeads.filter(l => l.phone), [allLoadedLeads])

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

  // Visible stages (from server data, filtered by hiddenStageIds)
  const visibleStages = useMemo(() =>
    stageData.filter(s => !hiddenStageIds.has(s.id)),
    [stageData, hiddenStageIds]
  )

  // List virtualizer
  const listVirtualizer = useVirtualizer({
    count: listLeads.length,
    getScrollElement: () => listScrollRef.current,
    estimateSize: () => 56,
    overscan: 10,
  })

  // Batch-fetch observations for visible list rows
  useEffect(() => {
    if (viewMode !== 'list' || listLeads.length === 0) return
    const items = listVirtualizer.getVirtualItems()
    if (items.length === 0) return
    const visibleIds = items.map(item => listLeads[item.index]?.id).filter(Boolean)
    if (visibleIds.length > 0) {
      fetchBatchObservations(visibleIds)
    }
  }, [viewMode, listVirtualizer.getVirtualItems(), listLeads, fetchBatchObservations])

  // Infinite scroll for list view
  useEffect(() => {
    if (viewMode !== 'list' || !listHasMore || listLoading) return
    const el = listScrollRef.current
    if (!el) return
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = el
      if (scrollHeight - scrollTop - clientHeight < 300) {
        fetchListLeads(false)
      }
    }
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [viewMode, listHasMore, listLoading, fetchListLeads])

  if (loading) {
    return (
      <div className="flex flex-col h-full min-h-0 animate-pulse">
        {/* Skeleton header */}
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="h-6 w-20 bg-slate-200 rounded" />
            <div className="h-4 w-32 bg-slate-100 rounded mt-1" />
          </div>
          <div className="flex gap-2">
            <div className="h-8 w-20 bg-slate-200 rounded-lg" />
            <div className="h-8 w-16 bg-slate-200 rounded-lg" />
            <div className="h-8 w-20 bg-emerald-200 rounded-lg" />
          </div>
        </div>
        {/* Skeleton search */}
        <div className="h-10 bg-slate-100 rounded-xl mb-3" />
        {/* Skeleton kanban columns */}
        <div className="flex-1 flex gap-3 overflow-hidden">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="w-[272px] flex-shrink-0">
              <div className="h-10 rounded-t-xl bg-slate-200 mb-2" />
              <div className="space-y-2 p-2">
                {[1, 2, 3, 4, 5].map(j => (
                  <div key={j} className="bg-white p-3 rounded-xl border border-slate-100">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="w-7 h-7 bg-slate-200 rounded-full" />
                      <div className="h-4 w-24 bg-slate-200 rounded" />
                    </div>
                    <div className="h-3 w-32 bg-slate-100 rounded mt-1.5" />
                    <div className="flex gap-1 mt-2">
                      <div className="h-4 w-12 bg-slate-100 rounded-full" />
                      <div className="h-4 w-14 bg-slate-100 rounded-full" />
                    </div>
                    <div className="h-3 w-20 bg-slate-50 rounded mt-2" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Leads</h1>
          <p className="text-slate-500 text-sm mt-0.5">{totalLeadCount} leads en total</p>
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
              {/* View toggle */}
              <div className="inline-flex items-center border border-slate-200 rounded-lg overflow-hidden">
                <button
                  onClick={() => setViewMode('kanban')}
                  className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium transition ${
                    viewMode === 'kanban' ? 'bg-emerald-50 text-emerald-700' : 'text-slate-500 hover:bg-slate-50'
                  }`}
                  title="Vista Kanban"
                >
                  <LayoutGrid className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => setViewMode('list')}
                  className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium transition ${
                    viewMode === 'list' ? 'bg-emerald-50 text-emerald-700' : 'text-slate-500 hover:bg-slate-50'
                  }`}
                  title="Vista Lista"
                >
                  <List className="w-3.5 h-3.5" />
                </button>
              </div>

              <button
                onClick={() => { fetchDevices(); setShowBroadcastModal(true) }}
                disabled={broadcastableLeads.length === 0}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-emerald-200 rounded-lg hover:bg-emerald-50 transition text-emerald-700 text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Radio className="w-3.5 h-3.5" />
                Masivo
              </button>

              {/* ··· More dropdown */}
              <div ref={moreMenuRef} className="relative">
                <button
                  onClick={() => setShowMoreMenu(v => !v)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 border rounded-lg text-xs font-medium transition ${
                    showMoreMenu ? 'border-slate-400 bg-slate-100 text-slate-700' : 'border-slate-200 hover:bg-slate-50 text-slate-600'
                  }`}
                  title="Más acciones"
                >
                  <MoreHorizontal className="w-4 h-4" />
                  <span className="hidden sm:inline">Más</span>
                  <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showMoreMenu ? 'rotate-180' : ''}`} />
                </button>
                {showMoreMenu && (
                  <div className="absolute right-0 top-full mt-1.5 w-56 bg-white border border-slate-200 rounded-xl shadow-xl z-30 py-1 overflow-hidden">
                    <button
                      onClick={() => { setSelectionMode(true); setShowMoreMenu(false) }}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
                    >
                      <CheckSquare className="w-4 h-4 text-slate-400" />
                      Seleccionar
                    </button>
                    <button
                      onClick={() => { setShowStageModal(true); setShowMoreMenu(false) }}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
                    >
                      <Settings className="w-4 h-4 text-slate-400" />
                      Etapas
                    </button>
                    <button
                      onClick={() => { setShowImportModal(true); setShowMoreMenu(false) }}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
                    >
                      <Upload className="w-4 h-4 text-slate-400" />
                      Importar CSV
                    </button>
                    {devices.length > 0 && (
                      <>
                        <div className="my-1 border-t border-slate-100" />
                        <div className="px-4 py-2">
                          <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Filtrar por dispositivo</p>
                          {devices.map(d => (
                            <label key={d.id} className="flex items-center gap-2 py-1 cursor-pointer text-sm">
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
                                className="w-3.5 h-3.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                              />
                              <span className="text-slate-700 text-xs">{d.name || d.phone || 'Dispositivo'}</span>
                            </label>
                          ))}
                          {filterDeviceIds.size > 0 && (
                            <button
                              onClick={() => setFilterDeviceIds(new Set())}
                              className="w-full mt-1 text-xs text-slate-500 hover:text-slate-700 py-0.5"
                            >
                              Limpiar filtro
                            </button>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>

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

      {/* Pipeline Kanban — Virtualized */}
      {viewMode === 'kanban' && (
      <div className="flex-1 min-h-0 flex flex-col">
      {/* Top synced scrollbar */}
      <div
        ref={topScrollRef}
        onScroll={handleTopScroll}
        className="overflow-x-auto kanban-scroll-top flex-shrink-0"
        style={{ height: 12 }}
      >
        <div style={{ width: `${(visibleStages.length + (unassignedData.total_count > 0 ? 1 : 0)) * 288}px`, height: 1 }} />
      </div>
      <div
        ref={kanbanRef}
        onScroll={handleKanbanScroll}
        className="overflow-x-auto flex-1 min-h-0 kanban-scroll"
      >
        <div className="flex gap-3 h-full" style={{ minWidth: `${(visibleStages.length + (unassignedData.total_count > 0 ? 1 : 0)) * 288}px` }}>
          {visibleStages.map((stageItem) => (
            <VirtualKanbanColumn
              key={stageItem.id}
              column={stageItem}
              totalCount={stageItem.total_count}
              hasMore={stageItem.has_more}
              loadingMore={loadingMoreStages.has(stageItem.id)}
              onLoadMore={() => loadMoreForStage(stageItem.id)}
              selectedIds={selectedIds}
              detailLeadId={detailLead?.id || null}
              draggedLeadId={draggedLeadId}
              dragOverColumn={dragOverColumn}
              selectionMode={selectionMode}
              onToggleSelection={toggleSelection}
              onOpenDetail={openDetailPanel}
              onDelete={handleDeleteLead}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            />
          ))}
          {/* Unassigned column */}
          {unassignedData.total_count > 0 && (
            <VirtualKanbanColumn
              key="__unassigned__"
              column={{
                id: '__unassigned__',
                name: 'Sin etapa',
                color: '#64748b',
                leads: unassignedData.leads,
              }}
              totalCount={unassignedData.total_count}
              hasMore={unassignedData.has_more}
              loadingMore={loadingMoreStages.has('__unassigned__')}
              onLoadMore={() => loadMoreForStage('__unassigned__')}
              selectedIds={selectedIds}
              detailLeadId={detailLead?.id || null}
              draggedLeadId={draggedLeadId}
              dragOverColumn={dragOverColumn}
              selectionMode={selectionMode}
              onToggleSelection={toggleSelection}
              onOpenDetail={openDetailPanel}
              onDelete={handleDeleteLead}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            />
          )}
        </div>
      </div>
      </div>
      )}

      {/* List View — Virtualized */}
      {viewMode === 'list' && (
        <div className="flex-1 min-h-0 flex flex-col">
          {/* Sticky header */}
          <div className="bg-slate-50 border-b border-slate-200 flex-shrink-0">
            <div className="flex">
              <div className="px-3 py-2.5 text-[11px] font-semibold text-slate-500 uppercase tracking-wider w-[220px]">Lead</div>
              <div className="px-3 py-2.5 text-[11px] font-semibold text-slate-500 uppercase tracking-wider w-[110px]">Etapa</div>
              <div className="px-3 py-2.5 text-[11px] font-semibold text-slate-500 uppercase tracking-wider w-[180px]">Etiquetas</div>
              <div className="px-3 py-2.5 text-[11px] font-semibold text-slate-500 uppercase tracking-wider flex-1">Últimas observaciones</div>
              <div className="px-3 py-2.5 w-[40px]"></div>
            </div>
          </div>
          {/* Virtualized rows */}
          <div ref={listScrollRef} className="flex-1 min-h-0 overflow-auto">
            {listLeads.length > 0 ? (
              <div style={{ height: listVirtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
                {listVirtualizer.getVirtualItems().map((virtualRow) => {
                  const lead = listLeads[virtualRow.index]
                  const stageName = lead.stage_name || stages.find(s => s.id === lead.stage_id)?.name
                  const stageColor = lead.stage_color || stages.find(s => s.id === lead.stage_id)?.color || '#94a3b8'
                  const obs = listObservations.get(lead.id)
                  const isExpanded = expandedListLeadId === lead.id

                  return (
                    <div
                      key={lead.id}
                      ref={listVirtualizer.measureElement}
                      data-index={virtualRow.index}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                    >
                      <div
                        className={`flex items-start group border-b border-slate-100 hover:bg-slate-50/80 transition cursor-pointer ${
                          detailLead?.id === lead.id ? 'bg-emerald-50/50' : ''
                        }`}
                        onClick={() => openDetailPanel(lead)}
                      >
                        {/* Lead info */}
                        <div className="px-3 py-2.5 w-[220px]">
                          <div className="flex items-center gap-2.5">
                            <div className="w-8 h-8 bg-emerald-50 rounded-full flex items-center justify-center shrink-0">
                              <span className="text-emerald-700 text-xs font-semibold">
                                {(lead.name || '?').charAt(0).toUpperCase()}
                              </span>
                            </div>
                            <div className="min-w-0">
                              <p className="text-[13px] font-medium text-slate-900 truncate">{lead.name || 'Sin nombre'}</p>
                              {lead.phone && (
                                <p className="text-[11px] text-slate-500 mt-0.5">{lead.phone}</p>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Stage */}
                        <div className="px-3 py-2.5 w-[110px]">
                          {stageName ? (
                            <span
                              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold text-white"
                              style={{ backgroundColor: stageColor }}
                            >
                              {stageName}
                            </span>
                          ) : (
                            <span className="text-[10px] text-slate-400 italic">Sin etapa</span>
                          )}
                        </div>

                        {/* Tags */}
                        <div className="px-3 py-2.5 w-[180px]">
                          {lead.structured_tags && lead.structured_tags.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {lead.structured_tags.slice(0, 3).map(tag => (
                                <span
                                  key={tag.id}
                                  className="px-1.5 py-0.5 text-[10px] rounded-full text-white font-medium"
                                  style={{ backgroundColor: tag.color || '#6b7280' }}
                                >
                                  {tag.name}
                                </span>
                              ))}
                              {lead.structured_tags.length > 3 && (
                                <span className="text-[10px] text-slate-400">+{lead.structured_tags.length - 3}</span>
                              )}
                            </div>
                          ) : (
                            <span className="text-[10px] text-slate-300">—</span>
                          )}
                        </div>

                        {/* Observations preview */}
                        <div className="px-3 py-2.5 flex-1" onClick={(e) => e.stopPropagation()}>
                          {loadingListObs.has(lead.id) ? (
                            <div className="flex items-center gap-2">
                              <div className="animate-spin rounded-full h-3 w-3 border border-slate-200 border-t-emerald-500" />
                              <span className="text-[10px] text-slate-400">Cargando...</span>
                            </div>
                          ) : obs && obs.length > 0 ? (
                            <div className="space-y-1">
                              {obs.slice(0, isExpanded ? 10 : 3).map(o => (
                                <div key={o.id} className="flex items-start gap-1.5">
                                  <span className="shrink-0 mt-0.5 text-[10px]">
                                    {o.type === 'call' ? '📞' : o.type === 'note' ? '📝' : '↕'}
                                  </span>
                                  <p className="text-[11px] text-slate-600 leading-tight line-clamp-1">
                                    {(o.notes || '').replace(/^\(sinc\)\s*/i, '')}
                                  </p>
                                  <span className="shrink-0 text-[9px] text-slate-400 mt-0.5 whitespace-nowrap">
                                    {formatDistanceToNow(new Date(o.created_at), { locale: es, addSuffix: false })}
                                  </span>
                                </div>
                              ))}
                              {obs.length > 3 && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setExpandedListLeadId(isExpanded ? null : lead.id)
                                  }}
                                  className="text-[10px] text-emerald-600 hover:text-emerald-700 font-medium mt-0.5"
                                >
                                  {isExpanded ? (
                                    <span className="inline-flex items-center gap-0.5"><ChevronUp className="w-3 h-3" /> Menos</span>
                                  ) : (
                                    <span className="inline-flex items-center gap-0.5"><ChevronDown className="w-3 h-3" /> +{obs.length - 3} más</span>
                                  )}
                                </button>
                              )}
                            </div>
                          ) : (
                            <span className="text-[10px] text-slate-300 italic">Sin observaciones</span>
                          )}
                        </div>

                        {/* Actions */}
                        <div className="px-3 py-2.5 w-[40px]">
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDeleteLead(lead.id) }}
                            className="p-1 text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                            title="Eliminar"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-16 text-slate-400">
                <FileText className="w-10 h-10 mb-2 text-slate-300" />
                <p className="text-sm">No se encontraron leads</p>
              </div>
            )}
            {listLoading && (
              <div className="flex items-center justify-center py-3">
                <div className="animate-spin rounded-full h-5 w-5 border-2 border-slate-200 border-t-emerald-500" />
              </div>
            )}
          </div>
        </div>
      )}

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
                  updateLeadInStages(updatedLead.id, () => updatedLead as any)
                }}
                onClose={() => { setShowDetailPanel(false); setShowInlineChat(false) }}
                onSendWhatsApp={(phone: string) => handleSendWhatsApp(phone)}
                onDelete={(leadId: string) => {
                  removeLeadFromStages(leadId)
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
        onSuccess={() => { fetchLeadsPaginated(); fetchPipelines() }}
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
            {allLoadedLeads.length !== broadcastableLeads.length && (
              <p className="text-amber-600 mt-1">
                {allLoadedLeads.length - broadcastableLeads.length} lead(s) sin teléfono serán excluidos.
              </p>
            )}
          </div>
        }
      />
    </div>
  )
}
