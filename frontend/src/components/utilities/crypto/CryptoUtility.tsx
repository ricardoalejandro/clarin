'use client'

import { Children, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ArrowDownToLine, Binary, Copy, Eye, EyeOff, Hash, KeyRound, Loader2, LockKeyhole } from 'lucide-react'
import {
  CryptoInputError, decodeBase64, decodeUtf8, decryptJwe, encodeBase64, encodeHex, encodeUtf8, encryptJwe,
  generateAesKey, generateRsaKeys, hashText, MAX_CRYPTO_ENCODED_CHARS, MAX_CRYPTO_PEM_CHARS,
  type Base64Format, type CipherAlgorithm, type HashAlgorithm,
} from './cryptoOperations'

const controlBase = 'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border px-3 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 disabled:opacity-40'
const control = `${controlBase} border-slate-200 bg-white text-slate-700 hover:bg-slate-50`
const selectedControl = `${controlBase} border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100`
const primary = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-emerald-700 px-4 text-sm font-semibold text-white hover:bg-emerald-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 disabled:opacity-40'
const field = 'min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600'
const textField = `${field} block resize-y py-3 font-mono leading-6`
const panel = 'min-w-0 space-y-4 rounded-2xl border border-slate-200 bg-white p-4'
const pair = 'grid items-start gap-3'

