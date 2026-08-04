import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import AccountSwitcher from './AccountSwitcher'

vi.mock('@/lib/api', () => ({ api: vi.fn() }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('AccountSwitcher', () => {
  const accountsResponse = {
    success: true as const,
    status: 200,
    data: {
      success: true,
      total: 2000,
      has_more: false,
      accounts: [
        { account_id: 'current', account_name: 'Filial Iquitos', account_slug: 'iquitos', role: 'super_admin', is_default: true },
        { account_id: 'next', account_name: 'Filial Lima', account_slug: 'lima', role: 'agent', is_default: false },
      ],
    },
  }

  it('opens as an accessible centered modal and restores focus after Escape', async () => {
    vi.mocked(api).mockResolvedValue(accountsResponse)
    render(<AccountSwitcher currentAccount={{ id: 'current', name: 'Filial Iquitos' }} accountCount={2000} collapsed={false} onSwitch={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: /Filial Iquitos/ })
    trigger.focus()
    fireEvent.click(trigger)

    const dialog = await screen.findByRole('dialog', { name: 'Cambiar cuenta' })
    const input = screen.getByRole('combobox')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAttribute('data-account-switcher-layout', 'centered-modal-mobile-sheet')
    expect(screen.getByText('2,000 cuentas')).toBeInTheDocument()
    expect(await screen.findByText(/Super administrador/)).toBeInTheDocument()
    expect(screen.getByText('Actual')).toBeInTheDocument()
    await waitFor(() => expect(input).toHaveFocus())

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Cambiar cuenta' })).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
  })

  it('blocks dismissal during a switch and keeps the modal open after a failed change', async () => {
    vi.mocked(api).mockResolvedValue({
      ...accountsResponse,
    })
    let finishSwitch: (result: string | null) => void = () => undefined
    const onSwitch = vi.fn().mockReturnValue(new Promise<string | null>(resolve => { finishSwitch = resolve }))
    render(<AccountSwitcher currentAccount={{ id: 'current', name: 'Filial Iquitos' }} accountCount={2000} collapsed={false} onSwitch={onSwitch} />)
    fireEvent.click(screen.getByRole('button', { name: /Filial Iquitos/ }))
    const input = await screen.findByRole('combobox')
    await screen.findByText('Filial Lima')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(onSwitch).toHaveBeenCalledWith('next'))

    const closeButton = screen.getByRole('button', { name: 'Cerrar selector' })
    expect(closeButton).toBeDisabled()
    fireEvent.mouseDown(document.querySelector('[data-account-switcher-backdrop]') as Element)
    expect(screen.getByRole('dialog', { name: 'Cambiar cuenta' })).toBeInTheDocument()

    await act(async () => finishSwitch('No tienes acceso a esta cuenta.'))
    expect(await screen.findByRole('alert')).toHaveTextContent('No tienes acceso')
    expect(screen.getByRole('dialog', { name: 'Cambiar cuenta' })).toBeInTheDocument()
    expect(closeButton).not.toBeDisabled()
  })
})
