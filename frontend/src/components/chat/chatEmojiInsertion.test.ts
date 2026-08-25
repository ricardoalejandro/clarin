import { describe, expect, it } from 'vitest'
import { insertTextAtSelection } from '@/lib/whatsappEditor'

describe('chat emoji insertion', () => {
  it('inserts into an empty composer and advances by the full Unicode sequence', () => {
    const result = insertTextAtSelection('', { start: 0, end: 0 }, '👨‍👩‍👧‍👦')
    expect(result).toEqual({
      value: '👨‍👩‍👧‍👦',
      selection: { start: '👨‍👩‍👧‍👦'.length, end: '👨‍👩‍👧‍👦'.length },
    })
  })

  it('inserts at a saved middle caret without truncating a skin-tone emoji', () => {
    expect(insertTextAtSelection('Hola mundo', { start: 5, end: 5 }, '👋🏽 ').value).toBe('Hola 👋🏽 mundo')
  })

  it('replaces only the selected range', () => {
    expect(insertTextAtSelection('Hola mundo', { start: 5, end: 10 }, '❤️').value).toBe('Hola ❤️')
  })
})
