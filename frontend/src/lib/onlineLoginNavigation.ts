import { WHITEBOARD_PUBLIC_LIBRARY_CALLBACK_PATH } from './whiteboardPublicLibraries'

/** Online authentication must leave the login document and its restrictive CSP. */
export function navigateAfterOnlineLogin(next: string | null, target: Pick<Location, 'assign'> = window.location) {
  const destination = next && (
    next === WHITEBOARD_PUBLIC_LIBRARY_CALLBACK_PATH
    || next.startsWith('/oauth/authorize')
    || next.startsWith('https://clarin.naperu.cloud/oauth/authorize')
  ) ? next : '/dashboard'

  // A client router transition retains login's img-src (without blob:), breaking
  // attachment previews and avatar editing until a manual reload. This boundary
  // applies only after online authentication, never to an unlocked offline port.
  target.assign(destination)
}
