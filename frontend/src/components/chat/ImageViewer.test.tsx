import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ImageViewer from './ImageViewer'
import { StrictMode } from 'react'

beforeEach(() => {
  window.history.replaceState({ preserved: 'chat-route', __clarinMessageSelection: true }, '')
  vi.spyOn(window.history, 'back').mockImplementation(() => {})
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('image viewer', () => {
  it('shows loading, exposes a manual retry and resets the failure on a different source', () => {
    const { rerender } = render(<ImageViewer src="/first.jpg" isOpen onClose={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent('Cargando imagen')
    fireEvent.error(screen.getByRole('img'))
    expect(screen.getByRole('alert')).toHaveTextContent('No se pudo cargar')
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar imagen' }))
    fireEvent.load(screen.getByRole('img'))
    expect(screen.getByRole('button', { name: 'Descargar imagen' })).toBeEnabled()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    rerender(<ImageViewer src="/second.jpg" isOpen onClose={vi.fn()} />)
    expect(screen.getByRole('img')).toHaveAttribute('src', '/second.jpg')
    expect(screen.getByRole('status')).toHaveTextContent('Cargando imagen')
  })
  it('bounds slow loading and never starts an automatic retry', () => {
    vi.useFakeTimers()
    render(<ImageViewer src="/slow.jpg" isOpen onClose={vi.fn()} />)
    act(() => vi.advanceTimersByTime(30_000))
    expect(screen.getByRole('alert')).toHaveTextContent('No se pudo cargar')
    act(() => vi.advanceTimersByTime(60_000))
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })
  it('owns one Android Back entry while retaining other history state', async () => {
    const onClose = vi.fn()
    render(<ImageViewer src="/photo.jpg" isOpen onClose={onClose} />)
    await waitFor(() => expect(window.history.state).toMatchObject({ preserved: 'chat-route', __clarinMessageSelection: true, __clarinImageViewer: expect.any(String) }))
    const prior = { preserved: 'chat-route', __clarinMessageSelection: true }
    window.history.replaceState(prior, '')
    fireEvent.popState(window, { state: prior })
    expect(onClose).toHaveBeenCalledOnce()
    expect(window.history.back).not.toHaveBeenCalled()
  })
  it('closes explicitly without duplicating the Back close', async () => {
    const onClose = vi.fn()
    render(<ImageViewer src="/photo.jpg" isOpen onClose={onClose} />)
    await waitFor(() => expect(window.history.state.__clarinImageViewer).toEqual(expect.any(String)))
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar visor' }))
    expect(window.history.back).toHaveBeenCalledOnce()
    fireEvent.popState(window, { state: {} })
    expect(onClose).toHaveBeenCalledOnce()
  })
  it('creates only one Back entry during StrictMode mount replay', async () => {
    const push = vi.spyOn(window.history, 'pushState')
    render(<StrictMode><ImageViewer src="/photo.jpg" isOpen onClose={vi.fn()} /></StrictMode>)
    await waitFor(() => expect(push).toHaveBeenCalledOnce())
    expect(window.history.back).not.toHaveBeenCalled()
  })
  it('traps keyboard focus, consumes Escape, and restores the invoking control', async () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()
    const onClose = vi.fn()
    const { unmount } = render(<ImageViewer src="/photo.jpg" isOpen onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveFocus())
    fireEvent.load(screen.getByRole('img'))
    const controls = within(screen.getByRole('dialog')).getAllByRole('button').filter(button => !button.hasAttribute('disabled'))
    controls.at(-1)!.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(controls[0]).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
    unmount()
    expect(trigger).toHaveFocus()
    trigger.remove()
  })
})
