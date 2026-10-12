import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import CreateContactModal from '../CreateContactModal'

vi.mock('@/lib/api', () => ({ api: vi.fn() }))
vi.mock('@/lib/authScope', () => ({ getAuthScope: () => 'account-1', isAuthIdentityChanging: () => false, subscribeAuthScope: () => () => {} }))

const callbacks = { onClose: vi.fn(), onSuccess: vi.fn() }
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }

beforeEach(() => { vi.useFakeTimers(); vi.mocked(api).mockReset(); vi.mocked(api).mockResolvedValue({ success: true, data: { success: true, tags: [], can_create: false } }) })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('CreateContactModal', () => {
  it('uses bounded module search and hides creation without permission', async () => {
    render(<CreateContactModal open {...callbacks} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Nueva' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(499) })
    expect(api).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(api).toHaveBeenCalledWith('/api/tags/search?context_type=contact_create&q=Nueva&limit=20', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(screen.queryByRole('option', { name: /Crear/ })).not.toBeInTheDocument()
  })

  it('keeps existing tags assignable by pointer without creation permission', async () => {
    vi.mocked(api).mockResolvedValue({ success: true, data: { success: true, tags: [{ id: 'tag-1', name: 'Prioridad', color: '#2563EB' }], can_create: false } })
    render(<CreateContactModal open {...callbacks} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'prio' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    fireEvent.click(screen.getByRole('option', { name: 'Prioridad' }))
    expect(screen.getByRole('button', { name: 'Quitar etiqueta Prioridad' })).toBeInTheDocument()
  })

  it('aborts old queries immediately and keeps only current search results', async () => {
    let resolveOld!: (result: any) => void
    vi.mocked(api).mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve }))
    render(<CreateContactModal open {...callbacks} />)
    const query = screen.getByRole('combobox')
    fireEvent.change(query, { target: { value: 'Anterior' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    const oldSignal = vi.mocked(api).mock.calls[0][1]!.signal as AbortSignal
    fireEvent.change(query, { target: { value: 'Actual' } })
    expect(oldSignal.aborted).toBe(true)
    await act(async () => { resolveOld({ success: true, data: { success: true, tags: [{ id: 'old', name: 'Obsoleta' }], can_create: true } }); await Promise.resolve() })
    expect(screen.queryByText('Obsoleta')).not.toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(499) })
    expect(api).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(api).toHaveBeenCalledTimes(2)
  })

  it('waits for tag creation before allowing the contact to save its canonical ID', async () => {
    let complete!: (result: any) => void
    vi.mocked(api).mockResolvedValueOnce({ success: true, data: { success: true, tags: [], can_create: true } }).mockReturnValueOnce(new Promise(resolve => { complete = resolve }))
    const fetchMock = vi.fn().mockResolvedValue({ json: async () => ({ success: true }) })
    vi.stubGlobal('fetch', fetchMock)
    render(<CreateContactModal open {...callbacks} />)
    fireEvent.change(screen.getByPlaceholderText('Juan'), { target: { value: 'Synthetic' } })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Nueva' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    fireEvent.click(screen.getByRole('option', { name: 'Crear “Nueva”' }))
    expect(screen.getByRole('button', { name: 'Crear contacto' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Crear contacto' }))
    expect(fetchMock).not.toHaveBeenCalled()
    await act(async () => { complete({ success: true, data: { success: true, tag: { id: 'new-id', name: 'Nueva', color: '#6366F1' } } }) })
    expect(screen.getByRole('button', { name: 'Crear contacto' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Crear contacto' }))
    await settle()
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).tag_ids).toEqual(['new-id'])
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

  it('sends canonical IDs after case-insensitive existing-tag selection', async () => {
    vi.mocked(api).mockResolvedValue({ success: true, data: { success: true, tags: [{ id: 'tag-1', name: 'Prioridad', color: '#2563EB' }], can_create: false } })
    const fetchMock = vi.fn().mockResolvedValue({ json: async () => ({ success: true }) })
    vi.stubGlobal('fetch', fetchMock)
    render(<CreateContactModal open {...callbacks} />)
    await settle()
    const query = screen.getByRole('combobox')
    fireEvent.change(query, { target: { value: ' PRIORIDAD ' } })
    await act(async () => { vi.advanceTimersByTime(500) })
    await settle()
    fireEvent.keyDown(query, { key: 'Enter' })
    fireEvent.change(screen.getByPlaceholderText('Juan'), { target: { value: 'Synthetic' } })
    fireEvent.click(screen.getByRole('button', { name: 'Crear contacto' }))
    await settle()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ tag_ids: ['tag-1'] })
  })
})
