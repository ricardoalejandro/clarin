'use client'

import { useState } from 'react'
import { Check, CheckCheck, Download, FileText, Clock, AlertCircle, RefreshCw, Reply, Forward, Star } from 'lucide-react'
import { renderFormattedText } from '@/lib/whatsappFormat'

interface Message {
  id: string
  message_id: string
  from_jid?: string
  from_name?: string
  body?: string
  message_type?: string
  media_url?: string
  media_mimetype?: string
  media_filename?: string
  media_size?: number
  is_from_me: boolean
  is_read: boolean
  status?: string
  timestamp: string
  quoted_message_id?: string
  quoted_body?: string
  quoted_sender?: string
}

interface MessageBubbleProps {
  message: Message
  contactName?: string
  onMediaClick?: (url: string, type: string) => void
  onRetry?: () => void
  onReply?: (message: Message) => void
  onForward?: (message: Message) => void
  onSaveSticker?: (mediaUrl: string) => void
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

export default function MessageBubble({ message, contactName, onMediaClick, onRetry, onReply, onForward, onSaveSticker, savedStickerUrls }: MessageBubbleProps) {
  const [imageLoaded, setImageLoaded] = useState(false)
  const [imageError, setImageError] = useState(false)

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
      <div className={`border-l-4 ${message.is_from_me ? 'border-green-500 bg-green-50' : 'border-gray-400 bg-gray-50'} rounded px-2 py-1 mb-1 cursor-pointer`}>
        {message.quoted_sender && (
          <p className="text-xs font-semibold text-green-700 truncate">
            {formatQuotedSender(message.quoted_sender)}
          </p>
        )}
        <p className="text-xs text-gray-600 truncate max-w-[250px]">
          {message.quoted_body}
        </p>
      </div>
    )
  }

  const renderMedia = () => {
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
            className="relative cursor-pointer rounded-lg overflow-hidden mb-1 max-w-[280px]"
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
                className={`max-w-full rounded-lg ${imageLoaded ? 'block' : 'hidden'}`}
                onLoad={() => setImageLoaded(true)}
                onError={() => setImageError(true)}
              />
            )}
          </div>
        )

      case 'video':
        return (
          <div className="relative rounded-lg overflow-hidden mb-1 max-w-[300px] bg-black">
            <video
              src={proxyUrl}
              className="max-w-full rounded-lg"
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

  const isOptimistic = message.id.startsWith('optimistic-')

  return (
    <div className={`group flex ${message.is_from_me ? 'justify-end' : 'justify-start'}`}>
      {/* Action buttons - visible on mobile, hover on desktop (for outgoing: left side) */}
      {message.is_from_me && !isOptimistic && (
        <div className="flex md:hidden md:group-hover:flex items-center gap-1 mr-1 self-center">
          <button
            onClick={() => onForward?.(message)}
            className="p-1.5 rounded-full bg-white shadow-md hover:bg-gray-100 text-gray-500 hover:text-gray-700 transition-all"
            title="Reenviar"
          >
            <Forward className="w-4 h-4" />
          </button>
          <button
            onClick={() => onReply?.(message)}
            className="p-1.5 rounded-full bg-white shadow-md hover:bg-gray-100 text-gray-500 hover:text-gray-700 transition-all"
            title="Responder"
          >
            <Reply className="w-4 h-4" />
          </button>
        </div>
      )}

      <div
        className={`max-w-[85%] sm:max-w-[70%] ${
          message.message_type === 'sticker'
            ? 'p-1'
            : `px-3 py-2 rounded-lg shadow-sm ${
                message.is_from_me
                  ? 'bg-green-100 rounded-br-none'
                  : 'bg-white rounded-bl-none'
              }`
        }`}
      >
        {/* Sender name for incoming messages */}
        {!message.is_from_me && (senderDisplayName || message.from_name) && (
          <p className="text-xs text-green-600 font-medium mb-1">
            {senderDisplayName || message.from_name}
          </p>
        )}

        {/* Quoted message */}
        {renderQuotedMessage()}

        {/* Media content */}
        {renderMedia()}

        {/* Text body */}
        {message.body && message.message_type !== 'sticker' && (
          <p className="text-gray-800 whitespace-pre-wrap break-words">
            {renderFormattedText(message.body)}
          </p>
        )}

        {/* Empty placeholder for media-only messages */}
        {!message.body && message.media_url && message.message_type === 'image' && (
          <span className="sr-only">Imagen</span>
        )}

        {/* Timestamp and status */}
        <div className={`flex items-center justify-end gap-1 mt-1 ${message.message_type === 'sticker' ? 'bg-black/30 rounded-full px-2 py-0.5' : ''}`}>
          <span className={`text-xs ${message.message_type === 'sticker' ? 'text-white' : 'text-gray-500'}`}>
            {formatTime(message.timestamp)}
          </span>
          {renderStatus()}
        </div>
      </div>

      {/* Action buttons - visible on mobile, hover on desktop (for incoming: right side) */}
      {!message.is_from_me && !isOptimistic && (
        <div className="flex md:hidden md:group-hover:flex items-center gap-1 ml-1 self-center">
          <button
            onClick={() => onReply?.(message)}
            className="p-1.5 rounded-full bg-white shadow-md hover:bg-gray-100 text-gray-500 hover:text-gray-700 transition-all"
            title="Responder"
          >
            <Reply className="w-4 h-4" />
          </button>
          <button
            onClick={() => onForward?.(message)}
            className="p-1.5 rounded-full bg-white shadow-md hover:bg-gray-100 text-gray-500 hover:text-gray-700 transition-all"
            title="Reenviar"
          >
            <Forward className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  )
}
