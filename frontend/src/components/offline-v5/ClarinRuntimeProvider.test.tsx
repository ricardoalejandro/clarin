import { useEffect } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ events: [] as string[], beginOnline: vi.fn() }))
const offlineSnapshot = {
  mode: 'offline' as const,
  active: true,
  canEnterOffline: true,
  userId: '11111111-1111-4111-8111-111111111111',
  accountId: '22222222-2222-4222-8222-222222222222',
  authorizedModules: ['tasks'],
  selectedRoots: { tasks: ['list-a'] },
  capabilities: ['tasks.update'],
  pendingCount: 0,
  conflictCount: 0,
}
vi.mock('@/lib/api', () => ({
  setSharedWebSocketOfflineSuppressed: (suppressed: boolean) => { mocks.events.push(`transport:${suppressed}`) },
}))
vi.mock('@/lib/offlineV5Runtime', () => ({
  acknowledgeOfflineV5ServerWinsConflicts: vi.fn(),
  beginOfflineV5OnlineTransition: mocks.beginOnline,
  explainOfflineV5Capability: () => ({ allowed: true }),
  getOfflineV5RuntimeSnapshot: () => offlineSnapshot,
  installOfflineV5FetchInterceptor: () => { mocks.events.push('fetch-interceptor') },
  requestOfflineV5Sync: vi.fn(),
  subscribeOfflineV5Runtime: (listener: (snapshot: typeof offlineSnapshot) => void) => {
    listener(offlineSnapshot)
    return vi.fn()
  },
}))
vi.mock('@/offline-v5/client', () => ({ browserOfflineV5Client: { activity: vi.fn() } }))

import { ClarinRuntimeProvider, useClarinRuntime } from './ClarinRuntimeProvider'

function CanonicalChild() {
  const { beginOnlineReauthentication } = useClarinRuntime()
  useEffect(() => { mocks.events.push('canonical-effect') }, [])
  return <button type="button" onClick={() => void beginOnlineReauthentication()}>Volver online</button>
}

afterEach(() => { cleanup(); mocks.events.length = 0; sessionStorage.clear(); vi.clearAllMocks() })

describe('ClarinRuntimeProvider first offline mount', () => {
  it('closes online auth and WebSocket transport before canonical child effects', () => {
    render(<ClarinRuntimeProvider><CanonicalChild /></ClarinRuntimeProvider>)
    expect(mocks.events).toContain('fetch-interceptor')
    expect(mocks.events.indexOf('transport:true')).toBeLessThan(mocks.events.indexOf('canonical-effect'))
    expect(mocks.events.indexOf('fetch-interceptor')).toBeLessThan(mocks.events.indexOf('canonical-effect'))
  })

  it('stores the exact offline identity and opens only the v5 online-transition latch', async () => {
    render(<ClarinRuntimeProvider><CanonicalChild /></ClarinRuntimeProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'Volver online' }))
    await waitFor(() => expect(mocks.beginOnline).toHaveBeenCalledOnce())
    expect(JSON.parse(sessionStorage.getItem('clarin:offline-v3-online-reauth') || '{}')).toMatchObject({
      user_id: offlineSnapshot.userId,
      account_id: offlineSnapshot.accountId,
    })
  })
})
