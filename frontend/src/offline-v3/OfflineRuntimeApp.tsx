import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { AlertCircle, BookOpenCheck, ContactRound, GitCompareArrows, KeyRound, ListChecks, Loader2, LockKeyhole, MonitorCheck, PenTool, RefreshCw, ShieldCheck, Wifi, WifiOff } from 'lucide-react'
import ClarinBrandMark from '@/components/branding/ClarinBrandMark'
import OfflineConflictsView from '@/components/offline-v3/OfflineConflictsView'
import OfflineContactsView from '@/components/offline-v3/OfflineContactsView'
import OfflineProgramsView from '@/components/offline-v3/OfflineProgramsView'
import OfflineStatusIndicator from '@/components/offline-v3/OfflineStatusIndicator'
import OfflineTasksView from '@/components/offline-v3/OfflineTasksView'
import OfflineWhiteboardsView from '@/components/offline-v3/OfflineWhiteboardsView'
import { probeRemoteAvailability, type RemoteAvailability } from './availability'
import { OfflineV3Bridge } from './bridge'
import { createOfflineBridgeGateway } from './gateway'
import { OfflineNavigationAdapter, isOfflinePathSupported, type NavigationSnapshot } from './navigation'
import { initialOfflineRuntimeState, offlineRuntimeReducer } from './runtimeState'
import { LocalServiceError, type GrantSummary } from './types'
import { beginOfflineV3OnlineReauth, setOfflineV3Mode, setOfflineV3NavigationEnabled } from '@/lib/offlineV3ServiceWorker'
import { offlineBrowserLabel } from './browserLabel'
import { storeOfflineReauthExpectation } from './offlineReauth'
import { OFFLINE_V3_IDENTITY_CHANNEL } from './profileEpoch'
import { nextOfflineActivitySequence } from './activity'

declare const __CLARIN_OFFLINE_BUILD__: string

const HEARTBEAT_MS = 15_000
const REMOTE_PROBE_MS = 15_000
const IDLE_MS = 30 * 60_000

function moduleFromPath(pathname: string) {
  if (pathname.startsWith('/dashboard/tasks')) return 'tasks'
  if (pathname.startsWith('/dashboard/contacts')) return 'contacts'
  if (pathname.startsWith('/dashboard/programs')) return 'programs'
  if (pathname.startsWith('/dashboard/whiteboards')) return 'whiteboards'
  if (pathname.startsWith('/dashboard/conflicts')) return 'conflicts'
  return 'home'
}

function routeID(pathname: string, module: 'programs' | 'whiteboards') {
  const match = pathname.match(new RegExp(`^/dashboard/${module}/([0-9a-f-]{36})/?$`, 'i'))
  return match?.[1]
}

function LoginFrame({ children }: { children: React.ReactNode }) {
  return <main className="offline-login"><section className="offline-login__card"><div className="offline-login__brand"><ClarinBrandMark label="Clarin" /><div><strong>Clarin</strong><span>Acceso protegido offline</span></div></div>{children}</section></main>
}

function ServiceUnavailable({ message, retry }: { message: string; retry: () => void }) {
  return <LoginFrame><div className="offline-login__state offline-login__state--warning"><WifiOff /></div><h1>El motor offline no está disponible</h1><p>{message}</p><div className="offline-alert offline-alert--info"><ShieldCheck />No se han abierto datos locales ni se ha utilizado otra cuenta como alternativa.</div><button className="offline-button offline-button--primary offline-button--wide" onClick={retry}><RefreshCw />Volver a comprobar</button></LoginFrame>
}

