import type { Task, TaskPriority, TaskStatus, TaskStatusCategory, TaskWorkflowStatus } from '@/types/task'

export type TaskVisualUpdate = {
  priority?: TaskPriority
  status_id?: string
}

export function taskLegacyStatusForCategory(category: TaskStatusCategory): TaskStatus {
  if (category === 'done') return 'completed'
  if (category === 'cancelled') return 'cancelled'
  return 'pending'
}

/**
 * Projects the exact semantic fields rendered by every Work view. Identity
 * color is intentionally untouched: priority and workflow status are not
 * aliases for task.color/resolved_color.
 */
export function projectTaskVisualUpdate(
  task: Task,
  update: TaskVisualUpdate,
  statuses: readonly TaskWorkflowStatus[],
): Task {
  let projected = update.priority ? { ...task, priority: update.priority } : task
  if (!update.status_id) return projected

  const status = statuses.find(candidate => candidate.id === update.status_id)
  if (!status) return projected
  if (task.status_detail?.workflow_id && status.workflow_id !== task.status_detail.workflow_id) return projected

  projected = {
    ...projected,
    status_id: status.id,
    status_detail: status,
    status: taskLegacyStatusForCategory(status.category),
    progress: status.category === 'done'
      ? 100
      : task.status_detail?.category === 'done' && task.progress === 100
        ? 0
        : task.progress,
  }
  return projected
}

export function projectTaskVisualUpdates(
  task: Task,
  updates: readonly TaskVisualUpdate[],
  statuses: readonly TaskWorkflowStatus[],
): Task {
  return updates.reduce<Task>((current, update) => projectTaskVisualUpdate(current, update, statuses), task)
}

export type TaskVisualMutationEntry = {
  taskId: string
  operationId: string
  baseVersion: number
  before: Task
  optimistic: Task
}

export type TaskVisualMutationLedger = Readonly<Record<string, TaskVisualMutationEntry>>

export type TaskVisualMutationResult = {
  ledger: TaskVisualMutationLedger
  task: Task
}

function taskVersion(task: Pick<Task, 'version'>) {
  const version = Number(task.version || 0)
  return Number.isFinite(version) ? version : 0
}

function withoutTask(ledger: TaskVisualMutationLedger, taskId: string): TaskVisualMutationLedger {
  if (!(taskId in ledger)) return ledger
  const next = { ...ledger }
  delete next[taskId]
  return next
}

export function beginTaskVisualMutation(
  ledger: TaskVisualMutationLedger,
  task: Task,
  update: TaskVisualUpdate,
  statuses: readonly TaskWorkflowStatus[],
  operationId: string,
): TaskVisualMutationResult & { entry: TaskVisualMutationEntry } {
  const optimistic = projectTaskVisualUpdate(task, update, statuses)
  const entry: TaskVisualMutationEntry = {
    taskId: task.id,
    operationId,
    baseVersion: taskVersion(task),
    before: task,
    optimistic,
  }
  return { ledger: { ...ledger, [task.id]: entry }, task: optimistic, entry }
}

/**
 * Extends the visible projection of the active write without replacing its
 * operation id, base version or rollback snapshot. Queued writes can therefore
 * stay immediately visible while the active network request remains the sole
 * owner of reconciliation.
 */
export function extendTaskVisualMutation(
  ledger: TaskVisualMutationLedger,
  taskId: string,
  updates: readonly TaskVisualUpdate[],
  statuses: readonly TaskWorkflowStatus[],
): (TaskVisualMutationResult & { entry: TaskVisualMutationEntry }) | null {
  const entry = ledger[taskId]
  if (!entry) return null
  const optimistic = projectTaskVisualUpdates(entry.optimistic, updates, statuses)
  const nextEntry = { ...entry, optimistic }
  return {
    ledger: { ...ledger, [taskId]: nextEntry },
    task: optimistic,
    entry: nextEntry,
  }
}

export type TaskVisualReconciliationResult = TaskVisualMutationResult & {
  accepted: boolean
  settledOperation: boolean
}

/**
 * Canonical HTTP/WebSocket data wins only when it settles the active
 * operation or advances the task version. Same-version unrelated echoes
 * cannot erase a pending optimistic projection.
 */
export function reconcileTaskVisualMutation(
  ledger: TaskVisualMutationLedger,
  current: Task,
  canonical: Task,
  operationId?: string,
): TaskVisualReconciliationResult {
  if (canonical.id !== current.id) {
    return { ledger, task: current, accepted: false, settledOperation: false }
  }

  const entry = ledger[current.id]
  const canonicalVersion = taskVersion(canonical)
  if (!entry) {
    const accepted = canonicalVersion >= taskVersion(current)
    return { ledger, task: accepted ? canonical : current, accepted, settledOperation: false }
  }

  if (canonicalVersion < entry.baseVersion) {
    return { ledger, task: current, accepted: false, settledOperation: false }
  }

  const settlesActiveOperation = Boolean(operationId && operationId === entry.operationId)
  const advancesCanonicalVersion = canonicalVersion > entry.baseVersion
  if (!settlesActiveOperation && !advancesCanonicalVersion) {
    return { ledger, task: entry.optimistic, accepted: false, settledOperation: false }
  }

  return {
    ledger: withoutTask(ledger, current.id),
    task: canonical,
    accepted: true,
    settledOperation: settlesActiveOperation,
  }
}

export type TaskVisualRollbackResult = TaskVisualMutationResult & { rolledBack: boolean }

/** A failed stale operation can never roll back a newer operation/version. */
export function rollbackTaskVisualMutation(
  ledger: TaskVisualMutationLedger,
  current: Task,
  taskId: string,
  operationId: string,
): TaskVisualRollbackResult {
  const entry = ledger[taskId]
  if (!entry || entry.operationId !== operationId || current.id !== taskId) {
    return { ledger, task: current, rolledBack: false }
  }

  const nextLedger = withoutTask(ledger, taskId)
  if (taskVersion(current) > entry.baseVersion) {
    return { ledger: nextLedger, task: current, rolledBack: false }
  }
  return { ledger: nextLedger, task: entry.before, rolledBack: true }
}
