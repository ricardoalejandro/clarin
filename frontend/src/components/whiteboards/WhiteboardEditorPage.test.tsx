import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WhiteboardEditorPage from '@/app/dashboard/whiteboards/[id]/page'

const route = vi.hoisted(() => ({ params: {} as { id?: string }, pathname: '/dashboard/whiteboards', opened: [] as string[] }))
vi.mock('next/navigation', () => ({ useParams: () => route.params, usePathname: () => route.pathname }))
vi.mock('next/dynamic', () => ({ default: () => ({ boardID }: { boardID: string }) => {
  route.opened.push(boardID)
  return <div data-testid="canonical-whiteboard-editor">{boardID}</div>
} }))

afterEach(() => { cleanup(); route.params = {}; route.pathname = '/dashboard/whiteboards'; route.opened = []; window.history.replaceState({}, '', '/') })

describe('canonical whiteboard route with the prepared static shell', () => {
  const id = '80000000-0000-4000-8000-000000000014'
  it('waits for an identity and reacts to the destination before the address bar commits', () => {
    window.history.replaceState({}, '', '/dashboard/whiteboards')
    const { rerender } = render(<WhiteboardEditorPage />)
    expect(route.opened).toEqual([])
    route.pathname = `/dashboard/whiteboards/${id}`
    rerender(<WhiteboardEditorPage />)
    expect(screen.getByTestId('canonical-whiteboard-editor').textContent).toBe(id)
    expect(route.opened.every(Boolean)).toBe(true)
  })
  it('recovers the committed canonical URL when the cached shell has no dynamic params', () => {
    route.pathname = '/dashboard/offline-v5-whiteboard'
    window.history.replaceState({}, '', `/dashboard/whiteboards/${id}`)
    render(<WhiteboardEditorPage />)
    expect(screen.getByTestId('canonical-whiteboard-editor').textContent).toBe(id)
    expect(route.opened.every(Boolean)).toBe(true)
  })
  it('preserves a normal dynamic parameter', () => {
    route.params = { id }
    render(<WhiteboardEditorPage />)
    expect(screen.getByTestId('canonical-whiteboard-editor').textContent).toBe(id)
  })
})
