import { describe, expect, it } from 'vitest'
import { chatDeviceMenuPosition, chatDeviceSelectionLabel, chatHistoryDevices } from './chatDeviceSelection'

const devices = [{ id: 'online', name: 'Online', status: 'connected' }, { id: 'offline', name: 'Offline', status: 'disconnected' }]

describe('chat history device selection', () => {
  it('keeps disconnected Web history but excludes Cloud and deleting devices', () => {
    expect(chatHistoryDevices([...devices,
      { id: 'cloud', name: 'Cloud', status: 'connected', provider: 'whatsapp_cloud_api' },
      { id: 'deleting', name: 'Deleting', status: 'connected', deletion: { operation_id: 'op', phase: 'pending', attempts: 0 } },
    ]).map(device => device.id)).toEqual(['online', 'offline'])
  })

  it('distinguishes explicit all-device selection from unfiltered device-less history', () => {
    expect(chatDeviceSelectionLabel(devices, [], 'Todos los dispositivos')).toBe('Todos los dispositivos')
    expect(chatDeviceSelectionLabel(devices, ['online', 'offline'], 'Todos los dispositivos')).toBe('2 dispositivos')
    expect(chatDeviceSelectionLabel(devices, ['offline'], 'Todos los dispositivos')).toBe('Offline')
    expect(chatDeviceSelectionLabel(devices, ['missing'], 'Todos los dispositivos')).toBe('Dispositivo no disponible')
  })

  it('keeps the menu inside a narrow visual viewport with an open keyboard', () => {
    const viewport = { left: 10, top: 20, width: 320, height: 280 }
    const menu = chatDeviceMenuPosition({ left: 290, top: 200, bottom: 244, width: 200 }, viewport, 360)
    expect(menu.left).toBeGreaterThanOrEqual(18)
    expect(menu.left + menu.width).toBeLessThanOrEqual(322)
    expect(menu.top).toBeGreaterThanOrEqual(28)
    expect(menu.top + menu.maxHeight).toBeLessThanOrEqual(292)
  })

  it('flips upward when there is more room above the trigger', () => {
    expect(chatDeviceMenuPosition({ left: 40, top: 580, bottom: 624, width: 280 }, { left: 0, top: 0, width: 800, height: 640 }, 200)).toEqual({ left: 40, top: 374, width: 280, maxHeight: 200 })
  })
})
