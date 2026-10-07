import type { Device, DeviceDeletionResult, DeviceDeletionStatus } from '@/types/chat'

export function isDeviceDeleting(device?: { status?: string | null; deletion?: DeviceDeletionStatus | null } | null) {
  return Boolean(device && (device.status === 'deleting' || device.deletion))
}

export const deletingCapabilities: Device['runtime_capabilities'] = {
  can_start_chat: false, can_check_whatsapp: false, can_send_sticker: false,
  can_send_animated_sticker: false, can_send_reaction: false, can_publish_status: false,
  can_publish_status_link: false, can_sync_own_status: false,
}

export function applyDeviceDeletionResult<T extends Device>(devices: T[], result: DeviceDeletionResult, fromRequestedDelete = false): T[] {
  const existing = devices.find(device => device.id === result.device_id)
  if (!existing) return devices
  if (existing.deletion && existing.deletion.operation_id !== result.operation_id) return devices
  if (result.deletion_status === 'completed') {
    if (!existing.deletion && !fromRequestedDelete) return devices
    return devices.filter(device => device.id !== result.device_id)
  }
  return devices.map(device => device.id !== result.device_id ? device : {
    ...device, status: 'deleting', qr_code: '', runtime_capabilities: deletingCapabilities,
    deletion: {
      operation_id: result.operation_id,
      phase: device.deletion?.phase || 'pending',
      attempts: device.deletion?.attempts || 0,
      next_retry_at: result.next_retry_at ?? device.deletion?.next_retry_at,
      error_code: result.error_code ?? device.deletion?.error_code,
    },
  })
}

export function deviceDeletionMessage(device: { deletion?: DeviceDeletionStatus | null }, now = Date.now()) {
  const deletion = device.deletion
  if (!deletion) return 'Se está eliminando el dispositivo. Conservamos sus contactos y chats.'
  if (deletion.phase === 'remote_unlinked') return 'WhatsApp ya se desvinculó. Completando la limpieza del dispositivo.'
  if (deletion.error_code && deletion.next_retry_at) {
    const date = new Date(deletion.next_retry_at)
    if (Number.isFinite(date.getTime()) && date.getTime() > now) return `El servidor reintentará automáticamente el ${date.toLocaleString('es-PE')}. Conservamos los contactos y chats.`
  }
  return 'Eliminando el dispositivo y desvinculando WhatsApp. Conservamos los contactos y chats.'
}
