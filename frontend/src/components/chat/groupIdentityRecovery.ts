export type GroupIdentityRecoveryState = 'pending' | 'recovering' | 'completed' | 'partial' | 'waiting_connection' | 'error'
export interface GroupIdentityRecovery {
  state: GroupIdentityRecoveryState
  phase: string
  processed: number
  resolved: number
  pending: number
  conflicts: number
  unresolved_members?: number
  last_error_code: string
  updated_at: string
}
export interface GroupIdentityRecoverySnapshot { deviceId: string; recovery: GroupIdentityRecovery | null; identityRevision: number; error?: string }
const states = new Set(['pending', 'recovering', 'completed', 'partial', 'waiting_connection', 'error'])
export const isIdentityRevision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
export function parseGroupIdentityRecovery(value: unknown, deviceId: string): GroupIdentityRecoverySnapshot {
  const data = value as { success?: unknown; identity_revision?: unknown; recovery?: GroupIdentityRecovery | null }
  if (data?.success !== true || !isIdentityRevision(data.identity_revision) || data.recovery === undefined) throw new Error('No pudimos consultar la recuperación de identidades.')
  const job = data.recovery
  if (job !== null && (!states.has(job.state) || typeof job.phase !== 'string' || job.unresolved_members !== undefined && !isIdentityRevision(job.unresolved_members) || ['processed', 'resolved', 'pending', 'conflicts'].some(key => !isIdentityRevision(job[key as keyof GroupIdentityRecovery])))) throw new Error('No pudimos consultar la recuperación de identidades.')
  return { deviceId, identityRevision: data.identity_revision, recovery: job }
}
export function groupIdentityRecoveryPollDelay(rows: GroupIdentityRecoverySnapshot[]): number | null {
  if (rows.some(row => row.recovery?.state === 'pending' || row.recovery?.state === 'recovering')) return 5000
  if (rows.some(row => row.error || row.recovery?.state === 'waiting_connection')) return 30000
  return null
}
export function groupIdentityRecoveryLabel(row: GroupIdentityRecoverySnapshot): string | null {
  if (row.error) return 'No pudimos consultar el estado de recuperación de nombres.'
  const job = row.recovery
  if (!job) return null
  const unresolved = job.unresolved_members ? ` · ${job.unresolved_members} integrantes sin identificar` : ''
  if (job.state === 'completed' && !job.unresolved_members) return null
  if (job.state === 'waiting_connection') return 'Recuperación de nombres en espera de conexión.'
  if (job.state === 'pending') return 'Recuperación de nombres pendiente.'
  if (job.state === 'recovering') return `Recuperando nombres: ${job.processed} candidatos revisados · ${job.resolved} coincidencias verificadas · ${job.pending} verificaciones pendientes${unresolved}.`
  return `${job.state === 'error' ? 'No se pudo completar la recuperación' : 'Recuperación parcial'}: ${job.resolved} coincidencias verificadas · ${job.pending} verificaciones pendientes${unresolved}${job.conflicts ? ` · ${job.conflicts} ${job.conflicts === 1 ? 'identidad' : 'identidades'} por revisar` : ''}.`
}
