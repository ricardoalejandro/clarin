import type { Device } from '@/types/chat'
import { isDeviceDeleting } from '@/components/settings/deviceLifecycle'

export function chatHistoryDevices(devices: Device[]): Device[] {
  return devices.filter(device => device.provider !== 'whatsapp_cloud_api' && !isDeviceDeleting(device))
}

export function chatDeviceSelectionLabel(devices: Device[], selected: string[], placeholder: string): string {
  if (!selected.length) return placeholder
  if (selected.length === 1) return devices.find(device => device.id === selected[0])?.name || 'Dispositivo no disponible'
  // Every explicit selection excludes device-less history, unlike [] (All).
  return `${selected.length} dispositivos`
}

export function chatDeviceMenuPosition(anchor: { left: number; top: number; bottom: number; width: number }, viewport: { left: number; top: number; width: number; height: number }, requestedHeight: number) {
  const margin = 8
  const gap = 6
  const width = Math.min(Math.max(240, anchor.width), Math.max(0, viewport.width - margin * 2))
  const maxHeight = Math.min(requestedHeight, Math.max(0, viewport.height - margin * 2))
  const bottom = viewport.top + viewport.height - margin
  const below = Math.max(0, bottom - anchor.bottom - gap)
  const above = Math.max(0, anchor.top - viewport.top - margin - gap)
  const flip = below < maxHeight && above > below
  const desiredTop = flip ? anchor.top - gap - maxHeight : anchor.bottom + gap
  return {
    width,
    maxHeight,
    left: Math.max(viewport.left + margin, Math.min(anchor.left, viewport.left + viewport.width - width - margin)),
    top: Math.max(viewport.top + margin, Math.min(desiredTop, bottom - maxHeight)),
  }
}
