'use client'

import { useEffect, useState, useCallback } from 'react'
import { User, Building, Bell, Shield, LogOut, Save, Loader2, Volume2, VolumeX, BellRing, BellOff, Eye, EyeOff, Play, Zap, Plus, Pencil, Trash2, X, Link2, RefreshCw, CheckCircle2, XCircle, Power, Activity, Inbox, Paperclip, Image, Video, File } from 'lucide-react'
import {
  getNotificationSettings,
  saveNotificationSettings,
  playNotificationSound,
  requestNotificationPermission,
  SOUND_OPTIONS,
  type NotificationSettings,
} from '@/lib/notificationSounds'
import { useNotifications } from '@/components/NotificationProvider'

interface Account {
  id: string
  name: string
  slug: string
  plan: string
  created_at: string
}

interface UserProfile {
  id: string
  email: string
  name: string
  role: string
  account_id?: string
  is_super_admin?: boolean
}

export default function SettingsPage() {
  const [account, setAccount] = useState<Account | null>(null)
  const [user, setUser] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [activeTab, setActiveTab] = useState('profile')
  const [formData, setFormData] = useState({
    userName: '',
    userEmail: '',
    accountName: '',
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  })
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [notifSettings, setNotifSettings] = useState<NotificationSettings | null>(null)
  const [notifPermission, setNotifPermission] = useState<NotificationPermission>('default')
  const { refreshSettings: refreshProviderSettings } = useNotifications()
  const [quickReplies, setQuickReplies] = useState<{ id: string; shortcut: string; title: string; body: string; media_url: string; media_type: string; media_filename: string }[]>([])
  const [editingQR, setEditingQR] = useState<{ id?: string; shortcut: string; title: string; body: string; media_url: string; media_type: string; media_filename: string } | null>(null)
  const [savingQR, setSavingQR] = useState(false)
  const [uploadingQRMedia, setUploadingQRMedia] = useState(false)
  const [kommoStatus, setKommoStatus] = useState<{
    configured: boolean
    connected: boolean
    subdomain: string
    account?: { id: number; name: string; currency: string; country: string }
    error?: string
  } | null>(null)
  const [kommoSyncing, setKommoSyncing] = useState(false)
  const [kommoSyncProgress, setKommoSyncProgress] = useState('')
  const [kommoSyncResult, setKommoSyncResult] = useState<{
    pipelines: number; stages: number; tags: number; leads: number; contacts: number; duration: string; errors?: string[]
  } | null>(null)
  const [kommoPipelines, setKommoPipelines] = useState<{
    id: number; name: string; is_main: boolean; stages: number; connected: boolean
  }[]>([])
  const [kommoConnected, setKommoConnected] = useState<{
    id: string; kommo_pipeline_id: number; pipeline_name: string; enabled: boolean; last_synced_at: string | null
  }[]>([])
  const [kommoLoadingPipelines, setKommoLoadingPipelines] = useState(false)
  const [kommoConnecting, setKommoConnecting] = useState<number | null>(null)
  const [kommoWorkerStatus, setKommoWorkerStatus] = useState<{
    running: boolean; queue_length: number; last_check: string | null; connected_count: number
  } | null>(null)
  const [incomingStageId, setIncomingStageId] = useState<string>('')
  const [pipelineStages, setPipelineStages] = useState<{ id: string; name: string; color: string; pipeline_name: string }[]>([])
  const [savingStage, setSavingStage] = useState(false)

  const fetchSettings = useCallback(async () => {
    const token = localStorage.getItem('token')
    try {
      // Fetch user info from /api/me (always works)
      const meRes = await fetch('/api/me', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const meData = await meRes.json()
      if (meData.success && meData.user) {
        const u = meData.user
        setUser({
          id: u.id,
          email: u.email,
          name: u.display_name || u.username,
          role: u.role,
          account_id: u.account_id,
          is_super_admin: u.is_super_admin,
        })
        setFormData(prev => ({
          ...prev,
          userName: u.display_name || u.username || '',
          userEmail: u.email || '',
          accountName: u.account_name || '',
        }))
        // Build account info from /api/me response
        setAccount({
          id: u.account_id,
          name: u.account_name || '',
          slug: '',
          plan: '',
          created_at: '',
        })
      }
      // Try to fetch richer settings (may not exist)
      try {
        const res = await fetch('/api/settings', {
          headers: { Authorization: `Bearer ${token}` },
        })
        const data = await res.json()
        if (data.success) {
          if (data.account) {
            setAccount(data.account)
            setIncomingStageId(data.account.default_incoming_stage_id || '')
          }
          if (data.user) {
            setUser(prev => ({ ...prev!, ...data.user, account_id: prev?.account_id }))
            setFormData(prev => ({
              ...prev,
              userName: data.user?.name || prev.userName,
              userEmail: data.user?.email || prev.userEmail,
              accountName: data.account?.name || prev.accountName,
            }))
          }
        }
      } catch { /* optional endpoint */ }
    } catch (err) {
      console.error('Failed to fetch settings:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSettings()
  }, [fetchSettings])

  const fetchQuickReplies = useCallback(async () => {
    const token = localStorage.getItem('token')
    try {
      const res = await fetch('/api/quick-replies', { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      if (data.success) setQuickReplies(data.quick_replies || [])
    } catch {}
  }, [])

  useEffect(() => {
    fetchQuickReplies()
  }, [fetchQuickReplies])

  const fetchPipelineStages = useCallback(async () => {
    const token = localStorage.getItem('token')
    try {
      const res = await fetch('/api/pipelines', { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      if (data.success && data.pipelines) {
        const stages: { id: string; name: string; color: string; pipeline_name: string }[] = []
        for (const p of data.pipelines) {
          if (p.stages) {
            for (const st of p.stages) {
              stages.push({ id: st.id, name: st.name, color: st.color, pipeline_name: p.name })
            }
          }
        }
        setPipelineStages(stages)
      }
    } catch {}
  }, [])

  useEffect(() => {
    if (activeTab === 'account') fetchPipelineStages()
  }, [activeTab, fetchPipelineStages])

  const handleSaveIncomingStage = async (stageId: string) => {
    setSavingStage(true)
    const token = localStorage.getItem('token')
    try {
      const res = await fetch('/api/settings/incoming-stage', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ stage_id: stageId || null }),
      })
      const data = await res.json()
      if (data.success) {
        setIncomingStageId(stageId)
        showMessage('success', 'Etapa de leads entrantes actualizada')
      } else {
        showMessage('error', data.error || 'Error al actualizar')
      }
    } catch {
      showMessage('error', 'Error de conexión')
    } finally {
      setSavingStage(false)
    }
  }

  const fetchKommoStatus = useCallback(async () => {
    const token = localStorage.getItem('token')
    try {
      const res = await fetch('/api/kommo/status', { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      if (data.success) {
        setKommoStatus({
          configured: data.configured,
          connected: data.connected || false,
          subdomain: data.subdomain || '',
          account: data.account,
          error: data.error,
        })
      }
    } catch {}
  }, [])

  const fetchKommoPipelines = useCallback(async () => {
    const token = localStorage.getItem('token')
    setKommoLoadingPipelines(true)
    try {
      const res = await fetch('/api/kommo/pipelines', { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      if (data.success) setKommoPipelines(data.pipelines || [])
    } catch {} finally { setKommoLoadingPipelines(false) }
  }, [])

  const fetchKommoConnected = useCallback(async () => {
    const token = localStorage.getItem('token')
    try {
      const res = await fetch('/api/kommo/connected', { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      if (data.success) setKommoConnected(data.connected || [])
    } catch {}
  }, [])

  const fetchKommoWorkerStatus = useCallback(async () => {
    const token = localStorage.getItem('token')
    try {
      const res = await fetch('/api/kommo/sync/status', { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      if (data.success) setKommoWorkerStatus(data.status)
    } catch {}
  }, [])

  useEffect(() => {
    fetchKommoStatus()
  }, [fetchKommoStatus])

  // Fetch pipelines and worker status when integrations tab is active
  useEffect(() => {
    if (activeTab === 'integrations' && kommoStatus?.connected) {
      fetchKommoPipelines()
      fetchKommoConnected()
      fetchKommoWorkerStatus()
      const interval = setInterval(fetchKommoWorkerStatus, 10000)
      return () => clearInterval(interval)
    }
  }, [activeTab, kommoStatus?.connected, fetchKommoPipelines, fetchKommoConnected, fetchKommoWorkerStatus])

  const handleKommoConnectPipeline = async (kommoId: number) => {
    // Check if another pipeline is already connected
    const currentConnected = kommoConnected.find(c => c.enabled && c.kommo_pipeline_id !== kommoId)
    if (currentConnected) {
      const pipelineName = kommoPipelines.find(p => p.id === currentConnected.kommo_pipeline_id)?.name || 'actual'
      if (!confirm(`El embudo "${pipelineName}" se desconectará. Solo un embudo puede estar activo. ¿Continuar?`)) {
        return
      }
    }
    setKommoConnecting(kommoId)
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/kommo/pipelines/${kommoId}/connect`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        showMessage('success', 'Pipeline conectado. Sincronización inicial en curso...')
        fetchKommoPipelines()
        fetchKommoConnected()
      } else {
        showMessage('error', data.error || 'Error al conectar')
      }
    } catch {
      showMessage('error', 'Error de conexión')
    } finally {
      setKommoConnecting(null)
    }
  }

  const handleKommoDisconnectPipeline = async (kommoId: number) => {
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/kommo/pipelines/${kommoId}/connect`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        showMessage('success', 'Pipeline desconectado')
        fetchKommoPipelines()
        fetchKommoConnected()
      } else {
        showMessage('error', data.error || 'Error al desconectar')
      }
    } catch {
      showMessage('error', 'Error de conexión')
    }
  }

  const pollFullSyncStatus = useCallback(async () => {
    const token = localStorage.getItem('token')
    try {
      const res = await fetch('/api/kommo/sync/full-status', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success && data.status) {
        const st = data.status
        if (st.running) {
          setKommoSyncProgress(st.progress || 'Sincronizando...')
          return true // still running
        } else {
          // Done
          if (st.result) {
            setKommoSyncResult(st.result)
            showMessage('success', `Sincronización completada en ${st.result.duration}`)
          } else if (st.error) {
            showMessage('error', st.error)
          }
          setKommoSyncing(false)
          setKommoSyncProgress('')
          return false // done
        }
      }
    } catch {
      // ignore polling errors
    }
    return false
  }, [])

  const handleKommoSync = async () => {
    setKommoSyncing(true)
    setKommoSyncResult(null)
    setKommoSyncProgress('Iniciando sincronización...')
    const token = localStorage.getItem('token')
    try {
      const res = await fetch('/api/kommo/sync', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        showMessage('success', 'Sincronización iniciada en segundo plano')
        // Start polling every 2 seconds
        const interval = setInterval(async () => {
          const stillRunning = await pollFullSyncStatus()
          if (!stillRunning) {
            clearInterval(interval)
          }
        }, 2000)
      } else {
        showMessage('error', data.error || 'Error al sincronizar')
        setKommoSyncing(false)
        setKommoSyncProgress('')
      }
    } catch {
      showMessage('error', 'Error de conexión al sincronizar')
      setKommoSyncing(false)
      setKommoSyncProgress('')
    }
  }

  // Check if there's already a sync running when tab loads
  useEffect(() => {
    if (activeTab === 'integrations' && kommoStatus?.connected) {
      const checkRunningSync = async () => {
        const token = localStorage.getItem('token')
        try {
          const res = await fetch('/api/kommo/sync/full-status', {
            headers: { Authorization: `Bearer ${token}` },
          })
          const data = await res.json()
          if (data.success && data.status?.running) {
            setKommoSyncing(true)
            setKommoSyncProgress(data.status.progress || 'Sincronizando...')
            const interval = setInterval(async () => {
              const stillRunning = await pollFullSyncStatus()
              if (!stillRunning) clearInterval(interval)
            }, 2000)
          }
        } catch {}
      }
      checkRunningSync()
    }
  }, [activeTab, kommoStatus?.connected, pollFullSyncStatus])

  const handleQRMediaUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !editingQR) return
    setUploadingQRMedia(true)
    const token = localStorage.getItem('token')
    try {
      const formData = new FormData()
      formData.append('file', file)
      const res = await fetch('/api/media/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      })
      const data = await res.json()
      if (data.success && (data.proxy_url || data.public_url)) {
        let mediaType = 'document'
        if (file.type.startsWith('image/')) mediaType = 'image'
        else if (file.type.startsWith('video/')) mediaType = 'video'
        else if (file.type.startsWith('audio/')) mediaType = 'audio'
        setEditingQR({ ...editingQR, media_url: data.proxy_url || data.public_url, media_type: mediaType, media_filename: file.name })
      } else {
        showMessage('error', data.error || 'Error al subir archivo')
      }
    } catch {
      showMessage('error', 'Error al subir archivo')
    } finally {
      setUploadingQRMedia(false)
      e.target.value = ''
    }
  }

  const handleSaveQuickReply = async () => {
    if (!editingQR || !editingQR.shortcut.trim() || (!editingQR.body.trim() && !editingQR.media_url)) return
    setSavingQR(true)
    const token = localStorage.getItem('token')
    try {
      const isEdit = !!editingQR.id
      const res = await fetch(isEdit ? `/api/quick-replies/${editingQR.id}` : '/api/quick-replies', {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          shortcut: editingQR.shortcut.trim(),
          title: editingQR.title.trim(),
          body: editingQR.body.trim(),
          media_url: editingQR.media_url || '',
          media_type: editingQR.media_type || '',
          media_filename: editingQR.media_filename || '',
        }),
      })
      const data = await res.json()
      if (data.success) {
        setEditingQR(null)
        fetchQuickReplies()
        showMessage('success', isEdit ? 'Respuesta rápida actualizada' : 'Respuesta rápida creada')
      } else {
        showMessage('error', data.error || 'Error al guardar')
      }
    } catch {
      showMessage('error', 'Error al guardar respuesta rápida')
    } finally {
      setSavingQR(false)
    }
  }

  const handleDeleteQuickReply = async (id: string) => {
    if (!confirm('¿Eliminar esta respuesta rápida?')) return
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/quick-replies/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        fetchQuickReplies()
        showMessage('success', 'Respuesta rápida eliminada')
      } else {
        showMessage('error', data.error || 'Error al eliminar')
      }
    } catch {
      showMessage('error', 'Error al eliminar respuesta rápida')
    }
  }

  // Load notification settings once we have the account ID
  useEffect(() => {
    if (user?.account_id) {
      setNotifSettings(getNotificationSettings(user.account_id))
    }
    if ('Notification' in window) {
      setNotifPermission(Notification.permission)
    }
  }, [user?.account_id])

  const handleSaveNotifications = () => {
    if (!user?.account_id || !notifSettings) return
    saveNotificationSettings(user.account_id, notifSettings)
    refreshProviderSettings()
    showMessage('success', 'Preferencias de notificación guardadas')
  }

  const handleRequestPermission = async () => {
    const perm = await requestNotificationPermission()
    setNotifPermission(perm)
    if (perm === 'granted') {
      showMessage('success', 'Notificaciones del navegador activadas')
    }
  }

  const handlePreviewSound = () => {
    if (notifSettings) {
      playNotificationSound(notifSettings.sound_type, notifSettings.sound_volume)
    }
  }

  const showMessage = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text })
    setTimeout(() => setMessage(null), 3000)
  }

  const handleSaveProfile = async () => {
    setSaving(true)
    const token = localStorage.getItem('token')
    try {
      const res = await fetch('/api/settings/profile', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: formData.userName,
          email: formData.userEmail,
        }),
      })
      const data = await res.json()
      if (data.success) {
        showMessage('success', 'Perfil actualizado correctamente')
        fetchSettings()
      } else {
        showMessage('error', data.error || 'Error al actualizar perfil')
      }
    } catch (err) {
      showMessage('error', 'Error al actualizar perfil')
    } finally {
      setSaving(false)
    }
  }

  const handleSaveAccount = async () => {
    setSaving(true)
    const token = localStorage.getItem('token')
    try {
      const res = await fetch('/api/settings/account', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: formData.accountName,
        }),
      })
      const data = await res.json()
      if (data.success) {
        showMessage('success', 'Cuenta actualizada correctamente')
        fetchSettings()
      } else {
        showMessage('error', data.error || 'Error al actualizar cuenta')
      }
    } catch (err) {
      showMessage('error', 'Error al actualizar cuenta')
    } finally {
      setSaving(false)
    }
  }

  const handleChangePassword = async () => {
    if (formData.newPassword !== formData.confirmPassword) {
      showMessage('error', 'Las contraseñas no coinciden')
      return
    }
    if (formData.newPassword.length < 8) {
      showMessage('error', 'La contraseña debe tener al menos 8 caracteres')
      return
    }
    setSaving(true)
    const token = localStorage.getItem('token')
    try {
      const res = await fetch('/api/settings/password', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          currentPassword: formData.currentPassword,
          newPassword: formData.newPassword,
        }),
      })
      const data = await res.json()
      if (data.success) {
        showMessage('success', 'Contraseña actualizada correctamente')
        setFormData(prev => ({
          ...prev,
          currentPassword: '',
          newPassword: '',
          confirmPassword: '',
        }))
      } else {
        showMessage('error', data.error || 'Error al cambiar contraseña')
      }
    } catch (err) {
      showMessage('error', 'Error al cambiar contraseña')
    } finally {
      setSaving(false)
    }
  }

  const handleLogout = () => {
    localStorage.removeItem('token')
    window.location.href = '/'
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-6 w-6 border-2 border-emerald-200 border-t-emerald-600" />
      </div>
    )
  }

  const tabs = [
    { id: 'profile', label: 'Perfil', icon: User },
    { id: 'account', label: 'Cuenta', icon: Building },
    ...(user?.is_super_admin ? [{ id: 'integrations', label: 'Integraciones', icon: Link2 }] : []),
    { id: 'quick-replies', label: 'Respuestas Rápidas', icon: Zap },
    { id: 'notifications', label: 'Notificaciones', icon: Bell },
    { id: 'security', label: 'Seguridad', icon: Shield },
  ]

  return (
    <div className="max-w-4xl mx-auto space-y-6 overflow-y-auto flex-1 min-h-0">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Configuración</h1>
        <p className="text-sm text-slate-500 mt-0.5">Administra tu perfil y preferencias</p>
      </div>

      {/* Message */}
      {message && (
        <div className={`px-4 py-3 rounded-xl text-sm ${message.type === 'success' ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' : 'bg-red-50 text-red-700 border border-red-100'}`}>
          {message.text}
        </div>
      )}

      {/* Tabs */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="flex overflow-x-auto border-b border-slate-200">
          {tabs.map((tab) => {
            const Icon = tab.icon
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-3 py-2.5 sm:px-5 sm:py-3 font-medium transition whitespace-nowrap text-xs sm:text-sm ${
                  activeTab === tab.id
                    ? 'text-emerald-600 border-b-2 border-emerald-600 bg-emerald-50/50'
                    : 'text-slate-500 hover:text-slate-900 hover:bg-slate-50'
                }`}
              >
                <Icon className="w-4 h-4" />
                {tab.label}
              </button>
            )
          })}
        </div>

        <div className="p-6">
          {/* Profile Tab */}
          {activeTab === 'profile' && (
            <div className="space-y-6">
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 bg-emerald-50 rounded-full flex items-center justify-center">
                  <span className="text-emerald-700 text-xl font-semibold">
                    {(user?.name || user?.email || 'U').charAt(0).toUpperCase()}
                  </span>
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-slate-900">{user?.name || 'Usuario'}</h2>
                  <p className="text-sm text-slate-500">{user?.email}</p>
                  <span className="inline-block mt-1 px-2 py-0.5 bg-emerald-50 text-emerald-700 text-xs font-medium rounded-full">
                    {user?.role || 'user'}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Nombre</label>
                  <input
                    type="text"
                    value={formData.userName}
                    onChange={(e) => setFormData({ ...formData, userName: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-sm text-slate-900 placeholder:text-slate-400"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Email</label>
                  <input
                    type="email"
                    value={formData.userEmail}
                    onChange={(e) => setFormData({ ...formData, userEmail: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-sm text-slate-900 placeholder:text-slate-400"
                  />
                </div>
              </div>

              <button
                onClick={handleSaveProfile}
                disabled={saving}
                className="inline-flex items-center gap-2 bg-emerald-600 text-white px-4 py-2 rounded-xl hover:bg-emerald-700 disabled:opacity-50 text-sm font-medium shadow-sm"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                Guardar Cambios
              </button>
            </div>
          )}

          {/* Account Tab */}
          {activeTab === 'account' && (
            <div className="space-y-6">
              <div className="bg-slate-50 p-4 rounded-xl">
                <h3 className="text-sm font-medium text-slate-900">Información de la Cuenta</h3>
                <div className="mt-2 space-y-1 text-xs text-slate-500">
                  <p>Plan: <span className="font-medium text-slate-900">{account?.plan || 'free'}</span></p>
                  <p>Slug: <span className="font-medium text-slate-900">{account?.slug || 'N/A'}</span></p>
                  <p>Creada: <span className="font-medium text-slate-900">
                    {account?.created_at ? new Date(account.created_at).toLocaleDateString('es') : 'N/A'}
                  </span></p>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Nombre de la Cuenta</label>
                <input
                  type="text"
                  value={formData.accountName}
                  onChange={(e) => setFormData({ ...formData, accountName: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-sm text-slate-900 placeholder:text-slate-400"
                />
              </div>

              <button
                onClick={handleSaveAccount}
                disabled={saving}
                className="inline-flex items-center gap-2 bg-emerald-600 text-white px-4 py-2 rounded-xl hover:bg-emerald-700 disabled:opacity-50 text-sm font-medium shadow-sm"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                Guardar Cambios
              </button>

              {/* Default Incoming Stage Selector */}
              <div className="pt-6 border-t border-slate-200">
                <div className="flex items-center gap-2 mb-1">
                  <Inbox className="w-4 h-4 text-emerald-600" />
                  <h3 className="text-sm font-medium text-slate-900">Etapa de Leads Entrantes</h3>
                </div>
                <p className="text-xs text-slate-500 mb-3">
                  Los nuevos leads que lleguen por WhatsApp se asignarán automáticamente a esta etapa.
                </p>
                <div className="flex items-center gap-3">
                  <select
                    value={incomingStageId}
                    onChange={(e) => handleSaveIncomingStage(e.target.value)}
                    disabled={savingStage}
                    className="flex-1 max-w-md px-3 py-2 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-sm text-slate-900 bg-white disabled:opacity-50"
                  >
                    <option value="">Automático (Leads Entrantes)</option>
                    {pipelineStages.map((st) => (
                      <option key={st.id} value={st.id}>
                        {st.pipeline_name} → {st.name}
                      </option>
                    ))}
                  </select>
                  {savingStage && <Loader2 className="w-4 h-4 animate-spin text-emerald-600" />}
                </div>
                {incomingStageId && (
                  <p className="text-[10px] text-emerald-600 mt-1.5">
                    ✓ Configurado: {pipelineStages.find(s => s.id === incomingStageId)?.name || 'Etapa seleccionada'}
                  </p>
                )}
              </div>

              <div className="pt-6 border-t border-slate-200">
                <h3 className="text-sm font-medium text-red-600 mb-2">Zona de Peligro</h3>
                <p className="text-xs text-slate-500 mb-4">
                  Una vez que elimines tu cuenta, no hay vuelta atrás. Por favor, ten cuidado.
                </p>
                <button className="px-4 py-2 border border-red-200 text-red-600 rounded-xl hover:bg-red-50 text-sm">
                  Eliminar Cuenta
                </button>
              </div>
            </div>
          )}

          {/* Integrations Tab */}
          {activeTab === 'integrations' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-sm font-medium text-slate-900">Kommo CRM</h3>
                <p className="text-xs text-slate-500 mt-1">
                  Sincronización bidireccional con Kommo: etapas, etiquetas y nuevos leads se sincronizan automáticamente.
                </p>
              </div>

              {/* Connection Status */}
              <div className="bg-slate-50 rounded-xl p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {kommoStatus?.connected ? (
                      <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                    ) : kommoStatus?.configured ? (
                      <XCircle className="w-5 h-5 text-red-500" />
                    ) : (
                      <Link2 className="w-5 h-5 text-slate-400" />
                    )}
                    <div>
                      <p className="text-sm font-medium text-slate-900">
                        {kommoStatus?.connected
                          ? 'Conectado'
                          : kommoStatus?.configured
                          ? 'Error de conexión'
                          : 'No configurado'}
                      </p>
                      {kommoStatus?.subdomain && (
                        <p className="text-xs text-slate-500">{kommoStatus.subdomain}.kommo.com</p>
                      )}
                      {kommoStatus?.error && (
                        <p className="text-xs text-red-500 mt-1">{kommoStatus.error}</p>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={fetchKommoStatus}
                    className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-white rounded-lg transition"
                    title="Verificar conexión"
                  >
                    <RefreshCw className="w-4 h-4" />
                  </button>
                </div>

                {kommoStatus?.account && (
                  <div className="mt-3 pt-3 border-t border-slate-200 grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <span className="text-slate-500">Cuenta:</span>{' '}
                      <span className="font-medium text-slate-900">{kommoStatus.account.name}</span>
                    </div>
                    <div>
                      <span className="text-slate-500">ID:</span>{' '}
                      <span className="font-medium text-slate-900">{kommoStatus.account.id}</span>
                    </div>
                    <div>
                      <span className="text-slate-500">País:</span>{' '}
                      <span className="font-medium text-slate-900">{kommoStatus.account.country}</span>
                    </div>
                    <div>
                      <span className="text-slate-500">Moneda:</span>{' '}
                      <span className="font-medium text-slate-900">{kommoStatus.account.currency}</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Pipeline Selector */}
              {kommoStatus?.connected && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="text-sm font-medium text-slate-900 flex items-center gap-2">
                        <Power className="w-4 h-4" /> Embudos (Pipelines)
                      </h4>
                      <p className="text-xs text-slate-500">
                        Selecciona un embudo para sincronizar en tiempo real. Solo un embudo puede estar activo a la vez.
                      </p>
                    </div>
                    <button
                      onClick={() => { fetchKommoPipelines(); fetchKommoConnected() }}
                      disabled={kommoLoadingPipelines}
                      className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition"
                      title="Refrescar pipelines"
                    >
                      <RefreshCw className={`w-4 h-4 ${kommoLoadingPipelines ? 'animate-spin' : ''}`} />
                    </button>
                  </div>

                  {kommoLoadingPipelines && kommoPipelines.length === 0 ? (
                    <div className="flex items-center justify-center py-8 text-slate-400 text-sm">
                      <Loader2 className="w-5 h-5 animate-spin mr-2" /> Cargando embudos...
                    </div>
                  ) : (
                    <div className="grid gap-3">
                      {kommoPipelines.map((pipeline) => {
                        const connected = kommoConnected.find(c => c.kommo_pipeline_id === pipeline.id && c.enabled)
                        const isConnecting = kommoConnecting === pipeline.id
                        return (
                          <div
                            key={pipeline.id}
                            className={`border rounded-xl p-4 transition ${
                              connected
                                ? 'border-emerald-200 bg-emerald-50/50'
                                : 'border-slate-200 bg-white hover:border-slate-300'
                            }`}
                          >
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-3">
                                <div className={`w-2.5 h-2.5 rounded-full ${connected ? 'bg-emerald-500 animate-pulse' : 'bg-slate-300'}`} />
                                <div>
                                  <p className="text-sm font-medium text-slate-900">
                                    {pipeline.name}
                                    {pipeline.is_main && (
                                      <span className="ml-2 text-[10px] bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded-full">Principal</span>
                                    )}
                                  </p>
                                  <p className="text-[10px] text-slate-500">
                                    {pipeline.stages} etapas · ID: {pipeline.id}
                                    {connected?.last_synced_at && (
                                      <> · Último sync: {new Date(connected.last_synced_at).toLocaleString('es-PE')}</>
                                    )}
                                  </p>
                                </div>
                              </div>
                              <button
                                onClick={() => connected
                                  ? handleKommoDisconnectPipeline(pipeline.id)
                                  : handleKommoConnectPipeline(pipeline.id)
                                }
                                disabled={isConnecting}
                                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition ${
                                  connected
                                    ? 'bg-red-50 text-red-700 hover:bg-red-100'
                                    : 'bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm'
                                } disabled:opacity-50`}
                              >
                                {isConnecting ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : connected ? (
                                  <XCircle className="w-4 h-4" />
                                ) : (
                                  <Power className="w-4 h-4" />
                                )}
                                {isConnecting ? 'Conectando...' : connected ? 'Desconectar' : 'Conectar'}
                              </button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {/* Worker Status */}
                  {kommoWorkerStatus && (
                    <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-sm">
                      <div className="flex items-center gap-2 mb-1">
                        <Activity className={`w-4 h-4 ${kommoWorkerStatus.running ? 'text-emerald-600' : 'text-slate-400'}`} />
                        <span className="text-xs font-medium text-slate-900">Worker de Sincronización</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${kommoWorkerStatus.running ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                          {kommoWorkerStatus.running ? 'Activo' : 'Inactivo'}
                        </span>
                      </div>
                      <div className="text-[10px] text-slate-500 space-y-0.5">
                        <p>{kommoWorkerStatus.connected_count} pipeline(s) conectado(s) · {kommoWorkerStatus.queue_length} tarea(s) en cola</p>
                        {kommoWorkerStatus.last_check && (
                          <p>Última verificación: {new Date(kommoWorkerStatus.last_check).toLocaleString('es-PE')}</p>
                        )}
                      </div>
                    </div>
                  )}

                  <hr className="border-slate-200" />

                  {/* Full Sync (all pipelines) */}
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="text-sm font-medium text-slate-900">Sincronización Completa</h4>
                      <p className="text-xs text-slate-500">
                        Importa los pipelines conectados, etapas, etiquetas, contactos y leads en segundo plano.
                      </p>
                      {kommoSyncing && kommoSyncProgress && (
                        <p className="text-xs text-emerald-600 mt-1 flex items-center gap-2">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          {kommoSyncProgress}
                        </p>
                      )}
                    </div>
                    <button
                      onClick={handleKommoSync}
                      disabled={kommoSyncing}
                      className="inline-flex items-center gap-2 bg-emerald-600 text-white px-4 py-2 rounded-xl hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition text-sm font-medium shadow-sm"
                    >
                      {kommoSyncing ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <RefreshCw className="w-4 h-4" />
                      )}
                      {kommoSyncing ? 'Sincronizando...' : 'Sincronizar Todo'}
                    </button>
                  </div>

                  {/* Sync Result */}
                  {kommoSyncResult && (
                    <div className="bg-emerald-50 border border-emerald-100 rounded-xl p-4">
                      <h4 className="text-sm font-medium text-emerald-800 mb-2">Sincronización completada</h4>
                      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
                        <div className="bg-white rounded-xl p-3 text-center">
                          <p className="text-xl font-bold text-slate-900">{kommoSyncResult.pipelines}</p>
                          <p className="text-slate-500 text-[10px]">Pipelines</p>
                        </div>
                        <div className="bg-white rounded-xl p-3 text-center">
                          <p className="text-xl font-bold text-slate-900">{kommoSyncResult.stages}</p>
                          <p className="text-slate-500 text-[10px]">Etapas</p>
                        </div>
                        <div className="bg-white rounded-xl p-3 text-center">
                          <p className="text-xl font-bold text-slate-900">{kommoSyncResult.tags}</p>
                          <p className="text-slate-500 text-[10px]">Etiquetas</p>
                        </div>
                        <div className="bg-white rounded-xl p-3 text-center">
                          <p className="text-xl font-bold text-slate-900">{kommoSyncResult.contacts}</p>
                          <p className="text-slate-500 text-[10px]">Contactos</p>
                        </div>
                        <div className="bg-white rounded-xl p-3 text-center">
                          <p className="text-xl font-bold text-slate-900">{kommoSyncResult.leads}</p>
                          <p className="text-slate-500 text-[10px]">Leads</p>
                        </div>
                      </div>
                      <p className="text-[10px] text-emerald-700 mt-2">Duración: {kommoSyncResult.duration}</p>
                      {kommoSyncResult.errors && kommoSyncResult.errors.length > 0 && (
                        <div className="mt-2 text-xs text-red-600">
                          {kommoSyncResult.errors.map((e, i) => (
                            <p key={i}>{e}</p>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Read-only notice */}
                  <div className="text-xs text-slate-500 bg-emerald-50 border border-emerald-100 rounded-xl p-3">
                    <strong>Sincronización bidireccional:</strong> Cambios de etapa, etiquetas y nuevos leads en Clarin se reflejan automáticamente en Kommo. Solo un embudo activo a la vez.
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Quick Replies Tab */}
          {activeTab === 'quick-replies' && (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-medium text-slate-900">Respuestas Rápidas</h3>
                  <p className="text-xs text-slate-500 mt-1">
                    Crea respuestas predefinidas. Escribe <code className="px-1 py-0.5 bg-slate-100 rounded text-emerald-700 text-[10px]">/</code> en el chat para buscarlas.
                  </p>
                </div>
                <button
                  onClick={() => setEditingQR({ shortcut: '', title: '', body: '', media_url: '', media_type: '', media_filename: '' })}
                  className="inline-flex items-center gap-1.5 bg-emerald-600 text-white px-3 py-1.5 rounded-xl hover:bg-emerald-700 text-xs font-medium shadow-sm"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Nueva
                </button>
              </div>

              {/* Edit/Create form */}
              {editingQR && (
                <div className="bg-emerald-50/50 border border-emerald-100 rounded-xl p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-medium text-slate-900">
                      {editingQR.id ? 'Editar respuesta rápida' : 'Nueva respuesta rápida'}
                    </h4>
                    <button onClick={() => setEditingQR(null)} className="p-1 text-slate-400 hover:text-slate-600">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">Atajo</label>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-emerald-600 font-mono text-xs">/</span>
                        <input
                          type="text"
                          value={editingQR.shortcut}
                          onChange={e => setEditingQR({ ...editingQR, shortcut: e.target.value.replace(/\s/g, '').toLowerCase() })}
                          placeholder="saludo"
                          className="w-full pl-7 pr-3 py-2 border border-slate-200 rounded-xl text-slate-900 placeholder:text-slate-400 focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-sm"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">Título (opcional)</label>
                      <input
                        type="text"
                        value={editingQR.title}
                        onChange={e => setEditingQR({ ...editingQR, title: e.target.value })}
                        placeholder="Saludo inicial"
                        className="w-full px-3 py-2 border border-slate-200 rounded-xl text-slate-900 placeholder:text-slate-400 focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-sm"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Mensaje</label>
                    <textarea
                      value={editingQR.body}
                      onChange={e => setEditingQR({ ...editingQR, body: e.target.value })}
                      placeholder="¡Hola! Gracias por contactarnos. ¿En qué podemos ayudarte?"
                      rows={3}
                      className="w-full px-3 py-2 border border-slate-200 rounded-xl text-slate-900 placeholder:text-slate-400 focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-sm resize-none"
                    />
                  </div>

                  {/* Media attachment */}
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Archivo adjunto (opcional)</label>
                    {editingQR.media_url ? (
                      <div className="flex items-center gap-3 p-2.5 bg-white border border-slate-200 rounded-xl">
                        <div className="w-8 h-8 bg-emerald-50 rounded-lg flex items-center justify-center shrink-0">
                          {editingQR.media_type === 'image' ? <Image className="w-4 h-4 text-emerald-600" /> :
                           editingQR.media_type === 'video' ? <Video className="w-4 h-4 text-emerald-600" /> :
                           <File className="w-4 h-4 text-emerald-600" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-slate-900 truncate">{editingQR.media_filename || 'Archivo'}</p>
                          <p className="text-[10px] text-slate-400">{editingQR.media_type}</p>
                        </div>
                        <button
                          onClick={() => setEditingQR({ ...editingQR, media_url: '', media_type: '', media_filename: '' })}
                          className="p-1 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition shrink-0"
                          title="Eliminar adjunto"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ) : (
                      <label className="flex items-center gap-2 px-3 py-2 border border-dashed border-slate-300 rounded-xl text-slate-500 hover:bg-white hover:border-emerald-300 hover:text-emerald-600 transition cursor-pointer text-xs">
                        {uploadingQRMedia ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Paperclip className="w-3.5 h-3.5" />
                        )}
                        {uploadingQRMedia ? 'Subiendo...' : 'Adjuntar imagen, video o documento'}
                        <input
                          type="file"
                          accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt"
                          onChange={handleQRMediaUpload}
                          disabled={uploadingQRMedia}
                          className="hidden"
                        />
                      </label>
                    )}
                  </div>

                  {/* Preview */}
                  {(editingQR.body.trim() || editingQR.media_url) && (
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">Vista previa</label>
                      <div className="bg-[#e5ddd5] rounded-xl p-3 flex justify-end">
                        <div className="max-w-[280px]">
                          {editingQR.media_url && editingQR.media_type === 'image' && (
                            <div className="bg-white rounded-lg overflow-hidden shadow-sm mb-0.5">
                              <img src={editingQR.media_url} alt="" className="w-full max-h-[200px] object-cover" />
                              {editingQR.body.trim() && (
                                <div className="px-2 py-1.5">
                                  <p className="text-xs text-slate-800 whitespace-pre-wrap">{editingQR.body}</p>
                                </div>
                              )}
                            </div>
                          )}
                          {editingQR.media_url && editingQR.media_type === 'video' && (
                            <div className="bg-white rounded-lg overflow-hidden shadow-sm mb-0.5">
                              <video src={editingQR.media_url} className="w-full max-h-[200px] object-cover" />
                              {editingQR.body.trim() && (
                                <div className="px-2 py-1.5">
                                  <p className="text-xs text-slate-800 whitespace-pre-wrap">{editingQR.body}</p>
                                </div>
                              )}
                            </div>
                          )}
                          {editingQR.media_url && editingQR.media_type !== 'image' && editingQR.media_type !== 'video' && (
                            <div className="bg-white rounded-lg p-2 shadow-sm mb-0.5">
                              <div className="flex items-center gap-2 bg-emerald-50 rounded-lg p-2">
                                <File className="w-5 h-5 text-emerald-600 shrink-0" />
                                <div className="min-w-0">
                                  <p className="text-xs font-medium text-slate-900 truncate">{editingQR.media_filename}</p>
                                  <p className="text-[10px] text-slate-400">{editingQR.media_type}</p>
                                </div>
                              </div>
                              {editingQR.body.trim() && (
                                <p className="text-xs text-slate-800 whitespace-pre-wrap mt-1.5 px-0.5">{editingQR.body}</p>
                              )}
                            </div>
                          )}
                          {!editingQR.media_url && editingQR.body.trim() && (
                            <div className="bg-[#dcf8c6] rounded-lg px-2.5 py-1.5 shadow-sm">
                              <p className="text-xs text-slate-800 whitespace-pre-wrap">{editingQR.body}</p>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => setEditingQR(null)}
                      className="px-3 py-1.5 text-slate-600 hover:bg-slate-100 rounded-xl text-xs"
                    >
                      Cancelar
                    </button>
                    <button
                      onClick={handleSaveQuickReply}
                      disabled={savingQR || !editingQR.shortcut.trim() || (!editingQR.body.trim() && !editingQR.media_url)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 disabled:opacity-50 text-xs font-medium shadow-sm"
                    >
                      {savingQR ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                      Guardar
                    </button>
                  </div>
                </div>
              )}

              {/* List */}
              {quickReplies.length === 0 ? (
                <div className="text-center py-8 text-slate-500">
                  <Zap className="w-8 h-8 mx-auto mb-2 text-slate-300" />
                  <p className="text-sm">No hay respuestas rápidas aún</p>
                  <p className="text-xs text-slate-400 mt-1">Crea una para responder más rápido en los chats</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {quickReplies.map(qr => (
                    <div key={qr.id} className="flex items-start gap-3 p-3 bg-slate-50 rounded-xl group">
                      <span className="inline-block px-2 py-0.5 bg-emerald-50 text-emerald-700 text-[10px] font-mono rounded-full mt-0.5 flex-shrink-0">
                        /{qr.shortcut}
                      </span>
                      <div className="flex-1 min-w-0">
                        {qr.title && <p className="text-sm font-medium text-slate-900">{qr.title}</p>}
                        {qr.media_url && (
                          <div className="flex items-center gap-1.5 mb-1">
                            {qr.media_type === 'image' ? <Image className="w-3 h-3 text-emerald-500" /> :
                             qr.media_type === 'video' ? <Video className="w-3 h-3 text-emerald-500" /> :
                             <File className="w-3 h-3 text-emerald-500" />}
                            <span className="text-[10px] text-emerald-600 font-medium">{qr.media_filename || qr.media_type}</span>
                          </div>
                        )}
                        {qr.body && <p className="text-xs text-slate-600 whitespace-pre-wrap">{qr.body}</p>}
                      </div>
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                        <button
                          onClick={() => setEditingQR({ id: qr.id, shortcut: qr.shortcut, title: qr.title, body: qr.body, media_url: qr.media_url || '', media_type: qr.media_type || '', media_filename: qr.media_filename || '' })}
                          className="p-1.5 text-slate-400 hover:text-emerald-600 hover:bg-white rounded-lg"
                          title="Editar"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleDeleteQuickReply(qr.id)}
                          className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-white rounded-lg"
                          title="Eliminar"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Notifications Tab */}
          {activeTab === 'notifications' && notifSettings && (
            <div className="space-y-6">
              {/* Sound Settings */}
              <div>
                <h3 className="text-sm font-medium text-slate-900 mb-1">Sonido de Notificación</h3>
                <p className="text-xs text-slate-500 mb-4">Configura el sonido que se reproduce al recibir un mensaje nuevo en esta cuenta.</p>

                {/* Enable toggle */}
                <div className="flex items-center justify-between p-4 bg-slate-50 rounded-xl mb-4">
                  <div className="flex items-center gap-3">
                    {notifSettings.sound_enabled ? (
                      <Volume2 className="w-4 h-4 text-emerald-600" />
                    ) : (
                      <VolumeX className="w-4 h-4 text-slate-400" />
                    )}
                    <div>
                      <p className="text-sm font-medium text-slate-900">Sonido activado</p>
                      <p className="text-xs text-slate-500">Reproduce un sonido al recibir mensaje</p>
                    </div>
                  </div>
                  <button
                    onClick={() => setNotifSettings({ ...notifSettings, sound_enabled: !notifSettings.sound_enabled, sound_type: !notifSettings.sound_enabled && notifSettings.sound_type === 'none' ? 'whatsapp' : notifSettings.sound_type })}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${notifSettings.sound_enabled ? 'bg-emerald-600' : 'bg-slate-300'}`}
                  >
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${notifSettings.sound_enabled ? 'translate-x-6' : 'translate-x-1'}`} />
                  </button>
                </div>

                {/* Sound type selector */}
                {notifSettings.sound_enabled && (
                  <div className="space-y-3">
                    <label className="block text-xs font-medium text-slate-600">Tipo de sonido</label>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {SOUND_OPTIONS.filter(s => s.value !== 'none').map((opt) => (
                        <button
                          key={opt.value}
                          onClick={() => setNotifSettings({ ...notifSettings, sound_type: opt.value })}
                          className={`flex items-center gap-3 p-3 rounded-xl border transition text-left ${
                            notifSettings.sound_type === opt.value
                              ? 'border-emerald-500 bg-emerald-50/50 ring-1 ring-emerald-500'
                              : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                          }`}
                        >
                          <div className="flex-1">
                            <p className={`text-sm font-medium ${notifSettings.sound_type === opt.value ? 'text-emerald-700' : 'text-slate-900'}`}>{opt.label}</p>
                            <p className="text-[10px] text-slate-500">{opt.description}</p>
                          </div>
                          <button
                            onClick={(e) => { e.stopPropagation(); playNotificationSound(opt.value, notifSettings.sound_volume) }}
                            className="p-1.5 rounded-full hover:bg-white/80 text-slate-500 hover:text-emerald-600 transition"
                            title="Previsualizar"
                          >
                            <Play className="w-3.5 h-3.5" />
                          </button>
                        </button>
                      ))}
                    </div>

                    {/* Volume slider */}
                    <div className="mt-4">
                      <label className="block text-xs font-medium text-slate-600 mb-2">
                        Volumen: {Math.round(notifSettings.sound_volume * 100)}%
                      </label>
                      <div className="flex items-center gap-3">
                        <VolumeX className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                        <input
                          type="range"
                          min="0"
                          max="100"
                          value={Math.round(notifSettings.sound_volume * 100)}
                          onChange={(e) => setNotifSettings({ ...notifSettings, sound_volume: parseInt(e.target.value) / 100 })}
                          className="flex-1 h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-emerald-600"
                        />
                        <Volume2 className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      </div>
                    </div>

                    {/* Test button */}
                    <button
                      onClick={handlePreviewSound}
                      className="inline-flex items-center gap-2 px-3 py-1.5 text-xs text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-xl hover:bg-emerald-100 transition"
                    >
                      <Play className="w-3.5 h-3.5" />
                      Probar sonido
                    </button>
                  </div>
                )}
              </div>

              {/* Browser Notifications */}
              <div className="pt-6 border-t border-slate-200">
                <h3 className="text-sm font-medium text-slate-900 mb-1">Notificaciones del Navegador</h3>
                <p className="text-xs text-slate-500 mb-4">Muestra una notificación emergente tipo WhatsApp Web cuando recibes un mensaje y la pestaña no está activa.</p>

                {/* Permission status */}
                {notifPermission === 'denied' && (
                  <div className="p-3 bg-red-50 text-red-700 text-xs rounded-xl mb-4">
                    Las notificaciones están bloqueadas por tu navegador. Para activarlas, haz clic en el icono de candado en la barra de direcciones y permite las notificaciones.
                  </div>
                )}

                {notifPermission === 'default' && notifSettings.browser_notifications && (
                  <div className="p-3 bg-amber-50 text-amber-700 text-xs rounded-xl mb-4 flex items-center justify-between">
                    <span>Necesitas dar permiso al navegador para mostrar notificaciones.</span>
                    <button
                      onClick={handleRequestPermission}
                      className="ml-3 px-3 py-1 bg-amber-100 border border-amber-200 rounded-xl text-xs font-medium hover:bg-amber-200 transition whitespace-nowrap"
                    >
                      Permitir
                    </button>
                  </div>
                )}

                {/* Enable toggle */}
                <div className="flex items-center justify-between p-4 bg-slate-50 rounded-xl mb-4">
                  <div className="flex items-center gap-3">
                    {notifSettings.browser_notifications ? (
                      <BellRing className="w-4 h-4 text-emerald-600" />
                    ) : (
                      <BellOff className="w-4 h-4 text-slate-400" />
                    )}
                    <div>
                      <p className="text-sm font-medium text-slate-900">Notificaciones emergentes</p>
                      <p className="text-xs text-slate-500">Muestra alerta visual cuando la pestaña está en segundo plano</p>
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      const enabling = !notifSettings.browser_notifications
                      setNotifSettings({ ...notifSettings, browser_notifications: enabling })
                      if (enabling && notifPermission === 'default') {
                        handleRequestPermission()
                      }
                    }}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${notifSettings.browser_notifications ? 'bg-emerald-600' : 'bg-slate-300'}`}
                  >
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${notifSettings.browser_notifications ? 'translate-x-6' : 'translate-x-1'}`} />
                  </button>
                </div>

                {/* Show preview toggle */}
                {notifSettings.browser_notifications && (
                  <div className="flex items-center justify-between p-4 bg-slate-50 rounded-xl">
                    <div className="flex items-center gap-3">
                      {notifSettings.show_preview ? (
                        <Eye className="w-4 h-4 text-emerald-600" />
                      ) : (
                        <EyeOff className="w-4 h-4 text-slate-400" />
                      )}
                      <div>
                        <p className="text-sm font-medium text-slate-900">Mostrar vista previa</p>
                        <p className="text-xs text-slate-500">Muestra el contenido del mensaje en la notificación</p>
                      </div>
                    </div>
                    <button
                      onClick={() => setNotifSettings({ ...notifSettings, show_preview: !notifSettings.show_preview })}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${notifSettings.show_preview ? 'bg-emerald-600' : 'bg-slate-300'}`}
                    >
                      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${notifSettings.show_preview ? 'translate-x-6' : 'translate-x-1'}`} />
                    </button>
                  </div>
                )}
              </div>

              {/* Account context note */}
              <div className="text-xs text-slate-500 bg-blue-50 border border-blue-100 rounded-xl p-3">
                <strong>Nota:</strong> Esta configuración aplica solo a la cuenta <strong>{account?.name || 'actual'}</strong>. Al cambiar de cuenta, se aplicarán las preferencias guardadas para esa cuenta.
              </div>

              {/* Save button */}
              <button
                onClick={handleSaveNotifications}
                className="inline-flex items-center gap-2 bg-emerald-600 text-white px-4 py-2 rounded-xl hover:bg-emerald-700 transition text-sm font-medium shadow-sm"
              >
                <Save className="w-4 h-4" />
                Guardar Preferencias
              </button>
            </div>
          )}

          {/* Security Tab */}
          {activeTab === 'security' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-sm font-medium text-slate-900 mb-4">Cambiar Contraseña</h3>
                <div className="space-y-4 max-w-md">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Contraseña Actual</label>
                    <input
                      type="password"
                      value={formData.currentPassword}
                      onChange={(e) => setFormData({ ...formData, currentPassword: e.target.value })}
                      className="w-full px-3 py-2 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-sm text-slate-900 placeholder:text-slate-400"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Nueva Contraseña</label>
                    <input
                      type="password"
                      value={formData.newPassword}
                      onChange={(e) => setFormData({ ...formData, newPassword: e.target.value })}
                      className="w-full px-3 py-2 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-sm text-slate-900 placeholder:text-slate-400"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Confirmar Contraseña</label>
                    <input
                      type="password"
                      value={formData.confirmPassword}
                      onChange={(e) => setFormData({ ...formData, confirmPassword: e.target.value })}
                      className="w-full px-3 py-2 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-sm text-slate-900 placeholder:text-slate-400"
                    />
                  </div>
                  <button
                    onClick={handleChangePassword}
                    disabled={saving || !formData.currentPassword || !formData.newPassword}
                    className="inline-flex items-center gap-2 bg-emerald-600 text-white px-4 py-2 rounded-xl hover:bg-emerald-700 disabled:opacity-50 text-sm font-medium shadow-sm"
                  >
                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Shield className="w-4 h-4" />}
                    Cambiar Contraseña
                  </button>
                </div>
              </div>

              <div className="pt-6 border-t border-slate-200">
                <h3 className="text-sm font-medium text-slate-900 mb-4">Sesión</h3>
                <button
                  onClick={handleLogout}
                  className="inline-flex items-center gap-2 px-4 py-2 border border-slate-200 text-slate-700 rounded-xl hover:bg-slate-50 text-sm"
                >
                  <LogOut className="w-4 h-4" />
                  Cerrar Sesión
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
