'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Loader2,
  Maximize2,
  MessageCircle,
  Minimize2,
  Phone,
  RefreshCw,
  Search,
  Send,
  Smartphone,
  User,
  WifiOff,
  X,
} from 'lucide-react'

interface Device {
  id: string
  name: string
  phone?: string
  status: string
  provider?: 'whatsapp_web' | 'whatsapp_cloud_api' | string | null
  runtime_capabilities?: {
    can_start_chat?: boolean
    can_check_whatsapp?: boolean
  }
}

interface Contact {
  id: string
  jid: string
  phone: string | null
  name: string | null
  last_name?: string | null
  custom_name: string | null
  push_name: string | null
  email?: string | null
  company?: string | null
  avatar_url: string | null
}

interface ExistingChat {
  id: string
}

interface NewChatModalProps {
  isOpen: boolean
  onClose: () => void
  devices: Device[]
  onChatCreated: (chatId: string) => void
}

type RecipientMode = 'search' | 'manual'
type ValidationStatus = 'idle' | 'checking' | 'valid' | 'invalid' | 'error'
type ResizeEdge = 'n' | 'e' | 's' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

interface PhoneValidation {
  status: ValidationStatus
  normalizedPhone?: string
  jid?: string
  verifiedName?: string
  existingChat?: ExistingChat | null
  message?: string
}

interface WindowGeometry {
  x: number
  y: number
  width: number
  height: number
}

interface CompletionState {
  warning: string
  chatId: string
  deviceId: string
  to: string
  initialMessage: string
}

const SEARCH_PAGE_SIZE = 20
const VIEWPORT_MARGIN = 16
const DEFAULT_WIDTH = 720
const DEFAULT_HEIGHT = 640
const MIN_WIDTH = 560
const MIN_HEIGHT = 480

const EMPTY_VALIDATION: PhoneValidation = { status: 'idle' }

const RESIZE_CLASSES: Record<ResizeEdge, string> = {
  n: 'left-3 right-3 -top-1 h-2 cursor-n-resize',
  e: '-right-1 top-3 bottom-3 w-2 cursor-e-resize',
  s: 'left-3 right-3 -bottom-1 h-2 cursor-s-resize',
  w: '-left-1 top-3 bottom-3 w-2 cursor-w-resize',
  ne: '-right-1 -top-1 h-4 w-4 cursor-ne-resize',
  nw: '-left-1 -top-1 h-4 w-4 cursor-nw-resize',
  se: '-right-1 -bottom-1 h-4 w-4 cursor-se-resize',
  sw: '-left-1 -bottom-1 h-4 w-4 cursor-sw-resize',
}

const COUNTRY_CODES = [
  { code: '+51', country: 'Perú' },
  { code: '+1', country: 'EE. UU. / Canadá' },
  { code: '+52', country: 'México' },
  { code: '+54', country: 'Argentina' },
  { code: '+55', country: 'Brasil' },
  { code: '+56', country: 'Chile' },
  { code: '+57', country: 'Colombia' },
  { code: '+58', country: 'Venezuela' },
  { code: '+591', country: 'Bolivia' },
  { code: '+593', country: 'Ecuador' },
  { code: '+595', country: 'Paraguay' },
  { code: '+598', country: 'Uruguay' },
  { code: '+34', country: 'España' },
]

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function getContactDisplayName(contact: Contact): string {
  const baseName = contact.custom_name || contact.name || contact.push_name
  const fullName = [baseName, contact.last_name].filter(Boolean).join(' ').trim()
  return fullName || contact.phone || contact.jid
}

function cleanPhone(value: string): string {
  return (value || '').replace(/\D/g, '')
}

function formatPhone(value: string): string {
  const digits = cleanPhone(value)
  return digits ? `+${digits}` : ''
}

