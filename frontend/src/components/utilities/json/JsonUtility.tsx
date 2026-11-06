'use client'

import { useEffect, useLayoutEffect, useRef, useState, type ComponentPropsWithRef, type MouseEvent, type ReactNode } from 'react'
import {
  ArrowDownToLine, Braces, Check, ChevronLeft, ChevronRight, Copy, Ellipsis, FileUp, GitCompare,
  Loader2, PanelRightOpen, Redo2, Settings2, Shrink, Sparkles, Undo2, X,
} from 'lucide-react'
import { editor } from 'monaco-editor'
import { DocumentCodeEditor, DocumentDiff, registerDocumentCompletions, type DiffDocument } from './JsonCodeEditor'
import {
  adjustFont, canCompare, DEFAULT_FONT, DIFF_LIMIT, LARGE_DOCUMENT, LONG_LINE, otherPanel,
  PANEL_BREAKPOINT, repairPreview, TRAM_LENGTH, visiblePanels, type DocumentFormat, type Panel,
} from './editorWorkspaceState'
import { useEditorDocuments, type DocumentSnapshot } from './useEditorDocuments'
import { getXmlDeclaredEncoding, JSON_INPUT_LIMIT, JSON_REPAIR_LIMIT, measureDocument } from './jsonLimits'
import type { DocumentWorkerRequest, DocumentWorkerResponse, JsonOperation, JsonRequest } from './jsonOperations'

const button = 'inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium text-[var(--editor-ink)] outline-none hover:bg-[var(--editor-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500 disabled:opacity-40 pointer-fine:min-h-8'
const select = 'min-h-11 rounded-md border border-[var(--editor-border)] bg-[var(--editor-bar)] px-2 text-xs text-[var(--editor-ink)] pointer-fine:min-h-8'
const menuClass = 'fixed inset-auto m-0 max-h-[calc(100dvh-1rem)] w-64 max-w-[calc(100vw-1rem)] overflow-auto rounded-lg border border-[var(--editor-border)] bg-[var(--editor-bar)] p-2 text-[var(--editor-ink)] shadow-xl'
const panels: Panel[] = ['a', 'b']

function Action({ label, children, ...props }: ComponentPropsWithRef<'button'> & { label: string; children: ReactNode }) {
  return <button {...props} type="button" className={`${button} ${props.className ?? ''}`} aria-label={label} title={label}>{children}</button>
}

function positionMenu(event: MouseEvent<HTMLButtonElement>, menu: HTMLDivElement | null) {
  if (!menu) return
  if (menu.matches(':popover-open')) {
    return
  }
  const trigger = event.currentTarget.getBoundingClientRect()
  const viewport = window.visualViewport
  const left = viewport?.offsetLeft ?? 0
  const top = viewport?.offsetTop ?? 0
  const right = left + (viewport?.width ?? window.innerWidth)
  const bottom = top + (viewport?.height ?? window.innerHeight)
  menu.style.maxWidth = `${right - left - 16}px`
  menu.style.maxHeight = `${bottom - top - 16}px`
  menu.style.left = `${Math.max(left + 8, Math.min(trigger.right - 256, right - 264))}px`
  menu.style.top = `${top + 8}px`
  requestAnimationFrame(() => {
    const height = menu.getBoundingClientRect().height
    menu.style.top = `${Math.max(top + 8, Math.min(trigger.bottom + 4, bottom - height - 8))}px`
  })
}

interface Notice { message: string; error?: boolean; warnings?: string[] }
interface ProposedEdit extends DocumentSnapshot { before: string; after: string; revision: number }
interface Work { panel: Panel; worker: Worker; timer: number }

