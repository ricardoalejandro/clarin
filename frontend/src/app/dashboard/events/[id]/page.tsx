'use client'

import { useEffect, useState, useCallback, useMemo, useRef, memo } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import {
  ArrowLeft, Users, UserPlus, Search, Phone, MessageSquare, Mail,
  CheckCircle2, Clock, GripVertical, List, LayoutGrid, X, Plus, Trash2,
  Filter, Send, Maximize2, CalendarDays, Download,
  FileSpreadsheet, FileText, FileDown, Loader2, StickyNote,
  Tag, CheckSquare, XCircle, Code, AlertCircle, AlertTriangle, BookOpen, Camera, Edit3,
  ChevronRight, PenLine, Settings, Lock, ShieldBan,
  MoreHorizontal, ChevronDown, RefreshCw, Copy, ArrowUp, ArrowDown
} from 'lucide-react'
import { format, formatDistanceToNow } from 'date-fns'
import { es } from 'date-fns/locale'
import { useVirtualizer } from '@tanstack/react-virtual'
import CreateCampaignModal, { CampaignFormResult } from '@/components/CreateCampaignModal'
import ContactSelector, { SelectedPerson } from '@/components/ContactSelector'
import ChatPanel from '@/components/chat/ChatPanel'
import LeadDetailPanel from '@/components/LeadDetailPanel'
import { useAccessibleDialog } from '@/components/pipelines/useAccessibleDialog'
import ObservationHistoryModal from '@/components/ObservationHistoryModal'
import FormulaEditor from '@/components/FormulaEditor'
import { Chat } from '@/types/chat'
import { exportToExcel, exportToCSV } from '@/utils/eventExport'
import { generateWordReport, type ReportStyle, type DetailLevel } from '@/utils/eventWordReport'
import { subscribeWebSocket } from '@/lib/api'
import { createWhatsAppChat, deviceDisplayPhone, relationClassName, relationLabel, resolveWhatsAppChat, type WhatsAppDeviceOption } from '@/lib/whatsappChatLauncher'
import { useKanbanPan } from '@/lib/useKanbanPan'

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

const STAGE_COLOR_OPTIONS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#6366f1', '#14b8a6', '#64748b']

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
  tag_formula?: string; tag_formula_type?: string; tag_formula_mode?: string
  has_membership_rules?: boolean
}

interface TagItem {
  id: string; account_id: string; name: string; color: string; created_at: string
}

interface Participant {
  id: string; event_id: string; contact_id?: string; name: string
  last_name?: string; short_name?: string; phone?: string; email?: string
  age?: number; status: string; notes?: string; dni?: string; birth_date?: string
  company?: string; address?: string; distrito?: string; ocupacion?: string
  stage_id?: string; stage_name?: string; stage_color?: string
  next_action?: string; next_action_date?: string; invited_at?: string
  confirmed_at?: string; attended_at?: string; last_interaction?: string
  tags?: TagItem[]
  duplicate_contact?: boolean
  is_archived?: boolean
  is_blocked?: boolean
  auto_tag_sync?: boolean
  membership_state?: string
  membership_source?: string
  membership_reason?: string
  membership_changed_at?: string
  active_lead_count?: number
  related_leads?: RelatedLeadSummary[]
}

interface RelatedLeadSummary {
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

interface PipelineStage {
  id: string; pipeline_id: string; name: string; color: string; position: number
  participant_count?: number
}

interface DraftStage {
  id: string
  pipeline_id: string
  name: string
  color: string
  position: number
  total_count: number
  isNew?: boolean
  clientId?: string
  isDeleted?: boolean
}

interface DraftStageDeletion {
  stageId: string
  stageName: string
  totalCount: number
  moveToStageId: string
}

interface Observation {
  id: string; contact_id: string | null; lead_id: string | null; type: string
  direction: string | null; outcome: string | null; notes: string | null
  created_by_name: string | null; created_at: string
}

interface MembershipHistoryEntry {
  id: string
  action: string
  participant_id?: string
  contact_id?: string
  actor_type: string
  actor_user_id?: string
  source: string
  rule_revision: number
  before_state: Record<string, unknown>
  after_state: Record<string, unknown>
  metadata: Record<string, unknown>
  created_at: string
}

interface StageData {
  id: string; pipeline_id: string; name: string; color: string; position: number
  total_count: number; participants: Participant[]; has_more: boolean
}

interface TagInfo { name: string; color: string; count: number }

interface Device {
  id: string; name: string; phone?: string | null; phone_number?: string; jid?: string | null; status: string
  normalized_phone?: string; historical_relation?: WhatsAppDeviceOption['historical_relation']; matches_historical?: boolean
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
    id: p.id,
    original_lead_id: null,
    name: p.name || '',
    last_name: p.last_name || null,
    short_name: p.short_name || null,
    phone: p.phone || '',
    email: p.email || '',
    company: p.company || null,
    age: p.age || null,
    dni: p.dni || null,
    birth_date: p.birth_date || null,
    address: p.address || null,
    distrito: p.distrito || null,
    ocupacion: p.ocupacion || null,
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
    is_archived: p.is_archived || false,
    is_blocked: p.is_blocked || false,
  }
}

// ─── Memoized ParticipantCard ────────────────────────────────────────────────
interface ParticipantCardProps {
  participant: Participant
  isSelected: boolean
  isDetailActive: boolean
  isDragged: boolean
  selectionMode: boolean
  canDrag?: boolean
  canDelete?: boolean
  onToggleSelection: (id: string) => void
  onOpenDetail: (p: Participant) => void
  onDelete: (id: string) => void
  onDragStart: (e: React.DragEvent, id: string) => void
  onDragEnd: (e: React.DragEvent) => void
}

