import { findDocumentText, type SearchRequest, type SearchResponse } from './documentSearch'

let source = ''
self.onmessage = (event: MessageEvent<SearchRequest>) => {
  const request = event.data
  if (request.kind === 'load') { source = request.source; return }
  const response: SearchResponse = { id: request.id, ...findDocumentText(source, request.query, request.caseSensitive, request.offset) }
  self.postMessage(response)
}
