'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { ArrowDownToLine, ArrowLeft, Braces, Check, Copy, Loader2, Redo2, Undo2 } from 'lucide-react'
import type { JsonEditorHandle, JsonEditorHistory } from './JsonCodeEditor'
import { fitsJsonInput } from './jsonLimits'
import type { JsonMode, JsonOperation, JsonRequest, JsonResult } from './jsonOperations'

const controlBase = 'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border px-3 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 disabled:opacity-40'
const control = `${controlBase} border-slate-200 bg-white text-slate-700 hover:bg-slate-50`
const primary = `${controlBase} border-emerald-700 bg-emerald-700 text-white hover:bg-emerald-800`
const JsonCodeEditor = dynamic(() => import('./JsonCodeEditor'), {
  ssr: false,
  loading: () => <p role="status" className="min-h-64 p-4 text-sm text-slate-500">Abriendo editor…</p>,
})

export default function JsonUtility() {
  const [source, setSource] = useState('')
  const [history, setHistory] = useState<JsonEditorHistory>({ undo: false, redo: false })
  const [mode, setMode] = useState<JsonMode>('strict')
  const [indent, setIndent] = useState<JsonRequest['indent']>('2')
  const [result, setResult] = useState<JsonResult>()
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [inputError, setInputError] = useState('')
  const [outputReady, setOutputReady] = useState(false)
  const inputRef = useRef<JsonEditorHandle>(null)
  const outputRef = useRef<JsonEditorHandle>(null)
  const generation = useRef(0)
  const task = useRef<{ worker: Worker; timeout: number } | null>(null)
  const downloads = useRef(new Map<string, number>())

  const stopTask = useCallback(() => {
    generation.current++
    if (!task.current) return
    window.clearTimeout(task.current.timeout)
    task.current.worker.terminate()
    task.current = null
  }, [])

  useEffect(() => {
    const urls = downloads.current
    return () => {
      stopTask()
      for (const [url, timeout] of urls) {
        window.clearTimeout(timeout)
        URL.revokeObjectURL(url)
      }
      urls.clear()
    }
  }, [stopTask])

  const invalidate = useCallback(() => {
    stopTask()
    setBusy(false)
    setResult(undefined)
    setFeedback('')
    setInputError('')
  }, [stopTask])

  const inputFits = fitsJsonInput(source)

  function updateSource(text: string) {
    invalidate()
    setSource(text)
  }

  function step(direction: 'undo' | 'redo') {
    inputRef.current?.focus()
    inputRef.current?.[direction]()
  }

  function run(operation: JsonOperation) {
    invalidate()
    setBusy(true)
    try {
      const worker = new Worker(new URL('./json.worker.ts', import.meta.url), { type: 'module' })
      const finish = (value: JsonResult) => {
        if (task.current?.worker !== worker) return
        stopTask()
        setResult(value)
        setBusy(false)
      }
      task.current = { worker, timeout: window.setTimeout(() => finish({ ok: false, message: 'El documento tardó demasiado en procesarse. Intenta con una parte más pequeña.' }), 10_000) }
      worker.onmessage = (event: MessageEvent<JsonResult>) => finish(event.data)
      worker.onerror = (event) => {
        event.preventDefault()
        finish({ ok: false, message: 'No se pudo procesar el documento. Puedes reintentar.' })
      }
      worker.postMessage({ operation, source, mode, indent } satisfies JsonRequest)
    } catch {
      stopTask()
      setBusy(false)
      setResult({ ok: false, message: 'No se pudo iniciar el editor de JSON en este navegador.' })
    }
  }

  const output = result?.ok ? result.text : undefined
  const canApply = output !== undefined && output !== source && fitsJsonInput(output)
  const canRun = !busy && !!source && inputFits

  async function copy() {
    if (output === undefined) return
    const current = generation.current
    try {
      await navigator.clipboard.writeText(output)
      if (generation.current === current) setFeedback('Resultado copiado.')
    } catch {
      if (generation.current !== current) return
      outputRef.current?.selectAll()
      setFeedback('El resultado quedó seleccionado. Cópialo con el atajo del teclado o el menú del dispositivo.')
    }
  }

  function download() {
    if (!result?.ok || output === undefined) return
    const type = result.extension === 'json' ? 'application/json' : 'text/plain;charset=utf-8'
    const url = URL.createObjectURL(new Blob([output], { type }))
    const link = document.createElement('a')
    link.href = url
    link.download = `resultado.${result.extension ?? 'txt'}`
    link.click()
    downloads.current.set(url, window.setTimeout(() => {
      URL.revokeObjectURL(url)
      downloads.current.delete(url)
    }, 1000))
  }

  return <section aria-label="Editor de JSON" className="space-y-3">
    <div className="flex flex-wrap items-end gap-2 rounded-2xl border border-slate-200 bg-white p-3">
      <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
        Sintaxis
        <select className={control} value={mode} onChange={(event) => { invalidate(); setMode(event.target.value as JsonMode) }}>
          <option value="strict">JSON estricto</option>
          <option value="jsonc">JSON con comentarios</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
        Sangría
        <select className={control} value={indent} onChange={(event) => { invalidate(); setIndent(event.target.value as JsonRequest['indent']) }}>
          <option value="2">2 espacios</option>
          <option value="4">4 espacios</option>
          <option value="tab">Tabulador</option>
        </select>
      </label>
      <button type="button" disabled={!canRun} onClick={() => run('format')} className={primary}><Braces className="h-4 w-4" aria-hidden />Formatear</button>
      <button type="button" disabled={!canRun} onClick={() => run('validate')} className={control}><Check className="h-4 w-4" aria-hidden />Validar</button>
      <button type="button" disabled={!canRun} onClick={() => run('minify')} className={control}>Compactar</button>
      <button type="button" disabled={!canRun} onClick={() => run('unescape')} className={control}>Desescapar</button>
      <button type="button" disabled={!canRun} onClick={() => run('escape')} className={control}>Escapar</button>
      <button type="button" disabled={!canRun} onClick={() => run('repair')} className={control}>Reparar</button>
      {busy && <button type="button" onClick={invalidate} className={control}>Cancelar</button>}
    </div>
    <div className="grid items-start gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 25rem), 1fr))' }}>
      <div className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="flex min-h-16 flex-wrap items-center gap-1 border-b border-slate-200 bg-slate-50 px-3 py-1.5">
          <h2 className="mr-auto px-1 text-sm font-semibold text-slate-900">Entrada</h2>
          <button type="button" aria-label="Deshacer" title="Deshacer (Ctrl/⌘+Z)" disabled={!history.undo} onClick={() => step('undo')} className={`${control} w-11 px-0`}><Undo2 className="h-4 w-4" aria-hidden /></button>
          <button type="button" aria-label="Rehacer" title="Rehacer (Ctrl/⌘+Mayús+Z)" disabled={!history.redo} onClick={() => step('redo')} className={`${control} w-11 px-0`}><Redo2 className="h-4 w-4" aria-hidden /></button>
          <button type="button" disabled={!source} className={control} onClick={() => { inputRef.current?.replace(''); inputRef.current?.focus() }}>Limpiar</button>
        </div>
        <JsonCodeEditor editorRef={inputRef} label="Entrada JSON" allowComments={mode === 'jsonc'} placeholder="Pega un JSON o una cadena escapada."
          onEdit={updateSource} onHistoryChange={setHistory}
          onLargePaste={() => setInputError('El texto pegado supera el límite de 2 MiB. Se conservó el original.')} />
      </div>
      <div className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white" aria-busy={busy}>
        <div className="flex min-h-16 flex-wrap items-center gap-1 border-b border-slate-200 bg-slate-50 px-3 py-1.5">
          <h2 className="mr-auto px-1 text-sm font-semibold text-slate-900">Resultado</h2>
          <button type="button" disabled={!canApply} className={control} onClick={() => { if (!canApply) return; inputRef.current?.replace(output); inputRef.current?.focus() }}><ArrowLeft className="h-4 w-4" aria-hidden />Usar como entrada</button>
          <button type="button" disabled={output === undefined || !outputReady} className={`${control} w-11 px-0`} aria-label="Copiar resultado" title="Copiar resultado" onClick={() => void copy()}><Copy className="h-4 w-4" aria-hidden /></button>
          <button type="button" disabled={output === undefined} className={`${control} w-11 px-0`} aria-label="Descargar resultado" title="Descargar resultado" onClick={download}><ArrowDownToLine className="h-4 w-4" aria-hidden /></button>
        </div>
        <JsonCodeEditor editorRef={outputRef} label="Resultado JSON" value={output ?? ''} readOnly onReady={() => setOutputReady(true)}
          language={result?.ok && result.extension === 'txt' ? 'plaintext' : 'json'}
          placeholder={busy ? 'Procesando…' : 'Aquí aparecerá el resultado de la operación.'} />
      </div>
    </div>
    <div className="space-y-1 px-1 text-sm" aria-live="polite" aria-atomic="true">
      {busy && <p className="flex items-center gap-2 text-slate-600"><Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden />Procesando documento…</p>}
      {(inputError || !inputFits) && <p className="text-rose-700">{inputError || 'La entrada supera el límite de 2 MiB. Reduce el documento para procesarlo.'}</p>}
      {result && <p className={result.ok ? 'text-slate-700' : 'text-rose-700'}>{result.message}</p>}
      {result?.ok && result.warnings.map((warning) => <p key={warning} className="text-amber-800">{warning}</p>)}
      {output !== undefined && !canApply && output !== source && <p className="text-amber-800">El resultado supera el límite de la entrada. Puedes copiarlo o descargarlo.</p>}
      {feedback && <p className="text-slate-700">{feedback}</p>}
    </div>
    {result?.ok && result.changedSource !== undefined && <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
      <p className="font-semibold">Fragmento original afectado</p>
      {result.changedSource ? <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{result.changedSource}</pre> : <p>La propuesta agrega contenido en el original.</p>}
    </div>}
    <p id="utility-json-help" className="px-1 text-xs text-slate-500">Entrada de hasta 2 MiB. Desescapar quita una capa de una cadena JSON. Reparar prepara una propuesta que puedes revisar y aplicar.</p>
  </section>
}
