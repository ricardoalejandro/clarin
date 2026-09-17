'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, Database, Download, Loader2, Search, ShieldCheck, Trash2, WifiOff } from 'lucide-react'

type Grant = {
  id: string
  account_id: string
  account_name?: string
  terminal_id: string
  modules: string[]
  quota_bytes: number
  max_offline_seconds: number
  selection_revision: number
}
export type OfflineSelection = {
  id?: string
  module: string
  resource_type: string
  resource_id: string
  label?: string
  subtitle?: string
}
type Candidate = { id: string; type: string; label: string; subtitle?: string }
type OfflineConflict = { id: string; module: string; resource_id: string; conflict_paths: string[]; created_at: string }
type EnrollmentStatus = { terminal_id: string; state: 'requested' | 'approved' | 'active' | 'rejected'; display_name?: string; [key: string]: unknown }

declare global {
  interface Window {
    clarinDesktop?: {
      bootstrapStatus: () => Promise<{ state: string; terminal_id?: string }>
		prepareEnrollment: () => Promise<Record<string, unknown> & { success?: boolean; state: string; terminal_id: string; error?: string; error_code?: string; device_posture?: { bitlocker: string; windows_hello: string } }>
      completeEnrollment: (approval: EnrollmentStatus) => Promise<{ success: boolean }>
    }
  }
}

const moduleLabels: Record<string, string> = { whiteboards: 'Pizarra', tasks: 'Tareas', contacts: 'Contactos', programs: 'Programas' }
export const maxOfflineResources = 20

export function toggleOfflineSelection(current: OfflineSelection[], module: string, candidate: Candidate) {
  const found = current.some((item) => item.module === module && item.resource_id === candidate.id)
  if (found) return current.filter((item) => !(item.module === module && item.resource_id === candidate.id))
  if (current.length >= maxOfflineResources) return current
  return [...current, { module, resource_type: candidate.type, resource_id: candidate.id, label: candidate.label, subtitle: candidate.subtitle }]
}

export function removeResolvedOfflineConflict(current: OfflineConflict[], conflictID: string) {
  return current.filter((item) => item.id !== conflictID)
}

export function installerFilenameFromDisposition(disposition: string | null, fallback: string) {
	const match = disposition?.match(/filename="([^"\\/]+)"/i)
	return match?.[1] || fallback || 'Clarin-Offline-Setup.exe'
}

export async function sha256Hex(blob: Blob) {
	const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
	return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
}

export function offlineInstallerDownloadURL(checksum: string) {
	const normalized = checksum.trim().toLowerCase()
	return /^[a-f0-9]{64}$/.test(normalized)
		? `/api/offline/v2/installer?sha256=${normalized}`
		: '/api/offline/v2/installer'
}

export async function completeApprovedOfflineEnrollment(
	bridge: NonNullable<Window['clarinDesktop']>,
	approval: EnrollmentStatus,
): Promise<EnrollmentStatus> {
	const completed = await bridge.completeEnrollment(approval)
	if (!completed?.success) throw new Error('Windows no pudo instalar la autorización offline.')
	return { ...approval, state: 'active' }
}

