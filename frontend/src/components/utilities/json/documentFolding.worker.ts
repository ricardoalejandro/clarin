import { DocumentFoldingScanner, type FoldingRequest, type FoldingResponse } from './documentFolding'

let scanner: DocumentFoldingScanner | undefined
let identity = 0
self.onmessage = (event: MessageEvent<FoldingRequest>) => {
  const request = event.data
  if (request.kind === 'start') { identity = request.id; scanner = new DocumentFoldingScanner(request.format) }
  else if (request.id === identity && scanner) scanner.append(request.text)
  else return
  const response: FoldingResponse = request.kind === 'chunk' && (request.end || scanner!.halted)
    ? { kind: 'result', id: identity, result: scanner!.finish() } : { kind: 'ack', id: identity }
  self.postMessage(response)
  if (response.kind === 'result') scanner = undefined
}
