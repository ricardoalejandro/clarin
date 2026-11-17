'use client'

import { useEffect, useId, useLayoutEffect, useRef, useState, type ComponentPropsWithRef, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import {
  ArrowDownToLine, Braces, Brackets, Check, ChevronLeft, ChevronRight, Copy, Eraser, FileUp, GitCompare,
  Loader2, MoreHorizontal, PanelRightOpen, Quote, Redo2, Search, Settings2, Shrink, Sparkles, Undo2, WrapText, Wrench, X, type LucideIcon,
} from 'lucide-react'
import { editor } from 'monaco-editor'
import { DocumentCodeEditor, DocumentDiff, registerDocumentCompletions, type DiffDocument } from './JsonCodeEditor'
import {
  adjustFont, canCompare, DEFAULT_FONT, DIFF_LIMIT, fontZoomPercent, LARGE_DOCUMENT, LONG_LINE, MAX_FONT, MIN_FONT, otherPanel,
  PANEL_BREAKPOINT, repairPreview, TRAM_LENGTH, visiblePanels, type DocumentFormat, type Panel,
} from './editorWorkspaceState'
import { useEditorDocuments, type DocumentSnapshot } from './useEditorDocuments'
import { JSON_INPUT_LIMIT, JSON_REPAIR_LIMIT, measureDocument } from './jsonLimits'
import type { DocumentFileResult, DocumentWorkerRequest, DocumentWorkerResponse, JsonOperation, JsonRequest } from './jsonOperations'
import { DocumentImportReview } from './DocumentImportReview'
import { DOCUMENT_ENCODINGS, originalDocumentAsset, prepareUtf8XmlDownload } from './documentFile'
import { documentExportExtension, documentFormat, isStructuredFormat } from './documentFormats'
import { DocumentFormatPicker } from './DocumentFormatPicker'
import { useDocumentSearch } from './useDocumentSearch'
import type { DocumentMatch } from './documentSearch'
import type { DocumentFoldingStatus } from './documentFolding'
import { useUtilityDocument, useUtilityDocumentState } from '../library/UtilityDocumentContext'
import { editorViewsNeedCompaction, projectEditorViewState, safeJsonViews, validJsonPreference } from './editorPreferences'
import WorkspaceActionsMenu from '@/components/operational-overlay/WorkspaceActionsMenu'
import { fineUtilityPointer, jsonToolbarLayout, type JsonToolbarAction } from './jsonToolbarLayout'
import '../utility-density.css'
import './jsonWorkspace.css'

const button = 'utility-control inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium text-[var(--editor-ink)] outline-none hover:bg-[var(--editor-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500 disabled:opacity-40'
const select = 'utility-field json-editor-field rounded-md border border-[var(--editor-border)] bg-[var(--editor-bar)] px-2 text-xs text-[var(--editor-ink)]'
const menuClass = 'fixed inset-auto m-0 max-h-[calc(100dvh-1rem)] w-64 max-w-[calc(100vw-1rem)] overflow-auto rounded-lg border border-[var(--editor-border)] bg-[var(--editor-bar)] p-2 text-[var(--editor-ink)] shadow-xl'
const panels: Panel[] = ['a', 'b']

function useJsonPreference<T,>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [stored, setStored] = useUtilityDocumentState(key, initial)
  const value = validJsonPreference(key, stored) ? stored : initial
  return [value, next => setStored(previous => typeof next === 'function' ? (next as (previous: T) => T)(validJsonPreference(key, previous) ? previous : initial) : next)]
}

function Action({ label, title = label, children, ...props }: ComponentPropsWithRef<'button'> & { label: string; children: ReactNode }) {
  return <button {...props} type="button" className={`${button} ${props.className ?? ''}`} aria-label={label} title={title}>{children}</button>
}

