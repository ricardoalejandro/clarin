import type { Metadata } from 'next'
import { headers } from 'next/headers'
import './globals.css'

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://clarin.naperu.cloud'
const MARKETING_URL = process.env.NEXT_PUBLIC_MARKETING_URL || 'https://landing.clarin.naperu.cloud'

export const metadata: Metadata = {
  title: 'Clarin CRM - WhatsApp Business',
  description: 'Sistema de gestión de comunicaciones por WhatsApp',
  metadataBase: new URL(MARKETING_URL),
  icons: {
    icon: '/favicon.svg',
  },
  openGraph: {
    title: 'Clarin CRM - WhatsApp Business',
    description: 'Sistema de gestión de comunicaciones por WhatsApp',
    url: MARKETING_URL,
    siteName: 'Clarin',
    locale: 'es_PE',
    type: 'website',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const host = headers().get('host')?.split(':')[0].toLowerCase()
  const canonicalUrl = host === 'landing.clarin.naperu.cloud' ? MARKETING_URL : APP_URL

  return (
    <html lang="es" className="h-full">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <link rel="canonical" href={canonicalUrl} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
        <script dangerouslySetInnerHTML={{ __html: `
          (function() {
            var lastW = window.innerWidth;
            function setH() {
              document.documentElement.style.setProperty('--app-height', window.innerHeight + 'px');
              lastW = window.innerWidth;
            }
            setH();
            window.addEventListener('resize', function() {
              if (window.innerWidth !== lastW) setH();
            });
            window.addEventListener('orientationchange', function() { setTimeout(setH, 150); });
          })();
        `}} />
        <script dangerouslySetInnerHTML={{ __html: `
          (function() {
            function enableScroll() {
              if (window.location.pathname !== '/' && window.location.pathname !== '') return;
              var html = document.documentElement;
              html.classList.add('public-page-scroll');
            }
            if (document.readyState === 'loading') {
              document.addEventListener('DOMContentLoaded', enableScroll);
            } else {
              enableScroll();
            }
          })();
        `}} />
      </head>
      <body className="h-full bg-slate-50">{children}</body>
    </html>
  )
}
