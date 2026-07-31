import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TagInput, { type TagItem } from './TagInput'
import { SEARCH_DEBOUNCE_MS } from '@/lib/useDebouncedValue'

const tags: TagItem[] = [
  { id: 'green', account_id: 'account-1', name: 'Verde', color: '#10b981' },
  { id: 'blue', account_id: 'account-1', name: 'Azul', color: '#3b82f6' },
]

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('TagInput search', () => {
  it('mantiene el texto inmediato y publica resultados a los 500 ms exactos', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ json: async () => ({ success: true, tags }) } as Response)
    const onTagsChange = vi.fn()
    render(<TagInput entityType="contact" entityId="contact-1" assignedTags={[]} localMode onTagsChange={onTagsChange} />)
    const input = screen.getByPlaceholderText('Agregar etiqueta...')
    fireEvent.focus(input)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Verde' })).toBeInTheDocument())

    vi.useFakeTimers()
    fireEvent.change(input, { target: { value: 'ver' } })
    expect(input).toHaveValue('ver')
    expect(screen.getByRole('status')).toHaveTextContent('Buscando etiquetas')
    expect(screen.queryByRole('button', { name: 'Verde' })).not.toBeInTheDocument()

    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1))
    expect(screen.queryByRole('button', { name: 'Verde' })).not.toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByRole('button', { name: 'Verde' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Azul' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Verde' }))
    expect(onTagsChange).toHaveBeenCalledWith([tags[0]])
    expect(input).toHaveValue('')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
