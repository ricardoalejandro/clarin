import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import JsonUtility from './JsonUtility'
import { processJson, type DocumentWorkerRequest, type DocumentWorkerResponse } from './jsonOperations'
import { measureDocument } from './jsonLimits'

vi.mock('monaco-editor', () => ({ editor: { setTheme: vi.fn(), setModelMarkers: vi.fn() } }))
vi.mock('./JsonCodeEditor', () => ({
  DocumentCodeEditor: ({ label, model, visible, onFocus }: { label: string; model: { text: string; write: (text: string) => void }; visible: boolean; onFocus: () => void }) =>
    <textarea aria-label={label} hidden={!visible} value={model.text} onFocus={onFocus} onChange={event => model.write(event.target.value)} />,
  DocumentDiff: () => <div>Comparación</div>,
  registerDocumentCompletions: () => () => {},
}))
vi.mock('./useEditorDocuments', async () => {
  const { useRef, useState } = await import('react')
  return {
    useEditorDocuments(onChange: (panel: 'a' | 'b') => void) {
      const [texts, setTexts] = useState({ a: '', b: '' })
      const [hasB, setHasB] = useState(false)
      const revisions = useRef({ a: 0, b: 0 })
      const runtime = useRef({ a: { model: { getVersionId: () => revisions.current.a } }, b: { model: { getVersionId: () => revisions.current.b } } })
      const write = (panel: 'a' | 'b', text: string) => {
        revisions.current[panel]++
        setTexts(current => ({ ...current, [panel]: text }))
        onChange(panel)
      }
      const model = (panel: 'a' | 'b') => ({ text: texts[panel], write: (text: string) => write(panel, text) })
      const state = (panel: 'a' | 'b') => ({ length: texts[panel].length, revision: revisions.current[panel] })
      return {
        ensure: (panel: 'a' | 'b') => { if (panel === 'b') setHasB(true) },
        models: { a: model('a'), b: hasB ? model('b') : undefined },
        states: { a: state('a'), b: state('b') },
        runtimes: runtime,
        replace: (panel: 'a' | 'b', next: { source: string }) => write(panel, next.source),
        source: (panel: 'a' | 'b') => texts[panel],
        syncLanguage: vi.fn(),
        setFormat: vi.fn(),
        mark: vi.fn(),
      }
    },
  }
})

class JsonWorker {
  onmessage?: (event: { data: DocumentWorkerResponse }) => void
  private active = true

  postMessage(request: DocumentWorkerRequest) {
    queueMicrotask(() => {
      if (!this.active || request.kind !== 'transform') return
      const result = processJson(request)
      if (result.ok && result.text !== undefined) result.metrics = measureDocument(result.text)
      this.onmessage?.({ data: { kind: 'transform', result } })
    })
  }

  terminate() { this.active = false }
}

beforeEach(() => vi.stubGlobal('ResizeObserver', class {
  observe() {}
  disconnect() {}
}))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('uses Clarin’s high-contrast form style only in the dark theme', () => {
  render(<JsonUtility />)
  const syntax = screen.getByRole('combobox', { name: 'Formato del documento' })
  expect(syntax).toHaveClass('dark-input')
  fireEvent.change(screen.getByLabelText('Tema'), { target: { value: 'light' } })
  expect(syntax).not.toHaveClass('dark-input')
})

it('formats only the active document and keeps the hidden draft', async () => {
  vi.stubGlobal('Worker', JsonWorker)
  render(<JsonUtility />)
  const a = screen.getByRole('textbox', { name: 'Documento A' })
  fireEvent.change(a, { target: { value: '{"a":1}' } })
  fireEvent.click(screen.getByRole('button', { name: 'Mostrar segundo panel' }))
  fireEvent.click(screen.getByRole('button', { name: 'Ver documento B' }))
  const b = screen.getByRole('textbox', { name: 'Documento B' })
  fireEvent.change(b, { target: { value: '{"b":2}' } })
  fireEvent.click(screen.getByRole('button', { name: 'Formatear' }))
  await screen.findByText(/formato aplicado/i)
  expect(b).toHaveValue('{\n  "b": 2\n}')
  expect(a).toHaveValue('{"a":1}')
  fireEvent.click(screen.getByRole('button', { name: 'Ocultar panel B' }))
  expect(screen.getByRole('textbox', { name: 'Documento A' })).toHaveValue('{"a":1}')
  fireEvent.click(screen.getByRole('button', { name: 'Mostrar segundo panel' }))
  fireEvent.click(screen.getByRole('button', { name: 'Ver documento B' }))
  expect(screen.getByRole('textbox', { name: 'Documento B' })).toHaveValue('{\n  "b": 2\n}')
})

it('stages a repair and applies it only after explicit confirmation', async () => {
  vi.stubGlobal('Worker', JsonWorker)
  render(<JsonUtility />)
  const a = screen.getByRole('textbox', { name: 'Documento A' })
  fireEvent.change(a, { target: { value: '{//id://dfdf}' } })
  fireEvent.click(screen.getByText('Reparar', { selector: 'button' }))
  expect(await screen.findByText('Propuesta de reparación · Documento A')).toBeInTheDocument()
  expect(a).toHaveValue('{//id://dfdf}')
  fireEvent.click(screen.getByRole('button', { name: 'Aplicar reparación' }))
  expect(a).toHaveValue('{}')
})
