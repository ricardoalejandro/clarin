import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { ComponentProps, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'

const apiMocks = vi.hoisted(() => ({
  listWhiteboardCommentThreads: vi.fn(),
  listWhiteboardCommentMarkers: vi.fn(),
}))

vi.mock('@/lib/whiteboardCommentsApi', () => ({
  ...apiMocks,
}))

vi.mock('@excalidraw/excalidraw', () => {
  const DefaultSidebar = ({ children }: { children?: ReactNode }) => <aside>{children}</aside>
  DefaultSidebar.TabTriggers = ({ children }: { children?: ReactNode }) => <div>{children}</div>
  const Sidebar = {
    TabTrigger: ({ children, ...props }: ComponentProps<'button'> & { tab?: string }) => <button type="button" {...props}>{children}</button>,
    Tab: ({ children }: { children?: ReactNode; tab?: string; className?: string }) => <div>{children}</div>,
  }
  return {
    DefaultSidebar,
    Sidebar,
    getCommonBounds: () => [0, 0, 0, 0],
    viewportCoordsToSceneCoords: ({ clientX, clientY }: { clientX: number; clientY: number }) => ({ x: clientX, y: clientY }),
  }
})

import {
  WhiteboardCommentsProvider,
  WhiteboardCommentsSidebar,
  WhiteboardSidebarActions,
  whiteboardSidebarKeyboardToggle,
  whiteboardSidebarIsActive,
  whiteboardSidebarToggle,
} from './WhiteboardComments'

function editorAPI(openSidebar: { name: string; tab?: string } | null = null) {
  return {
    getAppState: vi.fn(() => ({ openSidebar })),
    toggleSidebar: vi.fn(),
  } as unknown as ExcalidrawImperativeAPI
}

describe('WhiteboardCommentsSidebar triggers', () => {
  afterEach(cleanup)

  beforeEach(() => {
    apiMocks.listWhiteboardCommentThreads.mockReset().mockResolvedValue({
      success: true,
      data: {
        success: true,
        threads: [],
        next_cursor: null,
        counts: { open: 12, resolved: 4, all: 16 },
      },
    })
    apiMocks.listWhiteboardCommentMarkers.mockReset().mockResolvedValue({
      success: true,
      data: { success: true, markers: [], next_cursor: null },
    })
  })

  it('owns exactly one external Biblioteca action and one canonical Comentarios action', async () => {
    const api = editorAPI()
    render(<WhiteboardCommentsProvider boardID="board-1" currentUserID="user-1" canComment editorAPI={api}>
      <WhiteboardSidebarActions editorAPI={api} openSidebar={null} />
      <WhiteboardCommentsSidebar />
    </WhiteboardCommentsProvider>)

    expect(document.querySelectorAll('[data-whiteboard-sidebar-action="library"]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-whiteboard-sidebar-action="comments"]')).toHaveLength(1)
    const comments = document.querySelector<HTMLButtonElement>('[data-whiteboard-sidebar-action="comments"]')
    await waitFor(() => expect(comments).toHaveAttribute(
      'aria-label',
      'Comentarios · 12 abiertos',
    ))
  })

  it('selects each DefaultSidebar tab in one click and marks only the exact tab active', () => {
    const api = editorAPI({ name: 'default', tab: 'library' })
    render(<WhiteboardCommentsProvider boardID="board-1" currentUserID="user-1" canComment editorAPI={api}>
      <WhiteboardSidebarActions editorAPI={api} openSidebar={{ name: 'default', tab: 'library' }} />
    </WhiteboardCommentsProvider>)

    const library = document.querySelector<HTMLButtonElement>('[data-whiteboard-sidebar-action="library"]')
    const comments = document.querySelector<HTMLButtonElement>('[data-whiteboard-sidebar-action="comments"]')
    expect(library).not.toBeNull()
    expect(comments).not.toBeNull()
    expect(library).toHaveAttribute('aria-pressed', 'true')
    expect(comments).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(comments!)
    expect(api.toggleSidebar).toHaveBeenCalledWith({ name: 'default', tab: 'comments', force: true })
    expect(whiteboardSidebarIsActive({ name: 'default', tab: 'library' }, 'comments')).toBe(false)
    expect(whiteboardSidebarIsActive({ name: 'default', tab: 'comments' }, 'comments')).toBe(true)
    expect(whiteboardSidebarToggle('comments', { name: 'default', tab: 'comments' })).toEqual({
      name: 'default', tab: 'comments', force: false,
    })
  })

  it('maps Space and Enter to the focused canonical sidebar action without repeats', () => {
    expect(whiteboardSidebarKeyboardToggle({
      key: ' ', repeat: false, tab: 'comments', openSidebar: null,
    })).toEqual({ name: 'default', tab: 'comments', force: true })
    expect(whiteboardSidebarKeyboardToggle({
      key: 'Enter', repeat: false, tab: 'comments', openSidebar: { name: 'default', tab: 'comments' },
    })).toEqual({ name: 'default', tab: 'comments', force: false })
    expect(whiteboardSidebarKeyboardToggle({
      key: 'Enter', repeat: false, tab: 'library', openSidebar: null,
    })).toEqual({ name: 'default', tab: 'library', force: true })
    expect(whiteboardSidebarKeyboardToggle({
      key: ' ', repeat: true, tab: 'library', openSidebar: null,
    })).toBeNull()
    expect(whiteboardSidebarKeyboardToggle({
      key: 'Escape', repeat: false, tab: 'comments', openSidebar: null,
    })).toBeNull()
  })
})
