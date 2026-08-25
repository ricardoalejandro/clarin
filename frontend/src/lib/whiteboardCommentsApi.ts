import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api'
import {
  WHITEBOARD_COMMENT_DEFAULT_PAGE_SIZE,
  WHITEBOARD_COMMENT_MAX_PAGE_SIZE,
  WHITEBOARD_THREAD_COMMENT_DEFAULT_PAGE_SIZE,
  WHITEBOARD_THREAD_COMMENT_MAX_PAGE_SIZE,
  type WhiteboardComment,
  type WhiteboardCommentAnchor,
  type WhiteboardCommentCounts,
  type WhiteboardCommentMarker,
  type WhiteboardCommentStatusFilter,
  type WhiteboardCommentThread,
  type WhiteboardCommentThreadStatus,
} from '@/lib/whiteboardComments'

const WHITEBOARD_COMMENTS_API_ROOT = '/api/whiteboards'

export interface WhiteboardCommentThreadsPage {
  success?: boolean
  threads: WhiteboardCommentThread[]
  next_cursor?: string | null
  counts: WhiteboardCommentCounts
}

export interface WhiteboardCommentMarkersPage {
  success?: boolean
  markers: WhiteboardCommentMarker[]
  next_cursor?: string | null
}

export interface WhiteboardCommentThreadResponse {
  success?: boolean
  thread: WhiteboardCommentThread
}

export interface WhiteboardCommentThreadMutationResponse {
  success?: boolean
  thread: WhiteboardCommentThread
}

export interface WhiteboardThreadCommentsPage {
  success?: boolean
  comments: WhiteboardComment[]
  next_cursor?: string | null
}

export function buildWhiteboardCommentThreadsPath(input: {
  boardID: string
  status?: WhiteboardCommentStatusFilter
  cursor?: string | null
  limit?: number
}) {
  const limit = Math.max(1, Math.min(
    WHITEBOARD_COMMENT_MAX_PAGE_SIZE,
    Math.trunc(input.limit || WHITEBOARD_COMMENT_DEFAULT_PAGE_SIZE),
  ))
  const params = new URLSearchParams({ status: input.status || 'all', limit: String(limit) })
  if (input.cursor) params.set('cursor', input.cursor)
  return `${WHITEBOARD_COMMENTS_API_ROOT}/${encodeURIComponent(input.boardID)}/comment-threads?${params.toString()}`
}

export function listWhiteboardCommentThreads(input: {
  boardID: string
  status?: WhiteboardCommentStatusFilter
  cursor?: string | null
  limit?: number
  signal?: AbortSignal
}) {
  return apiGet<WhiteboardCommentThreadsPage>(buildWhiteboardCommentThreadsPath(input), { signal: input.signal })
}

export function buildWhiteboardCommentMarkersPath(input: {
  boardID: string
  cursor?: string | null
  limit?: number
}) {
  const limit = Math.max(1, Math.min(
    WHITEBOARD_COMMENT_MAX_PAGE_SIZE,
    Math.trunc(input.limit || WHITEBOARD_COMMENT_MAX_PAGE_SIZE),
  ))
  const params = new URLSearchParams({ limit: String(limit) })
  if (input.cursor) params.set('cursor', input.cursor)
  return `${WHITEBOARD_COMMENTS_API_ROOT}/${encodeURIComponent(input.boardID)}/comment-markers?${params.toString()}`
}

export function listWhiteboardCommentMarkers(input: {
  boardID: string
  cursor?: string | null
  limit?: number
  signal?: AbortSignal
}) {
  return apiGet<WhiteboardCommentMarkersPage>(buildWhiteboardCommentMarkersPath(input), { signal: input.signal })
}

export function getWhiteboardCommentThread(input: {
  boardID: string
  threadID: string
  signal?: AbortSignal
}) {
  return apiGet<WhiteboardCommentThreadResponse>(
    `${WHITEBOARD_COMMENTS_API_ROOT}/${encodeURIComponent(input.boardID)}/comment-threads/${encodeURIComponent(input.threadID)}`,
    { signal: input.signal },
  )
}

