'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizeServerURL, offlinePageURL, isAllowedNavigation, isOfflinePage, isSafeAccountID, shouldStartOffline, nextUnavailableChecks, enrollmentErrorResponse } = require('../lib/policy.cjs')

test('server URL accepts one HTTPS origin and rejects embedded authority', () => {
	assert.equal(normalizeServerURL('https://clarin.example/'), 'https://clarin.example')
	assert.throws(() => normalizeServerURL('https://clarin.example/path'))
  assert.throws(() => normalizeServerURL('http://clarin.example'))
  assert.throws(() => normalizeServerURL('https://user:secret@clarin.example'))
})

test('navigation is confined to Clarin origin and the exact offline page', () => {
  const local = offlinePageURL()
  assert.equal(isOfflinePage(local, local), true)
  assert.equal(isAllowedNavigation('https://clarin.example/dashboard/tasks', 'https://clarin.example', local), true)
  assert.equal(isAllowedNavigation('https://clarin.example.evil.test/', 'https://clarin.example', local), false)
  assert.equal(isAllowedNavigation('clarin-offline://app/other.html', 'https://clarin.example', local), false)
})

test('account ids passed to the agent are strict UUIDs', () => {
  assert.equal(isSafeAccountID('f56aa6ec-e698-4509-b90f-0cf65ac9b34c'), true)
  assert.equal(isSafeAccountID('../profile'), false)
})

test('startup opens Clarin online for enrollment and keeps corrupt local state blocked', () => {
	assert.equal(shouldStartOffline('unregistered'), false)
	assert.equal(shouldStartOffline('pending'), false)
	assert.equal(shouldStartOffline('blocked'), true)
	assert.equal(shouldStartOffline('enrolled'), false)
})

test('remote fallback requires two consecutive unavailable checks and resets on recovery', () => {
	assert.equal(nextUnavailableChecks(0, false), 1)
	assert.equal(nextUnavailableChecks(1, false), 2)
	assert.equal(nextUnavailableChecks(2, false), 2)
	assert.equal(nextUnavailableChecks(2, true), 0)
})

test('enrollment errors are stable Spanish responses without raw agent output', () => {
	assert.deepEqual(enrollmentErrorResponse(new Error('Clarin Offline requires Windows 11 build 22000 or later')), {
		success: false,
		state: 'error',
		terminal_id: '',
		error_code: 'windows_not_supported',
		error: 'Clarin Offline requiere Windows 11 de 64 bits actualizado.'
	})
	const unknown = enrollmentErrorResponse(new Error('PowerShell secret internal detail'))
	assert.equal(unknown.error_code, 'enrollment_prepare_failed')
	assert.equal(unknown.error.includes('PowerShell'), false)
	assert.equal(unknown.error.includes('secret'), false)
	assert.equal(enrollmentErrorResponse(new Error('BitLocker protection must be enabled')).error_code, 'enrollment_prepare_failed')
})
