'use client'

import { useEffect, useState, useCallback } from 'react'
import { User, Building, Bell, Shield, LogOut, Save, Loader2 } from 'lucide-react'

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

  const fetchSettings = useCallback(async () => {
    const token = localStorage.getItem('token')
    try {
      const res = await fetch('/api/settings', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        setAccount(data.account)
        setUser(data.user)
        setFormData(prev => ({
          ...prev,
          userName: data.user?.name || '',
          userEmail: data.user?.email || '',
          accountName: data.account?.name || '',
        }))
      }
    } catch (err) {
      console.error('Failed to fetch settings:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSettings()
  }, [fetchSettings])

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
