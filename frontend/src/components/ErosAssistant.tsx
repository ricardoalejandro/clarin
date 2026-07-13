'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { usePathname } from 'next/navigation'
import { Send, X, Minimize2, Maximize2, Sparkles, MessageSquarePlus, Trash2, FileSpreadsheet, FileText, Menu, BarChart3, Download, ChevronsUpDown, Copy, PanelRight, Square, StopCircle, RotateCcw, AlertCircle } from 'lucide-react'
import ErosCat, { CatMood } from './ErosCat'
import ErosChart, { parseChartBlocks, type ChartConfig } from './ErosChart'
import ErosQuickTasks, { type ErosQuickTask } from './eros/ErosQuickTasks'
import { useErosWindow, type ErosResizeEdge } from './eros/useErosWindow'

interface ErosFileAttachment {
  id: string
  filename: string
  format: string
  content_type: string
  status: string
  size_bytes?: number
  expires_at: string
  delivered_at?: string
  created_at?: string
}

interface ChatMessage {
  id?: string
  conversation_id?: string
  role: 'user' | 'assistant'
  content: string
  codex_model?: string
  reasoning_effort?: string
  duration_ms?: number
  metadata?: Record<string, unknown> | null
  tool_calls?: unknown[]
  attachments?: ErosFileAttachment[]
  created_at?: string
}

interface Conversation {
  id: string
  title: string
  created_at: string
  updated_at: string
  messages?: ChatMessage[]
}

interface ErosStatus {
  success?: boolean
  enabled: boolean
  user_enabled: boolean
  available: boolean
  provider: string
  auth_mode: string
  codex_model?: string
  default_reasoning_effort?: string
  allowed_reasoning_efforts?: string[]
  allow_user_reasoning_override?: boolean
  bridge_configured: boolean
  credential_configured: boolean
  mcp_configured: boolean
}

type ErosRunStatus = 'queued' | 'starting' | 'running' | 'waiting_for_input' | 'completed' | 'failed' | 'cancelled'

interface ErosClarification {
  question: string
  context?: string
  options: Array<{ id: string; label: string; description: string }>
  allow_custom: boolean
}

interface ErosRun {
  id: string
  conversation_id?: string
  status: ErosRunStatus
  phase?: string
  kind?: 'chat' | 'quick_task'
  task_key?: string
  error_code?: string
  safe_error?: string
  result?: unknown
  message?: ChatMessage | string | null
  attachments?: ErosFileAttachment[]
  created_at?: string
}

const ACTIVE_RUN_STORAGE_KEY = 'clarin:eros:active_run:v1'
const EROS_FILE_DB_NAME = 'clarin-eros-files'
const EROS_FILE_DB_VERSION = 1
const EROS_FILE_STORE = 'files'

const reasoningLabelByValue: Record<string, string> = {
  low: 'Rápido',
  medium: 'Normal',
  high: 'Profundo',
  xhigh: 'Máximo',
}

const waitingMoods: CatMood[] = [
  'playing_ball', 'sleeping', 'stretching', 'washing', 'chasing_tail',
  'looking_left', 'looking_right', 'yawning', 'pawing', 'jumping',
  'winking', 'curious', 'excited', 'love', 'studying',
  'fishing', 'dancing', 'meowing', 'stargazing', 'walking', 'walking_ball'
]

const ACTIVE_RUN_STATUSES = new Set<ErosRunStatus>(['queued', 'starting', 'running'])
const RECOVERABLE_RUN_STATUSES = new Set<ErosRunStatus>(['queued', 'starting', 'running', 'waiting_for_input'])

const createClientRequestID = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const isRunStatus = (value: unknown): value is ErosRunStatus => (
  value === 'queued' || value === 'starting' || value === 'running'
  || value === 'waiting_for_input' || value === 'completed' || value === 'failed' || value === 'cancelled'
)

const normalizeErosRun = (raw: any): ErosRun | null => {
  if (!raw || typeof raw.id !== 'string' || !isRunStatus(raw.status)) return null
  return {
    id: raw.id,
    conversation_id: typeof raw.conversation_id === 'string' ? raw.conversation_id : undefined,
    status: raw.status,
    phase: typeof raw.phase === 'string' ? raw.phase : undefined,
    kind: raw.kind === 'quick_task' ? 'quick_task' : 'chat',
    task_key: typeof raw.task_key === 'string' ? raw.task_key : undefined,
    error_code: typeof raw.error_code === 'string' ? raw.error_code : undefined,
    safe_error: typeof raw.safe_error === 'string' ? raw.safe_error : undefined,
    result: raw.result,
    message: typeof raw.message === 'string' || (raw.message && typeof raw.message === 'object') ? raw.message : null,
    attachments: Array.isArray(raw.attachments) ? raw.attachments.map(normalizeErosAttachment).filter(Boolean) as ErosFileAttachment[] : undefined,
    created_at: typeof raw.created_at === 'string' ? raw.created_at : undefined,
  }
}

const runClarification = (run: ErosRun | null): ErosClarification | null => {
  const value = run?.result && typeof run.result === 'object' ? (run.result as any).clarification : null
  if (!value || typeof value.question !== 'string' || !Array.isArray(value.options) || value.options.length < 2) return null
  return {
    question: value.question,
    context: typeof value.context === 'string' ? value.context : undefined,
    options: value.options.filter((option: any) => option && typeof option.id === 'string' && typeof option.label === 'string' && typeof option.description === 'string').slice(0, 3),
    allow_custom: value.allow_custom !== false,
  }
}

const runPhaseLabel = (run: ErosRun | null) => {
  if (!run) return 'Procesando…'
  const known: Record<string, string> = {
    queued: 'En cola segura',
    starting: 'Preparando la consulta',
    running: 'Consultando tus datos',
    loading_context: 'Preparando el contexto',
    querying_data: 'Consultando tus datos',
    consulting: 'Consultando tus datos',
    processing: 'Procesando la consulta',
    querying: 'Consultando tus datos',
    cancelling: 'Cancelando de forma segura',
    reasoning: 'Analizando resultados',
    formatting: 'Preparando la respuesta',
    exporting: 'Generando el archivo',
  }
  return known[run.phase || ''] || known[run.status] || 'Procesando…'
}

const resultToMessage = (result: unknown): string => {
  if (typeof result === 'string') return result
  if (!result || typeof result !== 'object') return 'La tarea terminó correctamente.'
  const row = result as Record<string, unknown>
  for (const key of ['response', 'content', 'summary', 'text', 'message']) {
    if (typeof row[key] === 'string' && row[key]) return String(row[key])
  }
  const rows = Array.isArray(row.rows) ? row.rows : Array.isArray(row.items) ? row.items : []
  if (rows.length > 0 && rows.every(item => item && typeof item === 'object' && !Array.isArray(item))) {
    const columns = Object.keys(rows[0] as Record<string, unknown>).slice(0, 8)
    const header = `| ${columns.join(' | ')} |`
    const separator = `| ${columns.map(() => '---').join(' | ')} |`
    const body = rows.slice(0, 100).map(item => {
      const object = item as Record<string, unknown>
      return `| ${columns.map(column => String(object[column] ?? '').replace(/\|/g, '\\|')).join(' | ')} |`
    })
    return [header, separator, ...body].join('\n')
  }
  const count = typeof row.count === 'number' ? row.count : typeof row.total === 'number' ? row.total : null
  return count !== null ? `Resultado: **${count.toLocaleString('es-PE')}**` : 'La tarea terminó correctamente.'
}

const normalizeChatMessage = (raw: any): ChatMessage => ({
  id: typeof raw?.id === 'string' ? raw.id : undefined,
  conversation_id: typeof raw?.conversation_id === 'string' ? raw.conversation_id : undefined,
  role: raw?.role === 'assistant' ? 'assistant' : 'user',
  content: typeof raw?.content === 'string' ? raw.content : '',
  codex_model: typeof raw?.codex_model === 'string' ? raw.codex_model : undefined,
  reasoning_effort: typeof raw?.reasoning_effort === 'string' ? raw.reasoning_effort : undefined,
  duration_ms: typeof raw?.duration_ms === 'number' ? raw.duration_ms : undefined,
  metadata: raw?.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata) ? raw.metadata : null,
  tool_calls: Array.isArray(raw?.tool_calls) ? raw.tool_calls : undefined,
  attachments: Array.isArray(raw?.attachments) ? raw.attachments.map(normalizeErosAttachment).filter(Boolean) : undefined,
  created_at: typeof raw?.created_at === 'string' ? raw.created_at : undefined,
})

const normalizeErosAttachment = (raw: any): ErosFileAttachment | null => {
  if (!raw || typeof raw?.id !== 'string') return null
  return {
    id: raw.id,
    filename: typeof raw.filename === 'string' ? raw.filename : 'eros_archivo.txt',
    format: typeof raw.format === 'string' ? raw.format : 'txt',
    content_type: typeof raw.content_type === 'string' ? raw.content_type : 'text/plain; charset=utf-8',
    status: typeof raw.status === 'string' ? raw.status : 'ready',
    size_bytes: typeof raw.size_bytes === 'number' ? raw.size_bytes : undefined,
    expires_at: typeof raw.expires_at === 'string' ? raw.expires_at : '',
    delivered_at: typeof raw.delivered_at === 'string' ? raw.delivered_at : undefined,
    created_at: typeof raw.created_at === 'string' ? raw.created_at : undefined,
  }
}

