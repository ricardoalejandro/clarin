import { describe, expect, it } from 'vitest'
import {
  createWhiteboardElementCommentAnchor,
  createWhiteboardCommentDraft,
  createWhiteboardPointCommentAnchor,
  appendWhiteboardThreadCommentPage,
  insertWhiteboardCommentEmoji,
  isWhiteboardCommentDraftDirty,
  isWhiteboardCommentPinVisible,
  nextWhiteboardCommentThreadIndex,
  normalizeWhiteboardCommentCounts,
  projectWhiteboardCommentAnchorToViewport,
  reconcileWhiteboardCommentMarkers,
  reconcileWhiteboardCommentThreadCollection,
  resolveWhiteboardCommentAnchor,
  reconcileWhiteboardThreadCommentPage,
  updateWhiteboardCommentDraftBody,
  validateWhiteboardCommentBody,
  visibleWhiteboardCommentThreads,
  whiteboardCommentThreadCount,
  type WhiteboardCommentThread,
} from '@/lib/whiteboardComments'
import {
  buildWhiteboardCommentMarkersPath,
  buildWhiteboardCommentThreadsPath,
  buildWhiteboardThreadCommentsPath,
} from '@/lib/whiteboardCommentsApi'

function thread(overrides: Partial<WhiteboardCommentThread> = {}): WhiteboardCommentThread {
  return {
    id: 'thread-1',
    board_id: 'board-1',
    element_id: 'element-1',
    anchor_x: 50,
    anchor_y: 25,
    anchor_ratio_x: 0.5,
    anchor_ratio_y: 0.5,
    status: 'open',
    version: 1,
    created_by: 'user-1',
    created_by_name: 'Ana Pérez',
    comments: [],
    created_at: '2026-08-14T10:00:00Z',
    updated_at: '2026-08-14T10:00:00Z',
    ...overrides,
  }
}

describe('whiteboard comment anchors', () => {
  it('stores a normalized element anchor and follows moved/resized bounds', () => {
    const anchor = createWhiteboardElementCommentAnchor({
      elementID: 'shape-1',
      bounds: { minX: 10, minY: 20, maxX: 110, maxY: 70 },
      sceneX: 85,
      sceneY: 30,
    })
    expect(anchor).toEqual({
      element_id: 'shape-1',
      anchor_x: 85,
      anchor_y: 30,
      anchor_ratio_x: 0.75,
      anchor_ratio_y: 0.2,
    })

    expect(resolveWhiteboardCommentAnchor(anchor, { minX: 200, minY: 100, maxX: 400, maxY: 200 })).toEqual({
      sceneX: 350,
      sceneY: 120,
      elementID: 'shape-1',
      orphaned: false,
    })
  })

  it('clamps an element click and preserves the absolute fallback when its shape disappears', () => {
    const anchor = createWhiteboardElementCommentAnchor({
      elementID: 'shape-1',
      bounds: { minX: 10, minY: 20, maxX: 110, maxY: 70 },
      sceneX: 900,
      sceneY: -20,
    })
    expect(anchor.anchor_ratio_x).toBe(1)
    expect(anchor.anchor_ratio_y).toBe(0)
    expect(resolveWhiteboardCommentAnchor(anchor, null)).toEqual({
      sceneX: 110,
      sceneY: 20,
      elementID: 'shape-1',
      orphaned: true,
    })
  })

  it('keeps a free-canvas point independent from element geometry', () => {
    const anchor = createWhiteboardPointCommentAnchor(-12.5, 44)
    expect(resolveWhiteboardCommentAnchor(anchor, null)).toEqual({
      sceneX: -12.5,
      sceneY: 44,
      elementID: null,
      orphaned: false,
    })
  })

  it('projects scene coordinates and clips pins against the measured editor container', () => {
    const point = projectWhiteboardCommentAnchorToViewport(
      { sceneX: 100, sceneY: 80 },
      { zoom: 2, scrollX: -20, scrollY: 10, offsetLeft: 50, offsetTop: 30 },
    )
    expect(point).toEqual({ x: 210, y: 210 })
    expect(isWhiteboardCommentPinVisible({
      point,
      containerLeft: 40,
      containerTop: 20,
      containerWidth: 400,
      containerHeight: 300,
    })).toBe(true)
    expect(isWhiteboardCommentPinVisible({
      point: { x: 900, y: 210 },
      containerLeft: 40,
      containerTop: 20,
      containerWidth: 400,
      containerHeight: 300,
      margin: 0,
    })).toBe(false)
  })
})

