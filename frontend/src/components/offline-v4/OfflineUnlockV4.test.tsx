import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import OfflineUnlockV4 from './OfflineUnlockV4'

const props = () => ({ grants: [{ grant_id: 'a', state: 'available' as const, label: 'Copia offline 1' }, { grant_id: 'b', state: 'available' as const, label: 'Copia offline 2' }], accounts: [] as Array<{ grant_id: string; account_name: string }>, busy: false, error: '', onlineAvailable: false, onUnlock: vi.fn().mockResolvedValue(undefined), onSelectAccount: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn(), onOnline: vi.fn() })
afterEach(cleanup)

describe('offline unlock identity form', () => {
  it('does not truncate passwords accepted during preparation', () => {
    const callbacks = props()
    render(<OfflineUnlockV4 {...callbacks} />)
    const password = 'a'.repeat(1024)
    const input = screen.getByLabelText('Contraseña de Clarin')
    expect(input).toHaveAttribute('maxlength', '1024')
    fireEvent.change(screen.getByLabelText('Usuario de Clarin'), { target: { value: 'ana' } })
    fireEvent.change(input, { target: { value: password } })
    fireEvent.click(screen.getByRole('button', { name: 'Desbloquear copia local' }))
    expect(callbacks.onUnlock).toHaveBeenCalledExactlyOnceWith('ana', password)
    expect(input).toHaveValue('')
  })
  it('submits username without exposing opaque copies or account names, then clears the password', () => {
    const callbacks = props()
    render(<OfflineUnlockV4 {...callbacks} />)
    fireEvent.change(screen.getByLabelText('Usuario de Clarin'), { target: { value: 'ana' } })
    fireEvent.change(screen.getByLabelText('Contraseña de Clarin'), { target: { value: 'secret-local-password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Desbloquear copia local' }))
    expect(callbacks.onUnlock).toHaveBeenCalledExactlyOnceWith('ana', 'secret-local-password')
    expect(screen.queryByText('Copia offline 1')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Contraseña de Clarin')).toHaveValue('')
  })
  it('requires explicit account selection after identity proof without default activation', () => {
    const callbacks = props()
    render(<OfflineUnlockV4 {...callbacks} accounts={[{ grant_id: 'a', account_name: 'Cuenta A' }, { grant_id: 'b', account_name: 'Cuenta B' }]} />)
    expect(callbacks.onSelectAccount).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Contraseña de Clarin')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cuenta B' }))
    expect(callbacks.onSelectAccount).toHaveBeenCalledExactlyOnceWith('b')
  })
  it('does not offer an unfinished or expired copy as an empty account', () => {
    render(<OfflineUnlockV4 {...props()} grants={[{ grant_id: 'a', state: 'preparing', label: 'Copia offline 1' }]} />)
    expect(screen.queryByLabelText('Contraseña de Clarin')).not.toBeInTheDocument()
    expect(screen.getByText(/preparación de la copia no terminó/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Iniciar una sesión online' })).not.toBeInTheDocument()
  })
})
