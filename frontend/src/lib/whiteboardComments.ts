export const WHITEBOARD_COMMENT_BODY_MAX_LENGTH = 4_000
export const WHITEBOARD_COMMENT_DEFAULT_PAGE_SIZE = 50
export const WHITEBOARD_COMMENT_MAX_PAGE_SIZE = 200
export const WHITEBOARD_THREAD_COMMENT_DEFAULT_PAGE_SIZE = 50
export const WHITEBOARD_THREAD_COMMENT_MAX_PAGE_SIZE = 100

export type WhiteboardCommentThreadStatus = 'open' | 'resolved'
export type WhiteboardCommentStatusFilter = WhiteboardCommentThreadStatus | 'all'

export interface WhiteboardComment {
  id: string
  thread_id: string
  author_id?: string | null
  author_name?: string | null
  body: string
  version: number
  deleted_at?: string | null
  created_at: string
  updated_at: string
}

export interface WhiteboardCommentThread {
  id: string
  board_id: string
  element_id?: string | null
  anchor_x: number
  anchor_y: number
  anchor_ratio_x?: number | null
  anchor_ratio_y?: number | null
  status: WhiteboardCommentThreadStatus
  version: number
  created_by?: string | null
  created_by_name?: string | null
  resolved_by?: string | null
  resolved_at?: string | null
  comments: WhiteboardComment[]
  comment_count?: number
  comments_has_more?: boolean
  comments_next_cursor?: string | null
  created_at: string
  updated_at: string
}

export interface WhiteboardCommentAnchor {
  element_id: string | null
  anchor_x: number
  anchor_y: number
  anchor_ratio_x: number | null
  anchor_ratio_y: number | null
}

export interface WhiteboardCommentElementBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface WhiteboardCommentResolvedAnchor {
  sceneX: number
  sceneY: number
  elementID: string | null
  orphaned: boolean
}

export interface WhiteboardCommentViewportState {
  zoom: number
  scrollX: number
  scrollY: number
  offsetLeft: number
  offsetTop: number
}

export interface WhiteboardCommentViewportPoint {
  x: number
  y: number
}

export interface WhiteboardCommentChangedEvent {
  action?: string
  board_id?: string
  thread?: WhiteboardCommentThread
  reason?: string
}

export interface WhiteboardCommentCounts {
  open: number
  resolved: number
  all: number
}

export interface WhiteboardCommentMarker {
  id: string
  board_id: string
  element_id?: string | null
  anchor_x: number
  anchor_y: number
  anchor_ratio_x?: number | null
  anchor_ratio_y?: number | null
  version: number
  comment_count: number
  updated_at: string
}

export interface WhiteboardCommentThreadCollection {
  threads: WhiteboardCommentThread[]
  nextCursor: string | null
  counts: WhiteboardCommentCounts
}

export type WhiteboardCommentDraftKind = 'create' | 'reply' | 'edit'

export interface WhiteboardCommentDraft {
  key: string
  kind: WhiteboardCommentDraftKind
  body: string
  initialBody: string
  operationID: string
  pending: boolean
  error: string | null
  threadID: string | null
  commentID: string | null
  baseVersion: number | null
}

export const EMPTY_WHITEBOARD_COMMENT_COUNTS: WhiteboardCommentCounts = Object.freeze({
  open: 0,
  resolved: 0,
  all: 0,
})

