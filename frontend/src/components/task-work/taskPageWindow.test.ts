import { describe, expect, it, vi } from 'vitest'
import type { Task } from '@/types/task'
import { collectTaskWindow } from './taskPageWindow'

const row = (id: number) => ({ id: String(id), version: 1 }) as Task
describe('canonical task cursor window', () => {
  it('normalizes a null first page to an authoritative empty window', async () => {
    const load = vi.fn(async () => ({ tasks: null, total: 0, next_cursor: '', has_more: false }))
    const result = await collectTaskWindow(load, 150)
    expect(result).toEqual({ tasks: [], total: 0, next_cursor: '', has_more: false })
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('accepts a null final page after a concurrent page shrink', async () => {
    const result = await collectTaskWindow(async cursor => cursor
      ? { tasks: null, total: 1, next_cursor: '' }
      : { tasks: [row(1)], total: 2, next_cursor: 'next' }, 100)
    expect(result.tasks.map(task => task.id)).toEqual(['1'])
    expect(result.next_cursor).toBe('')
    expect(result.total).toBe(1)
  })

  it.each([{ total: 0 }, { tasks: {}, total: 1 }, { tasks: [], total: '0' }])('rejects malformed pages without silently deleting rows: %j', async page => {
    await expect(collectTaskWindow(async () => page, 50)).rejects.toThrow('Reintenta')
  })

  it.each([1, 50, 150])('refreshes %i loaded rows without retaining absent filtered rows', async count => {
    const calls = Math.max(1, Math.ceil(count / 50))
    const load = vi.fn(async (cursor?: string) => {
      const page = Number(cursor || 0)
      return { tasks: Array.from({ length: 50 }, (_, index) => row(page * 50 + index + 1)), total: 300, next_cursor: String(page + 1) }
    })
    const result = await collectTaskWindow(load, count)
    expect(load).toHaveBeenCalledTimes(calls)
    expect(result.tasks).toHaveLength(calls * 50)
    expect(result.next_cursor).toBe(String(calls))
  })

  it('keeps a reordered row when it moved to a later loaded page', async () => {
    const result = await collectTaskWindow(async cursor => cursor
      ? { tasks: [row(1)], total: 2 }
      : { tasks: [row(2)], total: 2, next_cursor: 'next' }, 100)
    expect(result.tasks.map(task => task.id)).toEqual(['2', '1'])
    expect(result.next_cursor).toBeUndefined()
  })

  it('rejects a failed later page instead of publishing a partial refresh', async () => {
    await expect(collectTaskWindow(async cursor => {
      if (cursor) throw new Error('network')
      return { tasks: [row(1)], total: 100, next_cursor: 'next' }
    }, 100)).rejects.toThrow('network')
  })

  it('rejects a repeated cursor', async () => {
    await expect(collectTaskWindow(async () => ({ tasks: [row(1)], total: 100, next_cursor: 'same' }), 150)).rejects.toThrow('cursor')
  })
})
