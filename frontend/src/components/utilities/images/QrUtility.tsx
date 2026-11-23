'use client'

import { Download, FileCode, FileImage, QrCode, ScanLine, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { useUtilityDocumentState, useUtilityDocumentText } from '../library/UtilityDocumentContext'
import { UtilityActionMenu } from '../library/UtilityActionMenu'
import { useSavedImage } from './useSavedImage'
import { CopyImageResult, ImageInput, ImageModePicker, ImagePanelHeader, InlineStatus, downloadLocalFile, downloadLocalUrl, iconButton, imageGrid, imagePanel, primaryButton, textField } from './ImageControls'
import type { LocalImage } from './localImages'
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

function GenerateQr({ modeControl }: { modeControl: ReactNode }) {
  const [text, setText] = useUtilityDocumentText('qr-text')
  const [generated, setGenerated] = useUtilityDocumentState('qr_generated', false)
  const result = useLocalJob<GeneratedQr>()
  const restored = useRef(false)
  useEffect(() => {
    if (!text || !generated || restored.current) return
    restored.current = true
    void result.run(signal => generateQr(text, signal))
  }, [text, generated])

  return (
    <>
      <div className="utility-work-toolbar" role="group" aria-label="Acciones de QR">
        {modeControl}
        <button type="button" className={`${primaryButton} ml-auto`} aria-label="Generar QR" disabled={!text || result.state.status === 'pending'} onClick={() => { restored.current = true; setGenerated(true); void result.run(signal => generateQr(text, signal)) }}>
          <QrCode aria-hidden="true" className="h-4 w-4" />{result.state.status === 'pending' ? 'Generando…' : 'Generar'}
        </button>
      </div>
      <div className={imageGrid}>
      <section className={imagePanel}>
        <ImagePanelHeader title="Texto o enlace" htmlFor="qr-text">
          {text && <button type="button" className={iconButton} aria-label="Limpiar" title="Limpiar texto" onClick={() => { result.clear(); setGenerated(false); setText('') }}><X aria-hidden="true" className="h-4 w-4" /></button>}
        </ImagePanelHeader>
        <textarea id="qr-text" className={`${textField} min-h-36`} placeholder="Escribe o pega el contenido del QR" value={text} autoComplete="off" spellCheck={false} onChange={event => {
          result.clear()
          setGenerated(false)
          setText(event.target.value)
        }} />
      </section>
      <section className={imagePanel}>
        <ImagePanelHeader title="Código QR">
          {result.state.status === 'ready' && <UtilityActionMenu label="Descargar QR" className={iconButton} icon={Download} actions={[
            { id: 'png', label: 'Descargar PNG', icon: FileImage, onSelect: () => { if (result.state.status === 'ready') downloadLocalUrl(result.state.value.png, 'codigo-qr.png') } },
            { id: 'svg', label: 'Descargar SVG', icon: FileCode, onSelect: () => { if (result.state.status === 'ready') downloadLocalFile(new Blob([result.state.value.svg], { type: 'image/svg+xml' }), 'codigo-qr.svg') } },
          ]} />}
        </ImagePanelHeader>
        {result.state.status === 'idle' && <InlineStatus>El código aparecerá aquí cuando lo generes.</InlineStatus>}
        {result.state.status === 'pending' && <InlineStatus>Preparando vista previa y descargas…</InlineStatus>}
        {result.state.status === 'error' && <InlineStatus error>{result.state.error}</InlineStatus>}
        {result.state.status === 'ready' && <img src={result.state.value.png} alt="Código QR generado" className="mx-auto h-auto w-full max-w-52 rounded-lg border border-slate-200 bg-white [image-rendering:pixelated]" />}
      </section>
    </div>
    </>
  )
}
function DecodeQr({ modeControl }: { modeControl: ReactNode }) {
  const source = useLocalJob<LocalImage>()
  const savedImage = useSavedImage('source', source)
  const result = useLocalJob<string>()
  const [decoded, setDecoded] = useUtilityDocumentState('qr_decoded', false)
  const restored = useRef(false)
  const image = source.state.status === 'ready' ? source.state.value : null

  async function decode(signal: AbortSignal) {
    if (!image) throw new Error('Selecciona una imagen.')
    const value = await readLocalQr(image, signal)
    if (value.kind !== 'found') throw new Error('No encontramos un código QR. Prueba con una imagen nítida o recorta alrededor del código.')
    if (!value.text) throw new Error('El código QR encontrado no contiene texto legible.')
    return value.text
  }
  useEffect(() => {
    if (!image || !decoded || restored.current) return
    restored.current = true; void result.run(decode)
  }, [image, decoded])

  return (
    <>
      <div className="utility-work-toolbar" role="group" aria-label="Acciones de QR">
        {modeControl}
        <button type="button" className={`${primaryButton} ml-auto`} aria-label="Leer QR" disabled={!image || result.state.status === 'pending'} onClick={() => { restored.current = true; setDecoded(true); if (image) void result.run(decode) }}>
          <ScanLine aria-hidden="true" className="h-4 w-4" />{result.state.status === 'pending' ? 'Leyendo…' : 'Leer'}
        </button>
        {result.state.status === 'pending' && <button type="button" className={iconButton} aria-label="Cancelar lectura" title="Cancelar lectura" onClick={result.clear}><X aria-hidden="true" className="h-4 w-4" /></button>}
      </div>
      <div className={imageGrid}>
      <section className={imagePanel}>
        <ImageInput label="Imagen del QR" source={source.state} onSelect={file => {
          result.clear()
          setDecoded(false)
          savedImage.select(file)
        }} onClear={() => { result.clear(); setDecoded(false); savedImage.clear() }} />
      </section>
      <section className={imagePanel}>
        <ImagePanelHeader title="Contenido del QR">
          {result.state.status === 'ready' && <CopyImageResult value={result.state.value} fallback="No pudimos copiar el contenido. Selecciónalo y cópialo manualmente." />}
        </ImagePanelHeader>
        {result.state.status === 'idle' && <InlineStatus>El contenido aparecerá aquí después de leer el código.</InlineStatus>}
        {result.state.status === 'pending' && <InlineStatus>Buscando el código en la imagen…</InlineStatus>}
        {result.state.status === 'error' && <InlineStatus error>{result.state.error}</InlineStatus>}
        {result.state.status === 'ready' && <textarea readOnly aria-label="Contenido del QR" className={`${textField} min-h-32`} value={result.state.value} />}
      </section>
    </div>
    </>
  )
}

export default function QrUtility() {
  const [mode, setMode] = useUtilityDocumentState<QrMode>('qr_mode', 'create')
  const modeInput = useRef<HTMLSelectElement>(null)
  const restoreModeFocus = useRef(false)
  useLayoutEffect(() => {
    if (restoreModeFocus.current) { restoreModeFocus.current = false; modeInput.current?.focus({ preventScroll: true }) }
  }, [mode])
  const modeControl = <ImageModePicker inputRef={modeInput} label="Operación de QR" mode={mode} onChange={next => { restoreModeFocus.current = true; setMode(next) }} options={modes} />
  return (
    <div className="utility-density-scope flex min-w-0 flex-col gap-2">
      {mode === 'create' ? <GenerateQr modeControl={modeControl} /> : <DecodeQr modeControl={modeControl} />}
    </div>
  )
}
