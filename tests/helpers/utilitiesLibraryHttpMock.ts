import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Route } from '@playwright/test'
import { createUtilitiesLibraryMock } from './utilitiesLibraryMock'

/** Native HTTP transport keeps Blob request bytes observable in WebKit, whose
 * interception protocol omits them from Route.request().postDataBuffer(). */
export async function createUtilitiesLibraryHttpMock() {
  const library = createUtilitiesLibraryMock()
  const server = createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', request.headers.origin || '*')
    response.setHeader('Access-Control-Allow-Credentials', 'true')
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
    response.setHeader('Access-Control-Allow-Headers', request.headers['access-control-request-headers'] || '*')
    response.setHeader('Access-Control-Expose-Headers', 'X-Content-Version')
    response.setHeader('Cache-Control', 'no-store')
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return }
    try {
      const payload = await readPayload(request)
      const adapter = {
        request: () => ({
          url: () => `http://127.0.0.1${request.url}`,
          method: () => request.method || 'GET',
          headers: () => Object.fromEntries(Object.entries(request.headers).filter(([, value]) => value !== undefined).map(([name, value]) => [name, Array.isArray(value) ? value.join(',') : value])),
          postDataJSON: () => JSON.parse(payload.toString('utf8')),
          postDataBuffer: () => payload,
        }),
        fulfill: async (options: NonNullable<Parameters<Route['fulfill']>[0]>) => {
          for (const [name, value] of Object.entries(options.headers || {})) response.setHeader(name, value)
          if (options.contentType) response.setHeader('Content-Type', options.contentType)
          let body = options.body
          if (options.json !== undefined) { response.setHeader('Content-Type', 'application/json'); body = JSON.stringify(options.json) }
          response.writeHead(options.status || 200)
          response.end(body)
        },
      } as unknown as Route
      if (!await library.handle(adapter)) { response.writeHead(404); response.end() }
    } catch (error) {
      if (!response.headersSent) { response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'HTTP mock failed' })) }
      else response.destroy()
    }
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() }) })
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    ...library,
    url,
    close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() }),
  }
}

async function readPayload(request: IncomingMessage) {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > 64 * 1024 * 1024) throw new Error('Test request exceeds the document limit')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}