function finiteNumber(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function clampWhiteboardCommentRatio(value: unknown) {
  return Math.min(1, Math.max(0, finiteNumber(value, 0.5)))
}

export function createWhiteboardPointCommentAnchor(sceneX: number, sceneY: number): WhiteboardCommentAnchor {
  return {
    element_id: null,
    anchor_x: finiteNumber(sceneX),
    anchor_y: finiteNumber(sceneY),
    anchor_ratio_x: null,
    anchor_ratio_y: null,
  }
}

export function createWhiteboardElementCommentAnchor(input: {
  elementID: string
  bounds: WhiteboardCommentElementBounds
  sceneX?: number
  sceneY?: number
}): WhiteboardCommentAnchor {
  const minX = Math.min(finiteNumber(input.bounds.minX), finiteNumber(input.bounds.maxX))
  const maxX = Math.max(finiteNumber(input.bounds.minX), finiteNumber(input.bounds.maxX))
  const minY = Math.min(finiteNumber(input.bounds.minY), finiteNumber(input.bounds.maxY))
  const maxY = Math.max(finiteNumber(input.bounds.minY), finiteNumber(input.bounds.maxY))
  const width = maxX - minX
  const height = maxY - minY
  const requestedX = finiteNumber(input.sceneX, minX + width / 2)
  const requestedY = finiteNumber(input.sceneY, minY + height / 2)
  const ratioX = width > 0 ? clampWhiteboardCommentRatio((requestedX - minX) / width) : 0.5
  const ratioY = height > 0 ? clampWhiteboardCommentRatio((requestedY - minY) / height) : 0.5
  return {
    element_id: input.elementID,
    anchor_x: minX + width * ratioX,
    anchor_y: minY + height * ratioY,
    anchor_ratio_x: ratioX,
    anchor_ratio_y: ratioY,
  }
}

export function resolveWhiteboardCommentAnchor(
  thread: Pick<WhiteboardCommentThread, 'element_id' | 'anchor_x' | 'anchor_y' | 'anchor_ratio_x' | 'anchor_ratio_y'>,
  bounds: WhiteboardCommentElementBounds | null,
): WhiteboardCommentResolvedAnchor {
  const fallback = {
    sceneX: finiteNumber(thread.anchor_x),
    sceneY: finiteNumber(thread.anchor_y),
    elementID: thread.element_id || null,
    orphaned: Boolean(thread.element_id),
  }
  if (!thread.element_id || !bounds) return fallback
  const minX = Math.min(finiteNumber(bounds.minX), finiteNumber(bounds.maxX))
  const maxX = Math.max(finiteNumber(bounds.minX), finiteNumber(bounds.maxX))
  const minY = Math.min(finiteNumber(bounds.minY), finiteNumber(bounds.maxY))
  const maxY = Math.max(finiteNumber(bounds.minY), finiteNumber(bounds.maxY))
  return {
    sceneX: minX + (maxX - minX) * clampWhiteboardCommentRatio(thread.anchor_ratio_x),
    sceneY: minY + (maxY - minY) * clampWhiteboardCommentRatio(thread.anchor_ratio_y),
    elementID: thread.element_id,
    orphaned: false,
  }
}

export function projectWhiteboardCommentAnchorToViewport(
  anchor: Pick<WhiteboardCommentResolvedAnchor, 'sceneX' | 'sceneY'>,
  viewport: WhiteboardCommentViewportState,
): WhiteboardCommentViewportPoint {
  const zoom = Math.max(0.01, finiteNumber(viewport.zoom, 1))
  return {
    x: (finiteNumber(anchor.sceneX) + finiteNumber(viewport.scrollX)) * zoom + finiteNumber(viewport.offsetLeft),
    y: (finiteNumber(anchor.sceneY) + finiteNumber(viewport.scrollY)) * zoom + finiteNumber(viewport.offsetTop),
  }
}

export function isWhiteboardCommentPinVisible(input: {
  point: WhiteboardCommentViewportPoint
  containerLeft: number
  containerTop: number
  containerWidth: number
  containerHeight: number
  margin?: number
}) {
  const margin = Math.max(0, finiteNumber(input.margin, 24))
  const x = input.point.x - finiteNumber(input.containerLeft)
  const y = input.point.y - finiteNumber(input.containerTop)
  return x >= -margin
    && y >= -margin
    && x <= Math.max(0, finiteNumber(input.containerWidth)) + margin
    && y <= Math.max(0, finiteNumber(input.containerHeight)) + margin
}

export function normalizeWhiteboardCommentBody(value: string) {
  return value.replace(/\r\n?/g, '\n').trim()
}

export function validateWhiteboardCommentBody(value: string) {
  const body = normalizeWhiteboardCommentBody(value)
  if (!body) return { valid: false as const, body, error: 'Escribe un comentario.' }
  if (Array.from(body).length > WHITEBOARD_COMMENT_BODY_MAX_LENGTH) {
    return {
      valid: false as const,
      body,
      error: `El comentario no puede superar ${WHITEBOARD_COMMENT_BODY_MAX_LENGTH.toLocaleString('es')} caracteres.`,
    }
  }
  return { valid: true as const, body, error: null }
}

export function insertWhiteboardCommentEmoji(
  value: string,
  emoji: string,
  selectionStart: number | null,
  selectionEnd: number | null,
) {
  const start = Math.max(0, Math.min(value.length, selectionStart ?? value.length))
  const end = Math.max(start, Math.min(value.length, selectionEnd ?? start))
  const nextValue = `${value.slice(0, start)}${emoji}${value.slice(end)}`
  return { value: nextValue, caret: start + emoji.length }
}

export function createWhiteboardCommentOperationID() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `comment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export function normalizeWhiteboardCommentCounts(
  value: Partial<WhiteboardCommentCounts> | null | undefined,
  fallback: WhiteboardCommentCounts = EMPTY_WHITEBOARD_COMMENT_COUNTS,
): WhiteboardCommentCounts {
  const count = (candidate: unknown, current: number) => typeof candidate === 'number' && Number.isFinite(candidate)
    ? Math.max(0, Math.trunc(candidate))
    : current
  const open = count(value?.open, fallback.open)
  const resolved = count(value?.resolved, fallback.resolved)
  const all = count(value?.all, Math.max(fallback.all, open + resolved))
  return {
    open,
    resolved,
    all: Math.max(all, open + resolved),
  }
}

export function createWhiteboardCommentDraft(input: {
  key: string
  kind: WhiteboardCommentDraftKind
  operationID: string
  initialBody?: string
  threadID?: string | null
  commentID?: string | null
  baseVersion?: number | null
}): WhiteboardCommentDraft {
  const initialBody = input.initialBody || ''
  return {
    key: input.key,
    kind: input.kind,
    body: initialBody,
    initialBody,
    operationID: input.operationID,
    pending: false,
    error: null,
    threadID: input.threadID || null,
    commentID: input.commentID || null,
    baseVersion: input.baseVersion ?? null,
  }
}

export function updateWhiteboardCommentDraftBody(
  draft: WhiteboardCommentDraft,
  body: string,
  operationID: string,
): WhiteboardCommentDraft {
  if (draft.pending || draft.body === body) return draft
  return { ...draft, body, operationID, error: null }
}

export function isWhiteboardCommentDraftDirty(draft: WhiteboardCommentDraft) {
  return draft.body !== draft.initialBody
}

export function whiteboardCommentMarkerFromThread(thread: WhiteboardCommentThread): WhiteboardCommentMarker {
  return {
    id: thread.id,
    board_id: thread.board_id,
    element_id: thread.element_id || null,
    anchor_x: thread.anchor_x,
    anchor_y: thread.anchor_y,
    anchor_ratio_x: thread.anchor_ratio_x ?? null,
    anchor_ratio_y: thread.anchor_ratio_y ?? null,
    version: thread.version,
    comment_count: whiteboardCommentThreadCount(thread),
    updated_at: thread.updated_at,
  }
}

export function reconcileWhiteboardCommentMarkers(input: {
  current: readonly WhiteboardCommentMarker[]
  incoming: readonly WhiteboardCommentMarker[]
  mode: 'replace' | 'upsert'
  removeIDs?: readonly string[]
}) {
  const markers = new Map<string, WhiteboardCommentMarker>()
  if (input.mode !== 'replace') {
    for (const marker of input.current) markers.set(marker.id, marker)
  }
  for (const id of input.removeIDs || []) markers.delete(id)
  for (const marker of input.incoming) {
    const current = markers.get(marker.id)
    if (!current
      || marker.version > current.version
      || (marker.version === current.version && marker.updated_at >= current.updated_at)) {
      markers.set(marker.id, marker)
    }
  }
  return Array.from(markers.values()).sort((a, b) => {
    const updated = Date.parse(b.updated_at) - Date.parse(a.updated_at)
    if (Number.isFinite(updated) && updated !== 0) return updated
    return b.id.localeCompare(a.id)
  })
}

export function visibleWhiteboardCommentThreads(
  threads: readonly WhiteboardCommentThread[],
  filter: WhiteboardCommentStatusFilter,
) {
  return threads.filter(thread => filter === 'all' || thread.status === filter)
}

export function compareWhiteboardCommentThreads(a: WhiteboardCommentThread, b: WhiteboardCommentThread) {
  const updated = Date.parse(b.updated_at) - Date.parse(a.updated_at)
  if (Number.isFinite(updated) && updated !== 0) return updated
  return b.id.localeCompare(a.id)
}

export function whiteboardCommentThreadCount(thread: WhiteboardCommentThread) {
  return Math.max(thread.comments.length, Math.max(0, Math.trunc(thread.comment_count ?? thread.comments.length)))
}

export function appendWhiteboardThreadCommentPage(input: {
  thread: WhiteboardCommentThread
  comments: readonly WhiteboardComment[]
  nextCursor?: string | null
}) {
  const commentsByID = new Map(input.thread.comments.map(comment => [comment.id, comment]))
  for (const comment of input.comments) {
    const current = commentsByID.get(comment.id)
    if (!current
      || comment.version > current.version
      || (comment.version === current.version && comment.updated_at >= current.updated_at)) {
      commentsByID.set(comment.id, comment)
    }
  }
  const comments = Array.from(commentsByID.values()).sort((a, b) => {
    const created = Date.parse(a.created_at) - Date.parse(b.created_at)
    if (Number.isFinite(created) && created !== 0) return created
    return a.id.localeCompare(b.id)
  })
  const nextCursor = input.nextCursor || null
  return {
    ...input.thread,
    comments,
    comment_count: Math.max(whiteboardCommentThreadCount(input.thread), comments.length),
    comments_has_more: Boolean(nextCursor),
    comments_next_cursor: nextCursor,
  }
}

export function reconcileWhiteboardThreadCommentPage(input: {
  thread: WhiteboardCommentThread
  comments: readonly WhiteboardComment[]
  requestedCursor?: string | null
  nextCursor?: string | null
}) {
  const requestedCursor = input.requestedCursor || null
  const currentCursor = input.thread.comments_next_cursor || null
  const paginationIsCurrent = input.thread.comments_has_more === true && currentCursor === requestedCursor
  const merged = appendWhiteboardThreadCommentPage({
    thread: input.thread,
    comments: input.comments,
    nextCursor: input.nextCursor,
  })
  if (paginationIsCurrent) return merged
  return {
    ...merged,
    comments_has_more: input.thread.comments_has_more,
    comments_next_cursor: input.thread.comments_next_cursor,
  }
}

export function reconcileWhiteboardCommentThreadCollection(input: {
  current: WhiteboardCommentThreadCollection
  incoming: readonly WhiteboardCommentThread[]
  mode: 'replace' | 'append' | 'upsert'
  nextCursor?: string | null
  counts?: WhiteboardCommentCounts
}): WhiteboardCommentThreadCollection {
  const threadsByID = new Map<string, WhiteboardCommentThread>()
  if (input.mode !== 'replace') {
    for (const thread of input.current.threads) threadsByID.set(thread.id, thread)
  }
  for (const thread of input.incoming) {
    const current = threadsByID.get(thread.id)
    if (!current
      || thread.version > current.version
      || (thread.version === current.version && thread.updated_at >= current.updated_at)) {
      threadsByID.set(thread.id, thread)
    }
  }
  return {
    threads: Array.from(threadsByID.values()).sort(compareWhiteboardCommentThreads),
    nextCursor: input.nextCursor === undefined ? input.current.nextCursor : input.nextCursor,
    counts: input.counts || input.current.counts,
  }
}

export function nextWhiteboardCommentThreadIndex(input: {
  currentIndex: number
  itemCount: number
  key: string
}) {
  const count = Math.max(0, Math.trunc(input.itemCount))
  if (count === 0) return -1
  const current = Math.max(0, Math.min(count - 1, Math.trunc(input.currentIndex)))
  if (input.key === 'Home') return 0
  if (input.key === 'End') return count - 1
  if (input.key === 'ArrowDown') return (current + 1) % count
  if (input.key === 'ArrowUp') return (current - 1 + count) % count
  return current
}

export function whiteboardCommentInitials(name: string | null | undefined) {
  const words = (name || 'Usuario').trim().split(/\s+/).filter(Boolean)
  return words.slice(0, 2).map(word => Array.from(word)[0] || '').join('').toLocaleUpperCase('es') || 'U'
}
