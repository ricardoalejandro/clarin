import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OfflineDataGateway } from '@/offline-v3/gateway'
import OfflineWhiteboardsView from './OfflineWhiteboardsView'

const renderScene = vi.hoisted(() => vi.fn())
vi.mock('@/offline-v3/whiteboardRender', () => ({ renderOfflineWhiteboard: renderScene }))
const board = { id: 'one', version: 1, name: 'Pizarra segura', updated_at: '2026-09-14', scene: { elements: [] } }
afterEach(() => { cleanup(); vi.restoreAllMocks(); renderScene.mockReset() })

describe('offline whiteboard view session', () => {
  it('renders an inert image with zoom and destroys its object URL on close', async () => {
    const revoke = vi.fn(); Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:private-board') }); Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke })
    renderScene.mockResolvedValue(new Blob(['svg']))
    const gateway = { whiteboardScene: vi.fn().mockResolvedValue({ item: board }) } as unknown as OfflineDataGateway
    const view = render(<OfflineWhiteboardsView gateway={gateway} whiteboardId="one" navigate={vi.fn()} />)
    expect(await screen.findByRole('img', { name: /Pizarra segura/ })).toHaveAttribute('src', 'blob:private-board')
    fireEvent.click(screen.getByRole('button', { name: 'Acercar pizarra' })); expect(screen.getByLabelText('Ampliación')).toHaveTextContent('200%')
    fireEvent.click(screen.getByRole('button', { name: 'Ajustar' })); expect(screen.getByLabelText('Ampliación')).toHaveTextContent('100%')
    const signal = renderScene.mock.calls[0][1] as AbortSignal
    view.unmount(); expect(signal.aborted).toBe(true); expect(revoke).toHaveBeenCalledWith('blob:private-board')
  })
  it('does not render a previous board or account after a late response', async () => {
    let resolveOld!: (value: unknown) => void
    const oldGateway = { whiteboardScene: vi.fn(() => new Promise(resolve => { resolveOld = resolve })) } as unknown as OfflineDataGateway
    const nextGateway = { whiteboardScene: vi.fn().mockRejectedValue(new Error('Acceso bloqueado')) } as unknown as OfflineDataGateway
    const view = render(<OfflineWhiteboardsView gateway={oldGateway} whiteboardId="one" navigate={vi.fn()} />)
    view.rerender(<OfflineWhiteboardsView gateway={nextGateway} whiteboardId="two" navigate={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Acceso bloqueado')
    resolveOld({ item: board }); await waitFor(() => expect(renderScene).not.toHaveBeenCalled())
    expect(screen.queryByText('Pizarra segura')).not.toBeInTheDocument()
  })
})
