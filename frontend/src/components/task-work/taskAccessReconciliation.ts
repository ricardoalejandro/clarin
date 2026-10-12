import type { Task } from '@/types/task'

type TaskAccessTarget = 'task' | 'list' | 'folder' | 'environment'
type ScopedTask = Pick<Task, 'id' | 'parent_task_id' | 'list_id' | 'folder_id' | 'environment_id'>

/** A newer task version proves data freshness, never renewed authorization.
 * Only an actor-authorized read started after the tombstone can lift its fence. */
export class TaskAccessReconciliation {
  epoch = 0
  private readonly revoked = new Map<string, number>()
  private readonly confirmed = new Map<string, number>()

  private keys(task: ScopedTask) {
    return [`task:${task.id}`, task.parent_task_id && `task:${task.parent_task_id}`,
      task.list_id && `list:${task.list_id}`, task.folder_id && `folder:${task.folder_id}`,
      task.environment_id && `environment:${task.environment_id}`].filter(Boolean) as string[]
  }

  revoke(target: TaskAccessTarget, id: string, knownTasks: readonly ScopedTask[] = []) {
    this.epoch += 1
    const key = `${target}:${id}`
    this.revoked.set(key, this.epoch)
    // A late move must not evade a source-container revocation with a new location.
    for (const task of knownTasks) {
      if (this.keys(task).includes(key)) this.revoked.set(`task:${task.id}`, this.epoch)
    }
  }

  canAccept(task: ScopedTask) {
    const required = Math.max(0, ...this.keys(task).map(key => this.revoked.get(key) || 0))
    return required === 0 || (this.confirmed.get(task.id) || 0) >= required
  }

  confirmRead(task: ScopedTask, startedEpoch: number) {
    if (startedEpoch !== this.epoch) return false
    this.confirmed.set(task.id, startedEpoch)
    return true
  }
}
