'use client'

import { ArrowLeftRight, Download, X } from 'lucide-react'
import { useState } from 'react'
import { CopyImageResult, ImageInput, ImageModePicker, ImagePreview, InlineStatus, downloadLocalFile, imageGrid, imagePanel, primaryButton, secondaryButton, textField } from './ImageControls'
import { decodeImageBase64, encodeImageBase64, validateLocalImage, type LocalImage } from './localImages'
import { useLocalJob } from './useLocalJob'

const modes = [{ value: 'encode', label: 'Imagen a Base64' }, { value: 'decode', label: 'Base64 a imagen' }] as const
const encodings = [{ value: 'raw', label: 'Base64' }, { value: 'url', label: 'Data URL' }] as const
const PREVIEW_CHARACTERS = 12_000
type ImageMode = typeof modes[number]['value']
type Encoding = typeof encodings[number]['value']

function Base64Output({ dataUrl }: { dataUrl: string }) {
  const [format, setFormat] = useState<Encoding>('raw')
  const value = format === 'url' ? dataUrl : dataUrl.slice(dataUrl.indexOf(',') + 1)
  const truncated = value.length > PREVIEW_CHARACTERS
  return (
    <>
      <ImageModePicker label="Formato de salida" mode={format} onChange={setFormat} options={encodings} />
      <textarea readOnly aria-label="Texto Base64 resultante" className={`${textField} min-h-36 break-all`} value={value.slice(0, PREVIEW_CHARACTERS)} />
      {truncated && <p className="text-xs text-slate-600">Vista previa de los primeros {new Intl.NumberFormat('es').format(PREVIEW_CHARACTERS)} caracteres. Copiar y Descargar incluyen el texto completo.</p>}
      <div className="flex flex-wrap items-center gap-2">
        <CopyImageResult key={format} value={value} fallback={truncated ? 'No pudimos copiar el texto. Usa Descargar TXT para obtenerlo completo.' : 'No pudimos copiar el texto. Selecciónalo manualmente o usa Descargar TXT.'} />
        <button type="button" className={secondaryButton} onClick={() => downloadLocalFile(new Blob([value], { type: 'text/plain;charset=utf-8' }), format === 'url' ? 'imagen-data-url.txt' : 'imagen-base64.txt')}><Download aria-hidden="true" className="h-4 w-4" />Descargar TXT</button>
      </div>
    </>
  )
}

function EncodeImage() {
  const source = useLocalJob<LocalImage>()
  const result = useLocalJob<string>()
  const image = source.state.status === 'ready' ? source.state.value : null

  return (
    <div className={imageGrid}>
      <section className={`${imagePanel} space-y-3`}>
        <h2 className="text-sm font-semibold text-slate-800">Imagen original</h2>
        <ImageInput source={source.state} onSelect={file => {
          result.clear()
          void source.run(signal => validateLocalImage(file, signal))
        }} onClear={() => { result.clear(); source.clear() }} />
        <button type="button" className={primaryButton} disabled={!image || result.state.status === 'pending'} onClick={() => image && void result.run(signal => encodeImageBase64(image.blob, signal))}>
          <ArrowLeftRight aria-hidden="true" className="h-4 w-4" />{result.state.status === 'pending' ? 'Convirtiendo…' : 'Convertir a Base64'}
        </button>
      </section>
      <section className={`${imagePanel} space-y-3`}>
        <h2 className="text-sm font-semibold text-slate-800">Resultado Base64</h2>
        {result.state.status === 'idle' && <InlineStatus>Selecciona una imagen y conviértela para obtener su representación como texto.</InlineStatus>}
        {result.state.status === 'pending' && <InlineStatus>Codificando la imagen original…</InlineStatus>}
        {result.state.status === 'error' && <InlineStatus error>{result.state.error}</InlineStatus>}
        {result.state.status === 'ready' && <Base64Output dataUrl={result.state.value} />}
      </section>
    </div>
  )
}

function DecodeImage() {
  const [text, setText] = useState('')
  const result = useLocalJob<LocalImage>()

  return (
    <div className={imageGrid}>
      <section className={`${imagePanel} space-y-3`}>
        <label htmlFor="base64-image-text" className="block text-sm font-semibold text-slate-800">Texto Base64 o Data URL</label>
        <textarea id="base64-image-text" className={`${textField} min-h-36 break-all`} value={text} autoComplete="off" spellCheck={false} placeholder="Pega Base64 o data:image/png;base64,…" onChange={event => { result.clear(); setText(event.target.value) }} />
        <p className="text-xs text-slate-600">PNG, JPG o WebP · Hasta 10 MiB y 16 megapíxeles después de decodificar.</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={primaryButton} disabled={!text || result.state.status === 'pending'} onClick={() => void result.run(signal => decodeImageBase64(text, signal))}>
            <ArrowLeftRight aria-hidden="true" className="h-4 w-4" />{result.state.status === 'pending' ? 'Convirtiendo…' : 'Convertir a imagen'}
          </button>
          {text && <button type="button" className={secondaryButton} onClick={() => { result.clear(); setText('') }}><X aria-hidden="true" className="h-4 w-4" />Limpiar</button>}
        </div>
      </section>
      <section className={`${imagePanel} space-y-3`}>
        <h2 className="text-sm font-semibold text-slate-800">Imagen recuperada</h2>
        {result.state.status === 'idle' && <InlineStatus>Pega el contenido y conviértelo para ver la imagen.</InlineStatus>}
        {result.state.status === 'pending' && <InlineStatus>Comprobando y abriendo la imagen…</InlineStatus>}
        {result.state.status === 'error' && <InlineStatus error>{result.state.error}</InlineStatus>}
        {result.state.status === 'ready' && <DecodedImageOutput image={result.state.value} />}
      </section>
    </div>
  )
}

function DecodedImageOutput({ image }: { image: LocalImage }) {
  return (
    <>
      <ImagePreview image={image} />
      <button type="button" className={secondaryButton} onClick={() => downloadLocalFile(image.blob, image.name)}><Download aria-hidden="true" className="h-4 w-4" />Descargar imagen</button>
    </>
  )
}

export default function ImageBase64Utility() {
  const [mode, setMode] = useState<ImageMode>('encode')
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ImageModePicker label="Conversión de imagen" mode={mode} onChange={setMode} options={modes} />
      {mode === 'encode' ? <EncodeImage /> : <DecodeImage />}
    </div>
  )
}
