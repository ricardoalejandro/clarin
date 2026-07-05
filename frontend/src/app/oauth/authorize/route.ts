import { proxyOAuthRequest } from '../oauthProxy'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  return proxyOAuthRequest(request, '/oauth/authorize')
}

export async function HEAD(request: Request) {
  return proxyOAuthRequest(request, '/oauth/authorize')
}
