import { ClipboardCopy, ImagePlus, Loader2, Upload, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode, type Ref } from 'react'
import { IMAGE_TYPES, type LocalImage } from './localImages'
import { useLocalJob, type JobState } from './useLocalJob'

export const primaryButton = 'utility-control inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500'
export const secondaryButton = 'utility-control inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50'
export const iconButton = secondaryButton
export const imagePanel = 'utility-panel min-w-0 space-y-2'
export const imageGrid = 'utility-pair'
export const textField = 'block w-full min-w-0 resize-y rounded-lg border border-slate-200 bg-slate-50 p-2 font-mono text-sm text-slate-800 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20'

export function ImagePanelHeader({ title, htmlFor, children }: { title: string; htmlFor?: string; children?: ReactNode }) {
  return <div className="flex min-w-0 flex-wrap items-center justify-between gap-1">
    <h2 className="min-w-0 text-sm font-semibold text-slate-800">{htmlFor ? <label htmlFor={htmlFor}>{title}</label> : title}</h2>
    {children && <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1">{children}</div>}
  </div>
}

export function ImageModePicker<T extends string>({ label, mode, options, onChange, inputRef }: {
  label: string
  mode: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
  inputRef?: Ref<HTMLSelectElement>
}) {
  return (
    <select ref={inputRef} aria-label={label} value={mode} onChange={event => onChange(event.target.value as T)} className="utility-field min-w-0 max-w-full rounded-lg border border-slate-200 bg-white px-2 text-sm font-medium text-slate-700 outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  )
}

export function InlineStatus({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <p role={error ? 'alert' : 'status'} className={`min-w-0 break-words text-sm ${error ? 'text-rose-700' : 'text-slate-600'}`}>{children}</p>
}

export function ImagePreview({ image }: { image: LocalImage }) {
  const [preview, setPreview] = useState<{ image: LocalImage; url: string } | null>(null)
  useEffect(() => {
    const url = URL.createObjectURL(image.blob)
    setPreview({ image, url })
    return () => URL.revokeObjectURL(url)
  }, [image])
  return (
    <figure className="min-w-0 space-y-2">
      {preview?.image === image && <img src={preview.url} alt="Vista previa de la imagen" className="mx-auto max-h-52 max-w-full rounded-lg object-contain" />}
      <figcaption className="text-center text-xs text-slate-600">
        <span className="block break-all font-medium">{image.name}</span>
        {image.width} × {image.height} px · {new Intl.NumberFormat('es').format(image.blob.size)} bytes
      </figcaption>
    </figure>
  )
}

export function ImageInput({ source, onSelect, onClear, label = 'Imagen' }: {
  source: JobState<LocalImage>
  onSelect: (file: File) => void
  onClear: () => void
  label?: string
}) {
  const helpId = useId()
  const fileInput = useRef<HTMLInputElement>(null)
  const pasteArea = useRef<HTMLDivElement>(null)
  const clipboardRequest = useRef(0)
  const [clipboard, setClipboard] = useState<{ busy: boolean; error?: string }>({ busy: false })
  const [dragging, setDragging] = useState(false)

  useEffect(() => () => { clipboardRequest.current += 1 }, [])

  function select(file: File) {
    clipboardRequest.current += 1
    setClipboard({ busy: false })
    onSelect(file)
  }

  async function pasteImage() {
    const request = ++clipboardRequest.current
    setClipboard({ busy: true })
    try {
      const items = await navigator.clipboard.read()
      if (request !== clipboardRequest.current) return
      for (const item of items) {
        const type = IMAGE_TYPES.find(candidate => item.types.includes(candidate))
        if (!type) continue
        const blob = await item.getType(type)
        if (request === clipboardRequest.current) select(new File([blob], '', { type }))
        return
      }
      setClipboard({ busy: false, error: 'El portapapeles no contiene una imagen PNG, JPG o WebP.' })
    } catch {
      if (request !== clipboardRequest.current) return
      pasteArea.current?.focus()
      setClipboard({ busy: false, error: 'El navegador no dio acceso al portapapeles. Usa el comando Pegar en el área de imagen o selecciona un archivo.' })
    }
  }

  return (
    <div className="space-y-2">
      <ImagePanelHeader title={label}>
        <button type="button" className={iconButton} aria-label={source.status === 'ready' ? 'Cambiar imagen' : 'Seleccionar archivo'} title={source.status === 'ready' ? 'Cambiar imagen' : 'Seleccionar archivo'} onClick={() => fileInput.current?.click()}><Upload aria-hidden="true" className="h-4 w-4" /></button>
        <button type="button" className={iconButton} aria-label={clipboard.busy ? 'Leyendo portapapeles…' : 'Pegar imagen'} title="Pegar imagen" disabled={clipboard.busy} onClick={() => void pasteImage()}><ClipboardCopy aria-hidden="true" className="h-4 w-4" /></button>
        {(source.status !== 'idle' || clipboard.busy) && <button type="button" className={iconButton} aria-label={source.status === 'pending' || clipboard.busy ? 'Cancelar' : 'Quitar imagen'} title={source.status === 'pending' || clipboard.busy ? 'Cancelar' : 'Quitar imagen'} onClick={() => {
          clipboardRequest.current += 1
          setClipboard({ busy: false })
          if (!clipboard.busy) onClear()
          pasteArea.current?.focus()
        }}><X aria-hidden="true" className="h-4 w-4" /></button>}
      </ImagePanelHeader>
      <div
        ref={pasteArea}
        role="group"
        aria-label="Área para pegar o soltar una imagen"
        aria-describedby={helpId}
        tabIndex={0}
        onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true) } }}
        onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false) }}
        onDrop={event => {
          event.preventDefault()
          setDragging(false)
          const file = event.dataTransfer.files.item(0)
          if (file) select(file)
        }}
        onPaste={event => {
          const item = Array.from(event.clipboardData.items).find(candidate => candidate.kind === 'file')
          const file = item?.getAsFile() ?? event.clipboardData.files.item(0)
          if (!file) return
          event.preventDefault()
          select(file)
        }}
        className={`flex min-h-28 min-w-0 flex-col items-center justify-center rounded-lg border border-dashed p-2 outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${dragging ? 'border-emerald-500 bg-emerald-50' : 'border-slate-300 bg-slate-50'}`}
      >
        {source.status === 'ready' ? <ImagePreview image={source.value} /> : (
          <div className="text-center">
            {source.status === 'pending' ? <Loader2 aria-hidden="true" className="mx-auto mb-1 h-5 w-5 motion-safe:animate-spin text-emerald-600" /> : <ImagePlus aria-hidden="true" className="mx-auto mb-1 h-5 w-5 text-slate-400" />}
            <p className="text-sm font-medium text-slate-700">{source.status === 'pending' ? 'Abriendo imagen…' : 'Arrastra o pega una imagen aquí'}</p>
          </div>
        )}
        <p id={helpId} className="mt-1 text-center text-xs text-slate-600">PNG, JPG o WebP · 10 MiB · 16 megapíxeles</p>
      </div>
      <input ref={fileInput} type="file" accept={IMAGE_TYPES.join(',')} hidden onChange={event => {
        const file = event.currentTarget.files?.item(0)
        event.currentTarget.value = ''
        if (file) select(file)
      }} />
      {clipboard.error && <InlineStatus error>{clipboard.error}</InlineStatus>}
      {source.status === 'error' && <InlineStatus error>{source.error}</InlineStatus>}
    </div>
  )
}

export function downloadLocalFile(data: Blob, filename: string) {
  const url = URL.createObjectURL(data)
  downloadLocalUrl(url, filename)
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function downloadLocalUrl(url: string, filename: string) {
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
}

export function CopyImageResult({ value, fallback }: { value: string; fallback: string }) {
  const copy = useLocalJob<void>()
  return (
    <>
      <button type="button" className={iconButton} aria-label="Copiar" title="Copiar resultado" disabled={copy.state.status === 'pending'} onClick={() => void copy.run(async () => {
        try {
          await navigator.clipboard.writeText(value)
        } catch {
          throw new Error(fallback)
        }
      })}><ClipboardCopy aria-hidden="true" className="h-4 w-4" /></button>
      {copy.state.status === 'ready' && <InlineStatus>Copiado.</InlineStatus>}
      {copy.state.status === 'error' && <InlineStatus error>{copy.state.error}</InlineStatus>}
    </>
  )
}