describe('whiteboard comment collection', () => {
  it('deduplicates pages and refuses to replace a newer canonical thread with a stale event', () => {
    const canonical = thread({ version: 3, updated_at: '2026-08-14T12:00:00Z' })
    const result = reconcileWhiteboardCommentThreadCollection({
      current: { threads: [canonical], nextCursor: 'next-1', counts: { open: 1, resolved: 0, all: 1 } },
      incoming: [thread({ version: 2, updated_at: '2026-08-14T13:00:00Z' }), thread({ id: 'thread-2' })],
      mode: 'append',
      nextCursor: null,
    })
    expect(result.threads).toHaveLength(2)
    expect(result.threads.find(item => item.id === 'thread-1')?.version).toBe(3)
    expect(result.nextCursor).toBeNull()
  })

  it('filters statuses locally so open pins remain available after loading all threads', () => {
    const threads = [thread(), thread({ id: 'thread-2', status: 'resolved' })]
    expect(visibleWhiteboardCommentThreads(threads, 'open').map(item => item.id)).toEqual(['thread-1'])
    expect(visibleWhiteboardCommentThreads(threads, 'resolved').map(item => item.id)).toEqual(['thread-2'])
    expect(visibleWhiteboardCommentThreads(threads, 'all')).toHaveLength(2)
  })

  it('wraps Arrow navigation and supports Home and End', () => {
    expect(nextWhiteboardCommentThreadIndex({ currentIndex: 2, itemCount: 3, key: 'ArrowDown' })).toBe(0)
    expect(nextWhiteboardCommentThreadIndex({ currentIndex: 0, itemCount: 3, key: 'ArrowUp' })).toBe(2)
    expect(nextWhiteboardCommentThreadIndex({ currentIndex: 1, itemCount: 3, key: 'Home' })).toBe(0)
    expect(nextWhiteboardCommentThreadIndex({ currentIndex: 1, itemCount: 3, key: 'End' })).toBe(2)
  })

  it('appends a bounded thread page in chronological order and preserves the server total', () => {
    const first = {
      id: 'comment-1', thread_id: 'thread-1', body: 'Uno', version: 1,
      created_at: '2026-08-14T10:00:00Z', updated_at: '2026-08-14T10:00:00Z',
    }
    const base = thread({ comments: [first], comment_count: 3, comments_has_more: true, comments_next_cursor: 'cursor-1' })
    const result = appendWhiteboardThreadCommentPage({
      thread: base,
      comments: [
        { ...first, version: 2, body: 'Uno editado', updated_at: '2026-08-14T10:03:00Z' },
        { ...first, id: 'comment-2', body: 'Dos', created_at: '2026-08-14T10:01:00Z', updated_at: '2026-08-14T10:01:00Z' },
      ],
      nextCursor: 'cursor-2',
    })
    expect(result.comments.map(comment => comment.id)).toEqual(['comment-1', 'comment-2'])
    expect(result.comments[0].body).toBe('Uno editado')
    expect(whiteboardCommentThreadCount(result)).toBe(3)
    expect(result.comments_has_more).toBe(true)
    expect(result.comments_next_cursor).toBe('cursor-2')
  })

  it('does not let a stale page response reopen a thread completed by realtime', () => {
    const complete = thread({
      comments: [{
        id: 'comment-1', thread_id: 'thread-1', body: 'Completo', version: 2,
        created_at: '2026-08-14T10:00:00Z', updated_at: '2026-08-14T10:02:00Z',
      }],
      comment_count: 1,
      comments_has_more: false,
      comments_next_cursor: null,
    })
    const result = reconcileWhiteboardThreadCommentPage({
      thread: complete,
      requestedCursor: 'cursor-obsoleto',
      comments: [{
        id: 'comment-1', thread_id: 'thread-1', body: 'Viejo', version: 1,
        created_at: '2026-08-14T10:00:00Z', updated_at: '2026-08-14T10:01:00Z',
      }],
      nextCursor: 'cursor-todavia-mas-viejo',
    })
    expect(result.comments[0].body).toBe('Completo')
    expect(result.comments_has_more).toBe(false)
    expect(result.comments_next_cursor).toBeNull()
  })

  it('keeps marker pages body-free, deduplicated, and resistant to stale updates', () => {
    const current = [{
      id: 'thread-1', board_id: 'board-1', element_id: null, anchor_x: 5, anchor_y: 7,
      anchor_ratio_x: null, anchor_ratio_y: null, version: 3, comment_count: 4,
      updated_at: '2026-08-14T12:00:00Z',
    }]
    const result = reconcileWhiteboardCommentMarkers({
      current,
      incoming: [
        { ...current[0], version: 2, comment_count: 2, updated_at: '2026-08-14T13:00:00Z' },
        { ...current[0], id: 'thread-2', version: 1, comment_count: 1 },
      ],
      mode: 'upsert',
    })
    expect(result).toHaveLength(2)
    expect(result.find(marker => marker.id === 'thread-1')?.comment_count).toBe(4)
    expect(result.every(marker => !('comments' in marker))).toBe(true)
  })
})

