import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import useCrmWindowStorageScope from './useCrmWindowStorageScope'

const mocks = vi.hoisted(() => ({ apiGet: vi.fn() }))

vi.mock('@/lib/api', () => ({ apiGet: mocks.apiGet }))

describe('useCrmWindowStorageScope', () => {
  beforeEach(() => {
    mocks.apiGet.mockReset().mockResolvedValue({
      success: true,
      data: { user: { id: 'user-7', account_id: 'account-3' } },
    })
  })

  it('isolates Contact window preferences by account, actor and surface', async () => {
    const { result } = renderHook(() => useCrmWindowStorageScope('contacts'))

    expect(result.current).toBe('pending:pending:contacts')
    await waitFor(() => expect(result.current).toBe('account-3:user-7:contacts'))
    expect(mocks.apiGet).toHaveBeenCalledWith('/api/me')
  })
})
