import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { apiPut } from '@/lib/api'
import { AccountSessionPolicy } from './AccountSessionPolicy'

vi.mock('@/lib/api', () => ({ apiPut: vi.fn() }))

describe('AccountSessionPolicy', () => {
  it('validates minutes and saves only the target account policy', async () => {
    const save = vi.mocked(apiPut)
    save.mockResolvedValue({ success: true, data: { session_idle_timeout_minutes: 120 } })
    const onSaved = vi.fn()
    render(<AccountSessionPolicy accountId="account-a" minutes={30} disabled={false} onBusyChange={vi.fn()} onSaved={onSaved} />)
    const input = screen.getByRole('textbox', { name: /Cerrar por inactividad/ })
    const button = screen.getByRole('button', { name: 'Guardar plazo' })
    expect(button).toBeDisabled()
    fireEvent.change(input, { target: { value: '4' } })
    fireEvent.click(button)
    expect(screen.getByRole('alert')).toHaveTextContent('entre 5 y 1440 minutos')
    expect(save).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '120' } })
    fireEvent.click(button)
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(120))
    expect(save).toHaveBeenCalledWith('/api/admin/accounts/account-a/session-policy', { session_idle_timeout_minutes: 120 })
    expect(screen.getByRole('status')).toHaveTextContent('guardado')
  })
})
