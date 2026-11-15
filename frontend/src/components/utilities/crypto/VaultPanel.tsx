'use client'

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, Download, KeyRound, Loader2, Plus, RefreshCw, Search, Trash2, Upload, X } from 'lucide-react'
import { useDebouncedValue } from '@/lib/useDebouncedValue'
import EditorConfirmDialog from '@/components/documents/EditorConfirmDialog'
import { jsonRequest, libraryRequest, operationId } from '../library/libraryApi'
import { useUtilityDocument, useUtilityDocumentState } from '../library/UtilityDocumentContext'
import { CryptoInputError } from './cryptoOperations'
import type { KeyMaterial, VaultCandidate, VaultKind } from './pkiOperations'
import { usePkiJob } from './usePkiJob'
import { CryptoHelp, CryptoToolbarActions } from './CryptoToolbarContext'
import '../utility-density.css'

export interface VaultItem {
  id: string; name: string; description: string; kind: VaultKind; algorithm: string; bits?: number
  public_data: string; metadata: Record<string, unknown>; version: number; created_at: string; updated_at: string
}
export interface VaultSelection { id: string; name?: string; kind: VaultKind; algorithm: string; bits?: number }
const buttonBase = 'utility-control inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border px-2 text-xs font-medium focus-visible:ring-2 focus-visible:ring-emerald-600 disabled:opacity-50'
const button = `${buttonBase} border-slate-200 bg-white text-slate-700 hover:bg-slate-50`
const primary = `${buttonBase} border-emerald-700 bg-emerald-700 text-white hover:bg-emerald-800`
const field = 'utility-field w-full rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-emerald-600'
const fields = 'grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr))]'

function VaultDisclosure({ title, children, open, onToggle }: { title: string; children: ReactNode; open: boolean; onToggle: () => void }) {
  const id = useId()
  return <section className="border-t border-slate-100 pt-1">
    <button type="button" className={`${buttonBase} w-full justify-between border-transparent text-slate-700 hover:bg-slate-50`} aria-expanded={open} aria-controls={id} onClick={onToggle}>{title}<ChevronDown size={14} aria-hidden className={open ? 'rotate-180' : ''} /></button>
    <div id={id} hidden={!open} className="space-y-2 pt-2">{children}</div>
  </section>
}

