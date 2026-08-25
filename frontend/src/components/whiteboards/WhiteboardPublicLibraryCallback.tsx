'use client'

import { useEffect, useState } from 'react'
import { AlertTriangle, LibraryBig, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { tryRefreshTokenOutcome, type AuthRefreshOutcome } from '@/lib/api'
import {
  buildWhiteboardPublicLibraryLoginPath,
  buildWhiteboardPublicLibraryReturnPath,
  isWhiteboardPublicLibraryIdentifier,
  parseWhiteboardPublicLibraryCallbackFragment,
  WHITEBOARD_PUBLIC_LIBRARY_CALLBACK_STORAGE_KEY,
  WHITEBOARD_PUBLIC_LIBRARY_CALLBACK_TTL_MS,
  whiteboardPublicLibraryCallbackError,
  type WhiteboardPublicLibraryCallbackTokens,
} from '@/lib/whiteboardPublicLibraries'
import { submitWhiteboardPublicLibraryCallback } from '@/lib/whiteboardPublicLibrariesApi'

type CallbackPhase = 'validating' | 'redirecting' | 'error'

export interface WhiteboardPublicLibraryCallbackRuntime {
  identity: () => string
  readHash: () => string
  clearHash: () => void
  navigate: (path: string) => void
  readSession: (key: string) => string | null
  writeSession: (key: string, value: string) => void
  removeSession: (key: string) => void
  refreshSession: () => Promise<AuthRefreshOutcome>
}

interface PendingCallback {
  createdAt: number
  tokens: WhiteboardPublicLibraryCallbackTokens
  stored: boolean
  inFlight?: Promise<string>
}

const pendingCallbacks = new Map<string, PendingCallback>()
class PublicLibraryCallbackError extends Error {
  readonly retryable: boolean
  readonly authRequired: boolean

  constructor(message: string, retryable: boolean, authRequired = false) {
    super(message)
    this.retryable = retryable
    this.authRequired = authRequired
  }
}

export function refreshWhiteboardPublicLibraryCallbackSession() {
  return tryRefreshTokenOutcome({ redirectOnIdle: false })
}

const browserRuntime: WhiteboardPublicLibraryCallbackRuntime = {
  identity: () => `${window.location.pathname}${window.location.search}`,
  readHash: () => window.location.hash,
  clearHash: () => {
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`)
  },
  navigate: path => window.location.replace(path),
  readSession: key => window.sessionStorage.getItem(key),
  writeSession: (key, value) => window.sessionStorage.setItem(key, value),
  removeSession: key => window.sessionStorage.removeItem(key),
  refreshSession: refreshWhiteboardPublicLibraryCallbackSession,
}

function removeStoredCallback(runtime: WhiteboardPublicLibraryCallbackRuntime) {
  try {
    runtime.removeSession(WHITEBOARD_PUBLIC_LIBRARY_CALLBACK_STORAGE_KEY)
  } catch {
    // A disabled storage implementation must not keep the fragment in the URL.
  }
}

function storeCallback(runtime: WhiteboardPublicLibraryCallbackRuntime, key: string, pending: PendingCallback) {
  try {
    runtime.writeSession(WHITEBOARD_PUBLIC_LIBRARY_CALLBACK_STORAGE_KEY, JSON.stringify({
      createdAt: pending.createdAt,
      identity: key,
      tokens: pending.tokens,
    }))
    return true
  } catch {
    // Memory still covers a same-document remount; login recovery will not be
    // offered unless sessionStorage accepted the bounded callback.
    return false
  }
}

function readStoredCallback(runtime: WhiteboardPublicLibraryCallbackRuntime, key: string): PendingCallback | null {
  try {
    const raw = runtime.readSession(WHITEBOARD_PUBLIC_LIBRARY_CALLBACK_STORAGE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as {
      createdAt?: unknown
      identity?: unknown
      tokens?: { token?: unknown; libraryURL?: unknown }
    }
    if (value.identity !== key || typeof value.createdAt !== 'number'
      || Date.now() - value.createdAt > WHITEBOARD_PUBLIC_LIBRARY_CALLBACK_TTL_MS
      || typeof value.tokens?.token !== 'string' || typeof value.tokens.libraryURL !== 'string') {
      removeStoredCallback(runtime)
      return null
    }
    const parsed = parseWhiteboardPublicLibraryCallbackFragment(
      `#addLibrary=${encodeURIComponent(value.tokens.libraryURL)}&token=${encodeURIComponent(value.tokens.token)}`,
    )
    if (!parsed.ok) {
      removeStoredCallback(runtime)
      return null
    }
    return { createdAt: value.createdAt, tokens: parsed.tokens, stored: true }
  } catch {
    removeStoredCallback(runtime)
    return null
  }
}

