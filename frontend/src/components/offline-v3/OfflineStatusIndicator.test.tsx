import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OfflineSession, SyncStatus } from '@/offline-v3/types'
import OfflineStatusIndicator from './OfflineStatusIndicator'

afterEach(cleanup)
const session: OfflineSession = {session_id:'s',capability:'memory-only',profile_epoch:1,idle_expires_at:'2026-09-14T22:00:00Z',lease_expires_at:'2026-09-17T20:00:00Z',actor:{user_id:'u',username:'ana',display_name:'Ana',account_id:'a',account_name:'Cuenta A'},actions:['tasks.read']}
const sync:SyncStatus = {state:'error',server_reachability:'unreachable',pending_count:2,conflict_count:1,outcome_unknown_count:0,last_success_at:'2026-09-14T20:00:00Z',lease_expires_at:'2026-09-17T21:00:00Z',selection_revision:1,last_error:{code:'server_unreachable',message:'not logged',retryable:true}}

describe('persistent offline status',()=>{
  it('shows exact identity, pending work, conflicts and renewed lease deadline',()=>{
    const view=render(<OfflineStatusIndicator session={session} sync={sync} onSync={vi.fn()} />)
    expect(screen.getByLabelText('Estado offline de la cuenta actual')).toHaveAttribute('data-mode','offline')
    expect(screen.getByText('Ana · Cuenta A')).toBeVisible()
    expect(screen.getByText('2 pendientes')).toBeVisible()
    expect(screen.getByText('1 conflicto')).toBeVisible()
    expect(view.container.querySelector('time[datetime="2026-09-17T21:00:00Z"]')).toBeVisible()
    expect(view.container.querySelector('time[datetime="2026-09-14T20:00:00Z"]')).toBeVisible()
    expect(screen.getByText(/Los cambios pendientes siguen guardados localmente/)).toBeVisible()
    expect(screen.queryByText('not logged')).not.toBeInTheDocument()
  })
  it('does not invent a successful sync and prevents overlapping manual retries',()=>{
    const view=render(<OfflineStatusIndicator session={session} sync={null} onSync={vi.fn()} />)
    expect(screen.getByText('Última sincronización: sin registro')).toBeVisible()
    view.rerender(<OfflineStatusIndicator session={session} sync={{...sync,state:'syncing',last_error:undefined}} onSync={vi.fn()} />)
    expect(screen.getByRole('button',{name:'Sincronizar'})).toBeDisabled()
  })
})
