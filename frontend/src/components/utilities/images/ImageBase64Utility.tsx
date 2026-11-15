'use client'

import { ArrowLeftRight, Download, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { useUtilityDocumentState, useUtilityDocumentText } from '../library/UtilityDocumentContext'
import { useSavedImage } from './useSavedImage'
import { CopyImageResult, ImageInput, ImageModePicker, ImagePanelHeader, ImagePreview, InlineStatus, downloadLocalFile, iconButton, imageGrid, imagePanel, primaryButton, textField } from './ImageControls'
import { decodeImageBase64, encodeImageBase64, type LocalImage } from './localImages'
import { IMAGE_TEXT_PREVIEW_CHARACTERS, imageTextOutput } from './imageTextOutput'
import { useLocalJob } from './useLocalJob'

const modes = [{ value: 'encode', label: 'Imagen a Base64' }, { value: 'decode', label: 'Base64 a imagen' }] as const
const encodings = [{ value: 'raw', label: 'Base64' }, { value: 'url', label: 'Data URL' }] as const
type ImageMode = typeof modes[number]['value']
type Encoding = typeof encodings[number]['value']

function Base64Output({ dataUrl }: { dataUrl: string }) {
  const [format, setFormat] = useUtilityDocumentState<Encoding>('image_output_format', 'raw')
  const { value, preview, truncated } = imageTextOutput(dataUrl, format)
  return (
    <>
      <ImagePanelHeader title="Resultado">
        <ImageModePicker label="Formato de salida" mode={format} onChange={setFormat} options={encodings} />
        <CopyImageResult key={format} value={value} fallback={truncated ? 'No pudimos copiar el texto. Usa Descargar TXT para obtenerlo completo.' : 'No pudimos copiar el texto. Selecciónalo manualmente o usa Descargar TXT.'} />
        <button type="button" className={iconButton} aria-label="Descargar TXT" title="Descargar texto completo" onClick={() => downloadLocalFile(new Blob([value], { type: 'text/plain;charset=utf-8' }), format === 'url' ? 'imagen-data-url.txt' : 'imagen-base64.txt')}><Download aria-hidden="true" className="h-4 w-4" /></button>
      </ImagePanelHeader>
      <textarea readOnly aria-label="Texto Base64 resultante" className={`${textField} min-h-36 break-all`} value={preview} />
      {truncated && <p className="text-xs text-slate-600">Vista previa de los primeros {new Intl.NumberFormat('es').format(IMAGE_TEXT_PREVIEW_CHARACTERS)} caracteres. Copiar y Descargar incluyen el texto completo.</p>}
    </>
  )
}

function EncodeImage({ modeControl }: { modeControl: ReactNode }) {
  const source = useLocalJob<LocalImage>()
  const savedImage = useSavedImage('source', source)
  const result = useLocalJob<string>()
  const [encoded, setEncoded] = useUtilityDocumentState('image_encoded', false)
  const restored = useRef(false)
  const image = source.state.status === 'ready' ? source.state.value : null
  useEffect(() => {
    if (!image || !encoded || restored.current) return
    restored.current = true; void result.run(signal => encodeImageBase64(image.blob, signal))
  }, [image, encoded])

  return (
    <>
      <div className="utility-work-toolbar" role="group" aria-label="Acciones de imagen">
        {modeControl}
        <button type="button" className={`${primaryButton} ml-auto`} aria-label="Convertir a Base64" disabled={!image || result.state.status === 'pending'} onClick={() => { restored.current = true; setEncoded(true); if (image) void result.run(signal => encodeImageBase64(image.blob, signal)) }}>
          <ArrowLeftRight aria-hidden="true" className="h-4 w-4" />{result.state.status === 'pending' ? 'Convirtiendo…' : 'Convertir'}
        </button>
      </div>
      <div className={imageGrid}>
      <section className={imagePanel}>
        <ImageInput label="Imagen original" source={source.state} onSelect={file => {
          result.clear()
          setEncoded(false)
          savedImage.select(file)
        }} onClear={() => { result.clear(); setEncoded(false); savedImage.clear() }} />
      </section>
      <section className={imagePanel}>
        {result.state.status !== 'ready' && <ImagePanelHeader title="Resultado Base64" />}
        {result.state.status === 'idle' && <InlineStatus>Selecciona una imagen y conviértela para obtener su representación como texto.</InlineStatus>}
        {result.state.status === 'pending' && <InlineStatus>Codificando la imagen original…</InlineStatus>}
        {result.state.status === 'error' && <InlineStatus error>{result.state.error}</InlineStatus>}
        {result.state.status === 'ready' && <Base64Output dataUrl={result.state.value} />}
      </section>
    </div>
    </>
  )
}

function DecodeImage({ modeControl }: { modeControl: ReactNode }) {
  const [text, setText] = useUtilityDocumentText('base64-text')
  const result = useLocalJob<LocalImage>()
  const [decoded, setDecoded] = useUtilityDocumentState('image_decoded', false)
  const restored = useRef(false)
  useEffect(() => {
    if (!text || !decoded || restored.current) return
    restored.current = true; void result.run(signal => decodeImageBase64(text, signal))
  }, [text, decoded])

  return (
    <>
      <div className="utility-work-toolbar" role="group" aria-label="Acciones de imagen">
        {modeControl}
        <button type="button" className={`${primaryButton} ml-auto`} aria-label="Convertir a imagen" disabled={!text || result.state.status === 'pending'} onClick={() => { restored.current = true; setDecoded(true); void result.run(signal => decodeImageBase64(text, signal)) }}>
          <ArrowLeftRight aria-hidden="true" className="h-4 w-4" />{result.state.status === 'pending' ? 'Convirtiendo…' : 'Convertir'}
        </button>
      </div>
      <div className={imageGrid}>
      <section className={imagePanel}>
        <ImagePanelHeader title="Texto Base64 o Data URL" htmlFor="base64-image-text">
          {text && <button type="button" className={iconButton} aria-label="Limpiar" title="Limpiar texto" onClick={() => { result.clear(); setDecoded(false); setText('') }}><X aria-hidden="true" className="h-4 w-4" /></button>}
        </ImagePanelHeader>
        <textarea id="base64-image-text" className={`${textField} min-h-36 break-all`} value={text} autoComplete="off" spellCheck={false} placeholder="Pega Base64 o data:image/png;base64,…" onChange={event => { result.clear(); setDecoded(false); setText(event.target.value) }} />
        <p className="text-xs text-slate-600">PNG, JPG o WebP · Hasta 10 MiB y 16 megapíxeles después de decodificar.</p>
      </section>
      <section className={imagePanel}>
        <ImagePanelHeader title="Imagen recuperada">
          {result.state.status === 'ready' && <button type="button" className={iconButton} aria-label="Descargar imagen" title="Descargar imagen original" onClick={() => { if (result.state.status === 'ready') downloadLocalFile(result.state.value.blob, result.state.value.name) }}><Download aria-hidden="true" className="h-4 w-4" /></button>}
        </ImagePanelHeader>
        {result.state.status === 'idle' && <InlineStatus>Pega el contenido y conviértelo para ver la imagen.</InlineStatus>}
        {result.state.status === 'pending' && <InlineStatus>Comprobando y abriendo la imagen…</InlineStatus>}
        {result.state.status === 'error' && <InlineStatus error>{result.state.error}</InlineStatus>}
        {result.state.status === 'ready' && <ImagePreview image={result.state.value} />}
      </section>
    </div>
    </>
  )
}

export default function ImageBase64Utility() {
  const [mode, setMode] = useUtilityDocumentState<ImageMode>('image_mode', 'encode')
  const modeInput = useRef<HTMLSelectElement>(null)
  const restoreModeFocus = useRef(false)
  useLayoutEffect(() => {
    if (restoreModeFocus.current) { restoreModeFocus.current = false; modeInput.current?.focus({ preventScroll: true }) }
  }, [mode])
  const modeControl = <ImageModePicker inputRef={modeInput} label="Conversión de imagen" mode={mode} onChange={next => { restoreModeFocus.current = true; setMode(next) }} options={modes} />
  return (
    <div className="utility-density-scope flex min-w-0 flex-col gap-2">
      {mode === 'encode' ? <EncodeImage modeControl={modeControl} /> : <DecodeImage modeControl={modeControl} />}
    </div>
  )
}
