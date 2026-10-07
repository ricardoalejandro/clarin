import type { Device } from '@/types/chat'
import { isDeviceDeleting } from '@/components/settings/deviceLifecycle'

/** An empty device filter includes retained conversations with no device. */
export function reconcileChatDeviceFilters(
  selectedIds: string[],
  devices: ReadonlyArray<Pick<Device, 'id' | 'status' | 'deletion'>>,
): string[] {
  const availableIds = new Set(devices.filter(device => !isDeviceDeleting(device)).map(device => device.id))
  const next = selectedIds.filter(id => availableIds.has(id))
  return next.length === selectedIds.length ? selectedIds : next
}
