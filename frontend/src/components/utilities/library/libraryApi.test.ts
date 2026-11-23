import { describe, expect, it } from 'vitest'
import { closeOpenDocument, deletedWorkspaceMatches, minimalTextEdit, moveOpenDocument } from './libraryApi'

describe('utility document identity and incremental edits', () => {
  it.each([
    ['hello world', 'hello brave world'], ['{ "á": 1 }', '{ "á": 2 }'],
    ['a😀z', 'a😁z'], ['😀', ''], ['', '多行\nñ'], ['same', 'same'],
  ])('reconstructs the exact UTF-16 document: %s -> %s', (before, after) => {
    const edit = minimalTextEdit(before, after)
    expect(edit ? before.slice(0, edit.offset) + edit.text + before.slice(edit.offset + edit.delete_count) : before).toBe(after)
    if (edit) {
      expect(/^[\uDC00-\uDFFF]/.test(edit.text)).toBe(false)
      expect(/[\uD800-\uDBFF]$/.test(edit.text)).toBe(false)
    }
  })
  it('sends a small replacement for a large document', () => {
    const before = 'x'.repeat(2_000_000) + 'old' + 'y'.repeat(2_000_000)
    expect(minimalTextEdit(before, before.replace('old', 'new'))).toEqual({ offset: 2_000_000, delete_count: 3, text: 'new' })
  })
  it('closing a tab chooses a neighbor and never represents a document deletion', () => {
    expect(closeOpenDocument({ open_ids: ['a', 'b', 'c'], active_id: 'b', version: 7 }, 'b')).toEqual({ open_ids: ['a', 'c'], active_id: 'c', version: 7 })
    expect(closeOpenDocument({ open_ids: ['a'], active_id: 'a', version: 7 }, 'a').active_id).toBeNull()
  })
  it('moves tabs without changing IDs, losing tabs or moving beyond the edge', () => {
    expect(moveOpenDocument(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c'])
    expect(moveOpenDocument(['a', 'b'], 'a', -1)).toEqual(['a', 'b'])
  })
  it('adopts deletion-owned workspace versions only for the exact expected tab change', () => {
    const current = { open_ids: ['a', 'b'], active_id: 'a', version: 3 }
    expect(deletedWorkspaceMatches(current, 'a', { open_ids: ['b'], active_id: null, version: 4 })).toBe(true)
    expect(deletedWorkspaceMatches(current, 'a', { open_ids: ['b', 'other-device'], active_id: null, version: 5 })).toBe(false)
    expect(deletedWorkspaceMatches(current, 'a', { open_ids: ['b'], active_id: 'b', version: 5 })).toBe(false)
    expect(deletedWorkspaceMatches(current, 'a', null)).toBe(false)
  })
})