const metadataString = (metadata: Record<string, unknown> | null | undefined, key: string) => {
  const value = metadata?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

const metadataNumber = (metadata: Record<string, unknown> | null | undefined, key: string) => {
  const value = metadata?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

const formatErosDuration = (ms?: number) => {
  if (!ms || ms <= 0) return ''
  if (ms < 1000) return `${Math.round(ms)} ms`
  const seconds = ms / 1000
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`
}

const openErosFileDB = () => new Promise<IDBDatabase | null>((resolve) => {
  if (typeof window === 'undefined' || !('indexedDB' in window)) {
    resolve(null)
    return
  }
  const req = window.indexedDB.open(EROS_FILE_DB_NAME, EROS_FILE_DB_VERSION)
  req.onupgradeneeded = () => {
    const db = req.result
    if (!db.objectStoreNames.contains(EROS_FILE_STORE)) db.createObjectStore(EROS_FILE_STORE, { keyPath: 'id' })
  }
  req.onerror = () => resolve(null)
  req.onsuccess = () => resolve(req.result)
})

const getCachedErosFile = async (id: string): Promise<{ blob: Blob; filename: string; contentType: string; expiresAt: string } | null> => {
  const db = await openErosFileDB()
  if (!db) return null
  return new Promise(resolve => {
    const tx = db.transaction(EROS_FILE_STORE, 'readonly')
    const req = tx.objectStore(EROS_FILE_STORE).get(id)
    req.onerror = () => resolve(null)
    req.onsuccess = () => {
      const row = req.result
      if (!row?.blob || !row?.expiresAt || new Date(row.expiresAt).getTime() <= Date.now()) {
        resolve(null)
        return
      }
      resolve(row)
    }
  })
}

const putCachedErosFile = async (id: string, blob: Blob, filename: string, contentType: string, expiresAt: string) => {
  const db = await openErosFileDB()
  if (!db) return
  await new Promise<void>(resolve => {
    const tx = db.transaction(EROS_FILE_STORE, 'readwrite')
    tx.objectStore(EROS_FILE_STORE).put({ id, blob, filename, contentType, expiresAt, savedAt: new Date().toISOString() })
    tx.oncomplete = () => resolve()
    tx.onerror = () => resolve()
  })
}

const deleteCachedErosFile = async (id: string) => {
  const db = await openErosFileDB()
  if (!db) return
  await new Promise<void>(resolve => {
    const tx = db.transaction(EROS_FILE_STORE, 'readwrite')
    tx.objectStore(EROS_FILE_STORE).delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => resolve()
  })
}

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const formatBytes = (bytes?: number) => {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const fileFormatLabel = (format: string) => {
  const value = format.toLowerCase()
  if (value === 'xlsx') return 'Excel'
  if (value === 'docx') return 'Word'
  if (value === 'pptx') return 'PowerPoint'
  if (value === 'pdf') return 'PDF'
  return value.toUpperCase()
}

export default function ErosAssistant({ isOpenProp = false, onClose }: { isOpenProp?: boolean; onClose?: () => void }) {
  const [isOpen, setIsOpen] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [lastFailedMessage, setLastFailedMessage] = useState<string | null>(null)
  const [catMood, setCatMood] = useState<CatMood>('idle')
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [showSidebar, setShowSidebar] = useState(false)
  const [erosConfigured, setErosConfigured] = useState<boolean | null>(null) // null = loading
  const [erosStatus, setErosStatus] = useState<ErosStatus | null>(null)
  const [clarificationText, setClarificationText] = useState('')
  const [answeringClarification, setAnsweringClarification] = useState(false)
  const [mobileVH, setMobileVH] = useState<number | null>(null)
  const [maximizedChart, setMaximizedChart] = useState<ChartConfig | null>(null)
  const [isInputExpanded, setIsInputExpanded] = useState(false)
  const [inputHistory, setInputHistory] = useState<string[]>([])
  const [cachedFileIds, setCachedFileIds] = useState<Set<string>>(new Set())
  const [quickTasks, setQuickTasks] = useState<ErosQuickTask[]>([])
  const [quickTasksLoading, setQuickTasksLoading] = useState(false)
  const [activeRun, setActiveRun] = useState<ErosRun | null>(null)
  const [lastFailedRunId, setLastFailedRunId] = useState<string | null>(null)
  const [runError, setRunError] = useState('')
  const inputHistoryIndex = useRef<number>(-1)
  const inputDraft = useRef<string>('')
  const conversationRequestRef = useRef(0)
  const conversationIdRef = useRef<string | null>(null)
  const pollRequestRef = useRef(0)
  const legacyAbortRef = useRef<AbortController | null>(null)
  const busyRef = useRef(false)
  const headerMoods: CatMood[] = ['idle', 'winking', 'playing_ball', 'curious', 'dancing', 'jumping', 'love', 'pawing', 'walking']
  const [headerMoodIdx, setHeaderMoodIdx] = useState(0)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const chatPanelRef = useRef<HTMLDivElement>(null)
  const pathname = usePathname()
  const erosWindow = useErosWindow()
  const { effectiveMode, isMobile } = erosWindow

  useEffect(() => { conversationIdRef.current = conversationId }, [conversationId])

  // Sync isOpen with prop from layout
  useEffect(() => {
    setIsOpen(isOpenProp)
  }, [isOpenProp])

  // Adjust inner layout when mobile keyboard opens/closes
  useEffect(() => {
    if (!isMobile || !isOpen) { setMobileVH(null); return }
    const vv = window.visualViewport
    if (!vv) return
    const onResize = () => {
      // Use visualViewport height to shrink panel when keyboard is open
      const vh = vv.height
      const fullH = window.innerHeight
      // Only set mobileVH when keyboard is actually open (viewport noticeably smaller)
      if (fullH - vh > 100) {
        setMobileVH(vh)
      } else {
        setMobileVH(null)
      }
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
    }
    onResize()
    vv.addEventListener('resize', onResize)
    return () => vv.removeEventListener('resize', onResize)
  }, [isMobile, isOpen])

  // Cycle header cat mood for playful animations
  useEffect(() => {
    if (!isOpen || isLoading) return
    const interval = setInterval(() => {
      setHeaderMoodIdx(prev => (prev + 1) % headerMoods.length)
    }, 3000)
    return () => clearInterval(interval)
  }, [isOpen, isLoading])

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    const ids = messages.flatMap(m => m.attachments?.map(file => file.id) || [])
    if (ids.length === 0) {
      setCachedFileIds(new Set())
      return
    }
    let active = true
    Promise.all(ids.map(async id => [id, Boolean(await getCachedErosFile(id))] as const)).then(results => {
      if (!active) return
      setCachedFileIds(new Set(results.filter(([, cached]) => cached).map(([id]) => id)))
    })
    return () => { active = false }
  }, [messages])

  // Focus input when panel opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [isOpen])

  // Global Escape key handler for Eros panel
  useEffect(() => {
    if (!isOpen) return
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Don't handle if textarea has focus (handleKeyDown handles it)
      if (document.activeElement === inputRef.current) return
      e.preventDefault()
      if (maximizedChart) { setMaximizedChart(null); return }
      if (effectiveMode === 'maximized' && !isMobile) { erosWindow.setMode('floating'); return }
      onClose?.()
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [effectiveMode, erosWindow, isMobile, isOpen, maximizedChart, onClose])

  // Rotate moods during loading
  useEffect(() => {
    if (!isLoading) return
    const interval = setInterval(() => {
      const mood = waitingMoods[Math.floor(Math.random() * waitingMoods.length)]
      setCatMood(mood)
    }, 3500)
    return () => clearInterval(interval)
  }, [isLoading])

  // Load conversations when opened
  useEffect(() => {
    if (isOpen) loadConversations()
  }, [isOpen])

  const getAuthHeaders = () => {
    const token = localStorage.getItem('token')
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    }
  }

  const checkErosStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/eros/status', { headers: getAuthHeaders() })
      const data = await res.json()
      setErosStatus(data)
      setErosConfigured(Boolean(data.success && data.available))
    } catch {
      setErosStatus(null)
      setErosConfigured(false)
    }
  }, [])

  // Check if Eros is available for this user.
  useEffect(() => {
    checkErosStatus()
  }, [checkErosStatus])

  useEffect(() => {
    if (isOpen) checkErosStatus()
  }, [isOpen, checkErosStatus])

  useEffect(() => {
    const onFocus = () => checkErosStatus()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [checkErosStatus])

  const loadConversations = async () => {
    try {
      const res = await fetch('/api/eros/conversations', { headers: getAuthHeaders() })
      const data = await res.json()
      if (data.success) setConversations(data.conversations || [])
    } catch { /* ignore */ }
  }

  const loadConversation = async (id: string) => {
    if (activeRun?.status === 'waiting_for_input' && activeRun.conversation_id && activeRun.conversation_id !== id) {
      setRunError('Responde primero la aclaración pendiente antes de cambiar de conversación.')
      return
    }
    const requestId = ++conversationRequestRef.current
    try {
      const res = await fetch(`/api/eros/conversations/${id}`, { headers: getAuthHeaders() })
      const data = await res.json()
      if (requestId === conversationRequestRef.current && data.success && data.conversation) {
        setConversationId(id)
        setMessages(data.conversation.messages?.map(normalizeChatMessage) || [])
        setShowSidebar(false)
        setRunError('')
      }
    } catch { /* ignore */ }
  }

  const deleteConversation = async (id: string) => {
    try {
      const response = await fetch(`/api/eros/conversations/${id}`, { method: 'DELETE', headers: getAuthHeaders() })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        setRunError(data.error === 'conversation_run_active'
          ? 'Esta conversación tiene una consulta activa. Cancélala o espera a que termine antes de eliminarla.'
          : 'No pude eliminar la conversación.')
        return
      }
      setConversations(prev => prev.filter(c => c.id !== id))
      if (conversationId === id) {
        setConversationId(null)
        setMessages([])
      }
    } catch {
      setRunError('No pude eliminar la conversación.')
    }
  }

  const startNewChat = () => {
    if (activeRun?.status === 'waiting_for_input') {
      setRunError('Responde primero la aclaración pendiente o vuelve a esa conversación para continuar.')
      return
    }
    conversationRequestRef.current += 1
    setConversationId(null)
    setMessages([])
    setShowSidebar(false)
    setRunError('')
    setLastFailedMessage(null)
    setLastFailedRunId(null)
    setCatMood('greeting')
    setTimeout(() => setCatMood('idle'), 2000)
    setTimeout(() => inputRef.current?.focus(), 100)
  }

  const downloadErosAttachment = async (file: ErosFileAttachment) => {
    if (file.expires_at && new Date(file.expires_at).getTime() <= Date.now()) {
      alert('Este archivo ya no está disponible. Puedes pedirme que lo genere otra vez.')
      return
    }
    const cached = await getCachedErosFile(file.id)
    if (cached) {
      setCachedFileIds(prev => new Set(prev).add(file.id))
      downloadBlob(cached.blob, cached.filename)
      return
    }
    try {
      const res = await fetch(`/api/eros/files/${file.id}/download`, { headers: getAuthHeaders() })
      if (res.status === 410) {
        alert('Este archivo ya no está disponible. Puedes pedirme que lo genere otra vez.')
        return
      }
      if (!res.ok) {
        alert('No pude descargar el archivo. Intenta de nuevo.')
        return
      }
      const blob = await res.blob()
      const filename = file.filename || `eros_archivo.${file.format || 'txt'}`
      await putCachedErosFile(file.id, blob, filename, file.content_type, file.expires_at)
      setCachedFileIds(prev => new Set(prev).add(file.id))
      downloadBlob(blob, filename)
    } catch {
      alert('No pude descargar el archivo. Intenta de nuevo.')
    }
  }

  const copyErosAttachmentLink = async (file: ErosFileAttachment) => {
    try {
      const link = `${window.location.origin}/api/eros/files/${file.id}/download`
      await navigator.clipboard.writeText(link)
    } catch {
      alert('No pude copiar el enlace.')
    }
  }

  const removeCachedErosAttachment = async (file: ErosFileAttachment) => {
    await deleteCachedErosFile(file.id)
    setCachedFileIds(prev => {
      const next = new Set(prev)
      next.delete(file.id)
      return next
    })
  }

  const finishRun = useCallback((run: ErosRun) => {
    busyRef.current = false
    if (window.localStorage.getItem(ACTIVE_RUN_STORAGE_KEY) === run.id) {
      window.localStorage.removeItem(ACTIVE_RUN_STORAGE_KEY)
    }
    setActiveRun(run)
    setIsLoading(false)

    if (run.status === 'completed' || run.status === 'waiting_for_input') {
      const content = typeof run.message === 'string'
        ? run.message
        : run.message && typeof run.message === 'object'
          ? run.message.content
          : resultToMessage(run.result)
      const assistant = normalizeChatMessage(run.message && typeof run.message === 'object'
        ? {
            ...run.message,
            attachments: run.message.attachments?.length ? run.message.attachments : run.attachments,
          }
        : { role: 'assistant', content, attachments: run.attachments })
      if ((!run.conversation_id || conversationIdRef.current === run.conversation_id) && assistant.content) {
        setMessages(previous => {
          if (assistant.id && previous.some(message => message.id === assistant.id)) return previous
          return [...previous, assistant]
        })
      }
      setRunError('')
      setLastFailedMessage(null)
      setLastFailedRunId(null)
      setCatMood(run.status === 'waiting_for_input' ? 'curious' : 'happy')
      if (run.status === 'completed') window.setTimeout(() => setCatMood('idle'), 1800)
      void loadConversations()
    } else {
      const cancelled = run.status === 'cancelled'
      setRunError(cancelled ? 'La ejecución fue cancelada.' : run.safe_error || 'No pude completar la consulta. Puedes reintentarla sin perder el contexto.')
      setLastFailedRunId(cancelled ? null : run.id)
      setCatMood(cancelled ? 'idle' : 'curious')
    }
    window.setTimeout(() => inputRef.current?.focus(), 50)
  }, [])

  const pollRun = useCallback(async (runId: string) => {
    const requestId = ++pollRequestRef.current
    try {
      const response = await fetch(`/api/eros/runs/${runId}`, { headers: getAuthHeaders(), cache: 'no-store' })
      if (!response.ok) return
      const data = await response.json()
      const run = normalizeErosRun(data.run || data)
      if (!run || requestId !== pollRequestRef.current) return
      setActiveRun(run)
      if (ACTIVE_RUN_STATUSES.has(run.status)) {
        setIsLoading(true)
        setCatMood(run.phase === 'reasoning' ? 'studying' : 'thinking')
      } else {
        finishRun(run)
      }
    } catch {
      // Durable runs continue in the backend; a later poll or focus recovery will reconnect.
    }
  }, [finishRun])

  useEffect(() => {
    if (!activeRun || !ACTIVE_RUN_STATUSES.has(activeRun.status)) return
    const runId = activeRun.id
    const timer = window.setInterval(() => void pollRun(runId), 1500)
    return () => window.clearInterval(timer)
  }, [activeRun?.id, activeRun?.status, pollRun])

  const recoverActiveRuns = useCallback(async () => {
    try {
      const response = await fetch('/api/eros/runs?active=true', { headers: getAuthHeaders(), cache: 'no-store' })
      if (!response.ok) return
      const data = await response.json()
      const runs = (Array.isArray(data.runs) ? data.runs : data.run ? [data.run] : [])
        .map(normalizeErosRun)
        .filter(Boolean) as ErosRun[]
      let run = runs.find(item => RECOVERABLE_RUN_STATUSES.has(item.status)) || null
      if (!run) {
        const rememberedRunId = window.localStorage.getItem(ACTIVE_RUN_STORAGE_KEY)
        if (rememberedRunId) {
          const rememberedResponse = await fetch(`/api/eros/runs/${rememberedRunId}`, { headers: getAuthHeaders(), cache: 'no-store' })
          if (rememberedResponse.ok) {
            const rememberedData = await rememberedResponse.json()
            run = normalizeErosRun(rememberedData.run || rememberedData)
          } else {
            window.localStorage.removeItem(ACTIVE_RUN_STORAGE_KEY)
          }
        }
      }
      if (!run) return
      if (!ACTIVE_RUN_STATUSES.has(run.status)) {
        if (run.conversation_id) {
          conversationIdRef.current = run.conversation_id
          await loadConversation(run.conversation_id)
        }
        finishRun(run)
        return
      }
      setActiveRun(run)
      setIsLoading(ACTIVE_RUN_STATUSES.has(run.status))
      busyRef.current = ACTIVE_RUN_STATUSES.has(run.status)
      window.localStorage.setItem(ACTIVE_RUN_STORAGE_KEY, run.id)
      setRunError('')
      if (run.conversation_id && !conversationIdRef.current) {
        conversationIdRef.current = run.conversation_id
        await loadConversation(run.conversation_id)
      }
      if (ACTIVE_RUN_STATUSES.has(run.status)) void pollRun(run.id)
    } catch {
      // Older backends do not expose durable runs; the chat fallback remains available.
    }
  }, [finishRun, pollRun])

  const runLegacyChat = useCallback(async (msg: string, historyMessages: ChatMessage[]) => {
    const controller = new AbortController()
    legacyAbortRef.current = controller
    try {
      const history = historyMessages.slice(-20).map(message => ({
        role: message.role,
        content: message.role === 'assistant'
          ? message.content.replace(/<chart>[\s\S]*?<\/chart>/g, '[gráfico]').replace(/^\|.*\|$/gm, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 800)
          : message.content.slice(0, 800),
      }))
      const response = await fetch('/api/eros/chat', {
        method: 'POST',
        headers: getAuthHeaders(),
        signal: controller.signal,
        body: JSON.stringify({
          message: msg,
          history,
          current_page: pathname,
          conversation_id: conversationIdRef.current || '',
        }),
      })
      const data = await response.json()
      if (data.success && data.response) {
        setMessages(previous => [...previous, normalizeChatMessage(data.message || {
          role: 'assistant',
          content: data.response,
          codex_model: data.codex_model,
          reasoning_effort: data.reasoning_effort,
          duration_ms: data.duration_ms,
          metadata: data.metadata,
          tool_calls: data.tool_calls,
        })])
        if (data.conversation_id && !conversationIdRef.current) {
          conversationIdRef.current = data.conversation_id
          setConversationId(data.conversation_id)
        }
        setLastFailedMessage(null)
        setRunError('')
        setCatMood('happy')
        void loadConversations()
      } else {
        const disabled = data.error === 'eros_user_disabled' || data.error === 'eros_disabled'
        if (disabled) setErosConfigured(false)
        throw new Error(typeof data.safe_error === 'string' ? data.safe_error : typeof data.error === 'string' ? data.error : 'No pude completar la consulta.')
      }
    } catch (error) {
      if ((error as Error).name === 'AbortError') setRunError('La consulta fue cancelada.')
      else setRunError(error instanceof Error && !error.message.startsWith('eros_') ? error.message : 'Eros no está disponible en este momento. Inténtalo nuevamente en unos minutos.')
      setLastFailedMessage(msg)
      setCatMood('curious')
    } finally {
      legacyAbortRef.current = null
      busyRef.current = false
      setIsLoading(false)
      window.setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [pathname])

  const createRun = useCallback(async ({
    kind,
    label,
    message,
    task,
  }: {
    kind: 'chat' | 'quick_task'
    label: string
    message?: string
    task?: ErosQuickTask
  }) => {
    if (busyRef.current || isLoading || !erosConfigured) return
    busyRef.current = true
    const userMessage: ChatMessage = { role: 'user', content: label }
    const historyMessages = [...messages, userMessage]
    setMessages(previous => [...previous, userMessage])
    setIsLoading(true)
    setRunError('')
    setLastFailedMessage(null)
    setLastFailedRunId(null)
    setCatMood(kind === 'quick_task' ? 'studying' : 'thinking')

    try {
      const parameters = {
        ...Object.fromEntries((task?.parameters || [])
        .filter(parameter => parameter.default !== undefined)
        .map(parameter => [parameter.name, parameter.default])),
        ...(task?.key === 'export_current_result' && activeRun?.status === 'completed'
          ? { format: 'xlsx', source_run_id: activeRun.id }
          : {}),
      }
      const response = await fetch('/api/eros/runs', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          client_request_id: createClientRequestID(),
          conversation_id: conversationIdRef.current || undefined,
          kind,
          message,
          task_key: task?.key,
          parameters,
          current_page: pathname,
        }),
      })
      if ((response.status === 404 || response.status === 405 || response.status === 501) && kind === 'chat' && message) {
        await runLegacyChat(message, historyMessages)
        return
      }
      const data = await response.json().catch(() => ({}))
      const run = normalizeErosRun(data.run || data)
      if (!response.ok || !run) throw new Error(data.safe_error || data.error || 'No pude iniciar la consulta.')
      if (run.conversation_id) {
        conversationIdRef.current = run.conversation_id
        setConversationId(run.conversation_id)
      }
      setActiveRun(run)
      window.localStorage.setItem(ACTIVE_RUN_STORAGE_KEY, run.id)
      void pollRun(run.id)
    } catch (error) {
      busyRef.current = false
      setIsLoading(false)
      setRunError(error instanceof Error ? error.message : 'No pude iniciar la consulta.')
      setLastFailedMessage(message || label)
      setCatMood('curious')
    }
  }, [activeRun, erosConfigured, isLoading, messages, pathname, pollRun, runLegacyChat])

  const sendMessage = useCallback((messageOverride?: string) => {
    const msg = (messageOverride ?? input).trim()
    if (!msg || busyRef.current || isLoading) return
    setInput('')
    setInputHistory(previous => [...previous, msg])
    inputHistoryIndex.current = -1
    inputDraft.current = ''
    void createRun({ kind: 'chat', label: msg, message: msg })
  }, [createRun, input, isLoading])

  const runQuickTask = useCallback((task: ErosQuickTask) => {
    void createRun({ kind: 'quick_task', label: `⚡ ${task.title}`, task })
  }, [createRun])

  const answerClarification = useCallback(async (optionId?: string) => {
    const clarification = runClarification(activeRun)
    const customText = clarificationText.trim()
    if (!activeRun || activeRun.status !== 'waiting_for_input' || !clarification || (!optionId && !customText) || answeringClarification) return
    setAnsweringClarification(true)
    setRunError('')
    try {
      const selected = clarification.options.find(option => option.id === optionId)
      const response = await fetch(`/api/eros/runs/${activeRun.id}/answer`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ client_request_id: createClientRequestID(), option_id: optionId || '', custom_text: optionId ? '' : customText }),
      })
      const data = await response.json().catch(() => ({}))
      const run = normalizeErosRun(data.run || data)
      if (!response.ok || !run) throw new Error(data.error || 'No pude registrar la aclaración.')
      const label = selected?.label || customText
      setMessages(previous => [...previous, { role: 'user', content: label }])
      setClarificationText('')
      setActiveRun(run)
      setIsLoading(true)
      busyRef.current = true
      window.localStorage.setItem(ACTIVE_RUN_STORAGE_KEY, run.id)
      void pollRun(run.id)
    } catch (error) {
      setRunError(error instanceof Error ? error.message : 'No pude registrar la aclaración.')
    } finally {
      setAnsweringClarification(false)
    }
  }, [activeRun, answeringClarification, clarificationText, pollRun])

  const cancelActiveRun = useCallback(async () => {
    if (activeRun && ACTIVE_RUN_STATUSES.has(activeRun.status)) {
      try {
        const response = await fetch(`/api/eros/runs/${activeRun.id}/cancel`, { method: 'POST', headers: getAuthHeaders(), body: '{}' })
        const data = await response.json().catch(() => ({}))
        const run = normalizeErosRun(data.run || data)
        if (run) finishRun(run)
        else setActiveRun(current => current ? { ...current, phase: 'cancelling' } : current)
      } catch {
        setRunError('No pude confirmar la cancelación; la ejecución seguirá visible al reconectar.')
      }
      return
    }
    legacyAbortRef.current?.abort()
  }, [activeRun, finishRun])

  const retryLastMessage = useCallback(async () => {
    if (isLoading) return
    setRunError('')
    if (lastFailedRunId) {
      try {
        const response = await fetch(`/api/eros/runs/${lastFailedRunId}/retry`, { method: 'POST', headers: getAuthHeaders(), body: '{}' })
        const data = await response.json().catch(() => ({}))
        const run = normalizeErosRun(data.run || data)
        if (response.ok && run) {
          busyRef.current = true
          setActiveRun(run)
          window.localStorage.setItem(ACTIVE_RUN_STORAGE_KEY, run.id)
          setLastFailedRunId(null)
          setIsLoading(true)
          void pollRun(run.id)
          return
        }
      } catch { /* fall through to message retry */ }
    }
    if (lastFailedMessage) {
      const retry = lastFailedMessage
      setLastFailedMessage(null)
      sendMessage(retry)
    }
  }, [isLoading, lastFailedMessage, lastFailedRunId, pollRun, sendMessage])

  const loadQuickTasks = useCallback(async () => {
    setQuickTasksLoading(true)
    try {
      const response = await fetch('/api/eros/quick-tasks', { headers: getAuthHeaders(), cache: 'no-store' })
      if (!response.ok) return
      const data = await response.json()
      const tasks = Array.isArray(data.tasks) ? data.tasks.flatMap((task: any) => {
        const key = typeof task?.key === 'string' ? task.key : typeof task?.id === 'string' ? task.id : ''
        if (!key || typeof task?.title !== 'string' || typeof task?.description !== 'string') return []
        return [{
          key,
          title: task.title,
          description: task.description,
          icon: typeof task.icon === 'string' ? task.icon : undefined,
          category: typeof task.category === 'string' ? task.category : undefined,
          parameters: Array.isArray(task.parameters) ? task.parameters : undefined,
          defaults: task.defaults && typeof task.defaults === 'object' && !Array.isArray(task.defaults) ? task.defaults : undefined,
          input_schema: task.input_schema && typeof task.input_schema === 'object' && !Array.isArray(task.input_schema) ? task.input_schema : undefined,
        }]
      }) : []
      setQuickTasks(tasks)
    } catch {
      setQuickTasks([])
    } finally {
      setQuickTasksLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!isOpen || !erosConfigured) return
    void loadQuickTasks()
    void recoverActiveRuns()
  }, [erosConfigured, isOpen, loadQuickTasks, recoverActiveRuns])

  useEffect(() => {
    const reconnect = () => {
      if (document.visibilityState === 'visible') void recoverActiveRuns()
    }
    window.addEventListener('focus', reconnect)
    document.addEventListener('visibilitychange', reconnect)
    return () => {
      window.removeEventListener('focus', reconnect)
      document.removeEventListener('visibilitychange', reconnect)
    }
  }, [recoverActiveRuns])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (maximizedChart) { setMaximizedChart(null); return }
      if (effectiveMode === 'maximized' && !isMobile) { erosWindow.setMode('floating'); return }
      onClose?.()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    } else if (e.key === 'ArrowUp' && inputHistory.length > 0) {
      // Only navigate history if cursor is at the start or input is empty
      const textarea = inputRef.current
      if (textarea && textarea.selectionStart === 0 && textarea.selectionEnd === 0) {
        e.preventDefault()
        if (inputHistoryIndex.current === -1) {
          inputDraft.current = input
          inputHistoryIndex.current = inputHistory.length - 1
        } else if (inputHistoryIndex.current > 0) {
          inputHistoryIndex.current -= 1
        }
        setInput(inputHistory[inputHistoryIndex.current])
      }
    } else if (e.key === 'ArrowDown' && inputHistoryIndex.current !== -1) {
      const textarea = inputRef.current
      const atEnd = textarea && textarea.selectionStart === textarea.value.length
      if (atEnd) {
        e.preventDefault()
        if (inputHistoryIndex.current < inputHistory.length - 1) {
          inputHistoryIndex.current += 1
          setInput(inputHistory[inputHistoryIndex.current])
        } else {
          inputHistoryIndex.current = -1
          setInput(inputDraft.current)
        }
      }
    }
  }

  const exportAsTxt = () => {
    if (messages.length === 0) return
    const lines = messages.map(m => {
      const label = m.role === 'user' ? 'Tú' : 'Eros'
      // Strip chart tags and clean up for text
      const clean = m.content
        .replace(/<chart>[\s\S]*?<\/chart>/g, '[Gráfico]')
        .replace(/```[\s\S]*?```/g, '[Código]')
        .trim()
      return `[${label}]\n${clean}\n`
    })
    const header = `═══════════════════════════════════════\n  Conversación con Eros — Clarin CRM\n  ${new Date().toLocaleString('es-PE')}\n═══════════════════════════════════════\n\n`
    const text = header + lines.join('\n─────────────────────────────────────\n\n')
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `eros_conversacion_${new Date().toISOString().slice(0, 10)}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }

  const exportAsPdf = async () => {
    if (messages.length === 0) return
    try {
      const jsPDF = (await import('jspdf')).default
      const html2canvas = (await import('html2canvas')).default
      const pdf = new jsPDF('p', 'mm', 'a4')
      const pageW = pdf.internal.pageSize.getWidth()
      const margin = 15

      // Header
      pdf.setFillColor(5, 150, 105) // emerald-600
      pdf.rect(0, 0, pageW, 28, 'F')
      pdf.setTextColor(255, 255, 255)
      pdf.setFontSize(16)
      pdf.setFont('helvetica', 'bold')
      pdf.text('Eros — Clarin CRM', margin, 14)
      pdf.setFontSize(9)
      pdf.setFont('helvetica', 'normal')
      pdf.text(`Conversación exportada el ${new Date().toLocaleString('es-PE')}`, margin, 22)

      let y = 38

      for (const msg of messages) {
        const isUser = msg.role === 'user'
        const label = isUser ? 'Tú' : 'Eros'
        const { segments } = parseChartBlocks(msg.content)

        // Check page break
        if (y > 260) { pdf.addPage(); y = 15 }

        // Role label
        pdf.setFontSize(8)
        pdf.setFont('helvetica', 'bold')
        pdf.setTextColor(isUser ? 5 : 71, isUser ? 150 : 85, isUser ? 105 : 105)
        pdf.text(label, margin, y)
        y += 5

        for (const seg of segments) {
          if (seg.type === 'chart' && seg.config) {
            // Render chart to canvas then to PDF
            const tempDiv = document.createElement('div')
            tempDiv.style.cssText = 'position:fixed;left:-9999px;top:0;width:500px;height:300px;background:white;'
            document.body.appendChild(tempDiv)
            const { createRoot } = await import('react-dom/client')
            const React = await import('react')
            const ErosChartMod = (await import('./ErosChart')).default
            const root = createRoot(tempDiv)
            root.render(React.createElement(ErosChartMod, { config: seg.config, compact: false }))
            // Wait for chart to render
            await new Promise(r => setTimeout(r, 800))
            try {
              const canvas = await html2canvas(tempDiv, { scale: 2, useCORS: true, backgroundColor: '#ffffff' })
              const imgData = canvas.toDataURL('image/png')
              const imgW = pageW - margin * 2
              const imgH = (canvas.height / canvas.width) * imgW
              if (y + imgH > 280) { pdf.addPage(); y = 15 }
              pdf.addImage(imgData, 'PNG', margin, y, imgW, imgH)
              y += imgH + 5
            } catch { /* chart render failed, skip */ }
            root.unmount()
            document.body.removeChild(tempDiv)
          } else {
            // Text content
            const clean = seg.content.replace(/<[^>]+>/g, '').trim()
            if (!clean) continue
            pdf.setFontSize(10)
            pdf.setFont('helvetica', 'normal')
            pdf.setTextColor(51, 65, 85) // slate-700
            const lines = pdf.splitTextToSize(clean, pageW - margin * 2)
            for (const line of lines) {
              if (y > 280) { pdf.addPage(); y = 15 }
              pdf.text(line, margin, y)
              y += 4.5
            }
          }
        }
        y += 6
      }

      // Footer
      const pageCount = pdf.getNumberOfPages()
      for (let i = 1; i <= pageCount; i++) {
        pdf.setPage(i)
        pdf.setFontSize(7)
        pdf.setTextColor(148, 163, 184) // slate-400
        pdf.text(`Clarin CRM — Página ${i} de ${pageCount}`, pageW / 2, 290, { align: 'center' })
      }

      pdf.save(`eros_conversacion_${new Date().toISOString().slice(0, 10)}.pdf`)
    } catch (err) {
      console.error('PDF export error:', err)
    }
  }

  // Handle export requests detected in messages
  const handleExport = async (format: 'excel' | 'word', content: string) => {
    try {
      // Extract table data from markdown in the message
      const lines = content.split('\n').filter(l => l.trim().startsWith('|'))
      if (lines.length < 2) return

      const headers = lines[0].split('|').filter(c => c.trim()).map(c => c.trim())
      const dataRows = lines.slice(1).filter(l => !l.match(/^\|[\s-|]+\|$/))

      if (format === 'excel') {
        const xlsxMod = await import('xlsx')
        const XLSX = xlsxMod.default || xlsxMod
        const fileSaver = await import('file-saver')
        const saveAs = fileSaver.saveAs || fileSaver.default?.saveAs
        const rows = dataRows.map(row => {
          const cells = row.split('|').filter(c => c.trim()).map(c => c.trim())
          const obj: Record<string, string> = {}
          headers.forEach((h, i) => { obj[h] = cells[i] || '' })
          return obj
        })
        const ws = XLSX.utils.json_to_sheet(rows)
        const wb = XLSX.utils.book_new()
        XLSX.utils.book_append_sheet(wb, ws, 'Reporte')
        const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
        saveAs(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'reporte_eros.xlsx')
      } else {
        const fileSaver = await import('file-saver')
        const saveAs = fileSaver.saveAs || fileSaver.default?.saveAs
        let html = '\ufeff<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><style>table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:8px;text-align:left}th{background:#10b981;color:white}body{font-family:Calibri,Arial,sans-serif}</style></head><body>'
        html += '<h2>Reporte Eros - Clarin CRM</h2>'
        html += '<table><thead><tr>' + headers.map(h => `<th>${h}</th>`).join('') + '</tr></thead><tbody>'
        dataRows.forEach(row => {
          const cells = row.split('|').filter(c => c.trim()).map(c => c.trim())
          html += '<tr>' + cells.map(c => `<td>${c}</td>`).join('') + '</tr>'
        })
        html += '</tbody></table></body></html>'
        const blob = new Blob([html], { type: 'application/msword;charset=utf-8' })
        saveAs(blob, 'reporte_eros.doc')
      }
    } catch (err) {
      console.error('Export error:', err)
      alert('Error al exportar. Intenta de nuevo.')
    }
  }

  // Check if message contains table data (for showing export buttons)
  const hasTableData = (content: string) => {
    const lines = content.split('\n').filter(l => l.trim().startsWith('|'))
    return lines.length >= 3
  }

  // Format markdown-like response (bold, lists, tables)
  const formatResponse = (text: string) => {
    const lines = text.split('\n')
    const result: JSX.Element[] = []
    let i = 0

    while (i < lines.length) {
      const line = lines[i]

      // Detect table: lines starting with |
      if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
        const tableLines: string[] = []
        while (i < lines.length && lines[i].trim().startsWith('|')) {
          tableLines.push(lines[i])
          i++
        }

        // Parse table
        if (tableLines.length >= 2) {
          const headerCells = tableLines[0].split('|').filter(c => c.trim()).map(c => c.trim())
          const dataLines = tableLines.filter((_, idx) => {
            if (idx === 0) return false
            return !tableLines[idx].match(/^\s*\|[\s-:]+\|\s*$/)
          })

          result.push(
            <div key={`table-${i}`} className="overflow-x-auto my-2 rounded-lg border border-slate-200">
              <table className="min-w-full text-xs">
                <thead>
                  <tr className="bg-emerald-500 text-white">
                    {headerCells.map((h, j) => (
                      <th key={j} className="px-3 py-2 text-left font-semibold whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {dataLines.map((row, ri) => {
                    const cells = row.split('|').filter(c => c.trim()).map(c => c.trim())
                    return (
                      <tr key={ri} className={ri % 2 === 0 ? 'bg-white' : 'bg-slate-50'}>
                        {cells.map((cell, ci) => (
                          <td key={ci} className="px-3 py-1.5 border-t border-slate-100 whitespace-nowrap">{cell}</td>
                        ))}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )
          continue
        }
      }

      // Parse inline formatting: bold **text**, italic *text*
      const parseInline = (text: string) => {
        // First split bold, then italic within each segment
        return text.split(/(\*\*[^*]+\*\*)/g).flatMap((seg, j) => {
          if (seg.startsWith('**') && seg.endsWith('**')) {
            return [<strong key={`b${j}`} className="font-semibold">{seg.slice(2, -2)}</strong>]
          }
          // Split italic *text* (single asterisk, not double)
          return seg.split(/(\*[^*]+\*)/g).map((sub, k) => {
            if (sub.startsWith('*') && sub.endsWith('*') && sub.length > 2) {
              return <em key={`i${j}-${k}`} className="italic text-slate-600">{sub.slice(1, -1)}</em>
            }
            return sub
          })
        })
      }
      const parts = parseInline(line)

      // Bullet points (-, •, *)
      const bulletMatch = line.match(/^(\s*)[\-•\*]\s+(.*)/)
      if (bulletMatch) {
        const indent = Math.min(Math.floor(bulletMatch[1].length / 2), 3)
        result.push(
          <div key={i} className="flex gap-1.5" style={{ marginLeft: `${indent * 12 + 4}px` }}>
            <span className="text-emerald-500 shrink-0 mt-0.5">•</span>
            <span>{parseInline(bulletMatch[2])}</span>
          </div>
        )
        i++
        continue
      }

      // Numbered lists
      const numMatch = line.trim().match(/^(\d+)\.\s+(.*)/)
      if (numMatch) {
        result.push(
          <div key={i} className="flex gap-1.5 ml-1">
            <span className="text-emerald-600 font-medium shrink-0">{numMatch[1]}.</span>
            <span>{parseInline(numMatch[2])}</span>
          </div>
        )
        i++
        continue
      }

      // Heading-like lines (###)
      const headingMatch = line.match(/^#{1,3}\s+(.*)/)
      if (headingMatch) {
        result.push(<div key={i} className="font-semibold text-slate-800 mt-1">{parseInline(headingMatch[1])}</div>)
        i++
        continue
      }

      result.push(<div key={i}>{parts}{line === '' && <br />}</div>)
      i++
    }

    return result
  }


  // Render assistant message with chart blocks support
  const renderAssistantMessage = (text: string, msgIndex: number) => {
    // Strip leaked tool call JSON from AI response (defense in depth)
    const cleanText = text.replace(/\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"parameters"\s*:\s*\{[^}]*\}\s*\}/g, '').trim()
    const { segments } = parseChartBlocks(cleanText || text)
    if (segments.length === 1 && segments[0].type === 'text') {
      return formatResponse(text)
    }
    return segments.map((seg, i) => {
      if (seg.type === 'chart' && seg.config) {
        return (
          <div key={`chart-${i}`} className="my-2">
            <button
              onClick={() => setMaximizedChart(seg.config!)}
              className="group flex items-center gap-2.5 w-full px-4 py-3 rounded-xl bg-gradient-to-r from-emerald-50 to-teal-50 border border-emerald-200/60 hover:border-emerald-300 hover:from-emerald-100 hover:to-teal-100 transition-all duration-200 active:scale-[0.98]"
            >
              <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-emerald-500/10 group-hover:bg-emerald-500/20 transition-colors">
                <BarChart3 size={18} className="text-emerald-600" />
              </div>
              <div className="flex-1 text-left">
                <span className="text-sm font-medium text-emerald-700 block">Ver gráfico{seg.config.title ? `: ${seg.config.title}` : ''}</span>
                <span className="text-[11px] text-emerald-500/80">
                  {seg.config.type === 'pie' ? 'Gráfico circular' : seg.config.type === 'bar' ? 'Gráfico de barras' : seg.config.type === 'line' ? 'Gráfico de líneas' : seg.config.type === 'area' ? 'Gráfico de área' : seg.config.type === 'radar' ? 'Gráfico radar' : seg.config.type === 'scatter' ? 'Dispersión' : seg.config.type === 'heatmap' ? 'Mapa de calor' : seg.config.type === 'gauge' ? 'Indicador' : seg.config.type === 'stacked' ? 'Barras apiladas' : 'Gráfico'}
                  {' · Toca para visualizar'}
                </span>
              </div>
              <Sparkles size={14} className="text-emerald-400 group-hover:text-emerald-500 transition-colors" />
            </button>
          </div>
        )
      }
      return <div key={`text-${i}`}>{formatResponse(seg.content)}</div>
    })
  }

  const renderErosAttachment = (file: ErosFileAttachment) => {
    const cached = cachedFileIds.has(file.id)
    const expired = Boolean(file.expires_at && new Date(file.expires_at).getTime() <= Date.now())
    const size = formatBytes(file.size_bytes)
    const label = expired
      ? 'Expirado'
      : cached
        ? 'Disponible en este navegador'
        : 'Generable durante 4h'
    const isSheet = ['xlsx', 'csv'].includes(file.format?.toLowerCase())
    const Icon = isSheet ? FileSpreadsheet : FileText
    return (
      <div
        key={file.id}
        className={`mt-1.5 ml-1 flex max-w-full items-center gap-2 rounded-xl border bg-white/95 px-2.5 py-2 text-xs shadow-sm ${
          expired ? 'border-slate-200 opacity-70' : 'border-emerald-100'
        }`}
      >
        <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${isSheet ? 'bg-emerald-50 text-emerald-600' : 'bg-blue-50 text-blue-600'}`}>
          <Icon size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-slate-700" title={file.filename}>{file.filename}</div>
          <div className="truncate text-[10px] text-slate-400">
            {fileFormatLabel(file.format)}{size ? ` · ${size}` : ''} · {label}
          </div>
        </div>
        <button
          type="button"
          onClick={() => downloadErosAttachment(file)}
          disabled={expired}
          className="shrink-0 rounded-lg bg-emerald-500 px-2.5 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-emerald-600 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
          title="Descargar"
        >
          Descargar
        </button>
        <button
          type="button"
          onClick={() => copyErosAttachmentLink(file)}
          className="shrink-0 rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-50 hover:text-slate-600"
          title="Copiar enlace interno"
        >
          <Copy size={13} />
        </button>
        {cached && (
          <button
            type="button"
            onClick={() => removeCachedErosAttachment(file)}
            className="shrink-0 rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-500"
            title="Eliminar de este navegador"
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>
    )
  }

  const getAssistantExecutionLabel = (msg: ChatMessage) => {
    if (msg.role !== 'assistant') return null
    const model = (msg.codex_model || metadataString(msg.metadata, 'model')).trim()
    const effort = (msg.reasoning_effort || metadataString(msg.metadata, 'reasoning_effort')).trim()
    const duration = msg.duration_ms || metadataNumber(msg.metadata, 'backend_bridge_duration_ms') || metadataNumber(msg.metadata, 'duration_ms')
    const toolCount = Array.isArray(msg.tool_calls)
      ? msg.tool_calls.length
      : metadataNumber(msg.metadata, 'tool_call_count')

    if (!model && !effort && !duration) return null

    const effortLabel = effort ? reasoningLabelByValue[effort] || effort : ''
    const durationLabel = formatErosDuration(duration)
    const parts = [model, effortLabel, durationLabel].filter(Boolean)
    const detail = [
      model ? `Modelo: ${model}` : '',
      effortLabel ? `Pensamiento: ${effortLabel}` : '',
      durationLabel ? `Duración: ${durationLabel}` : '',
      toolCount ? `Herramientas: ${toolCount}` : 'Herramientas: 0',
    ].filter(Boolean).join(' · ')

    return {
      label: parts.join(' · '),
      title: detail,
    }
  }

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr)
    const now = new Date()
    const diff = now.getTime() - d.getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 60) return `hace ${mins}m`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `hace ${hours}h`
    const days = Math.floor(hours / 24)
    if (days < 7) return `hace ${days}d`
    return d.toLocaleDateString('es-PE', { day: '2-digit', month: 'short' })
  }

  // --- UNIFIED RENDER ---
  if (!isOpen) return null

  const isFullscreen = isMobile
  const isMaximizedView = effectiveMode === 'maximized'
  const isDocked = effectiveMode === 'docked'
  const isFloating = effectiveMode === 'floating'
  const pendingClarification = runClarification(activeRun)
  const availableQuickTasks = quickTasks.filter(task => (
    task.key !== 'export_current_result'
    || (activeRun?.status === 'completed' && activeRun.task_key !== 'export_current_result')
  ))

  return (
    <>
      {/* A desktop maximized window keeps a small, clickable margin around it. */}
      {isMaximizedView && !isMobile && (
        <div
          className="fixed inset-0 z-[55] bg-slate-950/30 backdrop-blur-[1px] transition-opacity"
          onClick={() => erosWindow.setMode('floating')}
        />
      )}

      <div
        ref={chatPanelRef}
        className={`${isDocked ? 'relative z-20 shrink-0' : 'fixed z-[56]'} flex flex-col overflow-hidden bg-white ${
          !erosWindow.isInteracting ? 'transition-[inset,width,height,box-shadow,border-radius] duration-200 ease-out' : ''
        } ${isDocked
          ? 'border-l border-slate-200 shadow-[-10px_0_30px_rgba(15,23,42,0.08)]'
          : isFullscreen
            ? 'rounded-none shadow-2xl'
            : isMaximizedView
              ? 'rounded-2xl border border-slate-200 shadow-2xl'
              : 'rounded-2xl border border-slate-200/80 shadow-[0_18px_60px_rgba(15,23,42,0.22)] ring-1 ring-black/5'
        }`}
        style={{ ...erosWindow.panelStyle, ...(isFullscreen && mobileVH ? { height: `${mobileVH}px` } : {}) }}
        aria-label="Asistente Eros"
      >
        {isDocked && (
          <div
            role="separator"
            aria-label="Ajustar ancho del panel Eros"
            aria-orientation="vertical"
            aria-valuemin={erosWindow.dockMin}
            aria-valuemax={erosWindow.dockMax}
            aria-valuenow={Math.round(erosWindow.dockWidth)}
            tabIndex={0}
            onPointerDown={erosWindow.beginDockResize}
            onDoubleClick={erosWindow.resetDockWidth}
            onKeyDown={erosWindow.handleDockSeparatorKeyDown}
            className="eros-dock-separator absolute inset-y-0 left-0 z-[75] w-3 -translate-x-1/2 cursor-col-resize focus:outline-none focus-visible:bg-emerald-400/25"
          />
        )}
        {isFloating && (['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw'] as ErosResizeEdge[]).map(edge => (
          <div
            key={edge}
            aria-hidden="true"
            onPointerDown={event => erosWindow.beginResize(edge, event)}
            className={`eros-resize-handle eros-resize-${edge}`}
          />
        ))}
        {/* Conversation history drawer */}
        {showSidebar && (
          <>
            <div className="fixed inset-0 bg-black/20 z-[61]" onClick={() => setShowSidebar(false)} />
            <div
              className="fixed inset-y-0 left-0 w-72 z-[62] shadow-xl border-r border-slate-200 flex flex-col bg-slate-50"
              style={{ animation: 'eros-drawer-slide 0.25s ease-out both' }}
            >
              <div className="p-3 border-b border-slate-200 flex items-center justify-between">
                <h4 className="text-sm font-semibold text-slate-700">Historial</h4>
                <button
                  onClick={startNewChat}
                  className="p-1.5 hover:bg-emerald-50 rounded-lg transition-colors text-emerald-600"
                  title="Nuevo chat"
                >
                  <MessageSquarePlus size={16} />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto">
                {conversations.map(conv => (
                  <div
                    key={conv.id}
                    className={`group px-3 py-2.5 cursor-pointer border-b border-slate-100 hover:bg-white transition-colors ${
                      conversationId === conv.id ? 'bg-emerald-50 border-l-2 border-l-emerald-500' : ''
                    }`}
                    onClick={() => loadConversation(conv.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={event => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        void loadConversation(conv.id)
                      }
                    }}
                  >
                    <p className="text-xs font-medium text-slate-700 truncate">{conv.title || 'Sin título'}</p>
                    <div className="flex items-center justify-between mt-1">
                      <span className="text-[10px] text-slate-400">{formatDate(conv.updated_at)}</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteConversation(conv.id) }}
                        className="rounded p-1 text-slate-400 opacity-100 transition-all hover:bg-red-50 hover:text-red-500 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
                        title="Eliminar"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                ))}
                {conversations.length === 0 && (
                  <div className="p-4 text-center text-xs text-slate-400">
                    Sin conversaciones aún
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {/* Header */}
        <div
          className={`relative flex shrink-0 select-none items-center gap-1.5 overflow-visible bg-gradient-to-r from-emerald-700 via-emerald-600 to-teal-500 px-2.5 ${isFullscreen ? 'h-[calc(3.5rem+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)]' : 'h-14'} ${isFloating ? 'cursor-grab rounded-t-2xl active:cursor-grabbing' : ''}`}
          onPointerDown={erosWindow.beginDrag}
          onDoubleClick={event => {
            if ((event.target as HTMLElement).closest('button, a, input, textarea, select, [data-no-window-drag]')) return
            if (!isMobile) erosWindow.setMode(isMaximizedView ? 'floating' : 'maximized')
          }}
        >
          <button
            onClick={() => setShowSidebar(prev => !prev)}
            className="z-10 rounded-lg p-1.5 transition-colors hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            title="Historial"
          >
            <Menu size={16} className="text-white" />
          </button>
          <div className="eros-header-cat-lane relative h-14 min-w-[52px] flex-1 overflow-hidden" aria-hidden="true">
            <div className={`eros-header-cat-wander absolute top-1/2 flex h-[46px] w-[46px] -translate-y-1/2 items-center justify-center rounded-full bg-white/15 shadow-inner ring-1 ring-white/20 ${isLoading ? 'eros-header-cat-working' : ''}`}>
              <ErosCat mood={isLoading ? catMood : headerMoods[headerMoodIdx]} size={42} />
            </div>
          </div>
          <div className="min-w-[46px] max-w-[72px]" data-no-window-drag>
            <h3 className="text-white font-semibold text-sm leading-tight">Eros</h3>
            <p className="text-emerald-100/80 text-[11px] truncate">
              {isLoading ? 'Trabajando' : conversationId ? 'Chat activo' : 'IA de consulta'}
            </p>
          </div>
          <div className="z-10 flex shrink-0 items-center gap-0.5" data-no-window-drag>
            {erosConfigured && messages.length > 0 && (
              <details className="group/export relative">
                <summary
                  className="flex cursor-pointer list-none rounded-lg p-1.5 transition-colors hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70 [&::-webkit-details-marker]:hidden"
                  title="Exportar conversación"
                >
                  <Download size={14} className="text-white/80" />
                </summary>
                <div className="absolute right-0 top-full z-10 mt-1 min-w-[132px] rounded-lg border border-slate-200 bg-white py-1 shadow-xl">
                  <button
                    onClick={exportAsTxt}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 transition-colors"
                  >
                    <FileText size={12} className="text-slate-500" /> TXT
                  </button>
                  <button
                    onClick={exportAsPdf}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 transition-colors"
                  >
                    <FileSpreadsheet size={12} className="text-emerald-500" /> PDF
                  </button>
                </div>
              </details>
            )}
            <button
              onClick={startNewChat}
              className="rounded-lg p-1.5 transition-colors hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
              title="Nuevo chat"
            >
              <Sparkles size={14} className="text-white/80" />
            </button>
            {!isMobile && (
              <div className="flex items-center rounded-lg bg-black/10 p-0.5" aria-label="Modo de ventana">
                <button onClick={() => erosWindow.setMode('floating')} className={`rounded-md p-1 ${isFloating ? 'bg-white/25 text-white' : 'text-white/65 hover:bg-white/15'}`} title="Ventana flotante"><Square size={12} /></button>
                <button onClick={() => erosWindow.setMode('maximized')} className={`rounded-md p-1 ${isMaximizedView ? 'bg-white/25 text-white' : 'text-white/65 hover:bg-white/15'}`} title="Maximizar"><Maximize2 size={12} /></button>
                {erosWindow.canDock && <button onClick={() => erosWindow.setMode('docked')} className={`rounded-md p-1 ${isDocked ? 'bg-white/25 text-white' : 'text-white/65 hover:bg-white/15'}`} title="Acoplar a la derecha"><PanelRight size={12} /></button>}
              </div>
            )}
            <button
              onClick={() => onClose?.()}
              className="rounded-lg p-1.5 transition-colors hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
              title="Cerrar"
            >
              <X size={14} className="text-white/80" />
            </button>
          </div>
        </div>

        {/* Progress comes from the durable run state, never from a fake timer. */}
        {isLoading && (
          <div className="shrink-0" role="status" aria-live="polite">
            <div className="h-0.5 bg-slate-100 overflow-hidden">
              <div className="eros-run-progress h-full w-1/3 bg-gradient-to-r from-transparent via-emerald-500 to-transparent" />
            </div>
            <div className="flex min-h-7 items-center justify-between gap-2 bg-emerald-50/70 px-3 py-1">
              <span className="truncate text-[10px] font-medium text-emerald-700">{activeRun ? runPhaseLabel(activeRun) : 'Procesando consulta anterior…'}</span>
              <button type="button" onClick={cancelActiveRun} className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-slate-500 hover:bg-white hover:text-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400/50">
                <StopCircle size={11} /> Cancelar
              </button>
            </div>
          </div>
        )}

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-3 space-y-3 min-h-0 eros-dot-bg eros-scroll-area bg-gradient-to-b from-slate-50 to-slate-100/80">
          {/* Not available */}
          {erosConfigured === false && (
            <div className="flex flex-col items-center justify-center h-full text-center py-6 gap-3">
              <ErosCat mood="sleeping" size={isMaximizedView || isFullscreen ? 100 : 72} />
              <div>
                <p className="text-slate-700 font-medium text-sm">Eros está dormido 😴</p>
                <p className="text-slate-500 text-xs mt-1.5 max-w-[250px] leading-relaxed">
                  Tu acceso se controla desde Administración. Si ya estás habilitado, revisa que el servicio de Eros esté disponible.
                </p>
              </div>
              <div className="mt-1 grid grid-cols-1 gap-1.5 text-[11px] text-slate-500">
                <span className={erosStatus?.user_enabled ? 'text-emerald-600' : 'text-slate-500'}>
                  Usuario {erosStatus?.user_enabled ? 'habilitado' : 'sin acceso'}
                </span>
                <span className={erosStatus?.bridge_configured ? 'text-emerald-600' : 'text-slate-500'}>
                  Servicio {erosStatus?.bridge_configured ? 'configurado' : 'pendiente'}
                </span>
                <span className={erosStatus?.mcp_configured ? 'text-emerald-600' : 'text-slate-500'}>
                  Datos {erosStatus?.mcp_configured ? 'listos' : 'pendientes'}
                </span>
              </div>
            </div>
          )}

          {/* Chat area */}
          {erosConfigured && (<>
            {messages.length === 0 && (
              <div className="flex min-h-full flex-col items-center justify-center px-1 py-6 text-center">
                <ErosCat mood="greeting" size={isMaximizedView || isFullscreen ? 100 : 76} />
                <div>
                  <p className="text-sm font-semibold text-slate-700">¡Hola! Soy Eros 🐱</p>
                  <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-slate-500">
                    Pregúntame libremente o inicia una consulta frecuente con un toque.
                  </p>
                </div>
                <ErosQuickTasks tasks={availableQuickTasks} loading={quickTasksLoading} disabled={isLoading} onRun={runQuickTask} />
              </div>
            )}

            {messages.map((msg, i) => {
              const execution = getAssistantExecutionLabel(msg)
              const savedResult = msg.role === 'assistant' && msg.metadata?.result_set && typeof msg.metadata.result_set === 'object'
                ? msg.metadata.result_set as Record<string, unknown>
                : null
              return (
                <div key={msg.id || i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`group/message flex flex-col ${isMaximizedView || isFullscreen ? 'max-w-[75%]' : 'max-w-[85%]'}`}>
                    <div
                      className={`px-3 py-2 rounded-2xl leading-relaxed text-[13px] ${
                        msg.role === 'user'
                          ? 'bg-emerald-500 text-white rounded-br-sm'
                          : 'bg-white text-slate-800 rounded-bl-sm shadow-sm border border-slate-100'
                      }`}
                      style={{ animation: 'eros-slide-in 0.2s ease-out both' }}
                    >
                      {msg.role === 'assistant' ? renderAssistantMessage(msg.content, i) : msg.content}
                    </div>
                    {msg.role === 'assistant' && msg.attachments?.map(renderErosAttachment)}
                    {savedResult && (
                      <div className="mt-1.5 ml-1 inline-flex w-fit items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-[10px] font-medium text-emerald-700" title="Eros puede reutilizar exactamente estos registros en tu siguiente consulta">
                        <Sparkles size={10} /> Resultado guardado · {Number(savedResult.returned_count || 0).toLocaleString('es-PE')} {String(savedResult.entity_type || 'registros')}
                      </div>
                    )}
                    {execution && (
                      <div
                        className="mt-1 ml-1 text-[10px] leading-none text-slate-400 transition-opacity sm:opacity-0 sm:group-hover/message:opacity-100 sm:group-focus-within/message:opacity-100"
                        title={execution.title}
                      >
                        {execution.label}
                      </div>
                    )}
                    {msg.role === 'assistant' && hasTableData(msg.content) && (
                      <div className="flex gap-1.5 mt-1.5 ml-1">
                        <button
                          onClick={() => handleExport('excel', msg.content)}
                          className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium bg-emerald-50 text-emerald-700 rounded-lg hover:bg-emerald-100 transition-colors"
                        >
                          <FileSpreadsheet size={12} /> Excel
                        </button>
                        <button
                          onClick={() => handleExport('word', msg.content)}
                          className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium bg-blue-50 text-blue-700 rounded-lg hover:bg-blue-100 transition-colors"
                        >
                          <FileText size={12} /> Word
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}

            {isLoading && (
              <div className="flex justify-start">
                <div className="bg-white text-slate-500 px-3 py-3 rounded-2xl rounded-bl-sm shadow-sm border border-slate-100">
                  <div className="flex items-center gap-3">
                    <ErosCat mood={catMood} size={isMaximizedView || isFullscreen ? 72 : 48} />
                    <div className="flex flex-col gap-1">
                      <span className="text-xs text-slate-600 font-medium">
                        {activeRun ? runPhaseLabel(activeRun) : 'Reconectando con la consulta…'}
                      </span>
                      <span className="inline-flex gap-1.5 items-center">
                        <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                        <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                        <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {runError && !isLoading && (
              <div className="flex justify-start" role="alert">
                <div className="max-w-[92%] rounded-2xl rounded-bl-sm border border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-900 shadow-sm">
                  <div className="flex items-start gap-2">
                    <AlertCircle size={15} className="mt-0.5 shrink-0 text-amber-600" />
                    <div className="min-w-0">
                      <p className="text-xs leading-relaxed">{runError}</p>
                      {(lastFailedRunId || lastFailedMessage) && (
                        <button type="button" onClick={retryLastMessage} className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-white/70 px-2 py-1 text-[11px] font-semibold text-emerald-700 hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40">
                          <RotateCcw size={11} /> Reintentar
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeRun?.status === 'waiting_for_input' && pendingClarification && (
              <div className="flex justify-start" role="group" aria-label="Aclaración solicitada por Eros">
                <div className="w-full max-w-[94%] rounded-2xl rounded-bl-sm border border-emerald-200 bg-white p-3 shadow-sm">
                  <p className="text-sm font-semibold text-slate-800">{pendingClarification.question}</p>
                  {pendingClarification.context && <p className="mt-1 text-xs leading-relaxed text-slate-500">{pendingClarification.context}</p>}
                  <div className="mt-3 grid gap-2">
                    {pendingClarification.options.map(option => (
                      <button key={option.id} type="button" disabled={answeringClarification} onClick={() => void answerClarification(option.id)} className="rounded-xl border border-slate-200 px-3 py-2 text-left transition-colors hover:border-emerald-300 hover:bg-emerald-50 disabled:opacity-60">
                        <span className="block text-xs font-semibold text-slate-700">{option.label}</span>
                        <span className="mt-0.5 block text-[11px] leading-relaxed text-slate-500">{option.description}</span>
                      </button>
                    ))}
                  </div>
                  {pendingClarification.allow_custom && (
                    <div className="mt-3 flex items-end gap-2">
                      <textarea value={clarificationText} onChange={event => setClarificationText(event.target.value)} rows={2} maxLength={1000} placeholder="Otra opción: escribe exactamente lo que deseas…" disabled={answeringClarification} className="min-h-[58px] flex-1 resize-none rounded-xl border border-slate-200 px-3 py-2 text-xs text-slate-700 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/20" />
                      <button type="button" onClick={() => void answerClarification()} disabled={!clarificationText.trim() || answeringClarification} className="rounded-xl bg-emerald-500 p-2.5 text-white hover:bg-emerald-600 disabled:opacity-40" aria-label="Enviar otra opción"><Send size={15} /></button>
                    </div>
                  )}
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </>)}
        </div>

        {/* Maximized Chart Overlay */}
        {maximizedChart && (
          <div className="absolute inset-0 z-[70] bg-white flex flex-col" style={{ animation: 'eros-bounce-in 0.2s ease-out both' }}>
            <div className="px-4 py-3 border-b border-slate-100 bg-gradient-to-r from-emerald-50 to-slate-50 flex items-center justify-between shrink-0">
              <h4 className="text-sm font-semibold text-slate-700 truncate">{maximizedChart.title || 'Gráfico'}</h4>
              <button
                onClick={() => setMaximizedChart(null)}
                className="p-1.5 hover:bg-slate-200 rounded-lg transition-colors text-slate-500 hover:text-slate-700 shrink-0"
                title="Cerrar gráfico"
              >
                <Minimize2 size={16} />
              </button>
            </div>
            <div className="flex-1 min-h-0 p-2">
              <ErosChart config={maximizedChart} />
            </div>
          </div>
        )}

        {/* Input */}
        <div className={`border-t border-slate-200 p-2.5 bg-white shrink-0 ${
          isFullscreen ? 'pb-[max(0.625rem,env(safe-area-inset-bottom))]' : ''
        } ${isFloating ? 'rounded-b-2xl' : ''}`}>
          {erosConfigured && (
            <div className="mb-2 text-[10px] font-medium text-slate-400" aria-label="Nivel de análisis automático">
              Análisis automático{activeRun?.message && typeof activeRun.message === 'object' && activeRun.message.reasoning_effort ? ` · ${reasoningLabelByValue[activeRun.message.reasoning_effort] || activeRun.message.reasoning_effort}` : ''}
            </div>
          )}
          <div className="flex gap-2 items-end">
            <div className="flex-1 min-w-0 relative">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value)
                  const ta = e.target
                  ta.style.height = 'auto'
                  const maxH = isInputExpanded ? 200 : 80
                  ta.style.height = Math.min(ta.scrollHeight, maxH) + 'px'
                }}
                onKeyDown={handleKeyDown}
                onFocus={() => {
                  if (isMobile) {
                    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 350)
                  }
                }}
                placeholder={erosConfigured ? "Escribe tu pregunta..." : "Eros no está disponible"}
                rows={isInputExpanded ? 4 : 1}
                className={`w-full resize-none rounded-xl border border-slate-200 px-3 py-2 pr-8 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-400 transition-all ${isInputExpanded ? 'max-h-[200px]' : 'max-h-[80px]'}`}
                style={{ minHeight: isInputExpanded ? '100px' : '38px' }}
                disabled={isLoading || activeRun?.status === 'waiting_for_input' || !erosConfigured}
              />
              <button
                onClick={() => {
                  setIsInputExpanded(prev => !prev)
                  setTimeout(() => {
                    if (inputRef.current) {
                      const ta = inputRef.current
                      ta.style.height = 'auto'
                      const maxH = !isInputExpanded ? 200 : 80
                      ta.style.height = Math.min(ta.scrollHeight, maxH) + 'px'
                      ta.focus()
                    }
                  }, 50)
                }}
                className="absolute top-1.5 right-1.5 p-0.5 rounded text-slate-300 hover:text-emerald-500 hover:bg-emerald-50/80 transition-colors"
                title={isInputExpanded ? 'Reducir campo' : 'Ampliar campo'}
                type="button"
              >
                <ChevronsUpDown size={12} />
              </button>
            </div>
            <button
              onClick={() => sendMessage()}
              data-eros-send
              disabled={!input.trim() || isLoading || activeRun?.status === 'waiting_for_input' || !erosConfigured}
              className="p-2 rounded-xl bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-40 disabled:hover:bg-emerald-500 transition-all shrink-0 active:scale-95"
            >
              <Send size={16} />
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
