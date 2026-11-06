import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { editor, MarkerSeverity } from 'monaco-editor'
import { documentLanguage, LARGE_DOCUMENT, LONG_LINE, type DocumentFormat, type Panel } from './editorWorkspaceState'
import { type DocumentMetrics } from './jsonLimits'

export interface DocumentSnapshot {
  source: string
  metrics: DocumentMetrics
  plainText?: boolean
  formatHint?: DocumentFormat
}

interface DocumentState {
  revision: number
  length: number
  reduced: boolean
  huge: boolean
  plainText: boolean
  undo: boolean
  redo: boolean
}

interface DocumentRuntime {
  model: editor.ITextModel
  view: editor.IStandaloneCodeEditor | null
  versions: Map<number, { metrics: DocumentMetrics; raw?: string; plainText?: boolean }>
  formatHistory: Map<number, DocumentFormat>
  applying: DocumentSnapshot | undefined
}

const initialState: DocumentState = { revision: 0, length: 0, reduced: false, huge: false, plainText: false, undo: false, redo: false }

export function useEditorDocuments(onChange: (panel: Panel, formatHint?: DocumentFormat) => void) {
  const [models, setModels] = useState<Partial<Record<Panel, editor.ITextModel>>>({})
  const [states, setStates] = useState({ a: initialState, b: initialState })
  const runtimes = useRef<Partial<Record<Panel, DocumentRuntime>>>({})
  const subscriptions = useRef<{ dispose(): void }[]>([])
  const changed = useRef(onChange)
  useLayoutEffect(() => { changed.current = onChange }, [onChange])

  const ensure = useCallback((panel: Panel) => {
    if (runtimes.current[panel]) return
    const model = editor.createModel('', 'json')
    // Keep LF input the same size on Windows and Linux. Imported CR/CRLF stays in its raw snapshot.
    model.setEOL(editor.EndOfLineSequence.LF)
    const runtime: DocumentRuntime = { model, view: null, versions: new Map(), formatHistory: new Map(), applying: undefined }
    runtimes.current[panel] = runtime
    const update = (change: editor.IModelContentChangedEvent) => {
      const revision = model.getVersionId()
      const version = model.getAlternativeVersionId()
      const applied = runtime.applying
      if (applied) {
        // Monaco normalizes line endings. Keep the original XML/text for transformations and export.
        const raw = applied.source.includes('\r') ? applied.source : undefined
        runtime.versions.set(version, { metrics: applied.metrics, raw, plainText: applied.plainText })
        const oldest = runtime.versions.keys().next().value
        if (runtime.versions.size > 4 && oldest !== undefined) runtime.versions.delete(oldest)
        if (applied.formatHint) runtime.formatHistory.set(version, applied.formatHint)
      }
      const saved = runtime.versions.get(version)
      const exact = saved?.metrics
      const length = model.getValueLength()
      const lineCount = model.getLineCount()
      const huge = exact ? exact.longestLine > LONG_LINE : change.changes.some(edit => {
        if (edit.text.length > LONG_LINE) {
          let run = 0
          for (let index = 0; index < edit.text.length; index++) {
            const code = edit.text.charCodeAt(index)
            run = code === 10 || code === 13 ? 0 : run + 1
            if (run > LONG_LINE) return true
          }
        }
        return model.getLineLength(Math.min(lineCount, edit.range.startLineNumber)) > LONG_LINE
      })
      if (huge && runtime.view?.getModel() === model) runtime.view.setModel(null)
      const reduced = huge || (exact?.bytes ?? length) >= LARGE_DOCUMENT || lineCount >= 200_000
      editor.setModelMarkers(model, 'clarin-document', [])
      setStates(current => ({ ...current, [panel]: {
        revision, length, reduced, huge, plainText: saved?.plainText ?? false, undo: model.canUndo(), redo: model.canRedo(),
      } }))
      changed.current(panel, runtime.formatHistory.get(version))
    }
    subscriptions.current.push(model.onDidChangeContent(update))
    setModels(current => ({ ...current, [panel]: model }))
  }, [])

  useLayoutEffect(() => {
    ensure('a')
    const active = runtimes.current
    return () => {
      for (const sub of subscriptions.current.splice(0)) sub.dispose()
      for (const runtime of Object.values(active)) runtime.model.dispose()
      runtimes.current = {}
    }
  }, [ensure])

  function replace(panel: Panel, next: DocumentSnapshot, currentFormat?: DocumentFormat) {
    const runtime = runtimes.current[panel]
    if (!runtime) return
    const { model, view } = runtime
    if (source(panel) === next.source) return
    if (next.formatHint && currentFormat) runtime.formatHistory.set(model.getAlternativeVersionId(), currentFormat)
    if (next.metrics.longestLine > LONG_LINE && view?.getModel() === model) view.setModel(null)
    runtime.applying = next
    model.pushStackElement()
    try {
      model.pushEditOperations(view?.getModel() === model ? view.getSelections() : null, [{ range: model.getFullModelRange(), text: next.source }], () => null)
    } finally {
      model.pushStackElement()
      runtime.applying = undefined
    }
  }

  function setFormat(panel: Panel, format: DocumentFormat) {
    const runtime = runtimes.current[panel]
    if (runtime) runtime.formatHistory.set(runtime.model.getAlternativeVersionId(), format)
  }

  function source(panel: Panel) {
    const runtime = runtimes.current[panel]
    return runtime?.versions.get(runtime.model.getAlternativeVersionId())?.raw ?? runtime?.model.getValue(undefined, true) ?? ''
  }

  function syncLanguage(panel: Panel, format: DocumentFormat, reduced: boolean) {
    const model = runtimes.current[panel]?.model
    if (!model) return
    const language = documentLanguage(format, reduced)
    if (model.getLanguageId() !== language) editor.setModelLanguage(model, language)
  }

  function mark(panel: Panel, line: number, column: number, message: string) {
    const model = runtimes.current[panel]?.model
    if (!model) return
    const position = model.validatePosition({ lineNumber: line, column })
    editor.setModelMarkers(model, 'clarin-document', [{
      severity: MarkerSeverity.Error, message,
      startLineNumber: position.lineNumber, endLineNumber: position.lineNumber,
      startColumn: position.column, endColumn: Math.min(position.column + 1, model.getLineMaxColumn(position.lineNumber)),
    }])
  }

  return { ensure, models, states, runtimes, replace, source, syncLanguage, setFormat, mark }
}
