'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, CloudOff, Download, HardDrive, KeyRound, Loader2, MonitorCheck, RefreshCw, Search, ShieldCheck } from 'lucide-react'
import { OfflineV3Bridge } from '@/offline-v3/bridge'
import { offlineBrowserLabel } from '@/offline-v3/browserLabel'
import {
  OfflineV3APIError,
  createEnrollmentChallenge,
  currentSyncIntakeKey,
  enrollmentRequestStatus,
  grantBootstrap,
  grantSelection,
  grantServerChallenge,
  localGrantActivationBundle,
  localGrantLeaseActivationBundle,
  onlineGrants,
  registerGrantKeys,
  renewGrantLease,
  replaceGrantSelection,
  selectionCandidates,
  submitEnrollmentRequest,
  type EnrollmentRequestStatus,
  type OnlineGrant,
  type SelectionCandidate,
} from '@/offline-v3/onlineClient'
import { LocalServiceError, type GrantSummary, type OfflineModule, type OfflineResource, type PrincipalChallenge } from '@/offline-v3/types'
import { setOfflineV3NavigationEnabled } from '@/lib/offlineV3ServiceWorker'
import { broadcastOfflineProfileEpoch } from '@/offline-v3/profileEpoch'

const CLIENT_BUILD = process.env.NEXT_PUBLIC_BUILD_VERSION || 'dev'
const moduleCopy: Array<{ id: OfflineModule; label: string; detail: string }> = [
  { id: 'tasks', label: 'Tareas', detail: 'Listas autorizadas; crear y completar según permiso' },
  { id: 'contacts', label: 'Contactos', detail: 'Solo lectura' },
  { id: 'programs', label: 'Programas', detail: 'Solo lectura' },
  { id: 'whiteboards', label: 'Pizarras', detail: 'Solo lectura' },
]
const moduleReadAction: Record<OfflineModule, 'tasks.read' | 'contacts.read' | 'programs.read' | 'whiteboards.read'> = {
  tasks: 'tasks.read',
  contacts: 'contacts.read',
  programs: 'programs.read',
  whiteboards: 'whiteboards.read',
}

type SelectedResource = Pick<SelectionCandidate, 'module' | 'resource_type' | 'resource_id' | 'label' | 'subtitle'>

export function toggleV3Selection(current: SelectedResource[], candidate: SelectionCandidate, maximum: number) {
  const exists = current.some(item => item.module === candidate.module && item.resource_id === candidate.resource_id)
  if (exists) return current.filter(item => !(item.module === candidate.module && item.resource_id === candidate.resource_id))
  if (current.length >= maximum) return current
  return [...current, candidate]
}

export function indexLocalGrantSummaries(items: GrantSummary[]) {
  return Object.fromEntries(items.map(item => [item.grant_id, item]))
}

export function localGrantNeedsSelectionRenewal(local: GrantSummary | undefined, serverSelectionRevision: number) {
  return Boolean(local && (
    local.state === 'expired' ||
    (local.state === 'available' && local.selection_revision !== serverSelectionRevision)
  ))
}

export function localGrantBlocksSelectionChange(local: GrantSummary | undefined) {
  if (!local) return ''
  if (local.pending_count > 0) return 'Sincroniza los cambios locales pendientes antes de modificar qué recursos se guardan.'
  return ''
}

function selectionFromResource(item: OfflineResource): SelectedResource {
  return { module: item.module, resource_type: item.resource_type, resource_id: item.resource_id, label: item.label }
}

function requestTone(state?: string) {
  if (state === 'approved') return 'border-emerald-200 bg-emerald-50 text-emerald-900'
  if (state === 'rejected' || state === 'revoked') return 'border-red-200 bg-red-50 text-red-800'
  return 'border-amber-200 bg-amber-50 text-amber-900'
}

