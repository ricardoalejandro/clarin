'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import {
  Search, Phone, Mail, Building2, Tag, Edit, Trash2, RefreshCw,
  ChevronDown, CheckSquare, Square, XCircle, MoreVertical, MoreHorizontal,
  Users, Merge, Eye, X, Smartphone, AlertTriangle, MessageSquare, Send,
  Clock, Plus, FileText, Maximize2, CalendarDays, Upload, Calendar, User, Save, Edit2, Filter, Radio,
  UserPlus, ClipboardPaste, Hash
} from 'lucide-react'
import { formatDistanceToNow, format } from 'date-fns'
import { es } from 'date-fns/locale'
import ImportCSVModal from '@/components/ImportCSVModal'
import TagInput from '@/components/TagInput'
import CreateCampaignModal, { CampaignFormResult } from '@/components/CreateCampaignModal'
import CreateContactModal from '@/components/CreateContactModal'
import PasteFromExcelModal from '@/components/PasteFromExcelModal'
import LeadDetailPanel from '@/components/LeadDetailPanel'
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
  device_names?: ContactDeviceName[]
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
  const [filterTagIds, setFilterTagIds] = useState<Set<string>>(new Set())
  const [showTagFilter, setShowTagFilter] = useState(false)
  const [tagSearchTerm, setTagSearchTerm] = useState('')
  const [allTags, setAllTags] = useState<StructuredTag[]>([])

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

  // Sync
  const [syncing, setSyncing] = useState(false)
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
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Broadcast
  const [showBroadcastModal, setShowBroadcastModal] = useState(false)
  const [submittingBroadcast, setSubmittingBroadcast] = useState(false)

  // Send message
  const [showSendMessage, setShowSendMessage] = useState(false)
  const [sendDeviceId, setSendDeviceId] = useState('')
  const [sendLoading, setSendLoading] = useState(false)
  const router = useRouter()

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
      if (filterTagIds.size > 0) params.set('tag_ids', Array.from(filterTagIds).join(','))
      params.set('limit', String(CONTACTS_PAGE_SIZE))
      params.set('offset', String(offset))
      params.set('has_phone', 'false')

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
  }, [token, searchTerm, filterDevice, filterTagIds])

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
  }, [debouncedSearch, filterDevice, filterTagIds])

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

  const handleSyncAll = async () => {
    const connectedDevices = devices.filter(d => d.status === 'connected')
    if (connectedDevices.length === 0) {
      alert('No hay dispositivos conectados')
      return
    }
    setSyncing(true)
    try {
      for (const device of connectedDevices) {
        await fetch(`/api/devices/${device.id}/sync-contacts`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        })
      }
      // Refresh after a short delay to let sync complete
      setTimeout(() => {
        fetchContacts()
        setSyncing(false)
      }, 3000)
    } catch {
      setSyncing(false)
      alert('Error al sincronizar')
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
    <div className="space-y-6 overflow-y-auto flex-1 min-h-0">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Contactos</h1>
          <p className="text-slate-500 text-sm mt-1">{total.toLocaleString()} contactos en total</p>
        </div>

        {/* ── Toolbar ── */}
        <div className="flex items-center gap-2">
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
              <button
                onClick={() => { setSelectionMode(false); setSelectedIds(new Set()) }}
                className="w-9 h-9 flex items-center justify-center border border-slate-300 rounded-lg hover:bg-slate-50 text-slate-500 hover:text-slate-700 transition-colors"
                title="Cancelar selección"
              >
                <X className="w-4 h-4" />
              </button>
            </>
          ) : (
            /* Normal mode: 3 elements */
            <>
              {/* Primary CTA */}
              <button
                onClick={() => setShowCreateContact(true)}
                className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors text-sm font-semibold shadow-sm shadow-emerald-900/20"
              >
                <UserPlus className="w-4 h-4" />
                Nuevo contacto
              </button>

              {/* Masivo — secondary but frequent */}
              <button
                onClick={() => { fetchDevices(); setShowBroadcastModal(true) }}
                disabled={broadcastableContacts.length === 0}
                className="inline-flex items-center gap-2 px-4 py-2 border border-emerald-300 bg-emerald-50 hover:bg-emerald-100 rounded-lg transition-colors text-emerald-700 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Radio className="w-4 h-4" />
                Masivo
              </button>

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
                  <div className="absolute right-0 top-full mt-1.5 w-52 bg-white border border-slate-200 rounded-xl shadow-xl z-30 py-1 overflow-hidden">
                    <button
                      onClick={() => { handleSyncAll(); setShowMoreMenu(false) }}
                      disabled={syncing}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors disabled:opacity-50"
                    >
                      <RefreshCw className={`w-4 h-4 text-slate-400 ${syncing ? 'animate-spin' : ''}`} />
                      {syncing ? 'Sincronizando...' : 'Sincronizar'}
                    </button>
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
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Buscar por nombre, teléfono, email, empresa..."
            className="w-full pl-10 pr-4 py-2.5 bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 text-slate-900 placeholder:text-slate-400 text-sm"
          />
        </div>
        <div className="relative">
          <Smartphone className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
          <select
            value={filterDevice}
            onChange={(e) => setFilterDevice(e.target.value)}
            className="pl-10 pr-8 py-2.5 bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 appearance-none cursor-pointer text-slate-900 text-sm"
          >
            <option value="">Todos los dispositivos</option>
            {devices.map(d => (
              <option key={d.id} value={d.id}>{d.name} {d.phone ? `(${d.phone})` : ''}</option>
            ))}
          </select>
          <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
        </div>
        {/* Tag Filter */}
        <div className="relative">
          <button
            onClick={() => setShowTagFilter(!showTagFilter)}
            className={`flex items-center gap-2 px-3 py-2.5 bg-white border rounded-lg hover:border-emerald-500 focus:ring-2 focus:ring-emerald-500 min-w-[170px] text-sm ${
              filterTagIds.size > 0 ? 'border-emerald-500' : 'border-slate-300'
            }`}
          >
            <Tag className="w-4 h-4 text-emerald-600" />
            <span className="flex-1 text-left font-medium text-slate-800 truncate">
              {filterTagIds.size === 0 ? 'Todas las etiquetas' : `${filterTagIds.size} etiqueta${filterTagIds.size > 1 ? 's' : ''}`}
            </span>
            <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${showTagFilter ? 'rotate-180' : ''}`} />
          </button>
          {showTagFilter && (
            <div className="absolute top-full left-0 mt-1 w-64 bg-white border border-slate-200 rounded-xl shadow-xl z-30 max-h-[350px] overflow-hidden flex flex-col">
              <div className="p-3 border-b border-slate-100 flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Etiquetas</span>
                {filterTagIds.size > 0 && (
                  <button onClick={() => { setFilterTagIds(new Set()); setShowTagFilter(false) }} className="text-xs text-red-500 hover:text-red-700">
                    Limpiar
                  </button>
                )}
              </div>
              <div className="px-3 py-2 border-b border-slate-100">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                  <input
                    type="text"
                    value={tagSearchTerm}
                    onChange={(e) => setTagSearchTerm(e.target.value)}
                    placeholder="Buscar etiqueta..."
                    className="w-full pl-8 pr-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-800 placeholder:text-slate-400 focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                  />
                </div>
              </div>
              {filterTagIds.size > 0 && (
                <div className="px-3 py-2 border-b border-slate-100 flex flex-wrap gap-1">
                  {Array.from(filterTagIds).map(id => {
                    const tag = allTags.find(t => t.id === id)
                    if (!tag) return null
                    return (
                      <span
                        key={id}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium text-white"
                        style={{ backgroundColor: tag.color || '#6b7280' }}
                      >
                        {tag.name}
                        <button onClick={() => { const next = new Set(filterTagIds); next.delete(id); setFilterTagIds(next) }} className="hover:opacity-75">
                          <X className="w-2.5 h-2.5" />
                        </button>
                      </span>
                    )
                  })}
                </div>
              )}
              <div className="flex-1 overflow-y-auto max-h-[200px]">
                {(() => {
                  const filtered = allTags.filter(t =>
                    !tagSearchTerm.trim() || t.name.toLowerCase().includes(tagSearchTerm.trim().toLowerCase())
                  )
                  if (filtered.length === 0) return <p className="text-xs text-slate-400 text-center py-4">Sin etiquetas</p>
                  return filtered.map(tag => {
                    const isActive = filterTagIds.has(tag.id)
                    return (
                      <label
                        key={tag.id}
                        className="flex items-center gap-2 px-3 py-2 hover:bg-slate-50 cursor-pointer transition"
                      >
                        <input
                          type="checkbox"
                          checked={isActive}
                          onChange={() => {
                            const next = new Set(filterTagIds)
                            if (isActive) next.delete(tag.id); else next.add(tag.id)
                            setFilterTagIds(next)
                            setShowTagFilter(false)
                          }}
                          className="w-3.5 h-3.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                        />
                        <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: tag.color }} />
                        <span className="flex-1 text-xs text-slate-700">{tag.name}</span>
                      </label>
                    )
                  })
                })()}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Contacts Table with Infinite Scroll */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden flex flex-col" style={{ maxHeight: 'calc(100vh - 280px)' }}>
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
            <thead className="bg-slate-50 border-b border-slate-200 sticky top-0 z-10">
              <tr>
                {selectionMode && <th className="w-10 px-4 py-3" />}
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Contacto</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Teléfono</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider hidden md:table-cell">Email</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider hidden lg:table-cell">Empresa</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider hidden lg:table-cell">Etiquetas</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider hidden md:table-cell">Fuente</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider hidden lg:table-cell">Última actividad</th>
                <th className="w-10 px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {contacts.length === 0 && !loading ? (
                <tr>
                  <td colSpan={selectionMode ? 9 : 8} className="text-center py-12 text-slate-500">
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
                        <img
                          src={contact.avatar_url}
                          alt=""
                          className="w-10 h-10 rounded-full object-cover"
                        />
                      ) : (
                        <div className="w-10 h-10 bg-emerald-50 rounded-full flex items-center justify-center flex-shrink-0 overflow-hidden">
                          <span className="text-emerald-700 font-medium text-sm">
                            {getInitials(contact)}
                          </span>
                        </div>
                      )}
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-900 truncate">
                          {getDisplayName(contact)}
                        </p>
                        {contact.custom_name && contact.name && (
                          <p className="text-xs text-slate-400 truncate">
                            WA: {contact.name}
                          </p>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-700">
                    {contact.phone || <span className="text-slate-400">-</span>}
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-700 hidden md:table-cell">
                    {contact.email || <span className="text-slate-400">-</span>}
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-700 hidden lg:table-cell">
                    {contact.company || <span className="text-slate-400">-</span>}
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell">
                    <div className="flex flex-wrap gap-1">
                      {(contact.structured_tags || []).slice(0, 2).map((tag) => (
                        <span
                          key={tag.id}
                          className="px-2 py-0.5 text-xs rounded-full font-medium text-white"
                          style={{ backgroundColor: tag.color || '#6b7280' }}
                        >
                          {tag.name}
                        </span>
                      ))}
                      {(contact.structured_tags || []).length > 2 && (
                        <span className="text-xs text-slate-400">+{(contact.structured_tags || []).length - 2}</span>
                      )}
                      {(!contact.structured_tags || contact.structured_tags.length === 0) && (contact.tags || []).slice(0, 2).map((tag, i) => (
                        <span key={i} className="px-2 py-0.5 bg-slate-100 text-slate-600 text-xs rounded-full">
                          {tag}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-500 hidden md:table-cell">
                    {contact.source || 'whatsapp'}
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-400 hidden lg:table-cell">
                    {contact.last_activity ? (
                      <span title={format(new Date(contact.last_activity), 'dd/MM/yyyy HH:mm', { locale: es })}>
                        {formatDistanceToNow(new Date(contact.last_activity), { addSuffix: true, locale: es })}
                      </span>
                    ) : (
                      <span className="text-slate-300">-</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={(e) => { e.stopPropagation(); openEditModal(contact) }}
                      className="p-1 text-slate-400 hover:text-slate-600 rounded"
                    >
                      <MoreVertical className="w-4 h-4" />
                    </button>
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
              {filterTagIds.size > 0 || searchTerm || filterDevice
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
