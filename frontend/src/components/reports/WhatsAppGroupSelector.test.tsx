import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SEARCH_DEBOUNCE_MS } from '@/lib/useDebouncedValue'
import type { WhatsAppGroupOption } from '@/types/report'
import WhatsAppGroupSelector from './WhatsAppGroupSelector'

const groups: WhatsAppGroupOption[] = [
  { id: 'alpha', name: 'Comunidad Alpha', participant_count: 12, kind: 'community', suspended: false },
  { id: 'beta', name: 'Grupo Beta', participant_count: 7, kind: 'group', suspended: false },
]

describe('WhatsAppGroupSelector search', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('mantiene el texto inmediato y filtra el catálogo a los 500 ms exactos', () => {
    vi.useFakeTimers()
    render(<WhatsAppGroupSelector groups={groups} value="" onChange={vi.fn()} />)

    fireEvent.click(screen.getByRole('combobox'))
    const listbox = screen.getByRole('listbox')
    const input = screen.getByPlaceholderText('Buscar grupo…')
    fireEvent.change(input, { target: { value: 'beta' } })

    expect(input).toHaveValue('beta')
    expect(screen.getByLabelText('Buscando grupos')).toBeInTheDocument()
    expect(within(listbox).getByText('Comunidad Alpha')).toBeInTheDocument()

    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1))
    expect(within(listbox).getByText('Comunidad Alpha')).toBeInTheDocument()

    act(() => vi.advanceTimersByTime(1))
    expect(within(listbox).queryByText('Comunidad Alpha')).not.toBeInTheDocument()
    expect(within(listbox).getByText('Grupo Beta')).toBeInTheDocument()
    expect(screen.queryByLabelText('Buscando grupos')).not.toBeInTheDocument()
  })

  it('selecciona y cierra inmediatamente sin esperar otro debounce', () => {
    vi.useFakeTimers()
    const onChange = vi.fn()
    render(<WhatsAppGroupSelector groups={groups} value="" onChange={onChange} />)

    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByRole('option', { name: /Grupo Beta/i }))

    expect(onChange).toHaveBeenCalledOnce()
    expect(onChange).toHaveBeenCalledWith(groups[1])
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })
})
