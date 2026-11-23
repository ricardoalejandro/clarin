import { describe, expect, it, vi } from 'vitest'
import type { Task } from '@/types/task'
import { collectTaskStructuralSnapshot, mergeTaskStructuralSnapshot, taskStructuralRefreshPageCount } from './taskStructuralRefresh'
import { mergeTaskPage, taskPageParams } from './taskPagination'

const task = (id: string, version = 1, list_id = 'source') => ({ id, version, list_id } as Task)

describe('canonical structural task refresh', () => {
  it('revalidates every already-loaded page with bounded cursors, without using the total as a size', async () => {
    const next = vi.fn().mockResolvedValueOnce({ tasks: [task('b')], total: 9000, next_cursor: 'cursor-3' }).mockResolvedValueOnce({ tasks: [task('c')], total: 9000, next_cursor: 'cursor-4' })
    const result = await collectTaskStructuralSnapshot({ tasks: [task('a')], total: 9000, next_cursor: 'cursor-2' }, 101, next, () => true)
    expect(taskStructuralRefreshPageCount(0)).toBe(1)
    expect(next.mock.calls.map(([cursor]) => cursor)).toEqual(['cursor-2', 'cursor-3'])
    expect(next.mock.calls.map(([cursor]) => taskPageParams(new URLSearchParams(), cursor).get('limit'))).toEqual(['50', '50'])
    expect(result?.tasks.map(item => item.id)).toEqual(['a', 'b', 'c'])
    expect(result?.next_cursor).toBe('cursor-4')
  })
  it('removes tasks from a deleted container even when they lived in a previously loaded tail', () => {
    const current = [task('head'), task('removed-tail')]
    const versions = new Map(current.map(item => [item.id, item.version || 0]))
    expect(mergeTaskStructuralSnapshot(current, [task('head', 2)], versions, () => true).map(item => item.id)).toEqual(['head'])
    expect(mergeTaskPage(current, [task('head', 2)], 'refresh').map(item => item.id)).toEqual(['head', 'removed-tail'])
  })
  it('replaces preserved tasks with their canonical destination and drops those excluded by the new scope/filter', () => {
    const current = [task('moved', 1), task('excluded', 1)]
    const versions = new Map(current.map(item => [item.id, item.version || 0]))
    const canonical = task('moved', 2, 'destination')
    const result = mergeTaskStructuralSnapshot(current, [canonical], versions, () => true)
    expect(result).toEqual([canonical])
  })
  it('retains newer concurrent edits only when still visible and never revives authoritative removals', () => {
    const versions = new Map([['edited', 1], ['filtered', 1], ['removed', 1]])
    const result = mergeTaskStructuralSnapshot([task('edited', 2), task('filtered', 2), task('removed', 2)], [], versions, item => item.id !== 'filtered', new Set(['removed']))
    expect(result.map(item => item.id)).toEqual(['edited'])
  })
  it('does not commit a partial snapshot after a request becomes obsolete or a later page fails', async () => {
    let current = true
    const canceled = await collectTaskStructuralSnapshot({ tasks: [task('a')], total: 100, next_cursor: 'next' }, 100, async () => { current = false; return { tasks: [task('b')], total: 100 } }, () => current)
    expect(canceled).toBeNull()
    await expect(collectTaskStructuralSnapshot({ tasks: [task('a')], total: 100, next_cursor: 'next' }, 100, async () => { throw new Error('network') }, () => true)).rejects.toThrow('network')
  })
})
