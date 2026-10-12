'use client'

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  CalendarDays, Plus, Search, MapPin, Users, Clock, Edit2, Trash2,
  Eye, LayoutGrid, List, ChevronRight, Home, FolderPlus, MoreHorizontal,
  LayoutTemplate, FolderOpen, ArrowLeft, MoveRight, Tag, X, ChevronDown, Check,
  Code, FileText, EyeOff, Copy, GripVertical,
  Loader2, ArrowUp, ArrowDown,
} from 'lucide-react'
import { format } from 'date-fns'
import { es } from 'date-fns/locale'
import { cancelEventResource } from '@/components/events/eventCancellation'
import EventConfigurationWindow from '@/components/events/EventConfigurationWindow'
import { EventStageSummary, type EventStageSummaryItem } from '@/components/events/EventStageSummary'
import { EventListActions } from '@/components/events/EventListActions'
import { api, subscribeWebSocket } from '@/lib/api'
import { useContainerWidth } from '@/components/responsive/useContainerWidth'
import { resolveEventsResponsiveLayout, type EventsViewMode } from '@/lib/eventsResponsive'
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '@/lib/useDebouncedValue'
import { eventDetailPayload, eventLocalDateTime, isEventContextReadOnly } from './eventForm'
import { eventListQuery } from './eventListFilters'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Extract quoted tag names from a formula string, e.g. '("foo" or "bar%") and "baz"' → ['foo','bar%','baz'] */
function extractFormulaTags(formula: string): string[] {
  const matches = formula.match(/"([^"]+)"/g)
  if (!matches) return []
  return Array.from(new Set(matches.map(m => m.slice(1, -1))))
}

