import { useState, type ReactNode } from 'react'
import { AlertCircle, Loader2, LockKeyhole, RefreshCw } from 'lucide-react'
import ClarinBrandMark from '@/components/branding/ClarinBrandMark'
import type { LocalGrantSummary } from '@/offline-v4/types'

export function OfflineLoginFrameV4({ children }: { children: ReactNode }) {
  return <main className="offline-login"><section className="offline-login__card"><div className="offline-login__brand"><ClarinBrandMark label="Clarin" /><div><strong>Clarin</strong><span>Acceso protegido en tu navegador</span></div></div>{children}</section></main>
}

export default function OfflineUnlockV4({ grants, accounts, busy, error, onlineAvailable, onUnlock, onSelectAccount, onRefresh, onOnline }: {
  grants: LocalGrantSummary[]
  accounts: Array<{ grant_id: string; account_name: string }>
  busy: boolean
  error: string
  onlineAvailable: boolean
  onUnlock: (username: string, password: string) => Promise<void>
  onSelectAccount: (grantId: string) => Promise<void>
  onRefresh: () => void
  onOnline: () => void
}) {
  const available = grants.filter(item => item.state === 'available')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  return <OfflineLoginFrameV4><div className="offline-login__state"><LockKeyhole /></div><h1>{accounts.length ? 'Elige tu cuenta offline' : 'Entrar en modo offline'}</h1><p>{accounts.length ? 'Tu identidad está verificada. Elige explícitamente la cuenta con la que quieres trabajar.' : 'La copia permanece cifrada en este navegador. Usa tu usuario y la contraseña de Clarin con la que la preparaste.'}</p>{accounts.length ? <div className="offline-account-options" aria-label="Cuentas verificadas">{accounts.map(account => <button type="button" key={account.grant_id} disabled={busy} onClick={() => void onSelectAccount(account.grant_id)} className="offline-button offline-button--secondary offline-button--wide">{account.account_name}</button>)}</div> : !available.length ? <div className="offline-alert offline-alert--warning"><AlertCircle />{grants.some(item => item.state === 'expired') ? 'La autorización de 24 horas venció. Conéctate y renueva la copia desde Configuración → Offline. Los cambios pendientes no se borran automáticamente.' : grants.some(item => item.state === 'preparing') ? 'La preparación de la copia no terminó. Necesitas conexión para completarla antes de poder usarla.' : 'Este perfil no tiene copias offline preparadas. Primero solicita autorización y prepara tus recursos mientras tienes conexión.'}</div> : <form autoComplete="off" onSubmit={event => { event.preventDefault(); if (busy || !username.trim() || !password) return; const secret = password; setPassword(''); void onUnlock(username, secret) }}>
    <label className="offline-field"><span>Usuario de Clarin</span><input type="text" value={username} disabled={busy} onChange={event => setUsername(event.target.value)} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} data-1p-ignore /></label>
    <label className="offline-field"><span>Contraseña de Clarin</span><input type="password" value={password} disabled={busy} onChange={event => setPassword(event.target.value)} autoComplete="off" maxLength={1024} data-1p-ignore /></label>
    <button className="offline-button offline-button--primary offline-button--wide" disabled={busy || !username.trim() || !password}>{busy ? <Loader2 className="spin" /> : <LockKeyhole />}Desbloquear copia local</button>
  </form>}{error && <div className="offline-alert offline-alert--error" role="alert"><AlertCircle />{error}</div>}<button type="button" className="offline-link-button" disabled={busy} onClick={() => { setUsername(''); setPassword(''); onRefresh() }}><RefreshCw />{accounts.length ? 'Cambiar de usuario' : 'Volver a comprobar'}</button>{onlineAvailable && <button type="button" className="offline-link-button" disabled={busy} onClick={onOnline}>Iniciar una sesión online</button>}<p className="offline-login__hint">Los nombres de usuarios y cuentas solo se muestran después del desbloqueo. Cada usuario necesita su propia autorización.</p></OfflineLoginFrameV4>
}
