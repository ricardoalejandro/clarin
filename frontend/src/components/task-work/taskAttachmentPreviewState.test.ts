import { describe, expect, it } from 'vitest'
import {
  ATTACHMENT_PREVIEW_POLL_MAX_MS,
  ATTACHMENT_PREVIEW_SLOW_MS,
  ATTACHMENT_PREVIEW_TIMEOUT_MS,
  canRetryTaskAttachmentConversion,
  shouldPollTaskAttachmentPreview,
  taskAttachmentPreviewPhaseLabel,
  taskAttachmentPreviewPollDelay,
} from './taskAttachmentPreviewState'

describe('task attachment preview state', () => {
  it('uses the bounded slow and terminal timeout contract', () => {
    expect(ATTACHMENT_PREVIEW_SLOW_MS).toBe(8_000)
    expect(ATTACHMENT_PREVIEW_TIMEOUT_MS).toBe(30_000)
    expect(taskAttachmentPreviewPhaseLabel('downloading')).toBe('Descargando el archivo…')
    expect(taskAttachmentPreviewPhaseLabel('rendering')).toBe('Renderizando la página…')
  })

  it('polls only active Word conversions with bounded backoff', () => {
    expect(shouldPollTaskAttachmentPreview({ kind: 'word_pdf', status: 'pending' })).toBe(true)
    expect(shouldPollTaskAttachmentPreview({ kind: 'word_pdf', status: 'processing' })).toBe(true)
    expect(shouldPollTaskAttachmentPreview({ kind: 'word_pdf', status: 'failed' })).toBe(false)
    expect(shouldPollTaskAttachmentPreview({ kind: 'pdf', status: 'pending' })).toBe(false)
    expect(taskAttachmentPreviewPollDelay(0)).toBe(2_000)
    expect(taskAttachmentPreviewPollDelay(2)).toBe(8_000)
    expect(taskAttachmentPreviewPollDelay(20)).toBe(ATTACHMENT_PREVIEW_POLL_MAX_MS)
  })

  it('offers server retry only for terminal Word failures', () => {
    expect(canRetryTaskAttachmentConversion({ kind: 'word_pdf', status: 'failed' })).toBe(true)
    expect(canRetryTaskAttachmentConversion({ kind: 'word_pdf', status: 'processing' })).toBe(false)
    expect(canRetryTaskAttachmentConversion({ kind: 'pdf', status: 'failed' })).toBe(false)
    expect(canRetryTaskAttachmentConversion(null)).toBe(false)
  })
})
