import type { OfflineTask } from './types'

export function offlineTaskIsCompleted(task: OfflineTask): boolean {
  // Canonical snapshots/receipts use workflow categories, not the legacy
  // status field used by optimistic local creations.
  return task.status_category ? task.status_category === 'done' : task.status === 'completed'
}

export function offlineTaskCanComplete(task: OfflineTask, grantCanComplete: boolean): boolean {
  return grantCanComplete && task.can_complete === true && !offlineTaskIsCompleted(task)
    && task.status_category !== 'cancelled' && task.status !== 'cancelled'
    && (task.local_confirmation !== 'pending' || task.version === 0) && task.local_confirmation !== 'rejected'
}

export const offlineTaskPriorityLabels: Record<OfflineTask['priority'], string> = {
  low: 'Baja', medium: 'Media', high: 'Alta', urgent: 'Urgente',
}
