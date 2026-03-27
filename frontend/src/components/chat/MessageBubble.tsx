'use client'

import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { Check, CheckCheck, Download, FileText, Clock, AlertCircle, RefreshCw, Reply, Forward, Star, SmilePlus, BarChart3, Trash2, MapPin, Phone, Eye, Ban, Pencil, Plus, ChevronDown } from 'lucide-react'
import { renderFormattedText } from '@/lib/whatsappFormat'
import { Message, Reaction, PollOption } from '@/types/chat'
import { splitEmojiSegments, getAppleEmojiUrl } from '@/utils/appleEmoji'
import dynamic from 'next/dynamic'

/** Reconstruct WhatsApp-formatted text from DOM nodes (preserves *, _, ~, ` markers on copy) */
function domToWhatsApp(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || ''
  if (node.nodeType !== Node.ELEMENT_NODE) return ''
  const el = node as HTMLElement
  const tag = el.tagName.toLowerCase()
  const inner = Array.from(el.childNodes).map(domToWhatsApp).join('')
  switch (tag) {
    case 'strong': case 'b': return `*${inner}*`
    case 'em': case 'i': return `_${inner}_`
    case 'del': case 's': return `~${inner}~`
    case 'code': return el.parentElement?.tagName.toLowerCase() === 'pre' ? inner : `\`${inner}\``
    case 'pre': return `\`\`\`${inner}\`\`\``
    case 'img': return (el as HTMLImageElement).alt || ''
    case 'br': return '\n'
    default: return inner
  }
}

const EmojiPickerReact = dynamic(() => import('emoji-picker-react'), {
  ssr: false,
  loading: () => (
    <div className="w-[350px] h-[400px] bg-white rounded-xl shadow-xl border border-gray-200 flex items-center justify-center">
      <div className="animate-pulse text-gray-400 text-sm">Cargando emojis...</div>
    </div>
  ),
})

interface MessageBubbleProps {
  message: Message
  contactName?: string
  onMediaClick?: (url: string, type: string) => void
  onRetry?: () => void
  onReply?: (message: Message) => void
  onForward?: (message: Message) => void
  onDelete?: (message: Message) => void
  onEdit?: (message: Message) => void
  onSaveSticker?: (mediaUrl: string) => void
  onReact?: (message: Message, emoji: string) => void
  savedStickerUrls?: Set<string>
}

// Convert MinIO public URL to backend proxy URL
const getProxyUrl = (url: string | undefined): string => {
  if (!url) return ''
  if (url.startsWith('/api/media/')) return url
  if (url.startsWith('blob:')) return url

  const bucketMatch = url.match(/\/clarin-media\/(.+)$/)
  if (bucketMatch) {
    return `/api/media/file/${bucketMatch[1]}`
  }

  console.warn('[getProxyUrl] Unrecognized media URL:', url)
  return ''
}

// Format quoted sender name for display
const formatQuotedSender = (sender?: string, isFromMe?: boolean): string => {
  if (!sender) return ''
  if (sender === 'Me' || isFromMe) return 'Tú'
  // Remove @s.whatsapp.net suffix
  return sender.replace(/@s\.whatsapp\.net$/, '').replace(/@lid$/, '')
}

