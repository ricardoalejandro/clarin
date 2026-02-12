'use client'

import { useEffect, useState } from 'react'
import { MessageSquare, Smartphone, Users, TrendingUp, Signal, Wifi, WifiOff } from 'lucide-react'

interface Stats {
  connected_devices: number
  ws_clients: number
}

interface Device {
  id: string
  name: string
  phone: string
  status: string
}

interface Chat {
  id: string
  name: string
  last_message: string
  unread_count: number
  contact_custom_name?: string
  contact_name?: string
  contact_phone?: string
  jid?: string
}

// Priority: custom_name (CRM) → contact_name (WhatsApp address book) → chat.name (push_name) → phone
const getChatDisplayName = (chat: Chat): string => {
  if (chat.contact_custom_name?.trim()) return chat.contact_custom_name.trim()
  if (chat.contact_name?.trim()) return chat.contact_name.trim()
  if (chat.name?.trim()) return chat.name.trim()
  if (chat.contact_phone) return '+' + chat.contact_phone
  return chat.name || 'Sin nombre'
}

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [devices, setDevices] = useState<Device[]>([])
  const [chats, setChats] = useState<Chat[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchData = async () => {
      const token = localStorage.getItem('token')
      const headers = { Authorization: `Bearer ${token}` }

      try {
        const [statsRes, devicesRes, chatsRes] = await Promise.all([
          fetch('/api/stats', { headers }),
          fetch('/api/devices', { headers }),
          fetch('/api/chats', { headers }),
        ])

        const [statsData, devicesData, chatsData] = await Promise.all([
          statsRes.json(),
          devicesRes.json(),
          chatsRes.json(),
        ])

        if (statsData.success) setStats(statsData.stats)
        if (devicesData.success) setDevices(devicesData.devices || [])
        if (chatsData.success) setChats(chatsData.chats || [])
      } catch (err) {
        console.error('Failed to fetch data:', err)
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [])

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'connected': return 'bg-green-100 text-green-700'
      case 'connecting': return 'bg-yellow-100 text-yellow-700'
      default: return 'bg-gray-100 text-gray-700'
    }
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'connected': return <Wifi className="w-4 h-4" />
      case 'connecting': return <Signal className="w-4 h-4 animate-pulse" />
      default: return <WifiOff className="w-4 h-4" />
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-600" />
      </div>
    )
  }

  const totalUnread = chats.reduce((sum, c) => sum + (c.unread_count || 0), 0)
  const connectedDevices = devices.filter(d => d.status === 'connected').length

  return (
    <div className="space-y-6 overflow-y-auto flex-1 min-h-0">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-gray-500">Resumen de tu cuenta</p>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl p-6 border border-gray-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">Dispositivos</p>
              <p className="text-2xl font-bold text-gray-900">{connectedDevices}/{devices.length}</p>
            </div>
            <div className="w-12 h-12 bg-green-100 rounded-lg flex items-center justify-center">
              <Smartphone className="w-6 h-6 text-green-600" />
            </div>
          </div>
          <p className="text-sm text-green-600 mt-2">
            {connectedDevices} conectados
          </p>
        </div>

        <div className="bg-white rounded-xl p-6 border border-gray-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">Chats</p>
              <p className="text-2xl font-bold text-gray-900">{chats.length}</p>
            </div>
            <div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center">
              <MessageSquare className="w-6 h-6 text-blue-600" />
            </div>
          </div>
          <p className="text-sm text-blue-600 mt-2">
            {totalUnread} mensajes sin leer
          </p>
        </div>

        <div className="bg-white rounded-xl p-6 border border-gray-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">Leads</p>
              <p className="text-2xl font-bold text-gray-900">--</p>
            </div>
            <div className="w-12 h-12 bg-purple-100 rounded-lg flex items-center justify-center">
              <Users className="w-6 h-6 text-purple-600" />
            </div>
          </div>
          <p className="text-sm text-purple-600 mt-2">
            Ver todos
          </p>
        </div>

        <div className="bg-white rounded-xl p-6 border border-gray-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">Conversiones</p>
              <p className="text-2xl font-bold text-gray-900">--</p>
            </div>
            <div className="w-12 h-12 bg-orange-100 rounded-lg flex items-center justify-center">
              <TrendingUp className="w-6 h-6 text-orange-600" />
            </div>
          </div>
          <p className="text-sm text-orange-600 mt-2">
            Este mes
          </p>
        </div>
      </div>

      {/* Devices section */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="p-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="font-semibold text-gray-900">Dispositivos</h2>
          <a href="/dashboard/devices" className="text-sm text-green-600 hover:text-green-700">
            Ver todos →
          </a>
        </div>
        <div className="divide-y divide-gray-100">
          {devices.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              No hay dispositivos conectados
            </div>
          ) : (
            devices.slice(0, 5).map((device) => (
              <div key={device.id} className="p-4 flex items-center justify-between hover:bg-gray-50">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-gray-100 rounded-lg flex items-center justify-center">
                    <Smartphone className="w-5 h-5 text-gray-600" />
                  </div>
                  <div>
                    <p className="font-medium text-gray-900">{device.name || 'Dispositivo'}</p>
                    <p className="text-sm text-gray-500">{device.phone || 'Sin número'}</p>
                  </div>
                </div>
                <span className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-sm ${getStatusColor(device.status)}`}>
                  {getStatusIcon(device.status)}
                  {device.status === 'connected' ? 'Conectado' : 
                   device.status === 'connecting' ? 'Conectando' : 'Desconectado'}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Recent chats */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="p-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="font-semibold text-gray-900">Chats Recientes</h2>
          <a href="/dashboard/chats" className="text-sm text-green-600 hover:text-green-700">
            Ver todos →
          </a>
        </div>
        <div className="divide-y divide-gray-100">
          {chats.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              No hay chats aún
            </div>
          ) : (
            chats.slice(0, 5).map((chat) => (
              <a 
                key={chat.id} 
                href={`/dashboard/chats?id=${chat.id}`}
                className="p-4 flex items-center gap-3 hover:bg-gray-50 cursor-pointer"
              >
                <div className="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center">
                  <span className="text-green-700 font-medium">
                    {getChatDisplayName(chat).charAt(0).toUpperCase()}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-gray-900 truncate">{getChatDisplayName(chat)}</p>
                  <p className="text-sm text-gray-500 truncate">{chat.last_message || 'Sin mensajes'}</p>
                </div>
                {(chat.unread_count || 0) > 0 && (
                  <span className="bg-green-600 text-white text-xs font-medium px-2 py-1 rounded-full">
                    {chat.unread_count}
                  </span>
                )}
              </a>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
