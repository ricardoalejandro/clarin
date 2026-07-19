'use client'

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  Search, Phone, PhoneOff, Mail, Building2, Tag, Edit, Trash2, RefreshCw,
  ChevronDown, CheckSquare, Square, XCircle, MoreVertical, MoreHorizontal,
  Users, Merge, Eye, X, Smartphone, MessageSquare, Send,
  Clock, Plus, FileText, Maximize2, CalendarDays, Upload, Calendar, User, Save, Edit2, Filter, Radio,
  UserPlus, ClipboardPaste, Hash, Code, Download, CheckCircle2, ExternalLink, ArrowUpDown, ChevronUp, Cloud, Settings
} from 'lucide-react'
import { formatDistanceToNow, format } from 'date-fns'
import { es } from 'date-fns/locale'
import ImportCSVModal from '@/components/ImportCSVModal'
import TagInput from '@/components/TagInput'
import CreateCampaignModal, { CampaignFormResult } from '@/components/CreateCampaignModal'
import CreateContactModal from '@/components/CreateContactModal'
import PasteFromExcelModal from '@/components/PasteFromExcelModal'
import LeadDetailPanel from '@/components/LeadDetailPanel'
import ChatPanel from '@/components/chat/ChatPanel'
import FormulaEditor from '@/components/FormulaEditor'
import BulkGenerateDocumentModal from '@/components/BulkGenerateDocumentModal'
import { useAccessibleDialog } from '@/components/pipelines/useAccessibleDialog'
import { useContainerWidth } from '@/components/responsive/useContainerWidth'
import { subscribeWebSocket } from '@/lib/api'
import { createWhatsAppChat, deviceDisplayPhone, relationClassName, relationLabel, resolveWhatsAppChat, type WhatsAppDeviceOption } from '@/lib/whatsappChatLauncher'
import type { Lead } from '@/types/contact'
import type { Chat } from '@/types/chat'
import type { CustomFieldDefinition, CustomFieldValue, CustomFieldFilter } from '@/types/custom-field'

interface ContactDeviceName {
  id: string
  contact_id: string
  device_id: string
  name: string | null
  push_name: string | null
  business_name: string | null
  device_name: string | null
  synced_at: string
}

interface StructuredTag {
  id: string
  account_id: string
  name: string
  color: string
}

interface Contact {
  id: string
  account_id: string
  device_id: string | null
  jid: string
  phone: string | null
  name: string | null
  last_name: string | null
  short_name: string | null
  custom_name: string | null
  push_name: string | null
  avatar_url: string | null
  email: string | null
  company: string | null
  age: number | null
  dni: string | null
  birth_date: string | null
  address: string | null
  distrito: string | null
  ocupacion: string | null
  tags: string[] | null
  structured_tags: StructuredTag[] | null
  notes: string | null
  source: string | null
  is_group: boolean
  kommo_id: number | null
  created_at: string
  updated_at: string
  last_activity: string | null
  lead_count?: number
  device_names?: ContactDeviceName[]
  google_sync?: boolean
  google_synced_at?: string | null
  google_sync_error?: string | null
}

interface ContactRelationCounts {
  leads: number
  chats: number
  tasks: number
  interactions: number
  events: number
  programs: number
  campaign_recipients: number
  custom_fields: number
  tags: number
}

interface DuplicateCandidate {
  contact: Contact
  counts: ContactRelationCounts
}

interface DuplicateGroup {
  group_key: string
  normalized_phone: string
  confidence: string
  reason: string
  recommended_keep_id: string
  contacts: DuplicateCandidate[]
}

interface MergePreview {
  keep_id: string
  merge_ids: string[]
  fields: { field: string; label: string; final_value?: string | null; conflict: boolean; candidates?: string[] }[]
  leads: {
    id: string
    contact_id: string
    name?: string | null
    phone?: string | null
    pipeline_name?: string | null
    stage_name?: string | null
    is_archived: boolean
    is_blocked: boolean
    created_at: string
  }[]
  counts: ContactRelationCounts
  warnings?: string[]
}

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

function getDisplayName(c: Contact): string {
  return c.custom_name || c.name || c.push_name || c.phone || c.jid || '?'
}

function getInitials(c: Contact): string {
  const name = getDisplayName(c)
  if (!name || name === '?') return '?'
  // Filter to only letters/digits for initials
  const cleaned = name.replace(/[^a-zA-Z0-9\s\u00C0-\u024F]/g, '').trim()
  if (!cleaned) return name.charAt(0).toUpperCase()
  const parts = cleaned.split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return cleaned.substring(0, 2).toUpperCase()
}

function getRelationTotal(counts?: ContactRelationCounts): number {
  if (!counts) return 0
  return counts.leads + counts.chats + counts.tasks + counts.interactions + counts.events + counts.programs + counts.campaign_recipients + counts.custom_fields + counts.tags
}

function normalizeDuplicateGroups(raw: any[]): DuplicateGroup[] {
  return (raw || []).map((group: any, index: number) => {
    if (Array.isArray(group)) {
      const contacts = group as Contact[]
      return {
        group_key: `legacy-${index}`,
        normalized_phone: contacts[0]?.phone || '',
        confidence: 'high',
        reason: 'same_phone',
        recommended_keep_id: contacts[0]?.id || '',
        contacts: contacts.map(contact => ({
          contact,
          counts: { leads: contact.lead_count || 0, chats: 0, tasks: 0, interactions: 0, events: 0, programs: 0, campaign_recipients: 0, custom_fields: 0, tags: contact.structured_tags?.length || contact.tags?.length || 0 },
        })),
      }
    }
    return group as DuplicateGroup
  })
}

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

function contactToLead(c: Contact): Lead {
  return {
    id: c.id,
    account_id: c.account_id,
    contact_id: c.id,
    jid: c.jid,
    name: c.custom_name ?? c.name ?? c.push_name ?? null,
    last_name: c.last_name ?? null,
    short_name: c.short_name ?? null,
    phone: c.phone ?? null,
    email: c.email ?? null,
    company: c.company ?? null,
    age: c.age ?? null,
    dni: c.dni ?? null,
    birth_date: c.birth_date ?? null,
    address: c.address ?? null,
    distrito: c.distrito ?? null,
    ocupacion: c.ocupacion ?? null,
    notes: c.notes ?? null,
    tags: c.tags || null,
    structured_tags: c.structured_tags || null,
    status: 'active',
    source: c.source ?? null,
    pipeline_id: null,
    stage_id: null,
    stage_name: null,
    stage_color: null,
    stage_position: null,
    kommo_id: c.kommo_id ?? null,
    is_archived: false,
    is_blocked: false,
    archived_at: null,
    blocked_at: null,
    block_reason: null,
    assigned_to: null,
    assigned_to_name: null,
    custom_fields: null,
    created_at: c.created_at,
    updated_at: c.updated_at,
  } as unknown as Lead
}

