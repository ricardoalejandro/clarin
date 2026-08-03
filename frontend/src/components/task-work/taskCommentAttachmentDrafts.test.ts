import { describe, expect, it } from 'vitest'
import type { TaskAttachment } from '@/types/task'
import {
  mergeCommentAttachmentDrafts,
  removeCommentAttachmentDrafts,
  resolveCommentAttachment,
} from './taskCommentAttachmentDrafts'

const draft = { id: 'draft-1', filename: 'captura.png' } as TaskAttachment
const published = { id: 'published-1', filename: 'informe.pdf' } as TaskAttachment

describe('comment attachment draft lookup', () => {
  it('keeps comment drafts separate from the task attachment collection', () => {
    const taskAttachments = [published]
    const lookup = mergeCommentAttachmentDrafts({}, [draft])
    expect(taskAttachments).toEqual([published])
    expect(resolveCommentAttachment(draft.id, lookup, taskAttachments)).toBe(draft)
  })

  it('resolves already-published comment attachments without adding them to task files', () => {
    const lookup = mergeCommentAttachmentDrafts({}, [published])
    expect(resolveCommentAttachment(published.id, lookup, [])?.filename).toBe('informe.pdf')
  })

  it('removes only promoted or abandoned draft ids', () => {
    const other = { ...draft, id: 'draft-2' }
    const lookup = mergeCommentAttachmentDrafts({}, [draft, other])
    expect(removeCommentAttachmentDrafts(lookup, [draft.id])).toEqual({ [other.id]: other })
  })
})
