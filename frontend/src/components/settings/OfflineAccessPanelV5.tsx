'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, CloudOff, HardDrive, Loader2, LockKeyhole, RefreshCw, Search, ShieldCheck } from 'lucide-react'
import { browserOfflineV5Client } from '@/offline-v5/client'
import { OfflineV5Error } from '@/offline-v5/types'
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '@/lib/useDebouncedValue'
import {
  enrollmentStatusV5,
  grantSelectionV5,
  offlineAvailabilityV5,
  onlineGrantsV5,
  resourceCandidatesV5,
  type OfflineEnrollmentV5,
  type OfflineGrantV5,
} from '@/components/offline-v5/online'
import {
  offlineModulesV5,
  offlineV5PreparationNotice,
  offlineV5ResourceKey,
  offlineV5ResourceLabel,
  reconcileOfflineV5ResourceLabels,
  toggleOfflineV5Resource,
  type OfflineV5Module,
  type OfflineV5Resource,
} from '@/components/offline-v5/uiState'

type LocalGrant = { grantId: string; state: 'preparing' | 'available' | 'revoked' | 'expired'; label?: string }
type PreparationState = { completed: number; total: number }

const secondary = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-50'
const primary = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50'

function requestStateLabel(state: string) {
  return ({
    requested: 'Pendiente de aprobación',
    pending: 'Pendiente de aprobación',
    approved: 'Autorizado',
    active: 'Autorizado',
    available: 'Copia preparada',
    preparing: 'Preparando copia',
    expired: 'Autorización vencida',
    revoked: 'Revocado',
    rejected: 'Rechazado',
  } as Record<string, string>)[state] || 'No disponible'
}

export function offlineV5PasswordValidation(password: string) {
  if ([...password].length < 10) return 'Tu contraseña actual de Clarín debe tener al menos 10 caracteres.'
  if (new TextEncoder().encode(password).byteLength > 72) return 'Tu contraseña actual de Clarín no puede superar 72 bytes en UTF-8.'
  return ''
}

export function offlineV5CanReloadSelection(errorCode: string) {
  return errorCode === 'offline_selection_changed'
}

export function offlineV5CanReloadPage(errorCode: string) {
  return errorCode === 'worker_update_required' || errorCode === 'worker_unavailable'
}

