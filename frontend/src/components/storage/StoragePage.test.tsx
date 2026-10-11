import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import StoragePage from '@/app/dashboard/storage/page'
import { api, apiGet, subscribeWebSocket } from '@/lib/api'
import { completeAuthIdentityChange } from '@/lib/authScope'
import { type StorageFile, type StorageFilesResponse, type StorageUsage } from './storageModel'

vi.mock('@/lib/api', () => ({ subscribeWebSocket: vi.fn(() => () => {}), api: vi.fn(), apiGet: vi.fn(), apiBlob: vi.fn().mockResolvedValue({ success: false, error: 'Sin vista previa' }) }))
vi.mock('@/components/operational-window/OperationalWindowShell', () => ({ default: ({ children, footer, title, onRequestClose }: { children: React.ReactNode; footer: React.ReactNode; title: string; onRequestClose: () => void }) => <section aria-label={`Detalles de ${title}`}>{children}{footer}<button onClick={onRequestClose}>Cerrar detalles</button></section> }))
vi.mock('./StoragePreview', () => ({ MediaIcon: () => <span />, StorageThumbnail: () => <span />, StoragePreview: ({ file, onClose }: { file: StorageFile; onClose: () => void }) => <div role="dialog"><span>{file.filename}</span><button onClick={onClose}>Cerrar visor</button></div> }))
const file = (key: string, extra: Partial<StorageFile> = {}): StorageFile => ({ object_key: key, filename: `${key}.pdf`, media_type: 'document', size_bytes: 4096, origins: [{ type: 'chats', label: 'Chat de prueba' }], references_count: 1, status: 'active', can_remove: true, ...extra })
const initialFiles = [file('a'), file('b'), file('protected', { can_remove: false, blocked_reason: 'Se usa en una campaña.' })]
const usage: StorageUsage & { success: true } = { success: true, account_id: 'account-a', scope: 'account', used_bytes: 204800, visible_bytes: 12288, limit_bytes: 1048576, available_bytes: 843776, percent_used: 20, object_count: 3, by_type: { document: 12288 }, by_origin: { chats: 12288 }, removable_bytes: 8192, removable_count: 2, trash_bytes: 0, can_manage: true, retention_days: 7 }
let response: StorageFilesResponse
let usageResponse = usage
const list = () => ({ success: true as const, data: response })
const mockGet = vi.mocked(apiGet)
const mockApi = vi.mocked(api)

beforeEach(() => {
  localStorage.clear(); completeAuthIdentityChange(); usageResponse = usage
  response = { success: true, files: initialFiles, total: 3, limit: 40, offset: 0, next_offset: 40, has_more: false, can_manage: true }
  vi.mocked(subscribeWebSocket).mockClear()
  mockGet.mockReset(); mockApi.mockReset()
  mockGet.mockImplementation(async endpoint => endpoint === '/api/storage/usage' ? { success: true, data: usageResponse } : endpoint.startsWith('/api/storage/activity') ? { success: true, data: { success: true, operations: [], total: 0, has_more: false } } : list())
  HTMLElement.prototype.scrollIntoView = vi.fn()
})
afterEach(() => { cleanup(); vi.useRealTimers() })
const loaded = async () => { render(<StoragePage />); await screen.findByRole('checkbox', { name: 'Seleccionar a.pdf' }) }
const selectA = () => fireEvent.click(screen.getByRole('checkbox', { name: 'Seleccionar a.pdf' }))
const staged = { success: true, preview_id: 'review-1', expires_at: '2099-10-10T10:00:00Z', action: 'trash', items: [{ object_key: 'a', filename: 'a.pdf', size_bytes: 4096, eligible: true }], eligible_count: 1, estimated_bytes: 4096 }
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(complete => { resolve = complete })
  return { promise, resolve }
}

