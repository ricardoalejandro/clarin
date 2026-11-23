import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ZoomableImageSurface from './ZoomableImageSurface'
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
describe('inline image surface', () => {
  it('keeps its owning window, exposes keyboard controls and resets a new resource', () => {
    const onLoad = vi.fn()
    const view = render(<div role="dialog"><ZoomableImageSurface src="/one.png" alt="Foto actual" onLoad={onLoad} /></div>)
    const dialog = screen.getByRole('dialog')
    fireEvent.load(screen.getByRole('img', { hidden: true }))
    expect(onLoad).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Acercar imagen' }))
    expect(screen.getByLabelText('Escala de imagen')).toHaveTextContent('125%')
    fireEvent.keyDown(screen.getByRole('region'), { key: '+' })
    expect(screen.getByLabelText('Escala de imagen')).toHaveTextContent('150%')
    view.rerender(<div role="dialog"><ZoomableImageSurface src="/two.png" alt="Foto actual" /></div>)
    expect(screen.getByRole('dialog')).toBe(dialog)
    expect(screen.getByLabelText('Escala de imagen')).toHaveTextContent('100%')
    expect(screen.getByText('Cargando imagen…')).toBeInTheDocument()
  })
  it('observes the replacement image after retry and releases the previous observer', () => {
    const observers: { observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = []
    class TestResizeObserver {
      observe = vi.fn()
      disconnect = vi.fn()
      constructor() { observers.push(this) }
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver)
    const view = render(<ZoomableImageSurface src="/retry.png" alt="Foto" />)
    const previousImage = screen.getByRole('img', { hidden: true })
    expect(observers).toHaveLength(1)
    expect(observers[0].observe.mock.calls.some(call => call[0] === previousImage)).toBe(true)
    fireEvent.error(previousImage)
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
    const replacementImage = screen.getByRole('img', { hidden: true })
    expect(replacementImage).not.toBe(previousImage)
    expect(observers).toHaveLength(2)
    expect(observers[0].disconnect).toHaveBeenCalledOnce()
    expect(observers[1].observe.mock.calls.some(call => call[0] === replacementImage)).toBe(true)
    expect(observers[1].observe.mock.calls.some(call => call[0] === previousImage)).toBe(false)
    view.unmount()
    expect(observers[1].disconnect).toHaveBeenCalledOnce()
  })
  it('reports an image error, supports an explicit retry and never changes a saved photo', () => {
    const onError = vi.fn()
    render(<ZoomableImageSurface src="/bad.png" alt="Foto" onError={onError} />)
    fireEvent.error(screen.getByRole('img', { hidden: true }))
    expect(onError).toHaveBeenCalledOnce()
    expect(screen.getByRole('alert')).toHaveTextContent('No se pudo cargar')
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
    fireEvent.load(screen.getByRole('img', { hidden: true }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Acercar imagen' })).toBeEnabled()
  })
})
