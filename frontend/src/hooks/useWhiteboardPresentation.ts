'use client'

import { useCallback, useEffect, useMemo, useReducer, useRef, type MutableRefObject } from 'react'
import {
  CaptureUpdateAction,
  getVisibleSceneBounds,
  zoomToFitBounds,
} from '@excalidraw/excalidraw'
import type { AppState, ExcalidrawImperativeAPI, UserToFollow } from '@excalidraw/excalidraw/types'
import type { WhiteboardRealtimeEvent, WhiteboardRealtimeActor } from '@/lib/whiteboards'
import type { WhiteboardRealtimeRoom, WhiteboardRoomConnectionState } from '@/lib/whiteboardsApi'
import {
  initialWhiteboardPresentationState,
  shouldShowWhiteboardPresentationInvitation,
  whiteboardFollowChangeFromEvent,
  whiteboardPresentationControlState,
  whiteboardPresentationFromEvent,
  whiteboardPresentationReducer,
  whiteboardPresentationStoppedID,
  whiteboardViewportBoundsFromEvent,
} from '@/lib/whiteboardPresentation'

interface UseWhiteboardPresentationInput {
  editorAPI: ExcalidrawImperativeAPI | null
  roomRef: MutableRefObject<WhiteboardRealtimeRoom | null>
  canPresent: boolean
  runWithTransientSceneSuppressed: (update: () => void) => void
}