function Enrollment({ bridge, onReady, onPending, onError }: { bridge: OfflineV3Bridge; onReady: () => void; onPending: () => void; onError: (message: string) => void }) {
  const [principal, setPrincipal] = useState<Awaited<ReturnType<OfflineV3Bridge['createPrincipalChallenge']>> | null>(null)
  const [checking, setChecking] = useState(false)

  async function prepare() {
    setChecking(true)
    try { setPrincipal(await bridge.createPrincipalChallenge()) } catch (error) { onError((error as Error).message) } finally { setChecking(false) }
  }

  async function verify() {
    if (!principal || checking) return
    setChecking(true)
    try {
      const deadline = Date.parse(principal.expires_at)
      while (Date.now() < deadline) {
        const status = await bridge.principalChallengeStatus(principal.challenge_id)
        if (status.state === 'completed') {
          const browserChallenge = await bridge.browserChallenge(__CLARIN_OFFLINE_BUILD__, offlineBrowserLabel())
          const profile = await bridge.enrollBrowser(principal.challenge_id, browserChallenge.challenge_id, __CLARIN_OFFLINE_BUILD__, offlineBrowserLabel())
          if (profile.state === 'active') onReady()
          else onPending()
          return
        }
        if (status.state === 'expired') break
        await new Promise(resolve => window.setTimeout(resolve, 1_000))
      }
      throw new Error('La comprobación de Windows venció. Iníciala nuevamente.')
    } catch (error) {
      onError((error as Error).message)
    } finally {
      setChecking(false)
    }
  }

  return <LoginFrame><div className="offline-login__state"><MonitorCheck /></div><h1>Vincula este navegador</h1><p>Clarin necesita comprobar una sola vez el usuario real de Windows. No tienes que copiar identificadores ni claves.</p>{principal ? <><a className="offline-button offline-button--primary offline-button--wide" href={principal.launch_uri} onClick={() => window.setTimeout(() => void verify(), 600)}><MonitorCheck />Comprobar Windows</a><p className="offline-login__hint">Windows abrirá el helper de Clarin. Regresa a esta pestaña; la comprobación continúa sola.</p></> : <button className="offline-button offline-button--primary offline-button--wide" onClick={() => void prepare()} disabled={checking}>{checking ? <Loader2 className="spin" /> : <KeyRound />}Preparar acceso</button>}</LoginFrame>
}

function PendingBrowser({ retry }: { retry: () => void }) {
  return <LoginFrame><div className="offline-login__state"><ShieldCheck /></div><h1>Esperando autorización</h1><p>El perfil de este navegador ya fue identificado. Un superadmin debe aprobar la combinación exacta de Windows, navegador, usuario y cuenta.</p><button className="offline-button offline-button--secondary offline-button--wide" onClick={retry}><RefreshCw />Comprobar aprobación</button></LoginFrame>
}

function Unlock({ grants, busy, error, canGoOnline, switchingOnline, onUnlock, onRefresh, onGoOnline }: { grants: GrantSummary[]; busy: boolean; error: string; canGoOnline: boolean; switchingOnline: boolean; onUnlock: (grantId: string, login: string, password: string) => void; onRefresh: () => void; onGoOnline: () => void }) {
  const available = grants.filter(grant => grant.state === 'available' && grant.ready)
  const [grantId, setGrantId] = useState(available[0]?.grant_id || '')
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const grant = grants.find(item => item.grant_id === grantId)

  useEffect(() => { setGrantId(current => available.some(item => item.grant_id === current) ? current : available[0]?.grant_id || '') }, [grants])

  return <LoginFrame><div className="offline-login__state"><LockKeyhole /></div><h1>Entrar en modo offline</h1><p>Usa el mismo usuario y contraseña de Clarin. Se cifran antes de enviarse al servicio local y no se guardan en el navegador.</p>{grants.length === 0 ? <div className="offline-alert offline-alert--warning"><AlertCircle />Este navegador no tiene cuentas autorizadas.</div> : available.length === 0 ? <div className="offline-alert offline-alert--warning"><AlertCircle />Hay autorizaciones, pero ninguna copia terminó de prepararse. No se muestran como vacías.</div> : <form onSubmit={event => { event.preventDefault(); onUnlock(grantId, login, password); setPassword('') }} autoComplete="off"><label className="offline-field"><span>Cuenta autorizada</span><select value={grantId} onChange={event => { setGrantId(event.target.value); setLogin(''); setPassword('') }}>{available.map(item => <option key={item.grant_id} value={item.grant_id}>{item.display_user} · {item.display_account}</option>)}</select></label><label className="offline-field"><span>Usuario de Clarin</span><input type="text" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="off" data-1p-ignore value={login} onChange={event => setLogin(event.target.value)} /></label><label className="offline-field"><span>Contraseña de Clarin</span><input type="password" autoComplete="off" data-1p-ignore value={password} onChange={event => setPassword(event.target.value)} /></label>{grant?.needs_online_provision && <div className="offline-alert offline-alert--warning"><AlertCircle />Esta cuenta necesita una preparación online autenticada antes del primer uso offline.</div>}<button className="offline-button offline-button--primary offline-button--wide" disabled={!login.trim() || !password || !grantId || busy || grant?.needs_online_provision}>{busy ? <Loader2 className="spin" /> : <LockKeyhole />}Desbloquear copia local</button></form>}{error && <div className="offline-alert offline-alert--error" role="alert"><AlertCircle />{error}</div>}<button className="offline-link-button" onClick={onRefresh}>Actualizar autorizaciones</button>{canGoOnline && <button className="offline-link-button" disabled={switchingOnline} onClick={onGoOnline}>{switchingOnline ? 'Abriendo acceso online…' : 'Iniciar una sesión online nueva'}</button>}<p className="offline-login__hint">Cerrar el navegador o permanecer 30 minutos sin actividad vuelve a bloquear los datos.</p></LoginFrame>
}

