import type { WhiteboardSummary } from '@/lib/whiteboards'

export const WHITEBOARD_HUB_REVALIDATION_INTERVAL_MS = 45_000

type WorkTargetType = 'environment' | 'folder' | 'list' | 'location_view'

export interface WhiteboardHubRedaction {
  kind: 'all_work' | 'work_target' | 'board'
  targetType?: WorkTargetType
  targetID?: string
  boardID?: string
}

export interface WhiteboardHubRealtimeDecision {
  refresh: boolean
  authoritySensitive: boolean
  redaction?: WhiteboardHubRedaction
}

interface TaskRealtimePayload {
  action?: string
  target_type?: string
  target_id?: string
  environment_id?: string
  folder_id?: string
  list_id?: string
  location_view_id?: string
  task_view_id?: string
  whiteboard_id?: string
  board_id?: string
  environment?: { id?: string }
}

const WORK_STRUCTURE_ACTIONS = new Set([
  'environment_archived',
  'environment_unarchived',
  'environment_trashed',
  'environment_restored',
  'environment_purged',
  'folder_archived',
  'folder_unarchived',
  'folder_trashed',
  'folder_restored',
  'folder_purged',
  'list_archived',
  'list_unarchived',
  'list_trashed',
  'list_deleted',
  'list_restored',
  'list_purged',
  'location_view_created',
  'location_view_updated',
  'location_view_trashed',
  'location_view_restored',
  'location_view_purged',
])

const REDACTING_STRUCTURE_ACTIONS = new Set([
  'environment_trashed',
  'environment_purged',
  'folder_trashed',
  'folder_purged',
  'list_trashed',
  'list_deleted',
  'list_purged',
  'location_view_trashed',
  'location_view_purged',
])

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
}

function nonEmptyString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function workTarget(payload: TaskRealtimePayload, action: string): Pick<WhiteboardHubRedaction, 'targetType' | 'targetID'> | null {
  const explicitType = payload.target_type
  const explicitID = nonEmptyString(payload.target_id)
  if (explicitID && (explicitType === 'environment' || explicitType === 'folder' || explicitType === 'list')) {
    return { targetType: explicitType, targetID: explicitID }
  }

  const actionType = action.startsWith('environment_')
    ? 'environment'
    : action.startsWith('folder_')
      ? 'folder'
      : action.startsWith('list_')
        ? 'list'
        : action.startsWith('location_view_')
          ? 'location_view'
          : undefined
  if (!actionType) return null
  const targetID = actionType === 'environment'
    ? nonEmptyString(payload.environment_id) || nonEmptyString(payload.environment?.id)
    : actionType === 'folder'
      ? nonEmptyString(payload.folder_id)
      : actionType === 'list'
        ? nonEmptyString(payload.list_id)
        : nonEmptyString(payload.location_view_id) || nonEmptyString(payload.task_view_id)
  return targetID ? { targetType: actionType, targetID } : null
}

/**
 * Maps the already-existing general `/ws` task channel to a bounded Hub
 * invalidation. The event never becomes canonical state: callers must refetch
 * the actor-authorized Hub snapshot before rendering names or counters again.
 */
export function whiteboardHubRealtimeDecision(value: unknown): WhiteboardHubRealtimeDecision {
  const message = record(value)
  if (message?.event !== 'task_update') return { refresh: false, authoritySensitive: false }
  const payloadRecord = record(message.data)
  if (!payloadRecord) return { refresh: false, authoritySensitive: false }
  const payload = payloadRecord as TaskRealtimePayload
  const action = nonEmptyString(payload.action) || ''

  if (action === 'whiteboard_hub_changed') {
    return { refresh: true, authoritySensitive: true }
  }
  if (action === 'whiteboard_work_hub_revoked') {
    return {
      refresh: true,
      authoritySensitive: true,
      redaction: { kind: 'all_work' },
    }
  }

  if (action === 'access_revoked') {
    if (payload.target_type === 'task') return { refresh: false, authoritySensitive: false }
    const target = workTarget(payload, action)
    return {
      refresh: true,
      authoritySensitive: true,
      redaction: target
        ? { kind: 'work_target', ...target }
        : { kind: 'all_work' },
    }
  }
  if (action === 'access_changed') {
    return payload.target_type === 'task'
      ? { refresh: false, authoritySensitive: false }
      : { refresh: true, authoritySensitive: true }
  }
  if (!WORK_STRUCTURE_ACTIONS.has(action)) return { refresh: false, authoritySensitive: false }

  const target = workTarget(payload, action)
  return {
    refresh: true,
    authoritySensitive: true,
    redaction: REDACTING_STRUCTURE_ACTIONS.has(action) && target
      ? { kind: 'work_target', ...target }
      : undefined,
  }
}

function workLocationMatchesTarget(
  board: WhiteboardSummary,
  targetType: WorkTargetType | undefined,
  targetID: string | undefined,
) {
  const location = board.work_location
  if (board.origin !== 'work' || !location || !targetType || !targetID) return false
  if (targetType === 'environment') return location.environment_id === targetID
  if (targetType === 'location_view') return location.task_view_id === targetID
  if (location.scope_type === targetType && location.scope_id === targetID) return true
  return Boolean(location.breadcrumb?.some(item => item.type === targetType && item.id === targetID))
}

/** Immediately removes protected labels while the canonical request is in flight. */
export function redactWhiteboardHubSnapshot(
  boards: readonly WhiteboardSummary[],
  redaction: WhiteboardHubRedaction | undefined,
) {
  if (!redaction) return [...boards]
  if (redaction.kind === 'all_work') return boards.filter(board => board.origin !== 'work')
  if (redaction.kind === 'board') return boards.filter(board => board.id !== redaction.boardID)
  return boards.filter(board => !workLocationMatchesTarget(board, redaction.targetType, redaction.targetID))
}
