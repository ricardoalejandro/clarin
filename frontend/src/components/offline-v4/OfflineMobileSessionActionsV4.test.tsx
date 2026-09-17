import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import OfflineMobileSessionActionsV4 from './OfflineMobileSessionActionsV4'

afterEach(cleanup)

describe('mobile offline session control', () => {
  it('exposes explicit locking and user/account switching through one action', () => {
    const onLock = vi.fn()
    render(<OfflineMobileSessionActionsV4 busy={false} onLock={onLock} />)
    fireEvent.click(screen.getByRole('button', { name: 'Bloquear / cambiar usuario o cuenta' }))
    expect(onLock).toHaveBeenCalledTimes(1)
  })
  it('does not start a second identity transition while busy', () => {
    const onLock = vi.fn()
    render(<OfflineMobileSessionActionsV4 busy onLock={onLock} />)
    const button = screen.getByRole('button', { name: 'Bloquear / cambiar usuario o cuenta' })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(onLock).not.toHaveBeenCalled()
  })
})
