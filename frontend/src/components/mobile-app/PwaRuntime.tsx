'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, Share, Smartphone, SquarePlus, X } from 'lucide-react'
import { useAccessibleDialog } from '@/components/pipelines/useAccessibleDialog'
import { isInstallPromptDismissed, isIOSDevice, isMobileAppDevice, isStandaloneApp } from '@/lib/mobileApp'

const INSTALL_DISMISS_MS = 14 * 24 * 60 * 60 * 1000
const INSTALL_DISMISS_KEY = 'clarin:pwa-install-dismissed-until'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

interface PwaRuntimeValue {
  ready: boolean
  standalone: boolean
  mobileApp: boolean
  installAvailable: boolean
  promptDismissed: boolean
  iosDevice: boolean
  instructionsOpen: boolean
  install: () => Promise<void>
  dismissPrompt: () => void
  closeInstructions: () => void
}

const PwaRuntimeContext = createContext<PwaRuntimeValue>({
  ready: false,
  standalone: false,
  mobileApp: false,
  installAvailable: false,
  promptDismissed: false,
  iosDevice: false,
  instructionsOpen: false,
  install: async () => {},
  dismissPrompt: () => {},
  closeInstructions: () => {},
})

function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return

    let cancelled = false
    const register = async () => {
      try {
        const registration = await navigator.serviceWorker.register('/sw.js', {
          scope: '/',
          updateViaCache: 'none',
        })
        if (!cancelled) await registration.update()
      } catch (error) {
        console.warn('No se pudo registrar la experiencia instalable de Clarin.', error)
      }
    }

    if (document.readyState === 'complete') void register()
    else window.addEventListener('load', register, { once: true })

    return () => {
      cancelled = true
      window.removeEventListener('load', register)
    }
  }, [])

  return null
}

export function PwaRuntimeProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false)
  const [standalone, setStandalone] = useState(false)
  const [mobileDevice, setMobileDevice] = useState(false)
  const [iosDevice, setIosDevice] = useState(false)
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null)
  const [promptDismissed, setPromptDismissed] = useState(false)
  const [instructionsOpen, setInstructionsOpen] = useState(false)

  useEffect(() => {
    const media = window.matchMedia('(display-mode: standalone)')
    const navigatorStandalone = (navigator as Navigator & { standalone?: boolean }).standalone
    const updateStandalone = () => setStandalone(isStandaloneApp({
      displayModeStandalone: media.matches,
      navigatorStandalone,
    }))

    setIosDevice(isIOSDevice({
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      maxTouchPoints: navigator.maxTouchPoints,
    }))
    setMobileDevice(isMobileAppDevice({
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      maxTouchPoints: navigator.maxTouchPoints,
      userAgentMobile: (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData?.mobile,
    }))
    setPromptDismissed(isInstallPromptDismissed(window.localStorage.getItem(INSTALL_DISMISS_KEY)))
    updateStandalone()
    setReady(true)
    media.addEventListener?.('change', updateStandalone)
    return () => media.removeEventListener?.('change', updateStandalone)
  }, [])

  useEffect(() => {
    const handleBeforeInstall = (event: Event) => {
      event.preventDefault()
      setInstallEvent(event as BeforeInstallPromptEvent)
    }
    const handleInstalled = () => {
      setInstallEvent(null)
      setInstructionsOpen(false)
    }
    window.addEventListener('beforeinstallprompt', handleBeforeInstall)
    window.addEventListener('appinstalled', handleInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstall)
      window.removeEventListener('appinstalled', handleInstalled)
    }
  }, [])

  const dismissPrompt = useCallback(() => {
    const dismissedUntil = Date.now() + INSTALL_DISMISS_MS
    window.localStorage.setItem(INSTALL_DISMISS_KEY, String(dismissedUntil))
    setPromptDismissed(true)
  }, [])

  const install = useCallback(async () => {
    if (standalone) return
    if (installEvent) {
      await installEvent.prompt()
      const choice = await installEvent.userChoice
      setInstallEvent(null)
      if (choice.outcome === 'dismissed') dismissPrompt()
      return
    }
    if (iosDevice) setInstructionsOpen(true)
  }, [dismissPrompt, installEvent, iosDevice, standalone])

  const value = useMemo<PwaRuntimeValue>(() => ({
    ready,
    standalone,
    mobileApp: standalone && mobileDevice,
    installAvailable: !standalone && Boolean(installEvent || iosDevice),
    promptDismissed,
    iosDevice,
    instructionsOpen,
    install,
    dismissPrompt,
    closeInstructions: () => setInstructionsOpen(false),
  }), [dismissPrompt, install, installEvent, instructionsOpen, iosDevice, mobileDevice, promptDismissed, ready, standalone])

  return (
    <PwaRuntimeContext.Provider value={value}>
      <ServiceWorkerRegistrar />
      {children}
    </PwaRuntimeContext.Provider>
  )
}

export function usePwaRuntime() {
  return useContext(PwaRuntimeContext)
}

