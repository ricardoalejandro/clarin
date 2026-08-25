import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps, ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@excalidraw/excalidraw', () => {
  const Excalidraw = () => null
  const MainMenu = ({ children }: { children?: ReactNode }) => <>{children}</>
  MainMenu.Group = ({ children }: { children?: ReactNode }) => <>{children}</>
  MainMenu.Item = ({ children, ...props }: ComponentProps<'button'>) => <button {...props}>{children}</button>
  return {
    CaptureUpdateAction: { NEVER: 'never' },
    Excalidraw,
    MainMenu,
    getVisibleSceneBounds: vi.fn(),
    reconcileElements: vi.fn(),
    serializeAsJSON: vi.fn(),
  }
})

vi.mock('@/hooks/useWhiteboardAssetHydration', () => ({
  useWhiteboardAssetHydration: () => ({
    progress: { phase: 'idle', completed: 0, total: 0 },
    request: vi.fn(),
    retry: vi.fn(),
  }),
  whiteboardAssetHydrationMessage: () => null,
}))

vi.mock('@/hooks/useWhiteboardPresentation', () => ({
  useWhiteboardPresentation: () => ({
    controlState: 'unavailable',
    state: {},
    showInvitation: false,
    handleConnectionChange: vi.fn(),
    handleRealtimeEvent: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    acceptInvitation: vi.fn(),
    declineInvitation: vi.fn(),
    leaveFollow: vi.fn(),
  }),
}))

import GuestWhiteboardEditor from './GuestWhiteboardEditor'

describe('GuestWhiteboardEditor access form', () => {
  afterEach(() => {
    cleanup()
    window.history.replaceState({}, '', '/')
  })

  it('keeps guest-entered credentials readable on the dark form', async () => {
    window.history.replaceState({}, '', '/shared/whiteboards/board-1#secret')
    render(<GuestWhiteboardEditor shareLinkID="board-1" />)

    await waitFor(() => expect(document.querySelector('form')).not.toBeNull())
    const name = screen.getByRole('textbox')
    expect(name).toHaveClass('dark-input')
    fireEvent.change(name, { target: { value: 'Marta' } })
    expect(name).toHaveValue('Marta')

    const password = screen.getByLabelText('Contraseña, si fue configurada')
    expect(password).toHaveClass('dark-input')
    fireEvent.change(password, { target: { value: 'secreto' } })
    expect(password).toHaveValue('secreto')
  })
})
