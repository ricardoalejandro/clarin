import { describe, expect, it } from 'vitest'
import { DocumentBuffer } from './documentBuffer'

describe('bounded document buffer', () => {
  it('applies multiple original-offset edits atomically and counts UTF-8 bytes', () => {
    const buffer = new DocumentBuffer('a😀b\r\nend')
    expect(buffer.apply([{ rangeOffset: 3, rangeLength: 1, text: 'ñ' }, { rangeOffset: 0, rangeLength: 1, text: 'Ω' }])).toBe(true)
    expect(buffer.snapshot()).toBe('Ω😀ñ\r\nend')
    expect(buffer.bytes).toBe(new TextEncoder().encode(buffer.snapshot()).byteLength)
    expect(buffer.slice(1, 3)).toBe('😀')
  })
  it('rejects overflow, overlap and surrogate splitting without changing the source', () => {
    const buffer = new DocumentBuffer('a😀z')
    expect(buffer.apply([{ rangeOffset: 2, rangeLength: 1, text: '' }])).toBe(false)
    expect(buffer.apply([{ rangeOffset: 0, rangeLength: 1, text: 'too big' }], 6)).toBe(false)
    expect(buffer.apply([{ rangeOffset: 0, rangeLength: 3, text: '' }, { rangeOffset: 1, rangeLength: 1, text: '' }])).toBe(false)
    expect(buffer.snapshot()).toBe('a😀z')
  })
  it('supports edits in a 30 MiB source and retains bounded slices', () => {
    const buffer = new DocumentBuffer('x'.repeat(30 * 1024 * 1024))
    expect(buffer.apply([{ rangeOffset: 28 * 1024 * 1024, rangeLength: 3, text: 'end' }])).toBe(true)
    expect(buffer.slice(28 * 1024 * 1024 - 1, 28 * 1024 * 1024 + 4)).toBe('xendx')
    expect(buffer.length).toBe(30 * 1024 * 1024)
  })
})
