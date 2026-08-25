export type TaskScopedWriteQueues = Map<string, Promise<void>>

export type TaskMutationFailure = {
  taskId: string
  taskTitle: string
  message: string
}

export type TaskMutationFailureStore = Readonly<Record<string, TaskMutationFailure>>

/**
 * Runs writes for one task in order while allowing unrelated tasks to proceed
 * independently. The first write starts synchronously so its optimistic ledger
 * entry exists before another click can enqueue a follow-up mutation.
 */
export function enqueueTaskScopedWrite<T>(
  queues: TaskScopedWriteQueues,
  taskId: string,
  write: () => Promise<T>,
): Promise<T> {
  const start = () => {
    try {
      return Promise.resolve(write())
    } catch (error) {
      return Promise.reject(error)
    }
  }
  const previous = queues.get(taskId)
  const current = previous ? previous.then(start, start) : start()
  const tail = current.then(() => undefined, () => undefined)
  queues.set(taskId, tail)
  void tail.then(() => {
    if (queues.get(taskId) === tail) queues.delete(taskId)
  })
  return current
}

/**
 * A task-scoped failure follows its task. While B is inspected, a late failure
 * from A stays stored but is not presented as a global error.
 */
export function contextualTaskMutationFailure(
  failures: TaskMutationFailureStore,
  activeTaskId: string | null,
  latestTaskId: string,
): TaskMutationFailure | undefined {
  const contextualTaskId = activeTaskId || latestTaskId
  return contextualTaskId ? failures[contextualTaskId] : undefined
}