export function buildWhiteboardThreadCommentsPath(input: {
  boardID: string
  threadID: string
  cursor?: string | null
  limit?: number
}) {
  const limit = Math.max(1, Math.min(
    WHITEBOARD_THREAD_COMMENT_MAX_PAGE_SIZE,
    Math.trunc(input.limit || WHITEBOARD_THREAD_COMMENT_DEFAULT_PAGE_SIZE),
  ))
  const params = new URLSearchParams({ limit: String(limit) })
  if (input.cursor) params.set('cursor', input.cursor)
  return `${WHITEBOARD_COMMENTS_API_ROOT}/${encodeURIComponent(input.boardID)}/comment-threads/${encodeURIComponent(input.threadID)}/comments?${params.toString()}`
}

export function listWhiteboardThreadComments(input: {
  boardID: string
  threadID: string
  cursor?: string | null
  limit?: number
  signal?: AbortSignal
}) {
  return apiGet<WhiteboardThreadCommentsPage>(buildWhiteboardThreadCommentsPath(input), { signal: input.signal })
}

export function createWhiteboardCommentThread(input: {
  boardID: string
  operationID: string
  anchor: WhiteboardCommentAnchor
  body: string
}) {
  return apiPost<WhiteboardCommentThreadMutationResponse>(
    `${WHITEBOARD_COMMENTS_API_ROOT}/${encodeURIComponent(input.boardID)}/comment-threads`,
    {
      operation_id: input.operationID,
      element_id: input.anchor.element_id,
      anchor_x: input.anchor.anchor_x,
      anchor_y: input.anchor.anchor_y,
      anchor_ratio_x: input.anchor.anchor_ratio_x,
      anchor_ratio_y: input.anchor.anchor_ratio_y,
      body: input.body,
    },
  )
}

export function replyToWhiteboardCommentThread(input: {
  boardID: string
  threadID: string
  operationID: string
  body: string
}) {
  return apiPost<WhiteboardCommentThreadMutationResponse>(
    `${WHITEBOARD_COMMENTS_API_ROOT}/${encodeURIComponent(input.boardID)}/comment-threads/${encodeURIComponent(input.threadID)}/replies`,
    { operation_id: input.operationID, body: input.body },
  )
}

export function updateWhiteboardComment(input: {
  boardID: string
  threadID: string
  commentID: string
  operationID: string
  expectedVersion: number
  body: string
}) {
  return apiPatch<WhiteboardCommentThreadMutationResponse>(
    `${WHITEBOARD_COMMENTS_API_ROOT}/${encodeURIComponent(input.boardID)}/comment-threads/${encodeURIComponent(input.threadID)}/comments/${encodeURIComponent(input.commentID)}`,
    {
      operation_id: input.operationID,
      expected_version: input.expectedVersion,
      body: input.body,
    },
  )
}

export function deleteWhiteboardComment(input: {
  boardID: string
  threadID: string
  commentID: string
  operationID: string
  expectedVersion: number
}) {
  return apiDelete<WhiteboardCommentThreadMutationResponse>(
    `${WHITEBOARD_COMMENTS_API_ROOT}/${encodeURIComponent(input.boardID)}/comment-threads/${encodeURIComponent(input.threadID)}/comments/${encodeURIComponent(input.commentID)}`,
    { operation_id: input.operationID, expected_version: input.expectedVersion },
  )
}

export function updateWhiteboardCommentThreadStatus(input: {
  boardID: string
  threadID: string
  operationID: string
  expectedVersion: number
  status: WhiteboardCommentThreadStatus
}) {
  return apiPatch<WhiteboardCommentThreadMutationResponse>(
    `${WHITEBOARD_COMMENTS_API_ROOT}/${encodeURIComponent(input.boardID)}/comment-threads/${encodeURIComponent(input.threadID)}/status`,
    {
      operation_id: input.operationID,
      expected_version: input.expectedVersion,
      status: input.status,
    },
  )
}