export function VaultPanel({ onUse, onDeleted }: { onUse: (item: VaultSelection) => void; onDeleted?: (id: string) => void }) {
  const documentSession = useUtilityDocument()
  const [query, setQuery] = useState('')
  const [settled, settleQuery] = useDebouncedValue(query)
  const [items, setItems] = useState<VaultItem[]>([])
  const [next, setNext] = useState('')
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [selectedId, setSelectedId] = useUtilityDocumentState<string>('key_id', '')
  const [selected, setSelected] = useState<VaultItem | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [kind, setKind] = useState<'aes' | 'rsa' | 'ec'>('rsa')
  const [size, setSize] = useState('3072')
  const [password, setPassword] = useState('')
  const [exportFormat, setExportFormat] = useState<'pem' | 'jwk' | 'jwk-protected' | 'p12' | 'public' | 'certificate' | 'certificate-der' | 'csr'>('pem')
  const [commonName, setCommonName] = useState('')
  const [dns, setDns] = useState('')
  const [jwt, setJwt] = useState('')
  const [output, setOutput] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [rename, setRename] = useState('')
  const [renameDescription, setRenameDescription] = useState('')
  const [creation, setCreation] = useState<'generate' | 'import' | null>(null)
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({})
  const section = (id: string) => ({ open: Boolean(openSections[id]), onToggle: () => setOpenSections(current => ({ ...current, [id]: !current[id] })) })
  const host = useRef<HTMLElement>(null)
  const [wide, setWide] = useState(false)
  const generation = useRef(0)
  const selection = useRef('')
  const queryRef = useRef(settled)
  queryRef.current = settled
  const input = useRef<HTMLInputElement>(null)
  const certificateInput = useRef<HTMLInputElement>(null)
  const downloads = useRef(new Set<string>())
  const job = usePkiJob()
  const busy = pending || job.busy
  useEffect(() => documentSession?.registerBeforeDeactivate?.(() => {
    generation.current++
    job.cancel()
    setPending(false)
  }), [documentSession, job.cancel])
  useEffect(() => () => { generation.current++; downloads.current.forEach(url => URL.revokeObjectURL(url)); downloads.current.clear() }, [])
  useEffect(() => {
    const node = host.current
    if (!node) return
    const measure = () => setWide(node.getBoundingClientRect().width >= 672)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    void libraryRequest<{ configured: boolean }>('/vault/status', { signal: controller.signal }).then(value => setConfigured(value.configured)).catch(() => { if (!controller.signal.aborted) setError('No se pudo comprobar la disponibilidad de la biblioteca de claves.') })
    return () => controller.abort()
  }, [refresh])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    void libraryRequest<{ items: VaultItem[]; next_cursor?: string; has_more: boolean }>(`/vault?q=${encodeURIComponent(settled)}`, { signal: controller.signal }).then(page => {
      if (controller.signal.aborted) return
      if (!Array.isArray(page.items)) throw new Error('Invalid collection')
      setItems(page.items); setNext(page.has_more ? page.next_cursor || '' : '')
    }).catch(() => { if (!controller.signal.aborted) setError('No se pudo cargar la biblioteca. Reintenta.') }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [settled, refresh])
  useEffect(() => {
    const controller = new AbortController()
    const selectionChanged = selection.current !== selectedId
    if (selectionChanged) {
      generation.current++; job.cancel(); setOutput(''); setPassword(''); setPending(false); selection.current = selectedId
      setOpenSections({})
    }
    setSelected(null)
    if (selectedId) void libraryRequest<{ item: VaultItem }>(`/vault/${selectedId}`, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return
      setSelected(result.item); setRename(result.item.name); setRenameDescription(result.item.description)
      if (selectionChanged) setExportFormat(result.item.kind === 'aes' ? 'jwk-protected' : result.item.kind === 'certificate' ? 'certificate' : Array.isArray(result.item.metadata.key_usage) && !result.item.metadata.key_usage.includes('sign') ? 'public' : 'pem')
    }).catch(() => { if (!controller.signal.aborted) setError('La entrada seleccionada ya no está disponible. Elige otra.') })
    return () => controller.abort()
    // The worker is scoped to the selected entry, not the list/search request.
  }, [selectedId, refresh, job.cancel])
  async function act(work: (current: () => boolean) => Promise<void>) {
    if (busy) return
    const revision = generation.current
    setPending(true); setError(''); setNotice(''); setOutput('')
    try { await work(() => generation.current === revision) }
    catch (error) {
      if (generation.current === revision && !(error instanceof Error && error.name === 'AbortError')) setError(error instanceof Error ? error.message : 'No se pudo completar la operación.')
    } finally { if (generation.current === revision) setPending(false) }
  }
  async function store(value: VaultCandidate, current: () => boolean) {
    if (!current()) return
    const result = await libraryRequest<{ item: VaultItem }>('/vault', jsonRequest('POST', { ...value, name: name.trim() || 'Nueva clave', description: description.trim(), operation_id: operationId() }))
    if (!current()) return
    setSelectedId(result.item.id); setSelected(result.item); setRefresh(value => value + 1); setNotice('Entrada guardada y protegida en tu biblioteca.'); setPassword(''); setCreation(null)
  }
  async function material(item: VaultItem) {
    const value = await libraryRequest<{ material: string }>(`/vault/${item.id}/material`)
    return value.material
  }
  function download(data: string | Uint8Array, filename: string) {
    const blob = new Blob([typeof data === 'string' ? data : new Uint8Array(data).buffer], { type: 'application/octet-stream' })
    const url = URL.createObjectURL(blob); downloads.current.add(url)
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click()
    window.setTimeout(() => { URL.revokeObjectURL(url); downloads.current.delete(url) }, 1000)
  }
  async function more() {
    const revision = generation.current
    const search = settled
    await act(async current => {
      const page = await libraryRequest<{ items: VaultItem[]; next_cursor?: string; has_more: boolean }>(`/vault?q=${encodeURIComponent(settled)}&cursor=${encodeURIComponent(next)}`)
      if (current() && revision === generation.current && queryRef.current === search) { setItems(existing => [...existing, ...page.items.filter(item => !existing.some(previous => previous.id === item.id))]); setNext(page.has_more ? page.next_cursor || '' : '') }
    })
  }
  async function attachDerived(selfSigned: boolean, current: () => boolean) {
    if (!selected) return
    const stored = await material(selected)
    if (!current()) return
    const result = await job.run<string>({ task: selfSigned ? 'certificate' : 'csr', material: stored, commonName, dns: dns.split(/[\s,]+/).filter(Boolean) })
    if (!current()) return
    const parsed = JSON.parse(stored) as KeyMaterial
    if (selfSigned) parsed.certificates = [result, ...parsed.certificates]
    else parsed.requests = [...(parsed.requests || []), result]
    let metadata = selected.metadata
    if (selfSigned) metadata = (await job.run<VaultCandidate>({ task: 'import', data: new TextEncoder().encode(result).buffer, filename: 'certificate.pem', password: '' })).metadata
    if (!current()) return
    await libraryRequest(`/vault/${selected.id}/material`, jsonRequest('PUT', { version: selected.version, material: JSON.stringify(parsed), metadata, operation_id: operationId() }))
    if (current()) { setOutput(result); setRefresh(value => value + 1); setNotice(selfSigned ? 'Certificado de prueba guardado. No representa confianza pública.' : 'Solicitud CSR guardada en esta entrada.') }
  }
  async function attachCertificate(file: File, current: () => boolean) {
    if (!selected) return
    if (file.size > 1024 * 1024) throw new CryptoInputError('El certificado supera 1 MiB.')
    const data = await file.arrayBuffer()
    if (!current()) return
    const imported = await job.run<VaultCandidate>({ task: 'import', data, filename: file.name, password: '' })
    if (!current()) return
    const certificate = JSON.parse(imported.material) as KeyMaterial
    if (!certificate.certificates.length) throw new CryptoInputError('Selecciona un certificado X.509 en PEM o DER.')
    const stored = JSON.parse(await material(selected)) as KeyMaterial
    if (!current()) return
    if (!stored.privateKey) throw new CryptoInputError('Asocia el certificado a una entrada con su clave privada.')
    // Reimport verifies that a certificate's public key matches this private key.
    const checked = await job.run<VaultCandidate>({ task: 'import', data: new TextEncoder().encode([stored.privateKey, ...certificate.certificates].join('\n')).buffer, filename: 'identity.pem', password: '' })
    if (!current()) return
    const combined = JSON.parse(checked.material) as KeyMaterial
    combined.requests = stored.requests
    await libraryRequest(`/vault/${selected.id}/material`, jsonRequest('PUT', { version: selected.version, material: JSON.stringify(combined), metadata: checked.metadata, operation_id: operationId() }))
    if (current()) { setRefresh(value => value + 1); setNotice('Certificado asociado a su clave y guardado.') }
  }
  return <section ref={host} aria-label="Biblioteca personal de claves" className="min-w-0 space-y-2">
    <h2 className="sr-only">Mis claves y certificados</h2>
    <CryptoToolbarActions>
      <button type="button" className={primary} aria-label="Nueva clave" title="Nueva clave" disabled={busy || !configured} onClick={() => setCreation('generate')}><Plus size={16} aria-hidden /></button>
      <button type="button" className={button} aria-label="Importar clave o certificado" title="Importar clave o certificado" disabled={busy || !configured} onClick={() => setCreation('import')}><Upload size={16} aria-hidden /></button>
      <button type="button" className={button} aria-label="Actualizar biblioteca de claves" title="Actualizar biblioteca de claves" onClick={() => setRefresh(value => value + 1)} disabled={busy}><RefreshCw size={16} aria-hidden /></button>
    </CryptoToolbarActions>
    <CryptoHelp>Privados para tu usuario y cuenta. Se protegen cifrados en el servidor y se abren con tu sesión de Clarin.</CryptoHelp>
    {configured === false && <p role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">La protección de claves aún no está configurada en el servidor. Las demás herramientas siguen disponibles.</p>}
    <div className="grid items-start gap-2" style={{ gridTemplateColumns: wide ? '224px minmax(0,1fr)' : 'minmax(0,1fr)' }}>
      <aside className={`${wide ? 'sticky top-2' : ''} utility-panel space-y-1`}><label className="relative block"><span className="sr-only">Buscar claves por nombre o huella</span><Search aria-hidden className="absolute left-2 top-1/2 size-4 -translate-y-1/2 text-slate-400" /><input className={`${field} pl-8`} maxLength={128} value={query} onChange={event => { setQuery(event.target.value); if (!event.target.value) settleQuery('') }} placeholder="Nombre o huella…" /></label>
        {(loading || query !== settled) && <p role="status" className="text-xs text-slate-500">Buscando…</p>}
        <ul className="max-h-80 space-y-0.5 overflow-y-auto">{items.map(item => <li key={item.id}><button type="button" disabled={busy} aria-pressed={selectedId === item.id} onClick={() => setSelectedId(item.id)} className={`w-full rounded-lg px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 ${selectedId === item.id ? 'bg-emerald-50 text-emerald-900' : 'hover:bg-slate-50'}`}><span className="block truncate text-xs font-medium">{item.name}</span><span className="block text-[11px] text-slate-500">{item.algorithm} {item.bits || ''}</span></button></li>)}</ul>
        {!items.length && !loading && <p className="py-4 text-sm text-slate-500">Todavía no hay entradas que mostrar.</p>}{next && <button className={button} type="button" disabled={busy} onClick={() => void more()}>Mostrar más</button>}
      </aside>
      <div className="min-w-0 space-y-2">
        <section hidden={creation === null} aria-label={creation === 'import' ? 'Importar clave' : 'Crear clave'} className="utility-panel space-y-2">
          <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">{creation === 'import' ? 'Importar clave o certificado' : 'Nueva clave'}</h3><button type="button" className={button} aria-label="Cerrar opciones de creación" disabled={busy} onClick={() => setCreation(null)}><X size={16} aria-hidden /></button></div>
          <div className={fields}><label className="text-xs">Nombre<input className={`${field} mt-1`} maxLength={160} value={name} onChange={event => setName(event.target.value)} placeholder="Ej. Integración de pruebas" /></label><label className="text-xs">Descripción<input className={`${field} mt-1`} maxLength={1000} value={description} onChange={event => setDescription(event.target.value)} /></label></div>
          <div hidden={creation !== 'generate'}><div className={fields}><label className="text-xs">Tipo de clave<select className={`${field} mt-1`} value={kind} onChange={event => { const value = event.target.value as typeof kind; setKind(value); setSize(value === 'aes' ? '256' : value === 'ec' ? 'P-256' : '3072') }}><option value="rsa">RSA</option><option value="aes">AES-GCM</option><option value="ec">ECDSA</option></select></label><label className="text-xs">Tamaño o curva<select className={`${field} mt-1`} value={size} onChange={event => setSize(event.target.value)}>{(kind === 'aes' ? ['128', '256'] : kind === 'ec' ? ['P-256', 'P-384'] : ['2048', '3072', '4096']).map(value => <option key={value}>{value}</option>)}</select></label></div></div>
          <div hidden={creation !== 'import'}><label className="block text-xs">Contraseña de importación<input type="password" autoComplete="new-password" className={`${field} mt-1`} maxLength={1024} value={password} onChange={event => setPassword(event.target.value)} /><span className="text-[11px] text-slate-500">Temporal; no se guarda en la hoja.</span></label></div>
          <div className="flex flex-wrap gap-1">{creation === 'generate' ? <button type="button" className={primary} disabled={busy || !configured} onClick={() => void act(async current => { const value = await job.run<VaultCandidate>({ task: 'generate', kind, size: kind === 'ec' ? size : Number(size) }); await store(value, current) })}><KeyRound aria-hidden size={16} />Generar y guardar</button> : <button type="button" className={primary} disabled={busy || !configured} onClick={() => input.current?.click()}><Upload aria-hidden size={16} />Importar archivo</button>}</div>
          <input ref={input} type="file" hidden accept=".p12,.pfx,.pem,.der,.cer,.crt,.jwk,.jwe,.json" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; void act(async current => { if (file.size > 1024 * 1024) throw new CryptoInputError('El archivo supera 1 MiB.'); const data = await file.arrayBuffer(); if (!current()) return; const value = await job.run<VaultCandidate>({ task: 'import', data, filename: file.name, password }); await store(value, current) }) }} />
          <p className="text-xs text-slate-500">P12/PFX, PEM/DER, JWK y X.509. Máximo 1 MiB por archivo.</p>
        </section>
        {selected && <section aria-label="Entrada seleccionada" className="utility-panel space-y-2">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-1"><h3 className="min-w-0 break-words text-sm font-semibold">{selected.name}</h3><div className="flex items-center gap-1">{(selected.kind === 'rsa' || selected.kind === 'aes') && <button type="button" className={primary} disabled={busy || !configured} onClick={() => onUse(selected)}>Usar esta clave</button>}<button className={`${button} text-rose-700`} disabled={busy} onClick={() => setDeleting(true)} type="button" aria-label="Eliminar" title="Eliminar clave"><Trash2 aria-hidden size={16} /></button></div></div>
          <dl className="space-y-1 text-xs"><div><dt className="font-semibold text-slate-600">Algoritmo</dt><dd>{selected.algorithm} {selected.bits || ''}</dd></div>{Boolean(selected.metadata.fingerprint) && <div><dt className="font-semibold text-slate-600">Huella</dt><dd className="break-all font-mono text-[11px]">{String(selected.metadata.fingerprint)}</dd></div>}</dl>
          <VaultDisclosure title="Detalles del certificado" {...section('certificate')}><dl className={`${fields} text-xs`}>{Object.entries({ Titular: selected.metadata.subject, Emisor: selected.metadata.issuer, 'Válido desde': selected.metadata.not_before, 'Válido hasta': selected.metadata.not_after, SAN: Array.isArray(selected.metadata.san) ? selected.metadata.san.join(', ') : undefined }).filter(([, value]) => value).map(([label, value]) => <div key={label} className="min-w-0"><dt className="font-semibold text-slate-600">{label}</dt><dd className="break-all text-slate-800">{String(value)}</dd></div>)}</dl>{Boolean(selected.metadata.not_after) && <p className="text-xs text-slate-500">La vigencia describe fechas; no confirma la confianza de una autoridad certificadora ni su revocación.</p>}</VaultDisclosure>
          <VaultDisclosure title="Renombrar" {...section('rename')}><div className={fields}><label className="text-xs">Nombre de entrada<input className={`${field} mt-1`} value={rename} maxLength={160} onChange={event => setRename(event.target.value)} /></label><label className="text-xs">Descripción de entrada<input className={`${field} mt-1`} value={renameDescription} maxLength={1000} onChange={event => setRenameDescription(event.target.value)} /></label></div>
          <button type="button" className={button} disabled={busy || !rename.trim()} onClick={() => void act(async current => { await libraryRequest(`/vault/${selected.id}`, jsonRequest('PATCH', { version: selected.version, name: rename.trim(), description: renameDescription, operation_id: operationId() })); if (current()) { setRefresh(value => value + 1); setNotice('Entrada actualizada.') } })}>Guardar nombre</button></VaultDisclosure>
          <input type="file" hidden ref={certificateInput} accept=".pem,.cer,.crt,.der" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void act(current => attachCertificate(file, current)) }} />
          <VaultDisclosure title="Exportar" {...section('export')}><label className="block text-xs">Formato de exportación<select className={`${field} mt-1`} value={exportFormat} onChange={event => setExportFormat(event.target.value as typeof exportFormat)}>{(selected.kind === 'rsa' || selected.kind === 'ec') && <><option value="pem">Privada PKCS#8 protegida</option><option value="p12">P12/PFX protegido</option><option value="csr">Solicitudes CSR guardadas</option></>}{selected.kind !== 'certificate' && <><option value="jwk-protected">JWK protegido con contraseña (JWE)</option><option value="jwk">JWK sin contraseña</option></>}{selected.kind !== 'aes' && <><option value="public">Pública PEM</option><option value="certificate">Certificados PEM</option><option value="certificate-der">Certificado DER</option></>}</select></label>
          <label className="block text-xs">Contraseña de exportación<input type="password" autoComplete="new-password" className={`${field} mt-1`} maxLength={1024} value={password} onChange={event => setPassword(event.target.value)} /><span className="text-[11px] text-slate-500">Temporal; no se guarda en la hoja.</span></label>
          <button type="button" className={button} aria-label="Exportar archivo" disabled={busy || !configured} onClick={() => void act(async current => { const value = await material(selected); if (!current()) return; const result = await job.run<{ data: string | Uint8Array; filename: string }>({ task: 'export', material: value, format: exportFormat, password }); if (current()) { download(result.data, result.filename); setPassword(''); setNotice('Archivo preparado para descargar.') } })}><Download aria-hidden size={16} />Exportar</button>
          {exportFormat === 'jwk' && <p className="text-xs text-amber-800">El archivo JWK privado o simétrico contiene el secreto sin contraseña.</p>}
          </VaultDisclosure>
          {(selected.kind === 'rsa' || selected.kind === 'ec') && <><VaultDisclosure title="Certificados y CSR" {...section('csr')}><div className={fields}><label className="text-xs">Nombre común (CN)<input className={`${field} mt-1`} value={commonName} disabled={busy} maxLength={255} onChange={event => { setCommonName(event.target.value); setOutput('') }} /></label><label className="text-xs">Nombres DNS (SAN)<input className={`${field} mt-1`} value={dns} disabled={busy} maxLength={25000} onChange={event => { setDns(event.target.value); setOutput('') }} placeholder="api.ejemplo.com, ejemplo.com" /></label></div><div className="flex flex-wrap gap-1"><button type="button" className={button} disabled={busy || !configured || !commonName.trim()} onClick={() => void act(current => attachDerived(false, current))}>Crear y guardar CSR</button><button type="button" className={button} disabled={busy || !configured || !commonName.trim()} onClick={() => void act(current => attachDerived(true, current))}>Certificado de prueba</button><button type="button" className={button} disabled={busy || !configured} onClick={() => certificateInput.current?.click()}>Asociar certificado</button></div></VaultDisclosure>
            <VaultDisclosure title="JWT" {...section('jwt')}>
            <label className="block text-sm">Contenido JWT / token<textarea className={`${field} mt-1 min-h-28 resize-y py-2 font-mono`} value={jwt} disabled={busy} onChange={event => { setJwt(event.target.value); setOutput('') }} maxLength={1_400_000} spellCheck={false} /></label><div className="flex flex-wrap gap-1">{(['sign', 'verify'] as const).map(task => <button type="button" className={button} key={task} disabled={busy || !configured || !jwt.trim()} onClick={() => void act(async current => { const value = await material(selected); if (!current()) return; const result = await job.run<string>({ task, material: value, source: jwt }); if (current()) setOutput(result) })}>{task === 'sign' ? 'Firmar JWT' : 'Verificar firma JWT'}</button>)}</div></VaultDisclosure></>}
          {output && <div className="space-y-2"><label className="block text-sm">Resultado<textarea readOnly className={`${field} mt-1 min-h-32 resize-y py-2 font-mono`} value={output} /></label><button type="button" className={button} onClick={() => download(output, output.startsWith('-----BEGIN') ? 'solicitud-o-certificado.pem' : 'resultado.txt')}>Descargar resultado</button></div>}
        </section>}
        {!selected && creation === null && <div className="utility-panel text-sm text-slate-500">Selecciona una entrada para trabajar con ella, o utiliza Nueva clave e Importar.</div>}
      </div>
    </div>
    {busy && <div role="status" className="flex items-center gap-2 text-sm text-slate-600"><Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />Procesando…{job.busy && <button className={button} type="button" onClick={() => { job.cancel(); setPending(false) }}>Cancelar</button>}</div>}
    {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}{notice && <p role="status" className="text-sm text-emerald-800">{notice}</p>}
    {deleting && selected && <EditorConfirmDialog title="Eliminar clave o certificado" onCancel={() => { if (!busy) setDeleting(false) }} actions={<><button className={button} disabled={busy} onClick={() => setDeleting(false)} type="button">Cancelar</button><button className={`${button} text-rose-700`} disabled={busy} type="button" onClick={() => void act(async current => { await libraryRequest(`/vault/${selected.id}?version=${selected.version}`, { method: 'DELETE' }); if (current()) { onDeleted?.(selected.id); setDeleting(false); setSelectedId(''); setSelected(null); setRefresh(value => value + 1); setNotice('Entrada eliminada. La limpieza física se procesará automáticamente.') } })}>Eliminar definitivamente</button></>}><p>Se eliminará <strong>{selected.name}</strong> de Clarin. Las copias exportadas seguirán existiendo y el certificado no se revocará.</p></EditorConfirmDialog>}
  </section>
}
