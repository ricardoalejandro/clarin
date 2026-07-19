'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import {
  Radio, Settings2, Eye, Paperclip, X, CalendarClock,
  Image, Video, AudioLines, File, FileText, FileAudio, Send, Smile,
  Plus, Trash2, Table2, ClipboardPaste, ChevronDown, ChevronUp, AlertTriangle
} from 'lucide-react'
import { format } from 'date-fns'
import { es } from 'date-fns/locale'
import MessageBubble from '@/components/chat/MessageBubble'
import WhatsAppTextInput, { WhatsAppTextInputHandle } from '@/components/WhatsAppTextInput'
import EmojiPicker from '@/components/chat/EmojiPicker'
import { useAccessibleDialog } from '@/components/pipelines/useAccessibleDialog'
import { compressImageStandard } from '@/utils/imageCompression'

interface Device {
  id: string
  name: string
  phone?: string | null
  phone_number?: string
  status: string
}

export interface CampaignAttachment {
  id?: string
  media_url: string
  media_type: string
  caption: string
  file_name: string
  file_size: number
  position: number
  _localPreview?: string
  _uploading?: boolean
}

export interface CampaignRecipientRow {
  celular: string
  nombre_corto: string
  [key: string]: string
}

export interface CampaignFormResult {
  name: string
  device_id: string
  message_template: string
  attachments: {
    media_url: string
    media_type: string
    caption: string
    file_name: string
    file_size: number
    position: number
  }[]
  settings: {
    min_delay_seconds: number
    max_delay_seconds: number
    batch_size: number
    batch_pause_minutes: number
    daily_limit: number
    active_hours_start: string
    active_hours_end: string
    simulate_typing: boolean
    randomize_message: boolean
  }
  scheduled_at?: string
  recipients?: { phone: string; name?: string; metadata?: Record<string, string> }[]
}

interface CreateCampaignModalProps {
  open: boolean
  onClose: () => void
  onSubmit: (data: CampaignFormResult) => Promise<void>
  devices: Device[]
  infoPanel?: React.ReactNode
  title?: string
  subtitle?: string
  accentColor?: 'green' | 'purple'
  submitLabel?: string
  submitting?: boolean
  initialName?: string
  initialData?: {
    device_id?: string
    message_template?: string
    attachments?: CampaignAttachment[]
    settings?: Record<string, any>
    scheduled_at?: string | null
  }
}

const ACCEPTED_TYPES: Record<string, string[]> = {
  image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
  video: ['video/mp4', 'video/3gpp', 'video/quicktime'],
  audio: ['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/opus', 'audio/aac'],
  document: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
}

const BASE_VARIABLES = [
  { label: 'Nombre', value: '{{nombre}}' },
  { label: 'Nombre completo', value: '{{nombre_completo}}' },
  { label: 'Nombre corto', value: '{{nombre_corto}}' },
  { label: 'Celular', value: '{{celular}}' },
]

const DEFAULT_COLUMNS = ['celular', 'nombre_corto']
const MOBILE_RECIPIENT_PAGE_SIZE = 20
const MOBILE_STEPS = [
  { id: 'message', label: 'Mensaje' },
  { id: 'recipients', label: 'Destinatarios' },
  { id: 'settings', label: 'Configuración' },
  { id: 'review', label: 'Revisión' },
] as const
type MobileStep = typeof MOBILE_STEPS[number]['id']

// ─── TSV / CSV parser ────────────────────────────────────────────────
interface ParseResult {
  rows: Record<string, string>[]
  detectedColumns?: string[] // only set if headers were auto-detected
  duplicatesRemoved: number
}

const HEADER_SYNONYMS: Record<string, string> = {
  celular: 'celular', telefono: 'celular', teléfono: 'celular', phone: 'celular', cel: 'celular', móvil: 'celular', movil: 'celular',
  nombre: 'nombre_corto', nombre_corto: 'nombre_corto', name: 'nombre_corto',
  email: 'email', correo: 'email',
  empresa: 'empresa', company: 'empresa',
}

