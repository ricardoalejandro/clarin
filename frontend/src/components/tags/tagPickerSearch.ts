import type { ContactProfileContext } from '@/types/contact-profile'
export type TagCatalogContext = 'contact_create' | 'lead_create' | 'lead_import' | 'automation'
export function tagPickerSearchPath(source: { contactId?: string; context?: ContactProfileContext; catalogContext?: TagCatalogContext }, query: string, ids?: string[]) {
  if (source.catalogContext) {
    const params = new URLSearchParams({ context_type: source.catalogContext, q: query, limit: '20' })
    if (ids?.length) params.set('ids', [...new Set(ids)].slice(0, 25).join(','))
    return `/api/tags/search?${params}`
  }
  if (!source.contactId || !source.context) throw new Error('El selector requiere un contexto de etiquetas.')
  const params = new URLSearchParams({ context_type: source.context.type, context_id: source.context.id, q: query, limit: '20' })
  return `/api/contact-profiles/${source.contactId}/tags?${params}`
}
