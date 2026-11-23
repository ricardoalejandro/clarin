import { expect, it } from 'vitest'
import { documentVaultPath, scopedVaultEvent } from './vaultScope'

it('requires a document for both metadata and material paths', () => {
  expect(documentVaultPath('doc-a', 'key')).toBe('/documents/doc-a/vault/key')
  expect(() => documentVaultPath('', 'key')).toThrow('Abre un documento')
})

it('accepts canonical changes and deletion only in the owning document', () => {
  const event = { event: 'utility_updated', data: { kind: 'vault_deleted', id: 'key', document_id: 'doc-a' } }
  expect(scopedVaultEvent(event, 'doc-a')).toEqual(event.data)
  expect(scopedVaultEvent(event, 'doc-b')).toBeNull()
  expect(scopedVaultEvent({ ...event, data: { kind: 'vault', id: 'key' } }, 'doc-a')).toBeNull()
  expect(scopedVaultEvent({ ...event, data: { ...event.data, kind: 'document' } }, 'doc-a')).toBeNull()
  expect(scopedVaultEvent(null, 'doc-a')).toBeNull()
})
