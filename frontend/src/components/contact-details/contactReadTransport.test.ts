import { describe, expect, it } from 'vitest'
import { contactReadTransportReady } from './contactReadTransport'

const offline = { mode: 'offline' as const, active: true, authorizedModules: ['contacts'], capabilities: ['contacts.read'] }

describe('contact read transport', () => {
  it('allows an unlocked authorized copy without manufacturing an online token', () => {
    expect(contactReadTransportReady(null, offline)).toBe(true)
    expect(contactReadTransportReady(null, { ...offline, mode: 'syncing' })).toBe(true)
    expect(contactReadTransportReady(null, { ...offline, mode: 'conflict' })).toBe(true)
  })
  it('requires the online token for online reads', () => {
    expect(contactReadTransportReady(null, { ...offline, mode: 'online' })).toBe(false)
    expect(contactReadTransportReady('synthetic', { ...offline, mode: 'online' })).toBe(true)
  })
  it('does not let a retained token bypass a locked, inactive or unauthorized copy', () => {
    for (const state of [{ ...offline, active: false }, { ...offline, mode: 'locked' as const }, { ...offline, mode: 'unavailable' as const }, { ...offline, authorizedModules: ['tasks'] }, { ...offline, capabilities: ['contacts.update'] }]) {
      expect(contactReadTransportReady('synthetic', state)).toBe(false)
    }
  })
})
