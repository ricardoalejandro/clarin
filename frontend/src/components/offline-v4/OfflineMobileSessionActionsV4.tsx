import { LockKeyhole } from 'lucide-react'

/** The desktop sidebar is hidden on narrow screens; session control must not be. */
export default function OfflineMobileSessionActionsV4({ busy, onLock }: { busy: boolean; onLock: () => void }) {
  return <div className="offline-mobile-session-actions"><button type="button" className="offline-button offline-button--secondary" disabled={busy} onClick={onLock}><LockKeyhole aria-hidden="true" />Bloquear / cambiar usuario o cuenta</button></div>
}
