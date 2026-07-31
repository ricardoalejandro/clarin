import type { TaskAttachmentPreview } from '@/types/task'

export const ATTACHMENT_PREVIEW_SLOW_MS = 8_000
export const ATTACHMENT_PREVIEW_TIMEOUT_MS = 30_000
export const ATTACHMENT_PREVIEW_POLL_MAX_MS = 15_000

export type TaskAttachmentPreviewPhase =
  | 'metadata'
  | 'converting'
  | 'downloading'
  | 'opening'
  | 'rendering'
  | 'ready'
  | 'unsupported'
  | 'error'

export function taskAttachmentPreviewPhaseLabel(phase: TaskAttachmentPreviewPhase) {
  switch (phase) {
    case 'metadata': return 'Consultando el archivo…'
    case 'converting': return 'Convirtiendo el documento…'
    case 'downloading': return 'Descargando el archivo…'
    case 'opening': return 'Abriendo el documento…'
    case 'rendering': return 'Renderizando la página…'
    default: return ''
  }
}

export function shouldPollTaskAttachmentPreview(preview: Pick<TaskAttachmentPreview, 'kind' | 'status'>) {
  return preview.kind === 'word_pdf' && (preview.status === 'pending' || preview.status === 'processing')
}

export function canRetryTaskAttachmentConversion(preview: Pick<TaskAttachmentPreview, 'kind' | 'status'> | null) {
  return preview?.kind === 'word_pdf' && preview.status === 'failed'
}

export function taskAttachmentPreviewPollDelay(attempt: number) {
  return Math.min(2_000 * (2 ** Math.max(0, attempt)), ATTACHMENT_PREVIEW_POLL_MAX_MS)
}
