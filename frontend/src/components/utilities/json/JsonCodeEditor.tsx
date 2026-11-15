'use client'

import { useLayoutEffect, useRef } from 'react'
import { editor, json, KeyCode, KeyMod, languages, Position, Range } from 'monaco-editor'
import { jsonLiteralCompletions, xmlClosingTagCompletion } from './documentCompletions'
import { acceptsEditorZoom, documentRevealSelection, documentWrapOptions, tramRange } from './editorWorkspaceState'
import { registerLargeJsonSyntax } from './largeJsonSyntax'

globalThis.MonacoEnvironment = {
  getWorker(_moduleId, label) {
    if (label === 'json') return new Worker(new URL('./monacoJson.worker.ts', import.meta.url), { type: 'module' })
    return new Worker(new URL('./monacoEditor.worker.ts', import.meta.url), { type: 'module' })
  },
}

// JSON and JSONC can be open together. Explicit local validation owns diagnostics.
json.jsonDefaults.setDiagnosticsOptions({ validate: false, schemas: [], enableSchemaRequest: false })
json.jsonDefaults.setModeConfiguration({ ...json.jsonDefaults.modeConfiguration, diagnostics: false, documentFormattingEdits: false, documentRangeFormattingEdits: false })
registerLargeJsonSyntax(languages)

export function registerDocumentCompletions() {
  const readPrefix = (model: editor.ITextModel, position: Position) =>
    model.getOffsetAt(position) <= 128 * 1024 ? model.getValueInRange(Range.fromPositions(new Position(1, 1), position)) : ''
  const replaceRange = (position: Position, partial: string, suffixLength = 0) =>
    new Range(position.lineNumber, position.column - partial.length, position.lineNumber, position.column + suffixLength)
  const jsonCompletions = languages.registerCompletionItemProvider('json', {
    provideCompletionItems(model, position) {
      const prefix = readPrefix(model, position)
      return { suggestions: (prefix ? jsonLiteralCompletions(prefix) : []).map(({ label, partial }) => ({
        label, kind: languages.CompletionItemKind.Keyword, insertText: label, range: replaceRange(position, partial),
      })) }
    },
  })
  const xmlCompletions = languages.registerCompletionItemProvider('xml', {
    triggerCharacters: ['/'],
    provideCompletionItems(model, position) {
      const completion = xmlClosingTagCompletion(readPrefix(model, position))
      const next = model.getLineContent(position.lineNumber)[position.column - 1]
      return { suggestions: completion ? [{
        label: completion.label, kind: languages.CompletionItemKind.Keyword,
        insertText: `${completion.label}>`, range: replaceRange(position, completion.partial, next === '>' ? 1 : 0),
      }] : [] }
    },
  })
  return () => { jsonCompletions.dispose(); xmlCompletions.dispose() }
}

const baseOptions: editor.IStandaloneEditorConstructionOptions = {
  automaticLayout: true,
  colorDecorators: false,
  editContext: false,
  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
  minimap: { enabled: false },
  maxTokenizationLineLength: 20_000,
  mouseWheelZoom: false,
  padding: { top: 6, bottom: 6 },
  scrollBeyondLastLine: false,
  scrollbar: { alwaysConsumeMouseWheel: false },
  wordBasedSuggestions: 'off',
}

function fontOptions(size: number) {
  return { fontSize: size, lineHeight: Math.round(size * 1.5) }
}

function bindWheel(host: HTMLElement, focused: () => boolean, zoom: (delta: number) => void) {
  let lastStep = 0
  const wheel = (event: WheelEvent) => {
    if (!acceptsEditorZoom(event, focused())) return
    event.preventDefault()
    event.stopPropagation()
    const now = performance.now()
    if (now - lastStep < 45 && lastStep) return
    lastStep = now
    zoom(event.deltaY < 0 ? 1 : -1)
  }
  host.addEventListener('wheel', wheel, { capture: true, passive: false })
  return () => host.removeEventListener('wheel', wheel, true)
}

