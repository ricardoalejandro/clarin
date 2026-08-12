import type { TaskAccessLevel, TaskPermissions } from '@/types/task'

type TaskContainerAccessSource = {
  effective_access_level?: TaskAccessLevel
  capabilities?: Pick<TaskPermissions, 'level' | 'can_archive' | 'can_trash' | 'can_restore'>
  permissions?: Pick<TaskPermissions, 'level' | 'can_archive' | 'can_trash' | 'can_restore'>
}

export type TaskContainerLifecycleCapability = 'can_archive' | 'can_trash' | 'can_restore'

export function taskContainerCanManageStructure(item?: TaskContainerAccessSource | null) {
  const level = item?.capabilities?.level
    || item?.permissions?.level
    || item?.effective_access_level
  return level === 'full'
}

export function taskContainerLifecycleCapability(
  item: TaskContainerAccessSource | null | undefined,
  capability: TaskContainerLifecycleCapability,
) {
  const canonical = item?.capabilities?.[capability]
  if (canonical !== undefined) return canonical
  return item?.permissions?.[capability]
}
