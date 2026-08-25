import type { CSSProperties } from 'react'
import type { TaskAttachment } from '@/types/task'

export const TASK_DETAIL_MIN_WORKSPACE_WIDTH = 480
export const TASK_DETAIL_MIN_INSPECTOR_WIDTH = 440
export const TASK_DETAIL_MAX_INSPECTOR_WIDTH = 672
export const TASK_DETAIL_MIN_DOCKED_AVAILABLE_WIDTH = TASK_DETAIL_MIN_WORKSPACE_WIDTH + TASK_DETAIL_MIN_INSPECTOR_WIDTH

export type TaskDetailInspectorMode = 'docked' | 'floating' | 'maximized'

export type TaskDetailInspectorLayout = {
  availableWidth: number
  canDock: boolean
  dockedWidth: number
  workspaceWidth: number
  temporaryMode?: 'maximized'
}

function finiteWidth(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

/**
 * Resolves the in-flow detail inspector from the measured Work surface. The
 * measurement must already exclude the Work navigation and Eros chrome.
 */
export function taskDetailInspectorLayout(availableWidth: number): TaskDetailInspectorLayout {
  const width = finiteWidth(availableWidth)
  const canDock = width >= TASK_DETAIL_MIN_DOCKED_AVAILABLE_WIDTH
  const dockedWidth = Math.min(
    TASK_DETAIL_MAX_INSPECTOR_WIDTH,
    Math.max(TASK_DETAIL_MIN_INSPECTOR_WIDTH, width - TASK_DETAIL_MIN_WORKSPACE_WIDTH),
  )

  return {
    availableWidth: width,
    canDock,
    dockedWidth,
    workspaceWidth: canDock ? width - dockedWidth : width,
    temporaryMode: canDock ? undefined : 'maximized',
  }
}

export type TaskDetailVisualState = {
  backdropStyle: CSSProperties
  blocksWorkspace: boolean
}

export type TaskDetailReadToken = {
  taskId: string
  generation: number
}

export function nextTaskDetailReadToken(current: TaskDetailReadToken | undefined, taskId: string): TaskDetailReadToken {
  return { taskId, generation: (current?.generation || 0) + 1 }
}

export function acceptsTaskDetailRead(active: TaskDetailReadToken | undefined, candidate: TaskDetailReadToken) {
  return Boolean(active && active.taskId === candidate.taskId && active.generation === candidate.generation)
}

/** Detail-only policy. Other operational windows keep their shared visuals. */
export function taskDetailVisualState(mode: TaskDetailInspectorMode, isMobile = false): TaskDetailVisualState {
  const effectiveMode = isMobile ? 'maximized' : mode
  if (effectiveMode === 'maximized') {
    return {
      backdropStyle: { backgroundColor: 'rgba(2, 6, 23, 0.45)', backdropFilter: 'blur(3px)' },
      blocksWorkspace: true,
    }
  }
  if (effectiveMode === 'docked') {
    return {
      backdropStyle: { backgroundColor: 'transparent', backdropFilter: 'none' },
      blocksWorkspace: false,
    }
  }
  return {
    backdropStyle: { backgroundColor: 'rgba(2, 6, 23, 0.18)', backdropFilter: 'blur(2px)' },
    blocksWorkspace: false,
  }
}

export type TaskDetailDraft = {
  title: string
  description: string
  comment: string
  commentMentionIds: string[]
  commentAttachmentIds: string[]
  commentAttachmentLookup: Record<string, TaskAttachment>
  editingCommentId: string
  editingCommentBody: string
  editingMentionIds: string[]
  editingAttachmentIds: string[]
  subtaskTitle: string
}

export type TaskDetailDraftStore = Readonly<Record<string, TaskDetailDraft>>

function cloneDraft(draft: TaskDetailDraft): TaskDetailDraft {
  return {
    ...draft,
    commentMentionIds: [...draft.commentMentionIds],
    commentAttachmentIds: [...draft.commentAttachmentIds],
    commentAttachmentLookup: { ...draft.commentAttachmentLookup },
    editingMentionIds: [...draft.editingMentionIds],
    editingAttachmentIds: [...draft.editingAttachmentIds],
  }
}

export function saveTaskDetailDraft(store: TaskDetailDraftStore, taskId: string, draft: TaskDetailDraft): TaskDetailDraftStore {
  if (!taskId) return store
  return { ...store, [taskId]: cloneDraft(draft) }
}

export function readTaskDetailDraft(store: TaskDetailDraftStore, taskId: string): TaskDetailDraft | undefined {
  const draft = store[taskId]
  return draft ? cloneDraft(draft) : undefined
}

export function discardTaskDetailDraft(store: TaskDetailDraftStore, taskId: string): TaskDetailDraftStore {
  if (!taskId || !(taskId in store)) return store
  const next = { ...store }
  delete next[taskId]
  return next
}
