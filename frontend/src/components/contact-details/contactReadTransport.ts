import type { RuntimeSnapshot } from '@/lib/offlineV5Runtime'

/** A prepared, unlocked copy authorizes local reads without an online token. */
export function contactReadTransportReady(token: string | null, snapshot: Pick<RuntimeSnapshot, 'mode' | 'active' | 'authorizedModules' | 'capabilities'>): boolean {
  if (snapshot.mode === 'online') return Boolean(token)
  if (!snapshot.active || !['offline', 'syncing', 'conflict'].includes(snapshot.mode)) return false
  return snapshot.authorizedModules.includes('contacts') && snapshot.capabilities.some(action => ['contacts.read', 'contacts.*', '*'].includes(action))
}
