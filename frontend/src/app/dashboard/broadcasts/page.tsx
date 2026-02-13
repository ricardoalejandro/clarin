'use client'

import { useEffect, useState, useCallback } from 'react'
import {
  Radio, Plus, Play, Pause, Trash2, Edit, Users, Send, Clock,
  CheckCircle2, XCircle, AlertTriangle, ChevronDown, Search,
  Settings2, FileText, Image, Video, AudioLines, File, Eye, Copy,
  BarChart3, ZoomIn, ZoomOut, CalendarClock, X, Paperclip
} from 'lucide-react'
import { formatDistanceToNow, format } from 'date-fns'
import { es } from 'date-fns/locale'
import MessageBubble from '@/components/chat/MessageBubble'
import CreateCampaignModal, { CampaignFormResult, CampaignAttachment } from '@/components/CreateCampaignModal'

interface Device {
  id: string
  name: string
  phone: string | null
  status: string
}

interface Campaign {
  id: string
  account_id: string
  device_id: string
  name: string
  message_template: string
  media_url: string | null
  media_type: string | null
  status: string
  scheduled_at: string | null
  started_at: string | null
  completed_at: string | null
  total_recipients: number
  sent_count: number
  failed_count: number
  settings: Record<string, any>
  created_at: string
  updated_at: string
  device_name: string | null
  attachments?: CampaignAttachment[]
}

interface Recipient {
  id: string
  campaign_id: string
  contact_id: string | null
  jid: string
  name: string | null
  phone: string | null
  status: string
  sent_at: string | null
  error_message: string | null
  wait_time_ms: number | null
}

interface Contact {
  id: string
  jid: string
  phone: string | null
  name: string | null
  custom_name: string | null
  push_name: string | null
}

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-700',
  scheduled: 'bg-blue-100 text-blue-700',
  running: 'bg-yellow-100 text-yellow-700',
  paused: 'bg-orange-100 text-orange-700',
  completed: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
}

const STATUS_LABELS: Record<string, string> = {
  draft: 'Borrador',
  scheduled: 'Programada',
  running: 'Enviando',
  paused: 'Pausada',
  completed: 'Completada',
  failed: 'Fallida',
}

const MEDIA_ICONS: Record<string, any> = {
  image: Image,
  video: Video,
  audio: AudioLines,
  document: File,
}

