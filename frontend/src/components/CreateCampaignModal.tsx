'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import {
  Radio, Settings2, Eye, Paperclip, X, CalendarClock,
  Image, Video, AudioLines, File, FileText, FileAudio, Send, Smile
} from 'lucide-react'
import { format } from 'date-fns'
import { es } from 'date-fns/locale'
import MessageBubble from '@/components/chat/MessageBubble'
import WhatsAppTextInput, { WhatsAppTextInputHandle } from '@/components/WhatsAppTextInput'
import EmojiPicker from '@/components/chat/EmojiPicker'

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

const VARIABLES = [
  { label: 'Nombre', value: '{{nombre}}' },
  { label: 'Nombre completo', value: '{{nombre_completo}}' },
  { label: 'Nombre corto', value: '{{nombre_corto}}' },
  { label: 'Celular', value: '{{celular}}' },
]

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

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [open, onClose])

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
    const localPreview = ['image', 'video'].includes(mediaType) ? URL.createObjectURL(file) : undefined
    const tempAttachment: CampaignAttachment = {
      media_url: '', media_type: mediaType, caption: '', file_name: file.name,
      file_size: file.size, position: attachments.length, _localPreview: localPreview, _uploading: true,
    }
    setAttachments(prev => [...prev, tempAttachment])
    const idx = attachments.length
    try {
      const fd = new FormData()
      fd.append('file', file)
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

  const connectedDevices = devices.filter(d => d.status === 'connected')
  const accent = accentColor === 'purple' ? {
    ring: 'focus:ring-purple-500', bg: 'bg-purple-600', bgHover: 'hover:bg-purple-700',
  } : {
    ring: 'focus:ring-green-500', bg: 'bg-green-600', bgHover: 'hover:bg-green-700',
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
    })
  }

  const personalizeText = (text: string) => text
    .replace(/\{\{nombre\}\}/g, 'Juan')
    .replace(/\{\{nombre_completo\}\}/g, 'Juan Pérez López')
    .replace(/\{\{nombre_corto\}\}/g, 'Juanito')
    .replace(/\{\{celular\}\}/g, '+51999888777')
    .replace(/\{\{name\}\}/g, 'Juan')
    .replace(/\{\{telefono\}\}/g, '+51999888777')
    .replace(/\{\{phone\}\}/g, '+51999888777')

  const defaultSubmitLabel = hasSchedule ? 'Programar Campaña' : 'Crear Campaña'

  if (!open) return null

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
              <Radio className={`w-5 h-5 ${accentColor === 'purple' ? 'text-purple-600' : 'text-green-600'}`} />
              {title}
            </h2>
            {subtitle && <p className="text-sm text-gray-500 mt-0.5">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600 rounded">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {infoPanel}

          {/* Name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Nombre *</label>
            <input
              type="text"
              value={formData.name}
              onChange={e => setFormData({ ...formData, name: e.target.value })}
              className={`w-full px-4 py-2 border border-gray-300 rounded-lg ${accent.ring} focus:ring-2 focus:border-transparent text-gray-900`}
              placeholder="Ej: Promoción Navidad 2025"
            />
          </div>

          {/* Device */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Dispositivo *</label>
            <select
              value={formData.device_id}
              onChange={e => setFormData({ ...formData, device_id: e.target.value })}
              className={`w-full px-4 py-2 border border-gray-300 rounded-lg ${accent.ring} focus:ring-2 focus:border-transparent text-gray-900`}
            >
              <option value="">Seleccionar dispositivo...</option>
              {connectedDevices.map(d => (
                <option key={d.id} value={d.id}>{d.name} ({d.phone || d.phone_number || 'Sin número'})</option>
              ))}
            </select>
            {connectedDevices.length === 0 && (
              <p className="text-xs text-red-500 mt-1">No hay dispositivos conectados. Conecta uno primero.</p>
            )}
          </div>

          {/* Message */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Mensaje {attachments.length > 0 ? '(opcional)' : '*'}
            </label>
            <div className="flex flex-wrap gap-1 mb-2">
              {VARIABLES.map(v => (
                <button
                  key={v.value}
                  type="button"
                  onClick={() => {
                    if (textareaRef.current) {
                      textareaRef.current.insertAtCaret(v.value)
                    } else {
                      setFormData({ ...formData, message_template: formData.message_template + v.value })
                    }
                  }}
                  className="px-2 py-1 text-xs bg-green-50 text-green-700 border border-green-200 rounded-md hover:bg-green-100 transition"
                >
                  + {v.label}
                </button>
              ))}
            </div>
            <WhatsAppTextInput
              ref={textareaRef}
              value={formData.message_template}
              onChange={v => setFormData({ ...formData, message_template: v })}
              rows={4}
              placeholder="Hola {{nombre}}, te escribimos para..."
            />
            <div className="flex items-center justify-between mt-1">
              <div className="flex items-center gap-2">
                <p className="text-xs text-gray-400">
                  Variables: {'{{nombre}}'}, {'{{nombre_completo}}'}, {'{{nombre_corto}}'}, {'{{celular}}'}
                </p>
                <div className="relative">
                  <EmojiPicker
                    onEmojiSelect={(emoji: string) => {
                      if (textareaRef.current) {
                        textareaRef.current.insertAtCaret(emoji)
                      } else {
                        setFormData(f => ({ ...f, message_template: f.message_template + emoji }))
                      }
                      setShowEmoji(false)
                    }}
                    isOpen={showEmoji}
                    onToggle={() => setShowEmoji(!showEmoji)}
                    buttonClassName="p-1 text-gray-400 hover:text-gray-600 rounded"
                  />
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowPreview(!showPreview)}
                className="text-xs text-green-600 hover:text-green-700 font-medium flex items-center gap-1"
              >
                <Eye className="w-3 h-3" />
                {showPreview ? 'Ocultar vista previa' : 'Vista previa'}
              </button>
            </div>

            {/* Preview */}
            {showPreview && (formData.message_template || readyAttachments.length > 0) && (
              <div className="mt-2 p-3 bg-[#e5ddd5] rounded-lg max-w-sm space-y-1">
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
            <label className="block text-sm font-medium text-gray-700 mb-2">Adjuntos ({attachments.length}/10)</label>
            <input type="file" ref={attachInputRef} onChange={handleAttachInputChange} className="hidden" />
            {attachments.length > 0 && (
              <div className="space-y-2 mb-3">
                {attachments.map((att, i) => {
                  const TypeIcon = att.media_type === 'image' ? Image : att.media_type === 'video' ? Video : att.media_type === 'audio' ? AudioLines : File
                  const typeColors: Record<string, string> = { image: 'bg-purple-100 text-purple-600', video: 'bg-red-100 text-red-600', audio: 'bg-orange-100 text-orange-600', document: 'bg-blue-100 text-blue-600' }
                  return (
                    <div key={i} className="border border-gray-200 rounded-lg p-3 bg-gray-50">
                      <div className="flex items-center gap-3">
                        <div className="shrink-0">
                          {att._localPreview && att.media_type === 'image' ? (
                            <img src={att._localPreview} alt="" className="w-12 h-12 rounded-lg object-cover" />
                          ) : att._localPreview && att.media_type === 'video' ? (
                            <video src={att._localPreview} className="w-12 h-12 rounded-lg object-cover" />
                          ) : (
                            <div className={`w-12 h-12 rounded-lg flex items-center justify-center ${typeColors[att.media_type] || typeColors.document}`}>
                              <TypeIcon className="w-5 h-5" />
                            </div>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate">{att.file_name}</p>
                          <div className="flex items-center gap-2 text-xs text-gray-400">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${typeColors[att.media_type] || typeColors.document}`}>
                              {att.media_type === 'image' ? 'Imagen' : att.media_type === 'video' ? 'Video' : att.media_type === 'audio' ? 'Audio' : 'Documento'}
                            </span>
                            <span>{(att.file_size / 1024 / 1024).toFixed(2)} MB</span>
                            {att._uploading && <span className="text-amber-500 animate-pulse">Subiendo...</span>}
                          </div>
                        </div>
                        <button onClick={() => removeAttachment(i)} className="p-1 hover:bg-red-50 rounded text-red-400 hover:text-red-600 transition">
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                      {att.media_type !== 'audio' && (
                        <div className="mt-2">
                          {att.caption !== undefined && (
                            <div>
                              <div className="flex items-center justify-between mb-1">
                                <label className="flex items-center gap-1.5 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={att.caption !== ''}
                                    onChange={e => updateAttachmentCaption(i, e.target.checked ? ' ' : '')}
                                    className="rounded border-gray-300 text-green-600 focus:ring-green-500 w-3.5 h-3.5"
                                  />
                                  <span className="text-[11px] text-gray-500">Pie de foto</span>
                                </label>
                                {att.caption && (
                                  <div className="flex flex-wrap gap-1">
                                    {VARIABLES.map(v => (
                                      <button
                                        key={v.value}
                                        type="button"
                                        onClick={() => updateAttachmentCaption(i, (att.caption || '') + v.value)}
                                        className="px-1.5 py-0.5 text-[10px] bg-green-50 text-green-700 border border-green-200 rounded hover:bg-green-100 transition"
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
                  className="inline-flex items-center gap-2 px-3 py-2 border border-dashed border-gray-300 rounded-lg text-sm text-gray-600 hover:border-green-400 hover:text-green-600 hover:bg-green-50 transition"
                >
                  <Paperclip className="w-4 h-4" />
                  Adjuntar archivo
                </button>
                {showAttachMenu && (
                  <div className="absolute bottom-full mb-2 left-0 bg-white rounded-xl shadow-xl border border-gray-200 p-2 z-50 min-w-48">
                    <div className="space-y-1">
                      <button onClick={() => handleAttachSelect(ACCEPTED_TYPES.image.join(','))} className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-purple-50 rounded-lg text-left">
                        <div className="w-8 h-8 bg-purple-100 rounded-lg flex items-center justify-center"><Image className="w-4 h-4 text-purple-600" /></div>
                        <span className="text-sm font-semibold text-gray-800">Imagen</span>
                      </button>
                      <button onClick={() => handleAttachSelect(ACCEPTED_TYPES.video.join(','))} className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-red-50 rounded-lg text-left">
                        <div className="w-8 h-8 bg-red-100 rounded-lg flex items-center justify-center"><Video className="w-4 h-4 text-red-600" /></div>
                        <span className="text-sm font-semibold text-gray-800">Video</span>
                      </button>
                      <button onClick={() => handleAttachSelect(ACCEPTED_TYPES.audio.join(','))} className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-orange-50 rounded-lg text-left">
                        <div className="w-8 h-8 bg-orange-100 rounded-lg flex items-center justify-center"><FileAudio className="w-4 h-4 text-orange-600" /></div>
                        <span className="text-sm font-semibold text-gray-800">Audio</span>
                      </button>
                      <button onClick={() => handleAttachSelect(ACCEPTED_TYPES.document.join(','))} className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-blue-50 rounded-lg text-left">
                        <div className="w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center"><FileText className="w-4 h-4 text-blue-600" /></div>
                        <span className="text-sm font-semibold text-gray-800">Documento</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Anti-ban settings */}
          <div className="border border-gray-200 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-3">
              <Settings2 className="w-4 h-4 text-gray-500" />
              <h3 className="text-sm font-medium text-gray-700">Configuración Anti-Ban</h3>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
                <div className="flex items-center gap-1">
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

          {/* Schedule */}
          <div className="border border-gray-200 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-3">
              <CalendarClock className="w-4 h-4 text-gray-500" />
              <h3 className="text-sm font-medium text-gray-700">Programar envío (opcional)</h3>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
                  Quitar programación
                </button>
              </div>
            )}
            <p className="text-[10px] text-gray-400 mt-2">Máximo 1 semana en el futuro. Deja vacío para enviar manualmente.</p>
          </div>

          {/* Speed estimator */}
          {formData.batch_size > 0 && formData.min_delay > 0 && formData.max_delay > 0 && (() => {
            const avgDelay = (formData.min_delay + formData.max_delay) / 2
            const batchTimeSec = avgDelay * formData.batch_size
            const cycleTimeMin = batchTimeSec / 60 + formData.batch_pause
            const msgsPerHour = cycleTimeMin > 0 ? Math.round(formData.batch_size / cycleTimeMin * 60) : 0
            const hoursFor1000 = msgsPerHour > 0 ? (1000 / msgsPerHour).toFixed(1) : '?'
            return (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-800">
                <p className="font-medium mb-1">Velocidad estimada</p>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  <span>~{avgDelay.toFixed(0)}s promedio entre msgs</span>
                  <span>~{cycleTimeMin.toFixed(1)} min por lote de {formData.batch_size}</span>
                  <span className="font-semibold">~{msgsPerHour} msgs/hora</span>
                  <span>1000 msgs en ~{hoursFor1000}h</span>
                </div>
              </div>
            )
          })()}
        </div>

        <div className="px-6 py-4 border-t border-gray-200 flex gap-3 shrink-0">
          <button onClick={onClose} className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50">
            Cancelar
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className={`flex-1 px-4 py-2 ${accent.bg} text-white rounded-lg ${accent.bgHover} disabled:opacity-50 font-medium flex items-center justify-center gap-2`}
          >
            <Send className="w-4 h-4" />
            {submitting ? 'Creando...' : (submitLabel || defaultSubmitLabel)}
          </button>
        </div>
      </div>
    </div>
  )
}
