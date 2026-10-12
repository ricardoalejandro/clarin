import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { beginAuthIdentityChange, completeAuthIdentityChange } from '@/lib/authScope'
import { OperationalOverlayProvider } from '@/components/operational-window/OperationalOverlayContext'
import CatalogTagPicker from './CatalogTagPicker'
import TagPicker from './TagPicker'
vi.mock('@/lib/api', () => ({ api: vi.fn() }))
const tag = { id: 'tag-1', account_id: 'account-1', name: 'Prioridad', color: '#2563EB' }
const second = { ...tag, id: 'tag-2', name: 'Seguimiento' }
const delay = async (ms = 500) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
beforeEach(() => { vi.useFakeTimers(); vi.mocked(api).mockReset() })
afterEach(() => { cleanup(); completeAuthIdentityChange(); vi.useRealTimers() })
describe('shared TagPicker', () => {
  it('restores pointer events inside a transparent work-window host and selects once', async () => {
    vi.mocked(api).mockResolvedValue({ success: true, data: { success: true, tags: [tag] } })
    const host = document.createElement('div'); host.style.pointerEvents = 'none'; document.body.appendChild(host)
    const onChange = vi.fn(), release = vi.fn()
    const { unmount } = render(<OperationalOverlayProvider portalTarget={host} registerOverlay={() => release}><TagPicker contactId="c1" context={{ type: 'lead', id: 'l1' }} selected={[]} onChange={onChange} /></OperationalOverlayProvider>)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'prio' } }); await delay()
    expect(screen.getByRole('listbox').parentElement).toBe(host)
    expect(screen.getByRole('listbox')).toHaveClass('pointer-events-auto')
    const option = screen.getByRole('option', { name: tag.name })
    fireEvent.pointerDown(option); fireEvent.mouseDown(option); fireEvent.mouseUp(option); fireEvent.click(option)
    expect(onChange).toHaveBeenCalledExactlyOnceWith([tag])
    expect(release).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('combobox')).toHaveFocus()
    unmount(); host.remove()
  })
  it('replaces a single selection and clears it explicitly without extra writes', async () => {
    vi.mocked(api).mockResolvedValue({ success: true, data: { success: true, tags: [second], can_create: false } })
    const onChange = vi.fn()
    const { rerender } = render(<CatalogTagPicker contextType="lead_import" mode="single" selected={[tag]} onChange={onChange} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'seg' } }); await delay()
    fireEvent.click(screen.getByRole('option', { name: second.name }))
    expect(onChange).toHaveBeenLastCalledWith([second])
    rerender(<CatalogTagPicker contextType="lead_import" mode="single" selected={[second]} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Quitar etiqueta Seguimiento' }))
    expect(onChange).toHaveBeenLastCalledWith([])
    expect(vi.mocked(api).mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
  })
  it('rejects stale A-B-A requests and debounces every raw edit at exactly 500ms', async () => {
    let resolveOld!: (value: any) => void
    vi.mocked(api).mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve })).mockResolvedValue({ success: true, data: { success: true, tags: [second], can_create: false } })
    render(<CatalogTagPicker contextType="lead_create" selected={[]} onChange={vi.fn()} />)
    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'A' } }); await delay()
    const signal = vi.mocked(api).mock.calls[0][1]?.signal as AbortSignal
    fireEvent.change(input, { target: { value: 'B' } }); await delay(200)
    fireEvent.change(input, { target: { value: 'A' } }); expect(signal.aborted).toBe(true)
    await act(async () => { resolveOld({ success: true, data: { success: true, tags: [tag], can_create: true } }) })
    expect(screen.queryByRole('option', { name: tag.name })).not.toBeInTheDocument()
    await delay(499); expect(api).toHaveBeenCalledTimes(1)
    await delay(1); expect(api).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('option', { name: second.name })).toBeInTheDocument()
  })
  it('gates creation by module search permission, prevents duplicate submits and retains failures', async () => {
    let complete!: (value: any) => void
    vi.mocked(api).mockResolvedValueOnce({ success: true, data: { success: true, tags: [], can_create: true } }).mockReturnValueOnce(new Promise(resolve => { complete = resolve }))
    const onChange = vi.fn()
    render(<CatalogTagPicker contextType="contact_create" selected={[]} onChange={onChange} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Nueva' } }); await delay()
    const create = screen.getByRole('option', { name: 'Crear “Nueva”' })
    fireEvent.click(create); fireEvent.click(create)
    expect(api).toHaveBeenCalledTimes(2)
    await act(async () => { complete({ success: false, error: 'Sin permiso' }) })
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('Sin permiso')
    expect(screen.getByRole('combobox')).toHaveValue('Nueva')
  })
  it('reconciles a created tag through the latest controlled callback and selection', async () => {
    let complete!: (result: any) => void
    vi.mocked(api).mockResolvedValueOnce({ success: true, data: { success: true, tags: [], can_create: true } }).mockReturnValueOnce(new Promise(resolve => { complete = resolve }))
    const oldChange = vi.fn(), currentChange = vi.fn()
    const { rerender } = render(<CatalogTagPicker contextType="contact_create" selected={[tag]} onChange={oldChange} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Nueva' } }); await delay()
    fireEvent.click(screen.getByRole('option', { name: 'Crear “Nueva”' }))
    rerender(<CatalogTagPicker contextType="contact_create" selected={[second]} onChange={currentChange} />)
    const created = { id: 'new', name: 'Nueva', color: '#6366F1' }
    await act(async () => { complete({ success: true, data: { success: true, tag: created } }) })
    expect(oldChange).not.toHaveBeenCalled()
    expect(currentChange).toHaveBeenCalledExactlyOnceWith([second, created])
  })
  it('aborts pending search work immediately when authentication changes', async () => {
    vi.mocked(api).mockReturnValue(new Promise(() => {}))
    render(<CatalogTagPicker contextType="lead_create" selected={[]} onChange={vi.fn()} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'vieja' } }); await delay()
    const signal = vi.mocked(api).mock.calls[0][1]?.signal as AbortSignal
    act(() => { beginAuthIdentityChange() })
    expect(signal.aborted).toBe(true)
    expect(screen.getByRole('combobox')).toHaveValue('')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })
  it('resets query and aborts requests when changing form or node session', async () => {
    vi.mocked(api).mockReturnValue(new Promise(() => {}))
    const props = { contextType: 'automation' as const, selected: [], onChange: vi.fn() }
    const { rerender } = render(<CatalogTagPicker {...props} sessionKey="node-1" />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'vieja' } }); await delay()
    const signal = vi.mocked(api).mock.calls[0][1]?.signal as AbortSignal
    rerender(<CatalogTagPicker {...props} sessionKey="node-2" />)
    expect(signal.aborted).toBe(true)
    expect(screen.getByRole('combobox')).toHaveValue('')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })
})