function parsePastedText(
  text: string,
  currentColumns: string[],
  existingRows: Record<string, string>[],
): ParseResult {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n').filter(l => l.trim())
  if (lines.length === 0) return { rows: [], duplicatesRemoved: 0 }
  const sample = lines[0]
  const tabCount = (sample.match(/\t/g) || []).length
  const commaCount = (sample.match(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/g) || []).length
  const semiCount = (sample.match(/;/g) || []).length
  const sep = tabCount >= commaCount && tabCount >= semiCount ? '\t'
    : commaCount >= semiCount ? ',' : ';'
  const splitLine = (line: string): string[] => {
    const cells: string[] = []
    let cur = ''
    let inQuote = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') { inQuote = !inQuote }
      else if (ch === sep && !inQuote) { cells.push(cur.trim().replace(/^["']|["']$/g, '')); cur = '' }
      else { cur += ch }
    }
    cells.push(cur.trim().replace(/^["']|["']$/g, ''))
    return cells
  }
  // Detect headers
  const firstCells = splitLine(lines[0])
  const hasHeaders = firstCells.some(c => HEADER_SYNONYMS[c.toLowerCase().trim()] !== undefined)
  let columns = [...currentColumns]
  let detectedColumns: string[] | undefined
  if (hasHeaders) {
    // Map headers to canonical column names
    const mapped = firstCells.map(h => HEADER_SYNONYMS[h.toLowerCase().trim()] || h.toLowerCase().trim().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')).filter(Boolean)
    // Add any new columns not already present
    const newCols = mapped.filter(c => c && !columns.includes(c))
    if (newCols.length > 0) {
      columns = [...columns, ...newCols]
      detectedColumns = columns
    }
    // Use detected column order for mapping
    const dataLines = lines.slice(1)
    const parsed = dataLines.map(line => {
      const cells = splitLine(line)
      const row: Record<string, string> = {}
      columns.forEach(col => { row[col] = '' }) // init all
      mapped.forEach((col, i) => { if (col && cells[i]) row[col] = cells[i] })
      return row
    }).filter(r => r.celular?.replace(/[^0-9]/g, ''))
    // Deduplicate by phone (existing + new, first wins)
    const seen = new Set(existingRows.map(r => r.celular?.replace(/[^0-9]/g, '')).filter(Boolean))
    let dupes = 0
    const unique = parsed.filter(r => {
      const phone = r.celular?.replace(/[^0-9]/g, '') || ''
      if (!phone || seen.has(phone)) { dupes++; return false }
      seen.add(phone)
      return true
    })
    return { rows: unique, detectedColumns, duplicatesRemoved: dupes }
  }
  // No headers — map positionally to current columns
  const dataLines = lines
  const parsed = dataLines.map(line => {
    const cells = splitLine(line)
    const row: Record<string, string> = {}
    columns.forEach((col, i) => { row[col] = cells[i] || '' })
    return row
  }).filter(r => r.celular?.replace(/[^0-9]/g, ''))
  // Deduplicate
  const seen = new Set(existingRows.map(r => r.celular?.replace(/[^0-9]/g, '')).filter(Boolean))
  let dupes = 0
  const unique = parsed.filter(r => {
    const phone = r.celular?.replace(/[^0-9]/g, '') || ''
    if (!phone || seen.has(phone)) { dupes++; return false }
    seen.add(phone)
    return true
  })
  return { rows: unique, duplicatesRemoved: dupes }
}

export default function CreateCampaignModal({
  open,
  onClose,
  onSubmit,
  devices,
  infoPanel,
  title = 'Nueva Campaña',
  subtitle,
  accentColor = 'green',
  submitLabel,
  submitting = false,
  initialName = '',
  initialData,
}: CreateCampaignModalProps) {
  const [formData, setFormData] = useState({
    name: '',
    device_id: '',
    message_template: '',
    min_delay: 8,
    max_delay: 15,
    batch_size: 25,
    batch_pause: 2,
    daily_limit: 1000,
    active_hours_start: '07:00',
    active_hours_end: '22:00',
    simulate_typing: true,
    scheduled_date: '',
    scheduled_time: '',
  })
  const [attachments, setAttachments] = useState<CampaignAttachment[]>([])
  const [showAttachMenu, setShowAttachMenu] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const attachMenuRef = useRef<HTMLDivElement>(null)
  const attachInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<WhatsAppTextInputHandle>(null)

  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null

  const [showEmoji, setShowEmoji] = useState(false)

  // Spreadsheet recipients
  const [sheetColumns, setSheetColumns] = useState<string[]>([...DEFAULT_COLUMNS])
  const [sheetRows, setSheetRows] = useState<Record<string, string>[]>([])
  const [showSheet, setShowSheet] = useState(false)
  const [newColName, setNewColName] = useState('')
  const [showAddCol, setShowAddCol] = useState(false)
  const [pasteInfo, setPasteInfo] = useState<{ added: number; dupes: number } | null>(null)
  const [mobileRecipientPage, setMobileRecipientPage] = useState(0)

  // Right column sections collapse state
  const [showSettings, setShowSettings] = useState(false)
  const [showSchedule, setShowSchedule] = useState(false)
  const [mobileStep, setMobileStep] = useState<MobileStep>('message')
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  const handleCampaignEscape = useCallback(() => {
    if (showAttachMenu) { setShowAttachMenu(false); return }
    if (showEmoji) { setShowEmoji(false); return }
    if (showAddCol) { setShowAddCol(false); setNewColName(''); return }
    onClose()
  }, [onClose, showAddCol, showAttachMenu, showEmoji])
  useAccessibleDialog(open, dialogRef, handleCampaignEscape, closeButtonRef)

  // Reset form when modal opens
  useEffect(() => {
    if (open) {
      const s = initialData?.settings || {}
      let schedDate = ''
      let schedTime = ''
      if (initialData?.scheduled_at) {
        const dt = new Date(initialData.scheduled_at)
        schedDate = dt.toISOString().split('T')[0]
        schedTime = dt.toTimeString().slice(0, 5)
      }
      setFormData({
        name: initialName,
        device_id: initialData?.device_id || '',
        message_template: initialData?.message_template || '',
        min_delay: s.min_delay_seconds ?? 8,
        max_delay: s.max_delay_seconds ?? 15,
        batch_size: s.batch_size ?? 25,
        batch_pause: s.batch_pause_minutes ?? 2,
        daily_limit: s.daily_limit ?? 1000,
        active_hours_start: s.active_hours_start || '07:00',
        active_hours_end: s.active_hours_end || '22:00',
        simulate_typing: s.simulate_typing ?? true,
        scheduled_date: schedDate,
        scheduled_time: schedTime,
      })
      attachments.forEach(a => { if (a._localPreview) URL.revokeObjectURL(a._localPreview) })
      setAttachments(initialData?.attachments || [])
      setShowPreview(false)
      setSheetRows([])
      setSheetColumns([...DEFAULT_COLUMNS])
      setShowSheet(false)
      setShowAddCol(false)
      setNewColName('')
      setPasteInfo(null)
      setMobileRecipientPage(0)
      setMobileStep('message')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Close attach menu on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (attachMenuRef.current && !attachMenuRef.current.contains(e.target as Node)) {
        setShowAttachMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const getMediaType = (mimeType: string): string => {
    if (ACCEPTED_TYPES.image.includes(mimeType)) return 'image'
    if (ACCEPTED_TYPES.video.includes(mimeType)) return 'video'
    if (ACCEPTED_TYPES.audio.includes(mimeType)) return 'audio'
    return 'document'
  }

  const handleAttachFile = async (file: File, mediaType: string) => {
    if (attachments.length >= 10) { alert('Máximo 10 adjuntos por campaña'); return }
    if (file.size > 32 * 1024 * 1024) { alert('El archivo es demasiado grande. Máximo 32MB.'); return }
    if (mediaType === 'video' && file.size > 15 * 1024 * 1024) { alert('El video es demasiado grande. Máximo 15 MB.'); return }
    let fileToSend = file
    if (mediaType === 'image') {
      try { fileToSend = await compressImageStandard(file) } catch (err) { console.warn('[Campaign] Image compression failed, using original:', err) }
    }
    const localPreview = ['image', 'video'].includes(mediaType) ? URL.createObjectURL(fileToSend) : undefined
    const tempAttachment: CampaignAttachment = {
      media_url: '', media_type: mediaType, caption: '', file_name: fileToSend.name,
      file_size: fileToSend.size, position: attachments.length, _localPreview: localPreview, _uploading: true,
    }
    setAttachments(prev => [...prev, tempAttachment])
    const idx = attachments.length
    try {
      const fd = new FormData()
      fd.append('file', fileToSend)
      fd.append('folder', 'uploads')
      const uploadRes = await fetch('/api/media/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      })
      const uploadData = await uploadRes.json()
      if (!uploadData.success) throw new Error(uploadData.error || 'Error al subir archivo')
      const url = uploadData.proxy_url || uploadData.public_url
      setAttachments(prev => prev.map((a, i) => i === idx ? { ...a, media_url: url, _uploading: false } : a))
    } catch (err) {
      alert('Error al subir archivo: ' + (err instanceof Error ? err.message : 'desconocido'))
      setAttachments(prev => prev.filter((_, i) => i !== idx))
      if (localPreview) URL.revokeObjectURL(localPreview)
    }
  }

  const handleAttachSelect = (accept: string) => {
    setShowAttachMenu(false)
    if (attachInputRef.current) {
      attachInputRef.current.accept = accept
      attachInputRef.current.click()
    }
  }

  const handleAttachInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    handleAttachFile(file, getMediaType(file.type))
    if (attachInputRef.current) attachInputRef.current.value = ''
  }

  const removeAttachment = (index: number) => {
    setAttachments(prev => {
      const a = prev[index]
      if (a._localPreview) URL.revokeObjectURL(a._localPreview)
      return prev.filter((_, i) => i !== index).map((att, i) => ({ ...att, position: i }))
    })
  }

  const updateAttachmentCaption = (index: number, caption: string) => {
    setAttachments(prev => prev.map((a, i) => i === index ? { ...a, caption } : a))
  }

  // ─── Spreadsheet helpers ─────────────────────────────
  const addSheetRow = useCallback(() => {
    const emptyRow: Record<string, string> = {}
    sheetColumns.forEach(col => { emptyRow[col] = '' })
    setSheetRows(prev => [...prev, emptyRow])
    setMobileRecipientPage(Math.floor(sheetRows.length / MOBILE_RECIPIENT_PAGE_SIZE))
  }, [sheetColumns, sheetRows.length])

  const updateSheetCell = useCallback((rowIdx: number, col: string, value: string) => {
    setSheetRows(prev => prev.map((r, i) => i === rowIdx ? { ...r, [col]: value } : r))
  }, [])

  const removeSheetRow = useCallback((rowIdx: number) => {
    setSheetRows(prev => prev.filter((_, i) => i !== rowIdx))
  }, [])

  const addColumn = useCallback(() => {
    const name = newColName.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
    if (!name || sheetColumns.includes(name)) return
    setSheetColumns(prev => [...prev, name])
    setSheetRows(prev => prev.map(r => ({ ...r, [name]: '' })))
    setNewColName('')
    setShowAddCol(false)
  }, [newColName, sheetColumns])

  const removeColumn = useCallback((col: string) => {
    if (col === 'celular') return // can't remove phone
    setSheetColumns(prev => prev.filter(c => c !== col))
    setSheetRows(prev => prev.map(r => { const { [col]: _, ...rest } = r; return rest }))
  }, [])

  const handleSheetPaste = useCallback((e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData('text')
    const pasteTarget = e.target instanceof HTMLElement
      ? e.target.closest('[data-campaign-paste-catcher="true"]')
      : null
    if (!text || (!pasteTarget && !text.includes('\n') && !text.includes('\t'))) return
    e.preventDefault()
    const result = parsePastedText(text, sheetColumns, sheetRows)
    if (result.detectedColumns) {
      setSheetColumns(result.detectedColumns)
    }
    if (result.rows.length > 0) {
      setSheetRows(prev => [...prev, ...result.rows])
      setMobileRecipientPage(0)
    }
    setPasteInfo({ added: result.rows.length, dupes: result.duplicatesRemoved })
    setTimeout(() => setPasteInfo(null), 4000)
  }, [sheetColumns, sheetRows])

  // Dynamic variables from spreadsheet custom columns
  const customColumns = sheetColumns.filter(c => !DEFAULT_COLUMNS.includes(c))
  const allVariables = [
    ...BASE_VARIABLES,
    ...customColumns.map(c => ({ label: c, value: `{{${c}}}` })),
  ]

  // Compute valid sheet recipients
  const validSheetRows = sheetRows.filter(r => r.celular?.replace(/[^0-9]/g, '').length >= 7)
  const mobileRecipientPageCount = Math.max(1, Math.ceil(sheetRows.length / MOBILE_RECIPIENT_PAGE_SIZE))
  const safeMobileRecipientPage = Math.min(mobileRecipientPage, mobileRecipientPageCount - 1)
  const mobileRecipientStart = safeMobileRecipientPage * MOBILE_RECIPIENT_PAGE_SIZE
  const mobileRecipientRows = sheetRows.slice(mobileRecipientStart, mobileRecipientStart + MOBILE_RECIPIENT_PAGE_SIZE)

  const connectedDevices = devices.filter(d => d.status === 'connected')
  const accent = accentColor === 'purple' ? {
    ring: 'focus:ring-purple-500', bg: 'bg-purple-600', bgHover: 'hover:bg-purple-700',
    light: 'bg-purple-50 text-purple-700 border-purple-200', hoverLight: 'hover:bg-purple-100',
  } : {
    ring: 'focus:ring-green-500', bg: 'bg-green-600', bgHover: 'hover:bg-green-700',
    light: 'bg-green-50 text-green-700 border-green-200', hoverLight: 'hover:bg-green-100',
  }

  const hasSchedule = !!(formData.scheduled_date && formData.scheduled_time)
  const readyAttachments = attachments.filter(a => a.media_url)
  const canSubmit = formData.name && formData.device_id &&
    (formData.message_template || readyAttachments.length > 0) &&
    !attachments.some(a => a._uploading) && !submitting

  const handleSubmit = async () => {
    let scheduledAt: string | undefined
    if (hasSchedule) {
      const dt = new Date(`${formData.scheduled_date}T${formData.scheduled_time}:00`)
      const now = new Date()
      if (dt <= now) { alert('La fecha programada debe ser en el futuro'); return }
      if (dt > new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)) {
        alert('La fecha programada no puede ser mayor a 1 semana'); return
      }
      scheduledAt = dt.toISOString()
    }
    // Build recipients from spreadsheet rows
    const recipients = validSheetRows.map(r => {
      const phone = r.celular.replace(/[^0-9]/g, '')
      const meta: Record<string, string> = {}
      sheetColumns.forEach(col => {
        if (col !== 'celular' && col !== 'nombre_corto' && r[col]) meta[col] = r[col]
      })
      return {
        phone,
        name: r.nombre_corto || undefined,
        metadata: Object.keys(meta).length > 0 ? meta : undefined,
      }
    })
    await onSubmit({
      name: formData.name,
      device_id: formData.device_id,
      message_template: formData.message_template,
      attachments: readyAttachments.map(a => ({
        media_url: a.media_url, media_type: a.media_type, caption: a.caption,
        file_name: a.file_name, file_size: a.file_size, position: a.position,
      })),
      settings: {
        min_delay_seconds: formData.min_delay,
        max_delay_seconds: formData.max_delay,
        batch_size: formData.batch_size,
        batch_pause_minutes: formData.batch_pause,
        daily_limit: formData.daily_limit,
        active_hours_start: formData.active_hours_start,
        active_hours_end: formData.active_hours_end,
        simulate_typing: formData.simulate_typing,
        randomize_message: true,
      },
      scheduled_at: scheduledAt,
      recipients: recipients.length > 0 ? recipients : undefined,
    })
  }

  const personalizeText = (text: string) => {
    let result = text
      .replace(/\{\{nombre\}\}/g, 'Juan')
      .replace(/\{\{nombre_completo\}\}/g, 'Juan Pérez López')
      .replace(/\{\{nombre_corto\}\}/g, 'Juanito')
      .replace(/\{\{celular\}\}/g, '+51999888777')
      .replace(/\{\{name\}\}/g, 'Juan')
      .replace(/\{\{telefono\}\}/g, '+51999888777')
      .replace(/\{\{phone\}\}/g, '+51999888777')
    // Replace custom column variables with sample values
    customColumns.forEach(col => {
      result = result.replace(new RegExp(`\\{\\{${col}\\}\\}`, 'g'), `[${col}]`)
    })
    return result
  }

  const defaultSubmitLabel = hasSchedule ? 'Programar Campaña' : 'Crear Campaña'
  const mobileStepIndex = MOBILE_STEPS.findIndex(step => step.id === mobileStep)

  if (!open) return null

  return (
    <div className="app-viewport fixed inset-0 z-[70] flex items-stretch justify-center bg-black/50 p-0 lg:items-center lg:p-3">
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="campaign-modal-title" className="campaign-dialog flex h-[var(--app-height)] w-full max-w-6xl flex-col overflow-hidden rounded-none bg-white pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] shadow-2xl outline-none lg:h-auto lg:max-h-[95vh] lg:rounded-xl lg:pl-0 lg:pr-0">
        {/* ─── Header ──────────────────────────────────────── */}
        <div className="campaign-dialog-header flex shrink-0 items-center justify-between gap-3 border-b border-gray-200 px-4 pb-3 pt-[max(.75rem,env(safe-area-inset-top))] lg:px-6 lg:py-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className={`campaign-dialog-icon w-9 h-9 rounded-lg flex items-center justify-center ${accentColor === 'purple' ? 'bg-purple-100' : 'bg-green-100'}`}>
              <Radio className={`w-5 h-5 ${accentColor === 'purple' ? 'text-purple-600' : 'text-green-600'}`} />
            </div>
            <div className="min-w-0">
              <h2 id="campaign-modal-title" className="truncate text-lg font-semibold text-gray-900">{title}</h2>
              {subtitle && <p className="campaign-dialog-subtitle truncate text-xs text-gray-500">{subtitle}</p>}
            </div>
          </div>
          <button ref={closeButtonRef} onClick={onClose} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-gray-400 transition hover:bg-gray-100 hover:text-gray-600" aria-label="Cerrar campaña">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="campaign-stepbar shrink-0 overflow-x-auto border-b border-gray-200 bg-white px-3 py-2 lg:hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="flex min-w-max gap-1" role="tablist" aria-label="Pasos de la campaña">
            {MOBILE_STEPS.map((step, index) => (
              <button key={step.id} type="button" role="tab" aria-selected={mobileStep === step.id} onClick={() => setMobileStep(step.id)} className={`flex min-h-11 items-center gap-2 rounded-xl px-3 text-xs font-semibold transition-colors ${mobileStep === step.id ? 'bg-emerald-50 text-emerald-700' : 'text-gray-500 hover:bg-gray-50'}`}>
                <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] ${mobileStep === step.id ? 'bg-emerald-600 text-white' : 'bg-gray-100 text-gray-500'}`}>{index + 1}</span>{step.label}
              </button>
            ))}
          </div>
        </div>

        {/* ─── Body: Two columns ───────────────────────────── */}
        <div className={`${mobileStep === 'review' ? 'hidden' : 'flex'} min-h-0 flex-1 flex-col overflow-y-auto lg:flex lg:flex-row lg:overflow-hidden`}>
          {/* ═══ LEFT COLUMN: Message & Attachments ═══ */}
          <div className={`${mobileStep === 'message' ? 'block' : 'hidden'} w-full space-y-4 p-4 lg:block lg:w-1/2 lg:overflow-y-auto lg:border-r lg:border-gray-200 lg:p-5`}>
            {infoPanel}

            {/* Name + Device row */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Nombre *</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={e => setFormData({ ...formData, name: e.target.value })}
                  className={`w-full px-3 py-2 border border-gray-300 rounded-lg ${accent.ring} focus:ring-2 focus:border-transparent text-sm text-gray-900`}
                  placeholder="Ej: Campaña #001"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Dispositivo *</label>
                <select
                  value={formData.device_id}
                  onChange={e => setFormData({ ...formData, device_id: e.target.value })}
                  className={`w-full px-3 py-2 border border-gray-300 rounded-lg ${accent.ring} focus:ring-2 focus:border-transparent text-sm text-gray-900`}
                >
                  <option value="">Seleccionar...</option>
                  {connectedDevices.map(d => (
                    <option key={d.id} value={d.id}>{d.name} ({d.phone || d.phone_number || '—'})</option>
                  ))}
                </select>
                {connectedDevices.length === 0 && (
                  <p className="text-[10px] text-red-500 mt-0.5">Sin dispositivos conectados</p>
                )}
              </div>
            </div>

            {/* Message */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Mensaje {attachments.length > 0 ? '(opcional)' : '*'}
              </label>
              <div className="flex flex-wrap gap-1 mb-1.5">
                {allVariables.map(v => (
                  <button
                    key={v.value}
                    type="button"
                    onClick={() => {
                      if (textareaRef.current) textareaRef.current.insertAtCaret(v.value)
                      else setFormData({ ...formData, message_template: formData.message_template + v.value })
                    }}
                    className={`px-2 py-0.5 text-[11px] border rounded-md transition ${customColumns.includes(v.label) ? 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100' : `${accent.light} ${accent.hoverLight}`}`}
                  >
                    + {v.label}
                  </button>
                ))}
              </div>
              <WhatsAppTextInput
                ref={textareaRef}
                value={formData.message_template}
                onChange={v => setFormData({ ...formData, message_template: v })}
                rows={5}
                placeholder="Hola {{nombre}}, te escribimos para..."
              />
              <div className="mt-1 flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-start gap-1">
                  <p className="min-w-0 break-words pt-2 text-[10px] text-gray-400">
                    Variables: {allVariables.map(v => v.value).join(', ')}
                  </p>
                  <EmojiPicker
                    onEmojiSelect={(emoji: string) => {
                      if (textareaRef.current) textareaRef.current.insertAtCaret(emoji)
                      else setFormData(f => ({ ...f, message_template: f.message_template + emoji }))
                      setShowEmoji(false)
                    }}
                    isOpen={showEmoji}
                    onToggle={() => setShowEmoji(!showEmoji)}
                    portalTarget={dialogRef.current}
                    buttonClassName="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-gray-400 hover:bg-gray-100 hover:text-gray-600 lg:h-8 lg:w-8"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setShowPreview(!showPreview)}
                  className="flex min-h-11 shrink-0 items-center gap-1 rounded-lg px-2 text-[11px] font-medium text-green-600 hover:bg-green-50 hover:text-green-700 lg:min-h-0 lg:py-1"
                >
                  <Eye className="w-3 h-3" />
                  {showPreview ? 'Ocultar' : 'Vista previa'}
                </button>
              </div>

              {/* Preview */}
              {showPreview && (formData.message_template || readyAttachments.length > 0) && (
                <div className="mt-2 p-3 bg-[#e5ddd5] rounded-lg space-y-1">
                  {(() => {
                    const singleAttachNoCaption = readyAttachments.length === 1 && !readyAttachments[0].caption
                    if (singleAttachNoCaption && formData.message_template) {
                      return (
                        <MessageBubble
                          message={{
                            id: 'preview-0', message_id: 'preview-0',
                            body: personalizeText(formData.message_template),
                            message_type: readyAttachments[0].media_type,
                            media_url: readyAttachments[0]._localPreview || readyAttachments[0].media_url,
                            is_from_me: true, is_read: false, status: 'sent',
                            timestamp: new Date().toISOString(),
                          }}
                        />
                      )
                    }
                    return (
                      <>
                        {formData.message_template && (
                          <MessageBubble
                            message={{
                              id: 'preview-text', message_id: 'preview-text',
                              body: personalizeText(formData.message_template),
                              message_type: 'text', is_from_me: true, is_read: false, status: 'sent',
                              timestamp: new Date().toISOString(),
                            }}
                          />
                        )}
                        {readyAttachments.map((att, i) => (
                          <MessageBubble
                            key={`preview-att-${i}`}
                            message={{
                              id: `preview-att-${i}`, message_id: `preview-att-${i}`,
                              body: att.caption ? personalizeText(att.caption) : undefined,
                              message_type: att.media_type,
                              media_url: att._localPreview || att.media_url,
                              media_filename: att.file_name,
                              is_from_me: true, is_read: false, status: 'sent',
                              timestamp: new Date().toISOString(),
                            }}
                          />
                        ))}
                      </>
                    )
                  })()}
                </div>
              )}
            </div>

            {/* Attachments */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1.5">Adjuntos ({attachments.length}/10)</label>
              <input type="file" ref={attachInputRef} onChange={handleAttachInputChange} className="hidden" />
              {attachments.length > 0 && (
                <div className="space-y-2 mb-2">
                  {attachments.map((att, i) => {
                    const TypeIcon = att.media_type === 'image' ? Image : att.media_type === 'video' ? Video : att.media_type === 'audio' ? AudioLines : File
                    const typeColors: Record<string, string> = { image: 'bg-purple-100 text-purple-600', video: 'bg-red-100 text-red-600', audio: 'bg-orange-100 text-orange-600', document: 'bg-blue-100 text-blue-600' }
                    return (
                      <div key={i} className="border border-gray-200 rounded-lg p-2.5 bg-gray-50">
                        <div className="flex items-center gap-2">
                          <div className="shrink-0">
                            {att._localPreview && att.media_type === 'image' ? (
                              <img src={att._localPreview} alt="" className="w-10 h-10 rounded object-cover" />
                            ) : att._localPreview && att.media_type === 'video' ? (
                              <video src={att._localPreview} className="w-10 h-10 rounded object-cover" />
                            ) : (
                              <div className={`w-10 h-10 rounded flex items-center justify-center ${typeColors[att.media_type] || typeColors.document}`}>
                                <TypeIcon className="w-4 h-4" />
                              </div>
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium text-gray-900 truncate">{att.file_name}</p>
                            <div className="flex items-center gap-1.5 text-[10px] text-gray-400">
                              <span className={`px-1 py-0.5 rounded text-[9px] font-medium ${typeColors[att.media_type] || typeColors.document}`}>
                                {att.media_type === 'image' ? 'IMG' : att.media_type === 'video' ? 'VID' : att.media_type === 'audio' ? 'AUD' : 'DOC'}
                              </span>
                              <span>{(att.file_size / 1024 / 1024).toFixed(1)} MB</span>
                              {att._uploading && <span className="text-amber-500 animate-pulse">Subiendo...</span>}
                            </div>
                          </div>
                          <button onClick={() => removeAttachment(i)} className="p-1 hover:bg-red-50 rounded text-red-400 hover:text-red-600 transition">
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        {att.media_type !== 'audio' && att.caption !== undefined && (
                          <div className="mt-2">
                            <div className="flex items-center justify-between mb-1">
                              <label className="flex items-center gap-1 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={att.caption !== ''}
                                  onChange={e => updateAttachmentCaption(i, e.target.checked ? ' ' : '')}
                                  className="rounded border-gray-300 text-green-600 focus:ring-green-500 w-3 h-3"
                                />
                                <span className="text-[10px] text-gray-500">Pie de foto</span>
                              </label>
                              {att.caption && (
                                <div className="flex flex-wrap gap-0.5">
                                  {allVariables.slice(0, 4).map(v => (
                                    <button
                                      key={v.value}
                                      type="button"
                                      onClick={() => updateAttachmentCaption(i, (att.caption || '') + v.value)}
                                      className="px-1 py-0.5 text-[9px] bg-green-50 text-green-700 border border-green-200 rounded hover:bg-green-100 transition"
                                    >
                                      + {v.label}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                            {att.caption && (
                              <WhatsAppTextInput
                                value={att.caption.trim() === '' ? '' : att.caption}
                                onChange={v => updateAttachmentCaption(i, v || ' ')}
                                rows={2}
                                placeholder="Texto del pie de foto..."
                              />
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
              {attachments.length < 10 && (
                <div ref={attachMenuRef} className="relative inline-block">
                  <button
                    type="button"
                    onClick={() => setShowAttachMenu(!showAttachMenu)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 border border-dashed border-gray-300 rounded-lg text-xs text-gray-600 hover:border-green-400 hover:text-green-600 hover:bg-green-50 transition"
                  >
                    <Paperclip className="w-3.5 h-3.5" />
                    Adjuntar archivo
                  </button>
                  {showAttachMenu && (
                    <div className="fixed inset-x-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-[60] rounded-xl border border-gray-200 bg-white p-1.5 shadow-xl lg:absolute lg:inset-x-auto lg:bottom-full lg:left-0 lg:mb-2 lg:min-w-44">
                      <div className="space-y-0.5">
                        <button onClick={() => handleAttachSelect(ACCEPTED_TYPES.image.join(','))} className="w-full flex items-center gap-2.5 px-2.5 py-2 hover:bg-purple-50 rounded-lg text-left">
                          <div className="w-7 h-7 bg-purple-100 rounded flex items-center justify-center"><Image className="w-3.5 h-3.5 text-purple-600" /></div>
                          <span className="text-xs font-medium text-gray-800">Imagen</span>
                        </button>
                        <button onClick={() => handleAttachSelect(ACCEPTED_TYPES.video.join(','))} className="w-full flex items-center gap-2.5 px-2.5 py-2 hover:bg-red-50 rounded-lg text-left">
                          <div className="w-7 h-7 bg-red-100 rounded flex items-center justify-center"><Video className="w-3.5 h-3.5 text-red-600" /></div>
                          <span className="text-xs font-medium text-gray-800">Video</span>
                        </button>
                        <button onClick={() => handleAttachSelect(ACCEPTED_TYPES.audio.join(','))} className="w-full flex items-center gap-2.5 px-2.5 py-2 hover:bg-orange-50 rounded-lg text-left">
                          <div className="w-7 h-7 bg-orange-100 rounded flex items-center justify-center"><FileAudio className="w-3.5 h-3.5 text-orange-600" /></div>
                          <span className="text-xs font-medium text-gray-800">Audio</span>
                        </button>
                        <button onClick={() => handleAttachSelect(ACCEPTED_TYPES.document.join(','))} className="w-full flex items-center gap-2.5 px-2.5 py-2 hover:bg-blue-50 rounded-lg text-left">
                          <div className="w-7 h-7 bg-blue-100 rounded flex items-center justify-center"><FileText className="w-3.5 h-3.5 text-blue-600" /></div>
                          <span className="text-xs font-medium text-gray-800">Documento</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* ═══ RIGHT COLUMN: Config + Spreadsheet ═══ */}
          <div className={`${mobileStep === 'recipients' || mobileStep === 'settings' ? 'block' : 'hidden'} w-full space-y-4 p-4 lg:block lg:w-1/2 lg:overflow-y-auto lg:p-5`}>
            <div className={`${mobileStep === 'settings' ? 'space-y-4' : 'hidden'} lg:block lg:space-y-4`}>
            {/* ── Anti-ban settings (collapsible) ── */}
            <div className="border border-gray-200 rounded-lg overflow-hidden">
              <button
                type="button"
                onClick={() => setShowSettings(!showSettings)}
                className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-50 hover:bg-gray-100 transition"
              >
                <div className="flex items-center gap-2">
                  <Settings2 className="w-4 h-4 text-gray-500" />
                  <span className="text-sm font-medium text-gray-700">Configuración Anti-Ban</span>
                </div>
                {showSettings ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
              </button>
              {showSettings && (
                <div className="p-4 border-t border-gray-200">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Delay mín (seg)</label>
                      <input type="number" value={formData.min_delay} onChange={e => setFormData({ ...formData, min_delay: +e.target.value })} className="w-full px-3 py-1.5 border border-gray-300 rounded text-sm text-gray-900" />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Delay máx (seg)</label>
                      <input type="number" value={formData.max_delay} onChange={e => setFormData({ ...formData, max_delay: +e.target.value })} className="w-full px-3 py-1.5 border border-gray-300 rounded text-sm text-gray-900" />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Tamaño del lote</label>
                      <input type="number" value={formData.batch_size} onChange={e => setFormData({ ...formData, batch_size: +e.target.value })} className="w-full px-3 py-1.5 border border-gray-300 rounded text-sm text-gray-900" />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Pausa entre lotes (min)</label>
                      <input type="number" value={formData.batch_pause} onChange={e => setFormData({ ...formData, batch_pause: +e.target.value })} className="w-full px-3 py-1.5 border border-gray-300 rounded text-sm text-gray-900" />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Límite diario</label>
                      <input type="number" value={formData.daily_limit} onChange={e => setFormData({ ...formData, daily_limit: +e.target.value })} className="w-full px-3 py-1.5 border border-gray-300 rounded text-sm text-gray-900" />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Horas activas</label>
                      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-1">
                        <input type="time" value={formData.active_hours_start} onChange={e => setFormData({ ...formData, active_hours_start: e.target.value })} className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs text-gray-900" />
                        <span className="text-xs text-gray-400">-</span>
                        <input type="time" value={formData.active_hours_end} onChange={e => setFormData({ ...formData, active_hours_end: e.target.value })} className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs text-gray-900" />
                      </div>
                    </div>
                  </div>
                  <label className="flex items-center gap-2 mt-3 cursor-pointer">
                    <input type="checkbox" checked={formData.simulate_typing} onChange={e => setFormData({ ...formData, simulate_typing: e.target.checked })} className="rounded border-gray-300 text-green-600 focus:ring-green-500" />
                    <span className="text-xs text-gray-600">Simular escritura (typing indicator)</span>
                  </label>
                </div>
              )}
            </div>

            {/* ── Schedule (collapsible) ── */}
            <div className="border border-gray-200 rounded-lg overflow-hidden">
              <button
                type="button"
                onClick={() => setShowSchedule(!showSchedule)}
                className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-50 hover:bg-gray-100 transition"
              >
                <div className="flex items-center gap-2">
                  <CalendarClock className="w-4 h-4 text-gray-500" />
                  <span className="text-sm font-medium text-gray-700">Programar envío</span>
                  {hasSchedule && <span className="text-[10px] text-blue-600 font-medium bg-blue-50 px-1.5 py-0.5 rounded">Programado</span>}
                </div>
                {showSchedule ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
              </button>
              {showSchedule && (
                <div className="p-4 border-t border-gray-200">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Fecha</label>
                      <input type="date" value={formData.scheduled_date} onChange={e => setFormData({ ...formData, scheduled_date: e.target.value })} min={new Date().toISOString().split('T')[0]} max={new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]} className="w-full px-3 py-1.5 border border-gray-300 rounded text-sm text-gray-900" />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Hora</label>
                      <input type="time" value={formData.scheduled_time} onChange={e => setFormData({ ...formData, scheduled_time: e.target.value })} className="w-full px-3 py-1.5 border border-gray-300 rounded text-sm text-gray-900" />
                    </div>
                  </div>
                  {hasSchedule && (
                    <div className="mt-2 flex items-center justify-between">
                      <p className="text-xs text-blue-600">
                        Se enviará el {format(new Date(`${formData.scheduled_date}T${formData.scheduled_time}`), "d 'de' MMMM 'a las' HH:mm", { locale: es })}
                      </p>
                      <button type="button" onClick={() => setFormData({ ...formData, scheduled_date: '', scheduled_time: '' })} className="text-xs text-red-500 hover:text-red-700">
                        Quitar
                      </button>
                    </div>
                  )}
                  <p className="text-[10px] text-gray-400 mt-2">Máximo 1 semana. Deja vacío para enviar manualmente.</p>
                </div>
              )}
            </div>

            {/* ── Speed estimator ── */}
            {formData.batch_size > 0 && formData.min_delay > 0 && formData.max_delay > 0 && (() => {
              const avgDelay = (formData.min_delay + formData.max_delay) / 2
              const batchTimeSec = avgDelay * formData.batch_size
              const cycleTimeMin = batchTimeSec / 60 + formData.batch_pause
              const msgsPerHour = cycleTimeMin > 0 ? Math.round(formData.batch_size / cycleTimeMin * 60) : 0
              const hoursFor1000 = msgsPerHour > 0 ? (1000 / msgsPerHour).toFixed(1) : '?'
              return (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-2.5 text-xs text-blue-800">
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                    <span className="font-semibold">~{msgsPerHour} msgs/hora</span>
                    <span>~{avgDelay.toFixed(0)}s entre msgs</span>
                    <span>1000 msgs ≈ {hoursFor1000}h</span>
                  </div>
                </div>
              )
            })()}
            </div>

            {/* ═══ SPREADSHEET RECIPIENTS ═══ */}
            <div className={`${mobileStep === 'recipients' ? 'block' : 'hidden'} overflow-hidden rounded-lg border border-gray-200 lg:block`}>
              <button
                type="button"
                onClick={() => { setShowSheet(!showSheet); if (!showSheet && sheetRows.length === 0) addSheetRow() }}
                className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-50 hover:bg-gray-100 transition"
              >
                <div className="flex items-center gap-2">
                  <Table2 className="w-4 h-4 text-emerald-600" />
                  <span className="text-sm font-medium text-gray-700">Destinatarios directos</span>
                  {validSheetRows.length > 0 && (
                    <span className="text-[10px] font-semibold text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded-full">{validSheetRows.length}</span>
                  )}
                </div>
                {showSheet ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
              </button>
              {showSheet && (
                <div className="border-t border-gray-200">
                  {/* Column management bar */}
                  <div className="px-3 py-2 bg-gray-50/50 border-b border-gray-100 flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] text-gray-500 font-medium uppercase tracking-wider">Columnas:</span>
                    {sheetColumns.map(col => (
                      <span key={col} className="inline-flex items-center gap-1 px-2 py-0.5 bg-white border border-gray-200 rounded text-[11px] text-gray-700">
                        {col}
                        {col === 'celular' && <span className="text-red-400">*</span>}
                        {col !== 'celular' && (
                          <button
                            onClick={(e) => { e.stopPropagation(); removeColumn(col) }}
                            className="text-gray-400 hover:text-red-500 ml-0.5"
                          >
                            <X className="w-2.5 h-2.5" />
                          </button>
                        )}
                      </span>
                    ))}
                    {showAddCol ? (
                      <div className="flex items-center gap-1">
                        <input
                          type="text"
                          value={newColName}
                          onChange={e => setNewColName(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') addColumn(); if (e.key === 'Escape') setShowAddCol(false) }}
                          placeholder="nombre_campo"
                          className="px-2 py-0.5 text-[11px] border border-gray-300 rounded w-28 focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 text-gray-900"
                          autoFocus
                        />
                        <button onClick={addColumn} className="text-emerald-600 hover:text-emerald-700">
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => { setShowAddCol(false); setNewColName('') }} className="text-gray-400 hover:text-gray-600">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setShowAddCol(true)}
                        className="inline-flex items-center gap-0.5 px-2 py-0.5 text-[11px] text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 border border-dashed border-emerald-300 rounded transition"
                      >
                        <Plus className="w-3 h-3" /> Columna
                      </button>
                    )}
                  </div>

                  {/* Spreadsheet table */}
                  <div className="overflow-visible lg:max-h-60 lg:overflow-auto" onPaste={handleSheetPaste}>
                    <div className="space-y-3 p-3 lg:hidden">
                      <textarea
                        data-campaign-paste-catcher="true"
                        aria-label="Pegar lista de destinatarios"
                        placeholder="Pega aquí filas copiadas desde Excel o una lista con celular y nombre"
                        className="min-h-20 w-full resize-none rounded-xl border border-dashed border-emerald-300 bg-emerald-50/50 p-3 text-sm text-gray-700 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
                        value=""
                        onChange={() => {}}
                      />
                      {mobileRecipientRows.map((row, pageRowIdx) => {
                        const rowIdx = mobileRecipientStart + pageRowIdx
                        const phone = row.celular?.replace(/[^0-9]/g, '') || ''
                        const isInvalid = Boolean(row.celular && phone.length < 7)
                        return (
                          <div key={rowIdx} className={`rounded-xl border p-3 ${isInvalid ? 'border-red-200 bg-red-50/40' : 'border-gray-200 bg-white'}`}>
                            <div className="mb-3 flex items-center justify-between"><span className="text-xs font-semibold text-gray-500">Destinatario {rowIdx + 1}</span><button type="button" onClick={() => removeSheetRow(rowIdx)} className="flex h-11 w-11 items-center justify-center rounded-xl text-gray-400 hover:bg-red-50 hover:text-red-500" aria-label={`Eliminar destinatario ${rowIdx + 1}`}><Trash2 className="h-4 w-4" /></button></div>
                            <div className="space-y-3">
                              {sheetColumns.map(col => (
                                <label key={col} className="block"><span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-gray-500">{col}{col === 'celular' && <span className="text-red-500"> *</span>}</span><input type="text" inputMode={col === 'celular' ? 'tel' : 'text'} value={row[col] || ''} onChange={event => updateSheetCell(rowIdx, col, event.target.value)} placeholder={col === 'celular' ? '51999888777' : col === 'nombre_corto' ? 'Nombre' : ''} className={`min-h-11 w-full rounded-xl border px-3 text-sm text-gray-900 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 ${isInvalid && col === 'celular' ? 'border-red-300 bg-red-50' : 'border-gray-200'}`} /></label>
                              ))}
                            </div>
                          </div>
                        )
                      })}
                      {sheetRows.length > MOBILE_RECIPIENT_PAGE_SIZE && (
                        <div className="flex items-center justify-between gap-3 rounded-xl border border-gray-200 bg-gray-50 p-2" aria-label="Paginación de destinatarios">
                          <button
                            type="button"
                            onClick={() => setMobileRecipientPage(Math.max(0, safeMobileRecipientPage - 1))}
                            disabled={safeMobileRecipientPage === 0}
                            className="min-h-11 min-w-11 rounded-xl border border-gray-200 bg-white px-3 text-sm font-medium text-gray-700 transition hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            Anterior
                          </button>
                          <span className="text-center text-xs text-gray-500" aria-live="polite">
                            {mobileRecipientStart + 1}–{Math.min(mobileRecipientStart + MOBILE_RECIPIENT_PAGE_SIZE, sheetRows.length)} de {sheetRows.length}
                          </span>
                          <button
                            type="button"
                            onClick={() => setMobileRecipientPage(Math.min(mobileRecipientPageCount - 1, safeMobileRecipientPage + 1))}
                            disabled={safeMobileRecipientPage >= mobileRecipientPageCount - 1}
                            className="min-h-11 min-w-11 rounded-xl border border-gray-200 bg-white px-3 text-sm font-medium text-gray-700 transition hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            Siguiente
                          </button>
                        </div>
                      )}
                    </div>
                    <table className="hidden w-full text-xs lg:table">
                      <thead className="sticky top-0 z-10">
                        <tr className="bg-gray-100 border-b border-gray-200">
                          <th className="w-8 px-1 py-1.5 text-center text-[10px] text-gray-400 font-medium">#</th>
                          {sheetColumns.map(col => (
                            <th key={col} className="px-2 py-1.5 text-left text-[10px] text-gray-500 font-medium uppercase tracking-wider">
                              {col}{col === 'celular' && <span className="text-red-400 ml-0.5">*</span>}
                            </th>
                          ))}
                          <th className="w-8 px-1 py-1.5"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {sheetRows.map((row, rowIdx) => {
                          const phone = row.celular?.replace(/[^0-9]/g, '') || ''
                          const isInvalid = row.celular && phone.length < 7 && phone.length > 0
                          return (
                            <tr key={rowIdx} className={`border-b border-gray-100 ${isInvalid ? 'bg-red-50/50' : 'hover:bg-gray-50'}`}>
                              <td className="px-1 py-0.5 text-center text-[10px] text-gray-400">{rowIdx + 1}</td>
                              {sheetColumns.map(col => (
                                <td key={col} className="px-1 py-0.5">
                                  <input
                                    type="text"
                                    value={row[col] || ''}
                                    onChange={e => updateSheetCell(rowIdx, col, e.target.value)}
                                    placeholder={col === 'celular' ? '51999888777' : col === 'nombre_corto' ? 'Nombre' : ''}
                                    className={`w-full px-1.5 py-1 border rounded text-xs focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 outline-none text-gray-900 ${isInvalid && col === 'celular' ? 'border-red-300 bg-red-50' : 'border-gray-200'}`}
                                  />
                                </td>
                              ))}
                              <td className="px-1 py-0.5 text-center">
                                <button onClick={() => removeSheetRow(rowIdx)} className="p-0.5 text-gray-400 hover:text-red-500 transition">
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Spreadsheet footer */}
                  <div className="flex flex-col gap-2 border-t border-gray-200 bg-gray-50/50 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        onClick={addSheetRow}
                        className="inline-flex items-center gap-1 px-2 py-1 text-[11px] text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded transition font-medium"
                      >
                        <Plus className="w-3 h-3" /> Fila
                      </button>
                      <span className="flex items-center gap-1 text-[10px] text-gray-400">
                        <ClipboardPaste className="w-3 h-3" /> <span className="hidden lg:inline">Ctrl+V para pegar desde Excel</span><span className="lg:hidden">Pega una lista arriba o agrega filas</span>
                      </span>
                      {pasteInfo && (
                        <span className="text-[10px] text-emerald-600 font-medium animate-pulse">
                          +{pasteInfo.added} pegado{pasteInfo.added !== 1 ? 's' : ''}{pasteInfo.dupes > 0 ? ` (${pasteInfo.dupes} duplicado${pasteInfo.dupes !== 1 ? 's' : ''} omitido${pasteInfo.dupes !== 1 ? 's' : ''})` : ''}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {sheetRows.length > 0 && sheetRows.length !== validSheetRows.length && (
                        <span className="text-[10px] text-amber-600 flex items-center gap-0.5">
                          <AlertTriangle className="w-3 h-3" /> {sheetRows.length - validSheetRows.length} sin celular válido
                        </span>
                      )}
                      <span className="text-[10px] text-gray-500 font-medium">
                        {validSheetRows.length} destinatario{validSheetRows.length !== 1 ? 's' : ''} válido{validSheetRows.length !== 1 ? 's' : ''}
                      </span>
                      {sheetRows.length > 0 && (
                        <button
                          onClick={() => { setSheetRows([]); setMobileRecipientPage(0) }}
                          className="text-[10px] text-red-500 hover:text-red-700 transition"
                        >
                          Limpiar
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ─── Footer ──────────────────────────────────────── */}
        <div className={`${mobileStep === 'review' ? 'block' : 'hidden'} min-h-0 flex-1 space-y-4 overflow-y-auto p-4 lg:hidden`}>
          <div>
            <h3 className="text-base font-semibold text-gray-900">Revisa antes de crear</h3>
            <p className="mt-1 text-xs text-gray-500">Confirma el dispositivo, el contenido y la configuración de entrega.</p>
          </div>
          {infoPanel}
          <dl className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white text-sm">
            <div className="flex items-start justify-between gap-4 p-3"><dt className="text-gray-500">Nombre</dt><dd className="max-w-[65%] break-words text-right font-medium text-gray-900">{formData.name || '—'}</dd></div>
            <div className="flex items-start justify-between gap-4 p-3"><dt className="text-gray-500">Dispositivo</dt><dd className="max-w-[65%] break-words text-right font-medium text-gray-900">{connectedDevices.find(device => device.id === formData.device_id)?.name || 'Sin seleccionar'}</dd></div>
            <div className="flex items-start justify-between gap-4 p-3"><dt className="text-gray-500">Mensaje</dt><dd className="max-w-[65%] text-right font-medium text-gray-900">{formData.message_template ? `${formData.message_template.length} caracteres` : 'Solo adjuntos'}</dd></div>
            <div className="flex items-start justify-between gap-4 p-3"><dt className="text-gray-500">Adjuntos</dt><dd className="font-medium text-gray-900">{readyAttachments.length}</dd></div>
            <div className="flex items-start justify-between gap-4 p-3"><dt className="text-gray-500">Directos</dt><dd className="font-medium text-gray-900">{validSheetRows.length}</dd></div>
            <div className="flex items-start justify-between gap-4 p-3"><dt className="text-gray-500">Intervalo</dt><dd className="max-w-[65%] text-right font-medium text-gray-900">{formData.min_delay}–{formData.max_delay} s por mensaje</dd></div>
            <div className="flex items-start justify-between gap-4 p-3"><dt className="text-gray-500">Lotes</dt><dd className="max-w-[65%] text-right font-medium text-gray-900">{formData.batch_size} mensajes · pausa {formData.batch_pause} min</dd></div>
            <div className="flex items-start justify-between gap-4 p-3"><dt className="text-gray-500">Límite diario</dt><dd className="font-medium text-gray-900">{formData.daily_limit}</dd></div>
            <div className="flex items-start justify-between gap-4 p-3"><dt className="text-gray-500">Horario activo</dt><dd className="max-w-[65%] text-right font-medium text-gray-900">{formData.active_hours_start}–{formData.active_hours_end}</dd></div>
            <div className="flex items-start justify-between gap-4 p-3"><dt className="text-gray-500">Simular escritura</dt><dd className="font-medium text-gray-900">{formData.simulate_typing ? 'Sí' : 'No'}</dd></div>
            <div className="flex items-start justify-between gap-4 p-3"><dt className="text-gray-500">Aleatorizar mensaje</dt><dd className="font-medium text-gray-900">Sí</dd></div>
            <div className="flex items-start justify-between gap-4 p-3"><dt className="text-gray-500">Envío</dt><dd className="max-w-[65%] text-right font-medium text-gray-900">{hasSchedule ? `${formData.scheduled_date} ${formData.scheduled_time}` : 'Inicio manual'}</dd></div>
          </dl>
          {!canSubmit && <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">Completa el nombre, selecciona un dispositivo conectado y agrega un mensaje o adjunto antes de crear la campaña.</div>}
        </div>

        <div className="campaign-dialog-footer flex shrink-0 gap-3 border-t border-gray-200 bg-white px-4 py-3 pb-[calc(.75rem+env(safe-area-inset-bottom))] lg:hidden">
          <button type="button" onClick={mobileStepIndex === 0 ? onClose : () => setMobileStep(MOBILE_STEPS[mobileStepIndex - 1].id)} className="min-h-11 flex-1 rounded-xl border border-gray-300 px-4 text-sm font-medium text-gray-700 hover:bg-gray-50">{mobileStepIndex === 0 ? 'Cancelar' : 'Anterior'}</button>
          {mobileStepIndex < MOBILE_STEPS.length - 1 ? (
            <button type="button" onClick={() => setMobileStep(MOBILE_STEPS[mobileStepIndex + 1].id)} className={`min-h-11 flex-1 rounded-xl px-4 text-sm font-semibold text-white ${accent.bg} ${accent.bgHover}`}>Siguiente</button>
          ) : (
            <button type="button" onClick={handleSubmit} disabled={!canSubmit} className={`flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold text-white disabled:opacity-50 ${accent.bg} ${accent.bgHover}`}><Send className="h-4 w-4" />{submitting ? 'Creando...' : (submitLabel || defaultSubmitLabel)}</button>
          )}
        </div>
        <div className="hidden shrink-0 items-center justify-between border-t border-gray-200 px-6 py-3 lg:flex">
          <div className="text-xs text-gray-400">
            {validSheetRows.length > 0 && (
              <span className="text-emerald-600 font-medium">{validSheetRows.length} destinatario{validSheetRows.length !== 1 ? 's' : ''} directo{validSheetRows.length !== 1 ? 's' : ''}</span>
            )}
          </div>
          <div className="flex gap-3">
            <button onClick={onClose} className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 text-sm transition">
              Cancelar
            </button>
            <button
              onClick={handleSubmit}
              disabled={!canSubmit}
              className={`px-6 py-2 ${accent.bg} text-white rounded-lg ${accent.bgHover} disabled:opacity-50 font-medium flex items-center gap-2 text-sm transition shadow-lg shadow-green-600/20`}
            >
              <Send className="w-4 h-4" />
              {submitting ? 'Creando...' : (submitLabel || defaultSubmitLabel)}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
