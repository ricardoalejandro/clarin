import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const APP_HOST = 'clarin.naperu.cloud'
const MARKETING_HOST = 'landing.clarin.naperu.cloud'
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || `https://${APP_HOST}`

function getHost(request: NextRequest) {
  return (request.headers.get('host') || '').split(':')[0].toLowerCase()
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const host = getHost(request)
  const isAppHost = host === APP_HOST
  const isMarketingHost = host === MARKETING_HOST

  const authToken = request.cookies.get('auth-token')
  const refreshToken = request.cookies.get('refresh-token')
  const hasAnyAuth = !!(authToken?.value || refreshToken?.value)

  if (
    isMarketingHost &&
    (pathname.startsWith('/api') || pathname.startsWith('/ws') || pathname.startsWith('/mcp') || pathname === '/health')
  ) {
    return new NextResponse('Not found', { status: 404 })
  }

  if (isMarketingHost && (pathname === '/login' || pathname === '/signup' || pathname.startsWith('/dashboard'))) {
    return NextResponse.redirect(new URL(`${pathname}${request.nextUrl.search}`, APP_URL))
  }

  if (isAppHost && pathname === '/') {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  // Dashboard routes: the client will validate/refresh the session.
  if (pathname.startsWith('/dashboard')) {
    if (!hasAnyAuth) {
      return NextResponse.redirect(new URL('/login', request.url))
    }
    return NextResponse.next()
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/', '/login', '/signup', '/dashboard/:path*', '/api/:path*', '/ws/:path*', '/mcp/:path*', '/health'],
}