export default function OfflineAccessPanelV3({ currentLogin }: { currentLogin: string }) {
  const bridge = useMemo(() => new OfflineV3Bridge(), [])
  const [engine, setEngine] = useState<'checking' | 'ready' | 'unavailable'>('checking')
  const [featureEnabled, setFeatureEnabled] = useState(true)
  const [principal, setPrincipal] = useState<PrincipalChallenge | null>(null)
  const [request, setRequest] = useState<EnrollmentRequestStatus | null>(null)
  const [grants, setGrants] = useState<OnlineGrant[]>([])
  const [grantId, setGrantId] = useState('')
  const [module, setModule] = useState<OfflineModule>('tasks')
  const [selected, setSelected] = useState<SelectedResource[]>([])
  const [selectionRevision, setSelectionRevision] = useState(0)
  const [selectionDirty, setSelectionDirty] = useState(false)
  const [selectionConflictConfirmation, setSelectionConflictConfirmation] = useState(false)
  const [localGrants, setLocalGrants] = useState<Record<string, GrantSummary>>({})
  const [query, setQuery] = useState('')
  const [candidates, setCandidates] = useState<SelectionCandidate[]>([])
  const [busy, setBusy] = useState('')
  const [credentialsReady, setCredentialsReady] = useState(false)
  const [preparationNotice, setPreparationNotice] = useState('')
  const [error, setError] = useState('')
  const mountedRef = useRef(true)
  const provisionPasswordRef = useRef<HTMLInputElement>(null)
  const provisionConfirmationRef = useRef<HTMLInputElement>(null)
  const grant = grants.find(item => item.grant_id === grantId)
  const localGrant = grant ? localGrants[grant.grant_id] : undefined
  const selectionNeedsRenewal = Boolean(grant && localGrantNeedsSelectionRenewal(localGrant, grant.selection_revision))

  const readLocalGrantSummaries = useCallback(async () => {
    const local = await bridge.grants().catch(() => ({ items: [] as GrantSummary[] }))
    const indexed = indexLocalGrantSummaries(local.items)
    if (mountedRef.current) setLocalGrants(indexed)
    return local.items
  }, [bridge])

  const applyEnrollmentStatus = useCallback(async (status: Awaited<ReturnType<typeof enrollmentRequestStatus>>) => {
    if (!mountedRef.current) return
    setRequest(status.request)
    let serverGrants = status.grants || []
    if (status.service_descriptor && status.signer_public_keys) {
      await bridge.activateBrowserProfile({ service_descriptor: status.service_descriptor, signer_public_keys: status.signer_public_keys }, CLIENT_BUILD)
      const refreshed = await onlineGrants()
      serverGrants = refreshed.grants || []
      await readLocalGrantSummaries()
    }
    setGrants(serverGrants)
    setGrantId(current => serverGrants.some(item => item.grant_id === current) ? current : serverGrants[0]?.grant_id || '')
  }, [bridge, readLocalGrantSummaries])

  const refresh = useCallback(async () => {
    setBusy(current => current || 'refresh')
    setError('')
    try {
      const health = await bridge.health()
      if (health.protocol !== 3 || health.engine_state !== 'ready' || health.configured_origin !== window.location.origin) throw new Error('El motor offline no está listo para este sitio.')
      setEngine('ready')
      const identity = await bridge.initializeIdentity()
      const grantsResponse = await onlineGrants()
      setGrants(grantsResponse.grants || [])
      setGrantId(current => grantsResponse.grants.some(item => item.grant_id === current) ? current : grantsResponse.grants[0]?.grant_id || '')
      for (const requestId of identity.pendingEnrollmentRequestIds || []) {
        try {
          const status = await enrollmentRequestStatus(requestId)
          await applyEnrollmentStatus(status)
          break
        } catch (statusError) {
          if (!(statusError instanceof OfflineV3APIError) || statusError.status !== 404) throw statusError
        }
      }
      const localProof = identity.browserProfileId ? await bridge.proveBrowser(CLIENT_BUILD) : null
      if (localProof?.state === 'active') {
        const localGrantItems = await readLocalGrantSummaries()
        if (localGrantItems.some(item => item.state === 'available' && item.ready)) await setOfflineV3NavigationEnabled(true)
      }
      setFeatureEnabled(true)
    } catch (refreshError) {
      if (refreshError instanceof OfflineV3APIError && refreshError.code === 'offline_v3_disabled') setFeatureEnabled(false)
      else {
        if (refreshError instanceof OfflineV3APIError) setEngine('ready')
        else setEngine('unavailable')
        setError((refreshError as Error).message || 'No se pudo comprobar el acceso offline.')
      }
    } finally {
      setBusy(current => current === 'refresh' ? '' : current)
    }
  }, [applyEnrollmentStatus, bridge, readLocalGrantSummaries])

  useEffect(() => {
    mountedRef.current = true
    void refresh()
    return () => { mountedRef.current = false }
  }, [refresh])

  useEffect(() => {
    if (!request?.id || request.state !== 'requested') return
    const timer = window.setInterval(() => void enrollmentRequestStatus(request.id).then(applyEnrollmentStatus).catch(() => {}), 5_000)
    return () => window.clearInterval(timer)
  }, [applyEnrollmentStatus, request?.id, request?.state])

  useEffect(() => {
    if (!grantId) { setSelected([]); setSelectionRevision(0); setSelectionDirty(false); setSelectionConflictConfirmation(false); return }
    const controller = new AbortController()
    void grantSelection(grantId, controller.signal).then(result => {
      setSelected(result.items.map(selectionFromResource))
      setSelectionRevision(result.selection_revision)
      setSelectionDirty(false)
      setSelectionConflictConfirmation(false)
    }).catch(fetchError => { if ((fetchError as Error).name !== 'AbortError') setError((fetchError as Error).message) })
    return () => controller.abort()
  }, [grantId])

  useEffect(() => {
    clearCredentialInputs()
    setPreparationNotice('')
  }, [grantId])

  useEffect(() => {
    if (!grant || !grant.effective_actions.includes(moduleReadAction[module])) {
      const first = moduleCopy.find(item => grant?.effective_actions.includes(moduleReadAction[item.id]))
      if (first) setModule(first.id)
    }
  }, [grant, module])

  useEffect(() => {
    if (!grantId || !module) { setCandidates([]); return }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void selectionCandidates(grantId, module, query, controller.signal)
        .then(result => setCandidates(result.items || []))
        .catch(searchError => { if ((searchError as Error).name !== 'AbortError') setError((searchError as Error).message) })
    }, 500)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [grantId, module, query])

  async function startPrincipalVerification() {
    setBusy('principal')
    setError('')
    try {
      await bridge.initializeIdentity()
      setPrincipal(await bridge.createPrincipalChallenge())
    } catch (startError) {
      setError((startError as Error).message)
    } finally { setBusy('') }
  }

  async function completePrincipalVerification() {
    if (!principal) return
    setBusy('principal')
    try {
      const deadline = Date.parse(principal.expires_at)
      while (Date.now() < deadline) {
        const status = await bridge.principalChallengeStatus(principal.challenge_id)
        if (status.state === 'completed') {
          const label = offlineBrowserLabel()
          const challenge = await bridge.browserChallenge(CLIENT_BUILD, label)
          await bridge.enrollBrowser(principal.challenge_id, challenge.challenge_id, CLIENT_BUILD, label)
          setPrincipal(null)
          await submitRequest()
          return
        }
        if (status.state === 'expired') break
        await new Promise(resolve => window.setTimeout(resolve, 1_000))
      }
      throw new Error('La comprobación de Windows venció. Inténtala nuevamente.')
    } catch (verifyError) {
      setError((verifyError as Error).message)
    } finally { setBusy('') }
  }

  async function submitRequest() {
    setBusy('request')
    setError('')
    try {
      await bridge.initializeIdentity()
      const challenge = await createEnrollmentChallenge()
      const label = offlineBrowserLabel()
      const payload = await bridge.enrollmentMaterial(challenge, {
        displayName: label,
        clientVersion: CLIENT_BUILD,
      })
      const result = await submitEnrollmentRequest(payload)
      await bridge.rememberEnrollmentRequest(result.request.id)
      setRequest(result.request)
    } catch (requestError) {
      setError((requestError as Error).message)
    } finally { setBusy('') }
  }

  async function requestAccess() {
    const identity = await bridge.initializeIdentity().catch(() => null)
    if (!identity?.browserProfileId) await startPrincipalVerification()
    else await submitRequest()
  }

  async function saveSelection() {
    if (!grant || busy) return
    setBusy('selection')
    setError('')
    try {
      // A selection authority change must not proceed if local state cannot be
      // inspected: otherwise an unavailable motor could leave a usable stale
      // copy. This path deliberately does not use the best-effort refresh.
      const freshLocalItems = (await bridge.grants()).items
      setLocalGrants(indexLocalGrantSummaries(freshLocalItems))
      const freshLocal = freshLocalItems.find(item => item.grant_id === grant.grant_id) || localGrant
      const blocked = localGrantBlocksSelectionChange(freshLocal)
      if (blocked) { setError(blocked); return }
      if ((freshLocal?.conflict_count || 0) > 0 && !selectionConflictConfirmation) {
        setSelectionConflictConfirmation(true)
        setError('Hay cambios en conflicto registrados. Revisa "Cambios por revisar" o vuelve a pulsar para confirmar: al retirar un recurso, sus detalles locales también pueden dejar de estar disponibles.')
        return
      }
      // Fail closed locally before changing server authority. If the network
      // write fails, the prior copy remains sealed until an explicit renewal;
      // it is never silently reopened under a stale selection lease.
      if (freshLocal && freshLocal.state !== 'revoked') {
        const suspended = await bridge.suspendGrantForSelection(grant.grant_id)
        broadcastOfflineProfileEpoch(suspended.profile_epoch)
        await readLocalGrantSummaries()
      }
      const result = await replaceGrantSelection(grant.grant_id, selectionRevision, selected.map(item => ({ module: item.module, resource_type: item.resource_type, resource_id: item.resource_id })))
      setSelected(result.items.map(selectionFromResource))
      setSelectionRevision(result.selection_revision)
      setGrants(current => current.map(item => item.grant_id === grant.grant_id ? { ...item, selection_revision: result.selection_revision } : item))
      setSelectionDirty(false)
      setSelectionConflictConfirmation(false)
    } catch (saveError) {
      setError(saveError instanceof LocalServiceError && saveError.code === 'pending_operations'
        ? 'Se detectó un cambio local pendiente mientras guardabas. Sincronízalo antes de modificar qué recursos se conservan.'
        : (saveError as Error).message)
      // Keep the user's draft on transport/local failures. If the optimistic
      // server revision itself is stale, reconcile canonical authority; a PUT
      // whose response was lost will deterministically land in this branch on
      // retry instead of duplicating any mutation.
      if (saveError instanceof OfflineV3APIError && saveError.status === 409) {
        await grantSelection(grant.grant_id).then(result => {
          setSelected(result.items.map(selectionFromResource))
          setSelectionRevision(result.selection_revision)
          setSelectionDirty(false)
        }).catch(() => {})
      }
    } finally { setBusy('') }
  }

  async function downloadMotor() {
    setBusy('download')
    setError('')
    try {
      const token = localStorage.getItem('token') || ''
      const response = await fetch('/api/offline/v3/installer', { headers: token ? { Authorization: `Bearer ${token}` } : {}, credentials: 'include', cache: 'no-store' })
      const expected = (response.headers.get('X-Clarin-SHA256') || '').toLowerCase()
      if (!response.ok || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Clarin no publicó un instalador verificable.')
      const blob = await response.blob()
      const actual = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('')
      if (actual !== expected) throw new Error('La descarga fue descartada porque su SHA-256 no coincide.')
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = 'Clarin-Offline-Setup.exe'
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (downloadError) { setError((downloadError as Error).message) } finally { setBusy('') }
  }

  function clearCredentialInputs() {
    if (provisionPasswordRef.current) provisionPasswordRef.current.value = ''
    if (provisionConfirmationRef.current) provisionConfirmationRef.current.value = ''
    setCredentialsReady(false)
  }

  function updateCredentialReadiness() {
    const password = provisionPasswordRef.current?.value || ''
    setCredentialsReady(password.length > 0 && password === (provisionConfirmationRef.current?.value || ''))
  }

  async function waitForPreparedGrant(targetGrantId: string) {
    const deadline = Date.now() + 120_000
    let lastItems: GrantSummary[] = []
    while (Date.now() < deadline) {
      const page = await bridge.grants()
      lastItems = page.items
      const current = page.items.find(item => item.grant_id === targetGrantId)
      if (current?.ready) return page.items
      if ((current?.selection_errors || 0) > 0) throw new Error('Uno o más recursos no pudieron preparar su copia protegida. Revisa el estado y vuelve a intentarlo.')
      await new Promise(resolve => window.setTimeout(resolve, 1_500))
    }
    if (lastItems.length > 0) setLocalGrants(indexLocalGrantSummaries(lastItems))
    throw new Error('La descarga protegida sigue pendiente. Mantén esta pantalla abierta y pulsa continuar para reanudarla.')
  }

  async function prepareOrRenewGrant() {
    if (!grant || busy) return
    if (!currentLogin.trim()) { setError('Clarin no pudo confirmar el usuario actual. Actualiza la sesión antes de preparar la copia.'); return }
    const renewing = localGrant?.state === 'available' || localGrant?.state === 'expired'
    if (!renewing && selected.length === 0) { setError('Selecciona y guarda al menos un recurso antes de preparar la copia.'); return }
    if (selectionDirty) { setError('Guarda la selección antes de preparar la copia.'); return }
    const password = provisionPasswordRef.current?.value || ''
    if (!password || password !== (provisionConfirmationRef.current?.value || '')) { setError('La contraseña y su confirmación deben coincidir.'); return }
    const targetGrantId = grant.grant_id
    setBusy(renewing ? 'renewal' : 'provision')
    setError('')
    setPreparationNotice('')
    try {
      // The server validates the current Clarin password first. Only after that
      // succeeds is the same value encrypted for the attested local service.
      const bootstrap = await grantBootstrap(targetGrantId, currentLogin, password)
      if (renewing) {
        const leaseChallenge = await grantServerChallenge(targetGrantId, 'lease')
        const prepared = await bridge.prepareGrantLease(targetGrantId, currentLogin, password, {
          grantBootstrap: bootstrap.grant_bootstrap,
          leaseChallenge,
        })
        const proof = await bridge.signGrantLease(prepared)
        const serverBundle = await renewGrantLease(targetGrantId, proof)
        await bridge.activateGrantLease(targetGrantId, localGrantLeaseActivationBundle(serverBundle))
      } else {
        const [keyChallenge, intakeKey] = await Promise.all([
          grantServerChallenge(targetGrantId, 'grant_keys'),
          currentSyncIntakeKey(),
        ])
        const prepared = await bridge.prepareGrantProvision(targetGrantId, currentLogin, password, {
          grantBootstrap: bootstrap.grant_bootstrap,
          keyChallenge,
        })
        const registration = await bridge.signGrantKeyRegistration(prepared)
        const serverBundle = await registerGrantKeys(targetGrantId, registration)
        await bridge.activateGrantProvision(targetGrantId, localGrantActivationBundle(serverBundle, intakeKey))
      }

      let localItems: GrantSummary[]
      if (selected.length > 0) {
        await bridge.unlock(targetGrantId, currentLogin, password)
        try {
          await bridge.triggerSync()
          localItems = await waitForPreparedGrant(targetGrantId)
        } finally {
          await bridge.lock('security').catch(() => {})
        }
      } else {
        localItems = await readLocalGrantSummaries()
      }
      if (!mountedRef.current) return
      setLocalGrants(indexLocalGrantSummaries(localItems))
      const hasReadyCopy = localItems.some(item => item.state === 'available' && item.ready)
      const shellReady = await setOfflineV3NavigationEnabled(hasReadyCopy)
      if (hasReadyCopy && !shellReady) throw new Error('La copia de datos terminó, pero el navegador no pudo guardar la entrada web offline. Pulsa continuar para reintentarlo.')
      setPreparationNotice(selected.length === 0
        ? 'Se retiraron de esta cuenta los recursos locales que ya no están seleccionados.'
        : 'La copia protegida y la entrada web offline quedaron listas en este navegador.')
      const updated = await onlineGrants()
      setGrants(updated.grants || [])
    } catch (provisionError) {
      setError(`${(provisionError as Error).message || 'No se pudo preparar la copia.'} Puedes repetir la preparación: Clarin reutilizará las mismas claves locales y no duplicará la autorización.`)
    } finally {
      clearCredentialInputs()
      setBusy('')
    }
  }

  const maximum = Math.min(grant?.max_resources || 20, 20)
  const readableModules = moduleCopy.filter(item => grant?.effective_actions.includes(moduleReadAction[item.id]))
  const localCopyReady = Boolean(localGrant?.state === 'available' && localGrant.ready && !selectionNeedsRenewal)
  const localCopyPaused = Boolean(localGrant?.state === 'available' && !selectionNeedsRenewal && selected.length === 0)

  return <div className="space-y-5 p-5">
    <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div><div className="flex items-center gap-2 font-semibold text-slate-900"><CloudOff className="h-5 w-5 text-emerald-600" />Acceso web offline</div><p className="mt-1 text-sm text-slate-600">Clarin identifica Windows y este navegador automáticamente. No copies IDs, certificados ni claves.</p></div>
      <button type="button" onClick={() => void refresh()} disabled={Boolean(busy)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm"><RefreshCw className={busy === 'refresh' ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />Actualizar</button>
    </div>

    {!featureEnabled && <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><strong>Piloto cerrado.</strong> La funcionalidad v3 continúa desactivada y no se abrirán copias locales.</div>}
    {engine === 'unavailable' && <div className="rounded-xl border border-sky-200 bg-sky-50 p-4"><div className="flex gap-3"><HardDrive className="mt-0.5 h-5 w-5 text-sky-700" /><div><strong className="text-slate-900">Falta el motor de Windows</strong><p className="mt-1 text-sm text-slate-600">Se instala una sola vez. Después el usuario trabaja desde la misma web.</p></div></div><button type="button" onClick={() => void downloadMotor()} disabled={busy === 'download'} className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-medium text-white"><Download className="h-4 w-4" />{busy === 'download' ? 'Verificando…' : 'Descargar instalador'}</button></div>}
    {engine === 'ready' && !request && <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4"><div className="flex gap-3"><MonitorCheck className="mt-0.5 h-5 w-5 text-emerald-700" /><div><strong className="text-slate-900">Este equipo puede solicitar acceso</strong><p className="mt-1 text-sm text-slate-600">El superadmin decidirá las cuentas y acciones permitidas para la combinación exacta de PC, Windows, navegador y usuario Clarin.</p></div></div><button type="button" onClick={() => void requestAccess()} disabled={Boolean(busy) || !featureEnabled} className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white disabled:opacity-50"><ShieldCheck className="h-4 w-4" />Solicitar acceso offline</button></div>}
    {principal && <div className="rounded-xl border border-sky-200 bg-sky-50 p-4"><strong>Comprueba tu usuario de Windows</strong><p className="mt-1 text-sm text-slate-600">Abre el helper de Clarin y vuelve a esta pestaña. La comprobación termina automáticamente.</p><a href={principal.launch_uri} onClick={() => window.setTimeout(() => void completePrincipalVerification(), 600)} className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white"><KeyRound className="h-4 w-4" />Comprobar Windows</a></div>}
    {request && <div className={`rounded-xl border p-4 text-sm ${requestTone(request.state)}`}><div className="font-semibold">{request.state === 'approved' ? 'Acceso aprobado' : request.state === 'requested' ? 'Esperando al superadmin' : request.state === 'rejected' ? 'Solicitud rechazada' : 'Acceso revocado'}</div><div className="mt-1">{request.display_name} · {request.principal_display_name}</div></div>}
    {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}
    {preparationNotice && <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">{preparationNotice}</div>}

    {grant && <section className="space-y-4 rounded-xl border border-slate-200 p-4">
      <div><h3 className="font-semibold text-slate-900">Qué quieres sincronizar</h3><p className="mt-1 text-sm text-slate-500">Tú eliges dentro de lo aprobado. Clarin nunca descargará recursos de otra cuenta.</p></div>
      <label className="block text-sm font-medium text-slate-700">Cuenta autorizada<select value={grantId} disabled={Boolean(busy)} onChange={event => setGrantId(event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-slate-200 bg-white px-3 disabled:opacity-60">{grants.map(item => <option key={item.grant_id} value={item.grant_id}>{item.account_name} · {item.display_user}</option>)}</select></label>
      <div className="flex flex-wrap gap-2">{readableModules.map(item => <button type="button" key={item.id} disabled={Boolean(busy)} onClick={() => setModule(item.id)} className={`min-h-11 rounded-lg border px-3 text-left text-sm disabled:opacity-60 ${module === item.id ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-slate-200 bg-white text-slate-600'}`}><span className="font-medium">{item.label}</span><span className="ml-1 text-xs opacity-75">{item.detail}</span></button>)}</div>
      <label className="relative block"><Search className="absolute left-3 top-3.5 h-4 w-4 text-slate-400" /><input value={query} disabled={Boolean(busy)} onChange={event => setQuery(event.target.value)} className="min-h-11 w-full rounded-lg border border-slate-200 pl-10 pr-3 text-sm disabled:opacity-60" placeholder="Buscar recursos autorizados…" /></label>
      <div className="max-h-72 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">{candidates.map(candidate => { const checked = selected.some(item => item.module === candidate.module && item.resource_id === candidate.resource_id); return <button type="button" disabled={Boolean(busy)} key={`${candidate.module}:${candidate.resource_id}`} onClick={() => setSelected(current => { const next = toggleV3Selection(current, candidate, maximum); if (next !== current) { setSelectionDirty(true); setSelectionConflictConfirmation(false) } return next })} className="flex min-h-12 w-full items-center gap-3 px-3 text-left text-sm hover:bg-slate-50 disabled:opacity-60"><span className={`flex h-5 w-5 items-center justify-center rounded border ${checked ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-slate-300'}`}>{checked && <Check className="h-3.5 w-3.5" />}</span><span className="min-w-0 flex-1"><span className="block truncate font-medium text-slate-800">{candidate.label}</span>{candidate.subtitle && <span className="block truncate text-xs text-slate-500">{candidate.subtitle}</span>}</span></button>})}</div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><span className="text-sm text-slate-500">{selected.length} de {maximum} recursos seleccionados</span><button type="button" onClick={() => void saveSelection()} disabled={Boolean(busy) || selectionRevision < 1 || !selectionDirty} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white disabled:opacity-50">{busy === 'selection' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{selectionConflictConfirmation ? 'Confirmar cambio de selección' : 'Guardar selección'}</button></div>
      {localCopyReady ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900"><div className="flex items-center gap-2 font-semibold"><ShieldCheck className="h-4 w-4" />Copia protegida preparada</div><p className="mt-1">Los {localGrant?.selection_ready || selected.length} recursos están guardados y verificados. Ya puedes usar esta cuenta cuando Clarin o Cloudflare no respondan.</p></div> : localCopyPaused ? <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><strong>Acceso offline pausado para esta cuenta</strong><p className="mt-1">No hay recursos seleccionados. La web offline no mostrará datos de esta cuenta.</p></div> : <div className="rounded-xl border border-sky-200 bg-sky-50 p-4"><div className="flex items-start gap-3"><KeyRound className="mt-0.5 h-5 w-5 text-sky-700" /><div><strong className="text-slate-900">{selectionNeedsRenewal ? 'Aplicar la nueva selección a esta copia' : localGrant?.state === 'available' ? 'Continuar la descarga protegida' : localGrant?.state === 'preparing' || grant.keys_ready ? 'Retomar preparación segura' : 'Preparar esta cuenta para uso offline'}</strong><p className="mt-1 text-sm text-slate-600">Confirma la contraseña del usuario <strong>{currentLogin || 'actual'}</strong>. Clarin verifica primero esa identidad exacta y sólo después cifra las credenciales para el motor local; no se guardan en el navegador.</p>{localGrant?.state === 'available' && !localGrant.ready && <p className="mt-1 text-xs text-slate-500">Preparados: {localGrant.selection_ready || 0} de {localGrant.selection_total || selected.length}. Mantén esta pantalla abierta mientras termina.</p>}</div></div><div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="text-sm text-slate-700"><span>Contraseña de Clarin</span><input ref={provisionPasswordRef} type="password" autoComplete="off" data-1p-ignore onInput={updateCredentialReadiness} className="mt-1 min-h-11 w-full rounded-lg border border-slate-200 bg-white px-3" /></label><label className="text-sm text-slate-700"><span>Confirmar contraseña</span><input ref={provisionConfirmationRef} type="password" autoComplete="off" data-1p-ignore onInput={updateCredentialReadiness} className="mt-1 min-h-11 w-full rounded-lg border border-slate-200 bg-white px-3" /></label></div><button type="button" onClick={() => void prepareOrRenewGrant()} disabled={Boolean(busy) || !currentLogin.trim() || !credentialsReady || (!localGrant && selected.length === 0) || selectionDirty} className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-45">{busy === 'provision' || busy === 'renewal' ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}{selectionNeedsRenewal ? 'Aplicar selección y verificar' : localGrant?.state === 'available' ? 'Continuar preparación' : localGrant?.state === 'preparing' || grant.keys_ready ? 'Retomar sin regenerar claves' : 'Preparar copia protegida'}</button></div>}
    </section>}
  </div>
}
