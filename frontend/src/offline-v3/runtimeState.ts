import type { GrantSummary, OfflineSession, SyncStatus } from './types'

export type OfflineRuntimePhase =
  | 'booting'
  | 'service_unavailable'
  | 'principal_required'
  | 'browser_pending'
  | 'locked'
  | 'unlocking'
  | 'offline_active'
  | 'revoked'
  | 'expired'
  | 'error'

export interface OfflineRuntimeState {
  phase: OfflineRuntimePhase
  generation: number
  profileEpoch: number
  grants: GrantSummary[]
  session: OfflineSession | null
  sync: SyncStatus | null
  error: string
}

export type OfflineRuntimeAction =
  | { type: 'SERVICE_UNAVAILABLE'; message: string }
  | { type: 'PRINCIPAL_REQUIRED' }
  | { type: 'BROWSER_PENDING' }
  | { type: 'LOCKED'; grants: GrantSummary[]; profileEpoch: number }
  | { type: 'UNLOCKING' }
  | { type: 'UNLOCKED'; session: OfflineSession; sync: SyncStatus }
  | { type: 'SYNC'; sync: SyncStatus }
  | { type: 'IDENTITY_CHANGED'; profileEpoch: number; message?: string }
  | { type: 'REVOKED'; profileEpoch: number }
  | { type: 'EXPIRED'; profileEpoch: number }
  | { type: 'ERROR'; message: string }

export const initialOfflineRuntimeState: OfflineRuntimeState = {
  phase: 'booting',
  generation: 0,
  profileEpoch: 0,
  grants: [],
  session: null,
  sync: null,
  error: '',
}

export function offlineRuntimeReducer(state: OfflineRuntimeState, action: OfflineRuntimeAction): OfflineRuntimeState {
  switch (action.type) {
    case 'SERVICE_UNAVAILABLE':
      return { ...initialOfflineRuntimeState, phase: 'service_unavailable', generation: state.generation + 1, error: action.message }
    case 'PRINCIPAL_REQUIRED':
      return { ...state, phase: 'principal_required', session: null, sync: null, error: '' }
    case 'BROWSER_PENDING':
      return { ...state, phase: 'browser_pending', session: null, sync: null, error: '' }
    case 'LOCKED':
      return {
        ...state,
        phase: 'locked',
        grants: action.grants,
        profileEpoch: action.profileEpoch,
        session: null,
        sync: null,
        error: '',
      }
    case 'UNLOCKING':
      return { ...state, phase: 'unlocking', error: '' }
    case 'UNLOCKED':
      return {
        ...state,
        phase: 'offline_active',
        generation: state.generation + 1,
        profileEpoch: action.session.profile_epoch,
        session: action.session,
        sync: action.sync,
        error: '',
      }
    case 'SYNC':
      return state.session ? { ...state, sync: action.sync } : state
    case 'IDENTITY_CHANGED':
      return {
        ...state,
        phase: 'locked',
        generation: state.generation + 1,
        profileEpoch: action.profileEpoch,
        session: null,
        sync: null,
        error: action.message || 'La identidad offline cambió en otra pestaña. Vuelve a ingresar.',
      }
    case 'REVOKED':
      return { ...state, phase: 'revoked', generation: state.generation + 1, profileEpoch: action.profileEpoch, session: null, sync: null }
    case 'EXPIRED':
      return { ...state, phase: 'expired', generation: state.generation + 1, profileEpoch: action.profileEpoch, session: null, sync: null }
    case 'ERROR':
      return { ...state, phase: state.phase === 'unlocking' ? 'locked' : state.phase, error: action.message }
  }
}

export interface RuntimeRequestIdentity {
  generation: number
  profileEpoch: number
  userId: string
  accountId: string
}

export function captureRuntimeRequestIdentity(state: OfflineRuntimeState): RuntimeRequestIdentity | null {
  if (!state.session) return null
  return {
    generation: state.generation,
    profileEpoch: state.profileEpoch,
    userId: state.session.actor.user_id,
    accountId: state.session.actor.account_id,
  }
}

export function isRuntimeRequestCurrent(state: OfflineRuntimeState, identity: RuntimeRequestIdentity | null) {
  return Boolean(identity && state.session
    && identity.generation === state.generation
    && identity.profileEpoch === state.profileEpoch
    && identity.userId === state.session.actor.user_id
    && identity.accountId === state.session.actor.account_id)
}