describe('whiteboard comment text and API contract', () => {
  it('keeps a draft operation and edit baseline stable until the body really changes', () => {
    const draft = createWhiteboardCommentDraft({
      key: 'edit:comment-1',
      kind: 'edit',
      operationID: 'op-1',
      initialBody: 'Original',
      threadID: 'thread-1',
      commentID: 'comment-1',
      baseVersion: 7,
    })
    expect(isWhiteboardCommentDraftDirty(draft)).toBe(false)
    expect(updateWhiteboardCommentDraftBody(draft, 'Original', 'op-2')).toBe(draft)
    const edited = updateWhiteboardCommentDraftBody(draft, 'Mi cambio', 'op-2')
    expect(edited).toMatchObject({ body: 'Mi cambio', operationID: 'op-2', baseVersion: 7 })
    expect(isWhiteboardCommentDraftDirty(edited)).toBe(true)
    expect(updateWhiteboardCommentDraftBody({ ...edited, pending: true }, 'Otro', 'op-3').body).toBe('Mi cambio')
  })

  it('normalizes canonical counts without allowing negative or fractional inventory', () => {
    expect(normalizeWhiteboardCommentCounts({ open: 2.9, resolved: -4, all: 9.8 })).toEqual({
      open: 2,
      resolved: 0,
      all: 9,
    })
  })

  it('accepts Unicode and emoji, normalizes newlines, and rejects empty or oversized bodies', () => {
    expect(validateWhiteboardCommentBody('  ¡Hola 👋!\r\nSegunda línea  ')).toEqual({
      valid: true,
      body: '¡Hola 👋!\nSegunda línea',
      error: null,
    })
    expect(validateWhiteboardCommentBody('  ').valid).toBe(false)
    expect(validateWhiteboardCommentBody('🟢'.repeat(4_001)).valid).toBe(false)
  })

  it('inserts an emoji at the current selection and returns the next caret', () => {
    expect(insertWhiteboardCommentEmoji('Hola mundo', '🎉', 5, 10)).toEqual({ value: 'Hola 🎉', caret: 7 })
  })

  it('builds a bounded, encoded comments page path', () => {
    expect(buildWhiteboardCommentThreadsPath({
      boardID: 'board/with space',
      status: 'resolved',
      cursor: 'cursor+1',
      limit: 900,
    })).toBe('/api/whiteboards/board%2Fwith%20space/comment-threads?status=resolved&limit=200&cursor=cursor%2B1')
    expect(buildWhiteboardThreadCommentsPath({
      boardID: 'board/with space',
      threadID: 'thread/one',
      cursor: 'cursor+2',
      limit: 900,
    })).toBe('/api/whiteboards/board%2Fwith%20space/comment-threads/thread%2Fone/comments?limit=100&cursor=cursor%2B2')
    expect(buildWhiteboardCommentMarkersPath({
      boardID: 'board/with space',
      cursor: 'marker+2',
      limit: 900,
    })).toBe('/api/whiteboards/board%2Fwith%20space/comment-markers?limit=200&cursor=marker%2B2')
  })
})
