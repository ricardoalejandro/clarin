'use client'

import { Children, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ArrowDownToLine, Binary, Copy, Eye, EyeOff, Hash, Info, KeyRound, Loader2, LockKeyhole, X } from 'lucide-react'
import { subscribeWebSocket } from '@/lib/api'
import { useUtilityDocument, useUtilityDocumentState } from '../library/UtilityDocumentContext'
import { libraryRequest, UtilityRequestError } from '../library/libraryApi'
import { VaultPanel, type VaultSelection } from './VaultPanel'
import type { KeyMaterial } from './pkiOperations'
import { CryptoHelp, CryptoHelpContext, CryptoToolbarActions, CryptoToolbarContext } from './CryptoToolbarContext'
import { documentVaultPath, scopedVaultEvent } from './vaultScope'
import '../utility-density.css'
import {
  CryptoInputError, decodeBase64, decodeUtf8, decryptJwe, encodeBase64, encodeHex, encodeUtf8, encryptJwe,
  generateAesKey, generateRsaKeys, hashText, MAX_CRYPTO_ENCODED_CHARS, MAX_CRYPTO_PEM_CHARS,
  type Base64Format, type CipherAlgorithm, type HashAlgorithm,
} from './cryptoOperations'

const controlBase = 'utility-control inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border px-2 text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 disabled:opacity-40'
const control = `${controlBase} border-slate-200 bg-white text-slate-700 hover:bg-slate-50`
const selectedControl = `${controlBase} border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100`
const primary = `${controlBase} border-emerald-700 bg-emerald-700 text-white hover:bg-emerald-800`
const field = 'utility-field w-full rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600'
const textField = `${field} block resize-y py-2 font-mono leading-6`
const panel = 'utility-panel flex min-h-0 flex-col gap-2'
const pair = 'utility-pair utility-crypto-pair'

