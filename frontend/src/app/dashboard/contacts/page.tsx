'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import {
  Search, Phone, PhoneOff, Mail, Building2, Tag, Edit, Trash2, RefreshCw,
  ChevronDown, CheckSquare, Square, XCircle, MoreVertical, MoreHorizontal,
  Users, Merge, Eye, X, Smartphone, AlertTriangle, MessageSquare, Send,
  Clock, Plus, FileText, Maximize2, CalendarDays, Upload, Calendar, User, Save, Edit2, Filter, Radio,
  UserPlus, ClipboardPaste, Hash, Code, Download, CheckCircle2, ExternalLink, ArrowUpDown, ChevronUp, Cloud
} from 'lucide-react'
import { formatDistanceToNow, format } from 'date-fns'
import { es } from 'date-fns/locale'
import ImportCSVModal from '@/components/ImportCSVModal'
import TagInput from '@/components/TagInput'
import CreateCampaignModal, { CampaignFormResult } from '@/components/CreateCampaignModal'
import CreateContactModal from '@/components/CreateContactModal'
import PasteFromExcelModal from '@/components/PasteFromExcelModal'
import LeadDetailPanel from '@/components/LeadDetailPanel'
import FormulaEditor from '@/components/FormulaEditor'
import type { Lead } from '@/types/contact'

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

