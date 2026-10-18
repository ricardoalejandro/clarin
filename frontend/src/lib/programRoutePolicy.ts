/** Programas is a focused workspace; assistant availability elsewhere is unchanged. */
export function programRoute(pathname: string | null | undefined): boolean {
  return pathname === '/dashboard/programs' || Boolean(pathname?.startsWith('/dashboard/programs/'))
}

export function erosAvailableForRoute(pathname: string | null | undefined): boolean {
  return !programRoute(pathname)
}