export function useWhiteboardPresentation({
  editorAPI,
  roomRef,
  canPresent,
  runWithTransientSceneSuppressed,
}: UseWhiteboardPresentationInput) {
  const [state, dispatch] = useReducer(whiteboardPresentationReducer, initialWhiteboardPresentationState)
  const stateRef = useRef(state)
  const selfActorIDRef = useRef<string | null>(null)
  const skipFollowBroadcastRef = useRef<{ actorID: string; action: 'FOLLOW' | 'UNFOLLOW' } | null>(null)

  useEffect(() => { stateRef.current = state }, [state])

  const sendCurrentViewport = useCallback(() => {
    const api = editorAPI
    if (!api || api.getAppState().followedBy.size === 0) return false
    return roomRef.current?.sendViewport(getVisibleSceneBounds(api.getAppState())) || false
  }, [editorAPI, roomRef])

  const setEditorFollowing = useCallback((actor: WhiteboardRealtimeActor | null, broadcast = true, preserveAcceptance = false) => {
    if (!editorAPI) return
    const current = editorAPI.getAppState().userToFollow
    if (!actor && current && !broadcast) {
      skipFollowBroadcastRef.current = { actorID: current.socketId, action: 'UNFOLLOW' }
    }
    dispatch({ type: 'follow.local', actorID: actor?.id || null, preserveAcceptance })
    runWithTransientSceneSuppressed(() => {
      editorAPI.updateScene({
        appState: {
          userToFollow: actor ? { socketId: actor.id, username: actor.display_name } as UserToFollow : null,
        } as AppState,
        captureUpdate: CaptureUpdateAction.NEVER,
      })
    })
  }, [editorAPI, runWithTransientSceneSuppressed])

  const handleConnectionChange = useCallback((connection: WhiteboardRoomConnectionState) => {
    if (connection !== 'open') selfActorIDRef.current = null
    if (connection !== 'open' && editorAPI) {
      const current = editorAPI.getAppState().userToFollow
      if (current) skipFollowBroadcastRef.current = { actorID: current.socketId, action: 'UNFOLLOW' }
      runWithTransientSceneSuppressed(() => {
        editorAPI.updateScene({
          appState: { userToFollow: null, followedBy: new Set() } as AppState,
          captureUpdate: CaptureUpdateAction.NEVER,
        })
      })
    }
    dispatch({ type: 'connection', connection })
  }, [editorAPI, runWithTransientSceneSuppressed])

  const handleRealtimeEvent = useCallback((event: WhiteboardRealtimeEvent) => {
    if (event.event === 'room.ready') {
      const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data)
        ? event.data as Record<string, unknown>
        : {}
      const actorID = event.actor?.id || (typeof data.actor_id === 'string' ? data.actor_id : '')
      if (actorID) {
        selfActorIDRef.current = actorID
        dispatch({ type: 'room.ready', actorID })
      }
      return true
    }
    if (event.event === 'presentation.snapshot') {
      const previous = stateRef.current.active
      const presentation = whiteboardPresentationFromEvent(event)
      if (!presentation && previous && stateRef.current.followingActorID === previous.actor.id) {
        setEditorFollowing(null, false)
      }
      dispatch({ type: 'snapshot', presentation })
      return true
    }
    if (event.event === 'presentation.changed') {
      const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data)
        ? event.data as Record<string, unknown>
        : {}
      if (data.status === 'started') {
        const presentation = whiteboardPresentationFromEvent(event)
        if (presentation) dispatch({ type: 'presentation.started', presentation })
      } else if (data.status === 'stopped') {
        const presentationID = whiteboardPresentationStoppedID(event)
        const active = stateRef.current.active
        if (presentationID && active?.presentation_id === presentationID && stateRef.current.followingActorID === active.actor.id) {
          setEditorFollowing(null, false)
        }
        if (presentationID) dispatch({ type: 'presentation.stopped', presentationID })
      }
      return true
    }
    if (event.event === 'follow.change') {
      const change = whiteboardFollowChangeFromEvent(event)
      const selfActorID = stateRef.current.selfActorID
      if (!change || !selfActorID || change.targetActorID !== selfActorID || !editorAPI) return true
      const followedBy = new Set(editorAPI.getAppState().followedBy)
      if (change.action === 'FOLLOW') followedBy.add(change.sourceActorID as never)
      else followedBy.delete(change.sourceActorID as never)
      runWithTransientSceneSuppressed(() => {
        editorAPI.updateScene({
          appState: { followedBy } as AppState,
          captureUpdate: CaptureUpdateAction.NEVER,
        })
      })
      dispatch({ type: 'follow.remote', actorID: change.sourceActorID, action: change.action })
      if (change.action === 'FOLLOW') requestAnimationFrame(() => { sendCurrentViewport() })
      return true
    }
    if (event.event === 'viewport.update') {
      const bounds = whiteboardViewportBoundsFromEvent(event)
      const sourceActorID = event.actor?.id
      if (!bounds || !sourceActorID || !editorAPI) return true
      const appState = editorAPI.getAppState()
      if (appState.userToFollow?.socketId !== sourceActorID || appState.followedBy.has(sourceActorID as never)) return true
      const next = zoomToFitBounds({ bounds, appState, fitToViewport: true, viewportZoomFactor: 1 }).appState
      runWithTransientSceneSuppressed(() => {
        editorAPI.updateScene({ appState: next, captureUpdate: CaptureUpdateAction.NEVER })
      })
      return true
    }
    if (event.event === 'presence.update' && event.actor?.id) {
      const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data)
        ? event.data as Record<string, unknown>
        : {}
      if (data.status === 'left') {
        if (stateRef.current.followingActorID === event.actor.id) setEditorFollowing(null, false)
        dispatch({ type: 'actor.left', actorID: event.actor.id })
      }
      return false
    }
	if (event.event === 'presence.snapshot') {
	  const presentActorIDs = new Set(Array.isArray(event.data)
		? event.data.flatMap(value => value && typeof value === 'object' && !Array.isArray(value) && typeof (value as Record<string, unknown>).id === 'string'
		  ? [String((value as Record<string, unknown>).id)]
		  : [])
		: [])
	  const activeActorID = stateRef.current.active?.actor.id
	  if (activeActorID && !presentActorIDs.has(activeActorID)) {
		if (stateRef.current.followingActorID === activeActorID) setEditorFollowing(null, false)
		dispatch({ type: 'actor.left', actorID: activeActorID })
	  }
	  return false
	}
	if (event.event === 'error' && event.code === 'follow_target_unavailable') return true
    if (event.event === 'error' && event.code?.startsWith('presentation_')) {
      dispatch({ type: 'failure', message: event.error || 'No se pudo actualizar la presentación.' })
      return true
    }
    return false
  }, [editorAPI, runWithTransientSceneSuppressed, sendCurrentViewport, setEditorFollowing])

  useEffect(() => {
    if (!editorAPI) return
    const unsubscribeFollow = editorAPI.onUserFollow(payload => {
      const actorID = payload.userToFollow.socketId
      const skipped = skipFollowBroadcastRef.current
      if (skipped?.actorID === actorID && skipped.action === payload.action) {
        skipFollowBroadcastRef.current = null
        return
      }
      if (actorID === selfActorIDRef.current) {
        if (payload.action === 'FOLLOW') setEditorFollowing(null, false)
        return
      }
      const current = stateRef.current
      if (payload.action === 'FOLLOW' && current.active?.actor.id === current.selfActorID) {
        setEditorFollowing(null, false)
        return
      }
      roomRef.current?.sendFollow(actorID, payload.action)
      dispatch({ type: 'follow.local', actorID: payload.action === 'FOLLOW' ? actorID : null })
    })
    const unsubscribeScroll = editorAPI.onScrollChange(() => { sendCurrentViewport() })
    return () => {
      unsubscribeFollow()
      unsubscribeScroll()
    }
  }, [editorAPI, roomRef, sendCurrentViewport, setEditorFollowing])

  useEffect(() => {
    if (!editorAPI || !state.active || state.acceptedPresentationID !== state.active.presentation_id || state.followingActorID === state.active.actor.id) return
    setEditorFollowing(state.active.actor, true, true)
  }, [editorAPI, setEditorFollowing, state.acceptedPresentationID, state.active, state.followingActorID])

  useEffect(() => {
    if (!editorAPI) return
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && editorAPI.getAppState().userToFollow) setEditorFollowing(null)
    }
    document.addEventListener('keydown', onEscape, true)
    return () => document.removeEventListener('keydown', onEscape, true)
  }, [editorAPI, setEditorFollowing])

  const start = useCallback(async () => {
    const room = roomRef.current
    if (!canPresent || !room?.isOpen() || stateRef.current.active || stateRef.current.starting) return
    if (editorAPI?.getAppState().userToFollow) setEditorFollowing(null)
    dispatch({ type: 'start.requested' })
    try {
      const pending = room.startPresentation()
      if (!pending) throw new Error('La sala de colaboración está desconectada.')
      const acknowledgement = await pending
      const presentation = whiteboardPresentationFromEvent(acknowledgement)
      if (!presentation) throw new Error('Clarin devolvió una confirmación de presentación incompleta.')
      dispatch({ type: 'presentation.started', presentation })
    } catch (startError) {
      dispatch({ type: 'failure', message: startError instanceof Error ? startError.message : 'No se pudo iniciar la presentación.' })
    }
  }, [canPresent, editorAPI, roomRef, setEditorFollowing])

  const stop = useCallback(async () => {
    const presentation = stateRef.current.active
    const room = roomRef.current
    if (!presentation || presentation.actor.id !== stateRef.current.selfActorID || stateRef.current.stopping) return
    dispatch({ type: 'stop.requested' })
    try {
      const pending = room?.stopPresentation(presentation.presentation_id)
      if (!pending) throw new Error('La sala de colaboración está desconectada.')
      await pending
      dispatch({ type: 'presentation.stopped', presentationID: presentation.presentation_id })
    } catch (stopError) {
      dispatch({ type: 'failure', message: stopError instanceof Error ? stopError.message : 'No se pudo finalizar la presentación.' })
    }
  }, [roomRef])

  const acceptInvitation = useCallback(() => {
    const presentation = stateRef.current.active
    if (!presentation || presentation.actor.id === stateRef.current.selfActorID) return
    setEditorFollowing(presentation.actor)
  }, [setEditorFollowing])

  const declineInvitation = useCallback(() => {
    const presentation = stateRef.current.active
    if (presentation) dispatch({ type: 'invitation.declined', presentationID: presentation.presentation_id })
  }, [])

  const leaveFollow = useCallback(() => setEditorFollowing(null), [setEditorFollowing])
  const getSelfActorID = useCallback(() => selfActorIDRef.current, [])

  return useMemo(() => ({
    state,
    controlState: whiteboardPresentationControlState(state),
    showInvitation: shouldShowWhiteboardPresentationInvitation(state),
    start,
    stop,
    acceptInvitation,
    declineInvitation,
    leaveFollow,
    clearError: () => dispatch({ type: 'error.cleared' }),
    handleRealtimeEvent,
    handleConnectionChange,
    getSelfActorID,
  }), [acceptInvitation, declineInvitation, getSelfActorID, handleConnectionChange, handleRealtimeEvent, leaveFollow, start, state, stop])
}
