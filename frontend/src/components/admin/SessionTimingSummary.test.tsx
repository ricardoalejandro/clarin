import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { getOnlineSessionTiming } from '@/lib/api'
import { SessionTimingSummary } from './SessionTimingSummary'

vi.mock('@/lib/api', () => ({ getOnlineSessionTiming: vi.fn(() => null), subscribeOnlineSessionNotice: vi.fn(() => () => {}) }))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks() })

it('shows only timing metadata from the selected account without polling', () => {
  vi.mocked(getOnlineSessionTiming).mockReturnValue({ session: { account_id: 'a', idle_timeout_minutes: 180, scope: 'public-correlation', server_now: '2026-11-14T12:00:00Z', idle_expires_at: '2026-11-14T15:00:00Z', absolute_expires_at: '2026-11-21T12:00:00Z' }, deadlineAt: Date.parse('2026-11-14T15:00:00Z') })
  const { rerender } = render(<SessionTimingSummary accountId="a" />)
  expect(screen.getByText('180 minutos por inactividad')).toBeInTheDocument()
  expect(screen.getByLabelText('Duración de tu sesión').querySelector('time')).toHaveAttribute('datetime', '2026-11-14T15:00:00.000Z')
  rerender(<SessionTimingSummary accountId="b" />)
  expect(screen.queryByLabelText('Duración de tu sesión')).not.toBeInTheDocument()
})

it('opens the compact timing detail through a portal and restores focus without renewing the session', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.mocked(getOnlineSessionTiming).mockReturnValue({ session: { account_id: 'a', idle_timeout_minutes: 180, scope: 'public-correlation', server_now: '2026-11-14T12:00:00Z', idle_expires_at: '2026-11-14T15:00:00Z', absolute_expires_at: '2026-11-21T12:00:00Z' }, deadlineAt: Date.parse('2026-11-14T15:00:00Z') })
  render(<SessionTimingSummary compact accountId="a" />)
  const trigger = screen.getByRole('button', { name: 'Duración de tu sesión' })
  trigger.focus(); fireEvent.click(trigger)
  const detail = screen.getByRole('dialog', { name: 'Detalle de la sesión' })
  expect(detail.parentElement).toBe(document.body)
  expect(detail.querySelector('time')).toHaveAttribute('datetime', '2026-11-14T15:00:00.000Z')
  expect(screen.getByText('El guardado automático no amplía este plazo.')).toBeInTheDocument()
  fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() => expect(trigger).toHaveFocus())
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(getOnlineSessionTiming).toHaveBeenCalledTimes(1)
})
