const MCP_INTERNAL_URL = process.env.MCP_INTERNAL_URL || 'http://clarin-backend:8081'

export const dynamic = 'force-dynamic'

export async function proxyOAuthRequest(request: Request, pathname: string) {
  const incomingURL = new URL(request.url)
  const targetURL = new URL(pathname, MCP_INTERNAL_URL)
  targetURL.search = incomingURL.search

  const headers = new Headers(request.headers)
  headers.delete('host')
  headers.set('x-forwarded-host', incomingURL.host)
  headers.set('x-forwarded-proto', incomingURL.protocol.replace(':', ''))

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  const upstream = await fetch(targetURL, {
    method: request.method,
    headers,
    body: hasBody ? await request.arrayBuffer() : undefined,
    cache: 'no-store',
    redirect: 'manual',
  })

  const responseHeaders = new Headers(upstream.headers)
  responseHeaders.delete('content-encoding')
  responseHeaders.delete('content-length')
  responseHeaders.delete('transfer-encoding')

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  })
}
