 'use client'
import { useEffect, useRef, useState } from 'react'
import type { Canvas } from 'fabric'
import { Download, Loader2 } from 'lucide-react'
import { StorageDialog as DocumentDialog } from '@/components/storage/StorageDialog'
import { DOCUMENT_EXPORT_PROFILES, documentExportGeometry, downloadBlob, type ExportOptions } from '@/lib/fabric/export'
import { safeDocumentFilename } from '@/lib/documents/documentLibrary'
import { readExportPreference, saveExportPreference, type ExportProfile } from '@/lib/documents/exportPreferences'
import { getAuthScope } from '@/lib/authScope'
import { api } from '@/lib/api'
type Props = { canvas: Canvas; templateName: string; onClose: () => void; pageWidth?: number; pageHeight?: number }
export default function DocumentExportDialog(props: Props) {
  const [preferenceIdentity, setPreferenceIdentity] = useState('')
  useEffect(() => {
    const controller = new AbortController(), scope = getAuthScope()
    const timer = window.setTimeout(() => { if (getAuthScope() === scope) setPreferenceIdentity(scope); controller.abort() }, 1500)
    void api<{user:{id:string;account_id:string}}>('/api/me', {signal:controller.signal}).then(result => {
      if (controller.signal.aborted || getAuthScope() !== scope) return
      window.clearTimeout(timer)
      const user = result.data?.user
      // On an unavailable identity request, export still works with isolated,
      // temporary preferences; never reuse another actor's saved settings.
      setPreferenceIdentity(user?.id && user.account_id ? `${user.account_id}:${user.id}` : scope)
    })
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [])
  if (!preferenceIdentity) return <DocumentDialog title="Exportar documento" onClose={props.onClose}><p role="status" className="py-10 text-center text-sm text-slate-500">Preparando exportación…</p></DocumentDialog>
  return <DocumentExportSession {...props} preferenceIdentity={preferenceIdentity} />
}
function DocumentExportSession({ canvas, templateName, onClose, pageWidth, pageHeight, preferenceIdentity }: Props & {preferenceIdentity:string}) {
  const [format, setFormat] = useState<ExportOptions['format']>('pdf')
  const identity = useRef(preferenceIdentity)
  const initial = useRef(readExportPreference(identity.current, 'pdf'))
  const [profile, setProfile] = useState<ExportProfile>(initial.current.profile)
  const [customDpi, setCustomDpi] = useState(initial.current.dpi)
  const [customQuality, setCustomQuality] = useState(initial.current.quality)
  const [dpiInput,setDpiInput] = useState(String(initial.current.dpi))
  const [qualityInput,setQualityInput] = useState(String(Math.round(initial.current.quality*100)))
  const [scope, setScope] = useState<'page' | 'selection'>('page')
  const [transparent, setTransparent] = useState(initial.current.transparent)
  const [blob, setBlob] = useState<Blob | null>(null)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [readyConfiguration,setReadyConfiguration] = useState('')
  const configuration = JSON.stringify({format,profile,customDpi,customQuality,scope,transparent,retry})
  const [geometry, setGeometry] = useState<ReturnType<typeof documentExportGeometry> | null>(null)
  const first = useRef<HTMLButtonElement>(null)
  const renderQueue = useRef<Promise<void>>(Promise.resolve())
  const selected = canvas.getActiveObjects().filter(o => !(o as unknown as Record<string, unknown>).__isPage).length
  useEffect(() => {
    const controller = new AbortController(); const identity = getAuthScope(); let resource = ''; let timedOut = false
    setBusy(true); setBlob(null); setUrl(''); setError(''); setGeometry(null)
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); setBusy(false); setError('La exportación tardó demasiado. Reintenta con el perfil Ligero.') }, 30000)
    const resolution = profile === 'custom' ? { dpi: customDpi, quality: customQuality } : DOCUMENT_EXPORT_PROFILES[profile]
    saveExportPreference(preferenceIdentity, format, { profile, ...resolution, transparent })
    const options: ExportOptions = { format, ...resolution, scope, transparent: format === 'png' && transparent, signal: controller.signal }
    const job = renderQueue.current.catch(() => {}).then(async () => {
      if (controller.signal.aborted || getAuthScope() !== identity) return
      try {
        const { createDocumentRenderSnapshot } = await import('@/lib/fabric/editorSnapshot')
        const snapshot = await createDocumentRenderSnapshot(canvas, scope, options.transparent)
        const { renderDocumentSnapshotWithPreview } = await import('@/lib/fabric/export')
        const result = await renderDocumentSnapshotWithPreview(snapshot, options)
        if (controller.signal.aborted || getAuthScope() !== identity) return
        resource = URL.createObjectURL(result.preview); setUrl(resource); setBlob(result.blob); setGeometry(documentExportGeometry(snapshot.width, snapshot.height, options)); setReadyConfiguration(configuration)
      } catch (reason) { if (!controller.signal.aborted && getAuthScope() === identity) setError(reason instanceof Error ? reason.message : 'No se pudo exportar. Vuelve a intentarlo.') }
      finally { window.clearTimeout(timeout); if (!controller.signal.aborted && !timedOut) setBusy(false) }
    })
    renderQueue.current = job
    void job
    return () => { controller.abort(); window.clearTimeout(timeout); if (resource) URL.revokeObjectURL(resource) }
  }, [canvas, format, profile, customDpi, customQuality, scope, transparent, retry])
  const changeFormat = (value: ExportOptions['format']) => { const saved = readExportPreference(identity.current, value); setFormat(value); setProfile(saved.profile); setCustomDpi(saved.dpi); setCustomQuality(saved.quality); setDpiInput(String(saved.dpi)); setQualityInput(String(Math.round(saved.quality*100))); setTransparent(saved.transparent) }
  const customPending = profile === 'custom' && (dpiInput !== String(customDpi) || qualityInput !== String(Math.round(customQuality * 100)))
  const choice = (active: boolean) => `min-h-11 rounded-xl border px-3 py-2 text-sm font-medium ${active ? 'border-emerald-500 bg-emerald-50 text-emerald-800' : 'border-slate-200 text-slate-600 hover:bg-slate-50'} disabled:opacity-40`
  return <DocumentDialog title="Exportar documento" description={templateName} onClose={onClose} wide initialFocusRef={first} footer={<><span className="mr-auto text-sm text-slate-500" aria-live="polite">{blob ? `${(blob.size / 1024).toLocaleString('es-PE', { maximumFractionDigits: 1 })} KiB · tamaño exacto` : 'Preparando archivo'}</span><button onClick={onClose} className="min-h-11 rounded-xl border border-slate-200 px-4 text-sm">Cerrar</button><button disabled={!blob || busy || customPending || readyConfiguration !== configuration} onClick={() => { if (blob && !busy && !customPending && readyConfiguration === configuration) downloadBlob(blob, `${safeDocumentFilename(templateName)}.${format === 'jpeg' ? 'jpg' : format}`) }} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-medium text-white disabled:opacity-40"><Download className="h-4 w-4" />Descargar</button></>}>
    <div className="grid min-w-0 gap-5 sm:grid-cols-[220px_minmax(0,1fr)]">
      <div className="space-y-5">
        <fieldset><legend className="mb-2 text-sm font-semibold text-slate-900">Formato</legend><div className="flex flex-wrap gap-2">{(['pdf', 'png', 'jpeg'] as const).map((item, index) => <button ref={index === 0 ? first : undefined} key={item} className={choice(format === item)} onClick={() => changeFormat(item)} aria-pressed={format === item}>{item.toUpperCase()}</button>)}</div></fieldset>
        <fieldset><legend className="mb-2 text-sm font-semibold text-slate-900">Calidad</legend><div className="space-y-2">{Object.entries(DOCUMENT_EXPORT_PROFILES).map(([key, value]) => <button key={key} className={`${choice(profile === key)} flex w-full items-center justify-between gap-2`} aria-pressed={profile === key} onClick={() => setProfile(key as typeof profile)}><span>{value.label}</span><span className="text-xs">{value.dpi} ppp</span></button>)}<button className={`${choice(profile === 'custom')} w-full`} aria-pressed={profile === 'custom'} onClick={() => setProfile('custom')}>Personalizado</button></div></fieldset>
        {profile === 'custom' && <div className="grid grid-cols-2 gap-2"><label className="text-xs text-slate-600">Resolución (ppp)<input aria-label="Resolución personalizada" type="number" min={72} max={600} value={dpiInput} onChange={e => setDpiInput(e.target.value)} onBlur={() => { const value=Math.min(600,Math.max(72,Number(dpiInput)||300));setDpiInput(String(value));setCustomDpi(value) }} onKeyDown={e => {if(e.key==='Enter')e.currentTarget.blur()}} className="mt-1 min-h-11 w-full rounded-xl border border-slate-200 px-2" /></label><label className="text-xs text-slate-600">Calidad (%)<input aria-label="Calidad personalizada" type="number" min={10} max={100} disabled={format === 'png' || (format === 'pdf' && customDpi >= 300)} value={qualityInput} onChange={e => setQualityInput(e.target.value)} onBlur={() => {const value=Math.min(100,Math.max(10,Number(qualityInput)||95));setQualityInput(String(value));setCustomQuality(value/100)}} onKeyDown={e => {if(e.key==='Enter')e.currentTarget.blur()}} className="mt-1 min-h-11 w-full rounded-xl border border-slate-200 px-2 disabled:opacity-40" /></label></div>}
        {format === 'pdf' && (profile === 'print' || (profile === 'custom' && customDpi >= 300)) && <p className="text-xs text-emerald-700">PDF con imagen sin pérdida para impresión.</p>}
        <fieldset><legend className="mb-2 text-sm font-semibold text-slate-900">Contenido</legend><div className="flex flex-wrap gap-2"><button className={choice(scope === 'page')} aria-pressed={scope === 'page'} onClick={() => setScope('page')}>Página completa</button><button className={choice(scope === 'selection')} aria-pressed={scope === 'selection'} disabled={!selected} onClick={() => setScope('selection')}>Selección ({selected})</button></div></fieldset>
        {format === 'png' && <label className="flex min-h-11 items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={transparent} onChange={e => setTransparent(e.target.checked)} />Fondo transparente</label>}
        <p className="text-xs leading-5 text-slate-500">{geometry ? `${geometry.width} × ${geometry.height} px · ${Math.round(geometry.effectiveDpi)} ppp${geometry.clamped ? ' · Ajustado al límite de 32 MP.' : ''}` : pageWidth && pageHeight ? `${pageWidth} × ${pageHeight} mm` : 'Vista previa del archivo final.'}</p>
      </div>
      <div className="flex min-h-72 min-w-0 items-center justify-center overflow-hidden rounded-2xl border border-slate-200 bg-slate-100 p-3">
        {busy ? <p role="status" className="text-center text-sm text-slate-600"><Loader2 className="mx-auto mb-3 h-6 w-6 animate-spin motion-reduce:animate-none" />Generando vista previa…</p> : error ? <div role="alert" className="p-4 text-sm text-rose-700"><p>{error}</p><button onClick={() => setRetry(v => v + 1)} className="mt-3 min-h-11 rounded-xl border border-rose-200 px-4">Reintentar</button></div> : url ? <img src={url} alt="Vista previa del archivo exportado" className="max-h-[48dvh] max-w-full object-contain" /> : null}
      </div>
    </div>
  </DocumentDialog>
}
