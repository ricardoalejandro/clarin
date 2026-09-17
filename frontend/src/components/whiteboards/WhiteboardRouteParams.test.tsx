import { cleanup, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WhiteboardEditorPage from '@/app/dashboard/whiteboards/[id]/page'
import SharedWhiteboardPage from '@/app/shared/whiteboards/[id]/page'

const route = vi.hoisted(() => ({ id: 'first-board' }))

vi.mock('next/navigation', () => ({ useParams: () => route }))
vi.mock('next/dynamic', () => ({
  default: () => function EditorProbe({ boardID, shareLinkID }: { boardID?: string; shareLinkID?: string }) {
    const id = boardID ?? shareLinkID
    const [mountedID] = useState(id)
    return <div data-testid="editor" data-id={id} data-mounted-id={mountedID} />
  },
}))

afterEach(() => {
  cleanup()
  route.id = 'first-board'
})

describe('whiteboard route parameters', () => {
  it('reads the authenticated board from the current App Router parameters on navigation', () => {
    const { rerender } = render(<WhiteboardEditorPage />)
    expect(screen.getByTestId('editor')).toHaveAttribute('data-id', 'first-board')

    route.id = 'next-board'
    rerender(<WhiteboardEditorPage />)
    expect(screen.getByTestId('editor')).toHaveAttribute('data-id', 'next-board')
  })

  it('reads the share link from the router and remounts the guest editor for a different link', () => {
    const { rerender } = render(<SharedWhiteboardPage />)
    expect(screen.getByTestId('editor')).toHaveAttribute('data-id', 'first-board')
    expect(screen.getByTestId('editor')).toHaveAttribute('data-mounted-id', 'first-board')

    route.id = 'different-share'
    rerender(<SharedWhiteboardPage />)
    expect(screen.getByTestId('editor')).toHaveAttribute('data-id', 'different-share')
    expect(screen.getByTestId('editor')).toHaveAttribute('data-mounted-id', 'different-share')
  })
})
