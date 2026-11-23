import type { Task, TaskEnvironment } from '@/types/task'
import { taskContainerCanManageStructure } from './taskContainerCapabilities'

export function taskEnvironmentCanRemove(environment?: TaskEnvironment | null) {
  return Boolean(environment && !environment.is_default && !environment.deleted_at && taskContainerCanManageStructure(environment))
}

export function taskEnvironmentPreferenceKey(accountID: string, userID: string) {
  return `clarin:tasks:${accountID || 'account'}:${userID || 'user'}:active-environment:v1`
}

export function mergeTaskEnvironmentIndex(current: TaskEnvironment[], incoming: TaskEnvironment[]) {
  return Array.from(new Map([...current, ...incoming].map(environment => [environment.id, environment])).values())
    .sort((left, right) => left.sort_order - right.sort_order || left.name.localeCompare(right.name, 'es'))
}

export function selectActiveTaskEnvironment(environments: TaskEnvironment[], preferredID = '') {
  return environments.find(environment => environment.id === preferredID && !environment.deleted_at)
    || environments.find(environment => environment.is_default && !environment.archived_at && !environment.deleted_at)
    || environments.find(environment => !environment.archived_at && !environment.deleted_at)
}

export function preferredTaskEnvironmentNeedsFetch(environments: TaskEnvironment[], preferredID: string) {
  return Boolean(preferredID && !environments.some(environment => environment.id === preferredID))
}

export function taskEnvironmentInventoryChanged(before?: Task | null, after?: Task | null) {
  if (!before || !after) return Boolean(before || after)
  return before.list_id !== after.list_id || before.environment_id !== after.environment_id
    || before.parent_task_id !== after.parent_task_id || before.status_id !== after.status_id
    || before.status !== after.status || before.deleted_at !== after.deleted_at
}

export function taskEnvironmentStructureEvent(action: string) {
  return /^(environment|folder|list|container)_/.test(action)
}
