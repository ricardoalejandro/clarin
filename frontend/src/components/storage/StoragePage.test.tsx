import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import StoragePage from '@/app/dashboard/storage/page'
import { api, apiGet } from '@/lib/api'
import { completeAuthIdentityChange } from '@/lib/authScope'
import { type StorageFile, type StorageFilesResponse, type StorageUsage } from './storageModel'

vi.mock('@/lib/api', () => ({ api: vi.fn(), apiGet: vi.fn(), apiBlob: vi.fn().mockResolvedValue({ success: false, error: 'Sin vista previa' }) }))
vi.mock('./StoragePreview', () => ({ MediaIcon: () => <span />, StorageThumbnail: () => <span />, StoragePreview: ({ file, onClose }: { file: StorageFile; onClose: () => void }) => <div role="dialog"><span>{file.filename}</span><button onClick={onClose}>Cerrar visor</button></div> }))
const file = (key: string, extra: Partial<StorageFile> = {}): StorageFile => ({ object_key: key, filename: `${key}.pdf`, media_type: 'document', size_bytes: 4096, origins: [{ type: 'chats', label: 'Chat de prueba' }], references_count: 1, status: 'active', can_remove: true, ...extra })
const initialFiles = [file('a'), file('b'), file('protected', { can_remove: false, blocked_reason: 'Se usa en una campaña.' })]
const usage: StorageUsage & { success: true } = { success: true, scope: 'account', used_bytes: 204800, visible_bytes: 12288, limit_bytes: 1048576, available_bytes: 843776, percent_used: 20, object_count: 3, by_type: { document: 12288 }, by_origin: { chats: 12288 }, removable_bytes: 8192, removable_count: 2, trash_bytes: 0, can_manage: true, retention_days: 7 }
let response: StorageFilesResponse
let usageResponse = usage
const list = () => ({ success: true as const, data: response })
const mockGet = vi.mocked(apiGet)
const mockApi = vi.mocked(api)

beforeEach(() => {
  localStorage.clear(); completeAuthIdentityChange(); usageResponse = usage
  response = { success: true, files: initialFiles, total: 3, limit: 40, offset: 0, next_offset: 40, has_more: false, can_manage: true }
  mockGet.mockReset(); mockApi.mockReset()
  mockGet.mockImplementation(async endpoint => endpoint === '/api/storage/usage' ? { success: true, data: usageResponse } : endpoint.startsWith('/api/storage/activity') ? { success: true, data: { success: true, operations: [], total: 0, has_more: false } } : list())
  HTMLElement.prototype.scrollIntoView = vi.fn()
})
afterEach(() => { cleanup(); vi.useRealTimers() })
const loaded = async () => { render(<StoragePage />); await screen.findByRole('checkbox', { name: 'Seleccionar a.pdf' }) }
const selectA = () => fireEvent.click(screen.getByRole('checkbox', { name: 'Seleccionar a.pdf' }))
const staged = { success: true, preview_id: 'review-1', expires_at: '2099-10-10T10:00:00Z', action: 'trash', items: [{ object_key: 'a', filename: 'a.pdf', size_bytes: 4096, eligible: true }], eligible_count: 1, estimated_bytes: 4096 }

