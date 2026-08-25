import { describe, expect, it } from 'vitest'
import type { TaskAttachment } from '@/types/task'
import {
  TASK_DETAIL_MAX_INSPECTOR_WIDTH,
  TASK_DETAIL_MIN_DOCKED_AVAILABLE_WIDTH,
  acceptsTaskDetailRead,
  discardTaskDetailDraft,
  nextTaskDetailReadToken,
  readTaskDetailDraft,
  saveTaskDetailDraft,
  taskDetailInspectorLayout,
  taskDetailVisualState,
  type TaskDetailDraft,
} from './taskDetailInspectorState'

const attachment: TaskAttachment = {
  id: 'attachment-1',
  account_id: 'account-1',
  task_id: 'task-a',
  media_asset_id: 'asset-1',
  filename: 'brief.pdf',
  content_type: 'application/pdf',
  media_type: 'document',
  size_bytes: 42,
  url: '/api/media/asset-1',
  created_at: '2026-08-24T00:00:00.000Z',
}

const draft: TaskDetailDraft = {
  title: 'Título A',
  description: 'Descripción pendiente',
  comment: 'Comentario sin enviar',
  commentMentionIds: ['user-1'],
  commentAttachmentIds: [attachment.id],
  commentAttachmentLookup: { [attachment.id]: attachment },
  editingCommentId: 'comment-1',
  editingCommentBody: 'Edición',
  editingMentionIds: ['user-2'],
  editingAttachmentIds: [],
  subtaskTitle: 'Subtarea rápida',
}

describe('task detail inspector state', () => {
  it('keeps 480 px for Work and clamps the inspector to 440–672 px', () => {
    expect(taskDetailInspectorLayout(TASK_DETAIL_MIN_DOCKED_AVAILABLE_WIDTH)).toEqual({
      availableWidth: 920,
      canDock: true,
      dockedWidth: 440,
      workspaceWidth: 480,
      temporaryMode: undefined,
    })
    expect(taskDetailInspectorLayout(1_000)).toMatchObject({ canDock: true, dockedWidth: 520, workspaceWidth: 480 })
    expect(taskDetailInspectorLayout(1_600)).toMatchObject({
      canDock: true,
      dockedWidth: TASK_DETAIL_MAX_INSPECTOR_WIDTH,
      workspaceWidth: 928,
    })
  })

  it('temporarily maximizes below 920 px without inventing a docked layout', () => {
    expect(taskDetailInspectorLayout(919)).toMatchObject({
      canDock: false,
      dockedWidth: 440,
      workspaceWidth: 919,
      temporaryMode: 'maximized',
    })
    expect(taskDetailInspectorLayout(Number.NaN)).toMatchObject({ availableWidth: 0, canDock: false, temporaryMode: 'maximized' })
  })

  it('uses the detail-only veil policy without changing other windows', () => {
    expect(taskDetailVisualState('docked')).toEqual({
      backdropStyle: { backgroundColor: 'transparent', backdropFilter: 'none' },
      blocksWorkspace: false,
    })
    expect(taskDetailVisualState('floating')).toEqual({
      backdropStyle: { backgroundColor: 'rgba(2, 6, 23, 0.18)', backdropFilter: 'blur(2px)' },
      blocksWorkspace: false,
    })
    expect(taskDetailVisualState('maximized')).toEqual({
      backdropStyle: { backgroundColor: 'rgba(2, 6, 23, 0.45)', backdropFilter: 'blur(3px)' },
      blocksWorkspace: true,
    })
    expect(taskDetailVisualState('floating', true).blocksWorkspace).toBe(true)
  })

  it('rejects inverted A results after the active read session advances to B', () => {
    const sessionA = nextTaskDetailReadToken(undefined, 'task-a')
    const sessionB = nextTaskDetailReadToken(sessionA, 'task-b')
    expect(acceptsTaskDetailRead(sessionB, sessionA)).toBe(false)
    expect(acceptsTaskDetailRead(sessionB, sessionB)).toBe(true)

    const refreshedB = nextTaskDetailReadToken(sessionB, 'task-b')
    expect(acceptsTaskDetailRead(refreshedB, sessionB)).toBe(false)
    expect(acceptsTaskDetailRead(refreshedB, refreshedB)).toBe(true)
  })

  it('stores independent defensive draft snapshots by task and discards only the requested task', () => {
    let store = saveTaskDetailDraft({}, 'task-a', draft)
    store = saveTaskDetailDraft(store, 'task-b', { ...draft, title: 'Título B', comment: 'B' })

    draft.commentMentionIds.push('mutation-after-save')
    const restoredA = readTaskDetailDraft(store, 'task-a')!
    restoredA.commentAttachmentIds.push('mutation-after-read')

    expect(restoredA.title).toBe('Título A')
    expect(restoredA.commentMentionIds).toEqual(['user-1'])
    expect(readTaskDetailDraft(store, 'task-a')?.commentAttachmentIds).toEqual(['attachment-1'])
    expect(readTaskDetailDraft(store, 'task-b')?.comment).toBe('B')

    const withoutA = discardTaskDetailDraft(store, 'task-a')
    expect(readTaskDetailDraft(withoutA, 'task-a')).toBeUndefined()
    expect(readTaskDetailDraft(withoutA, 'task-b')?.title).toBe('Título B')
  })
})
