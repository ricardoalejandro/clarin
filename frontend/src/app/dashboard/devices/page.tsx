'use client'

import { useEffect, useState, useCallback } from 'react'
import { Smartphone, Plus, Wifi, WifiOff, Signal, Trash2, Power, RefreshCw, QrCode, Edit } from 'lucide-react'
import { createWebSocket } from '@/lib/api'

interface Device {
  id: string
  name: string
  phone: string
  jid: string
  status: string
  qr_code: string
  last_seen_at: string
}

export default function DevicesPage() {
  const [devices, setDevices] = useState<Device[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [newDeviceName, setNewDeviceName] = useState('')
  const [creating, setCreating] = useState(false)
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null)
  const [editingDevice, setEditingDevice] = useState<Device | null>(null)
  const [editName, setEditName] = useState('')
  const [saving, setSaving] = useState(false)

  const fetchDevices = useCallback(async () => {
    const token = localStorage.getItem('token')
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
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchDevices()
    // Poll for updates every 5 seconds
    const interval = setInterval(fetchDevices, 5000)
    return () => clearInterval(interval)
  }, [fetchDevices])

  // Setup WebSocket for real-time updates
  useEffect(() => {
    const ws = createWebSocket((data: unknown) => {
      const msg = data as { event?: string; data?: { status?: string; device_id?: string } }
      if (msg.event === 'device_status') {
        if (msg.data?.status === 'connected' && selectedDevice?.id === msg.data?.device_id) {
          setSelectedDevice(null)
        }
        fetchDevices()
      } else if (msg.event === 'qr_code') {
        fetchDevices()
      }
    })
    if (!ws) return
    return () => ws.close()
  }, [fetchDevices, selectedDevice])

  // Close QR modal when device status changes to connected (polling fallback)
  useEffect(() => {
    if (selectedDevice) {
      const updatedDevice = devices.find(d => d.id === selectedDevice.id)
      if (updatedDevice && updatedDevice.status === 'connected') {
        setSelectedDevice(null)
      } else if (updatedDevice && updatedDevice.qr_code !== selectedDevice.qr_code) {
        // Update QR code if it changed
        setSelectedDevice(updatedDevice)
      }
    }
  }, [devices, selectedDevice])

  const handleCreate = async () => {
    if (!newDeviceName.trim()) return
    setCreating(true)
    const token = localStorage.getItem('token')

    try {
      const res = await fetch('/api/devices', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: newDeviceName }),
      })
      const data = await res.json()
      if (data.success) {
        setNewDeviceName('')
        setShowCreate(false)
        fetchDevices()
        // Auto-connect the new device
        await handleConnect(data.device.id)
      }
    } catch (err) {
      console.error('Failed to create device:', err)
    } finally {
      setCreating(false)
    }
  }

  const handleConnect = async (deviceId: string) => {
    const token = localStorage.getItem('token')
    try {
      await fetch(`/api/devices/${deviceId}/connect`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      fetchDevices()
    } catch (err) {
      console.error('Failed to connect device:', err)
    }
  }

  const handleDisconnect = async (deviceId: string) => {
    const token = localStorage.getItem('token')
    try {
      await fetch(`/api/devices/${deviceId}/disconnect`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      fetchDevices()
    } catch (err) {
      console.error('Failed to disconnect device:', err)
    }
  }

  const handleDelete = async (deviceId: string) => {
    if (!confirm('¿Estás seguro de eliminar este dispositivo?')) return
    const token = localStorage.getItem('token')
    try {
      await fetch(`/api/devices/${deviceId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      fetchDevices()
      if (selectedDevice?.id === deviceId) {
        setSelectedDevice(null)
      }
    } catch (err) {
      console.error('Failed to delete device:', err)
    }
  }

  const handleUpdateDevice = async () => {
    if (!editingDevice || !editName.trim()) return
    setSaving(true)
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/devices/${editingDevice.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: editName.trim() }),
      })
      const data = await res.json()
      if (data.success) {
        setEditingDevice(null)
        fetchDevices()
      } else {
        alert(data.error || 'Error al actualizar dispositivo')
      }
    } catch (err) {
      console.error('Failed to update device:', err)
    } finally {
      setSaving(false)
    }
  }

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'connected':
        return (
          <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs bg-emerald-50 text-emerald-700">
            <Wifi className="w-3.5 h-3.5" /> Conectado
          </span>
        )
      case 'connecting':
        return (
          <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs bg-amber-50 text-amber-700">
            <Signal className="w-3.5 h-3.5 animate-pulse" /> Conectando
          </span>
        )
      default:
        return (
          <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs bg-slate-100 text-slate-500">
            <WifiOff className="w-3.5 h-3.5" /> Desconectado
          </span>
        )
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-6 w-6 border-2 border-emerald-200 border-t-emerald-600" />
      </div>
    )
  }

  return (
    <div className="space-y-5 overflow-y-auto flex-1 min-h-0">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Dispositivos</h1>
          <p className="text-sm text-slate-500">Gestiona tus conexiones de WhatsApp</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center justify-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-xl transition-colors text-sm font-medium shadow-sm"
        >
          <Plus className="w-4 h-4" />
          Agregar Dispositivo
        </button>
      </div>

      {/* Create device modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-md mx-4 border border-slate-100">
            <h2 className="text-lg font-semibold text-slate-900 mb-4">Nuevo Dispositivo</h2>
            <input
              type="text"
              value={newDeviceName}
              onChange={(e) => setNewDeviceName(e.target.value)}
              placeholder="Nombre del dispositivo"
              className="w-full px-3 py-2.5 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:border-transparent mb-4 text-sm text-slate-900 placeholder:text-slate-400"
              autoFocus
            />
            <div className="flex gap-3">
              <button
                onClick={() => setShowCreate(false)}
                className="flex-1 px-4 py-2 border border-slate-200 rounded-xl hover:bg-slate-50 text-sm text-slate-600"
              >
                Cancelar
              </button>
              <button
                onClick={handleCreate}
                disabled={creating || !newDeviceName.trim()}
                className="flex-1 px-4 py-2 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 disabled:opacity-50 text-sm font-medium shadow-sm"
              >
                {creating ? 'Creando...' : 'Crear y Conectar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* QR Code modal */}
      {selectedDevice && selectedDevice.status === 'connecting' && selectedDevice.qr_code && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-md mx-4 text-center border border-slate-100">
            <div className="flex items-center justify-center gap-2 mb-3">
              <QrCode className="w-5 h-5 text-emerald-600" />
              <h2 className="text-lg font-semibold text-slate-900">Escanea el código QR</h2>
            </div>
            <p className="text-sm text-slate-500 mb-4">
              Abre WhatsApp en tu teléfono y escanea este código
            </p>
            <div className="bg-white p-4 rounded-xl border border-slate-100 inline-block mb-4">
              <img
                src={selectedDevice.qr_code}
                alt="QR Code"
                className="w-56 h-56"
              />
            </div>
            <div className="flex items-center justify-center gap-2 text-xs text-slate-500 mb-4">
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              Esperando escaneo...
            </div>
            <button
              onClick={() => setSelectedDevice(null)}
              className="px-4 py-2 border border-slate-200 rounded-xl hover:bg-slate-50 text-sm text-slate-600"
            >
              Cerrar
            </button>
          </div>
        </div>
      )}

      {/* Edit device modal */}
      {editingDevice && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-md mx-4 border border-slate-100">
            <h2 className="text-lg font-semibold text-slate-900 mb-4">Editar Dispositivo</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Nombre</label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full px-3 py-2.5 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-sm text-slate-900"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Teléfono</label>
                <input
                  type="text"
                  value={editingDevice.phone || 'Sin número'}
                  disabled
                  className="w-full px-3 py-2.5 border border-slate-100 rounded-xl bg-slate-50 text-sm text-slate-400"
                />
                <p className="text-[10px] text-slate-400 mt-1">El teléfono se asigna automáticamente al conectar WhatsApp</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Estado</label>
                <div className="px-3 py-2">{getStatusBadge(editingDevice.status)}</div>
              </div>
            </div>
            <div className="flex gap-3 mt-5">
              <button
                onClick={() => setEditingDevice(null)}
                className="flex-1 px-4 py-2 border border-slate-200 rounded-xl hover:bg-slate-50 text-sm text-slate-600"
              >
                Cancelar
              </button>
              <button
                onClick={handleUpdateDevice}
                disabled={saving || !editName.trim()}
                className="flex-1 px-4 py-2 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 disabled:opacity-50 text-sm font-medium shadow-sm"
              >
                {saving ? 'Guardando...' : 'Guardar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Devices list */}
      <div className="bg-white rounded-xl border border-slate-200">
        {devices.length === 0 ? (
          <div className="p-12 text-center">
            <div className="w-14 h-14 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-3">
              <Smartphone className="w-7 h-7 text-slate-400" />
            </div>
            <h3 className="text-base font-medium text-slate-900 mb-1">No hay dispositivos</h3>
            <p className="text-sm text-slate-500 mb-4">Agrega tu primer dispositivo WhatsApp para comenzar</p>
            <button
              onClick={() => setShowCreate(true)}
              className="inline-flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-xl transition-colors text-sm font-medium shadow-sm"
            >
              <Plus className="w-4 h-4" />
              Agregar Dispositivo
            </button>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {devices.map((device) => (
              <div key={device.id} className="p-4 flex items-center justify-between hover:bg-slate-50 transition">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-slate-100 rounded-xl flex items-center justify-center">
                    <Smartphone className="w-5 h-5 text-slate-500" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-slate-900">{device.name || 'Dispositivo'}</p>
                    <p className="text-xs text-slate-500">
                      {device.phone || device.jid || 'Sin número asignado'}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {getStatusBadge(device.status)}

                  <button
                    onClick={() => { setEditingDevice(device); setEditName(device.name || '') }}
                    className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                    title="Editar"
                  >
                    <Edit className="w-4 h-4" />
                  </button>

                  {device.status === 'connected' ? (
                    <button
                      onClick={() => handleDisconnect(device.id)}
                      className="p-1.5 text-slate-400 hover:text-orange-600 hover:bg-orange-50 rounded-lg transition-colors"
                      title="Desconectar"
                    >
                      <Power className="w-4 h-4" />
                    </button>
                  ) : device.status === 'connecting' ? (
                    <button
                      onClick={() => setSelectedDevice(device)}
                      className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors"
                      title="Ver QR"
                    >
                      <QrCode className="w-4 h-4" />
                    </button>
                  ) : (
                    <button
                      onClick={() => {
                        handleConnect(device.id)
                        setSelectedDevice(device)
                      }}
                      className="p-1.5 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors"
                      title="Conectar"
                    >
                      <Power className="w-4 h-4" />
                    </button>
                  )}

                  <button
                    onClick={() => handleDelete(device.id)}
                    className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                    title="Eliminar"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
