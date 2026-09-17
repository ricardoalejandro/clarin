const UUID_PATH_SEGMENT = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'

/**
 * Next's cached static route shell has no dynamic parameter of its own. When
 * that shell is served at the real canonical URL, recover the resource ID
 * from the address bar so the normal page/component remains the only UI.
 */
export function canonicalResourceID(
  routeValue: string | string[] | undefined,
  collection: 'programs' | 'whiteboards',
  pathname = typeof window === 'undefined' ? '' : window.location.pathname,
) {
  const candidate = Array.isArray(routeValue) ? routeValue[0] : routeValue
  if (candidate) return candidate
  const match = pathname.match(new RegExp(`^/dashboard/${collection}/(${UUID_PATH_SEGMENT})/?$`, 'i'))
  return match?.[1] || ''
}
