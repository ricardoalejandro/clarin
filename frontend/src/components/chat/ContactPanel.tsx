'use client'

import { useState, useEffect } from 'react'
import { X, User, Smartphone } from 'lucide-react'
import ImageViewer from '@/components/chat/ImageViewer'
import LeadDetailPanel from '@/components/LeadDetailPanel'

interface Contact {
  id: string
  jid: string
  phone?: string
  name?: string
  custom_name?: string
  last_name?: string
  short_name?: string
  push_name?: string
  avatar_url?: string
  email?: string
  company?: string
  age?: number
  notes?: string
  is_group: boolean
}

interface Lead {
  id: string
  jid: string
  contact_id: string | null
  name: string
  last_name: string | null
  short_name: string | null
  phone: string
  email: string
  company: string | null
  age: number | null
  status: string
  pipeline_id: string | null
  stage_id: string | null
  stage_name: string | null
  stage_color: string | null
  stage_position: number | null
  notes: string
  tags: string[]
  structured_tags: any[] | null
  kommo_id: number | null
  assigned_to: string
  created_at: string
  updated_at: string
}

interface ContactPanelProps {
  chatId: string
  isOpen: boolean
  onClose: () => void
  deviceName?: string
  devicePhone?: string
}

export default function ContactPanel({ chatId, isOpen, onClose, deviceName, devicePhone }: ContactPanelProps) {
  const [contact, setContact] = useState<Contact | null>(null)
  const [lead, setLead] = useState<Lead | null>(null)
  const [loading, setLoading] = useState(true)
  const [showAvatarViewer, setShowAvatarViewer] = useState(false)

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [isOpen, onClose])

  useEffect(() => {
    if (isOpen && chatId) {
      fetchDetails()
    }
  }, [isOpen, chatId])

  const fetchDetails = async () => {
    setLoading(true)
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/chats/${chatId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        setContact(data.contact || null)
        setLead(data.lead || null)
      }
    } catch (err) {
      console.error('Failed to fetch chat details:', err)
    } finally {
      setLoading(false)
    }
  }

  if (!isOpen) return null

  const cleanName = (name?: string | null) => name?.replace(/^[\s.·•\-]+/, '').trim() || ''
  const displayName = cleanName(contact?.custom_name) || cleanName(contact?.name) || cleanName(contact?.push_name) || cleanName(lead?.name) || 'Contacto'
  const avatarUrl = contact?.avatar_url
  const fmtDevicePhone = devicePhone ? (devicePhone.startsWith('+') ? devicePhone : '+' + devicePhone) : ''

  return (
    <div className="border-l border-slate-200 bg-white flex flex-col h-full w-full">
      {/* Header */}
      <div className="px-4 py-3.5 border-b border-slate-200 bg-slate-50 flex items-center justify-between shrink-0">
        <h3 className="text-base font-bold text-slate-900">
          {lead ? 'Detalle del Lead' : 'Contacto'}
        </h3>
        <button onClick={onClose} className="p-1 hover:bg-slate-200 rounded-lg transition">
          <X className="w-5 h-5 text-slate-500" />
        </button>
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-600" />
        </div>
      ) : lead ? (
        /* ─── When there IS a lead, show the unified LeadDetailPanel ─── */
        <div className="flex-1 overflow-hidden flex flex-col min-h-0">
          {/* Compact contact/device header above the lead panel */}
          <div className="px-4 py-3 border-b border-slate-100 shrink-0">
            <div className="flex items-center gap-3">
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt={displayName}
                  className="w-10 h-10 rounded-full object-cover cursor-pointer hover:opacity-80 transition ring-2 ring-slate-200 hover:ring-emerald-400 shadow-sm shrink-0"
                  onClick={() => setShowAvatarViewer(true)}
                />
              ) : (
                <div className="w-10 h-10 bg-emerald-50 rounded-full flex items-center justify-center shadow-sm shrink-0">
                  <User className="w-5 h-5 text-emerald-600" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-slate-900 truncate">{displayName}</p>
                {(deviceName || fmtDevicePhone) && (
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <Smartphone className="w-3 h-3 text-slate-400" />
                    <span className="text-[11px] text-slate-500 truncate">{deviceName}{fmtDevicePhone ? ` · ${fmtDevicePhone}` : ''}</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Unified Lead Panel */}
          <LeadDetailPanel
            lead={lead}
            onLeadChange={(updatedLead) => setLead(updatedLead)}
            onClose={onClose}
            hideHeader={true}
            hideWhatsApp={true}
            hideDelete={false}
            onDelete={() => {
              setLead(null)
              fetchDetails()
            }}
            className="flex-1 min-h-0"
          />
        </div>
      ) : (
        /* ─── When there is NO lead, show basic contact info ─── */
        <div className="flex-1 overflow-y-auto">
          {/* Avatar and name */}
          <div className="p-5 text-center border-b border-slate-200">
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt={displayName}
                className="w-20 h-20 rounded-full mx-auto mb-3 object-cover cursor-pointer hover:opacity-80 transition ring-2 ring-slate-300 hover:ring-emerald-400 shadow-sm"
                onClick={() => setShowAvatarViewer(true)}
              />
            ) : (
              <div className="w-20 h-20 bg-emerald-50 rounded-full mx-auto mb-3 flex items-center justify-center shadow-sm">
                <User className="w-10 h-10 text-emerald-600" />
              </div>
            )}
            <h4 className="text-xl font-semibold text-slate-900">{displayName}</h4>
            {contact?.phone && (
              <p className="text-slate-600 text-sm mt-1 font-medium">
                {contact.phone.startsWith('+') ? contact.phone : '+' + contact.phone}
              </p>
            )}
          </div>

          {/* Device info */}
          {(deviceName || devicePhone) && (
            <div className="px-4 py-3 border-b border-slate-200">
              <div className="flex items-center gap-2 text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
                <Smartphone className="w-3.5 h-3.5 text-slate-500" />
                <span>Dispositivo</span>
              </div>
              <p className="text-sm font-semibold text-slate-900">{deviceName || 'Sin nombre'}</p>
              {fmtDevicePhone && (
                <p className="text-xs text-slate-600">{fmtDevicePhone}</p>
              )}
            </div>
          )}

          {/* Contact info */}
          {contact && (
            <div className="px-4 py-3 border-b border-slate-200 space-y-2">
              <h5 className="text-xs font-bold text-slate-700 uppercase tracking-wider">Información</h5>
              {contact.email && (
                <p className="text-sm text-slate-700">📧 {contact.email}</p>
              )}
              {contact.company && (
                <p className="text-sm text-slate-700">🏢 {contact.company}</p>
              )}
              {contact.age && (
                <p className="text-sm text-slate-700">🎂 {contact.age} años</p>
              )}
            </div>
          )}

          <div className="px-4 py-6 text-center">
            <p className="text-sm text-slate-400 italic">Este contacto no tiene un lead asociado.</p>
          </div>
        </div>
      )}

      {/* Avatar viewer */}
      {avatarUrl && (
        <ImageViewer
          src={avatarUrl}
          alt={displayName}
          isOpen={showAvatarViewer}
          onClose={() => setShowAvatarViewer(false)}
        />
      )}
    </div>
  )
}
