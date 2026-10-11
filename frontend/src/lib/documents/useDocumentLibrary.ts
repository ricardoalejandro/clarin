import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api } from '@/lib/api'
import { getAuthScope, subscribeAuthScope, isAuthIdentityChanging } from '@/lib/authScope'
import type { DocumentTemplate } from '@/types/document'
import { useDebouncedValue } from '@/lib/useDebouncedValue'
import { documentLibraryPath, mergeDocumentPage, type DocumentLibraryPage } from './documentLibrary'
export function useDocumentLibrary() {
 const scope = useSyncExternalStore(subscribeAuthScope, getAuthScope, () => 'server')
 const [dataScope, setDataScope] = useState(scope)
 const [templates, setTemplates] = useState<DocumentTemplate[]>([])
 const [loading, setLoading] = useState(true)
 const [query, setQuery] = useState('')
 const [settled, settle] = useDebouncedValue(query)
 const [cursor, setCursor] = useState('')
 const [error, setError] = useState('')
 const active = useRef<{ id: number; controller?: AbortController }>({ id: 0 })
 const load = useCallback(async (next = '') => {
  active.current.controller?.abort(); const controller = new AbortController(); const id = ++active.current.id; active.current.controller = controller
  const identity = getAuthScope(); if (isAuthIdentityChanging(identity) || identity === 'server') return; setLoading(true); setError('')
  const response = await api<DocumentLibraryPage>(documentLibraryPath(settled, next), { signal: controller.signal })
  if (controller.signal.aborted || id !== active.current.id || identity !== getAuthScope()) return
  setDataScope(identity)
  if (response.success && response.data) { setTemplates(old => next ? mergeDocumentPage(old, response.data!.templates) : response.data!.templates); setCursor(response.data.next_cursor || '') }
  else setError(response.error || 'No se pudieron cargar las plantillas.')
  setLoading(false)
 }, [settled, scope])
 useEffect(() => { setTemplates([]); setCursor(''); setError(''); setDataScope(scope) }, [scope])
 useEffect(() => { void load(); return () => { active.current.controller?.abort() } }, [load])
 return { templates: scope === dataScope && !isAuthIdentityChanging(scope) ? templates : [], loading, query, setQuery: (value: string) => { setQuery(value); if (!value) settle('') }, cursor, error, loadMore: () => load(cursor), retry: () => load(), pending: query !== settled }
}