export default function OfflineAccessPanelV5({ currentLogin, currentUserID }: { currentLogin: string; currentUserID: string }) {
  const [enabled, setEnabled] = useState(false)
  const [prepareEnabled, setPrepareEnabled] = useState(false)
  const [browserSupported, setBrowserSupported] = useState(true)
  const [persistent, setPersistent] = useState(false)
  const [request, setRequest] = useState<OfflineEnrollmentV5 | null>(null)
  const [grants, setGrants] = useState<OfflineGrantV5[]>([])
  const [local, setLocal] = useState<LocalGrant[]>([])
  const [grantID, setGrantID] = useState('')
  const [module, setModule] = useState<OfflineV5Module>('tasks')
  const [selection, setSelection] = useState<OfflineV5Resource[]>([])
  const [selectionRevision, setSelectionRevision] = useState(0)
  const [selectionScope, setSelectionScope] = useState('')
  const [selectionLoading, setSelectionLoading] = useState(false)
  const [selectionLoaded, setSelectionLoaded] = useState(false)
  const [selectionAttempt, setSelectionAttempt] = useState(0)
  const [selectionDirty, setSelectionDirty] = useState(false)
  const [candidates, setCandidates] = useState<OfflineV5Resource[]>([])
  const [candidateScope, setCandidateScope] = useState('')
  const [cursor, setCursor] = useState('')
  const [query, setQuery] = useState('')
  const [settledQuery] = useDebouncedValue(query, SEARCH_DEBOUNCE_MS)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [preparing, setPreparing] = useState<PreparationState | null>(null)
  const [busy, setBusy] = useState('refresh')
  const [error, setError] = useState('')
  const [errorCode, setErrorCode] = useState('')
  const [notice, setNotice] = useState('')
  const [password, setPassword] = useState('')
  const mounted = useRef(false)
  const refreshRequest = useRef<AbortController | null>(null)
  const candidatesRequest = useRef<AbortController | null>(null)

  const grant = grants.find(item => item.grant_id === grantID)
  const allowedModules = offlineModulesV5.filter(item => grant?.modules?.includes(item.id))
  const localGrant = local.find(item => item.grantId === grantID)
  const ready = localGrant?.state === 'available' && !selectionDirty
  const visibleCandidates = candidateScope === `${grantID}:${module}:${settledQuery}` ? candidates : []
  const maximum = Math.min(20, Math.max(0, grant?.max_resources || 20))

  const refresh = useCallback(async () => {
    refreshRequest.current?.abort()
    const controller = new AbortController()
    refreshRequest.current = controller
    setBusy('refresh')
    setError('')
    setErrorCode('')
    try {
      const availability = await offlineAvailabilityV5(controller.signal)
      if (controller.signal.aborted) return
      setEnabled(availability.enabled)
      setPrepareEnabled(availability.prepare_enabled)
      if (!availability.enabled) {
        setGrants([])
        return
      }

      const supported = typeof SharedWorker !== 'undefined'
        && typeof indexedDB !== 'undefined'
        && Boolean(globalThis.crypto?.subtle)
        && globalThis.isSecureContext
      setBrowserSupported(supported)
      if (!supported) return
      const persistence = await navigator.storage?.persisted?.().catch(() => false)
      if (!controller.signal.aborted) setPersistent(Boolean(persistence))

      const profile = await browserOfflineV5Client.profile()
      const page = await onlineGrantsV5(profile.browser_profile_id, controller.signal)
      if (controller.signal.aborted) return
      const active = page.items.filter(item => item.state !== 'revoked')
      await browserOfflineV5Client.reconcileLocalGrants(currentUserID, active.map(item => item.grant_id))
      const copies = await browserOfflineV5Client.listLocalGrants()
      if (controller.signal.aborted) return
      setGrants(active)
      setLocal(copies as LocalGrant[])
      setGrantID(current => active.some(item => item.grant_id === current) ? current : active[0]?.grant_id || '')
      if (active.length) setRequest(null)
    } catch (refreshError) {
      if (!controller.signal.aborted) {
        setErrorCode(refreshError instanceof OfflineV5Error ? refreshError.code : '')
        setError(refreshError instanceof Error ? refreshError.message : 'No se pudo comprobar el acceso offline.')
      }
    } finally {
      if (!controller.signal.aborted && mounted.current) setBusy('')
    }
  }, [currentUserID])

  useEffect(() => {
    mounted.current = true
    let unsubscribe = () => {}
    try {
      unsubscribe = browserOfflineV5Client.subscribe(state => {
        const progress = (state as { preparing?: PreparationState }).preparing
        setPreparing(progress || null)
      })
    } catch {
      setBrowserSupported(false)
    }
    void refresh()
    return () => {
      mounted.current = false
      refreshRequest.current?.abort()
      candidatesRequest.current?.abort()
      unsubscribe()
    }
  }, [refresh])

  useEffect(() => {
    if (!request || !['requested', 'pending'].includes(request.state)) return
    const controller = new AbortController()
    const timer = window.setInterval(() => {
      void enrollmentStatusV5(request.id, controller.signal).then(result => {
        if (controller.signal.aborted) return
        setRequest(result.request)
        if (result.request.state === 'approved') void refresh()
      }).catch(() => {})
    }, 5_000)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [refresh, request])

  useEffect(() => {
    setSelection([])
    setSelectionRevision(0)
    setSelectionDirty(false)
    setSelectionLoaded(false)
    setSelectionScope('')
    setPassword('')
    setNotice('')
    setError('')
    setErrorCode('')
    if (!grantID) {
      setSelectionLoading(false)
      return
    }
    const controller = new AbortController()
    setSelectionLoading(true)
    void grantSelectionV5(grantID, controller.signal).then(result => {
      if (controller.signal.aborted) return
      setSelection(result.items)
      setSelectionRevision(result.selection_revision)
      setSelectionLoaded(true)
      setSelectionScope(grantID)
    }).catch(selectionError => {
      if (!controller.signal.aborted) { setErrorCode(''); setError(selectionError instanceof Error ? selectionError.message : 'No se pudo cargar la selección.') }
    }).finally(() => {
      if (!controller.signal.aborted) setSelectionLoading(false)
    })
    return () => controller.abort()
  }, [grantID, selectionAttempt])

  useEffect(() => {
    if (!allowedModules.some(item => item.id === module)) setModule(allowedModules[0]?.id || 'tasks')
  }, [allowedModules, module])

  const loadCandidates = useCallback(async (after = '') => {
    candidatesRequest.current?.abort()
    const controller = new AbortController()
    candidatesRequest.current = controller
    if (!grantID || !grant?.modules?.includes(module)) {
      setCandidates([])
      setCursor('')
      return
    }
    setSearching(true)
    setSearchError('')
    if (!after) {
      setCandidates([])
      setCursor('')
    }
    try {
      const result = await resourceCandidatesV5(grantID, module, settledQuery, after, controller.signal)
      if (controller.signal.aborted) return
      setCandidateScope(`${grantID}:${module}:${settledQuery}`)
      setCandidates(current => after
        ? [...new Map([...current, ...result.items].map(item => [offlineV5ResourceKey(item), item])).values()]
        : result.items)
      setCursor(result.next_cursor || '')
    } catch (candidateError) {
      if (!controller.signal.aborted) setSearchError(candidateError instanceof Error ? candidateError.message : 'No se pudieron buscar recursos.')
    } finally {
      if (!controller.signal.aborted) setSearching(false)
    }
  }, [grant?.modules, grantID, module, settledQuery])

  useEffect(() => {
    void loadCandidates()
    return () => candidatesRequest.current?.abort()
  }, [loadCandidates])

  async function requestAccess() {
    if (busy) return
    setBusy('request')
    setError('')
    setErrorCode('')
    try {
      const result = await browserOfflineV5Client.enroll()
      if (mounted.current) setRequest(result as OfflineEnrollmentV5)
      await refresh()
    } catch (requestError) {
      if (mounted.current) { setErrorCode(''); setError(requestError instanceof Error ? requestError.message : 'No se pudo solicitar la autorización.') }
    } finally {
      if (mounted.current) setBusy('')
    }
  }

  async function prepare() {
    if (!grant || busy || selectionLoading || !selectionLoaded) return
    const validation = offlineV5PasswordValidation(password)
    if (validation) {
      setErrorCode('')
      setError(validation)
      return
    }
    if (!selection.length) {
      setErrorCode('')
      setError('Elige al menos un recurso autorizado para preparar la copia.')
      return
    }
    const secret = password
    setPassword('')
    setBusy('prepare')
    setError('')
    setErrorCode('')
    setNotice('')
    try {
      await navigator.storage?.persist?.().catch(() => false)
      if (selectionDirty) {
        const result = await browserOfflineV5Client.replaceSelection(grantID, selectionRevision, selection)
        const canonical = result as { items: OfflineV5Resource[]; selection_revision: number }
        if (mounted.current) {
          setSelection(canonical.items ? reconcileOfflineV5ResourceLabels(canonical.items, selection) : selection)
          setSelectionRevision(canonical.selection_revision ?? selectionRevision)
          setSelectionDirty(false)
        }
      }
      const prepared = await browserOfflineV5Client.prepare(grantID, secret)
      const copies = await browserOfflineV5Client.listLocalGrants()
      const isPersistent = await navigator.storage?.persisted?.().catch(() => false)
      if (mounted.current) {
        setLocal(copies as LocalGrant[])
        setPersistent(Boolean(isPersistent))
        setNotice(offlineV5PreparationNotice(prepared.shellActivation))
      }
    } catch (prepareError) {
      await browserOfflineV5Client.lock().catch(() => {})
      if (mounted.current) {
        setErrorCode(prepareError instanceof OfflineV5Error ? prepareError.code : '')
        setError(prepareError instanceof Error ? prepareError.message : 'No se pudo preparar la copia offline.')
      }
    } finally {
      if (mounted.current) setBusy('')
    }
  }

  return <section className="space-y-5 p-4 sm:p-6" aria-label="Acceso offline en este navegador">
    <header className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="flex items-center gap-2 font-semibold text-slate-900"><CloudOff className="h-5 w-5 text-emerald-600" />Clarin offline, en este navegador</h2><p className="mt-1 max-w-3xl text-sm text-slate-600">Sin instalar nada. Un superadmin autoriza este perfil, tu usuario, cada cuenta y sus módulos. Tú eliges hasta 20 recursos concretos; ninguna otra cuenta se guarda.</p></div><button type="button" className={secondary} disabled={Boolean(busy)} onClick={() => void refresh()}><RefreshCw className={`h-4 w-4 ${busy === 'refresh' ? 'animate-spin motion-reduce:animate-none' : ''}`} />Actualizar</button></header>
    {error && <div role="alert" className={`rounded-xl border p-4 text-sm ${offlineV5CanReloadPage(errorCode) ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-red-200 bg-red-50 text-red-700'}`}>{error}{offlineV5CanReloadPage(errorCode) && <button type="button" className="ml-2 font-semibold underline" onClick={() => window.location.reload()}>Recargar ahora</button>}{grantID && offlineV5CanReloadSelection(errorCode) && <button type="button" disabled={Boolean(busy)} className="ml-2 underline" onClick={() => { if (!selectionDirty || window.confirm('¿Descartar el borrador y cargar la selección autorizada?')) setSelectionAttempt(value => value + 1) }}>Volver a cargar selección</button>}</div>}
    {notice && <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">{notice}</div>}
    {busy === 'refresh' && !enabled
      ? <p role="status" className="flex items-center gap-2 p-5 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />Comprobando disponibilidad…</p>
      : !enabled
        ? <p className="rounded-xl border border-slate-200 p-5 text-sm text-slate-600">El acceso offline todavía no está habilitado. Clarin online continúa funcionando normalmente.</p>
        : !browserSupported
          ? <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">Este perfil no dispone del almacenamiento cifrado y la coordinación necesarios. Usa una versión actual de Chrome o Edge fuera del modo privado.</div>
          : <>
            {!persistent && <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><HardDrive className="h-5 w-5 shrink-0" /><span>Clarin solicitará almacenamiento persistente al preparar la copia. Borrar los datos del sitio o usar modo privado puede eliminar datos locales aún no sincronizados.</span></div>}
            <div className="flex flex-col gap-3 rounded-xl border border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-medium text-slate-900">{currentLogin} · Este perfil del navegador</p><p className="mt-1 text-sm text-slate-500">{request ? requestStateLabel(request.state) : grants.length ? 'Autorización disponible' : 'Solicita permiso una sola vez para este usuario en este perfil.'}</p></div><button type="button" className={primary} disabled={Boolean(busy) || request?.state === 'requested' || request?.state === 'pending'} onClick={() => void requestAccess()}>{busy === 'request' ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <ShieldCheck className="h-4 w-4" />}{grants.length ? 'Solicitar otra autorización' : 'Solicitar acceso offline'}</button></div>
            {grants.length === 0
              ? <p className="rounded-xl border border-dashed border-slate-200 p-8 text-center text-sm text-slate-500">Cuando el superadmin apruebe este perfil aparecerán aquí las cuentas y módulos autorizados.</p>
              : <>
                <div><h3 className="mb-2 text-sm font-semibold text-slate-900">1. Elige una cuenta autorizada</h3><div className="flex flex-wrap gap-2" role="group" aria-label="Cuentas autorizadas">{grants.map(item => <button type="button" key={item.grant_id} disabled={Boolean(busy)} aria-pressed={item.grant_id === grantID} onClick={() => { if (!selectionDirty || window.confirm('Hay una selección sin guardar. ¿Descartarla y cambiar de cuenta?')) setGrantID(item.grant_id) }} className={`min-h-11 rounded-lg border px-4 text-sm ${item.grant_id === grantID ? 'border-emerald-500 bg-emerald-50 text-emerald-900' : 'border-slate-200 text-slate-600'}`}>{item.account_name}</button>)}</div></div>
                {grant && selectionScope !== grantID && <p role="status" className="p-4 text-sm text-slate-500">{selectionLoading ? 'Cargando selección de esta cuenta…' : 'No hay una selección verificada. Vuelve a cargarla para continuar.'}</p>}
                {grant && selectionScope === grantID && <div key={grant.grant_id} className="space-y-4 rounded-xl border border-slate-200 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-sm font-semibold text-slate-900">2. Elige qué sincronizar</h3><p className="mt-1 text-xs text-slate-500">Cada recurso elegido conservará sus opciones habituales. Clarin añadirá solo sus dependencias mínimas necesarias.</p></div><span className="text-sm text-slate-500" aria-live="polite">{selection.length} / {maximum} recursos · {grant.account_name}</span></div>
                  <div className="flex flex-wrap gap-2" role="group" aria-label="Tipo de recurso">{allowedModules.map(item => <button type="button" key={item.id} disabled={Boolean(busy)} aria-pressed={item.id === module} className={`rounded-lg px-3 py-2 text-sm ${module === item.id ? 'bg-emerald-50 font-semibold text-emerald-800' : 'text-slate-600'}`} onClick={() => { setModule(item.id); setQuery('') }}>{item.label}</button>)}</div>
                  <label className="relative block"><Search className="absolute left-3 top-3.5 h-4 w-4 text-slate-400" /><input aria-label="Buscar recursos autorizados" value={query} onChange={event => setQuery(event.target.value)} className="min-h-11 w-full rounded-lg border border-slate-200 pl-10 pr-3 text-sm" placeholder="Buscar recursos autorizados…" disabled={Boolean(busy)} /></label>
                  <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-200">{selectionLoading ? <p className="p-5 text-sm text-slate-500">Cargando selección…</p> : visibleCandidates.map(item => { const checked = selection.some(selected => offlineV5ResourceKey(selected) === offlineV5ResourceKey(item)); return <label key={offlineV5ResourceKey(item)} className={`flex min-h-14 items-center gap-3 border-b border-slate-100 p-3 last:border-0 ${checked ? 'bg-emerald-50' : 'bg-white'}`}><input type="checkbox" className="h-4 w-4 accent-emerald-600" checked={checked} disabled={Boolean(busy) || (!checked && selection.length >= maximum)} onChange={() => { setSelection(current => toggleOfflineV5Resource(current, item, maximum)); setSelectionDirty(true); setNotice('') }} /><span className="min-w-0 text-sm"><span className="block break-words font-medium text-slate-800">{offlineV5ResourceLabel(item)}</span>{item.subtitle && <span className="block text-xs text-slate-500">{item.subtitle}</span>}</span></label> })}{searching || query !== settledQuery ? <p role="status" className="p-4 text-sm text-slate-500">Buscando…</p> : searchError ? <div role="alert" className="p-4 text-sm text-red-700">{searchError}<button type="button" className="ml-2 underline" onClick={() => void loadCandidates()}>Reintentar</button></div> : !visibleCandidates.length && <p className="p-5 text-sm text-slate-500">No hay recursos autorizados que coincidan.</p>}{cursor && <button type="button" className="min-h-11 w-full text-sm font-semibold text-emerald-700" disabled={searching || Boolean(busy)} onClick={() => void loadCandidates(cursor)}>Cargar más recursos</button>}</div>
                  {selection.length > 0 && <div className="flex flex-wrap gap-2" aria-label="Recursos seleccionados">{selection.map(item => <button type="button" key={offlineV5ResourceKey(item)} disabled={Boolean(busy)} onClick={() => { setSelection(current => toggleOfflineV5Resource(current, item, maximum)); setSelectionDirty(true); setNotice('') }} className="max-w-full break-words rounded-lg bg-slate-100 px-3 py-2 text-left text-xs text-slate-700" aria-label={`Quitar ${offlineV5ResourceLabel(item)}`}>{offlineV5ResourceLabel(item)} ×</button>)}</div>}
                  <form onSubmit={event => { event.preventDefault(); void prepare() }} autoComplete="on" className="space-y-3 border-t border-slate-100 pt-4"><div><h3 className="text-sm font-semibold text-slate-900">3. Confirma tu identidad con tus credenciales actuales de Clarín</h3><p className="mt-1 text-sm text-slate-600">Usuario de Clarín: <strong className="font-semibold text-slate-900">{currentLogin}</strong></p><p className="mt-1 max-w-3xl text-sm text-slate-500">Usa la misma contraseña con la que inicias sesión en Clarín. No estás creando una contraseña nueva para el modo offline. Se utiliza por HTTPS para verificar tu identidad y localmente para cifrar y desbloquear la copia; no se guarda. La autorización dura como máximo 24 horas y se bloquea tras 30 minutos sin actividad.</p></div><div className="max-w-xl"><label className="text-sm font-medium text-slate-700">Contraseña actual de Clarín<input type="password" value={password} onChange={event => setPassword(event.target.value)} minLength={10} maxLength={72} autoComplete="current-password" disabled={Boolean(busy)} className="mt-1 min-h-11 w-full rounded-lg border border-slate-200 px-3" /></label></div><div className="flex flex-wrap items-center gap-3"><button type="submit" className={primary} disabled={Boolean(busy) || !prepareEnabled || selectionLoading || !selection.length || !password}>{busy === 'prepare' ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : ready ? <CheckCircle2 className="h-4 w-4" /> : <LockKeyhole className="h-4 w-4" />}{ready ? 'Actualizar copia offline' : 'Preparar acceso offline'}</button>{ready && <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-700"><CheckCircle2 className="h-4 w-4" />Lista para usar sin conexión</span>}</div>{busy === 'prepare' && <p role="status" className="text-sm text-slate-500">{preparing ? `Preparando ${preparing.completed} de ${preparing.total} recursos…` : 'Cifrando, guardando y verificando la copia… No cierres esta pestaña.'}</p>}</form>
                </div>}
              </>}
          </>}
  </section>
}
