'use client'

import { Download, QrCode, ScanLine, X } from 'lucide-react'
import { useState } from 'react'
import { CopyImageResult, ImageInput, ImageModePicker, InlineStatus, downloadLocalFile, imageGrid, imagePanel, primaryButton, secondaryButton, textField } from './ImageControls'
import { validateLocalImage, type LocalImage } from './localImages'
import { readLocalQr } from './qrReader'
import { useLocalJob } from './useLocalJob'

const modes = [{ value: 'create', label: 'Generar QR' }, { value: 'read', label: 'Leer QR' }] as const
type QrMode = typeof modes[number]['value']
type GeneratedQr = { svg: string; png: string }

async function generateQr(text: string, signal: AbortSignal): Promise<GeneratedQr> {
  if (text.length > 7089) throw new Error('El contenido supera la capacidad de un código QR. Acorta el texto.')
  const { default: qr } = await import('qrcode')
  signal.throwIfAborted()
  const options = { errorCorrectionLevel: 'M', margin: 4, scale: 8 } as const
  try {
    const [png, svg] = await Promise.all([
      qr.toDataURL(text, options),
      qr.toString(text, { ...options, type: 'svg' }),
    ])
    return { png, svg }
  } catch (error) {
    if (error instanceof Error && /amount of data is too big/i.test(error.message)) {
      throw new Error('El contenido supera la capacidad de un código QR. Acorta el texto.')
    }
    throw new Error('No pudimos generar el código QR. Vuelve a intentarlo.')
  }
}

function GenerateQr() {
  const [text, setText] = useState('')
  const result = useLocalJob<GeneratedQr>()

  return (
    <div className={imageGrid}>
      <section className={`${imagePanel} space-y-3`}>
        <label htmlFor="qr-text" className="block text-sm font-semibold text-slate-800">Texto o enlace</label>
        <textarea id="qr-text" className={`${textField} min-h-36`} placeholder="Escribe o pega el contenido del QR" value={text} autoComplete="off" spellCheck={false} onChange={event => {
          result.clear()
          setText(event.target.value)
        }} />
        <div className="flex flex-wrap gap-2">
          <button type="button" className={primaryButton} disabled={!text || result.state.status === 'pending'} onClick={() => void result.run(signal => generateQr(text, signal))}>
            <QrCode aria-hidden="true" className="h-4 w-4" />{result.state.status === 'pending' ? 'Generando…' : 'Generar QR'}
          </button>
          {text && <button type="button" className={secondaryButton} onClick={() => { result.clear(); setText('') }}><X aria-hidden="true" className="h-4 w-4" />Limpiar</button>}
        </div>
      </section>
      <section className={`${imagePanel} space-y-3`}>
        <h2 className="text-sm font-semibold text-slate-800">Código generado</h2>
        {result.state.status === 'idle' && <InlineStatus>El código aparecerá aquí cuando lo generes.</InlineStatus>}
        {result.state.status === 'pending' && <InlineStatus>Preparando vista previa y descargas…</InlineStatus>}
        {result.state.status === 'error' && <InlineStatus error>{result.state.error}</InlineStatus>}
        {result.state.status === 'ready' && <GeneratedQrOutput value={result.state.value} />}
      </section>
    </div>
  )
}

function GeneratedQrOutput({ value }: { value: GeneratedQr }) {
  return (
    <>
      <img src={value.png} alt="Código QR generado" className="mx-auto h-auto w-full max-w-52 rounded-lg border border-slate-200 bg-white [image-rendering:pixelated]" />
      <div className="flex flex-wrap gap-2">
        <a href={value.png} download="codigo-qr.png" className={secondaryButton}><Download aria-hidden="true" className="h-4 w-4" />Descargar PNG</a>
        <button type="button" className={secondaryButton} onClick={() => downloadLocalFile(new Blob([value.svg], { type: 'image/svg+xml' }), 'codigo-qr.svg')}><Download aria-hidden="true" className="h-4 w-4" />Descargar SVG</button>
      </div>
    </>
  )
}

function DecodeQr() {
  const source = useLocalJob<LocalImage>()
  const result = useLocalJob<string>()
  const image = source.state.status === 'ready' ? source.state.value : null

  return (
    <div className={imageGrid}>
      <section className={`${imagePanel} space-y-3`}>
        <h2 className="text-sm font-semibold text-slate-800">Imagen del QR</h2>
        <ImageInput source={source.state} onSelect={file => {
          result.clear()
          void source.run(signal => validateLocalImage(file, signal))
        }} onClear={() => { result.clear(); source.clear() }} />
        <div className="flex flex-wrap gap-2">
          <button type="button" className={primaryButton} disabled={!image || result.state.status === 'pending'} onClick={() => image && void result.run(async signal => {
            const decoded = await readLocalQr(image, signal)
            if (decoded.kind !== 'found') throw new Error('No encontramos un código QR. Prueba con una imagen nítida o recorta alrededor del código.')
            if (!decoded.text) throw new Error('El código QR encontrado no contiene texto legible.')
            return decoded.text
          })}>
            <ScanLine aria-hidden="true" className="h-4 w-4" />{result.state.status === 'pending' ? 'Leyendo…' : 'Leer QR'}
          </button>
          {result.state.status === 'pending' && <button type="button" className={secondaryButton} onClick={result.clear}>Cancelar lectura</button>}
        </div>
      </section>
      <section className={`${imagePanel} space-y-3`}>
        <h2 className="text-sm font-semibold text-slate-800">Contenido del QR</h2>
        {result.state.status === 'idle' && <InlineStatus>El contenido aparecerá aquí después de leer el código.</InlineStatus>}
        {result.state.status === 'pending' && <InlineStatus>Buscando el código en la imagen…</InlineStatus>}
        {result.state.status === 'error' && <InlineStatus error>{result.state.error}</InlineStatus>}
        {result.state.status === 'ready' && (
          <>
            <textarea readOnly aria-label="Contenido del QR" className={`${textField} min-h-32`} value={result.state.value} />
            <div className="flex flex-wrap items-center gap-2"><CopyImageResult value={result.state.value} fallback="No pudimos copiar el contenido. Selecciónalo y cópialo manualmente." /></div>
          </>
        )}
      </section>
    </div>
  )
}

export default function QrUtility() {
  const [mode, setMode] = useState<QrMode>('create')
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ImageModePicker label="Operación de QR" mode={mode} onChange={setMode} options={modes} />
      {mode === 'create' ? <GenerateQr /> : <DecodeQr />}
    </div>
  )
}
