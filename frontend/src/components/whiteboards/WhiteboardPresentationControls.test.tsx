import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WhiteboardPresentationState } from '@/lib/whiteboardPresentation'
import { WhiteboardPresentationButton, WhiteboardPresentationOverlay } from './WhiteboardPresentationControls'

const activeState: WhiteboardPresentationState = {
  connection: 'open',
  selfActorID: 'presenter-1',
  active: {
    presentation_id: 'presentation-1',
    actor: { id: 'presenter-1', kind: 'user', display_name: 'Ana', access: 'edit' },
    started_at: '2026-08-17T10:00:00Z',
  },
  starting: false,
  stopping: false,
  declinedPresentationID: null,
  acceptedPresentationID: null,
  followingActorID: null,
  followerActorIDs: ['viewer-1', 'viewer-2'],
  error: null,
}

describe('WhiteboardPresentationControls', () => {
  afterEach(cleanup)

  it('lets an editor finish and exposes the live follower count', () => {
    const onStop = vi.fn()
    render(<WhiteboardPresentationButton controlState="active" state={activeState} canPresent onStart={vi.fn()} onStop={onStop} />)
    fireEvent.click(screen.getByRole('button', { name: 'Finalizar presentación · 2 siguiendo' }))
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('does not expose presenting to a read-only participant', () => {
    const { container } = render(<WhiteboardPresentationButton controlState="available" state={{ ...activeState, active: null }} canPresent={false} onStart={vi.fn()} onStop={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('offers explicit consent and a separate leave action', () => {
    const onAccept = vi.fn()
    const onDecline = vi.fn()
    const onLeave = vi.fn()
    const viewerState = { ...activeState, selfActorID: 'viewer-1', followingActorID: null }
    const rendered = render(<WhiteboardPresentationOverlay state={viewerState} showInvitation onAccept={onAccept} onDecline={onDecline} onLeave={onLeave} />)
    fireEvent.click(screen.getByRole('button', { name: 'Seguir' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ahora no' }))
    expect(onAccept).toHaveBeenCalledTimes(1)
    expect(onDecline).toHaveBeenCalledTimes(1)

    rendered.rerender(<WhiteboardPresentationOverlay state={{ ...viewerState, followingActorID: 'presenter-1' }} showInvitation={false} onAccept={onAccept} onDecline={onDecline} onLeave={onLeave} />)
    fireEvent.click(screen.getByRole('button', { name: 'Dejar de seguir' }))
    expect(onLeave).toHaveBeenCalledTimes(1)
  })
})
