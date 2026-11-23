import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CustomFieldInput from './CustomFieldInput'
import type { CustomFieldDefinition, CustomFieldValue } from '@/types/custom-field'

const definition: CustomFieldDefinition = { id: 'field-date', account_id: 'account', name: 'Renovación', slug: 'renovacion', field_type: 'date', config: {}, is_required: false, default_value: null, sort_order: 0, created_at: '', updated_at: '' }
const value: CustomFieldValue = { id: 'field-value', field_id: 'field-date', contact_id: 'contact', value_date: '2026-06-15', created_at: '', updated_at: '' }
afterEach(cleanup)

describe('inline custom dates', () => {
  it('keeps partial text local and opening the calendar does not save', () => {
    const save = vi.fn()
    render(<CustomFieldInput definition={definition} value={value} onSave={save} />)
    fireEvent.click(screen.getByText('Renovación'))
    const date = screen.getByRole('textbox', { name: 'Renovación' })
    fireEvent.change(date, { target: { value: '20/06/' } })
    fireEvent.blur(date)
    expect(save).not.toHaveBeenCalled()
    expect(date).toHaveValue('20/06/')
    fireEvent.change(date, { target: { value: '20/06/2026' } })
    const calendar = screen.getByRole('button', { name: /Renovación:/ })
    fireEvent.blur(date, { relatedTarget: calendar })
    fireEvent.click(calendar)
    expect(screen.getByRole('dialog')).toBeVisible()
    expect(save).not.toHaveBeenCalled()
  })

  it('saves the committed value once and preserves the draft after a rejected save', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined)
    render(<CustomFieldInput definition={definition} value={value} onSave={save} />)
    fireEvent.click(screen.getByText('Renovación'))
    const date = screen.getByRole('textbox', { name: 'Renovación' })
    fireEvent.change(date, { target: { value: '20/06/2026' } })
    fireEvent.keyDown(date, { key: 'Enter' })
    await screen.findByRole('alert')
    expect(date).toHaveValue('20/06/2026')
    expect(save).toHaveBeenCalledExactlyOnceWith('field-date', { value: '2026-06-20' })
    fireEvent.keyDown(date, { key: 'Enter' })
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Renovación' })).not.toBeInTheDocument())
    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenLastCalledWith('field-date', { value: '2026-06-20' })
  })

  it('never clears a required date and cancellation discards partial text', () => {
    const save = vi.fn()
    render(<CustomFieldInput definition={{ ...definition, is_required: true }} value={value} onSave={save} />)
    fireEvent.click(screen.getByText('Renovación'))
    const date = screen.getByRole('textbox', { name: 'Renovación' })
    fireEvent.change(date, { target: { value: '' } })
    fireEvent.keyDown(date, { key: 'Enter' })
    expect(save).not.toHaveBeenCalled()
    fireEvent.change(date, { target: { value: '20/06/2026' } })
    const cancel = screen.getByRole('button', { name: 'Cancelar edición de Renovación' })
    fireEvent.blur(date, { relatedTarget: cancel })
    expect(save).not.toHaveBeenCalled()
    fireEvent.click(cancel)
    expect(screen.queryByRole('textbox', { name: 'Renovación' })).not.toBeInTheDocument()
    expect(save).not.toHaveBeenCalled()
  })
})
