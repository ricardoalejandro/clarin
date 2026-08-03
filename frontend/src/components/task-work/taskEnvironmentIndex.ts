import type { TaskEnvironment } from '@/types/task'

export function taskEnvironmentPreferenceKey(accountID: string, userID: string) {
  return `clarin:tasks:${accountID || 'account'}:${userID || 'user'}:active-environment:v1`
}

export function mergeTaskEnvironmentIndex(current: TaskEnvironment[], incoming: TaskEnvironment[]) {
  return Array.from(new Map([...current, ...incoming].map(environment => [environment.id, environment])).values())
    .sort((left, right) => left.sort_order - right.sort_order || left.name.localeCompare(right.name, 'es'))
}

export function selectActiveTaskEnvironment(environments: TaskEnvironment[], preferredID = '') {
  return environments.find(environment => environment.id === preferredID && !environment.archived_at)
    || environments.find(environment => environment.is_default && !environment.archived_at)
    || environments.find(environment => !environment.archived_at)
}

export function preferredTaskEnvironmentNeedsFetch(environments: TaskEnvironment[], preferredID: string) {
  return Boolean(preferredID && !environments.some(environment => environment.id === preferredID))
}
