import type {
  WhiteboardPresentation,
  WhiteboardRealtimeActor,
  WhiteboardRealtimeEvent,
  WhiteboardViewportBounds,
} from '@/lib/whiteboards'

export type WhiteboardPresentationConnection = 'connecting' | 'open' | 'closed'
export type WhiteboardPresentationControlState = 'available' | 'starting' | 'active' | 'occupied' | 'disconnected' | 'error'

export interface WhiteboardPresentationState {
  connection: WhiteboardPresentationConnection
  selfActorID: string | null
  active: WhiteboardPresentation | null
  starting: boolean
  stopping: boolean
  declinedPresentationID: string | null
  acceptedPresentationID: string | null
  followingActorID: string | null
  followerActorIDs: readonly string[]
  error: string | null
}

export const initialWhiteboardPresentationState: WhiteboardPresentationState = {
  connection: 'connecting',
  selfActorID: null,
  active: null,
  starting: false,
  stopping: false,
  declinedPresentationID: null,
  acceptedPresentationID: null,
  followingActorID: null,
  followerActorIDs: [],
  error: null,
}

export type WhiteboardPresentationAction =
  | { type: 'connection'; connection: WhiteboardPresentationConnection }
  | { type: 'room.ready'; actorID: string }
  | { type: 'snapshot'; presentation: WhiteboardPresentation | null }
  | { type: 'presentation.started'; presentation: WhiteboardPresentation }
  | { type: 'presentation.stopped'; presentationID: string }
  | { type: 'start.requested' }
  | { type: 'stop.requested' }
  | { type: 'follow.local'; actorID: string | null; preserveAcceptance?: boolean }
  | { type: 'follow.remote'; actorID: string; action: 'FOLLOW' | 'UNFOLLOW' }
  | { type: 'invitation.declined'; presentationID: string }
  | { type: 'actor.left'; actorID: string }
  | { type: 'failure'; message: string }
  | { type: 'error.cleared' }

export function whiteboardPresentationReducer(
  state: WhiteboardPresentationState,
  action: WhiteboardPresentationAction,
): WhiteboardPresentationState {
  switch (action.type) {
    case 'connection':
      if (action.connection === 'open') return { ...state, connection: 'open', error: null }
      return {
        ...state,
        connection: action.connection,
        selfActorID: null,
        active: null,
        starting: false,
        stopping: false,
        followingActorID: null,
        followerActorIDs: [],
      }
    case 'room.ready':
      return { ...state, connection: 'open', selfActorID: action.actorID, error: null }
    case 'snapshot': {
      const sameInvitation = Boolean(action.presentation && state.active?.presentation_id === action.presentation.presentation_id)
      const keepAccepted = Boolean(action.presentation && state.acceptedPresentationID === action.presentation.presentation_id)
      const keepDeclined = Boolean(action.presentation && state.declinedPresentationID === action.presentation.presentation_id)
      return {
        ...state,
        active: action.presentation,
        starting: false,
        stopping: false,
        acceptedPresentationID: keepAccepted ? state.acceptedPresentationID : null,
        declinedPresentationID: keepDeclined ? state.declinedPresentationID : null,
        followerActorIDs: sameInvitation ? state.followerActorIDs : [],
        error: null,
      }
    }
    case 'presentation.started':
      return {
        ...state,
        active: action.presentation,
        starting: false,
        stopping: false,
        declinedPresentationID: null,
        acceptedPresentationID: null,
        followerActorIDs: [],
        error: null,
      }
    case 'presentation.stopped':
      if (state.active?.presentation_id !== action.presentationID) return state
      return {
        ...state,
        active: null,
        starting: false,
        stopping: false,
        declinedPresentationID: null,
        acceptedPresentationID: null,
        followingActorID: state.followingActorID === state.active.actor.id ? null : state.followingActorID,
        followerActorIDs: [],
        error: null,
      }
    case 'start.requested':
      return { ...state, starting: true, stopping: false, error: null }
    case 'stop.requested':
      return { ...state, stopping: true, error: null }
    case 'follow.local': {
      const acceptsActive = Boolean(action.actorID && state.active?.actor.id === action.actorID)
      return {
        ...state,
        followingActorID: action.actorID,
        acceptedPresentationID: acceptsActive
          ? state.active!.presentation_id
          : action.preserveAcceptance ? state.acceptedPresentationID : null,
        declinedPresentationID: acceptsActive ? null : state.declinedPresentationID,
      }
    }
    case 'follow.remote': {
      const followers = new Set(state.followerActorIDs)
      if (action.action === 'FOLLOW') followers.add(action.actorID)
      else followers.delete(action.actorID)
      return { ...state, followerActorIDs: Array.from(followers) }
    }
    case 'invitation.declined':
      return {
        ...state,
        declinedPresentationID: action.presentationID,
        acceptedPresentationID: state.acceptedPresentationID === action.presentationID ? null : state.acceptedPresentationID,
      }
    case 'actor.left':
      return {
        ...state,
        active: state.active?.actor.id === action.actorID ? null : state.active,
        followingActorID: state.followingActorID === action.actorID ? null : state.followingActorID,
        acceptedPresentationID: state.active?.actor.id === action.actorID ? null : state.acceptedPresentationID,
        declinedPresentationID: state.active?.actor.id === action.actorID ? null : state.declinedPresentationID,
        followerActorIDs: state.followerActorIDs.filter(id => id !== action.actorID),
      }
    case 'failure':
      return { ...state, starting: false, stopping: false, error: action.message }
    case 'error.cleared':
      return { ...state, error: null }
  }
}

