import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Clarin CRM - WhatsApp Business',
  description: 'Sistema de gestión de comunicaciones por WhatsApp',
  icons: {
    icon: '/favicon.svg',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="es" className="h-full overflow-hidden">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
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
      </head>
      <body className="h-full overflow-hidden bg-slate-50">{children}</body>
    </html>
  )
}
