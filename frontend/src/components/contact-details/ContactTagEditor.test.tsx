import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import ContactTagEditor from './ContactTagEditor'
import { OperationalOverlayProvider } from '@/components/operational-window/OperationalOverlayContext'

vi.mock('@/lib/api', () => ({ api: vi.fn() }))

const selected = [{ id: 'tag-1', account_id: 'account-1', name: 'Prioridad', color: '#2563EB' }]

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(api).mockReset()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('ContactTagEditor', () => {
  it('removes an assigned tag directly without opening the full Contact editor', () => {
    const onChange = vi.fn()
    render(<ContactTagEditor contactId="contact-1" context={{ type: 'lead', id: 'lead-1' }} selected={selected} canCreate onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Quitar etiqueta Prioridad' }))
    expect(onChange).toHaveBeenCalledWith([])
  })

  it('can hide duplicate selected chips when embedded below the canonical tag row', () => {
    render(<ContactTagEditor contactId="contact-1" context={{ type: 'lead', id: 'lead-1' }} selected={selected} canCreate showSelected={false} onChange={vi.fn()} />)
    expect(screen.queryByLabelText('Etiquetas seleccionadas')).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Buscar o crear etiqueta' })).toBeInTheDocument()
  })

  it('starts bounded remote search exactly 500 ms after the last keystroke', async () => {
    vi.mocked(api).mockResolvedValue({ success: true, data: { success: true, tags: [] } })
    render(<ContactTagEditor contactId="contact-1" context={{ type: 'lead', id: 'lead-1' }} selected={[]} canCreate={false} onChange={vi.fn()} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Buscar o crear etiqueta' }), { target: { value: 'vip' } })

    await act(async () => { vi.advanceTimersByTime(499) })
    expect(api).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(1); await Promise.resolve() })
    expect(api).toHaveBeenCalledWith(expect.stringContaining('q=vip&limit=20'), expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal) }))
  })

  it('keeps results above overflow boundaries and supports keyboard selection and Escape', async () => {
    const tags = [{ ...selected[0], id: 'one', name: 'Uno' }, { ...selected[0], id: 'two', name: 'Dos' }]
    const onChange = vi.fn()
    vi.mocked(api).mockResolvedValue({ success: true, data: { success: true, tags } })
    const { container } = render(<ContactTagEditor contactId="contact-1" context={{ type: 'contact', id: 'contact-1' }} selected={[]} canCreate={false} onChange={onChange} />)
    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'o' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    const menu = screen.getByRole('listbox')
    expect(container.contains(menu)).toBe(false)
    expect(menu.parentElement).toBe(document.body)
    fireEvent.keyDown(input, { key: 'End' })
    expect(input).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'Dos' }).id)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith([tags[1]])
    expect(input).toHaveValue('')
    expect(input).toHaveFocus()
    fireEvent.change(input, { target: { value: 'nueva' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(input).toHaveValue('nueva')
    expect(input).toHaveFocus()
  })

  it('restarts the delay for whitespace edits and rejects an old contact response', async () => {
    let resolveOld!: (value: Awaited<ReturnType<typeof api>>) => void
    vi.mocked(api).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }) as ReturnType<typeof api>)
    const props = { selected: [], canCreate: false, onChange: vi.fn() }
    const { rerender } = render(<ContactTagEditor {...props} contactId="contact-1" context={{ type: 'contact', id: 'contact-1' }} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'vip' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'vip ' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(499) })
    expect(api).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    const signal = vi.mocked(api).mock.calls[0][1]?.signal as AbortSignal
    rerender(<ContactTagEditor {...props} contactId="contact-2" context={{ type: 'contact', id: 'contact-2' }} />)
    expect(signal.aborted).toBe(true)
    await act(async () => { resolveOld({ success: true, data: { success: true, tags: selected } }) })
    expect(screen.getByRole('combobox')).toHaveValue('')
    expect(screen.queryByText('Prioridad')).not.toBeInTheDocument()
  })

  it('uses the owning work window portal and releases its overlay registration when dismissed', () => {
    const portalTarget = document.createElement('div')
    document.body.appendChild(portalTarget)
    const release = vi.fn()
    const registerOverlay = vi.fn(() => release)
    const { unmount } = render(<OperationalOverlayProvider portalTarget={portalTarget} registerOverlay={registerOverlay}>
      <ContactTagEditor contactId="contact-1" context={{ type: 'lead', id: 'lead-1' }} selected={[]} canCreate={false} onChange={vi.fn()} />
    </OperationalOverlayProvider>)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'vip' } })
    expect(screen.getByRole('listbox').parentElement).toBe(portalTarget)
    expect(registerOverlay).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' })
    expect(release).toHaveBeenCalledTimes(1)
    unmount()
    portalTarget.remove()
  })
})
