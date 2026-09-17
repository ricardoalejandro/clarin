import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, BookOpenCheck, ContactRound, GitCompareArrows, ListChecks, Loader2, LockKeyhole, PenTool, ShieldCheck, Wifi } from 'lucide-react'
import ClarinBrandMark from '@/components/branding/ClarinBrandMark'
import OfflineContactsView from '@/components/offline-v3/OfflineContactsView'
import OfflineProgramsView from '@/components/offline-v3/OfflineProgramsView'
import OfflineWhiteboardsView from '@/components/offline-v3/OfflineWhiteboardsView'
import OfflineTasksView from '@/components/offline-v3/OfflineTasksView'
import OfflineConflictsView from '@/components/offline-v3/OfflineConflictsView'
import OfflineStatusIndicator from '@/components/offline-v3/OfflineStatusIndicator'
import OfflineUnlockV4, { OfflineLoginFrameV4 } from '@/components/offline-v4/OfflineUnlockV4'
import { probeAvailabilityV4 } from '@/components/offline-v4/availability'
import { clearEntryIdentityV4, readEntryIdentityV4 } from '@/components/offline-v4/entryIdentity'
import { browserOfflineClient } from './client'
import OfflineMobileSessionActionsV4 from '@/components/offline-v4/OfflineMobileSessionActionsV4'
import type { BrowserState, LocalGrantSummary } from './types'
import { OfflineNavigationAdapter, isOfflinePathSupported } from '@/offline-v3/navigation'
import { storeOfflineReauthExpectation } from '@/offline-v3/offlineReauth'
import { beginOfflineV4OnlineReauth, setOfflineV4Mode } from '@/lib/offlineV4ServiceWorker'
import type { RemoteAvailability } from '@/offline-v3/availability'

const modules = [
  { id: 'tasks', label: 'Tareas', detail: 'Leer, crear y completar según permiso', action: 'tasks.read', icon: ListChecks },
  { id: 'contacts', label: 'Contactos', detail: 'Consulta de solo lectura', action: 'contacts.read', icon: ContactRound },
  { id: 'programs', label: 'Programas', detail: 'Roster y sesiones en lectura', action: 'programs.read', icon: BookOpenCheck },
  { id: 'whiteboards', label: 'Pizarras', detail: 'Escenas autorizadas en lectura', action: 'whiteboards.read', icon: PenTool },
]
const routeID = (pathname: string, module: string) => pathname.match(new RegExp(`^/dashboard/${module}/([0-9a-f-]{36})/?$`, 'i'))?.[1]

