import { AlertTriangle, CheckCircle2, CloudOff, Loader2, RefreshCw } from 'lucide-react'
import type { OfflineSession, SyncStatus } from '@/offline-v3/types'

function SyncTime({ label, value }: { label: string; value?: string }) {
  if (!value || !Number.isFinite(Date.parse(value))) return <span>{label}: sin registro</span>
  return <span>{label}: <time dateTime={value}>{new Date(value).toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' })}</time></span>
}

export default function OfflineStatusIndicator({
  session,
  sync,
  onSync,
}: {
  session: OfflineSession
  sync: SyncStatus | null
  onSync: () => void
}) {
  const syncing = sync?.state === 'syncing'
  const conflicts = sync?.conflict_count || 0
  const pending = sync?.pending_count || 0
  return (
    <section className="offline-status" aria-live="polite" data-mode="offline" aria-label="Estado offline de la cuenta actual">
      <span className="offline-status__icon"><CloudOff aria-hidden="true" /></span>
      <span className="offline-status__identity">
        <strong>Modo offline</strong>
        <span>{session.actor.display_name || session.actor.username} · {session.actor.account_name}</span>
      </span>
      <span className="offline-status__facts">
        {syncing ? <span><Loader2 className="spin" />Sincronizando</span> : pending ? <span><RefreshCw />{pending} pendiente{pending === 1 ? '' : 's'}</span> : <span><CheckCircle2 />Guardado local</span>}
        {conflicts > 0 && <span className="offline-status__warning"><AlertTriangle />{conflicts} conflicto{conflicts === 1 ? '' : 's'}</span>}
      </span>
      <button type="button" onClick={onSync} disabled={syncing} className="offline-button offline-button--quiet">
        <RefreshCw className={syncing ? 'spin' : ''} />Sincronizar
      </button>
      <span className="offline-status__details">
        <SyncTime label="Última sincronización" value={sync?.last_success_at} />
        <SyncTime label="Acceso offline hasta" value={sync?.lease_expires_at || session.lease_expires_at} />
        {Boolean(sync?.outcome_unknown_count) && <span className="offline-status__warning">{sync?.outcome_unknown_count} cambio(s) esperando confirmación; no se reenviarán con otra identidad.</span>}
        {sync?.last_error && <span className="offline-status__warning">La sincronización no se completó. Los cambios pendientes siguen guardados localmente.</span>}
      </span>
    </section>
  )
}