function prepareCallback(runtime: WhiteboardPublicLibraryCallbackRuntime) {
  const key = runtime.identity()
  const fragment = runtime.readHash()

  // A newly returned credential always wins over callback memory. The map is
  // only for remounts/retries after the browser has already removed the hash.
  // Otherwise a failed prior import could shadow a later catalog selection.
  if (fragment) {
    const parsed = parseWhiteboardPublicLibraryCallbackFragment(fragment)
    runtime.clearHash()
    pendingCallbacks.delete(key)
    if (!parsed.ok) {
      removeStoredCallback(runtime)
      return { key, error: parsed.error }
    }
    const pending: PendingCallback = { createdAt: Date.now(), tokens: parsed.tokens, stored: false }
    pending.stored = storeCallback(runtime, key, pending)
    pendingCallbacks.set(key, pending)
    return { key, pending }
  }

  const existing = pendingCallbacks.get(key)
  if (existing && Date.now() - existing.createdAt <= WHITEBOARD_PUBLIC_LIBRARY_CALLBACK_TTL_MS) return { key, pending: existing }
  if (existing) pendingCallbacks.delete(key)
  const stored = readStoredCallback(runtime, key)
  if (stored) {
    pendingCallbacks.set(key, stored)
    return { key, pending: stored }
  }
  return { key, error: 'El enlace de la biblioteca no contiene las credenciales esperadas.' }
}

async function submitPreparedCallback(pending: PendingCallback, runtime: WhiteboardPublicLibraryCallbackRuntime) {
  if (!pending.inFlight) {
    pending.inFlight = (async () => {
      let response = await submitWhiteboardPublicLibraryCallback(pending.tokens)
      if (!response.success && response.status === 401) {
        const refreshOutcome = await runtime.refreshSession().catch(() => 'unavailable' as const)
        if (refreshOutcome === 'expired') {
          throw new PublicLibraryCallbackError(
            'Tu sesión expiró. Inicia sesión para continuar la importación.',
            false,
            true,
          )
        }
        if (refreshOutcome === 'unavailable') {
          throw new PublicLibraryCallbackError(
            'No se pudo verificar tu sesión temporalmente. Reintenta cuando se recupere la conexión.',
            true,
          )
        }
        response = await submitWhiteboardPublicLibraryCallback(pending.tokens)
      }
      if (!response.success && response.status === 401) {
        throw new PublicLibraryCallbackError(
          'Tu sesión expiró. Inicia sesión para continuar la importación.',
          false,
          true,
        )
      }
      const boardID = response.data?.board_id
      const importID = response.data?.import_id
      if (!response.success) {
        const retryableConflict = response.status === 409
          && response.data?.code === 'whiteboard_library_import_unavailable'
        throw new PublicLibraryCallbackError(
          whiteboardPublicLibraryCallbackError(response.status),
          response.status === undefined || response.status === 429 || response.status >= 500 || retryableConflict,
        )
      }
      if (!isWhiteboardPublicLibraryIdentifier(boardID) || !isWhiteboardPublicLibraryIdentifier(importID)) {
        throw new Error('Clarin no pudo confirmar el destino seguro de la biblioteca.')
      }
      const returnPath = buildWhiteboardPublicLibraryReturnPath(boardID, importID)
      if (!returnPath) throw new Error('Clarin no pudo confirmar el destino seguro de la biblioteca.')
      return returnPath
    })().finally(() => {
      pending.inFlight = undefined
    })
  }
  return pending.inFlight
}

