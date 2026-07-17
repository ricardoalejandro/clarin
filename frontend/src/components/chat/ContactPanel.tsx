'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { X, User, Smartphone, Tag, Pencil, Check, Archive, ShieldBan, ShieldOff, AlertCircle, CheckCircle2, Loader2, RotateCcw, BriefcaseBusiness, Mail, Building2, Cake, FileText, Plus, RefreshCw, Search } from 'lucide-react'
import LeadDetailPanel from '@/components/LeadDetailPanel'
import ContactAvatarControl from '@/components/ContactAvatarControl'
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

interface ChatDevice {
  id: string
  name?: string | null
  phone?: string | null
  status?: string | null
  provider?: 'whatsapp_web' | 'whatsapp_cloud_api' | string | null
}

interface ContactSearchResult {
  id: string
  jid: string
  phone?: string | null
  name?: string | null
  custom_name?: string | null
  last_name?: string | null
  push_name?: string | null
  company?: string | null
  avatar_url?: string | null
}

const DO_NOT_CONTACT_REASONS = ['Solicita no ser contactado', 'Agresivo o abusivo', 'Número equivocado', 'Spam o fraude']
const ARCHIVE_OPPORTUNITY_REASONS = ['Ya no aplica al programa', 'Proceso finalizado', 'Oportunidad duplicada', 'Datos incorrectos', 'No responde']

interface ContactPanelProps {
  chatId: string
  isOpen: boolean
  onClose: () => void
  deviceName?: string
  devicePhone?: string
  chatPhone?: string
}

