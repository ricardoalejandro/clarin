import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import JsonUtility from './JsonUtility'
import type JsonCodeEditor from './JsonCodeEditor'
import { processJson, type JsonRequest, type JsonResult } from './jsonOperations'

vi.mock('./JsonCodeEditor', async () => {
  const { useImperativeHandle, useState } = await import('react')
  return {
    default: ({ label, editorRef, readOnly, value, onEdit }: ComponentProps<typeof JsonCodeEditor>) => {
      const [text, setText] = useState('')
      const update = (next: string) => { setText(next); onEdit?.(next) }
      useImperativeHandle(editorRef, () => ({ replace: update, focus() {}, selectAll() {}, undo() {}, redo() {} }))
      return <textarea aria-label={label} readOnly={readOnly} value={readOnly ? value : text} onChange={event => update(event.target.value)} />
    },
  }
})

class JsonWorker {
  onmessage?: (event: { data: JsonResult }) => void
  private active = true

  postMessage(request: JsonRequest) {
    queueMicrotask(() => {
      if (this.active) this.onmessage?.({ data: processJson(request) })
    })
  }

  terminate() { this.active = false }
}

afterEach(() => vi.unstubAllGlobals())

it('previews a repair without editing the Monaco source until the user applies it', async () => {
  vi.stubGlobal('Worker', JsonWorker)
  render(<JsonUtility />)
  const source = await screen.findByRole('textbox', { name: 'Entrada JSON' })
  const output = screen.getByRole('textbox', { name: 'Resultado JSON' })
  fireEvent.change(source, { target: { value: '{//id://dfdf}' } })
  fireEvent.click(screen.getByRole('button', { name: 'Reparar' }))
  expect(await screen.findByText('Fragmento original afectado')).toBeInTheDocument()
  expect(output).toHaveValue('{}')
  expect(source).toHaveValue('{//id://dfdf}')
  fireEvent.click(screen.getByRole('button', { name: 'Usar como entrada' }))
  expect(source).toHaveValue('{}')
  expect(output).toHaveValue('')
})
