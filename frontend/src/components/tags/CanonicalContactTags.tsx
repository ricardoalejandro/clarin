'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import ContactTagEditor from '@/components/contact-details/ContactTagEditor'
import { subscribeAuthScope } from '@/lib/authScope'
import { useContactProfile } from '@/components/contact-details/useContactProfile'
import type { ContactProfileAvailableTag, ContactProfileContext } from '@/types/contact-profile'
import type { StructuredTag } from '@/types/contact'

interface Props {
  contactId: string
  context: ContactProfileContext
  initialTags: StructuredTag[]
  onChange: (tags: StructuredTag[]) => void
  onBeforeAssign?: (tagId: string) => Promise<boolean>
  onBeforeRemove?: (tagId: string) => Promise<boolean>
}
export default function CanonicalContactTags({ contactId, context, initialTags, onChange, onBeforeAssign, onBeforeRemove }: Props) {
  const [tags, setTags] = useState(initialTags)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [retryTags, setRetryTags] = useState<StructuredTag[] | null>(null)
  const key = `${contactId}:${context.type}:${context.id}`
  const activeKey = useRef(key); activeKey.current = key
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange
  const generation = useRef(0)
  const busy = useRef(false)
  const profile = useContactProfile({ contactId, context, initialContact: { id: contactId, structured_tags: initialTags }, onContactChange: contact => { if (!busy.current) { setTags(contact.structured_tags); onChangeRef.current(contact.structured_tags) } } })
  useEffect(() => { generation.current++; busy.current = false; setPending(false); setTags(initialTags); setError(''); setRetryTags(null); return () => { generation.current++ } }, [key])
  useEffect(() => subscribeAuthScope(() => { generation.current++; busy.current = false; setPending(false); setTags([]); setError(''); setRetryTags(null) }), [])
  useEffect(() => { if (!busy.current && profile.contact) setTags(profile.contact.structured_tags) }, [profile.contact])
  const update = async (selection: ContactProfileAvailableTag[]) => {
    const accountId = profile.contact?.account_id
    if (busy.current || !profile.capabilities.can_edit || !accountId) return
    const next: StructuredTag[] = selection.map(tag => ({ ...tag, account_id: accountId }))
    const previous = tags, requestKey = key, requestGeneration = generation.current
    busy.current = true; setPending(true); setError(''); setRetryTags(null)
    try {
      const added = next.find(tag => !previous.some(item => item.id === tag.id))
      const removed = previous.find(tag => !next.some(item => item.id === tag.id))
      const allowed = added && onBeforeAssign ? await onBeforeAssign(added.id) : removed && onBeforeRemove ? await onBeforeRemove(removed.id) : true
      if (activeKey.current !== requestKey || generation.current !== requestGeneration) return
      if (!allowed) return
      setTags(next); onChangeRef.current(next)
      const result = await profile.updateContact({ tag_ids: next.map(tag => tag.id) })
      if (activeKey.current !== requestKey || generation.current !== requestGeneration || result.stale) return
      if (!result.success || !result.contact) { setTags(previous); onChangeRef.current(previous); setError(result.error || 'No se pudo actualizar la etiqueta.'); setRetryTags(next) }
      else { setTags(result.contact.structured_tags); onChangeRef.current(result.contact.structured_tags) }
    } catch {
      if (activeKey.current !== requestKey || generation.current !== requestGeneration) return
      setTags(previous); onChangeRef.current(previous); setError('No se pudo actualizar la etiqueta.'); setRetryTags(next)
    } finally {
      if (activeKey.current === requestKey && generation.current === requestGeneration) { busy.current = false; setPending(false) }
    }
  }
  return <div aria-busy={pending}>
    {pending && <p role="status" className="flex items-center gap-2 text-xs text-slate-500"><Loader2 className="h-3.5 w-3.5 animate-spin" />Actualizando etiquetas…</p>}
    <ContactTagEditor contactId={contactId} context={context} selected={tags} canCreate={profile.capabilities.can_create_tags} disabled={pending || profile.loading || !profile.capabilities.can_edit || !profile.contact?.account_id} onChange={next => { void update(next) }} />
    {(error || profile.error) && <p role="alert" className="mt-2 text-xs text-red-600">{error || profile.error}<button type="button" disabled={pending} className="ml-2 min-h-11 px-2 font-semibold underline" onClick={() => { if (retryTags) void update(retryTags); else profile.refresh() }}>Reintentar</button></p>}
  </div>
}
