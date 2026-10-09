import { describe, expect, it } from 'vitest'
import { cloudDeviceBadges, deviceNameError } from './deviceAdministration'

describe('device administration validation and provider truth', () => {
  it('accepts 255 Unicode characters, trims names, and rejects empty or oversized values', () => {
    expect(deviceNameError('  Canal  ')).toBe('')
    expect(deviceNameError('😀'.repeat(255))).toBe('')
    expect(deviceNameError('😀'.repeat(256))).toContain('255')
    expect(deviceNameError(' '.repeat(10))).toContain('obligatorio')
  })

  it('reports real Cloud sending and billing states without inventing billing verification', () => {
    expect(cloudDeviceBadges({ api_sending_enabled: true, api_billing_status: 'configured' })).toEqual({ sending: { enabled: true, label: 'Envío activo' }, billing: { enabled: true, label: 'Facturación configurada' } })
    expect(cloudDeviceBadges({ api_sending_enabled: false, api_billing_status: 'not_configured' }).billing.label).toBe('Facturación no configurada')
    expect(cloudDeviceBadges({ api_sending_enabled: true, api_billing_status: 'unknown' }).billing.label).toBe('Facturación no verificada')
  })
})