function columns(width: string) {
  return { gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${width}), 1fr))` }
}

function useOperation<T>() {
  const documentSession = useUtilityDocument()
  const generation = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const [result, setResult] = useState<T>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => () => { generation.current++; controller.current?.abort() }, [])
  useEffect(() => documentSession?.registerBeforeDeactivate?.(() => reset()), [documentSession])

  function reset() {
    generation.current++
    controller.current?.abort()
    setResult(undefined)
    setError('')
    setBusy(false)
  }

  function inputError(message: string) {
    reset()
    setError(message)
  }

  async function run(work: (isCurrent: () => boolean, signal: AbortSignal) => T | Promise<T>) {
    controller.current?.abort()
    const request = new AbortController()
    controller.current = request
    const current = ++generation.current
    setResult(undefined)
    setError('')
    setBusy(true)
    try {
      const value = await work(() => generation.current === current && !request.signal.aborted, request.signal)
      if (generation.current === current) setResult(value)
    } catch (error) {
      if (generation.current === current) setError(error instanceof CryptoInputError ? error.message : 'No se pudo completar la operación. Puedes reintentar.')
    } finally {
      if (generation.current === current) setBusy(false)
    }
  }

  return { result, error, busy, reset, inputError, run }
}

function useDownload() {
  const pending = useRef(new Map<string, number>())
  useEffect(() => {
    const urls = pending.current
    return () => {
      for (const [url, timeout] of urls) {
        window.clearTimeout(timeout)
        URL.revokeObjectURL(url)
      }
      urls.clear()
    }
  }, [])

  return (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
    pending.current.set(url, window.setTimeout(() => {
      URL.revokeObjectURL(url)
      pending.current.delete(url)
    }, 1000))
  }
}

function LabeledField({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block min-w-0 space-y-1 text-sm font-semibold text-slate-700"><span className="block">{label}</span>{children}</label>
}

function FormatOptions({ children }: { children: ReactNode }) {
  return <details className="rounded-lg border border-slate-200 px-2">
    <summary className="utility-control flex cursor-pointer items-center text-xs font-medium text-slate-600">Opciones de formato</summary>
    <div className="grid gap-2 pb-2" style={columns('10rem')}>{children}</div>
  </details>
}

function SourceField({ label, value, onChange, rows = 7 }: { label: string; value: string; onChange: (value: string) => void; rows?: number }) {
  return <label className="flex min-h-0 flex-1 flex-col gap-1 text-sm font-semibold text-slate-700"><span>{label}</span>
    <textarea rows={rows} value={value} className={`${textField} min-h-32 flex-1 font-normal`} onChange={(event) => onChange(event.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} />
  </label>
}

function TaskActions({ label, busy, disabled, onRun, onClear, error }: { label: string; busy: boolean; disabled?: boolean; onRun: () => void; onClear: () => void; error: string }) {
  return <>
    <CryptoToolbarActions>
      <button type="button" disabled={disabled || busy} className={primary} onClick={onRun}>{busy && <Loader2 aria-hidden className="h-4 w-4 motion-safe:animate-spin" />}{busy ? 'Procesando…' : label}</button>
      <button type="button" className={control} aria-label={busy ? 'Cancelar' : 'Limpiar'} title={busy ? 'Cancelar' : 'Limpiar'} onClick={onClear}><X size={16} aria-hidden /></button>
    </CryptoToolbarActions>
    {(error || busy) && <div className="text-sm" aria-live="polite" aria-atomic="true">{error && <p className="text-rose-700">{error}</p>}{busy && <p className="sr-only">Operación en curso</p>}</div>}
  </>
}

function ResultText({ title, value, fileName, secret = false }: { title: string; value: string; fileName: string; secret?: boolean }) {
  const [shown, setShown] = useState(!secret)
  const [message, setMessage] = useState('')
  const id = useId()
  const output = useRef<HTMLTextAreaElement>(null)
  const generation = useRef(0)
  const download = useDownload()

  useEffect(() => () => { generation.current++ }, [value])

  async function copy() {
    const current = generation.current
    try {
      await navigator.clipboard.writeText(value)
      if (generation.current === current) setMessage('Copiado al portapapeles.')
    } catch {
      if (generation.current !== current) return
      if (output.current) {
        output.current.focus()
        output.current.select()
        setMessage('El resultado quedó seleccionado. Cópialo con el atajo del teclado o el menú del dispositivo.')
      } else {
        setMessage('No se pudo copiar. Puedes mostrar o descargar la clave.')
      }
    }
  }

  return <div className="space-y-1">
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-1">
      {shown ? <label className="text-xs font-semibold text-slate-900" htmlFor={id}>{title}</label> : <p className="text-xs font-semibold text-slate-900">{title}</p>}
    <div className="flex items-center gap-1">
      {secret && <button type="button" className={control} onClick={() => setShown(!shown)}>{shown ? <EyeOff aria-hidden className="h-4 w-4" /> : <Eye aria-hidden className="h-4 w-4" />}{shown ? 'Ocultar clave' : 'Mostrar clave'}</button>}
      <button type="button" className={control} onClick={() => void copy()} aria-label={`Copiar ${title.toLowerCase()}`} title="Copiar resultado completo"><Copy aria-hidden className="h-4 w-4" /></button>
      <button type="button" className={control} onClick={() => download(new Blob([value], { type: 'text/plain;charset=utf-8' }), fileName)} aria-label={`Descargar ${title.toLowerCase()}`} title="Descargar resultado completo"><ArrowDownToLine aria-hidden className="h-4 w-4" /></button>
    </div>
    </div>
    {shown && <textarea id={id} rows={6} readOnly ref={output} className={textField} value={value} spellCheck={false} placeholder="Resultado vacío" />}
    {!shown && <p className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-2 text-sm text-slate-600">La clave está oculta.</p>}
    {message && <p aria-live="polite" className="text-xs text-slate-600">{message}</p>}
  </div>
}

function ResultPanel({ children, busy }: { children?: ReactNode; busy: boolean }) {
  const hasResult = Children.toArray(children).length > 0
  return <div className={panel} aria-busy={busy}>
    <h3 className="text-xs font-semibold text-slate-900">Resultado</h3>
    <p role="status" className="sr-only">{hasResult ? 'Resultado listo.' : ''}</p>
    {hasResult ? children : <p className="text-sm text-slate-500">{busy ? 'Procesando…' : 'Aquí aparecerá el resultado de la operación.'}</p>}
  </div>
}

function changeBounded(value: string, limit: number, setValue: (value: string) => void, operation: { inputError: (message: string) => void; reset: () => void }) {
  if (value.length > limit) {
    operation.inputError('La entrada supera el límite de esta operación. Se conservó el valor anterior.')
    return
  }
  operation.reset()
  setValue(value)
}

function CipherPanel({ savedKey, onKeyUnavailable }: { savedKey?: VaultSelection; onKeyUnavailable?: (id: string) => void }) {
  const documentId = useUtilityDocument()?.documentId || ''
  const [mode, setMode] = useUtilityDocumentState<'encrypt' | 'decrypt'>('cipher_mode', 'encrypt')
  const [algorithm, setAlgorithm] = useUtilityDocumentState<CipherAlgorithm>('cipher_algorithm', 'aes256')
  const [source, setSource] = useState('')
  const [key, setKey] = useState('')
  const operation = useOperation<string>()
  const [useSaved, setUseSaved] = useState(Boolean(savedKey))
  useEffect(() => {
    operation.reset()
    if (!savedKey) { setUseSaved(false); return }
    setUseSaved(true)
    setAlgorithm(savedKey.kind === 'rsa' ? 'rsa' : savedKey.bits === 128 ? 'aes128' : 'aes256')
    // A saved entry determines the compatible profile without copying private material into React state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey?.id])
  const encrypting = mode === 'encrypt'
  const rsa = algorithm === 'rsa'
  const updateKey = (value: string) => changeBounded(value, rsa ? MAX_CRYPTO_PEM_CHARS : 256, setKey, operation)

  return <div className={pair}>
    <div className={panel}>
      <div className="grid gap-3" style={columns('11rem')}>
        <LabeledField label="Operación">
          <select value={mode} className={field} onChange={(event) => { operation.reset(); setMode(event.target.value as typeof mode); if (rsa) setKey('') }}>
            <option value="encrypt">Cifrar texto</option><option value="decrypt">Descifrar JWE</option>
          </select>
        </LabeledField>
        <LabeledField label="Algoritmo">
          <select value={algorithm} disabled={useSaved} className={field} onChange={(event) => { operation.reset(); setKey(''); setAlgorithm(event.target.value as CipherAlgorithm) }}>
            <option value="aes128">AES-128-GCM</option><option value="aes256">AES-256-GCM</option><option value="rsa">RSA híbrido</option>
          </select>
        </LabeledField>
      </div>
      <SourceField label={encrypting ? 'Texto para cifrar (UTF-8)' : 'JWE compacto'} value={source} onChange={(value) => changeBounded(value, MAX_CRYPTO_ENCODED_CHARS, setSource, operation)} />
      {savedKey && <label className="flex min-h-11 items-center gap-2 break-words text-sm text-slate-700"><input type="checkbox" className="shrink-0" checked={useSaved} onChange={event => { operation.reset(); setUseSaved(event.target.checked) }} /><span className="min-w-0 break-all">Usar la clave seleccionada de Mis claves ({savedKey.name ? `${savedKey.name} · ` : ''}{savedKey.algorithm})</span></label>}
      {!useSaved && (rsa
        ? <SourceField rows={4} label={encrypting ? 'Clave pública RSA (PEM SPKI)' : 'Clave privada RSA (PEM PKCS#8)'} value={key} onChange={updateKey} />
        : <LabeledField label={`Clave AES de ${algorithm === 'aes128' ? '128' : '256'} bits (Base64)`}><input type="password" autoComplete="off" value={key} className={`${field} font-mono font-normal`} onChange={(event) => updateKey(event.target.value)} /></LabeledField>)}
      <CryptoHelp>Formato JWE compacto. {rsa ? 'RSA-OAEP-256 protege una clave nueva de AES-256-GCM en cada operación.' : 'La clave Base64 puede generarse en Claves.'} Límite de texto de 1 MiB.</CryptoHelp>
      <TaskActions label={encrypting ? 'Cifrar' : 'Descifrar'} busy={operation.busy} error={operation.error} disabled={(!useSaved && !key.trim()) || (!encrypting && !source.trim())}
        onRun={() => void operation.run(async (isCurrent, signal) => {
          let value = key
          if (useSaved && savedKey) {
            let stored: { material: string }
            try {
              stored = await libraryRequest<{ material: string }>(`${documentVaultPath(documentId, savedKey.id)}/material`, { signal })
            } catch (error) {
              if (isCurrent() && error instanceof UtilityRequestError && error.status === 404) onKeyUnavailable?.(savedKey.id)
              throw error
            }
            if (!isCurrent()) throw new DOMException('Operación cancelada', 'AbortError')
            const material = JSON.parse(stored.material) as KeyMaterial
            value = rsa ? (encrypting ? material.publicKey : material.privateKey) || '' : material.secret || ''
          }
          return encrypting ? encryptJwe(source, algorithm, value) : decryptJwe(source, algorithm, value)
        })}
        onClear={() => { operation.reset(); if (!operation.busy) { setSource(''); setKey('') } }} />
    </div>
    <ResultPanel busy={operation.busy}>{operation.result !== undefined && <ResultText title={encrypting ? 'JWE cifrado' : 'Texto descifrado'} value={operation.result} fileName={encrypting ? 'resultado.jwe' : 'resultado.txt'} />}</ResultPanel>
  </div>
}

function HashPanel() {
  const [mode, setMode] = useUtilityDocumentState<'hash' | 'hmac'>('hash_mode', 'hash')
  const [algorithm, setAlgorithm] = useUtilityDocumentState<HashAlgorithm>('hash_algorithm', 'SHA-256')
  const [format, setFormat] = useUtilityDocumentState<'hex' | 'base64'>('hash_format', 'hex')
  const [keyFormat, setKeyFormat] = useState<'utf8' | 'base64'>('utf8')
  const [source, setSource] = useState('')
  const [key, setKey] = useState('')
  const operation = useOperation<Uint8Array>()

  return <div className={pair}>
    <div className={panel}>
      <div className="grid gap-3" style={columns('10rem')}>
        <LabeledField label="Operación">
          <select value={mode} className={field} onChange={(event) => { operation.reset(); setKey(''); setMode(event.target.value as typeof mode) }}>
            <option value="hash">Hash</option><option value="hmac">HMAC</option>
          </select>
        </LabeledField>
        <LabeledField label="Algoritmo">
          <select value={algorithm} className={field} onChange={(event) => { operation.reset(); setAlgorithm(event.target.value as HashAlgorithm) }}>
            <option>SHA-256</option><option>SHA-384</option><option>SHA-512</option>
          </select>
        </LabeledField>
      </div>
      <SourceField label="Texto (UTF-8)" value={source} onChange={(value) => changeBounded(value, MAX_CRYPTO_ENCODED_CHARS, setSource, operation)} />
      {mode === 'hmac' && <div className="grid gap-3" style={columns('10rem')}>
        <FormatOptions><LabeledField label="Formato de clave">
          <select value={keyFormat} className={field} onChange={(event) => { operation.reset(); setKey(''); setKeyFormat(event.target.value as typeof keyFormat) }}>
            <option value="utf8">Texto UTF-8</option><option value="base64">Base64</option>
          </select>
        </LabeledField></FormatOptions>
        <LabeledField label="Clave HMAC"><input type="password" autoComplete="off" value={key} className={`${field} font-mono font-normal`} onChange={(event) => changeBounded(event.target.value, 24 * 1024, setKey, operation)} /></LabeledField>
      </div>}
      <CryptoHelp>{mode === 'hash' ? 'Calcula una huella del texto, incluso si está vacío.' : 'Calcula una huella de autenticación a partir de una clave secreta.'} Límite de texto de 1 MiB.</CryptoHelp>
      <TaskActions label={mode === 'hash' ? 'Calcular hash' : 'Calcular HMAC'} busy={operation.busy} error={operation.error} disabled={mode === 'hmac' && !key.length}
        onRun={() => void operation.run(() => hashText(source, algorithm, mode === 'hmac' ? { value: key, format: keyFormat } : undefined))}
        onClear={() => { operation.reset(); if (!operation.busy) { setSource(''); setKey('') } }} />
    </div>
    <ResultPanel busy={operation.busy}>{operation.result && <>
      <FormatOptions><LabeledField label="Formato del resultado">
        <select className={field} value={format} onChange={(event) => setFormat(event.target.value as typeof format)}><option value="hex">Hexadecimal</option><option value="base64">Base64</option></select>
      </LabeledField></FormatOptions>
      <ResultText key={format} title={mode === 'hash' ? 'Huella' : 'Código HMAC'} value={format === 'hex' ? encodeHex(operation.result) : encodeBase64(operation.result, 'base64')} fileName={mode === 'hash' ? 'hash.txt' : 'hmac.txt'} />
    </>}</ResultPanel>
  </div>
}

type GeneratedKeys = { kind: 'aes'; key: string } | { kind: 'rsa'; publicKey: string; privateKey: string }

function KeyPanel() {
  const [mode, setMode] = useState<'aes' | 'rsa'>('aes')
  const [aesLength, setAesLength] = useState<128 | 256>(256)
  const [rsaLength, setRsaLength] = useState<2048 | 3072 | 4096>(3072)
  const operation = useOperation<GeneratedKeys>()

  return <div className={pair}>
    <div className={panel}>
      <LabeledField label="Tipo de clave">
        <select value={mode} className={field} onChange={(event) => { operation.reset(); setMode(event.target.value as typeof mode) }}><option value="aes">AES-GCM</option><option value="rsa">RSA-OAEP-256</option></select>
      </LabeledField>
      {mode === 'aes' ? <LabeledField label="Tamaño">
        <select value={aesLength} className={field} onChange={(event) => { operation.reset(); setAesLength(Number(event.target.value) as typeof aesLength) }}><option value="128">128 bits</option><option value="256">256 bits</option></select>
      </LabeledField> : <LabeledField label="Tamaño">
        <select value={rsaLength} className={field} onChange={(event) => { operation.reset(); setRsaLength(Number(event.target.value) as typeof rsaLength) }}><option value="2048">2048 bits</option><option value="3072">3072 bits</option><option value="4096">4096 bits</option></select>
      </LabeledField>}
      <CryptoHelp>{mode === 'aes' ? 'Genera una clave secreta en Base64.' : 'Genera una clave pública SPKI y una clave privada PKCS#8 en PEM.'} Guarda la clave secreta o privada en un lugar seguro si necesitas usarla después.</CryptoHelp>
      <TaskActions label={mode === 'aes' ? 'Generar clave AES' : 'Generar par RSA'} busy={operation.busy} error={operation.error}
        onRun={() => void operation.run(async () => mode === 'aes' ? { kind: 'aes', key: await generateAesKey(aesLength) } : { kind: 'rsa', ...await generateRsaKeys(rsaLength) })}
        onClear={operation.reset} />
    </div>
    <ResultPanel busy={operation.busy}>
      {operation.result?.kind === 'aes' && <ResultText title="Clave AES en Base64" value={operation.result.key} fileName="clave-aes.txt" secret />}
      {operation.result?.kind === 'rsa' && <div className="space-y-4">
        <ResultText title="Clave pública RSA" value={operation.result.publicKey} fileName="rsa-publica.pem" />
        <ResultText title="Clave privada RSA" value={operation.result.privateKey} fileName="rsa-privada.pem" secret />
      </div>}
    </ResultPanel>
  </div>
}

type Base64Result = { kind: 'text'; value: string } | { kind: 'binary'; value: Uint8Array<ArrayBuffer> }

function Base64Panel() {
  const [mode, setMode] = useUtilityDocumentState<'encode' | 'decode'>('base64_mode', 'encode')
  const [format, setFormat] = useUtilityDocumentState<Base64Format>('base64_format', 'base64')
  const [output, setOutput] = useUtilityDocumentState<'text' | 'binary'>('base64_output', 'text')
  const [source, setSource] = useState('')
  const operation = useOperation<Base64Result>()
  const download = useDownload()

  function convert(): Base64Result {
    if (mode === 'encode') return { kind: 'text', value: encodeBase64(encodeUtf8(source), format) }
    const bytes = decodeBase64(source, format)
    return output === 'text' ? { kind: 'text', value: decodeUtf8(bytes) } : { kind: 'binary', value: bytes }
  }

  return <div className={pair}>
    <div className={panel}>
      <div className="grid gap-3" style={columns('10rem')}>
        <LabeledField label="Operación">
          <select value={mode} className={field} onChange={(event) => { operation.reset(); setMode(event.target.value as typeof mode) }}><option value="encode">Codificar</option><option value="decode">Decodificar</option></select>
        </LabeledField>
      </div>
      <FormatOptions><LabeledField label="Formato">
          <select value={format} className={field} onChange={(event) => { operation.reset(); setFormat(event.target.value as Base64Format) }}><option value="base64">Base64</option><option value="base64url">Base64URL</option></select>
        </LabeledField>
        {mode === 'decode' && <LabeledField label="Salida">
          <select value={output} className={field} onChange={(event) => { operation.reset(); setOutput(event.target.value as typeof output) }}><option value="text">Texto UTF-8</option><option value="binary">Archivo binario</option></select>
        </LabeledField>}
      </FormatOptions>
      <SourceField label={mode === 'encode' ? 'Texto (UTF-8)' : `Entrada en ${format === 'base64' ? 'Base64' : 'Base64URL'}`} value={source} onChange={(value) => changeBounded(value, MAX_CRYPTO_ENCODED_CHARS, setSource, operation)} />
      <CryptoHelp>Límite de 1 MiB de texto o datos binarios.</CryptoHelp>
      <TaskActions label={mode === 'encode' ? 'Codificar' : 'Decodificar'} busy={operation.busy} error={operation.error}
        onRun={() => void operation.run(convert)} onClear={() => { operation.reset(); setSource('') }} />
    </div>
    <ResultPanel busy={operation.busy}>
      {operation.result?.kind === 'text' && <ResultText title={mode === 'encode' ? 'Texto codificado' : 'Texto decodificado'} value={operation.result.value} fileName="resultado.txt" />}
      {operation.result?.kind === 'binary' && <div className="space-y-2">
        <p className="text-sm text-slate-600">{operation.result.value.byteLength.toLocaleString('es')} bytes listos para descargar.</p>
        <button type="button" className={control} onClick={() => { if (operation.result?.kind === 'binary') download(new Blob([operation.result.value], { type: 'application/octet-stream' }), 'resultado.bin') }}><ArrowDownToLine aria-hidden className="h-4 w-4" />Descargar archivo</button>
      </div>}
    </ResultPanel>
  </div>
}

const areas = [
  { id: 'cipher', label: 'Cifrado', icon: LockKeyhole, Component: CipherPanel },
  { id: 'hash', label: 'Hash y HMAC', icon: Hash, Component: HashPanel },
  { id: 'keys', label: 'Claves', icon: KeyRound, Component: KeyPanel },
  { id: 'base64', label: 'Base64', icon: Binary, Component: Base64Panel },
] as const

export default function CryptoUtility() {
  const session = useUtilityDocument()
  return <DocumentCryptoUtility key={session?.documentId || 'standalone'} />
}

function DocumentCryptoUtility() {
  const documentSession = useUtilityDocument()
  const documentId = documentSession?.documentId || ''
  const [actionsHost, setActionsHost] = useState<HTMLDivElement | null>(null)
  const [showHelp, setShowHelp] = useState(false)
  const [active, setActive] = useUtilityDocumentState<(typeof areas)[number]['id'] | 'vault'>('active', 'cipher')
  const [keyId, setKeyId] = useUtilityDocumentState<string>('key_id', '')
  const keyIdRef = useRef(keyId)
  keyIdRef.current = keyId
  const [savedKey, setSavedKey] = useState<VaultSelection>()
  const [keyNotice, setKeyNotice] = useState('')
  function forgetUnavailableKey(id: string) {
    if (keyIdRef.current !== id) return
    void documentSession?.reconcileVaultDeletion?.(id)
    keyIdRef.current = ''
    setKeyId('')
    setSavedKey(undefined)
    setKeyNotice('La clave guardada ya no está disponible. Puedes elegir otra en Mis claves.')
  }
  const [visited, setVisited] = useState(() => new Set([active]))
  useEffect(() => { setVisited(previous => new Set([...previous, active])) }, [active])
  useEffect(() => {
    if (!keyId || !documentId) { setSavedKey(undefined); return }
    let controller: AbortController | undefined
    function reloadKey() {
      if (keyIdRef.current !== keyId) return
      controller?.abort()
      const current = new AbortController()
      controller = current
      void libraryRequest<{ item: VaultSelection }>(documentVaultPath(documentId, keyId), { signal: current.signal }).then(result => {
        if (current.signal.aborted || keyIdRef.current !== keyId) return
        setSavedKey(result.item.kind === 'rsa' || result.item.kind === 'aes' ? result.item : undefined)
        setKeyNotice('')
      }).catch(async error => {
        if (current.signal.aborted || keyIdRef.current !== keyId) return
        if (!(error instanceof UtilityRequestError) || error.status !== 404) return
        try {
          await libraryRequest<{ item: VaultSelection }>(`/vault/legacy/${encodeURIComponent(keyId)}`, { signal: current.signal })
          if (current.signal.aborted || keyIdRef.current !== keyId) return
          setSavedKey(undefined)
          setKeyNotice('Esta clave pertenece a tu biblioteca anterior. Importa una copia en Mis claves para usarla en este documento.')
        } catch (legacyError) {
          if (current.signal.aborted || keyIdRef.current !== keyId) return
          if (legacyError instanceof UtilityRequestError && legacyError.status === 404) forgetUnavailableKey(keyId)
        }
      })
    }
    reloadKey()
    const release = subscribeWebSocket(message => {
      const event = scopedVaultEvent(message, documentId)
      if (event?.id !== keyId) return
      if (event.kind === 'vault_deleted') { controller?.abort(); forgetUnavailableKey(keyId) }
      else reloadKey()
    })
    return () => { controller?.abort(); release() }
  }, [keyId, documentId])

  return <section aria-label="Criptografía y codificación" className="utility-density-scope flex min-h-0 w-full flex-1 flex-col gap-2">
    <div className="utility-work-toolbar gap-1 border-b border-slate-200">
    <select className={`${field} utility-crypto-select`} aria-label="Herramienta de criptografía" value={active} onChange={event => setActive(event.target.value as typeof active)}>{areas.map(area => <option key={area.id} value={area.id}>{area.label}</option>)}<option value="vault">Mis claves</option></select>
    <div role="group" aria-label="Herramientas de criptografía" className="utility-crypto-tabs flex-1">
      {areas.map(({ id, label, icon: Icon }) => <button type="button" key={id} aria-pressed={active === id} className={active === id ? selectedControl : control} onClick={() => setActive(id)}><Icon className="h-4 w-4" aria-hidden />{label}</button>)}
      <button type="button" aria-pressed={active === 'vault'} className={active === 'vault' ? selectedControl : control} onClick={() => setActive('vault')}><KeyRound aria-hidden className="size-4" />Mis claves</button>
    </div>
    <div ref={setActionsHost} className="flex shrink-0 items-center gap-1" data-crypto-primary-actions />
    <button type="button" className={`${control} shrink-0`} aria-label="Información de criptografía" title="Información y límites" aria-expanded={showHelp} aria-controls="crypto-information" onClick={() => setShowHelp(value => !value)}><Info size={16} aria-hidden /></button>
    </div>
    {keyNotice && <p role="status" className="text-sm text-slate-600">{keyNotice}{keyId && <button type="button" className={`${control} ml-2`} onClick={() => setActive('vault')}>Abrir Mis claves</button>}</p>}
    <CryptoHelpContext.Provider value={showHelp}>
    {areas.map(({ id, Component }) => visited.has(id) && <div key={id} hidden={active !== id} className={active === id ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}><CryptoToolbarContext.Provider value={active === id ? actionsHost : null}>{id === 'cipher' ? <CipherPanel savedKey={savedKey} onKeyUnavailable={forgetUnavailableKey} /> : <Component />}</CryptoToolbarContext.Provider></div>)}
    {active === 'vault' && <CryptoToolbarContext.Provider value={actionsHost}><VaultPanel onDeleted={forgetUnavailableKey} onUse={item => { keyIdRef.current = item.id; setKeyNotice(''); setKeyId(item.id); setSavedKey(item); if (item.kind === 'rsa' || item.kind === 'aes') setActive('cipher') }} /></CryptoToolbarContext.Provider>}
    </CryptoHelpContext.Provider>
    {showHelp && <p id="crypto-information" className="text-xs leading-5 text-slate-500">Se guardan las preferencias y referencias de la hoja. Las contraseñas, entradas de texto criptográficas y resultados descifrados son temporales. Guarda las claves mediante Mis claves.</p>}
  </section>
}
