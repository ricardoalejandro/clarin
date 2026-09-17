// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { offlineV5CanReloadPage, offlineV5CanReloadSelection, offlineV5PasswordValidation } from './OfflineAccessPanelV5'

describe('Offline v5 credential and recovery copy', () => {
  it('uses the current Clarín password length contract without asking for a second password', () => {
    expect(offlineV5PasswordValidation('Ricardo1@')).toContain('10 caracteres')
    expect(offlineV5PasswordValidation('Ricardo12@')).toBe('')
    expect(offlineV5PasswordValidation('á'.repeat(37))).toContain('72 bytes')
  })

  it('offers selection reload only for a real selection revision conflict', () => {
    expect(offlineV5CanReloadSelection('offline_selection_changed')).toBe(true)
    for (const code of ['offline_key_already_registered', 'offline_resource_too_large', 'offline_quota_exceeded', 'offline_retry_required', 'offline_asset_integrity_failed']) {
      expect(offlineV5CanReloadSelection(code)).toBe(false)
    }
  })

  it('offers a page reload when the deployed offline worker changed', () => {
    expect(offlineV5CanReloadPage('worker_update_required')).toBe(true)
    expect(offlineV5CanReloadPage('worker_unavailable')).toBe(true)
    expect(offlineV5CanReloadPage('offline_selection_changed')).toBe(false)
  })
})
