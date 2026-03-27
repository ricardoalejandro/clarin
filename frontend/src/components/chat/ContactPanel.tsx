'use client'

import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X, User, Smartphone, Tag, Pencil, Check, Archive, ArchiveRestore, ShieldBan, ShieldOff } from 'lucide-react'
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

  // ─── Archive / Block ───────────────────────────────────────────────────────
  const [showArchiveModal, setShowArchiveModal] = useState(false)
  const [archiveReason, setArchiveReason] = useState('')
  const [archiveTargetId, setArchiveTargetId] = useState<string | null>(null)
  const [showBlockModal, setShowBlockModal] = useState(false)
  const [blockReason, setBlockReason] = useState('')
  const [blockTargetId, setBlockTargetId] = useState<string | null>(null)

  const getToken = () => localStorage.getItem('token') || ''

  const openArchiveModal = (leadId: string) => {
    setArchiveTargetId(leadId)
    setArchiveReason('')
    setShowArchiveModal(true)
  }

  const confirmArchive = async () => {
    if (!archiveReason || !archiveTargetId) return
    try {
      await fetch(`/api/leads/${archiveTargetId}/archive`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ archive: true, reason: archiveReason }),
      })
      setShowArchiveModal(false)
      fetchDetails()
    } catch (err) { console.error('Failed to archive:', err) }
  }

  const handleRestoreLead = async (leadId: string) => {
    try {
      await fetch(`/api/leads/${leadId}/archive`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ archive: false }),
      })
      fetchDetails()
    } catch (err) { console.error('Failed to restore:', err) }
  }

  const openBlockModal = (leadId: string) => {
    setBlockTargetId(leadId)
    setBlockReason('')
    setShowBlockModal(true)
  }

  const confirmBlock = async () => {
    if (!blockReason || !blockTargetId) return
    try {
      await fetch(`/api/leads/${blockTargetId}/block`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ block: true, reason: blockReason }),
      })
      setShowBlockModal(false)
      fetchDetails()
    } catch (err) { console.error('Failed to block:', err) }
  }

  const handleUnblock = async (leadId: string) => {
    try {
      await fetch(`/api/leads/${leadId}/block`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ block: false }),
      })
      fetchDetails()
    } catch (err) { console.error('Failed to unblock:', err) }
  }

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
            onArchive={(leadId: string, archive: boolean) => {
              if (archive) openArchiveModal(leadId)
              else handleRestoreLead(leadId)
            }}
            onBlock={(leadId: string) => openBlockModal(leadId)}
            onUnblock={(leadId: string) => handleUnblock(leadId)}
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

      {/* ═══ Archive Reason Modal ═══ */}
      {showArchiveModal && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[60]">
          <div className="bg-white rounded-2xl shadow-2xl w-[420px] max-w-[95vw]">
            <div className="px-6 py-4 border-b border-slate-200">
              <h3 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
                <Archive className="w-5 h-5 text-amber-500" />
                Archivar lead
              </h3>
              <p className="text-sm text-slate-500 mt-1">Selecciona el motivo del archivado.</p>
            </div>
            <div className="px-6 py-4 space-y-2">
              {['Ya no aplica al programa', 'Proceso finalizado', 'Lead duplicado', 'Datos incorrectos', 'No responde'].map(reason => (
                <button key={reason} onClick={() => setArchiveReason(reason)} className={`w-full text-left px-4 py-2.5 rounded-lg text-sm transition ${archiveReason === reason ? 'bg-amber-50 text-amber-700 ring-1 ring-amber-200 font-medium' : 'text-slate-700 hover:bg-slate-50'}`}>
                  {reason}
                </button>
              ))}
              <div className="pt-2">
                <input type="text" placeholder="Otro motivo..." value={!['Ya no aplica al programa', 'Proceso finalizado', 'Lead duplicado', 'Datos incorrectos', 'No responde'].includes(archiveReason) ? archiveReason : ''} onChange={(e) => setArchiveReason(e.target.value)} onFocus={() => { if (['Ya no aplica al programa', 'Proceso finalizado', 'Lead duplicado', 'Datos incorrectos', 'No responde'].includes(archiveReason)) setArchiveReason('') }} className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-amber-500 focus:border-amber-500" />
              </div>
            </div>
            <div className="px-6 py-4 border-t border-slate-200 flex justify-end gap-3">
              <button onClick={() => setShowArchiveModal(false)} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition">Cancelar</button>
              <button onClick={confirmArchive} disabled={!archiveReason} className="px-4 py-2 bg-amber-600 text-white text-sm font-medium rounded-lg hover:bg-amber-700 disabled:opacity-50 transition">Archivar</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ═══ Block Reason Modal ═══ */}
      {showBlockModal && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[60]">
          <div className="bg-white rounded-2xl shadow-2xl w-[420px] max-w-[95vw]">
            <div className="px-6 py-4 border-b border-slate-200">
              <h3 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
                <ShieldBan className="w-5 h-5 text-red-500" />
                Bloquear lead
              </h3>
              <p className="text-sm text-slate-500 mt-1">Selecciona el motivo del bloqueo. Los leads bloqueados no serán contactados.</p>
            </div>
            <div className="px-6 py-4 space-y-2">
              {['No está interesado', 'Solicita no ser contactado', 'Agresivo o abusivo', 'Número equivocado', 'Spam o fraude'].map(reason => (
                <button key={reason} onClick={() => setBlockReason(reason)} className={`w-full text-left px-4 py-2.5 rounded-lg text-sm transition ${blockReason === reason ? 'bg-red-50 text-red-700 ring-1 ring-red-200 font-medium' : 'text-slate-700 hover:bg-slate-50'}`}>
                  {reason}
                </button>
              ))}
              <div className="pt-2">
                <input type="text" placeholder="Otro motivo..." value={!['No está interesado', 'Solicita no ser contactado', 'Agresivo o abusivo', 'Número equivocado', 'Spam o fraude'].includes(blockReason) ? blockReason : ''} onChange={(e) => setBlockReason(e.target.value)} onFocus={() => { if (['No está interesado', 'Solicita no ser contactado', 'Agresivo o abusivo', 'Número equivocado', 'Spam o fraude'].includes(blockReason)) setBlockReason('') }} className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-red-500 focus:border-red-500" />
              </div>
            </div>
            <div className="px-6 py-4 border-t border-slate-200 flex justify-end gap-3">
              <button onClick={() => setShowBlockModal(false)} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition">Cancelar</button>
              <button onClick={confirmBlock} disabled={!blockReason} className="px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 disabled:opacity-50 transition">Bloquear</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
