'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Script from 'next/script'
import { ArrowRight, Eye, EyeOff, Lock, ShieldCheck, User, WifiOff } from 'lucide-react'
import ClarinBrandMark from '@/components/branding/ClarinBrandMark'
import { getLoginNoticeForLogoutReason, invalidateOfflineBeforeIdentityChange, markAuthTokenRefreshed } from '@/lib/api'
import { WHITEBOARD_PUBLIC_LIBRARY_CALLBACK_PATH } from '@/lib/whiteboardPublicLibraries'
import { classifyRemoteResponse } from '@/offline-v3/availability'
import {
  clearOfflineReauthExpectation,
  readOfflineReauthExpectation,
  storeOfflineReauthExpectation,
  type OfflineReauthExpectation,
} from '@/offline-v3/offlineReauth'
import {
  beginOfflineV5OnlineTransition,
  cancelOfflineV5OnlineTransition,
  completeOfflineV5OnlineTransition,
  getOfflineV5RuntimeSnapshot,
  hasPreparedOfflineV5CopyForUsername,
  refreshOfflineV5FallbackState,
  replaceStaleOfflineLoginWithOnline,
  dismissOfflineV5FallbackOffer,
  selectOfflineV5Account,
  subscribeOfflineV5Runtime,
  unlockOfflineV5User,
  type RuntimeSnapshot,
} from '@/lib/offlineV5Runtime'
import { getOfflineV5ServiceWorkerStatus, hasOfflineV5ServiceWorkerRegistration } from '@/lib/offlineV5ServiceWorker'
import { browserOfflineV5Client } from '@/offline-v5/client'

type TurnstileWidgetID = string | number

const recoverableTurnstileErrors = new Set([
  'Cloudflare no pudo completar la verificación. Puedes esperar o usar tu copia offline autorizada.',
  'Cloudflare no pudo completar la verificación. Puedes esperar y volver a intentarlo.',
  'Cloudflare no pudo iniciar la verificación. Puedes esperar o usar tu copia offline autorizada.',
  'Cloudflare no pudo iniciar la verificación. Puedes esperar y volver a intentarlo.',
  'Cloudflare no está respondiendo. Puedes esperar o usar tu copia offline autorizada.',
  'Cloudflare no está respondiendo. Puedes esperar y volver a intentarlo.',
  'Cloudflare no pudo cargar la verificación. Puedes esperar o usar tu copia offline autorizada.',
  'Cloudflare no pudo cargar la verificación. Puedes esperar y volver a intentarlo.',
  'Completa la verificación de seguridad para iniciar sesión.',
])

function recoverTurnstileError(current: string) {
  return recoverableTurnstileErrors.has(current) ? '' : current
}

export function offlineFallbackMessage(reason: string, copyAvailable: boolean) {
  const base = reason.trim().replace(/[.!?]+$/, '')
  return copyAvailable
    ? `${base}. Puedes esperar o usar tu copia offline autorizada.`
    : `${base}. Puedes esperar y volver a intentarlo.`
}

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: string | HTMLElement,
        options: {
          sitekey: string
          theme?: 'light' | 'dark' | 'auto'
          size?: 'normal' | 'compact' | 'flexible'
          callback?: (token: string) => void
          'expired-callback'?: () => void
          'error-callback'?: () => void
        }
      ) => TurnstileWidgetID
      reset: (widgetId?: TurnstileWidgetID) => void
      remove: (widgetId: TurnstileWidgetID) => void
    }
  }
}

