'use client'

import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { getAuthScope, isAuthIdentityChanging, subscribeAuthScope } from '@/lib/authScope'
import TagPicker, { type TagPickerItem, type TagPickerProps } from './TagPicker'
import { tagPickerSearchPath, type TagCatalogContext } from './tagPickerSearch'

type Props = Omit<TagPickerProps, 'contactId' | 'context' | 'canCreate' | 'catalogContext'> & { contextType: TagCatalogContext }

export default function CatalogTagPicker({ contextType, selected, sessionKey = '', ...props }: Props) {
  const [resolved, setResolved] = useState<{ key: string; tags: TagPickerItem[] }>({ key: '', tags: [] })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [retry, setRetry] = useState(0)
  const generation = useRef(0)
  const hydrationAbortRef = useRef<AbortController | null>(null)
  const cacheKey = `${getAuthScope()}:${contextType}:${sessionKey}`
  const known = useRef<{ key: string; tags: Map<string, TagPickerItem> }>({ key: cacheKey, tags: new Map() })
  if (known.current.key !== cacheKey) known.current = { key: cacheKey, tags: new Map() }
  selected.forEach(tag => { if (tag.name) known.current.tags.set(tag.id, tag) })
  const ids = selected.filter(tag => !tag.name).map(tag => tag.id).join(',')

  useEffect(() => subscribeAuthScope(() => {
    generation.current++
    hydrationAbortRef.current?.abort()
    known.current = { key: '', tags: new Map() }
    setResolved({ key: '', tags: [] }); setError(''); setLoading(false)
  }), [])

  useEffect(() => {
    const sequence = ++generation.current, scope = getAuthScope(), controller = new AbortController()
    hydrationAbortRef.current = controller
    const missing = ids.split(',').filter(id => id && !known.current.tags.has(id))
    setError(''); setLoading(Boolean(missing.length) && !isAuthIdentityChanging(scope))
    if (!missing.length || isAuthIdentityChanging(scope)) return
    void api<{ success: boolean; tags: TagPickerItem[] }>(tagPickerSearchPath({ catalogContext: contextType }, '', missing), { signal: controller.signal }).then(result => {
      if (controller.signal.aborted || generation.current !== sequence || scope !== getAuthScope() || known.current.key !== cacheKey) return
      setLoading(false)
      if (!result.success || !result.data?.success || !Array.isArray(result.data.tags)) setError(result.error || 'No se pudo cargar la etiqueta seleccionada.')
      else {
        result.data.tags.forEach(tag => known.current.tags.set(tag.id, tag))
        setResolved({ key: cacheKey, tags: result.data.tags })
        if (missing.some(id => !result.data!.tags.some(tag => tag.id === id))) setError('La etiqueta seleccionada ya no está disponible. Elige otra antes de activar.')
      }
    }).catch(() => {
      if (!controller.signal.aborted && generation.current === sequence && scope === getAuthScope() && known.current.key === cacheKey) { setLoading(false); setError('No se pudo cargar la etiqueta seleccionada.') }
    })
    return () => controller.abort()
  }, [ids, contextType, sessionKey, retry, cacheKey])

  const display = selected.map(tag => tag.name ? tag : known.current.tags.get(tag.id) || (resolved.key === cacheKey ? resolved.tags.find(item => item.id === tag.id) : undefined) || { ...tag, name: loading ? 'Cargando etiqueta…' : 'Etiqueta no disponible' })
  return <><TagPicker {...props} selected={display} catalogContext={contextType} sessionKey={sessionKey} onChange={next => {
    next.forEach(tag => { if (tag.name) known.current.tags.set(tag.id, tag) })
    setResolved({ key: cacheKey, tags: [...known.current.tags.values()] })
    props.onChange(next)
  }} />{error && <p role="alert" className="mt-2 text-xs text-red-600">{error}<button type="button" className="ml-2 min-h-11 px-2 underline" onClick={() => setRetry(value => value + 1)}>Reintentar</button></p>}</>
}