export default function OfflineAccessPanel() {
  const [grants, setGrants] = useState<Grant[]>([])
  const [grantID, setGrantID] = useState('')
  const [module, setModule] = useState('')
  const [selections, setSelections] = useState<OfflineSelection[]>([])
  const [query, setQuery] = useState('')
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [loading, setLoading] = useState(true)
	const [controlAvailable, setControlAvailable] = useState(true)
	const [installerAvailable, setInstallerAvailable] = useState(false)
	const [installerFilename, setInstallerFilename] = useState('')
	const [installerSHA256, setInstallerSHA256] = useState('')
	const [desktopAvailable, setDesktopAvailable] = useState(false)
	const [enrollment, setEnrollment] = useState<EnrollmentStatus | null>(null)
	const [enrollmentBusy, setEnrollmentBusy] = useState(false)
	const [downloading, setDownloading] = useState(false)
  const [searching, setSearching] = useState(false)
  const [saving, setSaving] = useState(false)
	const [conflicts, setConflicts] = useState<OfflineConflict[]>([])
	const [resolvingConflictID, setResolvingConflictID] = useState('')
  const [error, setError] = useState('')
  const headers = useMemo(() => ({ Authorization: `Bearer ${typeof window === 'undefined' ? '' : localStorage.getItem('token') || ''}`, 'Content-Type': 'application/json' }), [])
  const grant = grants.find((item) => item.id === grantID)
	const completingRef = useRef(false)
	const savingRef = useRef(false)
	const selectionGenerationRef = useRef(0)

	const refreshGrants = useCallback(async () => {
		const response = await fetch('/api/offline/v2/grants', { headers })
		const data = await response.json()
		if (!response.ok || !data.success) {
			if (response.status === 503) setControlAvailable(false)
			else throw new Error(data.error || 'No se pudo consultar la autorización offline.')
			return
		}
		setControlAvailable(true)
		const next = (data.grants || []) as Grant[]
		setGrants(next)
		setInstallerAvailable(Boolean(data.installer_available))
		setInstallerFilename(data.installer_filename || '')
		setInstallerSHA256(data.installer_sha256 || '')
		setGrantID((current) => next.some((item) => item.id === current) ? current : next[0]?.id || '')
	}, [headers])

  useEffect(() => {
    let active = true
    void (async () => {
      setLoading(true)
      try {
		await refreshGrants()
		if (!active) return
		const bridge = window.clarinDesktop
		setDesktopAvailable(Boolean(bridge))
		if (bridge) {
			const status = await bridge.bootstrapStatus()
			if (status.terminal_id && status.state === 'pending') setEnrollment({ terminal_id: status.terminal_id, state: 'requested' })
			if (status.terminal_id && status.state === 'enrolled') setEnrollment({ terminal_id: status.terminal_id, state: 'active' })
		}
      } catch {
        if (active) setError('No se pudo conectar con el servidor.')
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [refreshGrants])

	useEffect(() => {
		if (!enrollment?.terminal_id || enrollment.state === 'active' || enrollment.state === 'rejected' || !desktopAvailable) return
		let cancelled = false
		let timer = 0
		async function poll() {
			try {
				const response = await fetch(`/api/offline/v2/enrollment-requests/${enrollment!.terminal_id}`, { headers })
				const data = await response.json()
				if (cancelled || !response.ok || !data.success) return
				if (data.state === 'approved') {
					if (completingRef.current || !window.clarinDesktop) return
					completingRef.current = true
					setEnrollmentBusy(true)
					try {
						const activeEnrollment = await completeApprovedOfflineEnrollment(window.clarinDesktop, data)
						await refreshGrants()
						if (!cancelled) {
							setEnrollment(activeEnrollment)
							window.clearInterval(timer)
						}
					} finally {
						completingRef.current = false
						if (!cancelled) setEnrollmentBusy(false)
					}
					return
				}
				if (data.state === 'active') await refreshGrants()
				if (!cancelled) setEnrollment(data)
			} catch (requestError) {
				if (!cancelled) setError((requestError as Error).message || 'No se pudo consultar el estado de la solicitud offline.')
			}
		}
		void poll()
		timer = window.setInterval(() => void poll(), 5000)
		return () => { cancelled = true; window.clearInterval(timer) }
	}, [desktopAvailable, enrollment?.state, enrollment?.terminal_id, headers, refreshGrants])

	useEffect(() => {
		const controller = new AbortController()
		void (async () => {
			try {
				const response = await fetch('/api/offline/v2/conflicts?limit=100', { headers, signal: controller.signal })
				const data = await response.json()
				if (response.ok && data.success) setConflicts(data.conflicts || [])
			} catch (requestError) {
				if ((requestError as Error).name !== 'AbortError') setError('No se pudieron consultar los conflictos offline.')
			}
		})()
		return () => controller.abort()
	}, [headers])

  useEffect(() => {
    const generation = ++selectionGenerationRef.current
    if (!grantID) {
      setSelections([])
      return
    }
    const controller = new AbortController()
    void (async () => {
      setError('')
      try {
        const response = await fetch(`/api/offline/v2/grants/${grantID}/selections`, { headers, signal: controller.signal })
        const data = await response.json()
        if (response.ok && data.success) {
          if (generation === selectionGenerationRef.current) setSelections(data.selections || [])
        } else if (generation === selectionGenerationRef.current) setError(data.error || 'No se pudieron cargar los recursos.')
      } catch (requestError) {
        if ((requestError as Error).name !== 'AbortError') setError('No se pudo conectar con el servidor.')
      }
    })()
    return () => controller.abort()
  }, [grantID, headers])

  useEffect(() => {
    const selectedGrant = grants.find((item) => item.id === grantID)
    if (!selectedGrant) {
      setModule('')
      return
    }
    setModule((current) => selectedGrant.modules.includes(current) ? current : selectedGrant.modules[0] || '')
  }, [grantID, grants])

  useEffect(() => {
    if (!grantID || !module) {
      setCandidates([])
      return
    }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void (async () => {
        setSearching(true)
        try {
          const params = new URLSearchParams({ module, q: query })
          const response = await fetch(`/api/offline/v2/grants/${grantID}/resources?${params}`, { headers, signal: controller.signal })
          const data = await response.json()
          if (response.ok && data.success) setCandidates(data.items || [])
          else if (!controller.signal.aborted) setError(data.error || 'No se pudieron buscar recursos.')
        } catch (requestError) {
          if ((requestError as Error).name !== 'AbortError') setError('No se pudo completar la búsqueda.')
        } finally {
          if (!controller.signal.aborted) setSearching(false)
        }
      })()
    }, 500)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [grantID, module, query, headers])

  async function persist(next: OfflineSelection[]) {
    if (!grantID || savingRef.current) return
    savingRef.current = true
    const generation = ++selectionGenerationRef.current
    const previous = selections
    setSelections(next)
    setSaving(true)
    setError('')
    try {
      const response = await fetch(`/api/offline/v2/grants/${grantID}/selections`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ selections: next.map((item) => ({ module: item.module, resource_type: item.resource_type, resource_id: item.resource_id })) }),
      })
      const data = await response.json()
      if (!response.ok || !data.success) {
        if (generation === selectionGenerationRef.current) setSelections(previous)
        setError(data.error || 'No se pudo guardar la selección.')
        return
      }
      if (generation === selectionGenerationRef.current) setSelections(data.selections || next)
      setGrants((current) => current.map((item) => item.id === grantID ? { ...item, selection_revision: data.selection_revision } : item))
    } catch {
      if (generation === selectionGenerationRef.current) setSelections(previous)
      setError('No se pudo conectar con el servidor. La selección anterior fue restaurada.')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

	async function keepServerVersion(conflictID: string) {
		if (resolvingConflictID) return
		setResolvingConflictID(conflictID)
		setError('')
		try {
			const response = await fetch(`/api/offline/v2/conflicts/${conflictID}/resolve`, { method: 'POST', headers, body: JSON.stringify({ strategy: 'server' }) })
			const data = await response.json()
			if (!response.ok || !data.success) {
				setError(data.error || 'No se pudo resolver el conflicto.')
				return
			}
			setConflicts((current) => removeResolvedOfflineConflict(current, conflictID))
		} catch {
			setError('No se pudo conectar con el servidor para resolver el conflicto.')
		} finally {
			setResolvingConflictID('')
		}
		}

	async function requestOfflineAccess() {
		if (!window.clarinDesktop || enrollmentBusy) return
		setEnrollmentBusy(true)
		setError('')
		try {
			const prepared = await window.clarinDesktop.prepareEnrollment()
			if (prepared.success === false) throw new Error(prepared.error || 'No se pudo preparar este equipo.')
			if (prepared.state === 'active') {
				setEnrollment({ terminal_id: prepared.terminal_id, state: 'active' })
				return
			}
			const response = await fetch('/api/offline/v2/enrollment-requests', {
				method: 'POST', headers,
				body: JSON.stringify({ terminal_id: prepared.terminal_id, display_name: prepared.display_name, public_key_pem: prepared.public_key_pem, windows_sid_hash: prepared.windows_sid_hash, install_instance_hash: prepared.install_instance_hash, client_version: prepared.client_version, device_posture: prepared.device_posture }),
			})
			const data = await response.json()
			if (!response.ok || !data.success) throw new Error(data.error || 'No se pudo enviar la solicitud offline.')
			setEnrollment({ terminal_id: data.terminal_id, state: data.state })
		} catch (requestError) {
			setError((requestError as Error).message || 'No se pudo preparar este equipo.')
		} finally {
			setEnrollmentBusy(false)
		}
	}

	async function downloadArtifact(path: string, checksum: string, fallback: string) {
		setDownloading(true)
		setError('')
		try {
			const response = await fetch(path, { headers: { Authorization: headers.Authorization } })
			if (!response.ok) {
				const data = await response.json().catch(() => ({}))
				setError(data.error || 'No se pudo descargar el archivo offline.')
				return
			}
			const blob = await response.blob()
			const advertised = (response.headers.get('X-Clarin-SHA256') || checksum).trim().toLowerCase()
			if (!advertised || await sha256Hex(blob) !== advertised) {
				setError('La descarga no superó la verificación SHA-256 y fue descartada.')
				return
			}
			const url = URL.createObjectURL(blob)
			try {
				const anchor = document.createElement('a')
				anchor.href = url
				anchor.download = installerFilenameFromDisposition(response.headers.get('Content-Disposition'), fallback)
				anchor.click()
			} finally {
				URL.revokeObjectURL(url)
			}
		} catch {
			setError('No se pudo conectar con el servidor para descargar el instalador.')
		} finally {
			setDownloading(false)
		}
	}

	async function downloadInstaller() {
		if (!installerAvailable || downloading) return
		await downloadArtifact(offlineInstallerDownloadURL(installerSHA256), installerSHA256, installerFilename)
	}

  if (loading) return <div className="flex min-h-48 items-center justify-center text-sm text-slate-500"><Loader2 className="mr-2 h-4 w-4 animate-spin" />Consultando autorización offline…</div>
	if (!controlAvailable) return <div className="mx-auto max-w-xl py-12 text-center"><WifiOff className="mx-auto h-9 w-9 text-amber-400" /><h3 className="mt-3 text-sm font-semibold text-slate-900">Modo offline todavía no activado</h3><p className="mt-1 text-sm text-slate-500">La infraestructura está preparada y cerrada. Un operador debe encender las banderas del piloto cuando el equipo Windows esté listo.</p></div>

  const selectedForModule = selections.filter((item) => item.module === module)
  return <div className="space-y-5">
	<section className="rounded-xl border border-slate-200 bg-white p-4"><div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div className="max-w-2xl"><h3 className="text-sm font-semibold text-slate-900">Aplicación Clarín para Windows 11</h3>{desktopAvailable ? <p className="mt-1 text-sm text-slate-500">Este equipo se identifica automáticamente con una clave privada no exportable. No tienes que copiar IDs, claves ni certificados.</p> : <p className="mt-1 text-sm text-slate-500">El instalador no depende de certificados comerciales. Clarín verifica su SHA-256 antes de descargarlo; Windows puede mostrar el aviso normal de editor desconocido.</p>}</div>{desktopAvailable ? <button type="button" disabled={enrollmentBusy || enrollment?.state === 'requested' || enrollment?.state === 'approved' || enrollment?.state === 'active'} onClick={() => void requestOfflineAccess()} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-medium text-white disabled:opacity-45">{enrollmentBusy && <Loader2 className="h-4 w-4 animate-spin" />}{enrollment?.state === 'requested' ? 'Esperando aprobación' : enrollment?.state === 'approved' ? 'Instalando autorización…' : enrollment?.state === 'active' ? 'Equipo autorizado' : enrollment?.state === 'rejected' ? 'Solicitud rechazada' : 'Solicitar acceso offline'}</button> : <button type="button" disabled={!installerAvailable || downloading} onClick={() => void downloadInstaller()} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 text-sm font-medium text-white disabled:opacity-45">{downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}{downloading ? 'Verificando SHA-256…' : 'Descargar instalador'}</button>}</div>{desktopAvailable && enrollment?.state === 'requested' && <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Solicitud enviada para <span className="font-medium">{enrollment.display_name || 'este equipo'}</span>. La pantalla se actualizará automáticamente cuando un superadmin decida.</div>}{desktopAvailable && enrollment?.state === 'active' && <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">Terminal activa. El contenido seleccionado se sincroniza y queda disponible durante un máximo de 24 horas sin conexión.</div>}</section>
	{conflicts.length > 0 && <section className="rounded-xl border border-amber-200 bg-amber-50 p-4"><div className="flex items-start gap-3"><AlertTriangle className="mt-0.5 h-5 w-5 text-amber-700" /><div className="min-w-0 flex-1"><h3 className="text-sm font-semibold text-amber-950">Cambios offline que necesitan decisión</h3><p className="mt-1 text-sm text-amber-800">La primera versión habilita la resolución segura conservando el dato canónico del servidor. La mezcla manual permanece bloqueada.</p><div className="mt-3 space-y-2">{conflicts.map((conflict) => <div key={conflict.id} className="flex items-center gap-3 rounded-lg border border-amber-200 bg-white p-3"><div className="min-w-0 flex-1"><div className="truncate text-sm font-medium text-slate-800">{moduleLabels[conflict.module] || conflict.module} · {conflict.resource_id.slice(0, 8)}</div><div className="truncate text-xs text-slate-500">{conflict.conflict_paths.join(', ') || 'Cambio concurrente'} · {new Date(conflict.created_at).toLocaleString('es-PE')}</div></div><button type="button" disabled={Boolean(resolvingConflictID)} onClick={() => void keepServerVersion(conflict.id)} className="button min-h-11 rounded-lg border border-amber-300 bg-amber-100 px-3 text-sm font-medium text-amber-900 disabled:opacity-60">{resolvingConflictID === conflict.id ? 'Resolviendo…' : 'Conservar servidor'}</button></div>)}</div></div></div></section>}
	{grants.length === 0 && <div className="rounded-xl border border-slate-200 bg-slate-50 p-8 text-center text-sm text-slate-500"><WifiOff className="mx-auto mb-3 h-8 w-8 text-slate-300" />Cuando el superadmin apruebe este equipo aparecerán aquí las cuentas y los recursos que puedes elegir.</div>}
    {grants.length > 0 && <>
    <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
      <div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 h-5 w-5 text-emerald-700" /><div><h3 className="text-sm font-semibold text-emerald-950">Tú decides qué datos estarán disponibles</h3><p className="mt-1 text-sm text-emerald-800">Solo puedes seleccionar recursos que ya puedes consultar en Clarin. Si pierdes acceso, Clarin bloquea nuevas sincronizaciones y el contenido local deja de abrirse al vencer la autorización, como máximo en 24 horas.</p></div></div>
    </div>

    <label className="block max-w-xl text-sm font-medium text-slate-700">Terminal y cuenta<select value={grantID} onChange={(event) => { setGrantID(event.target.value); setQuery('') }} className="mt-1.5 min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 font-normal">{grants.map((item) => <option key={item.id} value={item.id}>{item.account_name || item.account_id} · terminal {item.terminal_id.slice(0, 8)}</option>)}</select></label>

    {grant && <>
      <div className="flex flex-wrap gap-2">{grant.modules.map((item) => <button type="button" key={item} onClick={() => { setModule(item); setQuery('') }} className={`min-h-11 rounded-xl border px-4 text-sm font-medium ${module === item ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}>{moduleLabels[item] || item}<span className="ml-2 rounded-full bg-white/80 px-2 py-0.5 text-xs">{selections.filter((selection) => selection.module === item).length}</span></button>)}</div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(280px,0.72fr)]">
        <section className="rounded-xl border border-slate-200">
          <div className="border-b border-slate-100 p-4"><label className="relative block"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input value={query} onChange={(event) => setQuery(event.target.value)} maxLength={160} className="min-h-11 w-full rounded-xl border border-slate-200 pl-9 pr-10 text-sm" placeholder={`Buscar en ${moduleLabels[module] || module}…`} />{searching && <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-slate-400" />}</label></div>
          <div className="max-h-[28rem] overflow-y-auto p-2">{!searching && candidates.length === 0 ? <div className="p-8 text-center text-sm text-slate-500">No hay resultados disponibles.</div> : candidates.map((candidate) => {
            const selected = selections.some((item) => item.module === module && item.resource_id === candidate.id)
            return <button type="button" disabled={saving || (!selected && selections.length >= maxOfflineResources)} key={candidate.id} onClick={() => void persist(toggleOfflineSelection(selections, module, candidate))} className="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-slate-50 disabled:opacity-50"><span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${selected ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-slate-300'}`}>{selected && <Check className="h-3.5 w-3.5" />}</span><span className="min-w-0"><span className="block truncate text-sm font-medium text-slate-800">{candidate.label}</span>{candidate.subtitle && <span className="block truncate text-xs text-slate-500">{candidate.subtitle}</span>}</span></button>
          })}</div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-slate-50/60 p-4"><div className="flex items-center justify-between"><h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900"><Database className="h-4 w-4 text-emerald-600" />Seleccionados · {selections.length}/{maxOfflineResources}</h3>{saving && <span className="flex items-center gap-1 text-xs text-slate-500"><Loader2 className="h-3.5 w-3.5 animate-spin" />Guardando</span>}</div>{selectedForModule.length === 0 ? <p className="mt-5 text-sm text-slate-500">Selecciona al menos un recurso para descargar este módulo.</p> : <div className="mt-3 space-y-2">{selectedForModule.map((item) => <div key={`${item.module}-${item.resource_id}`} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white p-3"><span className="min-w-0 flex-1 truncate text-sm text-slate-700">{item.label || item.resource_id}</span><button type="button" disabled={saving} onClick={() => void persist(selections.filter((selection) => selection.resource_id !== item.resource_id || selection.module !== item.module))} className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label={`Quitar ${item.label || item.resource_id}`}><Trash2 className="h-4 w-4" /></button></div>)}</div>}</section>
      </div>
    </>}
    </>}
    {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
  </div>
}
