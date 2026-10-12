import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import EventContactPicker from './EventContactPicker'
const mocks = vi.hoisted(() => ({ api: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: mocks.api }))
vi.mock('@/lib/authScope', () => ({ getAuthScope: () => 'test-scope', subscribeAuthScope: () => () => {} }))
vi.mock('@/components/operational-window/OperationalWindowShell', () => ({ default: ({ open, children, footer }: { open: boolean; children: ReactNode; footer: ReactNode }) => open ? <section>{children}{footer}</section> : null }))
const first = { contact: { id: 'one', name: 'Ana', phone: '123' }, membership_status: 'not_added', eligibility: 'eligible', can_add: true }
const active = { contact: { id: 'two', name: 'Luis' }, participant_id: 'participant-two', membership_status: 'active', eligibility: 'eligible', can_add: false }
const page = { candidates: [first, active], total: 20001, has_more: false, has_rules: false, event_status: 'active', counts: { available: 20000, already_active: 1, inactive: 0, ineligible: 0, matches: 20001 } }
const selection = { selection_id: 'selection-one', selected: 20000, new: 19990, reactivations: 10, expires_at: '2099-01-01T00:00:00Z' }
const result = { selection_id: selection.selection_id, operation_id: 'operation', created: 19990, reactivated: 10, already_active: 0, total_active: 20001, stage_counts: {}, completed_at: '2026-01-01' }
const props = { eventId: 'event', eventName: 'Evento prueba', open: true, onClose: vi.fn(), onAdded: vi.fn() }
function defaultAPI(path: string) {
 if (path.startsWith('/api/tags')) return Promise.resolve({ success: true, data: { tags: [{ id: 'tag-one', name: 'Prioridad', color: '#123456' }] } })
 return Promise.resolve({ success: true, data: { page } })
}
beforeEach(() => { mocks.api.mockReset().mockImplementation(defaultAPI); sessionStorage.clear(); props.onClose.mockReset(); props.onAdded.mockReset() })
afterEach(() => { cleanup(); vi.useRealTimers() })
describe('EventContactPicker', () => {
 it('keeps filter changes staged and requests bounded remote tags', async () => {
  render(<EventContactPicker {...props} />)
  await screen.findByLabelText('Seleccionar Ana')
  fireEvent.click(screen.getByRole('button', { name: 'Filtros' }))
  await screen.findByText('Prioridad')
  const calls = mocks.api.mock.calls.length
  fireEvent.click(screen.getByLabelText('Solo contactos con teléfono'))
  fireEvent.click(screen.getByLabelText('Prioridad'))
  expect(mocks.api).toHaveBeenCalledTimes(calls)
  expect(mocks.api).toHaveBeenCalledWith('/api/tags?limit=20&search=', expect.objectContaining({ signal: expect.any(AbortSignal) }))
  fireEvent.click(screen.getByRole('button', { name: 'Aplicar filtros' }))
  await waitFor(() => expect(mocks.api).toHaveBeenCalledWith(expect.stringContaining('has_phone=true'), expect.anything()))
  expect(mocks.api.mock.calls.some(([path]) => path.includes('tag_ids=tag-one'))).toBe(true)
 })
 it('debounces search exactly 500ms and aborts its predecessor', async () => {
  vi.useFakeTimers()
  render(<EventContactPicker {...props} />)
  await act(async () => {})
  const original = mocks.api.mock.calls[0][1].signal as AbortSignal
  mocks.api.mockClear()
  fireEvent.change(screen.getByLabelText('Buscar contactos'), { target: { value: 'Ana & José' } })
  expect(original.aborted).toBe(true)
  await act(async () => { vi.advanceTimersByTime(499) })
  expect(mocks.api).not.toHaveBeenCalled()
  await act(async () => { vi.advanceTimersByTime(1) })
  expect(mocks.api).toHaveBeenCalledTimes(1)
  expect(mocks.api.mock.calls[0][0]).toContain('search=Ana+%26+Jos%C3%A9')
 })
 it('keeps selection while inspecting a participant and suspending the window', async () => {
  const inspect = vi.fn()
  const view = render(<EventContactPicker {...props} onInspectParticipant={inspect} />)
  fireEvent.click(await screen.findByLabelText('Seleccionar Ana'))
  fireEvent.click(screen.getByRole('button', { name: 'Ver participante Luis' }))
  expect(inspect).toHaveBeenCalledWith('participant-two', 'two')
  expect(props.onClose).not.toHaveBeenCalled()
  view.rerender(<EventContactPicker {...props} onInspectParticipant={inspect} suspended />)
  view.rerender(<EventContactPicker {...props} onInspectParticipant={inspect} />)
  expect(screen.getByLabelText('Seleccionar Ana')).toBeChecked()
 })
 it('freezes a prepared selection when the event closes remotely and preserves it on reopening', async () => {
  const view = render(<EventContactPicker {...props} />)
  fireEvent.click(await screen.findByLabelText('Seleccionar Ana'))
  view.rerender(<EventContactPicker {...props} readOnly />)
  expect(screen.getByLabelText('Seleccionar Ana')).toBeChecked()
  expect(screen.getByLabelText('Seleccionar Ana')).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Revisar selección' })).toBeDisabled()
  expect(screen.getByText(/Tu selección se conserva/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Revisar selección' }))
  expect(mocks.api.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
  view.rerender(<EventContactPicker {...props} readOnly={false} />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Revisar selección' })).toBeEnabled())
  expect(screen.getByLabelText('Seleccionar Ana')).toBeChecked()
 })
 it('blocks confirmation when the event closes after review while retaining the frozen selection', async () => {
  mocks.api.mockImplementation((path: string, options?: RequestInit) => {
   if (path.endsWith('/participant-selections') && options?.method === 'POST') return Promise.resolve({ success: true, data: { selection } })
   if (path.includes('/participant-selections/selection-one')) return Promise.resolve({ success: true, data: { selection, page } })
   return defaultAPI(path)
  })
  const view = render(<EventContactPicker {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: /Seleccionar todos los disponibles/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Revisar selección' }))
  await screen.findByRole('button', { name: /Confirmar 20/ })
  view.rerender(<EventContactPicker {...props} readOnly />)
  expect(screen.getByRole('button', { name: /Confirmar 20/ })).toBeDisabled()
  expect(screen.getByText(/Tu selección se conserva/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /Confirmar 20/ }))
  expect(mocks.api.mock.calls.some(([path]) => path.endsWith('/confirm'))).toBe(false)
  view.rerender(<EventContactPicker {...props} readOnly={false} />)
  await waitFor(() => expect(screen.getByRole('button', { name: /Confirmar 20/ })).toBeEnabled())
 })
 it('previews all matches with a small filter payload and recovers a lost confirmation', async () => {
  let confirmed = false
  mocks.api.mockImplementation((path: string, options?: RequestInit) => {
   if (path.endsWith('/participant-selections') && options?.method === 'POST') return Promise.resolve({ success: true, data: { selection } })
   if (path.endsWith('/confirm')) { confirmed = true; return Promise.resolve({ success: false, status: 503, error: 'Respuesta perdida' }) }
   if (path.includes('/participant-selections/selection-one')) return Promise.resolve({ success: true, data: confirmed ? { selection: { ...selection, result } } : { selection, page } })
   return defaultAPI(path)
  })
  const view = render(<EventContactPicker {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: /Seleccionar todos los disponibles/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Revisar selección' }))
  await screen.findByRole('button', { name: /Confirmar 20/ })
  const prepare = mocks.api.mock.calls.find(([path, options]) => path.endsWith('/participant-selections') && options?.method === 'POST')!
  const payload = JSON.parse(prepare[1].body)
  expect(payload.mode).toBe('filtered')
  expect(payload).not.toHaveProperty('contact_ids')
  expect(prepare[1].body.length).toBeLessThan(300)
  fireEvent.click(screen.getByRole('button', { name: /Confirmar 20/ }))
  await screen.findByRole('button', { name: 'Comprobar resultado' })
  view.rerender(<EventContactPicker {...props} readOnly />)
  expect(screen.getByRole('button', { name: 'Comprobar resultado' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: 'Comprobar resultado' }))
  await waitFor(() => expect(props.onAdded).toHaveBeenCalledExactlyOnceWith(result))
  expect(mocks.api.mock.calls.filter(([path]) => path.endsWith('/confirm'))).toHaveLength(1)
 })
 it('retries an uncertain operation with the same identifier without replacing its frozen review', async () => {
  const operations: string[] = []
  mocks.api.mockImplementation((path: string, options?: RequestInit) => {
   if (path.endsWith('/participant-selections') && options?.method === 'POST') return Promise.resolve({ success: true, data: { selection } })
   if (path.endsWith('/confirm')) {
    operations.push(JSON.parse(String(options?.body)).operation_id)
    return Promise.resolve(operations.length === 1 ? { success: false, error: 'Respuesta perdida' } : { success: true, data: { result } })
   }
   if (path.includes('/participant-selections/selection-one')) return Promise.resolve({ success: true, data: { selection, page } })
   return defaultAPI(path)
  })
  render(<EventContactPicker {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: /Seleccionar todos los disponibles/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Revisar selección' }))
  fireEvent.click(await screen.findByRole('button', { name: /Confirmar 20/ }))
  fireEvent.click(await screen.findByRole('button', { name: 'Comprobar resultado' }))
  await screen.findByText(/Todavía no hay un resultado confirmado/)
  expect(screen.queryByRole('button', { name: 'Volver' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /Confirmar 20/ }))
  await waitFor(() => expect(props.onAdded).toHaveBeenCalledExactlyOnceWith(result))
  expect(operations).toHaveLength(2)
  expect(operations[1]).toBe(operations[0])
 })

 it.each(['trailing whitespace', 'return to the settled term'])('restarts an aborted search after 500ms when input changes by %s', async variant => {
  vi.useFakeTimers()
  render(<EventContactPicker {...props} />)
  await act(async () => {})
  let resolvePrevious!: (value: unknown) => void
  mocks.api.mockImplementationOnce(() => new Promise(resolve => { resolvePrevious = resolve }))
  fireEvent.change(screen.getByLabelText('Buscar contactos'), { target: { value: 'Ana' } })
  await act(async () => { vi.advanceTimersByTime(500) })
  const previousSignal = mocks.api.mock.calls.at(-1)![1].signal as AbortSignal
  const calls = mocks.api.mock.calls.length
  if (variant === 'trailing whitespace') {
   fireEvent.change(screen.getByLabelText('Buscar contactos'), { target: { value: 'Ana ' } })
  } else {
   fireEvent.change(screen.getByLabelText('Buscar contactos'), { target: { value: 'Anab' } })
   fireEvent.change(screen.getByLabelText('Buscar contactos'), { target: { value: 'Ana' } })
  }
  expect(previousSignal.aborted).toBe(true)
  await act(async () => { vi.advanceTimersByTime(499) })
  expect(mocks.api).toHaveBeenCalledTimes(calls)
  await act(async () => { vi.advanceTimersByTime(1) })
  expect(mocks.api).toHaveBeenCalledTimes(calls + 1)
  expect(mocks.api.mock.calls.at(-1)![0]).toContain('search=Ana')
  expect(screen.getByLabelText('Seleccionar Ana')).not.toBeDisabled()
  await act(async () => resolvePrevious({ success: false, error: 'Obsolete search failed' }))
  expect(screen.queryByText('Obsolete search failed')).not.toBeInTheDocument()
 })

 it('releases a purged receipt after recovery returns 404 and allows a fresh review', async () => {
  let confirmationSent = false
  mocks.api.mockImplementation((path: string, options?: RequestInit) => {
   if (path.endsWith('/participant-selections') && options?.method === 'POST') return Promise.resolve({ success: true, data: { selection } })
   if (path.endsWith('/confirm')) { confirmationSent = true; return Promise.resolve({ success: false, error: 'Respuesta perdida' }) }
   if (path.includes('/participant-selections/selection-one')) {
    if (confirmationSent && !path.includes('?review=true')) return Promise.resolve({ success: false, status: 404, error: 'La revisión ya no está disponible' })
    return Promise.resolve({ success: true, data: { selection, page } })
   }
   return defaultAPI(path)
  })
  render(<EventContactPicker {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: /Seleccionar todos los disponibles/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Revisar selección' }))
  fireEvent.click(await screen.findByRole('button', { name: /Confirmar 20/ }))
  expect(sessionStorage.length).toBe(1)
  fireEvent.click(await screen.findByRole('button', { name: 'Comprobar resultado' }))
  const reviewAgain = await screen.findByRole('button', { name: 'Revisar selección' })
  await waitFor(() => expect(reviewAgain).toBeEnabled())
  expect(sessionStorage.length).toBe(0)
  expect(screen.queryByRole('button', { name: 'Comprobar resultado' })).not.toBeInTheDocument()
  fireEvent.click(reviewAgain)
  await screen.findByRole('button', { name: /Confirmar 20/ })
  expect(mocks.api.mock.calls.filter(([path, options]) => path.endsWith('/participant-selections') && options?.method === 'POST')).toHaveLength(2)
 })

})