function viewportSize() {
  const visualViewport = typeof window === 'undefined' ? null : window.visualViewport
  return {
    width: typeof window === 'undefined' ? 1440 : visualViewport?.width ?? window.innerWidth,
    height: typeof window === 'undefined' ? 900 : visualViewport?.height ?? window.innerHeight,
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

function defaultGeometry(): WindowGeometry {
  const viewport = viewportSize()
  const maxWidth = Math.max(320, viewport.width - VIEWPORT_MARGIN * 2)
  const maxHeight = Math.max(240, viewport.height - VIEWPORT_MARGIN * 2)
  const width = Math.min(DEFAULT_WIDTH, maxWidth)
  const height = Math.min(DEFAULT_HEIGHT, maxHeight)
  return {
    x: Math.max(VIEWPORT_MARGIN, (viewport.width - width) / 2),
    y: Math.max(VIEWPORT_MARGIN, (viewport.height - height) / 2),
    width,
    height,
  }
}

function clampGeometry(geometry: WindowGeometry): WindowGeometry {
  const viewport = viewportSize()
  const maxWidth = Math.max(320, viewport.width - VIEWPORT_MARGIN * 2)
  const maxHeight = Math.max(240, viewport.height - VIEWPORT_MARGIN * 2)
  const width = clamp(geometry.width, Math.min(MIN_WIDTH, maxWidth), maxWidth)
  const height = clamp(geometry.height, Math.min(MIN_HEIGHT, maxHeight), maxHeight)
  return {
    x: clamp(geometry.x, VIEWPORT_MARGIN, viewport.width - width - VIEWPORT_MARGIN),
    y: clamp(geometry.y, VIEWPORT_MARGIN, viewport.height - height - VIEWPORT_MARGIN),
    width,
    height,
  }
}

function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem('token') || ''}` }
}

export default function NewChatModal({ isOpen, onClose, devices, onChatCreated }: NewChatModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)
  const submittingRef = useRef(false)
  const wasOpenRef = useRef(false)
  const geometryRef = useRef<WindowGeometry>(defaultGeometry())
  const interactionCleanupRef = useRef<(() => void) | null>(null)
  const searchAbortRef = useRef<AbortController | null>(null)
  const searchRequestRef = useRef(0)
  const validationAbortRef = useRef<AbortController | null>(null)
  const validationRequestRef = useRef(0)
  const submitAbortRef = useRef<AbortController | null>(null)
  const submitRequestRef = useRef(0)
  const retryingInitialMessageRef = useRef(false)
  const isOpenRef = useRef(isOpen)

  const [selectedDevice, setSelectedDevice] = useState('')
  const [mode, setMode] = useState<RecipientMode>('search')
  const [searchTerm, setSearchTerm] = useState('')
  const [contacts, setContacts] = useState<Contact[]>([])
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null)
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchLoadingMore, setSearchLoadingMore] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [searchTotal, setSearchTotal] = useState(0)
  const [searchHasMore, setSearchHasMore] = useState(false)
  const [countryCode, setCountryCode] = useState('+51')
  const [manualPhone, setManualPhone] = useState('')
  const [initialMessage, setInitialMessage] = useState('')
  const [validation, setValidation] = useState<PhoneValidation>(EMPTY_VALIDATION)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [completion, setCompletion] = useState<CompletionState | null>(null)
  const [retryingInitialMessage, setRetryingInitialMessage] = useState(false)
  const [retryInitialMessageError, setRetryInitialMessageError] = useState('')
  const [geometry, setGeometry] = useState<WindowGeometry>(defaultGeometry)
  const [isMobile, setIsMobile] = useState(false)
  const [isMaximized, setIsMaximized] = useState(false)
  const [isInteracting, setIsInteracting] = useState(false)

  onCloseRef.current = onClose
  geometryRef.current = geometry
  isOpenRef.current = isOpen

  const compatibleDevices = useMemo(
    () => devices.filter(device => {
      const provider = device.provider || 'whatsapp_web'
      return device.status === 'connected'
        && provider === 'whatsapp_web'
        && device.runtime_capabilities?.can_start_chat !== false
        && device.runtime_capabilities?.can_check_whatsapp !== false
    }),
    [devices],
  )

  const candidatePhone = useMemo(() => {
    if (mode === 'search') return cleanPhone(selectedContact?.phone || '')
    return `${cleanPhone(countryCode)}${cleanPhone(manualPhone)}`
  }, [countryCode, manualPhone, mode, selectedContact])

  const invalidateValidation = useCallback(() => {
    validationAbortRef.current?.abort()
    validationAbortRef.current = null
    validationRequestRef.current += 1
    setValidation(EMPTY_VALIDATION)
    setSubmitError('')
  }, [])

  const requestClose = useCallback(() => {
    if (submittingRef.current || retryingInitialMessageRef.current) return
    searchAbortRef.current?.abort()
    validationAbortRef.current?.abort()
    submitAbortRef.current?.abort()
    submitRequestRef.current += 1
    onCloseRef.current()
  }, [])

  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      const firstDevice = compatibleDevices[0]?.id || ''
      setSelectedDevice(firstDevice)
      setMode('search')
      setSearchTerm('')
      setContacts([])
      setSelectedContact(null)
      setSearchLoading(false)
      setSearchLoadingMore(false)
      setSearchError('')
      setSearchTotal(0)
      setSearchHasMore(false)
      setCountryCode('+51')
      setManualPhone('')
      setInitialMessage('')
      setValidation(EMPTY_VALIDATION)
      setSubmitError('')
      setCompletion(null)
      setRetryingInitialMessage(false)
      setRetryInitialMessageError('')
      setSubmitting(false)
      submittingRef.current = false
      retryingInitialMessageRef.current = false
      submitAbortRef.current?.abort()
      submitAbortRef.current = null
      submitRequestRef.current += 1
      setGeometry(defaultGeometry())
      setIsMaximized(false)
    }

    if (!isOpen && wasOpenRef.current) {
      searchAbortRef.current?.abort()
      validationAbortRef.current?.abort()
      submitAbortRef.current?.abort()
      submitRequestRef.current += 1
      interactionCleanupRef.current?.()
    }
    wasOpenRef.current = isOpen
  }, [compatibleDevices, isOpen])

  useEffect(() => {
    if (!isOpen) return
    if (!compatibleDevices.some(device => device.id === selectedDevice)) {
      setSelectedDevice(compatibleDevices[0]?.id || '')
      invalidateValidation()
    }
  }, [compatibleDevices, invalidateValidation, isOpen, selectedDevice])

  useEffect(() => {
    if (!isOpen) return

    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusFrame = window.requestAnimationFrame(() => dialogRef.current?.focus())

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (!submittingRef.current) requestClose()
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return

      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter(element => element.offsetParent !== null)
      if (focusable.length === 0) {
        event.preventDefault()
        dialogRef.current.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
      previousFocusRef.current?.focus({ preventScroll: true })
      previousFocusRef.current = null
    }
  }, [isOpen, requestClose])

  useEffect(() => {
    if (!isOpen) return
    const compactQuery = window.matchMedia(
      '(max-width: 767px), (max-height: 599px), ((max-width: 1023px) and (hover: none) and (pointer: coarse))',
    )
    const updateViewport = () => {
      setIsMobile(compactQuery.matches)
      setGeometry(current => clampGeometry(current))
    }
    updateViewport()
    window.addEventListener('resize', updateViewport)
    compactQuery.addEventListener('change', updateViewport)
    window.visualViewport?.addEventListener('resize', updateViewport)
    window.visualViewport?.addEventListener('scroll', updateViewport)
    return () => {
      window.removeEventListener('resize', updateViewport)
      compactQuery.removeEventListener('change', updateViewport)
      window.visualViewport?.removeEventListener('resize', updateViewport)
      window.visualViewport?.removeEventListener('scroll', updateViewport)
    }
  }, [isOpen])

  const searchContacts = useCallback(async (query: string, offset: number, append: boolean) => {
    const trimmedQuery = query.trim()
    if (trimmedQuery.length < 2) return

    searchAbortRef.current?.abort()
    const controller = new AbortController()
    searchAbortRef.current = controller
    const requestId = ++searchRequestRef.current

    if (append) setSearchLoadingMore(true)
    else {
      setSearchLoading(true)
      setSearchError('')
    }

    try {
      const params = new URLSearchParams({
        search: trimmedQuery,
        limit: String(SEARCH_PAGE_SIZE),
        offset: String(offset),
        has_phone: 'true',
        sort_by: 'relevance',
      })
      const response = await fetch(`/api/chats/contacts/search?${params.toString()}`, {
        headers: authHeaders(),
        signal: controller.signal,
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'No pudimos buscar los contactos')
      }
      if (requestId !== searchRequestRef.current) return

      const rawContacts = Array.isArray(data.contacts) ? data.contacts as Contact[] : []
      const phoneContacts = rawContacts.filter(contact => Boolean(cleanPhone(contact.phone || '')))
      setContacts(previous => {
        if (!append) return phoneContacts
        const byId = new Map(previous.map(contact => [contact.id, contact]))
        phoneContacts.forEach(contact => byId.set(contact.id, contact))
        return Array.from(byId.values())
      })

      const total = Number(data.total ?? offset + rawContacts.length)
      setSearchTotal(total)
      setSearchHasMore(Boolean(data.has_more ?? (offset + rawContacts.length < total)))
      setSearchError('')
    } catch (error) {
      if (controller.signal.aborted || requestId !== searchRequestRef.current) return
      setSearchError(error instanceof Error ? error.message : 'No pudimos buscar los contactos')
      if (!append) {
        setContacts([])
        setSearchTotal(0)
        setSearchHasMore(false)
      }
    } finally {
      if (requestId === searchRequestRef.current) {
        setSearchLoading(false)
        setSearchLoadingMore(false)
      }
    }
  }, [])

  useEffect(() => {
    if (!isOpen || mode !== 'search' || selectedContact) return
    const query = searchTerm.trim()
    if (query.length < 2) {
      searchAbortRef.current?.abort()
      searchRequestRef.current += 1
      setContacts([])
      setSearchLoading(false)
      setSearchLoadingMore(false)
      setSearchError('')
      setSearchTotal(0)
      setSearchHasMore(false)
      return
    }
    const timer = window.setTimeout(() => searchContacts(query, 0, false), 300)
    return () => window.clearTimeout(timer)
  }, [isOpen, mode, searchContacts, searchTerm, selectedContact])

  const handleSearchChange = (value: string) => {
    setSearchTerm(value)
    setSelectedContact(null)
    setContacts([])
    invalidateValidation()
  }

  const handleSelectContact = (contact: Contact) => {
    searchAbortRef.current?.abort()
    searchRequestRef.current += 1
    setSearchLoading(false)
    setSearchLoadingMore(false)
    setSelectedContact(contact)
    setSearchTerm(getContactDisplayName(contact))
    setContacts([])
    setSearchError('')
    invalidateValidation()
  }

  const changeMode = (nextMode: RecipientMode) => {
    if (nextMode === mode) return
    searchAbortRef.current?.abort()
    searchRequestRef.current += 1
    setSearchLoading(false)
    setSearchLoadingMore(false)
    setMode(nextMode)
    setSelectedContact(null)
    setSearchTerm('')
    setContacts([])
    setSearchError('')
    setSearchTotal(0)
    setSearchHasMore(false)
    setManualPhone('')
    invalidateValidation()
  }

  const handleDeviceChange = (deviceId: string) => {
    setSelectedDevice(deviceId)
    invalidateValidation()
  }

  const handleCountryCodeChange = (value: string) => {
    const digits = cleanPhone(value).slice(0, 4)
    setCountryCode(digits ? `+${digits}` : '+')
    setSelectedContact(null)
    invalidateValidation()
  }

  const handleManualPhoneChange = (value: string) => {
    setManualPhone(value.replace(/[^\d\s()-]/g, '').slice(0, 24))
    setSelectedContact(null)
    invalidateValidation()
  }

  const validatePhone = useCallback(async () => {
    if (!selectedDevice) {
      setValidation({ status: 'error', message: 'Selecciona un dispositivo conectado.' })
      return
    }
    if (candidatePhone.length < 7 || candidatePhone.length > 15) {
      setValidation({
        status: 'error',
        message: 'Revisa el número: debe incluir código de país y tener entre 7 y 15 dígitos.',
      })
      return
    }

    validationAbortRef.current?.abort()
    const controller = new AbortController()
    validationAbortRef.current = controller
    const requestId = ++validationRequestRef.current
    setValidation({ status: 'checking' })
    setSubmitError('')

    try {
      const response = await fetch('/api/contacts/check-whatsapp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ device_id: selectedDevice, phones: [candidatePhone] }),
        signal: controller.signal,
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'WhatsApp no pudo verificar este número')
      }
      if (requestId !== validationRequestRef.current) return

      const result = Array.isArray(data.results) ? data.results[0] : data.result
      if (!result?.is_on_whatsapp) {
        setValidation({
          status: 'invalid',
          normalizedPhone: cleanPhone(result?.phone || candidatePhone),
          message: 'Este número no está registrado en WhatsApp.',
        })
        return
      }

      const normalizedPhone = cleanPhone(result.phone || data.normalized_phone || candidatePhone)
      const verifiedName = result.verified_name
        || result.verifiedName
        || result.business_name
        || result.push_name
        || result.name
        || data.verified_name
        || undefined
      let existingChat: ExistingChat | null = result.chat?.id ? result.chat : null

      if (!existingChat) {
        try {
          const resolveResponse = await fetch(`/api/chats/resolve-whatsapp/${normalizedPhone}`, {
            headers: authHeaders(),
            signal: controller.signal,
          })
          const resolveData = await resolveResponse.json().catch(() => ({}))
          if (resolveResponse.ok && resolveData.success && resolveData.chat?.id) {
            existingChat = { id: resolveData.chat.id }
          }
        } catch (error) {
          if (controller.signal.aborted) throw error
          // Detecting an existing local chat is an enhancement; successful
          // WhatsApp validation remains authoritative when this lookup fails.
        }
      }

      if (requestId !== validationRequestRef.current) return
      setValidation({
        status: 'valid',
        normalizedPhone,
        jid: result.jid || data.jid,
        verifiedName,
        existingChat,
      })
    } catch (error) {
      if (controller.signal.aborted || requestId !== validationRequestRef.current) return
      setValidation({
        status: 'error',
        message: error instanceof Error ? error.message : 'WhatsApp no pudo verificar este número.',
      })
    }
  }, [candidatePhone, selectedDevice])

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (submittingRef.current) return
    if (!selectedDevice) {
      setSubmitError('Selecciona un dispositivo conectado.')
      return
    }
    if (validation.status !== 'valid' || !validation.normalizedPhone) {
      setSubmitError('Valida el número antes de iniciar la conversación.')
      return
    }

    const message = initialMessage.trim()
    submittingRef.current = true
    setSubmitting(true)
    setSubmitError('')

    submitAbortRef.current?.abort()
    const controller = new AbortController()
    submitAbortRef.current = controller
    const requestId = ++submitRequestRef.current
    try {
      const response = await fetch('/api/chats/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          device_id: selectedDevice,
          contact_id: mode === 'search' ? selectedContact?.id : undefined,
          phone: validation.normalizedPhone,
          initial_message: message || undefined,
        }),
        signal: controller.signal,
      })
      const data = await response.json().catch(() => ({}))
      if (controller.signal.aborted || requestId !== submitRequestRef.current || !isOpenRef.current) return
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'No pudimos iniciar la conversación')
      }

      const chatId = data.chat?.id || data.chat_id || validation.existingChat?.id
      if (!chatId) throw new Error('El servidor no devolvió la conversación creada')

      onChatCreated(chatId)
      if (data.warning) {
        const canonicalRecipient = String(data.chat?.jid || data.jid || validation.jid || '').trim()
        setCompletion({
          warning: data.warning || 'La conversación está lista, pero el mensaje inicial no pudo enviarse.',
          chatId,
          deviceId: selectedDevice,
          to: canonicalRecipient,
          initialMessage: message,
        })
        setRetryInitialMessageError('')
        window.requestAnimationFrame(() => dialogRef.current?.focus())
      } else {
        onCloseRef.current()
      }
    } catch (error) {
      if (controller.signal.aborted || requestId !== submitRequestRef.current || !isOpenRef.current) return
      setSubmitError(error instanceof Error ? error.message : 'No pudimos iniciar la conversación')
    } finally {
      if (requestId === submitRequestRef.current) {
        submitAbortRef.current = null
        submittingRef.current = false
        setSubmitting(false)
      }
    }
  }

  const retryInitialMessage = async () => {
    if (!completion || retryingInitialMessageRef.current) return
    if (!completion.to || !completion.initialMessage) {
      setRetryInitialMessageError('No se pudo determinar el destinatario canónico. Abre la conversación para enviar el mensaje.')
      return
    }

    retryingInitialMessageRef.current = true
    setRetryingInitialMessage(true)
    setRetryInitialMessageError('')
    const requestId = submitRequestRef.current
    try {
      const response = await fetch('/api/messages/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          device_id: completion.deviceId,
          to: completion.to,
          body: completion.initialMessage,
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (requestId !== submitRequestRef.current || !isOpenRef.current) return
      if (!response.ok || !data.success) throw new Error(data.error || 'No se pudo reenviar el mensaje inicial.')
      onChatCreated(completion.chatId)
      onCloseRef.current()
    } catch (error) {
      if (requestId !== submitRequestRef.current || !isOpenRef.current) return
      setRetryInitialMessageError(error instanceof Error ? error.message : 'No se pudo reenviar el mensaje inicial.')
    } finally {
      retryingInitialMessageRef.current = false
      if (requestId === submitRequestRef.current) setRetryingInitialMessage(false)
    }
  }

  const beginPointerSession = useCallback((
    event: ReactPointerEvent,
    onMove: (deltaX: number, deltaY: number) => void,
  ) => {
    if (event.button !== 0) return
    event.preventDefault()
    interactionCleanupRef.current?.()
    const startX = event.clientX
    const startY = event.clientY
    setIsInteracting(true)

    const move = (pointer: PointerEvent) => {
      pointer.preventDefault()
      onMove(pointer.clientX - startX, pointer.clientY - startY)
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', cleanup)
      window.removeEventListener('pointercancel', cleanup)
      document.body.style.userSelect = ''
      setIsInteracting(false)
      interactionCleanupRef.current = null
    }

    document.body.style.userSelect = 'none'
    interactionCleanupRef.current = cleanup
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', cleanup, { once: true })
    window.addEventListener('pointercancel', cleanup, { once: true })
  }, [])

  const beginDrag = useCallback((event: ReactPointerEvent) => {
    if (isMobile || isMaximized) return
    const target = event.target as HTMLElement
    if (target.closest('button, input, select, textarea, a, [data-no-window-drag]')) return
    const start = geometryRef.current
    beginPointerSession(event, (deltaX, deltaY) => {
      const next = clampGeometry({ ...start, x: start.x + deltaX, y: start.y + deltaY })
      geometryRef.current = next
      setGeometry(next)
    })
  }, [beginPointerSession, isMaximized, isMobile])

  const beginResize = useCallback((edge: ResizeEdge, event: ReactPointerEvent) => {
    if (isMobile || isMaximized) return
    const start = geometryRef.current
    const viewport = viewportSize()
    beginPointerSession(event, (deltaX, deltaY) => {
      let { x, y, width, height } = start
      if (edge.includes('e')) {
        width = clamp(start.width + deltaX, Math.min(MIN_WIDTH, viewport.width), viewport.width - start.x - VIEWPORT_MARGIN)
      }
      if (edge.includes('s')) {
        height = clamp(start.height + deltaY, Math.min(MIN_HEIGHT, viewport.height), viewport.height - start.y - VIEWPORT_MARGIN)
      }
      if (edge.includes('w')) {
        const nextWidth = clamp(start.width - deltaX, Math.min(MIN_WIDTH, viewport.width), start.x + start.width - VIEWPORT_MARGIN)
        x = start.x + start.width - nextWidth
        width = nextWidth
      }
      if (edge.includes('n')) {
        const nextHeight = clamp(start.height - deltaY, Math.min(MIN_HEIGHT, viewport.height), start.y + start.height - VIEWPORT_MARGIN)
        y = start.y + start.height - nextHeight
        height = nextHeight
      }
      const next = clampGeometry({ x, y, width, height })
      geometryRef.current = next
      setGeometry(next)
    })
  }, [beginPointerSession, isMaximized, isMobile])

  const panelStyle = useMemo<CSSProperties>(() => {
    if (isMobile) return { inset: 0, width: 'var(--app-width, 100vw)', height: 'var(--app-height, 100dvh)' }
    if (isMaximized) return { inset: VIEWPORT_MARGIN }
    return {
      left: geometry.x,
      top: geometry.y,
      width: geometry.width,
      height: geometry.height,
    }
  }, [geometry, isMaximized, isMobile])

  if (!isOpen) return null

  const canValidate = Boolean(selectedDevice)
    && candidatePhone.length >= 7
    && candidatePhone.length <= 15
    && validation.status !== 'checking'
  const canSubmit = validation.status === 'valid' && Boolean(selectedDevice) && !submitting
  const isExistingWithoutMessage = Boolean(validation.existingChat?.id && !initialMessage.trim())

  return (
    <div
      className="app-viewport fixed inset-0 z-[70] bg-slate-950/45 backdrop-blur-[2px]"
      onMouseDown={event => {
        if (event.target === event.currentTarget) requestClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-chat-title"
        aria-describedby="new-chat-description"
        aria-busy={submitting}
        tabIndex={-1}
        className={`${isMobile ? 'absolute' : 'fixed'} flex flex-col overflow-hidden bg-white outline-none ${
          !isInteracting ? 'transition-[inset,width,height,border-radius,box-shadow] duration-200 ease-out' : ''
        } ${
          isMobile
            ? 'rounded-none'
            : isMaximized
              ? 'rounded-2xl border border-slate-200 shadow-2xl'
              : 'rounded-3xl border border-slate-200/90 shadow-[0_24px_80px_rgba(15,23,42,0.30)] ring-1 ring-black/5'
        }`}
        style={panelStyle}
      >
        {!isMobile && !isMaximized && (Object.keys(RESIZE_CLASSES) as ResizeEdge[]).map(edge => (
          <div
            key={edge}
            aria-hidden="true"
            onPointerDown={event => beginResize(edge, event)}
            className={`absolute z-30 ${RESIZE_CLASSES[edge]}`}
          />
        ))}

        <header
          onPointerDown={beginDrag}
          onDoubleClick={() => {
            if (!isMobile) setIsMaximized(current => !current)
          }}
          className={`flex h-[72px] shrink-0 items-center justify-between gap-4 border-b border-slate-200 bg-gradient-to-r from-white via-white to-emerald-50/50 px-4 sm:px-6 ${
            !isMobile && !isMaximized ? 'cursor-move' : ''
          }`}
        >
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-emerald-600 text-white shadow-sm shadow-emerald-600/25">
              <MessageCircle className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <h2 id="new-chat-title" className="truncate text-base font-semibold text-slate-900 sm:text-lg">
                Nueva conversación
              </h2>
              <p id="new-chat-description" className="truncate text-xs text-slate-500">
                El número debe estar verificado por WhatsApp
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1" data-no-window-drag>
            {!isMobile && (
              <button
                type="button"
                onClick={() => setIsMaximized(current => !current)}
                className="flex h-10 w-10 items-center justify-center rounded-xl text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                aria-label={isMaximized ? 'Restaurar ventana' : 'Maximizar ventana'}
                title={isMaximized ? 'Restaurar' : 'Maximizar'}
              >
                {isMaximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </button>
            )}
            <button
              type="button"
              onClick={requestClose}
              disabled={submitting || retryingInitialMessage}
              className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:cursor-not-allowed disabled:opacity-40 sm:h-10 sm:w-10"
              aria-label={submitting || retryingInitialMessage ? 'Espera a que termine la operación' : 'Cerrar nueva conversación'}
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </header>

        {completion ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex flex-1 items-center justify-center overflow-y-auto p-6 sm:p-10">
              <div className="w-full max-w-md text-center">
                <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl bg-amber-100 text-amber-700">
                  <AlertCircle className="h-8 w-8" />
                </span>
                <h3 className="mt-5 text-xl font-semibold text-slate-900">Conversación creada</h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">{completion.warning}</p>
                <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-left text-sm text-amber-800">
                  No se perdió la conversación. Puedes reintentar el mismo mensaje ahora o enviarlo desde el panel de chat.
                </div>
                {retryInitialMessageError && (
                  <div className="mt-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-left text-sm text-red-800" role="alert">
                    {retryInitialMessageError}
                  </div>
                )}
              </div>
            </div>
            <footer className="flex shrink-0 flex-col-reverse gap-3 border-t border-slate-200 bg-slate-50/80 px-4 pt-4 sm:flex-row sm:justify-end sm:px-6" style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}>
              <button
                type="button"
                onClick={() => void retryInitialMessage()}
                disabled={retryingInitialMessage || !completion.to || !completion.initialMessage}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-amber-300 bg-white px-5 text-sm font-semibold text-amber-800 transition hover:bg-amber-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {retryingInitialMessage ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                {retryingInitialMessage ? 'Reintentando…' : 'Reintentar mensaje'}
              </button>
              <button
                type="button"
                onClick={() => onCloseRef.current()}
                disabled={retryingInitialMessage}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 text-sm font-semibold text-white shadow-sm shadow-emerald-600/20 transition hover:bg-emerald-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
              >
                Abrir conversación <ChevronRight className="h-4 w-4" />
              </button>
            </footer>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
            <fieldset disabled={submitting} className="contents">
            <div className="flex-1 space-y-5 overflow-y-auto bg-slate-50/40 px-4 py-5 sm:px-6">
              <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm shadow-slate-200/40">
                <div className="mb-3 flex items-center gap-3">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-700">1</span>
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900">Dispositivo de envío</h3>
                    <p className="text-xs text-slate-500">Solo conexiones de WhatsApp Web disponibles</p>
                  </div>
                </div>

                {compatibleDevices.length > 0 ? (
                  <div className="relative">
                    <Smartphone className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                    <select
                      value={selectedDevice}
                      onChange={event => handleDeviceChange(event.target.value)}
                      className="min-h-11 w-full appearance-none rounded-xl border border-slate-300 bg-white py-2.5 pl-10 pr-10 text-sm font-medium text-slate-800 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
                      aria-label="Dispositivo de WhatsApp"
                    >
                      <option value="">Seleccionar dispositivo</option>
                      {compatibleDevices.map(device => (
                        <option key={device.id} value={device.id}>
                          {device.name}{device.phone ? ` · ${device.phone}` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3" role="status">
                    <WifiOff className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
                    <div>
                      <p className="text-sm font-semibold text-amber-900">No hay dispositivos compatibles conectados</p>
                      <p className="mt-0.5 text-xs leading-5 text-amber-800">
                        Conecta un dispositivo de WhatsApp Web para iniciar una conversación manual.
                      </p>
                    </div>
                  </div>
                )}
              </section>

              <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm shadow-slate-200/40">
                <div className="mb-3 flex items-center gap-3">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-700">2</span>
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900">Destinatario</h3>
                    <p className="text-xs text-slate-500">Busca un contacto o escribe un número internacional</p>
                  </div>
                </div>

                <div className="mb-4 grid grid-cols-2 rounded-xl bg-slate-100 p-1" role="tablist" aria-label="Forma de elegir destinatario">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mode === 'search'}
                    onClick={() => changeMode('search')}
                    className={`flex min-h-10 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                      mode === 'search' ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    <Search className="h-4 w-4" /> Contacto
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mode === 'manual'}
                    onClick={() => changeMode('manual')}
                    className={`flex min-h-10 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                      mode === 'manual' ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    <Phone className="h-4 w-4" /> Número
                  </button>
                </div>

                {mode === 'search' ? (
                  <div>
                    <label htmlFor="new-chat-contact-search" className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-600">
                      Buscar contacto
                    </label>
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                      <input
                        id="new-chat-contact-search"
                        type="search"
                        autoComplete="off"
                        value={searchTerm}
                        onChange={event => handleSearchChange(event.target.value)}
                        placeholder="Nombre, teléfono, correo u organización…"
                        className="min-h-11 w-full rounded-xl border border-slate-300 bg-white py-2.5 pl-10 pr-10 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
                        role="combobox"
                        aria-autocomplete="list"
                        aria-controls="new-chat-contact-results"
                        aria-expanded={searchTerm.trim().length >= 2 && !selectedContact}
                      />
                      {searchLoading && <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-emerald-600" />}
                    </div>

                    {selectedContact ? (
                      <div className="mt-3 flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50/70 p-3">
                        {selectedContact.avatar_url ? (
                          <img
                            src={selectedContact.avatar_url}
                            alt=""
                            loading="lazy"
                            className="h-10 w-10 shrink-0 rounded-full object-cover ring-2 ring-white"
                          />
                        ) : (
                          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 ring-2 ring-white">
                            <User className="h-5 w-5" />
                          </span>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-slate-900">{getContactDisplayName(selectedContact)}</p>
                          <p className="truncate text-xs text-slate-600">{formatPhone(selectedContact.phone || '')}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleSearchChange('')}
                          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-white hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                          aria-label="Cambiar contacto"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    ) : searchTerm.trim().length >= 2 ? (
                      <div id="new-chat-contact-results" className="mt-2 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg shadow-slate-200/50" role="listbox">
                        {searchLoading ? (
                          <div className="flex min-h-24 items-center justify-center gap-2 px-4 text-sm text-slate-500" role="status">
                            <Loader2 className="h-4 w-4 animate-spin text-emerald-600" /> Buscando contactos…
                          </div>
                        ) : searchError ? (
                          <div className="flex min-h-28 flex-col items-center justify-center px-4 py-4 text-center">
                            <AlertCircle className="h-5 w-5 text-red-500" />
                            <p className="mt-2 text-sm font-medium text-slate-800">No pudimos cargar los contactos</p>
                            <p className="mt-0.5 text-xs text-slate-500">{searchError}</p>
                            <button
                              type="button"
                              onClick={() => searchContacts(searchTerm, 0, false)}
                              className="mt-3 inline-flex min-h-9 items-center gap-2 rounded-lg px-3 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                            >
                              <RefreshCw className="h-3.5 w-3.5" /> Reintentar
                            </button>
                          </div>
                        ) : contacts.length === 0 ? (
                          <div className="flex min-h-28 flex-col items-center justify-center px-4 py-4 text-center">
                            <User className="h-6 w-6 text-slate-300" />
                            <p className="mt-2 text-sm font-medium text-slate-700">No encontramos contactos con teléfono</p>
                            <button
                              type="button"
                              onClick={() => changeMode('manual')}
                              className="mt-2 text-xs font-semibold text-emerald-700 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                            >
                              Escribir un número internacional
                            </button>
                          </div>
                        ) : (
                          <div className="max-h-52 overflow-y-auto p-1.5">
                            {contacts.map(contact => (
                              <button
                                key={contact.id}
                                type="button"
                                role="option"
                                aria-selected={false}
                                onClick={() => handleSelectContact(contact)}
                                className="flex min-h-12 w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition hover:bg-slate-50 focus:outline-none focus-visible:bg-emerald-50 focus-visible:ring-2 focus-visible:ring-emerald-500"
                              >
                                {contact.avatar_url ? (
                                  <img src={contact.avatar_url} alt="" loading="lazy" className="h-9 w-9 shrink-0 rounded-full object-cover" />
                                ) : (
                                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500">
                                    <User className="h-4 w-4" />
                                  </span>
                                )}
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-sm font-medium text-slate-900">{getContactDisplayName(contact)}</span>
                                  <span className="block truncate text-xs text-slate-500">
                                    {formatPhone(contact.phone || '')}{contact.company ? ` · ${contact.company}` : ''}
                                  </span>
                                </span>
                                <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" />
                              </button>
                            ))}
                            {searchHasMore && (
                              <button
                                type="button"
                                onClick={() => searchContacts(searchTerm, contacts.length, true)}
                                disabled={searchLoadingMore}
                                className="mt-1 flex min-h-10 w-full items-center justify-center gap-2 rounded-lg text-xs font-semibold text-emerald-700 transition hover:bg-emerald-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-60"
                              >
                                {searchLoadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                                {searchLoadingMore ? 'Cargando…' : `Cargar más (${contacts.length} de ${searchTotal})`}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    ) : (
                      <p className="mt-2 text-xs text-slate-500">Escribe al menos 2 caracteres para buscar.</p>
                    )}
                  </div>
                ) : (
                  <div className="grid grid-cols-[108px_minmax(0,1fr)] gap-3">
                    <div>
                      <label htmlFor="new-chat-country-code" className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-600">
                        País
                      </label>
                      <input
                        id="new-chat-country-code"
                        type="tel"
                        inputMode="tel"
                        list="new-chat-country-codes"
                        value={countryCode}
                        onChange={event => handleCountryCodeChange(event.target.value)}
                        className="min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-semibold text-slate-900 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
                        aria-label="Código internacional de país"
                      />
                      <datalist id="new-chat-country-codes">
                        {COUNTRY_CODES.map(country => <option key={country.code} value={country.code}>{country.country}</option>)}
                      </datalist>
                    </div>
                    <div>
                      <label htmlFor="new-chat-phone" className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-600">
                        Teléfono
                      </label>
                      <input
                        id="new-chat-phone"
                        type="tel"
                        inputMode="tel"
                        autoComplete="tel-national"
                        value={manualPhone}
                        onChange={event => handleManualPhoneChange(event.target.value)}
                        placeholder="999 888 777"
                        className="min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-medium text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
                      />
                    </div>
                    <p className="col-span-2 -mt-1 text-xs text-slate-500">
                      Vista previa: <span className="font-semibold text-slate-700">{candidatePhone ? formatPhone(candidatePhone) : '—'}</span>
                    </p>
                  </div>
                )}

                <div className="mt-4 border-t border-slate-100 pt-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0" aria-live="polite">
                      {validation.status === 'idle' && (
                        <p className="text-xs leading-5 text-slate-500">Valida el destinatario para confirmar que existe en WhatsApp.</p>
                      )}
                      {validation.status === 'checking' && (
                        <p className="flex items-center gap-2 text-sm font-medium text-slate-700" role="status">
                          <Loader2 className="h-4 w-4 animate-spin text-emerald-600" /> Verificando con WhatsApp…
                        </p>
                      )}
                      {validation.status === 'valid' && (
                        <div className="flex items-start gap-2 text-emerald-700">
                          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                          <div className="min-w-0">
                            <p className="text-sm font-semibold">Número verificado</p>
                            <p className="truncate text-xs">
                              {validation.verifiedName ? `${validation.verifiedName} · ` : ''}{formatPhone(validation.normalizedPhone || candidatePhone)}
                            </p>
                          </div>
                        </div>
                      )}
                      {validation.status === 'invalid' && (
                        <div className="flex items-start gap-2 text-red-700" role="alert">
                          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                          <p className="text-xs leading-5">{validation.message}</p>
                        </div>
                      )}
                      {validation.status === 'error' && (
                        <div className="flex items-start gap-2 text-amber-800" role="alert">
                          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                          <p className="text-xs leading-5">{validation.message}</p>
                        </div>
                      )}
                    </div>
                    {validation.status !== 'valid' && (
                      <button
                        type="button"
                        onClick={validatePhone}
                        disabled={!canValidate}
                        className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 text-sm font-semibold text-emerald-700 transition hover:border-emerald-300 hover:bg-emerald-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400"
                      >
                        {validation.status === 'checking' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                        Validar número
                      </button>
                    )}
                  </div>

                  {validation.status === 'valid' && validation.existingChat && (
                    <div className="mt-3 flex items-start gap-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2.5 text-sky-800">
                      <MessageCircle className="mt-0.5 h-4 w-4 shrink-0" />
                      <p className="text-xs leading-5">
                        Ya existe una conversación con este número. Se abrirá el historial actual, sin crear duplicados.
                      </p>
                    </div>
                  )}
                </div>
              </section>

              <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm shadow-slate-200/40">
                <div className="mb-3 flex items-center gap-3">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-bold text-slate-600">3</span>
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900">Mensaje inicial</h3>
                    <p className="text-xs text-slate-500">Opcional; también puedes escribir después de abrir el chat</p>
                  </div>
                </div>
                <textarea
                  value={initialMessage}
                  onChange={event => setInitialMessage(event.target.value)}
                  placeholder="Escribe un mensaje de bienvenida…"
                  rows={3}
                  maxLength={4096}
                  className="w-full resize-y rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm leading-6 text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
                />
                <p className="mt-1 text-right text-[11px] text-slate-400">{initialMessage.length}/4096</p>
              </section>

              {submitError && (
                <div className="flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-red-800" role="alert">
                  <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
                  <p className="text-sm leading-5">{submitError}</p>
                </div>
              )}
            </div>

            <footer className="flex shrink-0 flex-col-reverse gap-3 border-t border-slate-200 bg-white px-4 pt-4 sm:flex-row sm:items-center sm:justify-end sm:px-6" style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}>
              <button
                type="button"
                onClick={requestClose}
                disabled={submitting}
                className="inline-flex min-h-11 items-center justify-center rounded-xl border border-slate-300 bg-white px-5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={!canSubmit}
                className="inline-flex min-h-11 min-w-[180px] items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 text-sm font-semibold text-white shadow-sm shadow-emerald-600/25 transition hover:bg-emerald-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none"
              >
                {submitting ? (
                  <><Loader2 className="h-4 w-4 animate-spin" /> Iniciando…</>
                ) : isExistingWithoutMessage ? (
                  <><MessageCircle className="h-4 w-4" /> Abrir conversación</>
                ) : validation.existingChat ? (
                  <><Send className="h-4 w-4" /> Enviar y abrir</>
                ) : (
                  <><Send className="h-4 w-4" /> Iniciar conversación</>
                )}
              </button>
            </footer>
            </fieldset>
          </form>
        )}
      </div>
    </div>
  )
}
