import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StorageDetailsWindow } from './StorageDetailsWindow'
import { apiGet } from '@/lib/api'
import { completeAuthIdentityChange, getAuthScope } from '@/lib/authScope'
import { STORAGE_READ_TIMEOUT_MS, type StorageFile, type StorageUse, type StorageUsesResponse } from './storageModel'

vi.mock('@/lib/api', () => ({ apiGet: vi.fn() }))
vi.mock('@/components/operational-window/OperationalWindowShell', () => ({ default: ({ children, footer, onRequestClose }: { children: React.ReactNode; footer: React.ReactNode; onRequestClose: () => void }) => <section>{children}{footer}<button onClick={onRequestClose}>Cerrar detalles</button></section> }))
const file: StorageFile = { object_key: 'account/file', filename: 'Compartido.pdf', media_type: 'document', size_bytes: 4096, origins: [], references_count: 3, can_remove: false, status: 'active' }
const use = (id: string, can_remove = true): StorageUse => ({ use_id: id, type: 'chats', label: `Uso ${id}`, can_remove })
const response = (uses: StorageUse[], extra: Partial<StorageUsesResponse> = {}) => ({ success: true as const, data: { success: true, uses, total: uses.length, limit: 40, has_more: false, ...extra } })
const mockGet = vi.mocked(apiGet)
const onReview = vi.fn(), onClose = vi.fn(), onUnavailable = vi.fn(), onPreview = vi.fn()
const props = () => ({ file, scope: getAuthScope(), refresh: 0, canManage: true, reviewBusy: false, onReview, onClose, onUnavailable, onPreview })
beforeEach(() => { completeAuthIdentityChange(); mockGet.mockReset(); onReview.mockClear(); onClose.mockClear(); onUnavailable.mockClear(); onPreview.mockClear() })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('storage individual uses work window', () => {
  it('keeps selected uses across cursor pages and sends only allowed IDs in stable order', async () => {
    mockGet.mockImplementation(async path => path.includes('cursor=second') ? response([use('a'), use('protected', false)]) : response([use('z')], { next_cursor: 'second', has_more: true, total: 3 }))
    render(<StorageDetailsWindow {...props()} />)
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Seleccionar uso: Uso z' }))
    fireEvent.click(screen.getByRole('button', { name: 'Usos siguientes' }))
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Seleccionar uso: Uso a' }))
    expect(screen.getByRole('checkbox', { name: 'Seleccionar uso: Uso protected' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Revisar usos seleccionados' }))
    expect(onReview).toHaveBeenCalledExactlyOnceWith({ object_key: file.object_key, mode: 'uses', use_ids: ['a', 'z'] })
    expect(mockGet.mock.calls[1][0]).toBe('/api/storage/uses?object_key=account%2Ffile&limit=40&cursor=second')
    fireEvent.click(screen.getByRole('button', { name: 'Usos anteriores' }))
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Seleccionar uso: Uso z' })).toBeChecked())
  })

  it('protects the selected draft on close, and cancellation never makes a write', async () => {
    mockGet.mockResolvedValue(response([use('a')]))
    render(<StorageDetailsWindow {...props()} />)
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Seleccionar uso: Uso a' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar detalles' }))
    expect(await screen.findByRole('dialog', { name: 'Descartar selección de usos' })).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Seguir revisando' }))
    expect(screen.getByRole('checkbox', { name: 'Seleccionar uso: Uso a' })).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar detalles' }))
    fireEvent.click(screen.getByRole('button', { name: 'Descartar selección' }))
    expect(onClose).toHaveBeenCalledOnce(); expect(onReview).not.toHaveBeenCalled()
  })

  it('silently preserves mounted rows but removes revoked selections after canonical refresh', async () => {
    mockGet.mockResolvedValue(response([use('a')]))
    const initial = props()
    const { rerender } = render(<StorageDetailsWindow {...initial} />)
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Seleccionar uso: Uso a' }))
    let resolve: (value: unknown) => void = () => {}
    mockGet.mockImplementationOnce(() => new Promise(done => { resolve = done as typeof resolve }))
    rerender(<StorageDetailsWindow {...initial} refresh={1} />)
    expect(screen.getByRole('checkbox', { name: 'Seleccionar uso: Uso a' })).toBeChecked()
    expect(screen.queryByText('Comprobando ubicaciones y permisos…')).toBeNull()
    await act(async () => resolve(response([use('a', false)])))
    expect(screen.getByRole('checkbox', { name: 'Seleccionar uso: Uso a' })).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Revisar usos seleccionados' })).toBeDisabled()
  })

  it('keeps a transient failure visible, disables review, and retries without losing a valid selection', async () => {
    mockGet.mockResolvedValue(response([use('a')]))
    const initial = props()
    const { rerender } = render(<StorageDetailsWindow {...initial} />)
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Seleccionar uso: Uso a' }))
    mockGet.mockResolvedValueOnce({ success: false, status: 503, error: 'Inventario ocupado' })
    rerender(<StorageDetailsWindow {...initial} refresh={1} />)
    await screen.findByText('Inventario ocupado')
    expect(screen.getByRole('button', { name: 'Revisar usos seleccionados' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Revisar usos seleccionados' })).toBeEnabled())
    expect(screen.getByRole('checkbox', { name: 'Seleccionar uso: Uso a' })).toBeChecked()
  })

  it('redacts forbidden uses and rejects late data after identity changes', async () => {
    let resolve: (value: unknown) => void = () => {}
    mockGet.mockImplementationOnce(() => new Promise(done => { resolve = done as typeof resolve }))
    const first = render(<StorageDetailsWindow {...props()} />)
    act(() => completeAuthIdentityChange())
    await act(async () => resolve(response([use('private')])) )
    expect(screen.queryByText('Uso private')).toBeNull()
    first.unmount()
    mockGet.mockResolvedValueOnce({ success: false, status: 403, error: 'Sin acceso' })
    render(<StorageDetailsWindow {...props()} />)
    await waitFor(() => expect(onUnavailable).toHaveBeenCalledOnce())
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('never infers upload ownership from an object key or exposes an unsafe origin link', async () => {
    mockGet.mockResolvedValue(response([{ ...use('a'), href: 'https://outside.example/secret' }]))
    render(<StorageDetailsWindow {...props()} file={{ ...file, object_key: 'account/uploads/my-file', is_own_upload: true, ownership_verified: false }} />)
    await screen.findByText('Uso a')
    expect(screen.queryByText('Carga tuya verificada')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Vista previa' }))
    expect(onPreview).toHaveBeenCalledOnce()
  })

  it('coalesces ordinary refreshes without aborting the current authorized read', async () => {
    const completions: ((value: unknown) => void)[] = []
    mockGet.mockImplementation(() => new Promise(resolve => completions.push(resolve as (value: unknown) => void)))
    const initial = props()
    const view = render(<StorageDetailsWindow {...initial} />)
    const firstSignal = mockGet.mock.calls[0][1]?.signal
    view.rerender(<StorageDetailsWindow {...initial} refresh={1} />)
    view.rerender(<StorageDetailsWindow {...initial} refresh={2} />)
    expect(firstSignal?.aborted).toBe(false)
    expect(mockGet).toHaveBeenCalledTimes(1)
    await act(async () => completions[0](response([use('a')])) )
    expect(screen.getByText('Uso a')).toBeInTheDocument()
    expect(mockGet).toHaveBeenCalledTimes(2)
    await act(async () => completions[1](response([use('a', false)])))
    expect(screen.getByRole('checkbox', { name: 'Seleccionar uso: Uso a' })).toBeDisabled()
    expect(screen.queryByLabelText('Actualizando usos')).toBeNull()
  })

  it('ends a stalled refresh at its original deadline and retries without accepting late rows', async () => {
    vi.useFakeTimers()
    const completions: ((value: unknown) => void)[] = []
    mockGet.mockImplementation(() => new Promise(resolve => completions.push(resolve as (value: unknown) => void)))
    const initial = props()
    const view = render(<StorageDetailsWindow {...initial} />)
    const firstSignal = mockGet.mock.calls[0][1]?.signal
    await act(async () => vi.advanceTimersByTime(STORAGE_READ_TIMEOUT_MS - 1000))
    view.rerender(<StorageDetailsWindow {...initial} refresh={1} />)
    await act(async () => vi.advanceTimersByTime(1000))
    expect(firstSignal?.aborted).toBe(true)
    expect(screen.queryByText('Comprobando ubicaciones y permisos…')).toBeNull()
    expect(screen.getByRole('alert')).toHaveTextContent('No se pudieron cargar los usos')
    view.rerender(<StorageDetailsWindow {...initial} refresh={2} />)
    expect(mockGet).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
    expect(mockGet).toHaveBeenCalledTimes(2)
    await act(async () => completions[1](response([use('current')])) )
    await act(async () => completions[0](response([use('stale')])) )
    expect(screen.getByRole('checkbox', { name: 'Seleccionar uso: Uso current' })).toBeEnabled()
    expect(screen.queryByText('Uso stale')).toBeNull()
  })

  it('keeps verified uses actionable through continuous successful refreshes without a cumulative timeout', async () => {
    vi.useFakeTimers()
    const completions: ((value: unknown) => void)[] = []
    mockGet.mockImplementation(() => new Promise(resolve => completions.push(resolve as (value: unknown) => void)))
    const initial = props()
    const view = render(<StorageDetailsWindow {...initial} />)
    for (let index = 0; index < 4; index++) {
      view.rerender(<StorageDetailsWindow {...initial} refresh={index + 1} />)
      await act(async () => vi.advanceTimersByTime(20_000))
      await act(async () => completions[index](response([use('a')])) )
      expect(mockGet).toHaveBeenCalledTimes(index + 2)
      const checkbox = screen.getByRole('checkbox', { name: 'Seleccionar uso: Uso a' })
      expect(checkbox).toBeEnabled()
      if (index === 0) fireEvent.click(checkbox)
      expect(checkbox).toBeChecked()
      const review = screen.getByRole('button', { name: 'Revisar usos seleccionados' })
      expect(review).toBeEnabled()
      fireEvent.click(review)
      expect(onReview).toHaveBeenCalledTimes(index + 1)
      expect(screen.queryByRole('alert')).toBeNull()
    }
  })

  it('allows pagination during a background refresh but blocks actions until the new page is verified', async () => {
    const completions: ((value: unknown) => void)[] = []
    mockGet.mockImplementation(() => new Promise(resolve => completions.push(resolve as (value: unknown) => void)))
    const initial = props()
    const view = render(<StorageDetailsWindow {...initial} />)
    await act(async () => completions[0](response([use('a')], { next_cursor: 'second', has_more: true })))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Seleccionar uso: Uso a' }))
    view.rerender(<StorageDetailsWindow {...initial} refresh={1} />)
    expect(screen.getByRole('button', { name: 'Revisar usos seleccionados' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Usos siguientes' }))
    expect(mockGet).toHaveBeenCalledTimes(3)
    expect(mockGet.mock.calls[1][1]?.signal?.aborted).toBe(true)
    expect(screen.getByRole('checkbox', { name: 'Seleccionar uso: Uso a' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Revisar usos seleccionados' })).toBeDisabled()
    await act(async () => completions[1]({ success: false, status: 403 }))
    expect(onUnavailable).not.toHaveBeenCalled()
    await act(async () => completions[2](response([use('b')])) )
    expect(screen.getByRole('checkbox', { name: 'Seleccionar uso: Uso b' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Revisar usos seleccionados' })).toBeEnabled()
  })
})