export default function MessageBubble({ message, contactName, onMediaClick, onRetry, onReply, onForward, onDelete, onEdit, onSaveSticker, onReact, savedStickerUrls }: MessageBubbleProps) {
  const [imageLoaded, setImageLoaded] = useState(false)
  const [imageError, setImageError] = useState(false)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [showFullPicker, setShowFullPicker] = useState(false)
  const [showContextMenu, setShowContextMenu] = useState(false)
  const [menuDropUp, setMenuDropUp] = useState(false)
  const [pickerPos, setPickerPos] = useState({ top: 0, left: 0 })
  const emojiPickerRef = useRef<HTMLDivElement>(null)
  const plusBtnRef = useRef<HTMLButtonElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const chevronBtnRef = useRef<HTMLButtonElement>(null)

  const QUICK_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏']

  const closeAllPickers = () => {
    setShowEmojiPicker(false)
    setShowFullPicker(false)
    setShowContextMenu(false)
  }

  const handleOpenFullPicker = () => {
    if (plusBtnRef.current) {
      const rect = plusBtnRef.current.getBoundingClientRect()
      const pickerWidth = 350
      const pickerHeight = 400
      let left = message.is_from_me ? rect.right - pickerWidth : rect.left
      let top = rect.top - pickerHeight - 8
      // Clamp to viewport
      if (top < 8) top = rect.bottom + 8
      if (left < 8) left = 8
      if (left + pickerWidth > window.innerWidth - 8) left = window.innerWidth - pickerWidth - 8
      setPickerPos({ top, left })
    }
    setShowFullPicker(true)
  }

  // Close emoji picker / context menu on outside click
  useEffect(() => {
    if (!showEmojiPicker && !showFullPicker && !showContextMenu) return
    const handleClick = (e: MouseEvent) => {
      if (showFullPicker) return // Full picker has its own backdrop
      if (showContextMenu && contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setShowContextMenu(false)
      }
      if (showEmojiPicker && emojiPickerRef.current && !emojiPickerRef.current.contains(e.target as Node)) {
        setShowEmojiPicker(false)
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeAllPickers()
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [showEmojiPicker, showFullPicker, showContextMenu])

  // Measure menu position after render and flip if it overflows viewport (runs before paint = no flicker)
  useLayoutEffect(() => {
    if (showContextMenu && contextMenuRef.current) {
      const rect = contextMenuRef.current.getBoundingClientRect()
      if (!menuDropUp && rect.bottom > window.innerHeight - 10) {
        setMenuDropUp(true)
      } else if (menuDropUp && rect.top < 10) {
        setMenuDropUp(false)
      }
    }
  }, [showContextMenu, menuDropUp])

  // Use contactName (resolved by parent via getChatDisplayName) as the sender name for incoming messages
  const senderDisplayName = !message.is_from_me
    ? (contactName || message.from_name)
    : undefined

  const formatTime = (timestamp: string) => {
    try {
      return new Date(timestamp).toLocaleTimeString('es', {
        hour: '2-digit',
        minute: '2-digit'
      })
    } catch {
      return ''
    }
  }

  const formatFileSize = (bytes?: number) => {
    if (!bytes) return ''
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(1024))
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`
  }

  const renderQuotedMessage = () => {
    if (!message.quoted_message_id || !message.quoted_body) return null

    return (
      <div className={`border-l-4 ${message.is_from_me ? 'border-emerald-500 bg-emerald-50/50' : 'border-slate-400 bg-slate-50'} rounded px-2 py-1 mb-1 cursor-pointer`}>
        {message.quoted_sender && (
          <p className="text-xs font-semibold text-emerald-700 truncate">
            {formatQuotedSender(message.quoted_sender)}
          </p>
        )}
        <p className="text-xs text-slate-600 truncate max-w-[250px]">
          {message.quoted_body}
        </p>
      </div>
    )
  }

  const renderMedia = () => {
    // View-once: show special indicator instead of actual media
    if (message.is_view_once) {
      return (
        <div className="flex items-center gap-2 px-2 py-2 bg-slate-50 rounded-lg mb-1">
          <Eye className="w-5 h-5 text-slate-400" />
          <span className="text-sm text-slate-500 italic">
            {message.message_type === 'video' ? 'Video' : 'Foto'} · Ver una vez
          </span>
        </div>
      )
    }

    if (!message.media_url) {
      // Sticker without downloaded media — show placeholder
      if (message.message_type === 'sticker') {
        return (
          <div className="w-40 h-40 bg-gray-100 rounded-lg flex items-center justify-center">
            <span className="text-3xl">🏷️</span>
          </div>
        )
      }
      return null
    }

    const proxyUrl = getProxyUrl(message.media_url)

    switch (message.message_type) {
      case 'image':
        return (
          <div
            className="relative cursor-pointer overflow-hidden"
            onClick={() => onMediaClick?.(proxyUrl, 'image')}
          >
            {!imageLoaded && !imageError && (
              <div className="w-full h-48 bg-gray-200 animate-pulse flex items-center justify-center">
                <span className="text-gray-500 text-sm">Cargando...</span>
              </div>
            )}
            {imageError ? (
              <div className="w-full h-32 bg-gray-200 flex items-center justify-center">
                <span className="text-gray-500 text-sm">Error al cargar imagen</span>
              </div>
            ) : (
              <img
                src={proxyUrl}
                alt="Imagen"
                className={`w-full block ${imageLoaded ? '' : 'hidden'}`}
                onLoad={() => setImageLoaded(true)}
                onError={() => setImageError(true)}
              />
            )}
          </div>
        )

      case 'video':
        return (
          <div className="relative overflow-hidden bg-black">
            <video
              src={proxyUrl}
              className="w-full block"
              controls
              preload="metadata"
              playsInline
            />
          </div>
        )

      case 'audio':
        return (
          <div className="mb-1 max-w-[280px]">
            <audio
              src={proxyUrl}
              controls
              className="w-full h-10"
              style={{ minWidth: '200px' }}
            />
          </div>
        )

      case 'document':
        return (
          <div
            className="flex items-center gap-3 p-2 bg-gray-100 rounded-lg mb-1 cursor-pointer hover:bg-gray-200"
            onClick={() => window.open(proxyUrl, '_blank')}
          >
            <div className="w-10 h-10 bg-green-100 rounded-lg flex items-center justify-center flex-shrink-0">
              <FileText className="w-5 h-5 text-green-600" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-800 truncate">
                {message.media_filename || 'Documento'}
              </p>
              <p className="text-xs text-gray-500">
                {formatFileSize(message.media_size)}
              </p>
            </div>
            <Download className="w-5 h-5 text-gray-400" />
          </div>
        )

      case 'sticker':
        return (
          <div className="group/sticker relative">
            <img
              src={proxyUrl}
              alt="Sticker"
              className="w-40 h-40 object-contain"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none'
              }}
            />
            {onSaveSticker && !message.is_from_me && (
              <button
                onClick={() => onSaveSticker(message.media_url!)}
                className={`absolute top-1 right-1 p-1.5 rounded-full shadow-md transition-all ${
                  savedStickerUrls?.has(message.media_url!)
                    ? 'bg-yellow-400 text-white'
                    : 'bg-white/90 text-gray-500 hover:text-yellow-500 opacity-0 group-hover/sticker:opacity-100'
                }`}
                title={savedStickerUrls?.has(message.media_url!) ? 'Guardado' : 'Guardar sticker'}
              >
                <Star className={`w-3.5 h-3.5 ${savedStickerUrls?.has(message.media_url!) ? 'fill-current' : ''}`} />
              </button>
            )}
          </div>
        )

      default:
        return null
    }
  }

  const renderPoll = () => {
    if (message.message_type !== 'poll' || !message.poll_question) return null

    const options = message.poll_options || []
    const totalVotes = options.reduce((sum, o) => sum + (o.vote_count || 0), 0)

    return (
      <div className="mb-1">
        <div className="flex items-center gap-2 mb-2">
          <BarChart3 className="w-4 h-4 text-green-600" />
          <p className="font-medium text-gray-800">{message.poll_question}</p>
        </div>
        <div className="space-y-1.5">
          {options.map((opt) => {
            const pct = totalVotes > 0 ? Math.round((opt.vote_count / totalVotes) * 100) : 0
            return (
              <div key={opt.id} className="relative">
                <div
                  className="absolute inset-0 bg-green-100 rounded"
                  style={{ width: `${pct}%` }}
                />
                <div className="relative flex items-center justify-between px-2 py-1.5 text-sm">
                  <span className="text-gray-800">{opt.name}</span>
                  <span className="text-xs text-gray-500 ml-2 whitespace-nowrap">
                    {opt.vote_count} {opt.vote_count === 1 ? 'voto' : 'votos'}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
        {totalVotes > 0 && (
          <p className="text-xs text-gray-400 mt-1">{totalVotes} voto{totalVotes !== 1 ? 's' : ''} en total</p>
        )}
        {message.poll_max_selections && message.poll_max_selections > 1 && (
          <p className="text-xs text-gray-400">Máx. {message.poll_max_selections} opciones</p>
        )}
      </div>
    )
  }

  const renderLocation = () => {
    if (message.message_type !== 'location' || !message.latitude || !message.longitude) return null

    const lat = message.latitude
    const lng = message.longitude
    const mapUrl = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=15/${lat}/${lng}`
    const staticMapUrl = `https://staticmap.openstreetmap.de/staticmap.php?center=${lat},${lng}&zoom=15&size=300x200&markers=${lat},${lng},red-pushpin`

    return (
      <div className="mb-1">
        <a href={mapUrl} target="_blank" rel="noopener noreferrer" className="block">
          <div className="relative rounded-lg overflow-hidden bg-slate-100">
            <img
              src={staticMapUrl}
              alt="Ubicación"
              className="w-full h-[150px] object-cover"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none'
              }}
            />
            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/50 to-transparent p-2">
              <div className="flex items-center gap-1 text-white text-xs">
                <MapPin className="w-3.5 h-3.5" />
                <span>{message.body || 'Ubicación compartida'}</span>
              </div>
            </div>
          </div>
        </a>
      </div>
    )
  }

  const renderContactCard = () => {
    if (message.message_type !== 'contact') return null

    return (
      <div className="mb-1 min-w-[200px]">
        <div className="flex items-center gap-3 p-2 bg-slate-50 rounded-lg">
          <div className="w-10 h-10 rounded-full bg-slate-200 flex items-center justify-center flex-shrink-0">
            <Phone className="w-5 h-5 text-slate-500" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-slate-800 truncate">
              {message.contact_name || message.body || 'Contacto'}
            </p>
            {message.contact_phone && (
              <p className="text-xs text-slate-500">{message.contact_phone}</p>
            )}
          </div>
        </div>
        {message.contact_phone && (
          <a
            href={`https://wa.me/${message.contact_phone}`}
            target="_blank"
            rel="noopener noreferrer"
            className="block text-center text-xs text-emerald-600 hover:text-emerald-700 font-medium mt-1.5 py-1 border-t border-slate-200"
          >
            Enviar mensaje
          </a>
        )}
      </div>
    )
  }

  const renderReactions = () => {
    if (!message.reactions || message.reactions.length === 0) return null

    // Group reactions by emoji
    const grouped: Record<string, { emoji: string; count: number; hasOwn: boolean }> = {}
    for (const r of message.reactions) {
      if (!grouped[r.emoji]) {
        grouped[r.emoji] = { emoji: r.emoji, count: 0, hasOwn: false }
      }
      grouped[r.emoji].count++
      if (r.is_from_me) grouped[r.emoji].hasOwn = true
    }

    return (
      <div className={`flex flex-wrap gap-1 mt-1 ${message.is_from_me ? 'justify-end' : 'justify-start'}`}>
        {Object.values(grouped).map((g) => (
          <button
            key={g.emoji}
            onClick={() => onReact?.(message, g.emoji)}
            className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-xs border transition-colors ${
              g.hasOwn
                ? 'bg-green-100 border-green-300 hover:bg-green-200'
                : 'bg-gray-100 border-gray-200 hover:bg-gray-200'
            }`}
          >
            <img
              src={getAppleEmojiUrl(g.emoji)}
              alt={g.emoji}
              className="inline-block"
              style={{ width: '16px', height: '16px' }}
              draggable={false}
            />
            {g.count > 1 && <span className="text-gray-600">{g.count}</span>}
          </button>
        ))}
      </div>
    )
  }

  const renderStatus = () => {
    if (!message.is_from_me) return null

    switch (message.status) {
      case 'read':
        return <CheckCheck className="w-4 h-4 text-blue-500" />
      case 'delivered':
        return <CheckCheck className="w-4 h-4 text-gray-400" />
      case 'sending':
        return <Clock className="w-4 h-4 text-gray-400 animate-pulse" />
      case 'failed':
        return (
          <button onClick={onRetry} className="flex items-center gap-1 text-red-500 hover:text-red-700" title="Reintentar">
            <AlertCircle className="w-4 h-4" />
            <RefreshCw className="w-3 h-3" />
          </button>
        )
      default:
        return <Check className="w-4 h-4 text-gray-400" />
    }
  }

  const hasVisualMedia = !!message.media_url && ['image', 'video'].includes(message.message_type || '') && !message.is_view_once
  const isOptimistic = (message.id || '').startsWith('optimistic-')

  // Detect single-emoji messages (exactly 1 emoji, no text)
  const isEmojiOnly = (() => {
    if (!message.body || message.message_type !== 'text' || message.media_url) return false
    const segments = splitEmojiSegments(message.body.trim())
    const emojiSegments = segments.filter(s => s.type === 'emoji')
    const textSegments = segments.filter(s => s.type === 'text' && s.value.trim().length > 0)
    // Only exactly 1 emoji with no text → big display
    return emojiSegments.length === 1 && textSegments.length === 0
  })()

  // Detect 2-3 emoji-only messages (medium size, in bubble)
  const isMultiEmojiOnly = (() => {
    if (isEmojiOnly || !message.body || message.message_type !== 'text' || message.media_url) return false
    const segments = splitEmojiSegments(message.body.trim())
    const emojiSegments = segments.filter(s => s.type === 'emoji')
    const textSegments = segments.filter(s => s.type === 'text' && s.value.trim().length > 0)
    return emojiSegments.length >= 2 && emojiSegments.length <= 3 && textSegments.length === 0
  })()

  // Revoked message — show "deleted" placeholder
  if (message.is_revoked) {
    return (
      <div className={`group flex ${message.is_from_me ? 'justify-end' : 'justify-start'}`}>
        <div className={`max-w-[85%] sm:max-w-[70%] px-3 py-1.5 rounded-xl shadow-sm ${
          message.is_from_me ? 'bg-[#d9fdd3] rounded-br-none' : 'bg-white rounded-bl-none'
        }`}>
          <div className="flex items-center gap-1.5">
            <Ban className="w-3.5 h-3.5 text-slate-400" />
            <p className="text-slate-400 italic text-[14px]">
              {message.is_from_me ? 'Eliminaste este mensaje' : 'Se eliminó este mensaje'}
            </p>
          </div>
          <div className="flex items-center justify-end gap-1 mt-0.5">
            <span className="text-[11px] text-slate-400">{formatTime(message.timestamp)}</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={`group flex ${message.is_from_me ? 'justify-end' : 'justify-start'}`}>
      {/* Wrapper for message bubble + hover controls + reaction popup */}
      <div className="relative max-w-[85%] sm:max-w-[70%]">
      <div
        className={`${
          message.message_type === 'sticker'
            ? 'p-1'
            : isEmojiOnly
              ? 'py-0.5'
              : hasVisualMedia
                ? `max-w-[330px] rounded-xl shadow-sm overflow-hidden ${
                    message.is_from_me
                      ? 'bg-[#d9fdd3] rounded-br-none'
                      : 'bg-white rounded-bl-none'
                  }`
                : `px-3 py-1.5 rounded-xl shadow-sm ${
                    message.is_from_me
                      ? 'bg-[#d9fdd3] rounded-br-none'
                      : 'bg-white rounded-bl-none'
                  }`
        }`}
      >
        {/* Sender name for incoming messages (hidden for emoji-only like WhatsApp Web) */}
        {!message.is_from_me && !isEmojiOnly && (senderDisplayName || message.from_name) && (
          <p className={`text-xs text-emerald-700 font-medium mb-0.5 ${hasVisualMedia ? 'px-3 pt-1.5' : ''}`}>
            {senderDisplayName || message.from_name}
          </p>
        )}

        {/* Quoted message */}
        {message.quoted_message_id && message.quoted_body && (
          <div className={hasVisualMedia ? 'px-2 pt-1' : ''}>
            {renderQuotedMessage()}
          </div>
        )}

        {/* Media content */}
        {renderMedia()}

        {/* Poll content */}
        {renderPoll()}

        {/* Location content */}
        {renderLocation()}

        {/* Contact card content */}
        {renderContactCard()}

        {/* Text body */}
        {message.body && message.message_type !== 'sticker' && message.message_type !== 'poll' && (
          isEmojiOnly ? (
            <div className={`flex flex-wrap gap-1 ${message.is_from_me ? 'justify-end' : 'justify-start'}`}>
              {splitEmojiSegments(message.body.trim()).filter(s => s.type === 'emoji').map((seg, i) => (
                <img
                  key={i}
                  src={getAppleEmojiUrl(seg.value)}
                  alt={seg.value}
                  className="inline-block object-contain"
                  style={{ width: '66px', height: '66px' }}
                  draggable={false}
                  onError={(e) => {
                    const span = document.createElement('span')
                    span.textContent = seg.value
                    span.style.fontSize = '66px'
                    span.style.lineHeight = '1'
                    e.currentTarget.replaceWith(span)
                  }}
                />
              ))}
            </div>
          ) : isMultiEmojiOnly ? (
            <div className="flex flex-wrap gap-1 items-end">
              {splitEmojiSegments(message.body.trim()).filter(s => s.type === 'emoji').map((seg, i) => (
                <img
                  key={i}
                  src={getAppleEmojiUrl(seg.value)}
                  alt={seg.value}
                  className="inline-block object-contain"
                  style={{ width: '34px', height: '34px' }}
                  draggable={false}
                  onError={(e) => {
                    const span = document.createElement('span')
                    span.textContent = seg.value
                    span.style.fontSize = '34px'
                    span.style.lineHeight = '1'
                    e.currentTarget.replaceWith(span)
                  }}
                />
              ))}
            </div>
          ) : (
            <p
              className={`text-slate-900 whitespace-pre-wrap break-words text-[14.5px] leading-[19px] ${hasVisualMedia ? 'px-3 pt-1' : ''}`}
              onCopy={(e) => {
                const sel = window.getSelection()
                if (!sel || sel.rangeCount === 0) return
                const fragment = sel.getRangeAt(0).cloneContents()
                const text = Array.from(fragment.childNodes).map(domToWhatsApp).join('')
                if (text) {
                  e.preventDefault()
                  e.clipboardData.setData('text/plain', text)
                }
              }}
            >
              {renderFormattedText(message.body)}
            </p>
          )
        )}

        {/* Empty placeholder for media-only messages */}
        {!message.body && message.media_url && message.message_type === 'image' && (
          <span className="sr-only">Imagen</span>
        )}

        {/* Timestamp and status */}
        <div className={`flex items-center justify-end gap-1 mt-0.5 ${
          message.message_type === 'sticker'
            ? 'bg-black/30 rounded-full px-2 py-0.5 w-fit ml-auto'
            : isEmojiOnly
              ? 'bg-slate-200/80 rounded-full px-2 py-0.5 w-fit ml-auto'
              : hasVisualMedia ? 'px-3 pb-1.5' : ''
        }`}>
          {message.is_edited && (
            <span className={`text-[10px] italic ${message.message_type === 'sticker' ? 'text-white/70' : 'text-slate-400'}`}>
              editado
            </span>
          )}
          <span className={`text-[11px] ${message.message_type === 'sticker' ? 'text-white' : 'text-slate-500'}`}>
            {formatTime(message.timestamp)}
          </span>
          {renderStatus()}
        </div>

        {/* Reactions display */}
        {renderReactions()}
      </div>

      {/* WhatsApp Web-style hover trigger bar — emoji + chevron at top-right of bubble */}
      {!isOptimistic && message.message_type !== 'sticker' && !isEmojiOnly && (
        <div className={`absolute top-1 right-1 z-10 flex items-center rounded-md transition-opacity duration-150 ${showContextMenu || showEmojiPicker ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} ${message.is_from_me ? 'bg-[#d9fdd3]/90' : 'bg-white/90'}`}>
          <button
            onClick={(e) => { e.stopPropagation(); setShowEmojiPicker(!showEmojiPicker); setShowContextMenu(false) }}
            className="p-1 rounded-md hover:bg-black/5 text-slate-500 hover:text-slate-700 transition-colors"
            title="Reaccionar"
          >
            <SmilePlus className="w-4 h-4" />
          </button>
          <button
            ref={chevronBtnRef}
            onClick={(e) => {
              e.stopPropagation()
              if (!showContextMenu) setMenuDropUp(false)
              setShowContextMenu(!showContextMenu)
              setShowEmojiPicker(false)
            }}
            className="p-1 rounded-md hover:bg-black/5 text-slate-500 hover:text-slate-700 transition-colors"
            title="Más opciones"
          >
            <ChevronDown className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Context menu dropdown */}
      {showContextMenu && (
        <div
          ref={contextMenuRef}
          className={`absolute z-50 ${message.is_from_me ? 'right-0' : 'left-0'} ${menuDropUp ? 'bottom-full mb-1' : 'top-8'} bg-white rounded-lg shadow-xl border border-slate-200 py-1 min-w-[170px]`}
        >
          <button
            onClick={() => { onReply?.(message); closeAllPickers() }}
            className="w-full flex items-center gap-3 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
          >
            <Reply className="w-4 h-4 text-slate-400" />
            Responder
          </button>
          <button
            onClick={() => { onForward?.(message); closeAllPickers() }}
            className="w-full flex items-center gap-3 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
          >
            <Forward className="w-4 h-4 text-slate-400" />
            Reenviar
          </button>
          {onEdit && message.is_from_me && message.message_type === 'text' && !message.is_revoked && (
            <button
              onClick={() => { onEdit(message); closeAllPickers() }}
              className="w-full flex items-center gap-3 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
            >
              <Pencil className="w-4 h-4 text-slate-400" />
              Editar
            </button>
          )}
          {onDelete && message.is_from_me && (
            <>
              <div className="border-t border-slate-100 my-1" />
              <button
                onClick={() => { onDelete(message); closeAllPickers() }}
                className="w-full flex items-center gap-3 px-3 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors"
              >
                <Trash2 className="w-4 h-4" />
                Eliminar
              </button>
            </>
          )}
        </div>
      )}

      {/* Quick reaction bar - positioned above message bubble like WhatsApp Web */}
      {showEmojiPicker && !showFullPicker && (
        <div
          ref={emojiPickerRef}
          className={`absolute z-50 ${message.is_from_me ? 'right-0' : 'left-0'} bottom-full mb-1 flex items-center gap-0.5 bg-white rounded-full shadow-xl border border-gray-100 px-2 py-1.5`}
        >
          {QUICK_EMOJIS.map((e) => (
            <button
              key={e}
              onClick={() => { onReact?.(message, e); closeAllPickers() }}
              className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-gray-100 transition-all hover:scale-110"
            >
              <img
                src={getAppleEmojiUrl(e)}
                alt={e}
                className="w-7 h-7"
                draggable={false}
              />
            </button>
          ))}
          <div className="w-px h-6 bg-gray-200 mx-0.5" />
          <button
            ref={plusBtnRef}
            onClick={handleOpenFullPicker}
            className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-gray-100 transition-all"
            title="Más reacciones"
          >
            <Plus className="w-5 h-5 text-gray-400" />
          </button>
        </div>
      )}

      {/* Full emoji picker for reactions - rendered via portal */}
      {showFullPicker && typeof document !== 'undefined' && createPortal(
        <>
          <div className="fixed inset-0 z-[100]" onClick={closeAllPickers} />
          <div
            className="fixed z-[101] rounded-xl overflow-hidden shadow-2xl"
            style={{ top: pickerPos.top, left: pickerPos.left }}
          >
            <EmojiPickerReact
              onEmojiClick={(emojiData: any) => { onReact?.(message, emojiData.emoji); closeAllPickers() }}
              searchPlaceHolder="Buscar una reacción..."
              width={350}
              height={400}
              skinTonesDisabled
              previewConfig={{ showPreview: false }}
              lazyLoadEmojis
            />
          </div>
        </>,
        document.body
      )}
      </div>
    </div>
  )
}
