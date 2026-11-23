import { describe, expect, it } from 'vitest'
import { hydrateMentions, insertMention, mentionQuery, reconcileMentionRanges, serializeMentions } from './chatMentions'
describe('structured WhatsApp mentions', () => {
  const member = { jid: '51999900001@s.whatsapp.net', name: 'María León' }
  const draft = insertMention({ text: 'Hola @Mar', mentions: [] }, { start: 5, end: 9 }, member)
  it('uses provider identities, retains Unicode labels and deduplicates recipients', () => {
    expect(draft.text).toBe('Hola @María León ')
    const wire = serializeMentions(draft.text, draft.mentions)
    expect(wire).toEqual({ body: 'Hola @51999900001 ', mentions: [member] })
    expect(hydrateMentions(wire.body, wire.mentions)).toEqual(draft)
  })
  it('only recognizes an at-sign at a word boundary, never email', () => {
    expect(mentionQuery('mail@host', 9)).toBeNull()
    expect(mentionQuery('hola @María', 11)?.query).toBe('María')
  })
  it('shifts after an earlier edit, preserves formatting and invalidates edited identities', () => {
    expect(reconcileMentionRanges(draft.text, 'XX' + draft.text, draft.mentions)[0].start).toBe(7)
    expect(reconcileMentionRanges(draft.text, draft.text.replace('María', 'Lucía'), draft.mentions)).toEqual([])
    expect(reconcileMentionRanges(draft.text, 'Hola *@María León* ', draft.mentions, true)[0]).toMatchObject({ start: 6, end: 17 })
    expect(serializeMentions(draft.text.replace('María', 'Lucía'), draft.mentions).mentions).toEqual([])
  })
  it('does not infer a mention from a matching display name or pasted text', () => {
    expect(hydrateMentions('Hola @María León', [member]).mentions).toEqual([])
    expect(reconcileMentionRanges(draft.text, 'Otro @María León texto', draft.mentions)).toEqual([])
  })
})
