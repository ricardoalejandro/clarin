import type { Metadata } from 'next'
import './globals.css'

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://clarin.naperu.cloud'

export const metadata: Metadata = {
  title: 'Clarin CRM - WhatsApp Business',
  description: 'Sistema de gestión de comunicaciones por WhatsApp',
  metadataBase: new URL(APP_URL),
  icons: {
    icon: '/favicon.svg',
  },
  openGraph: {
    title: 'Clarin CRM - WhatsApp Business',
    description: 'Sistema de gestión de comunicaciones por WhatsApp',
    url: APP_URL,
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
  return (
    <html lang="es" className="h-full">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <link rel="canonical" href={APP_URL} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
        <script dangerouslySetInnerHTML={{ __html: `
          (function() {
            var frame = 0;
            function setViewport() {
              if (frame) cancelAnimationFrame(frame);
              frame = requestAnimationFrame(function() {
                var viewport = window.visualViewport;
                var height = viewport ? viewport.height : window.innerHeight;
                var width = viewport ? viewport.width : window.innerWidth;
                var offsetTop = viewport ? viewport.offsetTop : 0;
                var offsetLeft = viewport ? viewport.offsetLeft : 0;
                var keyboardInset = Math.max(0, window.innerHeight - height - offsetTop);
                var root = document.documentElement;
                root.style.setProperty('--app-height', Math.round(height) + 'px');
                root.style.setProperty('--app-width', Math.round(width) + 'px');
                root.style.setProperty('--visual-viewport-offset-top', Math.round(offsetTop) + 'px');
                root.style.setProperty('--visual-viewport-offset-left', Math.round(offsetLeft) + 'px');
                root.style.setProperty('--keyboard-inset', Math.round(keyboardInset) + 'px');
              });
            }
            setViewport();
            window.addEventListener('resize', setViewport, { passive: true });
            window.addEventListener('orientationchange', function() { setTimeout(setViewport, 150); }, { passive: true });
            if (window.visualViewport) {
              window.visualViewport.addEventListener('resize', setViewport, { passive: true });
              window.visualViewport.addEventListener('scroll', setViewport, { passive: true });
            }
          })();
        `}} />
      </head>
      <body className="h-full bg-slate-50">{children}</body>
    </html>
  )
}