export default function JsonUtility() {
  const host = useRef<HTMLElement>(null)
  const preferences = useRef<HTMLDivElement>(null)
  const secondary = useRef<HTMLDivElement>(null)
  const compareButton = useRef<HTMLButtonElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const fileTarget = useRef<Panel>('a')
  const task = useRef<Work | null>(null)
  const urls = useRef(new Map<string, number>())
  const alive = useRef(false)
  const [width, setWidth] = useState(0)
  const [split, setSplit] = useState(false)
  const [active, setActive] = useState<Panel>('a')
  const [dark, setDark] = useState(true)
  const [font, setFont] = useState(DEFAULT_FONT)
  const [indent, setIndent] = useState<JsonRequest['indent']>('2')
  const [structuralXml, setStructuralXml] = useState(false)
  const [formats, setFormats] = useState<Record<Panel, DocumentFormat>>({ a: 'strict', b: 'strict' })
  const [signedXml, setSignedXml] = useState<Partial<Record<Panel, boolean>>>({})
  const [chunks, setChunks] = useState<Record<Panel, number>>({ a: 0, b: 0 })
  const [notices, setNotices] = useState<Partial<Record<Panel, Notice>>>({})
  const [proposal, setProposal] = useState<Partial<Record<Panel, ProposedEdit>>>({})
  const [oversized, setOversized] = useState<Partial<Record<Panel, { source: string; extension: string }>>>({})
  const [busy, setBusy] = useState<Panel | null>(null)
  const [diff, setDiff] = useState<readonly [DiffDocument, DiffDocument]>()
  const [diffStatus, setDiffStatus] = useState('')
  const wide = width >= PANEL_BREAKPOINT
  const visible = visiblePanels(active, split, width)

  function stop() {
    if (!task.current) return
    window.clearTimeout(task.current.timer)
    task.current.worker.terminate()
    task.current = null
  }

  const documents = useEditorDocuments((panel, formatHint) => {
    if (task.current?.panel === panel) {
      stop()
      setBusy(null)
    }
    setNotices(current => ({ ...current, [panel]: undefined }))
    setProposal(current => ({ ...current, [panel]: undefined }))
    setOversized(current => ({ ...current, [panel]: undefined }))
    setSignedXml(current => current[panel] ? { ...current, [panel]: undefined } : current)
    if (formatHint) setFormats(current => current[panel] === formatHint ? current : { ...current, [panel]: formatHint })
    setChunks(current => current[panel] ? { ...current, [panel]: 0 } : current)
  })
  const { states, models, runtimes } = documents
  const state = states[active]
  const format = formats[active]
  const pendingRepair = proposal[active]
  const pendingDownload = oversized[active]
  const activeNotice = notices[active]
  const working = busy !== null
  const canRun = Boolean(state.length && !working && !diff)
  const canTransform = canRun && !(format === 'xml' && signedXml[active])
  const selectClass = dark ? `${select} dark-input` : select

  useLayoutEffect(() => {
    const element = host.current
    if (!element) return
    let measuredWidth = element.clientWidth
    const closeMenus = () => {
      for (const menu of [preferences.current, secondary.current]) {
        if (menu?.matches(':popover-open')) menu.hidePopover()
      }
    }
    const observer = new ResizeObserver(([entry]) => {
      if (Math.abs(measuredWidth - entry.contentRect.width) >= 1) closeMenus()
      measuredWidth = entry.contentRect.width
      setWidth(measuredWidth)
    })
    observer.observe(element)
    setWidth(measuredWidth)
    const viewport = window.visualViewport
    window.addEventListener('resize', closeMenus)
    viewport?.addEventListener('resize', closeMenus)
    viewport?.addEventListener('scroll', closeMenus)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', closeMenus)
      viewport?.removeEventListener('resize', closeMenus)
      viewport?.removeEventListener('scroll', closeMenus)
    }
  }, [])

  useLayoutEffect(() => { editor.setTheme(dark ? 'vs-dark' : 'vs') }, [dark])
  useLayoutEffect(registerDocumentCompletions, [])
  useLayoutEffect(() => {
    for (const panel of panels) documents.syncLanguage(panel, formats[panel], states[panel].reduced || states[panel].plainText)
  })

  useEffect(() => {
    alive.current = true
    const downloads = urls.current
    return () => {
      alive.current = false
      stop()
      for (const [url, timer] of downloads) {
        window.clearTimeout(timer)
        URL.revokeObjectURL(url)
      }
      downloads.clear()
    }
  }, [])

  function announce(panel: Panel, message: string, error = false, warnings?: string[]) {
    setNotices(current => ({ ...current, [panel]: { message, error, warnings } }))
  }

  function launch(panel: Panel, request: DocumentWorkerRequest, receive: (response: DocumentWorkerResponse) => void) {
    if (task.current) return false
    const model = runtimes.current[panel]?.model
    if (!model) return false
    const revision = model.getVersionId()
    setBusy(panel)
    try {
      const worker = new Worker(new URL('./json.worker.ts', import.meta.url), { type: 'module' })
      const finish = (callback: () => void) => {
        if (task.current?.worker !== worker) return
        stop()
        setBusy(null)
        if (model.getVersionId() === revision) callback()
      }
      const bytes = request.kind === 'read-file' ? request.file.size : request.source.length
      task.current = { panel, worker, timer: window.setTimeout(() => {
        finish(() => announce(panel, 'El documento tardó demasiado. Puedes reintentar o procesar una parte más pequeña.', true))
      }, bytes >= LARGE_DOCUMENT ? 60_000 : 30_000) }
      worker.onmessage = (event: MessageEvent<DocumentWorkerResponse>) => finish(() => receive(event.data))
      worker.onerror = event => {
        event.preventDefault()
        finish(() => announce(panel, 'No se pudo procesar el documento. Puedes reintentar.', true))
      }
      worker.postMessage(request)
      return true
    } catch {
      stop()
      setBusy(null)
      announce(panel, 'No se pudo iniciar el procesamiento local.', true)
      return false
    }
  }

  function run(operation: JsonOperation) {
    const panel = active
    const source = documents.source(panel)
    const revision = states[panel].revision
    if (!source || task.current) return
    if (operation === 'repair' && source.length > JSON_REPAIR_LIMIT) {
      announce(panel, 'Reparar admite documentos de hasta 2 MiB.', true)
      return
    }
    setProposal(current => ({ ...current, [panel]: undefined }))
    setOversized(current => ({ ...current, [panel]: undefined }))
    announce(panel, '')
    runtimes.current[panel]?.view?.focus()
    launch(panel, {
      kind: 'transform', operation, source, mode: format === 'jsonc' ? 'jsonc' : 'strict', indent,
      language: format === 'xml' ? 'xml' : 'json', xmlSpacing: structuralXml ? 'structure' : 'safe',
    }, response => {
      if (response.kind !== 'transform') return
      const result = response.result
      if (result.xmlSigned) setSignedXml(current => ({ ...current, [panel]: true }))
      if (!result.ok) {
        if (result.line && result.column) documents.mark(panel, result.line, result.column, result.message)
        announce(panel, result.message, true)
        return
      }
      if (result.text !== undefined && result.metrics && result.text !== source) {
        const snapshot = { source: result.text, metrics: result.metrics, plainText: result.extension === 'txt' }
        if (result.metrics.bytes > JSON_INPUT_LIMIT) {
          setOversized(current => ({ ...current, [panel]: { source: result.text!, extension: result.extension ?? 'txt' } }))
          announce(panel, 'El resultado supera 25 MiB. Puedes descargarlo y conservar el documento abierto.', false, result.warnings)
          return
        }
        if (operation === 'repair') {
          const preview = repairPreview(source, result.text)
          setProposal(current => ({ ...current, [panel]: { ...snapshot, ...preview, revision } }))
        } else {
          documents.replace(panel, snapshot)
        }
      }
      announce(panel, result.message, false, result.warnings)
    })
  }

  function paste(panel: Panel, event: ClipboardEvent, start: number, end: number) {
    const text = event.clipboardData?.getData('text/plain')
    if (!text) return
    const model = models[panel]
    if (!model) return
    const length = model.getValueLength()
    const entire = start === 0 && end === length
    const projected = length - (end - start) + text.length
    if (!entire && text.length <= LONG_LINE && projected * 3 <= JSON_INPUT_LIMIT) return
    event.preventDefault()
    event.stopPropagation()
    if (projected > JSON_INPUT_LIMIT) {
      announce(panel, 'El texto pegado supera 25 MiB. Se conservó el documento.', true)
      return
    }
    if (task.current) {
      stop()
      setBusy(null)
    }
    const original = entire ? '' : model.getValue()
    const source = entire ? text : original.slice(0, start) + text + original.slice(end)
    const apply = (metrics: DocumentSnapshot['metrics']) => {
      if (metrics.bytes > JSON_INPUT_LIMIT) {
        announce(panel, 'El texto pegado supera 25 MiB. Se conservó el documento.', true)
        return
      }
      documents.replace(panel, { source, metrics })
    }
    if (source.length <= LONG_LINE) apply(measureDocument(source))
    else launch(panel, { kind: 'measure', source }, response => {
      if (response.kind === 'measure') apply(response.metrics)
    })
  }

  function openFile(file: File | undefined) {
    const panel = fileTarget.current
    if (!file) return
    if (file.size > JSON_INPUT_LIMIT) {
      announce(panel, 'El archivo supera 25 MiB. Se conservó el documento abierto.', true)
      return
    }
    launch(panel, { kind: 'read-file', file }, response => {
      if (response.kind !== 'read-file') return
      const { result } = response
      if (!result.ok) {
        announce(panel, result.message, true)
        return
      }
      documents.replace(panel, { ...result, formatHint: result.syntaxHint }, formats[panel])
      if (result.syntaxHint) setFormats(current => ({ ...current, [panel]: result.syntaxHint! }))
      announce(panel, 'Archivo local abierto.')
    })
  }

  function selectFormat(next: DocumentFormat) {
    setFormats(current => ({ ...current, [active]: next }))
    documents.setFormat(active, next)
    setProposal(current => ({ ...current, [active]: undefined }))
    setOversized(current => ({ ...current, [active]: undefined }))
    editor.setModelMarkers(models[active]!, 'clarin-document', [])
    announce(active, '')
  }

  function startComparison() {
    const a = models.a
    const b = models.b
    if (!a || !b || !states.a.length || !states.b.length) {
      announce(active, 'Agrega texto a los dos paneles para comparar.')
      return
    }
    if (states.a.huge || states.b.huge || a.getValueLength() > DIFF_LIMIT || b.getValueLength() > DIFF_LIMIT) {
      announce(active, 'La comparación admite hasta 5 MiB y 100.000 líneas por documento, sin líneas gigantes.', true)
      return
    }
    const left = documents.source('a')
    const right = documents.source('b')
    if (!canCompare([measureDocument(left), measureDocument(right)])) {
      announce(active, 'La comparación admite hasta 5 MiB y 100.000 líneas por documento, sin líneas gigantes.', true)
      return
    }
    setDiffStatus('Calculando diferencias…')
    setDiff([{ source: left, language: a.getLanguageId() }, { source: right, language: b.getLanguageId() }])
  }

  function closeComparison() {
    setDiff(undefined)
    requestAnimationFrame(() => compareButton.current?.focus())
  }

  function reveal() {
    documents.ensure(otherPanel(active))
    setSplit(true)
  }

  function hide(panel: Panel) {
    const remaining = otherPanel(panel)
    setActive(remaining)
    setSplit(false)
    requestAnimationFrame(() => runtimes.current[remaining]?.view?.focus())
  }

  async function copy() {
    const panel = active
    const model = models[panel]
    const revision = model?.getVersionId()
    try {
      await navigator.clipboard.writeText(documents.source(panel))
      if (alive.current && model?.getVersionId() === revision) announce(panel, 'Documento copiado.')
    } catch {
      if (alive.current && model?.getVersionId() === revision) announce(panel, 'El navegador no permitió copiar. Usa la selección del editor o descarga el documento.', true)
    }
  }

  function download(source: string, extension: string) {
    if (extension === 'xml') {
      const encoding = getXmlDeclaredEncoding(source)
      if (encoding && !/^utf-8$/i.test(encoding)) {
        announce(active, `El XML declara ${encoding}. Cambia la declaración a UTF-8 antes de descargar o copia el texto.`, true)
        return
      }
    }
    const type = extension === 'xml' ? 'application/xml' : extension === 'json' ? 'application/json' : 'text/plain'
    const url = URL.createObjectURL(new Blob([source], { type: `${type};charset=utf-8` }))
    const link = document.createElement('a')
    link.href = url
    link.download = `documento-${active}.${extension}`
    link.click()
    urls.current.set(url, window.setTimeout(() => {
      URL.revokeObjectURL(url)
      urls.current.delete(url)
    }, 1000))
  }

  const zoom = (delta: number) => setFont(current => adjustFont(current, delta))
  const history = (direction: 'undo' | 'redo') => {
    const runtime = runtimes.current[active]
    void runtime?.model[direction]()
    runtime?.view?.focus()
  }

  return (
    <section ref={host} aria-label="Editor de documentos" data-editor-theme={dark ? 'dark' : 'light'}
      className="flex min-h-64 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--editor-canvas)] text-[var(--editor-ink)] [color-scheme:light] [--editor-bar:#f8fafc] [--editor-border:#cbd5e1] [--editor-canvas:#fff] [--editor-hover:#e2e8f0] [--editor-ink:#1e293b] [--editor-muted:#475569] data-[editor-theme=dark]:[color-scheme:dark] data-[editor-theme=dark]:[--editor-bar:#252526] data-[editor-theme=dark]:[--editor-border:#424248] data-[editor-theme=dark]:[--editor-canvas:#1e1e1e] data-[editor-theme=dark]:[--editor-hover:#3a3d41] data-[editor-theme=dark]:[--editor-ink:#e2e8f0] data-[editor-theme=dark]:[--editor-muted:#a9b4c3]">
      <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-1 border-b border-[var(--editor-border)] bg-[var(--editor-bar)] px-1 py-0.5">
        {diff ? (
          <Action label="Volver a editar" onClick={closeComparison}><ChevronLeft size={15} aria-hidden /> Volver a editar</Action>
        ) : <>
          <div className="flex items-center gap-0.5" aria-label="Operaciones del panel activo">
            <select aria-label="Formato del documento" className={selectClass} value={format} disabled={working} onChange={event => selectFormat(event.target.value as DocumentFormat)}>
              <option value="strict">JSON</option>
              <option value="jsonc">JSONC</option>
              <option value="xml">XML</option>
            </select>
            <Action label="Formatear" disabled={!canTransform} onClick={() => run('format')} className="text-emerald-700 data-[theme=dark]:text-emerald-300" data-theme={dark ? 'dark' : 'light'}><Braces size={15} aria-hidden /><span className="hidden sm:inline">Formatear</span></Action>
            {format !== 'xml' && <Action label="Formato inteligente" disabled={!canRun} onClick={() => run('smart')}><Sparkles size={15} aria-hidden /></Action>}
            <Action label="Compactar" disabled={!canTransform} onClick={() => run('minify')}><Shrink size={15} aria-hidden /></Action>
            <Action label="Validar" disabled={!canRun} onClick={() => run('validate')}><Check size={15} aria-hidden /></Action>
          </div>
          <div className="flex items-center gap-0.5 border-l border-[var(--editor-border)] pl-1">
            <Action label="Deshacer" disabled={!state.undo} onClick={() => history('undo')}><Undo2 size={15} aria-hidden /></Action>
            <Action label="Rehacer" disabled={!state.redo} onClick={() => history('redo')}><Redo2 size={15} aria-hidden /></Action>
            <Action label="Abrir archivo" disabled={working} onClick={() => { fileTarget.current = active; fileInput.current?.click() }}><FileUp size={15} aria-hidden /></Action>
            <input ref={fileInput} aria-label="Abrir archivo local" type="file" accept=".json,.jsonc,.xml,.txt,application/json,application/xml,text/xml,text/plain" hidden
              onChange={event => { openFile(event.currentTarget.files?.[0]); event.currentTarget.value = '' }} />
            <Action label="Más acciones del documento" popoverTarget="document-actions" onClick={event => positionMenu(event, secondary.current)}><Ellipsis size={16} aria-hidden /></Action>
            <div id="document-actions" ref={secondary} popover="auto" className={menuClass} onClick={event => { if (event.target instanceof Element && event.target.closest('button')) secondary.current?.hidePopover?.() }}>
              <div className="grid gap-0.5">
                <Action label="Copiar documento" disabled={!state.length} onClick={() => void copy()}><Copy size={14} aria-hidden /> Copiar documento</Action>
                <Action label="Descargar documento" disabled={!state.length} onClick={() => download(documents.source(active), state.plainText ? 'txt' : format === 'strict' ? 'json' : format)}><ArrowDownToLine size={14} aria-hidden /> Descargar documento</Action>
                {format !== 'xml' && <>
                  <Action label="Reparar" disabled={!canRun} onClick={() => run('repair')}>Reparar</Action>
                  <Action label="Escapar" disabled={!canRun} onClick={() => run('escape')}>Escapar</Action>
                  <Action label="Desescapar" disabled={!canRun} onClick={() => run('unescape')}>Desescapar</Action>
                </>}
                <Action label="Limpiar documento" disabled={!state.length} onClick={() => documents.replace(active, { source: '', metrics: measureDocument('') })}>Limpiar documento</Action>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-0.5 border-l border-[var(--editor-border)] pl-1">
            {split ? <>
              <Action ref={compareButton} label="Comparar diferencias" disabled={working} onClick={startComparison}><GitCompare size={15} aria-hidden /><span className="hidden lg:inline">Comparar</span></Action>
              {!wide && <Action label={`Ocultar panel ${active.toUpperCase()}`} onClick={() => hide(active)}><X size={15} aria-hidden /></Action>}
            </> : <Action label="Mostrar segundo panel" onClick={reveal}><PanelRightOpen size={15} aria-hidden /><span className="hidden lg:inline">Dos paneles</span></Action>}
          </div>
        </>}
        <div className="ml-auto flex items-center">
          <Action label="Preferencias del editor" popoverTarget="document-preferences" onClick={event => positionMenu(event, preferences.current)}><Settings2 size={16} aria-hidden /></Action>
          <div id="document-preferences" ref={preferences} popover="auto" className={menuClass}>
            <div className="grid gap-2 p-1">
              <label className="grid gap-1 text-xs">Tema<select aria-label="Tema" className={selectClass} value={dark ? 'dark' : 'light'} onChange={event => setDark(event.target.value === 'dark')}><option value="dark">Oscuro</option><option value="light">Claro</option></select></label>
              <label className="grid gap-1 text-xs">Sangría<select aria-label="Sangría" className={selectClass} value={indent} disabled={working} onChange={event => setIndent(event.target.value as JsonRequest['indent'])}><option value="2">2 espacios</option><option value="4">4 espacios</option><option value="tab">Tabulador</option></select></label>
              <p className="text-xs text-[var(--editor-muted)]">Desplazamiento visual por cada nivel. Cuatro espacios separan más los niveles.</p>
              {format === 'xml' && <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={structuralXml} disabled={working} onChange={event => setStructuralXml(event.target.checked)} /> Ajustar espacios entre etiquetas</label>}
              <div className="flex items-center justify-between border-t border-[var(--editor-border)] pt-1">
                <Action label="Reducir letra" onClick={() => zoom(-1)}>A−</Action>
                <Action label="Restablecer tamaño de letra" onClick={() => setFont(DEFAULT_FONT)}>{font} px</Action>
                <Action label="Aumentar letra" onClick={() => zoom(1)}>A+</Action>
              </div>
            </div>
          </div>
        </div>
      </div>
      {split && !wide && !diff && <div className="flex shrink-0 gap-1 border-b border-[var(--editor-border)] bg-[var(--editor-bar)] px-1" role="group" aria-label="Documento visible">
        {panels.map(panel => <Action key={panel} label={`Ver documento ${panel.toUpperCase()}`} aria-pressed={active === panel} onClick={() => setActive(panel)} className="aria-pressed:bg-[var(--editor-hover)]">{`Documento ${panel.toUpperCase()}`}</Action>)}
      </div>}
      <div className={`${diff ? 'hidden' : 'flex'} min-h-0 min-w-0 flex-1 gap-px bg-[var(--editor-border)]`}>
        {panels.map(panel => {
          const model = models[panel]
          if (!model) return null
          const shown = !diff && visible.includes(panel)
          const data = states[panel]
          const total = Math.max(1, Math.ceil(data.length / TRAM_LENGTH))
          const chunk = data.huge ? Math.min(chunks[panel], total - 1) : null
          const label = `Documento ${panel.toUpperCase()}`
          return <div key={panel} hidden={!shown} className={`${shown ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-1 flex-col`}>
            {(split && wide || chunk !== null) && <div className="flex shrink-0 items-center justify-between gap-1 border-b border-[var(--editor-border)] bg-[var(--editor-bar)] px-1">
              <Action label={`Activar ${label.toLowerCase()}`} aria-pressed={active === panel} className="aria-pressed:bg-[var(--editor-hover)]" onClick={() => runtimes.current[panel]?.view?.focus()}>{label}</Action>
              {chunk !== null && <div className="flex items-center gap-0.5 text-xs text-[var(--editor-muted)]">
                <Action label="Tramo anterior" disabled={!chunk} onClick={() => setChunks(current => ({ ...current, [panel]: chunk - 1 }))}><ChevronLeft size={15} aria-hidden /></Action>
                <span>{chunk + 1} / {total}</span>
                <Action label="Tramo siguiente" disabled={chunk + 1 >= total} onClick={() => setChunks(current => ({ ...current, [panel]: chunk + 1 }))}><ChevronRight size={15} aria-hidden /></Action>
              </div>}
              {split && wide && <Action label={`Ocultar panel ${panel.toUpperCase()}`} onClick={() => hide(panel)}><X size={15} aria-hidden /></Action>}
            </div>}
            <DocumentCodeEditor id={`document-editor-${panel}`} label={label} model={model} visible={shown}
              font={font} reduced={data.reduced} chunk={chunk} revision={data.revision} onZoom={zoom}
              onFocus={() => setActive(panel)} onPaste={(event, start, end) => paste(panel, event, start, end)}
              onReady={view => { const runtime = runtimes.current[panel]; if (runtime) runtime.view = view }} />
          </div>
        })}
      </div>
      {diff && <DocumentDiff documents={diff} wide={wide} font={font} onZoom={zoom} onStatus={setDiffStatus} />}
      {pendingRepair && !diff && <div className="shrink-0 border-t border-[var(--editor-border)] bg-[var(--editor-bar)] px-2 py-1">
        <p className="text-xs font-medium">Propuesta de reparación · Documento {active.toUpperCase()}</p>
        <div className="grid max-h-24 gap-2 overflow-auto py-1 text-xs sm:grid-cols-2">
          <div><span>Original</span><pre className="whitespace-pre-wrap break-all">{pendingRepair.before || '(vacío)'}</pre></div>
          <div><span>Propuesta</span><pre className="whitespace-pre-wrap break-all">{pendingRepair.after || '(vacío)'}</pre></div>
        </div>
        <div className="flex gap-1">
          <Action label="Aplicar reparación" onClick={() => {
            if (state.revision !== pendingRepair.revision) return
            documents.replace(active, pendingRepair)
            announce(active, 'Reparación aplicada.')
            runtimes.current[active]?.view?.focus()
          }}>Aplicar reparación</Action>
          <Action label="Descartar propuesta" onClick={() => {
            setProposal(current => ({ ...current, [active]: undefined }))
            announce(active, '')
            runtimes.current[active]?.view?.focus()
          }}>Descartar</Action>
        </div>
      </div>}
      <footer className="flex min-h-6 shrink-0 flex-wrap items-center gap-x-2 border-t border-[var(--editor-border)] bg-[var(--editor-bar)] px-2 text-[11px] leading-5 text-[var(--editor-muted)]">
        <span role="status" aria-live="polite" className={activeNotice?.error && !diff ? 'text-rose-700 data-[theme=dark]:text-rose-300' : ''} data-theme={dark ? 'dark' : 'light'}>
          {diff ? diffStatus : busy ? <span className="inline-flex items-center gap-1"><Loader2 size={12} className="motion-safe:animate-spin" aria-hidden /> Procesando documento {busy.toUpperCase()}…</span>
            : activeNotice?.message || (state.huge ? 'Línea extensa · Vista por tramos. Formatear procesa el documento completo.' : state.reduced ? 'Documento grande · Resaltado simplificado.' : 'Procesamiento local · Hasta 25 MiB por documento.')}
        </span>
        {!diff && !busy && activeNotice?.warnings?.map(warning => <span key={warning}>{warning}</span>)}
        {busy && <Action label="Cancelar operación" onClick={() => { const panel = busy; stop(); setBusy(null); announce(panel, 'Operación cancelada.') }}>Cancelar</Action>}
        {pendingDownload && !diff && <Action label="Descargar resultado" onClick={() => download(pendingDownload.source, pendingDownload.extension)}>Descargar resultado</Action>}
        {!diff && <span className="ml-auto shrink-0">Panel {active.toUpperCase()}</span>}
      </footer>
    </section>
  )
}
