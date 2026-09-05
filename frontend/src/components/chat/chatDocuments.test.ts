import { describe, expect, it } from 'vitest'
import { chatDocumentDescriptor, isPdfChatDocument } from '@/utils/chatDocuments'

describe('chat document classification', () => {
  it('classifies PDFs using MIME, original filename and canonical URL fallbacks', () => {
    expect(isPdfChatDocument({ media_mimetype: 'Application/PDF; version=1.7' })).toBe(true)
    expect(isPdfChatDocument({ media_filename: 'Contrato Final.PDF' })).toBe(true)
    expect(isPdfChatDocument({ media_url: '/api/media/file/account/media/pdf/hash.pdf?download=1' })).toBe(true)
    expect(isPdfChatDocument({ media_filename: 'presupuesto.xlsx', media_mimetype: 'application/vnd.ms-excel' })).toBe(false)
  })

  it('builds a stable viewer session with the original document metadata', () => {
    expect(chatDocumentDescriptor({
      id: 'row-1',
      message_id: 'provider-1',
      media_url: '/legacy/file.pdf',
      media_filename: ' contrato.pdf ',
      media_mimetype: 'application/pdf',
      media_size: 2048,
    }, '/api/media/file/account/file.pdf')).toEqual({
      sessionId: 'row-1:/api/media/file/account/file.pdf',
      src: '/api/media/file/account/file.pdf',
      filename: 'contrato.pdf',
      mimeType: 'application/pdf',
      size: 2048,
    })
  })
})
