'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Globe,
  Loader2,
  Lock,
  Maximize2,
  Minimize2,
  Monitor,
  Power,
  RefreshCw,
  ShieldCheck,
  Unlock,
} from 'lucide-react'
import { apiGet, apiPost } from '@/lib/api'

interface AllowedDomain {
  id: string
  domain: string
  is_active: boolean
  created_at: string
}

interface SharedBrowserSession {
  id: string
  status: 'idle' | 'connected' | 'error' | string
  current_url: string
  current_domain: string
  controller_user_id?: string
  controller_display_name?: string
  control_expires_at?: string
  last_error?: string
  has_control: boolean
  can_request_control: boolean
  can_force_control: boolean
}

interface StatusPayload {
  success: boolean
  session: SharedBrowserSession
  allowed_domains: AllowedDomain[]
  is_admin: boolean
  gateway_available: boolean
}

function normalizeURLInput(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed.includes('://') ? trimmed : `https://${trimmed}`
}

function statusLabel(session?: SharedBrowserSession, gatewayAvailable = false) {
  if (!gatewayAvailable) return 'Servicio no disponible'
  if (!session || session.status === 'idle') return 'Sin iniciar'
  if (session.status === 'error') return 'Error'
  if (session.has_control) return 'Con control'
  if (session.controller_display_name) return `Controlado por ${session.controller_display_name}`
  return 'Solo lectura'
}

type RFBInstance = {
  viewOnly: boolean
  scaleViewport: boolean
  resizeSession: boolean
  focus?: () => void
  disconnect: () => void
  addEventListener: (event: string, listener: EventListener) => void
}

type RFBConstructor = new (target: HTMLElement, url: string, options?: Record<string, unknown>) => RFBInstance

