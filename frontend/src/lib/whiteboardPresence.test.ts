import { describe, expect, it } from 'vitest'
import type { WhiteboardCollaboratorState } from './whiteboards'
import { excalidrawWhiteboardCollaborators } from './whiteboardPresence'

function collaboratorsFixture() {
  return new Map<string, WhiteboardCollaboratorState>([
    ['actor-local', { id: 'actor-local', username: 'Luis' }],
    ['actor-remote', { id: 'actor-remote', username: 'Ana' }],
  ])
}

describe('excalidrawWhiteboardCollaborators', () => {
  it('holds an early presence snapshot until room.ready identifies the local actor', () => {
    const early = excalidrawWhiteboardCollaborators(collaboratorsFixture(), null)
    expect(early.size).toBe(0)

    const ready = excalidrawWhiteboardCollaborators(collaboratorsFixture(), 'actor-local')
    expect(ready.size).toBe(2)
    expect(Array.from(ready.values()).filter(collaborator => collaborator.isCurrentUser)).toHaveLength(1)
    expect(ready.get('actor-local' as never)?.isCurrentUser).toBe(true)
  })

  it('marks exactly the room actor as the current user across reconnections', () => {
    const initial = excalidrawWhiteboardCollaborators(collaboratorsFixture(), 'actor-local')
    expect(initial.get('actor-local' as never)?.isCurrentUser).toBe(true)
    expect(initial.get('actor-remote' as never)?.isCurrentUser).toBe(false)

    const reconnected = excalidrawWhiteboardCollaborators(collaboratorsFixture(), 'actor-remote')
    expect(reconnected.get('actor-local' as never)?.isCurrentUser).toBe(false)
    expect(reconnected.get('actor-remote' as never)?.isCurrentUser).toBe(true)
  })
})
