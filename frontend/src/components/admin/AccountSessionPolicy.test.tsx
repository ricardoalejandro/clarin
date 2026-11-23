import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiPut, getOnlineSessionTiming } from '@/lib/api'
import { AccountSessionPolicy } from './AccountSessionPolicy'

vi.mock('@/lib/api', () => ({ apiPut: vi.fn(), getOnlineSessionTiming: vi.fn(() => null), subscribeOnlineSessionNotice: vi.fn(() => () => {}) }))
afterEach(() => { cleanup(); vi.mocked(getOnlineSessionTiming).mockReturnValue(null) })

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
    expect(screen.getByRole('status')).toHaveTextContent('las sesiones abiertas conservan su plazo actual')
  })

  it('shows the effective current session separately without exposing another account session', () => {
    vi.mocked(getOnlineSessionTiming).mockReturnValue({ session: { account_id: 'account-a', idle_timeout_minutes: 30, scope: 'safe-correlation', server_now: '2026-11-14T12:00:00Z', idle_expires_at: '2026-11-14T12:30:00Z', absolute_expires_at: '2026-11-21T12:00:00Z' }, deadlineAt: Date.parse('2026-11-14T12:30:00Z') })
    const { rerender } = render(<AccountSessionPolicy accountId="account-a" minutes={180} disabled={false} onBusyChange={vi.fn()} onSaved={vi.fn()} />)
    expect(screen.getByText('180 minutos por inactividad')).toBeInTheDocument()
    expect(screen.getByText('30 minutos por inactividad')).toBeInTheDocument()
    expect(screen.getByText(/El plazo configurado es diferente/)).toBeInTheDocument()
    rerender(<AccountSessionPolicy accountId="account-b" minutes={120} disabled={false} onBusyChange={vi.fn()} onSaved={vi.fn()} />)
    expect(screen.queryByText('Plazo efectivo de esta sesión')).not.toBeInTheDocument()
  })
})