export default function BroadcastsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [devices, setDevices] = useState<Device[]>([])
  const [contacts, setContacts] = useState<Contact[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showDetailModal, setShowDetailModal] = useState(false)
  const [showRecipientsModal, setShowRecipientsModal] = useState(false)
  const [selectedCampaign, setSelectedCampaign] = useState<Campaign | null>(null)
  const [recipients, setRecipients] = useState<Recipient[]>([])
  const [searchContacts, setSearchContacts] = useState('')
  const [selectedContactIds, setSelectedContactIds] = useState<Set<string>>(new Set())
  const [detailTab, setDetailTab] = useState<'recipients' | 'chart'>('recipients')
  const [chartZoom, setChartZoom] = useState(1)
  const [showDuplicateModal, setShowDuplicateModal] = useState(false)
  const [duplicateMessage, setDuplicateMessage] = useState('')
  const [duplicateCampaign, setDuplicateCampaign] = useState<Campaign | null>(null)

  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null

  const fetchCampaigns = useCallback(async () => {
    try {
      const res = await fetch('/api/campaigns', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) setCampaigns(data.campaigns || [])
    } catch (err) {
      console.error('Failed to fetch campaigns:', err)
    } finally {
      setLoading(false)
    }
  }, [token])

  const fetchDevices = useCallback(async () => {
    try {
      const res = await fetch('/api/devices', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) setDevices(data.devices || [])
    } catch (err) {
      console.error('Failed to fetch devices:', err)
    }
  }, [token])

  const fetchContacts = useCallback(async () => {
    try {
      const res = await fetch('/api/contacts?limit=1000&has_phone=true', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) setContacts(data.contacts || [])
    } catch (err) {
      console.error('Failed to fetch contacts:', err)
    }
  }, [token])

  useEffect(() => {
    fetchCampaigns()
    fetchDevices()
    fetchContacts()

    // Auto-refresh running campaigns
    const interval = setInterval(() => {
      fetchCampaigns()
    }, 15000)
    return () => clearInterval(interval)
  }, [fetchCampaigns, fetchDevices, fetchContacts])

  const handleCreateCampaign = async (formResult: CampaignFormResult) => {
    try {
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
      if (data.success) {
        if (formResult.scheduled_at && data.campaign) {
          await fetch(`/api/campaigns/${data.campaign.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ status: 'scheduled', scheduled_at: formResult.scheduled_at }),
          })
        }
        setShowCreateModal(false)
        fetchCampaigns()
        if (data.campaign) {
          setSelectedCampaign(data.campaign)
          setShowRecipientsModal(true)
        }
      } else {
        alert(data.error || 'Error al crear campaña')
      }
    } catch (err) {
      alert('Error al crear campaña')
    }
  }

  const handleAddRecipients = async () => {
    if (!selectedCampaign || selectedContactIds.size === 0) return
    const recipientsList = contacts
      .filter(c => selectedContactIds.has(c.id))
      .map(c => ({
        contact_id: c.id,
        jid: c.jid,
        name: c.custom_name || c.name || c.push_name || null,
        phone: c.phone || c.jid.replace('@s.whatsapp.net', ''),
      }))

    try {
      const res = await fetch(`/api/campaigns/${selectedCampaign.id}/recipients`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ recipients: recipientsList }),
      })
      const data = await res.json()
      if (data.success) {
        setShowRecipientsModal(false)
        setSelectedContactIds(new Set())
        setSearchContacts('')
        fetchCampaigns()
      } else {
        alert(data.error || 'Error al agregar destinatarios')
      }
    } catch (err) {
      alert('Error al agregar destinatarios')
    }
  }

  const handleStartCampaign = async (id: string) => {
    if (!confirm('¿Iniciar el envío masivo? Los mensajes se enviarán según la configuración anti-ban.')) return
    try {
      const res = await fetch(`/api/campaigns/${id}/start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) fetchCampaigns()
      else alert(data.error || 'Error al iniciar campaña')
    } catch (err) {
      alert('Error al iniciar campaña')
    }
  }

  const handlePauseCampaign = async (id: string) => {
    try {
      const res = await fetch(`/api/campaigns/${id}/pause`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) fetchCampaigns()
      else alert(data.error || 'Error al pausar campaña')
    } catch (err) {
      alert('Error al pausar campaña')
    }
  }

  const handleDeleteCampaign = async (id: string) => {
    if (!confirm('¿Eliminar esta campaña? Esta acción no se puede deshacer.')) return
    try {
      const res = await fetch(`/api/campaigns/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) fetchCampaigns()
      else alert(data.error || 'Error al eliminar campaña')
    } catch (err) {
      alert('Error al eliminar campaña')
    }
  }

  const handleViewRecipients = async (campaign: Campaign) => {
    setSelectedCampaign(campaign)
    setDetailTab('recipients')
    try {
      const res = await fetch(`/api/campaigns/${campaign.id}/recipients`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) setRecipients(data.recipients || [])
    } catch (err) {
      console.error('Failed to fetch recipients:', err)
    }
    setShowDetailModal(true)
  }

  const handleDuplicate = async () => {
    if (!duplicateCampaign) return
    try {
      const res = await fetch(`/api/campaigns/${duplicateCampaign.id}/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ message_template: duplicateMessage || null }),
      })
      const data = await res.json()
      if (data.success) {
        setShowDuplicateModal(false)
        setDuplicateMessage('')
        setDuplicateCampaign(null)
        fetchCampaigns()
      } else {
        alert(data.error || 'Error al duplicar')
      }
    } catch (err) {
      alert('Error al duplicar campaña')
    }
  }

  // Auto-refresh detail modal when campaign is running
  useEffect(() => {
    if (!showDetailModal || !selectedCampaign) return
    if (selectedCampaign.status !== 'running') return
    const interval = setInterval(async () => {
      try {
        const [campRes, recRes] = await Promise.all([
          fetch(`/api/campaigns/${selectedCampaign.id}`, { headers: { Authorization: `Bearer ${token}` } }),
          fetch(`/api/campaigns/${selectedCampaign.id}/recipients`, { headers: { Authorization: `Bearer ${token}` } }),
        ])
        const campData = await campRes.json()
        const recData = await recRes.json()
        if (campData.success) setSelectedCampaign(campData.campaign)
        if (recData.success) setRecipients(recData.recipients || [])
      } catch {}
    }, 5000)
    return () => clearInterval(interval)
  }, [showDetailModal, selectedCampaign?.id, selectedCampaign?.status, token])

  const toggleContactSelection = (contactId: string) => {
    const newSet = new Set(selectedContactIds)
    if (newSet.has(contactId)) newSet.delete(contactId)
    else newSet.add(contactId)
    setSelectedContactIds(newSet)
  }

  const filteredContacts = contacts.filter(c => {
    const term = searchContacts.toLowerCase()
    return (c.name || '').toLowerCase().includes(term) ||
      (c.custom_name || '').toLowerCase().includes(term) ||
      (c.phone || '').toLowerCase().includes(term) ||
      c.jid.toLowerCase().includes(term)
  })

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-600" />
      </div>
    )
  }

  return (
    <div className="space-y-6 overflow-y-auto flex-1 min-h-0">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Envíos Masivos</h1>
          <p className="text-gray-600 mt-1">{campaigns.length} campañas</p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="inline-flex items-center gap-2 bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 transition"
        >
          <Plus className="w-5 h-5" />
          Nueva Campaña
        </button>
      </div>

      {/* Anti-ban info banner */}
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5 shrink-0" />
        <div className="text-sm text-amber-800">
          <p className="font-medium">Protección Anti-Ban activada</p>
          <p className="mt-1">Delays aleatorios entre mensajes, envío por lotes con pausas automáticas. Máximo 1000 msgs/día. Todos los parámetros son configurables al crear cada campaña.</p>
        </div>
      </div>

      {/* Campaigns list */}
      {campaigns.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <Radio className="w-12 h-12 text-gray-300 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900">Sin campañas</h3>
          <p className="text-gray-500 mt-1">Crea tu primera campaña de envío masivo</p>
        </div>
      ) : (
        <div className="grid gap-4">
          {campaigns.map(campaign => {
            const progress = campaign.total_recipients > 0
              ? Math.round(((campaign.sent_count + campaign.failed_count) / campaign.total_recipients) * 100)
              : 0
            const MediaIcon = campaign.media_type ? MEDIA_ICONS[campaign.media_type] || FileText : null
            const attachCount = campaign.attachments?.length || 0

            return (
              <div key={campaign.id} className="bg-white rounded-xl border border-gray-200 p-5 hover:shadow-md transition">
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3">
                      <h3 className="font-semibold text-gray-900 truncate">{campaign.name}</h3>
                      <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[campaign.status] || STATUS_COLORS.draft}`}>
                        {STATUS_LABELS[campaign.status] || campaign.status}
                      </span>
                      {MediaIcon && <MediaIcon className="w-4 h-4 text-gray-400" />}
                      {attachCount > 0 && (
                        <span className="flex items-center gap-1 text-xs text-gray-400">
                          <Paperclip className="w-3 h-3" />{attachCount}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-gray-500 mt-1 line-clamp-1">
                      {campaign.message_template}
                    </p>
                    <div className="flex items-center gap-4 mt-2 text-xs text-gray-400">
                      {campaign.device_name && (
                        <span className="flex items-center gap-1">
                          <Send className="w-3 h-3" />
                          {campaign.device_name}
                        </span>
                      )}
                      <span className="flex items-center gap-1">
                        <Users className="w-3 h-3" />
                        {campaign.total_recipients} destinatarios
                      </span>
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {formatDistanceToNow(new Date(campaign.created_at), { locale: es, addSuffix: true })}
                      </span>
                      {campaign.scheduled_at && (
                        <span className="flex items-center gap-1 text-blue-500">
                          <CalendarClock className="w-3 h-3" />
                          Programada: {format(new Date(campaign.scheduled_at), "d MMM HH:mm", { locale: es })}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1 ml-4">
                    {(campaign.status === 'draft' || campaign.status === 'scheduled') && campaign.total_recipients > 0 && (
                      <button
                        onClick={() => handleStartCampaign(campaign.id)}
                        className="p-2 text-green-600 hover:bg-green-50 rounded-lg transition"
                        title="Iniciar envío ahora"
                      >
                        <Play className="w-5 h-5" />
                      </button>
                    )}
                    {campaign.status === 'paused' && (
                      <button
                        onClick={() => handleStartCampaign(campaign.id)}
                        className="p-2 text-green-600 hover:bg-green-50 rounded-lg transition"
                        title="Reanudar envío"
                      >
                        <Play className="w-5 h-5" />
                      </button>
                    )}
                    {campaign.status === 'running' && (
                      <button
                        onClick={() => handlePauseCampaign(campaign.id)}
                        className="p-2 text-orange-600 hover:bg-orange-50 rounded-lg transition"
                        title="Pausar envío"
                      >
                        <Pause className="w-5 h-5" />
                      </button>
                    )}
                    {(campaign.status === 'draft' || campaign.status === 'scheduled') && (
                      <button
                        onClick={() => {
                          setSelectedCampaign(campaign)
                          setShowRecipientsModal(true)
                        }}
                        className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition"
                        title="Agregar destinatarios"
                      >
                        <Users className="w-5 h-5" />
                      </button>
                    )}
                    <button
                      onClick={() => handleViewRecipients(campaign)}
                      className="p-2 text-gray-600 hover:bg-gray-50 rounded-lg transition"
                      title="Ver detalles"
                    >
                      <Eye className="w-5 h-5" />
                    </button>
                    <button
                      onClick={() => {
                        setDuplicateCampaign(campaign)
                        setDuplicateMessage(campaign.message_template)
                        setShowDuplicateModal(true)
                      }}
                      className="p-2 text-purple-600 hover:bg-purple-50 rounded-lg transition"
                      title="Duplicar campaña"
                    >
                      <Copy className="w-5 h-5" />
                    </button>
                    {(campaign.status === 'draft' || campaign.status === 'scheduled' || campaign.status === 'completed' || campaign.status === 'failed') && (
                      <button
                        onClick={() => handleDeleteCampaign(campaign.id)}
                        className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition"
                        title="Eliminar"
                      >
                        <Trash2 className="w-5 h-5" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Progress bar */}
                {campaign.total_recipients > 0 && (
                  <div className="mt-3">
                    <div className="flex justify-between text-xs text-gray-500 mb-1">
                      <span>{campaign.sent_count} enviados · {campaign.failed_count} fallidos</span>
                      <span>{progress}%</span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-2">
                      <div className="flex h-2 rounded-full overflow-hidden">
                        <div
                          className="bg-green-500 transition-all"
                          style={{ width: `${campaign.total_recipients > 0 ? (campaign.sent_count / campaign.total_recipients) * 100 : 0}%` }}
                        />
                        <div
                          className="bg-red-400 transition-all"
                          style={{ width: `${campaign.total_recipients > 0 ? (campaign.failed_count / campaign.total_recipients) * 100 : 0}%` }}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Create Campaign Modal */}
      <CreateCampaignModal
        open={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onSubmit={handleCreateCampaign}
        devices={devices}
      />

      {/* Add Recipients Modal */}
      {showRecipientsModal && selectedCampaign && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl p-6 w-full max-w-lg max-h-[90vh] flex flex-col">
            <h2 className="text-xl font-bold text-gray-900 mb-1">Agregar Destinatarios</h2>
            <p className="text-sm text-gray-500 mb-4">Campaña: {selectedCampaign.name}</p>

            <div className="relative mb-3">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                value={searchContacts}
                onChange={e => setSearchContacts(e.target.value)}
                placeholder="Buscar contacto..."
                className="w-full pl-9 pr-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-900"
              />
            </div>

            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-gray-500">{selectedContactIds.size} seleccionado(s)</span>
              <button
                onClick={() => setSelectedContactIds(new Set(filteredContacts.map(c => c.id)))}
                className="text-xs text-green-600 hover:underline"
              >
                Seleccionar todos
              </button>
            </div>

            <div className="flex-1 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100 min-h-0">
              {filteredContacts.length === 0 ? (
                <div className="p-8 text-center text-gray-400 text-sm">
                  No se encontraron contactos
                </div>
              ) : (
                filteredContacts.map(contact => (
                  <label
                    key={contact.id}
                    className="flex items-center gap-3 p-3 hover:bg-gray-50 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={selectedContactIds.has(contact.id)}
                      onChange={() => toggleContactSelection(contact.id)}
                      className="rounded border-gray-300 text-green-600 focus:ring-green-500"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">
                        {contact.custom_name || contact.name || contact.push_name || 'Sin nombre'}
                      </p>
                      <p className="text-xs text-gray-400 truncate">
                        {contact.phone || contact.jid.replace('@s.whatsapp.net', '')}
                      </p>
                    </div>
                  </label>
                ))
              )}
            </div>

            <div className="flex gap-3 mt-4">
              <button
                onClick={() => { setShowRecipientsModal(false); setSelectedContactIds(new Set()); setSearchContacts('') }}
                className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
              >
                Cancelar
              </button>
              <button
                onClick={handleAddRecipients}
                disabled={selectedContactIds.size === 0}
                className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
              >
                Agregar {selectedContactIds.size} destinatario(s)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Campaign Detail Modal */}
      {showDetailModal && selectedCampaign && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl p-6 w-full max-w-2xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold text-gray-900">{selectedCampaign.name}</h2>
              <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[selectedCampaign.status]}`}>
                {STATUS_LABELS[selectedCampaign.status]}
              </span>
            </div>

            <div className="space-y-3 text-sm">
              <div>
                <span className="text-gray-500">Mensaje:</span>
                <p className="text-gray-900 mt-1 bg-gray-50 p-3 rounded-lg whitespace-pre-wrap">{selectedCampaign.message_template}</p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="bg-green-50 rounded-lg p-3 text-center">
                  <p className="text-2xl font-bold text-green-700">{selectedCampaign.sent_count}</p>
                  <p className="text-xs text-green-600">Enviados</p>
                </div>
                <div className="bg-red-50 rounded-lg p-3 text-center">
                  <p className="text-2xl font-bold text-red-700">{selectedCampaign.failed_count}</p>
                  <p className="text-xs text-red-600">Fallidos</p>
                </div>
                <div className="bg-blue-50 rounded-lg p-3 text-center">
                  <p className="text-2xl font-bold text-blue-700">
                    {selectedCampaign.total_recipients - selectedCampaign.sent_count - selectedCampaign.failed_count}
                  </p>
                  <p className="text-xs text-blue-600">Pendientes</p>
                </div>
              </div>
            </div>

            {/* Tabs */}
            <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit mt-4 mb-3">
              <button
                onClick={() => setDetailTab('recipients')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  detailTab === 'recipients' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                <Users className="w-3.5 h-3.5" /> Destinatarios ({recipients.length})
              </button>
              <button
                onClick={() => setDetailTab('chart')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  detailTab === 'chart' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                <BarChart3 className="w-3.5 h-3.5" /> Tiempos de Espera
              </button>
            </div>

            {detailTab === 'recipients' ? (
              <div className="flex-1 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100 min-h-0 max-h-72">
                {recipients.map((rec, idx) => (
                  <div key={rec.id} className="flex items-center justify-between p-2.5 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-300 w-5 text-right shrink-0">{idx + 1}</span>
                        <div className="min-w-0">
                          <p className="font-medium text-gray-900 truncate">{rec.name || rec.jid.replace('@s.whatsapp.net', '')}</p>
                          <div className="flex items-center gap-2 text-xs text-gray-400">
                            <span>{rec.phone || rec.jid.replace('@s.whatsapp.net', '')}</span>
                            {rec.sent_at && (
                              <span className="text-green-600">
                                {format(new Date(rec.sent_at), 'HH:mm:ss', { locale: es })}
                              </span>
                            )}
                            {rec.wait_time_ms != null && rec.wait_time_ms > 0 && (
                              <span className="text-blue-500">
                                espera: {(rec.wait_time_ms / 1000).toFixed(1)}s
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0 ml-2">
                      {rec.status === 'sent' && <CheckCircle2 className="w-4 h-4 text-green-500" />}
                      {rec.status === 'failed' && (
                        <span title={rec.error_message || ''}>
                          <XCircle className="w-4 h-4 text-red-500" />
                        </span>
                      )}
                      {rec.status === 'pending' && <Clock className="w-4 h-4 text-gray-400" />}
                      <span className={`text-xs px-1.5 py-0.5 rounded ${
                        rec.status === 'sent' ? 'bg-green-100 text-green-700' :
                        rec.status === 'failed' ? 'bg-red-100 text-red-700' :
                        'bg-gray-100 text-gray-600'
                      }`}>
                        {rec.status === 'sent' ? 'Enviado' : rec.status === 'failed' ? 'Fallido' : 'Pendiente'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex-1 min-h-0">
                {(() => {
                  const sentRecipients = recipients.filter(r => r.wait_time_ms != null && r.wait_time_ms > 0)
                  if (sentRecipients.length < 2) {
                    return (
                      <div className="flex items-center justify-center h-48 text-gray-400 text-sm">
                        Se necesitan al menos 2 mensajes enviados para mostrar el gráfico
                      </div>
                    )
                  }
                  const waitTimes = sentRecipients.map(r => r.wait_time_ms! / 1000)
                  const maxWait = Math.max(...waitTimes)
                  const minWait = Math.min(...waitTimes)
                  const avgWait = waitTimes.reduce((a, b) => a + b, 0) / waitTimes.length
                  const configMin = selectedCampaign.settings?.min_delay_seconds || selectedCampaign.settings?.min_delay || 8
                  const configMax = selectedCampaign.settings?.max_delay_seconds || selectedCampaign.settings?.max_delay || 15

                  const pointSpacing = 60 * chartZoom
                  const padL = 50
                  const padR = 25
                  const padT = 20
                  const padB = 35
                  const chartW = Math.max(400, padL + padR + (waitTimes.length - 1) * pointSpacing)
                  const chartH = 240
                  const plotW = chartW - padL - padR
                  const plotH = chartH - padT - padB
                  const yMax = Math.max(maxWait, configMax) * 1.15
                  const yMin = 0

                  const points = waitTimes.map((v, i) => ({
                    x: padL + (waitTimes.length === 1 ? plotW / 2 : (i / (waitTimes.length - 1)) * plotW),
                    y: padT + plotH - ((v - yMin) / (yMax - yMin)) * plotH,
                    value: v,
                    idx: i,
                  }))
                  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')

                  const configMinY = padT + plotH - ((configMin - yMin) / (yMax - yMin)) * plotH
                  const configMaxY = padT + plotH - ((configMax - yMin) / (yMax - yMin)) * plotH
                  const avgY = padT + plotH - ((avgWait - yMin) / (yMax - yMin)) * plotH

                  const yTicks = 5
                  const yTickValues = Array.from({ length: yTicks + 1 }, (_, i) => yMin + (yMax - yMin) * (i / yTicks))

                  return (
                    <div>
                      <div className="flex flex-wrap items-center gap-4 mb-3 text-xs">
                        <span className="flex items-center gap-1">
                          <span className="w-3 h-0.5 bg-green-500 inline-block" /> Tiempo real
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="w-3 h-0.5 bg-blue-400 inline-block border-dashed" style={{borderTop:'1px dashed'}} /> Config mín ({configMin}s)
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="w-3 h-0.5 bg-red-400 inline-block" style={{borderTop:'1px dashed'}} /> Config máx ({configMax}s)
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="w-3 h-0.5 bg-amber-500 inline-block" style={{borderTop:'1px dashed'}} /> Promedio ({avgWait.toFixed(1)}s)
                        </span>
                        <span>Mín: {minWait.toFixed(1)}s · Máx: {maxWait.toFixed(1)}s · Puntos: {waitTimes.length}</span>
                        <div className="ml-auto flex items-center gap-1">
                          <button
                            onClick={() => setChartZoom(z => Math.max(0.5, z - 0.25))}
                            className="p-1 rounded hover:bg-gray-100 text-gray-500" title="Alejar">
                            <ZoomOut className="w-4 h-4" />
                          </button>
                          <span className="text-gray-400 min-w-[3rem] text-center">{Math.round(chartZoom * 100)}%</span>
                          <button
                            onClick={() => setChartZoom(z => Math.min(4, z + 0.25))}
                            className="p-1 rounded hover:bg-gray-100 text-gray-500" title="Acercar">
                            <ZoomIn className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                      <div className="overflow-x-auto rounded-lg border border-gray-100" style={{ maxHeight: '300px' }}>
                        <svg width={chartW} height={chartH} viewBox={`0 0 ${chartW} ${chartH}`} style={{ minWidth: `${chartW}px` }}>
                          {/* Grid lines */}
                          {yTickValues.map((v, i) => {
                            const y = padT + plotH - ((v - yMin) / (yMax - yMin)) * plotH
                            return (
                              <g key={i}>
                                <line x1={padL} y1={y} x2={chartW - padR} y2={y} stroke="#e5e7eb" strokeWidth="0.5" />
                                <text x={padL - 5} y={y + 3} textAnchor="end" className="fill-gray-400" fontSize="10">{v.toFixed(1)}s</text>
                              </g>
                            )
                          })}
                          {/* Config min line */}
                          <line x1={padL} y1={configMinY} x2={chartW - padR} y2={configMinY}
                            stroke="#60a5fa" strokeWidth="1" strokeDasharray="4 3" />
                          {/* Config max line */}
                          <line x1={padL} y1={configMaxY} x2={chartW - padR} y2={configMaxY}
                            stroke="#f87171" strokeWidth="1" strokeDasharray="4 3" />
                          {/* Average line */}
                          <line x1={padL} y1={avgY} x2={chartW - padR} y2={avgY}
                            stroke="#f59e0b" strokeWidth="1" strokeDasharray="3 3" />
                          {/* Data line */}
                          <path d={pathD} fill="none" stroke="#22c55e" strokeWidth="2" strokeLinejoin="round" />
                          {/* Data points with labels */}
                          {points.map((p, i) => (
                            <g key={i}>
                              <circle cx={p.x} cy={p.y} r="4" fill="#22c55e" stroke="white" strokeWidth="1.5" />
                              <text x={p.x} y={p.y - 8} textAnchor="middle" className="fill-green-700" fontSize="9" fontWeight="600">
                                {p.value.toFixed(1)}s
                              </text>
                              <text x={p.x} y={padT + plotH + 14} textAnchor="middle" className="fill-gray-500" fontSize="9">
                                #{p.idx + 1}
                              </text>
                            </g>
                          ))}
                          {/* X axis */}
                          <line x1={padL} y1={padT + plotH} x2={chartW - padR} y2={padT + plotH} stroke="#d1d5db" strokeWidth="1" />
                          <text x={padL + plotW / 2} y={chartH - 3} textAnchor="middle" className="fill-gray-400" fontSize="9">
                            Mensaje # (total: {waitTimes.length} de {recipients.filter(r => r.status === 'sent').length} enviados)
                          </text>
                        </svg>
                      </div>
                    </div>
                  )
                })()}
              </div>
            )}

            {selectedCampaign.status === 'running' && (
              <div className="mt-2 flex items-center gap-2 text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-2">
                <div className="animate-spin rounded-full h-3 w-3 border-b border-amber-600" />
                Actualizando en tiempo real cada 5 segundos...
              </div>
            )}

            <div className="shrink-0 pt-4">
              <button
                onClick={() => { setShowDetailModal(false); setRecipients([]) }}
                className="w-full px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
              >
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Duplicate Campaign Modal */}
      {showDuplicateModal && duplicateCampaign && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl p-6 w-full max-w-lg">
            <h2 className="text-xl font-bold text-gray-900 mb-1">Duplicar Campaña</h2>
            <p className="text-sm text-gray-500 mb-4">
              Se creará una copia de &quot;{duplicateCampaign.name}&quot; con los mismos destinatarios y configuración.
            </p>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Mensaje (puedes editarlo)</label>
              <textarea
                value={duplicateMessage}
                onChange={e => setDuplicateMessage(e.target.value)}
                rows={5}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 text-gray-900"
              />
              <p className="text-xs text-gray-400 mt-1">
                Variables: {'{{nombre}}'}, {'{{nombre_completo}}'}, {'{{nombre_corto}}'}, {'{{celular}}'}
              </p>
            </div>
            <div className="flex gap-3 mt-4">
              <button
                onClick={() => { setShowDuplicateModal(false); setDuplicateMessage(''); setDuplicateCampaign(null) }}
                className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
              >
                Cancelar
              </button>
              <button
                onClick={handleDuplicate}
                className="flex-1 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700"
              >
                <Copy className="w-4 h-4 inline mr-2" />
                Duplicar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
