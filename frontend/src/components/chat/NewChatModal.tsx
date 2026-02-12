'use client'

import { useState, useEffect, useCallback } from 'react'
import { X, MessageCircle, Send, Search, Phone, User } from 'lucide-react'

interface Device {
  id: string
  name: string
  phone?: string
  status: string
}

interface Contact {
  id: string
  jid: string
  phone: string | null
  name: string | null
  custom_name: string | null
  push_name: string | null
  avatar_url: string | null
}

interface NewChatModalProps {
  isOpen: boolean
  onClose: () => void
  devices: Device[]
  onChatCreated: (chatId: string) => void
}

function getContactDisplayName(c: Contact): string {
  return c.custom_name || c.name || c.push_name || c.phone || c.jid
}

export default function NewChatModal({ isOpen, onClose, devices, onChatCreated }: NewChatModalProps) {
  const [selectedDevice, setSelectedDevice] = useState<string>('')
  const [phone, setPhone] = useState('')
  const [initialMessage, setInitialMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Contact search
  const [searchTerm, setSearchTerm] = useState('')
  const [contacts, setContacts] = useState<Contact[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null)
  const [mode, setMode] = useState<'search' | 'manual'>('search')

  const connectedDevices = devices.filter(d => d.status === 'connected')

  useEffect(() => {
    if (isOpen && connectedDevices.length > 0 && !selectedDevice) {
      setSelectedDevice(connectedDevices[0].id)
    }
  }, [isOpen, connectedDevices, selectedDevice])

  useEffect(() => {
    if (!isOpen) {
      setPhone('')
      setInitialMessage('')
      setError('')
      setSearchTerm('')
      setContacts([])
      setSelectedContact(null)
      setMode('search')
    }
  }, [isOpen])

  const searchContacts = useCallback(async (query: string) => {
    if (!query || query.length < 2) {
      setContacts([])
      return
    }
    setSearchLoading(true)
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/contacts?search=${encodeURIComponent(query)}&limit=10&has_phone=false`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        setContacts((data.contacts || []).filter((c: Contact) => c.phone))
      }
    } catch {
      // Ignore search errors
    } finally {
      setSearchLoading(false)
    }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => {
      if (mode === 'search') searchContacts(searchTerm)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchTerm, mode, searchContacts])

  const handleSelectContact = (contact: Contact) => {
    setSelectedContact(contact)
    setPhone(contact.phone || '')
    setSearchTerm(getContactDisplayName(contact))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (!selectedDevice) {
      setError('Selecciona un dispositivo')
      return
    }
    if (!phone.trim()) {
      setError('Ingresa un número de teléfono')
      return
    }

    const cleanPhone = phone.replace(/[^0-9+]/g, '')
    
    setLoading(true)
    setError('')

    const token = localStorage.getItem('token')
    try {
      const res = await fetch('/api/chats/new', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          device_id: selectedDevice,
          phone: cleanPhone,
          initial_message: initialMessage.trim() || undefined,
        }),
      })
      const data = await res.json()
      
      if (data.success) {
        onChatCreated(data.chat.id)
        onClose()
      } else {
        setError(data.error || 'Error al crear conversación')
      }
    } catch (err) {
      setError('Error de conexión')
    } finally {
      setLoading(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <MessageCircle className="w-5 h-5 text-green-600" />
            <h2 className="text-lg font-semibold">Nueva Conversación</h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        {/* Content */}
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {/* Device selector */}
          <div>
            <label className="block text-sm font-bold text-gray-800 mb-1">Dispositivo</label>
            <select
              value={selectedDevice}
              onChange={(e) => setSelectedDevice(e.target.value)}
              className="w-full px-3 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-800 font-medium bg-white"
            >
              <option value="">Seleccionar dispositivo</option>
              {connectedDevices.map(device => (
                <option key={device.id} value={device.id}>
                  {device.name} {device.phone ? `(${device.phone})` : ''}
                </option>
              ))}
            </select>
            {connectedDevices.length === 0 && (
              <p className="mt-1 text-sm font-medium text-red-600">No hay dispositivos conectados</p>
            )}
          </div>

          {/* Mode tabs */}
          <div className="flex border-b border-gray-200">
            <button
              type="button"
              onClick={() => { setMode('search'); setPhone(''); setSelectedContact(null) }}
              className={`flex-1 py-2 text-sm font-medium border-b-2 transition ${
                mode === 'search' ? 'border-green-600 text-green-700' : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              <Search className="w-4 h-4 inline mr-1" />
              Buscar Contacto
            </button>
            <button
              type="button"
              onClick={() => { setMode('manual'); setSearchTerm(''); setContacts([]); setSelectedContact(null) }}
              className={`flex-1 py-2 text-sm font-medium border-b-2 transition ${
                mode === 'manual' ? 'border-green-600 text-green-700' : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              <Phone className="w-4 h-4 inline mr-1" />
              Número Manual
            </button>
          </div>

          {mode === 'search' ? (
            <div>
              <label className="block text-sm font-bold text-gray-800 mb-1">Buscar contacto</label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => {
                    setSearchTerm(e.target.value)
                    setSelectedContact(null)
                  }}
                  placeholder="Nombre, teléfono o email..."
                  className="w-full pl-9 pr-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-800 placeholder:text-gray-400"
                />
              </div>
              {/* Results dropdown */}
              {searchTerm.length >= 2 && !selectedContact && (
                <div className="mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                  {searchLoading ? (
                    <div className="p-3 text-center text-gray-500 text-sm">Buscando...</div>
                  ) : contacts.length === 0 ? (
                    <div className="p-3 text-center text-gray-500 text-sm">
                      No se encontraron contactos
                      <button
                        type="button"
                        onClick={() => setMode('manual')}
                        className="block mx-auto mt-1 text-green-600 hover:underline text-sm"
                      >
                        Ingresar número manualmente
                      </button>
                    </div>
                  ) : contacts.map(contact => (
                    <button
                      key={contact.id}
                      type="button"
                      onClick={() => handleSelectContact(contact)}
                      className="w-full flex items-center gap-3 px-3 py-2 hover:bg-gray-50 text-left"
                    >
                      {contact.avatar_url ? (
                        <img src={contact.avatar_url} alt="" className="w-8 h-8 rounded-full object-cover" />
                      ) : (
                        <div className="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center">
                          <User className="w-4 h-4 text-green-700" />
                        </div>
                      )}
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">
                          {getContactDisplayName(contact)}
                        </p>
                        <p className="text-xs text-gray-500">{contact.phone}</p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {selectedContact && (
                <div className="mt-2 p-2 bg-green-50 rounded-lg flex items-center gap-2">
                  <User className="w-4 h-4 text-green-600" />
                  <span className="text-sm text-green-700 font-medium">{getContactDisplayName(selectedContact)}</span>
                  <span className="text-xs text-green-600">{selectedContact.phone}</span>
                  <button
                    type="button"
                    onClick={() => { setSelectedContact(null); setPhone(''); setSearchTerm('') }}
                    className="ml-auto p-0.5 hover:bg-green-100 rounded"
                  >
                    <X className="w-3.5 h-3.5 text-green-600" />
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div>
              <label className="block text-sm font-bold text-gray-800 mb-1">Número de teléfono</label>
              <input
                type="text"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="51999888777"
                className="w-full px-3 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-800 font-medium placeholder:text-gray-400"
              />
              <p className="mt-1.5 text-xs font-medium text-gray-600">
                Incluye el código de país sin + (ej: 51 para Perú)
              </p>
            </div>
          )}

          {/* Initial message */}
          <div>
            <label className="block text-sm font-bold text-gray-800 mb-1">
              Mensaje inicial (opcional)
            </label>
            <textarea
              value={initialMessage}
              onChange={(e) => setInitialMessage(e.target.value)}
              placeholder="Hola, me contacto contigo para..."
              rows={3}
              className="w-full px-3 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent resize-none text-gray-800 placeholder:text-gray-400"
            />
          </div>

          {/* Error */}
          {error && (
            <div className="p-3 bg-red-50 text-red-700 text-sm rounded-lg">{error}</div>
          )}

          {/* Actions */}
          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2.5 border border-gray-300 text-gray-800 font-semibold rounded-lg hover:bg-gray-100"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={loading || connectedDevices.length === 0 || !phone.trim()}
              className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {loading ? (
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
              ) : (
                <>
                  <Send className="w-4 h-4" />
                  Iniciar Chat
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
