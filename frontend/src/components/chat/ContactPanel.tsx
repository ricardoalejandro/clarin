'use client'

import { useState, useEffect, useRef } from 'react'
import { X, User, Smartphone, Tag, Pencil, Check } from 'lucide-react'
import ImageViewer from '@/components/chat/ImageViewer'
import LeadDetailPanel from '@/components/LeadDetailPanel'
import TagInput from '@/components/TagInput'
import type { Lead, StructuredTag } from '@/types/contact'

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
  structured_tags?: StructuredTag[]
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
  const [editingName, setEditingName] = useState(false)
  const [editNameValue, setEditNameValue] = useState('')
  const [savingName, setSavingName] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)

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

  const startEditingName = () => {
    setEditNameValue(contact?.custom_name || contact?.name || contact?.push_name || '')
    setEditingName(true)
    setTimeout(() => nameInputRef.current?.focus(), 50)
  }

  const saveCustomName = async () => {
    if (!contact) return
    setSavingName(true)
    try {
      const token = localStorage.getItem('token')
      const res = await fetch(`/api/contacts/${contact.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ custom_name: editNameValue.trim() }),
      })
      const data = await res.json()
      if (data.success && data.contact) {
        setContact(data.contact)
      }
    } catch (err) {
      console.error('Failed to save contact name:', err)
    } finally {
      setSavingName(false)
      setEditingName(false)
    }
  }

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
                <div className="flex items-center gap-1.5 group/name">
                  {editingName ? (
                    <div className="flex items-center gap-1 flex-1 min-w-0">
                      <input
                        ref={nameInputRef}
                        value={editNameValue}
                        onChange={e => setEditNameValue(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') saveCustomName(); if (e.key === 'Escape') setEditingName(false) }}
                        className="text-sm font-semibold text-slate-900 bg-slate-50 border border-emerald-300 rounded px-1.5 py-0.5 flex-1 min-w-0 focus:outline-none focus:ring-2 focus:ring-emerald-500/25"
                        disabled={savingName}
                      />
                      <button onClick={saveCustomName} disabled={savingName} className="p-0.5 text-emerald-600 hover:text-emerald-700 transition-colors shrink-0">
                        <Check className="w-4 h-4" />
                      </button>
                    </div>
                  ) : (
                    <>
                      <p className="text-sm font-semibold text-slate-900 truncate">{displayName}</p>
                      {contact && (
                        <button onClick={startEditingName} className="p-0.5 text-slate-300 hover:text-emerald-600 opacity-0 group-hover/name:opacity-100 transition-all shrink-0" title="Editar nombre">
                          <Pencil className="w-3 h-3" />
                        </button>
                      )}
                    </>
                  )}
                </div>
                {(deviceName || fmtDevicePhone) && (
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <Smartphone className="w-3 h-3 text-slate-400" />
                    <span className="text-[11px] text-slate-500 truncate">{deviceName}{fmtDevicePhone ? ` · ${fmtDevicePhone}` : ''}</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Unified Lead Panel — tags are now unified (contact_tags shown in lead panel) */}
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
            <div className="flex items-center justify-center gap-2 group/name">
              {editingName ? (
                <div className="flex items-center gap-1.5">
                  <input
                    ref={nameInputRef}
                    value={editNameValue}
                    onChange={e => setEditNameValue(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') saveCustomName(); if (e.key === 'Escape') setEditingName(false) }}
                    className="text-xl font-semibold text-slate-900 bg-slate-50 border border-emerald-300 rounded-lg px-2 py-1 text-center focus:outline-none focus:ring-2 focus:ring-emerald-500/25"
                    disabled={savingName}
                  />
                  <button onClick={saveCustomName} disabled={savingName} className="p-1 text-emerald-600 hover:text-emerald-700 transition-colors">
                    <Check className="w-5 h-5" />
                  </button>
                </div>
              ) : (
                <>
                  <h4 className="text-xl font-semibold text-slate-900">{displayName}</h4>
                  {contact && (
                    <button onClick={startEditingName} className="p-1 text-slate-300 hover:text-emerald-600 opacity-0 group-hover/name:opacity-100 transition-all" title="Editar nombre">
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  )}
                </>
              )}
            </div>
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

          {/* Contact tags */}
          {contact && (
            <div className="px-4 py-3 border-b border-slate-200">
              <div className="flex items-center gap-1.5 mb-2">
                <Tag className="w-3.5 h-3.5 text-slate-400" />
                <h5 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Etiquetas</h5>
              </div>
              <TagInput
                entityType="contact"
                entityId={contact.id}
                assignedTags={contact.structured_tags || []}
                onTagsChange={(newTags) => {
                  setContact(prev => prev ? { ...prev, structured_tags: newTags } : prev)
                }}
              />
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