function buildVNCURL() {
  const apiBase = process.env.NEXT_PUBLIC_API_URL || ''
  const base = apiBase ? new URL(apiBase, window.location.origin) : new URL(window.location.origin)
  const protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${base.host}/api/shared-browser/vnc`
}

export default function SharedBrowserPage() {
  const [status, setStatus] = useState<StatusPayload | null>(null)
  const [url, setUrl] = useState('')
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [streamNonce, setStreamNonce] = useState(Date.now())
  const [isMaximized, setIsMaximized] = useState(false)
  const [pendingDomain, setPendingDomain] = useState('')
  const [vncState, setVncState] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle')
  const vncContainerRef = useRef<HTMLDivElement>(null)
  const rfbRef = useRef<RFBInstance | null>(null)

  const session = status?.session
  const isAdmin = Boolean(status?.is_admin)
  const gatewayAvailable = Boolean(status?.gateway_available)
  const canControl = Boolean(session?.has_control)
  const isConnected = session?.status === 'connected' && gatewayAvailable

  const loadStatus = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    const res = await apiGet<StatusPayload>('/api/shared-browser/status')
    if (res.success && res.data) {
      setStatus(res.data)
      if (res.data.session?.current_url) setUrl(res.data.session.current_url)
    } else if (!silent) {
      setMessage({ type: 'error', text: res.error || 'No se pudo cargar el navegador compartido' })
    }
    if (!silent) setLoading(false)
  }, [])

  useEffect(() => {
    loadStatus()
  }, [loadStatus])

  useEffect(() => {
    const timer = setInterval(() => {
      loadStatus(true)
    }, 5000)
    return () => clearInterval(timer)
  }, [loadStatus])

  useEffect(() => {
    if (!isMaximized) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsMaximized(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isMaximized])

  useEffect(() => {
    if (!isConnected || !canControl || !vncContainerRef.current) {
      rfbRef.current?.disconnect()
      rfbRef.current = null
      setVncState('idle')
      return
    }

    let disposed = false
    const target = vncContainerRef.current
    target.replaceChildren()
    setVncState('connecting')

    import('@novnc/novnc')
      .then(mod => {
        if (disposed || !vncContainerRef.current) return
        const RFB = mod.default as RFBConstructor
        const rfb = new RFB(vncContainerRef.current, buildVNCURL())
        rfb.viewOnly = false
        rfb.scaleViewport = true
        rfb.resizeSession = true
        rfb.addEventListener('connect', () => {
          if (!disposed) setVncState('connected')
        })
        rfb.addEventListener('disconnect', () => {
          if (!disposed) setVncState(prev => (prev === 'idle' ? prev : 'error'))
        })
        rfb.addEventListener('securityfailure', () => {
          if (!disposed) setVncState('error')
        })
        rfbRef.current = rfb
      })
      .catch(() => {
        if (!disposed) setVncState('error')
      })

    return () => {
      disposed = true
      rfbRef.current?.disconnect()
      rfbRef.current = null
      target.replaceChildren()
    }
  }, [isConnected, canControl, streamNonce, session?.controller_user_id])

  const domainsText = useMemo(() => {
    const domains = status?.allowed_domains || []
    if (domains.length === 0) return 'Sin dominios aprobados'
    return domains.map(d => d.domain).join(', ')
  }, [status?.allowed_domains])

  const runAction = async (action: () => Promise<void>) => {
    setBusy(true)
    setMessage(null)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }

  const openURL = async (approveDomain = false) => {
    const target = normalizeURLInput(url)
    if (!target) {
      setMessage({ type: 'error', text: 'Ingresa una URL para abrir.' })
      return
    }
    await runAction(async () => {
      const res = await apiPost<any>('/api/shared-browser/open', { url: target, approve_domain: approveDomain })
      if (res.success && res.data) {
        setPendingDomain('')
        setMessage({ type: 'success', text: 'Navegador conectado.' })
        await loadStatus(true)
        setStreamNonce(Date.now())
        return
      }
      if (res.error?.toLowerCase().includes('dominio') && isAdmin) {
        const host = (() => {
          try { return new URL(target).hostname } catch { return '' }
        })()
        setPendingDomain(host)
        setMessage({ type: 'info', text: 'Este dominio necesita aprobación de Admin.' })
      } else {
        setMessage({ type: 'error', text: res.error || 'No se pudo abrir la URL.' })
      }
    })
  }

  const requestControl = async (force = false) => {
    await runAction(async () => {
      const res = await apiPost<any>('/api/shared-browser/request-control', { force })
      if (!res.success) {
        setMessage({ type: 'error', text: res.error || 'No se pudo tomar control.' })
        await loadStatus(true)
        return
      }
      await loadStatus(true)
      setMessage({ type: 'success', text: force ? 'Control tomado por Admin.' : 'Ahora tienes el control.' })
    })
  }

  const releaseControl = async () => {
    await runAction(async () => {
      const res = await apiPost<any>('/api/shared-browser/release-control', {})
      if (!res.success) {
        setMessage({ type: 'error', text: res.error || 'No se pudo liberar control.' })
        return
      }
      await loadStatus(true)
      setMessage({ type: 'success', text: 'Control liberado.' })
    })
  }

  const reloadBrowser = async () => {
    await runAction(async () => {
      const res = await apiPost<any>('/api/shared-browser/reload', {})
      if (!res.success) {
        setMessage({ type: 'error', text: res.error || 'No se pudo recargar.' })
        return
      }
      setStreamNonce(Date.now())
    })
  }

  const restartBrowser = async () => {
    await runAction(async () => {
      const res = await apiPost<any>('/api/shared-browser/restart', {})
      if (!res.success) {
        setMessage({ type: 'error', text: res.error || 'No se pudo reiniciar.' })
        return
      }
      await loadStatus(true)
      setStreamNonce(Date.now())
      setMessage({ type: 'success', text: 'Sesión reiniciada.' })
    })
  }

  const approvePendingDomain = async () => {
    if (!pendingDomain && !url) return
    await runAction(async () => {
      const res = await apiPost<any>('/api/shared-browser/allowed-domains', { domain: pendingDomain, url })
      if (!res.success) {
        setMessage({ type: 'error', text: res.error || 'No se pudo aprobar el dominio.' })
        return
      }
      setPendingDomain('')
      await loadStatus(true)
      await openURL(true)
    })
  }

  if (loading) {
    return (
      <div className="h-full bg-slate-50 flex items-center justify-center">
        <div className="flex items-center gap-3 text-slate-500">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-sm">Cargando navegador...</span>
        </div>
      </div>
    )
  }

  return (
    <div className={`${isMaximized ? 'fixed inset-0 z-[80]' : 'h-[calc(100vh-56px)]'} bg-slate-50 flex flex-col overflow-hidden`}>
      <div className="bg-white border-b border-slate-200 px-4 py-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-9 h-9 rounded-lg bg-emerald-50 text-emerald-700 flex items-center justify-center border border-emerald-100">
              <Monitor className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h1 className="text-lg font-semibold text-slate-900 leading-tight">Navegador compartido</h1>
              <p className="text-xs text-slate-500 truncate">{domainsText}</p>
            </div>
          </div>

          <div className="flex-1 flex items-center gap-2 min-w-0">
            <div className="relative flex-1 min-w-[180px]">
              <Globe className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                value={url}
                onChange={e => setUrl(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void openURL(false) }}
                placeholder="https://sistema.com"
                className="w-full h-10 pl-9 pr-3 rounded-lg border border-slate-200 bg-white text-sm text-slate-800 outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
              />
            </div>
            <button
              onClick={() => openURL(false)}
              disabled={busy || !gatewayAvailable}
              className="h-10 px-4 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ExternalLink className="w-4 h-4" />}
              Abrir
            </button>
          </div>

          <div className="flex items-center gap-2">
            <div className={`h-10 px-3 rounded-lg border flex items-center gap-2 text-sm ${
              gatewayAvailable ? 'bg-white border-slate-200 text-slate-700' : 'bg-amber-50 border-amber-200 text-amber-700'
            }`}>
              {gatewayAvailable ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <AlertCircle className="w-4 h-4" />}
              <span className="whitespace-nowrap">{statusLabel(session, gatewayAvailable)}</span>
            </div>
          </div>
        </div>

        {(message || pendingDomain) && (
          <div className={`mt-3 flex flex-col gap-2 rounded-lg border px-3 py-2 text-sm ${
            message?.type === 'error'
              ? 'bg-red-50 border-red-200 text-red-700'
              : message?.type === 'success'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                : 'bg-amber-50 border-amber-200 text-amber-700'
          }`}>
            {message?.text && <div>{message.text}</div>}
            {pendingDomain && isAdmin && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{pendingDomain}</span>
                <button
                  onClick={approvePendingDomain}
                  disabled={busy}
                  className="h-8 px-3 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 disabled:opacity-50"
                >
                  Aprobar y abrir
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="bg-white border-b border-slate-200 px-4 py-2 flex flex-wrap items-center gap-2">
        {canControl ? (
          <button onClick={releaseControl} disabled={busy} className="h-9 px-3 rounded-lg border border-slate-200 text-slate-700 text-sm hover:bg-slate-50 flex items-center gap-2">
            <Unlock className="w-4 h-4" />
            Liberar control
          </button>
        ) : (
          <button onClick={() => requestControl(false)} disabled={busy || !session?.can_request_control} className="h-9 px-3 rounded-lg border border-slate-200 text-slate-700 text-sm hover:bg-slate-50 disabled:opacity-50 flex items-center gap-2">
            <Lock className="w-4 h-4" />
            Solicitar control
          </button>
        )}
        {session?.can_force_control && (
          <button onClick={() => requestControl(true)} disabled={busy} className="h-9 px-3 rounded-lg border border-amber-200 bg-amber-50 text-amber-700 text-sm hover:bg-amber-100 flex items-center gap-2">
            <ShieldCheck className="w-4 h-4" />
            Tomar control
          </button>
        )}
        <button onClick={reloadBrowser} disabled={busy || !canControl || session?.status !== 'connected'} className="h-9 px-3 rounded-lg border border-slate-200 text-slate-700 text-sm hover:bg-slate-50 disabled:opacity-50 flex items-center gap-2">
          <RefreshCw className="w-4 h-4" />
          Recargar
        </button>
        <button onClick={() => setIsMaximized(value => !value)} className="h-9 px-3 rounded-lg border border-slate-200 text-slate-700 text-sm hover:bg-slate-50 flex items-center gap-2">
          {isMaximized ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          {isMaximized ? 'Restaurar' : 'Maximizar'}
        </button>
        <button onClick={restartBrowser} disabled={busy || !canControl} className="h-9 px-3 rounded-lg border border-red-200 text-red-700 text-sm hover:bg-red-50 disabled:opacity-50 flex items-center gap-2">
          <Power className="w-4 h-4" />
          Reiniciar sesión
        </button>
        <div className="ml-auto flex items-center gap-2 text-xs text-slate-500">
          <span>
            {canControl
              ? vncState === 'connected'
                ? 'Control fluido'
                : 'Conectando vista'
              : 'Solo lectura'}
          </span>
        </div>
      </div>

      <div
        className="flex-1 min-h-0 bg-slate-950 outline-none relative"
      >
        {isConnected && canControl ? (
          <>
            <div
              ref={vncContainerRef}
              onPointerDown={() => rfbRef.current?.focus?.()}
              className="absolute inset-0 overflow-hidden bg-slate-950 [&_canvas]:max-w-full [&_canvas]:max-h-full"
            />
            {vncState !== 'connected' && (
              <div className="absolute inset-0 flex items-center justify-center bg-slate-950/70">
                <div className="flex items-center gap-3 rounded-lg border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-slate-200">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>{vncState === 'error' ? 'Reconectando navegador...' : 'Conectando vista fluida...'}</span>
                </div>
              </div>
            )}
          </>
        ) : isConnected ? (
          <img
            src={`/api/shared-browser/stream?t=${streamNonce}`}
            alt="Navegador compartido"
            draggable={false}
            onLoad={() => setMessage(prev => prev?.text === 'No se pudo cargar la vista del navegador.' ? null : prev)}
            onError={() => setMessage({ type: 'error', text: 'No se pudo cargar la vista del navegador.' })}
            className="w-full h-full object-contain select-none"
          />
        ) : (
          <div className="h-full flex items-center justify-center p-6">
            <div className="max-w-md text-center">
              <div className="w-14 h-14 mx-auto rounded-xl bg-slate-800 border border-slate-700 flex items-center justify-center text-slate-300">
                <Monitor className="w-7 h-7" />
              </div>
              <h2 className="mt-4 text-lg font-semibold text-white">Sin navegador activo</h2>
              <p className="mt-2 text-sm text-slate-400">
                {gatewayAvailable
                  ? 'Ingresa una URL aprobada para iniciar la instancia compartida de esta cuenta.'
                  : 'El servicio interno del navegador aún no está disponible.'}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
