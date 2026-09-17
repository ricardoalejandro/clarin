'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, CloudOff, HardDrive, Loader2, LockKeyhole, RefreshCw, Search, ShieldCheck } from 'lucide-react'
import { browserOfflineClient } from '@/offline-v4/client'
import type { BrowserCapabilities, BrowserState, LocalGrantSummary } from '@/offline-v4/types'
import type { OfflineModule } from '@/offline-v3/types'
import { setOfflineV4Mode, setOfflineV4NavigationEnabled } from '@/lib/offlineV4ServiceWorker'
import { useDebouncedValue } from '@/lib/useDebouncedValue'
import { enrollmentStatusV4, grantSelectionV4, offlineAvailabilityV4, onlineGrantsV4, resourceCandidatesV4, type EnrollmentV4, type OnlineGrantV4, type ResourceV4, type SelectionV4 } from '@/components/offline-v4/online'
import { offlineModulesV4, reconcileSelectionLabelsV4, resourceKeyV4, resourceLabelV4, stateLabelV4, toggleResourceV4, validateOfflinePasswordV4 } from '@/components/offline-v4/uiState'

const button = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 disabled:opacity-50'
const primary = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white disabled:opacity-50'

export default function OfflineAccessPanelV4({ currentLogin }: { currentLogin: string }) {
  const [capabilities, setCapabilities] = useState<BrowserCapabilities | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [request, setRequest] = useState<EnrollmentV4 | null>(null)
  const [grants, setGrants] = useState<OnlineGrantV4[]>([])
  const [local, setLocal] = useState<LocalGrantSummary[]>([])
  const [grantId, setGrantId] = useState('')
  const [module, setModule] = useState<OfflineModule>('tasks')
  const [selection, setSelection] = useState<ResourceV4[]>([])
  const [revision, setRevision] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [selectionLoading, setSelectionLoading] = useState(false)
  const [selectionLoaded, setSelectionLoaded] = useState(false)
  const [selectionScope, setSelectionScope] = useState('')
  const [selectionAttempt, setSelectionAttempt] = useState(0)
  const [candidates, setCandidates] = useState<ResourceV4[]>([])
  const [candidateScope, setCandidateScope] = useState('')
  const [cursor, setCursor] = useState('')
  const [query, setQuery] = useState('')
  const [settledQuery] = useDebouncedValue(query, 500)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [busy, setBusy] = useState('refresh')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [state, setState] = useState<BrowserState>({ generation: 0, session: null })
  const [shellReady, setShellReady] = useState(false)
  const mounted = useRef(false)
  const refreshRequest = useRef<AbortController | null>(null)
  const candidatesRequest = useRef<AbortController | null>(null)
  const grant = grants.find(item => item.grant_id === grantId)
  const allowedModules = offlineModulesV4.filter(item => grant?.actions.includes(item.action))
  const localGrant = local.find(item => item.grant_id === grantId)
  const ready = localGrant?.state === 'available' && shellReady && !dirty
  const visibleCandidates = candidateScope === `${grantId}:${module}:${settledQuery}` ? candidates : []

  const refresh = useCallback(async () => {
    refreshRequest.current?.abort()
    const controller = new AbortController()
    refreshRequest.current = controller
    setBusy('refresh'); setError('')
    try {
      const availability = await offlineAvailabilityV4(controller.signal)
      if (controller.signal.aborted) return
      setEnabled(availability.enabled)
      if (!availability.enabled) { setGrants([]); return }
      const support = await browserOfflineClient.capabilities()
      if (controller.signal.aborted) return
      setCapabilities(support)
      if (!support.supported) return
      const profile = await browserOfflineClient.profile()
      const [page, copies] = await Promise.all([onlineGrantsV4(profile.browser_profile_id, controller.signal), browserOfflineClient.listLocalGrants()])
      if (controller.signal.aborted) return
      const active = page.items.filter(item => item.state !== 'revoked')
      setGrants(active); setLocal(copies)
      setGrantId(current => active.some(item => item.grant_id === current) ? current : active[0]?.grant_id || '')
      // The profile stores newest requests first, across every local user.
      // Keep that order so a prior approval cannot hide a new pending request.
      setRequest(null)
      for (const id of profile.request_ids) {
        try {
          const result = await enrollmentStatusV4(id, controller.signal)
          if (!controller.signal.aborted) setRequest(result.request)
          break
        } catch (statusError) { if (controller.signal.aborted) throw statusError }
      }
      if (copies.some(item => item.state === 'available')) {
        const verified = await setOfflineV4NavigationEnabled(true)
        if (!controller.signal.aborted) setShellReady(verified)
      }
    } catch (refreshError) {
      if (!controller.signal.aborted) setError((refreshError as Error).message)
    } finally { if (!controller.signal.aborted && mounted.current) setBusy('') }
  }, [])

  useEffect(() => {
    mounted.current = true
    let unsubscribe = () => {}
    try { unsubscribe = browserOfflineClient.subscribe(setState) } catch { /* capabilities() renders unsupported browsers without breaking settings. */ }
    void refresh()
    return () => { mounted.current = false; refreshRequest.current?.abort(); candidatesRequest.current?.abort(); unsubscribe() }
  }, [refresh])

  useEffect(() => {
    if (!request || !['requested', 'pending'].includes(request.state)) return
    const controller = new AbortController()
    const timer = window.setInterval(() => {
      void enrollmentStatusV4(request.id, controller.signal).then(result => {
        if (controller.signal.aborted) return
        setRequest(result.request)
        if (result.request.state === 'approved') void refresh()
      }).catch(() => {})
    }, 5_000)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [request?.id, request?.state, refresh])

  useEffect(() => {
    const controller = new AbortController()
    setSelection([]); setRevision(0); setDirty(false); setSelectionLoaded(false); setSelectionScope(''); setPassword(''); setConfirmation(''); setNotice(''); setError('')
    if (!grantId) { setSelectionLoading(false); return }
    setSelectionLoading(true)
    void grantSelectionV4(grantId, controller.signal).then(result => {
      if (!controller.signal.aborted) { setSelection(result.items); setRevision(result.selection_revision); setSelectionLoaded(true); setSelectionScope(grantId) }
    }).catch(fetchError => { if (!controller.signal.aborted) setError((fetchError as Error).message) }).finally(() => { if (!controller.signal.aborted) setSelectionLoading(false) })
    return () => controller.abort()
  }, [grantId, selectionAttempt])

  useEffect(() => { if (!allowedModules.some(item => item.id === module)) setModule(allowedModules[0]?.id || 'tasks') }, [grantId, grant?.actions.join(','), module])

  const loadCandidates = useCallback(async (after = '') => {
    candidatesRequest.current?.abort()
    const controller = new AbortController()
    candidatesRequest.current = controller
    if (!grantId) { setCandidates([]); setCursor(''); return }
    setSearching(true); setSearchError('')
    if (!after) { setCandidates([]); setCursor('') }
    try {
      const result = await resourceCandidatesV4(grantId, module, settledQuery, after, controller.signal)
      if (controller.signal.aborted) return
      setCandidateScope(`${grantId}:${module}:${settledQuery}`)
      setCandidates(current => after ? [...new Map([...current, ...result.items].map(item => [resourceKeyV4(item), item])).values()] : result.items)
      setCursor(result.next_cursor || '')
    } catch (fetchError) { if (!controller.signal.aborted) setSearchError((fetchError as Error).message) } finally { if (!controller.signal.aborted) setSearching(false) }
  }, [grantId, module, settledQuery])
  useEffect(() => { void loadCandidates(); return () => candidatesRequest.current?.abort() }, [loadCandidates])

  async function requestAccess() {
    if (busy) return
    setBusy('request'); setError('')
    try {
      const result = await browserOfflineClient.enroll()
      if (mounted.current) setRequest(result)
      await refresh()
    } catch (requestError) { if (mounted.current) setError((requestError as Error).message) } finally { if (mounted.current) setBusy('') }
  }

  async function prepare() {
    if (!grant || busy || selectionLoading || !selectionLoaded) return
    const validation = validateOfflinePasswordV4(password, confirmation)
    if (validation) { setError(validation); return }
    if (!selection.length) { setError('Elige al menos un recurso autorizado para preparar la copia.'); return }
    const secret = password
    setPassword(''); setConfirmation(''); setBusy('prepare'); setError(''); setNotice('')
    try {
      if (dirty && localGrant && localGrant.state !== 'revoked') {
        // An expired or interrupted copy must first renew its existing scope;
        // it cannot use the offline unlock endpoint as a renewal prerequisite.
        if (localGrant.state === 'available') await browserOfflineClient.unlock(grantId, secret, currentLogin)
        else await browserOfflineClient.prepare(grantId, secret)
        const sync = await browserOfflineClient.gateway().syncStatus()
        if (dirty && sync.pending_count > 0) throw new Error('Sincroniza los cambios pendientes antes de cambiar los recursos de esta cuenta.')
      }
      if (dirty) {
        const result = await browserOfflineClient.replaceSelection(grantId, revision, selection) as SelectionV4
        if (mounted.current) { setRevision(result.selection_revision); setSelection(reconcileSelectionLabelsV4(result.items, selection)); setDirty(false) }
      }
      const session = await browserOfflineClient.prepare(grantId, secret)
      if (session.actor.username.toLowerCase() !== currentLogin.trim().toLowerCase()) { await browserOfflineClient.lock(); throw new Error('La identidad cambió. Vuelve a iniciar sesión con el usuario que solicitó esta copia.') }
      if (!await setOfflineV4NavigationEnabled(true)) throw new Error('Los datos se guardaron cifrados, pero falta verificar la web offline. Reintenta la preparación antes de desconectarte.')
      await browserOfflineClient.lock()
      const copies = await browserOfflineClient.listLocalGrants()
      if (mounted.current) { setLocal(copies); setShellReady(true); setNotice('Copia verificada y lista. Puedes cerrar el navegador y volver a esta misma dirección sin conexión durante la vigencia de 24 horas.') }
    } catch (prepareError) { await browserOfflineClient.lock().catch(() => {}); if (mounted.current) setError((prepareError as Error).message) } finally { if (mounted.current) setBusy('') }
  }

  async function openOffline() {
    setBusy('open'); setError('')
    try {
      if (!await setOfflineV4Mode('offline')) throw new Error('No se pudo abrir el modo offline de forma segura. Reintenta la preparación.')
      window.location.assign('/login?offline=1')
    } catch (openError) { setError((openError as Error).message); setBusy('') }
  }

  return <section className="space-y-5 p-4 sm:p-6" aria-label="Acceso offline en este navegador">
    <header className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div><h2 className="flex items-center gap-2 font-semibold text-slate-900"><CloudOff className="h-5 w-5 text-emerald-600" />Clarin offline, en este navegador</h2><p className="mt-1 max-w-2xl text-sm text-slate-600">Sin instalar nada. Un superadmin autoriza este perfil de navegador, tu usuario y cada cuenta. Tú eliges qué guardar.</p></div>
      <button type="button" className={button} disabled={Boolean(busy)} onClick={() => void refresh()}><RefreshCw className={`h-4 w-4 ${busy === 'refresh' ? 'animate-spin' : ''}`} />Actualizar</button>
    </header>
    {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}{grantId && <button type="button" disabled={Boolean(busy)} className="ml-2 underline" onClick={() => { if (!dirty || window.confirm('¿Descartar el borrador y cargar la selección del servidor?')) setSelectionAttempt(value => value + 1) }}>Volver a cargar selección</button>}</div>}
    {notice && <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">{notice}</div>}
    {busy === 'refresh' && !capabilities ? <p role="status" className="flex items-center gap-2 p-5 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Comprobando disponibilidad…</p> : !enabled ? <p className="rounded-xl border border-slate-200 p-5 text-sm text-slate-600">El acceso offline todavía no está habilitado. Clarin online continúa funcionando normalmente.</p> : !capabilities?.supported ? <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">{capabilities?.reason || 'Este navegador no dispone del almacenamiento protegido y la coordinación necesarios. Usa una versión actual de Chrome o Edge en un perfil normal.'}</div> : <>
      {!capabilities.persistent && <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><HardDrive className="h-5 w-5 shrink-0" />El navegador todavía no garantiza almacenamiento persistente. Borrar los datos del sitio, usar modo privado o una limpieza del navegador puede eliminar la copia y cambios no sincronizados.</div>}
      <div className="flex flex-col gap-3 rounded-xl border border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-medium text-slate-900">{currentLogin} · Este perfil del navegador</p><p className="mt-1 text-sm text-slate-500">{request ? stateLabelV4(request.state) : grants.length ? 'Autorización disponible' : 'Solicita permiso una sola vez para este usuario en este navegador.'}</p></div><button type="button" className={primary} disabled={Boolean(busy) || request?.state === 'requested' || request?.state === 'pending'} onClick={() => void requestAccess()}>{busy === 'request' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}{grants.length ? 'Solicitar otra autorización' : 'Solicitar acceso offline'}</button></div>
      {grants.length === 0 ? <p className="rounded-xl border border-dashed border-slate-200 p-8 text-center text-sm text-slate-500">Cuando el superadmin apruebe este navegador aparecerán las cuentas y recursos autorizados. No se guardan datos de cuentas no autorizadas.</p> : <>
        <div><h3 className="mb-2 text-sm font-semibold text-slate-900">1. Elige una cuenta autorizada</h3><div className="flex flex-wrap gap-2" role="group" aria-label="Cuentas autorizadas">{grants.map(item => <button type="button" key={item.grant_id} disabled={Boolean(busy)} aria-pressed={item.grant_id === grantId} onClick={() => { if (!dirty || window.confirm('Hay una selección sin guardar. ¿Descartarla y cambiar de cuenta?')) setGrantId(item.grant_id) }} className={`min-h-11 rounded-lg border px-4 text-sm ${item.grant_id === grantId ? 'border-emerald-500 bg-emerald-50 text-emerald-900' : 'border-slate-200 text-slate-600'}`}>{item.account_name}</button>)}</div></div>
        {grant && selectionScope !== grantId && <p role="status" className="p-4 text-sm text-slate-500">{selectionLoading ? 'Cargando selección de esta cuenta…' : 'No hay una selección verificada. Vuelve a cargarla para continuar.'}</p>}
        {grant && selectionScope === grantId && <div key={grant.grant_id} className="space-y-4 rounded-xl border border-slate-200 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold text-slate-900">2. Elige qué sincronizar</h3><span className="text-sm text-slate-500" aria-live="polite">{selection.length} / {Math.min(20, grant.max_resources)} recursos · {grant.account_name}</span></div>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Tipo de recurso">{allowedModules.map(item => <button type="button" key={item.id} disabled={Boolean(busy)} aria-pressed={item.id === module} className={`rounded-lg px-3 py-2 text-sm ${module === item.id ? 'bg-emerald-50 font-semibold text-emerald-800' : 'text-slate-600'}`} onClick={() => { setModule(item.id); setQuery('') }}>{item.label}</button>)}</div>
          <label className="relative block"><Search className="absolute left-3 top-3 h-4 w-4 text-slate-400" /><input aria-label="Buscar recursos autorizados" value={query} onChange={event => setQuery(event.target.value)} className="min-h-11 w-full rounded-lg border border-slate-200 pl-10 pr-3 text-sm" placeholder="Buscar recursos autorizados…" disabled={Boolean(busy)} /></label>
          <div className="max-h-64 overflow-y-auto rounded-lg border border-slate-200">
            {selectionLoading ? <p className="p-5 text-sm text-slate-500">Cargando selección…</p> : visibleCandidates.map(item => { const checked = selection.some(selected => resourceKeyV4(selected) === resourceKeyV4(item)); return <label key={resourceKeyV4(item)} className={`flex min-h-14 items-center gap-3 border-b border-slate-100 p-3 last:border-0 ${checked ? 'bg-emerald-50' : 'bg-white'}`}><input type="checkbox" className="h-4 w-4 accent-emerald-600" checked={checked} disabled={Boolean(busy) || (!checked && selection.length >= Math.min(20, grant.max_resources))} onChange={() => { setSelection(current => toggleResourceV4(current, item, grant.max_resources)); setDirty(true); setNotice('') }} /><span className="min-w-0 text-sm"><span className="block break-words font-medium text-slate-800">{resourceLabelV4(item)}</span>{item.subtitle && <span className="block text-xs text-slate-500">{item.subtitle}</span>}</span></label> })}
            {searching || query !== settledQuery ? <p role="status" className="p-4 text-sm text-slate-500">Buscando…</p> : searchError ? <div role="alert" className="p-4 text-sm text-red-700">{searchError}<button className="ml-2 underline" onClick={() => void loadCandidates()}>Reintentar</button></div> : !visibleCandidates.length && <p className="p-5 text-sm text-slate-500">No hay recursos autorizados que coincidan.</p>}
            {cursor && <button type="button" className="min-h-11 w-full text-sm font-semibold text-emerald-700" disabled={searching || Boolean(busy)} onClick={() => void loadCandidates(cursor)}>Cargar más recursos</button>}
          </div>
          {selection.length > 0 && <div className="flex flex-wrap gap-2" aria-label="Recursos seleccionados">{selection.map(item => <button type="button" key={resourceKeyV4(item)} disabled={Boolean(busy)} onClick={() => { setSelection(current => toggleResourceV4(current, item, grant.max_resources)); setDirty(true); setNotice('') }} className="max-w-full break-words rounded-lg bg-slate-100 px-3 py-2 text-left text-xs text-slate-700" aria-label={`Quitar ${resourceLabelV4(item)}`}>{resourceLabelV4(item)} ×</button>)}</div>}
          <form onSubmit={event => { event.preventDefault(); void prepare() }} autoComplete="off" className="space-y-3 border-t border-slate-100 pt-4">
            <h3 className="text-sm font-semibold text-slate-900">3. Protege y prepara tu copia</h3><p className="text-sm text-slate-500">Confirma tu contraseña de Clarin (mínimo 12 caracteres). No se guarda en la caché: protege el cifrado de esta copia. La autorización dura como máximo 24 horas y se bloquea tras 30 minutos sin actividad.</p>
            <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm text-slate-700">Contraseña de Clarin<input type="password" value={password} onChange={event => setPassword(event.target.value)} minLength={12} maxLength={1024} autoComplete="off" data-1p-ignore disabled={Boolean(busy)} className="mt-1 min-h-11 w-full rounded-lg border border-slate-200 px-3" /></label><label className="text-sm text-slate-700">Repetir contraseña<input type="password" value={confirmation} onChange={event => setConfirmation(event.target.value)} minLength={12} maxLength={1024} autoComplete="off" data-1p-ignore disabled={Boolean(busy)} className="mt-1 min-h-11 w-full rounded-lg border border-slate-200 px-3" /></label></div>
            <div className="flex flex-wrap items-center gap-3"><button type="submit" className={primary} disabled={Boolean(busy) || selectionLoading || !selection.length || !password || !confirmation}>{busy === 'prepare' ? <Loader2 className="h-4 w-4 animate-spin" /> : <LockKeyhole className="h-4 w-4" />}{localGrant ? 'Actualizar y verificar copia' : 'Preparar acceso offline'}</button>{ready && <button type="button" className={button} disabled={Boolean(busy)} onClick={() => void openOffline()}><Check className="h-4 w-4 text-emerald-600" />Entrar en modo offline</button>}</div>
            {busy === 'prepare' && <p role="status" className="text-sm text-slate-500">{state.preparing ? `Preparando ${state.preparing.completed} de ${state.preparing.total} recursos…` : 'Cifrando, guardando y verificando la copia y la web offline… No cierres esta pestaña.'}</p>}
          </form>
        </div>}
      </>}
    </>}
  </section>
}
