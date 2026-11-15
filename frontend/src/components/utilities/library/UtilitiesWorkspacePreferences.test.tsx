import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { effectiveUtilitiesNavigation, useUtilitiesWorkspacePreferences, utilitiesWorkspacePreferenceKey, UtilitiesWorkspacePreferencesProvider, validUtilitiesWorkspacePreferences } from '@/lib/utilitiesWorkspacePreferences'

beforeEach(() => localStorage.clear())
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('validates only layout booleans and keeps user/account preference keys independent', () => {
  expect(validUtilitiesWorkspacePreferences({ navigationCollapsed: 'false', libraryOpen: null, source: 'excluded' })).toEqual({ navigationCollapsed: true, libraryOpen: false })
  expect(validUtilitiesWorkspacePreferences({ navigationCollapsed: false, libraryOpen: true })).toEqual({ navigationCollapsed: false, libraryOpen: true })
  expect(utilitiesWorkspacePreferenceKey('a:b', 'c')).not.toBe(utilitiesWorkspacePreferenceKey('a', 'b:c'))
  expect(utilitiesWorkspacePreferenceKey(undefined, 'c')).toBeNull()
})

it('shares layout with descendants, preserves the global preference and restores separate account/user choices', async () => {
  localStorage.setItem('sidebar_collapsed', 'false')
  const hook = renderHook(({ user, account }) => useUtilitiesWorkspacePreferences(user, account), { initialProps: { user: 'u1', account: 'a1' } })
  expect(hook.result.current.preferences).toEqual({ navigationCollapsed: true, libraryOpen: false })
  act(() => hook.result.current.updatePreferences({ navigationCollapsed: false, libraryOpen: true }))
  expect(JSON.parse(localStorage.getItem(utilitiesWorkspacePreferenceKey('u1', 'a1')!)!)).toEqual({ navigationCollapsed: false, libraryOpen: true })
  expect(localStorage.getItem('sidebar_collapsed')).toBe('false')
  hook.rerender({ user: 'u1', account: 'a2' })
  await waitFor(() => expect(hook.result.current.preferences).toEqual({ navigationCollapsed: true, libraryOpen: false }))
  hook.rerender({ user: 'u2', account: 'a1' })
  expect(hook.result.current.preferences.libraryOpen).toBe(false)
  hook.rerender({ user: 'u1', account: 'a1' })
  await waitFor(() => expect(hook.result.current.preferences.libraryOpen).toBe(true))
  const shared = hook.result.current
  const child = renderHook(() => useUtilitiesWorkspacePreferences(), { wrapper: ({ children }) => <UtilitiesWorkspacePreferencesProvider value={shared}>{children}</UtilitiesWorkspacePreferencesProvider> })
  expect(child.result.current).toBe(shared)
  expect(effectiveUtilitiesNavigation(true, false, { navigationCollapsed: true, libraryOpen: false })).toBe(true)
  expect(effectiveUtilitiesNavigation(false, false, { navigationCollapsed: true, libraryOpen: false })).toBe(false)
  expect(effectiveUtilitiesNavigation(false, true, { navigationCollapsed: false, libraryOpen: false })).toBe(true)
})

it('recovers corrupt storage, follows scoped changes from another window and remains usable when storage fails', async () => {
  const key = utilitiesWorkspacePreferenceKey('u', 'a')!
  localStorage.setItem(key, '{broken')
  const hook = renderHook(() => useUtilitiesWorkspacePreferences('u', 'a'))
  expect(hook.result.current.preferences.libraryOpen).toBe(false)
  localStorage.setItem(key, JSON.stringify({ navigationCollapsed: false, libraryOpen: true, content: 'never read' }))
  act(() => window.dispatchEvent(new StorageEvent('storage', { key })))
  await waitFor(() => expect(hook.result.current.preferences).toEqual({ navigationCollapsed: false, libraryOpen: true }))
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Unavailable') })
  act(() => hook.result.current.updatePreferences({ libraryOpen: false }))
  expect(hook.result.current.preferences.libraryOpen).toBe(false)
})
