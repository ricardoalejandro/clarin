'use client'

import { useEffect, useState, useCallback } from 'react'
import {
  Radio, Plus, Play, Pause, Trash2, Edit, Users, Send, Clock,
  CheckCircle2, XCircle, AlertTriangle, ChevronDown, Search,
  Settings2, FileText, Image, Video, AudioLines, File, Eye
} from 'lucide-react'
import { formatDistanceToNow, format } from 'date-fns'
import { es } from 'date-fns/locale'

interface Device {
  id: string
  name: string
  phone_number: string
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

  const [formData, setFormData] = useState({
    name: '',
    device_id: '',
    message_template: '',
    media_url: '',
    media_type: '',
    min_delay: 8,
    max_delay: 15,
    batch_size: 25,
    batch_pause: 2,
    daily_limit: 1000,
    active_hours_start: '07:00',
    active_hours_end: '22:00',
    simulate_typing: true,
  })

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

  const handleCreateCampaign = async () => {
    try {
      const res = await fetch('/api/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name: formData.name,
          device_id: formData.device_id,
          message_template: formData.message_template,
          media_url: formData.media_url || null,
          media_type: formData.media_type || null,
          settings: {
            min_delay_seconds: formData.min_delay,
            max_delay_seconds: formData.max_delay,
            batch_size: formData.batch_size,
            batch_pause_minutes: formData.batch_pause,
            daily_limit: formData.daily_limit,
            active_hours_start: formData.active_hours_start,
            active_hours_end: formData.active_hours_end,
            simulate_typing: formData.simulate_typing,
            randomize_message: true,
          },
        }),
      })
      const data = await res.json()
      if (data.success) {
        setShowCreateModal(false)
        resetForm()
        fetchCampaigns()

        // Auto-open recipients modal for the new campaign
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

  const resetForm = () => {
    setFormData({
      name: '', device_id: '', message_template: '', media_url: '', media_type: '',
      min_delay: 8, max_delay: 15, batch_size: 25, batch_pause: 2,
      daily_limit: 1000, active_hours_start: '07:00', active_hours_end: '22:00',
      simulate_typing: true,
    })
  }

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

  const connectedDevices = devices.filter(d => d.status === 'connected')

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
          onClick={() => { resetForm(); setShowCreateModal(true) }}
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
                    </div>
                  </div>

                  <div className="flex items-center gap-1 ml-4">
                    {campaign.status === 'draft' && campaign.total_recipients > 0 && (
                      <button
                        onClick={() => handleStartCampaign(campaign.id)}
                        className="p-2 text-green-600 hover:bg-green-50 rounded-lg transition"
                        title="Iniciar envío"
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
                    {campaign.status === 'draft' && (
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
                    {(campaign.status === 'draft' || campaign.status === 'completed' || campaign.status === 'failed') && (
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
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold text-gray-900 mb-4">Nueva Campaña</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Nombre *</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={e => setFormData({ ...formData, name: e.target.value })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 text-gray-900"
                  placeholder="Ej: Promoción Navidad 2025"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Dispositivo *</label>
                <select
                  value={formData.device_id}
                  onChange={e => setFormData({ ...formData, device_id: e.target.value })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 text-gray-900"
                >
                  <option value="">Seleccionar dispositivo...</option>
                  {connectedDevices.map(d => (
                    <option key={d.id} value={d.id}>{d.name} ({d.phone_number || 'Sin número'})</option>
                  ))}
                </select>
                {connectedDevices.length === 0 && (
                  <p className="text-xs text-red-500 mt-1">No hay dispositivos conectados. Conecta uno primero.</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Mensaje *</label>
                <textarea
                  value={formData.message_template}
                  onChange={e => setFormData({ ...formData, message_template: e.target.value })}
                  rows={4}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 text-gray-900"
                  placeholder="Hola {{nombre}}, te escribimos para..."
                />
                <p className="text-xs text-gray-400 mt-1">
                  Variables: {'{{nombre}}'}, {'{{telefono}}'} se reemplazan automáticamente
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Tipo de Media</label>
                  <select
                    value={formData.media_type}
                    onChange={e => setFormData({ ...formData, media_type: e.target.value })}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 text-gray-900"
                  >
                    <option value="">Solo texto</option>
                    <option value="image">Imagen</option>
                    <option value="video">Video</option>
                    <option value="audio">Audio</option>
                    <option value="document">Documento</option>
                  </select>
                </div>
                {formData.media_type && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">URL del Media</label>
                    <input
                      type="text"
                      value={formData.media_url}
                      onChange={e => setFormData({ ...formData, media_url: e.target.value })}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 text-gray-900"
                      placeholder="https://..."
                    />
                  </div>
                )}
              </div>

              {/* Anti-ban settings */}
              <div className="border border-gray-200 rounded-lg p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Settings2 className="w-4 h-4 text-gray-500" />
                  <h3 className="text-sm font-medium text-gray-700">Configuración Anti-Ban</h3>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Delay mín (seg)</label>
                    <input
                      type="number"
                      value={formData.min_delay}
                      onChange={e => setFormData({ ...formData, min_delay: +e.target.value })}
                      className="w-full px-3 py-1.5 border border-gray-300 rounded text-sm text-gray-900"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Delay máx (seg)</label>
                    <input
                      type="number"
                      value={formData.max_delay}
                      onChange={e => setFormData({ ...formData, max_delay: +e.target.value })}
                      className="w-full px-3 py-1.5 border border-gray-300 rounded text-sm text-gray-900"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Tamaño del lote</label>
                    <input
                      type="number"
                      value={formData.batch_size}
                      onChange={e => setFormData({ ...formData, batch_size: +e.target.value })}
                      className="w-full px-3 py-1.5 border border-gray-300 rounded text-sm text-gray-900"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Pausa entre lotes (min)</label>
                    <input
                      type="number"
                      value={formData.batch_pause}
                      onChange={e => setFormData({ ...formData, batch_pause: +e.target.value })}
                      className="w-full px-3 py-1.5 border border-gray-300 rounded text-sm text-gray-900"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Límite diario</label>
                    <input
                      type="number"
                      value={formData.daily_limit}
                      onChange={e => setFormData({ ...formData, daily_limit: +e.target.value })}
                      className="w-full px-3 py-1.5 border border-gray-300 rounded text-sm text-gray-900"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Horas activas</label>
                    <div className="flex items-center gap-1">
                      <input
                        type="time"
                        value={formData.active_hours_start}
                        onChange={e => setFormData({ ...formData, active_hours_start: e.target.value })}
                        className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs text-gray-900"
                      />
                      <span className="text-xs text-gray-400">-</span>
                      <input
                        type="time"
                        value={formData.active_hours_end}
                        onChange={e => setFormData({ ...formData, active_hours_end: e.target.value })}
                        className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs text-gray-900"
                      />
                    </div>
                  </div>
                </div>
                <label className="flex items-center gap-2 mt-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.simulate_typing}
                    onChange={e => setFormData({ ...formData, simulate_typing: e.target.checked })}
                    className="rounded border-gray-300 text-green-600 focus:ring-green-500"
                  />
                  <span className="text-xs text-gray-600">Simular escritura (typing indicator)</span>
                </label>
              </div>

              {/* Speed estimator */}
              {formData.batch_size > 0 && formData.min_delay > 0 && formData.max_delay > 0 && (() => {
                const avgDelay = (formData.min_delay + formData.max_delay) / 2
                const batchTimeSec = avgDelay * formData.batch_size
                const cycleTimeMin = batchTimeSec / 60 + formData.batch_pause
                const msgsPerHour = cycleTimeMin > 0 ? Math.round(formData.batch_size / cycleTimeMin * 60) : 0
                const hoursFor1000 = msgsPerHour > 0 ? (1000 / msgsPerHour).toFixed(1) : '?'
                return (
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-800">
                    <p className="font-medium mb-1">Velocidad estimada</p>
                    <div className="flex flex-wrap gap-x-4 gap-y-1">
                      <span>~{avgDelay.toFixed(0)}s promedio entre msgs</span>
                      <span>~{cycleTimeMin.toFixed(1)} min por lote de {formData.batch_size}</span>
                      <span className="font-semibold">~{msgsPerHour} msgs/hora</span>
                      <span>1000 msgs en ~{hoursFor1000}h</span>
                    </div>
                  </div>
                )
              })()}
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setShowCreateModal(false)}
                className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
              >
                Cancelar
              </button>
              <button
                onClick={handleCreateCampaign}
                disabled={!formData.name || !formData.device_id || !formData.message_template}
                className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
              >
                Crear Campaña
              </button>
            </div>
          </div>
        </div>
      )}

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
          <div className="bg-white rounded-xl p-6 w-full max-w-lg max-h-[90vh] flex flex-col">
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

            {/* Recipients list */}
            <h3 className="text-sm font-medium text-gray-700 mt-4 mb-2">
              Destinatarios ({recipients.length})
            </h3>
            <div className="flex-1 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100 min-h-0 max-h-60">
              {recipients.map(rec => (
                <div key={rec.id} className="flex items-center justify-between p-2.5 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium text-gray-900 truncate">{rec.name || rec.jid.replace('@s.whatsapp.net', '')}</p>
                    <p className="text-xs text-gray-400">{rec.phone || rec.jid.replace('@s.whatsapp.net', '')}</p>
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

            <button
              onClick={() => { setShowDetailModal(false); setRecipients([]) }}
              className="w-full mt-4 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
            >
              Cerrar
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
