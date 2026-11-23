import { groupIdentityRecoveryLabel, type GroupIdentityRecoverySnapshot } from './groupIdentityRecovery'
export default function GroupIdentityRecoveryNotice({ rows, devices = [], retryHint = false }: { rows: GroupIdentityRecoverySnapshot[]; devices?: { id: string; name?: string | null }[]; retryHint?: boolean }) {
  const visible = rows.map(row => ({ row, label: groupIdentityRecoveryLabel(row) })).filter(item => item.label)
  if (!visible.length) return null
  return <div aria-label="Recuperación de nombres de WhatsApp" className="space-y-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600">{visible.slice(0, 3).map(({ row, label }) => <p key={row.deviceId} role="status">{rows.length > 1 && <span className="font-semibold">{devices.find(device => device.id === row.deviceId)?.name || 'Dispositivo WhatsApp'}: </span>}{label}{retryHint && (row.error || ['partial', 'error'].includes(row.recovery?.state || '')) && <span className="block text-slate-500">Puedes reintentar desde Actualizar grupos de WhatsApp.</span>}</p>)}{visible.length > 3 && <p className="text-slate-500">{visible.length - 3} dispositivos más con recuperación pendiente.</p>}</div>
}