export default function LoginScreen() {
  const router = useRouter()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [sessionNotice, setSessionNotice] = useState('')
  const [loading, setLoading] = useState(false)
  const [turnstileSiteKey, setTurnstileSiteKey] = useState('')
  const [turnstileRequired, setTurnstileRequired] = useState(false)
  const [loginEnabled, setLoginEnabled] = useState(true)
  const [turnstileReady, setTurnstileReady] = useState(false)
  const [turnstileToken, setTurnstileToken] = useState('')
  const [offlineOffer, setOfflineOffer] = useState(false)
  const [offlineChecking, setOfflineChecking] = useState(false)
  const [offlineAccounts, setOfflineAccounts] = useState<Array<{ grantId: string; accountId: string; accountName: string }>>([])
  const [offlineReauthRequested, setOfflineReauthRequested] = useState(false)
  const [offlineFreshLoginRequested, setOfflineFreshLoginRequested] = useState(false)
  const [offlineReauth, setOfflineReauth] = useState<OfflineReauthExpectation | null>(null)
  const turnstileRef = useRef<HTMLDivElement | null>(null)
  const widgetIdRef = useRef<TurnstileWidgetID | null>(null)
  const offlineOfferDismissedRef = useRef(false)
  const offlineOfferForcedRef = useRef(false)
  const offlineOfferCheckRef = useRef(0)

  const showOfflineFallback = useCallback((reason: string) => {
    const check = ++offlineOfferCheckRef.current
    offlineOfferForcedRef.current = true
    offlineOfferDismissedRef.current = false
    setOfflineOffer(false)
    setError(offlineFallbackMessage(reason, false))
    const login = username.trim()
    if (!login) {
      void dismissOfflineV5FallbackOffer().catch(() => undefined)
      return
    }
    void hasOfflineV5ServiceWorkerRegistration()
      .then(registered => registered ? hasPreparedOfflineV5CopyForUsername(login) : false)
      .then(copyAvailable => {
      if (offlineOfferCheckRef.current !== check) return
      setError(offlineFallbackMessage(reason, copyAvailable))
      setOfflineOffer(copyAvailable)
      if (!copyAvailable) void dismissOfflineV5FallbackOffer().catch(() => undefined)
      })
  }, [username])

  useEffect(() => {
    const sessionNotice = sessionStorage.getItem('clarin:login_notice')
    if (!sessionNotice) return
    sessionStorage.removeItem('clarin:login_notice')
    setNotice(sessionNotice)
  }, [])

  useEffect(() => {
    const reason = new URLSearchParams(window.location.search).get('reason')
    setSessionNotice(getLoginNoticeForLogoutReason(reason))
  }, [])

  useEffect(() => {
    let cancelled = false
    let reloadStarted = false
    let unsubscribe = () => {}
    let timer: number | undefined
    const considerOfflineOffer = async () => {
      const fallback = await refreshOfflineV5FallbackState().catch(() => ({ offer: false, reloadOnlineLogin: false }))
      if (cancelled) return
      if (fallback.reloadOnlineLogin && !reloadStarted) {
        reloadStarted = true
        replaceStaleOfflineLoginWithOnline()
        return
      }
      const outageDetected = offlineOfferForcedRef.current || fallback.offer || navigator.onLine === false
      if (!outageDetected) {
        offlineOfferCheckRef.current++
        offlineOfferDismissedRef.current = false
        setOfflineOffer(false)
        return
      }
      // Keep the ordinary login unchanged until the person submits an exact
      // username and an online attempt actually fails. Never advertise a copy
      // belonging to an unknown or different user in a shared browser.
      if (!offlineOfferForcedRef.current) setOfflineOffer(false)
    }
    const onConnectivityChange = () => { void considerOfflineOffer() }
    void hasOfflineV5ServiceWorkerRegistration().then(registered => {
      if (cancelled || !registered) return
      void considerOfflineOffer()
      unsubscribe = subscribeOfflineV5Runtime(() => { void considerOfflineOffer() })
      timer = window.setInterval(onConnectivityChange, 5_000)
      window.addEventListener('online', onConnectivityChange)
      window.addEventListener('offline', onConnectivityChange)
    })
    return () => {
      cancelled = true
      unsubscribe()
      if (timer !== undefined) window.clearInterval(timer)
      window.removeEventListener('online', onConnectivityChange)
      window.removeEventListener('offline', onConnectivityChange)
    }
  }, [])

  useEffect(() => {
    const query = new URLSearchParams(window.location.search)
    if (query.get('offline_fresh_login') === '1') {
      setOfflineFreshLoginRequested(true)
      return
    }
    if (query.get('offline_reauth') !== '1') return
    setOfflineReauthRequested(true)
    const expectation = readOfflineReauthExpectation(window.sessionStorage)
    setOfflineReauth(expectation)
    if (!expectation) setError('La transición segura desde el modo offline venció. Vuelve a iniciarla desde tu copia local.')
  }, [])

  const renderTurnstile = useCallback(() => {
    const turnstile = window.turnstile
    if (!turnstileSiteKey || !turnstileReady || !turnstile || !turnstileRef.current || widgetIdRef.current !== null) return
    try {
      widgetIdRef.current = turnstile.render(turnstileRef.current, {
        sitekey: turnstileSiteKey,
        theme: 'light',
        size: 'flexible',
        callback: (token: string) => {
          offlineOfferCheckRef.current++
          offlineOfferForcedRef.current = false
          setTurnstileToken(token)
          if (navigator.onLine !== false) setOfflineOffer(false)
          setError(recoverTurnstileError)
        },
        'expired-callback': () => setTurnstileToken(''),
        'error-callback': () => {
          setTurnstileToken('')
          showOfflineFallback('Cloudflare no pudo completar la verificación')
        },
      })
    } catch {
      setTurnstileReady(false)
      showOfflineFallback('Cloudflare no pudo iniciar la verificación')
    }
  }, [showOfflineFallback, turnstileReady, turnstileSiteKey])

  const resetTurnstile = useCallback(() => {
    setTurnstileToken('')
    if (window.turnstile && widgetIdRef.current !== null) {
      window.turnstile.reset(widgetIdRef.current)
    }
  }, [])

  const loadSecurityConfig = useCallback(async () => {
    try {
      const response = await fetch('/api/public/security-config')
      const contentType = response.headers.get('content-type') || ''
      if (response.headers.get('X-Clarin-Response') !== '1' || !contentType.includes('application/json')) return null
      const data = await response.json().catch(() => ({}))
      if (!data.success) return null
      const config = {
        turnstileSiteKey: typeof data.turnstile_site_key === 'string' ? data.turnstile_site_key : '',
        turnstileRequired: Boolean(data.login_turnstile_required),
        loginEnabled: Boolean(data.login_enabled ?? true),
      }
      setTurnstileSiteKey(config.turnstileSiteKey)
      setTurnstileRequired(config.turnstileRequired)
      setLoginEnabled(config.loginEnabled)
      return config
    } catch {
      return null
    }
  }, [])

  useEffect(() => {
    void loadSecurityConfig().then(config => {
      if (!config) {
        setTurnstileRequired(false)
        setLoginEnabled(true)
      }
    })
  }, [loadSecurityConfig])

  useEffect(() => {
    if (window.turnstile) setTurnstileReady(true)
  }, [turnstileSiteKey])

  useEffect(() => {
    if (!turnstileRequired || !turnstileSiteKey || turnstileReady || turnstileToken) return
    const timer = window.setTimeout(() => {
      showOfflineFallback('Cloudflare no está respondiendo')
    }, 8_000)
    return () => window.clearTimeout(timer)
  }, [showOfflineFallback, turnstileReady, turnstileRequired, turnstileSiteKey, turnstileToken])

  useEffect(() => {
    renderTurnstile()
    return () => {
      if (window.turnstile && widgetIdRef.current !== null) {
        window.turnstile.remove(widgetIdRef.current)
        widgetIdRef.current = null
      }
    }
  }, [renderTurnstile])

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    offlineOfferForcedRef.current = false
    setError('')
    if (!loginEnabled) {
      setError('Inicio de sesión temporalmente no disponible.')
      return
    }
    if (offlineReauthRequested && !offlineReauth) {
      setError('No existe una identidad local vigente para volver al modo online.')
      return
    }
    setLoading(true)
    let transitionKind: 'reauth' | 'fresh' | null = offlineReauthRequested
      ? 'reauth'
      : offlineFreshLoginRequested
        ? 'fresh'
        : null
    let reauthExpectation = offlineReauth

    // A local logout intentionally leaves the verified shell in offline mode.
    // Arm its narrow login latch before the ordinary form can touch the
    // network. An active local identity must always reauthenticate exactly;
    // a locked shell may start a fresh online identity without deleting any
    // prepared copy.
    if (!transitionKind) {
      const runtime = getOfflineV5RuntimeSnapshot()
      const shouldProbeWorker = runtime.active
        || runtime.mode === 'locked'
        || offlineOffer
        || Boolean(navigator.serviceWorker?.controller)
      const workerStatus = shouldProbeWorker
        ? await getOfflineV5ServiceWorkerStatus().catch(() => undefined)
        : undefined
      if (runtime.active || workerStatus?.mode === 'offline') {
        if (runtime.active) {
          if (!runtime.userId || !runtime.accountId) {
            setError('La sesión offline activa no tiene una identidad verificable. Tu copia local continúa intacta.')
            setLoading(false)
            return
          }
          try {
            reauthExpectation = storeOfflineReauthExpectation(window.sessionStorage, {
              user_id: runtime.userId,
              account_id: runtime.accountId,
            })
          } catch (transitionError) {
            setError(transitionError instanceof Error ? transitionError.message : 'No se pudo preparar una transición online segura.')
            setLoading(false)
            return
          }
          transitionKind = 'reauth'
          setOfflineReauth(reauthExpectation)
          setOfflineReauthRequested(true)
          router.replace('/login?offline_reauth=1')
        } else {
          clearOfflineReauthExpectation(window.sessionStorage)
          transitionKind = 'fresh'
          setOfflineFreshLoginRequested(true)
          router.replace('/login?offline_fresh_login=1')
        }
      }
    }

    const cancelFailedTransition = async () => {
      if (!transitionKind) return
      await cancelOfflineV5OnlineTransition().catch(() => undefined)
    }
    let effectiveTurnstileRequired: boolean = turnstileRequired
    let effectiveTurnstileSiteKey: string = turnstileSiteKey
    let effectiveLoginEnabled: boolean = loginEnabled
    if (transitionKind) {
      try {
        // Renew only the narrow v5 network allow-list. The local key and SW
        // offline mode remain intact until the server proves this identity.
        await beginOfflineV5OnlineTransition()
      } catch {
        setError('No se pudo comprobar la conexión online. Tu sesión y tus cambios offline continúan intactos.')
        setLoading(false)
        return
      }

      // The first config request after reopening an offline shell could not
      // reach Clarin. Retry it only after the narrow latch is ready so that
      // Turnstile is neither skipped nor guessed.
      const config = await loadSecurityConfig()
      if (!config) {
        await cancelFailedTransition()
        showOfflineFallback('No se pudo comprobar la configuración de acceso de Clarin')
        setLoading(false)
        return
      }
      effectiveTurnstileRequired = config.turnstileRequired
      effectiveTurnstileSiteKey = config.turnstileSiteKey
      effectiveLoginEnabled = config.loginEnabled
    }
    if (!effectiveLoginEnabled) {
      await cancelFailedTransition()
      setError('Inicio de sesión temporalmente no disponible.')
      setLoading(false)
      return
    }
    if (effectiveTurnstileRequired && !turnstileToken) {
      if (!effectiveTurnstileSiteKey) {
        await cancelFailedTransition()
        showOfflineFallback('Cloudflare no pudo cargar la verificación')
      } else {
        setError('Completa la verificación de seguridad para iniciar sesión.')
      }
      setLoading(false)
      return
    }
    if (transitionKind !== 'reauth') {
      try {
        await invalidateOfflineBeforeIdentityChange()
      } catch {
        await cancelFailedTransition()
        setError('No se pudo bloquear la sesión offline anterior. Cierra las otras pestañas de Clarin y vuelve a intentarlo antes de cambiar de usuario.')
        setOfflineOffer(false)
        setLoading(false)
        return
      }
    }
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          password,
          turnstile_token: turnstileToken,
          ...(reauthExpectation ? {
            offline_reauth_user_id: reauthExpectation.user_id,
            offline_reauth_account_id: reauthExpectation.account_id,
          } : {}),
        }),
        credentials: 'include',
      })
      const contentType = res.headers.get('content-type') || ''
      const data = contentType.includes('application/json') ? await res.json().catch(() => ({})) : {}
      const trustedClarinResponse = contentType.includes('application/json') && res.headers.get('X-Clarin-Response') === '1'
      if (!trustedClarinResponse) {
        await cancelFailedTransition()
        showOfflineFallback('Clarin o la protección de acceso no devolvieron una respuesta verificable')
        resetTurnstile()
        return
      }
      if (!data.success) {
        const classification = classifyRemoteResponse(res.status, contentType, res.headers.get('X-Clarin-Response'), data)
        if (classification.state === 'infrastructure_unavailable') {
          await cancelFailedTransition()
          showOfflineFallback('Clarin o la protección de acceso no están respondiendo')
          resetTurnstile()
          return
        }
        await cancelFailedTransition()
        const identityMismatch = data.code === 'offline_identity_mismatch' || data.error === 'offline_identity_mismatch'
        setError(identityMismatch ? 'Las credenciales pertenecen a otra identidad o cuenta. Para proteger la copia local, inicia sesión con el mismo usuario y cuenta.' : data.error || 'Error al iniciar sesión')
        setOfflineOffer(false)
        resetTurnstile()
        return
      }
      if (reauthExpectation && (data.user?.id !== reauthExpectation.user_id || data.user?.account_id !== reauthExpectation.account_id)) {
        await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => null)
        await cancelFailedTransition()
        setError('Clarin no pudo confirmar la misma identidad y cuenta. La sesión online fue descartada.')
        setPassword('')
        resetTurnstile()
        return
      }
      if (transitionKind) {
        try {
          await completeOfflineV5OnlineTransition()
        } catch {
          await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => null)
          await cancelFailedTransition()
          setError('La identidad fue validada, pero el navegador no pudo cerrar el modo offline de forma segura. Tu copia local continúa disponible.')
          setPassword('')
          resetTurnstile()
          return
        }
      }
      if (reauthExpectation) clearOfflineReauthExpectation(window.sessionStorage)
      markAuthTokenRefreshed()
      const next = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('next') : ''
      const safeNext = next && (
        next === WHITEBOARD_PUBLIC_LIBRARY_CALLBACK_PATH
        || next.startsWith('/oauth/authorize')
        || next.startsWith('https://clarin.naperu.cloud/oauth/authorize')
      ) ? next : '/dashboard'
      if (safeNext.startsWith('/oauth/authorize') || safeNext.startsWith('https://clarin.naperu.cloud/oauth/authorize')) {
        window.location.assign(safeNext)
        return
      }
      router.push(safeNext)
      router.refresh()
    } catch {
      await cancelFailedTransition()
      showOfflineFallback('No se pudo conectar con Clarin')
      resetTurnstile()
    } finally {
      setLoading(false)
    }
  }

  const completeOfflineEntry = (snapshot: RuntimeSnapshot) => {
    if (!snapshot.active || snapshot.mode !== 'offline') {
      throw new Error('No hay una copia offline vigente y preparada para esta cuenta en este perfil del navegador.')
    }
    clearOfflineReauthExpectation(window.sessionStorage)
    setPassword('')
    setOfflineAccounts([])
    // A client transition keeps the unlocked SharedWorker port alive while the
    // canonical dashboard mounts. A full reload would intentionally lock it.
    router.push('/dashboard')
  }

  const enterOffline = async () => {
    if (offlineChecking) return
    if (!username.trim() || !password) {
      setError('Escribe tu usuario y tu contraseña actual de Clarin para desbloquear únicamente tus copias offline.')
      return
    }
    setOfflineChecking(true)
    setError('')
    try {
      const result = await unlockOfflineV5User(username.trim(), password)
      setPassword('')
      if (result.snapshot) {
        completeOfflineEntry(getOfflineV5RuntimeSnapshot())
        return
      }
      if (result.accounts.length < 2) {
        throw new Error('No hay una copia offline vigente y preparada para este usuario en este perfil del navegador.')
      }
      setOfflineAccounts(result.accounts)
    } catch (offlineError) {
      setOfflineAccounts([])
      setError((offlineError as Error).message || 'No se pudo abrir la copia offline autorizada.')
    } finally {
      setOfflineChecking(false)
    }
  }

  const selectOfflineAccount = async (grantId: string) => {
    if (offlineChecking) return
    setOfflineChecking(true)
    setError('')
    try {
      completeOfflineEntry(await selectOfflineV5Account(grantId))
    } catch (offlineError) {
      setError((offlineError as Error).message || 'No se pudo abrir esa cuenta offline.')
    } finally {
      setOfflineChecking(false)
    }
  }

  const startFreshOnlineLogin = async () => {
    if (offlineChecking || loading) return
    setOfflineChecking(true)
    setError('')
    try {
      clearOfflineReauthExpectation(window.sessionStorage)
      await beginOfflineV5OnlineTransition()
      const config = await loadSecurityConfig()
      if (!config) {
        await cancelOfflineV5OnlineTransition().catch(() => undefined)
        setOfflineOffer(true)
        setError('No se pudo comprobar la conexión online. Tus copias offline no cambiaron.')
        return
      }
      setOfflineReauth(null)
      setOfflineReauthRequested(false)
      setOfflineFreshLoginRequested(true)
      setOfflineOffer(false)
      router.replace('/login?offline_fresh_login=1')
    } catch (transitionError) {
      setError(transitionError instanceof Error ? transitionError.message : 'No se pudo abrir el acceso online. Tus copias offline no cambiaron.')
    } finally {
      setOfflineChecking(false)
    }
  }

  const cancelOnlineTransition = async () => {
    if (offlineChecking || loading) return
    setOfflineChecking(true)
    setError('')
    try {
      await cancelOfflineV5OnlineTransition()
      clearOfflineReauthExpectation(window.sessionStorage)
      setOfflineReauth(null)
      setOfflineReauthRequested(false)
      setOfflineFreshLoginRequested(false)
      setPassword('')
      if (getOfflineV5RuntimeSnapshot().active) {
        router.replace('/dashboard')
      } else {
        setOfflineOffer(true)
        router.replace('/login')
      }
    } catch (transitionError) {
      setError(transitionError instanceof Error ? transitionError.message : 'No se pudo cancelar la transición. Tu copia offline no fue descartada.')
    } finally {
      setOfflineChecking(false)
    }
  }

  const waitForOnline = () => {
    offlineOfferCheckRef.current++
    offlineOfferForcedRef.current = false
    offlineOfferDismissedRef.current = true
    void browserOfflineV5Client.lock().catch(() => {})
    void dismissOfflineV5FallbackOffer().catch(() => {})
    setOfflineAccounts([])
    setOfflineOffer(false)
    setError('')
    resetTurnstile()
  }

  return (
    <main className="app-viewport overflow-y-auto bg-slate-50">
      {turnstileSiteKey && (
        <Script
          src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
          strategy="afterInteractive"
          onLoad={() => setTurnstileReady(true)}
          onError={() => {
            setTurnstileReady(false)
            showOfflineFallback('Cloudflare no pudo cargar la verificación')
          }}
        />
      )}
      <section className="mx-auto flex min-h-full w-full max-w-sm flex-col justify-center px-4 py-[max(2rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))]">
        <div className="mb-6 flex flex-col items-center text-center sm:mb-8">
          <ClarinBrandMark label="Clarín" className="h-12 w-12 rounded-xl shadow-sm" />
          <h1 className="mt-4 text-2xl font-bold text-slate-900">Clarin</h1>
          <p className="mt-1 text-sm text-slate-500">Ingresa a tu dashboard</p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
          {notice && (
            <div role="status" className="mb-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              {notice}
            </div>
          )}
          {sessionNotice && (
            <div role="status" className="mb-5 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800">
              {sessionNotice}
            </div>
          )}
          {offlineReauthRequested && offlineReauth && (
            <div role="status" className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
              <p>Por seguridad, vuelve a autenticar exactamente el mismo usuario y la misma cuenta que estaban abiertos offline.</p>
              <button type="button" disabled={offlineChecking || loading} onClick={() => void cancelOnlineTransition()} className="mt-2 min-h-10 rounded-lg border border-emerald-200 bg-white px-3 font-semibold disabled:opacity-50">Cancelar y volver offline</button>
            </div>
          )}
          {offlineFreshLoginRequested && (
            <div role="status" className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
              <p>Inicia una sesión online nueva. La sesión que pudiera existir en las cookies no se abrirá automáticamente.</p>
              <button type="button" disabled={offlineChecking || loading} onClick={() => void cancelOnlineTransition()} className="mt-2 min-h-10 rounded-lg border border-emerald-200 bg-white px-3 font-semibold disabled:opacity-50">Cancelar y elegir modo offline</button>
            </div>
          )}
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm mb-5">
              {error}
            </div>
          )}

          {offlineOffer && username.trim() && !offlineReauthRequested && !offlineFreshLoginRequested && (
            <div className="mb-5 rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900">
              <div className="flex gap-2"><WifiOff className="mt-0.5 h-4 w-4 shrink-0" /><span>El modo offline solo abrirá copias previamente aprobadas y preparadas para tu usuario en este perfil del navegador.</span></div>
              {offlineAccounts.length > 0 ? <div className="mt-3 space-y-2" role="group" aria-label="Cuentas offline verificadas">
                <p className="text-xs font-semibold text-sky-800">Identidad verificada. Elige la cuenta que necesitas:</p>
                {offlineAccounts.map(account => <button key={account.grantId} type="button" disabled={offlineChecking} onClick={() => void selectOfflineAccount(account.grantId)} className="flex min-h-11 w-full items-center justify-between rounded-lg bg-slate-900 px-4 text-left font-semibold text-white disabled:opacity-50"><span className="truncate">{account.accountName}</span><ArrowRight className="h-4 w-4 shrink-0" /></button>)}
              </div> : <button type="button" onClick={() => void enterOffline()} disabled={offlineChecking} className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 font-semibold text-white disabled:opacity-50">
                <ShieldCheck className="h-4 w-4" />{offlineChecking ? 'Comprobando copia local…' : 'Entrar en modo offline'}
              </button>}
              <button type="button" disabled={offlineChecking || loading} onClick={() => void startFreshOnlineLogin()} className="mt-2 min-h-11 w-full rounded-lg border border-sky-300 bg-white font-semibold text-sky-950 disabled:opacity-50">Iniciar sesión online</button>
              <button type="button" disabled={offlineChecking} onClick={waitForOnline} className="mt-2 min-h-11 w-full rounded-lg border border-sky-200 bg-white text-sm text-sky-900">Prefiero esperar</button>
            </div>
          )}

          <form onSubmit={handleLogin} className="space-y-5">
            <div>
              <label className="block text-xs font-medium text-slate-500 uppercase tracking-wider mb-1.5">
                Usuario
              </label>
              <div className="relative">
                <User className="absolute left-3.5 top-1/2 -translate-y-1/2 w-[18px] h-[18px] text-slate-400" />
                <input
                  type="text"
                  value={username}
                  onChange={(e) => {
                    if (offlineAccounts.length) {
                      void browserOfflineV5Client.lock().catch(() => {})
                      setOfflineAccounts([])
                    }
                    setUsername(e.target.value)
                  }}
                  placeholder="usuario o correo"
                  className="w-full pl-11 pr-4 py-3 bg-white border border-slate-300 text-slate-900 placeholder:text-slate-400 rounded-lg focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 outline-none transition-all text-base sm:text-sm"
                  required
                  disabled={loading}
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-500 uppercase tracking-wider mb-1.5">
                Contraseña
              </label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-[18px] h-[18px] text-slate-400" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => {
                    if (offlineAccounts.length) {
                      void browserOfflineV5Client.lock().catch(() => {})
                      setOfflineAccounts([])
                    }
                    setPassword(e.target.value)
                  }}
                  placeholder="tu contraseña"
                  className="w-full pl-11 pr-12 py-3 bg-white border border-slate-300 text-slate-900 placeholder:text-slate-400 rounded-lg focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 outline-none transition-all text-base sm:text-sm"
                  required
                  disabled={loading}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-1 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-50 hover:text-slate-600"
                  aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                  disabled={loading}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {turnstileRequired && (
              <div className="min-h-[70px] min-w-0 overflow-hidden flex items-center justify-center">
                {turnstileSiteKey && loginEnabled ? (
                  <div ref={turnstileRef} className="w-full min-w-0" />
                ) : (
                  <div className="w-full rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                    Estamos activando el inicio de sesión seguro.
                  </div>
                )}
              </div>
            )}

            <button
              type="submit"
              className="w-full bg-emerald-600 hover:bg-emerald-700 text-white py-3 rounded-lg font-semibold transition-colors disabled:opacity-50 flex items-center justify-center gap-2 shadow-sm"
              disabled={loading || !loginEnabled || (offlineReauthRequested && !offlineReauth) || (turnstileRequired && !turnstileSiteKey)}
            >
              {loading ? (
                <span className="animate-spin rounded-full h-5 w-5 border-2 border-white/30 border-t-white" />
              ) : (
                <>
                  Iniciar sesión <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>
        </div>
      </section>
    </main>
  )
}
