import { processJson, type JsonRequest } from './jsonOperations'

self.onmessage = (event: MessageEvent<JsonRequest>) => {
  self.postMessage(processJson(event.data))
}
