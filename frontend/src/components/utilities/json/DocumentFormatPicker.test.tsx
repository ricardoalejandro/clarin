import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DocumentFormatPicker } from './DocumentFormatPicker'

beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }) })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

it('portals choices, filters at exactly 500ms, and clears immediately', async () => {
  const change = vi.fn()
  render(<DocumentFormatPicker value="strict" width={72} onChange={change} />)
  fireEvent.click(screen.getByRole('combobox', { name: 'Formato del documento' }))
  expect(screen.getByRole('dialog', { name: 'Elegir formato del documento' }).parentElement).toBe(document.body)
  const input = screen.getByRole('combobox', { name: 'Buscar formato' })
  vi.useFakeTimers()
  fireEvent.change(input, { target: { value: 'TypeScript' } })
  expect(screen.getAllByRole('option')).toHaveLength(14)
  expect(screen.getByRole('status')).toHaveTextContent('Preparando búsqueda')
  await act(async () => { await vi.advanceTimersByTimeAsync(499) })
  expect(screen.getAllByRole('option')).toHaveLength(14)
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(screen.getAllByRole('option')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Limpiar búsqueda de formatos' }))
  expect(screen.getAllByRole('option')).toHaveLength(14)
  fireEvent.click(screen.getByRole('option', { name: /JSON con comentarios/ }))
  expect(change).toHaveBeenCalledExactlyOnceWith('jsonc')
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  expect(screen.getByRole('combobox', { name: 'Formato del documento' })).toHaveFocus()
})

it('supports keyboard selection and Escape without changing the document mode', () => {
  const change = vi.fn()
  render(<DocumentFormatPicker value="strict" width={72} onChange={change} />)
  const trigger = screen.getByRole('combobox', { name: 'Formato del documento' })
  trigger.focus()
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  const search = screen.getByRole('combobox', { name: 'Buscar formato' })
  fireEvent.keyDown(search, { key: 'End' })
  fireEvent.keyDown(search, { key: 'Enter' })
  expect(change).toHaveBeenCalledExactlyOnceWith('sql')
  fireEvent.click(trigger)
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Buscar formato' }), { key: 'Escape' })
  expect(change).toHaveBeenCalledTimes(1)
  expect(trigger).toHaveFocus()
})
