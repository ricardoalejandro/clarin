'use client'

import { useEffect, useState, useCallback, useMemo, useRef, memo } from 'react'
import { useParams, useRouter } from 'next/navigation'
import {
  ArrowLeft, Users, UserPlus, Search, Phone, MessageSquare, Mail,
  CheckCircle2, Clock, GripVertical, List, LayoutGrid, X, Plus, Trash2,
  Filter, Send, Maximize2, MapPin, CalendarDays, Download,
  FileSpreadsheet, FileText, FileDown, Loader2, StickyNote,
  Tag, CheckSquare, XCircle, Code, AlertCircle
} from 'lucide-react'
import { format, formatDistanceToNow } from 'date-fns'
import { es } from 'date-fns/locale'
import { useVirtualizer } from '@tanstack/react-virtual'
import CreateCampaignModal, { CampaignFormResult } from '@/components/CreateCampaignModal'
import ContactSelector, { SelectedPerson } from '@/components/ContactSelector'
import ChatPanel from '@/components/chat/ChatPanel'
import LeadDetailPanel from '@/components/LeadDetailPanel'
import FormulaEditor from '@/components/FormulaEditor'
import { Chat } from '@/types/chat'
import { exportToExcel, exportToCSV } from '@/utils/eventExport'
import { generateWordReport, type ReportStyle, type DetailLevel } from '@/utils/eventWordReport'
import { subscribeWebSocket } from '@/lib/api'

const getToken = () => typeof window !== 'undefined' ? localStorage.getItem('token') || '' : ''

// ─── Date Filter Presets (Event Participants) ────────────────────────────────
const PARTICIPANT_DATE_PRESETS = [
  { key: 'last_15m', label: 'Últimos 15 min' },
  { key: 'last_hour', label: 'Última hora' },
  { key: 'today', label: 'Hoy' },
  { key: 'yesterday', label: 'Ayer' },
  { key: 'last_7d', label: 'Últimos 7 días' },
  { key: 'this_week', label: 'Esta semana' },
  { key: 'this_month', label: 'Este mes' },
  { key: 'last_30d', label: 'Últimos 30 días' },
  { key: 'custom', label: 'Rango personalizado' },
] as const

const PARTICIPANT_DATE_FIELDS = [
  { key: 'created_at', label: 'Creación' },
  { key: 'updated_at', label: 'Modificación' },
  { key: 'invited_at', label: 'Invitación' },
  { key: 'confirmed_at', label: 'Confirmación' },
  { key: 'attended_at', label: 'Asistencia' },
] as const

function resolveParticipantDatePreset(preset: string, customFrom?: string, customTo?: string): { from: string; to: string } | null {
  const now = new Date()
  switch (preset) {
    case 'last_15m': { const f = new Date(now.getTime() - 15 * 60 * 1000); return { from: f.toISOString(), to: now.toISOString() } }
    case 'last_hour': { const f = new Date(now.getTime() - 60 * 60 * 1000); return { from: f.toISOString(), to: now.toISOString() } }
    case 'today': { const s = new Date(now); s.setHours(0, 0, 0, 0); return { from: s.toISOString(), to: now.toISOString() } }
    case 'yesterday': { const s = new Date(now); s.setDate(s.getDate() - 1); s.setHours(0, 0, 0, 0); const e = new Date(s); e.setHours(23, 59, 59, 999); return { from: s.toISOString(), to: e.toISOString() } }
    case 'last_7d': { const f = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); return { from: f.toISOString(), to: now.toISOString() } }
    case 'this_week': { const s = new Date(now); const dow = s.getDay(); s.setDate(s.getDate() - (dow === 0 ? 6 : dow - 1)); s.setHours(0, 0, 0, 0); return { from: s.toISOString(), to: now.toISOString() } }
    case 'this_month': { const s = new Date(now.getFullYear(), now.getMonth(), 1); return { from: s.toISOString(), to: now.toISOString() } }
    case 'last_30d': { const f = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); return { from: f.toISOString(), to: now.toISOString() } }
    case 'custom': { if (!customFrom && !customTo) return null; const f = customFrom ? new Date(customFrom + 'T00:00:00').toISOString() : ''; const t = customTo ? new Date(customTo + 'T23:59:59').toISOString() : ''; return { from: f, to: t } }
    default: return null
  }
}
// ─── Interfaces ──────────────────────────────────────────────────────────────
interface Event {
  id: string; name: string; description?: string; event_date?: string; event_end?: string
  location?: string; status: string; color: string; total_participants: number
  participant_counts?: Record<string, number>
  pipeline_id?: string; pipeline_name?: string
}

interface TagItem {
  id: string; account_id: string; name: string; color: string; created_at: string
}

interface Participant {
  id: string; event_id: string; contact_id?: string; lead_id?: string; name: string
  last_name?: string; short_name?: string; phone?: string; email?: string
  age?: number; status: string; notes?: string; dni?: string; birth_date?: string
  stage_id?: string; stage_name?: string; stage_color?: string
  next_action?: string; next_action_date?: string; invited_at?: string
  confirmed_at?: string; attended_at?: string; last_interaction?: string
  tags?: TagItem[]
}

interface PipelineStage {
  id: string; pipeline_id: string; name: string; color: string; position: number
  participant_count?: number
}

interface Observation {
  id: string; contact_id: string | null; lead_id: string | null; type: string
  direction: string | null; outcome: string | null; notes: string | null
  created_by_name: string | null; created_at: string
}

interface StageData {
  id: string; pipeline_id: string; name: string; color: string; position: number
  total_count: number; participants: Participant[]; has_more: boolean
}

interface TagInfo { name: string; color: string; count: number }

interface Device {
  id: string; name: string; phone_number: string; status: string
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function hexToRgb(hex: string) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16)
  return { r, g, b }
}
function hexBgLight(hex: string) { const { r, g, b } = hexToRgb(hex); return `rgba(${r},${g},${b},0.08)` }

/** Map a Participant to a Lead-like object for LeadDetailPanel */
function participantToLead(p: Participant): any {
  return {
    id: p.lead_id || p.id,
    name: p.name || '',
    last_name: p.last_name || null,
    short_name: p.short_name || null,
    phone: p.phone || '',
    email: p.email || '',
    company: null,
    age: p.age || null,
    dni: p.dni || null,
    birth_date: p.birth_date || null,
    status: p.status,
    pipeline_id: null,
    stage_id: p.stage_id || null,
    stage_name: p.stage_name || null,
    stage_color: p.stage_color || null,
    notes: p.notes || '',
    tags: [],
    structured_tags: p.tags?.map(t => ({ id: t.id, account_id: t.account_id || '', name: t.name, color: t.color })) || null,
    kommo_id: null,
    jid: '',
    contact_id: p.contact_id || null,
    assigned_to: '',
    created_at: '',
    updated_at: '',
  }
}

// ─── Memoized ParticipantCard ────────────────────────────────────────────────
interface ParticipantCardProps {
  participant: Participant
  isSelected: boolean
  isDetailActive: boolean
  isDragged: boolean
  selectionMode: boolean
  onToggleSelection: (id: string) => void
  onOpenDetail: (p: Participant) => void
  onDelete: (id: string) => void
  onDragStart: (e: React.DragEvent, id: string) => void
  onDragEnd: (e: React.DragEvent) => void
}

const ParticipantCard = memo(function ParticipantCard({
  participant: p, isSelected, isDetailActive, isDragged, selectionMode,
  onToggleSelection, onOpenDetail, onDelete, onDragStart, onDragEnd,
}: ParticipantCardProps) {
  return (
    <div
      draggable={!selectionMode}
      onDragStart={(e) => onDragStart(e, p.id)}
      onDragEnd={onDragEnd}
      className={`bg-white p-3 rounded-xl shadow-sm border hover:shadow-md transition cursor-pointer ${
        isSelected ? 'border-emerald-500 ring-2 ring-emerald-100'
        : isDetailActive ? 'border-emerald-400 ring-2 ring-emerald-200 bg-emerald-50/50'
        : 'border-slate-100'
      } ${isDragged ? 'opacity-50' : ''} ${!selectionMode ? 'cursor-grab active:cursor-grabbing' : ''}`}
      onClick={() => selectionMode ? onToggleSelection(p.id) : onOpenDetail(p)}
    >
      <div className="flex items-start justify-between group">
        <div className="flex items-center gap-2">
          {selectionMode ? (
            <button onClick={(e) => { e.stopPropagation(); onToggleSelection(p.id) }} className="p-0.5">
              {isSelected ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <div className="w-4 h-4 rounded border-2 border-slate-300" />}
            </button>
          ) : (
            <div className="w-7 h-7 bg-emerald-50 rounded-full flex items-center justify-center">
              <span className="text-emerald-700 text-xs font-semibold">{(p.name || '?').charAt(0).toUpperCase()}</span>
            </div>
          )}
          <p className="text-[13px] font-medium text-slate-900 truncate max-w-[150px]">
            {p.name || 'Sin nombre'} {p.last_name || ''}
          </p>
        </div>
        {!selectionMode && (
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(p.id) }}
            className="p-1 text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      {p.short_name && <p className="text-[11px] text-slate-400 italic mt-0.5 ml-9">{p.short_name}</p>}
      {p.phone && (
        <div className="flex items-center gap-1.5 mt-1.5 text-xs text-slate-500"><Phone className="w-3 h-3" />{p.phone}</div>
      )}
      {p.email && (
        <div className="flex items-center gap-1.5 mt-1 text-xs text-slate-500"><Mail className="w-3 h-3" /><span className="truncate max-w-[180px]">{p.email}</span></div>
      )}
      {p.tags && p.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {p.tags.slice(0, 3).map(tag => (
            <span key={tag.id} className="px-1.5 py-0.5 text-[10px] rounded-full text-white font-medium" style={{ backgroundColor: tag.color || '#6b7280' }}>{tag.name}</span>
          ))}
          {p.tags.length > 3 && <span className="px-1.5 py-0.5 text-slate-400 text-[10px]">+{p.tags.length - 3}</span>}
        </div>
      )}
      {p.next_action && (
        <div className="flex items-center gap-1 mt-2 text-[11px] text-amber-600">
          <Clock className="w-3 h-3" /><span className="truncate">{p.next_action}</span>
        </div>
      )}
    </div>
  )
})

// ─── Virtualized Kanban Column ───────────────────────────────────────────────
interface VirtualColumnProps {
  column: { id: string; name: string; color: string; participants: Participant[] }
  totalCount: number; hasMore: boolean; loadingMore: boolean
  onLoadMore: () => void
  selectedIds: Set<string>; detailParticipantId: string | null
  draggedId: string | null; dragOverColumn: string | null; selectionMode: boolean
  onToggleSelection: (id: string) => void; onOpenDetail: (p: Participant) => void
  onDelete: (id: string) => void
  onDragStart: (e: React.DragEvent, id: string) => void; onDragEnd: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent, stageId: string) => void; onDragLeave: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent, stageId: string) => void
  onRenameStage?: (stageId: string, newName: string) => void
}