describe('storage complete workflow', () => {
  it('stages a review without deleting, confirms exactly once, and reports retained space honestly', async () => {
    await loaded(); selectA()
    mockApi.mockResolvedValueOnce({ success: true, data: staged })
    fireEvent.click(screen.getByRole('button', { name: 'Revisar selección' }))
    const dialog = await screen.findByRole('dialog', { name: 'Revisar eliminación' })
    expect(mockApi).toHaveBeenCalledTimes(1)
    expect(mockApi.mock.calls[0][0]).toBe('/api/storage/cleanup/preview')
    expect(JSON.parse(mockApi.mock.calls[0][1]!.body as string)).toEqual({ object_keys: ['a'], action: 'trash' })
    expect(within(dialog).getByText(/El espacio se liberará cuando/)).toBeTruthy()
    let finish: (value: unknown) => void = () => {}
    mockApi.mockImplementationOnce(() => new Promise(resolve => { finish = resolve as typeof finish }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mover a la papelera' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mover a la papelera' }))
    expect(mockApi).toHaveBeenCalledTimes(2)
    await act(async () => finish({ success: true, data: { success: true, operation_id: 'op', status: 'completed', action: 'trash', items: [{ object_key: 'a', filename: 'a.pdf', status: 'completed' }], freed_bytes: 0, retained_bytes: 4096 } }))
    expect(await screen.findByText(/Todavía no se ha liberado espacio/)).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('checkbox', { name: 'Seleccionar a.pdf' })).not.toBeChecked()
  })
  it('retains failed selection and exposes errors instead of announcing full success', async () => {
    await loaded(); selectA(); fireEvent.click(screen.getByRole('checkbox', { name: 'Seleccionar b.pdf' }))
    mockApi.mockResolvedValueOnce({ success: true, data: { ...staged, eligible_count: 2 } })
    fireEvent.click(screen.getByRole('button', { name: 'Revisar selección' }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByRole('button', { name: 'Mover a la papelera' })
    mockApi.mockResolvedValueOnce({ success: true, data: { success: true, operation_id: 'op', status: 'partial', action: 'trash', items: [{ object_key: 'a', filename: 'a.pdf', status: 'completed' }, { object_key: 'b', filename: 'b.pdf', status: 'failed', reason: 'Inténtalo de nuevo.' }], freed_bytes: 0, retained_bytes: 4096 } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mover a la papelera' }))
    await screen.findByText(/1 no se pudieron procesar/)
    expect(screen.getByRole('checkbox', { name: 'Seleccionar b.pdf' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Seleccionar a.pdf' })).not.toBeChecked()
  })
  it('cancels staging without writes and blocks protected files', async () => {
    await loaded()
    expect(screen.getByRole('checkbox', { name: 'Seleccionar protected.pdf' })).toBeDisabled()
    selectA(); mockApi.mockResolvedValueOnce({ success: true, data: staged })
    fireEvent.click(screen.getByRole('button', { name: 'Revisar selección' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('dialog')).toBeNull(); expect(mockApi).toHaveBeenCalledTimes(1)
  })
  it('returns focus to the re-enabled invoker when Escape closes a pending review', async () => {
    await loaded(); selectA()
    const trigger = screen.getByRole('button', { name: 'Revisar selección' })
    trigger.focus()
    let finish: (value: unknown) => void = () => {}
    mockApi.mockImplementationOnce(() => {
      // Chromium drops focus when the invoker becomes disabled, before the
      // dialog effect can capture it. JSDOM needs that focus loss explicitly.
      trigger.blur()
      return new Promise(resolve => { finish = resolve as typeof finish })
    })
    fireEvent.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: 'Revisar eliminación' })
    expect(trigger).toBeDisabled()
    within(dialog).getByRole('button', { name: 'Cerrar ventana' }).focus()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(trigger).toBeEnabled()
    expect(trigger).toHaveFocus()
    expect(mockApi.mock.calls[0][1]?.signal?.aborted).toBe(true)
    await act(async () => finish({ success: true, data: staged }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(trigger).toHaveFocus()
    expect(screen.getByRole('checkbox', { name: 'Seleccionar a.pdf' })).toBeChecked()
  })
  it('uses real pagination and preserves selection across pages beyond 200 files', async () => {
    response = { ...response, total: 241, has_more: true, next_offset: 240 }
    await loaded(); selectA()
    response = { ...response, files: [file('last')], offset: 240, total: 241, has_more: false }
    fireEvent.click(screen.getByRole('button', { name: 'Página siguiente' }))
    await screen.findByRole('checkbox', { name: 'Seleccionar last.pdf' })
    expect(mockGet.mock.calls.some(([path]) => path.includes('offset=240'))).toBe(true)
    expect(screen.getByText(/1 seleccionado ·/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Página siguiente' })).toBeDisabled()
  })
  it('never exposes quota availability or management actions for an authorized read-only view', async () => {
    usageResponse = { ...usage, scope: 'authorized', can_manage: false }; response = { ...response, can_manage: false }
    render(<StoragePage />)
    await screen.findByText('Archivos a los que tienes acceso')
    await screen.findByText(/Necesitas permiso/)
    expect(screen.queryByRole('checkbox')).toBeNull(); expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.queryByText(/843/)).toBeNull(); expect(screen.getByRole('button', { name: 'Revisar archivos' })).toBeDisabled()
  })
  it('rejects late account responses and destroys selection on identity change', async () => {
    await loaded(); selectA()
    let finish: (value: unknown) => void = () => {}
    mockGet.mockImplementationOnce(() => new Promise(resolve => { finish = resolve as typeof finish }))
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar' }))
    response = { ...response, files: [file('account-b')], total: 1 }
    act(() => { completeAuthIdentityChange() })
    await screen.findByRole('checkbox', { name: 'Seleccionar account-b.pdf' })
    await act(async () => finish({ success: true, data: { ...usage, visible_bytes: 999999 } }))
    expect(screen.queryByRole('checkbox', { name: 'Seleccionar a.pdf' })).toBeNull()
    expect(screen.queryByText(/1 seleccionado ·/)).toBeNull()
  })
  it('debounces typing at 500 ms, aborts predecessors, and clears immediately', async () => {
    await loaded(); vi.useFakeTimers(); mockGet.mockClear()
    fireEvent.change(screen.getByRole('textbox', { name: 'Buscar archivos' }), { target: { value: 'informe' } })
    await act(async () => { vi.advanceTimersByTime(499) }); expect(mockGet).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(1) })
    expect(mockGet.mock.calls.filter(([path]) => path.includes('q=informe'))).toHaveLength(1)
    mockGet.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Limpiar búsqueda' }))
    await act(async () => {})
    expect(mockGet.mock.calls.some(([path]) => path.startsWith('/api/storage/files') && !path.includes('q='))).toBe(true)
  })
  it('expires reviews before confirmation and requires a fresh review', async () => {
    await loaded(); selectA(); mockApi.mockResolvedValueOnce({ success: true, data: { ...staged, expires_at: '2000-01-01T00:00:00Z' } })
    fireEvent.click(screen.getByRole('button', { name: 'Revisar selección' }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText(/La revisión venció/)
    expect(within(dialog).queryByRole('button', { name: 'Mover a la papelera' })).toBeNull()
    expect(within(dialog).getByRole('button', { name: 'Volver a revisar' })).toBeEnabled()
  })
  it('retries a durable pending operation after reload using its original ID without creating a new review', async () => {
    await loaded()
    mockGet.mockImplementation(async endpoint => endpoint === '/api/storage/usage' ? { success: true, data: usageResponse } : endpoint.startsWith('/api/storage/activity') ? { success: true, data: { success: true, operations: [{ id: 'durable-operation', action: 'purge', status: 'processing', can_retry: true, created_at: '2026-10-10T10:00:00Z', files_count: 0, freed_bytes: 0, retained_bytes: 4096 }], total: 1, has_more: false } } : list())
    fireEvent.click(screen.getByRole('tab', { name: 'Actividad' }))
    await screen.findByText('Eliminación pendiente')
    mockApi.mockResolvedValueOnce({ success: true, data: { success: true, operation_id: 'durable-operation', status: 'completed', action: 'purge', items: [{ object_key: 'a', filename: 'a.pdf', status: 'completed' }], freed_bytes: 4096, retained_bytes: 0 } })
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar operación' }))
    await screen.findByText(/Espacio liberado: 4.0 KB/)
    expect(mockApi).toHaveBeenCalledTimes(1)
    expect(mockApi.mock.calls[0][0]).toBe('/api/storage/cleanup/confirm')
    expect(JSON.parse(mockApi.mock.calls[0][1]!.body as string)).toEqual({ preview_id: 'durable-operation' })
  })
  it.each([
    { reason: 'La eliminación está pendiente. Puedes reintentarla desde Actividad.', canRestore: false },
    { reason: 'El archivo volvió a utilizarse y se conservará.', canRestore: true },
  ])('explains a blocked trash item instead of promising purge availability: $reason', async ({ reason, canRestore }) => {
    await loaded()
    response = { ...response, files: [file('retained', { status: 'trash', can_remove: false, can_restore: canRestore, can_purge: false, purge_after: '2000-01-01T12:00:00Z', blocked_reason: reason })], total: 1 }
    fireEvent.click(screen.getByRole('tab', { name: 'Papelera' }))
    const checkbox = await screen.findByRole('checkbox', { name: 'Seleccionar retained.pdf' })
    const row = checkbox.closest('article')!
    expect(row.textContent).toContain(reason)
    expect(row.textContent).toContain('Retención mínima hasta')
    expect(row.textContent).not.toContain('Borrado disponible desde')
    expect(row.textContent).not.toContain('Disponible para borrado definitivo')
    if (canRestore) expect(checkbox).toBeEnabled()
    else expect(checkbox).toBeDisabled()
  })
  it.each([
    { scope: 'account' as const, label: 'Tus operaciones y los borrados definitivos de esta cuenta' },
    { scope: 'authorized' as const, label: 'Tus operaciones de almacenamiento' },
  ])('describes the authorized activity scope for $scope', async ({ scope, label }) => {
    usageResponse = { ...usage, scope }
    await loaded()
    fireEvent.click(screen.getByRole('tab', { name: 'Actividad' }))
    expect(await screen.findByText(label)).toBeTruthy()
    expect(screen.queryByText('Historial de las operaciones de esta cuenta')).toBeNull()
  })
  it('keeps a retry failure visible after the inventory refresh succeeds', async () => {
    await loaded()
    mockGet.mockImplementation(async endpoint => endpoint === '/api/storage/usage' ? { success: true, data: usageResponse } : endpoint.startsWith('/api/storage/activity') ? { success: true, data: { success: true, operations: [{ id: 'op', action: 'purge', status: 'processing', can_retry: true, created_at: '2026-10-10T10:00:00Z', files_count: 0, freed_bytes: 0, retained_bytes: 4096 }], total: 1, has_more: false } } : list())
    fireEvent.click(screen.getByRole('tab', { name: 'Actividad' }))
    await screen.findByRole('button', { name: 'Reintentar operación' })
    mockApi.mockResolvedValueOnce({ success: false, error: 'No se pudo confirmar la eliminación.' })
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar operación' }))
    await screen.findByText('No se pudo confirmar la eliminación.')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reintentar operación' })).toBeEnabled())
    expect(screen.getByRole('alert').textContent).toContain('No se pudo confirmar la eliminación.')
  })
  it('debounces typing a deletion to empty, while allowing a deliberate clear immediately', async () => {
    await loaded(); vi.useFakeTimers()
    fireEvent.change(screen.getByRole('textbox', { name: 'Buscar archivos' }), { target: { value: 'informe' } })
    await act(async () => vi.advanceTimersByTime(500)); mockGet.mockClear()
    fireEvent.change(screen.getByRole('textbox', { name: 'Buscar archivos' }), { target: { value: '' } })
    await act(async () => vi.advanceTimersByTime(499)); expect(mockGet).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTime(1))
    expect(mockGet.mock.calls.filter(([path]) => path.startsWith('/api/storage/files') && !path.includes('q='))).toHaveLength(1)
  })

  it('explains the account quota gap without exposing technical files', async () => {
    usageResponse = { ...usage, managed_elsewhere_bytes: 1048576 }
    await loaded()
    expect(screen.getByText('1.0 MB corresponden a contenido gestionado desde otros módulos.')).toBeTruthy()
    expect(screen.queryByText(/MinIO|tabla|logs/)).toBeNull()
  })

})
