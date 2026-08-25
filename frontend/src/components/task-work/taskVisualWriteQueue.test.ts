import { describe, expect, it } from 'vitest'
import {
  contextualTaskMutationFailure,
  enqueueTaskScopedWrite,
  type TaskMutationFailureStore,
  type TaskScopedWriteQueues,
} from './taskVisualWriteQueue'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

describe('task-scoped visual write queue', () => {
  it('serializes one write per change and lets the next write observe the canonical version', async () => {
    const queues: TaskScopedWriteQueues = new Map()
    const firstResponse = deferred<number>()
    const versions: number[] = []
    let canonicalVersion = 5
    let writes = 0

    const first = enqueueTaskScopedWrite(queues, 'task-a', async () => {
      writes += 1
      versions.push(canonicalVersion)
      canonicalVersion = await firstResponse.promise
      return canonicalVersion
    })
    const second = enqueueTaskScopedWrite(queues, 'task-a', async () => {
      writes += 1
      versions.push(canonicalVersion)
      canonicalVersion += 1
      return canonicalVersion
    })

    expect(writes).toBe(1)
    expect(versions).toEqual([5])
    firstResponse.resolve(6)
    await expect(first).resolves.toBe(6)
    await expect(second).resolves.toBe(7)
    expect(writes).toBe(2)
    expect(versions).toEqual([5, 6])
    expect(queues.size).toBe(0)
  })

  it('does not make task B wait for task A', async () => {
    const queues: TaskScopedWriteQueues = new Map()
    const releaseA = deferred<void>()
    const started: string[] = []

    const writeA = enqueueTaskScopedWrite(queues, 'task-a', async () => {
      started.push('a')
      await releaseA.promise
    })
    const writeB = enqueueTaskScopedWrite(queues, 'task-b', async () => {
      started.push('b')
    })

    await writeB
    expect(started).toEqual(['a', 'b'])
    releaseA.resolve()
    await writeA
  })
})

describe('contextual task mutation failures', () => {
  const failures: TaskMutationFailureStore = {
    'task-a': { taskId: 'task-a', taskTitle: 'Tarea A', message: 'Fallo tardío de A' },
  }

  it('hides a late failure from A while B is open and restores it when returning to A', () => {
    expect(contextualTaskMutationFailure(failures, 'task-b', 'task-a')).toBeUndefined()
    expect(contextualTaskMutationFailure(failures, 'task-a', 'task-a')).toEqual(failures['task-a'])
  })

  it('uses the latest task failure only when no inspector task owns the context', () => {
    expect(contextualTaskMutationFailure(failures, null, 'task-a')).toEqual(failures['task-a'])
  })
})