const ParticipantCard = memo(function ParticipantCard({
  participant: p, isSelected, isDetailActive, isDragged, selectionMode,
  canDrag = true,
  canDelete = true,
  onToggleSelection, onOpenDetail, onDelete, onDragStart, onDragEnd,
}: ParticipantCardProps) {
  return (
    <div
      draggable={!selectionMode && canDrag}
      onDragStart={(e) => onDragStart(e, p.id)}
      onDragEnd={onDragEnd}
      className={`bg-white p-3 rounded-xl shadow-sm border hover:shadow-md transition cursor-pointer ${
        isSelected ? 'border-emerald-500 ring-2 ring-emerald-100'
        : isDetailActive ? 'border-emerald-400 ring-2 ring-emerald-200 bg-emerald-50/50'
        : 'border-slate-100'
      } ${isDragged ? 'opacity-50' : ''} ${!selectionMode && canDrag ? 'cursor-grab active:cursor-grabbing' : ''}`}
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
          {p.duplicate_contact && (
            <span title="Este contacto aparece más de una vez en el evento" className="ml-1 text-amber-500">
              <AlertTriangle className="w-3.5 h-3.5" />
            </span>
          )}
        </div>
        {!selectionMode && canDelete && (
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
  onColorStage?: (stageId: string, color: string) => void
  onDeleteStage?: (stageId: string, stageName: string, totalCount: number) => void
  canManageStage?: boolean
  canDragParticipants?: boolean
  stageEditMode?: boolean
  onStageDragStart?: (stageId: string) => void
  onStageDrop?: (stageId: string) => void
  isStageDragging?: boolean
}

const VirtualKanbanColumn = memo(function VirtualKanbanColumn({
  column, totalCount, hasMore, loadingMore, onLoadMore,
  selectedIds, detailParticipantId, draggedId, dragOverColumn, selectionMode,
  onToggleSelection, onOpenDetail, onDelete, onDragStart, onDragEnd, onDragOver, onDragLeave, onDrop,
  onRenameStage, onColorStage, onDeleteStage, canManageStage = true, canDragParticipants = true,
  stageEditMode = false, onStageDragStart, onStageDrop, isStageDragging = false,
}: VirtualColumnProps) {
  const parentRef = useRef<HTMLDivElement>(null)
  const [editingName, setEditingName] = useState(false)
  const [editName, setEditName] = useState(column.name)
  const editInputRef = useRef<HTMLInputElement>(null)
  const virtualizer = useVirtualizer({
    count: column.participants.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 140,
    overscan: 5,
    measureElement: (el) => el?.getBoundingClientRect().height || 140,
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

  useEffect(() => {
    setEditName(column.name)
  }, [column.name])

  return (
    <div
      className={`w-[272px] flex-shrink-0 flex flex-col transition ${isStageDragging ? 'opacity-60' : ''}`}
      style={{ maxHeight: '100%' }}
      draggable={stageEditMode && Boolean(onStageDragStart)}
      onDragStart={(e) => {
        if (!stageEditMode || !onStageDragStart) return
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('application/x-event-stage', column.id)
        onStageDragStart(column.id)
      }}
      onDragOver={(e) => {
        if (!stageEditMode || !onStageDrop) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
      }}
      onDrop={(e) => {
        if (!stageEditMode || !onStageDrop) return
        e.preventDefault()
        onStageDrop(column.id)
      }}
    >
      <div
        className="px-3 py-2.5 rounded-t-xl sticky top-0 z-10 shrink-0"
        style={{ background: `linear-gradient(135deg, ${column.color}30, ${column.color}18)`, borderBottom: `3px solid ${column.color}`, boxShadow: `0 2px 8px ${column.color}20` }}
      >
        <div className="flex items-center justify-between gap-2">
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
            <div className="flex items-center gap-1.5 min-w-0">
              {stageEditMode && <GripVertical className="w-3.5 h-3.5 text-slate-400 shrink-0 cursor-grab" />}
              <span
                className={`text-sm font-bold tracking-wide uppercase text-slate-800 truncate ${canManageStage ? 'cursor-pointer hover:text-emerald-700 transition-colors' : ''}`}
                onDoubleClick={() => { if (canManageStage) { setEditName(column.name); setEditingName(true); setTimeout(() => editInputRef.current?.select(), 50) } }}
                title={canManageStage ? 'Doble clic para editar' : undefined}
              >{column.name}</span>
            </div>
          )}
          <div className="flex items-center gap-1.5 shrink-0">
            {column.participants.length < totalCount && (
              <span className="text-[10px] text-slate-500 font-medium tabular-nums">{column.participants.length}/</span>
            )}
            <span className="text-xs px-2 py-0.5 rounded-full font-bold text-white tabular-nums" style={{ backgroundColor: column.color }}>{totalCount}</span>
            {canManageStage && onDeleteStage && (
              <button
                onClick={() => onDeleteStage(column.id, column.name, totalCount)}
                className="p-1 rounded-md text-slate-400 hover:text-red-600 hover:bg-white/70 transition-colors"
                title="Eliminar etapa"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
      {stageEditMode && canManageStage && (
        <div className="px-3 py-2 bg-white border-x border-slate-100 flex items-center gap-1.5">
          {STAGE_COLOR_OPTIONS.map(color => (
            <button
              key={color}
              type="button"
              onClick={() => onColorStage?.(column.id, color)}
              className={`w-5 h-5 rounded-full border transition ${column.color === color ? 'border-slate-900 scale-110' : 'border-white hover:scale-105'}`}
              style={{ backgroundColor: color }}
              title={color}
            />
          ))}
        </div>
      )}
      <div
        ref={parentRef}
        className={`bg-slate-50/80 p-2 flex-1 overflow-y-auto kanban-col-scroll transition-colors ${
          canDragParticipants && dragOverColumn === column.id ? 'bg-emerald-50 ring-2 ring-emerald-300 ring-inset' : ''
        }`}
        style={{ minHeight: 200 }}
        onDragOver={canDragParticipants ? (e) => onDragOver(e, column.id) : undefined}
        onDragLeave={canDragParticipants ? onDragLeave : undefined}
        onDrop={canDragParticipants ? (e) => onDrop(e, column.id) : undefined}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const p = column.participants[vi.index]
            return (
              <div key={p.id} ref={virtualizer.measureElement} data-index={vi.index} style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}>
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
                    canDrag={canDragParticipants}
                    canDelete={canDragParticipants}
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
  const searchParams = useSearchParams()
  const eventId = params.id as string
  const folderParam = searchParams.get('folder')

  // Core data
  const [event, setEvent] = useState<Event | null>(null)
  const [stageData, setStageData] = useState<StageData[]>([])
  const [unassignedData, setUnassignedData] = useState<{ total_count: number; participants: Participant[]; has_more: boolean }>({ total_count: 0, participants: [], has_more: false })
  const [allTags, setAllTags] = useState<TagInfo[]>([])
  const [pipelineStages, setPipelineStages] = useState<PipelineStage[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMoreStages, setLoadingMoreStages] = useState<Set<string>>(new Set())
  const participantRequestRef = useRef(0)
  const participantAbortRef = useRef<AbortController | null>(null)
  const participantGenerationRef = useRef(0)
  const stageAbortRefs = useRef<Map<string, AbortController>>(new Map())

  // UI state
  const [viewMode, setViewMode] = useState<'kanban' | 'list' | 'logbook'>('kanban')
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [showFilterDropdown, setShowFilterDropdown] = useState(false)
  const [filterStageIds, setFilterStageIds] = useState<Set<string>>(new Set())
  const [filterTagNames, setFilterTagNames] = useState<Set<string>>(new Set())
  const [excludeFilterTagNames, setExcludeFilterTagNames] = useState<Set<string>>(new Set())
  const [tagFilterMode, setTagFilterMode] = useState<'OR' | 'AND'>('OR')
  const [filterHasPhone, setFilterHasPhone] = useState(false)
  // Formula filter
  const [tagSearchQuery, setTagSearchQuery] = useState('')
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
  const [detailParticipantLoading, setDetailParticipantLoading] = useState(false)
  const [detailParticipantError, setDetailParticipantError] = useState('')
  const detailParticipantRequestRef = useRef(0)
  const detailPanelDialogRef = useRef<HTMLDivElement>(null)
  const detailPreviousFocusRef = useRef<HTMLElement | null>(null)
  const [showMembershipHistory, setShowMembershipHistory] = useState(false)
  const [membershipHistory, setMembershipHistory] = useState<MembershipHistoryEntry[]>([])
  const [membershipHistoryLoading, setMembershipHistoryLoading] = useState(false)

  // Track own stage changes to avoid WebSocket refetch race condition
  const ownStageChangeRef = useRef(false)
  const ownStageTimerRef = useRef<NodeJS.Timeout | null>(null)

  // WhatsApp inline chat
  const [showInlineChat, setShowInlineChat] = useState(false)
  const [inlineChatId, setInlineChatId] = useState('')
  const [inlineChat, setInlineChat] = useState<Chat | null>(null)
  const [inlineChatDeviceId, setInlineChatDeviceId] = useState('')
  const [inlineChatReadOnly, setInlineChatReadOnly] = useState(false)
  const [showDeviceSelector, setShowDeviceSelector] = useState(false)
  const [devices, setDevices] = useState<Device[]>([])
  const [whatsappPhone, setWhatsappPhone] = useState('')
  const [existingChatForWA, setExistingChatForWA] = useState<Chat | null>(null)
  const [whatsappHistoricalPhone, setWhatsappHistoricalPhone] = useState('')
  const whatsappPhoneRef = useRef('')

  // Add participant
  const [showAddModal, setShowAddModal] = useState(false)
  const [addTab, setAddTab] = useState<'search' | 'manual'>('search')
  const [manualForm, setManualForm] = useState({ name: '', last_name: '', short_name: '', phone: '', email: '', age: '' })
  const [addingParticipant, setAddingParticipant] = useState(false)
  const [addParticipantError, setAddParticipantError] = useState('')
  const [participantCandidatesRevision, setParticipantCandidatesRevision] = useState(0)
  const manualContactDialogRef = useRef<HTMLDivElement>(null)
  const manualContactNameRef = useRef<HTMLInputElement>(null)
  const doNotContactDialogRef = useRef<HTMLDivElement>(null)
  const doNotContactFirstChoiceRef = useRef<HTMLButtonElement>(null)

  // Export
  const [showExportModal, setShowExportModal] = useState(false)
  const [exportFormat, setExportFormat] = useState<'excel' | 'csv' | 'word'>('excel')
  const [exportScope, setExportScope] = useState<'all' | 'filtered'>('all')
  const [exportStyle, setExportStyle] = useState<ReportStyle>('gerencia')
  const [exportDetail, setExportDetail] = useState<DetailLevel>('detallado')
  const [exporting, setExporting] = useState(false)

  // Campaign
  const [showCampaignModal, setShowCampaignModal] = useState(false)
  const [creatingCampaign, setCreatingCampaign] = useState(false)
  const [campaignInitialName, setCampaignInitialName] = useState('')

  // More menu
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const moreMenuRef = useRef<HTMLDivElement>(null)

  // Stage management
  const [showStageModal, setShowStageModal] = useState(false)
  const [showStageEditorModal, setShowStageEditorModal] = useState(false)
  const [newStageName, setNewStageName] = useState('')
  const [newStageColor, setNewStageColor] = useState('#3b82f6')
  const [stageEditMode, setStageEditMode] = useState(false)
  const [draftStages, setDraftStages] = useState<DraftStage[]>([])
  const [draftDeletedStages, setDraftDeletedStages] = useState<DraftStageDeletion[]>([])
  const [stageLayoutSaving, setStageLayoutSaving] = useState(false)
  const [stageLayoutError, setStageLayoutError] = useState('')
  const [draggedStageId, setDraggedStageId] = useState<string | null>(null)
  const [duplicatingEvent, setDuplicatingEvent] = useState(false)

  // Google Sync
  const [showGoogleSyncModal, setShowGoogleSyncModal] = useState(false)
  const [googleSyncStatus, setGoogleSyncStatus] = useState<{ total: number; synced: number; pending: number; no_contact: number } | null>(null)
  const [googleSyncLoading, setGoogleSyncLoading] = useState(false)
  const [googleSyncing, setGoogleSyncing] = useState(false)
  const [googleConnected, setGoogleConnected] = useState(false)

  // List view
  const [listParticipants, setListParticipants] = useState<Participant[]>([])
  const [listTotal, setListTotal] = useState(0)
  const [listHasMore, setListHasMore] = useState(false)
  const [listLoading, setListLoading] = useState(false)
  const listOffsetRef = useRef(0)
  const listRequestRef = useRef(0)
  const listAbortRef = useRef<AbortController | null>(null)
  const listScrollRef = useRef<HTMLDivElement>(null)
  const [listObservations, setListObservations] = useState<Map<string, Observation[]>>(new Map())
  const [loadingListObs, setLoadingListObs] = useState<Set<string>>(new Set())
  const [listHistoryParticipant, setListHistoryParticipant] = useState<Participant | null>(null)

  // ── Logbook (Bitácora) state ──
  interface Logbook {
    id: string; event_id: string; account_id: string; date: string; title: string
    status: string; general_notes: string; stage_snapshot: Record<string, { name: string; color: string; count: number }>
    total_participants: number; captured_at: string | null; created_by: string | null
    created_by_name: string | null; created_at: string; updated_at: string
    entries?: LogbookEntry[]
    saved_filter?: Record<string, unknown> | null
  }
  interface LogbookEntry {
    id: string; logbook_id: string; participant_id: string; stage_id: string | null
    stage_name: string; stage_color: string; notes: string; created_at: string
    participant_name: string; participant_phone: string | null
  }
  // Helper: parse logbook date without timezone shift (dates stored as UTC midnight)
  const parseLogbookDate = (dateStr: string) => {
    if (!dateStr) return new Date()
    // If it's a full ISO string with T00:00:00Z, extract just the date part and parse as local noon
    const dateOnly = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr.slice(0, 10)
    return new Date(dateOnly + 'T12:00:00')
  }
  const [logbooks, setLogbooks] = useState<Logbook[]>([])
  const [logbooksLoading, setLogbooksLoading] = useState(false)
  const [selectedLogbook, setSelectedLogbook] = useState<Logbook | null>(null)
  const [selectedLogbookLoading, setSelectedLogbookLoading] = useState(false)
  const [showNewLogbookModal, setShowNewLogbookModal] = useState(false)
  const [showLogbookSettingsModal, setShowLogbookSettingsModal] = useState(false)
  const [logbookSettingsTitle, setLogbookSettingsTitle] = useState('')
  const [logbookSettingsDate, setLogbookSettingsDate] = useState('')
  const [logbookSettingsStatus, setLogbookSettingsStatus] = useState('pending')
  const [logbookSettingsUpdating, setLogbookSettingsUpdating] = useState(false)
  const [newLogbookDate, setNewLogbookDate] = useState('')
  const [newLogbookTitle, setNewLogbookTitle] = useState('')
  const [newLogbookCaptureNow, setNewLogbookCaptureNow] = useState(false)
  const [creatingLogbook, setCreatingLogbook] = useState(false)
  const [capturingSnapshot, setCapturingSnapshot] = useState(false)
  const [editingLogbookNotes, setEditingLogbookNotes] = useState(false)
  const [logbookNotesText, setLogbookNotesText] = useState('')
  const [savingLogbookNotes, setSavingLogbookNotes] = useState(false)
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null)
  const [entryNotesText, setEntryNotesText] = useState('')
  const [savingEntryNotes, setSavingEntryNotes] = useState(false)
  const [autoCreating, setAutoCreating] = useState(false)
  const [logbookViewMode, setLogbookViewMode] = useState<'list' | 'kanban'>('list')
  // Logbook inline editing
  const [editingLogbookTitle, setEditingLogbookTitle] = useState(false)
  const [editLogbookTitleValue, setEditLogbookTitleValue] = useState('')
  const [editingLogbookDate, setEditingLogbookDate] = useState(false)
  const [editLogbookDateValue, setEditLogbookDateValue] = useState('')
  // Preview for pending logbooks with saved filter
  const [previewParticipants, setPreviewParticipants] = useState<Array<{ id: string; name: string; phone: string | null; stage_name: string; stage_color: string; stage_id: string | null }>>([])
  const [previewLoading, setPreviewLoading] = useState(false)
  // Filter confirmation for logbook snapshot
  const [showFilterConfirmDialog, setShowFilterConfirmDialog] = useState(false)
  const [filterConfirmAction, setFilterConfirmAction] = useState<(() => void) | null>(null)

  // Inline event name editing
  const [editingEventName, setEditingEventName] = useState(false)
  const [editNameValue, setEditNameValue] = useState('')
  const editNameRef = useRef<HTMLInputElement>(null)

  const kanbanRef = useRef<HTMLDivElement>(null)
  const topScrollRef = useRef<HTMLDivElement>(null)
  const syncingScroll = useRef(false)

  // Ctrl+drag kanban panning
  useKanbanPan(kanbanRef, topScrollRef)

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

  const openMembershipHistory = useCallback(async () => {
    setShowMembershipHistory(true)
    setMembershipHistoryLoading(true)
    try {
      const res = await fetch(`/api/events/${eventId}/membership-history?limit=100`, { headers: { Authorization: `Bearer ${getToken()}` } })
      const data = await res.json()
      if (!res.ok || !data.success) throw new Error(data.error || 'No se pudo cargar el historial')
      setMembershipHistory(data.entries || [])
    } catch (e) {
      console.error('[Membership history]', e)
      setMembershipHistory([])
    } finally {
      setMembershipHistoryLoading(false)
    }
  }, [eventId])

  const fetchParticipantsPaginated = useCallback(async () => {
    participantAbortRef.current?.abort()
    stageAbortRefs.current.forEach(controller => controller.abort())
    stageAbortRefs.current.clear()
    setLoadingMoreStages(new Set())
    const abortController = new AbortController()
    participantAbortRef.current = abortController
    const requestId = ++participantRequestRef.current
    participantGenerationRef.current += 1
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
        signal: abortController.signal,
      })
      const data = await res.json()
      if (requestId === participantRequestRef.current && data.success) {
        setStageData((data.stages || []).map((s: StageData) => ({ ...s, participants: s.participants || [] })))
        const ua = data.unassigned || { total_count: 0, participants: [], has_more: false }
        setUnassignedData({ ...ua, participants: ua.participants || [] })
        setAllTags(data.all_tags || [])
      }
    } catch (err) {
      if (abortController.signal.aborted) return
      console.error('Failed to fetch participants:', err)
    } finally {
      if (requestId === participantRequestRef.current) {
        if (participantAbortRef.current === abortController) participantAbortRef.current = null
        setLoading(false)
      }
    }
  }, [eventId, debouncedSearch, filterTagNames, excludeFilterTagNames, tagFilterMode, filterStageIds, filterHasPhone, appliedFormulaType, appliedFormulaText, filterDateField, filterDatePreset, filterDateFrom, filterDateTo])

  const loadMoreForStage = useCallback(async (stageId: string) => {
    if (stageAbortRefs.current.has(stageId)) return
    const abortController = new AbortController()
    stageAbortRefs.current.set(stageId, abortController)
    const generation = participantGenerationRef.current
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
        signal: abortController.signal,
      })
      const data = await res.json()
      if (generation === participantGenerationRef.current && stageAbortRefs.current.get(stageId) === abortController && data.success) {
        const newP = data.participants || []
        if (isUnassigned) {
          setUnassignedData(prev => {
            const byID = new Map(prev.participants.map(participant => [participant.id, participant]))
            newP.forEach((participant: Participant) => byID.set(participant.id, participant))
            return { ...prev, participants: Array.from(byID.values()), has_more: data.has_more }
          })
        } else {
          setStageData(prev => prev.map(s => {
            if (s.id !== stageId) return s
            const byID = new Map(s.participants.map(participant => [participant.id, participant]))
            newP.forEach((participant: Participant) => byID.set(participant.id, participant))
            return { ...s, participants: Array.from(byID.values()), has_more: data.has_more }
          }))
        }
      }
    } catch (err) {
      if (abortController.signal.aborted) return
      console.error('Failed to load more:', err)
    } finally {
      if (stageAbortRefs.current.get(stageId) === abortController) {
        stageAbortRefs.current.delete(stageId)
        setLoadingMoreStages(prev => { const next = new Set(prev); next.delete(stageId); return next })
      }
    }
  }, [stageData, unassignedData, eventId, debouncedSearch, filterTagNames, excludeFilterTagNames, tagFilterMode, filterHasPhone, appliedFormulaType, appliedFormulaText, filterDateField, filterDatePreset, filterDateFrom, filterDateTo])

  const fetchListParticipants = useCallback(async (reset: boolean = false) => {
    if (!reset && listAbortRef.current) return
    listAbortRef.current?.abort()
    const abortController = new AbortController()
    listAbortRef.current = abortController
    const requestId = ++listRequestRef.current
    setListLoading(true)
    const offset = reset ? 0 : listOffsetRef.current
    try {
      const params = new URLSearchParams()
      params.set('offset', String(offset))
      params.set('limit', '100')
      if (debouncedSearch) params.set('search', debouncedSearch)
      if (filterStageIds.size > 0) params.set('stage_ids', Array.from(filterStageIds).join(','))
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
      const res = await fetch(`/api/events/${eventId}/participants?${params}`, {
        headers: { Authorization: `Bearer ${getToken()}` },
        signal: abortController.signal,
      })
      const data = await res.json()
      if (requestId === listRequestRef.current && data.success) {
        const participants = data.participants || []
        if (reset) {
          setListParticipants(participants)
          listOffsetRef.current = participants.length
        } else {
          setListParticipants(prev => {
            const byID = new Map(prev.map(participant => [participant.id, participant]))
            participants.forEach((participant: Participant) => byID.set(participant.id, participant))
            return Array.from(byID.values())
          })
          listOffsetRef.current = offset + participants.length
        }
        setListTotal(data.total || participants.length)
        setListHasMore(participants.length >= 100)
      }
    } catch (err) {
      if (abortController.signal.aborted) return
      console.error('Failed to fetch list participants:', err)
    } finally {
      if (requestId === listRequestRef.current) {
        if (listAbortRef.current === abortController) listAbortRef.current = null
        setListLoading(false)
      }
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
  const eventHasMembershipRules = event?.has_membership_rules ?? Boolean(event?.tag_formula?.trim())
  const eventIsReadOnly = event?.status === 'completed' || event?.status === 'cancelled'
  const detailPanelOpen = showDetailPanel || showInlineChat

  const activeDraftStages = useMemo(() => (
    draftStages
      .filter(stage => !stage.isDeleted)
      .sort((a, b) => a.position - b.position)
  ), [draftStages])

  const renderedStageData = useMemo(() => {
    if (!stageEditMode) return stageData
    const currentById = new Map(stageData.map(stage => [stage.id, stage]))
    return activeDraftStages.map(stage => {
      const current = currentById.get(stage.id)
      return {
        id: stage.id,
        pipeline_id: stage.pipeline_id,
        name: stage.name,
        color: stage.color,
        position: stage.position,
        total_count: current?.total_count ?? stage.total_count,
        participants: current?.participants || [],
        has_more: current?.has_more || false,
      }
    })
  }, [activeDraftStages, stageData, stageEditMode])

  const stageEditDirty = useMemo(() => {
    if (!stageEditMode) return false
    if (draftDeletedStages.length > 0) return true
    if (draftStages.some(stage => stage.isNew)) return true
    const currentById = new Map((pipelineStages.length > 0 ? pipelineStages : stageData)
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((stage, idx) => [stage.id, { name: stage.name, color: stage.color, index: idx }])
    )
    return activeDraftStages.some((stage, idx) => {
      const current = currentById.get(stage.id)
      return !current || current.name !== stage.name || current.color !== stage.color || current.index !== idx
    })
  }, [activeDraftStages, draftDeletedStages.length, draftStages, pipelineStages, stageData, stageEditMode])

  const stageSaveBlocked = useMemo(() => (
    draftDeletedStages.some(deletion => {
      const stageStillDeleted = draftStages.some(stage => stage.id === deletion.stageId && stage.isDeleted && !stage.isNew)
      if (!stageStillDeleted) return false
      return !deletion.moveToStageId || !activeDraftStages.some(stage => stage.id === deletion.moveToStageId && !stage.isNew)
    })
  ), [activeDraftStages, draftDeletedStages, draftStages])

  const kanbanColumnCount = renderedStageData.length + (unassignedData.total_count > 0 ? 1 : 0)

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
      // Mark that we initiated this stage change (prevents WebSocket refetch from reverting)
      ownStageChangeRef.current = true
      if (ownStageTimerRef.current) clearTimeout(ownStageTimerRef.current)
      ownStageTimerRef.current = setTimeout(() => { ownStageChangeRef.current = false }, 3000)
      const res = await fetch(`/api/events/${eventId}/participants/${pid}/stage`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage_id: targetStageId }),
      })
      const data = await res.json()
      if (!data.success) { ownStageChangeRef.current = false; fetchParticipantsPaginated() }
    } catch { ownStageChangeRef.current = false; fetchParticipantsPaginated() }
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

  const applyStageManagementResponse = useCallback((data: any) => {
    const pipelineChanged = Boolean(data.pipeline_id && event?.pipeline_id && data.pipeline_id !== event.pipeline_id)
    if (data.pipeline_id) {
      setEvent(prev => prev ? { ...prev, pipeline_id: data.pipeline_id } : prev)
    }
    if (pipelineChanged) {
      setFilterStageIds(new Set())
    }
    if (data.stages) {
      setPipelineStages((data.stages || []).sort((a: PipelineStage, b: PipelineStage) => a.position - b.position))
    }
    fetchEvent()
    fetchParticipantsPaginated()
    if (viewMode === 'list') fetchListParticipants(true)
  }, [event?.pipeline_id, fetchEvent, fetchParticipantsPaginated, fetchListParticipants, viewMode])

  // ─── Stage Management ───────────────────────────────────────────────────────
  const beginStageEditMode = useCallback(() => {
    const sourceStages = (pipelineStages.length > 0 ? pipelineStages : stageData)
      .slice()
      .sort((a, b) => a.position - b.position)
    const countByStage = new Map(stageData.map(s => [s.id, s.total_count]))
    setDraftStages(sourceStages.map((stage, idx) => ({
      id: stage.id,
      pipeline_id: stage.pipeline_id,
      name: stage.name,
      color: stage.color || '#6366f1',
      position: idx,
      total_count: countByStage.get(stage.id) || 0,
    })))
    setDraftDeletedStages([])
    setStageLayoutError('')
    setDraggedStageId(null)
    setStageEditMode(true)
    setShowStageEditorModal(true)
    setShowMoreMenu(false)
  }, [pipelineStages, stageData])

  const cancelStageEditMode = useCallback(() => {
    setStageEditMode(false)
    setDraftStages([])
    setDraftDeletedStages([])
    setStageLayoutError('')
    setDraggedStageId(null)
    setShowStageEditorModal(false)
    setShowStageModal(false)
    setNewStageName('')
    setNewStageColor('#3b82f6')
  }, [])

  const handleCreateStage = useCallback(async () => {
    const name = newStageName.trim()
    if (!name || stageLayoutSaving) return
    if (!stageEditMode) {
      beginStageEditMode()
    }
    const clientId = `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`
    setDraftStages(prev => {
      const activeCount = prev.filter(s => !s.isDeleted).length
      return [...prev, {
        id: clientId,
        clientId,
        pipeline_id: event?.pipeline_id || '',
        name,
        color: newStageColor,
        position: activeCount,
        total_count: 0,
        isNew: true,
      }]
    })
    setShowStageModal(false)
    setNewStageName('')
    setNewStageColor('#3b82f6')
    setStageLayoutError('')
  }, [beginStageEditMode, event?.pipeline_id, newStageColor, newStageName, stageEditMode, stageLayoutSaving])

  const handleRenameStage = useCallback(async (stageId: string, newName: string) => {
    const name = newName.trim()
    if (!name) return
    if (!stageEditMode) return
    setDraftStages(prev => prev.map(stage => stage.id === stageId ? { ...stage, name } : stage))
    setStageLayoutError('')
  }, [stageEditMode])

  const handleColorStage = useCallback((stageId: string, color: string) => {
    if (!stageEditMode) return
    setDraftStages(prev => prev.map(stage => stage.id === stageId ? { ...stage, color } : stage))
    setStageLayoutError('')
  }, [stageEditMode])

  const handleDeleteStage = useCallback(async (stageId: string, stageName: string, totalCount: number) => {
    if (!stageEditMode) return
    const activeStages = draftStages.filter(stage => !stage.isDeleted)
    if (activeStages.length <= 1) {
      setStageLayoutError('Debe quedar al menos una etapa activa.')
      return
    }
    const stage = draftStages.find(item => item.id === stageId)
    if (stage?.isNew) {
      setDraftStages(prev => prev.filter(item => item.id !== stageId).map((item, idx) => ({ ...item, position: idx })))
      return
    }
    const firstDestination = activeStages.find(item => item.id !== stageId)?.id || ''
    setDraftStages(prev => prev.map(item => item.id === stageId ? { ...item, isDeleted: true } : item))
    setDraftDeletedStages(prev => prev.some(item => item.stageId === stageId)
      ? prev
      : [...prev, { stageId, stageName, totalCount, moveToStageId: firstDestination }]
    )
    setStageLayoutError('')
  }, [draftStages, stageEditMode])

  const undoDeleteStage = useCallback((stageId: string) => {
    setDraftStages(prev => prev.map(stage => stage.id === stageId ? { ...stage, isDeleted: false } : stage))
    setDraftDeletedStages(prev => prev.filter(item => item.stageId !== stageId))
    setStageLayoutError('')
  }, [])

  const setDeletedStageDestination = useCallback((stageId: string, moveToStageId: string) => {
    setDraftDeletedStages(prev => prev.map(item => item.stageId === stageId ? { ...item, moveToStageId } : item))
    setStageLayoutError('')
  }, [])

  const moveDraftStage = useCallback((fromId: string, toId: string) => {
    if (!fromId || !toId || fromId === toId) return
    setDraftStages(prev => {
      const active = prev.filter(stage => !stage.isDeleted)
      const deleted = prev.filter(stage => stage.isDeleted)
      const fromIndex = active.findIndex(stage => stage.id === fromId)
      const toIndex = active.findIndex(stage => stage.id === toId)
      if (fromIndex < 0 || toIndex < 0) return prev
      const next = [...active]
      const [moved] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, moved)
      return [
        ...next.map((stage, idx) => ({ ...stage, position: idx })),
        ...deleted,
      ]
    })
    setStageLayoutError('')
  }, [])

  const handleStageColumnDrop = useCallback((targetStageId: string) => {
    if (!draggedStageId) return
    moveDraftStage(draggedStageId, targetStageId)
    setDraggedStageId(null)
  }, [draggedStageId, moveDraftStage])

  const saveStageLayout = useCallback(async () => {
    if (stageLayoutSaving) return
    const activeStages = draftStages
      .filter(stage => !stage.isDeleted)
      .sort((a, b) => a.position - b.position)
    if (activeStages.length === 0) {
      setStageLayoutError('Debe quedar al menos una etapa activa.')
      return
    }
    const invalidStage = activeStages.find(stage => !stage.name.trim())
    if (invalidStage) {
      setStageLayoutError('Todas las etapas necesitan nombre.')
      return
    }
    const invalidDeletion = draftDeletedStages.find(deletion => {
      const stageStillDeleted = draftStages.some(stage => stage.id === deletion.stageId && stage.isDeleted && !stage.isNew)
      if (!stageStillDeleted) return false
      return !deletion.moveToStageId || !activeStages.some(stage => stage.id === deletion.moveToStageId && !stage.isNew)
    })
    if (invalidDeletion) {
      setStageLayoutError(`Elige una etapa destino para "${invalidDeletion.stageName}".`)
      return
    }

    setStageLayoutSaving(true)
    setStageLayoutError('')
    try {
      const res = await fetch(`/api/events/${eventId}/stages/layout`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({
          stages: activeStages.map((stage, idx) => ({
            ...(stage.isNew ? { clientId: stage.clientId || stage.id } : { id: stage.id }),
            name: stage.name.trim(),
            color: stage.color || '#6366f1',
            position: idx,
          })),
          deletions: draftDeletedStages
            .filter(deletion => draftStages.some(stage => stage.id === deletion.stageId && stage.isDeleted && !stage.isNew))
            .map(deletion => ({
              id: deletion.stageId,
              moveTo: { kind: 'stage', id: deletion.moveToStageId },
            })),
        }),
      })
      const data = await res.json()
      if (!data.success) {
        setStageLayoutError(data.error || 'No se pudo guardar el layout de etapas.')
        return
      }
      setFilterStageIds(prev => {
        const deleted = new Set(draftDeletedStages.map(item => item.stageId))
        const next = new Set(prev)
        deleted.forEach(id => next.delete(id))
        return next
      })
      applyStageManagementResponse(data)
      setStageEditMode(false)
      setDraftStages([])
      setDraftDeletedStages([])
      setShowStageEditorModal(false)
      setShowStageModal(false)
      setNewStageName('')
      setNewStageColor('#3b82f6')
    } catch (e) {
      console.error('[SaveStageLayout]', e)
      setStageLayoutError('No se pudo guardar el layout de etapas.')
    } finally {
      setStageLayoutSaving(false)
    }
  }, [applyStageManagementResponse, draftDeletedStages, draftStages, eventId, stageLayoutSaving])

  const moveDraftStageByOffset = useCallback((stageId: string, offset: number) => {
    const active = activeDraftStages
    const index = active.findIndex(stage => stage.id === stageId)
    const target = active[index + offset]
    if (!target) return
    moveDraftStage(stageId, target.id)
  }, [activeDraftStages, moveDraftStage])

  const handleDuplicateEvent = useCallback(async () => {
    if (duplicatingEvent) return
    setDuplicatingEvent(true)
    setShowMoreMenu(false)
    try {
      const res = await fetch(`/api/events/${eventId}/duplicate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getToken()}` },
      })
      const data = await res.json()
      if (!data.success || !data.event?.id) {
        alert(data.error || 'No se pudo duplicar el evento.')
        return
      }
      router.push(`/dashboard/events/${data.event.id}`)
    } catch (e) {
      console.error('[DuplicateEvent]', e)
      alert('No se pudo duplicar el evento.')
    } finally {
      setDuplicatingEvent(false)
    }
  }, [duplicatingEvent, eventId, router])

  // ─── Add Participants ────────────────────────────────────────────────────────
  const handleAddFromSelector = async (selected: SelectedPerson[]) => {
    if (selected.length === 0 || addingParticipant) return
    const parts = selected.map(p => ({
      contact_id: p.id,
      name: p.name, phone: p.phone || '', email: p.email || '',
    }))
    setAddingParticipant(true)
    setAddParticipantError('')
    try {
      const res = await fetch(`/api/events/${eventId}/participants/bulk`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ participants: parts }),
      })
      const data = await res.json()
      if (!res.ok || !data.success) {
        if (data.code === 'EVENT_RULE_NOT_MATCHED' || res.status === 422) {
          setAddParticipantError(data.error || 'Uno de los contactos ya no cumple las reglas actuales del evento. Actualiza sus etiquetas y vuelve a intentarlo.')
        } else if (res.status === 409) {
          setAddParticipantError(data.error || 'El evento cambió de estado y ya no permite agregar participantes.')
        } else {
          setAddParticipantError(data.error || 'No pudimos agregar los contactos. Revisa la selección e inténtalo nuevamente.')
        }
        return
      }

      const summary = data.summary || {}
      const created = Number(summary.created || 0)
      const reactivated = Number(summary.reactivated || 0)
      const alreadyActive = Number(summary.already_active || 0)
      const rejected = Number(summary.rejected || 0)
      const changed = created + reactivated
      if (changed > 0) {
        fetchParticipantsPaginated()
        fetchEvent()
      }
      if (rejected > 0 || (changed === 0 && alreadyActive > 0)) {
        setParticipantCandidatesRevision(current => current + 1)
        const completedMessage = changed > 0
          ? `${changed} contacto${changed !== 1 ? 's se añadieron' : ' se añadió'} correctamente. `
          : ''
        const rejectedMessage = rejected > 0
          ? `${rejected} no ${rejected !== 1 ? 'pudieron añadirse' : 'pudo añadirse'} porque la configuración cambió o ya no cumple las reglas.`
          : `${alreadyActive} contacto${alreadyActive !== 1 ? 's ya formaban' : ' ya formaba'} parte del evento.`
        setAddParticipantError(completedMessage + rejectedMessage)
        return
      }
      setShowAddModal(false)
      setAddParticipantError('')
    } catch (error) {
      console.error('[AddEventContacts]', error)
      setAddParticipantError('No pudimos conectar con el servidor. Revisa tu conexión e inténtalo nuevamente.')
    } finally {
      setAddingParticipant(false)
    }
  }

  const handleAddManual = async () => {
    if (!manualForm.name.trim() || addingParticipant) return
    if (eventHasMembershipRules) {
      setAddParticipantError('Este evento tiene reglas. Crea o actualiza primero el contacto y sus etiquetas; después podrás seleccionarlo cuando cumpla la configuración.')
      return
    }
    if (eventIsReadOnly) {
      setAddParticipantError('Este evento está cerrado y ya no permite registrar participantes.')
      return
    }
    const body: Record<string, unknown> = {
      name: manualForm.name, last_name: manualForm.last_name,
      short_name: manualForm.short_name || undefined,
      phone: manualForm.phone || undefined, email: manualForm.email || undefined,
    }
    if (manualForm.age) body.age = parseInt(manualForm.age)
    setAddingParticipant(true)
    setAddParticipantError('')
    try {
      const res = await fetch(`/api/events/${eventId}/participants`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok || !data.success) {
        setAddParticipantError(data.error || 'No se pudo registrar y agregar el contacto.')
        return
      }
      setShowAddModal(false)
      setAddParticipantError('')
      setManualForm({ name: '', last_name: '', short_name: '', phone: '', email: '', age: '' })
      fetchParticipantsPaginated()
      fetchEvent()
    } catch (error) {
      console.error('[CreateEventContact]', error)
      setAddParticipantError('No pudimos conectar con el servidor. Revisa tu conexión e inténtalo nuevamente.')
    } finally {
      setAddingParticipant(false)
    }
  }
  // ─── Delete ─────────────────────────────────────────────────────────────────
  const handleDeleteParticipant = useCallback(async (pid: string) => {
    if (!confirm('¿Sacar este participante del listado activo? Su historial se conservará.')) return
    try {
      const res = await fetch(`/api/events/${eventId}/participants/${pid}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${getToken()}` },
      })
      const data = await res.json()
      if (!res.ok || !data.success) { alert(data.error || 'No se pudo sacar al participante'); return }
      removeParticipantFromStages(pid)
      if (detailParticipant?.id === pid) { setShowDetailPanel(false); setShowInlineChat(false) }
      fetchEvent()
    } catch (e) { console.error(e) }
  }, [eventId, detailParticipant, removeParticipantFromStages, fetchEvent])

  // ─── Detail Panel ──────────────────────────────────────────────────────────
  const openDetailPanel = useCallback((p: Participant) => {
    setDetailParticipant(p)
    setShowDetailPanel(true)
    setDetailParticipantLoading(true)
    setDetailParticipantError('')
    const requestID = ++detailParticipantRequestRef.current
    void (async () => {
      try {
        const response = await fetch(`/api/events/${eventId}/participants/${p.id}`, {
          headers: { Authorization: `Bearer ${getToken()}` },
        })
        const data = await response.json().catch(() => ({}))
        if (requestID !== detailParticipantRequestRef.current) return
        if (!response.ok || !data.success || !data.participant) {
          if (response.status === 404) {
            setDetailParticipantError('Este participante ya no pertenece a este evento o dejó de estar disponible. Actualiza el listado e inténtalo nuevamente.')
            fetchParticipantsPaginated()
          } else {
            setDetailParticipantError(data.error || 'No pudimos cargar la ficha completa ni sus oportunidades. Inténtalo nuevamente.')
          }
          return
        }
        setDetailParticipant(data.participant as Participant)
      } catch (error) {
        if (requestID === detailParticipantRequestRef.current) {
          console.error('[EventParticipantDetail]', error)
          setDetailParticipantError('No pudimos conectar con el servidor para cargar la ficha completa. Revisa tu conexión e inténtalo nuevamente.')
        }
      } finally {
        if (requestID === detailParticipantRequestRef.current) setDetailParticipantLoading(false)
      }
    })()
  }, [eventId, fetchParticipantsPaginated])

  const handleViewExistingParticipant = useCallback((person: SelectedPerson) => {
    if (!person.participant_id) return
    setShowAddModal(false)
    setAddParticipantError('')
    openDetailPanel({
      id: person.participant_id,
      event_id: eventId,
      contact_id: person.id,
      name: person.name,
      phone: person.phone,
      email: person.email,
      status: 'invited',
      stage_id: person.stage_id,
      stage_name: person.stage_name,
      stage_color: person.stage_color,
      membership_source: person.membership_source,
      membership_reason: person.membership_reason,
      tags: person.tags?.map(tag => ({ ...tag, account_id: '', created_at: '' })),
    })
  }, [eventId, openDetailPanel])

  const toggleSelection = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }, [])

  // ─── WhatsApp ──────────────────────────────────────────────────────────────
  const handleSendWhatsApp = async (phone: string) => {
    const cleanPhone = (phone || '').replace(/[^0-9]/g, '')
    if (!cleanPhone) {
      alert('Este participante no tiene un número válido')
      return
    }
    setWhatsappPhone(cleanPhone)
    whatsappPhoneRef.current = cleanPhone
    try {
      const resolution = await resolveWhatsAppChat(cleanPhone)
      if (!resolution.success) {
        alert(resolution.error || 'Error al resolver conversación')
        return
      }
      setExistingChatForWA(resolution.chat || null)
      setWhatsappHistoricalPhone(resolution.historical_phone || '')
      if (resolution.mode === 'read_only' && resolution.chat) {
        setInlineChatId(resolution.chat.id)
        setInlineChat(resolution.chat)
        setInlineChatDeviceId(resolution.chat.device_id || '')
        setInlineChatReadOnly(true)
        setShowInlineChat(true)
        return
      }
      if (resolution.mode === 'open_direct' && resolution.devices[0]) {
        await handleDeviceSelectedForChat(resolution.devices[0] as Device, cleanPhone)
        return
      }
      if (resolution.mode === 'choose_device') {
        setDevices(resolution.devices as Device[])
        setShowDeviceSelector(true)
        return
      }
      alert('No hay dispositivos conectados para enviar')
    } catch { alert('Error de conexión') }
  }

  const handleDeviceSelectedForChat = async (device: Device, phone?: string) => {
    setShowDeviceSelector(false)
    setInlineChatReadOnly(false)
    const cleanPhone = (phone || whatsappPhoneRef.current || whatsappPhone).replace(/[^0-9]/g, '')
    if (!cleanPhone) {
      alert('No hay número seleccionado para abrir el chat')
      return
    }
    try {
      const data = await createWhatsAppChat(device.id, cleanPhone)
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

  // ─── Archive / Block ───────────────────────────────────────────────────────
  const [showBlockModal, setShowBlockModal] = useState(false)
  const [blockReason, setBlockReason] = useState('')
  const [blockTargetId, setBlockTargetId] = useState<string | null>(null)
  const [blockError, setBlockError] = useState('')
  const [savingBlock, setSavingBlock] = useState(false)

  useAccessibleDialog(
    showAddModal && addTab === 'manual',
    manualContactDialogRef,
    () => { if (!addingParticipant) setShowAddModal(false) },
    manualContactNameRef,
  )
  useAccessibleDialog(
    showBlockModal,
    doNotContactDialogRef,
    () => { if (!savingBlock) setShowBlockModal(false) },
    doNotContactFirstChoiceRef,
  )

  const openBlockModal = (contactId: string) => {
    setBlockTargetId(contactId)
    setBlockReason('')
    setBlockError('')
    setShowBlockModal(true)
  }

  const confirmBlock = async () => {
    if (!blockReason || !blockTargetId || savingBlock) return
    setSavingBlock(true)
    setBlockError('')
    try {
      const response = await fetch(`/api/contacts/${blockTargetId}/do-not-contact`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ blocked: true, reason: blockReason }),
      })
      const data = await response.json()
      if (!response.ok || !data.success) throw new Error(data.error || 'No se pudo actualizar el contacto')
      setShowBlockModal(false)
      setShowDetailPanel(false)
      setShowInlineChat(false)
      fetchEvent()
    } catch (err) {
      console.error('Failed to block:', err)
      setBlockError(err instanceof Error ? err.message : 'No se pudo actualizar el contacto')
    } finally {
      setSavingBlock(false)
    }
  }

  const handleUnblock = async (contactId: string) => {
    try {
      const response = await fetch(`/api/contacts/${contactId}/do-not-contact`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ blocked: false }),
      })
      const data = await response.json()
      if (!response.ok || !data.success) throw new Error(data.error || 'No se pudo actualizar el contacto')
      setShowDetailPanel(false)
      setShowInlineChat(false)
      fetchEvent()
    } catch (err) { console.error('Failed to unblock:', err) }
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
          stage_ids: filterStageIds.size > 0 ? Array.from(filterStageIds).join(',') : undefined,
          tag_names: filterTagNames.size > 0 ? Array.from(filterTagNames) : undefined,
          tag_mode: tagFilterMode || 'OR',
          exclude_tag_names: excludeFilterTagNames.size > 0 ? Array.from(excludeFilterTagNames) : undefined,
          tag_formula: (appliedFormulaType === 'advanced' && appliedFormulaText) ? appliedFormulaText : undefined,
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
        // Add spreadsheet recipients if any
        if (formResult.recipients && formResult.recipients.length > 0 && data.campaign) {
          const sheetRecipients = formResult.recipients.map(r => ({
            jid: r.phone + '@s.whatsapp.net',
            name: r.name || '',
            phone: r.phone,
            metadata: r.metadata || {},
          }))
          await fetch(`/api/campaigns/${data.campaign.id}/recipients`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ recipients: sheetRecipients }),
          })
        }
        const extraCount = formResult.recipients?.length || 0
        alert(`Campaña creada con ${(data.recipients_count || 0) + extraCount} destinatarios.`)
        setShowCampaignModal(false)
      } else { alert(data.error || 'Error al crear campaña') }
    } catch (e) { console.error(e); alert('Error de conexión') }
    setCreatingCampaign(false)
  }

  // ─── Export ────────────────────────────────────────────────────────────────
  const buildFilterParams = useCallback(() => {
    const params = new URLSearchParams()
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
    return params
  }, [debouncedSearch, appliedFormulaType, appliedFormulaText, filterTagNames, excludeFilterTagNames, tagFilterMode, filterStageIds, filterHasPhone, filterDatePreset, filterDateFrom, filterDateTo, filterDateField])

  const handleExport = async () => {
    if (!event) return
    setExporting(true)
    try {
      // Build URL with or without filters
      const useFilters = exportFormat === 'excel' && exportScope === 'filtered' && activeFilterCount > 0
      const params = useFilters ? buildFilterParams() : new URLSearchParams()
      const qs = params.toString()
      const url = `/api/events/${eventId}/participants${qs ? '?' + qs : ''}`
      const res = await fetch(url, { headers: { Authorization: `Bearer ${getToken()}` } })
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

  // ─── Logbook Functions ──────────────────────────────────────────────────────
  const fetchLogbooks = useCallback(async () => {
    setLogbooksLoading(true)
    try {
      const res = await fetch(`/api/events/${eventId}/logbooks`, { headers: { Authorization: `Bearer ${getToken()}` } })
      const data = await res.json()
      if (Array.isArray(data)) setLogbooks(data)
    } catch (e) { console.error('[Logbooks] fetch error:', e) }
    finally { setLogbooksLoading(false) }
  }, [eventId])

  const fetchLogbookPreview = useCallback(async (lid: string) => {
    setPreviewLoading(true)
    try {
      const res = await fetch(`/api/events/${eventId}/logbooks/${lid}/preview`, { headers: { Authorization: `Bearer ${getToken()}` } })
      const data = await res.json()
      setPreviewParticipants(data.participants || [])
    } catch (e) { console.error('[Logbook] preview error:', e); setPreviewParticipants([]) }
    finally { setPreviewLoading(false) }
  }, [eventId])

  const fetchLogbookDetail = useCallback(async (lid: string) => {
    setSelectedLogbookLoading(true)
    setPreviewParticipants([])
    try {
      const res = await fetch(`/api/events/${eventId}/logbooks/${lid}`, { headers: { Authorization: `Bearer ${getToken()}` } })
      const data = await res.json()
      if (data.id) {
        setSelectedLogbook(data)
        setLogbookNotesText(data.general_notes || '')
        // Auto-fetch preview for pending logbooks with saved filter
        if (data.status === 'pending' && data.saved_filter) {
          fetchLogbookPreview(lid)
        }
      }
    } catch (e) { console.error('[Logbook] detail error:', e) }
    finally { setSelectedLogbookLoading(false) }
  }, [eventId, fetchLogbookPreview])

  const handleUpdateLogbookSettings = async (updateFilter: boolean = false) => {
    if (!selectedLogbook || !logbookSettingsDate || !logbookSettingsTitle.trim()) return
    setLogbookSettingsUpdating(true)
    try {
      const body: any = {
        title: logbookSettingsTitle.trim(),
        date: logbookSettingsDate,
        status: logbookSettingsStatus
      }
      if (updateFilter) {
        body.saved_filter = getSnapshotFilterBody()
      }
      const res = await fetch(`/api/events/${eventId}/logbooks/${selectedLogbook.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`
        },
        body: JSON.stringify(body)
      })
      if (!res.ok) throw new Error('Error updating')
      const updated = await res.json()
      setSelectedLogbook(updated)
      setShowLogbookSettingsModal(false)
      fetchLogbooks()
    } catch (e) {
      console.error('Error al guardar configuración', e)
    } finally {
      setLogbookSettingsUpdating(false)
    }
  }

  const handleCreateLogbook = async () => {
    if (!newLogbookDate) return
    // If capture_now is checked AND filters are active, show confirmation first
    if (newLogbookCaptureNow && activeFilterCount > 0) {
      setFilterConfirmAction(() => () => doCreateLogbook())
      setShowFilterConfirmDialog(true)
      return
    }
    doCreateLogbook()
  }

  // Build filter body for snapshot capture
  const getSnapshotFilterBody = () => {
    if (activeFilterCount === 0) return {}
    const body: Record<string, unknown> = {}
    if (debouncedSearch) body.text_search = debouncedSearch
    if (filterStageIds.size > 0) body.stage_ids = Array.from(filterStageIds).join(',')
    if (appliedFormulaType === 'advanced' && appliedFormulaText) {
      body.tag_formula = appliedFormulaText
    } else {
      if (filterTagNames.size > 0) body.tag_names = Array.from(filterTagNames)
      if (filterTagNames.size > 0 || excludeFilterTagNames.size > 0) body.tag_mode = tagFilterMode
      if (excludeFilterTagNames.size > 0) body.exclude_tag_names = Array.from(excludeFilterTagNames)
    }
    if (filterHasPhone) body.has_phone = true
    const dateRange = resolveParticipantDatePreset(filterDatePreset, filterDateFrom, filterDateTo)
    if (dateRange) {
      body.date_field = filterDateField
      if (dateRange.from) body.date_from = dateRange.from
      if (dateRange.to) body.date_to = dateRange.to
    }
    return body
  }

  const doCreateLogbook = async () => {
    if (!newLogbookDate) return
    setShowFilterConfirmDialog(false)
    setCreatingLogbook(true)
    try {
      const filterBody = getSnapshotFilterBody()
      const res = await fetch(`/api/events/${eventId}/logbooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ date: newLogbookDate, title: newLogbookTitle, capture_now: newLogbookCaptureNow, ...filterBody }),
      })
      const data = await res.json()
      if (data.id) {
        await fetchLogbooks()
        setSelectedLogbook(data)
        setShowNewLogbookModal(false)
        setNewLogbookDate('')
        setNewLogbookTitle('')
        setNewLogbookCaptureNow(false)
      } else if (data.error) {
        alert(data.error)
      }
    } catch (e) { console.error('[Logbook] create error:', e) }
    finally { setCreatingLogbook(false) }
  }

  const handleCaptureSnapshot = async (lid: string) => {
    // If filters are active, show confirmation dialog
    if (activeFilterCount > 0) {
      setFilterConfirmAction(() => () => doCaptureSnapshot(lid))
      setShowFilterConfirmDialog(true)
      return
    }
    doCaptureSnapshot(lid)
  }

  const doCaptureSnapshot = async (lid: string) => {
    setShowFilterConfirmDialog(false)
    setCapturingSnapshot(true)
    try {
      const filterBody = getSnapshotFilterBody()
      const hasFilters = Object.keys(filterBody).length > 0
      // If no active UI filters but logbook has saved_filter, send saved_filter
      let bodyToSend = hasFilters ? filterBody : undefined
      if (!hasFilters && selectedLogbook?.saved_filter && Object.keys(selectedLogbook.saved_filter).length > 0) {
        bodyToSend = selectedLogbook.saved_filter as Record<string, unknown>
      }
      const sendBody = bodyToSend && Object.keys(bodyToSend).length > 0
      const res = await fetch(`/api/events/${eventId}/logbooks/${lid}/capture`, {
        method: 'POST',
        headers: { ...(sendBody ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${getToken()}` },
        ...(sendBody ? { body: JSON.stringify(bodyToSend) } : {}),
      })
      const data = await res.json()
      if (data.id) {
        setSelectedLogbook(data)
        await fetchLogbooks()
      }
    } catch (e) { console.error('[Logbook] capture error:', e) }
    finally { setCapturingSnapshot(false) }
  }

  const handleAutoCreateLogbooks = async () => {
    setAutoCreating(true)
    try {
      const res = await fetch(`/api/events/${eventId}/logbooks/auto-create`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getToken()}` },
      })
      const data = await res.json()
      if (data.created > 0) {
        await fetchLogbooks()
      }
    } catch (e) { console.error('[Logbook] auto-create error:', e) }
    finally { setAutoCreating(false) }
  }

  const handleSaveLogbookNotes = async () => {
    if (!selectedLogbook) return
    setSavingLogbookNotes(true)
    try {
      await fetch(`/api/events/${eventId}/logbooks/${selectedLogbook.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ general_notes: logbookNotesText }),
      })
      setSelectedLogbook(prev => prev ? { ...prev, general_notes: logbookNotesText } : null)
      setEditingLogbookNotes(false)
    } catch (e) { console.error('[Logbook] save notes error:', e) }
    finally { setSavingLogbookNotes(false) }
  }

  const handleSaveEntryNotes = async (entryId: string) => {
    setSavingEntryNotes(true)
    try {
      await fetch(`/api/events/${eventId}/logbooks/${selectedLogbook?.id}/entries/${entryId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ notes: entryNotesText }),
      })
      setSelectedLogbook(prev => {
        if (!prev || !prev.entries) return prev
        return { ...prev, entries: prev.entries.map(e => e.id === entryId ? { ...e, notes: entryNotesText } : e) }
      })
      setEditingEntryId(null)
    } catch (e) { console.error('[Logbook] save entry notes error:', e) }
    finally { setSavingEntryNotes(false) }
  }

  const handleDeleteLogbook = async (lid: string) => {
    if (!confirm('¿Eliminar esta bitácora? Se perderán las notas y el snapshot.')) return
    try {
      await fetch(`/api/events/${eventId}/logbooks/${lid}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${getToken()}` },
      })
      if (selectedLogbook?.id === lid) setSelectedLogbook(null)
      await fetchLogbooks()
    } catch (e) { console.error('[Logbook] delete error:', e) }
  }

  // ─── Effects ───────────────────────────────────────────────────────────────
  useEffect(() => {
    Promise.all([fetchEvent(), fetchDevices()]).then(() => {})
  }, [fetchEvent, fetchDevices])

  useEffect(() => () => {
    participantAbortRef.current?.abort()
    listAbortRef.current?.abort()
    stageAbortRefs.current.forEach(controller => controller.abort())
    stageAbortRefs.current.clear()
  }, [])

  useEffect(() => {
    if (event) fetchParticipantsPaginated()
  }, [event, fetchParticipantsPaginated])

  useEffect(() => {
    if (viewMode === 'list' && event) fetchListParticipants(true)
  }, [viewMode, fetchListParticipants, event])

  // Fetch logbooks when switching to logbook view
  useEffect(() => {
    if (viewMode === 'logbook' && event) fetchLogbooks()
  }, [viewMode, fetchLogbooks, event])

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery), 500)
    return () => clearTimeout(t)
  }, [searchQuery])

  // WebSocket — debounce reconciliation events to avoid refresh storms from background sync
  const participantDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const unsubscribe = subscribeWebSocket((data: unknown) => {
	  const msg = data as { event?: string; action?: string; event_id?: string; data?: { action?: string; event_id?: string } }
	  const payload = msg.data || msg
	  if (msg.event === 'contact_update') {
		fetchParticipantsPaginated()
		if (viewMode === 'list') fetchListParticipants(true)
		return
	  }
	  if (msg.event === 'event_participant_update' && payload.event_id === eventId) {
        // Skip refetch if we just changed a stage ourselves (prevents reverting optimistic update)
		if (payload.action === 'stage_changed' && ownStageChangeRef.current) return
		if (payload.action === 'tag_sync_reconcile' || payload.action === 'rule_reconciled' || payload.action === 'membership_reconciled') {
          // Background sync reconciliation — debounce to avoid refresh storms
          if (participantDebounceRef.current) clearTimeout(participantDebounceRef.current)
          participantDebounceRef.current = setTimeout(() => {
            fetchParticipantsPaginated()
            fetchEvent()
            if (viewMode === 'list') fetchListParticipants(true)
            participantDebounceRef.current = null
          }, 3000)
          return
        }
        // Direct user actions — refetch immediately
        fetchParticipantsPaginated()
        fetchEvent()
        if (viewMode === 'list') fetchListParticipants(true)
      }
	  if (msg.event === 'logbook_update' && payload.event_id === eventId) {
        if (viewMode === 'logbook') fetchLogbooks()
      }
      // Handle interaction updates — invalidate and refetch observations in list view
      if (msg.event === 'interaction_update' && viewMode === 'list') {
        // Invalidate all cached observations and refetch visible ones
        const visibleIds = Array.from(listObservations.keys())
        if (visibleIds.length > 0) {
          setListObservations(new Map())
          setLoadingListObs(new Set())
          fetchBatchObservations(visibleIds)
        }
      }
      // Handle lead updates — only react to actual user-initiated changes, not background sync
      if (msg.event === 'lead_update' && msg.action !== 'synced') {
        fetchParticipantsPaginated()
        if (viewMode === 'list') fetchListParticipants(true)
      }
    })
    return () => {
      unsubscribe()
      if (participantDebounceRef.current) clearTimeout(participantDebounceRef.current)
    }
  }, [eventId, fetchParticipantsPaginated, fetchEvent, viewMode, fetchListParticipants, fetchLogbooks, listObservations, fetchBatchObservations])

  useEffect(() => {
    if (!detailPanelOpen) return
    detailPreviousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = window.requestAnimationFrame(() => detailPanelDialogRef.current?.focus({ preventScroll: true }))
    const trapFocus = (keyboardEvent: KeyboardEvent) => {
      if (keyboardEvent.key !== 'Tab') return
      const dialog = detailPanelDialogRef.current
      if (!dialog) return
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
      )).filter(element => element.offsetParent !== null)
      if (focusable.length === 0) {
        keyboardEvent.preventDefault()
        dialog.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (keyboardEvent.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        keyboardEvent.preventDefault()
        last.focus()
      } else if (!keyboardEvent.shiftKey && document.activeElement === last) {
        keyboardEvent.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', trapFocus, true)
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('keydown', trapFocus, true)
      detailPreviousFocusRef.current?.focus({ preventScroll: true })
      detailPreviousFocusRef.current = null
    }
  }, [detailPanelOpen])

  // Escape key
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return

      // These dialogs own their Escape handling (focus trap + topmost popover).
      // Returning here prevents the page from navigating while they are open.
      if (showAddModal || showBlockModal || listHistoryParticipant) return

      const closeLayer = (close: () => void) => {
        e.preventDefault()
        e.stopImmediatePropagation()
        close()
      }

      // Close exactly one visible layer. In particular, an open filter is a
      // popover, not a request to leave the event.
      if (showFilterConfirmDialog) { closeLayer(() => setShowFilterConfirmDialog(false)); return }
      if (showMembershipHistory) { closeLayer(() => setShowMembershipHistory(false)); return }
      if (showGoogleSyncModal) { closeLayer(() => { if (!googleSyncing) setShowGoogleSyncModal(false) }); return }
      if (showExportModal) { closeLayer(() => { if (!exporting) setShowExportModal(false) }); return }
      if (showDeviceSelector) { closeLayer(() => setShowDeviceSelector(false)); return }
      if (showCampaignModal) { closeLayer(() => { if (!creatingCampaign) setShowCampaignModal(false) }); return }
      if (showInlineChat) { closeLayer(() => setShowInlineChat(false)); return }
      if (showStageModal) { closeLayer(() => setShowStageModal(false)); return }
      if (showNewLogbookModal) { closeLayer(() => { if (!creatingLogbook) setShowNewLogbookModal(false) }); return }
      if (showLogbookSettingsModal) { closeLayer(() => { if (!logbookSettingsUpdating) setShowLogbookSettingsModal(false) }); return }
      if (showStageEditorModal) { closeLayer(cancelStageEditMode); return }
      if (showMoreMenu) { closeLayer(() => setShowMoreMenu(false)); return }
      if (showFilterDropdown) { closeLayer(() => setShowFilterDropdown(false)); return }
      if (editingEventName) { closeLayer(() => setEditingEventName(false)); return }
      if (editingEntryId) { closeLayer(() => setEditingEntryId(null)); return }
      if (editingLogbookNotes) { closeLayer(() => setEditingLogbookNotes(false)); return }
      if (editingLogbookTitle) { closeLayer(() => setEditingLogbookTitle(false)); return }
      if (editingLogbookDate) { closeLayer(() => setEditingLogbookDate(false)); return }
      if (showDetailPanel) { closeLayer(() => setShowDetailPanel(false)); return }
      if (selectionMode) { closeLayer(() => { setSelectionMode(false); setSelectedIds(new Set()) }); return }
      if (selectedLogbook) { closeLayer(() => setSelectedLogbook(null)); return }
      // If in logbook mode, return to kanban view instead of leaving the event
      if (viewMode === 'logbook') { closeLayer(() => setViewMode('kanban')); return }
      // No modals open — go back to events list (preserves folder state)
      closeLayer(() => router.push('/dashboard/events' + (folderParam ? `?folder=${folderParam}` : '')))
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [
    showAddModal, showBlockModal, listHistoryParticipant, showFilterConfirmDialog,
    showMembershipHistory, showGoogleSyncModal, googleSyncing, showExportModal,
    exporting, showDeviceSelector, showCampaignModal, creatingCampaign,
    showInlineChat, showStageModal, showNewLogbookModal, creatingLogbook,
    showLogbookSettingsModal, logbookSettingsUpdating, showStageEditorModal,
    cancelStageEditMode, showMoreMenu, showFilterDropdown, editingEventName,
    editingEntryId, editingLogbookNotes, editingLogbookTitle, editingLogbookDate,
    showDetailPanel, selectionMode, selectedLogbook, viewMode, router, folderParam,
  ])

  // Close more menu on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setShowMoreMenu(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Check if Google is connected
  useEffect(() => {
    fetch('/api/google/status', { headers: { Authorization: `Bearer ${getToken()}` } })
      .then(r => r.json())
      .then(d => { if (d.connected) setGoogleConnected(true) })
      .catch(() => {})
  }, [])

  const fetchGoogleSyncStatus = useCallback(async () => {
    setGoogleSyncLoading(true)
    try {
      const res = await fetch(`/api/events/${eventId}/google-sync-status`, { headers: { Authorization: `Bearer ${getToken()}` } })
      const data = await res.json()
      if (data.success) setGoogleSyncStatus(data)
    } catch { /* ignore */ }
    finally { setGoogleSyncLoading(false) }
  }, [eventId])

  const handleGoogleSync = async () => {
    setGoogleSyncing(true)
    try {
      const res = await fetch(`/api/events/${eventId}/google-sync`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getToken()}` },
      })
      const data = await res.json()
      if (data.success) {
        setShowGoogleSyncModal(false)
        setGoogleSyncStatus(null)
      } else {
        alert(data.error || 'Error al sincronizar')
      }
    } catch { alert('Error de conexión') }
    finally { setGoogleSyncing(false) }
  }

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

  const activeFilterCount = filterStageIds.size + filterTagNames.size + excludeFilterTagNames.size + (appliedFormulaType === 'advanced' && appliedFormulaText ? 1 : 0) + (filterDatePreset ? 1 : 0) + (filterHasPhone ? 1 : 0) + (debouncedSearch ? 1 : 0)
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
      {/* Event Header — single compact row */}
      <div className="flex items-center gap-3 py-2 shrink-0">
        <button onClick={() => {
          if (viewMode === 'logbook') { setViewMode('kanban'); setSelectedLogbook(null) }
          else router.push('/dashboard/events' + (folderParam ? `?folder=${folderParam}` : ''))
        }} className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex items-center gap-2 min-w-0 group/name">
          <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: event.color }} />
          {editingEventName ? (
            <input
              ref={editNameRef}
              value={editNameValue}
              onChange={e => setEditNameValue(e.target.value)}
              onBlur={async () => {
                const v = editNameValue.trim()
                if (v && v !== event.name) {
                  try {
                    await fetch(`/api/events/${eventId}`, {
                      method: 'PUT',
                      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
                      body: JSON.stringify({ name: v }),
                    })
                    setEvent(prev => prev ? { ...prev, name: v } : prev)
                  } catch (e) { console.error('[Event] rename error:', e) }
                }
                setEditingEventName(false)
              }}
              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setEditingEventName(false) } }}
              className="font-bold text-lg text-slate-900 bg-transparent border-b-2 border-emerald-500 outline-none px-0 py-0 min-w-[120px] max-w-[500px] w-auto"
              size={Math.max(10, editNameValue.length)}
              autoFocus
            />
          ) : (
            <h1
              className={`font-bold text-lg text-slate-900 truncate max-w-[280px] ${eventIsReadOnly ? 'cursor-default' : 'cursor-text hover:bg-slate-100 hover:px-1.5 hover:rounded'}`}
              onClick={() => { if (!eventIsReadOnly) { setEditNameValue(event.name); setEditingEventName(true) } }}
              title={event.name}
            >{event.name}</h1>
          )}
          {!editingEventName && !eventIsReadOnly && (
            <button
              onClick={() => { setEditNameValue(event.name); setEditingEventName(true) }}
              className="opacity-0 group-hover/name:opacity-100 p-1 text-slate-400 hover:text-emerald-600 rounded transition flex-shrink-0"
              title="Editar nombre"
            >
              <Edit3 className="w-3.5 h-3.5" />
            </button>
          )}
          <span className="text-xs text-slate-400 font-medium tabular-nums bg-slate-100 px-2 py-0.5 rounded-full flex-shrink-0">{totalParticipantCount}</span>
        </div>

		<button onClick={openMembershipHistory} className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:border-emerald-300 hover:text-emerald-700 transition" title="Ver altas, salidas y reactivaciones">
		  <BookOpen className="w-3.5 h-3.5" />
		  Historial
		</button>

        {viewMode !== 'logbook' && (
          <>
            {/* Search + Filter dropdown container */}
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 z-10" />
              <input
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Buscar participante..."
                className={`w-full pl-8 pr-3 py-1.5 bg-white border rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 text-slate-800 placeholder:text-slate-400 text-sm ${activeFilterCount > 0 ? 'border-emerald-400 ring-1 ring-emerald-200' : 'border-slate-200'}`}
              />
              <button
                onClick={() => setShowFilterDropdown(!showFilterDropdown)}
                className={`absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md transition ${activeFilterCount > 0 ? 'bg-green-100 text-green-700' : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'}`}
              >
                <Filter className="w-3.5 h-3.5" />
                {activeFilterCount > 0 && (
                  <span className="absolute -top-1 -right-1 w-4 h-4 bg-emerald-600 text-white text-[10px] rounded-full flex items-center justify-center">{activeFilterCount}</span>
                )}
              </button>

              {/* ─── Two-Column Filter Dropdown ─── */}
              {showFilterDropdown && (
                <div className="absolute left-0 top-full mt-1 w-[min(620px,90vw)] bg-white border border-slate-200/80 rounded-2xl shadow-2xl shadow-slate-200/50 z-50 flex flex-col max-h-[70vh]" onClick={e => e.stopPropagation()}>
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
                          onClick={() => { setFilterStageIds(new Set()); setFilterTagNames(new Set()); setExcludeFilterTagNames(new Set()); setTagFilterMode('OR'); setFilterHasPhone(false); setPFormulaType('simple'); setPFormulaText(''); setPFormulaIsValid(true); setAppliedFormulaType('simple'); setAppliedFormulaText(''); setFilterDateField('created_at'); setFilterDatePreset(''); setFilterDateFrom(''); setFilterDateTo(''); setTagSearchQuery('') }}
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

                        {/* Simple mode — tag search + grid */}
                        {pFormulaType === 'simple' ? (
                          <div className="flex-1 overflow-y-auto p-3 space-y-2">
                            <div className="relative">
                              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                              <input
                                type="text"
                                placeholder="Buscar etiqueta..."
                                value={tagSearchQuery}
                                onChange={(e) => setTagSearchQuery(e.target.value)}
                                className="w-full pl-8 pr-3 py-1.5 text-xs border border-slate-200 rounded-lg bg-white focus:ring-2 focus:ring-emerald-500 focus:border-transparent outline-none transition placeholder:text-slate-400"
                              />
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {allUniqueTags.filter(t => t.name.toLowerCase().includes(tagSearchQuery.toLowerCase())).map(tag => {
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
                              placeholder={'Ej: "kommo" and not in ("iquitos" or "conf_03-jun")'}
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
          </>
        )}

        {/* View toggle */}
        <div className="inline-flex items-center border border-slate-200 rounded-lg overflow-hidden flex-shrink-0">
          <button onClick={() => setViewMode('kanban')} className={`inline-flex items-center gap-1 px-2 py-1.5 text-xs font-medium transition ${viewMode === 'kanban' ? 'bg-emerald-50 text-emerald-700' : 'text-slate-500 hover:bg-slate-50'}`}>
            <LayoutGrid className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => setViewMode('list')} className={`inline-flex items-center gap-1 px-2 py-1.5 text-xs font-medium transition ${viewMode === 'list' ? 'bg-emerald-50 text-emerald-700' : 'text-slate-500 hover:bg-slate-50'}`}>
            <List className="w-3.5 h-3.5" />
          </button>
        </div>

        {viewMode === 'kanban' && !stageEditMode && (
          <button
            onClick={beginStageEditMode}
            disabled={eventIsReadOnly}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-slate-300 rounded-lg text-sm text-slate-600 hover:bg-slate-50 transition-colors flex-shrink-0 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
            title={eventIsReadOnly ? 'El evento está cerrado' : 'Editar etapas'}
          >
            <PenLine className="w-4 h-4" />
            <span className="hidden sm:inline">Editar etapas</span>
          </button>
        )}

        {/* ─── "Más" dropdown menu ─── */}
        <div ref={moreMenuRef} className="relative flex-shrink-0">
          <button
            onClick={() => setShowMoreMenu(v => !v)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 border rounded-lg text-sm transition-colors ${
              showMoreMenu ? 'border-slate-400 bg-slate-100 text-slate-700'
                : 'border-slate-300 hover:bg-slate-50 text-slate-600'
            }`}
            title="Más acciones"
          >
            <MoreHorizontal className="w-4 h-4" />
            <span className="hidden sm:inline">Más</span>
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showMoreMenu ? 'rotate-180' : ''}`} />
          </button>

          {showMoreMenu && (
            <div className="absolute right-0 top-full mt-1.5 w-56 bg-white border border-slate-200 rounded-xl shadow-xl z-30 py-1 overflow-hidden">
              {/* 1. Agregar contacto */}
              <button
                onClick={() => { setAddParticipantError(''); setAddTab('search'); setShowAddModal(true); setShowMoreMenu(false) }}
                disabled={eventIsReadOnly}
                title={eventIsReadOnly ? 'El evento está cerrado' : 'Buscar contactos para agregar'}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-emerald-700 font-medium hover:bg-emerald-50 transition-colors disabled:cursor-not-allowed disabled:text-slate-400 disabled:hover:bg-white"
              >
                <UserPlus className="w-4 h-4 text-emerald-500" />
                Agregar contacto
              </button>

              {/* 2. Envío masivo */}
              <button
                onClick={async () => {
                  setShowMoreMenu(false)
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
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
              >
                <Send className="w-4 h-4 text-slate-400" />
                Envío masivo
              </button>

              {/* 3. Sincronizar Google */}
              {googleConnected && (
                <button
                  onClick={() => { setShowGoogleSyncModal(true); fetchGoogleSyncStatus(); setShowMoreMenu(false) }}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
                >
                  <RefreshCw className="w-4 h-4 text-slate-400" />
                  Sincronizar Google
                </button>
              )}

              {/* 4. Registrar contacto */}
              <button
                onClick={() => { setAddParticipantError(''); setAddTab('manual'); setShowAddModal(true); setShowMoreMenu(false) }}
                disabled={eventHasMembershipRules || eventIsReadOnly}
                title={eventIsReadOnly ? 'El evento está cerrado' : eventHasMembershipRules ? 'Disponible solo para eventos sin reglas' : 'Crear y agregar un contacto'}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-left text-sm text-slate-700 hover:bg-slate-50 transition-colors disabled:cursor-not-allowed disabled:text-slate-400 disabled:hover:bg-white"
              >
                <Plus className="w-4 h-4 text-slate-400" />
                <span>
                  <span className="block">Registrar contacto</span>
                  {eventHasMembershipRules && <span className="block text-[10px] font-normal text-amber-600">Requiere un evento sin reglas</span>}
                </span>
              </button>

              {/* 5. Editar etapas */}
              <button
                onClick={beginStageEditMode}
                disabled={eventIsReadOnly}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors disabled:cursor-not-allowed disabled:text-slate-400 disabled:hover:bg-white"
              >
                <PenLine className="w-4 h-4 text-slate-400" />
                Editar etapas
              </button>

              <button
                onClick={handleDuplicateEvent}
                disabled={duplicatingEvent}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors disabled:opacity-50"
              >
                {duplicatingEvent ? <Loader2 className="w-4 h-4 text-slate-400 animate-spin" /> : <Copy className="w-4 h-4 text-slate-400" />}
                Duplicar evento
              </button>

              <div className="my-1 border-t border-slate-100" />

              {/* 6. Exportar */}
              <button
                onClick={() => { setExportScope(activeFilterCount > 0 ? 'filtered' : 'all'); setShowExportModal(true); setShowMoreMenu(false) }}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
              >
                <Download className="w-4 h-4 text-slate-400" />
                Exportar
              </button>

              {/* 7. Bitácora */}
              <button
                onClick={() => { setViewMode(viewMode === 'logbook' ? 'kanban' : 'logbook'); setShowMoreMenu(false) }}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
              >
                <BookOpen className="w-4 h-4 text-slate-400" />
                Bitácora
              </button>
            </div>
          )}
        </div>
      </div>

      {eventIsReadOnly && (
        <div className="mb-2 flex shrink-0 items-start gap-2.5 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
          <div>
            <p className="font-semibold">Evento de solo lectura</p>
            <p className="mt-0.5 text-xs text-slate-500">Puedes consultar participantes, historial y oportunidades relacionadas, pero no agregar, mover ni retirar personas.</p>
          </div>
        </div>
      )}

      {/* ═══ Kanban View ═══ */}
      {viewMode === 'kanban' && (
        <div className="flex-1 min-h-0 flex flex-col animate-view-enter">
          <div ref={topScrollRef} onScroll={handleTopScroll} className="overflow-x-auto kanban-scroll-top flex-shrink-0" style={{ height: 12 }}>
            <div style={{ width: `${kanbanColumnCount * 288}px`, height: 1 }} />
          </div>
          <div ref={kanbanRef} onScroll={handleKanbanScroll} className="overflow-x-auto flex-1 min-h-0 kanban-scroll">
            <div className="flex gap-3 h-full" style={{ minWidth: `${kanbanColumnCount * 288}px` }}>
              {renderedStageData.map((stageItem) => (
                <VirtualKanbanColumn
                  key={stageItem.id}
                  column={stageItem}
                  totalCount={stageItem.total_count}
                  hasMore={stageItem.has_more}
                  loadingMore={loadingMoreStages.has(stageItem.id)}
                  onLoadMore={() => { if (!stageEditMode) loadMoreForStage(stageItem.id) }}
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
                  onColorStage={handleColorStage}
                  onDeleteStage={handleDeleteStage}
                  canManageStage={stageEditMode && !eventIsReadOnly}
                  canDragParticipants={!stageEditMode && !eventIsReadOnly}
                  stageEditMode={stageEditMode}
                  onStageDragStart={setDraggedStageId}
                  onStageDrop={handleStageColumnDrop}
                  isStageDragging={draggedStageId === stageItem.id}
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
                  canManageStage={false}
                  canDragParticipants={!stageEditMode && !eventIsReadOnly}
                />
              )}
            </div>
          </div>
        </div>
      )}

      {/* ═══ List View — Virtualized ═══ */}
      {viewMode === 'list' && (
        <div className="flex-1 min-h-0 flex flex-col animate-view-enter">
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
                          detailParticipant?.id === p.id ? 'bg-emerald-100 border-l-[3px] border-l-emerald-500 shadow-sm ring-1 ring-emerald-200/60' : 'border-l-[3px] border-l-transparent'
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
                          onClick={(e) => { e.stopPropagation(); if (obs && obs.length > 0) { setListHistoryParticipant(p) } }}
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
                          {!eventIsReadOnly && (
                            <button onClick={(e) => { e.stopPropagation(); handleDeleteParticipant(p.id) }} className="p-1 text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity" title="Sacar del evento">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
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

      {/* ═══ Logbook (Bitácora) View ═══ */}
      {viewMode === 'logbook' && (
        <div className="flex-1 min-h-0 flex animate-view-enter">
          {/* Left Panel — Logbook list */}
          <div className="w-[280px] border-r border-slate-200 bg-slate-50/50 flex flex-col flex-shrink-0">
            <div className="px-3 py-3 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-700">Bitácoras</h3>
              <div className="flex items-center gap-1">
                {event?.event_date && (
                  <button onClick={handleAutoCreateLogbooks} disabled={autoCreating}
                    className="p-1.5 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition disabled:opacity-50" title="Auto-crear desde rango de fechas">
                    {autoCreating ? <Loader2 className="w-4 h-4 animate-spin" /> : <CalendarDays className="w-4 h-4" />}
                  </button>
                )}
                <button onClick={() => setShowNewLogbookModal(true)}
                  className="p-1.5 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition" title="Nueva bitácora">
                  <Plus className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {logbooksLoading ? (
                <div className="space-y-2 p-3">
                  {[...Array(4)].map((_, i) => <div key={i} className="h-14 bg-slate-100 rounded-lg animate-pulse" />)}
                </div>
              ) : logbooks.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center px-4">
                  <BookOpen className="w-10 h-10 text-slate-300 mb-3" />
                  <p className="text-sm text-slate-500 font-medium">Sin bitácoras</p>
                  <p className="text-xs text-slate-400 mt-1">Crea una bitácora para registrar el estado de los participantes en una fecha</p>
                  {event?.event_date && (
                    <button onClick={handleAutoCreateLogbooks} disabled={autoCreating}
                      className="mt-4 flex items-center gap-2 px-3 py-2 bg-emerald-600 text-white rounded-lg text-xs font-medium hover:bg-emerald-700 transition shadow-sm disabled:opacity-50">
                      {autoCreating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CalendarDays className="w-3.5 h-3.5" />}
                      Crear desde fechas del evento
                    </button>
                  )}
                </div>
              ) : (
                <div className="p-2 space-y-1">
                  {logbooks.map(lb => (
                    <button key={lb.id}
                      onClick={() => fetchLogbookDetail(lb.id)}
                      className={`w-full text-left px-3 py-2.5 rounded-lg transition-all group ${
                        selectedLogbook?.id === lb.id
                          ? 'bg-emerald-50 border border-emerald-200 shadow-sm'
                          : 'hover:bg-white hover:shadow-sm border border-transparent'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div className={`w-2 h-2 rounded-full flex-shrink-0 ${lb.status === 'completed' ? 'bg-emerald-500' : 'bg-amber-400'}`} />
                          <span className="text-sm font-medium text-slate-800 truncate">{lb.title || format(parseLogbookDate(lb.date), 'dd/MM/yyyy')}</span>
                        </div>
                        <button onClick={(e) => { e.stopPropagation(); handleDeleteLogbook(lb.id) }}
                          className="p-1 text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity">
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                      <div className="flex items-center gap-2 mt-1 ml-4">
                        <span className="text-[11px] text-slate-400">{format(parseLogbookDate(lb.date), 'dd MMM yyyy', { locale: es })}</span>
                        {lb.status !== 'pending' && (
                          <span className={`text-[10px] font-medium ${lb.status === 'completed' ? 'text-emerald-600' : 'text-blue-600'}`}>{lb.total_participants} part.</span>
                        )}
                        {lb.status === 'pending' && (
                          <span className="text-[10px] text-amber-500 font-medium">Pendiente</span>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Right Panel — Logbook detail */}
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            {selectedLogbookLoading ? (
              <div className="flex-1 flex items-center justify-center">
                <Loader2 className="w-8 h-8 animate-spin text-emerald-500" />
              </div>
            ) : selectedLogbook ? (
              <>
                {/* Logbook header */}
                <div className="px-5 py-2.5 border-b border-slate-200 bg-white flex-shrink-0">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2 group/lbtitle">
                        {editingLogbookTitle ? (
                          <input
                            value={editLogbookTitleValue}
                            onChange={e => setEditLogbookTitleValue(e.target.value)}
                            onBlur={async () => {
                              const v = editLogbookTitleValue.trim()
                              if (v && v !== selectedLogbook.title) {
                                try {
                                  const res = await fetch(`/api/events/${eventId}/logbooks/${selectedLogbook.id}`, {
                                    method: 'PUT',
                                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
                                    body: JSON.stringify({ title: v }),
                                  })
                                  const data = await res.json()
                                  if (data.id) { setSelectedLogbook(data); fetchLogbooks() }
                                } catch (e) { console.error('[Logbook] rename error:', e) }
                              }
                              setEditingLogbookTitle(false)
                            }}
                            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditingLogbookTitle(false) }}
                            className="text-lg font-semibold text-slate-900 bg-transparent border-b-2 border-emerald-500 outline-none px-0"
                            autoFocus
                          />
                        ) : (
                          <h3
                            className="text-lg font-semibold text-slate-900 cursor-text hover:bg-slate-100 hover:px-1.5 hover:rounded transition"
                            onClick={() => { setEditLogbookTitleValue(selectedLogbook.title || format(parseLogbookDate(selectedLogbook.date), 'dd/MM/yyyy')); setEditingLogbookTitle(true) }}
                            title="Click para editar"
                          >{selectedLogbook.title || format(parseLogbookDate(selectedLogbook.date), 'dd/MM/yyyy')}</h3>
                        )}
                        {!editingLogbookTitle && (
                          <button onClick={() => { setEditLogbookTitleValue(selectedLogbook.title || format(parseLogbookDate(selectedLogbook.date), 'dd/MM/yyyy')); setEditingLogbookTitle(true) }}
                            className="opacity-0 group-hover/lbtitle:opacity-100 p-1 text-slate-400 hover:text-emerald-600 rounded transition">
                            <Edit3 className="w-3 h-3" />
                          </button>
                        )}
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                          selectedLogbook.status === 'completed' ? 'bg-emerald-50 text-emerald-700' :
                          selectedLogbook.status === 'active' ? 'bg-blue-50 text-blue-700' : 'bg-amber-50 text-amber-700'
                        }`}>
                          {selectedLogbook.status === 'completed' ? 'Completada' :
                           selectedLogbook.status === 'active' ? 'Activa' : 'Pendiente'}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 mt-0.5">
                        {editingLogbookDate ? (
                          <input
                            type="date"
                            value={editLogbookDateValue}
                            onChange={e => setEditLogbookDateValue(e.target.value)}
                            onBlur={async () => {
                              if (editLogbookDateValue && editLogbookDateValue !== selectedLogbook.date.slice(0, 10)) {
                                try {
                                  const res = await fetch(`/api/events/${eventId}/logbooks/${selectedLogbook.id}`, {
                                    method: 'PUT',
                                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
                                    body: JSON.stringify({ date: editLogbookDateValue }),
                                  })
                                  const data = await res.json()
                                  if (data.id) { setSelectedLogbook(data); fetchLogbooks() }
                                } catch (e) { console.error('[Logbook] date error:', e) }
                              }
                              setEditingLogbookDate(false)
                            }}
                            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditingLogbookDate(false) }}
                            className="text-xs text-slate-500 bg-transparent border-b border-emerald-500 outline-none"
                            autoFocus
                          />
                        ) : (
                          <p className="text-xs text-slate-400 cursor-pointer hover:text-emerald-600 transition"
                            onClick={() => { setEditLogbookDateValue(selectedLogbook.date.slice(0, 10)); setEditingLogbookDate(true) }}
                            title="Click para cambiar fecha">
                            {format(parseLogbookDate(selectedLogbook.date), "EEEE, d 'de' MMMM yyyy", { locale: es })}
                          </p>
                        )}
                        {selectedLogbook.captured_at && !editingLogbookDate && (
                          <span className="text-xs text-slate-400"> · Capturada {formatDistanceToNow(new Date(selectedLogbook.captured_at), { locale: es, addSuffix: true })}</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={() => {
                        setLogbookSettingsTitle(selectedLogbook.title)
                        setLogbookSettingsDate(selectedLogbook.date.split('T')[0])
                        setLogbookSettingsStatus(selectedLogbook.status)
                        setShowLogbookSettingsModal(true)
                      }} className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition" title="Configurar bitácora">
                        <Settings className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleCaptureSnapshot(selectedLogbook.id)}
                        disabled={capturingSnapshot || selectedLogbook.status === 'completed'}
                        className={`flex items-center gap-1.5 px-3 py-2 text-white rounded-lg text-xs font-medium transition shadow-sm disabled:opacity-50 ${selectedLogbook.status === 'completed' ? 'bg-slate-400 cursor-not-allowed' : 'bg-emerald-600 hover:bg-emerald-700'}`}>
                        {capturingSnapshot ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> :
                           selectedLogbook.status === 'completed' ? <Lock className="w-3.5 h-3.5" /> : <Camera className="w-3.5 h-3.5" />}
                        {selectedLogbook.status === 'completed' ? 'Completado' : selectedLogbook.status === 'active' ? 'Re-capturar' : 'Capturar Snapshot'}
                        {activeFilterCount > 0 && selectedLogbook.status !== 'completed' && <span className="bg-white/20 rounded px-1 text-[10px]">({totalParticipantCount})</span>}
                      </button>
                    </div>
                  </div>

                  {/* Stage snapshot badges */}
                  {selectedLogbook.status !== 'pending' && selectedLogbook.stage_snapshot && Object.keys(selectedLogbook.stage_snapshot).length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {Object.entries(selectedLogbook.stage_snapshot).map(([key, stage]) => (
                        <div key={key} className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium text-white"
                          style={{ backgroundColor: stage.color || '#94a3b8' }}>
                          {stage.name || 'Sin etapa'}: {stage.count}
                        </div>
                      ))}
                      <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-600">
                        Total: {selectedLogbook.total_participants}
                      </div>
                    </div>
                  )}
                </div>

                {/* General notes */}
                <div className="px-5 py-2 border-b border-slate-100 bg-slate-50/50 flex-shrink-0">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-slate-500 uppercase tracking-wider">Observaciones generales</span>
                    {!editingLogbookNotes ? (
                      <button onClick={() => { setLogbookNotesText(selectedLogbook.general_notes || ''); setEditingLogbookNotes(true) }}
                        className="p-1 text-slate-400 hover:text-emerald-600 rounded transition">
                        <PenLine className="w-3.5 h-3.5" />
                      </button>
                    ) : (
                      <div className="flex items-center gap-1">
                        <button onClick={() => setEditingLogbookNotes(false)} className="p-1 text-slate-400 hover:text-slate-600 rounded transition">
                          <X className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={handleSaveLogbookNotes} disabled={savingLogbookNotes}
                          className="p-1 text-emerald-600 hover:text-emerald-700 rounded transition disabled:opacity-50">
                          {savingLogbookNotes ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    )}
                  </div>
                  {editingLogbookNotes ? (
                    <textarea
                      value={logbookNotesText}
                      onChange={e => setLogbookNotesText(e.target.value)}
                      className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500 outline-none resize-none"
                      rows={3}
                      placeholder="Notas sobre esta fecha..."
                      autoFocus
                    />
                  ) : (
                    <p className="text-sm text-slate-600 whitespace-pre-line">{selectedLogbook.general_notes || <span className="text-slate-400 italic">Sin notas</span>}</p>
                  )}
                </div>

                {/* View mode toggle */}
                {selectedLogbook.status === 'completed' && selectedLogbook.entries && selectedLogbook.entries.length > 0 && (
                  <div className="px-5 py-2 border-b border-slate-100 bg-white flex-shrink-0 flex items-center justify-between">
                    <span className="text-xs text-slate-400">{selectedLogbook.entries.length} participantes</span>
                    <div className="inline-flex items-center bg-slate-100 rounded-lg p-0.5">
                      <button
                        onClick={() => setLogbookViewMode('list')}
                        className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium transition ${
                          logbookViewMode === 'list' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                        }`}
                      >
                        <List className="w-3 h-3" />
                        Lista
                      </button>
                      <button
                        onClick={() => setLogbookViewMode('kanban')}
                        className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium transition ${
                          logbookViewMode === 'kanban' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                        }`}
                      >
                        <LayoutGrid className="w-3 h-3" />
                        Kanban
                      </button>
                    </div>
                  </div>
                )}

                {/* Entries */}
                <div className="flex-1 overflow-y-auto">
                  {selectedLogbook.status === 'pending' ? (
                    <div className="flex flex-col h-full">
                      {/* Preview banner + capture button */}
                      <div className="px-5 py-3 bg-amber-50 border-b border-amber-200 flex items-center justify-between gap-3 flex-shrink-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="w-2 h-2 rounded-full bg-amber-400 flex-shrink-0" />
                          <span className="text-xs text-amber-700 font-medium">
                            Vista previa{previewParticipants.length > 0 ? ` · ${previewParticipants.length} participantes` : ''}
                          </span>
                          {selectedLogbook.saved_filter && (
                            <span className="text-[10px] text-amber-500 bg-amber-100 px-1.5 py-0.5 rounded">Con filtro guardado</span>
                          )}
                        </div>
                        <button onClick={() => handleCaptureSnapshot(selectedLogbook.id)} disabled={capturingSnapshot}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-medium hover:bg-emerald-700 transition shadow-sm disabled:opacity-50 flex-shrink-0">
                          {capturingSnapshot ? <Loader2 className="w-3 h-3 animate-spin" /> : <Camera className="w-3 h-3" />}
                          Capturar Snapshot
                        </button>
                      </div>

                      {/* Preview participants list */}
                      {previewLoading ? (
                        <div className="flex items-center justify-center py-16">
                          <Loader2 className="w-6 h-6 animate-spin text-slate-300" />
                        </div>
                      ) : previewParticipants.length > 0 ? (
                        <div className="flex-1 overflow-y-auto">
                          <table className="w-full">
                            <thead className="sticky top-0 bg-white z-10">
                              <tr className="border-b border-slate-200">
                                <th className="text-left text-[11px] font-semibold text-slate-500 uppercase tracking-wider py-2.5 px-4 w-[200px]">Participante</th>
                                <th className="text-left text-[11px] font-semibold text-slate-500 uppercase tracking-wider py-2.5 px-4">Etapa</th>
                                <th className="text-left text-[11px] font-semibold text-slate-500 uppercase tracking-wider py-2.5 px-4 w-[140px]">Teléfono</th>
                              </tr>
                            </thead>
                            <tbody>
                              {previewParticipants.map((p, idx) => (
                                <tr key={p.id} className={`border-b border-slate-50 ${idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'}`}>
                                  <td className="py-2 px-4">
                                    <span className="text-sm text-slate-700 font-medium">{p.name}</span>
                                  </td>
                                  <td className="py-2 px-4">
                                    {p.stage_name ? (
                                      <span className="inline-flex items-center gap-1.5 text-xs">
                                        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: p.stage_color || '#94a3b8' }} />
                                        {p.stage_name}
                                      </span>
                                    ) : (
                                      <span className="text-xs text-slate-400">Sin etapa</span>
                                    )}
                                  </td>
                                  <td className="py-2 px-4 text-xs text-slate-500 font-mono">{p.phone || '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center justify-center py-16 text-center">
                          <Camera className="w-12 h-12 text-slate-300 mb-3" />
                          <p className="text-sm text-slate-500 font-medium">Bitácora pendiente</p>
                          <p className="text-xs text-slate-400 mt-1 max-w-sm">
                            {selectedLogbook.saved_filter
                              ? 'El filtro guardado no encontró participantes que coincidan actualmente'
                              : activeFilterCount > 0
                                ? `Captura un snapshot con los ${totalParticipantCount} participantes filtrados actualmente`
                                : 'Captura un snapshot para registrar el estado actual de todos los participantes en esta fecha'}
                          </p>
                          {!selectedLogbook.saved_filter && (
                            <button onClick={() => handleCaptureSnapshot(selectedLogbook.id)} disabled={capturingSnapshot}
                              className="mt-4 flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 transition shadow-sm disabled:opacity-50">
                              {capturingSnapshot ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-4 h-4" />}
                              {activeFilterCount > 0 ? `Capturar (${totalParticipantCount} filtrados)` : 'Capturar Snapshot'}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  ) : selectedLogbook.entries && selectedLogbook.entries.length > 0 ? (
                    logbookViewMode === 'list' ? (
                    <table className="w-full">
                      <thead className="sticky top-0 bg-white z-10">
                        <tr className="border-b border-slate-200">
                          <th className="text-left text-[11px] font-semibold text-slate-500 uppercase tracking-wider py-2.5 px-4 w-[200px]">Participante</th>
                          <th className="text-left text-[11px] font-semibold text-slate-500 uppercase tracking-wider py-2.5 px-4 w-[120px]">Etapa</th>
                          <th className="text-left text-[11px] font-semibold text-slate-500 uppercase tracking-wider py-2.5 px-4">Notas</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {selectedLogbook.entries.map(entry => (
                          <tr key={entry.id} className="hover:bg-slate-50/50 transition-colors">
                            <td className="px-4 py-2.5">
                              <div className="flex items-center gap-2">
                                <div className="w-7 h-7 bg-emerald-50 rounded-full flex items-center justify-center flex-shrink-0">
                                  <span className="text-emerald-700 text-xs font-semibold">{(entry.participant_name || '?').charAt(0).toUpperCase()}</span>
                                </div>
                                <div className="min-w-0">
                                  <p className="text-[13px] font-medium text-slate-800 truncate">{entry.participant_name}</p>
                                  {entry.participant_phone && <p className="text-[10px] text-slate-400">{entry.participant_phone}</p>}
                                </div>
                              </div>
                            </td>
                            <td className="px-4 py-2.5">
                              {entry.stage_name ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold text-white" style={{ backgroundColor: entry.stage_color || '#94a3b8' }}>
                                  {entry.stage_name}
                                </span>
                              ) : <span className="text-[10px] text-slate-400 italic">—</span>}
                            </td>
                            <td className="px-4 py-2.5">
                              {editingEntryId === entry.id ? (
                                <div className="flex items-center gap-2">
                                  <input
                                    value={entryNotesText}
                                    onChange={e => setEntryNotesText(e.target.value)}
                                    className="flex-1 bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-sm text-slate-700 focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500 outline-none"
                                    placeholder="Nota sobre este participante..."
                                    autoFocus
                                    onKeyDown={e => { if (e.key === 'Enter') handleSaveEntryNotes(entry.id); if (e.key === 'Escape') setEditingEntryId(null) }}
                                  />
                                  <button onClick={() => handleSaveEntryNotes(entry.id)} disabled={savingEntryNotes}
                                    className="p-1 text-emerald-600 hover:text-emerald-700 disabled:opacity-50">
                                    {savingEntryNotes ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                                  </button>
                                  <button onClick={() => setEditingEntryId(null)} className="p-1 text-slate-400 hover:text-slate-600">
                                    <X className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              ) : (
                                <div className="flex items-center gap-1 group/notes cursor-pointer"
                                  onClick={() => { setEditingEntryId(entry.id); setEntryNotesText(entry.notes || '') }}>
                                  {entry.notes ? (
                                    <span className="text-sm text-slate-600">{entry.notes}</span>
                                  ) : (
                                    <span className="text-xs text-slate-300 italic">Agregar nota...</span>
                                  )}
                                  <PenLine className="w-3 h-3 text-slate-300 opacity-0 group-hover/notes:opacity-100 transition-opacity" />
                                </div>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    ) : (
                    /* Kanban view */
                    <div className="h-full flex flex-col">
                      <div className="flex-1 overflow-x-auto overflow-y-hidden">
                        <div className="flex gap-3 p-4 h-full min-w-min">
                          {(() => {
                            // Build columns from stage_snapshot first (includes stages with 0 participants)
                            const grouped: Record<string, { name: string; color: string; entries: typeof selectedLogbook.entries }> = {}
                            const stageOrder: string[] = []
                            if (selectedLogbook.stage_snapshot) {
                              for (const [key, stage] of Object.entries(selectedLogbook.stage_snapshot)) {
                                if (key === 'unassigned') continue
                                grouped[stage.name || key] = { name: stage.name || 'Sin etapa', color: stage.color || '#94a3b8', entries: [] }
                                stageOrder.push(stage.name || key)
                              }
                            }
                            // Assign entries to their stage columns
                            for (const entry of selectedLogbook.entries) {
                              const key = entry.stage_name || '__none__'
                              if (!grouped[key]) {
                                grouped[key] = { name: entry.stage_name || 'Sin etapa', color: entry.stage_color || '#94a3b8', entries: [] }
                              }
                              grouped[key].entries.push(entry)
                            }
                            // Sort: snapshot order first, then unnamed, "Sin etapa" last
                            const sortedKeys = Object.keys(grouped).sort((a, b) => {
                              if (a === '__none__') return 1
                              if (b === '__none__') return -1
                              const ia = stageOrder.indexOf(a)
                              const ib = stageOrder.indexOf(b)
                              if (ia !== -1 && ib !== -1) return ia - ib
                              if (ia !== -1) return -1
                              if (ib !== -1) return 1
                              return a.localeCompare(b)
                            })
                            return sortedKeys.map(key => {
                              const group = grouped[key]
                              return (
                                <div key={key} className="flex flex-col w-[220px] min-w-[220px] bg-slate-50 rounded-xl border border-slate-200/80 overflow-hidden">
                                  {/* Column header */}
                                  <div className="px-3 py-2.5 flex items-center gap-2 flex-shrink-0" style={{ borderBottom: `2px solid ${group.color}` }}>
                                    <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: group.color }} />
                                    <span className="text-xs font-semibold text-slate-700 truncate">{group.name}</span>
                                    <span className="ml-auto text-[10px] font-bold text-slate-400 bg-white rounded-full px-1.5 py-0.5">{group.entries.length}</span>
                                  </div>
                                  {/* Cards */}
                                  <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
                                    {group.entries.map(entry => (
                                      <div key={entry.id} className="bg-white rounded-lg border border-slate-100 p-2.5 shadow-sm hover:shadow-md hover:border-slate-200 transition-all group/card">
                                        <div className="flex items-center gap-2">
                                          <div className="w-6 h-6 bg-emerald-50 rounded-full flex items-center justify-center flex-shrink-0">
                                            <span className="text-emerald-700 text-[10px] font-semibold">{(entry.participant_name || '?').charAt(0).toUpperCase()}</span>
                                          </div>
                                          <div className="min-w-0 flex-1">
                                            <p className="text-[12px] font-medium text-slate-800 truncate leading-tight">{entry.participant_name}</p>
                                            {entry.participant_phone && <p className="text-[10px] text-slate-400 leading-tight">{entry.participant_phone}</p>}
                                          </div>
                                        </div>
                                        {/* Notes inline */}
                                        <div className="mt-1.5">
                                          {editingEntryId === entry.id ? (
                                            <div className="flex items-center gap-1">
                                              <input
                                                value={entryNotesText}
                                                onChange={e => setEntryNotesText(e.target.value)}
                                                className="flex-1 bg-slate-50 border border-slate-200 rounded px-1.5 py-1 text-[11px] text-slate-700 focus:ring-1 focus:ring-emerald-500/40 focus:border-emerald-500 outline-none"
                                                placeholder="Nota..."
                                                autoFocus
                                                onKeyDown={e => { if (e.key === 'Enter') handleSaveEntryNotes(entry.id); if (e.key === 'Escape') setEditingEntryId(null) }}
                                              />
                                              <button onClick={() => handleSaveEntryNotes(entry.id)} disabled={savingEntryNotes}
                                                className="p-0.5 text-emerald-600 hover:text-emerald-700 disabled:opacity-50">
                                                {savingEntryNotes ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
                                              </button>
                                              <button onClick={() => setEditingEntryId(null)} className="p-0.5 text-slate-400 hover:text-slate-600">
                                                <X className="w-3 h-3" />
                                              </button>
                                            </div>
                                          ) : (
                                            <div className="flex items-center gap-1 cursor-pointer group/cnotes"
                                              onClick={() => { setEditingEntryId(entry.id); setEntryNotesText(entry.notes || '') }}>
                                              {entry.notes ? (
                                                <p className="text-[11px] text-slate-500 leading-snug line-clamp-2">{entry.notes}</p>
                                              ) : (
                                                <p className="text-[10px] text-slate-300 italic opacity-0 group-hover/card:opacity-100 transition-opacity">+ nota</p>
                                              )}
                                              <PenLine className="w-2.5 h-2.5 text-slate-300 opacity-0 group-hover/cnotes:opacity-100 transition-opacity flex-shrink-0" />
                                            </div>
                                          )}
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )
                            })
                          })()}
                        </div>
                      </div>
                    </div>
                    )
                  ) : (
                    <div className="flex flex-col items-center justify-center py-16 text-slate-400">
                      <Users className="w-10 h-10 mb-2 text-slate-300" />
                      <p className="text-sm">Sin entradas</p>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-center">
                <BookOpen className="w-12 h-12 text-slate-300 mb-3" />
                <p className="text-sm text-slate-500 font-medium">Selecciona una bitácora</p>
                <p className="text-xs text-slate-400 mt-1">Elige una fecha del panel izquierdo para ver el detalle</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Stage Editor Modal */}
      {showStageEditorModal && (
        <div className="fixed inset-0 bg-slate-950/45 backdrop-blur-sm flex items-center justify-center z-[60] p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[88vh] border border-slate-200 flex flex-col overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-slate-950">Configurar etapas</h2>
                <p className="text-sm text-slate-500 mt-0.5">{event?.name || 'Evento'}</p>
              </div>
              <button
                onClick={cancelStageEditMode}
                disabled={stageLayoutSaving}
                className="p-2 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition disabled:opacity-50"
                aria-label="Cerrar"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-6 py-5 overflow-y-auto space-y-5">
              <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-end rounded-xl border border-slate-200 bg-slate-50 p-4">
                <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-500 uppercase tracking-wider mb-1.5">Nueva etapa</label>
                    <input
                      value={newStageName}
                      onChange={e => setNewStageName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleCreateStage() }}
                      className="w-full bg-white border border-slate-200 text-slate-800 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 outline-none"
                      placeholder="Ej: Seguimiento"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-500 uppercase tracking-wider mb-1.5">Color</label>
                    <div className="flex flex-wrap gap-1.5 min-w-[200px]">
                      {STAGE_COLOR_OPTIONS.map(color => (
                        <button
                          key={color}
                          type="button"
                          onClick={() => setNewStageColor(color)}
                          className={`w-8 h-8 rounded-full border-2 transition ${newStageColor === color ? 'border-slate-900 scale-105 shadow-sm' : 'border-white hover:scale-105'}`}
                          style={{ backgroundColor: color }}
                          aria-label={`Color ${color}`}
                        />
                      ))}
                    </div>
                  </div>
                </div>
                <button
                  onClick={handleCreateStage}
                  disabled={!newStageName.trim() || stageLayoutSaving}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Plus className="w-4 h-4" />
                  Crear etapa
                </button>
              </div>

              <div className="space-y-2">
                {activeDraftStages.map((stage, idx) => (
                  <div
                    key={stage.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData('application/x-event-stage', stage.id)
                      setDraggedStageId(stage.id)
                    }}
                    onDragOver={(e) => {
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      const sourceId = draggedStageId || e.dataTransfer.getData('application/x-event-stage')
                      if (sourceId) moveDraftStage(sourceId, stage.id)
                      setDraggedStageId(null)
                    }}
                    onDragEnd={() => setDraggedStageId(null)}
                    className={`rounded-xl border bg-white p-3 transition ${draggedStageId === stage.id ? 'border-emerald-300 opacity-60' : 'border-slate-200'}`}
                  >
                    <div className="grid grid-cols-[auto_1fr_auto] gap-3 items-center">
                      <div className="flex items-center gap-2">
                        <GripVertical className="w-4 h-4 text-slate-300 cursor-grab" />
                        <span className="w-7 h-7 rounded-lg bg-slate-100 text-slate-500 text-xs font-semibold flex items-center justify-center tabular-nums">{idx + 1}</span>
                      </div>
                      <div className="min-w-0">
                        <input
                          value={stage.name}
                          onChange={e => handleRenameStage(stage.id, e.target.value)}
                          className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-900 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
                        />
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          {STAGE_COLOR_OPTIONS.map(color => (
                            <button
                              key={color}
                              type="button"
                              onClick={() => handleColorStage(stage.id, color)}
                              className={`w-6 h-6 rounded-full border-2 transition ${stage.color === color ? 'border-slate-900 scale-110' : 'border-white hover:scale-105'}`}
                              style={{ backgroundColor: color }}
                              aria-label={`Color ${color}`}
                            />
                          ))}
                          {stage.total_count > 0 && (
                            <span className="ml-2 text-xs text-slate-500">{stage.total_count} participante{stage.total_count !== 1 ? 's' : ''}</span>
                          )}
                          {stage.isNew && <span className="text-xs text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full">Nueva</span>}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => moveDraftStageByOffset(stage.id, -1)}
                          disabled={idx === 0}
                          className="p-2 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition disabled:opacity-30"
                          aria-label="Subir etapa"
                        >
                          <ArrowUp className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => moveDraftStageByOffset(stage.id, 1)}
                          disabled={idx === activeDraftStages.length - 1}
                          className="p-2 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition disabled:opacity-30"
                          aria-label="Bajar etapa"
                        >
                          <ArrowDown className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteStage(stage.id, stage.name, stage.total_count)}
                          disabled={activeDraftStages.length <= 1}
                          className="p-2 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition disabled:opacity-30"
                          aria-label="Eliminar etapa"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {(draftDeletedStages.length > 0 || stageLayoutError) && (
                <div className="space-y-2">
                  {draftDeletedStages.map(deletion => {
                    const stageStillDeleted = draftStages.some(stage => stage.id === deletion.stageId && stage.isDeleted && !stage.isNew)
                    if (!stageStillDeleted) return null
                    const destinationStages = activeDraftStages.filter(stage => stage.id !== deletion.stageId && !stage.isNew)
                    return (
                      <div key={deletion.stageId} className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                        <div className="flex flex-wrap items-center gap-3">
                          <Trash2 className="w-4 h-4 text-red-500" />
                          <div className="min-w-[180px] flex-1">
                            <p className="text-sm font-medium text-slate-800">Eliminar {deletion.stageName}</p>
                            <p className="text-xs text-slate-500">
                              {deletion.totalCount > 0 ? `${deletion.totalCount} participante${deletion.totalCount !== 1 ? 's' : ''} se moverán a otra etapa.` : 'Esta etapa no tiene participantes.'}
                            </p>
                          </div>
                          <select
                            value={deletion.moveToStageId}
                            onChange={e => setDeletedStageDestination(deletion.stageId, e.target.value)}
                            className="min-w-[220px] rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-emerald-500/30"
                          >
                            <option value="">Mover a...</option>
                            {destinationStages.map(stage => (
                              <option key={stage.id} value={stage.id}>{stage.name}</option>
                            ))}
                          </select>
                          <button
                            onClick={() => undoDeleteStage(deletion.stageId)}
                            className="px-3 py-2 text-sm font-medium text-slate-600 hover:text-slate-900 hover:bg-white rounded-lg transition"
                          >
                            Deshacer
                          </button>
                        </div>
                      </div>
                    )
                  })}
                  {stageLayoutError && (
                    <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                      <AlertCircle className="w-4 h-4" />
                      {stageLayoutError}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-slate-100 flex flex-wrap justify-between gap-3 bg-white">
              <p className="text-xs text-slate-500 self-center">Los cambios se aplican recién al guardar.</p>
              <div className="flex items-center gap-2">
                <button
                  onClick={cancelStageEditMode}
                  disabled={stageLayoutSaving}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-100 transition disabled:opacity-50"
                >
                  Cancelar
                </button>
                <button
                  onClick={saveStageLayout}
                  disabled={!stageEditDirty || stageSaveBlocked || stageLayoutSaving}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {stageLayoutSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                  Guardar cambios
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Stage Modal */}
      {showStageModal && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-[60] p-4" onClick={() => setShowStageModal(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm border border-slate-100" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <h2 className="text-base font-semibold text-slate-900">Nueva etapa</h2>
              <button onClick={() => setShowStageModal(false)} className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100 transition">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="px-5 py-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-500 uppercase tracking-wider mb-1.5">Nombre *</label>
                <input
                  value={newStageName}
                  onChange={e => setNewStageName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleCreateStage(); if (e.key === 'Escape') setShowStageModal(false) }}
                  className="w-full bg-slate-50 border border-slate-200 text-slate-800 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500 outline-none"
                  placeholder="Ej: Seguimiento"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">Color</label>
                <div className="flex flex-wrap gap-2">
                  {STAGE_COLOR_OPTIONS.map(color => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => setNewStageColor(color)}
                      className={`w-8 h-8 rounded-full border-2 transition-all ${newStageColor === color ? 'border-slate-900 scale-110 shadow-sm' : 'border-white hover:scale-105'}`}
                      style={{ backgroundColor: color }}
                      title={color}
                    />
                  ))}
                </div>
              </div>
            </div>
            <div className="px-5 py-4 border-t border-slate-100 flex justify-end gap-3">
              <button onClick={() => setShowStageModal(false)} className="px-4 py-2 text-sm text-slate-500 hover:text-slate-700 rounded-lg hover:bg-slate-100 transition">Cancelar</button>
              <button
                onClick={handleCreateStage}
                disabled={!newStageName.trim() || stageLayoutSaving}
                className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 transition shadow-sm disabled:opacity-50"
              >
                {stageLayoutSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                Crear
              </button>
            </div>
          </div>
        </div>
      )}

      {/* New Logbook Modal */}
      {showNewLogbookModal && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-[60] p-4" onClick={() => setShowNewLogbookModal(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md border border-slate-100" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <h2 className="text-base font-semibold text-slate-900">Nueva Bitácora</h2>
              <button onClick={() => setShowNewLogbookModal(false)} className="p-2 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100 transition">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-500 uppercase tracking-wider mb-1.5">Fecha *</label>
                <input type="date" value={newLogbookDate} onChange={e => setNewLogbookDate(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 text-slate-800 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500 outline-none" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 uppercase tracking-wider mb-1.5">Título (opcional)</label>
                <input type="text" value={newLogbookTitle} onChange={e => setNewLogbookTitle(e.target.value)}
                  placeholder={newLogbookDate ? format(new Date(newLogbookDate + 'T12:00:00'), 'dd/MM/yyyy') : 'Ej: Día 1 - Inauguración'}
                  className="w-full bg-slate-50 border border-slate-200 text-slate-800 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500 outline-none placeholder-slate-400" />
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={newLogbookCaptureNow} onChange={e => setNewLogbookCaptureNow(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500" />
                <span className="text-sm text-slate-700">Capturar snapshot ahora</span>
              </label>
            </div>
            <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-3">
              <button onClick={() => setShowNewLogbookModal(false)} className="px-4 py-2 text-sm text-slate-500 hover:text-slate-700 rounded-lg hover:bg-slate-100 transition">Cancelar</button>
              <button onClick={handleCreateLogbook} disabled={!newLogbookDate || creatingLogbook}
                className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 transition shadow-sm disabled:opacity-50">
                {creatingLogbook ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                Crear
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Filter Confirmation Dialog for Logbook Snapshot */}
      {showFilterConfirmDialog && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-[70] p-4" onClick={() => setShowFilterConfirmDialog(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm border border-slate-100 animate-in fade-in zoom-in-95 duration-200" onClick={e => e.stopPropagation()}>
            <div className="px-6 pt-6 pb-4 text-center">
              <div className="w-12 h-12 bg-amber-50 rounded-full flex items-center justify-center mx-auto mb-3">
                <Filter className="w-6 h-6 text-amber-600" />
              </div>
              <h3 className="text-base font-semibold text-slate-900 mb-1">Filtros activos</h3>
              <p className="text-sm text-slate-500">
                Tienes <span className="font-semibold text-amber-600">{activeFilterCount}</span> filtro{activeFilterCount > 1 ? 's' : ''} activo{activeFilterCount > 1 ? 's' : ''}.
                La bitácora se creará con <span className="font-semibold text-emerald-600">{totalParticipantCount}</span> de <span className="font-semibold text-slate-700">{event?.total_participants ?? '?'}</span> participantes.
              </p>
            </div>
            <div className="px-6 py-4 border-t border-slate-100 flex gap-3">
              <button onClick={() => setShowFilterConfirmDialog(false)}
                className="flex-1 px-4 py-2.5 text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition">
                Cancelar
              </button>
              <button onClick={() => { if (filterConfirmAction) filterConfirmAction() }}
                className="flex-1 px-4 py-2.5 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition shadow-sm">
                Continuar con filtros
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Logbook Settings Modal */}
      {showLogbookSettingsModal && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-[60] p-4" onClick={() => setShowLogbookSettingsModal(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md border border-slate-100 overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50/50">
              <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
                <Settings className="w-5 h-5 text-slate-400" />
                Configuración de Bitácora
              </h2>
              <button onClick={() => setShowLogbookSettingsModal(false)} className="p-2 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100 transition">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-[13px] font-medium text-slate-700 mb-1">Título</label>
                <input
                  type="text"
                  value={logbookSettingsTitle}
                  onChange={(e) => setLogbookSettingsTitle(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-shadow"
                />
              </div>
              <div>
                <label className="block text-[13px] font-medium text-slate-700 mb-1">Fecha de la sesión</label>
                <input
                  type="date"
                  value={logbookSettingsDate}
                  onChange={(e) => setLogbookSettingsDate(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-shadow"
                />
              </div>
              <div>
                <label className="block text-[13px] font-medium text-slate-700 mb-1">Estado</label>
                <select
                  value={logbookSettingsStatus}
                  onChange={(e) => setLogbookSettingsStatus(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-shadow"
                >
                  <option value="pending">Pendiente (No capturada)</option>
                  <option value="active">Activa (Capturada, permite Re-capturar)</option>
                  <option value="completed">Completada (Bloquea Re-capturar)</option>
                </select>
                <p className="mt-1.5 text-xs text-slate-500 leading-tight">
                  {logbookSettingsStatus === 'pending' && 'La bitácora aún no tiene datos.'}
                  {logbookSettingsStatus === 'active' && 'Permite actualizar la foto mediante el botón de Re-capturar.'}
                  {logbookSettingsStatus === 'completed' && 'Oculta el botón de Re-capturar para evitar sobreescribir los datos.'}
                </p>
              </div>

              <div className="pt-4 border-t border-slate-100 flex flex-col gap-2">
                <p className="text-xs font-medium text-slate-700 mb-1">Filtro asociado</p>
                {selectedLogbook?.saved_filter && Object.keys(selectedLogbook.saved_filter).length > 0 ? (
                  <div className="bg-slate-50 p-3 rounded-lg border border-slate-100 font-mono text-[10px] text-slate-600 overflow-x-auto max-h-24 overflow-y-auto">
                    {JSON.stringify(selectedLogbook.saved_filter, null, 2)}
                  </div>
                ) : (
                  <p className="text-xs text-slate-500 italic">No hay filtro guardado</p>
                )}

                <button
                  onClick={() => handleUpdateLogbookSettings(true)}
                  disabled={logbookSettingsUpdating}
                  className="mt-1 flex items-center justify-center gap-1.5 w-full px-3 py-2 bg-slate-100 text-slate-700 rounded-lg text-xs font-medium hover:bg-slate-200 transition"
                  title="Actualizar el filtro guardado con el filtro aplicado actualmente en la pantalla"
                >
                  <Filter className="w-3.5 h-3.5" />
                  Sobreescribir con el Filtro Actual
                </button>
              </div>

            </div>
            <div className="px-6 py-4 bg-slate-50/50 border-t border-slate-100 flex gap-2">
              <button onClick={() => setShowLogbookSettingsModal(false)}
                className="flex-1 px-4 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition">
                Cancelar
              </button>
              <button
                onClick={() => handleUpdateLogbookSettings(false)}
                disabled={logbookSettingsUpdating}
                className="flex-1 flex justify-center items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition shadow-sm disabled:opacity-50">
                {logbookSettingsUpdating && <Loader2 className="w-4 h-4 animate-spin" />}
                Guardar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ List History Modal ═══ */}
      {listHistoryParticipant && (
        <ObservationHistoryModal
          isOpen={true}
          onClose={() => setListHistoryParticipant(null)}
          participantId={listHistoryParticipant.id}
          eventId={eventId}
          contactId={listHistoryParticipant.contact_id}
          name={listHistoryParticipant.name || 'Sin nombre'}
          observations={listObservations.get(listHistoryParticipant.id) || []}
          onObservationChange={() => {
            fetchBatchObservations([listHistoryParticipant.id])
          }}
        />
      )}

      {/* ═══ Detail Panel (Slide-over) with Inline Chat ═══ */}
      {(showDetailPanel || showInlineChat) && detailParticipant && (
        <div className="fixed inset-0 z-50 flex justify-end overflow-hidden">
          <div
            className="absolute inset-0 bg-black/30 backdrop-blur-[2px]"
            onClick={() => { setShowDetailPanel(false); setShowInlineChat(false) }}
          />
          <div
            ref={detailPanelDialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Detalle del participante"
            tabIndex={-1}
            className={`relative h-full bg-white shadow-2xl flex transition-all duration-300 border-l border-slate-200 outline-none ${showInlineChat ? 'w-[85vw] max-w-6xl' : 'w-full max-w-md'}`}
          >
            {showInlineChat && inlineChatId && (
              <div className="flex-1 min-w-0 border-r border-slate-200 flex flex-col h-full bg-slate-50/50">
                <ChatPanel
                  chatId={inlineChatId}
                  deviceId={inlineChatDeviceId}
                  initialChat={inlineChat || undefined}
                  readOnly={inlineChatReadOnly}
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
                relatedLeads={detailParticipant.related_leads || []}
                relatedLeadsLoading={detailParticipantLoading}
                relatedLeadsError={detailParticipantError}
                onRetryRelatedLeads={() => openDetailPanel(detailParticipant)}
                eventMembership={{
                  state: detailParticipant.membership_state,
                  source: detailParticipant.membership_source,
                  reason: detailParticipant.membership_reason,
                  autoTagSync: detailParticipant.auto_tag_sync,
                  changedAt: detailParticipant.membership_changed_at,
                }}
                readOnly={eventIsReadOnly}
                hideDelete={eventIsReadOnly}
                onLeadChange={(updatedLead: any) => {
                  // Map back from Lead shape to Participant update
                  updateParticipantInStages(detailParticipant.id, p => ({
                    ...p,
                    name: updatedLead.name ?? p.name,
                    last_name: updatedLead.last_name ?? p.last_name,
                    short_name: updatedLead.short_name ?? p.short_name,
                    phone: updatedLead.phone ?? p.phone,
                    email: updatedLead.email ?? p.email,
                    age: updatedLead.age ?? p.age,
                    dni: updatedLead.dni ?? p.dni,
                    birth_date: updatedLead.birth_date ?? p.birth_date,
                    company: updatedLead.company ?? p.company,
                    address: updatedLead.address ?? p.address,
                    distrito: updatedLead.distrito ?? p.distrito,
                    ocupacion: updatedLead.ocupacion ?? p.ocupacion,
                    notes: updatedLead.notes ?? p.notes,
                    stage_id: updatedLead.stage_id || p.stage_id,
                    stage_name: updatedLead.stage_name || p.stage_name,
                    stage_color: updatedLead.stage_color || p.stage_color,
                    structured_tags: updatedLead.structured_tags,
                    tags: updatedLead.structured_tags?.map((t: any) => ({ id: t.id, account_id: t.account_id || '', name: t.name, color: t.color, created_at: '' })),
                  }))
                  setDetailParticipant(prev => prev ? {
                    ...prev,
                    name: updatedLead.name ?? prev.name,
                    last_name: updatedLead.last_name ?? prev.last_name,
                    short_name: updatedLead.short_name ?? prev.short_name,
                    phone: updatedLead.phone ?? prev.phone,
                    email: updatedLead.email ?? prev.email,
                    age: updatedLead.age ?? prev.age,
                    dni: updatedLead.dni ?? prev.dni,
                    birth_date: updatedLead.birth_date ?? prev.birth_date,
                    company: updatedLead.company ?? prev.company,
                    address: updatedLead.address ?? prev.address,
                    distrito: updatedLead.distrito ?? prev.distrito,
                    ocupacion: updatedLead.ocupacion ?? prev.ocupacion,
                    notes: updatedLead.notes ?? prev.notes,
                    stage_id: updatedLead.stage_id || prev.stage_id,
                    stage_name: updatedLead.stage_name || prev.stage_name,
                    stage_color: updatedLead.stage_color || prev.stage_color,
                    tags: updatedLead.structured_tags?.map((t: any) => ({ id: t.id, account_id: t.account_id || '', name: t.name, color: t.color, created_at: '' })),
                  } : null)
                }}
                onStageChange={(stageId: string, stageName: string, stageColor: string) => {
                  // Optimistic kanban move — LeadDetailPanel already sent the PATCH
                  const updatedProps = { stage_id: stageId, stage_name: stageName || undefined, stage_color: stageColor || undefined }
                  setStageData(prev => {
                    let movedP: Participant | undefined
                    const afterRemove = prev.map(s => {
                      const idx = s.participants.findIndex(p => p.id === detailParticipant.id)
                      if (idx >= 0) {
                        movedP = { ...s.participants[idx], ...updatedProps }
                        return { ...s, participants: s.participants.filter(p => p.id !== detailParticipant.id), total_count: Math.max(0, s.total_count - 1) }
                      }
                      return s
                    })
                    if (movedP) {
                      return afterRemove.map(s => s.id === stageId
                        ? { ...s, participants: [movedP!, ...s.participants], total_count: s.total_count + 1 }
                        : s
                      )
                    }
                    return afterRemove
                  })
                  setUnassignedData(prev => {
                    const idx = prev.participants.findIndex(p => p.id === detailParticipant.id)
                    if (idx >= 0) {
                      const movedP = { ...prev.participants[idx], ...updatedProps }
                      setStageData(sd => sd.map(s => s.id === stageId
                        ? { ...s, participants: [movedP, ...s.participants], total_count: s.total_count + 1 }
                        : s
                      ))
                      return { ...prev, participants: prev.participants.filter(p => p.id !== detailParticipant.id), total_count: Math.max(0, prev.total_count - 1) }
                    }
                    return prev
                  })
                  setListParticipants(prev => prev.map(p => p.id === detailParticipant.id ? { ...p, ...updatedProps } : p))
                  // Block incoming WebSocket refetch
                  ownStageChangeRef.current = true
                  if (ownStageTimerRef.current) clearTimeout(ownStageTimerRef.current)
                  ownStageTimerRef.current = setTimeout(() => { ownStageChangeRef.current = false }, 3000)
                }}
                onClose={() => { setShowDetailPanel(false); setShowInlineChat(false) }}
                onSendWhatsApp={(phone: string) => handleSendWhatsApp(phone)}
                onBlock={() => {
                  if (detailParticipant.contact_id) openBlockModal(detailParticipant.contact_id)
                }}
                onUnblock={() => {
                  if (detailParticipant.contact_id) handleUnblock(detailParticipant.contact_id)
                }}
                onObservationChange={() => {
                  if (viewMode === 'list') {
                    setListObservations(new Map())
                    setLoadingListObs(new Set())
                  }
                }}
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
      {/* ═══ Contact communication preference ═══ */}
      {showBlockModal && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-sm">
          <div ref={doNotContactDialogRef} role="dialog" aria-modal="true" aria-labelledby="do-not-contact-title" tabIndex={-1} className="w-full max-w-md overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl">
            <div className="px-6 py-4 border-b border-slate-200">
              <h3 id="do-not-contact-title" className="text-lg font-semibold text-slate-900 flex items-center gap-2">
                <ShieldBan className="w-5 h-5 text-red-500" />
                Marcar como no contactable
              </h3>
              <p className="text-sm text-slate-500 mt-1">Esta preferencia pertenece al contacto y evita mensajes desde campañas, eventos y automatizaciones.</p>
            </div>
            <div className="px-6 py-4 space-y-2">
              {['Solicita no ser contactado', 'Agresivo o abusivo', 'Número equivocado', 'Spam o fraude'].map((reason, index) => (
                <button ref={index === 0 ? doNotContactFirstChoiceRef : undefined} key={reason} onClick={() => setBlockReason(reason)} className={`min-h-11 w-full text-left px-4 py-2.5 rounded-xl text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 ${blockReason === reason ? 'bg-red-50 text-red-700 ring-1 ring-red-200 font-medium' : 'text-slate-700 hover:bg-slate-50'}`}>
                  {reason}
                </button>
              ))}
              <div className="pt-2">
                <input type="text" placeholder="Otro motivo..." value={!['Solicita no ser contactado', 'Agresivo o abusivo', 'Número equivocado', 'Spam o fraude'].includes(blockReason) ? blockReason : ''} onChange={(e) => setBlockReason(e.target.value)} onFocus={() => { if (['Solicita no ser contactado', 'Agresivo o abusivo', 'Número equivocado', 'Spam o fraude'].includes(blockReason)) setBlockReason('') }} className="h-11 w-full px-4 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-red-500 focus:border-red-500" />
              </div>
              {blockError && <p className="flex items-center gap-2 rounded-xl bg-red-50 px-3 py-2 text-xs font-medium text-red-700" role="alert"><AlertCircle className="h-4 w-4 shrink-0" />{blockError}</p>}
            </div>
            <div className="px-6 py-4 border-t border-slate-200 flex justify-end gap-3">
              <button onClick={() => setShowBlockModal(false)} disabled={savingBlock} className="h-11 px-4 text-sm text-slate-600 hover:bg-slate-100 rounded-xl transition disabled:opacity-50">Cancelar</button>
              <button onClick={confirmBlock} disabled={!blockReason || savingBlock} className="inline-flex h-11 items-center gap-2 px-4 bg-red-600 text-white text-sm font-medium rounded-xl hover:bg-red-700 disabled:opacity-50 transition">{savingBlock && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />}{savingBlock ? 'Guardando…' : 'Confirmar'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ Add Participant — ContactSelector ═══ */}
      <ContactSelector
        open={showAddModal && addTab === 'search'}
        onClose={() => {
          if (addingParticipant) return
          setShowAddModal(false)
          setAddParticipantError('')
        }}
        onConfirm={handleAddFromSelector}
        title="Agregar contactos"
        subtitle={eventHasMembershipRules
          ? 'Busca por nombre, teléfono o correo. Solo se pueden agregar contactos que cumplan las reglas actuales del evento.'
          : 'Busca por nombre, teléfono o correo. Como este evento no tiene reglas, puedes agregar cualquier contacto de la cuenta.'}
        confirmLabel="Agregar al evento"
        sourceFilter="contact"
        eventId={eventId}
        onViewExisting={handleViewExistingParticipant}
        submitting={addingParticipant}
        errorMessage={addParticipantError}
        refreshKey={participantCandidatesRevision}
      />

      {/* ═══ Add Participant — Manual contact ═══ */}
      {showAddModal && addTab === 'manual' && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-sm">
          <div
            ref={manualContactDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-event-contact-title"
            className="flex max-h-[92vh] w-full max-w-xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl"
          >
            <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-5">
              <div>
                <h2 id="new-event-contact-title" className="text-lg font-semibold text-slate-950">Registrar contacto</h2>
                <p className="mt-1 text-sm text-slate-500">
                  Se creará o reutilizará el contacto y se añadirá como participante. Esto no crea una oportunidad comercial.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (addingParticipant) return
                  setShowAddModal(false)
                  setAddParticipantError('')
                }}
                disabled={addingParticipant}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                aria-label="Cerrar registro de contacto"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5">
              <div className="rounded-2xl border border-emerald-100 bg-emerald-50/60 px-4 py-3 text-sm text-emerald-800">
                Este evento no tiene reglas automáticas. El contacto se creará —o se reutilizará si ya existe— y se añadirá directamente como participante.
              </div>

              {addParticipantError && (
                <p className="mt-4 flex items-start gap-2 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700" role="alert">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  {addParticipantError}
                </p>
              )}

              <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <label className="sm:col-span-2">
                  <span className="mb-1.5 block text-sm font-medium text-slate-700">Nombre <span className="text-red-500">*</span></span>
                  <input
                    value={manualForm.name}
                    onChange={event => setManualForm(form => ({ ...form, name: event.target.value }))}
                    ref={manualContactNameRef}
                    autoComplete="name"
                    className="h-11 w-full rounded-xl border border-slate-200 px-3.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
                    placeholder="Nombre del contacto"
                  />
                </label>
                <label>
                  <span className="mb-1.5 block text-sm font-medium text-slate-700">Apellido</span>
                  <input
                    value={manualForm.last_name}
                    onChange={event => setManualForm(form => ({ ...form, last_name: event.target.value }))}
                    autoComplete="family-name"
                    className="h-11 w-full rounded-xl border border-slate-200 px-3.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
                    placeholder="Apellido"
                  />
                </label>
                <label>
                  <span className="mb-1.5 block text-sm font-medium text-slate-700">Nombre corto</span>
                  <input
                    value={manualForm.short_name}
                    onChange={event => setManualForm(form => ({ ...form, short_name: event.target.value }))}
                    className="h-11 w-full rounded-xl border border-slate-200 px-3.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
                    placeholder="Cómo prefieres identificarlo"
                  />
                </label>
                <label>
                  <span className="mb-1.5 block text-sm font-medium text-slate-700">Teléfono</span>
                  <input
                    type="tel"
                    inputMode="tel"
                    value={manualForm.phone}
                    onChange={event => setManualForm(form => ({ ...form, phone: event.target.value }))}
                    autoComplete="tel"
                    className="h-11 w-full rounded-xl border border-slate-200 px-3.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
                    placeholder="944 903 497"
                  />
                </label>
                <label>
                  <span className="mb-1.5 block text-sm font-medium text-slate-700">Correo</span>
                  <input
                    type="email"
                    value={manualForm.email}
                    onChange={event => setManualForm(form => ({ ...form, email: event.target.value }))}
                    autoComplete="email"
                    className="h-11 w-full rounded-xl border border-slate-200 px-3.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
                    placeholder="correo@ejemplo.com"
                  />
                </label>
                <label>
                  <span className="mb-1.5 block text-sm font-medium text-slate-700">Edad</span>
                  <input
                    type="number"
                    min="0"
                    max="130"
                    value={manualForm.age}
                    onChange={event => setManualForm(form => ({ ...form, age: event.target.value }))}
                    className="h-11 w-full rounded-xl border border-slate-200 px-3.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
                    placeholder="Edad"
                  />
                </label>
              </div>

              <button
                type="button"
                onClick={() => setAddTab('search')}
                className="mt-5 inline-flex h-11 items-center gap-2 rounded-xl px-3 text-sm font-medium text-emerald-700 transition hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
              >
                <Search className="h-4 w-4" />
                Buscar un contacto existente
              </button>
            </div>

            <div className="flex flex-col-reverse gap-3 border-t border-slate-100 bg-slate-50/70 px-6 py-4 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => {
                  setShowAddModal(false)
                  setAddParticipantError('')
                  setManualForm({ name: '', last_name: '', short_name: '', phone: '', email: '', age: '' })
                }}
                disabled={addingParticipant}
                className="h-11 rounded-xl border border-slate-200 bg-white px-5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleAddManual}
                disabled={!manualForm.name.trim() || addingParticipant || eventHasMembershipRules || eventIsReadOnly}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
              >
                {addingParticipant ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
                {addingParticipant ? 'Registrando…' : 'Registrar y agregar'}
              </button>
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
            {existingChatForWA && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 mb-3">
                Ya existe historial{whatsappHistoricalPhone ? ` con el numero ${whatsappHistoricalPhone}` : ' con numero historico desconocido'}.
              </p>
            )}
            {devices.length === 0 ? (
              <p className="text-xs text-slate-400 text-center py-4">No hay dispositivos conectados</p>
            ) : (
              <div className="space-y-2">
                {devices.map(device => (
                  <button key={device.id} onClick={() => handleDeviceSelectedForChat(device)}
                    className="w-full flex items-center gap-3 p-3 border border-slate-100 rounded-xl hover:bg-emerald-50 hover:border-emerald-200 transition text-left"
                  >
                    <div className="w-9 h-9 bg-emerald-50 rounded-full flex items-center justify-center"><Phone className="w-4 h-4 text-emerald-600" /></div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-slate-900">{device.name || 'Dispositivo'}</p>
                        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${relationClassName(device)}`}>{relationLabel(device)}</span>
                      </div>
                      <p className="text-xs text-slate-500">{deviceDisplayPhone(device)}</p>
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
              {exportFormat === 'excel' && activeFilterCount > 0 && (
                <div>
                  <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3 block">Alcance</label>
                  <div className="grid grid-cols-2 gap-3">
                    <button onClick={() => setExportScope('all')}
                      className={`flex items-center gap-3 p-3.5 rounded-xl border-2 text-left transition-all ${
                        exportScope === 'all' ? 'border-emerald-500 bg-emerald-50' : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      <Users className={`w-5 h-5 flex-shrink-0 ${exportScope === 'all' ? 'text-emerald-600' : 'text-slate-400'}`} />
                      <div>
                        <span className={`text-sm font-semibold ${exportScope === 'all' ? 'text-slate-900' : 'text-slate-600'}`}>Todos</span>
                        <p className="text-[11px] text-slate-400">Todos los participantes</p>
                      </div>
                    </button>
                    <button onClick={() => setExportScope('filtered')}
                      className={`flex items-center gap-3 p-3.5 rounded-xl border-2 text-left transition-all ${
                        exportScope === 'filtered' ? 'border-emerald-500 bg-emerald-50' : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      <Filter className={`w-5 h-5 flex-shrink-0 ${exportScope === 'filtered' ? 'text-emerald-600' : 'text-slate-400'}`} />
                      <div>
                        <span className={`text-sm font-semibold ${exportScope === 'filtered' ? 'text-slate-900' : 'text-slate-600'}`}>Filtrados</span>
                        <p className="text-[11px] text-slate-400">{totalParticipantCount} participantes</p>
                      </div>
                    </button>
                  </div>
                </div>
              )}
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

      {/* ═══ Google Sync Modal ═══ */}
      {showMembershipHistory && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[70] p-4" onClick={() => setShowMembershipHistory(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[80vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
              <div>
                <h2 className="text-base font-bold text-slate-900">Historial de membresía</h2>
                <p className="text-xs text-slate-500 mt-0.5">Altas, salidas y reactivaciones sin perder bitácoras ni interacciones.</p>
              </div>
              <button onClick={() => setShowMembershipHistory(false)} className="p-1.5 text-slate-400 hover:bg-slate-100 rounded-lg"><X className="w-4 h-4" /></button>
            </div>
            <div className="overflow-y-auto p-4">
              {membershipHistoryLoading ? (
                <div className="py-12 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-emerald-600" /></div>
              ) : membershipHistory.length === 0 ? (
                <div className="py-12 text-center text-sm text-slate-400">Aún no hay cambios de membresía registrados.</div>
              ) : (
                <div className="space-y-2">
                  {membershipHistory.map(entry => {
                    const labels: Record<string, string> = { created: 'Alta automática', reactivated: 'Reactivado', deactivated: 'Salida del listado activo', created_or_reactivated: 'Alta manual' }
                    const state = entry.after_state || {}
                    const reason = typeof state.reason === 'string' ? state.reason : ''
                    return (
                      <div key={entry.id} className="rounded-xl border border-slate-200 px-4 py-3 flex items-start gap-3">
                        <div className={`mt-1 w-2.5 h-2.5 rounded-full flex-shrink-0 ${entry.action === 'deactivated' ? 'bg-amber-500' : 'bg-emerald-500'}`} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-semibold text-slate-800">{labels[entry.action] || entry.action}</span>
                            {reason && <span className="text-[10px] bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">{reason}</span>}
                            {entry.rule_revision > 0 && <span className="text-[10px] text-violet-600">regla v{entry.rule_revision}</span>}
                          </div>
                          <p className="text-xs text-slate-500 mt-1 break-all">Contacto: {entry.contact_id || 'histórico'} · {entry.actor_type === 'user' ? 'usuario' : 'sistema'} · {entry.source || 'sin origen'}</p>
                        </div>
                        <time className="text-[11px] text-slate-400 whitespace-nowrap">{new Date(entry.created_at).toLocaleString('es-PE')}</time>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {showGoogleSyncModal && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4"
          onClick={() => !googleSyncing && setShowGoogleSyncModal(false)}
          onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); if (!googleSyncing) setShowGoogleSyncModal(false) } }}
        >
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="px-6 py-5 border-b border-slate-100 bg-gradient-to-r from-blue-50 to-indigo-50/50">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/20">
                    <RefreshCw className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <h2 className="text-lg font-bold text-slate-900">Sincronizar con Google</h2>
                    <p className="text-xs text-slate-500 mt-0.5">Contactos de Google del evento</p>
                  </div>
                </div>
                <button onClick={() => !googleSyncing && setShowGoogleSyncModal(false)} className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="p-6">
              {googleSyncLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
                </div>
              ) : googleSyncStatus ? (
                <div className="space-y-4">
                  {/* Stats grid */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-slate-50 rounded-xl p-4 text-center">
                      <p className="text-2xl font-bold text-slate-900 tabular-nums">{googleSyncStatus.total}</p>
                      <p className="text-xs text-slate-500 mt-1">Total participantes</p>
                    </div>
                    <div className="bg-emerald-50 rounded-xl p-4 text-center">
                      <p className="text-2xl font-bold text-emerald-600 tabular-nums">{googleSyncStatus.synced}</p>
                      <p className="text-xs text-emerald-600/70 mt-1">Ya sincronizados</p>
                    </div>
                    <div className="bg-amber-50 rounded-xl p-4 text-center">
                      <p className="text-2xl font-bold text-amber-600 tabular-nums">{googleSyncStatus.pending}</p>
                      <p className="text-xs text-amber-600/70 mt-1">Pendientes</p>
                    </div>
                    <div className="bg-slate-50 rounded-xl p-4 text-center">
                      <p className="text-2xl font-bold text-slate-400 tabular-nums">{googleSyncStatus.no_contact}</p>
                      <p className="text-xs text-slate-400 mt-1">Sin contacto</p>
                    </div>
                  </div>

                  {googleSyncStatus.pending > 0 && (
                    <p className="text-xs text-slate-500 text-center">
                      Se sincronizarán {googleSyncStatus.pending} contacto{googleSyncStatus.pending !== 1 ? 's' : ''} en segundo plano.
                    </p>
                  )}
                  {googleSyncStatus.pending === 0 && (
                    <p className="text-xs text-emerald-600 text-center font-medium">
                      Todos los contactos ya están sincronizados con Google.
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-slate-500 text-center py-8">No se pudo obtener el estado de sincronización.</p>
              )}
            </div>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-slate-100 bg-slate-50 flex items-center justify-between">
              <button
                onClick={() => !googleSyncing && setShowGoogleSyncModal(false)}
                disabled={googleSyncing}
                className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-800 rounded-lg hover:bg-slate-100 disabled:opacity-50 transition-colors"
              >
                Cerrar
              </button>
              <button
                onClick={handleGoogleSync}
                disabled={googleSyncing || !googleSyncStatus || googleSyncStatus.pending === 0}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-blue-500 to-indigo-600 hover:from-blue-600 hover:to-indigo-700 shadow-lg shadow-blue-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
              >
                {googleSyncing ? (
                  <><Loader2 className="w-4 h-4 animate-spin" />Sincronizando...</>
                ) : (
                  <><RefreshCw className="w-4 h-4" />Sincronizar todos</>
                )}
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
