'use client'

import { useEffect, useState } from 'react'
import { MessageSquare, Smartphone, Users, TrendingUp, Signal, Wifi, WifiOff } from 'lucide-react'

interface Stats {
  connected_devices: number
  ws_clients: number
  leads: number
  contacts: number
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
        <div className="animate-spin rounded-full h-6 w-6 border-2 border-emerald-200 border-t-emerald-600" />
      </div>
    )
  }

  const totalUnread = chats.reduce((sum, c) => sum + (c.unread_count || 0), 0)
  const connectedDevices = devices.filter(d => d.status === 'connected').length

  return (
    <div className="space-y-5 overflow-y-auto flex-1 min-h-0">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-slate-900">Dashboard</h1>
        <p className="text-slate-500 text-sm mt-0.5">Resumen general de tu cuenta</p>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-white rounded-xl p-4 border border-slate-200/80 hover:shadow-sm transition-shadow">
          <div className="flex items-center justify-between mb-3">
            <div className="w-9 h-9 bg-emerald-50 rounded-lg flex items-center justify-center">
              <Smartphone className="w-[18px] h-[18px] text-emerald-600" />
            </div>
            <span className="text-[11px] font-medium text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">{connectedDevices} activos</span>
          </div>
          <p className="text-2xl font-bold text-slate-900">{devices.length}</p>
          <p className="text-xs text-slate-500 mt-0.5">Dispositivos</p>
        </div>

        <div className="bg-white rounded-xl p-4 border border-slate-200/80 hover:shadow-sm transition-shadow">
          <div className="flex items-center justify-between mb-3">
            <div className="w-9 h-9 bg-blue-50 rounded-lg flex items-center justify-center">
              <MessageSquare className="w-[18px] h-[18px] text-blue-600" />
            </div>
            {totalUnread > 0 && <span className="text-[11px] font-medium text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">{totalUnread} nuevos</span>}
          </div>
          <p className="text-2xl font-bold text-slate-900">{chats.length}</p>
          <p className="text-xs text-slate-500 mt-0.5">Chats</p>
        </div>

        <div className="bg-white rounded-xl p-4 border border-slate-200/80 hover:shadow-sm transition-shadow">
          <div className="flex items-center justify-between mb-3">
            <div className="w-9 h-9 bg-violet-50 rounded-lg flex items-center justify-center">
              <Users className="w-[18px] h-[18px] text-violet-600" />
            </div>
          </div>
          <p className="text-2xl font-bold text-slate-900">{stats?.leads ?? '--'}</p>
          <p className="text-xs text-slate-500 mt-0.5">Leads</p>
        </div>

        <div className="bg-white rounded-xl p-4 border border-slate-200/80 hover:shadow-sm transition-shadow">
          <div className="flex items-center justify-between mb-3">
            <div className="w-9 h-9 bg-amber-50 rounded-lg flex items-center justify-center">
              <TrendingUp className="w-[18px] h-[18px] text-amber-600" />
            </div>
          </div>
          <p className="text-2xl font-bold text-slate-900">{stats?.contacts ?? '--'}</p>
          <p className="text-xs text-slate-500 mt-0.5">Contactos</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Devices section */}
        <div className="bg-white rounded-xl border border-slate-200/80 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
            <h2 className="font-semibold text-slate-800 text-sm">Dispositivos</h2>
            <a href="/dashboard/devices" className="text-xs text-emerald-600 hover:text-emerald-700 font-medium">
              Ver todos
            </a>
          </div>
          <div className="divide-y divide-slate-50">
            {devices.length === 0 ? (
              <div className="p-8 text-center text-slate-400 text-sm">
                No hay dispositivos conectados
              </div>
            ) : (
              devices.slice(0, 5).map((device) => (
                <div key={device.id} className="px-4 py-3 flex items-center justify-between hover:bg-slate-50/50 transition-colors">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 bg-slate-100 rounded-lg flex items-center justify-center">
                      <Smartphone className="w-4 h-4 text-slate-500" />
                    </div>
                    <div>
                      <p className="font-medium text-slate-800 text-sm">{device.name || 'Dispositivo'}</p>
                      <p className="text-xs text-slate-400">{device.phone || 'Sin número'}</p>
                    </div>
                  </div>
                  <span className={`flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(device.status)}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${device.status === 'connected' ? 'bg-emerald-500' : device.status === 'connecting' ? 'bg-yellow-500 animate-pulse' : 'bg-slate-400'}`} />
                    {device.status === 'connected' ? 'Conectado' : device.status === 'connecting' ? 'Conectando' : 'Desconectado'}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Recent chats */}
        <div className="bg-white rounded-xl border border-slate-200/80 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
            <h2 className="font-semibold text-slate-800 text-sm">Chats Recientes</h2>
            <a href="/dashboard/chats" className="text-xs text-emerald-600 hover:text-emerald-700 font-medium">
              Ver todos
            </a>
          </div>
          <div className="divide-y divide-slate-50">
            {chats.length === 0 ? (
              <div className="p-8 text-center text-slate-400 text-sm">
                No hay chats aún
              </div>
            ) : (
              chats.slice(0, 5).map((chat) => (
                <a 
                  key={chat.id} 
                  href={`/dashboard/chats?id=${chat.id}`}
                  className="px-4 py-3 flex items-center gap-3 hover:bg-slate-50/50 transition-colors cursor-pointer"
                >
                  <div className="w-9 h-9 bg-emerald-50 rounded-full flex items-center justify-center shrink-0">
                    <span className="text-emerald-700 font-semibold text-sm">
                      {getChatDisplayName(chat).charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-slate-800 truncate text-sm">{getChatDisplayName(chat)}</p>
                    <p className="text-xs text-slate-400 truncate">{chat.last_message || 'Sin mensajes'}</p>
                  </div>
                  {(chat.unread_count || 0) > 0 && (
                    <span className="bg-emerald-600 text-white text-[10px] font-bold w-5 h-5 rounded-full flex items-center justify-center shrink-0">
                      {chat.unread_count}
                    </span>
                  )}
                </a>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