function columns(width: string) {
  return { gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${width}), 1fr))` }
}

function useOperation<T>() {
  const generation = useRef(0)
  const [result, setResult] = useState<T>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => () => { generation.current++ }, [])

  function reset() {
    generation.current++
    setResult(undefined)
    setError('')
    setBusy(false)
  }

  function inputError(message: string) {
    reset()
    setError(message)
  }

  async function run(work: () => T | Promise<T>) {
    const current = ++generation.current
    setResult(undefined)
    setError('')
    setBusy(true)
    try {
      const value = await work()
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

function SourceField({ label, value, onChange, rows = 7 }: { label: string; value: string; onChange: (value: string) => void; rows?: number }) {
  return <LabeledField label={label}>
    <textarea rows={rows} value={value} className={`${textField} font-normal`} onChange={(event) => onChange(event.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} />
  </LabeledField>
}

function TaskActions({ label, busy, disabled, onRun, onClear, error }: { label: string; busy: boolean; disabled?: boolean; onRun: () => void; onClear: () => void; error: string }) {
  return <>
    <div className="flex flex-wrap gap-2">
      <button type="button" disabled={disabled || busy} className={primary} onClick={onRun}>{busy && <Loader2 aria-hidden className="h-4 w-4 motion-safe:animate-spin" />}{busy ? 'Procesando…' : label}</button>
      <button type="button" className={control} onClick={onClear}>{busy ? 'Cancelar' : 'Limpiar'}</button>
    </div>
    <div className="text-sm" aria-live="polite" aria-atomic="true">{error && <p className="text-rose-700">{error}</p>}{busy && <p className="sr-only">Operación en curso</p>}</div>
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

  return <div className="space-y-2">
    {shown ? <label className="text-sm font-semibold text-slate-900" htmlFor={id}>{title}</label> : <p className="text-sm font-semibold text-slate-900">{title}</p>}
    {shown && <textarea id={id} rows={4} readOnly ref={output} className={textField} value={value} spellCheck={false} placeholder="Resultado vacío" />}
    {!shown && <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">La clave está oculta.</p>}
    <div className="flex flex-wrap gap-2">
      {secret && <button type="button" className={control} onClick={() => setShown(!shown)}>{shown ? <EyeOff aria-hidden className="h-4 w-4" /> : <Eye aria-hidden className="h-4 w-4" />}{shown ? 'Ocultar clave' : 'Mostrar clave'}</button>}
      <button type="button" className={control} onClick={() => void copy()} aria-label={`Copiar ${title.toLowerCase()}`}><Copy aria-hidden className="h-4 w-4" />Copiar</button>
      <button type="button" className={control} onClick={() => download(new Blob([value], { type: 'text/plain;charset=utf-8' }), fileName)} aria-label={`Descargar ${title.toLowerCase()}`}><ArrowDownToLine aria-hidden className="h-4 w-4" />Descargar</button>
    </div>
    <p aria-live="polite" className="text-sm text-slate-600">{message}</p>
  </div>
}

function ResultPanel({ children, busy }: { children?: ReactNode; busy: boolean }) {
  const hasResult = Children.toArray(children).length > 0
  return <div className={panel} aria-busy={busy}>
    <h3 className="text-sm font-semibold text-slate-900">Resultado</h3>
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

function CipherPanel() {
  const [mode, setMode] = useState<'encrypt' | 'decrypt'>('encrypt')
  const [algorithm, setAlgorithm] = useState<CipherAlgorithm>('aes256')
  const [source, setSource] = useState('')
  const [key, setKey] = useState('')
  const operation = useOperation<string>()
  const encrypting = mode === 'encrypt'
  const rsa = algorithm === 'rsa'
  const updateKey = (value: string) => changeBounded(value, rsa ? MAX_CRYPTO_PEM_CHARS : 256, setKey, operation)

  return <div className={pair} style={columns('24rem')}>
    <div className={panel}>
      <div className="grid gap-3" style={columns('11rem')}>
        <LabeledField label="Operación">
          <select value={mode} className={field} onChange={(event) => { operation.reset(); setMode(event.target.value as typeof mode); if (rsa) setKey('') }}>
            <option value="encrypt">Cifrar texto</option><option value="decrypt">Descifrar JWE</option>
          </select>
        </LabeledField>
        <LabeledField label="Algoritmo">
          <select value={algorithm} className={field} onChange={(event) => { operation.reset(); setKey(''); setAlgorithm(event.target.value as CipherAlgorithm) }}>
            <option value="aes128">AES-128-GCM</option><option value="aes256">AES-256-GCM</option><option value="rsa">RSA híbrido</option>
          </select>
        </LabeledField>
      </div>
      <SourceField label={encrypting ? 'Texto para cifrar (UTF-8)' : 'JWE compacto'} value={source} onChange={(value) => changeBounded(value, MAX_CRYPTO_ENCODED_CHARS, setSource, operation)} />
      {rsa
        ? <SourceField rows={4} label={encrypting ? 'Clave pública RSA (PEM SPKI)' : 'Clave privada RSA (PEM PKCS#8)'} value={key} onChange={updateKey} />
        : <LabeledField label={`Clave AES de ${algorithm === 'aes128' ? '128' : '256'} bits (Base64)`}><input type="password" autoComplete="off" value={key} className={`${field} font-mono font-normal`} onChange={(event) => updateKey(event.target.value)} /></LabeledField>}
      <p className="text-xs text-slate-600">Formato JWE compacto. {rsa ? 'RSA-OAEP-256 protege una clave nueva de AES-256-GCM en cada operación.' : 'La clave Base64 puede generarse en Claves.'} Límite de texto de 1 MiB.</p>
      <TaskActions label={encrypting ? 'Cifrar' : 'Descifrar'} busy={operation.busy} error={operation.error} disabled={!key.trim() || (!encrypting && !source.trim())}
        onRun={() => void operation.run(() => encrypting ? encryptJwe(source, algorithm, key) : decryptJwe(source, algorithm, key))}
        onClear={() => { operation.reset(); if (!operation.busy) { setSource(''); setKey('') } }} />
    </div>
    <ResultPanel busy={operation.busy}>{operation.result !== undefined && <ResultText title={encrypting ? 'JWE cifrado' : 'Texto descifrado'} value={operation.result} fileName={encrypting ? 'resultado.jwe' : 'resultado.txt'} />}</ResultPanel>
  </div>
}

function HashPanel() {
  const [mode, setMode] = useState<'hash' | 'hmac'>('hash')
  const [algorithm, setAlgorithm] = useState<HashAlgorithm>('SHA-256')
  const [format, setFormat] = useState<'hex' | 'base64'>('hex')
  const [keyFormat, setKeyFormat] = useState<'utf8' | 'base64'>('utf8')
  const [source, setSource] = useState('')
  const [key, setKey] = useState('')
  const operation = useOperation<Uint8Array>()

  return <div className={pair} style={columns('24rem')}>
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
        <LabeledField label="Formato de clave">
          <select value={keyFormat} className={field} onChange={(event) => { operation.reset(); setKey(''); setKeyFormat(event.target.value as typeof keyFormat) }}>
            <option value="utf8">Texto UTF-8</option><option value="base64">Base64</option>
          </select>
        </LabeledField>
        <LabeledField label="Clave HMAC"><input type="password" autoComplete="off" value={key} className={`${field} font-mono font-normal`} onChange={(event) => changeBounded(event.target.value, 24 * 1024, setKey, operation)} /></LabeledField>
      </div>}
      <p className="text-xs text-slate-600">{mode === 'hash' ? 'Calcula una huella del texto, incluso si está vacío.' : 'Calcula una huella de autenticación a partir de una clave secreta.'} Límite de texto de 1 MiB.</p>
      <TaskActions label={mode === 'hash' ? 'Calcular hash' : 'Calcular HMAC'} busy={operation.busy} error={operation.error} disabled={mode === 'hmac' && !key.length}
        onRun={() => void operation.run(() => hashText(source, algorithm, mode === 'hmac' ? { value: key, format: keyFormat } : undefined))}
        onClear={() => { operation.reset(); if (!operation.busy) { setSource(''); setKey('') } }} />
    </div>
    <ResultPanel busy={operation.busy}>{operation.result && <>
      <LabeledField label="Formato del resultado">
        <select className={field} value={format} onChange={(event) => setFormat(event.target.value as typeof format)}><option value="hex">Hexadecimal</option><option value="base64">Base64</option></select>
      </LabeledField>
      <ResultText key={format} title={mode === 'hash' ? 'Huella' : 'Código HMAC'} value={format === 'hex' ? encodeHex(operation.result) : encodeBase64(operation.result, 'base64')} fileName={mode === 'hash' ? 'hash.txt' : 'hmac.txt'} />
    </>}</ResultPanel>
  </div>
}

type GeneratedKeys = { kind: 'aes'; key: string } | { kind: 'rsa'; publicKey: string; privateKey: string }

function KeyPanel() {
  const [mode, setMode] = useState<'aes' | 'rsa'>('aes')
  const [aesLength, setAesLength] = useState<128 | 256>(256)
  const [rsaLength, setRsaLength] = useState<2048 | 3072>(3072)
  const operation = useOperation<GeneratedKeys>()

  return <div className={pair} style={columns('24rem')}>
    <div className={panel}>
      <LabeledField label="Tipo de clave">
        <select value={mode} className={field} onChange={(event) => { operation.reset(); setMode(event.target.value as typeof mode) }}><option value="aes">AES-GCM</option><option value="rsa">RSA-OAEP-256</option></select>
      </LabeledField>
      {mode === 'aes' ? <LabeledField label="Tamaño">
        <select value={aesLength} className={field} onChange={(event) => { operation.reset(); setAesLength(Number(event.target.value) as typeof aesLength) }}><option value="128">128 bits</option><option value="256">256 bits</option></select>
      </LabeledField> : <LabeledField label="Tamaño">
        <select value={rsaLength} className={field} onChange={(event) => { operation.reset(); setRsaLength(Number(event.target.value) as typeof rsaLength) }}><option value="2048">2048 bits</option><option value="3072">3072 bits</option></select>
      </LabeledField>}
      <p className="text-xs text-slate-600">{mode === 'aes' ? 'Genera una clave secreta en Base64.' : 'Genera una clave pública SPKI y una clave privada PKCS#8 en PEM.'} Guarda la clave secreta o privada en un lugar seguro si necesitas usarla después.</p>
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
  const [mode, setMode] = useState<'encode' | 'decode'>('encode')
  const [format, setFormat] = useState<Base64Format>('base64')
  const [output, setOutput] = useState<'text' | 'binary'>('text')
  const [source, setSource] = useState('')
  const operation = useOperation<Base64Result>()
  const download = useDownload()

  function convert(): Base64Result {
    if (mode === 'encode') return { kind: 'text', value: encodeBase64(encodeUtf8(source), format) }
    const bytes = decodeBase64(source, format)
    return output === 'text' ? { kind: 'text', value: decodeUtf8(bytes) } : { kind: 'binary', value: bytes }
  }

  return <div className={pair} style={columns('24rem')}>
    <div className={panel}>
      <div className="grid gap-3" style={columns('10rem')}>
        <LabeledField label="Operación">
          <select value={mode} className={field} onChange={(event) => { operation.reset(); setMode(event.target.value as typeof mode) }}><option value="encode">Codificar</option><option value="decode">Decodificar</option></select>
        </LabeledField>
        <LabeledField label="Formato">
          <select value={format} className={field} onChange={(event) => { operation.reset(); setFormat(event.target.value as Base64Format) }}><option value="base64">Base64</option><option value="base64url">Base64URL</option></select>
        </LabeledField>
        {mode === 'decode' && <LabeledField label="Salida">
          <select value={output} className={field} onChange={(event) => { operation.reset(); setOutput(event.target.value as typeof output) }}><option value="text">Texto UTF-8</option><option value="binary">Archivo binario</option></select>
        </LabeledField>}
      </div>
      <SourceField label={mode === 'encode' ? 'Texto (UTF-8)' : `Entrada en ${format === 'base64' ? 'Base64' : 'Base64URL'}`} value={source} onChange={(value) => changeBounded(value, MAX_CRYPTO_ENCODED_CHARS, setSource, operation)} />
      <p className="text-xs text-slate-600">Límite de 1 MiB de texto o datos binarios.</p>
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
  const [active, setActive] = useState<(typeof areas)[number]['id']>('cipher')
  const Component = areas.find(({ id }) => id === active)?.Component ?? CipherPanel

  return <section aria-label="Criptografía y codificación" className="space-y-3">
    <div role="group" aria-label="Herramientas de criptografía" className="flex flex-wrap gap-2 rounded-2xl border border-slate-200 bg-white p-3">
      {areas.map(({ id, label, icon: Icon }) => <button type="button" key={id} aria-pressed={active === id} className={active === id ? selectedControl : control} onClick={() => setActive(id)}><Icon className="h-4 w-4" aria-hidden />{label}</button>)}
    </div>
    <Component />
  </section>
}
