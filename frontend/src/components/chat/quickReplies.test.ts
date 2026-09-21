import { describe, expect, it } from 'vitest'
import type { QuickReply } from '@/types/quick-reply'
import {
  buildQuickReplyComposerSelection,
  createQuickReplyComposerDraft,
  extractQuickReplyCommand,
  reconcileQuickReplyRealtime,
  markQuickReplyAttachmentFailed,
  markQuickReplyAttachmentSent,
  replaceQuickReplyCommand,
  sortQuickReplies,
} from '@/utils/quickReplies'

const reply = (overrides: Partial<QuickReply>): QuickReply => ({
  id: overrides.id || 'reply-1',
  shortcut: overrides.shortcut || 'saludo',
  title: overrides.title || '',
  body: overrides.body || '',
  attachments: overrides.attachments || [],
  updated_at: overrides.updated_at || '2026-09-17T10:00:00Z',
  media_url: overrides.media_url,
  media_type: overrides.media_type,
  media_filename: overrides.media_filename,
})

describe('quick reply commands', () => {
  it('recognizes Unicode, underscores and hyphens only in the terminal command', () => {
    expect(extractQuickReplyCommand('Texto previo /dirección-perú_2')).toEqual({
      query: 'dirección-perú_2',
      start: 13,
      end: 30,
    })
    expect(extractQuickReplyCommand('https://clarin.test/')).toBeNull()
    expect(extractQuickReplyCommand('/inicio texto')).toBeNull()
  })

  it('replaces the command without trimming surrounding content', () => {
    expect(replaceQuickReplyCommand('Hola  /saludo', 'Buenos días')).toBe('Hola  Buenos días')
    expect(replaceQuickReplyCommand('/saludo', 'Buenos días')).toBe('Buenos días')
  })
})

describe('quick reply composer selection', () => {
  it('orders canonical attachments and keeps the body as the final text message', () => {
    const selection = buildQuickReplyComposerSelection(reply({
      body: 'Texto final',
      attachments: [
        { id: 'b', media_url: '/b', media_type: 'image', media_filename: 'b.jpg', caption: 'B', position: 1 },
        { id: 'a', media_url: '/a', media_type: 'image', media_filename: 'a.jpg', caption: 'A', position: 0 },
      ],
    }))
    expect(selection.attachments.map(item => item.id)).toEqual(['a', 'b'])
    expect(selection.body).toBe('Texto final')
  })

  it('preserves legacy single-media semantics by using the body as its caption', () => {
    const selection = buildQuickReplyComposerSelection(reply({
      body: 'Pie heredado',
      media_url: '/legacy',
      media_type: 'image',
      media_filename: 'legacy.jpg',
    }))
    expect(selection.body).toBe('')
    expect(selection.attachments).toHaveLength(1)
    expect(selection.attachments[0].caption).toBe('Pie heredado')
  })

  it('advances sequentially and retains the failed item for an exact retry', () => {
    const source = reply({
      body: 'Texto final',
      attachments: [
        { id: 'a', media_url: '/a', media_type: 'image', media_filename: 'a.jpg', caption: '', position: 0 },
        { id: 'b', media_url: '/b', media_type: 'image', media_filename: 'b.jpg', caption: '', position: 1 },
      ],
    })
    const draft = createQuickReplyComposerDraft(source)
    expect(draft).not.toBeNull()
    const afterFirst = markQuickReplyAttachmentSent(draft!)
    expect(afterFirst.sentAttachments).toBe(1)
    expect(afterFirst.attachments.map(item => item.id)).toEqual(['b'])

    const failed = markQuickReplyAttachmentFailed(afterFirst, 'optimistic-2', 'Falló')
    expect(failed.sentAttachments).toBe(1)
    expect(failed.attachments[0]).toMatchObject({ id: 'b', sendTempId: 'optimistic-2' })
    expect(failed.error).toBe('Falló')
  })
})

describe('quick reply realtime reconciliation', () => {
  it('keeps canonical alphabetical order and updates filtered totals', () => {
    const current = [reply({ id: 'z', shortcut: 'zeta', body: 'Texto' })]
    const created = reply({ id: 'a', shortcut: 'ámbito', body: 'Texto' })
    const next = reconcileQuickReplyRealtime(current, 1, { action: 'created', quick_reply: created }, '', 'all')
    expect(next.replies.map(item => item.id)).toEqual(['a', 'z'])
    expect(next.total).toBe(2)

    const deleted = reconcileQuickReplyRealtime(next.replies, next.total, { action: 'deleted', quick_reply_id: 'a' }, '', 'all')
    expect(deleted.replies.map(item => item.id)).toEqual(['z'])
    expect(deleted.total).toBe(1)
  })

  it('sorts with stable IDs when shortcuts are equivalent', () => {
    expect(sortQuickReplies([
      reply({ id: 'b', shortcut: 'Dato' }),
      reply({ id: 'a', shortcut: 'dato' }),
    ]).map(item => item.id)).toEqual(['a', 'b'])
  })

  it('keeps totals stable for unloaded updates and decrements known all-list deletions', () => {
    const current = [reply({ id: 'a', shortcut: 'alfa' })]
    const unloadedUpdate = reconcileQuickReplyRealtime(
      current,
      80,
      { action: 'updated', quick_reply: reply({ id: 'z', shortcut: 'zeta' }) },
      '',
      'all',
    )
    expect(unloadedUpdate.total).toBe(80)
    expect(unloadedUpdate.replies.map(item => item.id)).toEqual(['a', 'z'])

    const unloadedDelete = reconcileQuickReplyRealtime(
      current,
      80,
      { action: 'deleted', quick_reply_id: 'z' },
      '',
      'all',
    )
    expect(unloadedDelete.total).toBe(79)
  })
})