/** Render tag pills for an event's formula or simple tags */
function FormulaTagDisplay({ ev, maxTags = 3, size = 'sm' }: { ev: { tags?: { id: string; name: string; color: string; negate?: boolean }[]; tag_formula?: string; tag_formula_type?: string; tag_formula_mode?: string }; maxTags?: number; size?: 'sm' | 'xs' }) {
  const isAdvanced = ev.tag_formula_type === 'advanced' && !!ev.tag_formula
  const tags = ev.tags || []
  const formulaTags = isAdvanced ? extractFormulaTags(ev.tag_formula!) : []
  const tagColorMap = new Map(tags.map(t => [t.name.toLowerCase(), t.color]))
  const px = size === 'sm' ? 'px-2 py-0.5' : 'px-1.5 py-0.5'
  const text = size === 'sm' ? 'text-[11px]' : 'text-[10px]'

  if (isAdvanced) {
    const display = formulaTags.slice(0, maxTags)
    const extra = formulaTags.length - maxTags
    return (
      <div className="flex items-center gap-1 flex-wrap">
        {display.map((name, i) => {
          const color = tagColorMap.get(name.toLowerCase()) || '#8b5cf6'
          return <span key={i} className={`inline-flex items-center gap-0.5 ${px} rounded-full ${text} font-medium text-white`} style={{ backgroundColor: color }}>{name}</span>
        })}
        {extra > 0 && <span className={`${text} text-slate-400`}>+{extra}</span>}
        <span className={`inline-flex items-center gap-0.5 ${px} rounded-full ${text} font-medium bg-violet-100 text-violet-700`}>
          <Code className="w-2.5 h-2.5" />Avanzado
        </span>
      </div>
    )
  }

  if (tags.length > 0) {
    const display = tags.slice(0, maxTags)
    const extra = tags.length - maxTags
    const mode = ev.tag_formula_mode || 'OR'
    return (
      <div className="flex items-center gap-1 flex-wrap">
        {display.map(tag => (
          <span key={tag.id} className={`inline-flex items-center ${px} rounded-full ${text} font-medium text-white`} style={{ backgroundColor: tag.color }}>{tag.name}</span>
        ))}
        {extra > 0 && <span className={`${text} text-slate-400`}>+{extra}</span>}
        <span className={`${text} text-slate-400 font-medium`}>{mode}</span>
      </div>
    )
  }

  return <span className="text-[10px] text-slate-300">-</span>
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface TagItem {
  id: string
  name: string
  color: string
  negate?: boolean
}

interface Event {
  id: string
  name: string
  description?: string
  event_date?: string
  event_end?: string
  location?: string
  status: string
  color: string
  tag_formula_mode?: string
  rule_revision?: number
  tag_formula?: string
  tag_formula_type?: string
  folder_id?: string | null
  created_at: string
  updated_at?: string
  total_participants: number
  participant_counts?: Record<string, number>
  stage_counts?: Record<string, number>
  stage_summary?: EventStageSummaryItem[]
  tags?: TagItem[]
}

interface EventFolder {
  id: string
  account_id: string
  parent_id?: string | null
  name: string
  color: string
  icon: string
  position: number
  event_count: number
  created_at: string
  updated_at: string
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_OPTIONS = [
  { value: 'active', label: 'Activo', desc: 'Sincronizando etiquetas', color: 'bg-emerald-100 text-emerald-700', syncing: true },
  { value: 'draft', label: 'Borrador', desc: 'Sin sincronizar', color: 'bg-slate-100 text-slate-700', syncing: false },
  { value: 'completed', label: 'Completado', desc: 'Evento finalizado, sin sincronizar', color: 'bg-blue-100 text-blue-700', syncing: false },
  { value: 'cancelled', label: 'Cancelado', desc: 'Evento eliminado, sin sincronizar', color: 'bg-red-100 text-red-700', syncing: false },
]

const COLOR_OPTIONS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899',
  '#06b6d4', '#f97316', '#14b8a6', '#6366f1',
]

const FOLDER_ICONS = ['📁', '📂', '🎓', '🎉', '🏋️', '📊', '📝', '🎯', '📌', '🗂️']

const PARTICIPANT_STATUSES = [
  { key: 'invited', label: 'Invitados', color: 'bg-blue-500' },
  { key: 'contacted', label: 'Contactados', color: 'bg-yellow-500' },
  { key: 'confirmed', label: 'Confirmados', color: 'bg-green-500' },
  { key: 'declined', label: 'Declinados', color: 'bg-red-500' },
  { key: 'attended', label: 'Asistieron', color: 'bg-emerald-600' },
]

// ─── Main Component ───────────────────────────────────────────────────────────

export default function EventsPage() {
  const { ref: pageRef, width: pageWidth } = useContainerWidth<HTMLDivElement>()
  const router = useRouter()
  const searchParams = useSearchParams()
  // Events & Folders state
  const [events, setEvents] = useState<Event[]>([])
  const [folders, setFolders] = useState<EventFolder[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [eventsError, setEventsError] = useState('')
  const [hasMore, setHasMore] = useState(true)
  const [total, setTotal] = useState(0)
  const offsetRef = useRef(0)
  const hasMoreRef = useRef(true)
  const loadingMoreRef = useRef(false)
  const eventsRequestRef = useRef(0)
  const eventsAbortControllerRef = useRef<AbortController | null>(null)
  const eventsScrollRef = useRef<HTMLDivElement | null>(null)
  const setEventsPageRef = useCallback((node: HTMLDivElement | null) => {
    eventsScrollRef.current = node
    pageRef.current = node
  }, [pageRef])
  const EVENTS_PAGE_SIZE = 50

  // Navigation state
  const [currentFolderID, setCurrentFolderID] = useState<string | null>(null)
  const [folderPath, setFolderPath] = useState<EventFolder[]>([]) // breadcrumb

  // Filters & View
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useDebouncedValue(search, SEARCH_DEBOUNCE_MS)
  const searchPending = search !== debouncedSearch
  const [statusFilter, setStatusFilter] = useState('active')
  const [includeCancelled, setIncludeCancelled] = useState(false)
  const [viewMode, setViewMode] = useState<EventsViewMode>('list')

  // Sort state for list view
  const [sortField, setSortField] = useState<string | null>('name')
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc')

  // Event modal
  const [showCreate, setShowCreate] = useState(false)
  const [editEvent, setEditEvent] = useState<Event | null>(null)
  const [configurationSection, setConfigurationSection] = useState<'data'|'stages'|'rules'>('data')
  // Folder modal
  const [showFolderModal, setShowFolderModal] = useState(false)
  const [editFolder, setEditFolder] = useState<EventFolder | null>(null)
  const [folderForm, setFolderForm] = useState({ name: '', color: '#3b82f6', icon: '📁' })

  // Event context menus
  const [menuEventID, setMenuEventID] = useState<string | null>(null)
  const [showMoveMenu, setShowMoveMenu] = useState<string | null>(null)
  const [duplicatingEventID, setDuplicatingEventID] = useState<string | null>(null)
  const [cancellingEventID, setCancellingEventID] = useState<string | null>(null)

  // Drag & drop
  const [dragOverFolderID, setDragOverFolderID] = useState<string | null>(null)
  const dragEventIDRef = useRef<string | null>(null)

  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : ''

  // ─── Data Fetching ──────────────────────────────────────────────────────────

  const fetchFolders = useCallback(async () => {
    try {
      const res = await fetch('/api/events/folders', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) setFolders(data.folders || [])
    } catch (e) {
      console.error(e)
    }
  }, [token])

  const fetchEvents = useCallback(async (reset: boolean = true, reconcile: boolean = false) => {
    const visibleLimit = reset && reconcile ? Math.max(EVENTS_PAGE_SIZE, offsetRef.current) : EVENTS_PAGE_SIZE
    if (!reset && (!hasMoreRef.current || loadingMoreRef.current)) return
    if (!reset) {
      loadingMoreRef.current = true
      setLoadingMore(true)
    }
    eventsAbortControllerRef.current?.abort()
    const controller = new AbortController()
    eventsAbortControllerRef.current = controller
    const requestID = ++eventsRequestRef.current
    if (reset) setEventsError('')
    try {
      if (reset) {
        offsetRef.current = 0
        hasMoreRef.current = true
      }
      const pageItems: Event[] = []
      let serverCount = 0
      do {
        const params = eventListQuery({ search: debouncedSearch, status: statusFilter, includeCancelled,
          folderID: currentFolderID, limit: Math.min(200, visibleLimit - pageItems.length), offset: offsetRef.current + pageItems.length, sort: sortField ?? 'date', direction: sortDirection })
        const response = await api<{ success: boolean; events?: Event[]; total?: number; error?: string }>(`/api/events?${params}`, { signal: controller.signal })
        if (controller.signal.aborted || requestID !== eventsRequestRef.current) return
        const result = response.data
        if (!response.success || !result?.success) throw new Error(response.error || result?.error || 'No se pudieron cargar los eventos')
        const items: Event[] = result.events || []
        pageItems.push(...items)
        serverCount = result.total ?? pageItems.length
        if (!items.length) break
      } while (reset && reconcile && pageItems.length < visibleLimit && pageItems.length < serverCount)
      const data = { success: true, events: pageItems, total: serverCount }
      if (requestID !== eventsRequestRef.current) return
      if (data.success) {
        const newEvents: Event[] = data.events || []
        if (reset) {
          setEvents(newEvents)
        } else {
          setEvents(prev => {
            const ids = new Set(prev.map(e => e.id))
            return [...prev, ...newEvents.filter(e => !ids.has(e.id))]
          })
        }
        const serverTotal = data.total ?? newEvents.length
        setTotal(serverTotal)
        offsetRef.current += newEvents.length
        const nextHasMore = offsetRef.current < serverTotal
        hasMoreRef.current = nextHasMore
        setHasMore(nextHasMore)
      }
    } catch (e) {
      if (controller.signal.aborted || (e instanceof Error && e.name === 'AbortError')) return
      if (requestID !== eventsRequestRef.current) return
      console.error(e)
      setEventsError(e instanceof Error ? e.message : 'No se pudieron cargar los eventos')
    } finally {
      if (requestID === eventsRequestRef.current) {
        if (eventsAbortControllerRef.current === controller) eventsAbortControllerRef.current = null
        setLoading(false)
        setLoadingMore(false)
        loadingMoreRef.current = false
      }
    }
  }, [token, debouncedSearch, statusFilter, currentFolderID, includeCancelled, sortField, sortDirection])

  useEffect(() => () => {
    eventsRequestRef.current += 1
    eventsAbortControllerRef.current?.abort()
  }, [])

  // Restore folder from URL on mount
  useEffect(() => {
    const folderFromUrl = searchParams.get('folder')
    if (folderFromUrl && !currentFolderID) {
      setCurrentFolderID(folderFromUrl)
      // Build folder path by fetching folder ancestors
      fetch('/api/events/folders', { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.json())
        .then(data => {
          if (!data.success) return
          const allFolders: EventFolder[] = data.folders || []
          const path: EventFolder[] = []
          let fid: string | null | undefined = folderFromUrl
          while (fid) {
            const f = allFolders.find(x => x.id === fid)
            if (f) { path.unshift(f); fid = f.parent_id } else break
          }
          setFolderPath(path)
        })
        .catch(() => {})
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => { void fetchFolders() }, [fetchFolders])
  useEffect(() => { void fetchEvents() }, [fetchEvents])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = subscribeWebSocket((message: unknown) => {
      const event = (message as { event?: string }).event ?? ''
      if (!['event_update', 'event_participant_update', 'event_stage_update', 'event_membership_update'].includes(event)) return
      clearTimeout(timer)
      timer = setTimeout(() => { void fetchEvents(true, true); }, 150)
    })
    return () => { unsubscribe(); clearTimeout(timer) }
  }, [fetchEvents])

  // Infinite scroll for events
  useEffect(() => {
    if (!hasMore || loadingMore || loading) return
    const el = eventsScrollRef.current
    if (!el) return
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = el
      if (scrollHeight - scrollTop - clientHeight < 300) {
        fetchEvents(false)
      }
    }
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [hasMore, loadingMore, loading, fetchEvents])

  // Close modals on Escape
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const closeLayer = (close: () => void) => {
        e.preventDefault()
        e.stopImmediatePropagation()
        close()
      }

      // Escape always dismisses only the topmost layer. A filter/dropdown must
      // never collapse the form behind it or navigate away from the page.
      if (showMoveMenu) { closeLayer(() => setShowMoveMenu(null)); return }
      if (menuEventID) { closeLayer(() => setMenuEventID(null)); return }
      if (showFolderModal || editFolder) {
        closeLayer(() => { setShowFolderModal(false); setEditFolder(null) })
      }
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [showMoveMenu, menuEventID, showFolderModal, editFolder])

  // Close context menus on outside click
  useEffect(() => {
    const h = (e: MouseEvent) => {
      // Only close if the click was NOT on a menu toggle button
      const target = e.target as HTMLElement
      if (target.closest('[data-menu-toggle]')) return
      setMenuEventID(null)
      setShowMoveMenu(null)
    }
    document.addEventListener('click', h)
    return () => document.removeEventListener('click', h)
  }, [])

  // ─── Folder Navigation ──────────────────────────────────────────────────────

  const visibleFolders = folders.filter(f =>
    currentFolderID ? f.parent_id === currentFolderID : !f.parent_id
  )

  // The server applies status visibility before counting and pagination.
  const filteredEvents = events

  const sortedEvents = filteredEvents

  const toggleSort = (field: string) => {
    if (sortField === field) {
      setSortDirection(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDirection('asc')
    }
  }

  const SortIcon = ({ field }: { field: string }) => (
    <span aria-hidden="true" className="inline-flex flex-col ml-1 -space-y-1 text-[8px] leading-none">
      <span className={sortField === field && sortDirection === 'asc' ? 'text-emerald-600' : 'text-slate-300'}>▲</span>
      <span className={sortField === field && sortDirection === 'desc' ? 'text-emerald-600' : 'text-slate-300'}>▼</span>
    </span>
  )

  const navigateIntoFolder = (folder: EventFolder) => {
    setCurrentFolderID(folder.id)
    setFolderPath(prev => [...prev, folder])
    setSearch('')
    setDebouncedSearch('')
    setStatusFilter('')
    setLoading(true)
  }

  const navigateToBreadcrumb = (index: number) => {
    if (index === -1) {
      setCurrentFolderID(null)
      setFolderPath([])
    } else {
      setCurrentFolderID(folderPath[index].id)
      setFolderPath(prev => prev.slice(0, index + 1))
    }
    setSearch('')
    setDebouncedSearch('')
    setStatusFilter('')
    setLoading(true)
  }

  // ─── Drag & Drop ────────────────────────────────────────────────────────────

  const handleDragStart = (e: React.DragEvent, eventID: string) => {
    dragEventIDRef.current = eventID
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('application/x-clarin-event', eventID)
    e.dataTransfer.setData('text/plain', eventID)
  }

  const handleDragEnd = () => {
    dragEventIDRef.current = null
    setDragOverFolderID(null)
  }

  const handleFolderDragOver = (e: React.DragEvent, folderID: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverFolderID(folderID)
  }

  const handleFolderDrop = async (e: React.DragEvent, targetFolderID: string) => {
    e.preventDefault()
    setDragOverFolderID(null)
    const eventID = e.dataTransfer.getData('application/x-clarin-event') || dragEventIDRef.current
    if (!eventID) return
    dragEventIDRef.current = null
    await moveEventToFolder(eventID, targetFolderID)
  }

  const moveEventToFolder = async (eventID: string, folderID: string | null) => {
    try {
      const res = await fetch(`/api/events/${eventID}/move-folder`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder_id: folderID }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) throw new Error(data.error || 'No se pudo mover el evento')
      await Promise.all([fetchEvents(), fetchFolders()])
    } catch (error) {
      alert(error instanceof Error ? error.message : 'No se pudo mover el evento')
    }
  }

  // ─── Event CRUD ─────────────────────────────────────────────────────────────

  const configurationOpen = showCreate || !!editEvent
  const configurationOpenRef = useRef(configurationOpen)
  configurationOpenRef.current = configurationOpen
  const openEventRoute = (ev: Event, logbook = false) => {
    if (configurationOpenRef.current) return
    const query = new URLSearchParams()
    if (currentFolderID) query.set('folder', currentFolderID)
    if (logbook) query.set('view', 'logbook')
    router.push('/dashboard/events/' + ev.id + (query.size ? '?' + query : ''))
  }
  const resetEventForm = () => { if (configurationOpen) return; setEditEvent(null); setConfigurationSection('data') }
  const openEditEvent = (ev: Event) => { if (configurationOpen) return; setConfigurationSection('data'); setEditEvent(ev) }
  const openStageConfiguration = (ev: Event) => { if (configurationOpen) return; setConfigurationSection('stages'); setEditEvent(ev) }

  const handleCancelEvent = async (ev: Event) => {
    if (cancellingEventID || isEventContextReadOnly(ev.status)) return
    if (!confirm('¿Cancelar «' + ev.name + '»? Sus participantes, observaciones y bitácoras se conservarán como historial. El evento quedará cerrado y no podrá reabrirse.')) return
    setCancellingEventID(ev.id)
    try {
      await cancelEventResource(ev, token || '')
      await Promise.all([fetchEvents(true, true), fetchFolders()])
    } catch (error) {
      alert(error instanceof Error ? error.message : 'No se pudo cancelar el evento')
    } finally { setCancellingEventID(null) }
  }

  const handleDuplicateEvent = async (id: string) => {
    if (duplicatingEventID || configurationOpenRef.current) return
    setDuplicatingEventID(id)
    try {
      const res = await fetch(`/api/events/${id}/duplicate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (!data.success || !data.event?.id) {
        alert(data.error || 'No se pudo duplicar el evento')
        return
      }
      if (configurationOpenRef.current) { await fetchEvents(true, true); return }
      router.push(`/dashboard/events/${data.event.id}`)
    } catch (e) {
      console.error('Failed to duplicate event:', e)
      alert('No se pudo duplicar el evento')
    } finally {
      setDuplicatingEventID(null)
    }
  }

  // ─── Folder CRUD ────────────────────────────────────────────────────────────

  const openCreateFolder = () => {
    setEditFolder(null)
    setFolderForm({ name: '', color: '#3b82f6', icon: '📁' })
    setShowFolderModal(true)
  }

  const openEditFolder = (folder: EventFolder, e: React.MouseEvent) => {
    e.stopPropagation()
    setEditFolder(folder)
    setFolderForm({ name: folder.name, color: folder.color, icon: folder.icon })
    setShowFolderModal(true)
  }

  const handleSaveFolder = async () => {
    try {
      const res = editFolder
        ? await fetch(`/api/events/folders/${editFolder.id}`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(folderForm),
          })
        : await fetch('/api/events/folders', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...folderForm, parent_id: currentFolderID || undefined }),
          })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) throw new Error(data.error || 'No se pudo guardar la carpeta')
      setShowFolderModal(false)
      setEditFolder(null)
      await fetchFolders()
    } catch (error) {
      alert(error instanceof Error ? error.message : 'No se pudo guardar la carpeta')
    }
  }

  const handleDeleteFolder = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirm('¿Eliminar carpeta? Los eventos se moverán a la carpeta padre.')) return
    try {
      const res = await fetch(`/api/events/folders/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.success === false) throw new Error(data.error || 'No se pudo eliminar la carpeta')
      await Promise.all([fetchFolders(), fetchEvents()])
    } catch (error) {
      alert(error instanceof Error ? error.message : 'No se pudo eliminar la carpeta')
    }
  }

  // ─── Loading ─────────────────────────────────────────────────────────────────

  if (loading && events.length === 0 && folders.length === 0) {
    return (
      <div ref={setEventsPageRef} className="flex h-64 min-w-0 flex-1 items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-600" />
      </div>
    )
  }

  // ─── Render Helpers ───────────────────────────────────────────────────────────

  const renderFolderModal = () => (
    <div className="responsive-dialog-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={() => setShowFolderModal(false)}>
      <div className="responsive-dialog-panel w-full max-w-sm overflow-y-auto rounded-xl bg-white shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="p-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))] sm:p-6">
          <h2 className="text-lg font-semibold text-slate-900 mb-4">
            {editFolder ? 'Editar carpeta' : 'Nueva carpeta'}
          </h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Nombre *</label>
              <input value={folderForm.name} onChange={e => setFolderForm({ ...folderForm, name: e.target.value })} autoFocus
                className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 text-slate-900"
                placeholder="Ej: Eventos 2025" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Ícono</label>
              <div className="flex flex-wrap gap-2">
                {FOLDER_ICONS.map(icon => (
                  <button key={icon} onClick={() => setFolderForm({ ...folderForm, icon })}
                    className={`w-11 h-11 text-xl rounded-lg border-2 transition-all flex items-center justify-center ${folderForm.icon === icon ? 'border-emerald-500 bg-emerald-50 scale-110' : 'border-transparent hover:border-slate-200 hover:bg-slate-50'}`}>
                    {icon}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Color</label>
              <div className="flex flex-wrap gap-2">
                {COLOR_OPTIONS.map(c => (
                  <button key={c} onClick={() => setFolderForm({ ...folderForm, color: c })}
                    className={`h-11 w-11 rounded-full border-2 transition-all sm:h-7 sm:w-7 ${folderForm.color === c ? 'border-slate-900 scale-110' : 'border-transparent hover:scale-105'}`}
                    style={{ backgroundColor: c }} />
                ))}
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-3 mt-6">
            <button onClick={() => setShowFolderModal(false)}
              className="min-h-11 flex-1 px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">Cancelar</button>
            <button disabled={!folderForm.name} onClick={handleSaveFolder}
              className="min-h-11 flex-1 px-6 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors">
              {editFolder ? 'Guardar' : 'Crear'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )

  const responsiveLayout = resolveEventsResponsiveLayout(viewMode, pageWidth)
  const {
    viewMode: effectiveViewMode,
    listPresentation,
    compactWorkspace,
    folderGridColumns,
    compactGridColumns,
    eventGridColumns,
  } = responsiveLayout

  // ─── JSX ─────────────────────────────────────────────────────────────────────

  return (
    <div
      ref={setEventsPageRef}
      data-events-view={effectiveViewMode}
      data-events-list-presentation={effectiveViewMode === 'list' ? listPresentation : undefined}
      className="min-h-0 min-w-0 flex-1 space-y-5 overflow-x-hidden overflow-y-auto pb-[max(1.5rem,env(safe-area-inset-bottom))]"
    >

      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Eventos</h1>
          <p className="text-slate-500 text-sm mt-0.5">Gestiona actividades y haz seguimiento a tus contactos</p>
        </div>
        <div className="flex w-full gap-2 sm:w-auto">
          <button onClick={openCreateFolder}
            className="flex min-h-11 flex-1 items-center justify-center gap-2 px-3 py-2.5 bg-white border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 transition-colors shadow-sm text-sm font-medium sm:flex-none sm:px-4">
            <FolderPlus className="w-4 h-4" />
            Nueva carpeta
          </button>
          <button disabled={configurationOpen} title={configurationOpen ? 'Cierra la configuración abierta antes de crear otro evento' : undefined} onClick={() => { if (configurationOpen) return; resetEventForm(); setShowCreate(true) }}
            className="flex min-h-11 flex-1 items-center justify-center gap-2 px-3 py-2.5 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors shadow-sm text-sm font-medium sm:flex-none sm:px-4 disabled:cursor-not-allowed disabled:opacity-40">
            <Plus className="w-4 h-4" />
            Nuevo Evento
          </button>
        </div>
      </div>

      {/* Breadcrumb */}
      {folderPath.length > 0 && (
        <nav className="flex items-center gap-1 overflow-x-auto pb-1 text-sm">
          <button onClick={() => navigateToBreadcrumb(-1)}
            className="flex items-center gap-1.5 px-2.5 py-1 text-slate-500 hover:text-emerald-700 hover:bg-emerald-50 rounded-lg transition-colors">
            <Home className="w-3.5 h-3.5" />
            <span>Eventos</span>
          </button>
          {folderPath.map((folder, i) => (
            <div key={folder.id} className="flex items-center gap-1">
              <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
              <button onClick={() => navigateToBreadcrumb(i)}
                className={`flex items-center gap-1.5 whitespace-nowrap px-2.5 py-1 rounded-lg transition-colors font-medium ${i === folderPath.length - 1 ? 'text-slate-900 bg-slate-100 cursor-default' : 'text-slate-500 hover:text-emerald-700 hover:bg-emerald-50'}`}>
                <span className="text-base leading-none">{folder.icon}</span>
                {folder.name}
              </button>
            </div>
          ))}
        </nav>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        {folderPath.length > 0 && (
          <button onClick={() => navigateToBreadcrumb(folderPath.length - 2)}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg border border-slate-200 transition-colors">
            <ArrowLeft className="w-4 h-4" />
            Atrás
          </button>
        )}
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            value={search}
            onChange={e => {
              const next = e.target.value
              eventsRequestRef.current += 1
              eventsAbortControllerRef.current?.abort()
              setSearch(next)
              if (!next) setDebouncedSearch('')
            }}
            placeholder="Buscar eventos..."
            className="w-full pl-10 pr-10 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-slate-900" />
          {searchPending && (
            <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-emerald-500" aria-label="Buscando eventos" />
          )}
        </div>
        <select aria-label="Estado de eventos" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          className="px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 text-slate-900">
          <option value="">Todos los estados</option>
          {STATUS_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        {!statusFilter && <button
          type="button"
          aria-pressed={includeCancelled}
          onClick={() => setIncludeCancelled(value => !value)}
          className={`flex min-h-11 items-center justify-center gap-1.5 px-3 py-2 border rounded-xl text-sm transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
            includeCancelled ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
          }`}
          title={includeCancelled ? 'Los resultados incluyen eventos cancelados' : 'Los resultados excluyen eventos cancelados'}
        >
          {includeCancelled ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
          Incluir cancelados
        </button>}
        <div className="flex self-stretch rounded-xl bg-slate-100 p-0.5 sm:self-auto" role="group" aria-label="Vista de eventos">
          <button type="button" data-events-view-option="grid" onClick={() => setViewMode('grid')} title="Cuadrícula" aria-label="Vista de cuadrícula" aria-pressed={viewMode === 'grid'}
            className={`flex min-h-11 min-w-11 flex-1 items-center justify-center rounded-lg transition-colors sm:flex-none ${viewMode === 'grid' ? 'bg-white text-slate-900 shadow' : 'text-slate-500 hover:text-slate-700'}`}>
            <LayoutGrid className="w-4 h-4" />
          </button>
          <button type="button" data-events-view-option="compact" onClick={() => setViewMode('compact')} title="Compacta" aria-label="Vista compacta" aria-pressed={viewMode === 'compact'}
            className={`flex min-h-11 min-w-11 flex-1 items-center justify-center rounded-lg transition-colors sm:flex-none ${viewMode === 'compact' ? 'bg-white text-slate-900 shadow' : 'text-slate-500 hover:text-slate-700'}`}>
            <LayoutTemplate className="w-4 h-4" />
          </button>
          <button type="button" data-events-view-option="list" onClick={() => setViewMode('list')} title="Lista" aria-label="Vista de lista" aria-pressed={viewMode === 'list'}
            className={`flex min-h-11 min-w-11 flex-1 items-center justify-center rounded-lg transition-colors sm:flex-none ${viewMode === 'list' ? 'bg-white text-slate-900 shadow' : 'text-slate-500 hover:text-slate-700'}`}>
            <List className="w-4 h-4" />
          </button>
        </div>
      </div>

      {eventsError && (
        <div className="flex flex-col gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 sm:flex-row sm:items-center sm:justify-between" role="alert">
          <span>{eventsError}. Conservamos los datos que ya estaban cargados.</span>
          <button
            type="button"
            onClick={() => { setLoading(true); void fetchEvents(true) }}
            className="min-h-11 shrink-0 rounded-lg border border-red-300 bg-white px-4 font-semibold text-red-700 hover:bg-red-100"
          >
            Reintentar
          </button>
        </div>
      )}

      {/* ─── Folders section ──────────────────────────────────────────────────── */}
      {visibleFolders.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Carpetas</p>
          <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${folderGridColumns}, minmax(0, 1fr))` }}>
            {visibleFolders.map(folder => (
              <div key={folder.id}
                onDragOver={e => handleFolderDragOver(e, folder.id)}
                onDragLeave={() => setDragOverFolderID(null)}
                onDrop={e => handleFolderDrop(e, folder.id)}
                onClick={() => navigateIntoFolder(folder)}
                className={`relative group bg-white border-2 rounded-xl p-4 cursor-pointer transition-all select-none ${
                  dragOverFolderID === folder.id
                    ? 'border-emerald-400 bg-emerald-50 shadow-md scale-[1.02]'
                    : 'border-slate-200 hover:border-slate-300 hover:shadow-sm'
                }`}>
                <div className="absolute top-0 left-0 right-0 h-1 rounded-t-xl" style={{ backgroundColor: folder.color }} />
                <div className="flex items-start justify-between mt-1">
                  <span className="text-3xl leading-none">{folder.icon}</span>
                  <button
                    data-menu-toggle
                    onClick={e => { e.stopPropagation(); setMenuEventID(menuEventID === `f-${folder.id}` ? null : `f-${folder.id}`) }}
                    className="touch-action-visible flex h-11 w-11 items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg opacity-100 transition-all lg:h-auto lg:w-auto lg:p-1 lg:opacity-0 lg:group-hover:opacity-100" aria-label={`Acciones de la carpeta ${folder.name}`}>
                    <MoreHorizontal className="w-4 h-4" />
                  </button>
                </div>
                <p className="mt-2 text-sm font-semibold text-slate-800 truncate">{folder.name}</p>
                <p className="text-xs text-slate-400 mt-0.5">{folder.event_count} evento{folder.event_count !== 1 ? 's' : ''}</p>
                {menuEventID === `f-${folder.id}` && (
                  <div className={compactWorkspace
                    ? 'fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-[70] max-h-[70vh] overflow-y-auto rounded-2xl border border-slate-200 bg-white py-1 shadow-2xl'
                    : 'absolute right-2 top-8 z-20 min-w-[160px] rounded-xl border border-slate-200 bg-white py-1 shadow-lg'
                  } onClick={e => e.stopPropagation()}>
                    <button onClick={e => openEditFolder(folder, e)}
                      className="w-full flex min-h-11 items-center gap-2 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">
                      <Edit2 className="w-3.5 h-3.5" /> Editar
                    </button>
                    <button onClick={e => handleDeleteFolder(folder.id, e)}
                      className="w-full flex min-h-11 items-center gap-2 px-4 py-2 text-sm text-red-600 hover:bg-red-50">
                      <Trash2 className="w-3.5 h-3.5" /> Eliminar
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Events section label */}
      {(visibleFolders.length > 0 || folderPath.length > 0) && (
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mt-5 mb-3">
          {folderPath.length > 0 ? `Eventos en "${folderPath[folderPath.length - 1].name}"` : 'Eventos sin carpeta'}
        </p>
      )}

      {/* ─── Events ──────────────────────────────────────────────────────────── */}
      {eventsError && filteredEvents.length === 0 && visibleFolders.length === 0 ? null : filteredEvents.length === 0 && visibleFolders.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-slate-200">
          <CalendarDays className="w-12 h-12 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-500 font-medium">No hay eventos en esta vista</p>
          <p className="text-slate-400 text-sm mt-1">{debouncedSearch ? 'Prueba con otra búsqueda o cambia el estado.' : !statusFilter && !includeCancelled ? 'Puedes incluir los cancelados o crear un nuevo evento.' : 'Cambia el estado o crea un nuevo evento para empezar.'}</p>
        </div>
      ) : filteredEvents.length === 0 ? (
        <div className="text-center py-10 bg-white rounded-xl border border-dashed border-slate-200">
          <FolderOpen className="w-10 h-10 text-slate-300 mx-auto mb-2" />
          <p className="text-slate-500 text-sm">No hay eventos aquí</p>
          <p className="text-slate-400 text-xs mt-0.5">Mueve eventos desde su menú de acciones o crea uno nuevo</p>
        </div>
      ) : effectiveViewMode === 'list' ? (
        /* List View */
        <div data-events-list className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          {listPresentation === 'stacked' ? (
            <div className="p-2" data-events-stacked-list>
              <div className="mb-2 flex items-center gap-2 rounded-xl bg-slate-50 p-2">
                <label className="min-w-0 flex-1 text-[11px] font-semibold text-slate-500">
                  <span className="sr-only">Ordenar eventos por</span>
                  <select
                    aria-label="Ordenar eventos por"
                    value={sortField || 'name'}
                    onChange={event => setSortField(event.target.value)}
                    className="h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
                  >
                    <option value="name">Nombre</option>
                    <option value="status">Estado</option>
                    <option value="formula">Fórmula</option>
                    <option value="participants">Participantes</option>
                    <option value="asistentes">Asistentes</option>
                    <option value="preinscritos">Pre inscritos</option>
                    <option value="inscritos">Inscritos</option>
                  </select>
                </label>
                <button
                  type="button"
                  onClick={() => setSortDirection(direction => direction === 'asc' ? 'desc' : 'asc')}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:border-emerald-300 hover:text-emerald-700"
                  aria-label={sortDirection === 'asc' ? 'Orden ascendente; cambiar a descendente' : 'Orden descendente; cambiar a ascendente'}
                  title={sortDirection === 'asc' ? 'Ascendente' : 'Descendente'}
                >
                  {sortDirection === 'asc' ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}
                </button>
              </div>
              <div role="list" aria-label="Eventos en vista de lista" className="space-y-2">
                {sortedEvents.map(ev => {
                  const statusOpt = STATUS_OPTIONS.find(option => option.value === ev.status)
                  const hasFormula = Boolean(ev.tag_formula || (ev.tags && ev.tags.length > 0))
                  return (
                    <article key={ev.id} role="listitem" className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
                      <button
                        type="button"
                        disabled={configurationOpen} title={configurationOpen ? 'Cierra la configuración abierta antes de navegar' : undefined} onClick={() => openEventRoute(ev)}
                        className="w-full p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-50 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500"
                        aria-label={`Abrir evento ${ev.name}`}
                      >
                        <span className="flex items-start gap-2.5">
                          <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: ev.color }} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-semibold text-slate-900">{ev.name}</span>
                            {ev.description && <span className="mt-0.5 block line-clamp-2 text-xs leading-5 text-slate-500">{ev.description}</span>}
                          </span>
                          {statusOpt && <span className={`${statusOpt.color} shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold`}>{statusOpt.label}</span>}
                        </span>
                        <div className="mt-3 flex items-center justify-between gap-3 text-xs text-slate-500"><span>{ev.total_participants.toLocaleString('es-PE')} participantes</span>{ev.event_date && <span>{format(new Date(ev.event_date), 'd MMM', {locale: es})}</span>}</div>
                        <div className="mt-3"><EventStageSummary stages={ev.stage_summary} total={ev.total_participants}/></div>
                      </button>
                      <div className="flex items-center justify-end border-t border-slate-100 px-2 py-1">
                        <EventListActions configurationOpen={configurationOpen} name={ev.name} readOnly={isEventContextReadOnly(ev.status)} busy={duplicatingEventID===ev.id || cancellingEventID===ev.id} folders={folders} folderID={ev.folder_id}
                          onConfigure={()=>openEditEvent(ev)} onStages={()=>openStageConfiguration(ev)} onLogbooks={()=>openEventRoute(ev,true)}
                          onDuplicate={()=>{void handleDuplicateEvent(ev.id)}} onCancel={()=>{void handleCancelEvent(ev)}} onMove={id=>{void moveEventToFolder(ev.id,id)}}/>
                      </div>
                    </article>
                  )
                })}
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto" data-events-table-list>
              <table className="w-full min-w-[720px] text-sm">
                <thead><tr className="border-b border-slate-200 bg-slate-50/80">
                  {[['name','Evento'],['status','Estado'],['participants','Participantes']].map(([key,label]) => <th key={key} scope="col" aria-sort={sortField===key ? (sortDirection==='asc'?'ascending':'descending'):'none'} className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500"><button onClick={()=>toggleSort(key)} className="inline-flex items-center gap-1">{label}<SortIcon field={key}/></button></th>)}
                  <th scope="col" className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">Distribución por etapa</th>
                  <th scope="col" className="w-14"><span className="sr-only">Acciones</span></th>
                </tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {sortedEvents.map(ev => {
                    const statusOpt=STATUS_OPTIONS.find(s=>s.value===ev.status)
                    return <tr key={ev.id} className="group hover:bg-slate-50/70">
                      <td className="max-w-[340px] px-4 py-4"><button className="flex w-full items-start gap-3 text-left disabled:cursor-not-allowed disabled:opacity-50" disabled={configurationOpen} title={configurationOpen ? 'Cierra la configuración abierta antes de navegar' : undefined} onClick={()=>openEventRoute(ev)}>
                        <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full" style={{backgroundColor:ev.color}}/>
                        <span className="min-w-0"><span className="block font-semibold text-slate-800 group-hover:text-emerald-700">{ev.name}</span><span className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-400">{ev.event_date && <span>{format(new Date(ev.event_date),'d MMM yyyy',{locale:es})}</span>}{ev.location && <span>{ev.location}</span>}</span></span>
                      </button></td>
                      <td className="px-4 py-4"><span className={`${statusOpt?.color} inline-flex rounded-full px-2 py-1 text-[11px] font-medium`}>{statusOpt?.label ?? ev.status}</span></td>
                      <td className="px-4 py-4 font-semibold tabular-nums text-slate-700">{ev.total_participants.toLocaleString('es-PE')}</td>
                      <td className="w-[42%] px-4 py-4"><EventStageSummary stages={ev.stage_summary} total={ev.total_participants}/></td>
                      <td className="px-2"><EventListActions configurationOpen={configurationOpen} name={ev.name} readOnly={isEventContextReadOnly(ev.status)} busy={duplicatingEventID===ev.id || cancellingEventID===ev.id} folders={folders} folderID={ev.folder_id}
                        onConfigure={()=>openEditEvent(ev)} onStages={()=>openStageConfiguration(ev)} onLogbooks={()=>openEventRoute(ev,true)}
                        onDuplicate={()=>{void handleDuplicateEvent(ev.id)}} onCancel={()=>{void handleCancelEvent(ev)}} onMove={id=>{void moveEventToFolder(ev.id,id)}}/></td>
                    </tr>
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <div className="grid gap-4" style={{gridTemplateColumns:`repeat(${effectiveViewMode === 'compact' ? compactGridColumns : eventGridColumns}, minmax(0, 1fr))`}}>
          {filteredEvents.map(ev => {
            const statusOpt=STATUS_OPTIONS.find(s=>s.value===ev.status)
            return <article key={ev.id} className="flex min-w-0 flex-col rounded-xl border border-slate-200 bg-white transition hover:border-slate-300 hover:shadow-sm">
              <div className="h-1 rounded-t-xl" style={{backgroundColor:ev.color}}/>
              <div className="flex items-start justify-between gap-2 px-4 pt-3">
                <button disabled={configurationOpen} title={configurationOpen ? 'Cierra la configuración abierta antes de navegar' : undefined} onClick={()=>openEventRoute(ev)} className="min-w-0 flex-1 py-1 text-left text-sm font-semibold leading-6 text-slate-900 hover:text-emerald-700 disabled:cursor-not-allowed disabled:opacity-50">{ev.name}</button>
                <EventListActions configurationOpen={configurationOpen} name={ev.name} readOnly={isEventContextReadOnly(ev.status)} busy={duplicatingEventID===ev.id || cancellingEventID===ev.id} folders={folders} folderID={ev.folder_id}
                  onConfigure={()=>openEditEvent(ev)} onStages={()=>openStageConfiguration(ev)} onLogbooks={()=>openEventRoute(ev,true)}
                  onDuplicate={()=>{void handleDuplicateEvent(ev.id)}} onCancel={()=>{void handleCancelEvent(ev)}} onMove={id=>{void moveEventToFolder(ev.id,id)}}/>
              </div>
              <div className="flex flex-1 flex-col gap-3 px-4 pb-4">
                <div className="flex flex-wrap items-center gap-2"><span className={`${statusOpt?.color} rounded-full px-2 py-1 text-[10px] font-semibold`}>{statusOpt?.label}</span>{ev.event_date&&<span className="text-xs text-slate-400">{format(new Date(ev.event_date),'d MMM yyyy',{locale:es})}</span>}</div>
                {effectiveViewMode!=='compact'&&ev.description&&<p className="line-clamp-2 text-xs leading-5 text-slate-500">{ev.description}</p>}
                <FormulaTagDisplay ev={ev} maxTags={2} size="xs"/>
                <div className="mt-auto border-t border-slate-100 pt-3"><div className="mb-3 flex items-baseline gap-1.5"><span className="text-lg font-semibold tabular-nums text-slate-800">{ev.total_participants.toLocaleString('es-PE')}</span><span className="text-xs text-slate-400">participantes</span></div><EventStageSummary stages={ev.stage_summary} total={ev.total_participants}/></div>
              </div>
            </article>
          })}
        </div>
      )}

      {/* Loading more indicator */}
      {loadingMore && (
        <div className="flex items-center justify-center py-4">
          <div className="w-5 h-5 border-2 border-emerald-600 border-t-transparent rounded-full animate-spin" />
          <span className="ml-2 text-sm text-slate-500">Cargando más eventos...</span>
        </div>
      )}
      {!hasMore && events.length > 0 && total > EVENTS_PAGE_SIZE && (
        <p className="text-center text-xs text-slate-400 py-2">{total} eventos cargados</p>
      )}

      {/* Drop zone to move events back to parent when inside a folder */}
      {folderPath.length > 0 && (
        <div
          onDragOver={e => { e.preventDefault(); setDragOverFolderID('__root__') }}
          onDragLeave={() => setDragOverFolderID(null)}
          onDrop={async e => {
            e.preventDefault()
            setDragOverFolderID(null)
            const eventID = e.dataTransfer.getData('application/x-clarin-event') || dragEventIDRef.current
            if (!eventID) return
            dragEventIDRef.current = null
            await moveEventToFolder(eventID, folderPath.length > 1 ? folderPath[folderPath.length - 2].id : null)
          }}
          className={`mt-4 hidden items-center justify-center gap-2 px-6 py-4 border-2 border-dashed rounded-xl transition-all text-sm md:flex ${
            dragOverFolderID === '__root__'
              ? 'border-emerald-400 bg-emerald-50 text-emerald-600'
              : 'border-slate-200 text-slate-400 hover:border-slate-300'
          }`}>
          <ArrowLeft className="w-4 h-4" />
          Suelta aquí para mover a «{folderPath.length > 1 ? folderPath[folderPath.length - 2].name : 'Raíz'}»
        </div>
      )}

      {/* Modals */}
      <EventConfigurationWindow open={showCreate || !!editEvent} eventId={editEvent?.id} initialSection={configurationSection} folderId={currentFolderID}
        onClose={() => { setShowCreate(false); setEditEvent(null) }}
        onCreated={() => { void fetchEvents() }}
        onSaved={async () => { await fetchEvents(true, true) }} />
      {showFolderModal && renderFolderModal()}
    </div>
  )
}
