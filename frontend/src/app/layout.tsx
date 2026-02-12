import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Clarin CRM - WhatsApp Business',
  description: 'Sistema de gestión de comunicaciones por WhatsApp',
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
      <body className="h-full overflow-hidden bg-gray-50">{children}</body>
    </html>
  )
}
