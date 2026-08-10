import { describe, expect, it } from 'vitest'
import { collectWhiteboardLibraryPages } from './whiteboardsApi'
import type { WhiteboardLibraryRecord } from './whiteboards'

function library(id: string): WhiteboardLibraryRecord {
  return {
    id,
    name: id,
    description: '',
    visibility: 'account',
    version: 1,
    created_at: '2026-08-09T00:00:00Z',
    updated_at: '2026-08-09T00:00:00Z',
  }
}

describe('whiteboard library pagination', () => {
  it('collects every stable page and deduplicates boundary rows', async () => {
    const cursors: Array<string | null> = []
    const result = await collectWhiteboardLibraryPages(async cursor => {
      cursors.push(cursor)
      return cursor === null
        ? { success: true, data: { libraries: [library('one'), library('two')], next_cursor: 'next' } }
        : { success: true, data: { libraries: [library('two'), library('three')], next_cursor: null } }
    })
    expect(cursors).toEqual([null, 'next'])
    expect(result.data?.libraries.map(item => item.id)).toEqual(['one', 'two', 'three'])
  })

  it('fails closed on a repeated cursor instead of looping forever', async () => {
    const result = await collectWhiteboardLibraryPages(async () => ({
      success: true,
      data: { libraries: [], next_cursor: 'same' },
    }))
    expect(result.success).toBe(false)
    expect(result.status).toBe(409)
  })
})
