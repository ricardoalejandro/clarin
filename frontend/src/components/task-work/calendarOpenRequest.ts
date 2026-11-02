import type { WorkEventOccurrence } from '@/types/task'
import type { TaskWorkspaceScope } from './taskWorkspaceState'

export interface CalendarOpenContext {
  accountID: string
  userID: string
  environmentID: string
  scope: TaskWorkspaceScope
}

export type CalendarOpenIntent =
  | { kind: 'create' }
  | { kind: 'focus'; occurrence: WorkEventOccurrence }

export type CalendarOpenRequest = CalendarOpenIntent & {
  id: string
  contextKey: string
}

export function calendarOpenContextKey(context: CalendarOpenContext) {
  return JSON.stringify([
    context.accountID, context.userID, context.environmentID,
    context.scope.type, 'id' in context.scope ? context.scope.id : '',
  ])
}

// Opening is a one-shot user command, never persisted calendar view state.
export function createCalendarOpenRequest(contextKey: string, intent: CalendarOpenIntent, id: string = crypto.randomUUID()): CalendarOpenRequest {
  return { ...intent, id, contextKey }
}

export function calendarOpenRequestForContext(request: CalendarOpenRequest | null | undefined, contextKey: string) {
  return request?.contextKey === contextKey ? request : null
}

export function consumeCalendarOpenRequest(request: CalendarOpenRequest | null, consumedID: string) {
  return request?.id === consumedID ? null : request
}
