export interface VaultScopeEvent {
  event?: string
  type?: string
  data?: { kind?: string; id?: string; document_id?: string | null }
}

export function documentVaultPath(documentId: string, entryId?: string) {
  if (!documentId) throw new Error('Abre un documento para gestionar sus claves.')
  return `/documents/${encodeURIComponent(documentId)}/vault${entryId ? `/${encodeURIComponent(entryId)}` : ''}`
}

export function scopedVaultEvent(message: unknown, documentId: string) {
  const event = message as VaultScopeEvent | null
  if (!documentId || (event?.event || event?.type) !== 'utility_updated' || event?.data?.document_id !== documentId) return null
  return event.data.kind === 'vault' || event.data.kind === 'vault_deleted' ? event.data : null
}
