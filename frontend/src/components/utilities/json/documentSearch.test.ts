import { describe, expect, it } from 'vitest'
import { findDocumentText } from './documentSearch'
import { TRAM_LENGTH } from './editorWorkspaceState'

describe('whole document literal search', () => {
  it('searches outside the displayed chunk and preserves Unicode offsets', () => {
    const source = 'x'.repeat(TRAM_LENGTH - 2) + '😀target' + 'x'.repeat(TRAM_LENGTH) + 'TARGET'
    const page = findDocumentText(source, 'target')
    expect(page.matches.map(match => match.offset)).toEqual([TRAM_LENGTH, source.length - 6])
    expect(findDocumentText(source, 'target', true).matches).toHaveLength(1)
  })
  it('treats regex punctuation literally and never changes case-folded offsets', () => {
    expect(findDocumentText('İ 😀 A.*[x] a.*[x]', 'a.*[x]').matches.map(match => match.offset)).toEqual([5, 12])
    expect(findDocumentText('.* anything', '.*').matches).toHaveLength(1)
  })
  it('pages matches without duplicates or skipping a boundary match', () => {
    const first = findDocumentText('a-a-a-a', 'a', false, 0, 2)
    expect(first.matches.map(match => match.offset)).toEqual([0, 2])
    expect(first.nextOffset).toBe(4)
    const last = findDocumentText('a-a-a-a', 'a', false, first.nextOffset!, 2)
    expect(last.matches.map(match => match.offset)).toEqual([4, 6])
    expect(last.nextOffset).toBeNull()
    expect(findDocumentText('anything', '').matches).toEqual([])
  })
})