function positionMenu(anchor: HTMLElement, menu: HTMLDivElement | null) {
  if (!menu) return
  if (menu.matches(':popover-open')) {
    return
  }
  const trigger = anchor.getBoundingClientRect()
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
interface Work { panel: Panel; kind: DocumentWorkerRequest['kind']; worker: Worker; timer: number }
type EditorAction = JsonToolbarAction | 'repair' | 'escape' | 'unescape' | 'clear' | 'original' | 'preferences'
interface EditorActionDefinition { label: string; icon: LucideIcon; title?: string; disabled?: boolean; pressed?: boolean; run: () => void }

export default function JsonUtility() {
  const utility = useUtilityDocument()
  const hydrated = useRef(true)
  const [restoring, setRestoring] = useState(Boolean(utility))
  const librarySearch = useRef<{ request: number; attempted: Set<Panel>; located: boolean } | null>(null)
  const host = useRef<HTMLElement>(null)
  const preferences = useRef<HTMLDivElement>(null)
  const moreButton = useRef<HTMLButtonElement>(null)
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const menuId = `json-actions-${useId().replace(/:/g, '')}`
  const [finePointer, setFinePointer] = useState(false)
  const compareButton = useRef<HTMLButtonElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const fileTarget = useRef<Panel>('a')
  const task = useRef<Work | null>(null)
  const cancelRestore = useRef<(() => void) | null>(null)
  const deactivated = useRef(false)
  const beforeDeactivate = useRef<() => void>(() => {})
  const urls = useRef(new Map<string, number>())
  const alive = useRef(false)
  const [width, setWidth] = useState(0)
  const [split, setSplit] = useJsonPreference('json.split', false)
  const [active, setActive] = useJsonPreference<Panel>('json.active', 'a')
  const [dark, setDark] = useJsonPreference('json.dark', true)
  const [font, setFont] = useJsonPreference('json.font', DEFAULT_FONT)
  const [wrap, setWrap] = useJsonPreference<Record<Panel, boolean>>('json.wrap', { a: false, b: false })
  const [indent, setIndent] = useJsonPreference<JsonRequest['indent']>('json.indent', '2')
  const [structuralXml, setStructuralXml] = useJsonPreference('json.structuralXml', false)
  const [formats, setFormats] = useJsonPreference<Record<Panel, DocumentFormat>>('json.formats', { a: 'strict', b: 'strict' })
  const [plainText, setPlainText] = useJsonPreference<Record<Panel, boolean>>('json.plainText', { a: false, b: false })
  const [signedXml, setSignedXml] = useState<Partial<Record<Panel, boolean>>>({})
  const [chunks, setChunks] = useJsonPreference<Record<Panel, number>>('json.chunks', { a: 0, b: 0 })
  const [searchOpen, setSearchOpen] = useState(false)
  const searchInput = useRef<HTMLInputElement>(null)
  const [folding, setFolding] = useState<Partial<Record<Panel, DocumentFoldingStatus>>>({})
  const [revealMatch, setRevealMatch] = useState<{ panel: Panel; offset: number; length: number; nonce: number }>()
  const revealSequence = useRef(0)
  const [encodingChoice, setEncodingChoice] = useState('utf-8')
  const [pendingEncoding, setPendingEncoding] = useState<{ panel: Panel; file: File }>()
  const [pendingImport, setPendingImport] = useState<{ panel: Panel; file: File; result: Extract<DocumentFileResult, { ok: true }>; revision: number }>()
  const originals = useRef<Partial<Record<Panel, Blob>>>({})
  const [originalNames, setOriginalNames] = useJsonPreference<Partial<Record<Panel, string>>>('json.originalNames', {})
  const [initialViews] = useState(() => safeJsonViews(utility?.initialState['json.views']))
  const savedViews = useRef(initialViews)
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

  const documents = useEditorDocuments((panel, formatHint, error, textOnly) => {
    if (task.current?.panel === panel) {
      stop()
      setBusy(null)
    }
    setNotices(current => ({ ...current, [panel]: error ? { message: error, error: true } : undefined }))
    setProposal(current => ({ ...current, [panel]: undefined }))
    setOversized(current => ({ ...current, [panel]: undefined }))
    setSignedXml(current => current[panel] ? { ...current, [panel]: undefined } : current)
    if (formatHint) setFormats(current => current[panel] === formatHint ? current : { ...current, [panel]: formatHint })
    if (textOnly !== undefined) setPlainText(current => current[panel] === textOnly ? current : { ...current, [panel]: textOnly })
    if (hydrated.current && !error) utility?.setSlot(`panel-${panel}`, () => documents.source(panel))
  })
  const { states, models, runtimes } = documents
  const state = states[active]
  const search = useDocumentSearch(searchOpen, active, state.revision, () => documents.source(active))
  const format = formats[active]
  const pendingRepair = proposal[active]
  const pendingDownload = oversized[active]
  const activeNotice = notices[active]
  const working = busy !== null
  const canRun = Boolean(state.length && !working && !diff)
  const structured = isStructuredFormat(format)
  const canValidate = canRun && structured
  const canTransform = canValidate && !(format === 'xml' && signedXml[active])
  const unavailableFormat = structured ? undefined : 'Disponible para JSON, JSON con comentarios y XML. Este formato admite edición, búsqueda, comparación y descarga.'
  const selectClass = dark ? `${select} dark-input` : select

  function rememberView(panel: Panel, view: editor.ICodeEditorViewState | null) {
    const projected = projectEditorViewState(view)
    // A temporarily hidden Monaco model reports null; retain its last reading position.
    if (!projected) return
    savedViews.current = { ...savedViews.current, [panel]: projected }
    utility?.setState({ 'json.views': savedViews.current })
  }

  useLayoutEffect(() => {
    beforeDeactivate.current = () => {
      deactivated.current = true
      stop()
      search.suspend()
      cancelRestore.current?.()
      librarySearch.current = null
      for (const panel of panels) {
        const view = runtimes.current[panel]?.view
        if (view?.getModel()) rememberView(panel, view.saveViewState())
      }
      setBusy(null)
      setRestoring(false)
      setSearchOpen(false)
    }
  })
  useLayoutEffect(() => utility?.registerBeforeDeactivate?.(() => beforeDeactivate.current()), [utility?.documentId, utility?.registerBeforeDeactivate])
  useLayoutEffect(() => {
    // Replace legacy oversized folding state before the next autosave attempts
    // to send configuration. Text retains its existing independent slot path.
    if (utility && editorViewsNeedCompaction(utility.initialState['json.views'])) utility.setState({ 'json.views': savedViews.current })
  }, [utility?.documentId])

  useLayoutEffect(() => {
    documents.ensure(active)
    if (split) documents.ensure(otherPanel(active))
  }, [active, split, documents.ensure])

  useEffect(() => {
    if (!utility || deactivated.current) return
    let cancelled = false
    const workers = new Set<Worker>()
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const cancel = () => { cancelled = true; workers.forEach(worker => worker.terminate()); timers.forEach(timer => clearTimeout(timer)) }
    cancelRestore.current = cancel
    const revisions = { a: runtimes.current.a?.model.getVersionId(), b: runtimes.current.b?.model.getVersionId() }
    const restore = async () => {
      try {
        for (const panel of panels) {
          if (cancelled || deactivated.current) break
          const blob = await utility.readSlot(`panel-${panel}`)
          if (cancelled || deactivated.current || !blob) continue
          documents.ensure(panel)
          const runtime = runtimes.current[panel]
          if (!runtime || revisions[panel] !== undefined && runtime.model.getVersionId() !== revisions[panel]) continue
          const revision = runtime.model.getVersionId()
          const result = await new Promise<DocumentWorkerResponse>((resolve, reject) => {
            const worker = new Worker(new URL('./json.worker.ts', import.meta.url), { type: 'module' })
            workers.add(worker)
            const timer = setTimeout(() => { timers.delete(timer); worker.terminate(); workers.delete(worker); reject(new Error('timeout')) }, 60_000)
            timers.add(timer)
            worker.onmessage = event => { clearTimeout(timer); timers.delete(timer); worker.terminate(); workers.delete(worker); resolve(event.data) }
            worker.onerror = () => { clearTimeout(timer); timers.delete(timer); worker.terminate(); workers.delete(worker); reject(new Error('read')) }
            // Editable slots are always UTF-8, independently of the declaration
            // retained inside an imported XML. Original bytes have their own slot.
            worker.postMessage({ kind: 'read-file', file: new File([blob], `panel-${panel}.txt`), encoding: 'utf-8' })
          })
          if (cancelled || deactivated.current || result.kind !== 'read-file' || runtime.model.getVersionId() !== revision) continue
          if (!result.result.ok) throw new Error(result.result.message)
          hydrated.current = false
          try { documents.replace(panel, { ...result.result, plainText: plainText[panel] }) } finally { hydrated.current = true }
        }
      } catch {
        if (!cancelled) announce('a', 'No se pudo restaurar el contenido. Vuelve a abrir el documento para reintentar.', true)
      } finally {
        if (!cancelled) { hydrated.current = true; setRestoring(false) }
      }
    }
    void restore()
    return () => { cancel(); if (cancelRestore.current === cancel) cancelRestore.current = null }
    // A provider is keyed by document ID. Its session stays stable while editing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [utility?.documentId])

  function find() {
    search.resume()
    setSearchOpen(true)
    requestAnimationFrame(() => searchInput.current?.focus())
  }

  function showMatch(match: DocumentMatch) {
    setChunks(current => ({ ...current, [active]: Math.floor(match.offset / TRAM_LENGTH) }))
    setRevealMatch({ panel: active, offset: match.offset, length: match.length, nonce: ++revealSequence.current })
  }

  useEffect(() => {
    if (restoring || !utility?.searchQuery || utility.searchRequest === undefined || librarySearch.current?.request === utility.searchRequest) return
    librarySearch.current = { request: utility.searchRequest, attempted: new Set(), located: false }
    setSearchOpen(true)
    search.setCaseSensitive(false)
    search.setQuery(utility.searchQuery)
  }, [restoring, utility?.searchQuery, utility?.searchRequest])

  useEffect(() => {
    const navigation = librarySearch.current
    if (!navigation || navigation.located || !search.completed || search.working || search.pending || search.error || restoring) return
    if (search.matches.length) { navigation.located = true; showMatch(search.matches[0]); return }
    navigation.attempted.add(active)
    const next = otherPanel(active)
    if (!navigation.attempted.has(next) && states[next].length) setActive(next)
    else navigation.located = true
  }, [restoring, active, search.completed, search.working, search.pending, search.error, search.matches, states])

  useLayoutEffect(() => {
    const element = host.current
    if (!element) return
    let measuredWidth = element.clientWidth
    const closeMenu = () => {
      const menu = preferences.current
      const restoreFocus = Boolean(menu?.contains(document.activeElement) || document.getElementById(menuId)?.contains(document.activeElement))
      if (menu?.matches(':popover-open')) menu.hidePopover()
      setMenuAnchor(null)
      if (restoreFocus) moreButton.current?.focus({ preventScroll: true })
    }
    const observer = new ResizeObserver(([entry]) => {
      if (Math.abs(measuredWidth - entry.contentRect.width) >= 1) closeMenu()
      measuredWidth = entry.contentRect.width
      setWidth(measuredWidth)
      const focused = document.activeElement
      requestAnimationFrame(() => {
        if (focused instanceof HTMLElement && !focused.isConnected) moreButton.current?.focus({ preventScroll: true })
      })
    })
    observer.observe(element)
    setWidth(measuredWidth)
    const viewport = window.visualViewport
    window.addEventListener('resize', closeMenu)
    viewport?.addEventListener('resize', closeMenu)
    viewport?.addEventListener('scroll', closeMenu)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', closeMenu)
      viewport?.removeEventListener('resize', closeMenu)
      viewport?.removeEventListener('scroll', closeMenu)
    }
  }, [])

  useLayoutEffect(() => {
    if (!window.matchMedia) return
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)')
    const coarse = window.matchMedia('(any-pointer: coarse)')
    const update = () => setFinePointer(fineUtilityPointer(fine.matches, coarse.matches))
    update()
    fine.addEventListener('change', update)
    coarse.addEventListener('change', update)
    return () => { fine.removeEventListener('change', update); coarse.removeEventListener('change', update) }
  }, [])

  useLayoutEffect(() => { editor.setTheme(dark ? 'vs-dark' : 'vs') }, [dark])
  useLayoutEffect(registerDocumentCompletions, [])
  useLayoutEffect(() => {
    for (const panel of panels) documents.syncLanguage(panel, formats[panel], { ...states[panel], plainText: plainText[panel] })
  })

  useEffect(() => {
    utility?.reportDisplayStatus?.({
      lightPanels: panels.filter(panel => states[panel].length > 0 && states[panel].reduced && !states[panel].huge),
      chunkedPanels: panels.filter(panel => states[panel].length > 0 && states[panel].huge),
      folding,
    })
  }, [utility, states, folding])

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
    if (task.current || host.current?.closest('[inert]')) return false
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
      task.current = { panel, kind: request.kind, worker, timer: window.setTimeout(() => {
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
    if (!source || task.current || !isStructuredFormat(format)) return
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
        const snapshot: DocumentSnapshot = { source: result.text, metrics: result.metrics, plainText: result.extension === 'txt', formatHint: result.extension === 'txt' ? 'plaintext' : format }
        if (result.metrics.bytes > JSON_INPUT_LIMIT) {
          setOversized(current => ({ ...current, [panel]: { source: result.text!, extension: result.extension ?? 'txt' } }))
          announce(panel, 'El resultado supera 60 MiB. Se conservó el documento abierto.', true, result.warnings)
          return
        }
        if (operation === 'repair') {
          const preview = repairPreview(source, result.text)
          setProposal(current => ({ ...current, [panel]: { ...snapshot, ...preview, revision } }))
        } else {
          documents.replace(panel, snapshot, format)
        }
      }
      const message = operation === 'smart' && result.text === source
        ? 'El documento ya usa el formato inteligente.'
        : result.message
      announce(panel, message, false, result.warnings)
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
      announce(panel, 'El texto pegado supera 60 MiB. Se conservó el documento.', true)
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
        announce(panel, 'El texto pegado supera 60 MiB. Se conservó el documento.', true)
        return
      }
      documents.replace(panel, { source, metrics })
    }
    if (source.length <= LONG_LINE) apply(measureDocument(source))
    else launch(panel, { kind: 'measure', source }, response => {
      if (response.kind === 'measure') apply(response.metrics)
    })
  }

  function applyFile(candidate: NonNullable<typeof pendingImport>) {
    const { panel, file, result, revision } = candidate
    if (runtimes.current[panel]?.model.getVersionId() !== revision) {
      setPendingImport(undefined)
      setPendingEncoding({ panel, file })
      announce(panel, 'El panel cambió durante la lectura. Se conservó tu edición; vuelve a probar la codificación.', true)
      return
    }
    // Queue opaque bytes before model changes can queue the editable text.
    originals.current[panel] = file
    utility?.setSlot(`original-${panel}`, originalDocumentAsset(file))
    documents.replace(panel, { ...result, formatHint: result.syntaxHint }, formats[panel])
    setOriginalNames(current => ({ ...current, [panel]: file.name }))
    setPendingEncoding(undefined)
    setPendingImport(undefined)
    if (result.syntaxHint) {
      setFormats(current => ({ ...current, [panel]: result.syntaxHint! }))
      setPlainText(current => ({ ...current, [panel]: false }))
      documents.setFormat(panel, result.syntaxHint)
    }
    announce(panel, result.converted ? `Archivo abierto como ${result.encoding}. La descarga editada usará UTF-8; el original se conserva.` : 'Archivo local abierto.', false, result.warnings)
  }

  function openFile(file: File | undefined, encoding?: string, panel = fileTarget.current) {
    if (!file) return
    if (file.size > JSON_INPUT_LIMIT) {
      announce(panel, 'El archivo supera 60 MiB. Se conservó el documento abierto.', true)
      return
    }
    launch(panel, { kind: 'read-file', file, encoding }, response => {
      if (response.kind !== 'read-file') return
      const { result } = response
      if (!result.ok) {
        if (result.encodingConflict) {
          setPendingEncoding({ panel, file })
          setEncodingChoice(result.suggestedEncoding ?? 'utf-8')
        }
        announce(panel, result.message, true)
        return
      }
      const candidate = { panel, file, result, revision: runtimes.current[panel]!.model.getVersionId() }
      if (encoding || result.converted || result.warnings?.length) setPendingImport(candidate)
      else applyFile(candidate)
    })
  }

  function cancelFileImport(panel: Panel) {
    if (task.current?.kind === 'read-file' && task.current.panel === panel) {
      stop()
      setBusy(null)
    }
    setPendingImport(undefined)
    setPendingEncoding(undefined)
    announce(panel, 'Apertura cancelada. Se conservó el documento.')
  }

  function selectFormat(next: DocumentFormat) {
    setFormats(current => ({ ...current, [active]: next }))
    setPlainText(current => ({ ...current, [active]: false }))
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
    requestAnimationFrame(() => (compareButton.current ?? moreButton.current)?.focus())
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
    if (format === 'xml' && extension !== 'txt') {
      const prepared = prepareUtf8XmlDownload(source, Boolean(signedXml[active]) || source.includes('http://www.w3.org/2000/09/xmldsig#'))
      if (!prepared.ok) {
        announce(active, prepared.message, true)
        return
      }
      source = prepared.source
    }
    const type = extension === 'txt' ? 'text/plain' : documentFormat(format).mime
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

  async function downloadOriginal() {
    const panel = active
    try {
      const blob = originals.current[panel] ?? await utility?.readSlot(`original-${panel}`)
      if (!alive.current) return
      if (!blob) { announce(panel, 'No se pudo recuperar el archivo original.', true); return }
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = originalNames[panel] ?? 'documento-original'
      link.click()
      urls.current.set(url, window.setTimeout(() => { URL.revokeObjectURL(url); urls.current.delete(url) }, 1000))
    } catch {
      if (alive.current) announce(panel, 'No se pudo descargar el original. Revisa la conexión y vuelve a intentarlo.', true)
    }
  }

  const zoom = (delta: number) => setFont(current => adjustFont(current, delta))
  const zoomPercent = fontZoomPercent(font)
  const toggleWrap = (panel: Panel) => setWrap(current => ({ ...current, [panel]: !current[panel] }))
  const history = (direction: 'undo' | 'redo') => {
    const runtime = runtimes.current[active]
    void runtime?.model[direction]()
    runtime?.view?.focus()
  }

  const actions: Record<EditorAction, EditorActionDefinition> = {
    undo: { label: 'Deshacer', icon: Undo2, disabled: !state.undo, run: () => history('undo') },
    redo: { label: 'Rehacer', icon: Redo2, disabled: !state.redo, run: () => history('redo') },
    open: { label: 'Abrir archivo', icon: FileUp, disabled: working, run: () => { fileTarget.current = active; fileInput.current?.click() } },
    copy: { label: 'Copiar documento', icon: Copy, disabled: !state.length, run: () => { void copy() } },
    download: { label: 'Descargar documento', icon: ArrowDownToLine, disabled: !state.length, run: () => download(documents.source(active), documentExportExtension(format, originalNames[active], plainText[active])) },
    smart: { label: 'Formato inteligente', title: unavailableFormat ?? 'Formato inteligente · Agrupa elementos cortos', icon: Sparkles, disabled: !canValidate, run: () => run('smart') },
    minify: { label: 'Compactar', icon: Shrink, disabled: !canTransform, run: () => run('minify') },
    wrap: { label: 'Ajustar líneas', title: state.huge ? 'El ajuste de línea está activo en la vista por tramos' : 'Ajustar líneas (Word wrap · Alt+Z)', icon: WrapText, disabled: state.huge, pressed: state.huge || wrap[active], run: () => toggleWrap(active) },
    panel: { label: split ? `Ocultar panel ${active.toUpperCase()}` : 'Mostrar segundo panel', icon: split ? X : PanelRightOpen, run: () => split ? hide(active) : reveal() },
    compare: { label: 'Comparar diferencias', icon: GitCompare, disabled: working, run: startComparison },
    repair: { label: 'Reparar', icon: Wrench, disabled: !canValidate, run: () => run('repair') },
    escape: { label: 'Escapar', icon: Quote, disabled: !canValidate, run: () => run('escape') },
    unescape: { label: 'Desescapar', icon: Brackets, disabled: !canValidate, run: () => run('unescape') },
    clear: { label: 'Limpiar documento', title: 'Limpiar documento · Se puede deshacer', icon: Eraser, disabled: !state.length, run: () => documents.replace(active, { source: '', metrics: measureDocument('') }) },
    original: { label: 'Descargar archivo original', title: `Descargar original · ${originalNames[active] ?? ''}`, icon: ArrowDownToLine, run: () => { void downloadOriginal() } },
    preferences: { label: 'Preferencias del editor', icon: Settings2, run: () => {
      if (!moreButton.current || !preferences.current) return
      positionMenu(moreButton.current, preferences.current)
      preferences.current.showPopover?.()
      requestAnimationFrame(() => preferences.current?.querySelector('select')?.focus({ preventScroll: true }))
    } },
  }
  const toolbar = jsonToolbarLayout(width, finePointer, format, split)
  const menuActions: EditorAction[] = diff ? ['preferences'] : [
    ...toolbar.overflow,
    ...(format === 'strict' || format === 'jsonc' ? ['repair', 'escape', 'unescape'] as const : []),
    ...(originalNames[active] ? ['original'] as const : []),
    'clear', 'preferences',
  ]
  const toolbarAction = (id: JsonToolbarAction) => {
    const action = actions[id]
    return <Action key={id} ref={id === 'compare' ? compareButton : undefined} label={action.label} title={action.title} disabled={action.disabled}
      aria-pressed={action.pressed} aria-keyshortcuts={id === 'wrap' ? 'Alt+Z' : undefined} onClick={action.run}
      className="json-toolbar-icon aria-pressed:bg-[var(--editor-hover)]"><action.icon size={16} aria-hidden /></Action>
  }

  return (
    <section ref={host} aria-label="Editor de documentos" data-editor-theme={dark ? 'dark' : 'light'}
      className="flex min-h-64 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--editor-canvas)] text-[var(--editor-ink)] [color-scheme:light] [--editor-bar:#f8fafc] [--editor-border:#cbd5e1] [--editor-canvas:#fff] [--editor-hover:#e2e8f0] [--editor-ink:#1e293b] [--editor-muted:#475569] data-[editor-theme=dark]:[color-scheme:dark] data-[editor-theme=dark]:[--editor-bar:#252526] data-[editor-theme=dark]:[--editor-border:#424248] data-[editor-theme=dark]:[--editor-canvas:#1e1e1e] data-[editor-theme=dark]:[--editor-hover:#3a3d41] data-[editor-theme=dark]:[--editor-ink:#e2e8f0] data-[editor-theme=dark]:[--editor-muted:#a9b4c3]">
      <div className="utility-work-toolbar border-b border-[var(--editor-border)] bg-[var(--editor-bar)]" role="toolbar" aria-label="Herramientas del documento activo" data-json-toolbar>
        {diff ? (
          <Action label="Volver a editar" onClick={closeComparison}><ChevronLeft size={15} aria-hidden /> Volver a editar</Action>
        ) : <>
          <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label="Operaciones del panel activo">
            <DocumentFormatPicker className={`${selectClass} shrink-0`} width={toolbar.syntaxWidth} value={format} disabled={working} onChange={selectFormat} />
            <Action label="Formatear" title={unavailableFormat ?? (format === 'xml' ? 'Formatear XML' : 'Formatear · Un elemento por línea')} disabled={!canTransform} onClick={() => run('format')} className="json-toolbar-icon text-emerald-700 data-[theme=dark]:text-emerald-300" data-theme={dark ? 'dark' : 'light'}><Braces size={16} aria-hidden /></Action>
            <Action label="Validar" title={unavailableFormat} disabled={!canValidate} onClick={() => run('validate')} className="json-toolbar-icon"><Check size={16} aria-hidden /></Action>
            <Action label="Buscar en todo el documento" disabled={!state.length} onClick={find} className="json-toolbar-icon"><Search size={16} aria-hidden /></Action>
          </div>
          {toolbar.visible.map(group => <div key={group[0]} className="json-toolbar-group" data-json-promoted role="group" aria-label="Acciones del documento activo">{group.map(toolbarAction)}</div>)}
        </>}
        <Action ref={moreButton} label="Más acciones del editor" className="json-toolbar-icon ml-auto" aria-haspopup="menu" aria-expanded={Boolean(menuAnchor)} aria-controls={menuAnchor ? menuId : undefined}
          onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setMenuAnchor(event.currentTarget) } }}
          onClick={event => { const anchor = event.currentTarget; setMenuAnchor(current => current ? null : anchor) }}><MoreHorizontal size={16} aria-hidden /></Action>
      </div>
      {menuAnchor && <WorkspaceActionsMenu anchor={menuAnchor} id={menuId} label="Más acciones del editor" onClose={() => setMenuAnchor(null)}>
        {menuActions.map(id => {
          const action = actions[id]
          return <button key={id} type="button" role="menuitem" aria-label={action.label} title={action.title} disabled={action.disabled}
            aria-description={action.pressed === undefined ? undefined : action.pressed ? 'Activado' : 'Desactivado'} aria-keyshortcuts={id === 'wrap' ? 'Alt+Z' : undefined}
            className="utility-control flex w-full items-center gap-2 rounded-lg px-3 text-left text-xs font-medium text-slate-700 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-emerald-600 disabled:opacity-40"
            onClick={() => { setMenuAnchor(null); moreButton.current?.focus({ preventScroll: true }); action.run() }}><action.icon size={16} aria-hidden /><span>{action.label}</span>{action.pressed && <Check size={14} aria-label="Activado" className="ml-auto" />}</button>
        })}
      </WorkspaceActionsMenu>}
      <input ref={fileInput} aria-label="Abrir archivo local" type="file" hidden
        onChange={event => { openFile(event.currentTarget.files?.[0]); event.currentTarget.value = '' }} />
          <div id="document-preferences" ref={preferences} popover="auto" className={menuClass} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); preferences.current?.hidePopover(); moreButton.current?.focus({ preventScroll: true }) } }}>
            <div className="grid gap-2 p-1">
              <label className="grid gap-1 text-xs">Tema<select aria-label="Tema" className={selectClass} value={dark ? 'dark' : 'light'} onChange={event => setDark(event.target.value === 'dark')}><option value="dark">Oscuro</option><option value="light">Claro</option></select></label>
              <label className="grid gap-1 text-xs">Sangría<select aria-label="Sangría" className={selectClass} value={indent} disabled={working} onChange={event => setIndent(event.target.value as JsonRequest['indent'])}><option value="2">2 espacios</option><option value="4">4 espacios</option><option value="tab">Tabulador</option></select></label>
              <p className="text-xs text-[var(--editor-muted)]">Desplazamiento visual por cada nivel. Cuatro espacios separan más los niveles.</p>
              {format === 'xml' && <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={structuralXml} disabled={working} onChange={event => setStructuralXml(event.target.checked)} /> Ajustar espacios entre etiquetas</label>}
              <div className="flex items-center justify-between border-t border-[var(--editor-border)] pt-1">
                <Action label="Reducir letra" disabled={font <= MIN_FONT} onClick={() => zoom(-1)}>A−</Action>
                <span className="text-xs tabular-nums">{zoomPercent}%</span>
                <Action label="Aumentar letra" disabled={font >= MAX_FONT} onClick={() => zoom(1)}>A+</Action>
              </div>
            </div>
          </div>
      {pendingEncoding && <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--editor-border)] bg-[var(--editor-bar)] p-2 text-xs" role="group" aria-label="Elegir codificación del archivo">
        <span className="min-w-0 break-all">Se conservó el documento. Abrir {pendingEncoding.file.name} como:</span>
        <select aria-label="Codificación del archivo" className={selectClass} value={encodingChoice} onChange={event => setEncodingChoice(event.target.value)}>{DOCUMENT_ENCODINGS.map(encoding => <option key={encoding} value={encoding}>{encoding.toUpperCase()}</option>)}</select>
        <Action label="Abrir con esta codificación" disabled={working} onClick={() => openFile(pendingEncoding.file, encodingChoice, pendingEncoding.panel)}>Probar</Action>
        <Action label="Cancelar apertura" onClick={() => cancelFileImport(pendingEncoding.panel)}><X size={15} aria-hidden /></Action>
      </div>}
      {pendingImport && <DocumentImportReview fileName={pendingImport.file.name} source={pendingImport.result.source} encoding={pendingImport.result.encoding ?? 'utf-8'} warnings={pendingImport.result.warnings}
        onApply={() => applyFile(pendingImport)} onCancel={() => cancelFileImport(pendingImport.panel)}
        onChooseEncoding={() => { setEncodingChoice(pendingImport.result.encoding ?? 'utf-8'); setPendingEncoding({ panel: pendingImport.panel, file: pendingImport.file }); setPendingImport(undefined) }} />}
      {searchOpen && !diff && <div className="shrink-0 border-b border-[var(--editor-border)] bg-[var(--editor-bar)] p-1 text-xs">
        <div className="flex min-w-0 flex-wrap items-center gap-1" role="search" aria-label="Buscar en todo el documento">
          <Search size={15} aria-hidden />
          <input ref={searchInput} aria-label="Texto para buscar en todo el documento" maxLength={1024} value={search.query} onChange={event => search.setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setSearchOpen(false); if (event.key === 'Enter' && search.matches[0]) showMatch(search.matches[0]) }} className="utility-field json-editor-field min-w-0 flex-1 rounded-md border border-[var(--editor-border)] bg-[var(--editor-canvas)] px-2 text-[var(--editor-ink)] outline-none focus:ring-2 focus:ring-emerald-500" placeholder="Busca en el documento completo…" />
          <Action label="Distinguir mayúsculas" aria-pressed={search.caseSensitive} onClick={() => search.setCaseSensitive(value => !value)}>Aa</Action>
          <span role="status">{search.working || search.pending ? 'Buscando…' : search.error || (search.query ? `${search.matches.length}${search.nextOffset !== null ? '+' : ''} coincidencias` : 'Texto literal · Todo el documento')}</span>
          <Action label="Cerrar búsqueda" onClick={() => { setSearchOpen(false); runtimes.current[active]?.view?.focus() }}><X size={15} aria-hidden /></Action>
        </div>
        {search.matches.length > 0 && <div className="max-h-28 overflow-auto" aria-label="Coincidencias del documento">
          {search.matches.map(match => <button type="button" key={match.offset} disabled={search.pending || search.working} onClick={() => showMatch(match)} className="block min-h-8 w-full truncate rounded px-2 text-left font-mono hover:bg-[var(--editor-hover)] focus-visible:ring-2 focus-visible:ring-emerald-500">{match.preview}</button>)}
          {search.nextOffset !== null && <Action label="Más coincidencias" disabled={search.working || search.pending} onClick={search.more}>Más coincidencias</Action>}
        </div>}
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
              font={font} wrap={wrap[panel]} reduced={data.reduced} chunk={chunk} revision={data.revision} onZoom={zoom}
              onFoldingStatus={status => setFolding(current => JSON.stringify(current[panel]) === JSON.stringify(status) ? current : { ...current, [panel]: status })}
              onToggleWrap={() => toggleWrap(panel)}
              onFind={find} reveal={revealMatch?.panel === panel ? revealMatch : undefined}
              initialViewState={savedViews.current[panel]}
              onViewState={view => rememberView(panel, view)}
              onFocus={() => setActive(panel)} onPaste={(event, start, end) => paste(panel, event, start, end)}
              onReady={view => { const runtime = runtimes.current[panel]; if (runtime) runtime.view = view }} />
          </div>
        })}
      </div>
      {diff && <DocumentDiff documents={diff} wide={wide} font={font} onZoom={zoom} onStatus={setDiffStatus} />}
      {pendingRepair && !diff && <div className="shrink-0 border-t border-[var(--editor-border)] bg-[var(--editor-bar)] px-2 py-1">
        <p className="text-xs font-medium">Propuesta de reparación · Documento {active.toUpperCase()}</p>
        <div className="grid max-h-24 gap-2 overflow-auto py-1 text-xs" style={{ gridTemplateColumns: width >= 640 ? 'repeat(2, minmax(0, 1fr))' : 'minmax(0, 1fr)' }}>
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
      {!diff && (activeNotice?.error || activeNotice?.warnings?.length) ? <div role={activeNotice.error ? 'alert' : 'status'} className="max-h-24 shrink-0 overflow-auto border-t border-[var(--editor-border)] bg-[var(--editor-bar)] px-2 py-1 text-xs text-[var(--editor-ink)]">
        {activeNotice.error && <p>{activeNotice.message}</p>}{activeNotice.warnings?.map(warning => <p key={warning}>{warning}</p>)}
      </div> : null}
      <footer className="json-editor-footer border-t border-[var(--editor-border)] bg-[var(--editor-bar)] text-[11px] leading-5 text-[var(--editor-muted)]">
        {split && !wide && !diff ? <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label="Documento visible">
          {panels.map(panel => <Action key={panel} label={`Ver documento ${panel.toUpperCase()}`} aria-pressed={active === panel} onClick={() => setActive(panel)} className="px-0 aria-pressed:bg-[var(--editor-hover)]">{panel.toUpperCase()}</Action>)}
          <Action label={`Ocultar panel ${active.toUpperCase()}`} onClick={() => hide(active)} className="px-0"><X size={14} aria-hidden /></Action>
        </div> : !diff && <span className="shrink-0 px-1" title={`Panel ${active.toUpperCase()}`}>{active.toUpperCase()}</span>}
        <span role="status" aria-live="polite" className="min-w-0 flex-1 truncate px-1" title={activeNotice?.message || 'Procesamiento local · Recomendado hasta 30 MiB; máximo 60 MiB por documento.'}>
          {diff ? diffStatus : busy ? <span className="inline-flex items-center gap-1"><Loader2 size={12} className="motion-safe:animate-spin" aria-hidden /> Procesando {busy.toUpperCase()}…</span>
            : activeNotice?.error ? 'Revisa el aviso' : activeNotice?.message || (state.huge ? 'Tramos editables · Buscar recorre todo el documento' : state.reduced ? 'Documento grande · Resaltado básico' : 'Local · 30 MiB recomendado · 60 MiB máx.')}
        </span>
        {busy && <Action label="Cancelar operación" className="px-0" onClick={() => { const panel = busy; stop(); setBusy(null); announce(panel, 'Operación cancelada.') }}><X size={14} aria-hidden /></Action>}
        {pendingDownload && !diff && <Action label="Descargar resultado" className="px-0" onClick={() => download(pendingDownload.source, pendingDownload.extension)}><ArrowDownToLine size={14} aria-hidden /></Action>}
        <Action label="Restablecer zoom del editor" title={`Zoom del editor ${zoomPercent}% · Restablecer a 100%`}
          aria-description={`Zoom actual ${zoomPercent}%`} className="w-[3.25rem] px-0 tabular-nums" onClick={() => setFont(DEFAULT_FONT)}>{zoomPercent}%</Action>
      </footer>
    </section>
  )
}
