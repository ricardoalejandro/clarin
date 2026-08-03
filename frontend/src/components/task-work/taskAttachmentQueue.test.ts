import { describe, expect, it } from 'vitest'
import {
  TASK_ATTACHMENT_MAX_BYTES,
  enqueueTaskAttachmentFiles,
  markTaskAttachmentQueueItem,
  taskAttachmentQueueProgress,
  taskAttachmentUploadEndpoint,
  taskAttachmentUploadForm,
  taskCreationAttachmentSaveIntent,
  taskImageFilesFromClipboard,
} from './taskAttachmentQueue'

describe('task attachment queue', () => {
  it('adds valid files once and reports invalid empty/oversized files', () => {
    const image = new File(['image'], 'evidencia.png', { type: 'image/png', lastModified: 10 })
    const empty = new File([], 'vacio.png', { type: 'image/png' })
    const oversized = new File([new Uint8Array(1)], 'gigante.pdf', { type: 'application/pdf' })
    Object.defineProperty(oversized, 'size', { value: TASK_ATTACHMENT_MAX_BYTES + 1 })

    const first = enqueueTaskAttachmentFiles([], [image, empty, oversized])
    const second = enqueueTaskAttachmentFiles(first.queue, [image])

    expect(first.queue).toHaveLength(1)
    expect(first.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('vacío'),
      expect.stringContaining('50 MB'),
    ]))
    expect(second.queue).toHaveLength(1)
    expect(second.added).toHaveLength(0)
  })

  it('builds the single safe multipart task upload contract', () => {
    const image = new File(['image'], 'evidencia.png', { type: 'image/png' })
    const form = taskAttachmentUploadForm(image, 'operation-1')

    expect(taskAttachmentUploadEndpoint('task/unsafe')).toBe('/api/tasks/task%2Funsafe/attachments/upload')
    expect(form.get('file')).toBe(image)
    expect(form.get('operation_id')).toBe('operation-1')
    expect(form.get('attachment_context')).toBe('task')

    const commentForm = taskAttachmentUploadForm(image, 'operation-2', 'comment')
    expect(commentForm.get('attachment_context')).toBe('comment')
  })

  it('extracts only clipboard images and leaves plain text/non-image files untouched', () => {
    const image = new File(['image'], 'image.png', { type: 'image/jpeg', lastModified: 22 })
    const pdf = new File(['pdf'], 'documento.pdf', { type: 'application/pdf' })
    const clipboard = {
      items: [
        { kind: 'string', type: 'text/plain', getAsFile: () => null },
        { kind: 'file', type: 'application/pdf', getAsFile: () => pdf },
        { kind: 'file', type: 'image/jpeg', getAsFile: () => image },
      ],
      files: [pdf, image],
    } as unknown as Pick<DataTransfer, 'items' | 'files'>

    const files = taskImageFilesFromClipboard(clipboard)

    expect(files).toHaveLength(1)
    expect(files[0].type).toBe('image/jpeg')
    expect(files[0].name).toBe('imagen-pegada-1.jpg')
  })

  it('keeps deterministic retry progress without returning uploaded entries to pending', () => {
    const one = new File(['one'], 'one.png', { type: 'image/png', lastModified: 1 })
    const two = new File(['two'], 'two.png', { type: 'image/png', lastModified: 2 })
    let queue = enqueueTaskAttachmentFiles([], [one, two]).queue
    queue = markTaskAttachmentQueueItem(queue, queue[0].id, 'uploaded')
    queue = markTaskAttachmentQueueItem(queue, queue[1].id, 'failed', 'sin conexión')

    expect(taskAttachmentQueueProgress(queue)).toEqual({ total: 2, uploaded: 1, pending: 1, failed: 1 })
    expect(queue[0].status).toBe('uploaded')
    expect(queue[1]).toMatchObject({ status: 'failed', error: 'sin conexión' })
    expect(taskCreationAttachmentSaveIntent('created-task', queue, true)).toBe('retry-attachments')
    expect(taskCreationAttachmentSaveIntent(undefined, queue, true)).toBe('create-task')
    expect(taskCreationAttachmentSaveIntent('created-task', [queue[0]], true)).toBe('none')
  })
})
