import { expect, it } from 'vitest'
import { taskAttachmentCommentingAvailable } from './taskAttachmentPreviewState'

it('preparing existing attachment bytes never grants offline anchored-comment writes', () => {
  expect(taskAttachmentCommentingAvailable(true, true)).toBe(false)
  expect(taskAttachmentCommentingAvailable(false, true)).toBe(false)
  expect(taskAttachmentCommentingAvailable(false, false)).toBe(false)
  expect(taskAttachmentCommentingAvailable(true, false)).toBe(true)
})