describe('storage complete workflow', () => {
  it('renders a file page while the independent summary is still pending, including a filter change', async () => {
    const summary = deferred<unknown>()
    mockGet.mockImplementation(async endpoint => endpoint === '/api/storage/usage' ? await summary.promise as never : list())
    render(<StoragePage />)
    expect(await screen.findByRole('button', { name: 'a.pdf' })).toBeTruthy()
    const summarySignal = mockGet.mock.calls.find(([path]) => path === '/api/storage/usage')?.[1]?.signal
    fireEvent.click(screen.getByRole('button', { name: 'Videos' }))
    await waitFor(() => expect(mockGet.mock.calls.some(([path]) => path.includes('type=video'))).toBe(true))
    expect(summarySignal?.aborted).toBe(false)
    expect(mockGet.mock.calls.filter(([path]) => path === '/api/storage/usage')).toHaveLength(1)
    await act(async () => summary.resolve({ success: true, data: usage }))
    expect(await screen.findByRole('progressbar', { name: 'Espacio utilizado' })).toBeTruthy()
  })
  it('renders the verified summary while the independent file page is still pending', async () => {
    const files = deferred<unknown>()
    mockGet.mockImplementation(async endpoint => endpoint === '/api/storage/usage' ? { success: true, data: usage } : await files.promise as never)
    render(<StoragePage />)
    expect(await screen.findByRole('progressbar', { name: 'Espacio utilizado' })).toBeTruthy()
    expect(screen.getByRole('status', { name: 'Cargando archivos' })).toBeTruthy()
    await act(async () => files.resolve(list()))
    expect(await screen.findByRole('button', { name: 'a.pdf' })).toBeTruthy()
  })
  it('keeps loaded files usable after a summary error and retries the summary explicitly', async () => {
    let failed = true
    mockGet.mockImplementation(async endpoint => endpoint === '/api/storage/usage' ? failed ? { success: false, status: 503, error: 'Resumen temporalmente no disponible' } : { success: true, data: usage } : list())
    render(<StoragePage />)
    expect(await screen.findByRole('button', { name: 'a.pdf' })).toBeTruthy()
    expect(await screen.findByText('Resumen temporalmente no disponible')).toBeTruthy()
    failed = false
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar resumen' }))
    expect(await screen.findByRole('progressbar', { name: 'Espacio utilizado' })).toBeTruthy()
    expect(screen.queryByText('Resumen temporalmente no disponible')).toBeNull()
  })
  it('stages a review without deleting, confirms exactly once, and reports retained space honestly', async () => {
    await loaded(); selectA()
    mockApi.mockResolvedValueOnce({ success: true, data: staged })
    fireEvent.click(screen.getByRole('button', { name: 'Revisar selección' }))
    const dialog = await screen.findByRole('dialog', { name: 'Revisar eliminación' })
    expect(mockApi).toHaveBeenCalledTimes(1)
    expect(mockApi.mock.calls[0][0]).toBe('/api/storage/cleanup/preview')
    expect(JSON.parse(mockApi.mock.calls[0][1]!.body as string)).toEqual({ targets: [{ object_key: 'a', mode: 'file' }], action: 'trash' })
    expect(within(dialog).getByText(/El espacio se liberará cuando/)).toBeTruthy()
    let finish: (value: unknown) => void = () => {}
    mockApi.mockImplementationOnce(() => new Promise(resolve => { finish = resolve as typeof finish }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirmar retirada' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirmar retirada' }))
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
    await within(dialog).findByRole('button', { name: 'Confirmar retirada' })
    mockApi.mockResolvedValueOnce({ success: true, data: { success: true, operation_id: 'op', status: 'partial', action: 'trash', items: [{ object_key: 'a', filename: 'a.pdf', status: 'completed' }, { object_key: 'b', filename: 'b.pdf', status: 'failed', reason: 'Inténtalo de nuevo.' }], freed_bytes: 0, retained_bytes: 4096 } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirmar retirada' }))
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
    expect(within(dialog).queryByRole('button', { name: 'Confirmar retirada' })).toBeNull()
    expect(within(dialog).getByRole('button', { name: 'Volver a revisar' })).toBeEnabled()
  })
  it('retries a durable pending operation after reload using its original ID without creating a new review', async () => {
    await loaded()
    mockGet.mockImplementation(async endpoint => endpoint === '/api/storage/usage' ? { success: true, data: usageResponse } : endpoint.startsWith('/api/storage/activity') ? { success: true, data: { success: true, operations: [{ id: 'durable-operation', action: 'purge', status: 'processing', can_retry: true, created_at: '2026-10-10T10:00:00Z', files_count: 0, freed_bytes: 0, retained_bytes: 4096 }], total: 1, has_more: false } } : list())
    fireEvent.click(screen.getByRole('tab', { name: 'Actividad' }))
    await screen.findByText('Eliminación pendiente')
    mockApi.mockResolvedValueOnce({ success: true, data: { success: true, operation_id: 'durable-operation', status: 'completed', action: 'purge', items: [{ object_key: 'a', filename: 'a.pdf', status: 'completed' }], freed_bytes: 4096, retained_bytes: 0 } })
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar operación' }))
    await screen.findByText(/Espacio liberado: 4.0 KiB/)
    expect(mockApi).toHaveBeenCalledTimes(1)
    expect(mockApi.mock.calls[0][0]).toBe('/api/storage/cleanup/confirm')
    expect(JSON.parse(mockApi.mock.calls[0][1]!.body as string)).toEqual({ preview_id: 'durable-operation' })
  })
  it.each([
    { reason: 'La eliminación está pendiente. Puedes reintentarla desde Actividad.', canRestore: false },
    { reason: 'El archivo volvió a utilizarse y se conservará.', canRestore: true },
  ])('explains a blocked trash item instead of promising purge availability: $reason', async ({ reason, canRestore }) => {
    await loaded()
    response = { ...response, files: [file('retained', { status: 'trash', recovery_id: 'retained-recovery', can_remove: false, can_restore: canRestore, can_purge: false, purge_after: '2000-01-01T12:00:00Z', blocked_reason: reason })], total: 1 }
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
    expect(screen.getByText('1.0 MiB corresponden a contenido gestionado desde otros módulos.')).toBeTruthy()
    expect(screen.queryByText(/MinIO|tabla|logs/)).toBeNull()
  })

  it('reviews only selected uses from a protected shared file without a file selection', async () => {
    const useResponse = { success: true, uses: [{ use_id: 'chat-use', type: 'chats', label: 'Chat permitido', can_remove: true }, { use_id: 'published', type: 'campaigns', label: 'Publicación vigente', can_remove: false, blocked_reason: 'Está publicada.' }], limit: 40, total: 2, has_more: false }
    mockGet.mockImplementation(async endpoint => endpoint === '/api/storage/usage' ? { success: true, data: usageResponse } : endpoint.startsWith('/api/storage/uses?') ? { success: true, data: useResponse } : list())
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: 'protected.pdf' }))
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Seleccionar uso: Chat permitido' }))
    expect(screen.getByRole('checkbox', { name: 'Seleccionar uso: Publicación vigente' })).toBeDisabled()
    mockApi.mockResolvedValueOnce({ success: true, data: { ...staged, selected_uses_count: 1, retained_uses_visible_count: 1, retained_elsewhere: true, trash_bytes: 0 } })
    fireEvent.click(screen.getByRole('button', { name: 'Revisar usos seleccionados' }))
    const dialog = await screen.findByRole('dialog', { name: 'Revisar eliminación' })
    await within(dialog).findByText('1 uso seleccionado para retirar.')
    expect(JSON.parse(mockApi.mock.calls[0][1]!.body as string)).toEqual({ action: 'trash', targets: [{ object_key: 'protected', mode: 'uses', use_ids: ['chat-use'] }] })
    expect(within(dialog).getByText('1 uso visible se conserva.')).toBeTruthy()
    expect(within(dialog).getByText(/Espacio liberado ahora: 0 B/)).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: 'Seleccionar a.pdf' })).not.toBeChecked()
  })

  it('distinguishes two recoveries of the same object and sends only the selected recovery', async () => {
    await loaded()
    response = { ...response, total: 2, files: [file('shared', { recovery_id: 'first', filename: 'Primera retirada', status: 'trash', can_remove: false, can_restore: true }), file('shared', { recovery_id: 'second', filename: 'Segunda retirada', status: 'trash', can_remove: false, can_restore: true })] }
    fireEvent.click(screen.getByRole('tab', { name: 'Papelera' }))
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Seleccionar Segunda retirada' }))
    expect(screen.getByRole('checkbox', { name: 'Seleccionar Primera retirada' })).not.toBeChecked()
    mockApi.mockResolvedValueOnce({ success: true, data: { ...staged, action: 'restore' } })
    fireEvent.click(screen.getByRole('button', { name: 'Restaurar' }))
    await screen.findByRole('dialog')
    expect(JSON.parse(mockApi.mock.calls[0][1]!.body as string)).toEqual({ action: 'restore', recovery_ids: ['second'] })
  })

  it('applies an authorized recommendation as reproducible filters without writing', async () => {
    usageResponse = { ...usage, recommendations: [{ id: 'unused_uploads', count: 2, bytes: 8192, filters: { status: 'unused_uploads' } }] }
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: /Mis cargas sin utilizar/ }))
    await waitFor(() => expect(mockGet.mock.calls.some(([path]) => path.includes('status=unused_uploads'))).toBe(true))
    expect(mockApi).not.toHaveBeenCalled()
    expect(screen.getByRole('combobox', { name: 'Disponibilidad para limpiar' })).toHaveValue('unused_uploads')
  })

  it('ignores other accounts and preserves a staged review while canonical data reconciles', async () => {
    await loaded(); selectA()
    const message = () => vi.mocked(subscribeWebSocket).mock.calls.at(-1)![0]
    mockGet.mockClear()
    act(() => message()({ event: 'storage_changed', data: { account_id: 'account-b', revision: 2 } }))
    expect(mockGet).not.toHaveBeenCalled()
    mockApi.mockResolvedValueOnce({ success: true, data: staged })
    fireEvent.click(screen.getByRole('button', { name: 'Revisar selección' }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByRole('button', { name: 'Confirmar retirada' })
    act(() => message()({ event: 'storage_changed', data: { account_id: 'account-a', revision: 3, operation_id: 'local-operation' } }))
    expect(screen.getByRole('checkbox', { name: 'Seleccionar a.pdf' })).toBeChecked()
    expect(screen.queryByRole('status', { name: 'Cargando archivos' })).toBeNull()
    expect(within(dialog).getByRole('button', { name: 'Confirmar retirada' })).toBeEnabled()
    expect(within(dialog).queryByText(/El almacenamiento cambió/)).toBeNull()
    await waitFor(() => expect(mockGet.mock.calls.some(([path]) => path === '/api/storage/usage')).toBe(true))
  })

  it('keeps selection and impact review usable during continuous ordinary updates', async () => {
    await loaded()
    const background = deferred<ReturnType<typeof list>>()
    const impact = deferred<{ success: true; data: typeof staged }>()
    mockGet.mockImplementation(async endpoint => endpoint === '/api/storage/usage' ? { success: true, data: usageResponse } : background.promise)
    mockApi.mockReturnValueOnce(impact.promise)
    const message = vi.mocked(subscribeWebSocket).mock.calls.at(-1)![0]
    await act(async () => message({ event: 'storage_changed', data: { account_id: 'account-a', revision: 1 } }))
    expect(screen.getByRole('checkbox', { name: 'Seleccionar a.pdf' })).toBeEnabled()
    selectA()
    expect(screen.getByRole('button', { name: 'Revisar selección' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Revisar selección' }))
    const signal = mockApi.mock.calls[0][1]!.signal!
    for (const revision of [2, 3, 4]) await act(async () => message({ event: 'storage_changed', data: { account_id: 'account-a', revision } }))
    expect(signal.aborted).toBe(false)
    await act(async () => impact.resolve({ success: true, data: staged }))
    await act(async () => message({ event: 'storage_changed', data: { account_id: 'account-a', revision: 5 } }))
    expect(screen.getByRole('button', { name: 'Confirmar retirada' })).toBeEnabled()
    mockApi.mockResolvedValueOnce({ success: true, data: { success: true, operation_id: 'op', status: 'completed', action: 'trash', items: [{ object_key: 'a', filename: 'a.pdf', status: 'completed' }], freed_bytes: 0, retained_bytes: 4096 } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Confirmar retirada' })))
    expect(mockApi).toHaveBeenCalledTimes(2)
    expect(JSON.parse(mockApi.mock.calls[1][1]!.body as string)).toEqual({ preview_id: staged.preview_id })
    expect(screen.getByRole('region', { name: 'Resultado de la operación' })).toBeInTheDocument()
  })

  it('keeps actions disabled for old rows while a different filter is loading', async () => {
    await loaded()
    mockGet.mockImplementation(() => new Promise(() => {}))
    fireEvent.click(screen.getByRole('button', { name: 'Filtros' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Filtrar por origen' }), { target: { value: 'chats' } })
    expect(screen.getByRole('checkbox', { name: 'Seleccionar a.pdf' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Seleccionar archivos de esta página' })).toBeDisabled()
  })

  it('aborts an impact review and rejects its completion after an explicit access reset', async () => {
    await loaded(); selectA()
    const impact = deferred<{ success: true; data: typeof staged }>()
    mockApi.mockReturnValueOnce(impact.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Revisar selección' }))
    const signal = mockApi.mock.calls[0][1]!.signal!
    mockGet.mockImplementation(() => new Promise(() => {}))
    await act(async () => vi.mocked(subscribeWebSocket).mock.calls.at(-1)![0]({ event: 'storage_changed', data: { account_id: 'account-a', revision: 1, reason: 'access_changed' } }))
    expect(signal.aborted).toBe(true)
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () => impact.resolve({ success: true, data: staged }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('checkbox', { name: 'Seleccionar a.pdf' })).toBeNull()
  })

  it('redacts viewers and selected files immediately when Work access is revoked', async () => {
    await loaded(); selectA()
    fireEvent.click(screen.getByRole('button', { name: 'Ver a.pdf' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    mockGet.mockImplementation(() => new Promise(() => {}))
    act(() => vi.mocked(subscribeWebSocket).mock.calls.at(-1)![0]({ event: 'task_update', data: { action: 'access_revoked', target_type: 'task' } }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('checkbox', { name: 'Seleccionar a.pdf' })).toBeNull()
    expect(screen.queryByText(/1 seleccionado ·/)).toBeNull()
  })

  it('finishes an in-flight page under repeated ordinary events and coalesces one follow-up', async () => {
    await loaded()
    const first = deferred<ReturnType<typeof list>>()
    const latest = deferred<ReturnType<typeof list>>()
    let reads = 0
    mockGet.mockImplementation(async endpoint => endpoint === '/api/storage/usage'
      ? { success: true, data: usageResponse }
      : ++reads === 1 ? first.promise : latest.promise)
    fireEvent.click(screen.getByRole('tab', { name: 'Papelera' }))
    const signal = mockGet.mock.calls.at(-1)![1]!.signal!
    const message = vi.mocked(subscribeWebSocket).mock.calls.at(-1)![0]
    for (const revision of [1, 2, 3]) await act(async () => message({ event: 'storage_changed', data: { account_id: 'account-a', revision } }))
    expect(signal.aborted).toBe(false)
    expect(reads).toBe(1)
    const oldPage = { ...response, files: [file('first', { status: 'trash', recovery_id: 'first-recovery', can_restore: true })], total: 1 }
    await act(async () => first.resolve({ success: true, data: oldPage }))
    expect(screen.getByRole('button', { name: 'first.pdf' })).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Cargando archivos' })).toBeNull()
    expect(reads).toBe(2)
    await act(async () => latest.resolve({ success: true, data: { ...oldPage, files: [file('latest', { status: 'trash', recovery_id: 'latest-recovery', can_restore: true })] } }))
    expect(screen.getByRole('button', { name: 'latest.pdf' })).toBeInTheDocument()
    expect(screen.queryByText('Actualizando…')).toBeNull()
    expect(reads).toBe(2)
  })

  it('bounds a stalled page read and ignores its late response after retry', async () => {
    await loaded()
    vi.useFakeTimers()
    const stalled = deferred<ReturnType<typeof list>>()
    mockGet.mockImplementation(async endpoint => endpoint === '/api/storage/usage' ? { success: true, data: usageResponse } : stalled.promise)
    fireEvent.click(screen.getByRole('tab', { name: 'Papelera' }))
    const signal = mockGet.mock.calls.at(-1)![1]!.signal!
    await act(async () => vi.advanceTimersByTime(30_000))
    expect(signal.aborted).toBe(true)
    expect(screen.queryByRole('status', { name: 'Cargando archivos' })).toBeNull()
    expect(screen.getByText(/La consulta de archivos tardó demasiado/)).toBeInTheDocument()
    mockGet.mockImplementation(async endpoint => endpoint === '/api/storage/usage' ? { success: true, data: usageResponse } : list())
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Actualizar' })))
    expect(screen.getByRole('button', { name: 'a.pdf' })).toBeInTheDocument()
    await act(async () => stalled.resolve({ success: true, data: { ...response, files: [file('stale')], total: 1 } }))
    expect(screen.queryByRole('button', { name: 'stale.pdf' })).toBeNull()
    expect(screen.getByRole('button', { name: 'a.pdf' })).toBeInTheDocument()
  })

  it('interrupts queued ordinary refreshes immediately when account access is revoked', async () => {
    await loaded(); selectA()
    const stale = deferred<ReturnType<typeof list>>()
    const canonical = deferred<ReturnType<typeof list>>()
    let reads = 0
    mockGet.mockImplementation(async endpoint => endpoint === '/api/storage/usage'
      ? { success: true, data: usageResponse }
      : ++reads === 1 ? stale.promise : canonical.promise)
    const message = vi.mocked(subscribeWebSocket).mock.calls.at(-1)![0]
    await act(async () => message({ event: 'storage_changed', data: { account_id: 'account-a', revision: 1 } }))
    const signal = mockGet.mock.calls.at(-1)![1]!.signal!
    await act(async () => message({ event: 'storage_changed', data: { account_id: 'account-a', revision: 2 } }))
    await act(async () => message({ event: 'storage_changed', data: { account_id: 'account-a', revision: 3, reason: 'access_changed' } }))
    expect(signal.aborted).toBe(true)
    expect(screen.queryByRole('checkbox', { name: 'Seleccionar a.pdf' })).toBeNull()
    expect(screen.queryByText(/1 seleccionado ·/)).toBeNull()
    await act(async () => stale.resolve(list()))
    expect(screen.queryByRole('checkbox', { name: 'Seleccionar a.pdf' })).toBeNull()
    await act(async () => canonical.resolve({ success: true, data: { ...response, files: [], total: 0, can_manage: false } }))
    expect(screen.getByText('No hay archivos disponibles')).toBeInTheDocument()
  })

  it('bounds a stalled impact review without losing its selection and accepts an explicit retry', async () => {
    await loaded(); selectA()
    vi.useFakeTimers()
    const stalled = deferred<{ success: true; data: typeof staged }>()
    mockApi.mockReturnValueOnce(stalled.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Revisar selección' }))
    const signal = mockApi.mock.calls[0][1]!.signal!
    await act(async () => vi.advanceTimersByTime(30_000))
    expect(signal.aborted).toBe(true)
    expect(screen.queryByText('Comprobando dónde se utilizan los archivos…')).toBeNull()
    expect(screen.getByText(/La revisión tardó demasiado/)).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Seleccionar a.pdf' })).toBeChecked()
    mockApi.mockResolvedValueOnce({ success: true, data: { ...staged, preview_id: 'fresh-review' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Volver a revisar' })))
    await act(async () => stalled.resolve({ success: true, data: staged }))
    mockApi.mockResolvedValueOnce({ success: false, status: 503, error: 'Fallo de prueba' })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Confirmar retirada' })))
    expect(JSON.parse(mockApi.mock.calls[2][1]!.body as string)).toEqual({ preview_id: 'fresh-review' })
  })

  it('discards a conflicted review and requires a fresh impact check before confirming again', async () => {
    await loaded(); selectA()
    mockApi.mockResolvedValueOnce({ success: true, data: staged })
    fireEvent.click(screen.getByRole('button', { name: 'Revisar selección' }))
    const confirm = await screen.findByRole('button', { name: 'Confirmar retirada' })
    mockApi.mockResolvedValueOnce({ success: false, status: 409, error: 'El archivo cambió. Vuelve a revisar.' })
    fireEvent.click(confirm)
    await screen.findByText('El archivo cambió. Vuelve a revisar.')
    expect(screen.queryByRole('button', { name: 'Confirmar retirada' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Volver a revisar' })).toBeEnabled()
    expect(screen.getByRole('checkbox', { name: 'Seleccionar a.pdf' })).toBeChecked()
    mockApi.mockResolvedValueOnce({ success: true, data: { ...staged, preview_id: 'fresh-review' } })
    fireEvent.click(screen.getByRole('button', { name: 'Volver a revisar' }))
    await screen.findByRole('button', { name: 'Confirmar retirada' })
    expect(mockApi.mock.calls[2][0]).toBe('/api/storage/cleanup/preview')
  })

  it('discards sensitive cached rows on a forbidden canonical response', async () => {
    await loaded(); selectA()
    mockGet.mockResolvedValue({ success: false, status: 403, error: 'Permiso revocado' })
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar' }))
    await screen.findByText(/Tu acceso al almacenamiento cambió/)
    expect(screen.queryByRole('checkbox', { name: 'Seleccionar a.pdf' })).toBeNull()
    expect(screen.queryByText(/1 seleccionado ·/)).toBeNull()
  })

  it('protects an individual-use draft when opening a different file from the workspace', async () => {
    mockGet.mockImplementation(async endpoint => endpoint === '/api/storage/usage' ? { success: true, data: usageResponse } : endpoint.startsWith('/api/storage/uses?') ? { success: true, data: { success: true, uses: [{ use_id: 'selected', type: 'chats', label: 'Uso seleccionado', can_remove: true }], limit: 40, has_more: false } } : list())
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: 'a.pdf' }))
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Seleccionar uso: Uso seleccionado' }))
    fireEvent.click(screen.getByRole('button', { name: 'b.pdf' }))
    const decision = await screen.findByRole('dialog', { name: 'Cambiar de archivo' })
    expect(screen.getByRole('region', { name: 'Detalles de a.pdf' })).toBeTruthy()
    fireEvent.click(within(decision).getByRole('button', { name: 'Seguir revisando' }))
    expect(screen.getByRole('checkbox', { name: 'Seleccionar uso: Uso seleccionado' })).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'b.pdf' }))
    fireEvent.click(screen.getByRole('button', { name: 'Descartar selección y cambiar' }))
    await waitFor(() => expect(screen.getByRole('region', { name: 'Detalles de b.pdf' })).toBeTruthy())
    expect(screen.getByRole('checkbox', { name: 'Seleccionar uso: Uso seleccionado' })).not.toBeChecked()
    expect(mockApi).not.toHaveBeenCalled()
  })

  it('preserves a valid selection when usage temporarily fails and keeps management disabled until retry', async () => {
    await loaded(); selectA()
    mockGet.mockImplementation(async endpoint => endpoint === '/api/storage/usage' ? { success: false, status: 503, error: 'Verificación temporalmente no disponible' } : list())
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar' }))
    await screen.findByText(/Verificación temporalmente no disponible/)
    expect(screen.getByRole('checkbox', { name: 'Seleccionar a.pdf' })).toBeChecked()
    expect(screen.getByRole('button', { name: 'Revisar selección' })).toBeDisabled()
  })
  it('redacts cached content on reconnect before canonical access is known', async () => {
    await loaded(); selectA()
    const reconnect = vi.mocked(subscribeWebSocket).mock.calls.at(-1)![1]!
    const send = vi.fn()
    act(() => reconnect(send))
    mockGet.mockImplementation(() => new Promise(() => {}))
    act(() => reconnect(send))
    expect(screen.queryByRole('checkbox', { name: 'Seleccionar a.pdf' })).toBeNull()
    expect(screen.queryByText(/1 seleccionado ·/)).toBeNull()
  })

  it('reveals advanced filters explicitly and preserves their count when collapsed', async () => {
    await loaded()
    const disclosure = screen.getByRole('button', { name: 'Filtros' })
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    expect(disclosure).toHaveAttribute('aria-controls', 'storage-advanced-filters')
    expect(screen.queryByRole('combobox', { name: 'Filtrar por origen' })).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Buscar archivos' })).toBeVisible()
    fireEvent.click(disclosure)
    expect(disclosure).toHaveAttribute('aria-expanded', 'true')
    fireEvent.change(screen.getByRole('combobox', { name: 'Filtrar por origen' }), { target: { value: 'chats' } })
    await waitFor(() => expect(mockGet.mock.calls.some(([path]) => path.includes('origin=chats'))).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: /Filtros\s*1\s*activos/ }))
    expect(screen.queryByRole('combobox', { name: 'Filtrar por origen' })).toBeNull()
    expect(screen.getByRole('button', { name: /Filtros\s*1\s*activos/ })).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(screen.getByRole('button', { name: 'Limpiar filtros' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Filtros' })).toBeTruthy())
  })
  it('reveals filters applied by the review shortcut without hiding search or media types', async () => {
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: 'Revisar archivos' }))
    expect(screen.getByRole('button', { name: /Filtros\s*1\s*activos/ })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('combobox', { name: 'Disponibilidad para limpiar' })).toHaveValue('removable')
    expect(screen.getByRole('textbox', { name: 'Buscar archivos' })).toBeVisible()
    expect(screen.getByRole('button', { name: /^Fotos/ })).toBeVisible()
  })

})
