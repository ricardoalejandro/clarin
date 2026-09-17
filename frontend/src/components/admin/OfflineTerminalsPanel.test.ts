import { describe, expect, it } from 'vitest'
import { buildOfflineApprovalPayload, defaultOfflineApproval, offlinePostureLabel, offlinePostureRequiresRiskAcknowledgement, offlineTerminalGrants, validateOfflineTerminalDraft, type OfflineGrantDraft } from './OfflineTerminalsPanel'

describe('validateOfflineTerminalDraft', () => {
  const valid: OfflineGrantDraft[] = [{ accountId: 'account-1', modules: ['tasks'] }]

  it('requires the bound user and device name', () => {
    expect(validateOfflineTerminalDraft('', 'user-1', valid)).toContain('equipo')
    expect(validateOfflineTerminalDraft('Equipo', '', valid)).toContain('usuario')
  })

  it('requires modules but deliberately does not ask the superadmin for resources', () => {
    expect(validateOfflineTerminalDraft('Equipo', 'user-1', [{ accountId: 'account-1', modules: [] }])).toContain('módulo')
    expect(validateOfflineTerminalDraft('Equipo', 'user-1', valid)).toBe('')
  })

  it('rejects duplicate account grants', () => {
    expect(validateOfflineTerminalDraft('Equipo', 'user-1', [...valid, ...valid])).toContain('repitas')
  })
})

describe('defaultOfflineApproval', () => {
	it('derives the first eligible account from the requesting user instead of asking for client data', () => {
		const grants = defaultOfflineApproval(
			{ id: 'user-1', username: 'ana', display_name: 'Ana', is_active: true, is_super_admin: false, accounts: [{ account_id: 'account-2' }] },
			[{ id: 'account-1', name: 'Uno', is_active: true }, { id: 'account-2', name: 'Dos', is_active: true }],
		)
		expect(grants).toEqual([{ accountId: 'account-2', modules: ['whiteboards', 'tasks', 'contacts', 'programs'] }])
	})
})

describe('offline device posture', () => {
	it('allows normal approval only when both recommended protections are present', () => {
		expect(offlinePostureRequiresRiskAcknowledgement({ bitlocker_status: 'enabled', windows_hello_status: 'configured' })).toBe(false)
		expect(offlinePostureRequiresRiskAcknowledgement({ bitlocker_status: 'disabled', windows_hello_status: 'configured' })).toBe(true)
		expect(offlinePostureRequiresRiskAcknowledgement({ bitlocker_status: 'enabled', windows_hello_status: 'not_configured' })).toBe(true)
		expect(offlinePostureRequiresRiskAcknowledgement({ bitlocker_status: 'unknown', windows_hello_status: 'unknown' })).toBe(true)
	})

	it('uses explicit labels instead of communicating posture only with color', () => {
		expect(offlinePostureLabel('bitlocker', 'disabled')).toBe('BitLocker desactivado')
		expect(offlinePostureLabel('windows_hello', 'not_configured')).toBe('Windows Hello no configurado')
		expect(offlinePostureLabel('windows_hello', 'unexpected')).toBe('Windows Hello desconocido')
	})

	it('includes the deliberate risk decision in the single approval write', () => {
		expect(buildOfflineApprovalPayload([{ accountId: 'account-1', modules: ['tasks'] }], true)).toEqual({
			grants: [{ account_id: 'account-1', modules: ['tasks'] }],
			acknowledge_device_risk: true,
		})
	})

	it('treats omitted grants from requested terminals as an empty collection', () => {
		expect(offlineTerminalGrants({})).toEqual([])
		expect(offlineTerminalGrants({ grants: [] })).toEqual([])
	})
})