export default function WhiteboardPublicLibraryCallback({
  runtime = browserRuntime,
}: {
  runtime?: WhiteboardPublicLibraryCallbackRuntime
}) {
  const [phase, setPhase] = useState<CallbackPhase>('validating')
  const [error, setError] = useState<string | null>(null)
  const [canRetry, setCanRetry] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let active = true
    const prepared = prepareCallback(runtime)
    if (!prepared.pending) {
      setPhase('error')
      setError(prepared.error || 'El enlace de la biblioteca no es válido.')
      setCanRetry(false)
      return () => { active = false }
    }

    setPhase('validating')
    setError(null)
    setCanRetry(false)
    void submitPreparedCallback(prepared.pending, runtime)
      .then(path => {
        if (!active) return
        setPhase('redirecting')
        pendingCallbacks.delete(prepared.key)
        removeStoredCallback(runtime)
        runtime.navigate(path)
      })
      .catch(callbackError => {
        if (!active) return
        if (callbackError instanceof PublicLibraryCallbackError && callbackError.authRequired) {
          if (!prepared.pending.stored) {
            setPhase('error')
            setCanRetry(false)
            setError('Tu sesión expiró y el navegador no permitió conservar este callback. Vuelve a abrir el catálogo desde la pizarra.')
            return
          }
          setPhase('redirecting')
          runtime.navigate(buildWhiteboardPublicLibraryLoginPath())
          return
        }
        setPhase('error')
        setCanRetry(callbackError instanceof PublicLibraryCallbackError ? callbackError.retryable : false)
        if (!(callbackError instanceof PublicLibraryCallbackError) || !callbackError.retryable) {
          removeStoredCallback(runtime)
        }
        setError(callbackError instanceof Error
          ? callbackError.message
          : 'No se pudo validar la biblioteca.')
      })
    return () => { active = false }
  }, [attempt, runtime])

  return <main className="flex min-h-[calc(100vh-4rem)] items-center justify-center bg-slate-50 p-4 sm:p-6">
    <section
      aria-labelledby="public-library-callback-title"
      aria-busy={phase !== 'error'}
      className="w-full max-w-lg rounded-3xl border border-slate-200 bg-white p-6 text-center shadow-xl shadow-slate-200/60 sm:p-8"
    >
      <span className={`mx-auto flex h-14 w-14 items-center justify-center rounded-2xl ${phase === 'error' ? 'bg-rose-50 text-rose-600' : phase === 'redirecting' ? 'bg-emerald-50 text-emerald-700' : 'bg-indigo-50 text-indigo-700'}`}>
        {phase === 'error'
          ? <AlertTriangle className="h-6 w-6" aria-hidden="true" />
          : phase === 'redirecting'
            ? <ShieldCheck className="h-6 w-6" aria-hidden="true" />
            : <LibraryBig className="h-6 w-6" aria-hidden="true" />}
      </span>
      <h1 id="public-library-callback-title" className="mt-5 text-xl font-black text-slate-900">
        {phase === 'error' ? 'No se pudo importar la biblioteca' : phase === 'redirecting' ? 'Biblioteca validada' : 'Validando biblioteca'}
      </h1>
      <p className={`mt-2 text-sm leading-6 ${phase === 'error' ? 'text-rose-700' : 'text-slate-500'}`} role={phase === 'error' ? 'alert' : 'status'}>
        {phase === 'error'
          ? error
          : phase === 'redirecting'
            ? 'Volviendo a la pizarra para añadir los elementos a Mi biblioteca…'
            : 'Clarin está descargando y revisando el archivo en el servidor. Tu navegador no se conecta directamente al archivo externo.'}
      </p>

      {phase === 'validating' && <Loader2 className="mx-auto mt-6 h-6 w-6 animate-spin text-indigo-600" aria-hidden="true" />}
      {phase === 'redirecting' && <Loader2 className="mx-auto mt-6 h-6 w-6 animate-spin text-emerald-600" aria-hidden="true" />}
      {phase === 'error' && <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-center">
        <a href="/dashboard/whiteboards" className="inline-flex min-h-11 items-center justify-center rounded-xl border border-slate-200 px-4 text-sm font-bold text-slate-600 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">Volver a Pizarras</a>
        {canRetry && <button type="button" onClick={() => setAttempt(value => value + 1)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 text-sm font-black text-white hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2">
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Reintentar
        </button>}
      </div>}

      <p className="mt-6 border-t border-slate-100 pt-4 text-xs leading-5 text-slate-400">
        Sólo se aceptan bibliotecas compatibles, de tamaño limitado y sin contenido ejecutable ni recursos remotos.
      </p>
    </section>
  </main>
}

export function resetWhiteboardPublicLibraryCallbackMemoryForTests() {
  pendingCallbacks.clear()
}