export default function ContactsPage() {
  const { ref: workspaceRef, width: workspaceWidth } = useContainerWidth<HTMLDivElement>()
  const isCompactWorkspace = workspaceWidth > 0 && workspaceWidth < 1024
  const kommoEnabled = typeof window !== 'undefined' && localStorage.getItem('kommo_enabled') === 'true'
  const [contacts, setContacts] = useState<Contact[]>([])
  const [devices, setDevices] = useState<Device[]>([])
  const [loading, setLoading] = useState(true)
  const [contactsError, setContactsError] = useState('')
  const [total, setTotal] = useState(0)
  const [searchTerm, setSearchTerm] = useState('')
  const [filterDevice, setFilterDevice] = useState('')
  const [allTags, setAllTags] = useState<StructuredTag[]>([])

  // Advanced filter state
  const [showFilterDropdown, setShowFilterDropdown] = useState(false)
  const [filterTagNames, setFilterTagNames] = useState<Set<string>>(new Set())
  const [excludeFilterTagNames, setExcludeFilterTagNames] = useState<Set<string>>(new Set())
  const [tagFilterMode, setTagFilterMode] = useState<'OR' | 'AND'>('OR')
  const [tagSearchTerm, setTagSearchTerm] = useState('')
  const [leadFormulaType, setLeadFormulaType] = useState<'simple' | 'advanced'>('simple')
  const [leadFormulaText, setLeadFormulaText] = useState('')
  const [leadFormulaIsValid, setLeadFormulaIsValid] = useState(true)
  const [appliedFormulaType, setAppliedFormulaType] = useState<'simple' | 'advanced'>('simple')
  const [appliedFormulaText, setAppliedFormulaText] = useState('')
  const [filterDateField, setFilterDateField] = useState<'created_at' | 'updated_at'>('created_at')
  const [filterDatePreset, setFilterDatePreset] = useState('')
  const [filterDateFrom, setFilterDateFrom] = useState('')
  const [filterDateTo, setFilterDateTo] = useState('')
  const filterDropdownRef = useRef<HTMLDivElement>(null)
  // Infinite scroll state
  const CONTACTS_PAGE_SIZE = 50
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const offsetRef = useRef(0)
  const contactsRequestRef = useRef(0)
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  // Selection
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Detail / Edit
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null)
  const [showDetailPanel, setShowDetailPanel] = useState(false)
  const [scrollToTasks, setScrollToTasks] = useState(false)
  const [showEditModal, setShowEditModal] = useState(false)
  const [editForm, setEditForm] = useState({
    custom_name: '',
    last_name: '',
    short_name: '',
    phone: '',
    email: '',
    company: '',
    age: '',
    tags: '',
    notes: '',
    address: '',
  })

  // Duplicates
  const [showDuplicates, setShowDuplicates] = useState(false)
  const [duplicateGroups, setDuplicateGroups] = useState<DuplicateGroup[]>([])
  const [loadingDuplicates, setLoadingDuplicates] = useState(false)
  const [selectedDuplicateKey, setSelectedDuplicateKey] = useState<string | null>(null)
  const [mergeKeepByGroup, setMergeKeepByGroup] = useState<Record<string, string>>({})
  const [mergePreview, setMergePreview] = useState<MergePreview | null>(null)
  const [loadingMergePreview, setLoadingMergePreview] = useState(false)
  const [mergingGroupKey, setMergingGroupKey] = useState<string | null>(null)
  const mergePreviewRequestRef = useRef(0)

  // Sort
  const [sortBy, setSortBy] = useState('')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc')

  const [showImportModal, setShowImportModal] = useState(false)
  const [showCreateContact, setShowCreateContact] = useState(false)
  const [showPasteExcel, setShowPasteExcel] = useState(false)
  const [showBulkDocModal, setShowBulkDocModal] = useState(false)

  // Toolbar dropdown
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const [showMobileBulkMenu, setShowMobileBulkMenu] = useState(false)
  const moreMenuRef = useRef<HTMLDivElement>(null)

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setShowMoreMenu(false)
      }
      if (actionsMenuRef.current && !actionsMenuRef.current.contains(e.target as Node)) {
        setActionsMenuId(null)
      }
      if (cfColumnPickerRef.current && !cfColumnPickerRef.current.contains(e.target as Node)) {
        setShowCfColumnPicker(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Close filter dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (filterDropdownRef.current && !filterDropdownRef.current.contains(e.target as Node)) {
        setShowFilterDropdown(false)
      }
    }
    if (showFilterDropdown) {
      document.addEventListener('mousedown', handler)
      return () => document.removeEventListener('mousedown', handler)
    }
  }, [showFilterDropdown])

  // Broadcast
  const [showBroadcastModal, setShowBroadcastModal] = useState(false)
  const [submittingBroadcast, setSubmittingBroadcast] = useState(false)
  const [pendingBroadcastCampaignId, setPendingBroadcastCampaignId] = useState<string | null>(null)

  // Send message / Inline chat
  const [showSendMessage, setShowSendMessage] = useState(false)
  const [sendLoading, setSendLoading] = useState(false)
  const [whatsappPhone, setWhatsappPhone] = useState('')
  const [showInlineChat, setShowInlineChat] = useState(false)
  const [inlineChatId, setInlineChatId] = useState('')
  const [inlineChat, setInlineChat] = useState<Chat | null>(null)
  const [inlineChatDeviceId, setInlineChatDeviceId] = useState('')
  const [inlineChatReadOnly, setInlineChatReadOnly] = useState(false)
  const [existingChatForWA, setExistingChatForWA] = useState<any>(null)
  const [allDevicesForModal, setAllDevicesForModal] = useState<Device[]>([])
  const [whatsappHistoricalPhone, setWhatsappHistoricalPhone] = useState('')
  const whatsappRequestRef = useRef(0)
  const activeContactIdRef = useRef<string | null>(null)
  const contactDetailRequestRef = useRef(0)

  useEffect(() => {
    activeContactIdRef.current = selectedContact?.id || null
  }, [selectedContact?.id])

  const resetInlineChatState = useCallback(() => {
    whatsappRequestRef.current += 1
    setShowSendMessage(false)
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

  const isCurrentWhatsAppRequest = useCallback((requestId: number, contactId: string | null) => {
    return whatsappRequestRef.current === requestId && activeContactIdRef.current === contactId
  }, [])

  // Ver Leads modal
  const [showContactLeads, setShowContactLeads] = useState(false)
  const [contactLeadsTarget, setContactLeadsTarget] = useState<Contact | null>(null)
  const [contactLeads, setContactLeads] = useState<any[]>([])
  const [contactLeadsLoading, setContactLeadsLoading] = useState(false)
  const contactOpportunitiesDialogRef = useRef<HTMLDivElement>(null)
  const closeContactOpportunities = useCallback(() => {
    setShowContactLeads(false)
    setContactLeads([])
    setContactLeadsTarget(null)
  }, [])
  useAccessibleDialog(showContactLeads, contactOpportunitiesDialogRef, closeContactOpportunities)

  // Actions dropdown
  const [actionsMenuId, setActionsMenuId] = useState<string | null>(null)
  const actionsMenuRef = useRef<HTMLDivElement>(null)

  // Export
  const [showExportModal, setShowExportModal] = useState(false)
  const [exportFormat, setExportFormat] = useState<'excel' | 'csv'>('excel')
  const [exportScope, setExportScope] = useState<'all' | 'filtered'>('filtered')
  const [exporting, setExporting] = useState(false)
  const [exportIncludeTags, setExportIncludeTags] = useState(false)
  const router = useRouter()

  // Google Contacts sync
  const [googleConnected, setGoogleConnected] = useState(false)
  const [googleSyncing, setGoogleSyncing] = useState(false)

  // Custom field columns
  const [cfDefs, setCfDefs] = useState<CustomFieldDefinition[]>([])
  const [cfVisibleIds, setCfVisibleIds] = useState<Set<string>>(new Set())
  const [showCfColumnPicker, setShowCfColumnPicker] = useState(false)
  const cfColumnPickerRef = useRef<HTMLDivElement>(null)
  const [cfFilters, setCfFilters] = useState<CustomFieldFilter[]>([])

  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null

  // Virtualizer for contacts table
  const contactsVirtualizer = useVirtualizer({
    count: contacts.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 56,
    overscan: 15,
  })

  const fetchContacts = useCallback(async (reset: boolean = true) => {
    if (!token) return
    const offset = reset ? 0 : offsetRef.current
    if (reset) {
      setLoading(true)
    } else {
      setLoadingMore(true)
    }
    const requestId = ++contactsRequestRef.current
    if (reset) setContactsError('')
    try {
      const params = new URLSearchParams()
      if (searchTerm) params.set('search', searchTerm)
      if (filterDevice) params.set('device_id', filterDevice)

      // Advanced filter: formula or simple tag filter
      if (appliedFormulaType === 'advanced' && appliedFormulaText) {
        params.set('tag_formula', appliedFormulaText)
      } else {
        if (filterTagNames.size > 0) params.set('tag_names', Array.from(filterTagNames).join(','))
        if (excludeFilterTagNames.size > 0) params.set('exclude_tag_names', Array.from(excludeFilterTagNames).join(','))
        if (filterTagNames.size > 0 || excludeFilterTagNames.size > 0) params.set('tag_mode', tagFilterMode)
      }

      // Date filter
      if (filterDatePreset) {
        const resolved = resolveDatePreset(filterDatePreset, filterDateFrom, filterDateTo)
        if (resolved) {
          params.set('date_field', filterDateField)
          if (resolved.from) params.set('date_from', resolved.from)
          if (resolved.to) params.set('date_to', resolved.to)
        }
      }

      params.set('limit', String(CONTACTS_PAGE_SIZE))
      params.set('offset', String(offset))
      params.set('has_phone', 'false')
      if (sortBy) {
        params.set('sort_by', sortBy)
        params.set('sort_order', sortOrder)
      }
      if (cfVisibleIds.size > 0) {
        params.set('include_custom_fields', 'true')
      }
      if (cfFilters.length > 0) {
        params.set('cf_filter', JSON.stringify(cfFilters))
      }

      const res = await fetch(`/api/contacts?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json().catch(() => ({}))
      if (requestId !== contactsRequestRef.current) return
      if (!res.ok || !data.success) throw new Error(data.error || 'No se pudieron cargar los contactos')
      if (data.success) {
        const newContacts: Contact[] = data.contacts || []
        const serverTotal: number = data.total ?? 0
        setTotal(serverTotal)

        if (reset) {
          setContacts(newContacts)
          offsetRef.current = newContacts.length
        } else {
          setContacts(prev => {
            const existingIds = new Set(prev.map(c => c.id))
            const unique = newContacts.filter(c => !existingIds.has(c.id))
            return [...prev, ...unique]
          })
          offsetRef.current = offset + newContacts.length
        }
        setHasMore((offset + newContacts.length) < serverTotal)
        setContactsError('')
      }
    } catch (err) {
      if (requestId !== contactsRequestRef.current) return
      console.error('Failed to fetch contacts:', err)
      setContactsError(err instanceof Error ? err.message : 'No se pudieron cargar los contactos')
    } finally {
      if (requestId === contactsRequestRef.current) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, searchTerm, filterDevice, appliedFormulaType, appliedFormulaText, filterTagNames, excludeFilterTagNames, tagFilterMode, filterDatePreset, filterDateField, filterDateFrom, filterDateTo, sortBy, sortOrder, cfVisibleIds, cfFilters])

  const loadMoreContacts = useCallback(() => {
    if (loadingMore || !hasMore) return
    fetchContacts(false)
  }, [loadingMore, hasMore, fetchContacts])

  const handleContactsScroll = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el || !hasMore || loadingMore) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 300) {
      loadMoreContacts()
    }
  }, [hasMore, loadingMore, loadMoreContacts])

  const fetchDevices = useCallback(async () => {
    if (!token) return
    try {
      const res = await fetch('/api/devices', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        setDevices(data.devices || [])
      }
    } catch (err) {
      console.error('Failed to fetch devices:', err)
    }
  }, [token])

  const fetchAllTags = useCallback(async () => {
    if (!token) return
    try {
      const res = await fetch('/api/tags', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        setAllTags(data.tags || [])
      }
    } catch (err) {
      console.error('Failed to fetch tags:', err)
    }
  }, [token])

  useEffect(() => {
    fetchDevices()
    fetchAllTags()
    // Fetch custom field definitions
    if (token) {
      fetch('/api/custom-fields', { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.json())
        .then(d => {
          if (d.success) {
            const defs: CustomFieldDefinition[] = d.definitions || []
            setCfDefs(defs)
            // Restore visible columns from localStorage
            try {
              const saved = localStorage.getItem('cf_columns_contacts')
              if (saved) {
                const ids: string[] = JSON.parse(saved)
                const validIds = ids.filter(id => defs.some(d => d.id === id))
                setCfVisibleIds(new Set(validIds))
              }
            } catch {}
          }
        })
        .catch(() => {})
    }
    if (token) {
      // Check Google Contacts status
      fetch('/api/google/status', { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.json())
        .then(d => { if (d.success) setGoogleConnected(d.connected || false) })
        .catch(() => {})
    }
  }, [fetchDevices, fetchAllTags])

  // Custom field column toggle
  const toggleCfColumn = useCallback((fieldId: string) => {
    setCfVisibleIds(prev => {
      const next = new Set(prev)
      if (next.has(fieldId)) next.delete(fieldId)
      else next.add(fieldId)
      localStorage.setItem('cf_columns_contacts', JSON.stringify(Array.from(next)))
      return next
    })
  }, [])

  // Format custom field value for table cell
  const formatCfCell = useCallback((def: CustomFieldDefinition, contact: Contact) => {
    const vals: CustomFieldValue[] = (contact as any).custom_field_values || []
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

  // WebSocket listener for custom field definition updates
  useEffect(() => {
    const unsubscribe = subscribeWebSocket((data: unknown) => {
      const msg = data as { event?: string }
      if (msg.event === 'contact_update') {
        void fetchContacts(true)
      } else if (msg.event === 'custom_field_def_update') {
        if (token) {
          fetch('/api/custom-fields', { headers: { Authorization: `Bearer ${token}` } })
            .then(r => r.json())
            .then(d => { if (d.success) setCfDefs(d.definitions || []) })
            .catch(() => {})
        }
      }
    })
    return () => unsubscribe()
  }, [fetchContacts, token])

  // Debounced fetch: resets scroll to top on filter/search change
  const [debouncedSearch, setDebouncedSearch] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchTerm), 500)
    return () => clearTimeout(timer)
  }, [searchTerm])

  // Debounce tag filter changes to prevent flickering
  const [debouncedTagNames, setDebouncedTagNames] = useState<Set<string>>(new Set())
  const [debouncedExcludeTagNames, setDebouncedExcludeTagNames] = useState<Set<string>>(new Set())
  const [debouncedTagMode, setDebouncedTagMode] = useState<'OR' | 'AND'>('OR')
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedTagNames(filterTagNames)
      setDebouncedExcludeTagNames(excludeFilterTagNames)
      setDebouncedTagMode(tagFilterMode)
    }, 500)
    return () => clearTimeout(timer)
  }, [filterTagNames, excludeFilterTagNames, tagFilterMode])

  useEffect(() => {
    offsetRef.current = 0
    fetchContacts(true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, filterDevice, appliedFormulaType, appliedFormulaText, debouncedTagNames, debouncedExcludeTagNames, debouncedTagMode, filterDatePreset, filterDateField, filterDateFrom, filterDateTo, sortBy, sortOrder])

  // Auto-open contact detail from URL params (e.g. ?contact_id=UUID&scroll=tasks)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const cId = params.get('contact_id')
    const scroll = params.get('scroll')
    if (!cId) return

    // Clear URL params to avoid re-triggering
    window.history.replaceState({}, '', window.location.pathname)

    const fetchAndOpenContact = async () => {
      try {
        const token = localStorage.getItem('token')
        const res = await fetch(`/api/contacts/${cId}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        const data = await res.json()
        if (data.success && data.contact) {
          resetInlineChatState()
          setSelectedContact(data.contact)
          setShowDetailPanel(true)
          if (scroll === 'tasks') setScrollToTasks(true)
        }
      } catch { /* ignore */ }
    }
    fetchAndOpenContact()
  }, [resetInlineChatState])

  // Lock body scroll when detail panel is open
  useEffect(() => {
    if (showDetailPanel) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [showDetailPanel])

  // Close modals on Escape (topmost first)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (showMobileBulkMenu) { setShowMobileBulkMenu(false); return }
      if (actionsMenuId) { setActionsMenuId(null); return }
      if (showMoreMenu) { setShowMoreMenu(false); return }
      if (showFilterDropdown) { setShowFilterDropdown(false); return }
      if (showSendMessage) { resetInlineChatState(); return }
      if (showDuplicates) { setShowDuplicates(false); return }
      if (showEditModal) { setShowEditModal(false); setSelectedContact(null); return }
      if (showInlineChat) { resetInlineChatState(); return }
      if (showDetailPanel) { setShowDetailPanel(false); resetInlineChatState(); return }
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [actionsMenuId, resetInlineChatState, showFilterDropdown, showMobileBulkMenu, showMoreMenu, showSendMessage, showDuplicates, showEditModal, showInlineChat, showDetailPanel])

  const openDetail = async (contact: Contact) => {
    resetInlineChatState()
    const requestId = ++contactDetailRequestRef.current
    activeContactIdRef.current = contact.id
    setSelectedContact(contact)
    setShowDetailPanel(true)
    // Fetch full contact with device names
    try {
      const res = await fetch(`/api/contacts/${contact.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (requestId === contactDetailRequestRef.current && activeContactIdRef.current === contact.id && data.success) {
        setSelectedContact(data.contact)
      }
    } catch { /* Keep the list projection already shown in the panel. */ }
  }

  const openEditModal = (contact: Contact) => {
    setSelectedContact(contact)
    setEditForm({
      custom_name: contact.custom_name || '',
      last_name: contact.last_name || '',
      short_name: contact.short_name || '',
      phone: contact.phone || '',
      email: contact.email || '',
      company: contact.company || '',
      age: contact.age ? String(contact.age) : '',
      tags: (contact.tags || []).join(', '),
      notes: contact.notes || '',
      address: contact.address || '',
    })
    setShowEditModal(true)
  }

  const handleUpdateContact = async () => {
    if (!selectedContact) return
    try {
      const res = await fetch(`/api/contacts/${selectedContact.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          custom_name: editForm.custom_name || null,
          last_name: editForm.last_name || null,
          short_name: editForm.short_name || null,
          phone: editForm.phone || null,
          email: editForm.email || null,
          company: editForm.company || null,
          age: editForm.age ? parseInt(editForm.age) : null,
          tags: editForm.tags.split(',').map(t => t.trim()).filter(Boolean),
          notes: editForm.notes || null,
          address: editForm.address || null,
        }),
      })
      const data = await res.json()
      if (data.success) {
        setShowEditModal(false)
        fetchContacts()
        if (showDetailPanel && data.contact) {
          setSelectedContact(data.contact)
        }
      } else {
        alert(data.error || 'Error al actualizar contacto')
      }
    } catch {
      alert('Error de conexión')
    }
  }


  const handleDeleteContact = async (contactId: string) => {
    if (!confirm('¿Eliminar este contacto? También se eliminarán sus leads, chats y mensajes. Esta acción no se puede deshacer.')) return
    try {
      const res = await fetch(`/api/contacts/${contactId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        setShowDetailPanel(false)
        setSelectedContact(null)
        fetchContacts()
      }
    } catch {
      alert('Error de conexión')
    }
  }

  const handleDeleteSelected = async () => {
    if (selectedIds.size === 0) return
    if (!confirm(`¿Eliminar ${selectedIds.size} contacto(s)? También se eliminarán sus leads, chats y mensajes. Esta acción no se puede deshacer.`)) return
    try {
      const res = await fetch('/api/contacts/batch', {
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
        fetchContacts()
      }
    } catch {
      alert('Error de conexión')
    }
  }

  const toggleSelection = (id: string) => {
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelectedIds(next)
  }

  const handleGoogleBatchSync = async () => {
    if (selectedIds.size === 0 || selectedIds.size > 30) return
    setGoogleSyncing(true)
    try {
      const res = await fetch('/api/google/contacts/batch/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ contact_ids: Array.from(selectedIds) }),
      })
      const data = await res.json()
      if (data.success) {
        fetchContacts()
        setSelectedIds(new Set())
        setSelectionMode(false)
      } else {
        alert(data.error || 'Error al sincronizar')
      }
    } catch {
      alert('Error de conexión')
    } finally {
      setGoogleSyncing(false)
    }
  }

  const handleGoogleBatchDesync = async () => {
    if (selectedIds.size === 0 || selectedIds.size > 30) return
    if (!confirm(`¿Dejar de sincronizar ${selectedIds.size} contacto(s) con Google?`)) return
    setGoogleSyncing(true)
    try {
      const res = await fetch('/api/google/contacts/batch/desync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ contact_ids: Array.from(selectedIds) }),
      })
      const data = await res.json()
      if (data.success) {
        fetchContacts()
        setSelectedIds(new Set())
        setSelectionMode(false)
      } else {
        alert(data.error || 'Error al desincronizar')
      }
    } catch {
      alert('Error de conexión')
    } finally {
      setGoogleSyncing(false)
    }
  }

  const handleGoogleSyncSingle = async (contactId: string) => {
    setGoogleSyncing(true)
    try {
      const res = await fetch(`/api/google/contacts/${contactId}/sync`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        fetchContacts()
      } else {
        alert(data.error || 'Error al sincronizar')
      }
    } catch {
      alert('Error de conexión')
    } finally {
      setGoogleSyncing(false)
    }
  }

  const handleFindDuplicates = async () => {
    setLoadingDuplicates(true)
    try {
      const res = await fetch('/api/contacts/duplicates', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        const groups = normalizeDuplicateGroups(data.groups || data.duplicates || [])
        setDuplicateGroups(groups)
        const keepMap: Record<string, string> = {}
        groups.forEach(group => {
          keepMap[group.group_key] = group.recommended_keep_id || group.contacts[0]?.contact.id || ''
        })
        setMergeKeepByGroup(keepMap)
        setSelectedDuplicateKey(groups[0]?.group_key || null)
        setMergePreview(null)
        setShowDuplicates(true)
        if (groups[0]) loadMergePreview(groups[0], keepMap[groups[0].group_key])
      }
    } catch {
      alert('Error buscando duplicados')
    } finally {
      setLoadingDuplicates(false)
    }
  }

  async function loadMergePreview(group: DuplicateGroup, keepId: string) {
    const mergeIds = group.contacts.map(c => c.contact.id).filter(id => id !== keepId)
    if (!keepId || mergeIds.length === 0) {
      setMergePreview(null)
      return
    }
    const requestId = mergePreviewRequestRef.current + 1
    mergePreviewRequestRef.current = requestId
    setLoadingMergePreview(true)
    try {
      const res = await fetch('/api/contacts/merge/preview', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ keep_id: keepId, merge_ids: mergeIds }),
      })
      const data = await res.json()
      if (requestId !== mergePreviewRequestRef.current) return
      if (data.success) setMergePreview(data.preview)
      else alert(data.error || 'Error al preparar la unificación')
    } catch {
      if (requestId === mergePreviewRequestRef.current) alert('Error al preparar la unificación')
    } finally {
      if (requestId === mergePreviewRequestRef.current) setLoadingMergePreview(false)
    }
  }

  const handleMerge = async (group: DuplicateGroup) => {
    const keepId = mergeKeepByGroup[group.group_key] || group.recommended_keep_id || group.contacts[0]?.contact.id
    const mergeIds = group.contacts.map(c => c.contact.id).filter(id => id !== keepId)
    if (!keepId || mergeIds.length === 0) return
    if (!confirm(`¿Unificar ${mergeIds.length + 1} contactos?\n\nLos leads, chats, tareas e historial de los duplicados se sumarán al contacto elegido.`)) return
    setMergingGroupKey(group.group_key)
    try {
      const res = await fetch('/api/contacts/merge', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ keep_id: keepId, merge_ids: mergeIds }),
      })
      const data = await res.json()
      if (data.success) {
        fetchContacts()
        const nextGroups = duplicateGroups.filter(g => g.group_key !== group.group_key)
        setDuplicateGroups(nextGroups)
        setSelectedDuplicateKey(nextGroups[0]?.group_key || null)
        setMergePreview(null)
        if (nextGroups.length === 0) setShowDuplicates(false)
      } else {
        alert(data.error || 'Error al unificar')
      }
    } catch {
      alert('Error al unificar')
    } finally {
      setMergingGroupKey(null)
    }
  }



  const handleSendWhatsApp = async (phone: string, contactOverride?: Contact) => {
    const contactId = contactOverride?.id || activeContactIdRef.current
    if (contactOverride) activeContactIdRef.current = contactOverride.id
    resetInlineChatState()
    const requestId = whatsappRequestRef.current
    setWhatsappPhone(phone)
    try {
      const resolution = await resolveWhatsAppChat(phone)
      if (!isCurrentWhatsAppRequest(requestId, contactId)) return
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
        await handleContactDeviceSelected(resolution.devices[0] as Device, phone, requestId, contactId)
        return
      }
      if (resolution.mode === 'choose_device') {
        setAllDevicesForModal(resolution.devices as Device[])
        setShowSendMessage(true)
        return
      }
      alert('No hay dispositivos conectados para enviar')
    } catch (err) {
      if (!isCurrentWhatsAppRequest(requestId, contactId)) return
      console.error('Failed to resolve WhatsApp chat:', err)
      alert('Error de conexión')
    }
  }

  const handleContactDeviceSelected = async (
    device: Device,
    phoneOverride?: string,
    requestId: number = whatsappRequestRef.current,
    contactId: string | null = activeContactIdRef.current
  ) => {
    setShowSendMessage(false)
    setInlineChatReadOnly(false)
    try {
      const data = await createWhatsAppChat(device.id, phoneOverride || whatsappPhone)
      if (!isCurrentWhatsAppRequest(requestId, contactId)) return
      if (data.success && data.chat) {
        setInlineChatId(data.chat.id)
        setInlineChat(data.chat)
        setInlineChatDeviceId(device.id)
        setShowInlineChat(true)
      } else {
        alert(data.error || 'Error al crear conversación')
      }
    } catch {
      if (!isCurrentWhatsAppRequest(requestId, contactId)) return
      alert('Error de conexión')
    }
  }

  const handlePreviousDeviceSelected = () => {
    setShowSendMessage(false)
    if (existingChatForWA) {
      setInlineChatId(existingChatForWA.id)
      setInlineChat(existingChatForWA)
      setInlineChatDeviceId(existingChatForWA.device_id || '')
      setInlineChatReadOnly(true)
      setShowInlineChat(true)
    }
  }

  // Active filter count
  const activeFilterCount = filterTagNames.size + excludeFilterTagNames.size + (filterDevice ? 1 : 0) + (appliedFormulaType === 'advanced' && appliedFormulaText ? 1 : 0) + (filterDatePreset ? 1 : 0) + cfFilters.length
  const mobileFilterAdjustmentCount = activeFilterCount + (sortBy ? 1 : 0)

  const buildBroadcastContactFilters = () => {
    const params = new URLSearchParams()
    if (debouncedSearch) params.set('search', debouncedSearch)
    if (filterDevice) params.set('device_id', filterDevice)
    if (appliedFormulaType === 'advanced' && appliedFormulaText) {
      params.set('tag_formula', appliedFormulaText)
    } else {
      if (filterTagNames.size > 0) params.set('tag_names', Array.from(filterTagNames).join(','))
      if (excludeFilterTagNames.size > 0) params.set('exclude_tag_names', Array.from(excludeFilterTagNames).join(','))
      if (filterTagNames.size > 0 || excludeFilterTagNames.size > 0) params.set('tag_mode', tagFilterMode)
    }
    if (filterDatePreset) {
      const resolved = resolveDatePreset(filterDatePreset, filterDateFrom, filterDateTo)
      if (resolved) {
        params.set('date_field', filterDateField)
        if (resolved.from) params.set('date_from', resolved.from)
        if (resolved.to) params.set('date_to', resolved.to)
      }
    }
    if (cfFilters.length > 0) params.set('cf_filter', JSON.stringify(cfFilters))
    return params
  }

  // Filtered tags for tag browser
  const filteredTags = allTags.filter(t =>
    !tagSearchTerm.trim() || t.name.toLowerCase().includes(tagSearchTerm.trim().toLowerCase())
  )

  // Fetch leads for a contact
  const fetchContactLeads = async (contact: Contact) => {
    setContactLeadsTarget(contact)
    setShowContactLeads(true)
    setContactLeadsLoading(true)
    try {
      const res = await fetch(`/api/contacts/${contact.id}/leads`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        setContactLeads(data.leads || [])
      }
    } catch {
      console.error('Failed to fetch contact leads')
    } finally {
      setContactLeadsLoading(false)
    }
  }

  // Export contacts
  const handleExportContacts = async () => {
    setExporting(true)
    try {
      const params = new URLSearchParams()
      if (exportScope === 'filtered') {
        if (searchTerm) params.set('search', searchTerm)
        if (filterDevice) params.set('device_id', filterDevice)
        if (appliedFormulaType === 'advanced' && appliedFormulaText) {
          params.set('tag_formula', appliedFormulaText)
        } else {
          if (filterTagNames.size > 0) params.set('tag_names', Array.from(filterTagNames).join(','))
          if (excludeFilterTagNames.size > 0) params.set('exclude_tag_names', Array.from(excludeFilterTagNames).join(','))
          if (filterTagNames.size > 0 || excludeFilterTagNames.size > 0) params.set('tag_mode', tagFilterMode)
        }
        if (filterDatePreset) {
          const resolved = resolveDatePreset(filterDatePreset, filterDateFrom, filterDateTo)
          if (resolved) {
            params.set('date_field', filterDateField)
            if (resolved.from) params.set('date_from', resolved.from)
            if (resolved.to) params.set('date_to', resolved.to)
          }
        }
      }
      params.set('limit', '50000')
      params.set('offset', '0')
      params.set('has_phone', 'false')

      const res = await fetch(`/api/contacts?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (!data.success) return

      const allContacts: Contact[] = data.contacts || []
      const { utils, writeFile } = await import('xlsx')
      const rows = allContacts.map(c => {
        const row: Record<string, string> = {
          'telefono': c.phone || '',
          'nombre': getDisplayName(c),
          'apellido': c.last_name || '',
          'email': c.email || '',
          'empresa': c.company || '',
          'notas': c.notes || '',
          'dni': c.dni || '',
          'fecha_nacimiento': c.birth_date ? c.birth_date.split('T')[0] : '',
          'direccion': c.address || '',
        }
        if (exportIncludeTags) {
          row['tags'] = (c.structured_tags || []).map(t => t.name).join(', ') || (c.tags || []).join(', ')
        }
        return row
      })

      if (exportFormat === 'excel') {
        const wb = utils.book_new()
        const ws = utils.json_to_sheet(rows)
        utils.book_append_sheet(wb, ws, 'Contactos')
        writeFile(wb, `contactos_${format(new Date(), 'yyyy-MM-dd')}.xlsx`)
      } else {
        const ws = utils.json_to_sheet(rows)
        const csv = utils.sheet_to_csv(ws)
        const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `contactos_${format(new Date(), 'yyyy-MM-dd')}.csv`
        a.click()
        URL.revokeObjectURL(url)
      }
      setShowExportModal(false)
    } catch (err) {
      console.error('Export failed:', err)
      alert('Error al exportar contactos')
    } finally {
      setExporting(false)
    }
  }

  const handleCreateBroadcastFromContacts = async (formResult: CampaignFormResult) => {
    setSubmittingBroadcast(true)
    let campaignId = pendingBroadcastCampaignId
    try {
      // Create only once. Any failed downstream step leaves this same draft
      // available for a safe retry instead of creating another campaign.
      if (!campaignId) {
        const createRes = await fetch('/api/campaigns', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            name: formResult.name,
            device_id: formResult.device_id,
            message_template: formResult.message_template,
            attachments: formResult.attachments,
            settings: formResult.settings,
          }),
        })
        const createData = await createRes.json()
        if (!createRes.ok || !createData.success || !createData.campaign?.id) {
          throw new Error(createData.error || 'No se pudo crear la campaña')
        }
        campaignId = createData.campaign.id
        setPendingBroadcastCampaignId(campaignId)
      }

      // Spreadsheet rows become real Contacts before the filtered set is
      // resolved. The unique campaign/contact index prevents retry duplicates.
      if (formResult.recipients && formResult.recipients.length > 0) {
        const sheetRecipients = formResult.recipients.map(r => ({
          jid: r.phone + '@s.whatsapp.net',
          name: r.name || '',
          phone: r.phone,
          metadata: r.metadata || {},
        }))
        const sheetRes = await fetch(`/api/campaigns/${campaignId}/recipients`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ recipients: sheetRecipients, save_as_contacts: true }),
        })
        const sheetData = await sheetRes.json()
        if (!sheetRes.ok || !sheetData.success) {
          throw new Error(sheetData.error || 'No se pudieron agregar los teléfonos pegados')
        }
      }

      const filterParams = buildBroadcastContactFilters()
      const recipientsRes = await fetch(`/api/campaigns/${campaignId}/recipients/from-contacts?${filterParams.toString()}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const recipientsData = await recipientsRes.json()
      if (!recipientsRes.ok || !recipientsData.success) {
        throw new Error(recipientsData.error || 'No se pudieron agregar los contactos filtrados')
      }

      // Scheduling is deliberately last: a campaign cannot become scheduled
      // until the backend confirms that it has persisted recipients.
      if (formResult.scheduled_at) {
        const scheduleRes = await fetch(`/api/campaigns/${campaignId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ status: 'scheduled', scheduled_at: formResult.scheduled_at }),
        })
        const scheduleData = await scheduleRes.json()
        if (!scheduleRes.ok || !scheduleData.success) {
          throw new Error(scheduleData.error || 'Los destinatarios se guardaron, pero no se pudo programar la campaña')
        }
      }

      setPendingBroadcastCampaignId(null)
      setShowBroadcastModal(false)
      const excluded = Number(recipientsData.excluded_count || 0)
      const totalRecipients = Number(recipientsData.total_recipients || 0)
      alert(
        excluded > 0
          ? `Campaña creada con ${totalRecipients} destinatarios. ${excluded} contacto(s) fueron excluidos por no tener teléfono o estar marcados como “No contactar”.`
          : `Campaña creada con ${totalRecipients} destinatarios.`,
      )
      router.push('/dashboard/broadcasts')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al crear campaña desde contactos'
      if (campaignId) {
        alert(`La campaña quedó guardada como borrador. ${message}`)
      } else {
        alert(message)
      }
    } finally {
      setSubmittingBroadcast(false)
    }
  }

  const selectedDuplicateGroup = duplicateGroups.find(g => g.group_key === selectedDuplicateKey) || duplicateGroups[0] || null
  const mobileActionContact = actionsMenuId ? contacts.find(contact => contact.id === actionsMenuId) || null : null

  if (loading && contacts.length === 0) {
    return (
      <div ref={workspaceRef} className="flex h-full min-h-0 items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-600" />
      </div>
    )
  }

  return (
    <div ref={workspaceRef} className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 py-2 sm:gap-3 shrink-0">
        <div className="order-1 flex flex-1 items-center gap-2 min-w-0 sm:order-none sm:flex-none">
          <h1 className="text-lg font-bold text-slate-900 whitespace-nowrap">Contactos</h1>
          <span className="text-xs text-slate-400 font-medium tabular-nums bg-slate-100 px-2 py-0.5 rounded-full">{total.toLocaleString()}</span>
        </div>

        <div ref={filterDropdownRef} className="relative order-3 basis-full sm:order-none sm:flex-1 sm:basis-auto sm:max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 z-10" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onFocus={() => {
              if (!isCompactWorkspace) setShowFilterDropdown(true)
            }}
            placeholder="Buscar por nombre, teléfono, email..."
            className={`${isCompactWorkspace ? 'h-11 rounded-xl pr-12' : 'rounded-lg py-1.5 pr-3'} w-full border bg-white pl-8 text-sm text-slate-800 placeholder:text-slate-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500 ${activeFilterCount > 0 ? 'border-emerald-400 ring-1 ring-emerald-200' : 'border-slate-200'}`}
          />
          {activeFilterCount > 0 && !showFilterDropdown && !isCompactWorkspace && (
            <span className="absolute right-2.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full bg-emerald-600 text-[10px] font-bold text-white">{activeFilterCount}</span>
          )}
          {isCompactWorkspace && <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setShowFilterDropdown(true)}
            className="absolute right-0 top-0 inline-flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            aria-label={`Abrir filtros y orden${mobileFilterAdjustmentCount > 0 ? `, ${mobileFilterAdjustmentCount} ajustes activos` : ''}`}
          >
            <Filter className="h-5 w-5" />
            {mobileFilterAdjustmentCount > 0 && <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-600 px-1 text-[9px] font-bold text-white">{mobileFilterAdjustmentCount}</span>}
          </button>}

          {/* Filter dropdown */}
          {showFilterDropdown && (
            <div className={`${isCompactWorkspace ? 'app-viewport fixed inset-0 z-[70] h-[var(--app-height,100dvh)] w-full' : 'absolute left-0 top-full z-40 mt-1.5 h-auto max-h-[70vh] w-[min(560px,90vw)] rounded-xl border'} flex flex-col overflow-hidden border-slate-200 bg-white shadow-2xl`} onMouseDown={(e) => e.stopPropagation()}>
              {/* Dropdown header */}
              <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between shrink-0">
                <div className="flex items-center gap-2.5">
                  <Filter className="w-4 h-4 text-emerald-500" />
                  <span className="text-sm font-semibold text-slate-800">Filtros y orden</span>
                  {mobileFilterAdjustmentCount > 0 && (
                    <span className="text-[10px] font-medium bg-emerald-50 text-emerald-600 px-2 py-0.5 rounded-full">{mobileFilterAdjustmentCount} activo{mobileFilterAdjustmentCount > 1 ? 's' : ''}</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {activeFilterCount > 0 && (
                    <button
                      onClick={() => { setFilterTagNames(new Set()); setExcludeFilterTagNames(new Set()); setTagFilterMode('OR'); setLeadFormulaType('simple'); setLeadFormulaText(''); setLeadFormulaIsValid(true); setAppliedFormulaType('simple'); setAppliedFormulaText(''); setFilterDateField('created_at'); setFilterDatePreset(''); setFilterDateFrom(''); setFilterDateTo(''); setFilterDevice(''); setCfFilters([]) }}
                      className="text-[11px] text-red-400 hover:text-red-600 font-medium transition-colors"
                    >
                      Limpiar todo
                    </button>
                  )}
                  <button onClick={() => setShowFilterDropdown(false)} className={`flex items-center justify-center rounded-xl transition-colors hover:bg-slate-100 ${isCompactWorkspace ? 'h-11 w-11' : 'h-8 w-8'}`} aria-label="Cerrar filtros y orden">
                    <X className="w-4 h-4 text-slate-400" />
                  </button>
                </div>
              </div>

              {/* ─── Responsive Body: 2 cols when space, 1 col when narrow ─── */}
              <div className={`flex min-h-0 flex-1 ${isCompactWorkspace ? 'flex-col overflow-y-auto' : 'flex-row overflow-hidden'}`}>

                {/* ══ Left Column — Device + Date ══ */}
                <div className={`${isCompactWorkspace ? 'w-full border-b p-4' : 'w-[220px] overflow-y-auto border-r p-3'} shrink-0 space-y-4 border-slate-100 bg-slate-50/30`}>
                {/* Device filter */}
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-1 h-3.5 bg-slate-300 rounded-full" />
                    <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Dispositivo</p>
                  </div>
                  <select
                    value={filterDevice}
                    onChange={(e) => setFilterDevice(e.target.value)}
                    className="w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg text-xs text-slate-700 focus:ring-1 focus:ring-emerald-500"
                  >
                    <option value="">Todos</option>
                    {devices.map(d => (
                      <option key={d.id} value={d.id}>{d.name} {d.phone ? `(${d.phone})` : ''}</option>
                    ))}
                  </select>
                </div>

                {/* Date Filter */}
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-1 h-3.5 bg-blue-400 rounded-full" />
                    <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Fecha</p>
                  </div>
                  <div className="flex rounded-lg border border-slate-200 bg-slate-50/50 overflow-hidden mb-2">
                    <button
                      onClick={() => setFilterDateField('created_at')}
                      className={`flex-1 px-2 py-1.5 text-[10px] font-semibold transition-all ${filterDateField === 'created_at' ? 'bg-blue-500 text-white shadow-sm' : 'text-slate-500 hover:bg-white'}`}
                    >
                      Creación
                    </button>
                    <button
                      onClick={() => setFilterDateField('updated_at')}
                      className={`flex-1 px-2 py-1.5 text-[10px] font-semibold transition-all ${filterDateField === 'updated_at' ? 'bg-blue-500 text-white shadow-sm' : 'text-slate-500 hover:bg-white'}`}
                    >
                      Modificación
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-1">
                    {DATE_PRESETS.map(p => (
                      <button
                        key={p.key}
                        onClick={() => {
                          if (filterDatePreset === p.key) { setFilterDatePreset(''); setFilterDateFrom(''); setFilterDateTo('') }
                          else { setFilterDatePreset(p.key); if (p.key !== 'custom') { setFilterDateFrom(''); setFilterDateTo('') } }
                        }}
                        className={`px-2 py-1.5 rounded-lg text-[10px] font-medium transition-all border ${
                          filterDatePreset === p.key
                            ? 'bg-blue-500 text-white border-blue-500 shadow-sm'
                            : 'border-slate-200 text-slate-600 hover:bg-white hover:shadow-sm'
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
                        <input type="date" value={filterDateFrom} onChange={e => setFilterDateFrom(e.target.value)}
                          className="w-full px-2 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400" />
                      </div>
                      <div>
                        <label className="text-[9px] font-semibold text-slate-400 uppercase">Hasta</label>
                        <input type="date" value={filterDateTo} onChange={e => setFilterDateTo(e.target.value)}
                          className="w-full px-2 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400" />
                      </div>
                    </div>
                  )}
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
                </div>

                {/* ══ Center Column — Custom Fields ══ */}
                {cfDefs.length > 0 && (
                <div className={`${isCompactWorkspace ? 'w-full border-b p-4' : 'w-[220px] overflow-y-auto border-r p-3'} shrink-0 space-y-3 border-slate-100`}>
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

                {/* ══ Right Column — Tags ══ */}
                <div className={`min-w-0 flex-1 space-y-4 ${isCompactWorkspace ? 'p-4' : 'overflow-y-auto p-3'}`}>

                {/* Simple / Advanced tabs */}
                {allTags.length > 0 && (
                  <>
                    <div className="flex rounded-xl border border-slate-200 bg-slate-50/50 overflow-hidden">
                      <button type="button" onClick={() => setLeadFormulaType('simple')}
                        className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-[11px] font-semibold transition-all ${
                          leadFormulaType === 'simple' ? 'bg-emerald-500 text-white shadow-sm' : 'text-slate-500 hover:bg-white hover:text-slate-700'
                        }`}>
                        <FileText className="w-3.5 h-3.5" />
                        Simple
                      </button>
                      <button type="button" onClick={() => setLeadFormulaType('advanced')}
                        className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-[11px] font-semibold transition-all ${
                          leadFormulaType === 'advanced' ? 'bg-violet-500 text-white shadow-sm' : 'text-slate-500 hover:bg-white hover:text-slate-700'
                        }`}>
                        <Code className="w-3.5 h-3.5" />
                        Avanzado
                      </button>
                    </div>

                    {/* SIMPLE MODE */}
                    {leadFormulaType === 'simple' && (
                      <>
                        <div className="flex items-center gap-2">
                          <div className="inline-flex rounded-lg border border-slate-200 overflow-hidden">
                            <button onClick={() => setTagFilterMode('OR')}
                              className={`px-3 py-1 text-[10px] font-bold tracking-wide transition-all ${tagFilterMode === 'OR' ? 'bg-emerald-500 text-white' : 'bg-white text-slate-400 hover:bg-slate-50'}`}>
                              OR
                            </button>
                            <button onClick={() => setTagFilterMode('AND')}
                              className={`px-3 py-1 text-[10px] font-bold tracking-wide transition-all ${tagFilterMode === 'AND' ? 'bg-blue-500 text-white' : 'bg-white text-slate-400 hover:bg-slate-50'}`}>
                              AND
                            </button>
                          </div>
                          <p className="text-[10px] text-slate-400 leading-tight">
                            {tagFilterMode === 'AND' ? 'Todas' : 'Al menos una'}
                          </p>
                        </div>
                        <div className="relative">
                          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                          <input
                            type="text"
                            value={tagSearchTerm}
                            onChange={(e) => setTagSearchTerm(e.target.value)}
                            placeholder="Buscar etiquetas..."
                            className="w-full pl-9 pr-3 py-2 bg-white border border-slate-200 rounded-xl text-xs text-slate-800 placeholder:text-slate-400 focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-400 transition-all"
                          />
                        </div>
                        <div className="space-y-0.5 max-h-48 overflow-y-auto">
                          {filteredTags.map(tag => {
                            const isIncluded = filterTagNames.has(tag.name)
                            const isExcluded = excludeFilterTagNames.has(tag.name)
                            return (
                              <div
                                key={tag.id}
                                onClick={() => {
                                  if (!isIncluded && !isExcluded) {
                                    const next = new Set(filterTagNames); next.add(tag.name); setFilterTagNames(next)
                                  } else if (isIncluded) {
                                    const incl = new Set(filterTagNames); incl.delete(tag.name); setFilterTagNames(incl)
                                    const excl = new Set(excludeFilterTagNames); excl.add(tag.name); setExcludeFilterTagNames(excl)
                                  } else {
                                    const next = new Set(excludeFilterTagNames); next.delete(tag.name); setExcludeFilterTagNames(next)
                                  }
                                }}
                                className={`flex items-center gap-2.5 px-2.5 py-1.5 rounded-xl cursor-pointer select-none transition-all ${
                                  isIncluded ? 'bg-emerald-50 ring-1 ring-emerald-200' : isExcluded ? 'bg-red-50 ring-1 ring-red-200' : 'hover:bg-white hover:shadow-sm'
                                }`}
                              >
                                {isIncluded ? (
                                  <div className="w-4 h-4 rounded-full shrink-0 bg-emerald-500 flex items-center justify-center"><CheckSquare className="w-2.5 h-2.5 text-white" /></div>
                                ) : isExcluded ? (
                                  <div className="w-4 h-4 rounded-full shrink-0 bg-red-500 flex items-center justify-center"><X className="w-2.5 h-2.5 text-white" /></div>
                                ) : (
                                  <div className="w-3 h-3 rounded-full shrink-0 ring-2 ring-white shadow-sm" style={{ backgroundColor: tag.color }} />
                                )}
                                <span className={`flex-1 text-[11px] transition-colors ${
                                  isIncluded ? 'text-emerald-700 font-semibold' : isExcluded ? 'text-red-400 line-through' : 'text-slate-700'
                                }`}>{tag.name}</span>
                              </div>
                            )
                          })}
                          {filteredTags.length === 0 && tagSearchTerm.trim() && (
                            <div className="text-center py-4">
                              <Search className="w-4 h-4 text-slate-300 mx-auto mb-1" />
                              <p className="text-[10px] text-slate-400">Sin resultados para &quot;{tagSearchTerm}&quot;</p>
                            </div>
                          )}
                        </div>
                      </>
                    )}

                    {/* ADVANCED MODE */}
                    {leadFormulaType === 'advanced' && (
                      <div className="space-y-3">
                        <div className="p-2.5 bg-slate-50 rounded-xl border border-slate-100">
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
                          tags={allTags}
                          compact
                          rows={5}
                          onValidChange={setLeadFormulaIsValid}
                        />
                      </div>
                    )}
                  </>
                )}

                {allTags.length === 0 && (
                  <div className="flex items-center justify-center py-6">
                    <div className="text-center">
                      <Tag className="w-5 h-5 text-slate-300 mx-auto mb-1.5" />
                      <p className="text-[10px] text-slate-400">No hay etiquetas</p>
                    </div>
                  </div>
                )}

                {/* Active tag selections */}
                {(filterTagNames.size > 0 || excludeFilterTagNames.size > 0) && (
                  <div className="border-t border-slate-100 pt-3">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="w-1 h-3.5 bg-emerald-400 rounded-full" />
                      <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Selección</p>
                    </div>
                    <div className="space-y-2">
                      {filterTagNames.size > 0 && (
                        <div>
                          <div className="flex items-center gap-1 mb-1">
                            <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                            <span className="text-[10px] font-semibold text-emerald-600 uppercase tracking-wide">Incluir</span>
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {Array.from(filterTagNames).map(name => {
                              const tag = allTags.find(t => t.name === name)
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
                          <div className="flex items-center gap-1 mb-1">
                            <XCircle className="w-3 h-3 text-red-400" />
                            <span className="text-[10px] font-semibold text-red-500 uppercase tracking-wide">Excluir</span>
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {Array.from(excludeFilterTagNames).map(name => {
                              const tag = allTags.find(t => t.name === name)
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
                  </div>
                )}
                </div>
              </div>

              {isCompactWorkspace && (
                <div className="shrink-0 border-t border-slate-100 bg-white px-4 py-3">
                  <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-slate-500">Ordenar contactos</p>
                  <div className="flex gap-2">
                    <label htmlFor="contacts-mobile-sort" className="sr-only">Criterio de orden</label>
                    <select
                      id="contacts-mobile-sort"
                      value={sortBy}
                      onChange={(event) => {
                        const value = event.target.value
                        setSortBy(value)
                        setSortOrder(value === 'name' ? 'asc' : 'desc')
                      }}
                      className="h-11 min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    >
                      <option value="">Orden original</option>
                      <option value="name">Nombre</option>
                      <option value="lead_count">Oportunidades</option>
                      <option value="created_at">Creación</option>
                    </select>
                    <button type="button" onClick={() => setSortOrder(order => order === 'asc' ? 'desc' : 'asc')} disabled={!sortBy} className="inline-flex h-11 min-w-11 items-center justify-center rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-600 disabled:opacity-40" aria-label={sortOrder === 'asc' ? 'Orden ascendente; cambiar a descendente' : 'Orden descendente; cambiar a ascendente'}>
                      <ChevronUp className={`mr-1 h-4 w-4 transition-transform ${sortOrder === 'desc' ? 'rotate-180' : ''}`} />
                      {sortOrder === 'asc' ? 'Asc.' : 'Desc.'}
                    </button>
                  </div>
                </div>
              )}

              {/* Dropdown footer */}
              <div className="px-4 py-3 border-t border-slate-100 shrink-0">
                <button
                  onClick={() => {
                    setAppliedFormulaType(leadFormulaType)
                    setAppliedFormulaText(leadFormulaType === 'advanced' ? leadFormulaText : '')
                    setShowFilterDropdown(false)
                  }}
                  disabled={leadFormulaType === 'advanced' && !leadFormulaIsValid}
                  className="w-full px-4 py-2.5 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 active:bg-emerald-800 disabled:opacity-50 disabled:cursor-not-allowed transition-all text-sm font-semibold shadow-sm shadow-emerald-200 hover:shadow-md hover:shadow-emerald-200"
                >
                  Aplicar
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="order-2 flex flex-shrink-0 items-center gap-1 sm:order-none sm:gap-2">
          {selectionMode ? (
            /* Selection mode bar */
            <>
              <span className="px-1 py-2 text-xs text-slate-600 font-medium sm:px-3 sm:text-sm">
                {selectedIds.size} seleccionado{selectedIds.size !== 1 ? 's' : ''}
              </span>
              <button
                onClick={() => setSelectedIds(new Set(contacts.map(c => c.id)))}
                className="min-h-11 px-2 text-xs border border-slate-300 rounded-xl hover:bg-slate-50 transition-colors sm:min-h-0 sm:px-3 sm:py-2 sm:text-sm sm:rounded-lg"
              >
                Todos
              </button>
              {!isCompactWorkspace && <button
                onClick={handleDeleteSelected}
                disabled={selectedIds.size === 0}
                className="rounded-lg bg-red-600 px-3 py-2 text-sm text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Eliminar ({selectedIds.size})
              </button>}
              {googleConnected && !isCompactWorkspace && (
                <>
                  <button
                    onClick={handleGoogleBatchSync}
                    disabled={selectedIds.size === 0 || selectedIds.size > 30 || googleSyncing}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                    title="Sincronizar con Google Contacts"
                  >
                    {googleSyncing ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                    Google Sync
                  </button>
                  <button
                    onClick={handleGoogleBatchDesync}
                    disabled={selectedIds.size === 0 || selectedIds.size > 30 || googleSyncing}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                    title="Quitar de Google Contacts"
                  >
                    <XCircle className="w-3.5 h-3.5" />
                    Desync
                  </button>
                </>
              )}
              {!isCompactWorkspace && <button
                onClick={() => { setSelectionMode(false); setSelectedIds(new Set()) }}
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-300 text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-700"
                title="Cancelar selección"
              >
                <X className="w-4 h-4" />
              </button>}
              {isCompactWorkspace && <button
                type="button"
                onClick={() => setShowMobileBulkMenu(true)}
                className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-slate-300 text-slate-600 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                aria-label="Acciones para contactos seleccionados"
              >
                <MoreHorizontal className="h-5 w-5" />
              </button>}
            </>
          ) : (
            /* Normal mode */
            <>
              {/* ··· More dropdown */}
              <div ref={moreMenuRef} className="relative">
                <button
                  onClick={() => setShowMoreMenu(v => !v)}
                  className={`inline-flex min-h-11 items-center gap-1.5 rounded-xl border px-3 text-sm transition-colors sm:min-h-0 sm:rounded-lg sm:py-2 ${
                    showMoreMenu
                      ? 'border-slate-400 bg-slate-100 text-slate-700'
                      : 'border-slate-300 hover:bg-slate-50 text-slate-600'
                  }`}
                  title="Más acciones"
                >
                  <MoreHorizontal className="w-4 h-4" />
                  <span className="hidden sm:inline">Más</span>
                  <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showMoreMenu ? 'rotate-180' : ''}`} />
                </button>

                {showMoreMenu && !isCompactWorkspace && (
                  <div className="absolute right-0 top-full z-30 mt-1.5 w-56 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-xl">
                    <button
                      onClick={() => { setShowCreateContact(true); setShowMoreMenu(false) }}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-emerald-700 font-medium hover:bg-emerald-50 transition-colors"
                    >
                      <UserPlus className="w-4 h-4 text-emerald-500" />
                      Nuevo contacto
                    </button>
                    <button
                      onClick={() => { fetchDevices(); setShowBroadcastModal(true); setShowMoreMenu(false) }}
                      disabled={total === 0}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <Radio className="w-4 h-4 text-slate-400" />
                      Masivo
                    </button>
                    <div className="my-1 border-t border-slate-100" />
                    <button
                      onClick={() => { setShowPasteExcel(true); setShowMoreMenu(false) }}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
                    >
                      <ClipboardPaste className="w-4 h-4 text-slate-400" />
                      Pegar desde Excel
                    </button>
                    <button
                      onClick={() => { setShowImportModal(true); setShowMoreMenu(false) }}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
                    >
                      <Upload className="w-4 h-4 text-slate-400" />
                      Importar Excel
                    </button>
                    <div className="my-1 border-t border-slate-100" />
                    <button
                      onClick={() => { handleFindDuplicates(); setShowMoreMenu(false) }}
                      disabled={loadingDuplicates}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors disabled:opacity-50"
                    >
                      <Merge className="w-4 h-4 text-slate-400" />
                      {loadingDuplicates ? 'Buscando...' : 'Buscar duplicados'}
                    </button>
                    <button
                      onClick={() => { setSelectionMode(true); setShowMoreMenu(false) }}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
                    >
                      <CheckSquare className="w-4 h-4 text-slate-400" />
                      Seleccionar contactos
                    </button>
                    <div className="my-1 border-t border-slate-100" />
                    <button
                      onClick={() => { setShowExportModal(true); setShowMoreMenu(false) }}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
                    >
                      <Download className="w-4 h-4 text-slate-400" />
                      Exportar contactos
                    </button>
                    <button
                      onClick={() => { setShowBulkDocModal(true); setShowMoreMenu(false) }}
                      disabled={contacts.length === 0}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <FileText className="w-4 h-4 text-slate-400" />
                      Generar Documentos
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {contactsError && (
        <div className="mb-2 flex shrink-0 flex-col gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 sm:flex-row sm:items-center sm:justify-between" role="alert">
          <span>{contactsError}. Conservamos los contactos que ya estaban cargados.</span>
          <button type="button" onClick={() => void fetchContacts(true)} className="min-h-11 shrink-0 rounded-lg border border-red-300 bg-white px-4 font-semibold text-red-700 hover:bg-red-100">Reintentar</button>
        </div>
      )}

      {/* Main content */}
      <div className="flex flex-col flex-1 min-h-0">
          {/* Counter bar */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/50 px-3 py-2 shrink-0 sm:px-4">
            <p className="text-[11px] text-slate-500 sm:text-xs">
              Mostrando {contacts.length} de {total.toLocaleString()} contactos
            </p>
            {loadingMore && (
              <div className="hidden items-center gap-1.5 text-xs text-emerald-600 sm:flex">
                <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-emerald-600" />
                Cargando más...
              </div>
            )}
          </div>

          {/* Scrollable table with sticky header */}
          <div
            ref={scrollContainerRef}
            onScroll={handleContactsScroll}
            className={`min-h-0 flex-1 overflow-y-auto ${isCompactWorkspace ? 'overflow-x-hidden' : 'overflow-x-auto'}`}
          >
            {isCompactWorkspace && <div className="divide-y divide-slate-100">
              {contacts.length === 0 && !loading && !contactsError ? (
                <div className="px-5 py-14 text-center text-slate-500">
                  <Users className="mx-auto mb-3 h-11 w-11 text-slate-300" />
                  <p className="font-medium">No hay contactos</p>
                  <p className="mt-1 text-xs leading-relaxed">Los contactos se sincronizan automáticamente desde tus dispositivos WhatsApp.</p>
                </div>
              ) : contacts.map((contact) => {
                const tags = contact.structured_tags || []
                return (
                  <article
                    key={`mobile-${contact.id}`}
                    className={`group relative px-3 py-3 transition ${selectedIds.has(contact.id) ? 'bg-emerald-50' : selectedContact?.id === contact.id ? 'bg-emerald-50/70' : 'bg-white active:bg-slate-50'}`}
                    onClick={() => selectionMode ? toggleSelection(contact.id) : openDetail(contact)}
                  >
                    <div className="flex min-w-0 items-start gap-3">
                      {selectionMode && (
                        <button
                          type="button"
                          onClick={(event) => { event.stopPropagation(); toggleSelection(contact.id) }}
                          className="-ml-1 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                          aria-label={selectedIds.has(contact.id) ? `Quitar selección de ${getDisplayName(contact)}` : `Seleccionar ${getDisplayName(contact)}`}
                        >
                          {selectedIds.has(contact.id) ? <CheckSquare className="h-5 w-5 text-emerald-600" /> : <Square className="h-5 w-5" />}
                        </button>
                      )}
                      {contact.avatar_url ? (
                        <img src={contact.avatar_url} alt="" className="h-11 w-11 shrink-0 rounded-full object-cover" />
                      ) : (
                        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-emerald-50">
                          <span className="text-sm font-semibold text-emerald-700">{getInitials(contact)}</span>
                        </div>
                      )}
                      <div className="min-w-0 flex-1 pt-0.5">
                        <div className="flex min-w-0 items-center gap-1.5 pr-10">
                          <h2 className="truncate text-sm font-semibold text-slate-900">{getDisplayName(contact)}</h2>
                          {contact.google_sync && <Cloud className="h-3.5 w-3.5 shrink-0 text-blue-500" aria-label="Sincronizado con Google Contacts" />}
                        </div>
                        <p className="mt-0.5 truncate text-xs text-slate-500">
                          {contact.phone || (contact.jid?.includes('@clarin.') || contact.jid?.includes('@internal') ? 'Sin teléfono' : contact.jid)}
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">
                            {kommoEnabled ? (contact.source || 'whatsapp') : 'whatsapp'}
                          </span>
                          {(contact.lead_count ?? 0) > 0 && (
                            <button
                              type="button"
                              onClick={(event) => { event.stopPropagation(); fetchContactLeads(contact) }}
                              className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700"
                            >
                              {contact.lead_count} oportunidad{contact.lead_count === 1 ? '' : 'es'}
                            </button>
                          )}
                          {tags.slice(0, 2).map(tag => (
                            <span key={tag.id} className="max-w-[110px] truncate rounded-full px-2 py-0.5 text-[10px] font-medium text-white" style={{ backgroundColor: tag.color || '#6b7280' }}>{tag.name}</span>
                          ))}
                          {tags.length > 2 && <span className="text-[10px] text-slate-400">+{tags.length - 2}</span>}
                        </div>
                      </div>
                      {!selectionMode && (
                        <button
                          type="button"
                          onClick={(event) => { event.stopPropagation(); setActionsMenuId(contact.id) }}
                          className="absolute right-2 top-2 inline-flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                          aria-label={`Acciones de ${getDisplayName(contact)}`}
                        >
                          <MoreVertical className="h-5 w-5" />
                        </button>
                      )}
                    </div>
                  </article>
                )
              })}
            </div>}

            {!isCompactWorkspace && <table className="w-full">
              <thead className="bg-slate-100 border-b-2 border-slate-200 sticky top-0 z-10" style={{ display: 'table', tableLayout: 'fixed', width: '100%' }}>
                <tr>
                  {selectionMode && <th className="w-10 px-4 py-3" />}
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider cursor-pointer select-none hover:text-slate-700" onClick={() => { if (sortBy === 'name') { setSortOrder(o => o === 'asc' ? 'desc' : 'asc') } else { setSortBy('name'); setSortOrder('asc') } }}>
                    <span className="inline-flex items-center gap-1">Contacto {sortBy === 'name' ? <ChevronUp className={`w-3 h-3 transition-transform ${sortOrder === 'desc' ? 'rotate-180' : ''}`} /> : <ArrowUpDown className="w-3 h-3 opacity-40" />}</span>
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider hidden md:table-cell">Nombre corto</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider hidden lg:table-cell">Etiquetas</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider hidden md:table-cell">Fuente</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider hidden md:table-cell cursor-pointer select-none hover:text-slate-700" onClick={() => { if (sortBy === 'lead_count') { setSortOrder(o => o === 'asc' ? 'desc' : 'asc') } else { setSortBy('lead_count'); setSortOrder('desc') } }}>
                    <span className="inline-flex items-center gap-1">Leads {sortBy === 'lead_count' ? <ChevronUp className={`w-3 h-3 transition-transform ${sortOrder === 'desc' ? 'rotate-180' : ''}`} /> : <ArrowUpDown className="w-3 h-3 opacity-40" />}</span>
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider hidden lg:table-cell cursor-pointer select-none hover:text-slate-700" onClick={() => { if (sortBy === 'created_at') { setSortOrder(o => o === 'asc' ? 'desc' : 'asc') } else { setSortBy('created_at'); setSortOrder('desc') } }}>
                    <span className="inline-flex items-center gap-1">Creación {sortBy === 'created_at' ? <ChevronUp className={`w-3 h-3 transition-transform ${sortOrder === 'desc' ? 'rotate-180' : ''}`} /> : <ArrowUpDown className="w-3 h-3 opacity-40" />}</span>
                  </th>
                  {cfDefs.filter(d => cfVisibleIds.has(d.id)).sort((a, b) => a.sort_order - b.sort_order).map(def => (
                    <th key={def.id} className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider hidden lg:table-cell max-w-[160px]">
                      <span className="truncate block">{def.name}</span>
                    </th>
                  ))}
                  <th className="w-10 px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider relative">
                    <div ref={cfColumnPickerRef} className="inline-block">
                      {cfDefs.length > 0 && (
                        <button
                          onClick={(e) => { e.stopPropagation(); setShowCfColumnPicker(!showCfColumnPicker) }}
                          className={`p-1 rounded hover:bg-slate-200 transition ${showCfColumnPicker || cfVisibleIds.size > 0 ? 'text-emerald-600' : 'text-slate-400'}`}
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
                  </th>
                </tr>
              </thead>
              <tbody style={{ height: contacts.length > 0 ? contactsVirtualizer.getTotalSize() : undefined, position: 'relative', display: 'block' }}>
                {contacts.length === 0 && !loading && !contactsError ? (
                  <tr style={{ display: 'table-row' }}>
                    <td colSpan={(selectionMode ? 8 : 7) + cfDefs.filter(d => cfVisibleIds.has(d.id)).length} className="text-center py-12 text-slate-500">
                      <Users className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                      <p className="text-base font-medium">No hay contactos</p>
                      <p className="text-sm mt-1">Los contactos se sincronizan automáticamente desde tus dispositivos WhatsApp</p>
                    </td>
                  </tr>
                ) : contactsVirtualizer.getVirtualItems().map((virtualRow) => {
                  const contact = contacts[virtualRow.index]
                  if (!contact) return null
                  return (
                  <tr
                    key={contact.id}
                    ref={contactsVirtualizer.measureElement}
                    data-index={virtualRow.index}
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', display: 'table', tableLayout: 'fixed', transform: `translateY(${virtualRow.start}px)` }}
                    className={`hover:bg-slate-50 cursor-pointer transition border-b border-slate-100 ${
                      selectedIds.has(contact.id) ? 'bg-emerald-100' : selectedContact?.id === contact.id ? 'bg-emerald-100 border-l-[3px] border-l-emerald-500' : ''
                    }`}
                    onClick={() => selectionMode ? toggleSelection(contact.id) : openDetail(contact)}
                  >
                    {selectionMode && (
                      <td className="px-4 py-3">
                        <button onClick={(e) => { e.stopPropagation(); toggleSelection(contact.id) }}>
                          {selectedIds.has(contact.id) ? (
                            <CheckSquare className="w-5 h-5 text-emerald-600" />
                          ) : (
                            <Square className="w-5 h-5 text-slate-400" />
                          )}
                        </button>
                      </td>
                    )}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {contact.avatar_url ? (
                          <img src={contact.avatar_url} alt="" className="w-10 h-10 rounded-full object-cover" />
                        ) : (
                          <div className="w-10 h-10 bg-emerald-50 rounded-full flex items-center justify-center flex-shrink-0 overflow-hidden">
                            <span className="text-emerald-700 font-medium text-sm">{getInitials(contact)}</span>
                          </div>
                        )}
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <p className="text-sm font-medium text-slate-900 truncate">{getDisplayName(contact)}</p>
                            {contact.google_sync && (
                              <span title="Sincronizado con Google Contacts">
                                <Cloud className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-slate-400 truncate">
                            {contact.phone || (contact.jid?.includes('@clarin.') || contact.jid?.includes('@internal')
                              ? <span className="inline-flex items-center gap-1 text-slate-300"><PhoneOff className="w-3 h-3" />Sin teléfono</span>
                              : contact.jid)}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-600 hidden md:table-cell">
                      {contact.short_name || <span className="text-slate-300">-</span>}
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell">
                      <div className="flex flex-wrap gap-1">
                        {(contact.structured_tags || []).slice(0, 3).map((tag) => (
                          <span key={tag.id} className="px-2 py-0.5 text-xs rounded-full font-medium text-white" style={{ backgroundColor: tag.color || '#6b7280' }}>
                            {tag.name}
                          </span>
                        ))}
                        {(contact.structured_tags || []).length > 3 && (
                          <span className="text-xs text-slate-400">+{(contact.structured_tags || []).length - 3}</span>
                        )}
                        {(!contact.structured_tags || contact.structured_tags.length === 0) && (contact.tags || []).slice(0, 3).map((tag, i) => (
                          <span key={i} className="px-2 py-0.5 bg-slate-100 text-slate-600 text-xs rounded-full">{tag}</span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-500 hidden md:table-cell">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium ${
                        kommoEnabled && contact.source === 'kommo' ? 'bg-blue-50 text-blue-600' : 'bg-emerald-50 text-emerald-600'
                      }`}>
                        {kommoEnabled ? (contact.source || 'whatsapp') : 'whatsapp'}
                      </span>
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell">
                      {(contact.lead_count ?? 0) > 0 ? (
                        <button
                          onClick={(e) => { e.stopPropagation(); fetchContactLeads(contact) }}
                          className="inline-flex min-h-8 items-center gap-1 rounded-full bg-emerald-50 px-2.5 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                          title={`${contact.lead_count} oportunidad${contact.lead_count === 1 ? '' : 'es'}`}
                        >
                          {contact.lead_count}
                          <ExternalLink className="w-3 h-3" />
                        </button>
                      ) : (
                        <span className="text-xs text-slate-300">0</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-400 hidden lg:table-cell">
                      {contact.created_at ? (
                        <span title={format(new Date(contact.created_at), 'dd/MM/yyyy HH:mm', { locale: es })}>
                          {formatDistanceToNow(new Date(contact.created_at), { addSuffix: true, locale: es })}
                        </span>
                      ) : (
                        <span className="text-slate-300">-</span>
                      )}
                    </td>
                    {cfDefs.filter(d => cfVisibleIds.has(d.id)).sort((a, b) => a.sort_order - b.sort_order).map(def => (
                      <td key={def.id} className="px-4 py-3 text-xs text-slate-600 hidden lg:table-cell max-w-[160px]">
                        {formatCfCell(def, contact)}
                      </td>
                    ))}
                    <td className="px-4 py-3 relative">
                      <div ref={actionsMenuId === contact.id ? actionsMenuRef : undefined}>
                        <button
                          onClick={(e) => { e.stopPropagation(); setActionsMenuId(actionsMenuId === contact.id ? null : contact.id) }}
                          className="p-1 text-slate-400 hover:text-slate-600 rounded hover:bg-slate-100"
                        >
                          <MoreVertical className="w-4 h-4" />
                        </button>
                        {actionsMenuId === contact.id && (
                          <div className="absolute right-4 top-full mt-1 w-48 bg-white border border-slate-200 rounded-xl shadow-xl z-20 py-1">
                            <button
                              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); openDetail(contact); setActionsMenuId(null) }}
                              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                            >
                              <Eye className="w-4 h-4 text-slate-400" /> Ver detalle
                            </button>
                            <button
                              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); openEditModal(contact); setActionsMenuId(null) }}
                              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                            >
                              <Edit2 className="w-4 h-4 text-slate-400" /> Editar
                            </button>
                            <button
                              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); fetchContactLeads(contact); setActionsMenuId(null) }}
                              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                            >
                              <Users className="w-4 h-4 text-slate-400" /> Ver leads ({contact.lead_count ?? 0})
                            </button>
                            <button
                              onMouseDown={(e) => {
                                e.preventDefault(); e.stopPropagation()
                                setSelectedContact(contact)
                                const phone = contact.phone || contact.jid?.replace(/@.*$/, '') || ''
                                if (phone) {
                                  handleSendWhatsApp(phone, contact)
                                } else {
                                  alert('Este contacto no tiene número de teléfono')
                                }
                                setActionsMenuId(null)
                              }}
                              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                            >
                              <MessageSquare className="w-4 h-4 text-slate-400" /> Enviar mensaje
                            </button>
                            {googleConnected && (
                              <button
                                onMouseDown={(e) => {
                                  e.preventDefault(); e.stopPropagation()
                                  handleGoogleSyncSingle(contact.id)
                                  setActionsMenuId(null)
                                }}
                                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                              >
                                <Upload className="w-4 h-4 text-blue-400" />
                                {contact.google_sync ? 'Re-sincronizar Google' : 'Sync a Google'}
                              </button>
                            )}
                            <div className="my-1 border-t border-slate-100" />
                            <button
                              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); handleDeleteContact(contact.id); setActionsMenuId(null) }}
                              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-red-600 hover:bg-red-50"
                            >
                              <Trash2 className="w-4 h-4 text-red-400" /> Eliminar
                            </button>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>}

            {/* Loading sentinel at bottom */}
            {loadingMore && (
              <div className="flex items-center justify-center py-4">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-emerald-600" />
              </div>
            )}
            {!hasMore && contacts.length > 0 && !loading && (
              <div className="text-center py-3 text-xs text-slate-400">
                Todos los contactos cargados
              </div>
            )}
          </div>
        </div>

      {typeof document !== 'undefined' && isCompactWorkspace && showMoreMenu && createPortal(
        <div className="app-viewport fixed inset-0 z-[90] flex flex-col bg-white">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Más acciones de contactos"
            className="flex h-full min-h-0 w-full flex-col bg-white"
          >
            <div className="safe-area-top flex min-h-16 shrink-0 items-center justify-between border-b border-slate-200 px-4">
              <div><h2 className="font-bold text-slate-900">Acciones de contactos</h2><p className="text-xs text-slate-500">Crear, importar y administrar</p></div>
              <button type="button" onClick={() => setShowMoreMenu(false)} className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label="Cerrar acciones"><X className="h-5 w-5" /></button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
            {[
              { group: 'Crear y comunicar', label: 'Nuevo contacto', icon: UserPlus, action: () => setShowCreateContact(true), accent: 'text-emerald-700' },
              { group: 'Crear y comunicar', label: 'Masivo', icon: Radio, action: () => { fetchDevices(); setShowBroadcastModal(true) }, disabled: total === 0 },
              { group: 'Importar', label: 'Pegar desde Excel', icon: ClipboardPaste, action: () => setShowPasteExcel(true) },
              { group: 'Importar', label: 'Importar Excel', icon: Upload, action: () => setShowImportModal(true) },
              { group: 'Herramientas', label: loadingDuplicates ? 'Buscando duplicados…' : 'Buscar duplicados', icon: Merge, action: handleFindDuplicates, disabled: loadingDuplicates },
              { group: 'Herramientas', label: 'Seleccionar contactos', icon: CheckSquare, action: () => setSelectionMode(true) },
              { group: 'Herramientas', label: 'Exportar contactos', icon: Download, action: () => setShowExportModal(true) },
              { group: 'Herramientas', label: 'Generar documentos', icon: FileText, action: () => setShowBulkDocModal(true), disabled: contacts.length === 0 },
            ].map(({ group, label, icon: Icon, action, disabled, accent }, index, actions) => (
              <div key={label}>
                {(index === 0 || actions[index - 1].group !== group) && <p className={`${index === 0 ? '' : 'mt-5'} mb-1 px-3 text-[10px] font-bold uppercase tracking-widest text-slate-400`}>{group}</p>}
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => { setShowMoreMenu(false); action() }}
                  className={`flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-medium transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 ${accent || 'text-slate-700'}`}
                >
                  <Icon className="h-5 w-5 shrink-0 text-slate-400" />
                  {label}
                </button>
              </div>
            ))}
            </div>
            <div className="safe-area-bottom shrink-0 border-t border-slate-200 bg-white p-4"><button type="button" onClick={() => setShowMoreMenu(false)} className="min-h-12 w-full rounded-xl border border-slate-200 text-sm font-semibold text-slate-600">Cerrar</button></div>
          </div>
        </div>,
        document.body,
      )}

      {typeof document !== 'undefined' && isCompactWorkspace && showMobileBulkMenu && createPortal(
        <div className="app-viewport fixed inset-0 z-[90] flex items-end bg-slate-950/40" onMouseDown={() => setShowMobileBulkMenu(false)}>
          <div role="dialog" aria-modal="true" aria-label="Acciones de selección" className="w-full rounded-t-3xl bg-white px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 shadow-2xl" onMouseDown={(event) => event.stopPropagation()}>
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-slate-300" />
            <p className="px-2 pb-2 text-sm font-semibold text-slate-800">{selectedIds.size} contacto{selectedIds.size === 1 ? '' : 's'} seleccionado{selectedIds.size === 1 ? '' : 's'}</p>
            <button type="button" onClick={() => { setShowMobileBulkMenu(false); handleDeleteSelected() }} disabled={selectedIds.size === 0} className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-sm font-medium text-red-600 transition hover:bg-red-50 disabled:opacity-40"><Trash2 className="h-5 w-5" />Eliminar seleccionados</button>
            {googleConnected && (
              <>
                <button type="button" onClick={() => { setShowMobileBulkMenu(false); handleGoogleBatchSync() }} disabled={selectedIds.size === 0 || selectedIds.size > 30 || googleSyncing} className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-40"><Upload className="h-5 w-5 text-blue-500" />Sincronizar con Google</button>
                <button type="button" onClick={() => { setShowMobileBulkMenu(false); handleGoogleBatchDesync() }} disabled={selectedIds.size === 0 || selectedIds.size > 30 || googleSyncing} className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-40"><XCircle className="h-5 w-5 text-slate-400" />Quitar de Google</button>
              </>
            )}
            <button type="button" onClick={() => { setShowMobileBulkMenu(false); setSelectionMode(false); setSelectedIds(new Set()) }} className="mt-2 min-h-12 w-full rounded-xl border border-slate-200 text-sm font-semibold text-slate-600">Cancelar selección</button>
          </div>
        </div>,
        document.body,
      )}

      {typeof document !== 'undefined' && isCompactWorkspace && mobileActionContact && createPortal(
        <div className="app-viewport fixed inset-0 z-[90] flex items-end bg-slate-950/40" onMouseDown={() => setActionsMenuId(null)}>
          <div role="dialog" aria-modal="true" aria-label={`Acciones de ${getDisplayName(mobileActionContact)}`} className="max-h-[80dvh] w-full overflow-y-auto rounded-t-3xl bg-white px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 shadow-2xl" onMouseDown={(event) => event.stopPropagation()}>
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-slate-300" />
            <p className="truncate px-2 pb-2 text-sm font-semibold text-slate-800">{getDisplayName(mobileActionContact)}</p>
            <button type="button" onClick={() => { setActionsMenuId(null); openDetail(mobileActionContact) }} className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-sm text-slate-700 hover:bg-slate-50"><Eye className="h-5 w-5 text-slate-400" />Ver detalle</button>
            <button type="button" onClick={() => { setActionsMenuId(null); openEditModal(mobileActionContact) }} className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-sm text-slate-700 hover:bg-slate-50"><Edit2 className="h-5 w-5 text-slate-400" />Editar</button>
            <button type="button" onClick={() => { setActionsMenuId(null); fetchContactLeads(mobileActionContact) }} className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-sm text-slate-700 hover:bg-slate-50"><Users className="h-5 w-5 text-slate-400" />Ver oportunidades ({mobileActionContact.lead_count ?? 0})</button>
            <button
              type="button"
              onClick={() => {
                setActionsMenuId(null)
                setSelectedContact(mobileActionContact)
                const phone = mobileActionContact.phone || mobileActionContact.jid?.replace(/@.*$/, '') || ''
                if (phone) handleSendWhatsApp(phone, mobileActionContact)
                else alert('Este contacto no tiene número de teléfono')
              }}
              className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-sm text-slate-700 hover:bg-slate-50"
            >
              <MessageSquare className="h-5 w-5 text-slate-400" />Enviar mensaje
            </button>
            {googleConnected && <button type="button" onClick={() => { setActionsMenuId(null); handleGoogleSyncSingle(mobileActionContact.id) }} className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-sm text-slate-700 hover:bg-slate-50"><Upload className="h-5 w-5 text-blue-500" />{mobileActionContact.google_sync ? 'Re-sincronizar Google' : 'Sincronizar con Google'}</button>}
            <button type="button" onClick={() => { setActionsMenuId(null); handleDeleteContact(mobileActionContact.id) }} className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-sm text-red-600 hover:bg-red-50"><Trash2 className="h-5 w-5" />Eliminar</button>
            <button type="button" onClick={() => setActionsMenuId(null)} className="mt-2 min-h-12 w-full rounded-xl border border-slate-200 text-sm font-semibold text-slate-600">Cancelar</button>
          </div>
        </div>,
        document.body,
      )}

      {/* Detail Panel (Slide-over) with Inline Chat */}
      {(showDetailPanel || showInlineChat) && selectedContact && (
        <div className="app-viewport fixed inset-0 z-[70] flex justify-end overflow-hidden">
          <div
            className="absolute inset-0 bg-black/30 backdrop-blur-[2px]"
            onClick={() => { setShowDetailPanel(false); resetInlineChatState() }}
          />
          <div className={`relative flex h-full w-full bg-white shadow-2xl transition-all duration-300 border-l border-slate-200 ${showInlineChat ? 'xl:w-[85vw] xl:max-w-6xl' : 'max-w-md'}`}>

            {/* Chat Panel - Left Side */}
            {showInlineChat && inlineChatId && (
              <div className="flex h-full min-w-0 flex-1 flex-col bg-slate-50/50 xl:border-r xl:border-slate-200">
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

            {/* Contact Details - Right Side */}
            <div className={`${showInlineChat ? 'hidden xl:flex xl:w-[360px] xl:shrink-0' : 'flex w-full'} h-full flex-col bg-white`}>
            <LeadDetailPanel
              contactMode
              contactId={selectedContact.id}
              scrollToTasks={scrollToTasks}
              lead={contactToLead(selectedContact)}
              onLeadChange={(updatedLead) => {
                const updatedContact = {
                  ...selectedContact,
                  name: updatedLead.name,
                  last_name: updatedLead.last_name,
                  short_name: updatedLead.short_name,
                  phone: updatedLead.phone,
                  email: updatedLead.email,
                  company: updatedLead.company,
                  age: updatedLead.age,
                  dni: updatedLead.dni,
                  birth_date: updatedLead.birth_date,
                  address: updatedLead.address,
                  distrito: updatedLead.distrito,
                  ocupacion: updatedLead.ocupacion,
                  notes: updatedLead.notes,
                  structured_tags: updatedLead.structured_tags,
                }
                setSelectedContact(updatedContact)
                setContacts(prev => prev.map(c => c.id === updatedContact.id ? { ...c, ...updatedContact } : c))
              }}
              onClose={() => { setShowDetailPanel(false); resetInlineChatState(); setScrollToTasks(false) }}
              onDelete={() => {
                setShowDetailPanel(false)
                resetInlineChatState()
                setSelectedContact(null)
                fetchContacts()
              }}
              deviceNames={selectedContact.device_names}
              pushName={selectedContact.push_name}
              avatarUrl={selectedContact.avatar_url}
              onSendWhatsApp={(phone: string) => handleSendWhatsApp(phone)}
              hideWhatsApp={showInlineChat}
              onContactUpdate={(contact) => {
                setSelectedContact(contact)
                setContacts(prev => prev.map(c => c.id === contact.id ? { ...c, ...contact } : c))
              }}
            />
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {showEditModal && selectedContact && (
        <div className="responsive-dialog-backdrop fixed inset-0 flex items-center justify-center bg-black/50">
          <div className="responsive-dialog-panel w-full max-w-md overflow-y-auto rounded-xl bg-white p-4 sm:max-h-[90vh] sm:p-6">
            <h2 className="text-xl font-bold text-slate-900 mb-4">Editar Contacto</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Nombre personalizado</label>
                <input
                  type="text"
                  value={editForm.custom_name}
                  onChange={(e) => setEditForm({ ...editForm, custom_name: e.target.value })}
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 text-slate-900 placeholder:text-slate-400 text-sm"
                  placeholder={selectedContact.name || selectedContact.push_name || 'Nombre del contacto'}
                />
                <p className="text-xs text-slate-400 mt-1">
                  Nombre original: {selectedContact.name || selectedContact.push_name || '-'}
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Apellido</label>
                  <input
                    type="text"
                    value={editForm.last_name}
                    onChange={(e) => setEditForm({ ...editForm, last_name: e.target.value })}
                    className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 text-slate-900 placeholder:text-slate-400 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Nombre Corto</label>
                  <input
                    type="text"
                    value={editForm.short_name}
                    onChange={(e) => setEditForm({ ...editForm, short_name: e.target.value })}
                    className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 text-slate-900 placeholder:text-slate-400 text-sm"
                    placeholder="Apodo o nombre corto"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Teléfono</label>
                <input
                  type="tel"
                  value={editForm.phone}
                  onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 text-slate-900 placeholder:text-slate-400 text-sm"
                  placeholder="+51 999 888 777"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
                <input
                  type="email"
                  value={editForm.email}
                  onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 text-slate-900 placeholder:text-slate-400 text-sm"
                  placeholder="correo@ejemplo.com"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Empresa</label>
                  <input
                    type="text"
                    value={editForm.company}
                    onChange={(e) => setEditForm({ ...editForm, company: e.target.value })}
                    className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 text-slate-900 placeholder:text-slate-400 text-sm"
                    placeholder="Nombre de la empresa"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Edad</label>
                  <input
                    type="number"
                    value={editForm.age}
                    onChange={(e) => setEditForm({ ...editForm, age: e.target.value })}
                    className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 text-slate-900 placeholder:text-slate-400 text-sm"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Etiquetas</label>
                <input
                  type="text"
                  value={editForm.tags}
                  onChange={(e) => setEditForm({ ...editForm, tags: e.target.value })}
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 text-slate-900 placeholder:text-slate-400 text-sm"
                  placeholder="cliente, vip, urgente (separadas por coma)"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Notas</label>
                <textarea
                  value={editForm.notes}
                  onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                  rows={3}
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 text-slate-900 placeholder:text-slate-400 text-sm"
                  placeholder="Notas sobre este contacto..."
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Dirección</label>
                <input
                  type="text"
                  value={editForm.address}
                  onChange={(e) => setEditForm({ ...editForm, address: e.target.value })}
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 text-slate-900 placeholder:text-slate-400 text-sm"
                  placeholder="Dirección del contacto"
                />
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => { setShowEditModal(false); setSelectedContact(null) }}
                className="flex-1 px-4 py-2 border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 text-sm"
              >
                Cancelar
              </button>
              <button
                onClick={handleUpdateContact}
                className="flex-1 px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 text-sm"
              >
                Guardar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Duplicates Modal */}
      {showDuplicates && (
        <div className="responsive-dialog-backdrop fixed inset-0 flex items-center justify-center bg-black/50">
          <div className="responsive-dialog-panel flex w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl sm:h-[86vh]">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
              <div className="flex items-center gap-2">
                <Merge className="w-4 h-4 text-emerald-600" />
                <div>
                  <h2 className="text-sm font-semibold text-slate-900">Unificar contactos</h2>
                  <p className="text-xs text-slate-500">{duplicateGroups.length} grupo{duplicateGroups.length !== 1 ? 's' : ''} con posible duplicado</p>
                </div>
              </div>
              <button onClick={() => setShowDuplicates(false)} className="p-1 hover:bg-slate-100 rounded">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 min-h-0 flex flex-col md:flex-row">
              {duplicateGroups.length === 0 ? (
                <div className="flex-1 flex items-center justify-center text-slate-500">
                  <div className="text-center">
                  <CheckSquare className="w-12 h-12 mx-auto mb-3 text-emerald-500" />
                  <p className="font-medium">No se encontraron duplicados</p>
                  </div>
                </div>
              ) : (
                <>
                  <div className="w-full md:w-80 border-b md:border-b-0 md:border-r border-slate-200 bg-slate-50/60 overflow-y-auto">
                    {duplicateGroups.map((group) => {
                      const totalLeads = group.contacts.reduce((sum, candidate) => sum + (candidate.counts?.leads || 0), 0)
                      const selected = selectedDuplicateKey === group.group_key
                      return (
                        <button
                          key={group.group_key}
                          onClick={() => {
                            setSelectedDuplicateKey(group.group_key)
                            const keep = mergeKeepByGroup[group.group_key] || group.recommended_keep_id || group.contacts[0]?.contact.id
                            loadMergePreview(group, keep)
                          }}
                          className={`w-full text-left px-4 py-3 border-b border-slate-200 transition ${selected ? 'bg-white shadow-sm' : 'hover:bg-white/70'}`}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <p className="text-sm font-semibold text-slate-800 truncate">+{group.normalized_phone || 'sin telefono'}</p>
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-semibold">{group.contacts.length}</span>
                          </div>
                          <p className="text-xs text-slate-500 mt-1">{totalLeads} lead{totalLeads !== 1 ? 's' : ''} vinculados</p>
                        </button>
                      )
                    })}
                  </div>

                  <div className="flex-1 min-w-0 overflow-y-auto">
                    {selectedDuplicateGroup && (
                      <div className="p-4 space-y-4">
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Grupo</p>
                            <h3 className="text-base font-semibold text-slate-900">+{selectedDuplicateGroup.normalized_phone || 'sin telefono'}</h3>
                            <p className="text-xs text-slate-500">El contacto elegido conservará sus datos; los leads e historial de los demás se sumarán.</p>
                          </div>
                          <button
                            onClick={() => loadMergePreview(selectedDuplicateGroup, mergeKeepByGroup[selectedDuplicateGroup.group_key] || selectedDuplicateGroup.recommended_keep_id)}
                            disabled={loadingMergePreview}
                            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50"
                          >
                            <Eye className="w-3.5 h-3.5" />
                            {loadingMergePreview ? 'Revisando...' : 'Actualizar preview'}
                          </button>
                        </div>

                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                          {selectedDuplicateGroup.contacts.map(({ contact, counts }) => {
                            const keepId = mergeKeepByGroup[selectedDuplicateGroup.group_key] || selectedDuplicateGroup.recommended_keep_id
                            const isKeep = keepId === contact.id
                            return (
                              <label key={contact.id} className={`border rounded-lg p-3 cursor-pointer transition ${isKeep ? 'border-emerald-300 bg-emerald-50/60' : 'border-slate-200 hover:border-slate-300'}`}>
                                <div className="flex items-start gap-3">
                                  <input
                                    type="radio"
                                    name={`keep-${selectedDuplicateGroup.group_key}`}
                                    checked={isKeep}
                                    onChange={() => {
                                      setMergeKeepByGroup(prev => ({ ...prev, [selectedDuplicateGroup.group_key]: contact.id }))
                                      loadMergePreview(selectedDuplicateGroup, contact.id)
                                    }}
                                    className="mt-1 accent-emerald-600"
                                  />
                                  <div className="w-9 h-9 bg-white rounded-full flex items-center justify-center shrink-0 border border-slate-200">
                                    <span className="text-emerald-700 text-xs font-bold">{getInitials(contact)}</span>
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2">
                                      <p className="text-sm font-semibold text-slate-900 truncate">{getDisplayName(contact)}</p>
                                      {isKeep && <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-600 text-white font-semibold">Se mantiene</span>}
                                    </div>
                                    <p className="text-xs text-slate-500 truncate">{contact.jid}</p>
                                    <div className="mt-2 flex flex-wrap gap-1.5 text-[10px]">
                                      <span className="px-1.5 py-0.5 bg-white border border-slate-200 rounded">{counts.leads} leads</span>
                                      <span className="px-1.5 py-0.5 bg-white border border-slate-200 rounded">{counts.chats} chats</span>
                                      <span className="px-1.5 py-0.5 bg-white border border-slate-200 rounded">{getRelationTotal(counts)} relaciones</span>
                                    </div>
                                  </div>
                                </div>
                              </label>
                            )
                          })}
                        </div>

                        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                          <div className="border border-slate-200 rounded-lg overflow-hidden">
                            <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
                              <p className="text-xs font-semibold text-slate-700">Campos finales</p>
                              {loadingMergePreview && <RefreshCw className="w-3 h-3 text-slate-400 animate-spin" />}
                            </div>
                            <div className="divide-y divide-slate-100 max-h-72 overflow-y-auto">
                              {(mergePreview?.fields || []).map(field => (
                                <div key={field.field} className="px-3 py-2 grid grid-cols-[120px_1fr_auto] gap-2 items-center text-xs">
                                  <span className="text-slate-500">{field.label}</span>
                                  <span className="text-slate-900 truncate">{field.final_value || '-'}</span>
                                  {field.conflict && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-semibold">conflicto</span>}
                                </div>
                              ))}
                              {!loadingMergePreview && !mergePreview && (
                                <p className="text-xs text-slate-400 text-center py-6">Selecciona un contacto para revisar la fusión.</p>
                              )}
                            </div>
                          </div>

                          <div className="border border-slate-200 rounded-lg overflow-hidden">
                            <div className="px-3 py-2 bg-slate-50 border-b border-slate-200">
                              <p className="text-xs font-semibold text-slate-700">Leads que quedarán vinculados</p>
                            </div>
                            <div className="divide-y divide-slate-100 max-h-72 overflow-y-auto">
                              {(mergePreview?.leads || []).map(lead => (
                                <div key={lead.id} className="px-3 py-2 text-xs">
                                  <div className="flex items-center justify-between gap-2">
                                    <p className="font-medium text-slate-900 truncate">{lead.name || lead.phone || lead.id}</p>
                                    {(lead.is_archived || lead.is_blocked) && <span className="text-[10px] text-slate-500">{lead.is_archived ? 'Archivado' : 'Bloqueado'}</span>}
                                  </div>
                                  <p className="text-slate-500 truncate">{lead.pipeline_name || 'Sin pipeline'} / {lead.stage_name || 'Sin etapa'}</p>
                                </div>
                              ))}
                              {!loadingMergePreview && mergePreview?.leads?.length === 0 && (
                                <p className="text-xs text-slate-400 text-center py-6">No hay leads vinculados en este grupo.</p>
                              )}
                            </div>
                          </div>
                        </div>

                        {mergePreview?.warnings && mergePreview.warnings.length > 0 && (
                          <div className="border border-amber-200 bg-amber-50 rounded-lg px-3 py-2 text-xs text-amber-800">
                            {mergePreview.warnings.join(' ')}
                          </div>
                        )}

                        <div className="sticky bottom-0 bg-white border-t border-slate-200 -mx-4 -mb-4 px-4 py-3 flex items-center justify-between gap-3">
                          <p className="text-xs text-slate-500">
                            Se moverán {mergePreview?.counts.leads || 0} leads, {mergePreview?.counts.chats || 0} chats y {mergePreview?.counts.tasks || 0} tareas desde los duplicados.
                          </p>
                          <button
                            onClick={() => handleMerge(selectedDuplicateGroup)}
                            disabled={!mergePreview || mergingGroupKey === selectedDuplicateGroup.group_key || loadingMergePreview}
                            className="inline-flex items-center gap-1.5 px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-semibold"
                          >
                            {mergingGroupKey === selectedDuplicateGroup.group_key ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Merge className="w-4 h-4" />}
                            Unificar grupo
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Device Selector Modal for WhatsApp */}
      {showSendMessage && selectedContact && (
        <div className="app-viewport fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm border border-slate-100">
	            <h2 className="text-sm font-semibold text-slate-900 mb-3">Seleccionar dispositivo</h2>
	            <p className="text-xs text-slate-500 mb-4">Elige el dispositivo para enviar el mensaje a {whatsappPhone}</p>
	            {existingChatForWA && (
	              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 mb-3">
	                Ya existe historial{whatsappHistoricalPhone ? ` con el numero ${whatsappHistoricalPhone}` : ' con numero historico desconocido'}.
	              </p>
	            )}
            {allDevicesForModal.filter(d => d.status === 'connected').length === 0 ? (
              <p className="text-xs text-slate-400 text-center py-4">No hay dispositivos conectados</p>
            ) : (
              <div className="space-y-2">
                {/* Connected devices — sort chat owner first */}
                {[...allDevicesForModal.filter(d => d.status === 'connected')].sort((a, b) => {
                  if (existingChatForWA?.device_id === a.id) return -1
                  if (existingChatForWA?.device_id === b.id) return 1
                  return 0
	                }).map((device) => {
	                  const isChatOwner = device.matches_historical || existingChatForWA?.device_id === device.id
                  return (
                    <button
                      key={device.id}
                      onClick={() => handleContactDeviceSelected(device)}
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
                {existingChatForWA && existingChatForWA.device_id && !allDevicesForModal.find(d => d.id === existingChatForWA.device_id && d.status === 'connected') && (
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
            <button
              onClick={resetInlineChatState}
              className="w-full mt-4 px-4 py-2 border border-slate-200 text-slate-600 rounded-xl hover:bg-slate-50 text-sm"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      <ImportCSVModal
        open={showImportModal}
        onClose={() => setShowImportModal(false)}
        onSuccess={fetchContacts}
        defaultType="contacts"
      />

      <CreateContactModal
        open={showCreateContact}
        onClose={() => setShowCreateContact(false)}
        onSuccess={fetchContacts}
      />

      <PasteFromExcelModal
        open={showPasteExcel}
        onClose={() => setShowPasteExcel(false)}
        onSuccess={fetchContacts}
      />

      {/* Opportunity history for a contact */}
      {showContactLeads && contactLeadsTarget && (
        <div className="app-viewport fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/55 p-0 backdrop-blur-sm sm:p-4" onMouseDown={event => { if (event.target === event.currentTarget) closeContactOpportunities() }}>
          <div ref={contactOpportunitiesDialogRef} role="dialog" aria-modal="true" aria-labelledby="contact-opportunities-title" aria-describedby="contact-opportunities-description" tabIndex={-1} className="flex h-full w-full max-w-3xl flex-col overflow-hidden bg-white shadow-2xl sm:h-auto sm:max-h-[88vh] sm:rounded-3xl">
            <header className="flex items-start gap-3 border-b border-slate-200 px-5 py-5 sm:px-6">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-700"><Radio className="h-5 w-5" /></div>
              <div className="min-w-0 flex-1">
                <h2 id="contact-opportunities-title" className="truncate text-lg font-bold text-slate-900">Oportunidades de {getDisplayName(contactLeadsTarget)}</h2>
                <p id="contact-opportunities-description" className="mt-1 text-sm text-slate-500">Cada oportunidad representa un interés comercial distinto; la persona y sus datos permanecen en el contacto.</p>
              </div>
              <span className="hidden rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold tabular-nums text-slate-600 sm:inline-flex">{contactLeads.length}</span>
              <button type="button" onClick={closeContactOpportunities} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-500 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label="Cerrar historial de oportunidades"><X className="h-5 w-5" /></button>
            </header>

            {contactLeads.filter((lead: any) => lead.status === 'open' && !lead.is_archived && !lead.deleted_at).length >= 2 && (
              <div className="mx-5 mt-4 flex items-start gap-3 rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 sm:mx-6">
                <Hash className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
                <p className="text-xs leading-relaxed text-blue-800">Hay <strong>{contactLeads.filter((lead: any) => lead.status === 'open' && !lead.is_archived && !lead.deleted_at).length} oportunidades abiertas</strong>. Esto es válido; sus títulos y pipelines permiten distinguir qué proceso representa cada una.</p>
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50/70 p-5 sm:p-6">
              {contactLeadsLoading ? (
                <div className="flex min-h-48 items-center justify-center" aria-busy="true"><div className="h-7 w-7 animate-spin rounded-full border-2 border-slate-200 border-b-emerald-600 motion-reduce:animate-none" /><span className="ml-3 text-sm font-medium text-slate-500">Cargando oportunidades…</span></div>
              ) : contactLeads.length === 0 ? (
                <div className="flex min-h-56 flex-col items-center justify-center rounded-3xl border border-dashed border-slate-300 bg-white px-6 text-center">
                  <Users className="h-10 w-10 text-slate-300" />
                  <p className="mt-3 font-bold text-slate-700">Aún no tiene oportunidades</p>
                  <p className="mt-1 max-w-sm text-sm leading-relaxed text-slate-500">Puedes crear una desde Leads sin duplicar este contacto.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {contactLeads.map((lead: any) => {
                    const lifecycle = lead.deleted_at
                      ? { label: 'Papelera', className: 'bg-slate-200 text-slate-700' }
                      : lead.is_archived
                        ? { label: 'Archivada', className: 'bg-amber-100 text-amber-800' }
                        : lead.status === 'won'
                          ? { label: 'Ganada', className: 'bg-emerald-100 text-emerald-800' }
                          : lead.status === 'lost'
                            ? { label: 'Perdida', className: 'bg-red-100 text-red-800' }
                            : { label: 'Abierta', className: 'bg-blue-100 text-blue-800' }
                    return (
                      <article key={lead.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-slate-300 hover:shadow-md">
                        <div className="flex items-start gap-3">
                          <span className="mt-1 h-3 w-3 shrink-0 rounded-full ring-2 ring-white shadow-[0_0_0_1px_rgba(15,23,42,0.15)]" style={{ backgroundColor: lead.stage_color || '#94a3b8' }} aria-hidden="true" />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <h3 className="min-w-0 truncate text-sm font-bold text-slate-900">{lead.title || 'Oportunidad sin título'}</h3>
                              <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${lifecycle.className}`}>{lifecycle.label}</span>
                              {lead.is_blocked && <span className="rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-red-700 ring-1 ring-red-200">No contactable</span>}
                            </div>
                            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                              <span>{lead.pipeline_name || 'Sin pipeline'}</span>
                              <span aria-hidden="true">·</span>
                              <span className="font-medium text-slate-600">{lead.stage_name || 'Sin etapa'}</span>
                              {lead.created_at && <><span aria-hidden="true">·</span><span>{format(new Date(lead.created_at), 'dd/MM/yy', { locale: es })}</span></>}
                            </div>
                            {lead.status === 'lost' && lead.close_reason && <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-red-700">Motivo: {lead.close_reason}</p>}
                          </div>
                          <button type="button" onClick={() => { closeContactOpportunities(); router.push(`/dashboard/leads?lead_id=${lead.id}`) }} className="inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-xl border border-slate-200 px-3 text-xs font-bold text-slate-700 transition hover:border-emerald-200 hover:bg-emerald-50 hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label={`Abrir ${lead.title || 'oportunidad'}`}>
                            Abrir <ExternalLink className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </article>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Export Modal */}

      {/* Bulk Document Generation Modal */}
      {showBulkDocModal && (
        <BulkGenerateDocumentModal
          leads={contacts.map(c => ({
            id: c.id,
            jid: c.jid,
            contact_id: c.id,
            name: c.custom_name || c.name || c.push_name || '',
            last_name: c.last_name || '',
            short_name: c.short_name || null,
            phone: c.phone || '',
            email: c.email || '',
            company: c.company || null,
            age: c.age,
            dni: c.dni || null,
            birth_date: c.birth_date || null,
            address: c.address || null,
            status: '',
            pipeline_id: null,
            stage_id: null,
            stage_name: null,
            stage_color: null,
            stage_position: null,
            notes: c.notes || '',
            tags: c.tags || [],
            structured_tags: c.structured_tags || null,
            kommo_id: c.kommo_id,
            is_archived: false,
            archived_at: null,
            is_blocked: false,
            blocked_at: null,
            block_reason: '',
            kommo_deleted_at: null,
            assigned_to: '',
            created_at: c.created_at,
            updated_at: c.updated_at,
          }) as Lead)}
          onClose={() => setShowBulkDocModal(false)}
        />
      )}

      {showExportModal && (
        <div className="responsive-dialog-backdrop fixed inset-0 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl p-6 w-full max-w-sm">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-emerald-100 rounded-full flex items-center justify-center">
                <Download className="w-5 h-5 text-emerald-600" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-slate-900">Exportar Contactos</h3>
                <p className="text-sm text-slate-500">{total.toLocaleString()} contactos{activeFilterCount > 0 ? ' (filtrados)' : ''}</p>
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
                      <p className="text-sm font-medium text-slate-700">Todos los contactos</p>
                    </div>
                  </label>
                  <label className={`flex items-center gap-3 p-3 border rounded-lg cursor-pointer hover:bg-slate-50 ${activeFilterCount > 0 ? 'border-emerald-300 bg-emerald-50/50' : 'border-slate-200'}`}>
                    <input type="radio" checked={exportScope === 'filtered'} onChange={() => setExportScope('filtered')} className="text-emerald-600 focus:ring-emerald-500" />
                    <div>
                      <p className="text-sm font-medium text-slate-700">Solo filtrados ({total.toLocaleString()})</p>
                      {activeFilterCount > 0 && <p className="text-xs text-emerald-600">{activeFilterCount} filtro{activeFilterCount > 1 ? 's' : ''} activo{activeFilterCount > 1 ? 's' : ''}</p>}
                    </div>
                  </label>
                </div>
              </div>

              <label className="flex items-center gap-3 p-3 border border-slate-200 rounded-lg cursor-pointer hover:bg-slate-50">
                <input type="checkbox" checked={exportIncludeTags} onChange={e => setExportIncludeTags(e.target.checked)} className="rounded text-emerald-600 focus:ring-emerald-500" />
                <div>
                  <p className="text-sm font-medium text-slate-700">Incluir etiquetas</p>
                  <p className="text-xs text-slate-500">Agrega columna &quot;tags&quot; al archivo</p>
                </div>
              </label>
            </div>

            <div className="flex gap-3 mt-6">
              <button onClick={() => setShowExportModal(false)} className="flex-1 px-4 py-2 border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 text-sm">
                Cancelar
              </button>
              <button onClick={handleExportContacts} disabled={exporting}
                className="flex-1 px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 text-sm disabled:opacity-50 flex items-center justify-center gap-2">
                {exporting ? <><div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" /> Exportando...</> : <><Download className="w-4 h-4" /> Exportar</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Broadcast from Contacts Modal */}
      <CreateCampaignModal
        open={showBroadcastModal}
        onClose={() => {
          if (submittingBroadcast) return
          setShowBroadcastModal(false)
          setPendingBroadcastCampaignId(null)
        }}
        onSubmit={handleCreateBroadcastFromContacts}
        devices={devices.filter(d => d.status === 'connected')}
        submitting={submittingBroadcast}
        title="Envío Masivo desde Contactos"
        subtitle={`${total.toLocaleString()} contactos coinciden con la vista actual`}
        submitLabel={submittingBroadcast ? 'Creando...' : 'Crear y agregar destinatarios'}
        initialName={`Contactos - ${new Date().toLocaleDateString('es-PE', { day: 'numeric', month: 'short' })}`}
        infoPanel={
          <div className="bg-emerald-50 border border-emerald-100 rounded-xl p-3 text-xs text-emerald-800">
            <div className="flex items-center gap-2 mb-1">
              <Radio className="w-3.5 h-3.5 text-emerald-600" />
              <span className="font-medium">Destinatarios desde Contactos</span>
            </div>
            <p className="text-emerald-600">
              El servidor resolverá los <strong>{total.toLocaleString()}</strong> contactos
              {activeFilterCount > 0 || searchTerm || filterDevice
                ? ' filtrados' : ''}, incluso los que aún no se cargaron en la tabla.
            </p>
            <p className="text-slate-500 mt-1">
              Se excluirán grupos, contactos sin teléfono y contactos marcados como “No contactar”.
            </p>
          </div>
        }
      />
    </div>
  )
}
