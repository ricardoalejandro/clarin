'use client'

import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react'

export interface UtilitiesWorkspacePreferences { navigationCollapsed: boolean; libraryOpen: boolean }
export const DEFAULT_UTILITIES_WORKSPACE_PREFERENCES: Readonly<UtilitiesWorkspacePreferences> = { navigationCollapsed: true, libraryOpen: false }

export function utilitiesWorkspacePreferenceKey(userId?: string, accountId?: string) {
  return userId && accountId ? `clarin:utilities-layout:${encodeURIComponent(userId)}:${encodeURIComponent(accountId)}` : null
}

export function validUtilitiesWorkspacePreferences(value: unknown): UtilitiesWorkspacePreferences {
  const stored = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return {
    navigationCollapsed: typeof stored.navigationCollapsed === 'boolean' ? stored.navigationCollapsed : true,
    libraryOpen: typeof stored.libraryOpen === 'boolean' ? stored.libraryOpen : false,
  }
}

export function effectiveUtilitiesNavigation(utilities: boolean, globalCollapsed: boolean, preference: UtilitiesWorkspacePreferences) {
  return utilities ? preference.navigationCollapsed : globalCollapsed
}

interface PreferenceContextValue {
  preferences: UtilitiesWorkspacePreferences
  updatePreferences: (patch: Partial<UtilitiesWorkspacePreferences>) => void
}
const PreferenceContext = createContext<PreferenceContextValue | null>(null)
export const UtilitiesWorkspacePreferencesProvider = PreferenceContext.Provider

/** Only validated layout booleans persist here; documents and session data never enter this store. */
export function useUtilitiesWorkspacePreferences(userId?: string, accountId?: string): PreferenceContextValue {
  const inherited = useContext(PreferenceContext)
  const key = utilitiesWorkspacePreferenceKey(userId, accountId)
  const [state, setState] = useState<{ key: string | null; value: UtilitiesWorkspacePreferences }>({ key, value: { ...DEFAULT_UTILITIES_WORKSPACE_PREFERENCES } })
  const preferences = state.key === key ? state.value : { ...DEFAULT_UTILITIES_WORKSPACE_PREFERENCES }
  const current = useRef({ key, preferences })
  current.current = { key, preferences }
  useLayoutEffect(() => {
    if (inherited || !key) return
    const load = () => {
      let value = { ...DEFAULT_UTILITIES_WORKSPACE_PREFERENCES }
      try { value = validUtilitiesWorkspacePreferences(JSON.parse(localStorage.getItem(key) || 'null')) } catch { /* Invalid or unavailable preferences use the safe defaults. */ }
      setState({ key, value })
    }
    load()
    const changed = (event: StorageEvent) => { if (event.key === key || event.key === null) load() }
    window.addEventListener('storage', changed)
    return () => window.removeEventListener('storage', changed)
  }, [key, inherited])
  const updatePreferences = useCallback((patch: Partial<UtilitiesWorkspacePreferences>) => {
    const snapshot = current.current
    const value = validUtilitiesWorkspacePreferences({ ...snapshot.preferences, ...patch })
    current.current = { key: snapshot.key, preferences: value }
    setState({ key: snapshot.key, value })
    if (snapshot.key) { try { localStorage.setItem(snapshot.key, JSON.stringify(value)) } catch { /* Layout remains usable without browser storage. */ } }
  }, [])
  const own = useMemo(() => ({ preferences, updatePreferences }), [preferences, updatePreferences])
  return inherited ?? own
}
