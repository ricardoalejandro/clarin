'use strict'

const DEFAULT_SERVER = 'https://clarin.naperu.cloud'
const OFFLINE_PAGE = 'clarin-offline://app/offline.html'

function normalizeServerURL(raw = DEFAULT_SERVER) {
  const url = new URL(raw)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.pathname !== '' && url.pathname !== '/')) {
    throw new Error('CLARIN_SERVER_URL must be a plain HTTPS origin')
  }
  return url.origin
}

function offlinePageURL() { return OFFLINE_PAGE }

function isOfflinePage(raw, expected) {
  try {
    const value = new URL(raw)
    const target = new URL(expected)
    return value.protocol === 'clarin-offline:' && value.href === target.href
  } catch {
    return false
  }
}

function isAllowedNavigation(raw, serverOrigin, localPage) {
  try {
    const target = new URL(raw)
    return target.origin === serverOrigin || isOfflinePage(target.href, localPage)
  } catch {
    return false
  }
}

function isSafeAccountID(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

function shouldStartOffline(bootstrapState) {
	return bootstrapState === 'blocked'
}

function nextUnavailableChecks(current, reachable) {
	return reachable ? 0 : Math.min(Math.max(Number.isInteger(current) ? current : 0, 0) + 1, 2)
}

function enrollmentErrorResponse(error) {
	const detail = error instanceof Error ? error.message : String(error || '')
	if (/Windows 11|build 22000|x64/i.test(detail)) {
		return { success: false, state: 'error', terminal_id: '', error_code: 'windows_not_supported', error: 'Clarin Offline requiere Windows 11 de 64 bits actualizado.' }
	}
	if (/multiple terminal profiles|another server|profile identity/i.test(detail)) {
		return { success: false, state: 'error', terminal_id: '', error_code: 'local_profile_conflict', error: 'Este equipo tiene una autorización local anterior que necesita revisión por soporte.' }
	}
	if (/Cng|keyset|cryptograph|clave/i.test(detail)) {
		return { success: false, state: 'error', terminal_id: '', error_code: 'device_key_unavailable', error: 'Windows no pudo proteger la identidad offline de este equipo.' }
	}
	return { success: false, state: 'error', terminal_id: '', error_code: 'enrollment_prepare_failed', error: 'No se pudo preparar el modo offline en este equipo. Inténtalo de nuevo.' }
}

module.exports = { DEFAULT_SERVER, OFFLINE_PAGE, normalizeServerURL, offlinePageURL, isOfflinePage, isAllowedNavigation, isSafeAccountID, shouldStartOffline, nextUnavailableChecks, enrollmentErrorResponse }
