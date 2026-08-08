import { MessageSquare, RefreshCw, WifiOff } from 'lucide-react'

const OFFLINE_STYLES = `
  :root, html, body { margin: 0; min-height: 100%; background: #020617; color: #f1f5f9; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  * { box-sizing: border-box; }
  .clarin-offline { min-height: 100vh; min-height: 100dvh; display: flex; align-items: center; justify-content: center; overflow-y: auto; padding: max(1rem, env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right)) max(1rem, env(safe-area-inset-bottom)) max(1rem, env(safe-area-inset-left)); background: #020617; }
  .clarin-offline-card { width: 100%; max-width: 28rem; overflow: hidden; border: 1px solid rgba(51,65,85,.9); border-radius: 1.5rem; background: #0f172a; box-shadow: 0 28px 80px rgba(0,0,0,.35); }
  .clarin-offline-content { padding: 1.5rem; border-bottom: 1px solid #1e293b; background: radial-gradient(circle at top right, rgba(16,185,129,.18), transparent 48%); }
  .clarin-offline-brand { display: flex; align-items: center; gap: .75rem; }
  .clarin-offline-mark { display: flex; width: 2.75rem; height: 2.75rem; align-items: center; justify-content: center; border-radius: 1rem; color: white; background: #10b981; box-shadow: 0 10px 25px rgba(2,44,34,.4); }
  .clarin-offline-mark svg, .clarin-offline-state svg { width: 1.25rem; height: 1.25rem; }
  .clarin-offline-name { margin: 0; color: white; font-size: 1.125rem; font-weight: 700; letter-spacing: -.025em; }
  .clarin-offline-eyebrow { margin: .15rem 0 0; color: #6ee7b7; font-size: .7rem; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; }
  .clarin-offline-state { display: flex; width: 3.5rem; height: 3.5rem; margin-top: 2rem; align-items: center; justify-content: center; border: 1px solid rgba(252,211,77,.2); border-radius: 1rem; color: #fcd34d; background: rgba(251,191,36,.1); }
  .clarin-offline-title { margin: 1rem 0 0; color: white; font-size: 1.5rem; font-weight: 700; line-height: 1.25; letter-spacing: -.025em; }
  .clarin-offline-copy { margin: .5rem 0 0; color: #94a3b8; font-size: .875rem; line-height: 1.6; }
  .clarin-offline-actions { padding: 1rem; }
  .clarin-offline-retry { min-height: 2.75rem; display: flex; align-items: center; justify-content: center; gap: .5rem; border-radius: .75rem; color: #022c22; background: #10b981; box-shadow: 0 10px 25px rgba(2,44,34,.25); font-size: .875rem; font-weight: 700; text-decoration: none; }
  .clarin-offline-retry:focus-visible { outline: 2px solid #6ee7b7; outline-offset: 3px; }
  .clarin-offline-retry svg { width: 1rem; height: 1rem; }
  @media (min-width: 640px) { .clarin-offline-content { padding: 2rem; } .clarin-offline-actions { padding: 1.5rem; } }
`

export default function OfflinePage() {
  return (
    <main className="clarin-offline">
      <style dangerouslySetInnerHTML={{ __html: OFFLINE_STYLES }} />
      <section className="clarin-offline-card">
        <div className="clarin-offline-content">
          <div className="clarin-offline-brand">
            <span className="clarin-offline-mark"><MessageSquare /></span>
            <div>
              <p className="clarin-offline-name">Clarin</p>
              <p className="clarin-offline-eyebrow">Experiencia móvil</p>
            </div>
          </div>

          <span className="clarin-offline-state"><WifiOff /></span>
          <h1 className="clarin-offline-title">Estás sin conexión</h1>
          <p className="clarin-offline-copy">
            Por seguridad, Clarin no guarda datos de tu cuenta para trabajar sin internet. Tu información permanece protegida; reintenta cuando vuelva la conexión.
          </p>
        </div>

        <div className="clarin-offline-actions">
          <a href="/dashboard" className="clarin-offline-retry"><RefreshCw />Reintentar</a>
        </div>
      </section>
    </main>
  )
}