export function PwaInstallMenuAction({ compact, onInvoked }: { compact: boolean; onInvoked?: () => void }) {
  const runtime = usePwaRuntime()
  if (!runtime.ready || runtime.standalone || !runtime.installAvailable) return null

  return (
    <div className={`shrink-0 border-t border-slate-700/50 ${compact ? 'p-2' : 'px-2.5 py-2'}`}>
      <button
        type="button"
        onClick={() => { onInvoked?.(); void runtime.install() }}
        className={`w-full min-h-11 lg:min-h-0 flex items-center ${compact ? 'justify-center p-2' : 'gap-2.5 px-3 py-2'} rounded-lg border border-sky-400/20 bg-sky-400/10 text-sky-200 transition-all hover:border-sky-300/40 hover:bg-sky-400/15 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300/70`}
        aria-label="Instalar Clarin"
        title={compact ? 'Instalar Clarin' : undefined}
      >
        <Download className="h-[18px] w-[18px] shrink-0" />
        {!compact && <span className="flex-1 text-left text-[13px] font-semibold">Instalar Clarin</span>}
      </button>
    </div>
  )
}

export function PwaInstallExperience() {
  const runtime = usePwaRuntime()
  const [mobileSurface, setMobileSurface] = useState(false)
  const [bannerReady, setBannerReady] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const media = window.matchMedia('(max-width: 1024px), (pointer: coarse)')
    const update = () => setMobileSurface(media.matches)
    update()
    media.addEventListener?.('change', update)
    return () => media.removeEventListener?.('change', update)
  }, [])

  useEffect(() => {
    if (!runtime.installAvailable || runtime.promptDismissed || runtime.standalone) {
      setBannerReady(false)
      return
    }
    const timer = window.setTimeout(() => setBannerReady(true), 1600)
    return () => window.clearTimeout(timer)
  }, [runtime.installAvailable, runtime.promptDismissed, runtime.standalone])

  useAccessibleDialog(runtime.instructionsOpen, dialogRef, runtime.closeInstructions, closeRef)

  const guide = runtime.instructionsOpen && typeof document !== 'undefined' ? createPortal(
    <div className="app-viewport fixed z-[240] flex items-end justify-center bg-slate-950/50 backdrop-blur-[2px] sm:items-center sm:p-4" onMouseDown={event => { if (event.target === event.currentTarget) runtime.closeInstructions() }}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="pwa-ios-title" className="animate-view-enter w-full overflow-hidden rounded-t-3xl border border-white/70 bg-white shadow-[0_28px_80px_rgba(15,23,42,0.3)] outline-none motion-reduce:animate-none sm:max-w-md sm:rounded-3xl">
        <header className="flex items-start gap-3 border-b border-slate-100 px-4 py-4 sm:px-5">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700"><Smartphone className="h-5 w-5" /></span>
          <div className="min-w-0 flex-1"><h2 id="pwa-ios-title" className="text-xl font-bold tracking-tight text-slate-900">Instala Clarin</h2><p className="mt-1 text-sm leading-5 text-slate-500">Añádelo a tu pantalla de inicio para abrirlo como una app.</p></div>
          <button ref={closeRef} type="button" onClick={runtime.closeInstructions} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400" aria-label="Cerrar instrucciones"><X className="h-5 w-5" /></button>
        </header>
        <ol className="space-y-3 px-4 py-5 sm:px-5">
          <li className="flex gap-3 rounded-2xl bg-slate-50 p-3.5"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white text-emerald-700 shadow-sm"><Share className="h-4 w-4" /></span><span className="pt-0.5 text-sm leading-6 text-slate-700"><strong className="block text-slate-900">1. Toca Compartir</strong>Usa el botón Compartir de tu navegador.</span></li>
          <li className="flex gap-3 rounded-2xl bg-slate-50 p-3.5"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white text-emerald-700 shadow-sm"><SquarePlus className="h-4 w-4" /></span><span className="pt-0.5 text-sm leading-6 text-slate-700"><strong className="block text-slate-900">2. Añadir a pantalla de inicio</strong>Elige esa opción y confirma con Añadir.</span></li>
        </ol>
        <div className="border-t border-slate-100 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:px-5"><button type="button" onClick={runtime.closeInstructions} className="min-h-11 w-full rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2">Entendido</button></div>
      </div>
    </div>, document.body
  ) : null

  return (
    <>
      {guide}
      {mobileSurface && bannerReady && runtime.installAvailable && !runtime.promptDismissed && !runtime.standalone && (
        <aside className="fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-[210] mx-auto max-w-lg rounded-2xl border border-slate-200/90 bg-white/95 p-3 shadow-[0_22px_55px_rgba(15,23,42,0.2)] ring-1 ring-white/80 backdrop-blur-xl" aria-label="Instalar Clarin">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-sm shadow-emerald-600/25"><Download className="h-5 w-5" /></span>
            <div className="min-w-0 flex-1"><p className="text-sm font-bold text-slate-900">Lleva Clarin contigo</p><p className="mt-0.5 text-xs leading-5 text-slate-500">Instálalo para abrirlo rápido y usar su experiencia móvil.</p></div>
            <button type="button" onClick={runtime.dismissPrompt} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400" aria-label="Recordar más tarde"><X className="h-4 w-4" /></button>
          </div>
          <div className="mt-3 grid grid-cols-[1fr_auto] gap-2"><button type="button" onClick={() => void runtime.install()} className="min-h-11 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2">{runtime.iosDevice ? 'Ver cómo instalar' : 'Instalar Clarin'}</button><button type="button" onClick={runtime.dismissPrompt} className="min-h-11 rounded-xl px-3 text-sm font-semibold text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300">Ahora no</button></div>
        </aside>
      )}
    </>
  )
}