export default function OfflineRuntimeApp() {
  const navigation = useMemo(() => new OfflineNavigationAdapter(), [])
  const gateway = useMemo(() => browserOfflineClient.gateway(), [])
  const [route, setRoute] = useState(() => navigation.snapshot())
  const [state, setState] = useState<BrowserState>({ generation: 0, session: null })
  const [grants, setGrants] = useState<LocalGrantSummary[]>([])
  const [accounts, setAccounts] = useState<Array<{ grant_id: string; account_name: string }>>([])
  const [booting, setBooting] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [remote, setRemote] = useState<RemoteAvailability>({ state: 'infrastructure_unavailable', code: 'not_checked' })
  const mounted = useRef(false)
  const stateRef = useRef(state)
  stateRef.current = state

  const boot = useCallback(async () => {
    setBooting(true); setError('')
    try {
      const capabilities = await browserOfflineClient.capabilities()
      if (!capabilities.supported) throw new Error(capabilities.reason || 'Este navegador no permite abrir el almacenamiento protegido.')
      const copies = await browserOfflineClient.listLocalGrants()
      if (mounted.current) setGrants(copies)
    } catch (bootError) { if (mounted.current) setError((bootError as Error).message) } finally { if (mounted.current) setBooting(false) }
  }, [])

  useEffect(() => {
    mounted.current = true
    let unsubscribe = () => {}
    try { unsubscribe = browserOfflineClient.subscribe(next => { if (mounted.current) { if (next.generation !== stateRef.current.generation) setAccounts([]); setState(next); if (next.error) setError(next.error) } }) } catch { /* boot() presents capability failures as a recoverable state. */ }
    void boot()
    return () => { mounted.current = false; unsubscribe() }
  }, [boot])
  useEffect(() => {
    const stop = navigation.start()
    const unsubscribe = navigation.subscribe(setRoute)
    if (!isOfflinePathSupported(route.pathname)) navigation.navigate('/dashboard', { replace: true })
    return () => { stop(); unsubscribe() }
  }, [navigation])
  useEffect(() => {
    const controller = new AbortController()
    let inFlight = false
    const probe = async () => { if (inFlight) return; inFlight = true; try { const result = await probeAvailabilityV4(controller.signal); if (!controller.signal.aborted) setRemote(result) } finally { inFlight = false } }
    void probe()
    const interval = window.setInterval(() => void probe(), 15_000)
    window.addEventListener('online', probe)
    return () => { controller.abort(); window.clearInterval(interval); window.removeEventListener('online', probe) }
  }, [])
  useEffect(() => {
    if (!state.session) return
    let last = 0
    const activity = (event: Event) => { if (!event.isTrusted || Date.now() - last < 1_000) return; last = Date.now(); browserOfflineClient.activity() }
    const events = ['pointerdown', 'keydown', 'scroll', 'touchstart'] as const
    events.forEach(name => window.addEventListener(name, activity, { passive: true }))
    return () => events.forEach(name => window.removeEventListener(name, activity))
  }, [state.session?.session_id])
  useEffect(() => {
    if (!state.session) return
    let inFlight = false
    let disposed = false
    const reconcile = async () => {
      if (inFlight || disposed) return
      inFlight = true
      try {
        if (remote.state === 'available') await gateway.triggerSync()
        else await gateway.syncStatus()
      } catch { /* The worker publishes locked/error/sync state; do not attach stale errors to another identity. */ }
      finally { inFlight = false }
    }
    void reconcile()
    const timer = window.setInterval(() => void reconcile(), 15_000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [state.session?.session_id, remote.state, gateway])

  async function unlock(username: string, password: string) {
    if (busy) return
    setBusy(true); setError('')
    try {
      if (!await setOfflineV4Mode('offline')) throw new Error('No se pudo fijar el modo offline. Vuelve a preparar la web con conexión.')
      const result = await browserOfflineClient.unlockUser(username, password, readEntryIdentityV4(window.sessionStorage) || undefined)
      if (mounted.current) setAccounts(result.session ? [] : result.accounts)
      if (result.session && (route.pathname === '/login' || route.pathname === '/')) navigation.navigate('/dashboard', { replace: true })
    } catch (unlockError) { if (mounted.current) setError((unlockError as Error).message) } finally { if (mounted.current) setBusy(false) }
  }
  async function selectAccount(grantId: string) {
    if (busy) return
    setBusy(true); setError('')
    try {
      await browserOfflineClient.selectAccount(grantId)
      setAccounts([])
      navigation.navigate('/dashboard', { replace: true })
    } catch (selectError) { if (mounted.current) { setAccounts([]); setError((selectError as Error).message) } } finally { if (mounted.current) setBusy(false) }
  }
  async function lock() {
    setBusy(true); setError(''); setAccounts([])
    clearEntryIdentityV4(window.sessionStorage)
    // Hide the rendered identity immediately. The worker then revokes all its
    // sessions before any other copy can be selected in this profile.
    setState(current => ({ generation: current.generation + 1, session: null }))
    try { await browserOfflineClient.lock(); await boot() } catch (lockError) { setError((lockError as Error).message) } finally { if (mounted.current) setBusy(false) }
  }
  async function sync() {
    const generation = stateRef.current.generation
    setError('')
    try { await gateway.triggerSync() } catch (syncError) { if (mounted.current && stateRef.current.generation === generation) setError((syncError as Error).message) }
  }
  async function goOnline() {
    if (busy || remote.state !== 'available') return
    setBusy(true); setError('')
    try {
      const session = stateRef.current.session
      if (session) storeOfflineReauthExpectation(window.sessionStorage, session.actor)
      if (!await beginOfflineV4OnlineReauth()) throw new Error('No se pudo preparar una transición online segura. Tu copia local sigue disponible.')
      await browserOfflineClient.lock()
      window.location.assign(session ? '/login?offline_reauth=1' : '/login?offline_fresh_login=1')
    } catch (onlineError) { if (mounted.current) { setError((onlineError as Error).message); setBusy(false) } }
  }

  if (booting) return <OfflineLoginFrameV4><div className="offline-loading offline-loading--large"><Loader2 className="spin" />Comprobando tus copias protegidas…</div></OfflineLoginFrameV4>
  if (!state.session) return <OfflineUnlockV4 grants={grants} accounts={accounts} busy={busy} error={error} onlineAvailable={remote.state === 'available'} onUnlock={unlock} onSelectAccount={selectAccount} onRefresh={() => void lock()} onOnline={() => void goOnline()} />
  const actions = new Set<string>(state.session.actions)
  const activeModule = route.pathname.split('/')[2] || 'home'
  const navigate = (path: string) => { if (!navigation.navigate(path)) setError('Esta pantalla no está disponible offline.') }
  const moduleAllowed = activeModule === 'home' || activeModule === 'conflicts' || modules.some(item => item.id === activeModule && actions.has(item.action))
  const refreshToken = state.sync?.last_success_at || ''

  return <div className="offline-runtime" key={`${state.generation}:${state.session.actor.user_id}:${state.session.actor.account_id}`}>
    <OfflineStatusIndicator session={state.session} sync={state.sync || null} onSync={() => void sync()} />
    <OfflineMobileSessionActionsV4 busy={busy} onLock={() => void lock()} />
    {remote.state === 'available' && <div className="offline-online-notice" role="status"><Wifi /><span>Clarin vuelve a estar disponible. Tu usuario y cuenta offline no cambian. Los cambios se sincronizan con su identidad original.</span><button type="button" className="offline-button offline-button--quiet" disabled={busy} onClick={() => void goOnline()}><ShieldCheck />Volver al modo online</button></div>}
    <div className="offline-runtime__body"><aside className="offline-sidebar"><div className="offline-sidebar__brand"><ClarinBrandMark /><span><strong>Clarin</strong><small>Modo offline</small></span></div><nav aria-label="Módulos offline"><button className={activeModule === 'home' ? 'active' : ''} onClick={() => navigate('/dashboard')}><ShieldCheck />Inicio</button>{modules.filter(item => actions.has(item.action)).map(item => <button key={item.id} className={activeModule === item.id ? 'active' : ''} onClick={() => navigate(`/dashboard/${item.id}`)}><item.icon />{item.label}</button>)}<button className={activeModule === 'conflicts' ? 'active' : ''} onClick={() => navigate('/dashboard/conflicts')}><GitCompareArrows />Cambios{Boolean(state.sync?.conflict_count) && <span className="offline-sidebar__badge">{state.sync?.conflict_count}</span>}</button></nav><button type="button" className="offline-sidebar__lock" disabled={busy} onClick={() => void lock()}><LockKeyhole />Bloquear / cambiar usuario o cuenta</button></aside>
      <main className="offline-workspace">
        {error && <div role="alert" className="offline-alert offline-alert--error offline-runtime-error"><AlertCircle />{error}</div>}
        {state.persistent === false && <div className="offline-alert offline-alert--warning offline-runtime-error">El navegador no garantiza retener esta copia. No borres sus datos y sincroniza los cambios pendientes en cuanto puedas.</div>}
        {!moduleAllowed ? <div className="offline-alert offline-alert--warning offline-runtime-error">Este módulo no está autorizado para la cuenta actual.</div> : <>
          {activeModule === 'home' && <section className="offline-module"><header className="offline-module__header"><div><p className="offline-eyebrow">{state.session.actor.account_name}</p><h1>Tu espacio offline</h1><p>Solo están disponibles los recursos seleccionados y preparados para esta identidad.</p></div></header><div className="offline-home-grid">{modules.filter(item => actions.has(item.action)).map(item => <button key={item.id} onClick={() => navigate(`/dashboard/${item.id}`)}><span><item.icon /></span><strong>{item.label}</strong><small>{item.detail}</small></button>)}</div></section>}
          {activeModule === 'tasks' && <OfflineTasksView gateway={gateway} canCreate={state.persistent === true && actions.has('tasks.create')} canComplete={state.persistent === true && actions.has('tasks.complete')} onSync={next => setState(current => current.session && current.generation === state.generation ? { ...current, sync: next } : current)} refreshToken={refreshToken} />}
          {activeModule === 'contacts' && <OfflineContactsView gateway={gateway} refreshToken={refreshToken} />}
          {activeModule === 'programs' && <OfflineProgramsView gateway={gateway} refreshToken={refreshToken} programId={routeID(route.pathname, 'programs')} navigate={navigate} />}
          {activeModule === 'whiteboards' && <OfflineWhiteboardsView gateway={gateway} refreshToken={refreshToken} whiteboardId={routeID(route.pathname, 'whiteboards')} navigate={navigate} />}
          {activeModule === 'conflicts' && <OfflineConflictsView gateway={gateway} refreshToken={`${refreshToken}:${state.sync?.conflict_count || 0}`} />}
        </>}
      </main>
    </div>
  </div>
}
