'use client'

import { memo, useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Check, CheckCheck, Download, FileText, Clock, AlertCircle, RefreshCw, Reply, Forward, Star, SmilePlus, BarChart3, Trash2, MapPin, Phone, Eye, Ban, Pencil, Plus, ChevronDown, Loader2, Info, Copy } from 'lucide-react'
import { renderFormattedText } from '@/lib/whatsappFormat'
import { Message, Reaction, PollOption } from '@/types/chat'
import { splitEmojiSegments, getAppleEmojiUrl } from '@/utils/appleEmoji'
import dynamic from 'next/dynamic'
import { canonicalChatMediaUrl, chatMediaIdentity } from '@/utils/chatMediaUrl'
import { dedupeReactions } from '@/utils/chatReactions'
import styles from './MessageBubble.module.css'

/** Reconstruct WhatsApp-formatted text from DOM nodes (preserves *, _, ~, ` markers on copy) */
function domToWhatsApp(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || ''
  if (node.nodeType !== Node.ELEMENT_NODE) return ''
  const el = node as HTMLElement
  if (el.dataset.whatsappIgnore === 'true') return ''
  const tag = el.tagName.toLowerCase()
  const inner = Array.from(el.childNodes).map(domToWhatsApp).join('')
  if (el.dataset.whatsappPrefix !== undefined) return `${el.dataset.whatsappPrefix}${inner}`
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

const EmojiPickerReact = dynamic(() => import('./LocalizedEmojiPicker'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center rounded-xl border border-gray-200 bg-white shadow-xl">
      <div className="animate-pulse text-gray-400 text-sm">Cargando emojis...</div>
    </div>
  ),
})

interface MessageBubbleProps {
  message: Message
  contactName?: string
  onMediaClick?: (url: string, type: string) => void
  onRetry?: (message: Message) => void
  onReply?: (message: Message) => void
  onQuotedMessageClick?: (quotedMessageId: string) => void
  onForward?: (message: Message) => void
  onDelete?: (message: Message) => void
  onEdit?: (message: Message) => void
  onInfo?: (message: Message) => void
  onCopy?: (message: Message) => void
  compactSelection?: boolean
  selected?: boolean
  onSelect?: (message: Message) => void
  onToggleStickerFavorite?: (mediaUrl: string) => void | Promise<void>
  onReact?: (message: Message, emoji: string) => void
  savedStickerUrls?: Set<string>
  savingStickerUrls?: Set<string>
}

// Convert MinIO public URL to backend proxy URL
const getProxyUrl = (url: string | undefined): string => {
  const proxyUrl = canonicalChatMediaUrl(url)
  if (!proxyUrl && url) console.warn('[getProxyUrl] Unrecognized media URL:', url)
  return proxyUrl
}

// Format quoted sender name for display
const formatQuotedSender = (sender?: string, isFromMe?: boolean): string => {
  if (!sender) return ''
  if (sender === 'Me' || isFromMe) return 'Tú'
  // Remove @s.whatsapp.net suffix
  return sender.replace(/@s\.whatsapp\.net$/, '').replace(/@lid$/, '')
}

