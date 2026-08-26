import { describe, expect, it } from 'vitest'
import type { WhiteboardSummary } from '@/lib/whiteboards'
import {
  redactWhiteboardHubSnapshot,
  whiteboardHubRealtimeDecision,
} from '@/lib/whiteboardHubRealtime'

const access = {
  level: 'manage' as const,
  can_view: true,
  can_comment: true,
  can_edit: true,
  can_manage_access: true,
  can_delete: true,
}

function board(id: string, input: Partial<WhiteboardSummary> = {}): WhiteboardSummary {
  return {
    id,
    name: id,
    created_at: '2026-08-26T00:00:00Z',
    updated_at: '2026-08-26T00:00:00Z',
    version: 1,
    scene_sequence: 0,
    effective_access: access,
    ...input,
  }
}

describe('whiteboard Hub realtime reconciliation', () => {
  it('redacts every Work label immediately when an authority revocation has no safe target', () => {
    const decision = whiteboardHubRealtimeDecision({ event: 'task_update', data: { action: 'access_revoked' } })
    expect(decision).toEqual({
      refresh: true,
      authoritySensitive: true,
      redaction: { kind: 'all_work' },
    })
    expect(redactWhiteboardHubSnapshot([
      board('standalone', { origin: 'standalone' }),
      board('work', { origin: 'work' }),
    ], decision.redaction).map(item => item.id)).toEqual(['standalone'])
  })

  it('redacts a revoked folder and descendant list without leaking its breadcrumb', () => {
    const decision = whiteboardHubRealtimeDecision({
      event: 'task_update',
      data: { action: 'access_revoked', target_type: 'folder', target_id: 'folder-secret' },
    })
    const boards = [
      board('folder-board', {
        origin: 'work',
        work_location: {
          task_view_id: 'view-folder', environment_id: 'environment', scope_type: 'folder', scope_id: 'folder-secret', scope_name: 'Secret', lifecycle: 'active',
        },
      }),
      board('list-board', {
        origin: 'work',
        work_location: {
          task_view_id: 'view-list', environment_id: 'environment', scope_type: 'list', scope_id: 'list', scope_name: 'List', lifecycle: 'active',
          breadcrumb: [
            { type: 'environment', id: 'environment', name: 'Environment' },
            { type: 'folder', id: 'folder-secret', name: 'Secret' },
            { type: 'list', id: 'list', name: 'List' },
          ],
        },
      }),
      board('other', {
        origin: 'work',
        work_location: {
          task_view_id: 'view-other', environment_id: 'environment', scope_type: 'list', scope_id: 'other-list', scope_name: 'Other', lifecycle: 'active',
        },
      }),
    ]
    expect(redactWhiteboardHubSnapshot(boards, decision.redaction).map(item => item.id)).toEqual(['other'])
  })

  it('refreshes archived parents but only redacts Trash and purge transitions', () => {
    expect(whiteboardHubRealtimeDecision({
      event: 'task_update', data: { action: 'folder_archived', folder_id: 'folder' },
    })).toMatchObject({ refresh: true, redaction: undefined })
    expect(whiteboardHubRealtimeDecision({
      event: 'task_update', data: { action: 'folder_trashed', folder_id: 'folder' },
    })).toMatchObject({
      refresh: true,
      redaction: { kind: 'work_target', targetType: 'folder', targetID: 'folder' },
    })
    expect(whiteboardHubRealtimeDecision({
      event: 'task_update', data: { action: 'environment_purged', environment_id: 'environment' },
    })).toMatchObject({
      refresh: true,
      redaction: { kind: 'work_target', targetType: 'environment', targetID: 'environment' },
    })
  })

  it('ignores task-only and unrelated high-volume updates', () => {
    expect(whiteboardHubRealtimeDecision({ event: 'task_update', data: { action: 'updated', task_id: 'task' } }).refresh).toBe(false)
    expect(whiteboardHubRealtimeDecision({ event: 'task_update', data: { action: 'access_changed', target_type: 'task', target_id: 'task' } }).refresh).toBe(false)
    expect(whiteboardHubRealtimeDecision({ event: 'chat_update', data: {} }).refresh).toBe(false)
  })

  it('accepts a payload-free Hub invalidation on the existing task channel without trusting resource data', () => {
    expect(whiteboardHubRealtimeDecision({
      event: 'task_update', data: { action: 'whiteboard_hub_changed' },
    })).toEqual({ refresh: true, authoritySensitive: true })
    expect(whiteboardHubRealtimeDecision({
      event: 'task_update', data: { action: 'whiteboard_work_hub_revoked' },
    })).toEqual({
      refresh: true,
      authoritySensitive: true,
      redaction: { kind: 'all_work' },
    })
  })

  it('targets one contextual view when its lifecycle event is available on the existing task channel', () => {
    const decision = whiteboardHubRealtimeDecision({
      event: 'task_update', data: { action: 'location_view_trashed', task_view_id: 'view-a' },
    })
    const boards = [
      board('a', {
        origin: 'work',
        work_location: { task_view_id: 'view-a', environment_id: 'environment', scope_type: 'list', scope_id: 'list', scope_name: 'List', lifecycle: 'active' },
      }),
      board('b', {
        origin: 'work',
        work_location: { task_view_id: 'view-b', environment_id: 'environment', scope_type: 'list', scope_id: 'list', scope_name: 'List', lifecycle: 'active' },
      }),
    ]
    expect(redactWhiteboardHubSnapshot(boards, decision.redaction).map(item => item.id)).toEqual(['b'])
  })
})
