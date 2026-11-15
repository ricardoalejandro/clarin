import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CreateContactModal from './CreateContactModal'

vi.mock('@/components/tags/CatalogTagPicker', () => ({ default: () => null }))
vi.mock('@/lib/authScope', () => ({ subscribeAuthScope: () => () => {} }))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('contact creation manual dates', () => {
  it('blocks a partial date and creates with the latest complete text without a prior blur', async () => {
    const fetch = vi.fn().mockResolvedValue({ json: async () => ({ success: true }) })
    vi.stubGlobal('fetch', fetch)
    render(<CreateContactModal open onClose={vi.fn()} onSuccess={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText('Juan'), { target: { value: 'Contacto de prueba' } })
    const date = screen.getByRole('textbox', { name: 'Fecha de nacimiento' })
    fireEvent.change(date, { target: { value: '04/05/' } })
    expect(screen.getByRole('button', { name: 'Crear contacto' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Crear contacto' }))
    expect(fetch).not.toHaveBeenCalled()
    expect(date).toHaveValue('04/05/')
    fireEvent.change(date, { target: { value: '04/05/1992' } })
    fireEvent.click(screen.getByRole('button', { name: 'Crear contacto' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ name: 'Contacto de prueba', birth_date: '1992-05-04' })
  })

  it('protects an uncommitted partial date when closing', () => {
    const close = vi.fn()
    render(<CreateContactModal open onClose={close} onSuccess={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Fecha de nacimiento' }), { target: { value: '04/05/' } })
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(close).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: 'Fecha de nacimiento' })).toHaveValue('04/05/')
  })
})
