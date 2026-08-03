export const TASK_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024

export function taskAttachmentUploadEndpoint(taskID: string) {
  return `/api/tasks/${encodeURIComponent(taskID)}/attachments/upload`
}

export function taskAttachmentUploadForm(file: File, operationID: string, attachmentContext: 'task' | 'comment' = 'task') {
  const form = new FormData()
  form.append('file', file)
  form.append('operation_id', operationID)
  form.append('attachment_context', attachmentContext)
  return form
}

export type TaskAttachmentQueueStatus = 'pending' | 'uploading' | 'uploaded' | 'failed'

export interface QueuedTaskAttachment {
  id: string
  file: File
  status: TaskAttachmentQueueStatus
  error?: string
  previewUrl?: string
}

export function taskAttachmentFileID(file: Pick<File, 'name' | 'size' | 'type' | 'lastModified'>) {
  return [file.name.trim().toLocaleLowerCase(), file.size, file.type.toLocaleLowerCase(), file.lastModified].join(':')
}

export function taskAttachmentValidationError(file: Pick<File, 'name' | 'size'>) {
  if (file.size <= 0) return `${file.name || 'El archivo'} está vacío.`
  if (file.size > TASK_ATTACHMENT_MAX_BYTES) return `${file.name || 'El archivo'} supera el límite de 50 MB.`
  return ''
}

export function enqueueTaskAttachmentFiles(current: QueuedTaskAttachment[], files: File[]) {
  const existing = new Set(current.map(item => item.id))
  const added: QueuedTaskAttachment[] = []
  const errors: string[] = []
  for (const file of files) {
    const error = taskAttachmentValidationError(file)
    if (error) {
      errors.push(error)
      continue
    }
    const id = taskAttachmentFileID(file)
    if (existing.has(id)) continue
    existing.add(id)
    added.push({ id, file, status: 'pending' })
  }
  return { queue: [...current, ...added], added, errors }
}

function clipboardFileName(file: File, index: number) {
  if (file.name && file.name !== 'image.png') return file.name
  const extension = file.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
  return `imagen-pegada-${index + 1}.${extension}`
}

export function taskImageFilesFromClipboard(clipboardData: Pick<DataTransfer, 'items' | 'files'>) {
  const itemFiles = Array.from(clipboardData.items || [])
    .filter(item => item.kind === 'file' && item.type.toLocaleLowerCase().startsWith('image/'))
    .map(item => item.getAsFile())
    .filter((file): file is File => Boolean(file))
  const candidates = itemFiles.length
    ? itemFiles
    : Array.from(clipboardData.files || []).filter(file => file.type.toLocaleLowerCase().startsWith('image/'))
  return candidates.map((file, index) => {
    const name = clipboardFileName(file, index)
    return name === file.name ? file : new File([file], name, { type: file.type, lastModified: file.lastModified })
  })
}

export function taskAttachmentQueueProgress(queue: QueuedTaskAttachment[]) {
  return {
    total: queue.length,
    uploaded: queue.filter(item => item.status === 'uploaded').length,
    pending: queue.filter(item => item.status === 'pending' || item.status === 'failed').length,
    failed: queue.filter(item => item.status === 'failed').length,
  }
}

export function markTaskAttachmentQueueItem(
  queue: QueuedTaskAttachment[],
  id: string,
  status: TaskAttachmentQueueStatus,
  error = '',
) {
  return queue.map(item => item.id === id ? { ...item, status, error: error || undefined } : item)
}

export function taskCreationAttachmentSaveIntent(
  createdTaskID: string | undefined,
  queue: QueuedTaskAttachment[],
  baseFormValid: boolean,
) {
  const pending = queue.filter(item => item.status === 'pending' || item.status === 'failed')
  if (createdTaskID) return pending.length ? 'retry-attachments' as const : 'none' as const
  return baseFormValid ? 'create-task' as const : 'none' as const
}
