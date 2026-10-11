'use client'

import { useEffect, useRef, useState } from 'react'
import { AlertCircle, RefreshCw } from 'lucide-react'

interface Props {
  src: string
  kind: 'image' | 'video' | 'gif' | 'audio'
  originalGIF?: boolean
  onOpen?: () => void
}

// Once activated, a player retains its source while scrolling. In particular,
// moving an already playing video outside the viewport must not interrupt it.
export default function ChatMessageMedia({ src, kind, originalGIF, onOpen }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const playerRef = useRef<HTMLMediaElement>(null)
  const [activated, setActivated] = useState(kind === 'image' || kind === 'audio')
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const isImage = kind === 'image' || (kind === 'gif' && originalGIF)
  const label = kind === 'audio' ? 'audio' : kind === 'image' ? 'imagen' : kind === 'gif' ? 'GIF' : 'video'

  useEffect(() => {
    if (activated) return
    const node = containerRef.current
    if (!node) return
    if (typeof IntersectionObserver === 'undefined') {
      setActivated(true)
      return
    }
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return
      setActivated(true)
      observer.disconnect()
    }, { rootMargin: '240px 0px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [activated])

  useEffect(() => {
    const player = playerRef.current
    if (!player) return
    return () => {
      // Leave active playback alone on scroll; release it when its message or
      // source disappears so switching chats cannot leave invisible audio.
      // StrictMode replays effects while the same player is still connected.
      if (player.isConnected) return
      player.pause()
      player.removeAttribute('src')
      player.load()
    }
  }, [activated, attempt, failed, src])

  const retry = () => {
    setFailed(false)
    setLoaded(false)
    setActivated(true)
    setAttempt(value => value + 1)
  }

  const frame = kind === 'audio'
    ? 'mb-1 w-[280px] max-w-full'
    : isImage
      ? `relative w-[330px] max-w-full overflow-hidden bg-slate-100 ${loaded && !failed ? '' : 'min-h-48'}`
      : 'relative aspect-video w-[330px] max-w-full overflow-hidden bg-black'

  return (
    <div ref={containerRef} className={frame} data-chat-media={kind}>
      {failed || !src ? (
        <div className={`flex min-h-24 flex-col items-center justify-center gap-2 bg-slate-100 px-4 py-3 text-center text-slate-600 ${kind === 'audio' ? 'rounded-lg' : isImage ? 'h-full min-h-48' : 'h-full'}`} role="status">
          <AlertCircle className="h-5 w-5" aria-hidden />
          <span className="text-xs">No se pudo cargar {label === 'imagen' ? 'la imagen' : `el ${label}`}.</span>
          {src && <button type="button" onClick={retry} className="inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-xs font-semibold text-emerald-700 transition-colors hover:bg-emerald-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label={`Reintentar cargar ${label}`}><RefreshCw className="h-4 w-4" aria-hidden />Reintentar</button>}
        </div>
      ) : isImage ? (
        <div role={onOpen ? 'button' : undefined} tabIndex={onOpen ? 0 : undefined} aria-label={onOpen ? `Abrir ${label}` : undefined} onClick={onOpen} onKeyDown={event => {
          if (!onOpen || (event.key !== 'Enter' && event.key !== ' ')) return
          event.preventDefault()
          event.stopPropagation()
          onOpen()
        }} className={onOpen ? 'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500' : ''}>
          {!loaded && <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-500" role="status">{activated ? 'Cargando…' : 'GIF'}</div>}
          {activated && <img key={attempt} src={src} alt={label === 'imagen' ? 'Imagen' : 'GIF'} loading="lazy" decoding="async" onLoad={() => setLoaded(true)} onError={() => setFailed(true)} className={`block w-full transition-opacity duration-150 motion-reduce:transition-none ${loaded ? 'opacity-100' : 'opacity-0'}`} />}
        </div>
      ) : kind === 'audio' ? (
        <audio ref={playerRef as React.RefObject<HTMLAudioElement>} key={attempt} src={src} controls preload="none" className="h-11 w-full" aria-label="Mensaje de audio" onError={() => setFailed(true)} />
      ) : (
        <>
          {!activated && <button type="button" onClick={() => setActivated(true)} className="absolute inset-0 flex items-center justify-center text-sm font-medium text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-400">Cargar {label}</button>}
          {activated && <video ref={playerRef as React.RefObject<HTMLVideoElement>} key={attempt} src={src} controls={kind === 'video'} autoPlay={kind === 'gif'} loop={kind === 'gif'} muted={kind === 'gif'} playsInline preload="metadata" className="h-full w-full object-contain" aria-label={kind === 'gif' ? 'GIF animado' : 'Video del mensaje'} onLoadedMetadata={() => setLoaded(true)} onError={() => setFailed(true)} />}
          {activated && !loaded && <span className="pointer-events-none absolute inset-x-0 top-3 text-center text-xs text-white/80" role="status">Cargando {label}…</span>}
        </>
      )}
      {kind === 'gif' && !failed && <span className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-bold text-white">GIF</span>}
    </div>
  )
}
