'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { X, User, Smartphone, Tag, Pencil, Check, Archive, ArchiveRestore, ShieldBan, ShieldOff, AlertCircle, CheckCircle2, Loader2, RotateCcw } from 'lucide-react'
import ImageViewer from '@/components/chat/ImageViewer'
import LeadDetailPanel from '@/components/LeadDetailPanel'
import TagInput from '@/components/TagInput'
import { useAccessibleDialog } from '@/components/pipelines/useAccessibleDialog'
import type { Lead, PipelineStage, StructuredTag } from '@/types/contact'

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
  do_not_contact?: boolean
  do_not_contact_reason?: string
}

const DO_NOT_CONTACT_REASONS = ['Solicita no ser contactado', 'Agresivo o abusivo', 'Número equivocado', 'Spam o fraude']

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
  const [opportunities, setOpportunities] = useState<Lead[]>([])
  const [loadingOpportunity, setLoadingOpportunity] = useState(false)
  const [loading, setLoading] = useState(true)
  const [showAvatarViewer, setShowAvatarViewer] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [editNameValue, setEditNameValue] = useState('')
  const [savingName, setSavingName] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const activeChatIdRef = useRef<string | null>(isOpen ? chatId : null)
  const selectedOpportunityIdRef = useRef<string | null>(null)

  // ─── Archive / Block ───────────────────────────────────────────────────────
  const [showArchiveModal, setShowArchiveModal] = useState(false)
  const [archiveReason, setArchiveReason] = useState('')
  const [archiveTargetId, setArchiveTargetId] = useState<string | null>(null)
  const [showBlockModal, setShowBlockModal] = useState(false)
  const [blockReason, setBlockReason] = useState('')
  const [savingBlock, setSavingBlock] = useState(false)
  const [blockError, setBlockError] = useState('')
  const blockDialogRef = useRef<HTMLDivElement>(null)
  const blockCancelRef = useRef<HTMLButtonElement>(null)
  const [stageChangeRequest, setStageChangeRequest] = useState<{ lead: Lead; stage: PipelineStage; mode: 'won' | 'lost' | 'reopen' } | null>(null)
  const [stageChangeReason, setStageChangeReason] = useState('')
  const [stageChangeError, setStageChangeError] = useState('')
  const [savingStageChange, setSavingStageChange] = useState(false)
  const stageChangeDialogRef = useRef<HTMLDivElement>(null)

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

  const openBlockModal = () => {
    if (!contact) return
    setBlockReason('')
    setBlockError('')
    setShowBlockModal(true)
  }

  const confirmBlock = async () => {
    if (!blockReason.trim() || !contact || savingBlock) return
    setSavingBlock(true)
    setBlockError('')
    try {
      const response = await fetch(`/api/contacts/${contact.id}/do-not-contact`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ blocked: true, reason: blockReason.trim() }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.success) throw new Error(data?.error || 'No se pudo guardar la preferencia.')
      setShowBlockModal(false)
      await fetchDetails()
    } catch (err) {
      console.error('Failed to set do-not-contact:', err)
      setBlockError(err instanceof Error ? err.message : 'No se pudo guardar la preferencia.')
    } finally {
      setSavingBlock(false)
    }
  }

  const handleUnblock = async () => {
    if (!contact) return
    try {
      const response = await fetch(`/api/contacts/${contact.id}/do-not-contact`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ blocked: false }),
      })
      if (!response.ok) throw new Error('No se pudo permitir el contacto.')
      await fetchDetails()
    } catch (err) { console.error('Failed to allow contact:', err) }
  }

  const closeBlockModal = useCallback(() => {
    if (!savingBlock) setShowBlockModal(false)
  }, [savingBlock])
  useAccessibleDialog(showBlockModal, blockDialogRef, closeBlockModal, blockCancelRef)

  const applyOpportunityStage = async (targetLead: Lead, stage: PipelineStage, closeReason = '') => {
    const response = await fetch(`/api/leads/${targetLead.id}/stage`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ stage_id: stage.id, ...(closeReason ? { close_reason: closeReason } : {}) }),
    })
    const data = await response.json().catch(() => null)
    if (!response.ok || !data?.success || !data.lead) throw new Error(data?.error || 'No se pudo actualizar la oportunidad.')
    const updated = { ...data.lead, structured_tags: data.lead.structured_tags || targetLead.structured_tags }
    selectedOpportunityIdRef.current = updated.id
    setLead(updated)
    setOpportunities(current => current.map(item => item.id === updated.id ? updated : item))
  }

  const requestOpportunityStageChange = (targetLead: Lead, stage: PipelineStage) => {
    if (stage.stage_type !== 'won' && stage.stage_type !== 'lost' && targetLead.status !== 'won' && targetLead.status !== 'lost') {
      void applyOpportunityStage(targetLead, stage).catch(error => console.error('Failed to update opportunity stage:', error))
      return
    }
    setStageChangeRequest({
      lead: targetLead,
      stage,
      mode: stage.stage_type === 'won' || stage.stage_type === 'lost' ? stage.stage_type : 'reopen',
    })
    setStageChangeReason('')
    setStageChangeError('')
  }

  const closeStageChangeDialog = useCallback(() => {
    if (!savingStageChange) setStageChangeRequest(null)
  }, [savingStageChange])
  useAccessibleDialog(Boolean(stageChangeRequest), stageChangeDialogRef, closeStageChangeDialog)

  const confirmOpportunityStageChange = async () => {
    if (!stageChangeRequest || savingStageChange) return
    if (stageChangeRequest.mode === 'lost' && !stageChangeReason.trim()) {
      setStageChangeError('Indica por qué se perdió esta oportunidad.')
      return
    }
    setSavingStageChange(true)
    setStageChangeError('')
    try {
      await applyOpportunityStage(stageChangeRequest.lead, stageChangeRequest.stage, stageChangeRequest.mode === 'lost' ? stageChangeReason.trim() : '')
      setStageChangeRequest(null)
      setStageChangeReason('')
    } catch (error) {
      setStageChangeError(error instanceof Error ? error.message : 'No se pudo actualizar la oportunidad.')
    } finally {
      setSavingStageChange(false)
    }
  }

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !showArchiveModal && !showBlockModal && !stageChangeRequest) onClose()
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [isOpen, onClose, showArchiveModal, showBlockModal, stageChangeRequest])

  useEffect(() => {
    activeChatIdRef.current = isOpen ? chatId : null
    if (isOpen && chatId) {
      setContact(null)
      setLead(null)
      setOpportunities([])
      setLoadingOpportunity(false)
      selectedOpportunityIdRef.current = null
      setEditingName(false)
      setShowAvatarViewer(false)
      setLoading(true)
      fetchDetails(chatId)
    } else {
      setContact(null)
      setLead(null)
      setOpportunities([])
      setLoadingOpportunity(false)
      selectedOpportunityIdRef.current = null
      setLoading(false)
    }
  }, [isOpen, chatId])

  const fetchDetails = async (targetChatId: string = chatId) => {
    setLoading(true)
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/chats/${targetChatId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (activeChatIdRef.current !== targetChatId) return
      if (data.success) {
        const nextContact = data.contact || null
        setContact(nextContact)
        let nextOpportunities: Lead[] = data.lead ? [data.lead] : []
        if (nextContact?.id) {
          try {
            const opportunitiesResponse = await fetch(`/api/contacts/${nextContact.id}/leads`, {
              headers: { Authorization: `Bearer ${token}` },
            })
            const opportunitiesData = await opportunitiesResponse.json().catch(() => null)
            if (opportunitiesResponse.ok && opportunitiesData?.success) nextOpportunities = opportunitiesData.leads || []
          } catch {
            // Keep the chat's preferred opportunity as a resilient fallback.
          }
        }
        if (activeChatIdRef.current !== targetChatId) return
        setOpportunities(nextOpportunities)
        const preferredId = selectedOpportunityIdRef.current || data.lead?.id
        const selected = nextOpportunities.find(item => item.id === preferredId)
          || nextOpportunities.find(item => item.status === 'open' && !item.is_archived && !item.deleted_at)
          || nextOpportunities[0]
          || data.lead
          || null
        selectedOpportunityIdRef.current = selected?.id || null
        setLead(selected)
      }
    } catch (err) {
      console.error('Failed to fetch chat details:', err)
    } finally {
      if (activeChatIdRef.current === targetChatId) {
        setLoading(false)
      }
    }
  }

  const selectOpportunity = async (opportunityId: string) => {
    if (opportunityId === lead?.id || loadingOpportunity) return
    const previousId = lead?.id || null
    selectedOpportunityIdRef.current = opportunityId
    setLoadingOpportunity(true)
    try {
      const response = await fetch(`/api/leads/${opportunityId}`, { headers: { Authorization: `Bearer ${getToken()}` } })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.success || !data.lead) throw new Error(data?.error || 'No se pudo abrir la oportunidad.')
      if (selectedOpportunityIdRef.current !== opportunityId) return
      setLead(data.lead)
      setOpportunities(current => current.map(item => item.id === opportunityId ? { ...item, ...data.lead } : item))
    } catch (error) {
      selectedOpportunityIdRef.current = previousId
      console.error('Failed to load opportunity:', error)
    } finally {
      setLoadingOpportunity(false)
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
          {lead ? 'Contacto y oportunidad' : 'Contacto'}
        </h3>
        <button type="button" onClick={onClose} className="inline-flex h-11 w-11 items-center justify-center rounded-xl transition hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label="Cerrar detalle">
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
            {opportunities.length > 1 && (
              <div className="mt-3 rounded-2xl border border-slate-200 bg-slate-50 p-3">
                <label htmlFor="chat-opportunity-selector" className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-slate-500">Oportunidad que estás viendo</label>
                <select
                  id="chat-opportunity-selector"
                  value={selectedOpportunityIdRef.current || lead.id}
                  onChange={event => void selectOpportunity(event.target.value)}
                  disabled={loadingOpportunity}
                  className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100"
                >
                  {opportunities.map(opportunity => (
                    <option key={opportunity.id} value={opportunity.id}>
                      {opportunity.title || 'Oportunidad sin título'} · {opportunity.deleted_at ? 'Papelera' : opportunity.is_archived ? 'Archivada' : opportunity.status === 'won' ? 'Ganada' : opportunity.status === 'lost' ? 'Perdida' : 'Abierta'}
                    </option>
                  ))}
                </select>
                <p className="mt-1.5 text-xs leading-relaxed text-slate-500">{loadingOpportunity ? 'Abriendo oportunidad…' : 'Las acciones comerciales se aplicarán únicamente a la oportunidad seleccionada.'}</p>
              </div>
            )}
          </div>

          {/* Unified Lead Panel — tags are now unified (contact_tags shown in lead panel) */}
          <LeadDetailPanel
            lead={lead}
            onLeadChange={(updatedLead) => {
              setLead(updatedLead)
              setOpportunities(current => current.map(item => item.id === updatedLead.id ? updatedLead : item))
            }}
            onClose={onClose}
            hideHeader={true}
            hideWhatsApp={true}
            hideDelete={false}
            onDelete={() => {
              setOpportunities(current => current.filter(item => item.id !== lead.id))
              selectedOpportunityIdRef.current = null
              setLead(null)
              fetchDetails()
            }}
            onArchive={(leadId: string, archive: boolean) => {
              if (archive) openArchiveModal(leadId)
              else handleRestoreLead(leadId)
            }}
            onBlock={() => openBlockModal()}
            onUnblock={() => handleUnblock()}
            onStageChangeRequest={requestOpportunityStageChange}
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

          {contact && (
            <div className="px-4 py-4 border-b border-slate-200">
              {contact.do_not_contact ? (
                <div className="rounded-2xl border border-red-200 bg-red-50 p-4">
                  <div className="flex items-start gap-3">
                    <ShieldBan className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold text-red-900">No contactar</p>
                      <p className="mt-1 text-xs leading-relaxed text-red-700">{contact.do_not_contact_reason || 'Este contacto no debe recibir mensajes.'}</p>
                    </div>
                  </div>
                  <button type="button" onClick={() => void handleUnblock()} className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-red-200 bg-white px-4 text-sm font-semibold text-red-700 transition hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2">
                    <ShieldOff className="h-4 w-4" /> Permitir contacto
                  </button>
                </div>
              ) : (
                <button type="button" onClick={openBlockModal} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:border-red-200 hover:bg-red-50 hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2">
                  <ShieldBan className="h-4 w-4" /> Marcar como no contactable
                </button>
              )}
            </div>
          )}

          <div className="px-4 py-6 text-center">
            <p className="text-sm text-slate-400 italic">Este contacto aún no tiene una oportunidad asociada.</p>
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

      {stageChangeRequest && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 z-[85] flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-sm">
          <div ref={stageChangeDialogRef} role="dialog" aria-modal="true" aria-labelledby="chat-stage-change-title" aria-describedby="chat-stage-change-description" tabIndex={-1} className="w-full max-w-md overflow-hidden rounded-3xl bg-white shadow-2xl">
            <div className="flex items-start gap-3 border-b border-slate-200 px-5 py-5 sm:px-6">
              <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ${stageChangeRequest.mode === 'won' ? 'bg-emerald-50 text-emerald-700' : stageChangeRequest.mode === 'lost' ? 'bg-red-50 text-red-700' : 'bg-blue-50 text-blue-700'}`}>
                {stageChangeRequest.mode === 'won' ? <CheckCircle2 className="h-5 w-5" /> : stageChangeRequest.mode === 'lost' ? <AlertCircle className="h-5 w-5" /> : <RotateCcw className="h-5 w-5" />}
              </div>
              <div className="min-w-0 flex-1">
                <h3 id="chat-stage-change-title" className="text-lg font-bold text-slate-900">
                  {stageChangeRequest.mode === 'won' ? 'Marcar oportunidad como ganada' : stageChangeRequest.mode === 'lost' ? 'Marcar oportunidad como perdida' : 'Reabrir oportunidad'}
                </h3>
                <p id="chat-stage-change-description" className="mt-1 text-sm leading-relaxed text-slate-500">
                  {stageChangeRequest.lead.title || 'Oportunidad sin título'} · {stageChangeRequest.stage.name}
                </p>
              </div>
              <button type="button" onClick={closeStageChangeDialog} disabled={savingStageChange} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-50" aria-label="Cerrar"><X className="h-5 w-5" /></button>
            </div>
            <div className="px-5 py-5 sm:px-6">
              {stageChangeRequest.mode === 'lost' ? (
                <div>
                  <label htmlFor="chat-loss-reason" className="mb-2 block text-sm font-bold text-slate-800">Motivo de pérdida <span className="text-red-600">*</span></label>
                  <textarea id="chat-loss-reason" autoFocus value={stageChangeReason} onChange={event => { setStageChangeReason(event.target.value); setStageChangeError('') }} rows={4} maxLength={1000} placeholder="Ej. Eligió otra opción, presupuesto insuficiente…" className="w-full resize-none rounded-xl border border-slate-300 px-4 py-3 text-sm leading-relaxed text-slate-800 focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-100" />
                  <p className="mt-1.5 text-right text-xs tabular-nums text-slate-400">{stageChangeReason.length}/1000</p>
                </div>
              ) : (
                <p className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm leading-relaxed text-slate-600">
                  {stageChangeRequest.mode === 'won' ? 'La oportunidad saldrá de las abiertas y quedará registrada como ganada.' : 'La oportunidad volverá a estar abierta y se limpiarán los datos de su cierre anterior.'}
                </p>
              )}
              {stageChangeError && <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm font-medium text-red-700" role="alert">{stageChangeError}</p>}
            </div>
            <div className="flex flex-col-reverse gap-2 border-t border-slate-200 px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
              <button type="button" onClick={closeStageChangeDialog} disabled={savingStageChange} className="min-h-11 rounded-xl border border-slate-200 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 disabled:opacity-50">Cancelar</button>
              <button type="button" onClick={() => void confirmOpportunityStageChange()} disabled={savingStageChange || (stageChangeRequest.mode === 'lost' && !stageChangeReason.trim())} className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-5 text-sm font-bold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-45 ${stageChangeRequest.mode === 'lost' ? 'bg-red-600 hover:bg-red-700 focus-visible:ring-red-500' : 'bg-emerald-600 hover:bg-emerald-700 focus-visible:ring-emerald-500'}`}>
                {savingStageChange && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />}
                {savingStageChange ? 'Guardando…' : stageChangeRequest.mode === 'won' ? 'Confirmar ganada' : stageChangeRequest.mode === 'lost' ? 'Confirmar perdida' : 'Reabrir oportunidad'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ═══ Archive Reason Modal ═══ */}
      {showArchiveModal && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[60]">
          <div className="bg-white rounded-2xl shadow-2xl w-[420px] max-w-[95vw]">
            <div className="px-6 py-4 border-b border-slate-200">
              <h3 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
                <Archive className="w-5 h-5 text-amber-500" />
                Archivar oportunidad
              </h3>
              <p className="text-sm text-slate-500 mt-1">La persona, el chat y sus eventos se conservarán.</p>
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

      {/* ═══ Do-not-contact reason modal ═══ */}
      {showBlockModal && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-sm" onMouseDown={event => { if (event.target === event.currentTarget) closeBlockModal() }}>
          <div ref={blockDialogRef} role="dialog" aria-modal="true" aria-labelledby="contact-dnc-title" aria-describedby="contact-dnc-description" tabIndex={-1} className="flex max-h-[min(90vh,680px)] w-full max-w-md flex-col overflow-hidden rounded-3xl bg-white shadow-2xl">
            <div className="flex items-start gap-3 border-b border-slate-200 px-5 py-5 sm:px-6">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-red-50 text-red-600"><ShieldBan className="h-5 w-5" /></div>
              <div className="min-w-0 flex-1">
              <h3 id="contact-dnc-title" className="text-lg font-bold text-slate-900">
                No contactar a esta persona
              </h3>
              <p id="contact-dnc-description" className="mt-1 text-sm leading-relaxed text-slate-500">Esta preferencia se aplica al contacto completo y a todas sus oportunidades. No cambia si están ganadas, perdidas o abiertas.</p>
              </div>
              <button type="button" onClick={closeBlockModal} disabled={savingBlock} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-50" aria-label="Cerrar"><X className="h-5 w-5" /></button>
            </div>
            <div className="space-y-2 overflow-y-auto px-5 py-5 sm:px-6">
              <p className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">Motivo</p>
              {DO_NOT_CONTACT_REASONS.map(reason => (
                <button type="button" key={reason} onClick={() => { setBlockReason(reason); setBlockError('') }} className={`min-h-11 w-full rounded-xl px-4 py-2.5 text-left text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 ${blockReason === reason ? 'bg-red-50 text-red-700 ring-1 ring-red-200 font-semibold' : 'text-slate-700 hover:bg-slate-50'}`} aria-pressed={blockReason === reason}>
                  {reason}
                </button>
              ))}
              <div className="pt-2">
                <label htmlFor="contact-dnc-other" className="sr-only">Otro motivo</label>
                <input id="contact-dnc-other" type="text" placeholder="Otro motivo relacionado con la comunicación…" value={!DO_NOT_CONTACT_REASONS.includes(blockReason) ? blockReason : ''} onChange={(e) => { setBlockReason(e.target.value); setBlockError('') }} onFocus={() => { if (DO_NOT_CONTACT_REASONS.includes(blockReason)) setBlockReason('') }} className="h-11 w-full rounded-xl border border-slate-300 px-4 text-sm focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-100" />
              </div>
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-relaxed text-amber-800">“No está interesado” es un resultado comercial: se registra llevando la oportunidad a Perdido, no bloqueando al contacto.</div>
              {blockError && <p className="text-sm font-medium text-red-700" role="alert">{blockError}</p>}
            </div>
            <div className="flex flex-col-reverse gap-2 border-t border-slate-200 bg-white px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
              <button ref={blockCancelRef} type="button" onClick={closeBlockModal} disabled={savingBlock} className="min-h-11 rounded-xl border border-slate-200 px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 disabled:opacity-50">Cancelar</button>
              <button type="button" onClick={() => void confirmBlock()} disabled={!blockReason.trim() || savingBlock} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-red-600 px-5 text-sm font-bold text-white transition hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-45">{savingBlock ? 'Guardando…' : 'Confirmar no contactar'}</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