function MessageBubble({ message, contactName, onMediaClick, onRetry, onReply, onQuotedMessageClick, onForward, onDelete, onEdit, onInfo, onCopy, compactSelection = false, selected = false, onSelect, onToggleStickerFavorite, onReact, savedStickerUrls, savingStickerUrls }: MessageBubbleProps) {
  const [imageLoaded, setImageLoaded] = useState(false)
  const [imageError, setImageError] = useState(false)
  const [stickerLoadError, setStickerLoadError] = useState(false)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [showFullPicker, setShowFullPicker] = useState(false)
  const [showContextMenu, setShowContextMenu] = useState(false)
  const [pickerPos, setPickerPos] = useState({ top: 8, left: 8, width: 350, height: 400 })
  const [menuPos, setMenuPos] = useState({ top: 8, left: 8, maxHeight: 240 })
  const [quickReactionPos, setQuickReactionPos] = useState({ top: 8, left: 8, maxWidth: 304 })
  const emojiPickerRef = useRef<HTMLDivElement>(null)
  const reactionBtnRef = useRef<HTMLButtonElement>(null)
  const plusBtnRef = useRef<HTMLButtonElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const chevronBtnRef = useRef<HTMLButtonElement>(null)
  const longPressTimerRef = useRef<number | null>(null)
  const longPressOriginRef = useRef({ x: 0, y: 0 })
  const suppressClickRef = useRef(false)

  const QUICK_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏']

  const cancelLongPress = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }, [])

  const beginLongPress = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!compactSelection || !onSelect || message.is_revoked || (message.id || '').startsWith('optimistic-')) return
    if ((event.target as HTMLElement).closest('button, a, input, textarea, audio, video')) return
    cancelLongPress()
    suppressClickRef.current = false
    longPressOriginRef.current = { x: event.clientX, y: event.clientY }
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTimerRef.current = null
      suppressClickRef.current = true
      onSelect(message)
      if ('vibrate' in navigator) navigator.vibrate?.(20)
    }, 500)
  }, [cancelLongPress, compactSelection, message, onSelect])

  const moveLongPress = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (longPressTimerRef.current === null) return
    const deltaX = Math.abs(event.clientX - longPressOriginRef.current.x)
    const deltaY = Math.abs(event.clientY - longPressOriginRef.current.y)
    if (deltaX > 10 || deltaY > 10) cancelLongPress()
  }, [cancelLongPress])

  const finishLongPress = useCallback(() => cancelLongPress(), [cancelLongPress])

  useEffect(() => cancelLongPress, [cancelLongPress])

  useEffect(() => {
    if (!selected) return
    closeAllPickers()
  }, [selected])

  const visualViewportBounds = useCallback(() => {
    const viewport = window.visualViewport
    const left = viewport?.offsetLeft || 0
    const top = viewport?.offsetTop || 0
    return {
      left,
      top,
      width: viewport?.width || window.innerWidth,
      height: viewport?.height || window.innerHeight,
    }
  }, [])

  const positionContextMenu = useCallback(() => {
    const anchor = chevronBtnRef.current
    if (!anchor) return
    const anchorRect = anchor.getBoundingClientRect()
    const viewport = visualViewportBounds()
    const margin = 8
    const menuWidth = contextMenuRef.current?.offsetWidth || 190
    const maxHeight = Math.max(132, viewport.height - margin * 2)
    const menuHeight = Math.min(contextMenuRef.current?.offsetHeight || 240, maxHeight)
    const viewportRight = viewport.left + viewport.width
    const viewportBottom = viewport.top + viewport.height
    let left = message.is_from_me ? anchorRect.right - menuWidth : anchorRect.left
    let top = anchorRect.bottom + 4
    if (top + menuHeight > viewportBottom - margin) top = anchorRect.top - menuHeight - 4
    left = Math.max(viewport.left + margin, Math.min(left, viewportRight - menuWidth - margin))
    top = Math.max(viewport.top + margin, Math.min(top, viewportBottom - menuHeight - margin))
    setMenuPos({ top, left, maxHeight })
  }, [message.is_from_me, visualViewportBounds])

  const positionQuickReactions = useCallback(() => {
    const directAnchor = reactionBtnRef.current
    const anchor = directAnchor?.offsetParent ? directAnchor : chevronBtnRef.current
    if (!anchor) return
    const anchorRect = anchor.getBoundingClientRect()
    const viewport = visualViewportBounds()
    const margin = 8
    const maxWidth = Math.max(1, viewport.width - margin * 2)
    const pickerWidth = Math.min(emojiPickerRef.current?.offsetWidth || 304, maxWidth)
    const pickerHeight = emojiPickerRef.current?.offsetHeight || 54
    const viewportRight = viewport.left + viewport.width
    const viewportBottom = viewport.top + viewport.height
    let left = message.is_from_me ? anchorRect.right - pickerWidth : anchorRect.left
    let top = anchorRect.top - pickerHeight - 6
    if (top < viewport.top + margin) top = anchorRect.bottom + 6
    left = Math.max(viewport.left + margin, Math.min(left, viewportRight - pickerWidth - margin))
    top = Math.max(viewport.top + margin, Math.min(top, viewportBottom - pickerHeight - margin))
    setQuickReactionPos({ top, left, maxWidth })
  }, [message.is_from_me, visualViewportBounds])

  const closeAllPickers = () => {
    setShowEmojiPicker(false)
    setShowFullPicker(false)
    setShowContextMenu(false)
  }

  const handleOpenFullPicker = () => {
    if (plusBtnRef.current) {
      const rect = plusBtnRef.current.getBoundingClientRect()
      const visualViewport = window.visualViewport
      const viewportLeft = visualViewport?.offsetLeft || 0
      const viewportTop = visualViewport?.offsetTop || 0
      const viewportWidth = visualViewport?.width || window.innerWidth
      const viewportHeight = visualViewport?.height || window.innerHeight
      const pickerWidth = Math.min(350, Math.max(1, viewportWidth - 16))
      const pickerHeight = Math.min(400, Math.max(1, viewportHeight - 16))
      let left = message.is_from_me ? rect.right - pickerWidth : rect.left
      let top = rect.top - pickerHeight - 8
      // Clamp to viewport
      if (top < viewportTop + 8) top = Math.min(rect.bottom + 8, viewportTop + viewportHeight - pickerHeight - 8)
      left = Math.max(viewportLeft + 8, Math.min(left, viewportLeft + viewportWidth - pickerWidth - 8))
      top = Math.max(viewportTop + 8, Math.min(top, viewportTop + viewportHeight - pickerHeight - 8))
      setPickerPos({ top, left, width: pickerWidth, height: pickerHeight })
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

  // Menus live in a body portal so the message scroller cannot clip them.
  useLayoutEffect(() => {
    if (showContextMenu) positionContextMenu()
  }, [positionContextMenu, showContextMenu])

  useLayoutEffect(() => {
    if (showEmojiPicker && !showFullPicker) positionQuickReactions()
  }, [positionQuickReactions, showEmojiPicker, showFullPicker])

  useEffect(() => {
    if (!showContextMenu && (!showEmojiPicker || showFullPicker)) return
    const reposition = () => {
      if (showContextMenu) positionContextMenu()
      if (showEmojiPicker && !showFullPicker) positionQuickReactions()
    }
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    window.visualViewport?.addEventListener('resize', reposition)
    window.visualViewport?.addEventListener('scroll', reposition)
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
      window.visualViewport?.removeEventListener('resize', reposition)
      window.visualViewport?.removeEventListener('scroll', reposition)
    }
  }, [positionContextMenu, positionQuickReactions, showContextMenu, showEmojiPicker, showFullPicker])

  useEffect(() => {
    setImageLoaded(false)
    setImageError(false)
    setStickerLoadError(false)
  }, [message.media_url])

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
    if (!message.quoted_message_id) return null
    const quotedPreview = message.quoted_body?.trim() || 'Mensaje citado'

    return (
      <button
        type="button"
        onClick={() => onQuotedMessageClick?.(message.quoted_message_id!)}
        className={`mb-1 block w-full rounded border-l-4 px-2 py-1 text-left transition ${message.is_from_me ? 'border-emerald-600 bg-emerald-50/70 hover:bg-emerald-100/80' : 'border-slate-400 bg-slate-50 hover:bg-slate-100'} ${onQuotedMessageClick ? 'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500' : 'cursor-default'}`}
        aria-label={onQuotedMessageClick ? 'Ir al mensaje respondido' : undefined}
      >
        {message.quoted_sender && (
          <p className="text-xs font-semibold text-emerald-700 truncate">
            {message.quoted_is_from_me || message.quoted_sender === 'Me'
              ? 'Tú'
              : (contactName || formatQuotedSender(message.quoted_sender))}
          </p>
        )}
        <p className="text-xs text-slate-600 truncate max-w-[250px]">
          {quotedPreview}
        </p>
      </button>
    )
  }

  const renderMedia = () => {
    if (message.media_deleted) {
      return (
        <div className="flex items-center gap-3 p-2 bg-slate-100 rounded-lg mb-1">
          <div className="w-9 h-9 bg-slate-200 rounded-lg flex items-center justify-center shrink-0">
            <FileText className="w-5 h-5 text-slate-500" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-600">Archivo eliminado</p>
            <p className="text-xs text-slate-400">Se liberó espacio de la cuenta</p>
          </div>
        </div>
      )
    }

    // View-once: show special indicator instead of actual media
    if (message.is_view_once) {
      return (
        <div className="flex items-center gap-2 px-2 py-2 bg-slate-50 rounded-lg mb-1">
          <Eye className="w-5 h-5 text-slate-400" />
          <span className="text-sm text-slate-500 italic">
            {message.message_type === 'video' || message.message_type === 'gif' ? 'Video' : 'Foto'} · Ver una vez
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
            className={`relative cursor-pointer overflow-hidden bg-gray-100 ${imageLoaded || imageError ? '' : 'min-h-48'}`}
            onClick={() => onMediaClick?.(proxyUrl, 'image')}
          >
            {!imageLoaded && !imageError && (
              <div className="absolute inset-0 flex min-h-48 w-full animate-pulse items-center justify-center bg-gray-200">
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
                loading="lazy"
                decoding="async"
                className={`block w-full transition-opacity duration-150 ${imageLoaded ? 'opacity-100' : 'opacity-0'}`}
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

      case 'gif': {
        const sourceIsOriginalGIF = message.media_mimetype === 'image/gif' || /\.gif(?:$|\?)/i.test(message.media_url)
        return (
          <div className="relative overflow-hidden bg-black">
            {sourceIsOriginalGIF ? (
              <img src={proxyUrl} alt="GIF" loading="lazy" decoding="async" className="block w-full" />
            ) : (
              <video src={proxyUrl} className="w-full block" autoPlay loop muted playsInline preload="metadata" />
            )}
            <span className="absolute bottom-2 left-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-bold text-white">GIF</span>
          </div>
        )
      }

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

      case 'sticker': {
        const stickerIdentity = chatMediaIdentity(message.media_url)
        const stickerIsSaved = savedStickerUrls?.has(stickerIdentity) ?? false
        const stickerIsSaving = savingStickerUrls?.has(stickerIdentity) ?? false
        const canSaveSticker = !!onToggleStickerFavorite && !isOptimistic && !message.media_url.startsWith('blob:')
        return (
          <div className="group/sticker relative">
            {stickerLoadError ? (
              <div className="flex h-40 w-40 flex-col items-center justify-center gap-2 rounded-xl border border-slate-200 bg-slate-50 text-slate-500">
                <AlertCircle className="h-6 w-6" />
                <span className="text-xs font-medium">Sticker no disponible</span>
              </div>
            ) : (
              <img
                src={proxyUrl}
                alt="Sticker"
                loading="lazy"
                decoding="async"
                className="h-40 w-40 object-contain"
                onError={() => setStickerLoadError(true)}
              />
            )}
            {canSaveSticker && (
              <button
                type="button"
                onClick={event => {
                  event.stopPropagation()
                  void onToggleStickerFavorite(message.media_url!)
                }}
                disabled={stickerIsSaving}
                aria-pressed={stickerIsSaved}
                aria-label={stickerIsSaved ? 'Quitar sticker de favoritos' : 'Guardar sticker en favoritos'}
                className={`absolute right-1 top-1 flex h-9 w-9 items-center justify-center rounded-full border shadow-md transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:cursor-wait ${
                  stickerIsSaved
                    ? 'border-amber-300 bg-amber-400 text-white'
                    : 'border-slate-200 bg-white/95 text-slate-500 opacity-100 hover:text-amber-500 sm:opacity-0 sm:group-hover/sticker:opacity-100 sm:group-focus-within/sticker:opacity-100'
                }`}
                title={stickerIsSaved ? 'Quitar de favoritos' : 'Guardar en favoritos'}
              >
                {stickerIsSaving
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <Star className={`h-4 w-4 ${stickerIsSaved ? 'fill-current' : ''}`} />}
              </button>
            )}
          </div>
        )
      }

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

    return (
      <div className="mb-1">
        <a href={mapUrl} target="_blank" rel="noopener noreferrer" className="block">
          <div className="rounded-lg overflow-hidden bg-slate-100 border border-slate-200">
            <div className="h-[150px] flex flex-col items-center justify-center gap-2 text-slate-600 px-4 text-center">
              <div className="w-10 h-10 rounded-full bg-white shadow-sm flex items-center justify-center text-emerald-600">
                <MapPin className="w-5 h-5" />
              </div>
              <div>
                <div className="text-sm font-medium text-slate-800">{message.body || 'Ubicación compartida'}</div>
                <div className="text-xs text-slate-500 mt-0.5">{lat.toFixed(6)}, {lng.toFixed(6)}</div>
              </div>
            </div>
            <div className="bg-white/80 px-3 py-2 border-t border-slate-200">
              <div className="flex items-center gap-1 text-emerald-700 text-xs font-medium">
                <MapPin className="w-3.5 h-3.5" />
                <span>Abrir en OpenStreetMap</span>
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
    for (const r of dedupeReactions(message.reactions)) {
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
          <button onClick={() => onRetry?.(message)} className="flex items-center gap-1 text-red-500 hover:text-red-700" title="Reintentar">
            <AlertCircle className="w-4 h-4" />
            <RefreshCw className="w-3 h-3" />
          </button>
        )
      default:
        return <Check className="w-4 h-4 text-gray-400" />
    }
  }

  const hasVisualMedia = !!message.media_url && ['image', 'video', 'gif'].includes(message.message_type || '') && !message.is_view_once
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
  const hasPersistentTouchAction = !compactSelection && !isOptimistic && message.message_type !== 'sticker' && !isEmojiOnly

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
    <div
      className={`${styles.messageContainer} ${compactSelection ? styles.compactSelectionSurface : ''} group flex rounded-xl transition-colors ${message.is_from_me ? 'justify-end' : 'justify-start'} ${selected ? 'bg-emerald-200/65 ring-2 ring-inset ring-emerald-500/40' : ''}`}
      onPointerDown={beginLongPress}
      onPointerMove={moveLongPress}
      onPointerUp={finishLongPress}
      onPointerCancel={finishLongPress}
      onContextMenu={event => {
        if (!compactSelection || !onSelect) return
        event.preventDefault()
        cancelLongPress()
        onSelect(message)
      }}
      onClickCapture={event => {
        if (!suppressClickRef.current) return
        suppressClickRef.current = false
        event.preventDefault()
        event.stopPropagation()
      }}
      onKeyDown={event => {
        if (!compactSelection || !onSelect || (event.key !== 'Enter' && event.key !== ' ')) return
        event.preventDefault()
        onSelect(message)
      }}
      tabIndex={compactSelection ? 0 : undefined}
      role={compactSelection ? 'group' : undefined}
      aria-label={compactSelection ? (selected ? 'Mensaje seleccionado' : 'Mantén presionado para ver acciones del mensaje') : undefined}
    >
      {/* Wrapper for message bubble + hover controls + reaction popup */}
      <div className={`relative max-w-[85%] sm:max-w-[70%] ${hasPersistentTouchAction ? styles.touchActionWrapper : ''}`}>
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
        {message.quoted_message_id && (
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
      {!compactSelection && !isOptimistic && message.message_type !== 'sticker' && !isEmojiOnly && (
        <div data-open={showContextMenu || showEmojiPicker} className={`${styles.messageActions} ${message.is_from_me ? styles.messageActionsFromMe : styles.messageActionsIncoming} absolute right-1 top-1 z-10 flex items-center rounded-md transition-opacity duration-150 ${message.is_from_me ? 'bg-[#d9fdd3]/90' : 'bg-white/90'}`}>
          {onReact && <button
            ref={reactionBtnRef}
            type="button"
            onClick={(e) => { e.stopPropagation(); setShowEmojiPicker(!showEmojiPicker); setShowContextMenu(false) }}
            className={`${styles.messageActionButton} ${styles.reactionTrigger} rounded-md text-slate-500 transition-colors hover:bg-black/5 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500`}
            title="Reaccionar"
            aria-label="Reaccionar al mensaje"
          >
            <SmilePlus className="w-4 h-4" />
          </button>}
          <button
            ref={chevronBtnRef}
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              setShowContextMenu(!showContextMenu)
              setShowEmojiPicker(false)
            }}
            className={`${styles.messageActionButton} rounded-md text-slate-500 transition-colors hover:bg-black/5 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500`}
            title="Más opciones"
            aria-label="Más acciones del mensaje"
            aria-haspopup="menu"
            aria-expanded={showContextMenu}
          >
            <ChevronDown className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Context menu dropdown */}
      {showContextMenu && typeof document !== 'undefined' && createPortal(
        <div
          ref={contextMenuRef}
          role="menu"
          className="fixed z-[90] min-w-[190px] overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-xl"
          style={menuPos}
        >
          {onReact && <button
            type="button"
            role="menuitem"
            onClick={() => { setShowEmojiPicker(true); setShowContextMenu(false) }}
            className="flex min-h-11 w-full items-center gap-3 px-3 text-sm text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500"
          >
            <SmilePlus className="h-4 w-4 text-slate-400" />
            Reaccionar
          </button>}
          {onReply && <button
            type="button"
            role="menuitem"
            onClick={() => { onReply?.(message); closeAllPickers() }}
            className="flex min-h-11 w-full items-center gap-3 px-3 text-sm text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500"
          >
            <Reply className="w-4 h-4 text-slate-400" />
            Responder
          </button>}
          {onForward && <button
            type="button"
            role="menuitem"
            onClick={() => { onForward?.(message); closeAllPickers() }}
            className="flex min-h-11 w-full items-center gap-3 px-3 text-sm text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500"
          >
            <Forward className="w-4 h-4 text-slate-400" />
            Reenviar
          </button>}
          {onCopy && (message.body || message.media_filename) && (
            <button
              type="button"
              role="menuitem"
              onClick={() => { onCopy(message); closeAllPickers() }}
              className="flex min-h-11 w-full items-center gap-3 px-3 text-sm text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500"
            >
              <Copy className="h-4 w-4 text-slate-400" />
              Copiar
            </button>
          )}
          {onInfo && message.is_from_me && (
            <button
              type="button"
              role="menuitem"
              onClick={() => { onInfo(message); closeAllPickers() }}
              className="flex min-h-11 w-full items-center gap-3 px-3 text-sm text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500"
            >
              <Info className="h-4 w-4 text-slate-400" />
              Información
            </button>
          )}
          {onEdit && message.is_from_me && message.message_type === 'text' && !message.is_revoked && (
            <button
              type="button"
              role="menuitem"
              onClick={() => { onEdit(message); closeAllPickers() }}
              className="flex min-h-11 w-full items-center gap-3 px-3 text-sm text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500"
            >
              <Pencil className="w-4 h-4 text-slate-400" />
              Editar
            </button>
          )}
          {onDelete && message.is_from_me && (
            <>
              <div className="border-t border-slate-100 my-1" />
              <button
                type="button"
                role="menuitem"
                onClick={() => { onDelete(message); closeAllPickers() }}
                className="flex min-h-11 w-full items-center gap-3 px-3 text-sm text-red-600 transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red-500"
              >
                <Trash2 className="w-4 h-4" />
                Eliminar para todos
              </button>
            </>
          )}
        </div>,
        document.body,
      )}

      {/* Quick reaction bar - positioned above message bubble like WhatsApp Web */}
      {showEmojiPicker && !showFullPicker && typeof document !== 'undefined' && createPortal(
        <div
          ref={emojiPickerRef}
          className="fixed z-[90] flex items-center gap-0.5 overflow-x-auto rounded-full border border-gray-100 bg-white px-2 py-1.5 shadow-xl"
          style={{ top: quickReactionPos.top, left: quickReactionPos.left, maxWidth: quickReactionPos.maxWidth }}
        >
          {QUICK_EMOJIS.map((e) => (
            <button
              type="button"
              key={e}
              onClick={() => { onReact?.(message, e); closeAllPickers() }}
              className={`${styles.reactionOption} rounded-full transition-all hover:scale-110 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500`}
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
            type="button"
            onClick={handleOpenFullPicker}
            className={`${styles.reactionOption} rounded-full transition-all hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500`}
            title="Más reacciones"
          >
            <Plus className="w-5 h-5 text-gray-400" />
          </button>
        </div>,
        document.body,
      )}

      {/* Full emoji picker for reactions - rendered via portal */}
      {showFullPicker && typeof document !== 'undefined' && createPortal(
        <>
          <div className="app-viewport fixed inset-0 z-[100]" onClick={closeAllPickers} />
          <div
            className="fixed z-[101] rounded-xl overflow-hidden shadow-2xl"
            style={{ top: pickerPos.top, left: pickerPos.left, width: pickerPos.width, height: pickerPos.height }}
          >
            <EmojiPickerReact
              onEmojiClick={(emojiData: any) => { onReact?.(message, emojiData.emoji); closeAllPickers() }}
              searchPlaceHolder="Buscar una reacción..."
              width={pickerPos.width}
              height={pickerPos.height}
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

export default memo(MessageBubble)
