'use client'

import { useEffect, useState, useCallback } from 'react'
import { User, Building, Bell, Shield, LogOut, Save, Loader2, Volume2, VolumeX, BellRing, BellOff, Eye, EyeOff, Play } from 'lucide-react'
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
          if (data.account) setAccount(data.account)
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
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-600" />
      </div>
    )
  }

  const tabs = [
    { id: 'profile', label: 'Perfil', icon: User },
    { id: 'account', label: 'Cuenta', icon: Building },
    { id: 'notifications', label: 'Notificaciones', icon: Bell },
    { id: 'security', label: 'Seguridad', icon: Shield },
  ]

  return (
    <div className="max-w-4xl mx-auto space-y-6 overflow-y-auto flex-1 min-h-0">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Configuración</h1>
        <p className="text-gray-600 mt-1">Administra tu perfil y preferencias</p>
      </div>

      {/* Message */}
      {message && (
        <div className={`p-4 rounded-lg ${message.type === 'success' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
          {message.text}
        </div>
      )}

      {/* Tabs */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="flex overflow-x-auto border-b border-gray-200">
          {tabs.map((tab) => {
            const Icon = tab.icon
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-3 sm:px-6 sm:py-4 font-medium transition whitespace-nowrap text-sm sm:text-base ${
                  activeTab === tab.id
                    ? 'text-green-600 border-b-2 border-green-600 bg-green-50'
                    : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                }`}
              >
                <Icon className="w-5 h-5" />
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
                <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center">
                  <span className="text-green-700 text-2xl font-bold">
                    {(user?.name || user?.email || 'U').charAt(0).toUpperCase()}
                  </span>
                </div>
                <div>
                  <h2 className="text-xl font-semibold text-gray-900">{user?.name || 'Usuario'}</h2>
                  <p className="text-gray-500">{user?.email}</p>
                  <span className="inline-block mt-1 px-2 py-0.5 bg-green-100 text-green-700 text-sm rounded-full">
                    {user?.role || 'user'}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Nombre</label>
                  <input
                    type="text"
                    value={formData.userName}
                    onChange={(e) => setFormData({ ...formData, userName: e.target.value })}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 text-gray-900 placeholder:text-gray-400"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                  <input
                    type="email"
                    value={formData.userEmail}
                    onChange={(e) => setFormData({ ...formData, userEmail: e.target.value })}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 text-gray-900 placeholder:text-gray-400"
                  />
                </div>
              </div>

              <button
                onClick={handleSaveProfile}
                disabled={saving}
                className="inline-flex items-center gap-2 bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 disabled:opacity-50"
              >
                {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
                Guardar Cambios
              </button>
            </div>
          )}

          {/* Account Tab */}
          {activeTab === 'account' && (
            <div className="space-y-6">
              <div className="bg-gray-50 p-4 rounded-lg">
                <h3 className="font-medium text-gray-900">Información de la Cuenta</h3>
                <div className="mt-2 space-y-1 text-sm text-gray-600">
                  <p>Plan: <span className="font-medium text-gray-900">{account?.plan || 'free'}</span></p>
                  <p>Slug: <span className="font-medium text-gray-900">{account?.slug || 'N/A'}</span></p>
                  <p>Creada: <span className="font-medium text-gray-900">
                    {account?.created_at ? new Date(account.created_at).toLocaleDateString('es') : 'N/A'}
                  </span></p>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Nombre de la Cuenta</label>
                <input
                  type="text"
                  value={formData.accountName}
                  onChange={(e) => setFormData({ ...formData, accountName: e.target.value })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 text-gray-900 placeholder:text-gray-400"
                />
              </div>

              <button
                onClick={handleSaveAccount}
                disabled={saving}
                className="inline-flex items-center gap-2 bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 disabled:opacity-50"
              >
                {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
                Guardar Cambios
              </button>

              <div className="pt-6 border-t border-gray-200">
                <h3 className="font-medium text-red-600 mb-2">Zona de Peligro</h3>
                <p className="text-sm text-gray-600 mb-4">
                  Una vez que elimines tu cuenta, no hay vuelta atrás. Por favor, ten cuidado.
                </p>
                <button className="px-4 py-2 border border-red-300 text-red-600 rounded-lg hover:bg-red-50">
                  Eliminar Cuenta
                </button>
              </div>
            </div>
          )}

          {/* Notifications Tab */}
          {activeTab === 'notifications' && notifSettings && (
            <div className="space-y-6">
              {/* Sound Settings */}
              <div>
                <h3 className="font-medium text-gray-900 mb-1">Sonido de Notificación</h3>
                <p className="text-sm text-gray-500 mb-4">Configura el sonido que se reproduce al recibir un mensaje nuevo en esta cuenta.</p>

                {/* Enable toggle */}
                <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg mb-4">
                  <div className="flex items-center gap-3">
                    {notifSettings.sound_enabled ? (
                      <Volume2 className="w-5 h-5 text-green-600" />
                    ) : (
                      <VolumeX className="w-5 h-5 text-gray-400" />
                    )}
                    <div>
                      <p className="font-medium text-gray-900">Sonido activado</p>
                      <p className="text-sm text-gray-500">Reproduce un sonido al recibir mensaje</p>
                    </div>
                  </div>
                  <button
                    onClick={() => setNotifSettings({ ...notifSettings, sound_enabled: !notifSettings.sound_enabled, sound_type: !notifSettings.sound_enabled && notifSettings.sound_type === 'none' ? 'whatsapp' : notifSettings.sound_type })}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${notifSettings.sound_enabled ? 'bg-green-600' : 'bg-gray-300'}`}
                  >
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${notifSettings.sound_enabled ? 'translate-x-6' : 'translate-x-1'}`} />
                  </button>
                </div>

                {/* Sound type selector */}
                {notifSettings.sound_enabled && (
                  <div className="space-y-3">
                    <label className="block text-sm font-medium text-gray-700">Tipo de sonido</label>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {SOUND_OPTIONS.filter(s => s.value !== 'none').map((opt) => (
                        <button
                          key={opt.value}
                          onClick={() => setNotifSettings({ ...notifSettings, sound_type: opt.value })}
                          className={`flex items-center gap-3 p-3 rounded-lg border transition text-left ${
                            notifSettings.sound_type === opt.value
                              ? 'border-green-500 bg-green-50 ring-1 ring-green-500'
                              : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                          }`}
                        >
                          <div className="flex-1">
                            <p className={`font-medium text-sm ${notifSettings.sound_type === opt.value ? 'text-green-700' : 'text-gray-900'}`}>{opt.label}</p>
                            <p className="text-xs text-gray-500">{opt.description}</p>
                          </div>
                          <button
                            onClick={(e) => { e.stopPropagation(); playNotificationSound(opt.value, notifSettings.sound_volume) }}
                            className="p-1.5 rounded-full hover:bg-white/80 text-gray-500 hover:text-green-600 transition"
                            title="Previsualizar"
                          >
                            <Play className="w-4 h-4" />
                          </button>
                        </button>
                      ))}
                    </div>

                    {/* Volume slider */}
                    <div className="mt-4">
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        Volumen: {Math.round(notifSettings.sound_volume * 100)}%
                      </label>
                      <div className="flex items-center gap-3">
                        <VolumeX className="w-4 h-4 text-gray-400 shrink-0" />
                        <input
                          type="range"
                          min="0"
                          max="100"
                          value={Math.round(notifSettings.sound_volume * 100)}
                          onChange={(e) => setNotifSettings({ ...notifSettings, sound_volume: parseInt(e.target.value) / 100 })}
                          className="flex-1 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-green-600"
                        />
                        <Volume2 className="w-4 h-4 text-gray-400 shrink-0" />
                      </div>
                    </div>

                    {/* Test button */}
                    <button
                      onClick={handlePreviewSound}
                      className="inline-flex items-center gap-2 px-4 py-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg hover:bg-green-100 transition"
                    >
                      <Play className="w-4 h-4" />
                      Probar sonido
                    </button>
                  </div>
                )}
              </div>

              {/* Browser Notifications */}
              <div className="pt-6 border-t border-gray-200">
                <h3 className="font-medium text-gray-900 mb-1">Notificaciones del Navegador</h3>
                <p className="text-sm text-gray-500 mb-4">Muestra una notificación emergente tipo WhatsApp Web cuando recibes un mensaje y la pestaña no está activa.</p>

                {/* Permission status */}
                {notifPermission === 'denied' && (
                  <div className="p-3 bg-red-50 text-red-700 text-sm rounded-lg mb-4">
                    Las notificaciones están bloqueadas por tu navegador. Para activarlas, haz clic en el icono de candado en la barra de direcciones y permite las notificaciones.
                  </div>
                )}

                {notifPermission === 'default' && notifSettings.browser_notifications && (
                  <div className="p-3 bg-yellow-50 text-yellow-700 text-sm rounded-lg mb-4 flex items-center justify-between">
                    <span>Necesitas dar permiso al navegador para mostrar notificaciones.</span>
                    <button
                      onClick={handleRequestPermission}
                      className="ml-3 px-3 py-1 bg-yellow-100 border border-yellow-300 rounded text-sm font-medium hover:bg-yellow-200 transition whitespace-nowrap"
                    >
                      Permitir
                    </button>
                  </div>
                )}

                {/* Enable toggle */}
                <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg mb-4">
                  <div className="flex items-center gap-3">
                    {notifSettings.browser_notifications ? (
                      <BellRing className="w-5 h-5 text-green-600" />
                    ) : (
                      <BellOff className="w-5 h-5 text-gray-400" />
                    )}
                    <div>
                      <p className="font-medium text-gray-900">Notificaciones emergentes</p>
                      <p className="text-sm text-gray-500">Muestra alerta visual cuando la pestaña está en segundo plano</p>
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
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${notifSettings.browser_notifications ? 'bg-green-600' : 'bg-gray-300'}`}
                  >
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${notifSettings.browser_notifications ? 'translate-x-6' : 'translate-x-1'}`} />
                  </button>
                </div>

                {/* Show preview toggle */}
                {notifSettings.browser_notifications && (
                  <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                    <div className="flex items-center gap-3">
                      {notifSettings.show_preview ? (
                        <Eye className="w-5 h-5 text-green-600" />
                      ) : (
                        <EyeOff className="w-5 h-5 text-gray-400" />
                      )}
                      <div>
                        <p className="font-medium text-gray-900">Mostrar vista previa</p>
                        <p className="text-sm text-gray-500">Muestra el contenido del mensaje en la notificación</p>
                      </div>
                    </div>
                    <button
                      onClick={() => setNotifSettings({ ...notifSettings, show_preview: !notifSettings.show_preview })}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${notifSettings.show_preview ? 'bg-green-600' : 'bg-gray-300'}`}
                    >
                      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${notifSettings.show_preview ? 'translate-x-6' : 'translate-x-1'}`} />
                    </button>
                  </div>
                )}
              </div>

              {/* Account context note */}
              <div className="text-sm text-gray-500 bg-blue-50 border border-blue-100 rounded-lg p-3">
                <strong>Nota:</strong> Esta configuración aplica solo a la cuenta <strong>{account?.name || 'actual'}</strong>. Al cambiar de cuenta, se aplicarán las preferencias guardadas para esa cuenta.
              </div>

              {/* Save button */}
              <button
                onClick={handleSaveNotifications}
                className="inline-flex items-center gap-2 bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 transition"
              >
                <Save className="w-5 h-5" />
                Guardar Preferencias
              </button>
            </div>
          )}

          {/* Security Tab */}
          {activeTab === 'security' && (
            <div className="space-y-6">
              <div>
                <h3 className="font-medium text-gray-900 mb-4">Cambiar Contraseña</h3>
                <div className="space-y-4 max-w-md">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Contraseña Actual</label>
                    <input
                      type="password"
                      value={formData.currentPassword}
                      onChange={(e) => setFormData({ ...formData, currentPassword: e.target.value })}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 text-gray-900 placeholder:text-gray-400"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Nueva Contraseña</label>
                    <input
                      type="password"
                      value={formData.newPassword}
                      onChange={(e) => setFormData({ ...formData, newPassword: e.target.value })}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 text-gray-900 placeholder:text-gray-400"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Confirmar Contraseña</label>
                    <input
                      type="password"
                      value={formData.confirmPassword}
                      onChange={(e) => setFormData({ ...formData, confirmPassword: e.target.value })}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 text-gray-900 placeholder:text-gray-400"
                    />
                  </div>
                  <button
                    onClick={handleChangePassword}
                    disabled={saving || !formData.currentPassword || !formData.newPassword}
                    className="inline-flex items-center gap-2 bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 disabled:opacity-50"
                  >
                    {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Shield className="w-5 h-5" />}
                    Cambiar Contraseña
                  </button>
                </div>
              </div>

              <div className="pt-6 border-t border-gray-200">
                <h3 className="font-medium text-gray-900 mb-4">Sesión</h3>
                <button
                  onClick={handleLogout}
                  className="inline-flex items-center gap-2 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
                >
                  <LogOut className="w-5 h-5" />
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
