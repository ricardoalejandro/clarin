import { ClipboardCopy, ImagePlus, Loader2, Upload, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { IMAGE_TYPES, type LocalImage } from './localImages'
import { useLocalJob, type JobState } from './useLocalJob'

export const primaryButton = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500'
export const secondaryButton = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50'
export const imagePanel = 'min-w-0 rounded-2xl border border-slate-200 bg-white p-4 sm:p-5'
export const imageGrid = 'grid min-w-0 gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,23rem),1fr))]'
export const textField = 'block w-full min-w-0 resize-y rounded-xl border border-slate-200 bg-slate-50 p-3 font-mono text-sm text-slate-800 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20'

export function ImageModePicker<T extends string>({ label, mode, options, onChange }: {
  label: string
  mode: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  const name = useId()
  return (
    <fieldset className="flex min-w-0 flex-wrap gap-1 self-start rounded-xl border border-slate-200 bg-slate-100 p-1">
      <legend className="sr-only">{label}</legend>
      {options.map(option => (
        <label key={option.value} className="relative cursor-pointer">
          <input type="radio" name={name} checked={option.value === mode} onChange={() => onChange(option.value)} className="peer sr-only" />
          <span className="flex min-h-11 items-center rounded-lg px-3 text-sm font-semibold text-slate-600 peer-checked:bg-white peer-checked:text-emerald-800 peer-checked:shadow-sm peer-focus-visible:ring-2 peer-focus-visible:ring-emerald-500">{option.label}</span>
        </label>
      ))}
    </fieldset>
  )
}

export function InlineStatus({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <p role={error ? 'alert' : 'status'} className={`text-sm ${error ? 'text-rose-700' : 'text-slate-600'}`}>{children}</p>
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

export function ImageInput({ source, onSelect, onClear }: {
  source: JobState<LocalImage>
  onSelect: (file: File) => void
  onClear: () => void
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
    <div className="space-y-3">
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
        className={`flex min-h-40 min-w-0 flex-col items-center justify-center rounded-xl border border-dashed p-4 outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${dragging ? 'border-emerald-500 bg-emerald-50' : 'border-slate-300 bg-slate-50'}`}
      >
        {source.status === 'ready' ? <ImagePreview image={source.value} /> : (
          <div className="text-center">
            {source.status === 'pending' ? <Loader2 aria-hidden="true" className="mx-auto mb-2 h-6 w-6 motion-safe:animate-spin text-emerald-600" /> : <ImagePlus aria-hidden="true" className="mx-auto mb-2 h-6 w-6 text-slate-400" />}
            <p className="text-sm font-medium text-slate-700">{source.status === 'pending' ? 'Abriendo imagen…' : 'Arrastra o pega una imagen aquí'}</p>
          </div>
        )}
        <p id={helpId} className="mt-2 text-center text-xs text-slate-600">PNG, JPG o WebP · Hasta 10 MiB y 16 megapíxeles</p>
      </div>
      <input ref={fileInput} type="file" accept={IMAGE_TYPES.join(',')} hidden onChange={event => {
        const file = event.currentTarget.files?.item(0)
        event.currentTarget.value = ''
        if (file) select(file)
      }} />
      <div className="flex flex-wrap gap-2">
        <button type="button" className={secondaryButton} onClick={() => fileInput.current?.click()}><Upload aria-hidden="true" className="h-4 w-4" />{source.status === 'ready' ? 'Cambiar imagen' : 'Seleccionar archivo'}</button>
        <button type="button" className={secondaryButton} disabled={clipboard.busy} onClick={() => void pasteImage()}><ClipboardCopy aria-hidden="true" className="h-4 w-4" />{clipboard.busy ? 'Leyendo portapapeles…' : 'Pegar imagen'}</button>
        {(source.status !== 'idle' || clipboard.busy) && (
          <button type="button" className={secondaryButton} onClick={() => {
            clipboardRequest.current += 1
            setClipboard({ busy: false })
            if (!clipboard.busy) onClear()
            pasteArea.current?.focus()
          }}><X aria-hidden="true" className="h-4 w-4" />{source.status === 'pending' || clipboard.busy ? 'Cancelar' : 'Quitar imagen'}</button>
        )}
      </div>
      {clipboard.error && <InlineStatus error>{clipboard.error}</InlineStatus>}
      {source.status === 'error' && <InlineStatus error>{source.error}</InlineStatus>}
    </div>
  )
}

export function downloadLocalFile(data: Blob, filename: string) {
  const url = URL.createObjectURL(data)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function CopyImageResult({ value, fallback }: { value: string; fallback: string }) {
  const copy = useLocalJob<void>()
  return (
    <>
      <button type="button" className={secondaryButton} disabled={copy.state.status === 'pending'} onClick={() => void copy.run(async () => {
        try {
          await navigator.clipboard.writeText(value)
        } catch {
          throw new Error(fallback)
        }
      })}><ClipboardCopy aria-hidden="true" className="h-4 w-4" />Copiar</button>
      {copy.state.status === 'ready' && <InlineStatus>Copiado.</InlineStatus>}
      {copy.state.status === 'error' && <InlineStatus error>{copy.state.error}</InlineStatus>}
    </>
  )
}
