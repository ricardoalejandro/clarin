import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import JsonUtility from './JsonUtility'
import { processJson, type DocumentWorkerRequest, type DocumentWorkerResponse } from './jsonOperations'
import { measureDocument } from './jsonLimits'
import { UtilityDocumentProvider, type UtilityDocumentSession } from '../library/UtilityDocumentContext'

vi.mock('monaco-editor', () => ({ editor: { setTheme: vi.fn(), setModelMarkers: vi.fn() } }))
vi.mock('./JsonCodeEditor', () => ({
  DocumentCodeEditor: ({ label, model, visible, wrap, onFocus }: { label: string; model: { text: string; write: (text: string) => void }; visible: boolean; wrap: boolean; onFocus: () => void }) =>
    <textarea aria-label={label} hidden={!visible} wrap={wrap ? 'soft' : 'off'} value={model.text} onFocus={onFocus} onChange={event => model.write(event.target.value)} />,
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

it('restores a selected empty second panel and tolerates invalid saved editor preferences', async () => {
  const session: UtilityDocumentSession = {
    documentId: 'document-b', initialState: { 'json.active': 'b', 'json.split': true, 'json.font': 5000, 'json.formats': null },
    readSlot: vi.fn(async () => null), setState: vi.fn(), setSlot: vi.fn(), getSlot: vi.fn(), flush: vi.fn(async () => true),
  }
  render(<UtilityDocumentProvider value={session}><JsonUtility /></UtilityDocumentProvider>)
  expect(await screen.findByRole('textbox', { name: 'Documento B' })).toBeVisible()
  expect(screen.getByRole('combobox', { name: 'Formato del documento' })).toHaveValue('strict')
  expect(screen.getByRole('button', { name: 'Restablecer zoom del editor' })).toHaveTextContent('100%')
})

it('keeps the document actions directly accessible and limits JSON actions to JSON modes', () => {
  render(<JsonUtility />)
  const actions = within(screen.getByRole('group', { name: 'Acciones del documento activo' }))
  for (const name of ['Reparar', 'Escapar', 'Desescapar', 'Copiar documento', 'Descargar documento', 'Limpiar documento']) {
    expect(actions.getByRole('button', { name })).toBeVisible()
  }
  fireEvent.change(screen.getByRole('combobox', { name: 'Formato del documento' }), { target: { value: 'xml' } })
  expect(actions.queryByRole('button', { name: 'Reparar' })).not.toBeInTheDocument()
  expect(actions.getByRole('button', { name: 'Descargar documento' })).toBeVisible()
})

it('reports and resets the zoom and keeps visual wrapping independent for each panel', () => {
  render(<JsonUtility />)
  const zoom = screen.getByRole('button', { name: 'Restablecer zoom del editor' })
  expect(zoom).toHaveTextContent('100%')
  fireEvent.click(screen.getByRole('button', { name: 'Aumentar letra', hidden: true }))
  expect(zoom).toHaveTextContent('107%')
  fireEvent.click(zoom)
  expect(zoom).toHaveTextContent('100%')

  const wrap = screen.getByRole('button', { name: 'Ajustar líneas' })
  const a = screen.getByRole('textbox', { name: 'Documento A' })
  fireEvent.change(a, { target: { value: '{"a":1}' } })
  fireEvent.click(wrap)
  expect(a).toHaveAttribute('wrap', 'soft')
  expect(a).toHaveValue('{"a":1}')
  fireEvent.click(screen.getByRole('button', { name: 'Mostrar segundo panel' }))
  fireEvent.click(screen.getByRole('button', { name: 'Ver documento B' }))
  expect(wrap).toHaveAttribute('aria-pressed', 'false')
  expect(screen.getByRole('textbox', { name: 'Documento B' })).toHaveAttribute('wrap', 'off')
  fireEvent.click(screen.getByRole('button', { name: 'Ver documento A' }))
  expect(wrap).toHaveAttribute('aria-pressed', 'true')
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
  fireEvent.click(screen.getByRole('button', { name: 'Reparar' }))
  expect(await screen.findByText('Propuesta de reparación · Documento A')).toBeInTheDocument()
  expect(a).toHaveValue('{//id://dfdf}')
  fireEvent.click(screen.getByRole('button', { name: 'Aplicar reparación' }))
  expect(a).toHaveValue('{}')
})

it('preserves the source when a worker fails instead of clearing the editor', async () => {
  class FailedWorker {
    onerror?: (event: { preventDefault(): void }) => void
    terminate() {}
    postMessage() { queueMicrotask(() => this.onerror?.({ preventDefault() {} })) }
  }
  vi.stubGlobal('Worker', FailedWorker)
  render(<JsonUtility />)
  const input = screen.getByRole('textbox', { name: 'Documento A' })
  fireEvent.change(input, { target: { value: '{"preserve":9007199254740993}' } })
  fireEvent.click(screen.getByRole('button', { name: 'Formatear' }))
  await screen.findByText('No se pudo procesar el documento. Puedes reintentar.')
  expect(input).toHaveValue('{"preserve":9007199254740993}')
})

it('cancels a worker and rejects its late result without changing either draft', async () => {
  class PendingWorker {
    static current: PendingWorker
    onmessage?: (event: { data: DocumentWorkerResponse }) => void
    terminated = false
    constructor() { PendingWorker.current = this }
    postMessage() {}
    terminate() { this.terminated = true }
  }
  vi.stubGlobal('Worker', PendingWorker)
  render(<JsonUtility />)
  const input = screen.getByRole('textbox', { name: 'Documento A' })
  fireEvent.change(input, { target: { value: '{"preserve":1}' } })
  fireEvent.click(screen.getByRole('button', { name: 'Formatear' }))
  const worker = PendingWorker.current
  fireEvent.click(screen.getByRole('button', { name: 'Cancelar operación' }))
  expect(worker.terminated).toBe(true)
  worker.onmessage?.({ data: { kind: 'transform', result: { ok: true, message: 'obsolete', warnings: [], text: '{\n "preserve": 2\n}', metrics: measureDocument('{\n "preserve": 2\n}') } } })
  expect(input).toHaveValue('{"preserve":1}')
  expect(screen.getByText('Operación cancelada.')).toBeInTheDocument()
})

it('stops a pending transformation synchronously before the library freezes and disposes its source', async () => {
  class PendingWorker {
    static current: PendingWorker
    onmessage?: (event: { data: DocumentWorkerResponse }) => void
    terminated = false
    constructor() { PendingWorker.current = this }
    postMessage() {}
    terminate() { this.terminated = true }
  }
  vi.stubGlobal('Worker', PendingWorker)
  let deactivate: (() => void) | undefined
  const unregister = vi.fn()
  const session: UtilityDocumentSession = {
    documentId: 'freeze-document', initialState: {}, readSlot: vi.fn(async () => null), setState: vi.fn(), setSlot: vi.fn(), getSlot: vi.fn(), flush: vi.fn(async () => true),
    registerBeforeDeactivate: callback => { deactivate = callback; return unregister },
  }
  const { unmount } = render(<UtilityDocumentProvider value={session}><JsonUtility /></UtilityDocumentProvider>)
  const input = screen.getByRole('textbox', { name: 'Documento A' })
  fireEvent.change(input, { target: { value: '{"frozen":1}' } })
  fireEvent.click(screen.getByRole('button', { name: 'Formatear' }))
  const pending = PendingWorker.current
  act(() => deactivate?.())
  expect(pending.terminated).toBe(true)
  pending.onmessage?.({ data: { kind: 'transform', result: { ok: true, warnings: [], message: 'late', text: '{"frozen":2}', metrics: measureDocument('{"frozen":2}') } } })
  expect(input).toHaveValue('{"frozen":1}')
  unmount()
  expect(unregister).toHaveBeenCalledOnce()
})

it('does not start another panel read after deactivation while restoration is awaiting content', async () => {
  let resolveRead!: (value: Blob | null) => void
  let deactivate!: () => void
  const readSlot = vi.fn(() => new Promise<Blob | null>(resolve => { resolveRead = resolve }))
  const session: UtilityDocumentSession = {
    documentId: 'pending-read-document', initialState: {}, readSlot, setState: vi.fn(), setSlot: vi.fn(), getSlot: vi.fn(), flush: vi.fn(async () => true),
    registerBeforeDeactivate: callback => { deactivate = callback; return () => {} },
  }
  render(<UtilityDocumentProvider value={session}><JsonUtility /></UtilityDocumentProvider>)
  expect(readSlot).toHaveBeenCalledOnce()
  act(() => deactivate())
  await act(async () => { resolveRead(null); await Promise.resolve() })
  expect(readSlot).toHaveBeenCalledOnce()
  expect(readSlot).toHaveBeenCalledWith('panel-a')
})
