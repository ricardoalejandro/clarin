import { describe, expect, it, vi } from 'vitest'
import type { Task } from '@/types/task'
import { collectTaskWindow } from './taskPageWindow'

const row = (id: number) => ({ id: String(id), version: 1 }) as Task
describe('canonical task cursor window', () => {
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
