import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import EventRulesEditor from './EventRulesEditor'
import { emptyEventRule } from './eventConfiguration'
const { mockApi } = vi.hoisted(() => ({ mockApi: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: mockApi }))
beforeEach(() => { vi.useFakeTimers(); mockApi.mockReset(); mockApi.mockResolvedValue({ success: true, data: { success: true, tags: [] } }) })
afterEach(() => { cleanup(); vi.useRealTimers() })
it('waits exactly 500 ms, aborts predecessors and ignores their late result', async () => {
  let finishFirst!: (value: unknown) => void
  mockApi.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve }))
  render(<EventRulesEditor value={emptyEventRule()} onChange={vi.fn()} />)
  const input = screen.getByLabelText('Buscar etiquetas para reglas')
  fireEvent.change(input, { target: { value: 'Vieja' } })
  await act(async () => { vi.advanceTimersByTime(499) })
  expect(mockApi).not.toHaveBeenCalled()
  await act(async () => { vi.advanceTimersByTime(1) })
  expect(mockApi).toHaveBeenCalledTimes(1)
  const signal = mockApi.mock.calls[0][1].signal as AbortSignal
  fireEvent.change(input, { target: { value: 'Nueva' } })
  expect(signal.aborted).toBe(true)
  await act(async () => { vi.advanceTimersByTime(500) })
  expect(mockApi.mock.calls[1][0]).toContain('search=Nueva')
  await act(async () => { finishFirst({ success: true, data: { success: true, tags: [{ id: 'old', name: 'Resultado obsoleto', color: '#123456' }] } }) })
  expect(screen.queryByText('Resultado obsoleto')).not.toBeInTheDocument()
  fireEvent.click(screen.getByLabelText('Limpiar búsqueda de etiquetas'))
  expect(input).toHaveValue('')
})
