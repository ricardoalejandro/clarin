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

const loginContentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
  "script-src-elem 'self' 'unsafe-inline' https://challenges.cloudflare.com",
  "connect-src 'self' https://challenges.cloudflare.com",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "frame-src https://challenges.cloudflare.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

const offlineV3ContentSecurityPolicy = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self' http://127.0.0.1:17373",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ')

const nextConfig = {
  output: 'standalone',
  // The repository also has a Playwright lockfile one directory above. Keep
  // standalone tracing rooted at this application and its vendored packages.
  outputFileTracingRoot: __dirname,
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
    const loginHeaders = [
      ...noStore,
      { key: 'Content-Security-Policy', value: loginContentSecurityPolicy },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'same-origin' },
    ]
    const offlineV3Headers = [
      ...noStore,
      { key: 'Content-Security-Policy', value: offlineV3ContentSecurityPolicy },
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
    ]
    return [
      { source: '/', headers: loginHeaders },
      { source: '/login', headers: loginHeaders },
      { source: '/signup', headers: noStore },
      { source: '/dashboard/:path*', headers: noStore },
      { source: '/dashboard/whiteboards/:path*', headers: whiteboardHeaders },
      { source: '/dashboard/tasks/:path*', headers: whiteboardHeaders },
      { source: '/shared/whiteboards/:path*', headers: whiteboardHeaders },
      { source: '/d/:path*', headers: noStore },
      { source: '/f/:path*', headers: noStore },
      { source: '/offline-v3/:path*', headers: offlineV3Headers },
      { source: '/offline-v4/:path*', headers: offlineV3Headers.map(header => header.key === 'Content-Security-Policy' ? { ...header, value: offlineV3ContentSecurityPolicy.replace(' http://127.0.0.1:17373', '') } : header) },
      { source: '/offline-v5/:path*', headers: offlineV3Headers.map(header => header.key === 'Content-Security-Policy' ? { ...header, value: offlineV3ContentSecurityPolicy.replace(' http://127.0.0.1:17373', '') } : header) },
    ]
  },
}

module.exports = nextConfig
