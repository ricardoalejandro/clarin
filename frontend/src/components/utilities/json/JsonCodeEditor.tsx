'use client'

import { useImperativeHandle, useLayoutEffect, useRef, type Ref } from 'react'
import { editor, json } from 'monaco-editor'
import { fitsJsonInput } from './jsonLimits'

const { jsonDefaults } = json

globalThis.MonacoEnvironment = {
  getWorker(_moduleId, label) {
    if (label === 'json') return new Worker(new URL('./monacoJson.worker.ts', import.meta.url), { type: 'module' })
    return new Worker(new URL('./monacoEditor.worker.ts', import.meta.url), { type: 'module' })
  },
}

export interface JsonEditorHandle {
  focus: () => void
  replace: (value: string) => void
  selectAll: () => void
  undo: () => void
  redo: () => void
}

export interface JsonEditorHistory {
  undo: boolean
  redo: boolean
}

interface Props {
  label: string
  placeholder: string
  readOnly?: boolean
  value?: string
  onEdit?: (value: string) => void
  onHistoryChange?: (value: JsonEditorHistory) => void
  onLargePaste?: () => void
  onReady?: () => void
  allowComments?: boolean
  language?: 'json' | 'plaintext'
  editorRef: Ref<JsonEditorHandle>
}

export default function JsonCodeEditor(props: Props) {
  const { editorRef, label, readOnly = false, value, placeholder, allowComments = false, language = 'json' } = props
  const host = useRef<HTMLDivElement>(null)
  const instance = useRef<editor.IStandaloneCodeEditor>(null)
  const current = useRef(props)

  useLayoutEffect(() => { current.current = props }, [props])

  useImperativeHandle(editorRef, () => ({
    focus: () => instance.current?.focus(),
    replace: (text) => {
      const view = instance.current
      const model = view?.getModel()
      if (!view || !model || model.getValue() === text) return
      view.pushUndoStop()
      view.executeEdits('clarin.utilities', [{ range: model.getFullModelRange(), text }])
      view.pushUndoStop()
    },
    selectAll: () => {
      const view = instance.current
      const model = view?.getModel()
      if (!view || !model) return
      view.focus()
      view.setSelection(model.getFullModelRange())
    },
    undo: () => instance.current?.trigger('clarin.utilities', 'undo', null),
    redo: () => instance.current?.trigger('clarin.utilities', 'redo', null),
  }), [])

  useLayoutEffect(() => {
    const element = host.current
    if (!element) return
    const model = editor.createModel(current.current.value ?? '', current.current.language ?? 'json')
    const view = editor.create(element, {
      model,
      ariaLabel: label,
      automaticLayout: true,
      bracketPairColorization: { enabled: true },
      colorDecorators: false,
      domReadOnly: readOnly,
      editContext: false,
      folding: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
      fontSize: 14,
      lineHeight: 23,
      lineNumbers: 'on',
      matchBrackets: 'always',
      minimap: { enabled: false },
      padding: { top: 10, bottom: 10 },
      placeholder: current.current.placeholder,
      readOnly,
      scrollBeyondLastLine: false,
      tabIndex: 0,
      theme: 'vs',
      wordBasedSuggestions: 'off',
    })
    instance.current = view

    const change = view.onDidChangeModelContent(() => {
      if (readOnly) return
      current.current.onEdit?.(model.getValue())
      queueMicrotask(() => {
        if (instance.current === view) current.current.onHistoryChange?.({ undo: model.canUndo(), redo: model.canRedo() })
      })
    })

    const guardPaste = (event: ClipboardEvent) => {
      if (readOnly || fitsJsonInput(event.clipboardData?.getData('text/plain') ?? '')) return
      event.preventDefault()
      event.stopPropagation()
      current.current.onLargePaste?.()
    }
    element.addEventListener('paste', guardPaste, true)
    current.current.onReady?.()

    return () => {
      instance.current = null
      element.removeEventListener('paste', guardPaste, true)
      change.dispose()
      view.dispose()
      model.dispose()
      if (!readOnly) jsonDefaults.setDiagnosticsOptions(jsonDefaults.diagnosticsOptions)
    }
  }, [label, readOnly])

  useLayoutEffect(() => {
    const view = instance.current
    if (!view) return
    view.updateOptions({ placeholder })
    const model = view.getModel()
    if (model && model.getLanguageId() !== language) editor.setModelLanguage(model, language)
    if (readOnly && value !== undefined && view.getValue() !== value) view.setValue(value)
  }, [language, placeholder, readOnly, value])

  useLayoutEffect(() => {
    if (readOnly) return
    jsonDefaults.setDiagnosticsOptions({
      validate: true,
      allowComments,
      comments: allowComments ? 'ignore' : 'error',
      trailingCommas: allowComments ? 'ignore' : 'error',
      schemas: [],
      enableSchemaRequest: false,
    })
  }, [allowComments, readOnly])

  return <div ref={host} data-testid={readOnly ? 'json-monaco-result' : 'json-monaco-source'} className="w-full" style={{ height: 'clamp(16rem, 44vh, 32rem)' }} />
}
