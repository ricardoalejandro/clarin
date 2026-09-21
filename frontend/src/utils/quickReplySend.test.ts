import { describe, expect, it } from 'vitest'
import { createQuickReplyComposerDraft, getQuickReplyItems, moveQuickReplyItem } from './quickReplies'
import { freezeQuickReplySequence } from './quickReplySend'
import type { QuickReply } from '@/types/quick-reply'

const reply: QuickReply = { id: 'q', shortcut: 'saludo', title: 'Saludo', updated_at: '', body: 'Texto inicial\n\nDespedida', attachments: [{ id: 'image', media_type: 'image', media_url: '/image', media_filename: 'foto.png', caption: '*Pie unido*\n😊', position: 0 }], items: [{ id: 'first', type: 'text', text: 'Texto inicial' }, { id: 'media', type: 'media', attachment_id: 'image' }, { id: 'last', type: 'text', text: 'Despedida' }] }
const context = { chatId: 'chat', jid: 'jid', deviceId: 'device', through: 'incoming-1', quote: null, trailingText: '' }
describe('quick reply sequence', () => {
  it('prepares one provider request per block with the caption attached to its image', () => {
    const frozen = freezeQuickReplySequence(createQuickReplyComposerDraft(reply)!, context)
    expect(frozen.items).toHaveLength(3)
    expect(frozen.items?.[1].payload).toMatchObject({ media_type: 'image', body: '*Pie unido*\n😊', media_filename: 'foto.png', defer_attention: true })
    expect(frozen.items?.map(item => item.payload?.body)).toEqual(['Texto inicial', '*Pie unido*\n😊', 'Despedida'])
    expect(new Set(frozen.items?.map(item => item.operationId)).size).toBe(3)
  })
  it('freezes retries after partial success, including the original attention watermark', () => {
    const frozen = freezeQuickReplySequence(createQuickReplyComposerDraft(reply)!, context)
    frozen.items![0].sent = true
    const retry = freezeQuickReplySequence(frozen, { ...context, through: 'new-incoming', trailingText: 'changed' })
    expect(retry).toBe(frozen)
    expect(retry.throughMessageId).toBe('incoming-1')
    expect(retry.items?.filter(item => !item.sent)).toHaveLength(2)
  })
  it('preserves legacy attachment-then-text interpretation and explicit reordering', () => {
    const legacy = getQuickReplyItems({ ...reply, items: undefined })
    expect(legacy.map(item => item.type)).toEqual(['media', 'text'])
    const moved = moveQuickReplyItem(legacy, 1, 0)
    expect(moved.map(item => item.type)).toEqual(['text', 'media'])
    expect(legacy[0].type).toBe('media')
  })
  it('keeps trailing personal text as one extra block without duplicating the searchable body', () => {
    const frozen = freezeQuickReplySequence(createQuickReplyComposerDraft(reply)!, { ...context, trailingText: 'Personalizado' })
    expect(frozen.items).toHaveLength(4)
    expect(frozen.items?.at(-1)?.payload?.body).toBe('Personalizado')
  })
})
