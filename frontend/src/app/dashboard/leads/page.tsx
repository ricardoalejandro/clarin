'use client'

import { useEffect, useState, useCallback, useRef, useMemo, memo } from 'react'
import { createPortal } from 'react-dom'
import { Search, Plus, Phone, Mail, User, UserPlus, Tag, Calendar, MoreVertical, MoreHorizontal, MessageCircle, Trash2, Edit, ChevronDown, ChevronLeft, ChevronRight, Filter, CheckSquare, Square, MinusSquare, XCircle, Clock, FileText, X, Maximize2, Upload, Building2, Save, Edit2, Settings, Pencil, Eye, EyeOff, GripVertical, RefreshCw, Radio, LayoutGrid, List, ChevronUp, Code, AlertCircle, AlertTriangle, CheckCircle2, Archive, ShieldBan, ArchiveRestore, ShieldOff, Download } from 'lucide-react'
import { formatDistanceToNow, format } from 'date-fns'
import { useKanbanPan } from '@/lib/useKanbanPan'
import { es } from 'date-fns/locale'
import FormulaEditor from '@/components/FormulaEditor'
import { useVirtualizer } from '@tanstack/react-virtual'
import ImportCSVModal from '@/components/ImportCSVModal'
import ContactSelector, { type SelectedPerson } from '@/components/ContactSelector'
import TagInput from '@/components/TagInput'
import CreateCampaignModal, { CampaignFormResult } from '@/components/CreateCampaignModal'
import { useRouter } from 'next/navigation'
import { api, subscribeWebSocket } from '@/lib/api'
import { contactIdFromRealtimeEvent } from '@/lib/contactProfileEvents'
import { createWhatsAppChat, deviceDisplayPhone, relationClassName, relationLabel, resolveWhatsAppChat, type WhatsAppDeviceOption } from '@/lib/whatsappChatLauncher'
import ChatPanel from '@/components/chat/ChatPanel'
import LeadDetailPanel from '@/components/LeadDetailPanel'
import ContactDetailSurface from '@/components/contact-details/ContactDetailSurface'
import ObservationHistoryModal from '@/components/ObservationHistoryModal'
import BulkGenerateDocumentModal from '@/components/BulkGenerateDocumentModal'
import PipelineStageManager from '@/components/pipelines/PipelineStageManager'
import { useAccessibleDialog } from '@/components/pipelines/useAccessibleDialog'
import { useContainerWidth } from '@/components/responsive/useContainerWidth'
import { Chat } from '@/types/chat'
import type { StructuredTag, PipelineStage, Pipeline, Lead, Observation } from '@/types/contact'
import type { ContactProfileContact, ContactProfileResponse } from '@/types/contact-profile'
import type { CustomFieldDefinition, CustomFieldValue, CustomFieldFilter } from '@/types/custom-field'

interface Device {
  id: string
  name: string
  phone?: string | null
  jid?: string | null
  status: string
  normalized_phone?: string
  historical_relation?: WhatsAppDeviceOption['historical_relation']
  matches_historical?: boolean
  has_different_number?: boolean
  history_unknown?: boolean
}

interface StageData {
  id: string
  pipeline_id: string
  name: string
  color: string
  position: number
  stage_type?: 'active' | 'won' | 'lost'
  total_count: number
  leads: Lead[]
  has_more: boolean
}

interface TagInfo {
  name: string
  color: string
  count: number
}

function mergeContactProfileIntoLead(lead: Lead, contact: ContactProfileContact): Lead {
  if (lead.contact_id !== contact.id) return lead
  return {
    ...lead,
    name: contact.custom_name || contact.name || contact.push_name || contact.short_name || contact.phone || 'Sin nombre',
    last_name: contact.last_name ?? null,
    short_name: contact.short_name ?? null,
    phone: contact.phone || '',
    email: contact.email || '',
    company: contact.company ?? null,
    age: contact.age ?? null,
    dni: contact.dni ?? null,
    birth_date: contact.birth_date ?? null,
    address: contact.address ?? null,
    distrito: contact.distrito ?? null,
    ocupacion: contact.ocupacion ?? null,
    tags: contact.structured_tags.map(tag => tag.name),
    structured_tags: contact.structured_tags,
  }
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
  onRestore: (id: string) => void
  onLifecycleAction: (lead: Lead, mode: 'won' | 'lost' | 'reopen') => void
  stageOptions: PipelineStage[]
  onStageChange: (lead: Lead, stage: PipelineStage) => void
  isTrash: boolean
  onDragStart: (e: React.DragEvent, id: string) => void
  onDragEnd: (e: React.DragEvent) => void
}

