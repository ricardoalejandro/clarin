import { readDocumentFile } from './documentFile'
import { measureDocument } from './jsonLimits'
import { processJson, type DocumentWorkerRequest, type DocumentWorkerResponse } from './jsonOperations'

self.onmessage = async (event: MessageEvent<DocumentWorkerRequest>) => {
  const message = event.data
  let response: DocumentWorkerResponse
  switch (message.kind) {
    case 'transform': response = { kind: 'transform', result: processJson(message) }; break
    case 'read-file': response = { kind: 'read-file', result: await readDocumentFile(message.file) }; break
    case 'measure': response = { kind: 'measure', metrics: measureDocument(message.source) }; break
  }
  self.postMessage(response)
}
