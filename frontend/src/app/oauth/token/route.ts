import { proxyOAuthRequest } from '../oauthProxy'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  return proxyOAuthRequest(request, '/oauth/token')
}

export async function GET(request: Request) {
  return proxyOAuthRequest(request, '/oauth/token')
}

export async function HEAD(request: Request) {
  return proxyOAuthRequest(request, '/oauth/token')
}