export default function ContactPanel({ chatId, isOpen, onClose, deviceName, devicePhone, chatPhone }: ContactPanelProps) {
  const [contact, setContact] = useState<Contact | null>(null)
  const [chatDevice, setChatDevice] = useState<ChatDevice | null>(null)
  const [lead, setLead] = useState<Lead | null>(null)
  const [opportunities, setOpportunities] = useState<Lead[]>([])
  const [loadingOpportunity, setLoadingOpportunity] = useState(false)
  const [loading, setLoading] = useState(true)
  const [detailsError, setDetailsError] = useState('')
  const [opportunitiesError, setOpportunitiesError] = useState('')
  const [opportunitySelectionError, setOpportunitySelectionError] = useState<{ opportunityId: string; message: string } | null>(null)
  const [showCreateOpportunity, setShowCreateOpportunity] = useState(false)
  const [newOpportunityTitle, setNewOpportunityTitle] = useState('Consulta por WhatsApp')
  const [creatingOpportunity, setCreatingOpportunity] = useState(false)
  const [createOpportunityError, setCreateOpportunityError] = useState('')
  const [editingName, setEditingName] = useState(false)
  const [editNameValue, setEditNameValue] = useState('')
  const [savingName, setSavingName] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const activeChatIdRef = useRef<string | null>(isOpen ? chatId : null)
  const selectedOpportunityIdRef = useRef<string | null>(null)
  const detailsAbortRef = useRef<AbortController | null>(null)
  const opportunityAbortRef = useRef<AbortController | null>(null)
  const stageMutationAbortRef = useRef<AbortController | null>(null)
  const nameMutationAbortRef = useRef<AbortController | null>(null)
  const createMutationAbortRef = useRef<AbortController | null>(null)
  const preferenceMutationAbortRef = useRef<AbortController | null>(null)
  const restoreMutationAbortRef = useRef<AbortController | null>(null)
  const mutationEpochRef = useRef(0)
	const activeContactIdRef = useRef<string | null>(null)
  const contactSearchAbortRef = useRef<AbortController | null>(null)
  const contactLinkBusyRef = useRef(false)
  const [showContactLinker, setShowContactLinker] = useState(false)
  const [contactSearch, setContactSearch] = useState('')
  const [contactMatches, setContactMatches] = useState<ContactSearchResult[]>([])
  const [contactSearchLoading, setContactSearchLoading] = useState(false)
  const [newContactName, setNewContactName] = useState('')
  const [linkingContactId, setLinkingContactId] = useState<string | null>(null)
  const [contactLinkError, setContactLinkError] = useState('')
	activeContactIdRef.current = contact?.id || null

  // ─── Archive / Block ───────────────────────────────────────────────────────
  const [showArchiveModal, setShowArchiveModal] = useState(false)
  const [archiveReason, setArchiveReason] = useState('')
  const [archiveTargetId, setArchiveTargetId] = useState<string | null>(null)
  const [savingArchive, setSavingArchive] = useState(false)
  const [archiveError, setArchiveError] = useState('')
  const savingArchiveRef = useRef(false)
  const archiveDialogRef = useRef<HTMLDivElement>(null)
  const archiveCancelRef = useRef<HTMLButtonElement>(null)
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

  const searchContacts = useCallback(async (query: string) => {
    contactSearchAbortRef.current?.abort()
    const normalizedQuery = query.trim()
    if (normalizedQuery.length < 2) {
      setContactMatches([])
      setContactSearchLoading(false)
      return
    }
    const controller = new AbortController()
    contactSearchAbortRef.current = controller
    setContactSearchLoading(true)
    setContactLinkError('')
    try {
      const params = new URLSearchParams({ search: normalizedQuery, limit: '10', offset: '0' })
      const response = await fetch(`/api/chats/contacts/search?${params.toString()}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('token') || ''}` },
        signal: controller.signal,
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.success) throw new Error(data?.error || 'No se pudieron buscar contactos.')
      if (controller.signal.aborted) return
      setContactMatches(Array.isArray(data.contacts) ? data.contacts : [])
    } catch (error) {
      if (controller.signal.aborted) return
      setContactMatches([])
      setContactLinkError(error instanceof Error ? error.message : 'No se pudieron buscar contactos.')
    } finally {
      if (contactSearchAbortRef.current === controller) {
        contactSearchAbortRef.current = null
        setContactSearchLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    if (!showContactLinker) {
      contactSearchAbortRef.current?.abort()
      setContactSearchLoading(false)
      return
    }
    const timer = window.setTimeout(() => void searchContacts(contactSearch), 250)
    return () => window.clearTimeout(timer)
  }, [contactSearch, searchContacts, showContactLinker])

  const openContactLinker = () => {
    const initialPhone = (chatPhone || '').replace(/^\+/, '')
    setContactSearch(initialPhone)
    setContactMatches([])
    setNewContactName('')
    setContactLinkError('')
    setShowContactLinker(true)
  }

  const linkChatContact = async (payload: { contact_id?: string; name?: string }, pendingId: string) => {
    if (contactLinkBusyRef.current) return
    const targetChatId = activeChatIdRef.current
    if (!targetChatId) return
    contactLinkBusyRef.current = true
    setLinkingContactId(pendingId)
    setContactLinkError('')
    try {
      const response = await fetch(`/api/chats/${targetChatId}/contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify(payload),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.success) throw new Error(data?.error || 'No se pudo vincular el contacto.')
      if (activeChatIdRef.current !== targetChatId) return
      setShowContactLinker(false)
      await fetchDetails(targetChatId)
    } catch (error) {
      if (activeChatIdRef.current === targetChatId) {
        setContactLinkError(error instanceof Error ? error.message : 'No se pudo vincular el contacto.')
      }
    } finally {
      contactLinkBusyRef.current = false
      setLinkingContactId(null)
    }
  }

  const closeArchiveModal = useCallback(() => {
    if (savingArchiveRef.current) return
    setShowArchiveModal(false)
    setArchiveError('')
  }, [])
  useAccessibleDialog(showArchiveModal, archiveDialogRef, closeArchiveModal, archiveCancelRef)

  const openArchiveModal = (leadId: string) => {
    setArchiveTargetId(leadId)
    setArchiveReason('')
    setArchiveError('')
    setShowArchiveModal(true)
  }

  const confirmArchive = async () => {
    if (!archiveReason.trim() || !archiveTargetId || savingArchiveRef.current) return
    const targetChatId = activeChatIdRef.current
    if (!targetChatId) return
    savingArchiveRef.current = true
    setSavingArchive(true)
    setArchiveError('')
    try {
      const response = await fetch(`/api/leads/${archiveTargetId}/archive`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ archive: true, reason: archiveReason.trim() }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.success) throw new Error(data?.error || 'No se pudo archivar la oportunidad.')
      if (activeChatIdRef.current !== targetChatId) return
      setShowArchiveModal(false)
      await fetchDetails(targetChatId)
    } catch (err) {
      if (activeChatIdRef.current === targetChatId) {
        setArchiveError(err instanceof Error ? err.message : 'No se pudo archivar la oportunidad.')
      }
    } finally {
      savingArchiveRef.current = false
      setSavingArchive(false)
    }
  }

  const handleRestoreLead = async (leadId: string) => {
	const targetChatId = activeChatIdRef.current
	const epoch = mutationEpochRef.current
	if (!targetChatId) return
	restoreMutationAbortRef.current?.abort()
	const controller = new AbortController()
	restoreMutationAbortRef.current = controller
    try {
	  const response = await fetch(`/api/leads/${leadId}/archive`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ archive: false }),
		signal: controller.signal,
      })
	  if (!response.ok) throw new Error('No se pudo restaurar la oportunidad.')
	  if (!controller.signal.aborted && mutationEpochRef.current === epoch && activeChatIdRef.current === targetChatId) await fetchDetails(targetChatId)
	} catch (err) {
	  if (!controller.signal.aborted && mutationEpochRef.current === epoch && activeChatIdRef.current === targetChatId) console.error('Failed to restore:', err)
	}
  }

  const openBlockModal = () => {
    if (!contact) return
    setBlockReason('')
    setBlockError('')
    setShowBlockModal(true)
  }

  const confirmBlock = async () => {
    if (!blockReason.trim() || !contact || savingBlock) return
	const targetChatId = activeChatIdRef.current
	const targetContactId = contact.id
	const epoch = mutationEpochRef.current
	if (!targetChatId) return
	preferenceMutationAbortRef.current?.abort()
	const controller = new AbortController()
	preferenceMutationAbortRef.current = controller
    setSavingBlock(true)
    setBlockError('')
    try {
      const response = await fetch(`/api/contacts/${contact.id}/do-not-contact`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ blocked: true, reason: blockReason.trim() }),
		signal: controller.signal,
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.success) throw new Error(data?.error || 'No se pudo guardar la preferencia.')
	  if (controller.signal.aborted || mutationEpochRef.current !== epoch || activeChatIdRef.current !== targetChatId || activeContactIdRef.current !== targetContactId) return
	  setShowBlockModal(false)
	  await fetchDetails(targetChatId)
    } catch (err) {
	  if (!controller.signal.aborted && mutationEpochRef.current === epoch && activeChatIdRef.current === targetChatId && activeContactIdRef.current === targetContactId) {
		console.error('Failed to set do-not-contact:', err)
		setBlockError(err instanceof Error ? err.message : 'No se pudo guardar la preferencia.')
	  }
    } finally {
	  if (mutationEpochRef.current === epoch && activeChatIdRef.current === targetChatId) setSavingBlock(false)
    }
  }

  const handleUnblock = async () => {
    if (!contact) return
	const targetChatId = activeChatIdRef.current
	const targetContactId = contact.id
	const epoch = mutationEpochRef.current
	if (!targetChatId) return
	preferenceMutationAbortRef.current?.abort()
	const controller = new AbortController()
	preferenceMutationAbortRef.current = controller
    try {
      const response = await fetch(`/api/contacts/${contact.id}/do-not-contact`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ blocked: false }),
		signal: controller.signal,
      })
      if (!response.ok) throw new Error('No se pudo permitir el contacto.')
	  if (!controller.signal.aborted && mutationEpochRef.current === epoch && activeChatIdRef.current === targetChatId && activeContactIdRef.current === targetContactId) await fetchDetails(targetChatId)
	} catch (err) {
	  if (!controller.signal.aborted && mutationEpochRef.current === epoch && activeChatIdRef.current === targetChatId) console.error('Failed to allow contact:', err)
	}
  }

  const closeBlockModal = useCallback(() => {
    if (!savingBlock) setShowBlockModal(false)
  }, [savingBlock])
  useAccessibleDialog(showBlockModal, blockDialogRef, closeBlockModal, blockCancelRef)

  const applyOpportunityStage = async (targetLead: Lead, stage: PipelineStage, closeReason = '') => {
	const targetChatId = activeChatIdRef.current
	if (!targetChatId) return
	const epoch = mutationEpochRef.current
	stageMutationAbortRef.current?.abort()
	const controller = new AbortController()
	stageMutationAbortRef.current = controller
    const response = await fetch(`/api/leads/${targetLead.id}/stage`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ stage_id: stage.id, ...(closeReason ? { close_reason: closeReason } : {}) }),
	  signal: controller.signal,
    })
    const data = await response.json().catch(() => null)
    if (!response.ok || !data?.success || !data.lead) throw new Error(data?.error || 'No se pudo actualizar la oportunidad.')
	if (controller.signal.aborted || mutationEpochRef.current !== epoch || activeChatIdRef.current !== targetChatId) return
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
	const targetChatId = activeChatIdRef.current
	const epoch = mutationEpochRef.current
    try {
      await applyOpportunityStage(stageChangeRequest.lead, stageChangeRequest.stage, stageChangeRequest.mode === 'lost' ? stageChangeReason.trim() : '')
	  if (mutationEpochRef.current !== epoch || activeChatIdRef.current !== targetChatId) return
      setStageChangeRequest(null)
      setStageChangeReason('')
    } catch (error) {
	  if (mutationEpochRef.current !== epoch || activeChatIdRef.current !== targetChatId || (error instanceof DOMException && error.name === 'AbortError')) return
      setStageChangeError(error instanceof Error ? error.message : 'No se pudo actualizar la oportunidad.')
    } finally {
	  if (mutationEpochRef.current === epoch && activeChatIdRef.current === targetChatId) setSavingStageChange(false)
    }
  }

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || showArchiveModal || showBlockModal || stageChangeRequest) return
      if (showContactLinker) setShowContactLinker(false)
      else onClose()
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [isOpen, onClose, showArchiveModal, showBlockModal, showContactLinker, stageChangeRequest])

  useEffect(() => {
	mutationEpochRef.current += 1
	stageMutationAbortRef.current?.abort()
	nameMutationAbortRef.current?.abort()
	createMutationAbortRef.current?.abort()
	preferenceMutationAbortRef.current?.abort()
	restoreMutationAbortRef.current?.abort()
    activeChatIdRef.current = isOpen ? chatId : null
    if (isOpen && chatId) {
      detailsAbortRef.current?.abort()
      opportunityAbortRef.current?.abort()
      setContact(null)
      setChatDevice(null)
      setLead(null)
      setOpportunities([])
      setLoadingOpportunity(false)
      setDetailsError('')
      setOpportunitiesError('')
      setOpportunitySelectionError(null)
      setShowCreateOpportunity(false)
      setNewOpportunityTitle('Consulta por WhatsApp')
      setCreateOpportunityError('')
	  setShowArchiveModal(false)
	  setStageChangeRequest(null)
	  setSavingStageChange(false)
      setArchiveTargetId(null)
      setArchiveError('')
      selectedOpportunityIdRef.current = null
      setEditingName(false)
      setShowContactLinker(false)
      setContactMatches([])
      setContactLinkError('')
      setLinkingContactId(null)
      setLoading(true)
      fetchDetails(chatId)
    } else {
      setContact(null)
      setChatDevice(null)
      setLead(null)
      setOpportunities([])
      setLoadingOpportunity(false)
      selectedOpportunityIdRef.current = null
      setLoading(false)
    }
    return () => {
	  mutationEpochRef.current += 1
	  stageMutationAbortRef.current?.abort()
	  nameMutationAbortRef.current?.abort()
	  createMutationAbortRef.current?.abort()
	  preferenceMutationAbortRef.current?.abort()
	  restoreMutationAbortRef.current?.abort()
      activeChatIdRef.current = null
      detailsAbortRef.current?.abort()
      opportunityAbortRef.current?.abort()
      contactSearchAbortRef.current?.abort()
    }
  // fetchDetails deliberately uses an explicit chat id and guards late responses.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, chatId])

  const fetchDetails = async (targetChatId: string = chatId) => {
    detailsAbortRef.current?.abort()
    opportunityAbortRef.current?.abort()
    setLoadingOpportunity(false)
    const controller = new AbortController()
    detailsAbortRef.current = controller
    setLoading(true)
    setDetailsError('')
    setOpportunitiesError('')
    setOpportunitySelectionError(null)
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/chats/${targetChatId}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.success) throw new Error(data?.error || 'No se pudieron cargar los detalles del chat.')
      if (activeChatIdRef.current !== targetChatId) return
      const nextContact = data.contact || null
      setContact(nextContact)
      setChatDevice(data.device || null)
      let nextOpportunities: Lead[] = Array.isArray(data.opportunities) ? data.opportunities : data.lead ? [data.lead] : []
      if (nextContact?.id && !Array.isArray(data.opportunities)) {
        try {
          const opportunitiesResponse = await fetch(`/api/contacts/${nextContact.id}/leads`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: controller.signal,
          })
          const opportunitiesData = await opportunitiesResponse.json().catch(() => null)
          if (!opportunitiesResponse.ok || !opportunitiesData?.success) throw new Error(opportunitiesData?.error || 'No se pudieron cargar las oportunidades.')
          nextOpportunities = opportunitiesData.leads || []
        } catch (error) {
          if (controller.signal.aborted) return
          // Keep the preferred opportunity as a fallback, but communicate partial data.
          setOpportunitiesError(error instanceof Error ? error.message : 'No se pudieron cargar las oportunidades.')
        }
      }
      if (activeChatIdRef.current !== targetChatId || controller.signal.aborted) return
      setOpportunities(nextOpportunities)
      const preferredId = selectedOpportunityIdRef.current || data.active_opportunity_id || data.lead?.id
      const selectedSummary = nextOpportunities.find(item => item.id === preferredId)
        || nextOpportunities.find(item => item.status === 'open' && !item.is_archived && !item.deleted_at)
        || nextOpportunities[0]
        || null
      selectedOpportunityIdRef.current = selectedSummary?.id || null
      if (!selectedSummary) {
        setLead(null)
      } else if (data.lead?.id === selectedSummary.id) {
        // `opportunities` contains compact selector summaries. Only the legacy
        // `lead` field (or the scoped endpoint below) is complete enough for
        // LeadDetailPanel and its edit actions.
        setLead({ ...selectedSummary, ...data.lead })
      } else {
        setLead(null)
        setLoadingOpportunity(true)
        try {
          const opportunityResponse = await fetch(`/api/chats/${targetChatId}/opportunities/${selectedSummary.id}`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: controller.signal,
          })
          const opportunityData = await opportunityResponse.json().catch(() => null)
          if (!opportunityResponse.ok || !opportunityData?.success || !opportunityData.lead) throw new Error(opportunityData?.error || 'No se pudo abrir la oportunidad.')
          if (activeChatIdRef.current !== targetChatId || selectedOpportunityIdRef.current !== selectedSummary.id) return
          setLead(opportunityData.lead)
          setOpportunities(current => current.map(item => item.id === selectedSummary.id ? { ...item, ...opportunityData.lead } : item))
        } catch (error) {
          if (!controller.signal.aborted && activeChatIdRef.current === targetChatId) {
            setOpportunitySelectionError({
              opportunityId: selectedSummary.id,
              message: error instanceof Error ? error.message : 'No se pudo abrir la oportunidad.',
            })
          }
        } finally {
          if (!controller.signal.aborted && activeChatIdRef.current === targetChatId) setLoadingOpportunity(false)
        }
      }
    } catch (err) {
      if (controller.signal.aborted) return
      console.error('Failed to fetch chat details:', err)
      if (activeChatIdRef.current === targetChatId) setDetailsError(err instanceof Error ? err.message : 'No se pudieron cargar los detalles del chat.')
    } finally {
      if (activeChatIdRef.current === targetChatId && !controller.signal.aborted) {
        setLoading(false)
      }
    }
  }

  const selectOpportunity = async (opportunityId: string, force = false) => {
    if (!force && opportunityId === lead?.id) return
    const targetChatId = activeChatIdRef.current
    if (!targetChatId) return
    const previousId = lead?.id || null
    opportunityAbortRef.current?.abort()
    const controller = new AbortController()
    opportunityAbortRef.current = controller
    selectedOpportunityIdRef.current = opportunityId
    setLoadingOpportunity(true)
    setOpportunitySelectionError(null)
    try {
      const response = await fetch(`/api/chats/${targetChatId}/opportunities/${opportunityId}`, {
        headers: { Authorization: `Bearer ${getToken()}` },
        signal: controller.signal,
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.success || !data.lead) throw new Error(data?.error || 'No se pudo abrir la oportunidad.')
      if (controller.signal.aborted || activeChatIdRef.current !== targetChatId || selectedOpportunityIdRef.current !== opportunityId) return
      setLead(data.lead)
      setOpportunities(current => current.map(item => item.id === opportunityId ? { ...item, ...data.lead } : item))
    } catch (error) {
      if (controller.signal.aborted || activeChatIdRef.current !== targetChatId || selectedOpportunityIdRef.current !== opportunityId) return
      selectedOpportunityIdRef.current = previousId
      setOpportunitySelectionError({
        opportunityId,
        message: error instanceof Error ? error.message : 'No se pudo abrir la oportunidad.',
      })
    } finally {
      if (!controller.signal.aborted && activeChatIdRef.current === targetChatId) {
        opportunityAbortRef.current = null
        setLoadingOpportunity(false)
      }
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
	const targetChatId = activeChatIdRef.current
	const targetContactId = contact.id
	const epoch = mutationEpochRef.current
	if (!targetChatId) return
	nameMutationAbortRef.current?.abort()
	const controller = new AbortController()
	nameMutationAbortRef.current = controller
    setSavingName(true)
    try {
      const token = localStorage.getItem('token')
      const res = await fetch(`/api/contacts/${contact.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ custom_name: editNameValue.trim() }),
		signal: controller.signal,
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.success || !data.contact) throw new Error(data?.error || 'No se pudo actualizar el nombre.')
	  if (controller.signal.aborted || mutationEpochRef.current !== epoch || activeChatIdRef.current !== targetChatId || data.contact.id !== targetContactId) return
	  setContact(data.contact)
    } catch (err) {
	  if (!controller.signal.aborted && mutationEpochRef.current === epoch && activeChatIdRef.current === targetChatId) console.error('Failed to save contact name:', err)
    } finally {
	  if (mutationEpochRef.current === epoch && activeChatIdRef.current === targetChatId) {
		setSavingName(false)
		setEditingName(false)
	  }
    }
  }

  const createOpportunity = async () => {
    if (!contact || !newOpportunityTitle.trim() || creatingOpportunity) return
	const targetChatId = activeChatIdRef.current
	const targetContactId = contact.id
	const epoch = mutationEpochRef.current
	if (!targetChatId) return
	createMutationAbortRef.current?.abort()
	const controller = new AbortController()
	createMutationAbortRef.current = controller
    setCreatingOpportunity(true)
    setCreateOpportunityError('')
    try {
      const response = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({
		  contact_id: targetContactId,
          title: newOpportunityTitle.trim(),
          source: 'whatsapp',
        }),
		signal: controller.signal,
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.success) throw new Error(data?.error || 'No se pudo crear la oportunidad.')
	  if (controller.signal.aborted || mutationEpochRef.current !== epoch || activeChatIdRef.current !== targetChatId) return
	  selectedOpportunityIdRef.current = data.lead?.id || null
      setShowCreateOpportunity(false)
	  await fetchDetails(targetChatId)
    } catch (error) {
	  if (!controller.signal.aborted && mutationEpochRef.current === epoch && activeChatIdRef.current === targetChatId) setCreateOpportunityError(error instanceof Error ? error.message : 'No se pudo crear la oportunidad.')
    } finally {
	  if (mutationEpochRef.current === epoch && activeChatIdRef.current === targetChatId) setCreatingOpportunity(false)
    }
  }

  const cleanName = (name?: string | null) => name?.replace(/^[\s.·•\-]+/, '').trim() || ''
  const displayName = cleanName(contact?.custom_name) || cleanName(contact?.name) || cleanName(contact?.push_name) || cleanName(lead?.name) || 'Número sin vincular'
  const avatarUrl = contact?.avatar_url
  const actualDeviceName = cleanName(chatDevice?.name) || deviceName || 'Dispositivo WhatsApp'
  const actualDevicePhone = cleanName(chatDevice?.phone) || devicePhone || ''
  const fmtDevicePhone = actualDevicePhone ? (actualDevicePhone.startsWith('+') ? actualDevicePhone : '+' + actualDevicePhone) : ''
  const deviceProvider = chatDevice?.provider === 'whatsapp_cloud_api'
    ? 'WhatsApp Cloud API'
    : chatDevice?.provider === 'whatsapp_web' || (!chatDevice?.provider && chatDevice)
      ? 'WhatsApp Web'
      : chatDevice?.provider || ''
  const displayPhone = contact?.phone
    ? (contact.phone.startsWith('+') ? contact.phone : '+' + contact.phone)
    : chatPhone || ''
  const opportunityStatus = (opportunity: Lead) => {
    if (opportunity.deleted_at) return { label: 'Papelera', className: 'border-red-200 bg-red-50 text-red-700' }
    if (opportunity.is_archived) return { label: 'Archivada', className: 'border-amber-200 bg-amber-50 text-amber-700' }
    if (opportunity.status === 'won') return { label: 'Ganada', className: 'border-emerald-200 bg-emerald-50 text-emerald-700' }
    if (opportunity.status === 'lost') return { label: 'Perdida', className: 'border-rose-200 bg-rose-50 text-rose-700' }
    return { label: 'Abierta', className: 'border-blue-200 bg-blue-50 text-blue-700' }
  }
  const opportunityComposer = (
    <div className="mx-3 mb-3 rounded-2xl border border-emerald-200 bg-emerald-50/50 p-3 text-left">
      <label htmlFor="new-chat-opportunity-title" className="mb-1.5 block text-xs font-bold text-slate-700">Concepto de la oportunidad</label>
      <input id="new-chat-opportunity-title" autoFocus value={newOpportunityTitle} onChange={event => { setNewOpportunityTitle(event.target.value); setCreateOpportunityError('') }} onKeyDown={event => { if (event.key === 'Enter') void createOpportunity(); if (event.key === 'Escape') setShowCreateOpportunity(false) }} maxLength={160} className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100" />
      {createOpportunityError && <p className="mt-2 text-xs font-medium text-red-700" role="alert">{createOpportunityError}</p>}
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={() => setShowCreateOpportunity(false)} disabled={creatingOpportunity} className="min-h-10 rounded-xl px-3 text-xs font-semibold text-slate-600 hover:bg-emerald-100 disabled:opacity-50">Cancelar</button>
        <button type="button" onClick={() => void createOpportunity()} disabled={creatingOpportunity || !newOpportunityTitle.trim()} className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-emerald-600 px-3 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-50">{creatingOpportunity && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{creatingOpportunity ? 'Creando…' : 'Crear'}</button>
      </div>
    </div>
  )
  const selectedOpportunity = lead || opportunities.find(opportunity => opportunity.id === selectedOpportunityIdRef.current) || opportunities[0] || null
  const opportunityContext = (opportunity: Lead) => {
    const pipeline = opportunity.lead_pipeline_name || opportunity.pipeline_name
    const stage = opportunity.lead_stage_name || opportunity.stage_name
    return [pipeline, stage].filter(Boolean).join(' · ') || 'Sin pipeline ni etapa'
  }
  const selectedOpportunityStatus = selectedOpportunity ? opportunityStatus(selectedOpportunity) : null

  return (
    <div className="flex h-full w-full flex-col border-l border-slate-200 bg-white">
      <div className="flex min-h-[64px] shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4">
        <div>
          <h3 className="text-base font-bold text-slate-900">Detalles</h3>
          <p className="text-[11px] text-slate-500">Contacto y contexto comercial</p>
        </div>
        <button type="button" onClick={onClose} className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label="Cerrar detalles">
          <X className="h-5 w-5" />
        </button>
      </div>

      {loading ? (
        <div className="flex-1 space-y-4 overflow-hidden p-4" aria-label="Cargando detalles">
          <div className="flex animate-pulse items-center gap-3 rounded-2xl border border-slate-100 p-3">
            <div className="h-12 w-12 rounded-full bg-slate-100" />
            <div className="flex-1 space-y-2"><div className="h-4 w-2/3 rounded bg-slate-100" /><div className="h-3 w-1/2 rounded bg-slate-100" /></div>
          </div>
          <div className="h-11 animate-pulse rounded-xl bg-slate-100" />
          <div className="h-48 animate-pulse rounded-2xl bg-slate-100" />
        </div>
      ) : detailsError && !contact && opportunities.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-red-50 text-red-600"><AlertCircle className="h-6 w-6" /></div>
          <h4 className="mt-4 text-sm font-bold text-slate-900">No pudimos cargar los detalles</h4>
          <p className="mt-1 max-w-xs text-xs leading-relaxed text-slate-500">{detailsError}</p>
          <button type="button" onClick={() => void fetchDetails()} className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-xl bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2">
            <RefreshCw className="h-4 w-4" /> Reintentar
          </button>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="border-b border-slate-200 px-4 py-4">
            <div className="flex items-center gap-3">
              {contact ? (
                <ContactAvatarControl
                  contactId={contact.id}
                  contextType="chat"
                  contextId={chatId}
                  displayName={displayName}
                  avatarUrl={avatarUrl}
                  compact
                  onChange={updated => setContact(current => current ? { ...current, avatar_url: updated.avatar_url || undefined } : current)}
                />
              ) : (
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-emerald-50 ring-1 ring-emerald-100">
                  <User className="h-5 w-5 text-emerald-700" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="group/name flex min-w-0 items-center gap-1.5">
                  {editingName ? (
                    <>
                      <input
                        ref={nameInputRef}
                        value={editNameValue}
                        onChange={event => setEditNameValue(event.target.value)}
                        onKeyDown={event => { if (event.key === 'Enter') void saveCustomName(); if (event.key === 'Escape') setEditingName(false) }}
                        disabled={savingName}
                        className="h-9 min-w-0 flex-1 rounded-lg border border-emerald-300 px-2 text-sm font-semibold text-slate-900 outline-none focus:ring-2 focus:ring-emerald-100"
                        aria-label="Nombre del contacto"
                      />
                      <button type="button" onClick={() => void saveCustomName()} disabled={savingName} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-emerald-700 hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label="Guardar nombre">
                        {savingName ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                      </button>
                    </>
                  ) : (
                    <>
                      <p className="truncate text-sm font-bold text-slate-900">{displayName}</p>
                      {contact && (
                        <button type="button" onClick={startEditingName} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 opacity-100 hover:bg-slate-100 hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 sm:opacity-0 sm:group-hover/name:opacity-100 sm:focus:opacity-100" aria-label="Editar nombre">
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </>
                  )}
                </div>
                {displayPhone && <p className="mt-0.5 truncate text-xs font-medium text-slate-500">{displayPhone}</p>}
              </div>
              {contact?.do_not_contact && <span className="shrink-0 rounded-full border border-red-200 bg-red-50 px-2 py-1 text-[10px] font-bold text-red-700">No contactar</span>}
            </div>
            {(chatDevice || deviceName || fmtDevicePhone) && (
              <div className="mt-3 flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                <Smartphone className="h-4 w-4 shrink-0 text-slate-400" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-semibold text-slate-700">{actualDeviceName}</p>
                  {(fmtDevicePhone || deviceProvider) && <p className="truncate text-[10px] text-slate-500">{[fmtDevicePhone, deviceProvider].filter(Boolean).join(' · ')}</p>}
                </div>
                {chatDevice?.status && <span className={`shrink-0 rounded-full px-2 py-1 text-[9px] font-bold ${chatDevice.status === 'connected' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}>{chatDevice.status === 'connected' ? 'Conectado' : 'No disponible'}</span>}
              </div>
            )}
          </div>

          <div>
            {detailsError && (
              <div className="mx-4 mt-3 flex shrink-0 items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800" role="status">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1">{detailsError}</span>
                <button type="button" onClick={() => void fetchDetails()} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500" aria-label="Reintentar"><RefreshCw className="h-3.5 w-3.5" /></button>
              </div>
            )}

            {!contact ? (
              <div className="flex min-h-[320px] flex-col items-center justify-center px-6 py-10 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-500"><User className="h-6 w-6" /></div>
                <h4 className="mt-4 text-sm font-bold text-slate-900">Número sin vincular</h4>
                <p className="mt-1 max-w-xs text-xs leading-relaxed text-slate-500">Esta conversación todavía no está asociada a una ficha de contacto del CRM.</p>
                {!showContactLinker ? (
                  <button type="button" onClick={openContactLinker} className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"><Plus className="h-4 w-4" /> Crear o vincular contacto</button>
                ) : (
                  <div className="mt-5 w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-3 text-left shadow-sm">
                    <label htmlFor="chat-contact-search" className="text-xs font-bold text-slate-700">Buscar contacto existente</label>
                    <div className="relative mt-1.5">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                      <input id="chat-contact-search" autoFocus value={contactSearch} onChange={event => setContactSearch(event.target.value)} placeholder="Nombre, organización o teléfono" className="h-11 w-full rounded-xl border border-slate-300 pl-9 pr-10 text-sm text-slate-800 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100" />
                      {contactSearchLoading && <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-emerald-600" aria-label="Buscando contactos" />}
                    </div>
                    {contactMatches.length > 0 && (
                      <div className="mt-2 max-h-48 space-y-1 overflow-y-auto" role="listbox" aria-label="Contactos encontrados">
                        {contactMatches.map(match => {
                          const matchName = cleanName(match.custom_name) || cleanName(match.name) || cleanName(match.push_name) || match.phone || 'Contacto sin nombre'
                          const pending = linkingContactId === match.id
                          return (
                            <button key={match.id} type="button" role="option" aria-selected="false" disabled={!!linkingContactId} onClick={() => void linkChatContact({ contact_id: match.id }, match.id)} className="flex min-h-12 w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-55">
                              {match.avatar_url ? <img src={match.avatar_url} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" /> : <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500"><User className="h-4 w-4" /></span>}
                              <span className="min-w-0 flex-1"><span className="block truncate text-xs font-bold text-slate-800">{matchName}</span><span className="block truncate text-[10px] text-slate-500">{[match.phone ? (match.phone.startsWith('+') ? match.phone : `+${match.phone}`) : '', match.company].filter(Boolean).join(' · ')}</span></span>
                              {pending ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-emerald-600" /> : <Check className="h-4 w-4 shrink-0 text-emerald-600" />}
                            </button>
                          )
                        })}
                      </div>
                    )}
                    {contactSearch.trim().length >= 2 && !contactSearchLoading && contactMatches.length === 0 && !contactLinkError && <p className="mt-2 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-500">No encontramos coincidencias. Puedes crear la ficha debajo.</p>}
                    <div className="my-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-slate-400"><span className="h-px flex-1 bg-slate-200" /> o crear uno nuevo <span className="h-px flex-1 bg-slate-200" /></div>
                    <label htmlFor="chat-new-contact-name" className="text-xs font-bold text-slate-700">Nombre del contacto</label>
                    <input id="chat-new-contact-name" value={newContactName} onChange={event => { setNewContactName(event.target.value); setContactLinkError('') }} onKeyDown={event => { if (event.key === 'Enter' && newContactName.trim()) void linkChatContact({ name: newContactName.trim() }, 'new') }} maxLength={160} placeholder="Ej. María López" className="mt-1.5 h-11 w-full rounded-xl border border-slate-300 px-3 text-sm text-slate-800 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100" />
                    {contactLinkError && <p className="mt-2 rounded-xl bg-red-50 px-3 py-2 text-xs font-medium text-red-700" role="alert">{contactLinkError}</p>}
                    <div className="mt-3 flex justify-end gap-2">
                      <button type="button" onClick={() => setShowContactLinker(false)} disabled={!!linkingContactId} className="min-h-10 rounded-xl px-3 text-xs font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-50">Cancelar</button>
                      <button type="button" onClick={() => void linkChatContact({ name: newContactName.trim() }, 'new')} disabled={!newContactName.trim() || !!linkingContactId} className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-emerald-600 px-3 text-xs font-bold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-45">{linkingContactId === 'new' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{linkingContactId === 'new' ? 'Creando…' : 'Crear y vincular'}</button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <>
                <div className="divide-y divide-slate-100 border-b border-slate-200 bg-white">
                  {(contact.email || contact.company || contact.age) && (
                    <section className="space-y-2 px-4 py-3" aria-labelledby="contact-information-title">
                      <h5 id="contact-information-title" className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Datos del contacto</h5>
                      {contact.email && <div className="flex items-center gap-2 text-sm text-slate-700"><Mail className="h-4 w-4 shrink-0 text-slate-400" /><span className="truncate">{contact.email}</span></div>}
                      {contact.company && <div className="flex items-center gap-2 text-sm text-slate-700"><Building2 className="h-4 w-4 shrink-0 text-slate-400" /><span className="truncate">{contact.company}</span></div>}
                      {contact.age && <div className="flex items-center gap-2 text-sm text-slate-700"><Cake className="h-4 w-4 shrink-0 text-slate-400" /><span>{contact.age} años</span></div>}
                    </section>
                  )}
                  <section className="space-y-2 px-4 py-3" aria-labelledby="contact-notes-title">
                    <div className="flex items-center gap-1.5"><FileText className="h-3.5 w-3.5 text-slate-400" /><h5 id="contact-notes-title" className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Notas del contacto</h5></div>
                    <p className={`whitespace-pre-wrap text-xs leading-5 ${contact.notes?.trim() ? 'text-slate-700' : 'italic text-slate-400'}`}>{contact.notes?.trim() || 'Sin notas registradas en la ficha del contacto.'}</p>
                  </section>
                  <section className="px-4 py-3" aria-labelledby="contact-tags-title">
                    <div className="mb-2 flex items-center gap-1.5"><Tag className="h-3.5 w-3.5 text-slate-400" /><h5 id="contact-tags-title" className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Etiquetas del contacto</h5></div>
                    <TagInput entityType="contact" entityId={contact.id} assignedTags={contact.structured_tags || []} onTagsChange={newTags => setContact(current => current ? { ...current, structured_tags: newTags } : current)} />
                  </section>
                  <section className="px-4 py-3">
                    {contact.do_not_contact ? (
                      <div className="rounded-xl border border-red-200 bg-red-50 p-3">
                        <div className="flex items-start gap-2"><ShieldBan className="mt-0.5 h-4 w-4 shrink-0 text-red-600" /><div className="min-w-0 flex-1"><p className="text-xs font-bold text-red-900">No contactar</p><p className="mt-0.5 text-xs leading-relaxed text-red-700">{contact.do_not_contact_reason || 'Este contacto no debe recibir mensajes.'}</p></div></div>
                        <button type="button" onClick={() => void handleUnblock()} className="mt-2 inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-xl border border-red-200 bg-white px-3 text-xs font-semibold text-red-700 hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"><ShieldOff className="h-4 w-4" /> Permitir contacto</button>
                      </div>
                    ) : (
                      <button type="button" onClick={openBlockModal} className="inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 hover:border-red-200 hover:bg-red-50 hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"><ShieldBan className="h-4 w-4" /> Marcar como no contactable</button>
                    )}
                  </section>
                </div>

                <div className="flex min-h-12 shrink-0 items-center justify-between gap-3 border-b border-slate-200 bg-slate-50/70 px-4 py-2">
                  <div className="flex min-w-0 items-center gap-2"><BriefcaseBusiness className="h-4 w-4 shrink-0 text-emerald-700" /><div><h4 className="text-xs font-bold text-slate-800">Contexto comercial</h4><p className="text-[10px] text-slate-500">{opportunities.length} oportunidad{opportunities.length === 1 ? '' : 'es'}</p></div></div>
                  <button type="button" onClick={() => setShowCreateOpportunity(value => !value)} className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-xl border border-emerald-200 bg-white px-3 text-xs font-bold text-emerald-700 hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"><Plus className="h-3.5 w-3.5" /> Crear</button>
                </div>

                {showCreateOpportunity && opportunityComposer}

                {opportunitiesError && opportunities.length === 0 ? (
                  <div className="flex min-h-64 flex-col items-center justify-center px-6 py-8 text-center">
                    <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-50 text-amber-700"><AlertCircle className="h-5 w-5" /></div>
                    <h4 className="mt-3 text-sm font-bold text-slate-900">No pudimos cargar las oportunidades</h4>
                    <p className="mt-1 max-w-xs text-xs leading-relaxed text-slate-500">{opportunitiesError}</p>
                    <button type="button" onClick={() => void fetchDetails()} className="mt-3 inline-flex min-h-10 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"><RefreshCw className="h-4 w-4" /> Reintentar</button>
                  </div>
                ) : opportunities.length === 0 ? (
                  <div className="flex min-h-56 flex-col items-center justify-center px-5 py-8 text-center">
                    <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-700"><BriefcaseBusiness className="h-5 w-5" /></div>
                    <h4 className="mt-3 text-sm font-bold text-slate-900">Sin oportunidades</h4>
                    <p className="mt-1 max-w-xs text-xs leading-relaxed text-slate-500">Los datos personales ya pertenecen al contacto. Crea una oportunidad solo cuando exista un proceso comercial.</p>
                  </div>
                ) : (
                  <>
                  <div className="space-y-3 border-b border-slate-200 bg-slate-50/60 p-3" aria-label="Selector de oportunidad">
                    {opportunitySelectionError && (
                      <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] leading-relaxed text-rose-800" role="alert">
                        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span className="min-w-0 flex-1">{opportunitySelectionError.message}</span>
                        <button
                          type="button"
                          onClick={() => void selectOpportunity(opportunitySelectionError.opportunityId, true)}
                          disabled={loadingOpportunity}
                          className="inline-flex min-h-7 shrink-0 items-center gap-1 rounded-lg px-2 font-bold hover:bg-rose-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 disabled:opacity-50"
                        >
                          <RefreshCw className={`h-3 w-3 ${loadingOpportunity ? 'animate-spin' : ''}`} /> Reintentar
                        </button>
                      </div>
                    )}
                    {opportunitiesError && (
                      <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800" role="status">
                        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span className="min-w-0 flex-1">Mostrando la oportunidad disponible. {opportunitiesError}</span>
                        <button type="button" onClick={() => void fetchDetails()} className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg hover:bg-amber-100" aria-label="Reintentar"><RefreshCw className="h-3 w-3" /></button>
                      </div>
                    )}
                    {opportunities.length > 1 ? (
                      <label className="block">
                        <span className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-slate-500">Oportunidad que estás viendo</span>
                        <span className="relative block">
                          <select
                            value={selectedOpportunity?.id || ''}
                            onChange={event => void selectOpportunity(event.target.value)}
                            disabled={loadingOpportunity}
                            className="h-11 w-full appearance-none rounded-xl border border-slate-300 bg-white px-3 pr-10 text-xs font-semibold text-slate-800 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 disabled:cursor-wait disabled:opacity-65"
                          >
                            {opportunities.map(opportunity => {
                              const status = opportunityStatus(opportunity)
                              return <option key={opportunity.id} value={opportunity.id}>{opportunity.title || 'Oportunidad sin título'} · {opportunityContext(opportunity)} · {status.label}</option>
                            })}
                          </select>
                          {loadingOpportunity ? <Loader2 className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-emerald-600" /> : <BriefcaseBusiness className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />}
                        </span>
                      </label>
                    ) : selectedOpportunity ? (
                      <div className="rounded-xl border border-emerald-200 bg-white px-3 py-2.5 shadow-sm">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-xs font-bold text-slate-900">{selectedOpportunity.title || 'Oportunidad sin título'}</p>
                            <p className="mt-1 truncate text-[10px] text-slate-500">{opportunityContext(selectedOpportunity)}</p>
                          </div>
                          {selectedOpportunityStatus && <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-bold ${selectedOpportunityStatus.className}`}>{selectedOpportunityStatus.label}</span>}
                        </div>
                      </div>
                    ) : null}
                    {opportunities.length > 1 && selectedOpportunity && (
                      <div className="flex items-center justify-between gap-3 px-1 text-[10px] text-slate-500">
                        <span className="min-w-0 truncate">{opportunityContext(selectedOpportunity)}</span>
                        {selectedOpportunityStatus && <span className={`shrink-0 rounded-full border px-2 py-0.5 font-bold ${selectedOpportunityStatus.className}`}>{selectedOpportunityStatus.label}</span>}
                      </div>
                    )}
                  </div>
                  {lead ? (
                    <div className="relative">
                      {loadingOpportunity && <div className="absolute inset-0 z-10 flex items-start justify-center bg-white/70 pt-20"><Loader2 className="h-6 w-6 animate-spin text-emerald-600" aria-label="Abriendo oportunidad" /></div>}
                      <LeadDetailPanel
                        lead={lead}
                        onLeadChange={updatedLead => { setLead(updatedLead); setOpportunities(current => current.map(item => item.id === updatedLead.id ? updatedLead : item)) }}
                        onClose={onClose}
                        hideHeader={true}
                        hideIdentity={true}
                        commercialOnly={true}
                        parentOwnsScroll={true}
                        hideWhatsApp={true}
                        hideDelete={false}
                        onDelete={() => { setOpportunities(current => current.filter(item => item.id !== lead.id)); selectedOpportunityIdRef.current = null; setLead(null); void fetchDetails() }}
                        onArchive={(leadId: string, archive: boolean) => { if (archive) openArchiveModal(leadId); else void handleRestoreLead(leadId) }}
                        onStageChangeRequest={requestOpportunityStageChange}
                        className="border-b border-slate-200"
                      />
                    </div>
                  ) : (
                    <div className="flex flex-1 items-center justify-center text-xs text-slate-500">Selecciona una oportunidad.</div>
                  )}
                  </>
                )}
              </>
            )}
          </div>
        </div>
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
        <div className="fixed inset-0 z-[85] flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-sm" onMouseDown={event => { if (event.target === event.currentTarget) closeArchiveModal() }}>
          <div ref={archiveDialogRef} role="dialog" aria-modal="true" aria-labelledby="chat-archive-title" aria-describedby="chat-archive-description" tabIndex={-1} className="flex max-h-[min(90vh,680px)] w-full max-w-md flex-col overflow-hidden rounded-3xl bg-white shadow-2xl">
            <div className="flex items-start gap-3 border-b border-slate-200 px-5 py-5 sm:px-6">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-amber-50 text-amber-700"><Archive className="h-5 w-5" /></div>
              <div className="min-w-0 flex-1">
                <h3 id="chat-archive-title" className="text-lg font-bold text-slate-900">Archivar oportunidad</h3>
                <p id="chat-archive-description" className="mt-1 text-sm leading-relaxed text-slate-500">La oportunidad dejará de aparecer entre las activas. El contacto, este chat y su historial se conservarán.</p>
              </div>
              <button type="button" onClick={closeArchiveModal} disabled={savingArchive} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:opacity-50" aria-label="Cerrar"><X className="h-5 w-5" /></button>
            </div>
            <div className="space-y-2 overflow-y-auto px-5 py-5 sm:px-6">
              <p className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">Motivo del archivo</p>
              {ARCHIVE_OPPORTUNITY_REASONS.map(reason => (
                <button type="button" key={reason} onClick={() => { setArchiveReason(reason); setArchiveError('') }} disabled={savingArchive} className={`min-h-11 w-full rounded-xl px-4 py-2.5 text-left text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${archiveReason === reason ? 'bg-amber-50 font-semibold text-amber-800 ring-1 ring-amber-200' : 'text-slate-700 hover:bg-slate-50'}`} aria-pressed={archiveReason === reason}>
                  {reason}
                </button>
              ))}
              <div className="pt-2">
                <label htmlFor="chat-archive-other" className="sr-only">Otro motivo</label>
                <input id="chat-archive-other" type="text" placeholder="Otro motivo…" disabled={savingArchive} value={!ARCHIVE_OPPORTUNITY_REASONS.includes(archiveReason) ? archiveReason : ''} onChange={(e) => { setArchiveReason(e.target.value); setArchiveError('') }} onFocus={() => { if (ARCHIVE_OPPORTUNITY_REASONS.includes(archiveReason)) setArchiveReason('') }} className="h-11 w-full rounded-xl border border-slate-300 px-4 text-sm focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-100 disabled:bg-slate-100" />
              </div>
              {archiveError && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm font-medium text-red-700" role="alert">{archiveError}</p>}
            </div>
            <div className="flex flex-col-reverse gap-2 border-t border-slate-200 bg-white px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
              <button ref={archiveCancelRef} type="button" onClick={closeArchiveModal} disabled={savingArchive} className="min-h-11 rounded-xl border border-slate-200 px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 disabled:opacity-50">Cancelar</button>
              <button type="button" onClick={() => void confirmArchive()} disabled={!archiveReason.trim() || savingArchive} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-amber-600 px-5 text-sm font-bold text-white transition hover:bg-amber-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-45">{savingArchive && <Loader2 className="h-4 w-4 animate-spin" />}{savingArchive ? 'Archivando…' : 'Archivar oportunidad'}</button>
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
