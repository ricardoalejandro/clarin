import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  const authToken = request.cookies.get('auth-token')
  const refreshToken = request.cookies.get('refresh-token')
  const hasAnyAuth = !!(authToken?.value || refreshToken?.value)

  // Dashboard routes: require at least one auth cookie
  if (pathname.startsWith('/dashboard')) {
    if (!hasAnyAuth) {
      return NextResponse.redirect(new URL('/', request.url))
    }
    return NextResponse.next()
  }

  // Login page: redirect to dashboard if user has auth cookies
  if (pathname === '/') {
    if (hasAnyAuth) {
      return NextResponse.redirect(new URL('/dashboard', request.url))
    }
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/', '/dashboard/:path*'],
}