const VirtualKanbanColumn = memo(function VirtualKanbanColumn({
  column, totalCount, hasMore, loadingMore, onLoadMore,
  selectedIds, detailParticipantId, draggedId, dragOverColumn, selectionMode,
  onToggleSelection, onOpenDetail, onDelete, onDragStart, onDragEnd, onDragOver, onDragLeave, onDrop,
  onRenameStage,
}: VirtualColumnProps) {
  const parentRef = useRef<HTMLDivElement>(null)
  const [editingName, setEditingName] = useState(false)
  const [editName, setEditName] = useState(column.name)
  const editInputRef = useRef<HTMLInputElement>(null)
  const virtualizer = useVirtualizer({
    count: column.participants.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 120,
    overscan: 5,
  })

  useEffect(() => {
    const el = parentRef.current
    if (!el || !hasMore || loadingMore) return
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = el
      if (scrollHeight - scrollTop - clientHeight < 300) onLoadMore()
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
          {editingName ? (
            <input
              ref={editInputRef}
              value={editName}
              onChange={e => setEditName(e.target.value)}
              onBlur={() => { if (editName.trim() && editName.trim() !== column.name && onRenameStage) { onRenameStage(column.id, editName.trim()) } setEditingName(false) }}
              onKeyDown={e => { if (e.key === 'Enter') { e.currentTarget.blur() } else if (e.key === 'Escape') { setEditName(column.name); setEditingName(false) } }}
              className="text-sm font-bold tracking-wide uppercase text-slate-800 bg-white/60 border border-slate-300 rounded px-1.5 py-0.5 w-full focus:ring-2 focus:ring-emerald-500 focus:border-transparent outline-none"
              autoFocus
            />
          ) : (
            <span
              className="text-sm font-bold tracking-wide uppercase text-slate-800 cursor-pointer hover:text-emerald-700 transition-colors"
              onDoubleClick={() => { setEditName(column.name); setEditingName(true); setTimeout(() => editInputRef.current?.select(), 50) }}
              title="Doble clic para editar"
            >{column.name}</span>
          )}
          <div className="flex items-center gap-1.5">
            {column.participants.length < totalCount && (
              <span className="text-[10px] text-slate-500 font-medium tabular-nums">{column.participants.length}/</span>
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
          {virtualizer.getVirtualItems().map((vi) => {
            const p = column.participants[vi.index]
            return (
              <div key={p.id} style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}>
                <div className="pb-2">
                  <ParticipantCard
                    participant={p}
                    isSelected={selectedIds.has(p.id)}
                    isDetailActive={detailParticipantId === p.id}
                    isDragged={draggedId === p.id}
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
        {!hasMore && column.participants.length > 0 && column.participants.length >= totalCount && totalCount > 50 && (
          <p className="text-center text-[10px] text-slate-400 py-2">Todos cargados</p>
        )}
      </div>
    </div>
  )
})

// ─── Main Page ───────────────────────────────────────────────────────────────
export default function EventDetailPage() {
  const params = useParams()
  const router = useRouter()
  const eventId = params.id as string

  // Core data
  const [event, setEvent] = useState<Event | null>(null)
  const [stageData, setStageData] = useState<StageData[]>([])
  const [unassignedData, setUnassignedData] = useState<{ total_count: number; participants: Participant[]; has_more: boolean }>({ total_count: 0, participants: [], has_more: false })
  const [allTags, setAllTags] = useState<TagInfo[]>([])
  const [pipelineStages, setPipelineStages] = useState<PipelineStage[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMoreStages, setLoadingMoreStages] = useState<Set<string>>(new Set())

  // UI state
  const [viewMode, setViewMode] = useState<'kanban' | 'list'>('kanban')
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [showFilterDropdown, setShowFilterDropdown] = useState(false)
  const [filterStageIds, setFilterStageIds] = useState<Set<string>>(new Set())
  const [filterTagNames, setFilterTagNames] = useState<Set<string>>(new Set())
  const [excludeFilterTagNames, setExcludeFilterTagNames] = useState<Set<string>>(new Set())
  const [tagFilterMode, setTagFilterMode] = useState<'OR' | 'AND'>('OR')
  const [filterHasPhone, setFilterHasPhone] = useState(false)
  // Formula filter
  const [pFormulaType, setPFormulaType] = useState<'simple' | 'advanced'>('simple')
  const [pFormulaText, setPFormulaText] = useState('')
  const [pFormulaIsValid, setPFormulaIsValid] = useState(true)
  const [appliedFormulaType, setAppliedFormulaType] = useState<'simple' | 'advanced'>('simple')
  const [appliedFormulaText, setAppliedFormulaText] = useState('')
  // Date filter
  const [filterDateField, setFilterDateField] = useState<string>('created_at')
  const [filterDatePreset, setFilterDatePreset] = useState('')
  const [filterDateFrom, setFilterDateFrom] = useState('')
  const [filterDateTo, setFilterDateTo] = useState('')

  // Selection & drag
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [selectionMode, setSelectionMode] = useState(false)
  const [bulkMoving, setBulkMoving] = useState(false)
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null)

  // Detail panel
  const [showDetailPanel, setShowDetailPanel] = useState(false)
  const [detailParticipant, setDetailParticipant] = useState<Participant | null>(null)

  // WhatsApp inline chat
  const [showInlineChat, setShowInlineChat] = useState(false)
  const [inlineChatId, setInlineChatId] = useState('')
  const [inlineChat, setInlineChat] = useState<Chat | null>(null)
  const [inlineChatDeviceId, setInlineChatDeviceId] = useState('')
  const [showDeviceSelector, setShowDeviceSelector] = useState(false)
  const [devices, setDevices] = useState<Device[]>([])
  const [whatsappPhone, setWhatsappPhone] = useState('')

  // Add participant
  const [showAddModal, setShowAddModal] = useState(false)
  const [addTab, setAddTab] = useState<'search' | 'manual'>('search')
  const [manualForm, setManualForm] = useState({ name: '', last_name: '', short_name: '', phone: '', email: '', age: '' })

  // Export
  const [showExportModal, setShowExportModal] = useState(false)
  const [exportFormat, setExportFormat] = useState<'excel' | 'csv' | 'word'>('excel')
  const [exportStyle, setExportStyle] = useState<ReportStyle>('gerencia')
  const [exportDetail, setExportDetail] = useState<DetailLevel>('detallado')
  const [exporting, setExporting] = useState(false)

  // Campaign
  const [showCampaignModal, setShowCampaignModal] = useState(false)
  const [creatingCampaign, setCreatingCampaign] = useState(false)
  const [campaignInitialName, setCampaignInitialName] = useState('')

  // List view
  const [listParticipants, setListParticipants] = useState<Participant[]>([])
  const [listTotal, setListTotal] = useState(0)
  const [listHasMore, setListHasMore] = useState(false)
  const [listLoading, setListLoading] = useState(false)
  const listOffsetRef = useRef(0)
  const listScrollRef = useRef<HTMLDivElement>(null)
  const [listObservations, setListObservations] = useState<Map<string, Observation[]>>(new Map())
  const [loadingListObs, setLoadingListObs] = useState<Set<string>>(new Set())
  const [listHistoryParticipant, setListHistoryParticipant] = useState<Participant | null>(null)
  const [listHistoryFilterType, setListHistoryFilterType] = useState('')
  const [listHistoryFilterFrom, setListHistoryFilterFrom] = useState('')
  const [listHistoryFilterTo, setListHistoryFilterTo] = useState('')

  const kanbanRef = useRef<HTMLDivElement>(null)
  const topScrollRef = useRef<HTMLDivElement>(null)
  const syncingScroll = useRef(false)

  // ─── Fetch Functions ─────────────────────────────────────────────────────────
  const fetchEvent = useCallback(async () => {
    try {
      const res = await fetch(`/api/events/${eventId}`, { headers: { Authorization: `Bearer ${getToken()}` } })
      const data = await res.json()
      if (data.success) {
        setEvent(data.event)
        if (data.event.pipeline_id) {
          try {
            const pRes = await fetch(`/api/events/pipelines/${data.event.pipeline_id}`, { headers: { Authorization: `Bearer ${getToken()}` } })
            const pData = await pRes.json()
            if (pData.success && pData.pipeline?.stages) {
              setPipelineStages(pData.pipeline.stages.sort((a: PipelineStage, b: PipelineStage) => a.position - b.position))
            }
          } catch (e) { console.error('[Pipeline]', e) }
        }
      }
    } catch (e) { console.error(e) }
  }, [eventId])

  const fetchParticipantsPaginated = useCallback(async () => {
    try {
      const params = new URLSearchParams()
      params.set('per_stage', '50')
      if (debouncedSearch) params.set('search', debouncedSearch)
      if (appliedFormulaType === 'advanced' && appliedFormulaText) {
        params.set('tag_formula', appliedFormulaText)
      } else {
        if (filterTagNames.size > 0) params.set('tag_names', Array.from(filterTagNames).join(','))
        if (filterTagNames.size > 0 || excludeFilterTagNames.size > 0) params.set('tag_mode', tagFilterMode)
        if (excludeFilterTagNames.size > 0) params.set('exclude_tag_names', Array.from(excludeFilterTagNames).join(','))
      }
      if (filterStageIds.size > 0) params.set('stage_ids', Array.from(filterStageIds).join(','))
      if (filterHasPhone) params.set('has_phone', 'true')
      const dateRange = resolveParticipantDatePreset(filterDatePreset, filterDateFrom, filterDateTo)
      if (dateRange) {
        params.set('date_field', filterDateField)
        if (dateRange.from) params.set('date_from', dateRange.from)
        if (dateRange.to) params.set('date_to', dateRange.to)
      }
      const res = await fetch(`/api/events/${eventId}/participants/paginated?${params}`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      })
      const data = await res.json()
      if (data.success) {
        setStageData((data.stages || []).map((s: StageData) => ({ ...s, participants: s.participants || [] })))
        const ua = data.unassigned || { total_count: 0, participants: [], has_more: false }
        setUnassignedData({ ...ua, participants: ua.participants || [] })
        setAllTags(data.all_tags || [])
      }
    } catch (err) {
      console.error('Failed to fetch participants:', err)
    } finally {
      setLoading(false)
    }
  }, [eventId, debouncedSearch, filterTagNames, excludeFilterTagNames, tagFilterMode, filterStageIds, filterHasPhone, appliedFormulaType, appliedFormulaText, filterDateField, filterDatePreset, filterDateFrom, filterDateTo])

  const loadMoreForStage = useCallback(async (stageId: string) => {
    if (loadingMoreStages.has(stageId)) return
    setLoadingMoreStages(prev => new Set(prev).add(stageId))
    try {
      const isUnassigned = stageId === '__unassigned__'
      const currentParticipants = isUnassigned
        ? unassignedData.participants
        : stageData.find(s => s.id === stageId)?.participants || []
      const params = new URLSearchParams()
      params.set('offset', String(currentParticipants.length))
      params.set('limit', '50')
      if (debouncedSearch) params.set('search', debouncedSearch)
      if (appliedFormulaType === 'advanced' && appliedFormulaText) {
        params.set('tag_formula', appliedFormulaText)
      } else {
        if (filterTagNames.size > 0) params.set('tag_names', Array.from(filterTagNames).join(','))
        if (filterTagNames.size > 0 || excludeFilterTagNames.size > 0) params.set('tag_mode', tagFilterMode)
        if (excludeFilterTagNames.size > 0) params.set('exclude_tag_names', Array.from(excludeFilterTagNames).join(','))
      }
      if (filterHasPhone) params.set('has_phone', 'true')
      const dateRange = resolveParticipantDatePreset(filterDatePreset, filterDateFrom, filterDateTo)
      if (dateRange) {
        params.set('date_field', filterDateField)
        if (dateRange.from) params.set('date_from', dateRange.from)
        if (dateRange.to) params.set('date_to', dateRange.to)
      }
      const endpoint = isUnassigned ? 'unassigned' : stageId
      const res = await fetch(`/api/events/${eventId}/participants/by-stage/${endpoint}?${params}`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      })
      const data = await res.json()
      if (data.success) {
        const newP = data.participants || []
        if (isUnassigned) {
          setUnassignedData(prev => ({ ...prev, participants: [...prev.participants, ...newP], has_more: data.has_more }))
        } else {
          setStageData(prev => prev.map(s => s.id === stageId ? { ...s, participants: [...s.participants, ...newP], has_more: data.has_more } : s))
        }
      }
    } catch (err) {
      console.error('Failed to load more:', err)
    } finally {
      setLoadingMoreStages(prev => { const next = new Set(prev); next.delete(stageId); return next })
    }
  }, [loadingMoreStages, stageData, unassignedData, eventId, debouncedSearch, filterTagNames, excludeFilterTagNames, tagFilterMode, filterHasPhone, appliedFormulaType, appliedFormulaText, filterDateField, filterDatePreset, filterDateFrom, filterDateTo])

  const fetchListParticipants = useCallback(async (reset: boolean = false) => {
    setListLoading(true)
    const offset = reset ? 0 : listOffsetRef.current
    try {
      const params = new URLSearchParams()
      params.set('offset', String(offset))
      params.set('limit', '100')
      if (debouncedSearch) params.set('search', debouncedSearch)
      if (filterStageIds.size > 0) params.set('status', Array.from(filterStageIds).join(','))
      if (appliedFormulaType === 'advanced' && appliedFormulaText) {
        params.set('tag_formula', appliedFormulaText)
      } else {
        if (filterTagNames.size > 0) params.set('tags', Array.from(filterTagNames).join(','))
        if (filterTagNames.size > 0 || excludeFilterTagNames.size > 0) params.set('tag_mode', tagFilterMode)
        if (excludeFilterTagNames.size > 0) params.set('exclude_tag_names', Array.from(excludeFilterTagNames).join(','))
      }
      if (filterHasPhone) params.set('has_phone', 'true')
      const dateRange = resolveParticipantDatePreset(filterDatePreset, filterDateFrom, filterDateTo)
      if (dateRange) {
        params.set('date_field', filterDateField)
        if (dateRange.from) params.set('date_from', dateRange.from)
        if (dateRange.to) params.set('date_to', dateRange.to)
      }
      const res = await fetch(`/api/events/${eventId}/participants?${params}`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      })
      const data = await res.json()
      if (data.success) {
        const participants = data.participants || []
        if (reset) {
          setListParticipants(participants)
          listOffsetRef.current = participants.length
        } else {
          setListParticipants(prev => [...prev, ...participants])
          listOffsetRef.current = offset + participants.length
        }
        setListTotal(data.total || participants.length)
        setListHasMore(participants.length >= 100)
      }
    } catch (err) {
      console.error('Failed to fetch list participants:', err)
    } finally {
      setListLoading(false)
    }
  }, [eventId, debouncedSearch, filterStageIds, filterTagNames, excludeFilterTagNames, tagFilterMode, filterHasPhone, appliedFormulaType, appliedFormulaText, filterDateField, filterDatePreset, filterDateFrom, filterDateTo])

  const fetchBatchObservations = useCallback(async (participantIds: string[]) => {
    const uncached = participantIds.filter(id => !listObservations.has(id) && !loadingListObs.has(id))
    if (uncached.length === 0) return
    setLoadingListObs(prev => { const next = new Set(prev); uncached.forEach(id => next.add(id)); return next })
    try {
      const res = await fetch(`/api/events/${eventId}/participants/observations/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ participant_ids: uncached, limit: 5 }),
      })
      const data = await res.json()
      if (data.success && data.observations) {
        setListObservations(prev => {
          const next = new Map(prev)
          for (const [pid, obs] of Object.entries(data.observations)) {
            next.set(pid, obs as Observation[])
          }
          uncached.forEach(id => { if (!next.has(id)) next.set(id, []) })
          return next
        })
      }
    } catch (err) {
      console.error('Failed to batch fetch observations:', err)
    } finally {
      setLoadingListObs(prev => { const next = new Set(prev); uncached.forEach(id => next.delete(id)); return next })
    }
  }, [eventId, listObservations, loadingListObs])

  const fetchDevices = useCallback(async () => {
    try {
      const res = await fetch('/api/devices', { headers: { Authorization: `Bearer ${getToken()}` } })
      const data = await res.json()
      if (data.success) setDevices((data.devices || []).filter((d: Device) => d.status === 'connected'))
    } catch (e) { console.error(e) }
  }, [])

  // ─── State Helpers ─────────────────────────────────────────────────────────
  const updateParticipantInStages = useCallback((pid: string, updater: (p: Participant) => Participant) => {
    setStageData(prev => prev.map(stage => ({
      ...stage,
      participants: stage.participants.map(p => p.id === pid ? updater(p) : p)
    })))
    setUnassignedData(prev => ({
      ...prev,
      participants: prev.participants.map(p => p.id === pid ? updater(p) : p)
    }))
    setListParticipants(prev => prev.map(p => p.id === pid ? updater(p) : p))
  }, [])

  const removeParticipantFromStages = useCallback((pid: string) => {
    setStageData(prev => prev.map(stage => ({
      ...stage,
      participants: stage.participants.filter(p => p.id !== pid),
      total_count: stage.participants.some(p => p.id === pid) ? stage.total_count - 1 : stage.total_count
    })))
    setUnassignedData(prev => ({
      ...prev,
      participants: prev.participants.filter(p => p.id !== pid),
      total_count: prev.participants.some(p => p.id === pid) ? prev.total_count - 1 : prev.total_count
    }))
    setListParticipants(prev => prev.filter(p => p.id !== pid))
  }, [])

  const findParticipantById = useCallback((pid: string): Participant | undefined => {
    for (const stage of stageData) {
      const found = stage.participants.find(p => p.id === pid)
      if (found) return found
    }
    return unassignedData.participants.find(p => p.id === pid)
  }, [stageData, unassignedData])

  const allLoadedParticipants = useMemo(() => {
    const all: Participant[] = []
    stageData.forEach(s => all.push(...(s.participants || [])))
    all.push(...(unassignedData.participants || []))
    return all
  }, [stageData, unassignedData])

  const totalParticipantCount = useMemo(() =>
    stageData.reduce((sum, s) => sum + s.total_count, 0) + unassignedData.total_count,
    [stageData, unassignedData]
  )

  const allFilteredParticipants = useMemo(() => {
    if (viewMode === 'list') return listParticipants
    return allLoadedParticipants
  }, [viewMode, listParticipants, allLoadedParticipants])

  const participantsWithPhone = useMemo(() => allFilteredParticipants.filter(p => p.phone), [allFilteredParticipants])

  // ─── Drag & Drop ────────────────────────────────────────────────────────────
  const handleDragStart = useCallback((e: React.DragEvent, pid: string) => {
    setDraggedId(pid)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', pid)
    if (e.currentTarget instanceof HTMLElement) e.currentTarget.style.opacity = '0.5'
  }, [])

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    setDraggedId(null)
    setDragOverColumn(null)
    if (e.currentTarget instanceof HTMLElement) e.currentTarget.style.opacity = '1'
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent, stageId: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverColumn(stageId)
  }, [])

  const handleDragLeave = useCallback(() => setDragOverColumn(null), [])

  const handleStageChange = useCallback(async (pid: string, targetStageId: string) => {
    const stage = pipelineStages.find(s => s.id === targetStageId) || stageData.find(s => s.id === targetStageId)
    const updatedProps = {
      stage_id: targetStageId,
      stage_name: stage?.name || undefined,
      stage_color: stage?.color || undefined,
    }
    // Optimistic move: remove from old stage, add to new
    setStageData(prev => {
      let movedP: Participant | undefined
      const afterRemove = prev.map(s => {
        const idx = s.participants.findIndex(p => p.id === pid)
        if (idx >= 0) {
          movedP = { ...s.participants[idx], ...updatedProps }
          return { ...s, participants: s.participants.filter(p => p.id !== pid), total_count: Math.max(0, s.total_count - 1) }
        }
        return s
      })
      if (movedP) {
        return afterRemove.map(s => s.id === targetStageId
          ? { ...s, participants: [movedP!, ...s.participants], total_count: s.total_count + 1 }
          : s
        )
      }
      return afterRemove
    })
    // Check unassigned→stage
    setUnassignedData(prev => {
      const idx = prev.participants.findIndex(p => p.id === pid)
      if (idx >= 0) {
        const movedP = { ...prev.participants[idx], ...updatedProps }
        setStageData(sd => sd.map(s => s.id === targetStageId
          ? { ...s, participants: [movedP, ...s.participants], total_count: s.total_count + 1 }
          : s
        ))
        return { ...prev, participants: prev.participants.filter(p => p.id !== pid), total_count: Math.max(0, prev.total_count - 1) }
      }
      return prev
    })
    setListParticipants(prev => prev.map(p => p.id === pid ? { ...p, ...updatedProps } : p))
    if (detailParticipant?.id === pid) {
      setDetailParticipant(prev => prev ? { ...prev, ...updatedProps } : null)
    }
    try {
      const res = await fetch(`/api/events/${eventId}/participants/${pid}/stage`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage_id: targetStageId }),
      })
      const data = await res.json()
      if (!data.success) fetchParticipantsPaginated()
    } catch { fetchParticipantsPaginated() }
  }, [eventId, pipelineStages, stageData, detailParticipant, fetchParticipantsPaginated])

  const handleDrop = useCallback((e: React.DragEvent, targetStageId: string) => {
    e.preventDefault()
    setDragOverColumn(null)
    const pid = e.dataTransfer.getData('text/plain')
    if (!pid) { setDraggedId(null); return }
    // Check if bulk
    if (selectedIds.has(pid) && selectedIds.size > 1) {
      setDraggedId(null)
      handleBulkMove(targetStageId)
      return
    }
    const p = findParticipantById(pid)
    if (p && p.stage_id !== targetStageId) {
      handleStageChange(pid, targetStageId)
    }
    setDraggedId(null)
  }, [selectedIds, findParticipantById, handleStageChange])

  const handleBulkMove = useCallback(async (targetStageId: string) => {
    if (selectedIds.size === 0) return
    setBulkMoving(true)
    const ids = Array.from(selectedIds)
    const stage = pipelineStages.find(s => s.id === targetStageId) || stageData.find(s => s.id === targetStageId)
    // Optimistic update
    ids.forEach(id => {
      updateParticipantInStages(id, p => ({
        ...p, stage_id: targetStageId, stage_name: stage?.name || undefined, stage_color: stage?.color || undefined,
      }))
    })
    setSelectedIds(new Set())
    try {
      await fetch(`/api/events/${eventId}/participants/bulk-stage`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ participant_ids: ids, stage_id: targetStageId }),
      })
      fetchParticipantsPaginated()
    } catch { fetchParticipantsPaginated() }
    finally { setBulkMoving(false) }
  }, [selectedIds, eventId, pipelineStages, stageData, updateParticipantInStages, fetchParticipantsPaginated])

  // ─── Rename Stage (inline kanban editing) ────────────────────────────────────
  const handleRenameStage = useCallback(async (stageId: string, newName: string) => {
    if (!event?.pipeline_id || !newName.trim()) return
    const stages = pipelineStages.length > 0
      ? pipelineStages
      : stageData.map(s => ({ id: s.id, pipeline_id: s.pipeline_id, name: s.name, color: s.color, position: s.position }))
    const updated = stages.map(s => ({
      id: s.id, name: s.id === stageId ? newName.trim() : s.name, color: s.color, position: s.position,
    }))
    try {
      const res = await fetch(`/api/events/pipelines/${event.pipeline_id}/stages`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ stages: updated }),
      })
      const data = await res.json()
      if (data.success) {
        setPipelineStages(prev => prev.map(s => s.id === stageId ? { ...s, name: newName.trim() } : s))
        setStageData(prev => prev.map(s => s.id === stageId ? { ...s, name: newName.trim() } : s))
      }
    } catch (e) { console.error('[RenameStage]', e) }
  }, [event?.pipeline_id, pipelineStages, stageData])

  // ─── Add Participants ────────────────────────────────────────────────────────
  const existingContactIds = useMemo(() => {
    const ids = new Set<string>()
    allLoadedParticipants.forEach(p => { if (p.contact_id) ids.add(p.contact_id) })
    return ids
  }, [allLoadedParticipants])

  const handleAddFromSelector = async (selected: SelectedPerson[]) => {
    if (selected.length === 0) return
    const parts = selected.map(p => ({
      contact_id: p.source_type === 'contact' ? p.id : undefined,
      name: p.name, phone: p.phone || '', email: p.email || '',
    }))
    const res = await fetch(`/api/events/${eventId}/participants/bulk`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ participants: parts }),
    })
    const data = await res.json()
    if (!data.success) { alert(data.error || 'Error al agregar participantes'); return }
    setShowAddModal(false)
    fetchParticipantsPaginated()
    fetchEvent()
  }

  const handleAddManual = async () => {
    const body: Record<string, unknown> = {
      name: manualForm.name, last_name: manualForm.last_name,
      short_name: manualForm.short_name || undefined,
      phone: manualForm.phone || undefined, email: manualForm.email || undefined,
    }
    if (manualForm.age) body.age = parseInt(manualForm.age)
    const res = await fetch(`/api/events/${eventId}/participants`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!data.success) { alert(data.error || 'Error al agregar participante'); return }
    setShowAddModal(false)
    setManualForm({ name: '', last_name: '', short_name: '', phone: '', email: '', age: '' })
    fetchParticipantsPaginated()
    fetchEvent()
  }

  // ─── Delete ─────────────────────────────────────────────────────────────────
  const handleDeleteParticipant = useCallback(async (pid: string) => {
    if (!confirm('¿Eliminar este participante?')) return
    removeParticipantFromStages(pid)
    if (detailParticipant?.id === pid) { setShowDetailPanel(false); setShowInlineChat(false) }
    try {
      await fetch(`/api/events/${eventId}/participants/${pid}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${getToken()}` },
      })
      fetchEvent()
    } catch (e) { console.error(e) }
  }, [eventId, detailParticipant, removeParticipantFromStages, fetchEvent])

  // ─── Detail Panel ──────────────────────────────────────────────────────────
  const openDetailPanel = useCallback((p: Participant) => {
    setDetailParticipant(p)
    setShowDetailPanel(true)
  }, [])

  const toggleSelection = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }, [])

  // ─── WhatsApp ──────────────────────────────────────────────────────────────
  const handleSendWhatsApp = async (phone: string) => {
    setWhatsappPhone(phone)
    await fetchDevices()
    const res = await fetch('/api/devices', { headers: { Authorization: `Bearer ${getToken()}` } })
    const data = await res.json()
    const connected = (data.devices || []).filter((d: Device) => d.status === 'connected')
    if (connected.length === 1) {
      handleDeviceSelectedForChat(connected[0], phone)
    } else {
      setShowDeviceSelector(true)
    }
  }

  const handleDeviceSelectedForChat = async (device: Device, phone?: string) => {
    setShowDeviceSelector(false)
    const cleanPhone = (phone || whatsappPhone).replace(/[^0-9]/g, '')
    try {
      const res = await fetch('/api/chats/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ device_id: device.id, phone: cleanPhone }),
      })
      const data = await res.json()
      if (data.success && data.chat) {
        setInlineChatId(data.chat.id)
        setInlineChat(data.chat)
        setInlineChatDeviceId(device.id)
        setShowInlineChat(true)
      } else {
        alert(data.error || 'Error al crear conversación')
      }
    } catch { alert('Error de conexión') }
  }

  // ─── Campaign ──────────────────────────────────────────────────────────────
  const handleCreateCampaign = async (formResult: CampaignFormResult) => {
    setCreatingCampaign(true)
    try {
      const res = await fetch(`/api/events/${eventId}/campaign`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formResult.name, device_id: formResult.device_id,
          message_template: formResult.message_template, attachments: formResult.attachments,
          scheduled_at: formResult.scheduled_at || undefined, settings: formResult.settings,
          status: filterStageIds.size > 0 ? Array.from(filterStageIds).join(',') : undefined,
          tag_ids: filterTagNames.size > 0 ? Array.from(filterTagNames) : undefined,
          has_phone: true,
        }),
      })
      const data = await res.json()
      if (data.success) {
        if (formResult.scheduled_at && data.campaign) {
          await fetch(`/api/campaigns/${data.campaign.id}`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'scheduled', scheduled_at: formResult.scheduled_at }),
          })
        }
        alert(`Campaña creada con ${data.recipients_count} destinatarios.`)
        setShowCampaignModal(false)
      } else { alert(data.error || 'Error al crear campaña') }
    } catch (e) { console.error(e); alert('Error de conexión') }
    setCreatingCampaign(false)
  }

  // ─── Export ────────────────────────────────────────────────────────────────
  const handleExport = async () => {
    if (!event) return
    setExporting(true)
    try {
      // Fetch ALL participants for export
      const res = await fetch(`/api/events/${eventId}/participants`, { headers: { Authorization: `Bearer ${getToken()}` } })
      const data = await res.json()
      const allP = data.success ? (data.participants || []) : []
      if (exportFormat === 'excel') { exportToExcel(event, allP) }
      else if (exportFormat === 'csv') { exportToCSV(event, allP) }
      else if (exportFormat === 'word') {
        let interactionsMap: Record<string, any[]> | undefined
        if (exportDetail === 'completo') {
          interactionsMap = {}
          const batchSize = 10
          for (let i = 0; i < allP.length; i += batchSize) {
            const batch = allP.slice(i, i + batchSize)
            const results = await Promise.all(
              batch.map(async (p: Participant) => {
                try {
                  const r = await fetch(`/api/interactions?participant_id=${p.id}`, { headers: { Authorization: `Bearer ${getToken()}` } })
                  const d = await r.json()
                  return { id: p.id, interactions: d.success ? d.interactions || [] : [] }
                } catch { return { id: p.id, interactions: [] } }
              })
            )
            for (const r of results) { interactionsMap![r.id] = r.interactions }
          }
        }
        await generateWordReport({ style: exportStyle, detail: exportDetail, event, participants: allP, interactions: interactionsMap })
      }
      setShowExportModal(false)
    } catch (e) { console.error('Export error:', e); alert('Error al exportar.') }
    finally { setExporting(false) }
  }

  // ─── Effects ───────────────────────────────────────────────────────────────
  useEffect(() => {
    Promise.all([fetchEvent(), fetchDevices()]).then(() => {})
  }, [fetchEvent, fetchDevices])

  useEffect(() => {
    if (event) fetchParticipantsPaginated()
  }, [event, fetchParticipantsPaginated])

  useEffect(() => {
    if (viewMode === 'list' && event) fetchListParticipants(true)
  }, [viewMode, fetchListParticipants, event])

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery), 500)
    return () => clearTimeout(t)
  }, [searchQuery])

  // WebSocket
  useEffect(() => {
    const unsubscribe = subscribeWebSocket((data: unknown) => {
      const msg = data as { event?: string; action?: string; event_id?: string }
      if (msg.event === 'event_participant_update' && msg.event_id === eventId) {
        fetchParticipantsPaginated()
        fetchEvent()
        if (viewMode === 'list') fetchListParticipants(true)
      }
    })
    return () => unsubscribe()
  }, [eventId, fetchParticipantsPaginated, fetchEvent, viewMode, fetchListParticipants])

  // Escape key
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (showExportModal) { setShowExportModal(false); return }
      if (showDeviceSelector) { setShowDeviceSelector(false); return }
      if (showInlineChat) { setShowInlineChat(false); return }
      if (showCampaignModal) { setShowCampaignModal(false); return }
      if (showAddModal) { setShowAddModal(false); return }
      if (showDetailPanel) { setShowDetailPanel(false); setShowInlineChat(false); return }
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [showExportModal, showDeviceSelector, showInlineChat, showCampaignModal, showAddModal, showDetailPanel])

  // Scroll sync for kanban
  const handleTopScroll = () => {
    if (syncingScroll.current) return
    syncingScroll.current = true
    if (kanbanRef.current && topScrollRef.current) kanbanRef.current.scrollLeft = topScrollRef.current.scrollLeft
    syncingScroll.current = false
  }
  const handleKanbanScroll = () => {
    if (syncingScroll.current) return
    syncingScroll.current = true
    if (kanbanRef.current && topScrollRef.current) topScrollRef.current.scrollLeft = kanbanRef.current.scrollLeft
    syncingScroll.current = false
  }

  // List virtualizer
  const listVirtualizer = useVirtualizer({
    count: listParticipants.length,
    getScrollElement: () => listScrollRef.current,
    estimateSize: () => 80,
    overscan: 10,
  })

  // Batch-fetch observations for visible list rows
  useEffect(() => {
    if (viewMode !== 'list' || listParticipants.length === 0) return
    const items = listVirtualizer.getVirtualItems()
    if (items.length === 0) return
    const visibleIds = items.map(item => listParticipants[item.index]?.id).filter(Boolean)
    if (visibleIds.length > 0) fetchBatchObservations(visibleIds)
  }, [viewMode, listVirtualizer.getVirtualItems(), listParticipants, fetchBatchObservations])

  // Infinite scroll for list
  useEffect(() => {
    if (viewMode !== 'list' || !listHasMore || listLoading) return
    const el = listScrollRef.current
    if (!el) return
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = el
      if (scrollHeight - scrollTop - clientHeight < 300) fetchListParticipants(false)
    }
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [viewMode, listHasMore, listLoading, fetchListParticipants])

  const activeFilterCount = filterStageIds.size + filterTagNames.size + excludeFilterTagNames.size + (appliedFormulaType === 'advanced' && appliedFormulaText ? 1 : 0) + (filterDatePreset ? 1 : 0) + (filterHasPhone ? 1 : 0)
  const displayStages = pipelineStages.length > 0 ? pipelineStages : stageData.map(s => ({ id: s.id, pipeline_id: s.pipeline_id, name: s.name, color: s.color, position: s.position }))
  const allUniqueTags = allTags

  // ─── Loading ───────────────────────────────────────────────────────────────
  if (loading || !event) {
    return (
      <div className="flex flex-col h-full min-h-0 animate-pulse p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="h-8 w-8 bg-slate-200 rounded-lg" />
          <div>
            <div className="h-5 w-48 bg-slate-200 rounded" />
            <div className="h-3 w-32 bg-slate-100 rounded mt-1.5" />
          </div>
        </div>
        <div className="h-10 bg-slate-100 rounded-xl mb-4" />
        <div className="flex-1 flex gap-3 overflow-hidden">
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} className="w-[272px] flex-shrink-0">
              <div className="h-10 rounded-t-xl bg-slate-200 mb-2" />
              <div className="space-y-2 p-2">
                {[1, 2, 3].map(j => (
                  <div key={j} className="bg-white p-3 rounded-xl border border-slate-100">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="w-7 h-7 bg-slate-200 rounded-full" />
                      <div className="h-4 w-24 bg-slate-200 rounded" />
                    </div>
                    <div className="h-3 w-32 bg-slate-100 rounded mt-1.5" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Event Header */}
      <div className="flex-shrink-0 pb-3">
        <div className="flex items-center gap-3 mb-2">
          <button onClick={() => router.push('/dashboard/events')} className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: event.color }} />
              <h1 className="text-xl font-bold text-slate-900 truncate">{event.name}</h1>
            </div>
            <div className="flex items-center gap-4 text-sm text-slate-500 mt-0.5 ml-5">
              {event.event_date && (
                <span className="flex items-center gap-1"><CalendarDays className="w-3.5 h-3.5" />{format(new Date(event.event_date), "d MMM yyyy, HH:mm", { locale: es })}</span>
              )}
              {event.location && (
                <span className="flex items-center gap-1"><MapPin className="w-3.5 h-3.5" />{event.location}</span>
              )}
              <span className="flex items-center gap-1"><Users className="w-3.5 h-3.5" />{totalParticipantCount} participantes</span>
            </div>
          </div>
        </div>

        {/* Stage badges */}
        <div className="flex items-center gap-2 flex-wrap ml-8 mb-3">
          {stageData.map(s => (
            <span key={s.id} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium" style={{ backgroundColor: hexBgLight(s.color), color: s.color }}>
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: s.color }} />
              {s.total_count} {s.name.toLowerCase()}
            </span>
          ))}
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-3 ml-8 flex-wrap">
          {/* Search + Filter dropdown container */}
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Buscar participante..."
              className="w-full pl-10 pr-10 py-2 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-slate-900 placeholder:text-slate-400"
            />
            <button
              onClick={() => setShowFilterDropdown(!showFilterDropdown)}
              className={`absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-md transition ${activeFilterCount > 0 ? 'bg-green-100 text-green-700' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'}`}
            >
              <Filter className="w-4 h-4" />
              {activeFilterCount > 0 && (
                <span className="absolute -top-1 -right-1 w-4 h-4 bg-green-600 text-white text-[10px] rounded-full flex items-center justify-center">{activeFilterCount}</span>
              )}
            </button>

            {/* ─── Two-Column Filter Dropdown ─── */}
            {showFilterDropdown && (
              <div className="absolute left-0 top-full mt-2 z-50 bg-white border border-slate-200 rounded-2xl shadow-2xl flex flex-col" style={{ width: 620, maxHeight: '70vh' }} onClick={e => e.stopPropagation()}>
                {/* Header */}
                <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between shrink-0">
                  <div className="flex items-center gap-2.5">
                    <div className="w-1.5 h-4 bg-emerald-500 rounded-full" />
                    <span className="text-sm font-semibold text-slate-800">Filtros</span>
                    {activeFilterCount > 0 && (
                      <span className="text-[10px] font-medium bg-emerald-50 text-emerald-600 px-2 py-0.5 rounded-full">{activeFilterCount} activo{activeFilterCount > 1 ? 's' : ''}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {activeFilterCount > 0 && (
                      <button
                        onClick={() => { setFilterStageIds(new Set()); setFilterTagNames(new Set()); setExcludeFilterTagNames(new Set()); setTagFilterMode('OR'); setFilterHasPhone(false); setPFormulaType('simple'); setPFormulaText(''); setPFormulaIsValid(true); setAppliedFormulaType('simple'); setAppliedFormulaText(''); setFilterDateField('created_at'); setFilterDatePreset(''); setFilterDateFrom(''); setFilterDateTo('') }}
                        className="text-[11px] text-red-400 hover:text-red-600 font-medium transition-colors"
                      >
                        Limpiar todo
                      </button>
                    )}
                    <button onClick={() => setShowFilterDropdown(false)} className="p-1 hover:bg-slate-100 rounded-lg transition-colors">
                      <X className="w-4 h-4 text-slate-400" />
                    </button>
                  </div>
                </div>

                {/* Two-Column Body */}
                <div className="flex flex-1 min-h-0 overflow-hidden">

                  {/* ══ Left Column — Selections ══ */}
                  <div className="w-[240px] shrink-0 border-r border-slate-100 overflow-y-auto p-3 space-y-4 bg-slate-50/30">

                    {/* Stage pills */}
                    {displayStages.length > 0 && (
                      <div>
                        <div className="flex items-center gap-2 mb-2.5">
                          <div className="w-1 h-3.5 bg-slate-300 rounded-full" />
                          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Etapas</p>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {displayStages.map(stage => {
                            const isActive = filterStageIds.has(stage.id)
                            return (
                              <button
                                key={stage.id}
                                onClick={() => {
                                  const next = new Set(filterStageIds)
                                  if (isActive) next.delete(stage.id); else next.add(stage.id)
                                  setFilterStageIds(next)
                                }}
                                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium transition-all border ${
                                  isActive ? 'border-transparent text-white shadow-sm' : 'border-slate-200 text-slate-600 hover:bg-white hover:shadow-sm'
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

                    {/* Date filter */}
                    <div>
                      <div className="flex items-center gap-2 mb-2.5">
                        <div className="w-1 h-3.5 bg-blue-400 rounded-full" />
                        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Fecha</p>
                      </div>
                      <div className="flex flex-wrap gap-1 mb-2">
                        {PARTICIPANT_DATE_FIELDS.map(f => (
                          <button
                            key={f.key}
                            onClick={() => setFilterDateField(f.key)}
                            className={`px-2 py-1 rounded-lg text-[9px] font-semibold transition-all border ${filterDateField === f.key ? 'bg-blue-500 text-white border-blue-500' : 'border-slate-200 text-slate-500 hover:bg-white'}`}
                          >
                            {f.label}
                          </button>
                        ))}
                      </div>
                      <div className="grid grid-cols-2 gap-1">
                        {PARTICIPANT_DATE_PRESETS.map(p => (
                          <button
                            key={p.key}
                            onClick={() => {
                              if (filterDatePreset === p.key) { setFilterDatePreset(''); setFilterDateFrom(''); setFilterDateTo('') }
                              else { setFilterDatePreset(p.key); if (p.key !== 'custom') { setFilterDateFrom(''); setFilterDateTo('') } }
                            }}
                            className={`px-2 py-1.5 rounded-lg text-[10px] font-medium transition-all border ${
                              filterDatePreset === p.key ? 'bg-blue-500 text-white border-blue-500 shadow-sm' : 'border-slate-200 text-slate-600 hover:bg-white hover:shadow-sm'
                            }`}
                          >
                            {p.label}
                          </button>
                        ))}
                      </div>
                      {filterDatePreset === 'custom' && (
                        <div className="mt-2 space-y-1.5">
                          <div>
                            <label className="text-[9px] font-semibold text-slate-400 uppercase">Desde</label>
                            <input type="date" value={filterDateFrom} onChange={e => setFilterDateFrom(e.target.value)} className="w-full px-2 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-400" />
                          </div>
                          <div>
                            <label className="text-[9px] font-semibold text-slate-400 uppercase">Hasta</label>
                            <input type="date" value={filterDateTo} onChange={e => setFilterDateTo(e.target.value)} className="w-full px-2 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-400" />
                          </div>
                        </div>
                      )}
                      {filterDatePreset && filterDatePreset !== 'custom' && (
                        <div className="mt-2 flex items-center gap-1">
                          <Clock className="w-3 h-3 text-blue-500" />
                          <span className="text-[10px] font-medium text-blue-600">{PARTICIPANT_DATE_PRESETS.find(p => p.key === filterDatePreset)?.label}</span>
                          <button onClick={() => { setFilterDatePreset(''); setFilterDateFrom(''); setFilterDateTo('') }} className="ml-auto p-0.5 hover:bg-slate-100 rounded">
                            <X className="w-2.5 h-2.5 text-slate-400" />
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Has phone toggle */}
                    <div>
                      <button onClick={() => setFilterHasPhone(!filterHasPhone)}
                        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium border transition-colors w-full ${filterHasPhone ? 'bg-emerald-50 border-emerald-300 text-emerald-700' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}
                      >
                        <Phone className="w-3.5 h-3.5" />Solo con teléfono
                      </button>
                    </div>

                    {/* Active tag selections */}
                    {allUniqueTags.length > 0 && (
                      <div>
                        <div className="flex items-center gap-2 mb-2.5">
                          <div className="w-1 h-3.5 bg-emerald-400 rounded-full" />
                          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Selección</p>
                        </div>
                        {filterTagNames.size === 0 && excludeFilterTagNames.size === 0 ? (
                          <div className="border-2 border-dashed border-slate-200 rounded-xl p-4 text-center">
                            <Tag className="w-5 h-5 text-slate-300 mx-auto mb-1.5" />
                            <p className="text-[11px] text-slate-400">Haz click en las etiquetas para filtrar</p>
                          </div>
                        ) : (
                          <div className="space-y-3">
                            {filterTagNames.size > 0 && (
                              <div>
                                <div className="flex items-center gap-1.5 mb-1.5">
                                  <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                                  <span className="text-[10px] font-semibold text-emerald-600 uppercase tracking-wide">Incluir</span>
                                </div>
                                <div className="flex flex-wrap gap-1">
                                  {Array.from(filterTagNames).map(name => {
                                    const tag = allUniqueTags.find(t => t.name === name)
                                    return (
                                      <span key={name} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium text-white shadow-sm" style={{ backgroundColor: tag?.color || '#6b7280' }}>
                                        {name}
                                        <button onClick={() => { const next = new Set(filterTagNames); next.delete(name); setFilterTagNames(next) }} className="hover:opacity-75"><X className="w-2.5 h-2.5" /></button>
                                      </span>
                                    )
                                  })}
                                </div>
                              </div>
                            )}
                            {excludeFilterTagNames.size > 0 && (
                              <div>
                                <div className="flex items-center gap-1.5 mb-1.5">
                                  <XCircle className="w-3 h-3 text-red-400" />
                                  <span className="text-[10px] font-semibold text-red-500 uppercase tracking-wide">Excluir</span>
                                </div>
                                <div className="flex flex-wrap gap-1">
                                  {Array.from(excludeFilterTagNames).map(name => {
                                    const tag = allUniqueTags.find(t => t.name === name)
                                    return (
                                      <span key={name} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium text-white/90 line-through shadow-sm" style={{ backgroundColor: tag?.color || '#6b7280' }}>
                                        {name}
                                        <button onClick={() => { const next = new Set(excludeFilterTagNames); next.delete(name); setExcludeFilterTagNames(next) }} className="hover:opacity-75 no-underline"><X className="w-2.5 h-2.5" /></button>
                                      </span>
                                    )
                                  })}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                        <div className="mt-3 pt-3 border-t border-slate-100 space-y-1">
                          <div className="flex items-center gap-2 text-[10px] text-slate-400">
                            <div className="w-3 h-3 rounded-full bg-emerald-500 flex items-center justify-center shrink-0"><CheckSquare className="w-2 h-2 text-white" /></div>
                            <span>Click = incluir</span>
                          </div>
                          <div className="flex items-center gap-2 text-[10px] text-slate-400">
                            <div className="w-3 h-3 rounded-full bg-red-500 flex items-center justify-center shrink-0"><X className="w-2 h-2 text-white" /></div>
                            <span>2do click = excluir</span>
                          </div>
                          <div className="flex items-center gap-2 text-[10px] text-slate-400">
                            <div className="w-3 h-3 rounded-full bg-slate-200 shrink-0" />
                            <span>3ro = quitar</span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* ══ Right Column — Tag Browser ══ */}
                  <div className="flex-1 flex flex-col min-w-0 min-h-0">
                    {allUniqueTags.length > 0 && (
                      <>
                        {/* Top controls */}
                        <div className="p-3 pb-0 shrink-0 space-y-2.5">
                          {/* Simple / Advanced tabs */}
                          <div className="flex rounded-xl border border-slate-200 bg-slate-50/50 overflow-hidden">
                            <button type="button" onClick={() => setPFormulaType('simple')}
                              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-[11px] font-semibold transition-all ${pFormulaType === 'simple' ? 'bg-emerald-500 text-white shadow-sm' : 'text-slate-500 hover:bg-white hover:text-slate-700'}`}>
                              <FileText className="w-3.5 h-3.5" />Simple
                            </button>
                            <button type="button" onClick={() => setPFormulaType('advanced')}
                              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-[11px] font-semibold transition-all ${pFormulaType === 'advanced' ? 'bg-violet-500 text-white shadow-sm' : 'text-slate-500 hover:bg-white hover:text-slate-700'}`}>
                              <Code className="w-3.5 h-3.5" />Avanzado
                            </button>
                          </div>

                          {/* AND/OR toggle in simple mode */}
                          {pFormulaType === 'simple' && (
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Modo:</span>
                              <div className="flex rounded-lg border border-slate-200 overflow-hidden">
                                <button type="button" onClick={() => setTagFilterMode('OR')}
                                  className={`px-3 py-1 text-[10px] font-bold transition-all ${tagFilterMode === 'OR' ? 'bg-emerald-500 text-white' : 'text-slate-500 hover:bg-slate-50'}`}>
                                  OR
                                </button>
                                <button type="button" onClick={() => setTagFilterMode('AND')}
                                  className={`px-3 py-1 text-[10px] font-bold transition-all ${tagFilterMode === 'AND' ? 'bg-amber-500 text-white' : 'text-slate-500 hover:bg-slate-50'}`}>
                                  AND
                                </button>
                              </div>
                              <span className="text-[10px] text-slate-400">{tagFilterMode === 'OR' ? 'Cualquiera' : 'Todas'}</span>
                            </div>
                          )}
                        </div>

                        {/* Simple mode — tag grid */}
                        {pFormulaType === 'simple' ? (
                          <div className="flex-1 overflow-y-auto p-3">
                            <div className="flex flex-wrap gap-1.5">
                              {allUniqueTags.map(tag => {
                                const isInclude = filterTagNames.has(tag.name)
                                const isExclude = excludeFilterTagNames.has(tag.name)
                                return (
                                  <button
                                    key={tag.name}
                                    onClick={() => {
                                      if (!isInclude && !isExclude) {
                                        setFilterTagNames(prev => new Set(prev).add(tag.name))
                                      } else if (isInclude) {
                                        const ni = new Set(filterTagNames); ni.delete(tag.name); setFilterTagNames(ni)
                                        setExcludeFilterTagNames(prev => new Set(prev).add(tag.name))
                                      } else {
                                        const ne = new Set(excludeFilterTagNames); ne.delete(tag.name); setExcludeFilterTagNames(ne)
                                      }
                                    }}
                                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium transition-all border ${
                                      isInclude ? 'text-white border-transparent shadow-sm ring-2 ring-offset-1 ring-emerald-300'
                                      : isExclude ? 'text-white/90 border-transparent shadow-sm line-through ring-2 ring-offset-1 ring-red-300'
                                      : 'border-slate-200 text-slate-600 hover:bg-white hover:shadow-sm'
                                    }`}
                                    style={isInclude || isExclude ? { backgroundColor: tag.color || '#6b7280' } : {}}
                                  >
                                    {!isInclude && !isExclude && <div className="w-2 h-2 rounded-full" style={{ backgroundColor: tag.color || '#6b7280' }} />}
                                    {isInclude && <CheckCircle2 className="w-3 h-3" />}
                                    {isExclude && <XCircle className="w-3 h-3" />}
                                    {tag.name}
                                    <span className="text-[9px] opacity-70">({tag.count})</span>
                                  </button>
                                )
                              })}
                            </div>
                          </div>
                        ) : (
                          /* Advanced mode — formula editor */
                          <div className="flex-1 overflow-y-auto p-3">
                            <FormulaEditor
                              value={pFormulaText}
                              onChange={setPFormulaText}
                              onValidChange={setPFormulaIsValid}
                              tags={allUniqueTags.map(t => ({ name: t.name, color: t.color }))}
                              placeholder={'Ej: ("etiqueta1" or "etiqueta2") and not "excluir"'}
                            />
                            {pFormulaText && !pFormulaIsValid && (
                              <div className="mt-2 flex items-center gap-1.5 text-red-500 text-[11px]">
                                <AlertCircle className="w-3.5 h-3.5" />Fórmula no válida
                              </div>
                            )}
                          </div>
                        )}
                      </>
                    )}
                    {allUniqueTags.length === 0 && (
                      <div className="flex-1 flex items-center justify-center p-6">
                        <div className="text-center">
                          <Tag className="w-6 h-6 text-slate-300 mx-auto mb-2" />
                          <p className="text-xs text-slate-400">No hay etiquetas disponibles</p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Footer — Aplicar */}
                <div className="px-4 py-3 border-t border-slate-100 shrink-0 bg-white rounded-b-2xl">
                  <button
                    onClick={() => {
                      setAppliedFormulaType(pFormulaType)
                      setAppliedFormulaText(pFormulaType === 'advanced' ? pFormulaText : '')
                      setShowFilterDropdown(false)
                    }}
                    disabled={pFormulaType === 'advanced' && !pFormulaIsValid}
                    className="w-full px-4 py-2.5 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 active:bg-emerald-800 disabled:opacity-50 disabled:cursor-not-allowed transition-all text-sm font-semibold shadow-sm shadow-emerald-200 hover:shadow-md hover:shadow-emerald-200"
                  >
                    Aplicar
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="inline-flex items-center border border-slate-200 rounded-lg overflow-hidden">
            <button onClick={() => setViewMode('kanban')} className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium transition ${viewMode === 'kanban' ? 'bg-emerald-50 text-emerald-700' : 'text-slate-500 hover:bg-slate-50'}`}>
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => setViewMode('list')} className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium transition ${viewMode === 'list' ? 'bg-emerald-50 text-emerald-700' : 'text-slate-500 hover:bg-slate-50'}`}>
              <List className="w-3.5 h-3.5" />
            </button>
          </div>

          <button onClick={() => setShowExportModal(true)} className="flex items-center gap-2 px-3 py-2 bg-slate-600 text-white rounded-lg hover:bg-slate-700 text-xs font-medium shadow-sm">
            <Download className="w-3.5 h-3.5" />Exportar
          </button>

          <button
            onClick={async () => {
              fetchDevices()
              try {
                const res = await fetch('/api/campaigns', { headers: { Authorization: `Bearer ${getToken()}` } })
                const data = await res.json()
                const prefix = `Envío - ${event?.name || ''}`
                const count = (data.campaigns || []).filter((c: any) => c.name.startsWith(prefix)).length
                setCampaignInitialName(`${prefix} #${(count + 1).toString().padStart(3, '0')}`)
              } catch { setCampaignInitialName(`Envío - ${event?.name || ''}`) }
              setShowCampaignModal(true)
            }}
            className="flex items-center gap-2 px-3 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 text-xs font-medium shadow-sm"
          >
            <Send className="w-3.5 h-3.5" />Envío Masivo
          </button>

          <button onClick={() => { setAddTab('search'); setShowAddModal(true) }} className="flex items-center gap-2 px-3 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 text-xs font-medium shadow-sm">
            <UserPlus className="w-3.5 h-3.5" />Agregar
          </button>
          <button onClick={() => { setAddTab('manual'); setShowAddModal(true) }} className="p-2 text-slate-500 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition" title="Agregar manualmente">
            <Plus className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* ═══ Kanban View ═══ */}
      {viewMode === 'kanban' && (
        <div className="flex-1 min-h-0 flex flex-col">
          <div ref={topScrollRef} onScroll={handleTopScroll} className="overflow-x-auto kanban-scroll-top flex-shrink-0" style={{ height: 12 }}>
            <div style={{ width: `${(stageData.length + (unassignedData.total_count > 0 ? 1 : 0)) * 288}px`, height: 1 }} />
          </div>
          <div ref={kanbanRef} onScroll={handleKanbanScroll} className="overflow-x-auto flex-1 min-h-0 kanban-scroll">
            <div className="flex gap-3 h-full" style={{ minWidth: `${(stageData.length + (unassignedData.total_count > 0 ? 1 : 0)) * 288}px` }}>
              {stageData.map((stageItem) => (
                <VirtualKanbanColumn
                  key={stageItem.id}
                  column={stageItem}
                  totalCount={stageItem.total_count}
                  hasMore={stageItem.has_more}
                  loadingMore={loadingMoreStages.has(stageItem.id)}
                  onLoadMore={() => loadMoreForStage(stageItem.id)}
                  selectedIds={selectedIds}
                  detailParticipantId={detailParticipant?.id || null}
                  draggedId={draggedId}
                  dragOverColumn={dragOverColumn}
                  selectionMode={selectionMode}
                  onToggleSelection={toggleSelection}
                  onOpenDetail={openDetailPanel}
                  onDelete={handleDeleteParticipant}
                  onDragStart={handleDragStart}
                  onDragEnd={handleDragEnd}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  onRenameStage={handleRenameStage}
                />
              ))}
              {unassignedData.total_count > 0 && (
                <VirtualKanbanColumn
                  key="__unassigned__"
                  column={{ id: '__unassigned__', name: 'Sin etapa', color: '#64748b', participants: unassignedData.participants }}
                  totalCount={unassignedData.total_count}
                  hasMore={unassignedData.has_more}
                  loadingMore={loadingMoreStages.has('__unassigned__')}
                  onLoadMore={() => loadMoreForStage('__unassigned__')}
                  selectedIds={selectedIds}
                  detailParticipantId={detailParticipant?.id || null}
                  draggedId={draggedId}
                  dragOverColumn={dragOverColumn}
                  selectionMode={selectionMode}
                  onToggleSelection={toggleSelection}
                  onOpenDetail={openDetailPanel}
                  onDelete={handleDeleteParticipant}
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

      {/* ═══ List View — Virtualized ═══ */}
      {viewMode === 'list' && (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="bg-slate-50 border-b-2 border-slate-200 flex-shrink-0">
            <div className="flex">
              <div className="px-3 py-2.5 text-[11px] font-semibold text-slate-500 uppercase tracking-wider w-[220px]">Participante</div>
              <div className="px-3 py-2.5 text-[11px] font-semibold text-slate-500 uppercase tracking-wider w-[110px]">Etapa</div>
              <div className="px-3 py-2.5 text-[11px] font-semibold text-slate-500 uppercase tracking-wider w-[180px]">Etiquetas</div>
              <div className="px-3 py-2.5 text-[11px] font-semibold text-slate-500 uppercase tracking-wider flex-1">Observaciones</div>
              <div className="px-3 py-2.5 w-[40px]"></div>
            </div>
          </div>
          <div ref={listScrollRef} className="flex-1 min-h-0 overflow-auto">
            {listParticipants.length > 0 ? (
              <div style={{ height: listVirtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
                {listVirtualizer.getVirtualItems().map((vr) => {
                  const p = listParticipants[vr.index]
                  const obs = listObservations.get(p.id)
                  return (
                    <div key={p.id} ref={listVirtualizer.measureElement} data-index={vr.index}
                      style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vr.start}px)` }}
                    >
                      <div
                        className={`flex items-start group border-b border-slate-200/80 hover:bg-emerald-50/40 hover:shadow-sm transition-all duration-150 cursor-pointer ${
                          detailParticipant?.id === p.id ? 'bg-emerald-50/60 border-l-2 border-l-emerald-500' : 'border-l-2 border-l-transparent'
                        }`}
                        onClick={() => openDetailPanel(p)}
                      >
                        <div className="px-3 py-2.5 w-[220px]">
                          <div className="flex items-center gap-2.5">
                            <div className="w-8 h-8 bg-emerald-50 rounded-full flex items-center justify-center shrink-0">
                              <span className="text-emerald-700 text-xs font-semibold">{(p.name || '?').charAt(0).toUpperCase()}</span>
                            </div>
                            <div className="min-w-0">
                              <p className="text-[13px] font-medium text-slate-900 truncate">{p.name || 'Sin nombre'} {p.last_name || ''}</p>
                              {p.phone && <p className="text-[11px] text-slate-500 mt-0.5">{p.phone}</p>}
                            </div>
                          </div>
                        </div>
                        <div className="px-3 py-2.5 w-[110px]">
                          {p.stage_name ? (
                            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold text-white" style={{ backgroundColor: p.stage_color || '#94a3b8' }}>
                              {p.stage_name}
                            </span>
                          ) : <span className="text-[10px] text-slate-400 italic">Sin etapa</span>}
                        </div>
                        <div className="px-3 py-2.5 w-[180px]">
                          {p.tags && p.tags.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {p.tags.slice(0, 3).map(tag => (
                                <span key={tag.id} className="px-1.5 py-0.5 text-[10px] rounded-full text-white font-medium" style={{ backgroundColor: tag.color || '#6b7280' }}>{tag.name}</span>
                              ))}
                              {p.tags.length > 3 && <span className="text-[10px] text-slate-400">+{p.tags.length - 3}</span>}
                            </div>
                          ) : <span className="text-[10px] text-slate-300">—</span>}
                        </div>
                        <div className="px-3 py-2.5 flex-1 cursor-pointer hover:bg-slate-50 rounded-lg transition-colors"
                          onClick={(e) => { e.stopPropagation(); if (obs && obs.length > 0) { setListHistoryParticipant(p); setListHistoryFilterType(''); setListHistoryFilterFrom(''); setListHistoryFilterTo('') } }}
                        >
                          {loadingListObs.has(p.id) ? (
                            <div className="flex items-center gap-2">
                              <div className="animate-spin rounded-full h-3 w-3 border border-slate-200 border-t-emerald-500" />
                              <span className="text-[10px] text-slate-400">Cargando...</span>
                            </div>
                          ) : obs && obs.length > 0 ? (
                            <div className="space-y-1">
                              {obs.slice(0, 2).map(o => (
                                <div key={o.id} className="flex items-start gap-1.5">
                                  <span className="shrink-0 mt-0.5 text-[10px]">{o.type === 'call' ? '📞' : o.type === 'note' ? '📝' : '↕'}</span>
                                  <p className="text-[11px] text-slate-600 leading-tight">{(o.notes || '').replace(/^\(sinc\)\s*/i, '')}</p>
                                  <span className="shrink-0 text-[9px] text-slate-400 mt-0.5 whitespace-nowrap">{formatDistanceToNow(new Date(o.created_at), { locale: es, addSuffix: false })}</span>
                                </div>
                              ))}
                              {obs.length > 2 && (
                                <span className="text-[10px] text-emerald-600 font-medium inline-flex items-center gap-0.5">
                                  <Maximize2 className="w-3 h-3" /> Ver {obs.length} observaciones
                                </span>
                              )}
                            </div>
                          ) : <span className="text-[10px] text-slate-300 italic">Sin observaciones</span>}
                        </div>
                        <div className="px-3 py-2.5 w-[40px]">
                          <button onClick={(e) => { e.stopPropagation(); handleDeleteParticipant(p.id) }} className="p-1 text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity" title="Eliminar">
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
                <Users className="w-10 h-10 mb-2 text-slate-300" />
                <p className="text-sm">No se encontraron participantes</p>
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

      {/* ═══ List History Modal ═══ */}
      {listHistoryParticipant && (() => {
        const historyObs = listObservations.get(listHistoryParticipant.id) || []
        const filtered = historyObs.filter(obs => {
          if (listHistoryFilterType && obs.type !== listHistoryFilterType) return false
          if (listHistoryFilterFrom && new Date(obs.created_at) < new Date(listHistoryFilterFrom)) return false
          if (listHistoryFilterTo) { const to = new Date(listHistoryFilterTo); to.setDate(to.getDate() + 1); if (new Date(obs.created_at) >= to) return false }
          return true
        })
        return (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-[60] p-4" onClick={() => setListHistoryParticipant(null)}>
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col border border-slate-100" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">Historial Completo</h2>
                  <p className="text-sm text-slate-500">{listHistoryParticipant.name || 'Sin nombre'} — {filtered.length} registros</p>
                </div>
                <button onClick={() => setListHistoryParticipant(null)} className="p-2 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100 transition"><X className="w-5 h-5" /></button>
              </div>
              <div className="px-6 py-3 border-b border-slate-100 bg-slate-50">
                <div className="flex items-center gap-4 flex-wrap">
                  <div>
                    <label className="text-[10px] text-slate-500 uppercase tracking-wider mb-1 block font-semibold">Tipo</label>
                    <select value={listHistoryFilterType} onChange={(e) => setListHistoryFilterType(e.target.value)} className="px-3 py-1.5 border border-slate-200 rounded-xl text-sm text-slate-700 focus:ring-2 focus:ring-emerald-500 bg-white">
                      <option value="">Todos</option><option value="note">Nota</option><option value="call">Llamada</option><option value="whatsapp">WhatsApp</option><option value="email">Email</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] text-slate-500 uppercase tracking-wider mb-1 block font-semibold">Desde</label>
                    <input type="date" value={listHistoryFilterFrom} onChange={(e) => setListHistoryFilterFrom(e.target.value)} className="px-3 py-1.5 border border-slate-200 rounded-xl text-sm text-slate-700 focus:ring-2 focus:ring-emerald-500 bg-white" />
                  </div>
                  <div>
                    <label className="text-[10px] text-slate-500 uppercase tracking-wider mb-1 block font-semibold">Hasta</label>
                    <input type="date" value={listHistoryFilterTo} onChange={(e) => setListHistoryFilterTo(e.target.value)} className="px-3 py-1.5 border border-slate-200 rounded-xl text-sm text-slate-700 focus:ring-2 focus:ring-emerald-500 bg-white" />
                  </div>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-6">
                {filtered.length === 0 ? (
                  <p className="text-sm text-slate-400 text-center py-10">No hay registros</p>
                ) : (
                  <div className="space-y-3">
                    {filtered.map(obs => (
                      <div key={obs.id} className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className={`px-2.5 py-0.5 text-xs rounded-lg font-semibold ${obs.type === 'note' ? 'bg-yellow-100 text-yellow-700' : obs.type === 'call' ? 'bg-blue-100 text-blue-700' : obs.type === 'whatsapp' ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-700'}`}>
                            {obs.type === 'note' ? 'Nota' : obs.type === 'call' ? 'Llamada' : obs.type === 'whatsapp' ? 'WhatsApp' : obs.type}
                          </span>
                          <span className="text-xs text-slate-400">{format(new Date(obs.created_at), "d MMM yyyy, HH:mm", { locale: es })}</span>
                        </div>
                        <p className="text-sm text-slate-800 whitespace-pre-wrap">{obs.notes?.startsWith('(sinc) ') ? obs.notes.slice(7) : (obs.notes || '(sin contenido)')}</p>
                        {obs.created_by_name && <span className="text-xs text-slate-400 mt-1.5 block">por {obs.created_by_name}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )
      })()}

      {/* ═══ Detail Panel (Slide-over) with Inline Chat ═══ */}
      {(showDetailPanel || showInlineChat) && detailParticipant && (
        <div className="fixed inset-0 z-50 flex justify-end overflow-hidden">
          <div
            className="absolute inset-0 bg-black/30 backdrop-blur-[2px]"
            onClick={() => { setShowDetailPanel(false); setShowInlineChat(false) }}
          />
          <div className={`relative h-full bg-white shadow-2xl flex transition-all duration-300 border-l border-slate-200 ${showInlineChat ? 'w-[85vw] max-w-6xl' : 'w-full max-w-md'}`}>
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
            <div className={`${showInlineChat ? 'w-[360px] shrink-0' : 'w-full'} flex flex-col h-full bg-white`}>
              <LeadDetailPanel
                lead={participantToLead(detailParticipant)}
                eventMode={true}
                eventId={eventId}
                eventStages={displayStages.map(s => ({ id: s.id, pipeline_id: s.pipeline_id || '', name: s.name, color: s.color, position: s.position, lead_count: 0 }))}
                participantId={detailParticipant.id}
                onBeforeTagAssign={async (tagId: string) => {
                  const token = localStorage.getItem('token')
                  try {
                    const res = await fetch(`/api/events/${eventId}/participants/${detailParticipant.id}/check-tag-impact`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                      body: JSON.stringify({ tag_id: tagId, action: 'add' }),
                    })
                    const data = await res.json()
                    if (data.would_remove_from_event) {
                      return confirm('⚠️ Agregar esta etiqueta hará que el participante ya NO cumpla con la fórmula del evento y será removido. ¿Deseas continuar?')
                    }
                  } catch (e) { console.error(e) }
                  return true
                }}
                onBeforeTagRemove={async (tagId: string) => {
                  const token = localStorage.getItem('token')
                  try {
                    const res = await fetch(`/api/events/${eventId}/participants/${detailParticipant.id}/check-tag-impact`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                      body: JSON.stringify({ tag_id: tagId, action: 'remove' }),
                    })
                    const data = await res.json()
                    if (data.would_remove_from_event) {
                      return confirm('⚠️ Quitar esta etiqueta hará que el participante ya NO cumpla con la fórmula del evento y será removido. ¿Deseas continuar?')
                    }
                  } catch (e) { console.error(e) }
                  return true
                }}
                onLeadChange={(updatedLead: any) => {
                  // Map back from Lead shape to Participant update
                  updateParticipantInStages(detailParticipant.id, p => ({
                    ...p,
                    name: updatedLead.name || p.name,
                    last_name: updatedLead.last_name || p.last_name,
                    short_name: updatedLead.short_name || p.short_name,
                    phone: updatedLead.phone || p.phone,
                    email: updatedLead.email || p.email,
                    age: updatedLead.age || p.age,
                    dni: updatedLead.dni || p.dni,
                    birth_date: updatedLead.birth_date || p.birth_date,
                    notes: updatedLead.notes ?? p.notes,
                    stage_id: updatedLead.stage_id || p.stage_id,
                    stage_name: updatedLead.stage_name || p.stage_name,
                    stage_color: updatedLead.stage_color || p.stage_color,
                    structured_tags: updatedLead.structured_tags,
                    tags: updatedLead.structured_tags?.map((t: any) => ({ id: t.id, account_id: t.account_id || '', name: t.name, color: t.color, created_at: '' })),
                  }))
                  setDetailParticipant(prev => prev ? {
                    ...prev,
                    name: updatedLead.name || prev.name,
                    last_name: updatedLead.last_name || prev.last_name,
                    short_name: updatedLead.short_name || prev.short_name,
                    phone: updatedLead.phone || prev.phone,
                    email: updatedLead.email || prev.email,
                    age: updatedLead.age || prev.age,
                    dni: updatedLead.dni || prev.dni,
                    birth_date: updatedLead.birth_date || prev.birth_date,
                    notes: updatedLead.notes ?? prev.notes,
                    stage_id: updatedLead.stage_id || prev.stage_id,
                    stage_name: updatedLead.stage_name || prev.stage_name,
                    stage_color: updatedLead.stage_color || prev.stage_color,
                    tags: updatedLead.structured_tags?.map((t: any) => ({ id: t.id, account_id: t.account_id || '', name: t.name, color: t.color, created_at: '' })),
                  } : null)
                }}
                onStageChange={(stageId: string, stageName: string, stageColor: string) => {
                  // Move participant between stages in kanban
                  handleStageChange(detailParticipant.id, stageId)
                }}
                onClose={() => { setShowDetailPanel(false); setShowInlineChat(false) }}
                onSendWhatsApp={(phone: string) => handleSendWhatsApp(phone)}
                onDelete={(id: string) => {
                  removeParticipantFromStages(detailParticipant.id)
                  setShowDetailPanel(false)
                  setShowInlineChat(false)
                  fetchEvent()
                }}
                hideWhatsApp={showInlineChat}
              />
            </div>
          </div>
        </div>
      )}

      {/* ═══ Add Participant — ContactSelector ═══ */}
      <ContactSelector
        open={showAddModal && addTab === 'search'}
        onClose={() => setShowAddModal(false)}
        onConfirm={handleAddFromSelector}
        title="Agregar Participantes"
        subtitle="Busca entre tus contactos y leads para agregar al evento"
        confirmLabel="Agregar"
        excludeIds={existingContactIds}
      />

      {/* ═══ Add Participant — Manual ═══ */}
      {showAddModal && addTab === 'manual' && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-hidden flex flex-col border border-slate-100">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <h2 className="text-lg font-semibold text-slate-900">Agregar Manualmente</h2>
              <button onClick={() => setShowAddModal(false)} className="p-1, text-slate-400 hover:text-slate-600 rounded"><X className="w-5 h-5" /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Nombre *</label>
                    <input value={manualForm.name} onChange={e => setManualForm(f => ({ ...f, name: e.target.value }))} className="w-full px-4 py-2 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-slate-900" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Apellido</label>
                    <input value={manualForm.last_name} onChange={e => setManualForm(f => ({ ...f, last_name: e.target.value }))} className="w-full px-4 py-2 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-slate-900" />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Nombre Corto</label>
                  <input value={manualForm.short_name} onChange={e => setManualForm(f => ({ ...f, short_name: e.target.value }))} placeholder="Apodo o nombre corto" className="w-full px-4 py-2 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-slate-900" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Teléfono</label>
                  <input value={manualForm.phone} onChange={e => setManualForm(f => ({ ...f, phone: e.target.value }))} className="w-full px-4 py-2 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-slate-900" placeholder="+51..." />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
                  <input value={manualForm.email} onChange={e => setManualForm(f => ({ ...f, email: e.target.value }))} type="email" className="w-full px-4 py-2 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-slate-900" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Edad</label>
                  <input value={manualForm.age} onChange={e => setManualForm(f => ({ ...f, age: e.target.value }))} type="number" className="w-full px-4 py-2 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-slate-900" />
                </div>
              </div>
              <button onClick={() => setAddTab('search')} className="mt-4 text-sm text-emerald-600 hover:text-emerald-700 font-medium">
                Buscar contacto/lead existente
              </button>
            </div>
            <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-3">
              <button onClick={() => setShowAddModal(false)} className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-xl text-sm">Cancelar</button>
              <button onClick={handleAddManual} disabled={!manualForm.name} className="px-6 py-2 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 disabled:opacity-50 font-medium text-sm">Agregar</button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ Device Selector ═══ */}
      {showDeviceSelector && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-[60] p-4">
          <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm border border-slate-100">
            <h2 className="text-sm font-semibold text-slate-900 mb-3">Seleccionar dispositivo</h2>
            <p className="text-xs text-slate-500 mb-4">Elige el dispositivo para el chat con {whatsappPhone}</p>
            {devices.length === 0 ? (
              <p className="text-xs text-slate-400 text-center py-4">No hay dispositivos conectados</p>
            ) : (
              <div className="space-y-2">
                {devices.map(device => (
                  <button key={device.id} onClick={() => handleDeviceSelectedForChat(device)}
                    className="w-full flex items-center gap-3 p-3 border border-slate-100 rounded-xl hover:bg-emerald-50 hover:border-emerald-200 transition text-left"
                  >
                    <div className="w-9 h-9 bg-emerald-50 rounded-full flex items-center justify-center"><Phone className="w-4 h-4 text-emerald-600" /></div>
                    <div>
                      <p className="text-sm font-medium text-slate-900">{device.name || 'Dispositivo'}</p>
                      <p className="text-xs text-slate-500">{device.phone_number || ''}</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
            <button onClick={() => setShowDeviceSelector(false)} className="w-full mt-4 px-4 py-2 border border-slate-200 text-slate-600 rounded-xl hover:bg-slate-50 text-sm">Cancelar</button>
          </div>
        </div>
      )}

      {/* ═══ Campaign Modal ═══ */}
      <CreateCampaignModal
        open={showCampaignModal}
        onClose={() => setShowCampaignModal(false)}
        onSubmit={handleCreateCampaign}
        devices={devices}
        title="Envío Masivo desde Evento"
        subtitle="Crea una campaña con los participantes que tengan teléfono"
        accentColor="purple"
        submitLabel={creatingCampaign ? 'Creando...' : `Crear campaña (${participantsWithPhone.length})`}
        submitting={creatingCampaign || participantsWithPhone.length === 0}
        initialName={campaignInitialName || `Envío - ${event?.name || ''}`}
        infoPanel={
          <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <Users className="w-4 h-4 text-purple-600" />
              <span className="text-sm font-semibold text-purple-800">{participantsWithPhone.length} destinatarios con teléfono</span>
            </div>
            <p className="text-xs text-purple-500 mt-2">Puedes ajustar los filtros arriba antes de crear la campaña</p>
          </div>
        }
      />

      {/* ═══ Export Modal ═══ */}
      {showExportModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4" onClick={() => !exporting && setShowExportModal(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-5 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-slate-50/50">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-slate-600 flex items-center justify-center"><FileDown className="w-5 h-5 text-white" /></div>
                  <div>
                    <h2 className="text-lg font-bold text-slate-900">Exportar Evento</h2>
                    <p className="text-sm text-slate-500">{totalParticipantCount} participantes</p>
                  </div>
                </div>
                <button onClick={() => !exporting && setShowExportModal(false)} className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100"><X className="w-5 h-5" /></button>
              </div>
            </div>
            <div className="p-6 space-y-6">
              <div>
                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3 block">Formato</label>
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { key: 'excel' as const, label: 'Excel', desc: 'Hoja de cálculo', icon: FileSpreadsheet, color: 'emerald' },
                    { key: 'csv' as const, label: 'CSV', desc: 'Texto plano', icon: FileText, color: 'blue' },
                    { key: 'word' as const, label: 'Word', desc: 'Informe detallado', icon: FileDown, color: 'indigo' },
                  ].map(f => (
                    <button key={f.key} onClick={() => setExportFormat(f.key)}
                      className={`relative flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all ${
                        exportFormat === f.key
                          ? `border-${f.color}-500 bg-${f.color}-50 ring-2 ring-${f.color}-200`
                          : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      <f.icon className={`w-8 h-8 ${exportFormat === f.key ? `text-${f.color}-600` : 'text-slate-400'}`} />
                      <span className={`text-sm font-semibold ${exportFormat === f.key ? 'text-slate-900' : 'text-slate-600'}`}>{f.label}</span>
                      <span className="text-[11px] text-slate-400">{f.desc}</span>
                      {exportFormat === f.key && (
                        <div className={`absolute top-2 right-2 w-5 h-5 rounded-full flex items-center justify-center bg-${f.color}-500`}>
                          <CheckCircle2 className="w-3.5 h-3.5 text-white" />
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </div>
              {exportFormat === 'word' && (
                <div className="space-y-5">
                  <div>
                    <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3 block">Estilo del Informe</label>
                    <div className="space-y-2">
                      {[
                        { key: 'gerencia' as ReportStyle, label: 'Ejecutivo', desc: 'Formal, profesional.', emoji: '📊' },
                        { key: 'informal' as ReportStyle, label: 'Informal', desc: 'Amigable, relajado.', emoji: '😊' },
                        { key: 'divertido' as ReportStyle, label: 'Divertido', desc: 'Colorido, con emojis.', emoji: '🎉' },
                      ].map(s => (
                        <button key={s.key} onClick={() => setExportStyle(s.key)}
                          className={`w-full flex items-center gap-4 p-3.5 rounded-xl border-2 text-left transition-all ${exportStyle === s.key ? 'border-emerald-500 bg-emerald-50' : 'border-slate-200 hover:border-slate-300'}`}
                        >
                          <span className="text-2xl">{s.emoji}</span>
                          <div><span className="text-sm font-semibold text-slate-800">{s.label}</span><p className="text-xs text-slate-500 mt-0.5">{s.desc}</p></div>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3 block">Nivel de Detalle</label>
                    <div className="grid grid-cols-3 gap-2">
                      {[
                        { key: 'basico' as DetailLevel, label: 'Básico', desc: 'Resumen y lista' },
                        { key: 'detallado' as DetailLevel, label: 'Detallado', desc: 'Datos completos' },
                        { key: 'completo' as DetailLevel, label: 'Completo', desc: 'Con interacciones' },
                      ].map(d => (
                        <button key={d.key} onClick={() => setExportDetail(d.key)}
                          className={`flex flex-col items-center gap-1 p-3 rounded-xl border-2 transition-all ${exportDetail === d.key ? 'border-slate-500 bg-slate-50' : 'border-slate-200 hover:border-slate-300'}`}
                        >
                          <span className={`text-sm font-semibold ${exportDetail === d.key ? 'text-slate-900' : 'text-slate-600'}`}>{d.label}</span>
                          <span className="text-[11px] text-slate-400 text-center">{d.desc}</span>
                        </button>
                      ))}
                    </div>
                    {exportDetail === 'completo' && (
                      <p className="text-xs text-amber-600 mt-2 flex items-center gap-1"><Clock className="w-3 h-3" />Cargará interacciones de cada participante.</p>
                    )}
                  </div>
                </div>
              )}
            </div>
            <div className="px-6 py-4 border-t border-slate-100 bg-slate-50 flex items-center justify-between">
              <button onClick={() => !exporting && setShowExportModal(false)} disabled={exporting} className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-800 rounded-lg hover:bg-slate-100 disabled:opacity-50">Cancelar</button>
              <button onClick={handleExport} disabled={exporting}
                className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white shadow-sm transition-all ${
                  exportFormat === 'excel' ? 'bg-emerald-600 hover:bg-emerald-700' : exportFormat === 'csv' ? 'bg-blue-600 hover:bg-blue-700' : 'bg-indigo-600 hover:bg-indigo-700'
                } disabled:opacity-50`}
              >
                {exporting ? <><Loader2 className="w-4 h-4 animate-spin" />Generando...</> : <><Download className="w-4 h-4" />{exportFormat === 'excel' ? 'Descargar Excel' : exportFormat === 'csv' ? 'Descargar CSV' : 'Generar Informe'}</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ Floating Bulk Action Bar ═══ */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 bg-white border border-slate-200 px-4 py-2.5 rounded-2xl shadow-2xl shadow-slate-300/40 max-w-[95vw] flex-wrap">
          <span className="text-sm font-semibold text-slate-800 tabular-nums whitespace-nowrap">
            {selectedIds.size} seleccionado{selectedIds.size !== 1 ? 's' : ''}
          </span>
          <div className="w-px h-5 bg-slate-200 mx-1" />
          <span className="text-xs text-slate-400 whitespace-nowrap">Mover a:</span>
          {displayStages.map(s => (
            <button key={s.id} onClick={() => handleBulkMove(s.id)} disabled={bulkMoving}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all disabled:opacity-50 hover:opacity-80"
              style={{ backgroundColor: hexBgLight(s.color), color: s.color }}
            >
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: s.color }} />
              {s.name}
              {bulkMoving && <Loader2 className="w-3 h-3 animate-spin ml-1" />}
            </button>
          ))}
          <div className="w-px h-5 bg-slate-200 mx-1" />
          <button onClick={() => setSelectedIds(new Set())} className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors" title="Deseleccionar">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  )
}