interface Device {
  id: string
  name: string
  phone?: string
  status: string
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
  const [contacts, setContacts] = useState<Contact[]>([])
  const [devices, setDevices] = useState<Device[]>([])
  const [loading, setLoading] = useState(true)
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
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  // Selection
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Detail / Edit
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null)
  const [showDetailPanel, setShowDetailPanel] = useState(false)
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
  })

  // Duplicates
  const [showDuplicates, setShowDuplicates] = useState(false)
  const [duplicateGroups, setDuplicateGroups] = useState<Contact[][]>([])
  const [loadingDuplicates, setLoadingDuplicates] = useState(false)

  // Sort
  const [sortBy, setSortBy] = useState('')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc')

  // Duplicate leads alert
  const [duplicateLeadsCount, setDuplicateLeadsCount] = useState(0)
  const [duplicateLeadsDismissed, setDuplicateLeadsDismissed] = useState(false)
  const [archivingLeadId, setArchivingLeadId] = useState<string | null>(null)

  const [showImportModal, setShowImportModal] = useState(false)
  const [showCreateContact, setShowCreateContact] = useState(false)
  const [showPasteExcel, setShowPasteExcel] = useState(false)

  // Toolbar dropdown
  const [showMoreMenu, setShowMoreMenu] = useState(false)
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

  // Send message
  const [showSendMessage, setShowSendMessage] = useState(false)
  const [sendDeviceId, setSendDeviceId] = useState('')
  const [sendLoading, setSendLoading] = useState(false)

  // Ver Leads modal
  const [showContactLeads, setShowContactLeads] = useState(false)
  const [contactLeadsTarget, setContactLeadsTarget] = useState<Contact | null>(null)
  const [contactLeads, setContactLeads] = useState<any[]>([])
  const [contactLeadsLoading, setContactLeadsLoading] = useState(false)

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

  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null

  const fetchContacts = useCallback(async (reset: boolean = true) => {
    if (!token) return
    const offset = reset ? 0 : offsetRef.current
    if (reset) {
      setLoading(true)
    } else {
      setLoadingMore(true)
    }
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

      const res = await fetch(`/api/contacts?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
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
      }
    } catch (err) {
      console.error('Failed to fetch contacts:', err)
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, searchTerm, filterDevice, appliedFormulaType, appliedFormulaText, filterTagNames, excludeFilterTagNames, tagFilterMode, filterDatePreset, filterDateField, filterDateFrom, filterDateTo, sortBy, sortOrder])

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
    // Check for contacts with duplicate leads
    if (token) {
      fetch('/api/contacts/lead-duplicates', { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.json())
        .then(d => { if (d.success) setDuplicateLeadsCount(d.count || 0) })
        .catch(() => {})
      // Check Google Contacts status
      fetch('/api/google/status', { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.json())
        .then(d => { if (d.success) setGoogleConnected(d.connected || false) })
        .catch(() => {})
    }
  }, [fetchDevices, fetchAllTags])

  // Debounced fetch: resets scroll to top on filter/search change
  const [debouncedSearch, setDebouncedSearch] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchTerm), 500)
    return () => clearTimeout(timer)
  }, [searchTerm])

  useEffect(() => {
    offsetRef.current = 0
    fetchContacts(true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, filterDevice, appliedFormulaType, appliedFormulaText, filterTagNames, excludeFilterTagNames, tagFilterMode, filterDatePreset, filterDateField, filterDateFrom, filterDateTo, sortBy, sortOrder])

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
      if (showSendMessage) { setShowSendMessage(false); setSendDeviceId(''); return }
      if (showDuplicates) { setShowDuplicates(false); return }
      if (showEditModal) { setShowEditModal(false); setSelectedContact(null); return }
      if (showDetailPanel) { setShowDetailPanel(false); return }
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [showSendMessage, showDuplicates, showEditModal, showDetailPanel])

  const openDetail = async (contact: Contact) => {
    // Fetch full contact with device names
    try {
      const res = await fetch(`/api/contacts/${contact.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        setSelectedContact(data.contact)
        setShowDetailPanel(true)
      }
    } catch {
      setSelectedContact(contact)
      setShowDetailPanel(true)
    }
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

  const handleResetFromDevice = async (contactId: string) => {
    if (!confirm('¿Restaurar datos del dispositivo? Se eliminará el nombre personalizado.')) return
    try {
      const res = await fetch(`/api/contacts/${contactId}/reset`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        fetchContacts()
        if (data.contact) setSelectedContact(data.contact)
      } else {
        alert(data.error || 'Error al restaurar')
      }
    } catch {
      alert('Error de conexión')
    }
  }

  const handleDeleteContact = async (contactId: string) => {
    if (!confirm('¿Estás seguro de eliminar este contacto?')) return
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
    if (!confirm(`¿Eliminar ${selectedIds.size} contacto(s)?`)) return
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
        setDuplicateGroups(data.duplicates || [])
        setShowDuplicates(true)
      }
    } catch {
      alert('Error buscando duplicados')
    } finally {
      setLoadingDuplicates(false)
    }
  }

  const handleMerge = async (keepId: string, mergeIds: string[]) => {
    if (!confirm(`¿Fusionar ${mergeIds.length + 1} contactos? Los duplicados se eliminarán.`)) return
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
        handleFindDuplicates() // Refresh duplicates
      }
    } catch {
      alert('Error al fusionar')
    }
  }



  const handleSendMessageToContact = async (deviceId?: string) => {
    const devId = deviceId || sendDeviceId
    if (!selectedContact || !devId) return
    setSendDeviceId(devId)
    setSendLoading(true)

    const phone = selectedContact.phone || selectedContact.jid?.replace(/@.*$/, '') || ''
    if (!phone) {
      alert('Este contacto no tiene número de teléfono')
      setSendLoading(false)
      return
    }

    try {
      const res = await fetch('/api/chats/new', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          device_id: devId,
          phone: phone.replace(/[^0-9]/g, ''),
        }),
      })
      const data = await res.json()
      if (data.success) {
        setShowSendMessage(false)
        setShowDetailPanel(false)
        router.push(`/dashboard/chats?open=${data.chat.id}`)
      } else {
        alert(data.error || 'Error al crear conversación')
      }
    } catch {
      alert('Error de conexión')
    } finally {
      setSendLoading(false)
    }
  }

  // Contacts with phone for broadcast
  const broadcastableContacts = contacts.filter(c => c.phone)

  // Active filter count
  const activeFilterCount = filterTagNames.size + excludeFilterTagNames.size + (appliedFormulaType === 'advanced' && appliedFormulaText ? 1 : 0) + (filterDatePreset ? 1 : 0)

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

  // Archive (finalize) a lead from the Ver Leads modal
  const handleArchiveLeadFromModal = async (leadId: string) => {
    if (!token || !contactLeadsTarget) return
    if (!confirm('¿Finalizar este lead? Se archivará y sus etiquetas se recalcularán en el contacto.')) return
    setArchivingLeadId(leadId)
    try {
      const res = await fetch(`/api/leads/${leadId}/archive`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ archive: true }),
      })
      const data = await res.json()
      if (data.success) {
        // Refresh the leads list for this contact
        fetchContactLeads(contactLeadsTarget)
        // Refresh contacts list and duplicate count
        fetchContacts()
        fetch('/api/contacts/lead-duplicates', { headers: { Authorization: `Bearer ${token}` } })
          .then(r => r.json())
          .then(d => { if (d.success) setDuplicateLeadsCount(d.count || 0) })
          .catch(() => {})
      }
    } catch {
      console.error('Failed to archive lead')
    } finally {
      setArchivingLeadId(null)
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

      // 3. Add filtered contacts as recipients
      const recipientsList = broadcastableContacts.map(contact => {
        const cleanPhone = (contact.phone || '').replace(/[^0-9]/g, '')
        return {
          jid: cleanPhone ? cleanPhone + '@s.whatsapp.net' : '',
          name: getDisplayName(contact),
          phone: cleanPhone,
          metadata: {
            ...(contact.short_name ? { nombre_corto: contact.short_name } : {}),
            ...(contact.company ? { empresa: contact.company } : {}),
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
    } catch {
      alert('Error al crear campaña desde contactos')
    } finally {
      setSubmittingBroadcast(false)
    }
  }

  if (loading && contacts.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-600" />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center gap-3 py-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <h1 className="text-lg font-bold text-slate-900 whitespace-nowrap">Contactos</h1>
          <span className="text-xs text-slate-400 font-medium tabular-nums bg-slate-100 px-2 py-0.5 rounded-full">{total.toLocaleString()}</span>
          {duplicateLeadsCount > 0 && !duplicateLeadsDismissed && (
            <button onClick={() => setDuplicateLeadsDismissed(true)} className="text-amber-500 hover:text-amber-600 transition-colors" title={`${duplicateLeadsCount} contacto(s) con múltiples leads activos`}>
              <AlertTriangle className="w-4 h-4" />
            </button>
          )}
        </div>

        <div ref={filterDropdownRef} className="flex-1 max-w-sm relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 z-10" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onFocus={() => setShowFilterDropdown(true)}
            placeholder="Buscar por nombre, teléfono, email..."
            className={`w-full pl-8 pr-3 py-1.5 bg-white border rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 text-slate-800 placeholder:text-slate-400 text-sm ${activeFilterCount > 0 ? 'border-emerald-400 ring-1 ring-emerald-200' : 'border-slate-200'}`}
          />
          {activeFilterCount > 0 && !showFilterDropdown && (
            <span className="absolute right-2.5 top-1/2 -translate-y-1/2 w-5 h-5 bg-emerald-600 text-white text-[10px] font-bold rounded-full flex items-center justify-center">{activeFilterCount}</span>
          )}

          {/* Filter dropdown */}
          {showFilterDropdown && (
            <div className="absolute left-0 top-full mt-1.5 w-[min(560px,90vw)] bg-white border border-slate-200 rounded-xl shadow-2xl z-40 flex flex-col max-h-[70vh] overflow-hidden" onMouseDown={(e) => e.stopPropagation()}>
              {/* Dropdown header */}
              <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between shrink-0">
                <div className="flex items-center gap-2.5">
                  <Filter className="w-4 h-4 text-emerald-500" />
                  <span className="text-sm font-semibold text-slate-800">Filtros</span>
                  {activeFilterCount > 0 && (
                    <span className="text-[10px] font-medium bg-emerald-50 text-emerald-600 px-2 py-0.5 rounded-full">{activeFilterCount} activo{activeFilterCount > 1 ? 's' : ''}</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {activeFilterCount > 0 && (
                    <button
                      onClick={() => { setFilterTagNames(new Set()); setExcludeFilterTagNames(new Set()); setTagFilterMode('OR'); setLeadFormulaType('simple'); setLeadFormulaText(''); setLeadFormulaIsValid(true); setAppliedFormulaType('simple'); setAppliedFormulaText(''); setFilterDateField('created_at'); setFilterDatePreset(''); setFilterDateFrom(''); setFilterDateTo(''); setFilterDevice('') }}
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

              {/* ─── Responsive Body: 2 cols when space, 1 col when narrow ─── */}
              <div className="flex flex-col sm:flex-row flex-1 min-h-0 overflow-hidden">

                {/* ══ Left Column — Device + Date ══ */}
                <div className="w-full sm:w-[220px] shrink-0 border-b sm:border-b-0 sm:border-r border-slate-100 overflow-y-auto p-3 space-y-4 bg-slate-50/30 max-h-[30vh] sm:max-h-none">
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

                {/* ══ Right Column — Tags ══ */}
                <div className="flex-1 min-w-0 overflow-y-auto p-3 space-y-4">

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
                            <div><code className="text-violet-600 bg-violet-50 px-1 py-0.5 rounded">( )</code> agrupar</div>
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

        <div className="flex items-center gap-2 flex-shrink-0">
          {selectionMode ? (
            /* Selection mode bar */
            <>
              <span className="px-3 py-2 text-sm text-slate-600 font-medium">
                {selectedIds.size} seleccionado{selectedIds.size !== 1 ? 's' : ''}
              </span>
              <button
                onClick={() => setSelectedIds(new Set(contacts.map(c => c.id)))}
                className="px-3 py-2 text-sm border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"
              >
                Todos
              </button>
              <button
                onClick={handleDeleteSelected}
                disabled={selectedIds.size === 0}
                className="px-3 py-2 text-sm bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Eliminar ({selectedIds.size})
              </button>
              {googleConnected && (
                <>
                  <button
                    onClick={handleGoogleBatchSync}
                    disabled={selectedIds.size === 0 || selectedIds.size > 30 || googleSyncing}
                    className="px-3 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
                    title="Sincronizar con Google Contacts"
                  >
                    {googleSyncing ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                    Google Sync
                  </button>
                  <button
                    onClick={handleGoogleBatchDesync}
                    disabled={selectedIds.size === 0 || selectedIds.size > 30 || googleSyncing}
                    className="px-3 py-2 text-sm border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5 text-slate-600"
                    title="Quitar de Google Contacts"
                  >
                    <XCircle className="w-3.5 h-3.5" />
                    Desync
                  </button>
                </>
              )}
              <button
                onClick={() => { setSelectionMode(false); setSelectedIds(new Set()) }}
                className="w-9 h-9 flex items-center justify-center border border-slate-300 rounded-lg hover:bg-slate-50 text-slate-500 hover:text-slate-700 transition-colors"
                title="Cancelar selección"
              >
                <X className="w-4 h-4" />
              </button>
            </>
          ) : (
            /* Normal mode */
            <>
              {/* ··· More dropdown */}
              <div ref={moreMenuRef} className="relative">
                <button
                  onClick={() => setShowMoreMenu(v => !v)}
                  className={`inline-flex items-center gap-1.5 px-3 py-2 border rounded-lg text-sm transition-colors ${
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

                {showMoreMenu && (
                  <div className="absolute right-0 top-full mt-1.5 w-56 bg-white border border-slate-200 rounded-xl shadow-xl z-30 py-1 overflow-hidden">
                    <button
                      onClick={() => { setShowCreateContact(true); setShowMoreMenu(false) }}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-emerald-700 font-medium hover:bg-emerald-50 transition-colors"
                    >
                      <UserPlus className="w-4 h-4 text-emerald-500" />
                      Nuevo contacto
                    </button>
                    <button
                      onClick={() => { fetchDevices(); setShowBroadcastModal(true); setShowMoreMenu(false) }}
                      disabled={broadcastableContacts.length === 0}
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
                      Importar CSV
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
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-col flex-1 min-h-0">
          {/* Counter bar */}
          <div className="flex items-center justify-between px-4 py-2 border-b border-slate-100 bg-slate-50/50 shrink-0">
            <p className="text-xs text-slate-500">
              Mostrando {contacts.length} de {total.toLocaleString()} contactos
            </p>
            {loadingMore && (
              <div className="flex items-center gap-1.5 text-xs text-emerald-600">
                <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-emerald-600" />
                Cargando más...
              </div>
            )}
          </div>

          {/* Scrollable table with sticky header */}
          <div
            ref={scrollContainerRef}
            onScroll={handleContactsScroll}
            className="overflow-y-auto overflow-x-auto flex-1 min-h-0"
          >
            <table className="w-full">
              <thead className="bg-slate-100 border-b-2 border-slate-200 sticky top-0 z-10">
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
                  <th className="w-10 px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {contacts.length === 0 && !loading ? (
                  <tr>
                    <td colSpan={selectionMode ? 8 : 7} className="text-center py-12 text-slate-500">
                      <Users className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                      <p className="text-base font-medium">No hay contactos</p>
                      <p className="text-sm mt-1">Los contactos se sincronizan automáticamente desde tus dispositivos WhatsApp</p>
                    </td>
                  </tr>
                ) : contacts.map((contact) => (
                  <tr
                    key={contact.id}
                    className={`hover:bg-slate-50 cursor-pointer transition ${
                      selectedIds.has(contact.id) ? 'bg-emerald-50' : ''
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
                        contact.source === 'kommo' ? 'bg-blue-50 text-blue-600' : 'bg-emerald-50 text-emerald-600'
                      }`}>
                        {contact.source || 'whatsapp'}
                      </span>
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell">
                      {(contact.lead_count ?? 0) > 0 ? (
                        <button
                          onClick={(e) => { e.stopPropagation(); fetchContactLeads(contact) }}
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium transition ${
                            (contact.lead_count ?? 0) >= 2
                              ? 'bg-amber-50 text-amber-700 hover:bg-amber-100'
                              : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                          }`}
                          title={(contact.lead_count ?? 0) >= 2 ? 'Este contacto tiene múltiples leads activos' : undefined}
                        >
                          {(contact.lead_count ?? 0) >= 2 && <AlertTriangle className="w-3 h-3" />}
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
                                const connDevices = devices.filter(d => d.status === 'connected')
                                if (connDevices.length === 0) { alert('No hay dispositivos conectados'); return }
                                if (connDevices.length === 1) setSendDeviceId(connDevices[0].id); else setSendDeviceId('')
                                setShowSendMessage(true)
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
                ))}
              </tbody>
            </table>

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

      {/* Detail Panel (Slide-over) */}
      {showDetailPanel && selectedContact && (
        <div className="fixed inset-0 z-50 flex justify-end overflow-hidden">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" onClick={() => setShowDetailPanel(false)} />
          <div className="relative w-full max-w-md bg-white shadow-2xl overflow-hidden border-l border-slate-200">
            <LeadDetailPanel
              contactMode
              contactId={selectedContact.id}
              lead={contactToLead(selectedContact)}
              onLeadChange={(updatedLead) => {
                setSelectedContact({
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
                  notes: updatedLead.notes,
                  structured_tags: updatedLead.structured_tags,
                })
              }}
              onClose={() => setShowDetailPanel(false)}
              onDelete={() => {
                setShowDetailPanel(false)
                setSelectedContact(null)
                fetchContacts()
              }}
              deviceNames={selectedContact.device_names}
              pushName={selectedContact.push_name}
              avatarUrl={selectedContact.avatar_url}
              onResetFromDevice={() => handleResetFromDevice(selectedContact.id)}
              onSendMessage={() => {
                const connDevices = devices.filter(d => d.status === 'connected')
                if (connDevices.length === 0) {
                  alert('No hay dispositivos conectados')
                  return
                }
                if (connDevices.length === 1) {
                  setSendDeviceId(connDevices[0].id)
                } else {
                  setSendDeviceId('')
                }
                setShowSendMessage(true)
              }}
              onContactUpdate={(contact) => {
                setSelectedContact(contact)
                fetchContacts()
              }}
            />
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {showEditModal && selectedContact && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl p-6 w-full max-w-md max-h-[90vh] overflow-y-auto">
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
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-4 border-b border-slate-200">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-yellow-500" />
                <h2 className="text-lg font-semibold text-slate-900">
                  Contactos Duplicados ({duplicateGroups.length} grupos)
                </h2>
              </div>
              <button onClick={() => setShowDuplicates(false)} className="p-1 hover:bg-slate-100 rounded">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {duplicateGroups.length === 0 ? (
                <div className="text-center py-8 text-slate-500">
                  <CheckSquare className="w-12 h-12 mx-auto mb-3 text-emerald-500" />
                  <p className="font-medium">No se encontraron duplicados</p>
                </div>
              ) : duplicateGroups.map((group, gi) => (
                <div key={gi} className="border border-yellow-200 rounded-lg p-4 bg-yellow-50/50">
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-sm font-medium text-slate-700">
                      Teléfono: {group[0]?.phone || 'desconocido'} ({group.length} contactos)
                    </p>
                    <button
                      onClick={() => handleMerge(group[0].id, group.slice(1).map(c => c.id))}
                      className="flex items-center gap-1 px-3 py-1 text-sm bg-yellow-500 text-white rounded-lg hover:bg-yellow-600"
                    >
                      <Merge className="w-3.5 h-3.5" />
                      Fusionar
                    </button>
                  </div>
                  <div className="space-y-2">
                    {group.map((contact, ci) => (
                      <div key={contact.id} className="flex items-center gap-3 p-2 bg-white rounded-lg">
                        <div className="w-8 h-8 bg-emerald-50 rounded-full flex items-center justify-center flex-shrink-0">
                          <span className="text-emerald-700 text-xs font-medium">{getInitials(contact)}</span>
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-slate-900 truncate">{getDisplayName(contact)}</p>
                          <p className="text-xs text-slate-500">{contact.jid}</p>
                        </div>
                        {ci === 0 && (
                          <span className="px-2 py-0.5 bg-emerald-100 text-emerald-700 text-xs rounded font-medium">
                            Se mantiene
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Send Message Modal */}
      {showSendMessage && selectedContact && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4">
          <div className="bg-white rounded-xl p-6 w-full max-w-sm">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-emerald-100 rounded-full flex items-center justify-center">
                <Send className="w-5 h-5 text-emerald-600" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-slate-900">Enviar Mensaje</h3>
                <p className="text-sm text-slate-500">{getDisplayName(selectedContact)}</p>
              </div>
            </div>
            <p className="text-sm text-slate-600 mb-4">
              Selecciona el dispositivo para iniciar la conversación:
            </p>
            {devices.filter(d => d.status === 'connected').length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-4">No hay dispositivos conectados</p>
            ) : (
              <div className="space-y-2">
                {devices.filter(d => d.status === 'connected').map((device) => (
                  <button
                    key={device.id}
                    onClick={() => handleSendMessageToContact(device.id)}
                    disabled={sendLoading}
                    className="w-full flex items-center gap-3 p-3 border border-slate-200 rounded-lg hover:bg-emerald-50 hover:border-emerald-300 transition text-left disabled:opacity-50"
                  >
                    <div className="w-10 h-10 bg-emerald-100 rounded-full flex items-center justify-center">
                      <Smartphone className="w-5 h-5 text-emerald-600" />
                    </div>
                    <div className="flex-1">
                      <p className="font-medium text-slate-900">{device.name || 'Dispositivo'}</p>
                      <p className="text-xs text-slate-500">{device.phone || ''}</p>
                    </div>
                    {sendLoading && sendDeviceId === device.id && (
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-emerald-600" />
                    )}
                  </button>
                ))}
              </div>
            )}
            <button
              onClick={() => { setShowSendMessage(false); setSendDeviceId('') }}
              className="w-full mt-4 px-4 py-2 border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 text-sm"
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

      {/* Ver Leads Modal */}
      {showContactLeads && contactLeadsTarget && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => { setShowContactLeads(false); setContactLeads([]); setContactLeadsTarget(null) }}
          onKeyDown={(e) => { if (e.key === 'Escape') { setShowContactLeads(false); setContactLeads([]); setContactLeadsTarget(null) } }}>
          <div className="bg-white rounded-xl w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-slate-200">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">Leads de {getDisplayName(contactLeadsTarget)}</h2>
                <p className="text-sm text-slate-500">{contactLeads.length} lead{contactLeads.length !== 1 ? 's' : ''}</p>
              </div>
              <button onClick={() => { setShowContactLeads(false); setContactLeads([]); setContactLeadsTarget(null) }} className="p-1 hover:bg-slate-100 rounded">
                <X className="w-5 h-5 text-slate-400" />
              </button>
            </div>
            {/* Warning for multiple active leads */}
            {contactLeads.filter((l: any) => !l.is_archived && !l.is_blocked).length >= 2 && (
              <div className="mx-4 mt-3 flex items-start gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg">
                <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
                <p className="text-xs text-amber-700">
                  Este contacto tiene <strong>{contactLeads.filter((l: any) => !l.is_archived && !l.is_blocked).length} leads activos</strong>.
                  Se recomienda finalizar los leads que ya no estén en uso para evitar confusión de etiquetas.
                </p>
              </div>
            )}
            <div className="flex-1 overflow-y-auto p-4">
              {contactLeadsLoading ? (
                <div className="flex items-center justify-center py-8">
                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-emerald-600" />
                </div>
              ) : contactLeads.length === 0 ? (
                <div className="text-center py-8 text-slate-500">
                  <Users className="w-10 h-10 mx-auto mb-2 text-slate-300" />
                  <p className="font-medium">No tiene leads asociados</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {contactLeads.map((lead: any) => (
                    <div key={lead.id} className="flex items-center gap-3 p-3 border border-slate-200 rounded-lg hover:bg-slate-50 transition">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-slate-900 truncate">
                            {lead.name || ''} {lead.last_name || ''}
                          </p>
                          {lead.is_archived && <span className="px-1.5 py-0.5 bg-amber-100 text-amber-700 text-[10px] rounded font-medium">Archivado</span>}
                          {lead.is_blocked && <span className="px-1.5 py-0.5 bg-red-100 text-red-700 text-[10px] rounded font-medium">Bloqueado</span>}
                        </div>
                        <div className="flex items-center gap-3 mt-1">
                          {lead.phone && <span className="text-xs text-slate-500">{lead.phone}</span>}
                          {lead.pipeline_name && (
                            <span className="inline-flex items-center gap-1 text-xs text-slate-400">
                              {lead.pipeline_name}
                              {lead.stage_name && (
                                <>
                                  <span className="text-slate-300">&gt;</span>
                                  <span className="inline-flex items-center gap-1">
                                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: lead.stage_color || '#6b7280' }} />
                                    {lead.stage_name}
                                  </span>
                                </>
                              )}
                            </span>
                          )}
                        </div>
                        {lead.tags && lead.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1.5">
                            {lead.tags.slice(0, 4).map((tag: any) => (
                              <span key={tag.id || tag.name} className="px-1.5 py-0.5 text-[10px] rounded-full font-medium text-white" style={{ backgroundColor: tag.color || '#6b7280' }}>
                                {tag.name}
                              </span>
                            ))}
                            {lead.tags.length > 4 && <span className="text-[10px] text-slate-400">+{lead.tags.length - 4}</span>}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <span className="text-xs text-slate-400">{lead.created_at ? format(new Date(lead.created_at), 'dd/MM/yy', { locale: es }) : ''}</span>
                        {!lead.is_archived && !lead.is_blocked && (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleArchiveLeadFromModal(lead.id) }}
                            disabled={archivingLeadId === lead.id}
                            className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-md transition disabled:opacity-50"
                            title="Finalizar este lead (archivar y recalcular etiquetas)"
                          >
                            {archivingLeadId === lead.id ? (
                              <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-amber-600" />
                            ) : (
                              <XCircle className="w-3 h-3" />
                            )}
                            Finalizar
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Export Modal */}
      {showExportModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
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
        onClose={() => setShowBroadcastModal(false)}
        onSubmit={handleCreateBroadcastFromContacts}
        devices={devices.filter(d => d.status === 'connected')}
        submitting={submittingBroadcast}
        title="Envío Masivo desde Contactos"
        subtitle={`Se incluirán ${broadcastableContacts.length} contactos con teléfono`}
        submitLabel={submittingBroadcast ? 'Creando...' : 'Crear y agregar destinatarios'}
        initialName={`Contactos - ${new Date().toLocaleDateString('es-PE', { day: 'numeric', month: 'short' })}`}
        infoPanel={
          <div className="bg-emerald-50 border border-emerald-100 rounded-xl p-3 text-xs text-emerald-800">
            <div className="flex items-center gap-2 mb-1">
              <Radio className="w-3.5 h-3.5 text-emerald-600" />
              <span className="font-medium">Destinatarios desde Contactos</span>
            </div>
            <p className="text-emerald-600">
              Se agregarán automáticamente <strong>{broadcastableContacts.length}</strong> contactos
              {activeFilterCount > 0 || searchTerm || filterDevice
                ? ' (filtrados)' : ''} como destinatarios de esta campaña.
            </p>
            {contacts.length !== broadcastableContacts.length && (
              <p className="text-amber-600 mt-1">
                {contacts.length - broadcastableContacts.length} contacto(s) sin teléfono serán excluidos.
              </p>
            )}
          </div>
        }
      />
    </div>
  )
}
