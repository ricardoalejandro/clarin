'use client'

import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { getAuthScope, isAuthIdentityChanging, subscribeAuthScope } from '@/lib/authScope'
import TagPicker, { type TagPickerItem, type TagPickerProps } from './TagPicker'
import { tagPickerSearchPath, type TagCatalogContext } from './tagPickerSearch'

type Props = Omit<TagPickerProps, 'contactId' | 'context' | 'canCreate' | 'catalogContext'> & { contextType: TagCatalogContext }
export default function CatalogTagPicker({ contextType, selected, sessionKey = '', ...props }: Props) {
  const [resolved, setResolved] = useState<TagPickerItem[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [retry, setRetry] = useState(0)
  const generation = useRef(0)
  const hydrationAbortRef = useRef<AbortController | null>(null)
  const ids = selected.filter(tag => !tag.name).map(tag => tag.id).join(',')
  useEffect(() => subscribeAuthScope(() => { generation.current++; hydrationAbortRef.current?.abort(); setResolved([]); setError(''); setLoading(false) }), [])
  useEffect(() => {
    const sequence = ++generation.current, scope = getAuthScope(), controller = new AbortController()
    hydrationAbortRef.current = controller
    setResolved([]); setError(''); setLoading(Boolean(ids) && !isAuthIdentityChanging(scope))
    if (!ids || isAuthIdentityChanging(scope)) return
    void api<{ success: boolean; tags: TagPickerItem[] }>(tagPickerSearchPath({ catalogContext: contextType }, '', ids.split(',')), { signal: controller.signal }).then(result => {
      if (controller.signal.aborted || generation.current !== sequence || scope !== getAuthScope()) return
      setLoading(false)
      if (!result.success || !result.data?.success || !Array.isArray(result.data.tags)) setError(result.error || 'No se pudo cargar la etiqueta seleccionada.')
      else {
        setResolved(result.data.tags)
        if (ids.split(',').some(id => !result.data!.tags.some(tag => tag.id === id))) setError('La etiqueta seleccionada ya no está disponible. Elige otra antes de activar.')
      }
    }).catch(() => { if (!controller.signal.aborted && generation.current === sequence) { setLoading(false); setError('No se pudo cargar la etiqueta seleccionada.') } })
    return () => controller.abort()
  }, [ids, contextType, sessionKey, retry])
  const display = selected.map(tag => tag.name ? tag : resolved.find(item => item.id === tag.id) || { ...tag, name: loading ? 'Cargando etiqueta…' : 'Etiqueta no disponible' })
  return <><TagPicker {...props} selected={display} catalogContext={contextType} sessionKey={sessionKey} />{error && <p role="alert" className="mt-2 text-xs text-red-600">{error}<button type="button" className="ml-2 min-h-11 px-2 underline" onClick={() => setRetry(value => value + 1)}>Reintentar</button></p>}</>
}