function realtimeActor(value: unknown): WhiteboardRealtimeActor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const actor = value as Record<string, unknown>
  if (typeof actor.id !== 'string' || !actor.id || typeof actor.display_name !== 'string') return null
  return {
    id: actor.id,
    kind: typeof actor.kind === 'string' ? actor.kind : 'user',
    display_name: actor.display_name,
    access: typeof actor.access === 'string' ? actor.access : 'view',
  }
}

export function whiteboardPresentation(value: unknown): WhiteboardPresentation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const actor = realtimeActor(record.actor)
  if (typeof record.presentation_id !== 'string' || !record.presentation_id || !actor || typeof record.started_at !== 'string') return null
  return { presentation_id: record.presentation_id, actor, started_at: record.started_at }
}

export function whiteboardPresentationFromEvent(event: WhiteboardRealtimeEvent) {
  const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data)
    ? event.data as Record<string, unknown>
    : {}
  return whiteboardPresentation(data.presentation)
}

export function whiteboardPresentationStoppedID(event: WhiteboardRealtimeEvent) {
  const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data)
    ? event.data as Record<string, unknown>
    : {}
  return typeof data.presentation_id === 'string' ? data.presentation_id : null
}

export function whiteboardFollowChangeFromEvent(event: WhiteboardRealtimeEvent) {
  const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data)
    ? event.data as Record<string, unknown>
    : {}
  if (typeof data.target_actor_id !== 'string' || (data.action !== 'FOLLOW' && data.action !== 'UNFOLLOW') || !event.actor?.id) return null
  return { sourceActorID: event.actor.id, targetActorID: data.target_actor_id, action: data.action as 'FOLLOW' | 'UNFOLLOW' }
}

export function whiteboardViewportBoundsFromEvent(event: WhiteboardRealtimeEvent): WhiteboardViewportBounds | null {
  const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data)
    ? event.data as Record<string, unknown>
    : {}
  if (!Array.isArray(data.bounds) || data.bounds.length !== 4) return null
  const bounds = data.bounds.map(Number) as [number, number, number, number]
  if (bounds.some(value => !Number.isFinite(value) || Math.abs(value) > 1_000_000)) return null
  if (bounds[2] <= bounds[0] || bounds[3] <= bounds[1]) return null
  return bounds
}

export function whiteboardPresentationControlState(state: WhiteboardPresentationState): WhiteboardPresentationControlState {
  if (state.connection !== 'open' || !state.selfActorID) return 'disconnected'
  if (state.starting) return 'starting'
  if (state.error && (!state.active || state.active.actor.id === state.selfActorID)) return 'error'
  if (state.active?.actor.id === state.selfActorID) return 'active'
  if (state.active) return 'occupied'
  return 'available'
}

export function shouldShowWhiteboardPresentationInvitation(state: WhiteboardPresentationState) {
  const active = state.active
  return Boolean(
    active
    && state.selfActorID
    && active.actor.id !== state.selfActorID
    && state.declinedPresentationID !== active.presentation_id
    && state.acceptedPresentationID !== active.presentation_id
    && state.followingActorID !== active.actor.id,
  )
}