interface Props {
  id: string
  label: string
  model: editor.ITextModel
  font: number
  wrap: boolean
  visible: boolean
  reduced: boolean
  chunk: number | null
  revision: number
  onZoom: (delta: number) => void
  onToggleWrap: () => void
  onFocus: () => void
  onPaste: (event: ClipboardEvent, start: number, end: number) => void
  onReady: (view: editor.IStandaloneCodeEditor | null) => void
  onFind?: () => void
  reveal?: { offset: number; length: number; nonce: number }
  initialViewState?: editor.ICodeEditorViewState | null
  onViewState?: (state: editor.ICodeEditorViewState | null) => void
}

export function DocumentCodeEditor(props: Props) {
  const { id, model, label, font, wrap, visible, reduced, chunk, revision } = props
  const host = useRef<HTMLDivElement>(null)
  const instance = useRef<editor.IStandaloneCodeEditor>(null)
  const viewState = useRef<editor.ICodeEditorViewState | null>(null)
  const preview = useRef<editor.ITextModel | null>(null)
  const previewState = useRef<{ chunk: number; revision: number; view: editor.ICodeEditorViewState | null } | null>(null)
  const previewRange = useRef<{ chunk: number; start: number; end: number; revision: number } | null>(null)
  const syncingPreview = useRef(false)
  const restoredView = useRef(false)
  const revealedMatch = useRef<number | null>(null)
  const latest = useRef(props)
  useLayoutEffect(() => { latest.current = props }, [props])

  useLayoutEffect(() => {
    const element = host.current
    if (!element) return
    const view = editor.create(element, { ...baseOptions, model: null, ariaLabel: label })
    instance.current = view
    const focus = view.onDidFocusEditorText(() => latest.current.onFocus())
    const findAction = view.addAction({ id: 'clarin.document.findAll', label: 'Buscar en todo el documento', keybindings: [KeyMod.CtrlCmd | KeyCode.KeyF], run: () => latest.current.onFind?.() })
    const undoAction = view.addAction({ id: 'clarin.document.undo', label: 'Deshacer en el documento', keybindings: [KeyMod.CtrlCmd | KeyCode.KeyZ], run: () => latest.current.chunk !== null ? model.undo() : view.trigger('clarin', 'undo', null) })
    const redoAction = view.addAction({ id: 'clarin.document.redo', label: 'Rehacer en el documento', keybindings: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyZ, KeyMod.CtrlCmd | KeyCode.KeyY], run: () => latest.current.chunk !== null ? model.redo() : view.trigger('clarin', 'redo', null) })
    const remember = () => latest.current.onViewState?.(view.saveViewState())
    const scroll = view.onDidScrollChange(remember)
    const cursor = view.onDidChangeCursorSelection(remember)
    const wrapAction = view.addAction({
      id: 'clarin.document.toggleWrap',
      label: 'Ajustar líneas',
      keybindings: [KeyMod.Alt | KeyCode.KeyZ],
      run: () => {
        if (latest.current.chunk === null) latest.current.onToggleWrap()
      },
    })
    const paste = (event: ClipboardEvent) => {
      const selection = view.getSelection()
      if (!selection) return
      const activeModel = view.getModel()
      if (!activeModel) return
      const origin = activeModel === model ? 0 : previewRange.current?.start
      if (origin === undefined) return
      latest.current.onPaste(event, origin + activeModel.getOffsetAt(selection.getStartPosition()), origin + activeModel.getOffsetAt(selection.getEndPosition()))
    }
    const unbindWheel = bindWheel(element, () => view.hasTextFocus(), delta => latest.current.onZoom(delta))
    element.addEventListener('paste', paste, true)
    latest.current.onReady(view)
    return () => {
      remember()
      instance.current = null
      latest.current.onReady(null)
      element.removeEventListener('paste', paste, true)
      unbindWheel()
      focus.dispose()
      findAction.dispose()
      undoAction.dispose()
      redoAction.dispose()
      scroll.dispose()
      cursor.dispose()
      wrapAction.dispose()
      view.dispose()
      preview.current?.dispose()
      preview.current = null
      previewRange.current = null
    }
  }, [label, model])

  useLayoutEffect(() => {
    const view = instance.current
    if (!view) return
    if (!visible || chunk !== null) {
      if (view.getModel() === model) viewState.current = view.saveViewState()
      if (chunk === null || !visible) {
        if (chunk !== null && view.getModel() === preview.current && preview.current) {
          previewState.current = { chunk, revision, view: view.saveViewState() }
        }
        view.setModel(null)
        return
      }
      const length = model.getValueLength()
      if (previewRange.current?.chunk === chunk && previewRange.current.revision === revision && view.getModel() === preview.current && (!props.reveal || revealedMatch.current === props.reveal.nonce)) return
      const codeAt = (offset: number) => model.getValueInRange(Range.fromPositions(model.getPositionAt(offset), model.getPositionAt(offset + 1))).charCodeAt(0)
      const { start, end: defaultEnd } = tramRange(length, chunk, codeAt)
      const target = props.reveal
      const end = target && target.nonce !== revealedMatch.current && target.offset >= start && target.offset < defaultEnd
        ? Math.min(length, Math.max(defaultEnd, target.offset + target.length)) : defaultEnd
      const first = model.getPositionAt(start)
      const last = model.getPositionAt(end)
      const text = model.getValueInRange(Range.fromPositions(first, last))
      const previousView = previewRange.current?.chunk === chunk && view.getModel() === preview.current ? view.saveViewState() : null
      if (!preview.current) {
        preview.current = editor.createModel('', 'plaintext')
        preview.current.setEOL(editor.EndOfLineSequence.LF)
        preview.current.onDidChangeContent(change => {
          const range = previewRange.current
          if (syncingPreview.current || !range || range.revision !== model.getVersionId()) return
          const edits = change.changes.map(edit => ({
            range: Range.fromPositions(model.getPositionAt(range.start + edit.rangeOffset), model.getPositionAt(range.start + edit.rangeOffset + edit.rangeLength)), text: edit.text,
          }))
          const beforeLength = model.getValueLength()
          const delta = change.changes.reduce((sum, edit) => sum + edit.text.length - edit.rangeLength, 0)
          model.pushEditOperations(null, edits, () => null)
          const expected = model.getValueInRange(Range.fromPositions(model.getPositionAt(range.start), model.getPositionAt(range.end + delta)))
          if (model.getValueLength() !== beforeLength + delta || preview.current?.getValue() !== expected) {
            // A size/Unicode guard may reject the source mutation. Restore only
            // this bounded fragment, keeping the authoritative model intact.
            syncingPreview.current = true
            try { preview.current?.setValue(model.getValueInRange(Range.fromPositions(model.getPositionAt(range.start), model.getPositionAt(range.end)))) } finally { syncingPreview.current = false }
          } else range.end += delta
          range.revision = model.getVersionId()
        })
      }
      if (view.getModel() !== preview.current) view.setModel(preview.current)
      if (preview.current.getValue() !== text) {
        syncingPreview.current = true
        try { preview.current.setValue(text) } finally { syncingPreview.current = false }
        if (previousView) view.restoreViewState(previousView)
        else view.setScrollPosition({ scrollTop: 0, scrollLeft: 0 })
      }
      previewRange.current = { chunk, start, end, revision }
      view.layout()
      const saved = previewState.current
      if (saved?.chunk === chunk && saved.revision === revision && saved.view) view.restoreViewState(saved.view)
      else if (!restoredView.current && latest.current.initialViewState) { view.restoreViewState(latest.current.initialViewState); restoredView.current = true }
      previewState.current = null
    } else if (view.getModel() !== model) {
      view.setModel(model)
      preview.current?.dispose()
      preview.current = null
      previewState.current = null
      view.layout()
      if (viewState.current) view.restoreViewState(viewState.current)
      else if (!restoredView.current && latest.current.initialViewState) { view.restoreViewState(latest.current.initialViewState); restoredView.current = true }
    }
  }, [model, visible, chunk, revision, props.reveal])

  useLayoutEffect(() => {
    instance.current?.updateOptions({
      ...fontOptions(font),
      readOnly: false,
      domReadOnly: false,
      ariaLabel: label,
      folding: !reduced,
      bracketPairColorization: { enabled: !reduced },
      matchBrackets: reduced ? 'never' : 'always',
      occurrencesHighlight: reduced ? 'off' : 'singleFile',
      quickSuggestions: !reduced,
      selectionHighlight: !reduced,
      stickyScroll: { enabled: false },
      ...documentWrapOptions(wrap, chunk),
      wordWrapColumn: 100,
      stopRenderingLineAfter: chunk !== null ? -1 : 100_000,
      placeholder: 'Pega texto o abre un archivo local.',
    })
  }, [font, label, reduced, chunk, wrap])

  useLayoutEffect(() => {
    const target = props.reveal
    const view = instance.current
    const activeModel = view?.getModel()
    if (!target || !view || !activeModel) return
    const origin = activeModel === model ? 0 : previewRange.current?.start ?? 0
    const selection = documentRevealSelection(revealedMatch.current, target, origin, activeModel.getValueLength())
    if (!selection) return
    revealedMatch.current = selection.nonce
    const from = activeModel.getPositionAt(selection.start)
    const until = activeModel.getPositionAt(selection.end)
    view.setSelection(Range.fromPositions(from, until))
    view.revealPositionInCenter(from)
    view.focus()
  }, [props.reveal, model, chunk, revision])

  return <div id={id} ref={host} data-testid={id} className="min-h-0 min-w-0 flex-1 overflow-hidden" />
}

