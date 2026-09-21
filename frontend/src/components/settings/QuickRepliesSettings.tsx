'use client'

import { createPortal } from 'react-dom'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  File,
  FileAudio,
  Image,
  Loader2,
  MoreVertical,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
  Video,
  X,
  Zap,
} from 'lucide-react'
import QuickReplySequenceEditor, { QuickReplySequencePreview } from '@/components/chat/QuickReplySequenceEditor'
import OperationalWindowShell from '@/components/operational-window/OperationalWindowShell'
import { subscribeWebSocket } from '@/lib/api'
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '@/lib/useDebouncedValue'
import type {
  QuickReply,
  QuickReplyAttachment,
  QuickReplyKind,
  QuickReplyItem,
  QuickReplyMutationResponse,
  QuickReplyPage,
  QuickReplyRealtimePayload,
} from '@/types/quick-reply'
import {
  getQuickReplyAttachments,
  getQuickReplyItems,
  quickReplyTextProjection,
  isValidQuickReplyShortcut,
  mergeQuickReplyPages,
  QUICK_REPLY_PAGE_SIZE,
  reconcileQuickReplyRealtime,
} from '@/utils/quickReplies'

type QuickReplyDraft = {
  id?: string
  updated_at?: string
  shortcut: string
  title: string
  body: string
  items: QuickReplyItem[]
  attachments: QuickReplyAttachment[]
}

type UploadTask = {
  id: string
  file: globalThis.File
  status: 'queued' | 'uploading' | 'error'
  error?: string
}

type ListState = {
  replies: QuickReply[]
  total: number
  hasMore: boolean
  nextCursor: string
}

type Notice = { type: 'success' | 'error'; text: string }

interface QuickRepliesSettingsProps {
  accountId?: string
  canManage: boolean
  onMessage?: (type: Notice['type'], text: string) => void
}

const EMPTY_LIST: ListState = { replies: [], total: 0, hasMore: false, nextCursor: '' }

function draftFromReply(reply?: QuickReply): QuickReplyDraft {
  return {
    id: reply?.id,
    updated_at: reply?.updated_at,
    shortcut: reply?.shortcut || '',
    title: reply?.title || '',
    body: reply?.body || '',
    items: reply ? getQuickReplyItems(reply).map(item => ({ ...item, id: crypto.randomUUID() })) : [{ id: crypto.randomUUID(), type: 'text', text: '' }],
    attachments: reply ? getQuickReplyAttachments(reply).map(item => ({ ...item })) : [],
  }
}

function draftFingerprint(draft: QuickReplyDraft | null) {
  if (!draft) return ''
  return JSON.stringify({
    shortcut: draft.shortcut,
    title: draft.title,
    items: draft.items,
    attachments: draft.attachments.map(({ id, media_asset_id, media_type, media_filename, caption, position }) => ({
      id: id || '',
      media_asset_id: media_asset_id || '',
      media_type,
      media_filename,
      caption,
      position,
    })),
  })
}

function formatUpdatedAt(value?: string) {
  if (!value) return 'Sin fecha'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return 'Sin fecha'
  return new Intl.DateTimeFormat('es-PE', { dateStyle: 'medium', timeStyle: 'short' }).format(parsed)
}

function mediaIcon(type: string, className = 'h-4 w-4') {
  if (type === 'image') return <Image className={className} aria-hidden />
  if (type === 'video') return <Video className={className} aria-hidden />
  if (type === 'audio') return <FileAudio className={className} aria-hidden />
  return <File className={className} aria-hidden />
}

function ConfirmationDialog({
  open,
  title,
  description,
  confirmLabel,
  destructive = false,
  busy = false,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  destructive?: boolean
  busy?: boolean
  error?: string
  onCancel: () => void
  onConfirm: () => void
}) {
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return
      event.preventDefault()
      onCancel()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [busy, onCancel, open])
  if (!open || typeof document === 'undefined') return null
  return createPortal(
    <div data-operational-confirmation className="fixed inset-0 z-[190] flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-[2px]" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onCancel() }}>
      <section role="alertdialog" aria-modal="true" aria-labelledby="quick-reply-confirm-title" className="w-full max-w-md rounded-3xl border border-white/70 bg-white p-5 shadow-2xl ring-1 ring-slate-900/10">
        <div className={`flex h-11 w-11 items-center justify-center rounded-2xl ${destructive ? 'bg-rose-50 text-rose-600' : 'bg-amber-50 text-amber-600'}`}>
          {destructive ? <Trash2 className="h-5 w-5" /> : <AlertCircle className="h-5 w-5" />}
        </div>
        <h3 id="quick-reply-confirm-title" className="mt-4 text-lg font-semibold text-slate-900">{title}</h3>
        <p className="mt-2 text-sm leading-6 text-slate-600">{description}</p>
        {error && <p role="alert" className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" disabled={busy} onClick={onCancel} className="min-h-11 rounded-xl px-4 text-sm font-bold text-slate-600 transition hover:bg-slate-100 disabled:opacity-40">Cancelar</button>
          <button type="button" disabled={busy} onClick={onConfirm} className={`inline-flex min-h-11 items-center gap-2 rounded-xl px-4 text-sm font-semibold text-white shadow-sm transition disabled:opacity-40 ${destructive ? 'bg-rose-600 hover:bg-rose-700' : 'bg-amber-500 hover:bg-amber-600'}`}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}{confirmLabel}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  )
}

