/** @type {import('next').NextConfig} */
const whiteboardContentSecurityPolicy = [
  "default-src 'self'",
  // Next.js emits an inline bootstrap; unsafe-eval and every remote script stay disabled.
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self' blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_BUILD_VERSION: process.env.NEXT_PUBLIC_BUILD_VERSION || 'dev',
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**',
      },
    ],
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080'}/api/:path*`,
      },
    ]
  },
  async headers() {
    const noStore = [
      {
        key: 'Cache-Control',
        value: 'no-store, no-cache, must-revalidate, proxy-revalidate',
      },
    ]
    const whiteboardHeaders = [
      ...noStore,
      {
        key: 'Content-Security-Policy',
        value: whiteboardContentSecurityPolicy,
      },
    ]
    return [
      { source: '/', headers: noStore },
      { source: '/login', headers: noStore },
      { source: '/signup', headers: noStore },
      { source: '/dashboard/:path*', headers: noStore },
      { source: '/dashboard/whiteboards/:path*', headers: whiteboardHeaders },
      { source: '/shared/whiteboards/:path*', headers: whiteboardHeaders },
      { source: '/d/:path*', headers: noStore },
      { source: '/f/:path*', headers: noStore },
    ]
  },
}

module.exports = nextConfig
