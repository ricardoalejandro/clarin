export type ChatMediaType = 'image' | 'video' | 'audio' | 'document'

export const MAX_CHAT_FILE_SIZE = 32 * 1024 * 1024
export const MAX_CHAT_VIDEO_SIZE = 15 * 1024 * 1024

const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/3gpp', 'video/quicktime'])
const AUDIO_MIME_TYPES = new Set(['audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/wav', 'audio/opus', 'audio/aac', 'audio/mp4'])
const DOCUMENT_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  'application/zip',
  'application/x-rar-compressed',
  'application/vnd.rar',
])

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp'])
const VIDEO_EXTENSIONS = new Set(['mp4', '3gp', 'mov'])
const AUDIO_EXTENSIONS = new Set(['mp3', 'ogg', 'wav', 'opus', 'aac', 'm4a'])
const DOCUMENT_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'zip', 'rar'])

export type ChatAttachmentValidation =
  | { ok: true; mediaType: ChatMediaType }
  | { ok: false; error: string }

function getExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  return dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : ''
}

export function validateChatAttachment(file: File, forceDocument = false): ChatAttachmentValidation {
  if (file.size <= 0) {
    return { ok: false, error: 'El archivo está vacío y no se puede adjuntar.' }
  }
  if (file.size > MAX_CHAT_FILE_SIZE) {
    return { ok: false, error: 'El archivo es demasiado grande. El máximo es 32 MB.' }
  }

  const mimeType = file.type.toLowerCase()
  const extension = getExtension(file.name)

  if (forceDocument) {
    const supportedAsDocument = DOCUMENT_MIME_TYPES.has(mimeType) || DOCUMENT_EXTENSIONS.has(extension) || IMAGE_MIME_TYPES.has(mimeType) || IMAGE_EXTENSIONS.has(extension)
    return supportedAsDocument
      ? { ok: true, mediaType: 'document' }
      : { ok: false, error: 'Este tipo de archivo no se puede enviar como documento.' }
  }

  let mediaType: ChatMediaType | null = null
  if (IMAGE_MIME_TYPES.has(mimeType) || (!mimeType && IMAGE_EXTENSIONS.has(extension))) mediaType = 'image'
  else if (VIDEO_MIME_TYPES.has(mimeType) || (!mimeType && VIDEO_EXTENSIONS.has(extension))) mediaType = 'video'
  else if (AUDIO_MIME_TYPES.has(mimeType) || (!mimeType && AUDIO_EXTENSIONS.has(extension))) mediaType = 'audio'
  else if (DOCUMENT_MIME_TYPES.has(mimeType) || DOCUMENT_EXTENSIONS.has(extension)) mediaType = 'document'

  if (!mediaType) {
    return { ok: false, error: 'Este tipo de archivo no es compatible con el chat.' }
  }
  if (mediaType === 'video' && file.size > MAX_CHAT_VIDEO_SIZE) {
    return { ok: false, error: 'El video es demasiado grande. El máximo es 15 MB.' }
  }

  return { ok: true, mediaType }
}