export interface DiffDocument {
  source: string
  language: string
}

export function DocumentDiff({ documents, wide, font, onZoom, onStatus }: {
  documents: readonly [DiffDocument, DiffDocument]
  wide: boolean
  font: number
  onZoom: (delta: number) => void
  onStatus: (status: string) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const instance = useRef<editor.IStandaloneDiffEditor>(null)
  const latest = useRef({ font, wide, onZoom, onStatus })
  useLayoutEffect(() => { latest.current = { font, wide, onZoom, onStatus } }, [font, wide, onZoom, onStatus])

  useLayoutEffect(() => {
    const element = host.current
    if (!element) return
    const original = editor.createModel(documents[0].source, documents[0].language)
    const modified = editor.createModel(documents[1].source, documents[1].language)
    const diff = editor.createDiffEditor(element, {
      ...baseOptions,
      ...fontOptions(latest.current.font),
      ariaLabel: 'Comparación de documentos',
      renderSideBySide: latest.current.wide,
      useInlineViewWhenSpaceIsLimited: true,
      readOnly: true,
      originalEditable: false,
      maxFileSize: 5,
      maxComputationTime: 2500,
      ignoreTrimWhitespace: false,
    })
    instance.current = diff
    const unbindWheel = bindWheel(element, () => {
      const active = document.activeElement
      return [diff.getOriginalEditor(), diff.getModifiedEditor()].some(view => view.hasTextFocus() && !!active && view.getDomNode()?.contains(active))
    }, delta => latest.current.onZoom(delta))
    const viewModel = diff.createViewModel({ original, modified })
    diff.setModel(viewModel)
    const equal = documents[0].source === documents[1].source
    const timeout = window.setTimeout(() => latest.current.onStatus('La comparación tardó demasiado. Vuelve a los documentos para revisarlos.'), 8000)
    let disposed = false
    void viewModel.waitForDiff().then(() => {
      if (disposed) return
      window.clearTimeout(timeout)
      const changes = diff.getLineChanges()
      latest.current.onStatus(equal ? 'Los documentos son idénticos.' : changes?.length ? 'Diferencias resaltadas.' : 'No se pudo resaltar la diferencia. Ambos documentos siguen disponibles.')
    }).catch(() => {
      if (!disposed) {
        window.clearTimeout(timeout)
        latest.current.onStatus('No se pudo calcular la comparación.')
      }
    })
    diff.focus()
    return () => {
      disposed = true
      instance.current = null
      window.clearTimeout(timeout)
      unbindWheel()
      diff.dispose()
      viewModel.dispose()
      original.dispose()
      modified.dispose()
    }
  }, [documents])

  useLayoutEffect(() => {
    const diff = instance.current
    diff?.updateOptions({ renderSideBySide: wide, ...fontOptions(font) })
  }, [font, wide])

  return <div ref={host} data-testid="document-editor-diff" className="min-h-0 min-w-0 flex-1 overflow-hidden" />
}
