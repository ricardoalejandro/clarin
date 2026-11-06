'use client'

import { useLayoutEffect, useRef } from 'react'
import { editor, json, languages, Position, Range } from 'monaco-editor'
import { jsonLiteralCompletions, xmlClosingTagCompletion } from './documentCompletions'
import { acceptsEditorZoom, tramRange } from './editorWorkspaceState'

globalThis.MonacoEnvironment = {
  getWorker(_moduleId, label) {
    if (label === 'json') return new Worker(new URL('./monacoJson.worker.ts', import.meta.url), { type: 'module' })
    return new Worker(new URL('./monacoEditor.worker.ts', import.meta.url), { type: 'module' })
  },
}

// JSON and JSONC can be open together. Explicit local validation owns diagnostics.
json.jsonDefaults.setDiagnosticsOptions({ validate: false, schemas: [], enableSchemaRequest: false })
json.jsonDefaults.setModeConfiguration({ ...json.jsonDefaults.modeConfiguration, documentFormattingEdits: false, documentRangeFormattingEdits: false })

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
  visible: boolean
  reduced: boolean
  chunk: number | null
  revision: number
  onZoom: (delta: number) => void
  onFocus: () => void
  onPaste: (event: ClipboardEvent, start: number, end: number) => void
  onReady: (view: editor.IStandaloneCodeEditor | null) => void
}

export function DocumentCodeEditor(props: Props) {
  const { id, model, label, font, visible, reduced, chunk, revision } = props
  const host = useRef<HTMLDivElement>(null)
  const instance = useRef<editor.IStandaloneCodeEditor>(null)
  const viewState = useRef<editor.ICodeEditorViewState | null>(null)
  const preview = useRef<editor.ITextModel | null>(null)
  const previewState = useRef<{ chunk: number; revision: number; view: editor.ICodeEditorViewState | null } | null>(null)
  const latest = useRef(props)
  useLayoutEffect(() => { latest.current = props }, [props])

  useLayoutEffect(() => {
    const element = host.current
    if (!element) return
    const view = editor.create(element, { ...baseOptions, model: null, ariaLabel: label })
    instance.current = view
    const focus = view.onDidFocusEditorText(() => latest.current.onFocus())
    const paste = (event: ClipboardEvent) => {
      const selection = view.getSelection()
      if (!selection || view.getModel() !== model) return
      latest.current.onPaste(event, model.getOffsetAt(selection.getStartPosition()), model.getOffsetAt(selection.getEndPosition()))
    }
    const unbindWheel = bindWheel(element, () => view.hasTextFocus(), delta => latest.current.onZoom(delta))
    element.addEventListener('paste', paste, true)
    latest.current.onReady(view)
    return () => {
      instance.current = null
      latest.current.onReady(null)
      element.removeEventListener('paste', paste, true)
      unbindWheel()
      focus.dispose()
      view.dispose()
      preview.current?.dispose()
      preview.current = null
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
      const codeAt = (offset: number) => model.getValueInRange(Range.fromPositions(model.getPositionAt(offset), model.getPositionAt(offset + 1))).charCodeAt(0)
      const { start, end } = tramRange(length, chunk, codeAt)
      const first = model.getPositionAt(start)
      const last = model.getPositionAt(end)
      const text = model.getValueInRange(Range.fromPositions(first, last))
      preview.current ??= editor.createModel('', 'plaintext')
      if (view.getModel() !== preview.current) view.setModel(preview.current)
      if (preview.current.getValue() !== text) {
        preview.current.setValue(text)
        view.setScrollPosition({ scrollTop: 0, scrollLeft: 0 })
      }
      view.layout()
      const saved = previewState.current
      if (saved?.chunk === chunk && saved.revision === revision && saved.view) view.restoreViewState(saved.view)
      previewState.current = null
    } else if (view.getModel() !== model) {
      view.setModel(model)
      preview.current?.dispose()
      preview.current = null
      previewState.current = null
      view.layout()
      if (viewState.current) view.restoreViewState(viewState.current)
    }
  }, [model, visible, chunk, revision])

  useLayoutEffect(() => {
    instance.current?.updateOptions({
      ...fontOptions(font),
      readOnly: chunk !== null,
      domReadOnly: chunk !== null,
      ariaLabel: label,
      folding: !reduced,
      bracketPairColorization: { enabled: !reduced },
      matchBrackets: reduced ? 'never' : 'always',
      occurrencesHighlight: reduced ? 'off' : 'singleFile',
      quickSuggestions: !reduced,
      selectionHighlight: !reduced,
      stickyScroll: { enabled: false },
      wordWrap: chunk !== null ? 'bounded' : 'off',
      wordWrapColumn: 100,
      stopRenderingLineAfter: chunk !== null ? -1 : 100_000,
      placeholder: 'Pega texto o abre un archivo local.',
    })
  }, [font, label, reduced, chunk])

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
