import { describe, expect, it } from 'vitest'
import type { WhiteboardPresentation } from '@/lib/whiteboards'
import {
  initialWhiteboardPresentationState,
  shouldShowWhiteboardPresentationInvitation,
  whiteboardPresentationControlState,
  whiteboardPresentationReducer,
  whiteboardViewportBoundsFromEvent,
} from './whiteboardPresentation'

const presentation: WhiteboardPresentation = {
  presentation_id: 'presentation-1',
  actor: { id: 'presenter-1', kind: 'user', display_name: 'Ana', access: 'edit' },
  started_at: '2026-08-17T10:00:00Z',
}

describe('whiteboard presentation state', () => {
  it('asks consent once and preserves a rejection across repeated snapshots', () => {
    let state = whiteboardPresentationReducer(initialWhiteboardPresentationState, { type: 'room.ready', actorID: 'viewer-1' })
    state = whiteboardPresentationReducer(state, { type: 'snapshot', presentation })
    expect(shouldShowWhiteboardPresentationInvitation(state)).toBe(true)

    state = whiteboardPresentationReducer(state, { type: 'invitation.declined', presentationID: presentation.presentation_id })
    state = whiteboardPresentationReducer(state, { type: 'snapshot', presentation })
    expect(shouldShowWhiteboardPresentationInvitation(state)).toBe(false)
  })

  it('remembers accepted presentations through reconnect without silently accepting a new one', () => {
    let state = whiteboardPresentationReducer(initialWhiteboardPresentationState, { type: 'room.ready', actorID: 'viewer-1' })
    state = whiteboardPresentationReducer(state, { type: 'snapshot', presentation })
    state = whiteboardPresentationReducer(state, { type: 'follow.local', actorID: presentation.actor.id })
    state = whiteboardPresentationReducer(state, { type: 'connection', connection: 'closed' })
    state = whiteboardPresentationReducer(state, { type: 'room.ready', actorID: 'viewer-2' })
    state = whiteboardPresentationReducer(state, { type: 'snapshot', presentation })
    expect(state.acceptedPresentationID).toBe(presentation.presentation_id)
    expect(shouldShowWhiteboardPresentationInvitation(state)).toBe(false)

    state = whiteboardPresentationReducer(state, {
      type: 'presentation.started',
      presentation: { ...presentation, presentation_id: 'presentation-2' },
    })
    expect(state.acceptedPresentationID).toBeNull()
    expect(shouldShowWhiteboardPresentationInvitation(state)).toBe(true)
  })

  it('tracks only followers targeting this presenter and ignores stale stop events', () => {
    let state = whiteboardPresentationReducer(initialWhiteboardPresentationState, { type: 'room.ready', actorID: presentation.actor.id })
    state = whiteboardPresentationReducer(state, { type: 'presentation.started', presentation })
    state = whiteboardPresentationReducer(state, { type: 'follow.remote', actorID: 'viewer-1', action: 'FOLLOW' })
    state = whiteboardPresentationReducer(state, { type: 'follow.remote', actorID: 'viewer-2', action: 'FOLLOW' })
    state = whiteboardPresentationReducer(state, { type: 'follow.remote', actorID: 'viewer-1', action: 'UNFOLLOW' })
    expect(state.followerActorIDs).toEqual(['viewer-2'])
    expect(whiteboardPresentationControlState(state)).toBe('active')

    const unchanged = whiteboardPresentationReducer(state, { type: 'presentation.stopped', presentationID: 'older' })
    expect(unchanged.active).toEqual(presentation)
  })

  it('reports occupied, offline and retryable error control states honestly', () => {
    let state = whiteboardPresentationReducer(initialWhiteboardPresentationState, { type: 'room.ready', actorID: 'viewer-1' })
    state = whiteboardPresentationReducer(state, { type: 'snapshot', presentation })
    expect(whiteboardPresentationControlState(state)).toBe('occupied')
    state = whiteboardPresentationReducer(state, { type: 'connection', connection: 'closed' })
    expect(whiteboardPresentationControlState(state)).toBe('disconnected')
    state = whiteboardPresentationReducer(state, { type: 'room.ready', actorID: 'viewer-2' })
    state = whiteboardPresentationReducer(state, { type: 'failure', message: 'Redis no disponible' })
    expect(whiteboardPresentationControlState(state)).toBe('error')
    state = whiteboardPresentationReducer(state, { type: 'presentation.started', presentation: { ...presentation, actor: { ...presentation.actor, id: 'viewer-2' } } })
    state = whiteboardPresentationReducer(state, { type: 'failure', message: 'No se pudo finalizar' })
    expect(whiteboardPresentationControlState(state)).toBe('error')
  })

  it('rejects non-finite, inverted and out-of-range remote viewports', () => {
    const event = (bounds: unknown) => ({ event: 'viewport.update' as const, data: { bounds } })
    expect(whiteboardViewportBoundsFromEvent(event([0, 0, 100, 50]))).toEqual([0, 0, 100, 50])
    expect(whiteboardViewportBoundsFromEvent(event([0, 0, 0, 50]))).toBeNull()
    expect(whiteboardViewportBoundsFromEvent(event([0, 0, Number.NaN, 50]))).toBeNull()
    expect(whiteboardViewportBoundsFromEvent(event([0, 0, 1_000_001, 50]))).toBeNull()
  })
})
