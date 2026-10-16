import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const acknowledgeConflicts = vi.fn()
const sync = vi.fn()
const beginOnlineReauthentication = vi.fn().mockResolvedValue(true)
const push = vi.fn()
const conflicts = vi.fn().mockResolvedValue([])
const resolveConflict = vi.fn().mockResolvedValue(undefined)

vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

vi.mock('./ClarinRuntimeProvider', () => ({
  useClarinRuntime: () => ({
    snapshot: {
      mode: 'conflict', active: true, canEnterOffline: true,
      authorizedModules: ['tasks'], selectedRoots: { tasks: ['list-a'] }, capabilities: ['tasks.update'],
      pendingCount: 0, conflictCount: 1,
    },
    acknowledgeConflicts,
    conflicts,
    resolveConflict,
    beginOnlineReauthentication,
    sync,
    notice: '',
    clearNotice: vi.fn(),
  }),
}))

import OfflineRuntimeIndicator from './OfflineRuntimeIndicator'

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('OfflineRuntimeIndicator conflict policy', () => {
  it('preserves local variants and opens explicit review instead of accepting every server version', async () => {
    render(<OfflineRuntimeIndicator />)
    expect(screen.getByText(/tu versión local sigue guardada/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Revisar conflictos' }))
    await vi.waitFor(() => expect(conflicts).toHaveBeenCalledOnce())
    expect(acknowledgeConflicts).not.toHaveBeenCalled()
    expect(resolveConflict).not.toHaveBeenCalled()
    expect(sync).not.toHaveBeenCalled()
  })

  it('uses the compact v5 reauthentication action before navigating to login', async () => {
    render(<OfflineRuntimeIndicator />)
    fireEvent.click(screen.getByRole('button', { name: 'Volver online' }))
    await vi.waitFor(() => expect(beginOnlineReauthentication).toHaveBeenCalledOnce())
    expect(push).toHaveBeenCalledWith('/login?offline_reauth=1')
  })
})