export default function QuickRepliesSettings({ accountId, canManage, onMessage }: QuickRepliesSettingsProps) {
  const [list, setList] = useState<ListState>(EMPTY_LIST)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [listError, setListError] = useState('')
  const [loadingMore, setLoadingMore] = useState(false)
  const [filterLoading, setFilterLoading] = useState(false)
  const [rawSearch, setRawSearch] = useState('')
  const [settledSearch, setSettledSearch] = useDebouncedValue('', SEARCH_DEBOUNCE_MS)
  const [kind, setKind] = useState<QuickReplyKind>('all')
  const requestRef = useRef<AbortController | null>(null)
  const requestGenerationRef = useRef(0)

  const [selectedID, setSelectedID] = useState<string | null>(null)
  const [selectedSnapshot, setSelectedSnapshot] = useState<QuickReply | null>(null)
  const [windowMode, setWindowMode] = useState<'view' | 'edit' | 'create' | null>(null)
  const [draft, setDraft] = useState<QuickReplyDraft | null>(null)
  const [initialFingerprint, setInitialFingerprint] = useState('')
  const [saving, setSaving] = useState(false)
  const [editorError, setEditorError] = useState('')
  const [externalVersion, setExternalVersion] = useState<QuickReply | null>(null)
  const [externalDeleted, setExternalDeleted] = useState(false)
  const [discardOpen, setDiscardOpen] = useState(false)
  const [pendingAfterDiscard, setPendingAfterDiscard] = useState<{ mode: 'view' | 'edit' | 'create'; reply?: QuickReply } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<QuickReply | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [newAssetIDs, setNewAssetIDs] = useState<Set<string>>(() => new Set())
  const [uploadTasks, setUploadTasks] = useState<UploadTask[]>([])
  const editorSessionRef = useRef(0)
  useEffect(() => { editorSessionRef.current++; return () => { editorSessionRef.current++ } }, [accountId])
  const [menu, setMenu] = useState<{ reply: QuickReply; top: number; left: number } | null>(null)

  const selectedReply = useMemo(() => list.replies.find(reply => reply.id === selectedID) || selectedSnapshot, [list.replies, selectedID, selectedSnapshot])
  const currentFingerprint = useMemo(() => draftFingerprint(draft), [draft])
  const dirty = Boolean(draft && currentFingerprint !== initialFingerprint)
  const uploadBusy = uploadTasks.some(task => task.status === 'queued' || task.status === 'uploading')
  const searchPending = rawSearch.trim() !== settledSearch

  useEffect(() => {
    if (rawSearch.trim() === '') {
      setSettledSearch('')
      return
    }
    const timer = window.setTimeout(() => setSettledSearch(rawSearch.trim()), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [rawSearch, setSettledSearch])

  const fetchPage = useCallback(async ({ reset, cursor = '' }: { reset: boolean; cursor?: string }) => {
    if (!canManage) return
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    const generation = ++requestGenerationRef.current
    if (reset) {
      setFilterLoading(true)
      setListError('')
      setPhase(previous => previous === 'error' ? 'loading' : previous)
    } else {
      setLoadingMore(true)
    }
    try {
      const params = new URLSearchParams({ limit: String(QUICK_REPLY_PAGE_SIZE), kind })
      if (settledSearch) params.set('query', settledSearch)
      if (cursor) params.set('cursor', cursor)
      const token = localStorage.getItem('token')
      const response = await fetch(`/api/quick-replies?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      })
      const data = await response.json().catch(() => ({})) as Partial<QuickReplyPage>
      if (!response.ok || !data.success) throw new Error(data.error || 'No se pudieron cargar las respuestas rápidas.')
      if (controller.signal.aborted || generation !== requestGenerationRef.current) return
      const incoming = Array.isArray(data.quick_replies) ? data.quick_replies : []
      setList(previous => ({
        replies: reset ? mergeQuickReplyPages([], incoming) : mergeQuickReplyPages(previous.replies, incoming),
        total: typeof data.total === 'number' ? data.total : incoming.length,
        hasMore: Boolean(data.has_more),
        nextCursor: data.next_cursor || '',
      }))
      setPhase('ready')
    } catch (error) {
      if (controller.signal.aborted) return
      setListError(error instanceof Error ? error.message : 'No se pudieron cargar las respuestas rápidas.')
      setPhase('error')
    } finally {
      if (requestRef.current === controller) requestRef.current = null
      if (generation === requestGenerationRef.current) {
        setFilterLoading(false)
        setLoadingMore(false)
      }
    }
  }, [accountId, canManage, kind, settledSearch])

  useEffect(() => {
    if (!canManage) return
    void fetchPage({ reset: true })
    return () => requestRef.current?.abort()
  }, [canManage, fetchPage])

  useEffect(() => {
    if (!canManage) return
    return subscribeWebSocket((message: unknown) => {
      const event = message as { type?: string; event?: string; data?: QuickReplyRealtimePayload; message?: QuickReplyRealtimePayload }
      if ((event.type || event.event) !== 'quick_reply_update') return
      const payload = event.data || event.message
      if (!payload) return
      setList(previous => {
        const reconciled = reconcileQuickReplyRealtime(previous.replies, previous.total, payload, settledSearch, kind)
        return { ...previous, replies: reconciled.replies, total: reconciled.total }
      })
      const targetID = payload.quick_reply_id || payload.quick_reply?.id
      if (!targetID || targetID !== selectedID) return
      if (payload.action === 'deleted') {
        setExternalDeleted(true)
        return
      }
      if (!payload.quick_reply) return
      setSelectedSnapshot(payload.quick_reply)
      if (windowMode === 'edit' && dirty) {
        setExternalVersion(payload.quick_reply)
      } else if (windowMode === 'edit') {
        const nextDraft = draftFromReply(payload.quick_reply)
        setDraft(nextDraft)
        setInitialFingerprint(draftFingerprint(nextDraft))
      }
    })
  }, [canManage, dirty, kind, selectedID, settledSearch, windowMode])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    document.addEventListener('pointerdown', close)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('pointerdown', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [menu])

  const releaseDraftAsset = useCallback(async (assetID: string) => {
    const token = localStorage.getItem('token')
    try {
      await fetch(`/api/quick-replies/draft-media/${assetID}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
    } catch {
      // The durable inventory retention remains the cleanup fallback.
    }
  }, [])

  const newAssetIDsRef = useRef(newAssetIDs)
  useEffect(() => { newAssetIDsRef.current = newAssetIDs }, [newAssetIDs])
  useEffect(() => () => {
    for (const assetID of newAssetIDsRef.current) void releaseDraftAsset(assetID)
  }, [releaseDraftAsset])

  const closeImmediately = useCallback(() => {
    editorSessionRef.current++
    setWindowMode(null)
    setSelectedID(null)
    setSelectedSnapshot(null)
    setDraft(null)
    setInitialFingerprint('')
    setEditorError('')
    setExternalVersion(null)
    setExternalDeleted(false)
    setUploadTasks([])
    setNewAssetIDs(new Set())
  }, [])

  useEffect(() => { closeImmediately(); setList(EMPTY_LIST); setPhase('loading'); setSaving(false) }, [accountId, closeImmediately])

  const discardDraft = useCallback(() => {
    const assets = Array.from(newAssetIDs)
    const pending = pendingAfterDiscard
    setDiscardOpen(false)
    closeImmediately()
    for (const assetID of assets) void releaseDraftAsset(assetID)
    if (pending?.mode === 'create') {
      const nextDraft = draftFromReply()
      setWindowMode('create')
      setDraft(nextDraft)
      setInitialFingerprint(draftFingerprint(nextDraft))
    } else if (pending?.reply && pending.mode === 'view') {
      setSelectedID(pending.reply.id)
      setSelectedSnapshot(pending.reply)
      setWindowMode('view')
    } else if (pending?.reply && pending.mode === 'edit') {
      const nextDraft = draftFromReply(pending.reply)
      setSelectedID(pending.reply.id)
      setSelectedSnapshot(pending.reply)
      setWindowMode('edit')
      setDraft(nextDraft)
      setInitialFingerprint(draftFingerprint(nextDraft))
    }
    setPendingAfterDiscard(null)
  }, [closeImmediately, newAssetIDs, pendingAfterDiscard, releaseDraftAsset])

  const requestClose = useCallback(() => {
    if (saving || uploadBusy) return
    if (dirty) {
      setPendingAfterDiscard(null)
      setDiscardOpen(true)
      return
    }
    closeImmediately()
  }, [closeImmediately, dirty, saving, uploadBusy])

  const openView = (reply: QuickReply) => {
    if (dirty) {
      setPendingAfterDiscard({ mode: 'view', reply })
      setDiscardOpen(true)
      return
    }
    setSelectedID(reply.id)
    setSelectedSnapshot(reply)
    setWindowMode('view')
    setDraft(null)
    setEditorError('')
    setExternalVersion(null)
    setExternalDeleted(false)
  }

  const openEditor = (reply: QuickReply) => {
    if (dirty) {
      setPendingAfterDiscard({ mode: 'edit', reply })
      setDiscardOpen(true)
      return
    }
    const nextDraft = draftFromReply(reply)
    setSelectedID(reply.id)
    setSelectedSnapshot(reply)
    setWindowMode('edit')
    setDraft(nextDraft)
    setInitialFingerprint(draftFingerprint(nextDraft))
    setEditorError('')
    setExternalVersion(null)
    setExternalDeleted(false)
    setNewAssetIDs(new Set())
    setUploadTasks([])
  }

  const openCreate = () => {
    if (dirty) {
      setPendingAfterDiscard({ mode: 'create' })
      setDiscardOpen(true)
      return
    }
    const nextDraft = draftFromReply()
    setSelectedID(null)
    setSelectedSnapshot(null)
    setWindowMode('create')
    setDraft(nextDraft)
    setInitialFingerprint(draftFingerprint(nextDraft))
    setEditorError('')
    setExternalVersion(null)
    setExternalDeleted(false)
    setNewAssetIDs(new Set())
    setUploadTasks([])
  }

  const runUpload = async (task: UploadTask) => {
    const editorSession = editorSessionRef.current
    setUploadTasks(previous => previous.map(item => item.id === task.id ? { ...item, status: 'uploading', error: undefined } : item))
    try {
      let file = task.file
      if (file.type.startsWith('image/') && !file.type.includes('gif')) {
        const { compressImageStandard } = await import('@/utils/imageCompression')
        file = await compressImageStandard(file)
      }
      const formData = new FormData()
      formData.append('file', file)
      formData.append('folder', 'quick-reply-drafts')
      const token = localStorage.getItem('token')
      const response = await fetch('/api/media/upload', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: formData })
      const data = await response.json().catch(() => ({})) as { success?: boolean; media_asset_id?: string; proxy_url?: string; public_url?: string; error?: string }
      const mediaURL = data.proxy_url || data.public_url
      if (!response.ok || !data.success || !data.media_asset_id || !mediaURL) throw new Error(data.error || `No se pudo subir ${task.file.name}.`)
      if (editorSession !== editorSessionRef.current) return
      const mediaType = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'document'
      const assetID = String(data.media_asset_id)
      const attachmentID = crypto.randomUUID()
      setNewAssetIDs(previous => new Set(previous).add(assetID))
      setDraft(previous => previous ? {
        ...previous,
        items: [...previous.items, { id: crypto.randomUUID(), type: 'media', attachment_id: attachmentID }],
        attachments: [...previous.attachments, {
          id: attachmentID,
          media_asset_id: assetID,
          media_url: mediaURL,
          media_type: mediaType,
          media_filename: task.file.name,
          caption: '',
          position: previous.attachments.length,
        }],
      } : previous)
      setUploadTasks(previous => previous.filter(item => item.id !== task.id))
    } catch (error) {
      if (editorSession !== editorSessionRef.current) return
      setUploadTasks(previous => previous.map(item => item.id === task.id ? {
        ...item,
        status: 'error',
        error: error instanceof Error ? error.message : `No se pudo subir ${task.file.name}.`,
      } : item))
    }
  }

  const addUploadFiles = async (files: FileList | null) => {
    if (!files || !draft) return
    const available = Math.max(0, Math.min(5 - draft.attachments.length - uploadTasks.length, 20 - draft.items.length - uploadTasks.length))
    const selected = Array.from(files).slice(0, available)
    if (selected.length === 0) {
      setEditorError('Cada respuesta rápida puede incluir como máximo 5 adjuntos.')
      return
    }
    const tasks = selected.map((file, index): UploadTask => ({ id: `${Date.now()}-${index}-${file.name}`, file, status: 'queued' }))
    setUploadTasks(previous => [...previous, ...tasks])
    for (const task of tasks) await runUpload(task)
  }

  const removeAttachment = (index: number) => {
    if (!draft || saving || uploadBusy) return
    const removed = draft.attachments[index]
    setDraft({
      ...draft,
      items: draft.items.filter(item => item.attachment_id !== removed?.id),
      attachments: draft.attachments.filter((_, itemIndex) => itemIndex !== index).map((item, position) => ({ ...item, position })),
    })
    const assetID = removed?.media_asset_id || ''
    if (assetID && newAssetIDs.has(assetID) && !draft.attachments.some((item, itemIndex) => itemIndex !== index && item.media_asset_id === assetID)) {
      setNewAssetIDs(previous => {
        const next = new Set(previous)
        next.delete(assetID)
        return next
      })
      void releaseDraftAsset(assetID)
    }
  }

  const moveAttachment = (index: number, direction: -1 | 1) => {
    if (!draft) return
    const nextIndex = index + direction
    if (nextIndex < 0 || nextIndex >= draft.attachments.length) return
    const attachments = [...draft.attachments]
    ;[attachments[index], attachments[nextIndex]] = [attachments[nextIndex], attachments[index]]
    setDraft({ ...draft, attachments: attachments.map((item, position) => ({ ...item, position })) })
  }

  const findCanonicalReply = async (id: string) => {
    let cursor = ''
    const token = localStorage.getItem('token')
    for (let page = 0; page < 20; page += 1) {
      const params = new URLSearchParams({ limit: String(QUICK_REPLY_PAGE_SIZE), kind: 'all' })
      if (cursor) params.set('cursor', cursor)
      const response = await fetch(`/api/quick-replies?${params.toString()}`, { headers: { Authorization: `Bearer ${token}` } })
      const data = await response.json().catch(() => ({})) as Partial<QuickReplyPage>
      if (!response.ok || !data.success) return null
      const found = (data.quick_replies || []).find(reply => reply.id === id)
      if (found) return found
      if (!data.has_more || !data.next_cursor) return null
      cursor = data.next_cursor
    }
    return null
  }

  const saveDraft = async () => {
    const editorSession = editorSessionRef.current
    if (!draft || saving || uploadBusy || externalDeleted) return
    const shortcut = draft.shortcut.trim().replace(/^\//, '').toLocaleLowerCase()
    if (!isValidQuickReplyShortcut(shortcut)) {
      setEditorError('El atajo solo admite letras, números, guiones y guion bajo, con un máximo de 100 caracteres.')
      return
    }
    const items = draft.items.filter(item => item.type === 'media' || item.text?.trim())
    if (items.length === 0) {
      setEditorError('Escribe un mensaje o añade al menos un adjunto.')
      return
    }
    if (Array.from(draft.title).length > 255) {
      setEditorError('El título no puede superar 255 caracteres.')
      return
    }
    setSaving(true)
    setEditorError('')
    try {
      const token = localStorage.getItem('token')
      const isEdit = Boolean(draft.id)
      const response = await fetch(isEdit ? `/api/quick-replies/${draft.id}` : '/api/quick-replies', {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          shortcut,
          title: draft.title.trim(),
          body: quickReplyTextProjection(items),
          items,
          expected_updated_at: draft.updated_at || '',
          attachments: draft.attachments.map((attachment, position) => ({
            id: attachment.id,
            media_asset_id: attachment.media_asset_id,
            media_type: attachment.media_type,
            media_filename: attachment.media_filename,
            caption: attachment.caption || '',
            position,
          })),
        }),
      })
      const data = await response.json().catch(() => ({})) as QuickReplyMutationResponse
      if (!response.ok || !data.success || !data.quick_reply) {
        if (response.status === 409 && data.code === 'quick_reply_conflict' && draft.id) {
          const canonical = await findCanonicalReply(draft.id)
          if (canonical) setExternalVersion(canonical)
        }
        throw new Error(data.error || 'No se pudo guardar la respuesta rápida.')
      }
      if (editorSession !== editorSessionRef.current) return
      const canonical = data.quick_reply
      setList(previous => {
        const action = isEdit ? 'updated' : 'created'
        const reconciled = reconcileQuickReplyRealtime(previous.replies, previous.total, { action, quick_reply: canonical }, settledSearch, kind)
        return { ...previous, replies: reconciled.replies, total: reconciled.total }
      })
      setNewAssetIDs(new Set())
      setSelectedID(canonical.id)
      setSelectedSnapshot(canonical)
      setWindowMode('view')
      setDraft(null)
      setInitialFingerprint('')
      setExternalVersion(null)
      setExternalDeleted(false)
      onMessage?.('success', isEdit ? 'Respuesta rápida actualizada' : 'Respuesta rápida creada')
    } catch (error) {
      if (editorSession !== editorSessionRef.current) return
      setEditorError(error instanceof Error ? error.message : 'No se pudo guardar la respuesta rápida.')
    } finally {
      if (editorSession === editorSessionRef.current) setSaving(false)
    }
  }

  const reloadExternalVersion = () => {
    if (!externalVersion) return
    const nextDraft = draftFromReply(externalVersion)
    setDraft(nextDraft)
    setInitialFingerprint(draftFingerprint(nextDraft))
    setExternalVersion(null)
    setEditorError('')
  }

  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return
    setDeleting(true)
    setDeleteError('')
    try {
      const token = localStorage.getItem('token')
      const response = await fetch(`/api/quick-replies/${deleteTarget.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
      const data = await response.json().catch(() => ({})) as { success?: boolean; error?: string }
      if (!response.ok || !data.success) throw new Error(data.error || 'No se pudo eliminar la respuesta rápida.')
      setList(previous => {
        const reconciled = reconcileQuickReplyRealtime(previous.replies, previous.total, { action: 'deleted', quick_reply_id: deleteTarget.id }, settledSearch, kind)
        return { ...previous, replies: reconciled.replies, total: reconciled.total }
      })
      if (selectedID === deleteTarget.id) closeImmediately()
      onMessage?.('success', 'Respuesta rápida eliminada')
      setDeleteTarget(null)
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : 'No se pudo eliminar la respuesta rápida.')
    } finally {
      setDeleting(false)
    }
  }

  if (!canManage) {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center text-center">
        <AlertCircle className="h-8 w-8 text-amber-500" />
        <h3 className="mt-3 text-sm font-semibold text-slate-800">No tienes permiso para administrar respuestas rápidas</h3>
        <p className="mt-1 max-w-md text-xs leading-5 text-slate-500">Puedes seguir usando las respuestas disponibles desde el chat si tienes acceso a conversaciones.</p>
      </div>
    )
  }

  const windowTitle = windowMode === 'create' ? 'Nueva respuesta rápida' : windowMode === 'edit' ? `Editar /${draft?.shortcut || ''}` : `/${selectedReply?.shortcut || ''}`
  const windowDescription = windowMode === 'view' ? 'Revisa el contenido exacto antes de editarlo o eliminarlo.' : 'Prepara texto y adjuntos; nada se enviará desde esta pantalla.'

  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-slate-900">Respuestas rápidas</h3>
            {phase === 'ready' && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold tabular-nums text-slate-600">{list.total}</span>}
          </div>
          <p className="mt-1 text-xs leading-5 text-slate-500">Escribe <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-emerald-700">/</code> en el chat para buscar. Seleccionar una respuesta solo la prepara; tú confirmas el envío.</p>
        </div>
        <button type="button" onClick={openCreate} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2">
          <Plus className="h-4 w-4" />Nueva respuesta
        </button>
      </header>

      <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-3 lg:flex-row lg:items-center">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Buscar respuestas rápidas</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input value={rawSearch} onChange={event => setRawSearch(event.target.value)} placeholder="Buscar por atajo, título o mensaje…" className="min-h-11 w-full rounded-xl border border-slate-200 bg-white pl-10 pr-10 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100" />
          {searchPending ? <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-emerald-600" aria-label="Preparando búsqueda" /> : rawSearch ? <button type="button" onClick={() => setRawSearch('')} className="absolute right-1 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Limpiar búsqueda"><X className="h-4 w-4" /></button> : null}
        </label>
        <div className="flex rounded-xl border border-slate-200 bg-white p-1" aria-label="Filtrar respuestas" role="group">
          {([['all', 'Todas'], ['text', 'Texto'], ['media', 'Multimedia']] as Array<[QuickReplyKind, string]>).map(([value, label]) => (
            <button key={value} type="button" onClick={() => setKind(value)} aria-pressed={kind === value} className={`min-h-9 flex-1 rounded-lg px-3 text-xs font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 lg:flex-none ${kind === value ? 'bg-emerald-50 text-emerald-700 shadow-sm' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800'}`}>{label}</button>
          ))}
        </div>
      </div>

      {filterLoading && list.replies.length > 0 && <div className="flex items-center gap-2 text-xs font-semibold text-slate-500" role="status"><Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-600" />Actualizando resultados…</div>}

      {phase === 'loading' ? (
        <div className="space-y-2" aria-label="Cargando respuestas rápidas">
          {[0, 1, 2, 3].map(item => <div key={item} className="h-20 animate-pulse rounded-2xl border border-slate-100 bg-slate-50" />)}
        </div>
      ) : phase === 'error' && list.replies.length === 0 ? (
        <div className="flex min-h-64 flex-col items-center justify-center text-center" role="alert">
          <AlertCircle className="h-8 w-8 text-rose-500" />
          <h4 className="mt-3 text-sm font-semibold text-slate-800">No pudimos cargar las respuestas rápidas</h4>
          <p className="mt-1 max-w-md text-xs leading-5 text-slate-500">{listError}</p>
          <button type="button" onClick={() => void fetchPage({ reset: true })} className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-700 hover:bg-slate-50"><RefreshCw className="h-4 w-4" />Reintentar</button>
        </div>
      ) : list.replies.length === 0 ? (
        <div className="flex min-h-64 flex-col items-center justify-center text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600"><Zap className="h-6 w-6" /></span>
          <h4 className="mt-3 text-sm font-semibold text-slate-800">{settledSearch || kind !== 'all' ? 'No hay coincidencias' : 'Aún no hay respuestas rápidas'}</h4>
          <p className="mt-1 max-w-md text-xs leading-5 text-slate-500">{settledSearch || kind !== 'all' ? 'Prueba otra búsqueda o limpia los filtros.' : 'Crea la primera para responder desde los chats sin volver a escribir el mismo contenido.'}</p>
          {!settledSearch && kind === 'all' && <button type="button" onClick={openCreate} className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-700"><Plus className="h-4 w-4" />Crear respuesta</button>}
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
          <div className="divide-y divide-slate-100">
            {list.replies.map(reply => {
              const attachments = getQuickReplyAttachments(reply)
              return (
                <div key={reply.id} className={`group flex items-stretch transition ${selectedID === reply.id ? 'bg-emerald-50/70' : 'hover:bg-slate-50/80'}`}>
                  <button type="button" onClick={() => openView(reply)} className="min-w-0 flex-1 px-3 py-3 text-left focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500 sm:px-4">
                    <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:gap-4">
                      <div className="flex w-full shrink-0 items-center justify-between gap-2 sm:w-40 sm:block">
                        <span className="inline-flex max-w-full rounded-full bg-emerald-50 px-2 py-1 font-mono text-[11px] font-bold text-emerald-700 ring-1 ring-emerald-100">/{reply.shortcut}</span>
                        <span className="text-[10px] text-slate-400 sm:mt-2 sm:block">{formatUpdatedAt(reply.updated_at)}</span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-slate-800">{reply.title || 'Sin título'}</p>
                        {reply.body ? <p className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-xs leading-5 text-slate-600">{reply.body}</p> : <p className="mt-1 text-xs italic text-slate-400">Respuesta compuesta solo por adjuntos</p>}
                        {attachments.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{attachments.slice(0, 3).map((attachment, index) => <span key={attachment.id || `${attachment.media_url}-${index}`} className="inline-flex max-w-44 items-center gap-1.5 rounded-lg bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-600">{mediaIcon(attachment.media_type, 'h-3 w-3')}<span className="truncate">{attachment.media_filename || attachment.media_type}</span></span>)}{attachments.length > 3 && <span className="rounded-lg bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-500">+{attachments.length - 3}</span>}</div>}
                      </div>
                    </div>
                  </button>
                  <button type="button" onPointerDown={event => event.stopPropagation()} onClick={event => {
                    event.stopPropagation()
                    const rect = event.currentTarget.getBoundingClientRect()
                    const width = 184
                    const left = Math.min(window.innerWidth - width - 8, Math.max(8, rect.right - width))
                    const top = rect.bottom + 8 + 112 > window.innerHeight ? Math.max(8, rect.top - 112) : rect.bottom + 8
                    setMenu({ reply, top, left })
                  }} className="m-2 flex h-11 w-11 shrink-0 items-center justify-center self-center rounded-xl text-slate-400 transition hover:bg-white hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label={`Acciones para /${reply.shortcut}`} aria-haspopup="menu"><MoreVertical className="h-4 w-4" /></button>
                </div>
              )
            })}
          </div>
          {list.hasMore && <div className="border-t border-slate-100 p-3 text-center"><button type="button" disabled={loadingMore} onClick={() => void fetchPage({ reset: false, cursor: list.nextCursor })} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50">{loadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowDown className="h-4 w-4" />}Cargar más</button></div>}
        </div>
      )}

      {listError && list.replies.length > 0 && <div role="alert" className="flex items-center justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700"><span>{listError}</span><button type="button" onClick={() => void fetchPage({ reset: true })} className="min-h-9 rounded-lg px-3 hover:bg-rose-100">Reintentar</button></div>}

      {menu && typeof document !== 'undefined' && createPortal(
        <div role="menu" onPointerDown={event => event.stopPropagation()} style={{ top: menu.top, left: menu.left }} className="fixed z-[150] w-[184px] rounded-2xl border border-slate-200 bg-white p-1.5 shadow-2xl ring-1 ring-slate-900/5">
          <button type="button" role="menuitem" onClick={() => { const reply = menu.reply; setMenu(null); openEditor(reply) }} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-bold text-slate-700 hover:bg-emerald-50 hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"><Pencil className="h-4 w-4" />Editar</button>
          <button type="button" role="menuitem" onClick={() => { setDeleteError(''); setDeleteTarget(menu.reply); setMenu(null) }} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-bold text-rose-600 hover:bg-rose-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"><Trash2 className="h-4 w-4" />Eliminar</button>
        </div>, document.body,
      )}

      <OperationalWindowShell
        open={windowMode !== null}
        storageKey="clarin:quick-replies:window"
        storageScope={accountId || 'account'}
        title={windowTitle}
        eyebrow="Configuración · Respuestas rápidas"
        description={windowDescription}
        icon={Zap}
        defaultMode="docked"
        defaultWidth={880}
        defaultHeight={760}
        minWidth={520}
        minHeight={520}
        dockedWidth={680}
        busy={saving || uploadBusy}
        onRequestClose={requestClose}
        contentClassName="min-h-0 flex-1 overflow-y-auto bg-slate-50/60"
        dataAttribute="quick-reply-window"
        footer={windowMode === 'view' ? (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => selectedReply && setDeleteTarget(selectedReply)} className="mr-auto inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-bold text-rose-600 hover:bg-rose-50"><Trash2 className="h-4 w-4" />Eliminar</button>
            <button type="button" onClick={requestClose} className="min-h-11 rounded-xl px-4 text-sm font-bold text-slate-600 hover:bg-white">Cerrar</button>
            <button type="button" onClick={() => selectedReply && openEditor(selectedReply)} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-5 text-sm font-semibold text-white hover:bg-emerald-700"><Pencil className="h-4 w-4" />Editar</button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-auto text-xs font-semibold text-slate-500">{dirty ? 'Cambios sin guardar' : 'Sin cambios pendientes'}</span>
            <button type="button" disabled={saving || uploadBusy} onClick={requestClose} className="min-h-11 rounded-xl px-4 text-sm font-bold text-slate-600 hover:bg-white disabled:opacity-40">Cancelar</button>
            <button type="button" disabled={saving || uploadBusy || externalDeleted || !draft || !isValidQuickReplyShortcut(draft.shortcut) || !draft.items.some(item => item.type === 'media' || item.text?.trim())} onClick={() => void saveDraft()} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-40">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}Guardar</button>
          </div>
        )}
      >
        {windowMode === 'view' && selectedReply ? (
          <div className="space-y-5 p-4 sm:p-6">
            <section className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <span className="inline-flex rounded-full bg-emerald-50 px-2.5 py-1 font-mono text-xs font-semibold text-emerald-700 ring-1 ring-emerald-100">/{selectedReply.shortcut}</span>
                  <h3 className="mt-3 text-lg font-semibold text-slate-900">{selectedReply.title || 'Sin título'}</h3>
                </div>
                <p className="text-[11px] font-semibold text-slate-400">Actualizada {formatUpdatedAt(selectedReply.updated_at)}</p>
              </div>
            </section>
            <section>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-[.14em] text-slate-500">Vista previa</h4>
              <QuickReplySequencePreview items={getQuickReplyItems(selectedReply)} attachments={getQuickReplyAttachments(selectedReply)} />
            </section>
          </div>
        ) : draft ? (
          <div className="space-y-5 p-4 sm:p-6">
            {externalDeleted && <div role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700"><p className="font-semibold">Esta respuesta fue eliminada en otra sesión.</p><p className="mt-1 text-xs leading-5">El borrador permanece visible para que puedas copiarlo, pero ya no puede sobrescribir el registro eliminado.</p></div>}
            {externalVersion && !externalDeleted && <div role="alert" className="flex flex-col gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 sm:flex-row sm:items-center"><div className="min-w-0 flex-1"><p className="font-semibold">Hay una versión más reciente</p><p className="mt-1 text-xs leading-5">Tus cambios siguen intactos. Recarga solo cuando quieras sustituir este borrador por la versión canónica.</p></div><button type="button" onClick={reloadExternalVersion} className="min-h-11 shrink-0 rounded-xl border border-amber-300 bg-white px-4 text-xs font-semibold text-amber-800 hover:bg-amber-100">Recargar versión</button></div>}
            {editorError && <div role="alert" className="flex items-start gap-2 rounded-2xl border border-rose-200 bg-rose-50 p-3 text-xs font-semibold leading-5 text-rose-700"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span>{editorError}</span></div>}

            <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold text-slate-700">Atajo</span>
                  <span className="relative block"><span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-sm font-semibold text-emerald-600">/</span><input autoFocus={windowMode === 'create'} value={draft.shortcut} onChange={event => setDraft({ ...draft, shortcut: event.target.value.replace(/^\//, '').toLocaleLowerCase() })} aria-invalid={Boolean(draft.shortcut && !isValidQuickReplyShortcut(draft.shortcut))} className="min-h-11 w-full rounded-xl border border-slate-200 pl-7 pr-3 text-sm text-slate-900 outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100 aria-[invalid=true]:border-rose-300 aria-[invalid=true]:ring-rose-100" placeholder="saludo-inicial" /></span>
                  <span className={`mt-1 block text-[11px] ${draft.shortcut && !isValidQuickReplyShortcut(draft.shortcut) ? 'font-semibold text-rose-600' : 'text-slate-400'}`}>Letras, números, guiones y guion bajo.</span>
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold text-slate-700">Título <span className="font-medium text-slate-400">(opcional)</span></span>
                  <input value={draft.title} maxLength={255} onChange={event => setDraft({ ...draft, title: event.target.value })} className="min-h-11 w-full rounded-xl border border-slate-200 px-3 text-sm text-slate-900 outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100" placeholder="Saludo inicial" />
                  <span className="mt-1 block text-right text-[10px] tabular-nums text-slate-400">{Array.from(draft.title).length}/255</span>
                </label>
              </div>

            </section>

            <QuickReplySequenceEditor items={draft.items} attachments={draft.attachments} disabled={saving || uploadBusy || externalDeleted}
              onChange={(items, attachments) => setDraft({ ...draft, items, attachments })}
              onRemoveAttachment={id => removeAttachment(draft.attachments.findIndex(item => item.id === id))} />
            <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
              <p className="text-xs text-slate-500">Archivos: {draft.attachments.length + uploadTasks.length}/5</p>
              {uploadTasks.map(task => <div key={task.id} className={`flex items-center gap-3 rounded-2xl border p-3 ${task.status === 'error' ? 'border-rose-200 bg-rose-50' : 'border-emerald-100 bg-emerald-50'}`}><span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white ${task.status === 'error' ? 'text-rose-600' : 'text-emerald-700'}`}>{task.status === 'uploading' || task.status === 'queued' ? <Loader2 className="h-4 w-4 animate-spin" /> : <AlertCircle className="h-4 w-4" />}</span><div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold text-slate-800">{task.file.name}</p><p className={`mt-0.5 text-[10px] ${task.status === 'error' ? 'text-rose-600' : 'text-emerald-700'}`}>{task.error || 'Subiendo archivo…'}</p></div>{task.status === 'error' && <><button type="button" onClick={() => void runUpload(task)} className="min-h-10 rounded-xl px-3 text-xs font-semibold text-rose-700 hover:bg-white">Reintentar</button><button type="button" onClick={() => setUploadTasks(previous => previous.filter(item => item.id !== task.id))} className="flex h-10 w-10 items-center justify-center rounded-xl text-rose-500 hover:bg-white" aria-label={`Quitar ${task.file.name}`}><X className="h-4 w-4" /></button></>}</div>)}
              {draft.attachments.length + uploadTasks.length < 5 && draft.items.length + uploadTasks.length < 20 && <label className="flex min-h-12 cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 px-3 text-xs font-semibold text-slate-500 transition hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700 focus-within:ring-2 focus-within:ring-emerald-500"><Paperclip className="h-4 w-4" />Añadir archivos<input type="file" multiple accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt" className="sr-only" disabled={saving || uploadBusy} onChange={event => { void addUploadFiles(event.target.files); event.target.value = '' }} /></label>}
            </section>

          </div>
        ) : null}
      </OperationalWindowShell>

      <ConfirmationDialog open={discardOpen} title="¿Descartar los cambios?" description="El texto y los archivos nuevos de este borrador se perderán. Los archivos ya guardados en la respuesta original no serán eliminados." confirmLabel="Descartar" destructive onCancel={() => { setDiscardOpen(false); setPendingAfterDiscard(null) }} onConfirm={discardDraft} />
      <ConfirmationDialog open={Boolean(deleteTarget)} title={`Eliminar /${deleteTarget?.shortcut || ''}`} description="Dejará de aparecer en Configuración y en los chats. Los mensajes enviados anteriormente se conservarán." confirmLabel="Eliminar respuesta" destructive busy={deleting} error={deleteError} onCancel={() => { if (!deleting) { setDeleteTarget(null); setDeleteError('') } }} onConfirm={() => void confirmDelete()} />
    </div>
  )
}
