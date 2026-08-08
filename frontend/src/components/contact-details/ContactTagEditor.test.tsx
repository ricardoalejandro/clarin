import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import ContactTagEditor from './ContactTagEditor'

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
})
