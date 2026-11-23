import { jsonRequest, libraryRequest, operationId, type UtilityDocument } from '../library/libraryApi'

/** The server snapshots the document and every private key in one transaction. */
export async function duplicateCryptoDocument(document: UtilityDocument, recovery: boolean) {
  const source = recovery ? (await libraryRequest<{ document: UtilityDocument }>(`/documents/${document.id}`)).document : document
  return libraryRequest<{ document: UtilityDocument }>(`/documents/${document.id}/duplicate`, jsonRequest('POST', {
    base_version: source.version,
    operation_id: operationId(),
    title: `${document.title} · copia`,
    config: document.config,
  }))
}