function DashboardHome({ navigate, actions }: { navigate: (path: string) => void; actions: Set<string> }) {
  const modules = [
    { id: 'tasks', label: 'Tareas', description: 'Leer, crear y completar', icon: ListChecks, action: 'tasks.read' },
    { id: 'contacts', label: 'Contactos', description: 'Consulta de solo lectura', icon: ContactRound, action: 'contacts.read' },
    { id: 'programs', label: 'Programas', description: 'Roster y sesiones en lectura', icon: BookOpenCheck, action: 'programs.read' },
    { id: 'whiteboards', label: 'Pizarras', description: 'Escenas autorizadas en lectura', icon: PenTool, action: 'whiteboards.read' },
  ]
  return <section className="offline-module"><header className="offline-module__header"><div><p className="offline-eyebrow">Copia protegida</p><h1>¿Qué necesitas consultar?</h1><p>Solo aparecen módulos autorizados y preparados para esta identidad.</p></div></header><div className="offline-home-grid">{modules.filter(item => actions.has(item.action)).map(item => <button key={item.id} onClick={() => navigate(`/dashboard/${item.id}`)}><span><item.icon /></span><strong>{item.label}</strong><small>{item.description}</small></button>)}</div></section>
}

export default function OfflineRuntimeApp() {
  const bridge = useMemo(() => new OfflineV3Bridge(), [])
  const gateway = useMemo(() => createOfflineBridgeGateway(bridge), [bridge])
  const navigatorAdapter = useMemo(() => new OfflineNavigationAdapter(), [])
  const [route, setRoute] = useState<NavigationSnapshot>(() => navigatorAdapter.snapshot())
  const [state, dispatch] = useReducer(offlineRuntimeReducer, initialOfflineRuntimeState)
  const [remote, setRemote] = useState<RemoteAvailability>({ state: 'infrastructure_unavailable', code: 'not_checked' })
  const [principalError, setPrincipalError] = useState('')
  const [switchingOnline, setSwitchingOnline] = useState(false)
  const stateRef = useRef(state)
  const identityChannelRef = useRef<BroadcastChannel | null>(null)
  const activitySequenceRef = useRef(0)
  stateRef.current = state

  const loadGrants = useCallback(async () => {
    const proof = await bridge.proveBrowser(__CLARIN_OFFLINE_BUILD__)
    if (proof.state === 'revoked') { dispatch({ type: 'REVOKED', profileEpoch: proof.profile_epoch }); return }
    if (proof.state !== 'active') { dispatch({ type: 'BROWSER_PENDING' }); return }
    const page = await bridge.grants()
    if (page.items.some(grant => grant.state === 'available' && grant.ready)) void setOfflineV3NavigationEnabled(true)
    dispatch({ type: 'LOCKED', grants: page.items, profileEpoch: proof.profile_epoch })
  }, [bridge])

  const boot = useCallback(async () => {
    try {
      const health = await bridge.health()
      if (health.protocol !== 3 || health.engine_state !== 'ready') throw new Error('El servicio local todavía no está listo.')
      if (health.configured_origin !== window.location.origin) throw new Error('El motor está vinculado a otro origen de Clarin.')
      const identity = await bridge.initializeIdentity()
      if (!identity.browserProfileId) { dispatch({ type: 'PRINCIPAL_REQUIRED' }); return }
      await loadGrants()
    } catch (error) {
      dispatch({ type: 'SERVICE_UNAVAILABLE', message: (error as Error).message })
    }
  }, [bridge, loadGrants])

  useEffect(() => { const stop = navigatorAdapter.start(); const unsubscribe = navigatorAdapter.subscribe(setRoute); if (!isOfflinePathSupported(route.pathname)) navigatorAdapter.navigate('/dashboard', { replace: true }); return () => { stop(); unsubscribe() } }, [navigatorAdapter])
  useEffect(() => { void boot() }, [boot])
  useEffect(() => bridge.onInvalidated(error => {
    const epoch = error.profileEpoch || stateRef.current.profileEpoch + 1
    if (error.code === 'grant_revoked') dispatch({ type: 'REVOKED', profileEpoch: epoch })
    else if (error.code === 'lease_expired') dispatch({ type: 'EXPIRED', profileEpoch: epoch })
    else dispatch({ type: 'IDENTITY_CHANGED', profileEpoch: epoch })
  }), [bridge])

  useEffect(() => {
    const channel = new BroadcastChannel(OFFLINE_V3_IDENTITY_CHANNEL)
    identityChannelRef.current = channel
    channel.onmessage = event => {
      const epoch = Number((event.data as { profile_epoch?: unknown })?.profile_epoch)
      if (Number.isFinite(epoch) && epoch > stateRef.current.profileEpoch) dispatch({ type: 'IDENTITY_CHANGED', profileEpoch: epoch })
    }
    return () => { identityChannelRef.current = null; channel.close() }
  }, [])

  useEffect(() => {
    const probe = () => void probeRemoteAvailability().then(setRemote)
    probe()
    const interval = window.setInterval(probe, REMOTE_PROBE_MS)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    if (!state.session) return
    const clientInstanceId = crypto.randomUUID()
    activitySequenceRef.current = 0
    const recordActivity = (event: Event) => {
      if (!event.isTrusted) return
      activitySequenceRef.current = nextOfflineActivitySequence(activitySequenceRef.current, event.isTrusted)
    }
    const activityEvents = ['pointerdown', 'keydown', 'scroll', 'touchstart'] as const
    activityEvents.forEach(name => window.addEventListener(name, recordActivity, { passive: true }))
    const beat = () => void bridge.heartbeat(clientInstanceId, document.visibilityState === 'visible', activitySequenceRef.current).then(result => dispatch({ type: 'SYNC', sync: result.sync })).catch(() => {})
    beat()
    const interval = window.setInterval(beat, HEARTBEAT_MS)
    document.addEventListener('visibilitychange', beat)
    return () => { window.clearInterval(interval); document.removeEventListener('visibilitychange', beat); activityEvents.forEach(name => window.removeEventListener(name, recordActivity)) }
  }, [bridge, state.session])

  useEffect(() => {
    if (!state.session) return
    let timer = window.setTimeout(() => void lock('idle'), IDLE_MS)
    const activity = (event: Event) => { if (!event.isTrusted) return; window.clearTimeout(timer); timer = window.setTimeout(() => void lock('idle'), IDLE_MS) }
    const events = ['pointerdown', 'keydown', 'scroll', 'touchstart'] as const
    events.forEach(name => window.addEventListener(name, activity, { passive: true }))
    return () => { window.clearTimeout(timer); events.forEach(name => window.removeEventListener(name, activity)) }
  }, [state.session])

  async function unlock(grantId: string, login: string, password: string) {
    dispatch({ type: 'UNLOCKING' })
    try {
      const result = await bridge.unlock(grantId, login, password)
      if (!await setOfflineV3Mode('offline')) {
        await bridge.lock('security').catch(() => {})
        throw new Error('El navegador no pudo fijar el modo offline de forma segura. Actualiza la página y vuelve a intentarlo.')
      }
      dispatch({ type: 'UNLOCKED', session: result.session, sync: result.sync })
      identityChannelRef.current?.postMessage({ profile_epoch: result.session.profile_epoch })
      if (route.pathname === '/login') navigatorAdapter.navigate('/dashboard', { replace: true })
    } catch (error) {
      const message = error instanceof LocalServiceError && error.code === 'unlock_throttled'
        ? 'Demasiados intentos. Espera el tiempo indicado antes de volver a probar.'
        : error instanceof LocalServiceError && error.code === 'invalid_offline_credential'
          ? 'No se pudo validar la identidad offline. Comprueba el usuario y la contraseña.'
        : (error as Error).message
      await loadGrants().catch(() => {})
      // Refresh first: LOCKED intentionally clears stale errors. Publishing
      // the credential error afterwards keeps this attempt visible instead of
      // flashing and disappearing when the grant list reconciles.
      dispatch({ type: 'ERROR', message })
    }
  }

  async function lock(reason: 'logout' | 'switch' | 'idle' | 'security') {
    const nextEpoch = stateRef.current.profileEpoch + 1
    await bridge.lock(reason).catch(() => {})
    identityChannelRef.current?.postMessage({ profile_epoch: nextEpoch })
    dispatch({ type: 'IDENTITY_CHANGED', profileEpoch: nextEpoch, message: reason === 'idle' ? 'La copia se bloqueó tras 30 minutos sin actividad.' : undefined })
  }

  async function syncNow() {
    try { dispatch({ type: 'SYNC', sync: await gateway.triggerSync() }) } catch (error) { dispatch({ type: 'ERROR', message: (error as Error).message }) }
  }

  async function reauthenticateOnline() {
    const session = stateRef.current.session
    if (!session || remote.state !== 'available' || switchingOnline) return
    setSwitchingOnline(true)
    try {
      if (!await beginOfflineV3OnlineReauth()) throw new Error('El navegador no pudo preparar la transición segura al modo online.')
      storeOfflineReauthExpectation(window.sessionStorage, session.actor)
      await lock('switch')
      window.location.assign('/login?offline_reauth=1')
    } catch (error) {
      setSwitchingOnline(false)
      dispatch({ type: 'ERROR', message: (error as Error).message || 'No se pudo iniciar la transición segura al modo online.' })
    }
  }

  async function startFreshOnlineLogin() {
    if (remote.state !== 'available' || switchingOnline) return
    setSwitchingOnline(true)
    try {
      if (!await beginOfflineV3OnlineReauth()) throw new Error('El navegador no pudo preparar un inicio online seguro.')
      window.location.assign('/login?offline_fresh_login=1')
    } catch (error) {
      setSwitchingOnline(false)
      dispatch({ type: 'ERROR', message: (error as Error).message || 'No se pudo abrir el inicio de sesión online.' })
    }
  }

  if (state.phase === 'booting') return <LoginFrame><div className="offline-loading offline-loading--large"><Loader2 className="spin" />Preparando acceso protegido…</div></LoginFrame>
  if (state.phase === 'service_unavailable') return <ServiceUnavailable message={state.error} retry={() => void boot()} />
  if (state.phase === 'principal_required') return <Enrollment bridge={bridge} onReady={() => void loadGrants()} onPending={() => dispatch({ type: 'BROWSER_PENDING' })} onError={message => { setPrincipalError(message); dispatch({ type: 'ERROR', message }) }} />
  if (state.phase === 'browser_pending') return <PendingBrowser retry={() => void loadGrants()} />
  if (state.phase === 'revoked') return <LoginFrame><div className="offline-login__state offline-login__state--danger"><AlertCircle /></div><h1>Acceso offline revocado</h1><p>Esta copia ya no puede abrirse. El motor conservará únicamente el canal necesario para recibir y confirmar controles autorizados.</p></LoginFrame>
  if (state.phase === 'expired') return <LoginFrame><div className="offline-login__state offline-login__state--warning"><AlertCircle /></div><h1>La autorización venció</h1><p>Conecta Clarin para renovar la autorización. Las operaciones pendientes no se borrarán silenciosamente.</p></LoginFrame>
  if (!state.session) return <Unlock grants={state.grants} busy={state.phase === 'unlocking'} error={state.error || principalError} canGoOnline={remote.state === 'available'} switchingOnline={switchingOnline} onUnlock={(grantId, login, password) => void unlock(grantId, login, password)} onRefresh={() => void loadGrants()} onGoOnline={() => void startFreshOnlineLogin()} />

  const actions = new Set<string>(state.session.actions)
  const activeModule = moduleFromPath(route.pathname)
  const navigate = (path: string) => { if (!navigatorAdapter.navigate(path)) dispatch({ type: 'ERROR', message: 'Esa pantalla no está disponible offline.' }) }
  return <div className="offline-runtime" key={state.generation}>
    <OfflineStatusIndicator session={state.session} sync={state.sync} onSync={() => void syncNow()} />
    {remote.state === 'available' && <div className="offline-online-notice" role="status"><Wifi /><span>Internet volvió. Continúas en tu sesión local hasta que decidas cambiar.</span><button type="button" className="offline-button offline-button--quiet" disabled={switchingOnline} onClick={() => void reauthenticateOnline()}>{switchingOnline ? <Loader2 className="spin" /> : <ShieldCheck />}Volver al modo online</button></div>}
    <div className="offline-runtime__body">
      <aside className="offline-sidebar"><div className="offline-sidebar__brand"><ClarinBrandMark /><span><strong>Clarin</strong><small>Modo offline</small></span></div><nav aria-label="Módulos offline"><button className={activeModule === 'home' ? 'active' : ''} onClick={() => navigate('/dashboard')}><ShieldCheck />Inicio</button>{actions.has('tasks.read') && <button className={activeModule === 'tasks' ? 'active' : ''} onClick={() => navigate('/dashboard/tasks')}><ListChecks />Tareas</button>}{actions.has('contacts.read') && <button className={activeModule === 'contacts' ? 'active' : ''} onClick={() => navigate('/dashboard/contacts')}><ContactRound />Contactos</button>}{actions.has('programs.read') && <button className={activeModule === 'programs' ? 'active' : ''} onClick={() => navigate('/dashboard/programs')}><BookOpenCheck />Programas</button>}{actions.has('whiteboards.read') && <button className={activeModule === 'whiteboards' ? 'active' : ''} onClick={() => navigate('/dashboard/whiteboards')}><PenTool />Pizarras</button>}{(state.sync?.conflict_count || 0) > 0 && <button className={activeModule === 'conflicts' ? 'active' : ''} onClick={() => navigate('/dashboard/conflicts')}><GitCompareArrows />Cambios<span className="offline-sidebar__badge" aria-label={`${state.sync?.conflict_count || 0} cambios por revisar`}>{state.sync?.conflict_count}</span></button>}</nav><button className="offline-sidebar__lock" onClick={() => void lock('logout')}><LockKeyhole />Bloquear</button></aside>
      <main className="offline-workspace">
        {state.error && <div className="offline-alert offline-alert--error offline-runtime-error"><AlertCircle />{state.error}</div>}
        {activeModule === 'home' && <DashboardHome navigate={navigate} actions={actions} />}
        {activeModule === 'tasks' && actions.has('tasks.read') && <OfflineTasksView gateway={gateway} canCreate={actions.has('tasks.create')} canComplete={actions.has('tasks.complete')} onSync={sync => dispatch({ type: 'SYNC', sync })} refreshToken={state.sync?.last_success_at || ''} />}
        {activeModule === 'contacts' && actions.has('contacts.read') && <OfflineContactsView gateway={gateway} refreshToken={state.sync?.last_success_at || ''} />}
        {activeModule === 'programs' && actions.has('programs.read') && <OfflineProgramsView gateway={gateway} programId={routeID(route.pathname, 'programs')} navigate={navigate} refreshToken={state.sync?.last_success_at || ''} />}
        {activeModule === 'whiteboards' && actions.has('whiteboards.read') && <OfflineWhiteboardsView gateway={gateway} whiteboardId={routeID(route.pathname, 'whiteboards')} navigate={navigate} refreshToken={state.sync?.last_success_at || ''} />}
        {activeModule === 'conflicts' && <OfflineConflictsView gateway={gateway} refreshToken={`${state.sync?.last_success_at || ''}:${state.sync?.conflict_count || 0}`} />}
      </main>
    </div>
  </div>
}
