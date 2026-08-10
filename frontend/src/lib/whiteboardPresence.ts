import type { Collaborator, SocketId } from '@excalidraw/excalidraw/types'
import type { WhiteboardCollaboratorState } from './whiteboards'

const CURSOR_COLORS = [
  { background: '#d1fae5', stroke: '#047857' },
  { background: '#dbeafe', stroke: '#1d4ed8' },
  { background: '#fef3c7', stroke: '#b45309' },
  { background: '#fce7f3', stroke: '#be185d' },
  { background: '#ede9fe', stroke: '#6d28d9' },
  { background: '#cffafe', stroke: '#0e7490' },
] as const

function cursorColor(id: string) {
  let hash = 0
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) | 0
  return CURSOR_COLORS[Math.abs(hash) % CURSOR_COLORS.length]
}

export function excalidrawWhiteboardCollaborators(states: ReadonlyMap<string, WhiteboardCollaboratorState>) {
  const collaborators = new Map<SocketId, Collaborator>()
  states.forEach((state, id) => {
    const socketID = id as SocketId
    collaborators.set(socketID, {
      id,
      socketId: socketID,
      username: state.username,
      pointer: state.pointer,
      button: state.button,
      color: cursorColor(id),
    })
  })
  return collaborators
}
