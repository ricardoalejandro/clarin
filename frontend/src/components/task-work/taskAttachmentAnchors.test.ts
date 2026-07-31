import { describe, expect, it } from 'vitest'
import { normalizedAttachmentPoint, textAttachmentAnchor } from './taskAttachmentAnchors'

describe('task attachment anchors', () => {
  it('normalizes image and PDF coordinates and clamps outside clicks', () => {
    expect(normalizedAttachmentPoint('image', { left: 10, top: 20, width: 100, height: 200 }, 60, 120)).toMatchObject({ kind: 'image', x: .5, y: .5 })
    expect(normalizedAttachmentPoint('pdf', { left: 10, top: 20, width: 100, height: 200 }, 500, -10, 4)).toEqual({ kind: 'pdf', page: 4, x: 1, y: 0 })
  })

  it('anchors safe text context by line, offset and bounded quote', () => {
    expect(textAttachmentAnchor('one\ntwo\nthree', 7, 'two')).toEqual({ kind: 'text', line: 2, offset: 7, quote: 'two' })
    expect(textAttachmentAnchor('short', 99, 'x'.repeat(700)).quote).toHaveLength(500)
  })
})
