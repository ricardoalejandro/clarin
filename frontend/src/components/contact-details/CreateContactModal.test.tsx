import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import CreateContactModal from '../CreateContactModal'

vi.mock('@/lib/api', () => ({ api: vi.fn() }))
vi.mock('@/lib/authScope', () => ({ subscribeAuthScope: () => () => {} }))

const callbacks = { onClose: vi.fn(), onSuccess: vi.fn() }
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }

beforeEach(() => { vi.useFakeTimers(); vi.mocked(api).mockReset(); vi.mocked(api).mockResolvedValue({ success: true, data: { success: true, tags: [], can_create: false } }) })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('CreateContactModal', () => {
  it('requests a bounded catalog and hides new-tag creation when permission is absent', async () => {
    render(<CreateContactModal open {...callbacks} />)
    await settle()
    expect(api).toHaveBeenCalledWith('/api/tags?limit=20&search=', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    fireEvent.change(screen.getByPlaceholderText('Buscar etiquetas...'), { target: { value: 'Nueva' } })
    await act(async () => { vi.advanceTimersByTime(500) })
    await settle()
    expect(screen.queryByTitle('Añadir etiqueta')).not.toBeInTheDocument()
    fireEvent.keyDown(screen.getByPlaceholderText('Buscar etiquetas...'), { key: 'Enter' })
    expect(screen.queryByText('Nueva', { selector: 'span' })).not.toBeInTheDocument()
  })

  it('keeps existing tags assignable without permission to create global tags', async () => {
    vi.mocked(api).mockResolvedValue({ success: true, data: { success: true, tags: [{ id: 'tag-1', name: 'Prioridad', color: '#2563EB' }], can_create: false } })
    render(<CreateContactModal open {...callbacks} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Prioridad' }))
    expect(screen.getByText('Prioridad', { selector: 'span' })).toBeInTheDocument()
  })

  it('debounces 500 ms and rejects stale results even before the next query starts', async () => {
    let resolveOld!: (result: any) => void
    vi.mocked(api).mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve }))
    render(<CreateContactModal open {...callbacks} />)
    const query = screen.getByPlaceholderText('Buscar etiquetas...')
    const oldSignal = vi.mocked(api).mock.calls[0][1]!.signal as AbortSignal
    fireEvent.change(query, { target: { value: 'Actual' } })
    expect(oldSignal.aborted).toBe(true)
    await act(async () => { resolveOld({ success: true, data: { success: true, tags: [{ id: 'old', name: 'Obsoleta' }], can_create: true } }); await Promise.resolve() })
    expect(screen.queryByText('Obsoleta')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Añadir etiqueta')).not.toBeInTheDocument()
    await act(async () => { vi.advanceTimersByTime(499) })
    expect(api).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(1) })
    await settle()
    expect(api).toHaveBeenCalledTimes(2)
    expect(api).toHaveBeenLastCalledWith('/api/tags?limit=20&search=Actual', expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })

  it('blocks invalid metadata before starting a write and sets matching input limits', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<CreateContactModal open {...callbacks} />)
    await settle()
    const surname = screen.getByPlaceholderText('Pérez')
    expect(surname).toHaveAttribute('maxlength', '510')
    expect(screen.getByPlaceholderText('12345678')).toHaveAttribute('maxlength', '100')
    fireEvent.change(screen.getByPlaceholderText('Juan'), { target: { value: 'Synthetic' } })
    fireEvent.change(surname, { target: { value: 'a'.repeat(256) } })
    fireEvent.click(screen.getByRole('button', { name: 'Crear contacto' }))
    expect(screen.getByText(/El apellido admite como máximo 255 caracteres/)).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('permits all 255 Unicode code points through the input and payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ json: async () => ({ success: true }) })
    vi.stubGlobal('fetch', fetchMock)
    render(<CreateContactModal open {...callbacks} />)
    await settle()
    const unicodeSurname = '🙂'.repeat(255)
    const surname = screen.getByPlaceholderText('Pérez') as HTMLInputElement
    expect(surname.maxLength).toBeGreaterThanOrEqual(unicodeSurname.length)
    fireEvent.change(screen.getByPlaceholderText('Juan'), { target: { value: 'Synthetic' } })
    fireEvent.change(surname, { target: { value: unicodeSurname } })
    fireEvent.click(screen.getByRole('button', { name: 'Crear contacto' }))
    await settle()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).last_name).toBe(unicodeSurname)
  })

  it('sends the exact catalog name after case-insensitive existing-tag selection', async () => {
    vi.mocked(api).mockResolvedValue({ success: true, data: { success: true, tags: [{ id: 'tag-1', name: 'Prioridad', color: '#2563EB' }], can_create: false } })
    const fetchMock = vi.fn().mockResolvedValue({ json: async () => ({ success: true }) })
    vi.stubGlobal('fetch', fetchMock)
    render(<CreateContactModal open {...callbacks} />)
    await settle()
    const query = screen.getByPlaceholderText('Buscar etiquetas...')
    fireEvent.change(query, { target: { value: ' PRIORIDAD ' } })
    await act(async () => { vi.advanceTimersByTime(500) })
    await settle()
    fireEvent.keyDown(query, { key: 'Enter' })
    fireEvent.change(screen.getByPlaceholderText('Juan'), { target: { value: 'Synthetic' } })
    fireEvent.click(screen.getByRole('button', { name: 'Crear contacto' }))
    await settle()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ tags: ['Prioridad'], tag_ids: ['tag-1'] })
  })
})
