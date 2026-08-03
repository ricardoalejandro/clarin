import type { Task } from '@/types/task'

type TaskWithPermissions = Pick<Task, 'permissions'>

// Capabilities are actor-scoped server truth. Missing capabilities must fail
// closed: a stale cache or partial realtime payload can never manufacture an
// action the current user may not perform.
export function canEditTask(task?: TaskWithPermissions | null) {
  return task?.permissions?.can_edit === true
}

export function canCommentOnTask(task?: TaskWithPermissions | null) {
  return task?.permissions?.can_comment === true
}

export function canAdministerTask(task?: TaskWithPermissions | null) {
  return task?.permissions?.can_delete === true
}

export function allTasksCanEdit(tasks: TaskWithPermissions[]) {
  return tasks.length > 0 && tasks.every(canEditTask)
}

export function allTasksCanBeAdministered(tasks: TaskWithPermissions[]) {
  return tasks.length > 0 && tasks.every(canAdministerTask)
}
