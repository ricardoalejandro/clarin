import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ChatMessageMedia from './ChatMessageMedia'
import { StrictMode } from 'react'

let callbacks: IntersectionObserverCallback[]
let disconnect: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  callbacks = []
  disconnect = vi.fn()
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { callbacks.push(callback) }
    observe = vi.fn()
    unobserve = vi.fn()
    disconnect = disconnect
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('chat media lifecycle', () => {
  it('preserves the attached audio source during StrictMode replay', () => {
    const { container, unmount } = render(<StrictMode><ChatMessageMedia src="/voice.ogg" kind="audio" /></StrictMode>)
    const audio = container.querySelector('audio')!
    expect(audio).toHaveAttribute('src', '/voice.ogg')
    expect(audio.load).not.toHaveBeenCalled()
    unmount()
    expect(audio.pause).toHaveBeenCalledOnce()
    expect(audio.load).toHaveBeenCalledOnce()
  })
  it.each(['video', 'gif'] as const)('defers %s until near the viewport and retains the playing source afterward', kind => {
    const { container, rerender, unmount } = render(<ChatMessageMedia src="/video.mp4" kind={kind} />)
    expect(container.querySelector('video')).toBeNull()
    act(() => callbacks[0]([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
    const video = container.querySelector('video')!
    fireEvent.play(video)
    act(() => callbacks[0]([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver))
    rerender(<ChatMessageMedia src="/video.mp4" kind={kind} />)
    expect(container.querySelector('video')).toBe(video)
    expect(video).toHaveAttribute('src', '/video.mp4')
    expect(video.pause).not.toHaveBeenCalled()
    expect(disconnect).toHaveBeenCalled()
    unmount()
    expect(video.pause).toHaveBeenCalledOnce()
    expect(video).not.toHaveAttribute('src')
  })
  it('keeps the original GIF deferred too', () => {
    const { container } = render(<ChatMessageMedia src="/animation.gif" kind="gif" originalGIF />)
    expect(container.querySelector('img')).toBeNull()
    act(() => callbacks[0]([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
    expect(screen.getByAltText('GIF')).toHaveAttribute('src', '/animation.gif')
  })
  it.each(['video', 'audio', 'image', 'gif'] as const)('requires a manual retry after a %s failure', kind => {
    const { container } = render(<ChatMessageMedia src="/media" kind={kind} />)
    if (callbacks.length) act(() => callbacks[0]([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
    const original = container.querySelector('img, video, audio')!
    fireEvent.error(original)
    expect(container.querySelector('img, video, audio')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('No se pudo cargar')
    fireEvent.click(screen.getByRole('button', { name: /Reintentar cargar/ }))
    expect(container.querySelector('img, video, audio')).not.toBe(original)
    expect(container.querySelector('img, video, audio')).toHaveAttribute('src', '/media')
  })
  it('opens images with the keyboard without bubbling selection and keeps audio unloaded until playback', () => {
    const onOpen = vi.fn()
    const onParentKey = vi.fn()
    const { container } = render(<div onKeyDown={onParentKey}><ChatMessageMedia src="/photo.jpg" kind="image" onOpen={onOpen} /><ChatMessageMedia src="/audio.ogg" kind="audio" /></div>)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Abrir imagen' }), { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledOnce()
    expect(onParentKey).not.toHaveBeenCalled()
    expect(container.querySelector('audio')).toHaveAttribute('preload', 'none')
  })
  it('offers no impossible retry for an unsupported empty URL', () => {
    render(<ChatMessageMedia src="" kind="video" />)
    expect(screen.queryByRole('button', { name: /Reintentar/ })).not.toBeInTheDocument()
  })
})
