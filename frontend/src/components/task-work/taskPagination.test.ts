import { describe, expect, it } from 'vitest'
import type { Task } from '@/types/task'
import { mergeTaskPage, resolveTaskPageItem, TASK_PAGE_SIZE, taskPageParams, taskPageQueryKey } from './taskPagination'

function task(id: string, version = 1): Task {
  return { id, version } as Task
}

describe('task cursor pagination', () => {
  it('builds a bounded cursor request and removes legacy offset state', () => {
    const params = taskPageParams(new URLSearchParams('environment_id=env&offset=400'), 'opaque-cursor')
    expect(params.get('limit')).toBe(String(TASK_PAGE_SIZE))
    expect(params.get('cursor')).toBe('opaque-cursor')
    expect(params.has('offset')).toBe(false)
  })

  it('uses a stable query identity independent from pagination and insertion order', () => {
    expect(taskPageQueryKey(new URLSearchParams('search=hola&environment_id=env&cursor=old')))
      .toBe(taskPageQueryKey(new URLSearchParams('limit=200&environment_id=env&search=hola')))
  })

  it('replaces rows for a new query but preserves an already loaded tail on refresh', () => {
    const current = [task('a'), task('b'), task('c')]
    expect(mergeTaskPage(current, [task('a', 2)], 'replace').map(item => item.id)).toEqual(['a'])
    expect(mergeTaskPage(current, [task('a', 2)], 'refresh').map(item => item.id)).toEqual(['a', 'b', 'c'])
  })

  it('elimina ausencias autoritativas sin descartar el resto de la cola paginada', () => {
    const current = [task('head'), task('moved', 2), task('tail')]
    const merged = mergeTaskPage(current, [task('head', 2)], 'refresh', new Set(['moved']))
    expect(merged.map(item => item.id)).toEqual(['head', 'tail'])
  })

  it('appends without duplicates and never replaces a newer local version with an older page', () => {
    const merged = mergeTaskPage([task('a', 4)], [task('a', 2), task('b', 1)], 'append')
    expect(merged.map(item => [item.id, item.version])).toEqual([['a', 4], ['b', 1]])
  })

  it('never resurrects an absent task from a page older than realtime state', () => {
    expect(resolveTaskPageItem(4, 5, 5, false)).toBe('reject')
    expect(resolveTaskPageItem(4, 5, undefined, false)).toBe('reject')
    expect(resolveTaskPageItem(4, 5, undefined, true)).toBe('preserve-current')
    expect(resolveTaskPageItem(6, 5, 5, false)).toBe('accept')
  })
})