const LeadCard = memo(function LeadCard({
  lead, isSelected, isDetailActive, isDragged, selectionMode,
  onToggleSelection, onOpenDetail, onDelete, onRestore, onLifecycleAction, stageOptions, onStageChange, isTrash, onDragStart, onDragEnd,
}: LeadCardProps) {
  const [actionsOpen, setActionsOpen] = useState(false)
  const actionsRef = useRef<HTMLDivElement>(null)
  const mobileActionsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!actionsOpen) return
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return
      if (event instanceof MouseEvent && (actionsRef.current?.contains(event.target as Node) || mobileActionsRef.current?.contains(event.target as Node))) return
      setActionsOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [actionsOpen])
  const trashRemainingDays = isTrash && lead.deleted_at
    ? Math.max(0, 30 - Math.floor((Date.now() - new Date(lead.deleted_at).getTime()) / (24 * 60 * 60 * 1000)))
    : null
  return (
    <div
      draggable={!selectionMode}
      onDragStart={(e) => onDragStart(e, lead.id)}
      onDragEnd={onDragEnd}
      className={`relative bg-white p-3 rounded-xl shadow-sm border hover:shadow-md transition cursor-pointer ${
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
          <div className="min-w-0">
            <p className="max-w-[150px] truncate text-[13px] font-semibold text-slate-900">{lead.name || 'Sin nombre'}</p>
          </div>
          {lead.kommo_id && (
            <span title={lead.kommo_deleted_at ? `Eliminado de Kommo #${lead.kommo_id}` : `Vinculado a Kommo #${lead.kommo_id}`} className={`flex-shrink-0 flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium leading-none ${lead.kommo_deleted_at ? 'bg-amber-50 text-amber-600' : 'bg-emerald-50 text-emerald-600'}`}>
              <RefreshCw className="w-2.5 h-2.5" />{lead.kommo_deleted_at ? 'K✗' : 'K'}
            </span>
          )}
        </div>
        {!selectionMode && isTrash && (
          <button
            onClick={(e) => { e.stopPropagation(); onRestore(lead.id) }}
            className="touch-action-visible inline-flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 opacity-100 transition-all hover:bg-emerald-50 hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 lg:h-10 lg:w-10 lg:opacity-0 lg:focus:opacity-100 lg:group-hover:opacity-100"
            aria-label={`Restaurar ${lead.name || 'lead'}`}
          >
            <ArchiveRestore className="h-4 w-4" />
          </button>
        )}
        {!selectionMode && !isTrash && (
          <div ref={actionsRef} className="relative">
            <button
              type="button"
              onClick={(event) => { event.stopPropagation(); setActionsOpen(open => !open) }}
              className="touch-action-visible inline-flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 opacity-100 transition-all hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 lg:h-10 lg:w-10 lg:opacity-0 lg:focus:opacity-100 lg:group-hover:opacity-100"
              aria-label={`Acciones de ${lead.name || 'lead'}`}
              aria-haspopup="menu"
              aria-expanded={actionsOpen}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
            {actionsOpen && (
              <div role="menu" className="touch-menu-hidden absolute right-0 top-10 z-30 hidden w-48 overflow-hidden rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl lg:block" onClick={event => event.stopPropagation()}>
                {lead.status === 'won' || lead.status === 'lost' ? (
                  <button type="button" role="menuitem" onClick={() => { setActionsOpen(false); onLifecycleAction(lead, 'reopen') }} className="flex min-h-10 w-full items-center gap-2 rounded-lg px-3 text-left text-xs font-semibold text-blue-700 hover:bg-blue-50">
                    <ArchiveRestore className="h-4 w-4" /> Reabrir lead
                  </button>
                ) : (
                  <>
                    <button type="button" role="menuitem" onClick={() => { setActionsOpen(false); onLifecycleAction(lead, 'won') }} className="flex min-h-10 w-full items-center gap-2 rounded-lg px-3 text-left text-xs font-semibold text-emerald-700 hover:bg-emerald-50">
                      <CheckCircle2 className="h-4 w-4" /> Marcar como ganado
                    </button>
                    <button type="button" role="menuitem" onClick={() => { setActionsOpen(false); onLifecycleAction(lead, 'lost') }} className="flex min-h-10 w-full items-center gap-2 rounded-lg px-3 text-left text-xs font-semibold text-red-700 hover:bg-red-50">
                      <XCircle className="h-4 w-4" /> Marcar como perdido
                    </button>
                  </>
                )}
                <div className="my-1 border-t border-slate-100" />
                <button type="button" role="menuitem" onClick={() => { setActionsOpen(false); onDelete(lead.id) }} className="flex min-h-10 w-full items-center gap-2 rounded-lg px-3 text-left text-xs font-semibold text-slate-600 hover:bg-red-50 hover:text-red-700">
                  <Trash2 className="h-4 w-4" /> Mover a papelera
                </button>
              </div>
            )}
            {actionsOpen && typeof document !== 'undefined' && createPortal(
              <div ref={mobileActionsRef} role="menu" className="touch-menu-visible fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-[90] max-h-[70vh] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-2 shadow-2xl lg:hidden" onClick={event => event.stopPropagation()}>
                <p className="px-3 py-2 text-xs font-semibold text-slate-500">Acciones de {lead.name || 'lead'}</p>
                {lead.status === 'won' || lead.status === 'lost' ? (
                  <button type="button" role="menuitem" onClick={() => { setActionsOpen(false); onLifecycleAction(lead, 'reopen') }} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold text-blue-700 hover:bg-blue-50"><ArchiveRestore className="h-4 w-4" /> Reabrir lead</button>
                ) : (
                  <>
                    <button type="button" role="menuitem" onClick={() => { setActionsOpen(false); onLifecycleAction(lead, 'won') }} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold text-emerald-700 hover:bg-emerald-50"><CheckCircle2 className="h-4 w-4" /> Marcar como ganado</button>
                    <button type="button" role="menuitem" onClick={() => { setActionsOpen(false); onLifecycleAction(lead, 'lost') }} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold text-red-700 hover:bg-red-50"><XCircle className="h-4 w-4" /> Marcar como perdido</button>
                  </>
                )}
                <div className="my-1 border-t border-slate-100" />
                <button type="button" role="menuitem" onClick={() => { setActionsOpen(false); onDelete(lead.id) }} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold text-slate-700 hover:bg-red-50 hover:text-red-700"><Trash2 className="h-4 w-4" /> Mover a papelera</button>
              </div>,
              document.body,
            )}
          </div>
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
      {!selectionMode && !isTrash && stageOptions.length > 0 && (
        <label className="touch-stage-visible mt-2 block lg:hidden" onClick={event => event.stopPropagation()}>
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-400">Mover a etapa</span>
          <select
            value={lead.stage_id || ''}
            onChange={event => {
              const stage = stageOptions.find(option => option.id === event.target.value)
              if (stage && stage.id !== lead.stage_id) onStageChange(lead, stage)
            }}
            className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
            aria-label={`Mover ${lead.name || 'lead'} a otra etapa`}
          >
            {!lead.stage_id && <option value="">Sin etapa</option>}
            {stageOptions.map(stage => <option key={stage.id} value={stage.id}>{stage.name}</option>)}
          </select>
        </label>
      )}
      <div className="flex items-center justify-between mt-2 text-[10px] text-slate-400">
        <span>{trashRemainingDays !== null ? (trashRemainingDays > 0 ? `${trashRemainingDays} día${trashRemainingDays === 1 ? '' : 's'} para restaurar` : 'Pendiente de purga') : formatDistanceToNow(new Date(lead.created_at), { locale: es })}</span>
        {isTrash ? <Trash2 className="h-3 w-3" aria-hidden="true" /> : <MessageCircle className="w-3 h-3" aria-hidden="true" />}
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
  onRestore: (id: string) => void
  onLifecycleAction: (lead: Lead, mode: 'won' | 'lost' | 'reopen') => void
  stageOptions: PipelineStage[]
  onStageChange: (lead: Lead, stage: PipelineStage) => void
  isTrash: boolean
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
  onRestore, onLifecycleAction, stageOptions, onStageChange, isTrash,
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
                ref={virtualizer.measureElement}
                data-index={virtualItem.index}
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
                    onRestore={onRestore}
                    onLifecycleAction={onLifecycleAction}
                    stageOptions={stageOptions}
                    onStageChange={onStageChange}
                    isTrash={isTrash}
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

// ─── Date Filter Presets ──────────────────────────────────────────────────────
const DATE_PRESETS = [
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

function resolveDatePreset(preset: string, customFrom?: string, customTo?: string): { from: string; to: string } | null {
  const now = new Date()
  switch (preset) {
    case 'last_15m': {
      const from = new Date(now.getTime() - 15 * 60 * 1000)
      return { from: from.toISOString(), to: now.toISOString() }
    }
    case 'last_hour': {
      const from = new Date(now.getTime() - 60 * 60 * 1000)
      return { from: from.toISOString(), to: now.toISOString() }
    }
    case 'today': {
      const start = new Date(now); start.setHours(0, 0, 0, 0)
      return { from: start.toISOString(), to: now.toISOString() }
    }
    case 'yesterday': {
      const start = new Date(now); start.setDate(start.getDate() - 1); start.setHours(0, 0, 0, 0)
      const end = new Date(start); end.setHours(23, 59, 59, 999)
      return { from: start.toISOString(), to: end.toISOString() }
    }
    case 'last_7d': {
      const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      return { from: from.toISOString(), to: now.toISOString() }
    }
    case 'this_week': {
      const start = new Date(now); const dow = start.getDay(); start.setDate(start.getDate() - (dow === 0 ? 6 : dow - 1)); start.setHours(0, 0, 0, 0)
      return { from: start.toISOString(), to: now.toISOString() }
    }
    case 'this_month': {
      const start = new Date(now.getFullYear(), now.getMonth(), 1)
      return { from: start.toISOString(), to: now.toISOString() }
    }
    case 'last_30d': {
      const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
      return { from: from.toISOString(), to: now.toISOString() }
    }
    case 'custom': {
      if (!customFrom && !customTo) return null
      const from = customFrom ? new Date(customFrom + 'T00:00:00').toISOString() : ''
      const to = customTo ? new Date(customTo + 'T23:59:59').toISOString() : ''
      return { from, to }
    }
    default: return null
  }
}

export default function LeadsPage() {
  const { ref: workspaceRef, width: workspaceWidth } = useContainerWidth<HTMLDivElement>()
  const isCompactListWorkspace = workspaceWidth > 0 && workspaceWidth < 900
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
  const [filterPanelPosition, setFilterPanelPosition] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null)
  const [filterStageIds, setFilterStageIds] = useState<Set<string>>(new Set())
  const [filterTagNames, setFilterTagNames] = useState<Set<string>>(new Set())
  const [excludeFilterTagNames, setExcludeFilterTagNames] = useState<Set<string>>(new Set())
  const [tagFilterMode, setTagFilterMode] = useState<'OR' | 'AND'>('OR')
  const [tagSearchTerm, setTagSearchTerm] = useState('')
  // Advanced formula filter
  const [leadFormulaType, setLeadFormulaType] = useState<'simple' | 'advanced'>('simple')
  const [leadFormulaText, setLeadFormulaText] = useState('')
  const [leadFormulaIsValid, setLeadFormulaIsValid] = useState(true)
  // Applied formula (only applied on clicking Aplicar)
  const [appliedFormulaType, setAppliedFormulaType] = useState<'simple' | 'advanced'>('simple')
  const [appliedFormulaText, setAppliedFormulaText] = useState('')
  const [showAddModal, setShowAddModal] = useState(false)
  const [creatingLead, setCreatingLead] = useState(false)
  const [showEditModal, setShowEditModal] = useState(false)
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState(false)
  const [draggedLeadId, setDraggedLeadId] = useState<string | null>(null)
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null)
  const [formData, setFormData] = useState({
    title: '',
    name: '',
    phone: '',
    email: '',
    notes: '',
    tags: '',
    stage_id: '',
    dni: '',
    birth_date: '',
  })

  // Detail panel
  const [showDetailPanel, setShowDetailPanel] = useState(false)
  const [detailLead, setDetailLead] = useState<Lead | null>(null)
  const [scrollToTasks, setScrollToTasks] = useState(false)
  const [observations, setObservations] = useState<Observation[]>([])
  const [loadingObservations, setLoadingObservations] = useState(false)
  const [newObservation, setNewObservation] = useState('')
  const [newObservationType, setNewObservationType] = useState<'note' | 'call'>('note')
  const [savingObservation, setSavingObservation] = useState(false)
  const [obsDisplayCount, setObsDisplayCount] = useState(5)
  const [showHistoryModal, setShowHistoryModal] = useState(false)
  const [showImportModal, setShowImportModal] = useState(false)
  const [showContactImportModal, setShowContactImportModal] = useState(false)
  const [importingContacts, setImportingContacts] = useState(false)
  const [duplicateConfirmation, setDuplicateConfirmation] = useState<{
    kind: 'single' | 'bulk'
    count: number
    contacts?: SelectedPerson[]
  } | null>(null)
  const duplicateDialogRef = useRef<HTMLDivElement>(null)
  const duplicateCancelRef = useRef<HTMLButtonElement>(null)
  const addLeadDialogRef = useRef<HTMLDivElement>(null)
  const newLeadTitleRef = useRef<HTMLInputElement>(null)
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
  const [hiddenStageIds, setHiddenStageIds] = useState<Set<string>>(new Set())

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
  const [inlineChatReadOnly, setInlineChatReadOnly] = useState(false)
  const [existingChatForWA, setExistingChatForWA] = useState<any>(null)
  const [allDevicesForModal, setAllDevicesForModal] = useState<Device[]>([])
  const [whatsappHistoricalPhone, setWhatsappHistoricalPhone] = useState('')
  const whatsappRequestRef = useRef(0)
  const activeLeadIdRef = useRef<string | null>(null)
  const loadedLeadContextByContactRef = useRef(new Map<string, string>())
  const contactRefreshSequenceRef = useRef(new Map<string, number>())

  const closeDuplicateConfirmation = useCallback(() => setDuplicateConfirmation(null), [])
  useAccessibleDialog(Boolean(duplicateConfirmation), duplicateDialogRef, closeDuplicateConfirmation, duplicateCancelRef)
  const closeAddLeadDialog = useCallback(() => {
    if (creatingLead) return
    setShowAddModal(false)
    setFormData({ title: '', name: '', phone: '', email: '', notes: '', tags: '', stage_id: '', dni: '', birth_date: '' })
  }, [creatingLead])
  useAccessibleDialog(showAddModal && !duplicateConfirmation, addLeadDialogRef, closeAddLeadDialog, newLeadTitleRef)

  useEffect(() => {
    activeLeadIdRef.current = detailLead?.id || null
  }, [detailLead?.id])

  const resetInlineChatState = useCallback(() => {
    whatsappRequestRef.current += 1
    setShowDeviceSelector(false)
    setWhatsappPhone('')
    setShowInlineChat(false)
    setInlineChatId('')
    setInlineChat(null)
    setInlineChatDeviceId('')
    setInlineChatReadOnly(false)
    setExistingChatForWA(null)
    setAllDevicesForModal([])
    setWhatsappHistoricalPhone('')
  }, [])

  const isCurrentWhatsAppRequest = useCallback((requestId: number, leadId: string | null) => {
    return whatsappRequestRef.current === requestId && activeLeadIdRef.current === leadId
  }, [])

  // Device filter for leads
  const [filterDeviceIds, setFilterDeviceIds] = useState<Set<string>>(new Set())
  const [showDeviceFilter, setShowDeviceFilter] = useState(false)

  // Date filter
  const [filterDateField, setFilterDateField] = useState<'created_at' | 'updated_at'>('created_at')
  const [filterDatePreset, setFilterDatePreset] = useState('')
  const [filterDateFrom, setFilterDateFrom] = useState('')
  const [filterDateTo, setFilterDateTo] = useState('')

  // Broadcast from leads
  const [showBroadcastModal, setShowBroadcastModal] = useState(false)
  const [submittingBroadcast, setSubmittingBroadcast] = useState(false)

  // View mode: kanban vs list
  const [viewMode, setViewMode] = useState<'kanban' | 'list'>('kanban')
  const prevViewModeRef = useRef<'kanban' | 'list'>('kanban')

  // Opportunity lifecycle. "blocked" remains temporarily visible for legacy records.
  const [statusFilter, setStatusFilter] = useState<'active' | 'won' | 'lost' | 'archived' | 'blocked' | 'trash'>('active')
  const [leadCounts, setLeadCounts] = useState({ active: 0, won: 0, lost: 0, archived: 0, blocked: 0, trash: 0 })
  const [hiddenByStatus, setHiddenByStatus] = useState(0)

  // List view paginated data
  const [listLeads, setListLeads] = useState<Lead[]>([])
  const [listTotal, setListTotal] = useState(0)
  const [listHasMore, setListHasMore] = useState(false)
  const [listLoading, setListLoading] = useState(false)

  // Custom field columns for list view
  const [cfDefs, setCfDefs] = useState<CustomFieldDefinition[]>([])
  const [cfVisibleIds, setCfVisibleIds] = useState<Set<string>>(new Set())
  const [showCfColumnPicker, setShowCfColumnPicker] = useState(false)
  const cfColumnPickerRef = useRef<HTMLDivElement>(null)
  const [cfFilters, setCfFilters] = useState<CustomFieldFilter[]>([])

  // "Más" dropdown menu
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const moreMenuRef = useRef<HTMLDivElement>(null)

  // Export
  const [showExportModal, setShowExportModal] = useState(false)
  const [exportFormat, setExportFormat] = useState<'excel' | 'csv'>('excel')
  const [exportScope, setExportScope] = useState<'all' | 'filtered'>('filtered')
  const [exporting, setExporting] = useState(false)

  // Bulk document generation
  const [showBulkDocModal, setShowBulkDocModal] = useState(false)

  // Create Event from Leads modal
  const [showCreateEventModal, setShowCreateEventModal] = useState(false)
  const [createEventForm, setCreateEventForm] = useState({ name: '', description: '', event_date: '', event_end: '', location: '', color: '#10b981' })
  const [creatingEvent, setCreatingEvent] = useState(false)

  // List view observations cache
  const [listObservations, setListObservations] = useState<Map<string, Observation[]>>(new Map())

  // Google Contacts sync
  const [googleConnected, setGoogleConnected] = useState(false)
  const [googleSyncing, setGoogleSyncing] = useState(false)

  const [loadingListObs, setLoadingListObs] = useState<Set<string>>(new Set())
  const [expandedListLeadId, setExpandedListLeadId] = useState<string | null>(null)
  const [listHistoryLead, setListHistoryLead] = useState<Lead | null>(null)

  const kanbanRef = useRef<HTMLDivElement>(null)
  const topScrollRef = useRef<HTMLDivElement>(null)
  const listScrollRef = useRef<HTMLDivElement>(null)
  const listOffsetRef = useRef(0)
  const filterDropdownRef = useRef<HTMLDivElement>(null)
  const filterDialogRef = useRef<HTMLDivElement>(null)
  const syncingScroll = useRef(false)
  const activePipelineIdRef = useRef<string | null>(null)
  const kanbanRequestRef = useRef(0)
  const listRequestRef = useRef(0)
  const [resultsError, setResultsError] = useState('')
  const filterSnapshotRef = useRef<{
    stageIds: Set<string>
    includeTags: Set<string>
    excludeTags: Set<string>
    deviceIds: Set<string>
    tagMode: 'OR' | 'AND'
    formulaType: 'simple' | 'advanced'
    formulaText: string
    formulaValid: boolean
    appliedFormulaType: 'simple' | 'advanced'
    appliedFormulaText: string
    dateField: 'created_at' | 'updated_at'
    datePreset: string
    dateFrom: string
    dateTo: string
    customFields: CustomFieldFilter[]
  } | null>(null)

  const openFilters = () => {
    filterSnapshotRef.current = {
      stageIds: new Set(filterStageIds),
      includeTags: new Set(filterTagNames),
      excludeTags: new Set(excludeFilterTagNames),
      deviceIds: new Set(filterDeviceIds),
      tagMode: tagFilterMode,
      formulaType: leadFormulaType,
      formulaText: leadFormulaText,
      formulaValid: leadFormulaIsValid,
      appliedFormulaType,
      appliedFormulaText,
      dateField: filterDateField,
      datePreset: filterDatePreset,
      dateFrom: filterDateFrom,
      dateTo: filterDateTo,
      customFields: cfFilters.map(filter => ({ ...filter })),
    }
    setShowFilterDropdown(true)
  }

  const discardFilterDraft = useCallback(() => {
    const snapshot = filterSnapshotRef.current
    if (snapshot) {
      setFilterStageIds(snapshot.stageIds)
      setFilterTagNames(snapshot.includeTags)
      setExcludeFilterTagNames(snapshot.excludeTags)
      setFilterDeviceIds(snapshot.deviceIds)
      setTagFilterMode(snapshot.tagMode)
      setLeadFormulaType(snapshot.formulaType)
      setLeadFormulaText(snapshot.formulaText)
      setLeadFormulaIsValid(snapshot.formulaValid)
      setAppliedFormulaType(snapshot.appliedFormulaType)
      setAppliedFormulaText(snapshot.appliedFormulaText)
      setFilterDateField(snapshot.dateField)
      setFilterDatePreset(snapshot.datePreset)
      setFilterDateFrom(snapshot.dateFrom)
      setFilterDateTo(snapshot.dateTo)
      setCfFilters(snapshot.customFields)
    }
    filterSnapshotRef.current = null
    setShowFilterDropdown(false)
  }, [])

  useAccessibleDialog(showFilterDropdown, filterDialogRef, discardFilterDraft)

  useEffect(() => {
    activePipelineIdRef.current = activePipeline?.id || null
    const validStageIds = new Set((activePipeline?.stages || []).map(stage => stage.id))
    setFilterStageIds(current => {
      const next = new Set(Array.from(current).filter(stageId => validStageIds.has(stageId)))
      return next.size === current.size ? current : next
    })
  }, [activePipeline?.id])

  // Ctrl+drag kanban panning
  useKanbanPan(kanbanRef, topScrollRef)

  // Click outside to close dropdowns
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (moreMenuRef.current && !moreMenuRef.current.contains(event.target as Node)) {
        setShowMoreMenu(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => {
      document.removeEventListener("mousedown", handleClickOutside)
    }
  }, [])

  const fetchPipelines = useCallback(async (preferredPipelineId?: string | null) => {
    const token = localStorage.getItem('token')
    try {
      const pipelinesRes = await fetch('/api/pipelines', { headers: { Authorization: `Bearer ${token}` } })
      const data = await pipelinesRes.json()
      if (data.success && data.pipelines && data.pipelines.length > 0) {
        setPipelines(data.pipelines)
        const keepPipelineId = preferredPipelineId ?? activePipelineIdRef.current
        if (keepPipelineId === '__no_pipeline__') {
          setActivePipeline({ id: '__no_pipeline__', name: 'Sin pipeline', is_default: false, stages: [] })
          return
        }
        const currentP = keepPipelineId ? data.pipelines.find((p: Pipeline) => p.id === keepPipelineId) : null
        const defaultP = data.pipelines.find((p: Pipeline) => p.is_default) || data.pipelines[0]
        if (currentP || defaultP) setActivePipeline(currentP || defaultP)
      } else {
        setPipelines([])
      }
    } catch (err) {
      console.error('Failed to fetch pipelines:', err)
    } finally {
      setPipelinesLoaded(true)
    }
  }, [])

  const fetchLeadCounts = useCallback(async () => {
    const token = localStorage.getItem('token')
    try {
      const params = new URLSearchParams()
      if (activePipeline) params.set('pipeline_id', activePipeline.id)
      const res = await fetch(`/api/leads/counts?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        setLeadCounts({
          active: data.open ?? data.active ?? 0,
          won: data.won || 0,
          lost: data.lost || 0,
          archived: data.archived || 0,
          blocked: data.blocked || 0,
          trash: data.trash ?? data.deleted ?? 0,
        })
      }
    } catch (err) {
      console.error('Failed to fetch lead counts:', err)
    }
  }, [activePipeline])

  const fetchLeadsPaginated = useCallback(async () => {
    const requestId = ++kanbanRequestRef.current
    const token = localStorage.getItem('token')
    setResultsError('')
    try {
      const params = new URLSearchParams()
      params.set('status_filter', statusFilter)
      params.set('lifecycle', statusFilter === 'active' ? 'open' : statusFilter)
      if (activePipeline) params.set('pipeline_id', activePipeline.id)
      params.set('per_stage', '50')
      if (debouncedSearchTerm) params.set('search', debouncedSearchTerm)
      if (appliedFormulaType === 'advanced' && appliedFormulaText) {
        params.set('tag_formula', appliedFormulaText)
      } else {
        if (filterTagNames.size > 0) params.set('tag_names', Array.from(filterTagNames).join(','))
        if (filterTagNames.size > 0 || excludeFilterTagNames.size > 0) params.set('tag_mode', tagFilterMode)
        if (excludeFilterTagNames.size > 0) params.set('exclude_tag_names', Array.from(excludeFilterTagNames).join(','))
      }
      if (filterStageIds.size > 0) params.set('stage_ids', Array.from(filterStageIds).join(','))
      filterDeviceIds.forEach(id => params.append('device_ids', id))
      const dateRange = resolveDatePreset(filterDatePreset, filterDateFrom, filterDateTo)
      if (dateRange) {
        params.set('date_field', filterDateField)
        if (dateRange.from) params.set('date_from', dateRange.from)
        if (dateRange.to) params.set('date_to', dateRange.to)
      }
      const res = await fetch(`/api/leads/paginated?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (requestId !== kanbanRequestRef.current) return
      if (data.success) {
        setStageData((data.stages || []).map((s: StageData) => ({ ...s, leads: s.leads || [] })))
        const ua = data.unassigned || { total_count: 0, leads: [], has_more: false }
        setUnassignedData({ ...ua, leads: ua.leads || [] })
        setAllTags(data.all_tags || [])
        setHiddenByStatus(data.hidden_by_status || 0)
      } else setResultsError(data.error || 'No pudimos cargar las oportunidades.')
    } catch (err) {
      if (requestId !== kanbanRequestRef.current) return
      console.error('Failed to fetch leads:', err)
      setResultsError('No pudimos cargar las oportunidades. Revisa tu conexión e inténtalo otra vez.')
    } finally {
      if (requestId === kanbanRequestRef.current) setLoading(false)
    }
  }, [statusFilter, activePipeline, debouncedSearchTerm, filterTagNames, excludeFilterTagNames, tagFilterMode, filterStageIds, filterDeviceIds, appliedFormulaType, appliedFormulaText, filterDateField, filterDatePreset, filterDateFrom, filterDateTo])

  const fetchListLeads = useCallback(async (reset: boolean = false) => {
    const requestId = ++listRequestRef.current
    setListLoading(true)
    setResultsError('')
    const offset = reset ? 0 : listOffsetRef.current
    const token = localStorage.getItem('token')
    try {
      const params = new URLSearchParams()
      params.set('status_filter', statusFilter)
      params.set('lifecycle', statusFilter === 'active' ? 'open' : statusFilter)
      // When searching, omit pipeline_id to find leads across all pipelines
      if (activePipeline && !debouncedSearchTerm) params.set('pipeline_id', activePipeline.id)
      params.set('offset', String(offset))
      params.set('limit', '100')
      if (debouncedSearchTerm) params.set('search', debouncedSearchTerm)
      if (appliedFormulaType === 'advanced' && appliedFormulaText) {
        params.set('tag_formula', appliedFormulaText)
      } else {
        if (filterTagNames.size > 0) params.set('tag_names', Array.from(filterTagNames).join(','))
        if (filterTagNames.size > 0 || excludeFilterTagNames.size > 0) params.set('tag_mode', tagFilterMode)
        if (excludeFilterTagNames.size > 0) params.set('exclude_tag_names', Array.from(excludeFilterTagNames).join(','))
      }
      if (filterStageIds.size > 0) params.set('stage_ids', Array.from(filterStageIds).join(','))
      filterDeviceIds.forEach(id => params.append('device_ids', id))
      const dateRange = resolveDatePreset(filterDatePreset, filterDateFrom, filterDateTo)
      if (dateRange) {
        params.set('date_field', filterDateField)
        if (dateRange.from) params.set('date_from', dateRange.from)
        if (dateRange.to) params.set('date_to', dateRange.to)
      }
      if (cfVisibleIds.size > 0) params.set('include_custom_fields', 'true')
      if (cfFilters.length > 0) params.set('cf_filter', JSON.stringify(cfFilters))
      const res = await fetch(`/api/leads/list-paginated?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (requestId !== listRequestRef.current) return
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
      } else setResultsError(data.error || 'No pudimos cargar las oportunidades.')
    } catch (err) {
      if (requestId !== listRequestRef.current) return
      console.error('Failed to fetch list leads:', err)
      setResultsError('No pudimos cargar las oportunidades. Revisa tu conexión e inténtalo otra vez.')
    } finally {
      if (requestId === listRequestRef.current) setListLoading(false)
    }
  }, [statusFilter, activePipeline, debouncedSearchTerm, filterTagNames, excludeFilterTagNames, tagFilterMode, filterStageIds, filterDeviceIds, appliedFormulaType, appliedFormulaText, filterDateField, filterDatePreset, filterDateFrom, filterDateTo, cfVisibleIds, cfFilters])

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
      params.set('status_filter', statusFilter)
      params.set('lifecycle', statusFilter === 'active' ? 'open' : statusFilter)
      params.set('offset', String(currentLeads.length))
      params.set('limit', '50')
      if (activePipeline) params.set('pipeline_id', activePipeline.id)
      if (debouncedSearchTerm) params.set('search', debouncedSearchTerm)
      if (appliedFormulaType === 'advanced' && appliedFormulaText) {
        params.set('tag_formula', appliedFormulaText)
      } else {
        if (filterTagNames.size > 0) params.set('tag_names', Array.from(filterTagNames).join(','))
        if (filterTagNames.size > 0 || excludeFilterTagNames.size > 0) params.set('tag_mode', tagFilterMode)
        if (excludeFilterTagNames.size > 0) params.set('exclude_tag_names', Array.from(excludeFilterTagNames).join(','))
      }
      filterDeviceIds.forEach(id => params.append('device_ids', id))
      const dateRange = resolveDatePreset(filterDatePreset, filterDateFrom, filterDateTo)
      if (dateRange) {
        params.set('date_field', filterDateField)
        if (dateRange.from) params.set('date_from', dateRange.from)
        if (dateRange.to) params.set('date_to', dateRange.to)
      }
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
  }, [loadingMoreStages, stageData, unassignedData, activePipeline, debouncedSearchTerm, filterTagNames, excludeFilterTagNames, tagFilterMode, filterDeviceIds, appliedFormulaType, appliedFormulaText, filterDateField, filterDatePreset, filterDateFrom, filterDateTo])

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

  const reconcileContactProfile = useCallback((contact: ContactProfileContact) => {
    setStageData(current => current.map(stage => ({
      ...stage,
      leads: stage.leads.map(lead => mergeContactProfileIntoLead(lead, contact)),
    })))
    setUnassignedData(current => ({
      ...current,
      leads: current.leads.map(lead => mergeContactProfileIntoLead(lead, contact)),
    }))
    setListLeads(current => current.map(lead => mergeContactProfileIntoLead(lead, contact)))
    setDetailLead(current => current ? mergeContactProfileIntoLead(current, contact) : current)
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

  useEffect(() => {
    const contexts = new Map<string, string>()
    ;[...allLoadedLeads, ...listLeads, ...(detailLead ? [detailLead] : [])].forEach(lead => {
      if (lead.contact_id && !contexts.has(lead.contact_id)) contexts.set(lead.contact_id, lead.id)
    })
    loadedLeadContextByContactRef.current = contexts
  }, [allLoadedLeads, detailLead, listLeads])

  const refreshLoadedContact = useCallback(async (contactId: string) => {
    const leadId = loadedLeadContextByContactRef.current.get(contactId)
    if (!leadId) return
    const sequence = (contactRefreshSequenceRef.current.get(contactId) || 0) + 1
    contactRefreshSequenceRef.current.set(contactId, sequence)
    const result = await api<ContactProfileResponse>(`/api/contact-profiles/${contactId}?context_type=lead&context_id=${leadId}`)
    if (contactRefreshSequenceRef.current.get(contactId) !== sequence) return
    if (result.success && result.data?.success && result.data.contact) reconcileContactProfile(result.data.contact)
  }, [reconcileContactProfile])

  // Find lead by ID across all loaded data
  const findLeadById = useCallback((leadId: string): Lead | undefined => {
    for (const stage of stageData) {
      const found = (stage.leads || []).find(l => l.id === leadId)
      if (found) return found
    }
    const inUnassigned = (unassignedData.leads || []).find(l => l.id === leadId)
    if (inUnassigned) return inUnassigned
    return listLeads.find(l => l.id === leadId) || (detailLead?.id === leadId ? detailLead : undefined)
  }, [stageData, unassignedData, listLeads, detailLead])

  // Total count from server (all matching leads, not just loaded)
  const totalLeadCount = useMemo(() =>
    stageData.reduce((sum, s) => sum + s.total_count, 0) + unassignedData.total_count,
    [stageData, unassignedData]
  )

  const fetchDevices = useCallback(async () => {
    const result = await api<{ devices?: Device[] }>('/api/devices')
    if (result.success && result.data) {
      setDevices((result.data.devices || []).filter((d: Device) => d.status === 'connected'))
    }
  }, [])

  useEffect(() => {
    fetchPipelines()
    fetchDevices()
    // Check Google Contacts connection status
    fetch('/api/google/status').then(r => r.json()).then(d => setGoogleConnected(!!d.connected)).catch(() => {})
    // Fetch custom field definitions
    const token = localStorage.getItem('token')
    if (token) {
      fetch('/api/custom-fields', { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.json())
        .then(d => {
          if (d.success) {
            const defs: CustomFieldDefinition[] = d.definitions || []
            setCfDefs(defs)
            try {
              const saved = localStorage.getItem('cf_columns_leads')
              if (saved) {
                const ids: string[] = JSON.parse(saved)
                const validIds = ids.filter(id => defs.some(def => def.id === id))
                setCfVisibleIds(new Set(validIds))
              }
            } catch {}
          }
        })
        .catch(() => {})
    }
    // Load hidden stages from localStorage
    try {
      const saved = localStorage.getItem('hiddenStageIds')
      if (saved) setHiddenStageIds(new Set(JSON.parse(saved)))
    } catch {}
  }, [fetchPipelines])

  // Auto-open lead detail from URL params (e.g. ?lead_id=UUID&scroll=tasks)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const leadId = params.get('lead_id')
    const scroll = params.get('scroll')
    if (!leadId) return

    // Clear URL params to avoid re-triggering
    window.history.replaceState({}, '', window.location.pathname)

    const fetchAndOpenLead = async () => {
      try {
        const token = localStorage.getItem('token')
        const res = await fetch(`/api/leads/${leadId}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        const data = await res.json()
        if (data.success && data.lead) {
          resetInlineChatState()
          setDetailLead(data.lead)
          setShowDetailPanel(true)
          if (scroll === 'tasks') setScrollToTasks(true)
        }
      } catch { /* ignore */ }
    }
    fetchAndOpenLead()
  }, [resetInlineChatState])

  // Fetch paginated kanban data when pipelines loaded or pipeline/filters change
  useEffect(() => {
    if (pipelinesLoaded && !showFilterDropdown) {
      fetchLeadsPaginated()
      fetchLeadCounts()
    }
  }, [pipelinesLoaded, fetchLeadsPaginated, fetchLeadCounts, showFilterDropdown])

  // Fetch list data when in list view (and when filters change)
  useEffect(() => {
    if (viewMode === 'list' && pipelinesLoaded && !showFilterDropdown) {
      fetchListLeads(true)
    }
  }, [viewMode, fetchListLeads, pipelinesLoaded, showFilterDropdown])

  // Auto-switch to list view when search is active (cross-pipeline results work best in list)
  useEffect(() => {
    if (debouncedSearchTerm) {
      if (viewMode !== 'list') {
        prevViewModeRef.current = viewMode
        setViewMode('list')
      }
    } else {
      setViewMode(prevViewModeRef.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearchTerm])

  // WebSocket: listen for lead_update events — delta updates for paginated data
  useEffect(() => {
    const unsubscribe = subscribeWebSocket((data: unknown) => {
      const msg = data as { event?: string; action?: string; lead?: Lead; lead_id?: string; stage_id?: string }
      if (msg.event === 'contact_update') {
        const contactId = contactIdFromRealtimeEvent(data)
        if (contactId) void refreshLoadedContact(contactId)
      }
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
        } else if (msg.action !== 'synced') {
          // Fallback: full re-fetch for unknown actions (skip background sync noise)
          fetchLeadsPaginated()
        }
      }
      // Handle interaction updates — invalidate observations cache so list view refreshes
      if (msg.event === 'interaction_update') {
        const leadId = (msg as Record<string, unknown>).lead_id as string | undefined
        if (leadId && viewMode === 'list') {
          setListObservations(prev => {
            const next = new Map(prev)
            next.delete(leadId)
            return next
          })
          setLoadingListObs(prev => {
            const next = new Set(prev)
            next.delete(leadId)
            return next
          })
          // Immediate refetch for the affected lead
          const tk = localStorage.getItem('token')
          if (tk) {
            fetch(`/api/leads/${leadId}/interactions?limit=5`, { headers: { Authorization: `Bearer ${tk}` } })
              .then(r => r.json()).then(d => {
                if (d.success) setListObservations(prev => new Map(prev).set(leadId, d.interactions || []))
              }).catch(() => {})
          }
        }
      }
      // Handle custom field definition updates
      if (msg.event === 'custom_field_def_update') {
        const tk = localStorage.getItem('token')
        if (tk) {
          fetch('/api/custom-fields', { headers: { Authorization: `Bearer ${tk}` } })
            .then(r => r.json())
            .then(d => { if (d.success) setCfDefs(d.definitions || []) })
            .catch(() => {})
        }
      }
    })
    return () => unsubscribe()
  }, [fetchLeadsPaginated, updateLeadInStages, removeLeadFromStages, detailLead, activePipeline, refreshLoadedContact, viewMode])

  // Custom field column toggle
  const toggleCfColumn = useCallback((fieldId: string) => {
    setCfVisibleIds(prev => {
      const next = new Set(prev)
      if (next.has(fieldId)) next.delete(fieldId)
      else next.add(fieldId)
      localStorage.setItem('cf_columns_leads', JSON.stringify(Array.from(next)))
      return next
    })
  }, [])

  // Format custom field value for list table cell
  const formatCfCell = useCallback((def: CustomFieldDefinition, lead: Lead) => {
    const vals: CustomFieldValue[] = (lead as any).custom_field_values || []
    const val = vals.find(v => v.field_id === def.id)
    if (!val) return <span className="text-slate-300">—</span>
    switch (def.field_type) {
      case 'text': case 'email': case 'phone': case 'url':
        return <span className="truncate">{val.value_text || '—'}</span>
      case 'number':
        return <span>{val.value_number != null ? val.value_number : '—'}</span>
      case 'currency': {
        if (val.value_number == null) return <span className="text-slate-300">—</span>
        const sym = def.config?.symbol || '$'
        const dec = def.config?.decimals ?? 2
        return <span>{sym} {val.value_number.toLocaleString('es-PE', { minimumFractionDigits: dec, maximumFractionDigits: dec })}</span>
      }
      case 'date':
        if (!val.value_date) return <span className="text-slate-300">—</span>
        try { return <span>{new Date(val.value_date).toLocaleDateString('es-PE', { year: 'numeric', month: 'short', day: 'numeric' })}</span> }
        catch { return <span>{val.value_date}</span> }
      case 'checkbox':
        return <span className={val.value_bool ? 'text-emerald-600' : 'text-slate-400'}>{val.value_bool ? 'Sí' : 'No'}</span>
      case 'select': {
        const opt = def.config?.options?.find(o => o.value === val.value_text)
        return <span>{opt?.label || val.value_text || '—'}</span>
      }
      case 'multi_select': {
        if (!val.value_json || val.value_json.length === 0) return <span className="text-slate-300">—</span>
        return <div className="flex flex-wrap gap-0.5">{val.value_json.slice(0, 2).map(v => {
          const o = def.config?.options?.find(opt => opt.value === v)
          return <span key={v} className="px-1.5 py-0.5 bg-slate-100 text-slate-600 text-[10px] rounded-full">{o?.label || v}</span>
        })}{val.value_json.length > 2 && <span className="text-[10px] text-slate-400">+{val.value_json.length - 2}</span>}</div>
      }
      default: return <span className="text-slate-300">—</span>
    }
  }, [])

  // Close cfColumnPicker on outside click
  useEffect(() => {
    if (!showCfColumnPicker) return
    const handler = (e: MouseEvent) => {
      if (cfColumnPickerRef.current && !cfColumnPickerRef.current.contains(e.target as Node)) {
        setShowCfColumnPicker(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showCfColumnPicker])

  // Debounce search term (500ms)
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearchTerm(searchTerm), 500)
    return () => clearTimeout(timer)
  }, [searchTerm])

  // Click outside to close filter dropdown + reset tag search
  useEffect(() => {
    if (!showFilterDropdown) {
      setTagSearchTerm('')
      setFilterPanelPosition(null)
      return
    }
    const handleClickOutside = (e: MouseEvent) => {
      const path = e.composedPath()
      if (path.some(target => target instanceof HTMLElement && target.dataset.formulaSuggestions === 'true')) return
      if (filterDropdownRef.current && !filterDropdownRef.current.contains(e.target as Node)) {
        discardFilterDraft()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showFilterDropdown, discardFilterDraft])

  useEffect(() => {
    if (!showFilterDropdown) return
    const updatePosition = () => {
      if (window.innerWidth < 640) {
        setFilterPanelPosition(null)
        return
      }
      const anchor = filterDropdownRef.current
      if (!anchor) return
      const rect = anchor.getBoundingClientRect()
      const viewport = window.visualViewport
      const viewportLeft = viewport?.offsetLeft || 0
      const viewportTop = viewport?.offsetTop || 0
      const viewportWidth = viewport?.width || window.innerWidth
      const viewportHeight = viewport?.height || window.innerHeight
      const margin = 12
      const width = Math.min(760, viewportWidth - margin * 2)
      const left = Math.min(
        Math.max(rect.left, viewportLeft + margin),
        viewportLeft + viewportWidth - width - margin,
      )
      const below = viewportTop + viewportHeight - rect.bottom - margin
      const useBelow = below >= 420
      const top = useBelow ? rect.bottom + 6 : viewportTop + margin
      const maxHeight = useBelow ? Math.min(560, below - 6) : Math.min(560, viewportHeight - margin * 2)
      setFilterPanelPosition({ left, top, width, maxHeight })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    window.visualViewport?.addEventListener('resize', updatePosition)
    window.visualViewport?.addEventListener('scroll', updatePosition)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
      window.visualViewport?.removeEventListener('resize', updatePosition)
      window.visualViewport?.removeEventListener('scroll', updatePosition)
    }
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

  const allStages = activePipeline?.stages || []
  const activeStages = allStages.filter(stage => stage.stage_type !== 'won' && stage.stage_type !== 'lost')
  const terminalStages = allStages.filter(stage => stage.stage_type === 'won' || stage.stage_type === 'lost')
  const stages = activeStages.filter(stage => !hiddenStageIds.has(stage.id))
  const filterableStages = statusFilter === 'won'
    ? terminalStages.filter(stage => stage.stage_type === 'won')
    : statusFilter === 'lost'
    ? terminalStages.filter(stage => stage.stage_type === 'lost')
    : stages

  const handleCreateLead = async (confirmDuplicate = false) => {
    if (!formData.title.trim() || !formData.name.trim() || creatingLead) return
    const token = localStorage.getItem('token')
    setCreatingLead(true)
    try {
      const stageId = formData.stage_id || undefined
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          title: formData.title.trim(),
          name: formData.name,
          phone: formData.phone,
          email: formData.email,
          notes: formData.notes,
          dni: formData.dni || undefined,
          birth_date: formData.birth_date || undefined,
          tags: formData.tags.split(',').map(t => t.trim()).filter(Boolean),
          stage_id: stageId || undefined,
          confirm_duplicate: confirmDuplicate,
        }),
      })
      const data = await res.json()
      if (data.success) {
        setShowAddModal(false)
        setFormData({ title: '', name: '', phone: '', email: '', notes: '', tags: '', stage_id: '', dni: '', birth_date: '' })
        fetchLeadsPaginated()
        fetchLeadCounts()
      } else if (res.status === 409 && (data.code === 'possible_duplicate' || data.error_code === 'possible_duplicate')) {
        const matches = Array.isArray(data.candidates) ? data.candidates.length : 1
        setDuplicateConfirmation({ kind: 'single', count: matches })
      } else {
        alert(data.error || 'Error al crear la oportunidad')
      }
    } catch (err) {
      console.error('Failed to create lead:', err)
      alert('Error al crear la oportunidad')
    } finally {
      setCreatingLead(false)
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
    if (!confirm('¿Mover esta oportunidad a la papelera? Podrás restaurarla durante 30 días. El contacto y el chat no se eliminarán.')) return
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/leads/${leadId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        fetchLeadsPaginated()
        fetchLeadCounts()
        if (viewMode === 'list') fetchListLeads(true)
      }
    } catch (err) {
      console.error('Failed to delete lead:', err)
    }
  }

  const handleRestoreLead = async (leadId: string, askConfirmation = true) => {
    if (askConfirmation && !confirm('¿Restaurar esta oportunidad? Volverá a aparecer en su vista correspondiente.')) return
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/leads/${leadId}/restore`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (!res.ok || !data.success) throw new Error(data.error || 'No se pudo restaurar la oportunidad.')
      removeLeadFromStages(leadId)
      await Promise.all([fetchLeadsPaginated(), fetchLeadCounts(), viewMode === 'list' ? fetchListLeads(true) : Promise.resolve()])
    } catch (err) {
      console.error('Failed to restore lead:', err)
      alert(err instanceof Error ? err.message : 'No se pudo restaurar la oportunidad.')
    }
  }

  const handleCreateLeadsFromContacts = async (contacts: SelectedPerson[], confirmDuplicate = false) => {
    if (contacts.length === 0 || importingContacts) return
    const token = localStorage.getItem('token')
    setImportingContacts(true)
    try {
      const createFromContacts = async (confirmDuplicate: boolean) => {
        const response = await fetch('/api/leads/from-contacts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ contact_ids: contacts.map(contact => contact.id), confirm_duplicate: confirmDuplicate }),
        })
        return { response, data: await response.json() }
      }
      let { response: res, data } = await createFromContacts(confirmDuplicate)
      if (res.status === 409 && (data.code === 'possible_duplicate' || data.error_code === 'possible_duplicate')) {
        setDuplicateConfirmation({
          kind: 'bulk',
          count: Array.isArray(data.candidates) ? data.candidates.length : contacts.length,
          contacts,
        })
        return
      }
      if (!res.ok || !data.success) {
        alert(data.error || 'Error al crear oportunidades desde contactos')
        return
      }
      setShowContactImportModal(false)
      await Promise.all([
        fetchLeadsPaginated(),
        fetchPipelines(activePipelineIdRef.current),
      ])
      const created = data.created || 0
      const skipped = data.skipped || 0
      if (skipped > 0) {
        alert(`Se crearon ${created} oportunidad(es). ${skipped} contacto(s) no pudieron procesarse; revisa posibles duplicados o datos incompletos.`)
      }
    } catch (err) {
      console.error('Failed to create leads from contacts:', err)
      alert('Error al crear oportunidades desde contactos')
    } finally {
      setImportingContacts(false)
    }
  }

  const confirmDuplicateCreation = () => {
    const pending = duplicateConfirmation
    if (!pending) return
    setDuplicateConfirmation(null)
    if (pending.kind === 'single') {
      void handleCreateLead(true)
    } else if (pending.contacts) {
      void handleCreateLeadsFromContacts(pending.contacts, true)
    }
  }

  const handleDeleteSelected = async () => {
    if (selectedIds.size === 0) return
    if (!confirm(`¿Mover ${selectedIds.size} oportunidad(es) a la papelera? Podrás restaurarlas durante 30 días.`)) return
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
        fetchLeadCounts()
        if (viewMode === 'list') fetchListLeads(true)
      }
    } catch (err) {
      console.error('Failed to delete leads:', err)
    } finally {
      setDeleting(false)
    }
  }

  const handleRestoreSelected = async () => {
    if (selectedIds.size === 0) return
    if (!confirm(`¿Restaurar ${selectedIds.size} oportunidad(es)?`)) return
    setDeleting(true)
    try {
      const token = localStorage.getItem('token')
      const results = await Promise.all(Array.from(selectedIds).map(id => fetch(`/api/leads/${id}/restore`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}` } })))
      if (results.some(result => !result.ok)) throw new Error('Algunas oportunidades no pudieron restaurarse.')
      setSelectedIds(new Set())
      setSelectionMode(false)
      await Promise.all([fetchLeadsPaginated(), fetchLeadCounts(), viewMode === 'list' ? fetchListLeads(true) : Promise.resolve()])
    } catch (err) {
      alert(err instanceof Error ? err.message : 'No se pudieron restaurar las oportunidades.')
    } finally {
      setDeleting(false)
    }
  }

  const handleGoogleBatchSyncFromLeads = async () => {
    if (selectedIds.size === 0 || selectedIds.size > 30) return
    const token = localStorage.getItem('token')
    setGoogleSyncing(true)
    try {
      const res = await fetch('/api/google/contacts/batch/sync-from-leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ lead_ids: Array.from(selectedIds) }),
      })
      const data = await res.json()
      if (res.ok) {
        const synced = (data.results || []).filter((r: any) => r.success).length
        const errors = (data.results || []).filter((r: any) => !r.success).length
        alert(`Sincronizados: ${synced} contacto(s)${errors ? `, errores: ${errors}` : ''}`)
      } else {
        alert(data.error || 'Error al sincronizar')
      }
    } catch {
      alert('Error de conexión')
    } finally {
      setGoogleSyncing(false)
    }
  }

  const handleGoogleBatchDesyncFromLeads = async () => {
    if (selectedIds.size === 0 || selectedIds.size > 30) return
    if (!confirm(`¿Desincronizar los contactos de ${selectedIds.size} lead(s) de Google?`)) return
    const token = localStorage.getItem('token')
    setGoogleSyncing(true)
    try {
      const res = await fetch('/api/google/contacts/batch/desync-from-leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ lead_ids: Array.from(selectedIds) }),
      })
      const data = await res.json()
      if (res.ok) {
        const desynced = (data.results || []).filter((r: any) => r.success).length
        alert(`Desincronizados: ${desynced} contacto(s)`)
      } else {
        alert(data.error || 'Error al desincronizar')
      }
    } catch {
      alert('Error de conexión')
    } finally {
      setGoogleSyncing(false)
    }
  }

  const handleArchiveLead = async (leadId: string, archive: boolean, reason: string = '') => {
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/leads/${leadId}/archive`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ archive, reason }),
      })
      const data = await res.json()
      if (data.success) {
        fetchLeadsPaginated()
        fetchLeadCounts()
        if (viewMode === 'list') fetchListLeads(true)
      }
    } catch (err) {
      console.error('Failed to archive lead:', err)
    }
  }

  const handleBlockLead = async (leadId: string, block: boolean, reason: string = '') => {
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/leads/${leadId}/block`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ block, reason }),
      })
      const data = await res.json()
      if (res.ok && data.success) {
        fetchLeadsPaginated()
        fetchLeadCounts()
        if (viewMode === 'list') fetchListLeads(true)
        if (showDetailPanel) {
          setShowDetailPanel(false)
          resetInlineChatState()
        }
        return true
      }
      throw new Error(data.error || 'No se pudo actualizar la preferencia del contacto.')
    } catch (err) {
      console.error('Failed to block lead:', err)
      return false
    }
  }

  const handleArchiveSelectedBatch = async (archive: boolean, reason: string = '') => {
    if (selectedIds.size === 0) return
    const token = localStorage.getItem('token')
    setDeleting(true)
    try {
      const res = await fetch('/api/leads/batch/archive', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ids: Array.from(selectedIds), archive, reason }),
      })
      const data = await res.json()
      if (data.success) {
        setSelectedIds(new Set())
        setSelectionMode(false)
        fetchLeadsPaginated()
        fetchLeadCounts()
        if (viewMode === 'list') fetchListLeads(true)
      }
    } catch (err) {
      console.error('Failed to archive leads batch:', err)
    } finally {
      setDeleting(false)
    }
  }

  const handleBlockSelectedBatch = async (block: boolean, reason: string = '') => {
    if (selectedIds.size === 0) return false
    const token = localStorage.getItem('token')
    setDeleting(true)
    try {
      const res = await fetch('/api/leads/batch/block', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ids: Array.from(selectedIds), block, reason }),
      })
      const data = await res.json()
      if (res.ok && data.success) {
        setSelectedIds(new Set())
        setSelectionMode(false)
        fetchLeadsPaginated()
        fetchLeadCounts()
        if (viewMode === 'list') fetchListLeads(true)
        return true
      }
      throw new Error(data.error || 'No se pudieron actualizar los contactos seleccionados.')
    } catch (err) {
      console.error('Failed to block leads batch:', err)
      return false
    } finally {
      setDeleting(false)
    }
  }

  // Block reason modal state
  const [showBlockModal, setShowBlockModal] = useState(false)
  const [blockReason, setBlockReason] = useState('')
  const [blockTargetId, setBlockTargetId] = useState<string | null>(null)
  const [blockBatchMode, setBlockBatchMode] = useState(false)
  const [savingBlockPreference, setSavingBlockPreference] = useState(false)
  const [blockPreferenceError, setBlockPreferenceError] = useState('')
  const blockDialogRef = useRef<HTMLDivElement>(null)
  const blockFirstChoiceRef = useRef<HTMLButtonElement>(null)

  // Archive reason modal state
  const [showArchiveModal, setShowArchiveModal] = useState(false)
  const [archiveReason, setArchiveReason] = useState('')
  const [archiveTargetId, setArchiveTargetId] = useState<string | null>(null)
  const [archiveBatchMode, setArchiveBatchMode] = useState(false)

  // Explicit close/reopen flow for terminal stages.
  const [lifecycleRequest, setLifecycleRequest] = useState<{ lead: Lead; stage: PipelineStage; mode: 'won' | 'lost' | 'reopen' } | null>(null)
  const [lifecycleReason, setLifecycleReason] = useState('')
  const [savingLifecycle, setSavingLifecycle] = useState(false)
  const [lifecycleError, setLifecycleError] = useState('')
  const lifecycleDialogRef = useRef<HTMLDivElement>(null)

  const closeLifecycleDialog = useCallback(() => {
    if (!savingLifecycle) setLifecycleRequest(null)
  }, [savingLifecycle])

  useAccessibleDialog(Boolean(lifecycleRequest), lifecycleDialogRef, closeLifecycleDialog)
  const closeBlockDialog = useCallback(() => {
    if (!savingBlockPreference) setShowBlockModal(false)
  }, [savingBlockPreference])
  useAccessibleDialog(showBlockModal, blockDialogRef, closeBlockDialog, blockFirstChoiceRef)

  const requestLeadStageChange = (lead: Lead, stage: PipelineStage) => {
    if (stage.stage_type === 'won' || stage.stage_type === 'lost') {
      setLifecycleRequest({ lead, stage, mode: stage.stage_type })
      setLifecycleReason('')
      setLifecycleError('')
      return
    }
    if (lead.status === 'won' || lead.status === 'lost') {
      setLifecycleRequest({ lead, stage, mode: 'reopen' })
      setLifecycleReason('')
      setLifecycleError('')
      return
    }
    void handleUpdateLeadStage(lead.id, stage.id)
  }

  const requestLifecycleAction = (lead: Lead, mode: 'won' | 'lost' | 'reopen') => {
    const pipelineStages = pipelines.find(pipeline => pipeline.id === lead.pipeline_id)?.stages
      || (activePipeline?.id === lead.pipeline_id ? allStages : [])
    const target = mode === 'reopen'
      ? [...pipelineStages]
          .filter(stage => stage.stage_type !== 'won' && stage.stage_type !== 'lost')
          .sort((a, b) => a.position - b.position)[0]
      : pipelineStages.find(stage => stage.stage_type === mode)

    if (!target) {
      setResultsError(mode === 'reopen'
        ? 'Este pipeline no tiene una etapa activa para reabrir el lead.'
        : `Este pipeline no tiene configurada una etapa de ${mode === 'won' ? 'ganados' : 'perdidos'}.`)
      return
    }
    requestLeadStageChange(lead, target)
  }

  const confirmLifecycleChange = async () => {
    if (!lifecycleRequest || savingLifecycle) return
    if (lifecycleRequest.mode === 'lost' && !lifecycleReason.trim()) {
      setLifecycleError('Indica por qué se perdió esta oportunidad.')
      return
    }
    setSavingLifecycle(true)
    setLifecycleError('')
    try {
      const token = localStorage.getItem('token')
      const response = await fetch(`/api/leads/${lifecycleRequest.lead.id}/stage`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          stage_id: lifecycleRequest.stage.id,
          ...(lifecycleRequest.mode === 'lost' ? { close_reason: lifecycleReason.trim() } : {}),
        }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.success) throw new Error(data?.error || 'No se pudo actualizar la oportunidad.')
      setLifecycleRequest(null)
      setLifecycleReason('')
      setShowDetailPanel(false)
      resetInlineChatState()
      await Promise.all([
        fetchLeadsPaginated(),
        fetchLeadCounts(),
        viewMode === 'list' ? fetchListLeads(true) : Promise.resolve(),
      ])
    } catch (err) {
      setLifecycleError(err instanceof Error ? err.message : 'No se pudo actualizar la oportunidad.')
    } finally {
      setSavingLifecycle(false)
    }
  }

  const openBlockModal = (leadId: string | null, batchMode: boolean = false) => {
    setBlockTargetId(leadId)
    setBlockBatchMode(batchMode)
    setBlockReason('')
    setBlockPreferenceError('')
    setShowBlockModal(true)
  }

  const openArchiveModal = (leadId: string | null, batchMode: boolean = false) => {
    setArchiveTargetId(leadId)
    setArchiveBatchMode(batchMode)
    setArchiveReason('')
    setShowArchiveModal(true)
  }

  const confirmArchive = () => {
    if (!archiveReason) return
    if (archiveBatchMode) {
      handleArchiveSelectedBatch(true, archiveReason)
    } else if (archiveTargetId) {
      handleArchiveLead(archiveTargetId, true, archiveReason)
      setShowDetailPanel(false)
      resetInlineChatState()
    }
    setShowArchiveModal(false)
  }

  const confirmBlock = async () => {
    if (!blockReason || savingBlockPreference) return
    setSavingBlockPreference(true)
    setBlockPreferenceError('')
    let success = false
    if (blockBatchMode) {
      success = await handleBlockSelectedBatch(true, blockReason)
    } else if (blockTargetId) {
      success = await handleBlockLead(blockTargetId, true, blockReason)
    }
    setSavingBlockPreference(false)
    if (success) setShowBlockModal(false)
    else setBlockPreferenceError('No se pudo actualizar la preferencia. Intenta nuevamente.')
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
    const leads = viewMode === 'list' ? listLeads : allLoadedLeads
    setSelectedIds(new Set(leads.map(l => l.id)))
  }

  const openDetailPanel = (lead: Lead) => {
    resetInlineChatState()
    setDetailLead(lead)
    setShowDetailPanel(true)
    setObsDisplayCount(5)
    setEditingField(null)
    setEditingNotes(false)
    setNotesValue(lead.notes || '')
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
    const firstStageId = pipelineId ? (newPipeline?.stages?.find(stage => stage.stage_type !== 'won' && stage.stage_type !== 'lost')?.id || null) : null

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
        const target = allStages.find(stage => stage.id === targetStageId)
        if (target) requestLeadStageChange(lead, target)
      }
    }
    setDraggedLeadId(null)
  }

  // Create event from current lead filters
  const handleCreateEventFromLeads = async () => {
    if (!createEventForm.name) return
    setCreatingEvent(true)
    try {
      const body: Record<string, unknown> = {
        name: createEventForm.name,
        description: createEventForm.description || undefined,
        event_date: createEventForm.event_date ? new Date(createEventForm.event_date).toISOString() : undefined,
        event_end: createEventForm.event_end ? new Date(createEventForm.event_end).toISOString() : undefined,
        location: createEventForm.location || undefined,
        color: createEventForm.color,
        // Lead filter criteria (current filters)
        lead_pipeline_id: activePipeline?.id || undefined,
        search: debouncedSearchTerm || undefined,
        tag_names: filterTagNames.size > 0 ? Array.from(filterTagNames) : undefined,
        stage_ids: filterStageIds.size > 0 ? Array.from(filterStageIds) : undefined,
        device_ids: filterDeviceIds.size > 0 ? Array.from(filterDeviceIds) : undefined,
      }
      const res = await fetch('/api/events/from-leads', {
        method: 'POST',
        headers: { Authorization: `Bearer ${localStorage.getItem('token') || ''}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (data.success) {
        setShowCreateEventModal(false)
        setCreateEventForm({ name: '', description: '', event_date: '', event_end: '', location: '', color: '#10b981' })
        // Navigate to the new event
        window.location.href = `/dashboard/events/${data.event.id}`
      } else {
        alert(data.error || 'Error al crear evento')
      }
    } catch (e) { console.error(e); alert('Error de conexión') }
    setCreatingEvent(false)
  }

  // WhatsApp internal chat — smart device selection
  const handleSendWhatsApp = async (phone: string) => {
    const leadId = activeLeadIdRef.current
    resetInlineChatState()
    const requestId = whatsappRequestRef.current
    setWhatsappPhone(phone)
    try {
      const resolution = await resolveWhatsAppChat(phone)
      if (!isCurrentWhatsAppRequest(requestId, leadId)) return
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
        await handleDeviceSelected(resolution.devices[0] as Device, phone, requestId, leadId)
        return
      }
      if (resolution.mode === 'choose_device') {
        setAllDevicesForModal(resolution.devices as Device[])
        setShowDeviceSelector(true)
        return
      }
      alert('No hay dispositivos conectados para enviar')
    } catch {
      if (!isCurrentWhatsAppRequest(requestId, leadId)) return
      alert('Error de conexión')
    }
  }

  const handleDeviceSelected = async (
    device: Device,
    phoneOverride?: string,
    requestId: number = whatsappRequestRef.current,
    leadId: string | null = activeLeadIdRef.current
  ) => {
    setShowDeviceSelector(false)
    setInlineChatReadOnly(false)
    try {
      const data = await createWhatsAppChat(device.id, phoneOverride || whatsappPhone)
      if (!isCurrentWhatsAppRequest(requestId, leadId)) return
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
      if (!isCurrentWhatsAppRequest(requestId, leadId)) return
      alert('Error de conexión')
    }
  }

  const handlePreviousDeviceSelected = () => {
    setShowDeviceSelector(false)
    if (existingChatForWA) {
      setInlineChatId(existingChatForWA.id)
      setInlineChat(existingChatForWA)
      setInlineChatDeviceId(existingChatForWA.device_id || '')
      setInlineChatReadOnly(true)
      setShowInlineChat(true)
    }
  }

  // Escape key closes modals/panels (topmost first)
  useEffect(() => {
    const handleEscapeKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        if (lifecycleRequest) return // handled by the accessible lifecycle dialog
        if (showDeviceSelector) { setShowDeviceSelector(false); return }
        if (showStageModal) { setShowStageModal(false); return }
        if (showAddModal) { setShowAddModal(false); return }
        if (showEditModal) { setShowEditModal(false); return }
        if (showFilterDropdown) { discardFilterDraft(); return }
        if (showInlineChat) { resetInlineChatState(); return }
        if (showDetailPanel) { setShowDetailPanel(false); resetInlineChatState(); return }
      }
    }
    window.addEventListener('keydown', handleEscapeKey)
    return () => window.removeEventListener('keydown', handleEscapeKey)
  }, [resetInlineChatState, lifecycleRequest, showDeviceSelector, showStageModal, showAddModal, showEditModal, showFilterDropdown, showInlineChat, showDetailPanel, discardFilterDraft])

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

  const activeFilterCount = filterStageIds.size + filterTagNames.size + excludeFilterTagNames.size + filterDeviceIds.size + (appliedFormulaType === 'advanced' && appliedFormulaText ? 1 : 0) + (filterDatePreset ? 1 : 0) + cfFilters.length

  // Export leads
  const handleExportLeads = async () => {
    setExporting(true)
    const token = localStorage.getItem('token')
    try {
      const params = new URLSearchParams()
      if (exportScope === 'filtered') {
        // Mirror EXACTLY the filters used by fetchListLeads so the export matches the visible list.
        params.set('status_filter', statusFilter)
        params.set('lifecycle', statusFilter === 'active' ? 'open' : statusFilter)
        if (activePipeline && !debouncedSearchTerm) params.set('pipeline_id', activePipeline.id)
        if (debouncedSearchTerm) params.set('search', debouncedSearchTerm)
        if (appliedFormulaType === 'advanced' && appliedFormulaText) {
          params.set('tag_formula', appliedFormulaText)
        } else {
          if (filterTagNames.size > 0) params.set('tag_names', Array.from(filterTagNames).join(','))
          if (excludeFilterTagNames.size > 0) params.set('exclude_tag_names', Array.from(excludeFilterTagNames).join(','))
          if (filterTagNames.size > 0 || excludeFilterTagNames.size > 0) params.set('tag_mode', tagFilterMode)
        }
        if (filterStageIds.size > 0) params.set('stage_ids', Array.from(filterStageIds).join(','))
        filterDeviceIds.forEach(id => params.append('device_ids', id))
        const resolved = resolveDatePreset(filterDatePreset, filterDateFrom, filterDateTo)
        if (resolved) {
          params.set('date_field', filterDateField)
          if (resolved.from) params.set('date_from', resolved.from)
          if (resolved.to) params.set('date_to', resolved.to)
        }
        if (cfFilters.length > 0) params.set('cf_filter', JSON.stringify(cfFilters))
      } else {
        if (activePipeline) params.set('pipeline_id', activePipeline.id)
      }
      params.set('view', 'list')
      params.set('limit', '50000')
      params.set('offset', '0')

      const res = await fetch(`/api/leads/list-paginated?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (!data.success) return

      const allLeads: Lead[] = data.leads || []
      const { utils, writeFile } = await import('xlsx')
      const rows = allLeads.map(l => ({
        'Nombre': l.name || '',
        'Apellido': l.last_name || '',
        'Nombre corto': l.short_name || '',
        'Teléfono': l.phone || '',
        'Email': l.email || '',
        'Empresa': l.company || '',
        'Pipeline': activePipeline?.name || '',
        'Etapa': l.stage_name || '',
        'Etiquetas': (l.structured_tags || []).map((t: any) => t.name).join(', ') || (l.tags || []).join(', '),
        'Archivado': l.is_archived ? 'Sí' : 'No',
        'Bloqueado': l.is_blocked ? 'Sí' : 'No',
        'Creado': format(new Date(l.created_at), 'dd/MM/yyyy HH:mm', { locale: es }),
        'Actualizado': format(new Date(l.updated_at), 'dd/MM/yyyy HH:mm', { locale: es }),
      }))

      if (exportFormat === 'excel') {
        const wb = utils.book_new()
        const ws = utils.json_to_sheet(rows)
        utils.book_append_sheet(wb, ws, 'Leads')
        writeFile(wb, `leads_${format(new Date(), 'yyyy-MM-dd')}.xlsx`)
      } else {
        const ws = utils.json_to_sheet(rows)
        const csv = utils.sheet_to_csv(ws)
        const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `leads_${format(new Date(), 'yyyy-MM-dd')}.csv`
        a.click()
        URL.revokeObjectURL(url)
      }
      setShowExportModal(false)
    } catch (err) {
      console.error('Export failed:', err)
      alert('Error al exportar leads')
    } finally {
      setExporting(false)
    }
  }


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

      // 3. Add ALL matching leads as recipients server-side (not limited by client pagination)
      const filterParams = new URLSearchParams()
      if (activePipeline && !debouncedSearchTerm) filterParams.set('pipeline_id', activePipeline.id)
      if (debouncedSearchTerm) filterParams.set('search', debouncedSearchTerm)
      if (appliedFormulaType === 'advanced' && appliedFormulaText) {
        filterParams.set('tag_formula', appliedFormulaText)
      } else {
        if (filterTagNames.size > 0) filterParams.set('tag_names', Array.from(filterTagNames).join(','))
        if (filterTagNames.size > 0 || excludeFilterTagNames.size > 0) filterParams.set('tag_mode', tagFilterMode)
        if (excludeFilterTagNames.size > 0) filterParams.set('exclude_tag_names', Array.from(excludeFilterTagNames).join(','))
      }
      if (filterStageIds.size > 0) filterParams.set('stage_ids', Array.from(filterStageIds).join(','))
      filterDeviceIds.forEach(id => filterParams.append('device_ids', id))
      const dateRange = resolveDatePreset(filterDatePreset, filterDateFrom, filterDateTo)
      if (dateRange) {
        filterParams.set('date_field', filterDateField)
        if (dateRange.from) filterParams.set('date_from', dateRange.from)
        if (dateRange.to) filterParams.set('date_to', dateRange.to)
      }

      const recipRes = await fetch(`/api/campaigns/${campaignId}/recipients/from-leads?${filterParams}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const recipData = await recipRes.json()
      if (!recipData.success) {
        alert(recipData.error || 'Error al agregar destinatarios')
        return
      }

      // Add spreadsheet recipients if any
      if (formResult.recipients && formResult.recipients.length > 0) {
        const sheetRecipients = formResult.recipients.map(r => ({
          jid: r.phone + '@s.whatsapp.net',
          name: r.name || '',
          phone: r.phone,
          metadata: r.metadata || {},
        }))
        await fetch(`/api/campaigns/${campaignId}/recipients`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ recipients: sheetRecipients }),
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

  // Keep lifecycle views focused: open opportunities use active stages and
  // closed views use only their corresponding terminal result.
  const visibleStages = useMemo(() => stageData.filter(stage => {
    if (hiddenStageIds.has(stage.id)) return false
    if (statusFilter === 'active') return stage.stage_type !== 'won' && stage.stage_type !== 'lost'
    if (statusFilter === 'won') return stage.stage_type === 'won'
    if (statusFilter === 'lost') return stage.stage_type === 'lost'
    return stage.total_count > 0
  }), [stageData, hiddenStageIds, statusFilter])

  // List virtualizer
  const listVirtualizer = useVirtualizer({
    count: listLeads.length,
    getScrollElement: () => listScrollRef.current,
    estimateSize: () => 80,
    overscan: 10,
  })

  useEffect(() => {
    if (viewMode === 'list') listVirtualizer.measure()
  }, [isCompactListWorkspace, viewMode])

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
      <div ref={workspaceRef} className="flex flex-col h-full min-h-0 animate-pulse">
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
    <div ref={workspaceRef} className="flex flex-col h-full min-h-0">
      {/* Row 1: Title + View Toggle + Search + Más */}
      <div className="flex flex-wrap items-center gap-2 py-2 shrink-0 sm:gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <h1 className="text-lg font-bold text-slate-900 whitespace-nowrap">Leads</h1>
          <span className="text-xs text-slate-400 font-medium tabular-nums bg-slate-100 px-2 py-0.5 rounded-full">{(viewMode === 'list' ? listTotal : totalLeadCount).toLocaleString()}</span>
        </div>

        {!selectionMode && (
          <div className="inline-flex items-center border border-slate-200 rounded-lg overflow-hidden">
            <button
              onClick={() => setViewMode('kanban')}
              className={`inline-flex items-center gap-1 px-2 py-1.5 text-xs font-medium transition ${
                viewMode === 'kanban' ? 'bg-emerald-50 text-emerald-700' : 'text-slate-500 hover:bg-slate-50'
              }`}
              title="Vista Kanban"
            >
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setViewMode('list')}
              className={`inline-flex items-center gap-1 px-2 py-1.5 text-xs font-medium transition ${
                viewMode === 'list' ? 'bg-emerald-50 text-emerald-700' : 'text-slate-500 hover:bg-slate-50'
              }`}
              title="Vista Lista"
            >
              <List className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        <div ref={filterDropdownRef} className="relative order-last w-full sm:order-none sm:max-w-lg sm:flex-1">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
            <input
              type="search"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Buscar oportunidades…"
              aria-label="Buscar oportunidades en todos los pipelines"
              className={`h-11 w-full rounded-xl border bg-white pl-9 text-sm text-slate-800 placeholder:text-slate-400 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 ${activeFilterCount > 0 ? 'border-emerald-300 pr-20' : 'border-slate-200 pr-12'}`}
            />
            <button
              type="button"
              onClick={() => showFilterDropdown ? discardFilterDraft() : openFilters()}
              className={`absolute right-1.5 top-1/2 inline-flex h-8 min-w-8 -translate-y-1/2 items-center justify-center gap-1 rounded-lg px-2 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${showFilterDropdown || activeFilterCount > 0 ? 'bg-emerald-100 text-emerald-700' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-700'}`}
              aria-expanded={showFilterDropdown}
              aria-haspopup="dialog"
              aria-label={activeFilterCount > 0 ? `Filtros, ${activeFilterCount} activos` : 'Abrir filtros'}
              title="Filtros"
            >
              <Filter className="h-4 w-4" aria-hidden="true" />
              {activeFilterCount > 0 && <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-emerald-600 px-1.5 text-[10px] font-bold text-white">{activeFilterCount}</span>}
            </button>
          </div>

          {/* Filter Dropdown — Two-Column Layout */}
          {showFilterDropdown && (
            <div
              ref={filterDialogRef}
              className={`app-viewport fixed inset-0 z-[70] flex w-full flex-col rounded-none border border-slate-200/80 bg-white pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] shadow-2xl shadow-slate-900/15 sm:inset-auto sm:h-auto sm:rounded-2xl sm:p-0 ${filterPanelPosition ? 'sm:opacity-100' : 'sm:pointer-events-none sm:opacity-0'}`}
              style={filterPanelPosition ? { left: filterPanelPosition.left, top: filterPanelPosition.top, width: filterPanelPosition.width, maxHeight: filterPanelPosition.maxHeight } : undefined}
              role="dialog"
              aria-modal="true"
              aria-label="Filtros de oportunidades"
            >
              {/* ─── Header ─── */}
              <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-3 py-2">
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
                      onClick={() => { setFilterStageIds(new Set()); setFilterTagNames(new Set()); setExcludeFilterTagNames(new Set()); setFilterDeviceIds(new Set()); setTagFilterMode('OR'); setLeadFormulaType('simple'); setLeadFormulaText(''); setLeadFormulaIsValid(true); setAppliedFormulaType('simple'); setAppliedFormulaText(''); setFilterDateField('created_at'); setFilterDatePreset(''); setFilterDateFrom(''); setFilterDateTo(''); setCfFilters([]) }}
                      className="text-[11px] text-red-400 hover:text-red-600 font-medium transition-colors"
                    >
                      Limpiar todo
                    </button>
                  )}
                  <button onClick={discardFilterDraft} className="inline-flex h-8 w-8 items-center justify-center rounded-lg hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label="Descartar cambios y cerrar filtros">
                    <X className="w-4 h-4 text-slate-400" />
                  </button>
                </div>
              </div>

              {/* ─── Responsive Body: 2 cols when space, 1 col when narrow ─── */}
              <div className={`grid min-h-0 flex-1 grid-cols-1 overflow-y-auto ${cfDefs.length > 0 ? 'md:grid-cols-[210px_180px_minmax(0,1fr)]' : 'md:grid-cols-[220px_minmax(0,1fr)]'}`}>

                {/* ══ Left Column — Selections ══ */}
                <div className="w-full space-y-3 border-b border-slate-100 bg-slate-50/50 p-2.5 md:border-b-0 md:border-r">

                  {/* Stage pills */}
                  {filterableStages.length > 0 && (
                    <div>
                      <div className="mb-2 flex items-center gap-2">
                        <div className="w-1 h-3.5 bg-slate-300 rounded-full" />
                        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Etapas</p>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {filterableStages.map(stage => {
                          const isActive = filterStageIds.has(stage.id)
                          return (
                            <button
                              key={stage.id}
                              onClick={() => {
                                const next = new Set(filterStageIds)
                                if (isActive) next.delete(stage.id); else next.add(stage.id)
                                setFilterStageIds(next)
                              }}
                              className={`inline-flex min-h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                                isActive ? 'border-emerald-300 bg-emerald-50 text-emerald-800 shadow-sm' : 'border-slate-200 text-slate-600 hover:bg-white hover:shadow-sm'
                              }`}
                              aria-pressed={isActive}
                            >
                              <div className="h-2 w-2 rounded-full" style={{ backgroundColor: stage.color }} aria-hidden="true" />
                              {stage.name}
                              {isActive && <CheckCircle2 className="h-3 w-3" aria-hidden="true" />}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* ── Date Filter ── */}
                  <div>
                    <div className="mb-2 flex items-center gap-2">
                      <div className="w-1 h-3.5 bg-blue-400 rounded-full" />
                      <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Fecha</p>
                    </div>
                    {/* Field toggle */}
                    <div className="flex rounded-lg border border-slate-200 bg-slate-50/50 overflow-hidden mb-2">
                      <button
                        onClick={() => setFilterDateField('created_at')}
                        className={`flex-1 px-2 py-1 text-[10px] font-semibold transition-all ${filterDateField === 'created_at' ? 'bg-blue-500 text-white shadow-sm' : 'text-slate-500 hover:bg-white'}`}
                      >
                        Creación
                      </button>
                      <button
                        onClick={() => setFilterDateField('updated_at')}
                        className={`flex-1 px-2 py-1 text-[10px] font-semibold transition-all ${filterDateField === 'updated_at' ? 'bg-blue-500 text-white shadow-sm' : 'text-slate-500 hover:bg-white'}`}
                      >
                        Modificación
                      </button>
                    </div>
                    {/* Preset buttons */}
                    <div className="grid grid-cols-2 gap-1">
                      {DATE_PRESETS.map(p => (
                        <button
                          key={p.key}
                          onClick={() => {
                            if (filterDatePreset === p.key) { setFilterDatePreset(''); setFilterDateFrom(''); setFilterDateTo('') }
                            else { setFilterDatePreset(p.key); if (p.key !== 'custom') { setFilterDateFrom(''); setFilterDateTo('') } }
                          }}
                          className={`rounded-lg border px-2 py-1 text-[10px] font-medium transition-all ${
                            filterDatePreset === p.key
                              ? 'bg-blue-500 text-white border-blue-500 shadow-sm'
                              : 'border-slate-200 text-slate-600 hover:bg-white hover:shadow-sm'
                          }`}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                    {/* Custom date range inputs */}
                    {filterDatePreset === 'custom' && (
                      <div className="mt-2 space-y-1.5">
                        <div>
                          <label className="text-[9px] font-semibold text-slate-400 uppercase">Desde</label>
                          <input
                            type="date"
                            value={filterDateFrom}
                            onChange={e => setFilterDateFrom(e.target.value)}
                            className="w-full px-2 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400"
                          />
                        </div>
                        <div>
                          <label className="text-[9px] font-semibold text-slate-400 uppercase">Hasta</label>
                          <input
                            type="date"
                            value={filterDateTo}
                            onChange={e => setFilterDateTo(e.target.value)}
                            className="w-full px-2 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400"
                          />
                        </div>
                      </div>
                    )}
                    {/* Active date chip */}
                    {filterDatePreset && filterDatePreset !== 'custom' && (
                      <div className="mt-2 flex items-center gap-1">
                        <Clock className="w-3 h-3 text-blue-500" />
                        <span className="text-[10px] font-medium text-blue-600">{DATE_PRESETS.find(p => p.key === filterDatePreset)?.label}</span>
                        <button onClick={() => { setFilterDatePreset(''); setFilterDateFrom(''); setFilterDateTo('') }} className="ml-auto p-0.5 hover:bg-slate-100 rounded">
                          <X className="w-2.5 h-2.5 text-slate-400" />
                        </button>
                      </div>
                    )}
                  </div>

                  {devices.length > 0 && (
                    <div>
                      <div className="mb-2 flex items-center gap-2">
                        <div className="h-3.5 w-1 rounded-full bg-violet-400" />
                        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Dispositivo</p>
                      </div>
                      <div className="space-y-1">
                        {devices.map(device => (
                          <label key={device.id} className="flex min-h-8 cursor-pointer items-center gap-2 rounded-lg px-2 text-xs text-slate-700 hover:bg-white">
                            <input
                              type="checkbox"
                              checked={filterDeviceIds.has(device.id)}
                              onChange={() => setFilterDeviceIds(current => {
                                const next = new Set(current)
                                if (next.has(device.id)) next.delete(device.id)
                                else next.add(device.id)
                                return next
                              })}
                              className="h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                            />
                            <span className="truncate">{device.name || device.phone || 'Dispositivo'}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Active tag selections */}
                  {allUniqueTags.length > 0 && (
                    <div>
                      <div className="mb-2 flex items-center gap-2">
                        <div className="w-1 h-3.5 bg-emerald-400 rounded-full" />
                        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Selección</p>
                      </div>

                      {filterTagNames.size === 0 && excludeFilterTagNames.size === 0 ? (
                        <div className="rounded-xl border-2 border-dashed border-slate-200 p-3 text-center">
                          <Tag className="w-5 h-5 text-slate-300 mx-auto mb-1.5" />
                          <p className="text-[11px] text-slate-400">Haz click en las etiquetas para filtrar</p>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {/* Include chips */}
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
                                    <span
                                      key={name}
                                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium text-white shadow-sm"
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
                            </div>
                          )}
                          {/* Exclude chips */}
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
                                    <span
                                      key={name}
                                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium text-white/90 line-through shadow-sm"
                                      style={{ backgroundColor: tag?.color || '#6b7280' }}
                                    >
                                      {name}
                                      <button onClick={() => { const next = new Set(excludeFilterTagNames); next.delete(name); setExcludeFilterTagNames(next) }} className="hover:opacity-75 no-underline">
                                        <X className="w-2.5 h-2.5" />
                                      </button>
                                    </span>
                                  )
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Click instructions */}
                      <div className="mt-2 border-t border-slate-100 pt-2">
                        <div className="space-y-1">
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
                    </div>
                  )}
                </div>

                {/* ══ Center Column — Custom Fields ══ */}
                {cfDefs.length > 0 && (
                <div className="w-full space-y-3 border-b border-slate-100 p-2.5 md:border-b-0 md:border-r">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-1 h-3.5 bg-violet-400 rounded-full" />
                      <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Campos</p>
                    </div>
                    <button
                      onClick={() => setCfFilters(prev => [...prev, { field_id: cfDefs[0].id, operator: 'eq' as const, value: '' }])}
                      className="p-1 hover:bg-violet-50 rounded-lg transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5 text-violet-500" />
                    </button>
                  </div>
                  {cfFilters.length === 0 && (
                    <p className="text-[10px] text-slate-400 text-center py-2">Sin filtros de campos</p>
                  )}
                  {cfFilters.map((cf, idx) => {
                    const def = cfDefs.find(d => d.id === cf.field_id)
                    const fieldType = def?.field_type || 'text'
                    const ops: { value: string; label: string }[] = (() => {
                      switch (fieldType) {
                        case 'number': case 'currency':
                          return [{ value: 'eq', label: '=' }, { value: 'neq', label: '≠' }, { value: 'gt', label: '>' }, { value: 'lt', label: '<' }, { value: 'gte', label: '≥' }, { value: 'lte', label: '≤' }, { value: 'is_empty', label: 'Vacío' }, { value: 'is_not_empty', label: 'No vacío' }]
                        case 'date':
                          return [{ value: 'eq', label: '=' }, { value: 'gt', label: 'Después' }, { value: 'lt', label: 'Antes' }, { value: 'is_empty', label: 'Vacío' }, { value: 'is_not_empty', label: 'No vacío' }]
                        case 'checkbox':
                          return [{ value: 'eq', label: '=' }]
                        case 'select':
                          return [{ value: 'eq', label: '=' }, { value: 'neq', label: '≠' }, { value: 'is_empty', label: 'Vacío' }, { value: 'is_not_empty', label: 'No vacío' }]
                        case 'multi_select':
                          return [{ value: 'contains_any', label: 'Contiene' }, { value: 'contains_all', label: 'Contiene todos' }, { value: 'is_empty', label: 'Vacío' }, { value: 'is_not_empty', label: 'No vacío' }]
                        default:
                          return [{ value: 'eq', label: '=' }, { value: 'neq', label: '≠' }, { value: 'contains', label: 'Contiene' }, { value: 'starts_with', label: 'Empieza' }, { value: 'is_empty', label: 'Vacío' }, { value: 'is_not_empty', label: 'No vacío' }]
                      }
                    })()
                    const needsValue = cf.operator !== 'is_empty' && cf.operator !== 'is_not_empty'
                    return (
                      <div key={idx} className="space-y-1 p-2 bg-slate-50 rounded-lg border border-slate-100">
                        <div className="flex items-center gap-1">
                          <select
                            value={cf.field_id}
                            onChange={(e) => {
                              const next = [...cfFilters]
                              next[idx] = { ...next[idx], field_id: e.target.value, value: '' }
                              setCfFilters(next)
                            }}
                            className="flex-1 min-w-0 px-1.5 py-1 bg-white border border-slate-200 rounded text-[10px] text-slate-700 focus:ring-1 focus:ring-violet-400"
                          >
                            {cfDefs.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                          </select>
                          <button onClick={() => setCfFilters(prev => prev.filter((_, i) => i !== idx))} className="p-0.5 hover:bg-red-50 rounded">
                            <X className="w-3 h-3 text-red-400" />
                          </button>
                        </div>
                        <select
                          value={cf.operator}
                          onChange={(e) => {
                            const next = [...cfFilters]
                            next[idx] = { ...next[idx], operator: e.target.value as CustomFieldFilter['operator'], value: '' }
                            setCfFilters(next)
                          }}
                          className="w-full px-1.5 py-1 bg-white border border-slate-200 rounded text-[10px] text-slate-700 focus:ring-1 focus:ring-violet-400"
                        >
                          {ops.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                        {needsValue && fieldType === 'checkbox' && (
                          <select
                            value={String(cf.value)}
                            onChange={(e) => {
                              const next = [...cfFilters]
                              next[idx] = { ...next[idx], value: e.target.value === 'true' }
                              setCfFilters(next)
                            }}
                            className="w-full px-1.5 py-1 bg-white border border-slate-200 rounded text-[10px] text-slate-700 focus:ring-1 focus:ring-violet-400"
                          >
                            <option value="true">Sí</option>
                            <option value="false">No</option>
                          </select>
                        )}
                        {needsValue && (fieldType === 'select' || fieldType === 'multi_select') && def?.config?.options && (
                          <select
                            value={String(cf.value)}
                            onChange={(e) => {
                              const next = [...cfFilters]
                              next[idx] = { ...next[idx], value: e.target.value }
                              setCfFilters(next)
                            }}
                            className="w-full px-1.5 py-1 bg-white border border-slate-200 rounded text-[10px] text-slate-700 focus:ring-1 focus:ring-violet-400"
                          >
                            <option value="">Seleccionar...</option>
                            {def.config.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        )}
                        {needsValue && fieldType === 'date' && (
                          <input
                            type="date"
                            value={String(cf.value || '')}
                            onChange={(e) => {
                              const next = [...cfFilters]
                              next[idx] = { ...next[idx], value: e.target.value }
                              setCfFilters(next)
                            }}
                            className="w-full px-1.5 py-1 bg-white border border-slate-200 rounded text-[10px] text-slate-700 focus:ring-1 focus:ring-violet-400"
                          />
                        )}
                        {needsValue && !['checkbox', 'select', 'multi_select', 'date'].includes(fieldType) && (
                          <input
                            type={fieldType === 'number' || fieldType === 'currency' ? 'number' : 'text'}
                            value={String(cf.value || '')}
                            onChange={(e) => {
                              const next = [...cfFilters]
                              next[idx] = { ...next[idx], value: fieldType === 'number' || fieldType === 'currency' ? (e.target.value ? Number(e.target.value) : '') : e.target.value }
                              setCfFilters(next)
                            }}
                            placeholder="Valor..."
                            className="w-full px-1.5 py-1 bg-white border border-slate-200 rounded text-[10px] text-slate-700 placeholder:text-slate-400 focus:ring-1 focus:ring-violet-400"
                          />
                        )}
                      </div>
                    )
                  })}
                </div>
                )}

                {/* ══ Right Column — Tag Browser ══ */}
                <div className="flex-1 flex flex-col min-w-0 min-h-0 w-full sm:w-auto">

                  {allUniqueTags.length > 0 && (
                    <>
                      {/* Top controls — shrink-0 */}
                      <div className="shrink-0 space-y-2 p-2.5 pb-0">
                        {/* Simple / Advanced tabs */}
                        <div className="flex overflow-hidden rounded-lg border border-slate-200 bg-slate-50/50" role="tablist" aria-label="Modo de filtrado por etiquetas">
                          <button type="button"
                            onClick={() => setLeadFormulaType('simple')}
                            role="tab"
                            aria-selected={leadFormulaType === 'simple'}
                            className={`flex min-h-9 flex-1 items-center justify-center gap-1.5 px-3 text-[11px] font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500 ${
                              leadFormulaType === 'simple'
                                ? 'bg-emerald-500 text-white shadow-sm'
                                : 'text-slate-500 hover:bg-white hover:text-slate-700'
                            }`}>
                            <FileText className="w-3.5 h-3.5" />
                            Simple
                          </button>
                          <button type="button"
                            onClick={() => setLeadFormulaType('advanced')}
                            role="tab"
                            aria-selected={leadFormulaType === 'advanced'}
                            className={`flex min-h-9 flex-1 items-center justify-center gap-1.5 px-3 text-[11px] font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500 ${
                              leadFormulaType === 'advanced'
                                ? 'bg-violet-500 text-white shadow-sm'
                                : 'text-slate-500 hover:bg-white hover:text-slate-700'
                            }`}>
                            <Code className="w-3.5 h-3.5" />
                            Avanzado
                          </button>
                        </div>

                        {/* ─── SIMPLE MODE controls ─── */}
                        {leadFormulaType === 'simple' && (
                          <>
                            <div className="flex items-center gap-3">
                              <div className="inline-flex overflow-hidden rounded-lg border border-slate-200" role="radiogroup" aria-label="Coincidencia de etiquetas incluidas">
                                <button
                                  type="button"
                                  onClick={() => setTagFilterMode('OR')}
                                  role="radio"
                                  aria-checked={tagFilterMode === 'OR'}
                                  className={`min-h-8 px-3 text-[10px] font-bold tracking-wide transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500 ${
                                    tagFilterMode === 'OR' ? 'bg-emerald-500 text-white' : 'bg-white text-slate-400 hover:bg-slate-50'
                                  }`}>
                                  Cualquiera
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setTagFilterMode('AND')}
                                  role="radio"
                                  aria-checked={tagFilterMode === 'AND'}
                                  className={`min-h-8 px-3 text-[10px] font-bold tracking-wide transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 ${
                                    tagFilterMode === 'AND' ? 'bg-blue-500 text-white' : 'bg-white text-slate-400 hover:bg-slate-50'
                                  }`}>
                                  Todas
                                </button>
                              </div>
                              <p className="text-[10px] text-slate-400 leading-tight">
                                {tagFilterMode === 'AND' ? 'Debe tener TODAS las incluidas' : 'Debe tener al menos UNA incluida'}
                                {excludeFilterTagNames.size > 0 ? ' y NINGUNA excluida' : ''}
                              </p>
                            </div>
                            <div className="relative">
                              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                              <input
                                type="text"
                                value={tagSearchTerm}
                                onChange={(e) => setTagSearchTerm(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault() }}
                                placeholder="Buscar etiquetas... (% = comodín)"
                                className="w-full rounded-lg border border-slate-200 bg-white py-1.5 pl-9 pr-3 text-xs text-slate-800 placeholder:text-slate-400 transition-all focus:border-emerald-400 focus:ring-2 focus:ring-emerald-500/30"
                              />
                            </div>
                          </>
                        )}
                      </div>

                      {/* ─── SIMPLE MODE — Tag list (scrollable, fills space) ─── */}
                      {leadFormulaType === 'simple' && (
                        <div className="min-h-0 flex-1 p-2.5 pt-2">
                          <div className="flex flex-wrap gap-1.5">
                            {filteredTags.map(tag => {
                              const isIncluded = filterTagNames.has(tag.name)
                              const isExcluded = excludeFilterTagNames.has(tag.name)
                              const count = tagLeadCounts.get(tag.name) || 0
                              return (
                                <button
                                  key={tag.id}
                                  type="button"
                                  onClick={() => {
                                    const include = new Set(filterTagNames)
                                    const exclude = new Set(excludeFilterTagNames)
                                    if (!isIncluded && !isExcluded) {
                                      include.add(tag.name)
                                    } else if (isIncluded) {
                                      include.delete(tag.name)
                                      exclude.add(tag.name)
                                    } else {
                                      exclude.delete(tag.name)
                                    }
                                    setFilterTagNames(include)
                                    setExcludeFilterTagNames(exclude)
                                  }}
                                  className={`inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${
                                    isIncluded
                                      ? 'border-emerald-600 bg-emerald-600 text-white shadow-sm focus-visible:ring-emerald-500'
                                      : isExcluded
                                        ? 'border-red-600 bg-red-600 text-white shadow-sm line-through decoration-white/80 focus-visible:ring-red-500'
                                        : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50 hover:shadow-sm focus-visible:ring-emerald-500'
                                  }`}
                                  aria-label={`${tag.name}: ${isIncluded ? 'incluida; activar para excluir' : isExcluded ? 'excluida; activar para quitar' : 'sin filtro; activar para incluir'}`}
                                >
                                  {isIncluded ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> : isExcluded ? <XCircle className="h-3.5 w-3.5 shrink-0" /> : <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} />}
                                  <span className="min-w-0 truncate">{tag.name}</span>
                                  <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] tabular-nums ${isIncluded || isExcluded ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-400'}`}>{count}</span>
                                </button>
                              )
                            })}
                            {filteredTags.length === 0 && tagSearchTerm.trim() && (
                              <div className="text-center py-6">
                                <Search className="w-5 h-5 text-slate-300 mx-auto mb-1.5" />
                                <p className="text-xs text-slate-400">Sin resultados para &quot;{tagSearchTerm}&quot;</p>
                              </div>
                            )}
                          </div>
                          {filteredTags.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 border-t border-slate-100 pt-2 text-[10px] text-slate-400">
                              <span><strong className="text-emerald-600">1 clic</strong> incluir</span>
                              <span><strong className="text-red-600">2 clics</strong> excluir</span>
                              <span><strong className="text-slate-500">3 clics</strong> quitar</span>
                            </div>
                          )}
                        </div>
                      )}

                      {/* ─── ADVANCED MODE ─── */}
                      {leadFormulaType === 'advanced' && (
                        <div className="min-h-0 flex-1 space-y-2 p-2.5">
                          <div className="rounded-xl border border-slate-100 bg-slate-50 p-2">
                            <div className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">Sintaxis</div>
                            <div className="grid grid-cols-2 gap-1 text-[10px] text-slate-600">
                              <div><code className="text-violet-600 bg-violet-50 px-1 py-0.5 rounded">&quot;etiqueta&quot;</code> exacta</div>
                              <div><code className="text-violet-600 bg-violet-50 px-1 py-0.5 rounded">&quot;mar%&quot;</code> comodín</div>
                              <div><code className="text-violet-600 bg-violet-50 px-1 py-0.5 rounded">and</code> <code className="text-violet-600 bg-violet-50 px-1 py-0.5 rounded">or</code> <code className="text-violet-600 bg-violet-50 px-1 py-0.5 rounded">not</code></div>
                              <div><code className="text-violet-600 bg-violet-50 px-1 py-0.5 rounded">in ( )</code> agrupar lista</div>
                            </div>
                          </div>
                          <FormulaEditor
                            value={leadFormulaText}
                            onChange={setLeadFormulaText}
                            tags={allUniqueTags}
                            compact
                            rows={5}
                            onValidChange={setLeadFormulaIsValid}
                          />
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

              {/* ─── Footer — Aplicar ─── */}
              <div className="flex shrink-0 items-center gap-2 rounded-b-2xl border-t border-slate-100 bg-white px-3 py-2">
                <button
                  type="button"
                  onClick={discardFilterDraft}
                  className="min-h-10 rounded-xl border border-slate-200 px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                >
                  Cancelar
                </button>
                <button
                  onClick={() => {
                    setAppliedFormulaType(leadFormulaType)
                    setAppliedFormulaText(leadFormulaType === 'advanced' ? leadFormulaText : '')
                    filterSnapshotRef.current = null
                    setShowFilterDropdown(false)
                  }}
                  disabled={leadFormulaType === 'advanced' && !leadFormulaIsValid}
                  className="min-h-10 flex-1 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white shadow-sm shadow-emerald-200 transition-all hover:bg-emerald-700 hover:shadow-md hover:shadow-emerald-200 active:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Aplicar
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Actions area */}
        <div className={`flex min-w-0 items-center gap-2 shrink-0 ${selectionMode ? 'w-full overflow-x-auto pb-1 sm:w-auto sm:overflow-visible sm:pb-0' : 'ml-auto'}`}>
          {selectionMode ? (
            <>
              <span className="flex items-center px-2 py-1.5 text-xs text-slate-500 font-medium whitespace-nowrap">
                {selectedIds.size} sel.
              </span>
              <button onClick={selectAll} className="min-h-10 px-3 text-xs border border-slate-200 rounded-xl hover:bg-slate-50 text-slate-600 font-medium">
                Todos
              </button>
              {statusFilter === 'trash' && (
                <button onClick={handleRestoreSelected} disabled={selectedIds.size === 0 || deleting} className="inline-flex min-h-10 items-center gap-1.5 rounded-xl bg-emerald-600 px-3 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"><ArchiveRestore className="h-3.5 w-3.5" />Restaurar</button>
              )}
              {statusFilter === 'active' && (
                <button
                  onClick={() => openArchiveModal(null, true)}
                  disabled={selectedIds.size === 0 || deleting}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs bg-amber-500 text-white rounded-lg hover:bg-amber-600 disabled:opacity-50 font-medium"
                >
                  <Archive className="w-3 h-3" />
                  Archivar
                </button>
              )}
              {statusFilter === 'archived' && (
                <button
                  onClick={() => handleArchiveSelectedBatch(false)}
                  disabled={selectedIds.size === 0 || deleting}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 font-medium"
                >
                  <ArchiveRestore className="w-3 h-3" />
                  Restaurar
                </button>
              )}
              {statusFilter !== 'blocked' && statusFilter !== 'trash' && (
                <button
                  onClick={() => openBlockModal(null, true)}
                  disabled={selectedIds.size === 0 || deleting}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 font-medium"
                >
                  <ShieldBan className="w-3 h-3" />
                  No contactar
                </button>
              )}
              {statusFilter === 'blocked' && (
                <button
                  onClick={() => handleBlockSelectedBatch(false)}
                  disabled={selectedIds.size === 0 || deleting}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 font-medium"
                >
                  <ShieldOff className="w-3 h-3" />
                  Permitir contacto
                </button>
              )}
              {googleConnected && statusFilter !== 'trash' && (
                <>
                  <button
                    onClick={handleGoogleBatchSyncFromLeads}
                    disabled={selectedIds.size === 0 || selectedIds.size > 30 || googleSyncing}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium"
                  >
                    {googleSyncing ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
                    Sync
                  </button>
                  <button
                    onClick={handleGoogleBatchDesyncFromLeads}
                    disabled={selectedIds.size === 0 || selectedIds.size > 30 || googleSyncing}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50 disabled:opacity-50 font-medium"
                  >
                    <XCircle className="w-3 h-3" />
                    Desync
                  </button>
                </>
              )}
              {statusFilter !== 'trash' && <button
                onClick={handleDeleteSelected}
                disabled={selectedIds.size === 0 || deleting}
                className="px-2.5 py-1.5 text-xs bg-red-800 text-white rounded-lg hover:bg-red-900 disabled:opacity-50 font-medium"
              >
                {deleting ? '...' : `Papelera (${selectedIds.size})`}
              </button>}
              <button
                onClick={() => { setSelectionMode(false); setSelectedIds(new Set()) }}
                className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-300 text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-700"
                title="Cancelar selección"
              >
                <X className="w-4 h-4" />
              </button>
            </>
          ) : (
            <div ref={moreMenuRef} className="relative">
              <button
                onClick={() => setShowMoreMenu(v => !v)}
                className={`inline-flex min-h-11 items-center gap-1.5 px-3 py-1.5 border rounded-lg text-sm transition-colors ${
                  showMoreMenu ? 'border-slate-400 bg-slate-100 text-slate-700' : 'border-slate-300 hover:bg-slate-50 text-slate-600'
                }`}
                title="Más acciones"
              >
                <MoreHorizontal className="w-4 h-4" />
                <span className="hidden sm:inline">Más</span>
                <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showMoreMenu ? 'rotate-180' : ''}`} />
              </button>
              {showMoreMenu && (
                  <div className="fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-[80] max-h-[75vh] overflow-y-auto rounded-2xl border border-slate-200 bg-white py-1 shadow-2xl sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:top-full sm:mt-1.5 sm:w-56 sm:rounded-xl sm:shadow-xl">
                  <button
                    onClick={() => { setShowAddModal(true); setShowMoreMenu(false) }}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-emerald-700 font-medium hover:bg-emerald-50 transition-colors"
                  >
                    <Plus className="w-4 h-4 text-emerald-500" />
                    Nueva oportunidad
                  </button>
                  <button
                    onClick={() => { fetchDevices(); setShowBroadcastModal(true); setShowMoreMenu(false) }}
                    disabled={totalLeadCount === 0}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Radio className="w-4 h-4 text-slate-400" />
                    Masivo
                  </button>
                  <div className="my-1 border-t border-slate-100" />
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
                    Gestionar etapas
                  </button>
                  <div className="my-1 border-t border-slate-100" />
                  <button
                    onClick={() => { setShowImportModal(true); setShowMoreMenu(false) }}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
                  >
                    <Upload className="w-4 h-4 text-slate-400" />
                    Importar Excel
                  </button>
                  <button
                    onClick={() => { setShowContactImportModal(true); setShowMoreMenu(false) }}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
                  >
                    <UserPlus className="w-4 h-4 text-slate-400" />
                    Crear desde contactos
                  </button>
                  <button
                    onClick={() => { setShowExportModal(true); setShowMoreMenu(false) }}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
                  >
                    <Download className="w-4 h-4 text-slate-400" />
                    Exportar oportunidades
                  </button>
                  <button
                    onClick={() => { setShowBulkDocModal(true); setShowMoreMenu(false) }}
                    disabled={(viewMode === 'list' ? listLeads : allLoadedLeads).length === 0}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <FileText className="w-4 h-4 text-slate-400" />
                    Generar Documentos
                  </button>
                  <div className="my-1 border-t border-slate-100" />
                  <button
                    onClick={() => { setShowCreateEventModal(true); setShowMoreMenu(false) }}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-emerald-700 hover:bg-emerald-50 transition-colors"
                  >
                    <Calendar className="w-4 h-4 text-emerald-500" />
                    Crear evento desde oportunidades
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {resultsError && (
        <div className="mb-2 flex shrink-0 items-center gap-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800" role="alert">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">{resultsError}</span>
          <button type="button" onClick={() => viewMode === 'list' ? fetchListLeads(true) : fetchLeadsPaginated()} className="min-h-10 rounded-xl bg-white px-3 font-semibold text-red-700 ring-1 ring-red-200 hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500">Reintentar</button>
        </div>
      )}
      <p className="sr-only" aria-live="polite">{viewMode === 'list' ? listTotal : totalLeadCount} oportunidades encontradas.</p>

      {/* Row 2: Status tabs + Pipeline selector */}
      <div className="mb-2 flex shrink-0 items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pb-1">
        <div className="flex items-center gap-1" role="tablist" aria-label="Ciclo de vida de las oportunidades">
        <button
          onClick={() => setStatusFilter('active')}
          role="tab"
          aria-selected={statusFilter === 'active'}
          className={`inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl px-3 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
            statusFilter === 'active'
              ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
              : 'text-slate-500 hover:bg-slate-50'
          }`}
        >
          Abiertas
          <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${
            statusFilter === 'active' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'
          }`}>{leadCounts.active}</span>
        </button>
        <button onClick={() => setStatusFilter('won')} role="tab" aria-selected={statusFilter === 'won'} className={`inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl px-3 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${statusFilter === 'won' ? 'bg-emerald-600 text-white shadow-sm' : 'text-slate-500 hover:bg-slate-50'}`}>
          <CheckCircle2 className="h-3.5 w-3.5" />Ganadas
          {leadCounts.won > 0 && <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${statusFilter === 'won' ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-500'}`}>{leadCounts.won}</span>}
        </button>
        <button onClick={() => setStatusFilter('lost')} role="tab" aria-selected={statusFilter === 'lost'} className={`inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl px-3 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 ${statusFilter === 'lost' ? 'bg-red-600 text-white shadow-sm' : 'text-slate-500 hover:bg-slate-50'}`}>
          <XCircle className="h-3.5 w-3.5" />Perdidas
          {leadCounts.lost > 0 && <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${statusFilter === 'lost' ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-500'}`}>{leadCounts.lost}</span>}
        </button>
        <button
          onClick={() => setStatusFilter('archived')}
          role="tab"
          aria-selected={statusFilter === 'archived'}
          className={`inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl px-3 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${
            statusFilter === 'archived'
              ? 'bg-amber-50 text-amber-700 ring-1 ring-amber-200'
              : 'text-slate-500 hover:bg-slate-50'
          }`}
        >
          <Archive className="w-3 h-3" />
          Archivados
          {leadCounts.archived > 0 && (
            <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${
              statusFilter === 'archived' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500'
            }`}>{leadCounts.archived}</span>
          )}
        </button>
        <button onClick={() => setStatusFilter('trash')} role="tab" aria-selected={statusFilter === 'trash'} className={`inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl px-3 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 ${statusFilter === 'trash' ? 'bg-slate-700 text-white shadow-sm' : 'text-slate-500 hover:bg-slate-50'}`}>
          <Trash2 className="h-3.5 w-3.5" />Papelera
          {leadCounts.trash > 0 && <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${statusFilter === 'trash' ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-500'}`}>{leadCounts.trash}</span>}
        </button>
        </div>
        <div className="mx-1 h-7 w-px shrink-0 bg-slate-200" aria-hidden="true" />
        <div role="group" aria-label="Preferencia de comunicación">
          <button
            type="button"
            onClick={() => setStatusFilter('blocked')}
            aria-pressed={statusFilter === 'blocked'}
            title="Filtro transversal: puede incluir oportunidades abiertas, ganadas, perdidas o archivadas"
            className={`inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl px-3 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 ${
              statusFilter === 'blocked'
                ? 'bg-red-50 text-red-700 ring-1 ring-red-200'
                : 'text-slate-500 hover:bg-slate-50'
            }`}
          >
            <ShieldBan className="h-3.5 w-3.5" />
            No contactables
            {leadCounts.blocked > 0 && <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${statusFilter === 'blocked' ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-500'}`}>{leadCounts.blocked}</span>}
          </button>
        </div>
        </div>
        <div className="relative shrink-0">
          <Building2 className={`pointer-events-none absolute left-3 top-1/2 z-10 h-3.5 w-3.5 -translate-y-1/2 ${debouncedSearchTerm ? 'text-blue-600' : 'text-slate-500'}`} aria-hidden="true" />
          <select
            value={debouncedSearchTerm ? '__all__' : activePipeline?.id || '__no_pipeline__'}
            disabled={Boolean(debouncedSearchTerm)}
            onChange={event => {
              const pipelineId = event.target.value
              if (pipelineId === '__no_pipeline__') {
                setActivePipeline({ id: '__no_pipeline__', name: 'Sin pipeline', is_default: false, stages: [] })
                return
              }
              const pipeline = pipelines.find(item => item.id === pipelineId)
              if (pipeline) setActivePipeline(pipeline)
            }}
            className={`min-h-10 max-w-[210px] appearance-none truncate rounded-xl border py-2 pl-8 pr-8 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:cursor-not-allowed ${debouncedSearchTerm ? 'border-blue-200 bg-blue-50 text-blue-700 opacity-100' : 'border-slate-200 bg-white text-slate-700 hover:border-emerald-300 hover:bg-emerald-50'}`}
            title={debouncedSearchTerm ? 'La búsqueda consulta todos los pipelines' : 'Cambiar pipeline'}
            aria-label="Seleccionar pipeline"
          >
            {debouncedSearchTerm && <option value="__all__">Todos los pipelines</option>}
            {!debouncedSearchTerm && pipelines.map(pipeline => <option key={pipeline.id} value={pipeline.id}>{pipeline.name}</option>)}
            {!debouncedSearchTerm && <option value="__no_pipeline__">Sin pipeline</option>}
          </select>
          <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" aria-hidden="true" />
        </div>
      </div>

      {/* Hidden leads banner */}
      {hiddenByStatus > 0 && (
        <div className="flex items-center gap-2 px-3 py-1.5 mb-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">
          <EyeOff className="w-3.5 h-3.5 shrink-0" />
          <span>
            {hiddenByStatus} oportunidad{hiddenByStatus !== 1 ? 'es' : ''} coinciden con los filtros, pero pertenecen a otra vista del ciclo de vida.
          </span>
        </div>
      )}

      {/* Pipeline Kanban — Virtualized */}
      {viewMode === 'kanban' && (
      <div className="relative flex flex-1 min-h-0 flex-col">
      {statusFilter === 'active' && draggedLeadId && terminalStages.length > 0 && (
        <div className="pointer-events-none absolute inset-x-4 top-3 z-40 mx-auto grid max-w-xl gap-2 sm:grid-cols-2" aria-label="Destinos para cerrar un lead">
          {terminalStages.map(stage => {
            const won = stage.stage_type === 'won'
            const activeDrop = dragOverColumn === stage.id
            return (
              <div
                key={stage.id}
                onDragOver={event => handleDragOver(event, stage.id)}
                onDragLeave={handleDragLeave}
                onDrop={event => handleDrop(event, stage.id)}
                className={`pointer-events-auto flex min-h-12 items-center justify-center gap-2 rounded-2xl border px-4 text-xs font-bold shadow-xl backdrop-blur-sm transition ${won ? 'border-emerald-300 bg-emerald-50/95 text-emerald-800' : 'border-red-300 bg-red-50/95 text-red-800'} ${activeDrop ? 'scale-[1.02] ring-2 ring-offset-2 ' + (won ? 'ring-emerald-400' : 'ring-red-400') : ''}`}
              >
                {won ? <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> : <XCircle className="h-4 w-4" aria-hidden="true" />}
                Suelta para marcar como {won ? 'ganado' : 'perdido'}
              </div>
            )
          })}
        </div>
      )}
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
              onRestore={handleRestoreLead}
              onLifecycleAction={requestLifecycleAction}
              stageOptions={allStages}
              onStageChange={requestLeadStageChange}
              isTrash={statusFilter === 'trash'}
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
              onRestore={handleRestoreLead}
              onLifecycleAction={requestLifecycleAction}
              stageOptions={allStages}
              onStageChange={requestLeadStageChange}
              isTrash={statusFilter === 'trash'}
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
          {/* Cross-pipeline search indicator */}
          {debouncedSearchTerm && (
            <div className="flex-shrink-0 bg-emerald-50 border-b border-emerald-100 px-4 py-1.5 flex items-center gap-2 text-xs text-emerald-700">
              <Search className="w-3 h-3" />
              <span>Buscando en todos los pipelines · <strong>{listTotal}</strong> resultado{listTotal !== 1 ? 's' : ''}</span>
            </div>
          )}
          {/* Sticky header */}
          {!isCompactListWorkspace && <div className="flex-shrink-0 border-b-2 border-slate-200 bg-slate-50">
            <div className="flex">
              {selectionMode && (
                <div className="px-2 py-2.5 w-[36px] flex items-center justify-center">
                  <button
                    onClick={() => {
                      if (selectedIds.size === listLeads.length) {
                        setSelectedIds(new Set())
                      } else {
                        setSelectedIds(new Set(listLeads.map(l => l.id)))
                      }
                    }}
                    className="p-0.5"
                    title={selectedIds.size === listLeads.length ? 'Deseleccionar todos' : 'Seleccionar todos'}
                  >
                    {selectedIds.size > 0 && selectedIds.size === listLeads.length ? (
                      <CheckSquare className="w-4 h-4 text-emerald-600" />
                    ) : selectedIds.size > 0 ? (
                      <MinusSquare className="w-4 h-4 text-emerald-400" />
                    ) : (
                      <Square className="w-4 h-4 text-slate-300" />
                    )}
                  </button>
                </div>
              )}
              <div className="px-3 py-2.5 text-[11px] font-semibold text-slate-500 uppercase tracking-wider w-[220px]">Lead</div>
              <div className="px-3 py-2.5 text-[11px] font-semibold text-slate-500 uppercase tracking-wider w-[110px]">Etapa</div>
              <div className="px-3 py-2.5 text-[11px] font-semibold text-slate-500 uppercase tracking-wider w-[180px]">Etiquetas</div>
              {cfDefs.filter(d => cfVisibleIds.has(d.id)).sort((a, b) => a.sort_order - b.sort_order).map(def => (
                <div key={def.id} className="px-3 py-2.5 text-[11px] font-semibold text-slate-500 uppercase tracking-wider w-[140px] truncate">{def.name}</div>
              ))}
              <div className="px-3 py-2.5 text-[11px] font-semibold text-slate-500 uppercase tracking-wider flex-1">Últimas observaciones</div>
              {!selectionMode && (
                <div className="px-3 py-2.5 w-[40px] relative" ref={cfColumnPickerRef}>
                  {cfDefs.length > 0 && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setShowCfColumnPicker(!showCfColumnPicker) }}
                      className={`p-1 rounded hover:bg-slate-100 transition ${showCfColumnPicker || cfVisibleIds.size > 0 ? 'text-emerald-600' : 'text-slate-400'}`}
                      title="Columnas personalizadas"
                    >
                      <Settings className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {showCfColumnPicker && (
                    <div className="absolute right-0 top-full mt-1 w-56 bg-white border border-slate-200 rounded-xl shadow-xl z-30 py-2 max-h-64 overflow-y-auto">
                      <div className="px-3 py-1.5 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Campos personalizados</div>
                      {cfDefs.sort((a, b) => a.sort_order - b.sort_order).map(def => (
                        <label key={def.id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-50 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={cfVisibleIds.has(def.id)}
                            onChange={() => toggleCfColumn(def.id)}
                            className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                          />
                          <span className="text-sm text-slate-700 truncate">{def.name}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>}
          {/* Virtualized rows */}
          <div ref={listScrollRef} className={`min-h-0 flex-1 overflow-y-auto ${isCompactListWorkspace ? 'overflow-x-hidden' : 'overflow-x-auto'}`}>
            {listLeads.length > 0 ? (
              <div style={{ height: listVirtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
                {listVirtualizer.getVirtualItems().map((virtualRow) => {
                  const lead = listLeads[virtualRow.index]
                  const stageName = lead.stage_name || allStages.find(s => s.id === lead.stage_id)?.name
                  const stageColor = lead.stage_color || allStages.find(s => s.id === lead.stage_id)?.color || '#94a3b8'
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
                        className={`group relative flex cursor-pointer items-stretch transition-all duration-150 hover:bg-emerald-50/40 hover:shadow-sm ${isCompactListWorkspace ? 'mx-1 mb-2 flex-col rounded-xl border border-slate-200/80 bg-white shadow-sm' : 'm-0 flex-row items-start rounded-none border-x-0 border-b border-t-0 border-slate-200/80 bg-transparent shadow-none'} ${
                          selectionMode && selectedIds.has(lead.id) ? 'bg-emerald-50 border-l-[3px] border-l-emerald-500' :
                          detailLead?.id === lead.id ? 'bg-emerald-100 border-l-[3px] border-l-emerald-500 shadow-sm ring-1 ring-emerald-200/60' : 'border-l-[3px] border-l-transparent'
                        }`}
                        onClick={() => selectionMode ? toggleSelection(lead.id) : openDetailPanel(lead)}
                      >
                        {/* Selection checkbox */}
                        {selectionMode && (
                          <div className={`${isCompactListWorkspace ? 'absolute left-2 top-2 h-11 w-11' : 'static h-auto w-[36px] px-2 py-2.5'} z-10 flex items-center justify-center`}>
                            <button onClick={(e) => { e.stopPropagation(); toggleSelection(lead.id) }} className={`flex items-center justify-center ${isCompactListWorkspace ? 'h-11 w-11' : 'h-auto w-auto p-0.5'}`}>
                              {selectedIds.has(lead.id) ? <CheckSquare className="w-4 h-4 text-emerald-600" /> : <Square className="w-4 h-4 text-slate-300" />}
                            </button>
                          </div>
                        )}
                        {/* Lead info */}
                        <div className={`${isCompactListWorkspace ? 'w-full px-3 py-3 pr-14' : 'w-[220px] px-3 py-2.5 pr-3'} ${selectionMode ? (isCompactListWorkspace ? 'pl-14' : 'pl-3') : ''}`}>
                          <div className="flex items-center gap-2.5">
                            <div className="w-8 h-8 bg-emerald-50 rounded-full flex items-center justify-center shrink-0">
                              <span className="text-emerald-700 text-xs font-semibold">
                                {(lead.name || '?').charAt(0).toUpperCase()}
                              </span>
                            </div>
                            <div className="min-w-0">
                              <p className="truncate text-[13px] font-semibold text-slate-900">{lead.name || 'Sin nombre'}</p>
                              <p className="mt-0.5 truncate text-[11px] text-slate-500">{lead.phone || 'Sin teléfono'}</p>
                            </div>
                          </div>
                        </div>

                        {/* Stage */}
                        <div className={`${isCompactListWorkspace ? 'flex w-full items-center gap-2 px-3 pb-2' : 'block w-[110px] px-3 py-2.5'}`}>
                          {isCompactListWorkspace && <span className="w-20 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Etapa</span>}
                          {isCompactListWorkspace ? <select
                            value={lead.stage_id || ''}
                            onClick={event => event.stopPropagation()}
                            onChange={event => {
                              const stage = allStages.find(option => option.id === event.target.value)
                              if (stage && stage.id !== lead.stage_id) requestLeadStageChange(lead, stage)
                            }}
                            className="h-11 min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-2 text-sm text-slate-700 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
                            aria-label={`Mover ${lead.name || 'lead'} a otra etapa`}
                          >
                            {!lead.stage_id && <option value="">Sin etapa</option>}
                            {allStages.map(stage => <option key={stage.id} value={stage.id}>{stage.name}</option>)}
                          </select> : <div>
                            {stageName ? (
                              <span className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-700">
                                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: stageColor }} aria-hidden="true" />
                                {stageName}
                              </span>
                            ) : (
                              <span className="text-[10px] text-slate-400 italic">Sin etapa</span>
                            )}
                          </div>}
                        </div>

                        {/* Tags */}
                        <div className={`${isCompactListWorkspace ? 'flex w-full items-start gap-2 px-3 pb-2' : 'block w-[180px] px-3 py-2.5'}`}>
                          {isCompactListWorkspace && <span className="w-20 shrink-0 pt-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Etiquetas</span>}
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

                        {/* Custom field columns */}
                        {!isCompactListWorkspace && cfDefs.filter(d => cfVisibleIds.has(d.id)).sort((a, b) => a.sort_order - b.sort_order).map(def => (
                          <div key={def.id} className="w-[140px] truncate px-3 py-2.5 text-[11px] text-slate-600">
                            {formatCfCell(def, lead)}
                          </div>
                        ))}

                        {/* Observations preview */}
                        <div
                          className={`${isCompactListWorkspace ? 'w-full px-3 pb-3 pt-1' : 'w-auto flex-1 px-3 py-2.5'} cursor-pointer rounded-lg transition-colors hover:bg-slate-50`}
                          onClick={(e) => {
                            e.stopPropagation()
                            if (obs && obs.length > 0) {
                              setListHistoryLead(lead)
                            }
                          }}
                        >
                          {loadingListObs.has(lead.id) ? (
                            <div className="flex items-center gap-2">
                              <div className="animate-spin rounded-full h-3 w-3 border border-slate-200 border-t-emerald-500" />
                              <span className="text-[10px] text-slate-400">Cargando...</span>
                            </div>
                          ) : obs && obs.length > 0 ? (
                            <div className="space-y-1">
                              {obs.slice(0, isExpanded ? 10 : 2).map(o => (
                                <div key={o.id} className="flex items-start gap-1.5">
                                  <span className="shrink-0 mt-0.5 text-[10px]">
                                    {o.type === 'call' ? '📞' : o.type === 'note' ? '📝' : '↕'}
                                  </span>
                                  <p className="text-[11px] text-slate-600 leading-tight">
                                    {(o.notes || '').replace(/^\(sinc\)\s*/i, '')}
                                  </p>
                                  <span className="shrink-0 text-[9px] text-slate-400 mt-0.5 whitespace-nowrap">
                                    {formatDistanceToNow(new Date(o.created_at), { locale: es, addSuffix: false })}
                                  </span>
                                </div>
                              ))}
                              {obs.length > 2 && (
                                <span className="text-[10px] text-emerald-600 font-medium inline-flex items-center gap-0.5">
                                  <Maximize2 className="w-3 h-3" /> Ver {obs.length} observaciones
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="text-[10px] text-slate-300 italic">Sin observaciones</span>
                          )}
                        </div>

                        {/* Actions */}
                        {!selectionMode && (
                        <div className={`${isCompactListWorkspace ? 'absolute right-2 top-2 w-11' : 'static w-[52px] px-1 py-1.5'} z-10`}>
                          <button
                            onClick={(e) => { e.stopPropagation(); statusFilter === 'trash' ? handleRestoreLead(lead.id) : handleDeleteLead(lead.id) }}
                            className={`inline-flex items-center justify-center rounded-xl transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${isCompactListWorkspace ? 'h-11 w-11 opacity-100' : 'h-10 w-10 opacity-0 focus:opacity-100 group-hover:opacity-100'} ${statusFilter === 'trash' ? 'text-slate-400 hover:bg-emerald-50 hover:text-emerald-700' : 'text-slate-400 hover:bg-red-50 hover:text-red-600'}`}
                            aria-label={statusFilter === 'trash' ? `Restaurar ${lead.title || lead.name || 'oportunidad'}` : `Mover ${lead.title || lead.name || 'oportunidad'} a la papelera`}
                          >
                            {statusFilter === 'trash' ? <ArchiveRestore className="h-4 w-4" /> : <Trash2 className="h-4 w-4" />}
                          </button>
                        </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-16 text-slate-400">
                <FileText className="w-10 h-10 mb-2 text-slate-300" />
                <p className="text-sm">No se encontraron oportunidades</p>
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

      {/* List View — Historial Completo Modal */}
      {listHistoryLead && (
        <ObservationHistoryModal
          isOpen={true}
          onClose={() => setListHistoryLead(null)}
          leadId={listHistoryLead.id}
          name={listHistoryLead.name || 'Sin nombre'}
          observations={listObservations.get(listHistoryLead.id) || []}
          onObservationChange={() => {
            // Invalidate cache so it refetches
            setListObservations(prev => { const next = new Map(prev); next.delete(listHistoryLead.id); return next })
            fetchBatchObservations([listHistoryLead.id])
          }}
        />
      )}

      {/* Add Lead Modal */}
      {showAddModal && (
        <div className="app-viewport fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/55 p-0 backdrop-blur-sm sm:p-4" onMouseDown={event => { if (event.target === event.currentTarget) closeAddLeadDialog() }}>
          <div ref={addLeadDialogRef} role="dialog" aria-modal="true" aria-labelledby="create-lead-title" aria-describedby="create-lead-description" tabIndex={-1} className="flex h-full w-full max-w-xl flex-col overflow-hidden bg-white shadow-2xl sm:h-auto sm:max-h-[92vh] sm:rounded-3xl sm:border sm:border-slate-100">
            <header className="flex items-start gap-3 border-b border-slate-200 px-5 py-5 sm:px-6">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-700"><Plus className="h-5 w-5" /></div>
              <div className="min-w-0 flex-1">
                <h2 id="create-lead-title" className="text-lg font-bold text-slate-900">Nueva oportunidad</h2>
                <p id="create-lead-description" className="mt-1 text-sm leading-relaxed text-slate-500">Describe la oportunidad comercial y la persona interesada por separado.</p>
              </div>
              <button type="button" onClick={closeAddLeadDialog} disabled={creatingLead} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-50" aria-label="Cerrar"><X className="h-5 w-5" /></button>
            </header>
            <main className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
            <div className="space-y-4">
              <div>
                <label htmlFor="new-lead-title" className="mb-1.5 block text-xs font-bold text-slate-700">Concepto de la oportunidad *</label>
                <input
                  id="new-lead-title"
                  ref={newLeadTitleRef}
                  type="text"
                  maxLength={160}
                  value={formData.title}
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  className="h-11 w-full rounded-xl border border-slate-300 px-3 text-sm font-semibold text-slate-900 placeholder:font-normal placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  placeholder="Ej. Inscripción al programa 2026"
                />
                <p className="mt-1.5 text-xs text-slate-400">Esto identifica la oportunidad; no reemplaza el nombre del contacto.</p>
              </div>
              {/* Pipeline & Stage selector */}
              {activePipeline && activePipeline.stages && activePipeline.stages.length > 0 && (
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Pipeline / Etapa</label>
                  <div className="flex gap-2">
                    <div className="flex-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-700 truncate">
                      {activePipeline.name}
                    </div>
                    <select
                      value={formData.stage_id || ''}
                      onChange={(e) => setFormData({ ...formData, stage_id: e.target.value })}
                  className="h-11 flex-1 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 focus:ring-2 focus:ring-emerald-500"
                    >
                      <option value="">Automático (configuración de cuenta)</option>
                      {activePipeline.stages.filter(stage => stage.stage_type !== 'won' && stage.stage_type !== 'lost').map((st) => (
                        <option key={st.id} value={st.id}>{st.name}</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Nombre del contacto *</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="h-11 w-full rounded-xl border border-slate-200 px-3 text-sm text-slate-900 placeholder:text-slate-400 focus:ring-2 focus:ring-emerald-500"
                  placeholder="Nombre de la persona"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Teléfono</label>
                <input
                  type="tel"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                  className="h-11 w-full rounded-xl border border-slate-200 px-3 text-sm text-slate-900 placeholder:text-slate-400 focus:ring-2 focus:ring-emerald-500"
                  placeholder="+51 999 888 777"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Email</label>
                <input
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className="h-11 w-full rounded-xl border border-slate-200 px-3 text-sm text-slate-900 placeholder:text-slate-400 focus:ring-2 focus:ring-emerald-500"
                  placeholder="correo@ejemplo.com"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">DNI</label>
                  <input
                    type="text"
                    value={formData.dni}
                    onChange={(e) => setFormData({ ...formData, dni: e.target.value })}
                    className="h-11 w-full rounded-xl border border-slate-200 px-3 text-sm text-slate-900 placeholder:text-slate-400 focus:ring-2 focus:ring-emerald-500"
                    placeholder="12345678"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Fecha de nacimiento</label>
                  <input
                    type="date"
                    value={formData.birth_date}
                    onChange={(e) => setFormData({ ...formData, birth_date: e.target.value })}
                    className="h-11 w-full rounded-xl border border-slate-200 px-3 text-sm text-slate-900 placeholder:text-slate-400 focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Etiquetas</label>
                <input
                  type="text"
                  value={formData.tags}
                  onChange={(e) => setFormData({ ...formData, tags: e.target.value })}
                  className="h-11 w-full rounded-xl border border-slate-200 px-3 text-sm text-slate-900 placeholder:text-slate-400 focus:ring-2 focus:ring-emerald-500"
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
            </main>
            <footer className="flex gap-3 border-t border-slate-200 bg-white px-5 py-4 sm:px-6">
              <button
                type="button"
                onClick={closeAddLeadDialog}
                disabled={creatingLead}
                className="min-h-11 flex-1 rounded-xl border border-slate-200 px-4 text-sm font-semibold text-slate-600 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                onClick={() => handleCreateLead()}
                disabled={!formData.title.trim() || !formData.name.trim() || creatingLead}
                className="min-h-11 flex-1 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
              >
                {creatingLead ? 'Creando…' : 'Crear oportunidad'}
              </button>
            </footer>
          </div>
        </div>
      )}

      {duplicateConfirmation && (
        <div className="app-viewport fixed inset-0 z-[95] flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-sm">
          <div ref={duplicateDialogRef} role="alertdialog" aria-modal="true" aria-labelledby="duplicate-opportunity-title" tabIndex={-1} className="w-full max-w-md rounded-3xl border border-amber-200 bg-white p-6 shadow-2xl">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-50 text-amber-700">
              <AlertTriangle className="h-6 w-6" aria-hidden="true" />
            </div>
            <h2 id="duplicate-opportunity-title" className="mt-4 text-lg font-bold text-slate-900">Posible oportunidad duplicada</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">
              {duplicateConfirmation.kind === 'single'
                ? `Encontramos ${duplicateConfirmation.count} oportunidad${duplicateConfirmation.count === 1 ? '' : 'es'} abierta${duplicateConfirmation.count === 1 ? '' : 's'} con el mismo concepto para este contacto.`
                : `Algunos de los contactos seleccionados ya tienen una oportunidad abierta con el mismo concepto.`}
            </p>
            <p className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-600">Puedes continuar si se trata de una compra, inscripción o necesidad realmente distinta. El contacto seguirá siendo uno solo.</p>
            <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row">
              <button ref={duplicateCancelRef} type="button" onClick={closeDuplicateConfirmation} className="min-h-11 flex-1 rounded-xl border border-slate-200 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500">Volver y revisar</button>
              <button type="button" onClick={confirmDuplicateCreation} className="min-h-11 flex-1 rounded-xl bg-amber-600 px-4 text-sm font-bold text-white hover:bg-amber-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2">Crear de todas formas</button>
            </div>
          </div>
        </div>
      )}

      {lifecycleRequest && (
        <div className="app-viewport fixed inset-0 z-[75] flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-sm">
          <div ref={lifecycleDialogRef} role="dialog" aria-modal="true" aria-labelledby="lifecycle-dialog-title" tabIndex={-1} className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl">
            <div className={`flex h-12 w-12 items-center justify-center rounded-2xl ${lifecycleRequest.mode === 'won' ? 'bg-emerald-50 text-emerald-700' : lifecycleRequest.mode === 'lost' ? 'bg-red-50 text-red-700' : 'bg-blue-50 text-blue-700'}`}>
              {lifecycleRequest.mode === 'won' ? <CheckCircle2 className="h-6 w-6" /> : lifecycleRequest.mode === 'lost' ? <XCircle className="h-6 w-6" /> : <ArchiveRestore className="h-6 w-6" />}
            </div>
            <h2 id="lifecycle-dialog-title" className="mt-4 text-lg font-bold text-slate-900">
              {lifecycleRequest.mode === 'won' ? 'Marcar oportunidad como ganada' : lifecycleRequest.mode === 'lost' ? 'Marcar oportunidad como perdida' : 'Reabrir oportunidad'}
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">
              {lifecycleRequest.mode === 'won'
                ? `El lead de “${lifecycleRequest.lead.name || 'Sin nombre'}” se cerrará como resultado ganado y dejará el Kanban activo.`
                : lifecycleRequest.mode === 'lost'
                ? `Registra el motivo para aprender de este resultado sin perder el historial de “${lifecycleRequest.lead.name || 'Sin nombre'}”.`
                : `El lead volverá a “${lifecycleRequest.stage.name}” y quedará abierto para continuar el seguimiento.`}
            </p>
            {lifecycleRequest.mode === 'lost' && (
              <div className="mt-4">
                <label htmlFor="lost-reason" className="mb-1.5 block text-xs font-bold text-slate-700">Motivo de pérdida *</label>
                <textarea id="lost-reason" autoFocus value={lifecycleReason} onChange={event => { setLifecycleReason(event.target.value); setLifecycleError('') }} rows={4} maxLength={500} placeholder="Ej. Eligió otra solución, presupuesto insuficiente…" className="w-full resize-none rounded-xl border border-slate-300 px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-red-500" />
                <p className="mt-1 text-right text-xs tabular-nums text-slate-400">{lifecycleReason.length}/500</p>
              </div>
            )}
            {lifecycleError && <p className="mt-3 flex items-center gap-2 text-xs font-semibold text-red-700" role="alert"><AlertCircle className="h-4 w-4" />{lifecycleError}</p>}
            <div className="mt-6 flex gap-2">
              <button type="button" autoFocus={lifecycleRequest.mode !== 'lost'} onClick={closeLifecycleDialog} disabled={savingLifecycle} className="min-h-11 flex-1 rounded-xl border border-slate-200 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">Cancelar</button>
              <button type="button" onClick={confirmLifecycleChange} disabled={savingLifecycle || (lifecycleRequest.mode === 'lost' && !lifecycleReason.trim())} className={`inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl px-4 text-sm font-bold text-white disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${lifecycleRequest.mode === 'lost' ? 'bg-red-600 hover:bg-red-700 focus-visible:ring-red-500' : 'bg-emerald-600 hover:bg-emerald-700 focus-visible:ring-emerald-500'}`}>
                {savingLifecycle && <RefreshCw className="h-4 w-4 animate-spin motion-reduce:animate-none" />}
                {savingLifecycle ? 'Guardando…' : lifecycleRequest.mode === 'won' ? 'Marcar como ganada' : lifecycleRequest.mode === 'lost' ? 'Marcar como perdida' : 'Reabrir'}
              </button>
            </div>
          </div>
        </div>
      )}

      <PipelineStageManager
        open={showStageModal && Boolean(activePipeline && activePipeline.id !== '__no_pipeline__')}
        pipeline={activePipeline?.id === '__no_pipeline__' ? null : activePipeline}
        hiddenStageIds={hiddenStageIds}
        onToggleVisibility={toggleStageVisibility}
        onClose={() => setShowStageModal(false)}
        onSaved={async (updatedPipeline) => {
          setActivePipeline(updatedPipeline)
          setPipelines(current => current.map(item => item.id === updatedPipeline.id ? updatedPipeline : item))
          const validStageIds = new Set((updatedPipeline.stages || []).map(stage => stage.id))
          setFilterStageIds(current => new Set(Array.from(current).filter(stageId => validStageIds.has(stageId))))
          await Promise.all([fetchPipelines(updatedPipeline.id), fetchLeadsPaginated(), fetchLeadCounts()])
        }}
      />

      {/* Lead Detail Panel (Slide-over) with Inline Chat */}
      {(showDetailPanel || showInlineChat) && detailLead && (
        <div className="app-viewport fixed inset-0 z-[70] flex justify-end overflow-hidden">
          <div
            className="absolute inset-0 bg-black/30"
            onClick={() => { setShowDetailPanel(false); resetInlineChatState(); setNewObservation(''); setEditingField(null); setEditingNotes(false) }}
          />
          <div className={`relative flex h-full w-full border-l border-slate-200 bg-white shadow-2xl transition-all duration-200 motion-reduce:transition-none ${showInlineChat ? 'lg:w-[85vw] lg:max-w-6xl' : 'max-w-md'}`}>

            {/* Chat Panel - Left Side */}
            {showInlineChat && inlineChatId && (
              <div className="flex h-full min-w-0 flex-1 flex-col border-r border-slate-200 bg-slate-50/50">
                <ChatPanel
                  key={inlineChatId}
                  chatId={inlineChatId}
                  deviceId={inlineChatDeviceId}
                  initialChat={inlineChat || undefined}
                  readOnly={inlineChatReadOnly}
                  onClose={resetInlineChatState}
                  className="h-full"
                />
              </div>
            )}

            {/* Lead Details - Right Side */}
            <div className={`${showInlineChat ? 'hidden lg:flex lg:w-[360px] lg:shrink-0' : 'flex w-full'} h-full flex-col bg-white`}>
              {(() => {
                const hasCanonicalContact = Boolean(detailLead.contact_id)
                const opportunityPanel = (
                  <LeadDetailPanel
                    lead={detailLead}
                    scrollToTasks={scrollToTasks}
                    onLeadChange={(updatedLead: Lead) => {
                      setDetailLead(updatedLead as any)
                      updateLeadInStages(updatedLead.id, () => updatedLead as any)
                    }}
                    onStageChangeRequest={(lead, stage) => requestLeadStageChange(lead, stage)}
                    onLifecycleAction={requestLifecycleAction}
                    onClose={() => { setShowDetailPanel(false); resetInlineChatState(); setScrollToTasks(false) }}
                    onSendWhatsApp={(phone: string) => handleSendWhatsApp(phone)}
                    onDelete={(leadId: string) => {
                      removeLeadFromStages(leadId)
                      setShowDetailPanel(false)
                      resetInlineChatState()
                    }}
                    hideWhatsApp={showInlineChat}
                    onArchive={(leadId: string, archive: boolean) => {
                      if (archive) {
                        openArchiveModal(leadId, false)
                      } else {
                        handleArchiveLead(leadId, false)
                        setShowDetailPanel(false)
                        resetInlineChatState()
                      }
                    }}
                    onBlock={(leadId: string) => {
                      openBlockModal(leadId, false)
                    }}
                    onUnblock={(leadId: string) => {
                      handleBlockLead(leadId, false)
                      setShowDetailPanel(false)
                      resetInlineChatState()
                    }}
                    hideHeader={hasCanonicalContact}
                    hideIdentity={hasCanonicalContact}
                    commercialOnly={hasCanonicalContact}
                    parentOwnsScroll={hasCanonicalContact}
                    hideTabs={hasCanonicalContact}
                    hideCustomFields={hasCanonicalContact}
                    hideObservations={hasCanonicalContact}
                  />
                )
                if (!detailLead.contact_id) return opportunityPanel
                return (
                  <ContactDetailSurface
                    contactId={detailLead.contact_id}
                    context={{ type: 'lead', id: detailLead.id }}
                    initialContact={{
                      id: detailLead.contact_id,
                      jid: detailLead.jid,
                      name: detailLead.name,
                      last_name: detailLead.last_name,
                      short_name: detailLead.short_name,
                      phone: detailLead.phone,
                      email: detailLead.email,
                      company: detailLead.company,
                      age: detailLead.age,
                      dni: detailLead.dni,
                      birth_date: detailLead.birth_date,
                      address: detailLead.address,
                      distrito: detailLead.distrito,
                      ocupacion: detailLead.ocupacion,
                      structured_tags: [],
                      extra_phones: [],
                      custom_field_values: [],
                    }}
                    title="Detalles"
                    subtitle="Contacto y oportunidad"
                    onClose={() => { setShowDetailPanel(false); resetInlineChatState(); setScrollToTasks(false) }}
                    onContactChange={reconcileContactProfile}
                    onObservationChange={() => {
                      if (viewMode === 'list') {
                        setListObservations(current => { const next = new Map(current); next.delete(detailLead.id); return next })
                        setLoadingListObs(current => { const next = new Set(current); next.delete(detailLead.id); return next })
                        fetchBatchObservations([detailLead.id])
                      }
                    }}
                    contextContent={opportunityPanel}
                  />
                )
              })()}

            </div>
          </div>
        </div>
      )}

      {/* Device Selector Modal for WhatsApp */}
      {showDeviceSelector && (
        <div className="app-viewport fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm border border-slate-100">
	            <h2 className="text-sm font-semibold text-slate-900 mb-3">Seleccionar dispositivo</h2>
	            <p className="text-xs text-slate-500 mb-4">Elige el dispositivo para enviar el mensaje a {whatsappPhone}</p>
	            {existingChatForWA && (
	              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 mb-3">
	                Ya existe historial{whatsappHistoricalPhone ? ` con el numero ${whatsappHistoricalPhone}` : ' con numero historico desconocido'}.
	              </p>
	            )}
            {allDevicesForModal.length === 0 ? (
              <p className="text-xs text-slate-400 text-center py-4">No hay dispositivos conectados</p>
            ) : (
              <div className="space-y-2">
                {/* Connected devices — sort chat owner first */}
                {[...allDevicesForModal].sort((a, b) => {
                  if (existingChatForWA?.device_id === a.id) return -1
                  if (existingChatForWA?.device_id === b.id) return 1
                  return 0
	                }).map((device) => {
	                  const isChatOwner = device.matches_historical || existingChatForWA?.device_id === device.id
	                  return (
                    <button
                      key={device.id}
                      onClick={() => handleDeviceSelected(device)}
                      className={`w-full flex items-center gap-3 p-3 border rounded-xl transition text-left ${isChatOwner ? 'border-emerald-200 bg-emerald-50/50 hover:bg-emerald-50' : 'border-slate-100 hover:bg-emerald-50 hover:border-emerald-200'}`}
                    >
                      <div className={`w-9 h-9 rounded-full flex items-center justify-center ${isChatOwner ? 'bg-emerald-100' : 'bg-emerald-50'}`}>
                        <Phone className="w-4 h-4 text-emerald-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-slate-900">{device.name || 'Dispositivo'}</p>
	                          {isChatOwner && (
	                            <span className="text-[10px] font-medium bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded-full">Chat activo</span>
	                          )}
	                          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${relationClassName(device)}`}>{relationLabel(device)}</span>
	                        </div>
	                        <p className="text-xs text-slate-500">{deviceDisplayPhone(device)}</p>
	                      </div>
                    </button>
                  )
                })}

                {/* Previous device option (disconnected) — read-only mode */}
                {existingChatForWA && existingChatForWA.device_id && !allDevicesForModal.find(d => d.id === existingChatForWA.device_id) && (
                  <div className="pt-2 mt-2 border-t border-slate-100">
                    <button
                      onClick={handlePreviousDeviceSelected}
                      className="w-full flex items-center gap-3 p-3 border border-amber-200 bg-amber-50/50 rounded-xl hover:bg-amber-50 transition text-left"
                    >
                      <div className="w-9 h-9 bg-amber-100 rounded-full flex items-center justify-center">
                        <Eye className="w-4 h-4 text-amber-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-amber-800">Dispositivo anterior</p>
                        <p className="text-xs text-amber-600">Solo lectura · {existingChatForWA.device_name || 'Desconectado'}</p>
                      </div>
                    </button>
                  </div>
                )}
              </div>
            )}
            <button onClick={resetInlineChatState} className="w-full mt-4 px-4 py-2 border border-slate-200 text-slate-600 rounded-xl hover:bg-slate-50 text-sm">
              Cancelar
            </button>
          </div>
        </div>
      )}



      <ImportCSVModal
        open={showImportModal}
        onClose={() => setShowImportModal(false)}
        onSuccess={() => { fetchLeadsPaginated(); fetchPipelines(activePipelineIdRef.current) }}
        defaultType="leads"
      />

      <ContactSelector
        open={showContactImportModal}
        onClose={() => {
          if (!importingContacts) setShowContactImportModal(false)
        }}
        onConfirm={handleCreateLeadsFromContacts}
        title="Crear oportunidades desde contactos"
        subtitle="Un contacto puede tener varias oportunidades. Clarin te advertirá si ya tiene una abierta con el mismo concepto."
        confirmLabel={importingContacts ? 'Creando…' : 'Crear oportunidades'}
        sourceFilter="contact"
        advancedFilters
      />

      {/* Broadcast from Leads Modal */}
      <CreateCampaignModal
        open={showBroadcastModal}
        onClose={() => setShowBroadcastModal(false)}
        onSubmit={handleCreateBroadcastFromLeads}
        devices={devices}
        submitting={submittingBroadcast}
        title="Envío masivo desde oportunidades"
        subtitle={`${totalLeadCount} oportunidades coinciden; cada contacto elegible recibirá como máximo un mensaje.`}
        submitLabel={submittingBroadcast ? 'Creando...' : 'Crear y agregar destinatarios'}
        initialName={`Leads - ${new Date().toLocaleDateString('es-PE', { day: 'numeric', month: 'short' })}`}
        infoPanel={
          <div className="bg-emerald-50 border border-emerald-100 rounded-xl p-3 text-xs text-emerald-800">
            <div className="flex items-center gap-2 mb-1">
              <Radio className="w-3.5 h-3.5 text-emerald-600" />
              <span className="font-medium">Contactos únicos desde oportunidades</span>
            </div>
            <p className="text-emerald-600">
              Se resolverán los contactos de las oportunidades que coincidan con los filtros actuales y se deduplicarán por persona y canal.
            </p>
            <p className="text-slate-500 mt-1">
              Oportunidades coincidentes: <strong>{totalLeadCount}</strong>. Se excluyen contactos sin teléfono o marcados “No contactar”.
            </p>
          </div>
        }
      />

      {/* Create Event from Leads Modal */}
      {showCreateEventModal && (
        <div className="app-viewport fixed inset-0 z-[70] flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-slate-900">Crear evento desde oportunidades</h3>
                <p className="text-xs text-slate-500 mt-0.5">Se incorporará una sola participación por contacto, aunque tenga varias oportunidades coincidentes.</p>
              </div>
              <button onClick={() => setShowCreateEventModal(false)} className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="px-6 py-4 space-y-4">
              {/* Active filters summary */}
              {(debouncedSearchTerm || filterTagNames.size > 0 || filterStageIds.size > 0 || filterDeviceIds.size > 0) && (
                <div className="bg-emerald-50 border border-emerald-100 rounded-xl p-3 text-xs text-emerald-800">
                  <p className="font-medium mb-1">Filtros activos:</p>
                  <div className="flex flex-wrap gap-1.5">
                    {debouncedSearchTerm && <span className="bg-emerald-100 px-2 py-0.5 rounded-full">Búsqueda: &quot;{debouncedSearchTerm}&quot;</span>}
                    {filterTagNames.size > 0 && <span className="bg-emerald-100 px-2 py-0.5 rounded-full">{filterTagNames.size} etiqueta(s)</span>}
                    {filterStageIds.size > 0 && <span className="bg-emerald-100 px-2 py-0.5 rounded-full">{filterStageIds.size} etapa(s)</span>}
                    {filterDeviceIds.size > 0 && <span className="bg-emerald-100 px-2 py-0.5 rounded-full">{filterDeviceIds.size} dispositivo(s)</span>}
                  </div>
                </div>
              )}
              <div>
                <label className="text-sm font-medium text-slate-700">Nombre del evento *</label>
                <input
                  value={createEventForm.name}
                  onChange={e => setCreateEventForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Ej: Webinar Febrero 2025"
                  className="mt-1 w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-slate-900"
                />
              </div>
              <div>
                <label className="text-sm font-medium text-slate-700">Descripción</label>
                <textarea
                  value={createEventForm.description}
                  onChange={e => setCreateEventForm(f => ({ ...f, description: e.target.value }))}
                  rows={2}
                  className="mt-1 w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-slate-900"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-sm font-medium text-slate-700">Fecha inicio</label>
                  <input
                    type="datetime-local"
                    value={createEventForm.event_date}
                    onChange={e => setCreateEventForm(f => ({ ...f, event_date: e.target.value }))}
                    className="mt-1 w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-slate-900"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-slate-700">Fecha fin</label>
                  <input
                    type="datetime-local"
                    value={createEventForm.event_end}
                    onChange={e => setCreateEventForm(f => ({ ...f, event_end: e.target.value }))}
                    className="mt-1 w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-slate-900"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-sm font-medium text-slate-700">Ubicación</label>
                  <input
                    value={createEventForm.location}
                    onChange={e => setCreateEventForm(f => ({ ...f, location: e.target.value }))}
                    placeholder="Ej: Sala de conferencias"
                    className="mt-1 w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-slate-900"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-slate-700">Color</label>
                  <div className="mt-1 flex gap-2 flex-wrap">
                    {['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#6366f1'].map(c => (
                      <button
                        key={c}
                        onClick={() => setCreateEventForm(f => ({ ...f, color: c }))}
                        className={`w-8 h-8 rounded-full border-2 transition-all ${createEventForm.color === c ? 'border-slate-800 scale-110' : 'border-transparent hover:scale-105'}`}
                        style={{ backgroundColor: c }}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-slate-200 flex justify-end gap-3">
              <button
                onClick={() => setShowCreateEventModal(false)}
                className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition"
              >
                Cancelar
              </button>
              <button
                onClick={handleCreateEventFromLeads}
                disabled={creatingEvent || !createEventForm.name}
                className="px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition"
              >
                {creatingEvent ? 'Creando...' : 'Crear Evento'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Block Reason Modal */}
      {showBlockModal && (
        <div className="app-viewport fixed inset-0 z-[85] flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-sm">
          <div ref={blockDialogRef} role="dialog" aria-modal="true" aria-labelledby="lead-do-not-contact-title" tabIndex={-1} className="w-full max-w-md overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl">
            <div className="px-6 py-4 border-b border-slate-200">
              <h3 id="lead-do-not-contact-title" className="text-lg font-semibold text-slate-900 flex items-center gap-2">
                <ShieldBan className="w-5 h-5 text-red-500" />
                {blockBatchMode ? `No contactar a ${selectedIds.size} contacto(s)` : 'Marcar como no contactable'}
              </h3>
              <p className="text-sm text-slate-500 mt-1">Esta preferencia pertenece al contacto y evita nuevos mensajes desde campañas, eventos y automatizaciones. No elimina su historial ni sus participaciones.</p>
            </div>
            <div className="px-6 py-4 space-y-2">
              {[
                'Solicita no ser contactado',
                'Agresivo o abusivo',
                'Número equivocado',
                'Spam o fraude',
              ].map((reason, index) => (
                <button
                  ref={index === 0 ? blockFirstChoiceRef : undefined}
                  key={reason}
                  onClick={() => setBlockReason(reason)}
                  className={`min-h-11 w-full rounded-xl px-4 py-2.5 text-left text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 ${
                    blockReason === reason
                      ? 'bg-red-50 text-red-700 ring-1 ring-red-200 font-medium'
                      : 'text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  {reason}
                </button>
              ))}
              <div className="pt-2">
                <input
                  type="text"
                  placeholder="Otro motivo..."
                  value={!['Solicita no ser contactado', 'Agresivo o abusivo', 'Número equivocado', 'Spam o fraude'].includes(blockReason) ? blockReason : ''}
                  onChange={(e) => setBlockReason(e.target.value)}
                  onFocus={() => { if (['Solicita no ser contactado', 'Agresivo o abusivo', 'Número equivocado', 'Spam o fraude'].includes(blockReason)) setBlockReason('') }}
                  className="h-11 w-full rounded-xl border border-slate-200 px-4 text-sm focus:border-red-500 focus:ring-2 focus:ring-red-500"
                />
              </div>
              {blockPreferenceError && <p className="flex items-center gap-2 rounded-xl bg-red-50 px-3 py-2 text-xs font-medium text-red-700" role="alert"><AlertCircle className="h-4 w-4 shrink-0" />{blockPreferenceError}</p>}
            </div>
            <div className="px-6 py-4 border-t border-slate-200 flex justify-end gap-3">
              <button
                onClick={closeBlockDialog}
                disabled={savingBlockPreference}
                className="h-11 rounded-xl px-4 text-sm text-slate-600 transition hover:bg-slate-100 disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                onClick={confirmBlock}
                disabled={!blockReason || savingBlockPreference}
                className="inline-flex h-11 items-center gap-2 rounded-xl bg-red-600 px-4 text-sm font-medium text-white transition hover:bg-red-700 disabled:opacity-50"
              >
                {savingBlockPreference && <RefreshCw className="h-4 w-4 animate-spin motion-reduce:animate-none" />}
                {savingBlockPreference ? 'Guardando…' : 'Confirmar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Archive Reason Modal */}
      {showArchiveModal && (
        <div className="app-viewport fixed inset-0 z-[70] flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-2xl w-[420px] max-w-[95vw]">
            <div className="px-6 py-4 border-b border-slate-200">
              <h3 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
                <Archive className="w-5 h-5 text-amber-500" />
                Archivar {archiveBatchMode ? `${selectedIds.size} lead(s)` : 'lead'}
              </h3>
              <p className="text-sm text-slate-500 mt-1">Selecciona el motivo. La oportunidad saldrá de la vista principal, pero el contacto, sus eventos y todo su historial permanecerán intactos.</p>
            </div>
            <div className="px-6 py-4 space-y-2">
              {[
                'Ya no aplica al programa',
                'Proceso finalizado',
                'Lead duplicado',
                'Datos incorrectos',
                'No responde',
              ].map(reason => (
                <button
                  key={reason}
                  onClick={() => setArchiveReason(reason)}
                  className={`w-full text-left px-4 py-2.5 rounded-lg text-sm transition ${
                    archiveReason === reason
                      ? 'bg-amber-50 text-amber-700 ring-1 ring-amber-200 font-medium'
                      : 'text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  {reason}
                </button>
              ))}
              <div className="pt-2">
                <input
                  type="text"
                  placeholder="Otro motivo..."
                  value={!['Ya no aplica al programa', 'Proceso finalizado', 'Lead duplicado', 'Datos incorrectos', 'No responde'].includes(archiveReason) ? archiveReason : ''}
                  onChange={(e) => setArchiveReason(e.target.value)}
                  onFocus={() => { if (['Ya no aplica al programa', 'Proceso finalizado', 'Lead duplicado', 'Datos incorrectos', 'No responde'].includes(archiveReason)) setArchiveReason('') }}
                  className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-amber-500 focus:border-amber-500"
                />
              </div>
            </div>
            <div className="px-6 py-4 border-t border-slate-200 flex justify-end gap-3">
              <button
                onClick={() => setShowArchiveModal(false)}
                className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition"
              >
                Cancelar
              </button>
              <button
                onClick={confirmArchive}
                disabled={!archiveReason}
                className="px-4 py-2 bg-amber-600 text-white text-sm font-medium rounded-lg hover:bg-amber-700 disabled:opacity-50 transition"
              >
                Archivar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Export Modal */}

      {/* Bulk Document Generation Modal */}
      {showBulkDocModal && (
        <BulkGenerateDocumentModal
          leads={viewMode === 'list' ? listLeads : allLoadedLeads}
          onClose={() => setShowBulkDocModal(false)}
        />
      )}

      {showExportModal && (
        <div className="app-viewport fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl p-6 w-full max-w-sm">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-emerald-100 rounded-full flex items-center justify-center">
                <Download className="w-5 h-5 text-emerald-600" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-slate-900">Exportar Leads</h3>
                <p className="text-sm text-slate-500">{activePipeline?.name || 'Todos'}</p>
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">Formato</label>
                <div className="flex rounded-lg border border-slate-200 overflow-hidden">
                  <button onClick={() => setExportFormat('excel')}
                    className={`flex-1 px-3 py-2 text-sm font-medium transition ${exportFormat === 'excel' ? 'bg-emerald-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
                    Excel (.xlsx)
                  </button>
                  <button onClick={() => setExportFormat('csv')}
                    className={`flex-1 px-3 py-2 text-sm font-medium transition ${exportFormat === 'csv' ? 'bg-emerald-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
                    CSV
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">Alcance</label>
                <div className="space-y-2">
                  <label className="flex items-center gap-3 p-3 border border-slate-200 rounded-lg cursor-pointer hover:bg-slate-50">
                    <input type="radio" checked={exportScope === 'all'} onChange={() => setExportScope('all')} className="text-emerald-600 focus:ring-emerald-500" />
                    <div>
                      <p className="text-sm font-medium text-slate-700">Todos los leads del pipeline</p>
                    </div>
                  </label>
                  <label className={`flex items-center gap-3 p-3 border rounded-lg cursor-pointer hover:bg-slate-50 ${activeFilterCount > 0 ? 'border-emerald-300 bg-emerald-50/50' : 'border-slate-200'}`}>
                    <input type="radio" checked={exportScope === 'filtered'} onChange={() => setExportScope('filtered')} className="text-emerald-600 focus:ring-emerald-500" />
                    <div>
                      <p className="text-sm font-medium text-slate-700">Solo filtrados</p>
                      {activeFilterCount > 0 && <p className="text-xs text-emerald-600">{activeFilterCount} filtro{activeFilterCount > 1 ? 's' : ''} activo{activeFilterCount > 1 ? 's' : ''}</p>}
                    </div>
                  </label>
                </div>
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <button onClick={() => setShowExportModal(false)} className="flex-1 px-4 py-2 border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 text-sm">
                Cancelar
              </button>
              <button onClick={handleExportLeads} disabled={exporting}
                className="flex-1 px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 text-sm disabled:opacity-50 flex items-center justify-center gap-2">
                {exporting ? <><div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" /> Exportando...</> : <><Download className="w-4 h-4" /> Exportar</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
