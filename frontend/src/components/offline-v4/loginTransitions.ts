import { beginOfflineV4OnlineReauth, setOfflineV4Mode } from '@/lib/offlineV4ServiceWorker'
import { OFFLINE_V4_META_CACHE } from '@/lib/pwaCache'

/** Called only after explicit, trusted online authentication and identity checks. */
export async function completeExplicitOnlineLogin(requireOfflineTransition = false): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return !requireOfflineTransition
  try {
    const registration = await navigator.serviceWorker.getRegistration('/')
    if (!registration?.active && !navigator.serviceWorker.controller) return !requireOfflineTransition
    // Legacy workers do not understand v4 messages. A new ordinary login must
    // remain usable while that worker controls existing tabs and v4 waits.
    // Reading cache names creates neither a cache nor a private browser profile.
    if (!requireOfflineTransition && !((await caches.keys()).includes(OFFLINE_V4_META_CACHE))) return true
    // Another tab may have entered offline mode after this login page opened.
    // The authenticated submit is explicit even when its URL has no reauth flag.
    if (!await beginOfflineV4OnlineReauth()) return false
    return await setOfflineV4Mode('online')
  } catch {
    return false
  }
}

const recoverableTurnstileErrors = new Set([
  'Cloudflare no pudo completar la verificación. Puedes esperar o usar tu copia offline autorizada.',
  'Cloudflare no pudo iniciar la verificación. Puedes esperar o usar tu copia offline autorizada.',
  'Cloudflare no está respondiendo. Puedes esperar o usar tu copia offline autorizada.',
  'Cloudflare no pudo cargar la verificación. Puedes esperar o usar tu copia offline autorizada.',
  'Completa la verificación de seguridad para iniciar sesión.',
])

/** A refreshed captcha cannot erase authentication or safe-transition errors. */
export function recoverTurnstileError(current: string): string {
  return recoverableTurnstileErrors.has(current) ? '' : current
}
