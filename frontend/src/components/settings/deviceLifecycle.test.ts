import { describe, expect, it } from 'vitest'
import type { Device, DeviceDeletionResult } from '@/types/chat'
import { applyDeviceDeletionResult, deviceDeletionMessage, isDeviceDeleting } from './deviceLifecycle'

const device: Device = { id: 'device-1', name: 'Synthetic channel', status: 'connected' }
const pending: DeviceDeletionResult = { device_id: device.id, operation_id: 'operation-1', deletion_status: 'pending', devices_total: 1, devices_available: 0, contacts_detached: 2, chats_detached: 3 }
describe('device deletion lifecycle', () => {
  it('retains the committed pending row and disables all runtime capabilities', () => {
    const rows = applyDeviceDeletionResult([device], pending)
    expect(rows).toHaveLength(1)
    expect(isDeviceDeleting(rows[0])).toBe(true)
    expect(Object.values(rows[0].runtime_capabilities!)).toEqual(Array(8).fill(false))
    expect(applyDeviceDeletionResult(rows, pending)).toEqual(rows)
  })
  it('accepts only completion of the current operation and is idempotent', () => {
    const rows = applyDeviceDeletionResult([device], pending)
    expect(applyDeviceDeletionResult(rows, { ...pending, operation_id: 'old-operation', deletion_status: 'completed' })).toEqual(rows)
    expect(applyDeviceDeletionResult([device], { ...pending, deletion_status: 'completed' })).toEqual([device])
    const completed = applyDeviceDeletionResult(rows, { ...pending, deletion_status: 'completed' })
    expect(completed).toEqual([])
    expect(applyDeviceDeletionResult(completed, pending)).toEqual([])
  })
  it('preserves the remote-unlinked checkpoint and describes automatic retry', () => {
    const rows = [{ ...device, status: 'deleting', deletion: { operation_id: 'operation-1', phase: 'remote_unlinked' as const, attempts: 2 } }]
    const updated = applyDeviceDeletionResult(rows, { ...pending, next_retry_at: '2026-10-07T03:00:00Z', error_code: 'whatsapp_cleanup_retry' })
    expect(updated[0].deletion?.phase).toBe('remote_unlinked')
    expect(deviceDeletionMessage(updated[0])).toContain('WhatsApp ya se desvinculó')
    const retry = { deletion: { ...updated[0].deletion!, phase: 'pending' as const } }
    expect(deviceDeletionMessage(retry, Date.parse('2026-10-07T02:00:00Z'))).toContain('automáticamente')
    expect(deviceDeletionMessage(retry, Date.parse('2026-10-07T04:00:00Z'))).toContain('Eliminando')
  })
  it('distinguishes local detachment and a missing or conflicting session from remote logout', () => {
    const local = { deletion: { operation_id: 'operation-1', phase: 'local_detached' as const, attempts: 1 } }
    const pendingMessage = deviceDeletionMessage({ deletion: { ...local.deletion, phase: 'pending' } })
    expect(pendingMessage).toContain('comprobará la sesión disponible')
    expect(pendingMessage).not.toContain('desvinculando WhatsApp')
    expect(deviceDeletionMessage(local)).toContain('No se desvinculó WhatsApp')
    expect(deviceDeletionMessage(local)).not.toContain('WhatsApp ya se desvinculó')
    expect(deviceDeletionMessage({ deletion: { ...local.deletion, phase: 'pending', error_code: 'whatsapp_session_missing' } })).toContain('únicamente el registro de Clarin')
    expect(deviceDeletionMessage({ deletion: { ...local.deletion, phase: 'pending', error_code: 'whatsapp_session_identity_conflict' } })).toContain('No se eliminará una sesión ajena')
  })
})
